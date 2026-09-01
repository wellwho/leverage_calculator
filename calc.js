// Leveraged DCA ladder calculator — isolated margin, long.
//
// Liquidation Price = Avg Entry - (Margin - Maintenance Margin) / Quantity
// Maintenance Margin = Avg Entry x Quantity x MMR
// (isolated-margin formula; fees/funding ignored.)
//
// Full manual control, no reserve: every dollar of `capital` is committed
// directly as margin across the ladder's buys — nothing is deliberately held
// back as an untouched reserve for Bybit's Auto-Margin Replenishment (AMR)
// feature to draw on later. (An earlier version of this calculator solved
// for a scale factor that left part of `capital` uncommitted on purpose,
// sized so that if/when AMR pulled all of it in, liquidation would land
// exactly on a chosen target drawdown. That baked in an assumption — AMR
// will always be there and always have time to act before liquidation — this
// version doesn't make. What you enter as capital is what actually goes to
// work, full stop, same principle the Spot tab already uses.) You can still
// enable Bybit's AMR on the resulting position from the Bybit app as a
// general safety net if you want one; this calculator just doesn't design
// around it or assume it.
//
// Design: N buys spaced evenly in drawdown from 0% to (N-1)/N * targetDrawdown
// (targetDrawdown now controls purely how far down the ladder's price rungs
// reach — same role it plays on the Spot tab — not a liquidation target to
// solve for). Dollar size per buy grows geometrically (ratio r) up to the
// buy nearest `sweetSpotDrawdownPct` — the drawdown you want this plan to buy
// the most at, adjustable per-call — then shrinks geometrically (ratio 1/r)
// beyond it: early buys are small (price hasn't fallen far enough to be
// attractive yet), the buy(s) right around the sweet spot are the biggest,
// and buys beyond it taper back down. Liquidation price (per row and at the
// end of the ladder) is a plain, real, informational read-out computed
// purely from margin actually committed by the buys placed so far — never a
// solved-for target, never assuming any reserve gets tapped, because there
// isn't one.

const GROWTH_RATIO = 1.26;
const SWEET_SPOT_DRAWDOWN_PCT = 35; // default peak location; smaller before and after — overridable per-call via buildLadderShape's/computePlan's/computeSpotPlan's sweetSpotDrawdownPct param

// Shared by computePlan (leveraged) and computeSpotPlan (spot): both use the
// exact same N-buys-spaced-evenly-in-drawdown ladder, with the same
// sweet-spot-peaked weight shape, so their trigger prices *and* relative buy
// sizes land on identical points for the same inputs — that's what makes them
// directly comparable. Only what happens with the capital at each of those
// triggers (leverage applied to quantity vs. plain 1x spend) differs between
// the two — both now commit 100% of capital directly, no reserve held back
// on either tab.
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

function computePlan({ entry, leverage, mmr, capital, numBuys, targetDrawdownPct, sweetSpotDrawdownPct }) {
  if (entry <= 0 || leverage <= 0 || capital <= 0) throw new Error('Entry price, leverage and capital must be positive.');
  const { N, weights, peakIdx, drawdowns, prices, K1 } = buildLadderShape({ entry, numBuys, targetDrawdownPct, sweetSpotDrawdownPct });

  // No liquidation target to solve for — E1 just has to make the buys sum to
  // the full capital (weight-shaped, same sweet-spot-peaked shape as the
  // Spot tab). Leverage is applied per-row below, to quantity only.
  const E1 = capital / K1;
  const buyAmounts = weights.map((w) => E1 * w);
  const totalBuys = buyAmounts.reduce((a, b) => a + b, 0);

  const rows = [];
  let cumQty = 0;
  let avgEntry = null;
  let cumMargin = 0;

  for (let i = 0; i < N; i++) {
    const amt = buyAmounts[i];
    const price = prices[i];
    const qty = (amt * leverage) / price;
    const newCumQty = cumQty + qty;
    avgEntry = avgEntry === null ? price : (avgEntry * cumQty + price * qty) / newCumQty;
    cumQty = newCumQty;
    cumMargin += amt;
    // Real, informational liquidation price at the moment this buy fills —
    // computed purely from margin actually committed so far. No reserve, no
    // AMR assumption baked in anywhere.
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

  const last = rows[rows.length - 1];
  return {
    rows,
    totalBuys,
    totalDeployed: totalBuys, // always equals capital now — nothing withheld
    finalQty: last.cumQty,
    finalAvgEntry: last.avgEntry,
    finalLiq: last.liq, // real liquidation price once every buy has filled — informational only, not a solved-for target
    ladderDepth: drawdowns[drawdowns.length - 1], // how far the ladder actually reaches, as a fraction
    peakIdx,
  };
}

// Spot DCA ladder — same trigger prices as computePlan (same buildLadderShape
// call, same N/targetDrawdownPct/entry), but no leverage, no liquidation:
// every dollar of capital goes straight into buying the asset at its ladder
// price, full stop. Both tabs let the caller override where the buy-size
// peak sits via sweetSpotDrawdownPct (falls back to the shared
// SWEET_SPOT_DRAWDOWN_PCT default when omitted, so the two tabs still land
// on identical shapes for identical inputs by default) — the only thing that
// differs between the two is what happens to the capital at each trigger
// (leverage applied to quantity vs. plain 1x spend).
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

// Leveraged-only: does a computed ladder actually survive to fill every row,
// or does it get liquidated partway down before a later buy ever triggers?
//
// Because computePlan now commits 100% of capital as margin at a fixed
// leverage (no reserve — see computePlan's header comment), there's a clean
// closed-form identity buried in its liq formula: every row's margin equals
// that row's own notional ÷ leverage (amt_i = price_i * qty_i / leverage,
// straight from qty_i = amt_i * leverage / price_i), so cumMargin/cumQty
// collapses to exactly avgEntry/leverage — regardless of how the ladder's
// weights are shaped. That makes every row's liquidation price exactly
//   avgEntry * (1 + mmr - 1/leverage)
// i.e. a FIXED percentage below whatever the CURRENT average entry happens
// to be, at every single row. Peak buy drawdown doesn't change that
// percentage at all — what it changes is how fast avgEntry itself falls to
// keep pace with the falling price, which is what determines whether the
// ladder can actually reach deeper rows before that fixed cushion runs out.
//
// This checks exactly that: walking the rows in order, does each row's own
// liq stay below the NEXT row's trigger price (so that next buy can actually
// fill before liquidation)? The first failure marks how deep the ladder
// really reaches versus how deep it was asked to reach.
function ladderSurvival(plan) {
  const rows = plan.rows;
  for (let i = 0; i < rows.length - 1; i++) {
    if (rows[i].liq >= rows[i + 1].price) {
      return { survivesFully: false, failedAtStep: rows[i + 1].step, survivedDrawdownPct: rows[i].drawdown * 100 };
    }
  }
  const last = rows[rows.length - 1];
  return { survivesFully: true, failedAtStep: null, survivedDrawdownPct: last.drawdown * 100 };
}

// Scans every achievable Peak buy drawdown value (1%-99%, 1% steps) for a
// given leverage / MMR / numBuys / targetDrawdownPct "shape" and reports
// whether each one lets the resulting ladder fully survive to its last row.
// Entry price and capital never affect the answer — ladderSurvival's
// liq/avgEntry comparison reduces entirely to price RATIOS relative to the
// first buy (both leg's absolute scale cancels out), so this always uses
// fixed placeholder values for them. That also means callers don't need the
// user's real entry/capital fields, which may be blank/invalid mid-edit —
// only the four "shape" inputs matter here.
function scanPeakFeasibility({ leverage, mmr, numBuys, targetDrawdownPct }) {
  const results = [];
  for (let peak = 1; peak <= 99; peak++) {
    try {
      const plan = computePlan({ entry: 100, leverage, mmr, capital: 1000, numBuys, targetDrawdownPct, sweetSpotDrawdownPct: peak });
      const surv = ladderSurvival(plan);
      results.push({ peak, survivesFully: surv.survivesFully, survivedDrawdownPct: surv.survivedDrawdownPct });
    } catch (e) {
      results.push({ peak, survivesFully: false, survivedDrawdownPct: 0 });
    }
  }
  return results;
}

// Same idea as scanPeakFeasibility, but samples Peak buy drawdown as a
// PERCENTAGE OF THE TARGET DRAWDOWN (1%-100%, 1% steps) instead of an
// absolute drawdown-from-entry percentage. This is what the UI's Peak buy
// drawdown slider actually drives: "the weight sits at -50% drawdown" is
// meaningless (and used to silently just clamp to the ladder's last row)
// once Target Drawdown is set shallower than that — e.g. a 40% target
// ladder never reaches -50% at all — but "the weight sits 50% of the way
// down the ladder's own depth" is always well-defined no matter what the
// target is set to. Each sample's absolute equivalent
// (peakPct/100 * targetDrawdownPct) is what's actually passed through to
// computePlan/ladderSurvival — this is purely a re-parameterization of the
// same survival model in scanPeakFeasibility, not a different one.
function scanPeakFeasibilityRelative({ leverage, mmr, numBuys, targetDrawdownPct }) {
  const results = [];
  for (let peakPct = 1; peakPct <= 100; peakPct++) {
    const absolutePeakPct = (peakPct / 100) * targetDrawdownPct;
    try {
      const plan = computePlan({ entry: 100, leverage, mmr, capital: 1000, numBuys, targetDrawdownPct, sweetSpotDrawdownPct: absolutePeakPct });
      const surv = ladderSurvival(plan);
      results.push({ peakPct, absolutePeakPct, survivesFully: surv.survivesFully, survivedDrawdownPct: surv.survivedDrawdownPct });
    } catch (e) {
      results.push({ peakPct, absolutePeakPct, survivesFully: false, survivedDrawdownPct: 0 });
    }
  }
  return results;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { computePlan, computeSpotPlan, GROWTH_RATIO, SWEET_SPOT_DRAWDOWN_PCT, ladderSurvival, scanPeakFeasibility, scanPeakFeasibilityRelative };
}
