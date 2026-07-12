// Vercel serverless function: places the ladder's limit buy orders on MEXC Futures.
// Credentials (MEXC_API_KEY / MEXC_API_SECRET) come from Vercel environment variables
// only — they are never sent to or read from the browser.
//
// POST /api/execute
// body: { symbol: "CRV_USDT", leverage: 5, orders: [{ step, price, qty }, ...] }
//   - price: limit price (quote currency)
//   - qty:   quantity in BASE asset units (e.g. CRV), same as calc.js's `newQty` —
//            this function converts it to MEXC's `vol` (number of contracts) itself.
//
// Auth per MEXC's futures integration guide:
//   target = accessKey + requestTimeMs + JSON.stringify(body)
//   signature = HMAC_SHA256(secretKey, target)  -> hex
//   headers: ApiKey, Request-Time, Signature

const crypto = require('crypto');

const PRIVATE_BASE_URL = 'https://api.mexc.com';
const CONTRACT_DETAIL_URL = 'https://contract.mexc.com/api/v1/contract/detail';
const ORDER_SPACING_MS = 550; // keeps us under MEXC's 4 requests / 2s limit on order/create

function sign(secretKey, accessKey, timestamp, paramString) {
  return crypto.createHmac('sha256', secretKey).update(accessKey + timestamp + paramString).digest('hex');
}

async function mexcPrivatePost(path, body, apiKey, secretKey) {
  const timestamp = Date.now().toString();
  const paramString = JSON.stringify(body);
  const signature = sign(secretKey, apiKey, timestamp, paramString);
  const res = await fetch(`${PRIVATE_BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ApiKey: apiKey,
      'Request-Time': timestamp,
      Signature: signature,
    },
    body: paramString,
  });
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(`MEXC returned a non-JSON response (HTTP ${res.status}).`);
  }
  return data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

  const { symbol, leverage, orders } = req.body || {};
  if (!symbol || !leverage || !Array.isArray(orders) || orders.length === 0) {
    res.status(400).json({ error: 'symbol, leverage, and a non-empty orders[] array are required.' });
    return;
  }
  if (orders.length > 30) {
    res.status(400).json({ error: 'Refusing to place more than 30 orders in one call.' });
    return;
  }

  // Pull contract spec (public endpoint, no auth) so we can convert the ladder's
  // base-asset quantities into MEXC's contract count (`vol`) and round to valid ticks.
  let contractSize, priceScale, volScale, minVol;
  try {
    const detailRes = await fetch(`${CONTRACT_DETAIL_URL}?symbol=${encodeURIComponent(symbol)}`);
    const detail = await detailRes.json();
    if (!detail || detail.success !== true || !detail.data) {
      throw new Error(`No contract spec found for "${symbol}".`);
    }
    contractSize = Number(detail.data.contractSize);
    priceScale = Number(detail.data.priceScale);
    volScale = Number(detail.data.volScale);
    minVol = Number(detail.data.minVol) || 1;
    if (!contractSize) throw new Error('contractSize missing from contract spec.');
  } catch (err) {
    res.status(502).json({ error: 'Could not fetch MEXC contract spec.', detail: String(err.message || err) });
    return;
  }

  const results = [];
  for (const order of orders) {
    const rawVol = order.qty / contractSize;
    const vol = Math.max(minVol, Number(rawVol.toFixed(volScale)) || Math.round(rawVol));
    const price = Number(order.price.toFixed(priceScale));

    const body = {
      symbol,
      price,
      vol,
      leverage: Number(leverage),
      side: 1, // open long
      type: order.market ? 5 : 1, // 5: market (fills now), 1: limit (rests on the book)
      openType: 1, // isolated
    };

    try {
      const data = await mexcPrivatePost('/api/v1/private/order/create', body, apiKey, secretKey);
      results.push({
        step: order.step,
        price,
        vol,
        orderType: order.market ? 'market' : 'limit',
        success: !!data.success,
        orderId: data?.data?.orderId || null,
        error: data.success ? null : data.message || `MEXC error code ${data.code}`,
      });
    } catch (err) {
      results.push({ step: order.step, price, vol, orderType: order.market ? 'market' : 'limit', success: false, orderId: null, error: String(err.message || err) });
    }

    await sleep(ORDER_SPACING_MS);
  }

  res.status(200).json({ contractSize, results });
};
