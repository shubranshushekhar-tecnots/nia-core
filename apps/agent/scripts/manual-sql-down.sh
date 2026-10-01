#!/usr/bin/env bash
# Tears down the throwaway SQL Server test harness started by
# manual-sql-up.sh. No confirmation needed — this only ever removes the
# dedicated nia-extract-mssql-test container, never the dev sandbox.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
exec "$ROOT/packages/extract/scripts/harness/stop.sh"
