// Demo-mode trading simulator. Pure functions, no DOM or network: index.html
// fetches real public candles and funding rates and feeds them in, and
// test/demo-sim.test.js checks the same functions against hand-worked cases.
// Loaded by index.html via <script> and require()d by tests, like calc.js.
//
// How a simulated position evolves:
// - Buy #1 fills at execute time at the live price (taker fee).
// - Each resting limit buy fills at its own price (maker fee) once a candle's
//   low reaches it.
// - Leveraged: the position is liquidated once a candle's low reaches the
//   liquidation price (isolated margin: avgEntry * (1 + MMR) - margin / qty,
//   the same formula as statusCalc.js). The whole margin is lost, and
//   remaining orders are canceled.
// - Leveraged: funding is charged at every settlement as qty * price * rate
//   (a long pays when the rate is positive).
// - Fees use Bybit's base tier on both exchanges (see DEMO_FEES).
//
// Only the lowest price reached matters, because every event here is a
// downside one (buys fill and liquidation triggers on the way DOWN). So a
// candle is processed by walking its low from the top: fill the highest
// resting order still above both the low and the current liquidation price,
// recompute liquidation, repeat; if the liquidation price comes first, the
// position is liquidated. That makes the result independent of candle size,
// and re-processing a candle already seen is harmless, which is what lets
// index.html advance a position incrementally with whatever interval fits.
// Funding is the exception: it depends on time, so it is applied in time
// order between candles and is tracked by its own cursor (fundingUntil).
//
// Not modelled: slippage, order-book depth, mark vs last price (liquidation
// uses traded lows), and fills inside the candle that contains the execute
// time (that candle also holds pre-execute prices, so it is skipped).

const DEMO_FEES = {
  leveraged: { taker: 0.00055, maker: 0.0002 },
  spot: { taker: 0.001, maker: 0.001 },
};

const SIM_INTERVALS = [
  { interval: '1', ms: 60e3 },
  { interval: '5', ms: 5 * 60e3 },
  { interval: '15', ms: 15 * 60e3 },
  { interval: '60', ms: 60 * 60e3 },
  { interval: '240', ms: 240 * 60e3 },
  { interval: 'D', ms: 24 * 60 * 60e3 },
];

// Finest candle interval that covers [sinceMs, nowMs] in at most maxCandles
// candles. 450 keeps under MEXC Spot's 500-candle cap.
function pickSimInterval(sinceMs, nowMs, maxCandles = 450) {
  const span = Math.max(0, nowMs - sinceMs);
  return SIM_INTERVALS.find((i) => span / i.ms <= maxCandles) || SIM_INTERVALS[SIM_INTERVALS.length - 1];
}

function leveragedLiqPrice(pos) {
  if (!(pos.holdVol > 0)) return null;
  return pos.holdAvgPrice * (1 + pos.mmr) - pos.im / pos.holdVol;
}

// Margin still reserved by resting limit orders (leveraged) or USDT locked by
// them (spot), as an exchange holds it while orders sit on the book.
function reservedByOrders(pos, leverage) {
  if (!pos) return 0;
  return pos.orders
    .filter((o) => o.state === 2)
    .reduce((sum, o) => sum + (o.price * o.vol) / (leverage || 1), 0);
}

// Free balance the way the real tabs report it: wallet minus what the open
// position and its resting orders tie up.
function demoAvailable(acct, mode) {
  const pos = acct.position;
  if (!pos) return Math.max(0, acct.balance);
  if (mode === 'leveraged') return Math.max(0, acct.balance - pos.im - reservedByOrders(pos, pos.leverage));
  return Math.max(0, acct.balance - reservedByOrders(pos, 1));
}

function demoEquity(acct, mode) {
  const pos = acct.position;
  if (!pos) return acct.balance;
  const price = pos.lastPrice || pos.holdAvgPrice;
  if (mode === 'leveraged') return acct.balance + (price - pos.holdAvgPrice) * pos.holdVol;
  return acct.balance + price * pos.holdVol;
}

// Builds a fresh simulated position from the plan's orders. `orders` are
// index.html's execute rows: { step, price, qty, market }. The market buy
// fills at livePrice; the last limit rung is shrunk, if needed, to what is
// actually left free, mirroring the real Execute's last-order sweep.
// Returns { acct, position, sweptQty } or throws if the market buy alone
// can't be afforded.
function openPosition(acct, mode, { symbol, exchange, orders, livePrice, leverage, mmr, nowMs }) {
  const fees = DEMO_FEES[mode];
  const lev = mode === 'leveraged' ? leverage : 1;
  const market = orders.find((o) => o.market);
  const limits = orders.filter((o) => !o.market);
  const mktNotional = livePrice * market.qty;
  const mktFee = mktNotional * fees.taker;

  let balance = acct.balance - mktFee;
  let free = balance - mktNotional / lev;
  if (mode === 'spot') { balance -= mktNotional; free = balance; }
  if (free < 0) throw new Error(`Not enough simulated balance for the market buy ($${(mktNotional / lev + mktFee).toFixed(2)} needed).`);

  // Reserve each limit order in turn; the last one gets whatever is left
  // (with room for its own fee), like the real last-order sweep.
  const placed = [];
  let sweptQty = null;
  limits.forEach((o, i) => {
    let qty = o.qty;
    const perUnit = o.price / lev + o.price * fees.maker;
    if (i === limits.length - 1 && qty * perUnit > free) {
      qty = Math.max(0, free / perUnit);
      sweptQty = qty;
    } else if ((qty * o.price) / lev > free + 1e-9) {
      throw new Error('This plan needs more than your free simulated balance. Click "Get balance", then Calculate again.');
    }
    if (qty <= 0) return;
    free -= (qty * o.price) / lev;
    placed.push({ ...o, qty });
  });

  const mkOrder = (o, filled, price) => ({
    orderId: `DEMO-${o.step}`,
    step: o.step,
    price,
    vol: o.qty,
    dealVol: filled ? o.qty : 0,
    dealAvgPrice: filled ? price : 0,
    side: 1,
    orderType: o.market ? 5 : 1,
    state: filled ? 3 : 2,
    createTime: nowMs,
    fillTime: filled ? nowMs : null,
  });

  const position = {
    v: 2,
    symbol,
    exchange,
    openTime: nowMs,
    sinceTime: nowMs,
    leverage: mode === 'leveraged' ? leverage : undefined,
    mmr: mode === 'leveraged' ? mmr : undefined,
    holdAvgPrice: livePrice,
    holdVol: market.qty,
    im: mode === 'leveraged' ? mktNotional / leverage : undefined,
    cost: mktNotional,
    fees: mktFee,
    funding: 0,
    simulatedUntil: nowMs,
    fundingUntil: nowMs,
    lastPrice: livePrice,
    lastPriceTime: nowMs,
    orders: [mkOrder(market, true, livePrice), ...placed.map((o) => mkOrder(o, false, o.price))],
  };

  return { acct: { ...acct, balance, position }, position, sweptQty };
}

function fillOrder(acct, mode, order, timeMs) {
  const pos = acct.position;
  const fee = order.price * order.vol * DEMO_FEES[mode].maker;
  const newVol = pos.holdVol + order.vol;
  pos.holdAvgPrice = (pos.holdAvgPrice * pos.holdVol + order.price * order.vol) / newVol;
  pos.holdVol = newVol;
  pos.cost += order.price * order.vol;
  pos.fees += fee;
  if (mode === 'leveraged') pos.im += (order.price * order.vol) / pos.leverage;
  else acct.balance -= order.price * order.vol;
  acct.balance -= fee;
  order.state = 3;
  order.dealVol = order.vol;
  order.dealAvgPrice = order.price;
  order.fillTime = timeMs;
  return { type: 'fill', step: order.step, price: order.price, qty: order.vol, fee, time: timeMs };
}

function closeTrade(acct, mode, { exitPrice, timeMs, outcome }) {
  const pos = acct.position;
  const filled = pos.orders.filter((o) => o.state === 3).length;
  let pnl;
  let closeFee = 0;
  if (outcome === 'liquidated') {
    // Isolated margin: the whole position margin is gone (the maintenance
    // part goes to the liquidation process), on top of fees/funding paid.
    acct.balance -= pos.im;
    pnl = -pos.im - pos.fees - pos.funding;
  } else if (mode === 'leveraged') {
    closeFee = exitPrice * pos.holdVol * DEMO_FEES.leveraged.taker;
    const pricePnl = (exitPrice - pos.holdAvgPrice) * pos.holdVol;
    acct.balance += pricePnl - closeFee;
    pnl = pricePnl - pos.fees - closeFee - pos.funding;
  } else {
    const proceeds = exitPrice * pos.holdVol;
    closeFee = proceeds * DEMO_FEES.spot.taker;
    acct.balance += proceeds - closeFee;
    pnl = proceeds - closeFee - pos.cost - pos.fees;
  }
  const trade = {
    mode,
    symbol: pos.symbol,
    exchange: pos.exchange,
    openTime: pos.openTime,
    closeTime: timeMs,
    outcome,
    avgEntry: pos.holdAvgPrice,
    size: pos.holdVol,
    exitPrice,
    filled,
    total: pos.orders.length,
    leverage: pos.leverage,
    fees: pos.fees + closeFee,
    funding: pos.funding || 0,
    pnl,
  };
  acct.history = [trade, ...(acct.history || [])];
  acct.position = null;
  return trade;
}

// Advances the account's open position through `candles` ({ time (s), low,
// close }, ascending) and, for leveraged, `funding` ({ time (ms), rate },
// ascending). Returns { acct, events, trade } where trade is set if the
// position was liquidated. Does not mutate its input.
function advancePosition(acctIn, mode, candles, funding, nowMs) {
  const acct = JSON.parse(JSON.stringify(acctIn));
  const events = [];
  const pos = acct.position;
  if (!pos) return { acct, events, trade: null };

  const usable = (candles || []).filter((c) => c.time * 1000 >= pos.openTime && Number.isFinite(c.low));
  const fundings = mode === 'leveraged'
    ? (funding || []).filter((f) => f.time > pos.fundingUntil && f.time <= nowMs)
    : [];

  let ci = 0;
  let fi = 0;
  while (ci < usable.length || fi < fundings.length) {
    const c = usable[ci];
    const f = fundings[fi];
    // Funding settles at f.time; candles that start before it go first.
    if (f && (!c || f.time <= c.time * 1000)) {
      const amount = pos.holdVol * pos.lastPrice * f.rate;
      pos.funding += amount;
      acct.balance -= amount;
      pos.fundingUntil = f.time;
      events.push({ type: 'funding', time: f.time, rate: f.rate, amount });
      fi++;
      continue;
    }

    const tMs = c.time * 1000;
    for (;;) {
      const next = pos.orders.filter((o) => o.state === 2).sort((a, b) => b.price - a.price)[0];
      const liq = mode === 'leveraged' ? leveragedLiqPrice(pos) : null;
      if (next && next.price >= c.low && (liq === null || next.price > liq)) {
        if (mode === 'spot' && acct.balance < next.price * next.vol * (1 + DEMO_FEES.spot.maker)) {
          next.state = 4; // can't be paid for any more (shouldn't happen: it was reserved)
          continue;
        }
        events.push(fillOrder(acct, mode, next, tMs));
        continue;
      }
      if (liq !== null && c.low <= liq) {
        pos.orders.forEach((o) => { if (o.state === 2) o.state = 4; });
        const trade = closeTrade(acct, mode, { exitPrice: liq, timeMs: tMs, outcome: 'liquidated' });
        events.push({ type: 'liquidation', price: liq, time: tMs });
        return { acct, events, trade };
      }
      break;
    }
    pos.lastPrice = c.close;
    pos.lastPriceTime = tMs;
    pos.simulatedUntil = Math.max(pos.simulatedUntil, tMs);
    ci++;
  }
  return { acct, events, trade: null };
}

// Manual close at exitPrice: cancels resting orders and sells everything
// (taker fee). Returns { acct, trade }.
function closePosition(acctIn, mode, exitPrice, nowMs) {
  const acct = JSON.parse(JSON.stringify(acctIn));
  if (!acct.position) return { acct, trade: null };
  acct.position.orders.forEach((o) => { if (o.state === 2) o.state = 4; });
  const trade = closeTrade(acct, mode, { exitPrice, timeMs: nowMs, outcome: 'closed' });
  return { acct, trade };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    DEMO_FEES,
    pickSimInterval,
    leveragedLiqPrice,
    demoAvailable,
    demoEquity,
    openPosition,
    advancePosition,
    closePosition,
  };
}
