// Decodes HEIC/HEIF and TIFF off the main process thread, so the window stays responsive
// (a 12 MP HEIC takes a second or more in WebAssembly). Replies with raw RGBA, transferred, not copied.
const { parentPort } = require('worker_threads');
const fs = require('fs');

let heicDecode = null;
let UTIF = null;

function decodeTiff(buffer) {
  UTIF = UTIF || require('utif2');
  const ifds = UTIF.decode(buffer);
  if (!ifds.length) throw new Error('TIFF invalid');
  // Many TIFFs (scanners, cameras) store a small thumbnail as the first page; show the largest image instead.
  const all = ifds.flatMap((ifd) => [ifd, ...(ifd.subIFD || [])]);
  const area = (ifd) => (ifd.t256 ? ifd.t256[0] : 0) * (ifd.t257 ? ifd.t257[0] : 0);
  const best = all.reduce((a, b) => (area(b) > area(a) ? b : a), all[0]);
  UTIF.decodeImage(buffer, best);
  const rgba = UTIF.toRGBA8(best);
  return { width: best.width, height: best.height, data: rgba };
}

async function decodeHeif(buffer) {
  heicDecode = heicDecode || require('heic-decode');
  const { width, height, data } = await heicDecode({ buffer });
  return { width, height, data };
}

parentPort.on('message', async ({ id, filePath, kind }) => {
  try {
    const buffer = await fs.promises.readFile(filePath);
    const img = kind === 'heif' ? await decodeHeif(buffer) : decodeTiff(buffer);
    const bytes = img.data instanceof Uint8Array || img.data instanceof Uint8ClampedArray
      ? new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength)
      : new Uint8Array(img.data);
    // Transfer needs the whole ArrayBuffer to be ours; copy only if the view is a slice of a bigger one.
    const own = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice();
    parentPort.postMessage({ id, width: img.width, height: img.height, data: own }, [own.buffer]);
  } catch (err) {
    parentPort.postMessage({ id, error: (err && err.message) || String(err) });
  }
});
