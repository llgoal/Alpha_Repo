const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');

function section(start, end) {
  const first = html.indexOf(start);
  const last = html.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `Missing source section: ${start}`);
  return html.slice(first, last);
}

// Run the application's actual state and playback functions with controlled
// audio loading and timers, so cancellation races are deterministic.
const playbackSource = [
  section('    let sourceImage = null;', '    function midiToNote'),
  section('    function clearPlaybackTimers()', '    function makeNoiseBuffer'),
  section('    async function playScore()', '    async function handleImageFile')
].join('\n');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

function harness(audioReady = Promise.resolve()) {
  const samples = deferred();
  const timers = new Map();
  const played = [];
  let scheduled = 0;
  let sampleRequests = 0;
  const els = {
    status: { textContent: '' },
    instrument: { value: 'piano', options: [{ text: 'Piano' }], selectedIndex: 0 },
    duration: { value: '4n' },
    playMeter: { style: { width: '0%' } }
  };
  const schedule = (kind, fn, delay) => {
    const id = ++scheduled;
    timers.set(id, { kind, fn, delay });
    return id;
  };
  const context = vm.createContext({
    els,
    performance: { now: () => 0 },
    getAudioContext: () => audioReady,
    getSoundFontPiano: () => { sampleRequests++; return samples.promise; },
    redrawOverlay() {},
    durationToSeconds: () => 0.5,
    playBrowserNote: (...args) => played.push(args),
    setTimeout: (fn, delay) => schedule('timeout', fn, delay),
    clearTimeout: id => timers.delete(id),
    setInterval: (fn, delay) => schedule('interval', fn, delay),
    clearInterval: id => timers.delete(id)
  });
  vm.runInContext(playbackSource + `
    audioCtx = { currentTime: 0 };
    detected.notes = [{ note: 'C4', duration: '4n' }];
  `, context);
  return {
    context, samples, timers, played, els,
    get status() { return els.status.textContent; },
    get scheduled() { return scheduled; },
    get sampleRequests() { return sampleRequests; }
  };
}

test('Stop cancels playback while piano samples are loading', async () => {
  const app = harness();
  const playing = app.context.playScore();
  await flush();
  assert.match(app.status, /^Loading/);
  app.context.stopScore();
  app.samples.resolve({});
  await playing;
  assert.equal(app.status, 'Stopped.');
  assert.equal(app.scheduled, 0);
  assert.equal(app.played.length, 0);
  assert.equal(app.els.playMeter.style.width, '0%');
});

test('Stop during audio activation prevents subsequent sample loading', async () => {
  const audio = deferred();
  const app = harness(audio.promise);
  const playing = app.context.playScore();
  app.context.stopScore();
  audio.resolve();
  await playing;
  assert.equal(app.sampleRequests, 0);
  assert.equal(app.status, 'Stopped.');
  assert.equal(app.scheduled, 0);
});

test('an obsolete audio failure does not overwrite the stopped state', async () => {
  const audio = deferred();
  const app = harness(audio.promise);
  const playing = app.context.playScore();
  app.context.stopScore();
  audio.reject(new Error('Audio activation failed'));
  await playing;
  assert.equal(app.status, 'Stopped.');
  assert.equal(app.scheduled, 0);
});

test('only the most recent Play request schedules notes', async () => {
  const app = harness();
  const first = app.context.playScore();
  await flush();
  const second = app.context.playScore();
  await flush();
  app.samples.resolve({});
  await Promise.all([first, second]);
  assert.equal(app.scheduled, 3); // One note, completion, and progress meter.
  assert.match(app.status, /^Playing 1 notes/);
});

test('normal playback plays the note and completes', async () => {
  const app = harness();
  const playing = app.context.playScore();
  await flush();
  app.samples.resolve({});
  await playing;
  const timeouts = [...app.timers.values()].filter(timer => timer.kind === 'timeout');
  timeouts.sort((a, b) => a.delay - b.delay);
  timeouts[0].fn();
  assert.equal(app.played[0][0], 'C4');
  timeouts[1].fn();
  assert.equal(app.status, 'Playback complete.');
  assert.equal(app.timers.size, 0);
});

test('Stop clears playback timers after loading has finished', async () => {
  const app = harness();
  const playing = app.context.playScore();
  await flush();
  app.samples.resolve({});
  await playing;
  assert.equal(app.timers.size, 3);
  app.context.stopScore();
  assert.equal(app.timers.size, 0);
  assert.equal(app.status, 'Stopped.');
});
