// Shared MEXC REST client — signing + fetch wrappers used by every api/*.js
// file that talks to MEXC, on both the Leveraged/Futures side (api/price.js,
// api/balance.js, api/execute.js, api/close.js, api/status.js) and the Spot
// side (api/spot/[action].js). Mirrors bybitClient.js's shape/exports so
// each api/*.js file can dispatch on an `exchange` param and call the
// matching client with parallel function names, but MEXC genuinely needs
// TWO different signing schemes (unlike Bybit's one scheme for everything):
//
// Futures (per MEXC's futures integration guide):
//   target = accessKey + requestTimeMs + JSON.stringify(body)   [POST]
//   target = accessKey + requestTimeMs + sortedQueryString      [GET]
//   signature = HMAC_SHA256(secretKey, target) -> hex
//   headers: ApiKey, Request-Time, Signature
//
// Spot v3 (per MEXC's spot v3 docs):
//   totalParams = "key1=value1&key2=value2..." (params as sent, NOT sorted)
//   signature = HMAC_SHA256(secretKey, totalParams) -> hex, sent as an extra
//     `signature` param appended to the query string (even on POST/DELETE —
//     MEXC spot v3 takes params in the query string, not a JSON body)
//   header: X-MEXC-APIKEY (not the Futures scheme's ApiKey/Request-Time/
//     Signature headers)
//   every SIGNED request needs `timestamp` (ms); `recvWindow` set generously
//     here to absorb serverless cold-start / network latency.
//   Since Feb 2024, MEXC's API gateway rejects every spot v3 request unless
//   Content-Type is exactly "application/json", even though params still
//   travel in the query string, not a real JSON body (tripped up ccxt too —
//   ccxt/ccxt#21345). The fix is just sending that header, not an actual
//   JSON body.
//
// Deliberately lives at the repo root, NOT under api/ — same reasoning as
// calc.js/bybitClient.js: a plain Vercel deployment turns every file under
// api/ into its own routed serverless function, so a shared helper module
// has to live outside that directory.

const crypto = require('crypto');

const FUTURES_PRIVATE_BASE_URL = 'https://api.mexc.com';
const FUTURES_CONTRACT_DETAIL_URL = 'https://contract.mexc.com/api/v1/contract/detail';
const FUTURES_TICKER_URL = 'https://contract.mexc.com/api/v1/contract/ticker';
const SPOT_BASE_URL = 'https://api.mexc.com';
const SPOT_RECV_WINDOW = 10000;
// A few minutes shy of the true 7-day boundary, not exactly 7 days: MEXC
// hard-rejects allOrders with "Only 7 day's data can be queried" if the gap
// between `startTime` and whatever it treats as "now" exceeds 7 days by even
// a little — and the gap between this serverless function computing
// Date.now() and MEXC's server actually evaluating that check (network
// latency, serverless cold start, clock drift) is enough to trip an exact
// 7*24*60*60*1000 window in practice.
const SPOT_SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000 - 5 * 60 * 1000;

function futuresSign(secretKey, accessKey, timestamp, paramString) {
  return crypto.createHmac('sha256', secretKey).update(accessKey + timestamp + paramString).digest('hex');
}

async function futuresPrivatePost(path, body, apiKey, secretKey) {
  const timestamp = Date.now().toString();
  const paramString = JSON.stringify(body || {});
  const signature = futuresSign(secretKey, apiKey, timestamp, paramString);
  const res = await fetch(`${FUTURES_PRIVATE_BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ApiKey: apiKey, 'Request-Time': timestamp, Signature: signature },
    body: paramString,
  });
  try {
    return await res.json();
  } catch {
    throw new Error(`MEXC returned a non-JSON response (HTTP ${res.status}).`);
  }
}

async function futuresPrivateGet(path, params, apiKey, secretKey) {
  const timestamp = Date.now().toString();
  const paramString = Object.keys(params || {})
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  const signature = futuresSign(secretKey, apiKey, timestamp, paramString);
  const qs = paramString ? `?${paramString}` : '';
  const res = await fetch(`${FUTURES_PRIVATE_BASE_URL}${path}${qs}`, {
    headers: { ApiKey: apiKey, 'Request-Time': timestamp, Signature: signature },
  });
  try {
    return await res.json();
  } catch {
    throw new Error(`MEXC returned a non-JSON response (HTTP ${res.status}).`);
  }
}

function futuresOk(data) {
  return !!data && data.success === true;
}

function futuresErrMsg(data, fallback) {
  if (!data) return fallback;
  return data.message ? `MEXC: ${data.message} (code ${data.code})` : fallback;
}

async function getFuturesContractDetail(symbol) {
  const res = await fetch(`${FUTURES_CONTRACT_DETAIL_URL}?symbol=${encodeURIComponent(symbol)}`);
  const detail = await res.json();
  if (!detail || detail.success !== true || !detail.data) {
    throw new Error(`No contract spec found for "${symbol}" on MEXC futures.`);
  }
  return detail.data;
}

async function getFuturesTicker(symbol) {
  const res = await fetch(`${FUTURES_TICKER_URL}?symbol=${encodeURIComponent(symbol)}`);
  const data = await res.json();
  if (!data || data.success !== true || !data.data) return null;
  return data.data;
}


const JSON_CONTENT_TYPE_HEADER = { 'Content-Type': 'application/json' };

function spotBuildParamString(params) {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
}

function spotSign(secretKey, totalParams) {
  return crypto.createHmac('sha256', secretKey).update(totalParams).digest('hex');
}

async function spotSignedRequest(method, path, params, apiKey, secretKey) {
  const allParams = { ...params, timestamp: Date.now(), recvWindow: SPOT_RECV_WINDOW };
  const paramString = spotBuildParamString(allParams);
  const signature = spotSign(secretKey, paramString);
  const res = await fetch(`${SPOT_BASE_URL}${path}?${paramString}&signature=${signature}`, {
    method,
    headers: { 'X-MEXC-APIKEY': apiKey, ...JSON_CONTENT_TYPE_HEADER },
  });
  try {
    return await res.json();
  } catch {
    throw new Error(`MEXC returned a non-JSON response (HTTP ${res.status}).`);
  }
}

const spotPrivateGet = (path, params, apiKey, secretKey) => spotSignedRequest('GET', path, params, apiKey, secretKey);
const spotPrivatePost = (path, params, apiKey, secretKey) => spotSignedRequest('POST', path, params, apiKey, secretKey);
const spotPrivateDelete = (path, params, apiKey, secretKey) => spotSignedRequest('DELETE', path, params, apiKey, secretKey);

async function getSpotTicker(symbol) {
  const res = await fetch(`${SPOT_BASE_URL}/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}`);
  return res.json();
}


// MEXC's spot v3 docs don't document a stepSize/tickSize filter the way
// Binance's does — precision comes from flat baseAssetPrecision/
// quotePrecision fields on /api/v3/exchangeInfo instead. Shared by
// api/spot/[action].js's execute/status/close actions.
async function getSpotSymbolPrecision(symbol) {
  let baseAssetPrecision = 6;
  let quotePrecision = 8;
  try {
    const detailRes = await fetch(`${SPOT_BASE_URL}/api/v3/exchangeInfo?symbol=${encodeURIComponent(symbol)}`);
    const detail = await detailRes.json();
    const info = Array.isArray(detail?.symbols) ? detail.symbols.find((s) => s.symbol === symbol) : detail;
    if (info) {
      if (Number.isFinite(Number(info.baseAssetPrecision))) baseAssetPrecision = Number(info.baseAssetPrecision);
      if (Number.isFinite(Number(info.quotePrecision))) quotePrecision = Number(info.quotePrecision);
    }
  } catch {
    // keep defaults — an individual order still gets rejected per-row if the
    // rounding is actually wrong, rather than failing the whole caller
  }
  return { baseAssetPrecision, quotePrecision };
}

// Client-supplied order tag so this app can tell its own ladder orders apart
// from anything placed manually on MEXC directly — same reasoning and same
// tag prefix as bybitClient.js's makeOrderLinkId/isAppOrderLinkId, just
// carried by MEXC's own client-order-id fields instead of Bybit's
// orderLinkId: `externalOid` on Futures order/create, `newClientOrderId` on
// Spot order (max 32 chars — this format comfortably fits: "ladderapp-" (10)
// + a 13-digit ms timestamp + "-" + a 1-2 digit step number).
const APP_ORDER_TAG = 'ladderapp';

function makeAppOrderTag(step) {
  return `${APP_ORDER_TAG}-${Date.now()}-${step}`;
}

function isAppOrderTag(tag) {
  return typeof tag === 'string' && tag.startsWith(`${APP_ORDER_TAG}-`);
}

module.exports = {
  // Futures
  futuresPrivateGet,
  futuresPrivatePost,
  futuresOk,
  futuresErrMsg,
  getFuturesContractDetail,
  getFuturesTicker,
  // Spot
  spotPrivateGet,
  spotPrivatePost,
  spotPrivateDelete,
  getSpotTicker,
  getSpotSymbolPrecision,
  SPOT_SEVEN_DAYS_MS,
  // Shared
  makeAppOrderTag,
  isAppOrderTag,
};
