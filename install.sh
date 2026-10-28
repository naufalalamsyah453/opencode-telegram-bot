#!/usr/bin/env bash
#
# install.sh — one-shot installer for opencode-telegram-bot on a fresh Linux VPS.
#
# Usage (repo is PRIVATE, so clone first — a bare curl to raw.githubusercontent returns 404):
#   sudo ./install.sh [options]
#   gh repo clone OWNER/REPO /tmp/optb && sudo /tmp/optb/install.sh [options]
#
# Options:
#   --user <name>     Service user to run the bot (default: current sudo user, else "oc")
#   --dir <path>      Install directory (default: /opt/opencode-telegram-bot)
#   --repo <url>      Git repo to clone (default: this script's repo)
#   --branch <name>   Git branch (default: master)
#   --env-file <path> Copy an existing .env into place instead of prompting
#   --no-service      Skip systemd unit installation
#   --no-opencode     Skip opencode CLI installation
#   -h, --help        Show this help
#
# The script is idempotent: re-running updates the checkout and reinstalls deps.

set -euo pipefail

DEFAULT_REPO="https://github.com/naufalalamsyah453/opencode-telegram-bot.git"
DEFAULT_BRANCH="master"
INSTALL_DIR="/opt/opencode-telegram-bot"
SERVICE_USER=""
REPO_URL="$DEFAULT_REPO"
BRANCH="$DEFAULT_BRANCH"
ENV_FILE=""
INSTALL_SERVICE=1
INSTALL_OPENCODE=1

log()  { printf '\033[1;32m[+]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "$0"
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --user)        SERVICE_USER="${2:?}"; shift 2 ;;
    --dir)         INSTALL_DIR="${2:?}"; shift 2 ;;
    --repo)        REPO_URL="${2:?}"; shift 2 ;;
    --branch)      BRANCH="${2:?}"; shift 2 ;;
    --env-file)    ENV_FILE="${2:?}"; shift 2 ;;
    --no-service)  INSTALL_SERVICE=0; shift ;;
    --no-opencode) INSTALL_OPENCODE=0; shift ;;
    -h|--help)     usage ;;
    *)             die "Unknown option: $1" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "Run as root (sudo ./install.sh)."

if [ -z "$SERVICE_USER" ]; then
  if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
    SERVICE_USER="$SUDO_USER"
  else
    SERVICE_USER="oc"
  fi
fi

if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  log "Creating user: $SERVICE_USER"
  useradd -m -s /bin/bash "$SERVICE_USER"
fi
SERVICE_HOME="$(getent passwd "$SERVICE_USER" | cut -d: -f6)"

# --- detect package manager / distro family ---
PKG=""
if command -v apt-get >/dev/null 2>&1; then PKG="apt"; \
elif command -v dnf    >/dev/null 2>&1; then PKG="dnf"; \
elif command -v yum    >/dev/null 2>&1; then PKG="yum"; \
elif command -v apk    >/dev/null 2>&1; then PKG="apk"; \
fi

need_pkg() {
  case "$PKG" in
    apt) DEBIAN_FRONTEND=noninteractive apt-get install -y "$@" ;;
    dnf|yum) "$PKG" install -y "$@" ;;
    apk) apk add --no-cache "$@" ;;
    *) die "No supported package manager found; install manually: $*" ;;
  esac
}

log "Installing base packages: git curl ca-certificates"
case "$PKG" in
  apt) apt-get update -qq; need_pkg git curl ca-certificates ;;
  dnf|yum) need_pkg git curl ca-certificates ;;
  apk)  need_pkg git curl ca-certificates bash ;;
  *)    warn "Unknown package manager; assuming git/curl present." ;;
esac

# --- Node.js >= 20 ---
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local major
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "$major" -ge 20 ]
}

if node_ok; then
  log "Node.js $(node -v) already present"
else
  log "Installing Node.js 20 via NodeSource"
  if [ "$PKG" = "apk" ]; then
    need_pkg nodejs npm
  else
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1 || die "NodeSource setup failed"
    need_pkg nodejs
  fi
  node_ok || die "Node.js >= 20 install failed"
fi
command -v npm >/dev/null 2>&1 || die "npm missing"

# --- opencode CLI (bot shells out to it) ---
OPENCODE_BIN=""
if [ "$INSTALL_OPENCODE" -eq 1 ]; then
  if sudo -u "$SERVICE_USER" -H bash -lc 'command -v opencode' >/dev/null 2>&1; then
    log "opencode CLI already installed for $SERVICE_USER"
  else
    log "Installing opencode CLI for $SERVICE_USER"
    sudo -u "$SERVICE_USER" -H bash -lc 'curl -fsSL https://opencode.ai/install | bash' \
      || warn "opencode auto-install failed — run it manually later"
  fi
fi
OPENCODE_BIN="$(sudo -u "$SERVICE_USER" -H bash -lc 'command -v opencode' 2>/dev/null || true)"
if [ -n "$OPENCODE_BIN" ]; then
  log "opencode: $OPENCODE_BIN ($("$OPENCODE_BIN" --version 2>/dev/null || echo '?'))"
else
  warn "opencode CLI not found on PATH — bot runs will fail until it is installed."
fi

# --- checkout ---
if [ -d "$INSTALL_DIR/.git" ]; then
  log "Updating existing checkout in $INSTALL_DIR"
  git -C "$INSTALL_DIR" fetch --quiet origin "$BRANCH"
  git -C "$INSTALL_DIR" checkout --quiet "$BRANCH"
  git -C "$INSTALL_DIR" reset --hard --quiet "origin/$BRANCH"
else
  log "Cloning $REPO_URL ($BRANCH) into $INSTALL_DIR"
  mkdir -p "$INSTALL_DIR"
  chown "$SERVICE_USER":"$SERVICE_USER" "$INSTALL_DIR"
  sudo -u "$SERVICE_USER" git clone --quiet --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
fi
chown -R "$SERVICE_USER":"$SERVICE_USER" "$INSTALL_DIR"

# --- dependencies ---
log "Installing npm dependencies"
sudo -u "$SERVICE_USER" -H bash -lc "cd '$INSTALL_DIR' && npm install --omit=dev --no-audit --no-fund"

# --- .env ---
ENV_PATH="$INSTALL_DIR/.env"
if [ -f "$ENV_PATH" ]; then
  log "Keeping existing $ENV_PATH"
elif [ -n "$ENV_FILE" ]; then
  [ -f "$ENV_FILE" ] || die "Env file not found: $ENV_FILE"
  install -m 600 -o "$SERVICE_USER" -g "$SERVICE_USER" "$ENV_FILE" "$ENV_PATH"
  log "Installed .env from $ENV_FILE"
else
  printf '\nTelegram bot token (from @BotFather): '
  read -r BOT_TOKEN_IN
  [ -n "$BOT_TOKEN_IN" ] || die "Token cannot be empty."
  printf 'Authorized Telegram user ID (numeric): '
  read -r AUTH_ID_IN
  [ -n "$AUTH_ID_IN" ] || die "User ID cannot be empty."

  cat > "$ENV_PATH" <<ENVEOF
# Telegram bot token from @BotFather
BOT_TOKEN=$BOT_TOKEN_IN

# Only this Telegram user ID may control the bot
AUTHORIZED_USER_ID=$AUTH_ID_IN

# Working directory for spawned commands
WORKDIR=$SERVICE_HOME

# Timeouts (seconds)
RUN_TIMEOUT_SECONDS=600
COMMAND_TIMEOUT_SECONDS=300
TERM_TIMEOUT_SECONDS=600
TOOL_TIMEOUT_SECONDS=600
RUN_HARD_TIMEOUT_SECONDS=1200

# Fallback model handling
FALLBACK_RETRIES=2

# Process timezone
TZ=Asia/Jakarta
ENVEOF
  chmod 600 "$ENV_PATH"
  chown "$SERVICE_USER":"$SERVICE_USER" "$ENV_PATH"
  log "Wrote $ENV_PATH"
fi

# --- config dirs for the service user ---
install -d -m 700 -o "$SERVICE_USER" -g "$SERVICE_USER" "$SERVICE_HOME/.config/opencode"
install -d -m 700 -o "$SERVICE_USER" -g "$SERVICE_USER" "$SERVICE_HOME/.config/opencode-telegram-bot"
log "Config dirs ready under $SERVICE_HOME/.config"

# --- systemd service ---
if [ "$INSTALL_SERVICE" -eq 1 ]; then
  if ! command -v systemctl >/dev/null 2>&1; then
    warn "systemd not found — skipping service install"
  else
    NODE_BIN="$(command -v node)"
    log "Writing systemd unit /etc/systemd/system/opencode-telegram-bot.service"
    cat > /etc/systemd/system/opencode-telegram-bot.service <<UNITEOF
[Unit]
Description=OpenCode Telegram Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=$ENV_PATH
ExecStart=$NODE_BIN $INSTALL_DIR/index.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

# hardening
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
ProtectHome=read-only
ReadWritePaths=$INSTALL_DIR $SERVICE_HOME/.config $SERVICE_HOME/.local $SERVICE_HOME/.cache

[Install]
WantedBy=multi-user.target
UNITEOF
    systemctl daemon-reload
    systemctl enable --quiet opencode-telegram-bot
    systemctl restart opencode-telegram-bot
    sleep 2
    if systemctl is-active --quiet opencode-telegram-bot; then
      log "Service running: opencode-telegram-bot"
    else
      warn "Service failed to start. Check: journalctl -u opencode-telegram-bot -n 50 --no-pager"
    fi
  fi
fi

cat <<DONEEOF

Done.

  Install dir : $INSTALL_DIR
  Service user: $SERVICE_USER
  Env file    : $ENV_PATH
  Logs        : journalctl -u opencode-telegram-bot -f

Next steps:
  1. Install/authenticate opencode for the service user, e.g.:
       sudo -u $SERVICE_USER -H opencode auth login
  2. Set a default model in $SERVICE_HOME/.config/opencode/opencode.json
  3. Message the bot from the authorized Telegram account.

DONEEOF