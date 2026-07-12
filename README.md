# Leveraged DCA Ladder Calculator

One-page calculator for sizing a laddered leveraged DCA position (isolated margin, long) against a target drawdown-before-liquidation. Live entry price pulled from MEXC Futures.

## Files
- `index.html` — UI (inputs + results table)
- `calc.js` — calculation engine (shared by the browser and tested via Node)
- `api/price.js` — Vercel serverless function that proxies MEXC's futures ticker (avoids browser CORS)
- `api/execute.js` — Vercel serverless function that places the ladder's limit buy orders on MEXC Futures
- `api/balance.js` — Vercel serverless function that fetches your available USDT futures balance

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
   - Enable both the **Futures → Order Placing** permission (for execution) and **Futures → View Account Details** permission (for the "Get balance" button).
   - IP binding: Vercel serverless functions don't have a fixed outbound IP, so leave the key **unbound** (unrestricted) unless you've set up a static-IP add-on. Unbound keys expire after 90 days and need renewing in MEXC's API Management page.
2. **Add the key to Vercel** (Project → Settings → Environment Variables):
   - `MEXC_API_KEY` = your Access Key
   - `MEXC_API_SECRET` = your Secret Key
   - Redeploy (`vercel --prod`) after adding them — env vars only take effect on the next deploy.
3. That's it — the key never touches the browser. `Execute plan on MEXC` calls `/api/execute`, which reads the key server-side and signs each request.

### What it does per click
- Converts each buy's base-asset quantity into MEXC's contract count (`vol`) using the live contract spec (`contractSize`, `priceScale`, `volScale`).
- Places each order sequentially with ~550ms spacing to stay under MEXC's order-placement rate limit (4 requests / 2s).
- Shows a per-order result (order ID or the specific MEXC error) once all orders have been submitted.
- Asks for a browser confirmation before sending anything — no orders go out on an accidental click.

## Pull available funds from MEXC

The "Get balance" button next to Total capital calls `api/balance.js`, which signs a request to MEXC's `Get Single Currency Asset Information` endpoint for USDT and fills the Total capital field with **usable amount** (`availableOpen` — MEXC's figure for what you can actually deploy into a new position, distinct from total equity or withdrawable balance). Requires the same `MEXC_API_KEY` / `MEXC_API_SECRET` env vars as execution, plus the key's "View Account Details" permission.

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
