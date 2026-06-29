# Shopify Voice AI — AI Voice Agent for Shopify | Telenow

**Turn Shopify store events into real AI phone calls — recover abandoned carts, confirm COD orders, cut RTO, and write every outcome back onto the order.**

[![License: MIT](https://img.shields.io/badge/License-MIT-green)](#-license)
[![Platform](https://img.shields.io/badge/Platform-Shopify-95BF47)](https://www.shopify.com)
[![Node](https://img.shields.io/badge/Node-%3E%3D18-339933)](https://nodejs.org)
[![Powered by Telenow](https://img.shields.io/badge/Powered_by-Telenow-6C2BD9)](https://telenow.ai)

**Shopify Voice AI** is a free, open-source embedded Shopify app that turns store events into real outbound phone calls placed by an AI voice agent. When a shopper abandons a checkout, places a Cash-on-Delivery order, or a fulfillment ships, the app triggers a natural, multilingual voice call — **abandoned cart recovery**, **COD confirmation** and **RTO reduction**, **order confirmation calls**, **delivery updates**, **failed-delivery (NDR) retry**, **win-back**, and **instant lead callback** — then writes the call outcome straight back onto the Shopify order as tags, notes, and a metafield. It connects to [Telenow](https://telenow.ai), a separate voice-AI calling service that needs its own account and a `vai_live_…` API key and is billed on usage by Telenow (never through Shopify). The result: store events become real AI phone conversations — including live "where is my order?" Q&A and a **Hindi / multilingual voice agent** — with the disposition logged on the order, no glue code required.

## Table of Contents

- [✨ Features](#-features)
- [🚀 Installation](#-installation)
- [⚙️ Configuration](#️-configuration)
- [🧩 How it works](#-how-it-works)
- [🔐 OAuth / install flow](#-oauth--install-flow)
- [🤖 Automations & the data written back](#-automations--the-data-written-back)
- [📥 Telenow webhooks (inbound)](#-telenow-webhooks-inbound)
- [🛡️ Security notes](#️-security-notes)
- [✅ Production checklist](#-production-checklist)
- [🧪 Local round-trip test](#-local-round-trip-test)
- [📁 Project layout](#-project-layout)
- [📞 About Telenow](#-about-telenow)
- [📄 License](#-license)

## ✨ Features

Every automation is independently toggleable, with its own agent, delay, quiet-hours window, and filters.

- **Abandoned checkout recovery** — fires on `checkouts/create` / `checkouts/update`; after a delay, if the cart still hasn't converted, the AI voice agent calls the shopper with their recovery link (and an optional discount) to win the sale back.
- **COD confirmation & RTO reduction** — fires on `orders/create` for Cash-on-Delivery orders; verifies the order by phone *before* you ship, so you stop paying for returns-to-origin and refused parcels. The result tags the order `telenow-cod-confirmed`, `telenow-cod-cancelled`, or `telenow-cod-no-response`.
- **Order confirmation calls** — fires on `orders/create`; confirms new orders the moment they're placed.
- **Delivery & shipping updates** — fires on `orders/fulfilled`; reads out the tracking number, tracking URL, and carrier as soon as the order is fulfilled.
- **Failed-delivery (NDR) retry** — ready-to-wire handler to call customers on a carrier "failed/exception" event and re-attempt or re-confirm the address before the parcel bounces back (wire your carrier/3PL webhook — see [Production checklist](#-production-checklist)).
- **Win-back / re-engagement** — scheduled sweep that re-activates lapsed customers whose last order is older than *N* days, with an optional discount.
- **Instant lead callback (speed to lead)** — fires on `customers/create`; phones a new customer or captured lead within seconds of sign-up (delay defaults to `0`). Every lead is captured to a built-in **Leads** view even when no call is placed.
- **Review, feedback & NPS calls** — scheduled stub to collect ratings and feedback X days after fulfillment.
- **Two-way live Q&A** — the agent can answer the shopper in real time during the call ("where is my order?", product and order lookups) using your existing Telenow agent's tools.
- **Order write-back** — on every call result the app writes order **tags**, appends an order **note**, and sets a `telenow.last_call` order **metafield** (`session_id`, `status`, `disposition`, `duration`, `ended_at`) so your team and theme always know the outcome.
- **Multilingual / Hindi voice agent** — uses your existing Telenow agents for a natural voice in English, Hindi and other Indian languages, plus global languages.
- **Quiet hours** — calls are suppressed inside each automation's local quiet-hours window, and re-checked at fire time for delayed calls.
- **Per-automation controls** — choose the Telenow agent ID, delay (minutes), quiet-hours window, and free-form filters per automation.
- **Extra use-case stubs** — `src/automations/extras.js` ships ready-to-fill stubs for back-in-stock callback, payment-failed retry, subscription renewal reminder, upsell/cross-sell, replenishment reminder, and high-value-order fraud check.

> **Free app — requires a Telenow account.** The app is free to install. Telenow is a separate third-party service that bills for call usage on its own platform; you connect it with your own `vai_live_…` API key (Telenow → Developers → API Keys). No charges go through Shopify.

## 🚀 Installation

```bash
git clone https://github.com/TelenowAI/shopify-voice-ai-app.git
cd shopify-voice-ai-app
npm install
cp .env.example .env      # fill in the values below
npm start                 # or: npm run dev  (node --watch)
```

You need a public HTTPS URL (Shopify and Telenow both call you). In dev, use a tunnel:

```bash
ngrok http 3000           # then set HOST=https://<id>.ngrok-free.app in .env
```

Requires **Node.js 18+** (the app uses the global `fetch`).

## ⚙️ Configuration

Copy `.env.example` to `.env` and fill in the values:

| Var | Required | Description |
| --- | --- | --- |
| `HOST` | ✅ | Public HTTPS base URL of this app (no trailing slash). Builds the OAuth callback and the Telenow webhook target. |
| `PORT` | | Listen port (default `3000`). |
| `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` | ✅ | From your app in the Shopify Partners dashboard. |
| `SHOPIFY_SCOPES` | | Defaults to `read_orders,write_orders,read_customers,read_checkouts,read_fulfillments`. Must match the Partners app config. |
| `SHOPIFY_API_VERSION` | | Admin REST version for write-backs (default `2025-10`). |
| `TELENOW_API_BASE` | | Telenow API base (default `https://api.telenow.ai`). |
| `DATA_DIR` | | Where the file store persists (default `./data`). |
| `DEFAULT_PHONE_COUNTRY` | | ISO-2 country for E.164 normalization of local numbers (default `IN`). |
| `SWEEP_INTERVAL_MS` / `SWEEP_RUN_ON_BOOT` | | Scheduler cadence (default 6h) / run sweeps once at boot for testing. |

> The **Telenow API key is not an env var** — each merchant pastes their own `vai_live_…` key in the settings page (`/app`), stored per shop.

## 🧩 How it works

```
Shopify store ──webhook(HMAC)──▶  this app  ──POST /api/sessions/initiate-call──▶  Telenow
     ▲                              │   ▲                                              │
     └──Admin API (tags/notes)──────┘   └──────POST /telenow/webhook (HMAC) ◀──────────┘
                                              (call.ended / call.analyzed)
```

The store "talks to" Telenow: a Shopify event hits this app over an HMAC-verified webhook, the app places an AI voice call through Telenow's API, and Telenow posts the call result back — at which point the app writes the outcome onto the Shopify order via the Admin API.

**Tech:** Node.js 18+ (global `fetch`), Express, `@shopify/shopify-api` for OAuth + webhook HMAC. No DB — a file-based store stub you swap in production.

## 🔐 OAuth / install flow

Auth uses Shopify **OAuth (offline token)** for the store, plus a per-shop Telenow **API key** (`X-API-Key`) the merchant pastes in the settings page and that is validated via `GET /api/v1/me`.

1. Merchant visits `HOST/auth?shop=THEIR-STORE.myshopify.com` (or `HOST/?shop=…`, which redirects).
2. App runs `shopify.auth.begin` → Shopify consent → `GET /auth/callback`.
3. On callback the app: persists the **offline access token**, **registers all Shopify webhooks**, and (if a Telenow key is already set) **subscribes the Telenow result webhook**. It then redirects to `/app`.
4. In `/app` the merchant pastes their Telenow API key (validated via `GET /api/v1/me`), picks an **agent ID** per automation, toggles automations, and sets delays/quiet-hours. Saving a new key (re)subscribes the Telenow webhook via `POST /api/v1/hooks`.

## 🤖 Automations & the data written back

Each automation builds a `variables` object and calls `POST /api/sessions/initiate-call` with the agent, the E.164 number, an `identifier` (e.g. `order:12345`), and `machineDetection: "hangup"`. We persist `sessionId → orderId` so the result webhook can find the order.

| Automation | Shopify trigger | Variables passed to the agent | Write-back on result |
| --- | --- | --- | --- |
| Abandoned checkout | `checkouts/create\|update` | `customer_name, cart_items, cart_total, currency, recovery_url, store_name, discount_code?` | logged (usually no order yet) |
| COD confirmation | `orders/create` (COD only) | `customer_name, order_number, order_items, order_total, payment_method, shipping_city` | tag `telenow-cod-confirmed` / `telenow-cod-cancelled` / `telenow-cod-no-response` + note |
| Order confirmation | `orders/create` | `customer_name, order_number, order_items, order_total` | note + metafield |
| Shipped | `orders/fulfilled` | `customer_name, order_number, tracking_number, tracking_url, carrier` | note + metafield |
| Lead callback | `customers/create` | `customer_name, email, source, store_name, tags, accepts_marketing, orders_count, city` | lead row updated (status + disposition + summary) |
| Win-back | scheduled | `customer_name, days_since_last_order, discount_code?` | note + metafield (when an order id is known) |
| Reviews / NPS | scheduled (stub) | `customer_name, order_number` | — |

On every call result we also write a `telenow.last_call` order **metafield** with `{ session_id, status, disposition, duration, ended_at }`.

> **COD cancelled does NOT auto-cancel the order** — we only tag + note it so the merchant reviews first. There's a clearly-marked `TODO` in `src/webhooks/telenow.js` to optionally call `POST /orders/{id}/cancel.json`.

### Extending — extra use cases

`src/automations/extras.js` ships ready-to-fill stubs for **back-in-stock callback, payment-failed retry, subscription renewal reminder, upsell/cross-sell, replenishment reminder, high-value-order fraud check**. To activate one: add it to `AUTOMATIONS` in `settings.js`, wire its trigger in `webhooks/shopify.js` (or a scheduled job), build `variables`, and call `placeCall(...)` — copy the pattern from `codConfirmation.js`.

## 📥 Telenow webhooks (inbound)

We subscribe with `POST /api/v1/hooks` (`events: ["call.ended","call.analyzed"]`, `source: "shopify"`, `includeTranscript: true`) and store the returned signing **secret** per shop. Telenow then POSTs results to `HOST/telenow/webhook` with:

```
X-VoiceAI-Signature: sha256=<hex HMAC-SHA256 of the raw body>
X-VoiceAI-Event:     call.ended | call.analyzed
X-VoiceAI-Delivery:  <uuid>
```

We verify by recomputing the HMAC over the **raw body** with that secret (constant-time compare), match the order via the persisted `sessionId` (falling back to the `identifier`), and decide COD confirmed-vs-cancelled from `analysis.disposition` (with a summary/transcript keyword fallback).

## 🛡️ Security notes

- **HMAC in both directions.** Inbound Shopify webhooks are verified by `@shopify/shopify-api` against `SHOPIFY_API_SECRET`; inbound Telenow webhooks are verified against the per-hook signing secret. Bad signatures get `401`. Webhook routes receive the **raw body** (mounted before the JSON parser) so the bytes match exactly.
- **Session-token auth for the settings API.** The embedded app's settings/leads API authorizes off a signed session token (`Authorization: Bearer …`), not the non-secret `?shop=` query, so one tenant can't read another's leads or overwrite its API key.
- **E.164 normalization.** Phone numbers from Shopify are normalized to E.164 before dialing (`src/util/phone.js`); un-normalizable numbers are skipped, never dialed.
- **Never log the API key.** The Telenow `X-API-Key` is never logged or sent to the browser — the settings page only ever sees a masked hint. Phone numbers are masked in logs.
- **Open-redirect / SSRF guard.** The `?shop=` parameter is validated against `*.myshopify.com` and sanitized via the library before any OAuth redirect.
- **Quiet hours.** Calls are suppressed inside each automation's local quiet-hours window (and re-checked at fire time for delayed calls).
- **Webhook dedupe.** Shopify redelivers webhooks (and `checkouts/update` fires many times per cart), so the app refuses to place a second call for the same entity within a TTL, clearing the mark if placement itself fails so a genuine retry still goes through.

## ✅ Production checklist

- [ ] **Swap the file store for a real DB.** `src/store.js` is an in-memory + JSON-file stub (no locking, last-write-wins, single-process). Move shops/settings/callMap/hooks to Postgres/MySQL/DynamoDB. The four logical stores are documented at the top of the file.
- [ ] **Durable scheduling for delays + sweeps.** Delayed calls use `setTimeout` and win-back/reviews use `setInterval` — neither survives a restart or scales across instances. Use a job queue (BullMQ/Redis, SQS) or `node-cron` with a leader lock.
- [ ] **Host on HTTPS** with a stable `HOST`. Re-register webhooks if the URL changes.
- [x] **Mandatory GDPR webhooks.** `customers/data_request`, `customers/redact`, `shop/redact` are registered, HMAC-verified, and act on the data we hold: data_request collects the customer's local call records, customers/redact erases them (call map + dedupe attempts), shop/redact purges all shop data. **Remaining for production:** forward redaction/export to Telenow for the actual voice recordings/transcripts (TODOs marked in `src/webhooks/shopify.js`).
- [ ] **App review.** Provide a test store, production HTTPS, and public docs (https://telenow.ai/docs). Confirm requested scopes match the Partners app config exactly.
- [ ] **Per-customer call frequency caps / suppression list** (don't call the same shopper repeatedly across automations).
- [ ] **Replace the win-back last-order proxy.** `winBack.js` approximates last-order date with `customer.updated_at`; maintain a true `last_order_at` index from `orders/create`, or use a Customer Segment query.
- [ ] **Persist `fulfilledAt`** on `orders/fulfilled` to activate the reviews/NPS sweep.

## 🧪 Local round-trip test

A self-contained harness proves the **entire integration chain** end-to-end on
your machine — **no real Shopify store, no real Telenow backend, and no hosting
required**. It drives the app's real modules (the wired Express app, the Shopify
webhook HMAC verifier, `placeCall`, the Telenow client, the result-webhook
receiver and the lead store), with an in-process mock Telenow API.

```bash
npm run roundtrip
```

What it exercises (the lead-callback path, whose write-back is to the app's own
lead store, so no Shopify Admin API is needed):

1. Seeds an installed shop + Telenow hook + settings directly via `store.js`
   (bypassing OAuth), enabling the `leadCallback` automation with an agent id and
   a Telenow API key.
2. POSTs a **real, HMAC-signed** `customers/create` webhook to `/webhooks/shopify`
   (`X-Shopify-Hmac-Sha256: base64(HMAC-SHA256(body, SHOPIFY_API_SECRET))`), which
   the bundled `@shopify/shopify-api` verifier accepts.
3. Asserts the mock Telenow received an `initiate-call` with the expected E.164
   number and a `lead:<id>` identifier, and that a lead row was stored and moved
   to `placed`.
4. Fires a `call.analyzed` **result webhook** back at `/telenow/webhook`, signed
   with the mock's hook secret (`X-VoiceAI-Signature: sha256=<hex>`), and asserts
   the lead is updated to `completed` / disposition `confirmed`.
5. Asserts a result webhook with a **wrong signature** is rejected with `401` and
   leaves the lead unchanged.

It prints `PASS`/`FAIL` per check and exits non-zero on any failure. It uses a
throwaway temp `DATA_DIR` (removed on exit) and dummy credentials, so it needs no
real keys and touches no network. Test files live in `test/`
(`test/mock-telenow.mjs`, `test/roundtrip.mjs`).

## 📁 Project layout

```
src/
  server.js              Express app: routers, body parsers, settings API, schedulers
  shopify.js             @shopify/shopify-api config + Admin REST write-back helpers
  auth.js                OAuth /auth + /auth/callback; registers webhooks on install
  telenow.js             Telenow API client (me, initiateCall, createHook, listHooks, deleteHook)
  settings.js            Per-shop settings model + defaults + redaction
  store.js               Persistence STUB (file JSON) — swap for a DB
  webhooks/
    shopify.js           Shopify webhook receiver (HMAC) + GDPR stubs + dispatch
    telenow.js           Telenow result receiver (HMAC) + write-back + hook lifecycle
  automations/
    _base.js             placeCall(): gating (enabled/key/agent/quiet/delay) + dial + map
    abandonedCheckout.js codConfirmation.js orderUpdates.js winBack.js reviews.js leadCallback.js
    extras.js            stubs for additional use cases
  util/
    phone.js             E.164 normalization
    quietHours.js        timezone-aware quiet-hours check
  public/app.html        embedded settings UI
```

## 📞 About Telenow

[Telenow](https://telenow.ai) is a multilingual AI voice-calling platform that places and answers natural-sounding phone calls with AI voice agents — in English, Hindi, and other Indian and global languages — and reports every call's outcome back to your systems. This Shopify app is a free connector to that service; you bring your own Telenow account and `vai_live_…` API key, and Telenow bills for call usage on its own platform.

- Website: [telenow.ai](https://telenow.ai)
- Docs: [telenow.ai/docs](https://telenow.ai/docs)
- Pricing: [telenow.ai/#pricing](https://telenow.ai/#pricing)

## 📄 License

[MIT](https://opensource.org/licenses/MIT) © Telenow
