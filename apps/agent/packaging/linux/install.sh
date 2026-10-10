#!/usr/bin/env bash
# Installs the Nia Core Agent as a systemd service. Run as root on the target
# Linux host, with a bundle tarball built by build-bundle.sh:
#   sudo ./install.sh /path/to/nia-core-agent-linux-<version>.tar.gz
#
# Idempotent: safe to re-run with a newer tarball to upgrade in place
# (stops the service, replaces /opt/nia-agent, restarts) — /etc/nia-agent
# (config/secrets/spool/logs/status) is never touched by this script.
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "must run as root (sudo)" >&2
  exit 1
fi

BUNDLE="${1:-}"
if [[ -z "$BUNDLE" || ! -f "$BUNDLE" ]]; then
  echo "usage: $0 <path-to-nia-core-agent-linux-VERSION.tar.gz>" >&2
  exit 1
fi

INSTALL_DIR=/opt/nia-agent
DATA_DIR=/etc/nia-agent
SERVICE_FILE=/etc/systemd/system/nia-agent.service
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! id nia-agent >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin nia-agent
fi

SERVICE_WAS_RUNNING=false
if systemctl is-active --quiet nia-agent 2>/dev/null; then
  SERVICE_WAS_RUNNING=true
  systemctl stop nia-agent
fi

rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
tar -xzf "$BUNDLE" -C "$INSTALL_DIR"
chown -R root:root "$INSTALL_DIR"

mkdir -p "$DATA_DIR"
chown nia-agent:nia-agent "$DATA_DIR"
chmod 700 "$DATA_DIR"

cp "$SCRIPT_DIR/nia-agent.service" "$SERVICE_FILE"
systemctl daemon-reload
systemctl enable nia-agent

if [[ "$SERVICE_WAS_RUNNING" == true ]]; then
  systemctl start nia-agent
  echo "upgraded and restarted nia-agent"
else
  echo "installed."
  if [[ -t 0 && -t 1 ]]; then
    read -r -p "Run guided setup now? [Y/n] " REPLY
    if [[ -z "$REPLY" || "$REPLY" =~ ^[Yy] ]]; then
      sudo -u nia-agent node "$INSTALL_DIR/dist/index.js" setup
    else
      cat <<EOF
Skipped. Run it later with:
  sudo -u nia-agent node $INSTALL_DIR/dist/index.js setup
EOF
    fi
  else
    cat <<EOF
Next steps:
  sudo -u nia-agent node $INSTALL_DIR/dist/index.js setup
  sudo -u nia-agent node $INSTALL_DIR/dist/index.js doctor
  systemctl start nia-agent
  systemctl status nia-agent
EOF
  fi
fi
