# Flush monitor

A small always-on service that watches **BTC and the crypto derivatives market as a whole** 24/7. It messages you on Telegram when a market-wide long flush looks increasingly likely, and when a BTC flush is under way.

It runs on the NAS, separately from the Vercel app. It reads **public market data only**: no exchange keys, and no knowledge of your positions (you manage position risk yourself). It is alert-only and never trades.

> These signals are probabilistic. A high score means leverage and froth are high compared with recent weeks. That's a reason to look, not a guarantee that price will drop. Compare the alerts with what actually happened for a week or two before trusting the thresholds (see "Calibrating" below).

## What it watches

Every `POLL_SECONDS` (default 5 min, one cycle takes ~40 s):

- **BTC** (`WATCHLIST`) gets a full flush-risk score and its own alerts.
- **The market**: a basket of the 10 largest perpetual-futures markets (`BASKET`, default BTC, ETH, SOL, XRP, DOGE, BNB, ADA, LINK, AVAX, SUI). Each coin is scored the same way as BTC, and the scores are combined into:
  - a **Market score**: the coins' scores weighted by open interest in USD, so BTC and ETH dominate as they do in reality;
  - **breadth**: how many of the majors are elevated at once. Leverage stretched across most of the market is a stronger warning than one coin running hot.

Individual altcoins never alert on their own.

### How a coin is scored

The monitor pulls ~3 weeks of hourly data from **Bybit, Binance and OKX** (free public endpoints). It ranks seven signals 0–100 against that coin's own recent history, so "high" adapts to each coin, then combines them into a 0–1 score.

The model follows the reading in Credible Crypto's [Velo Data tutorial](https://www.youtube.com/watch?v=rdaZDhciMxI). Its core panels are price, open interest, funding and perp premium, with volume delta as secondary:

| Signal | Weight | What it means |
|---|---|---|
| Open interest level | 0.25 | Aggregated OI **in coins** (not dollars: dollar OI rises with price even when nobody opens anything). More open leverage = more that can be liquidated. |
| Long build-up | 0.20 | OI rising *with* price over 24h = directional longs opening. OI rising on falling price is mostly shorts, so it counts half. OI falling into a rally is shorts covering and scores low. |
| Funding | 0.20 | OI-weighted across exchanges, normalised to 8h. 70% relative to its own history, 30% absolute (0.01%/8h = baseline, 0.05%/8h = hot), because positive funding stays normal for long stretches in bull markets. Zero or negative funding scores 0. |
| Perp premium | 0.20 | OI-weighted premium of perps over spot (Bybit + Binance). Leveraged buyers paying above fair value = froth. A spot premium scores 0. |
| Long/short crowding | 0.05 | Bybit account long share + Binance top-trader long share. |
| Taker selling | 0.05 | Binance 4h taker buy/sell volume ratio (the perp volume-delta idea; the video rates it the hardest to read). |
| Extension | 0.05 | Price vs its 7-day average. |

If an exchange is down for a coin, that coin's score uses the signals that are available and reports a *coverage* figure. Coins below `MIN_COVERAGE` (50%) are left out. The Market score needs at least `MIN_BASKET_SHARE` (60%) of the basket readable.

## Alerts

| Message | When |
|---|---|
| ⚠️ **BTC** flush risk ELEVATED / 🚨 HIGH | BTC score ≥ `RISK_ELEVATED` (0.70) / ≥ `RISK_HIGH` (0.80), with every signal's reading. |
| ⚠️ **Market** leverage ELEVATED / 🚨 HIGH | Market score ≥ 0.70 / ≥ 0.80, **or** at least `BREADTH_ELEVATED` (70%) of the majors elevated at once (that alone gives ELEVATED). Includes a table of every basket coin's score, OI and funding. |
| ✅ Back to normal | The score drops below `RISK_CLEAR` (0.55), and for the Market also breadth drops below `BREADTH_HOLD` (50%). The lower clear line stops a score hovering around 0.70 from spamming you. |
| 🌊 BTC flush under way | BTC OI down ≥ 8% **and** price down ≥ 4% within 4h: leverage is being cleared. At most once per 12h. |
| ⚙️ Monitor can't read data | BTC has failed three cycles in a row. |

An alert that stays active is repeated every `REPEAT_HOURS` (6h), and is otherwise silent. Send **/status** to the bot any time for the latest BTC readout and the basket table, or /help for the settings.

Every reading is also appended to `readings-YYYY-MM.jsonl` (about 1 MB a day): BTC in full detail, basket coins compactly, and one `MARKET` line per cycle.

## Setup

### 1. Telegram bot

1. In Telegram, message **@BotFather** → `/newbot` → pick a name. It replies with a token: that's `TELEGRAM_BOT_TOKEN`.
2. Open the link BotFather gives you (`t.me/<your_bot>`). Check the username carefully; a near-miss spelling is someone else's bot. Tap **START**.
3. Open `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser and copy `"chat":{"id": …}`: that's `TELEGRAM_CHAT_ID`. If it shows `"result":[]`, your message went to a different bot: check `…/getMe` shows the username you messaged.

The bot only answers that chat; anyone else who finds it is ignored.

### 2. Heartbeat (recommended)

If the NAS loses power or internet, the monitor can't tell you, because it's down too. Create a free check at [healthchecks.io](https://healthchecks.io) with a 5-minute period and ~15-minute grace, connect its Telegram integration, and put its ping URL in `HEALTHCHECK_URL`. The monitor pings after every cycle (and `/fail` when a cycle has errors).

### 3a. Synology without Docker (current production: DS418j)

Many Synology models, including ARM ones like the DS418j, can't run Container Manager. The monitor has no dependencies, so it runs directly on Synology's **Node.js** package (Package Center → Node.js v20 or v22).

Layout on the NAS, copied from the repo: `~/flushmon/bybitClient.js` and `~/flushmon/monitor/` (including `.env`). The scripts create `~/flushmon/data/` (state + readings) and `~/flushmon/logs/monitor.log`.

- `monitor/nas/start.sh` starts the monitor in the background unless it's already running. `run.sh` restarts it 30 s after any exit, keeps one rotated log, and caps the Node heap at 96 MB so it can't crowd out Plex.
- `monitor/nas/stop.sh` stops it.
- **Start after reboot:** DSM → Control Panel → Task Scheduler → Create → Triggered Task → User-defined script. User: your DSM user (not root), Event: **Boot-up**, Run command: `/bin/sh /var/services/homes/<user>/flushmon/monitor/nas/start.sh`.

Deploying from a Mac, with an SSH alias `plexnas` for the NAS. Use `tar` over SSH, not `scp`: macOS `scp` needs SFTP, which Synology has off by default.

```sh
COPYFILE_DISABLE=1 tar --no-xattrs -cf - --exclude monitor/.env --exclude monitor/data bybitClient.js monitor | ssh plexnas 'tar -xf - -C ~/flushmon'
ssh plexnas 'umask 077 && cat > ~/flushmon/monitor/.env' < monitor/.env      # only when .env changed
ssh plexnas 'sh ~/flushmon/monitor/nas/stop.sh; sh ~/flushmon/monitor/nas/start.sh'
ssh plexnas 'tail -f ~/flushmon/logs/monitor.log'
```

### 3b. Any host with Docker

```sh
cp monitor/.env.example monitor/.env   # fill in
cd monitor && docker compose up -d --build
docker compose logs -f
```

`restart: unless-stopped` brings it back after a reboot. State and readings live in the `flushmon-data` volume.

### Trying it locally

No Telegram is needed: without a bot token, messages print to the terminal.

```sh
node monitor/index.js --once
npm run test:monitor
```

Whatever machine runs it must not have a US IP address: Bybit and Binance block US addresses. A home connection in Croatia is fine.

## Configuration

All settings are environment variables in `monitor/.env`; `.env.example` lists every one with its default. To change what the score emphasises, use `WEIGHTS`, e.g. `WEIGHTS=premium=0.3,crowding=0`. Omitted keys keep their defaults, and weights don't need to sum to 1.

## Calibrating

The default thresholds are a reasonable starting point, not tuned values. After a week or two:

1. Pull the readings: `ssh plexnas 'cat ~/flushmon/data/readings-*.jsonl' > readings.jsonl`.
2. Find the real flushes in that period (the 🌊 messages, or sharp drops on the chart) and check what the BTC and `MARKET` scores were in the hours before each one.
3. Adjust `RISK_ELEVATED`/`RISK_HIGH`, the breadth settings and `WEIGHTS` so the alerts would have fired ahead of the flushes that mattered, without firing constantly in between.

## Files

- `index.js`: main loop, config, market basket, Telegram messages, `/status`, state and readings files, heartbeat.
- `signals.js`: all scoring math, including the market composite (pure, tested).
- `alerts.js`: when to send / repeat / clear, including the market breadth rule (pure, tested).
- `sources.js`: Bybit / Binance / OKX public market data.
- `telegram.js`: send messages and receive commands.
- `nas/`: start/stop/supervisor scripts for running without Docker.
- `test/monitor.test.js`: fixtures for `signals.js` and `alerts.js`.
