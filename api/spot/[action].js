// Single dynamic-route serverless function for all MEXC Spot endpoints —
// served at /api/spot/:action (e.g. /api/spot/price, /api/spot/execute),
// dispatching on req.query.action. This replaces what used to be five
// separate files (spot-price.js, spot-balance.js, spot-execute.js,
// spot-status.js, spot-close.js): Vercel's Hobby plan caps a deployment at
// 12 serverless functions, and adding Spot as five more files pushed this
// project's total (7 Leveraged/auth functions + 5 Spot) to 13. Merging
// Spot into one file brings the total back to 9, with headroom to spare.
// Behavior of each action is unchanged from the file it replaces — see the
// per-handler comments below for the original per-endpoint documentation.

const crypto = require('crypto');
const { computePnl } = require('../../statusCalc.js');

const BASE_URL = 'https://api.mexc.com';
const RECV_WINDOW = 10000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const ORDER_SPACING_MS = 550; // no MEXC-documented per-second cap on this endpoint; matches the Futures integration's conservative pacing

// ---- Shared MEXC Spot v3 signing helpers -----------------------------
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
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(`MEXC returned a non-JSON response (HTTP ${res.status}).`);
  }
  return data;
}

// ---- price: GET /api/spot/price?symbol=CRVUSDT -----------------------
// Proxies MEXC's Spot ticker price (avoids browser CORS block). Public
// endpoint, no auth needed — separate from api/price.js, which is the
// Futures ticker (different base path, different response shape, and Spot
// symbols have no underscore: "CRVUSDT", not "CRV_USDT").
async function handlePrice(req, res) {
  const { symbol } = req.query;
  if (!symbol) {
    res.status(400).json({ error: 'symbol query param is required, e.g. ?symbol=CRVUSDT' });
    return;
  }

  try {
    const upstream = await fetch(`${BASE_URL}/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}`);
    const data = await upstream.json();

    if (!data || !data.price) {
      res.status(404).json({ error: data?.msg || `No ticker found for symbol "${symbol}" on MEXC spot.` });
      return;
    }

    res.status(200).json({ symbol: data.symbol || symbol, lastPrice: data.price });
  } catch (err) {
    res.status(502).json({ error: 'Failed to reach MEXC.', detail: String(err) });
  }
}

// ---- balance: GET /api/spot/balance?asset=USDT ------------------------
// Fetches the account's available USDT SPOT balance (as opposed to
// api/balance.js, which is the Futures wallet). Same MEXC_API_KEY /
// MEXC_API_SECRET env vars as the rest of this app — MEXC uses one API key
// for the whole account, gated by permission checkboxes per product, so the
// key just needs "Spot Account Read" enabled alongside whatever Futures
// permissions it already has.
async function handleBalance(req, res, apiKey, secretKey) {
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
}

// ---- execute: POST /api/spot/execute -----------------------------------
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
async function handleExecute(req, res, apiKey, secretKey) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Use POST.' });
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

    await new Promise((r) => setTimeout(r, ORDER_SPACING_MS));
  }

  const capitalNum = Number(capital);
  const leftoverCapital = Number.isFinite(capitalNum) ? capitalNum - committedTotal : null;

  res.status(200).json({ results, committedTotal, leftoverCapital });
}

// ---- status: GET /api/spot/status?symbol=CRVUSDT -----------------------
// Read-only Spot ladder status for one symbol — the Spot-mode counterpart
// to api/status.js (Futures). No position/margin/liquidation concept here
// at all: "holdings" are just whatever the scoped orders below have
// actually filled, and P&L is plain return-on-cost-basis (statusCalc.js's
// computePnl, reused with `im` set to the cost basis instead of a margin
// figure — the math is identical: dollar P&L divided by whatever capital is
// actually at risk).
//
// The orders returned are mapped into the exact same shape Futures orders
// use ({price, vol, dealVol, dealAvgPrice, state, orderType, side,
// createTime}, with the same state/orderType number encoding: state 2
// resting, 3 filled, 4 canceled; orderType 1 limit, 5 market) so the
// browser's existing renderPositionStatus() — including its cumulative
// avg-entry-if-filled column — works for Spot mode with zero new UI code.
//
// Order-history caveat: MEXC's allOrders endpoint only looks back a maximum
// of 7 days. A deployment left running longer than that without a fresh
// Execute would lose visibility into its own early orders here — the
// Futures integration's history_orders endpoint doesn't have this limit.

// Classifies a raw MEXC order into our simplified filled/resting/canceled
// buckets from quantities rather than trusting the exact status-enum
// spelling (MEXC's docs didn't confirm the full status enum — see the
// execute handler's header comment for the same caveat).
function classify(o) {
  const executedQty = Number(o.executedQty || 0);
  const origQty = Number(o.origQty || 0);
  const status = String(o.status || '').toUpperCase();
  if (status === 'CANCELED' || status === 'REJECTED' || status === 'EXPIRED') return 4; // canceled
  if (origQty > 0 && executedQty >= origQty - 1e-9) return 3; // filled
  return 2; // resting (covers NEW and PARTIALLY_FILLED alike)
}

async function handleStatus(req, res, apiKey, secretKey) {
  const symbol = String(req.query.symbol || '').toUpperCase();
  if (!symbol) {
    res.status(400).json({ error: 'symbol query param is required.' });
    return;
  }

  let orders = [];
  let sinceTime = null;
  try {
    const raw = await spotPrivateGet('/api/v3/allOrders', { symbol, startTime: Date.now() - SEVEN_DAYS_MS }, apiKey, secretKey);
    if (!Array.isArray(raw)) {
      res.status(502).json({ error: raw?.msg || `Could not look up orders (MEXC error code ${raw?.code}).` });
      return;
    }

    const all = raw.map((o) => {
      const executedQty = Number(o.executedQty || 0);
      const cumQuote = Number(o.cummulativeQuoteQty || 0);
      const dealAvgPrice = executedQty > 0 ? cumQuote / executedQty : 0;
      const isMarket = String(o.type).toUpperCase() === 'MARKET';
      return {
        orderId: o.orderId,
        price: isMarket ? dealAvgPrice : Number(o.price),
        vol: Number(o.origQty),
        dealVol: executedQty,
        dealAvgPrice,
        side: 1,
        orderType: isMarket ? 5 : 1,
        state: classify(o),
        createTime: Number(o.time),
      };
    });

    // Same "since the last Execute" scoping as the Futures integration:
    // the most recent market buy marks the start of the current run.
    const marketBuys = all.filter((o) => o.orderType === 5);
    if (marketBuys.length > 0) sinceTime = Math.max(...marketBuys.map((o) => o.createTime));

    const scoped = sinceTime !== null ? all.filter((o) => o.createTime >= sinceTime) : all;
    orders = scoped.sort((a, b) => b.price - a.price);
  } catch (err) {
    res.status(502).json({ error: 'Failed to reach MEXC.', detail: String(err.message || err) });
    return;
  }

  // "Holdings" for this run = whatever's actually filled in the scoped list
  // — there's no unified position object on the spot side the way Futures
  // has one, so this is reconstructed directly from fills.
  const filled = orders.filter((o) => o.state === 3);
  const holdVol = filled.reduce((s, o) => s + o.dealVol, 0);
  const holdNotional = filled.reduce((s, o) => s + o.dealVol * o.dealAvgPrice, 0);
  const holdAvgPrice = holdVol > 0 ? holdNotional / holdVol : null;
  const hasPosition = holdVol > 0;

  let pnl = null;
  if (hasPosition) {
    try {
      const tickerRes = await fetch(`${BASE_URL}/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}`);
      const ticker = await tickerRes.json();
      const currentPrice = ticker && ticker.price ? Number(ticker.price) : null;
      if (currentPrice) {
        const costBasis = holdAvgPrice * holdVol; // no leverage — cost basis IS the capital at risk
        const { dollar, percent } = computePnl({
          holdAvgPrice,
          holdVol,
          contractSize: 1,
          currentPrice,
          im: costBasis,
          isLong: true,
        });
        pnl = { dollar, percent, currentPrice };
      }
    } catch {
      // leave pnl null — holdings/orders are still useful on their own
    }
  }

  res.status(200).json({
    hasPosition,
    position: hasPosition ? { holdAvgPrice, holdVol } : null,
    orders,
    sinceTime,
    pnl,
  });
}

// ---- close: POST /api/spot/close ---------------------------------------
// body: { symbol: "CRVUSDT", baseAsset: "CRV" }
//
// The counterpart to api/close.js (Futures). Spot has no position/leverage
// to flatten, so this does the spot-equivalent: cancel every open order on
// the symbol, then market-sell the ENTIRE free balance of the base asset
// back to USDT. Same account-flattening scope as the Futures panic button
// (not scoped to "this run" — it clears everything on this symbol).
async function handleClose(req, res, apiKey, secretKey) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Use POST.' });
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
}

// ---- dispatcher ----------------------------------------------------------
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { action } = req.query;

  if (action === 'price') {
    await handlePrice(req, res);
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

  switch (action) {
    case 'balance':
      await handleBalance(req, res, apiKey, secretKey);
      return;
    case 'execute':
      await handleExecute(req, res, apiKey, secretKey);
      return;
    case 'status':
      await handleStatus(req, res, apiKey, secretKey);
      return;
    case 'close':
      await handleClose(req, res, apiKey, secretKey);
      return;
    default:
      res.status(404).json({ error: `Unknown spot action "${action}".` });
  }
};
