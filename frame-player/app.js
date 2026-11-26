(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const KEY_STORE = 'framestudio.key';

  // ------------------------------------------------------------ key + API
  function readKey() {
    const m = location.hash.match(/key=([^&]+)/);
    if (m) {
      const k = decodeURIComponent(m[1]);
      try { localStorage.setItem(KEY_STORE, k); } catch {}
      history.replaceState(null, '', location.pathname + location.search);
      return k;
    }
    try { return localStorage.getItem(KEY_STORE) || ''; } catch { return ''; }
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

  function showKeyCard() { $('keyCard').hidden = false; setServer('bad', '需要密钥'); }
  $('keyForm').addEventListener('submit', e => {
    e.preventDefault();
    key = $('keyInput').value.trim();
    try { localStorage.setItem(KEY_STORE, key); } catch {}
    $('keyCard').hidden = true;
    refresh();
  });

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
    get hasAudio() { return !!(this.meta && this.meta.hasAudio); }

    open(meta) {
      this.close();
      this.meta = meta;
      this.gen++;
      this.canvas.width = meta.width || 1280;
      this.canvas.height = meta.height || 720;
      $('stage').style.aspectRatio = `${this.canvas.width} / ${this.canvas.height}`;
      if (this.hasAudio) {
        this.audio.src = media(meta.id, 'audio.m4a');
        this.audio.playbackRate = this.rate;
        this.audio.load();
      }
      const px = this.canvas.width * this.canvas.height * 4;
      // Decoded bitmaps are big: at most about 120 MB of them (1.5 s at most).
      this.bmpAhead = Math.max(2, Math.min(Math.ceil(this.fps * 1.5), Math.floor(120e6 / px)));
      this.blobAhead = Math.max(this.bmpAhead, Math.ceil(this.fps * 6));
      this.wall = { base: 0, at: performance.now() };
      this.drawn = -1;
      this.dropped = 0;
      $('timeline').max = String(Math.max(0, this.count - 1));
      $('durTime').textContent = fmtTime(this.duration);
      $('nowTitle').textContent = meta.title || '';
      $('nowInfo').textContent = `${fmtFps(meta.fps)} · ${meta.frames} 帧 · ${meta.width}×${meta.height}` + (meta.hasAudio ? ' · 有声音' : ' · 无声音');
      $('playerCard').hidden = false;
      this.seekFrame(0);
    }

    close() {
      this.pause();
      this.gen++;
      for (const e of this.cache.values()) if (e.bitmap) e.bitmap.close();
      this.cache.clear();
      this.inflight = 0;
      this.audio.removeAttribute('src');
      this.audio.load();
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
    fetchBlob(i) {
      const e = this.entry(i), gen = this.gen;
      if (e.blob || e.loading) return;
      e.loading = true;
      this.inflight++;
      fetch(media(this.meta.id, 'frames/' + frameName(i)))
        .then(r => { if (!r.ok) throw new Error(r.status); return r.blob(); })
        .then(b => { if (gen === this.gen) e.blob = b; })
        .catch(() => {})
        .finally(() => { if (gen === this.gen) { e.loading = false; this.inflight--; } });
    }
    decode(i) {
      const e = this.entry(i), gen = this.gen;
      if (!e.blob || e.bitmap || e.decoding) return;
      e.decoding = true;
      createImageBitmap(e.blob)
        .then(bm => { if (gen === this.gen && this.cache.get(i) === e) e.bitmap = bm; else bm.close(); })
        .catch(() => {})
        .finally(() => { e.decoding = false; });
    }
    schedule(cur) {
      const last = Math.min(this.count - 1, cur + this.blobAhead);
      for (let i = cur; i <= last && this.inflight < 8; i++) {
        const e = this.cache.get(i);
        if (!e || (!e.blob && !e.loading)) this.fetchBlob(i);
      }
      const lastBmp = Math.min(this.count - 1, cur + this.bmpAhead);
      for (let i = cur; i <= lastBmp; i++) this.decode(i);
      // Let go of what is far behind or far ahead (after a seek).
      for (const [i, e] of this.cache) {
        if (i < cur - 3 || i > last + 2) {
          if (e.loading) continue;
          if (e.bitmap) e.bitmap.close();
          this.cache.delete(i);
        } else if (e.bitmap && i > lastBmp + 2) {
          e.bitmap.close(); e.bitmap = null;
        }
      }
    }
    readyFrom(i, n) {
      for (let k = i; k < Math.min(this.count, i + n); k++) {
        const e = this.cache.get(k);
        if (!e || !e.bitmap) return false;
      }
      return true;
    }

    // --- playback
    play() {
      if (!this.meta || this.playing) return;
      if (this.frameAt(this.now()) >= this.count - 1) this.setTime(0);
      this.playing = true;
      this.updateButton();
      const i = this.frameAt(this.now());
      if (this.readyFrom(i, Math.min(this.bmpAhead, Math.max(2, Math.ceil(this.fps / 3))))) { this.stalled = true; this.resume(); return; }
      this.stalled = true;   // start once a little is buffered
      $('bufferBadge').hidden = false;
      if (this.hasAudio) {
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
    }
    resume() {
      this.stalled = false;
      $('bufferBadge').hidden = true;
      const t = this.now();
      this.wall = { base: t, at: performance.now() };
      if (this.hasAudio) {
        this.audio.playbackRate = this.rate;
        this.audio.play().catch(() => { this.playing = false; this.updateButton(); note('浏览器阻止了自动播放，请再点一次播放。', true); });
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
      if (this.playing) {
        const need = Math.min(this.bmpAhead, Math.max(2, Math.ceil(this.fps / 3)));
        if (this.stalled) {
          if (this.readyFrom(i, need)) this.resume();
        } else if (!this.readyFrom(i, 1)) {
          this.dropped++;
          this.stall();
        }
      }
      const e = this.cache.get(i);
      if (i !== this.drawn && e && e.bitmap) {
        this.ctx.drawImage(e.bitmap, 0, 0, this.canvas.width, this.canvas.height);
        this.drawn = i;
        this.updateReadout(i);
      }
    }

    updateReadout(i) {
      $('curTime').textContent = fmtTime(i / this.fps);
      if (!scrubbing) $('timeline').value = String(i);
      window.__frameState = { frame: i, time: this.now(), audio: this.hasAudio ? this.audio.currentTime : null, playing: this.playing, stalled: this.stalled, dropped: this.dropped };
    }
    updateButton() {
      $('playBtn').textContent = this.playing ? '❚❚' : '▶';
      $('playBtn').setAttribute('aria-label', this.playing ? '暂停' : '播放');
    }
  }

  const player = new Player();
  let scrubbing = false;
  let userMuted = false;

  $('playBtn').addEventListener('click', () => player.toggle());
  $('prevBtn').addEventListener('click', () => player.step(-1));
  $('nextBtn').addEventListener('click', () => player.step(1));
  $('rateSelect').addEventListener('change', () => player.setRate(player.rate));
  $('timeline').addEventListener('input', () => { scrubbing = true; player.seekFrame(Number($('timeline').value)); });
  $('timeline').addEventListener('change', () => { scrubbing = false; });
  $('volume').addEventListener('input', () => { player.audio.volume = Number($('volume').value); userMuted = false; player.audio.muted = false; updateMute(); });
  $('muteBtn').addEventListener('click', () => { userMuted = !userMuted; player.audio.muted = userMuted; updateMute(); });
  function updateMute() { $('muteBtn').textContent = userMuted || player.audio.volume === 0 ? '🔇' : '🔊'; }
  $('fsBtn').addEventListener('click', () => {
    const st = $('stage');
    if (document.fullscreenElement) document.exitFullscreen();
    else if (st.requestFullscreen) st.requestFullscreen().catch(() => {});
    else if (st.webkitRequestFullscreen) st.webkitRequestFullscreen();
  });
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
      setServer('ok', 'Mac mini 已连接');
      $('keyCard').hidden = true;
      render();
    } catch (e) {
      if (e.message !== 'key') setServer('bad', '连不上 Mac mini');
    }
    clearTimeout(pollTimer);
    const busy = videos.some(v => ['queued', 'downloading', 'processing', 'uploading'].includes(v.status));
    pollTimer = setTimeout(refresh, busy ? 1500 : 15000);
  }

  function statusLine(v) {
    if (v.status === 'ready') {
      return `${fmtTime(v.duration, false)} · ${fmtFps(v.fps)} · ${v.frames} 帧 · ${v.height}p · ${fmtBytes(v.bytes)}`;
    }
    if (v.status === 'error') return v.error || '失败';
    const pct = v.progress ? ` ${Math.round(v.progress)}%` : '';
    return (v.stage || v.status) + pct;
  }

  function render() {
    const total = videos.reduce((a, v) => a + (v.bytes || 0), 0);
    $('libInfo').textContent = videos.length ? `${videos.length} 部 · ${fmtBytes(total)}` : '';
    $('libEmpty').hidden = videos.length > 0;
    $('grid').innerHTML = videos.map(v => {
      const ready = v.status === 'ready', busy = !ready && v.status !== 'error';
      const thumb = ready
        ? `<div class="thumb" data-play="${v.id}" style="background-image:url('${media(v.id, 'thumb.jpg')}')"><span class="dur">${fmtTime(v.duration, false)}</span></div>`
        : `<div class="thumb pending">${busy ? '处理中…' : '处理失败'}</div>`;
      return `<article class="item${player.meta && player.meta.id === v.id ? ' active' : ''}">
        ${thumb}
        <div class="item-body">
          <div class="item-title" title="${esc(v.title)}">${esc(v.title || v.source)}</div>
          ${busy ? `<div class="bar"><i style="width:${v.progress || 2}%"></i></div>` : ''}
          <div class="item-meta${v.status === 'error' ? ' error' : ''}">${esc(statusLine(v))}</div>
          <div class="item-actions">
            ${ready ? `<button class="ghost" data-play="${v.id}">播放</button><a class="ghost" href="/api/videos/${v.id}/zip?k=${encodeURIComponent(key)}">下载 ZIP</a>` : ''}
            ${busy ? `<button class="ghost" data-cancel="${v.id}">取消</button>` : ''}
            ${v.status === 'error' && v.source.startsWith('http') ? `<button class="ghost" data-retry="${v.id}">重试</button>` : ''}
            <button class="ghost danger${armed.has(v.id) ? ' confirm' : ''}" data-del="${v.id}">${armed.has(v.id) ? '确定删除？' : '删除'}</button>
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
      if (v) { player.open(v); render(); $('playerCard').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    } else if (t.dataset.del) {
      const id = t.dataset.del;
      if (!armed.has(id)) {
        armed.add(id); render();
        setTimeout(() => { if (armed.delete(id)) render(); }, 4000);
        return;
      }
      armed.delete(id);
      if (player.meta && player.meta.id === id) { player.close(); $('playerCard').hidden = true; }
      try { await api(`/api/videos/${id}`, { method: 'DELETE' }); } catch (err) { note('删除失败：' + err.message, true); }
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
      note('已经交给 Mac mini 处理，下面可以看到进度。');
      refresh();
      return true;
    } catch (e) {
      if (e.message !== 'key') note('没能开始：' + e.message, true);
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
    xhr.upload.onprogress = ev => { if (ev.lengthComputable) note(`上传中 ${Math.round(ev.loaded / ev.total * 100)}%（${fmtBytes(ev.loaded)} / ${fmtBytes(ev.total)}）`); };
    xhr.onload = () => {
      if (xhr.status === 401) { showKeyCard(); return; }
      if (xhr.status >= 200 && xhr.status < 300) { note('上传完成，Mac mini 开始处理。'); refresh(); }
      else { let msg = `HTTP ${xhr.status}`; try { msg = JSON.parse(xhr.responseText).error || msg; } catch {} note('上传失败：' + msg, true); }
    };
    xhr.onerror = () => note('上传失败：连不上 Mac mini', true);
    xhr.send(f);
    note('上传中 0%');
  });

  refresh();
})();
