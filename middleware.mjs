// Vercel Routing Middleware — gates the entire app (calculator + every
// api/* endpoint) behind a login. Runs on the Node.js runtime (not Edge)
// so it shares the exact same HMAC session-cookie logic, byte for byte,
// with api/login.js and api/logout.js — no Edge/Node crypto mismatch to
// worry about.
//
// Env vars used: SESSION_SECRET (signs/verifies the cookie; APP_USERNAME
// and APP_PASSWORD live only in api/login.js, this file never sees them).

import crypto from 'node:crypto';
import { next } from '@vercel/functions';

export const config = {
  runtime: 'nodejs',
};

// Routes reachable without a session — the login page itself, and the
// two endpoints that create/destroy a session.
const PUBLIC_PATHS = new Set(['/login.html', '/api/login', '/api/logout']);

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  });
  return out;
}

function isValidSession(cookieHeader) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) return false;

  const raw = parseCookies(cookieHeader).session;
  if (!raw) return false;

  const dot = raw.lastIndexOf('.');
  if (dot === -1) return false;
  const expiryStr = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  if (!expiryStr || !sig || !/^\d+$/.test(expiryStr)) return false;

  const expected = crypto.createHmac('sha256', secret).update(expiryStr).digest('hex');
  let sigBuf, expBuf;
  try {
    sigBuf = Buffer.from(sig, 'hex');
    expBuf = Buffer.from(expected, 'hex');
  } catch {
    return false;
  }
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return false;

  return Date.now() < Number(expiryStr);
}

export default function middleware(request) {
  // Demo deployments (a separate Vercel project pointed at this same repo,
  // with DEMO_MODE=true and none of the MEXC/session secrets set) have no
  // account behind them to protect, so there's nothing to gate — skip auth
  // entirely rather than lock everyone out of a project with no valid
  // login configured. See README's "Demo instance" section.
  if (process.env.DEMO_MODE === 'true') {
    return next();
  }

  const url = new URL(request.url);

  if (PUBLIC_PATHS.has(url.pathname)) {
    return next();
  }

  if (isValidSession(request.headers.get('cookie'))) {
    return next();
  }

  // Unauthenticated: API calls get a clean 401 (so the page's fetch()
  // handlers can show a real error instead of following a redirect into
  // an HTML login page); page navigations get sent to the login page.
  if (url.pathname.startsWith('/api/')) {
    return new Response(JSON.stringify({ error: 'Not signed in.' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }

  return Response.redirect(new URL('/login.html', request.url), 302);
}
