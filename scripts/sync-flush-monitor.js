#!/usr/bin/env node
// Mirrors monitor/ into the public standalone repo (github.com/wellwho/flush-monitor).
//
// monitor/ in this repo is the single source of truth. The standalone repo is
// built from it mechanically:
//   - every file in monitor/ except: README.md (the NAS-specific one),
//     standalone/, and local runtime files (.env, data/, logs/, run.pid);
//   - plus everything in monitor/standalone/ (public README, package.json,
//     LICENSE, .gitignore), copied to the repo root.
//
// Before anything is written to the target, the built tree must pass every
// check below. A failure means the change could break the standalone
// version or leak something private, so nothing is synced; a person decides
// what to do.
//
// Usage:
//   node scripts/sync-flush-monitor.js --check                    build + verify only
//   node scripts/sync-flush-monitor.js --target ../flush-monitor  build, verify, write into a clone
//   node scripts/sync-flush-monitor.js --target DIR --push        ...then commit and push
// CI (.github/workflows/sync-flush-monitor.yml) runs the last form on every
// push to master that touches monitor/.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const MONITOR = path.join(REPO_ROOT, 'monitor');
const STANDALONE = path.join(MONITOR, 'standalone');

// Not mirrored: the NAS-specific README is replaced by standalone/README.md,
// and runtime files never leave the machine they were created on.
const EXCLUDE = new Set(['README.md', 'standalone', '.env', 'data', 'logs', 'run.pid', 'node_modules', '.DS_Store']);

// Strings that must never reach the public repo: details of the private
// deployment, and the shape of real secrets.
const FORBIDDEN = [
  [/plexnas/i, 'NAS SSH alias'],
  [/flushmon\b/i, 'NAS install folder name'],
  [/\/var\/services\/homes/i, 'NAS home path'],
  [/wellwho@/i, 'NAS login'],
  [/192\.168\.\d+\.\d+/, 'LAN address'],
  // Filled-in settings: only empty values belong in tracked files (.env itself is never synced).
  [/^\s*TELEGRAM_CHAT_ID=[ \t]*-?\d+/m, 'a filled-in Telegram chat id'],
  [/^\s*TELEGRAM_BOT_TOKEN=[ \t]*\S/m, 'a filled-in Telegram bot token'],
  [/^\s*HEALTHCHECK_URL=[ \t]*\S/m, 'a filled-in heartbeat URL'],
  [/\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/, 'Telegram bot token'],
  [/hc-ping\.com\/[0-9a-f]{8}-/i, 'healthchecks.io ping URL'],
  [/leverage_calculator/i, 'app repo name (the standalone repo stands on its own)'],
  [/\bcalc\.js\b|statusCalc/, 'reference to the calculator app'],
];

const REQUIRED = ['index.js', 'signals.js', 'alerts.js', 'sources.js', 'telegram.js', 'package.json', 'README.md', 'LICENSE', 'test/monitor.test.js'];

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

function copyTree(src, dest, exclude) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (exclude && exclude.has(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else fs.copyFileSync(from, to);
  }
}

function listFiles(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === '.git') return [];
    const p = path.join(dir, e.name);
    return e.isDirectory() ? listFiles(p, base) : [path.relative(base, p)];
  });
}

function build() {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'flush-monitor-'));
  copyTree(MONITOR, out, EXCLUDE);
  copyTree(STANDALONE, out, new Set(['.DS_Store']));
  // Keep the executable bit on the NAS scripts.
  for (const f of listFiles(out)) if (f.endsWith('.sh')) fs.chmodSync(path.join(out, f), 0o755);
  return out;
}

function verify(out) {
  const problems = [];
  const files = listFiles(out);

  for (const f of REQUIRED) if (!files.includes(f)) problems.push(`missing required file ${f}`);

  for (const f of files) {
    const full = path.join(out, f);
    const text = fs.readFileSync(full, 'utf8');
    for (const [re, what] of FORBIDDEN) if (re.test(text)) problems.push(`${f}: contains ${what} (${re})`);
    if (!f.endsWith('.js')) continue;
    // Every relative require must resolve inside the standalone tree;
    // anything else only exists in the calculator repo.
    for (const m of text.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
      const target = path.resolve(path.dirname(full), m[1]);
      const inside = target.startsWith(out + path.sep);
      const exists = [target, `${target}.js`, path.join(target, 'index.js')].some((p) => fs.existsSync(p));
      if (!inside || !exists) problems.push(`${f}: require('${m[1]}') doesn't resolve inside the standalone repo`);
    }
    try {
      execFileSync(process.execPath, ['--check', full], { stdio: 'pipe' });
    } catch (err) {
      problems.push(`${f}: syntax error\n${String(err.stderr || err.message).trim()}`);
    }
  }

  if (!problems.length) {
    try {
      execFileSync(process.execPath, ['test/monitor.test.js'], { cwd: out, stdio: 'pipe' });
    } catch (err) {
      problems.push(`tests fail in the standalone tree:\n${String(err.stdout || '').split('\n').filter((l) => /FAIL/.test(l)).join('\n')}`);
    }
  }
  return problems;
}

function git(cwd, ...a) {
  return execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
}

function main() {
  const out = build();
  const problems = verify(out);
  if (problems.length) {
    console.error('✗ Not synced: the standalone flush-monitor would break or leak private details.\n');
    for (const p of problems) console.error(`  - ${p}`);
    console.error('\nFix monitor/ (or monitor/standalone/), or decide how the standalone repo should change.');
    process.exit(1);
  }
  console.log(`✓ Standalone build passes all checks (${listFiles(out).length} files).`);

  const target = option('--target');
  if (flag('--check') || !target) return;

  const dest = path.resolve(target);
  if (!fs.existsSync(path.join(dest, '.git'))) throw new Error(`--target ${dest} is not a git clone of the standalone repo`);
  // Replace the clone's contents with the build, so deletions mirror too.
  for (const f of listFiles(dest)) fs.rmSync(path.join(dest, f));
  copyTree(out, dest);
  git(dest, 'add', '-A');
  if (!git(dest, 'status', '--porcelain')) {
    console.log('✓ Standalone repo already matches monitor/; nothing to commit.');
    return;
  }
  const sha = git(REPO_ROOT, 'rev-parse', '--short', 'HEAD');
  const subject = git(REPO_ROOT, 'log', '-1', '--format=%s');
  git(dest, 'commit', '-q', '-m', `${subject}\n\nMirrored from monitor/ in the leverage calculator repo at ${sha}.`);
  console.log(`✓ Committed to ${dest}: ${subject}`);
  if (flag('--push')) {
    git(dest, 'push', '-q');
    console.log('✓ Pushed.');
  }
}

main();
