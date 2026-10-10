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

# The local API's token and port files (see config/paths.ts's localApiDir())
# get an extra ACL entry on --system installs only: the daemon runs as
# root, but the token must still be readable by the user who ran the
# installer so their own (non-root) desktop app can use the local API
# without needing to run as root itself. A --user install has no such
# split -- the daemon and the desktop app both already run as the same
# logged-in user -- so this is skipped there; plain owner-only 700 is
# already correct. Pre-creating the folder here (rather than leaving it to
# the agent's own lazy mkdir on first run) means the ACL is in place before
# the token file is ever written.
LOCAL_API_DIR="$HOME_DIR/local-api"
mkdir -p "$LOCAL_API_DIR"
chmod 700 "$LOCAL_API_DIR"
if [[ "$SYSTEM" == true ]]; then
  INSTALLING_USER="${SUDO_USER:-}"
  if [[ -n "$INSTALLING_USER" ]]; then
    chmod +a "$INSTALLING_USER allow read,readattr,execute,search,file_inherit,directory_inherit" "$LOCAL_API_DIR"
  else
    echo "warning: could not determine the installing user (SUDO_USER is unset) -- the local API token will not be readable by any non-root account. Re-run via 'sudo ./install.sh --system' from a normal user's login session, or grant access manually:" >&2
    echo "  sudo chmod +a \"<username> allow read,readattr,execute,search,file_inherit,directory_inherit\" \"$LOCAL_API_DIR\"" >&2
  fi
fi

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

# build-bundle.mjs includes "Nia Agent.app" by default (only a deliberate
# --no-desktop, service-only build omits it) -- install it alongside the
# service either way; skip quietly here if this happens to be such a build.
APP_BUNDLE_SRC="$SCRIPT_DIR/Nia Agent.app"
APP_BUNDLE_DEST="/Applications/Nia Agent.app"
if [[ -d "$APP_BUNDLE_SRC" ]]; then
  # Quit a running instance before replacing it -- overwriting a running
  # .app bundle's contents in place leaves the live process pointed at
  # deleted/mismatched files. Graceful quit first (its own before-quit
  # handler saves window position/state), then a forced kill in case it
  # ignored the request or isn't responding. Both are allowed to be no-ops
  # when it simply isn't running -- the common case, not an error.
  if [[ -d "$APP_BUNDLE_DEST" ]]; then
    osascript -e 'tell application "Nia Agent" to quit' >/dev/null 2>&1 || true
    sleep 1.5
    pkill -f "$APP_BUNDLE_DEST/Contents/MacOS/" >/dev/null 2>&1 || true
  fi
  rm -rf "$APP_BUNDLE_DEST"
  cp -R "$APP_BUNDLE_SRC" "$APP_BUNDLE_DEST"
  # Strip the Gatekeeper quarantine flag -- cp (unlike a signed/notarized
  # installer flow) leaves it set, which would otherwise show an
  # "unidentified developer" warning on first launch.
  xattr -dr com.apple.quarantine "$APP_BUNDLE_DEST" 2>/dev/null || true
  if [[ -n "${SUDO_USER:-}" ]]; then
    chown -R "$SUDO_USER" "$APP_BUNDLE_DEST" 2>/dev/null || true
  fi
fi

if [[ "$SERVICE_WAS_LOADED" == true ]]; then
  echo "upgraded and restarted $LABEL"
else
  cat <<EOF
installed and started $LABEL (runs at login/boot going forward).
EOF
  if [[ -t 0 && -t 1 ]]; then
    read -r -p "Run guided setup now? [Y/n] " REPLY
    if [[ -z "$REPLY" || "$REPLY" =~ ^[Yy] ]]; then
      NIA_AGENT_HOME="$HOME_DIR" "$EXE_PATH" setup
    else
      cat <<EOF
Skipped. Run it later with:
  NIA_AGENT_HOME="$HOME_DIR" "$EXE_PATH" setup
EOF
    fi
  else
    cat <<EOF
Next steps:
  NIA_AGENT_HOME="$HOME_DIR" "$EXE_PATH" setup
  NIA_AGENT_HOME="$HOME_DIR" "$EXE_PATH" doctor
  launchctl print $DOMAIN/$LABEL
EOF
  fi
  cat <<EOF

Day-to-day, open the agent's own UI any time with:
  NIA_AGENT_HOME="$HOME_DIR" "$EXE_PATH" open
EOF
fi

# Open the desktop app on first install only (not on upgrade, so a running
# instance isn't force-closed/reopened under the user). GUI apps can't be
# opened as root, so a --system install run via sudo just leaves it in
# /Applications for the logged-in user to launch themselves.
if [[ -d "$APP_BUNDLE_DEST" && "$SERVICE_WAS_LOADED" == false && "${EUID}" -ne 0 ]]; then
  open -a "$APP_BUNDLE_DEST"
fi
