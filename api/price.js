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
const { getFuturesTicker } = require('../mexcClient.js');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { symbol } = req.query;
  const exchange = String(req.query.exchange || 'bybit').toLowerCase();
  if (!symbol) {
    res.status(400).json({ error: 'symbol query param is required, e.g. ?symbol=CRVUSDT' });
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
