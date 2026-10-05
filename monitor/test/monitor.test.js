// Pins the monitor's scoring (signals.js) and alert rules (alerts.js) with
// hand-built fixtures. Plain node, no framework: prints PASS/FAIL per check
// and exits 1 on any failure.
//   npm test   (or: node test/monitor.test.js)

const S = require('../signals');
const { decide, riskLevel, marketLevel } = require('../alerts');

let failures = 0;
function check(label, actual, expected, tol = 1e-9) {
  const ok =
    typeof expected === 'number' && typeof actual === 'number'
      ? Math.abs(actual - expected) <= tol
      : JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label}: ${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`);
}

const H = S.HOUR_MS;
const T0 = Date.UTC(2026, 0, 1);
const hourly = (vals, key) => vals.map((v, i) => ({ t: T0 + i * H, [key]: v }));

console.log('\nFixture A — percentile rank and funding normalisation');
check('max of window ranks 1', S.percentileRank([1, 2, 3, 4], 4), 1);
check('min of window ranks 1/n', S.percentileRank([1, 2, 3, 4], 1), 0.25);
check('ties count as at-or-below', S.percentileRank([1, 2, 2, 4], 2), 0.75);
check('non-finite values ignored', S.percentileRank([1, NaN, 3], 3), 1);
check('1h funding x8 to 8h-equivalent', S.fundingTo8h('0.0001', 1), 0.0008);
check('4h funding x2', S.fundingTo8h(0.0001, 4), 0.0002);
check('missing interval defaults to 8h', S.fundingTo8h(0.0001, undefined), 0.0001);

console.log('\nFixture B — combining exchanges');
const a = [{ t: T0, oi: 10 }, { t: T0 + H, oi: 11 }, { t: T0 + 2 * H, oi: 12 }];
const b = [{ t: T0 + 2 * H, oi: 5 }, { t: T0, oi: 4 }]; // unsorted, missing the middle hour
check('only hours present on every exchange are summed', S.combineHourly([a, b]), [{ t: T0, oi: 14 }, { t: T0 + 2 * H, oi: 17 }]);
check('a missing exchange is skipped, not treated as zero', S.combineHourly([a, null]).length, 3);
check('OI-weighted mean', S.weightedMean([{ v: 0.001, w: 3 }, { v: 0.002, w: 1 }]), 0.00125);
check('weighted mean skips missing values', S.weightedMean([{ v: null, w: 3 }, { v: 0.002, w: 1 }]), 0.002);
check(
  'weighted hourly premium',
  S.weightedHourly([hourly([0.001, 0.002], 'v'), hourly([0.003, 0.004], 'v')], [1, 1]).map((p) => p.v),
  [0.002, 0.003],
);

console.log('\nFixture C — long build-up reads OI against price direction');
check('OI up with price up counts in full', S.longBuildupValue(0.1, 0.05), 0.1);
check('OI up with price down (shorts opening) counts half', S.longBuildupValue(0.1, -0.05), 0.05);
check('OI down passes through as negative', S.longBuildupValue(-0.1, 0.05), -0.1);
// 96 flat hours, then a final 24h where OI rises 20% while price rises 5%:
// the latest rolling 24h value is the biggest in the window -> rank 1.
const flat = Array(96).fill(100);
const oiUp = hourly(flat.concat(Array.from({ length: 24 }, (_, i) => 100 * (1 + (0.2 * (i + 1)) / 24))), 'oi');
const pxUp = hourly(flat.concat(Array.from({ length: 24 }, (_, i) => 100 * (1 + (0.05 * (i + 1)) / 24))), 'close');
const lb = S.scoreLongBuildup(oiUp, pxUp);
check('OI +20% with price +5% scores the top of the window', lb.score, 1);
check('reports 24h OI change', lb.oiChg24h, 0.2, 1e-9);
const pxDown = hourly(flat.concat(Array.from({ length: 24 }, (_, i) => 100 * (1 - (0.05 * (i + 1)) / 24))), 'close');
const lbDown = S.scoreLongBuildup(oiUp, pxDown);
check('same OI rise on falling price still ranks high but via the halved value', lbDown.score, 1);
check('too little history returns null', S.scoreLongBuildup(oiUp.slice(0, 50), pxUp.slice(0, 50)), null);

console.log('\nFixture D — funding and premium');
check('negative funding scores 0', S.scoreFunding(-0.0001, [0.0001, 0.0002]).score, 0);
check('zero funding scores 0', S.scoreFunding(0, [0.0001]).score, 0);
// 0.0005/8h is the "hot" level -> abs part 1; max of history -> rel part 1.
const hist = Array.from({ length: 20 }, (_, i) => 0.00005 + i * 0.00001);
check('hot funding at top of history scores 1', S.scoreFunding(0.0005, hist).score, 1);
// Baseline 0.0001: abs part 0; rank in hist = share <= 0.0001 = 6/20 = 0.3 -> 0.7*0.3.
check('baseline funding scores only its relative part', S.scoreFunding(0.0001, hist).score, 0.21, 1e-12);
check('short history falls back to absolute only', S.scoreFunding(0.0003, [0.0001]).score, 0.5, 1e-12);
const prem = hourly(Array.from({ length: 48 }, (_, i) => -0.001 + i * 0.0001), 'v'); // ends at +0.0037
check('perp premium at top of window, above hot level, scores 1', S.scorePremium(prem).score, 1);
check('spot premium (perp below spot) scores 0', S.scorePremium(hourly(Array(48).fill(-0.001), 'v')).score, 0);

console.log('\nFixture E — composite and coverage');
const allHalf = Object.fromEntries(Object.keys(S.DEFAULT_WEIGHTS).map((k) => [k, { score: 0.5 }]));
check('default weights sum to 1', Object.values(S.DEFAULT_WEIGHTS).reduce((x, y) => x + y, 0), 1, 1e-12);
check('uniform 0.5 signals -> 0.5', S.composite(allHalf).score, 0.5, 1e-12);
const partial = { oiLevel: { score: 1 }, funding: { score: 0 }, premium: null };
const c = S.composite(partial);
check('missing signals are re-weighted, not zeroed', c.score, 0.25 / 0.45, 1e-12);
check('coverage = weight share available', c.coverage, 0.45, 1e-12);

console.log('\nFixture F — flush detection');
const oiDrop = hourly([100, 100, 100, 100, 95, 90], 'oi');
const pxDrop = hourly([1, 1, 1, 1, 0.97, 0.94], 'close');
check('OI -10% and price -6% over 4h is a flush', S.detectFlush(oiDrop, pxDrop).flushed, true);
check('price drop with flat OI is not', S.detectFlush(hourly(Array(6).fill(100), 'oi'), pxDrop).flushed, false);

console.log('\nFixture F2 — market basket');
const basket = [
  { asset: 'BTC', score: 0.6, oiUsd: 60 },
  { asset: 'ETH', score: 0.8, oiUsd: 30 },
  { asset: 'SOL', score: 0.9, oiUsd: 10 },
  { asset: 'XRP', score: null, oiUsd: 5 }, // unreadable: left out entirely
];
const m = S.marketComposite(basket, { elevated: 0.7 });
check('OI-weighted market score', m.score, (0.6 * 60 + 0.8 * 30 + 0.9 * 10) / 100, 1e-12);
check('unscored coins are excluded from the count', m.count, 3);
check('breadth counts coins at/above elevated', [m.elevatedCount, m.breadth], [2, 2 / 3]);
check('empty basket gives no score', S.marketComposite([], { elevated: 0.7 }).score, null);
const tm = { elevated: 0.7, high: 0.8, clear: 0.55 };
const br = { elevated: 0.7, hold: 0.5 };
check('low score, low breadth: quiet', marketLevel(0.5, 0.2, tm, br), { level: 0, hold: false });
check('breadth >= 70% lifts a sub-threshold score to elevated', marketLevel(0.65, 0.8, tm, br).level, 1);
check('breadth never lifts above elevated on its own', marketLevel(0.65, 1, tm, br).level, 1);
check('high score is high regardless of breadth', marketLevel(0.85, 0.1, tm, br).level, 2);
check('breadth >= 50% holds an active alert', marketLevel(0.5, 0.5, tm, br), { level: 0, hold: true });
check('unreadable score -> null', marketLevel(null, 0.9, tm, br), null);

console.log('\nFixture G — alert rules');
const t = { elevated: 0.7, high: 0.8, clear: 0.55 };
const REPEAT = 6 * H;
let st;
let d = decide(undefined, riskLevel(0.5, t).level, riskLevel(0.5, t).hold, 0, REPEAT);
check('quiet stays quiet', d.send, null);
d = decide(d.state, 1, true, H, REPEAT);
check('rising to elevated sends', d.send, 'raise');
st = d.state;
d = decide(st, 1, true, 2 * H, REPEAT);
check('staying elevated within repeat window is silent', d.send, null);
d = decide(d.state, 2, true, 3 * H, REPEAT);
check('escalating to high sends', d.send, 'raise');
d = decide(d.state, 1, true, 4 * H, REPEAT);
check('stepping down to elevated is silent', d.send, null);
d = decide(d.state, 2, true, 5 * H, REPEAT);
check('bouncing back to an already-announced high is silent', d.send, null);
d = decide(d.state, 2, true, 3 * H + REPEAT, REPEAT);
check('still high after the repeat window sends a reminder', d.send, 'repeat');
const lv = riskLevel(0.6, t);
check('0.6 is below elevated but above clear: level 0 with hold', lv, { level: 0, hold: true });
d = decide(d.state, lv.level, lv.hold, 10 * H, REPEAT);
check('held at level 1, no all-clear yet', [d.send, d.state.level], [null, 1]);
const lc = riskLevel(0.5, t);
d = decide(d.state, lc.level, lc.hold, 11 * H, REPEAT);
check('below clear threshold sends one all-clear', d.send, 'clear');
d = decide(d.state, 1, true, 12 * H, REPEAT);
check('a new episode raises again after a clear', d.send, 'raise');

if (failures) {
  console.log(`\n${failures} check(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll monitor fixtures match.');
