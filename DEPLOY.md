# Deploying

This app is a single Node/Express process that keeps its state in a JSON file and
runs its outbound-call sweeps on an in-process timer. That combination decides the
whole deployment shape, so read the constraint first — most of the hosting menu is
disqualified by it, and the ones that "work" but violate it fail silently rather
than loudly.

Two platforms are covered: **[Render](#deploying-to-render)** (currently in use) and
**[AWS](#deploying-to-aws)**.

---

## Deploying to Render

Render satisfies the single-instance constraint well — attaching a Disk *forces*
one instance and disables rolling deploys, which is exactly what this app needs.
Caddy is not used here; Render terminates TLS for you, so
[docker-compose.yml](docker-compose.yml) and [deploy/Caddyfile](deploy/Caddyfile)
are not part of a Render deploy.

### Required settings

| Setting | Value | Why |
|---|---|---|
| Instance type | **Starter** ($7/mo) or higher | [Free services cannot attach a disk](https://render.com/docs/free), and free instances spin down — which times out Shopify webhooks and stops the sweeps entirely. |
| Disk | Attach one, any size (~$0.25/GB/mo) | Without it, `store.json` — every merchant's OAuth token and Telenow API key — is wiped on every deploy. |
| `DATA_DIR` | The disk's mount path, e.g. `/var/data` | Must point **at the mounted disk**. A relative `./data` lands on the ephemeral container filesystem. |
| `HOST` | Optional on Render | `RENDER_EXTERNAL_URL` is injected automatically and used as the fallback. Set `HOST` explicitly only once a custom domain is in front. |

> **`SHOPIFY_APP_URL` is not the variable you want.** It is set by the Shopify CLI
> for `shopify app dev` and is read only by [scripts/dev-cli.js](scripts/dev-cli.js).
> Setting it in production has no effect — the server reads `HOST`.

Everything else (`SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_SCOPES`,
`SHOPIFY_API_VERSION`, `TELENOW_API_BASE`, `DEFAULT_PHONE_COUNTRY`) is the same as
in [.env.production.example](.env.production.example). Leave `SWEEP_RUN_ON_BOOT`
unset — it places real calls at startup.

### Then

**1. Set the Partners URLs** (Partners → your app → App setup):

- App URL: `https://shopify-telenow-ai-app.onrender.com`
- Allowed redirection URL: `https://shopify-telenow-ai-app.onrender.com/auth/callback`

Exactly that one redirect entry — it must match `CALLBACK_PATH` in
[src/auth.js:24](src/auth.js:24). Remove any leftover `shopify.dev` or
`trycloudflare.com` entries from earlier `shopify app dev` runs.

**2. Run the OAuth install once.** This is the only thing that produces a valid
session token:

```bash
open "https://shopify-telenow-ai-app.onrender.com/auth?shop=telenow.myshopify.com"
```

It redirects to `/app?shop=telenow.myshopify.com#t=<token>` — the `#t=` fragment
is what the settings page reads. Opening `/app` directly, with no fragment and
outside the admin iframe, will **always** return
`401 missing or invalid session token`.

**3. Afterwards, open the app from the Shopify admin**, not by typing the Render
URL into the address bar.

Verification checks are in §7.

---

## Deploying to AWS

---

## 1. The constraint

**Exactly one process. One persistent disk. Stop-then-start deploys, never rolling.**

Three facts in the code force this:

| Fact | Where | Consequence |
|---|---|---|
| The whole DB is read into memory once at import and never re-read | [src/store.js:35](src/store.js:35) | A second process works from a stale snapshot |
| Every write serializes the **entire** DB back over the file | [src/store.js:81](src/store.js:81) | The stale process's next write erases the other's work |
| The sweep scheduler runs in every process that binds the port | [src/server.js:1347](src/server.js:1347) | N processes ⇒ N calls to the same shopper |

The file holds every merchant's **offline Shopify access token** and their
**Telenow API key**. Losing it does not look like an outage: Shopify still shows
the app installed and still delivers webhooks, but every Admin write throws
`No offline session` and the merchant sees a dead app.

A rolling deploy is a two-process deployment for the length of the drain window.
Use stop-then-start.

### What this rules out on AWS

| Service | Why not |
|---|---|
| **App Runner** | Ephemeral filesystem, no EFS support — the token store is wiped on every deploy. Also [closed to new customers since 30 Apr 2026](https://docs.aws.amazon.com/apprunner/latest/relnotes/relnotes.html). |
| **Lambda + API Gateway** | No writable persistent disk; the 6-hour sweep timer never fires between invocations. |
| **Lightsail *Container Service*** | [Cannot attach a disk](https://repost.aws/questions/QUPvXP1lg4Rde2dqn--1IoWA/can-i-attach-lightsailt-disk-to-a-lightsailt-container) — ephemeral only. (The *instance* product is fine; see below.) |
| **ECS Fargate + EFS** | Technically possible, but EFS is NFS: the `write-tmp-then-rename` the store relies on for atomicity is weaker over NFS, and you must remember to pin `desiredCount=1` forever. More money, more moving parts, worse durability guarantee. |

### What to use

**AWS Lightsail instance, 2 GB** (`$12/mo`, static IP included). It is a plain
Docker host, so the stack in this repo runs verbatim — no adaptation. 2 GB rather
than 1 GB because a Docker build on 1 GB can OOM.

**Alternative: EC2 `t4g.small`** (~$12/mo on-demand, cheaper reserved; free-tier
eligible on `t3.micro` for the first 12 months, though 1 GB is tight for builds).
Identical setup — Lightsail is simpler billing and a simpler console; EC2 gives
you security groups, IAM, and snapshot tooling you may already use.

Everything below works on either.

---

## 2. Provision

1. **Create the instance.** Lightsail → Create instance → Linux/Unix → **Ubuntu 24.04 LTS** → 2 GB plan.
   On EC2: Ubuntu 24.04, `t4g.small` (ARM) or `t3.small` (x86).
2. **Attach a static IP.** Lightsail → Networking → Create static IP → attach.
   On EC2, allocate an Elastic IP and associate it. *Do not skip this* — a
   restart changes an unattached public IP, which breaks your Shopify redirect
   URL and your TLS cert.
3. **Open the firewall** to `80/tcp` and `443/tcp` (Lightsail → Networking, or an
   EC2 security group). Port 80 is required — Caddy uses it for the Let's Encrypt
   HTTP-01 challenge. Leave `3000` **closed**; Caddy is the only thing that
   should reach the app.
4. **Point DNS.** Create an `A` record for your domain at the static IP, then
   confirm it before you start anything:

```bash
dig +short app.yourdomain.com
```

It must print your static IP. Caddy will retry-loop on certificate issuance if
DNS has not propagated.

---

## 3. Install Docker

SSH in, then:

```bash
sudo apt-get update && sudo apt-get install -y ca-certificates curl git
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
```

Log out and back in so the group change takes effect, then verify:

```bash
docker compose version
```

---

## 4. Configure

```bash
git clone https://github.com/TelenowAI/shopify-voice-ai-app.git
cd shopify-voice-ai-app
```

**Set your domain and email in the Caddy config** — [deploy/Caddyfile](deploy/Caddyfile)
has two placeholders (`app.example.com`, `you@example.com`). Caddy obtains and
renews the TLS certificate automatically once these are right.

**Create the secret env file, on the server only:**

```bash
cp .env.production.example .env.production
chmod 600 .env.production
nano .env.production
```

Fill in:

| Variable | Value |
|---|---|
| `HOST` | `https://app.yourdomain.com` — no trailing slash, must match the Caddyfile |
| `SHOPIFY_API_KEY` | The `client_id` from [shopify.app.toml](shopify.app.toml) |
| `SHOPIFY_API_SECRET` | Partners → your app → API credentials |
| `SHOPIFY_SCOPES` | **Byte-identical** to `[access_scopes].scopes` in the toml — a mismatch causes a re-consent loop on every request |
| `DEFAULT_PHONE_COUNTRY` | Your merchants' primary market (`IN`, `US`, `GB`, …). Wrong value dials wrong numbers — see §8. |
| `SWEEP_RUN_ON_BOOT` | Leave commented out. It places **real calls** at startup. |

> **Do not copy the local `.env` up.** Its credentials are the literal strings
> `dev`. Git history is clean — no `.env` was ever committed (verified) — but if
> the local file ever held a real secret matching your production `client_id`,
> rotate it in Partners now.

`HOST` is the single value the OAuth callback, the Shopify webhook target, and
the Telenow webhook target are all built from. The Telenow one is registered
**remotely and persists**, so a wrong value there is not self-healing. The app now
refuses to boot on a missing, placeholder, or non-HTTPS `HOST`
([src/shopify.js](src/shopify.js)) rather than coming up healthy and writing
`localhost` URLs into Telenow.

---

## 5. Start

```bash
docker compose build
docker compose up -d
docker compose logs -f app
```

Read the boot banner. **Every URL must show your real domain:**

```
Telenow Shopify app listening on :3000
  Public HOST:        https://app.yourdomain.com
  Install URL:        https://app.yourdomain.com/auth?shop=telenow.myshopify.com
  Settings UI:        https://app.yourdomain.com/app?shop=telenow.myshopify.com
  Shopify webhooks →  https://app.yourdomain.com/webhooks/shopify
  Telenow webhooks →  https://app.yourdomain.com/telenow/webhook
```

Then confirm TLS and health from **outside** the box:

```bash
curl -s https://app.yourdomain.com/healthz
```

Expected: `{"ok":true,"service":"telenow-shopify"}`

---

## 6. Point Shopify at it

Editing the toml changes nothing on Shopify's side until you push it.

**First, edit [shopify.app.toml](shopify.app.toml):**

| Line | Set to |
|---|---|
| `application_url` | `https://app.yourdomain.com` |
| `[auth].redirect_urls` | `[ "https://app.yourdomain.com/auth/callback" ]` — exactly this one entry |
| `[build].automatically_update_urls_on_dev` | `false` |

The callback path must be exactly `/auth/callback`; it is set at
[src/auth.js:24](src/auth.js:24). Do not keep the CLI's `/api/auth/callback`
variant — the app never registers it.

**Then push and verify against the remote record:**

```bash
shopify app deploy
shopify app info
```

Confirm in **Partners → App setup** that the App URL and the single redirect URL
are your domain, and **remove** any leftover `shopify.dev` or `trycloudflare.com`
entries from earlier `shopify app dev` runs.

> Run `shopify app dev` against a **separate app record** from now on
> (`shopify app config link --config=dev`). Sharing one `client_id` between dev
> and prod means a dev run rewrites your production URLs.

---

## 7. Install and verify

Open the install URL for your store:

```
https://app.yourdomain.com/auth?shop=telenow.myshopify.com
```

Approve the scopes; you should land on `/app`.

| Check | Command | Expected |
|---|---|---|
| Health | `curl -s https://app.yourdomain.com/healthz` | `{"ok":true,...}` |
| HTTP→HTTPS | `curl -sI http://app.yourdomain.com/healthz` | `308` to `https://` |
| Container healthy | `docker compose ps` | `app` = `Up (healthy)` |
| App not directly exposed | `curl --max-time 5 http://<static-ip>:3000/healthz` | connection refused |
| Unauth API rejected | `curl -o /dev/null -w '%{http_code}' https://app.yourdomain.com/api/settings` | `401` |
| Webhook HMAC rejects junk | `curl -o /dev/null -w '%{http_code}' -X POST https://app.yourdomain.com/webhooks/shopify -d '{}'` | `401` |
| **Volume survives recreate** | `docker compose down && docker compose up -d`, reopen `/app` | Settings and install intact |
| Graceful shutdown | `docker compose stop app` | `[server] SIGTERM received…` then `[server] closed cleanly` |

**Ignore the webhook count in the install log.** [src/auth.js:108](src/auth.js:108)
prints `9` unconditionally, outside the failure loop, even when every
registration failed. Instead confirm there are **zero** `[auth] webhook register
failed:` lines, and check the store admin shows six subscriptions
(`CHECKOUTS_CREATE`, `CHECKOUTS_UPDATE`, `ORDERS_CREATE`, `ORDERS_FULFILLED`,
`CUSTOMERS_CREATE`, `APP_UNINSTALLED`).

**The sweeps first run at T+6h**, not at boot ([src/server.js:1359](src/server.js:1359)).
If the instance restarts more often than that, they never run at all.

---

## 8. Still outstanding

These are **not** fixed by deploying, and two of them mean the app will not
function even once it is live. Full detail and proposed fixes are in the audit.

| # | Issue | Impact |
|---|---|---|
| 1 | **Protected customer data access has never been requested** (Partners → API access) | Webhook payloads arrive with phone/name/email **redacted**, `extractPhone` returns nothing, and every automation silently skips. The app installs fine and places **zero calls**. |
| 2 | **The three mandatory GDPR webhook URLs are not declared** in the toml | The handlers exist but the library [refuses to register privacy topics](src/webhooks/shopify.js:40), so Shopify has nowhere to deliver them. Blocks app review. Note [README.md:156](README.md:156) wrongly marks this done. |
| 3 | **`/webhooks/ndr/:token` will dial any phone number in the request body** | Anyone with one NDR token can drive unlimited billed calls to arbitrary numbers; the dedupe key is built from attacker-controlled fields, so it is bypassable per-request. |
| 4 | **`/web-call` streams the visitor's mic to any WebSocket URL in the fragment** | A link on your own domain that requests microphone access and sends audio elsewhere. |
| 5 | **Delayed calls do not survive a restart** ([src/automations/_base.js:112](src/automations/_base.js:112)) | A redeploy inside the 5–30 min delay window drops the timer, but the dedupe mark persists for 24h — so the call is never placed and the log reads like correct behaviour. |
| 6 | **`redactCustomer`/`deleteShop` never purge `db.fulfillments`**, which holds shopper phone and name | Erasure is incomplete as a matter of law. |
| 7 | **No per-shop call/spend cap anywhere** | Nothing bounds outbound spend if any path misbehaves. |
| 8 | **REST write-back version** is still `2025-10` while the library moved to `2026-07` | Left deliberately — bumping it needs testing against the ongoing REST Admin sunset. Verify the five REST call sites before changing it. |

Items 1 and 2 are Partners-dashboard actions you can start today; they gate
everything else.

---

## 9. Operating it

**Back up the volume.** It holds every merchant's credentials. A daily cron:

```bash
docker run --rm -v shopify-voice-ai-app_telenow-data:/d -v /home/ubuntu/backups:/b alpine tar czf /b/store-$(date +%F).tgz /d
```

Plus a weekly Lightsail/EBS snapshot. With a file-based store this backup is the
difference between a bad night and a dead business.

**Redeploy:**

```bash
git pull && docker compose build && docker compose up -d
```

Compose recreates the container — a stop-then-start, which is what this app
needs. The named volume is untouched.

**Watch for one log line above all others:**

```
[store] DB unreadable, quarantined to …
```

The app now refuses to start rather than booting empty and overwriting the file
(which previously destroyed every merchant's install from a single bad parse).
It will crash-loop until you restore from backup — that is intentional and
correct.

**Scaling.** Do not add a second instance until the JSON store is replaced with a
real database and the sweeps move out of the web process. Until then, `replicas`
is a data-loss switch. [docker-compose.yml](docker-compose.yml) deliberately
omits it.
