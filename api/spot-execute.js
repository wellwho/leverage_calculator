// Vercel serverless function: places the Spot DCA ladder's buy orders on
// MEXC Spot (as opposed to api/execute.js, which is the Futures/leveraged
// integration — different API, different signing, no leverage/margin at
// all here since spot has no liquidation to manage).
//
// POST /api/spot-execute
// body: { symbol: "CRVUSDT", capital: 951, orders: [{ step, price, qty }, ...] }
//   - price: trigger price (quote currency) — used as the LIMIT price for
//     every row except the market buy.
//   - qty:   quantity in BASE asset units (e.g. CRV), same as calc.js's
//     computeSpotPlan `newQty`.
//
// Order #1 (market) intentionally uses `quoteOrderQty` (spend exactly this
// many dollars) rather than a base quantity, since a market order has no
// fixed execution price to compute quantity from ahead of time — this way
// the dollar amount actually spent always matches the plan exactly. Every
// other row is a LIMIT buy resting at its ladder price, using `quantity`
// (base units, rounded to the symbol's precision).
//
// Auth: MEXC Spot v3's signing scheme (see api/spot-balance.js for the
// full explanation) — X-MEXC-APIKEY header, HMAC-SHA256 over the exact
// param string sent, as a form-urlencoded POST body (NOT JSON, unlike the
// Futures integration).

const crypto = require('crypto');

const BASE_URL = 'https://api.mexc.com';
const RECV_WINDOW = 10000;
const ORDER_SPACING_MS = 550; // no MEXC-documented per-second cap on this endpoint; matches the Futures integration's conservative pacing

function buildParamString(params) {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
}

function sign(secretKey, totalParams) {
  return crypto.createHmac('sha256', secretKey).update(totalParams).digest('hex');
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

  const { symbol, orders, capital } = req.body || {};
  if (!symbol || !Array.isArray(orders) || orders.length === 0) {
    res.status(400).json({ error: 'symbol and a non-empty orders[] array are required.' });
    return;
  }
  if (orders.length > 30) {
    res.status(400).json({ error: 'Refusing to place more than 30 orders in one call.' });
    return;
  }

  // Pull the symbol's precision (public endpoint, no auth) so quantities/
  // prices land on values MEXC will accept. MEXC's spot v3 docs don't
  // document a stepSize/tickSize filter the way Binance's do — precision
  // comes from flat baseAssetPrecision/quotePrecision fields instead.
  let baseAssetPrecision = 6;
  let quotePrecision = 8;
  try {
    const detailRes = await fetch(`${BASE_URL}/api/v3/exchangeInfo?symbol=${encodeURIComponent(symbol)}`);
    const detail = await detailRes.json();
    const info = Array.isArray(detail?.symbols) ? detail.symbols.find((s) => s.symbol === symbol) : detail;
    if (info) {
      if (Number.isFinite(Number(info.baseAssetPrecision))) baseAssetPrecision = Number(info.baseAssetPrecision);
      if (Number.isFinite(Number(info.quotePrecision))) quotePrecision = Number(info.quotePrecision);
    }
    // If exchangeInfo doesn't return anything useful, fall back to the
    // defaults above rather than failing the whole execute — MEXC will
    // still reject an individual order if the rounding is actually wrong,
    // and that surfaces per-row below rather than blocking everything.
  } catch {
    // keep defaults
  }

  const results = [];
  let committedTotal = 0;

  for (const order of orders) {
    const price = Number(order.price.toFixed(quotePrecision));

    if (order.market) {
      // Market buy: spend the planned dollar amount exactly via
      // quoteOrderQty, rather than pre-computing a base quantity against a
      // ticker price that may have already moved.
      const quoteOrderQty = Number((order.price * order.qty).toFixed(quotePrecision));
      const body = { symbol, side: 'BUY', type: 'MARKET', quoteOrderQty };
      try {
        const data = await spotPrivatePost('/api/v3/order', body, apiKey, secretKey);
        const success = !!data?.orderId;
        if (success) committedTotal += quoteOrderQty;
        results.push({
          step: order.step,
          price,
          qty: null, // market order — actual fill qty isn't in the placement response; check Position Status after
          quoteOrderQty,
          orderType: 'market',
          success,
          orderId: data?.orderId || null,
          error: success ? null : data?.msg || `MEXC error code ${data?.code}`,
        });
      } catch (err) {
        results.push({ step: order.step, price, qty: null, quoteOrderQty, orderType: 'market', success: false, orderId: null, error: String(err.message || err) });
      }
    } else {
      const qty = Number(order.qty.toFixed(baseAssetPrecision));
      const body = { symbol, side: 'BUY', type: 'LIMIT', quantity: qty, price };
      try {
        const data = await spotPrivatePost('/api/v3/order', body, apiKey, secretKey);
        const success = !!data?.orderId;
        if (success) committedTotal += price * qty;
        results.push({
          step: order.step,
          price,
          qty,
          orderType: 'limit',
          success,
          orderId: data?.orderId || null,
          error: success ? null : data?.msg || `MEXC error code ${data?.code}`,
        });
      } catch (err) {
        results.push({ step: order.step, price, qty, orderType: 'limit', success: false, orderId: null, error: String(err.message || err) });
      }
    }

    await sleep(ORDER_SPACING_MS);
  }

  const capitalNum = Number(capital);
  const leftoverCapital = Number.isFinite(capitalNum) ? capitalNum - committedTotal : null;

  res.status(200).json({ results, committedTotal, leftoverCapital });
};
