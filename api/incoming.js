/**
 * Twilio Incoming Message Handler — AI-powered WhatsApp replies.
 *
 * URL params (set automatically by iFlow Settings):
 *   ?generic=0  — disable the generic fallback message
 *   ?reply=0    — disable ALL replies
 *
 * Vercel Environment Variables:
 *   GROQ_API_KEY          — Groq API key (gsk_...) — AI replies
 *   GEMINI_API_KEY        — Gemini key as fallback
 *   STORE_NAME            — store name in replies (e.g. "Joyce's Boutique")
 *   PRODUCTS_BLOB_URL     — public Blob URL for live product/payment data
 *   PRODUCTS_JSON         — fallback product list if Blob not set
 *   OWNER_WHATSAPP        — store owner's WhatsApp e.g. "+2348012345678"
 *   TWILIO_SID            — Twilio Account SID
 *   TWILIO_TOKEN          — Twilio Auth Token
 *   TWILIO_FROM           — Twilio WhatsApp sender e.g. "whatsapp:+14155238886"
 *   BLOB_READ_WRITE_TOKEN — Vercel Blob token (for storing chats + orders)
 */
import { put } from '@vercel/blob';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).end('Method Not Allowed');
  }

  const {
    From        = '',
    To          = '',
    Body        = '',
    ProfileName = '',
    MessageSid  = '',
    NumMedia    = '0'
  } = req.body || {};

  const allOff    = req.query?.reply   === '0';
  const genericOn = req.query?.generic !== '0';
  const storeName = process.env.STORE_NAME || 'our store';
  const apiKey    = process.env.GROQ_API_KEY || process.env.GEMINI_API_KEY || '';
  const notifyNum = req.query?.notify ? decodeURIComponent(req.query.notify) : '';

  const ctxFromUrl  = req.query?.ctx ? decodeURIComponent(req.query.ctx) : '';
  const blobBase    = (process.env.PRODUCTS_BLOB_URL || '').replace('iflow-products.json', '');

  // Load store data + this customer's conversation memory in parallel
  const [blobData, history] = await Promise.all([
    _fetchBlobData(),
    _loadChatMemory(From, blobBase)
  ]);

  const productCtx     = blobData.ctx || ctxFromUrl || (process.env.PRODUCTS_JSON || '');
  const paymentInfo    = blobData.paymentInfo || {};
  const riderEmails    = blobData.riderEmails || [];
  const negotiationPct    = blobData.negotiationPct ?? (parseFloat(process.env.NEGOTIATION_FLOOR_PCT) || 0);
  const loyalDiscountOn   = blobData.loyalDiscountOn  || false;
  const loyalDiscountAmt  = blobData.loyalDiscountAmt || 0;
  const loyalDiscountType = blobData.loyalDiscountType || 'pct';
  const hasEverOrdered    = history.some(m => /ORDER ALERT:/i.test(m.content));
  const isLoyalCustomer   = loyalDiscountOn && loyalDiscountAmt > 0 && hasEverOrdered;

  console.log(JSON.stringify({
    event: 'twilio_incoming', sid: MessageSid, from: From,
    name: ProfileName, body: Body.slice(0, 200),
    provider: apiKey.startsWith('gsk_') ? 'groq' : apiKey ? 'gemini' : 'none',
    hasProducts: !!productCtx, hasPayment: !!(paymentInfo.bank),
    memoryMessages: history.length, ts: new Date().toISOString()
  }));

  res.setHeader('Content-Type', 'text/xml');
  if (allOff) return res.status(200).send('<Response></Response>');

  const isPureGreeting = /^\s*(hi+|hello|hey+|sup|howdy|good\s*(morning|afternoon|evening|day))\s*[!?.]?\s*$/i.test(Body);

  // Server-side payment proof detection — don't rely solely on AI appending PAYMENT ALERT
  const looksLikePaymentProof = /\b(paid|payment|transferred|sent money|receipt|proof|screenshot|transfer|deposited|i've paid|i have paid|check it|already paid|i don pay|i done pay|i send am|e don done|money don enter|i dey come pick|i'll pick it up|coming to pick|pick it up|picking up|on my way|i dey road|i dey come|collecting it|self pickup|will pick up|come get it)\b/i.test(Body);
  // "Active" order = an ORDER ALERT that has NO subsequent PAYMENT ALERT.
  // If the last PAYMENT ALERT comes after the last ORDER ALERT, the order is DONE.
  let _lastOrderIdx = -1, _lastPaymentIdx = -1;
  history.forEach((m, i) => {
    if (/ORDER ALERT:/i.test(m.content))   _lastOrderIdx   = i;
    if (/PAYMENT ALERT:/i.test(m.content)) _lastPaymentIdx = i;
  });
  const hasActiveOrderInMemory = _lastOrderIdx !== -1 && _lastOrderIdx > _lastPaymentIdx;

  if (apiKey && Body.trim()) {
    // Prune history for AI: discard everything up to and including the last PAYMENT ALERT.
    // This strips completed-order context so old MacBook/AirPods chatter can't pollute
    // a brand-new Samsung conversation.
    const historyForAi = _lastPaymentIdx >= 0 ? history.slice(_lastPaymentIdx + 1) : history;

    // ── PAYMENT BYPASS — deterministic, no AI involved ────────────────────────
    // When the customer clearly says "paid" and we have an unconfirmed ORDER ALERT,
    // skip the AI entirely. The AI is too unreliable here — it ignores injections.
    if (looksLikePaymentProof && hasActiveOrderInMemory) {
      const lastOrder = history.filter(m => /ORDER ALERT:/i.test(m.content)).pop();
      const orderLine = lastOrder
        ? ((lastOrder.content.match(/ORDER ALERT:(.*)/i) || [])[1]?.trim() || lastOrder.content.slice(0, 200))
        : `${ProfileName || 'Customer'} | details in conversation`;
      const confirmMsg = `Got it! 🙏 Payment received — our team is verifying now, you'll hear from us shortly.`;
      const fullReply  = confirmMsg + '\nPAYMENT ALERT: ' + orderLine;
      const sid   = process.env.TWILIO_SID   || '';
      const token = process.env.TWILIO_TOKEN || '';
      await Promise.allSettled([
        _handlePaymentAlert(orderLine, From, ProfileName, storeName, sid, token, notifyNum, riderEmails),
        _saveChatMemory(From, blobBase, [
          ...history,
          { role: 'user',      content: Body },
          { role: 'assistant', content: fullReply }
        ])
      ]);
      return res.status(200).send(`<Response><Message>${escapeXml(confirmMsg)}</Message></Response>`);
    }
    // ─────────────────────────────────────────────────────────────────────────

    const lastAssistantMsg = historyForAi.filter(m => m.role === 'assistant').pop();
    const bodyWordCount = Body.trim().split(/\s+/).length;
    const looksLikeSelection = bodyWordCount <= 8 &&
      /\b(green|black|white|red|blue|gold|silver|first|second|third|one|two|three|1st|2nd|3rd|the one|that one|this one|option\s*\d|smaller|bigger|cheaper|expensive|that|this)\b/i.test(Body);
    const lastMsgOfferedOptions = lastAssistantMsg &&
      /which (one|would you|do you)|two options|both options|we have.*and.*which|option 1|option 2|\bor\b.*\bwhich\b/i.test(lastAssistantMsg.content);

    // Extract last known delivery address from ORDER ALERT history
    const lastOrderWithAddr = history.filter(m => /ORDER ALERT:/i.test(m.content) && /Address:/i.test(m.content)).pop();
    const lastKnownAddress  = lastOrderWithAddr
      ? (lastOrderWithAddr.content.match(/Address:\s*([^|\n]+)/i) || [])[1]?.trim()
      : null;

    let messageToAi = Body;
    if (looksLikeSelection && lastMsgOfferedOptions) {
      messageToAi = `[Context: I just offered these options to the customer: "${lastAssistantMsg.content.slice(0, 300)}". The customer is now choosing from that list.]\nCustomer message: ${Body}`;
    }

    // "Usual address" injection — resolve before AI sees the message
    const looksLikeUsualAddress = /\b(usual|same|last|previous|normal|regular)\b.{0,20}\b(address|place|location)\b|\bmy address\b|\bdeliver.*same\b|\bsame.*address\b/i.test(Body);
    if (looksLikeUsualAddress && lastKnownAddress) {
      messageToAi = `[Context: Customer said "my usual address" — the last address on file is: "${lastKnownAddress}". Use this address directly without asking any questions.]\nCustomer: ${Body}`;
    }

    let aiReply = await _callAi(messageToAi, ProfileName, storeName, apiKey, productCtx, historyForAi, paymentInfo, negotiationPct, isLoyalCustomer, loyalDiscountAmt, loyalDiscountType);

    // Guard: if AI greeted on a non-greeting message, retry with explicit nudge
    if (aiReply && !isPureGreeting && /^Hi[!,]?\s+How can I help/i.test(aiReply.trim())) {
      const nudge = historyForAi.length
        ? `[System: The customer just said "${Body}". This continues the conversation — do NOT greet. Respond in context.]`
        : `[System: "${Body}" is not a greeting. Ask what they need help with.]`;
      aiReply = await _callAi(nudge + '\n' + Body, ProfileName, storeName, apiKey, productCtx, historyForAi, paymentInfo, negotiationPct, isLoyalCustomer, loyalDiscountAmt, loyalDiscountType) || aiReply;
    }

    // Guard: if AI claimed payment received but no active order in history, correct it
    const aiClaimsPayment = aiReply && /payment received|our team is verifying|PAYMENT ALERT:/i.test(aiReply);
    if (aiClaimsPayment && !hasActiveOrderInMemory) {
      const correction = `[System: CORRECTION — no order has been confirmed yet. "${Body}" is a purchase confirmation, NOT payment. Ask for the delivery address next. Do NOT say payment received.]`;
      aiReply = await _callAi(correction + '\n' + Body, ProfileName, storeName, apiKey, productCtx, historyForAi, paymentInfo, negotiationPct, isLoyalCustomer, loyalDiscountAmt, loyalDiscountType) || aiReply;
    }

    // Guard: if AI says "need to choose / haven't ordered" but active order exists, correct it
    const aiConfusedAboutOrder = aiReply && /haven.t ordered|no order.*placed|need to (choose|select|pick|decide)|still need to (choose|select)|you haven.t (placed|made|selected)|can.t pay without|cannot pay without|(select|choose|pick).*first|without (selecting|choosing|picking)/i.test(aiReply);
    if (aiConfusedAboutOrder && hasActiveOrderInMemory) {
      const lastOrder = history.filter(m => /ORDER ALERT:/i.test(m.content)).pop();
      const orderCtx = lastOrder ? lastOrder.content.slice(0, 300) : 'See history for confirmed order';
      const fix = `[System: CORRECTION — an order WAS already confirmed. Evidence: "${orderCtx}". Customer said: "${Body}". Respond appropriately — do NOT ask them to re-select or re-confirm.]`;
      aiReply = await _callAi(fix + '\n' + Body, ProfileName, storeName, apiKey, productCtx, historyForAi, paymentInfo, negotiationPct, isLoyalCustomer, loyalDiscountAmt, loyalDiscountType) || aiReply;
    }

    if (aiReply) {
      const sid   = process.env.TWILIO_SID   || '';
      const token = process.env.TWILIO_TOKEN || '';

      if (/ORDER ALERT:/i.test(aiReply)) {
        _notifyOwner(aiReply, From, ProfileName, storeName, sid, token, notifyNum).catch(() => {});
      }

      // AI-triggered payment alert (edge case: AI fires PAYMENT ALERT without server bypass)
      if (/PAYMENT ALERT:/i.test(aiReply)) {
        const alertFromAi = (aiReply.match(/PAYMENT ALERT:(.*)/i) || [])[1]?.trim()
          || `${ProfileName || 'Customer'} | details in conversation`;
        _handlePaymentAlert(alertFromAi, From, ProfileName, storeName, sid, token, notifyNum, riderEmails).catch(() => {});
      }

      // Complaint alert
      if (/COMPLAINT ALERT:/i.test(aiReply)) {
        const summary = (aiReply.match(/COMPLAINT ALERT:(.*)/i) || [])[1]?.trim()
          || `${ProfileName || 'Customer'} has a complaint`;
        _saveAlert('complaint', summary, From, ProfileName, sid, token, notifyNum).catch(() => {});
      }

      // Price escalation
      if (/ESCALATE ALERT:/i.test(aiReply)) {
        const summary = (aiReply.match(/ESCALATE ALERT:(.*)/i) || [])[1]?.trim()
          || `${ProfileName || 'Customer'} wants to negotiate further`;
        _saveAlert('negotiation', summary, From, ProfileName, sid, token, notifyNum).catch(() => {});
      }

      const customerReply = aiReply
        .replace(/\n?ORDER ALERT:.*$/im, '')
        .replace(/\n?PAYMENT ALERT:.*$/im, '')
        .replace(/\n?COMPLAINT ALERT:.*$/im, '')
        .replace(/\n?ESCALATE ALERT:.*$/im, '')
        .trim();

      // Save full aiReply (ORDER ALERT preserved) so payment bypass can find order details later
      _saveChatMemory(From, blobBase, [
        ...history,
        { role: 'user',      content: Body },
        { role: 'assistant', content: aiReply }
      ]).catch(() => {});

      return res.status(200).send(`<Response><Message>${escapeXml(customerReply)}</Message></Response>`);
    }
  }

  if (genericOn) {
    const msg = ProfileName
      ? `Hi ${ProfileName}! Thanks for reaching out to *${storeName}*. We'll get back to you shortly 🙏`
      : `Hi! Thanks for reaching out to *${storeName}*. We'll be with you shortly 🙏`;
    return res.status(200).send(`<Response><Message>${escapeXml(msg)}</Message></Response>`);
  }

  res.status(200).send('<Response></Response>');
}

// Chat memory file prefix — increment (v3, v4…) to wipe all stored histories
const CHAT_PREFIX = 'iflow-mem2-';
const CHAT_TTL_MS = 24 * 60 * 60 * 1000; // messages older than 24h are dropped

function _chatKey(from) {
  return CHAT_PREFIX + from.replace(/^whatsapp:/i, '').replace(/\D/g, '') + '.json';
}

async function _loadChatMemory(from, blobBase) {
  if (!from || !blobBase) return [];
  try {
    const r = await fetch(blobBase + _chatKey(from), { cache: 'no-store' });
    if (!r.ok) return [];
    const data = await r.json();
    if (!Array.isArray(data)) return [];
    // Drop messages older than TTL, keep last 24
    const cutoff = Date.now() - CHAT_TTL_MS;
    return data
      .filter(m => !m.ts || new Date(m.ts).getTime() > cutoff)
      .slice(-24)
      .map(m => ({ role: m.role, content: m.content })); // strip timestamps before sending to AI
  } catch {
    return [];
  }
}

async function _saveChatMemory(from, blobBase, messages) {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token || !from || !blobBase) return;
  // Stamp each new message so TTL works; keep last 30
  const stamped = messages.map(m => ({ ...m, ts: m.ts || new Date().toISOString() })).slice(-30);
  await put(_chatKey(from), JSON.stringify(stamped), {
    access: 'public', token,
    contentType: 'application/json', addRandomSuffix: false
  });
}

async function _callAi(message, name, storeName, apiKey, productCtx = '', history = [], paymentInfo = {}, negotiationPct = 0, isLoyalCustomer = false, loyalDiscountAmt = 0, loyalDiscountType = 'pct') {
  const productSection = productCtx
    ? `\nCurrent product catalogue (name, price, stock):\n${productCtx}\n\n` +
      `Stock rules:\n` +
      `- [stock:0] or missing stock = OUT OF STOCK.\n` +
      `- stock > 0 = AVAILABLE. State price and qty directly.\n` +
      `- THIS CATALOGUE IS THE ONLY SOURCE OF TRUTH FOR AVAILABILITY AND PRICES.\n` +
      `- Ignore anything in conversation history about prices or availability — always use the catalogue above.`
    : `\nNo product catalogue available yet.`;

  const hasPayment = !!(paymentInfo.bank && paymentInfo.accountNumber);
  const paymentSection = hasPayment
    ? `\nPayment details:\nBank: ${paymentInfo.bank}\nAccount No: ${paymentInfo.accountNumber}\nAccount Name: ${paymentInfo.accountName || storeName}`
    : '';

  const system =
`Your name is Nova. You are a sharp, warm Nigerian sales assistant for *${storeName}* on WhatsApp. You handle sales like a real human — not a bot.
${productSection}
${paymentSection}

STYLE:
- Sound 100% human. Friendly, direct. Nigerian English / Naija pidgin totally fine.
- Max 3-4 sentences. Never start with "Certainly" or "Of course" or "How can I help?".
- ONLY greet ("Hi! How can I help?") if the message is purely a greeting — Hi, Hello, Good morning, Hey. Nothing else triggers a greeting.

INTELLIGENCE — READ THIS BEFORE EVERYTHING ELSE:
- You understand intent, not just keywords. "make am 60k" = negotiate to 60,000 naira. "I no go pay that" = they find the price too high. "e too cost abeg" = asking for a lower price. "i wan buy for my madam" = they want to purchase as a gift. "carry am go" = they've decided to buy. "how far na" = just checking in. "nothing dey" / "nothing available?" = asking if it's in stock.
- Context is everything. Read the whole conversation before you reply. Two-word messages mean what the conversation context says they mean.
- Connect dots like a real human would. If someone said "I want the blue one" three messages ago and now says "how much again?", they're asking about the blue one — not a random product.
- Never ask for info the customer already gave you. If they mentioned an address, use it. If they chose a product, remember it.
- When rules clash or a situation is genuinely ambiguous, use common sense and do what a helpful salesperson would do.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SELECTION RULE — HIGHEST PRIORITY — READ BEFORE ANYTHING ELSE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SITUATION: You JUST offered specific options (e.g. "We have iPhone 12 Black ₦100 and iPhone 12 Green ₦200 — which?")
THEN: Customer replies with a short selection ("the green one", "option 2", "the black one", "that one", "the second", "the cheaper one", "the first")
MANDATORY: You MUST confirm the matching item from YOUR OFFERED LIST. Period.

WRONG: Customer picks "the green one" from your iPhone 12 list → you talk about green AirPods Max. NEVER.
RIGHT:  Customer picks "the green one" from your iPhone 12 list → confirm iPhone 12 Green ₦200. DONE.

This rule overrides catalogue search. When customer is choosing from YOUR list, DO NOT search the catalogue for the colour/feature — match it to what YOU offered.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

PRODUCT KNOWLEDGE:
- Catalogue above is the only truth for availability, prices and stock.
- Fuzzy match aggressively: "iphone13pro" = "iPhone 13 Pro", "xr" = "XR", spelling errors fine.
- Products with [condition:...] have defects or limitations. Read the condition naturally — gauge severity yourself.
  Example: "slight edge scratches" = minor cosmetic. "cracked screen" = major, warn clearly. "e-sim only" = must disclose.
- If multiple variants exist for what customer wants (different colours/storage), list them and ask which — don't pick for them.
- If customer specifies enough detail to identify one variant, go with it directly.

CONVERSATION INTELLIGENCE — CRITICAL:
- Read ALL history before responding. Understand what's been discussed.
- "I want 1", "order it", "yes", "that one", "give me that" = they mean the product last discussed. NEVER ask "what would you like to order?" when context makes it obvious.
- If address was already given, don't ask again. If item was already confirmed, move to next missing piece.
- Connect the dots like a human would. Piece together fragmented messages naturally.
- If history shows a completed ORDER ALERT followed by a PAYMENT ALERT, that order is FULLY DONE. Start fresh — do not reference it as if it's still pending.
- Focus only on what the customer is asking for RIGHT NOW.

ADDRESS RULES — DO NOT BE NOSY:
- Customer gives a specific address → use it immediately. Do NOT ask questions or confirm it back.
- Customer says "my usual address" / "same address" / "deliver there" → use the address in the [Context] injection above. Do NOT ask which address or compare old addresses. Just use it.
- Customer says nothing about address yet → ask once: "What delivery address should I send it to?"
- NEVER bring up or compare multiple old addresses. Only ever use the most recent one.

BRAND NEW RULE:
- "brand new", "new", "sealed" as a condition means the product is perfect — never describe it as having defects or limitations.

ORDER FLOW (flexible, not a rigid script):
1. Figure out what they want — from this message and history combined.
2. If multiple variants exist AND customer didn't specify: list options, ask which one. Wait for answer.
3. Once you have: item + specific variant (if needed) + qty → ask for delivery address IF not already given.
   - "yes", "ok", "I want it", "that one", "yes please" = buyer confirming purchase interest. This is NOT payment. Move to step 3: ask for address.
4. Once you have item + qty + address → confirm ONCE and send payment:
   "Got it! ✅ [item] x[qty] → [address]."
   Append on new line: ORDER ALERT: ${name || 'Customer'} | [item] x[qty] | Address: [address]
${hasPayment ? `   Also in the same message:
   "Please pay ₦[price×qty] to:\\n*Bank:* ${paymentInfo.bank}\\n*Acct No:* ${paymentInfo.accountNumber}\\n*Name:* ${paymentInfo.accountName || storeName}\\n\\nSend a screenshot or type *Paid* when done. 🙏"` : ''}

IMPORTANT — ONE THING PER RESPONSE:
- If you're offering a variant as an option ("would that work?"), do NOT also confirm the order in the same message. Wait for yes/no.
- Never say "we don't have X but we have Y — would that work? Got it, Y confirmed!" in one message. Offer first. Confirm after.

LOYAL CUSTOMER:
${isLoyalCustomer
  ? `- This customer has ordered from ${storeName} before. They qualify for a loyal shopper reward: ${loyalDiscountType === 'amt' ? '₦' + loyalDiscountAmt + ' off' : loyalDiscountAmt + '% off'} their order.
- When they're placing a new order (after you have item + qty + address), mention this warmly before sharing payment details: "By the way, as one of our returning customers you get ${loyalDiscountType === 'amt' ? '₦' + loyalDiscountAmt + ' off' : loyalDiscountAmt + '% off'} — so your total is ₦[discounted amount]. 🎉"
- Apply the discount when calculating the total in ORDER ALERT and the payment amount.
- Don't mention the discount until they're about to pay — don't lead with it.`
  : '- No loyal customer discount active for this customer.'}

COMPLAINT HANDLING:
- If a customer expresses frustration, dissatisfaction, or complains about an order, delivery, product quality, or any part of the service:
  → Respond briefly and warmly. 1-2 sentences max. Acknowledge the problem, don't make excuses. Example: "I'm sorry to hear that — that's not the experience we want for you. 🙏 I'm flagging this to the team right away."
  → Append on a new line: COMPLAINT ALERT: [customer name] — [one-sentence summary of the complaint]
  → Do NOT try to resolve the issue yourself. Just acknowledge and flag it.
- "Annoyed" / "I've been waiting" / "this is too long" / "what is happening" / "I'm not happy" are all complaints.

PRICE NEGOTIATION:
${negotiationPct > 0
  ? `- You CAN offer a discount — maximum ${negotiationPct}% below the listed price. Calculate the floor price yourself (listed price × ${(1 - negotiationPct / 100).toFixed(2)}).
- When a customer asks for a lower price / says it's too expensive / asks for discount:
  → Counter-offer ONCE at a meaningful but not maximum discount (aim for half the max, round to nearest 500 or 1000 naira).
  → Be warm and firm: "Tightest I can go is ₦X — that's saving you ₦Y. Deal? 😊"
- If they push further below your counter: hold firm. "That's genuinely my best price, I can't go below ₦X 🙏" — then append: ESCALATE ALERT: [customer name] pushing price below floor on [item]
- If they STILL keep pushing after that: "Let me flag this to the store owner — they'll reach out to you directly 🙏" — append: ESCALATE ALERT: [customer name] very persistent on price, needs owner attention
- If they accept your counter-offer: use the AGREED price (not the catalogue price) in the ORDER ALERT and payment instructions.
- Never volunteer a discount unprompted. Only negotiate when customer explicitly asks.`
  : `- Prices are fixed. If a customer pushes hard more than once, say: "I totally understand — let me pass this to the owner and they'll reach out to you shortly 🙏" then append: ESCALATE ALERT: [customer name] pushing on price for [item], prices are fixed
  Otherwise just decline warmly: "Prices are set — but it's worth every kobo! 😊 Want to go ahead?"`}

PAYMENT PROOF — ONLY when customer explicitly says they have already sent money / paid / transferred:
- CRITICAL: Only fire this if ORDER ALERT has already been sent earlier in this conversation. If ORDER ALERT is NOT in history yet, the order hasn't been placed — "yes", "done", "ok" means they're confirming purchase, NOT paying. Ask for their address instead.
- "yes" / "ok" / "sure" alone = purchase confirmation, NOT payment proof. Never reply with payment-received for these.
- Trigger only for: paid, transferred, I've paid, sent it, receipt, screenshot, I don pay, i done pay, money don enter, etc.
Reply: "Got it! 🙏 Payment received — our team is verifying now, you'll hear from us shortly."
Append on new line: PAYMENT ALERT: ${name || 'Customer'} | [item from history] x[qty] | Address: [address from history]`;

  // Inject a reminder at the top of history so old corrupted messages don't override catalogue
  const systemReminder = {
    role: 'user',
    content: '[System note: Catalogue in system prompt has current prices and stock — use it for prices/availability. But use conversation history to understand WHAT the customer wants, what was agreed, and any address already given. Never forget what was discussed earlier in this chat.]'
  };
  const assistantAck = { role: 'assistant', content: 'Got it.' };
  const userMessages = history.length
    ? [systemReminder, assistantAck, ...history, { role: 'user', content: message }]
    : [{ role: 'user', content: message }];

  try {
    if (apiKey.startsWith('gsk_')) {
      for (const model of ['llama-3.3-70b-versatile', 'llama-3.1-70b-versatile', 'llama-3.1-8b-instant']) {
        const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
          body:    JSON.stringify({
            model,
            messages:    [{ role: 'system', content: system }, ...userMessages],
            max_tokens:  400,
            temperature: 0.3
          })
        });
        if (r.ok) {
          const d = await r.json();
          const t = d?.choices?.[0]?.message?.content?.trim();
          if (t) return t.length > 1500 ? t.slice(0, 1497) + '…' : t;
        }
        if (r.status === 401 || r.status === 403) break;
      }
    } else {
      const contents = userMessages.map(m => ({
        role:  m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      }));
      for (const m of ['gemini-2.0-flash-lite', 'gemini-1.5-flash', 'gemini-1.5-flash-8b']) {
        const r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey}`,
          {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
              system_instruction: { parts: [{ text: system }] },
              contents,
              generationConfig:   { maxOutputTokens: 400, temperature: 0.3 }
            })
          }
        );
        if (r.ok) {
          const d = await r.json();
          const t = d?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
          if (t) return t.length > 1500 ? t.slice(0, 1497) + '…' : t;
        }
        if (r.status === 401 || r.status === 403) break;
      }
    }
  } catch (err) {
    console.error(JSON.stringify({ event: 'ai_error', error: String(err), ts: new Date().toISOString() }));
  }
  return null;
}

async function _notifyOwner(aiReply, customerFrom, customerName, storeName, sid, token, notifyFromUrl = '') {
  const from     = process.env.TWILIO_FROM;
  const ownerNum = notifyFromUrl || process.env.OWNER_WHATSAPP;
  if (!sid || !token || !from || !ownerNum) return;

  const orderLine = (aiReply.match(/ORDER ALERT:(.*)/i) || [])[1]?.trim() || 'New order';
  const body = `🛒 *New Order — ${storeName}*\n${orderLine}\nFrom: ${customerName || customerFrom}`;
  const to   = ownerNum.startsWith('whatsapp:') ? ownerNum : 'whatsapp:' + ownerNum;
  const auth = 'Basic ' + Buffer.from(sid + ':' + token).toString('base64');

  await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
    method:  'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({ From: from, To: to, Body: body }).toString()
  });
}

async function _handlePaymentAlert(orderLine, customerFrom, customerName, storeName, sid, token, notifyFromUrl, riderEmails) {
  const alertLine = (typeof orderLine === 'string' ? orderLine : '') || 'Payment received';

  // Store order in Blob
  const blobToken  = process.env.BLOB_READ_WRITE_TOKEN;
  const blobBase   = (process.env.PRODUCTS_BLOB_URL || '').replace('iflow-products.json', '');
  if (blobToken && blobBase) {
    const ordersUrl = blobBase + 'iflow-orders.json';
    let orders = [];
    try {
      const r = await fetch(ordersUrl, { cache: 'no-store' });
      if (r.ok) orders = await r.json();
    } catch {}
    if (!Array.isArray(orders)) orders = [];
    // Dedup: skip only if this customer sent a payment_proof in the last 10 minutes
    // (prevents double-alerts from accidental double-sends, but allows new orders hours later)
    const tenMinsAgo = Date.now() - 10 * 60 * 1000;
    if (orders.some(o => o.customerNum === customerFrom && o.status === 'payment_proof'
        && new Date(o.createdAt).getTime() > tenMinsAgo)) return;
    orders.push({
      id:           'order_' + Date.now(),
      customerNum:  customerFrom,
      customerName: customerName || customerFrom,
      details:      alertLine,
      status:       'payment_proof',
      riderEmails:  riderEmails,
      createdAt:    new Date().toISOString()
    });
    await put('iflow-orders.json', JSON.stringify(orders), {
      access: 'public', token: blobToken,
      contentType: 'application/json', addRandomSuffix: false
    }).catch(() => {});
  }

  // Notify owner via WhatsApp
  const from     = process.env.TWILIO_FROM;
  const ownerNum = notifyFromUrl || process.env.OWNER_WHATSAPP;
  if (!sid || !token || !from || !ownerNum) return;

  const body = `💰 *Payment Proof — ${storeName}*\n${alertLine}\nFrom: ${customerName || customerFrom}\n\nOpen iFlow to verify & confirm.`;
  const to   = ownerNum.startsWith('whatsapp:') ? ownerNum : 'whatsapp:' + ownerNum;
  const auth = 'Basic ' + Buffer.from(sid + ':' + token).toString('base64');
  await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
    method:  'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({ From: from, To: to, Body: body }).toString()
  }).catch(() => {});
}

async function _saveAlert(type, summary, customerFrom, customerName, sid, token, notifyFromUrl) {
  const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
  const blobBase  = (process.env.PRODUCTS_BLOB_URL || '').replace('iflow-products.json', '');
  if (blobToken && blobBase) {
    const ordersUrl = blobBase + 'iflow-orders.json';
    let orders = [];
    try {
      const r = await fetch(ordersUrl, { cache: 'no-store' });
      if (r.ok) orders = await r.json();
    } catch {}
    if (!Array.isArray(orders)) orders = [];
    // Dedup: skip if same customer already has same type alert in last 5 mins
    const fiveMinsAgo = Date.now() - 5 * 60 * 1000;
    if (orders.some(o => o.customerNum === customerFrom && o.type === type && o.status === 'pending'
        && new Date(o.createdAt).getTime() > fiveMinsAgo)) return;
    orders.push({
      id:           type + '_' + Date.now(),
      type,
      customerNum:  customerFrom,
      customerName: customerName || customerFrom,
      details:      summary,
      status:       'pending',
      createdAt:    new Date().toISOString()
    });
    await put('iflow-orders.json', JSON.stringify(orders), {
      access: 'public', token: blobToken,
      contentType: 'application/json', addRandomSuffix: false
    }).catch(() => {});
  }

  // WhatsApp notification to owner
  const from     = process.env.TWILIO_FROM;
  const ownerNum = notifyFromUrl || process.env.OWNER_WHATSAPP;
  if (!sid || !token || !from || !ownerNum) return;
  const emojis   = { complaint: '⚠️', negotiation: '🔥' };
  const labels   = { complaint: 'Customer Complaint', negotiation: 'Price Standoff' };
  const emoji    = emojis[type] || '📣';
  const label    = labels[type] || 'Alert';
  const storeName = process.env.STORE_NAME || 'your store';
  const body = `${emoji} *${label} — ${storeName}*\n${summary}\nFrom: ${customerName || customerFrom}\n\nCheck iFlow for details.`;
  const to   = ownerNum.startsWith('whatsapp:') ? ownerNum : 'whatsapp:' + ownerNum;
  const auth = 'Basic ' + Buffer.from(sid + ':' + token).toString('base64');
  await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
    method:  'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({ From: from, To: to, Body: body }).toString()
  }).catch(() => {});
}

function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Fetch live data from Vercel Blob: products ctx string, paymentInfo, riderEmails.
 */
async function _fetchBlobData() {
  const url = process.env.PRODUCTS_BLOB_URL;
  if (!url) return { ctx: '', paymentInfo: {}, riderEmails: [] };
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) return { ctx: '', paymentInfo: {}, riderEmails: [] };
    const data = await r.json();
    const prods = Array.isArray(data) ? data : (data.products || []);
    const paymentInfo = data.paymentInfo || {};
    const riderEmails    = Array.isArray(data.riderEmails) ? data.riderEmails : [];
    const negotiationPct   = typeof data.negotiationPct === 'number' ? data.negotiationPct : null;
    const loyalDiscountOn  = !!data.loyalDiscountOn;
    const loyalDiscountAmt = data.loyalDiscountAmt  || 0;
    const loyalDiscountType = data.loyalDiscountType || 'pct';
    const ctx = prods.map(p => {
      const price = p.unitPrice ? ' (₦' + p.unitPrice + ')' : (p.price ? ' (₦' + p.price + ')' : '');
      const qty   = p.stockQty !== undefined ? p.stockQty : (p.qty !== undefined ? p.qty : null);
      const stock = qty !== null ? ' [stock:' + qty + ']' : '';
      const cond  = p.condition ? ' [condition:' + p.condition + ']' : '';
      const disc  = p.discount  ? (p.discountType === 'amt' ? ' [discount:₦' + p.discount + ' off]' : ' [discount:' + p.discount + '% off]') : '';
      return (p.name || '') + price + stock + cond + disc;
    }).filter(Boolean).join(', ');
    return { ctx, paymentInfo, riderEmails, negotiationPct, loyalDiscountOn, loyalDiscountAmt, loyalDiscountType };
  } catch {
    return { ctx: '', paymentInfo: {}, riderEmails: [], negotiationPct: null, loyalDiscountOn: false, loyalDiscountAmt: 0, loyalDiscountType: 'pct' };
  }
}
