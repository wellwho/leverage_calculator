#!/bin/sh
# Stops run.sh and the node process it supervises.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PIDFILE="$ROOT/run.pid"
if [ -f "$PIDFILE" ] && grep -q "run.sh" "/proc/$(cat "$PIDFILE")/cmdline" 2>/dev/null; then
  kill "$(cat "$PIDFILE")"
  pkill -f "$ROOT/monitor/index.js"
  rm -f "$PIDFILE"
  echo "flush monitor stopped"
else
  rm -f "$PIDFILE"
  echo "flush monitor was not running"
fi
