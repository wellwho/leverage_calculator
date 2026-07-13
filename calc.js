// Leveraged DCA ladder calculator — isolated margin, long.
//
// Liquidation Price = Avg Entry - (Margin - Maintenance Margin) / Quantity
// Maintenance Margin = Avg Entry x Quantity x MMR
// (MEXC isolated-margin formula; fees/funding ignored.)
//
// Margin = cumulative dollars ever put into the position (every buy's dollar
// amount is itself margin for that leveraged fill, plus any explicit
// margin top-up) — by the final row this always equals total capital.
// This makes the result path-independent: only N, the target drawdown,
// leverage, MMR and capital determine the final ladder.
//
// Design: N buys spaced evenly in drawdown from 0% to (N-1)/N * targetDrawdown,
// leaving one spacing-unit of buffer before the liquidation target. Dollar
// size per buy grows geometrically (ratio r) so the position scales up as
// price falls; r is fixed at 1.26 to match the proven reference plan.
// Solved in closed form for the first-buy size that lands liquidation
// exactly on the requested target drawdown.

const GROWTH_RATIO = 1.26;

// Shared by computePlan (leveraged) and computeSpotPlan (spot): both use the
// exact same N-buys-spaced-evenly-in-drawdown, geometric-growth-ratio ladder
// shape, so their trigger prices land on identical points for the same
// inputs — that's what makes them directly comparable. Only what happens
// with the capital at each of those triggers differs between the two.
// Note: this does NOT validate `entry` itself — each caller checks that
// (with its own appropriately-worded message, since computePlan's mentions
// leverage/capital and computeSpotPlan's doesn't) before calling in, so
// error wording for existing callers doesn't shift under this refactor.
function buildLadderShape({ entry, numBuys, targetDrawdownPct }) {
  const N = Math.round(numBuys);
  const T = targetDrawdownPct / 100;
  if (N < 1) throw new Error('Number of buys must be at least 1.');
  if (T <= 0 || T >= 1) throw new Error('Target drawdown coverage must be between 0% and 100% (exclusive).');

  const r = GROWTH_RATIO;
  const spacing = T / N;
  const drawdowns = Array.from({ length: N }, (_, i) => i * spacing);
  const prices = drawdowns.map((d) => entry * (1 - d));

  let K1 = 0;
  for (let i = 0; i < N; i++) K1 += Math.pow(r, i);

  return { N, T, r, drawdowns, prices, K1 };
}

function computePlan({ entry, leverage, mmr, capital, numBuys, targetDrawdownPct }) {
  if (entry <= 0 || leverage <= 0 || capital <= 0) throw new Error('Entry price, leverage and capital must be positive.');
  const { N, T, r, drawdowns, prices, K1 } = buildLadderShape({ entry, numBuys, targetDrawdownPct });

  let K2 = 0;
  for (let i = 0; i < N; i++) K2 += Math.pow(r, i) / prices[i];

  const targetLiq = entry * (1 - T);
  const denom = leverage * (K1 * (1 + mmr) - K2 * targetLiq);
  if (denom <= 0) {
    throw new Error('This combination of leverage / MMR / number of buys cannot reach that drawdown target — try fewer buys, lower leverage, or a shallower target.');
  }
  const E1 = capital / denom;

  const buyAmounts = drawdowns.map((_, i) => E1 * Math.pow(r, i));
  const totalBuys = buyAmounts.reduce((a, b) => a + b, 0);
  const margin = capital - totalBuys;

  if (margin < 0) {
    throw new Error('Computed margin is negative — this target/leverage/N combination is infeasible on this budget.');
  }

  const rows = [];

  // Step 1: first buy
  const qty1 = (buyAmounts[0] * leverage) / prices[0];
  let cumQty = qty1;
  let avgEntry = prices[0];
  let cumMargin = buyAmounts[0];
  rows.push({
    step: 1,
    action: 'Limit Buy #1',
    price: prices[0],
    drawdown: drawdowns[0],
    amount: buyAmounts[0],
    newQty: qty1,
    cumQty,
    avgEntry,
    liq: null, // nothing at risk yet
  });

  // Step 2: margin add (right after buy #1 fills)
  cumMargin += margin;
  let liq = avgEntry * (1 + mmr) - cumMargin / cumQty;
  rows.push({
    step: 2,
    action: 'Add Margin',
    price: prices[0],
    drawdown: 0,
    amount: margin,
    newQty: 0,
    cumQty,
    avgEntry,
    liq,
  });

  // Steps 3..N+1: remaining buys
  for (let i = 1; i < N; i++) {
    const amt = buyAmounts[i];
    const price = prices[i];
    const qty = (amt * leverage) / price;
    const newCumQty = cumQty + qty;
    avgEntry = (avgEntry * cumQty + price * qty) / newCumQty;
    cumQty = newCumQty;
    cumMargin += amt;
    liq = avgEntry * (1 + mmr) - cumMargin / cumQty;
    rows.push({
      step: i + 2,
      action: `Limit Buy #${i + 1}`,
      price,
      drawdown: drawdowns[i],
      amount: amt,
      newQty: qty,
      cumQty,
      avgEntry,
      liq,
    });
  }

  const last = rows[rows.length - 1];
  return {
    rows,
    totalBuys,
    margin,
    totalDeployed: totalBuys + margin,
    finalQty: last.cumQty,
    finalAvgEntry: last.avgEntry,
    finalLiq: last.liq,
    drawdownCovered: (entry - last.liq) / entry,
  };
}

// Spot DCA ladder — same trigger prices as computePlan (same buildLadderShape
// call, same N/targetDrawdownPct/entry), but no leverage, no margin buffer,
// no liquidation: every dollar of capital goes straight into buying the
// asset at its ladder price, full stop. This intentionally reuses the exact
// same ladder shape as the leveraged version so the two are directly
// comparable — same trigger points, same growth ratio — the only thing that
// differs is what happens to the capital at each trigger.
function computeSpotPlan({ entry, capital, numBuys, targetDrawdownPct }) {
  if (entry <= 0 || capital <= 0) throw new Error('Entry price and capital must be positive.');
  const { N, drawdowns, prices, K1 } = buildLadderShape({ entry, numBuys, targetDrawdownPct });

  // No liquidation target to solve for — E1 just has to make the buys sum
  // to the full capital (r^i-weighted, same growth shape as the leveraged
  // ladder).
  const E1 = capital / K1;
  const buyAmounts = drawdowns.map((_, i) => E1 * Math.pow(GROWTH_RATIO, i));
  const totalBuys = buyAmounts.reduce((a, b) => a + b, 0);

  const rows = [];
  let cumQty = 0;
  let avgEntry = null;
  let cumSpent = 0;

  for (let i = 0; i < N; i++) {
    const amt = buyAmounts[i];
    const price = prices[i];
    const qty = amt / price; // 1x — no leverage, one dollar buys 1/price units
    const newCumQty = cumQty + qty;
    avgEntry = avgEntry === null ? price : (avgEntry * cumQty + price * qty) / newCumQty;
    cumQty = newCumQty;
    cumSpent += amt;
    rows.push({
      step: i + 1,
      action: `Buy #${i + 1}`,
      price,
      drawdown: drawdowns[i],
      amount: amt,
      newQty: qty,
      cumQty,
      avgEntry,
    });
  }

  const last = rows[rows.length - 1];
  return {
    rows,
    totalBuys,
    totalDeployed: totalBuys, // no separate margin step — this always equals capital
    finalQty: last.cumQty,
    finalAvgEntry: last.avgEntry,
    lowestPrice: prices[prices.length - 1],
    ladderDepth: drawdowns[drawdowns.length - 1], // how far the ladder actually reaches, as a fraction
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { computePlan, computeSpotPlan, GROWTH_RATIO };
}
