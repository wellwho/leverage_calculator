// Leveraged DCA ladder calculator — isolated margin, long.
//
// Liquidation Price = Avg Entry - (Margin - Maintenance Margin) / Quantity
// Maintenance Margin = Avg Entry x Quantity x MMR
// (MEXC isolated-margin formula; fees/funding ignored.)
//
// Margin = cumulative dollars ever put into the position as buy fills. Unlike
// an earlier version of this calculator, the leftover capital ("margin" /
// reserve below) is never itself injected into the position at any specific
// step — it's left as genuinely uncommitted balance in the futures wallet,
// on the assumption that MEXC's own Auto-Margin feature (enabled on the
// position, outside this app) will draw on it and top up margin automatically
// if/when liquidation becomes imminent, at whatever point in the ladder's
// life that turns out to be. See api/execute.js and README.md for the
// mechanical reasoning: a resting limit order freezes its own margin, so this
// reserve has to stay unplaced (not tied to any order) to actually be
// available for MEXC to pull from.
//
// Design: N buys spaced evenly in drawdown from 0% to (N-1)/N * targetDrawdown,
// leaving one spacing-unit of buffer before the liquidation target — same
// spacing scheme as before. Dollar size per buy is no longer monotonically
// increasing: it grows geometrically (ratio r) up to the buy nearest
// SWEET_SPOT_DRAWDOWN_PCT — the drawdown this plan wants to buy the most at —
// then shrinks geometrically (ratio 1/r) beyond it. That means early buys are
// small (price hasn't fallen far enough to be attractive yet), the buy(s)
// right around the sweet spot are the biggest, and buys beyond it taper back
// down (still adding to the position and still needed to keep lowering avg
// entry, but no longer sized as the highest-conviction rungs). Because every
// rung is smaller than the old monotonic-growth shape would have made it, the
// naive per-rung liquidation price (computed from buy margin only, ignoring
// the untouched reserve) frequently sits worse than the next buy's trigger
// price — by design, this plan is relying on MEXC's Auto-Margin to bridge
// that gap rather than self-funding every rung's full safety margin the way
// the old shape did. Each row flags this (`autoMarginNeeded`) so it's visible
// rather than hidden.
//
// Still solved in closed form for the scale factor that lands the
// *protected* liquidation price (i.e. once the full reserve is counted, which
// is what happens if/when MEXC's Auto-Margin has drawn all of it in) exactly
// on the requested target drawdown — this is still the one true anchor input,
// capped below 100%.

const GROWTH_RATIO = 1.26;
const SWEET_SPOT_DRAWDOWN_PCT = 35; // default peak location; smaller before and after — overridable per-call via buildLadderShape's/computeSpotPlan's sweetSpotDrawdownPct param

// Shared by computePlan (leveraged) and computeSpotPlan (spot): both use the
// exact same N-buys-spaced-evenly-in-drawdown ladder, with the same
// sweet-spot-peaked weight shape, so their trigger prices *and* relative buy
// sizes land on identical points for the same inputs — that's what makes them
// directly comparable. Only what happens with the capital at each of those
// triggers (margin + leverage vs. plain spend) differs between the two.
// Note: this does NOT validate `entry` itself — each caller checks that
// (with its own appropriately-worded message, since computePlan's mentions
// leverage/capital and computeSpotPlan's doesn't) before calling in, so
// error wording for existing callers doesn't shift under this refactor.
function buildLadderShape({ entry, numBuys, targetDrawdownPct, sweetSpotDrawdownPct = SWEET_SPOT_DRAWDOWN_PCT }) {
  const N = Math.round(numBuys);
  const T = targetDrawdownPct / 100;
  if (N < 1) throw new Error('Number of buys must be at least 1.');
  if (T <= 0 || T >= 1) throw new Error('Target drawdown coverage must be between 0% and 100% (exclusive).');
  if (!(sweetSpotDrawdownPct > 0) || sweetSpotDrawdownPct >= 100) {
    throw new Error('Peak buy drawdown must be between 0% and 100% (exclusive).');
  }

  const r = GROWTH_RATIO;
  const spacing = T / N;
  const drawdowns = Array.from({ length: N }, (_, i) => i * spacing);
  const prices = drawdowns.map((d) => entry * (1 - d));

  // The rung whose drawdown lands closest to the sweet spot is the peak.
  // If the sweet spot is beyond this ladder's coverage (a shallow target
  // drawdown shallower than sweetSpotDrawdownPct), the peak clamps to the
  // last buy and the whole ladder degenerates to pure growth — the same
  // shape this calculator used before.
  const peakIdx = Math.min(N - 1, Math.max(0, Math.round(sweetSpotDrawdownPct / 100 / spacing)));

  // Symmetric (in log space) hump: ×r per step growing into the peak, ×1/r
  // per step shrinking out of it.
  const weights = Array.from({ length: N }, (_, i) =>
    i <= peakIdx ? Math.pow(r, i) : Math.pow(r, peakIdx) * Math.pow(1 / r, i - peakIdx)
  );

  let K1 = 0;
  for (let i = 0; i < N; i++) K1 += weights[i];

  return { N, T, weights, peakIdx, drawdowns, prices, K1 };
}

function computePlan({ entry, leverage, mmr, capital, numBuys, targetDrawdownPct }) {
  if (entry <= 0 || leverage <= 0 || capital <= 0) throw new Error('Entry price, leverage and capital must be positive.');
  const { N, T, weights, peakIdx, drawdowns, prices, K1 } = buildLadderShape({ entry, numBuys, targetDrawdownPct });

  let K2 = 0;
  for (let i = 0; i < N; i++) K2 += weights[i] / prices[i];

  const targetLiq = entry * (1 - T);
  const denom = leverage * (K1 * (1 + mmr) - K2 * targetLiq);
  if (denom <= 0) {
    throw new Error('This combination of leverage / MMR / number of buys cannot reach that drawdown target — try fewer buys, lower leverage, or a shallower target.');
  }
  const E1 = capital / denom;

  const buyAmounts = weights.map((w) => E1 * w);
  const totalBuys = buyAmounts.reduce((a, b) => a + b, 0);
  // Reserve — capital minus what's actually placed into buy orders. Never
  // actively added anywhere by this app; left as available futures balance
  // for MEXC's Auto-Margin to draw on if/when needed. See header comment.
  const margin = capital - totalBuys;

  if (margin < 0) {
    throw new Error('Computed margin is negative — this target/leverage/N combination is infeasible on this budget.');
  }

  const rows = [];
  let cumQty = 0;
  let avgEntry = null;
  let cumMargin = 0; // buys only — the reserve is never counted here, since nothing has actually committed it yet

  for (let i = 0; i < N; i++) {
    const amt = buyAmounts[i];
    const price = prices[i];
    const qty = (amt * leverage) / price;
    const newCumQty = cumQty + qty;
    avgEntry = avgEntry === null ? price : (avgEntry * cumQty + price * qty) / newCumQty;
    cumQty = newCumQty;
    cumMargin += amt;
    // Naive: assumes none of the reserve has been drawn in by MEXC yet — the
    // real, immediate liquidation price at the moment this buy fills.
    const liq = avgEntry * (1 + mmr) - cumMargin / cumQty;
    rows.push({
      step: i + 1,
      action: `Limit Buy #${i + 1}`,
      price,
      drawdown: drawdowns[i],
      amount: amt,
      newQty: qty,
      cumQty,
      avgEntry,
      liq,
      isPeak: i === peakIdx,
    });
  }

  // Per rung, flag whether this buy's own margin alone would carry the
  // position to the *next* buy's trigger price, or whether — because this
  // shape intentionally doesn't over-fund every rung — MEXC's Auto-Margin
  // would need to draw on the untouched reserve to bridge the gap first.
  for (let i = 0; i < N - 1; i++) {
    rows[i].autoMarginNeeded = rows[i].liq > rows[i + 1].price;
  }
  // After the last buy: whether reaching the protected target still requires
  // tapping the reserve at all (true whenever margin > 0, i.e. essentially
  // always — the reserve exists precisely to cover this last stretch).
  rows[N - 1].autoMarginNeeded = margin > 0 && rows[N - 1].liq > targetLiq;

  const last = rows[rows.length - 1];
  return {
    rows,
    totalBuys,
    margin,
    totalDeployed: totalBuys + margin,
    finalQty: last.cumQty,
    finalAvgEntry: last.avgEntry,
    naiveFinalLiq: last.liq, // real liquidation price if the reserve is never tapped
    protectedFinalLiq: targetLiq, // solved-for target — what the reserve, once drawn in, guarantees
    drawdownCovered: T,
    peakIdx,
  };
}

// Spot DCA ladder — same trigger prices as computePlan (same buildLadderShape
// call, same N/targetDrawdownPct/entry), but no leverage, no margin buffer,
// no liquidation: every dollar of capital goes straight into buying the asset
// at its ladder price, full stop. Unlike the leveraged tab, the Spot tab lets
// the caller override where the buy-size peak sits via sweetSpotDrawdownPct
// (falls back to the shared SWEET_SPOT_DRAWDOWN_PCT default when omitted, so
// the two tabs still land on identical shapes for identical inputs by
// default) — the only other thing that differs is what happens to the
// capital at each trigger.
function computeSpotPlan({ entry, capital, numBuys, targetDrawdownPct, sweetSpotDrawdownPct }) {
  if (entry <= 0 || capital <= 0) throw new Error('Entry price and capital must be positive.');
  const { N, weights, peakIdx, drawdowns, prices, K1 } = buildLadderShape({ entry, numBuys, targetDrawdownPct, sweetSpotDrawdownPct });

  // No liquidation target to solve for — E1 just has to make the buys sum
  // to the full capital (weight-shaped, same sweet-spot-peaked shape as the
  // leveraged ladder).
  const E1 = capital / K1;
  const buyAmounts = weights.map((w) => E1 * w);
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
      isPeak: i === peakIdx,
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
    peakIdx,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { computePlan, computeSpotPlan, GROWTH_RATIO, SWEET_SPOT_DRAWDOWN_PCT };
}
