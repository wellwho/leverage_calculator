# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-page DCA ladder calculator that also places and tracks real orders on **Bybit or MEXC** (selectable per page), in two modes: **Leveraged** (isolated-margin USDT perps) and **Spot DCA**. Deployed on Vercel as static files plus serverless functions, with no framework and no build step. `README.md` is the detailed spec and change log for every behaviour; read the relevant section before changing a feature, and update it in the same change. Most "why" lives in long header comments at the top of each file.

`monitor/` is a separate, always-on flush-risk monitor (Telegram alerts) that runs on the user's NAS, not on Vercel. See its own section below.

## Commands

```sh
npm test                               # all app test files; also Vercel's build step (vercel.json buildCommand)
node test/backfill.test.js             # run a single test file (plain node, prints PASS/FAIL, exits 1 on failure)
vercel dev                             # local server: index.html + api/* functions
vercel --prod                          # deploy (aborts if npm test fails)

npm run test:monitor                   # monitor tests (deliberately NOT in npm test, see below)
WATCHLIST=CRV,BTC node monitor/index.js --once   # one live monitor cycle; prints to stdout when no Telegram token
```

There is no linter or formatter configured, and no test framework: tests are hand-derived fixtures with a local `check()` helper.

## Architecture

**Shared math runs in both browser and server.** `calc.js` (ladder sizing: `computePlan`, `computeSpotPlan`, both built on `buildLadderShape` so the two tabs trigger at identical prices) and `statusCalc.js` (P&L, projected liquidation, `scopeOrdersSinceOpeningMarketBuy`) are loaded by `index.html` via `<script>` tags *and* `require`d by `api/*` and tests, via a guarded `module.exports`. Keep them free of Node- and DOM-specific APIs. Both are exchange-agnostic.

**Vercel constraints shape the file layout:**
- Every file under `api/` becomes a serverless function, so shared helpers (`calc.js`, `statusCalc.js`, `bybitClient.js`, `mexcClient.js`) must live at the repo root.
- The Hobby plan caps a deployment at 12 functions. The app uses 9, so new behaviour goes into an existing file rather than a new one:
  - Exchange support is an `exchange` branch ("bybit" default, or "mexc") *inside* each `api/*.js` handler, not one file per exchange.
  - All Spot endpoints (`price`, `balance`, `execute`, `status`, `close`, `discover`, `kline`) are one function, `api/spot/[action].js`.
  - Extra GET modes ride on query params of existing endpoints (e.g. `api/status.js?discover=1`, `api/price.js?kline=1`).
- `vercel.json` pins the region to `sin1`, because Bybit and Binance block US IPs.

**Exchange plumbing.** `bybitClient.js` uses one V5 HMAC scheme for linear and spot. `mexcClient.js` needs two schemes: Futures (`ApiKey`/`Request-Time`/`Signature` headers, sorted params) and Spot v3 (`X-MEXC-APIKEY` + signed query string, with a required `Content-Type: application/json` header). Symbol formats are built in `index.html`: Bybit uses `CRVUSDT` everywhere; MEXC uses `CRV_USDT` for futures and `CRVUSDT` for spot. MEXC futures sizes are contract counts and must be converted to and from base-asset qty via `contractSize`.

**Account models differ.** Bybit's UTA shares ONE collateral pool between Spot and Leveraged, so both tabs show the same balance. MEXC has separate wallets.

**Order lifecycle conventions (both exchanges, both tabs):**
- Buy #1 is a market order; the other rungs are limit orders, placed sequentially about 550 ms apart.
- The last rung sweeps whatever balance or margin is actually free, instead of its planned amount.
- Leftover capital is reported only, never added back.
- Every order is tagged as the app's own (Bybit `orderLinkId` via `makeOrderLinkId`, MEXC `externalOid`/`newClientOrderId` via `makeAppOrderTag`), so status can report `openedByApp`.

**Position Status:**
- **Order scoping.** Status shows only orders since the most recent opening market buy (`scopeOrdersSinceOpeningMarketBuy`).
- **Bybit order history.** On Bybit, merge `GET /v5/order/realtime?openOnly=0` (open orders) with `bybitFindClosedOrderHistorySinceOpening` (walks `/v5/order/history` back in 7-day windows, max 60 days). Do **not** use `openOnly=1` as history: it's an ephemeral cache that Bybit wipes on restart.
- **Spot `hasPosition`.** It comes from the real wallet balance, not reconstructed from fills.
- **Choosing what to show on page load.** `index.html` checks all 4 exchange × tab combinations, then falls back to `discoverActiveSymbol()`. It ranks app-opened first, then Leveraged over Spot, then the last-used exchange.

**Auth and demo mode.**
- `middleware.mjs` (Node runtime, not Edge) gates everything behind an HMAC-signed cookie issued by `api/login.js`.
- `DEMO_MODE=true` bypasses login. `index.html` then simulates the account client-side in `localStorage`, still using `statusCalc.js` and real public prices.

## Flush monitor (`monitor/`)

A standalone Node service with no dependencies (it borrows only `bybitOk`/`bybitErrMsg` from `../bybitClient.js`). It watches for a **market-wide** long flush:
- BTC (`WATCHLIST`) is scored and alerted individually.
- A basket of 10 majors (`BASKET`) is combined into an OI-weighted Market score plus breadth. Basket coins never alert on their own.
- It reads public market data only. It deliberately has no account access and sends no position or liquidation alerts; the user manages position risk themselves, so don't add any back.

Files:
- `signals.js`: pure scoring. Percentile-ranks OI in coins, long build-up, OI-weighted funding and premium, etc. against each coin's ~3-week history; also `marketComposite`.
- `alerts.js`: pure send/repeat/clear hysteresis plus the breadth rule.
- `sources.js`: Bybit, Binance and OKX public endpoints.
- `index.js`: the loop, Telegram, state and readings files in `DATA_DIR`, and the healthchecks.io ping.

Config is env vars; `monitor/.env.example` lists them all.

- **Kept off Vercel.** `.vercelignore` excludes `monitor/`, which is why its test is not part of `npm test` (the Vercel build would fail to find it).
- **Production host.** It runs on the user's Synology DS418j (ARM, no Docker support) using Synology's Node.js package (`/usr/local/bin/node`, v22), not the Dockerfile:
  - Code is copied to `~/flushmon` (layout: `bybitClient.js`, `monitor/`), with `data/` and `logs/` alongside.
  - It is run by `monitor/nas/start.sh`, which supervises `run.sh`; `stop.sh` stops it. A DSM Task Scheduler boot-up task runs `start.sh` after reboots.
  - SSH alias `plexnas` (key auth as `wellwho`, no passwordless sudo). `scp` doesn't work (SFTP is off); pipe over `ssh` instead.
  - Deploy commands are in `monitor/README.md` ("Synology without Docker").
- The Docker files (`monitor/Dockerfile`, `monitor/docker-compose.yml`, root `.dockerignore`) are for hosts that do have Docker.

## Repo notes

- `.git` is a symlink to `.git.nosync`. The `.nosync` suffix keeps the git directory out of iCloud Documents sync.
- `.env*` is gitignored except `.env.example`. Real secrets live in Vercel env vars, and in `monitor/.env` (Telegram token only) on the NAS.
