// Flush monitor: a long-running process (e.g. on a home NAS, see README.md)
// that watches for a MARKET-WIDE long flush. Every POLL_SECONDS it:
//   1. scores flush risk (signals.js) for BTC (WATCHLIST) and for every coin
//      in a basket of major perps (BASKET), from aggregated Bybit, Binance
//      and OKX data,
//   2. combines the basket into one OI-weighted Market score plus breadth
//      (how many majors are elevated at once),
//   3. sends Telegram alerts for BTC and for the Market only, per the rules
//      in alerts.js: never for individual altcoins, and never about
//      anyone's positions (it has no account access at all),
//   4. appends readings to DATA_DIR/readings-YYYY-MM.jsonl for calibrating
//      thresholds against what actually happened,
//   5. pings HEALTHCHECK_URL, so silence from the monitor itself is noticed.
// Alert-only: it never places, changes or closes orders.

const fs = require('fs');
const path = require('path');
const { computeSignals, combineHourly, weightedHourly, weightedMean, marketComposite, DEFAULT_WEIGHTS } = require('./signals');
const { decide, riskLevel, marketLevel } = require('./alerts');
const { bybitMarket, binanceMarket, okxMarket } = require('./sources');
const { createTelegram } = require('./telegram');

// --- Config ------------------------------------------------------------------

// Loads KEY=value lines from .env next to this file, if present. Values
// already in the environment win (e.g. from Docker's env_file or a shell).
function loadDotEnv(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
loadDotEnv(path.join(__dirname, '.env'));

const env = process.env;
const num = (name, fallback) => (env[name] !== undefined && env[name] !== '' ? Number(env[name]) : fallback);
const list = (value, fallback) => String(value || fallback).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);

function parseWeights(spec) {
  const weights = { ...DEFAULT_WEIGHTS };
  for (const part of String(spec || '').split(',').filter(Boolean)) {
    const [k, v] = part.split('=').map((x) => x.trim());
    if (!(k in weights) || !Number.isFinite(Number(v))) throw new Error(`WEIGHTS: bad entry "${part}" (known: ${Object.keys(weights).join(', ')})`);
    weights[k] = Number(v);
  }
  return weights;
}

const config = {
  watchlist: list(env.WATCHLIST, 'BTC'),
  basket: list(env.BASKET, 'BTC,ETH,SOL,XRP,DOGE,BNB,ADA,LINK,AVAX,SUI'),
  pollMs: num('POLL_SECONDS', 300) * 1000,
  risk: { elevated: num('RISK_ELEVATED', 0.7), high: num('RISK_HIGH', 0.8), clear: num('RISK_CLEAR', 0.55) },
  breadth: { elevated: num('BREADTH_ELEVATED', 0.7), hold: num('BREADTH_HOLD', 0.5) },
  minCoverage: num('MIN_COVERAGE', 0.5),
  // Share of the basket that must be readable before a Market score is trusted.
  minBasketShare: num('MIN_BASKET_SHARE', 0.6),
  repeatMs: num('REPEAT_HOURS', 6) * 3600 * 1000,
  flush: { hours: num('FLUSH_HOURS', 4), oiDropPct: num('FLUSH_OI_DROP', 0.08), priceDropPct: num('FLUSH_PRICE_DROP', 0.04) },
  flushCooldownMs: num('FLUSH_COOLDOWN_HOURS', 12) * 3600 * 1000,
  weights: parseWeights(env.WEIGHTS),
  dataDir: env.DATA_DIR || path.join(__dirname, 'data'),
  healthcheckUrl: env.HEALTHCHECK_URL || '',
};

const log = (...args) => console.log(new Date().toISOString(), ...args);
const telegram = createTelegram({ token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID, log });

// --- Persistence --------------------------------------------------------------

fs.mkdirSync(config.dataDir, { recursive: true });
const statePath = path.join(config.dataDir, 'state.json');

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return { alerts: {} };
  }
}

function saveState(state) {
  const tmp = `${statePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, statePath);
}

function appendReadings(lines) {
  const month = new Date().toISOString().slice(0, 7);
  fs.appendFileSync(path.join(config.dataDir, `readings-${month}.jsonl`), lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
}

// --- Formatting ----------------------------------------------------------------

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const pct = (x, d = 1) => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%` : 'n/a');
const rank = (s) => (s && Number.isFinite(s.score) ? `${Math.round(s.score * 100)}/100` : 'n/a');
const px = (x) => (Number.isFinite(x) ? Number(x.toPrecision(5)).toString() : 'n/a');
const usd = (x) => (Number.isFinite(x) ? (x >= 1e9 ? `$${(x / 1e9).toFixed(1)}B` : `$${(x / 1e6).toFixed(0)}M`) : 'n/a');
const sc = (x) => (Number.isFinite(x) ? x.toFixed(2) : 'n/a');
const LEVEL_NAME = ['normal', 'ELEVATED', 'HIGH'];
const icon = (kind, level) => (kind === 'clear' ? '✅' : level === 2 ? '🚨' : '⚠️');

function signalLines(r) {
  const s = r.signals;
  return [
    `• Open interest (coins, ${r.oiSources.join('+')}): ${rank(s.oiLevel)} of 3-week range, ${usd(r.oiUsd)}`,
    `• Long build-up 24h: OI ${pct(s.longBuildup?.oiChg24h)} vs price ${pct(s.longBuildup?.priceChg24h)} → ${rank(s.longBuildup)}`,
    `• Funding (OI-weighted): ${Number.isFinite(r.funding8h) ? `${(r.funding8h * 100).toFixed(4)}%/8h` : 'n/a'} → ${rank(s.funding)}`,
    `• Perp premium: ${pct(s.premium?.current, 3)} → ${rank(s.premium)}`,
    `• Long/short crowding: ${Number.isFinite(s.crowding?.longShare) ? `${(s.crowding.longShare * 100).toFixed(0)}% long` : 'n/a'} → ${rank(s.crowding)}`,
    `• Taker flow 4h: buy/sell ${Number.isFinite(s.takerSelling?.buySellRatio4h) ? s.takerSelling.buySellRatio4h.toFixed(2) : 'n/a'} → ${rank(s.takerSelling)}`,
    `• Above 7d average: ${pct(s.extension?.aboveSma7d)} → ${rank(s.extension)}`,
  ];
}

// One row per basket coin, highest score first, as a monospace table.
function basketTable(results) {
  const rows = [...results]
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
    .map((r) => `${r.asset.padEnd(5)} ${sc(r.score)}${r.score >= config.risk.elevated ? ' ▲' : '  '}  OI ${usd(r.oiUsd).padStart(6)}  fund ${Number.isFinite(r.funding8h) ? `${(r.funding8h * 100).toFixed(3)}%` : 'n/a'}`);
  return `<pre>${esc(rows.join('\n'))}</pre>`;
}

function riskMessage(kind, r) {
  const head =
    kind === 'clear'
      ? `✅ <b>${esc(r.asset)} flush risk back to normal</b> (${sc(r.score)})`
      : `${icon(kind, r.level)} <b>${esc(r.asset)} flush risk ${LEVEL_NAME[r.level]}</b> (${sc(r.score)})${kind === 'repeat' ? ' — still' : ''}`;
  const lines = [head, `Price ${px(r.price)} (24h ${pct(r.price24hPct)})`, ...signalLines(r)];
  if (r.coverage < 1) lines.push(`<i>Data coverage ${Math.round(r.coverage * 100)}% (${esc(r.missing.join(', ') || 'some signals')} unavailable)</i>`);
  return lines.join('\n');
}

function marketMessage(kind, m) {
  const head =
    kind === 'clear'
      ? `✅ <b>Market leverage back to normal</b> (${sc(m.score)})`
      : `${icon(kind, m.level)} <b>Market leverage ${LEVEL_NAME[m.level]}</b> (${sc(m.score)})${kind === 'repeat' ? ' — still' : ''}`;
  return [
    head,
    `${m.elevatedCount} of ${m.count} majors elevated (≥ ${config.risk.elevated}); OI-weighted score ${sc(m.score)}, total OI ${usd(m.oiUsd)}`,
    basketTable(m.results),
  ].join('\n');
}

function flushMessage(r) {
  const f = r.flush;
  return `🌊 <b>${esc(r.asset)} flush under way</b>: OI ${pct(f.oiChg)} and price ${pct(f.pxChg)} over ${f.hours}h. Leverage is being cleared out.`;
}

// --- One cycle ----------------------------------------------------------------

async function analyse(asset) {
  const symbol = `${asset}USDT`;
  const bybit = await bybitMarket(symbol);
  const missing = [];
  const optional = (name, promise) =>
    promise.catch((err) => {
      missing.push(name);
      log(`${asset}: ${name} unavailable: ${err.message}`);
      return null;
    });
  const [binance, okx] = await Promise.all([optional('Binance', binanceMarket(symbol)), optional('OKX', okxMarket(asset))]);
  const venues = [['Bybit', bybit], ['Binance', binance], ['OKX', okx]].filter(([, v]) => v);
  const oi = combineHourly(venues.map(([, v]) => v.oi));
  const premiumVenues = venues.filter(([, v]) => v.premium);
  const premium = weightedHourly(premiumVenues.map(([, v]) => v.premium), premiumVenues.map(([, v]) => v.oiValueUsd));
  const funding8h = weightedMean(venues.map(([, v]) => ({ v: v.funding8h, w: v.oiValueUsd })));
  const result = computeSignals({
    oi,
    price: bybit.price1h,
    premium,
    funding8h,
    fundingHistory8h: bybit.fundingHistory8h,
    ratioSeriesList: [bybit.longRatio, binance?.topLongRatio],
    taker: binance?.taker || [],
    weights: config.weights,
    flushOpts: config.flush,
  });
  const nullSignals = Object.entries(result.signals).filter(([, s]) => !s).map(([k]) => k);
  return {
    asset,
    price: bybit.price,
    price24hPct: bybit.price24hPct,
    oiUsd: venues.reduce((a, [, v]) => a + (Number.isFinite(v.oiValueUsd) ? v.oiValueUsd : 0), 0),
    oiSources: venues.map(([name]) => name),
    funding8h,
    missing: missing.concat(nullSignals),
    ...result,
  };
}

let lastSnapshot = { at: null, watched: [], market: null, errors: [] };
const failStreak = {};

async function cycle(state) {
  const now = Date.now();
  const errors = [];

  // Every distinct coin once, sequentially to stay gentle on rate limits.
  const byAsset = new Map();
  for (const asset of [...new Set([...config.watchlist, ...config.basket])]) {
    try {
      byAsset.set(asset, await analyse(asset));
      failStreak[asset] = 0;
    } catch (err) {
      failStreak[asset] = (failStreak[asset] || 0) + 1;
      errors.push(`${asset}: ${err.message}`);
      // Three failed cycles in a row (~15 min) on a watched coin is worth a
      // message: the monitor is running but blind on it.
      if (config.watchlist.includes(asset) && failStreak[asset] === 3) {
        await notify(`⚙️ Monitor can't read market data for ${esc(asset)}: ${esc(err.message)}`);
      }
    }
  }

  // Individual alerts: watchlist coins only.
  const watched = config.watchlist.map((a) => byAsset.get(a)).filter(Boolean);
  for (const r of watched) {
    const lvl = r.coverage >= config.minCoverage ? riskLevel(r.score, config.risk) : null;
    if (lvl) {
      const key = `risk:${r.asset}`;
      const d = decide(state.alerts[key], lvl.level, lvl.hold, now, config.repeatMs);
      state.alerts[key] = d.state;
      r.level = d.state.level;
      if (d.send) await notify(riskMessage(d.send, r));
    }
    const flushKey = `flush:${r.asset}`;
    if (r.flush.flushed && now - (state.alerts[flushKey]?.lastSentAt || 0) >= config.flushCooldownMs) {
      state.alerts[flushKey] = { lastSentAt: now };
      await notify(flushMessage(r));
    }
  }

  // Market basket.
  const basketResults = config.basket.map((a) => byAsset.get(a)).filter((r) => r && r.coverage >= config.minCoverage);
  let market = null;
  if (basketResults.length >= Math.ceil(config.basket.length * config.minBasketShare)) {
    market = {
      ...marketComposite(basketResults, { elevated: config.risk.elevated }),
      oiUsd: basketResults.reduce((a, r) => a + r.oiUsd, 0),
      results: basketResults,
    };
    const lvl = marketLevel(market.score, market.breadth, config.risk, config.breadth);
    if (lvl) {
      const d = decide(state.alerts.market, lvl.level, lvl.hold, now, config.repeatMs);
      state.alerts.market = d.state;
      market.level = d.state.level;
      if (d.send) await notify(marketMessage(d.send, market));
    }
  } else {
    errors.push(`market: only ${basketResults.length} of ${config.basket.length} basket coins readable`);
  }

  // Drop alert state for coins no longer on the watchlist.
  for (const key of Object.keys(state.alerts)) {
    const [kind, asset] = key.split(':');
    if ((kind === 'risk' || kind === 'flush') && !config.watchlist.includes(asset)) delete state.alerts[key];
  }

  const t = new Date(now).toISOString();
  const subScores = (r) => Object.fromEntries(Object.entries(r.signals).map(([k, s]) => [k, Number.isFinite(s?.score) ? Number(s.score.toFixed(3)) : null]));
  appendReadings([
    // Watchlist coins in full detail; basket coins compact, to keep the log small.
    ...watched.map((r) => ({ t, asset: r.asset, price: r.price, score: r.score, coverage: r.coverage, level: r.level ?? null, funding8h: r.funding8h, oiUsd: r.oiUsd, flush: r.flush, signals: r.signals })),
    ...basketResults
      .filter((r) => !config.watchlist.includes(r.asset))
      .map((r) => ({ t, asset: r.asset, price: r.price, score: r.score, coverage: r.coverage, oiUsd: r.oiUsd, sub: subScores(r) })),
    ...(market ? [{ t, asset: 'MARKET', score: market.score, level: market.level ?? null, breadth: market.breadth, elevatedCount: market.elevatedCount, count: market.count, oiUsd: market.oiUsd }] : []),
  ]);

  lastSnapshot = { at: now, watched, market, errors };
  // Degraded = the monitor can't do its job this cycle: a watchlist coin or
  // the whole Market score is missing. One basket coin failing is only
  // logged; reporting it to the heartbeat would page "down" on every
  // transient exchange hiccup.
  const degraded = watched.length < config.watchlist.length || !market;
  return { errors, degraded };
}

async function notify(html) {
  try {
    await telegram.send(html);
  } catch (err) {
    log(`telegram send failed: ${err.message}`);
  }
}

async function ping(suffix = '') {
  if (!config.healthcheckUrl) return;
  try {
    await fetch(`${config.healthcheckUrl}${suffix}`, { signal: AbortSignal.timeout(10000) });
  } catch (err) {
    log(`healthcheck ping failed: ${err.message}`);
  }
}

// --- Telegram commands ----------------------------------------------------------

function statusText() {
  if (!lastSnapshot.at) return 'No reading yet; the first cycle is still running.';
  const lines = [`<b>Flush monitor</b> · ${new Date(lastSnapshot.at).toISOString().slice(0, 16).replace('T', ' ')} UTC`];
  for (const r of lastSnapshot.watched) {
    lines.push('', `<b>${esc(r.asset)}</b> ${px(r.price)} (24h ${pct(r.price24hPct)}) · risk ${sc(r.score)} (${LEVEL_NAME[r.level || 0]})`, ...signalLines(r));
  }
  const m = lastSnapshot.market;
  if (m) {
    lines.push('', `<b>Market</b> · score ${sc(m.score)} (${LEVEL_NAME[m.level || 0]}) · ${m.elevatedCount}/${m.count} elevated · OI ${usd(m.oiUsd)}`, basketTable(m.results));
  }
  if (lastSnapshot.errors.length) lines.push('', '<b>Errors</b>', ...lastSnapshot.errors.map((e) => `• ${esc(e)}`));
  return lines.join('\n');
}

async function onCommand(cmd) {
  if (cmd === '/status') return statusText();
  return [
    '<b>Commands</b>',
    '/status — latest BTC readout and the market basket',
    '',
    `Watching ${esc(config.watchlist.join(', '))} and a market basket of ${config.basket.length} majors (${esc(config.basket.join(', '))}), every ${config.pollMs / 60000} min.`,
    `Alerts at risk ≥ ${config.risk.elevated} (elevated) / ≥ ${config.risk.high} (high), or when ≥ ${Math.round(config.breadth.elevated * 100)}% of the basket is elevated at once.`,
  ].join('\n');
}

// --- Main loop -------------------------------------------------------------------

async function main() {
  const once = process.argv.includes('--once');
  const state = loadState();
  log(`starting: watchlist=${config.watchlist.join(',')} basket=${config.basket.join(',')} poll=${config.pollMs / 1000}s telegram=${telegram.enabled ? 'on' : 'off (stdout)'} data=${config.dataDir}`);

  if (once) {
    const { errors } = await cycle(state);
    saveState(state);
    console.log(statusText().replace(/<[^>]+>/g, ''));
    process.exit(errors.length ? 1 : 0);
  }

  telegram.listen(onCommand);
  let first = true;
  for (;;) {
    try {
      const { errors, degraded } = await cycle(state);
      saveState(state);
      if (errors.length) log(`cycle errors: ${errors.join(' | ')}`);
      await ping(degraded ? '/fail' : '');
      if (first) {
        first = false;
        await notify(`🟢 Flush monitor started. Watching ${esc(config.watchlist.join(', '))} and the market (${config.basket.length} majors). Send /status any time.`);
      }
    } catch (err) {
      log(`cycle crashed: ${err.stack || err.message}`);
      await ping('/fail');
    }
    await new Promise((r) => setTimeout(r, config.pollMs));
  }
}

main();
