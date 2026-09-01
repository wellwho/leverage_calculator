// Vercel serverless function: the "Close Position" panic button, on
// whichever exchange the Leveraged tab is currently pointed at.
//
// Symbol-scoped on purpose, on both exchanges:
//   1. Cancel every resting order for that symbol first, so nothing can fill
//      while or after we're closing.
//   2. Look up the open position for that symbol only and flash-close it at
//      market.
//
// POST /api/close  body: { symbol: "CRVUSDT" | "CRV_USDT", exchange: "bybit" | "mexc" }
// `exchange` defaults to "bybit" when omitted, for back-compat.

const { bybitGet, bybitPost, bybitOk, bybitErrMsg } = require('../bybitClient.js');
const { futuresPrivateGet, futuresPrivatePost, futuresOk, futuresErrMsg, getFuturesTicker } = require('../mexcClient.js');

async function closeOnBybit(req, res, symbol) {
  const apiKey = process.env.BYBIT_API_KEY;
  const secretKey = process.env.BYBIT_API_SECRET;
  if (!apiKey || !secretKey) {
    res.status(500).json({
      error: 'BYBIT_API_KEY and/or BYBIT_API_SECRET are not set on the server. Add them in Vercel → Project Settings → Environment Variables, then redeploy.',
    });
    return;
  }

  const steps = [];

  try {
    const cancelData = await bybitPost('/v5/order/cancel-all', { category: 'linear', symbol }, apiKey, secretKey);
    steps.push({ step: 'cancel_orders', success: bybitOk(cancelData), error: bybitOk(cancelData) ? null : bybitErrMsg(cancelData, 'Unknown Bybit error') });
  } catch (err) {
    steps.push({ step: 'cancel_orders', success: false, error: String(err.message || err) });
  }

  let positions = [];
  let lookupFailed = false;
  try {
    const posData = await bybitGet('/v5/position/list', { category: 'linear', symbol }, apiKey, secretKey);
    if (bybitOk(posData) && Array.isArray(posData.result?.list)) {
      positions = posData.result.list.filter((p) => p.symbol === symbol && Number(p.size) > 0);
    } else {
      lookupFailed = true;
      steps.push({ step: 'close_position', success: false, error: bybitErrMsg(posData, 'Could not look up open positions.') });
    }
  } catch (err) {
    lookupFailed = true;
    steps.push({ step: 'close_position', success: false, error: String(err.message || err) });
  }

  if (!lookupFailed && positions.length === 0) {
    steps.push({ step: 'close_position', success: true, note: 'No open position on this symbol.' });
    res.status(200).json({ steps });
    return;
  }
  if (lookupFailed) {
    res.status(200).json({ steps });
    return;
  }

  for (const position of positions) {
    const closeSide = position.side === 'Buy' ? 'Sell' : 'Buy';
    const body = { category: 'linear', symbol, side: closeSide, orderType: 'Market', qty: String(position.size), reduceOnly: true, positionIdx: Number(position.positionIdx) || 0 };
    try {
      const data = await bybitPost('/v5/order/create', body, apiKey, secretKey);
      steps.push({ step: 'close_position', vol: Number(position.size), success: bybitOk(data), orderId: data?.result?.orderId || null, error: bybitOk(data) ? null : bybitErrMsg(data, 'Unknown Bybit error') });
    } catch (err) {
      steps.push({ step: 'close_position', success: false, error: String(err.message || err) });
    }
  }

  res.status(200).json({ steps });
}

async function closeOnMexc(req, res, symbol) {
  const apiKey = process.env.MEXC_API_KEY;
  const secretKey = process.env.MEXC_API_SECRET;
  if (!apiKey || !secretKey) {
    res.status(500).json({
      error: 'MEXC_API_KEY and/or MEXC_API_SECRET are not set on the server. Add them in Vercel → Project Settings → Environment Variables, then redeploy.',
    });
    return;
  }

  const steps = [];

  // Deliberately does NOT use MEXC's /api/v1/private/position/close_all —
  // that endpoint takes no symbol parameter and closes every open position
  // on the whole account. This app only ever trades one symbol at a time.
  try {
    const cancelData = await futuresPrivatePost('/api/v1/private/order/cancel_all', { symbol }, apiKey, secretKey);
    steps.push({ step: 'cancel_orders', success: !!cancelData.success, error: cancelData.success ? null : futuresErrMsg(cancelData, 'Unknown MEXC error') });
  } catch (err) {
    steps.push({ step: 'cancel_orders', success: false, error: String(err.message || err) });
  }

  let positions = [];
  let lookupFailed = false;
  try {
    const posData = await futuresPrivateGet('/api/v1/private/position/open_positions', { symbol }, apiKey, secretKey);
    if (futuresOk(posData) && Array.isArray(posData.data)) {
      positions = posData.data.filter((p) => p.symbol === symbol && Number(p.holdVol) > 0);
    } else {
      lookupFailed = true;
      steps.push({ step: 'close_position', success: false, error: futuresErrMsg(posData, 'Could not look up open positions.') });
    }
  } catch (err) {
    lookupFailed = true;
    steps.push({ step: 'close_position', success: false, error: String(err.message || err) });
  }

  if (!lookupFailed && positions.length === 0) {
    steps.push({ step: 'close_position', success: true, note: 'No open position on this symbol.' });
    res.status(200).json({ steps });
    return;
  }
  if (lookupFailed) {
    res.status(200).json({ steps });
    return;
  }

  // Reference price for the market close order — MEXC's place-order schema
  // marks price as required even when type is market.
  let price = null;
  try {
    const ticker = await getFuturesTicker(symbol);
    if (ticker) price = Number(ticker.lastPrice);
  } catch {
    // fall through — position's own avg price is the fallback below
  }

  for (const position of positions) {
    const side = Number(position.positionType) === 1 ? 4 : 2; // 4 close long, 2 close short
    const body = {
      symbol,
      price: price || Number(position.holdAvgPrice) || 0,
      vol: Number(position.holdVol),
      side,
      type: 5, // market — flash close
      openType: Number(position.openType) || 1,
      positionId: position.positionId,
      reduceOnly: true,
    };
    try {
      const data = await futuresPrivatePost('/api/v1/private/order/create', body, apiKey, secretKey);
      steps.push({ step: 'close_position', positionId: position.positionId, vol: body.vol, success: !!data.success, orderId: data?.data?.orderId || null, error: data.success ? null : futuresErrMsg(data, 'Unknown MEXC error') });
    } catch (err) {
      steps.push({ step: 'close_position', positionId: position.positionId, success: false, error: String(err.message || err) });
    }
  }

  res.status(200).json({ steps });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Use POST.' });
    return;
  }

  const { symbol, exchange } = req.body || {};
  if (!symbol) {
    res.status(400).json({ error: 'symbol is required.' });
    return;
  }

  if (String(exchange || 'bybit').toLowerCase() === 'mexc') {
    await closeOnMexc(req, res, symbol);
  } else {
    await closeOnBybit(req, res, symbol);
  }
};
