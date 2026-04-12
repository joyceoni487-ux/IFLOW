/**
 * Twilio Incoming Message Handler — AI-powered WhatsApp replies via Gemini.
 *
 * Set as the "When a message comes in" URL in Twilio Sandbox settings.
 * iFlow Settings generates the correct URL automatically.
 *
 * Required Vercel Environment Variables:
 *   GEMINI_API_KEY  — your Google Gemini API key (enables AI replies)
 *   STORE_NAME      — your store name shown in fallback replies (optional)
 *
 * Without GEMINI_API_KEY, falls back to a polite generic auto-reply.
 * Set ?reply=0 in the URL to disable all auto-replies.
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

  // ?reply=0 disables auto-reply entirely (controlled from iFlow Settings toggle)
  const autoReply = req.query?.reply !== '0';
  const storeName = process.env.STORE_NAME || 'our store';
  const hasMedia  = parseInt(NumMedia, 10) > 0;

  console.log(JSON.stringify({
    event: 'twilio_incoming',
    sid:   MessageSid,
    from:  From,
    name:  ProfileName,
    body:  Body.slice(0, 200),
    media: hasMedia,
    ai:    !!process.env.GEMINI_API_KEY,
    ts:    new Date().toISOString()
  }));

  res.setHeader('Content-Type', 'text/xml');

  if (!autoReply) {
    return res.status(200).send('<Response></Response>');
  }

  // Try AI reply first, fall back to generic if key not set or call fails
  const replyText = await _getAiReply(Body, ProfileName, storeName);

  res.status(200).send(`<Response><Message>${escapeXml(replyText)}</Message></Response>`);
}

async function _getAiReply(message, name, storeName) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey || !message.trim()) {
    return name
      ? `Hi ${name}! Thanks for reaching out to *${storeName}*. We've received your message and will get back to you shortly 🙏`
      : `Hi! Thanks for reaching out to *${storeName}*. We'll be with you shortly 🙏`;
  }

  const systemPrompt = `Your name is Alex. You are a friendly and sharp AI assistant for *${storeName}*, a shop that sells products to customers.

You respond to customer WhatsApp messages on behalf of the store. Your job is to help with:
- Product questions and availability
- Pricing enquiries
- Order follow-ups
- General customer support

Rules:
- Be warm, concise, and professional — this is WhatsApp, not email
- Keep replies under 4 sentences unless more detail is truly needed
- Never make up specific prices or stock levels you don't know — say you'll confirm shortly
- Speak in clear, natural English. You understand Nigerian English and accents perfectly
- If a customer is rude or spammy, stay polite and redirect to the topic
- Sign off with the store name when appropriate: *${storeName}*
- Never claim to be human if directly asked`;

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
    const body = {
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: message }] }],
      generationConfig: { maxOutputTokens: 300, temperature: 0.7 }
    };

    const r = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body)
    });

    if (!r.ok) throw new Error(`Gemini ${r.status}`);

    const data = await r.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

    if (!text) throw new Error('empty response');

    // WhatsApp max message length safety cap
    return text.length > 1500 ? text.slice(0, 1497) + '…' : text;

  } catch (err) {
    console.error(JSON.stringify({ event: 'gemini_error', error: String(err), ts: new Date().toISOString() }));
    // Graceful fallback — customer still gets a reply
    return name
      ? `Hi ${name}! Thanks for your message to *${storeName}*. We'll get back to you shortly 🙏`
      : `Hi! Thanks for reaching out to *${storeName}*. We'll be with you shortly 🙏`;
  }
}

function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
