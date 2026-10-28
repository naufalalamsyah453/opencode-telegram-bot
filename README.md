# opencode-telegram-bot

Telegram bot (Telegraf) that drives an `opencode` CLI session on a host machine: run commands, open terminals, stream tool output, and return news updates — all from chat.

## Stack

- Node.js
- [telegraf](https://github.com/telegraf/telegraf) — Telegram Bot API framework
- [dotenv](https://github.com/motdotla/dotenv) — env loading
- [indo-news-scraper](https://www.npmjs.com/package/indo-news-scraper) — Indonesian news feeds

## Quick install (VPS)

One command on a fresh Debian/Ubuntu/RHEL/Fedora/Alpine box:

```bash
curl -fsSL https://raw.githubusercontent.com/naufalalamsyah453/opencode-telegram-bot/master/install.sh \
  | sudo bash -s -- --user "$(id -un)"
```

The installer:

- installs `git`, `curl`, `ca-certificates`, Node.js >= 20 (NodeSource on Debian-family)
- installs the `opencode` CLI for the service user
- clones the repo to `/opt/opencode-telegram-bot`
- runs `npm install`
- creates `.env` (prompts for `BOT_TOKEN` + `AUTHORIZED_USER_ID`, mode `600`)
- writes and starts the `opencode-telegram-bot` systemd service

Re-running is safe: it updates the checkout and reinstalls dependencies.

```bash
sudo ./install.sh --help
```

| Option | Description |
| --- | --- |
| `--user <name>` | Service user (default: sudo user, else `oc`) |
| `--dir <path>` | Install dir (default: `/opt/opencode-telegram-bot`) |
| `--repo <url>` | Git repo to clone |
| `--branch <name>` | Git branch (default: `master`) |
| `--env-file <path>` | Copy an existing `.env` instead of prompting |
| `--no-service` | Skip systemd unit |
| `--no-opencode` | Skip opencode CLI install |

After install, authenticate opencode and set a model:

```bash
sudo -u <user> -H opencode auth login
sudo -u <user> -H nano ~/.config/opencode/opencode.json
journalctl -u opencode-telegram-bot -f
```

### Manual setup

```bash
git clone https://github.com/naufalalamsyah453/opencode-telegram-bot.git
cd opencode-telegram-bot
npm install
cp .env.example .env
# edit .env: set BOT_TOKEN and AUTHORIZED_USER_ID
npm start
```

## Configuration

All config comes from `.env` (see `.env.example`):

| Variable | Purpose |
| --- | --- |
| `BOT_TOKEN` | Telegram bot token from @BotFather |
| `AUTHORIZED_USER_ID` | Single Telegram user ID allowed to use the bot |
| `WORKDIR` | Working directory for spawned commands |
| `RUN_TIMEOUT_SECONDS` | Soft timeout for a run |
| `COMMAND_TIMEOUT_SECONDS` | Timeout for shell commands |
| `TERM_TIMEOUT_SECONDS` | Timeout for terminal sessions |
| `TOOL_TIMEOUT_SECONDS` | Timeout for tool calls |
| `RUN_HARD_TIMEOUT_SECONDS` | Hard kill timeout for a run |
| `FALLBACK_RETRIES` | Retry count when the primary model is unavailable |
| `FALLBACK_MODELS` | Optional comma-separated fallback model list |
| `VPS_SSH_HINT` | Optional template hint for port-forwarding tunnels |
| `TZ` | Process timezone |

## Run as a service

`install.sh` writes `/etc/systemd/system/opencode-telegram-bot.service` for you. To manage it:

```bash
sudo systemctl status opencode-telegram-bot
sudo systemctl restart opencode-telegram-bot
journalctl -u opencode-telegram-bot -f
```

## Security notes

- The bot is single-user gated via `AUTHORIZED_USER_ID`. Anyone holding the bot token and knowing that ID can control the host.
- Keep `.env` out of version control (already in `.gitignore`). Rotate `BOT_TOKEN` if it leaks.
- Commands run with the privileges of the service user — do not run as root.
