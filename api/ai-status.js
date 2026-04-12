/**
 * Checks whether AI is configured for WhatsApp auto-replies.
 * iFlow calls this when opening the WhatsApp settings section
 * to show a live "AI active / not configured" status badge.
 */
export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).json({
    ai:        !!(process.env.GROQ_API_KEY || process.env.GEMINI_API_KEY),
    provider:  process.env.GROQ_API_KEY ? 'groq' : process.env.GEMINI_API_KEY ? 'gemini' : null,
    storeName: process.env.STORE_NAME || null
  });
}
