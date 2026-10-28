'use strict';

const els = {
  viewport: document.getElementById('viewport'),
  stage: document.getElementById('stage'),
  canvas: document.getElementById('canvas'),
  image: document.getElementById('image'),
  video: document.getElementById('video'),
  emptyState: document.getElementById('empty-state'),
  dropOverlay: document.getElementById('drop-overlay'),
  busyOverlay: document.getElementById('busy-overlay'),
  busyText: document.getElementById('busy-text'),
  progressBar: document.getElementById('progress-bar'),
  progressWrap: document.querySelector('.progress'),
  toast: document.getElementById('toast'),
  fileName: document.getElementById('file-name'),
  fileCounter: document.getElementById('file-counter'),
  zoomLabel: document.getElementById('zoom-label'),
  btn: {
    open: document.getElementById('btn-open'),
    prev: document.getElementById('btn-prev'),
    next: document.getElementById('btn-next'),
    zoomIn: document.getElementById('btn-zoom-in'),
    zoomOut: document.getElementById('btn-zoom-out'),
    fit: document.getElementById('btn-fit'),
    one: document.getElementById('btn-100'),
    rotate: document.getElementById('btn-rotate'),
    savePng: document.getElementById('btn-save-png'),
    saveJpg: document.getElementById('btn-save-jpg'),
    folder: document.getElementById('btn-folder')
  }
};

const state = {
  currentPath: null,
  currentType: null, // 'raster' | 'image' | 'video'
  files: [],
  index: -1,
  zoom: 1,
  fitMode: true,
  rotation: 0,
  panX: 0,
  panY: 0,
  mediaW: 0,
  mediaH: 0,
  loadToken: 0,
  converting: false,
  toastTimer: null
};

// Keeps the neighbours of a native image decoded, so arrow-key browsing shows them instantly.
const preloaded = new Map();

// ---------- helpers ----------

function showToast(message, kind = 'error', ms = 5000) {
  els.toast.textContent = message;
  els.toast.className = kind === 'info' ? 'info' : '';
  els.toast.hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => { els.toast.hidden = true; }, ms);
}

function setBusy(text, { determinate = false } = {}) {
  if (text === null) {
    els.busyOverlay.hidden = true;
    return;
  }
  els.busyText.textContent = text;
  els.progressBar.style.width = '0%';
  els.progressWrap.classList.toggle('indeterminate', !determinate);
  els.busyOverlay.hidden = false;
}

function activeMediaEl() {
  if (state.currentType === 'raster') return els.canvas;
  if (state.currentType === 'image') return els.image;
  if (state.currentType === 'video') return els.video;
  return null;
}

function hideAllMedia() {
  els.canvas.hidden = true;
  els.image.hidden = true;
  els.image.removeAttribute('src');
  els.video.hidden = true;
  els.video.pause();
  els.video.removeAttribute('src');
  els.video.load();
}

function updateButtons() {
  const has = !!state.currentPath;
  const isImage = has && state.currentType !== 'video';
  els.btn.prev.disabled = !has || state.files.length < 2;
  els.btn.next.disabled = !has || state.files.length < 2;
  els.btn.zoomIn.disabled = !has;
  els.btn.zoomOut.disabled = !has;
  els.btn.fit.disabled = !has;
  els.btn.one.disabled = !has;
  els.btn.rotate.disabled = !isImage;
  els.btn.savePng.disabled = !isImage;
  els.btn.saveJpg.disabled = !isImage;
  els.btn.folder.disabled = !has;
}

// ---------- zoom / pan / layout ----------

function fitZoom() {
  if (!state.mediaW || !state.mediaH) return 1;
  const vw = els.viewport.clientWidth - 24;
  const vh = els.viewport.clientHeight - 24;
  const rotated = state.rotation % 180 !== 0;
  const w = rotated ? state.mediaH : state.mediaW;
  const h = rotated ? state.mediaW : state.mediaH;
  return Math.min(vw / w, vh / h, 1);
}

function applyTransform() {
  const el = activeMediaEl();
  if (!el) return;
  const z = state.fitMode ? fitZoom() : state.zoom;
  els.stage.style.transform =
    `translate(-50%, -50%) translate(${state.panX}px, ${state.panY}px) scale(${z}) rotate(${state.rotation}deg)`;
  els.zoomLabel.textContent = Math.round(z * 100) + '%';
}

function resetView({ keepRotation = false } = {}) {
  state.zoom = 1;
  state.fitMode = true;
  state.panX = 0;
  state.panY = 0;
  if (!keepRotation) state.rotation = 0;
  applyTransform();
}

function setZoom(newZoom, pivot) {
  const oldZ = state.fitMode ? fitZoom() : state.zoom;
  const z = Math.max(0.02, Math.min(newZoom, 40));
  if (pivot) {
    // keep the point under the cursor stable while zooming
    const rect = els.viewport.getBoundingClientRect();
    const cx = rect.left + rect.width / 2 + state.panX;
    const cy = rect.top + rect.height / 2 + state.panY;
    state.panX += (pivot.x - cx) * (1 - z / oldZ);
    state.panY += (pivot.y - cy) * (1 - z / oldZ);
  }
  state.zoom = z;
  state.fitMode = false;
  applyTransform();
}

window.addEventListener('resize', applyTransform);

els.viewport.addEventListener('wheel', (e) => {
  if (!state.currentPath) return;
  if (state.currentType === 'video' && e.target === els.video) return;
  e.preventDefault();
  const current = state.fitMode ? fitZoom() : state.zoom;
  const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
  setZoom(current * factor, { x: e.clientX, y: e.clientY });
}, { passive: false });

let dragging = null;
els.viewport.addEventListener('mousedown', (e) => {
  if (!state.currentPath || e.button !== 0) return;
  if (state.currentType === 'video' && e.target === els.video) return;
  dragging = { x: e.clientX, y: e.clientY, panX: state.panX, panY: state.panY };
});
window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  state.panX = dragging.panX + (e.clientX - dragging.x);
  state.panY = dragging.panY + (e.clientY - dragging.y);
  applyTransform();
});
window.addEventListener('mouseup', () => { dragging = null; });

els.viewport.addEventListener('dblclick', (e) => {
  if (!state.currentPath) return;
  if (state.currentType === 'video' && e.target === els.video) return;
  if (state.fitMode) setZoom(1, { x: e.clientX, y: e.clientY });
  else resetView({ keepRotation: true });
});

// ---------- loading ----------

async function loadPath(filePath, { refreshSiblings = true } = {}) {
  const token = ++state.loadToken;
  // A conversion for the file we are leaving would only burn CPU now
  if (state.converting) {
    state.converting = false;
    window.api.cancelVideo();
  }
  setBusy('Se încarcă…');
  try {
    const info = await window.api.loadFile(filePath);
    if (token !== state.loadToken) return;

    hideAllMedia();
    state.currentPath = info.path;
    state.currentType = info.type;
    els.fileName.textContent = info.name;
    els.fileName.title = info.path;
    els.emptyState.hidden = true;

    if (info.type === 'raster') {
      const ctx = els.canvas.getContext('2d');
      els.canvas.width = info.width;
      els.canvas.height = info.height;
      // View the IPC buffer directly instead of copying tens of megabytes again
      const pixels = new Uint8ClampedArray(info.data.buffer, info.data.byteOffset, info.data.byteLength);
      const imgData = new ImageData(pixels, info.width, info.height);
      ctx.putImageData(imgData, 0, 0);
      state.mediaW = info.width;
      state.mediaH = info.height;
      els.canvas.hidden = false;
      resetView();
      setBusy(null);
    } else if (info.type === 'image') {
      await new Promise((resolve, reject) => {
        els.image.onload = resolve;
        els.image.onerror = () => reject(new Error('Imaginea nu a putut fi decodată'));
        els.image.src = info.url;
      });
      // Finish decoding before showing, so large photos do not appear in stripes
      await els.image.decode().catch(() => {});
      if (token !== state.loadToken) return;
      state.mediaW = els.image.naturalWidth;
      state.mediaH = els.image.naturalHeight;
      els.image.hidden = false;
      resetView();
      setBusy(null);
    } else if (info.type === 'video') {
      els.video.hidden = false;
      // Resolves once the video has metadata. A codec Chromium cannot decode sometimes still yields
      // metadata but no picture (videoWidth 0), so that counts as a failure unless allowEmpty.
      const tryPlay = (url, allowEmpty = false) => new Promise((resolve, reject) => {
        els.video.onloadedmetadata = () => {
          if (els.video.videoWidth > 0 || allowEmpty) resolve();
          else reject(new Error('no video track decoded'));
        };
        els.video.onerror = () => reject(new Error('playback failed'));
        els.video.src = url;
      });

      let played = false;
      if (!info.forceTranscode) {
        played = await tryPlay(info.url).then(() => true, () => false);
      }
      if (token !== state.loadToken) return;

      // Fallbacks: rewrap the stream into MP4 when the codec allows it (seconds), otherwise convert to H.264.
      for (const mode of ['auto', 'transcode']) {
        if (played) break;
        setBusy('Se pregătește video…', { determinate: true });
        state.converting = true;
        let prepared;
        try {
          prepared = await window.api.prepareVideo(info.path, mode);
        } finally {
          if (token === state.loadToken) state.converting = false;
        }
        if (token !== state.loadToken) return;
        const last = prepared.mode === 'transcode';
        try {
          await tryPlay(prepared.url, last);
          played = true;
        } catch (err) {
          if (last) throw new Error('Redarea video a eșuat chiar și după conversie');
        }
        if (token !== state.loadToken) return;
      }

      state.mediaW = els.video.videoWidth || 1280;
      state.mediaH = els.video.videoHeight || 720;
      els.video.width = state.mediaW;
      els.video.height = state.mediaH;
      resetView();
      setBusy(null);
      els.video.play().catch(() => { /* autoplay might be blocked; controls remain */ });
    }

    if (refreshSiblings) {
      const s = await window.api.siblings(info.path);
      if (token !== state.loadToken) return;
      state.files = s.files;
      state.index = s.index;
    }
    els.fileCounter.textContent =
      state.files.length > 1 ? `${state.index + 1} / ${state.files.length}` : '';
    updateButtons();
    prefetchNeighbours();
  } catch (err) {
    if (token !== state.loadToken) return;
    if (/cancelled/.test(String(err && err.message))) return;
    setBusy(null);
    showToast('Nu am putut deschide fișierul:\n' + (err.message || err));
    updateButtons();
  }
}

async function prefetchNeighbours() {
  if (state.files.length < 2) return;
  const n = state.files.length;
  const around = [...new Set([state.files[(state.index + 1) % n], state.files[(state.index - 1 + n) % n]])];
  // Main decodes HEIC/TIFF neighbours into its cache and returns URLs for the formats Chromium decodes itself
  const urls = await window.api.prefetch(around).catch(() => ({}));
  for (const [p, url] of Object.entries(urls)) {
    if (preloaded.has(p)) continue;
    const img = new Image();
    img.src = url;
    img.decode().catch(() => {});
    preloaded.set(p, img);
  }
  for (const p of preloaded.keys()) if (!(p in urls)) preloaded.delete(p);
}

function navigate(delta) {
  if (state.files.length < 2) return;
  state.index = (state.index + delta + state.files.length) % state.files.length;
  loadPath(state.files[state.index], { refreshSiblings: false });
}

// ---------- save as ----------

async function saveAs(format) {
  if (!state.currentPath || state.currentType === 'video') return;
  try {
    // Save what is on screen, rotation included
    const src = state.currentType === 'raster' ? els.canvas : els.image;
    const rot = ((state.rotation % 360) + 360) % 360;
    const swap = rot === 90 || rot === 270;
    const source = document.createElement('canvas');
    source.width = swap ? state.mediaH : state.mediaW;
    source.height = swap ? state.mediaW : state.mediaH;
    const ctx = source.getContext('2d');
    if (format === 'jpeg') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, source.width, source.height);
    }
    ctx.translate(source.width / 2, source.height / 2);
    ctx.rotate((rot * Math.PI) / 180);
    ctx.drawImage(src, -state.mediaW / 2, -state.mediaH / 2, state.mediaW, state.mediaH);
    const blob = await new Promise((resolve) =>
      source.toBlob(resolve, format === 'jpeg' ? 'image/jpeg' : 'image/png', 0.92)
    );
    if (!blob) throw new Error('Conversia a eșuat');
    const data = new Uint8Array(await blob.arrayBuffer());
    const saved = await window.api.saveAs({
      suggestedName: els.fileName.textContent,
      data,
      format
    });
    if (saved) showToast('Salvat: ' + saved, 'info', 3500);
  } catch (err) {
    showToast('Salvarea a eșuat:\n' + (err.message || err));
  }
}

// ---------- toolbar ----------

els.btn.open.addEventListener('click', async () => {
  const p = await window.api.openDialog();
  if (p) loadPath(p);
});
els.btn.prev.addEventListener('click', () => navigate(-1));
els.btn.next.addEventListener('click', () => navigate(1));
els.btn.zoomIn.addEventListener('click', () => {
  const current = state.fitMode ? fitZoom() : state.zoom;
  setZoom(current * 1.25);
});
els.btn.zoomOut.addEventListener('click', () => {
  const current = state.fitMode ? fitZoom() : state.zoom;
  setZoom(current / 1.25);
});
els.btn.fit.addEventListener('click', () => resetView({ keepRotation: true }));
els.btn.one.addEventListener('click', () => setZoom(1));
els.btn.rotate.addEventListener('click', () => {
  state.rotation = (state.rotation + 90) % 360;
  applyTransform();
});
els.btn.savePng.addEventListener('click', () => saveAs('png'));
els.btn.saveJpg.addEventListener('click', () => saveAs('jpeg'));
els.btn.folder.addEventListener('click', () => {
  if (state.currentPath) window.api.showInFolder(state.currentPath);
});

// ---------- keyboard ----------

window.addEventListener('keydown', (e) => {
  if (e.target === els.video) return;
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.key.toLowerCase() === 'o') { e.preventDefault(); els.btn.open.click(); }
  else if (ctrl && e.key.toLowerCase() === 's') { e.preventDefault(); saveAs('png'); }
  else if (e.key === 'ArrowLeft') navigate(-1);
  else if (e.key === 'ArrowRight') navigate(1);
  else if (e.key === '+' || e.key === '=') els.btn.zoomIn.click();
  else if (e.key === '-') els.btn.zoomOut.click();
  else if (e.key === '0') resetView({ keepRotation: true });
  else if (e.key === '1') setZoom(1);
  else if (e.key.toLowerCase() === 'r' && !ctrl) els.btn.rotate.click();
  else if (e.key.toLowerCase() === 'f' && !ctrl) {
    document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
  }
});

// ---------- drag & drop ----------

let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  els.dropOverlay.hidden = false;
});
window.addEventListener('dragleave', (e) => {
  e.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) els.dropOverlay.hidden = true;
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  els.dropOverlay.hidden = true;
  const file = e.dataTransfer.files[0];
  if (!file) return;
  const p = window.api.pathForFile(file);
  if (p) loadPath(p);
});

// ---------- IPC events ----------

window.api.onOpenPath((p) => loadPath(p));
window.api.onTranscodeProgress(({ percent, mode }) => {
  els.progressBar.style.width = percent + '%';
  els.busyText.textContent = mode === 'remux'
    ? `Se pregătește video… ${percent}%`
    : `Se convertește video (codec nesuportat nativ)… ${percent}%`;
});
