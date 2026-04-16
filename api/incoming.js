/**
 * Twilio Incoming Message Handler — AI-powered WhatsApp replies.
 *
 * URL params (set automatically by iFlow Settings):
 *   ?generic=0  — disable the generic fallback message
 *   ?reply=0    — disable ALL replies
 *
 * Vercel Environment Variables:
 *   GROQ_API_KEY     — Groq API key (gsk_...) — AI replies
 *   GEMINI_API_KEY   — Gemini key as fallback
 *   STORE_NAME       — store name in replies (e.g. "Joyce's Boutique")
 *   PRODUCTS_JSON    — product list: "iPhone 15 (₦150000), Bags (₦5000), ..."
 *   OWNER_WHATSAPP   — store owner's WhatsApp e.g. "+2348012345678" (order alerts)
 *   TWILIO_SID       — Twilio Account SID  (enables conversation memory + order alerts)
 *   TWILIO_TOKEN     — Twilio Auth Token   (enables conversation memory + order alerts)
 *   TWILIO_FROM      — Twilio WhatsApp sender e.g. "whatsapp:+14155238886"
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).end('Method Not Allowed');
  }

  const {
    From        = '',
    To          = '',   // our Twilio number — used to fetch conversation history
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

  // Product context: URL ?ctx= param takes priority, then PRODUCTS_JSON env var
  const ctxFromUrl = req.query?.ctx ? decodeURIComponent(req.query.ctx) : '';
  const productCtx = ctxFromUrl || (process.env.PRODUCTS_JSON || '');

  // Fetch last 8 messages between this customer and the store for context.
  // Runs in parallel with other setup so it doesn't add net latency.
  const historyPromise = (sid && token && From && To)
    ? _getConversationHistory(From, To, sid, token, 8)
    : Promise.resolve([]);

  console.log(JSON.stringify({
    event: 'twilio_incoming', sid: MessageSid, from: From,
    name: ProfileName, body: Body.slice(0, 200),
    media: parseInt(NumMedia, 10) > 0,
    provider: apiKey.startsWith('gsk_') ? 'groq' : apiKey ? 'gemini' : 'none',
    hasProducts: !!productCtx, hasHistory: !!(sid && token),
    genericOn, ts: new Date().toISOString()
  }));

  res.setHeader('Content-Type', 'text/xml');
  if (allOff) return res.status(200).send('<Response></Response>');

  if (apiKey && Body.trim()) {
    const history  = await historyPromise;
    const aiReply  = await _callAi(Body, ProfileName, storeName, apiKey, productCtx, history);
    if (aiReply) {
      if (/ORDER ALERT:/i.test(aiReply)) {
        const notifyNum = req.query?.notify ? decodeURIComponent(req.query.notify) : '';
        _notifyOwner(aiReply, From, ProfileName, storeName, sid, token, notifyNum).catch(() => {});
      }
      const customerReply = aiReply.replace(/\n?ORDER ALERT:.*$/im, '').trim();
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
 * Fetch the last `limit` messages in this conversation from Twilio's history.
 * Returns OpenAI-format messages: [{role:"user"|"assistant", content:"..."}]
 */
async function _getConversationHistory(customerNum, ourNum, sid, token, limit = 8) {
  try {
    const auth = 'Basic ' + Buffer.from(sid + ':' + token).toString('base64');
    const base = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`;
    // Fetch inbound (customer→us) and outbound (us→customer) in parallel
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
    // Merge, sort oldest→newest, exclude the very last message (that's the current one)
    const all = [
      ...(inData.messages  || []).map(m => ({ ...m, role: 'user' })),
      ...(outData.messages || []).map(m => ({ ...m, role: 'assistant' }))
    ];
    all.sort((a, b) => new Date(a.date_sent) - new Date(b.date_sent));
    // Drop the most recent message (the one we're currently handling)
    const history = all.slice(0, -1).slice(-(limit - 1));
    return history.map(m => ({
      role:    m.role,
      content: (m.body || '').replace(/\n?ORDER ALERT:.*$/im, '').trim()
    }));
  } catch (e) {
    return [];
  }
}

async function _callAi(message, name, storeName, apiKey, productCtx = '', history = []) {
  const productSection = productCtx
    ? `\nProducts in stock:\n${productCtx}\n\nList them directly when asked — never say you'll check.`
    : `\nYou don't have the product list. Ask what specific item the customer wants.`;

  const system =
`Your name is Alex. You are a helpful AI assistant for *${storeName}* on WhatsApp.
${productSection}

Rules:
- Answer directly. No preamble. No filler words.
- Greetings: ONE sentence only — "Hi! What can I help you with?" — then stop.
- Be concise. 1-3 sentences max.
- Never invent prices — say you'll confirm.
- You understand Nigerian English perfectly.
- If asked if you're human: say you're an AI assistant for the store.

Order handling — when a customer wants to buy or order anything:
1. Confirm item and quantity from the conversation.
2. If delivery address is missing, ask for it.
3. Once you have item + qty + address, reply: "Order noted ✓ — [item] x[qty]. We'll reach out shortly to confirm payment and delivery."
4. Append on a new line: ORDER ALERT: ${name || 'Customer'} | [item] x[qty] | Address: [address]`;

  // Build message list: system + conversation history + current message
  const userMessages = [
    ...history,
    { role: 'user', content: message }
  ];

  try {
    if (apiKey.startsWith('gsk_')) {
      for (const model of ['llama-3.3-70b-versatile', 'llama-3.1-70b-versatile', 'llama-3.1-8b-instant']) {
        const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
          body:    JSON.stringify({
            model,
            messages:    [{ role: 'system', content: system }, ...userMessages],
            max_tokens:  300,
            temperature: 0.6
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
      // Gemini: convert history to Gemini format
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
              generationConfig:   { maxOutputTokens: 300, temperature: 0.6 }
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

/**
 * Send an order alert to the store owner's WhatsApp.
 * Requires: TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM, OWNER_WHATSAPP
 */
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

function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
