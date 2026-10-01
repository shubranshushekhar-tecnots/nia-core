#!/usr/bin/env bash
# Boots a throwaway mcr.microsoft.com/mssql/server container (separate
# from start.sh's normal harness — different container name/port, can run
# side by side) and forces it to accept TLS 1.0 only, via mssql-conf
# (docs: network.tlsprotocols). Proves whether apps/agent's
# allowLegacyTls (packages/extract/src/mssql/connection.ts) actually
# lets a connection succeed against real legacy-TLS SQL Server, and that
# a normal connection against the same server fails clearly without it.
# Tear down with stop-legacy-tls.sh.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
source ./config-legacy-tls.sh

if docker ps -a --format '{{.Names}}' | grep -qx "$NIA_EXTRACT_MSSQL_LEGACY_TLS_CONTAINER"; then
  echo "Removing existing $NIA_EXTRACT_MSSQL_LEGACY_TLS_CONTAINER container first..."
  docker rm -f "$NIA_EXTRACT_MSSQL_LEGACY_TLS_CONTAINER" >/dev/null
fi

echo "Starting $NIA_EXTRACT_MSSQL_LEGACY_TLS_CONTAINER (amd64, emulated — no arm64 image exists)..."
docker run -d \
  --platform linux/amd64 \
  --name "$NIA_EXTRACT_MSSQL_LEGACY_TLS_CONTAINER" \
  --memory=3g \
  -e "ACCEPT_EULA=Y" \
  -e "MSSQL_SA_PASSWORD=$NIA_EXTRACT_MSSQL_LEGACY_TLS_PASSWORD" \
  -e "MSSQL_PID=Developer" \
  -p "$NIA_EXTRACT_MSSQL_LEGACY_TLS_PORT:1433" \
  mcr.microsoft.com/mssql/server:2022-latest >/dev/null

echo "Waiting for SQL Server to accept connections (normal TLS, before restricting)..."
for i in $(seq 1 60); do
  if docker exec "$NIA_EXTRACT_MSSQL_LEGACY_TLS_CONTAINER" /opt/mssql-tools18/bin/sqlcmd -C -S localhost -U "$NIA_EXTRACT_MSSQL_LEGACY_TLS_USER" -P "$NIA_EXTRACT_MSSQL_LEGACY_TLS_PASSWORD" -Q "SELECT 1" >/dev/null 2>&1; then
    echo "Ready after ${i}x2s."
    break
  fi
  if [ "$i" -eq 60 ]; then
    echo "SQL Server did not become ready in time." >&2
    docker logs --tail 50 "$NIA_EXTRACT_MSSQL_LEGACY_TLS_CONTAINER" >&2
    exit 1
  fi
  sleep 2
done

echo "Restricting network.tlsprotocols to 1.0 only..."
docker exec "$NIA_EXTRACT_MSSQL_LEGACY_TLS_CONTAINER" /opt/mssql/bin/mssql-conf set network.tlsprotocols 1.0

# mssql-conf's setting alone is NOT enough: sqlservr links the image's system
# OpenSSL (3.0.2 on this Ubuntu 22.04 base), whose /etc/ssl/openssl.cnf ships
# `CipherString = DEFAULT:@SECLEVEL=2` — OpenSSL's own policy, which refuses
# TLS below 1.2 outright regardless of what network.tlsprotocols allows.
# Confirmed empirically: with SECLEVEL=2 left in place, `openssl s_client
# -tls1` run from INSIDE this same container (not just the host) fails with
# "no protocols available" even after setting network.tlsprotocols=1.0.
# Patch it down to 0 (sqlservr runs as the unprivileged `mssql` user, so a
# plain `docker exec` can't write this root-owned file — `--user root`
# bypasses only the container's internal user, not any host boundary; this
# container is throwaway and torn down by stop-legacy-tls.sh regardless).
echo "Lowering OpenSSL SECLEVEL so sqlservr can actually negotiate TLS 1.0..."
docker exec --user root "$NIA_EXTRACT_MSSQL_LEGACY_TLS_CONTAINER" \
  sed -i 's/@SECLEVEL=2/@SECLEVEL=0/' /etc/ssl/openssl.cnf

echo "Restarting the container to apply (mssql-conf changes need a sqlservr restart)..."
RESTART_TS=$(date +%s)
docker restart "$NIA_EXTRACT_MSSQL_LEGACY_TLS_CONTAINER" >/dev/null

# Can't use sqlcmd to probe readiness here: mssql-tools18's own TLS stack
# may itself refuse to negotiate down to TLS 1.0 (the same OpenSSL 3.x
# SECLEVEL issue documented in connection.ts) — so "sqlcmd can't connect"
# would be indistinguishable from "not ready yet". Read the startup log
# message directly instead.
echo "Waiting for SQL Server to report ready after restart..."
for i in $(seq 1 60); do
  if docker logs --since "$RESTART_TS" "$NIA_EXTRACT_MSSQL_LEGACY_TLS_CONTAINER" 2>&1 | grep -q "SQL Server is now ready for client connections"; then
    echo "Ready after ${i}x2s."
    break
  fi
  if [ "$i" -eq 60 ]; then
    echo "SQL Server did not report ready after restart." >&2
    docker logs --since "$RESTART_TS" "$NIA_EXTRACT_MSSQL_LEGACY_TLS_CONTAINER" >&2
    exit 1
  fi
  sleep 2
done

echo "Legacy-TLS harness ready at $NIA_EXTRACT_MSSQL_LEGACY_TLS_HOST:$NIA_EXTRACT_MSSQL_LEGACY_TLS_PORT (TLS 1.0 only)."
