
# Codex skills

*(Looking for a job. Urgently. I am a programmer of wide-specialization. ICPC finalist)*

## telegram-bot

Sends you a message. For example you may want to get a notify every time codex finishes a job.

It only works for one-way notifications. Your replies to the bot would not be relayed to the codex chat.

To install :

- do <code>pip install ./skill-telegram-bot/scripts/requirements.txt</code>
- Edit the file ./skill-telegram-bot/scripts/telegram_notify.py and put your USER_ID and BOT_TOKEN in there
- You can find your userid in telegram by interacting with @raw_data_bot in telegram
- You can create a bot using @BotFather bot. It will issue a token BOT_TOKEN.
- Ensure you have started a chat with the bot at least once (Telegram bots can’t DM you until you’ve interacted).
- to make the bot available to OpenAI's codex tool, copy ./skill-telegram-bot to ~/codex : <code>cp -rp skill-telegram-bot $HOME/.codex/skills/</code>

To test it, prompt codex: say "hi!" to me in Telegram.

## skill-speaker

Comlete.

It does not work due to imposed timeout of 10 sec for codex skill tools.


## skill-asterisk (voice call)

A skill that was supposed to make possible to make a call, or a series of calls. Possibly making use of a phonebook.

Incomlete at the moment.

It would not work due to imposed timeout of 10 sec for codex skill tools.