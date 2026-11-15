'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  platform: process.platform,
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: patch => ipcRenderer.invoke('config:set', patch),
  chooseDir: () => ipcRenderer.invoke('dir:choose'),
  openDir: () => ipcRenderer.invoke('dir:open'),
  showFile: file => ipcRenderer.invoke('file:show', file),
  setRecState: (state, elapsedText, extra) => ipcRenderer.send('rec:state', state, elapsedText || '', extra || {}),
  onSourceChosen: handler => ipcRenderer.on('source-chosen', (_e, name, type) => handler(name, type)),
  // 主进程要求选择录制源：handler(sources) 返回 Promise<sourceId|null>
  onPickSource: handler => ipcRenderer.on('pick-source', async (_e, id, sources) => {
    let v = null; try { v = await handler(sources); } catch {}
    ipcRenderer.send('pick-source:reply', id, v);
  }),
  onHotkey: handler => ipcRenderer.on('hotkey', (_e, k) => handler(k)),
});
