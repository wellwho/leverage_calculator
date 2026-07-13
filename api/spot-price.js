// Vercel serverless function: proxies MEXC's Spot ticker price (avoids browser
// CORS block). Public endpoint, no auth needed — separate from api/price.js,
// which is the Futures ticker (different base path, different response
// shape, and Spot symbols have no underscore: "CRVUSDT", not "CRV_USDT").
// GET /api/spot-price?symbol=CRVUSDT

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { symbol } = req.query;
  if (!symbol) {
    res.status(400).json({ error: 'symbol query param is required, e.g. ?symbol=CRVUSDT' });
    return;
  }

  try {
    const upstream = await fetch(`https://api.mexc.com/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}`);
    const data = await upstream.json();

    if (!data || !data.price) {
      res.status(404).json({ error: data?.msg || `No ticker found for symbol "${symbol}" on MEXC spot.` });
      return;
    }

    res.status(200).json({ symbol: data.symbol || symbol, lastPrice: data.price });
  } catch (err) {
    res.status(502).json({ error: 'Failed to reach MEXC.', detail: String(err) });
  }
};
