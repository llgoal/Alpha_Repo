# Frame Studio

A static, responsive frame-by-frame MP4 viewer powered by WebCodecs.

## Features

- Load a YouTube URL, browser-accessible HTTPS MP4 URL, or local MP4 file.
- Demux MP4 files with MP4Box.js and decode compressed samples with `VideoDecoder`.
- Draw decoded `VideoFrame` objects directly to canvas without an HTML `<video>` element.
- Step through actual MP4 video samples; remote MP4 files are requested in HTTP Range chunks.
- Control YouTube through its official IFrame Player API.
- Scrub, change playback speed, mute, and enter fullscreen.
- Keyboard shortcuts for frame stepping and five-second skips.

## Limitations

Canvas/WebCodecs mode is silent and currently supports MP4 only. Codec support depends on the browser; H.264/AVC MP4 is the safest choice. Remote sources must permit CORS and Range reads. YouTube frame stepping remains time-based and estimated because YouTube is handled by its official player; some videos disable embedding or have privacy, age, region, or account restrictions.

Use only while parked or by a passenger. This project does not override vehicle or browser playback safety controls.
