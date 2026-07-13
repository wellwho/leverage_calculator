// Vercel serverless function: fetches the account's available USDT SPOT
// balance (as opposed to api/balance.js, which is the Futures wallet).
// Same MEXC_API_KEY / MEXC_API_SECRET env vars as the rest of this app —
// MEXC uses one API key for the whole account, gated by permission
// checkboxes per product, so the key just needs "Spot Account Read"
// enabled alongside whatever Futures permissions it already has.
//
// GET /api/spot-balance?asset=USDT
//
// Auth per MEXC's Spot v3 docs — a different scheme from the Futures
// integration (api/balance.js etc.) entirely:
//   totalParams = "key1=value1&key2=value2..." (params as sent, NOT sorted —
//     whatever exact string you transmit is what must be signed)
//   signature = HMAC_SHA256(secretKey, totalParams) -> lowercase hex,
//     sent as an additional `signature` param
//   header: X-MEXC-APIKEY (not the Futures integration's ApiKey/Request-Time/
//     Signature headers)
//   every SIGNED request needs `timestamp` (ms); `recvWindow` is optional
//     (MEXC defaults to 5000ms, max 60000) — set generously here to absorb
//     serverless cold-start / network latency.

const crypto = require('crypto');

const BASE_URL = 'https://api.mexc.com';
const RECV_WINDOW = 10000;

function buildParamString(params) {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
}

function sign(secretKey, totalParams) {
  return crypto.createHmac('sha256', secretKey).update(totalParams).digest('hex');
}

async function spotPrivateGet(path, params, apiKey, secretKey) {
  const allParams = { ...params, timestamp: Date.now(), recvWindow: RECV_WINDOW };
  const paramString = buildParamString(allParams);
  const signature = sign(secretKey, paramString);
  const res = await fetch(`${BASE_URL}${path}?${paramString}&signature=${signature}`, {
    headers: { 'X-MEXC-APIKEY': apiKey },
  });
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(`MEXC returned a non-JSON response (HTTP ${res.status}).`);
  }
  return data;
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

  const asset = String(req.query.asset || 'USDT').toUpperCase();

  try {
    const data = await spotPrivateGet('/api/v3/account', {}, apiKey, secretKey);
    if (!data || !Array.isArray(data.balances)) {
      res.status(502).json({
        error: data?.msg || `MEXC error code ${data?.code} — check the key has "Spot Account Read" permission.`,
      });
      return;
    }
    const entry = data.balances.find((b) => b.asset === asset);
    res.status(200).json({
      asset,
      free: entry ? Number(entry.free) : 0, // available to spend
      locked: entry ? Number(entry.locked) : 0, // tied up in open orders
    });
  } catch (err) {
    res.status(502).json({ error: 'Failed to reach MEXC.', detail: String(err.message || err) });
  }
};
