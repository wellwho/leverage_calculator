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

const { computePnl, computeProjectedLiquidation, scopeOrdersSinceOpeningMarketBuy } = require('../statusCalc.js');

function closeEnough(actual, expected) {
  if (actual === null && expected === null) return true;
  if (typeof actual === 'number' && typeof expected === 'number') {
    return Math.abs(actual - expected) <= 1e-6 * Math.max(1, Math.abs(expected));
  }
  // Non-numeric fixtures (booleans, strings) added alongside Fixtures E-G
  // for scopeOrdersSinceOpeningMarketBuy -- exact equality is the right
  // comparison for those, the numeric tolerance above is only for money/
  // price math.
  return actual === expected;
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

console.log('\nFixture E — scopeOrdersSinceOpeningMarketBuy: picks the LATEST market buy as the run start, scopes to it, and detects the app tag (added after the Bybit openOnly-cache bug — see api/status.js / api/spot/[action].js header comments)');
{
  const isAppTag = (tag) => typeof tag === 'string' && tag.startsWith('ladderapp-');
  const getTag = (o) => o.tag;

  // An older, already-closed run (market buy + one fill) followed by the
  // current run (market buy + two resting limits) on the same symbol.
  const orders = [
    { price: 0.20, vol: 100, side: 1, orderType: 5, state: 3, createTime: 1000, tag: 'ladderapp-1000-0' }, // old run's market buy
    { price: 0.19, vol: 100, side: 1, orderType: 1, state: 3, createTime: 1500, tag: 'ladderapp-1000-1' }, // old run's limit fill
    { price: 0.15, vol: 200, side: 1, orderType: 5, state: 3, createTime: 5000, tag: 'ladderapp-5000-0' }, // CURRENT run's market buy (latest)
    { price: 0.14, vol: 150, side: 1, orderType: 1, state: 2, createTime: 5100, tag: 'ladderapp-5000-1' }, // current run's resting limit
    { price: 0.13, vol: 150, side: 1, orderType: 1, state: 2, createTime: 5200, tag: 'ladderapp-5000-2' }, // current run's resting limit
  ];

  const result = scopeOrdersSinceOpeningMarketBuy(orders, getTag, isAppTag);
  check('sinceTime picks latest market buy', result.sinceTime, 5000);
  check('scoped excludes the old run', result.scoped.length, 3);
  check('scoped sorted price descending (first row)', result.scoped[0].price, 0.15);
  check('scoped sorted price descending (last row)', result.scoped[result.scoped.length - 1].price, 0.13);
  check('openedByApp true when the opening order carries the app tag', result.openedByApp, true);
  check('openingOrder is the current run\'s market buy', result.openingOrder.createTime, 5000);
}

console.log('\nFixture F — scopeOrdersSinceOpeningMarketBuy: no market buy at all (e.g. a manually-opened position) falls back to returning every order, unscoped, openedByApp false');
{
  const isAppTag = () => true; // shouldn't even get called — no market buy to check
  const getTag = (o) => o.tag;
  const orders = [
    { price: 0.30, vol: 10, side: 1, orderType: 1, state: 2, createTime: 100, tag: null },
    { price: 0.28, vol: 10, side: 1, orderType: 1, state: 2, createTime: 200, tag: null },
  ];
  const result = scopeOrdersSinceOpeningMarketBuy(orders, getTag, isAppTag);
  check('sinceTime is null with no market buy', result.sinceTime, null);
  check('scoped keeps every order', result.scoped.length, 2);
  check('openedByApp false with no market buy', result.openedByApp, false);
  check('openingOrder is null', result.openingOrder, null);
}

console.log('\nFixture G — scopeOrdersSinceOpeningMarketBuy: opening market buy NOT tagged by this app (e.g. opened manually on the exchange) reports openedByApp false even though a market buy was found');
{
  const isAppTag = (tag) => typeof tag === 'string' && tag.startsWith('ladderapp-');
  const getTag = (o) => o.tag;
  const orders = [
    { price: 0.10, vol: 500, side: 1, orderType: 5, state: 3, createTime: 9000, tag: undefined }, // manually opened -- no orderLinkId/externalOid tag
    { price: 0.09, vol: 500, side: 1, orderType: 1, state: 2, createTime: 9100, tag: undefined },
  ];
  const result = scopeOrdersSinceOpeningMarketBuy(orders, getTag, isAppTag);
  check('sinceTime still found', result.sinceTime, 9000);
  check('openedByApp false without the tag', result.openedByApp, false);
}

if (failures > 0) {
  console.log(`\n${failures} mismatch(es) against the statusCalc backfill fixtures. Deploy blocked.`);
  process.exit(1);
} else {
  console.log('\nAll statusCalc backfill fixtures match. Safe to deploy.');
}
