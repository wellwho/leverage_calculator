// Backfill validation for calc.js's computeSpotPlan (the Spot DCA ladder —
// no leverage, no margin buffer, no liquidation).
//
// Fixture A reuses the exact same inputs as test/backfill.test.js's proven
// reference plan (entry 0.223, capital 951, 12 buys, 95% drawdown target),
// minus leverage/mmr, so the two tests double as a cross-check that both
// ladders trigger at identical prices — verified independently before these
// numbers were pinned here (see calc.js's buildLadderShape comment). Values
// below were hand-recomputed via an independent cumulative-notional/qty walk
// over the same rows, not just re-read from computeSpotPlan's own output.
//
// Run manually:   npm test        (or: node test/spot-backfill.test.js)
// Run on deploy:  wired into vercel.json's buildCommand — see README.

const { computeSpotPlan } = require('../calc.js');

function closeEnough(actual, expected) {
  if (typeof actual === 'number' && typeof expected === 'number') {
    return Math.abs(actual - expected) <= 1e-6 * Math.max(1, Math.abs(expected));
  }
  return actual === expected; // strings (e.g. error messages), etc. — exact match
}

let failures = 0;

function check(label, actual, expected) {
  if (closeEnough(actual, expected)) {
    console.log(`  PASS ${label}: ${actual}`);
  } else {
    console.log(`  FAIL ${label}: expected ${expected}, got ${actual}`);
    failures++;
  }
}

console.log('\nFixture A — 12-buy spot ladder, $951 capital, $0.223 entry, 95% drawdown (same inputs as the leveraged reference plan, minus leverage/mmr)');
{
  const r = computeSpotPlan({ entry: 0.223, capital: 951, numBuys: 12, targetDrawdownPct: 95 });
  check('rows.length', r.rows.length, 12);
  check('totalBuys', r.totalBuys, 951);
  check('totalDeployed', r.totalDeployed, 951);
  check('finalQty', r.finalQty, 16745.319147286042);
  check('finalAvgEntry', r.finalAvgEntry, 0.0567922680412371);
  check('lowestPrice', r.lowestPrice, 0.028804166666666666);
  check('ladderDepth', r.ladderDepth, 0.8708333333333333);
  // First and last row trigger prices, cross-checked against the leveraged
  // plan's own "Limit Buy" rows for the identical inputs — same
  // buildLadderShape call, so these must land on the same points.
  check('rows[0].price (== entry)', r.rows[0].price, 0.223);
  check('rows[11].price (== lowestPrice)', r.rows[11].price, 0.028804166666666666);
}

console.log('\nFixture B — small ladder (3 buys), sanity-checks the geometric weighting directly by hand');
{
  const r = computeSpotPlan({ entry: 100, capital: 1000, numBuys: 3, targetDrawdownPct: 30 });
  // Hand check: spacing = 30/3 = 10%, drawdowns = [0, 10%, 20%], prices = [100, 90, 80].
  // K1 = 1 + 1.26 + 1.26^2 = 1 + 1.26 + 1.5876 = 3.8476
  // E1 = 1000 / 3.8476 = 259.9021...
  check('rows[0].price', r.rows[0].price, 100);
  check('rows[1].price', r.rows[1].price, 90);
  check('rows[2].price', r.rows[2].price, 80);
  const K1 = 1 + 1.26 + 1.26 * 1.26;
  const E1 = 1000 / K1;
  const buy1 = E1, buy2 = E1 * 1.26, buy3 = E1 * 1.26 * 1.26;
  check('rows[0].amount', r.rows[0].amount, buy1);
  check('rows[1].amount', r.rows[1].amount, buy2);
  check('rows[2].amount', r.rows[2].amount, buy3);
  check('totalBuys', r.totalBuys, buy1 + buy2 + buy3);
  check('totalBuys == capital', r.totalBuys, 1000);
  const qty1 = buy1 / 100, qty2 = buy2 / 90, qty3 = buy3 / 80;
  const totalQty = qty1 + qty2 + qty3;
  const avgEntry = (buy1 + buy2 + buy3) / totalQty;
  check('finalQty', r.finalQty, totalQty);
  check('finalAvgEntry', r.finalAvgEntry, avgEntry);
}

console.log('\nFixture C — error paths');
{
  try {
    computeSpotPlan({ entry: 0, capital: 951, numBuys: 12, targetDrawdownPct: 95 });
    console.log('  FAIL: expected an error for entry <= 0');
    failures++;
  } catch (e) {
    check('entry<=0 message', e.message, 'Entry price and capital must be positive.');
  }
  try {
    computeSpotPlan({ entry: 0.223, capital: -1, numBuys: 12, targetDrawdownPct: 95 });
    console.log('  FAIL: expected an error for capital <= 0');
    failures++;
  } catch (e) {
    check('capital<=0 message', e.message, 'Entry price and capital must be positive.');
  }
}

if (failures > 0) {
  console.log(`\n${failures} mismatch(es) against the spot backfill fixtures. Deploy blocked.`);
  process.exit(1);
} else {
  console.log('\nAll spot backfill fixtures match. Safe to deploy.');
}
