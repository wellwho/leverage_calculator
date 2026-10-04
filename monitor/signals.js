// Flush-risk scoring — pure math, no network calls (same split as calc.js /
// statusCalc.js in the main app, so it can be pinned by plain node tests).
//
// A "flush" here means a long squeeze: price drops fast enough to liquidate
// a crowd of leveraged longs, whose forced selling pushes price down further.
// None of these signals predicts one on its own, and even together they're
// probabilistic. What they measure is how much liquidatable long leverage
// has built up, and how frothy perps are, compared with the symbol's own
// recent history. That's why every signal is a percentile against that
// symbol's last ~3 weeks rather than a fixed threshold: "high open interest"
// means something very different for BTC than for CRV.
//
// The model follows the reading in Credible Crypto's Velo Data tutorial
// (youtube.com/watch?v=rdaZDhciMxI), where the core panels are price,
// aggregated open interest, aggregated funding and aggregated perp premium,
// with volume delta as secondary:
//   - open interest is aggregated across exchanges and measured in COINS,
//     never dollars: dollar OI rises with price even when nobody opens a new
//     position, which looks like a leverage build-up that isn't there;
//   - OI rising WITH price = directional longs opening (what gets flushed);
//     OI falling as price rises = shorts covering (not long fuel);
//   - funding and premium are OI-weighted averages across exchanges; a perp
//     premium over spot means leveraged buyers are paying above fair value;
//   - positive funding is "typically bearish", but stays normal for long
//     stretches in strong bull markets, so funding leans on its own recent
//     range more than on an absolute level.
// Long/short ratio, taker flow and price extension are kept as low-weight
// supporting signals; the video doesn't use them.
//
// Each signal returns a 0..1 sub-score (1 = most flush-prone reading in the
// window) or null when its data isn't available (e.g. the symbol isn't
// listed on Binance). The composite is a weighted mean over whichever
// signals ARE available, so a missing source lowers coverage, not the score.

const HOUR_MS = 60 * 60 * 1000;

// Share of `values` that are <= `x`, in 0..1. Ties count as "at or below",
// so the maximum of a window always scores 1.
function percentileRank(values, x) {
  const finite = values.filter(Number.isFinite);
  if (!finite.length || !Number.isFinite(x)) return null;
  let atOrBelow = 0;
  for (const v of finite) if (v <= x) atOrBelow += 1;
  return atOrBelow / finite.length;
}

function clamp01(x) {
  return Math.min(1, Math.max(0, x));
}

const floorHour = (t) => Math.floor(t / HOUR_MS) * HOUR_MS;

// Funding rates are quoted per funding interval, and that interval differs
// per symbol (8h for most, 4h or 1h for some). Normalizes to an 8h-equivalent
// rate so readings are comparable across symbols and exchanges.
function fundingTo8h(rate, intervalHours) {
  const r = Number(rate);
  const h = Number(intervalHours) || 8;
  if (!Number.isFinite(r)) return null;
  return r * (8 / h);
}

// Weighted mean of [{v, w}] entries, skipping missing values; plain mean if
// no weights are usable.
function weightedMean(entries) {
  const ok = entries.filter((e) => Number.isFinite(e.v));
  if (!ok.length) return null;
  const wsum = ok.reduce((a, e) => a + (e.w > 0 ? e.w : 0), 0);
  if (!(wsum > 0)) return ok.reduce((a, e) => a + e.v, 0) / ok.length;
  return ok.reduce((a, e) => a + e.v * (e.w > 0 ? e.w : 0), 0) / wsum;
}

// Merges several exchanges' hourly open-interest series ([{t, oi}], any
// order) into one summed series, keeping only hours every series has, so a
// gap on one exchange can't look like a sudden OI drop.
function combineHourly(seriesList) {
  const present = seriesList.filter((s) => Array.isArray(s) && s.length);
  if (!present.length) return [];
  const maps = present.map((s) => new Map(s.map((p) => [floorHour(p.t), p.oi])));
  const hours = [...maps[0].keys()].filter((t) => maps.every((m) => Number.isFinite(m.get(t))));
  hours.sort((a, b) => a - b);
  return hours.map((t) => ({ t, oi: maps.reduce((sum, m) => sum + m.get(t), 0) }));
}

// OI-weighted average of several exchanges' hourly series ([{t, v}]),
// e.g. perp premium. `weights` are each exchange's current OI in USD.
function weightedHourly(seriesList, weights) {
  const present = seriesList.map((s, i) => ({ s, w: weights[i] })).filter((x) => Array.isArray(x.s) && x.s.length);
  if (!present.length) return [];
  const maps = present.map((x) => ({ m: new Map(x.s.map((p) => [floorHour(p.t), p.v])), w: x.w }));
  const hours = [...maps[0].m.keys()].filter((t) => maps.every((x) => Number.isFinite(x.m.get(t))));
  hours.sort((a, b) => a - b);
  return hours.map((t) => ({ t, v: weightedMean(maps.map((x) => ({ v: x.m.get(t), w: x.w }))) }));
}

// Value `hours` before the series' last point, or null if the series doesn't
// reach back that far. Series must be ascending by t.
function valueHoursAgo(series, hours, key) {
  if (!series.length) return null;
  const target = series[series.length - 1].t - hours * HOUR_MS;
  for (let i = series.length - 1; i >= 0; i -= 1) {
    if (series[i].t <= target) return series[i][key];
  }
  return null;
}

// Rolling `hours`-long % change at every point that has enough history.
function rollingChanges(series, hours, key) {
  const byT = new Map(series.map((p) => [p.t, p[key]]));
  const out = [];
  for (const p of series) {
    const past = byT.get(p.t - hours * HOUR_MS);
    if (Number.isFinite(past) && past > 0) out.push({ t: p.t, chg: p[key] / past - 1 });
  }
  return out;
}

function pctChange(now, then) {
  return Number.isFinite(now) && Number.isFinite(then) && then > 0 ? now / then - 1 : null;
}

// --- Individual signals ------------------------------------------------------

// 1. How high aggregated open interest (in coins) is versus its own recent
//    range. High OI = more positions that CAN be liquidated, in either
//    direction.
function scoreOiLevel(oi) {
  if (oi.length < 48) return null;
  const vals = oi.map((p) => p.oi);
  const current = vals[vals.length - 1];
  return { score: percentileRank(vals, current), current };
}

// 2. Long build-up: OI rising together with price over 24h, i.e. new
//    directional longs opening. OI growth while price FALLS is mostly shorts
//    opening, so it counts half; OI shrinking scores low whatever price does
//    (positions closing, e.g. shorts covering into a rally). Ranked against
//    every rolling 24h window in the series.
const SHORT_SIDE_DISCOUNT = 0.5;

function longBuildupValue(oiChg, pxChg) {
  return oiChg > 0 && pxChg <= 0 ? oiChg * SHORT_SIDE_DISCOUNT : oiChg;
}

function scoreLongBuildup(oi, price) {
  const priceByT = new Map(price.map((p) => [p.t, p.close]));
  const joined = oi.filter((p) => priceByT.has(p.t)).map((p) => ({ t: p.t, oi: p.oi, close: priceByT.get(p.t) }));
  if (joined.length < 72) return null;
  const pxChg = new Map(rollingChanges(joined, 24, 'close').map((c) => [c.t, c.chg]));
  const rows = rollingChanges(joined, 24, 'oi')
    .filter((c) => pxChg.has(c.t))
    .map((c) => ({ oiChg: c.chg, pxChg: pxChg.get(c.t), v: longBuildupValue(c.chg, pxChg.get(c.t)) }));
  if (rows.length < 24) return null;
  const last = rows[rows.length - 1];
  return { score: percentileRank(rows.map((r) => r.v), last.v), oiChg24h: last.oiChg, priceChg24h: last.pxChg };
}

// 3. Funding: longs paying shorts. 70% relative (percentile vs recent
//    funding), 30% absolute: at or below the 0.01%/8h baseline most
//    exchanges default to scores 0 on that part, 0.05%/8h or more scores 1.
//    Mostly relative because positive funding is normal in strong bull
//    markets; the absolute part stops a symbol that sat at baseline all month
//    from maxing out on one tick above it. Zero or negative funding (shorts
//    paying) scores 0: that's not a crowded-long market.
const FUNDING_BASELINE_8H = 0.0001;
const FUNDING_HOT_8H = 0.0005;

function scoreFunding(current8h, history8h) {
  if (!Number.isFinite(current8h)) return null;
  if (current8h <= 0) return { score: 0, current8h };
  const abs = clamp01((current8h - FUNDING_BASELINE_8H) / (FUNDING_HOT_8H - FUNDING_BASELINE_8H));
  const rel = history8h.filter(Number.isFinite).length >= 10 ? percentileRank(history8h, current8h) : abs;
  return { score: 0.7 * rel + 0.3 * abs, current8h };
}

// 4. Perp premium: perps trading above spot because leveraged buyers are
//    paying up ("froth"). Same 70/30 relative/absolute split as funding; a
//    spot premium (perps below spot, demand coming from spot) scores 0.
const PREMIUM_HOT = 0.002; // 0.2% over spot

function scorePremium(premium) {
  if (premium.length < 48) return null;
  const vals = premium.map((p) => p.v);
  const current = vals[vals.length - 1];
  if (!Number.isFinite(current)) return null;
  if (current <= 0) return { score: 0, current };
  return { score: 0.7 * percentileRank(vals, current) + 0.3 * clamp01(current / PREMIUM_HOT), current };
}

// 5. Long crowding: the share of accounts (or top traders) positioned long,
//    versus its own recent range. Averaged across whichever sources exist.
function scoreCrowding(ratioSeriesList) {
  const parts = ratioSeriesList
    .filter((s) => Array.isArray(s) && s.length >= 48)
    .map((s) => {
      const vals = s.map((p) => p.v);
      const current = vals[vals.length - 1];
      return { score: percentileRank(vals, current), current };
    });
  if (!parts.length) return null;
  return { score: parts.reduce((a, p) => a + p.score, 0) / parts.length, longShare: parts[0].current };
}

// 6. Aggressive selling: taker (market-order) sell volume overtaking buys
//    over the last 4h. Low buy/sell ratio = sellers hitting bids, scored
//    inverted so heavier selling scores higher. This is the perp volume-delta
//    idea from the video, which it rates as the hardest to read.
function scoreTakerSelling(taker) {
  if (taker.length < 48) return null;
  const window = 4;
  const rolling = [];
  for (let i = window - 1; i < taker.length; i += 1) {
    let buy = 0;
    let sell = 0;
    for (let j = i - window + 1; j <= i; j += 1) {
      buy += taker[j].buy;
      sell += taker[j].sell;
    }
    if (sell > 0) rolling.push(buy / sell);
  }
  if (rolling.length < 24) return null;
  const current = rolling[rolling.length - 1];
  // Share of windows with selling at least this heavy (ratio at or below current).
  const asHeavy = rolling.filter((r) => r <= current).length / rolling.length;
  return { score: 1 - asHeavy + 1 / rolling.length, buySellRatio4h: current };
}

// 7. Price extension: how far price is above its 7-day average, versus how
//    far it has been over the window. Longs in profit and stretched have more
//    to give back than a market that already bled out.
function scoreExtension(price) {
  const smaHours = 168;
  if (price.length < smaHours + 48) return null;
  const ext = [];
  let sum = 0;
  for (let i = 0; i < price.length; i += 1) {
    sum += price[i].close;
    if (i >= smaHours) sum -= price[i - smaHours].close;
    if (i >= smaHours - 1) ext.push(price[i].close / (sum / smaHours) - 1);
  }
  const current = ext[ext.length - 1];
  return { score: percentileRank(ext, current), aboveSma7d: current };
}

// --- Composite ---------------------------------------------------------------

// Core four from the video carry 85% of the weight.
const DEFAULT_WEIGHTS = {
  oiLevel: 0.25,
  longBuildup: 0.2,
  funding: 0.2,
  premium: 0.2,
  crowding: 0.05,
  takerSelling: 0.05,
  extension: 0.05,
};

function composite(signals, weights = DEFAULT_WEIGHTS) {
  let wsum = 0;
  let total = 0;
  for (const [name, w] of Object.entries(weights)) {
    const s = signals[name];
    if (s && Number.isFinite(s.score)) {
      total += w * clamp01(s.score);
      wsum += w;
    }
  }
  const allWeight = Object.values(weights).reduce((a, b) => a + b, 0);
  return { score: wsum ? total / wsum : null, coverage: allWeight ? wsum / allWeight : 0 };
}

// Flush under way (or just happened): open interest dropping sharply together
// with price, i.e. longs being closed or liquidated. Separate from the risk
// score above: it's the "the flush came" message, useful for knowing when a
// ladder's deep rungs may be filling or leverage has reset.
function detectFlush(oi, price, { hours = 4, oiDropPct = 0.08, priceDropPct = 0.04 } = {}) {
  const oiChg = pctChange(oi.length ? oi[oi.length - 1].oi : null, valueHoursAgo(oi, hours, 'oi'));
  const pxChg = pctChange(price.length ? price[price.length - 1].close : null, valueHoursAgo(price, hours, 'close'));
  if (oiChg === null || pxChg === null) return { flushed: false, oiChg, pxChg, hours };
  return { flushed: oiChg <= -oiDropPct && pxChg <= -priceDropPct, oiChg, pxChg, hours };
}

// Market-wide reading from a basket of major perps (BTC, ETH, SOL, ...):
// each coin's composite score, weighted by its open interest in USD, so the
// basket behaves like the market's actual leverage (BTC and ETH dominate).
// USD is right here, unlike in scoreOiLevel: the weights compare coins with
// each other at one moment, they don't track change over time. Breadth
// counts how many coins are at or above `elevated` on their own, because
// leverage stretched across most of the market is a stronger warning than
// one coin running hot. Coins whose score couldn't be computed are left out.
function marketComposite(results, { elevated }) {
  const scored = results.filter((r) => Number.isFinite(r.score));
  if (!scored.length) return { score: null, count: 0, elevatedCount: 0, breadth: 0 };
  const elevatedCount = scored.filter((r) => r.score >= elevated).length;
  return {
    score: weightedMean(scored.map((r) => ({ v: r.score, w: r.oiUsd }))),
    count: scored.length,
    elevatedCount,
    breadth: elevatedCount / scored.length,
  };
}

function computeSignals({ oi, price, premium, funding8h, fundingHistory8h, ratioSeriesList, taker, weights = DEFAULT_WEIGHTS, flushOpts }) {
  const signals = {
    oiLevel: scoreOiLevel(oi),
    longBuildup: scoreLongBuildup(oi, price),
    funding: scoreFunding(funding8h, fundingHistory8h),
    premium: scorePremium(premium),
    crowding: scoreCrowding(ratioSeriesList),
    takerSelling: scoreTakerSelling(taker),
    extension: scoreExtension(price),
  };
  return { signals, ...composite(signals, weights), flush: detectFlush(oi, price, flushOpts) };
}

module.exports = {
  HOUR_MS,
  DEFAULT_WEIGHTS,
  percentileRank,
  fundingTo8h,
  weightedMean,
  combineHourly,
  weightedHourly,
  valueHoursAgo,
  longBuildupValue,
  scoreOiLevel,
  scoreLongBuildup,
  scoreFunding,
  scorePremium,
  scoreCrowding,
  scoreTakerSelling,
  scoreExtension,
  composite,
  detectFlush,
  marketComposite,
  computeSignals,
};
