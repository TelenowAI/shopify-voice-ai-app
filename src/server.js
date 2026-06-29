// ─────────────────────────────────────────────────────────────────────────────
// server.js — Express app entrypoint.
//
// Wiring order matters because of body parsers:
//   - Webhook routes (Shopify + Telenow) need the RAW body for HMAC, so they get
//     express.text({ type: '*/*' }) and are mounted BEFORE the global JSON parser.
//   - The settings API gets express.json().
//   - /app serves the static settings page.
//
// Run with: `npm start` (needs env from .env — see .env.example).
// ─────────────────────────────────────────────────────────────────────────────

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import 'dotenv/config';
import express from 'express';

// Import order: shopify.js (which imports the node adapter) before anything that
// touches the library. The webhook module also calls addHandlers() at import.
import { shopify, HOST } from './shopify.js';
import { authRouter, rootHandler } from './auth.js';
import { shopifyWebhookRouter } from './webhooks/shopify.js';
import { telenowWebhookRouter, ensureTelenowHook } from './webhooks/telenow.js';
import { getSettings, getRedactedSettings, updateSettings, AUTOMATIONS } from './settings.js';
import { getShop, listLeads } from './store.js';
import { verifySessionToken } from './session.js';
import { TelenowClient } from './telenow.js';
import { runWinBackSweep } from './automations/winBack.js';
import { runReviewsSweep } from './automations/reviews.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

const app = express();
app.disable('x-powered-by');

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'telenow-shopify' }));

// ── Webhook receivers (RAW body — must come before express.json) ──────────────
// Shopify HMAC and Telenow X-VoiceAI-Signature both verify over raw bytes.
app.use('/webhooks/shopify', express.text({ type: '*/*', limit: '2mb' }), shopifyWebhookRouter);
app.use('/telenow/webhook', express.text({ type: '*/*', limit: '2mb' }), telenowWebhookRouter);

// ── Everything else can use JSON ──────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));

// ── OAuth (install + callback) ────────────────────────────────────────────────
app.use(authRouter);

// ── Landing ───────────────────────────────────────────────────────────────────
app.get('/', rootHandler);

// ── Embedded settings UI ──────────────────────────────────────────────────────
app.get('/app', (req, res) => {
  // The page reads ?shop= itself; we just require an installed shop to proceed.
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

// ─────────────────────────────────────────────────────────────────────────────
// Settings API (consumed by /app)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve + validate the shop from the signed session token (Authorization:
 * Bearer <t>) — NOT the non-secret ?shop= query (that allowed IDOR: any tenant
 * could read another's leads/PII and overwrite its API key by guessing the shop).
 * Returns the shop derived from the token, or null after writing 401/404.
 */
function requireInstalledShop(req, res) {
  const auth = req.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
  const shop = verifySessionToken(token);
  if (!shop) {
    res.status(401).json({ error: 'missing or invalid session token' });
    return null;
  }
  if (!getShop(shop)) {
    res.status(404).json({ error: 'shop not installed — complete OAuth first' });
    return null;
  }
  return shop;
}

// GET current settings (redacted key) + the automation catalog for the UI.
app.get('/api/settings', (req, res) => {
  const shop = requireInstalledShop(req, res);
  if (!shop) return;
  res.json({
    settings: getRedactedSettings(shop),
    catalog: AUTOMATIONS.map(({ key, label, triggers }) => ({ key, label, triggers })),
  });
});

// GET captured leads (newest first) for the Leads view in the embedded app.
app.get('/api/leads', (req, res) => {
  const shop = requireInstalledShop(req, res);
  if (!shop) return;
  res.json({ leads: listLeads(shop, 100) });
});

// POST settings update. If the API key changed, (re)subscribe the Telenow hook.
app.post('/api/settings', async (req, res) => {
  const shop = requireInstalledShop(req, res);
  if (!shop) return;

  const before = getSettings(shop).telenowApiKey;
  const patch = sanitizeSettingsPatch(req.body);
  const saved = updateSettings(shop, patch);

  // If a (new) key was provided, validate it and ensure the result webhook hook.
  let hookStatus = '';
  if (patch.telenowApiKey && patch.telenowApiKey !== before) {
    try {
      const client = new TelenowClient(saved.telenowApiKey);
      await client.me(); // throws if invalid
      await ensureTelenowHook(shop);
      hookStatus = 'Telenow connected and result webhook subscribed.';
    } catch (err) {
      hookStatus = `Saved, but Telenow setup failed: ${err.message}`;
    }
  }

  res.json({ settings: getRedactedSettings(shop), hookStatus });
});

// POST validate-key: optionally save a new key, then call Telenow /me.
app.post('/api/validate-key', async (req, res) => {
  const shop = requireInstalledShop(req, res);
  if (!shop) return;

  // Allow saving the key as part of validation.
  if (req.body?.telenowApiKey) {
    updateSettings(shop, { telenowApiKey: String(req.body.telenowApiKey) });
  }
  const key = getSettings(shop).telenowApiKey;
  if (!key) {
    res.status(400).json({ error: 'no API key set' });
    return;
  }
  try {
    const me = await new TelenowClient(key).me();
    res.json(me);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Whitelist + coerce the settings patch coming from the browser so we never
 * persist arbitrary fields. Mirrors the shape settings.js understands.
 */
function sanitizeSettingsPatch(body = {}) {
  const out = {};
  if (typeof body.telenowApiKey === 'string' && body.telenowApiKey.trim()) {
    out.telenowApiKey = body.telenowApiKey.trim();
  }
  if (body.winBackDays != null) out.winBackDays = Number(body.winBackDays) || 60;

  if (body.automations && typeof body.automations === 'object') {
    out.automations = {};
    for (const def of AUTOMATIONS) {
      const a = body.automations[def.key];
      if (!a) continue;
      out.automations[def.key] = {
        enabled: Boolean(a.enabled),
        agentId: typeof a.agentId === 'string' ? a.agentId.trim() : '',
        delayMinutes: Math.max(0, Number(a.delayMinutes) || 0),
        filters: a.filters && typeof a.filters === 'object' ? a.filters : undefined,
        quietHours: a.quietHours
          ? {
              enabled: Boolean(a.quietHours.enabled),
              start: String(a.quietHours.start || '21:00'),
              end: String(a.quietHours.end || '09:00'),
              timezone: String(a.quietHours.timezone || 'Asia/Kolkata'),
            }
          : undefined,
      };
      // Drop undefined keys so updateSettings' deep-merge keeps existing values.
      if (out.automations[def.key].filters === undefined) delete out.automations[def.key].filters;
      if (out.automations[def.key].quietHours === undefined) {
        delete out.automations[def.key].quietHours;
      }
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scheduled jobs (win-back + reviews)
//
// Simple setInterval scheduler. TODO: swap for node-cron or a real job runner in
// production; also guard against overlapping runs across multiple instances.
// ─────────────────────────────────────────────────────────────────────────────

const SWEEP_INTERVAL_MS = Number(process.env.SWEEP_INTERVAL_MS) || 6 * 60 * 60 * 1000; // 6h

function startSchedulers() {
  const tick = async () => {
    try {
      await runWinBackSweep();
    } catch (err) {
      console.error('[scheduler] win-back sweep error:', err.message);
    }
    try {
      await runReviewsSweep();
    } catch (err) {
      console.error('[scheduler] reviews sweep error:', err.message);
    }
  };
  // Don't run immediately at boot (let the process settle); first run after one
  // interval. Set SWEEP_RUN_ON_BOOT=1 to run once at startup for testing.
  if (process.env.SWEEP_RUN_ON_BOOT === '1') tick();
  const t = setInterval(tick, SWEEP_INTERVAL_MS);
  t.unref?.(); // don't keep the process alive solely for the timer
  console.log(`[scheduler] sweeps every ${Math.round(SWEEP_INTERVAL_MS / 3600000)}h`);
}

// ── 404 + error handlers ──────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'not found', path: req.path }));
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[server] unhandled error:', err);
  if (!res.headersSent) res.status(500).json({ error: 'internal error' });
});

// ── Boot ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\nTelenow Shopify app listening on :${PORT}`);
  console.log(`  Public HOST:        ${HOST}`);
  console.log(`  Install URL:        ${HOST}/auth?shop=YOUR-STORE.myshopify.com`);
  console.log(`  Settings UI:        ${HOST}/app?shop=YOUR-STORE.myshopify.com`);
  console.log(`  Shopify webhooks →  ${HOST}/webhooks/shopify`);
  console.log(`  Telenow webhooks →  ${HOST}/telenow/webhook`);
  console.log(`  Telenow API base:   ${process.env.TELENOW_API_BASE || 'https://api.telenow.ai'}\n`);
  startSchedulers();
});

export { app };
