const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

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
const transcodeCache = new Map(); // sourcePath -> temp mp4 path
let activeFfmpeg = null;

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
      }, 5000);
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
    createWindow();
  });
}

app.on('window-all-closed', () => {
  app.quit();
});

app.on('quit', () => {
  if (activeFfmpeg) {
    try { activeFfmpeg.kill('SIGKILL'); } catch { /* ignore */ }
  }
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

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

  if (kind === 'heif') {
    const decode = require('heic-decode');
    const buffer = await fsp.readFile(filePath);
    const { width, height, data } = await decode({ buffer });
    return { type: 'raster', name, path: filePath, width, height, data: Buffer.from(data) };
  }

  if (kind === 'tiff') {
    const UTIF = require('utif2');
    const buffer = await fsp.readFile(filePath);
    const ifds = UTIF.decode(buffer);
    if (!ifds.length) throw new Error('TIFF invalid');
    UTIF.decodeImage(buffer, ifds[0]);
    const rgba = UTIF.toRGBA8(ifds[0]);
    return { type: 'raster', name, path: filePath, width: ifds[0].width, height: ifds[0].height, data: Buffer.from(rgba) };
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

ipcMain.handle('file:siblings', async (_event, filePath) => {
  const dir = path.dirname(filePath);
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return { files: [filePath], index: 0 };
  }
  const files = entries
    .filter((e) => e.isFile() && ALL_EXT.has(path.extname(e.name).toLowerCase()))
    .map((e) => path.join(dir, e.name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  let index = files.findIndex((f) => f.toLowerCase() === filePath.toLowerCase());
  if (index === -1) {
    files.push(filePath);
    index = files.length - 1;
  }
  return { files, index };
});

function parseTimeToSeconds(str) {
  const m = str.match(/(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

ipcMain.handle('video:transcode', async (event, filePath) => {
  const cached = transcodeCache.get(filePath);
  if (cached && fs.existsSync(cached)) return { url: toFileUrl(cached) };

  if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
    throw new Error('ffmpeg nu a fost gasit in aplicatie');
  }

  await fsp.mkdir(tempDir, { recursive: true });
  const outPath = path.join(
    tempDir,
    crypto.createHash('sha1').update(filePath).digest('hex').slice(0, 16) + '.mp4'
  );

  const sender = event.sender;
  await new Promise((resolve, reject) => {
    const args = [
      '-y', '-i', filePath,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
      '-c:a', 'aac', '-b:a', '192k',
      outPath
    ];
    const proc = spawn(ffmpegPath, args, { windowsHide: true });
    activeFfmpeg = proc;
    let durationSec = 0;
    let stderrTail = '';

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderrTail = (stderrTail + text).slice(-4000);
      if (!durationSec) {
        const d = text.match(/Duration:\s*(\d+:\d+:\d+(?:\.\d+)?)/);
        if (d) durationSec = parseTimeToSeconds(d[1]);
      }
      const t = text.match(/time=(\d+:\d+:\d+(?:\.\d+)?)/);
      if (t && durationSec > 0 && !sender.isDestroyed()) {
        const pct = Math.min(99, Math.round((parseTimeToSeconds(t[1]) / durationSec) * 100));
        sender.send('transcode:progress', { path: filePath, percent: pct });
      }
    });

    proc.on('error', reject);
    proc.on('close', (code) => {
      activeFfmpeg = null;
      if (code === 0) resolve();
      else reject(new Error('Conversia video a esuat (ffmpeg cod ' + code + '):\n' + stderrTail.split('\n').slice(-6).join('\n')));
    });
  });

  transcodeCache.set(filePath, outPath);
  return { url: toFileUrl(outPath) };
});

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
