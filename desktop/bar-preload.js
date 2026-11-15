'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('bar', {
  onState: handler => ipcRenderer.on('bar:state', (_e, s) => handler(s)),
  action: a => ipcRenderer.send('bar:action', a),
});
