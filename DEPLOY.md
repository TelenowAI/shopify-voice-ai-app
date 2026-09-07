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
| `HOST` | **`https://shop.telenow.ai`** — required | See the custom-domain note below. Without it the app advertises the `*.onrender.com` address everywhere. |

> **`HOST` is mandatory once a custom domain is in front.** `RENDER_EXTERNAL_URL`
> — the fallback the app uses when `HOST` is unset — *always* resolves to the
> `*.onrender.com` address and **never** to a custom domain. So on a bare Render
> deploy you can omit `HOST`, but with `shop.telenow.ai` in front you must set
> it explicitly, or every OAuth callback, webhook target and NDR URL the app hands
> out will still say `shopify-telenow-ai-app.onrender.com`.

> **`SHOPIFY_APP_URL` is not the variable you want.** It is set by the Shopify CLI
> for `shopify app dev` and is read only by [scripts/dev-cli.js](scripts/dev-cli.js).
> Setting it in production has no effect — the server reads `HOST`.

### Custom domain

1. Render → your service → **Settings → Custom Domains → Add** `shop.telenow.ai`.
2. Add the DNS record Render shows you (a `CNAME` for `shopify` pointing at
   `shopify-telenow-ai-app.onrender.com`) at your `telenow.ai` DNS provider.
3. Wait for Render to verify it and issue the TLS certificate.
4. **Then** set `HOST=https://shop.telenow.ai` and redeploy.

Verify before going further — this must show the custom domain, not `onrender.com`:

```bash
curl -s https://shop.telenow.ai/ | grep -o 'https://[^<]*auth?shop=[^<]*'
```

Everything else (`SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_SCOPES`,
`SHOPIFY_API_VERSION`, `TELENOW_API_BASE`, `TELENOW_KEY_POOL`,
`DEFAULT_PHONE_COUNTRY`) is the same as in
[.env.production.example](.env.production.example). Leave `SWEEP_RUN_ON_BOOT`
unset — it places real calls at startup.

`SHOPIFY_API_KEY` must be the **listed** app's `client_id`,
`1181346b04d8d62d945cce9aa5fa90d7` — see the warning in [§4](#4-configure) for why
the other app record breaks billing silently. `TELENOW_KEY_POOL` must be seeded
before the first install or the app cannot place a call; see
[§10](#10-telenow-key-pool).

### Then

**1. Set the Partners URLs** (Partners → your app → App setup):

- App URL: `https://shop.telenow.ai`
- Allowed redirection URL: `https://shop.telenow.ai/auth/callback`

Exactly that one redirect entry — it must match `CALLBACK_PATH` in
[src/auth.js:24](src/auth.js:24). Remove any leftover `shopify.dev` or
`trycloudflare.com` entries from earlier `shopify app dev` runs.

**2. Run the OAuth install once.** This is the only thing that produces a valid
session token:

```bash
open "https://shop.telenow.ai/auth?shop=telenow.myshopify.com"
```

It redirects to `/app?shop=telenow.myshopify.com#t=<token>` — the `#t=` fragment
is what the settings page reads. Opening `/app` directly, with no fragment and
outside the admin iframe, will **always** return
`401 missing or invalid session token`.

**3. Afterwards, open the app from the Shopify admin**, not by typing the app URL
into the address bar.

Verification checks are in §7.

### Order matters

Do the custom domain **before** the first install. The Shopify webhook
subscriptions are stamped with `HOST` at install time
([src/webhooks/shopify.js:202](src/webhooks/shopify.js:202)) and only re-registered
during `/auth/callback`, and the Telenow hook is registered remotely
([src/webhooks/telenow.js:45](src/webhooks/telenow.js:45)). Install on the
`onrender.com` origin first and both point at the old address until you reinstall.

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
| `SHOPIFY_API_KEY` | The `client_id` from [shopify.app.telenowvoiceai.toml](shopify.app.telenowvoiceai.toml) — `1181346b04d8d62d945cce9aa5fa90d7`. **Must be the listed app.** `currentAppInstallation.activeSubscriptions` is scoped to the app that issued the token, so a mismatched key returns an empty array for every paying merchant and the app locks itself out. |
| `SHOPIFY_API_SECRET` | Partners → **the same app** → API credentials. A secret from the other app record verifies no webhook HMAC and signs no session token. |
| `SHOPIFY_SCOPES` | **Byte-identical** to `[access_scopes].scopes` in that toml (`read_checkouts,read_customers,read_fulfillments,read_orders,write_orders`) — a mismatch causes a re-consent loop on every request |
| `TELENOW_KEY_POOL` | The JSON array of pre-minted calling workspaces, each `{ref, apiKey, numberE164, numberId, provider, country}`. **The app cannot place a call without it** — every shop leases one entry, and the entry's `country` decides whether that shop's caller ID can reach its shoppers. See [§10](#10-telenow-key-pool) for how to mint and seed. |
| `DEFAULT_PHONE_COUNTRY` | **Optional, and usually leave it unset.** Last-resort fallback for numbers that arrive with no country code; the app resolves the country per shop from Shopify first (`explicit → shop's country → this → US`). Setting it pins every merchant on the instance to one market. |
| `SWEEP_RUN_ON_BOOT` | Leave commented out. It places **real calls** at startup. |

> **There are two app records with the same name, and only one of them is
> listed.** The real app is `client_id 1181346b04d8d62d945cce9aa5fa90d7`
> ([shopify.app.telenowvoiceai.toml](shopify.app.telenowvoiceai.toml)); the
> duplicate is `5aef351a…`. Before billing this was merely confusing — the app
> would install and run under either. It is now a silent, total failure: the
> Billing API scopes `currentAppInstallation.activeSubscriptions` to the app that
> **issued the access token**, so if the server holds the duplicate's credentials
> every entitlement read comes back empty. Every paying merchant reads as
> unsubscribed, the gate refuses to place calls, and nothing in the logs says
> "wrong app" — it looks exactly like a store that never paid. Take
> `SHOPIFY_API_KEY` and `SHOPIFY_API_SECRET` from the `1181346b…` record and from
> nowhere else.

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

Expected: `{"ok":true,"service":"telenow-shopify","keypool":{…}}`. Check the
`keypool` block too — `total` must match the number of workspaces you seeded. A
`total` of `0` means the pool never parsed, and no shop will be able to place a
call. See [§10](#10-telenow-key-pool).

---

## 6. Point Shopify at it

Editing the toml changes nothing on Shopify's side until you push it.

**First, select the right config.** The repo carries two app configs, and
`shopify app deploy` with no argument uses `shopify.app.toml` — the *unlisted
duplicate*. Deploying there is the failure mode where you do all the work and the
reviewer sees none of it, because the listed app is never touched:

```bash
shopify app config use telenowvoiceai
shopify app info          # must print client_id 1181346b04d8d62d945cce9aa5fa90d7
```

Do not proceed until `shopify app info` prints that `client_id`. If it prints
`5aef351a…` you are pointed at the duplicate.

**Then edit [shopify.app.telenowvoiceai.toml](shopify.app.telenowvoiceai.toml):**

| Line | Set to |
|---|---|
| `client_id` | `1181346b04d8d62d945cce9aa5fa90d7` — leave it alone; it identifies the listed app |
| `application_url` | `https://app.yourdomain.com` |
| `[auth].redirect_urls` | `[ "https://app.yourdomain.com/auth/callback" ]` — exactly this one entry |
| `[build].automatically_update_urls_on_dev` | `false` |

The callback path must be exactly `/auth/callback`; it is set at
[src/auth.js:24](src/auth.js:24). Do not keep the CLI's `/api/auth/callback`
variant — the app never registers it.

**Then push and verify against the remote record:**

```bash
shopify app deploy -c telenowvoiceai
shopify app info
```

Confirm in **Partners → App setup** that the App URL and the single redirect URL
are your domain, and **remove** any leftover `shopify.dev` or `trycloudflare.com`
entries from earlier `shopify app dev` runs.

Then confirm the credential and the deploy target are the *same* app: the
`SHOPIFY_API_KEY` in `.env.production` must be byte-identical to the `client_id`
`shopify app info` just printed.

```bash
grep '^SHOPIFY_API_KEY=' .env.production   # must end in 1181346b04d8d62d945cce9aa5fa90d7
```

A mismatch here is the billing failure described in §4: subscriptions are created
against one app and read back from another, so every merchant reads as
unsubscribed.

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
| Key pool seeded | `curl -s https://app.yourdomain.com/healthz` | `keypool.total` = workspaces seeded, `keypool.free` ≥ 5 |
| Pool stocks the right countries | `curl -s https://app.yourdomain.com/healthz` | `keypool.byCountry` lists every market you sell into, **`US` + `CA` ≥ 2 before app review** — see [§10](#10-telenow-key-pool) |
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
| 2 | **The three mandatory GDPR webhook URLs are not declared** in the toml | The handlers exist but the library [refuses to register privacy topics](src/webhooks/shopify.js:40), so Shopify has nowhere to deliver them. Blocks app review. Note [README.md:157](README.md:157) wrongly marks this done. |
| 3 | **`/webhooks/ndr/:token` will dial any phone number in the request body** | Anyone with one NDR token can drive calls to arbitrary numbers; the dedupe key is built from attacker-controlled fields, so it is bypassable per-request. The *spend* is now bounded three ways (see item 7), but the abuse is not: rotating the token is still owed. |
| 4 | **`/web-call` streams the visitor's mic to any WebSocket URL in the fragment** | A link on your own domain that requests microphone access and sends audio elsewhere. |
| 5 | **Delayed calls do not survive a restart** ([src/automations/_base.js:112](src/automations/_base.js:112)) | A redeploy inside the 5–30 min delay window drops the timer, but the dedupe mark persists for 24h — so the call is never placed and the log reads like correct behaviour. |
| 6 | **`redactCustomer`/`deleteShop` never purge `db.fulfillments`**, which holds shopper phone and name | Erasure is incomplete as a matter of law. |
| 7 | ~~No per-shop call/spend cap anywhere~~ **Fixed — three ceilings now sit above every call** | The plan gate refuses to spend past the shop's included minutes; Shopify's merchant-approved `cappedAmount` bounds what can ever be invoiced; and the per-workspace monthly ceiling set inside Telenow (§10) bounds the real cost. All three must be in place — the first two are code, the third is a manual step when you mint the workspace. |
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

---

## 10. Telenow key pool

Merchants pay Shopify and nothing else. They never sign up for Telenow, never see
an API key, and never buy a phone number — that is the whole point of the billing
rework, and Shopify requirement 1.2.1 is not satisfied if any of it leaks back
into the UI. What makes it work is that **the operator owns the Telenow side**: a
set of calling workspaces minted ahead of time, one of which the server leases to
each shop at install.

This is an operational responsibility, not a config value you set once. An empty
pool is an outage: [src/provisioning.js](src/provisioning.js) returns `null`,
every call route answers `503 {"error":"provisioning"}`, and the merchant sees an
app that will not dial. Read this section before the first install, not after.

### Mint the workspaces by hand

There is no partner provisioning API in v1 — `src/telenow.js` speaks only the
per-merchant API, authenticated by a key handed to its constructor. So the
workspaces are created the ordinary way, through the telenow.ai web signup. For
each one:

1. Sign up a workspace named `shopify-pool-01`, `-02`, … Keep the numbering flat;
   the name is the `ref` you will use everywhere else, including in logs.
2. Attach **one caller-ID number** to it, **in a country you actually sell into**.
   One number per workspace, never shared — a shared number would let one
   merchant's callbacks land in another's workspace. Which carrier you buy it
   from is your choice and the merchant never sees it: **Twilio and Plivo are
   both first class**, and Telenow also drives Exotel, Vonage and BYO SIP trunks.
   In practice Twilio for US/CA/GB/AU and Plivo for IN is the cheapest split, and
   Exotel is India-only by construction — never stock it for a Western market.
   Note the carrier and the number's ISO-3166-1 alpha-2 country as you go; both
   go into the seed below.
3. Set a **hard monthly spend ceiling inside Telenow** on that workspace.

Step 3 is not optional and it is not belt-and-braces. It is the last of the three
ceilings from §8 item 7, and it is the only one that bounds *real cost* rather
than *invoiced amount*: the plan gate and Shopify's `cappedAmount` both stop the
app from charging a merchant more, but neither stops the app from burning your own
Telenow balance if a code path misbehaves — and the unauthenticated NDR endpoint
(§8 item 3) is exactly such a path. Size the ceiling a little above the highest
plan's cap so a legitimately heavy month is not cut off mid-call.

Ship **30 workspaces**: 25 for early installs and **5 held back, unleased, until
the app-review verdict lands**. If the pool runs dry during review the reviewer
does not see a queue — they see an app that cannot place a call, and the
resubmission is spent.

### Geography: a number that cannot reach the shoppers is a broken install

A pool entry is not interchangeable with any other, because the caller-ID number
on it lives in one country. A foreign DID dialling a local mobile is routinely
blocked, silently dropped, or spam-labelled by the destination carrier — the
merchant does not get an error, they get a feature that quietly does not work.

So the lease is country-aware, in one direction only:

1. At install the app resolves **the shop's own country** from Shopify once
   (`shop.billingAddress.countryCodeV2`, cached on `settings.shopCountry`) and
   asks the pool for a free entry whose `country` matches. The log line is
   `[store] keypool: rule=country-match`.
2. If nothing matches it **leases a free entry anyway** and warns
   `rule=any-free — no free US number available … Mint US numbers into the pool`.
   That warning is the only signal you get, and it fires while there is still
   inventory rather than after the pool empties.
3. A shop reclaiming **its own** workspace after a reinstall still wins over both
   (`rule=reclaim`) — the entry holds that merchant's data, and moving them to a
   better-matched number would strand it.

The country **never blocks a lease**. A merchant on a foreign number can still
publish agents, take browser calls and be billed; a merchant with no workspace at
all sees `503 provisioning` on every screen. There is also, deliberately, no
merchant-facing path to fixing it: nothing in the UI offers to buy, port or
choose a number, because that off-platform purchase is exactly what got the app
paused under requirement 1.2.1. Stocking the right countries is **your** job, and
it is done here, in the pool.

### Seed the pool

The server reads the pool from `TELENOW_KEY_POOL` (a JSON array), falling back to
`${DATA_DIR}/keypool.json` holding the same array. Env is preferred in Docker;
the file is easier when the array is long enough to be unpleasant in a shell.

```
TELENOW_KEY_POOL=[{"ref":"ws-01","apiKey":"vai_live_…","numberE164":"+14155550123","numberId":"…","provider":"twilio","country":"US"},{"ref":"ws-02","apiKey":"vai_live_…","numberE164":"+919876543210","numberId":"…","provider":"plivo","country":"IN"}]
```

| Field | Required | Meaning |
|---|---|---|
| `ref` | yes | Unique, stable handle. The only part of an entry ever written to a log. |
| `apiKey` | yes | The workspace's `vai_live_…` key. Never logged, never sent to a browser. |
| `numberE164` | no | The caller-ID number attached to that workspace. |
| `numberId` | no | Its id on the Telenow side. |
| `provider` | no | Lowercase platform carrier id: `twilio`, `plivo`, `exotel`, `vonage`, `sip`. |
| `country` | no | ISO-3166-1 alpha-2 of **the number**, not of the merchant: `US`, `CA`, `IN`, … |

`provider` and `country` are additive — entries seeded before they existed still
register and still lease. But an unlabelled entry is treated as **unknown**, never
as Indian, so it can only ever be handed out as the fallback and it shows up under
`unknown` in the census below. Label everything you seed; a `country` is a one-word
edit and it is the difference between a call that connects and one that does not.
`numberProvider` / `numberCountry` are accepted as aliases if your seed generator
already uses those names.

`ref` must be unique and stable — it is the handle for every later operation, and
it is the only part of an entry that is ever written to a log. Treat the whole
value as a secret on par with `SHOPIFY_API_SECRET`: `chmod 600` the env file, and
never paste a populated pool into a ticket or a chat.

Malformed JSON is not fatal but it is silent in the way that matters: the app
logs the parse failure and behaves as though the pool were empty, so the symptom
you actually see is `503 provisioning` on every shop. If installs are failing,
check the boot log for the pool line before anything else.

### Lease, validate, monitor

At install, `ensureWorkspace(shop)` pops a free entry, records the lease in
`db.keypool`, stores the key server-side in the shop's settings, and subscribes
the Telenow result webhook for it. It is idempotent per shop — parallel boot
requests collapse onto one lease.

A leased key is re-validated with `GET /api/v1/me` at most once every 24 hours. A
`401` retires that entry and leases the next, which self-heals a stale
`store.json` whose uninstall webhook was lost. Anything else — a timeout, a 5xx,
DNS — deliberately **keeps** the key: treating a Telenow outage as thirty dead
keys would burn the entire pool in minutes and strand every shop.

`/healthz` reports the pool:

```bash
curl -s https://app.yourdomain.com/healthz
```

```json
{"ok":true,"service":"telenow-shopify",
 "keypool":{"total":30,"leased":4,"free":21,"quarantined":4,"dead":1,
            "byCountry":{"US":9,"CA":2,"IN":8,"unknown":2},
            "byProvider":{"twilio":11,"plivo":8,"unknown":2}}}
```

**Alarm when `free` drops below 5.** Refilling is a five-minute manual job — mint
more workspaces, append them to the array, redeploy — but only if someone is
watching. `dead` climbing on its own means keys are being revoked upstream;
`quarantined` climbing is normal and is explained next.

**`byCountry` and `byProvider` count FREE entries only** — the question they
answer is not "what did we buy" but "what can the next install actually get". A
pool of forty numbers is out of stock for a US merchant if all forty are leased,
and a census that counted everything would still read `US: 12` at the moment a US
merchant is handed an Indian DID. Alarm per country, not just on the total: **a
market you sell into that reaches `0` free is a market where every new install
gets a caller ID that may not connect.** A large `unknown` bucket means the
labels are missing from the seed, not that the numbers are.

`node scripts/keypool.js status` prints the same census from the box, plus a
per-country warning line; `node scripts/keypool.js list` shows the provider and
country of every workspace next to its state. Neither ever prints an API key.

### Before you submit for app review

Run through this the day you submit, not the week before — `free` only ever falls.

- [ ] `keypool.free` ≥ 10, and ≥ 5 of those held back for review traffic.
- [ ] **`keypool.byCountry` shows at least 2 free `US` or `CA` numbers.** This is
      the one that fails the review. Shopify's reviewer works from North America
      and "Send a test call" is the most prominent button in the app; an Indian
      DID ringing their mobile is frequently blocked or spam-filtered, so the
      reviewer sees a headline feature that does not work and the app is paused
      again under requirement **2.1.1 (functionality)** — where none of the
      billing rework helps. Two rather than one, because install → uninstall →
      reinstall is exactly how requirement 1.2.2 gets tested and each cycle can
      quarantine an entry.
- [ ] Every free entry has a `country`, so no lease falls through to `unknown`.
- [ ] Place one real test call from a **US** development store to a real
      North-American mobile and confirm it connects and is audible. The pool
      census proves inventory; only a real call proves routing.
- [ ] No merchant-visible copy anywhere offers to buy, port or choose a number,
      and no screen links to telenow.ai or to a carrier. That is the requirement
      1.2.1 violation the app was paused for; an empty number list must say the
      number is still being set up and point at the browser call.

### Uninstall quarantines the workspace. It is never re-leased.

On `APP_UNINSTALLED` the server calls `releaseWorkspace(shop)` **before**
`deleteShop(shop)` — the ordering matters, because `deleteShop` wipes the settings
row that holds the workspace ref. The release moves the pool entry to state
`quarantined`. It does **not** return it to `free`, and no code path anywhere
moves a quarantined entry back.

That is deliberate, and it is the one rule in this section not to optimise away.
A used workspace still holds the previous merchant's call recordings, call
transcripts, and their customers' phone numbers. Handing it to the next merchant
would hand them all of that — a protected-customer-data breach under Shopify's
own rules and a GDPR breach besides, arriving silently and looking like normal
operation. A quarantined workspace is not a wasted workspace; it is one that has
not been cleaned yet.

To put one back into service, purge it inside Telenow first — delete every call
record, transcript, recording, agent and contact in that workspace, and rotate its
API key — then assert that you did:

```bash
node scripts/keypool.js wipe ws-07 --wiped
```

The `--wiped` flag is the assertion, and the command refuses without it. Nothing
in the app can verify the purge actually happened, so the flag exists to make the
claim explicit and attributable rather than accidental. If you are not certain the
workspace was cleaned, do not pass it — mint a fresh workspace instead. They are
cheap; a data-handling incident during app review is not.

**Rotating a live key** — suspected leak, or Telenow revoked it — needs no special
tooling. Mint a replacement workspace, append it to the pool, and revoke the old
key inside Telenow. The next 24-hour revalidation gets a `401`, retires the dead
entry and leases the replacement on the shop's next request; the shop keeps its
agents and its call history, because those live in this app's store, not in the
workspace. Do the revoke *after* the replacement is in the pool, or the shop
answers `503 provisioning` in the gap.
