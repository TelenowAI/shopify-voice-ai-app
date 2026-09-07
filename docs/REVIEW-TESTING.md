# App review testing instructions (requirement 4.5.4)

This file is the source of truth for the text pasted into
**Partner Dashboard → App distribution → All apps → telenowvoiceai
(`client_id 1181346b04d8d62d945cce9aa5fa90d7`) → Distribution → Manage listing →
App review → Testing instructions.**

It lives in the repository on purpose. The instructions make specific factual claims about
the code — that no Telenow API key is requested, that the Starter plan needs no charge object, that
a development store gets `test: true` — and a reviewer will check every one of them by hand. If the
text only existed in the Partner Dashboard, a later code change could quietly falsify it and the
next thing we would hear is a second rejection. Keeping it next to the code means the claims are
reviewed in the same pull request as the behaviour they describe.

The paste block below is the spec text **verbatim**. Do not reword it to sound better. It was
written against requirements 1.2.1, 1.2.2, 1.2.3 and 4.2.1 clause by clause, and the sentence about
`shop.plan.partnerDevelopment` and `test: true` is the specific answer to the reviewer note
"full functionality could not be tested as it requires payment."

"Verbatim" is not the same as "frozen", and there are exactly two reasons to change it. The first is
a claim going out of date: the block is a set of assertions about the build, so a claim the code no
longer supports must be narrowed until it is true again, however well the original sentence read. A
reviewer who tests one claim and finds it false stops trusting the other nine. The second is a value
we cannot commit — see FILL-IN INSERTS below. Nothing else is a licence to edit it.

---

## BEFORE YOU PASTE THIS — human checklist

Nothing here can be automated. A person has to do all of it.

The paste block itself holds **no placeholder values**. Everything between the two rules is true of
the current build and is safe to paste exactly as it stands. Two things we would *like* to offer the
reviewer — a demo store and an inbound test number — deliberately do not live in the block, because
neither value is stable enough to sit in a repository and a wrong one is far worse than no offer at
all: a store domain that 404s or a number that nobody answers fails the review on the spot, for a
reason that has nothing to do with billing. They are kept as optional paragraphs under
**FILL-IN INSERTS** below, off by default.

**Gate before submitting** — this must print nothing:

```
awk '/^<!-- .*BEGIN VERBATIM/,/^<!-- .*END VERBATIM/' docs/REVIEW-TESTING.md | grep -n '<<<'
```

It greps the paste block alone rather than the whole file, because the FILL-IN INSERTS section and
this checklist both talk about `<<<` markers on purpose and a whole-file grep would cry wolf every
time. The `^<!--` anchor is not decoration either: without it the range would open on this very code
block, which names both markers, and the command would report itself as a failure.

Any hit means an insert was spliced into the block without being filled: the instructions are not
ready. Run the same check against the Partner Dashboard text after you paste it — that copy is the
one Shopify actually reads, and it is the only place a filled-in insert ever exists.

**Must be verified (every value in the block is real, but the world has to match it):**

- [ ] **Support address.** The block ends with `support@telenow.ai` and promises replies within one
      business hour **during review**. Confirm someone is on it for the review window.
- [ ] **Prices and terms match the code.** The block quotes $39, $149, 25 / 300 / 1,500 minutes,
      $0.12 / $0.10 per minute, $200.00 / $500.00 caps and a 7-day trial. These must match
      `src/plans.js`, the in-app Plans screen and the three listing plan cards **character for
      character** — a mismatch is requirement 4.2.1 and a documented second rejection. Re-check
      after any pricing change, however small.
- [ ] **Steps 1-6 really need no plan.** Walk them on a fresh development store with no
      subscription. If any of them returns a 402 paywall, the central claim of the block is false
      and the submission will be rejected on the same clause as last time.
- [ ] **Step 5's E.164 example.** `+14155550123` is a reserved-for-documentation number and should
      stay one. Do not swap in a real person's number.
- [ ] **The "WHAT CHANGED" section is still true.** It is a list of promises about the current
      build. Re-read it against the diff before submitting; in particular that
      `grep -rn "vai_live_" src/` and the "Buy a number on Telenow" links really do return nothing.
- [ ] **The demo video and listing were redone too.** The rejection cited the website *and video*.
      Fixing the code alone gets rejected again on the same clause. See the LISTINGCHANGES section
      of the blueprint.

---

## FILL-IN INSERTS — optional paragraphs the repository cannot hold

Both inserts are **off by default** and the paste block is complete and truthful without either of
them. To use one: fill every `<<<…>>>` marker with a value you have just verified by hand, paste the
finished paragraph into the Partner Dashboard field at the splice point named below, and leave this
file alone. The filled text belongs in the Dashboard, not in git — that way the repository never
carries a live phone number or a store domain that quietly stops existing.

If you use neither, paste the block as-is. Nothing in it depends on them.

### INSERT A — demo store

**Splice point:** in **TEST CREDENTIALS**, immediately after the paragraph beginning *"Nothing in
the app is billed outside Shopify."*

Do not splice this in until you have opened the store and confirmed all five things the paragraph
promises: it exists, this app is installed on it, it is on the free Starter plan, it has a
**published COD-confirmation agent**, and the staff invite to `appreview@shopify.com` has actually
been sent. The invite is the first thing the reviewer acts on, so an unsent one fails immediately.
The paragraph also promises a re-send within one business hour on request — make sure somebody is
watching that inbox for the review window.

> If you would rather not install on your own store, we have a demo store ready:
> - Store: `<<< demo store domain, e.g. telenow-review.myshopify.com >>>`
> - Staff invite sent to: `appreview@shopify.com` (tell us another address and we will re-send within one business hour)
> - The app is already installed there on the free Starter plan with a published COD-confirmation agent.

### INSERT B — inbound test number

This is the strongest single line in the 4.5.4 submission when it is real: it is the reason a
reviewer never has to hand over a personal phone number. It is also the fastest way to fail, because
a reviewer who calls a dead number concludes the app does not work. Before splicing it in, call the
number yourself from an outside line and confirm that the agent answers **and** that the call
appears in the app's Calls page.

Both edits below use the **same** number.

**B1 — splice point:** in **IF YOU DO NOT WANT TO GIVE OUT A PHONE NUMBER**, as a new sentence after
*"Step 5 is optional — skip it."*

> Or call our test agent directly from any phone: **`<<< inbound test number in E.164 form >>>`**. It answers as the COD-confirmation agent and the call appears in the app's Calls page within about 30 seconds.

**B2 — splice point:** the end of **step 5**, after *"The agent calls that number within a few
seconds."*

> Or skip this and call `<<< the same inbound test number >>>` instead.

---

## PASTE BLOCK — everything between the two rules below goes into the Partner Dashboard

<!-- ▼▼▼ BEGIN VERBATIM TESTING INSTRUCTIONS — PASTE FROM HERE ▼▼▼ -->

---

**TEST CREDENTIALS**

This app requires **no third-party account, no external signup, and no credentials of any kind.** There is nothing for you to log into outside Shopify. Everything the app needs — the AI voice agent, the phone number, and the calling capacity — is provisioned automatically by the app the moment you install it.

Nothing in the app is billed outside Shopify. There is no external checkout and no external pricing page reachable from anywhere in the app.

**HOW TO AVOID ANY CHARGE**

Two independent guarantees:
1. **The app is fully functional on the free Starter plan, which involves no charge object at all.** 25 AI voice minutes are included every 30 days. You can install, publish an agent, place real phone calls, and see outcomes written back onto orders **without ever opening a billing screen.** Steps 1-6 below need no plan.
2. **If you do test a paid plan (steps 7-10), the charge is automatically created as a Shopify TEST charge on a development store.** The app reads `shop.plan.partnerDevelopment` and passes `test: true` to `appSubscriptionCreate`, so no payment method is requested and no money is collected. You will see the normal Shopify approval screen; approving it costs nothing.

**IF YOU DO NOT WANT TO GIVE OUT A PHONE NUMBER**

Step 5 is optional — skip it. Step 4 (browser call) is the fuller proof of functionality anyway and needs no phone number at all, just a microphone: you talk to the agent and it answers you, live, inside the Shopify admin.

**STEP BY STEP**

1. Install the app on a development store. You are taken straight into the embedded app. No API key is requested.
2. You land on **Home**. The topbar shows **Starter · 25 minutes included**. Nothing is locked — every page has content.
3. Go to **Templates → COD order confirmation → Set up**. Walk the three steps and press **Publish agent**. The Access step shows the phone number that was assigned to you automatically; there is no purchase step.
4. Open the agent and press **Talk to this agent**. Allow microphone access. You will have a live two-way conversation with the AI agent in the browser. *(This is the quickest proof of full functionality and needs no phone number.)*
5. *(Optional)* Press **Send a test call** and enter a phone number in E.164 form, e.g. `+14155550123`. The agent calls that number within a few seconds.
6. Create a test order on the store with Cash on Delivery or a manual payment method. Within about a minute the agent places a confirmation call. Open **Calls** to see the transcript and outcome, and open the order to see the `telenow-cod-*` tag and the note the app wrote back.
7. *(Billing test)* Open **Plans** in the left navigation. You will see Starter $0, Growth $39/month and Scale $149/month, all in USD, matching the listing exactly.
8. Choose **Growth**. You are taken to **Shopify's own approval screen**. It shows $39.00 USD every 30 days, a 7-day free trial, and the usage terms: *"300 AI voice minutes are included every 30 days. Additional minutes are billed through Shopify at $0.12 per minute, up to the $200.00 monthly maximum you approve here."* Because this is a development store, this is a **test charge** — no payment method is requested.
9. Approve. You are returned into the app; the topbar now shows **Growth · 300 minutes** and Settings → Plan shows the status, the trial end date and the monthly maximum.
10. To verify plan changes (requirement 1.2.3): Settings → Plan → **Change plan** → Scale → approve, then **Change plan** → Growth → approve. Both directions complete inside the admin with no support contact and no reinstall. To verify decline handling (1.2.2): start a change and press **Decline** — you are returned to the Plans screen on your existing plan with no error and no data loss. To verify reinstall (1.2.2): uninstall and reinstall — the app opens on the free Starter plan and accepts a new charge.

**WHAT CHANGED SINCE THE PREVIOUS SUBMISSION (ref 131760)**

- All billing now runs through the Shopify Billing API. The app defines its plans in code and creates every charge with `appSubscriptionCreate`; overage minutes are billed with `appUsageRecordCreate` against a `cappedAmount` the merchant approves on Shopify's screen.
- The requirement to create an account on telenow.ai and paste an API key has been **removed entirely**. The app provisions the merchant's calling workspace and phone number itself. There is no Telenow API-key field anywhere in the app, and no route accepts one. (The one credential field that does still exist is unrelated to us and entirely optional: in the customer-support template, a merchant who ticks "Raise a Freshdesk ticket" and has no Freshdesk connected yet can enter their own Freshdesk domain and API key there. It is their helpdesk, not ours, it is off by default, and nothing in the voice product depends on it.)
- All seven "Buy a number on Telenow" links have been removed from the app, along with every "billed per call" and per-minute cost string.
- A free Starter plan was added so the app is fully testable with no charge of any kind.
- The listing pricing section, the listing copy and the demo video have been re-made to match. The video shows the Shopify approval screen; it no longer shows any external signup or pricing.

Support: support@telenow.ai · replies within one business hour during review.

---

<!-- ▲▲▲ END VERBATIM TESTING INSTRUCTIONS — PASTE UP TO HERE ▲▲▲ -->

---

# INTERNAL — reviewer dry-run script (R1-R14)

**This half of the document is for the Telenow team. Do not paste it into the Partner Dashboard,
and do not send it to Shopify.** It is longer, it names source files and line numbers, and it
describes what we expect to happen rather than what a reviewer is asked to do.

Its job is to be walked *before* we submit. The paste block above is a set of claims; this is the
rehearsal that proves each one. Walk R1 to R14 on a fresh development store, in order, with nobody
helping — if a step needs an explanation that is not in the paste block, the paste block is
incomplete and the reviewer will hit the same wall.

The literal path a Shopify reviewer follows, and what they see. Every step is reachable with **no Telenow account, no third-party signup, and no payment method**.

**R1 — Install.** Reviewer installs from the listing onto their own Shopify development store. `rootHandler` (`src/auth.js:148`) → `/auth` (`:32`) → Shopify consent → `/auth/callback` (`:58`) → `saveShop` (`:66`) → `registerShopifyWebhooks` (`:73`) → `ensureWorkspace(shop)` leases a calling workspace in the background → `getEmbeddedAppUrl` (`:101`). **They see:** the standard scope consent screen, then the app inside the admin. No key field. No external redirect. No mention of telenow.ai.

**R2 — First open, on the free Starter plan.** `GET /api/settings` returns `entitlement.plan = 'starter'`, `active = true`. **They see:** the Home page, a green "Starter · 25 minutes included" pill in the topbar, and a three-step welcome modal that says *Choose how you want to call → Publish an agent from a template → Watch calls and outcomes land here*. The step that used to read "Paste your `vai_live_…` API key from Telenow → Developers → API Keys" (`app.html:580`) is gone. **Nothing is locked.** This is the single most important difference from the rejected build: the reviewer can test the whole product before any money question exists.

**R3 — Publish an agent.** Templates → **COD order confirmation** → the existing 3-step wizard (`app.html:2444-3724`). Step 2 "Access" shows *"Calls will come from +91… — included with your plan."* The seven "Buy a number on Telenow ↗" buttons (1885, 2672, 2885, 3024, 3158, 3245, 3297) are gone. Publish → `POST /api/templates/:key/publish` (`src/server.js:867`) → 200: agent created, number bound (`:957`), automation enabled (`:981-1020`).

**R4 — Talk to the agent in the browser.** "Talk to this agent" → `POST /api/web-call` (`src/server.js:313`). **They see:** a live two-way voice conversation in the admin, mic in, agent voice out. Steer them here **first**: it needs no phone number, no country dialling, no carrier, and it proves STT + LLM + TTS end-to-end. Costs ~1 minute of the 25 free.

**R5 — Receive a real phone call, without giving out a number.** "Send a test call" → `POST /api/test-call` (`src/server.js:1066`). They may enter their own number — or, **if INSERT B was filled in and spliced into the submitted instructions**, call our published inbound line and let the agent answer them instead, so no reviewer ever has to hand over a personal phone number. Without INSERT B this step is simply optional and R4 carries the proof. Costs ~2 minutes of the 25.

**R6 — End-to-end automation.** Reviewer creates a test order on the dev store with COD/manual payment. `ORDERS_CREATE` (`src/webhooks/shopify.js:93-94`) → `handleCodConfirmation` → `placeCall` (`_base.js:44`) → a real call. **They see:** the call in the Calls page with transcript and disposition, and the order tagged `telenow-cod-*` with a note. This is the "does it do what the listing says" check, and it happens on the **free** plan.

**R7 — Hit the free ceiling deliberately (optional, scripted).** After 25 minutes, `POST /api/test-call` answers `402 minutes_exhausted` and the UI shows *"You have used all 25 free minutes for this period. Choose a plan to keep calling."* with a **Choose a plan** button. **They see:** a paywall that offers Shopify plans and nothing else.

**R8 — Open the plan screen.** Plans in the left rail, or the button from R7. **They see:** three cards — Starter $0 (current), Growth $39/mo, Scale $149/mo — with included minutes and the overage rate stated in USD. There is no telenow.ai link anywhere on this screen and no price in any other currency.

**R9 — Subscribe to Growth.** Click "Choose Growth" → `POST /api/billing/subscribe` → `shopify.billing.request({plan:'Telenow Growth', isTest:<partnerDevelopment>, returnUrl})` → the app opens Shopify's own `confirmationUrl` with `open(url,'_top')`. **They see:** Shopify's native approval screen showing *Telenow Growth — $39.00 USD every 30 days, 7-day free trial*, plus the usage line *"300 AI voice minutes are included every 30 days. Additional minutes are billed through Shopify at $0.12 per minute, up to the $200.00 monthly maximum you approve here."* **Because the store is a development store, `isDevelopmentStore()` returns true and the charge is created with `test: true` — no payment method is requested and no money moves.** This is the sentence that answers "full functionality could not be tested as it requires payment."

**R10 — Approve and return.** Shopify redirects to `GET /billing/callback?shop=…&state=…&host=…` → state verified → `refreshEntitlement` → `ensureWorkspace` → redirect to `https://admin.shopify.com/store/<their-store>/apps/<client_id>`. **They see:** the app back inside the admin, topbar pill now "Growth · 300 minutes", the Plan card in Settings showing status Active, trial end date, and 300 minutes included. Total elapsed: a few seconds.

**R11 — 1.2.2, decline.** Reviewer goes back to Plans, chooses Scale, and clicks **Decline** on Shopify's screen. `/billing/callback` finds no new subscription. **They see:** the Plans screen with a neutral *"No change made — you're still on Growth."* Not an error page, not a dead end, no data lost.

**R12 — 1.2.2, reinstall.** Reviewer uninstalls (`APP_UNINSTALLED` at `src/webhooks/shopify.js:111` releases the workspace, then purges), then reinstalls. **They see:** the app opens on the free Starter plan and the Plans screen accepts a fresh charge. Shopify cancels the old subscription itself on uninstall; the app makes no billing call there.

**R13 — 1.2.3, upgrade and downgrade.** Settings → Plan card → **Change plan** → Growth → Scale (approve), then Scale → Growth (approve). Each is the same `/api/billing/subscribe` route with `replacementBehavior: STANDARD`, so Shopify cancels the previous subscription and prorates on approval. **They see:** both directions complete inside the admin. No support contact, no reinstall, no email.

**R14 — Verify nothing off-platform survives.** Reviewer clicks around Settings, the Agents detail page, and all six template wizards. **They see:** no `vai_live_` field, no "Buy a number" link, no "billed per call" copy, no telenow.ai link that leads to a checkout, and no price in INR. `grep -rn "telenow\.ai/numbers\|vai_live_\|billed per call\|#pricing" src/public/app.html` returns zero.

---

## One thing R12 does not say out loud

R12 describes uninstall as "releases the workspace, then purges". Be clear internally about what
"releases" means, because it is not what the word usually implies: `releaseWorkspace()` moves the
leased calling workspace to a **quarantined** state, it does **not** return it to the free pool.
That workspace still holds the previous merchant's call recordings, transcripts and customer phone
numbers, and handing it to the next merchant would be a protected-customer-data breach. Only an
operator running `node scripts/keypool.js wipe <ref> --wiped` may put an entry back into
circulation, and only after the upstream workspace has actually been purged.

The practical consequence for a review dry run: **every uninstall/reinstall cycle consumes a pool
entry.** R12 is cheap to run once and expensive to run twenty times. Check `poolStatus()` before
submitting and make sure there is free headroom for the reviewer, who may well repeat R12 more
than once.
