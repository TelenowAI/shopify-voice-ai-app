// ─────────────────────────────────────────────────────────────────────────────
// scripts/dev-cli.js — entrypoint used by `shopify app dev` (via shopify.web.toml).
//
// The Shopify CLI injects HOST (its tunnel URL), PORT, SHOPIFY_API_KEY and
// SHOPIFY_API_SECRET into this process, and keeps the app's URLs in the Dev
// Dashboard in sync with that tunnel. Older CLI versions used SHOPIFY_APP_URL
// instead, so accept either.
//
// Order matters: HOST is set *before* importing the server. server.js loads
// dotenv, which never overwrites an already-set variable — so whatever the CLI
// provides wins over the HOST line in .env (that one is for the manual ngrok path).
// ─────────────────────────────────────────────────────────────────────────────

const tunnelUrl = process.env.SHOPIFY_APP_URL || process.env.HOST;

if (tunnelUrl) {
  process.env.HOST = tunnelUrl.replace(/\/$/, '');
} else {
  console.warn('[dev-cli] no HOST or SHOPIFY_APP_URL from the CLI — OAuth callback URLs will be wrong.');
}

// The CLI should supply real credentials. If it didn't, .env's placeholder would
// silently take over and OAuth would fail with a confusing Shopify error — so say so.
if (!process.env.SHOPIFY_API_KEY || process.env.SHOPIFY_API_KEY === 'dev') {
  console.warn('[dev-cli] WARNING: no real SHOPIFY_API_KEY from the CLI — OAuth will fail.');
}

console.log(`[dev-cli] HOST=${process.env.HOST} PORT=${process.env.PORT || 3000}`);

await import('../src/server.js');
