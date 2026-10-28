# opencode-telegram-bot

Telegram bot (Telegraf) that drives an `opencode` CLI session on a host machine: run commands, open terminals, stream tool output, and return news updates — all from chat.

## Stack

- Node.js
- [telegraf](https://github.com/telegraf/telegraf) — Telegram Bot API framework
- [dotenv](https://github.com/motdotla/dotenv) — env loading
- [indo-news-scraper](https://www.npmjs.com/package/indo-news-scraper) — Indonesian news feeds

## Setup

```bash
git clone <repo-url> opencode-telegram-bot
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

`opencode-telegram-bot.service` is a systemd unit. Adjust `User`, `WorkingDirectory`, and paths, then:

```bash
sudo cp opencode-telegram-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now opencode-telegram-bot
journalctl -u opencode-telegram-bot -f
```

## Security notes

- The bot is single-user gated via `AUTHORIZED_USER_ID`. Anyone holding the bot token and knowing that ID can control the host.
- Keep `.env` out of version control (already in `.gitignore`). Rotate `BOT_TOKEN` if it leaks.
- Commands run with the privileges of the service user — do not run as root.
