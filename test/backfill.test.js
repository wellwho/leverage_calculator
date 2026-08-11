// Validation for calc.js's computePlan (the leveraged ladder-sizing engine).
//
// The previous version of this test pinned computePlan's output against a
// hand-built reference spreadsheet. That spreadsheet was built for the old
// ladder shape — buy sizes growing monotonically (×1.26/step) all the way
// out, with a lump "Add Margin" step injected right after buy #1. Neither of
// those is true anymore: buy sizes now peak at the buy nearest a -35%
// drawdown "sweet spot" and taper off on both sides, and there's no injected
// margin step at all — the leftover capital just sits as an untouched
// reserve for MEXC's own Auto-Margin feature to draw on. There's no external
// backfill source for this shape, so this suite instead checks:
//
//   1. An exactly hand-derived single-buy fixture (small enough to verify
//      with a calculator, not spreadsheet software).
//   2. Structural invariants that must hold for *any* valid input, re-derived
//      independently of computePlan's own internals (capital conservation,
//      the sweet-spot peak landing where the ladder's own spacing says it
//      should, the hump actually being a hump, and the auto-margin-needed
//      flag matching its own definition) across a spread of parameter combos.
//   3. The pre-existing input-validation error paths.
//
// Run manually:   npm test        (or: node test/backfill.test.js)
// Run on deploy:  wired into vercel.json's buildCommand — see README.

const { computePlan } = require('../calc.js');

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

console.log('\nFixture A — single-buy plan, hand-derived exactly (entry 100, 5x, 1% MMR, $1000 capital, 50% target)');
{
  // Hand check: N=1 so weights=[1], K1=1, K2=1/100=0.01.
  // targetLiq = 100*(1-0.5) = 50.
  // denom = 5*(1*1.01 - 0.01*50) = 5*(1.01-0.5) = 5*0.51 = 2.55
  // E1 = 1000/2.55 = 392.156862745098... (== totalBuys, the only buy)
  // margin = 1000 - 392.156862745098... = 607.843137254902...
  // qty = 392.156862745098*5/100 = 19.6078431372549...
  // liq = 100*1.01 - 392.156862745098/19.6078431372549 = 101 - 20 = 81
  const r = computePlan({ entry: 100, leverage: 5, mmr: 0.01, capital: 1000, numBuys: 1, targetDrawdownPct: 50 });
  check('rows.length', r.rows.length, 1);
  check('rows[0].amount (== totalBuys, E1)', r.rows[0].amount, 392.15686274509807);
  check('rows[0].newQty', r.rows[0].newQty, 19.607843137254903);
  check('rows[0].liq (naive)', r.rows[0].liq, 81);
  check('margin', r.margin, 607.8431372549019);
  check('totalBuys', r.totalBuys, 392.15686274509807);
  check('totalDeployed == capital', r.totalDeployed, 1000);
  check('naiveFinalLiq', r.naiveFinalLiq, 81);
  check('protectedFinalLiq (== target liq exactly)', r.protectedFinalLiq, 50);
  check('drawdownCovered', r.drawdownCovered, 0.5);
  check('peakIdx', r.peakIdx, 0);
  check('rows[0].autoMarginNeeded (margin>0 and naive liq worse than target)', r.rows[0].autoMarginNeeded, true);
}

console.log('\nFixture B — structural invariants across a spread of inputs');
{
  const combos = [
    { label: 'old reference inputs (12 buys, deep 95% target — sweet spot well inside range)', input: { entry: 0.223, leverage: 5, mmr: 0.01, capital: 951, numBuys: 12, targetDrawdownPct: 95 } },
    { label: 'shallow target (sweet spot beyond range — should degenerate to pure growth)', input: { entry: 100, leverage: 10, mmr: 0.005, capital: 500, numBuys: 6, targetDrawdownPct: 20 } },
    { label: 'sweet spot exactly on a rung', input: { entry: 100, leverage: 10, mmr: 0.01, capital: 2000, numBuys: 20, targetDrawdownPct: 70 } },
    { label: 'small N, deep target', input: { entry: 50, leverage: 8, mmr: 0.02, capital: 300, numBuys: 4, targetDrawdownPct: 90 } },
  ];

  for (const { label, input } of combos) {
    const r = computePlan(input);
    const N = r.rows.length;
    const T = input.targetDrawdownPct / 100;
    const spacing = T / N;

    check(`${label}: rows.length == numBuys`, N, input.numBuys);
    check(`${label}: totalBuys + margin == capital`, r.totalBuys + r.margin, input.capital);
    check(`${label}: margin >= 0`, r.margin >= -1e-9, true);
    check(`${label}: protectedFinalLiq == entry*(1-T)`, r.protectedFinalLiq, input.entry * (1 - T));
    check(`${label}: drawdownCovered == T`, r.drawdownCovered, T);
    check(`${label}: naiveFinalLiq worse than (>=) protectedFinalLiq`, r.naiveFinalLiq >= r.protectedFinalLiq - 1e-9, true);

    // Peak = the rung whose drawdown lands closest to -35%, clamped to the
    // ladder's own range — computed here independently of calc.js's formula.
    const expectedPeak = Math.min(N - 1, Math.max(0, Math.round(0.35 / spacing)));
    check(`${label}: peakIdx`, r.peakIdx, expectedPeak);

    // Hump shape: strictly increasing $ amounts up to the peak, strictly
    // decreasing after it.
    let humpOk = true;
    for (let i = 1; i <= r.peakIdx; i++) if (!(r.rows[i].amount > r.rows[i - 1].amount)) humpOk = false;
    for (let i = r.peakIdx + 1; i < N; i++) if (!(r.rows[i].amount < r.rows[i - 1].amount)) humpOk = false;
    check(`${label}: buy amounts form a hump peaking at peakIdx`, humpOk, true);

    // autoMarginNeeded matches its own definition: does this rung's own
    // naive liq price sit worse than the next buy's trigger price?
    let flagsOk = true;
    for (let i = 0; i < N - 1; i++) {
      if (r.rows[i].autoMarginNeeded !== r.rows[i].liq > r.rows[i + 1].price) flagsOk = false;
    }
    const expectedLastFlag = r.margin > 1e-9 && r.rows[N - 1].liq > r.protectedFinalLiq;
    if (r.rows[N - 1].autoMarginNeeded !== expectedLastFlag) flagsOk = false;
    check(`${label}: autoMarginNeeded flags match their definition`, flagsOk, true);
  }
}

console.log('\nFixture C — error paths');
{
  try {
    computePlan({ entry: 0, leverage: 5, mmr: 0.01, capital: 1000, numBuys: 5, targetDrawdownPct: 50 });
    console.log('  FAIL: expected an error for entry <= 0');
    failures++;
  } catch (e) {
    check('entry<=0 message', e.message, 'Entry price, leverage and capital must be positive.');
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
    check('target>=100% message', e.message, 'Target drawdown coverage must be between 0% and 100% (exclusive).');
  }
  try {
    computePlan({ entry: 100, leverage: 1, mmr: 0.01, capital: 1000, numBuys: 5, targetDrawdownPct: 10 });
    console.log('  FAIL: expected an error for an infeasible (negative-margin) combination');
    failures++;
  } catch (e) {
    check('negative-margin message', e.message, 'Computed margin is negative — this target/leverage/N combination is infeasible on this budget.');
  }
}

if (failures > 0) {
  console.log(`\n${failures} mismatch(es). Deploy blocked.`);
  process.exit(1);
} else {
  console.log('\nAll backfill fixtures match. Safe to deploy.');
}
