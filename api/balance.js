// Vercel serverless function: fetches the account's usable USDT balance for
// opening new leveraged positions, on whichever exchange the request asks
// for.
// GET /api/balance?currency=USDT&exchange=bybit|mexc  (defaults to "bybit")
//
// IMPORTANT account-model difference between the two: MEXC keeps genuinely
// separate Futures and Spot wallets, so "Futures available balance" and
// "Spot available balance" are two different numbers there — same as this
// app originally assumed. Bybit's Unified Trading Account (UTA) merges spot
// holdings and derivatives margin into ONE pot instead: opening a leveraged
// position and buying spot both draw from (and are capped by) the SAME
// `totalAvailableBalance`. So on Bybit this endpoint and api/spot/[action].js's
// `balance` action report figures derived from the same underlying
// wallet-balance call — they will typically show the same number. That's
// expected there, not a bug; on MEXC the two stay genuinely independent.
//
// Bybit auth: shared V5 HMAC scheme — see bybitClient.js.
// MEXC auth: Futures integration guide's ApiKey/Request-Time/Signature
// scheme — see mexcClient.js.
const { bybitGet, bybitOk, bybitErrMsg, usdtFreeFromCoin } = require('../bybitClient.js');
const { futuresPrivateGet, futuresOk, futuresErrMsg } = require('../mexcClient.js');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const exchange = String(req.query.exchange || 'bybit').toLowerCase();
  const currency = String(req.query.currency || 'USDT').toUpperCase();

  if (exchange === 'mexc') {
    const apiKey = process.env.MEXC_API_KEY;
    const secretKey = process.env.MEXC_API_SECRET;
    if (!apiKey || !secretKey) {
      res.status(500).json({
        error: 'MEXC_API_KEY and/or MEXC_API_SECRET are not set on the server. Add them in Vercel → Project Settings → Environment Variables, then redeploy.',
      });
      return;
    }
    try {
      const data = await futuresPrivateGet(`/api/v1/private/account/asset/${encodeURIComponent(currency)}`, {}, apiKey, secretKey);
      if (!futuresOk(data) || !data.data) {
        res.status(404).json({ error: futuresErrMsg(data, `No asset info for "${currency}" (check the key has "View Account Details" permission).`) });
        return;
      }
      res.status(200).json({
        currency: data.data.currency,
        availableBalance: data.data.availableBalance,
        availableOpen: data.data.availableOpen, // usable amount for opening new positions
        cashBalance: data.data.cashBalance,
        equity: data.data.equity,
      });
    } catch (err) {
      res.status(502).json({ error: 'Failed to reach MEXC.', detail: String(err.message || err) });
    }
    return;
  }

  const apiKey = process.env.BYBIT_API_KEY;
  const secretKey = process.env.BYBIT_API_SECRET;
  if (!apiKey || !secretKey) {
    res.status(500).json({
      error: 'BYBIT_API_KEY and/or BYBIT_API_SECRET are not set on the server. Add them in Vercel → Project Settings → Environment Variables, then redeploy.',
    });
    return;
  }

  try {
    const data = await bybitGet('/v5/account/wallet-balance', { accountType: 'UNIFIED', coin: currency }, apiKey, secretKey);
    const account = bybitOk(data) && Array.isArray(data.result?.list) ? data.result.list[0] : null;
    const coinEntry = account && Array.isArray(account.coin) ? account.coin.find((c) => c.coin === currency) : null;

    if (!account) {
      res.status(404).json({ error: bybitErrMsg(data, `No wallet info returned for "${currency}" (check the key has "Account" read permission).`) });
      return;
    }

    // Under UTA there's no separate "usable to open new positions" vs
    // "currently available" the way MEXC has — both draw on the same
    // account-level pool, so both fields below are the same number. Kept as
    // two fields only so index.html's existing `data.availableOpen` read
    // keeps working unchanged for both exchanges.
    //
    // NOTE: the account-level `totalAvailableBalance` field is unreliable —
    // it comes back as an empty string for some accounts (confirmed live on
    // this one) — so free balance is computed directly from the coin entry
    // instead. See bybitClient.js's usdtFreeFromCoin for the formula/why.
    const freeBalance = usdtFreeFromCoin(coinEntry);
    res.status(200).json({
      currency,
      availableBalance: freeBalance,
      availableOpen: freeBalance,
      cashBalance: coinEntry ? Number(coinEntry.walletBalance) : null,
      equity: Number(account.totalEquity),
    });
  } catch (err) {
    res.status(502).json({ error: 'Failed to reach Bybit.', detail: String(err.message || err) });
  }
};
