#!/usr/bin/env bash
# One-command installer for your personal assistant on a fresh Ubuntu server.
# Run it again any time to update to the newest code — your data and settings are kept.
#
#   curl -fsSL https://raw.githubusercontent.com/YOUR-GITHUB-NAME/YOUR-REPO/main/setup.sh | sudo bash -s YOUR-GITHUB-NAME/YOUR-REPO
#
set -euo pipefail

REPO="${1:-}"
APP_DIR=/opt/assistant
DATA_DIR=/var/lib/assistant
ENV_FILE=/etc/assistant.env
SERVICE=assistant

say()  { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
warn() { printf '\n\033[1;33m!!  %s\033[0m\n' "$*"; }

[ "$(id -u)" -eq 0 ] || { echo "Please run with sudo."; exit 1; }
if [ -z "$REPO" ] && [ ! -d "$APP_DIR/.git" ]; then
  echo "Tell me where the code lives, e.g.:  sudo bash setup.sh your-github-name/your-repo"; exit 1
fi

say "Installing system packages (1–2 minutes)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq python3 python3-venv git curl ufw sqlite3 >/dev/null

say "Getting the app code"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only
else
  git clone "https://github.com/$REPO.git" "$APP_DIR"
fi

id -u assistant >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin assistant
mkdir -p "$DATA_DIR/backups"
chown -R assistant:assistant "$DATA_DIR"
chmod 700 "$DATA_DIR"

say "Installing Python packages"
python3 -m venv "$APP_DIR/.venv"
"$APP_DIR/.venv/bin/pip" install -q --upgrade pip
"$APP_DIR/.venv/bin/pip" install -q -r "$APP_DIR/requirements.txt"

if [ ! -f "$ENV_FILE" ]; then
  say "First-time settings"
  echo "Paste your Anthropic API key (starts with sk-ant-). It won't show on screen as you paste."
  read -rs API_KEY < /dev/tty; echo
  while true; do
    echo "Choose a passcode for the app (at least 8 characters). It won't show on screen."
    read -rs PASS1 < /dev/tty; echo
    echo "Type it again:"
    read -rs PASS2 < /dev/tty; echo
    if [ "$PASS1" != "$PASS2" ]; then warn "They didn't match. Try again."; continue; fi
    if [ ${#PASS1} -lt 8 ]; then warn "Too short. Use at least 8 characters."; continue; fi
    case "$PASS1" in *"'"*|*\\*) warn "Please don't use ' or \\ in the passcode."; continue;; esac
    break
  done
  echo "What should the assistant call you? (for example: Alex)"
  read -r DISPLAY_NAME < /dev/tty
  DISPLAY_NAME=${DISPLAY_NAME:-there}
  echo "What do you want to call your assistant? (press Return for: Jarvis)"
  read -r BOT_NAME < /dev/tty
  BOT_NAME=${BOT_NAME:-Jarvis}
  DISPLAY_NAME=${DISPLAY_NAME//\'/}; BOT_NAME=${BOT_NAME//\'/}
  API_KEY=$(printf '%s' "$API_KEY" | tr -d "[:space:]'")
  umask 077
  cat > "$ENV_FILE" <<EOF
ANTHROPIC_API_KEY='$API_KEY'
APP_PASSCODE='$PASS1'
USER_NAME='$DISPLAY_NAME'
ASSISTANT_NAME='$BOT_NAME'
TIMEZONE=America/Los_Angeles
DATA_DIR=$DATA_DIR
EOF
  chmod 600 "$ENV_FILE"
else
  say "Keeping your existing settings in $ENV_FILE"
fi

say "Setting the app to run all the time"
cat > /etc/systemd/system/$SERVICE.service <<EOF
[Unit]
Description=Personal assistant
After=network-online.target

[Service]
User=assistant
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$APP_DIR/.venv/bin/uvicorn app:app --host 127.0.0.1 --port 8000 --proxy-headers
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA_DIR
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now $SERVICE >/dev/null 2>&1
systemctl restart $SERVICE

say "Daily backups (keeps the last 14 days)"
cat > /etc/cron.daily/assistant-backup <<EOF
#!/bin/sh
sqlite3 $DATA_DIR/assistant.db ".backup '$DATA_DIR/backups/assistant-\$(date +%F).db'"
find $DATA_DIR/backups -name 'assistant-*.db' -mtime +14 -delete
chown -R assistant:assistant $DATA_DIR/backups
EOF
chmod 755 /etc/cron.daily/assistant-backup

say "Private network (Tailscale)"
if ! command -v tailscale >/dev/null; then
  curl -fsSL https://tailscale.com/install.sh | sh
fi
if ! tailscale status >/dev/null 2>&1; then
  echo
  echo "A link will appear below. Open it on your phone or computer and sign in to Tailscale"
  echo "with the SAME account you used on your iPhone. Then come back here."
  tailscale up --hostname=assistant
fi

say "Firewall: only your own devices can reach the app"
ufw --force reset >/dev/null
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow OpenSSH >/dev/null
ufw allow in on tailscale0 >/dev/null
ufw --force enable >/dev/null

say "Turning on the secure (https) address"
echo "If Tailscale asks you to enable HTTPS, open the link it shows, click Enable, then come back."
tailscale serve --bg --https=443 http://127.0.0.1:8000

sleep 2
NAME=$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')
if systemctl is-active --quiet $SERVICE; then
  say "All done!"
  echo
  echo "   Your assistant's address:   https://$NAME"
  echo
  echo "   Open that in Safari on your iPhone (with the Tailscale app turned on),"
  echo "   then tap Share → Add to Home Screen."
  echo
else
  warn "The app didn't start. Show Claude the output of:  journalctl -u $SERVICE -n 50"
fi
