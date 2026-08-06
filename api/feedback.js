/**
 * NutriDaily feedback proxy: browser → /api/feedback → Discord webhook.
 * Keeps the webhook URL server-side (not in client JS) and avoids Discord CORS.
 *
 * Vercel env (Production): DISCORD_WEBHOOK_URL = https://discord.com/api/webhooks/...
 * Build also sets client ND_CONFIG.feedbackEndpoint to "/api/feedback" when that env is set.
 */
async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const webhook = String(process.env.DISCORD_WEBHOOK_URL || '').trim();
  if (!webhook) {
    res.status(503).json({ error: 'Feedback not configured' });
    return;
  }

  try {
    const body = await readRawBody(req);
    const contentType = req.headers['content-type'] || 'application/octet-stream';

    if (body.length > 9 * 1024 * 1024) {
      res.status(413).json({ error: 'Payload too large' });
      return;
    }

    const upstream = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body
    });

    const text = await upstream.text();
    if (!upstream.ok) {
      const status = upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502;
      res.status(status).json({ error: 'Discord rejected', detail: text.slice(0, 200) });
      return;
    }
    res.status(204).end();
  } catch (e) {
    res.status(502).json({ error: 'Proxy failed', detail: String(e && e.message || e).slice(0, 200) });
  }
};

module.exports.config = {
  api: { bodyParser: false }
};
