const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Worker } = require('worker_threads');

let ffmpegPath = require('ffmpeg-static');
// In the packaged app ffmpeg lives outside the asar archive
if (ffmpegPath && ffmpegPath.includes('app.asar')) {
  ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked');
}

const HEIF_EXT = new Set(['.heic', '.heif']);
const TIFF_EXT = new Set(['.tif', '.tiff']);
const NATIVE_IMG_EXT = new Set([
  '.jpg', '.jpeg', '.jfif', '.png', '.apng', '.gif', '.webp', '.avif',
  '.bmp', '.svg', '.ico'
]);
const VIDEO_EXT = new Set([
  '.mp4', '.m4v', '.mov', '.mkv', '.webm', '.hevc', '.h265', '.265',
  '.avi', '.wmv', '.3gp', '.ts', '.mts', '.m2ts', '.mpg', '.mpeg'
]);
// Raw bitstreams / legacy containers that Chromium will never play directly
const ALWAYS_TRANSCODE_EXT = new Set([
  '.hevc', '.h265', '.265', '.avi', '.wmv', '.mts', '.m2ts', '.ts', '.mpg', '.mpeg', '.3gp'
]);

const ALL_EXT = new Set([...HEIF_EXT, ...TIFF_EXT, ...NATIVE_IMG_EXT, ...VIDEO_EXT]);

let mainWindow = null;
let pendingOpenPath = null;

const tempDir = path.join(os.tmpdir(), 'omniview-transcode');

function fileKind(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (HEIF_EXT.has(ext)) return 'heif';
  if (TIFF_EXT.has(ext)) return 'tiff';
  if (NATIVE_IMG_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  return 'unknown';
}

function toFileUrl(p) {
  return require('url').pathToFileURL(p).href;
}

// Identifies a file's current contents, so caches notice when it is replaced on disk.
async function fileKey(filePath) {
  const st = await fsp.stat(filePath);
  return `${path.resolve(filePath).toLowerCase()}|${st.size}|${st.mtimeMs}`;
}

function pickPathFromArgv(argv) {
  // Skip the executable and (in dev) the app directory argument
  const args = argv.slice(app.isPackaged ? 1 : 2);
  for (const a of args) {
    if (a.startsWith('-')) continue;
    try {
      if (fs.existsSync(a) && fs.statSync(a).isFile()) return path.resolve(a);
    } catch { /* ignore */ }
  }
  return null;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 640,
    minHeight: 420,
    backgroundColor: '#111318',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.webContents.on('did-finish-load', () => {
    if (pendingOpenPath) {
      mainWindow.webContents.send('open-path', pendingOpenPath);
      pendingOpenPath = null;
    }
  });

  // Smoke-test hook: OMNIVIEW_SCREENSHOT=<path.png> captures the window and quits
  if (process.env.OMNIVIEW_SCREENSHOT) {
    console.log('[smoke] screenshot hook armed:', process.env.OMNIVIEW_SCREENSHOT);
    mainWindow.webContents.once('did-finish-load', () => {
      console.log('[smoke] did-finish-load');
      setTimeout(async () => {
        try {
          console.log('[smoke] capturing...');
          const img = await mainWindow.webContents.capturePage();
          fs.writeFileSync(process.env.OMNIVIEW_SCREENSHOT, img.toPNG());
          console.log('[smoke] saved');
        } catch (e) {
          console.error('[smoke] capture failed:', e);
        } finally {
          app.quit();
        }
      }, Number(process.env.OMNIVIEW_SCREENSHOT_DELAY) || 5000);
    });
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const p = pickPathFromArgv(argv);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      if (p) mainWindow.webContents.send('open-path', p);
    }
  });

  app.whenReady().then(() => {
    pendingOpenPath = pickPathFromArgv(process.argv);
    // Leftovers from a previous run that did not exit cleanly
    fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    createWindow();
  });
}

app.on('window-all-closed', () => {
  app.quit();
});

app.on('quit', () => {
  cancelVideoJob();
  decoder.terminate();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------- image decoding (HEIF / TIFF) ----------

// A small pool of worker threads with a queue: what the user asked to see goes first,
// prefetching the neighbours only uses otherwise idle workers.
const decoder = (() => {
  const size = Math.max(1, Math.min(2, os.cpus().length - 1));
  const workers = [];
  const idle = [];
  const queue = [];
  const callbacks = new Map();
  let seq = 0;

  function spawnWorker() {
    const w = new Worker(path.join(__dirname, 'decoder-worker.js'));
    w.on('message', (msg) => {
      const cb = callbacks.get(msg.id);
      callbacks.delete(msg.id);
      idle.push(w);
      pump();
      if (cb) cb(msg);
    });
    w.on('error', (err) => {
      // Fail whatever this worker was doing and replace it
      for (const [id, cb] of callbacks) {
        if (cb.worker === w) { callbacks.delete(id); cb({ error: err.message }); }
      }
      for (const list of [workers, idle]) {
        const i = list.indexOf(w);
        if (i !== -1) list.splice(i, 1);
      }
      spawnWorker();
      pump();
    });
    workers.push(w);
    idle.push(w);
    return w;
  }

  function pump() {
    while (idle.length && queue.length) {
      const job = queue.shift();
      const w = idle.pop();
      const id = ++seq;
      const cb = (msg) => (msg.error ? job.reject(new Error(msg.error)) : job.resolve(msg));
      cb.worker = w;
      callbacks.set(id, cb);
      w.postMessage({ id, filePath: job.filePath, kind: job.kind });
    }
  }

  return {
    run(filePath, kind, { urgent }) {
      if (!workers.length) for (let i = 0; i < size; i++) spawnWorker();
      return new Promise((resolve, reject) => {
        const job = { filePath, kind, resolve, reject, urgent };
        if (urgent) {
          // A new image to show makes older not-yet-started prefetches pointless
          for (let i = queue.length - 1; i >= 0; i--) {
            if (!queue[i].urgent) queue.splice(i, 1)[0].reject(new Error('superseded'));
          }
          queue.unshift(job);
        } else {
          queue.push(job);
        }
        pump();
      });
    },
    terminate() {
      for (const w of workers) w.terminate();
    }
  };
})();

// Decoded images by file key, bounded by memory (RGBA: a 12 MP photo is ~48 MB).
const RASTER_CACHE_BYTES = 400 * 1024 * 1024;
const rasterCache = new Map(); // key -> { width, height, data }
const rasterInFlight = new Map(); // key -> Promise
let rasterCacheBytes = 0;

function cacheRaster(key, img) {
  rasterCache.set(key, img);
  rasterCacheBytes += img.data.byteLength;
  for (const [k, v] of rasterCache) {
    if (rasterCacheBytes <= RASTER_CACHE_BYTES || k === key) break;
    rasterCache.delete(k);
    rasterCacheBytes -= v.data.byteLength;
  }
}

async function decodeRaster(filePath, kind, { urgent }) {
  const key = await fileKey(filePath);
  const hit = rasterCache.get(key);
  if (hit) {
    // refresh LRU position
    rasterCache.delete(key);
    rasterCache.set(key, hit);
    return hit;
  }
  let p = rasterInFlight.get(key);
  if (!p) {
    p = decoder.run(filePath, kind, { urgent }).then((img) => {
      cacheRaster(key, img);
      return img;
    }).finally(() => rasterInFlight.delete(key));
    rasterInFlight.set(key, p);
  }
  return p;
}

// ---------- IPC ----------

ipcMain.handle('dialog:open', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Deschide fisier media',
    properties: ['openFile'],
    filters: [
      { name: 'Toate formatele suportate', extensions: [...ALL_EXT].map((e) => e.slice(1)) },
      { name: 'Imagini HEIC/HEIF', extensions: ['heic', 'heif'] },
      { name: 'Imagini', extensions: ['jpg', 'jpeg', 'jfif', 'png', 'apng', 'gif', 'webp', 'avif', 'bmp', 'svg', 'ico', 'tif', 'tiff'] },
      { name: 'Video', extensions: ['mp4', 'm4v', 'mov', 'mkv', 'webm', 'hevc', 'h265', '265', 'avi', 'wmv', '3gp', 'ts', 'mts', 'm2ts', 'mpg', 'mpeg'] },
      { name: 'Toate fisierele', extensions: ['*'] }
    ]
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('file:load', async (_event, filePath) => {
  const kind = fileKind(filePath);
  const name = path.basename(filePath);

  if (kind === 'heif' || kind === 'tiff') {
    const { width, height, data } = await decodeRaster(filePath, kind, { urgent: true });
    return { type: 'raster', name, path: filePath, width, height, data };
  }

  if (kind === 'image') {
    return { type: 'image', name, path: filePath, url: toFileUrl(filePath) };
  }

  if (kind === 'video') {
    const ext = path.extname(filePath).toLowerCase();
    return {
      type: 'video',
      name,
      path: filePath,
      url: toFileUrl(filePath),
      forceTranscode: ALWAYS_TRANSCODE_EXT.has(ext)
    };
  }

  throw new Error(`Format nesuportat: ${path.extname(filePath) || '(fara extensie)'}`);
});

// Decode the next/previous HEIC or TIFF while the user looks at the current one.
// Returns file URLs for natively supported images, which the renderer preloads itself.
ipcMain.handle('file:prefetch', async (_event, filePaths) => {
  const urls = {};
  for (const p of filePaths || []) {
    const kind = fileKind(p);
    if (kind === 'heif' || kind === 'tiff') decodeRaster(p, kind, { urgent: false }).catch(() => {});
    else if (kind === 'image') urls[p] = toFileUrl(p);
  }
  return urls;
});

ipcMain.handle('file:siblings', async (_event, filePath) => {
  const dir = path.dirname(filePath);
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return { files: [filePath], index: 0 };
  }
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const files = entries
    .filter((e) => e.isFile() && ALL_EXT.has(path.extname(e.name).toLowerCase()))
    .map((e) => path.join(dir, e.name))
    .sort(collator.compare);
  let index = files.findIndex((f) => f.toLowerCase() === filePath.toLowerCase());
  if (index === -1) {
    files.push(filePath);
    index = files.length - 1;
  }
  return { files, index };
});

// ---------- video: remux / transcode ----------

function parseTimeToSeconds(str) {
  const m = str.match(/(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

// `ffmpeg -i` with no output prints the stream info and exits; enough to choose between remux and transcode.
function probe(filePath) {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath, ['-hide_banner', '-i', filePath], { windowsHide: true });
    let err = '';
    proc.stderr.on('data', (c) => { err += c.toString(); });
    proc.on('error', () => resolve({ duration: 0, video: null, audio: null }));
    proc.on('close', () => {
      const d = err.match(/Duration:\s*(\d+:\d+:\d+(?:\.\d+)?)/);
      const v = err.match(/Stream #\S+.*?: Video: (\w+)/);
      const a = err.match(/Stream #\S+.*?: Audio: (\w+)/);
      resolve({ duration: d ? parseTimeToSeconds(d[1]) : 0, video: v ? v[1] : null, audio: a ? a[1] : null });
    });
  });
}

// Codecs Chromium decodes when they are in an MP4: for these, rewrapping the container is enough.
const REMUX_VIDEO = new Set(['h264', 'hevc']);
const COPY_AUDIO = new Set(['aac', 'mp3']);

const videoCache = new Map(); // `${fileKey}|${mode}` -> temp mp4 path
const videoInFlight = new Map(); // same key -> Promise
let activeJob = null; // { proc, key, cancelled }

function cancelVideoJob() {
  if (!activeJob) return;
  activeJob.cancelled = true;
  try { activeJob.proc.kill('SIGKILL'); } catch { /* ignore */ }
  activeJob = null;
}

function runFfmpeg(args, { duration, onProgress, key }) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { windowsHide: true });
    const job = { proc, key, cancelled: false };
    activeJob = job;
    let stderrTail = '';
    let out = '';

    // -progress pipe:1 gives stable key=value lines instead of the human-oriented status line
    proc.stdout.on('data', (chunk) => {
      out += chunk.toString();
      const lines = out.split('\n');
      out = lines.pop();
      for (const line of lines) {
        const m = line.match(/^out_time_us=(\d+)/);
        if (m && duration > 0) onProgress(Math.min(99, Math.round((Number(m[1]) / 1e6 / duration) * 100)));
      }
    });
    proc.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-4000);
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (activeJob === job) activeJob = null;
      if (job.cancelled) reject(new Error('cancelled'));
      else if (code === 0) resolve();
      else reject(new Error('Conversia video a esuat (ffmpeg cod ' + code + '):\n' + stderrTail.split('\n').slice(-6).join('\n')));
    });
  });
}

// mode: 'auto' remuxes when the codecs allow it (seconds, no quality loss) and transcodes otherwise;
// 'transcode' forces H.264, for when a remuxed file still would not play.
ipcMain.handle('video:prepare', async (event, filePath, mode = 'auto') => {
  if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
    throw new Error('ffmpeg nu a fost gasit in aplicatie');
  }

  const info = await probe(filePath);
  // An MP4/MOV that already holds these codecs gains nothing from rewrapping: if it did not play, the codec is the problem
  const alreadyMp4 = /^\.(mp4|m4v|mov)$/i.test(path.extname(filePath)) && (!info.audio || COPY_AUDIO.has(info.audio));
  const remux = mode === 'auto' && REMUX_VIDEO.has(info.video) && !alreadyMp4;
  const actual = remux ? 'remux' : 'transcode';
  const key = `${await fileKey(filePath)}|${actual}`;

  const cached = videoCache.get(key);
  if (cached && fs.existsSync(cached)) return { url: toFileUrl(cached), mode: actual };
  if (videoInFlight.has(key)) return videoInFlight.get(key);

  // Only one conversion at a time: whatever the user moved away from is no longer needed
  cancelVideoJob();

  const sender = event.sender;
  const p = (async () => {
    await fsp.mkdir(tempDir, { recursive: true });
    const outPath = path.join(tempDir, crypto.createHash('sha1').update(key).digest('hex').slice(0, 16) + '.mp4');

    const args = ['-y', '-hide_banner', '-nostats', '-progress', 'pipe:1'];
    args.push('-i', filePath, '-map', '0:v:0?', '-map', '0:a:0?', '-sn', '-dn');
    if (remux) {
      args.push('-c:v', 'copy');
      if (info.video === 'hevc') args.push('-tag:v', 'hvc1');
    } else {
      // Fit in 1920x1920: 4K transcodes take several times longer and a viewer does not need them
      args.push(
        '-vf', "scale='if(gt(iw,ih),min(1920,iw),-2)':'if(gt(iw,ih),-2,min(1920,ih))'",
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p'
      );
    }
    if (info.audio && COPY_AUDIO.has(info.audio)) args.push('-c:a', 'copy');
    else args.push('-c:a', 'aac', '-b:a', '192k');
    args.push('-movflags', '+faststart', outPath);

    await runFfmpeg(args, {
      duration: info.duration,
      key,
      onProgress: (percent) => {
        if (!sender.isDestroyed()) sender.send('transcode:progress', { path: filePath, percent, mode: actual });
      }
    });
    videoCache.set(key, outPath);
    return { url: toFileUrl(outPath), mode: actual };
  })().finally(() => videoInFlight.delete(key));

  videoInFlight.set(key, p);
  return p;
});

ipcMain.handle('video:cancel', () => cancelVideoJob());

ipcMain.handle('file:saveAs', async (_event, { suggestedName, data, format }) => {
  const ext = format === 'jpeg' ? 'jpg' : 'png';
  const base = suggestedName.replace(/\.[^.]+$/, '');
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Salveaza ca',
    defaultPath: `${base}.${ext}`,
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }]
  });
  if (result.canceled || !result.filePath) return null;
  await fsp.writeFile(result.filePath, Buffer.from(data));
  return result.filePath;
});

ipcMain.handle('file:showInFolder', (_event, filePath) => {
  shell.showItemInFolder(filePath);
});
