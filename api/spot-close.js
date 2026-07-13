// Vercel serverless function behind Spot mode's "Close position" button —
// the counterpart to api/close.js (Futures). Spot has no position/leverage
// to flatten, so this does the spot-equivalent: cancel every open order on
// the symbol, then market-sell the ENTIRE free balance of the base asset
// back to USDT. Same account-flattening scope as the Futures panic button
// (not scoped to "this run" — it clears everything on this symbol).
//
// POST /api/spot-close
// body: { symbol: "CRVUSDT", baseAsset: "CRV" }

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
  return res.json();
}

async function spotPrivateDelete(path, params, apiKey, secretKey) {
  const allParams = { ...params, timestamp: Date.now(), recvWindow: RECV_WINDOW };
  const paramString = buildParamString(allParams);
  const signature = sign(secretKey, paramString);
  const res = await fetch(`${BASE_URL}${path}?${paramString}&signature=${signature}`, {
    method: 'DELETE',
    headers: { 'X-MEXC-APIKEY': apiKey },
  });
  return res.json();
}

async function spotPrivatePost(path, params, apiKey, secretKey) {
  const allParams = { ...params, timestamp: Date.now(), recvWindow: RECV_WINDOW };
  const paramString = buildParamString(allParams);
  const signature = sign(secretKey, paramString);
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'X-MEXC-APIKEY': apiKey, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `${paramString}&signature=${signature}`,
  });
  return res.json();
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Use POST.' });
    return;
  }

  const apiKey = process.env.MEXC_API_KEY;
  const secretKey = process.env.MEXC_API_SECRET;
  if (!apiKey || !secretKey) {
    res.status(500).json({
      error: 'MEXC_API_KEY and/or MEXC_API_SECRET are not set on the server. Add them in Vercel → Project Settings → Environment Variables, then redeploy.',
    });
    return;
  }

  const { symbol, baseAsset } = req.body || {};
  if (!symbol || !baseAsset) {
    res.status(400).json({ error: 'symbol and baseAsset are required.' });
    return;
  }

  const steps = [];

  // Step 1: cancel every open order on this symbol.
  try {
    const data = await spotPrivateDelete('/api/v3/openOrders', { symbol }, apiKey, secretKey);
    // MEXC returns an array (one entry per canceled order) on success, or a
    // {code, msg} error object if the whole call failed (e.g. bad symbol).
    // An empty array is a valid "nothing was open" outcome, not a failure.
    const success = Array.isArray(data);
    steps.push({
      step: 'cancel_orders',
      success,
      note: success ? `${data.length} order(s) canceled` : null,
      error: success ? null : data?.msg || `MEXC error code ${data?.code}`,
    });
  } catch (err) {
    steps.push({ step: 'cancel_orders', success: false, error: String(err.message || err) });
  }

  // Step 2: sell the entire free balance of the base asset, market, to flatten.
  try {
    const accountData = await spotPrivateGet('/api/v3/account', {}, apiKey, secretKey);
    if (!Array.isArray(accountData?.balances)) {
      steps.push({ step: 'sell_holdings', success: false, error: accountData?.msg || `MEXC error code ${accountData?.code}` });
    } else {
      const entry = accountData.balances.find((b) => b.asset === baseAsset);
      const free = entry ? Number(entry.free) : 0;

      if (!(free > 0)) {
        steps.push({ step: 'sell_holdings', success: true, note: `No free ${baseAsset} balance to sell.` });
      } else {
        // Round down to a sane precision — selling slightly less than the
        // full free balance (rather than risking a reject from rounding up
        // past what's actually available) is the safe direction here.
        let baseAssetPrecision = 6;
        try {
          const detailRes = await fetch(`${BASE_URL}/api/v3/exchangeInfo?symbol=${encodeURIComponent(symbol)}`);
          const detail = await detailRes.json();
          const info = Array.isArray(detail?.symbols) ? detail.symbols.find((s) => s.symbol === symbol) : detail;
          if (info && Number.isFinite(Number(info.baseAssetPrecision))) baseAssetPrecision = Number(info.baseAssetPrecision);
        } catch {
          // keep default
        }
        const factor = Math.pow(10, baseAssetPrecision);
        const quantity = Math.floor(free * factor) / factor;

        if (!(quantity > 0)) {
          steps.push({ step: 'sell_holdings', success: true, note: `Free ${baseAsset} balance is dust below the sellable precision — nothing sold.` });
        } else {
          const data = await spotPrivatePost('/api/v3/order', { symbol, side: 'SELL', type: 'MARKET', quantity }, apiKey, secretKey);
          const success = !!data?.orderId;
          steps.push({
            step: 'sell_holdings',
            success,
            quantity,
            orderId: data?.orderId || null,
            error: success ? null : data?.msg || `MEXC error code ${data?.code}`,
          });
        }
      }
    }
  } catch (err) {
    steps.push({ step: 'sell_holdings', success: false, error: String(err.message || err) });
  }

  res.status(200).json({ steps });
};
