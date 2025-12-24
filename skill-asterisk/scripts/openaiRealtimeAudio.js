import { EventEmitter } from 'node:events';
import { OpenAIRealtimeWebSocket } from 'openai/beta/realtime/websocket';

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

export default class OpenAIRealtimeAudio extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = {
      model: 'gpt-4o-mini-realtime-preview',
      voice: 'alloy',
      prompt: '',
      tools: [],
      toolHandlers: {},
      inputAudioSampleRate: 24000,
      enableTranscription: true,
      ...options
    };

    this._connected = false;
    this._sessionReady = false;
    this._pendingInput = [];

    this._audioSinkReadyResolve = null;
    this._audioSourceReadyResolve = null;
    this._audioSinkReady = new Promise((resolve) => {
      this._audioSinkReadyResolve = resolve;
    });
    this._audioSourceReady = new Promise((resolve) => {
      this._audioSourceReadyResolve = resolve;
    });

    this._transcripts = [];
  }

  getAudioSink() {
    return this._audioSinkReady;
  }

  getAudioSource() {
    return this._audioSourceReady;
  }

  getTranscripts() {
    return [...this._transcripts];
  }

  start() {
    this.rt = new OpenAIRealtimeWebSocket({
      type: 'session.create',
      model: this.options.model,
      modalities: ['text', 'audio'],
      turn_detection: { type: 'server_vad' },
      input_audio_format: 'pcm16',
      voice: this.options.voice,
      tools: this.options.tools,
      dangerouslyAllowBrowser: true
    });

    this.rt.socket.addEventListener('open', () => {
      this._connected = true;
    });

    this.rt.on('session.created', () => {
      this._sessionReady = true;
      this._audioSourceReadyResolve?.(this);
      this._audioSourceReadyResolve = null;

      this.rt.send({
        type: 'session.update',
        session: {
          tools: this.options.tools,
          input_audio_transcription: this.options.enableTranscription
            ? { language: 'en', model: 'gpt-4o-mini-transcribe' }
            : undefined,
          instructions: 'Use audio modality in outputs.',
          modalities: ['audio', 'text']
        }
      });

      if (this.options.prompt && this.options.prompt.trim()) {
        this.rt.send({
          type: 'conversation.item.create',
          item: {
            role: 'system',
            type: 'message',
            content: [{ type: 'input_text', text: this.options.prompt }]
          }
        });
      }

      this.rt.send({
        type: 'response.create',
        response: { modalities: ['audio', 'text'] }
      });

      this._flushPendingInput();
    });

    this.rt.on('response.audio.delta', (ev) => {
      this._audioSinkReadyResolve?.(this);
      this._audioSinkReadyResolve = null;

      const buf = Buffer.from(ev.delta, 'base64');
      const samples = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));

      this.emit('onData', {
        samples,
        sampleRate: 24000,
        bitsPerSample: 16,
        channelCount: 1,
        numberOfFrames: samples.length
      });
    });

    this.rt.on('response.audio_transcript.done', (ev) => {
      this._transcripts.push({ role: 'assistant', content: ev.transcript, datetime: new Date() });
    });

    this.rt.on('conversation.item.input_audio_transcription.completed', (ev) => {
      this._transcripts.push({ role: 'user', content: ev.transcript, datetime: new Date() });
    });

    this.rt.on('response.function_call_arguments.done', (ev) => {
      const handler = this.options.toolHandlers?.[ev.name];
      if (typeof handler !== 'function') return;
      const args = ev.arguments ? JSON.parse(ev.arguments) : {};
      handler(args);
    });

    this.rt.on('input_audio_buffer.speech_started', () => {
      this.emit('onData', 'reset');
    });

    this.rt.on('error', (err) => this.emit('error', err));
    this.rt.socket.addEventListener('close', () => this.emit('close'));
  }

  close() {
    try {
      this.rt?.close?.();
    } catch {}
  }

  onData(data) {
    if (!data || typeof data !== 'object') return;
    if (!data.samples || !data.samples.length) return;

    const inRate = data.sampleRate ?? 24000;
    const resampled = resampleInt16Linear(data.samples, inRate, this.options.inputAudioSampleRate);

    this._pendingInput.push(resampled);
    this._flushPendingInput();
  }

  _flushPendingInput() {
    if (!this._connected || !this._sessionReady) return;
    while (this._pendingInput.length > 0) {
      const chunk = this._pendingInput.shift();
      const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      this.rt.send({
        type: 'input_audio_buffer.append',
        audio: bytes.toString('base64')
      });
    }
  }
}

