import * as pdfjsLib from '../node_modules/pdfjs-dist/build/pdf.min.mjs';
import { registerTextLayer, unregisterTextLayer, cleanText, selectionInTextLayer } from './selection.js';
import * as A from './annotations.js';
import { NewsEditor } from './editor.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../node_modules/pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href;
const CMAP_URL = new URL('../node_modules/pdfjs-dist/cmaps/', import.meta.url).href;
const FONT_URL = new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url).href;

const api = window.leitor;
const CSS_UNITS = 96 / 72;
const ZOOM_STEPS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6, 8];
const MIN_ZOOM = 0.1, MAX_ZOOM = 8;
const THUMB_W = 150;
const MAX_CANVAS_PIXELS = 16777216;
const PAGE_CACHE = 12; // páginas que guardam o conteúdo já preparado (imagens decodificadas) para voltar rápido
const WITH_STORAGE = pdfjsLib.AnnotationMode.ENABLE_STORAGE;
const PDF_OPTIONS = { cMapUrl: CMAP_URL, cMapPacked: true, standardFontDataUrl: FONT_URL, isEvalSupported: false };

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const icon = (id, cls) => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  if (cls) s.setAttribute('class', cls);
  const u = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  u.setAttribute('href', '#i-' + id);
  s.append(u);
  return s;
};
const basename = (p) => p.split(/[\\/]/).pop();
const dirname = (p) => p.replace(/[\\/][^\\/]*$/, '');
const IMG_RE = /\.(jpe?g|jfif|png|webp|bmp|gif)$/i;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const debounce = (fn, ms) => {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
};
const nextFrame = () => new Promise((r) => requestAnimationFrame(r));
const fmtDate = (ms) => (ms ? new Date(ms).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '');

// ---------------------------------------------------------------- Persistência
const store = Object.assign(
  {
    recent: [], positions: {}, theme: 'system', sidebar: true, sideTab: 'thumbs', night: false,
    hlColor: '#ffd83d', ulColor: '#5db2ff', stColor: '#f04438', noteColor: '#ffd83d',
  },
  await api.storeGet(),
);
const saveStoreNow = () => api.storeSet(store);
const saveStore = debounce(saveStoreNow, 400);

function addRecent(path, title) {
  store.recent = store.recent.filter((r) => r.path !== path);
  store.recent.unshift({ path, title: title || basename(path), at: Date.now() });
  store.recent.length = Math.min(store.recent.length, 20);
  saveStore();
  renderRecent();
}

function savePosition(doc) {
  if (!doc.pdf || !doc.path) return;
  store.positions[doc.path] = { page: doc.currentPage, zoom: doc.zoomMode, rotation: doc.rotation, at: Date.now() };
  const keys = Object.keys(store.positions);
  if (keys.length > 300) {
    keys.sort((a, b) => store.positions[a].at - store.positions[b].at)
      .slice(0, keys.length - 300)
      .forEach((k) => delete store.positions[k]);
  }
  saveStore();
}

// ---------------------------------------------------------------- Busca: normalização (ignora acentos)
const foldCache = new Map();
function foldChar(c, matchCase) {
  const key = c + (matchCase ? '1' : '0');
  let r = foldCache.get(key);
  if (r === undefined) {
    r = c.normalize('NFD').charAt(0) || c;
    if (!matchCase) r = r.toLowerCase().charAt(0) || r;
    foldCache.set(key, r);
  }
  return r;
}
const NON_ASCII = /[^\x00-\x7f]/g;
function fold(s, matchCase) {
  // só os caracteres não ASCII passam pela tabela; depois dela todos já estão em minúsculas estáveis,
  // então o toLowerCase só mexe no ASCII e o texto continua com o mesmo comprimento
  const t = s.replace(NON_ASCII, (c) => foldChar(c, matchCase));
  return matchCase ? t : t.toLowerCase();
}

// ---------------------------------------------------------------- Estado global
const state = { docs: [], active: null, presentation: false, fullscreen: false, tool: 'select', author: '' };

// ================================================================= Documento
let docSeq = 0;
class Doc {
  constructor(path, { bytes = null, name = null, dir = null } = {}) {
    this.uid = ++docSeq;
    this.path = path;
    this.name = name || basename(path);
    this.dir = dir || (path ? dirname(path) : null);
    this.bytes = bytes;          // conteúdo em memória: documento novo ou alterado pelo OCR
    this.contentDirty = !!bytes;
    this.title = this.name;
    this.pdf = null;
    this.task = null;
    this.pages = [];
    this.zoomMode = 'auto';
    this.scale = 1;
    this.rotation = 0;
    this.currentPage = 1;
    this.visible = new Set();
    this.recentPages = []; // páginas preparadas pelo PDF.js, da mais antiga para a mais recente
    this.textCache = new Map();
    this.textPending = new Map(); // leituras de texto em andamento (evita pedir a mesma página duas vezes)
    this.search = null;
    this.searchToken = 0;
    this.closed = false;
    this.docGen = 0; // muda a cada recarga do conteúdo

    // anotações
    this.annots = [];
    this.importedSnap = new Map(); // ref → snapshot no momento da importação/último salvamento
    this.hiddenRefs = new Set();   // (PDFs protegidos) anotações do arquivo substituídas pelas do app
    this.sidecarMode = false;
    this.history = [];
    this.future = [];
    this.dirty = false;
    this.selectedId = null;

    this.viewer = el('div', 'viewer');
    this.viewer.tabIndex = -1;
    this.viewer.hidden = true;
    this.pagesEl = el('div', 'pages');
    this.viewer.append(this.pagesEl);
    $('#viewerHost').append(this.viewer);

    this.thumbsEl = el('div', 'thumbs');
    this.outlineEl = el('div', 'outline');
    this.annotListEl = el('div', 'annotList');

    this.tabEl = el('div', 'tab');
    this.tabEl.setAttribute('role', 'tab');
    this.tabEl.title = path || this.name;
    const close = el('button', 'close');
    close.title = 'Fechar (Ctrl+W)';
    close.append(icon('close'));
    close.addEventListener('click', (e) => { e.stopPropagation(); requestCloseDoc(this); });
    this.tabName = el('span', 'name', this.name);
    const dot = el('span', 'dirty-dot');
    dot.title = 'Anotações não salvas';
    this.tabEl.append(icon('file', 'file'), this.tabName, dot, close);
    this.tabEl.addEventListener('click', () => activate(this));
    this.tabEl.addEventListener('auxclick', (e) => { if (e.button === 1) requestCloseDoc(this); });
    $('#tabs').append(this.tabEl);

    this.bindViewerEvents();

    this.observer = new IntersectionObserver((entries) => this.onIntersect(entries), {
      root: this.viewer, rootMargin: '120% 0px',
    });
    this.thumbObserver = new IntersectionObserver((entries) => this.onThumbIntersect(entries), {
      root: $('#sideContent'), rootMargin: '300px 0px',
    });
  }

  bindViewerEvents() {
    const v = this.viewer;
    v.addEventListener('scroll', () => { this.onScroll(); hideSelBar(); positionPopover(); hideContextMenu(); }, { passive: true });
    v.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });

    v.addEventListener('click', (e) => {
      if (state.presentation) {
        if (!e.target.closest('.linkLayer a')) this.goToPage(this.currentPage + 1);
        return;
      }
      if (e.target.closest('.note-icon, .linkLayer a, .edMark')) return;
      const p = e.target.closest('.page')?._p;
      if (!p) return;
      if (editor.active && state.tool === 'select' && !this.panMoved && document.getSelection().isCollapsed && editor.click(this, p, e)) return;
      if (state.tool === 'note') { this.placeNote(p, e.clientX, e.clientY); return; }
      if (this.panMoved) return;
      if (!document.getSelection().isCollapsed) return;
      const id = this.hitTest(p, e.clientX, e.clientY);
      if (id) openPopover(this, id);
    });

    // clique duplo/triplo (selecionar palavra/linha): o bloco agendado pelo 1º clique não entra
    v.addEventListener('mousedown', (e) => { if (e.detail > 1) editor.cancelClick(); });

    v.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (state.presentation) { this.goToPage(this.currentPage - 1); return; }
      this.showContextMenu(e);
    });

    // cursor de "mãozinha" sobre anotações
    v.addEventListener('mousemove', (e) => {
      if (this.hoverRaf || e.buttons) return;
      const { clientX, clientY, target } = e;
      this.hoverRaf = requestAnimationFrame(() => {
        this.hoverRaf = 0;
        const p = target.closest?.('.page')?._p;
        const hit = p && state.tool !== 'note' && document.getSelection().isCollapsed && this.hitTest(p, clientX, clientY);
        v.classList.toggle('over-annot', !!hit);
        if (editor.active) editor.hover(this, state.tool === 'select' ? p : null, clientX, clientY);
      });
    });

    // ferramenta Mão: arrastar para rolar
    v.addEventListener('pointerdown', (e) => {
      this.panMoved = false;
      if (state.tool !== 'hand' || e.button !== 0 || state.presentation) return;
      if (e.target.closest('.note-icon, .linkLayer a')) return;
      const start = { x: e.clientX, y: e.clientY, l: v.scrollLeft, t: v.scrollTop };
      document.body.classList.add('panning');
      const move = (ev) => {
        const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
        if (!this.panMoved && Math.hypot(dx, dy) > 3) {
          this.panMoved = true;
          v.setPointerCapture(e.pointerId); // só captura ao arrastar, para o clique simples abrir anotações
        }
        if (!this.panMoved) return;
        v.scrollLeft = start.l - dx;
        v.scrollTop = start.t - dy;
      };
      const up = () => {
        v.removeEventListener('pointermove', move);
        v.removeEventListener('pointerup', up);
        v.removeEventListener('pointercancel', up);
        document.body.classList.remove('panning');
      };
      v.addEventListener('pointermove', move);
      v.addEventListener('pointerup', up);
      v.addEventListener('pointercancel', up);
    });
  }

  // ------------------------------------------------------------ Carregamento
  async load({ restore = null } = {}) {
    let data;
    if (this.bytes) data = this.bytes.slice();
    else [data, this.stamp] = await Promise.all([api.readFile(this.path), api.fileStat(this.path)]);
    if (this.closed) return;
    this.task = pdfjsLib.getDocument({ data, ...PDF_OPTIONS });
    this.task.onPassword = (update, reason) => {
      askPassword(this.name, reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD).then((pw) => {
        if (pw == null) { this.cancelled = true; this.task.destroy(); } else { this.password = pw; update(pw); }
      });
    };
    this.pdf = await this.task.promise;
    if (this.closed) return;

    const meta = await this.pdf.getMetadata().catch(() => null);
    const t = meta?.info?.Title?.trim();
    if (t && !/^untitled|^microsoft word/i.test(t)) this.title = t;
    this.meta = meta;
    this.labels = await this.pdf.getPageLabels().catch(() => null);

    // anotações guardadas pelo app (PDFs protegidos)
    const side = this.path && !restore ? await api.sidecarGet(this.path).catch(() => null) : null;
    if (side?.annots) {
      this.sidecarMode = true;
      this.hiddenRefs = new Set(side.hiddenRefs || []);
      for (const a of side.annots) {
        const x = { ...a, ref: 'side:' + a.id };
        this.annots.push(x);
        this.importedSnap.set(x.ref, A.snapshotOf(x));
      }
    }

    const first = await this.pdf.getPage(1);
    const vp = first.getViewport({ scale: 1 });
    for (let i = 1; i <= this.pdf.numPages; i++) {
      const div = el('div', 'page loading');
      const wrap = el('div', 'canvasWrap');
      div.append(wrap);
      div.dataset.page = i;
      const p = { num: i, w: vp.width, h: vp.height, div, wrap, page: i === 1 ? first : null, gen: 0 };
      div._p = p;
      this.pages.push(p);
      this.pagesEl.append(div);
      this.observer.observe(div);
    }

    const saved = restore || (this.path ? store.positions[this.path] : null);
    if (saved) {
      this.rotation = saved.rotation || 0;
      this.zoomMode = saved.zoom ?? 'auto';
    }
    this.scale = this.computeScale(this.zoomMode);
    this.layout();
    if (saved?.page > 1) this.goToPage(saved.page, null, true);

    this.buildThumbs();
    this.buildOutline();
    if (this.path && !restore) addRecent(this.path, this.title);
    this.updateDirty();
    if (state.active === this) { updateUI(); showSideTab(store.sideTab); }
    this.backgroundScan();
    this.checkScanned();
  }

  /** Desmonta as páginas (para recarregar o documento a partir de novos bytes). */
  teardownPages() {
    closePopover(true);
    hideSelBar();
    this.observer.disconnect();
    this.thumbObserver.disconnect();
    for (const p of this.pages) {
      p.renderTask?.cancel();
      if (p.textDiv) unregisterTextLayer(p.textDiv);
    }
    for (const p of this.pages) editor.dropLayer(p);
    editor.forgetDoc(this);
    this.pages = [];
    this.releaseTextHelpers();
    this.docGen++; // invalida leituras ainda em andamento do conteúdo anterior
    this.visible.clear();
    this.recentPages = [];
    this.textCache.clear();
    this.textPending.clear();
    this.searchToken++;
    this.search = null;
    this.lastThumb = null;
    this.pagesEl.textContent = '';
    this.thumbsEl.textContent = '';
    this.outlineEl.textContent = '';
  }

  /** Substitui o conteúdo (ex.: depois do OCR) mantendo página, zoom e anotações. */
  async reloadFromBytes(bytes) {
    const restore = { page: this.currentPage, zoom: this.zoomMode, rotation: this.rotation };
    this.teardownPages();
    const old = this.pdf;
    this.pdf = null;
    this.task = null;
    await old?.destroy();
    this.bytes = bytes;
    this.contentDirty = true;
    this.hideScanBanner();
    await this.load({ restore });
  }

  /** Detecta PDFs digitalizados (sem texto) e oferece o OCR. */
  async checkScanned() {
    const n = Math.min(3, this.pages.length);
    let chars = 0;
    try {
      for (let i = 1; i <= n; i++) chars += (await this.getText(i)).text.replace(/\s+/g, '').length;
    } catch { return; }
    if (this.closed) return;
    this.scanned = n > 0 && chars < 10;
    if (this.scanned && !this.bannerDismissed) this.showScanBanner();
    else this.hideScanBanner();
  }

  showScanBanner() {
    if (this.banner) return;
    const b = el('div', 'scan-banner');
    b.append(icon('ocr'), el('span', null, 'Este PDF parece ser digitalizado: o texto ainda não pode ser selecionado, copiado nem pesquisado.'));
    const go = el('button', 'primary small', 'Reconhecer texto (OCR)');
    go.addEventListener('click', () => showOcrDialog(this));
    const x = el('button', 'icon-btn small');
    x.title = 'Fechar aviso';
    x.append(icon('close'));
    x.addEventListener('click', () => { this.bannerDismissed = true; this.hideScanBanner(); });
    b.append(go, x);
    this.viewer.prepend(b);
    this.banner = b;
  }

  hideScanBanner() {
    this.banner?.remove();
    this.banner = null;
  }

  // Em segundo plano: tamanho real de cada página e anotações existentes
  async backgroundScan() {
    const gen = this.docGen;
    let changed = false;
    for (let i = 1; i <= this.pages.length; i++) {
      if (this.closed || gen !== this.docGen) return;
      if (i % 8 === 0) await this.viewSettled();
      if (this.closed || gen !== this.docGen) return;
      const p = this.pages[i - 1];
      try {
        const page = p.page || (p.page = await this.pdf.getPage(i));
        const vp = page.getViewport({ scale: 1 });
        if (Math.abs(vp.width - p.w) > 0.5 || Math.abs(vp.height - p.h) > 0.5) {
          p.w = vp.width; p.h = vp.height; changed = true;
        }
        await this.ensureAnnots(p);
      } catch { /* página inválida: mantém tamanho estimado */ }
      if (changed && (i % 40 === 0 || i === this.pages.length)) {
        const anchor = this.captureAnchor();
        this.layout();
        this.restoreAnchor(anchor);
        this.rebuildThumbFrames();
        changed = false;
      }
    }
  }

  /** Rótulo impresso da página (ex.: "A3"), ou o número. */
  pageLabel(n) {
    return this.labels?.[n - 1] || String(n);
  }

  dims(p) {
    return this.rotation % 180 === 0 ? [p.w, p.h] : [p.h, p.w];
  }

  // ------------------------------------------------------------ Zoom e layout
  computeScale(mode) {
    if (typeof mode === 'number') return clamp(mode, MIN_ZOOM, MAX_ZOOM);
    const p = this.pages[this.currentPage - 1] || this.pages[0];
    if (!p) return 1;
    const [w, h] = this.dims(p);
    const padX = state.presentation ? 0 : 36;
    const padY = state.presentation ? 0 : 34;
    const availW = Math.max(100, this.viewer.clientWidth - padX);
    const availH = Math.max(100, this.viewer.clientHeight - padY);
    const pw = availW / (w * CSS_UNITS);
    const ph = availH / (h * CSS_UNITS);
    let s;
    if (mode === 'page-width') s = pw;
    else if (mode === 'page-fit') s = Math.min(pw, ph);
    else s = w > h ? Math.min(pw, ph) : Math.min(pw, 1.25);
    return clamp(Math.floor(s * 1000) / 1000, MIN_ZOOM, MAX_ZOOM);
  }

  layout() {
    const sf = this.scale * CSS_UNITS;
    for (const p of this.pages) {
      const [w, h] = this.dims(p);
      p.div.style.width = Math.floor(w * sf) + 'px';
      p.div.style.height = Math.floor(h * sf) + 'px';
      p.div.style.setProperty('--scale-factor', sf);
    }
  }

  captureAnchor() {
    const p = this.pages[this.currentPage - 1];
    if (!p) return null;
    const top = this.viewer.scrollTop - p.div.offsetTop;
    const left = this.viewer.scrollLeft + this.viewer.clientWidth / 2;
    return { page: p, fy: top / p.div.offsetHeight, fx: left / this.pagesEl.scrollWidth };
  }

  restoreAnchor(a) {
    if (!a) return;
    this.viewer.scrollTop = a.page.div.offsetTop + a.fy * a.page.div.offsetHeight;
    this.viewer.scrollLeft = a.fx * this.pagesEl.scrollWidth - this.viewer.clientWidth / 2;
  }

  setZoom(mode) {
    if (!this.pdf) return;
    const anchor = this.captureAnchor();
    this.zoomMode = mode;
    const scale = this.computeScale(mode);
    if (scale !== this.scale) {
      this.scale = scale;
      this.layout();
      this.restoreAnchor(anchor);
      for (const p of this.visible) this.renderPage(p);
    }
    savePosition(this);
    if (state.active === this) updateZoomUI();
  }

  zoomStep(dir) {
    const cur = this.scale;
    let next;
    if (dir > 0) next = ZOOM_STEPS.find((z) => z > cur + 0.001) ?? MAX_ZOOM;
    else next = [...ZOOM_STEPS].reverse().find((z) => z < cur - 0.001) ?? MIN_ZOOM;
    this.setZoom(next);
  }

  rotate(delta = 90) {
    const anchor = this.captureAnchor();
    this.rotation = (this.rotation + delta + 360) % 360;
    this.scale = this.computeScale(this.zoomMode);
    this.layout();
    this.restoreAnchor(anchor);
    for (const p of this.visible) this.renderPage(p);
    this.rebuildThumbFrames();
    savePosition(this);
    updateZoomUI();
    closePopover();
  }

  onWheel(e) {
    if (state.presentation) {
      e.preventDefault();
      const now = Date.now();
      if (now - (this.lastWheel || 0) < 250) return;
      this.lastWheel = now;
      this.goToPage(this.currentPage + (e.deltaY > 0 ? 1 : -1));
      return;
    }
    if (!e.ctrlKey) return;
    e.preventDefault();
    const factor = Math.exp(-e.deltaY / 700);
    const newScale = clamp(this.scale * factor, MIN_ZOOM, MAX_ZOOM);
    // mantém o ponto sob o cursor fixo
    const rect = this.viewer.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const ratio = newScale / this.scale;
    const px = this.viewer.scrollLeft + mx, py = this.viewer.scrollTop + my;
    this.zoomMode = newScale;
    this.scale = newScale;
    this.layout();
    this.viewer.scrollLeft = px * ratio - mx;
    this.viewer.scrollTop = py * ratio - my;
    this.debouncedRerender ||= debounce(() => {
      for (const p of this.visible) this.renderPage(p);
      savePosition(this);
    }, 150);
    this.debouncedRerender();
    updateZoomUI();
  }

  // ------------------------------------------------------------ Navegação
  onScroll() {
    const mid = this.viewer.scrollTop + this.viewer.clientHeight * (state.presentation ? 0.5 : 0.3);
    let lo = 0, hi = this.pages.length - 1, found = 0;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (this.pages[m].div.offsetTop <= mid) { found = m; lo = m + 1; } else hi = m - 1;
    }
    const num = found + 1;
    if (num !== this.currentPage) {
      this.currentPage = num;
      if (state.active === this) updatePageUI();
      this.highlightThumb();
    }
    this.savePosDebounced ||= debounce(() => savePosition(this), 600);
    this.savePosDebounced();
  }

  goToPage(n, pdfTop = null) {
    if (!this.pages.length) return;
    n = clamp(Math.round(n) || 1, 1, this.pages.length);
    const p = this.pages[n - 1];
    let top;
    if (state.presentation) {
      top = p.div.offsetTop - Math.max(0, (this.viewer.clientHeight - p.div.offsetHeight) / 2);
    } else {
      top = p.div.offsetTop - 10;
    }
    this.viewer.scrollTop = top;
    if (pdfTop != null) {
      (p.page ? Promise.resolve(p.page) : this.pdf.getPage(n)).then((page) => {
        p.page = page;
        const vp = this.viewportFor(page);
        const [, y] = vp.convertToViewportPoint(0, pdfTop);
        this.viewer.scrollTop = p.div.offsetTop + y - 10;
      });
    }
    this.currentPage = n;
    if (state.active === this) updatePageUI();
    this.highlightThumb();
  }

  async goToDest(dest) {
    try {
      const explicit = typeof dest === 'string' ? await this.pdf.getDestination(dest) : dest;
      if (!Array.isArray(explicit)) return;
      const ref = explicit[0];
      let idx = null;
      if (ref && typeof ref === 'object') idx = await this.pdf.getPageIndex(ref);
      else if (Number.isInteger(ref)) idx = ref;
      if (idx == null) return;
      const mode = explicit[1]?.name;
      let top = null;
      if (mode === 'XYZ') top = explicit[3];
      else if (mode === 'FitH' || mode === 'FitBH') top = explicit[2];
      this.goToPage(idx + 1, typeof top === 'number' ? top : null);
    } catch (err) {
      console.warn('Destino inválido', err);
    }
  }

  viewportFor(page, scale = this.scale * CSS_UNITS) {
    return page.getViewport({ scale, rotation: (page.rotate + this.rotation) % 360 });
  }

  // ------------------------------------------------------------ Renderização sob demanda
  onIntersect(entries) {
    for (const e of entries) {
      const p = e.target._p;
      if (e.isIntersecting) {
        this.visible.add(p);
        this.renderPage(p);
      } else {
        this.visible.delete(p);
        this.unrender(p);
      }
    }
  }

  unrender(p) {
    p.gen++;
    p.renderTask?.cancel();
    p.renderTask = null;
    if (p.canvas) { p.canvas.width = p.canvas.height = 0; p.canvas.remove(); p.canvas = null; }
    if (p.textDiv) { unregisterTextLayer(p.textDiv); p.textDiv.remove(); }
    p.textDiv = null; p.textLayer = null; p.hlDivs = null;
    p.linkDiv?.remove(); p.linkDiv = null;
    p.svg?.remove(); p.outline?.remove(); p.noteLayer?.remove();
    p.svg = p.outline = p.noteLayer = null; p.geom = null;
    editor.dropLayer(p);
    p.renderedKey = null;
    p.pendingKey = null; // o desenho interrompido não conta como "em andamento" (senão a página voltava em branco)
    p.div.classList.add('loading');
  }

  async renderPage(p) {
    const key = `${this.scale}|${this.rotation}`;
    if (p.renderedKey === key || p.pendingKey === key) return;
    const gen = ++p.gen;
    p.pendingKey = key;
    p.renderTask?.cancel();
    try {
      const page = p.page || (p.page = await this.pdf.getPage(p.num));
      await this.ensureAnnots(p);
      if (gen !== p.gen) return;
      const viewport = this.viewportFor(page);
      const dpr = window.devicePixelRatio || 1;
      let out = dpr;
      if (viewport.width * viewport.height * out * out > MAX_CANVAS_PIXELS) {
        out = Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height));
      }
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width * out);
      canvas.height = Math.floor(viewport.height * out);
      const task = page.render({
        canvasContext: canvas.getContext('2d', { alpha: false }),
        viewport,
        transform: out !== 1 ? [out, 0, 0, out, 0, 0] : null,
        annotationMode: WITH_STORAGE,
      });
      p.renderTask = task;
      await task.promise;
      if (gen !== p.gen) { canvas.width = 0; return; }
      p.renderTask = null;
      if (p.canvas) { p.canvas.width = 0; p.canvas.remove(); }
      p.canvas = canvas;
      p.wrap.prepend(canvas);
      p.div.classList.remove('loading');
      p.renderedKey = key;
      this.keepPrepared(p);
      this.renderAnnotLayer(p);
      await this.renderTextLayer(p, page, viewport, gen);
      if (gen === p.gen) {
        this.renderLinks(p, viewport);
        if (editor.active) editor.renderLayer(this, p);
      }
    } catch (err) {
      if (err?.name !== 'RenderingCancelledException' && err?.message !== 'Documento recarregado') console.error('Erro ao renderizar página', p.num, err);
    } finally {
      if (gen === p.gen) p.pendingKey = null;
    }
  }

  /**
   * O PDF.js guarda, por página, tudo o que preparou para desenhá-la (em PDFs digitalizados ou com fotos,
   * as imagens já decodificadas: ~10 MB por página). Sem limite, a memória só crescia ao rolar o documento.
   * Mantém as PAGE_CACHE páginas usadas por último (voltar a elas é instantâneo) e libera as outras.
   */
  keepPrepared(p) {
    const list = this.recentPages;
    const i = list.indexOf(p);
    if (i !== -1) list.splice(i, 1);
    list.push(p);
    for (let k = 0; list.length > PAGE_CACHE && k < list.length - PAGE_CACHE;) {
      const q = list[k];
      if (this.visible.has(q) || q.pendingKey || q.thumbBusy) { k++; continue; }
      q.page?.cleanup();
      list.splice(k, 1);
    }
  }

  /** Resolve quando as páginas na tela terminam de desenhar (tarefas secundárias esperam a vez). */
  viewSettled() {
    return new Promise((resolve) => {
      const check = () => {
        if (this.closed || ![...this.visible].some((p) => p.pendingKey)) resolve();
        else setTimeout(check, 60);
      };
      check();
    });
  }

  getText(num, source = null) {
    const tc = this.textCache.get(num);
    if (tc) return Promise.resolve(tc);
    let pending = this.textPending.get(num);
    if (!pending) {
      pending = this.readText(num, source).finally(() => {
        if (this.textPending.get(num) === pending) this.textPending.delete(num);
      });
      this.textPending.set(num, pending);
    }
    return pending;
  }

  async readText(num, source = null) {
    const gen = this.docGen;
    const p = this.pages[num - 1];
    if (!p || !this.pdf) throw new Error('Documento recarregado');
    const page = source ? await source.getPage(num) : p.page || (p.page = await this.pdf.getPage(num));
    const content = await page.getTextContent();
    if (source) page.cleanup();
    // o documento foi recarregado (ex.: OCR) enquanto o texto era lido: descarta o resultado antigo
    if (gen !== this.docGen) throw new Error('Documento recarregado');
    const items = content.items.filter((it) => it.str !== undefined);
    // Texto da página: um espaço virtual após cada fim de linha para a busca atravessar linhas
    const offsets = [];
    let text = '', lines = '';
    for (const it of items) {
      offsets.push(text.length);
      text += it.str;
      lines += it.str;
      if (it.hasEOL) { text += ' '; lines += '\n'; }
    }
    const tc = { content, items, offsets, text, lines, folded: {} };
    this.textCache.set(num, tc);
    return tc;
  }

  /**
   * Lê o texto de todas as páginas pedindo várias de uma vez ao worker do PDF.js (uma por vez, ele ficava
   * esperando a ida e volta de cada pedido). Chama visit(n, tc) na ordem das páginas; para se stop() for true.
   */
  async eachText(visit, stop, ahead = 8) {
    const total = this.pages.length;
    const helpers = this.textCache.size < total ? await this.textHelpers() : [];
    if (helpers.length) { this.helperUsers = (this.helperUsers || 0) + 1; clearTimeout(this.helperTimer); }
    const sources = [null, ...helpers];
    ahead *= sources.length;
    const queue = [];
    const want = (n) => { if (n <= total) queue[n] = this.getText(n, sources[n % sources.length]).catch(() => null); };
    try {
      for (let n = 1; n <= Math.min(ahead, total); n++) want(n);
      for (let n = 1; n <= total; n++) {
        want(n + ahead);
        const tc = await queue[n];
        queue[n] = null;
        if (stop()) return false;
        if (tc) visit(n, tc);
      }
      return true;
    } finally {
      // Ninguém mais usando os leitores extras: com o texto todo lido, fecha na hora; senão, após 15 s parados.
      if (helpers.length && --this.helperUsers === 0) {
        if (this.textCache.size >= total) this.releaseTextHelpers();
        else this.helperTimer = setTimeout(() => { if (!this.helperUsers) this.releaseTextHelpers(); }, 15000);
      }
    }
  }

  /**
   * Leitores extras (outros workers do PDF.js com o mesmo arquivo) para ler o texto de documentos longos
   * em paralelo: um worker sozinho leva ~8 ms por página, e a busca num livro de 600 páginas levava ~5 s.
   * São criados na primeira busca e fechados quando todo o texto já foi lido (ou o documento fecha).
   */
  textHelpers() {
    if (this.helpersPromise) return this.helpersPromise;
    const cores = navigator.hardwareConcurrency || 2;
    let k = Math.min(3, Math.floor((cores - 2) / 2));
    if (k < 1 || this.pages.length < 60) return Promise.resolve([]);
    const gen = this.docGen;
    const tasks = [];
    this.helperTasks = tasks;
    this.helpersPromise = (async () => {
      let data;
      if (this.bytes) data = this.bytes;
      else {
        // relê o arquivo só se ele não mudou no disco desde que foi aberto
        const st = await api.fileStat(this.path);
        if (!st || !this.stamp || st.size !== this.stamp.size || st.mtime !== this.stamp.mtime) return [];
        data = await api.readFile(this.path);
      }
      if (gen !== this.docGen || this.closed || data.length > 150e6) return [];
      if (data.length > 50e6) k = 1; // cada leitor guarda uma cópia do arquivo
      for (let i = 0; i < k; i++) {
        const task = pdfjsLib.getDocument({ data: data.slice(), password: this.password, ...PDF_OPTIONS });
        task.onPassword = () => task.destroy();
        tasks.push(task);
      }
      const docs = await Promise.all(tasks.map((t) => t.promise.catch(() => null)));
      return docs.filter((d) => d && d.numPages === this.pages.length);
    })().catch(() => []);
    return this.helpersPromise;
  }

  releaseTextHelpers() {
    clearTimeout(this.helperTimer);
    for (const t of this.helperTasks || []) t.destroy();
    this.helperTasks = null;
    this.helpersPromise = null;
  }

  /** Adianta a leitura do texto (ao abrir a barra de busca), para a busca terminar mais rápido. */
  prefetchText() {
    if (this.prefetching || !this.pdf || this.textCache.size >= this.pages.length) return;
    this.prefetching = true;
    const gen = this.docGen;
    this.eachText(() => {}, () => this.closed || gen !== this.docGen, 3)
      .finally(() => { this.prefetching = false; });
  }

  async renderTextLayer(p, page, viewport, gen) {
    const tc = await this.getText(p.num);
    if (gen !== p.gen) return;
    const div = el('div', 'textLayer');
    const tl = new pdfjsLib.TextLayer({ textContentSource: tc.content, container: div, viewport });
    await tl.render();
    if (gen !== p.gen) return;
    if (p.textDiv) { unregisterTextLayer(p.textDiv); p.textDiv.remove(); }
    p.div.append(div);
    p.textDiv = div;
    p.textLayer = tl;
    p.hlDivs = null;
    registerTextLayer(div);
    this.applyHighlights(p);
  }

  renderLinks(p, viewport) {
    p.linkDiv?.remove();
    const layer = el('div', 'linkLayer');
    for (const a of p.annots || []) {
      if (a.subtype !== 'Link') continue;
      const url = a.url || a.unsafeUrl;
      if (!url && !a.dest && !a.action) continue;
      const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(a.rect);
      const link = document.createElement('a');
      link.style.left = (Math.min(x1, x2) / viewport.width) * 100 + '%';
      link.style.top = (Math.min(y1, y2) / viewport.height) * 100 + '%';
      link.style.width = (Math.abs(x2 - x1) / viewport.width) * 100 + '%';
      link.style.height = (Math.abs(y2 - y1) / viewport.height) * 100 + '%';
      if (url) {
        link.title = url;
        link.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); api.openExternal(url); });
      } else if (a.dest) {
        link.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); this.goToDest(a.dest); });
      } else if (a.action) {
        link.addEventListener('click', (e) => {
          e.preventDefault(); e.stopPropagation();
          const n = this.currentPage;
          const map = { NextPage: n + 1, PrevPage: n - 1, FirstPage: 1, LastPage: this.pages.length };
          if (map[a.action]) this.goToPage(map[a.action]);
        });
      }
      layer.append(link);
    }
    p.div.append(layer);
    p.linkDiv = layer;
  }

  // ------------------------------------------------------------ Anotações: importação e camada visual
  ensureAnnots(p) {
    if (!p.annotsPromise) {
      p.annotsPromise = (async () => {
        const page = p.page || (p.page = await this.pdf.getPage(p.num));
        const list = await page.getAnnotations({ intent: 'display' }).catch(() => []);
        p.annots = list;
        const added = [];
        for (const d of list) {
          const a = A.fromPdfJs(d, p.num);
          if (!a) continue;
          // o PDF.js deixa de desenhar a original; o app passa a desenhá-la (e permite editá-la)
          this.pdf.annotationStorage.setValue(d.id, { noView: true, noPrint: true });
          if (this.hiddenRefs.has(d.id) || this.importedSnap.has(d.id)) continue;
          added.push(a);
          this.importedSnap.set(a.ref, A.snapshotOf(a));
        }
        if (added.some((a) => a.type !== 'note')) {
          try {
            const tc = await this.getText(p.num);
            for (const a of added) if (a.type !== 'note' && !a.text) a.text = A.textForQuads(tc.items, a.quads);
          } catch { /* sem texto: a lista mostra só o tipo */ }
        }
        if (added.length) {
          this.annots.push(...added);
          // mantém o histórico de desfazer coerente com as anotações recém-importadas
          for (const snap of [...this.history, ...this.future]) snap.push(...structuredClone(added));
          this.annotListChanged();
        }
      })();
    }
    return p.annotsPromise;
  }

  find(id) { return this.annots.find((a) => a.id === id); }
  pageAnnots(num) { return this.annots.filter((a) => a.page === num); }

  renderAnnotLayer(p) {
    p.svg?.remove(); p.outline?.remove(); p.noteLayer?.remove();
    p.svg = p.outline = p.noteLayer = null;
    if (!p.page) return;
    const vp = this.viewportFor(p.page, 1);
    const list = this.pageAnnots(p.num);
    p.vp1 = vp;
    p.geom = A.geometry(list, vp);
    if (!list.length) return;
    const [svg, outline] = A.buildSvgLayer(list, vp, this.selectedId);
    p.wrap.append(svg);
    p.div.append(outline);
    p.svg = svg;
    p.outline = outline;
    const notes = list.filter((a) => a.type === 'note');
    if (!notes.length) return;
    const layer = el('div', 'noteLayer');
    for (const a of notes) {
      const [x1, y1, x2, y2] = A.noteBox(a, vp);
      const b = el('button', 'note-icon' + (a.id === this.selectedId ? ' sel' : ''));
      b.style.left = (x1 / vp.width) * 100 + '%';
      b.style.top = (y1 / vp.height) * 100 + '%';
      b.style.width = ((x2 - x1) / vp.width) * 100 + '%';
      b.style.height = ((y2 - y1) / vp.height) * 100 + '%';
      b.style.setProperty('--note', a.color);
      b.dataset.id = a.id;
      b.title = a.comment ? a.comment.slice(0, 300) : 'Nota (clique para escrever)';
      b.append(icon('note-lines'));
      this.bindNoteDrag(b, a.id, p);
      layer.append(b);
    }
    p.div.append(layer);
    p.noteLayer = layer;
  }

  bindNoteDrag(b, id, p) {
    b.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      const sx = e.clientX, sy = e.clientY;
      let moved = false;
      b.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const dx = ev.clientX - sx, dy = ev.clientY - sy;
        if (!moved && Math.hypot(dx, dy) < 4) return;
        moved = true;
        b.classList.add('dragging');
        b.style.transform = `translate(${dx}px, ${dy}px)`;
      };
      const up = (ev) => {
        b.removeEventListener('pointermove', move);
        b.removeEventListener('pointerup', up);
        if (!moved) { openPopover(this, id); return; }
        const a = this.find(id);
        const vp = p.vp1;
        const r = p.div.getBoundingClientRect();
        if (!a || !vp) return;
        const [x1, y1, x2, y2] = A.noteBox(a, vp);
        const w = x2 - x1, h = y2 - y1;
        const nx = clamp(x1 + ((ev.clientX - sx) * vp.width) / r.width, 0, vp.width - w);
        const ny = clamp(y1 + ((ev.clientY - sy) * vp.height) / r.height, 0, vp.height - h);
        const pa = vp.convertToPdfPoint(nx, ny), pb = vp.convertToPdfPoint(nx + w, ny + h);
        this.mutate(() => {
          const t = this.find(id);
          t.rect = [Math.min(pa[0], pb[0]), Math.min(pa[1], pb[1]), Math.max(pa[0], pb[0]), Math.max(pa[1], pb[1])]
            .map((n) => Math.round(n * 100) / 100);
          t.modified = Date.now();
        }, [p.num]);
      };
      b.addEventListener('pointermove', move);
      b.addEventListener('pointerup', up);
    });
  }

  /** id da anotação de marcação sob o ponto (coordenadas da janela) */
  hitTest(p, cx, cy) {
    if (!p.geom?.length || !p.vp1) return null;
    const r = p.div.getBoundingClientRect();
    const x = ((cx - r.left) / r.width) * p.vp1.width;
    const y = ((cy - r.top) / r.height) * p.vp1.height;
    for (let i = p.geom.length - 1; i >= 0; i--) {
      const g = p.geom[i];
      if (g.a.type === 'note') continue;
      for (const [x1, y1, x2, y2] of g.boxes) {
        if (x >= x1 - 1 && x <= x2 + 1 && y >= y1 - 1 && y <= y2 + 1) return g.a.id;
      }
    }
    return null;
  }

  /** Retângulo (coordenadas da janela) de uma anotação já desenhada */
  clientRectOf(id) {
    const a = this.find(id);
    const p = a && this.pages[a.page - 1];
    const g = p?.geom?.find((x) => x.a.id === id);
    if (!g || !p.div.isConnected) return null;
    const r = p.div.getBoundingClientRect();
    const sx = r.width / p.vp1.width, sy = r.height / p.vp1.height;
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const b of g.boxes) { x1 = Math.min(x1, b[0]); y1 = Math.min(y1, b[1]); x2 = Math.max(x2, b[2]); y2 = Math.max(y2, b[3]); }
    return { left: r.left + x1 * sx, top: r.top + y1 * sy, right: r.left + x2 * sx, bottom: r.top + y2 * sy };
  }

  // ------------------------------------------------------------ Anotações: edição
  mutate(fn, pages = null, coalesceKey = null) {
    if (!coalesceKey || coalesceKey !== this.lastCoalesce) {
      this.history.push(structuredClone(this.annots));
      if (this.history.length > 200) this.history.shift();
    }
    this.lastCoalesce = coalesceKey;
    this.future = [];
    fn();
    this.annotsChanged(pages);
  }

  annotsChanged(pages) {
    const set = pages ? new Set(pages) : null;
    for (const p of this.pages) {
      if (set && !set.has(p.num)) continue;
      if (p.renderedKey) this.renderAnnotLayer(p);
      if (p.thumbKey != null || p.thumbBusy) { p.thumbKey = null; if (p.thumbVisible) this.renderThumb(p); }
    }
    this.updateDirty();
    this.annotListChanged();
  }

  undo() {
    if (!this.history.length) { toast('Nada para desfazer.', 1200); return; }
    closePopover();
    this.future.push(structuredClone(this.annots));
    this.annots = this.history.pop();
    this.lastCoalesce = null;
    this.annotsChanged(null);
  }

  redo() {
    if (!this.future.length) { toast('Nada para refazer.', 1200); return; }
    closePopover();
    this.history.push(structuredClone(this.annots));
    this.annots = this.future.pop();
    this.lastCoalesce = null;
    this.annotsChanged(null);
  }

  addMarkup(type, color, coalesceKey = null) {
    const sel = document.getSelection();
    if (!sel.rangeCount || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    const now = Date.now();
    const created = [];
    for (const p of this.pages) {
      if (!p.textDiv || !p.page) continue;
      const res = A.quadsFromRange(range, p, this.viewportFor(p.page, 1));
      if (!res) continue;
      created.push({
        id: A.newId(), type, page: p.num, color, opacity: 1, quads: res.quads, text: res.text,
        comment: '', author: state.author, created: now, modified: now, ref: null,
      });
    }
    if (!created.length) return null;
    this.mutate(() => this.annots.push(...created), created.map((a) => a.page), coalesceKey);
    sel.removeAllRanges();
    hideSelBar();
    return created[0];
  }

  placeNote(p, cx, cy) {
    if (!p.page) return;
    const r = p.div.getBoundingClientRect();
    const vp = this.viewportFor(p.page, 1);
    const vx = ((cx - r.left) / r.width) * vp.width;
    const vy = ((cy - r.top) / r.height) * vp.height;
    const now = Date.now();
    const a = {
      id: A.newId(), type: 'note', page: p.num, color: store.noteColor, opacity: 1,
      rect: A.noteRectAt(p, vp, vx, vy), text: '', comment: '', author: state.author, created: now, modified: now, ref: null,
    };
    const key = 'pop:' + a.id;
    this.mutate(() => this.annots.push(a), [p.num], key);
    setTool('select');
    openPopover(this, a.id, { isNew: true, focus: true, key });
  }

  deleteAnnot(id) {
    const a = this.find(id);
    if (!a) return;
    if (pop.doc === this && pop.id === id) closePopover(true);
    this.mutate(() => { this.annots = this.annots.filter((x) => x.id !== id); }, [a.page]);
    toast('Anotação excluída. Ctrl+Z desfaz.', 2000);
  }

  select(id) {
    const prev = this.selectedId && this.find(this.selectedId);
    this.selectedId = id;
    const pages = new Set([prev?.page, this.find(id)?.page].filter(Boolean));
    for (const n of pages) { const p = this.pages[n - 1]; if (p?.renderedKey) this.renderAnnotLayer(p); }
    for (const it of this.annotListEl.querySelectorAll('.al-item')) it.classList.toggle('active', it.dataset.id === id);
  }

  async goToAnnot(id) {
    const a = this.find(id);
    if (!a) return;
    const p = this.pages[a.page - 1];
    const page = p.page || (p.page = await this.pdf.getPage(a.page));
    const vp = this.viewportFor(page);
    const [x1, y1] = A.geometry([a], vp)[0].boxes.reduce((m, b) => [Math.min(m[0], b[0]), Math.min(m[1], b[1])], [Infinity, Infinity]);
    this.viewer.scrollTop = p.div.offsetTop + y1 - this.viewer.clientHeight / 3;
    const left = p.div.offsetLeft + x1;
    if (left < this.viewer.scrollLeft || left > this.viewer.scrollLeft + this.viewer.clientWidth - 60) {
      this.viewer.scrollLeft = left - 60;
    }
    for (let i = 0; i < 120 && !(p.renderedKey && p.geom); i++) await nextFrame();
    openPopover(this, id);
  }

  // ------------------------------------------------------------ Salvar
  diff() {
    const cur = new Map();
    for (const a of this.annots) if (a.ref) cur.set(a.ref, a);
    const remove = [], add = [];
    for (const [ref, snap] of this.importedSnap) {
      const a = cur.get(ref);
      if (!a) remove.push(ref);
      else if (A.snapshotOf(a) !== snap) { remove.push(ref); add.push(a); }
    }
    for (const a of this.annots) if (!a.ref) add.push(a);
    return { remove, add };
  }

  updateDirty() {
    const { remove, add } = this.diff();
    const dirty = this.contentDirty || remove.length + add.length > 0;
    if (dirty === this.dirty) return;
    this.dirty = dirty;
    this.tabEl.classList.toggle('dirty', dirty);
    this.annotListChanged();
    if (state.active === this) updateUI();
  }

  resetBaseline() {
    this.importedSnap = new Map(this.annots.filter((a) => a.ref).map((a) => [a.ref, A.snapshotOf(a)]));
    this.updateDirty();
  }

  async save(saveAs = false) {
    if (this.saving || !this.pdf) return false;
    if (!this.path) saveAs = true; // documento novo: sempre pergunta onde salvar
    const { remove, add } = this.diff();
    let dest = this.path;
    if (saveAs) {
      const suggestion = this.path
        ? this.path.replace(/\.pdf$/i, '') + ' (cópia).pdf'
        : (this.dir ? this.dir + '\\' : '') + this.name;
      dest = await api.saveDialog(suggestion);
      if (!dest) return false;
    } else if (!remove.length && !add.length && !this.contentDirty) {
      return true;
    }
    if (this.sidecarMode) {
      if (saveAs) toast('Este PDF é protegido e não pode ser salvo em outro arquivo. As anotações ficaram guardadas no Leitor PDF.', 6000);
      return this.saveSidecar();
    }
    this.saving = true;
    toast('Salvando…', 20000);
    try {
      const res = await api.saveAnnotations({
        src: this.path,
        srcBytes: this.bytes || undefined,
        dest,
        remove: remove.filter((r) => !r.startsWith('side:')),
        add: add.map((a) => ({ ...A.plain(a), author: a.author || state.author })),
      });
      if (res.error === 'encrypted') {
        this.sidecarMode = true;
        await this.saveSidecar(true);
        toast('Este PDF é protegido contra alterações. As anotações foram guardadas no Leitor PDF, sem modificar o arquivo.', 7000);
        return true;
      }
      if (res.error) {
        toast(res.error === 'locked'
          ? 'Não foi possível salvar: o arquivo está aberto em outro programa ou é somente leitura. Use “Salvar como” (Ctrl+Shift+S).'
          : `Não foi possível salvar: ${res.message}`, 7000);
        return false;
      }
      for (const a of add) if (res.refs[a.id]) a.ref = res.refs[a.id];
      const hadContent = this.contentDirty;
      if (dest !== this.path) {
        const oldName = this.name;
        this.path = dest;
        this.name = basename(dest);
        this.dir = dirname(dest);
        this.tabEl.title = dest;
        if (this.title === oldName) this.title = this.name;
        addRecent(dest, this.title);
      }
      this.bytes = null;
      this.contentDirty = false;
      this.stamp = await api.fileStat(dest);
      this.resetBaseline();
      if (state.active === this) updateUI();
      toast(saveAs ? `Salvo como “${this.name}”.` : hadContent ? 'Documento salvo.' : 'Anotações salvas no PDF.', 2500);
      return true;
    } catch (err) {
      toast('Não foi possível salvar: ' + (err?.message || err), 7000);
      return false;
    } finally {
      this.saving = false;
    }
  }

  async saveSidecar(silent = false) {
    const hidden = new Set(this.hiddenRefs);
    const current = new Set(this.annots.map((a) => a.ref).filter(Boolean));
    for (const ref of this.importedSnap.keys()) if (!ref.startsWith('side:') && !current.has(ref)) hidden.add(ref);
    const stored = [];
    for (const a of this.annots) {
      const fromPdf = a.ref && !a.ref.startsWith('side:');
      if (fromPdf && this.importedSnap.get(a.ref) === A.snapshotOf(a)) continue;
      if (fromPdf) hidden.add(a.ref);
      a.ref = 'side:' + a.id;
      stored.push(A.plain(a));
    }
    await api.sidecarSet(this.path, { annots: stored, hiddenRefs: [...hidden] });
    this.hiddenRefs = hidden;
    this.resetBaseline();
    if (!silent) toast('Anotações guardadas no Leitor PDF (este arquivo é protegido).', 3000);
    return true;
  }

  // ------------------------------------------------------------ Lista de anotações (painel lateral)
  annotListChanged() {
    this.listDebounced ||= debounce(() => {
      if (this.closed) return;
      if (state.active === this) updateAnnotCount();
      if (state.active === this && store.sideTab === 'annots') this.renderAnnotList();
    }, 120);
    this.listDebounced();
  }

  renderAnnotList() {
    const box = this.annotListEl;
    const scroll = $('#sideContent').scrollTop;
    box.textContent = '';
    const list = [...this.annots].sort((a, b) => {
      const ka = A.sortKey(a), kb = A.sortKey(b);
      return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2];
    });
    const head = el('div', 'al-head');
    head.append(el('span', null, list.length === 1 ? '1 anotação' : `${list.length} anotações`));
    if (this.dirty) {
      const b = el('button', 'al-save', 'Salvar');
      b.title = 'Salvar anotações no PDF (Ctrl+S)';
      b.addEventListener('click', () => this.save());
      head.append(b);
    }
    box.append(head);
    if (!list.length) {
      box.append(el('p', 'empty', 'Nenhuma anotação. Selecione um trecho do texto para marcá-lo ou use a ferramenta Nota (N).'));
      return;
    }
    let lastPage = 0;
    for (const a of list) {
      if (a.page !== lastPage) { box.append(el('div', 'al-page', `Página ${a.page}`)); lastPage = a.page; }
      const it = el('div', 'al-item' + (a.id === this.selectedId ? ' active' : ''));
      it.dataset.id = a.id;
      it.style.setProperty('--c', a.color);
      const top = el('div', 'al-top');
      top.append(icon({ highlight: 'marker', underline: 'underline', strikeout: 'strike', note: 'note' }[a.type]), el('span', null, A.TYPE_LABEL[a.type]));
      if (a.modified) top.append(el('span', 'al-date', fmtDate(a.modified)));
      it.append(top);
      if (a.text) it.append(el('div', 'al-quote', a.text.length > 220 ? a.text.slice(0, 220) + '…' : a.text));
      if (a.comment) it.append(el('div', 'al-comment', a.comment));
      it.addEventListener('click', () => this.goToAnnot(a.id));
      box.append(it);
    }
    $('#sideContent').scrollTop = scroll;
  }

  // ------------------------------------------------------------ Menu de contexto
  showContextMenu(e) {
    const p = e.target.closest('.page')?._p;
    const noteId = e.target.closest('.note-icon')?.dataset.id;
    const annotId = noteId || (p && this.hitTest(p, e.clientX, e.clientY));
    const a = annotId && this.find(annotId);
    const hasSel = selectionInTextLayer();
    const selText = hasSel ? document.getSelection().toString() : '';
    const items = [];
    if (a) {
      items.push({ label: 'Editar anotação…', icon: 'comment', action: () => openPopover(this, a.id) });
      if (a.text) items.push({ label: 'Copiar texto marcado', icon: 'copy', action: () => copyText(a.text) });
      items.push({ label: 'Excluir anotação', icon: 'trash', kbd: 'Del', action: () => this.deleteAnnot(a.id) });
      items.push({ sep: true });
    }
    if (hasSel) {
      items.push(
        { label: 'Copiar', icon: 'copy', kbd: 'Ctrl+C', action: () => copySelection(false) },
        { label: 'Copiar sem quebras de linha', action: () => copySelection(true) },
        { sep: true },
        { label: 'Marcar texto', icon: 'marker', swatch: store.hlColor, action: () => this.addMarkup('highlight', store.hlColor) },
        { label: 'Sublinhar', icon: 'underline', action: () => this.addMarkup('underline', store.ulColor) },
        { label: 'Tachar', icon: 'strike', action: () => this.addMarkup('strikeout', store.stColor) },
        { label: 'Comentar…', icon: 'comment', action: () => commentSelection(this) },
        { sep: true },
        { label: `Buscar “${selText.trim().slice(0, 30)}${selText.trim().length > 30 ? '…' : ''}”`, icon: 'search', action: () => { $('#searchInput').value = selText.trim().slice(0, 200); openSearchBar(); triggerSearch(); } },
        { sep: true },
      );
    }
    if (p && !a) {
      items.push({ label: 'Adicionar nota aqui', icon: 'note', action: () => this.placeNote(p, e.clientX, e.clientY) });
    }
    if (p) {
      items.push(
        { label: 'Selecionar texto da página', icon: 'cursor', action: () => selectPageText(this, p) },
        { label: 'Copiar texto da página', action: async () => copyText((await this.getText(p.num)).lines) },
        { sep: true },
      );
    }
    items.push({ label: 'Reconhecer texto (OCR)…', icon: 'ocr', kbd: 'Ctrl+Shift+O', action: () => showOcrDialog(this) }, { sep: true });
    items.push(
      { label: 'Desfazer', icon: 'undo', kbd: 'Ctrl+Z', disabled: !this.history.length, action: () => this.undo() },
      { label: 'Refazer', kbd: 'Ctrl+Y', disabled: !this.future.length, action: () => this.redo() },
    );
    showContextMenu(e.clientX, e.clientY, items);
  }

  // ------------------------------------------------------------ Miniaturas e sumário
  buildThumbs() {
    this.thumbsEl.textContent = '';
    for (const p of this.pages) {
      const t = el('div', 'thumb');
      const frame = el('div', 'frame');
      const num = el('div', 'num', String(p.num));
      t.append(frame, num);
      t.addEventListener('click', () => this.goToPage(p.num));
      frame._p = p;
      p.thumb = t;
      p.thumbFrame = frame;
      this.thumbsEl.append(t);
      this.thumbObserver.observe(frame);
    }
    this.rebuildThumbFrames();
    this.highlightThumb();
  }

  rebuildThumbFrames() {
    for (const p of this.pages) {
      if (!p.thumbFrame) continue;
      const [w, h] = this.dims(p);
      p.thumbFrame.style.height = Math.round((THUMB_W * h) / w) + 'px';
      if (p.thumbKey != null && p.thumbKey !== this.rotation) {
        p.thumbFrame.textContent = '';
        p.thumbKey = null;
        if (p.thumbVisible) this.renderThumb(p);
      }
    }
  }

  onThumbIntersect(entries) {
    for (const e of entries) {
      const p = e.target._p;
      p.thumbVisible = e.isIntersecting;
      if (e.isIntersecting) this.renderThumb(p);
    }
  }

  async renderThumb(p) {
    if (p.thumbBusy) { p.thumbAgain = true; return; }
    if (p.thumbKey === this.rotation) return;
    p.thumbBusy = true;
    p.thumbAgain = false;
    let rot = this.rotation;
    let ok = false;
    try {
      await this.viewSettled(); // as miniaturas não disputam o PDF.js com as páginas na tela
      if (this.closed || !this.pdf) return;
      rot = this.rotation;
      const page = p.page || (p.page = await this.pdf.getPage(p.num));
      await this.ensureAnnots(p);
      const base = this.viewportFor(page, 1);
      const dpr = window.devicePixelRatio || 1;
      const vp = this.viewportFor(page, (THUMB_W * dpr) / base.width);
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      const ctx = canvas.getContext('2d', { alpha: false });
      await page.render({ canvasContext: ctx, viewport: vp, annotationMode: WITH_STORAGE }).promise;
      A.drawOnCanvas(ctx, vp, this.pageAnnots(p.num));
      p.thumbFrame.textContent = '';
      p.thumbFrame.append(canvas);
      p.thumbKey = rot;
      ok = true;
      this.keepPrepared(p);
    } catch (err) {
      console.warn('Miniatura', p.num, err);
    } finally {
      p.thumbBusy = false;
      if (p.thumbVisible && (p.thumbAgain || (ok && p.thumbKey !== this.rotation))) {
        p.thumbKey = null;
        this.renderThumb(p);
      }
    }
  }

  highlightThumb() {
    const p = this.pages[this.currentPage - 1];
    if (!p?.thumb || this.lastThumb === p.thumb) return;
    this.lastThumb?.classList.remove('current');
    p.thumb.classList.add('current');
    this.lastThumb = p.thumb;
    if (state.active === this && store.sideTab === 'thumbs' && store.sidebar) {
      p.thumb.scrollIntoView({ block: 'nearest' });
    }
  }

  async buildOutline() {
    const outline = await this.pdf.getOutline().catch(() => null);
    this.hasOutline = !!outline?.length;
    this.outlineEl.textContent = '';
    if (!this.hasOutline) {
      this.outlineEl.append(el('p', 'empty', 'Este documento não possui sumário.'));
      return;
    }
    const build = (items, depth) => {
      const ul = el('ul');
      for (const item of items) {
        const li = el('li');
        const row = el('div', 'row');
        const tw = el('button', 'twisty');
        tw.append(icon('right'));
        if (item.items?.length) {
          tw.addEventListener('click', () => li.classList.toggle('open'));
          if (depth === 0 && items.length < 12) li.classList.add('open');
        } else tw.classList.add('leaf');
        const a = el('a', null, item.title || '(sem título)');
        if (item.bold) a.style.fontWeight = '600';
        if (item.italic) a.style.fontStyle = 'italic';
        a.addEventListener('click', () => {
          if (item.dest) this.goToDest(item.dest);
          else if (item.url) api.openExternal(item.url);
        });
        row.append(tw, a);
        li.append(row);
        if (item.items?.length) li.append(build(item.items, depth + 1));
        ul.append(li);
      }
      return ul;
    };
    this.outlineEl.append(build(outline, 0));
  }

  // ------------------------------------------------------------ Busca
  async runSearch(query, matchCase) {
    const token = ++this.searchToken;
    const prev = this.search;
    this.search = { query, matchCase, matches: [], byPage: new Map(), current: -1, done: false, scanned: 0 };
    if (prev) for (const p of this.pages) if (p.hlDivs) this.applyHighlights(p);
    if (!query.trim()) { this.search.done = true; updateSearchUI(); return; }
    const q = fold(query, matchCase);
    const startPage = this.currentPage;
    let lastUi = 0;
    const finished = await this.eachText((n, tc) => {
      const key = matchCase ? 'c' : 'i';
      const hay = tc.folded[key] || (tc.folded[key] = fold(tc.text, matchCase));
      let i = hay.indexOf(q);
      while (i !== -1) {
        const idx = this.search.matches.push({ page: n, start: i, end: i + q.length }) - 1;
        if (!this.search.byPage.has(n)) this.search.byPage.set(n, []);
        this.search.byPage.get(n).push(idx);
        i = hay.indexOf(q, i + Math.max(1, q.length));
      }
      this.search.scanned = n;
      if (this.search.current === -1 && n >= startPage && this.search.byPage.has(n)) {
        this.selectMatch(this.search.byPage.get(n)[0]);
      }
      const pg = this.pages[n - 1];
      if (pg.textLayer && this.search.byPage.has(n)) this.applyHighlights(pg);
      if (Date.now() - lastUi > 120) { updateSearchUI(); lastUi = Date.now(); }
    }, () => token !== this.searchToken || this.closed);
    if (!finished) return;
    this.search.done = true;
    if (this.search.current === -1 && this.search.matches.length) this.selectMatch(0);
    updateSearchUI();
  }

  selectMatch(idx) {
    const s = this.search;
    if (!s || !s.matches.length) return;
    const len = s.matches.length;
    const old = s.matches[s.current];
    s.current = ((idx % len) + len) % len;
    const m = s.matches[s.current];
    if (old && old.page !== m.page) this.applyHighlights(this.pages[old.page - 1]);
    const p = this.pages[m.page - 1];
    this.scrollToSelected = true;
    if (p.textLayer) this.applyHighlights(p);
    else this.goToPage(m.page);
    updateSearchUI();
  }

  applyHighlights(p) {
    const tl = p.textLayer;
    if (!tl) return;
    const divs = tl.textDivs;
    const strs = tl.textContentItemsStr;
    if (p.hlDivs) for (const i of p.hlDivs) if (divs[i]) divs[i].textContent = strs[i];
    p.hlDivs = null;
    const s = this.search;
    const idxs = s?.byPage.get(p.num);
    if (!idxs?.length) return;
    const tc = this.textCache.get(p.num);
    if (!tc || divs.length !== tc.items.length) return;

    const perDiv = new Map();
    for (const mi of idxs) {
      const m = s.matches[mi];
      for (let i = 0; i < tc.items.length; i++) {
        const a = tc.offsets[i], b = a + strs[i].length;
        if (b <= m.start) continue;
        if (a >= m.end) break;
        if (!perDiv.has(i)) perDiv.set(i, []);
        perDiv.get(i).push({ from: Math.max(0, m.start - a), to: Math.min(b, m.end) - a, sel: mi === s.current });
      }
    }
    let selEl = null;
    for (const [i, ranges] of perDiv) {
      const div = divs[i], str = strs[i];
      ranges.sort((x, y) => x.from - y.from);
      div.textContent = '';
      let pos = 0;
      for (const r of ranges) {
        if (r.from < pos) continue;
        if (r.from > pos) div.append(str.slice(pos, r.from));
        const span = el('span', 'hl' + (r.sel ? ' sel' : ''), str.slice(r.from, r.to));
        div.append(span);
        if (r.sel && !selEl) selEl = span;
        pos = r.to;
      }
      if (pos < str.length) div.append(str.slice(pos));
    }
    p.hlDivs = [...perDiv.keys()];
    if (selEl && this.scrollToSelected) {
      this.scrollToSelected = false;
      selEl.scrollIntoView({ block: 'center', inline: 'nearest' });
    }
  }

  clearSearch() {
    this.searchToken++;
    this.search = null;
    for (const p of this.pages) if (p.hlDivs) this.applyHighlights(p);
  }

  // ------------------------------------------------------------ Encerramento
  destroy() {
    this.closed = true;
    this.observer.disconnect();
    this.thumbObserver.disconnect();
    for (const p of this.pages) {
      p.renderTask?.cancel();
      if (p.textDiv) unregisterTextLayer(p.textDiv);
    }
    this.viewer.remove();
    this.tabEl.remove();
    this.thumbsEl.remove();
    this.outlineEl.remove();
    this.annotListEl.remove();
    editor.forgetDoc(this);
    this.releaseTextHelpers();
    (this.pdf || this.task)?.destroy();
  }
}

// ================================================================= Abas
async function openPaths(paths) {
  const images = paths.filter((p) => IMG_RE.test(p));
  if (images.length) showImagesDialog(images);
  paths = paths.filter((p) => !IMG_RE.test(p));
  let last = null;
  for (const path of paths) {
    const existing = state.docs.find((d) => d.path && d.path.toLowerCase() === path.toLowerCase());
    if (existing) { last = existing; continue; }
    const doc = new Doc(path);
    state.docs.push(doc);
    activate(doc);
    last = doc;
    try {
      await doc.load();
    } catch (err) {
      const cancelled = doc.cancelled;
      closeDoc(doc, false);
      if (!cancelled) {
        console.error(err);
        const msg = err?.name === 'InvalidPDFException' ? 'o arquivo não é um PDF válido ou está corrompido.'
          : /ENOENT/.test(err?.message || '') ? 'o arquivo não foi encontrado.'
          : err?.message || String(err);
        toast(`Não foi possível abrir “${basename(path)}”: ${msg}`, 5000);
        if (/ENOENT/.test(err?.message || '')) {
          store.recent = store.recent.filter((r) => r.path !== path);
          saveStore(); renderRecent();
        }
      }
      last = null;
    }
  }
  if (last && !last.closed) activate(last);
}

async function openBytes(bytes, name, dir) {
  const doc = new Doc(null, { bytes, name, dir });
  state.docs.push(doc);
  activate(doc);
  try {
    await doc.load();
    return doc;
  } catch (err) {
    closeDoc(doc, false);
    toast('Não foi possível abrir o PDF gerado: ' + (err?.message || err), 7000);
    return null;
  }
}

async function openDialog() {
  const files = await api.openDialog();
  if (files.length) openPaths(files);
}

function activate(doc) {
  if (state.active && state.active !== doc) state.active.viewer.hidden = true;
  closePopover();
  hideSelBar();
  state.active = doc;
  for (const d of state.docs) d.tabEl.classList.toggle('active', d === doc);
  document.body.classList.toggle('no-doc', !doc);
  if (!doc) {
    document.title = 'Leitor PDF';
    $('#sideContent').textContent = '';
    $('#pageInput').value = '';
    $('#pageCount').textContent = '/ 0';
    $('#zoomSelect').value = 'auto';
    $('#zoomCustom').hidden = true;
    closeSearchBar();
    renderRecent();
    updateSaveUI();
    return;
  }
  doc.viewer.hidden = false;
  doc.tabEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  showSideTab(store.sideTab);
  if (doc.pdf && typeof doc.zoomMode === 'string') doc.setZoom(doc.zoomMode);
  updateUI();
  doc.viewer.focus({ preventScroll: true });
}

function closeDoc(doc, save = true) {
  if (!doc) return;
  if (save) savePosition(doc);
  const i = state.docs.indexOf(doc);
  if (i === -1) return;
  if (pop.doc === doc) closePopover(true);
  state.docs.splice(i, 1);
  doc.destroy();
  if (state.active === doc) {
    state.active = null;
    activate(state.docs[Math.min(i, state.docs.length - 1)] || null);
  }
}

async function requestCloseDoc(doc) {
  if (!doc) return false;
  if (doc.dirty) {
    activate(doc);
    const v = await showModal('Salvar anotações?', `Deseja salvar as anotações feitas em “${doc.name}”?`, [
      { label: 'Cancelar', value: null },
      { label: 'Não salvar', value: 'discard' },
      { label: 'Salvar', value: 'save', primary: true },
    ]);
    if (!v) return false;
    if (v === 'save' && !(await doc.save())) return false;
  }
  closeDoc(doc);
  return true;
}

function cycleTab(dir) {
  const n = state.docs.length;
  if (n < 2) return;
  const i = state.docs.indexOf(state.active);
  activate(state.docs[(i + dir + n) % n]);
}

// ================================================================= Interface
function updateUI() {
  const d = state.active;
  if (!d) return;
  document.title = `${d.dirty ? '• ' : ''}${d.title} — Leitor PDF`;
  d.tabName.textContent = d.title;
  updatePageUI();
  updateZoomUI();
  updateSearchUI();
  updateSaveUI();
  updateAnnotCount();
}

function updateSaveUI() {
  const d = state.active;
  $('#btnSave').disabled = !d?.dirty;
  $('#btnSave').title = d?.dirty ? 'Salvar anotações (Ctrl+S)' : 'Nenhuma alteração para salvar (Ctrl+S)';
}

function updateAnnotCount() {
  const n = state.active?.annots.length || 0;
  $('#annotCount').textContent = n ? String(n) : '';
}

function updatePageUI() {
  const d = state.active;
  if (!d) return;
  const n = d.pages.length;
  if (document.activeElement !== $('#pageInput')) $('#pageInput').value = n ? d.currentPage : '';
  $('#pageCount').textContent = `/ ${n || '…'}`;
  $('#btnPrev').disabled = d.currentPage <= 1;
  $('#btnNext').disabled = d.currentPage >= n;
}

function updateZoomUI() {
  const d = state.active;
  if (!d) return;
  const sel = $('#zoomSelect');
  const custom = $('#zoomCustom');
  const pct = Math.round(d.scale * 100) + '%';
  if (typeof d.zoomMode === 'string') {
    sel.value = d.zoomMode;
    custom.hidden = true;
  } else {
    const opt = [...sel.options].find((o) => Number(o.value) === d.zoomMode);
    if (opt) { sel.value = opt.value; custom.hidden = true; } else {
      custom.textContent = pct; custom.hidden = false; sel.value = 'custom';
    }
  }
  sel.title = `Zoom: ${pct}`;
  $('#btnZoomOut').disabled = d.scale <= MIN_ZOOM;
  $('#btnZoomIn').disabled = d.scale >= MAX_ZOOM;
}

function updateSearchUI() {
  const d = state.active;
  const s = d?.search;
  const status = $('#searchStatus');
  const input = $('#searchInput');
  input.classList.remove('nores');
  if (!s || !s.query.trim()) { status.textContent = ''; return; }
  const total = s.matches.length;
  if (!s.done) {
    status.textContent = total ? `${s.current + 1} de ${total}+ …` : `Buscando… ${s.scanned}/${d.pages.length}`;
  } else if (!total) {
    status.textContent = d.scanned ? 'Nenhum resultado (PDF sem texto: use o OCR)' : 'Nenhum resultado';
    input.classList.add('nores');
  } else {
    status.textContent = `${s.current + 1} de ${total}`;
  }
}

function showSideTab(which) {
  if (!['thumbs', 'outline', 'annots'].includes(which)) which = 'thumbs';
  store.sideTab = which;
  saveStore();
  for (const b of document.querySelectorAll('#sideTabs button')) b.classList.toggle('active', b.dataset.side === which);
  const c = $('#sideContent');
  c.textContent = '';
  const d = state.active;
  if (!d) return;
  c.append({ outline: d.outlineEl, thumbs: d.thumbsEl, annots: d.annotListEl }[which]);
  if (which === 'thumbs') {
    d.lastThumb = null;
    requestAnimationFrame(() => d.highlightThumb());
  } else if (which === 'annots') {
    d.renderAnnotList();
  }
}

function setSidebar(open) {
  store.sidebar = open;
  saveStore();
  document.body.classList.toggle('sidebar-open', open);
  $('#btnSidebar').classList.toggle('on', open);
}

function applyTheme() {
  const t = store.theme;
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  const names = { system: 'do sistema', light: 'claro', dark: 'escuro' };
  $('#btnTheme').title = `Tema: ${names[t]} (clique para alternar)`;
}

function setNight(on) {
  store.night = on;
  saveStore();
  document.body.classList.toggle('night', on);
  $('#btnNight').classList.toggle('on', on);
}

// ---------------------------------------------------------------- Ferramentas
const TOOLS = { select: '#btnToolSelect', hand: '#btnToolHand', highlight: '#btnToolHighlight', note: '#btnToolNote' };
function setTool(tool) {
  if (state.tool === tool && tool !== 'select') tool = 'select';
  state.tool = tool;
  for (const [t, sel] of Object.entries(TOOLS)) {
    $(sel).classList.toggle('on', t === tool);
    document.body.classList.toggle('tool-' + t, t === tool);
  }
  hideSelBar();
  if (tool === 'note') toast('Clique na página onde deseja colocar a nota.', 2000);
  if (tool === 'highlight') toast('Selecione o texto que deseja marcar.', 2000);
}

function updateMarkerColor() {
  $('#btnToolHighlight').style.setProperty('--marker', store.hlColor);
}

// ---------------------------------------------------------------- Seleção: copiar
function copyText(text, join = false) {
  if (!text) return;
  api.copyText(cleanText(text, { joinLines: join }));
  toast('Texto copiado.', 1200);
}

function copySelection(join) {
  copyText(document.getSelection().toString(), join);
}

function selectPageText(doc, p) {
  if (!p?.textDiv) return;
  const range = document.createRange();
  range.selectNodeContents(p.textDiv);
  const sel = document.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  setTimeout(showSelBar, 0);
}

document.addEventListener('copy', (e) => {
  if (e.target?.closest?.('input, textarea')) return;
  if (!selectionInTextLayer()) return;
  e.clipboardData.setData('text/plain', cleanText(document.getSelection().toString()));
  e.preventDefault();
});

// ---------------------------------------------------------------- Barra flutuante da seleção
const selBar = $('#selBar');
function buildSelBar() {
  selBar.textContent = '';
  const colors = el('div', 'sb-colors');
  for (const [hex, name] of A.COLORS) {
    const b = el('button', 'swatch' + (hex === store.hlColor ? ' on' : ''));
    b.style.background = hex;
    b.title = `Marcar em ${name.toLowerCase()}`;
    b.addEventListener('click', () => {
      store.hlColor = hex; saveStore(); updateMarkerColor();
      state.active?.addMarkup('highlight', hex);
    });
    colors.append(b);
  }
  const btn = (ic, title, fn) => {
    const b = el('button', 'icon-btn small');
    b.title = title;
    b.append(icon(ic));
    b.addEventListener('click', fn);
    return b;
  };
  selBar.append(
    colors,
    el('span', 'sep'),
    btn('underline', 'Sublinhar', () => state.active?.addMarkup('underline', store.ulColor)),
    btn('strike', 'Tachar', () => state.active?.addMarkup('strikeout', store.stColor)),
    btn('comment', 'Marcar e comentar', () => commentSelection(state.active)),
    el('span', 'sep'),
    btn('copy', 'Copiar (Ctrl+C)', () => { copySelection(false); document.getSelection().removeAllRanges(); hideSelBar(); }),
  );
  if (editor.active) {
    const send = el('button', 'sb-send', 'Enviar para ' + editor.fieldLabel());
    send.title = 'Acrescentar o trecho selecionado ao campo ativo do editor';
    send.addEventListener('click', () => sendSelectionToEditor());
    selBar.append(el('span', 'sep'), send);
  }
}

/** Trecho selecionado → campo ativo do editor de matérias (com a área marcada na página). */
function sendSelectionToEditor() {
  const d = state.active;
  const sel = document.getSelection();
  if (!d || !editor.active || sel.isCollapsed) return;
  const byPage = new Map();
  for (const r of sel.getRangeAt(0).getClientRects()) {
    if (r.width < 1 || r.height < 1) continue;
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const p = d.pages.find((q) => { const b = q.div.getBoundingClientRect(); return cx >= b.left && cx <= b.right && cy >= b.top && cy <= b.bottom; });
    if (!p?.page) continue;
    // retângulos grandes (fim da camada de texto, seleção que "vaza") não são linhas de texto
    const b = p.div.getBoundingClientRect();
    if (r.height > b.height * 0.08 || r.width > b.width * 0.98) continue;
    const cur = byPage.get(p);
    byPage.set(p, cur ? { left: Math.min(cur.left, r.left), top: Math.min(cur.top, r.top), right: Math.max(cur.right, r.right), bottom: Math.max(cur.bottom, r.bottom) } : { left: r.left, top: r.top, right: r.right, bottom: r.bottom });
  }
  editor.addSelection(d, cleanText(sel.toString()), [...byPage]);
  sel.removeAllRanges();
  hideSelBar();
}
selBar.addEventListener('mousedown', (e) => e.preventDefault());

function commentSelection(doc) {
  if (!doc) return;
  const key = 'pop:' + Date.now();
  const a = doc.addMarkup('highlight', store.hlColor, key);
  if (a) openPopover(doc, a.id, { focus: true, key });
}

function showSelBar() {
  const d = state.active;
  if (!d || state.presentation || state.tool !== 'select' || !selectionInTextLayer()) { hideSelBar(); return; }
  const range = document.getSelection().getRangeAt(0);
  const rects = [...range.getClientRects()].filter((r) => r.width > 1 && r.height > 1 && r.height < window.innerHeight * 0.3);
  if (!rects.length) { hideSelBar(); return; }
  buildSelBar();
  selBar.hidden = false;
  const top = Math.min(...rects.map((r) => r.top));
  const bottom = Math.max(...rects.map((r) => r.bottom));
  const first = rects[0], last = rects[rects.length - 1];
  const host = $('#viewerHost').getBoundingClientRect();
  const w = selBar.offsetWidth, h = selBar.offsetHeight;
  let y = top - h - 10;
  if (y < host.top + 4) y = bottom + 10;
  if (y + h > window.innerHeight - 4) y = Math.max(host.top + 4, last.top - h - 10);
  const cx = rects.length > 1 ? (first.left + last.right) / 2 : (first.left + first.right) / 2;
  selBar.style.left = clamp(cx - w / 2, host.left + 4, window.innerWidth - w - 6) + 'px';
  selBar.style.top = y + 'px';
}

function hideSelBar() { selBar.hidden = true; }

document.addEventListener('mouseup', (e) => {
  if (e.button !== 0 || e.target.closest?.('#selBar, #annotPop, #ctxMenu, #modal')) return;
  setTimeout(() => {
    const d = state.active;
    if (!d || !selectionInTextLayer()) { hideSelBar(); return; }
    if (state.tool === 'highlight') d.addMarkup('highlight', store.hlColor);
    else showSelBar();
  }, 0);
});
document.addEventListener('keyup', (e) => { if (e.shiftKey && e.key.startsWith('Arrow')) showSelBar(); });
document.addEventListener('selectionchange', () => { if (document.getSelection().isCollapsed) hideSelBar(); });

// ---------------------------------------------------------------- Popover de edição de anotação
const pop = { el: $('#annotPop'), doc: null, id: null, isNew: false, key: null };

function openPopover(doc, id, { isNew = false, focus = false, key = null } = {}) {
  closePopover();
  const a = doc.find(id);
  if (!a) return;
  hideSelBar();
  Object.assign(pop, { doc, id, isNew, key: key || 'pop:' + id + ':' + Date.now() });
  doc.select(id);
  buildPopover();
  pop.el.hidden = false;
  positionPopover();
  if (focus) pop.el.querySelector('textarea')?.focus();
}

function popChange(fn, visual = true) {
  const { doc, id } = pop;
  const a = doc?.find(id);
  if (!a) return;
  doc.mutate(() => { const t = doc.find(id); fn(t); t.modified = Date.now(); }, visual ? [a.page] : [], pop.key);
}

function buildPopover() {
  const { doc, id } = pop;
  const a = doc.find(id);
  const root = pop.el;
  root.textContent = '';

  const head = el('div', 'ap-head');
  head.append(icon({ highlight: 'marker', underline: 'underline', strikeout: 'strike', note: 'note' }[a.type]));
  const title = el('span', 'ap-title', A.TYPE_LABEL[a.type]);
  head.append(title, el('span', 'muted', `· pág. ${a.page}`), el('span', 'grow'));
  const del = el('button', 'icon-btn small');
  del.title = 'Excluir anotação (Delete)';
  del.append(icon('trash'));
  del.addEventListener('click', () => doc.deleteAnnot(id));
  const close = el('button', 'icon-btn small');
  close.title = 'Fechar (Esc)';
  close.append(icon('close'));
  close.addEventListener('click', () => closePopover());
  head.append(del, close);
  root.append(head);

  const row = el('div', 'ap-row');
  const swatches = el('div', 'sb-colors');
  for (const [hex, name] of A.COLORS) {
    const b = el('button', 'swatch' + (hex === a.color ? ' on' : ''));
    b.style.background = hex;
    b.title = name;
    b.addEventListener('click', () => {
      popChange((t) => { t.color = hex; });
      const t = doc.find(id);
      const k = { highlight: 'hlColor', underline: 'ulColor', strikeout: 'stColor', note: 'noteColor' }[t.type];
      store[k] = hex; saveStore(); updateMarkerColor();
      for (const s of swatches.children) s.classList.toggle('on', s === b);
    });
    swatches.append(b);
  }
  row.append(swatches);
  root.append(row);

  if (a.type !== 'note') {
    const seg = el('div', 'ap-seg');
    for (const [t, ic] of [['highlight', 'marker'], ['underline', 'underline'], ['strikeout', 'strike']]) {
      const b = el('button', t === a.type ? 'on' : '');
      b.append(icon(ic), el('span', null, A.TYPE_LABEL[t]));
      b.addEventListener('click', () => {
        popChange((x) => { x.type = t; });
        for (const s of seg.children) s.classList.toggle('on', s === b);
        title.textContent = A.TYPE_LABEL[t];
      });
      seg.append(b);
    }
    root.append(seg);
    if (a.text) {
      const q = el('div', 'ap-quote', a.text.length > 280 ? a.text.slice(0, 280) + '…' : a.text);
      root.append(q);
    }
  }

  const ta = el('textarea');
  ta.placeholder = a.type === 'note' ? 'Escreva sua nota…' : 'Adicionar comentário…';
  ta.value = a.comment || '';
  ta.rows = a.type === 'note' ? 5 : 3;
  ta.addEventListener('input', () => popChange((t) => { t.comment = ta.value; }, a.type === 'note'));
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); e.stopPropagation(); closePopover(); }
  });
  root.append(ta);

  const foot = el('div', 'ap-foot muted');
  const who = a.author || state.author;
  foot.textContent = [who, fmtDate(a.modified || a.created)].filter(Boolean).join(' · ');
  root.append(foot);
}

function positionPopover() {
  if (!pop.doc || pop.el.hidden) return;
  const r = pop.doc.clientRectOf(pop.id);
  const host = $('#viewerHost').getBoundingClientRect();
  if (!r || r.bottom < host.top || r.top > host.bottom) { pop.el.style.visibility = 'hidden'; return; }
  pop.el.style.visibility = '';
  const w = pop.el.offsetWidth, h = pop.el.offsetHeight;
  let top = r.bottom + 8;
  if (top + h > window.innerHeight - 8) top = r.top - h - 8;
  top = clamp(top, host.top + 4, window.innerHeight - h - 8);
  const left = clamp((r.left + r.right) / 2 - w / 2, host.left + 4, window.innerWidth - w - 8);
  pop.el.style.left = left + 'px';
  pop.el.style.top = top + 'px';
}

function closePopover(skipCleanup = false) {
  if (!pop.doc) return;
  const { doc, id, isNew } = pop;
  pop.doc = null;
  pop.el.hidden = true;
  if (!skipCleanup) {
    const a = doc.find(id);
    // nota nova e vazia: desiste dela (como no Edge)
    if (a && isNew && a.type === 'note' && !a.comment.trim()) {
      doc.annots = doc.annots.filter((x) => x.id !== id);
      doc.history.pop();
      doc.lastCoalesce = null;
      doc.annotsChanged([a.page]);
    }
  }
  if (doc.selectedId === id && !doc.closed) doc.select(null);
}

document.addEventListener('mousedown', (e) => {
  if (!pop.el.hidden && !pop.el.contains(e.target) && !e.target.closest?.(`.note-icon[data-id="${pop.id}"]`) && !e.target.closest?.('#ctxMenu')) {
    closePopover();
  }
  if (!e.target.closest?.('#ctxMenu')) hideContextMenu();
  if (!e.target.closest?.('#selBar') && e.button === 0) hideSelBar();
}, true);

// ---------------------------------------------------------------- Menu de contexto
const ctxMenu = $('#ctxMenu');
function showContextMenu(x, y, items) {
  ctxMenu.textContent = '';
  let lastSep = true;
  for (const it of items) {
    if (it.sep) {
      if (!lastSep) { ctxMenu.append(el('div', 'cm-sep')); lastSep = true; }
      continue;
    }
    const b = el('button', 'cm-item');
    b.disabled = !!it.disabled;
    const ic = el('span', 'cm-icon');
    if (it.swatch) { const s = el('span', 'cm-swatch'); s.style.background = it.swatch; ic.append(s); }
    else if (it.icon) ic.append(icon(it.icon));
    b.append(ic, el('span', 'cm-label', it.label));
    if (it.kbd) b.append(el('span', 'cm-kbd', it.kbd));
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => { hideContextMenu(); it.action(); });
    ctxMenu.append(b);
    lastSep = false;
  }
  if (ctxMenu.lastChild?.classList.contains('cm-sep')) ctxMenu.lastChild.remove();
  ctxMenu.hidden = false;
  const w = ctxMenu.offsetWidth, h = ctxMenu.offsetHeight;
  ctxMenu.style.left = Math.min(x, window.innerWidth - w - 6) + 'px';
  ctxMenu.style.top = Math.min(y, window.innerHeight - h - 6) + 'px';
  hideSelBar();
}
function hideContextMenu() { ctxMenu.hidden = true; }

// ---------------------------------------------------------------- Busca (barra)
function openSearchBar() {
  if (!state.active) return;
  const bar = $('#searchbar');
  bar.hidden = false;
  const input = $('#searchInput');
  const sel = window.getSelection().toString().trim();
  if (sel && sel.length < 100 && !sel.includes('\n')) { input.value = sel; triggerSearch(); }
  input.focus();
  input.select();
  $('#btnSearch').classList.add('on');
  state.active.prefetchText();
}

function closeSearchBar() {
  $('#searchbar').hidden = true;
  $('#btnSearch').classList.remove('on');
  state.active?.clearSearch();
  updateSearchUI();
  state.active?.viewer.focus({ preventScroll: true });
}

function triggerSearch() {
  const d = state.active;
  if (!d?.pdf) return;
  d.runSearch($('#searchInput').value, $('#searchCase').checked);
}
const triggerSearchDebounced = debounce(triggerSearch, 250);

function searchStep(dir) {
  const d = state.active;
  if (!d) return;
  const q = $('#searchInput').value;
  if (!d.search || d.search.query !== q || d.search.matchCase !== $('#searchCase').checked) { triggerSearch(); return; }
  if (d.search.matches.length) d.selectMatch(d.search.current + dir);
}

// ---------------------------------------------------------------- Tela inicial
function timeAgo(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'agora';
  if (s < 3600) return `há ${Math.floor(s / 60)} min`;
  if (s < 86400) return `há ${Math.floor(s / 3600)} h`;
  if (s < 86400 * 7) return `há ${Math.floor(s / 86400)} d`;
  return new Date(ts).toLocaleDateString('pt-BR');
}

function renderRecent() {
  const list = $('#recentList');
  list.textContent = '';
  $('#recentWrap').hidden = !store.recent.length;
  for (const r of store.recent) {
    const li = el('li');
    li.title = r.path;
    const meta = el('div', 'meta');
    meta.append(el('div', 'title', r.title || basename(r.path)), el('div', 'path', r.path));
    const rm = el('button', 'icon-btn small remove');
    rm.title = 'Remover da lista';
    rm.append(icon('close'));
    rm.addEventListener('click', (e) => {
      e.stopPropagation();
      store.recent = store.recent.filter((x) => x.path !== r.path);
      saveStore(); renderRecent();
    });
    li.append(icon('file'), meta, el('span', 'when', timeAgo(r.at)), rm);
    li.addEventListener('click', () => openPaths([r.path]));
    list.append(li);
  }
}

// ---------------------------------------------------------------- Diálogos
let modalResolve = null;
function showModal(title, body, buttons, { wide = false } = {}) {
  return new Promise((resolve) => {
    modalResolve?.(null);
    modalResolve = resolve;
    const m = $('#modal');
    m.textContent = '';
    m.classList.toggle('wide', wide);
    m.append(el('h3', null, title));
    if (typeof body === 'string') m.append(el('p', null, body)); else if (body) m.append(body);
    const actions = el('div', 'actions');
    for (const b of buttons) {
      const btn = el('button', b.primary ? 'primary' : '', b.label);
      btn.addEventListener('click', () => finish(b.value));
      actions.append(btn);
    }
    m.append(actions);
    const back = $('#modalBack');
    back.hidden = false;
    const finish = (v) => {
      back.hidden = true;
      if (modalResolve === resolve) modalResolve = null;
      resolve(typeof v === 'function' ? v() : v);
    };
    m._finish = finish;
    m._cancel = () => finish(null);
    (m.querySelector('input') || actions.querySelector('.primary') || actions.lastChild)?.focus();
  });
}

function askPassword(name, wrong) {
  const wrap = el('div');
  wrap.append(el('p', null, `“${name}” está protegido. Digite a senha para abri-lo.`));
  if (wrong) wrap.append(el('p', 'error', 'Senha incorreta. Tente novamente.'));
  const input = el('input');
  input.type = 'password';
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#modal')._finish(input.value); });
  wrap.append(input);
  return showModal('Documento protegido', wrap, [
    { label: 'Cancelar', value: null },
    { label: 'Abrir', value: () => input.value, primary: true },
  ]);
}

function formatBytes(n) {
  if (n == null) return '—';
  const u = ['bytes', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toLocaleString('pt-BR', { maximumFractionDigits: i ? 1 : 0 })} ${u[i]}`;
}

function formatPdfDate(s) {
  if (!s) return '—';
  const d = pdfjsLib.PDFDateString.toDateObject(s);
  return d ? d.toLocaleString('pt-BR') : s;
}

async function showProperties() {
  const d = state.active;
  if (!d?.pdf) return;
  const info = d.meta?.info || {};
  const stat = await api.fileStat(d.path);
  const p = d.pages[d.currentPage - 1];
  const mm = (pt) => Math.round((pt * 25.4) / 72);
  const table = el('table');
  const rows = [
    ['Arquivo', d.name],
    ['Local', d.path],
    ['Tamanho', formatBytes(stat?.size)],
    ['Título', info.Title || '—'],
    ['Autor', info.Author || '—'],
    ['Assunto', info.Subject || '—'],
    ['Palavras-chave', info.Keywords || '—'],
    ['Criado em', formatPdfDate(info.CreationDate)],
    ['Modificado em', formatPdfDate(info.ModDate)],
    ['Aplicativo', info.Creator || '—'],
    ['Produtor do PDF', info.Producer || '—'],
    ['Versão do PDF', info.PDFFormatVersion || '—'],
    ['Páginas', String(d.pages.length)],
    ['Tamanho da página', p ? `${mm(p.w)} × ${mm(p.h)} mm` : '—'],
    ['Anotações', `${d.annots.length}${d.sidecarMode ? ' (guardadas no Leitor PDF)' : ''}`],
    ['Otimizado para web', info.IsLinearized ? 'Sim' : 'Não'],
  ];
  for (const [k, v] of rows) {
    const tr = el('tr');
    tr.append(el('td', null, k), el('td', null, v));
    table.append(tr);
  }
  const wrap = el('div');
  wrap.append(table);
  const link = el('p', 'link', 'Mostrar na pasta');
  link.addEventListener('click', () => api.showInFolder(d.path));
  wrap.append(link);
  showModal('Propriedades do documento', wrap, [{ label: 'Fechar', value: null, primary: true }]);
}

function showHelp() {
  const groups = [
    ['Arquivos e abas', [
      ['Ctrl+O', 'Abrir PDF ou imagens'], ['Ctrl+S', 'Salvar'], ['Ctrl+Shift+S', 'Salvar como…'],
      ['Ctrl+Shift+O', 'Reconhecer texto (OCR)'],
      ['Ctrl+W', 'Fechar aba'], ['Ctrl+Tab / Ctrl+Shift+Tab', 'Próxima / aba anterior'],
    ]],
    ['Navegação', [
      ['Ctrl+G', 'Ir para a página'], ['Home / End', 'Primeira / última página'],
      ['← / →, PgUp / PgDn', 'Página anterior / próxima'],
      ['Ctrl+F', 'Buscar'], ['Enter / Shift+Enter, F3', 'Próximo / resultado anterior'],
    ]],
    ['Seleção e anotações', [
      ['V', 'Ferramenta de seleção de texto'], ['H', 'Ferramenta Mão (arrastar a página)'],
      ['M', 'Ferramenta Marca-texto'], ['N', 'Ferramenta Nota'],
      ['E', 'Editor de matéria (clique nos blocos para montar a matéria)'], ['Esc (no editor)', 'Limpar a matéria e começar outra'],
      ['Clique duplo / triplo', 'Seleciona palavra / linha'], ['Ctrl+A', 'Seleciona o texto da página'],
      ['Ctrl+C', 'Copiar (corrige hifenização e ligaduras)'],
      ['Ctrl+Z / Ctrl+Y', 'Desfazer / refazer anotação'], ['Delete', 'Excluir a anotação aberta'],
      ['Botão direito', 'Menu com todas as opções'],
    ]],
    ['Visualização', [
      ['Ctrl++ / Ctrl+− / Ctrl+roda', 'Aumentar / diminuir zoom'],
      ['Ctrl+0 / Ctrl+1 / Ctrl+2', 'Página inteira / 100% / largura'],
      ['Ctrl+R / Ctrl+Shift+R', 'Girar horário / anti-horário'],
      ['Ctrl+B', 'Painel lateral'], ['Ctrl+Shift+N', 'Modo noturno'],
      ['Ctrl+P', 'Imprimir'], ['Ctrl+D', 'Propriedades'],
      ['F5', 'Modo apresentação'], ['F11', 'Tela cheia'], ['Esc', 'Fechar busca / sair da apresentação'],
    ]],
  ];
  const wrap = el('div');
  for (const [name, shortcuts] of groups) {
    wrap.append(el('h4', 'help-group', name));
    const table = el('table');
    for (const [k, v] of shortcuts) {
      const tr = el('tr');
      const td = el('td');
      k.split(', ').forEach((part, i) => {
        if (i) td.append(', ');
        td.append(el('kbd', null, part));
      });
      tr.append(td, el('td', null, v));
      table.append(tr);
    }
    wrap.append(table);
  }
  api.version().then((v) => wrap.append(el('p', 'muted', `Leitor PDF ${v} · motor PDF.js ${pdfjsLib.version}`)));
  showModal('Atalhos de teclado', wrap, [{ label: 'Fechar', value: null, primary: true }]);
}

let toastTimer;
function toast(msg, ms = 2500) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

// ---------------------------------------------------------------- Formulários simples
function makeSelect(options, value) {
  const s = el('select', 'field');
  for (const [v, label] of options) {
    const o = el('option', null, label);
    o.value = v;
    s.append(o);
  }
  if (value != null) s.value = value;
  return s;
}

function makeCheck(label, checked) {
  const row = el('label', 'check-row');
  const input = el('input');
  input.type = 'checkbox';
  input.checked = !!checked;
  row.append(input, el('span', null, label));
  return { row, input };
}

function formRow(label, control) {
  const r = el('label', 'form-row');
  r.append(el('span', null, label), control);
  return r;
}

function progressModal(title, onCancel) {
  const body = el('div', 'progress-body');
  const label = el('p', null, 'Preparando…');
  const bar = el('div', 'pbar');
  const fill = el('div', 'pbar-fill');
  bar.append(fill);
  const sub = el('p', 'muted small', '');
  body.append(label, bar, sub);
  let closed = false;
  showModal(title, body, [{ label: 'Cancelar', value: 'cancel' }]).then((v) => {
    closed = true;
    if (v === 'cancel' || v === null) onCancel?.();
  });
  return {
    set(text, frac, subtext) {
      if (text != null) label.textContent = text;
      if (frac != null) fill.style.width = Math.round(clamp(frac, 0, 1) * 100) + '%';
      if (subtext != null) sub.textContent = subtext;
    },
    close() {
      if (closed) return;
      closed = true;
      $('#modal')._finish?.('done');
    },
  };
}

// ---------------------------------------------------------------- OCR de um PDF aberto
async function showOcrDialog(d) {
  if (!d?.pdf) return;
  const OCR = await import('./ocr.js');
  const body = el('div', 'form');
  body.append(el('p', null, 'O reconhecimento de texto (OCR) transforma páginas digitalizadas ou fotografadas em texto que pode ser selecionado, copiado e pesquisado. Tudo é processado no seu computador, sem internet.'));
  const langSel = makeSelect(OCR.LANGS, store.ocrLang || 'por+eng');
  const engine = await engineControl(OCR, langSel);
  body.append(formRow('Idioma do texto', langSel), engine.row, engine.note);
  body.append(el('div', 'form-label', 'Páginas'));
  const radio = (value, label, checked) => {
    const r = el('label', 'check-row');
    const i = el('input');
    i.type = 'radio'; i.name = 'ocrPages'; i.value = value; i.checked = checked;
    r.append(i, el('span', null, label));
    return r;
  };
  body.append(
    radio('missing', 'Somente páginas sem texto (recomendado)', true),
    radio('all', 'Todas as páginas (refaz o OCR; o texto reconhecido antes é substituído)', false),
  );
  const v = await showModal('Reconhecer texto (OCR)', body, [
    { label: 'Cancelar', value: null },
    { label: 'Reconhecer', value: 'ok', primary: true },
  ]);
  if (v !== 'ok') return;
  store.ocrLang = langSel.value;
  engine.save();
  saveStore();
  await ocrDocument(d, { lang: langSel.value, mode: body.querySelector('input[name=ocrPages]:checked').value });
}

/**
 * Escolha do motor de OCR (OCR do Windows ou Tesseract), guardada em store.ocrEngine e usada também pelo
 * editor de matéria. Quando o Windows não tem OCR para o idioma escolhido, avisa que será usado o Tesseract.
 */
async function engineControl(OCR, langSel) {
  const info = await OCR.windowsOcr();
  const sel = makeSelect(OCR.ENGINES, store.ocrEngine || 'windows');
  const note = el('p', 'muted small');
  let chosen = sel.value;
  const sync = () => {
    const ok = !!OCR.windowsLang(info, langSel.value);
    sel.options[0].disabled = !ok;
    sel.value = ok ? chosen : 'tesseract';
    note.textContent = ok ? '' : info
      ? 'O Windows deste computador não tem o OCR deste idioma instalado; será usado o Tesseract.'
      : 'O OCR do Windows não está disponível neste computador; será usado o Tesseract.';
    note.hidden = ok;
  };
  sel.addEventListener('change', () => { if (!sel.options[0].disabled) chosen = sel.value; });
  langSel.addEventListener('change', sync);
  sync();
  const row = formRow('Motor do OCR', sel);
  return {
    row,
    note,
    set disabled(v) { sel.disabled = v; },
    save() { if (!sel.options[0].disabled) store.ocrEngine = sel.value; },
    get value() { return sel.value; },
  };
}

async function ocrDocument(d, { lang, mode }) {
  const [OCR, PB] = await Promise.all([import('./ocr.js'), import('./pdfbuild.js')]);

  // Preparação (antes da barra de progresso: um diálogo aberto por cima dela contaria como "Cancelar").
  // O PDF é alterado com o pdf-lib. Se ele não conseguir abrir o arquivo (protegido) ou se, ao refazer o
  // OCR, houver texto invisível de OUTRO programa (que não dá para remover com segurança), é criada uma
  // cópia nova a partir das imagens das páginas — o texto invisível antigo não entra na imagem.
  const original = d.bytes || (await api.readFile(d.path));
  let target = null;
  try { target = await PB.loadPdf(original); } catch { target = null; }
  let reason = target ? null : 'protegido';
  if (target && mode === 'all') {
    const foreign = d.pages.filter((p) => {
      try { return PB.hasForeignInvisibleText(target, target.getPage(p.num - 1)); } catch { return false; }
    }).length;
    if (foreign) {
      const v = await showModal('Texto reconhecido por outro programa', el('p', null,
        `${foreign === 1 ? 'Uma página já tem' : `${foreign} páginas já têm`} texto invisível gravado por outro programa ` +
        '(scanner, Adobe…). Para substituí-lo sem duplicar o texto, o Leitor PDF vai criar uma cópia nova do ' +
        'documento a partir das imagens das páginas, com o novo texto reconhecido. O arquivo original não é alterado.'), [
        { label: 'Cancelar', value: null },
        { label: 'Criar cópia com novo OCR', value: 'ok', primary: true },
      ]);
      if (v !== 'ok') return;
      reason = 'outro-ocr';
    }
  }
  const rasterize = !!reason;

  const signal = { cancelled: false };
  const prog = progressModal('Reconhecendo texto', () => { signal.cancelled = true; signal.terminate?.(); });
  try {
    prog.set('Verificando as páginas…', 0);
    const all = d.pages.map((p) => p.num);
    const need = [];
    for (const n of all) {
      if (signal.cancelled) throw new OCR.OcrCancelled();
      if (mode === 'all' || rasterize) { need.push(n); continue; }
      const tc = await d.getText(n).catch(() => null);
      if (!tc || tc.text.replace(/\s+/g, '').length < 3) need.push(n);
    }
    if (!need.length) {
      prog.close();
      toast('Todas as páginas já têm texto selecionável. Para refazer o OCR, escolha “Todas as páginas”.', 6000);
      return;
    }
    const pages = rasterize ? all : need;

    const views = new Map();
    const images = new Map();
    const jobs = pages.map((n) => async () => {
      const page = await d.pdf.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const s = clamp(3800 / Math.max(base.width, base.height), 2, 300 / 72); // até ~300 DPI
      const vp = page.getViewport({ scale: s });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      // canvas na CPU (willReadFrequently): os pixels serão lidos pelo OCR; evita a leitura pela GPU,
      // que pode travar o processo da GPU com imagens grandes enquanto a tela é desenhada
      const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      views.set(n, vp);
      if (rasterize) {
        const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
        images.set(n, new Uint8Array(await blob.arrayBuffer()));
      }
      return canvas;
    });
    const results = await OCR.recognizeAll(jobs, {
      engine: store.ocrEngine,
      lang,
      signal,
      onProgress: (done, total, frac) => prog.set(
        `Reconhecendo texto… página ${Math.min(done + 1, total)} de ${total}`, 0.02 + frac * 0.93, `${Math.round(frac * 100)}%`),
    });

    prog.set('Montando o PDF pesquisável…', 0.96, '');
    let words = 0;
    if (!rasterize) {
      const fi = await PB.ocrFont(target);
      pages.forEach((n, i) => {
        const vp = views.get(n);
        // pixels por unidade do PDF, incluindo /UserUnit (vp.scale não o inclui; a transformação sim)
        const pxPerUnit = Math.hypot(vp.transform[0], vp.transform[1]);
        const w = PB.wordsToPdf(results[i], (x, y) => vp.convertToPdfPoint(x, y), pxPerUnit);
        words += w.length;
        const page = target.getPage(n - 1);
        PB.removeOcrLayer(target, page); // se o Leitor PDF já fez OCR nesta página, substitui em vez de duplicar
        PB.addInvisibleText(target, page, fi, w);
      });
      const bytes = await PB.savePdf(target);
      prog.close();
      await d.reloadFromBytes(bytes);
      toast(`Texto reconhecido em ${pages.length} ${pages.length === 1 ? 'página' : 'páginas'} (${words} palavras). Salve com Ctrl+S para manter.`, 6000);
    } else {
      const out = await PB.PDFDocument.create();
      out.setProducer('Leitor PDF');
      const fi = await PB.ocrFont(out);
      for (const [i, n] of pages.entries()) {
        const vp = views.get(n);
        const pw = vp.width / vp.scale, ph = vp.height / vp.scale;
        const page = out.addPage([pw, ph]);
        page.drawImage(await out.embedJpg(images.get(n)), { x: 0, y: 0, width: pw, height: ph });
        const w = PB.wordsToPdf(results[i], (x, y) => [x / vp.scale, ph - y / vp.scale], vp.scale);
        words += w.length;
        PB.addInvisibleText(out, page, fi, w);
      }
      const bytes = await PB.savePdf(out);
      prog.close();
      await openBytes(bytes, d.name.replace(/\.pdf$/i, '') + ' (OCR).pdf', d.dir);
      toast(reason === 'protegido'
        ? 'Este PDF é protegido contra alterações, então foi criada uma cópia com o texto reconhecido. Salve-a com Ctrl+S.'
        : 'Foi criada uma cópia com o novo texto reconhecido (sem o texto antigo). Salve-a com Ctrl+S.', 8000);
    }
  } catch (err) {
    prog.close();
    if (err?.name === 'OcrCancelled' || signal.cancelled) { toast('OCR cancelado.'); return; }
    console.error(err);
    toast('Falha no OCR: ' + (err?.message || err), 8000);
  }
}

// ---------------------------------------------------------------- Imagens → PDF
let imgDlg = null;

/**
 * Desenha a imagem já na orientação correta (EXIF + giro escolhido).
 * @param size número = lado maior máximo (só reduz); função = lado maior desejado (pode ampliar, para o OCR)
 */
async function loadItemCanvas(it, size) {
  const bmp = await createImageBitmap(new Blob([it.bytes]), { imageOrientation: 'from-image' });
  const rot = it.rotation;
  const w = rot % 180 ? bmp.height : bmp.width;
  const h = rot % 180 ? bmp.width : bmp.height;
  const long = Math.max(w, h);
  const k = typeof size === 'function' ? size(long) / long : Math.min(1, size / long);
  const cw = Math.max(1, Math.round(w * k)), ch = Math.max(1, Math.round(h * k));
  const c = document.createElement('canvas');
  c.width = cw;
  c.height = ch;
  const ctx = c.getContext('2d', { alpha: false, willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, cw, ch);
  ctx.imageSmoothingQuality = 'high';
  ctx.translate(cw / 2, ch / 2);
  ctx.rotate((rot * Math.PI) / 180);
  const dw = rot % 180 ? ch : cw, dh = rot % 180 ? cw : ch;
  ctx.drawImage(bmp, -dw / 2, -dh / 2, dw, dh);
  bmp.close();
  return { canvas: c, w, h };
}

async function showImagesDialog(paths) {
  if (imgDlg) { imgDlg.add(paths); return; }
  const OCR = await import('./ocr.js');
  const items = [];
  const wrap = el('div', 'img-dlg');

  const head = el('div', 'img-head');
  const count = el('span', 'muted');
  const sortBtn = el('button', 'secondary small', 'Ordenar por nome');
  const addBtn = el('button', 'secondary small');
  addBtn.append(icon('plus'), el('span', null, 'Adicionar imagens'));
  head.append(count, el('span', 'grow'), sortBtn, addBtn);

  const grid = el('div', 'img-grid');
  const opts = el('div', 'img-opts');
  const sizeSel = makeSelect([['fit', 'Formato da imagem'], ['a4', 'A4'], ['letter', 'Carta']], store.imgSize || 'fit');
  const optimize = makeCheck('Reduzir o tamanho do arquivo', store.imgOptimize ?? true);
  const ocr = makeCheck('Reconhecer texto (OCR): permite selecionar, copiar e pesquisar o texto', store.imgOcr ?? true);
  const langSel = makeSelect(OCR.LANGS, store.ocrLang || 'por+eng');
  const engine = await engineControl(OCR, langSel);
  langSel.disabled = engine.disabled = !ocr.input.checked;
  ocr.input.addEventListener('change', () => { langSel.disabled = engine.disabled = !ocr.input.checked; });
  ocr.row.classList.add('wide');
  engine.note.classList.add('wide');
  opts.append(formRow('Tamanho da página', sizeSel), optimize.row, ocr.row, formRow('Idioma do texto', langSel), engine.row, engine.note);
  wrap.append(head, grid, el('p', 'muted small', 'Arraste as miniaturas para mudar a ordem das páginas.'), opts);

  const byName = (a, b) => a.name.localeCompare(b.name, 'pt-BR', { numeric: true });
  let dragFrom = -1;
  const render = () => {
    grid.textContent = '';
    count.textContent = items.length === 1 ? '1 imagem' : `${items.length} imagens`;
    items.forEach((it, i) => {
      const card = el('div', 'img-card');
      card.draggable = true;
      const box = el('div', 'img-box');
      const img = el('img');
      img.src = it.url;
      img.draggable = false;
      img.style.transform = `rotate(${it.rotation}deg)`;
      box.append(img);
      const name = el('div', 'img-name', it.name);
      name.title = it.path;
      const acts = el('div', 'img-acts');
      const btn = (ic, title, fn) => {
        const x = el('button', 'icon-btn small');
        x.title = title;
        x.append(icon(ic));
        x.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
        return x;
      };
      acts.append(
        btn('rot-left', 'Girar para a esquerda', () => { it.rotation = (it.rotation + 270) % 360; render(); }),
        btn('rotate', 'Girar para a direita', () => { it.rotation = (it.rotation + 90) % 360; render(); }),
        btn('trash', 'Remover', () => { URL.revokeObjectURL(it.url); items.splice(items.indexOf(it), 1); render(); }),
      );
      card.append(box, el('span', 'img-num', String(i + 1)), name, acts);
      card.addEventListener('dragstart', (e) => { dragFrom = i; card.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
      card.addEventListener('dragend', () => { dragFrom = -1; card.classList.remove('dragging'); });
      card.addEventListener('dragover', (e) => { if (dragFrom < 0) return; e.preventDefault(); card.classList.add('drop-target'); });
      card.addEventListener('dragleave', () => card.classList.remove('drop-target'));
      card.addEventListener('drop', (e) => {
        if (dragFrom < 0) return;
        e.preventDefault();
        e.stopPropagation();
        const [moved] = items.splice(dragFrom, 1);
        items.splice(i, 0, moved);
        dragFrom = -1;
        render();
      });
      grid.append(card);
    });
    if (!items.length) grid.append(el('p', 'empty', 'Nenhuma imagem. Use “Adicionar imagens” ou arraste arquivos para cá.'));
    const create = $('#modal .actions .primary');
    if (create) create.disabled = !items.length;
  };
  const add = async (ps) => {
    const batch = [];
    for (const p of ps) {
      try {
        const bytes = await api.readFile(p);
        batch.push({ path: p, name: basename(p), bytes, url: URL.createObjectURL(new Blob([bytes])), rotation: 0 });
      } catch {
        toast(`Não foi possível ler “${basename(p)}”.`, 4000);
      }
    }
    items.push(...batch.sort(byName)); // a ordem de arrastar/soltar é imprevisível: usa a ordem dos nomes
    render();
  };
  addBtn.addEventListener('click', async () => {
    const files = await api.openDialog('images');
    if (files.length) add(files);
  });
  sortBtn.addEventListener('click', () => { items.sort(byName); render(); });

  imgDlg = { add };
  const loading = add(paths);
  const v = await showModal('Criar PDF a partir de imagens', wrap, [
    { label: 'Cancelar', value: null },
    { label: 'Criar PDF', value: 'ok', primary: true },
  ], { wide: true });
  imgDlg = null;
  await loading;
  try {
    if (v === 'ok' && items.length) {
      Object.assign(store, { imgSize: sizeSel.value, imgOptimize: optimize.input.checked, imgOcr: ocr.input.checked, ocrLang: langSel.value });
      if (ocr.input.checked) engine.save();
      saveStore();
      await createPdfFromImages(items, { size: sizeSel.value, optimize: optimize.input.checked, ocr: ocr.input.checked, lang: langSel.value });
    }
  } finally {
    items.forEach((it) => URL.revokeObjectURL(it.url));
  }
}

async function createPdfFromImages(items, opts) {
  const [OCR, PB] = await Promise.all([import('./ocr.js'), import('./pdfbuild.js')]);
  const signal = { cancelled: false };
  const prog = progressModal('Criando PDF', () => { signal.cancelled = true; signal.terminate?.(); });
  try {
    const doc = await PB.PDFDocument.create();
    doc.setProducer('Leitor PDF');
    doc.setCreator('Leitor PDF');
    const layouts = [];
    const share = opts.ocr ? 0.25 : 0.95;
    for (const [i, it] of items.entries()) {
      if (signal.cancelled) throw new OCR.OcrCancelled();
      prog.set(`Preparando imagem ${i + 1} de ${items.length}…`, (i / items.length) * share, it.name);
      const jpg = PB.isJpeg(it.bytes), png = PB.isPng(it.bytes);
      const exif = jpg ? PB.jpegOrientation(it.bytes) : 1;
      const probe = await createImageBitmap(new Blob([it.bytes]), { imageOrientation: 'from-image' });
      const w = it.rotation % 180 ? probe.height : probe.width;
      const h = it.rotation % 180 ? probe.width : probe.height;
      probe.close();
      const tooBig = opts.optimize && Math.max(w, h) > 2480;
      const bigPng = opts.optimize && png && it.bytes.length > 3e6;
      let image;
      if ((jpg || png) && !it.rotation && exif === 1 && !tooBig && !bigPng) {
        image = jpg ? await doc.embedJpg(it.bytes) : await doc.embedPng(it.bytes); // sem perda: usa o arquivo original
      } else {
        const { canvas } = await loadItemCanvas(it, opts.optimize ? 2480 : 10000);
        const asPng = (png && !bigPng) || (!jpg && !png && !opts.optimize);
        const blob = await new Promise((r) => canvas.toBlob(r, asPng ? 'image/png' : 'image/jpeg', 0.85));
        canvas.width = canvas.height = 0;
        const out = new Uint8Array(await blob.arrayBuffer());
        image = asPng ? await doc.embedPng(out) : await doc.embedJpg(out);
      }
      const L = PB.layoutImage(w, h, opts.size);
      const page = doc.addPage([L.pw, L.ph]);
      page.drawImage(image, { x: L.x, y: L.y, width: L.w, height: L.h });
      layouts.push({ page, L });
    }

    let words = 0;
    if (opts.ocr) {
      const fi = await PB.ocrFont(doc);
      const sizes = [];
      const jobs = items.map((it, i) => async () => {
        const { canvas } = await loadItemCanvas(it, PB.ocrLongSide);
        sizes[i] = [canvas.width, canvas.height];
        return canvas;
      });
      const results = await OCR.recognizeAll(jobs, {
        engine: store.ocrEngine,
        lang: opts.lang,
        signal,
        onProgress: (done, total, frac) => prog.set(
          `Reconhecendo texto… imagem ${Math.min(done + 1, total)} de ${total}`, share + frac * (0.95 - share), `${Math.round(frac * 100)}%`),
      });
      results.forEach((ws, i) => {
        const { page, L } = layouts[i];
        const [ow, oh] = sizes[i];
        const pdfWords = PB.wordsToPdf(ws, (x, y) => [L.x + (x / ow) * L.w, L.y + L.h - (y / oh) * L.h], ow / L.w);
        words += pdfWords.length;
        PB.addInvisibleText(doc, page, fi, pdfWords);
      });
    }

    prog.set('Gerando o arquivo…', 0.97, '');
    const bytes = await PB.savePdf(doc);
    prog.close();
    const name = items.length === 1
      ? items[0].name.replace(/\.[^.]+$/, '') + '.pdf'
      : `Digitalização ${new Date().toLocaleDateString('pt-BR').replaceAll('/', '-')}.pdf`;
    await openBytes(bytes, name, dirname(items[0].path));
    const pages = items.length === 1 ? '1 página' : `${items.length} páginas`;
    toast(opts.ocr
      ? `PDF criado com ${pages} e ${words} palavras reconhecidas. Salve com Ctrl+S.`
      : `PDF criado com ${pages}. Salve com Ctrl+S.`, 7000);
  } catch (err) {
    prog.close();
    if (err?.name === 'OcrCancelled' || signal.cancelled) { toast('Criação do PDF cancelada.'); return; }
    console.error(err);
    toast('Não foi possível criar o PDF: ' + (err?.message || err), 8000);
  }
}

// ---------------------------------------------------------------- Impressão
async function printDoc() {
  const d = state.active;
  if (!d?.pdf || d.printing) return;
  d.printing = true;
  let cancelled = false;
  const status = el('p', null, 'Preparando páginas…');
  showModal('Imprimir', status, [{ label: 'Cancelar', value: 'cancel' }]).then((v) => { if (v === 'cancel') cancelled = true; });
  const area = $('#printArea');
  area.textContent = '';
  const urls = [];
  try {
    for (let n = 1; n <= d.pages.length; n++) {
      if (cancelled || d.closed) return;
      status.textContent = `Preparando página ${n} de ${d.pages.length}…`;
      const p = d.pages[n - 1];
      const page = p.page || (p.page = await d.pdf.getPage(n));
      await d.ensureAnnots(p);
      const vp = page.getViewport({ scale: 150 / 72, rotation: (page.rotate + d.rotation) % 360 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: vp, intent: 'print', annotationMode: WITH_STORAGE }).promise;
      A.drawOnCanvas(ctx, vp, d.pageAnnots(n));
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.92));
      canvas.width = 0;
      const url = URL.createObjectURL(blob);
      urls.push(url);
      const wrap = el('div', 'print-page');
      const img = el('img');
      img.src = url;
      wrap.append(img);
      area.append(wrap);
    }
    await Promise.all([...area.querySelectorAll('img')].map((i) => i.decode().catch(() => {})));
    if (cancelled) return;
    $('#modal')._cancel?.();
    await new Promise((r) => setTimeout(r, 50));
    window.print();
  } catch (err) {
    console.error(err);
    toast('Falha ao preparar a impressão: ' + (err?.message || err), 5000);
  } finally {
    if (!cancelled) $('#modal')._cancel?.();
    area.textContent = '';
    urls.forEach((u) => URL.revokeObjectURL(u));
    d.printing = false;
  }
}

// ---------------------------------------------------------------- Apresentação
let cursorTimer;
async function setPresentation(on) {
  const d = state.active;
  if (on && !d?.pdf) return;
  if (on === state.presentation) return;
  state.presentation = on;
  document.body.classList.toggle('presentation', on);
  closePopover();
  hideSelBar();
  if (on) {
    d.prevZoom = d.zoomMode;
    const page = d.currentPage;
    if (!state.fullscreen) await api.fullscreen(true);
    await new Promise((r) => setTimeout(r, 250));
    d.setZoom('page-fit');
    d.layout();
    d.goToPage(page);
    d.viewer.focus();
  } else {
    if (state.fullscreen) await api.fullscreen(false);
    if (d) {
      const page = d.currentPage;
      await new Promise((r) => setTimeout(r, 200));
      d.setZoom(d.prevZoom ?? 'auto');
      d.goToPage(page);
    }
    document.body.classList.remove('hide-cursor');
  }
}

document.addEventListener('mousemove', () => {
  if (!state.presentation) return;
  document.body.classList.remove('hide-cursor');
  clearTimeout(cursorTimer);
  cursorTimer = setTimeout(() => document.body.classList.add('hide-cursor'), 2000);
});

api.onFullscreen((on) => {
  state.fullscreen = on;
  $('#btnFullscreen').classList.toggle('on', on);
  if (!on && state.presentation) setPresentation(false);
});

// ================================================================= Eventos
$('#btnOpen').addEventListener('click', openDialog);
$('#btnNewTab').addEventListener('click', openDialog);
$('#homeOpen').addEventListener('click', openDialog);
$('#homeImages').addEventListener('click', async () => {
  const files = await api.openDialog('images');
  if (files.length) showImagesDialog(files);
});
$('#btnOcr').addEventListener('click', () => state.active && showOcrDialog(state.active));
$('#btnSave').addEventListener('click', () => state.active?.save());
$('#btnSidebar').addEventListener('click', () => setSidebar(!store.sidebar));
$('#btnPrev').addEventListener('click', () => state.active?.goToPage(state.active.currentPage - 1));
$('#btnNext').addEventListener('click', () => state.active?.goToPage(state.active.currentPage + 1));
$('#btnZoomIn').addEventListener('click', () => state.active?.zoomStep(1));
$('#btnZoomOut').addEventListener('click', () => state.active?.zoomStep(-1));
$('#btnRotate').addEventListener('click', () => state.active?.rotate(90));
$('#btnToolSelect').addEventListener('click', () => setTool('select'));
$('#btnToolHand').addEventListener('click', () => setTool('hand'));
$('#btnToolHighlight').addEventListener('click', () => {
  if (state.tool !== 'highlight' && selectionInTextLayer()) { state.active?.addMarkup('highlight', store.hlColor); return; }
  setTool('highlight');
});
$('#btnToolNote').addEventListener('click', () => setTool('note'));
$('#btnSearch').addEventListener('click', () => ($('#searchbar').hidden ? openSearchBar() : closeSearchBar()));
$('#btnNight').addEventListener('click', () => setNight(!store.night));
$('#btnTheme').addEventListener('click', () => {
  const order = ['system', 'light', 'dark'];
  store.theme = order[(order.indexOf(store.theme) + 1) % 3];
  saveStore();
  applyTheme();
  toast(`Tema ${{ system: 'do sistema', light: 'claro', dark: 'escuro' }[store.theme]}`, 1200);
});
$('#btnPresent').addEventListener('click', () => setPresentation(true));
$('#btnFullscreen').addEventListener('click', () => api.fullscreen());
$('#btnPrint').addEventListener('click', printDoc);
$('#btnInfo').addEventListener('click', showProperties);
$('#btnHelp').addEventListener('click', showHelp);

$('#zoomSelect').addEventListener('change', (e) => {
  const v = e.target.value;
  if (v === 'custom') return;
  state.active?.setZoom(isNaN(Number(v)) ? v : Number(v));
  state.active?.viewer.focus({ preventScroll: true });
});

const pageInput = $('#pageInput');
pageInput.addEventListener('focus', () => pageInput.select());
pageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    state.active?.goToPage(parseInt(pageInput.value, 10));
    state.active?.viewer.focus({ preventScroll: true });
  } else if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    updatePageUI();
    state.active?.viewer.focus({ preventScroll: true });
  }
});
pageInput.addEventListener('blur', updatePageUI);

for (const b of document.querySelectorAll('#sideTabs button')) {
  b.addEventListener('click', () => showSideTab(b.dataset.side));
}

const searchInput = $('#searchInput');
searchInput.addEventListener('input', triggerSearchDebounced);
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); searchStep(e.shiftKey ? -1 : 1); }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSearchBar(); }
});
$('#searchCase').addEventListener('change', triggerSearch);
$('#searchNext').addEventListener('click', () => searchStep(1));
$('#searchPrev').addEventListener('click', () => searchStep(-1));
$('#searchClose').addEventListener('click', closeSearchBar);

$('#modalBack').addEventListener('mousedown', (e) => { if (e.target.id === 'modalBack') $('#modal')._cancel?.(); });

// Arrastar e soltar
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
document.addEventListener('dragenter', (e) => { if (hasFiles(e)) { dragDepth++; $('#dropOverlay').hidden = false; } });
document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#dropOverlay').hidden = true; } });
document.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
document.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('#dropOverlay').hidden = true;
  const paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter((p) => p && (/\.pdf$/i.test(p) || IMG_RE.test(p)));
  if (paths.length) openPaths(paths);
  else if (e.dataTransfer.files.length) toast('Apenas PDFs e imagens (JPG, PNG, WebP, BMP, GIF) podem ser abertos.');
});

// Teclado
document.addEventListener('keydown', (e) => {
  const d = state.active;
  const ctrl = e.ctrlKey || e.metaKey;
  const k = e.key;
  const inField = e.target.matches?.('input, select, textarea');

  if (!$('#modalBack').hidden) {
    if (k === 'Escape') $('#modal')._cancel?.();
    return;
  }
  if (!ctxMenu.hidden && k === 'Escape') { hideContextMenu(); return; }
  if (pop.doc && !inField) {
    if (k === 'Escape') { e.preventDefault(); closePopover(); return; }
    if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); pop.doc.deleteAnnot(pop.id); return; }
  }

  if (state.presentation) {
    const next = ['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter', 'n'];
    const prev = ['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace', 'p'];
    if (next.includes(k)) { e.preventDefault(); d.goToPage(d.currentPage + 1); return; }
    if (prev.includes(k)) { e.preventDefault(); d.goToPage(d.currentPage - 1); return; }
    if (k === 'Home') { e.preventDefault(); d.goToPage(1); return; }
    if (k === 'End') { e.preventDefault(); d.goToPage(d.pages.length); return; }
    if (k === 'Escape' || k === 'F5') { e.preventDefault(); setPresentation(false); return; }
  }

  if (ctrl) {
    const key = k.toLowerCase();
    // nos campos de texto, deixa os atalhos de edição nativos funcionarem
    if (inField && ['a', 'c', 'x', 'v', 'z', 'y'].includes(key)) return;
    let handled = true;
    if (key === 'o' && e.shiftKey) { if (d) showOcrDialog(d); }
    else if (key === 'o') openDialog();
    else if (key === 's' && d) d.save(e.shiftKey);
    else if (key === 'w') requestCloseDoc(d);
    else if (key === 'tab') cycleTab(e.shiftKey ? -1 : 1);
    else if (key === 'f') openSearchBar();
    else if (key === 'g' && d) { pageInput.focus(); }
    else if ((key === '=' || key === '+') && d) d.zoomStep(1);
    else if (key === '-' && d) d.zoomStep(-1);
    else if (key === '0' && d) d.setZoom('page-fit');
    else if (key === '1' && d) d.setZoom(1);
    else if (key === '2' && d) d.setZoom('page-width');
    else if (key === 'r' && d) d.rotate(e.shiftKey ? -90 : 90);
    else if (key === 'b') setSidebar(!store.sidebar);
    else if (key === 'n' && e.shiftKey) setNight(!store.night);
    else if (key === 'p' && d) printDoc();
    else if (key === 'd' && d) showProperties();
    else if (key === 'z' && d) (e.shiftKey ? d.redo() : d.undo());
    else if (key === 'y' && d) d.redo();
    else if (key === 'a' && d) selectPageText(d, d.pages[d.currentPage - 1]);
    else if (key === 'pagedown') cycleTab(1);
    else if (key === 'pageup') cycleTab(-1);
    else if (key === 'c') handled = false; // cópia nativa (limpa pelo evento "copy")
    else handled = false;
    if (handled) e.preventDefault();
    return;
  }

  if (k === 'F1') { e.preventDefault(); showHelp(); return; }
  if (k === 'F11') { e.preventDefault(); api.fullscreen(); return; }
  if (k === 'F5' && d) { e.preventDefault(); setPresentation(true); return; }
  if (k === 'F3' && d) { e.preventDefault(); if ($('#searchbar').hidden) openSearchBar(); else searchStep(e.shiftKey ? -1 : 1); return; }
  if (k === 'Escape') {
    if (!selBar.hidden) { document.getSelection().removeAllRanges(); hideSelBar(); }
    else if (state.tool !== 'select') setTool('select');
    else if (!$('#searchbar').hidden) closeSearchBar();
    else if (editor.active && d && !inField && !e.defaultPrevented) editor.clear(true);
    else if (state.fullscreen) api.fullscreen(false);
    return;
  }
  if (inField || !d?.pdf) return;
  if (!e.altKey && k.toLowerCase() === 'e' && !state.presentation) { e.preventDefault(); editor.toggle(); return; }
  const tools = { v: 'select', h: 'hand', m: 'highlight', n: 'note' };
  if (!e.altKey && tools[k.toLowerCase()]) { e.preventDefault(); setTool(tools[k.toLowerCase()]); return; }
  if (k === 'Home') { e.preventDefault(); d.goToPage(1); }
  else if (k === 'End') { e.preventDefault(); d.goToPage(d.pages.length); }
  else if (k === 'ArrowLeft' && d.viewer.scrollWidth <= d.viewer.clientWidth) { e.preventDefault(); d.goToPage(d.currentPage - 1); }
  else if (k === 'ArrowRight' && d.viewer.scrollWidth <= d.viewer.clientWidth) { e.preventDefault(); d.goToPage(d.currentPage + 1); }
  else if (document.activeElement !== d.viewer && ['PageDown', 'PageUp', 'ArrowDown', 'ArrowUp', ' '].includes(k)) {
    d.viewer.focus({ preventScroll: true });
  }
});

// Reajusta zoom automático quando a área de visualização muda de tamanho
new ResizeObserver(debounce(() => {
  const d = state.active;
  if (d?.pdf && typeof d.zoomMode === 'string') d.setZoom(d.zoomMode);
  positionPopover();
}, 80)).observe($('#viewerHost'));

// Fechar a janela com anotações não salvas
let allowClose = false;
let confirmingQuit = false;
window.addEventListener('beforeunload', (e) => {
  for (const d of state.docs) savePosition(d);
  saveStoreNow();
  if (allowClose || !state.docs.some((d) => d.dirty)) return;
  e.preventDefault();
  e.returnValue = false;
  setTimeout(confirmQuit, 0);
});

async function confirmQuit() {
  if (confirmingQuit) return;
  confirmingQuit = true;
  try {
    const dirty = state.docs.filter((d) => d.dirty);
    const body = el('div');
    body.append(el('p', null, dirty.length === 1
      ? `Há anotações não salvas em “${dirty[0].name}”.`
      : `Há anotações não salvas em ${dirty.length} documentos:`));
    if (dirty.length > 1) {
      const ul = el('ul');
      for (const d of dirty) ul.append(el('li', null, d.name));
      body.append(ul);
    }
    const v = await showModal('Salvar antes de sair?', body, [
      { label: 'Cancelar', value: null },
      { label: 'Sair sem salvar', value: 'discard' },
      { label: dirty.length > 1 ? 'Salvar tudo' : 'Salvar', value: 'save', primary: true },
    ]);
    if (!v) return;
    if (v === 'save') {
      for (const d of dirty) {
        activate(d);
        if (!(await d.save())) return;
      }
    }
    allowClose = true;
    api.closeWindow();
  } finally {
    confirmingQuit = false;
  }
}

// ================================================================= Editor de matérias
const editor = new NewsEditor({
  $, el, icon, api, toast, pdfjsLib, store, saveStore,
  withStorage: WITH_STORAGE,
  getActive: () => state.active,
  docs: () => state.docs,
  relayout: () => positionPopover(),
});
$('#btnEditor').addEventListener('click', () => editor.toggle());

// ================================================================= Inicialização
applyTheme();
setSidebar(store.sidebar);
setNight(store.night);
setTool('select');
updateMarkerColor();
renderRecent();
api.onOpenFiles((files) => openPaths(files));
const [author, initial] = await Promise.all([api.userName().catch(() => ''), api.initialFiles()]);
state.author = author;
if (initial.length) openPaths(initial);
