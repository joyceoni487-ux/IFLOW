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

  const productCtx  = blobData.ctx || ctxFromUrl || (process.env.PRODUCTS_JSON || '');
  const paymentInfo = blobData.paymentInfo || {};
  const riderEmails = blobData.riderEmails || [];

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
  const hasActiveOrderInMemory = history.some(m =>
    /ORDER ALERT:|Got it.*✅|delivery address|please pay|make payment/i.test(m.content)
  );
  const serverDetectedPayment = looksLikePaymentProof && hasActiveOrderInMemory;

  if (apiKey && Body.trim()) {
    // If this looks like a short variant/colour selection and the previous assistant message
    // was listing options, inject that context explicitly so the AI can't confuse products.
    const lastAssistantMsg = history.filter(m => m.role === 'assistant').pop();
    const bodyWordCount = Body.trim().split(/\s+/).length;
    const looksLikeSelection = bodyWordCount <= 8 &&
      /\b(green|black|white|red|blue|gold|silver|first|second|third|one|two|three|1st|2nd|3rd|the one|that one|this one|option\s*\d|smaller|bigger|cheaper|expensive|that|this)\b/i.test(Body);
    const lastMsgOfferedOptions = lastAssistantMsg &&
      /which (one|would you|do you)|two options|both options|we have.*and.*which|option 1|option 2|\bor\b.*\bwhich\b/i.test(lastAssistantMsg.content);

    let messageToAi = Body;
    if (looksLikeSelection && lastMsgOfferedOptions) {
      messageToAi = `[Context: I just offered these options to the customer: "${lastAssistantMsg.content.slice(0, 300)}". The customer is now choosing from that list.]\nCustomer message: ${Body}`;
    }

    let aiReply = await _callAi(messageToAi, ProfileName, storeName, apiKey, productCtx, history, paymentInfo);

    // Guard: if AI greeted on a non-greeting message, retry with explicit nudge
    if (aiReply && !isPureGreeting && /^Hi[!,]?\s+How can I help/i.test(aiReply.trim())) {
      const nudge = history.length
        ? `[System: The customer just said "${Body}". This continues the conversation — do NOT greet. Respond in context.]`
        : `[System: "${Body}" is not a greeting. Ask what they need help with.]`;
      aiReply = await _callAi(nudge + '\n' + Body, ProfileName, storeName, apiKey, productCtx, history, paymentInfo) || aiReply;
    }

    // Guard: if AI triggered "payment received" but no ORDER has been placed yet, correct it
    const aiClaimsPayment = aiReply && /payment received|our team is verifying|PAYMENT ALERT:/i.test(aiReply);
    if (aiClaimsPayment && !hasActiveOrderInMemory) {
      const correction = `[System: CORRECTION — no order has been placed yet in this conversation. "${Body}" is a purchase confirmation ("yes/ok/sure"), NOT payment. The customer wants to buy but hasn't paid. You must ask for their delivery address next. Do NOT say payment received.]`;
      aiReply = await _callAi(correction + '\n' + Body, ProfileName, storeName, apiKey, productCtx, history, paymentInfo) || aiReply;
    }

    // Guard: if AI says "no order placed" or "need to choose" but history shows an active ORDER, correct it
    const aiConfusedAboutOrder = aiReply && /haven.t ordered|no order.*placed|need to (choose|select|pick|decide)|still need to (choose|select)|you haven.t (placed|made|selected)/i.test(aiReply);
    if (aiConfusedAboutOrder && hasActiveOrderInMemory) {
      const lastOrder = history.filter(m => /ORDER ALERT:/i.test(m.content)).pop();
      const orderCtx = lastOrder ? lastOrder.content.slice(0, 300) : 'See history for confirmed order';
      const fix = `[System: CORRECTION — an order WAS confirmed earlier in this conversation. Do NOT ask the customer to choose again. Confirmed order evidence from history: "${orderCtx}". The customer's current message is: "${Body}". Respond appropriately to this — if they said they paid, confirm payment received.]`;
      aiReply = await _callAi(fix + '\n' + Body, ProfileName, storeName, apiKey, productCtx, history, paymentInfo) || aiReply;
    }

    if (aiReply) {
      const sid   = process.env.TWILIO_SID   || '';
      const token = process.env.TWILIO_TOKEN || '';

      if (/ORDER ALERT:/i.test(aiReply)) {
        _notifyOwner(aiReply, From, ProfileName, storeName, sid, token, notifyNum).catch(() => {});
      }

      // Trigger payment alert if AI detected it OR server-side detection fired
      if (/PAYMENT ALERT:/i.test(aiReply) || serverDetectedPayment) {
        // Build alert line from AI reply or extract from history
        const alertFromAi = (aiReply.match(/PAYMENT ALERT:(.*)/i) || [])[1]?.trim();
        const orderFromHistory = history.filter(m => /ORDER ALERT:/i.test(m.content)).pop();
        const orderLine = alertFromAi
          || (orderFromHistory ? (orderFromHistory.content.match(/ORDER ALERT:(.*)/i) || [])[1]?.trim() : null)
          || `${ProfileName || 'Customer'} | details in conversation`;
        _handlePaymentAlert(orderLine, From, ProfileName, storeName, sid, token, notifyNum, riderEmails).catch(() => {});
      }

      const customerReply = aiReply
        .replace(/\n?ORDER ALERT:.*$/im, '')
        .replace(/\n?PAYMENT ALERT:.*$/im, '')
        .trim();

      // Save full aiReply (ORDER ALERT preserved) so payment fallback can find order details
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

async function _callAi(message, name, storeName, apiKey, productCtx = '', history = [], paymentInfo = {}) {
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
- If history shows a completed ORDER ALERT for an item, that order is DONE. Do not ask the customer to re-select or re-confirm it.

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
    // Dedup: skip if this customer already has a pending payment_proof order
    if (orders.some(o => o.customerNum === customerFrom && o.status === 'payment_proof')) return;
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
    const riderEmails = Array.isArray(data.riderEmails) ? data.riderEmails : [];
    const ctx = prods.map(p => {
      const price = p.unitPrice ? ' (₦' + p.unitPrice + ')' : (p.price ? ' (₦' + p.price + ')' : '');
      const qty   = p.stockQty !== undefined ? p.stockQty : (p.qty !== undefined ? p.qty : null);
      const stock = qty !== null ? ' [stock:' + qty + ']' : '';
      const cond  = p.condition ? ' [condition:' + p.condition + ']' : '';
      return (p.name || '') + price + stock + cond;
    }).filter(Boolean).join(', ');
    return { ctx, paymentInfo, riderEmails };
  } catch {
    return { ctx: '', paymentInfo: {}, riderEmails: [] };
  }
}
