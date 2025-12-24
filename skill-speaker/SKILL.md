---
name: skill-speaker
description: Run a local microphone↔speaker voice dialog using OpenAI Realtime audio models (Node.js). Uses the `mic` and `speaker` npm packages. Pass a detailed prompt that includes all dialog context + what must be learned from the user.
---

# Local Voice Dialog (mic ↔ OpenAI Realtime ↔ speaker)

This skill runs a two-way voice conversation:

- Your microphone streams audio to an OpenAI Realtime audio model.
- The model streams audio back to your speakers.
- Optional live transcripts are printed to stdout (useful for Codex to capture what was learned).

## Prompt requirement (important)

During the call, the Realtime model does **not** have access to most of the context that Codex has (repo files, prior reasoning, etc). Put *everything the voice agent needs* into the startup prompt, including:

- Relevant background/context for the conversation
- What the agent must learn from the user (explicit questions or a checklist)
- Any constraints (tone, length, allowed topics, how to summarize learned info)

## One-time setup

1. Install the skill into Codex:
   - Copy `skill-speaker/` into `$CODEX_HOME/skills` (default `~/.codex/skills/`)
2. Install Node deps:
   - `cd scripts && npm install`
3. Hardcode your OpenAI key:
   - Edit `scripts/config.js` and set `OPENAI_API_KEY`
   - Avoid committing the key to a public repo.

## Run

- Prompt from an argument:
  - `node scripts/voice-dialog.js --prompt "You are a voice interviewer. Context: ... Learn: ..."`
- Prompt from a file (best for long prompts):
  - `node scripts/voice-dialog.js --prompt-file /path/to/prompt.txt`
- Prompt from stdin:
  - `cat /path/to/prompt.txt | node scripts/voice-dialog.js --prompt-stdin`
- Test microphone level (no OpenAI connection):
  - `node scripts/voice-dialog.js --mictest`
  
While running:
- Press `q` or `space` to end the conversation and print `RESULT_JSON_*`.
- Saying “goodbye” (or similar) should cause the model to call `end_conversation` and end automatically.

## Notes / troubleshooting

- Requires network access (OpenAI Realtime).
- In network-restricted Codex runs, request approval to allow the connection.
- Uses the modern Realtime WebSocket endpoint (`wss://api.openai.com/v1/realtime`) via `openai/realtime/ws` (not the deprecated beta module path).
- Use headphones to avoid speaker→mic feedback loops.
- `mic` typically shells out to `arecord` (Linux) or `sox`; install those if startup fails.
- If you see silence in `--mictest`, set the capture device (ALSA) with `--mic-device` (default is `default`), e.g. `--mic-device plughw:0,0`. Use `arecord -L` to list devices.
- `speaker` is a native module; you may need build tooling for `npm install`.
- If the model name changes or you lack access, edit `scripts/config.js` (`REALTIME_MODEL`).
