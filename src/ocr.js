// OCR (reconhecimento de texto), 100% local: nada é enviado para a internet.
// Dois motores: o OCR do Windows (Windows.Media.Ocr, reconhecedor com IA que vem no sistema: ~15× mais
// rápido e com menos erros nas páginas de jornal de teste) e o Tesseract.js, usado quando o do Windows não
// está disponível (outro sistema, idioma não instalado) ou quando escolhido nas opções.
// Os arquivos do Tesseract (motor e idiomas) são servidos pelo protocolo interno app://.
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

export const ENGINES = [
  ['windows', 'OCR do Windows (rápido)'],
  ['tesseract', 'Tesseract (mais lento)'],
];

export class OcrCancelled extends Error {
  constructor() { super('OCR cancelado'); this.name = 'OcrCancelled'; }
}

/**
 * Imagem da página para o Tesseract, já com margem branca, no formato PPM (pixels crus). Entregar o canvas
 * faria o Tesseract.js comprimir tudo em PNG e o worker descomprimir de novo: o resultado é idêntico, mas
 * o PPM poupa ~1 s numa página de jornal.
 * Margem: o Tesseract endireita fotos tortas girando a imagem sem aumentar o quadro; sem margem, o que está
 * nos cantos sai do quadro e não é lido. 4,5% do lado maior em cada lado cobre inclinações de até ~10°.
 */
function toPpm(canvas) {
  const w = canvas.width, h = canvas.height;
  const pad = Math.ceil(0.045 * Math.max(w, h));
  const W = w + 2 * pad, H = h + 2 * pad;
  const head = new TextEncoder().encode(`P6\n${W} ${H}\n255\n`);
  const out = new Uint8Array(head.length + W * H * 3);
  out.set(head);
  out.fill(255, head.length);
  const { data } = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h);
  canvas.width = canvas.height = 0; // libera a memória do original
  for (let y = 0; y < h; y++) {
    let j = head.length + ((y + pad) * W + pad) * 3;
    for (let i = y * w * 4, end = i + w * 4; i < end; i += 4, j += 3) {
      const a = data[i + 3];
      if (a === 255) {
        out[j] = data[i]; out[j + 1] = data[i + 1]; out[j + 2] = data[i + 2];
      } else { // transparência sobre fundo branco
        const k = a / 255, bg = 255 - a;
        out[j] = data[i] * k + bg; out[j + 1] = data[i + 1] * k + bg; out[j + 2] = data[i + 2] * k + bg;
      }
    }
  }
  return { image: out, width: W, height: H, pad };
}

/**
 * Quantos workers do Tesseract usar: cada um lê uma página por vez (~200 MB de memória numa página grande).
 * Deixa dois núcleos livres para a interface e limita pela memória do computador.
 */
function poolSize(total) {
  const cores = navigator.hardwareConcurrency || 2;
  const mem = navigator.deviceMemory || 4; // GB (o Chromium informa no máximo 8)
  return Math.max(1, Math.min(total, cores - 2, mem >= 8 ? 6 : mem >= 4 ? 3 : 2));
}

/**
 * Reconhece o texto de várias imagens em paralelo.
 * @param {Array<() => Promise<HTMLCanvasElement>>} jobs  funções que produzem a imagem de cada página
 * @param {{engine?:'windows'|'tesseract', lang?:string, onProgress?:(done:number,total:number,frac:number)=>void, onPage?:(i:number, words:object[])=>void, signal?:{cancelled:boolean, terminate?:()=>void}}} opts
 * @returns {Promise<object[][]>} palavras de cada imagem (coordenadas em pixels da imagem entregue pelo job)
 */
export async function recognizeAll(jobs, opts = {}) {
  const { engine = 'windows', lang = 'por+eng', signal = { cancelled: false } } = opts;
  if (engine === 'windows') {
    const winLang = windowsLang(await windowsOcr(), lang);
    if (signal.cancelled) throw new OcrCancelled();
    if (winLang) {
      try {
        return await recognizeWindows(jobs, { ...opts, winLang, signal });
      } catch (err) {
        if (signal.cancelled || err?.name === 'OcrCancelled') throw new OcrCancelled();
        console.warn('OCR do Windows falhou; usando o Tesseract.', err);
      }
    }
  }
  return recognizeTesseract(jobs, { ...opts, signal });
}

// ------------------------------------------------------------------ OCR do Windows

let winInfo = null;

/** Idiomas do OCR do Windows ({langs, max}), ou null se ele não estiver disponível neste computador. */
export function windowsOcr() {
  winInfo ??= Promise.resolve(globalThis.leitor?.ocrWinInfo?.())
    .catch(() => null)
    .then((info) => {
      if (!info?.langs?.length) { winInfo = null; return null; } // tenta de novo na próxima vez
      return info;
    });
  return winInfo;
}

/**
 * Idioma do OCR do Windows para o idioma escolhido ('por+eng' e 'por' → português; 'eng' → inglês), ou null
 * se ele não estiver instalado no Windows. O modelo de português também lê o inglês que aparece no texto.
 */
export function windowsLang(info, lang) {
  const want = /^por/.test(lang) ? 'pt' : /^eng/.test(lang) ? 'en' : null;
  const tags = (info?.langs || []).filter((t) => t.toLowerCase().split('-')[0] === want);
  return tags.find((t) => /^(pt-br|en-us)$/i.test(t)) || tags[0] || null;
}

/**
 * Imagem em tons de cinza para o OCR do Windows, com margem branca: sem ela, o OCR ignora o texto encostado
 * na borda de imagens pequenas (um recorte de uma linha só não era lido).
 */
function toGray(canvas) {
  const w = canvas.width, h = canvas.height;
  const pad = Math.max(32, Math.ceil(0.02 * Math.max(w, h)));
  const W = w + 2 * pad, H = h + 2 * pad;
  const out = new Uint8Array(W * H).fill(255);
  const { data } = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h);
  canvas.width = canvas.height = 0; // libera a memória do original
  for (let y = 0; y < h; y++) {
    let j = (y + pad) * W + pad;
    for (let i = y * w * 4, end = i + w * 4; i < end; i += 4, j++) {
      const v = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
      const a = data[i + 3];
      out[j] = a === 255 ? v : (v * a + 255 * (255 - a)) / 255; // transparência sobre fundo branco
    }
  }
  return { gray: out, width: W, height: H, pad };
}

/**
 * Quantas imagens mandar ao mesmo tempo. O OCR do Windows lê várias em paralelo (8 páginas de jornal em
 * 0,8 s); o limite é a memória das páginas desenhadas à espera.
 */
function windowsPool(total) {
  const cores = navigator.hardwareConcurrency || 2;
  const mem = navigator.deviceMemory || 4;
  return Math.max(1, Math.min(total, cores - 1, mem >= 8 ? 4 : 2));
}

async function recognizeWindows(jobs, { winLang, onProgress, onPage, signal }) {
  const total = jobs.length;
  let abort;
  const aborted = new Promise((_, reject) => { abort = reject; });
  aborted.catch(() => {});
  const guard = (p) => Promise.race([p, aborted]);
  signal.terminate = () => abort(new OcrCancelled());
  if (signal.cancelled) throw new OcrCancelled();
  const results = new Array(total);
  let next = 0, done = 0;
  onProgress?.(0, total, 0);
  const loop = async () => {
    while (next < total) {
      if (signal.cancelled) throw new OcrCancelled();
      const idx = next++;
      const canvas = await guard(jobs[idx]());
      if (signal.cancelled) throw new OcrCancelled();
      if (!(canvas instanceof HTMLCanvasElement)) throw new Error('imagem em formato inesperado');
      const img = toGray(canvas);
      const res = await guard(globalThis.leitor.ocrWin(winLang, img.width, img.height, img.gray));
      results[idx] = wordsFromWindows(res, img);
      done++;
      onProgress?.(done, total, done / total);
      onPage?.(idx, results[idx]);
    }
  };
  try {
    await Promise.all(Array.from({ length: windowsPool(total) }, loop));
    return results;
  } catch (err) {
    if (signal.cancelled) throw new OcrCancelled();
    throw err;
  }
}

// letras que descem abaixo da linha de base (e pontuação que também desce)
const DESCENDERS = /[gjpqyçQJ,;()[\]{}|/_]/;

/**
 * Converte o resultado do OCR do Windows (linhas → palavras com retângulos) no mesmo formato de palavras do
 * Tesseract: início e fim da linha de base, espessura da linha e número da linha, em pixels da imagem
 * entregue pelo job. Numa foto torta o Windows mede a inclinação (angle) e devolve as posições na imagem
 * endireitada; elas são giradas de volta em torno do centro (conferido com a página de teste girada até 15°).
 */
export function wordsFromWindows({ angle, lines }, { width, height, pad = 0 }) {
  const t = ((angle || 0) * Math.PI) / 180, cos = Math.cos(t), sin = Math.sin(t);
  const cx = width / 2, cy = height / 2;
  const back = (x, y) => [cx + (x - cx) * cos - (y - cy) * sin - pad, cy + (x - cx) * sin + (y - cy) * cos - pad];
  const out = [];
  let n = 0;
  for (const line of lines || []) {
    const words = line.filter((w) => w[0].trim());
    if (!words.length) continue;
    n++;
    const top = Math.min(...words.map((w) => w[2]));
    const bottom = Math.max(...words.map((w) => w[2] + w[4]));
    const size = Math.max(1, bottom - top);
    // linha de base: fundo das palavras sem letras que descem (p, g, ç…) e que não são só pontuação
    const base = median(words.filter((w) => /[\p{L}\p{N}]/u.test(w[0]) && !DESCENDERS.test(w[0])).map((w) => w[2] + w[4]))
      ?? bottom - size * 0.2;
    for (const [text, x, , w] of words) {
      const [bx0, by0] = back(x, base);
      const [bx1, by1] = back(x + w, base);
      out.push({ text: text.trim(), bx0, by0, bx1, by1, size, line: n });
    }
  }
  return out;
}

// ------------------------------------------------------------------ Tesseract

async function recognizeTesseract(jobs, { lang = 'por+eng', onProgress, onPage, signal = { cancelled: false } } = {}) {
  const total = jobs.length;
  const size = poolSize(total);
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
  let finished = false;
  signal.terminate = () => {
    abort(new OcrCancelled());
    workers.forEach((w) => w.terminate().catch(() => {}));
  };
  if (signal.cancelled) throw new OcrCancelled();

  try {
    // Os workers são criados ao mesmo tempo (cada um carrega o motor e os idiomas).
    const pool = await guard(Promise.all(Array.from({ length: size }, async (_, i) => {
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
      creating.then((w) => {
        if (finished || signal.cancelled) w.terminate().catch(() => {});
        else workers.push(w);
      }, () => {});
      const worker = await creating;
      // Segmentação automática da página (PSM 3): detecta colunas, títulos, legendas e fotos.
      // Sem isso o Tesseract.js trata a página como um bloco único e junta as linhas de colunas vizinhas
      // (numa página de jornal: 23 de 33 linhas misturavam colunas e o erro subia de 0,5% para 3,3%).
      await worker.setParameters({ tessedit_pageseg_mode: Tesseract.PSM.AUTO });
      return worker;
    })));
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
          const p = toPpm(image);
          image = p.image;
          geo = { width: p.width, height: p.height, pad: p.pad };
        }
        // rotateAuto: o Tesseract mede a inclinação (foto torta, digitalização enviesada) e endireita a imagem
        // antes de analisar o layout; sem isso, linhas inclinadas são confundidas com colunas e picotadas.
        const { data } = await guard(w.recognize(image, { rotateAuto: !!geo.width }, { blocks: true, text: false }));
        image = null;
        results[idx] = wordsFromBlocks(data.blocks, { angle: data.rotateRadians || 0, ...geo });
        partial[i] = 0;
        done++;
        report();
        onPage?.(idx, results[idx]);
      }
    };
    await Promise.all(pool.map((w, i) => loop(w, i)));
    return results;
  } catch (err) {
    if (signal.cancelled) throw new OcrCancelled();
    throw err;
  } finally {
    finished = true;
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
 * @param geo.pad    margem branca acrescentada em cada lado (toPpm)
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
