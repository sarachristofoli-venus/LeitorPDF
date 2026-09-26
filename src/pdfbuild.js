// Montagem de PDFs: camada de texto invisível (OCR) e conversão de imagens em páginas.
import { PDFDocument, PDFName, StandardFonts } from '../node_modules/pdf-lib/dist/pdf-lib.esm.min.js';

export { PDFDocument };

const f = (n) => (Math.round(n * 1000) / 1000).toString();

export const PAGE_SIZES = {
  fit: null, // página no formato da imagem (lado maior = altura do A4)
  a4: [595.28, 841.89],
  letter: [612, 792],
};

// ------------------------------------------------------------------ Texto invisível

/** Prepara uma fonte padrão (Helvetica) e o filtro de caracteres que ela consegue codificar. */
export async function ocrFont(doc) {
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const charset = new Set(font.getCharacterSet());
  const clean = (s) => {
    let out = '';
    for (const ch of s.normalize('NFKC')) {
      const cp = ch.codePointAt(0);
      if (charset.has(cp)) { out += ch; continue; }
      const base = ch.normalize('NFD').charAt(0);
      if (charset.has(base.codePointAt(0))) out += base;
    }
    return out;
  };
  return { font, clean };
}

/**
 * Acrescenta a uma página uma camada de texto invisível (modo de renderização 3), como fazem
 * o Adobe e o OCRmyPDF: o texto não aparece, mas pode ser selecionado, copiado e pesquisado.
 * @param words  [{text, x, y, ux, uy, width, size}] em coordenadas do PDF (x,y = início da linha de base;
 *               ux,uy = direção do texto; width = largura ao longo da linha de base; size = altura da letra)
 */
export function addInvisibleText(doc, page, { font, clean }, words) {
  if (!words.length) return;
  const key = page.node.newFontDictionary('LpOcr', font.ref).toString();
  const space = font.encodeText(' ').toString();
  const spaceW = font.widthOfTextAtSize(' ', 1);
  const tm = (w) => `${f(w.ux)} ${f(w.uy)} ${f(-w.uy)} ${f(w.ux)} ${f(w.x)} ${f(w.y)} Tm`;
  const fit = (width, natural) => Math.min(1000, Math.max(5, (100 * width) / natural));
  let ops = 'BT\n3 Tr\n';
  for (let i = 0; i < words.length;) {
    const w = words[i];
    if (w.tilted) {
      // Linha inclinada: um único trecho "palavra palavra palavra" ajustado à largura da linha.
      // (Em texto girado o PDF.js só junta pedaços com a mesma escala; um trecho só evita o problema.)
      const group = [];
      while (i < words.length && words[i].line === w.line && words[i].tilted) group.push(words[i++]);
      const text = group.map((g) => clean(g.text)).filter(Boolean).join(' ');
      const last = group[group.length - 1];
      const ex = last.x + last.ux * last.width, ey = last.y + last.uy * last.width;
      const lineW = (ex - w.x) * w.ux + (ey - w.y) * w.uy;
      const size = group.reduce((a, g) => a + g.size, 0) / group.length;
      const natural = font.widthOfTextAtSize(text, size);
      if (text && natural > 0 && lineW > 0.5 && size > 0.5) {
        ops += `${key} ${f(size)} Tf ${f(fit(lineW, natural))} Tz ${tm(w)} ${font.encodeText(text).toString()} Tj\n`;
      }
      continue;
    }
    // Linha reta: cada palavra na posição exata, com a largura ajustada por escala horizontal (Tz)
    i++;
    const text = clean(w.text);
    if (!text || !(w.size > 0.5) || !(w.width > 0.5)) continue;
    const natural = font.widthOfTextAtSize(text, w.size);
    if (!(natural > 0)) continue;
    ops += `${key} ${f(w.size)} Tf ${f(fit(w.width, natural))} Tz ${tm(w)} ${font.encodeText(text).toString()} Tj`;
    // espaço explícito até a próxima palavra da linha, esticado para preencher exatamente o vão
    const n = words[i];
    if (n && n.line === w.line && !n.tilted) {
      const ex = w.x + w.ux * w.width, ey = w.y + w.uy * w.width;
      const gap = (n.x - ex) * w.ux + (n.y - ey) * w.uy;
      if (gap > 0.2) ops += ` ${f(Math.min(2000, (100 * gap) / (spaceW * w.size)))} Tz ${space} Tj`;
    }
    ops += '\n';
  }
  ops += 'ET\n';
  // isola o conteúdo original entre q/Q para que o estado gráfico dele não afete o texto novo
  const start = doc.context.register(doc.context.flateStream('q\n'));
  const end = doc.context.register(doc.context.flateStream('Q\n' + ops));
  if (!page.node.wrapContentStreams(start, end)) page.node.set(PDFName.of('Contents'), doc.context.obj([start, end]));
}

/**
 * Converte palavras do OCR (pixels de uma imagem) para coordenadas do PDF.
 * @param toPdf (px, py) → [x, y] no espaço do PDF
 * @param scale pixels por unidade do PDF
 */
export function wordsToPdf(words, toPdf, scale) {
  const out = [];
  for (const w of words) {
    const [x0, y0] = toPdf(w.x0, w.by0);
    const [x1, y1] = toPdf(w.x1, w.by1);
    const dx = x1 - x0, dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    if (len < 0.5) continue;
    // Linhas quase retas (até ~3°) são alinhadas ao eixo: o PDF.js só junta corretamente as palavras
    // de uma linha quando o texto não está inclinado (com inclinação ele confunde escala com mudança de linha).
    let ux = dx / len, uy = dy / len;
    const ang = Math.atan2(uy, ux);
    const q = Math.round(ang / (Math.PI / 2)) * (Math.PI / 2);
    const tilted = Math.abs(ang - q) > 0.052;
    if (!tilted) { ux = Math.round(Math.cos(q)) + 0; uy = Math.round(Math.sin(q)) + 0; }
    const width = dx * ux + dy * uy;
    if (width < 0.5) continue;
    out.push({ text: w.text, line: w.line, x: x0, y: y0, ux, uy, width, tilted, size: (w.size / scale) * 0.92 });
  }
  return out;
}

// ------------------------------------------------------------------ Imagens

/** Lê a orientação EXIF de um JPEG (1 = normal). */
export function jpegOrientation(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return 1;
  let off = 2;
  while (off + 4 < v.byteLength) {
    const marker = v.getUint16(off);
    const len = v.getUint16(off + 2);
    if (marker === 0xffe1 && v.getUint32(off + 4) === 0x45786966) { // "Exif"
      const tiff = off + 10;
      const le = v.getUint16(tiff) === 0x4949;
      const u16 = (o) => v.getUint16(o, le), u32 = (o) => v.getUint32(o, le);
      const ifd = tiff + u32(tiff + 4);
      const n = u16(ifd);
      for (let i = 0; i < n; i++) {
        const e = ifd + 2 + i * 12;
        if (e + 10 > v.byteLength) break;
        if (u16(e) === 0x0112) return u16(e + 8) || 1;
      }
      return 1;
    }
    if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) break;
    off += 2 + len;
  }
  return 1;
}

export const isJpeg = (b) => b[0] === 0xff && b[1] === 0xd8;
export const isPng = (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

/** Tamanho da página e retângulo da imagem para as opções escolhidas. */
export function layoutImage(imgW, imgH, size) {
  if (!PAGE_SIZES[size]) {
    const long = 841.89;
    const k = long / Math.max(imgW, imgH);
    const pw = imgW * k, ph = imgH * k;
    return { pw, ph, x: 0, y: 0, w: pw, h: ph };
  }
  let [pw, ph] = PAGE_SIZES[size];
  if (imgW > imgH) [pw, ph] = [ph, pw];
  const k = Math.min(pw / imgW, ph / imgH);
  const w = imgW * k, h = imgH * k;
  return { pw, ph, x: (pw - w) / 2, y: (ph - h) / 2, w, h };
}
