# Leveraged / Spot DCA Ladder Calculator

One-page calculator for sizing a laddered DCA position, in two modes switchable by tab:

- **Leveraged** — isolated margin, long, on MEXC Futures, sized against a target drawdown-before-liquidation.
- **Spot DCA** — the same laddered-buy math, no leverage, no margin, no liquidation, on MEXC Spot. Uses the exact same trigger prices as the Leveraged tab for the same inputs, so the two are directly comparable — see "Spot DCA mode" below for why they're not equivalent in outcome despite sharing a ladder shape.

Live entry price pulled from MEXC (Futures ticker for the Leveraged tab, Spot ticker for the Spot tab).

## Files
- `index.html` — UI (inputs + results table), with a Leveraged/Spot tab switch
- `calc.js` — calculation engine: `computePlan` (leveraged) and `computeSpotPlan` (spot), sharing a `buildLadderShape` helper so both tabs trigger at identical prices for the same inputs
- `statusCalc.js` — P&L / projected-liquidation math (shared by `api/status.js` server-side and, in demo mode, by `index.html` client-side)
- `api/config.js` — tells `index.html` whether this deployment is running in demo mode

### Leveraged (MEXC Futures)
- `api/price.js` — proxies MEXC's futures ticker (avoids browser CORS)
- `api/execute.js` — places the ladder's limit buy orders on MEXC Futures, then adds leftover capital as margin
- `api/balance.js` — fetches your available USDT futures balance
- `api/close.js` — behind the "Close Position" panic button
- `api/status.js` — reports whether a position is open and how the ladder's orders have filled

### Spot (MEXC Spot)
- `api/spot-price.js` — proxies MEXC's spot ticker
- `api/spot-execute.js` — places the ladder's buy orders on MEXC Spot (no leverage/margin)
- `api/spot-balance.js` — fetches your available USDT spot balance
- `api/spot-close.js` — behind the "Close Position" button in Spot mode
- `api/spot-status.js` — reports fill status for the current run's orders (spot has no unified "position" object, so this is reconstructed from order fills)

### Auth
- `login.html` — sign-in page
- `api/login.js` / `api/logout.js` — issue/clear the session cookie
- `middleware.mjs` — gates every route behind that session cookie (bypassed entirely in demo mode, see below)

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
Copy it into your browser. Click "Get price" to confirm it pulls a live MEXC price, then "Calculate plan" to confirm the table appears.

### 10. Make the link permanent
That first URL is a "preview" link. To get the permanent one, type:
```
vercel --prod
```
Press Enter and wait. It prints your permanent URL, e.g. `https://crv-calculator.vercel.app` — this is the one to bookmark/share.

### 11. (Optional) Use your own domain
If you own a domain name: in your browser go to vercel.com, log in, open this project, go to **Settings → Domains**, type your domain, and follow the DNS instructions shown on screen.

## Execute plan on MEXC (auto-place orders)

The "Execute" card at the bottom of the calculated plan places every "Limit Buy" row as an isolated-margin, open-long limit order on MEXC Futures via `api/execute.js`, then automatically adds whatever capital is left over directly to the position as margin.

### One-time setup

1. **Create a MEXC API key**: MEXC website → profile icon → API Management → Create API. Your account needs KYC completed to enable futures trading permission.
   - Enable **Futures → Order Placing** (execution + closing), **Futures → View Account Details** (the "Get balance" button), and **Futures → View Order Details** (the "Close Position" button looks up your open position, which needs this one).
   - IP binding: Vercel serverless functions don't have a fixed outbound IP, so leave the key **unbound** (unrestricted) unless you've set up a static-IP add-on. Unbound keys expire after 90 days and need renewing in MEXC's API Management page.
2. **Add the key to Vercel** (Project → Settings → Environment Variables):
   - `MEXC_API_KEY` = your Access Key
   - `MEXC_API_SECRET` = your Secret Key
   - Redeploy (`vercel --prod`) after adding them — env vars only take effect on the next deploy.
3. That's it — the key never touches the browser. `Execute plan on MEXC` calls `/api/execute`, which reads the key server-side and signs each request.

### What it does per click
- Converts each buy's base-asset quantity into MEXC's contract count (`vol`) using the live contract spec (`contractSize`, `priceScale`, `volScale`).
- Buy #1 is placed as a **market** order (fills immediately at the live price); every other buy is a **limit** order resting at its ladder price. This is a display/execution-layer choice only — `calc.js`'s sizing math is unaffected.
- Places each order sequentially with ~550ms spacing to stay under MEXC's order-placement rate limit (4 requests / 2s).
- Shows a per-order result (order ID or the specific MEXC error) once all orders have been submitted.
- **Adds the remaining margin automatically.** After every order has been placed, `api/execute.js` sums up what was *actually* committed — using each order's real, exchange-rounded price × contract count, not the plan's theoretical numbers, since MEXC's `contractSize`/`volScale`/`minVol` rounding means the orders that land rarely cost exactly what the plan predicted — and subtracts that from the "Total capital" you entered. Whatever's left gets sent to MEXC's `position/change_margin` endpoint (`type: 1`, increase) and attached directly to the position. This needs the position's `positionId`, which only exists after Buy #1 has filled, so it polls `position/open_positions` (up to 6 tries, 500ms apart) before giving up — by the time every ladder order has been placed this has almost always already happened, so the poll is mostly a safety net. If the remainder is negative (orders somehow cost more than the provided capital) or under a $0.01 floor, the step is skipped and reported as such rather than attempted. No extra API key permission is needed — `change_margin` uses the same **Futures → Order Placing** permission as order creation.
- Asks for a browser confirmation before sending anything — no orders go out on an accidental click.

## Pull available funds from MEXC

The "Get balance" button next to Total capital calls `api/balance.js`, which signs a request to MEXC's `Get Single Currency Asset Information` endpoint for USDT and fills the Total capital field with **usable amount** (`availableOpen` — MEXC's figure for what you can actually deploy into a new position, distinct from total equity or withdrawable balance). Requires the same `MEXC_API_KEY` / `MEXC_API_SECRET` env vars as execution, plus the key's "View Account Details" permission.

## Close Position (panic button)

The red "CLOSE POSITION" button in the Danger Zone card at the bottom calls `api/close.js` for the asset currently entered in the Asset field, and:

1. Cancels every resting order on that symbol first (`order/cancel_all`), so nothing already on the book can fill while — or after — the position is being closed.
2. Looks up any open position on that symbol (`position/open_positions`, filtered by symbol) and flash-closes it at market (`side` 4/2 for close-long/close-short, `type` market, tagged with that position's own `positionId` and `reduceOnly: true`).

This is deliberately scoped to **one symbol only**. MEXC also has an account-wide `/position/close_all` endpoint that takes no symbol and would close every open position across your whole account — it's intentionally not used here, since this app should only ever touch the pair you're looking at.

Asks for a browser confirmation before doing anything, same as Execute.

## Position Status (two app states)

The page checks `api/status.js` for the current Asset on load, after fetching a price, and after Execute/Close — and switches between two states:

- **No open position:** the ordinary plan calculator — inputs, Calculate, the theoretical ladder, and the "Execute plan on MEXC" card.
- **Position open:** a "Position Status" card replaces the Execute card, showing avg entry / size / leverage, unrealized P&L in $ and %, and a projected liquidation price — plus the orders **since your last Execute** — not the pair's full trading history — each row labeled Filled/Resting/Canceled/Invalid so it's clear how deep this run's ladder actually went. Execute is hidden in this state so a second ladder can't get deployed on top of a live one; Calculate above still works for previewing numbers only. A "Refresh status" button re-checks on demand.

  Scoping to "since the last Execute": `api/status.js` pulls every order for the symbol from `Get All Historical Orders` (unfiltered by state — its enum includes "unfilled", so one call covers resting/filled/canceled/invalid together), finds the most recent open-long **market** order (that's always Buy #1 in this app's ladder), and only returns orders from that timestamp onward. A prior, already-closed run on the same symbol won't show up mixed in.

  **Unrealized P&L ($ and %):** computed from the position's own `holdAvgPrice` against a live ticker price, converted through the contract's `contractSize`. The % is P&L divided by the position's current `im` (initial margin) — MEXC's own live figure for margin actually committed to the position right now, which already reflects any margin you've added manually in the MEXC app.

  **"Liq. if fully filled" price:** deliberately *not* MEXC's `liquidatePrice`, which only reflects what has actually filled so far. Instead, starting from the position's real, current `im`, avg entry, and size, this walks forward through every still-**resting** order in the scoped list, accumulates the margin each would add (`vol × contractSize × price ÷ leverage`, using the position's real leverage) and the resulting weighted avg entry, then reapplies the same isolated-margin liquidation formula used elsewhere in this app (`Avg Entry × (1 + MMR) − Total Margin ÷ Quantity`, MMR from the contract spec). Because it starts from live `im`, a manual margin top-up is picked up automatically on the next refresh.

  **"Avg entry if filled" column (per order row):** a running cumulative average, computed client-side in `index.html` straight from the scoped orders list — since it's already sorted highest-price-first, which is exactly fill order for a DCA-down ladder, walking down it and accumulating `qty × price` (using each order's real `dealVol`/`dealAvgPrice` once filled, or its resting `vol`/`price` before that) reconstructs "what the position average would be if this row, and everything above it, has filled" at every rung. Canceled/invalid orders are skipped — they never will fill, so they don't contribute — and show as "—".

Requires the same `MEXC_API_KEY` / `MEXC_API_SECRET` as the rest of the MEXC integration, plus "View Order Details" (already needed for Close Position).

## Spot DCA mode

The **Spot DCA** tab runs the same laddered-buy idea with no leverage, no margin, and no liquidation, executing on MEXC Spot instead of Futures. `computeSpotPlan` (in `calc.js`) shares its trigger-price math with the leveraged `computePlan` via a common `buildLadderShape` helper, so entering the same entry price / buy count / drawdown coverage on either tab produces buys at identical prices — only the sizing (leveraged solves for a liquidation-safe `E1`; spot just splits `capital` across the ladder) and the risk profile differ.

### One-time setup

The Spot tab reuses the **same** `MEXC_API_KEY` / `MEXC_API_SECRET` env vars as the Leveraged tab — no new env vars to add. The one manual step is on MEXC's side: your API key needs **Spot trading permission** enabled in addition to whatever Futures permissions it already has (MEXC website → API Management → edit the key → enable "Spot Trading"). Nothing here needs KYC beyond what Futures already required.

### API differences from Futures (why there's a separate set of `api/spot-*.js` files)

MEXC Spot v3 is a different API surface from Futures, not just a different symbol format:

- **Auth**: header `X-MEXC-APIKEY` (not the Futures `ApiKey`/`Request-Time`/`Signature` triplet), and the signature is `HMAC-SHA256(secretKey, paramString)` over the exact, unsorted query string / form body sent — not a JSON payload.
- **Symbols have no separator** — `CRVUSDT`, not `CRV_USDT`.
- **Order precision** comes from flat `baseAssetPrecision` / `quotePrecision` fields on `GET /api/v3/exchangeInfo` (MEXC's spot API doesn't document a Binance-style `LOT_SIZE`/`PRICE_FILTER` filter list).
- **Market buys spend an exact dollar amount** via `quoteOrderQty` rather than a pre-computed base quantity, so the first ladder rung always costs exactly what the plan says regardless of the instant of execution.
- **Order-history lookback is capped at 7 days** (`GET /api/v3/allOrders`) — unlike the Futures integration's `history_orders` endpoint, which has no such limit. A deployment left running longer than a week without a fresh Execute would lose visibility into that run's early orders in the Position Status card.
- MEXC's published Spot docs left some details unconfirmed (the full order-status enum beyond `NEW`/`CANCELED`, and one inconsistent `LIMIT`/`LIMIT_ORDER` example). `api/spot-status.js` sidesteps this by classifying fills from `executedQty` vs `origQty` — fields confirmed everywhere in the docs — rather than trusting an exact status string.

### What each endpoint does
- `api/spot-price.js` / `api/spot-balance.js` — live price and available USDT, same role as `api/price.js` / `api/balance.js`.
- `api/spot-execute.js` — places buy #1 as a market order (`quoteOrderQty`) and every other rung as a resting limit order, 550ms apart. After all orders are placed it reports `leftoverCapital` (planned capital minus what was actually committed) as an **informational line only** — unlike the Leveraged tab, this is not auto-deployed anywhere, since spot has no margin concept to add it to.
- `api/spot-status.js` — maps MEXC Spot orders into the exact same shape/encoding the Futures integration uses (`state`: resting/filled/canceled, `orderType`: limit/market), so the existing Position Status card — including the cumulative "avg entry if filled" column — renders Spot runs with zero extra UI code. Reconstructs "position" (avg entry, size) from filled orders directly, since spot has no unified position object the way Futures does. P&L % is computed against cost basis (price × filled qty) standing in for margin, since there's no leverage to divide by.
- `api/spot-close.js` — the Spot tab's "Close Position": cancels every resting order on the symbol, then market-sells the **entire free balance** of the base asset back to USDT. Like the Futures panic button, this flattens the whole symbol, not just the current run.

### Demo mode

Demo mode simulates Leveraged and Spot as two independent fake accounts (`localStorage` keys `leveraged` / `spot`, each with its own starting $1,000 balance and simulated position) — switching tabs in the demo doesn't share balance or position state between them, matching how two separate MEXC wallets (Futures vs Spot) would behave for real.

## Login

Since this deployment now trades on a real MEXC account, the whole app — the calculator page and every `api/*` endpoint — sits behind a login. `middleware.mjs` checks every request for a signed session cookie; anyone without one is redirected to `login.html` (or, for API calls, gets a 401).

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
Paste that random string when prompted (this is what signs the session cookie — never reuse it for anything else, and don't reuse your MEXC secret).

For each of the three, select all environments (Production/Preview/Development) unless you have a reason not to. Then redeploy:
```
vercel --prod
```

### How it works
- Signing in at `/login.html` posts to `api/login.js`, which checks the username/password against `APP_USERNAME`/`APP_PASSWORD` (constant-time comparison) and, on success, sets an `HttpOnly`, `Secure`, `SameSite=Strict` cookie signed with `SESSION_SECRET`. The cookie only carries an expiry timestamp + signature — no password material.
- Sessions last 7 days, then you're prompted to sign in again.
- `middleware.mjs` runs on Vercel's Node.js runtime (not Edge) so it shares byte-for-byte the same HMAC signing code as `api/login.js` — no cross-runtime crypto mismatches.
- "Log out" (top-right of the calculator) calls `api/logout.js`, which clears the cookie, then sends you back to `login.html`.
- This is single-user auth (one shared username/password) — there's no user database, matching the fact that this deploys against one MEXC account.

## Demo instance (shareable, no login, no real account)

For showing the app to someone without giving them access to the real MEXC account behind the production URL, run a second Vercel project from this same repo in **demo mode**: no login wall, and every balance/position/order on the page is simulated in the visitor's own browser — nothing ever calls a real MEXC account endpoint.

### What demo mode changes
- `middleware.mjs` skips the login check entirely when `DEMO_MODE=true`, so the page loads directly with no session required.
- "Get balance", "Execute plan", "Close position" and the Position Status card no longer call `api/balance.js` / `api/execute.js` / `api/status.js` / `api/close.js`. Instead, `index.html` simulates a fake account (starting balance $1,000) entirely client-side, storing the simulated position in the browser's `localStorage`. The same `statusCalc.js` math (P&L, projected liquidation) that the real deployment uses server-side runs client-side for the simulation, so the numbers behave identically.
- The live price feed (`api/price.js`) still hits MEXC's real *public* ticker — that's not account data, so the demo shows genuine live market prices while everything account-related is fake.
- A "DEMO MODE" banner appears at the top of the page, and "Log out" becomes "Reset demo" (clears the simulated position/balance back to a fresh $1,000).
- Since nothing sensitive is ever touched, the demo project needs **no environment variables at all** — no `MEXC_API_KEY`, `MEXC_API_SECRET`, `APP_USERNAME`, `APP_PASSWORD`, or `SESSION_SECRET`. Just `DEMO_MODE=true`.

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

Three test files, all wired into `npm test`:

- `test/backfill.test.js` checks `calc.js`'s `computePlan` (the leveraged ladder-sizing engine) against the proven reference plan (the 12-buy, $951, $0.223-entry plan).
- `test/status-backfill.test.js` checks `statusCalc.js` — the P&L and projected-liquidation math shown on the Position Status card — against hand-computed, independently cross-checked fixtures (a loss scenario with resting orders, a zero-resting-orders case, a profitable long, and a profitable short).
- `test/spot-backfill.test.js` checks `calc.js`'s `computeSpotPlan` against the same reference plan's trigger prices (confirming the shared `buildLadderShape` keeps Spot and Leveraged in sync), a second hand-computed fixture, and both error paths.

Run all three any time you change `calc.js` or `statusCalc.js`:

```
npm test
```

It's also wired into `vercel.json` as the build step — `vercel` / `vercel --prod` runs it automatically and **aborts the deploy if either test file fails**, so a broken calculation engine — ladder sizing or position math — can never go live.

## Notes
- Fees and funding are ignored.
- Liquidation price formula: `Avg Entry × (1 + MMR) − Total Margin Deployed ÷ Quantity` (MEXC isolated margin).
- Buy sizes grow geometrically (×1.26 per step); the ladder is spaced evenly in drawdown across the buys, leaving one spacing unit of buffer before the liquidation target.
- Default drawdown coverage is 70%.
- On page load and on Reset, the app automatically pulls the live MEXC price and your live usable balance (same as clicking "Get price" / "Get balance") before calculating, so the plan always starts from real numbers rather than the static fallback defaults (0.223 / $951) baked into the input fields.
- If the auto-pulled usable balance comes back as $0 (common while a position is already open and margin is tied up) or the price comes back invalid, that field is left unchanged instead of being overwritten — a $0 capital would otherwise break the calculator's validation ("Entry price, leverage and capital must be positive").

Testing auto-deploy
