// ─────────────────────────────────────────────────────────────────────────────
// scripts/seed-demo.js — seed a fake installed shop for LOCAL UI PREVIEW ONLY.
//
// This lets you open the settings page at:
//   http://localhost:3000/app?shop=demo.myshopify.com
// without going through a real Shopify OAuth install. The access token is a dummy
// and will fail any real Admin API call — it's only here so the settings API
// recognizes the shop as "installed".
//
// DO NOT use in production. Run via `npm run dev:preview`.
// ─────────────────────────────────────────────────────────────────────────────

import { saveShop, getShop } from '../src/store.js';

const SHOP = 'demo.myshopify.com';

if (!getShop(SHOP)) {
  saveShop(SHOP, { accessToken: 'shpat_dummy_preview_token', scope: 'read_orders,write_orders' });
  console.log(`[seed] created demo shop ${SHOP} (dummy token — preview only)`);
} else {
  console.log(`[seed] demo shop ${SHOP} already present`);
}
