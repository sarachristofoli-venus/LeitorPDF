'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, protocol, Menu, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { saveAnnotations } = require('./pdf-annotations');

const ROOT = app.getAppPath();
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.pfb': 'application/octet-stream',
  '.bcmap': 'application/octet-stream',
};

// Protocolo interno app:// — evita as restrições de file:// para módulos ES e o worker do PDF.js
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

let win = null;
let rendererReady = false;
let pendingFiles = [];

const dataFile = () => path.join(app.getPath('userData'), 'dados.json');
const sidecarFile = (file) => path.join(
  app.getPath('userData'), 'anotacoes',
  crypto.createHash('sha1').update(path.resolve(String(file)).toLowerCase()).digest('hex') + '.json',
);

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  } catch (err) {
    console.error('Falha ao salvar dados:', err);
  }
}

function pdfArgs(argv, cwd = process.cwd()) {
  return argv
    .slice(1)
    .filter((a) => !a.startsWith('-') && /\.pdf$/i.test(a))
    .map((a) => path.resolve(cwd, a))
    .filter((a) => fs.existsSync(a));
}

function sendFiles(files) {
  if (!files.length) return;
  if (win && rendererReady) win.webContents.send('open-files', files);
  else pendingFiles.push(...files);
}

function createWindow() {
  const state = readJson(dataFile(), {}).window || {};
  win = new BrowserWindow({
    width: state.width || 1280,
    height: state.height || 860,
    x: state.x,
    y: state.y,
    minWidth: 640,
    minHeight: 420,
    title: 'Leitor PDF',
    icon: path.join(ROOT, 'build', 'icon.png'),
    backgroundColor: '#1e1f22',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  if (state.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('enter-full-screen', () => win.webContents.send('fullscreen', true));
  win.on('leave-full-screen', () => win.webContents.send('fullscreen', false));

  win.on('close', () => {
    const data = readJson(dataFile(), {});
    data.window = { ...win.getNormalBounds(), maximized: win.isMaximized() };
    writeJson(dataFile(), data);
  });
  win.on('closed', () => { win = null; rendererReady = false; });

  win.loadURL('app://leitor/src/index.html');
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  pendingFiles = pdfArgs(process.argv);

  app.on('second-instance', (_e, argv, cwd) => {
    sendFiles(pdfArgs(argv, cwd));
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);

    protocol.handle('app', async (request) => {
      const url = new URL(request.url);
      const file = path.normalize(path.join(ROOT, decodeURIComponent(url.pathname)));
      if (!file.startsWith(ROOT)) return new Response('Proibido', { status: 403 });
      try {
        const body = await fs.promises.readFile(file);
        const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
        return new Response(body, { headers: { 'content-type': type } });
      } catch {
        return new Response('Não encontrado', { status: 404 });
      }
    });

    ipcMain.handle('initial-files', () => {
      rendererReady = true;
      const files = pendingFiles;
      pendingFiles = [];
      return files;
    });

    ipcMain.handle('open-dialog', async () => {
      const res = await dialog.showOpenDialog(win, {
        title: 'Abrir PDF',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Documentos PDF', extensions: ['pdf'] }, { name: 'Todos os arquivos', extensions: ['*'] }],
      });
      return res.canceled ? [] : res.filePaths;
    });

    ipcMain.handle('read-file', (_e, file) => fs.promises.readFile(String(file)));

    ipcMain.handle('file-stat', async (_e, file) => {
      try {
        const st = await fs.promises.stat(String(file));
        return { size: st.size, mtime: st.mtimeMs };
      } catch {
        return null;
      }
    });

    ipcMain.handle('store-get', () => {
      const { window: _w, ...rest } = readJson(dataFile(), {});
      return rest;
    });

    ipcMain.on('store-set', (_e, data) => {
      const cur = readJson(dataFile(), {});
      writeJson(dataFile(), { ...data, window: cur.window });
    });

    ipcMain.on('open-external', (_e, url) => {
      try {
        const u = new URL(String(url));
        if (['http:', 'https:', 'mailto:'].includes(u.protocol)) shell.openExternal(u.href);
      } catch { /* URL inválida */ }
    });

    ipcMain.on('show-in-folder', (_e, file) => shell.showItemInFolder(String(file)));

    ipcMain.handle('fullscreen', (_e, on) => {
      if (!win) return false;
      win.setFullScreen(on === undefined ? !win.isFullScreen() : !!on);
      return win.isFullScreen();
    });

    ipcMain.handle('app-version', () => app.getVersion());

    ipcMain.on('copy-text', (_e, text) => clipboard.writeText(String(text)));
    ipcMain.on('close-window', () => win?.close());

    ipcMain.handle('user-name', () => {
      try { return os.userInfo().username; } catch { return ''; }
    });

    ipcMain.handle('save-dialog', async (_e, defaultPath) => {
      const res = await dialog.showSaveDialog(win, {
        title: 'Salvar PDF como',
        defaultPath: String(defaultPath || ''),
        filters: [{ name: 'Documentos PDF', extensions: ['pdf'] }],
      });
      return res.canceled ? null : res.filePath;
    });

    ipcMain.handle('save-annotations', async (_e, job) => {
      try {
        return await saveAnnotations(job);
      } catch (err) {
        const busy = ['EBUSY', 'EPERM', 'EACCES'].includes(err?.code);
        return { error: busy ? 'locked' : 'failed', message: err?.message || String(err) };
      }
    });

    ipcMain.handle('sidecar-get', (_e, file) => readJson(sidecarFile(file), null));
    ipcMain.handle('sidecar-set', (_e, file, data) => {
      writeJson(sidecarFile(file), { path: String(file), ...data });
      return true;
    });

    createWindow();
  });

  app.on('window-all-closed', () => app.quit());
}
