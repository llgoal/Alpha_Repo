(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const els = {
    form: $('urlForm'), url: $('videoUrl'), clearUrl: $('clearUrl'), file: $('fileInput'),
    video: $('sourceVideo'), canvas: $('frameCanvas'), youtubeLayer: $('youtubeLayer'), stage: $('stage'),
    empty: $('emptyState'), loading: $('loading'), status: $('stageStatus'), frameReadout: $('frameReadout'),
    currentFrame: $('currentFrame'), timeline: $('timeline'), currentTime: $('currentTime'), duration: $('duration'),
    sourceName: $('sourceName'), prev: $('prevFrame'), play: $('playPause'), next: $('nextFrame'),
    rate: $('playbackRate'), fps: $('fps'), mute: $('mute'), fullscreen: $('fullscreen'), message: $('message')
  };
  const ctx = els.canvas.getContext('2d', { alpha: false });
  const state = { ready: false, mode: null, objectUrl: null, frameCallback: 0, animationFrame: 0, youtubePlayer: null, youtubeTimer: 0, loadId: 0 };
  let youtubeApiPromise = null;
  const controls = [els.prev, els.play, els.next, els.rate, els.mute, els.fullscreen, els.timeline];

  function setControls(enabled) { controls.forEach(control => { control.disabled = !enabled; }); }
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
  function currentTimeValue() { try { return state.mode === 'youtube' ? Number(state.youtubePlayer.getCurrentTime()) || 0 : Number(els.video.currentTime) || 0; } catch { return 0; } }
  function durationValue() { try { return state.mode === 'youtube' ? Number(state.youtubePlayer.getDuration()) || 0 : Number(els.video.duration) || 0; } catch { return 0; } }
  function isPlaying() { return state.ready && (state.mode === 'youtube' ? youtubeState() === 1 : !els.video.paused && !els.video.ended); }

  function updateReadout(mediaTime = currentTimeValue()) {
    if (!state.ready) return;
    const duration = durationValue();
    const progress = duration > 0 ? Math.min(1000, Math.max(0, mediaTime / duration * 1000)) : 0;
    els.timeline.value = String(progress); els.timeline.style.setProperty('--progress', `${progress / 10}%`);
    els.currentTime.textContent = formatTime(mediaTime); els.duration.textContent = formatTime(duration);
    els.currentFrame.textContent = String(Math.max(0, Math.round(mediaTime * selectedFps()))).padStart(6, '0');
  }
  function sizeCanvas() {
    const width = els.video.videoWidth || 1280, height = els.video.videoHeight || 720;
    if (els.canvas.width !== width || els.canvas.height !== height) { els.canvas.width = width; els.canvas.height = height; }
  }
  function drawFrame(mediaTime = els.video.currentTime) {
    if (!state.ready || state.mode !== 'direct' || els.video.readyState < 2) return;
    sizeCanvas();
    try {
      ctx.fillStyle = '#050507'; ctx.fillRect(0, 0, els.canvas.width, els.canvas.height);
      ctx.drawImage(els.video, 0, 0, els.canvas.width, els.canvas.height); updateReadout(mediaTime);
    } catch { setStatus('DISPLAY ERROR', true); showMessage('浏览器无法把这个来源绘制到逐帧画布。请尝试本地视频或允许跨域访问的媒体直链。'); }
  }
  function cancelFrameLoop() {
    if (state.frameCallback && els.video.cancelVideoFrameCallback) els.video.cancelVideoFrameCallback(state.frameCallback);
    if (state.animationFrame) cancelAnimationFrame(state.animationFrame);
    state.frameCallback = 0; state.animationFrame = 0;
  }
  function stopYoutubeTimer() { if (state.youtubeTimer) clearInterval(state.youtubeTimer); state.youtubeTimer = 0; }
  function startYoutubeTimer() { stopYoutubeTimer(); state.youtubeTimer = window.setInterval(() => { if (state.mode === 'youtube' && state.ready) updateReadout(); }, 150); }
  function startFrameLoop() {
    cancelFrameLoop();
    if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
      const onFrame = (_now, metadata) => { drawFrame(metadata.mediaTime); if (!els.video.paused && !els.video.ended) state.frameCallback = els.video.requestVideoFrameCallback(onFrame); };
      state.frameCallback = els.video.requestVideoFrameCallback(onFrame); return;
    }
    const loop = () => { drawFrame(); if (!els.video.paused && !els.video.ended) state.animationFrame = requestAnimationFrame(loop); };
    state.animationFrame = requestAnimationFrame(loop);
  }
  function updatePlayButton() {
    const playing = isPlaying(); els.play.classList.toggle('playing', playing);
    els.play.setAttribute('aria-label', playing ? '暂停' : '播放'); setStatus(playing ? 'PLAYING' : state.ready ? 'PAUSED' : 'READY');
  }
  function sourceName(url) {
    try { const parsed = new URL(url); const name = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || parsed.hostname); return name.length > 50 ? `${name.slice(0, 47)}…` : name; }
    catch { return 'REMOTE VIDEO'; }
  }
  function parseStartTime(value) {
    if (!value) return 0;
    if (/^\d+(?:\.\d+)?$/.test(value)) return Number(value);
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
    if (window.YT && window.YT.Player) return Promise.resolve(window.YT);
    if (youtubeApiPromise) return youtubeApiPromise;
    youtubeApiPromise = new Promise((resolve, reject) => {
      const previousReady = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { if (typeof previousReady === 'function') previousReady(); resolve(window.YT); };
      const script = document.createElement('script'); script.src = 'https://www.youtube.com/iframe_api'; script.async = true;
      script.onerror = () => { youtubeApiPromise = null; reject(new Error('youtube-api')); }; document.head.appendChild(script);
    });
    return youtubeApiPromise;
  }
  function resetSource() {
    state.loadId++; state.ready = false; state.mode = null; cancelFrameLoop(); stopYoutubeTimer();
    els.video.pause(); els.video.removeAttribute('src'); els.video.load();
    if (state.youtubePlayer) { try { state.youtubePlayer.destroy(); } catch {} state.youtubePlayer = null; }
    els.youtubeLayer.hidden = true; els.youtubeLayer.innerHTML = '<div id="youtubePlayer"></div>';
    if (state.objectUrl) URL.revokeObjectURL(state.objectUrl); state.objectUrl = null; setControls(false);
    els.frameReadout.hidden = true; els.empty.hidden = false; els.loading.hidden = true; els.canvas.hidden = false;
    els.canvas.width = 300; els.canvas.height = 150; ctx.fillStyle = '#060608'; ctx.fillRect(0, 0, 300, 150);
    els.currentTime.textContent = '00:00.000'; els.duration.textContent = '00:00.000'; els.sourceName.textContent = 'NO SOURCE';
    els.timeline.value = '0'; els.timeline.style.setProperty('--progress', '0%'); els.rate.value = '1'; els.mute.classList.remove('muted'); updatePlayButton();
  }
  function loadDirectSource(url, label, objectUrl = null) {
    resetSource(); hideMessage(); const thisLoad = ++state.loadId; state.mode = 'direct'; state.objectUrl = objectUrl;
    els.loading.hidden = false; setStatus('LOADING'); els.sourceName.textContent = label; els.video.src = url;
    els.video.addEventListener('loadeddata', () => {
      if (thisLoad !== state.loadId) return; state.ready = true; els.loading.hidden = true; els.empty.hidden = true;
      els.frameReadout.hidden = false; setControls(true); els.video.playbackRate = 1; drawFrame(0); updatePlayButton();
    }, { once: true });
    els.video.addEventListener('error', () => {
      if (thisLoad !== state.loadId) return; state.ready = false; els.loading.hidden = true; setControls(false); setStatus('LOAD ERROR', true);
      showMessage('无法加载这个地址。请确认它是 HTTPS 视频直链、无需登录，并且服务器允许浏览器访问；也可以选择本地视频测试。');
    }, { once: true }); els.video.load();
  }
  async function loadYouTubeSource(video) {
    resetSource(); hideMessage(); const thisLoad = ++state.loadId; state.mode = 'youtube';
    els.loading.hidden = false; setStatus('LOADING YOUTUBE'); els.sourceName.textContent = `YOUTUBE · ${video.id}`;
    try {
      const YT = await loadYouTubeApi(); if (thisLoad !== state.loadId) return;
      els.youtubeLayer.hidden = false; els.canvas.hidden = true;
      state.youtubePlayer = new YT.Player('youtubePlayer', {
        width: '100%', height: '100%', videoId: video.id,
        playerVars: { playsinline: 1, controls: 1, rel: 0, origin: location.origin, start: Math.floor(video.start) },
        events: {
          onReady: event => {
            if (thisLoad !== state.loadId) return; state.ready = true; els.loading.hidden = true; els.empty.hidden = true;
            els.frameReadout.hidden = false; setControls(true); event.target.setPlaybackRate(1);
            if (video.start > 0) event.target.seekTo(video.start, true); event.target.pauseVideo(); updateReadout(video.start); updatePlayButton();
          },
          onStateChange: event => {
            if (thisLoad !== state.loadId || !state.ready) return;
            if (event.data === 1) startYoutubeTimer(); else { stopYoutubeTimer(); updateReadout(); }
            if (event.data === 3) setStatus('BUFFERING'); else updatePlayButton();
          },
          onError: event => {
            if (thisLoad !== state.loadId) return; state.ready = false; els.loading.hidden = true; setControls(false); setStatus('YOUTUBE ERROR', true);
            const blocked = event.data === 101 || event.data === 150;
            showMessage(blocked ? '该视频禁止在其他网页嵌入播放。请换一个允许嵌入的 YouTube 视频。' : 'YouTube 无法播放这个视频；它可能是私密、已删除、受地区限制或链接无效。');
          }
        }
      });
    } catch {
      if (thisLoad !== state.loadId) return; state.ready = false; els.loading.hidden = true; setControls(false); setStatus('YOUTUBE ERROR', true);
      showMessage('无法连接 YouTube 播放器。请检查网络或浏览器的内容拦截设置。');
    }
  }
  function validateDirectUrl(raw) {
    const parsed = new URL(raw); if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('protocol');
    if (location.protocol === 'https:' && parsed.protocol === 'http:') throw new Error('mixed-content');
    const host = parsed.hostname.toLowerCase().replace(/^www\./, ''); if (host === 'bilibili.com' || host === 'b23.tv') throw new Error('page-url'); return parsed.href;
  }
  async function togglePlayback() {
    if (!state.ready) return; hideMessage();
    if (state.mode === 'youtube') {
      try { isPlaying() ? state.youtubePlayer.pauseVideo() : state.youtubePlayer.playVideo(); } catch { showMessage('播放被浏览器或设备策略阻止。请直接点击 YouTube 播放器后再试。'); }
      window.setTimeout(updatePlayButton, 80); return;
    }
    if (els.video.paused || els.video.ended) {
      if (els.video.ended) els.video.currentTime = 0;
      try { await els.video.play(); startFrameLoop(); } catch { showMessage('播放被浏览器或设备策略阻止。请直接点击播放键，并确保设备允许当前状态下播放媒体。'); }
    } else { els.video.pause(); cancelFrameLoop(); drawFrame(); } updatePlayButton();
  }
  function seekTo(seconds) {
    const duration = durationValue(), target = Math.min(Math.max(0, seconds), duration || Math.max(0, seconds));
    if (state.mode === 'youtube') { state.youtubePlayer.seekTo(target, true); updateReadout(target); } else els.video.currentTime = target;
  }
  function stepFrame(direction) {
    if (!state.ready) return;
    if (state.mode === 'youtube') { state.youtubePlayer.pauseVideo(); stopYoutubeTimer(); } else { els.video.pause(); cancelFrameLoop(); }
    seekTo(currentTimeValue() + direction / selectedFps()); setStatus('FRAME STEP'); window.setTimeout(updatePlayButton, 140);
  }
  function skip(seconds) { if (state.ready) seekTo(currentTimeValue() + seconds); }

  els.form.addEventListener('submit', event => {
    event.preventDefault(); hideMessage(); const raw = els.url.value.trim();
    try { const youtube = parseYouTubeUrl(raw); if (youtube) { loadYouTubeSource(youtube); return; } const url = validateDirectUrl(raw); loadDirectSource(url, sourceName(url)); }
    catch (error) {
      if (error.message === 'youtube-id') showMessage('这个 YouTube 链接缺少有效的视频 ID。请复制完整的分享链接。');
      else if (error.message === 'page-url') showMessage('目前支持 YouTube 页面链接；其他视频网站请使用可直接打开的 MP4/WebM 地址。');
      else if (error.message === 'mixed-content') showMessage('HTTPS 页面不能加载 HTTP 视频，请改用 HTTPS 媒体地址。');
      else showMessage('请输入完整的 YouTube 链接或视频网址。');
    }
  });
  els.file.addEventListener('change', () => {
    const file = els.file.files && els.file.files[0]; if (!file) return; const url = URL.createObjectURL(file);
    loadDirectSource(url, file.name, url); els.url.value = ''; els.clearUrl.hidden = true; els.file.value = '';
  });
  els.url.addEventListener('input', () => { els.clearUrl.hidden = !els.url.value; });
  els.clearUrl.addEventListener('click', () => { els.url.value = ''; els.clearUrl.hidden = true; els.url.focus(); });
  els.prev.addEventListener('click', () => stepFrame(-1)); els.next.addEventListener('click', () => stepFrame(1)); els.play.addEventListener('click', togglePlayback);
  els.video.addEventListener('play', updatePlayButton); els.video.addEventListener('pause', updatePlayButton);
  els.video.addEventListener('ended', () => { cancelFrameLoop(); drawFrame(); updatePlayButton(); });
  els.video.addEventListener('seeked', () => drawFrame()); els.video.addEventListener('waiting', () => { if (state.ready) setStatus('BUFFERING'); });
  els.video.addEventListener('playing', () => { updatePlayButton(); startFrameLoop(); });
  els.timeline.addEventListener('input', () => { if (!state.ready || durationValue() <= 0) return; seekTo(Number(els.timeline.value) / 1000 * durationValue()); updateReadout(); });
  els.rate.addEventListener('change', () => { const rate = Number(els.rate.value) || 1; if (state.mode === 'youtube') { try { state.youtubePlayer.setPlaybackRate(rate); } catch {} } else els.video.playbackRate = rate; });
  els.fps.addEventListener('change', () => updateReadout());
  els.mute.addEventListener('click', () => {
    let muted; if (state.mode === 'youtube') { muted = !state.youtubePlayer.isMuted(); muted ? state.youtubePlayer.mute() : state.youtubePlayer.unMute(); }
    else { els.video.muted = !els.video.muted; muted = els.video.muted; }
    els.mute.classList.toggle('muted', muted); els.mute.setAttribute('aria-label', muted ? '取消静音' : '静音');
  });
  els.fullscreen.addEventListener('click', async () => { try { if (document.fullscreenElement) await document.exitFullscreen(); else await els.stage.requestFullscreen(); } catch { showMessage('当前浏览器不允许进入全屏模式。', 'info'); } });
  document.addEventListener('keydown', event => {
    if (event.target.matches('input, select, button')) return;
    if (event.code === 'Space') { event.preventDefault(); togglePlayback(); }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); stepFrame(-1); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); stepFrame(1); }
    else if (event.key.toLowerCase() === 'j') skip(-5); else if (event.key.toLowerCase() === 'l') skip(5);
    else if (event.key.toLowerCase() === 'm') els.mute.click(); else if (event.key.toLowerCase() === 'f') els.fullscreen.click();
  });
  resetSource();
})();
