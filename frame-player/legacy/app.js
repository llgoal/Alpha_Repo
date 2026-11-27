(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const els = {
    form: $('urlForm'), url: $('videoUrl'), clearUrl: $('clearUrl'), file: $('fileInput'),
    canvas: $('frameCanvas'), youtubeLayer: $('youtubeLayer'), stage: $('stage'),
    empty: $('emptyState'), loading: $('loading'), status: $('stageStatus'), frameReadout: $('frameReadout'),
    currentFrame: $('currentFrame'), timeline: $('timeline'), currentTime: $('currentTime'), duration: $('duration'),
    sourceName: $('sourceName'), prev: $('prevFrame'), play: $('playPause'), next: $('nextFrame'),
    rate: $('playbackRate'), fps: $('fps'), mute: $('mute'), fullscreen: $('fullscreen'), message: $('message')
  };
  const ctx = els.canvas.getContext('2d', { alpha: false });
  const state = {
    ready: false, mode: null, loadId: 0, playing: false, playbackToken: 0,
    decoder: null, frameQueue: [], samples: [], presentation: [], timestampIndex: new Map(), decoderConfig: null,
    currentIndex: 0, duration: 0, youtubePlayer: null, youtubeTimer: 0
  };
  let mp4boxPromise = null;
  let youtubeApiPromise = null;
  const controls = [els.prev, els.play, els.next, els.rate, els.mute, els.fullscreen, els.timeline];

  function setControls(enabled) {
    controls.forEach(control => { control.disabled = !enabled; });
    els.mute.disabled = !enabled || state.mode === 'canvas';
    els.fps.disabled = enabled && state.mode === 'canvas';
  }
  function setStatus(label, isError = false) { els.status.textContent = label; els.status.classList.toggle('error', isError); }
  function showMessage(text, kind = 'error') { els.message.textContent = text; els.message.className = `message${kind === 'info' ? ' info' : ''}`; els.message.hidden = false; }
  function hideMessage() { els.message.hidden = true; els.message.textContent = ''; }
  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '00:00.000';
    const hours = Math.floor(seconds / 3600), minutes = Math.floor((seconds % 3600) / 60), secs = Math.floor(seconds % 60), millis = Math.floor((seconds % 1) * 1000);
    const base = `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
    return hours ? `${String(hours).padStart(2, '0')}:${base}` : base;
  }
  function selectedFps() { return Math.max(1, Number(els.fps.value) || 30); }
  function youtubeState() { try { return state.youtubePlayer ? state.youtubePlayer.getPlayerState() : -1; } catch { return -1; } }
  function isPlaying() { return state.ready && (state.mode === 'youtube' ? youtubeState() === 1 : state.playing); }
  function currentCanvasTime() {
    const sample = state.presentation[state.currentIndex];
    return sample ? sample.cts / sample.timescale : 0;
  }
  function currentTimeValue() {
    if (state.mode === 'youtube') { try { return Number(state.youtubePlayer.getCurrentTime()) || 0; } catch { return 0; } }
    return currentCanvasTime();
  }
  function durationValue() {
    if (state.mode === 'youtube') { try { return Number(state.youtubePlayer.getDuration()) || 0; } catch { return 0; } }
    return state.duration;
  }
  function updateReadout(mediaTime = currentTimeValue()) {
    if (!state.ready) return;
    const duration = durationValue();
    const progress = duration > 0 ? Math.min(1000, Math.max(0, mediaTime / duration * 1000)) : 0;
    els.timeline.value = String(progress); els.timeline.style.setProperty('--progress', `${progress / 10}%`);
    els.currentTime.textContent = formatTime(mediaTime); els.duration.textContent = formatTime(duration);
    const frame = state.mode === 'canvas' ? state.currentIndex + 1 : Math.max(0, Math.round(mediaTime * selectedFps()));
    els.currentFrame.textContent = String(frame).padStart(6, '0');
  }
  function updatePlayButton() {
    const playing = isPlaying(); els.play.classList.toggle('playing', playing);
    els.play.setAttribute('aria-label', playing ? '暂停' : '播放');
    setStatus(playing ? 'PLAYING' : state.ready ? (state.mode === 'canvas' ? 'WEBCODECS READY' : 'PAUSED') : 'READY');
  }
  function sourceName(url) {
    try { const parsed = new URL(url); const name = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || parsed.hostname); return name.length > 50 ? `${name.slice(0, 47)}…` : name; }
    catch { return 'REMOTE MP4'; }
  }
  function closeFrameQueue() { for (const item of state.frameQueue) item.frame.close(); state.frameQueue = []; }
  function stopCanvasPlayback(update = true) {
    state.playing = false; state.playbackToken++; closeFrameQueue();
    if (state.decoder) { try { state.decoder.close(); } catch {} state.decoder = null; }
    if (update) updatePlayButton();
  }
  function stopYoutubeTimer() { if (state.youtubeTimer) clearInterval(state.youtubeTimer); state.youtubeTimer = 0; }
  function startYoutubeTimer() { stopYoutubeTimer(); state.youtubeTimer = window.setInterval(() => { if (state.mode === 'youtube' && state.ready) updateReadout(); }, 150); }

  function resetSource() {
    state.loadId++; state.ready = false; stopCanvasPlayback(false); stopYoutubeTimer(); state.mode = null;
    state.samples = []; state.presentation = []; state.timestampIndex = new Map(); state.decoderConfig = null; state.currentIndex = 0; state.duration = 0;
    if (state.youtubePlayer) { try { state.youtubePlayer.destroy(); } catch {} state.youtubePlayer = null; }
    els.youtubeLayer.hidden = true; els.youtubeLayer.innerHTML = '<div id="youtubePlayer"></div>'; els.canvas.hidden = false;
    setControls(false); els.fps.disabled = false; els.frameReadout.hidden = true; els.empty.hidden = false; els.loading.hidden = true;
    els.canvas.width = 300; els.canvas.height = 150; ctx.fillStyle = '#060608'; ctx.fillRect(0, 0, 300, 150);
    els.currentTime.textContent = '00:00.000'; els.duration.textContent = '00:00.000'; els.sourceName.textContent = 'NO SOURCE';
    els.timeline.value = '0'; els.timeline.style.setProperty('--progress', '0%'); els.rate.value = '1'; els.mute.classList.remove('muted'); updatePlayButton();
  }

  function getMP4Box() {
    if (!mp4boxPromise) mp4boxPromise = import('https://cdn.jsdelivr.net/npm/mp4box@2.4.1/+esm');
    return mp4boxPromise;
  }
  function decoderDescription(MP4Box, file, track) {
    const trak = file.getTrackById(track.id);
    for (const entry of trak.mdia.minf.stbl.stsd.entries) {
      const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
      if (!box) continue;
      const stream = new MP4Box.DataStream(undefined, 0, MP4Box.DataStream.BIG_ENDIAN);
      box.write(stream); return new Uint8Array(stream.buffer, 8);
    }
    throw new Error('unsupported-codec');
  }
  async function feedLocalFile(file, mp4, loadId) {
    const chunkSize = 2 * 1024 * 1024;
    for (let offset = 0; offset < file.size; offset += chunkSize) {
      if (loadId !== state.loadId) throw new Error('cancelled');
      const buffer = await file.slice(offset, Math.min(file.size, offset + chunkSize)).arrayBuffer();
      buffer.fileStart = offset; mp4.appendBuffer(buffer);
      setStatus(`READING ${Math.round(Math.min(file.size, offset + buffer.byteLength) / file.size * 100)}%`);
    }
  }
  async function feedRemoteFile(url, mp4, loadId) {
    const chunkSize = 2 * 1024 * 1024; let offset = 0, total = null;
    while (total === null || offset < total) {
      if (loadId !== state.loadId) throw new Error('cancelled');
      const response = await fetch(url, { headers: { Range: `bytes=${offset}-${offset + chunkSize - 1}` } });
      if (!response.ok) throw new Error('fetch');
      const buffer = await response.arrayBuffer();
      if (response.status !== 206) {
        if (offset !== 0) throw new Error('range');
        buffer.fileStart = 0; mp4.appendBuffer(buffer); setStatus('READING 100%'); return;
      }
      const match = (response.headers.get('content-range') || '').match(/\/(\d+)$/);
      if (!match || buffer.byteLength === 0) throw new Error('range');
      total = Number(match[1]); buffer.fileStart = offset; mp4.appendBuffer(buffer); offset += buffer.byteLength;
      setStatus(`READING ${Math.round(offset / total * 100)}%`);
    }
  }
  async function demuxMP4(source, loadId) {
    const MP4Box = await getMP4Box();
    if (loadId !== state.loadId) throw new Error('cancelled');
    const file = MP4Box.createFile(); const samples = [];
    let track = null, config = null, resolveReady, rejectReady;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    file.onError = () => rejectReady(new Error('demux'));
    file.onReady = info => {
      track = info.videoTracks && info.videoTracks[0];
      if (!track) { rejectReady(new Error('no-video')); return; }
      try {
        config = {
          codec: track.codec.startsWith('vp08') ? 'vp8' : track.codec,
          codedWidth: track.video.width, codedHeight: track.video.height,
          description: decoderDescription(MP4Box, file, track)
        };
        file.setExtractionOptions(track.id, null, { nbSamples: 100 }); file.start(); resolveReady();
      } catch (error) { rejectReady(error); }
    };
    file.onSamples = (_id, _user, batch) => { for (const sample of batch) samples.push(sample); };
    if (source instanceof Blob) await feedLocalFile(source, file, loadId); else await feedRemoteFile(source, file, loadId);
    file.flush(); await ready; await new Promise(resolve => setTimeout(resolve, 0));
    if (!samples.length) throw new Error('no-samples');
    const support = await VideoDecoder.isConfigSupported(config);
    if (!support.supported) throw new Error('unsupported-codec');
    samples.forEach((sample, index) => { sample.decodeIndex = index; });
    const presentation = [...samples].sort((a, b) => a.cts - b.cts || a.dts - b.dts);
    presentation.forEach((sample, index) => { sample.presentationIndex = index; });
    const last = presentation[presentation.length - 1];
    return { samples, presentation, config: support.config, duration: (last.cts + last.duration) / last.timescale };
  }
  function chunkFromSample(sample) {
    return new EncodedVideoChunk({
      type: sample.is_sync ? 'key' : 'delta', timestamp: Math.round(1e6 * sample.cts / sample.timescale),
      duration: Math.round(1e6 * sample.duration / sample.timescale), data: sample.data
    });
  }
  async function waitForDecoder(decoder, maxQueue = 16) {
    while (decoder.state === 'configured' && decoder.decodeQueueSize > maxQueue) await new Promise(resolve => setTimeout(resolve, 4));
  }
  function drawVideoFrame(frame, index) {
    const width = frame.displayWidth || frame.codedWidth, height = frame.displayHeight || frame.codedHeight;
    if (els.canvas.width !== width || els.canvas.height !== height) { els.canvas.width = width; els.canvas.height = height; }
    ctx.fillStyle = '#050507'; ctx.fillRect(0, 0, width, height); ctx.drawImage(frame, 0, 0, width, height);
    state.currentIndex = index; updateReadout();
  }
  async function renderCanvasFrame(index) {
    if (!state.ready || state.mode !== 'canvas') return;
    stopCanvasPlayback(false); const token = state.playbackToken;
    index = Math.max(0, Math.min(state.presentation.length - 1, index));
    const target = state.presentation[index], targetTimestamp = Math.round(1e6 * target.cts / target.timescale);
    let start = target.decodeIndex;
    while (start > 0 && !state.samples[start].is_sync) start--;
    let end = target.decodeIndex + 1;
    while (end < state.samples.length && !state.samples[end].is_sync) end++;
    let bestFrame = null, bestDiff = Infinity, decoderError = null;
    const decoder = new VideoDecoder({
      output: frame => {
        const diff = Math.abs(frame.timestamp - targetTimestamp);
        if (diff < bestDiff) { if (bestFrame) bestFrame.close(); bestFrame = frame; bestDiff = diff; } else frame.close();
      }, error: error => { decoderError = error; }
    });
    state.decoder = decoder; decoder.configure(state.decoderConfig); setStatus('DECODING FRAME');
    try {
      for (let i = start; i < end; i++) { if (token !== state.playbackToken) throw new Error('cancelled'); decoder.decode(chunkFromSample(state.samples[i])); await waitForDecoder(decoder); }
      await decoder.flush();
      if (decoderError || !bestFrame) throw decoderError || new Error('decode');
      if (token === state.playbackToken) drawVideoFrame(bestFrame, index);
    } finally {
      if (bestFrame) bestFrame.close(); if (decoder.state !== 'closed') decoder.close(); if (state.decoder === decoder) state.decoder = null; updatePlayButton();
    }
  }
  async function runCanvasPlayback(token) {
    const startSample = state.presentation[state.currentIndex]; let start = startSample.decodeIndex;
    while (start > 0 && !state.samples[start].is_sync) start--;
    let pumpDone = false, playbackError = null;
    const decoder = new VideoDecoder({
      output: frame => {
        const timestamp = frame.timestamp;
        const sample = state.timestampIndex.get(Math.round(timestamp));
        if (!sample || sample.presentationIndex < state.currentIndex) frame.close();
        else { state.frameQueue.push({ frame, index: sample.presentationIndex }); state.frameQueue.sort((a, b) => a.frame.timestamp - b.frame.timestamp); }
      }, error: error => { playbackError = error; }
    });
    state.decoder = decoder; decoder.configure(state.decoderConfig);
    const pump = (async () => {
      try {
        for (let i = start; i < state.samples.length && token === state.playbackToken; i++) {
          while (token === state.playbackToken && (decoder.decodeQueueSize > 16 || state.frameQueue.length > 12)) await new Promise(resolve => setTimeout(resolve, 5));
          if (token !== state.playbackToken) break; decoder.decode(chunkFromSample(state.samples[i]));
        }
        if (token === state.playbackToken) await decoder.flush();
      } catch (error) { if (token === state.playbackToken) playbackError = error; }
      pumpDone = true;
    })();
    while (token === state.playbackToken) {
      if (playbackError) throw playbackError;
      const item = state.frameQueue.shift();
      if (!item) { if (pumpDone) break; await new Promise(resolve => setTimeout(resolve, 5)); continue; }
      const sample = state.presentation[item.index];
      const duration = Math.max(8, sample.duration / sample.timescale * 1000 / (Number(els.rate.value) || 1));
      drawVideoFrame(item.frame, item.index); item.frame.close();
      await new Promise(resolve => setTimeout(resolve, duration));
    }
    await pump; if (token === state.playbackToken) { state.playing = false; closeFrameQueue(); if (decoder.state !== 'closed') decoder.close(); state.decoder = null; updatePlayButton(); }
  }
  function startCanvasPlayback() {
    stopCanvasPlayback(false); state.playing = true; const token = state.playbackToken; updatePlayButton();
    runCanvasPlayback(token).catch(() => {
      if (token !== state.playbackToken) return; stopCanvasPlayback(false);
      updatePlayButton(); setStatus('DECODE ERROR', true); showMessage('播放解码失败。请尝试 H.264 编码的标准 MP4 文件。');
    });
  }
  async function loadCanvasSource(source, label) {
    resetSource(); hideMessage(); const loadId = ++state.loadId; state.mode = 'canvas';
    els.loading.hidden = false; els.sourceName.textContent = label; setStatus('PREPARING WEBCODECS');
    if (!('VideoDecoder' in window) || !('EncodedVideoChunk' in window)) {
      els.loading.hidden = true; setStatus('UNSUPPORTED', true); showMessage('当前浏览器不支持 WebCodecs。请使用最新版 Chrome、Edge 或其他支持 WebCodecs 的浏览器。'); return;
    }
    try {
      const result = await demuxMP4(source, loadId); if (loadId !== state.loadId) return;
      state.samples = result.samples; state.presentation = result.presentation; state.decoderConfig = result.config; state.duration = result.duration;
      state.timestampIndex = new Map(result.presentation.map(sample => [Math.round(1e6 * sample.cts / sample.timescale), sample]));
      state.ready = true; els.loading.hidden = true; els.empty.hidden = true; els.frameReadout.hidden = false; setControls(true);
      await renderCanvasFrame(0);
    } catch (error) {
      if (error.message === 'cancelled') return;
      state.ready = false; els.loading.hidden = true; setControls(false); setStatus('MP4 ERROR', true);
      const codec = error.message === 'unsupported-codec';
      showMessage(codec ? '这个 MP4 的视频编码不受当前浏览器支持。建议使用 H.264/AVC 编码。' : '无法解析这个 MP4。直链必须允许跨域读取和 HTTP Range 请求，也可以改用本地 MP4。');
    }
  }

  function parseStartTime(value) {
    if (!value) return 0; if (/^\d+(?:\.\d+)?$/.test(value)) return Number(value);
    const match = String(value).toLowerCase().match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/);
    return match ? (Number(match[1]) || 0) * 3600 + (Number(match[2]) || 0) * 60 + (Number(match[3]) || 0) : 0;
  }
  function parseYouTubeUrl(raw) {
    let parsed; try { parsed = new URL(raw); } catch { return null; }
    const host = parsed.hostname.toLowerCase().replace(/^www\./, ''); let id = '';
    if (host === 'youtu.be') id = parsed.pathname.split('/').filter(Boolean)[0] || '';
    else if (['youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(host)) {
      if (parsed.pathname === '/watch') id = parsed.searchParams.get('v') || '';
      else { const parts = parsed.pathname.split('/').filter(Boolean); if (['shorts', 'embed', 'live'].includes(parts[0])) id = parts[1] || ''; }
    } else if (host === 'youtube-nocookie.com') { const parts = parsed.pathname.split('/').filter(Boolean); if (parts[0] === 'embed') id = parts[1] || ''; }
    else return null;
    if (!/^[A-Za-z0-9_-]{11}$/.test(id)) throw new Error('youtube-id');
    return { id, start: parseStartTime(parsed.searchParams.get('t') || parsed.searchParams.get('start') || '') };
  }
  function loadYouTubeApi() {
    if (window.YT && window.YT.Player) return Promise.resolve(window.YT); if (youtubeApiPromise) return youtubeApiPromise;
    youtubeApiPromise = new Promise((resolve, reject) => {
      const previousReady = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { if (typeof previousReady === 'function') previousReady(); resolve(window.YT); };
      const script = document.createElement('script'); script.src = 'https://www.youtube.com/iframe_api'; script.async = true;
      script.onerror = () => { youtubeApiPromise = null; reject(new Error('youtube-api')); }; document.head.appendChild(script);
    }); return youtubeApiPromise;
  }
  async function loadYouTubeSource(video) {
    resetSource(); hideMessage(); const loadId = ++state.loadId; state.mode = 'youtube';
    els.loading.hidden = false; setStatus('LOADING YOUTUBE'); els.sourceName.textContent = `YOUTUBE · ${video.id}`;
    try {
      const YT = await loadYouTubeApi(); if (loadId !== state.loadId) return; els.youtubeLayer.hidden = false; els.canvas.hidden = true;
      state.youtubePlayer = new YT.Player('youtubePlayer', {
        width: '100%', height: '100%', videoId: video.id,
        playerVars: { playsinline: 1, controls: 1, rel: 0, origin: location.origin, start: Math.floor(video.start) },
        events: {
          onReady: event => {
            if (loadId !== state.loadId) return; state.ready = true; els.loading.hidden = true; els.empty.hidden = true; els.frameReadout.hidden = false; setControls(true);
            event.target.setPlaybackRate(1); if (video.start > 0) event.target.seekTo(video.start, true); event.target.pauseVideo(); updateReadout(video.start); updatePlayButton();
          },
          onStateChange: event => {
            if (loadId !== state.loadId || !state.ready) return; if (event.data === 1) startYoutubeTimer(); else { stopYoutubeTimer(); updateReadout(); }
            if (event.data === 3) setStatus('BUFFERING'); else updatePlayButton();
          },
          onError: event => {
            if (loadId !== state.loadId) return; state.ready = false; els.loading.hidden = true; setControls(false); setStatus('YOUTUBE ERROR', true);
            showMessage(event.data === 101 || event.data === 150 ? '该视频禁止在其他网页嵌入播放。' : 'YouTube 无法播放这个视频；它可能是私密、已删除或受地区限制。');
          }
        }
      });
    } catch { if (loadId !== state.loadId) return; els.loading.hidden = true; setControls(false); setStatus('YOUTUBE ERROR', true); showMessage('无法连接 YouTube 播放器。请检查网络或内容拦截设置。'); }
  }
  function validateMP4Url(raw) {
    const parsed = new URL(raw); if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('protocol');
    if (location.protocol === 'https:' && parsed.protocol === 'http:') throw new Error('mixed-content'); return parsed.href;
  }
  function seekCanvasByTime(seconds) {
    let low = 0, high = state.presentation.length - 1;
    while (low < high) { const mid = Math.floor((low + high) / 2); if (state.presentation[mid].cts / state.presentation[mid].timescale < seconds) low = mid + 1; else high = mid; }
    renderCanvasFrame(low).catch(() => showMessage('无法解码所选帧。'));
  }
  function stepFrame(direction) {
    if (!state.ready) return;
    if (state.mode === 'canvas') { renderCanvasFrame(state.currentIndex + direction).catch(() => showMessage('无法解码所选帧。')); return; }
    state.youtubePlayer.pauseVideo(); stopYoutubeTimer(); const target = currentTimeValue() + direction / selectedFps(); state.youtubePlayer.seekTo(Math.max(0, target), true); updateReadout(target); setStatus('FRAME STEP');
  }
  function skip(seconds) {
    if (!state.ready) return; const target = Math.max(0, Math.min(durationValue(), currentTimeValue() + seconds));
    if (state.mode === 'canvas') seekCanvasByTime(target); else { state.youtubePlayer.seekTo(target, true); updateReadout(target); }
  }
  function togglePlayback() {
    if (!state.ready) return; hideMessage();
    if (state.mode === 'canvas') { state.playing ? stopCanvasPlayback() : startCanvasPlayback(); return; }
    try { isPlaying() ? state.youtubePlayer.pauseVideo() : state.youtubePlayer.playVideo(); } catch { showMessage('播放被浏览器或设备策略阻止。请直接点击 YouTube 播放器后再试。'); }
    window.setTimeout(updatePlayButton, 80);
  }

  els.form.addEventListener('submit', event => {
    event.preventDefault(); hideMessage(); const raw = els.url.value.trim();
    try { const youtube = parseYouTubeUrl(raw); if (youtube) { loadYouTubeSource(youtube); return; } const url = validateMP4Url(raw); loadCanvasSource(url, sourceName(url)); }
    catch (error) {
      if (error.message === 'youtube-id') showMessage('这个 YouTube 链接缺少有效的视频 ID。');
      else if (error.message === 'mixed-content') showMessage('HTTPS 页面不能读取 HTTP 文件，请改用 HTTPS 地址。');
      else showMessage('请输入完整的 YouTube 链接或 MP4 直链。');
    }
  });
  els.file.addEventListener('change', () => {
    const file = els.file.files && els.file.files[0]; if (!file) return; loadCanvasSource(file, file.name);
    els.url.value = ''; els.clearUrl.hidden = true; els.file.value = '';
  });
  els.url.addEventListener('input', () => { els.clearUrl.hidden = !els.url.value; });
  els.clearUrl.addEventListener('click', () => { els.url.value = ''; els.clearUrl.hidden = true; els.url.focus(); });
  els.prev.addEventListener('click', () => stepFrame(-1)); els.next.addEventListener('click', () => stepFrame(1)); els.play.addEventListener('click', togglePlayback);
  els.timeline.addEventListener('input', () => {
    if (!state.ready || durationValue() <= 0) return; const target = Number(els.timeline.value) / 1000 * durationValue();
    if (state.mode === 'canvas') seekCanvasByTime(target); else { state.youtubePlayer.seekTo(target, true); updateReadout(target); }
  });
  els.rate.addEventListener('change', () => { if (state.mode === 'youtube') { try { state.youtubePlayer.setPlaybackRate(Number(els.rate.value) || 1); } catch {} } });
  els.fps.addEventListener('change', () => updateReadout());
  els.mute.addEventListener('click', () => {
    if (state.mode !== 'youtube') return; const muted = !state.youtubePlayer.isMuted(); muted ? state.youtubePlayer.mute() : state.youtubePlayer.unMute();
    els.mute.classList.toggle('muted', muted); els.mute.setAttribute('aria-label', muted ? '取消静音' : '静音');
  });
  els.fullscreen.addEventListener('click', async () => { try { if (document.fullscreenElement) await document.exitFullscreen(); else await els.stage.requestFullscreen(); } catch { showMessage('当前浏览器不允许进入全屏模式。', 'info'); } });
  document.addEventListener('keydown', event => {
    if (event.target.matches('input, select, button')) return;
    if (event.code === 'Space') { event.preventDefault(); togglePlayback(); }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); stepFrame(-1); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); stepFrame(1); }
    else if (event.key.toLowerCase() === 'j') skip(-5); else if (event.key.toLowerCase() === 'l') skip(5);
    else if (event.key.toLowerCase() === 'm' && state.mode === 'youtube') els.mute.click(); else if (event.key.toLowerCase() === 'f') els.fullscreen.click();
  });
  resetSource();
})();
