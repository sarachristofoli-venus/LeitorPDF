// Editor de matérias (inspirado no "Editor Impresso" do Akaii): a página é dividida em blocos de texto;
// clicando nos blocos, o texto vai para o campo ativo (título, subtítulo, autor, conteúdo…), a área da
// matéria é marcada na página e pode ser salva/copiada como imagem (recorte). Texto que só existe dentro de
// imagens (anúncios, logotipos, páginas digitalizadas) é lido por OCR e vira blocos também.
//
// Coordenadas dos blocos e das marcas: "quadro da página exibida" (pontos, origem em cima, com a rotação
// própria da página, /Rotate) — o de page.getViewport({ scale: 1, rotation: page.rotate }). A rotação que o
// usuário aplica (Ctrl+R) é convertida só na hora de desenhar.
import {
  segment, wordsFromItems, boundsOf, blockText, vocabularyOf, oneLine, appendTo, cleanAuthor,
} from './blocks.js';

const FIELDS = [
  { key: 'editoria', label: 'Editoria', single: true, replace: true },
  { key: 'titulo', label: 'Título', single: true },
  { key: 'subtitulo', label: 'Subtítulo', single: true },
  { key: 'autor', label: 'Autor', single: true },
  { key: 'conteudo', label: 'Conteúdo', single: false },
];
const CLIP_SCALE = 200 / 72; // recorte em 200 dpi (a resolução das páginas no Akaii)
const MARK_PAD = 4;          // folga (pt) em volta dos blocos na área marcada
const OCR_MIN_SIDE = 24;     // imagens menores que isso (pt) não passam pelo OCR
const OCR_MAX_REGIONS = 12;
const OCR_MAX_PX = 4200;     // lado maior da imagem enviada ao OCR (o mesmo teto do OCR do documento)
const CLICK_DELAY = 230;     // espera para distinguir clique simples de duplo (selecionar palavra)

const pageKey = (doc, num) => `${doc.uid}#${num}`;
const copyMark = (m) => (m ? { ...m, rect: [...m.rect] } : null);

class Cancelled extends Error {
  constructor() { super('OCR cancelado'); this.name = 'OcrCancelled'; }
}

export class NewsEditor {
  /**
   * @param host { $, el, icon, api, toast, pdfjsLib, withStorage, getActive, docs, store, saveStore, relayout }
   */
  constructor(host) {
    this.h = host;
    this.active = false;
    this.values = Object.fromEntries(FIELDS.map((f) => [f.key, '']));
    this.field = 'titulo';
    this.pagesUsed = [];      // [{ doc, num, label }]
    this.marks = new Map();   // pageKey → { doc, num, rect: [x0,y0,x1,y1], adjusted }
    this.used = new Set();    // `${pageKey}#${blockId}`
    this.history = [];        // passos para o Desfazer (bloco, seleção ou "limpar")
    this.queue = [];          // páginas esperando OCR das imagens
    this.ocrBusy = false;
    this.ocrSignal = null;
    this.ocrJob = null;
    this.clickTimer = 0;
    this.statusTimer = 0;
    this.dragging = false;
    this.buildPanel();
  }

  // ------------------------------------------------------------------ Painel
  buildPanel() {
    const { el, icon } = this.h;
    const panel = el('aside');
    panel.id = 'editorPanel';
    panel.hidden = true;

    const head = el('div', 'ed-head');
    const title = el('strong', null, 'Editor de matéria');
    this.statusEl = el('span', 'ed-status muted');
    const close = el('button', 'icon-btn small');
    close.title = 'Fechar o editor (E)';
    close.append(icon('close'));
    close.addEventListener('click', () => this.toggle(false));
    head.append(title, this.statusEl, close);

    const hint = el('p', 'ed-hint muted',
      'Clique num campo e depois nos blocos da página. Ctrl+clique troca o texto do campo. Também dá para selecionar um trecho e enviar para o campo.');

    const form = el('div', 'ed-form');
    this.inputs = {};
    const pageRow = el('div', 'ed-row');
    for (const f of FIELDS) {
      const wrap = el('div', 'ed-field' + (f.single ? '' : ' grow'));
      wrap.dataset.field = f.key;
      const top = el('div', 'ed-label');
      top.append(el('span', null, f.label));
      const tools = el('span', 'ed-tools');
      const copy = el('button', 'icon-btn small');
      copy.title = `Copiar ${f.label.toLowerCase()}`;
      copy.append(icon('copy'));
      copy.addEventListener('click', () => this.copyText(this.values[f.key], f.label));
      const clear = el('button', 'icon-btn small');
      clear.title = `Limpar ${f.label.toLowerCase()}`;
      clear.append(icon('close'));
      clear.addEventListener('click', () => { this.setValue(f.key, '', true); this.focusField(f.key); });
      tools.append(copy, clear);
      top.append(tools);
      const input = f.key === 'editoria' || f.key === 'autor' ? el('input') : el('textarea');
      if (input.tagName === 'TEXTAREA' && f.single) input.rows = f.key === 'titulo' ? 3 : 2;
      input.spellcheck = true;
      input.lang = 'pt-BR';
      input.addEventListener('focus', () => this.setField(f.key));
      input.addEventListener('input', () => { this.values[f.key] = input.value; });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); input.blur(); this.h.getActive()?.viewer.focus({ preventScroll: true }); }
      });
      wrap.append(top, input);
      wrap.addEventListener('mousedown', (e) => { if (e.target === wrap || e.target.closest('.ed-label > span:first-child')) this.setField(f.key); });
      this.inputs[f.key] = input;
      if (f.key === 'editoria') {
        const pag = el('div', 'ed-field ed-page');
        const t = el('div', 'ed-label');
        t.append(el('span', null, 'Página'));
        this.pageEl = el('input');
        this.pageEl.readOnly = true;
        this.pageEl.tabIndex = -1;
        pag.append(t, this.pageEl);
        pageRow.append(wrap, pag);
        form.append(pageRow);
      } else form.append(wrap);
    }

    const opts = el('div', 'ed-opts');
    const ocrLabel = el('label', 'check');
    this.ocrCheck = el('input');
    this.ocrCheck.type = 'checkbox';
    this.ocrCheck.checked = this.h.store.edOcrImages !== false;
    this.ocrCheck.addEventListener('change', () => {
      this.h.store.edOcrImages = this.ocrCheck.checked;
      this.h.saveStore();
      if (this.ocrCheck.checked) this.queueVisible();
      else this.stopOcr();
    });
    ocrLabel.append(this.ocrCheck, ' Ler texto nas imagens (OCR)');
    const showLabel = el('label', 'check');
    this.showCheck = el('input');
    this.showCheck.type = 'checkbox';
    this.showCheck.checked = true;
    this.showCheck.addEventListener('change', () => document.body.classList.toggle('ed-hide-blocks', !this.showCheck.checked));
    showLabel.append(this.showCheck, ' Mostrar blocos');
    opts.append(ocrLabel, showLabel);

    const actions = el('div', 'ed-actions');
    const btn = (text, title, fn, cls = 'secondary') => {
      const b = el('button', cls, text);
      b.title = title;
      b.addEventListener('click', fn);
      return b;
    };
    this.undoBtn = btn('Desfazer', 'Desfazer o último passo (bloco acrescentado ou "Limpar")', () => this.undo());
    actions.append(
      btn('Limpar', 'Começar outra matéria (Esc)', () => this.clear(true)),
      this.undoBtn,
      btn('Copiar recorte', 'Copiar a imagem da área marcada', () => this.copyClip()),
      btn('Salvar recorte…', 'Salvar a imagem da área marcada (JPG)', () => this.saveClip()),
      btn('Copiar matéria', 'Copiar todos os campos', () => this.copyAll(), 'primary'),
    );

    panel.append(head, hint, form, opts, actions);
    this.h.$('#main').append(panel);
    this.panel = panel;
    this.setField('titulo');
    this.updateButtons();
  }

  fieldLabel() {
    return FIELDS.find((f) => f.key === this.field)?.label.toLowerCase() || 'o campo';
  }

  setField(key) {
    this.field = key;
    for (const w of this.panel.querySelectorAll('.ed-field[data-field]')) w.classList.toggle('on', w.dataset.field === key);
  }

  focusField(key) {
    this.setField(key);
    this.inputs[key]?.focus();
  }

  setValue(key, value, record = false) {
    if (record) this.history.push({ field: key, prev: this.values[key] });
    this.values[key] = value;
    const input = this.inputs[key];
    input.value = value;
    if (input.tagName === 'TEXTAREA') input.scrollTop = input.scrollHeight;
    this.updateButtons();
  }

  updateButtons() {
    this.undoBtn.disabled = !this.history.length;
  }

  status(text, keepMs = 0) {
    clearTimeout(this.statusTimer);
    this.statusEl.textContent = text;
    if (keepMs) this.statusTimer = setTimeout(() => { if (this.statusEl.textContent === text) this.statusEl.textContent = ''; }, keepMs);
  }

  // ------------------------------------------------------------------ Ligar/desligar
  toggle(on = !this.active) {
    if (on === this.active) return;
    this.active = on;
    this.panel.hidden = !on;
    document.body.classList.toggle('editor-on', on);
    this.h.$('#btnEditor')?.classList.toggle('on', on);
    const doc = this.h.getActive();
    if (on) {
      for (const d of this.h.docs()) for (const p of d.visible) if (p.renderedKey) this.renderLayer(d, p);
      if (doc) this.h.toast('Editor de matéria: clique num campo e depois nos blocos da página.', 3000);
    } else {
      this.cancelClick();
      this.stopOcr();
      this.hoverDiv = null;
      for (const d of this.h.docs()) {
        d.viewer.classList.remove('ed-over');
        for (const p of d.pages) this.dropLayer(p);
      }
    }
    this.h.relayout();
  }

  // ------------------------------------------------------------------ Blocos da página
  /** Dados da página (palavras e blocos), calculados uma vez por versão do documento. */
  pageData(doc, p) {
    if (!doc.ed || doc.ed.gen !== doc.docGen) doc.ed = { gen: doc.docGen, pages: new Map(), vocab: new Map() };
    const ed = doc.ed;
    let data = ed.pages.get(p.num);
    if (!data) {
      data = (async () => {
        const tc = await doc.getText(p.num);
        const page = p.page || (p.page = await doc.pdf.getPage(p.num));
        const vp0 = page.getViewport({ scale: 1, rotation: page.rotate });
        const words = wordsFromItems(tc.items, vp0);
        // vocabulário do documento (para capitulares e hífens ambíguos): cresce com as páginas lidas
        vocabularyOf(words, ed.vocab);
        const blocks = [];
        for (const b of segment(words, { width: vp0.width, height: vp0.height })) {
          const text = blockText(words, b, ed.vocab).trim();
          if (!text) continue;
          blocks.push({ id: blocks.length, kind: b.kind || 'text', source: 'pdf', rect: boundsOf(words, b.ids), text });
        }
        return { words, blocks, vp0, W: vp0.width, H: vp0.height, ocr: 'none' };
      })();
      ed.pages.set(p.num, data);
      data.catch(() => ed.pages.get(p.num) === data && ed.pages.delete(p.num));
    }
    return data;
  }

  /** Retângulo do quadro exibido → % do quadro na tela (com a rotação do usuário). */
  toPercent(doc, p, rect, data) {
    const vp = doc.viewportFor(p.page, 1);
    const a = data.vp0.convertToPdfPoint(rect[0], rect[1]);
    const b = data.vp0.convertToPdfPoint(rect[2], rect[3]);
    const r = vp.convertToViewportRectangle([a[0], a[1], b[0], b[1]]);
    const l = Math.min(r[0], r[2]) / vp.width, t = Math.min(r[1], r[3]) / vp.height;
    return [l, t, Math.abs(r[2] - r[0]) / vp.width, Math.abs(r[3] - r[1]) / vp.height];
  }

  /** Fração (0–1) do quadro na tela → ponto do quadro exibido. */
  fromPercent(doc, p, fx, fy, data) {
    const vp = doc.viewportFor(p.page, 1);
    const [ux, uy] = vp.convertToPdfPoint(fx * vp.width, fy * vp.height);
    return data.vp0.convertToViewportPoint(ux, uy);
  }

  /** Retângulo da tela (getClientRects) → retângulo do quadro exibido. */
  clientRectToPage(doc, p, r, data) {
    const b = p.div.getBoundingClientRect();
    const a = this.fromPercent(doc, p, (r.left - b.left) / b.width, (r.top - b.top) / b.height, data);
    const c = this.fromPercent(doc, p, (r.right - b.left) / b.width, (r.bottom - b.top) / b.height, data);
    return [Math.min(a[0], c[0]), Math.min(a[1], c[1]), Math.max(a[0], c[0]), Math.max(a[1], c[1])];
  }

  async renderLayer(doc, p) {
    if (!this.active || !p.page) return;
    const gen = p.gen;
    let data;
    try { data = await this.pageData(doc, p); } catch { return; }
    if (!this.active || gen !== p.gen || !p.div.isConnected) return;
    this.dropLayer(p, false);
    const { el } = this.h;
    const layer = el('div', 'edLayer');
    const rects = [];
    for (const b of data.blocks) {
      const [l, t, w, h] = this.toPercent(doc, p, b.rect, data);
      const div = el('div', 'edBlock' + (b.source === 'ocr' ? ' ocr' : '') + (b.kind === 'table' ? ' table' : ''));
      div.style.left = l * 100 + '%';
      div.style.top = t * 100 + '%';
      div.style.width = w * 100 + '%';
      div.style.height = h * 100 + '%';
      if (b.source === 'ocr') div.dataset.tag = 'OCR';
      else if (b.kind === 'table') div.dataset.tag = 'Tabela';
      if (this.used.has(pageKey(doc, p.num) + '#' + b.id)) div.classList.add('used');
      layer.append(div);
      rects.push({ b, div, l, t, r: l + w, bt: t + h, area: w * h });
    }
    p.div.append(layer);
    p.edLayer = layer;
    p.edRects = rects;
    p.edDoc = doc;
    this.renderMark(doc, p, data);
    if (this.ocrCheck.checked && data.ocr === 'none') this.enqueue(doc, p);
  }

  /** Página saiu da tela (ou o editor fechou): tira a camada e a página da fila do OCR. */
  dropLayer(p, leaving = true) {
    p.edLayer?.remove();
    p.edMark?.remove();
    p.edLayer = p.edMark = null;
    p.edRects = null;
    if (this.hoverDiv && !this.hoverDiv.isConnected) this.hoverDiv = null;
    if (leaving) this.queue = this.queue.filter((q) => q.p !== p);
  }

  hit(p, cx, cy) {
    if (!p.edRects) return null;
    const r = p.div.getBoundingClientRect();
    const fx = (cx - r.left) / r.width, fy = (cy - r.top) / r.height;
    const tol = 2 / Math.max(r.width, 1);
    let best = null;
    for (const it of p.edRects) {
      if (fx >= it.l - tol && fx <= it.r + tol && fy >= it.t - tol && fy <= it.bt + tol && (!best || it.area < best.area)) best = it;
    }
    return best;
  }

  hover(doc, p, cx, cy) {
    const it = p && this.active ? this.hit(p, cx, cy) : null;
    if (this.hoverDiv && this.hoverDiv !== it?.div) this.hoverDiv.classList.remove('hover');
    this.hoverDiv = it?.div || null;
    this.hoverDiv?.classList.add('hover');
    doc?.viewer.classList.toggle('ed-over', !!it);
  }

  /** Clique na página com o editor ligado. Devolve true se o clique foi usado. */
  click(doc, p, e) {
    if (!this.active || e.button !== 0) return false;
    const it = this.hit(p, e.clientX, e.clientY);
    if (!it) return false;
    this.cancelClick();
    if (e.detail > 1) return true;
    const replace = e.ctrlKey || e.metaKey;
    // espera um instante: se vier um segundo clique (selecionar palavra), o bloco não entra
    this.clickTimer = setTimeout(() => {
      this.clickTimer = 0;
      if (!this.active || doc.closed || !p.edRects || !document.getSelection().isCollapsed) return;
      this.addBlock(doc, p, it.b, replace);
    }, CLICK_DELAY);
    return true;
  }

  cancelClick() {
    clearTimeout(this.clickTimer);
    this.clickTimer = 0;
  }

  // ------------------------------------------------------------------ Montagem da matéria
  addPiece(key, text, replace, kind = 'text', vocab = null) {
    const f = FIELDS.find((x) => x.key === key);
    const cur = replace || f.replace ? '' : this.values[key];
    let next;
    if (key === 'autor') {
      const a = cleanAuthor(text);
      next = cur && a ? `${cur}, ${a}` : cur || a;
    } else next = appendTo(cur, text, { multiline: !f.single, table: kind === 'table', vocab });
    this.setValue(key, next, true);
  }

  addBlock(doc, p, block, replace = false) {
    const key = pageKey(doc, p.num);
    const usedKey = key + '#' + block.id;
    const marksMark = this.field !== 'editoria';
    const step = { marks: marksMark ? [{ key, prev: copyMark(this.marks.get(key)) }] : [], pagesPrev: this.pagesUsed.slice() };
    this.addPiece(this.field, block.text, replace, block.kind, doc.ed?.vocab);
    Object.assign(this.history[this.history.length - 1], step, { usedKey: this.used.has(usedKey) ? null : usedKey });
    this.used.add(usedKey);
    this.usePage(doc, p.num);
    if (marksMark) this.extendMark(doc, p, block.rect);
    this.refreshUsed(doc, p);
    this.updateButtons();
  }

  /** Texto selecionado na página → campo ativo (para trechos menores que um bloco). */
  async addSelection(doc, text, rectsByPage) {
    if (!this.active || !text.trim()) return;
    const marksMark = this.field !== 'editoria';
    const step = { marks: [], pagesPrev: this.pagesUsed.slice() };
    this.addPiece(this.field, text, false, 'text', doc.ed?.vocab);
    Object.assign(this.history[this.history.length - 1], step);
    for (const [p, clientRect] of rectsByPage) {
      let data;
      try { data = await this.pageData(doc, p); } catch { continue; }
      const key = pageKey(doc, p.num);
      this.usePage(doc, p.num);
      if (!marksMark) continue;
      step.marks.push({ key, prev: copyMark(this.marks.get(key)) });
      this.extendMark(doc, p, this.clientRectToPage(doc, p, clientRect, data));
    }
    this.updateButtons();
  }

  undo() {
    const h = this.history.pop();
    if (!h) return;
    if (h.kind === 'clear') {
      // desfaz o "Limpar": volta a matéria inteira
      for (const f of FIELDS) { this.values[f.key] = h.values[f.key]; this.inputs[f.key].value = h.values[f.key]; }
      this.pagesUsed = h.pagesUsed;
      this.marks = h.marks;
      this.used = h.used;
    } else {
      this.values[h.field] = h.prev;
      this.inputs[h.field].value = h.prev;
      if (h.usedKey) this.used.delete(h.usedKey);
      for (const m of h.marks || []) {
        const cur = this.marks.get(m.key);
        if (cur?.adjusted && !m.prev?.adjusted) continue; // a borda foi ajustada à mão depois: mantém
        if (m.prev) this.marks.set(m.key, m.prev); else this.marks.delete(m.key);
      }
      if (h.pagesPrev) this.pagesUsed = h.pagesPrev;
    }
    this.updatePages();
    for (const d of this.h.docs()) for (const p of d.pages) if (p.edLayer) this.renderLayer(d, p);
    this.updateButtons();
  }

  usePage(doc, num) {
    if (this.pagesUsed.some((u) => u.doc === doc && u.num === num)) return;
    this.pagesUsed.push({ doc, num, label: doc.pageLabel?.(num) || String(num) });
    this.updatePages();
  }

  updatePages() {
    this.pageEl.value = this.pagesUsed.map((u) => u.label).join(', ');
  }

  refreshUsed(doc, p) {
    if (!p.edRects) return;
    for (const it of p.edRects) it.div.classList.toggle('used', this.used.has(pageKey(doc, p.num) + '#' + it.b.id));
  }

  /** Limpa a matéria (Esc). Dá para desfazer. */
  clear(keepEditoria = true) {
    this.cancelClick();
    const empty = FIELDS.every((f) => (keepEditoria && f.key === 'editoria') || !this.values[f.key]) && !this.marks.size;
    if (!empty) {
      this.history.push({
        kind: 'clear', values: { ...this.values }, pagesUsed: this.pagesUsed.slice(),
        marks: new Map([...this.marks].map(([k, m]) => [k, copyMark(m)])), used: new Set(this.used),
      });
    }
    for (const f of FIELDS) if (!(keepEditoria && f.key === 'editoria')) this.setValue(f.key, '');
    this.pagesUsed = [];
    this.updatePages();
    this.marks.clear();
    this.used = new Set();
    this.updateButtons();
    for (const d of this.h.docs()) for (const p of d.pages) if (p.edLayer) { this.refreshUsed(d, p); p.edMark?.remove(); p.edMark = null; }
    this.setField('titulo');
    if (!empty) this.h.toast('Matéria limpa. “Desfazer” traz de volta.', 2500);
  }

  // ------------------------------------------------------------------ Área marcada (recorte)
  extendMark(doc, p, rect) {
    const key = pageKey(doc, p.num);
    this.pageData(doc, p).then((data) => {
      const r = [Math.max(0, rect[0] - MARK_PAD), Math.max(0, rect[1] - MARK_PAD), Math.min(data.W, rect[2] + MARK_PAD), Math.min(data.H, rect[3] + MARK_PAD)];
      const m = this.marks.get(key);
      if (!m) this.marks.set(key, { doc, num: p.num, rect: r, adjusted: false });
      else if (!m.adjusted) m.rect = [Math.min(m.rect[0], r[0]), Math.min(m.rect[1], r[1]), Math.max(m.rect[2], r[2]), Math.max(m.rect[3], r[3])];
      this.renderMark(doc, p, data);
    }).catch(() => {});
  }

  renderMark(doc, p, data) {
    if (this.dragging) return; // não recria a caixa no meio do arraste da borda
    p.edMark?.remove();
    p.edMark = null;
    const m = this.marks.get(pageKey(doc, p.num));
    if (!m || !this.active || !p.div.isConnected) return;
    const { el } = this.h;
    const [l, t, w, h] = this.toPercent(doc, p, m.rect, data);
    const box = el('div', 'edMark');
    box.style.left = l * 100 + '%';
    box.style.top = t * 100 + '%';
    box.style.width = w * 100 + '%';
    box.style.height = h * 100 + '%';
    box.title = 'Área da matéria (arraste as bordas para ajustar)';
    for (const edge of ['n', 's', 'e', 'w']) {
      const hd = el('div', 'edHandle ' + edge);
      hd.addEventListener('pointerdown', (e) => this.dragEdge(e, doc, p, m, edge, data));
      box.append(hd);
    }
    p.div.append(box);
    p.edMark = box;
  }

  /** Arrasta uma borda da área marcada. Sem arrastar (clique simples), o clique vale para o bloco embaixo. */
  dragEdge(e, doc, p, m, edge, data) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const hd = e.currentTarget;
    hd.setPointerCapture(e.pointerId);
    const r = p.div.getBoundingClientRect();
    const [l, t, w, h] = this.toPercent(doc, p, m.rect, data);
    let x0 = l, y0 = t, x1 = l + w, y1 = t + h;
    const box = p.edMark;
    const sx = e.clientX, sy = e.clientY;
    let moved = false;
    this.dragging = true;
    const move = (ev) => {
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 3) return;
      moved = true;
      const fx = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
      const fy = Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height));
      if (edge === 'n') y0 = Math.min(fy, y1 - 0.01);
      if (edge === 's') y1 = Math.max(fy, y0 + 0.01);
      if (edge === 'w') x0 = Math.min(fx, x1 - 0.01);
      if (edge === 'e') x1 = Math.max(fx, x0 + 0.01);
      box.style.left = x0 * 100 + '%';
      box.style.top = y0 * 100 + '%';
      box.style.width = (x1 - x0) * 100 + '%';
      box.style.height = (y1 - y0) * 100 + '%';
    };
    const up = (ev) => {
      hd.removeEventListener('pointermove', move);
      hd.removeEventListener('pointerup', up);
      hd.removeEventListener('pointercancel', up);
      hd.removeEventListener('lostpointercapture', up);
      this.dragging = false;
      if (!moved) {
        if (ev.type !== 'pointerup') return;
        const it = this.hit(p, ev.clientX, ev.clientY);
        if (it) this.addBlock(doc, p, it.b, ev.ctrlKey || ev.metaKey);
        return;
      }
      const a = this.fromPercent(doc, p, x0, y0, data), b = this.fromPercent(doc, p, x1, y1, data);
      m.rect = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
      m.adjusted = true;
    };
    hd.addEventListener('pointermove', move);
    hd.addEventListener('pointerup', up);
    hd.addEventListener('pointercancel', up);
    hd.addEventListener('lostpointercapture', up);
  }

  /** Imagem da área marcada de uma página (canvas) em 200 dpi, como aparece na tela (com a rotação do usuário). */
  async renderRegion(doc, num, rect, scale = CLIP_SCALE) {
    const page = await doc.pdf.getPage(num);
    const vp0 = page.getViewport({ scale: 1, rotation: page.rotate });
    const full = doc.viewportFor(page, scale);
    const a = vp0.convertToPdfPoint(rect[0], rect[1]), b = vp0.convertToPdfPoint(rect[2], rect[3]);
    const r = full.convertToViewportRectangle([a[0], a[1], b[0], b[1]]);
    const vx0 = Math.min(r[0], r[2]), vy0 = Math.min(r[1], r[3]);
    const cw = Math.max(1, Math.round(Math.abs(r[2] - r[0]))), ch = Math.max(1, Math.round(Math.abs(r[3] - r[1])));
    const vp = page.getViewport({ scale, rotation: full.rotation, offsetX: -vx0, offsetY: -vy0 });
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, cw, ch);
    await page.render({ canvasContext: ctx, viewport: vp, annotationMode: this.h.withStorage }).promise;
    return canvas;
  }

  /** Recorte: as áreas marcadas, na ordem das páginas usadas, empilhadas numa imagem só. */
  async clipCanvas() {
    const order = this.pagesUsed.map((u) => this.marks.get(pageKey(u.doc, u.num))).filter(Boolean);
    for (const m of this.marks.values()) if (!order.includes(m)) order.push(m);
    const live = order.filter((m) => m.doc.pdf && !m.doc.closed);
    if (!live.length) { this.h.toast('Marque a matéria primeiro: clique nos blocos da página.'); return null; }
    const parts = [];
    for (const m of live) parts.push(await this.renderRegion(m.doc, m.num, m.rect));
    if (parts.length === 1) return parts[0];
    const gap = 16;
    const out = document.createElement('canvas');
    out.width = Math.max(...parts.map((c) => c.width));
    out.height = parts.reduce((s, c) => s + c.height, 0) + gap * (parts.length - 1);
    const ctx = out.getContext('2d', { alpha: false });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, out.width, out.height);
    let y = 0;
    for (const c of parts) { ctx.drawImage(c, 0, y); y += c.height + gap; c.width = 0; }
    return out;
  }

  async saveClip() {
    try {
      const canvas = await this.clipCanvas();
      if (!canvas) return;
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
      canvas.width = 0;
      const first = this.pagesUsed[0] || [...this.marks.values()][0];
      const safe = (s) => String(s).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '').trim();
      const base = safe((first?.doc.name || 'matéria').replace(/\.pdf$/i, ''));
      const pages = this.pagesUsed.map((u) => safe(u.label)).join('-') || String(first?.num || '');
      const title = safe(oneLine(this.values.titulo)).slice(0, 60).trim();
      const name = `${base} - p${pages}${title ? ' - ' + title : ''}.jpg`;
      const dir = first?.doc.dir ? first.doc.dir + '\\' : '';
      const saved = await this.h.api.saveFile(dir + name, new Uint8Array(await blob.arrayBuffer()), 'jpg');
      if (saved) this.h.toast(`Recorte salvo: ${saved.split(/[\\/]/).pop()}`, 3500);
    } catch (err) {
      this.h.toast('Não foi possível salvar o recorte: ' + (err?.message || err), 5000);
    }
  }

  async copyClip() {
    try {
      const canvas = await this.clipCanvas();
      if (!canvas) return;
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
      canvas.width = 0;
      await this.h.api.copyImage(new Uint8Array(await blob.arrayBuffer()));
      this.h.toast('Recorte copiado. Cole com Ctrl+V.');
    } catch (err) {
      this.h.toast('Não foi possível copiar o recorte: ' + (err?.message || err), 5000);
    }
  }

  copyText(text, what) {
    if (!text.trim()) { this.h.toast(`${what} está vazio.`); return; }
    this.h.api.copyText(text);
    this.h.toast(`${what} copiado.`, 1500);
  }

  copyAll() {
    const v = this.values;
    const parts = [];
    if (v.editoria.trim()) parts.push(`Editoria: ${v.editoria.trim()}`);
    if (this.pageEl.value) parts.push(`Página: ${this.pageEl.value}`);
    if (v.titulo.trim()) parts.push(v.titulo.trim());
    if (v.subtitulo.trim()) parts.push(v.subtitulo.trim());
    if (v.autor.trim()) parts.push(`Por ${v.autor.trim()}`);
    if (v.conteudo.trim()) parts.push(v.conteudo.trim());
    this.copyText(parts.join('\n\n'), 'A matéria');
  }

  // ------------------------------------------------------------------ OCR das imagens
  enqueue(doc, p) {
    if (this.queue.some((q) => q.p === p) || this.ocrJob?.p === p) return;
    this.queue.push({ doc, p });
    this.pump();
  }

  queueVisible() {
    for (const d of this.h.docs()) for (const p of d.visible) if (p.edLayer) this.enqueue(d, p);
  }

  stopOcr() {
    this.queue = [];
    if (this.ocrSignal) { this.ocrSignal.cancelled = true; this.ocrSignal.terminate?.(); }
    this.status('');
  }

  async pump() {
    if (this.ocrBusy) return;
    // só páginas ainda na tela (as outras entram de novo na fila quando voltarem a aparecer)
    this.queue = this.queue.filter((q) => q.p.edLayer && !q.doc.closed);
    if (!this.queue.length) return;
    // prioridade: página atual do documento ativo, depois as outras visíveis
    const active = this.h.getActive();
    this.queue.sort((a, b) => (b.doc === active) - (a.doc === active)
      || Math.abs(a.p.num - (a.doc.currentPage || 1)) - Math.abs(b.p.num - (b.doc.currentPage || 1)));
    const job = this.queue.shift();
    this.ocrBusy = true;
    this.ocrJob = job;
    try {
      await this.ocrImages(job.doc, job.p);
    } catch (err) {
      if (err?.name !== 'OcrCancelled') console.warn('OCR das imagens', err);
    } finally {
      this.ocrBusy = false;
      this.ocrJob = null;
      this.pump();
    }
  }

  /** Caixas das imagens desenhadas na página (espaço do usuário), a partir da lista de operadores. */
  async imageBoxes(page) {
    const O = this.h.pdfjsLib.OPS;
    const ops = await page.getOperatorList({ annotationMode: this.h.withStorage });
    const mul = (m, k) => [m[0] * k[0] + m[2] * k[1], m[1] * k[0] + m[3] * k[1], m[0] * k[2] + m[2] * k[3], m[1] * k[2] + m[3] * k[3], m[0] * k[4] + m[2] * k[5] + m[4], m[1] * k[4] + m[3] * k[5] + m[5]];
    let ctm = [1, 0, 0, 1, 0, 0];
    const stack = [];
    const boxes = [];
    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i], a = ops.argsArray[i];
      if (fn === O.save) stack.push(ctm);
      else if (fn === O.restore) ctm = stack.pop() || ctm;
      else if (fn === O.transform) ctm = mul(ctm, a);
      else if (fn === O.paintFormXObjectBegin) { stack.push(ctm); if (Array.isArray(a?.[0])) ctm = mul(ctm, a[0]); }
      else if (fn === O.paintFormXObjectEnd) ctm = stack.pop() || ctm;
      else if (fn === O.paintImageXObject || fn === O.paintInlineImageXObject || fn === O.paintImageMaskXObject) {
        const xs = [ctm[4], ctm[0] + ctm[4], ctm[2] + ctm[4], ctm[0] + ctm[2] + ctm[4]];
        const ys = [ctm[5], ctm[1] + ctm[5], ctm[3] + ctm[5], ctm[1] + ctm[3] + ctm[5]];
        boxes.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
      }
    }
    return boxes;
  }

  async ocrImages(doc, p) {
    const signal = { cancelled: false };
    this.ocrSignal = signal;
    const gen = doc.docGen;
    const data = await this.pageData(doc, p);
    const check = () => {
      if (signal.cancelled || !this.active || !this.ocrCheck.checked || doc.closed || gen !== doc.docGen) throw new Cancelled();
    };
    check();
    if (data.ocr !== 'none') return;
    data.ocr = 'pending';
    try {
      await this.readImages(doc, p, data, signal, check);
      data.ocr = 'done';
    } catch (err) {
      data.ocr = err?.name === 'OcrCancelled' ? 'none' : 'error';
      throw err;
    } finally {
      if (this.ocrSignal === signal) this.ocrSignal = null;
    }
  }

  async readImages(doc, p, data, signal, check) {
    const page = p.page || (p.page = await doc.pdf.getPage(p.num));
    const { vp0, W, H } = data;

    // regiões de imagem (no quadro exibido) sem texto do PDF por cima
    const native = data.words.filter((w) => !w.rot);
    const boxes = await this.imageBoxes(page);
    check();
    let regions = boxes
      .map((b) => {
        const r = vp0.convertToViewportRectangle(b);
        return [Math.max(0, Math.min(r[0], r[2])), Math.max(0, Math.min(r[1], r[3])), Math.min(W, Math.max(r[0], r[2])), Math.min(H, Math.max(r[1], r[3]))];
      })
      .filter(([x0, y0, x1, y1]) => x1 - x0 >= OCR_MIN_SIDE && y1 - y0 >= OCR_MIN_SIDE * 0.6 && (x1 - x0) * (y1 - y0) >= 1200);
    // junta regiões sobrepostas (imagem + máscara, imagens repetidas)
    const merged = [];
    for (const r of regions.sort((a, b) => (b[2] - b[0]) * (b[3] - b[1]) - (a[2] - a[0]) * (a[3] - a[1]))) {
      const inside = merged.find((m) => {
        const ix = Math.min(m[2], r[2]) - Math.max(m[0], r[0]), iy = Math.min(m[3], r[3]) - Math.max(m[1], r[1]);
        return ix > 0 && iy > 0 && ix * iy > 0.6 * (r[2] - r[0]) * (r[3] - r[1]);
      });
      if (!inside) merged.push(r);
    }
    regions = merged.filter(([x0, y0, x1, y1]) => {
      const inside = native.filter((w) => (w.x0 + w.x1) / 2 >= x0 && (w.x0 + w.x1) / 2 <= x1 && (w.top + w.bottom) / 2 >= y0 && (w.top + w.bottom) / 2 <= y1);
      // camada de texto (OCR feito antes, texto sobre a foto de uma página digitalizada): cobre boa parte da imagem
      const covered = inside.reduce((s, w) => s + (w.x1 - w.x0) * (w.bottom - w.top), 0);
      return !(inside.length >= 8 && covered > 0.06 * (x1 - x0) * (y1 - y0));
    }).slice(0, OCR_MAX_REGIONS);
    if (!regions.length) return;

    this.status(`Lendo imagens da pág. ${doc.pageLabel?.(p.num) || p.num}…`);
    const OCR = await import('./ocr.js');
    check();
    const jobs = [];
    const frames = [];
    for (const r of regions) {
      const side = Math.max(r[2] - r[0], r[3] - r[1]);
      // ~300 dpi ou mais para letras pequenas, com teto no tamanho da imagem
      const scale = Math.min(8, OCR_MAX_PX / side, Math.max(300 / 72, 2600 / side));
      const frame = { r, scale };
      frames.push(frame);
      jobs.push(async () => {
        check();
        // mesmo quadro exibido (rotação própria da página), só que ampliado: coordenadas × scale
        const vp = page.getViewport({ scale, rotation: page.rotate, offsetX: -r[0] * scale, offsetY: -r[1] * scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round((r[2] - r[0]) * scale));
        canvas.height = Math.max(1, Math.round((r[3] - r[1]) * scale));
        const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport: vp, annotationMode: this.h.withStorage }).promise;
        return canvas;
      });
    }
    const results = await OCR.recognizeAll(jobs, { engine: this.h.store.ocrEngine, lang: 'por+eng', signal });
    check();

    // palavras do OCR → quadro exibido → blocos
    const added = [];
    results.forEach((ws, ri) => {
      const { r, scale } = frames[ri];
      if (!ws?.length) return;
      const X = (x) => r[0] + x / scale, Y = (y) => r[1] + y / scale;
      const words = [];
      ws.forEach((w, k) => {
        const size = w.size / scale;
        const ax = X(w.bx0), ay = Y(w.by0), bx = X(w.bx1), by = Y(w.by1);
        const vertical = Math.abs(by - ay) > Math.abs(bx - ax); // crédito de foto em pé
        let word;
        if (vertical) {
          const cx = (ax + bx) / 2;
          word = { x0: cx - size * 0.5, x1: cx + size * 0.5, top: Math.min(ay, by), bottom: Math.max(ay, by), rot: true };
        } else {
          const base = (ay + by) / 2;
          word = { x0: Math.min(ax, bx), x1: Math.max(ax, bx), top: base - size * 0.75, bottom: base + size * 0.25, rot: false };
        }
        const cx = (word.x0 + word.x1) / 2, cy = (word.top + word.bottom) / 2;
        // o texto do PDF que fica por cima da imagem já existe: não duplica
        if (native.some((n) => cx >= n.x0 - 1 && cx <= n.x1 + 1 && cy >= n.top - 1 && cy <= n.bottom + 1)) return;
        words.push({
          ...word, text: w.text, base: vertical ? cy : (word.top + size * 0.75), fs: size * 0.92, italic: false,
          item: w.line, eol: ws[k + 1]?.line !== w.line, conf: w.conf, font: undefined, // sem fonte: o segment usa tolerâncias de OCR
        });
      });
      if (!words.length) return;
      const vocab = vocabularyOf(words, new Map(doc.ed?.vocab || []));
      for (const b of segment(words, { width: W, height: H })) {
        const ids = b.ids;
        const letters = ids.reduce((s, i) => s + (words[i].text.match(/[\p{L}\p{N}]/gu) || []).length, 0);
        const conf = ids.reduce((s, i) => s + (words[i].conf ?? 100), 0) / ids.length;
        if (letters < 3 || conf < 50) continue;
        const text = blockText(words, b, vocab).trim();
        if (!text) continue;
        added.push({ kind: b.kind || 'text', source: 'ocr', rect: boundsOf(words, ids), text, conf });
      }
    });
    for (const b of added) { b.id = data.blocks.length; data.blocks.push(b); }
    const label = doc.pageLabel?.(p.num) || p.num;
    this.status(added.length ? `Pág. ${label}: ${added.length} ${added.length === 1 ? 'bloco lido' : 'blocos lidos'} nas imagens` : '', 6000);
    if (added.length && p.edLayer && this.active) this.renderLayer(doc, p);
  }

  /** Documento recarregado ou fechado: descarta blocos, marcas e passos do Desfazer ligados a ele. */
  forgetDoc(doc) {
    doc.ed = null;
    this.cancelClick();
    this.queue = this.queue.filter((q) => q.doc !== doc);
    if (this.ocrJob?.doc === doc && this.ocrSignal) { this.ocrSignal.cancelled = true; this.ocrSignal.terminate?.(); }
    const mine = (k) => k.startsWith(doc.uid + '#');
    for (const k of [...this.marks.keys()]) if (mine(k)) this.marks.delete(k);
    for (const k of [...this.used]) if (mine(k)) this.used.delete(k);
    this.pagesUsed = this.pagesUsed.filter((u) => u.doc !== doc);
    for (const h of this.history) {
      if (h.kind === 'clear') {
        h.pagesUsed = h.pagesUsed.filter((u) => u.doc !== doc);
        for (const k of [...h.marks.keys()]) if (mine(k)) h.marks.delete(k);
        for (const k of [...h.used]) if (mine(k)) h.used.delete(k);
        continue;
      }
      if (h.marks) h.marks = h.marks.filter((m) => !mine(m.key));
      if (h.pagesPrev) h.pagesPrev = h.pagesPrev.filter((u) => u.doc !== doc);
      if (h.usedKey && mine(h.usedKey)) h.usedKey = null;
    }
    this.updatePages();
  }
}
