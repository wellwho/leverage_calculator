// When to send a message — pure state transitions, no I/O, so the rules that
// decide whether your phone buzzes are pinned by tests rather than found out
// at 3am.
//
// Every alert stream (flush risk for BTC, and for the market basket) has
// levels 0 (quiet), 1 (elevated) and 2 (high), and follows the same rules:
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

// Market basket -> level. The OI-weighted score sets the level as for a
// single coin, and breadth can lift it to at least elevated: when most of
// the majors are stretched at once (`breadth.elevated`, default 70%), that's
// a market-wide warning even if BTC's heavy weight keeps the average lower.
// Breadth also holds an active alert until it falls below `breadth.hold`.
function marketLevel(score, breadthShare, t, breadth) {
  const base = riskLevel(score, t);
  if (!base) return null;
  return {
    level: Math.max(base.level, breadthShare >= breadth.elevated ? 1 : 0),
    hold: base.hold || breadthShare >= breadth.hold,
  };
}

module.exports = { decide, riskLevel, marketLevel };
