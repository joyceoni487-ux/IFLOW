/**
 * Twilio Incoming Message Handler — AI-powered WhatsApp replies via Groq / Gemini.
 *
 * Set as the "When a message comes in" URL in Twilio Sandbox settings.
 * iFlow Settings generates the correct URL automatically.
 *
 * Required Vercel Environment Variables:
 *   GROQ_API_KEY   — Groq API key (starts with gsk_) — preferred
 *   GEMINI_API_KEY — Gemini API key (fallback if no Groq key)
 *   STORE_NAME     — your store name shown in replies (optional)
 *
 * Without any AI key, falls back to a polite generic auto-reply.
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
  const apiKey    = process.env.GROQ_API_KEY || process.env.GEMINI_API_KEY || '';

  console.log(JSON.stringify({
    event:    'twilio_incoming',
    sid:      MessageSid,
    from:     From,
    name:     ProfileName,
    body:     Body.slice(0, 200),
    media:    hasMedia,
    provider: apiKey.startsWith('gsk_') ? 'groq' : apiKey ? 'gemini' : 'none',
    ts:       new Date().toISOString()
  }));

  res.setHeader('Content-Type', 'text/xml');

  if (!autoReply) {
    return res.status(200).send('<Response></Response>');
  }

  const replyText = await _getAiReply(Body, ProfileName, storeName, apiKey);
  res.status(200).send(`<Response><Message>${escapeXml(replyText)}</Message></Response>`);
}

async function _getAiReply(message, name, storeName, apiKey) {
  const fallback = name
    ? `Hi ${name}! Thanks for reaching out to *${storeName}*. We've received your message and will get back to you shortly 🙏`
    : `Hi! Thanks for reaching out to *${storeName}*. We'll be with you shortly 🙏`;

  if (!apiKey || !message.trim()) return fallback;

  const systemPrompt =
`Your name is Alex. You are a friendly and sharp AI assistant for *${storeName}*, helping customers over WhatsApp.

You help with: product questions, pricing, availability, order follow-ups, and general support.

Rules:
- Be warm, concise, and professional — this is WhatsApp, keep replies short (under 4 sentences unless more is truly needed)
- Never make up specific prices or stock levels — say you'll confirm shortly
- Speak in clear, natural English. You understand Nigerian English and accents perfectly
- If directly asked, you are an AI assistant, not a human
- Sign off with the store name when appropriate: *${storeName}*`;

  try {
    let text = null;

    if (apiKey.startsWith('gsk_')) {
      // Groq — OpenAI-compatible
      const models = ['llama-3.3-70b-versatile', 'llama-3.1-70b-versatile', 'llama-3.1-8b-instant'];
      for (const model of models) {
        const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
          body:    JSON.stringify({
            model,
            messages:   [{ role: 'system', content: systemPrompt }, { role: 'user', content: message }],
            max_tokens: 300,
            temperature: 0.7
          })
        });
        if (r.ok) {
          const data = await r.json();
          text = data?.choices?.[0]?.message?.content?.trim();
          break;
        }
        if (r.status === 401 || r.status === 403) break;
      }
    } else {
      // Gemini
      const models = ['gemini-2.0-flash-lite', 'gemini-1.5-flash', 'gemini-1.5-flash-8b'];
      for (const m of models) {
        const r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey}`,
          {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
              system_instruction: { parts: [{ text: systemPrompt }] },
              contents:           [{ role: 'user', parts: [{ text: message }] }],
              generationConfig:   { maxOutputTokens: 300, temperature: 0.7 }
            })
          }
        );
        if (r.ok) {
          const data = await r.json();
          text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
          break;
        }
        if (r.status === 401 || r.status === 403) break;
      }
    }

    if (!text) throw new Error('empty response');
    return text.length > 1500 ? text.slice(0, 1497) + '…' : text;

  } catch (err) {
    console.error(JSON.stringify({ event: 'ai_error', error: String(err), ts: new Date().toISOString() }));
    return fallback;
  }
}

function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
