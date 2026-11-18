# ScoreLens Piano

Take a photo of a short printed melody, read the notes, and play them back on a sampled grand piano. Everything runs in the browser; images are never uploaded.

## Run

From this directory:

```sh
python3 -m http.server 8787
```

Then open <http://127.0.0.1:8787/> and press **Demo score**, or upload a PNG/JPG/PDF, take a photo, drag an image in, or paste a screenshot. `mobile.html` redirects to the same page.

## What v1 reads

- One or more single-voice staves, printed (engraved) notation.
- Treble and bass clef (alto/tenor are detected but rarely tested); a clef menu overrides detection.
- Key signatures, accidentals (sharp, flat, natural) with bar-long carry.
- Whole, half, quarter, eighth, sixteenth and thirty-second notes, single and double dots, beams and flags.
- Whole/half/quarter/eighth/sixteenth rests, barlines, simple chords on one stem.
- Ledger lines above and below the staff, slightly rotated photos, uneven lighting.

Not yet: handwritten music, grand-staff piano scores played as two hands, multiple voices on one staff, ties, triplets, repeats and dynamics. The time signature is detected but playback follows the written note values.

Accuracy on the test set (rendered with Verovio in four music fonts): 98.8% of symbols on clean images (566 symbols) and 97.6% on blurred, noisy, rotated and photo-like copies (915 symbols).

## Files

- `index.html` – the app UI, drawing, and playback scheduling.
- `omr.js` – the recognizer. `OMR.recognize(rgbaOrGray, width, height, { clef })` returns staves (clef, key, lines, barlines) and events (`{ type: 'note', pitches, midi, name, beats }` or `{ type: 'rest', beats }`). Works in the browser and in Node.
- `player.js` – Web Audio piano: `PianoPlayer.unlock()` (call inside a tap), `load(midis)`, `playNote(midi, when, seconds)`, `stopAll()`.
- `piano-samples.js` – Salamander Grand Piano samples embedded as base64, so playback works offline and inside sandboxed previews.
- `demo.png` – the demo score.

## How recognition works

Normalize lighting and binarize; measure staff line thickness and spacing from run lengths; rescale so a staff space is about 20 px; deskew; find five-line staves; erase staff and ledger lines. Noteheads are found at the half-space positions where they can sit (solid cores for filled heads, enclosed holes for hollow ones), then stems, beams, flags, dots and accidentals are attached by measuring ink around each head. The header gives clef, key and time signature; rests are classified by shape. All thresholds are in staff spaces, so the scale of the image does not matter.

## Tests

With Node.js 18 or later, from the repository root:

```sh
node --test music-sheet-player/tests/omr.test.cjs
```

Each fixture in `tests/fixtures/` is a score image with its expected `midi:beats` sequence; the tests need no packages.

## Credits

Piano samples: [Salamander Grand Piano](https://archive.org/details/SalamanderGrandPianoV3) by Alexander Holm, CC BY 3.0.
