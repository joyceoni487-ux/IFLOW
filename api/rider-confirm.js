/**
 * /api/rider-confirm — Rider accepts or completes a delivery via email link.
 *
 * GET /api/rider-confirm?id=ORDER_ID&rider=rider@email.com&action=accept|complete
 *
 * Returns a simple HTML confirmation page the rider sees on their phone.
 * Updates iflow-orders.json in Blob so the iFlow app picks it up via polling.
 */
import { put } from '@vercel/blob';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { id, rider, action } = req.query;
  const wantsJson = (req.headers.accept || '').includes('application/json');

  function _respond(status, htmlArgs, jsonObj) {
    if (wantsJson) return res.status(status).json(jsonObj);
    return res.status(status).send(_page(...htmlArgs));
  }

  if (!id || !rider || !['accept', 'complete'].includes(action)) {
    return _respond(400, ['❌', 'Invalid Link', 'This link is invalid or has expired.'], { error: 'Invalid parameters' });
  }

  const blobBase  = (process.env.PRODUCTS_BLOB_URL || '').replace('iflow-products.json', '');
  const ordersUrl = blobBase ? blobBase + 'iflow-orders.json' : '';
  const token     = process.env.BLOB_READ_WRITE_TOKEN;

  if (!ordersUrl || !token) {
    return _respond(500, ['⚠️', 'Not Configured', 'The store has not fully configured iFlow. Contact support.'], { error: 'Not configured' });
  }

  let orders = [];
  try {
    const r = await fetch(ordersUrl, { cache: 'no-store' });
    if (r.ok) orders = await r.json();
    if (!Array.isArray(orders)) orders = [];
  } catch {
    return _respond(500, ['⚠️', 'Error', 'Could not load order data. Try again.'], { error: 'Load failed' });
  }

  const order = orders.find(o => o.id === id);
  if (!order) {
    return _respond(404, ['❌', 'Order Not Found', 'This order may have already been handled.'], { error: 'Not found' });
  }

  // Guard: don't re-accept if already assigned to another rider
  if (action === 'accept' && order.status === 'rider_accepted' && order.riderId !== rider) {
    return _respond(200, ['🔒', 'Already Taken', 'Another rider already accepted this delivery. Thank you!'], { error: 'Already taken' });
  }

  if (action === 'accept') {
    order.status          = 'rider_accepted';
    order.riderId         = rider;
    order.riderAcceptedAt = new Date().toISOString();
  } else if (action === 'complete') {
    if (order.riderId && order.riderId !== rider) {
      return _respond(200, ['🔒', 'Not Your Order', 'You are not assigned to this delivery.'], { error: 'Not your order' });
    }
    order.status      = 'delivered';
    order.deliveredAt = new Date().toISOString();
  }

  try {
    await put('iflow-orders.json', JSON.stringify(orders), {
      access: 'public', token,
      contentType: 'application/json', addRandomSuffix: false
    });
  } catch {
    return _respond(500, ['⚠️', 'Save Failed', 'Action recorded but could not save. Please notify the store.'], { error: 'Save failed' });
  }

  const storeName = process.env.STORE_NAME || 'iFlow Store';
  const sid   = process.env.TWILIO_SID   || '';
  const token = process.env.TWILIO_TOKEN || '';
  const from  = process.env.TWILIO_FROM  || '';

  if (action === 'accept' && order.customerNum && sid && token && from) {
    const auth  = 'Basic ' + Buffer.from(sid + ':' + token).toString('base64');
    const to    = order.customerNum.startsWith('whatsapp:') ? order.customerNum : 'whatsapp:' + order.customerNum;
    const riderDisplay = rider.includes('@') ? rider.split('@')[0] : rider;
    const msg   = `🏍️ *Rider Assigned!*\nGreat news, ${order.customerName || 'valued customer'}! Your delivery has been picked up by *${riderDisplay}*.\n\nThey are on their way to you. Feel free to reach out to the store if you need assistance. 🙏`;
    fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ From: from, To: to, Body: msg }).toString()
    }).catch(() => {});
  }

  if (action === 'complete' && order.customerNum && sid && token && from) {
    const auth = 'Basic ' + Buffer.from(sid + ':' + token).toString('base64');
    const to   = order.customerNum.startsWith('whatsapp:') ? order.customerNum : 'whatsapp:' + order.customerNum;
    const msg  = `📦 *Order Delivered!*\nYour order from *${storeName}* has been delivered. Thank you for shopping with us — we hope you love it! 🙏`;
    fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ From: from, To: to, Body: msg }).toString()
    }).catch(() => {});
  }

  if (action === 'accept') {
    return _respond(200,
      ['✅', 'Delivery Accepted!', `You've accepted this delivery for *${storeName}*. Head to the pickup location — the store has been notified.`],
      { success: true, action: 'accepted' });
  }
  return _respond(200,
    ['🎉', 'Delivery Complete!', `Order marked as delivered. Thank you for completing this delivery for *${storeName}*!`],
    { success: true, action: 'delivered' });
}

function _page(icon, title, msg) {
  return `<!DOCTYPE html><html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — iFlow</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0b0d14;
    color:#e2e8f0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
  .card{background:#1a1d2e;border-radius:20px;padding:40px 32px;max-width:420px;width:100%;
    text-align:center;box-shadow:0 16px 48px rgba(0,0,0,.5);border:1px solid rgba(255,255,255,.08)}
  .icon{font-size:3.5rem;margin-bottom:20px}
  h1{font-size:1.4rem;font-weight:700;margin-bottom:12px;color:#f1f5f9}
  p{color:#94a3b8;line-height:1.65;font-size:0.95rem}
  .brand{margin-top:32px;font-size:0.75rem;color:#475569;letter-spacing:.5px}
</style>
</head>
<body><div class="card">
  <div class="icon">${icon}</div>
  <h1>${title}</h1>
  <p>${msg.replace(/\*/g,'<strong>').replace(/\*/g,'</strong>')}</p>
  <p class="brand">Powered by iFlow</p>
</div></body></html>`;
}
