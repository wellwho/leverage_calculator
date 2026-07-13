// Vercel serverless function: places the ladder's limit buy orders on MEXC Futures,
// then adds whatever capital is left over as position margin.
// Credentials (MEXC_API_KEY / MEXC_API_SECRET) come from Vercel environment variables
// only — they are never sent to or read from the browser.
//
// POST /api/execute
// body: { symbol: "CRV_USDT", leverage: 5, capital: 951, orders: [{ step, price, qty }, ...] }
//   - price:   limit price (quote currency)
//   - qty:     quantity in BASE asset units (e.g. CRV), same as calc.js's `newQty` —
//              this function converts it to MEXC's `vol` (number of contracts) itself.
//   - capital: the plan's total capital. After every order is placed, whatever of it
//              wasn't actually committed to an order (MEXC's vol/price rounding means
//              this rarely matches the plan's numbers exactly) gets added directly to
//              the position as margin — see addRemainingMargin() below. Optional: if
//              omitted (e.g. an older frontend), the margin step is skipped.
//
// Auth per MEXC's futures integration guide:
//   target = accessKey + requestTimeMs + JSON.stringify(body)   [POST]
//   target = accessKey + requestTimeMs + sortedQueryString      [GET]
//   signature = HMAC_SHA256(secretKey, target)  -> hex
//   headers: ApiKey, Request-Time, Signature

const crypto = require('crypto');

const PRIVATE_BASE_URL = 'https://api.mexc.com';
const CONTRACT_DETAIL_URL = 'https://contract.mexc.com/api/v1/contract/detail';
const ORDER_SPACING_MS = 550; // keeps us under MEXC's 4 requests / 2s limit on order/create
const MIN_MARGIN_ADD = 0.01; // defensive floor — skip attempting a dust/negative top-up rather than let MEXC reject it

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Buy #1 (market) is placed first in the loop above, so by the time every
// ladder order has been placed, several hundred ms to several seconds have
// already elapsed — the position should already exist. Poll anyway, as a
// safety net against any lag, before giving up.
async function findOpenPosition(symbol, apiKey, secretKey, { attempts = 6, delayMs = 500 } = {}) {
  for (let i = 0; i < attempts; i++) {
    const data = await mexcPrivateGet('/api/v1/private/position/open_positions', { symbol }, apiKey, secretKey);
    if (data && data.success === true && Array.isArray(data.data)) {
      const position = data.data.find((p) => p.symbol === symbol && Number(p.holdVol) > 0);
      if (position) return position;
    }
    if (i < attempts - 1) await sleep(delayMs);
  }
  return null;
}

// Adds `amount` directly to the open position's margin via MEXC's
// change_margin endpoint (type 1 = increase). Requires the position to
// already exist, which is why this only ever runs after every ladder
// order has been placed.
async function addRemainingMargin({ symbol, amount, apiKey, secretKey }) {
  const position = await findOpenPosition(symbol, apiKey, secretKey);
  if (!position) {
    return {
      attempted: true,
      success: false,
      amount,
      error: 'Could not find the open position after placing orders — margin was not added automatically. Add it manually in the MEXC app.',
    };
  }
  try {
    const data = await mexcPrivatePost(
      '/api/v1/private/position/change_margin',
      { positionId: position.positionId, amount: Number(amount.toFixed(6)), type: 1 },
      apiKey,
      secretKey
    );
    return {
      attempted: true,
      success: !!data.success,
      amount,
      positionId: position.positionId,
      error: data.success ? null : data.message || `MEXC error code ${data.code}`,
    };
  } catch (err) {
    return { attempted: true, success: false, amount, positionId: position.positionId, error: String(err.message || err) };
  }
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

  const { symbol, leverage, orders, capital } = req.body || {};
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

  // Whatever capital wasn't actually committed to a successfully-placed
  // order — using each order's real, exchange-rounded price × vol, not the
  // plan's theoretical numbers — gets added straight to the position as
  // margin. This intentionally does NOT use calc.js's precomputed "Add
  // Margin" figure: MEXC's contract-unit rounding (contractSize/volScale/
  // minVol) means the orders that actually landed rarely cost exactly what
  // the plan predicted, so "whatever capital is left after placing every
  // order" is the more accurate number.
  let marginAdd = null;
  const capitalNum = Number(capital);
  if (Number.isFinite(capitalNum) && capitalNum > 0) {
    const committedMargin = results
      .filter((r) => r.success)
      .reduce((sum, r) => sum + (r.price * r.vol * contractSize) / Number(leverage), 0);
    const remaining = capitalNum - committedMargin;

    if (remaining >= MIN_MARGIN_ADD) {
      marginAdd = await addRemainingMargin({ symbol, amount: remaining, apiKey, secretKey });
    } else {
      marginAdd = {
        attempted: false,
        amount: remaining,
        reason:
          remaining < 0
            ? 'Placed orders committed more than the provided capital — nothing left to add.'
            : 'Remaining amount is below the minimum to bother adding.',
      };
    }
  } else {
    marginAdd = { attempted: false, amount: null, reason: 'No capital value was provided — margin step skipped.' };
  }

  res.status(200).json({ contractSize, results, marginAdd });
};
