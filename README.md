# Leveraged DCA Ladder Calculator

One-page calculator for sizing a laddered leveraged DCA position (isolated margin, long) against a target drawdown-before-liquidation. Live entry price pulled from MEXC Futures.

## Files
- `index.html` — UI (inputs + results table)
- `calc.js` — calculation engine (shared by the browser and tested via Node)
- `api/price.js` — Vercel serverless function that proxies MEXC's futures ticker (avoids browser CORS)
- `api/execute.js` — Vercel serverless function that places the ladder's limit buy orders on MEXC Futures
- `api/balance.js` — Vercel serverless function that fetches your available USDT futures balance
- `api/close.js` — Vercel serverless function behind the "Close Position" panic button
- `login.html` — sign-in page
- `api/login.js` / `api/logout.js` — issue/clear the session cookie
- `middleware.mjs` — gates every route behind that session cookie

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

The "Execute" card at the bottom of the calculated plan places every "Limit Buy" row as an isolated-margin, open-long limit order on MEXC Futures via `api/execute.js`. The "Add Margin" step is intentionally **not** automated — MEXC only lets you add margin to a position that already exists, which means it needs a position ID that doesn't exist until Buy #1 fills. Add that margin yourself in the MEXC app once you see the fill, using the dollar amount already shown in the ladder table.

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
- Asks for a browser confirmation before sending anything — no orders go out on an accidental click.

## Pull available funds from MEXC

The "Get balance" button next to Total capital calls `api/balance.js`, which signs a request to MEXC's `Get Single Currency Asset Information` endpoint for USDT and fills the Total capital field with **usable amount** (`availableOpen` — MEXC's figure for what you can actually deploy into a new position, distinct from total equity or withdrawable balance). Requires the same `MEXC_API_KEY` / `MEXC_API_SECRET` env vars as execution, plus the key's "View Account Details" permission.

## Close Position (panic button)

The red "CLOSE POSITION" button in the Danger Zone card at the bottom calls `api/close.js` for the asset currently entered in the Asset field, and:

1. Cancels every resting order on that symbol first (`order/cancel_all`), so nothing already on the book can fill while — or after — the position is being closed.
2. Looks up any open position on that symbol (`position/open_positions`, filtered by symbol) and flash-closes it at market (`side` 4/2 for close-long/close-short, `type` market, tagged with that position's own `positionId` and `reduceOnly: true`).

This is deliberately scoped to **one symbol only**. MEXC also has an account-wide `/position/close_all` endpoint that takes no symbol and would close every open position across your whole account — it's intentionally not used here, since this app should only ever touch the pair you're looking at.

Asks for a browser confirmation before doing anything, same as Execute.

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

## Local testing

```
vercel dev
```

This serves `index.html` and runs `api/price.js` locally so the "Get price" button works before you deploy.

## Backfill validation

`test/backfill.test.js` checks `calc.js` against the proven reference plan (the 12-buy, $951, $0.223-entry plan). Run it any time you change `calc.js`:

```
npm test
```

It's also wired into `vercel.json` as the build step — `vercel` / `vercel --prod` runs it automatically and **aborts the deploy if it fails**, so a broken calculation engine can never go live.

## Notes
- Fees and funding are ignored.
- Liquidation price formula: `Avg Entry × (1 + MMR) − Total Margin Deployed ÷ Quantity` (MEXC isolated margin).
- Buy sizes grow geometrically (×1.26 per step); the ladder is spaced evenly in drawdown across the buys, leaving one spacing unit of buffer before the liquidation target.

Testing auto-deploy
