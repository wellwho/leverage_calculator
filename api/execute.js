// Vercel serverless function: places the ladder's orders on the Leveraged
// tab's exchange of choice — Bybit's linear (USDT perpetual) market, or
// MEXC's futures market.
// Credentials come from Vercel environment variables only — BYBIT_API_KEY/
// BYBIT_API_SECRET for Bybit, MEXC_API_KEY/MEXC_API_SECRET for MEXC — never
// sent to or read from the browser.
//
// POST /api/execute
// body: { symbol, leverage: 5, capital: 951, orders: [{ step, price, qty }, ...], exchange: "bybit" | "mexc" }
//   - symbol:  "CRVUSDT" for Bybit, "CRV_USDT" for MEXC (see index.html's
//              toFuturesSymbol).
//   - exchange defaults to "bybit" when omitted, for back-compat.
//   - price:   limit price (quote currency)
//   - qty:     quantity in BASE asset units (e.g. CRV), same as calc.js's
//              `newQty` for both exchanges — Bybit's linear orders are
//              already denominated in the base asset (just rounded to
//              qtyStep); MEXC trades fixed-size contracts, so this function
//              converts qty into MEXC's `vol` (contract count) itself.
//   - capital: the plan's total capital. calc.js's computePlan commits 100%
//              of this directly as margin across the ladder's buys — no
//              reserve is held back on either exchange. After every order is
//              placed, whatever wasn't actually committed (price/qty
//              rounding means this rarely matches the plan's numbers
//              exactly) is reported back as `leftoverCapital` — informational
//              only. It's left as available balance rather than pushed into
//              the position; you can still enable each exchange's own
//              Auto-Margin Replenishment feature on the position from its own
//              app as a general safety net, but this app doesn't design
//              around it or assume it on either exchange.
//   - the LAST limit order in the ladder (the deepest rung), on BOTH
//     exchanges, sweeps whatever margin is actually free right before it's
//     placed instead of chasing its own pre-planned amount — small
//     cumulative price/qty rounding drift across every earlier order almost
//     always means the true remaining balance doesn't match this row's
//     planned number exactly by the time execution gets there (caught live
//     on Bybit, real money: the planned last order kept failing to place
//     while a few dollars sat unused in the account). Same reasoning and
//     same fix already shipped for the Spot tab's last row
//     (api/spot/[action].js's handleExecute).
//   - every order placed here also gets an app-tagged client order id
//     (Bybit's `orderLinkId`, MEXC's `externalOid`) so api/status.js can
//     tell an app-opened position apart from one opened manually on the
//     exchange directly, and prefer showing the former when both tabs (or
//     both exchanges) have something open.
//
// Bybit-only sequencing (MEXC takes leverage/openType as fields on every
// order/create call instead, so it needs no equivalent setup steps):
//   1. Set leverage for this symbol (POST /v5/position/set-leverage).
//   2. Switch the symbol to isolated margin (POST /v5/position/switch-isolated).
//      Both tolerate Bybit's "not modified" retCode as success. Step 2 is
//      best-effort — some Bybit account configurations (Portfolio Margin
//      mode) don't support a per-symbol isolated toggle, so a failure here
//      is surfaced as a warning rather than aborting the whole run.
//   3. Place every ladder row as its own order, Buy #1 at market (fills
//      now), the rest as resting limit buys.

const { bybitPublicGet, bybitGet, bybitPost, bybitOk, bybitOkOrAlreadySet, bybitErrMsg, usdtFreeFromCoin, makeOrderLinkId } = require('../bybitClient.js');
const { futuresPrivateGet, futuresPrivatePost, futuresOk, futuresErrMsg, getFuturesContractDetail, makeAppOrderTag } = require('../mexcClient.js');

const ORDER_SPACING_MS = 550; // conservative pacing, both exchanges' documented per-second order-create caps are looser than this

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Rounds down to the nearest exchange-accepted step (never up — the safe
// direction so an order never asks for slightly more than intended).
function floorToStep(value, step) {
  if (!step) return value;
  const decimals = (String(step).split('.')[1] || '').length;
  return Number((Math.floor(value / step) * step).toFixed(decimals));
}

// ---------------------------------------------------------------- Bybit ----

async function getBybitFreeUsdt(apiKey, secretKey) {
  try {
    const data = await bybitGet('/v5/account/wallet-balance', { accountType: 'UNIFIED', coin: 'USDT' }, apiKey, secretKey);
    const account = bybitOk(data) && Array.isArray(data.result?.list) ? data.result.list[0] : null;
    const coinEntry = account && Array.isArray(account.coin) ? account.coin.find((c) => c.coin === 'USDT') : null;
    if (!account || !coinEntry) return null;
    return usdtFreeFromCoin(coinEntry);
  } catch {
    return null;
  }
}

async function executeOnBybit(req, res, symbol, leverage, orders, capital) {
  const apiKey = process.env.BYBIT_API_KEY;
  const secretKey = process.env.BYBIT_API_SECRET;
  if (!apiKey || !secretKey) {
    res.status(500).json({
      error: 'BYBIT_API_KEY and/or BYBIT_API_SECRET are not set on the server. Add them in Vercel → Project Settings → Environment Variables, then redeploy.',
    });
    return;
  }

  let qtyStep, minOrderQty, tickSize;
  try {
    const detail = await bybitPublicGet('/v5/market/instruments-info', { category: 'linear', symbol });
    const info = bybitOk(detail) && Array.isArray(detail.result?.list) ? detail.result.list[0] : null;
    if (!info) throw new Error(`No instrument spec found for "${symbol}".`);
    qtyStep = Number(info.lotSizeFilter?.qtyStep);
    minOrderQty = Number(info.lotSizeFilter?.minOrderQty) || qtyStep;
    tickSize = Number(info.priceFilter?.tickSize);
    if (!qtyStep) throw new Error('qtyStep missing from instrument spec.');
  } catch (err) {
    res.status(502).json({ error: 'Could not fetch Bybit instrument spec.', detail: String(err.message || err) });
    return;
  }

  const warnings = [];

  try {
    const lev = String(Number(leverage));
    const levData = await bybitPost('/v5/position/set-leverage', { category: 'linear', symbol, buyLeverage: lev, sellLeverage: lev }, apiKey, secretKey);
    if (!bybitOkOrAlreadySet(levData)) {
      res.status(502).json({ error: bybitErrMsg(levData, 'Could not set leverage on Bybit.') });
      return;
    }
  } catch (err) {
    res.status(502).json({ error: 'Failed to reach Bybit while setting leverage.', detail: String(err.message || err) });
    return;
  }

  try {
    const lev = String(Number(leverage));
    const isoData = await bybitPost(
      '/v5/position/switch-isolated',
      { category: 'linear', symbol, tradeMode: 1, buyLeverage: lev, sellLeverage: lev },
      apiKey,
      secretKey
    );
    if (!bybitOkOrAlreadySet(isoData)) {
      warnings.push(
        `Could not switch ${symbol} to isolated margin (${bybitErrMsg(isoData, 'unknown error')}). Check the position's margin mode in the Bybit app — Auto-Margin Replenishment only applies to isolated positions.`
      );
    }
  } catch (err) {
    warnings.push(`Failed to reach Bybit while setting isolated margin: ${String(err.message || err)}`);
  }

  const results = [];
  try {
    for (let orderIdx = 0; orderIdx < orders.length; orderIdx++) {
      const order = orders[orderIdx];
      const isLastOrder = orderIdx === orders.length - 1;
      let qty = Math.max(minOrderQty, floorToStep(order.qty, qtyStep));
      const price = tickSize ? Number((Math.round(order.price / tickSize) * tickSize).toFixed(8)) : order.price;

      if (isLastOrder && !order.market) {
        const freeUsdt = await getBybitFreeUsdt(apiKey, secretKey);
        if (freeUsdt !== null) {
          const sweptQty = floorToStep((freeUsdt * Number(leverage)) / price, qtyStep);
          if (sweptQty >= minOrderQty) {
            qty = sweptQty;
          } else {
            results.push({ step: order.step, price, vol: 0, orderType: 'limit', success: false, orderId: null, error: 'Skipped — not enough free margin left to meet the minimum order size.' });
            await sleep(ORDER_SPACING_MS);
            continue;
          }
        }
      }

      const body = {
        category: 'linear',
        symbol,
        side: 'Buy',
        orderType: order.market ? 'Market' : 'Limit',
        qty: String(qty),
        timeInForce: order.market ? 'IOC' : 'GTC',
        positionIdx: 0,
        orderLinkId: makeOrderLinkId(order.step),
      };
      if (!order.market) body.price = String(price);

      try {
        const data = await bybitPost('/v5/order/create', body, apiKey, secretKey);
        results.push({
          step: order.step,
          price,
          vol: qty,
          orderType: order.market ? 'market' : 'limit',
          success: bybitOk(data),
          orderId: data?.result?.orderId || null,
          error: bybitOk(data) ? null : bybitErrMsg(data, 'Unknown Bybit error'),
        });
      } catch (err) {
        results.push({ step: order.step, price, vol: qty, orderType: order.market ? 'market' : 'limit', success: false, orderId: null, error: String(err.message || err) });
      }

      await sleep(ORDER_SPACING_MS);
    }
  } catch (err) {
    const capitalNum = Number(capital);
    let leftoverCapital = null;
    if (Number.isFinite(capitalNum) && capitalNum > 0) {
      const committedMargin = results.filter((r) => r.success).reduce((sum, r) => sum + (r.price * r.vol) / Number(leverage), 0);
      leftoverCapital = capitalNum - committedMargin;
    }
    res.status(200).json({ contractSize: 1, results, leftoverCapital, warnings, aborted: true, abortError: String(err.message || err) });
    return;
  }

  const capitalNum = Number(capital);
  let leftoverCapital = null;
  if (Number.isFinite(capitalNum) && capitalNum > 0) {
    const committedMargin = results.filter((r) => r.success).reduce((sum, r) => sum + (r.price * r.vol) / Number(leverage), 0);
    leftoverCapital = capitalNum - committedMargin;
  }

  res.status(200).json({ contractSize: 1, results, leftoverCapital, warnings });
}

// ----------------------------------------------------------------- MEXC ----

async function getMexcFreeUsdt(apiKey, secretKey) {
  try {
    const data = await futuresPrivateGet('/api/v1/private/account/asset/USDT', {}, apiKey, secretKey);
    if (!futuresOk(data) || !data.data) return null;
    return Number(data.data.availableOpen);
  } catch {
    return null;
  }
}

async function executeOnMexc(req, res, symbol, leverage, orders, capital) {
  const apiKey = process.env.MEXC_API_KEY;
  const secretKey = process.env.MEXC_API_SECRET;
  if (!apiKey || !secretKey) {
    res.status(500).json({
      error: 'MEXC_API_KEY and/or MEXC_API_SECRET are not set on the server. Add them in Vercel → Project Settings → Environment Variables, then redeploy.',
    });
    return;
  }

  let contractSize, priceScale, volScale, minVol;
  try {
    const detail = await getFuturesContractDetail(symbol);
    contractSize = Number(detail.contractSize);
    priceScale = Number(detail.priceScale);
    volScale = Number(detail.volScale);
    minVol = Number(detail.minVol) || 1;
    if (!contractSize) throw new Error('contractSize missing from contract spec.');
  } catch (err) {
    res.status(502).json({ error: 'Could not fetch MEXC contract spec.', detail: String(err.message || err) });
    return;
  }

  const results = [];
  // Wrapped in one outer try/catch as a safety net — same reasoning as the
  // Bybit path and api/spot/[action].js's handleExecute: an exception
  // escaping the per-order try/catch below would otherwise crash the whole
  // request uncaught, silently truncating the ladder with no readable error
  // and no record of what did/didn't get placed.
  try {
    for (let orderIdx = 0; orderIdx < orders.length; orderIdx++) {
      const order = orders[orderIdx];
      const isLastOrder = orderIdx === orders.length - 1;
      let rawVol = order.qty / contractSize;
      let vol = Math.max(minVol, Number(rawVol.toFixed(volScale)) || Math.round(rawVol));
      const price = Number(order.price.toFixed(priceScale));

      // Last limit order: sweep whatever margin is actually free right now,
      // same reasoning as the Bybit path above and the Spot tab's
      // isLastOrder handling.
      if (isLastOrder && !order.market) {
        const freeUsdt = await getMexcFreeUsdt(apiKey, secretKey);
        if (freeUsdt !== null) {
          const sweptRawVol = (freeUsdt * Number(leverage)) / (price * contractSize);
          const sweptVol = Math.floor(sweptRawVol * Math.pow(10, volScale)) / Math.pow(10, volScale);
          if (sweptVol >= minVol) {
            vol = sweptVol;
          } else {
            results.push({ step: order.step, price, vol: 0, orderType: 'limit', success: false, orderId: null, error: 'Skipped — not enough free margin left to meet the minimum order size.' });
            await sleep(ORDER_SPACING_MS);
            continue;
          }
        }
      }

      const body = {
        symbol,
        price,
        vol,
        leverage: Number(leverage),
        side: 1, // open long
        type: order.market ? 5 : 1, // 5 market (fills now), 1 limit (rests on the book)
        openType: 1, // isolated
        externalOid: makeAppOrderTag(order.step),
      };

      try {
        const data = await futuresPrivatePost('/api/v1/private/order/create', body, apiKey, secretKey);
        results.push({
          step: order.step,
          price,
          vol,
          orderType: order.market ? 'market' : 'limit',
          success: futuresOk(data),
          orderId: data?.data?.orderId || null,
          error: futuresOk(data) ? null : futuresErrMsg(data, 'Unknown MEXC error'),
        });
      } catch (err) {
        results.push({ step: order.step, price, vol, orderType: order.market ? 'market' : 'limit', success: false, orderId: null, error: String(err.message || err) });
      }

      await sleep(ORDER_SPACING_MS);
    }
  } catch (err) {
    const capitalNum = Number(capital);
    let leftoverCapital = null;
    if (Number.isFinite(capitalNum) && capitalNum > 0) {
      const committedMargin = results.filter((r) => r.success).reduce((sum, r) => sum + (r.price * r.vol * contractSize) / Number(leverage), 0);
      leftoverCapital = capitalNum - committedMargin;
    }
    res.status(200).json({ contractSize, results, leftoverCapital, warnings: [], aborted: true, abortError: String(err.message || err) });
    return;
  }

  const capitalNum = Number(capital);
  let leftoverCapital = null;
  if (Number.isFinite(capitalNum) && capitalNum > 0) {
    const committedMargin = results.filter((r) => r.success).reduce((sum, r) => sum + (r.price * r.vol * contractSize) / Number(leverage), 0);
    leftoverCapital = capitalNum - committedMargin;
  }

  res.status(200).json({ contractSize, results, leftoverCapital, warnings: [] });
}

// -------------------------------------------------------------- dispatch ----

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Use POST.' });
    return;
  }

  const { symbol, leverage, orders, capital, exchange } = req.body || {};
  if (!symbol || !leverage || !Array.isArray(orders) || orders.length === 0) {
    res.status(400).json({ error: 'symbol, leverage, and a non-empty orders[] array are required.' });
    return;
  }
  if (orders.length > 30) {
    res.status(400).json({ error: 'Refusing to place more than 30 orders in one call.' });
    return;
  }

  if (String(exchange || 'bybit').toLowerCase() === 'mexc') {
    await executeOnMexc(req, res, symbol, leverage, orders, capital);
  } else {
    await executeOnBybit(req, res, symbol, leverage, orders, capital);
  }
};
