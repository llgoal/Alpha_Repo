# Frame Studio

Turns a video into individual frame images plus its sound, then plays the
frames back at their frame rate with the sound in sync, so it looks like the
video. Paste a YouTube link, or upload a video file (MKV, MP4, MOV, WebM … up to
64 GB; on a computer you can also drop it on the page); your Mac mini downloads it,
splits it with ffmpeg and keeps it in a library you can play or delete.

## How it works

- `server/server.py` (Python, standard library only) runs on the Mac mini and
  serves the player. For each video it runs **yt-dlp** (links) and then one
  **ffmpeg** pass that writes `frames/000001.jpg …` at the chosen frame rate
  and size, plus `audio.m4a`, then smaller copies: `lite/` (360p, about a
  fifth of the size) and, for 720p and up, `mid/` (540p). Videos made before
  the copies existed get them in the background when the server starts. Jobs run one at a time; progress is shown in the
  library. Everything lives in `~/.framestudio/videos/<id>/`; the downloaded
  source is deleted once the frames are made.
- The player (`index.html`, `app.js`) draws the JPEGs to a canvas. The audio
  is the clock: at audio time *t* it shows frame `floor((t − audioOffset) × fps)`,
  so picture and sound stay together at any speed, after seeking and after
  stepping. Frames ahead of the playhead are fetched in half-second
  chunks, nearest first, two at a time (up to 10 s ahead), and the next ~1.5 s
  decoded; if the network falls behind, sound and picture pause together
  ("Buffering…") instead of drifting apart.
- A JPEG sequence needs several times the bandwidth of a normal video (720p30
  is roughly 10–15 Mbps). The player measures the connection; the next ~6 s
  are fetched at a quality it surely carries, and the spare bandwidth fetches
  frames further ahead (up to a minute) again at the best quality that can
  arrive in time. Playback stays smooth and gets sharper as the buffer grows,
  or while paused.
- Uploaded files: ffmpeg reads any container and codec it knows (H.264,
  HEVC/10-bit, AV1, VP9, MPEG-2 …; AAC, AC-3, DTS, FLAC, Opus …). The track
  marked default is used for sound (folded to stereo). Subtitles in the file
  are burned into the frames (default track, else Chinese, else the first;
  text ones need ffmpeg with libass, which Homebrew's has); choose "Subtitles:
  Off" to skip. HDR is tone-mapped to normal colours and non-square pixels
  (DVD rips) are made square.
- Controls: play/pause (space), previous/next frame (← →, Shift for 5 s),
  timeline, speed 0.25–2×, volume/mute (M), fullscreen (F).

## Install on the Mac mini

```bash
brew install ffmpeg deno
bash frame-player/server/install-mac.sh
```

It installs yt-dlp into `~/.framestudio/venv`, starts the server on port
8766 at every login and prints the link to open once (`#key=…`, which the
page remembers; every API and media request needs the key). On the home
network use `http://<mac-name>.local:8766/`. From anywhere, with Tailscale:
`tailscale funnel --bg --https=8443 8766` (443 is used by the music reader).

To update: `git pull`, then run `install-mac.sh` again. That also updates
yt-dlp; when YouTube downloads start failing, this is usually the fix.

Tests: `python3 -m unittest discover frame-player/server/tests` (needs ffmpeg;
yt-dlp is replaced by a stand-in).

## API

| | |
|---|---|
| `GET /api/videos` | library, newest first |
| `POST /api/videos` `{"url","fps","height"}` | download + split (fps 0 = original; height 0 = original) |
| `POST /api/upload?name=&fps=&height=` | body = video file |
| `POST /api/videos/<id>/cancel` | stop a job |
| `DELETE /api/videos/<id>` | delete video and frames |
| `GET /media/<id>/chunk?from=&n=[&v=lite|mid]` | many frames in one reply |
| `GET /media/<id>/frames/000001.jpg`, `lite/…`, `mid/…`, `audio.m4a`, `thumb.jpg` | files |

## Older version

`legacy/` is the earlier in-browser viewer (MP4Box.js + WebCodecs, no sound,
no server needed).

Use only while parked or by a passenger.
