// Anotações: modelo, geometria (seleção → quadriláteros no espaço do PDF) e desenho.
import { PDFDateString } from '../node_modules/pdfjs-dist/build/pdf.min.mjs';

export const COLORS = [
  ['#ffd83d', 'Amarelo'],
  ['#7bd96b', 'Verde'],
  ['#5db2ff', 'Azul'],
  ['#ff7eb8', 'Rosa'],
  ['#ffa53d', 'Laranja'],
  ['#f04438', 'Vermelho'],
];

export const TYPE_LABEL = {
  highlight: 'Marca-texto',
  underline: 'Sublinhado',
  strikeout: 'Tachado',
  note: 'Nota',
};

const IMPORT_TYPES = { Highlight: 'highlight', Underline: 'underline', Squiggly: 'underline', StrikeOut: 'strikeout', Text: 'note' };
const SVG_NS = 'http://www.w3.org/2000/svg';
export const NOTE_SIZE = 22; // em pontos do PDF

export const newId = () => 'lp-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/** Estado que importa para decidir se uma anotação importada foi alterada. */
export const snapshotOf = (a) => JSON.stringify([a.type, a.page, a.color, a.opacity, a.quads, a.rect, a.comment]);

export const plain = (a) => {
  const { ref, ...rest } = a;
  return rest;
};

const rgbToHex = (c) => '#' + [...c].slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
const pdfDate = (s) => (s ? PDFDateString.toDateObject(s)?.getTime() : null) || null;

/** Converte uma anotação lida pelo PDF.js para o modelo do app (ou null se não for suportada). */
export function fromPdfJs(d, pageNum) {
  const type = IMPORT_TYPES[d.subtype];
  if (!type || !/^\d+R\d*$/.test(d.id) || d.inReplyTo) return null;
  const [x1, y1, x2, y2] = d.rect;
  const a = {
    id: 'pdf-' + d.id,
    ref: d.id,
    type,
    page: pageNum,
    color: d.color ? rgbToHex(d.color) : '#ffd83d',
    opacity: type === 'highlight' ? (d.opacity ?? 1) : 1,
    comment: d.contentsObj?.str || '',
    author: d.titleObj?.str || '',
    created: pdfDate(d.creationDate),
    modified: pdfDate(d.modificationDate),
    text: '',
  };
  if (type === 'note') {
    a.rect = [x1, y1, x2, y2];
  } else {
    const q = d.quadPoints;
    a.quads = [];
    if (q?.length) for (let i = 0; i + 8 <= q.length; i += 8) a.quads.push(Array.from(q.slice(i, i + 8)));
    else a.quads.push([x1, y2, x2, y2, x1, y1, x2, y1]);
  }
  return a;
}

/** Pontos de um quadrilátero no viewport: [TL, TR, BL, BR] */
export function quadToViewport(q, vp) {
  return [0, 2, 4, 6].map((i) => vp.convertToViewportPoint(q[i], q[i + 1]));
}

const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

/** Linha de sublinhado (t≈0.08) ou tachado (t=0.5) a partir dos pontos [TL, TR, BL, BR]. */
export function lineAt(pts, t) {
  const [tl, tr, bl, br] = pts;
  return [lerp(bl, tl, t), lerp(br, tr, t)];
}

function boxOf(points) {
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

export function noteBox(a, vp) {
  const [x1, y1, x2, y2] = a.rect;
  return boxOf([vp.convertToViewportPoint(x1, y1), vp.convertToViewportPoint(x2, y2)]);
}

/** Retângulos (no viewport) de cada anotação, usados para clique e posicionamento. */
export function geometry(annots, vp) {
  return annots.map((a) => {
    if (a.type === 'note') return { a, boxes: [noteBox(a, vp)] };
    return { a, boxes: a.quads.map((q) => boxOf(quadToViewport(q, vp))) };
  });
}

/**
 * Desenha as anotações de marcação numa camada SVG (coordenadas do viewport em escala 1).
 * Notas são desenhadas à parte, como botões HTML.
 */
export function buildSvgLayer(annots, vp, selectedId) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'annotLayer');
  svg.setAttribute('viewBox', `0 0 ${vp.width} ${vp.height}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  for (const a of annots) {
    if (a.type === 'note') continue;
    const g = document.createElementNS(SVG_NS, 'g');
    for (const q of a.quads) {
      const pts = quadToViewport(q, vp);
      if (a.type === 'highlight') {
        const poly = document.createElementNS(SVG_NS, 'polygon');
        const [tl, tr, bl, br] = pts;
        poly.setAttribute('points', [tl, tr, br, bl].map((p) => p.join(',')).join(' '));
        poly.setAttribute('fill', a.color);
        poly.setAttribute('fill-opacity', a.opacity ?? 1);
        g.append(poly);
      } else {
        const h = Math.hypot(pts[0][0] - pts[2][0], pts[0][1] - pts[2][1]);
        const [p1, p2] = lineAt(pts, a.type === 'underline' ? 0.08 : 0.5);
        const line = document.createElementNS(SVG_NS, 'line');
        line.setAttribute('x1', p1[0]); line.setAttribute('y1', p1[1]);
        line.setAttribute('x2', p2[0]); line.setAttribute('y2', p2[1]);
        line.setAttribute('stroke', a.color);
        line.setAttribute('stroke-width', Math.max(0.8, h * 0.08));
        g.append(line);
      }
    }
    svg.append(g);
  }
  // contorno da anotação selecionada (fora do modo "multiplicar")
  const sel = annots.find((a) => a.id === selectedId && a.type !== 'note');
  const outline = document.createElementNS(SVG_NS, 'svg');
  outline.setAttribute('class', 'annotOutline');
  outline.setAttribute('viewBox', `0 0 ${vp.width} ${vp.height}`);
  outline.setAttribute('preserveAspectRatio', 'none');
  if (sel) {
    for (const q of sel.quads) {
      const [x1, y1, x2, y2] = boxOf(quadToViewport(q, vp));
      const r = document.createElementNS(SVG_NS, 'rect');
      r.setAttribute('x', x1 - 1.5); r.setAttribute('y', y1 - 1.5);
      r.setAttribute('width', x2 - x1 + 3); r.setAttribute('height', y2 - y1 + 3);
      r.setAttribute('rx', 2);
      outline.append(r);
    }
  }
  return [svg, outline];
}

/** Desenha as anotações num canvas 2D (miniaturas e impressão). */
export function drawOnCanvas(ctx, vp, annots) {
  for (const a of annots) {
    ctx.save();
    if (a.type === 'note') {
      const [x1, y1, x2, y2] = noteBox(a, vp);
      const w = x2 - x1, h = y2 - y1;
      ctx.fillStyle = a.color;
      ctx.strokeStyle = '#404040';
      ctx.lineWidth = Math.max(0.5, w * 0.04);
      ctx.fillRect(x1, y1, w, h);
      ctx.strokeRect(x1, y1, w, h);
      ctx.beginPath();
      for (const [t, len] of [[0.3, 0.6], [0.5, 0.6], [0.7, 0.4]]) {
        ctx.moveTo(x1 + w * 0.2, y1 + h * t);
        ctx.lineTo(x1 + w * (0.2 + len), y1 + h * t);
      }
      ctx.stroke();
    } else {
      for (const q of a.quads) {
        const pts = quadToViewport(q, vp);
        if (a.type === 'highlight') {
          ctx.globalCompositeOperation = 'multiply';
          ctx.globalAlpha = a.opacity ?? 1;
          ctx.fillStyle = a.color;
          const [tl, tr, bl, br] = pts;
          ctx.beginPath();
          ctx.moveTo(...tl); ctx.lineTo(...tr); ctx.lineTo(...br); ctx.lineTo(...bl);
          ctx.closePath();
          ctx.fill();
        } else {
          const h = Math.hypot(pts[0][0] - pts[2][0], pts[0][1] - pts[2][1]);
          const [p1, p2] = lineAt(pts, a.type === 'underline' ? 0.08 : 0.5);
          ctx.strokeStyle = a.color;
          ctx.lineWidth = Math.max(0.8, h * 0.08);
          ctx.beginPath();
          ctx.moveTo(...p1); ctx.lineTo(...p2);
          ctx.stroke();
        }
      }
    }
    ctx.restore();
  }
}

/**
 * Converte a seleção atual (dentro de uma página) em quadriláteros no espaço do PDF.
 * @param range  Range da seleção
 * @param p      página {div, textDiv, page}
 * @param vp     viewport da página em escala 1 com a rotação atual
 * @returns {{quads:number[][], text:string} | null}
 */
export function quadsFromRange(range, p, vp) {
  const layer = p.textDiv;
  if (!layer || !range.intersectsNode(layer)) return null;
  const pr = p.div.getBoundingClientRect();
  // "upright": viewport só com a rotação própria da página — o texto aparece na horizontal
  const up = p.page.getViewport({ scale: 1 });
  const rects = [];
  let text = '';
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!range.intersectsNode(node)) continue;
    const start = node === range.startContainer ? range.startOffset : 0;
    const end = node === range.endContainer ? range.endOffset : node.length;
    if (end <= start) continue;
    const slice = node.data.slice(start, end);
    text += slice;
    const span = node.parentElement?.closest('.textLayer > span');
    if (span?.nextSibling?.nodeName === 'BR' && (end === node.length)) text += '\n';
    if (!slice.trim()) continue;
    const sub = document.createRange();
    sub.setStart(node, start);
    sub.setEnd(node, end);
    for (const r of sub.getClientRects()) {
      if (r.width < 0.5 || r.height < 0.5) continue;
      const corners = [[r.left, r.top], [r.right, r.top], [r.left, r.bottom], [r.right, r.bottom]].map(([cx, cy]) => {
        const vx = ((cx - pr.left) / pr.width) * vp.width;
        const vy = ((cy - pr.top) / pr.height) * vp.height;
        const [px, py] = vp.convertToPdfPoint(vx, vy);
        return up.convertToViewportPoint(px, py);
      });
      rects.push(boxOf(corners));
    }
  }
  if (!rects.length) return null;

  // junta retângulos da mesma linha
  rects.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const lines = [];
  for (const r of rects) {
    const h = r[3] - r[1];
    const line = lines.find((l) => {
      const overlap = Math.min(l[3], r[3]) - Math.max(l[1], r[1]);
      const lh = Math.min(l[3] - l[1], h);
      const gap = Math.max(r[0] - l[2], l[0] - r[2]);
      return overlap > lh * 0.5 && gap < Math.max(lh, h) * 1.5;
    });
    if (line) {
      line[0] = Math.min(line[0], r[0]); line[1] = Math.min(line[1], r[1]);
      line[2] = Math.max(line[2], r[2]); line[3] = Math.max(line[3], r[3]);
    } else lines.push([...r]);
  }

  const quads = lines.map(([x1, y1, x2, y2]) => {
    const tl = up.convertToPdfPoint(x1, y1), tr = up.convertToPdfPoint(x2, y1);
    const bl = up.convertToPdfPoint(x1, y2), br = up.convertToPdfPoint(x2, y2);
    return [...tl, ...tr, ...bl, ...br].map((n) => Math.round(n * 100) / 100);
  });
  return { quads, text: text.replace(/\s+/g, ' ').trim() };
}

/**
 * Recupera o texto sob os quadriláteros de uma anotação importada, usando os itens de texto da página
 * (o PDF não guarda o trecho marcado). Aproximação proporcional por caractere; só texto horizontal.
 */
export function textForQuads(items, quads) {
  const out = [];
  for (const q of quads) {
    const qx1 = Math.min(q[0], q[4]), qx2 = Math.max(q[2], q[6]);
    const qy1 = Math.min(q[5], q[7]), qy2 = Math.max(q[1], q[3]);
    let line = '';
    for (const it of items) {
      if (!it.str || !it.transform || !it.width) continue;
      const [, b, c, d, e, f] = it.transform;
      if (Math.abs(b) > 0.01 || Math.abs(c) > 0.01) continue;
      const cy = f + (it.height || Math.abs(d)) * 0.35;
      if (cy < qy1 || cy > qy2) continue;
      const x1 = e, x2 = e + it.width;
      if (x2 <= qx1 || x1 >= qx2) continue;
      const n = it.str.length;
      const s = Math.max(0, Math.round(((qx1 - x1) / it.width) * n));
      const t = Math.min(n, Math.round(((qx2 - x1) / it.width) * n));
      line += it.str.slice(s, t);
    }
    if (line.trim()) out.push(line.trim());
  }
  return out.join(' ').replace(/\s+/g, ' ');
}

/** Retângulo (espaço do PDF) de uma nota com o canto superior esquerdo no ponto do viewport. */
export function noteRectAt(p, vp, vx, vy) {
  const up = p.page.getViewport({ scale: 1 });
  const [px, py] = vp.convertToPdfPoint(vx, vy);
  const [ux, uy] = up.convertToViewportPoint(px, py);
  const a = up.convertToPdfPoint(ux - NOTE_SIZE / 2, uy - NOTE_SIZE / 2);
  const b = up.convertToPdfPoint(ux + NOTE_SIZE / 2, uy + NOTE_SIZE / 2);
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])].map((n) => Math.round(n * 100) / 100);
}

/** Posição (topo, esquerda) de uma anotação para ordenar a lista. */
export function sortKey(a) {
  if (a.type === 'note') return [a.page, -a.rect[3], a.rect[0]];
  let top = -Infinity, left = Infinity;
  for (const q of a.quads) { top = Math.max(top, q[1], q[3]); left = Math.min(left, q[0], q[4]); }
  return [a.page, -top, left];
}
