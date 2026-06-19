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

function computePlan({ entry, leverage, mmr, capital, numBuys, targetDrawdownPct }) {
  const N = Math.round(numBuys);
  const T = targetDrawdownPct / 100;
  if (N < 1) throw new Error('Number of buys must be at least 1.');
  if (T <= 0 || T >= 1) throw new Error('Target drawdown coverage must be between 0% and 100% (exclusive).');
  if (entry <= 0 || leverage <= 0 || capital <= 0) throw new Error('Entry price, leverage and capital must be positive.');

  const r = GROWTH_RATIO;
  const spacing = T / N;
  const drawdowns = Array.from({ length: N }, (_, i) => i * spacing);
  const prices = drawdowns.map((d) => entry * (1 - d));

  let K1 = 0;
  let K2 = 0;
  for (let i = 0; i < N; i++) {
    const w = Math.pow(r, i);
    K1 += w;
    K2 += w / prices[i];
  }

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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { computePlan, GROWTH_RATIO };
}
