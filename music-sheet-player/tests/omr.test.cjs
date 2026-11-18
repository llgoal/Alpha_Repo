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
