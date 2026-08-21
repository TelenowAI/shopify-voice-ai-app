// ─────────────────────────────────────────────────────────────────────────────
// templates.js — ready-made voice agents for a Shopify store.
//
// Each template is a complete agent spec. Setting one up creates a real agent in
// the merchant's Telenow workspace, wired to their Shopify connector so it can
// read the store MID-CALL rather than only reciting what the webhook sent.
//
// Stack choice is deliberate and applies to every template:
//   LLM  xai / grok-4-fast-non-reasoning   260 ms, $0.20/$0.50 per M tokens
//   STT  deepgram / nova-3 (multi)         real-time code-switching for Hinglish
//   TTS  smallest / lightning_v3.1_pro     $10 per M chars
//
// TTS is ~half the per-minute cost, and the spread across providers is 8.3x
// ($6 Telenow → $50 ElevenLabs). These are transactional store calls where
// nobody is judging voice artistry, so the cheap end is the right end: roughly
// Rs 3.7/min instead of Rs 6.4/min. A merchant who wants a premium voice can
// switch the agent's TTS in Telenow afterwards.
//
// Prompts are written SHORT on purpose. Call length is the cost driver — a
// 39-second confirm and a 98-second chat cost 2.5x apart on identical
// technology — so each one states its goal, does it, and gets off the phone.
// ─────────────────────────────────────────────────────────────────────────────

/** Shared stack. Kept in one place so a merchant-wide change is a one-liner. */
const STACK = {
  llmProvider: 'xai',
  llmModel: 'grok-4-fast-non-reasoning',
  llmConfig: { temperature: 0.6 },
  sttProvider: 'deepgram',
  sttConfig: { model: 'nova-3', language: 'multi', punctuate: true, smart_format: true },
  ttsProvider: 'smallest',
  ttsVoice: 'meher',
  ttsConfig: { model: 'lightning_v3.1_pro' },
};

/** Behaviour every store agent shares. */
const SESSION = {
  contextMode: 'window',
  contextWindow: 12,
  maxDuration: 300,
  bargeInSensitivity: 0.5,
  behavior: {
    tone: 'professional_conversational',
    naturalFillers: true,
    aiDisclosureWhenAsked: true,
    scopeBoundaries: true,
    echoVerification: true,
  },
};

/** Prepended to every prompt: the rules that apply to all of them. */
const COMMON_RULES = [
  '## How to speak',
  '- Keep it short. One question at a time, and wait for the answer.',
  '- Match the language the customer uses. If they reply in Hindi or Hinglish, continue in that.',
  '- Never invent order details. If a tool gives you nothing, say you could not find it and offer to have a human follow up.',
  '- If asked whether you are a bot, say yes plainly, then carry on.',
  '- Do not argue, upsell hard, or repeat yourself. If they say no, accept it and close politely.',
  '- End the call as soon as the goal is met or clearly refused.',
].join('\n');

/**
 * Capability → tool spec. `connectionId` is filled in per merchant at setup.
 * Names are snake_case because the model calls them by name.
 */
const TOOLS = {
  'order.lookup': {
    name: 'lookup_order',
    description: 'Look up a Shopify order by its number to check status, payment, items or delivery.',
    handoff: 'Let me pull that order up…',
  },
  'customer.lookup': {
    name: 'lookup_customer',
    description: "Find the customer by phone, email or name to see their order history.",
    handoff: 'One moment…',
  },
  'product.search': {
    name: 'search_products',
    description: 'Search the store catalogue for a product by name to check price or availability.',
    handoff: 'Let me check the catalogue…',
  },
  'checkout.create_link': {
    name: 'create_checkout_link',
    description: 'Create a checkout link the customer can pay on. Use only after they agree to buy.',
    handoff: 'Creating that link for you…',
  },
  'order.update': {
    name: 'update_order',
    description: 'Write the outcome back onto the Shopify order as a tag or note.',
    handoff: 'Saving that…',
  },
};

/** The catalog. `capabilities` maps to TOOLS above. */
export const TEMPLATES = [
  {
    key: 'cod',
    // Which store event fires this agent. null = no automatic trigger yet.
    automationKey: 'codConfirmation',
    icon: '💵',
    name: 'COD Confirmation',
    tagline: 'Confirm cash-on-delivery orders before you ship',
    description:
      'Calls the customer right after a COD order and confirms they actually want it. '
      + 'Fake and impulse orders cancel themselves before you pay to ship them — the single '
      + 'highest-return call an Indian store can make.',
    capabilities: ['order.lookup', 'order.update'],
    opener: 'Hi, this is a quick call from {store_name} about your order.',
    variables: ['customer_name', 'order_number', 'order_total', 'items'],
    prompt: [
      'You are calling on behalf of {store_name} to confirm a Cash-on-Delivery order BEFORE it ships.',
      '',
      '## Your goal',
      'Get a clear yes or no on whether they still want this order.',
      '',
      '## The order',
      'Customer: {customer_name} · Order {order_number} · {items} · Total {order_total}, payable in cash on delivery.',
      '',
      '## How the call goes',
      '1. Greet them by name and say which store you are calling from.',
      '2. Read back the order in one sentence: what it is and the cash amount due.',
      '3. Ask directly: "Should we go ahead and ship this?"',
      '4. If YES — confirm the delivery address is correct, thank them, end.',
      '5. If NO — ask one short question about why (changed mind, ordered by mistake, price, found it cheaper), accept it, and end politely. Do not try to talk them back into it.',
      '6. If UNSURE — offer to hold the order for a day and call back.',
      '',
      '## Then',
      'Use update_order to tag the order: telenow-cod-confirmed, telenow-cod-cancelled, or telenow-cod-unsure. Add the reason as a note when they decline.',
      '',
      'If they ask anything about the order you were not told, use lookup_order.',
    ].join('\n'),
  },
  {
    key: 'rto',
    // Which store event fires this agent. null = no automatic trigger yet.
    automationKey: null,
    icon: '📦',
    name: 'RTO Reduction',
    tagline: 'Save parcels that are about to bounce back',
    description:
      'Calls when a delivery has failed or is at risk — courier could not reach them, address looks wrong, '
      + 'nobody answered. Re-confirms the address and reschedules, so the parcel gets delivered instead of '
      + 'returning to you at double the shipping cost.',
    capabilities: ['order.lookup', 'customer.lookup', 'order.update'],
    opener: 'Hi, calling from {store_name} about a delivery we could not complete.',
    variables: ['customer_name', 'order_number', 'courier_name', 'delivery_address'],
    prompt: [
      'You are calling on behalf of {store_name} because a delivery FAILED or is about to be returned.',
      '',
      '## Your goal',
      'Get the parcel delivered instead of returned. Fix whatever blocked it.',
      '',
      '## The order',
      'Customer: {customer_name} · Order {order_number} · Courier: {courier_name} · On file: {delivery_address}',
      '',
      '## How the call goes',
      '1. Say the courier could not complete the delivery, and that you want to get it to them.',
      '2. Find out why in one question: were they unavailable, is the address wrong, or do they no longer want it?',
      '3. If ADDRESS — read the address on file back and ask them to correct it. Repeat the corrected version so they confirm it.',
      '4. If UNAVAILABLE — ask which day and rough time works, and whether someone else can receive it.',
      '5. If THEY NO LONGER WANT IT — ask why briefly, accept it, end politely.',
      '',
      '## Then',
      'Use update_order to note the outcome and the corrected address or preferred slot, and tag telenow-rto-saved, telenow-rto-rescheduled or telenow-rto-refused.',
      '',
      'Use lookup_order for order details and lookup_customer if you need their history.',
    ].join('\n'),
  },
  {
    key: 'order-confirmation',
    // Which store event fires this agent. null = no automatic trigger yet.
    automationKey: 'orderConfirmation',
    icon: '✅',
    name: 'Order Confirmation',
    tagline: 'Verify items, quantity and address before dispatch',
    description:
      'Reads the order back line by line — product, quantity, and the full delivery address — and gets '
      + 'each confirmed. Catches wrong sizes, duplicate quantities and bad addresses while they are still '
      + 'free to fix.',
    capabilities: ['order.lookup', 'order.update'],
    opener: 'Hi, calling from {store_name} to confirm the order you just placed.',
    variables: ['customer_name', 'order_number', 'items', 'quantity', 'delivery_address', 'order_total'],
    prompt: [
      'You are calling on behalf of {store_name} to confirm a new order before it is dispatched.',
      '',
      '## Your goal',
      'Confirm three things: the items, the QUANTITY of each, and the delivery ADDRESS.',
      '',
      '## The order',
      'Customer: {customer_name} · Order {order_number} · {items} · Quantity: {quantity} · Total {order_total}',
      'Address on file: {delivery_address}',
      '',
      '## How the call goes',
      '1. Greet them and say you are confirming their order.',
      '2. Read the items and quantity: "That is {quantity} of {items}, is that right?" Wait for the answer.',
      '3. If the quantity is wrong, ask what it should be and repeat the corrected number back.',
      '4. Read the delivery address back in full. Ask them to confirm or correct it. Repeat any correction so they confirm it.',
      '5. State when it will ship, thank them, end.',
      '',
      '## Rules',
      '- Read the address slowly and completely, including the pincode. This is the step that prevents a return.',
      '- Confirm each item separately when there is more than one.',
      '- Never change an order without an explicit confirmation from them.',
      '',
      '## Then',
      'Use update_order to record what was confirmed or corrected, and tag telenow-order-confirmed or telenow-order-amended.',
    ].join('\n'),
  },
  {
    key: 'support',
    // Which store event fires this agent. null = no automatic trigger yet.
    automationKey: null,
    icon: '🎧',
    name: 'Customer Support',
    tagline: 'Answers orders, products and delivery questions',
    description:
      'A general support agent for inbound calls. Looks the caller up by their number, finds their order, '
      + 'and answers "where is my order", product and returns questions live from the store — instead of '
      + 'taking a message.',
    capabilities: ['order.lookup', 'customer.lookup', 'product.search'],
    opener: 'Hi, thanks for calling {store_name}. How can I help?',
    variables: ['store_name'],
    prompt: [
      'You are the customer support voice agent for {store_name}. Callers reach you with questions about their orders, products, delivery and returns.',
      '',
      '## Your goal',
      'Answer the question on this call, using the store data available to you.',
      '',
      '## Start',
      'Try lookup_customer with the caller\'s phone number to see who they are and what they ordered. If you find them, greet them by name and mention their most recent order.',
      '',
      '## What you handle',
      '- WHERE IS MY ORDER — lookup_order by order number, or use their most recent order. Give the status, what was in it, and the delivery expectation. Read the tracking number only if they ask.',
      '- PRODUCT QUESTIONS — search_products for price and availability. If it is not in the catalogue, say so.',
      '- RETURNS AND REFUNDS — explain the store policy in one or two sentences. Do not promise a refund amount or a date.',
      '- DELIVERY AND LOGISTICS — give the courier and expected timing from the order.',
      '',
      '## Boundaries',
      '- Never promise a refund, a discount or a delivery date you cannot see in the data.',
      '- If you cannot resolve it, say a team member will call back, and end. Do not stall.',
      '- Never read out payment details, and never ask for a card number, UPI PIN or OTP.',
    ].join('\n'),
  },
  {
    key: 'feedback',
    // Which store event fires this agent. null = no automatic trigger yet.
    automationKey: 'reviews',
    icon: '⭐',
    name: 'Product Feedback',
    tagline: 'Collect real feedback a few days after delivery',
    description:
      'Calls after delivery and asks how the product actually was. Voice gets real answers where email '
      + 'surveys get about two percent — and an unhappy customer gets caught before the review goes public.',
    capabilities: ['order.lookup'],
    opener: 'Hi, calling from {store_name} about the order you received recently.',
    variables: ['customer_name', 'order_number', 'items', 'delivered_days_ago'],
    prompt: [
      'You are calling on behalf of {store_name} to collect honest feedback after a delivery.',
      '',
      '## Your goal',
      'A rating out of five, and one sentence of why. Nothing more.',
      '',
      '## The order',
      'Customer: {customer_name} · Order {order_number} · {items} · Delivered about {delivered_days_ago} days ago.',
      '',
      '## How the call goes',
      '1. Greet them, say what the call is about, and ask if it is a good time. If not, offer to call back and end.',
      '2. Ask: "On a scale of one to five, how would you rate the product?"',
      '3. Ask ONE follow-up: what made it that score.',
      '4. If the score is 4 or 5 — thank them and mention a review would help other shoppers. Ask once, do not push.',
      '5. If the score is 3 or below — apologise once, ask what would make it right, and tell them the team will follow up. Do not offer a refund or replacement yourself.',
      '6. Thank them and end.',
      '',
      '## Rules',
      '- This is a short call. Do not turn it into a survey.',
      '- Take the criticism plainly. Never argue or explain it away.',
    ].join('\n'),
  },
  {
    key: 'post-purchase',
    // Which store event fires this agent. null = no automatic trigger yet.
    automationKey: null,
    icon: '🛍️',
    name: 'Post-Purchase',
    tagline: 'Check in after delivery, and recommend what fits',
    description:
      'Calls a few days after delivery to check the product arrived well, answers any early questions, '
      + 'and — only if the call is going well — suggests one genuinely related product and sends a '
      + 'checkout link on the call.',
    capabilities: ['order.lookup', 'product.search', 'checkout.create_link'],
    opener: 'Hi, calling from {store_name} to check in on your recent order.',
    variables: ['customer_name', 'order_number', 'items'],
    prompt: [
      'You are calling on behalf of {store_name} a few days after a delivery.',
      '',
      '## Your goal, in order',
      '1. Check the product arrived and is working out.',
      '2. Answer any question they have about it.',
      '3. ONLY IF the call is going well, suggest one related product.',
      '',
      '## The order',
      'Customer: {customer_name} · Order {order_number} · {items}',
      '',
      '## How the call goes',
      '1. Greet them and ask how they are finding {items}.',
      '2. If there is a PROBLEM — stop everything else. Listen, apologise once, say the team will follow up, and end. Do not recommend anything.',
      '3. If they are HAPPY — answer any questions using lookup_order or search_products.',
      '4. Then, once only: suggest one product that genuinely goes with what they bought. Say what it is and the price.',
      '5. If they are interested — use create_checkout_link and tell them it is on its way by message.',
      '6. If they are not — accept it immediately, thank them and end.',
      '',
      '## Rules',
      '- One recommendation. Never a second.',
      '- Never recommend anything to an unhappy customer.',
      '- Recommend something that actually relates to their purchase, not the most expensive thing you can find.',
    ].join('\n'),
  },
];

/** Look one up by key. */
export function getTemplate(key) {
  return TEMPLATES.find((t) => t.key === key) || null;
}

/** The catalog as the UI needs it — no prompts, which are long and not shown. */
export function listTemplates() {
  return TEMPLATES.map(({ key, icon, name, tagline, description, capabilities, variables, automationKey, opener, prompt }) =>
    ({ key, icon, name, tagline, description, capabilities, variables, automationKey,
      // The wizard pre-fills its Context step from these, so they ship with the catalog.
      opener, prompt }));
}

/**
 * Turn a template into a Shopify-agents create payload.
 *
 * Note the casing flip: this API takes camelCase on the way IN (llmProvider)
 * and returns snake_case on the way OUT (llm_provider). Do not reuse one shape
 * for both directions.
 *
 * @param {object} tpl               a TEMPLATES entry
 * @param {string} shop              the myshopify domain, used for naming
 * @param {string} storeName         display name, substituted into the prompt
 * @param {string|null} connectionId the Shopify connector; tools are omitted without it
 * @param {object} [o]               wizard overrides — every field optional, and
 *                                   anything absent falls back to the template default
 */
export function buildAgentPayload(tpl, shop, storeName, connectionId, o = {}) {
  const store = storeName || shop;
  // Tools reference the connection, never the credentials.
  const tools = connectionId
    ? tpl.capabilities
        .filter((cap) => TOOLS[cap])
        .map((cap) => ({ ...TOOLS[cap], kind: 'connector', config: { connectionId, capability: cap } }))
    : [];

  // A transfer target is a native tool, not a connector one.
  const dests = (o.transferDestinations || []).filter((d) => d && d.number);
  if (dests.length) {
    tools.push({
      name: 'transfer_to_human',
      description: 'Hand the call to a person when the caller asks for one or the agent cannot help.',
      kind: 'transfer',
      config: {
        destinations: dests.map((d) => ({ label: d.label || 'support', number: d.number })),
        message: o.transferMessage || 'Sure, connecting you now.',
      },
    });
  }

  const prompt = (o.systemPrompt || tpl.prompt).replace(/{store_name}/g, store);
  const opener = (o.opener || tpl.opener).replace(/{store_name}/g, store);

  return {
    name: o.name || `${tpl.name} — ${store}`,
    description: tpl.tagline,
    systemPrompt: `${prompt}

${COMMON_RULES}`,
    llmProvider: o.llmProvider || STACK.llmProvider,
    llmModel: o.llmModel || STACK.llmModel,
    llmConfig: STACK.llmConfig,
    sttProvider: o.sttProvider || STACK.sttProvider,
    sttConfig: { ...STACK.sttConfig, ...(o.sttModel ? { model: o.sttModel } : {}) },
    ttsProvider: o.ttsProvider || STACK.ttsProvider,
    ttsVoice: o.ttsVoice || STACK.ttsVoice,
    ttsConfig: { ...STACK.ttsConfig, ...(o.ttsModel ? { model: o.ttsModel } : {}) },
    sessionConfig: SESSION,
    telephonyConfig: {
      agentMsgOutbound: opener,
      // 'agent' makes the agent speak first on an outbound call.
      firstResponseOutbound: o.speakOpener === false ? 'user' : 'agent',
      recording: true,
    },
    metadata: {
      environment: 'staging',
      channels: ['phone'],
      tools,
      variables: tpl.variables
        .filter((v) => v !== 'store_name')
        .map((name) => ({ name, required: false })),
      telenowShopify: { template: tpl.key, shop },
    },
  };
}
