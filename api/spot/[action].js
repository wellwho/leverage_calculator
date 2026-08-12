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
// A few minutes shy of the true 7-day boundary, not exactly 7 days: MEXC
// hard-rejects allOrders with "Only 7 day's data can be queried" if the gap
// between `startTime` and whatever it treats as "now" exceeds 7 days by even
// a little — and the gap between this serverless function computing
// Date.now() and MEXC's server actually evaluating that check (network
// latency, serverless cold start, clock drift) is enough to trip an exact
// 7*24*60*60*1000 window in practice.
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000 - 5 * 60 * 1000;
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

// Since Feb 2024, MEXC's API gateway rejects every request — GET, POST, and
// DELETE alike — unless the Content-Type header is exactly
// "application/json" (error code 700013, msg "Invalid content Type."), even
// though the actual params are still sent as a signed query string, not a
// JSON body. This tripped up ccxt too (ccxt/ccxt#21345): the fix isn't to
// send a real JSON body, it's to send the query string as before and just
// set this header so the gateway's check passes.
const JSON_CONTENT_TYPE_HEADER = { 'Content-Type': 'application/json' };

async function spotPrivateGet(path, params, apiKey, secretKey) {
  const allParams = { ...params, timestamp: Date.now(), recvWindow: RECV_WINDOW };
  const paramString = buildParamString(allParams);
  const signature = sign(secretKey, paramString);
  const res = await fetch(`${BASE_URL}${path}?${paramString}&signature=${signature}`, {
    headers: { 'X-MEXC-APIKEY': apiKey, ...JSON_CONTENT_TYPE_HEADER },
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
    headers: { 'X-MEXC-APIKEY': apiKey, ...JSON_CONTENT_TYPE_HEADER },
  });
  return res.json();
}

async function spotPrivatePost(path, params, apiKey, secretKey) {
  const allParams = { ...params, timestamp: Date.now(), recvWindow: RECV_WINDOW };
  const paramString = buildParamString(allParams);
  const signature = sign(secretKey, paramString);
  // Params travel in the query string (not the body) — same as the GET/
  // DELETE helpers above — because the Content-Type header below is a
  // gateway-level requirement, not a real declaration of the body's
  // encoding. Sending an empty body keeps the two in sync.
  const res = await fetch(`${BASE_URL}${path}?${paramString}&signature=${signature}`, {
    method: 'POST',
    headers: { 'X-MEXC-APIKEY': apiKey, ...JSON_CONTENT_TYPE_HEADER },
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

// Live USDT free-balance lookup, called right before sizing each order below.
// The plan's `capital` figure is a snapshot from whenever the "Available
// balance" field was last refreshed in the browser — by the time later rows
// in a 6-row ladder actually fire, the real free balance can have drifted a
// few cents below what the plan assumed (e.g. it was fetched a bit earlier,
// or MEXC's own rounding on an already-placed row locked slightly more than
// this file's local price*qty math expected). Re-checking live, right before
// each order, means a row gets sized to whatever's *actually* left instead
// of blindly submitting the planned amount and letting MEXC hard-reject the
// whole order with code 30004 ("Insufficient position" — MEXC's shared
// insufficient-funds error, reused here from its futures wording) once the
// account runs a few cents short.
async function getFreeUsdt(apiKey, secretKey) {
  try {
    const data = await spotPrivateGet('/api/v3/account', {}, apiKey, secretKey);
    if (!data || !Array.isArray(data.balances)) return null;
    const entry = data.balances.find((b) => b.asset === 'USDT');
    return entry ? Number(entry.free) : 0;
  } catch {
    return null; // best-effort — fall back to submitting the planned amount unclamped
  }
}

// Free + locked balance of a single asset (public account snapshot) — shared
// by handleStatus (real position size, see below) and anything else that
// needs ground truth about what's actually held rather than what an order
// history reconstruction implies.
async function getAssetBalance(asset, apiKey, secretKey) {
  try {
    const data = await spotPrivateGet('/api/v3/account', {}, apiKey, secretKey);
    if (!data || !Array.isArray(data.balances)) return null;
    const entry = data.balances.find((b) => b.asset === asset);
    return entry ? { free: Number(entry.free), locked: Number(entry.locked) } : { free: 0, locked: 0 };
  } catch {
    return null;
  }
}

// Symbol precision (public endpoint, no auth) — shared by execute/close/
// status so quantities/prices land on values MEXC will accept and dust
// thresholds are computed consistently. MEXC's spot v3 docs don't document a
// stepSize/tickSize filter the way Binance's do — precision comes from flat
// baseAssetPrecision/quotePrecision fields instead.
async function getSymbolPrecision(symbol) {
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
    // defaults above rather than failing the whole caller — MEXC will still
    // reject an individual order if the rounding is actually wrong, and that
    // surfaces per-row rather than blocking everything.
  } catch {
    // keep defaults
  }
  return { baseAssetPrecision, quotePrecision };
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
// (base units, rounded to the symbol's precision). Every row's size is
// clamped against the live free USDT balance right before submission (see
// getFreeUsdt above) so a late row degrades to "buy whatever's actually
// left" instead of failing outright when the real balance has drifted a bit
// below the plan.
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

  const { baseAssetPrecision, quotePrecision } = await getSymbolPrecision(symbol);

  const results = [];
  let committedTotal = 0;

  for (const order of orders) {
    const price = Number(order.price.toFixed(quotePrecision));

    if (order.market) {
      // Market buy: spend the planned dollar amount exactly via
      // quoteOrderQty, rather than pre-computing a base quantity against a
      // ticker price that may have already moved.
      let quoteOrderQty = Number((order.price * order.qty).toFixed(quotePrecision));
      const freeUsdt = await getFreeUsdt(apiKey, secretKey);
      if (freeUsdt !== null) quoteOrderQty = Math.min(quoteOrderQty, Number(freeUsdt.toFixed(quotePrecision)));
      if (!(quoteOrderQty > 0)) {
        results.push({ step: order.step, price, qty: null, quoteOrderQty: 0, orderType: 'market', success: false, orderId: null, error: 'Skipped — no USDT balance left to spend.' });
        await new Promise((r) => setTimeout(r, ORDER_SPACING_MS));
        continue;
      }
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
      let qty = Number(order.qty.toFixed(baseAssetPrecision));
      const freeUsdt = await getFreeUsdt(apiKey, secretKey);
      if (freeUsdt !== null) {
        const factor = Math.pow(10, baseAssetPrecision);
        // Floor (never round up) — the safe direction when clamping against
        // a hard balance cap, same reasoning as handleClose's sell-side
        // rounding below.
        const maxAffordableQty = Math.floor((freeUsdt / price) * factor) / factor;
        qty = Math.min(qty, maxAffordableQty);
      }
      if (!(qty > 0)) {
        results.push({ step: order.step, price, qty: 0, orderType: 'limit', success: false, orderId: null, error: 'Skipped — no USDT balance left to spend.' });
        await new Promise((r) => setTimeout(r, ORDER_SPACING_MS));
        continue;
      }
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
// to api/status.js (Futures). Unlike an earlier version of this handler,
// `hasPosition` is NOT reconstructed from order history — it's read
// directly from the account's real free+locked balance of the base asset
// (e.g. CRV), the same way api/status.js trusts MEXC's actual
// open_positions endpoint for Futures. Order history is still used, but
// only for what a balance number alone can't provide: the fill/resting/
// canceled table, and reconstructing an average cost basis for P&L.
//
// Why hasPosition can't be inferred from fills alone: the earlier version
// scanned the scoped order list for anything "filled" and summed dealVol,
// with every order's `side` hardcoded to 1 (buy) regardless of what MEXC
// actually reported. That meant a SELL order — e.g. from the "Close
// position" panic button, or a manual sell placed directly on MEXC — got
// counted as ADDING to holdings instead of subtracting, so a fully
// flattened account could still show as "in position" indefinitely
// (reported live: position still showing after the account was already
// flat). Worse, since the "since" scope anchored to the most recent MARKET
// order of *either* side, closing via a market sell could push sinceTime
// past the original buys entirely, leaving only the sell itself in scope —
// misread as a brand-new buy fill. Reading the real balance sidesteps all
// of that: if you don't actually hold the asset, there's no position, full
// stop, regardless of what the order-history reconstruction would imply.
//
// Order-history caveat (unchanged from before): MEXC's allOrders endpoint
// only looks back a maximum of 7 days. A position opened longer ago than
// that with no order activity since will still correctly show as held (the
// real balance says so), but its avg entry / P&L come back null — there
// are no fills left in view to reconstruct a cost basis from.
//
// The orders returned are mapped into the exact same shape Futures orders
// use ({price, vol, dealVol, dealAvgPrice, state, orderType, side,
// createTime}, with the same state/orderType/side number encoding: state 2
// resting, 3 filled, 4 canceled; orderType 1 limit, 5 market; side 1 buy, 2
// sell) so the browser's existing renderPositionStatus() — including its
// cumulative avg-entry-if-filled column — works for Spot mode with zero new
// UI code.

// Classifies a raw MEXC order into our simplified filled/resting/canceled
// buckets.
//
// Order #1 of every plan is a MARKET buy placed via `quoteOrderQty` (spend
// exactly $X) rather than `quantity` (buy exactly Y units) — see the execute
// handler above. MEXC's allOrders response for an order placed that way
// comes back with `origQty` at "0.000000" even once fully filled (the fill
// amount instead lives in `executedQty`/`cummulativeQuoteQty`); the actual
// base-asset quantity was never known ahead of the fill, so there was never
// an origQty to report. The old version of this function required
// `origQty > 0` to ever call something "filled", which meant a fully-filled
// market buy was permanently misclassified as "resting". `status` is
// checked first now (MEXC does return it on every order — "FILLED" for a
// completed market or limit buy), with the quantity comparison kept only as
// a fallback for any status string this function doesn't recognize.
function classify(o) {
  const executedQty = Number(o.executedQty || 0);
  const origQty = Number(o.origQty || 0);
  const status = String(o.status || '').toUpperCase();
  if (status === 'CANCELED' || status === 'REJECTED' || status === 'EXPIRED' || status === 'PARTIALLY_CANCELED') return 4; // canceled
  if (status === 'FILLED') return 3; // filled — trust MEXC's own status first
  if (origQty > 0 && executedQty >= origQty - 1e-9) return 3; // filled (fallback: quantity-based, for limit orders / unrecognized status strings)
  if (!(origQty > 0) && executedQty > 0) return 3; // filled market order with no origQty to compare against (quoteOrderQty case)
  return 2; // resting (covers NEW and PARTIALLY_FILLED alike)
}

async function handleStatus(req, res, apiKey, secretKey) {
  const symbol = String(req.query.symbol || '').toUpperCase();
  if (!symbol) {
    res.status(400).json({ error: 'symbol query param is required.' });
    return;
  }
  // This app only ever trades USDT-quoted pairs (see index.html's
  // toSpotSymbol) — safe to derive the base asset by stripping the suffix.
  const baseAsset = symbol.endsWith('USDT') ? symbol.slice(0, -4) : symbol;

  const { baseAssetPrecision } = await getSymbolPrecision(symbol);

  // Ground truth for whether a position exists at all — see header comment.
  const balance = await getAssetBalance(baseAsset, apiKey, secretKey);
  if (balance === null) {
    res.status(502).json({ error: `Could not look up ${baseAsset} balance — check the key has "Spot Account Read" permission.` });
    return;
  }
  const factor = Math.pow(10, baseAssetPrecision);
  // Floor — never let float dust above the true balance read as "held".
  const realHoldVol = Math.floor((balance.free + balance.locked) * factor) / factor;
  const hasPosition = realHoldVol > 0;

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
        side: String(o.side).toUpperCase() === 'SELL' ? 2 : 1, // 1 buy, 2 sell — read from MEXC, not assumed (see header comment)
        orderType: isMarket ? 5 : 1,
        state: classify(o),
        createTime: Number(o.time),
      };
    });

    // Same "since the last Execute" scoping as the Futures integration: the
    // most recent BUY-side market order marks the start of the current run.
    // Scoped to BUY specifically (unlike the earlier version) so a market
    // SELL — e.g. from Close Position — can't shift this boundary past the
    // ladder's own buys.
    const marketBuys = all.filter((o) => o.orderType === 5 && o.side === 1);
    if (marketBuys.length > 0) sinceTime = Math.max(...marketBuys.map((o) => o.createTime));

    const scoped = sinceTime !== null ? all.filter((o) => o.createTime >= sinceTime) : all;
    // The fill/resting table and the avg-entry-if-filled column are both
    // framed around "how did this run's buy ladder progress" — a sell isn't
    // a ladder rung, so it's excluded here rather than risk being misread
    // as one.
    orders = scoped.filter((o) => o.side === 1).sort((a, b) => b.price - a.price);
  } catch (err) {
    res.status(502).json({ error: 'Failed to reach MEXC.', detail: String(err.message || err) });
    return;
  }

  // Cost basis for P&L, reconstructed from this run's filled BUY orders —
  // only available within the 7-day order-history window (see header
  // comment). hasPosition/realHoldVol above never depend on this; a
  // position held longer than that still shows as open, just without an avg
  // entry to compute P&L from.
  const filled = orders.filter((o) => o.state === 3);
  const filledVol = filled.reduce((s, o) => s + o.dealVol, 0);
  const filledNotional = filled.reduce((s, o) => s + o.dealVol * o.dealAvgPrice, 0);
  const holdAvgPrice = filledVol > 0 ? filledNotional / filledVol : null;

  let pnl = null;
  if (hasPosition && holdAvgPrice !== null) {
    try {
      const tickerRes = await fetch(`${BASE_URL}/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}`);
      const ticker = await tickerRes.json();
      const currentPrice = ticker && ticker.price ? Number(ticker.price) : null;
      if (currentPrice) {
        const costBasis = holdAvgPrice * realHoldVol; // no leverage — cost basis IS the capital at risk
        const { dollar, percent } = computePnl({
          holdAvgPrice,
          holdVol: realHoldVol,
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
    position: hasPosition ? { holdAvgPrice, holdVol: realHoldVol } : null,
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
// module.exports must stay a plain invocable function — that's what Vercel
// calls as the serverless handler. `classify` is attached to it as a
// property (functions are objects) purely so test/spot-status-classify.test.js
// can exercise it directly without duplicating its logic or standing up a
// fake MEXC server.
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

module.exports.classify = classify;
