// Vercel serverless function: validates username/password against
// Vercel environment variables and issues a signed session cookie.
// Credentials never live in code — only in APP_USERNAME / APP_PASSWORD /
// SESSION_SECRET, set in Vercel → Project Settings → Environment Variables.
//
// POST /api/login  body: { username, password }

const crypto = require('crypto');

const SESSION_DAYS = 7;
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;

// Constant-time-ish comparison that also tolerates different-length inputs
// (crypto.timingSafeEqual throws on mismatched lengths, so hash first).
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Use POST.' });
    return;
  }

  const appUsername = process.env.APP_USERNAME;
  const appPassword = process.env.APP_PASSWORD;
  const sessionSecret = process.env.SESSION_SECRET;
  if (!appUsername || !appPassword || !sessionSecret) {
    res.status(500).json({
      error: 'APP_USERNAME / APP_PASSWORD / SESSION_SECRET are not set on the server. Add them in Vercel → Project Settings → Environment Variables, then redeploy.',
    });
    return;
  }

  const { username, password } = req.body || {};
  if (!username || !password) {
    res.status(400).json({ error: 'Username and password are required.' });
    return;
  }

  const ok = safeEqual(username, appUsername) && safeEqual(password, appPassword);
  if (!ok) {
    res.status(401).json({ error: 'Invalid username or password.' });
    return;
  }

  const expiry = Date.now() + SESSION_MS;
  const sig = crypto.createHmac('sha256', sessionSecret).update(String(expiry)).digest('hex');
  const cookieValue = `${expiry}.${sig}`;

  res.setHeader(
    'Set-Cookie',
    `session=${cookieValue}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_MS / 1000)}`
  );
  res.status(200).json({ ok: true });
};
