import { hrtime } from 'node:process';
import { EventEmitter } from 'node:events';
import wrtc from '@roamhq/wrtc';
import JsSIP from 'jssip';

function ensureNodeWebRTCGlobals() {
  globalThis.window ??= globalThis;
  globalThis.navigator ??= {};
  globalThis.navigator.mediaDevices ??= {};

  if (typeof globalThis.navigator.mediaDevices.getUserMedia !== 'function') {
    globalThis.navigator.mediaDevices.getUserMedia = async () => {
      const { RTCAudioSource } = wrtc.nonstandard;
      const audioSource = new RTCAudioSource();
      const track = audioSource.createTrack();
      return new wrtc.MediaStream([track]);
    };
  }

  globalThis.RTCPeerConnection ??= wrtc.RTCPeerConnection;
  globalThis.RTCSessionDescription ??= wrtc.RTCSessionDescription;
  globalThis.RTCIceCandidate ??= wrtc.RTCIceCandidate;
  globalThis.MediaStream ??= wrtc.MediaStream;
  globalThis.MediaStreamTrack ??= wrtc.MediaStreamTrack;
}

function createControlledAudioStream() {
  const { RTCAudioSource } = wrtc.nonstandard;
  const audioSource = new RTCAudioSource();
  const track = audioSource.createTrack();
  const stream = new wrtc.MediaStream([track]);
  return { stream, audioSource, track };
}

class Int16ChunkQueue {
  constructor() {
    this._chunks = [];
    this._headOffset = 0;
    this._length = 0;
  }

  get length() {
    return this._length;
  }

  push(samples) {
    if (!samples || samples.length === 0) return;
    this._chunks.push(samples);
    this._length += samples.length;
  }

  reset() {
    this._chunks = [];
    this._headOffset = 0;
    this._length = 0;
  }

  readInto(out) {
    let written = 0;
    while (written < out.length && this._chunks.length > 0) {
      const head = this._chunks[0];
      const available = head.length - this._headOffset;
      const needed = out.length - written;
      const take = Math.min(available, needed);

      out.set(head.subarray(this._headOffset, this._headOffset + take), written);
      written += take;
      this._headOffset += take;
      this._length -= take;

      if (this._headOffset >= head.length) {
        this._chunks.shift();
        this._headOffset = 0;
      }
    }

    if (written < out.length) out.fill(0, written);
    return written;
  }
}

export class SIPClient extends EventEmitter {
  constructor(options = {}) {
    super();

    const { ws, uri, user, pass, displayName, autoAnswer = false } = options;
    if (!ws || !uri || !user || !pass) {
      throw new Error('SIPClient: ws, uri, user, pass are required');
    }

    ensureNodeWebRTCGlobals();

    this.options = { ws, uri, user, pass, displayName, autoAnswer };
    this._sessions = new WeakMap();

    const socket = new JsSIP.WebSocketInterface(ws);
    const configuration = {
      sockets: [socket],
      uri,
      password: pass,
      authorization_user: user,
      display_name: displayName,
      register: true,
      session_timers: false
    };

    this.ua = new JsSIP.UA(configuration);
  }

  start() {
    this.ua.on('registered', (e) => this.emit('registered', e));
    this.ua.on('registrationFailed', (e) => this.emit('registrationFailed', e));

    this.ua.on('newRTCSession', (data) => {
      const session = data.session;
      if (this._sessions.has(session)) return;

      const originator = data.originator;
      if (originator !== 'remote') return;

      if (!this.options.autoAnswer) {
        this.emit('incomingCall', session);
        return;
      }

      const { stream, audioSource } = createControlledAudioStream();
      const sipSession = new SIPSession(session, { audioSource });
      this._sessions.set(session, sipSession);
      this.emit('newSession', sipSession);

      session.answer({ mediaStream: stream });
    });

    this.ua.start();
  }

  stop() {
    this.ua.stop();
  }

  call(targetUri, options = {}) {
    const { stream, audioSource } = createControlledAudioStream();

    const session = this.ua.call(targetUri, {
      mediaConstraints: { audio: true, video: false },
      mediaStream: stream,
      ...options
    });

    const sipSession = new SIPSession(session, { audioSource });
    this._sessions.set(session, sipSession);
    this.emit('newSession', sipSession);
    return sipSession;
  }
}

export class SIPSession extends EventEmitter {
  constructor(session, { audioSource }) {
    super();
    this.session = session;
    this._audioSource = audioSource;

    this._stopped = false;
    this._incomingAudioSink = null;

    this._outgoing = new Int16ChunkQueue();

    this._audioSinkReadyResolve = null;
    this._audioSourceReadyResolve = null;
    this._audioSinkReady = new Promise((resolve) => {
      this._audioSinkReadyResolve = resolve;
    });
    this._audioSourceReady = new Promise((resolve) => {
      this._audioSourceReadyResolve = resolve;
    });

    this._startOutgoingPump();
    this._bindSessionEvents();
  }

  getAudioSink() {
    return this._audioSinkReady;
  }

  getAudioSource() {
    return this._audioSourceReady;
  }

  getDirection() {
    return this.session.direction;
  }

  terminate() {
    this._stopped = true;
    try {
      this.session.terminate();
    } catch {}
  }

  onData(data) {
    if (data === 'reset') return this._outgoing.reset();
    if (!data || typeof data !== 'object') return;
    if (data.samples && data.samples.length) this._outgoing.push(data.samples);
  }

  _bindSessionEvents() {
    const session = this.session;

    let candidateTimer = null;
    session.on('icecandidate', (e, maybeReady) => {
      const ready = typeof maybeReady === 'function' ? maybeReady : e?.ready;
      if (typeof ready !== 'function') return;
      if (candidateTimer) clearTimeout(candidateTimer);
      candidateTimer = setTimeout(ready, 333);
    });

    session.on('confirmed', () => {
      this._attachIncomingAudioSink();
    });

    session.on('failed', (e) => {
      this._stopped = true;
      this._cleanupIncomingAudioSink();
      this.emit('sessionFailed', e);
    });

    session.on('ended', (e) => {
      this._stopped = true;
      this._cleanupIncomingAudioSink();
      this.emit('sessionEnded', e);
    });
  }

  _attachIncomingAudioSink() {
    try {
      const pc = this.session.connection;
      if (!pc) return;

      const receivers = pc.getReceivers?.() ?? [];
      const audioReceiver = receivers.find((r) => r.track && r.track.kind === 'audio');
      if (!audioReceiver?.track) return;

      const { RTCAudioSink } = wrtc.nonstandard;
      this._incomingAudioSink = new RTCAudioSink(audioReceiver.track);
      this._incomingAudioSink.ondata = (data) => {
        this.emit('onData', data);
      };

      this._audioSinkReadyResolve?.(this);
      this._audioSinkReadyResolve = null;
    } catch (err) {
      this.emit('error', err);
    }
  }

  _cleanupIncomingAudioSink() {
    try {
      this._incomingAudioSink?.stop?.();
    } catch {}
    this._incomingAudioSink = null;
  }

  _startOutgoingPump() {
    const audioSource = this._audioSource;

    const frameSize = 240;
    const sampleRate = 24000;
    const frame = new Int16Array(frameSize);
    const empty = new Int16Array(frameSize);

    let nextTick = null;

    const pump = () => {
      if (this._stopped) return;

      const hasAudio = this._outgoing.length > 0;
      if (hasAudio) {
        frame.fill(0);
        this._outgoing.readInto(frame);
        audioSource.onData({
          samples: frame,
          sampleRate,
          bitsPerSample: 16,
          channelCount: 1,
          numberOfFrames: frameSize
        });
      } else {
        audioSource.onData({
          samples: empty,
          sampleRate,
          bitsPerSample: 16,
          channelCount: 1,
          numberOfFrames: frameSize
        });
      }

      const now = hrtime.bigint();
      let delayNs = 10_000_000n;
      if (nextTick !== null) {
        const drift = nextTick - now;
        if (-4_000_000n <= drift && drift <= 5_000_000n) delayNs += drift;
      }
      nextTick = now + delayNs;

      setTimeout(pump, Math.max(0, Math.round(Number(delayNs / 1_000_000n))));
    };

    pump();
    this._audioSourceReadyResolve?.(this);
    this._audioSourceReadyResolve = null;
  }
}
