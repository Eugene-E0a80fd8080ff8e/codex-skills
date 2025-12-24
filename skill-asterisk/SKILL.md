---
name: skill-asterisk
description: Bridge OpenAI Realtime audio with Asterisk via JsSIP (SIP over WebSocket/WebRTC) to make AI-driven phone calls. skill-asterisk/phonebook.txt contains phonebook.
---

# OpenAI Realtime ↔ Asterisk Bridge (Node.js + JsSIP)

This skill ships a small Node.js app that:

- Registers a WebRTC SIP endpoint to Asterisk via SIP-over-WebSocket (JsSIP).
- Places an outgoing call (by phonebook name or number).
- Streams call audio → OpenAI Realtime input.
- Streams OpenAI Realtime audio output → the SIP call.

## One-time setup

1. Ensure Asterisk is configured for WebRTC + SIP-over-WebSocket (PJSIP WSS transport, DTLS-SRTP, ICE).
2. Install Node dependencies:
   - `cd scripts && npm install`

## Configure

Edit `scripts/bridge.js` and hardcode at the top:

- `OPENAI_API_KEY`
- `SIP_URI` (example: `sip:1234@test.example.com`)
- `SIP_USER` (example: `1234`)
- `SIP_PASS` (example: `12345`)

Also edit:

- `phonebook.txt` (name ↔ number ↔ description)
- Optional `SIP_WS` override (defaults to `wss://<domain-from-SIP_URI>/ws`)

### Phonebook format

Edit `phonebook.txt` (freeform lines). Supported format is comma-separated:

- `Name, Phone Number, Description (optional)`

## Run

- List phonebook entries:
  - `node scripts/bridge.js --list`
- Call by name:
  - `node scripts/bridge.js --to Alice --prompt "Say hello and ask about the report."`
- Call by number/extension:
  - `node scripts/bridge.js --to 1234 --prompt "Hello!"`

## Notes

- This requires network access (OpenAI + your Asterisk WSS endpoint).
- `@roamhq/wrtc` is a native module; you may need build tooling (Python + make + C/C++ toolchain) for `npm install`.
