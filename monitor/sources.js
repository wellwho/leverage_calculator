// Network layer for the monitor: public market data from Bybit, Binance and
// OKX. No API keys and no account access, by design: the monitor watches the
// market, not anyone's positions. Everything here returns plain
// ascending-by-time series in the shapes signals.js expects; all scoring
// stays in signals.js.

// Bybit V5 wraps every response in { retCode, retMsg, result }; retCode 0 = success.
const bybitOk = (data) => !!data && data.retCode === 0;
const bybitErrMsg = (data, fallback) => (data && data.retMsg ? `Bybit: ${data.retMsg} (retCode ${data.retCode})` : fallback);
const { fundingTo8h } = require('./signals');

const BYBIT = 'https://api.bybit.com';
const BINANCE = 'https://fapi.binance.com';
const OKX = 'https://www.okx.com';
const TIMEOUT_MS = 15000;
const HISTORY_HOURS = 720; // ~30 days of hourly points

async function getJson(url, params) {
  const qs = new URLSearchParams(Object.entries(params || {}).filter(([, v]) => v !== undefined)).toString();
  const res = await fetch(qs ? `${url}?${qs}` : url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${url} returned non-JSON (HTTP ${res.status}): ${text.slice(0, 120)}`);
  }
  if (!res.ok) throw new Error(`${url} HTTP ${res.status}: ${data.msg || text.slice(0, 120)}`);
  return data;
}

async function bybitPublic(path, params) {
  const data = await getJson(`${BYBIT}${path}`, params);
  if (!bybitOk(data)) throw new Error(bybitErrMsg(data, `Bybit ${path} failed.`));
  return data.result;
}

// Follows Bybit's cursor pagination until `want` points are collected.
async function bybitPaged(path, params, want) {
  let out = [];
  let cursor;
  for (let page = 0; page < 10 && out.length < want; page += 1) {
    const result = await bybitPublic(path, { ...params, cursor });
    out = out.concat(result.list || []);
    cursor = result.nextPageCursor;
    if (!cursor || !(result.list || []).length) break;
  }
  return out;
}

const asc = (arr) => arr.sort((a, b) => a.t - b.t);

// --- Bybit market data (linear perpetual) ------------------------------------

async function bybitMarket(symbol) {
  const [tickerRes, instrRes, oiRaw, fundingRes, ratioRaw, klineRes, premiumRes] = await Promise.all([
    bybitPublic('/v5/market/tickers', { category: 'linear', symbol }),
    bybitPublic('/v5/market/instruments-info', { category: 'linear', symbol }),
    bybitPaged('/v5/market/open-interest', { category: 'linear', symbol, intervalTime: '1h', limit: 200 }, HISTORY_HOURS),
    bybitPublic('/v5/market/funding/history', { category: 'linear', symbol, limit: 200 }),
    bybitPaged('/v5/market/account-ratio', { category: 'linear', symbol, period: '1h', limit: 500 }, HISTORY_HOURS),
    // 168 extra hours so the 7-day average in scoreExtension covers the whole window.
    bybitPublic('/v5/market/kline', { category: 'linear', symbol, interval: '60', limit: 1000 }),
    bybitPublic('/v5/market/premium-index-price-kline', { category: 'linear', symbol, interval: '60', limit: 1000 }),
  ]);
  const ticker = tickerRes.list && tickerRes.list[0];
  if (!ticker) throw new Error(`${symbol} is not listed on Bybit linear.`);
  const intervalHours = (Number(instrRes.list?.[0]?.fundingInterval) || 480) / 60;
  return {
    price: Number(ticker.lastPrice),
    price24hPct: Number(ticker.price24hPcnt),
    oiValueUsd: Number(ticker.openInterestValue),
    funding8h: fundingTo8h(ticker.fundingRate, intervalHours),
    fundingHistory8h: (fundingRes.list || []).map((f) => fundingTo8h(f.fundingRate, intervalHours)),
    oi: asc(oiRaw.map((p) => ({ t: Number(p.timestamp), oi: Number(p.openInterest) }))),
    longRatio: asc(ratioRaw.map((p) => ({ t: Number(p.timestamp), v: Number(p.buyRatio) }))),
    // Kline rows: [start, open, high, low, close, volume, turnover], newest first.
    // The newest candle is still forming; drop it so every point is a closed hour.
    price1h: asc((klineRes.list || []).slice(1).map((k) => ({ t: Number(k[0]), close: Number(k[4]) }))),
    // Premium index (perp vs spot index) hourly closes, same newest-first/forming-candle shape.
    premium: asc((premiumRes.list || []).slice(1).map((k) => ({ t: Number(k[0]), v: Number(k[4]) }))),
  };
}

// --- Binance market data (USDⓈ-M perpetual) ----------------------------------
// Binance usually holds the most open interest, so leaving it out would miss
// most of the leverage on many symbols. Its /futures/data endpoints only go
// back 30 days and 500 points (≈21 days at 1h), which is enough. Not every
// symbol is listed; callers treat a failure here as "Binance unavailable".

let binanceFundingIntervals = null;

async function binanceFundingIntervalHours(symbol) {
  if (!binanceFundingIntervals) {
    const info = await getJson(`${BINANCE}/fapi/v1/fundingInfo`);
    binanceFundingIntervals = new Map(info.map((i) => [i.symbol, Number(i.fundingIntervalHours)]));
  }
  // fundingInfo only lists symbols whose interval was changed from the 8h default.
  return binanceFundingIntervals.get(symbol) || 8;
}

async function binanceMarket(symbol) {
  const hist = { symbol, period: '1h', limit: 500 };
  const [premium, oiRaw, topRaw, takerRaw, intervalHours, premiumKlines] = await Promise.all([
    getJson(`${BINANCE}/fapi/v1/premiumIndex`, { symbol }),
    getJson(`${BINANCE}/futures/data/openInterestHist`, hist),
    getJson(`${BINANCE}/futures/data/topLongShortPositionRatio`, hist),
    getJson(`${BINANCE}/futures/data/takerlongshortRatio`, hist),
    binanceFundingIntervalHours(symbol),
    getJson(`${BINANCE}/fapi/v1/premiumIndexKlines`, { symbol, interval: '1h', limit: 500 }),
  ]);
  return {
    oiValueUsd: Number(oiRaw.length ? oiRaw[oiRaw.length - 1].sumOpenInterestValue : NaN),
    funding8h: fundingTo8h(premium.lastFundingRate, intervalHours),
    oi: asc(oiRaw.map((p) => ({ t: Number(p.timestamp), oi: Number(p.sumOpenInterest) }))),
    topLongRatio: asc(topRaw.map((p) => ({ t: Number(p.timestamp), v: Number(p.longAccount) }))),
    taker: asc(takerRaw.map((p) => ({ t: Number(p.timestamp), buy: Number(p.buyVol), sell: Number(p.sellVol) }))),
    // Oldest first; the last kline is still forming, so drop it.
    premium: premiumKlines.slice(0, -1).map((k) => ({ t: Number(k[0]), v: Number(k[4]) })),
  };
}

// --- OKX market data (USDT-margined swap) ------------------------------------
// The third exchange in the video's aggregated OI and funding. Its premium
// history is per-tick rather than hourly, so OKX contributes OI and funding
// only. OI history pages back 100 hours per call via `end`.

async function okxGet(path, params) {
  const data = await getJson(`${OKX}${path}`, params);
  if (data.code !== '0') throw new Error(`OKX ${path}: ${data.msg || data.code}`);
  return data.data;
}

async function okxMarket(asset) {
  const instId = `${asset}-USDT-SWAP`;
  let rows = [];
  let end;
  for (let page = 0; page < 8 && rows.length < HISTORY_HOURS; page += 1) {
    const batch = await okxGet('/api/v5/rubik/stat/contracts/open-interest-history', { instId, period: '1H', limit: 100, end });
    if (!batch.length) break;
    rows = rows.concat(batch);
    end = batch[batch.length - 1][0];
  }
  const [funding] = await okxGet('/api/v5/public/funding-rate', { instId });
  const intervalHours = (Number(funding.fundingTime) - Number(funding.prevFundingTime)) / 3600000 || 8;
  // Rows: [ts, oi (contracts), oiCcy (coins), oiUsd], newest first. `end` is
  // exclusive, but dedupe anyway in case a page boundary repeats a row.
  const byT = new Map(rows.map((r) => [Number(r[0]), r]));
  const oi = asc([...byT.values()].map((r) => ({ t: Number(r[0]), oi: Number(r[2]) })));
  return {
    oiValueUsd: Number(rows.length ? rows[0][3] : NaN),
    funding8h: fundingTo8h(funding.fundingRate, intervalHours),
    oi,
  };
}

module.exports = { bybitMarket, binanceMarket, okxMarket };
