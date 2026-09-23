#!/usr/bin/env bash
set -euo pipefail

# One-off Supabase migration runner — a release step, never invoked at
# service startup (no service Dockerfile/CMD calls this). Shared verbatim
# by the root package.json scripts (migrate:status/push/verify) and by
# supabase/migrate.Dockerfile's ENTRYPOINT, so there's one implementation
# instead of two that can drift.
#
# Migration compatibility rule (see DEPLOYMENT.md): every migration must
# work with both the old and new app code running against it at the same
# time, since both do during a deploy. Add a column as nullable, deploy,
# backfill, tighten later; never drop or rename a column the current code
# still uses.

cmd="${1:-}"
: "${DATABASE_URL:?DATABASE_URL is required (direct Postgres connection string, percent-encoded)}"

case "$cmd" in
  status)
    supabase migration list --db-url "$DATABASE_URL"
    ;;

  push)
    supabase db push --db-url "$DATABASE_URL"
    ;;

  verify)
    # CI dry-run: fail if a migration file that's already applied to
    # $DATABASE_URL was modified in this change. Needs `jq` and a git
    # checkout with history back to $MIGRATE_BASE_REF — run this directly
    # in CI (not via the migrate container image, which has no .git).
    command -v jq >/dev/null 2>&1 || {
      echo "ERROR: 'jq' is required for verify (and 'git', for a real checkout)." >&2
      exit 1
    }
    git rev-parse --is-inside-work-tree >/dev/null 2>&1 || {
      echo "ERROR: verify requires a git checkout with history — run it as a CI step against the full repo, not inside the migrate container image." >&2
      exit 1
    }

    base_ref="${MIGRATE_BASE_REF:-origin/main}"
    applied_versions="$(
      supabase migration list --db-url "$DATABASE_URL" --output-format json \
        | jq -r '.migrations[] | select(.remote != "" and .remote != null) | .local'
    )"
    changed_files="$(git diff --name-only "${base_ref}...HEAD" -- supabase/migrations || true)"

    fail=0
    for f in $changed_files; do
      version="$(basename "$f" | cut -d'_' -f1)"
      if grep -qx "$version" <<<"$applied_versions"; then
        echo "ERROR: $f is already applied to the target database and was modified in this change." >&2
        echo "Migrations are forward-only/additive — add a new migration instead of editing this one." >&2
        fail=1
      fi
    done

    if [ "$fail" -ne 0 ]; then
      exit 1
    fi
    echo "OK: no already-applied migrations were modified."
    ;;

  *)
    echo "Usage: migrate.sh {status|push|verify}" >&2
    exit 1
    ;;
esac
