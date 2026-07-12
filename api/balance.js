// Vercel serverless function: fetches the account's available USDT futures balance.
// Credentials (MEXC_API_KEY / MEXC_API_SECRET) come from Vercel environment variables
// only — same as api/execute.js, never sent to or read from the browser.
//
// GET /api/balance?currency=USDT
//
// Auth per MEXC's futures integration guide:
//   - The currency is a *path* parameter, which MEXC's signing rules explicitly
//     exclude from the signed string, so the param string to sign is "".
//   target = accessKey + timestamp + ""
//   signature = HMAC_SHA256(secretKey, target) -> hex
//   headers: ApiKey, Request-Time, Signature

const crypto = require('crypto');

const PRIVATE_BASE_URL = 'https://api.mexc.com';

function sign(secretKey, accessKey, timestamp, paramString) {
  return crypto.createHmac('sha256', secretKey).update(accessKey + timestamp + paramString).digest('hex');
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const apiKey = process.env.MEXC_API_KEY;
  const secretKey = process.env.MEXC_API_SECRET;
  if (!apiKey || !secretKey) {
    res.status(500).json({
      error: 'MEXC_API_KEY and/or MEXC_API_SECRET are not set on the server. Add them in Vercel → Project Settings → Environment Variables, then redeploy.',
    });
    return;
  }

  const currency = String(req.query.currency || 'USDT').toUpperCase();
  const timestamp = Date.now().toString();
  const signature = sign(secretKey, apiKey, timestamp, '');

  try {
    const upstream = await fetch(`${PRIVATE_BASE_URL}/api/v1/private/account/asset/${encodeURIComponent(currency)}`, {
      headers: {
        ApiKey: apiKey,
        'Request-Time': timestamp,
        Signature: signature,
      },
    });
    let data;
    try {
      data = await upstream.json();
    } catch {
      throw new Error(`MEXC returned a non-JSON response (HTTP ${upstream.status}).`);
    }

    if (!data || data.success !== true || !data.data) {
      res.status(404).json({ error: data?.message || `No asset info for "${currency}" (check the key has "View Account Details" permission).` });
      return;
    }

    res.status(200).json({
      currency: data.data.currency,
      availableBalance: data.data.availableBalance, // currently available balance
      availableOpen: data.data.availableOpen, // usable amount for opening new positions
      cashBalance: data.data.cashBalance, // withdrawable balance
      equity: data.data.equity, // total equity incl. unrealized PnL
    });
  } catch (err) {
    res.status(502).json({ error: 'Failed to reach MEXC.', detail: String(err.message || err) });
  }
};
