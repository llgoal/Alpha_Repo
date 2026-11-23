// Piano playback for recognized scores, using the bundled Salamander Grand
// Piano samples (piano-samples.js). Notes are pitch-shifted from the nearest
// sample and scheduled on the Web Audio clock, so timing stays exact.
(function (global) {
  'use strict';

  const SAMPLES = global.PIANO_SAMPLES || {};
  const SAMPLE_MIDIS = Object.keys(SAMPLES).map(Number).sort((a, b) => a - b);

  let ctx = null;
  let output = null;
  const buffers = new Map(); // midi -> AudioBuffer | Promise
  let active = [];

  function nearestSample(midi) {
    let best = SAMPLE_MIDIS[0];
    for (const m of SAMPLE_MIDIS) if (Math.abs(m - midi) < Math.abs(best - midi)) best = m;
    return best;
  }

  function base64ToArrayBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  function decode(data) {
    // The callback form also works on older Safari.
    return new Promise((resolve, reject) => {
      const p = ctx.decodeAudioData(data, resolve, reject);
      if (p && p.then) p.then(resolve, reject);
    });
  }

  // Must run inside a click/tap handler so browsers allow audio output.
  function unlock() {
    const Ctor = global.AudioContext || global.webkitAudioContext;
    if (!Ctor) throw new Error('This browser cannot play Web Audio.');
    // A context that is not running by now was paused by the system (on
    // iPhone: after the photo picker or camera, a call, another app's
    // sound). Its resume() can then wait forever, so start a fresh one,
    // inside this tap. Decoded samples are kept: they work in any context.
    if (ctx && ctx.state !== 'running') {
      try { ctx.close(); } catch (e) { /* already closed */ }
      ctx = null;
    }
    if (!ctx) {
      ctx = new Ctor();
      output = null;
      active = [];
    }
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { /* optional API */ }
    // Never wait more than 3 s for the sound to start.
    const resumed = ctx.state !== 'running'
      ? Promise.race([ctx.resume(), new Promise((_, no) => setTimeout(() => no(new Error('the sound did not start. Tap Play again.')), 3000))])
      : Promise.resolve();
    // A one-sample buffer started inside the gesture unlocks iOS Safari.
    try {
      const src = ctx.createBufferSource();
      src.buffer = ctx.createBuffer(1, 1, ctx.sampleRate || 44100);
      src.connect(ctx.destination);
      src.start(0);
    } catch (e) { /* best effort */ }
    return resumed;
  }

  function getOutput() {
    if (output) return output;
    const input = ctx.createGain();
    const dry = ctx.createGain();
    const wet = ctx.createGain();
    const reverb = ctx.createConvolver();
    const comp = ctx.createDynamicsCompressor();
    dry.gain.value = 0.9;
    wet.gain.value = 0.2;
    const len = Math.floor(ctx.sampleRate * 2.2);
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2);
    }
    reverb.buffer = ir;
    comp.threshold.value = -14;
    comp.ratio.value = 3;
    input.connect(dry);
    input.connect(reverb);
    reverb.connect(wet);
    dry.connect(comp);
    wet.connect(comp);
    comp.connect(ctx.destination);
    output = input;
    return output;
  }

  // Decodes the samples needed for these MIDI notes (awaiting decodes that
  // are already in flight too).
  async function load(midis) {
    if (!SAMPLE_MIDIS.length) throw new Error('Piano samples are missing.');
    const wanted = [...new Set(midis.map(nearestSample))];
    await Promise.all(wanted.map(m => {
      if (buffers.has(m)) return buffers.get(m);
      const p = decode(base64ToArrayBuffer(SAMPLES[m])).then(buf => { buffers.set(m, buf); return buf; },
        err => { buffers.delete(m); throw err; }); // try again next time
      buffers.set(m, p);
      return p;
    }));
  }

  function playNote(midi, when, seconds, velocity = 0.9) {
    midi = Math.max(21, Math.min(108, midi));
    const sm = nearestSample(midi);
    const buf = buffers.get(sm);
    if (!(buf instanceof AudioBuffer)) return null;
    const start = Math.max(ctx.currentTime + 0.01, when);
    // Damper: the note rings a little past its written length.
    const release = midi > 84 ? 0.3 : midi > 60 ? 0.5 : 0.75;
    const stopAt = Math.min(start + buf.duration, start + Math.max(0.12, seconds) + release);
    const src = ctx.createBufferSource();
    const gain = ctx.createGain();
    src.buffer = buf;
    src.playbackRate.value = Math.pow(2, (midi - sm) / 12);
    gain.gain.setValueAtTime(velocity, start);
    gain.gain.setValueAtTime(velocity, Math.max(start, stopAt - release));
    gain.gain.exponentialRampToValueAtTime(0.0001, stopAt);
    src.connect(gain);
    gain.connect(getOutput());
    src.start(start);
    src.stop(stopAt + 0.05);
    active.push(src);
    src.onended = () => {
      active = active.filter(s => s !== src);
      src.disconnect();
      gain.disconnect();
    };
    return src;
  }

  function stopAll() {
    for (const s of active) {
      try { s.stop(0); } catch (e) { /* already stopped */ }
    }
    active = [];
  }

  global.PianoPlayer = {
    unlock,
    load,
    playNote,
    stopAll,
    get context() { return ctx; }
  };
})(typeof window !== 'undefined' ? window : this);
