'use strict';
// Grava anotações (marca-texto, sublinhado, tachado e notas) dentro do PDF usando pdf-lib.
const fs = require('fs');
const {
  PDFDocument, PDFName, PDFString, PDFHexString, PDFArray, PDFDict, PDFRef, EncryptedPDFError,
} = require('pdf-lib');

const SUBTYPE = { highlight: 'Highlight', underline: 'Underline', strikeout: 'StrikeOut', note: 'Text' };

const hexToRgb = (hex) => {
  const n = parseInt(String(hex).replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};
const f = (n) => (Math.round(n * 1000) / 1000).toString();
const refId = (ref) => (ref.generationNumber ? `${ref.objectNumber}R${ref.generationNumber}` : `${ref.objectNumber}R`);

function bbox(quads, pad = 0) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const q of quads) {
    for (let i = 0; i < 8; i += 2) {
      x1 = Math.min(x1, q[i]); x2 = Math.max(x2, q[i]);
      y1 = Math.min(y1, q[i + 1]); y2 = Math.max(y2, q[i + 1]);
    }
  }
  return [x1 - pad, y1 - pad, x2 + pad, y2 + pad];
}

// Quad: [TLx, TLy, TRx, TRy, BLx, BLy, BRx, BRy] (ordem usada pelo Acrobat)
function lineFor(q, t) {
  const [tlx, tly, trx, try_, blx, bly, brx, bry] = q;
  return [blx + (tlx - blx) * t, bly + (tly - bly) * t, brx + (trx - brx) * t, bry + (try_ - bry) * t];
}

function appearance(doc, a, rect) {
  const [r, g, b] = hexToRgb(a.color);
  const ops = [];
  const resources = {};
  if (a.type === 'highlight') {
    resources.ExtGState = { GS0: { Type: 'ExtGState', BM: 'Multiply', ca: a.opacity ?? 1, CA: a.opacity ?? 1 } };
    ops.push('/GS0 gs', `${f(r)} ${f(g)} ${f(b)} rg`);
    for (const q of a.quads) {
      ops.push(`${f(q[0])} ${f(q[1])} m ${f(q[2])} ${f(q[3])} l ${f(q[6])} ${f(q[7])} l ${f(q[4])} ${f(q[5])} l h f`);
    }
  } else if (a.type === 'underline' || a.type === 'strikeout') {
    ops.push(`${f(r)} ${f(g)} ${f(b)} RG`, '0 J');
    for (const q of a.quads) {
      const h = Math.hypot(q[0] - q[4], q[1] - q[5]);
      const w = Math.max(0.6, h * 0.07);
      const [x1, y1, x2, y2] = lineFor(q, a.type === 'underline' ? 0.08 : 0.5);
      ops.push(`${f(w)} w ${f(x1)} ${f(y1)} m ${f(x2)} ${f(y2)} l S`);
    }
  } else if (a.type === 'note') {
    const [x1, y1, x2, y2] = rect;
    const w = x2 - x1, h = y2 - y1;
    ops.push(
      `${f(r)} ${f(g)} ${f(b)} rg 0.25 0.25 0.25 RG 0.8 w`,
      `${f(x1 + 0.5)} ${f(y1 + 0.5)} ${f(w - 1)} ${f(h - 1)} re B`,
      '0.25 0.25 0.25 RG 1.1 w',
      `${f(x1 + w * 0.2)} ${f(y1 + h * 0.7)} m ${f(x1 + w * 0.8)} ${f(y1 + h * 0.7)} l S`,
      `${f(x1 + w * 0.2)} ${f(y1 + h * 0.5)} m ${f(x1 + w * 0.8)} ${f(y1 + h * 0.5)} l S`,
      `${f(x1 + w * 0.2)} ${f(y1 + h * 0.3)} m ${f(x1 + w * 0.6)} ${f(y1 + h * 0.3)} l S`,
    );
  }
  const stream = doc.context.stream(ops.join('\n'), {
    Type: 'XObject', Subtype: 'Form', FormType: 1, BBox: rect, Resources: resources,
  });
  return doc.context.register(stream);
}

function buildAnnotation(doc, a, pageRef) {
  const rect = a.type === 'note' ? a.rect : bbox(a.quads, 1);
  const dict = {
    Type: 'Annot',
    Subtype: SUBTYPE[a.type],
    Rect: rect,
    C: hexToRgb(a.color),
    F: 4,
    P: pageRef,
    NM: PDFString.of(a.id),
    T: PDFHexString.fromText(a.author || ''),
    Contents: PDFHexString.fromText(a.comment || ''),
    M: PDFString.fromDate(new Date(a.modified || Date.now())),
    CreationDate: PDFString.fromDate(new Date(a.created || Date.now())),
    AP: { N: appearance(doc, a, rect) },
  };
  if (a.type === 'note') {
    dict.Name = 'Comment';
    dict.Open = false;
  } else {
    dict.QuadPoints = a.quads.flat();
    if (a.type === 'highlight') dict.CA = a.opacity ?? 1;
  }
  return doc.context.register(doc.context.obj(dict));
}

/**
 * @param {{src:string, dest:string, remove:string[], add:object[]}} job
 * @returns {{ok:true, refs:Object<string,string>} | {error:string, message?:string}}
 */
async function saveAnnotations(job) {
  const bytes = await fs.promises.readFile(job.src);
  let doc;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (err) {
    if (err instanceof EncryptedPDFError || /encrypt/i.test(err?.message)) return { error: 'encrypted' };
    throw err;
  }
  const pages = doc.getPages();
  const remove = new Set(job.remove);

  if (remove.size) {
    for (const page of pages) {
      const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
      if (!annots) continue;
      const drop = new Set();
      for (let i = 0; i < annots.size(); i++) {
        const ref = annots.get(i);
        if (!(ref instanceof PDFRef) || !remove.has(refId(ref))) continue;
        drop.add(refId(ref));
        const dict = doc.context.lookupMaybe(ref, PDFDict);
        const popup = dict?.get(PDFName.of('Popup'));
        if (popup instanceof PDFRef) drop.add(refId(popup));
      }
      for (let i = annots.size() - 1; i >= 0; i--) {
        const ref = annots.get(i);
        if (ref instanceof PDFRef && drop.has(refId(ref))) {
          annots.remove(i);
          doc.context.delete(ref);
        }
      }
    }
  }

  const refs = {};
  for (const a of job.add) {
    const page = pages[a.page - 1];
    if (!page) continue;
    const ref = buildAnnotation(doc, a, page.ref);
    page.node.addAnnot(ref);
    refs[a.id] = refId(ref);
  }

  const out = await doc.save({ useObjectStreams: false });
  // Confere se o arquivo gerado abre e tem o mesmo número de páginas antes de substituir o original
  const check = await PDFDocument.load(out, { updateMetadata: false });
  if (check.getPageCount() !== pages.length) throw new Error('Verificação do arquivo salvo falhou.');

  const tmp = job.dest + '.leitorpdf-tmp';
  await fs.promises.writeFile(tmp, out);
  try {
    await fs.promises.rename(tmp, job.dest);
  } catch (err) {
    await fs.promises.unlink(tmp).catch(() => {});
    throw err;
  }
  return { ok: true, refs };
}

module.exports = { saveAnnotations };
