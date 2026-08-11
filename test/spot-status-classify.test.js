// Regression test for api/spot/[action].js's classify() — the function that
// buckets a raw MEXC order (from GET /api/v3/allOrders) into filled /
// resting / canceled for the Position Status card.
//
// The bug this guards against: Order #1 of every plan is a MARKET buy placed
// via `quoteOrderQty` (spend exactly $X), not `quantity` (buy exactly Y
// units) — see api/spot/[action].js's execute handler. MEXC's allOrders
// response for an order placed that way comes back with origQty at
// "0.000000" even once fully filled; the fill amount lives in executedQty /
// cummulativeQuoteQty instead. The old classify() required origQty > 0 to
// ever call something "filled", so a fully-filled market buy was
// permanently misclassified as "resting" — and since that market buy is
// usually the only order that's actually filled early in a ladder's life,
// the Position Status card would report "no position" despite a real,
// filled position sitting in the account (reported live: "in position but
// no status shown"). Fixtures below are shaped like MEXC's real allOrders
// response fields (all values as strings, matching the API).
//
// Run manually:   npm test        (or: node test/spot-status-classify.test.js)
// Run on deploy:  wired into vercel.json's buildCommand — see README.

const { classify } = require('../api/spot/[action].js');

let failures = 0;

function check(label, actual, expected) {
  if (actual === expected) {
    console.log(`  PASS ${label}: ${actual}`);
  } else {
    console.log(`  FAIL ${label}: expected ${expected}, got ${actual}`);
    failures++;
  }
}

console.log('Fixture A — market buy placed via quoteOrderQty, fully filled (the bug case)');
{
  // origQty "0.000000" — MEXC never had a base-asset quantity to report,
  // since the order specified a dollar amount instead. This is exactly what
  // Order #1 of a plan looks like in allOrders once it fills.
  const marketFilled = {
    symbol: 'CRVUSDT',
    orderId: '1',
    price: '0.000000',
    origQty: '0.000000',
    executedQty: '549.230000',
    cummulativeQuoteQty: '145.500000',
    status: 'FILLED',
    type: 'MARKET',
    side: 'BUY',
    time: 1000,
  };
  check('classify == 3 (filled)', classify(marketFilled), 3);
}

console.log('\nFixture B — market buy still recognized as filled even without a status field');
{
  // Belt-and-suspenders case: if MEXC ever omits/renames status, the
  // executedQty > 0 && !(origQty > 0) fallback must still catch this.
  const marketFilledNoStatus = {
    origQty: '0.000000',
    executedQty: '549.230000',
    cummulativeQuoteQty: '145.500000',
    type: 'MARKET',
    side: 'BUY',
  };
  check('classify == 3 (filled, fallback path)', classify(marketFilledNoStatus), 3);
}

console.log('\nFixture C — resting limit buy (unfilled, normal ladder rung waiting to trigger)');
{
  const limitResting = {
    origQty: '721.323000',
    executedQty: '0.000000',
    cummulativeQuoteQty: '0.000000',
    status: 'NEW',
    type: 'LIMIT',
    side: 'BUY',
  };
  check('classify == 2 (resting)', classify(limitResting), 2);
}

console.log('\nFixture D — filled limit buy (quantity-based path, unchanged from before this fix)');
{
  const limitFilled = {
    origQty: '721.323000',
    executedQty: '721.323000',
    cummulativeQuoteQty: '183.310000',
    status: 'FILLED',
    type: 'LIMIT',
    side: 'BUY',
  };
  check('classify == 3 (filled)', classify(limitFilled), 3);
}

console.log('\nFixture E — canceled order (any type)');
{
  const canceled = {
    origQty: '550.000000',
    executedQty: '0.000000',
    cummulativeQuoteQty: '0.000000',
    status: 'CANCELED',
    type: 'LIMIT',
    side: 'BUY',
  };
  check('classify == 4 (canceled)', classify(canceled), 4);
}

if (failures > 0) {
  console.log(`\n${failures} mismatch(es) against the spot status classify fixtures. Deploy blocked.`);
  process.exit(1);
} else {
  console.log('\nAll spot status classify fixtures match. Safe to deploy.');
}
