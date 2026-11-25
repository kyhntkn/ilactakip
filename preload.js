'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Açılışta kayıtlı veriyi ana süreçten eşzamanlı al (sayfa, veriyi ilk satırlarda okur)
const boot = ipcRenderer.sendSync('boot');
let epoch = boot.epoch;
let statusCb = null, flushCb = null, saveNowCb = null, dataCb = null, lastData = null;

ipcRenderer.on('status', (_e, s) => { if (statusCb) statusCb(s); });
// Ortak alandan yeni veri geldi (salt okunur ekranın canlı güncellenmesi, düzenleme hakkı alınınca güncel veri)
ipcRenderer.on('data', (_e, d) => { epoch = d.epoch; if (dataCb) dataCb(d.json); else lastData = d.json; });
ipcRenderer.on('app:flush', async () => {
  try { if (flushCb) await flushCb(); } catch (e) { /* kapanışı engelleme */ }
  ipcRenderer.send('app:flushed');
});
ipcRenderer.on('app:saveNow', () => { if (saveNowCb) saveNowCb(); });

contextBridge.exposeInMainWorld('desktop', {
  initial: boot.json,
  status0: boot.status,
  save: json => ipcRenderer.invoke('data:save', json, epoch),
  info: () => ipcRenderer.invoke('info'),
  chooseShared: () => ipcRenderer.invoke('shared:choose'),
  clearShared: () => ipcRenderer.invoke('shared:clear'),
  refreshShared: () => ipcRenderer.invoke('shared:refresh'),
  requestEdit: () => ipcRenderer.invoke('edit:request'),
  cancelRequest: () => ipcRenderer.invoke('edit:cancel'),
  takeover: () => ipcRenderer.invoke('edit:takeover'),
  releaseEdit: () => ipcRenderer.invoke('edit:release'),
  dismissNotice: () => ipcRenderer.invoke('notice:dismiss'),
  refocus: () => ipcRenderer.send('refocus'),
  openDataDir: () => ipcRenderer.invoke('open:data'),
  openBackups: () => ipcRenderer.invoke('open:backups'),
  openSharedBackups: () => ipcRenderer.invoke('open:sharedBackups'),
  openLog: () => ipcRenderer.invoke('open:log'),
  onStatus: cb => { statusCb = cb; },
  onData: cb => { dataCb = cb; if (lastData !== null) { const j = lastData; lastData = null; cb(j); } },
  onFlush: cb => { flushCb = cb; },
  onSaveNow: cb => { saveNowCb = cb; }
});
