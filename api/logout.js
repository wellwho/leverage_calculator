// Vercel serverless function: clears the session cookie set by api/login.js.
// Left in middleware.mjs's PUBLIC_PATHS so it always works, even against an
// already-expired session.

module.exports = async (req, res) => {
  res.setHeader('Set-Cookie', 'session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0');
  res.status(200).json({ ok: true });
};
