'use strict';

const fs = require('fs');
const path = require('path');

// Resolve OCR runtime assets both in dev (next to source) and when packaged
// as a single .exe (loose files next to the executable).
function baseDir() {
  try {
    const sea = require('node:sea');
    if (sea && sea.isSea && sea.isSea()) return path.dirname(process.execPath);
  } catch { /* not SEA */ }
  return path.join(__dirname, '..');
}

function firstExisting(cands) {
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch {} }
  return cands[cands.length - 1];
}

let _workerPromise = null;

async function getWorker() {
  if (_workerPromise) return _workerPromise;
  const { createWorker } = require('tesseract.js');
  const root = baseDir();

  const langPath = firstExisting([
    path.join(root, 'ocr-assets'),
    path.join(__dirname, '..', 'ocr-assets'),
  ]);
  const corePath = firstExisting([
    path.join(root, 'node_modules', 'tesseract.js-core'),
    path.join(__dirname, '..', 'node_modules', 'tesseract.js-core'),
  ]);
  const workerPath = firstExisting([
    path.join(root, 'node_modules', 'tesseract.js', 'src', 'worker-script', 'node', 'index.js'),
    path.join(__dirname, '..', 'node_modules', 'tesseract.js', 'src', 'worker-script', 'node', 'index.js'),
  ]);

  _workerPromise = createWorker('eng', 1, {
    langPath,
    cachePath: langPath,
    cacheMethod: 'none',
    gzip: true,
    corePath,
    workerPath,
    legacyCore: false,
    logger: () => {},
    errorHandler: (e) => console.error('[ocr]', e && e.message ? e.message : e),
  }).then(async (worker) => {
    await worker.setParameters({
      // statements are mostly tabular text + numbers
      preserve_interword_spaces: '1',
      tessedit_char_blacklist: '',
    });
    return worker;
  });
  return _workerPromise;
}

// Clean up a phone photo before OCR: upscale small images, greyscale, lift contrast.
// Big accuracy win on statement screenshots / WhatsApp photos.
async function preprocess(filePath) {
  try {
    const Jimp = require('jimp');
    const img = await Jimp.read(filePath);
    const w = img.bitmap.width;
    if (w < 1800) img.scale(Math.min(3, 2000 / Math.max(1, w)));
    img.greyscale().contrast(0.28).normalize();
    return await img.getBufferAsync(Jimp.MIME_PNG);
  } catch (e) {
    console.error('[ocr] preprocess skipped:', e.message);
    return filePath; // fall back to the raw file
  }
}

/**
 * OCR an image file to plain text.
 * @param {string} filePath
 * @returns {Promise<{text:string, meanConfidence:number, lines:string[]}>}
 */
async function ocrImage(filePath) {
  const worker = await getWorker();
  await worker.setParameters({ tessedit_pageseg_mode: '3', tessedit_char_whitelist: '' });
  const input = await preprocess(filePath);
  const { data } = await worker.recognize(input);
  const lines = (data.lines || []).map((l) => (l.text || '').replace(/\s+$/g, '')).filter(Boolean);
  return {
    text: data.text || '',
    meanConfidence: typeof data.confidence === 'number' ? data.confidence / 100 : 0,
    lines: lines.length ? lines : String(data.text || '').split(/\r?\n/).filter(Boolean),
  };
}

// Low-level: OCR a buffer with per-call Tesseract parameters; returns words with bboxes.
let _queue = Promise.resolve();
function recognizeWords(buffer, params = {}) {
  const run = async () => {
    const worker = await getWorker();
    await worker.setParameters({
      tessedit_pageseg_mode: params.psm || '6',
      tessedit_char_whitelist: params.whitelist || '',
    });
    const { data } = await worker.recognize(buffer);
    return (data.words || []).map((w) => ({ text: w.text || '', conf: w.confidence, x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1 }));
  };
  const p = _queue.then(run, run);
  _queue = p.catch(() => {});
  return p;
}

async function shutdown() {
  if (_workerPromise) {
    try { const w = await _workerPromise; await w.terminate(); } catch {}
    _workerPromise = null;
  }
}

module.exports = { ocrImage, recognizeWords, shutdown };
