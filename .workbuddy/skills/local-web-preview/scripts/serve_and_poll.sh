#!/usr/bin/env bash
# serve_and_poll.sh — start a local static server detached, poll until ready.
#
# Usage:
#   bash serve_and_poll.sh <SITE_DIR> [PORT] [PYTHON_EXEC]
#
# Examples:
#   bash serve_and_poll.sh "/d/游戏产物/anime-strategy-game" 3000
#   PYTHON_EXEC="/c/Users/MECHREVO/.workbuddy/binaries/python/versions/3.13.12/python.exe" \
#     bash serve_and_poll.sh "/d/游戏产物/anime-strategy-game" 8080
#
# Behavior:
#   1. cd into SITE_DIR (bash path — NO "cd /d", that is cmd.exe only)
#   2. launch `python -m http.server PORT --bind 127.0.0.1` detached (nohup + & + disown)
#   3. poll http://127.0.0.1:PORT/ until HTTP 200 (curl, fallback python socket check)
#   4. print "READY http://127.0.0.1:PORT/" and exit 0, leaving the server running
#   On failure: print the server log and exit 2.
#
# The server survives the launching shell because it is detached, so the agent
# can then navigate a browser to the printed URL.

set -u

DIR="${1:-.}"
PORT="${2:-3000}"
PY="${3:-${PYTHON_EXEC:-python}}"

# --- 1. cd (bash syntax; never "cd /d") ---
if ! cd "$DIR" 2>/dev/null; then
  echo "ERR: cannot cd to '$DIR' (use a bash path, e.g. /d/foo or /c/Users/foo; not 'cd /d')"
  exit 1
fi

# --- 2. resolve python ---
if ! command -v "$PY" >/dev/null 2>&1; then
  if command -v python3 >/dev/null 2>&1; then PY=python3
  elif command -v python >/dev/null 2>&1; then PY=python
  else
    echo "ERR: no python interpreter found. Set PYTHON_EXEC or pass it as arg3."
    exit 3
  fi
fi

LOG="/tmp/serve_and_poll_${PORT}.log"

# --- 3. start detached ---
nohup "$PY" -m http.server "$PORT" --bind 127.0.0.1 >"$LOG" 2>&1 &
SRV_PID=$!
disown "$SRV_PID" 2>/dev/null || true

echo "started pid=$SRV_PID on 127.0.0.1:$PORT; polling..."

# --- 4. poll ---
URL="http://127.0.0.1:${PORT}/"
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$URL" 2>/dev/null)
  if [ "$code" = "200" ]; then
    echo "READY $URL"
    exit 0
  fi
  # fallback when curl is unavailable
  if [ -z "$code" ]; then
    if "$PY" -c "import socket,sys; s=socket.socket(); s.settimeout(1); sys.exit(0 if s.connect_ex(('127.0.0.1',${PORT}))==0 else 1)" 2>/dev/null; then
      echo "READY $URL"
      exit 0
    fi
  fi
  sleep 1
done

echo "TIMEOUT: server not ready after 30s. last log ($LOG):"
cat "$LOG" 2>/dev/null
exit 2
