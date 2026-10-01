#!/usr/bin/env bash
# Shared config for the throwaway SQL Server test harness (Phase 1 Slice 4).
# Not added to docker-compose.yml on purpose — this is a one-off container
# started/stopped by start.sh/stop.sh, never part of the dev sandbox.
export NIA_EXTRACT_MSSQL_CONTAINER="nia-extract-mssql-test"
export NIA_EXTRACT_MSSQL_HOST="localhost"
export NIA_EXTRACT_MSSQL_PORT="14330"
export NIA_EXTRACT_MSSQL_USER="sa"
# Throwaway local test container only, torn down after every run — not a
# real secret.
export NIA_EXTRACT_MSSQL_PASSWORD="N!aExtractTest_2026"
export NIA_EXTRACT_MSSQL_DATABASE="nia_extract_test"
