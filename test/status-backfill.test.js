// Backfill validation for statusCalc.js (Position Status card's P&L and
// projected-liquidation math).
//
// Unlike test/backfill.test.js, these fixtures aren't from an external
// reference spreadsheet — they're hand-computed and cross-checked against
// the mocked end-to-end api/status.js run performed during development
// (see commit history / conversation record). The point is the same as
// the calc.js backfill test: pin known-good output so a future change to
// statusCalc.js can't silently drift without this test catching it.
//
// Run manually:   npm test        (or: node test/status-backfill.test.js)
// Run on deploy:  wired into vercel.json's buildCommand — see README.

const { computePnl, computeProjectedLiquidation } = require('../statusCalc.js');

function closeEnough(actual, expected) {
  if (actual === null && expected === null) return true;
  if (typeof actual !== 'number' || typeof expected !== 'number') return false;
  return Math.abs(actual - expected) <= 1e-6 * Math.max(1, Math.abs(expected));
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

console.log('\nFixture A — long position, small loss, two resting orders (the scenario hand-verified during development)');
{
  const pnl = computePnl({ holdAvgPrice: 0.223, holdVol: 900, contractSize: 1, currentPrice: 0.2, im: 90, isLong: true });
  check('pnl.dollar', pnl.dollar, -20.699999999999992);
  check('pnl.percent', pnl.percent, -22.999999999999993);

  const liq = computeProjectedLiquidation({
    holdAvgPrice: 0.223,
    holdVol: 900,
    contractSize: 1,
    im: 90,
    leverage: 5,
    mmr: 0.01,
    restingOrders: [
      { price: 0.205, vol: 1000, state: 2 },
      { price: 0.187, vol: 1200, state: 2 },
    ],
  });
  check('projectedLiquidation', liq, 0.1485551612903226);
}

console.log('\nFixture B — zero resting orders: projection should collapse to the current-only isolated-margin liquidation formula');
{
  const liq = computeProjectedLiquidation({
    holdAvgPrice: 0.15,
    holdVol: 5000,
    contractSize: 1,
    im: 200,
    leverage: 5,
    mmr: 0.01,
    restingOrders: [],
  });
  check('projectedLiquidation', liq, 0.11149999999999999);
}

console.log('\nFixture C — long position, in profit');
{
  const pnl = computePnl({ holdAvgPrice: 0.15, holdVol: 5000, contractSize: 1, currentPrice: 0.18, im: 200, isLong: true });
  check('pnl.dollar', pnl.dollar, 150);
  check('pnl.percent', pnl.percent, 75);
}

console.log('\nFixture D — short position, in profit (price fell)');
{
  const pnl = computePnl({ holdAvgPrice: 100, holdVol: 10, contractSize: 0.01, currentPrice: 95, im: 50, isLong: false });
  check('pnl.dollar', pnl.dollar, 0.5);
  check('pnl.percent', pnl.percent, 1);
}

if (failures > 0) {
  console.log(`\n${failures} mismatch(es) against the statusCalc backfill fixtures. Deploy blocked.`);
  process.exit(1);
} else {
  console.log('\nAll statusCalc backfill fixtures match. Safe to deploy.');
}
