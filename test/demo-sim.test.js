// Hand-worked fixtures for demoSim.js, the demo-mode trading simulator.
// Every expected number below is derived by hand in the comment beside it.
const { DEMO_FEES, pickSimInterval, leveragedLiqPrice, demoAvailable, demoEquity, openPosition, advancePosition, closePosition } = require('../demoSim.js');

let failures = 0;
function check(name, actual, expected, tol = 1e-9) {
  const ok = typeof expected === 'number' ? Math.abs(actual - expected) <= tol : actual === expected;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${actual}${ok ? '' : ` (expected ${expected})`}`);
  if (!ok) failures++;
}

const T0 = 1_800_000_000_000; // execute time (ms)
const candle = (minutesAfter, low, close) => ({ time: (T0 + minutesAfter * 60e3) / 1000, low, close });

console.log('Fees used');
check('perp taker', DEMO_FEES.leveraged.taker, 0.00055);
check('perp maker', DEMO_FEES.leveraged.maker, 0.0002);

console.log('\nFixture A — interval choice (450-candle cap)');
check('3h → 1m', pickSimInterval(T0, T0 + 3 * 3600e3).interval, '1');
check('10h → 5m', pickSimInterval(T0, T0 + 10 * 3600e3).interval, '5');
check('30 days → 4h', pickSimInterval(T0, T0 + 30 * 86400e3).interval, '240');

// Leveraged ladder: $1,000, 5x, MMR 1%. Market 100 @ 1.00, limits 100 @ 0.90
// and 200 @ 0.80.
const levOrders = [
  { step: 1, price: 1.0, qty: 100, market: true },
  { step: 2, price: 0.9, qty: 100, market: false },
  { step: 3, price: 0.8, qty: 200, market: false },
];
const fresh = { balance: 1000, position: null, history: [] };
const opened = openPosition(fresh, 'leveraged', { symbol: 'CRVUSDT', exchange: 'bybit', orders: levOrders, livePrice: 1.0, leverage: 5, mmr: 0.01, nowMs: T0 });

console.log('\nFixture B — open a leveraged ladder');
// fee 100 × 0.00055 = 0.055; margin 100 / 5 = 20
check('wallet after taker fee', opened.acct.balance, 999.945, 1e-9);
check('initial margin', opened.position.im, 20, 1e-9);
// liq = 1.00 × 1.01 − 20 / 100 = 0.81
check('initial liq', leveragedLiqPrice(opened.position), 0.81, 1e-9);
// available = 999.945 − 20 − (90/5 + 160/5 = 50) = 929.945
check('available', demoAvailable(opened.acct, 'leveraged'), 929.945, 1e-9);
check('nothing swept', opened.sweptQty, null);

console.log('\nFixture C — rung fills, then liquidation in a later candle');
const c1 = advancePosition(opened.acct, 'leveraged', [candle(-5, 0.5, 0.5), candle(10, 0.85, 0.88)], [], T0 + 20 * 60e3);
// The pre-execute candle (low 0.5) must be ignored.
// Rung 0.90 fills: fee 90 × 0.0002 = 0.018; avg (100 + 90) / 200 = 0.95; margin 20 + 18 = 38
check('no liquidation yet', c1.trade, null);
check('size after rung 2', c1.acct.position.holdVol, 200, 1e-9);
check('avg after rung 2', c1.acct.position.holdAvgPrice, 0.95, 1e-12);
check('margin after rung 2', c1.acct.position.im, 38, 1e-9);
check('wallet after maker fee', c1.acct.balance, 999.927, 1e-9);
// liq = 0.95 × 1.01 − 38 / 200 = 0.7695
check('liq after rung 2', leveragedLiqPrice(c1.acct.position), 0.7695, 1e-12);
check('rung 3 still resting', c1.acct.position.orders.find((o) => o.step === 3).state, 2);
check('last price = close', c1.acct.position.lastPrice, 0.88);

// Low 0.70: rung 0.80 (> liq 0.7695) fills first: fee 0.032; avg 350/400 = 0.875;
// margin 70; new liq = 0.875 × 1.01 − 70/400 = 0.70875 ≥ 0.70 → liquidated.
const c2 = advancePosition(c1.acct, 'leveraged', [candle(30, 0.7, 0.72)], [], T0 + 40 * 60e3);
check('liquidated', c2.trade && c2.trade.outcome, 'liquidated');
check('liq price', c2.trade.exitPrice, 0.70875, 1e-12);
check('position cleared', c2.acct.position, null);
// wallet = 999.927 − 0.032 − 70 = 929.895; pnl = −70 − (0.055 + 0.018 + 0.032)
check('wallet after liquidation', c2.acct.balance, 929.895, 1e-9);
check('trade pnl', c2.trade.pnl, -70.105, 1e-9);
check('pnl reconciles with wallet', 1000 + c2.trade.pnl, c2.acct.balance, 1e-9);
check('3/3 filled', c2.trade.filled, 3);

console.log('\nFixture D — same result from one coarse candle');
const coarse = advancePosition(opened.acct, 'leveraged', [candle(0, 0.7, 0.72)], [], T0 + 40 * 60e3);
check('coarse liq price', coarse.trade.exitPrice, 0.70875, 1e-12);
check('coarse wallet', coarse.acct.balance, 929.895, 1e-9);

console.log('\nFixture E — re-processing a candle is harmless');
const again = advancePosition(c1.acct, 'leveraged', [candle(10, 0.85, 0.88)], [], T0 + 20 * 60e3);
check('same size', again.acct.position.holdVol, 200, 1e-9);
check('same wallet', again.acct.balance, 999.927, 1e-9);

console.log('\nFixture F — liquidation before the next rung');
// 10x: margin 10, liq = 1.01 − 10/100 = 0.91. Rung at 0.85 sits below liq,
// so a drop to 0.80 liquidates at 0.91 and the rung never fills.
const o10 = openPosition(fresh, 'leveraged', { symbol: 'CRVUSDT', exchange: 'bybit', orders: [levOrders[0], { step: 2, price: 0.85, qty: 100, market: false }], livePrice: 1.0, leverage: 10, mmr: 0.01, nowMs: T0 });
const f1 = advancePosition(o10.acct, 'leveraged', [candle(1, 0.8, 0.8)], [], T0 + 5 * 60e3);
check('liquidated at 0.91', f1.trade.exitPrice, 0.91, 1e-12);
check('rung canceled', f1.trade.filled, 1);
check('wallet', f1.acct.balance, 1000 - 0.055 - 10, 1e-9);

console.log('\nFixture G — funding between candles');
// After rung 2 (size 200), last close 0.88; rate 0.0001 → pays 200 × 0.88 × 0.0001 = 0.0176
const g = advancePosition(opened.acct, 'leveraged', [candle(10, 0.85, 0.88), candle(70, 0.86, 0.87)], [{ time: T0 + 60 * 60e3, rate: 0.0001 }], T0 + 80 * 60e3);
check('funding paid', g.acct.position.funding, 0.0176, 1e-12);
check('wallet after funding', g.acct.balance, 999.927 - 0.0176, 1e-9);
const g2 = advancePosition(g.acct, 'leveraged', [candle(70, 0.86, 0.87)], [{ time: T0 + 60 * 60e3, rate: 0.0001 }], T0 + 80 * 60e3);
check('funding not charged twice', g2.acct.position.funding, 0.0176, 1e-12);

console.log('\nFixture H — manual close in profit');
// size 200 @ 0.95, close at 1.00: price pnl 10, close fee 200 × 0.00055 = 0.11
const h = closePosition(c1.acct, 'leveraged', 1.0, T0 + 60 * 60e3);
check('wallet', h.acct.balance, 999.927 + 10 - 0.11, 1e-9);
check('trade pnl', h.trade.pnl, 10 - 0.073 - 0.11, 1e-9);
check('pnl reconciles with wallet', 1000 + h.trade.pnl, h.acct.balance, 1e-9);
check('resting rung canceled', h.trade.filled, 2);
check('history recorded', h.acct.history.length, 1);

console.log('\nFixture I — spot ladder, fill and close');
const spotOrders = [
  { step: 1, price: 1.0, qty: 100, market: true },
  { step: 2, price: 0.9, qty: 100, market: false },
];
const s0 = openPosition(fresh, 'spot', { symbol: 'CRVUSDT', exchange: 'bybit', orders: spotOrders, livePrice: 1.0, nowMs: T0 });
// cash 1000 − 100 − 0.1 = 899.9; 90 locked by the resting buy
check('cash after market buy', s0.acct.balance, 899.9, 1e-9);
check('available', demoAvailable(s0.acct, 'spot'), 809.9, 1e-9);
const s1 = advancePosition(s0.acct, 'spot', [candle(3, 0.85, 0.9)], [], T0 + 10 * 60e3);
// fill 90 + fee 0.09 → cash 809.81; avg 0.95; equity 809.81 + 200 × 0.9 = 989.81
check('cash after fill', s1.acct.balance, 809.81, 1e-9);
check('spot avg', s1.acct.position.holdAvgPrice, 0.95, 1e-12);
check('spot equity', demoEquity(s1.acct, 'spot'), 989.81, 1e-9);
const s2 = closePosition(s1.acct, 'spot', 1.0, T0 + 20 * 60e3);
// proceeds 200 − fee 0.2 → cash 1009.61; pnl 200 − 0.2 − 190 − 0.19 = 9.61
check('cash after close', s2.acct.balance, 1009.61, 1e-9);
check('spot pnl', s2.trade.pnl, 9.61, 1e-9);

console.log('\nFixture J — last rung sweeps what is left');
// $300 spot: market 100 + 0.1 fee → 199.9 free; rung 2 locks 90 → 109.9;
// rung 3 (200 @ 0.80) needs 0.80 × 1.001 per unit → 109.9 / 0.8008 = 137.2378
const j = openPosition({ balance: 300, position: null }, 'spot', { symbol: 'CRVUSDT', exchange: 'bybit', orders: [...spotOrders, { step: 3, price: 0.8, qty: 200, market: false }], livePrice: 1.0, nowMs: T0 });
check('swept qty', j.sweptQty, 109.9 / 0.8008, 1e-9);
check('last order shrunk', j.position.orders[2].vol, 109.9 / 0.8008, 1e-9);

console.log('\nFixture K — market buy that cannot be afforded');
let threw = false;
try { openPosition({ balance: 10, position: null }, 'spot', { symbol: 'X', exchange: 'bybit', orders: spotOrders, livePrice: 1.0, nowMs: T0 }); } catch { threw = true; }
check('throws', threw, true);
// $150: market leaves 49.9 free, but rung 2 needs 90 before the last rung
threw = false;
try { openPosition({ balance: 150, position: null }, 'spot', { symbol: 'X', exchange: 'bybit', orders: [...spotOrders, { step: 3, price: 0.8, qty: 200, market: false }], livePrice: 1.0, nowMs: T0 }); } catch { threw = true; }
check('over-sized middle rung throws', threw, true);

if (failures) {
  console.log(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\nAll demo simulator checks passed.');
