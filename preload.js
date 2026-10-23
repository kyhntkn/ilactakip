'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Açılışta kayıtlı veriyi ana süreçten eşzamanlı al (sayfa, veriyi ilk satırlarda okur)
const boot = ipcRenderer.sendSync('boot');
let statusCb = null, flushCb = null, saveNowCb = null;

ipcRenderer.on('status', (_e, s) => { if (statusCb) statusCb(s); });
ipcRenderer.on('app:flush', async () => {
  try { if (flushCb) await flushCb(); } catch (e) { /* kapanışı engelleme */ }
  ipcRenderer.send('app:flushed');
});
ipcRenderer.on('app:saveNow', () => { if (saveNowCb) saveNowCb(); });

contextBridge.exposeInMainWorld('desktop', {
  initial: boot.json,
  status0: boot.status,
  save: json => ipcRenderer.invoke('data:save', json, boot.epoch),
  info: () => ipcRenderer.invoke('info'),
  chooseShared: () => ipcRenderer.invoke('shared:choose'),
  syncShared: () => ipcRenderer.invoke('shared:sync'),
  clearShared: () => ipcRenderer.invoke('shared:clear'),
  refocus: () => ipcRenderer.send('refocus'),
  openDataDir: () => ipcRenderer.invoke('open:data'),
  openBackups: () => ipcRenderer.invoke('open:backups'),
  onStatus: cb => { statusCb = cb; },
  onFlush: cb => { flushCb = cb; },
  onSaveNow: cb => { saveNowCb = cb; }
});
