// Seleção de texto: estabiliza a seleção, seleciona linhas com clique triplo e limpa o texto copiado.
// A estabilização é a mesma técnica do visualizador oficial do PDF.js (text_layer_builder.js).
import { normalizeUnicode } from '../node_modules/pdfjs-dist/build/pdf.min.mjs';

const layers = new Map(); // .textLayer -> .endOfContent
let listening = false;

function reset(end, layer) {
  layer.append(end);
  end.style.width = '';
  end.style.height = '';
  layer.classList.remove('selecting');
}

function enableGlobalListener() {
  if (listening) return;
  listening = true;
  let pointerDown = false;
  let prevRange = null;

  document.addEventListener('pointerdown', () => { pointerDown = true; });
  document.addEventListener('pointerup', () => { pointerDown = false; layers.forEach(reset); });
  window.addEventListener('blur', () => { pointerDown = false; layers.forEach(reset); });
  document.addEventListener('keyup', () => { if (!pointerDown) layers.forEach(reset); });

  document.addEventListener('selectionchange', () => {
    const sel = document.getSelection();
    if (sel.rangeCount === 0) { layers.forEach(reset); return; }
    const active = new Set();
    const range = sel.getRangeAt(0);
    for (const layer of layers.keys()) if (range.intersectsNode(layer)) active.add(layer);
    for (const [layer, end] of layers) {
      if (active.has(layer)) layer.classList.add('selecting');
      else reset(end, layer);
    }
    // Ao passar o mouse sobre um espaço vazio, o Chromium estenderia a seleção até o fim da página.
    // Mover o .endOfContent para junto do ponto de seleção limita esse salto a um único trecho.
    const modifyStart = prevRange && (
      range.compareBoundaryPoints(Range.END_TO_END, prevRange) === 0 ||
      range.compareBoundaryPoints(Range.START_TO_END, prevRange) === 0);
    let anchor = modifyStart ? range.startContainer : range.endContainer;
    if (anchor.nodeType === Node.TEXT_NODE) anchor = anchor.parentNode;
    // sobe para fora dos destaques da busca (<span class="hl">)
    while (anchor?.parentElement && !anchor.parentElement.classList.contains('textLayer') &&
      anchor.parentElement.closest('.textLayer')) anchor = anchor.parentElement;
    const layer = anchor?.parentElement?.closest('.textLayer');
    const end = layers.get(layer);
    if (end && anchor !== end) {
      end.style.width = layer.style.width;
      end.style.height = layer.style.height;
      anchor.parentElement.insertBefore(end, modifyStart ? anchor : anchor.nextSibling);
    }
    prevRange = range.cloneRange();
  });
}

function topSpan(node, layer) {
  let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  while (el && el.parentElement !== layer) el = el.parentElement;
  return el && el.tagName === 'SPAN' ? el : null;
}

/** Seleciona a linha inteira (entre dois <br>) que contém o nó. */
export function selectLine(layer, node) {
  const span = topSpan(node, layer);
  if (!span) return false;
  let first = span, last = span;
  while (first.previousElementSibling?.tagName === 'SPAN' && first.previousSibling?.nodeName !== 'BR') first = first.previousElementSibling;
  while (last.nextSibling && last.nextSibling.nodeName === 'SPAN') last = last.nextSibling;
  const range = document.createRange();
  range.setStartBefore(first);
  range.setEndAfter(last);
  const sel = document.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  return true;
}

export function registerTextLayer(layer) {
  const end = document.createElement('div');
  end.className = 'endOfContent';
  layer.append(end);
  layer.addEventListener('mousedown', (e) => {
    layer.classList.add('selecting');
    if (e.detail === 3 && e.button === 0) {
      if (selectLine(layer, e.target)) e.preventDefault();
    }
  });
  layers.set(layer, end);
  enableGlobalListener();
}

export function unregisterTextLayer(layer) {
  layers.delete(layer);
}

/**
 * Limpa o texto copiado de um PDF:
 * ligaduras (ﬁ → fi), caracteres nulos, hífens de quebra de linha, espaços sobrando.
 * joinLines: junta as linhas de um mesmo parágrafo em uma só.
 */
export function cleanText(text, { joinLines = false } = {}) {
  let s = normalizeUnicode(text).replace(/\u0000/g, '');
  s = s.replace(/\r\n?/g, '\n').replace(/[ \t ]+\n/g, '\n');
  s = s.replace(/­\n?/g, '');                              // hífen suave
  s = s.replace(/(\p{L})[-‐]\n(\p{Ll})/gu, '$1$2');           // "infor-\nmação" → "informação"
  if (joinLines) {
    s = s.replace(/\n{2,}/g, '').replace(/[ \t]*\n[ \t]*/g, ' ').replace(//g, '\n\n');
  }
  return s.replace(/[ \t]{2,}/g, ' ').trim();
}

/** Retorna true se a seleção atual está dentro de alguma camada de texto de PDF. */
export function selectionInTextLayer() {
  const sel = document.getSelection();
  if (!sel.rangeCount || sel.isCollapsed) return false;
  const range = sel.getRangeAt(0);
  for (const layer of layers.keys()) if (range.intersectsNode(layer)) return true;
  return false;
}
