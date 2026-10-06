# Leveraged / Spot DCA Ladder Calculator

One-page calculator for sizing a laddered DCA position, in two modes switchable by tab, on **either Bybit or MEXC** — a second tab strip at the very top of the page switches which exchange the current tab talks to:

- **Leveraged** — isolated margin, long, on the selected exchange's linear/futures (USDT perpetual) market. Full manual control: you choose how much capital to involve, how many buys, how deep the ladder reaches, and which drawdown gets the biggest buy ("Peak buy drawdown"). 100% of the capital you commit is deployed as margin across the ladder — nothing is held back as a reserve. Liquidation price is shown per row as a real, informational read-out, not something the plan solves for.
- **Spot DCA** — the same laddered-buy math, no leverage, no margin, no liquidation, on the selected exchange's Spot market. Uses the exact same trigger prices as the Leveraged tab for the same inputs (and, by default, the same buy-size shape too), so the two are directly comparable — see "Spot DCA mode" below.

Live entry price is pulled from whichever exchange is currently selected (linear/futures ticker for the Leveraged tab, spot ticker for the Spot tab).

> **Runs on Bybit and MEXC in parallel, through one shared calculator engine.** This app originally traded on MEXC, was fully migrated to Bybit, and MEXC was later added back alongside it — `calc.js` (the ladder math), the UI, and every feature (Peak buy weight slider, All Funds mode, last-order sweep, app-order tagging, cross-exchange auto-landing on an open position) work identically on both; only the exchange-specific plumbing (`bybitClient.js` / `mexcClient.js`, and an `exchange` branch inside each `api/*.js` file) differs underneath. The two exchanges' account models differ in one important way worth knowing before you use this: Bybit's Unified Trading Account (UTA) shares ONE pool of collateral between Spot and Leveraged, where MEXC keeps genuinely separate Futures/Spot wallets (its original, and current, model). See "Pull available funds" below. Each API key only needs the credentials for its own exchange — you can run one exchange without ever configuring the other's env vars, and the Bybit/MEXC toggle for that exchange will just show its "not configured" error until you do.

> **Flush monitor (`monitor/`).** A separate, always-on service that runs on a NAS (not on Vercel). It watches BTC and a basket of the 10 largest perp markets for market-wide long-flush risk (open interest, funding, perp premium and positioning across Bybit, Binance and OKX), and alerts on Telegram. It uses public data only, never touches the trading account, and never trades. See [monitor/README.md](monitor/README.md).

## Files
- `index.html` — UI (inputs + results table), with a Bybit/MEXC exchange switch above a Leveraged/Spot tab switch. `exchange` (a page-level variable, remembered across reloads via `localStorage`) is threaded into every fetch call as a query param (GET) or body field (POST); every server endpoint reads it and dispatches to the matching exchange's logic. `toFuturesSymbol` builds the right symbol format per exchange (Bybit: `CRVUSDT` everywhere; MEXC: `CRV_USDT` for futures, `CRVUSDT` for spot).
- `calc.js` — calculation engine: `computePlan` (leveraged) and `computeSpotPlan` (spot), sharing a `buildLadderShape` helper so both tabs trigger at identical prices, with identically-shaped buy sizes (peaking at the "Peak buy drawdown" you set — -35% by default), for the same inputs. Both tabs commit 100% of the chosen capital across the ladder — no reserve held back on either one. Entirely exchange-agnostic — pure math, no network calls — so it needs zero changes to work identically on both exchanges.
- `statusCalc.js` — P&L / projected-liquidation math (shared by `api/status.js` server-side and, in demo mode, by `index.html` client-side); also exchange-agnostic.
- `demoSim.js` — the demo-mode trading simulator (fills, liquidation, fees, funding, trade history); pure functions loaded by `index.html` and tested by `test/demo-sim.test.js`. See "Demo mode" below.
- `api/config.js` — tells `index.html` whether this deployment is running in demo mode
- `bybitClient.js` — shared Bybit V5 signing/fetch helper used by every `api/*.js` file below (one auth scheme covers both linear and spot)
- `mexcClient.js` — shared MEXC signing/fetch helper, mirroring `bybitClient.js`'s shape. MEXC genuinely needs two different signing schemes (Futures: `ApiKey`/`Request-Time`/`Signature` headers; Spot v3: `X-MEXC-APIKEY` header + a signed query string) where Bybit uses one for everything — see the file's header comment.

### Leveraged (Bybit linear / MEXC futures — USDT perpetual)
- `api/price.js` — proxies the selected exchange's futures ticker (avoids browser CORS)
- `api/execute.js` — Bybit: sets leverage + isolated margin, then places the ladder's orders on Bybit linear. MEXC: converts each row's base-asset qty into MEXC's contract count (`vol`) via the symbol's `contractSize`, then places orders with `leverage`/`openType` as per-order fields (no separate setup calls needed). Both: leftover capital is reported back only, never added to the position; the last limit order sweeps live free margin instead of its planned amount; every order is tagged (`orderLinkId` on Bybit, `externalOid` on MEXC) so `api/status.js` can tell an app-opened position apart from a manually-opened one.
- `api/balance.js` — fetches your usable USDT balance from whichever exchange is selected
- `api/close.js` — behind the "Close Position" panic button, on either exchange
- `api/status.js` — reports whether a position is open and how the ladder's orders have filled, on either exchange

### Spot (Bybit spot / MEXC spot)
- `api/spot/[action].js` — one Vercel Function handling all five Spot endpoints (`price`, `balance`, `execute`, `status`, `close`) at `/api/spot/price`, `/api/spot/balance`, etc., dispatching on the `action` URL segment, and further dispatching on `exchange` inside each action. Kept as a single file rather than one-per-action (or one-per-exchange) because Vercel's Hobby plan caps a deployment at 12 serverless functions — this app stays at 9 total (`login`/`logout`/`config`/`price`/`balance`/`execute`/`close`/`status` + this one) by branching on `exchange` inside existing files instead of adding new ones per exchange. See the file's own header comment for how each action's two branches map back to their original standalone versions.

### Auth
- `login.html` — sign-in page
- `api/login.js` / `api/logout.js` — issue/clear the session cookie
- `middleware.js` — gates every route behind that session cookie (bypassed entirely in demo mode, see below)

## Deploy to Vercel — detailed walkthrough

You need: a Mac, ~10 minutes, and an email address to sign up for Vercel (free).

### 1. Open Terminal
Press `Cmd + Space`, type `Terminal`, press Enter. A window with a text prompt opens.

### 2. Check if Node.js is installed
Type:
```
node -v
```
Press Enter.
- If you see something like `v18.19.0` (any v18 or higher) → skip to step 4.
- If you see `command not found: node` → continue to step 3.

### 3. Install Node.js (only if step 2 failed)
1. In your browser, go to https://nodejs.org
2. Click the button that says **LTS** to download it.
3. Open the downloaded file (in Downloads).
4. Click through the installer: Continue → Continue → Agree → Install. Enter your Mac password if asked. Click Close.
5. Go back to Terminal, close it completely (`Cmd + Q`), reopen it, and repeat step 2 to confirm `node -v` now shows a version.

### 4. Install the Vercel command-line tool
In Terminal, type:
```
npm install -g vercel
```
Press Enter. Wait until the prompt (`$`) returns — that means it finished. If you see "permission denied," instead run:
```
sudo npm install -g vercel
```
and enter your Mac password when asked (nothing will appear as you type it — that's normal).

### 5. Move into the calculator folder
Copy and paste this exactly, then press Enter:
```
cd "/Users/matkostankovic/Documents/Claude/Projects/CRV leverage plan/calculator"
```
No output means it worked. If you see "No such file or directory," let me know and I'll fix the path.

### 6. Start the deployment
Type:
```
vercel
```
Press Enter.

### 7. Log in (first time only)
Terminal will show a list of login options (GitHub, GitLab, Bitbucket, Email). Use the arrow keys to highlight **Continue with Email**, press Enter.
1. Type your email address, press Enter.
2. Terminal will say it sent you an email — go check your inbox.
3. Open the email from Vercel and click the confirmation link/button inside it.
4. Switch back to Terminal — it will continue automatically once you've clicked the link.

### 8. Answer the setup questions
Terminal will ask several questions one at a time. For each, just press Enter to accept the default shown in brackets, except where noted:
- `Set up and deploy "...calculator"?` → type `y`, press Enter
- `Which scope do you want to deploy to?` → press Enter (your personal account)
- `Link to existing project?` → type `N`, press Enter
- `What's your project's name?` → press Enter to accept the default, or type your own (e.g. `crv-calculator`)
- `In which directory is your code located?` → press Enter (default `./`)
- Any build-settings question → press Enter to accept the default

### 9. Get your link
After a short upload, Terminal prints a URL like:
```
https://crv-calculator-xxxx.vercel.app
```
Copy it into your browser. Click "Get price" to confirm it pulls a live Bybit price, then "Calculate plan" to confirm the table appears.

### 10. Make the link permanent
That first URL is a "preview" link. To get the permanent one, type:
```
vercel --prod
```
Press Enter and wait. It prints your permanent URL, e.g. `https://crv-calculator.vercel.app` — this is the one to bookmark/share.

### 11. (Optional) Use your own domain
If you own a domain name: in your browser go to vercel.com, log in, open this project, go to **Settings → Domains**, type your domain, and follow the DNS instructions shown on screen.

## Execute plan (auto-place orders, Bybit or MEXC)

The "Execute" card at the bottom of the calculated plan places every "Limit Buy" row as an isolated-margin, open-long order on whichever exchange's futures/linear market the top toggle currently selects, via `api/execute.js`. On **Bybit**, it first sets the symbol's leverage (`POST /v5/position/set-leverage`) and switches it to isolated margin (`POST /v5/position/switch-isolated`) — one-time-per-run settings calls. On **MEXC**, leverage and margin type (`openType: 1`, isolated) are sent as fields on every individual order instead — MEXC has no separate settings call — and each row's base-asset qty is converted into MEXC's contract count via the symbol's `contractSize` (`GET https://contract.mexc.com/api/v1/contract/detail`).

The button itself is labelled **"Execute plan on Bybit"** or **"Execute plan on MEXC"** to match the exchange toggle at the top of the page, and it re-labels the moment you flip that toggle — as does the Position Status orders note that quotes it. (Both are re-rendered by `applyModeCopy()`, which `setExchange()` already calls; the note is re-rendered from a pristine Bybit-first template captured at page load, since the `exchangeCopy()` text swap is one-directional.) The confirmation dialog that appears after clicking has always named the real target exchange, and the request itself has always carried the selected `exchange` — the button's own text was the only thing stuck on the HTML's Bybit-first default.

Every dollar of the capital you commit is deployed directly as margin across the ladder's buys — there's no reserve held back for this app to manage, on either exchange. Both exchanges' own Auto-Margin Replenishment feature (Bybit: "AMR", enable it on the position in the Bybit app; MEXC: "Auto-Margin", enable it in the MEXC app) is available as a general safety net if you want one, but this app doesn't design the plan around it or assume it'll be there — liquidation is shown per row purely as a real, informational figure computed from margin actually committed so far, never a target the plan solves for.

### One-time setup — Bybit

1. **Create a Bybit API key**: Bybit website → profile icon → API → Create New Key ("System-generated API Keys", HMAC). Your account needs a Unified Trading Account (UTA) — the account type Bybit issues by default today.
   - Permissions: enable **Contract → Orders & Positions** (execution + closing + the "Get balance"/"Close Position" lookups) and **Spot → Trade** (needed by the Spot tab below) — one key covers both tabs.
   - IP binding: Vercel serverless functions don't have a fixed outbound IP, so leave the key **unbound** (no IP restriction), unless you've set up a static-IP add-on. An unbound key is more sensitive if it ever leaks — keep the "Withdrawal" permission off, since this app never needs it.
2. **Add the key to Vercel** (Project → Settings → Environment Variables):
   - `BYBIT_API_KEY` = your API Key
   - `BYBIT_API_SECRET` = your API Secret
   - Redeploy (`vercel --prod`) after adding them — env vars only take effect on the next deploy.
3. That's it for the key — leverage and isolated margin get set automatically by `api/execute.js` on every run. Optionally, once a position is open, you can also **enable Auto-Margin Replenishment on the position**, in the Bybit app (Positions tab → toggle AMR), as a general safety net — this app doesn't design the plan around it or assume it's there.
4. The key never touches the browser. `Execute plan` (Bybit selected) calls `/api/execute` with `exchange: "bybit"`, which reads the key server-side and signs each request.

### One-time setup — MEXC

1. **Create a MEXC API key**: MEXC website → profile icon → API Management → Create API. HMAC key, same as Bybit.
   - Permissions: enable **Futures Trade** (execution, closing, balance/position lookups) and **Spot Trade** (needed by the Spot tab) — one key covers both tabs, same as the Bybit key.
   - IP binding: leave unbound for the same reason as Bybit above (Vercel has no fixed outbound IP) unless you've set up a static-IP proxy. Keep withdrawal permissions off.
2. **Add the key to Vercel** (Project → Settings → Environment Variables):
   - `MEXC_API_KEY` = your API Key
   - `MEXC_API_SECRET` = your API Secret
   - Redeploy (`vercel --prod`) after adding them.
3. Leverage and isolated margin (`openType: 1`) are sent per-order automatically by `api/execute.js`'s MEXC branch — nothing to toggle beforehand. Optionally, once a position is open, you can enable **Auto-Margin** on it directly in the MEXC app as a general safety net.
4. The key never touches the browser. `Execute plan` (MEXC selected) calls `/api/execute` with `exchange: "mexc"`, which reads the key server-side and signs each request using MEXC's futures signing scheme (see `mexcClient.js`).

You only need to configure the exchange(s) you actually intend to trade on — an unconfigured exchange's key check just returns a clear "not set" error when you try to use it, and doesn't affect the other exchange at all.

### What it does per click
- **Bybit:** sets leverage and isolated margin for the symbol before placing anything; a failure to switch to isolated margin is surfaced as a warning rather than aborting the run (some Bybit account configurations — Portfolio Margin mode — don't support a per-symbol isolated toggle; check the position's margin mode in the Bybit app if you see that warning). **MEXC:** leverage and `openType: 1` (isolated) ride along on every individual order instead — no separate settings call, so no equivalent warning case.
- Rounds each buy's quantity to what the exchange will accept: Bybit's linear orders are already denominated directly in the base asset, so this just rounds to the symbol's `qtyStep` (from `GET /v5/market/instruments-info`); MEXC trades fixed-size contracts, so the base-asset qty is first converted to MEXC's `vol` (contract count) via `qty ÷ contractSize`, then rounded to the symbol's `volScale`.
- Buy #1 is placed as a **market** order (fills immediately at the live price); every other buy is a **limit** order resting at its ladder price, on both exchanges. This is a display/execution-layer choice only — `calc.js`'s sizing math is unaffected.
- Places each order sequentially with ~550ms spacing on either exchange (conservative pacing — both exchanges' own per-key rate limits are generally more generous than this).
- Shows a per-order result (order ID or the specific exchange error) once all orders have been submitted.
- **Reports leftover capital, informationally only, on both exchanges.** After every order has been placed, `api/execute.js` sums up what was *actually* committed — using each order's real, exchange-rounded price × quantity, not the plan's theoretical numbers, since rounding means the orders that land rarely cost exactly what the plan predicted — and subtracts that from the "Total capital" you entered. The difference (`leftoverCapital`) is just displayed as a note; it's rounding/precision drift only, not a deliberate reserve, and it stays in your available balance.
- **Last-order sweep, on both exchanges.** The final rung of the ladder (the deepest limit order) spends whatever margin is actually free in your account right before it's placed, instead of its own pre-planned quantity — caught live with real money on Bybit: the planned last order kept failing to place while a few dollars sat unused, because cumulative price/qty rounding drift across every earlier order almost always means the true remaining balance doesn't match that row's planned number exactly. This means the last order can never fail for insufficient margin (it only ever asks for exactly what's free) and nothing gets left idle by a few dollars of drift. If the true remaining margin can't even cover the exchange's minimum order size, that row is skipped with a clear reason instead of being submitted and rejected. Same idea, independently, as the Spot tab's last-order sweep below.
- **Tags every order it places**, on both exchanges, with a client-supplied order id (Bybit's `orderLinkId` via `bybitClient.js`'s `makeOrderLinkId`; MEXC's `externalOid` via `mexcClient.js`'s `makeAppOrderTag`) so the app can later tell "opened through this calculator" apart from "opened manually on the exchange directly" — see the Position Status section's note on tab-selection priority for why.
- Asks for a browser confirmation before sending anything — no orders go out on an accidental click.

## Pull available funds

The "Get balance" button next to Available balance calls `api/balance.js`, which signs a request to whichever exchange is currently selected: Bybit's `Get Wallet Balance` endpoint (`accountType=UNIFIED`) for USDT, or MEXC's futures asset endpoint. Requires that exchange's key pair (`BYBIT_API_KEY`/`BYBIT_API_SECRET` or `MEXC_API_KEY`/`MEXC_API_SECRET`) as env vars, plus the key's account-read permission.

**Important, and different per exchange:** MEXC keeps genuinely separate Futures and Spot wallets, so on MEXC this figure and the Spot tab's balance are two independent numbers — same as this app originally assumed, and still true today. Bybit's Unified Trading Account, by contrast, merges spot holdings and derivatives margin into ONE pool — opening a leveraged position and buying spot both draw from, and are capped by, the same `totalAvailableBalance` — so on Bybit the Leveraged and Spot tabs will usually show the same number. That's expected on Bybit, not a bug — see `api/balance.js`'s header comment. Switching the exchange toggle switches which of these two account models you're looking at.

## Capital to deploy: All Funds vs Custom Amount

At the top of the Inputs card, a toggle next to "Capital to deploy" controls where the plan's `capital` number comes from — same behavior on both tabs:

- **Custom Amount** (default, so nobody deploys their entire balance just by opening the app) — a plain number you type in yourself. The field auto-fills from your live balance on page load / tab switch / Reset, same as clicking "Get balance", but you're free to edit it down to whatever you actually want to commit.
- **All Funds** — the field is disabled (there's nothing to type; it's always overwritten right before use) and locked to 100% of your current balance for the active tab (Spot USDT free balance, or Futures available balance). Both Calculate and Execute re-fetch that balance fresh immediately before using it — not just whatever was on screen when you last clicked Calculate — so "All Funds" always means the true live figure, even if some time passed between Calculate and Execute. If the fresh balance can't be read, or comes back too small to build a valid plan, Execute aborts with a clear message rather than silently running against stale numbers.

## Peak buy weight (where the ladder's weight sits)

Both tabs let you set which drawdown gets the biggest buy — but this is set as a **percentage of the target drawdown itself**, not an absolute drawdown from entry. A "Peak buy weight" of 50% always means "halfway down this ladder's own depth," whatever that depth is: on a -70% target, that lands the peak at -35%; on a -40% target, the *same* 50% setting lands it at -20%, not -50%. (An absolute value doesn't make sense here — you can't put the biggest buy at a -50% drawdown on a ladder that only reaches -40% in the first place; earlier versions of this control let you try, and it just silently clamped to the last buy.)

Drag the slider (or type an exact percentage in the field beside it) to set this. Buy sizes grow geometrically (×1.26 per step) up to the rung nearest your chosen weight position, then shrink geometrically beyond it — so early buys (price hasn't fallen far) are small, the buy(s) right around your chosen position are the biggest, and buys beyond it taper back down. Default is 50% (of whatever the target drawdown is currently set to). If the resulting absolute position falls beyond the ladder's own reach for any reason, it clamps to the last buy and sizing just grows the whole way instead, with no taper. Moving the slider toward "Shallow" concentrates capital in early buys; moving it toward "Deep" concentrates capital further down the ladder. A line below the slider always states the plain-language translation — e.g. "50% of the way to your -70% target = -35.0% drawdown from entry" — on both tabs.

### Leveraged tab: the slider's track shows whether this weight reaches the full ladder

Since 100% of capital is committed as margin at your chosen leverage (no reserve), there's a fixed identity buried in the math: every row's liquidation price is always `avgEntry × (1 + MMR − 1/leverage)` — a **constant percentage below the current average entry**, at every row, no matter how the buy weights are shaped. At 5x leverage with 1% MMR, for example, that's a fixed ~19% cushion below wherever your average entry currently sits. Peak buy weight doesn't change that percentage; what it changes is how fast the average entry itself falls to keep pace with the falling ladder price — which is what actually determines whether the ladder can reach its full target drawdown before that fixed cushion runs out.

On the Leveraged tab, the slider's own track color-codes this live: it scans every achievable weight position (1%-100% of the target drawdown) for the currently-entered leverage / MMR / number of buys / target drawdown, and shows which ones let the ladder actually reach the full target before liquidation:

- **Green** — this weight position reaches the full target drawdown; a status line confirms it and states the fixed cushion percentage.
- **Amber** — this position is already the best any position can achieve given the current leverage/buys/target — the shortfall is structural (the ladder's own price spacing outruns even a zero-lag average entry at some row), not something re-weighting can fix. The note states the deepest achievable depth and suggests more buys, lower leverage, or a shallower target.
- **Red** — this position underperforms what's actually achievable; the note names the shallowest position that reaches the best available depth (or the full target, if reachable), in both relative and absolute terms.

The slider's thumb sits exactly where your current setting falls on that colored track, so dragging it shows the color change directly under your hand — no separate marker or bar. It recomputes live as you edit leverage, MMR, number of buys, target drawdown, or the slider itself — no need to click Calculate first. This never depends on entry price or capital: both cancel out of the underlying ratio (see `calc.js`'s `ladderSurvival`/`scanPeakFeasibilityRelative` header comments for the derivation), so the indicator works instantly even before a live price/balance has loaded. On the Spot tab the track just shows a plain neutral fill, since there's no liquidation to evaluate.

Right below that, a line reads "Liquidation price at this weight: $X.XXXX" — the plan's final row's liquidation price in real dollar terms, using the Entry price field you've actually typed in (a dollar figure needs the real price to mean anything, unlike the percentage math above). It updates live as you move the slider or edit Entry/Leverage/MMR/Number of buys/Target drawdown, same as everything else on this control — no need to click Calculate. It's the same number the results table's "Final liquidation ($)" stat shows after you do click Calculate, just visible instantly while you're still dragging the slider. Capital doesn't affect it (same cancellation as the feasibility math), so it works before a balance has loaded too. Hidden on the Spot tab, since there's no liquidation there.

## Close Position (panic button)

The red "CLOSE POSITION" button in the Danger Zone card at the bottom calls `api/close.js` for the asset currently entered in the Asset field, and:

1. Cancels every resting order on that symbol first (`POST /v5/order/cancel-all`, symbol-scoped), so nothing already on the book can fill while — or after — the position is being closed.
2. Looks up the open position on that symbol (`GET /v5/position/list`, filtered by symbol) and flash-closes it at market (opposite side, `reduceOnly: true`) — no reference price needed at all, since a Bybit Market order simply omits `price`.

This is deliberately scoped to **one symbol only**, so this app never touches any other position on your account.

Asks for a browser confirmation before doing anything, same as Execute.

## Position Status (two app states)

The page checks `api/status.js` for the current Asset on load, after fetching a price, and after Execute/Close — and switches between two states:

- **No open position:** the ordinary plan calculator — inputs, Calculate, the theoretical ladder, and the "Execute plan on Bybit"/"Execute plan on MEXC" card.
- **Position open:** a "Position Status" card replaces the Execute card, showing avg entry / size / leverage, unrealized P&L in $ and %, and a projected liquidation price — plus the orders **since your last Execute** — not the pair's full trading history — each row labeled Filled/Resting/Canceled/Invalid so it's clear how deep this run's ladder actually went. Execute is hidden in this state so a second ladder can't get deployed on top of a live one; Calculate above still works for previewing numbers only. A "Refresh status" button re-checks on demand.

  **On page load specifically**, the app checks BOTH tabs on BOTH exchanges (four combos total) for an open position on the current Asset symbol before deciding what to show. If none of the four have anything open for that symbol, it does NOT immediately fall back to the default calculator — the Symbol field's value on a fresh load is just a static default ("CRV"), which may have nothing to do with what's actually open on your account. Instead it calls `discoverActiveSymbol()`, a cheap fallback that scans every symbol with an open Leveraged position or a nonzero Spot balance across both exchanges (via `GET /api/status?discover=1` and `GET /api/spot/discover` — one lightweight API call per exchange per mode, no per-symbol order-history walk), ranks candidates the same way as the main scoring below (Leveraged beats Spot, most-recently-touched wins as the tiebreak), sets the Symbol field to the winner, and re-runs the SAME 4-combo check for that symbol. Only if that also finds nothing does it fall through to the ordinary default calculator. This two-step design means the expensive, fully-scored (including `openedByApp`) check only ever runs against a symbol likely to actually have something open — added after a real account with an active Bybit Leveraged position on a symbol other than the Symbol field's default landed on the empty default calculator instead. This is `selectInitialTabByPosition()`/`discoverActiveSymbol()` in `index.html`, and only runs at load — switching tabs, exchange, or symbol by hand afterward still works exactly as before.

  **Priority order favors positions this app itself opened, then Leveraged over Spot, then your last-used exchange.** Every order the app places, on either exchange, is tagged with a client-supplied order id (Bybit's `orderLinkId` via `bybitClient.js`'s `makeOrderLinkId`/`isAppOrderLinkId`; MEXC's `externalOid`/`newClientOrderId` via `mexcClient.js`'s `makeAppOrderTag`/`isAppOrderTag`) that the exchange stores and echoes back but never interprets. `api/status.js` and `api/spot/[action].js`'s status action both check whether the market buy that opened the current run carries that tag, and report it back as `openedByApp`. This was added because the account has a pre-existing Bybit Leveraged position (HBAR) that was opened manually on Bybit directly, outside this app — without the tag, that position would have unconditionally won the Leveraged-always-wins rule below and hidden an actual app-managed ladder sitting on the other tab. Each of the four (tab × exchange) combos is scored — lower wins — on: app-opened beats manually-opened (dominant factor), Leveraged beats Spot (tiebreak), your last-used exchange beats the other one (finest tiebreak, only relevant when equally-ranked positions exist on both exchanges at once). So an app-managed ladder on any tab/exchange always outranks a manually-opened position, Leveraged wins the tiebreak among equally app-opened-or-not candidates, and your last-used exchange only matters as the final tiebreaker.

  Scoping to "since the last Execute" — **Bybit:** `api/status.js` (Leveraged) and `api/spot/[action].js`'s `handleStatus` (Spot) both fire `GET /v5/order/realtime` with `openOnly: 0` (currently open orders, real-time) in parallel with `bybitFindClosedOrderHistorySinceOpening` (`bybitClient.js`) — which walks `GET /v5/order/history`, Bybit's actual durable order history (2 years retention), backward from now in 7-day windows (Bybit's own per-call span limit) until it finds the market buy that opened the run, up to a 60-day cap — and merges both lists. This replaced an earlier version that used `openOnly: 1` alone (or, for the Leveraged tab after that first fix, merged with `openOnly: 0`) on the assumption that it was a "closed orders" *history* endpoint. It isn't: `openOnly: 1` reads from an ephemeral cache of up to 500 recently-closed orders that Bybit's own docs say gets wiped whenever their service restarts, independent of how old the order is — so a position's opening market buy (or a filled/canceled order) could vanish from Position Status at any time, not just once it aged out. Caught live twice: first as a real Leveraged run's resting limit orders not showing up at all (fixed by adding the `openOnly: 0` merge), then again as "Could not find the market buy that started this run" on a real position only ~2 days old even with that fix in place (root-caused to the ephemeral-cache behavior above, and fixed by switching the closed-order source to `order/history`). The Spot tab's Bybit branch had the same underlying bug in a worse form — it used `openOnly: 1` alone, with no `openOnly: 0` merge at all, so every still-resting Spot limit order was invisible to it — fixed the same way, in the same pass. **MEXC** has no equivalent split to work around — its `history_orders` endpoint returns orders of every status for a symbol in one call. Either way, the merged/returned list then finds the most recent open-long **market** order (that's always Buy #1 in this app's ladder, picked via `statusCalc.js`'s shared `scopeOrdersSinceOpeningMarketBuy`, used by both tabs on both exchanges) and only returns orders from that timestamp onward, so a prior, already-closed run on the same symbol won't show up mixed in. A `orderDebug` field in the response (surfaced in the UI under the orders table when present) reports how many open orders were seen, how many closed orders came from history, and how many 7-day windows had to be searched — useful for confirming this live the same way the original `openOnly` bug was diagnosed.

  **Unrealized P&L ($ and %):** computed from the position's own `avgPrice` against a live ticker price — no contract-size conversion needed, since Bybit's position `size` is already in base-asset units. The % is P&L divided by the position's current `positionIM` (initial margin) — Bybit's own live figure for margin actually committed to the position right now, which already reflects any top-up, whether added manually or by Bybit's own Auto-Margin Replenishment feature.

  **"Liq. if fully filled" price:** deliberately *not* Bybit's own `liqPrice`, which only reflects what has actually filled so far. Instead, starting from the position's real, current `positionIM`, avg entry, and size, this walks forward through every still-**resting** order in the scoped list, accumulates the margin each would add (`qty × price ÷ leverage`, using the position's real leverage) and the resulting weighted avg entry, then reapplies the same isolated-margin liquidation formula used elsewhere in this app (`Avg Entry × (1 + MMR) − Total Margin ÷ Quantity`, MMR from `GET /v5/market/risk-limit`'s lowest tier). Because it starts from live `positionIM`, any margin top-up — including one made automatically by Bybit's AMR feature — is picked up automatically on the next refresh.

  **"Avg entry if filled" column (per order row):** a running cumulative average, computed client-side in `index.html` straight from the scoped orders list — since it's already sorted highest-price-first, which is exactly fill order for a DCA-down ladder, walking down it and accumulating `qty × price` (using each order's real `dealVol`/`dealAvgPrice` once filled, or its resting `vol`/`price` before that) reconstructs "what the position average would be if this row, and everything above it, has filled" at every rung. Canceled/invalid orders are skipped — they never will fill, so they don't contribute — and show as "—".

  **Read-only 4h chart, at the bottom of the card, on both tabs:** a fixed candlestick chart of the current symbol at a 4-hour interval, showing the last ~10 days (`CHART_CANDLE_LIMIT = 60` in `index.html` — 60 four-hour candles) — [TradingView Lightweight Charts](https://tradingview.github.io/lightweight-charts/), loaded from a CDN (`https://cdn.jsdelivr.net/npm/lightweight-charts@4.1.3/...`), no other dependency added. Deliberately not interactive beyond hovering the crosshair to read an OHLC value — pan/scroll/zoom are disabled (`handleScroll`/`handleScale: false`), there's no timeframe picker, and nothing on it is editable — it's a picture of the deployed plan, not another input surface, per how it was asked for. Drawn as horizontal price lines on top of the candles: avg entry (solid teal), current price (dashed white), projected liquidation (dashed red, Leveraged only), then every order in the same "since last Execute" scoped list the table above uses — solid green for Filled, dashed amber for still-Resting/Pending, dotted gray for Canceled/Invalid (shown for context, same reasoning as the table's "—" rows). The candlestick series carries a custom `autoscaleInfoProvider` so the visible vertical range is fit to the candles' own high/low (+8% padding) only — by default this library also stretches the range to fit every price LINE, which dragged the whole chart down to the liquidation price (often 40–50% below anything relevant) and squeezed the actual price action/order band into a sliver at the top; now liq (and anything else far outside the candle range) simply renders off the bottom of this fixed, non-scrollable chart instead of compressing everything else. Candles come from two new lightweight, public, no-auth endpoints mirroring the existing price proxies: `GET /api/price?...&kline=1` (Leveraged, `handleKline` in `api/price.js`) and `GET /api/spot/kline?...` (Spot, `handleKline` in `api/spot/[action].js`) — Bybit via `GET /v5/market/kline` (`category: linear` or `spot`, `interval: "240"`), MEXC via `getFuturesKline`/`getSpotKline` in `mexcClient.js` (MEXC Futures' kline is a parallel-array response, MEXC Spot's is array-of-arrays — both normalized into the same `{time, open, high, low, close}[]` shape Bybit's already ascending-sorted response uses). Fetches once per Position Status refresh (page load / "Refresh status" / after Execute) — no streaming/websocket, matching the rest of this card's cadence. `renderStatusChart()` in `index.html` does its own fetch and never throws out of `renderPositionStatus()` — a slow candle fetch, a symbol with no candle history yet, or the CDN itself being blocked/unreachable each show a small note under the chart instead of the numbers/table above it being affected in any way.

Requires that exchange's key pair — `BYBIT_API_KEY`/`BYBIT_API_SECRET` or `MEXC_API_KEY`/`MEXC_API_SECRET` — same as the rest of that exchange's integration.

## Spot DCA mode

The **Spot DCA** tab runs the same laddered-buy idea with no leverage, no margin, and no liquidation, executing on whichever exchange's Spot market is currently selected. `computeSpotPlan` (in `calc.js`) shares its trigger-price math and its sweet-spot-peaked buy-size shape with the leveraged `computePlan` via a common `buildLadderShape` helper, so entering the same entry price / buy count / drawdown / peak on either tab produces buys at identical prices and identical relative sizes — leverage applied to quantity is the only thing that differs between the two now; both commit 100% of capital, and both compute an `E1 = capital / K1` scale factor the same way. None of this depends on which exchange is selected.

**Last-order sweep, on both exchanges:** the final rung of a Spot ladder spends whatever USDT is actually free in your account at the moment it executes, rather than its own planned dollar amount — this avoids the last order failing to place because an earlier market buy consumed slightly more than planned, leaving too little for the last rung's exact planned size. The Leveraged tab's last buy does the same thing now (see "Execute plan" above) — both shipped independently after the same real-money symptom (the last order failing while a few dollars sat unused) showed up on each tab in turn.

### One-time setup

The Spot tab reuses the **same** key pair as the Leveraged tab on whichever exchange is selected — `BYBIT_API_KEY`/`BYBIT_API_SECRET` for Bybit, `MEXC_API_KEY`/`MEXC_API_SECRET` for MEXC — no new env vars to add, as long as you enabled that exchange's Spot trading permission when creating the key (see the Leveraged tab's setup above for both exchanges).

### Two different APIs under one file

Bybit uses the **same** V5 signing scheme, symbol format, and response envelope for Spot as it does for linear. MEXC uses a genuinely **different** API for Spot than for Futures: a different signing scheme entirely (`X-MEXC-APIKEY` header + a signed query string, vs. Futures' `ApiKey`/`Request-Time`/`Signature` headers — see `mexcClient.js`), though the same `CRVUSDT` symbol format as Bybit (no underscore, unlike MEXC's own Futures symbols). `api/spot/[action].js` handles both, branching on `exchange` inside each action:

- **Bybit** — same auth, same symbol format as Leveraged (see `bybitClient.js`). Order precision comes from `lotSizeFilter`/`priceFilter` on `GET /v5/market/instruments-info?category=spot`. Market buys spend an exact dollar amount via `marketUnit: "quoteCoin"`. Order lookup merges real-time open orders (`openOnly=0`) with durable closed-order history (`bybitFindClosedOrderHistorySinceOpening`, up to a 60-day lookback) — see the Position Status section above for why this replaced a plain `openOnly=1` call. A failure in that order lookup (e.g. a transient Bybit error) reports `ordersError` and shows an empty/partial order list rather than hiding the whole card — `hasPosition`/holdings come from your real asset balance, fetched separately, so they're unaffected by an order-list hiccup. Order status is a clean, documented enum (`Filled`/`Cancelled`/`New`/`PartiallyFilled`/etc.).
- **MEXC** — Spot v3 auth via `mexcClient.js`. Order precision comes from flat `baseAssetPrecision`/`quotePrecision` fields on `GET /api/v3/exchangeInfo` (no separate tick-size filter the way Bybit has). Market buys spend an exact dollar amount via `quoteOrderQty`. Order lookup uses `GET /api/v3/allOrders`, capped at a 7-day lookback (`mexcClient.js`'s `SPOT_SEVEN_DAYS_MS`, padded a few minutes under the true boundary to absorb clock drift/latency) — a position held longer than that with no order activity since still shows as open (real balance says so), just without an avg entry to compute P&L from. Order status needs a fallback quantity-comparison check (`classifyMexc` in `api/spot/[action].js`) alongside MEXC's own `status` field, because a market buy placed via `quoteOrderQty` reports `origQty` as `"0.000000"` even once fully filled.

### What each `api/spot/[action].js` action does
- `price` / `balance` (GET `/api/spot/price`, `/api/spot/balance`) — live price and available USDT, same role as `api/price.js` / `api/balance.js`. See "Pull available funds" above — Spot and Leveraged balances share one pool on Bybit, but are genuinely independent on MEXC.
- `execute` (POST `/api/spot/execute`) — places buy #1 as a market order and every other rung as a resting limit order, 550ms apart, on either exchange. After all orders are placed it reports `leftoverCapital` (planned capital minus what was actually committed) as an **informational line only** — same as the Leveraged tab's `api/execute.js`, and for Spot doubly so since there's no margin concept to add it to at all. Every order is tagged (`orderLinkId`/`newClientOrderId`) the same way the Leveraged tab's orders are.
- `status` (GET `/api/spot/status`) — maps Spot orders (from either exchange) into the exact same shape/encoding the Leveraged integration uses (`state`: resting/filled/canceled, `orderType`: limit/market), so the existing Position Status card — including the cumulative "avg entry if filled" column — renders Spot runs from either exchange with zero extra UI code. Reconstructs "position" (avg entry, size) from filled orders directly, since Spot has no position object the way linear does — `hasPosition` itself is read from the real base-asset wallet balance, not inferred from fills. P&L % is computed against cost basis (price × filled qty) standing in for margin, since there's no leverage to divide by.
- `close` (POST `/api/spot/close`) — the Spot tab's "Close Position": cancels every resting order on the symbol, then market-sells the **entire free balance** of the base asset back to USDT, on either exchange. Like the Leveraged panic button, this flattens the whole symbol, not just the current run.

### Demo mode

Demo mode is a **paper-trading simulator** on real market data. Leveraged and Spot are two independent simulated accounts (each starting at $1,000, stored in this browser's `localStorage` under `demoAccount`); switching tabs doesn't share balance or positions between them. (For real, non-demo use: Bybit's Unified Trading Account shares ONE pool of collateral between Spot and Leveraged, where MEXC keeps them genuinely separate — see "Pull available funds" above.)

How a simulated run behaves (the rules live in `demoSim.js`'s header comment):
- **Execute:** Buy #1 fills at a freshly fetched live price, with a taker fee. Every other rung rests. Resting orders reserve their margin (Leveraged) or USDT (Spot), so the available balance drops the way it does on a real exchange. The last rung is shrunk to what's actually free, like the real last-order sweep, and a plan that needs more than the free balance before the last rung is refused.
- **Fills:** each limit buy fills at its own price, with a maker fee, once the real market trades down to it. "Real market" means candles from the exchange the position was opened on, via `api/price.js?kline=1&interval=&start=` (Leveraged) or `api/spot/kline?interval=&start=` (Spot).
- **Liquidation (Leveraged):** the position is liquidated, losing its whole isolated margin, once the price reaches the liquidation price `avgEntry × (1 + MMR) − margin ÷ qty`. That's the same formula as `statusCalc.js`, recomputed after every fill. Remaining orders are canceled, and the page shows a notice.
- **Funding (Leveraged):** charged at every real settlement (`api/price.js?funding=1`) as `qty × price × rate`.
- **Fees:** Bybit's base tier on both exchanges (perps 0.055% taker / 0.02% maker, spot 0.1%).
- **Close position:** catches the simulation up first, then sells everything at the live price, with a taker fee.
- **Results:** every closed or liquidated run is added to the **Simulated account** card. It shows wallet, equity, total return and a trade history with net P&L after fees and funding.

**How it advances.** The page re-checks every minute while it's open (and on load, "Refresh status", Close) and catches up from where it left off, using the finest candle interval that covers the gap in ≤450 candles (1m up to daily). Only the lowest price reached matters, because fills and liquidation are both downside events. So each candle is processed by walking its low from the top: fill the highest rung still above both the low and the current liquidation price, recompute, repeat; if the liquidation price comes first, liquidate. That makes the result independent of candle size, and re-processing a candle is harmless.

**Not modelled:** slippage, order-book depth, and mark price (liquidation uses traded prices). Fills inside the candle that contains the execute time are also missed, since that candle includes pre-execute prices.

A simulated position belongs to the exchange it was opened on. On page load the demo looks for an open simulated position, never for a real account (`discoverActiveSymbol()` is skipped in demo mode). Positions saved by the older, non-simulating demo are upgraded in place.

## Login

Since this deployment now trades on real Bybit and/or MEXC accounts, the whole app — the calculator page and every `api/*` endpoint — sits behind a login. `middleware.js` checks every request for a signed session cookie; anyone without one is redirected to `login.html` (or, for API calls, gets a 401).

### One-time setup

In Terminal, from the `calculator` folder:
```
vercel env add APP_USERNAME
```
Pick a username, paste it when prompted.
```
vercel env add APP_PASSWORD
```
Pick a strong password, paste it when prompted.
```
openssl rand -hex 32
```
Copy the random string it prints, then:
```
vercel env add SESSION_SECRET
```
Paste that random string when prompted (this is what signs the session cookie — never reuse it for anything else, and don't reuse your Bybit secret).

For each of the three, select all environments (Production/Preview/Development) unless you have a reason not to. Then redeploy:
```
vercel --prod
```

### How it works
- Signing in at `/login.html` posts to `api/login.js`, which checks the username/password against `APP_USERNAME`/`APP_PASSWORD` (constant-time comparison) and, on success, sets an `HttpOnly`, `Secure`, `SameSite=Strict` cookie signed with `SESSION_SECRET`. The cookie only carries an expiry timestamp + signature — no password material.
- Sessions last 7 days, then you're prompted to sign in again.
- `middleware.js` runs on Vercel's Node.js runtime (not Edge) so it shares byte-for-byte the same HMAC signing code as `api/login.js` — no cross-runtime crypto mismatches.
- **The file must be named `middleware.js` (or `.ts`).** Until October 2026 it was `middleware.mjs`, which Vercel silently ignores: every build shipped with no middleware, so the page and every `api/*` endpoint, including `execute` and `close`, were reachable without a login. A browser that still held a valid cookie looked exactly the same, which is why it went unnoticed. To verify the gate after any auth change: `curl -i "https://leveragecalculator.vercel.app/api/balance?exchange=bybit"` with no cookie must return `401`.
- "Log out" (top-right of the calculator) calls `api/logout.js`, which clears the cookie, then sends you back to `login.html`.
- This is single-user auth (one shared username/password) — there's no user database, matching the fact that this deploys against one Bybit account.

## Demo instance (shareable, no login, no real account)

For showing the app to someone without giving them access to the real Bybit account behind the production URL, run a second Vercel project from this same repo in **demo mode**: no login wall, and every balance/position/order on the page is simulated in the visitor's own browser — nothing ever calls a real Bybit account endpoint.

### What demo mode changes
- `middleware.js` skips the login check entirely when `DEMO_MODE=true`, so the page loads directly with no session required.
- "Get balance", "Execute plan", "Close position" and the Position Status card no longer call `api/balance.js` / `api/execute.js` / `api/status.js` / `api/close.js`. Instead, `index.html` runs a paper-trading simulation (starting balance $1,000) entirely client-side with `demoSim.js`, on real public candles and funding rates, storing the simulated account in the browser's `localStorage`. See "Demo mode" under Spot DCA mode for the rules.
- The live price feed (`api/price.js`) still hits Bybit's real *public* ticker — that's not account data, so the demo shows genuine live market prices while everything account-related is fake.
- A "DEMO MODE" banner appears at the top of the page, and "Log out" becomes "Reset demo" (clears the simulated position/balance back to a fresh $1,000).
- Since nothing sensitive is ever touched, the demo project needs **no environment variables at all** — no `BYBIT_API_KEY`, `BYBIT_API_SECRET`, `APP_USERNAME`, `APP_PASSWORD`, or `SESSION_SECRET`. Just `DEMO_MODE=true`.

### One-time setup
In Terminal, from the `calculator` folder, link a **second, separate** Vercel project to the same repo (give it its own name so it gets its own `<name>.vercel.app` URL — same domain, different subdomain from production):
```
vercel link
```
When prompted, choose "no" to using the existing project and create a new one — e.g. name it `leveragecalculator-demo`. Then set the one env var it needs:
```
vercel env add DEMO_MODE
```
Type `true` when prompted, select all environments (Production/Preview/Development). Deploy it:
```
vercel --prod
```
Vercel will print the new project's URL (something like `https://leveragecalculator-demo.vercel.app`) — that's the link to share. Your existing production project/URL and its env vars are untouched; the two projects share the same GitHub repo and code but are otherwise completely independent.

To push future code changes to both, just `git push` as usual — each Vercel project auto-deploys from the same branch independently.

## Local testing

```
vercel dev
```

This serves `index.html` and runs `api/price.js` locally so the "Get price" button works before you deploy.

## Backfill validation

Six test files, all wired into `npm test`:

- `test/backfill.test.js` checks `calc.js`'s `computePlan` (the leveraged ladder-sizing engine): an exactly hand-derived single-buy fixture, a hand-derived multi-buy fixture with an explicit peak-drawdown override (confirming the peak control actually plumbs through), structural invariants (capital conservation — `totalBuys == capital`, nothing withheld — the sweet-spot peak landing where the ladder's own spacing says it should, the hump shape, and an independent reconstruction of avg entry/liquidation/quantity from each row's own raw price/qty/amount) checked across a spread of inputs, and the input-validation error paths. It also checks `ladderSurvival`/`scanPeakFeasibility` (the feasibility indicator's math) against hand-reasoned cases: a case that's structurally impossible for any peak setting, a case reachable only with a deep-enough peak, and a low-leverage case that's trivially safe. There's no external spreadsheet backfill for the current sweet-spot-peaked shape — see the file's header comment for why. None of this depends on which exchange is selected — `calc.js` is exchange-agnostic.
- `test/status-backfill.test.js` checks `statusCalc.js` — the P&L and projected-liquidation math shown on the Position Status card — against hand-computed, independently cross-checked fixtures (a loss scenario with resting orders, a zero-resting-orders case, a profitable long, and a profitable short). Also exchange-agnostic.
- `test/spot-backfill.test.js` checks `calc.js`'s `computeSpotPlan`: trigger prices and shape cross-checked against the leveraged engine's own output (confirming the shared `buildLadderShape` keeps Spot and Leveraged in sync), two hand-computed fixtures (one where the sweet spot falls outside the ladder's range and degenerates to plain geometric growth, one with an interior peak), and both error paths.
- `test/spot-status-classify.test.js` pins `api/spot/[action].js`'s `classify` (the Bybit order-status classifier) against Bybit's own `orderStatus` enum — fixtures for a market buy placed via `marketUnit: "quoteCoin"`, resting/partial/filled limit orders, and canceled/rejected orders.
- `test/mexc-status-classify.test.js` pins `api/spot/[action].js`'s `classifyMexc` (the MEXC order-status classifier) against MEXC's own fixtures — including the market-buy-via-`quoteOrderQty` quirk (`origQty` stays `"0.000000"` even once filled, so `status` is checked first) and the quantity-comparison fallback path for any status string the function doesn't recognize.

- `test/demo-sim.test.js` checks `demoSim.js`, the demo simulator, against hand-worked fixtures: opening a ladder (fees, margin, liquidation price, available balance), a rung filling then a later liquidation, the same outcome from one coarse candle, re-processing a candle, liquidation before the next rung, funding between candles (and not charged twice), manual closes on both tabs with P&L reconciling to the wallet, the last-rung sweep, and refused over-sized plans.

Run all six any time you change `calc.js`, `statusCalc.js`, or either exchange's order-status classifier:

```
npm test
```

It's also wired into `vercel.json` as the build step — `vercel` / `vercel --prod` runs it automatically and **aborts the deploy if any test file fails**, so a broken calculation engine — ladder sizing or position math, on either exchange — can never go live.

## Notes
- Fees and funding are ignored.
- Liquidation price formula: `Avg Entry × (1 + MMR) − Total Margin Deployed ÷ Quantity` (isolated margin).
- Buy sizes peak at the rung nearest the **"Peak buy drawdown"** you set (default -35%) — the price this plan wants to buy the most at — growing geometrically (×1.26 per step) into it and shrinking geometrically (÷1.26 per step) beyond it, instead of growing monotonically all the way out. If the peak you set falls beyond "Target drawdown"/"Ladder depth"'s own reach, it clamps to the last buy and every buy just grows (no taper). See "Peak buy drawdown" above.
- **Target drawdown / Ladder depth controls purely how far down the ladder's price rungs reach** — it is *not* solved for or tied to a liquidation target. 100% of the capital you commit is deployed across the ladder's buys, full stop. Every rung's displayed liquidation price ("Liquidation ($)" column, Leveraged tab only) is the real, immediate one, computed purely from margin actually committed by the buys placed so far — a plain informational read-out you can use to judge the plan, never something the plan engineers toward. Enabling Bybit's own Auto-Margin Replenishment (AMR) on the resulting position, from the Bybit app, is available as a general safety net if you want one, but this app doesn't design around it.
- Default target drawdown is 70%; default peak buy drawdown is 35%.
- On page load and on Reset, the app automatically pulls the live Bybit price and your live usable balance (same as clicking "Get price" / "Get balance") before calculating, so the plan always starts from real numbers rather than the static fallback defaults (0.223 / $951) baked into the input fields.
- The auto-pulled usable balance always overwrites the Available balance field, even if it comes back as $0.00 (common while a position is already open and margin is tied up) — you'll need to top up or close the position before calculating a new plan, since a $0 capital fails the calculator's validation ("Entry price, leverage and capital must be positive").
- If the price comes back invalid, that field is left unchanged instead of being overwritten.

Testing auto-deploy
