#!/bin/sh
# Starts run.sh in the background unless it's already running. Safe to call
# repeatedly (DSM Task Scheduler boot task, or by hand after an update).
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PIDFILE="$ROOT/run.pid"
# After a reboot the old pid may belong to an unrelated process, so also
# check that it really is run.sh.
if [ -f "$PIDFILE" ] && grep -q "run.sh" "/proc/$(cat "$PIDFILE")/cmdline" 2>/dev/null; then
  echo "flush monitor already running (pid $(cat "$PIDFILE"))"
  exit 0
fi
nohup /bin/sh "$ROOT/monitor/nas/run.sh" > /dev/null 2>&1 &
echo $! > "$PIDFILE"
echo "flush monitor started (pid $!)"
