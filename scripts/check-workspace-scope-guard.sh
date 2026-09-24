#!/usr/bin/env bash
# Fails the build on a raw org_id/owner_id comparison inside apps/worker/src
# that doesn't go through packages/db's workspaceWhere() — see
# packages/db/src/workspaceScope.ts's header comment and
# docs/plans/data-access.md's Step 3. apps/worker runs entirely under
# service_role with no RLS backstop, so a hand-rolled scope comparison
# there (instead of the one canonical workspaceWhere()) is a real tenant-
# isolation bug, not a style nit.
#
# Scope is deliberately apps/worker/src only, not apps/api or apps/web:
# those two are RLS-backed (a missing/wrong scope clause there still can't
# leak cross-tenant rows, Postgres enforces it independently), so the
# guard's job is specifically the one place that scoping is
# application-level only.
#
# ALLOWLIST below holds every apps/worker/src file that still has the
# pre-migration inline ternary (`"orgId" in scope ? query.eq("org_id", ...)
# : ...`) or, post-conversion, a raw SQL-text org_id/owner_id comparison.
# Remove a file from this list the moment it's converted to call
# workspaceWhere() instead — the guard failing on a file you just converted
# means the conversion missed a spot.
set -euo pipefail

cd "$(dirname "$0")/.."

ALLOWLIST=(
)

is_allowlisted() {
  local f="$1"
  for allowed in "${ALLOWLIST[@]+"${ALLOWLIST[@]}"}"; do
    [[ "$f" == "$allowed" ]] && return 0
  done
  return 1
}

# Matches both the pre-migration Supabase-builder style
# (.eq("org_id", ...) / .is("org_id", ...) / same for owner_id) and the
# post-migration raw-SQL-text style (org_id = $1, owner_id is null, ...),
# so this guard stays useful before and after a given file converts.
PATTERN='\.(eq|is)\(\s*["'"'"'](org_id|owner_id)["'"'"']|["'"'"'`][^"'"'"'`]*\b(org_id|owner_id)\b\s*(=|is)\s*(\$|null)'

violations=""
while IFS= read -r -d '' file; do
  rel="${file#./}"
  is_allowlisted "$rel" && continue
  if grep -qE "$PATTERN" "$file"; then
    violations+="$rel"$'\n'
  fi
done < <(find apps/worker/src -name "*.ts" -print0)

if [[ -n "$violations" ]]; then
  echo "workspace-scope guard: raw org_id/owner_id comparison found outside workspaceWhere() in:" >&2
  echo "$violations" >&2
  echo "Use packages/db's workspaceWhere() instead, or add the file to ALLOWLIST in scripts/check-workspace-scope-guard.sh if it is not yet migrated (docs/plans/data-access.md Step 3)." >&2
  exit 1
fi

echo "workspace-scope guard: OK (no unscoped org_id/owner_id comparisons outside the allowlist)."
