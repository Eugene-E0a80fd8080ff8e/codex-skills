import fs from 'node:fs/promises';
import process from 'node:process';
import { createRequire } from 'node:module';
import readline from 'node:readline';

import {
  ENABLE_TRANSCRIPTION,
  MIC_DEVICE,
  MIC_SAMPLE_RATE,
  OPENAI_API_KEY,
  REALTIME_MODEL,
  REALTIME_SAMPLE_RATE,
  REALTIME_VOICE,
  TRANSCRIPTION_MODEL
} from './config.js';

function parseArgs(argv) {
  const args = { help: false, promptStdin: false, mictest: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--mictest') args.mictest = true;
    else if (arg === '--mic-device') args.micDevice = argv[++i];
    else if (arg === '--mic-rate') args.micRate = Number(argv[++i]);
    else if (arg === '--prompt' || arg === '-p') args.prompt = argv[++i];
    else if (arg === '--prompt-file') args.promptFile = argv[++i];
    else if (arg === '--prompt-stdin') args.promptStdin = true;
    else if (arg === '--no-transcription') args.noTranscription = true;
    else if (arg === '--model') args.model = argv[++i];
    else if (arg === '--voice') args.voice = argv[++i];
    else throw new Error(`Unknown arg: ${arg}`);
  }
  return args;
}

function printUsage() {
  console.log(
    [
      'Usage:',
      '  node voice-dialog.js --prompt "..."',
      '  node voice-dialog.js --prompt-file /path/to/prompt.txt',
      '  cat prompt.txt | node voice-dialog.js --prompt-stdin',
      '  node voice-dialog.js --mictest [--mic-device <alsa-device>] [--mic-rate <hz>]'
    ].join('\n')
  );
}

async function readStdinUtf8() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function decodePcm16le(chunk) {
  if (!chunk || chunk.length < 2) return null;
  const evenLength = chunk.length - (chunk.length % 2);
  const buf = evenLength === chunk.length ? chunk : chunk.subarray(0, evenLength);
  return new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));
}

function clampInt16(x) {
  if (x > 32767) return 32767;
  if (x < -32768) return -32768;
  return x;
}

function resampleInt16Linear(input, inRate, outRate) {
  if (inRate === outRate) return input;
  if (!input || input.length === 0) return new Int16Array(0);

  const ratio = inRate / outRate;
  const outLength = Math.max(1, Math.round(input.length / ratio));
  const output = new Int16Array(outLength);

  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;

    const s0 = input[idx] ?? input[input.length - 1];
    const s1 = input[idx + 1] ?? input[input.length - 1];
    const sample = s0 + (s1 - s0) * frac;
    output[i] = clampInt16(Math.round(sample));
  }

  return output;
}

function ensureApiKeyConfigured() {
  if (!OPENAI_API_KEY || OPENAI_API_KEY === 'REPLACE_ME') {
    throw new Error('Set OPENAI_API_KEY in scripts/config.js before running.');
  }
}

function createSpeaker(SpeakerCtor) {
  return new SpeakerCtor({
    channels: 1,
    bitDepth: 16,
    sampleRate: REALTIME_SAMPLE_RATE
  });
}

function createMicInstance(mic, options = {}) {
  const rate = Number.isFinite(options.rate) ? options.rate : MIC_SAMPLE_RATE;
  const device = (options.device ?? MIC_DEVICE ?? 'default').toString();
  const micInstance = mic({
    rate: String(rate),
    channels: '1',
    bitwidth: '16',
    encoding: 'signed-integer',
    endian: 'little',
    fileType: 'raw',
    device,
    debug: false
  });
  return { micInstance, micStream: micInstance.getAudioStream() };
}

function linearToDb(x) {
  if (!x || x <= 0) return -Infinity;
  return 20 * Math.log10(x);
}

function formatDb(db) {
  if (!Number.isFinite(db)) return '-inf';
  return db.toFixed(1);
}

async function runMicTest({ mic, micDevice, micRate }) {
  const rate = Number.isFinite(micRate) ? micRate : MIC_SAMPLE_RATE;
  const device = (micDevice ?? MIC_DEVICE ?? 'default').toString();
  console.log(`Mic test: speak into your microphone. Press Ctrl+C to stop. (device=${device}, rate=${rate})`);

  const { micInstance, micStream } = createMicInstance(mic, { device, rate });

  let accumSumSquares = 0;
  let accumCount = 0;
  let accumPeak = 0;

  micStream.on('data', (chunk) => {
    const int16 = decodePcm16le(chunk);
    if (!int16 || int16.length === 0) return;

    let peak = accumPeak;
    let sumSquares = 0;
    for (let i = 0; i < int16.length; i++) {
      const s = int16[i];
      const a = Math.abs(s);
      if (a > peak) peak = a;
      sumSquares += s * s;
    }

    accumPeak = peak;
    accumSumSquares += sumSquares;
    accumCount += int16.length;
  });

  micStream.on('error', (err) => {
    console.error('Mic error:', err);
  });

  let lastLen = 0;
  const render = () => {
    const rms = accumCount > 0 ? Math.sqrt(accumSumSquares / accumCount) / 32768 : 0;
    const peak = accumPeak / 32768;
    accumSumSquares = 0;
    accumCount = 0;
    accumPeak = 0;

    const rmsDb = linearToDb(rms);
    const peakDb = linearToDb(peak);

    const minDb = -60;
    const norm = Math.max(0, Math.min(1, (rmsDb - minDb) / (0 - minDb)));
    const width = Math.max(20, Math.min(60, (process.stdout.columns ?? 80) - 40));
    const filled = Math.round(norm * width);
    const bar = `${'#'.repeat(filled)}${' '.repeat(width - filled)}`;
    const clipped = peak >= 0.999 ? ' CLIP' : '';

    const line = `[${bar}] rms ${formatDb(rmsDb)} dBFS  peak ${formatDb(peakDb)} dBFS${clipped}`;
    const padded = line.padEnd(lastLen);
    lastLen = padded.length;

    if (process.stdout.isTTY) process.stdout.write(`\r${padded}`);
    else console.log(line);
  };

  const intervalMs = process.stdout.isTTY ? 100 : 1000;
  render();
  const interval = setInterval(render, intervalMs);

  const stop = () => {
    clearInterval(interval);
    try {
      micInstance.stop();
    } catch {}
    if (process.stdout.isTTY) process.stdout.write('\n');
  };

  process.on('SIGINT', () => {
    stop();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    stop();
    process.exit(0);
  });

  micInstance.start();
  await new Promise(() => {});
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const require = createRequire(import.meta.url);
  const mic = require('mic');
  if (args.mictest) {
    await runMicTest({ mic, micDevice: args.micDevice, micRate: args.micRate });
    return;
  }

  ensureApiKeyConfigured();
  process.env.OPENAI_API_KEY ||= OPENAI_API_KEY;

  const prompt =
    (args.promptFile ? await fs.readFile(args.promptFile, 'utf8') : undefined) ??
    (args.promptStdin ? await readStdinUtf8() : undefined) ??
    (args.prompt ? args.prompt : undefined) ??
    (!process.stdin.isTTY ? await readStdinUtf8() : undefined);

  if (!prompt || !prompt.trim()) {
    printUsage();
    throw new Error('Missing prompt. Provide --prompt, --prompt-file, or --prompt-stdin.');
  }

  const { OpenAIRealtimeWS } = require('openai/realtime/ws');
  const Speaker = require('speaker');

  const toolInstruction = [
    'If the user indicates they want to end the conversation (e.g. "goodbye", "bye", "that is all", "stop", "end"),',
    'call the tool end_conversation immediately.',
    'After calling end_conversation, say a brief goodbye and stop.'
  ].join(' ');

  const sessionInstructions = `${prompt.trim()}\n\n${toolInstruction}\n`;

  const speaker = { current: createSpeaker(Speaker) };
  const resetSpeaker = () => {
    try {
      speaker.current?.destroy?.();
    } catch {}
    speaker.current = createSpeaker(Speaker);
  };

  let socketOpen = false;
  let sessionConfigured = false;
  let micStarted = false;
  const pendingAudio = [];

  const transcriptionEnabled = ENABLE_TRANSCRIPTION && !args.noTranscription;

  const rt = new OpenAIRealtimeWS({ model: args.model ?? REALTIME_MODEL });

  const transcripts = [];

  const functionCallNameByCallId = new Map();
  const functionCallNameByItemId = new Map();

  let micInstance = null;
  let micStream = null;

  let ending = false;
  let finalized = false;
  let endedBy = null;
  let endTool = null;
  let endWaitResponseId = null;
  let endWaitTimer = null;
  let keypressCleanup = null;

  const printResult = () => {
    const result = {
      ended_by: endedBy,
      ended_at: new Date().toISOString(),
      tool: endTool,
      transcripts
    };
    console.log('\nRESULT_JSON_START');
    console.log(JSON.stringify(result, null, 2));
    console.log('RESULT_JSON_END');
  };

  const finalize = () => {
    if (finalized) return;
    finalized = true;
    if (endWaitTimer) clearTimeout(endWaitTimer);

    if (keypressCleanup) {
      try {
        keypressCleanup();
      } catch {}
      keypressCleanup = null;
    }

    try {
      micInstance?.stop?.();
    } catch {}
    try {
      speaker.current?.end?.();
    } catch {}
    try {
      rt.close();
    } catch {}

    printResult();
    process.exit(0);
  };

  const requestEnd = ({ by, tool, waitForResponseId = null }) => {
    if (ending) return;
    ending = true;
    endedBy = by;
    endTool = tool ?? null;
    endWaitResponseId = waitForResponseId;

    try {
      micInstance?.stop?.();
    } catch {}

    if (endWaitResponseId) {
      endWaitTimer = setTimeout(() => finalize(), 2500);
      return;
    }

    try {
      speaker.current?.end?.();
    } catch {}
    try {
      rt.send({ type: 'response.cancel' });
    } catch {}

    finalize();
  };

  const setupKeypress = () => {
    if (!process.stdin.isTTY) return () => {};
    readline.emitKeypressEvents(process.stdin);
    try {
      process.stdin.setRawMode(true);
    } catch {}
    process.stdin.resume();

    const onKeypress = (str, key) => {
      if (key?.ctrl && key?.name === 'c') return requestEnd({ by: 'keypress:ctrl+c' });
      if (key?.name === 'q') return requestEnd({ by: 'keypress:q' });
      if (key?.name === 'space') return requestEnd({ by: 'keypress:space' });
      if (str === 'q') return requestEnd({ by: 'keypress:q' });
      if (str === ' ') return requestEnd({ by: 'keypress:space' });
    };

    process.stdin.on('keypress', onKeypress);
    return () => {
      process.stdin.off('keypress', onKeypress);
      try {
        process.stdin.setRawMode(false);
      } catch {}
    };
  };

  keypressCleanup = setupKeypress();

  const flushPendingAudio = () => {
    if (!socketOpen || !sessionConfigured) return;
    while (pendingAudio.length > 0) {
      const chunk = pendingAudio.shift();
      const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      rt.send({ type: 'input_audio_buffer.append', audio: bytes.toString('base64') });
    }
  };

  const micSampleRate = Number.isFinite(args.micRate) ? args.micRate : MIC_SAMPLE_RATE;
  const micDevice = (args.micDevice ?? MIC_DEVICE ?? 'default').toString();
  ({ micInstance, micStream } = createMicInstance(mic, { device: micDevice, rate: micSampleRate }));

  micStream.on('data', (chunk) => {
    const int16 = decodePcm16le(chunk);
    if (!int16 || int16.length === 0) return;
    const resampled = resampleInt16Linear(int16, micSampleRate, REALTIME_SAMPLE_RATE);
    if (resampled.length === 0) return;

    pendingAudio.push(resampled);
    flushPendingAudio();
  });

  micStream.on('error', (err) => {
    console.error('Mic error:', err);
  });

  rt.on('conversation.item.created', (ev) => {
    const item = ev?.item;
    if (!item || item.type !== 'function_call') return;
    if (item.call_id) functionCallNameByCallId.set(item.call_id, item.name);
    if (item.id) functionCallNameByItemId.set(item.id, item.name);
  });

  rt.on('response.function_call_arguments.done', (ev) => {
    const name = functionCallNameByCallId.get(ev.call_id) ?? functionCallNameByItemId.get(ev.item_id);
    if (!name) return;
    if (name !== 'end_conversation') return;

    let toolArgs = {};
    try {
      toolArgs = ev.arguments ? JSON.parse(ev.arguments) : {};
    } catch {
      toolArgs = { arguments: ev.arguments };
    }

    try {
      rt.send({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: ev.call_id,
          output: 'OK'
        }
      });
    } catch {}

    requestEnd({
      by: 'tool:end_conversation',
      tool: { name, arguments: toolArgs },
      waitForResponseId: ev.response_id
    });
  });

  rt.socket.on('open', () => {
    socketOpen = true;
    rt.send({
      type: 'session.update',
      session: {
        type: 'realtime',
        output_modalities: ['audio'],
        instructions: sessionInstructions,
        tool_choice: 'auto',
        tools: [
          {
            type: 'function',
            name: 'end_conversation',
            description:
              'End the conversation when the user indicates they are done (e.g. goodbye). Provide a short summary of what you learned from the user.',
            parameters: {
              type: 'object',
              additionalProperties: false,
              properties: {
                reason: { type: 'string', description: 'Why the conversation is ending.' },
                summary: { type: 'string', description: 'Concise summary of what was learned from the user.' }
              },
              required: ['summary']
            }
          }
        ],
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24000 },
            transcription: transcriptionEnabled ? { language: 'en', model: TRANSCRIPTION_MODEL } : undefined,
            turn_detection: {
              type: 'server_vad',
              create_response: true,
              interrupt_response: true
            }
          },
          output: {
            format: { type: 'audio/pcm', rate: 24000 },
            voice: args.voice ?? REALTIME_VOICE
          }
        }
      }
    });

    rt.send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Start the conversation now.' }]
      }
    });

    rt.send({ type: 'response.create' });
  });

  rt.on('session.updated', () => {
    sessionConfigured = true;
    flushPendingAudio();
    if (!micStarted) {
      micInstance.start();
      micStarted = true;
    }
  });

  rt.on('response.output_audio.delta', (ev) => {
    const audioBytes = Buffer.from(ev.delta, 'base64');
    speaker.current.write(audioBytes);
  });

  rt.on('input_audio_buffer.speech_started', () => {
    resetSpeaker();
  });

  rt.on('conversation.item.input_audio_transcription.completed', (ev) => {
    transcripts.push({ role: 'user', text: ev.transcript, at: new Date().toISOString() });
    console.log(`USER: ${ev.transcript}`);
  });

  rt.on('response.output_audio_transcript.done', (ev) => {
    transcripts.push({ role: 'assistant', text: ev.transcript, at: new Date().toISOString() });
    console.log(`ASSISTANT: ${ev.transcript}`);
  });

  rt.on('response.done', (ev) => {
    if (!ending || !endWaitResponseId) return;
    const id = ev?.response?.id;
    if (!id || id === endWaitResponseId) finalize();
  });

  rt.on('error', (err) => {
    console.error('Realtime error:', err);
  });

  rt.socket.on('close', () => {
    console.log('Connection closed.');
  });

  process.on('SIGINT', () => requestEnd({ by: 'signal:SIGINT' }));
  process.on('SIGTERM', () => requestEnd({ by: 'signal:SIGTERM' }));
}

await main();
