#!/usr/bin/env bash
# Tears down the throwaway legacy-TLS SQL Server test container started
# by start-legacy-tls.sh.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
source ./config-legacy-tls.sh

if docker ps -a --format '{{.Names}}' | grep -qx "$NIA_EXTRACT_MSSQL_LEGACY_TLS_CONTAINER"; then
  docker rm -f "$NIA_EXTRACT_MSSQL_LEGACY_TLS_CONTAINER" >/dev/null
  echo "Removed $NIA_EXTRACT_MSSQL_LEGACY_TLS_CONTAINER."
else
  echo "$NIA_EXTRACT_MSSQL_LEGACY_TLS_CONTAINER not running."
fi
