/**
 * /api/products — Vercel Blob-backed product sync endpoint.
 *
 * GET  /api/products          — returns the latest products JSON stored in Blob
 * PUT  /api/products          — iFlow app pushes updated product list here
 *
 * Required Vercel environment variable:
 *   BLOB_READ_WRITE_TOKEN     — from Vercel Storage → Blob → your store → .env.local token
 */
import { put, list } from '@vercel/blob';

const BLOB_PATHNAME = 'iflow-products.json';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── GET: return cached products ──────────────────────────────────────────
  if (req.method === 'GET') {
    try {
      const token = process.env.BLOB_READ_WRITE_TOKEN;

      // Try PRODUCTS_BLOB_URL env var first (fastest)
      const staticUrl = process.env.PRODUCTS_BLOB_URL;
      if (staticUrl) {
        const r = await fetch(staticUrl, { cache: 'no-store' });
        if (r.ok) return res.status(200).json(await r.json());
      }

      // Fallback: discover the blob URL via list() (works even if env var not set)
      if (!token) return res.status(200).json({ products: [] });
      const { blobs } = await list({ token, prefix: 'iflow-products' });
      const blob = blobs.find(b => b.pathname === BLOB_PATHNAME);
      if (!blob) return res.status(200).json({ products: [] });
      const r2 = await fetch(blob.url, { cache: 'no-store' });
      if (!r2.ok) return res.status(200).json({ products: [] });
      return res.status(200).json(await r2.json());
    } catch {
      return res.status(200).json({ products: [] });
    }
  }

  // ── PUT: store updated products ──────────────────────────────────────────
  if (req.method === 'PUT') {
    const token = process.env.BLOB_READ_WRITE_TOKEN;
    if (!token) return res.status(500).json({ error: 'BLOB_READ_WRITE_TOKEN not set' });

    try {
      const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      const blob = await put(BLOB_PATHNAME, body, {
        access: 'public',
        token,
        contentType: 'application/json',
        addRandomSuffix: false
      });
      return res.status(200).json({ url: blob.url });
    } catch (err) {
      console.error(JSON.stringify({ event: 'blob_put_error', error: String(err) }));
      return res.status(500).json({ error: String(err) });
    }
  }

  res.status(405).end('Method Not Allowed');
}
