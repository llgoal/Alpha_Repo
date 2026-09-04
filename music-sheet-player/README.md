# ScoreLens Studio

A local browser app for reading simple sheet-music images, recognizing note heads on a single staff, editing the recognized sequence, and playing it back with different instrument voices.

## Run

From this directory:

```sh
python3 -m http.server 8787
```

Then open:

```text
http://127.0.0.1:8787/
```

The default page adapts to phone, tablet, and desktop screens. Existing `mobile.html` links redirect to this same page.

## What Works Now

- Upload PNG/JPG sheet images.
- Upload a PDF and render page 1 for recognition.
- Use camera preview/capture from localhost.
- Detect staff lines and note heads for clean monophonic scores.
- Edit recognized notes in a list or text box.
- Play back using piano, violin, flute, guitar, marimba, or pure tone voices.
- Tune threshold, tempo, clef, transpose, and overlay display.

## Tests

Run the playback cancellation regression tests with Node.js 18 or later:

```sh
node --test tests/playback.test.cjs
```

## Limits

This is a strong prototype, not a production OMR engine. It is best with clean single-staff melodies. Dense piano scores, handwritten notation, multiple voices, ties, accidentals, lyrics, chord symbols, and percussion notation need a deeper OMR model and MusicXML export/import layer.
