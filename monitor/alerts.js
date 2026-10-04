// When to send a message — pure state transitions, no I/O, so the rules that
// decide whether your phone buzzes are pinned by tests rather than found out
// at 3am.
//
// Every alert stream (flush risk per symbol, liquidation distance per
// position) has levels 0 (quiet), 1 (elevated/warning) and 2 (high/danger),
// and follows the same rules:
//   - going UP to a level that hasn't been announced yet sends immediately;
//   - staying at an active level re-sends only every `repeatMs` (a reminder,
//     not a stream of duplicates);
//   - stepping DOWN between active levels is silent, and stepping back up
//     to a level already announced in this episode waits for the repeat
//     timer, so a reading oscillating around a threshold can't spam;
//   - returning to 0 sends one "all clear", but only once the reading is
//     past a separate, more lenient clear threshold (`hold` keeps it at
//     level 1 until then), for the same anti-flapping reason.

function decide(prev, computedLevel, hold, now, repeatMs) {
  const p = prev || { level: 0, lastSentLevel: 0, lastSentAt: 0 };
  const level = computedLevel === 0 && p.level > 0 && hold ? 1 : computedLevel;
  const next = { level, lastSentLevel: p.lastSentLevel, lastSentAt: p.lastSentAt };

  if (level === 0) {
    if (p.level > 0) return { send: 'clear', state: { level: 0, lastSentLevel: 0, lastSentAt: now } };
    return { send: null, state: next };
  }
  if (level > p.lastSentLevel) {
    return { send: 'raise', state: { level, lastSentLevel: level, lastSentAt: now } };
  }
  if (now - p.lastSentAt >= repeatMs) {
    return { send: 'repeat', state: { level, lastSentLevel: Math.max(level, p.lastSentLevel), lastSentAt: now } };
  }
  return { send: null, state: next };
}

// Flush-risk score (0..1) -> level. `clear` sits below `elevated` so the
// all-clear needs a real step down, not one tick under the threshold.
function riskLevel(score, t) {
  if (!Number.isFinite(score)) return null;
  const level = score >= t.high ? 2 : score >= t.elevated ? 1 : 0;
  return { level, hold: score >= t.clear };
}

// Liquidation distance (fraction of price) -> level. Closer is worse.
function liqLevel(distance, t) {
  if (!Number.isFinite(distance)) return null;
  const level = distance <= t.danger ? 2 : distance <= t.warn ? 1 : 0;
  return { level, hold: distance <= t.warn * 1.25 };
}

module.exports = { decide, riskLevel, liqLevel };
