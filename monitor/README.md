# Flush monitor

A small always-on service that watches derivatives data 24/7 and messages you on Telegram when a long flush looks increasingly likely, when a flush is under way, and when an open position is getting close to liquidation.

It runs in Docker on the NAS, separately from the Vercel app. It reuses the app's exchange clients (`../bybitClient.js`, `../mexcClient.js`), and it is **alert-only**: it never places, changes or closes orders.

> These signals are probabilistic. A high score means leverage and froth are high compared with recent weeks. That's a reason to look, not a guarantee that price will drop. Run it for a week or two and compare the alerts with what actually happened before trusting the thresholds (see "Calibrating" below).

## What it watches

Every `POLL_SECONDS` (default 5 min) it does the following for each symbol in `WATCHLIST` plus every symbol with an open Bybit/MEXC position or a meaningful spot balance:

1. Pulls ~3 weeks of hourly data from **Bybit, Binance and OKX** using free public endpoints that need no key.
2. Scores seven signals, each as a 0–100 rank against that symbol's own recent history. A rank adapts to each coin, where fixed thresholds wouldn't: "high OI" for BTC means something different than for CRV.
3. Combines them into one **flush risk score** (0–1).

The model follows the reading in Credible Crypto's [Velo Data tutorial](https://www.youtube.com/watch?v=rdaZDhciMxI). In it, the core panels are price, open interest, funding and perp premium, with volume delta as secondary:

| Signal | Weight | What it means |
|---|---|---|
| Open interest level | 0.25 | Aggregated OI **in coins** (not dollars: dollar OI rises with price even when nobody opens anything). More open leverage = more that can be liquidated. |
| Long build-up | 0.20 | OI rising *with* price over 24h = directional longs opening. OI rising on falling price is mostly shorts, so it counts half. OI falling into a rally is shorts covering and scores low. |
| Funding | 0.20 | OI-weighted across exchanges, normalised to 8h. 70% relative to its own history, 30% absolute (0.01%/8h = baseline, 0.05%/8h = hot), because positive funding stays normal for long stretches in bull markets. Zero or negative funding scores 0. |
| Perp premium | 0.20 | OI-weighted premium of perps over spot (Bybit + Binance). Leveraged buyers paying above fair value = froth. A spot premium scores 0. |
| Long/short crowding | 0.05 | Bybit account long share + Binance top-trader long share. |
| Taker selling | 0.05 | Binance 4h taker buy/sell volume ratio (the perp volume-delta idea; the video rates it the hardest to read). |
| Extension | 0.05 | Price vs its 7-day average. |

If a source is down or a symbol isn't listed somewhere, the score is computed from the signals that are available and reported with a *coverage* figure. Alerts only fire with at least `MIN_COVERAGE` (50%) of the weight available.

## Alerts

| Message | When |
|---|---|
| ⚠️ Flush risk **ELEVATED** / 🚨 **HIGH** | Score ≥ `RISK_ELEVATED` (0.70) / ≥ `RISK_HIGH` (0.80). Includes every signal's reading and your positions in that symbol. |
| ✅ Back to normal | Score drops below `RISK_CLEAR` (0.55). It must drop below this lower threshold, not just under 0.70, so a score hovering around the line can't spam you. |
| 🌊 Flush under way | OI down ≥ 8% **and** price down ≥ 4% within 4h: leverage is being cleared, so deep ladder rungs may be filling. At most once per 12h per symbol. |
| ⚠️ / 🚨 Liquidation close | A leveraged position's liquidation price is within `LIQ_WARN` (15%) / `LIQ_DANGER` (8%) of the current price. |
| ⚙️ Monitor can't read data | A watched symbol has failed three cycles in a row. |

An alert that stays active is repeated every `REPEAT_HOURS` (6h), and is otherwise silent. Send **/status** to the bot at any time for the latest full readout, or /help for the settings.

Every reading is also appended to `readings-YYYY-MM.jsonl` in the data volume.

## Setup

### 1. Telegram bot (2 minutes)

1. In Telegram, message **@BotFather** → `/newbot` → pick a name. It replies with a token: that's `TELEGRAM_BOT_TOKEN`.
2. Send your new bot any message (e.g. "hi").
3. Open `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser and copy `"chat":{"id": …}`: that's `TELEGRAM_CHAT_ID`.

The bot only answers that chat; anyone else who finds it is ignored.

### 2. Read-only exchange keys (optional, for position awareness)

Create **new** keys for the monitor. Don't reuse the Vercel app's trading keys: this box sits on your home network and only ever needs to read.

- **Bybit:** API → Create New Key → System-generated → permissions **Read-Only** (Contract → Orders & Positions read, Wallet read). No trade, no withdrawal. Since the NAS has a fixed home IP, you *can* bind the key to that IP, which is safer than the Vercel keys can be.
- **MEXC:** API Management → Create → **View/Read** only, and IP-bind it the same way.

Without keys the monitor still watches the `WATCHLIST`, it just doesn't see your positions or liquidation prices.

### 3. Heartbeat (recommended)

If the NAS loses power or internet, the monitor can't tell you, because it's down too. Create a free check at [healthchecks.io](https://healthchecks.io) with a 5-minute period and ~15-minute grace, connect its Telegram integration, and put its ping URL in `HEALTHCHECK_URL`. The monitor pings after every cycle (and `/fail` when a cycle has errors), so healthchecks.io tells you when it goes quiet.

### 4. Run it on the NAS

Needs Docker (Synology: **Container Manager**; QNAP: **Container Station**). Over SSH on the NAS:

```sh
git clone https://github.com/wellwho/leverage_calculator.git
cd leverage_calculator
git checkout feature/flush-monitor   # until it's merged
cp monitor/.env.example monitor/.env
nano monitor/.env                    # fill in tokens, keys, WATCHLIST
cd monitor
docker compose up -d --build
docker compose logs -f               # should show "starting" and a cycle; Telegram gets "Flush monitor started"
```

On Synology you can instead create a **Project** in Container Manager pointing at the `monitor/` folder; it picks up `docker-compose.yml` directly.

To update after code changes: `git pull && docker compose up -d --build` from `monitor/`.

`restart: unless-stopped` brings it back after a NAS reboot. State (alert history) and readings live in the `flushmon-data` Docker volume, so they survive rebuilds.

### Trying it locally first

No Docker or Telegram needed. Without a bot token, messages print to the terminal:

```sh
WATCHLIST=CRV,BTC node monitor/index.js --once
npm run test:monitor
```

The NAS (or any machine running this) must not have a US IP address: Bybit and Binance block US addresses. A home connection in Croatia is fine.

## Configuration

All settings are environment variables in `monitor/.env`; `.env.example` lists every one with its default. To change what the score emphasises, use `WEIGHTS`, e.g. `WEIGHTS=premium=0.3,crowding=0`. Omitted keys keep their defaults, and weights don't need to sum to 1.

## Calibrating

The default thresholds are a reasonable starting point, not tuned values. After a week or two:

1. Look at `readings-*.jsonl` (each line has the score, every sub-signal and price). From the NAS: `docker compose exec flushmon sh -c 'tail -n 50 /data/readings-*.jsonl'`.
2. Find the real flushes in that period (the 🌊 messages, or sharp drops on the chart) and check what the score was in the hours before each one.
3. Adjust `RISK_ELEVATED`/`RISK_HIGH` and `WEIGHTS` so the alerts would have fired ahead of the flushes that mattered, without firing constantly in between.

## Files

- `index.js`: main loop, config, Telegram messages, `/status`, state and readings files, heartbeat.
- `signals.js`: all scoring math (pure, tested).
- `alerts.js`: when to send / repeat / clear (pure, tested).
- `sources.js`: Bybit / Binance / OKX market data and Bybit / MEXC positions.
- `telegram.js`: send messages and receive commands.
- `test/monitor.test.js`: fixtures for `signals.js` and `alerts.js`.
