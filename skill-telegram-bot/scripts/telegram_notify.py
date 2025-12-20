#!/usr/bin/env python3
from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

BOT_TOKEN = "PASTE_BOT_TOKEN_HERE"  # Use BotFather to create a bot. Write something to the bot at least once.
CHAT_ID = 123456789 # Your User ID (or group id) . Interact with @raw_data_bot to find out!

TELEGRAM_MESSAGE_LIMIT = 4096


def _die(message: str, exit_code: int = 2) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(exit_code)


def _validate_config() -> None:
    if not BOT_TOKEN or BOT_TOKEN == "PASTE_BOT_TOKEN_HERE":
        _die("Set BOT_TOKEN in scripts/telegram_notify.py (from BotFather).")
    if CHAT_ID in (0, 123456789) or CHAT_ID is None:
        _die("Set CHAT_ID in scripts/telegram_notify.py (numeric user/chat id).")


def _split_message(text: str, limit: int = TELEGRAM_MESSAGE_LIMIT) -> list[str]:
    if len(text) <= limit:
        return [text]

    parts: list[str] = []
    remaining = text
    while remaining:
        if len(remaining) <= limit:
            parts.append(remaining)
            break

        cut = remaining.rfind("\n", 0, limit)
        if cut == -1 or cut < limit // 2:
            cut = limit
        parts.append(remaining[:cut])
        remaining = remaining[cut:]
        if remaining.startswith("\n"):
            remaining = remaining[1:]

    return parts


def _read_text(*, text: str | None, file: str | None) -> str:
    if text and file:
        _die("Use only one of --text or --file.")

    if file:
        return Path(file).read_text(encoding="utf-8")

    if text is not None:
        return text

    if sys.stdin.isatty():
        _die("Provide --text, --file, or pipe a message via stdin.")

    return sys.stdin.read()


async def _send_via_telegram(*, message: str) -> None:
    try:
        from telegram import Bot
    except Exception as exc:
        _die(
            "Missing dependency: python-telegram-bot.\n"
            "Install it with:\n"
            "  python -m pip install -r scripts/requirements.txt\n\n"
            f"Import error: {exc}"
        )

    bot = Bot(token=BOT_TOKEN)
    for part in _split_message(message):
        await bot.send_message(chat_id=CHAT_ID, text=part)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Send a Telegram message to a fixed CHAT_ID.")
    parser.add_argument("--text", help="Message text.")
    parser.add_argument("--file", help="Read message text from a UTF-8 file.")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the message instead of sending (no network/deps required).",
    )
    args = parser.parse_args(argv)

    message = _read_text(text=args.text, file=args.file).strip("\n")
    if not message.strip():
        _die("Empty message; nothing to send.")

    if args.dry_run:
        print(message)
        return 0

    _validate_config()
    asyncio.run(_send_via_telegram(message=message))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
