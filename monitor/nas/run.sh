#!/bin/sh
# Runs the flush monitor without Docker (e.g. on a Synology NAS with the
# Node.js package from Package Center), restarting it if it ever exits.
# Started at boot by DSM Task Scheduler via start.sh; see README.md.
#
# Layout: the repo checkout (index.js, .env, ...), plus data/ (state +
# readings) and logs/monitor.log, both created here.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="${NODE:-/usr/local/bin/node}"
LOG="$ROOT/logs/monitor.log"
mkdir -p "$ROOT/data" "$ROOT/logs"

set -a
. "$ROOT/.env"
set +a
export DATA_DIR="$ROOT/data"

while true; do
  # Keep one previous log; the monitor itself only logs errors and startups.
  if [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 5000000 ]; then mv "$LOG" "$LOG.1"; fi
  # Heap capped so it stays polite on a small (1 GB) NAS.
  "$NODE" --max-old-space-size=96 "$ROOT/index.js" >> "$LOG" 2>&1
  echo "$(date '+%Y-%m-%d %H:%M:%S') monitor exited with $?, restarting in 30s" >> "$LOG"
  sleep 30
done
