// Validation for calc.js's computePlan (the leveraged ladder-sizing engine).
//
// This version commits 100% of capital directly across the ladder's buys —
// no reserve is held back for Bybit's Auto-Margin Replenishment (AMR) to
// draw on, and there's no "protected liquidation" target to solve for.
// Structurally, computePlan is now a leveraged sibling of computeSpotPlan
// (same buildLadderShape call, same sweet-spot-peaked weight distribution,
// same E1 = capital / K1 sizing) — the only things that differ are leverage
// applied to quantity, and a real (informational, never solved-for)
// liquidation price computed per row from margin actually committed so far.
// See test/spot-backfill.test.js's header for why there's no external
// backfill source for this shape; the same reasoning applies here. This
// suite checks:
//
//   1. An exactly hand-derived single-buy fixture (small enough to verify
//      with a calculator, not spreadsheet software).
//   2. A hand-derived multi-buy fixture with an explicit sweetSpotDrawdownPct
//      override, confirming the peak-buy control actually plumbs through
//      (and lands somewhere different than the shared default would).
//   3. Structural invariants that must hold for *any* valid input, re-derived
//      independently of computePlan's own internals: capital conservation
//      (totalBuys == capital, nothing withheld), the sweet-spot peak landing
//      where the ladder's own spacing says it should, the hump actually
//      being a hump, and the reported avgEntry/liq at every row matching an
//      independent reconstruction from each row's own raw price/qty/amount.
//   4. The pre-existing input-validation error paths (minus the old
//      "negative margin" infeasibility case, which can no longer happen now
//      that there's no reserve to solve for — E1 = capital / K1 is always
//      well-defined for valid inputs).
//   5. ladderSurvival/scanPeakFeasibility — the "does this ladder actually
//      survive to fill every row before liquidation?" helpers backing the
//      Leveraged tab's feasibility indicator. Hand-reasoned from the closed-
//      form identity these rely on (liq_i == avgEntry_i * (1 + mmr -
//      1/leverage), true for ANY weight shape once 100% of capital is
//      committed as margin — see calc.js's ladderSurvival header comment for
//      the derivation): a single-buy plan trivially "survives" (no next row
//      to fail at), a case where NO peak placement can reach the requested
//      target drawdown at all (the shortfall is structural, not fixable by
//      re-weighting), a case where only a deep-enough peak reaches the full
//      target, and a case where low leverage makes the whole thing trivially
//      safe regardless of peak.
//   6. scanPeakFeasibilityRelative — the same feasibility scan, but sampling
//      Peak buy drawdown as a percentage OF THE TARGET DRAWDOWN (what the
//      UI's slider actually drives) rather than an absolute drawdown from
//      entry. Confirms the relative→absolute conversion is exact and that
//      the resulting survival verdicts match scanPeakFeasibility's own
//      results at the equivalent absolute value.
//
// Run manually:   npm test        (or: node test/backfill.test.js)
// Run on deploy:  wired into vercel.json's buildCommand — see README.

const { computePlan, ladderSurvival, scanPeakFeasibility, scanPeakFeasibilityRelative } = require('../calc.js');

function closeEnough(actual, expected) {
  if (typeof actual !== 'number' || typeof expected !== 'number') return actual === expected;
  return Math.abs(actual - expected) <= 1e-6 * Math.max(1, Math.abs(expected));
}

let failures = 0;

function check(label, actual, expected) {
  const ok = typeof expected === 'boolean' ? actual === expected : closeEnough(actual, expected);
  if (ok) {
    console.log(`  PASS ${label}: ${actual}`);
  } else {
    console.log(`  FAIL ${label}: expected ${expected}, got ${actual}`);
    failures++;
  }
}

console.log('\nFixture A — single-buy plan, hand-derived exactly (entry 100, 5x, 1% MMR, $1000 capital, 50% depth)');
{
  // Hand check: N=1 so weights=[1], K1=1. E1 = capital/K1 = 1000.
  // price = entry*(1-0) = 100 (single buy always triggers at entry).
  // qty = 1000*5/100 = 50. avgEntry = 100. cumMargin = 1000.
  // liq = 100*1.01 - 1000/50 = 101 - 20 = 81.
  const r = computePlan({ entry: 100, leverage: 5, mmr: 0.01, capital: 1000, numBuys: 1, targetDrawdownPct: 50 });
  check('rows.length', r.rows.length, 1);
  check('rows[0].amount (== totalBuys == capital)', r.rows[0].amount, 1000);
  check('rows[0].newQty', r.rows[0].newQty, 50);
  check('rows[0].liq', r.rows[0].liq, 81);
  check('totalBuys == capital (nothing withheld)', r.totalBuys, 1000);
  check('totalDeployed == capital', r.totalDeployed, 1000);
  check('finalLiq', r.finalLiq, 81);
  check('ladderDepth (single buy always triggers at 0% drawdown)', r.ladderDepth, 0);
  check('peakIdx', r.peakIdx, 0);
}

console.log("\nFixture B — 4-buy plan with an explicit sweetSpotDrawdownPct override (entry 100, 3x, 1% MMR, $900 capital, 80% depth, peak forced to 25%)");
{
  // spacing = 80/4 = 20%, drawdowns = [0%, 20%, 40%, 60%], prices = [100, 80, 60, 40].
  // Default sweet spot (35%) would land peakIdx at round(35/20) = round(1.75) = 2.
  // Forcing sweetSpotDrawdownPct=25 instead: round(25/20) = round(1.25) = 1 —
  // a different rung, proving the override actually takes effect rather than
  // silently falling back to the shared default.
  const r = computePlan({ entry: 100, leverage: 3, mmr: 0.01, capital: 900, numBuys: 4, targetDrawdownPct: 80, sweetSpotDrawdownPct: 25 });
  check('peakIdx (forced by override, not the 35% default)', r.peakIdx, 1);
  check('rows[0].price', r.rows[0].price, 100);
  check('rows[1].price', r.rows[1].price, 80);
  check('rows[2].price', r.rows[2].price, 60);
  check('rows[3].price', r.rows[3].price, 40);
  const rr = 1.26;
  const K1 = 1 + rr + rr / rr + rr / (rr * rr); // i=0: r^0; i=1(peak): r^1; i=2: r^1*(1/r)^1; i=3: r^1*(1/r)^2
  const E1 = 900 / K1;
  const buy1 = E1, buy2 = E1 * rr, buy3 = E1 * rr * (1 / rr), buy4 = E1 * rr * (1 / rr) * (1 / rr);
  check('rows[0].amount', r.rows[0].amount, buy1);
  check('rows[1].amount (peak — biggest buy)', r.rows[1].amount, buy2);
  check('rows[2].amount', r.rows[2].amount, buy3);
  check('rows[3].amount', r.rows[3].amount, buy4);
  check('totalBuys == capital', r.totalBuys, 900);
}

console.log('\nFixture C — structural invariants across a spread of inputs');
{
  const combos = [
    { label: 'old reference inputs (12 buys, deep 95% depth — sweet spot well inside range)', input: { entry: 0.223, leverage: 5, mmr: 0.01, capital: 951, numBuys: 12, targetDrawdownPct: 95 } },
    { label: 'shallow depth (sweet spot beyond range — should degenerate to pure growth)', input: { entry: 100, leverage: 10, mmr: 0.005, capital: 500, numBuys: 6, targetDrawdownPct: 20 } },
    { label: 'sweet spot exactly on a rung', input: { entry: 100, leverage: 10, mmr: 0.01, capital: 2000, numBuys: 20, targetDrawdownPct: 70 } },
    { label: 'small N, deep depth', input: { entry: 50, leverage: 8, mmr: 0.02, capital: 300, numBuys: 4, targetDrawdownPct: 90 } },
  ];

  for (const { label, input } of combos) {
    const r = computePlan(input);
    const N = r.rows.length;
    const T = input.targetDrawdownPct / 100;
    const spacing = T / N;

    check(`${label}: rows.length == numBuys`, N, input.numBuys);
    check(`${label}: totalBuys == capital (nothing withheld)`, r.totalBuys, input.capital);
    check(`${label}: totalDeployed == capital`, r.totalDeployed, input.capital);
    // The last buy's drawdown is (N-1)/N * T — one spacing-unit short of T
    // itself, by design (leaves a buffer before the nominal target).
    check(`${label}: ladderDepth == (N-1)/N * T`, r.ladderDepth, ((N - 1) / N) * T);
    check(`${label}: finalLiq == last row's liq`, r.finalLiq, r.rows[N - 1].liq);

    // Peak = the rung whose drawdown lands closest to -35% (the default,
    // unoverridden here), clamped to the ladder's own range — computed here
    // independently of calc.js's formula.
    const expectedPeak = Math.min(N - 1, Math.max(0, Math.round(0.35 / spacing)));
    check(`${label}: peakIdx`, r.peakIdx, expectedPeak);

    // Hump shape: strictly increasing $ amounts up to the peak, strictly
    // decreasing after it.
    let humpOk = true;
    for (let i = 1; i <= r.peakIdx; i++) if (!(r.rows[i].amount > r.rows[i - 1].amount)) humpOk = false;
    for (let i = r.peakIdx + 1; i < N; i++) if (!(r.rows[i].amount < r.rows[i - 1].amount)) humpOk = false;
    check(`${label}: buy amounts form a hump peaking at peakIdx`, humpOk, true);

    // Independent reconstruction of avgEntry/liq from each row's own raw
    // price/newQty/amount, accumulated separately from whatever internal
    // variables computePlan used — a genuine cross-check, not just re-running
    // the same formula.
    let cumQtyCheck = 0;
    let cumMarginCheck = 0;
    let cumNotional = 0;
    let avgEntryOk = true;
    let liqOk = true;
    for (let i = 0; i < N; i++) {
      cumQtyCheck += r.rows[i].newQty;
      cumMarginCheck += r.rows[i].amount;
      cumNotional += r.rows[i].price * r.rows[i].newQty;
      const avgEntryCheck = cumNotional / cumQtyCheck;
      const liqCheck = avgEntryCheck * (1 + input.mmr) - cumMarginCheck / cumQtyCheck;
      if (!closeEnough(r.rows[i].avgEntry, avgEntryCheck)) avgEntryOk = false;
      if (!closeEnough(r.rows[i].liq, liqCheck)) liqOk = false;
      // qty independently re-derived from amount/leverage/price too.
      if (!closeEnough(r.rows[i].newQty, (r.rows[i].amount * input.leverage) / r.rows[i].price)) liqOk = false;
    }
    check(`${label}: avgEntry matches an independent reconstruction`, avgEntryOk, true);
    check(`${label}: liq (and qty) match an independent reconstruction`, liqOk, true);
  }
}

console.log('\nFixture D — error paths');
{
  try {
    computePlan({ entry: 0, leverage: 5, mmr: 0.01, capital: 1000, numBuys: 5, targetDrawdownPct: 50 });
    console.log('  FAIL: expected an error for entry <= 0');
    failures++;
  } catch (e) {
    check('entry<=0 message', e.message, 'Entry price, leverage and capital must be positive.');
  }
  try {
    computePlan({ entry: 100, leverage: 0, mmr: 0.01, capital: 1000, numBuys: 5, targetDrawdownPct: 50 });
    console.log('  FAIL: expected an error for leverage <= 0');
    failures++;
  } catch (e) {
    check('leverage<=0 message', e.message, 'Entry price, leverage and capital must be positive.');
  }
  try {
    computePlan({ entry: 100, leverage: 5, mmr: 0.01, capital: 1000, numBuys: 0, targetDrawdownPct: 50 });
    console.log('  FAIL: expected an error for numBuys < 1');
    failures++;
  } catch (e) {
    check('numBuys<1 message', e.message, 'Number of buys must be at least 1.');
  }
  try {
    computePlan({ entry: 100, leverage: 5, mmr: 0.01, capital: 1000, numBuys: 5, targetDrawdownPct: 150 });
    console.log('  FAIL: expected an error for targetDrawdownPct >= 100');
    failures++;
  } catch (e) {
    check('depth>=100% message', e.message, 'Target drawdown coverage must be between 0% and 100% (exclusive).');
  }
  try {
    computePlan({ entry: 100, leverage: 5, mmr: 0.01, capital: 1000, numBuys: 5, targetDrawdownPct: 50, sweetSpotDrawdownPct: 0 });
    console.log('  FAIL: expected an error for sweetSpotDrawdownPct <= 0');
    failures++;
  } catch (e) {
    check('peak<=0% message', e.message, 'Peak buy drawdown must be between 0% and 100% (exclusive).');
  }
}

console.log('\nFixture E — ladderSurvival / scanPeakFeasibility (the Leveraged-tab feasibility indicator)');
{
  // A single-buy ladder has no "next row" to fail at, so it trivially
  // survives — the first real usefulness check is that this doesn't throw
  // or misreport on the degenerate N=1 case.
  const single = ladderSurvival(computePlan({ entry: 100, leverage: 5, mmr: 0.01, capital: 1000, numBuys: 1, targetDrawdownPct: 50 }));
  check('single-buy survivesFully', single.survivesFully, true);
  check('single-buy failedAtStep', single.failedAtStep, null);
  check('single-buy survivedDrawdownPct', single.survivedDrawdownPct, 0);

  // 5x leverage, 12 buys, 70% target, 1% MMR: hand-verified earlier (see
  // the conversation this fixture came from) that NO peak placement can
  // reach the full target here — the relative price drop between rows 6 and
  // 7 already exceeds what a fixed ~19% (1/leverage - mmr) liquidation
  // cushion can cover, for ANY weight shape, so the shortfall is structural.
  // Confirms scanPeakFeasibility reports zero feasible peaks and the same
  // maximum achievable depth (29.166...%) at both a shallow peak (1%) and
  // the first peak that reaches that same ceiling (15%) — i.e. deepening
  // the peak helps up to a point, then plateaus at a hard limit, exactly as
  // derived: liq_i == avgEntry_i * (1 + mmr - 1/leverage) is a ratio
  // identity, so no weighting can push avgEntry down fast enough past the
  // row where the ladder's own (weight-independent) price spacing outruns
  // that fixed cushion.
  const scanTight = scanPeakFeasibility({ leverage: 5, mmr: 0.01, numBuys: 12, targetDrawdownPct: 70 });
  const spacingTight = 70 / 12; // % drawdown between consecutive rungs
  check('5x/12buys/70%: no peak fully survives', scanTight.some((r) => r.survivesFully), false);
  check('5x/12buys/70%: max achievable depth (row index 5)', Math.max(...scanTight.map((r) => r.survivedDrawdownPct)), spacingTight * 5);
  check('5x/12buys/70%: peak=1% depth (row index 4 — a shallow peak dies sooner)', scanTight.find((r) => r.peak === 1).survivedDrawdownPct, spacingTight * 4);
  check('5x/12buys/70%: peak=15% depth (plateaus at the ceiling)', scanTight.find((r) => r.peak === 15).survivedDrawdownPct, spacingTight * 5);

  // 3x leverage, 10 buys, 50% target, 1% MMR: unlike the case above, this
  // ladder IS fully reachable, but only with the weight pulled deep enough —
  // a shallow peak (5%) dies partway, a deep-enough peak (13%+) reaches the
  // full target. This is the "move the peak deeper" (amber) case the UI
  // needs to distinguish from the "structurally impossible" (red) case above.
  const scanReachable = scanPeakFeasibility({ leverage: 3, mmr: 0.01, numBuys: 10, targetDrawdownPct: 50 });
  check('3x/10buys/50%: peak=5% does not fully survive', scanReachable.find((r) => r.peak === 5).survivesFully, false);
  check('3x/10buys/50%: peak=5% depth', scanReachable.find((r) => r.peak === 5).survivedDrawdownPct, 40);
  check('3x/10buys/50%: peak=12% does not fully survive', scanReachable.find((r) => r.peak === 12).survivesFully, false);
  check('3x/10buys/50%: peak=13% fully survives', scanReachable.find((r) => r.peak === 13).survivesFully, true);

  // 2x leverage is forgiving enough (huge ~49% cushion) that a default-shape
  // ladder survives the full target drawdown without needing any special
  // peak placement.
  const low = ladderSurvival(computePlan({ entry: 100, leverage: 2, mmr: 0.01, capital: 1000, numBuys: 12, targetDrawdownPct: 70, sweetSpotDrawdownPct: 35 }));
  check('2x leverage, default peak: survivesFully', low.survivesFully, true);
}

console.log('\nFixture F — scanPeakFeasibilityRelative (the slider\'s "% of target drawdown" re-parameterization)');
{
  // The exact case from the conversation this fixture came from: a 70%
  // target with peakPct=50 must convert to exactly 35% absolute (half of
  // 70), and peakPct=100 must convert to exactly the full target itself.
  const scanTight = scanPeakFeasibilityRelative({ leverage: 5, mmr: 0.01, numBuys: 12, targetDrawdownPct: 70 });
  check('peakPct=50 -> absolutePeakPct == 35 (half of a 70% target)', scanTight.find((r) => r.peakPct === 50).absolutePeakPct, 35);
  check('peakPct=100 -> absolutePeakPct == 70 (the full target itself)', scanTight.find((r) => r.peakPct === 100).absolutePeakPct, 70);
  // Same structural ceiling as Fixture E's absolute-scan case (5x/12buys/70%
  // never fully survives, regardless of peak) — the relative scan must
  // report the identical verdict, since it's the same underlying model.
  check('no relative peak fully survives (matches Fixture E\'s absolute-scan finding)', scanTight.some((r) => r.survivesFully), false);
  check('max achievable depth matches Fixture E\'s absolute-scan finding', Math.max(...scanTight.map((r) => r.survivedDrawdownPct)), 70 / 12 * 5);

  // Direct cross-check against scanPeakFeasibility (absolute) at the
  // equivalent value: relative peakPct=50 on a 70% target (absolute 35)
  // must produce the exact same verdict as scanPeakFeasibility's own
  // peak=35 entry — this is a re-parameterization, not a different model.
  const relAt50 = scanTight.find((r) => r.peakPct === 50);
  const absAt35 = scanPeakFeasibility({ leverage: 5, mmr: 0.01, numBuys: 12, targetDrawdownPct: 70 }).find((r) => r.peak === 35);
  check('relative peakPct=50 matches absolute peak=35: survivesFully', relAt50.survivesFully, absAt35.survivesFully);
  check('relative peakPct=50 matches absolute peak=35: survivedDrawdownPct', relAt50.survivedDrawdownPct, absAt35.survivedDrawdownPct);

  // The user's own worked example: a 40% target with the weight at 50% of
  // that depth must land at exactly 20% absolute drawdown, not 50%.
  const scan40 = scanPeakFeasibilityRelative({ leverage: 3, mmr: 0.01, numBuys: 10, targetDrawdownPct: 40 });
  check('40% target, peakPct=50 -> absolutePeakPct == 20 (not 50 — the whole point of this re-parameterization)', scan40.find((r) => r.peakPct === 50).absolutePeakPct, 20);
}

if (failures > 0) {
  console.log(`\n${failures} mismatch(es). Deploy blocked.`);
  process.exit(1);
} else {
  console.log('\nAll backfill fixtures match. Safe to deploy.');
}
