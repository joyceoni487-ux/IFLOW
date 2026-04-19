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
 *   BLOB_READ_WRITE_TOKEN — Vercel Blob token (for storing orders)
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
  const sid       = process.env.TWILIO_SID   || '';
  const token     = process.env.TWILIO_TOKEN || '';
  const notifyNum = req.query?.notify ? decodeURIComponent(req.query.notify) : '';

  // Fetch Blob data (live products + payment info + rider emails) in parallel with history
  const ctxFromUrl  = req.query?.ctx ? decodeURIComponent(req.query.ctx) : '';
  const blobPromise = _fetchBlobData();
  const historyPromise = (sid && token && From && To)
    ? _getConversationHistory(From, To, sid, token, 10)
    : Promise.resolve([]);

  const [blobData, history] = await Promise.all([blobPromise, historyPromise]);

  const productCtx  = blobData.ctx || ctxFromUrl || (process.env.PRODUCTS_JSON || '');
  const paymentInfo = blobData.paymentInfo || {};
  const riderEmails = blobData.riderEmails || [];

  console.log(JSON.stringify({
    event: 'twilio_incoming', sid: MessageSid, from: From,
    name: ProfileName, body: Body.slice(0, 200),
    media: parseInt(NumMedia, 10) > 0,
    provider: apiKey.startsWith('gsk_') ? 'groq' : apiKey ? 'gemini' : 'none',
    hasProducts: !!productCtx, hasPayment: !!(paymentInfo.bank),
    historyCount: history.length, ts: new Date().toISOString()
  }));

  res.setHeader('Content-Type', 'text/xml');
  if (allOff) return res.status(200).send('<Response></Response>');

  // If the message is NOT a pure greeting but the AI returns a greeting response, retry with a stronger hint
  const isPureGreeting = /^\s*(hi|hello|hey|sup|howdy|good\s*(morning|afternoon|evening))\s*[!?.]?\s*$/i.test(Body);

  if (apiKey && Body.trim()) {
    let aiReply = await _callAi(Body, ProfileName, storeName, apiKey, productCtx, history, paymentInfo);

    // Guard: if AI greeted on a non-greeting message, retry with an explicit nudge
    if (aiReply && !isPureGreeting && /^Hi[!,]?\s+How can I help/i.test(aiReply.trim())) {
      const nudge = history.length
        ? `[System: The customer just said "${Body}". This is NOT a greeting — it continues the conversation above. Do NOT greet. Respond based on the conversation history.]`
        : `[System: The customer said "${Body}". This is not a greeting. Ask what they'd like to order or how you can help with a specific question.]`;
      aiReply = await _callAi(nudge + ' ' + Body, ProfileName, storeName, apiKey, productCtx, history, paymentInfo) || aiReply;
    }

    if (aiReply) {
      if (/ORDER ALERT:/i.test(aiReply)) {
        _notifyOwner(aiReply, From, ProfileName, storeName, sid, token, notifyNum).catch(() => {});
      }
      if (/PAYMENT ALERT:/i.test(aiReply)) {
        _handlePaymentAlert(aiReply, From, ProfileName, storeName, sid, token, notifyNum, riderEmails).catch(() => {});
      }
      const customerReply = aiReply
        .replace(/\n?ORDER ALERT:.*$/im, '')
        .replace(/\n?PAYMENT ALERT:.*$/im, '')
        .trim();
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

/**
 * Fetch last `limit` messages in this conversation from Twilio.
 * Returns [{role:"user"|"assistant", content:"..."}] oldest→newest.
 */
async function _getConversationHistory(customerNum, ourNum, sid, token, limit = 10) {
  try {
    const auth = 'Basic ' + Buffer.from(sid + ':' + token).toString('base64');
    const base = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`;
    const [inRes, outRes] = await Promise.all([
      fetch(`${base}?From=${encodeURIComponent(customerNum)}&To=${encodeURIComponent(ourNum)}&PageSize=${limit}`,
        { headers: { Authorization: auth } }),
      fetch(`${base}?From=${encodeURIComponent(ourNum)}&To=${encodeURIComponent(customerNum)}&PageSize=${limit}`,
        { headers: { Authorization: auth } })
    ]);
    const [inData, outData] = await Promise.all([
      inRes.ok  ? inRes.json()  : { messages: [] },
      outRes.ok ? outRes.json() : { messages: [] }
    ]);
    const all = [
      ...(inData.messages  || []).map(m => ({ ...m, role: 'user' })),
      ...(outData.messages || []).map(m => ({ ...m, role: 'assistant' }))
    ];
    all.sort((a, b) => new Date(a.date_sent) - new Date(b.date_sent));
    const history = all.slice(0, -1).slice(-(limit - 1));
    return history.map(m => ({
      role:    m.role,
      content: (m.body || '')
        .replace(/\n?ORDER ALERT:.*$/im, '')
        .replace(/\n?PAYMENT ALERT:.*$/im, '')
        .trim()
    }));
  } catch {
    return [];
  }
}

async function _callAi(message, name, storeName, apiKey, productCtx = '', history = [], paymentInfo = {}) {
  const productSection = productCtx
    ? `\nProduct catalogue (name, price, stock):\n${productCtx}\n\n` +
      `Stock rules: If [stock:0] → OUT OF STOCK. If stock > 0 → AVAILABLE. ` +
      `State prices and availability directly — never say "I'll check".`
    : `\nNo product catalogue yet. Ask what the customer wants.`;

  const hasPayment = !!(paymentInfo.bank && paymentInfo.accountNumber);
  const paymentSection = hasPayment
    ? `\nPayment details (send to customer when they want to pay):\nBank: ${paymentInfo.bank}\nAccount No: ${paymentInfo.accountNumber}\nAccount Name: ${paymentInfo.accountName || storeName}`
    : '';

  const system =
`Your name is Nova. You are the warm, human-sounding sales assistant for *${storeName}* on WhatsApp.
${productSection}
${paymentSection}

Personality & style:
- Sound like a real, friendly sales rep — not a bot.
- Natural Nigerian English / Naija pidgin is totally fine.
- Keep replies short (2-4 sentences max).
- Never say "I'll check", "I'll confirm", or "let me verify". You have all the info.
- If asked if you're human: say you're Nova, the AI assistant.
- Greeting rule: ONLY reply "Hi! How can I help you today?" when the message is literally just one of these words alone: Hi, Hello, Hey, Good morning, Good afternoon, Good evening, Howdy, Sup. A message with ANY other content — a place name, product, number, sentence — is NEVER a greeting. Never.

Reading history — CRITICAL:
- Read the FULL conversation history before replying.
- If the customer already mentioned a product earlier, remember it — don't ask them to repeat.
- If they say "I want to order one" or "ship to this address", look back to find what item they discussed.
- If the current message looks like a place or address (e.g. "Kuduru, new transformer", "No 13 Kuje street", "Lagos Island") and a product order appears in the history — treat it as the delivery address. Do NOT greet. Proceed to confirm the order.
- If a message is short or seems out of context but history shows an ongoing order, connect the dots — don't start over.

Order flow — follow steps in order, skip what's already been given:
1. Confirm item + quantity (check history first — they may have already mentioned it).
2. If delivery address hasn't been given, ask for it. One question at a time.
3. Once you have item + qty + address, confirm:
   "Got it! ✅ [item] x[qty] to [address]."
   Append: ORDER ALERT: ${name || 'Customer'} | [item] x[qty] | Address: [address]
${hasPayment ? `4. Right after confirming the order, send payment details in the same message:
   "Please make payment to:\\n*Bank:* ${paymentInfo.bank}\\n*Account No:* ${paymentInfo.accountNumber}\\n*Account Name:* ${paymentInfo.accountName || storeName}\\n\\nSend a screenshot or type *Paid* once you've transferred. 🙏"` : ''}

Payment confirmation — when customer says they paid / sent money / shares receipt / says "done":
Reply: "Thank you! 🙏 We've got your payment notification — our team is verifying it now. We'll confirm shortly."
Append on a new line: PAYMENT ALERT: ${name || 'Customer'} | [item from history] x[qty] | Address: [address from history]`;

  const userMessages = [...history, { role: 'user', content: message }];

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
            temperature: 0.65
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
              generationConfig:   { maxOutputTokens: 400, temperature: 0.65 }
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

async function _handlePaymentAlert(aiReply, customerFrom, customerName, storeName, sid, token, notifyFromUrl, riderEmails) {
  const alertLine = (aiReply.match(/PAYMENT ALERT:(.*)/i) || [])[1]?.trim() || 'Payment received';

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
      return (p.name || '') + price + stock;
    }).filter(Boolean).join(', ');
    return { ctx, paymentInfo, riderEmails };
  } catch {
    return { ctx: '', paymentInfo: {}, riderEmails: [] };
  }
}
