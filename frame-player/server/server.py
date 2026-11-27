"""Frame Studio server: turns a video (YouTube link or upload) into JPEG frames
plus one audio file, keeps a library of them, and serves the player.

    python server.py [--port 8766]

GET    /                          the player (frame-player/index.html and its files)
GET    /api/health                {"ok": true, "ffmpeg": ..., "ytdlp": ...}
GET    /api/videos                {"videos": [meta, ...]}   newest first
GET    /api/videos/<id>           meta (status, progress, fps, frames, ...)
POST   /api/videos                JSON {"url", "fps", "height"}: download and process
POST   /api/upload?name=&fps=&height=   body = the video file: process it
POST   /api/videos/<id>/cancel    stop a queued or running job
POST   /api/videos/<id>/position  {"t": seconds}: where playback stopped
DELETE /api/videos/<id>           delete the video and all its frames
GET    /media/<id>/chunk?from=0&n=30  many frames in one response (see send_chunk)
GET    /media/<id>/frames/000001.jpg, /media/<id>/audio.m4a, /media/<id>/thumb.jpg
GET    /api/videos/<id>/zip       all frames + audio as a ZIP download

Every /api and /media request needs the key, in the X-Frame-Key header or as
?k=<key>. The key is made on first start and kept in ~/.framestudio/key; open
the player once as <url>/#key=<key> and it remembers it, or type the 8-digit
PIN from ~/.framestudio/pin on the page (POST /api/login trades it for the key).
"""
import argparse
import json
import os
import re
import secrets
import shutil
import signal
import struct
import subprocess
import sys
import threading
import time
import zipfile
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse, parse_qs, unquote, quote

APP_DIR = Path(__file__).resolve().parent.parent
STATE_DIR = Path(os.environ.get('FRAMESTUDIO_HOME') or (Path.home() / '.framestudio'))
VIDEOS = STATE_DIR / 'videos'
MAX_UPLOAD = 4 * 1024 ** 3
FPS_CHOICES = (0, 12, 15, 24, 25, 30, 48, 50, 60)   # 0 = the video's own rate
HEIGHT_CHOICES = (0, 360, 480, 720, 1080)            # 0 = the video's own size
ID_RE = re.compile(r'^[a-f0-9]{12}$')
FRAME_RE = re.compile(r'^\d{6}\.jpg$')


def tool(name, env):
    """Find ffmpeg / ffprobe / yt-dlp: an override, next to this Python, or on PATH."""
    if os.environ.get(env):
        return os.environ[env]
    here = Path(sys.executable).parent / name
    if here.exists():
        return str(here)
    for d in ('/opt/homebrew/bin', '/usr/local/bin'):
        if (Path(d) / name).exists():
            return str(Path(d) / name)
    return shutil.which(name) or name


FFMPEG = tool('ffmpeg', 'FRAMESTUDIO_FFMPEG')
FFPROBE = tool('ffprobe', 'FRAMESTUDIO_FFPROBE')
YTDLP = tool('yt-dlp', 'FRAMESTUDIO_YTDLP')


def load_key():
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    f = STATE_DIR / 'key'
    if not f.exists():
        f.write_text(secrets.token_urlsafe(18))
        os.chmod(f, 0o600)
    return f.read_text().strip()


def load_pin():
    """A short number for typing on a car screen; trading it for the key is
    rate-limited (see Handler.login)."""
    f = STATE_DIR / 'pin'
    if not f.exists():
        f.write_text('%08d' % secrets.randbelow(10 ** 8))
        os.chmod(f, 0o600)
    return f.read_text().strip()


# ---------------------------------------------------------------- library

META_LOCK = threading.Lock()


def vdir(vid):
    return VIDEOS / vid


def read_meta(vid):
    try:
        return json.loads((vdir(vid) / 'meta.json').read_text())
    except (OSError, ValueError):
        return None


def write_meta(vid, meta):
    with META_LOCK:
        d = vdir(vid)
        if not d.exists():
            return  # deleted meanwhile
        tmp = d / 'meta.json.tmp'
        tmp.write_text(json.dumps(meta, ensure_ascii=False))
        tmp.replace(d / 'meta.json')


def update_meta(vid, **fields):
    meta = read_meta(vid)
    if meta is None:
        return None
    meta.update(fields)
    write_meta(vid, meta)
    return meta


def list_videos():
    out = []
    if VIDEOS.exists():
        for d in VIDEOS.iterdir():
            if ID_RE.match(d.name):
                m = read_meta(d.name)
                if m:
                    out.append(m)
    out.sort(key=lambda m: m.get('created', 0), reverse=True)
    return out


def new_video(**fields):
    vid = secrets.token_hex(6)
    vdir(vid).mkdir(parents=True)
    meta = {
        'id': vid, 'title': '', 'source': '', 'status': 'queued', 'stage': 'Waiting',
        'progress': 0, 'error': '', 'created': time.time(),
        'fps': 0, 'frames': 0, 'width': 0, 'height': 0, 'duration': 0,
        'hasAudio': False, 'audioOffset': 0, 'bytes': 0,
        'requestFps': 0, 'requestHeight': 720,
    }
    meta.update(fields)
    with META_LOCK:
        (vdir(vid) / 'meta.json').write_text(json.dumps(meta, ensure_ascii=False))
    return meta


def dir_size(d):
    return sum(f.stat().st_size for f in Path(d).rglob('*') if f.is_file())


# ---------------------------------------------------------------- processing

class Cancelled(Exception):
    pass


class Jobs:
    """One job at a time (ffmpeg uses every core); the rest wait in order."""

    def __init__(self):
        self.queue = []
        self.cond = threading.Condition()
        self.current = None      # id being processed
        self.proc = None         # its running subprocess
        self.cancelled = set()

    def start(self):
        threading.Thread(target=self.loop, daemon=True).start()

    def add(self, vid):
        with self.cond:
            self.queue.append(vid)
            self.cond.notify()

    def cancel(self, vid):
        with self.cond:
            self.cancelled.add(vid)
            if vid in self.queue:
                self.queue.remove(vid)
            if self.current == vid and self.proc and self.proc.poll() is None:
                self.proc.terminate()

    def loop(self):
        while True:
            with self.cond:
                while not self.queue:
                    self.cond.wait()
                vid = self.queue.pop(0)
                self.current = vid
            try:
                process(vid, self)
            except Cancelled:
                pass
            except Exception as e:  # noqa: BLE001  keep the worker alive
                update_meta(vid, status='error', stage='Failed', error=str(e)[:500])
            finally:
                with self.cond:
                    self.current = None
                    self.proc = None
                    self.cancelled.discard(vid)

    def run(self, vid, cmd, on_line=None, cwd=None):
        """Run a command, feeding its output lines to on_line; raise on failure."""
        if vid in self.cancelled:
            raise Cancelled()
        p = subprocess.Popen(cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                             text=True, errors='replace', bufsize=1)
        self.proc = p
        tail = []
        for line in p.stdout:
            line = line.rstrip()
            tail = (tail + [line])[-15:]
            if on_line:
                on_line(line)
        p.wait()
        self.proc = None
        if vid in self.cancelled:
            raise Cancelled()
        if p.returncode != 0:
            raise RuntimeError('\n'.join(l for l in tail if l)[-500:] or 'exit %d' % p.returncode)


def probe(path):
    out = subprocess.run([FFPROBE, '-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', str(path)],
                         capture_output=True, text=True, timeout=120)
    if out.returncode != 0:
        raise RuntimeError('Cannot read this video file: ' + out.stdout[-200:] + out.stderr[-300:])
    info = json.loads(out.stdout)
    video = next((s for s in info.get('streams', []) if s.get('codec_type') == 'video'
                  and not (s.get('disposition') or {}).get('attached_pic')), None)
    audio = next((s for s in info.get('streams', []) if s.get('codec_type') == 'audio'), None)
    if not video:
        raise RuntimeError('This file has no video picture')

    def rate(s):
        try:
            n, d = (s or '0/1').split('/')
            return float(n) / float(d) if float(d) else 0
        except ValueError:
            return 0
    fps = rate(video.get('avg_frame_rate')) or rate(video.get('r_frame_rate')) or 30
    duration = float(info.get('format', {}).get('duration') or video.get('duration') or 0)

    def start(s):
        try:
            return float(s.get('start_time') or 0)
        except (TypeError, ValueError):
            return 0.0
    return {
        'fps': fps, 'duration': duration,
        'width': int(video.get('width') or 0), 'height': int(video.get('height') or 0),
        'hasAudio': audio is not None,
        'videoStart': start(video), 'audioStart': start(audio) if audio else 0.0,
    }


def download(vid, url, jobs):
    d = vdir(vid)
    meta = read_meta(vid)
    h = meta.get('requestHeight') or 0
    fmt = ('bv*[height<=%d]+ba/b[height<=%d]/bv*+ba/b' % (h, h)) if h else 'bv*+ba/b'
    update_meta(vid, status='downloading', stage='Downloading', progress=0)
    pct = re.compile(r'\[download\]\s+([\d.]+)%')
    last = [0.0]

    def on_line(line):
        m = pct.search(line)
        if m:
            p = float(m.group(1))
            if abs(p - last[0]) >= 1 or p >= 100:
                last[0] = p
                update_meta(vid, progress=round(p, 1))
    cmd = [YTDLP, '--no-playlist', '--newline', '--no-colors', '--no-part', '-f', fmt,
           '--merge-output-format', 'mp4', '--write-info-json', '--ffmpeg-location', FFMPEG,
           '-o', 'source.%(ext)s', url]
    jobs.run(vid, cmd, on_line, cwd=d)
    try:
        info = json.loads((d / 'source.info.json').read_text())
        update_meta(vid, title=info.get('title') or meta.get('title'))
    except (OSError, ValueError):
        pass
    files = [f for f in d.glob('source.*') if f.suffix not in ('.json', '.part', '.ytdl')]
    if not files:
        raise RuntimeError('Download finished but the video file is missing')
    return max(files, key=lambda f: f.stat().st_size)


def extract(vid, src, jobs):
    """Frames at the chosen rate (and size) as JPEGs, audio as AAC in .m4a."""
    d = vdir(vid)
    meta = read_meta(vid)
    info = probe(src)
    fps = meta.get('requestFps') or round(info['fps'], 3)
    fps = max(1.0, min(120.0, float(fps)))
    want_h = meta.get('requestHeight') or 0
    out_h = min(want_h, info['height']) if want_h else info['height']
    out_h -= out_h % 2
    frames_dir = d / 'frames'
    if frames_dir.exists():
        shutil.rmtree(frames_dir)
    frames_dir.mkdir()
    vf = 'fps=%s' % fps
    if out_h and out_h != info['height']:
        vf += ',scale=-2:%d:flags=lanczos' % out_h
    update_meta(vid, status='processing', stage='Splitting frames', progress=0, duration=info['duration'],
                hasAudio=info['hasAudio'])
    cmd = [FFMPEG, '-hide_banner', '-nostdin', '-y', '-i', str(src),
           '-map', '0:v:0', '-vf', vf, '-q:v', '5', '-start_number', '1', str(frames_dir / '%06d.jpg')]
    if info['hasAudio']:
        cmd += ['-map', '0:a:0', '-vn', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', str(d / 'audio.m4a')]
    cmd[3:3] = ['-progress', 'pipe:1', '-nostats']
    total = info['duration'] or 0
    last = [0.0]

    def on_line(line):
        if line.startswith('out_time_us=') and total:
            try:
                p = min(99.0, int(line.split('=')[1]) / 1e6 / total * 100)
            except ValueError:
                return
            if p - last[0] >= 1:
                last[0] = p
                update_meta(vid, progress=round(p, 1))
    jobs.run(vid, cmd, on_line)
    count = len([f for f in frames_dir.iterdir() if FRAME_RE.match(f.name)])
    if not count:
        raise RuntimeError('No frames came out')
    # Thumbnail: a frame from about 10% in.
    shutil.copyfile(frames_dir / ('%06d.jpg' % max(1, count // 10)), d / 'thumb.jpg')
    try:
        first = probe(frames_dir / '000001.jpg')
        w, h = first['width'], first['height']
    except (RuntimeError, OSError, ValueError):
        w, h = 0, out_h
    for f in d.glob('source.*'):
        f.unlink()   # the frames and audio are what we keep
    return {
        'fps': fps, 'frames': count, 'width': w or 0, 'height': h or out_h,
        # Audio time t shows frame floor((t - audioOffset) * fps): the frames
        # start at the first video timestamp, the audio at its own.
        'audioOffset': round(info['videoStart'] - info['audioStart'], 4) if info['hasAudio'] else 0,
        'hasAudio': info['hasAudio'] and (d / 'audio.m4a').exists(),
    }


def process(vid, jobs):
    meta = read_meta(vid)
    if meta is None:
        return
    d = vdir(vid)
    if meta.get('source', '').startswith('http'):
        src = download(vid, meta['source'], jobs)
    else:
        src = next((f for f in d.glob('source.*') if f.suffix != '.json'), None)
        if not src:
            raise RuntimeError('The uploaded video file is missing')
    t0 = time.time()
    result = extract(vid, src, jobs)
    update_meta(vid, status='ready', stage='Done', progress=100, error='',
                seconds=round(time.time() - t0, 1), bytes=dir_size(d), **result)


JOBS = Jobs()


def recover():
    """After a restart, unfinished jobs start again (uploads) or are marked failed."""
    for m in sorted(list_videos(), key=lambda m: m.get('created', 0)):
        if m['status'] == 'uploading':
            update_meta(m['id'], status='error', stage='Failed', error='The server restarted during the upload; please upload again')
        elif m['status'] in ('queued', 'downloading', 'processing'):
            if m.get('source', '').startswith('http') or any(vdir(m['id']).glob('source.*')):
                update_meta(m['id'], status='queued', stage='Waiting', progress=0)
                JOBS.add(m['id'])
            else:
                update_meta(m['id'], status='error', stage='Failed', error='Interrupted by a server restart')


# ---------------------------------------------------------------- HTTP

def clean_choice(value, choices, default):
    try:
        v = int(float(value))
    except (TypeError, ValueError):
        return default
    return v if v in choices else default


def valid_url(url):
    try:
        u = urlparse(url)
    except ValueError:
        return False
    return u.scheme in ('http', 'https') and bool(u.netloc)


class Handler(SimpleHTTPRequestHandler):
    key = ''
    protocol_version = 'HTTP/1.1'

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(APP_DIR), **kw)

    def log_message(self, fmt, *args):
        if '/media/' in str(args[0] if args else ''):
            return   # one line per frame is too much
        sys.stderr.write('%s %s\n' % (time.strftime('%H:%M:%S'), fmt % args))

    def send_json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def parts(self):
        u = urlparse(self.path)
        return u.path, parse_qs(u.query)

    def authorized(self):
        _, q = self.parts()
        given = self.headers.get('X-Frame-Key') or (q.get('k') or [''])[0]
        return bool(self.key) and secrets.compare_digest(given, self.key)

    def end_headers(self):
        if not self.path.startswith(('/api/', '/media/')):
            self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    # --- GET
    def do_GET(self):
        path, q = self.parts()
        if path.startswith('/api/') or path.startswith('/media/'):
            if not self.authorized():
                return self.send_json(401, {'ok': False, 'error': 'key'})
            if path == '/api/health':
                return self.send_json(200, {'ok': True, 'ffmpeg': bool(shutil.which(FFMPEG) or Path(FFMPEG).exists()),
                                            'ytdlp': bool(shutil.which(YTDLP) or Path(YTDLP).exists())})
            if path == '/api/videos':
                return self.send_json(200, {'ok': True, 'videos': list_videos()})
            m = re.match(r'^/api/videos/([a-f0-9]{12})(/zip)?$', path)
            if m:
                meta = read_meta(m.group(1))
                if not meta:
                    return self.send_json(404, {'ok': False, 'error': 'not found'})
                if m.group(2):
                    return self.send_zip(meta)
                return self.send_json(200, dict(meta, ok=True))
            m = re.match(r'^/media/([a-f0-9]{12})/chunk$', path)
            if m:
                return self.send_chunk(m.group(1), q)
            m = re.match(r'^/media/([a-f0-9]{12})/(frames/\d{6}\.jpg|audio\.m4a|thumb\.jpg)$', path)
            if m:
                return self.send_media(vdir(m.group(1)) / m.group(2))
            return self.send_json(404, {'ok': False, 'error': 'not found'})
        if path.startswith('/server/') or '/.' in path:
            return self.send_json(404, {'error': 'not found'})
        return super().do_GET()

    def send_chunk(self, vid, q):
        """Many frames in one response, so a slow or far connection is not
        held up by one round trip per frame. ?from=<first index, 0-based>&n=<count>.
        Body: count (uint32 BE), then each frame's length (uint32 BE), then
        the JPEGs one after another."""
        try:
            first = max(0, int((q.get('from') or ['0'])[0]))
            n = max(1, min(240, int((q.get('n') or ['30'])[0])))
        except ValueError:
            return self.send_json(400, {'ok': False, 'error': 'from/n'})
        d = vdir(vid) / 'frames'
        parts = []
        for i in range(first, first + n):
            try:
                parts.append((d / ('%06d.jpg' % (i + 1))).read_bytes())
            except OSError:
                break
        if not parts:
            return self.send_json(404, {'ok': False, 'error': 'not found'})
        head = struct.pack('>I', len(parts)) + b''.join(struct.pack('>I', len(p)) for p in parts)
        size = len(head) + sum(len(p) for p in parts)
        self.send_response(200)
        self.send_header('Content-Type', 'application/octet-stream')
        self.send_header('Content-Length', str(size))
        self.send_header('Cache-Control', 'private, max-age=31536000, immutable')
        self.end_headers()
        self.wfile.write(head)
        for p in parts:
            self.wfile.write(p)

    def send_media(self, f):
        try:
            size = f.stat().st_size
        except OSError:
            return self.send_json(404, {'ok': False, 'error': 'not found'})
        ctype = 'image/jpeg' if f.suffix == '.jpg' else 'audio/mp4'
        start, end = 0, size - 1
        rng = self.headers.get('Range')
        m = re.match(r'bytes=(\d*)-(\d*)$', rng or '')
        if m and (m.group(1) or m.group(2)):
            if m.group(1):
                start = int(m.group(1))
                if m.group(2):
                    end = min(int(m.group(2)), size - 1)
            else:
                start = max(0, size - int(m.group(2)))
            if start > end:
                self.send_response(416)
                self.send_header('Content-Range', 'bytes */%d' % size)
                self.send_header('Content-Length', '0')
                self.end_headers()
                return
            self.send_response(206)
            self.send_header('Content-Range', 'bytes %d-%d/%d' % (start, end, size))
        else:
            self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Content-Length', str(end - start + 1))
        self.send_header('Cache-Control', 'private, max-age=31536000, immutable')
        self.end_headers()
        with open(f, 'rb') as fh:
            fh.seek(start)
            left = end - start + 1
            while left > 0:
                chunk = fh.read(min(1 << 16, left))
                if not chunk:
                    break
                self.wfile.write(chunk)
                left -= len(chunk)

    def send_zip(self, meta):
        if meta.get('status') != 'ready':
            return self.send_json(409, {'ok': False, 'error': 'Not finished yet'})
        d = vdir(meta['id'])
        name = re.sub(r'[\\/:*?"<>|\s]+', '_', meta.get('title') or meta['id'])[:80] or meta['id']
        self.send_response(200)
        self.send_header('Content-Type', 'application/zip')
        self.send_header('Content-Disposition', "attachment; filename=\"frames.zip\"; filename*=UTF-8''%s.zip"
                         % quote(name))
        self.send_header('Connection', 'close')
        self.close_connection = True
        self.end_headers()

        class Out:  # zipfile only needs write/flush on an unseekable stream
            def __init__(self, w):
                self.w, self.n = w, 0

            def write(self, b):
                self.w.write(b)
                self.n += len(b)
                return len(b)

            def tell(self):
                return self.n

            def flush(self):
                self.w.flush()
        try:
            with zipfile.ZipFile(Out(self.wfile), 'w', zipfile.ZIP_STORED) as z:
                info = {k: meta.get(k) for k in ('title', 'source', 'fps', 'frames', 'width', 'height',
                                                   'duration', 'hasAudio', 'audioOffset')}
                z.writestr('info.json', json.dumps(info, ensure_ascii=False, indent=2))
                if (d / 'audio.m4a').exists():
                    z.write(d / 'audio.m4a', 'audio.m4a')
                for f in sorted((d / 'frames').iterdir()):
                    if FRAME_RE.match(f.name):
                        z.write(f, 'frames/' + f.name)
        except (BrokenPipeError, ConnectionResetError):
            pass

    # --- POST / DELETE
    def read_json(self):
        n = int(self.headers.get('Content-Length') or 0)
        if n <= 0 or n > 65536:
            return {}
        try:
            return json.loads(self.rfile.read(n))
        except ValueError:
            return {}

    pin = ''
    fails = []            # times of wrong PINs, for the lockout
    fail_lock = threading.Lock()

    def login(self):
        """POST /api/login {"pin"} -> {"key"}. After 10 wrong PINs within
        15 minutes every attempt is refused until the window passes."""
        body = self.read_json()
        now = time.time()
        with Handler.fail_lock:
            Handler.fails[:] = [t for t in Handler.fails if now - t < 900]
            if len(Handler.fails) >= 10:
                return self.send_json(429, {'ok': False, 'error': 'Too many wrong PINs; try again in 15 minutes'})
            pin = re.sub(r'\D', '', str(body.get('pin') or ''))
            if self.pin and secrets.compare_digest(pin, self.pin):
                return self.send_json(200, {'ok': True, 'key': self.key})
            Handler.fails.append(now)
        time.sleep(1)
        return self.send_json(403, {'ok': False, 'error': 'pin'})

    def do_POST(self):
        path, q = self.parts()
        if not path.startswith('/api/'):
            return self.send_json(404, {'ok': False, 'error': 'not found'})
        if path == '/api/login':
            return self.login()
        if not self.authorized():
            return self.send_json(401, {'ok': False, 'error': 'key'})
        if path == '/api/videos':
            body = self.read_json()
            url = str(body.get('url') or '').strip()
            if not valid_url(url):
                return self.send_json(400, {'ok': False, 'error': 'Please enter a valid http(s) link'})
            meta = new_video(title=url, source=url,
                             requestFps=clean_choice(body.get('fps'), FPS_CHOICES, 0),
                             requestHeight=clean_choice(body.get('height'), HEIGHT_CHOICES, 720))
            JOBS.add(meta['id'])
            return self.send_json(200, dict(meta, ok=True))
        if path == '/api/upload':
            n = int(self.headers.get('Content-Length') or 0)
            if n <= 0 or n > MAX_UPLOAD:
                return self.send_json(413, {'ok': False, 'error': 'The file is empty or over 4 GB'})
            name = unquote((q.get('name') or ['video'])[0])[:200]
            ext = (Path(name).suffix.lower() or '.mp4')[:6]
            if not re.match(r'^\.[a-z0-9]{1,5}$', ext):
                ext = '.mp4'
            meta = new_video(title=Path(name).stem or 'Uploaded video', source='upload:' + name,
                             requestFps=clean_choice((q.get('fps') or [0])[0], FPS_CHOICES, 0),
                             requestHeight=clean_choice((q.get('height') or [720])[0], HEIGHT_CHOICES, 720),
                             status='uploading', stage='Uploading')
            dest = vdir(meta['id']) / ('source' + ext)
            left = n
            try:
                with open(dest, 'wb') as f:
                    while left > 0:
                        chunk = self.rfile.read(min(1 << 20, left))
                        if not chunk:
                            raise ConnectionError('upload cut off')
                        f.write(chunk)
                        left -= len(chunk)
            except (OSError, ConnectionError):
                shutil.rmtree(vdir(meta['id']), ignore_errors=True)
                self.close_connection = True
                return
            meta = update_meta(meta['id'], status='queued', stage='Waiting')
            JOBS.add(meta['id'])
            return self.send_json(200, dict(meta, ok=True))
        m = re.match(r'^/api/videos/([a-f0-9]{12})/position$', path)
        if m:
            # Where playback stopped, so any device can continue from there.
            try:
                t = max(0.0, float(self.read_json().get('t') or 0))
            except (TypeError, ValueError):
                return self.send_json(400, {'ok': False, 'error': 't'})
            meta = update_meta(m.group(1), position=round(t, 2), watchedAt=time.time())
            if not meta:
                return self.send_json(404, {'ok': False, 'error': 'not found'})
            return self.send_json(200, {'ok': True})
        m = re.match(r'^/api/videos/([a-f0-9]{12})/cancel$', path)
        if m:
            vid = m.group(1)
            meta = read_meta(vid)
            if not meta:
                return self.send_json(404, {'ok': False, 'error': 'not found'})
            if meta['status'] in ('queued', 'downloading', 'processing'):
                JOBS.cancel(vid)
                meta = update_meta(vid, status='error', stage='Cancelled', error='Cancelled')
            return self.send_json(200, dict(meta, ok=True))
        return self.send_json(404, {'ok': False, 'error': 'not found'})

    def do_DELETE(self):
        path, _ = self.parts()
        if not self.authorized():
            return self.send_json(401, {'ok': False, 'error': 'key'})
        m = re.match(r'^/api/videos/([a-f0-9]{12})$', path)
        if not m or not vdir(m.group(1)).exists():
            return self.send_json(404, {'ok': False, 'error': 'not found'})
        vid = m.group(1)
        JOBS.cancel(vid)
        for _ in range(50):   # let a running ffmpeg let go of the folder
            if JOBS.current != vid:
                break
            time.sleep(0.1)
        with META_LOCK:
            shutil.rmtree(vdir(vid), ignore_errors=True)
        return self.send_json(200, {'ok': True})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=8766)
    ap.add_argument('--host', default='0.0.0.0')
    args = ap.parse_args()
    Handler.key = load_key()
    Handler.pin = load_pin()
    VIDEOS.mkdir(parents=True, exist_ok=True)
    JOBS.start()
    recover()
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    print('Frame Studio server on port %d (ffmpeg: %s, yt-dlp: %s)' % (args.port, FFMPEG, YTDLP), flush=True)
    print('Videos in %s' % VIDEOS, flush=True)
    print('Open once with:  http://localhost:%d/#key=%s' % (args.port, Handler.key), flush=True)
    print('Or type this PIN on the page:  %s' % Handler.pin, flush=True)
    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()


if __name__ == '__main__':
    main()
