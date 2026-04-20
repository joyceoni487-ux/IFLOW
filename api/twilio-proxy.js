/**
 * Twilio REST API proxy — avoids CORS issues when fetching messages from the browser.
 * POST /api/twilio-proxy
 * Body (JSON): { sid, token, from }
 * Returns: { inbound: [...messages], outbound: [...messages] }
 */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).end('Method Not Allowed');

  const { sid, token, from } = req.body || {};
  if (!sid || !token || !from) {
    return res.status(400).json({ error: 'Missing sid, token, or from number' });
  }

  // Normalise: strip any "whatsapp:" prefix the client may have stored
  const cleanFrom = String(from).replace(/^whatsapp:/i, '').replace(/\s/g, '');
  const waFrom    = encodeURIComponent('whatsapp:' + cleanFrom);
  const auth      = 'Basic ' + Buffer.from(sid + ':' + token).toString('base64');
  const base      = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`;

  try {
    const [inRes, outRes] = await Promise.all([
      fetch(`${base}?To=${waFrom}&PageSize=200`,   { headers: { Authorization: auth } }),
      fetch(`${base}?From=${waFrom}&PageSize=200`, { headers: { Authorization: auth } }),
    ]);

    const [inText, outText] = await Promise.all([inRes.text(), outRes.text()]);

    let inData = {}, outData = {};
    try { inData  = JSON.parse(inText);  } catch(_) {}
    try { outData = JSON.parse(outText); } catch(_) {}

    if (!inRes.ok || !outRes.ok) {
      const bad = !inRes.ok ? inData : outData;
      return res.status(502).json({
        error: bad.message || bad.error_message || 'Twilio returned an error — check your SID, token and WhatsApp number'
      });
    }

    return res.status(200).json({
      inbound:  inData.messages  || [],
      outbound: outData.messages || [],
    });
  } catch (e) {
    console.error(JSON.stringify({ event: 'twilio_proxy_error', error: String(e), ts: new Date().toISOString() }));
    return res.status(500).json({ error: 'Proxy error: ' + String(e.message || e) });
  }
}
