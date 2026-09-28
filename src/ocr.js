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
 * Margem branca em volta da imagem antes do OCR. O Tesseract endireita fotos tortas girando a imagem
 * sem aumentar o quadro; sem margem, o que está nos cantos sai do quadro e não é lido.
 * 4,5% do lado maior em cada lado cobre inclinações de até ~10°.
 */
function withMargin(canvas) {
  const pad = Math.ceil(0.045 * Math.max(canvas.width, canvas.height));
  const c = document.createElement('canvas');
  c.width = canvas.width + 2 * pad;
  c.height = canvas.height + 2 * pad;
  const ctx = c.getContext('2d', { alpha: false, willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(canvas, pad, pad);
  canvas.width = canvas.height = 0; // libera a memória do original
  return { canvas: c, pad };
}

/**
 * Reconhece o texto de várias imagens em paralelo.
 * @param {Array<() => Promise<HTMLCanvasElement>>} jobs  funções que produzem a imagem de cada página
 * @param {{lang?:string, onProgress?:(done:number,total:number,frac:number)=>void, onPage?:(i:number, words:object[])=>void, signal?:{cancelled:boolean, terminate?:()=>void}}} opts
 * @returns {Promise<object[][]>} palavras de cada imagem (coordenadas em pixels da imagem entregue pelo job)
 */
export async function recognizeAll(jobs, { lang = 'por+eng', onProgress, onPage, signal = { cancelled: false } } = {}) {
  const total = jobs.length;
  const size = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1, total));
  const partial = new Array(size).fill(0);
  let done = 0;
  const report = () => onProgress?.(done, total, (done + partial.reduce((a, b) => a + b, 0)) / total);

  // Cancelamento: terminar um worker do Tesseract.js não rejeita as promessas pendentes dele, então
  // cada espera corre contra uma promessa de cancelamento (senão "Cancelar" deixaria tudo pendurado).
  let abort;
  const aborted = new Promise((_, reject) => { abort = reject; });
  aborted.catch(() => {});
  const guard = (p) => Promise.race([p, aborted]);
  const workers = [];
  signal.terminate = () => {
    abort(new OcrCancelled());
    workers.forEach((w) => w.terminate().catch(() => {}));
  };
  if (signal.cancelled) throw new OcrCancelled();

  try {
    for (let i = 0; i < size; i++) {
      if (signal.cancelled) throw new OcrCancelled();
      const creating = Tesseract.createWorker(lang, 1, {
        workerPath: WORKER_PATH,
        corePath: CORE_PATH,
        langPath: LANG_PATH,
        workerBlobURL: false,
        cacheMethod: 'none',
        gzip: true,
        logger: (m) => {
          if (m.status === 'recognizing text') { partial[i] = m.progress || 0; report(); }
        },
      });
      creating.then((w) => { if (signal.cancelled) w.terminate().catch(() => {}); }, () => {});
      const worker = await guard(creating);
      workers.push(worker);
      // Segmentação automática da página (PSM 3): detecta colunas, títulos, legendas e fotos.
      // Sem isso o Tesseract.js trata a página como um bloco único e junta as linhas de colunas vizinhas
      // (numa página de jornal: 23 de 33 linhas misturavam colunas e o erro subia de 0,5% para 3,3%).
      await guard(worker.setParameters({ tessedit_pageseg_mode: Tesseract.PSM.AUTO }));
    }
    const results = new Array(total);
    let next = 0;
    const loop = async (w, i) => {
      while (next < total) {
        if (signal.cancelled) throw new OcrCancelled();
        const idx = next++;
        let image = await guard(jobs[idx]());
        if (signal.cancelled) throw new OcrCancelled();
        partial[i] = 0;
        let geo = {};
        if (image instanceof HTMLCanvasElement) {
          const m = withMargin(image);
          image = m.canvas;
          geo = { width: image.width, height: image.height, pad: m.pad };
        }
        // rotateAuto: o Tesseract mede a inclinação (foto torta, digitalização enviesada) e endireita a imagem
        // antes de analisar o layout; sem isso, linhas inclinadas são confundidas com colunas e picotadas.
        const { data } = await guard(w.recognize(image, { rotateAuto: !!geo.width }, { blocks: true, text: false }));
        if (image instanceof HTMLCanvasElement) image.width = image.height = 0; // libera a memória
        results[idx] = wordsFromBlocks(data.blocks, { angle: data.rotateRadians || 0, ...geo });
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

const median = (arr) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/**
 * Palavra "lixo" (texto inventado sobre fotos e ilustrações). Decide pelo contexto: com confiança < 30,
 * descarta se não tiver nenhuma letra ou algarismo, ou se a linha inteira for duvidosa (mediana < 50).
 * Palavras curtas corretas em linhas boas ("R$", "STJ.", "e", "27") são mantidas.
 */
export function isJunk(text, conf, lineMedianConf = 100) {
  if (conf >= 30) return false;
  if (!/[\p{L}\p{N}]/u.test(text)) return true;
  return lineMedianConf < 50;
}

/**
 * Geometria de uma linha do Tesseract a partir da linha de base real (funciona para texto horizontal,
 * inclinado ou vertical — créditos de foto em jornais costumam ser verticais).
 * along(): posição ao longo da linha de base; at(t): ponto da linha de base; size: espessura da linha.
 */
function lineGeometry(line) {
  const lb = line.bbox;
  const bl = line.baseline;
  let dx = 1, dy = 0, ox = lb.x0, oy = lb.y1 - (lb.y1 - lb.y0) * 0.2;
  if (bl && (bl.x1 !== bl.x0 || bl.y1 !== bl.y0)) {
    const len = Math.hypot(bl.x1 - bl.x0, bl.y1 - bl.y0);
    dx = (bl.x1 - bl.x0) / len;
    dy = (bl.y1 - bl.y0) / len;
    ox = bl.x0;
    oy = bl.y0;
  }
  const corners = (b) => [[b.x0, b.y0], [b.x1, b.y0], [b.x0, b.y1], [b.x1, b.y1]];
  const along = (x, y) => (x - ox) * dx + (y - oy) * dy;
  const across = corners(lb).map(([x, y]) => -(x - ox) * dy + (y - oy) * dx);
  return {
    horizontal: Math.abs(dy) < 0.2,
    size: Math.max(1, Math.max(...across) - Math.min(...across)),
    span(b) {
      const t = corners(b).map(([x, y]) => along(x, y));
      return [Math.min(...t), Math.max(...t)];
    },
    at: (t) => [ox + dx * t, oy + dy * t],
  };
}

/**
 * Rede de segurança para quando a análise de layout do Tesseract falha e junta numa só "linha" o texto de
 * colunas vizinhas. As linhas já chegam cortadas nos vãos grandes; quando 3 ou mais linhas são cortadas no
 * mesmo ponto e os trechos à direita são texto corrido (3+ palavras em média), esse ponto é tratado como vão
 * entre colunas: os trechos que ainda o atravessam também são cortados, e tudo é reordenado coluna por coluna
 * (de cima para baixo). Na página de jornal de teste, com a análise de layout desligada, as palavras de outras
 * colunas no meio da seleção de uma coluna caíram de 983 para 19. Tabelas (trechos curtos) ficam por linha.
 */
function reorderColumns(segs) {
  const bySrc = new Map();
  for (const s of segs) {
    if (!s.geo.horizontal) continue;
    if (!bySrc.has(s.src)) bySrc.set(s.src, []);
    bySrc.get(s.src).push(s);
  }
  const cuts = [];
  for (const arr of bySrc.values()) {
    for (let i = 1; i < arr.length; i++) cuts.push({ x: (arr[i - 1].x1 + arr[i].x0) / 2, tol: arr[i].geo.size, right: arr[i] });
  }
  if (cuts.length < 3) return segs;
  cuts.sort((a, b) => a.x - b.x);
  const clusters = [];
  for (const c of cuts) {
    const last = clusters[clusters.length - 1];
    if (last && c.x - last[last.length - 1].x <= c.tol) last.push(c);
    else clusters.push([c]);
  }
  const gutters = clusters
    .filter((cl) => cl.length >= 3 && cl.reduce((a, c) => a + c.right.words.length, 0) / cl.length >= 3)
    .map((cl) => median(cl.map((c) => c.x)));
  if (!gutters.length) return segs;
  // Com os vãos de coluna conhecidos, corta também os trechos que ainda os atravessam (linhas em que
  // alguma sujeira no vão impediu o corte), no espaço entre palavras que cai sobre o vão.
  const pieces = [];
  for (const s of segs) {
    if (!s.geo.horizontal) { pieces.push(s); continue; }
    const tol = s.geo.size * 0.5;
    let cur = null;
    s.words.forEach((it, k) => {
      const prev = s.words[k - 1];
      const a = prev?.w.bbox.x1, b = it.w.bbox.x0;
      const crosses = prev && b > a && gutters.some((g) => g >= a - tol && g <= b + tol);
      if (!cur || crosses) {
        cur = { ...s, words: [], x0: Infinity, x1: -Infinity };
        pieces.push(cur);
      }
      cur.words.push(it);
      cur.x0 = Math.min(cur.x0, it.w.bbox.x0);
      cur.x1 = Math.max(cur.x1, it.w.bbox.x1);
    });
  }
  const column = (s) => gutters.filter((g) => s.x0 >= g).length;
  return pieces
    .map((s, i) => ({ s, i, c: s.geo.horizontal ? column(s) : 0 }))
    .sort((a, b) => a.c - b.c || a.i - b.i)
    .map((o) => o.s);
}

/**
 * Achata a árvore do Tesseract (blocos → parágrafos → linhas → palavras) numa lista de palavras com o
 * início e o fim da linha de base (bx0,by0 → bx1,by1), a espessura da linha e um número de trecho,
 * em pixels da imagem entregue pelo job. A ordem dos blocos é a ordem de leitura do Tesseract.
 * @param geo.angle  inclinação corrigida pelo Tesseract (a imagem foi girada em torno do centro, mesmo tamanho)
 * @param geo.pad    margem branca acrescentada em cada lado (withMargin)
 */
export function wordsFromBlocks(blocks, { angle = 0, width = 0, height = 0, pad = 0 } = {}) {
  // Coordenadas da imagem endireitada → gira de volta (−angle) → tira a margem = imagem original
  const cx = width / 2, cy = height / 2, cos = Math.cos(angle), sin = Math.sin(angle);
  const toOriginal = (x, y) => {
    let X = x, Y = y;
    if (angle && width) {
      X = cx + (x - cx) * cos + (y - cy) * sin;
      Y = cy - (x - cx) * sin + (y - cy) * cos;
    }
    return [X - pad, Y - pad];
  };
  const out = [];
  let segNo = 0, srcNo = 0;
  for (const b of blocks || []) {
    const segs = [];
    for (const par of b.paragraphs || []) {
      for (const line of par.lines || []) {
        srcNo++;
        const geo = lineGeometry(line);
        const words = (line.words || []).filter((w) => (w.text || '').trim());
        const med = median(words.map((w) => w.confidence)) ?? 100;
        let items = words
          .filter((w) => !isJunk(w.text.trim(), w.confidence, med))
          .map((w) => { const [t0, t1] = geo.span(w.bbox); return { w, t0, t1 }; });
        const gapsOf = (arr) => arr.slice(1).map((it, i) => it.t0 - arr[i].t1);
        let typical = median(gapsOf(items).filter((g) => g > 0)) ?? geo.size * 0.3;
        // Símbolos soltos (sem letra nem algarismo) isolados por vãos grandes são sujeira do vão entre
        // colunas (fios, marcas lidas como "—", "=", ":"). Eles dividiriam o vão ao meio e esconderiam a
        // separação das colunas. Um travessão de diálogo, com espaçamento normal, é mantido.
        items = items.filter((it, i) => {
          if (/[\p{L}\p{N}]/u.test(it.w.text)) return true;
          const left = i > 0 ? it.t0 - items[i - 1].t1 : Infinity;
          const right = i < items.length - 1 ? items[i + 1].t0 - it.t1 : Infinity;
          return !(left > typical * 2 && right > typical * 2 && (left !== Infinity || right !== Infinity));
        });
        // vão "anormal" = bem maior que o espaço típico entre as palavras desta linha
        const gaps = gapsOf(items);
        typical = median(gaps.filter((g) => g > 0)) ?? geo.size * 0.3;
        const limit = Math.max(geo.size * 0.9, typical * 3);
        let cur = null;
        for (const it of items) {
          if (!cur || it.t0 - cur.end > limit) {
            cur = { src: srcNo, geo, words: [], end: -Infinity, x0: Infinity, x1: -Infinity };
            segs.push(cur);
          }
          cur.words.push(it);
          cur.end = Math.max(cur.end, it.t1);
          cur.x0 = Math.min(cur.x0, it.w.bbox.x0);
          cur.x1 = Math.max(cur.x1, it.w.bbox.x1);
        }
      }
    }
    for (const s of reorderColumns(segs)) {
      segNo++;
      for (const { w, t0, t1 } of s.words) {
        const [bx0, by0] = toOriginal(...s.geo.at(t0));
        const [bx1, by1] = toOriginal(...s.geo.at(t1));
        out.push({ text: w.text.trim(), bx0, by0, bx1, by1, size: s.geo.size, line: segNo, conf: w.confidence });
      }
    }
  }
  return out;
}
