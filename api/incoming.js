/**
 * Twilio Incoming Message Handler — receives inbound WhatsApp messages.
 * Set as the "When a message comes in" URL in Twilio Sandbox settings:
 *   https://{your-vercel-domain}.vercel.app/api/incoming        ← auto-reply ON
 *   https://{your-vercel-domain}.vercel.app/api/incoming?reply=0 ← auto-reply OFF
 *
 * The iFlow Settings panel generates the correct URL based on your toggle.
 * Just copy and paste it into Twilio — no manual editing needed.
 *
 * Twilio POSTs these fields (application/x-www-form-urlencoded):
 *   From, To, Body, ProfileName, MessageSid, NumMedia, MediaUrl0 …
 *
 * Set STORE_NAME in Vercel Project Settings → Environment Variables
 * to personalise the auto-reply message.
 */
export default function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).end('Method Not Allowed');
  }

  const {
    From         = '',
    Body         = '',
    ProfileName  = '',
    MessageSid   = '',
    NumMedia     = '0'
  } = req.body || {};

  // ?reply=0 in the URL disables auto-reply (set from iFlow Settings toggle)
  const autoReply = req.query?.reply !== '0';
  const storeName = process.env.STORE_NAME || 'our store';
  const hasMedia  = parseInt(NumMedia, 10) > 0;

  console.log(JSON.stringify({
    event:      'twilio_incoming',
    sid:        MessageSid,
    from:       From,
    name:       ProfileName,
    body:       Body.slice(0, 200),
    media:      hasMedia,
    autoReply,
    ts:         new Date().toISOString()
  }));

  res.setHeader('Content-Type', 'text/xml');

  if (!autoReply) {
    // Auto-reply is off — just acknowledge Twilio with an empty response
    return res.status(200).send('<Response></Response>');
  }

  const reply = ProfileName
    ? `Hi ${ProfileName}! Thanks for reaching out to *${storeName}*. We've received your message and will get back to you shortly 🙏`
    : `Hi! Thanks for reaching out to *${storeName}*. We'll be with you shortly 🙏`;

  res.status(200).send(`<Response><Message>${escapeXml(reply)}</Message></Response>`);
}

function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
