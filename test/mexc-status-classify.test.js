// Regression test for api/spot/[action].js's classifyMexc() — the function
// that buckets a raw MEXC spot order (from GET /api/v3/allOrders) into
// filled / resting / canceled for the Position Status card. Mirrors
// spot-status-classify.test.js's Bybit fixtures, but pinned to MEXC's own
// field shapes and quirks — most importantly, a market buy placed via
// `quoteOrderQty` (Order #1 of every plan) comes back with `origQty` at
// "0.000000" even once fully filled, which is why `status` is checked
// before the origQty/executedQty comparison.
//
// Run manually:   npm test        (or: node test/mexc-status-classify.test.js)
// Run on deploy:  wired into vercel.json's buildCommand — see README.

const { classifyMexc } = require('../api/spot/[action].js');

let failures = 0;

function check(label, actual, expected) {
  if (actual === expected) {
    console.log(`  PASS ${label}: ${actual}`);
  } else {
    console.log(`  FAIL ${label}: expected ${expected}, got ${actual}`);
    failures++;
  }
}

console.log('Fixture A — market buy placed via quoteOrderQty, fully filled (origQty stays "0.000000")');
{
  const marketFilled = {
    symbol: 'CRVUSDT',
    orderId: '1',
    price: '0',
    origQty: '0.000000',
    executedQty: '549.230000',
    cummulativeQuoteQty: '145.500000',
    status: 'FILLED',
    type: 'MARKET',
    side: 'BUY',
    time: 1000,
  };
  check('classifyMexc == 3 (filled)', classifyMexc(marketFilled), 3);
}

console.log('\nFixture B — resting limit buy (unfilled, normal ladder rung waiting to trigger)');
{
  const limitResting = {
    price: '0.205000',
    origQty: '721.323000',
    executedQty: '0',
    cummulativeQuoteQty: '0',
    status: 'NEW',
    type: 'LIMIT',
    side: 'BUY',
  };
  check('classifyMexc == 2 (resting)', classifyMexc(limitResting), 2);
}

console.log('\nFixture C — partially filled limit buy still counts as resting');
{
  const limitPartial = {
    price: '0.205000',
    origQty: '721.323000',
    executedQty: '200.000000',
    status: 'PARTIALLY_FILLED',
    type: 'LIMIT',
    side: 'BUY',
  };
  check('classifyMexc == 2 (resting)', classifyMexc(limitPartial), 2);
}

console.log('\nFixture D — filled limit buy, status-based');
{
  const limitFilled = {
    price: '0.205000',
    origQty: '721.323000',
    executedQty: '721.323000',
    cummulativeQuoteQty: '148.07',
    status: 'FILLED',
    type: 'LIMIT',
    side: 'BUY',
  };
  check('classifyMexc == 3 (filled)', classifyMexc(limitFilled), 3);
}

console.log('\nFixture E — filled limit buy, quantity-fallback path (unrecognized status string)');
{
  const limitFilledFallback = {
    price: '0.205000',
    origQty: '721.323000',
    executedQty: '721.323000',
    status: 'SOME_FUTURE_STATUS_THIS_FUNCTION_DOES_NOT_KNOW',
    type: 'LIMIT',
    side: 'BUY',
  };
  check('classifyMexc == 3 (filled, via quantity fallback)', classifyMexc(limitFilledFallback), 3);
}

console.log('\nFixture F — canceled order');
{
  const canceled = { price: '0.187000', origQty: '550.000000', executedQty: '0', status: 'CANCELED', type: 'LIMIT', side: 'BUY' };
  check('classifyMexc == 4 (canceled)', classifyMexc(canceled), 4);
}

console.log('\nFixture G — rejected / expired / partially-canceled orders');
{
  const rejected = { price: '0.187000', origQty: '550.000000', executedQty: '0', status: 'REJECTED', type: 'LIMIT', side: 'BUY' };
  check('classifyMexc == 4 (rejected)', classifyMexc(rejected), 4);
  const expired = { price: '0.187000', origQty: '550.000000', executedQty: '0', status: 'EXPIRED', type: 'LIMIT', side: 'BUY' };
  check('classifyMexc == 4 (expired)', classifyMexc(expired), 4);
  const partiallyCanceled = { price: '0.187000', origQty: '550.000000', executedQty: '100.000000', status: 'PARTIALLY_CANCELED', type: 'LIMIT', side: 'BUY' };
  check('classifyMexc == 4 (partially canceled)', classifyMexc(partiallyCanceled), 4);
}

if (failures > 0) {
  console.log(`\n${failures} mismatch(es) against the MEXC status classify fixtures. Deploy blocked.`);
  process.exit(1);
} else {
  console.log('\nAll MEXC status classify fixtures match. Safe to deploy.');
}
