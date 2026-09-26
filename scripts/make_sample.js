// Gera test/amostra.pdf (uso: npx electron scripts/make_sample.js)
const { app, BrowserWindow } = require('electron');
const fs = require('fs'), path = require('path');
app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false });
  let html = '<meta charset="utf-8"><style>body{font:14pt Georgia;margin:2cm} h1{page-break-before:always;color:#b33} h1:first-of-type{page-break-before:avoid}</style>';
  html += '<h1 id="c0">Sumário</h1><ul>' + [1,2,3,4,5,6].map(i=>`<li><a href="#c${i}">Capítulo ${i}</a></li>`).join('') + '</ul><p>Link externo: <a href="https://mozilla.github.io/pdf.js/">PDF.js</a></p>';
  const lorem = 'Leitura de documentos em PDF com acentuação: ação, coração, informação, você. Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ';
  for (let i = 1; i <= 6; i++) {
    html += `<h1 id="c${i}">Capítulo ${i}</h1><h2>Seção ${i}.1</h2>` + `<p>${lorem.repeat(6)}</p>`.repeat(3) + `<h2>Seção ${i}.2</h2>` + `<p>Palavra especial: girassol${i}. ${lorem.repeat(5)}</p>`.repeat(3);
  }
  await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  const pdf = await w.webContents.printToPDF({ pageSize: 'A4', generateDocumentOutline: true, generateTaggedPDF: true });
  fs.writeFileSync(path.join(__dirname, '..', 'test', 'amostra.pdf'), pdf);
  console.log('ok', pdf.length);
  app.quit();
});
