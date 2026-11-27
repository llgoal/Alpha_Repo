"""End-to-end tests of the Frame Studio server with ffmpeg and a stand-in yt-dlp.

    python3 -m unittest discover frame-player/server/tests
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request
from pathlib import Path

SERVER = Path(__file__).resolve().parent.parent / 'server.py'


def free_port():
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    return port


@unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'needs ffmpeg')
class ServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix='framestudio-test-'))
        cls.video = cls.tmp / 'clip.mp4'
        subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=854x480:rate=30:duration=2',
                        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
                        '-c:a', 'aac', '-shortest', str(cls.video)], check=True)
        fake = cls.tmp / 'fake-ytdlp'
        fake.write_text('#!/bin/sh\n'
                        'case "$*" in *fail*) echo "ERROR: Video unavailable"; exit 1;; esac\n'
                        'echo "[download]  40.0%% of 1MiB"\n'
                        'cp "%s" source.mp4\n'
                        'echo \'{"title": "Fake title"}\' > source.info.json\n' % cls.video)
        fake.chmod(0o755)
        cls.port = free_port()
        env = dict(os.environ, FRAMESTUDIO_HOME=str(cls.tmp / 'home'), FRAMESTUDIO_YTDLP=str(fake))
        cls.proc = subprocess.Popen([sys.executable, str(SERVER), '--port', str(cls.port), '--host', '127.0.0.1'],
                                    env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(50):
            try:
                urllib.request.urlopen('http://127.0.0.1:%d/' % cls.port)
                break
            except OSError:
                time.sleep(0.1)
        cls.key = (cls.tmp / 'home' / 'key').read_text().strip()

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        cls.proc.wait()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def req(self, path, data=None, method=None, key=True, raw=False):
        headers = {'X-Frame-Key': self.key} if key else {}
        if isinstance(data, dict):
            data = json.dumps(data).encode()
            headers['Content-Type'] = 'application/json'
        r = urllib.request.Request('http://127.0.0.1:%d%s' % (self.port, path), data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(r) as res:
                body = res.read()
                return res.status, (body if raw else json.loads(body))
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b'{}')

    def wait(self, vid):
        for _ in range(200):
            _, m = self.req('/api/videos/' + vid)
            if m['status'] in ('ready', 'error'):
                return m
            time.sleep(0.1)
        self.fail('job did not finish')

    def test_needs_key(self):
        self.assertEqual(self.req('/api/videos', key=False)[0], 401)

    def test_link_is_downloaded_and_split(self):
        code, m = self.req('/api/videos', {'url': 'https://youtu.be/abc', 'fps': 24, 'height': 360})
        self.assertEqual(code, 200)
        m = self.wait(m['id'])
        self.assertEqual(m['status'], 'ready', m.get('error'))
        self.assertEqual(m['title'], 'Fake title')
        self.assertEqual(m['fps'], 24)
        self.assertEqual(m['frames'], 48)
        self.assertEqual((m['width'], m['height']), (640, 360))
        self.assertTrue(m['hasAudio'])
        code, jpg = self.req('/media/%s/frames/000048.jpg' % m['id'], raw=True)
        self.assertEqual(jpg[:2], b'\xff\xd8')
        code, _ = self.req('/media/%s/audio.m4a?k=%s' % (m['id'], self.key), key=False, raw=True)
        self.assertEqual(code, 200)
        code, chunk = self.req('/media/%s/chunk?from=40&n=30' % m['id'], raw=True)
        import struct
        k = struct.unpack('>I', chunk[:4])[0]
        self.assertEqual(k, 8)   # frames 41..48, the last ones
        first = struct.unpack('>I', chunk[4:8])[0]
        self.assertEqual(chunk[4 + 4 * k:4 + 4 * k + 2], b'\xff\xd8')
        self.assertEqual(len(chunk), 4 + 4 * k + sum(struct.unpack('>%dI' % k, chunk[4:4 + 4 * k])))
        self.assertGreater(first, 0)
        self.assertEqual(set(m['copies']), {'lite'})   # 360p: no mid copy
        code, chunk = self.req('/media/%s/chunk?from=0&n=4&v=lite' % m['id'], raw=True)
        self.assertEqual(struct.unpack('>I', chunk[:4])[0], 4)
        code, jpg = self.req('/media/%s/lite/000001.jpg' % m['id'], raw=True)
        self.assertEqual(jpg[:2], b'\xff\xd8')
        self.assertEqual(self.req('/api/videos/%s/zip' % m['id'])[0], 404)
        self.assertEqual(self.req('/api/videos/%s/position' % m['id'], {'t': 1.25})[0], 200)
        self.assertEqual(self.req('/api/videos/' + m['id'])[1]['position'], 1.25)
        self.assertEqual(self.req('/api/videos/' + m['id'], method='DELETE')[0], 200)
        self.assertEqual(self.req('/api/videos/' + m['id'])[0], 404)

    def test_upload_keeps_own_rate(self):
        code, m = self.req('/api/upload?name=clip.mp4', self.video.read_bytes())
        self.assertEqual(code, 200)
        m = self.wait(m['id'])
        self.assertEqual(m['status'], 'ready', m.get('error'))
        self.assertEqual((m['fps'], m['frames'], m['width'], m['height']), (30, 60, 854, 480))
        self.assertEqual(set(m['copies']), {'lite'})
        code, chunk = self.req('/media/%s/chunk?from=0&n=2&v=mid' % m['id'], raw=True)
        self.assertEqual(code, 404)
        _, lib = self.req('/api/videos')
        self.assertIn(m['id'], [v['id'] for v in lib['videos']])

    def test_failed_download_reports_error(self):
        _, m = self.req('/api/videos', {'url': 'https://youtu.be/fail'})
        m = self.wait(m['id'])
        self.assertEqual(m['status'], 'error')
        self.assertIn('Video unavailable', m['error'])

    def test_pin_gives_key(self):
        pin = (self.tmp / 'home' / 'pin').read_text().strip()
        self.assertRegex(pin, r'^\d{8}$')
        code, body = self.req('/api/login', {'pin': pin}, key=False)
        self.assertEqual((code, body.get('key')), (200, self.key))
        self.assertEqual(self.req('/api/login', {'pin': '00000000' if pin != '00000000' else '1'}, key=False)[0], 403)

    def test_bad_link_rejected(self):
        self.assertEqual(self.req('/api/videos', {'url': 'notaurl'})[0], 400)


if __name__ == '__main__':
    unittest.main()
