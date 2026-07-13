// Vercel serverless function: read-only position + order status for one
// symbol. Drives the UI's two states — "plan calculator" when nothing is
// open, "position status" (with fill markers) when something is.
//
// GET /api/status?symbol=CRV_USDT

const crypto = require('crypto');

const PRIVATE_BASE_URL = 'https://api.mexc.com';

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
  try {
    const ordersData = await mexcPrivateGet(
      '/api/v1/private/order/list/history_orders',
      { symbol, page_num: 1, page_size: 100 },
      apiKey,
      secretKey
    );
    if (ordersData && ordersData.success === true && Array.isArray(ordersData.data)) {
      orders = ordersData.data
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
        }))
        .sort((a, b) => b.price - a.price); // highest price first, matching the ladder's Buy #1-first order
    }
    // If this call fails, degrade gracefully — the position summary alone
    // is still useful, so don't fail the whole status check over it.
  } catch {
    // orders stays []
  }

  res.status(200).json({ hasPosition: !!position, position, orders });
};
