// Vercel serverless function: proxies MEXC futures ticker (avoids browser CORS block)
// GET /api/price?symbol=CRV_USDT
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { symbol } = req.query;
  if (!symbol) {
    res.status(400).json({ error: 'symbol query param is required, e.g. ?symbol=CRV_USDT' });
    return;
  }

  try {
    const upstream = await fetch(
      `https://contract.mexc.com/api/v1/contract/ticker?symbol=${encodeURIComponent(symbol)}`
    );
    const data = await upstream.json();

    if (!data || data.success !== true || !data.data) {
      res.status(404).json({ error: `No ticker found for symbol "${symbol}" on MEXC futures.` });
      return;
    }

    res.status(200).json({
      symbol: data.data.symbol,
      lastPrice: data.data.lastPrice,
      bid1: data.data.bid1,
      ask1: data.data.ask1,
      indexPrice: data.data.indexPrice,
      fairPrice: data.data.fairPrice,
      fundingRate: data.data.fundingRate,
      timestamp: data.data.timestamp,
    });
  } catch (err) {
    res.status(502).json({ error: 'Failed to reach MEXC.', detail: String(err) });
  }
};
