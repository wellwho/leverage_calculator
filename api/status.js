// Vercel serverless function: read-only position + order status for one
// symbol, on whichever exchange the Leveraged tab is pointed at. Drives the
// UI's two states — "plan calculator" when nothing is open, "position
// status" (with fill markers) when something is.
//
// GET /api/status?symbol=CRVUSDT&exchange=bybit  or  ?symbol=CRV_USDT&exchange=mexc
// `exchange` defaults to "bybit" when omitted, for back-compat.
//
// The order list is scoped to "since the last Execute", not full history: it
// only returns orders placed at or after the most recent open-long market
// order (Buy #1 in this app's ladder always fires as one of those), so a
// re-deploy on the same symbol doesn't drag old, already-closed runs into
// the list.
//
// Also computes, when a position is open:
//   - pnl: unrealized P&L in $ and % of currently-committed margin, using
//     the live ticker price against the position's own avg entry.
//   - projectedLiquidation: NOT the exchange's own current liquidation price
//     (that only reflects what has actually filled so far) — this projects
//     the liquidation price assuming every still-resting order in the scoped
//     list also fills, starting from the position's real, live initial
//     margin (which already reflects any margin added manually or via
//     either exchange's own Auto-Margin Replenishment). So this is a
//     real-time "if the whole ladder fills" number, not a stale
//     plan-time calculation.
//
// openedByApp: true if the market buy that opened the current run carries
// this app's own order tag (Bybit's orderLinkId via bybitClient.js's
// makeOrderLinkId, or MEXC's externalOid via mexcClient.js's
// makeAppOrderTag) — i.e. this position was built up through this app, not
// opened manually on the exchange directly. Read by index.html's
// selectInitialTabByPosition to prefer landing on an app-managed ladder over
// an unrelated manually-opened one.

const { bybitGet, bybitPublicGet, bybitOk, bybitErrMsg, isAppOrderLinkId, bybitFindClosedOrderHistorySinceOpening } = require('../bybitClient.js');
const { futuresPrivateGet, futuresOk, futuresErrMsg, getFuturesContractDetail, getFuturesTicker, isAppOrderTag } = require('../mexcClient.js');
const { computePnl, computeProjectedLiquidation, scopeOrdersSinceOpeningMarketBuy } = require('../statusCalc.js');

// How far back GET /v5/order/history is walked (in 7-day windows -- Bybit's
// own per-call span cap) to find the market buy that opened the current
// run. See bybitClient.js's bybitFindClosedOrderHistorySinceOpening header
// comment for why this replaced openOnly:1's ephemeral closed-order cache.
const HISTORY_LOOKBACK_MS = 60 * 24 * 60 * 60 * 1000;

// Bybit orderStatus -> this app's state encoding (2 resting, 3 filled, 4 canceled).
function classifyBybitStatus(orderStatus) {
  const s = String(orderStatus || '');
  if (s === 'Filled') return 3;
  if (s === 'Cancelled' || s === 'Rejected' || s === 'PartiallyFilledCanceled' || s === 'Deactivated') return 4;
  return 2; // New, PartiallyFilled, Untriggered, Triggered
}

// Strips a Bybit/MEXC futures symbol down to the bare base asset (e.g.
// "ENAUSDT" or "ENA_USDT" -> "ENA") -- matches the convention the Symbol
// input field itself uses (index.html's toFuturesSymbol/toSpotSymbol both
// take a bare asset and add the exchange-specific suffix back on).
function stripToBaseAsset(rawSymbol) {
  return String(rawSymbol || '').toUpperCase().replace(/_USDT$/, '').replace(/USDT$/, '');
}

// Discovery mode (?discover=1, no symbol needed): lists every OPEN Leveraged
// position on the account, across every symbol, cheaply -- one API call, no
// per-symbol order-history walk. Used by index.html's discoverActiveSymbol()
// as a fallback ONLY when the normal (fixed-symbol) position check below
// finds nothing for whatever symbol is currently in the Symbol field --
// e.g. the field still says "CRV" from a previous session but the account's
// real activity has since moved to a different symbol entirely, so the
// fixed-symbol check across all 4 (exchange x mode) combos comes up empty.
// Returns bare base-asset symbols + each position's own updatedTime (used
// as a recency tiebreak) -- deliberately NOT the full detail
// statusFromBybit/statusFromMexc compute (P&L, openedByApp, order list),
// since discovery just needs to answer "is anything open, and on what
// symbol" as cheaply as possible; whichever symbol wins gets a full,
// properly-scoped status check afterward anyway.
async function discoverFromBybit(req, res) {
  const apiKey = process.env.BYBIT_API_KEY;
  const secretKey = process.env.BYBIT_API_SECRET;
  if (!apiKey || !secretKey) {
    res.status(200).json({ symbols: [] }); // no keys configured -- nothing to discover, not an error worth surfacing here
    return;
  }
  try {
    const data = await bybitGet('/v5/position/list', { category: 'linear', settleCoin: 'USDT' }, apiKey, secretKey);
    if (!bybitOk(data) || !Array.isArray(data.result?.list)) {
      res.status(200).json({ symbols: [] });
      return;
    }
    const symbols = data.result.list
      .filter((p) => Number(p.size) > 0)
      .map((p) => ({ asset: stripToBaseAsset(p.symbol), updatedTime: Number(p.updatedTime) || 0 }));
    res.status(200).json({ symbols });
  } catch {
    res.status(200).json({ symbols: [] }); // discovery is best-effort -- a failure here just means the fallback finds nothing, never a hard error
  }
}

async function discoverFromMexc(req, res) {
  const apiKey = process.env.MEXC_API_KEY;
  const secretKey = process.env.MEXC_API_SECRET;
  if (!apiKey || !secretKey) {
    res.status(200).json({ symbols: [] });
    return;
  }
  try {
    const data = await futuresPrivateGet('/api/v1/private/position/open_positions', {}, apiKey, secretKey);
    if (!futuresOk(data) || !Array.isArray(data.data)) {
      res.status(200).json({ symbols: [] });
      return;
    }
    const symbols = data.data
      .filter((p) => Number(p.holdVol) > 0)
      .map((p) => ({ asset: stripToBaseAsset(p.symbol), updatedTime: Number(p.updateTime) || 0 }));
    res.status(200).json({ symbols });
  } catch {
    res.status(200).json({ symbols: [] });
  }
}

async function statusFromBybit(req, res, symbol) {
  const apiKey = process.env.BYBIT_API_KEY;
  const secretKey = process.env.BYBIT_API_SECRET;
  if (!apiKey || !secretKey) {
    res.status(500).json({
      error: 'BYBIT_API_KEY and/or BYBIT_API_SECRET are not set on the server. Add them in Vercel → Project Settings → Environment Variables, then redeploy.',
    });
    return;
  }

  let position = null;
  try {
    const posData = await bybitGet('/v5/position/list', { category: 'linear', symbol }, apiKey, secretKey);
    if (bybitOk(posData) && Array.isArray(posData.result?.list)) {
      position = posData.result.list.find((p) => p.symbol === symbol && Number(p.size) > 0) || null;
    } else {
      res.status(502).json({ error: bybitErrMsg(posData, 'Could not look up position.') });
      return;
    }
  } catch (err) {
    res.status(502).json({ error: 'Failed to reach Bybit.', detail: String(err.message || err) });
    return;
  }

  // Order list: real-time open orders (openOnly:0) merged with DURABLE
  // closed-order history (bybitFindClosedOrderHistorySinceOpening, walking
  // /v5/order/history backward in 7-day windows) -- see bybitClient.js's
  // header comment on that function for why openOnly:1's ephemeral cache
  // isn't safe to rely on here (it can lose a position's opening market buy
  // at any time, regardless of the order's age, whenever Bybit restarts
  // that cache).
  let orders = [];
  let sinceTime = null;
  let ordersError = null;
  let openedByApp = false;
  let orderDebug = null;
  try {
    const [openData, historyResult] = await Promise.all([
      bybitGet('/v5/order/realtime', { category: 'linear', symbol, openOnly: 0, limit: 50 }, apiKey, secretKey),
      bybitFindClosedOrderHistorySinceOpening(
        'linear',
        symbol,
        apiKey,
        secretKey,
        (o) => o.side === 'Buy' && o.orderType === 'Market',
        HISTORY_LOOKBACK_MS
      ),
    ]);

    if (!bybitOk(openData)) {
      ordersError = bybitErrMsg(openData, 'Bybit rejected the open-orders request.');
    } else {
      const seenIds = new Set();
      const rawList = [...(openData.result?.list || []), ...historyResult.orders].filter((o) => {
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
          side: o.side === 'Buy' ? 1 : 2,
          orderType: isMarket ? 5 : 1,
          state: classifyBybitStatus(o.orderStatus),
          createTime: Number(o.createdTime),
        };
      });

      const scopeResult = scopeOrdersSinceOpeningMarketBuy(all, (o) => o.orderLinkId, isAppOrderLinkId);
      sinceTime = scopeResult.sinceTime;
      orders = scopeResult.scoped;
      openedByApp = scopeResult.openedByApp;
      orderDebug = {
        openOrdersSeen: (openData.result?.list || []).length,
        closedOrdersFromHistory: historyResult.orders.length,
        historyWindowsSearched: historyResult.windows,
        historyLookbackDaysSearched: historyResult.windows * 7,
        marketBuyFound: sinceTime !== null,
        openedByApp,
        openingOrderLinkId: scopeResult.openingOrder ? scopeResult.openingOrder.orderLinkId || '(empty)' : null,
        openingOrderCreateTime: scopeResult.openingOrder ? scopeResult.openingOrder.createTime : null,
      };
    }
  } catch (err) {
    ordersError = `Failed to reach Bybit for the order list: ${String(err.message || err)}`;
  }

  let pnl = null;
  let projectedLiquidation = null;

  if (position) {
    try {
      const [riskRes, tickerRes] = await Promise.all([
        bybitPublicGet('/v5/market/risk-limit', { category: 'linear', symbol }),
        bybitPublicGet('/v5/market/tickers', { category: 'linear', symbol }),
      ]);

      const tiers = bybitOk(riskRes) && Array.isArray(riskRes.result?.list) ? riskRes.result.list : [];
      const lowestTier = tiers.find((t) => Number(t.isLowestRisk) === 1) || tiers[0] || null;
      const mmr = lowestTier ? Number(lowestTier.maintenanceMargin ?? lowestTier.maintainMargin) : null;

      const ticker = bybitOk(tickerRes) && Array.isArray(tickerRes.result?.list) ? tickerRes.result.list[0] : null;
      const currentPrice = ticker ? Number(ticker.lastPrice) : null;

      const holdAvgPrice = Number(position.avgPrice);
      const holdVol = Number(position.size);
      const im = Number(position.positionIM);
      const leverage = Number(position.leverage) || 1;
      const isLong = position.side === 'Buy';

      if (currentPrice) {
        const { dollar, percent } = computePnl({ holdAvgPrice, holdVol, contractSize: 1, currentPrice, im, isLong });
        pnl = { dollar, percent, currentPrice };
      }

      const restingOrders = orders.filter((o) => o.state === 2);
      projectedLiquidation = computeProjectedLiquidation({ holdAvgPrice, holdVol, contractSize: 1, im, leverage, mmr, restingOrders });
    } catch {
      // leave pnl / projectedLiquidation as null
    }
  }

  res.status(200).json({
    hasPosition: !!position,
    position: position ? { ...position, holdAvgPrice: Number(position.avgPrice), holdVol: Number(position.size) } : null,
    orders,
    sinceTime,
    pnl,
    projectedLiquidation,
    ordersError,
    orderDebug,
    openedByApp,
  });
}

async function statusFromMexc(req, res, symbol) {
  const apiKey = process.env.MEXC_API_KEY;
  const secretKey = process.env.MEXC_API_SECRET;
  if (!apiKey || !secretKey) {
    res.status(500).json({
      error: 'MEXC_API_KEY and/or MEXC_API_SECRET are not set on the server. Add them in Vercel → Project Settings → Environment Variables, then redeploy.',
    });
    return;
  }

  let position = null;
  try {
    const posData = await futuresPrivateGet('/api/v1/private/position/open_positions', { symbol }, apiKey, secretKey);
    if (futuresOk(posData) && Array.isArray(posData.data)) {
      position = posData.data.find((p) => p.symbol === symbol && Number(p.holdVol) > 0) || null;
    } else {
      res.status(502).json({ error: futuresErrMsg(posData, 'Could not look up position.') });
      return;
    }
  } catch (err) {
    res.status(502).json({ error: 'Failed to reach MEXC.', detail: String(err.message || err) });
    return;
  }

  // MEXC's history_orders call (unlike Bybit's split open/closed views)
  // returns orders of every status for a symbol in one call, with an
  // optional `states` filter left unset here on purpose — that's what lets
  // this table mark which ladder rungs actually got hit without a second
  // "current orders" call.
  let orders = [];
  let sinceTime = null;
  let openedByApp = false;
  let ordersError = null;
  let orderDebug = null;
  try {
    const ordersData = await futuresPrivateGet('/api/v1/private/order/list/history_orders', { symbol, page_num: 1, page_size: 100 }, apiKey, secretKey);
    if (futuresOk(ordersData) && Array.isArray(ordersData.data)) {
      const all = ordersData.data
        .filter((o) => o.symbol === symbol)
        .map((o) => ({
          orderId: o.orderId,
          externalOid: o.externalOid,
          price: Number(o.price),
          vol: Number(o.vol),
          dealVol: Number(o.dealVol),
          dealAvgPrice: Number(o.dealAvgPrice),
          side: o.side,
          orderType: o.orderType,
          state: o.state,
          createTime: o.createTime,
        }));

      const scopeResult = scopeOrdersSinceOpeningMarketBuy(all, (o) => o.externalOid, isAppOrderTag);
      sinceTime = scopeResult.sinceTime;
      orders = scopeResult.scoped;
      openedByApp = scopeResult.openedByApp;
      orderDebug = {
        ordersSeenFromHistoryOrders: all.length,
        marketBuyFound: sinceTime !== null,
        openedByApp,
        openingOrderExternalOid: scopeResult.openingOrder ? scopeResult.openingOrder.externalOid || '(empty)' : null,
        openingOrderCreateTime: scopeResult.openingOrder ? scopeResult.openingOrder.createTime : null,
      };
    } else {
      ordersError = futuresErrMsg(ordersData, 'Could not look up orders.');
    }
  } catch (err) {
    ordersError = `Failed to reach MEXC for the order list: ${String(err.message || err)}`;
  }

  let pnl = null;
  let projectedLiquidation = null;
  let contractSize = null;

  if (position) {
    try {
      const [detail, ticker] = await Promise.all([getFuturesContractDetail(symbol), getFuturesTicker(symbol)]);

      contractSize = Number(detail.contractSize);
      const mmr = Number(detail.maintenanceMarginRate);
      const currentPrice = ticker ? Number(ticker.lastPrice) : null;

      const holdAvgPrice = Number(position.holdAvgPrice);
      const holdVol = Number(position.holdVol); // contracts
      const im = Number(position.im);
      const leverage = Number(position.leverage) || 1;
      const isLong = Number(position.positionType) === 1;

      if (contractSize && currentPrice) {
        const { dollar, percent } = computePnl({ holdAvgPrice, holdVol, contractSize, currentPrice, im, isLong });
        pnl = { dollar, percent, currentPrice };
      }

      const restingOrders = orders.filter((o) => o.state === 2);
      projectedLiquidation = computeProjectedLiquidation({ holdAvgPrice, holdVol, contractSize, im, leverage, mmr, restingOrders });

      // MEXC's vol/dealVol/holdVol fields are contract counts, not
      // base-asset quantity — convert here (after the calc functions above
      // already used the raw contract values) so the client can treat every
      // qty field as base-asset units consistently, same convention as
      // Bybit's response and demo mode's contractSize: 1 path.
      if (contractSize) {
        orders.forEach((o) => {
          o.vol = o.vol * contractSize;
          o.dealVol = o.dealVol * contractSize;
        });
        position.holdVol = holdVol * contractSize;
      }
    } catch {
      // leave pnl / projectedLiquidation as null
    }
  }

  res.status(200).json({
    hasPosition: !!position,
    position: position ? { ...position, holdAvgPrice: Number(position.holdAvgPrice), holdVol: Number(position.holdVol) } : null,
    orders,
    sinceTime,
    pnl,
    projectedLiquidation,
    ordersError,
    orderDebug,
    openedByApp,
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const exchange = String(req.query.exchange || 'bybit').toLowerCase();

  if (req.query.discover === '1') {
    if (exchange === 'mexc') {
      await discoverFromMexc(req, res);
    } else {
      await discoverFromBybit(req, res);
    }
    return;
  }

  const symbol = String(req.query.symbol || '').toUpperCase();
  if (!symbol) {
    res.status(400).json({ error: 'symbol query param is required.' });
    return;
  }

  if (exchange === 'mexc') {
    await statusFromMexc(req, res, symbol);
  } else {
    await statusFromBybit(req, res, symbol);
  }
};
