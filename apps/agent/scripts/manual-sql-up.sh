#!/usr/bin/env bash
# Starts the throwaway SQL Server test harness (packages/extract/scripts/
# harness) for manual agent testing (docs/manual-testing/agent.md). The
# container is amd64-emulated on Apple Silicon and competes for memory/CPU
# with the dev sandbox if both run at once, so this asks for confirmation
# first. Never touches docker-compose.yml's dev sandbox.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

echo "This starts a throwaway SQL Server 2022 test container (amd64-emulated on Apple Silicon)."
read -r -p "Confirm the dev sandbox (docker-compose.yml's postgres/redis/connector-*) is stopped, and Rosetta 2 is enabled. Continue? [y/N] " reply
case "$reply" in
  [yY]|[yY][eE][sS]) ;;
  *)
    echo "Aborted."
    exit 1
    ;;
esac

exec "$ROOT/packages/extract/scripts/harness/start.sh"
