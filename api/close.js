// Vercel serverless function: the "Close Position" panic button.
//
// Deliberately does NOT use MEXC's /api/v1/private/position/close_all —
// that endpoint takes no symbol parameter and closes every open position
// on the whole account. This app only ever trades one symbol at a time,
// so instead:
//   1. Cancel every resting order for that symbol (order/cancel_all,
//      which IS symbol-scoped) — done first, so nothing can fill while
//      or after we're closing.
//   2. Look up open position(s) for that symbol only (position/open_positions
//      with a symbol filter) and flash-close each one at market.
//
// POST /api/close  body: { symbol: "CRV_USDT" }

const crypto = require('crypto');

const PRIVATE_BASE_URL = 'https://api.mexc.com';
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

  const { symbol } = req.body || {};
  if (!symbol) {
    res.status(400).json({ error: 'symbol is required.' });
    return;
  }

  const steps = [];

  // Step 1: cancel every resting order for this symbol.
  try {
    const cancelData = await mexcPrivatePost('/api/v1/private/order/cancel_all', { symbol }, apiKey, secretKey);
    steps.push({
      step: 'cancel_orders',
      success: !!cancelData.success,
      error: cancelData.success ? null : cancelData.message || `MEXC error code ${cancelData.code}`,
    });
  } catch (err) {
    steps.push({ step: 'cancel_orders', success: false, error: String(err.message || err) });
  }

  // Step 2: look up open position(s) for this symbol only.
  let positions = [];
  let lookupFailed = false;
  try {
    const posData = await mexcPrivateGet('/api/v1/private/position/open_positions', { symbol }, apiKey, secretKey);
    if (posData && posData.success === true && Array.isArray(posData.data)) {
      positions = posData.data.filter((p) => p.symbol === symbol && Number(p.holdVol) > 0);
    } else {
      lookupFailed = true;
      steps.push({
        step: 'close_position',
        success: false,
        error: posData?.message || `Could not look up open positions (MEXC error code ${posData?.code}).`,
      });
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
    const tickerRes = await fetch(`${TICKER_URL}?symbol=${encodeURIComponent(symbol)}`);
    const ticker = await tickerRes.json();
    if (ticker && ticker.success && ticker.data) price = Number(ticker.data.lastPrice);
  } catch {
    // fall through — position's own avg price is the fallback below
  }

  for (const position of positions) {
    const side = Number(position.positionType) === 1 ? 4 : 2; // 4: close long, 2: close short
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
      const data = await mexcPrivatePost('/api/v1/private/order/create', body, apiKey, secretKey);
      steps.push({
        step: 'close_position',
        positionId: position.positionId,
        vol: body.vol,
        success: !!data.success,
        orderId: data?.data?.orderId || null,
        error: data.success ? null : data.message || `MEXC error code ${data.code}`,
      });
    } catch (err) {
      steps.push({ step: 'close_position', positionId: position.positionId, success: false, error: String(err.message || err) });
    }
  }

  res.status(200).json({ steps });
};
