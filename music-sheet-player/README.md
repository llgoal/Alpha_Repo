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
- The piano voice uses real Salamander Grand Piano recordings bundled in `piano-samples.js`, so it works offline and needs no CDN. If the samples cannot be decoded, playback falls back to the built-in piano synth.
- On iPhone/iPad, playback unlocks audio during the Play tap so the ring/silent switch does not mute it.

## Tests

Run the playback cancellation regression tests with Node.js 18 or later:

```sh
node --test tests/playback.test.cjs
```

## Limits

This is a strong prototype, not a production OMR engine. It is best with clean single-staff melodies. Dense piano scores, handwritten notation, multiple voices, ties, accidentals, lyrics, chord symbols, and percussion notation need a deeper OMR model and MusicXML export/import layer.

## Credits

Piano samples: [Salamander Grand Piano V3](https://github.com/Tonejs/audio/tree/master/salamander) by Alexander Holm, licensed [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). Trimmed to 5 seconds and re-encoded as mono MP3.
