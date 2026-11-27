(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const KEY_STORE = 'framestudio.key';
  const svg = d => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
  const ICONS = {
    play: svg('<path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/>'),
    pause: svg('<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>'),
    prev: svg('<rect x="5" y="5" width="2.5" height="14" rx="1"/><path d="M19 6.2v11.6a.9.9 0 0 1-1.4.75L9.3 12.75a.9.9 0 0 1 0-1.5l8.3-5.8a.9.9 0 0 1 1.4.75z"/>'),
    next: svg('<rect x="16.5" y="5" width="2.5" height="14" rx="1"/><path d="M5 6.2v11.6a.9.9 0 0 0 1.4.75l8.3-5.8a.9.9 0 0 0 0-1.5L6.4 5.45A.9.9 0 0 0 5 6.2z"/>'),
    sound: svg('<path d="M4 9.5v5a1 1 0 0 0 1 1h3l4.3 3.6a.8.8 0 0 0 1.3-.6V5.5a.8.8 0 0 0-1.3-.6L8 8.5H5a1 1 0 0 0-1 1z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'),
    muted: svg('<path d="M4 9.5v5a1 1 0 0 0 1 1h3l4.3 3.6a.8.8 0 0 0 1.3-.6V5.5a.8.8 0 0 0-1.3-.6L8 8.5H5a1 1 0 0 0-1 1z"/><path d="M17 9.5l5 5m0-5l-5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'),
    fs: svg('<path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>'),
    fsExit: svg('<path d="M9 4v4a1 1 0 0 1-1 1H4M20 9h-4a1 1 0 0 1-1-1V4M15 20v-4a1 1 0 0 1 1-1h4M4 15h4a1 1 0 0 1 1 1v4" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>'),
  };

  // ------------------------------------------------------------ key + API
  // Some browsers (car browsers, private mode) block localStorage, so the key
  // is also kept in a cookie, and in the address when neither works.
  function saveKey(k) {
    try { localStorage.setItem(KEY_STORE, k); } catch {}
    try { document.cookie = `fskey=${encodeURIComponent(k)}; max-age=315360000; path=/; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`; } catch {}
    return storedKey() === k;
  }
  function storedKey() {
    try { const k = localStorage.getItem(KEY_STORE); if (k) return k; } catch {}
    try { const m = document.cookie.match(/(?:^|;\s*)fskey=([^;]+)/); if (m) return decodeURIComponent(m[1]); } catch {}
    return '';
  }
  function cleanKey(raw) {
    raw = String(raw || '').trim();
    const m = raw.match(/key=([^&\s]+)/);   // a whole pasted link works too
    return decodeURIComponent(m ? m[1] : raw);
  }
  function readKey() {
    const m = location.hash.match(/key=([^&]+)/);
    if (m) {
      const k = decodeURIComponent(m[1]);
      if (saveKey(k)) history.replaceState(null, '', location.pathname + location.search);
      return k;
    }
    return storedKey();
  }
  let key = readKey();

  async function api(path, opts = {}) {
    const res = await fetch(path, { ...opts, headers: { 'X-Frame-Key': key, ...(opts.headers || {}) } });
    let body = {};
    try { body = await res.json(); } catch {}
    if (res.status === 401) { showKeyCard(); throw new Error('key'); }
    if (!res.ok || body.ok === false) throw new Error(body.error || `HTTP ${res.status}`);
    return body;
  }
  const media = (id, file) => `/media/${id}/${file}?k=${encodeURIComponent(key)}`;
  const frameName = i => String(i + 1).padStart(6, '0') + '.jpg';

  let keyTried = false;
  function showKeyCard() {
    $('keyCard').hidden = false;
    setServer('bad', keyTried ? 'Wrong key' : 'Key needed');
    if (keyTried) keyHint('That key did not work. Try the 8-digit PIN.');
  }
  $('keyForm').addEventListener('submit', async e => {
    e.preventDefault();
    const raw = $('keyInput').value.trim();
    const digits = raw.replace(/[\s-]/g, '');
    $('keyHint').hidden = true;
    if (/^\d{4,12}$/.test(digits)) {
      // The short PIN: the Mac mini trades it for the real key.
      try {
        const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: digits }) });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) { keyHint(res.status === 429 ? body.error : 'Wrong PIN. Check the 8 digits on the Mac mini.'); return; }
        key = body.key;
      } catch { keyHint('Cannot reach the Mac mini.'); return; }
    } else key = cleanKey(raw);
    if (!saveKey(key)) history.replaceState(null, '', location.pathname + location.search + '#key=' + encodeURIComponent(key));
    keyTried = true;
    $('keyInput').value = '';
    $('keyCard').hidden = true;
    refresh();
  });
  function keyHint(text) { $('keyHint').textContent = text; $('keyHint').hidden = false; }

  function setServer(kind, text) {
    $('serverStatus').className = 'server ' + kind;
    $('serverText').textContent = text;
  }

  // ------------------------------------------------------------ helpers
  function fmtTime(s, precise = true) {
    if (!isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60), sec = s - m * 60;
    const h = Math.floor(m / 60);
    const ss = precise ? sec.toFixed(2).padStart(5, '0') : String(Math.floor(sec)).padStart(2, '0');
    return h ? `${h}:${String(m % 60).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  }
  function fmtBytes(n) {
    if (!n) return '';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
  }
  const fmtFps = f => (Math.round(f * 100) / 100) + ' fps';
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function note(text, isError = false) {
    const el = $('newNote');
    el.hidden = !text;
    el.textContent = text || '';
    el.classList.toggle('error', isError);
  }

  // ------------------------------------------------------------ sound
  // Some browsers (the Tesla one among them) refuse to start an <audio>
  // element. Web Audio is a separate path: the whole track is decoded into
  // memory and played from there. It offers the same few things the player
  // uses from an <audio> element, so the two can be swapped.
  let sharedCtx = null;
  function audioCtx() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!sharedCtx && AC) { try { sharedCtx = new AC(); } catch {} }
    if (sharedCtx && sharedCtx.state === 'suspended') sharedCtx.resume().catch(() => {});
    return sharedCtx;
  }
  class WebAudioOut {
    constructor(onended) {
      this.onended = onended;
      this.url = ''; this.data = null; this.buf = null;
      this.node = null; this.want = false;
      this._t = 0; this._rate = 1; this._muted = false; this.startAt = 0;
      this.ctx = audioCtx();
      if (this.ctx) { this.gain = this.ctx.createGain(); this.gain.connect(this.ctx.destination); }
    }
    setSource(url) {
      this.stopNode(); this.want = false; this.buf = null; this._t = 0; this.url = url || '';
      this.data = url ? fetch(url).then(r => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); }) : null;
    }
    async decoded() {
      if (this.buf) return this.buf;
      const url = this.url, data = await this.data;
      const buf = await new Promise((res, rej) => this.ctx.decodeAudioData(data.slice(0), res, rej));
      if (url === this.url) this.buf = buf;
      return buf;
    }
    async play() {
      if (!this.ctx || !this.data) throw new Error('no web audio');
      this.want = true;
      await this.ctx.resume();
      if (this.ctx.state !== 'running') throw new Error('blocked');
      await this.decoded();
      if (this.want && !this.node) this.startNode();
    }
    pause() { this.want = false; if (this.node) { this._t = this.currentTime; this.stopNode(); } }
    startNode() {
      const n = this.ctx.createBufferSource();
      n.buffer = this.buf; n.playbackRate.value = this._rate; n.connect(this.gain);
      n.onended = () => { if (this.node === n) { this.node = null; this._t = this.buf.duration; if (this.onended) this.onended(); } };
      this.startAt = this.ctx.currentTime;
      n.start(0, Math.max(0, Math.min(this._t, this.buf.duration)));
      this.node = n;
    }
    stopNode() { const n = this.node; this.node = null; if (n) { try { n.stop(); } catch {} n.disconnect(); } }
    get currentTime() {
      if (!this.node) return this._t;
      return Math.min(this.buf.duration, this._t + (this.ctx.currentTime - this.startAt) * this._rate);
    }
    set currentTime(t) {
      if (this.node) { this.stopNode(); this._t = t; this.startNode(); } else this._t = t;
    }
    get playbackRate() { return this._rate; }
    set playbackRate(r) {
      if (this.node) { this._t = this.currentTime; this.startAt = this.ctx.currentTime; this.node.playbackRate.value = r; }
      this._rate = r;
    }
    get muted() { return this._muted; }
    set muted(m) { this._muted = m; if (this.gain) this.gain.gain.value = m ? 0 : 1; }
  }

  // ------------------------------------------------------------ frame player
  // Frames are JPEGs on the server. The audio element is the clock: at audio
  // time t the stage shows frame floor((t - audioOffset) * fps). Without
  // audio a wall clock stands in. Frames ahead of the playhead are fetched
  // as compressed blobs (cheap) and the nearest ones decoded to bitmaps.
  class Player {
    constructor() {
      this.canvas = $('canvas');
      this.ctx = this.canvas.getContext('2d', { alpha: false });
      this.audio = new Audio();
      this.audio.preload = 'auto';
      this.audio.preservesPitch = true;
      this.meta = null;
      this.cache = new Map();         // index -> {blob, bitmap, loading, decoding}
      this.inflight = 0;
      this.playing = false;
      this.stalled = false;
      this.drawn = -1;
      this.wall = { base: 0, at: 0 }; // clock when there is no audio
      this.smooth = { t: 0, at: 0 };  // smooths coarse audio.currentTime
      this.gen = 0;
      this.dropped = 0;
      this.audio.addEventListener('ended', () => this.finish());
      this.loop = this.loop.bind(this);
      requestAnimationFrame(this.loop);
    }

    get fps() { return this.meta ? this.meta.fps : 30; }
    get count() { return this.meta ? this.meta.frames : 0; }
    get duration() { return this.count / this.fps; }
    // Last moment of the clock: the frames start audioOffset into the audio.
    get end() { return this.duration + (this.hasAudio ? Math.max(0, this.meta.audioOffset || 0) : 0); }
    get rate() { return Number($('rateSelect').value) || 1; }
    get hasAudio() { return !!(this.meta && this.meta.hasAudio && !this.silent); }
    setAudioSource(url) {
      if (this.audio instanceof WebAudioOut) return this.audio.setSource(url);
      if (url) { this.audio.src = url; this.audio.load(); }
      else { this.audio.removeAttribute('src'); this.audio.load(); }
    }
    // The <audio> element was refused: try Web Audio, and if that is refused
    // too, keep the picture going without sound.
    audioFailed() {
      if (!this.playing) return;
      const t = this.now();
      if (!(this.audio instanceof WebAudioOut)) {
        this.audio.pause();
        this.audio = new WebAudioOut(() => this.finish());
        this.audio.muted = userMuted;
        this.audio.playbackRate = this.rate;
        this.audio.setSource(media(this.meta.id, 'audio.m4a'));
        this.audio.currentTime = t;
        this.smooth = { t, at: performance.now() };
        this.audio.play().catch(() => this.audioFailed());
        return;
      }
      this.audio.pause();
      this.silent = true;
      this.wall = { base: t, at: performance.now() };
      note('This browser does not allow sound here; playing without sound.', true);
    }

    open(meta) {
      this.close();
      this.meta = meta;
      this.silent = false;
      this.gen++;
      this.canvas.width = meta.width || 1280;
      this.canvas.height = meta.height || 720;
      $('stage').style.aspectRatio = `${this.canvas.width} / ${this.canvas.height}`;
      if (this.hasAudio) {
        this.setAudioSource(media(meta.id, 'audio.m4a'));
        this.audio.playbackRate = this.rate;
      }
      const px = this.canvas.width * this.canvas.height * 4;
      // Decoded bitmaps are big: at most about 120 MB of them (1.5 s at most).
      this.bmpAhead = Math.max(2, Math.min(Math.ceil(this.fps * 1.5), Math.floor(120e6 / px)));
      // Frames come in half-second chunks, nearest first, two requests at a
      // time. The next few seconds are fetched at a quality the connection
      // can surely carry; with the bandwidth left over, frames further ahead
      // are fetched (or fetched again) at the best quality that can arrive
      // in time. So playback stays smooth and the picture gets sharper as
      // the buffer grows, or while paused.
      this.chunk = Math.max(4, Math.round(this.fps / 2));
      this.chunkLoading = new Set();
      this.useChunks = true;
      const dur = Math.max(0.1, meta.duration || this.duration);
      const copies = meta.copies || (meta.lite ? { lite: meta.liteBytes || 0 } : {});
      // Qualities, worst first: the smaller copies, then the full frames.
      this.tiers = ['lite', 'mid'].filter(n => n in copies).map(n => ({ v: n, bps: copies[n] / dur }))
        .concat([{ v: null, bps: (meta.frameBytes || meta.bytes || 0) / dur }]);
      this.top = this.tiers.length - 1;
      this.base = 0;
      this.safe = Math.ceil(this.fps * 6);
      // Up to a minute ahead, or about 80 MB of full frames.
      const perFrame = this.tiers[this.top].bps / this.fps || 1;
      this.blobAhead = Math.max(this.safe, Math.min(Math.ceil(this.fps * 60), Math.floor(80e6 / perFrame)));
      this.net = { bytes: 0, busy: 0, since: 0 };
      this.asked = new Set();
      this.wall = { base: 0, at: performance.now() };
      this.drawn = -1;
      this.dropped = 0;
      $('timeline').max = String(Math.max(0, this.count - 1));
      $('durTime').textContent = fmtTime(this.duration);
      $('nowTitle').textContent = meta.title || '';
      const mbps = meta.bytes && meta.duration ? meta.bytes * 8 / meta.duration / 1e6 : 0;
      $('nowInfo').textContent = `${fmtFps(meta.fps)} · ${meta.frames} frames · ${meta.width}×${meta.height}` + (meta.hasAudio ? ' · sound' : ' · no sound')
        + (mbps ? ` · needs about ${mbps.toFixed(mbps < 10 ? 1 : 0)} Mbps` : '');
      $('playerCard').hidden = false;
      // Continue where it was left, on this or another device.
      const pos = Number(meta.position) || 0;
      const resumeAt = pos > 3 && pos < this.duration - 3 ? pos : 0;
      this.saved = { t: resumeAt, at: performance.now() };
      this.seekFrame(Math.round(resumeAt * this.fps));
      $('resumeInfo').hidden = !resumeAt;
      if (resumeAt) $('resumeText').textContent = `Continuing from ${fmtTime(resumeAt, false)}`;
    }

    close() {
      this.pause();
      if (this.meta && this.saved) savePosition(this.meta.id, this.frameAt(this.now()) / this.fps);
      this.gen++;
      for (const e of this.cache.values()) if (e.bitmap) e.bitmap.close();
      this.cache.clear();
      this.inflight = 0;
      this.setAudioSource('');
      this.meta = null;
    }

    // --- clock
    now() {
      if (!this.meta) return 0;
      if (this.hasAudio) {
        const t = this.audio.currentTime, p = performance.now();
        if (!this.playing || this.stalled) { this.smooth = { t, at: p }; return t; }
        // currentTime updates in coarse steps in some browsers: run forward
        // from the last value and resync whenever it drifts.
        const est = this.smooth.t + (p - this.smooth.at) / 1000 * this.rate;
        if (Math.abs(est - t) > 0.08) { this.smooth = { t, at: p }; return t; }
        return Math.max(est, t - 0.04);
      }
      if (!this.playing || this.stalled) return this.wall.base;
      return this.wall.base + (performance.now() - this.wall.at) / 1000 * this.rate;
    }
    setTime(t) {
      t = Math.max(0, Math.min(this.end, t));
      if (this.hasAudio) { try { this.audio.currentTime = t; } catch {} this.smooth = { t, at: performance.now() }; }
      this.wall = { base: t, at: performance.now() };
    }
    frameAt(t) {
      const off = this.hasAudio ? (this.meta.audioOffset || 0) : 0;
      return Math.max(0, Math.min(this.count - 1, Math.floor((t - off) * this.fps + 1e-6)));
    }
    timeOf(i) { return (i + 0.5) / this.fps + (this.hasAudio ? (this.meta.audioOffset || 0) : 0); }

    // --- loading
    entry(i) {
      let e = this.cache.get(i);
      if (!e) { e = {}; this.cache.set(i, e); }
      return e;
    }
    // --- connection speed: bytes received over the time any request was open
    netStart() {
      if (this.inflight++ === 0) this.net.since = performance.now();
    }
    netEnd(bytes) {
      this.net.bytes += bytes;
      if (--this.inflight === 0) this.net.busy += performance.now() - this.net.since;
      // Weigh the last ~10 s of transfer, not the whole session.
      if (this.net.busy > 10000) { this.net.busy /= 2; this.net.bytes /= 2; }
    }
    speed() {
      const busy = this.net.busy + (this.inflight ? performance.now() - this.net.since : 0);
      // Bytes per second; unknown until enough has come in.
      return busy > 300 || this.net.bytes > 3e5 ? this.net.bytes / Math.max(busy, 1) * 1000 : 0;
    }
    // The quality for the next few seconds: the best one the connection
    // carries with room to spare (the worst one until it is measured).
    pickBase() {
      const sp = this.speed(), r = this.rate;
      if (!sp) return;
      let b = 0;
      for (let t = 1; t <= this.top; t++) {
        const margin = t <= this.base ? 1.1 : 1.3;   // slower to drop than to rise
        if (this.tiers[t].bps * r * margin < sp) b = t;
      }
      this.base = b;
    }
    fetchBlob(i) {
      const e = this.entry(i), gen = this.gen, q = this.base, v = this.tiers[q].v;
      if (e.blob || e.loading) return;
      e.loading = true;
      this.netStart();
      let got = 0;
      fetch(media(this.meta.id, (v || 'frames') + '/' + frameName(i)))
        .then(r => { if (!r.ok) throw new Error(r.status); return r.blob(); })
        .then(b => { got = b.size; if (gen === this.gen) { e.blob = b; e.q = q; } })
        .catch(() => {})
        .finally(() => { if (gen === this.gen) { e.loading = false; this.netEnd(got); } });
    }
    decode(i) {
      const e = this.entry(i), gen = this.gen;
      if (!e.blob || e.bitmap || e.decoding) return;
      e.decoding = true;
      const blob = e.blob;
      createImageBitmap(blob)
        .then(bm => { if (gen === this.gen && this.cache.get(i) === e && e.blob === blob) e.bitmap = bm; else bm.close(); })
        .catch(() => {})
        .finally(() => { e.decoding = false; });
    }
    fetchChunk(c, q) {
      const gen = this.gen, from = c * this.chunk, n = Math.min(this.chunk, this.count - from), v = this.tiers[q].v;
      this.chunkLoading.add(c);
      this.netStart();
      let got = 0;
      const url = media(this.meta.id, 'chunk') + `&from=${from}&n=${n}` + (v ? '&v=' + v : '');
      // Asked before: the browser's cache may answer, which says nothing
      // about the network, so it is left out of the speed estimate.
      const again = this.asked.has(url);
      this.asked.add(url);
      fetch(url)
        .then(r => { if (r.status === 404 && !v) this.useChunks = false; if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); })
        .then(buf => {
          if (!again) got = buf.byteLength;
          if (gen !== this.gen) return;
          const dv = new DataView(buf), k = dv.getUint32(0);
          let off = 4 + 4 * k;
          for (let j = 0; j < k; j++) {
            const len = dv.getUint32(4 + 4 * j), i = from + j;
            const e = this.entry(i);
            // A better frame replaces a worse one, unless that one is
            // decoded and about to be shown.
            if (!e.blob || (e.q < q && (!e.bitmap || i > this.cur + this.bmpAhead))) {
              if (e.bitmap) { e.bitmap.close(); e.bitmap = null; }
              e.blob = new Blob([new Uint8Array(buf, off, len)], { type: 'image/jpeg' });
              e.q = q;
            }
            off += len;
          }
        })
        .catch(() => {})
        .finally(() => { if (gen === this.gen) { this.chunkLoading.delete(c); this.netEnd(got); } });
    }
    // Worst quality held for chunk c from frame cur on (-1: some missing).
    chunkQ(c, cur) {
      const from = c * this.chunk, to = Math.min(this.count, from + this.chunk);
      let q = Infinity;
      for (let i = Math.max(from, cur); i < to; i++) {
        const e = this.cache.get(i);
        q = Math.min(q, e && e.blob ? e.q : -1);
        if (q < 0) break;
      }
      return q;
    }
    schedule(cur) {
      this.cur = cur;
      this.pickBase();
      const last = Math.min(this.count - 1, cur + this.blobAhead);
      if (this.useChunks) {
        const first = Math.floor(cur / this.chunk), lastC = Math.floor(last / this.chunk);
        const safeC = Math.floor(Math.min(this.count - 1, cur + this.safe) / this.chunk);
        // 1. The next few seconds, at the base quality, nearest first.
        let needSafe = false;
        for (let c = first; c <= safeC && this.inflight < 2; c++) {
          if (this.chunkLoading.has(c) || this.chunkQ(c, cur) >= 0) continue;
          needSafe = true;
          this.fetchChunk(c, this.base);
        }
        // 2. With what is left, better frames further ahead: for each chunk,
        // nearest first, the best quality that arrives well before it plays.
        const sp = this.speed();
        if (!needSafe && this.inflight < 2 && sp) {
          const from = Math.floor((cur + this.fps) / this.chunk);
          for (let c = Math.max(first, from); c <= lastC; c++) {
            if (this.chunkLoading.has(c)) continue;
            const have = this.chunkQ(c, cur);
            if (have >= this.top) continue;
            const lead = (c * this.chunk - cur) / this.fps / this.rate;   // seconds until it plays
            let pick = -1;
            for (let t = this.top; t > have; t--) {
              const secs = this.tiers[t].bps * this.chunk / this.fps / sp;
              if (secs + 0.3 < lead * 0.7) { pick = t; break; }
            }
            if (pick >= 0) { this.fetchChunk(c, pick); break; }
          }
        }
      } else {
        for (let i = cur; i <= Math.min(last, cur + this.safe) && this.inflight < 6; i++) {
          const e = this.cache.get(i);
          if (!e || (!e.blob && !e.loading)) this.fetchBlob(i);
        }
      }
      const lastBmp = Math.min(this.count - 1, cur + this.bmpAhead);
      const keepTo = cur + this.blobAhead + this.chunk + 2;   // whole chunks
      for (let i = cur; i <= lastBmp; i++) this.decode(i);
      // Let go of what is far behind or far ahead (after a seek).
      for (const [i, e] of this.cache) {
        if (i < cur - 3 || i > keepTo) {
          if (e.loading) continue;
          if (e.bitmap) e.bitmap.close();
          this.cache.delete(i);
        } else if (e.bitmap && i > lastBmp + 2) {
          e.bitmap.close(); e.bitmap = null;
        }
      }
    }
    // Compressed frames ready for the next `seconds` (or to the end).
    bufferedFrom(i, seconds) {
      const end = Math.min(this.count, i + Math.ceil(seconds * this.fps));
      for (let k = i; k < end; k++) { const e = this.cache.get(k); if (!e || !e.blob) return false; }
      return true;
    }
    readyFrom(i, n) {
      for (let k = i; k < Math.min(this.count, i + n); k++) {
        const e = this.cache.get(k);
        if (!e || !e.bitmap) return false;
      }
      return true;
    }

    canStart(i, seconds) {
      return this.bufferedFrom(i, seconds) && this.readyFrom(i, Math.min(this.bmpAhead, Math.max(2, Math.ceil(this.fps / 3))));
    }

    // --- playback
    play() {
      if (!this.meta || this.playing) return;
      if (this.frameAt(this.now()) >= this.count - 1) this.setTime(0);
      this.playing = true;
      this.updateButton();
      if (this.hasAudio) audioCtx();   // unlock Web Audio while we have the tap
      const i = this.frameAt(this.now());
      if (this.canStart(i, 1.5)) { this.stalled = true; this.resume(); return; }
      this.stalled = true;   // start once a little is buffered
      $('bufferBadge').hidden = false;
      if (this.hasAudio && !(this.audio instanceof WebAudioOut)) {
        // Phones only let audio start from a tap: start it now, hold it
        // until the frames are ready, then the loop lets it run.
        const t = this.now();
        this.audio.muted = true;
        this.audio.play().then(() => {
          if (this.stalled || !this.playing) { this.audio.pause(); this.setTime(t); }
        }).catch(() => {}).finally(() => { this.audio.muted = userMuted; });
      }
    }
    pause() {
      if (!this.playing) return;
      const t = this.now();
      this.playing = false;
      this.stalled = false;
      if (this.hasAudio) this.audio.pause();
      this.setTime(t);
      $('bufferBadge').hidden = true;
      this.updateButton();
    }
    toggle() { this.playing ? this.pause() : this.play(); }
    finish() {
      this.playing = false; this.stalled = false;
      if (this.hasAudio) this.audio.pause();
      this.wall = { base: this.duration, at: performance.now() };
      $('bufferBadge').hidden = true;
      this.updateButton();
      this.updateReadout(this.frameAt(this.now()));
      savePosition(this.meta.id, 0);   // watched to the end: next time from the start
      this.saved = { t: 0, at: performance.now() };
    }
    // Save the position every 5 s while playing, and shortly after a pause,
    // step or seek.
    maybeSave() {
      if (!this.meta || !this.saved) return;
      const t = this.frameAt(this.now()) / this.fps, p = performance.now();
      if (Math.abs(t - this.saved.t) < 1) return;
      if (p - this.saved.at < (this.playing ? 5000 : 1000)) return;
      this.saved = { t, at: p };
      savePosition(this.meta.id, t);
    }
    resume() {
      this.stalled = false;
      $('bufferBadge').hidden = true;
      const t = this.now();
      this.wall = { base: t, at: performance.now() };
      if (this.hasAudio) {
        this.audio.playbackRate = this.rate;
        this.audio.play().catch(() => this.audioFailed());
        this.smooth = { t: this.audio.currentTime, at: performance.now() };
      }
    }
    stall() {
      this.stalled = true;
      const t = this.now();
      if (this.hasAudio) this.audio.pause();
      this.setTime(t);
      $('bufferBadge').hidden = false;
    }
    seekFrame(i) {
      if (!this.meta) return;
      i = Math.max(0, Math.min(this.count - 1, i));
      this.setTime(this.timeOf(i));
      if (this.playing) this.stall();
      this.drawn = -1;
      this.updateReadout(i);
    }
    step(d) {
      if (!this.meta) return;
      const i = this.frameAt(this.now()) + d;
      this.pause();
      this.seekFrame(i);
    }
    setRate(r) {
      if (this.hasAudio) this.audio.playbackRate = r;
      const t = this.now();
      this.wall = { base: t, at: performance.now() };
    }

    loop() {
      requestAnimationFrame(this.loop);
      if (!this.meta || !this.count) return;
      const t = this.now();
      if (!this.hasAudio && this.playing && !this.stalled && t >= this.duration) { this.finish(); }
      const i = this.frameAt(this.now());
      this.schedule(i);
      this.maybeSave();
      if (this.playing) {
        if (this.stalled) {
          // After running dry, wait for a few seconds of frames, so it does
          // not stop again a moment later.
          if (this.canStart(i, this.dropped ? 3 : 1.5)) this.resume();
        } else if (!this.readyFrom(i, 1)) {
          this.dropped++;
          this.stall();
        }
      }
      const e = this.cache.get(i);
      if (i !== this.drawn && e && e.bitmap) {
        this.ctx.drawImage(e.bitmap, 0, 0, this.canvas.width, this.canvas.height);
        this.drawn = i;
        this.shownQ = e.q;
        this.updateReadout(i);
      }
    }

    updateReadout(i) {
      $('curTime').textContent = fmtTime(i / this.fps);
      if (!scrubbing) $('timeline').value = String(i);
      window.__frameState = { frame: i, time: this.now(), audio: this.hasAudio ? this.audio.currentTime : null, playing: this.playing, stalled: this.stalled, dropped: this.dropped, tier: this.base, shown: this.shownQ, mbps: +(this.speed() * 8 / 1e6).toFixed(1) };
    }
    updateButton() {
      $('playBtn').innerHTML = this.playing ? ICONS.pause : ICONS.play;
      $('playBtn').setAttribute('aria-label', this.playing ? 'Pause' : 'Play');
    }
  }

  function savePosition(id, t) {
    const v = videos.find(x => x.id === id);
    if (v) v.position = t;
    fetch(`/api/videos/${id}/position`, {
      method: 'POST', keepalive: true,
      headers: { 'X-Frame-Key': key, 'Content-Type': 'application/json' }, body: JSON.stringify({ t }),
    }).catch(() => {});
  }
  // Leaving the page (or the car screen turning off) saves too.
  const saveNow = () => { if (player.meta) { const t = player.frameAt(player.now()) / player.fps; player.saved = { t, at: performance.now() }; savePosition(player.meta.id, t); } };
  window.addEventListener('pagehide', saveNow);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveNow(); });

  const player = new Player();
  let scrubbing = false;
  let userMuted = false;

  $('playBtn').addEventListener('click', () => player.toggle());
  $('restartBtn').addEventListener('click', () => { player.seekFrame(0); $('resumeInfo').hidden = true; });
  $('prevBtn').addEventListener('click', () => player.step(-1));
  $('nextBtn').addEventListener('click', () => player.step(1));
  $('rateSelect').addEventListener('change', () => player.setRate(player.rate));
  $('timeline').addEventListener('input', () => { scrubbing = true; player.seekFrame(Number($('timeline').value)); });
  $('timeline').addEventListener('change', () => { scrubbing = false; });
  $('muteBtn').addEventListener('click', () => { userMuted = !userMuted; player.audio.muted = userMuted; updateMute(); });
  function updateMute() { $('muteBtn').innerHTML = userMuted ? ICONS.muted : ICONS.sound; }

  // Fullscreen: the real thing where the browser allows it on a page element
  // (desktop, Android, iPad); iPhone Safari only allows it for <video>, so
  // there the player card is stretched over the whole screen instead.
  const card = $('playerCard');
  const nativeFs = !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);
  const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement;
  let fakeFs = false;
  function updateFs() {
    const on = fakeFs || fsElement() === card;
    card.classList.toggle('is-fs', on);
    document.body.classList.toggle('fs-lock', on);
    $('fsBtn').innerHTML = on ? ICONS.fsExit : ICONS.fs;
    $('fsBtn').setAttribute('aria-label', on ? 'Exit fullscreen' : 'Fullscreen');
  }
  function setFake(on) {
    fakeFs = on;
    updateFs();
    if (on && screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {});
  }
  $('fsBtn').addEventListener('click', () => {
    if (fakeFs) return setFake(false);
    if (fsElement()) { (document.exitFullscreen || document.webkitExitFullscreen).call(document); return; }
    if (nativeFs) {
      const req = card.requestFullscreen || card.webkitRequestFullscreen;
      try {
        const p = req.call(card);
        if (p && p.then) p.then(() => { if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {}); }).catch(() => setFake(true));
      } catch { setFake(true); }
    } else setFake(true);
  });
  document.addEventListener('fullscreenchange', updateFs);
  document.addEventListener('webkitfullscreenchange', updateFs);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && fakeFs) setFake(false); });

  document.addEventListener('keydown', e => {
    if (!player.meta || ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName) && e.target.type !== 'range') return;
    if (e.key === ' ') { e.preventDefault(); player.toggle(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); e.shiftKey ? player.seekFrame(player.frameAt(player.now()) - Math.round(player.fps * 5)) : player.step(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); e.shiftKey ? player.seekFrame(player.frameAt(player.now()) + Math.round(player.fps * 5)) : player.step(1); }
    else if (e.key.toLowerCase() === 'm') $('muteBtn').click();
    else if (e.key.toLowerCase() === 'f') $('fsBtn').click();
  });

  // ------------------------------------------------------------ library
  let videos = [];
  let pollTimer = 0;
  const armed = new Set();   // ids whose delete button was pressed once

  async function refresh() {
    if (!key) { showKeyCard(); return; }
    try {
      const res = await api('/api/videos');
      videos = res.videos;
      setServer('ok', 'Mac mini connected');
      $('keyCard').hidden = true;
      render();
    } catch (e) {
      if (e.message !== 'key') setServer('bad', 'Cannot reach the Mac mini');
    }
    clearTimeout(pollTimer);
    const busy = videos.some(v => ['queued', 'downloading', 'processing', 'uploading'].includes(v.status));
    pollTimer = setTimeout(refresh, busy ? 1500 : 15000);
  }

  function statusLine(v) {
    if (v.status === 'ready') {
      return `${fmtTime(v.duration, false)} · ${fmtFps(v.fps)} · ${v.frames} frames · ${v.height}p · ${fmtBytes(v.bytes)}`;
    }
    if (v.status === 'error') return v.error === '已取消' ? 'Cancelled' : (v.error || 'Failed');
    const pct = v.progress ? ` ${Math.round(v.progress)}%` : '';
    const label = { queued: 'Waiting', uploading: 'Uploading', downloading: 'Downloading', processing: 'Splitting frames' }[v.status] || v.status;
    return label + pct;
  }

  const watched = v => v.status === 'ready' && v.position > 3 && v.position < v.duration - 3;

  function render() {
    const total = videos.reduce((a, v) => a + (v.bytes || 0), 0);
    $('libInfo').textContent = videos.length ? `${videos.length} video${videos.length === 1 ? '' : 's'} · ${fmtBytes(total)}` : '';
    $('libEmpty').hidden = videos.length > 0;
    $('grid').innerHTML = videos.map(v => {
      const ready = v.status === 'ready', busy = !ready && v.status !== 'error';
      const thumb = ready
        ? `<div class="thumb" data-play="${v.id}" style="background-image:url('${media(v.id, 'thumb.jpg')}')"><span class="dur">${fmtTime(v.duration, false)}</span>${watched(v) ? `<span class="watched"><i style="width:${Math.min(100, v.position / v.duration * 100)}%"></i></span>` : ''}</div>`
        : `<div class="thumb pending">${busy ? 'Processing…' : 'Failed'}</div>`;
      return `<article class="item${player.meta && player.meta.id === v.id ? ' active' : ''}">
        ${thumb}
        <div class="item-body">
          <div class="item-title" title="${esc(v.title)}">${esc(v.title || v.source)}</div>
          ${busy ? `<div class="bar"><i style="width:${v.progress || 2}%"></i></div>` : ''}
          <div class="item-meta${v.status === 'error' ? ' error' : ''}">${esc(statusLine(v))}</div>
          <div class="item-actions">
            ${ready ? `<button class="ghost" data-play="${v.id}">${watched(v) ? `Continue ${fmtTime(v.position, false)}` : 'Play'}</button>` : ''}
            ${busy ? `<button class="ghost" data-cancel="${v.id}">Cancel</button>` : ''}
            ${v.status === 'error' && v.source.startsWith('http') ? `<button class="ghost" data-retry="${v.id}">Retry</button>` : ''}
            <button class="ghost danger${armed.has(v.id) ? ' confirm' : ''}" data-del="${v.id}">${armed.has(v.id) ? 'Delete?' : 'Delete'}</button>
          </div>
        </div>
      </article>`;
    }).join('');
  }

  $('grid').addEventListener('click', async e => {
    const t = e.target.closest('[data-play],[data-del],[data-cancel],[data-retry]');
    if (!t) return;
    if (t.dataset.play) {
      const v = videos.find(x => x.id === t.dataset.play);
      if (v) { if (player.meta) saveNow(); player.open(v); render(); $('playerCard').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    } else if (t.dataset.del) {
      const id = t.dataset.del;
      if (!armed.has(id)) {
        armed.add(id); render();
        setTimeout(() => { if (armed.delete(id)) render(); }, 4000);
        return;
      }
      armed.delete(id);
      if (player.meta && player.meta.id === id) { player.close(); $('playerCard').hidden = true; }
      try { await api(`/api/videos/${id}`, { method: 'DELETE' }); } catch (err) { note('Delete failed: ' + err.message, true); }
      refresh();
    } else if (t.dataset.cancel) {
      try { await api(`/api/videos/${t.dataset.cancel}/cancel`, { method: 'POST' }); } catch {}
      refresh();
    } else if (t.dataset.retry) {
      const v = videos.find(x => x.id === t.dataset.retry);
      if (v) submitUrl(v.source, v.requestFps, v.requestHeight).then(ok => ok && api(`/api/videos/${v.id}`, { method: 'DELETE' }).then(refresh));
    }
  });

  // ------------------------------------------------------------ new video
  async function submitUrl(url, fps, height) {
    $('startBtn').disabled = true;
    try {
      await api('/api/videos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, fps, height }) });
      note('Sent to the Mac mini. Progress shows below.');
      refresh();
      return true;
    } catch (e) {
      if (e.message !== 'key') note('Could not start: ' + e.message, true);
      return false;
    } finally { $('startBtn').disabled = false; }
  }

  $('newForm').addEventListener('submit', async e => {
    e.preventDefault();
    const url = $('urlInput').value.trim();
    if (await submitUrl(url, Number($('fpsSelect').value), Number($('heightSelect').value))) $('urlInput').value = '';
  });

  $('fileInput').addEventListener('change', () => {
    const f = $('fileInput').files[0];
    $('fileInput').value = '';
    if (!f) return;
    const q = new URLSearchParams({ name: f.name, fps: $('fpsSelect').value, height: $('heightSelect').value });
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload?' + q);
    xhr.setRequestHeader('X-Frame-Key', key);
    xhr.upload.onprogress = ev => { if (ev.lengthComputable) note(`Uploading ${Math.round(ev.loaded / ev.total * 100)}% (${fmtBytes(ev.loaded)} / ${fmtBytes(ev.total)})`); };
    xhr.onload = () => {
      if (xhr.status === 401) { showKeyCard(); return; }
      if (xhr.status >= 200 && xhr.status < 300) { note('Uploaded. The Mac mini is processing it.'); refresh(); }
      else { let msg = `HTTP ${xhr.status}`; try { msg = JSON.parse(xhr.responseText).error || msg; } catch {} note('Upload failed: ' + msg, true); }
    };
    xhr.onerror = () => note('Upload failed: cannot reach the Mac mini', true);
    xhr.send(f);
    note('Uploading 0%');
  });

  $('prevBtn').innerHTML = ICONS.prev; $('nextBtn').innerHTML = ICONS.next; $('playBtn').innerHTML = ICONS.play;
  updateMute(); updateFs();
  refresh();
})();
