#!/bin/sh
# Runs the flush monitor on a Synology NAS without Docker (Synology's Node.js
# package instead), restarting it if it ever exits. Started at boot by DSM
# Task Scheduler via start.sh; see monitor/README.md "Synology without Docker".
#
# Layout on the NAS (copied from the repo):
#   ~/flushmon/bybitClient.js                  shared Bybit client (bybitOk/bybitErrMsg)
#   ~/flushmon/monitor/                        this folder, incl. .env
#   ~/flushmon/data/                           state + readings (created here)
#   ~/flushmon/logs/monitor.log                stdout/stderr

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NODE="${NODE:-/usr/local/bin/node}"
LOG="$ROOT/logs/monitor.log"
mkdir -p "$ROOT/data" "$ROOT/logs"

set -a
. "$ROOT/monitor/.env"
set +a
export DATA_DIR="$ROOT/data"

while true; do
  # Keep one previous log; the monitor itself only logs errors and startups.
  if [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 5000000 ]; then mv "$LOG" "$LOG.1"; fi
  # Heap capped so it can't crowd out Plex on a 1 GB NAS.
  "$NODE" --max-old-space-size=96 "$ROOT/monitor/index.js" >> "$LOG" 2>&1
  echo "$(date '+%Y-%m-%d %H:%M:%S') monitor exited with $?, restarting in 30s" >> "$LOG"
  sleep 30
done
