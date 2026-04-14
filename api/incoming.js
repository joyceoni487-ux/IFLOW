/**
 * Twilio Incoming Message Handler — AI-powered WhatsApp replies.
 *
 * URL params (set automatically by iFlow Settings):
 *   ?generic=0  — disable the generic fallback message
 *   ?generic=1  — enable generic fallback (default)
 *   ?reply=0    — disable ALL replies (all off)
 *
 * Vercel Environment Variables:
 *   GROQ_API_KEY     — Groq API key (gsk_...) — AI replies
 *   GEMINI_API_KEY   — Gemini key as fallback
 *   STORE_NAME       — store name in replies (e.g. "Joyce's Boutique")
 *   PRODUCTS_JSON    — product list: "iPhone 15 (₦150000), Bags (₦5000), ..."
 *   OWNER_WHATSAPP   — store owner's WhatsApp number e.g. "+2348012345678"
 *                      (receives order alerts when a customer places an order)
 *   TWILIO_SID       — Twilio Account SID (for sending owner alerts)
 *   TWILIO_TOKEN     — Twilio Auth Token (for sending owner alerts)
 *   TWILIO_FROM      — Twilio WhatsApp sender e.g. "whatsapp:+14155238886"
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).end('Method Not Allowed');
  }

  const {
    From        = '',
    Body        = '',
    ProfileName = '',
    MessageSid  = '',
    NumMedia    = '0'
  } = req.body || {};

  const allOff    = req.query?.reply   === '0';
  const genericOn = req.query?.generic !== '0';   // default ON
  const storeName = process.env.STORE_NAME || 'our store';
  const apiKey    = process.env.GROQ_API_KEY || process.env.GEMINI_API_KEY || '';
  // Product context: URL ?ctx= param (auto-built by iFlow Settings) takes priority;
  // falls back to PRODUCTS_JSON env var set once in Vercel dashboard.
  const ctxFromUrl = req.query?.ctx ? decodeURIComponent(req.query.ctx) : '';
  const productCtx = ctxFromUrl || (process.env.PRODUCTS_JSON || '');

  console.log(JSON.stringify({
    event:    'twilio_incoming',
    sid:      MessageSid,
    from:     From,
    name:     ProfileName,
    body:     Body.slice(0, 200),
    media:    parseInt(NumMedia, 10) > 0,
    provider: apiKey.startsWith('gsk_') ? 'groq' : apiKey ? 'gemini' : 'none',
    hasProducts: !!productCtx,
    genericOn,
    ts:       new Date().toISOString()
  }));

  res.setHeader('Content-Type', 'text/xml');

  // Everything off
  if (allOff) return res.status(200).send('<Response></Response>');

  // Try AI first if key is configured
  if (apiKey && Body.trim()) {
    const aiReply = await _callAi(Body, ProfileName, storeName, apiKey, productCtx);
    if (aiReply) {
      // Detect order alert and notify store owner if configured
      if (/ORDER ALERT:/i.test(aiReply)) {
        _notifyOwner(aiReply, From, ProfileName, storeName).catch(() => {});
      }
      // Strip internal ORDER ALERT line before sending to customer
      const customerReply = aiReply.replace(/\n?ORDER ALERT:.*$/im, '').trim();
      return res.status(200).send(`<Response><Message>${escapeXml(customerReply)}</Message></Response>`);
    }
    // AI failed — fall through to generic if enabled, else silent
  }

  // Generic fallback
  if (genericOn) {
    const msg = ProfileName
      ? `Hi ${ProfileName}! Thanks for reaching out to *${storeName}*. We'll get back to you shortly 🙏`
      : `Hi! Thanks for reaching out to *${storeName}*. We'll be with you shortly 🙏`;
    return res.status(200).send(`<Response><Message>${escapeXml(msg)}</Message></Response>`);
  }

  // Silent — just acknowledge Twilio
  res.status(200).send('<Response></Response>');
}

async function _callAi(message, name, storeName, apiKey, productCtx = '') {
  const productSection = productCtx
    ? `\nCurrent products in stock:\n${productCtx}\n\nWhen asked what products are available, list them from this list directly — do not say you'll check.`
    : `\nYou don't have the inventory list. If a customer asks what you have, ask what specific item or category they're looking for.`;

  const system =
`Your name is Alex. You are a sharp, helpful AI assistant for *${storeName}*, responding to customer WhatsApp messages.
${productSection}

Rules:
- Answer directly. No preamble, no filler phrases — just the answer.
- Greetings (hi, hello, good morning, etc.): ONE sentence only — e.g. "Hi! What can I help you with?" Then stop. Do NOT elaborate.
- Be concise — WhatsApp. 1-3 sentences max unless an order needs detail.
- Never invent prices you don't know — say you'll confirm.
- You understand Nigerian English and accents perfectly.
- If asked if you're human, say you're an AI assistant for the store.
- NEVER sign off with the store name.

Order handling — when a customer wants to buy, order, or receive a product:
1. Confirm item and quantity.
2. If no delivery address given, ask for it.
3. Once you have item + quantity + address: reply "Order noted ✓ — [item] x[qty]. We'll reach out shortly to confirm payment and delivery."
4. On that same reply, add a new line (invisible to conversation flow): ORDER ALERT: ${name || 'Customer'} | [item] x[qty] | Address: [address]`;

  try {
    if (apiKey.startsWith('gsk_')) {
      // Groq (preferred)
      for (const model of ['llama-3.3-70b-versatile', 'llama-3.1-70b-versatile', 'llama-3.1-8b-instant']) {
        const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
          body:    JSON.stringify({
            model,
            messages:    [{ role: 'system', content: system }, { role: 'user', content: message }],
            max_tokens:  300,
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
      // Gemini
      for (const m of ['gemini-2.0-flash-lite', 'gemini-1.5-flash', 'gemini-1.5-flash-8b']) {
        const r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey}`,
          {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
              system_instruction: { parts: [{ text: system }] },
              contents:           [{ role: 'user', parts: [{ text: message }] }],
              generationConfig:   { maxOutputTokens: 300, temperature: 0.65 }
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
  return null; // AI failed
}

/**
 * Send an order alert to the store owner's WhatsApp number.
 * Requires env vars: TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM, OWNER_WHATSAPP
 */
async function _notifyOwner(aiReply, customerFrom, customerName, storeName) {
  const sid      = process.env.TWILIO_SID;
  const token    = process.env.TWILIO_TOKEN;
  const from     = process.env.TWILIO_FROM;      // e.g. "whatsapp:+14155238886"
  const ownerNum = process.env.OWNER_WHATSAPP;   // e.g. "+2348012345678"
  if (!sid || !token || !from || !ownerNum) return;

  const orderLine = (aiReply.match(/ORDER ALERT:(.*)/i) || [])[1]?.trim() || 'New order';
  const body = `🛒 *New Order — ${storeName}*\n${orderLine}\nFrom: ${customerName || customerFrom}`;

  const to = ownerNum.startsWith('whatsapp:') ? ownerNum : 'whatsapp:' + ownerNum;
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
