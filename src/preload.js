'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('leitor', {
  initialFiles: () => ipcRenderer.invoke('initial-files'),
  openDialog: (kind) => ipcRenderer.invoke('open-dialog', kind),
  readFile: (file) => ipcRenderer.invoke('read-file', file),
  fileStat: (file) => ipcRenderer.invoke('file-stat', file),
  storeGet: () => ipcRenderer.invoke('store-get'),
  storeSet: (data) => ipcRenderer.send('store-set', data),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  showInFolder: (file) => ipcRenderer.send('show-in-folder', file),
  fullscreen: (on) => ipcRenderer.invoke('fullscreen', on),
  version: () => ipcRenderer.invoke('app-version'),
  userName: () => ipcRenderer.invoke('user-name'),
  copyText: (text) => ipcRenderer.send('copy-text', text),
  closeWindow: () => ipcRenderer.send('close-window'),
  saveDialog: (defaultPath) => ipcRenderer.invoke('save-dialog', defaultPath),
  saveFile: (defaultPath, bytes, ext) => ipcRenderer.invoke('save-file', defaultPath, bytes, ext),
  copyImage: (bytes) => ipcRenderer.invoke('copy-image', bytes),
  saveAnnotations: (job) => ipcRenderer.invoke('save-annotations', job),
  sidecarGet: (file) => ipcRenderer.invoke('sidecar-get', file),
  sidecarSet: (file, data) => ipcRenderer.invoke('sidecar-set', file, data),
  pathForFile: (file) => webUtils.getPathForFile(file),
  onOpenFiles: (cb) => ipcRenderer.on('open-files', (_e, files) => cb(files)),
  onFullscreen: (cb) => ipcRenderer.on('fullscreen', (_e, on) => cb(on)),
});
