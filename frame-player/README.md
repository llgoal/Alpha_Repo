# Frame Studio

A static, responsive frame-by-frame video viewer.

## Features

- Load a YouTube URL, browser-accessible HTTPS video URL, or local video file.
- Step backward or forward using the selected FPS estimate.
- Control YouTube through its official IFrame Player API; direct and local files use the browser media pipeline and canvas.
- Scrub, change playback speed, mute, and enter fullscreen.
- Keyboard shortcuts for frame stepping and five-second skips.

## Limitations

YouTube frame stepping uses time-based seeking and the selected FPS, so it is an estimate rather than codec-level frame accuracy. Some YouTube videos disable embedding or have privacy, age, region, or account restrictions. Other remote sources must be direct media URLs the browser can load; codec, CORS, authentication, range-request, and mixed-content restrictions still apply.

Use only while parked or by a passenger. This project does not override vehicle or browser playback safety controls.
