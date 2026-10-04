// Flush monitor: a long-running process (meant for Docker on an always-on
// box, see README.md) that every POLL_SECONDS:
//   1. finds the symbols to watch: WATCHLIST plus anything open on the
//      user's Bybit/MEXC accounts (read-only keys),
//   2. pulls aggregated market data for each from Bybit, Binance and OKX,
//   3. scores flush risk (signals.js) and checks liquidation distance,
//   4. sends Telegram alerts per the rules in alerts.js,
//   5. appends every reading to DATA_DIR/readings-YYYY-MM.jsonl, so the
//      thresholds can be calibrated against what actually happened,
//   6. pings HEALTHCHECK_URL, so silence from the monitor itself is noticed.
// Alert-only: it never places, changes or closes orders.

const fs = require('fs');
const path = require('path');
const { computeSignals, combineHourly, weightedHourly, weightedMean, liqDistance, DEFAULT_WEIGHTS } = require('./signals');
const { decide, riskLevel, liqLevel } = require('./alerts');
const { bybitMarket, binanceMarket, okxMarket, bybitPositions, mexcPositions } = require('./sources');
const { createTelegram } = require('./telegram');

// --- Config ------------------------------------------------------------------

const env = process.env;
const num = (name, fallback) => (env[name] !== undefined && env[name] !== '' ? Number(env[name]) : fallback);

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
  watchlist: String(env.WATCHLIST || 'CRV').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
  pollMs: num('POLL_SECONDS', 300) * 1000,
  risk: { elevated: num('RISK_ELEVATED', 0.7), high: num('RISK_HIGH', 0.8), clear: num('RISK_CLEAR', 0.55) },
  minCoverage: num('MIN_COVERAGE', 0.5),
  liq: { warn: num('LIQ_WARN', 0.15), danger: num('LIQ_DANGER', 0.08) },
  repeatMs: num('REPEAT_HOURS', 6) * 3600 * 1000,
  flush: { hours: num('FLUSH_HOURS', 4), oiDropPct: num('FLUSH_OI_DROP', 0.08), priceDropPct: num('FLUSH_PRICE_DROP', 0.04) },
  flushCooldownMs: num('FLUSH_COOLDOWN_HOURS', 12) * 3600 * 1000,
  minSpotUsd: num('MIN_SPOT_USD', 10),
  weights: parseWeights(env.WEIGHTS),
  dataDir: env.DATA_DIR || path.join(__dirname, 'data'),
  healthcheckUrl: env.HEALTHCHECK_URL || '',
};

// Stablecoins show up as wallet balances but have no flush to watch for.
const STABLES = new Set(['USDC', 'USDE', 'DAI', 'FDUSD', 'BUSD', 'TUSD', 'USDD', 'PYUSD', 'USD1']);

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

function appendReading(reading) {
  const month = new Date().toISOString().slice(0, 7);
  fs.appendFileSync(path.join(config.dataDir, `readings-${month}.jsonl`), `${JSON.stringify(reading)}\n`);
}

// --- Formatting ----------------------------------------------------------------

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const pct = (x, d = 1) => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%` : 'n/a');
const rank = (s) => (s && Number.isFinite(s.score) ? `${Math.round(s.score * 100)}/100` : 'n/a');
const px = (x) => (Number.isFinite(x) ? Number(x.toPrecision(5)).toString() : 'n/a');
const usd = (x) => (Number.isFinite(x) ? `$${(x / 1e6).toFixed(1)}M` : 'n/a');
const LEVEL_NAME = ['normal', 'ELEVATED', 'HIGH'];

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

function positionLine(p, price) {
  if (p.kind === 'spot') return `${p.exchange} spot: ${px(p.size)} ${esc(p.asset)}${Number.isFinite(price) ? ` (≈$${(p.size * price).toFixed(0)})` : ''}`;
  const d = liqDistance({ side: p.side, liqPrice: p.liqPrice, price });
  return `${p.exchange} ${p.leverage}x ${p.side.toUpperCase()} ${px(p.size)} ${esc(p.asset)} @ ${px(p.avgPrice)}, liq ${px(p.liqPrice)}${d !== null ? ` (${(d * 100).toFixed(1)}% away)` : ''}`;
}

function riskMessage(kind, r, positions) {
  const level = LEVEL_NAME[r.level];
  const head =
    kind === 'clear'
      ? `✅ <b>${esc(r.asset)} flush risk back to normal</b> (${r.score.toFixed(2)})`
      : `${r.level === 2 ? '🚨' : '⚠️'} <b>${esc(r.asset)} flush risk ${level}</b> (${r.score.toFixed(2)})${kind === 'repeat' ? ' — still' : ''}`;
  const lines = [head, `Price ${px(r.price)} (24h ${pct(r.price24hPct)})`, ...signalLines(r)];
  if (positions.length) lines.push('', '<b>Your positions</b>', ...positions.map((p) => positionLine(p, r.price)));
  if (r.coverage < 1) lines.push(`<i>Data coverage ${Math.round(r.coverage * 100)}% (${esc(r.missing.join(', ') || 'some signals')} unavailable)</i>`);
  return lines.join('\n');
}

function liqMessage(kind, p, price, distance) {
  if (kind === 'clear') return `✅ <b>${esc(p.asset)}</b> ${p.exchange} ${p.side}: liquidation distance back to ${(distance * 100).toFixed(1)}%`;
  const icon = distance <= config.liq.danger ? '🚨' : '⚠️';
  return `${icon} <b>${esc(p.asset)} liquidation ${(distance * 100).toFixed(1)}% away</b>\n${positionLine(p, price)}\nPrice ${px(price)}`;
}

function flushMessage(r) {
  const f = r.flush;
  return `🌊 <b>${esc(r.asset)} flush under way</b>: OI ${pct(f.oiChg)} and price ${pct(f.pxChg)} over ${f.hours}h. Leverage is being cleared out; deep ladder rungs may be filling.`;
}

// --- One cycle ----------------------------------------------------------------

async function analyse(asset) {
  const symbol = `${asset}USDT`;
  const bybit = await bybitMarket(symbol);
  const missing = [];
  const [binance, okx] = await Promise.all([
    binanceMarket(symbol).catch((err) => {
      missing.push('Binance');
      log(`${asset}: Binance unavailable: ${err.message}`);
      return null;
    }),
    okxMarket(asset).catch((err) => {
      missing.push('OKX');
      log(`${asset}: OKX unavailable: ${err.message}`);
      return null;
    }),
  ]);
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

let lastSnapshot = { at: null, results: [], positions: [], errors: [] };
const failStreak = {};

async function cycle(state) {
  const now = Date.now();
  const errors = [];

  const positions = [];
  for (const [name, fn] of [['Bybit', bybitPositions], ['MEXC', mexcPositions]]) {
    try {
      positions.push(...(await fn(env)));
    } catch (err) {
      errors.push(`${name} account: ${err.message}`);
    }
  }

  const assets = new Set(config.watchlist);
  for (const p of positions) if (!STABLES.has(p.asset)) assets.add(p.asset);

  const results = [];
  for (const asset of assets) {
    try {
      const r = await analyse(asset);
      failStreak[asset] = 0;
      // Drop dust spot balances that aren't watchlisted and have no leveraged position.
      const mine = positions.filter((p) => p.asset === asset);
      const meaningful = mine.filter((p) => p.kind === 'leveraged' || p.size * r.price >= config.minSpotUsd);
      if (!config.watchlist.includes(asset) && !meaningful.length) continue;
      r.positions = meaningful;
      results.push(r);
    } catch (err) {
      // A spot balance in a coin with no Bybit perp (exchange tokens, dust
      // from airdrops) can't be scored; that's expected, not a monitor fault.
      const important = config.watchlist.includes(asset) || positions.some((p) => p.asset === asset && p.kind === 'leveraged');
      if (!important) {
        log(`${asset}: skipped (spot holding, no market data: ${err.message})`);
        continue;
      }
      failStreak[asset] = (failStreak[asset] || 0) + 1;
      errors.push(`${asset}: ${err.message}`);
      // Three failed cycles in a row (~15 min) is worth a message: the
      // monitor is running but blind on this symbol.
      if (failStreak[asset] === 3) await notify(`⚙️ Monitor can't read market data for ${esc(asset)}: ${esc(err.message)}`);
    }
  }

  const liveKeys = new Set();
  for (const r of results) {
    // Flush risk.
    const riskKey = `risk:${r.asset}`;
    liveKeys.add(riskKey);
    const lvl = r.coverage >= config.minCoverage ? riskLevel(r.score, config.risk) : null;
    if (lvl) {
      const d = decide(state.alerts[riskKey], lvl.level, lvl.hold, now, config.repeatMs);
      state.alerts[riskKey] = d.state;
      r.level = d.state.level;
      if (d.send) await notify(riskMessage(d.send, r, r.positions));
    }

    // Flush under way.
    const flushKey = `flush:${r.asset}`;
    liveKeys.add(flushKey);
    if (r.flush.flushed && now - (state.alerts[flushKey]?.lastSentAt || 0) >= config.flushCooldownMs) {
      state.alerts[flushKey] = { lastSentAt: now };
      await notify(flushMessage(r));
    }

    // Liquidation distance, per leveraged position.
    for (const p of r.positions.filter((x) => x.kind === 'leveraged')) {
      const key = `liq:${p.exchange}:${p.asset}:${p.side}`;
      liveKeys.add(key);
      const distance = liqDistance({ side: p.side, liqPrice: p.liqPrice, price: r.price });
      const l = liqLevel(distance, config.liq);
      if (!l) continue;
      const d = decide(state.alerts[key], l.level, l.hold, now, config.repeatMs);
      state.alerts[key] = d.state;
      if (d.send) await notify(liqMessage(d.send, p, r.price, distance));
    }

    appendReading({
      t: new Date(now).toISOString(),
      asset: r.asset,
      price: r.price,
      score: r.score,
      coverage: r.coverage,
      level: r.level ?? null,
      funding8h: r.funding8h,
      oiUsd: r.oiUsd,
      flush: r.flush,
      signals: Object.fromEntries(Object.entries(r.signals).map(([k, s]) => [k, s])),
      positions: r.positions.length,
    });
  }

  // Forget alert state for symbols/positions no longer being watched (a
  // closed position shouldn't send an "all clear" days later), but keep
  // state for symbols that only errored this cycle.
  for (const key of Object.keys(state.alerts)) {
    const asset = key.split(':').length === 2 ? key.split(':')[1] : key.split(':')[2];
    if (!liveKeys.has(key) && !(failStreak[asset] > 0)) delete state.alerts[key];
  }

  lastSnapshot = { at: now, results, positions, errors };
  return errors;
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
  for (const r of lastSnapshot.results) {
    const score = Number.isFinite(r.score) ? r.score.toFixed(2) : 'n/a';
    lines.push('', `<b>${esc(r.asset)}</b> ${px(r.price)} · risk ${score} (${LEVEL_NAME[r.level || 0]})`, ...signalLines(r));
    for (const p of r.positions) lines.push(`  ↳ ${positionLine(p, r.price)}`);
  }
  if (lastSnapshot.errors.length) lines.push('', '<b>Errors</b>', ...lastSnapshot.errors.map((e) => `• ${esc(e)}`));
  return lines.join('\n');
}

async function onCommand(cmd) {
  if (cmd === '/status') return statusText();
  return [
    '<b>Commands</b>',
    '/status — latest score, signals and positions for every watched symbol',
    '',
    `Watching ${esc(config.watchlist.join(', '))} plus open positions, every ${config.pollMs / 60000} min.`,
    `Alerts at risk ≥ ${config.risk.elevated} (elevated) / ≥ ${config.risk.high} (high); liquidation within ${config.liq.warn * 100}% / ${config.liq.danger * 100}%.`,
  ].join('\n');
}

// --- Main loop -------------------------------------------------------------------

async function main() {
  const once = process.argv.includes('--once');
  const state = loadState();
  log(`starting: watchlist=${config.watchlist.join(',')} poll=${config.pollMs / 1000}s telegram=${telegram.enabled ? 'on' : 'off (stdout)'} data=${config.dataDir}`);

  if (once) {
    const errors = await cycle(state);
    saveState(state);
    console.log(statusText().replace(/<[^>]+>/g, ''));
    process.exit(errors.length ? 1 : 0);
  }

  telegram.listen(onCommand);
  let first = true;
  for (;;) {
    try {
      const errors = await cycle(state);
      saveState(state);
      if (errors.length) log(`cycle errors: ${errors.join(' | ')}`);
      await ping(errors.length ? '/fail' : '');
      if (first) {
        first = false;
        const syms = lastSnapshot.results.map((r) => r.asset).join(', ') || 'nothing yet';
        await notify(`🟢 Flush monitor started. Watching: ${esc(syms)}. Send /status any time.`);
      }
    } catch (err) {
      log(`cycle crashed: ${err.stack || err.message}`);
      await ping('/fail');
    }
    await new Promise((r) => setTimeout(r, config.pollMs));
  }
}

main();
