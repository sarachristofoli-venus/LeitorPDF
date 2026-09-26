// OCR (reconhecimento de texto) com Tesseract.js, 100% local: nada é enviado para a internet.
// Os arquivos do motor e dos idiomas são servidos pelo protocolo interno app://.
import Tesseract from '../node_modules/tesseract.js/dist/tesseract.esm.min.js';

const NM = new URL('../node_modules/', import.meta.url).href;
const WORKER_PATH = NM + 'tesseract.js/dist/worker.min.js';
const CORE_PATH = new URL('/ocr-core', import.meta.url).href; // resolvido no processo principal
const LANG_PATH = new URL('/tessdata', import.meta.url).href; // mapeado no processo principal

export const LANGS = [
  ['por+eng', 'Português + Inglês'],
  ['por', 'Português'],
  ['eng', 'Inglês'],
];

export class OcrCancelled extends Error {
  constructor() { super('OCR cancelado'); this.name = 'OcrCancelled'; }
}

/**
 * Reconhece o texto de várias imagens em paralelo.
 * @param {Array<() => Promise<HTMLCanvasElement|ImageBitmap|Blob>>} jobs  funções que produzem a imagem de cada página
 * @param {{lang?:string, onProgress?:(done:number,total:number,frac:number)=>void, onPage?:(i:number, words:object[])=>void, signal?:{cancelled:boolean}}} opts
 * @returns {Promise<object[][]>} palavras de cada imagem (coordenadas em pixels da imagem)
 */
export async function recognizeAll(jobs, { lang = 'por+eng', onProgress, onPage, signal = { cancelled: false } } = {}) {
  const total = jobs.length;
  const size = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1, total));
  const partial = new Array(size).fill(0);
  let done = 0;
  const report = () => onProgress?.(done, total, (done + partial.reduce((a, b) => a + b, 0)) / total);

  const workers = [];
  signal.terminate = () => workers.forEach((w) => w.terminate().catch(() => {}));
  try {
    for (let i = 0; i < size; i++) {
      if (signal.cancelled) throw new OcrCancelled();
      workers.push(await Tesseract.createWorker(lang, 1, {
        workerPath: WORKER_PATH,
        corePath: CORE_PATH,
        langPath: LANG_PATH,
        workerBlobURL: false,
        cacheMethod: 'none',
        gzip: true,
        logger: (m) => {
          if (m.status === 'recognizing text') { partial[i] = m.progress || 0; report(); }
        },
      }));
    }
    const results = new Array(total);
    let next = 0;
    const loop = async (w, i) => {
      while (next < total) {
        if (signal.cancelled) throw new OcrCancelled();
        const idx = next++;
        const image = await jobs[idx]();
        if (signal.cancelled) throw new OcrCancelled();
        partial[i] = 0;
        const { data } = await w.recognize(image, {}, { blocks: true, text: false });
        if (image instanceof HTMLCanvasElement) image.width = image.height = 0; // libera a memória
        results[idx] = wordsFromBlocks(data.blocks);
        partial[i] = 0;
        done++;
        report();
        onPage?.(idx, results[idx]);
      }
    };
    await Promise.all(workers.map((w, i) => loop(w, i)));
    return results;
  } catch (err) {
    if (signal.cancelled) throw new OcrCancelled();
    throw err;
  } finally {
    await Promise.all(workers.map((w) => w.terminate().catch(() => {})));
  }
}

/**
 * Achata a árvore do Tesseract (blocos → parágrafos → linhas → palavras) numa lista de palavras com
 * caixa, linha de base e altura da linha — tudo em pixels da imagem.
 */
export function wordsFromBlocks(blocks) {
  const out = [];
  let lineNo = 0;
  for (const b of blocks || []) {
    for (const par of b.paragraphs || []) {
      for (const line of par.lines || []) {
        lineNo++;
        const lb = line.bbox;
        const bl = line.baseline;
        const lineH = Math.max(1, lb.y1 - lb.y0);
        const baseAt = (x) => {
          if (!bl || bl.x1 === bl.x0) return lb.y1 - lineH * 0.2;
          return bl.y0 + ((bl.y1 - bl.y0) * (x - bl.x0)) / (bl.x1 - bl.x0);
        };
        for (const w of line.words || []) {
          const text = (w.text || '').trim();
          if (!text) continue;
          const { x0, x1 } = w.bbox;
          out.push({
            text,
            x0, x1,
            by0: baseAt(x0),
            by1: baseAt(x1),
            size: lineH,
            line: lineNo,
            conf: w.confidence,
          });
        }
      }
    }
  }
  return out;
}
