#!/usr/bin/env bash
# Installs the Nia Agent as a launchd service on macOS (Apple Silicon).
# Run from the unzipped bundle folder (built by build-bundle.mjs):
#   ./install.sh                     # per-user, starts at login (default)
#   sudo ./install.sh --system       # system-wide, starts at boot, all users
#
# Idempotent: safe to re-run with a newer bundle to upgrade in place (stops
# the service, replaces the installed binary, restarts) — the data dir
# (config/secrets/spool/logs/status) is never touched by this script.
#
# --label, --home, and --log-dir let you install a second, independent
# instance alongside a real one (used by this slice's own verification —
# see docs/pilot/install-guide.md).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SYSTEM=false
LABEL="com.nia.agent"
HOME_DIR=""
LOG_DIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --system) SYSTEM=true; shift ;;
    --label) LABEL="$2"; shift 2 ;;
    --home) HOME_DIR="$2"; shift 2 ;;
    --log-dir) LOG_DIR="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [[ "$SYSTEM" == true && "${EUID}" -ne 0 ]]; then
  echo "--system install must run as root (sudo)" >&2
  exit 1
fi

if [[ "$SYSTEM" == true ]]; then
  HOME_DIR="${HOME_DIR:-/Library/Application Support/NiaAgent}"
  LOG_DIR="${LOG_DIR:-/Library/Logs/NiaAgent}"
  PLIST_DIR="/Library/LaunchDaemons"
  DOMAIN="system"
else
  REAL_HOME="${HOME:-$(eval echo ~"$(whoami)")}"
  HOME_DIR="${HOME_DIR:-$REAL_HOME/Library/Application Support/NiaAgent}"
  LOG_DIR="${LOG_DIR:-$REAL_HOME/Library/Logs/NiaAgent}"
  PLIST_DIR="$REAL_HOME/Library/LaunchAgents"
  DOMAIN="gui/$(id -u)"
fi

PLIST_PATH="$PLIST_DIR/$LABEL.plist"
BIN_DIR="$HOME_DIR/bin"
EXE_PATH="$BIN_DIR/nia-agent"

SERVICE_WAS_LOADED=false
if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  SERVICE_WAS_LOADED=true
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
fi

mkdir -p "$BIN_DIR"
chmod 700 "$HOME_DIR"
cp "$SCRIPT_DIR/nia-agent" "$EXE_PATH"
chmod 755 "$EXE_PATH"

mkdir -p "$LOG_DIR"
chmod 700 "$LOG_DIR"

mkdir -p "$PLIST_DIR"
sed \
  -e "s|__NIA_AGENT_LABEL__|$LABEL|g" \
  -e "s|__NIA_AGENT_EXE__|$EXE_PATH|g" \
  -e "s|__NIA_AGENT_HOME__|$HOME_DIR|g" \
  -e "s|__NIA_AGENT_LOG_DIR__|$LOG_DIR|g" \
  "$SCRIPT_DIR/nia-agent.plist.template" > "$PLIST_PATH"
chmod 644 "$PLIST_PATH"

launchctl bootstrap "$DOMAIN" "$PLIST_PATH"
launchctl enable "$DOMAIN/$LABEL"

if [[ "$SERVICE_WAS_LOADED" == true ]]; then
  echo "upgraded and restarted $LABEL"
else
  cat <<EOF
installed and started $LABEL (runs at login/boot going forward). Next steps:
  NIA_AGENT_HOME="$HOME_DIR" "$EXE_PATH" connection add ...
  NIA_AGENT_HOME="$HOME_DIR" "$EXE_PATH" doctor
  launchctl print $DOMAIN/$LABEL
EOF
fi
