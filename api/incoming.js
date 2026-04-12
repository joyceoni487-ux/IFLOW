/**
 * Twilio Incoming Message Handler — receives inbound WhatsApp messages.
 * Optionally replace the "When a message comes in" URL in Twilio Sandbox settings:
 *   https://{your-vercel-domain}.vercel.app/api/incoming
 *
 * Twilio POSTs these fields (application/x-www-form-urlencoded):
 *   From, To, Body, ProfileName, MessageSid, NumMedia, MediaUrl0 …
 *
 * This handler logs the message and sends a polite auto-reply.
 * Customize the STORE_NAME env var in Vercel Project Settings → Environment Variables.
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

  const storeName = process.env.STORE_NAME || 'our store';
  const hasMedia  = parseInt(NumMedia, 10) > 0;

  console.log(JSON.stringify({
    event:   'twilio_incoming',
    sid:     MessageSid,
    from:    From,
    name:    ProfileName,
    body:    Body.slice(0, 200),
    media:   hasMedia,
    ts:      new Date().toISOString()
  }));

  // Auto-reply — edit this message to match your business
  const reply = ProfileName
    ? `Hi ${ProfileName}! Thanks for reaching out to *${storeName}*. We've received your message and will get back to you shortly 🙏`
    : `Hi! Thanks for reaching out to *${storeName}*. We'll be with you shortly 🙏`;

  res.setHeader('Content-Type', 'text/xml');
  res.status(200).send(`<Response><Message>${escapeXml(reply)}</Message></Response>`);
}

function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
