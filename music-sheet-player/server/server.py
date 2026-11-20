"""ScoreLens recognition server: serves the app and reads scores with homr.

    python server.py [--port 8765]

GET  /                  the app (index.html and its files)
GET  /api/health        {"ok": true, "engine": "homr"}  (needs the key)
POST /api/recognize     body = the image (PNG/JPEG); returns the result JSON

The key is made on first start and kept in ~/.scorelens/key. The app sends
it in the X-ScoreLens-Key header; open the app once as  <url>/#key=<key>
and it remembers it.
"""
import argparse
import json
import os
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import musicxml_events  # noqa: E402

APP_DIR = Path(__file__).resolve().parent.parent
STATE_DIR = Path.home() / '.scorelens'
MAX_BYTES = 25 * 1024 * 1024
HOMR = shutil.which('homr') or str(Path(sys.executable).parent / 'homr')
LOCK = threading.Lock()  # one page at a time: homr uses every core


def load_key():
    STATE_DIR.mkdir(exist_ok=True)
    f = STATE_DIR / 'key'
    if not f.exists():
        f.write_text(secrets.token_urlsafe(18))
        os.chmod(f, 0o600)
    return f.read_text().strip()


class Homr:
    """homr kept loaded in this process (models load once, not per page);
    the command line is the fallback if its internals ever change."""

    def __init__(self):
        self.run = None
        try:
            import onnxruntime as ort
            from homr.main import ProcessingConfig, download_weights, process_image
            from homr.music_xml_generator import XmlGeneratorArguments
            ort.set_default_logger_severity(3)
            download_weights(False, False, False)
            # No title OCR: the app does not use it and it costs time.
            cfg = ProcessingConfig(False, False, False, False, -1, False, False, False, False)
            self.run = lambda path: process_image(path, cfg, XmlGeneratorArguments(False, None, None))
            print('homr loaded in-process', flush=True)
        except Exception as e:  # noqa: BLE001
            print('homr in-process unavailable (%s); using the command line' % e, flush=True)

    def __call__(self, img):
        if self.run:
            self.run(str(img))
        else:
            subprocess.run([HOMR, '--no-title', str(img)], cwd=img.parent, capture_output=True, text=True, timeout=300)
        return img.with_suffix('.musicxml')


HOMR_RUN = None


def recognize(data, suffix):
    global HOMR_RUN
    with tempfile.TemporaryDirectory(prefix='scorelens-') as tmp:
        img = Path(tmp) / ('page' + suffix)
        img.write_bytes(data)
        t0 = time.time()
        with LOCK:
            if HOMR_RUN is None:
                HOMR_RUN = Homr()
            try:
                xml = HOMR_RUN(img)
            except Exception as e:  # noqa: BLE001
                raise RuntimeError('homr could not read the page: %s' % e)
        if not xml.exists():
            raise RuntimeError('homr found no music on the page')
        result = musicxml_events.to_result(xml.read_text(encoding='utf-8'))
        result['seconds'] = round(time.time() - t0, 1)
        return result


class Handler(SimpleHTTPRequestHandler):
    key = ''

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(APP_DIR), **kw)

    def log_message(self, fmt, *args):
        sys.stderr.write('%s %s\n' % (time.strftime('%H:%M:%S'), fmt % args))

    def send_json(self, code, obj):
        body = json.dumps(obj).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def authorized(self):
        return secrets.compare_digest(self.headers.get('X-ScoreLens-Key', ''), self.key)

    def end_headers(self):
        # Always serve the newest app files.
        if not self.path.startswith('/api/'):
            self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def do_GET(self):
        if self.path.startswith('/api/health'):
            if not self.authorized():
                return self.send_json(401, {'ok': False, 'error': 'key'})
            return self.send_json(200, {'ok': True, 'engine': 'homr'})
        if self.path.startswith('/server/') or '/.' in self.path:
            return self.send_json(404, {'error': 'not found'})
        return super().do_GET()

    def do_POST(self):
        if not self.path.startswith('/api/recognize'):
            return self.send_json(404, {'error': 'not found'})
        if not self.authorized():
            return self.send_json(401, {'ok': False, 'error': 'key'})
        n = int(self.headers.get('Content-Length') or 0)
        if n <= 0 or n > MAX_BYTES:
            return self.send_json(413, {'ok': False, 'error': 'image too large or empty'})
        data = self.rfile.read(n)
        ctype = self.headers.get('Content-Type', '')
        suffix = '.png' if 'png' in ctype else '.jpg'
        try:
            result = recognize(data, suffix)
        except Exception as e:  # report, keep serving
            return self.send_json(500, {'ok': False, 'error': str(e)[:300]})
        result['ok'] = True
        return self.send_json(200, result)


def warm_up():
    global HOMR_RUN
    with LOCK:
        if HOMR_RUN is None:
            HOMR_RUN = Homr()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=8765)
    ap.add_argument('--host', default='0.0.0.0')
    args = ap.parse_args()
    Handler.key = load_key()
    # Load the models now, so the first page is not slow.
    threading.Thread(target=warm_up, daemon=True).start()
    print('ScoreLens server on port %d (homr: %s)' % (args.port, HOMR), flush=True)
    print('Open once with:  http://localhost:%d/#key=%s' % (args.port, Handler.key), flush=True)
    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()


if __name__ == '__main__':
    main()
