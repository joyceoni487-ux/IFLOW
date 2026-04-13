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
    return res.status(400).json({ error: 'Missing sid, token, or from' });
  }

  const auth    = 'Basic ' + Buffer.from(sid + ':' + token).toString('base64');
  const base    = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`;
  const waFrom  = encodeURIComponent('whatsapp:' + from);

  try {
    const [inRes, outRes] = await Promise.all([
      fetch(`${base}?To=${waFrom}&PageSize=200`,   { headers: { Authorization: auth } }),
      fetch(`${base}?From=${waFrom}&PageSize=200`, { headers: { Authorization: auth } })
    ]);

    if (!inRes.ok || !outRes.ok) {
      const bad = inRes.ok ? outRes : inRes;
      const errData = await bad.json().catch(() => ({}));
      return res.status(bad.status).json({ error: errData.message || 'Twilio error ' + bad.status });
    }

    const [inData, outData] = await Promise.all([inRes.json(), outRes.json()]);
    return res.status(200).json({
      inbound:  inData.messages  || [],
      outbound: outData.messages || []
    });
  } catch (e) {
    console.error(JSON.stringify({ event: 'twilio_proxy_error', error: String(e), ts: new Date().toISOString() }));
    return res.status(500).json({ error: 'Proxy error: ' + e.message });
  }
}
