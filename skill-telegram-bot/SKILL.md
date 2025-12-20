---
name: skill-telegram-bot
description: Send Telegram messages from Codex to a fixed user/chat id using a preconfigured bot token (hardcoded) via python-telegram-bot. Use when the user asks to telegram/notify/ping them, or wants Codex to push status updates or results to Telegram.
---

# Telegram Notify (One-Way)

This skill is intentionally minimal: it only sends outbound Telegram messages (no polling/webhook bot server).

## One-time setup

1. Edit `scripts/telegram_notify.py` and hardcode:
   - `BOT_TOKEN` (from BotFather)
   - `CHAT_ID` (your numeric user/chat id) (to find your user ID, use @raw_data_bot in Telegram)
   - Avoid committing the token to a public repo.
2. Ensure you have started a chat with the bot at least once (Telegram bots can’t DM you until you’ve interacted).
3. Install dependency:
   - `python -m pip install -r scripts/requirements.txt`

## Send a message

- Send text from an argument:
  - `python3 scripts/telegram_notify.py --text "hello from codex"`
- Send text from stdin (best for multi-line content):
  - `printf '%s' "multi\nline\nmessage" | python3 scripts/telegram_notify.py`
- Send text from a file:
  - `python3 scripts/telegram_notify.py --file path/to/message.txt`

## Notes for Codex runs

- Sending a Telegram message requires network access; request approval if your environment is network-restricted.
- If the message is longer than Telegram’s limit, the script automatically splits it into multiple messages.
