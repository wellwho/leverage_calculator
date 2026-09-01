// Single dynamic-route serverless function for all Spot endpoints — served
// at /api/spot/:action (e.g. /api/spot/price, /api/spot/execute),
// dispatching on req.query.action, and further dispatching on an `exchange`
// query/body param ("bybit" | "mexc", defaults to "bybit" for back-compat)
// so both exchanges' Spot markets share this one file. Kept as one file
// (rather than one per action, or one per exchange) for the same Vercel
// Hobby-plan function-count reason as before: 8 other functions
// (login/logout/config/price/balance/execute/close/status) + a multi-way
// split here would push this project's total over the 12-function cap;
// merged, the total stays at 9.
//
// Bybit auth: shared V5 HMAC scheme (X-BAPI-* headers) — see bybitClient.js.
// MEXC auth: Spot v3's totalParams+signature scheme (X-MEXC-APIKEY header) —
// see mexcClient.js. Unlike Bybit (one scheme for every category), MEXC uses
// a DIFFERENT scheme here than its own Futures integration (api/execute.js
// etc.) does.
//
// IMPORTANT account-model difference: Bybit's Unified Trading Account (UTA)
// has no separate "Spot wallet" — spot holdings and derivatives margin share
// one pool (see api/balance.js's header comment; the same applies here to
// the `balance` action's Bybit branch). MEXC keeps genuinely separate
// Futures and Spot wallets, so its `balance` branch reports a number
// independent of api/balance.js's MEXC branch.

const { bybitPublicGet, bybitGet, bybitPost, bybitOk, bybitErrMsg, usdtFreeFromCoin, makeOrderLinkId, isAppOrderLinkId, bybitFindClosedOrderHistorySinceOpening } = require('../../bybitClient.js');
const {
  spotPrivateGet,
  spotPrivatePost,
  spotPrivateDelete,
  getSpotTicker,
  getSpotSymbolPrecision,
  SPOT_SEVEN_DAYS_MS,
  makeAppOrderTag,
  isAppOrderTag,
} = require('../../mexcClient.js');
const { computePnl, scopeOrdersSinceOpeningMarketBuy } = require('../../statusCalc.js');

// Same reasoning/mechanism as api/status.js's HISTORY_LOOKBACK_MS -- see
// bybitClient.js's bybitFindClosedOrderHistorySinceOpening header comment.
const HISTORY_LOOKBACK_MS = 60 * 24 * 60 * 60 * 1000;


const ORDER_SPACING_MS = 550; // conservative pacing, carried over from the Leveraged integration's rate-limit caution

// =====================================================================
// ---- price ----------------------------------------------------------
// GET /api/spot/price?symbol=CRVUSDT&exchange=bybit|mexc (defaults bybit)
// Proxies the exchange's Spot ticker (avoids browser CORS block). Public
// endpoint, no auth needed on either exchange.
// =====================================================================
async function handlePrice(req, res, exchange) {
  const { symbol } = req.query;
  if (!symbol) {
    res.status(400).json({ error: 'symbol query param is required, e.g. ?symbol=CRVUSDT' });
    return;
  }

  if (exchange === 'mexc') {
    try {
      const data = await getSpotTicker(String(symbol));
      if (!data || !data.price) {
        res.status(404).json({ error: data?.msg || `No ticker found for symbol "${symbol}" on MEXC spot.` });
        return;
      }
      res.status(200).json({ symbol: data.symbol || symbol, lastPrice: data.price });
    } catch (err) {
      res.status(502).json({ error: 'Failed to reach MEXC.', detail: String(err) });
    }
    return;
  }

  try {
    const data = await bybitPublicGet('/v5/market/tickers', { category: 'spot', symbol: String(symbol).toUpperCase() });
    const ticker = bybitOk(data) && Array.isArray(data.result?.list) ? data.result.list[0] : null;
    if (!ticker) {
      res.status(404).json({ error: `No ticker found for symbol "${symbol}" on Bybit spot.` });
      return;
    }
    res.status(200).json({ symbol: ticker.symbol, lastPrice: ticker.lastPrice });
  } catch (err) {
    res.status(502).json({ error: 'Failed to reach Bybit.', detail: String(err) });
  }
}

// =====================================================================
// ---- balance ----------------------------------------------------------
// GET /api/spot/balance?asset=USDT&exchange=bybit|mexc
// =====================================================================

// Bybit: for USDT specifically, "usable" is computed directly from the coin
// entry via bybitClient.js's usdtFreeFromCoin — NOT the account-level
// totalAvailableBalance field (unreliable — see api/balance.js's header
// comment), and NOT plain walletBalance-locked (overstates what's free once
// margin is committed elsewhere in the same UTA pool). For any other asset,
// walletBalance-locked is the right figure — not shared with anything else.
async function getBybitUsdtCoinData(apiKey, secretKey) {
  const data = await bybitGet('/v5/account/wallet-balance', { accountType: 'UNIFIED', coin: 'USDT' }, apiKey, secretKey);
  const account = bybitOk(data) && Array.isArray(data.result?.list) ? data.result.list[0] : null;
  const coinEntry = account && Array.isArray(account.coin) ? account.coin.find((c) => c.coin === 'USDT') : null;
  return { data, account, coinEntry };
}

async function handleBalance(req, res, apiKey, secretKey, exchange) {
  const asset = String(req.query.asset || 'USDT').toUpperCase();

  if (exchange === 'mexc') {
    try {
      const data = await spotPrivateGet('/api/v3/account', {}, apiKey, secretKey);
      if (!data || !Array.isArray(data.balances)) {
        res.status(502).json({ error: data?.msg || `MEXC error code ${data?.code} — check the key has "Spot Account Read" permission.` });
        return;
      }
      const entry = data.balances.find((b) => b.asset === asset);
      res.status(200).json({ asset, free: entry ? Number(entry.free) : 0, locked: entry ? Number(entry.locked) : 0 });
    } catch (err) {
      res.status(502).json({ error: 'Failed to reach MEXC.', detail: String(err.message || err) });
    }
    return;
  }

  try {
    if (asset === 'USDT') {
      const { data, account, coinEntry } = await getBybitUsdtCoinData(apiKey, secretKey);
      if (!account) {
        res.status(502).json({ error: bybitErrMsg(data, 'Could not look up USDT balance (check the key has "Account" read permission).') });
        return;
      }
      res.status(200).json({ asset, free: usdtFreeFromCoin(coinEntry), locked: coinEntry ? Number(coinEntry.locked) : 0 });
      return;
    }

    const data = await bybitGet('/v5/account/wallet-balance', { accountType: 'UNIFIED', coin: asset }, apiKey, secretKey);
    const account = bybitOk(data) && Array.isArray(data.result?.list) ? data.result.list[0] : null;
    const entry = account && Array.isArray(account.coin) ? account.coin.find((c) => c.coin === asset) : null;
    if (!account) {
      res.status(502).json({ error: bybitErrMsg(data, `Could not look up ${asset} balance (check the key has "Account" read permission).`) });
      return;
    }
    const walletBalance = entry ? Number(entry.walletBalance) : 0;
    const locked = entry ? Number(entry.locked) : 0;
    res.status(200).json({ asset, free: Math.max(0, walletBalance - locked), locked });
  } catch (err) {
    res.status(502).json({ error: 'Failed to reach Bybit.', detail: String(err.message || err) });
  }
}

// Live USDT free-balance lookup, called right before sizing each order —
// returns null (meaning "couldn't determine live balance — fall back to the
// planned amount, unclamped") rather than 0 whenever the balance can't be
// confirmed, since a transient blip is NOT the same as a confirmed zero
// balance (see the header comment on the Bybit branch's original bugfix:
// treating a missing entry as zero silently dropped an entire ladder mid-run
// with no visible error).
async function getFreeUsdt(exchange, apiKey, secretKey) {
  if (exchange === 'mexc') {
    try {
      const data = await spotPrivateGet('/api/v3/account', {}, apiKey, secretKey);
      if (!data || !Array.isArray(data.balances)) return null;
      const entry = data.balances.find((b) => b.asset === 'USDT');
      return entry ? Number(entry.free) : 0;
    } catch {
      return null;
    }
  }
  try {
    const { account, coinEntry } = await getBybitUsdtCoinData(apiKey, secretKey);
    if (!account || !coinEntry) return null;
    return usdtFreeFromCoin(coinEntry);
  } catch {
    return null;
  }
}

// Free + locked balance of a single asset — shared by handleStatus (real
// position size) and handleClose (how much is actually sellable).
async function getAssetBalance(exchange, asset, apiKey, secretKey) {
  if (exchange === 'mexc') {
    try {
      const data = await spotPrivateGet('/api/v3/account', {}, apiKey, secretKey);
      if (!data || !Array.isArray(data.balances)) return null;
      const entry = data.balances.find((b) => b.asset === asset);
      return entry ? { free: Number(entry.free), locked: Number(entry.locked) } : { free: 0, locked: 0 };
    } catch {
      return null;
    }
  }
  try {
    const data = await bybitGet('/v5/account/wallet-balance', { accountType: 'UNIFIED', coin: asset }, apiKey, secretKey);
    const account = bybitOk(data) && Array.isArray(data.result?.list) ? data.result.list[0] : null;
    const entry = account && Array.isArray(account.coin) ? account.coin.find((c) => c.coin === asset) : null;
    if (!entry) return { free: 0, locked: 0 };
    const locked = Number(entry.locked);
    return { free: Math.max(0, Number(entry.walletBalance) - locked), locked };
  } catch {
    return null;
  }
}

// Symbol precision — shared by execute/close/status so quantities/prices
// land on values the exchange will accept. Bybit additionally returns a
// price tick size; MEXC's spot v3 docs don't document one (precision comes
// from flat baseAssetPrecision/quotePrecision fields instead — see
// mexcClient.js's getSpotSymbolPrecision), so tickSize comes back null there.
async function getSymbolPrecision(exchange, symbol) {
  if (exchange === 'mexc') {
    const { baseAssetPrecision, quotePrecision } = await getSpotSymbolPrecision(symbol);
    return { baseAssetPrecision, quotePrecision, tickSize: null };
  }
  let baseAssetPrecision = 6;
  let quotePrecision = 8;
  let tickSize = null;
  try {
    const detail = await bybitPublicGet('/v5/market/instruments-info', { category: 'spot', symbol });
    const info = bybitOk(detail) && Array.isArray(detail.result?.list) ? detail.result.list[0] : null;
    if (info?.lotSizeFilter) {
      const basePrecStr = info.lotSizeFilter.basePrecision;
      const quotePrecStr = info.lotSizeFilter.quotePrecision;
      if (basePrecStr) baseAssetPrecision = (String(basePrecStr).split('.')[1] || '').length;
      if (quotePrecStr) quotePrecision = (String(quotePrecStr).split('.')[1] || '').length;
    }
    if (info?.priceFilter?.tickSize) tickSize = Number(info.priceFilter.tickSize);
  } catch {
    // keep defaults
  }
  return { baseAssetPrecision, quotePrecision, tickSize };
}

// =====================================================================
// ---- execute ----------------------------------------------------------
// POST /api/spot/execute
// body: { symbol, capital: 951, orders: [{ step, price, qty }, ...], exchange }
//   - price: trigger price (quote currency) — the LIMIT price for every row
//     except the market buy.
//   - qty:   quantity in BASE asset units (e.g. CRV), same as calc.js's
//     computeSpotPlan `newQty`.
//
// Order #1 (market) spends exactly the planned dollar amount rather than a
// pre-computed base quantity, since a market order has no fixed execution
// price to compute quantity from ahead of time — Bybit's marketUnit:
// "quoteCoin", MEXC's quoteOrderQty. Every other row is a LIMIT buy resting
// at its ladder price. Every row's size is clamped against the live free
// USDT balance right before submission; the LAST row instead sweeps
// whatever's actually free (see getFreeUsdt/isLastOrder below) so it can
// never fail for insufficient funds and nothing is left idle by drift.
// =====================================================================
async function handleExecute(req, res, apiKey, secretKey, exchange) {
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

  const { baseAssetPrecision, quotePrecision, tickSize } = await getSymbolPrecision(exchange, symbol);

  const results = [];
  let committedTotal = 0;

  // Wrapped in one try/catch as a safety net: an unexpected exception
  // anywhere in this loop would otherwise crash the whole request uncaught,
  // silently truncating the ladder. Individual per-order try/catches below
  // still turn a single order's own failure into a normal (visible) error
  // row without aborting the rest of the loop; this outer one only catches
  // something escaping those.
  try {
    for (let orderIdx = 0; orderIdx < orders.length; orderIdx++) {
      const order = orders[orderIdx];
      const isLastOrder = orderIdx === orders.length - 1;
      // Bybit needs the LIMIT price rounded to its price tick size, not
      // quotePrecision (a different, coarser field — see api/execute.js's
      // header comment for the bug this caused when the two were conflated).
      // MEXC has no separate tick size to round to, so quotePrecision is
      // the right (and only) precision for its price field too.
      const price = tickSize ? Number((Math.round(order.price / tickSize) * tickSize).toFixed(8)) : Number(order.price.toFixed(quotePrecision));

      if (order.market) {
        let quoteQty = Number((order.price * order.qty).toFixed(quotePrecision));
        const freeUsdt = await getFreeUsdt(exchange, apiKey, secretKey);
        if (freeUsdt !== null) quoteQty = Math.min(quoteQty, Number(freeUsdt.toFixed(quotePrecision)));
        if (!(quoteQty > 0)) {
          results.push({ step: order.step, price, qty: null, quoteOrderQty: 0, orderType: 'market', success: false, orderId: null, error: 'Skipped — no USDT balance left to spend.' });
          await new Promise((r) => setTimeout(r, ORDER_SPACING_MS));
          continue;
        }

        if (exchange === 'mexc') {
          const body = { symbol, side: 'BUY', type: 'MARKET', quoteOrderQty: quoteQty, newClientOrderId: makeAppOrderTag(order.step) };
          try {
            const data = await spotPrivatePost('/api/v3/order', body, apiKey, secretKey);
            const success = !!data?.orderId;
            if (success) committedTotal += quoteQty;
            results.push({ step: order.step, price, qty: null, quoteOrderQty: quoteQty, orderType: 'market', success, orderId: data?.orderId || null, error: success ? null : data?.msg || `MEXC error code ${data?.code}` });
          } catch (err) {
            results.push({ step: order.step, price, qty: null, quoteOrderQty: quoteQty, orderType: 'market', success: false, orderId: null, error: String(err.message || err) });
          }
        } else {
          const body = { category: 'spot', symbol, side: 'Buy', orderType: 'Market', qty: String(quoteQty), marketUnit: 'quoteCoin', orderLinkId: makeOrderLinkId(order.step) };
          try {
            const data = await bybitPost('/v5/order/create', body, apiKey, secretKey);
            const success = bybitOk(data);
            if (success) committedTotal += quoteQty;
            results.push({ step: order.step, price, qty: null, quoteOrderQty: quoteQty, orderType: 'market', success, orderId: data?.result?.orderId || null, error: success ? null : bybitErrMsg(data, 'Unknown Bybit error') });
          } catch (err) {
            results.push({ step: order.step, price, qty: null, quoteOrderQty: quoteQty, orderType: 'market', success: false, orderId: null, error: String(err.message || err) });
          }
        }
      } else {
        let qty = Number(order.qty.toFixed(baseAssetPrecision));
        const freeUsdt = await getFreeUsdt(exchange, apiKey, secretKey);
        const factor = Math.pow(10, baseAssetPrecision);
        if (freeUsdt !== null) {
          if (isLastOrder) {
            // The final rung spends whatever's actually left instead of
            // clamping its own planned dollar amount down to fit — by the
            // time execution reaches here, small cumulative drift from
            // per-order price/qty rounding, and the market order's real fill
            // price vs. the ticker price the plan was built from, almost
            // always means the true remaining balance doesn't match this
            // row's planned number exactly.
            qty = Math.floor((freeUsdt / price) * factor) / factor;
          } else {
            const maxAffordableQty = Math.floor((freeUsdt / price) * factor) / factor;
            qty = Math.min(qty, maxAffordableQty);
          }
        }
        if (!(qty > 0)) {
          results.push({ step: order.step, price, qty: 0, orderType: 'limit', success: false, orderId: null, error: 'Skipped — no USDT balance left to spend.' });
          await new Promise((r) => setTimeout(r, ORDER_SPACING_MS));
          continue;
        }

        if (exchange === 'mexc') {
          const body = { symbol, side: 'BUY', type: 'LIMIT', quantity: qty, price, newClientOrderId: makeAppOrderTag(order.step) };
          try {
            const data = await spotPrivatePost('/api/v3/order', body, apiKey, secretKey);
            const success = !!data?.orderId;
            if (success) committedTotal += price * qty;
            results.push({ step: order.step, price, qty, orderType: 'limit', success, orderId: data?.orderId || null, error: success ? null : data?.msg || `MEXC error code ${data?.code}` });
          } catch (err) {
            results.push({ step: order.step, price, qty, orderType: 'limit', success: false, orderId: null, error: String(err.message || err) });
          }
        } else {
          const body = { category: 'spot', symbol, side: 'Buy', orderType: 'Limit', qty: String(qty), price: String(price), timeInForce: 'GTC', orderLinkId: makeOrderLinkId(order.step) };
          try {
            const data = await bybitPost('/v5/order/create', body, apiKey, secretKey);
            const success = bybitOk(data);
            if (success) committedTotal += price * qty;
            results.push({ step: order.step, price, qty, orderType: 'limit', success, orderId: data?.result?.orderId || null, error: success ? null : bybitErrMsg(data, 'Unknown Bybit error') });
          } catch (err) {
            results.push({ step: order.step, price, qty, orderType: 'limit', success: false, orderId: null, error: String(err.message || err) });
          }
        }
      }

      await new Promise((r) => setTimeout(r, ORDER_SPACING_MS));
    }
  } catch (err) {
    const capitalNum = Number(capital);
    res.status(200).json({ results, committedTotal, leftoverCapital: Number.isFinite(capitalNum) ? capitalNum - committedTotal : null, aborted: true, abortError: String(err.message || err) });
    return;
  }

  const capitalNum = Number(capital);
  const leftoverCapital = Number.isFinite(capitalNum) ? capitalNum - committedTotal : null;
  res.status(200).json({ results, committedTotal, leftoverCapital });
}

// =====================================================================
// ---- status ----------------------------------------------------------
// GET /api/spot/status?symbol=CRVUSDT&exchange=bybit|mexc
// `hasPosition` is read directly from the account's real free+locked
// balance of the base asset (e.g. CRV) on both exchanges, never
// reconstructed from order history — a market SELL (Close Position, or a
// manual sell) must never get misread as something that adds to holdings.
//
// The orders returned are mapped into the exact same shape the Leveraged
// tab uses ({price, vol, dealVol, dealAvgPrice, state, orderType, side,
// createTime}, with the same state/orderType/side number encoding) so the
// browser's existing renderPositionStatus() works for Spot mode, on either
// exchange, with zero new UI code.
//
// MEXC's order-history lookback here is capped at 7 days (allOrders) — a
// position opened longer ago than that with no order activity since still
// correctly shows as held (the real balance says so), just without an avg
// entry to compute P&L from.
//
// Bybit's branch below previously used ONLY GET /v5/order/realtime with
// openOnly:1 ("recently closed orders") on the (wrong, same mistake
// api/status.js's Leveraged branch made and fixed) assumption that it
// returned open+closed together — it actually returns CLOSED orders only,
// from an ephemeral cache Bybit's own docs say gets wiped on service
// restart regardless of order age. That meant every still-RESTING Spot
// limit order was invisible here, and a filled market buy could vanish at
// any time too. Fixed the same way as Leveraged: openOnly:0 (real open
// orders) merged with durable /v5/order/history (see
// bybitFindClosedOrderHistorySinceOpening in bybitClient.js).
// =====================================================================

// Classifies a raw Bybit order into filled/resting/canceled buckets. Bybit
// reports a clean orderStatus enum on every order (including market buys
// placed via quoteCoin), so there's no origQty-blank-on-market-order quirk
// to work around the way MEXC needs below.
function classifyBybit(o) {
  const status = String(o.orderStatus || '');
  if (status === 'Filled') return 3;
  if (status === 'Cancelled' || status === 'Rejected' || status === 'PartiallyFilledCanceled' || status === 'Deactivated') return 4;
  return 2; // New, PartiallyFilled, Untriggered, Triggered
}

// Classifies a raw MEXC order. Order #1 of every plan is a MARKET buy placed
// via `quoteOrderQty` (spend exactly $X) rather than `quantity` — MEXC's
// allOrders response for an order placed that way comes back with `origQty`
// at "0.000000" even once fully filled (the fill amount instead lives in
// `executedQty`/`cummulativeQuoteQty`), so `status` is checked first (MEXC
// returns it on every order), with the quantity comparison kept only as a
// fallback for any status string this function doesn't recognize.
function classifyMexc(o) {
  const executedQty = Number(o.executedQty || 0);
  const origQty = Number(o.origQty || 0);
  const status = String(o.status || '').toUpperCase();
  if (status === 'CANCELED' || status === 'REJECTED' || status === 'EXPIRED' || status === 'PARTIALLY_CANCELED') return 4;
  if (status === 'FILLED') return 3;
  if (origQty > 0 && executedQty >= origQty - 1e-9) return 3;
  if (!(origQty > 0) && executedQty > 0) return 3;
  return 2;
}

// Discovery mode (action=discover, no symbol needed): lists every non-USDT
// asset with a nonzero balance on the account, across both free and locked.
// Same purpose/caller as api/status.js's discoverFromBybit/discoverFromMexc
// (see that header comment) -- index.html's discoverActiveSymbol() fallback
// for when the Symbol field's current value has no position anywhere.
// Deliberately loose (no dust filtering, no precision rounding) -- whichever
// asset(s) come back get a full, precision-aware handleStatus check
// afterward anyway, which is what actually decides hasPosition.
async function handleDiscover(req, res, apiKey, secretKey, exchange) {
  if (exchange === 'mexc') {
    try {
      const data = await spotPrivateGet('/api/v3/account', {}, apiKey, secretKey);
      if (!data || !Array.isArray(data.balances)) {
        res.status(200).json({ assets: [] });
        return;
      }
      const assets = data.balances
        .filter((b) => b.asset !== 'USDT' && Number(b.free) + Number(b.locked) > 0)
        .map((b) => b.asset);
      res.status(200).json({ assets });
    } catch {
      res.status(200).json({ assets: [] });
    }
    return;
  }

  try {
    const data = await bybitGet('/v5/account/wallet-balance', { accountType: 'UNIFIED' }, apiKey, secretKey);
    const account = bybitOk(data) && Array.isArray(data.result?.list) ? data.result.list[0] : null;
    const coins = account && Array.isArray(account.coin) ? account.coin : [];
    const assets = coins
      .filter((c) => c.coin !== 'USDT' && Number(c.walletBalance) > 0)
      .map((c) => c.coin);
    res.status(200).json({ assets });
  } catch {
    res.status(200).json({ assets: [] });
  }
}

async function handleStatus(req, res, apiKey, secretKey, exchange) {
  const symbol = String(req.query.symbol || '').toUpperCase();
  if (!symbol) {
    res.status(400).json({ error: 'symbol query param is required.' });
    return;
  }
  // Both exchanges only ever trade USDT-quoted spot pairs here (see
  // index.html's toSpotSymbol) — safe to derive the base asset by stripping
  // the suffix.
  const baseAsset = symbol.endsWith('USDT') ? symbol.slice(0, -4) : symbol;

  const { baseAssetPrecision } = await getSymbolPrecision(exchange, symbol);

  const balance = await getAssetBalance(exchange, baseAsset, apiKey, secretKey);
  if (balance === null) {
    res.status(502).json({ error: `Could not look up ${baseAsset} balance — check the key has account-read permission.` });
    return;
  }
  const factor = Math.pow(10, baseAssetPrecision);
  const realHoldVol = Math.floor((balance.free + balance.locked) * factor) / factor;
  const hasPosition = realHoldVol > 0;

  let orders = [];
  let sinceTime = null;
  let openedByApp = false;
  let orderDebug = null;
  let ordersError = null;

  if (exchange === 'mexc') {
    try {
      const raw = await spotPrivateGet('/api/v3/allOrders', { symbol, startTime: Date.now() - SPOT_SEVEN_DAYS_MS }, apiKey, secretKey);
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
          clientOrderId: o.clientOrderId || o.origClientOrderId,
          price: isMarket ? dealAvgPrice : Number(o.price),
          vol: Number(o.origQty),
          dealVol: executedQty,
          dealAvgPrice,
          side: String(o.side).toUpperCase() === 'SELL' ? 2 : 1,
          orderType: isMarket ? 5 : 1,
          state: classifyMexc(o),
          createTime: Number(o.time),
        };
      });

      const scopeResult = scopeOrdersSinceOpeningMarketBuy(all, (o) => o.clientOrderId, isAppOrderTag);
      sinceTime = scopeResult.sinceTime;
      openedByApp = scopeResult.openedByApp;
      orders = scopeResult.scoped.filter((o) => o.side === 1).sort((a, b) => b.price - a.price);
    } catch (err) {
      res.status(502).json({ error: 'Failed to reach MEXC.', detail: String(err.message || err) });
      return;
    }
  } else {
    try {
      const [openData, historyResult] = await Promise.all([
        bybitGet('/v5/order/realtime', { category: 'spot', symbol, openOnly: 0, limit: 50 }, apiKey, secretKey),
        bybitFindClosedOrderHistorySinceOpening(
          'spot',
          symbol,
          apiKey,
          secretKey,
          (o) => o.side === 'Buy' && o.orderType === 'Market',
          HISTORY_LOOKBACK_MS
        ),
      ]);

      if (!bybitOk(openData) || !Array.isArray(openData.result?.list)) {
        ordersError = bybitErrMsg(openData, 'Bybit rejected the open-orders request.');
      } else {
        const seenIds = new Set();
        const rawList = [...openData.result.list, ...historyResult.orders].filter((o) => {
          if (o.symbol !== symbol) return false;
          if (seenIds.has(o.orderId)) return false;
          seenIds.add(o.orderId);
          return true;
        });
        const all = rawList.map((o) => {
          const isMarket = o.orderType === 'Market';
          return {
            orderId: o.orderId,
            orderLinkId: o.orderLinkId,
            price: isMarket ? Number(o.avgPrice || 0) : Number(o.price),
            vol: Number(o.qty),
            dealVol: Number(o.cumExecQty),
            dealAvgPrice: Number(o.avgPrice || 0),
            side: o.side === 'Sell' ? 2 : 1,
            orderType: isMarket ? 5 : 1,
            state: classifyBybit(o),
            createTime: Number(o.createdTime),
          };
        });

        const scopeResult = scopeOrdersSinceOpeningMarketBuy(all, (o) => o.orderLinkId, isAppOrderLinkId);
        sinceTime = scopeResult.sinceTime;
        openedByApp = scopeResult.openedByApp;
        orders = scopeResult.scoped.filter((o) => o.side === 1).sort((a, b) => b.price - a.price);
        orderDebug = {
          openOrdersSeen: openData.result.list.length,
          closedOrdersFromHistory: historyResult.orders.length,
          historyWindowsSearched: historyResult.windows,
          historyLookbackDaysSearched: historyResult.windows * 7,
          marketBuyFound: sinceTime !== null,
        };
      }
    } catch (err) {
      // Don't let an order-list hiccup blank out hasPosition/pnl below --
      // both are derived from the real balance already fetched above, not
      // from this order list. Same graceful-degrade pattern as
      // api/status.js's Leveraged branch. Cost-basis P&L below will come
      // back null (it's reconstructed from filled BUY orders), which is
      // honest -- we don't have that data right now -- rather than hiding
      // the whole position.
      ordersError = `Failed to reach Bybit for the order list: ${String(err.message || err)}`;
    }
  }

  // Cost basis for P&L, reconstructed from this run's filled BUY orders.
  const filled = orders.filter((o) => o.state === 3);
  const filledVol = filled.reduce((s, o) => s + o.dealVol, 0);
  const filledNotional = filled.reduce((s, o) => s + o.dealVol * o.dealAvgPrice, 0);
  const holdAvgPrice = filledVol > 0 ? filledNotional / filledVol : null;

  let pnl = null;
  if (hasPosition && holdAvgPrice !== null) {
    try {
      let currentPrice = null;
      if (exchange === 'mexc') {
        const ticker = await getSpotTicker(symbol);
        currentPrice = ticker && ticker.price ? Number(ticker.price) : null;
      } else {
        const ticker = await bybitPublicGet('/v5/market/tickers', { category: 'spot', symbol });
        const tick = bybitOk(ticker) && Array.isArray(ticker.result?.list) ? ticker.result.list[0] : null;
        currentPrice = tick ? Number(tick.lastPrice) : null;
      }
      if (currentPrice) {
        const costBasis = holdAvgPrice * realHoldVol;
        const { dollar, percent } = computePnl({ holdAvgPrice, holdVol: realHoldVol, contractSize: 1, currentPrice, im: costBasis, isLong: true });
        pnl = { dollar, percent, currentPrice };
      }
    } catch {
      // leave pnl null
    }
  }

  res.status(200).json({ hasPosition, position: hasPosition ? { holdAvgPrice, holdVol: realHoldVol } : null, orders, sinceTime, pnl, openedByApp, orderDebug, ordersError });
}

// =====================================================================
// ---- close ----------------------------------------------------------
// POST /api/spot/close  body: { symbol, baseAsset, exchange }
// No position/leverage to flatten on Spot — cancel every open order on the
// symbol, then market-sell the ENTIRE free balance of the base asset back
// to USDT.
// =====================================================================
async function handleClose(req, res, apiKey, secretKey, exchange) {
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

  if (exchange === 'mexc') {
    try {
      const data = await spotPrivateDelete('/api/v3/openOrders', { symbol }, apiKey, secretKey);
      const success = Array.isArray(data);
      steps.push({ step: 'cancel_orders', success, note: success ? `${data.length} order(s) canceled` : null, error: success ? null : data?.msg || `MEXC error code ${data?.code}` });
    } catch (err) {
      steps.push({ step: 'cancel_orders', success: false, error: String(err.message || err) });
    }

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
          const { baseAssetPrecision } = await getSpotSymbolPrecision(symbol);
          const factor = Math.pow(10, baseAssetPrecision);
          const quantity = Math.floor(free * factor) / factor;
          if (!(quantity > 0)) {
            steps.push({ step: 'sell_holdings', success: true, note: `Free ${baseAsset} balance is dust below the sellable precision — nothing sold.` });
          } else {
            const data = await spotPrivatePost('/api/v3/order', { symbol, side: 'SELL', type: 'MARKET', quantity }, apiKey, secretKey);
            const success = !!data?.orderId;
            steps.push({ step: 'sell_holdings', success, quantity, orderId: data?.orderId || null, error: success ? null : data?.msg || `MEXC error code ${data?.code}` });
          }
        }
      }
    } catch (err) {
      steps.push({ step: 'sell_holdings', success: false, error: String(err.message || err) });
    }

    res.status(200).json({ steps });
    return;
  }

  try {
    const data = await bybitPost('/v5/order/cancel-all', { category: 'spot', symbol }, apiKey, secretKey);
    const success = bybitOk(data);
    const canceled = success && Array.isArray(data.result?.list) ? data.result.list.length : null;
    steps.push({ step: 'cancel_orders', success, note: success ? `${canceled ?? 0} order(s) canceled` : null, error: success ? null : bybitErrMsg(data, 'Unknown Bybit error') });
  } catch (err) {
    steps.push({ step: 'cancel_orders', success: false, error: String(err.message || err) });
  }

  try {
    const balance = await getAssetBalance('bybit', baseAsset, apiKey, secretKey);
    if (balance === null) {
      steps.push({ step: 'sell_holdings', success: false, error: `Could not look up ${baseAsset} balance.` });
    } else if (!(balance.free > 0)) {
      steps.push({ step: 'sell_holdings', success: true, note: `No free ${baseAsset} balance to sell.` });
    } else {
      const { baseAssetPrecision } = await getSymbolPrecision('bybit', symbol);
      const factor = Math.pow(10, baseAssetPrecision);
      const quantity = Math.floor(balance.free * factor) / factor;
      if (!(quantity > 0)) {
        steps.push({ step: 'sell_holdings', success: true, note: `Free ${baseAsset} balance is dust below the sellable precision — nothing sold.` });
      } else {
        const data = await bybitPost('/v5/order/create', { category: 'spot', symbol, side: 'Sell', orderType: 'Market', qty: String(quantity) }, apiKey, secretKey);
        const success = bybitOk(data);
        steps.push({ step: 'sell_holdings', success, quantity, orderId: data?.result?.orderId || null, error: success ? null : bybitErrMsg(data, 'Unknown Bybit error') });
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
// fake server. It exercises the Bybit classifier (classifyBybit) — the
// pre-existing behavior this test already covered; classifyMexc is exercised
// indirectly via the backfill fixtures instead.
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { action } = req.query;
  const exchange = String((req.method === 'POST' ? req.body?.exchange : req.query.exchange) || 'bybit').toLowerCase();

  if (action === 'price') {
    await handlePrice(req, res, exchange);
    return;
  }

  const envVarNames = exchange === 'mexc' ? ['MEXC_API_KEY', 'MEXC_API_SECRET'] : ['BYBIT_API_KEY', 'BYBIT_API_SECRET'];
  const apiKey = process.env[envVarNames[0]];
  const secretKey = process.env[envVarNames[1]];
  if (!apiKey || !secretKey) {
    res.status(500).json({
      error: `${envVarNames[0]} and/or ${envVarNames[1]} are not set on the server. Add them in Vercel → Project Settings → Environment Variables, then redeploy.`,
    });
    return;
  }

  switch (action) {
    case 'balance':
      await handleBalance(req, res, apiKey, secretKey, exchange);
      return;
    case 'execute':
      await handleExecute(req, res, apiKey, secretKey, exchange);
      return;
    case 'status':
      await handleStatus(req, res, apiKey, secretKey, exchange);
      return;
    case 'close':
      await handleClose(req, res, apiKey, secretKey, exchange);
      return;
    case 'discover':
      await handleDiscover(req, res, apiKey, secretKey, exchange);
      return;
    default:
      res.status(404).json({ error: `Unknown spot action "${action}".` });
  }
};

module.exports.classify = classifyBybit;
module.exports.classifyMexc = classifyMexc;
