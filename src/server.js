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

import crypto from 'node:crypto';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import 'dotenv/config';
import express from 'express';

// Import order: shopify.js (which imports the node adapter) before anything that
// touches the library. The webhook module also calls addHandlers() at import.
import { shopify, HOST, getShopProfile, findFlaggedOrders } from './shopify.js';
import { authRouter, rootHandler } from './auth.js';
import { shopifyWebhookRouter } from './webhooks/shopify.js';
import { telenowWebhookRouter, ensureTelenowHook } from './webhooks/telenow.js';
import { ndrWebhookRouter } from './webhooks/ndr.js';
import {
  getSettings, getRedactedSettings, updateSettings, AUTOMATIONS,
  getAutomation, getSavedAgents, addSavedAgent, removeSavedAgent,
} from './settings.js';
import { getShop, listLeads } from './store.js';
import { listTemplates, getTemplate, buildAgentPayload } from './templates.js';
import { verifyAnySessionToken } from './session.js';
import { TelenowClient } from './telenow.js';
import { runWinBackSweep } from './automations/winBack.js';
import { runReviewsSweep } from './automations/reviews.js';
import { runPostPurchaseSweep } from './automations/postPurchase.js';

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
// Carrier NDR (failed delivery). Same raw-body treatment as the others so it
// sits with them, though it authenticates by secret path rather than HMAC.
app.use('/webhooks/ndr', express.text({ type: '*/*', limit: '1mb' }), ndrWebhookRouter);

// ── Everything else can use JSON ──────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));

// ── OAuth (install + callback) ────────────────────────────────────────────────
app.use(authRouter);

// ── Landing ───────────────────────────────────────────────────────────────────
app.get('/', rootHandler);

// ── Embedded settings UI ──────────────────────────────────────────────────────
app.get('/app', async (req, res) => {
  // App Bridge needs the client ID at script-load time, so the page is rendered
  // here rather than served statically. This is the app's public client ID (not
  // the secret) - every embedded Shopify app exposes it in the page.
  try {
    // Embedded apps must allow the admin to frame them, and must NOT allow anyone
    // else. The shop is validated before it goes into the header so a crafted
    // ?shop= cannot inject directives.
    const raw = String(req.query.shop || '');
    const shopOk = new RegExp("^[a-zA-Z0-9][a-zA-Z0-9-]*[.]myshopify[.]com$").test(raw);
    const frameAncestors = shopOk
      ? 'https://' + raw + ' https://admin.shopify.com'
      : 'https://admin.shopify.com';
    res.setHeader('Content-Security-Policy', 'frame-ancestors ' + frameAncestors);

    const html = await readFile(path.join(__dirname, 'public', 'app.html'), 'utf8');
    const key = process.env.SHOPIFY_API_KEY || '';
    res.type('html').send(html.split('{{SHOPIFY_API_KEY}}').join(key));
  } catch (err) {
    console.error('[app] could not render settings page:', err.message);
    res.status(500).send('Could not load the settings page.');
  }
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
async function requireInstalledShop(req, res) {
  const auth = req.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
  const shop = await verifyAnySessionToken(token);
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
app.get('/api/settings', async (req, res) => {
  const shop = await requireInstalledShop(req, res);
  if (!shop) return;
  res.json({
    settings: getRedactedSettings(shop),
    catalog: AUTOMATIONS.map(({ key, label, triggers }) => ({ key, label, triggers })),
  });
});

// ── Telenow read-through routes ───────────────────────────────────────────────
// The UI never sees the API key: it calls these, and the server uses the key
// stored for the shop. A shop with no key yet gets 409 so the UI can prompt.

/** Build a Telenow client for the shop, or write 409 and return null. */
/** Like telenowFor, but returns null instead of answering 409 — for routes
  * that still have something useful to render without a key. */
function telenowForOrNull(shop) {
  const key = getSettings(shop).telenowApiKey;
  return key ? new TelenowClient(key) : null;
}

function telenowFor(shop, res) {
  const key = getSettings(shop).telenowApiKey;
  if (!key) {
    res.status(409).json({ error: 'no_api_key', message: 'Connect your Telenow API key first.' });
    return null;
  }
  return new TelenowClient(key);
}

/** Map a TelenowError onto a sensible HTTP response. */
function telenowFail(res, err, what) {
  const status = err?.status && err.status >= 400 && err.status < 600 ? err.status : 502;
  console.error('[api] ' + what + ' failed:', err.message);
  res.status(status).json({ error: what + "_failed", message: err.message });
}

// GET /api/agents — the org's voice agents, for the Agents page and the
// agent pickers on each automation.
// A Telenow agent id is a UUID. Validating here keeps junk out of the store and
// bounds what a caller can persist.
const UUID_RE = new RegExp('^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$');
const MAX_SAVED_AGENTS = 200;

// GET /api/agents — only the agents this store has added, in the order added.
//
// Ids that no longer resolve in Telenow (the agent was deleted there) are
// returned as tombstones rather than dropped: filtering them out silently makes
// them invisible AND unremovable, since the picker only lists live agents.
app.get('/api/agents', async (req, res) => {
  const shop = await requireInstalledShop(req, res);
  if (!shop) return;
  const saved = getSavedAgents(shop);
  const client = telenowFor(shop, res);
  if (!client) return;
  // Nothing added yet — skip the Telenow round-trip entirely.
  if (!saved.length) {
    res.json({ agents: [], total: 0, saved: [], missing: [] });
    return;
  }
  try {
    const { agents } = await client.listAllAgents();
    const byId = new Map(agents.map((a) => [a.id, a]));
    const mine = [];
    const missing = [];
    for (const id of saved) {
      const a = byId.get(id);
      if (a) mine.push(a); else missing.push(id);
    }
    res.json({ agents: mine, total: mine.length, saved, missing });
  } catch (err) {
    telenowFail(res, err, 'agents');
  }
});

// GET /api/agents/available — every agent in the org, flagged with whether it is
// already added. Declared BEFORE /api/agents/:id so "available" is not read as an id.
app.get('/api/agents/available', async (req, res) => {
  const shop = await requireInstalledShop(req, res);
  if (!shop) return;
  const client = telenowFor(shop, res);
  if (!client) return;
  try {
    const { agents, total, truncated } = await client.listAllAgents();
    const saved = new Set(getSavedAgents(shop));
    res.json({
      agents: agents.map((a) => ({ ...a, added: saved.has(a.id) })),
      total: agents.length,
      // Tell the UI when the org is larger than we are willing to page through,
      // rather than quietly showing a partial list as if it were everything.
      truncated: Boolean(truncated),
      orgTotal: total,
    });
  } catch (err) {
    telenowFail(res, err, 'agents');
  }
});

// POST /api/agents/saved — add one agent to this store's list.
app.post('/api/agents/saved', async (req, res) => {
  const shop = await requireInstalledShop(req, res);
  if (!shop) return;
  const agentId = String(req.body?.agentId || '').trim();
  if (!UUID_RE.test(agentId)) {
    res.status(400).json({ error: 'bad_request', message: 'A valid agent id is required.' });
    return;
  }
  if (getSavedAgents(shop).length >= MAX_SAVED_AGENTS && !getSavedAgents(shop).includes(agentId)) {
    res.status(409).json({ error: 'too_many', message: `You can add up to ${MAX_SAVED_AGENTS} agents.` });
    return;
  }
  res.json({ saved: addSavedAgent(shop, agentId) });
});

// DELETE /api/agents/saved/:id — unlink from this store. The agent itself is
// untouched in Telenow, so it can be added back at any time from the picker.
// Accepts an id that no longer resolves upstream, so a tombstoned entry can
// still be cleared.
app.delete('/api/agents/saved/:id', async (req, res) => {
  const shop = await requireInstalledShop(req, res);
  if (!shop) return;
  const id = req.params.id;
  const saved = removeSavedAgent(shop, id);

  // If this agent came from a template, forget that too — otherwise the
  // Templates page keeps claiming it is set up while the agent is gone from
  // the store, and there is no way to make it again.
  const installed = getSettings(shop).installedTemplates || {};
  const freed = Object.entries(installed).filter(([, v]) => v?.agentId === id).map(([k]) => k);
  if (freed.length) {
    const next = { ...installed };
    for (const k of freed) delete next[k];
    updateSettings(shop, { installedTemplates: next });
  }

  res.json({ saved, freedTemplates: freed });
});

// GET /api/agents/:id — one agent with its FULL configuration, for the agent
// detail view. Uses the Dashboard surface; the /v1 list omits prompt+config.
app.get('/api/agents/:id', async (req, res) => {
  const shop = await requireInstalledShop(req, res);
  if (!shop) return;
  const client = telenowFor(shop, res);
  if (!client) return;
  try {
    // Stats are a nice-to-have: a new agent with no calls can 404 here, and
    // that must not take down the whole detail view.
    const [agent, stats] = await Promise.all([
      client.getAgent(req.params.id),
      client.getAgentStats(req.params.id).catch(() => null),
    ]);
    res.json({ agent, stats });
  } catch (err) {
    telenowFail(res, err, 'agent');
  }
});

// GET /api/catalog — provider catalog, used to turn raw ids ("xai",
// "lightning_v3.1_pro") into human labels. Cached per shop for the process
// lifetime: it is a large, near-static payload and the detail view hits it
// on every open.
const catalogCache = new Map();
app.get('/api/catalog', async (req, res) => {
  const shop = await requireInstalledShop(req, res);
  if (!shop) return;
  if (catalogCache.has(shop)) {
    res.json(catalogCache.get(shop));
    return;
  }
  const client = telenowFor(shop, res);
  if (!client) return;
  try {
    const catalog = await client.getCatalog();
    catalogCache.set(shop, catalog);
    res.json(catalog);
  } catch (err) {
    telenowFail(res, err, 'catalog');
  }
});

// POST /api/web-call — start a browser call so the merchant can TALK to the
// agent through their microphone, the way the Telenow dashboard does.
//
// Returns the session id and the WebSocket URL; the audio itself is handled by
// the standalone /web-call page (see below), never by this server.
app.post('/api/web-call', async (req, res) => {
  const shop = await requireInstalledShop(req, res);
  if (!shop) return;
  const client = telenowFor(shop, res);
  if (!client) return;

  const agentId = String(req.body?.agentId || '').trim();
  if (!agentId) {
    res.status(400).json({ error: 'bad_request', message: 'agentId is required' });
    return;
  }
  const variables = {};
  const rawVars = req.body?.variables;
  if (rawVars && typeof rawVars === 'object' && !Array.isArray(rawVars)) {
    for (const [k, v] of Object.entries(rawVars)) {
      if (typeof v === 'string' && v.trim()) variables[k] = v.trim().slice(0, 500);
    }
  }

  try {
    const out = await client.initWebCall({
      agentId,
      variables,
      identifier: 'shopify-web:' + shop,
    });
    console.log(`[web-call] shop=${shop} agent=${agentId} session=${out.sessionId || '?'}`);
    res.json(out);
  } catch (err) {
    telenowFail(res, err, 'web call');
  }
});

// GET /web-call — the browser-call page, opened in its OWN WINDOW rather than
// rendered inside the app.
//
// Why a separate window: microphone access inside an iframe requires the
// EMBEDDING page to grant it via allow="microphone", and the Shopify admin
// controls that iframe, not us. A top-level window always has mic access, so
// the call works regardless of what Shopify sets. It carries no session token:
// the sessionId minted above is the only credential the WebSocket needs, and it
// arrives in the URL fragment (never sent to a server, never logged).
app.get('/web-call', async (req, res) => {
  try {
    const html = await readFile(path.join(__dirname, 'public', 'webcall.html'), 'utf8');
    res.type('html').send(html);
  } catch (err) {
    console.error('[web-call] could not render page:', err.message);
    res.status(500).send('Could not load the call page.');
  }
});

// The org id is needed for the org-scoped recording routes. It comes from
// /api/v1/me and never changes for a given key, so resolve it once per shop.
const orgIdCache = new Map();
async function orgIdFor(shop, client) {
  if (orgIdCache.has(shop)) return orgIdCache.get(shop);
  const me = await client.me();
  const orgId = me?.org_id || null;
  if (orgId) orgIdCache.set(shop, orgId);
  return orgId;
}

// GET /api/calls/:id/recording — a short-lived signed URL the browser can drop
// straight into an <audio> element, plus the metadata needed to label it.
//
// The audio bytes never pass through this server: the signed URL points at
// object storage and carries its own credential in the query string, which is
// the only way to play it from an <audio src> (that element cannot send an
// Authorization header). The URL expires, so it is fetched per play, not stored.
app.get('/api/calls/:id/recording', async (req, res) => {
  const shop = await requireInstalledShop(req, res);
  if (!shop) return;
  const client = telenowFor(shop, res);
  if (!client) return;
  try {
    const call = await client.getCallDetail(req.params.id);
    const recordingId = call?.recording_id;
    if (!recordingId) {
      res.status(404).json({ error: 'no_recording', message: 'This call has no recording.' });
      return;
    }
    const orgId = await orgIdFor(shop, client);
    if (!orgId) {
      res.status(502).json({ error: 'no_org', message: 'Could not resolve the Telenow organization.' });
      return;
    }
    // Metadata is a nice-to-have label; a failure there must not block playback.
    const [signed, meta] = await Promise.all([
      client.getRecordingUrl(orgId, recordingId),
      client.getRecording(orgId, recordingId).catch(() => null),
    ]);
    res.json({
      url: signed.url,
      expiresAt: signed.expiresAt,
      mime: meta?.mime || 'audio/wav',
      durationSec: meta?.duration_sec ?? null,
      sizeBytes: meta?.size_bytes ?? null,
      sampleRate: meta?.sample_rate ?? null,
    });
  } catch (err) {
    telenowFail(res, err, 'recording');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Shopify → Telenow native integration
//
// Telenow ships a Shopify connector that lets an agent read the store MID-CALL
// (order.lookup, customer.lookup, product.search, checkout.create_link,
// order.update). It needs exactly two things: the Admin API token and the store
// domain — both of which this app already holds from its own OAuth install.
//
// So the merchant never pastes a Shopify token into Telenow: the moment they
// save a valid Telenow API key here, we connect the store on their behalf.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Connect (or repair) this shop's Shopify connector in Telenow.
 *
 * Idempotent by design, three ways: a stable Idempotency-Key derived from the
 * shop replays the original create; an existing connection for the same store
 * domain is PATCHed rather than duplicated; and a 409 (already connected) is
 * resolved by looking the connection up and updating it.
 *
 * @returns {Promise<{connected: boolean, connectionId?: string, status?: string,
 *                    verified?: boolean, error?: string}>}
 */
async function connectShopifyIntegration(shop, client) {
  const session = getShop(shop);
  const accessToken = session?.accessToken;
  if (!accessToken) return { connected: false, error: 'No Shopify access token for this shop.' };
  // The preview/demo seed uses a dummy token; connecting it would just store a
  // credential that fails every verification.
  if (String(accessToken).includes('dummy')) {
    return { connected: false, error: 'This shop has a placeholder token (preview mode).' };
  }

  const settings = { store_domain: shop };
  const credentials = { api_token: accessToken };

  try {
    // Reuse an existing connection for this store rather than making a second.
    const existing = (await client.listConnections('shopify'))
      .find((c) => c?.settings?.store_domain === shop);
    if (existing) {
      const updated = await client.updateConnection(existing.id, { credentials, settings });
      const conn = updated?.connection ?? updated;
      return {
        connected: true, connectionId: conn?.id || existing.id,
        status: conn?.status, verified: updated?.verification?.ok !== false,
        error: updated?.verification?.error || conn?.lastError,
      };
    }

    const created = await client.createConnection({
      providerId: 'shopify',
      label: shop,
      credentials,
      settings,
      // A stable key per shop: a retry replays the original 201 instead of
      // connecting twice.
      idempotencyKey: 'shopify-connect-' + shop,
    });
    const conn = created?.connection ?? created;
    return {
      connected: true, connectionId: conn?.id,
      status: conn?.status,
      // A failed verification still returns 201 — the connection exists, the
      // credential just did not work. Surface it rather than claiming success.
      verified: created?.verification?.ok !== false,
      error: created?.verification?.error || conn?.lastError,
    };
  } catch (err) {
    // 409 = this workspace already connects that store. Find it and update.
    if (err?.status === 409) {
      try {
        const mine = (await client.listConnections('shopify'))
          .find((c) => c?.settings?.store_domain === shop);
        if (mine) {
          const updated = await client.updateConnection(mine.id, { credentials, settings });
          const conn = updated?.connection ?? updated;
          return { connected: true, connectionId: conn?.id || mine.id, status: conn?.status,
            verified: updated?.verification?.ok !== false };
        }
      } catch (e) { /* fall through to the error below */ }
    }
    return { connected: false, error: err.message };
  }
}

// GET /api/integrations/shopify — current connection status for this store.
app.get('/api/integrations/shopify', async (req, res) => {
  const shop = await requireInstalledShop(req, res);
  if (!shop) return;
  const client = telenowFor(shop, res);
  if (!client) return;
  try {
    const conn = (await client.listConnections('shopify'))
      .find((c) => c?.settings?.store_domain === shop) || null;
    res.json({
      connected: Boolean(conn),
      connectionId: conn?.id || null,
      status: conn?.status || null,
      account: conn?.settings?.account || null,
      capabilities: conn?.capabilities || [],
      lastError: conn?.lastError || null,
    });
  } catch (err) {
    telenowFail(res, err, 'integration');
  }
});

// POST /api/integrations/shopify/connect — connect or repair on demand. The
// same routine runs automatically when the API key is saved; this is the retry.
app.post('/api/integrations/shopify/connect', async (req, res) => {
  const shop = await requireInstalledShop(req, res);
  if (!shop) return;
  const client = telenowFor(shop, res);
  if (!client) return;
  res.json(await connectShopifyIntegration(shop, client));
});

// GET /api/templates — the ready-made agent catalog, plus whether each is
// already set up for this store and whether the Shopify connector is live.
app.get('/api/templates', async (req, res) => {
  const shop = await requireInstalledShop(req, res);
  if (!shop) return;
  const installed = getSettings(shop).installedTemplates || {};
  let connection = null;
  const client = telenowForOrNull(shop);
  if (client) {
    try {
      connection = (await client.listConnections('shopify'))
        .find((c) => c?.settings?.store_domain === shop) || null;
    } catch (e) { /* the catalog still renders without it */ }
  }
  res.json({
    templates: listTemplates().map((t) => ({ ...t, installed: installed[t.key] || null })),
    // Tools need the connector. Without it the agents still get created, but
    // they cannot read the store mid-call — so the UI warns rather than
    // silently producing a weaker agent.
    connected: Boolean(connection && connection.status === 'active'),
    connectionId: connection?.id || null,
  });
});

// POST /api/templates/:key/setup — create this agent in Telenow, wired to the
// store's Shopify connector, and add it to the store's agent list.
app.post('/api/templates/:key/setup', async (req, res) => {
  const shop = await requireInstalledShop(req, res);
  if (!shop) return;
  const tpl = getTemplate(req.params.key);
  if (!tpl) {
    res.status(404).json({ error: 'unknown_template', message: 'No such template.' });
    return;
  }
  const client = telenowFor(shop, res);
  if (!client) return;

  try {
    // Connect the store first if it is not already — the tools are the point.
    let conn = (await client.listConnections('shopify'))
      .find((c) => c?.settings?.store_domain === shop) || null;
    if (!conn) {
      const r = await connectShopifyIntegration(shop, client);
      if (r.connected) {
        conn = (await client.listConnections('shopify'))
          .find((c) => c?.settings?.store_domain === shop) || null;
      }
    }

    const profile = await getShopProfile(shop).catch(() => null);
    const payload = buildAgentPayload(tpl, shop, profile?.name, conn?.id || null);
    const agent = await client.createAgent(payload);
    if (!agent?.id) throw new Error('Telenow did not return an agent id.');

    // Show up on the Agents page without a second step.
    addSavedAgent(shop, agent.id);
    const installed = { ...(getSettings(shop).installedTemplates || {}) };
    installed[tpl.key] = { agentId: agent.id, at: new Date().toISOString() };
    updateSettings(shop, { installedTemplates: installed });

    console.log(`[template] shop=${shop} ${tpl.key} -> agent=${agent.id} tools=${payload.metadata.tools.length}`);
    res.json({
      agentId: agent.id,
      name: agent.name,
      tools: payload.metadata.tools.length,
      // False means the agent exists but has no store tools — worth saying.
      wired: Boolean(conn?.id),
    });
  } catch (err) {
    telenowFail(res, err, 'template setup');
  }
});

// POST /api/knowledge-bases — create one, optionally with its first document,
// so the merchant can write their returns/COD policy without leaving the wizard.
app.post('/api/knowledge-bases', async (req, res) => {
  const shop = await requireInstalledShop(req, res);
  if (!shop) return;
  const client = telenowFor(shop, res);
  if (!client) return;
  const name = String(req.body?.name || '').trim();
  if (!name) {
    res.status(400).json({ error: 'bad_request', message: 'A name is required.' });
    return;
  }
  try {
    const orgId = await orgIdFor(shop, client);
    if (!orgId) throw new Error('Could not resolve the Telenow organization.');
    const kb = await client.createKnowledgeBase(orgId, {
      name,
      description: String(req.body?.description || '').trim() || undefined,
    });
    if (!kb?.id) throw new Error('Telenow did not return a knowledge base id.');

    // The first document is optional — a base with no content is still valid,
    // and failing here must not lose the base that was just created.
    let document = null;
    const body = String(req.body?.body || '').trim();
    if (body) {
      try {
        const doc = await client.createKnowledgeDocument(orgId, kb.id, {
          title: String(req.body?.title || '').trim() || name,
          body,
        });
        document = doc?.id || true;
      } catch (err) {
        console.error(`[kb] document add failed for ${kb.id}:`, err.message);
      }
    }
    console.log(`[kb] shop=${shop} created ${kb.id} doc=${document ? 'yes' : 'no'}`);
    res.json({ id: kb.id, name: kb.name, document });
  } catch (err) {
    telenowFail(res, err, 'knowledge base');
  }
});

// GET /api/ndr-endpoint — the URL the merchant gives their courier, minting the
// secret on first request so a shop that never sets up RTO never holds one.
app.get('/api/ndr-endpoint', async (req, res) => {
  const shop = await requireInstalledShop(req, res);
  if (!shop) return;
  let token = getSettings(shop).ndrToken;
  if (!token) {
    token = crypto.randomBytes(32).toString('hex');
    updateSettings(shop, { ndrToken: token });
    console.log(`[ndr] minted endpoint token for ${shop}`);
  }
  res.json({ url: `${HOST}/webhooks/ndr/${token}` });
});

// POST /api/ndr-endpoint/rotate — replace the secret if it leaks.
app.post('/api/ndr-endpoint/rotate', async (req, res) => {
  const shop = await requireInstalledShop(req, res);
  if (!shop) return;
  const token = crypto.randomBytes(32).toString('hex');
  updateSettings(shop, { ndrToken: token });
  console.log(`[ndr] rotated endpoint token for ${shop}`);
  res.json({ url: `${HOST}/webhooks/ndr/${token}` });
});

// POST /api/voice-preview — synthesise a sample of one voice and stream the
// audio back, so the wizard's play buttons work without the browser ever
// holding the Telenow key.
//
// The upstream endpoint currently accepts a user JWT only, so an org API key
// gets 401. That is translated into a 501 with an explanation rather than
// passed through as a bare auth error, because it is not the merchant's
// credentials that are wrong — the capability simply is not exposed to keys yet.
app.post('/api/voice-preview', async (req, res) => {
  const shop = await requireInstalledShop(req, res);
  if (!shop) return;
  const client = telenowFor(shop, res);
  if (!client) return;

  const provider = String(req.body?.provider || '').trim();
  const voice = String(req.body?.voice || '').trim();
  if (!provider) {
    res.status(400).json({ error: 'bad_request', message: 'provider is required' });
    return;
  }
  // Short and capped: a preview costs real TTS characters on every press.
  const text = String(req.body?.text || '').trim().slice(0, 180)
    || 'Hello, this is a quick call from your store about the order you just placed.';

  try {
    const { bytes, contentType } = await client.previewVoice({
      provider, voice, text,
      config: req.body?.model ? { model: String(req.body.model) } : undefined,
    });
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'no-store');
    res.send(Buffer.from(bytes));
  } catch (err) {
    if (err?.status === 401 || err?.status === 403) {
      res.status(501).json({
        error: 'preview_unavailable',
        message: 'Voice preview is not available to API keys yet. '
          + 'Open the agent in Telenow to hear voices.',
      });
      return;
    }
    telenowFail(res, err, 'voice preview');
  }
});

// GET /api/escalations — issues raised by the agents, from the two sources that
// are actually readable.
//
// Deliberately NOT here: Freshdesk tickets. The connector exposes ticket.create
// and nothing else, so a ticket can be raised but never listed back. Nor are
// per-call tool invocations available (/api/sessions/{id}/tool-invocations is
// JWT-only, and /api/v1/calls/{id} carries no tool data), so "which calls raised
// a ticket" cannot be derived either. The UI says so rather than showing a
// half-empty list that looks broken.
app.get('/api/escalations', async (req, res) => {
  const shop = await requireInstalledShop(req, res);
  if (!shop) return;

  // Orders the agents tagged. Independent of Telenow, so it still works when
  // no API key is set.
  let orders = [];
  let ordersError = null;
  try {
    orders = (await findFlaggedOrders(shop, 50)).map((o) => ({
      id: o.id,
      name: o.name,
      createdAt: o.createdAt,
      tags: (o.tags || []).filter((t) => String(t).startsWith('telenow-')),
      note: o.note || '',
      fulfillment: o.displayFulfillmentStatus || null,
      financial: o.displayFinancialStatus || null,
      total: o.totalPriceSet?.shopMoney
        ? `${o.totalPriceSet.shopMoney.amount} ${o.totalPriceSet.shopMoney.currencyCode}` : null,
      customer: [o.customer?.firstName, o.customer?.lastName].filter(Boolean).join(' ') || null,
      phone: o.customer?.phone || null,
    }));
  } catch (err) {
    ordersError = err.message;
    console.error(`[escalations] order search failed for ${shop}:`, err.message);
  }

  // Calls that ended without a clean outcome, from this store's own agents.
  let calls = [];
  let callsError = null;
  const saved = getSavedAgents(shop);
  const client = telenowForOrNull(shop);
  if (client && saved.length) {
    try {
      const pages = await Promise.all(saved.slice(0, 10).map((id) =>
        client.listCalls({ limit: 50, agentId: id, sort: 'newest' }).catch(() => ({ calls: [] }))));
      const UNRESOLVED = new Set(['no-answer', 'failed', 'busy', 'cancelled']);
      calls = pages.flatMap((p) => p.calls || [])
        .filter((c) => UNRESOLVED.has(String(c.disposition || c.wrapup_disposition || '').toLowerCase()))
        .sort((a, b) => new Date(b.start_time || 0) - new Date(a.start_time || 0))
        .slice(0, 50)
        .map((c) => ({
          id: c.id, agent: c.agent_name, when: c.start_time,
          to: c.to_number || c.phone_number,
          disposition: c.disposition || c.wrapup_disposition,
          duration: c.duration_sec,
        }));
    } catch (err) {
      callsError = err.message;
    }
  }

  res.json({ orders, calls, ordersError, callsError, hasAgents: saved.length > 0 });
});

// GET /api/integrations — every connector this workspace has connected, so the
// wizard can tell whether a helpdesk is already available for ticket.create.
// Credentials are never included: they come back masked upstream anyway.
app.get('/api/integrations', async (req, res) => {
  const shop = await requireInstalledShop(req, res);
  if (!shop) return;
  const client = telenowFor(shop, res);
  if (!client) return;
  try {
    const conns = await client.listConnections();
    res.json({
      connections: conns.map((c) => ({
        id: c.id, providerId: c.providerId, label: c.label,
        status: c.status, capabilities: c.capabilities || [],
      })),
    });
  } catch (err) {
    telenowFail(res, err, 'integrations');
  }
});

// POST /api/integrations/connect — connect a non-Shopify provider from inside
// the wizard, so a merchant can wire up Freshdesk without leaving the setup.
//
// Shopify is excluded on purpose: it connects itself from the OAuth token this
// app already holds, and accepting a pasted one here would let a merchant point
// their Telenow workspace at a different store.
app.post('/api/integrations/connect', async (req, res) => {
  const shop = await requireInstalledShop(req, res);
  if (!shop) return;
  const client = telenowFor(shop, res);
  if (!client) return;
  const providerId = String(req.body?.providerId || '').trim();
  if (!providerId || providerId === 'shopify') {
    res.status(400).json({ error: 'bad_request', message: 'A non-Shopify providerId is required.' });
    return;
  }
  const credentials = req.body?.credentials && typeof req.body.credentials === 'object'
    ? req.body.credentials : {};
  const settings = req.body?.settings && typeof req.body.settings === 'object'
    ? req.body.settings : {};
  try {
    const created = await client.createConnection({
      providerId, label: providerId + ' — ' + shop, credentials, settings,
      idempotencyKey: providerId + '-connect-' + shop,
    });
    const conn = created?.connection ?? created;
    console.log(`[integration] shop=${shop} connected ${providerId} status=${conn?.status}`);
    res.json({
      id: conn?.id || null, status: conn?.status || null,
      capabilities: conn?.capabilities || [],
      // A failed verification still returns 201 upstream, so report it apart
      // from whether the connection exists.
      verified: created?.verification?.ok !== false,
      error: created?.verification?.error || conn?.lastError || null,
    });
  } catch (err) {
    telenowFail(res, err, 'integration connect');
  }
});

// GET /api/knowledge-bases — the org's knowledge bases, for the setup wizard.
app.get('/api/knowledge-bases', async (req, res) => {
  const shop = await requireInstalledShop(req, res);
  if (!shop) return;
  const client = telenowFor(shop, res);
  if (!client) return;
  try {
    const orgId = await orgIdFor(shop, client);
    const list = orgId ? await client.listKnowledgeBases(orgId) : [];
    res.json({ knowledgeBases: list.map((k) => ({
      id: k.id, name: k.name, description: k.description, documents: k.document_count,
    })) });
  } catch (err) {
    telenowFail(res, err, 'knowledge bases');
  }
});

// POST /api/templates/:key/publish — the setup wizard's final step.
//
// Creates the agent with the merchant's chosen stack, voice, prompt and opener,
// attaches a knowledge base if they picked one, and switches on the matching
// automation so new orders actually trigger the call.
app.post('/api/templates/:key/publish', async (req, res) => {
  const shop = await requireInstalledShop(req, res);
  if (!shop) return;
  const tpl = getTemplate(req.params.key);
  if (!tpl) {
    res.status(404).json({ error: 'unknown_template', message: 'No such template.' });
    return;
  }
  const client = telenowFor(shop, res);
  if (!client) return;
  const b = req.body || {};

  try {
    // The tools are the point, so make sure the store is connected first.
    let conn = (await client.listConnections('shopify'))
      .find((c) => c?.settings?.store_domain === shop) || null;
    if (!conn) {
      const r = await connectShopifyIntegration(shop, client);
      if (r.connected) {
        conn = (await client.listConnections('shopify'))
          .find((c) => c?.settings?.store_domain === shop) || null;
      }
    }

    const profile = await getShopProfile(shop).catch(() => null);
    // Boundaries chosen in the Access step become prompt rules. They are
    // appended rather than merged into the body so an edited prompt keeps them.
    const scope = req.body?.scope || {};
    const rules = [
      scope.noRefund && '- Never promise a refund, or state a refund amount. Say the team will confirm it.',
      scope.noDiscount && '- Never offer a discount, a free replacement or any goodwill gesture.',
      scope.noDate && '- Never promise a delivery date that the order data does not show.',
      scope.hours && `- Your team is available ${String(scope.hours).slice(0, 120)}. Mention that when something needs a person.`,
      b.postPurchase && b.postPurchase.crossSell === false
        && '- Do NOT recommend or sell anything on this call. Check in, answer questions, and end.',
      b.postPurchase?.crossSell && !b.postPurchase?.waConnectionId
        && '- You cannot send a link. If they want the product, tell them you will have the team message them.',
      b.feedback?.tagOrder && '- After they give a score, use update_order to tag the order telenow-feedback-<score> and add their exact words as a note.',
      b.feedback?.flagLow && '- If the score is 3 or below, also tag it telenow-feedback-low so a person follows up. Tell them someone from the team will call.',
    ].filter(Boolean);
    const NL = String.fromCharCode(10);
    const promptOverride = rules.length
      ? [String(b.systemPrompt || tpl.prompt), '', '## Limits set by the store', ...rules].join(NL)
      : b.systemPrompt;

    // With cross-sell off, the checkout tool is removed outright — a prompt rule
    // alone still leaves the model holding a way to spend the customer's money.
    const tplForBuild = (b.postPurchase && b.postPurchase.crossSell === false)
      ? { ...tpl, capabilities: tpl.capabilities.filter((c) => c !== 'checkout.create_link') }
      : tpl;

    const payload = buildAgentPayload(tplForBuild, shop, profile?.name, conn?.id || null, {
      llmProvider: b.llmProvider, llmModel: b.llmModel,
      sttProvider: b.sttProvider, sttModel: b.sttModel,
      ttsProvider: b.ttsProvider, ttsVoice: b.ttsVoice, ttsModel: b.ttsModel,
      systemPrompt: promptOverride, opener: b.opener, speakOpener: b.speakOpener,
      transferDestinations: b.transferDestinations, transferMessage: b.transferMessage,
      // Off unless the wizard explicitly asked for it — it is billed per call.
      postCallAnalysis: b.postCallAnalysis === true,
      // Escalation tools, each bound to the connection that provides it.
      extraTools: [
        // Feedback writes the score back as a tag + note, so it needs the write
        // capability its template does not carry by default.
        // The link is created by the Shopify connector but delivered by the
        // WhatsApp one, so the two tools carry different connection ids.
        b.postPurchase?.crossSell && b.postPurchase?.waConnectionId
          ? { capability: 'whatsapp.send', connectionId: b.postPurchase.waConnectionId } : null,
        (b.feedback?.tagOrder || b.feedback?.flagLow) && conn?.id
          ? { capability: 'order.update', connectionId: conn.id } : null,
        b.escalation?.logOnOrder && conn?.id
          ? { capability: 'order.update', connectionId: conn.id } : null,
        b.escalation?.freshdeskConnectionId
          ? { capability: 'ticket.create', connectionId: b.escalation.freshdeskConnectionId } : null,
      ].filter(Boolean),
    });
    const agent = await client.createAgent(payload);
    if (!agent?.id) throw new Error('Telenow did not return an agent id.');

    // Inbound: bind the number so customers can actually reach the agent. Done
    // after creation because it needs the agent id, and reported separately so
    // a 409 does not throw away an otherwise-good agent.
    let inbound = null;
    if (b.inboundNumberId) {
      try {
        await client.assignNumberToAgent(String(b.inboundNumberId), agent.id);
        inbound = { assigned: true };
      } catch (err) {
        inbound = { assigned: false, error: err.message, conflict: err?.status === 409 };
        console.error(`[publish] number assign failed for ${agent.id}:`, err.message);
      }
    }

    // Knowledge base is optional and must never sink a successful publish.
    let knowledgeBase = null;
    if (b.knowledgeBaseId) {
      try {
        const orgId = await orgIdFor(shop, client);
        await client.attachKnowledgeBase(orgId, agent.id, b.knowledgeBaseId);
        knowledgeBase = b.knowledgeBaseId;
      } catch (err) {
        console.error(`[publish] KB attach failed for ${agent.id}:`, err.message);
      }
    }

    // Switch the automation on, so an order actually triggers a call.
    const delaySeconds = Math.max(0, Number(b.delaySeconds) || 0);
    let automation = null;
    if (AUTOMATIONS.some((a) => a.key === tpl.automationKey)) {
      updateSettings(shop, { automations: { [tpl.automationKey]: {
        enabled: b.enableAutomation !== false,
        agentId: agent.id,
        delaySeconds,
        fromNumberId: String(b.fromNumberId || '') || undefined,
        // RTO only: the courier fires one NDR per attempt, and maxAttempts
        // decides how many of those become calls.
        // Per-template filters the sweeps and receivers read back.
        filters: (b.maxAttempts || b.feedback || b.postPurchase)
          ? {
              ...(getAutomation(shop, tpl.automationKey)?.filters || {}),
              ...(b.maxAttempts ? { maxAttempts: Math.max(1, Number(b.maxAttempts) || 1) } : {}),
              ...(b.postPurchase ? {
                daysAfterFulfillment: Math.max(1, Number(b.postPurchase.daysAfterFulfillment) || 10),
                maxAgeDays: Math.max(7, Number(b.postPurchase.maxAgeDays) || 30),
                minOrderValue: Math.max(0, Number(b.postPurchase.minOrderValue) || 0),
                maxPerSweep: Math.max(1, Number(b.postPurchase.maxPerSweep) || 25),
                suppressDays: Math.max(0, Number(b.postPurchase.suppressDays ?? 14)),
              } : {}),
              ...(b.feedback ? {
                daysAfterFulfillment: Math.max(1, Number(b.feedback.daysAfterFulfillment) || 7),
                maxAgeDays: Math.max(7, Number(b.feedback.maxAgeDays) || 30),
                minOrderValue: Math.max(0, Number(b.feedback.minOrderValue) || 0),
                maxPerSweep: Math.max(1, Number(b.feedback.maxPerSweep) || 25),
              } : {}),
            }
          : undefined,
        quietHours: b.quietHours && typeof b.quietHours === 'object'
          ? {
              enabled: Boolean(b.quietHours.enabled),
              start: String(b.quietHours.start || '21:00'),
              end: String(b.quietHours.end || '09:00'),
              timezone: String(b.quietHours.timezone || 'Asia/Kolkata'),
            }
          : undefined,
      } } });
      automation = tpl.automationKey;
    }

    addSavedAgent(shop, agent.id);
    const installed = { ...(getSettings(shop).installedTemplates || {}) };
    installed[tpl.key] = { agentId: agent.id, at: new Date().toISOString() };
    updateSettings(shop, { installedTemplates: installed });

    console.log(`[publish] shop=${shop} ${tpl.key} -> agent=${agent.id} ` +
      `tools=${payload.metadata.tools.length} kb=${knowledgeBase || 'none'} delay=${delaySeconds}s`);
    res.json({
      agentId: agent.id, name: agent.name,
      tools: payload.metadata.tools.length,
      wired: Boolean(conn?.id),
      knowledgeBase, automation, delaySeconds, inbound,
    });
  } catch (err) {
    telenowFail(res, err, 'publish');
  }
});

// GET /api/numbers — phone numbers this org has bought, for the "call from"
// picker. An empty list is a normal state, not an error: the merchant simply
// has not purchased a number yet, and the UI points them at Telenow to buy one.
app.get('/api/numbers', async (req, res) => {
  const shop = await requireInstalledShop(req, res);
  if (!shop) return;
  const client = telenowFor(shop, res);
  if (!client) return;
  try {
    const numbers = await client.listNumbers();
    // Only live numbers can place a call, so do not offer the others.
    res.json({ numbers: numbers.filter((n) => n && n.is_active !== false) });
  } catch (err) {
    telenowFail(res, err, 'numbers');
  }
});

// POST /api/test-call — ring the merchant's own phone so they can talk to an
// agent. Telephony rather than a browser web call: this UI runs in an iframe
// inside admin.shopify.com, where a web call would need mic permission and a
// WebRTC stack. This is one server-side POST and the merchant answers a phone.
//
// This SPENDS the merchant's Telenow balance, so the number is validated here
// as well as in the UI — never trust the client for something that costs money.
app.post('/api/test-call', async (req, res) => {
  const shop = await requireInstalledShop(req, res);
  if (!shop) return;
  const client = telenowFor(shop, res);
  if (!client) return;

  const agentId = String(req.body?.agentId || '').trim();
  const mobileNumber = String(req.body?.mobileNumber || '').trim();
  if (!agentId) {
    res.status(400).json({ error: 'bad_request', message: 'agentId is required' });
    return;
  }
  // E.164: leading +, no leading zero, 7-15 digits total.
  if (!new RegExp("^[+][1-9][0-9]{6,14}$").test(mobileNumber)) {
    res.status(400).json({ error: 'bad_number', message: 'Enter a number in E.164 form, e.g. +919876543210.' });
    return;
  }

  // Only string values, and only for keys the caller actually sent — the agent
  // substitutes these into its prompt.
  const variables = {};
  const raw = req.body?.variables;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === 'string' && v.trim()) variables[k] = v.trim().slice(0, 500);
    }
  }

  try {
    const result = await client.initiateCall({
      agentId,
      mobileNumber,
      variables,
      identifier: 'shopify-test:' + shop,
      // Optional. Blank means "let the agent decide" for both.
      fromNumberId: String(req.body?.fromNumberId || '').trim() || undefined,
      machineDetection: String(req.body?.machineDetection || 'agent').trim(),
    });
    console.log(`[test-call] shop=${shop} agent=${agentId} session=${result?.sessionId || '?'}`);
    res.json({ sessionId: result?.sessionId || null });
  } catch (err) {
    telenowFail(res, err, 'test call');
  }
});

// How deep merged pagination can go. Serving rows [offset, offset+limit) of a
// merged stream means pulling offset+limit rows from EVERY agent, so the fetch
// grows with page depth — this caps that rather than letting page 40 fan out
// into a huge multi-agent read.
const MERGE_DEPTH_CAP = 400;

// GET /api/calls — call history, restricted to the agents this store added.
//
// The org's Telenow account may run agents unrelated to this shop, so showing
// every call would leak other conversations into the merchant's list. Scope is
// savedAgents, not the org.
//
// One saved agent uses the upstream agent_id filter directly (exact total, one
// request, real offset). Several are fetched in parallel and merged, because
// that filter takes a single id.
app.get('/api/calls', async (req, res) => {
  const shop = await requireInstalledShop(req, res);
  if (!shop) return;
  const client = telenowFor(shop, res);
  if (!client) return;

  const saved = getSavedAgents(shop);
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const empty = { calls: [], total: 0, limit, offset: 0, hasMore: false, scopedToAgents: saved.length };
  if (!saved.length) { res.json({ ...empty, scopedToAgents: 0 }); return; }

  const status = req.query.status || undefined;
  const sort = req.query.sort || undefined;
  // An explicit ?agentId= narrows further, but only within the saved set.
  const only = String(req.query.agentId || '').trim();
  const ids = only ? saved.filter((id) => id === only) : saved;
  if (!ids.length) { res.json(empty); return; }

  try {
    if (ids.length === 1) {
      const r = await client.listCalls({ limit, offset, status, sort, agentId: ids[0] });
      res.json({
        calls: r.calls, total: r.total, limit, offset,
        hasMore: offset + (r.calls?.length || 0) < (r.total || 0),
        scopedToAgents: saved.length,
      });
      return;
    }

    // Pull enough from each agent that the merged stream reaches this page.
    const need = Math.min(offset + limit, MERGE_DEPTH_CAP);
    const pages = await Promise.all(
      ids.map((id) => client.listCalls({ limit: Math.min(need, 200), offset: 0, status, sort, agentId: id })
        .catch(() => ({ calls: [], total: 0 }))),
    );
    const merged = pages.flatMap((p) => p.calls || []);
    const total = pages.reduce((n, p) => n + (p.total || 0), 0);
    // Each page was sorted on its own, so the concatenation is not sorted.
    const time = (c) => new Date(c.start_time || c.created_at || 0).getTime() || 0;
    const dur = (c) => Number(c.duration_sec) || 0;
    const cmp = {
      oldest: (a, b) => time(a) - time(b),
      longest: (a, b) => dur(b) - dur(a),
      shortest: (a, b) => dur(a) - dur(b),
    }[sort] || ((a, b) => time(b) - time(a));
    merged.sort(cmp);

    res.json({
      calls: merged.slice(offset, offset + limit),
      total, limit, offset,
      hasMore: merged.length > offset + limit,
      // True when the cap, not the data, ended the list — so the UI can say so
      // instead of implying there is nothing further.
      depthCapped: need >= MERGE_DEPTH_CAP && total > MERGE_DEPTH_CAP,
      scopedToAgents: saved.length,
    });
  } catch (err) {
    telenowFail(res, err, 'calls');
  }
});

// GET /api/calls/:id — one call, for the detail drawer.
app.get('/api/calls/:id', async (req, res) => {
  const shop = await requireInstalledShop(req, res);
  if (!shop) return;
  const client = telenowFor(shop, res);
  if (!client) return;
  try {
    res.json(await client.getCallDetail(req.params.id));
  } catch (err) {
    telenowFail(res, err, 'call');
  }
});

// GET /api/shop — merchant profile synced from Shopify, shown in the UI header
// and the welcome flow. Cached per request; the Admin call is cheap and rare.
app.get('/api/shop', async (req, res) => {
  const shop = await requireInstalledShop(req, res);
  if (!shop) return;
  try {
    const profile = await getShopProfile(shop);
    res.json({ shop: profile });
  } catch (err) {
    console.error('[api] shop profile failed:', err.message);
    // Non-fatal: the UI still works without it, so degrade instead of erroring.
    res.json({ shop: null, error: err.message });
  }
});

// POST /api/onboarding/complete — records that the welcome flow was seen, so
// it only ever shows once per shop.
app.post('/api/onboarding/complete', async (req, res) => {
  const shop = await requireInstalledShop(req, res);
  if (!shop) return;
  const saved = updateSettings(shop, { onboardedAt: new Date().toISOString() });
  res.json({ onboardedAt: saved.onboardedAt });
});

// GET captured leads (newest first) for the Leads view in the embedded app.
app.get('/api/leads', async (req, res) => {
  const shop = await requireInstalledShop(req, res);
  if (!shop) return;
  res.json({ leads: listLeads(shop, 100) });
});

// POST settings update. If the API key changed, (re)subscribe the Telenow hook.
app.post('/api/settings', async (req, res) => {
  const shop = await requireInstalledShop(req, res);
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
      // Same auto-connect as validate-key, for the settings-save path.
      try {
        await connectShopifyIntegration(shop, new TelenowClient(saved.telenowApiKey));
      } catch (e) { /* never block saving the key on this */ }
      hookStatus = 'Telenow connected and result webhook subscribed.';
    } catch (err) {
      hookStatus = `Saved, but Telenow setup failed: ${err.message}`;
    }
  }

  res.json({ settings: getRedactedSettings(shop), hookStatus });
});

// POST validate-key: optionally save a new key, then call Telenow /me.
app.post('/api/validate-key', async (req, res) => {
  const shop = await requireInstalledShop(req, res);
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
    const client = new TelenowClient(key);
    const me = await client.me();
    // The key is good — now connect this Shopify store to their Telenow
    // workspace using the Admin token we already hold, so the merchant never
    // has to paste one into Telenow by hand.
    //
    // Deliberately non-fatal: a valid key must still save even if the store
    // connection fails (a viewer-role key cannot write connections, for one).
    let integration = null;
    try {
      integration = await connectShopifyIntegration(shop, client);
      console.log(`[integration] shop=${shop} connected=${integration.connected}` +
        (integration.error ? ` error=${integration.error}` : ''));
    } catch (err) {
      integration = { connected: false, error: err.message };
    }
    res.json({ ...me, integration });
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
        delaySeconds: a.delaySeconds == null || a.delaySeconds === ''
          ? undefined
          : Math.max(0, Number(a.delaySeconds) || 0),
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
      if (out.automations[def.key].delaySeconds === undefined) delete out.automations[def.key].delaySeconds;
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
    try {
      await runPostPurchaseSweep();
    } catch (err) {
      console.error('[scheduler] post-purchase sweep error:', err.message);
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
