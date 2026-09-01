// Pure calculation helpers for api/status.js — position P&L and the
// "if fully filled" projected liquidation price. Split out into their own
// module (same idea as calc.js for the ladder) so they can be backfill-
// tested against known-good numbers instead of only having been checked
// once by hand during development.
//
// Note: computeProjectedLiquidation uses the long-position isolated-margin
// formula only (Avg Entry × (1 + MMR) − Total Margin ÷ Quantity), matching
// this app's scope — it only ever opens long positions. computePnl is
// direction-aware (isLong flag) since that part is cheap to get right for
// both sides, but the liquidation projection is not intended for a short.

function computePnl({ holdAvgPrice, holdVol, contractSize, currentPrice, im, isLong }) {
  const qtyBase = holdVol * contractSize;
  const dollar = (isLong ? currentPrice - holdAvgPrice : holdAvgPrice - currentPrice) * qtyBase;
  const percent = im > 0 ? (dollar / im) * 100 : null;
  return { dollar, percent };
}

// restingOrders: [{ price, vol, state }] — only entries with state === 2
// (still on the book) should be passed in; the caller is responsible for
// that filter (api/status.js does it before calling this).
function computeProjectedLiquidation({ holdAvgPrice, holdVol, contractSize, im, leverage, mmr, restingOrders }) {
  if (!contractSize || mmr === null || mmr === undefined || !(im > 0)) return null;

  let qtyBase = holdVol * contractSize;
  let notionalSum = holdAvgPrice * qtyBase;
  let marginTotal = im;

  (restingOrders || []).forEach((o) => {
    const oQtyBase = o.vol * contractSize;
    notionalSum += o.price * oQtyBase;
    qtyBase += oQtyBase;
    marginTotal += (oQtyBase * o.price) / leverage;
  });

  if (qtyBase <= 0) return null;
  const projectedAvgEntry = notionalSum / qtyBase;
  return projectedAvgEntry * (1 + mmr) - marginTotal / qtyBase;
}

// Shared "since last Execute" order-scoping logic, used by both the
// Leveraged (api/status.js) and Spot (api/spot/[action].js's handleStatus)
// status endpoints, on either exchange, once each has normalized its raw
// exchange response into this app's own order shape:
//   { price, vol, dealVol, dealAvgPrice, side, orderType, state, createTime, ... }
// side: 1 = buy, 2 = sell. orderType: 5 = market, 1 = limit (this app's own
// encoding, carried over from MEXC's native enum, which every exchange's
// orders get normalized into).
//
// Finds the most recent open-long MARKET order (Buy #1 of this app's ladder
// always fires as one of those) and returns only orders from that timestamp
// onward, sorted by price descending -- so a prior, already-closed run on
// the same symbol doesn't get dragged into "this run"'s table. Does NOT
// filter by side itself (Leveraged's status table shows sells too, e.g. a
// manual reduce; Spot's handleStatus applies its own extra
// .filter(o => o.side === 1) on top of this when it wants buys only) --
// kept as a separate step so both tabs' slightly different needs stay
// expressed at the call site, not baked into this shared helper.
//
// getOpeningTag(order): reads whichever field carries this app's own order
// tag on the exchange/market this call is for (Bybit's orderLinkId, MEXC
// futures' externalOid, MEXC spot's clientOrderId).
// isAppTag(tag): the matching isAppOrderLinkId/isAppOrderTag checker.
function scopeOrdersSinceOpeningMarketBuy(orders, getOpeningTag, isAppTag) {
  const byPriceDesc = (a, b) => b.price - a.price;
  const marketBuys = orders.filter((o) => o.side === 1 && o.orderType === 5);

  if (marketBuys.length === 0) {
    return { sinceTime: null, scoped: orders.slice().sort(byPriceDesc), openedByApp: false, openingOrder: null };
  }

  const sinceTime = Math.max(...marketBuys.map((o) => Number(o.createTime)));
  const openingOrder = marketBuys.find((o) => Number(o.createTime) === sinceTime);
  const openedByApp = !!openingOrder && isAppTag(getOpeningTag(openingOrder));
  const scoped = orders.filter((o) => Number(o.createTime) >= sinceTime).sort(byPriceDesc);

  return { sinceTime, scoped, openedByApp, openingOrder };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { computePnl, computeProjectedLiquidation, scopeOrdersSinceOpeningMarketBuy };
}
