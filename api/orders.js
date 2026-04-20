/**
 * /api/orders — Read and confirm customer payment orders stored in Vercel Blob.
 *
 * GET  /api/orders                          — return all orders
 * PATCH /api/orders?id=order_xxx&action=confirm  — confirm payment → WhatsApp customer
 * PATCH /api/orders?id=order_xxx&action=dismiss  — dismiss without action
 *
 * Requires: PRODUCTS_BLOB_URL, BLOB_READ_WRITE_TOKEN, TWILIO_* env vars
 */
import { put } from '@vercel/blob';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const blobBase  = (process.env.PRODUCTS_BLOB_URL || '').replace('iflow-products.json', '');
  const ordersUrl = blobBase ? blobBase + 'iflow-orders.json' : '';

  async function loadOrders() {
    if (!ordersUrl) return [];
    try {
      const r = await fetch(ordersUrl, { cache: 'no-store' });
      if (!r.ok) return [];
      const d = await r.json();
      return Array.isArray(d) ? d : [];
    } catch { return []; }
  }

  async function saveOrders(orders) {
    const token = process.env.BLOB_READ_WRITE_TOKEN;
    if (!token) return;
    await put('iflow-orders.json', JSON.stringify(orders), {
      access: 'public', token,
      contentType: 'application/json', addRandomSuffix: false
    });
  }

  // ── GET ──────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const orders = await loadOrders();
    return res.status(200).json(orders);
  }

  // ── PATCH ─────────────────────────────────────────────────────────────────
  if (req.method === 'PATCH') {
    const { id, action } = req.query;
    if (!id || !action) return res.status(400).json({ error: 'id and action required' });

    const orders = await loadOrders();
    const order  = orders.find(o => o.id === id);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    if (action === 'confirm') {
      order.status      = 'confirmed';
      order.confirmedAt = new Date().toISOString();
      await saveOrders(orders);

      // Send WhatsApp confirmation to customer
      const sid   = process.env.TWILIO_SID   || '';
      const token = process.env.TWILIO_TOKEN || '';
      const from  = process.env.TWILIO_FROM  || '';
      const store = process.env.STORE_NAME   || 'our store';
      if (sid && token && from && order.customerNum) {
        const auth = 'Basic ' + Buffer.from(sid + ':' + token).toString('base64');
        const to   = order.customerNum.startsWith('whatsapp:')
          ? order.customerNum : 'whatsapp:' + order.customerNum;
        // Parse order details for receipt: "Customer | item x1 | Address: addr"
        const parts   = (order.details || '').split('|').map(p => p.trim());
        const itemStr = parts[1] || 'your order';
        const addrRaw = parts.find(p => /address:/i.test(p)) || '';
        const address = addrRaw.replace(/^address:\s*/i, '').trim();
        const receipt = [
          `🧾 *Order Summary*`,
          `━━━━━━━━━━━━━━━`,
          itemStr,
          address ? `📍 ${address}` : '',
          `━━━━━━━━━━━━━━━`,
          `✅ Payment received & verified`
        ].filter(Boolean).join('\n');
        const msg  = `✅ *Payment Confirmed!*\nThank you, ${order.customerName || 'valued customer'}!\n\n${receipt}\n\n📦 A rider will be assigned shortly — we'll send you their contact when they accept. 🙏`;
        await fetch(
          `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`,
          {
            method: 'POST',
            headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ From: from, To: to, Body: msg }).toString()
          }
        ).catch(() => {});
      }

      return res.status(200).json({ success: true, order, riderEmails: order.riderEmails || [] });
    }

    if (action === 'dismiss') {
      order.status = 'dismissed';
      await saveOrders(orders);
      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  }

  res.status(405).end('Method Not Allowed');
}
