#!/usr/bin/env bash
# Shared config for the throwaway legacy-TLS SQL Server test harness
# (Phase 3b Slice 8 — proving allowLegacyTls against a server forced to
# TLS 1.0-only). Separate container/port from config.sh's normal harness
# so both can run side by side; never part of docker-compose.yml.
export NIA_EXTRACT_MSSQL_LEGACY_TLS_CONTAINER="nia-extract-mssql-legacy-tls-test"
export NIA_EXTRACT_MSSQL_LEGACY_TLS_HOST="localhost"
export NIA_EXTRACT_MSSQL_LEGACY_TLS_PORT="14331"
export NIA_EXTRACT_MSSQL_LEGACY_TLS_USER="sa"
# Throwaway local test container only, torn down after every run — not a
# real secret.
export NIA_EXTRACT_MSSQL_LEGACY_TLS_PASSWORD="N!aExtractLegacyTlsTest_2026"
export NIA_EXTRACT_MSSQL_LEGACY_TLS_DATABASE="master"
