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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { computePnl, computeProjectedLiquidation };
}
