// Vercel serverless function: proxies the Futures/Leveraged ticker for
// whichever exchange the request asks for (avoids browser CORS block).
// GET /api/price?symbol=CRVUSDT&exchange=bybit   (Bybit linear, one symbol
//   format everywhere — see index.html's toFuturesSymbol)
// GET /api/price?symbol=CRV_USDT&exchange=mexc    (MEXC futures — underscore
//   symbol format, unlike its own Spot symbols)
// `exchange` defaults to "bybit" when omitted, for back-compat with any
// caller that predates the MEXC option.
//
// Both are public endpoints, no auth needed.
const { bybitPublicGet } = require('../bybitClient.js');
const { getFuturesTicker, getFuturesKline, getFuturesFundingHistory } = require('../mexcClient.js');

// Optional kline params, used by the demo simulator (index.html's
// demoFetchCandles): `interval` in Bybit's vocabulary and `start` in ms.
// Without them the chart's original fixed 4h behaviour is unchanged.
const KLINE_INTERVALS = new Set(['1', '5', '15', '60', '240', 'D']);

// Read-only 4h candlestick data for the Position Status chart -- fixed
// interval, no other timeframe exposed anywhere in the UI (see index.html's
// renderStatusChart). Public endpoint, no auth, same "proxy through our own
// API to dodge browser CORS" reasoning as the ticker branch below. Kline
// data is intentionally NOT cached/deduped across requests -- the chart
// only re-fetches on the same cadence as the rest of Position Status
// (page load / Refresh status / after Execute), which is infrequent enough
// that a plain per-request fetch is fine.
async function handleKline(req, res, symbol, exchange) {
  const limit = Math.min(Math.max(Number(req.query.limit) || 150, 10), 1000);
  const interval = KLINE_INTERVALS.has(String(req.query.interval)) ? String(req.query.interval) : '240';
  const startMs = Number(req.query.start) > 0 ? Number(req.query.start) : undefined;
  try {
    if (exchange === 'mexc') {
      const candles = await getFuturesKline(symbol, limit, { interval, startMs });
      res.status(200).json({ candles });
      return;
    }

    const data = await bybitPublicGet('/v5/market/kline', { category: 'linear', symbol, interval, limit, start: startMs });
    if (!data || data.retCode !== 0 || !Array.isArray(data.result?.list)) {
      res.status(502).json({ error: data?.retMsg ? `Bybit: ${data.retMsg}` : 'Could not fetch candles from Bybit linear.' });
      return;
    }
    // Bybit returns newest-first -- reverse to ascending time, which is
    // what the charting library on the client expects.
    const candles = data.result.list
      .map((c) => ({ time: Math.floor(Number(c[0]) / 1000), open: Number(c[1]), high: Number(c[2]), low: Number(c[3]), close: Number(c[4]) }))
      .reverse();
    res.status(200).json({ candles });
  } catch (err) {
    res.status(502).json({ error: `Failed to reach ${exchange === 'mexc' ? 'MEXC' : 'Bybit'} for candle data.`, detail: String(err.message || err) });
  }
}

// Settled funding rates since `start` (ms), as [{ time, rate }] ascending.
// Public data; the demo simulator charges these on simulated perp positions.
async function handleFunding(req, res, symbol, exchange) {
  const startMs = Number(req.query.start) || Date.now() - 7 * 24 * 60 * 60 * 1000;
  try {
    if (exchange === 'mexc') {
      res.status(200).json({ funding: await getFuturesFundingHistory(symbol, startMs) });
      return;
    }
    // Bybit returns at most 200 rows per call (~66 days at 8h); newest first.
    const data = await bybitPublicGet('/v5/market/funding/history', { category: 'linear', symbol, startTime: startMs, endTime: Date.now(), limit: 200 });
    if (!data || data.retCode !== 0 || !Array.isArray(data.result?.list)) {
      res.status(502).json({ error: data?.retMsg ? `Bybit: ${data.retMsg}` : 'Could not fetch funding history from Bybit.' });
      return;
    }
    const funding = data.result.list
      .map((f) => ({ time: Number(f.fundingRateTimestamp), rate: Number(f.fundingRate) }))
      .sort((a, b) => a.time - b.time);
    res.status(200).json({ funding });
  } catch (err) {
    res.status(502).json({ error: `Failed to reach ${exchange === 'mexc' ? 'MEXC' : 'Bybit'} for funding history.`, detail: String(err.message || err) });
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { symbol } = req.query;
  const exchange = String(req.query.exchange || 'bybit').toLowerCase();
  if (!symbol) {
    res.status(400).json({ error: 'symbol query param is required, e.g. ?symbol=CRVUSDT' });
    return;
  }

  if (req.query.kline === '1') {
    await handleKline(req, res, String(symbol).toUpperCase(), exchange);
    return;
  }

  if (req.query.funding === '1') {
    await handleFunding(req, res, String(symbol).toUpperCase(), exchange);
    return;
  }

  try {
    if (exchange === 'mexc') {
      const ticker = await getFuturesTicker(String(symbol));
      if (!ticker) {
        res.status(404).json({ error: `No ticker found for symbol "${symbol}" on MEXC futures.` });
        return;
      }
      res.status(200).json({
        symbol: ticker.symbol,
        lastPrice: ticker.lastPrice,
        bid1: ticker.bid1,
        ask1: ticker.ask1,
        indexPrice: ticker.indexPrice,
        fairPrice: ticker.fairPrice,
        fundingRate: ticker.fundingRate,
        timestamp: ticker.timestamp,
      });
      return;
    }

    const data = await bybitPublicGet('/v5/market/tickers', { category: 'linear', symbol: String(symbol).toUpperCase() });
    const ticker = data && data.retCode === 0 && Array.isArray(data.result?.list) ? data.result.list[0] : null;

    if (!ticker) {
      res.status(404).json({ error: `No ticker found for symbol "${symbol}" on Bybit linear.` });
      return;
    }

    res.status(200).json({
      symbol: ticker.symbol,
      lastPrice: ticker.lastPrice,
      bid1: ticker.bid1Price,
      ask1: ticker.ask1Price,
      indexPrice: ticker.indexPrice,
      fairPrice: ticker.markPrice, // Bybit's equivalent of MEXC's "fairPrice" is markPrice
      fundingRate: ticker.fundingRate,
      timestamp: data.time,
    });
  } catch (err) {
    res.status(502).json({ error: `Failed to reach ${exchange === 'mexc' ? 'MEXC' : 'Bybit'}.`, detail: String(err) });
  }
};
