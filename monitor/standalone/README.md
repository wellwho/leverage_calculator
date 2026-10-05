# flush-monitor

**A 24/7 early-warning bot for crypto long flushes.** It watches leverage across BTC and the 10 largest perpetual-futures markets, and pings you on Telegram when the market looks crowded and frothy enough to flush.

- **Free data:** public endpoints from Bybit, Binance and OKX. No paid feeds.
- **No API keys, no account access.** It never sees your positions and never trades.
- **No dependencies:** plain Node.js (18+), about 1,000 lines. Runs on a NAS, a Raspberry Pi, a $4 VPS, or Docker.
- **Quiet by design:** it alerts only when something changes, sends reminders at most every 6 hours, and sends one all-clear when things calm down.

> **Not financial advice.** A high score means leverage and froth are high compared with recent weeks. That's a reason to look, not a prediction that price will drop. The default thresholds are a starting point; compare the alerts with what actually happens before you rely on them.

## What it watches

A **flush** is a long squeeze. Price dips, over-leveraged longs get liquidated, and their forced selling pushes price down further, liquidating more longs. Flushes need fuel: lots of open leverage, mostly on one side, paying up to stay in. The monitor measures that fuel.

Every 5 minutes, for BTC and each coin in the basket (BTC, ETH, SOL, XRP, DOGE, BNB, ADA, LINK, AVAX, SUI), it pulls ~3 weeks of hourly data and ranks seven signals 0–100 **against that coin's own recent history**. A rank adapts to each coin, where a fixed threshold wouldn't: "high open interest" means something different for BTC than for DOGE.

| Signal | Weight | Why it matters |
|---|---|---|
| **Open interest** (aggregated, in coins) | 25% | More open leverage = more that can be liquidated. Measured in coins, not dollars, because dollar OI rises with price even when nobody opens a new position. |
| **Long build-up** | 20% | OI rising *together with* price = new directional longs. OI falling into a rally is shorts covering, which isn't flush fuel. |
| **Funding** (OI-weighted) | 20% | Longs paying shorts to stay in. Judged mostly against its own history, because positive funding is normal in bull markets. |
| **Perp premium** (OI-weighted) | 20% | Perps trading above spot = leveraged buyers paying over fair value. |
| Long/short crowding | 5% | Share of accounts and top traders positioned long. |
| Taker selling | 5% | Market sell volume overtaking buys (4h). |
| Extension | 5% | Price stretched above its 7-day average. |

The core four (open interest, build-up, funding, premium) follow how [Credible Crypto reads Velo Data](https://www.youtube.com/watch?v=rdaZDhciMxI).

The basket is combined into one **Market score**, weighted by each coin's open interest so BTC and ETH dominate as they do in reality. It also tracks **breadth**: how many majors are elevated at once. Leverage stretched across most of the market is a stronger warning than one coin running hot.

## What you get on Telegram

| Message | When |
|---|---|
| ⚠️ **BTC** flush risk ELEVATED / 🚨 HIGH | BTC score ≥ 0.70 / ≥ 0.80, with every signal's reading |
| ⚠️ **Market** leverage ELEVATED / 🚨 HIGH | Market score ≥ 0.70 / ≥ 0.80, or ≥ 70% of the majors elevated at once, with a table of all 10 coins |
| 🌊 BTC flush under way | BTC open interest down ≥ 8% **and** price down ≥ 4% within 4h |
| ✅ Back to normal | Scores fall clearly back (below 0.55), so a score hovering near the line doesn't spam you |

Send `/status` to the bot any time for the full readout.

## Quick start (5 minutes)

**1. Create a Telegram bot.**
- Message [@BotFather](https://t.me/BotFather) → `/newbot`; it replies with your **token**.
- Open the link to your new bot and tap **START**.
- Visit `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy the number after `"chat":{"id":`. That's your **chat ID**.

**2. Configure and run.**

```sh
git clone https://github.com/wellwho/flush-monitor.git
cd flush-monitor
cp .env.example .env        # add TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID
npm test                    # optional: scoring and alert-rule tests
npm run once                # one live check, printed to the terminal
npm start                   # run continuously
```

**Or with Docker:** `docker compose up -d --build`.

**On a Synology NAS without Docker** (many models, such as ARM "j" models, can't run Container Manager):
1. Install **Node.js** from Package Center and clone the repo.
2. Start it with `sh nas/start.sh`. A supervisor restarts it if it exits, and its memory use is capped for small NAS units.
3. To start it after reboots: DSM → Control Panel → Task Scheduler → Create → Triggered Task → User-defined script, Event **Boot-up**, command `/bin/sh /path/to/flush-monitor/nas/start.sh`.

`nas/stop.sh` stops it.

**3. Recommended: a heartbeat.** If the machine loses power, the monitor can't tell you. Create a free [healthchecks.io](https://healthchecks.io) check (period 5 min, grace 15 min, Telegram integration) and put its ping URL in `HEALTHCHECK_URL`.

> Bybit and Binance block US IP addresses, so run it somewhere else (a home connection outside the US, or a VPS in Europe or Asia).

## Configuration

Everything is set in `.env`; [`.env.example`](.env.example) lists every option with its default. The main ones:
- `WATCHLIST`: coins with their own alerts.
- `BASKET`: the coins that make up the Market score.
- The `RISK_*` thresholds and the `BREADTH_*` rules.
- `WEIGHTS`: change what the score emphasises, e.g. `WEIGHTS=premium=0.3,crowding=0`.

Every reading is appended to `data/readings-YYYY-MM.jsonl` (about 1 MB a day), so after a week or two you can check what the scores were before real moves and tune the thresholds.

## How it's built

| File | Role |
|---|---|
| `signals.js` | All scoring math (pure functions, tested) |
| `alerts.js` | When to send, repeat and clear (pure, tested) |
| `sources.js` | Bybit, Binance and OKX public market data |
| `telegram.js` | Sending messages and handling `/status` |
| `index.js` | The loop, state, readings log and heartbeat |

## License

MIT. Use it, fork it, adapt it. And again: not financial advice.
