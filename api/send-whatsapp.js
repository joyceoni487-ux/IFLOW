/**
 * POST /api/send-whatsapp
 * Body: { to: "+234...", message: "text" }
 *
 * Sends an outbound WhatsApp message via Twilio.
 * Used by Nova in-app AI when the owner asks it to contact a customer.
 */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end('Method Not Allowed');

  const { to, message } = req.body || {};
  if (!to || !message) return res.status(400).json({ error: 'to and message are required' });

  const sid   = process.env.TWILIO_SID   || '';
  const token = process.env.TWILIO_TOKEN || '';
  const from  = process.env.TWILIO_FROM  || '';

  if (!sid || !token || !from) {
    return res.status(500).json({ error: 'Twilio not configured' });
  }

  const waTo   = to.startsWith('whatsapp:') ? to : 'whatsapp:' + to;
  const auth   = 'Basic ' + Buffer.from(sid + ':' + token).toString('base64');

  try {
    const r = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`,
      {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ From: from, To: waTo, Body: message }).toString()
      }
    );
    const data = await r.json();
    if (data.sid) {
      return res.status(200).json({ success: true, sid: data.sid });
    }
    return res.status(400).json({ error: data.message || 'Send failed', code: data.code });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
