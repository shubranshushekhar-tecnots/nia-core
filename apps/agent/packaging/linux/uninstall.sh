#!/usr/bin/env bash
# Uninstalls the Nia Agent systemd service. Leaves /etc/nia-agent (config,
# encrypted secrets, spool, logs, status) in place by default — pass
# --purge to remove it too. Run as root.
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "must run as root (sudo)" >&2
  exit 1
fi

systemctl stop nia-agent 2>/dev/null || true
systemctl disable nia-agent 2>/dev/null || true
rm -f /etc/systemd/system/nia-agent.service
systemctl daemon-reload
rm -rf /opt/nia-agent

if [[ "${1:-}" == "--purge" ]]; then
  rm -rf /etc/nia-agent
  echo "uninstalled, including /etc/nia-agent (config/secrets/logs removed)"
else
  echo "uninstalled. /etc/nia-agent (config/secrets/logs) left in place — rerun with --purge to remove it too"
fi
