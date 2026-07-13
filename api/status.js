// Vercel serverless function: read-only position + order status for one
// symbol. Drives the UI's two states — "plan calculator" when nothing is
// open, "position status" (with fill markers) when something is.
//
// The order list is scoped to "since the last Execute", not full history:
// it only returns orders placed at or after the most recent open-long
// market order (Buy #1 in this app's ladder always fires as one of those),
// so a re-deploy on the same symbol doesn't drag old, already-closed runs
// into the list.
//
// Also computes, when a position is open:
//   - pnl: unrealized P&L in $ and % of currently-committed margin, using
//     the live ticker price against the position's own avg entry.
//   - projectedLiquidation: NOT MEXC's current liquidatePrice (that only
//     reflects what has actually filled so far) — this projects the
//     liquidation price assuming every still-resting order in the scoped
//     list also fills, starting from the position's real, live `im`
//     (initial margin), which already reflects any margin added manually
//     in the MEXC app. So this is a real-time "if the whole ladder fills"
//     number, not a stale plan-time calculation.
//
// GET /api/status?symbol=CRV_USDT

const crypto = require('crypto');

const PRIVATE_BASE_URL = 'https://api.mexc.com';
const CONTRACT_DETAIL_URL = 'https://contract.mexc.com/api/v1/contract/detail';
const TICKER_URL = 'https://contract.mexc.com/api/v1/contract/ticker';

function sign(secretKey, accessKey, timestamp, paramString) {
  return crypto.createHmac('sha256', secretKey).update(accessKey + timestamp + paramString).digest('hex');
}

async function mexcPrivateGet(path, params, apiKey, secretKey) {
  const timestamp = Date.now().toString();
  const paramString = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  const signature = sign(secretKey, apiKey, timestamp, paramString);
  const qs = paramString ? `?${paramString}` : '';
  const res = await fetch(`${PRIVATE_BASE_URL}${path}${qs}`, {
    headers: { ApiKey: apiKey, 'Request-Time': timestamp, Signature: signature },
  });
  return res.json();
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

  // Position lookup — scoped to this symbol only (same pattern as api/close.js).
  let position = null;
  try {
    const posData = await mexcPrivateGet('/api/v1/private/position/open_positions', { symbol }, apiKey, secretKey);
    if (posData && posData.success === true && Array.isArray(posData.data)) {
      position = posData.data.find((p) => p.symbol === symbol && Number(p.holdVol) > 0) || null;
    } else {
      res.status(502).json({ error: posData?.message || `Could not look up position (MEXC error code ${posData?.code}).` });
      return;
    }
  } catch (err) {
    res.status(502).json({ error: 'Failed to reach MEXC.', detail: String(err.message || err) });
    return;
  }

  // Order list — "history_orders" accepts an optional `states` filter whose
  // enum includes state 2 (unfilled/resting), so leaving `states` unset
  // returns orders of every status for this symbol in one call: pending,
  // resting, filled, canceled, invalid. That's what lets the UI mark which
  // ladder rungs actually got hit without a second "current orders" call.
  let orders = [];
  let sinceTime = null;
  try {
    const ordersData = await mexcPrivateGet(
      '/api/v1/private/order/list/history_orders',
      { symbol, page_num: 1, page_size: 100 },
      apiKey,
      secretKey
    );
    if (ordersData && ordersData.success === true && Array.isArray(ordersData.data)) {
      const all = ordersData.data
        .filter((o) => o.symbol === symbol)
        .map((o) => ({
          orderId: o.orderId,
          price: Number(o.price),
          vol: Number(o.vol),
          dealVol: Number(o.dealVol),
          dealAvgPrice: Number(o.dealAvgPrice),
          side: o.side,
          orderType: o.orderType,
          state: o.state,
          createTime: o.createTime,
        }));

      // Buy #1 in this app is always an open-long market order (side 1,
      // orderType 5) — the most recent one marks the start of the current
      // deployment. Only orders from that point on are "since the last
      // Execute", which is what the UI wants instead of full history.
      const marketBuys = all.filter((o) => o.side === 1 && o.orderType === 5);
      if (marketBuys.length > 0) {
        sinceTime = Math.max(...marketBuys.map((o) => Number(o.createTime)));
      }

      const scoped = sinceTime !== null ? all.filter((o) => Number(o.createTime) >= sinceTime) : all;
      orders = scoped.sort((a, b) => b.price - a.price); // highest price first, matching the ladder's Buy #1-first order
    }
    // If this call fails, degrade gracefully — the position summary alone
    // is still useful, so don't fail the whole status check over it.
  } catch {
    // orders stays []
  }

  // Unrealized P&L and the "if fully filled" projected liquidation price —
  // both real-time, both only computed when there's actually a position.
  let pnl = null;
  let projectedLiquidation = null;

  if (position) {
    try {
      const [detailRes, tickerRes] = await Promise.all([
        fetch(`${CONTRACT_DETAIL_URL}?symbol=${encodeURIComponent(symbol)}`),
        fetch(`${TICKER_URL}?symbol=${encodeURIComponent(symbol)}`),
      ]);
      const detail = await detailRes.json();
      const ticker = await tickerRes.json();

      const contractSize = detail && detail.success && detail.data ? Number(detail.data.contractSize) : null;
      const mmr = detail && detail.success && detail.data ? Number(detail.data.maintenanceMarginRate) : null;
      const currentPrice = ticker && ticker.success && ticker.data ? Number(ticker.data.lastPrice) : null;

      const holdAvgPrice = Number(position.holdAvgPrice);
      const holdVol = Number(position.holdVol); // contracts
      const im = Number(position.im); // current total margin — reflects manual top-ups
      const leverage = Number(position.leverage) || 1;
      const isLong = Number(position.positionType) === 1;

      if (contractSize && currentPrice) {
        const qtyBase = holdVol * contractSize;
        const dollar = (isLong ? currentPrice - holdAvgPrice : holdAvgPrice - currentPrice) * qtyBase;
        const percent = im > 0 ? (dollar / im) * 100 : null;
        pnl = { dollar, percent, currentPrice };
      }

      if (contractSize && mmr !== null && im > 0) {
        const restingOrders = orders.filter((o) => o.state === 2); // still on the book
        let qtyBase = holdVol * contractSize;
        let notionalSum = holdAvgPrice * qtyBase;
        let marginTotal = im;

        restingOrders.forEach((o) => {
          const oQtyBase = o.vol * contractSize;
          notionalSum += o.price * oQtyBase;
          qtyBase += oQtyBase;
          marginTotal += (oQtyBase * o.price) / leverage;
        });

        if (qtyBase > 0) {
          const projectedAvgEntry = notionalSum / qtyBase;
          projectedLiquidation = projectedAvgEntry * (1 + mmr) - marginTotal / qtyBase;
        }
      }
    } catch {
      // leave pnl / projectedLiquidation as null — position + orders are
      // still useful on their own.
    }
  }

  res.status(200).json({ hasPosition: !!position, position, orders, sinceTime, pnl, projectedLiquidation });
};
