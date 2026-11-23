// Recognition tests: each fixture is a rendered score (some blurred, rotated,
// noisy or photo-like) with the notes it contains as "midi:beats" / "R:beats".
// Run with: node --test music-sheet-player/tests
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const OMR = require('../omr.js');

// Minimal PNG reader (8-bit, non-interlaced) so the tests need no packages.
function readPng(file) {
  const buf = fs.readFileSync(file);
  let pos = 8, width = 0, height = 0, depth = 0, type = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const kind = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (kind === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      depth = data[8]; type = data[9];
      if (depth !== 8 || data[12] !== 0) throw new Error('unsupported PNG ' + file);
    } else if (kind === 'IDAT') idat.push(data);
    else if (kind === 'IEND') break;
    pos += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[type];
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pix = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? pix[dst + x - channels] : 0;
      const b = y > 0 ? pix[dst - stride + x] : 0;
      const c = x >= channels && y > 0 ? pix[dst - stride + x - channels] : 0;
      let v = raw[src + x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      pix[dst + x] = v & 255;
    }
  }
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * channels;
    const g = pix[s];
    rgba[i * 4] = channels >= 3 ? pix[s] : g;
    rgba[i * 4 + 1] = channels >= 3 ? pix[s + 1] : g;
    rgba[i * 4 + 2] = channels >= 3 ? pix[s + 2] : g;
    rgba[i * 4 + 3] = channels === 4 ? pix[s + 3] : channels === 2 ? pix[s + 1] : 255;
  }
  return { width, height, rgba };
}

const dir = path.join(__dirname, 'fixtures');
for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort()) {
  const name = file.replace(/\.json$/, '');
  test(`recognizes ${name}`, () => {
    const { expected } = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    const img = readPng(path.join(dir, name + '.png'));
    const res = OMR.recognize(img.rgba, img.width, img.height);
    const got = res.events.map(e => (e.type === 'note' ? `${e.midi}:${e.beats}` : `R:${e.beats}`));
    assert.deepStrictEqual(got, expected);
  });
}

test('the demo score reads exactly', () => {
  const img = readPng(path.join(__dirname, '..', 'demo.png'));
  const res = OMR.recognize(img.rgba, img.width, img.height);
  assert.strictEqual(res.staves.length, 4);
  assert.strictEqual(res.staves[0].clef, 'treble');
  assert.deepStrictEqual(res.staves[0].key, { type: 'sharp', count: 1 });
  const notes = res.events.filter(e => e.type === 'note');
  assert.strictEqual(notes.length, 53);
  assert.deepStrictEqual(notes.slice(0, 6).map(e => e.name), ['D4', 'G4', 'G4', 'A4', 'B4', 'B4']);
});

test('a blank page reports no staff', () => {
  const w = 400, h = 200;
  const res = OMR.recognize(new Uint8Array(w * h).fill(255), w, h);
  assert.strictEqual(res.staves.length, 0);
  assert.strictEqual(res.events.length, 0);
  assert.ok(res.warnings.length > 0);
});

test('note names', () => {
  assert.strictEqual(OMR.noteName(60), 'C4');
  assert.strictEqual(OMR.noteName(66), 'F#4');
  assert.strictEqual(OMR.noteName(70), 'Bb4');
});

// Piano music: a treble and a bass staff joined by a brace. Each fixture
// lists the notes of each hand ("midi+midi:beats" for chords).
const pianoDir = path.join(__dirname, 'fixtures-piano');
const chordToken = e => (e.type === 'note' ? e.pitches.map(p => p.midi).sort((a, b) => a - b).join('+') + ':' + e.beats : 'R:' + e.beats);
for (const file of fs.readdirSync(pianoDir).filter(f => f.endsWith('.json')).sort()) {
  const name = file.replace(/\.json$/, '');
  test(`reads both hands of ${name}`, () => {
    const { hands } = JSON.parse(fs.readFileSync(path.join(pianoDir, file), 'utf8'));
    const img = readPng(path.join(pianoDir, name + '.png'));
    const res = OMR.recognize(img.rgba, img.width, img.height);
    assert.ok(res.systems.length > 0 && res.systems.every(s => s.staves.length === 2), 'staves paired into piano systems');
    const got = { right: [], left: [] };
    for (const e of res.events) got[e.hand].push(chordToken(e));
    assert.deepStrictEqual(got.right, hands.rh);
    assert.deepStrictEqual(got.left, hands.lh);
    // The hands stay in step: each bar starts at the same beat in both.
    for (const sys of res.systems) {
      const starts = sys.staves.map(idx => {
        const m = new Map();
        for (const e of res.events) if (e.staff === idx && !m.has(e.measure)) m.set(e.measure, e.start);
        return [...m.values()];
      });
      assert.deepStrictEqual(starts[0], starts[1]);
    }
  });
}

test('single-line music is not paired into piano systems', () => {
  const img = readPng(path.join(__dirname, '..', 'demo.png'));
  const res = OMR.recognize(img.rgba, img.width, img.height);
  assert.ok(res.systems.every(s => s.staves.length === 1));
  // Lines play one after another.
  let prev = -1;
  for (const e of res.events) { assert.ok(e.start >= prev); prev = e.start; }
});

// The AI reader's notes are put on the page's own barlines: a bar it ran
// short (a dropped note) takes the page's reading, and the hands stay together.
test('a second reader missing a note keeps the hands together', () => {
  const staff = (index, top, clef, hand) => ({
    index, left: 0, right: 400, headerEnd: 0, clef, hand, key: { type: null, count: 0 }, time: '4/4',
    lines: [0, 1, 2, 3, 4].map(i => [top + 20 * i, top + 20 * i]), bars: [100, 200, 300, 400], repeats: [], voltas: []
  });
  const half = (staffIdx, x, k, midi) => ({
    type: 'note', beats: 2, base: 2, staff: staffIdx, x, y: 0,
    pitches: [{ midi, name: OMR.noteName(midi), x, y: 0, k }], midi, name: OMR.noteName(midi)
  });
  // Page reading: four bars of two half notes in each hand.
  const local = {
    staves: [staff(0, 0, 'treble', 'right'), staff(1, 200, 'bass', 'left')],
    systems: [{ staves: [0, 1] }], space: 20, scale: 1, tempo: null,
    toImage: (x, y) => ({ x, y }), fromImage: (x, y) => ({ x, y }), events: []
  };
  for (let b = 0; b < 4; b++) {
    local.events.push(half(0, b * 100 + 30, 4, 71), half(0, b * 100 + 70, 3, 72));
    local.events.push(half(1, b * 100 + 30, 4, 50), half(1, b * 100 + 70, 4, 50));
  }
  for (const e of local.events) e.y = e.pitches[0].y = local.staves[e.staff].lines[2][0];
  // Second reader: same notes, but the right hand's bar 2 lost its second note.
  const ext = { engine: 'homr', staves: [{ hand: 'right', clef: 'treble', key: { type: 'sharp', count: 2 } }, { hand: 'left', clef: 'bass', key: { type: 'sharp', count: 2 } }], events: [] };
  for (const e of local.events) {
    const hand = e.staff === 0 ? 'right' : 'left';
    if (hand === 'right' && e.x === 170) continue;
    const m = Math.floor(e.x / 100), start = m * 4 + (e.x % 100 > 50 ? 2 : 0);
    ext.events.push({ type: 'note', beats: 2, hand, measure: m, x: e.x + 3, y: e.y, start, starts: [start],
      pitches: e.pitches.map(p => Object.assign({}, p, { midi: p.midi + 1, x: p.x + 3 })) });
  }
  const res = OMR.mergeExternal(local, ext);
  assert.ok(res);
  assert.strictEqual(res.measures, 4);
  assert.strictEqual(res.filledBars, 1);
  const rh = res.events.filter(e => e.hand === 'right'), lh = res.events.filter(e => e.hand === 'left');
  assert.deepStrictEqual(rh.map(e => e.start), [0, 2, 4, 6, 8, 10, 12, 14]);
  assert.deepStrictEqual(lh.map(e => e.start), [0, 2, 4, 6, 8, 10, 12, 14]);
  // The filled note is spelled with the second reader's key (C sharp).
  assert.strictEqual(rh[3].midi, 73);
});

// The AI reader's own bars, repeats and endings are kept; a note value it
// misread (a bar that doesn't add up in one hand) is put right.
test('second reader: misread value fixed, repeats kept', () => {
  const ev = (hand, measure, start, beats, midi) => ({ type: midi ? 'note' : 'rest', hand, staff: hand === 'right' ? 0 : 1, measure, start, starts: [start], beats,
    pitches: midi ? [{ midi, name: OMR.noteName(midi) }] : undefined });
  // 3/8 with a pickup: bar 0 = two sixteenths; bar 1 has six sixteenths but
  // the first was read as an eighth; bar 2 is the end of a repeat.
  const ext = { staves: [{ hand: 'right', time: '3/8' }, { hand: 'left', time: '3/8' }], playOrder: [1, 2, 3, 1, 2, 3], events: [
    ev('right', 0, 0, 0.25, 76), ev('right', 0, 0.25, 0.25, 75), ev('left', 0, 0, 0.5),
    ev('right', 1, 0.5, 0.5, 76), ev('right', 1, 1, 0.25, 75), ev('right', 1, 1.25, 0.25, 76), ev('right', 1, 1.5, 0.25, 71), ev('right', 1, 1.75, 0.25, 74), ev('right', 1, 2, 0.25, 72),
    ev('left', 1, 0.5, 1.5),
    ev('right', 2, 2.25, 0.5, 69), ev('right', 2, 2.75, 1, null), ev('left', 2, 2.25, 0.25, 45), ev('left', 2, 2.5, 0.25, 52), ev('left', 2, 2.75, 0.25, 57), ev('left', 2, 3, 0.75)
  ] };
  const res = OMR.repairExternal(ext);
  assert.strictEqual(res.fixedValues, 1);
  assert.strictEqual(res.events[3].beats, 0.25);
  assert.ok(res.pickup);
  assert.strictEqual(res.totalBeats, 2 * (0.5 + 1.5 + 1.5));
  // The C after the fix ends bar 1 exactly; bar 2 starts at 2.0 and is played twice.
  assert.deepStrictEqual(res.events[8].starts, [1.75, 5.25]);
  assert.deepStrictEqual(res.events[10].starts, [2, 5.5]);
});
