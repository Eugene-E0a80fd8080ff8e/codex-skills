function removeListener(emitter, event, listener) {
  if (typeof emitter?.off === 'function') return emitter.off(event, listener);
  if (typeof emitter?.removeListener === 'function') return emitter.removeListener(event, listener);
  if (typeof emitter?.removeEventListener === 'function') return emitter.removeEventListener(event, listener);
}

export function pipeAudio(fromEmitter, toReceiver) {
  if (typeof fromEmitter?.on !== 'function') {
    throw new Error('pipeAudio: fromEmitter must support .on(event, listener)');
  }
  if (typeof toReceiver?.onData !== 'function') {
    throw new Error('pipeAudio: toReceiver must implement .onData(data)');
  }

  const handler = (data) => toReceiver.onData(data);
  fromEmitter.on('onData', handler);
  return () => removeListener(fromEmitter, 'onData', handler);
}

