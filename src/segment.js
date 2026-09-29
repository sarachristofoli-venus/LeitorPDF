// Segmentação da página em blocos para o editor de matérias. Escolhida num banco de teste com o Diário do
// Noroeste (blocos do Akaii como referência), páginas sintéticas e um conjunto oculto: F1 99,9 / 100 / 100, e
// o mesmo com palavras de OCR (posições imprecisas). Entrada: palavras de blocks.js; saída: blocos com linhas
// (texto) ou linhas/células (tabela). Palavras sem "font" (vindas do OCR) usam tolerâncias maiores.
//
// Abordagem — abordagem "de cima para baixo" (cortes X-Y recursivos).
//
// Ideia geral:
//   1. palavras giradas (rot) saem da análise e viram blocos próprios;
//   2. letras capitulares são detectadas e retiradas (voltam no fim, unidas ao texto que iniciam);
//   3. a página é cortada recursivamente pelos vãos em branco: calhas verticais (entre colunas) e faixas
//      horizontais (entre título, subtítulo, colunas...). Os limiares são relativos à fonte das palavras
//      vizinhas do vão e ao entrelinha medido na própria página;
//   4. quando um corte vertical revela várias colunas estreitas com linhas alinhadas e células curtas,
//      a região vira uma TABELA (um bloco só, com rows/células);
//   5. em cada região-folha, as linhas ainda são separadas quando o tamanho da fonte muda muito.
// Sem dependências, sem DOM. Coordenadas em pontos, origem no canto superior esquerdo.

// ---------- utilidades ----------
// Nos cortes horizontais usa-se só o "miolo" vertical de cada palavra (60% central da caixa): com OCR as
// caixas de linhas vizinhas chegam a se sobrepor, e o miolo mantém um vão positivo entre linhas.
const CORE = 0.6;
function median(arr) {
  if (!arr.length) return 0;
  const s = Float64Array.from(arr).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const nch = (w) => Math.max(1, w.text ? w.text.length : 1);

// estilo dominante de um conjunto de palavras (ponderado pelo nº de caracteres)
function styleOf(W, ids) {
  let tot = 0, ita = 0;
  const fonts = new Map();
  const byFs = [];
  for (const i of ids) {
    const w = W[i], n = nch(w);
    tot += n;
    if (w.italic) ita += n;
    if (w.font) fonts.set(w.font, (fonts.get(w.font) || 0) + n);
    byFs.push([w.fs, n]);
  }
  byFs.sort((a, b) => a[0] - b[0]);
  let acc = 0, fs = byFs.length ? byFs[0][0] : 0;
  for (const [f, n] of byFs) { acc += n; if (acc >= tot / 2) { fs = f; break; } }
  let font = null, best = 0;
  for (const [f, n] of fonts) if (n > best) { best = n; font = f; }
  return { fs, italic: ita > tot / 2, font, fontShare: tot ? best / tot : 0 };
}
const fsRatio = (a, b) => Math.max(a, b) / Math.max(1e-6, Math.min(a, b));
// Limiares de razão entre tamanhos de fonte. Sem nome de fonte (OCR) o tamanho é só uma estimativa pela
// altura da linha, então as tolerâncias crescem (ajustado em segment()).
const TH = { soft: 1.08, big: 1.25 };
// estilos diferentes: tamanho um pouco diferente, itálico ou fonte (quando o PDF informa a fonte)
function styleDiff(a, b) {
  if (fsRatio(a.fs, b.fs) >= TH.soft) return true;
  if (a.italic !== b.italic) return true;
  if (a.font && b.font && a.font !== b.font && a.fontShare > 0.6 && b.fontShare > 0.6) return true;
  return false;
}

// linhas (fileiras) de um conjunto de palavras: agrupa por linha de base (média corrente, tolerante a
// ruído de OCR); o campo "item" só ajuda: palavras do mesmo item com base próxima ficam na mesma linha
function rowsOf(W, ids) {
  const s = ids.slice().sort((a, b) => W[a].base - W[b].base);
  const rows = [];
  const byItem = new Map();
  let cur = null;
  for (const i of s) {
    const w = W[i];
    let r = null;
    const ri = w.item != null ? byItem.get(w.item) : null;
    if (ri && Math.abs(ri.base - w.base) <= 0.8 * w.fs) r = ri;
    else if (cur && w.base - cur.base <= 0.5 * Math.min(cur.fs, w.fs)) r = cur;
    if (r) {
      r.ids.push(i);
      r.n++;
      r.base += (w.base - r.base) / r.n;
    } else {
      r = cur = { ids: [i], base: w.base, fs: w.fs, n: 1 };
      rows.push(r);
    }
    if (w.item != null) byItem.set(w.item, r);
  }
  return rows;
}

// ---------- entrelinha típico da página ----------
// Para cada palavra, procura a palavra logo abaixo (sobreposição horizontal, mesma fonte) e mede
// passo/fs. O entrelinha "normal" de um tamanho de fonte é a mediana desses passos.
function makeLead(W, ids) {
  const s = ids.slice().sort((a, b) => W[a].base - W[b].base);
  const samples = [];
  for (let k = 0; k < s.length; k++) {
    const w = W[s[k]];
    let best = Infinity;
    for (let j = k + 1; j < s.length; j++) {
      const v = W[s[j]];
      const d = v.base - w.base;
      if (d > 2.5 * w.fs) break;
      if (d < 0.6 * w.fs) continue;
      if (fsRatio(v.fs, w.fs) > 1.1) continue;
      if (Math.min(v.x1, w.x1) - Math.max(v.x0, w.x0) <= 0) continue;
      if (d < best) best = d;
    }
    if (best < Infinity) samples.push([w.fs, best / w.fs]);
  }
  const global = samples.length ? median(samples.map((x) => x[1])) : 1.15;
  const cache = new Map();
  return (fs) => {
    const key = Math.round(fs * 4);
    if (cache.has(key)) return cache.get(key);
    // com fs estimado (OCR) a janela é mais larga, senão a mediana fica enviesada pelo erro de fs
    const r = samples.filter((x) => Math.abs(x[0] - fs) <= (TH.soft > 1.1 ? 0.25 : 0.1) * fs).map((x) => x[1]);
    const v = r.length >= 8 ? median(r) : global;
    cache.set(key, v);
    return v;
  };
}

// ---------- letras capitulares ----------
// Letra isolada, bem maior que o texto à sua direita, com linhas menores começando logo depois dela
// (na altura dela) e texto continuando por baixo, alinhado à sua esquerda.
function findDropcaps(W, ids) {
  const caps = new Map(); // id da capitular -> id da palavra-âncora (1ª palavra do texto)
  for (const i of ids) {
    const c = W[i];
    const t = (c.text || '').replace(/[“"‘'«(\[]/g, '');
    if (t.length !== 1 || !/[\p{L}\p{N}]/u.test(t)) continue;
    let anchor = -1, bd = Infinity, bodyFs = 0, nRight = 0;
    for (const j of ids) {
      if (j === i) continue;
      const v = W[j];
      if (v.fs * 1.8 > c.fs) continue;
      // à direita, colado na capitular, com a linha de base dentro da altura da capitular
      if (v.x0 < c.x1 - 0.1 * c.fs || v.x0 > c.x1 + 0.6 * c.fs) continue;
      if (v.base < c.top + 0.15 * c.fs || v.base > c.bottom + 0.3 * v.fs) continue;
      nRight++;
      const d = Math.abs(v.top - c.top) + 0.01 * (v.x0 - c.x1);
      if (d < bd) { bd = d; anchor = j; bodyFs = v.fs; }
    }
    if (anchor < 0) continue;
    // o texto continua abaixo, começando no alinhamento esquerdo da capitular (ou há 2+ linhas ao lado)
    let below = false;
    for (const j of ids) {
      const v = W[j];
      if (j === i || v.fs * 1.8 > c.fs) continue;
      if (Math.abs(v.x0 - c.x0) <= 0.8 * bodyFs && v.top >= c.bottom - 1.5 * bodyFs && v.top <= c.bottom + 1.5 * bodyFs) { below = true; break; }
    }
    if (!below && nRight < 2) continue;
    caps.set(i, anchor);
  }
  return caps;
}

// ---------- vãos verticais (calhas) ----------
function projGaps(W, ids, lo, hi) {
  const s = ids.slice().sort((a, b) => W[a][lo] - W[b][lo]);
  const gaps = [];
  let mx = W[s[0]][hi];
  for (let k = 1; k < s.length; k++) {
    const w = W[s[k]];
    if (w[lo] > mx) gaps.push([mx, w[lo]]);
    if (w[hi] > mx) mx = w[hi];
  }
  return gaps;
}

// avalia um vão vertical [a,b]; devolve a "força" (vão / fonte) ou 0 se não é corte válido
function vGapScore(W, rows, a, b, strict = false) {
  const g = b - a;
  const L = [], R = [];
  for (const r of rows) {
    let lw = -1, rw = -1;
    for (const i of r.ids) {
      const w = W[i];
      if (w.x1 <= a + 1e-6) { if (lw < 0 || w.x1 > W[lw].x1) lw = i; }
      else if (w.x0 >= b - 1e-6) { if (rw < 0 || w.x0 < W[rw].x0) rw = i; }
    }
    if (lw >= 0) L.push(lw);
    if (rw >= 0) R.push(rw);
  }
  if (!L.length || !R.length) return 0;
  // fonte dos vizinhos imediatos do vão
  const nearL = L.filter((i) => a - W[i].x1 <= 1.5 * W[i].fs);
  const nearR = R.filter((i) => W[i].x0 - b <= 1.5 * W[i].fs);
  const fsL = median((nearL.length ? nearL : L).map((i) => W[i].fs));
  const fsR = median((nearR.length ? nearR : R).map((i) => W[i].fs));
  const fsMin = Math.min(fsL, fsR);
  if (g < 0.35 * fsMin) return 0;
  const score = g / fsMin;
  // alinhamento das bordas: início das linhas à direita / fim das linhas à esquerda
  const aligned = (vals, ref, tol) => vals.filter((x) => Math.abs(x - ref) <= tol).length;
  const tol = 0.35 * fsMin;
  const xr = nearR.map((i) => W[i].x0), xl = nearL.map((i) => W[i].x1);
  const refR = median(xr.filter((x) => x <= b + 0.5 * fsMin)), refL = median(xl.filter((x) => x >= a - 0.5 * fsMin));
  const nAR = xr.length ? aligned(xr, refR, tol) : 0, nAL = xl.length ? aligned(xl, refL, tol) : 0;
  const alignedOk = (nAR >= 3 && nAR >= 0.6 * R.length) || (nAL >= 3 && nAL >= 0.6 * L.length);
  if (alignedOk) return score;
  if (strict) return 0;
  // sem bordas alinhadas: só vale um vão bem largo (maior que qualquer espaço entre palavras)
  const bigK = rows.length >= 3 ? 2.0 : 1.2;
  if (g >= bigK * fsMin) return score;
  if (fsRatio(fsL, fsR) >= TH.big && g >= 0.6 * fsMin) return score;
  return 0;
}

// ---------- vãos horizontais ----------
function hGapScore(W, ids, a, b, ctx, X0, X1) {
  const { lead, capAnchors } = ctx;
  let g = b - a;
  const above = [], below = [];
  for (const i of ids) {
    const w = W[i];
    if (w.cb <= a + 1e-6 && w.cb >= a - 0.6 * w.fs) above.push(i);
    else if (w.ct >= b - 1e-6 && w.ct <= b + 0.6 * w.fs) below.push(i);
  }
  if (!above.length || !below.length) return 0;
  const sA = styleOf(W, above), sB = styleOf(W, below);
  const fsMin = Math.min(sA.fs, sB.fs);
  // tamanho do vão pelas medianas das linhas vizinhas (o vão da projeção é um extremo, sensível a ruído)
  const gm = median(below.map((i) => W[i].ct)) - median(above.map((i) => W[i].cb));
  // if (gm > g) g = gm;
  // vão normal entre linhas deste tamanho (medido entre os "miolos" das palavras, ver coreBox)
  const g0 = Math.max(0, (lead(fsMin) - CORE) * fsMin);
  const ex = (g - g0) / fsMin; // vão "extra" em unidades de fonte
  if (ex >= 1.0) return ex + 1;
  // mudança de estilo medida coluna a coluna: cada palavra de baixo é comparada com as de cima
  // que se sobrepõem a ela na horizontal (evita misturar colunas vizinhas)
  let tot = 0, big = 0, soft = 0;
  for (const j of below) {
    const v = W[j];
    const up = above.filter((i) => Math.min(W[i].x1, v.x1) - Math.max(W[i].x0, v.x0) > 0);
    if (!up.length) continue;
    const su = styleOf(W, up), sv = styleOf(W, [j]), n = nch(v);
    tot += n;
    if (fsRatio(sv.fs, su.fs) >= TH.big) big += n;
    if (styleDiff(sv, su)) soft += n;
  }
  const bigFrac = tot ? big / tot : 0, softFrac = tot ? soft / tot : 1;
  if (bigFrac >= 0.5 && g >= 0.25 * fsMin) return Math.max(ex, 0) + 0.5;
  if (softFrac >= 0.5 && ex >= 0.3) return ex;
  if (ex >= 0.8) return ex;
  if (ex >= 0.3) {
    // mesmo estilo, vão médio. Corta se o corte revela calhas verticais (ex.: legenda larga sobre duas
    // colunas) ou se a margem esquerda muda; senão, só com vão ≥ 0,5 fonte e sem cara de parágrafo
    const mid = (a + b) / 2;
    const up = ids.filter((i) => W[i].ct + W[i].cb < 2 * mid), dn = ids.filter((i) => W[i].ct + W[i].cb >= 2 * mid);
    if (hasVCut(W, up) || hasVCut(W, dn)) return ex;
    // as margens do texto mudam de um lado para o outro do vão (ex.: quadro estreito sobre uma coluna)
    if (edgeShift(W, up, dn, a, b, fsMin, ctx.capBoxes) > 2.0) return ex;
    if (ex < 0.5) return 0;
    // troca de parágrafo: a linha de baixo começa recuada (a primeira linha do bloco ao lado de uma
    // capitular não conta como recuo)
    const dnX0 = Math.min(...below.map((i) => W[i].x0));
    const indent = dnX0 > X0 + 0.4 * fsMin && dnX0 < X0 + 4 * fsMin && !below.some((i) => capAnchors.has(i));
    if (!indent) return ex;
  }
  return 0;
}

// deslocamento (em fontes) da margem esquerda típica das ~4 linhas acima e abaixo de um vão
// (a direita não serve: em coluna estreita, linha de uma palavra só não chega à margem)
function edgeShift(W, up, dn, a, b, fs, caps) {
  // linha ao lado de uma capitular começa, na prática, na margem esquerda da capitular
  const rowLeft = (r) => {
    const x = Math.min(...r.ids.map((i) => W[i].x0));
    const c = caps.find((c) => x >= c.x1 - 0.2 * c.fs && x <= c.x1 + 0.6 * c.fs && r.base >= c.top && r.base <= c.bottom + 0.5 * r.fs);
    return c ? c.x0 : x;
  };
  const left = (ids) => median(rowsOf(W, ids).map(rowLeft));
  const zu = up.filter((i) => W[i].cb >= a - 4.5 * W[i].fs), zd = dn.filter((i) => W[i].ct <= b + 4.5 * W[i].fs);
  if (!zu.length || !zd.length) return 0;
  return Math.abs(left(zu) - left(zd)) / fs;
}

// há calha vertical sustentada por bordas alinhadas (3+ linhas)?
function hasVCut(W, ids) {
  if (ids.length < 6) return false;
  const rows = rowsOf(W, ids);
  if (rows.length < 3) return false;
  return projGaps(W, ids, 'x0', 'x1').some(([a, b]) => vGapScore(W, rows, a, b, true) > 0);
}

// ---------- tabela ----------
// Faixas vizinhas (resultado de um corte vertical) cujas linhas de base coincidem podem formar uma tabela.
// Testa cada intervalo contíguo de faixas "encadeadas": é tabela se há 4+ linhas seguidas que atravessam
// 2+ faixas e TODAS as colunas têm cara de célula (texto curto, que não enche a coluna como texto corrido).
function rowsMatch(A, B) {
  let m = 0;
  for (const r of A) if (B.some((q) => Math.abs(q.base - r.base) <= 0.5 * Math.min(q.fs, r.fs))) m++;
  return m;
}
function tableCandidate(W, strips, k0, k1) {
  const sidx = new Map();
  for (let k = k0; k <= k1; k++) for (const i of strips[k]) sidx.set(i, k);
  const rows = rowsOf(W, [...sidx.keys()]);
  const nsp = rows.map((r) => new Set(r.ids.map((i) => sidx.get(i))).size);
  // linhas com corpo de letra muito diferente do da tabela (ex.: o título dela) não entram
  const rfs = rows.map((r) => styleOf(W, r.ids).fs);
  const tfs = median(rfs.filter((_, k) => nsp[k] >= 2));
  const elig = rfs.map((f) => fsRatio(f, tfs) < TH.soft + 0.07);
  const span = nsp.map((n, k) => (elig[k] ? n : 0));
  let best = null;
  // sequências de linhas que cruzam 2+ faixas (tolera até 2 linhas isoladas no meio: célula quebrada)
  let st = -1;
  for (let k = 0; k <= rows.length; k++) {
    const ok = k < rows.length && (span[k] >= 2 || (st >= 0 && span[k] && ((k + 1 < rows.length && span[k + 1] >= 2) || (k + 2 < rows.length && span[k + 2] >= 2))));
    if (ok) { if (st < 0) st = k; continue; }
    if (st < 0) continue;
    let r0 = st, r1 = k - 1;
    st = -1;
    if (r1 - r0 + 1 < 4) continue;
    // continuação da última célula (quebrou em mais linhas) logo abaixo, no mesmo passo
    const pitch = median(rows.slice(r0 + 1, r1 + 1).map((r, j) => r.base - rows[r0 + j].base));
    while (r1 + 1 < rows.length && span[r1 + 1] === 1 && r1 + 1 - k < 2 && rows[r1 + 1].base - rows[r1].base <= 1.5 * pitch) r1++;
    const runRows = rows.slice(r0, r1 + 1);
    const tw = runRows.flatMap((r) => r.ids);
    const cuts = projGaps(W, tw, 'x0', 'x1').filter(([a, b]) => vGapScore(W, runRows, a, b) > 0);
    if (!cuts.length) continue;
    const bounds = cuts.map(([a, b]) => (a + b) / 2);
    const nc = bounds.length + 1;
    const colOf = (w) => { let c = 0; while (c < bounds.length && (w.x0 + w.x1) / 2 > bounds[c]) c++; return c; };
    const cx0 = new Array(nc).fill(Infinity), cx1 = new Array(nc).fill(-Infinity);
    for (const i of tw) { const c = colOf(W[i]); cx0[c] = Math.min(cx0[c], W[i].x0); cx1[c] = Math.max(cx1[c], W[i].x1); }
    const fills = Array.from({ length: nc }, () => []), nws = new Array(nc).fill(0);
    const fsT = median(tw.map((i) => W[i].fs));
    let cells = 0, broken = 0;
    for (const r of runRows) {
      const e0 = new Array(nc).fill(Infinity), e1 = new Array(nc).fill(-Infinity), cnt = new Array(nc).fill(0);
      for (const i of r.ids) { const c = colOf(W[i]); e0[c] = Math.min(e0[c], W[i].x0); e1[c] = Math.max(e1[c], W[i].x1); cnt[c]++; }
      for (let c = 0; c < nc; c++) if (cnt[c]) { cells++; nws[c] += cnt[c]; fills[c].push((e1[c] - e0[c]) / Math.max(1e-6, cx1[c] - cx0[c])); }
      // célula de tabela é um trecho contínuo: um buraco grande dentro dela indica colunas de outra coisa
      const xs = r.ids.map((i) => W[i]).sort((u, v) => u.x0 - v.x0);
      for (let j = 1; j < xs.length; j++) if (colOf(xs[j]) === colOf(xs[j - 1]) && xs[j].x0 - Math.max(...xs.slice(0, j).map((u) => u.x1)) > 1.5 * fsT) { broken++; break; }
    }
    if (broken > 0.1 * runRows.length) continue;
    // cada coluna: células curtas (não enchem a largura) ou de 1-2 palavras
    const cellLike = fills.every((f, c) => f.length && (median(f) <= 0.8 || nws[c] / f.length <= 1.6));
    const occ = cells / (runRows.length * nc);
    // colunas no mesmo corpo de letra e próximas entre si (não duas matérias separadas por uma foto)
    const colFs = Array.from({ length: nc }, () => []);
    for (const i of tw) colFs[colOf(W[i])].push(W[i].fs);
    const mf = colFs.map((f) => median(f));
    const sameFs = Math.max(...mf) / Math.min(...mf) < TH.soft + 0.07;
    const widest = Math.max(...cx1.map((x, c) => x - cx0[c]));
    const near = cuts.every(([a, b]) => b - a <= Math.max(4 * fsT, widest));
    // linhas num passo regular (linhas de matérias diferentes lado a lado não mantêm o passo)
    const steps = runRows.slice(1).map((r, j) => (r.base - runRows[j].base) / pitch);
    const regular = steps.filter((d) => d >= 0.6 && d <= 1.4).length >= 0.8 * steps.length;
    if (cellLike && sameFs && near && regular && occ >= 0.5 && (!best || tw.length > best.ids.length)) best = { k0, k1, ids: tw, bounds };
  }
  return best;
}
function tableTest(W, strips) {
  const sr = strips.map((s) => rowsOf(W, s));
  const link = [];
  for (let k = 0; k + 1 < strips.length; k++) {
    const m = Math.min(rowsMatch(sr[k], sr[k + 1]), rowsMatch(sr[k + 1], sr[k]));
    link.push(m >= 4 && m >= 0.6 * Math.min(sr[k].length, sr[k + 1].length));
  }
  let best = null;
  for (let k0 = 0; k0 < strips.length; k0++) {
    for (let k1 = k0 + 1; k1 < strips.length && link[k1 - 1]; k1++) {
      const t = tableCandidate(W, strips, k0, k1);
      if (t && (!best || t.ids.length > best.ids.length)) best = t;
    }
  }
  return best;
}

// ---------- corte X-Y recursivo ----------
function xycut(W, ids, out, ctx, depth) {
  if (!ids.length) return;
  if (ids.length === 1 || depth > 80) { out.push({ ids, kind: 'text' }); return; }
  const rows = rowsOf(W, ids);
  let X0 = Infinity, X1 = -Infinity;
  for (const i of ids) { if (W[i].x0 < X0) X0 = W[i].x0; if (W[i].x1 > X1) X1 = W[i].x1; }
  // candidatos verticais e horizontais
  const vg = projGaps(W, ids, 'x0', 'x1').map(([a, b]) => [a, b, vGapScore(W, rows, a, b)]).filter((g) => g[2] > 0);
  const hg = projGaps(W, ids, 'ct', 'cb').map(([a, b]) => [a, b, hGapScore(W, ids, a, b, ctx, X0, X1)]).filter((g) => g[2] > 0);
  const vBest = vg.reduce((m, g) => Math.max(m, g[2]), 0), hBest = hg.reduce((m, g) => Math.max(m, g[2]), 0);
  if (vg.length && vBest >= hBest) {
    const bounds = vg.map(([a, b]) => (a + b) / 2);
    const strips = bounds.map(() => []);
    strips.push([]);
    for (const i of ids) { const cx = (W[i].x0 + W[i].x1) / 2; let k = 0; while (k < bounds.length && cx > bounds[k]) k++; strips[k].push(i); }
    const t = tableTest(W, strips);
    if (t) {
      // faixas antes da tabela | (acima da tabela, tabela, abaixo) | faixas depois
      const inT = new Set(t.ids);
      const topB = Math.min(...t.ids.map((i) => W[i].base));
      for (let k = 0; k < t.k0; k++) xycut(W, strips[k], out, ctx, depth + 1);
      const mid = [];
      for (let k = t.k0; k <= t.k1; k++) mid.push(...strips[k]);
      xycut(W, mid.filter((i) => !inT.has(i) && W[i].base < topB), out, ctx, depth + 1);
      out.push({ ids: t.ids, kind: 'table', bounds: t.bounds });
      xycut(W, mid.filter((i) => !inT.has(i) && W[i].base >= topB), out, ctx, depth + 1);
      for (let k = t.k1 + 1; k < strips.length; k++) xycut(W, strips[k], out, ctx, depth + 1);
      return;
    }
    for (const s of strips) xycut(W, s, out, ctx, depth + 1);
    return;
  }
  if (hg.length) {
    const bounds = hg.map(([a, b]) => (a + b) / 2);
    const bands = bounds.map(() => []);
    bands.push([]);
    for (const i of ids) { const cy = (W[i].ct + W[i].cb) / 2; let k = 0; while (k < bounds.length && cy > bounds[k]) k++; bands[k].push(i); }
    for (const s of bands) xycut(W, s, out, ctx, depth + 1);
    return;
  }
  out.push({ ids, kind: 'text' });
}

// ---------- folha: separa linhas por mudança forte de tamanho ----------
function splitLeaf(W, ids) {
  const rows = rowsOf(W, ids);
  const blocks = [];
  let cur = null, curSt = null;
  for (const r of rows) {
    const st = styleOf(W, r.ids);
    if (cur && fsRatio(st.fs, curSt.fs) < TH.big) { cur.push(r); curSt = st; continue; }
    cur = [r];
    curSt = st;
    blocks.push(cur);
  }
  return blocks.map((rs) => rs.map((r) => r.ids.slice().sort((a, b) => W[a].x0 - W[b].x0)));
}

// ---------- tabela: linhas → células ----------
// Cada linha de base vira uma linha da tabela; as células são dadas pelas calhas entre colunas.
// Linha com poucas células logo abaixo de outra (célula que quebrou em 2 linhas) é somada à anterior.
function buildTable(W, ids, bounds) {
  const nc = bounds.length + 1;
  const rows = rowsOf(W, ids).map((r) => {
    const cells = Array.from({ length: nc }, () => []);
    for (const i of r.ids) { const cx = (W[i].x0 + W[i].x1) / 2; let c = 0; while (c < bounds.length && cx > bounds[c]) c++; cells[c].push(i); }
    return cells;
  });
  const filled = rows.map((cells) => cells.filter((c) => c.length).length);
  const typical = median(filled);
  const out = [];
  rows.forEach((cells, k) => {
    const prev = out[out.length - 1];
    if (prev && filled[k] < typical / 2 && filled[k] < nc) cells.forEach((c, j) => prev[j].push(...c));
    else out.push(cells);
  });
  return out.map((cells) => cells.map((c) => c.sort((a, b) => W[a].base - W[b].base || W[a].x0 - W[b].x0)));
}

// ---------- palavras giradas: agrupamento por proximidade ----------
function rotBlocks(W, ids) {
  const par = new Map(ids.map((i) => [i, i]));
  const find = (x) => { while (par.get(x) !== x) { par.set(x, par.get(par.get(x))); x = par.get(x); } return x; };
  for (let a = 0; a < ids.length; a++) for (let b = a + 1; b < ids.length; b++) {
    const u = W[ids[a]], v = W[ids[b]], f = Math.min(u.fs, v.fs);
    const dx = Math.max(0, Math.max(u.x0, v.x0) - Math.min(u.x1, v.x1)), dy = Math.max(0, Math.max(u.top, v.top) - Math.min(u.bottom, v.bottom));
    if (dx <= 0.6 * f && dy <= 1.5 * f) par.set(find(ids[a]), find(ids[b]));
  }
  const groups = new Map();
  for (const i of ids) { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(i); }
  const out = [];
  for (const g of groups.values()) {
    // linhas verticais = mesma faixa em x; ordem das palavras segue a ordem do texto (índice)
    const s = g.slice().sort((a, b) => (W[a].x0 + W[a].x1) - (W[b].x0 + W[b].x1));
    const lines = [];
    for (const i of s) {
      const cx = (W[i].x0 + W[i].x1) / 2;
      const l = lines.find((L) => Math.abs(L.cx - cx) <= 0.5 * W[i].fs);
      if (l) l.ids.push(i); else lines.push({ cx, ids: [i] });
    }
    for (const l of lines) l.ids.sort((a, b) => a - b);
    // texto subindo (girado anti-horário): 1ª linha à esquerda; descendo: 1ª linha à direita
    const l0 = lines.find((l) => l.ids.length > 1);
    const up = l0 ? W[l0.ids[0]].bottom > W[l0.ids[l0.ids.length - 1]].bottom : true;
    if (!up) lines.reverse();
    out.push({ ids: lines.flatMap((l) => l.ids), kind: 'text', lines: lines.map((l) => l.ids) });
  }
  return out;
}

// ---------- entrada principal ----------
export function segment(words, page) {
  const N = words.length;
  if (!N) return [];
  // cópia local com o miolo vertical (ct..cb) de cada palavra
  const W = words.map((w) => {
    const h = Math.max(1e-3, w.bottom - w.top), m = (1 - CORE) / 2;
    return { text: w.text, x0: w.x0, x1: w.x1, top: w.top, bottom: w.bottom, ct: w.top + m * h, cb: w.bottom - m * h, base: w.base, fs: w.fs > 0 ? w.fs : h, italic: !!w.italic, font: w.font, rot: !!w.rot, item: w.item };
  });
  const all = [...Array(N).keys()];
  const withFont = W.filter((w) => w.font).length;
  const noisy = withFont < 0.5 * N;
  TH.soft = noisy ? 1.2 : 1.08;
  TH.big = noisy ? 1.35 : 1.25;
  const rot = all.filter((i) => W[i].rot);
  const flat = all.filter((i) => !W[i].rot);
  const caps = findDropcaps(W, flat);
  const main = flat.filter((i) => !caps.has(i));
  const ctx = { lead: makeLead(W, main), capAnchors: new Set(caps.values()), capBoxes: [...caps.keys()].map((i) => W[i]) };
  const leaves = [];
  if (main.length) xycut(W, main, leaves, ctx, 0);

  const blocks = [];
  for (const lf of leaves) {
    if (lf.kind === 'table') {
      const rows = buildTable(W, lf.ids, lf.bounds);
      blocks.push({ ids: rows.flat(2), kind: 'table', rows });
    } else {
      for (const lines of splitLeaf(W, lf.ids)) blocks.push({ ids: lines.flat(), kind: 'text', lines });
    }
  }
  // capitulares: entram no início da linha da palavra-âncora
  const where = new Map();
  blocks.forEach((b, k) => b.ids.forEach((i) => where.set(i, k)));
  for (const [c, anc] of caps) {
    const b = blocks[where.get(anc)];
    if (!b) { blocks.push({ ids: [c], kind: 'text', lines: [[c]] }); continue; }
    b.ids.unshift(c);
    if (b.kind === 'text') { const ln = b.lines.find((l) => l.includes(anc)) || b.lines[0]; ln.unshift(c); }
    else { const row = b.rows.find((r) => r.some((cell) => cell.includes(anc))) || b.rows[0]; row[0].unshift(c); }
  }
  if (rot.length) blocks.push(...rotBlocks(W, rot));
  return blocks;
}
