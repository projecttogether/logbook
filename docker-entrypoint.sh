#!/bin/sh
set -e

role="${1:-web}"
export LOGBOOK_PROCESS="$role"

case "$role" in
  web)
    exec node server.js
    ;;
  worker)
    exec node dist/worker.mjs
    ;;
  migrate)
    exec node dist/migrate.mjs
    ;;
  directory-sync)
    exec node dist/directory-sync.mjs
    ;;
  cli)
    # The operator command (src/cli/entry.ts): `cli settings …`.
    shift
    exec node /app/dist/cli.mjs "$@"
    ;;
  *)
    exec "$@"
    ;;
esac
