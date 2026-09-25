#!/bin/sh
# Runs pending migrations, then execs the server — never serves traffic
# against a half-migrated or blocked database. `push` takes a Postgres
# advisory lock, so concurrent replicas starting at once serialize instead
# of racing. See scripts/migrate.mjs and DEPLOYMENT.md's "Migrations"
# section. `set -e` aborts before the exec on any non-zero exit (including
# a refused push, e.g. an unresolved prior failure or a pooled DATABASE_URL).
set -e
node scripts/migrate.mjs push
exec node dist/index.js
