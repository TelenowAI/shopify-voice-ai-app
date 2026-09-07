// ─────────────────────────────────────────────────────────────────────────────
// scripts/keypool.js — operator CLI for the Telenow calling-workspace pool.
//
//   node scripts/keypool.js status              counts: total/free/leased/quarantined/dead,
//                                               plus the FREE census by country and carrier
//   node scripts/keypool.js list                one row per workspace: carrier, country, holder
//   node scripts/keypool.js wipe <ref> --wiped  return a QUARANTINED workspace to the free pool
//
// WHY COUNTRY IS ON EVERY VIEW. A pool entry is not interchangeable with any
// other: the caller-ID number on it lives in one country, and a foreign DID
// dialling a local mobile is routinely blocked or spam-filtered by the
// destination carrier. `free: 21` therefore says nothing about whether the next
// US install gets a number that can ring a US shopper — twenty-one free Indian
// numbers report exactly the same total as twenty-one free American ones. The
// per-country FREE census is the number an operator actually has to watch, and
// it is the one that decides whether Shopify's North-American reviewer sees a
// test call connect.
//
// WHY THIS IS A CLI AND NOT AN HTTP ROUTE. Everything it touches is a
// credential-bearing pool that no merchant may reach: a route that re-seeds or
// re-frees workspaces is a route that can be found. The blueprint is explicit —
// "an operator-only re-seed path may exist as a CLI script under scripts/, never
// as an HTTP route."
//
// WHY IT READS store.json DIRECTLY INSTEAD OF IMPORTING src/store.js. Two
// reasons, and the first one is the serious one:
//
//   1. store.js's load() runs at module scope and, on an unparseable database,
//      RENAMES store.json to store.json.corrupt.<ts> and calls process.exit(1).
//      That is exactly the right behaviour for a server that must not boot on a
//      half-written file — and exactly the wrong behaviour for the diagnostic
//      tool an operator reaches for WHEN the file looks wrong. Importing it here
//      would mean `keypool.js status` could move the operator's database out
//      from under them before printing anything.
//   2. There is no exported "wipe" — deliberately, because nothing in the
//      running app may ever move an entry out of quarantine. So the write has to
//      happen here regardless, and having one writer that reads and writes the
//      same way is simpler to reason about than a reader that borrows the
//      module's in-memory snapshot and a writer that does not.
//
// THE COST OF THAT CHOICE, STATED PLAINLY: a running server holds the whole
// database in memory and rewrites it wholesale on its next persist(), so a wipe
// applied while the app is up can be silently undone. `wipe` therefore prints a
// restart instruction rather than pretending the write is safe.
//
// SECURITY: this file never prints a `vai_live_…` key, not even masked, and
// never writes one to stdout in JSON. The workspace `ref` is the handle an
// operator needs; it is not a credential.
// ─────────────────────────────────────────────────────────────────────────────

import 'dotenv/config';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolved exactly the way src/store.js and src/provisioning.js resolve it, so
// `DATA_DIR=… node scripts/keypool.js` looks at the same files the app does.
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(__dirname, '..', 'data');

const DB_FILE = path.join(DATA_DIR, 'store.json');
const POOL_FILE = path.join(DATA_DIR, 'keypool.json');

/** Below this many free workspaces, a fresh install is days away from a 503. */
const LOW_WATER_MARK = 5;

/**
 * Countries whose free stock is called out even when the seed holds none at all.
 *
 * Everything else is warned about only when the pool *used* to stock it and has
 * run out, which is derived from the seed rather than guessed. North America is
 * the exception because of who reviews the app: Shopify's reviewer works from
 * the US or Canada, "Send a test call" is the most prominent button in the UI,
 * and an Indian DID ringing a North-American mobile is frequently blocked. A
 * pool with zero free US/CA numbers passes every other check in this tool and
 * still fails app review under requirement 2.1.1 (functionality), so the absence
 * has to be visible before the submission, not inferred from it afterwards.
 */
const REVIEW_COUNTRIES = ['US', 'CA'];

/** Free US+CA numbers wanted before submitting: one for the review, one spare. */
const REVIEW_COUNTRY_MIN = 2;

const STATES = ['free', 'leased', 'quarantined', 'dead'];

/** Lowercase platform carrier id ('twilio', 'plivo', …), or '' when unlabelled. */
function normaliseProvider(value) {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : '';
}

/** ISO-3166-1 alpha-2, uppercased, or '' when unlabelled. */
function normaliseCountry(value) {
  return typeof value === 'string' && value.trim() ? value.trim().toUpperCase() : '';
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The operator-seeded pool definition: TELENOW_KEY_POOL (a JSON array) or
 * ${DATA_DIR}/keypool.json.
 *
 * It is read for the REFS AND THEIR LABELS — never for the credentials. A ref
 * that the seed defines but the database has never heard of has never been
 * leased, so it is free — and showing those is the difference between "the pool
 * is empty" and "the pool was never seeded", which are the two failure modes an
 * operator is actually trying to tell apart.
 *
 * `provider` and `country` live ONLY here. src/store.js keeps them in its
 * in-memory `poolSource` map and deliberately never copies them into store.json
 * alongside the lease state, so that an operator can relabel or rotate an entry
 * by editing the seed alone. This tool has to make the same join, which is why a
 * ref present in the database but missing from the seed shows as unlabelled
 * rather than as an error: that is a real state (the operator pulled the entry),
 * and it is the same state store.js treats as "unknown, never matches a country".
 *
 * Both spellings of each label are accepted for the same reason store.js accepts
 * them — a hand-written seed carrying `numberE164`/`numberId` naturally reads
 * `numberProvider`/`numberCountry`, and silently dropping those would make an
 * operator's carefully labelled pool report as unlabelled.
 *
 * @returns {{ source: 'env'|'file'|'none', refs: string[],
 *             labels: Map<string, {provider: string, country: string}>,
 *             error: string|null }}
 */
function readPoolSource() {
  const raw = process.env.TELENOW_KEY_POOL;
  let text = null;
  let source = 'none';

  const empty = (src, error) => ({ source: src, refs: [], labels: new Map(), error });

  if (typeof raw === 'string' && raw.trim()) {
    text = raw;
    source = 'env';
  } else if (fs.existsSync(POOL_FILE)) {
    try {
      text = fs.readFileSync(POOL_FILE, 'utf8');
      source = 'file';
    } catch (err) {
      return empty('file', `${POOL_FILE} unreadable: ${err.message}`);
    }
  }

  if (text === null) return empty(source, null);

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    // Deliberately does not echo `text` — it holds live API keys.
    return empty(source, `pool source is not valid JSON (${err.message})`);
  }
  if (!Array.isArray(parsed)) {
    return empty(source, 'pool source is not a JSON array');
  }

  const refs = [];
  const labels = new Map();
  for (const entry of parsed) {
    const ref = String(entry?.ref || '').trim();
    if (!ref) continue;
    if (!refs.includes(ref)) refs.push(ref);
    labels.set(ref, {
      provider: normaliseProvider(entry?.provider ?? entry?.numberProvider),
      country: normaliseCountry(entry?.country ?? entry?.numberCountry),
    });
  }
  return { source, refs, labels, error: null };
}

/**
 * Parse store.json. Throws with a message the operator can act on rather than
 * mutating anything — see the header for why this must not behave like
 * store.js's own loader.
 */
function readDb() {
  if (!fs.existsSync(DB_FILE)) {
    throw new Error(
      `no database at ${DB_FILE} — check DATA_DIR (currently ${DATA_DIR}); the app has not run here yet.`,
    );
  }
  let text;
  try {
    text = fs.readFileSync(DB_FILE, 'utf8');
  } catch (err) {
    throw new Error(`${DB_FILE} unreadable: ${err.message}`);
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') throw new Error('not a JSON object');
    return parsed;
  } catch (err) {
    throw new Error(
      `${DB_FILE} is not valid JSON (${err.message}). Nothing was changed — restore it from a backup.`,
    );
  }
}

/**
 * Normalise one `db.keypool` entry into a row this CLI can print and edit.
 *
 * The map is keyed by workspace ref, but the entry carries its own `ref` and the
 * blueprint sketch once described the collection as keyed by shop, so both are
 * tolerated: whichever of the key and the entry looks like a ref wins, and a key
 * shaped like a shop domain is read as the holder. Being wrong about the shape
 * here would mean an operator's `wipe` silently editing nothing.
 *
 * @param {string} key    the db.keypool map key
 * @param {object} value  the stored entry
 */
function normaliseRow(key, value) {
  const entry = value && typeof value === 'object' ? value : {};
  const keyIsShop = /\.myshopify\.com$/i.test(key);
  const ref = String(entry.ref || (keyIsShop ? '' : key) || '').trim();
  const shop = String(entry.shop || (keyIsShop ? key : '') || '').trim();

  // An entry with a holder but no recorded state predates the state machine (or
  // was written by a partial migration); read it as leased rather than as free,
  // because guessing "free" here is what would hand a live workspace to a second
  // merchant.
  let state = String(entry.state || '').trim().toLowerCase();
  if (!STATES.includes(state)) state = shop ? 'leased' : 'free';

  return {
    dbKey: key,
    ref,
    shop,
    state,
    since: firstTimestamp(entry),
  };
}

/** The most useful "since when" we have, whatever the writer chose to call it. */
function firstTimestamp(entry) {
  for (const field of ['wipedAt', 'releasedAt', 'quarantinedAt', 'diedAt', 'leasedAt', 'seededAt']) {
    const v = entry?.[field];
    if (typeof v === 'string' && v) return v;
  }
  return '';
}

/**
 * Every workspace we know about: the database's rows, plus any ref the seed
 * defines that the database has never recorded (which is a free workspace that
 * has simply never been leased).
 *
 * @returns {{ rows: object[], pool: ReturnType<typeof readPoolSource> }}
 */
function inventory() {
  const db = readDb();
  const keypool = db.keypool && typeof db.keypool === 'object' ? db.keypool : {};
  const rows = Object.entries(keypool).map(([k, v]) => normaliseRow(k, v));

  const pool = readPoolSource();
  const known = new Set(rows.map((r) => r.ref).filter(Boolean));
  for (const ref of pool.refs) {
    if (!known.has(ref)) rows.push({ dbKey: null, ref, shop: '', state: 'free', since: '' });
  }

  // The labels are joined on here rather than inside normaliseRow() because they
  // come from the other source entirely — the seed, not the database — and a row
  // that exists in only one of the two is normal, not a fault.
  for (const row of rows) {
    const label = pool.labels.get(row.ref);
    row.provider = label?.provider || '';
    row.country = label?.country || '';
  }

  rows.sort((a, b) => a.ref.localeCompare(b.ref));
  return { rows, pool };
}

/**
 * Counts in the same shape provisioning.poolStatus() reports, plus the two
 * breakdowns that decide whether an install gets a usable caller ID.
 *
 * byCountry/byProvider count FREE ENTRIES ONLY, matching store.js's
 * keypoolStatus() exactly. The question is not "what did we buy" but "what can
 * the next install actually get": a pool of forty numbers is out of stock for a
 * US merchant if all forty are leased, and a census that counted every state
 * would still read `US: 12` at the moment a US merchant is handed an Indian DID.
 *
 * `stockedCountries` is the separate, all-states view, and it exists only so
 * `status` can tell "we never stocked GB" apart from "we stocked GB and ran
 * out". The first is a business decision; the second is an incident.
 */
function counts(rows) {
  const out = {
    total: rows.length,
    free: 0,
    leased: 0,
    quarantined: 0,
    dead: 0,
    byCountry: {},
    byProvider: {},
    stockedCountries: new Set(),
  };
  for (const r of rows) {
    if (r.state in out) out[r.state] += 1;
    if (r.country) out.stockedCountries.add(r.country);
    if (r.state !== 'free') continue;
    const country = r.country || 'unknown';
    const provider = r.provider || 'unknown';
    out.byCountry[country] = (out.byCountry[country] || 0) + 1;
    out.byProvider[provider] = (out.byProvider[provider] || 0) + 1;
  }
  return out;
}

/** `{US: 9, IN: 8}` → `US 9, IN 8`, biggest first, with `none` for an empty map. */
function formatCensus(map) {
  const pairs = Object.entries(map).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (!pairs.length) return 'none';
  return pairs.map(([k, v]) => `${k} ${v}`).join(', ');
}

// ─────────────────────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────────────────────

function cmdStatus() {
  const { rows, pool } = inventory();
  const c = counts(rows);

  console.log(`Telenow workspace pool — ${DATA_DIR}`);
  console.log(`  seeded from      ${pool.source === 'none' ? 'nothing (unseeded)' : pool.source}`);
  if (pool.error) console.log(`  seed problem     ${pool.error}`);
  console.log(`  total            ${c.total}`);
  console.log(`  free             ${c.free}`);
  console.log(`  leased           ${c.leased}`);
  console.log(`  quarantined      ${c.quarantined}`);
  console.log(`  dead             ${c.dead}`);
  console.log(`  free by country  ${formatCensus(c.byCountry)}`);
  console.log(`  free by carrier  ${formatCensus(c.byProvider)}`);

  warnCountryStock(c);

  // Free only ever falls: every install takes one and every uninstall
  // quarantines one. An operator who sees this line has days of warning; the
  // alternative first symptom is a merchant meeting "503 provisioning" on a
  // fresh install, which reads as an outage rather than as an inventory problem.
  if (c.free < LOW_WATER_MARK) {
    console.log('');
    console.log(`  ! only ${c.free} free workspace(s) left (alarm below ${LOW_WATER_MARK}).`);
    console.log('    Mint more on telenow.ai and add them to the pool source, or wipe and');
    console.log('    return quarantined ones with:  node scripts/keypool.js wipe <ref> --wiped');
  }
  return 0;
}

/**
 * The warnings that a healthy-looking `free` count hides.
 *
 * Three separate conditions, deliberately not collapsed into one line, because
 * they need three different actions:
 *
 *   • No free US/CA number. Mint one BEFORE submitting for app review. The
 *     reviewer dials from North America and a foreign DID is frequently blocked
 *     or spam-filtered on the way in, so the most visible feature in the app —
 *     "Send a test call" — looks broken rather than slow. There is nothing the
 *     merchant, the reviewer or the app can do about it at that point: the app
 *     has no merchant-visible path to buying or choosing a number, on purpose
 *     (that off-platform purchase is the requirement 1.2.1 violation this app
 *     was paused for). Stocking the pool is the only fix, and it happens here.
 *   • A country the pool DOES stock has run out. New installs there are being
 *     leased whatever is free, which is a working call on a foreign caller ID —
 *     degraded, not broken, but it degrades silently.
 *   • Unlabelled free entries. They can never match a country, so they are only
 *     ever handed out as the fallback. Usually one missing field in the seed.
 */
function warnCountryStock(c) {
  const lines = [];

  const reviewFree = REVIEW_COUNTRIES.reduce((n, iso) => n + (c.byCountry[iso] || 0), 0);
  if (reviewFree < REVIEW_COUNTRY_MIN) {
    lines.push(
      `! only ${reviewFree} free ${REVIEW_COUNTRIES.join('/')} number(s) — want at least ${REVIEW_COUNTRY_MIN} before app review.`,
      '  Shopify reviews from North America and "Send a test call" is the first thing they press;',
      '  a foreign caller ID is routinely blocked or spam-filtered on the way to a US/CA mobile.',
      '  Mint one on the Telenow side, then add it to the pool seed with "country":"US".',
    );
  }

  const exhausted = [...c.stockedCountries]
    .filter((iso) => !REVIEW_COUNTRIES.includes(iso) && !(c.byCountry[iso] > 0))
    .sort();
  if (exhausted.length) {
    lines.push(
      `! out of free numbers in: ${exhausted.join(', ')} (the pool stocks these, none is free).`,
      '  New installs there are leased a foreign number — the call still connects, but from the',
      '  wrong country, and nothing merchant-visible says so.',
    );
  }

  const unlabelled = c.byCountry.unknown || 0;
  if (unlabelled) {
    lines.push(
      `! ${unlabelled} free workspace(s) have no country label and can never match a merchant.`,
      '  Add "provider" and "country" to those entries in the pool seed — see DEPLOY.md § 10.',
    );
  }

  if (!lines.length) return;
  console.log('');
  for (const line of lines) console.log(`  ${line}`);
}

function cmdList() {
  const { rows, pool } = inventory();
  if (pool.error) console.log(`! seed problem: ${pool.error}\n`);

  if (!rows.length) {
    console.log('The pool is empty. Seed it with TELENOW_KEY_POOL or ' + POOL_FILE + '.');
    return 0;
  }

  // Carrier and country come from the seed, so a dash in either column means the
  // entry is unlabelled there — not that the workspace has no number.
  const cell = (v) => v || '—';
  const widths = {
    ref: Math.max(3, ...rows.map((r) => r.ref.length || 1)),
    state: Math.max(5, ...rows.map((r) => r.state.length)),
    provider: Math.max(7, ...rows.map((r) => cell(r.provider).length)),
    country: 7,
    shop: Math.max(4, ...rows.map((r) => r.shop.length || 1)),
  };
  const pad = (s, n) => String(s).padEnd(n, ' ');

  console.log(
    `${pad('REF', widths.ref)}  ${pad('STATE', widths.state)}  ` +
      `${pad('CARRIER', widths.provider)}  ${pad('COUNTRY', widths.country)}  ` +
      `${pad('SHOP', widths.shop)}  SINCE`,
  );
  for (const r of rows) {
    console.log(
      `${pad(r.ref || '(no ref)', widths.ref)}  ${pad(r.state, widths.state)}  ` +
        `${pad(cell(r.provider), widths.provider)}  ${pad(cell(r.country), widths.country)}  ` +
        `${pad(r.shop || '—', widths.shop)}  ${r.since || '—'}`,
    );
  }

  const c = counts(rows);
  console.log('');
  console.log(`${c.total} workspace(s): ${c.free} free, ${c.leased} leased, ${c.quarantined} quarantined, ${c.dead} dead.`);
  console.log(`Free by country: ${formatCensus(c.byCountry)}. Free by carrier: ${formatCensus(c.byProvider)}.`);
  if (c.quarantined) {
    console.log('Quarantined workspaces still hold a former merchant\'s data and are NOT reusable');
    console.log('until they are purged on the Telenow side — see `wipe`.');
  }
  // Said out loud so nobody goes looking for a flag that would print them.
  console.log('API keys are never printed by this tool.');
  return 0;
}

/**
 * Return a quarantined workspace to the free pool.
 *
 * THE ENTIRE POINT OF THE --wiped FLAG. A released workspace still contains the
 * previous merchant's call recordings, transcripts, customer phone numbers and
 * agents. Leasing it to the next merchant hands one shop's protected customer
 * data to another — a data breach, not an inconvenience. Nothing in the running
 * app can move an entry out of quarantine for exactly that reason, and the only
 * thing standing between this command and the same breach is a human asserting
 * that they have actually purged the workspace upstream. So the flag is required
 * and is never inferred, defaulted, or implied by any other argument.
 */
function cmdWipe(args) {
  const ref = String(args.find((a) => !a.startsWith('-')) || '').trim();
  const asserted = args.includes('--wiped');

  if (!ref) {
    console.error('Usage: node scripts/keypool.js wipe <ref> --wiped');
    return 2;
  }

  const { rows } = inventory();
  const row = rows.find((r) => r.ref === ref);
  if (!row) {
    console.error(`No workspace with ref "${ref}". Run \`node scripts/keypool.js list\` to see them.`);
    return 1;
  }
  if (row.state !== 'quarantined') {
    console.error(
      `Refusing: ${ref} is "${row.state}", not "quarantined".` +
        (row.state === 'leased' ? ` It is currently held by ${row.shop || 'a shop'}.` : ''),
    );
    console.error('Only a quarantined workspace — one released by an uninstall — can be wiped back into the pool.');
    return 1;
  }

  if (!asserted) {
    console.error(`Refusing to free ${ref}: pass --wiped to confirm.`);
    console.error('');
    console.error('  This workspace was used by a merchant who has uninstalled. It STILL HOLDS');
    console.error('  their data: call recordings, call transcripts, their customers\' phone');
    console.error('  numbers, and the agents built for their store.');
    console.error('');
    console.error('  Returning it to the pool without purging it first leases all of that to');
    console.error('  the NEXT merchant who installs the app. That is a breach of another');
    console.error('  merchant\'s protected customer data, not a housekeeping shortcut.');
    console.error('');
    console.error(`  Before re-running with --wiped, sign in to telenow.ai as ${ref} and delete:`);
    console.error('    • every agent, prompt and knowledge base on the workspace');
    console.error('    • the entire call history, including recordings and transcripts');
    console.error('    • any contact / lead lists uploaded to it');
    console.error('  Then re-check that the call history really is empty.');
    console.error('');
    console.error(`  When that is genuinely done:  node scripts/keypool.js wipe ${ref} --wiped`);
    return 1;
  }

  const db = readDb();
  if (!db.keypool || typeof db.keypool !== 'object') db.keypool = {};
  const dbKey = row.dbKey;
  if (!dbKey || !db.keypool[dbKey]) {
    console.error(`Refusing: ${ref} has no row in ${DB_FILE} to update.`);
    return 1;
  }

  const entry = db.keypool[dbKey];
  const previousShop = row.shop;
  entry.ref = entry.ref || ref;
  entry.state = 'free';
  // The audit trail is the point: months later, "was ws-07 actually purged
  // before it went back out?" has to be answerable from the file itself.
  entry.wipedAt = new Date().toISOString();
  entry.wipedFromShop = previousShop || null;
  delete entry.shop;
  delete entry.leasedAt;

  writeDb(db);

  console.log(`${ref} returned to the free pool (was quarantined${previousShop ? ` from ${previousShop}` : ''}).`);
  console.log('');
  console.log('IF THE APP IS RUNNING, RESTART IT NOW. It holds this database in memory and');
  console.log('its next write rewrites the whole file, which would silently undo this change.');
  return 0;
}

/** Write store.json the way store.js does: tmp file, then rename. */
function writeDb(db) {
  const tmp = `${DB_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

function usage() {
  console.log('Telenow workspace pool — operator CLI');
  console.log('');
  console.log('  node scripts/keypool.js status');
  console.log('      Counts: total, free, leased, quarantined, dead — plus the FREE census by');
  console.log('      country and carrier, and a warning when a market is out of stock.');
  console.log('');
  console.log('  node scripts/keypool.js list');
  console.log('      Every workspace ref, its state, carrier, number country and the shop');
  console.log('      holding it. Never prints keys.');
  console.log('');
  console.log('  node scripts/keypool.js wipe <ref> --wiped');
  console.log('      Return a QUARANTINED workspace to the free pool. Refuses without --wiped,');
  console.log('      which asserts you have already purged the workspace on the Telenow side.');
  console.log('');
  console.log(`Reads DATA_DIR (currently ${DATA_DIR}).`);
}

function main(argv) {
  const [command, ...args] = argv;
  switch (command) {
    case 'status':
      return cmdStatus();
    case 'list':
      return cmdList();
    case 'wipe':
      return cmdWipe(args);
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      usage();
      return command === undefined ? 2 : 0;
    default:
      console.error(`Unknown command "${command}".`);
      console.error('');
      usage();
      return 2;
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  console.error(`keypool: ${err.message}`);
  process.exitCode = 1;
}
