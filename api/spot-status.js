// Vercel serverless function: read-only Spot ladder status for one symbol —
// the Spot-mode counterpart to api/status.js (Futures). No position/margin/
// liquidation concept here at all: "holdings" are just whatever the scoped
// orders below have actually filled, and P&L is plain return-on-cost-basis
// (statusCalc.js's computePnl, reused with `im` set to the cost basis
// instead of a margin figure — the math is identical: dollar P&L divided by
// whatever capital is actually at risk).
//
// The orders returned are mapped into the exact same shape Futures orders
// use ({price, vol, dealVol, dealAvgPrice, state, orderType, side,
// createTime}, with the same state/orderType number encoding: state 2
// resting, 3 filled, 4 canceled; orderType 1 limit, 5 market) so the
// browser's existing renderPositionStatus() — including its cumulative
// avg-entry-if-filled column — works for Spot mode with zero new UI code.
//
// GET /api/spot-status?symbol=CRVUSDT
//
// Order-history caveat: MEXC's allOrders endpoint only looks back a maximum
// of 7 days. A deployment left running longer than that without a fresh
// Execute would lose visibility into its own early orders here — the
// Futures integration's history_orders endpoint doesn't have this limit.

const { computePnl } = require('../statusCalc.js');

const BASE_URL = 'https://api.mexc.com';
const crypto = require('crypto');
const RECV_WINDOW = 10000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

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

// Classifies a raw MEXC order into our simplified filled/resting/canceled
// buckets from quantities rather than trusting the exact status-enum
// spelling (MEXC's docs didn't confirm the full status enum — see
// api/spot-execute.js's header comment for the same caveat).
function classify(o) {
  const executedQty = Number(o.executedQty || 0);
  const origQty = Number(o.origQty || 0);
  const status = String(o.status || '').toUpperCase();
  if (status === 'CANCELED' || status === 'REJECTED' || status === 'EXPIRED') return 4; // canceled
  if (origQty > 0 && executedQty >= origQty - 1e-9) return 3; // filled
  return 2; // resting (covers NEW and PARTIALLY_FILLED alike)
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
};
