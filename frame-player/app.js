(() => {
  'use strict';

  const els = {
    form: document.getElementById('urlForm'),
    url: document.getElementById('videoUrl'),
    clearUrl: document.getElementById('clearUrl'),
    file: document.getElementById('fileInput'),
    video: document.getElementById('sourceVideo'),
    canvas: document.getElementById('frameCanvas'),
    stage: document.getElementById('stage'),
    empty: document.getElementById('emptyState'),
    loading: document.getElementById('loading'),
    status: document.getElementById('stageStatus'),
    frameReadout: document.getElementById('frameReadout'),
    currentFrame: document.getElementById('currentFrame'),
    timeline: document.getElementById('timeline'),
    currentTime: document.getElementById('currentTime'),
    duration: document.getElementById('duration'),
    sourceName: document.getElementById('sourceName'),
    prev: document.getElementById('prevFrame'),
    play: document.getElementById('playPause'),
    next: document.getElementById('nextFrame'),
    rate: document.getElementById('playbackRate'),
    fps: document.getElementById('fps'),
    mute: document.getElementById('mute'),
    fullscreen: document.getElementById('fullscreen'),
    message: document.getElementById('message')
  };

  const ctx = els.canvas.getContext('2d', { alpha: false });
  const state = {
    ready: false,
    objectUrl: null,
    frameCallback: 0,
    animationFrame: 0,
    loadId: 0,
    sourceLabel: ''
  };

  const controls = [els.prev, els.play, els.next, els.rate, els.mute, els.fullscreen, els.timeline];

  function setControls(enabled) {
    controls.forEach(control => { control.disabled = !enabled; });
  }

  function setStatus(label, isError = false) {
    els.status.textContent = label;
    els.status.classList.toggle('error', isError);
  }

  function showMessage(text, kind = 'error') {
    els.message.textContent = text;
    els.message.className = `message${kind === 'info' ? ' info' : ''}`;
    els.message.hidden = false;
  }

  function hideMessage() {
    els.message.hidden = true;
    els.message.textContent = '';
  }

  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '00:00.000';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const millis = Math.floor((seconds % 1) * 1000);
    const base = `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
    return hours ? `${String(hours).padStart(2, '0')}:${base}` : base;
  }

  function selectedFps() {
    return Math.max(1, Number(els.fps.value) || 30);
  }

  function updateReadout(mediaTime = els.video.currentTime) {
    if (!state.ready) return;
    const duration = els.video.duration;
    const progress = duration > 0 ? Math.min(1000, Math.max(0, (mediaTime / duration) * 1000)) : 0;
    els.timeline.value = String(progress);
    els.timeline.style.setProperty('--progress', `${progress / 10}%`);
    els.currentTime.textContent = formatTime(mediaTime);
    els.duration.textContent = formatTime(duration);
    els.currentFrame.textContent = String(Math.max(0, Math.round(mediaTime * selectedFps()))).padStart(6, '0');
  }

  function sizeCanvas() {
    const width = els.video.videoWidth || 1280;
    const height = els.video.videoHeight || 720;
    if (els.canvas.width !== width || els.canvas.height !== height) {
      els.canvas.width = width;
      els.canvas.height = height;
    }
  }

  function drawFrame(mediaTime = els.video.currentTime) {
    if (!state.ready || els.video.readyState < 2) return;
    sizeCanvas();
    try {
      ctx.fillStyle = '#050507';
      ctx.fillRect(0, 0, els.canvas.width, els.canvas.height);
      ctx.drawImage(els.video, 0, 0, els.canvas.width, els.canvas.height);
      updateReadout(mediaTime);
    } catch (error) {
      setStatus('DISPLAY ERROR', true);
      showMessage('浏览器无法把这个来源绘制到逐帧画布。请尝试本地视频或允许跨域访问的媒体直链。');
    }
  }

  function cancelFrameLoop() {
    if (state.frameCallback && els.video.cancelVideoFrameCallback) {
      els.video.cancelVideoFrameCallback(state.frameCallback);
    }
    if (state.animationFrame) cancelAnimationFrame(state.animationFrame);
    state.frameCallback = 0;
    state.animationFrame = 0;
  }

  function startFrameLoop() {
    cancelFrameLoop();
    if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
      const onFrame = (_now, metadata) => {
        drawFrame(metadata.mediaTime);
        if (!els.video.paused && !els.video.ended) {
          state.frameCallback = els.video.requestVideoFrameCallback(onFrame);
        }
      };
      state.frameCallback = els.video.requestVideoFrameCallback(onFrame);
      return;
    }
    const onAnimationFrame = () => {
      drawFrame();
      if (!els.video.paused && !els.video.ended) state.animationFrame = requestAnimationFrame(onAnimationFrame);
    };
    state.animationFrame = requestAnimationFrame(onAnimationFrame);
  }

  function updatePlayButton() {
    const playing = state.ready && !els.video.paused && !els.video.ended;
    els.play.classList.toggle('playing', playing);
    els.play.setAttribute('aria-label', playing ? '暂停' : '播放');
    setStatus(playing ? 'PLAYING' : state.ready ? 'PAUSED' : 'READY');
  }

  function sourceName(url) {
    try {
      const parsed = new URL(url);
      const name = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || parsed.hostname);
      return name.length > 50 ? `${name.slice(0, 47)}…` : name;
    } catch {
      return 'REMOTE VIDEO';
    }
  }

  function resetSource() {
    state.loadId++;
    state.ready = false;
    cancelFrameLoop();
    els.video.pause();
    els.video.removeAttribute('src');
    els.video.load();
    if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
    state.objectUrl = null;
    setControls(false);
    els.frameReadout.hidden = true;
    els.empty.hidden = false;
    els.loading.hidden = true;
    els.canvas.width = 300;
    els.canvas.height = 150;
    ctx.fillStyle = '#060608';
    ctx.fillRect(0, 0, els.canvas.width, els.canvas.height);
    els.currentTime.textContent = '00:00.000';
    els.duration.textContent = '00:00.000';
    els.sourceName.textContent = 'NO SOURCE';
    els.timeline.value = '0';
    els.timeline.style.setProperty('--progress', '0%');
    updatePlayButton();
  }

  function loadSource(url, label, objectUrl = null) {
    resetSource();
    hideMessage();
    const thisLoad = ++state.loadId;
    state.objectUrl = objectUrl;
    state.sourceLabel = label;
    els.loading.hidden = false;
    setStatus('LOADING');
    els.sourceName.textContent = label;
    els.video.src = url;

    const onReady = () => {
      if (thisLoad !== state.loadId) return;
      state.ready = true;
      els.loading.hidden = true;
      els.empty.hidden = true;
      els.frameReadout.hidden = false;
      setControls(true);
      els.rate.value = '1';
      els.video.playbackRate = 1;
      drawFrame(0);
      updatePlayButton();
    };

    els.video.addEventListener('loadeddata', onReady, { once: true });
    els.video.addEventListener('error', () => {
      if (thisLoad !== state.loadId) return;
      state.ready = false;
      els.loading.hidden = true;
      setControls(false);
      setStatus('LOAD ERROR', true);
      showMessage('无法加载这个地址。请确认它是 HTTPS 视频直链、无需登录，并且服务器允许浏览器访问；也可以选择本地视频测试。');
    }, { once: true });
    els.video.load();
  }

  function validateUrl(raw) {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('protocol');
    if (location.protocol === 'https:' && parsed.protocol === 'http:') throw new Error('mixed-content');
    const host = parsed.hostname.toLowerCase();
    if (/^(www\.)?(youtube\.com|youtu\.be|bilibili\.com|b23\.tv)$/.test(host)) throw new Error('page-url');
    return parsed.href;
  }

  async function togglePlayback() {
    if (!state.ready) return;
    hideMessage();
    if (els.video.paused || els.video.ended) {
      if (els.video.ended) els.video.currentTime = 0;
      try {
        await els.video.play();
        startFrameLoop();
      } catch {
        showMessage('播放被浏览器或设备策略阻止。请直接点击播放键，并确保设备允许当前状态下播放媒体。');
      }
    } else {
      els.video.pause();
      cancelFrameLoop();
      drawFrame();
    }
    updatePlayButton();
  }

  function stepFrame(direction) {
    if (!state.ready) return;
    els.video.pause();
    cancelFrameLoop();
    const target = els.video.currentTime + direction / selectedFps();
    els.video.currentTime = Math.min(Math.max(0, target), els.video.duration || target);
    updatePlayButton();
  }

  function skip(seconds) {
    if (!state.ready) return;
    els.video.currentTime = Math.min(Math.max(0, els.video.currentTime + seconds), els.video.duration || 0);
  }

  els.form.addEventListener('submit', event => {
    event.preventDefault();
    try {
      const url = validateUrl(els.url.value.trim());
      loadSource(url, sourceName(url));
    } catch (error) {
      if (error.message === 'page-url') {
        showMessage('这是视频网站页面，不是视频文件直链。GitHub Pages 无法解析 YouTube 或 Bilibili 页面；请使用可直接打开的 MP4/WebM 地址或本地视频。');
      } else if (error.message === 'mixed-content') {
        showMessage('HTTPS 页面不能加载 HTTP 视频，请改用 HTTPS 媒体地址。');
      } else {
        showMessage('请输入完整、有效的视频网址，例如 https://example.com/video.mp4。');
      }
    }
  });

  els.file.addEventListener('change', () => {
    const file = els.file.files && els.file.files[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    loadSource(url, file.name, url);
    els.url.value = '';
    els.clearUrl.hidden = true;
    els.file.value = '';
  });

  els.url.addEventListener('input', () => { els.clearUrl.hidden = !els.url.value; });
  els.clearUrl.addEventListener('click', () => {
    els.url.value = '';
    els.clearUrl.hidden = true;
    els.url.focus();
  });
  els.prev.addEventListener('click', () => stepFrame(-1));
  els.next.addEventListener('click', () => stepFrame(1));
  els.play.addEventListener('click', togglePlayback);
  els.video.addEventListener('play', updatePlayButton);
  els.video.addEventListener('pause', updatePlayButton);
  els.video.addEventListener('ended', () => { cancelFrameLoop(); drawFrame(); updatePlayButton(); });
  els.video.addEventListener('seeked', () => drawFrame());
  els.video.addEventListener('waiting', () => { if (state.ready) setStatus('BUFFERING'); });
  els.video.addEventListener('playing', () => { updatePlayButton(); startFrameLoop(); });

  els.timeline.addEventListener('input', () => {
    if (!state.ready || !Number.isFinite(els.video.duration)) return;
    els.video.currentTime = (Number(els.timeline.value) / 1000) * els.video.duration;
    updateReadout();
  });

  els.rate.addEventListener('change', () => { els.video.playbackRate = Number(els.rate.value) || 1; });
  els.fps.addEventListener('change', () => updateReadout());
  els.mute.addEventListener('click', () => {
    els.video.muted = !els.video.muted;
    els.mute.classList.toggle('muted', els.video.muted);
    els.mute.setAttribute('aria-label', els.video.muted ? '取消静音' : '静音');
  });
  els.fullscreen.addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await els.stage.requestFullscreen();
    } catch {
      showMessage('当前浏览器不允许进入全屏模式。', 'info');
    }
  });

  document.addEventListener('keydown', event => {
    if (event.target.matches('input, select, button')) return;
    if (event.code === 'Space') { event.preventDefault(); togglePlayback(); }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); stepFrame(-1); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); stepFrame(1); }
    else if (event.key.toLowerCase() === 'j') skip(-5);
    else if (event.key.toLowerCase() === 'l') skip(5);
    else if (event.key.toLowerCase() === 'm') els.mute.click();
    else if (event.key.toLowerCase() === 'f') els.fullscreen.click();
  });

  resetSource();
})();
