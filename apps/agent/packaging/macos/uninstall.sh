#!/usr/bin/env bash
# Uninstalls the Nia Core Agent launchd service on macOS. Leaves the data dir
# (config, encrypted secrets, spool, logs, status) in place by default —
# pass --purge to remove it too.
#
#   ./uninstall.sh                     # per-user install (default)
#   sudo ./uninstall.sh --system       # system-wide install
#
# --label/--home/--log-dir must match whatever was passed to install.sh,
# if anything non-default was used.
set -euo pipefail

SYSTEM=false
PURGE=false
LABEL="com.nia.agent"
HOME_DIR=""
LOG_DIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --system) SYSTEM=true; shift ;;
    --purge) PURGE=true; shift ;;
    --label) LABEL="$2"; shift 2 ;;
    --home) HOME_DIR="$2"; shift 2 ;;
    --log-dir) LOG_DIR="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [[ "$SYSTEM" == true && "${EUID}" -ne 0 ]]; then
  echo "--system uninstall must run as root (sudo)" >&2
  exit 1
fi

if [[ "$SYSTEM" == true ]]; then
  HOME_DIR="${HOME_DIR:-/Library/Application Support/NiaAgent}"
  LOG_DIR="${LOG_DIR:-/Library/Logs/NiaAgent}"
  PLIST_PATH="/Library/LaunchDaemons/$LABEL.plist"
  DOMAIN="system"
else
  REAL_HOME="${HOME:-$(eval echo ~"$(whoami)")}"
  HOME_DIR="${HOME_DIR:-$REAL_HOME/Library/Application Support/NiaAgent}"
  LOG_DIR="${LOG_DIR:-$REAL_HOME/Library/Logs/NiaAgent}"
  PLIST_PATH="$REAL_HOME/Library/LaunchAgents/$LABEL.plist"
  DOMAIN="gui/$(id -u)"
fi

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
rm -f "$PLIST_PATH"
rm -rf "$HOME_DIR/bin"

# The desktop app shell is just a binary (like $HOME_DIR/bin above), not user
# data -- always remove it, regardless of --purge. Quietly a no-op on
# service-only installs that never had it.
APP_BUNDLE_DEST="/Applications/Nia Core Agent.app"
if [[ -d "$APP_BUNDLE_DEST" ]]; then
  # Quit a running instance first -- same reasoning as install.sh: graceful
  # quit, then a forced kill if it ignored the request or isn't responding.
  osascript -e 'tell application "Nia Core Agent" to quit' >/dev/null 2>&1 || true
  sleep 1.5
  pkill -f "$APP_BUNDLE_DEST/Contents/MacOS/" >/dev/null 2>&1 || true
fi
rm -rf "$APP_BUNDLE_DEST"

if [[ "$PURGE" == true ]]; then
  rm -rf "$HOME_DIR"
  rm -rf "$LOG_DIR"
  echo "uninstalled $LABEL, including data dir ($HOME_DIR) and logs ($LOG_DIR)"
else
  echo "uninstalled $LABEL. Data dir ($HOME_DIR) and logs ($LOG_DIR) left in place — rerun with --purge to remove them too"
fi
