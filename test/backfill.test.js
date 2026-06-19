// Backfill validation for calc.js
//
// "Backfill" fixtures below are taken verbatim from the proven reference
// spreadsheet ("CRV Leverage Calculator (manual price).xlsx", ENGINE +
// per-row table), which was built independently of calc.js and uses the
// same K1/K2/E1 formulas. If calc.js ever drifts from this known-good
// output, this test fails.
//
// Run manually:   npm test        (or: node test/backfill.test.js)
// Run on deploy:  wired into vercel.json's buildCommand — see README.

const assert = require('assert');
const { computePlan } = require('../calc.js');

// Pass/absolute-floor tolerance: catches real regressions, ignores
// last-bit float noise. 1e-6 relative, with a 1e-6 floor for near-zero values.
function closeEnough(actual, expected) {
  if (actual === null && expected === null) return true;
  if (typeof actual !== 'number' || typeof expected !== 'number') return false;
  return Math.abs(actual - expected) <= 1e-6 * Math.max(1, Math.abs(expected));
}

const fixtures = [
  {
    label: '12-buy plan — $951 capital, $0.223 entry, 5x, 1% MMR, 95% drawdown',
    input: { entry: 0.223, leverage: 5, mmr: 0.01, capital: 951, numBuys: 12, targetDrawdownPct: 95 },
    expectedRows: [
      { step: 1, action: 'Limit Buy #1', price: 0.223, drawdown: 0, amount: 4.04851959336957, newQty: 90.773981914116, cumQty: 90.773981914116, avgEntry: 0.223, liq: null },
      { step: 2, action: 'Add Margin', price: 0.223, drawdown: 0, amount: 717.244156051012, newQty: 0, cumQty: 90.773981914116, avgEntry: 0.223, liq: -7.72079881172293 },
      { step: 3, action: 'Limit Buy #2', price: 0.205345833333333, drawdown: 0.0791666666666667, amount: 5.10113468764566, newQty: 124.208380682483, cumQty: 214.982362596599, avgEntry: 0.212800114635078, liq: -3.16392492852649 },
      { step: 4, action: 'Limit Buy #3', price: 0.187691666666667, drawdown: 0.158333333333333, amount: 6.42742970643354, newQty: 171.223097449723, cumQty: 386.205460046322, avgEntry: 0.201668355304718, liq: -1.69380558685883 },
      { step: 5, action: 'Limit Buy #4', price: 0.1700375, drawdown: 0.2375, amount: 8.09856143010626, newQty: 238.140452256304, cumQty: 624.345912302626, avgEntry: 0.189603591142591, liq: -0.995213998948608 },
      { step: 6, action: 'Limit Buy #5', price: 0.152383333333333, drawdown: 0.316666666666667, amount: 10.2041874019339, newQty: 334.81966756865, cumQty: 959.165579871276, avgEntry: 0.176610970673258, liq: -0.604724403486126 },
      { step: 7, action: 'Limit Buy #6', price: 0.134729166666667, drawdown: 0.395833333333333, amount: 12.8572761264367, newQty: 477.152662802661, cumQty: 1436.31824267394, avgEntry: 0.162697609615112, liq: -0.367577914931396 },
      { step: 8, action: 'Limit Buy #7', price: 0.117075, drawdown: 0.475, amount: 16.2001679193102, newQty: 691.871361063858, cumQty: 2128.18960373779, avgEntry: 0.147865765237029, liq: -0.217249526985177 },
      { step: 9, action: 'Limit Buy #8', price: 0.0994208333333333, drawdown: 0.554166666666667, amount: 20.4122115783309, newQty: 1026.55604936914, cumQty: 3154.74565310693, avgEntry: 0.132101756541736, liq: -0.120351612967797 },
      { step: 10, action: 'Limit Buy #9', price: 0.0817666666666667, drawdown: 0.633333333333333, amount: 25.7193865886969, newQty: 1572.73052927213, cumQty: 4727.47618237907, avgEntry: 0.115356345356959, liq: -0.0582795558436199 },
      { step: 11, action: 'Limit Buy #10', price: 0.0641125, drawdown: 0.7125, amount: 32.4064271017581, newQty: 2527.30958095209, cumQty: 7254.78576333115, avgEntry: 0.0975048104446444, liq: -0.019886070673158 },
      { step: 12, action: 'Limit Buy #11', price: 0.0464583333333333, drawdown: 0.791666666666667, amount: 40.8320981482152, newQty: 4394.48589935949, cumQty: 11649.2716626906, avgEntry: 0.0782484113861456, liq: 0.00181134200515114 },
      { step: 13, action: 'Limit Buy #12', price: 0.0288041666666667, drawdown: 0.870833333333333, amount: 51.4484436667512, newQty: 8930.72940837573, cumQty: 20580.0010710664, avgEntry: 0.0567919902292007, liq: 0.01115 },
    ],
    expectedSummary: {
      totalBuys: 233.755843948988,
      margin: 717.244156051012,
      totalDeployed: 951,
      finalQty: 20580.0010710664,
      finalAvgEntry: 0.0567919902292007,
      finalLiq: 0.01115,
      drawdownCovered: 0.95,
    },
  },
];

let failures = 0;

for (const fixture of fixtures) {
  console.log(`\n${fixture.label}`);
  const result = computePlan(fixture.input);

  if (result.rows.length !== fixture.expectedRows.length) {
    console.log(`  FAIL: expected ${fixture.expectedRows.length} rows, got ${result.rows.length}`);
    failures++;
    continue;
  }

  fixture.expectedRows.forEach((expectedRow, i) => {
    const actualRow = result.rows[i];
    for (const key of ['step', 'action', 'price', 'drawdown', 'amount', 'newQty', 'cumQty', 'avgEntry', 'liq']) {
      const actual = actualRow[key];
      const expected = expectedRow[key];
      const ok = typeof expected === 'number' ? closeEnough(actual, expected) : actual === expected;
      if (!ok) {
        console.log(`  FAIL row ${i + 1} [${key}]: expected ${expected}, got ${actual}`);
        failures++;
      }
    }
  });

  for (const key of Object.keys(fixture.expectedSummary)) {
    const actual = result[key];
    const expected = fixture.expectedSummary[key];
    if (!closeEnough(actual, expected)) {
      console.log(`  FAIL summary [${key}]: expected ${expected}, got ${actual}`);
      failures++;
    }
  }

  if (failures === 0) console.log('  PASS — matches reference spreadsheet exactly.');
}

if (failures > 0) {
  console.log(`\n${failures} mismatch(es) against the backfilled reference plan. Deploy blocked.`);
  process.exit(1);
} else {
  console.log('\nAll backfill fixtures match. Safe to deploy.');
}
