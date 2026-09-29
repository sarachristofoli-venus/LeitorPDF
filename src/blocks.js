// Blocos de texto da página para o editor de matérias: palavras com posição → blocos (segment.js) → texto.
// Coordenadas "da página exibida": pontos, origem no canto SUPERIOR esquerdo, já com a rotação própria da
// página (/Rotate do PDF) aplicada — é o quadro de page.getViewport({ scale: 1, rotation: page.rotate }).
export { segment } from './segment.js';

const mul = (m, n) => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];

/**
 * Palavras a partir dos itens de texto do PDF.js (getTextContent). Cada item é dividido nos espaços, com a
 * largura repartida pelo número de caracteres (o PDF.js não dá a posição de cada letra). Pedaços de uma
 * mesma palavra que o PDF separou em itens encostados ("Alem" + "anha") são emendados.
 * @param items  textContent.items
 * @param vp0    page.getViewport({ scale: 1, rotation: page.rotate })
 */
export function wordsFromItems(items, vp0) {
  const words = [];
  items.forEach((it, idx) => {
    if (!it.str || !it.str.trim()) return;
    const m = mul(vp0.transform, it.transform); // texto → quadro exibido (y para baixo)
    const fs = Math.hypot(m[2], m[3]) || it.height;
    const adv = Math.hypot(m[0], m[1]);
    if (!fs || !adv || !(it.width >= 0)) return;
    const ux = m[0] / adv, uy = m[1] / adv;         // direção da escrita
    const vx = -m[2] / fs, vy = -m[3] / fs;         // direção "para cima" das letras
    const rot = Math.abs(uy) > 0.2 * Math.abs(ux) || ux < 0;
    const italic = !rot && Math.abs(m[2]) > 0.05 * Math.abs(m[3]);
    const n = it.str.length;
    const re = /\S+/g;
    const parts = [];
    let mm;
    while ((mm = re.exec(it.str))) parts.push([mm[0], mm.index, mm.index + mm[0].length]);
    parts.forEach(([text, i0, i1], k) => {
      const s0 = (it.width * i0) / n, s1 = (it.width * i1) / n;
      const eol = !!it.hasEOL && k === parts.length - 1;
      const edge = { first: k === 0 && i0 === 0, last: k === parts.length - 1 && i1 === n };
      if (rot) {
        const px = [m[4] + ux * s0, m[4] + ux * s1], py = [m[5] + uy * s0, m[5] + uy * s1];
        const xs = [], ys = [];
        for (let j = 0; j < 2; j++) {
          xs.push(px[j] + vx * fs * 0.8, px[j] - vx * fs * 0.2);
          ys.push(py[j] - vy * fs * 0.8, py[j] + vy * fs * 0.2);
        }
        const top = Math.min(...ys), bottom = Math.max(...ys);
        words.push({ text, x0: Math.min(...xs), x1: Math.max(...xs), top, bottom, base: (top + bottom) / 2, fs, italic: false, rot: true, item: idx, eol, font: it.fontName, edge });
      } else {
        const base = m[5];
        words.push({ text, x0: m[4] + s0, x1: m[4] + s1, top: base - fs * 0.8, bottom: base + fs * 0.2, base, fs, italic, rot: false, item: idx, eol, font: it.fontName, edge });
      }
    });
  });
  // emenda pedaços encostados vindos de itens diferentes (mudança de fonte no meio da palavra, ordinal "1º"…)
  const out = [];
  for (const w of words) {
    const p = out[out.length - 1];
    const f = p ? Math.min(p.fs, w.fs) : 0;
    // mesmo corpo de letra (senão é capitular, sobrescrito…) e mesma linha de base
    if (p && !p.rot && !w.rot && p.item !== w.item && p.edge.last && w.edge.first
      && Math.max(p.fs, w.fs) / f < 1.25 && Math.abs(p.base - w.base) < 0.25 * f
      && w.x0 - p.x1 < 0.12 * f && w.x0 - p.x1 > -0.3 * f) {
      p.text += w.text;
      p.x1 = Math.max(p.x1, w.x1);
      p.top = Math.min(p.top, w.top);
      p.bottom = Math.max(p.bottom, w.bottom);
      p.eol = w.eol;
      p.edge = { first: p.edge.first, last: w.edge.last };
      continue;
    }
    out.push(w);
  }
  for (const w of out) delete w.edge;
  return out;
}

/** Retângulo [x0, y0, x1, y1] de um conjunto de palavras. */
export function boundsOf(words, ids) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const i of ids) {
    const w = words[i];
    x0 = Math.min(x0, w.x0); y0 = Math.min(y0, w.top); x1 = Math.max(x1, w.x1); y1 = Math.max(y1, w.bottom);
  }
  return [x0, y0, x1, y1];
}

const median = (arr) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

const bare = (s) => s.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

/** Contagem das palavras (minúsculas, sem pontuação). Somada de várias páginas, serve de "dicionário" do documento. */
export function vocabularyOf(words, into = new Map()) {
  for (const w of words) {
    for (const part of w.text.split(/[-‐]/)) {
      const b = bare(part);
      if (b.length > 1) into.set(b, (into.get(b) || 0) + 1);
    }
    const whole = bare(w.text);
    if (whole.includes('-')) into.set(whole, (into.get(whole) || 0) + 1);
  }
  return into;
}
const count = (vocab, w) => (vocab ? vocab.get(w) || 0 : 0);

// Letras que sozinhas formam palavra em português: a capitular pode ser palavra ("O que…") ou só a
// primeira letra ("V" + "itória"). As demais sempre emendam na palavra seguinte.
const LETTER_WORDS = new Set(['a', 'e', 'o', 'à', 'é', 'ó', 'á', 'ô', 'ê']);
// início de palavra impossível em português: com a capitular vogal, é sinal de palavra partida ("E"+"ntre")
const BAD_START = /^(?:n[^haeiouáéíóúâêôãõ]|m[^aeiouáéíóúâêôãõ]|r[^aeiouáéíóúâêôãõh]|s[^aeiouáéíóúâêôãõh]|l[^aeiouáéíóúâêôãõh]|[bcdfgkpqtvxz][^aeiouáéíóúâêôãõrlh])/u;
const QUOTES_OPEN = /^[“"‘'«(\[]+/;

/** Capitular + resto da primeira palavra: emenda ("Vitória") ou separa ("O que"). */
function glueCap(cap, next, vocab) {
  const letter = cap.replace(QUOTES_OPEN, '');
  if (!/^\p{Ll}/u.test(next)) return false; // "O Supremo", "A 'Folha'…"
  if (!LETTER_WORDS.has(letter.toLowerCase())) return true;
  const joined = bare(letter + next), alone = bare(next);
  // a própria palavra partida conta 1 vez no vocabulário da página
  if (count(vocab, joined) > 0 && count(vocab, alone) <= 1) return true;
  if (count(vocab, alone) > 1) return false;
  return BAD_START.test(alone);
}

/**
 * Texto de um bloco. Parágrafos novos (recuo na primeira linha, ou linha anterior curta terminada em ponto)
 * viram "\n\n"; as demais quebras de linha ficam "\n" (o editor decide como juntar).
 * @param vocab  Map palavra → ocorrências no documento (para a capitular "A"+"udiência" → "Audiência")
 */
export function blockText(words, block, vocab = null) {
  if (block.kind === 'table' && block.rows?.length) {
    return block.rows
      .map((row) => row.map((cell) => cell.map((i) => words[i].text).join(' ')))
      .filter((cells) => cells.some(Boolean))
      .map((cells) => cells.join(' | '))
      .join('\n');
  }
  let lines = (block.lines?.length ? block.lines : [block.ids]).map((l) => [...l]);
  const all = lines.flat();
  if (!all.length) return '';
  const fsMed = median(all.map((i) => words[i].fs));

  // capitular: letra (ou algarismo, com aspas antes) bem maior que o texto, no canto superior esquerdo
  let cap = null, capBottom = -Infinity;
  if (all.length > 1) {
    const [bx0, by0] = boundsOf(words, all);
    const c = all.find((i) => {
      const w = words[i];
      return /^[\p{L}\p{N}]$/u.test(w.text.replace(QUOTES_OPEN, '')) && w.fs >= 1.6 * fsMed && w.x0 - bx0 < fsMed * 1.5 && w.top - by0 < w.fs;
    });
    if (c !== undefined) {
      cap = words[c].text;
      capBottom = words[c].bottom;
      lines = lines.map((l) => l.filter((i) => i !== c)).filter((l) => l.length);
    }
  }

  const texts = lines.map((l) => l.map((i) => words[i].text).join(' '));
  if (cap && texts.length) {
    const first = texts[0];
    const next = first.split(' ')[0] || '';
    texts[0] = cap + (glueCap(cap, next, vocab) ? '' : ' ') + first;
  }

  // parágrafos pela geometria das linhas (as linhas ao lado da capitular não são recuo)
  const geo = lines.map((l) => boundsOf(words, l));
  const free = geo.filter((g) => g[1] >= capBottom - fsMed * 0.3);
  const left = median((free.length ? free : geo).map((g) => g[0]));
  const right = Math.max(...geo.map((g) => g[2]));
  let out = texts[0] || '';
  for (let k = 1; k < texts.length; k++) {
    const indent = geo[k][1] >= capBottom - fsMed * 0.3 && geo[k][0] - left > fsMed * 0.6;
    const prevShort = right - geo[k - 1][2] > fsMed * 1.5 && /[.!?:]["”»’)]?$/.test(texts[k - 1]);
    out += (indent || prevShort ? '\n\n' : '\n') + texts[k];
  }
  return out;
}

// ------------------------------------------------------------------ Hífen no fim da linha
// Prefixos que pedem hífen e pronomes enclíticos: o hífen no fim da linha faz parte da palavra.
// (só prefixos que SEMPRE levam hífen: "auto", "anti", "sem"… também aparecem em quebras de sílaba comuns,
// como "sem-pre", e ficam de fora)
const HYPHEN_PREFIXES = new Set(['pré', 'pós', 'pró', 'ex', 'vice', 'recém', 'além', 'aquém', 'grã', 'grão', 'sota', 'soto']);
const COMPOUND_TAILS = /^(?:feira|feiras)$/u;

/**
 * "fim-" + "começo" na quebra de linha: emendar (hifenização da diagramação) ou manter o hífen
 * (palavra composta, sigla, número)? Devolve o texto junto.
 */
export function joinHyphen(left, right, vocab = null) {
  const lw = (left.slice(0, -1).match(/[\p{L}\p{N}]+$/u) || [''])[0];
  const rw = (right.match(/^[\p{L}\p{N}]+/u) || [''])[0];
  const keep = () => left + right;             // "PM-" + "ES" → "PM-ES"
  const join = () => left.slice(0, -1) + right; // "Capi-" + "xaba" → "Capixaba"
  if (!lw || !rw) return keep();
  if (/^[\p{Lu}\p{N}]/u.test(rw)) return keep();
  const l = lw.toLowerCase(), r = rw.toLowerCase();
  if (vocab) {
    if (count(vocab, `${l}-${r}`) > 0) return keep();
    if (count(vocab, l + r) > 0) return join();
  }
  // verbo + pronome ("fazê-lo", "trata-se", "comprou-o"). Quebras de sílaba parecidas ("esco-la", "des-se",
  // "fra-se", "análi-se") ficam de fora: o pronome só vale depois de vogal acentuada, de verbo em -a/-e com
  // 4+ letras (para "se") ou de pretérito em -ou/-eu/-iu.
  if (/^[\p{Ll}]/u.test(lw)) {
    if (['lo', 'la', 'los', 'las'].includes(r) && /[áâéêíóôú]$/u.test(l)) return keep();
    if (r === 'se' && /[ae]$/u.test(l) && l.length >= 4) return keep();
    if (['o', 'a', 'os', 'as', 'lhe', 'lhes', 'se'].includes(r) && /(?:ou|eu|iu)$/u.test(l)) return keep();
  }
  if (HYPHEN_PREFIXES.has(l) || COMPOUND_TAILS.test(r)) return keep();
  return join();
}

/** Junta as linhas de um trecho numa linha só (títulos, autor…), desfazendo a hifenização do fim de linha. */
export function oneLine(text, vocab = null) {
  const lines = text.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  let out = '';
  for (const ln of lines) {
    if (!out) out = ln;
    else if (/[\p{L}\p{N}]-$/u.test(out)) out = joinHyphen(out, ln, vocab);
    else out += ' ' + ln;
  }
  return out.replace(/\s{2,}/g, ' ').trim();
}

/** Corpo de texto: quebras simples viram espaço (ou emendam a palavra hifenizada), parágrafos ficam. */
export function bodyText(text, vocab = null) {
  return text
    .split(/\n{2,}/)
    .map((p) => oneLine(p, vocab))
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Acrescenta um trecho a um campo, como o Akaii: palavra hifenizada no fim do campo emenda com o trecho
 * seguinte; campo terminado em ponto, dois-pontos ou ponto e vírgula abre parágrafo novo; intertítulo
 * (linha curta sem pontuação) seguido de texto também; senão, continua a frase.
 */
export function appendTo(current, piece, { multiline, table = false, vocab = null }) {
  const cur = current.replace(/\s+$/, '');
  if (table && multiline) {
    // tabela: uma linha por linha da tabela, separada do texto anterior por um parágrafo
    piece = piece.split('\n').map((l) => l.replace(/\s{2,}/g, ' ').trim()).filter(Boolean).join('\n');
    return cur ? cur + '\n\n' + piece : piece;
  }
  piece = multiline ? bodyText(piece, vocab) : oneLine(piece, vocab);
  if (!piece) return current;
  if (!cur) return piece;
  if (/[\p{L}\p{N}]-$/u.test(cur)) return joinHyphen(cur, piece, vocab);
  if (multiline) {
    const lastPar = cur.slice(cur.lastIndexOf('\n') + 1);
    const sentenceEnd = /[.!?:;]$/.test(cur) || /[.!?]["”»’)]$/.test(cur);
    const heading = lastPar.length < 80 && !/[,;:\-–—(]$/.test(lastPar) && /^["“«]?\p{Lu}/u.test(piece);
    const afterTable = lastPar.includes(' | ');
    if (sentenceEnd || heading || afterTable) return cur + '\n\n' + piece;
  }
  return cur + ' ' + piece;
}

// ------------------------------------------------------------------ Autor
const PHOTO_LABEL = /^(?:fotos?|imagens?|arte|artes|ilustra[çc][ãa]o|infografia|infogr[áa]fico|montagem|reprodu[çc][ãa]o)\s*:/i;
const NEW_PART = /^(?:fotos?|imagens?|arte|artes|ilustra[çc][ãa]o|infografia|infogr[áa]fico|montagem|reprodu[çc][ãa]o|texto|textos|reportagem|edi[çc][ãa]o|colabora[çc][ãa]o)\s*:|^(?:por|de)\s/i;

/** Limpa a linha do autor: "Por Fulano / Foto: Divulgação" → "Fulano"; "Fotos: X | Texto: Y" → "Y". */
export function cleanAuthor(text) {
  // linhas: uma linha que não começa um item novo é continuação do nome (quebra dentro do nome)
  const lines = text.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  const merged = [];
  for (const ln of lines) {
    if (!merged.length || NEW_PART.test(ln) || /[|/·•]$/.test(merged[merged.length - 1])) merged.push(ln);
    else merged[merged.length - 1] += ' ' + ln;
  }
  const parts = merged
    .join(' | ')
    .replace(/\s+(?=(?:fotos?|imagens?|arte|ilustra[çc][ãa]o|infografia|texto|reportagem)\s*:)/gi, ' | ')
    .split(/\s*(?:\||·|•|\s\/\s|\s[–—]\s)\s*/);
  const names = [];
  for (let p of parts) {
    p = p.trim();
    if (!p || PHOTO_LABEL.test(p)) continue;
    p = p
      .replace(/^(?:por|de)\s+/i, '')
      .replace(/^(?:texto|textos|reportagem|colabora[çc][ãa]o)\s*:\s*/i, '')
      .replace(/\S+@\S+/g, '')
      .replace(/\bda reda[çc][ãa]o\b/i, '')
      .replace(/[\s,;/|]+$/, '')
      .replace(/^[\s,;/|]+/, '')
      .trim();
    if (p) names.push(p);
  }
  return names.join(', ');
}
