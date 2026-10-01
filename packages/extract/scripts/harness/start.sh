#!/usr/bin/env bash
# Boots a throwaway mcr.microsoft.com/mssql/server container (not part of
# docker-compose.yml's dev sandbox) and seeds it. Tear down with stop.sh.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
source ./config.sh

if docker ps -a --format '{{.Names}}' | grep -qx "$NIA_EXTRACT_MSSQL_CONTAINER"; then
  echo "Removing existing $NIA_EXTRACT_MSSQL_CONTAINER container first..."
  docker rm -f "$NIA_EXTRACT_MSSQL_CONTAINER" >/dev/null
fi

echo "Starting $NIA_EXTRACT_MSSQL_CONTAINER (amd64, emulated — no arm64 image exists)..."
docker run -d \
  --platform linux/amd64 \
  --name "$NIA_EXTRACT_MSSQL_CONTAINER" \
  --memory=3g \
  -e "ACCEPT_EULA=Y" \
  -e "MSSQL_SA_PASSWORD=$NIA_EXTRACT_MSSQL_PASSWORD" \
  -e "MSSQL_PID=Developer" \
  -p "$NIA_EXTRACT_MSSQL_PORT:1433" \
  mcr.microsoft.com/mssql/server:2022-latest >/dev/null

echo "Waiting for SQL Server to accept connections..."
for i in $(seq 1 60); do
  if docker exec "$NIA_EXTRACT_MSSQL_CONTAINER" /opt/mssql-tools18/bin/sqlcmd -C -S localhost -U "$NIA_EXTRACT_MSSQL_USER" -P "$NIA_EXTRACT_MSSQL_PASSWORD" -Q "SELECT 1" >/dev/null 2>&1; then
    echo "Ready after ${i}x2s."
    break
  fi
  if [ "$i" -eq 60 ]; then
    echo "SQL Server did not become ready in time." >&2
    docker logs --tail 50 "$NIA_EXTRACT_MSSQL_CONTAINER" >&2
    exit 1
  fi
  sleep 2
done

echo "Seeding..."
docker exec -i "$NIA_EXTRACT_MSSQL_CONTAINER" /opt/mssql-tools18/bin/sqlcmd -C -S localhost -U "$NIA_EXTRACT_MSSQL_USER" -P "$NIA_EXTRACT_MSSQL_PASSWORD" < ./seed.sql

echo "Harness ready at $NIA_EXTRACT_MSSQL_HOST:$NIA_EXTRACT_MSSQL_PORT / db $NIA_EXTRACT_MSSQL_DATABASE."
