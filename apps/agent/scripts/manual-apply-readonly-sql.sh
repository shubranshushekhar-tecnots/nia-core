#!/usr/bin/env bash
# Generates the read-only SQL Server login script via the existing, already-
# tested `nia-agent sql readonly` command, substitutes the placeholder
# password with the test harness's own throwaway password (not a real
# secret — see packages/extract/scripts/harness/config.sh), and applies it
# directly to the running test container via sqlcmd (same pattern the
# harness's own start.sh already uses to seed data). Never touches the dev
# sandbox DB.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
source "$ROOT/packages/extract/scripts/harness/config.sh"

LOGIN_NAME="${NIA_AGENT_READONLY_LOGIN:-nia_agent_readonly}"

echo "Generating read-only login script for login '$LOGIN_NAME' on database '$NIA_EXTRACT_MSSQL_DATABASE'..."
SCRIPT="$(cd "$ROOT" && pnpm --filter @nia/agent exec tsx src/index.ts sql readonly --login "$LOGIN_NAME" --databases "$NIA_EXTRACT_MSSQL_DATABASE" --with-cancel-visibility true)"

echo "Applying to $NIA_EXTRACT_MSSQL_CONTAINER..."
echo "$SCRIPT" | sed "s/<CHANGE_ME_STRONG_PASSWORD>/${NIA_EXTRACT_MSSQL_PASSWORD}/" \
  | docker exec -i "$NIA_EXTRACT_MSSQL_CONTAINER" /opt/mssql-tools18/bin/sqlcmd -C -S localhost -U "$NIA_EXTRACT_MSSQL_USER" -P "$NIA_EXTRACT_MSSQL_PASSWORD"

echo "Read-only login '$LOGIN_NAME' applied. Password: $NIA_EXTRACT_MSSQL_PASSWORD (throwaway test harness only, never a real secret)."
