// Shared Bybit V5 REST client — signing + fetch wrappers used by every
// api/*.js file (both the Leveraged/linear endpoints and api/spot/[action].js).
//
// Deliberately lives at the repo root, NOT under api/ — same reasoning as
// calc.js/statusCalc.js: a plain Vercel deployment (no framework) turns every
// file under api/ into its own routed serverless function, so a shared helper
// module has to live outside that directory or Vercel would try to treat it
// as an endpoint too.
//
// Auth per Bybit's V5 integration guide (one scheme for every category —
// linear, spot, etc. — unlike MEXC, which used two different signing
// schemes for Futures vs Spot):
//   GET:  signPayload = timestamp + apiKey + recvWindow + queryString
//   POST: signPayload = timestamp + apiKey + recvWindow + JSON.stringify(body)
//   signature = HMAC_SHA256(secretKey, signPayload) -> lowercase hex
//   headers: X-BAPI-API-KEY, X-BAPI-TIMESTAMP, X-BAPI-SIGN, X-BAPI-RECV-WINDOW
//
// Response envelope: every V5 call returns { retCode, retMsg, result, ... }.
// retCode === 0 means success; anything else is an error, with retMsg
// carrying the human-readable reason. bybitOk()/bybitErr() below standardize
// reading that envelope the way the old code checked MEXC's `success`/`code`.

const crypto = require('crypto');

const BASE_URL = 'https://api.bybit.com';
const RECV_WINDOW = '10000'; // generous, same reasoning as the old MEXC recvWindow: absorb serverless cold-start/network latency

function sign(secretKey, timestamp, apiKey, recvWindow, payload) {
  return crypto.createHmac('sha256', secretKey).update(timestamp + apiKey + recvWindow + payload).digest('hex');
}

function buildQueryString(params) {
  return Object.entries(params || {})
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
}

async function parseJson(res) {
  try {
    return await res.json();
  } catch {
    throw new Error(`Bybit returned a non-JSON response (HTTP ${res.status}).`);
  }
}

// Signed GET — params travel in the query string, which is exactly what
// gets signed (Bybit's GET signature payload IS the literal query string).
async function bybitGet(path, params, apiKey, secretKey) {
  const timestamp = Date.now().toString();
  const queryString = buildQueryString(params);
  const signature = sign(secretKey, timestamp, apiKey, RECV_WINDOW, queryString);
  const url = `${BASE_URL}${path}${queryString ? `?${queryString}` : ''}`;
  const res = await fetch(url, {
    headers: {
      'X-BAPI-API-KEY': apiKey,
      'X-BAPI-TIMESTAMP': timestamp,
      'X-BAPI-SIGN': signature,
      'X-BAPI-RECV-WINDOW': RECV_WINDOW,
    },
  });
  return parseJson(res);
}

// Signed POST — body travels as JSON, and that exact JSON string is what
// gets signed.
async function bybitPost(path, body, apiKey, secretKey) {
  const timestamp = Date.now().toString();
  const bodyString = JSON.stringify(body || {});
  const signature = sign(secretKey, timestamp, apiKey, RECV_WINDOW, bodyString);
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-BAPI-API-KEY': apiKey,
      'X-BAPI-TIMESTAMP': timestamp,
      'X-BAPI-SIGN': signature,
      'X-BAPI-RECV-WINDOW': RECV_WINDOW,
    },
    body: bodyString,
  });
  return parseJson(res);
}

// Public (unauthenticated) GET — market data endpoints (tickers,
// instruments-info, risk-limit) need no signature at all.
async function bybitPublicGet(path, params) {
  const queryString = buildQueryString(params);
  const url = `${BASE_URL}${path}${queryString ? `?${queryString}` : ''}`;
  const res = await fetch(url);
  return parseJson(res);
}

function bybitOk(data) {
  return !!data && data.retCode === 0;
}

function bybitErrMsg(data, fallback) {
  if (!data) return fallback;
  return data.retMsg ? `Bybit: ${data.retMsg} (retCode ${data.retCode})` : fallback;
}

// A handful of Bybit "setting" endpoints (set-leverage, switch-isolated)
// return a specific retCode when the account is already in the requested
// state — that's not a failure, it's a no-op confirming the setting already
// matches what we wanted, so callers should treat these as success rather
// than surfacing an error every time (same idea as the old MEXC code just
// re-sending idempotent requests, except Bybit is explicit about it via
// retCode instead of silently no-opping).
// 110043: "leverage not modified" (set-leverage)
// 110026: "cross/isolated margin mode is not modified" (switch-isolated)
const ALREADY_SET_RET_CODES = new Set([110043, 110026]);

function bybitOkOrAlreadySet(data) {
  return bybitOk(data) || (data && ALREADY_SET_RET_CODES.has(data.retCode));
}

// --- Durable order history (fixes the "vanishing order" bug below) --------
//
// GET /v5/order/realtime's openOnly:1 mode ("recently closed orders") looks
// like history but isn't: Bybit's own docs say it's a rolling cache of up to
// 500 records that gets WIPED whenever Bybit restarts that service,
// independent of how old the order is. A position's opening market buy (or
// any filled/canceled order) can disappear from it at any time for reasons
// that have nothing to do with age -- which is exactly what produced
// api/status.js's "Could not find the market buy that started this run"
// message even for a position only a day or two old. GET /v5/order/history
// is Bybit's real, durable order history (2 years retention) and is what
// the functions below use instead -- its only real constraint is that each
// call's startTime..endTime span can't exceed 7 days, so a lookup that
// might reach back further than that has to walk backward in 7-day windows.
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// Fetches ONE /v5/order/history window (<=7 days), following Bybit's cursor
// pagination until that window is exhausted. Throws on a Bybit-side error
// so callers can fold it into whatever ordersError/catch handling they
// already have -- same convention as bybitGet's callers use bybitOk/bybitErrMsg.
async function bybitGetOrderHistoryWindow(category, symbol, startTime, endTime, apiKey, secretKey) {
  let cursor;
  let all = [];
  let guard = 0; // defensive cap against a pathological/looping cursor; a real window never needs more than a couple of pages
  do {
    const params = { category, symbol, startTime, endTime, limit: 50 };
    if (cursor) params.cursor = cursor;
    const data = await bybitGet('/v5/order/history', params, apiKey, secretKey);
    if (!bybitOk(data)) throw new Error(bybitErrMsg(data, 'Bybit rejected the order-history request.'));
    all = all.concat(data.result?.list || []);
    cursor = data.result?.nextPageCursor || undefined;
    guard += 1;
  } while (cursor && guard < 20);
  return all;
}

// Walks /v5/order/history backward from now in 7-day windows, merging every
// window's raw orders, until `isOpeningOrder` matches one of them (the
// market buy that started the current run) or `maxLookbackMs` is exhausted.
// Because the walk starts at "now" and stops the moment the opening order is
// found, everything more recent than it is guaranteed to already be in the
// merged result -- no separate forward pass is needed to fill in the "since
// last Execute" range. Returns the raw (un-normalized) Bybit order objects;
// callers map them into this app's own shape the same way they already map
// /v5/order/realtime's results.
async function bybitFindClosedOrderHistorySinceOpening(category, symbol, apiKey, secretKey, isOpeningOrder, maxLookbackMs) {
  let collected = [];
  let windowEnd = Date.now();
  const floor = windowEnd - maxLookbackMs;
  let windows = 0;
  while (windowEnd > floor) {
    const windowStart = Math.max(windowEnd - SEVEN_DAYS_MS, floor);
    const windowOrders = await bybitGetOrderHistoryWindow(category, symbol, windowStart, windowEnd, apiKey, secretKey);
    collected = collected.concat(windowOrders);
    windows += 1;
    if (windowOrders.some(isOpeningOrder)) break;
    windowEnd = windowStart;
  }
  return { orders: collected, windows };
}

// Computes real usable/free USDT from a UTA wallet-balance USDT coin entry.
//
// The account-level `totalAvailableBalance` field (returned alongside the
// coin list on /v5/account/wallet-balance) looks like the obvious field to
// use for this, but it comes back as an EMPTY STRING for some accounts/
// margin configurations even though the coin-level fields are fully
// populated — confirmed live: for this app's account it was `""`, silently
// becoming 0 after Number(), while the coin entry had real numbers. So
// don't trust that field at all; compute free balance directly from the
// coin entry instead, the same way Bybit's own UI derives "available to
// trade":
//   free = walletBalance - totalPositionIM - totalOrderIM - locked
// (walletBalance minus margin already committed to open positions, margin
// reserved by open orders, and anything otherwise locked.) Verified against
// a real account: 1173.609 - 595.675 - 0 - 0 = 577.934, matching the
// $577.93 Bybit's own UI showed almost exactly.
function usdtFreeFromCoin(entry) {
  if (!entry) return 0;
  const walletBalance = Number(entry.walletBalance) || 0;
  const positionIM = Number(entry.totalPositionIM) || 0;
  const orderIM = Number(entry.totalOrderIM) || 0;
  const locked = Number(entry.locked) || 0;
  return Math.max(0, walletBalance - positionIM - orderIM - locked);
}

// Client-supplied order tag so this app can tell its own ladder orders apart
// from anything placed manually on Bybit directly (or by another tool).
// Added 2026-08-24 after the user asked for a way to prefer showing an
// app-managed ladder position over an unrelated, manually-opened one (e.g.
// the existing HBAR Leveraged position, opened outside this app) when
// deciding which tab to land on at page load. Every order this app places
// (Leveraged and Spot alike) gets tagged via Bybit's `orderLinkId` — a
// client order id Bybit stores and echoes back verbatim on every order
// lookup, but never interprets or acts on itself — with this prefix.
// api/status.js and api/spot/[action].js's status action then check whether
// the market buy that opened the current run carries the tag, and report
// that back as `openedByApp` in their response.
const APP_ORDER_TAG = 'ladderapp';

// Builds a unique, app-tagged orderLinkId for one order in a ladder run.
// Bybit requires orderLinkId to be unique per account; timestamp + the
// order's own step number is enough entropy within a single execute run —
// orders are placed sequentially with a pacing delay between them anyway
// (ORDER_SPACING_MS in both api/execute.js and api/spot/[action].js), so two
// orders in the same run never share a millisecond, and the step number
// guards against it even if they did.
function makeOrderLinkId(step) {
  return `${APP_ORDER_TAG}-${Date.now()}-${step}`;
}

// True if a given orderLinkId (as echoed back by Bybit on any order lookup)
// was one this app itself set via makeOrderLinkId above — i.e. this order
// was placed through this calculator, not manually on Bybit or by anything
// else.
function isAppOrderLinkId(orderLinkId) {
  return typeof orderLinkId === 'string' && orderLinkId.startsWith(`${APP_ORDER_TAG}-`);
}

module.exports = {
  BASE_URL,
  bybitGet,
  bybitPost,
  bybitPublicGet,
  bybitOk,
  bybitErrMsg,
  bybitOkOrAlreadySet,
  usdtFreeFromCoin,
  makeOrderLinkId,
  isAppOrderLinkId,
  bybitGetOrderHistoryWindow,
  bybitFindClosedOrderHistorySinceOpening,
};
