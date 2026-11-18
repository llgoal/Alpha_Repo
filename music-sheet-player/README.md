# ScoreLens Piano

Take a photo of a short printed melody, read the notes, and play them back on a sampled grand piano. Everything runs in the browser; images are never uploaded.

## Run

From this directory:

```sh
python3 -m http.server 8787
```

Then open <http://127.0.0.1:8787/> and press **Melody demo** or **Piano demo**, or upload a PNG/JPG/PDF, take a photo, drag an image in, or paste a screenshot. `mobile.html` redirects to the same page.

## What v1 reads

- One or more staves of printed (engraved) notation, one voice per staff.
- Piano music: a treble and a bass staff joined by a brace (or system barline) are read as right and left hand and played together, kept in step bar by bar. A menu plays both hands or one hand alone.
- Treble and bass clef (alto/tenor are detected but rarely tested); a clef menu overrides detection.
- Key signatures, accidentals (sharp, flat, natural) with bar-long carry.
- Whole, half, quarter, eighth, sixteenth and thirty-second notes, single and double dots, beams and flags.
- Whole/half/quarter/eighth/sixteenth rests, barlines, simple chords on one stem.
- Ledger lines above and below the staff, slightly rotated photos, uneven lighting, and phone photos of a book page whose lines bend toward the spine or the edge.
- Chords with heads stacked in thirds (e.g. G–B–D in the left hand).

Not yet: handwritten music, multiple voices on one staff, ties, triplets, repeats and dynamics. The time signature is detected but playback follows the written note values.

Accuracy on the test set (rendered with Verovio in four music fonts), as the share of notes and rests read with the right pitch and length:

| Set | Symbols | Accuracy |
| --- | --- | --- |
| Single-line scores, clean | 566 | 99.3% |
| Single-line scores, blurred / noisy / rotated / photo-like | 915 | 98.8% |
| Piano (both hands), clean | 409 | 99.3% |
| Piano (both hands), blurred / noisy / rotated / photo-like | 925 | 97.0% |
| A user's piano screenshot (Twinkle with Alberti bass) and 4 degraded copies | 440 | 99.5% |
| A phone photo of a printed piano book page (curved page, 5 systems, slurs, fingerings, pencil marks) | 185 | 97.8% |
| A phone photo of a beginner piano page (Brother John, taken at an angle, shaded edge) | 40 | 97.5% |
| 60 beginner piano pieces in method-book style (public-domain Essen folk melodies with bass lines, chords, lyrics, fingering, slurs) | 3362 | 97.5% |
| The same 60 pieces as simulated phone photos (angle, page curl, uneven light, blur, JPEG) | 3362 | 88.8% |

On every piano test image the two staves were paired into the right systems.

## Files

- `index.html` – the app UI, drawing, and playback scheduling.
- `omr.js` – the recognizer. `OMR.recognize(rgbaOrGray, width, height, { clef })` returns staves (clef, key, lines, barlines) and events (`{ type: 'note', pitches, midi, name, beats, start, hand }` or `{ type: 'rest', beats, start, hand }`; `start` is in beats from the beginning and `hand` is `'right'`, `'left'` or `null`), and `systems` (which staves play together). Works in the browser and in Node.
- `player.js` – Web Audio piano: `PianoPlayer.unlock()` (call inside a tap), `load(midis)`, `playNote(midi, when, seconds)`, `stopAll()`.
- `piano-samples.js` – Salamander Grand Piano samples embedded as base64, so playback works offline and inside sandboxed previews.
- `demo.png`, `demo-piano.png` – the demo scores.

## How recognition works

Normalize lighting and binarize; measure staff line thickness and spacing from run lengths; rescale so a staff space is about 20 px; deskew; find five-line staves in vertical strips (trying a few slopes in each, so curved lines of a photographed page are followed), link them across the page and trace each line; erase staff and ledger lines. Noteheads are found at the half-space positions where they can sit (solid cores for filled heads, enclosed holes for hollow ones), then stems, beams, flags, dots and accidentals are attached by measuring ink around each head. The header gives clef, key and time signature; rests are classified by shape. If the bars of a line do not add up, the page is read a second time with a slightly darker threshold (faint stems in a photo) and the reading whose bars add up better is kept. All thresholds are in staff spaces, so the scale of the image does not matter.

## Tests

With Node.js 18 or later, from the repository root:

```sh
node --test music-sheet-player/tests/omr.test.cjs
```

Each fixture in `tests/fixtures/` is a score image with its expected `midi:beats` sequence, and `tests/fixtures-piano/` holds piano scores with the notes of each hand; the tests need no packages.

## Credits

Piano samples: [Salamander Grand Piano](https://archive.org/details/SalamanderGrandPianoV3) by Alexander Holm, CC BY 3.0.
