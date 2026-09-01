// Regression test for api/spot/[action].js's classify() — the function that
// buckets a raw Bybit order (from GET /v5/order/realtime) into filled /
// resting / canceled for the Position Status card.
//
// This is a straightforward mapping over Bybit's own `orderStatus` enum —
// unlike the old MEXC integration, Bybit reports a clean status on every
// order (including a market buy placed via marketUnit:"quoteCoin" for
// Order #1 of a plan), so there's no origQty-blank-on-market-order quirk to
// guard against here. This test just pins the enum mapping so a future edit
// can't silently misclassify a status Bybit actually returns.
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

console.log('Fixture A — market buy placed via marketUnit:"quoteCoin", fully filled');
{
  // This is exactly what Order #1 of a plan looks like once it fills — no
  // origQty/executedQty ambiguity the way MEXC had, since Bybit reports
  // orderStatus directly regardless of how qty was specified at submission.
  const marketFilled = {
    symbol: 'CRVUSDT',
    orderId: '1',
    price: '0',
    qty: '145.500000',
    cumExecQty: '549.230000',
    avgPrice: '0.264800',
    orderStatus: 'Filled',
    orderType: 'Market',
    side: 'Buy',
    createdTime: '1000',
  };
  check('classify == 3 (filled)', classify(marketFilled), 3);
}

console.log('\nFixture B — resting limit buy (unfilled, normal ladder rung waiting to trigger)');
{
  const limitResting = {
    price: '0.205000',
    qty: '721.323000',
    cumExecQty: '0',
    orderStatus: 'New',
    orderType: 'Limit',
    side: 'Buy',
  };
  check('classify == 2 (resting)', classify(limitResting), 2);
}

console.log('\nFixture C — partially filled limit buy still counts as resting');
{
  const limitPartial = {
    price: '0.205000',
    qty: '721.323000',
    cumExecQty: '200.000000',
    orderStatus: 'PartiallyFilled',
    orderType: 'Limit',
    side: 'Buy',
  };
  check('classify == 2 (resting)', classify(limitPartial), 2);
}

console.log('\nFixture D — filled limit buy');
{
  const limitFilled = {
    price: '0.205000',
    qty: '721.323000',
    cumExecQty: '721.323000',
    avgPrice: '0.205000',
    orderStatus: 'Filled',
    orderType: 'Limit',
    side: 'Buy',
  };
  check('classify == 3 (filled)', classify(limitFilled), 3);
}

console.log('\nFixture E — canceled order (any type)');
{
  const canceled = {
    price: '0.187000',
    qty: '550.000000',
    cumExecQty: '0',
    orderStatus: 'Cancelled',
    orderType: 'Limit',
    side: 'Buy',
  };
  check('classify == 4 (canceled)', classify(canceled), 4);
}

console.log('\nFixture F — rejected order');
{
  const rejected = {
    price: '0.187000',
    qty: '550.000000',
    cumExecQty: '0',
    orderStatus: 'Rejected',
    orderType: 'Limit',
    side: 'Buy',
  };
  check('classify == 4 (canceled/rejected)', classify(rejected), 4);
}

if (failures > 0) {
  console.log(`\n${failures} mismatch(es) against the spot status classify fixtures. Deploy blocked.`);
  process.exit(1);
} else {
  console.log('\nAll spot status classify fixtures match. Safe to deploy.');
}
