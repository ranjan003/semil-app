#!/usr/bin/env bash
# Starts a throwaway PostgreSQL cluster for tests (needs the postgres OS user, so run as root).
# Usage: bash scripts/pg-sandbox.sh start|stop     Default port 54329, socket in /tmp.
set -euo pipefail
PGD=${PGD:-/var/tmp/semil_pg}; PORT=${PGPORT:-54329}
B=$(ls -d /usr/lib/postgresql/*/bin | sort -V | tail -1)
case "${1:-start}" in
  start)
    if [ ! -d "$PGD" ]; then mkdir -p "$PGD"; chown postgres "$PGD"; chmod 700 "$PGD"; su postgres -c "$B/initdb -D $PGD -A trust >/dev/null"; fi
    su postgres -c "$B/pg_ctl -D $PGD -o '-p $PORT -k /tmp -c fsync=off' -l $PGD/log -w start" >/dev/null
    echo "PostgreSQL ready: PGHOST=/tmp PGPORT=$PORT PGUSER=postgres" ;;
  stop) su postgres -c "$B/pg_ctl -D $PGD -m fast stop" >/dev/null && echo stopped ;;
esac
