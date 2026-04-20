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
  const looksLikePaymentProof = /\b(paid|payment|transferred|sent money|done|receipt|proof|screenshot|transfer|deposited|i've paid|i have paid|check it|already paid|i don pay|i done pay|i send am|e don done|money don enter|i dey come pick|i'll pick it up|coming to pick|pick it up|picking up|on my way|i dey road|i dey come|collecting it|self pickup|will pick up|come get it)\b/i.test(Body);
  const hasActiveOrderInMemory = history.some(m =>
    /ORDER ALERT:|Got it.*✅|delivery address|please pay|make payment/i.test(m.content)
  );
  const serverDetectedPayment = looksLikePaymentProof && hasActiveOrderInMemory;

  if (apiKey && Body.trim()) {
    let aiReply = await _callAi(Body, ProfileName, storeName, apiKey, productCtx, history, paymentInfo);

    // Guard: if AI greeted on a non-greeting message, retry with explicit nudge
    if (aiReply && !isPureGreeting && /^Hi[!,]?\s+How can I help/i.test(aiReply.trim())) {
      const nudge = history.length
        ? `[System: The customer just said "${Body}". This continues the conversation — do NOT greet. Respond in context.]`
        : `[System: "${Body}" is not a greeting. Ask what they need help with.]`;
      aiReply = await _callAi(nudge + '\n' + Body, ProfileName, storeName, apiKey, productCtx, history, paymentInfo) || aiReply;
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
    // Drop messages older than TTL, keep last 16
    const cutoff = Date.now() - CHAT_TTL_MS;
    return data
      .filter(m => !m.ts || new Date(m.ts).getTime() > cutoff)
      .slice(-16)
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
`Your name is Nova. You are the sharp, warm sales assistant for *${storeName}* on WhatsApp.
${productSection}
${paymentSection}

Style:
- Sound human. Friendly but direct. Nigerian English / Naija pidgin fine.
- Max 3-4 sentences. No filler, no "let me check", no "I'll confirm".
- Only greet ("Hi! How can I help?") when the message is PURELY a greeting word — Hi / Hello / Hey / Good morning. Nothing else ever triggers a greeting.

Product matching — fuzzy, not exact:
- Match customer requests even with typos, missing words, bad spelling (e.g. "iphone 13pro", "i phone 13 pro", "13pro black").
- If the EXACT product isn't in the catalogue but a very close variant exists, say: "We don't have [exact request], but we do have [closest match] at [price] — would that work?"
- Only say something is unavailable if there's genuinely nothing close in the catalogue.

Condition awareness — IMPORTANT:
- Some products have [condition:...] tags showing defects (cracked screen, battery health %, UK/US used, etc.).
- Do NOT confuse conditions with variants — conditions are defects or usage history, not colour/storage differences.
- ALWAYS disclose conditions honestly when recommending a defective product: "We have iPhone 13 at ₦180k — note it has a cracked screen. Still interested?"
- Battery health below 80% = significant, always mention it. Above 90% = minor, still mention briefly.
- If a customer asks about a phone's condition, tell them exactly what [condition:...] says.

One-shot intelligence — IMPORTANT:
- A customer may pack item + qty + address into ONE message, no commas, bad spelling (e.g. "i want 2 iphone 13pro black deliver to kuduru new transformer").
- Extract everything you can from a single message. If you have item + qty + address, confirm the order IMMEDIATELY — no back-and-forth questions.
- Only ask for what is genuinely missing. Ask one thing at a time.

Conversation memory — CRITICAL:
- Read ALL conversation history before responding.
- Product identity: when history shows an item was already agreed, use THAT EXACT ITEM — never swap it for something else from the catalogue.
- If the current message is an address and history has an ongoing order, proceed to confirm — do NOT greet or start over.
- History tells you WHAT the customer wants. The catalogue tells you IF it's available and at what PRICE.

Order flow (skip steps already done):
1. Identify item + qty — from this message or history.
2. If address is missing, ask once.
3. Once item + qty + address confirmed:
   "Got it! ✅ [item] x[qty] → [address]."
   Append on new line: ORDER ALERT: ${name || 'Customer'} | [item] x[qty] | Address: [address]
${hasPayment ? `4. In the same message after confirming, send:
   "Please pay ₦[price×qty] to:\\n*Bank:* ${paymentInfo.bank}\\n*Acct No:* ${paymentInfo.accountNumber}\\n*Name:* ${paymentInfo.accountName || storeName}\\n\\nSend a screenshot or type *Paid* when done. 🙏"` : ''}

Payment proof — when customer says paid / sends receipt / says done/transferred:
Reply: "Got it! 🙏 Payment received — our team is verifying now, you'll hear from us shortly."
Append on new line: PAYMENT ALERT: ${name || 'Customer'} | [item from history] x[qty] | Address: [address from history]`;

  // Inject a reminder at the top of history so old corrupted messages don't override catalogue
  const systemReminder = {
    role: 'user',
    content: '[System note: The product catalogue in the system prompt is always current and correct. Do not use any product availability or price information from earlier in this conversation — use only the catalogue.]'
  };
  const assistantAck = { role: 'assistant', content: 'Understood.' };
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
