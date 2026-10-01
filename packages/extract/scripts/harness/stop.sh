#!/usr/bin/env bash
# Tears down the throwaway SQL Server test container started by start.sh.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
source ./config.sh

if docker ps -a --format '{{.Names}}' | grep -qx "$NIA_EXTRACT_MSSQL_CONTAINER"; then
  docker rm -f "$NIA_EXTRACT_MSSQL_CONTAINER" >/dev/null
  echo "Removed $NIA_EXTRACT_MSSQL_CONTAINER."
else
  echo "$NIA_EXTRACT_MSSQL_CONTAINER not running."
fi
