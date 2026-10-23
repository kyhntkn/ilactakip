'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const { createStore } = require('./store');

app.setAppUserModelId('tr.ilac.siparistakip');
if (!app.requestSingleInstanceLock()) { app.quit(); return; }

let win = null, store = null, closing = false;
const msgBox = o => (win && !win.isDestroyed() ? dialog.showMessageBox(win, o) : dialog.showMessageBox(o)).then(r => r.response);

function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 900, minHeight: 600, show: false,
    title: 'İlaç Sipariş Takip', icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  win.setMenuBarVisibility(true);
  win.loadFile(path.join(__dirname, 'app', 'index.html'));
  win.once('ready-to-show', () => { win.maximize(); win.show(); });
  // Dış adreslere gitmeyi / yeni pencere açmayı engelle
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file://')) e.preventDefault(); });

  // Kapanırken: sayfadaki bekleyen değişikliği kaydettir, sonra kapat
  win.on('close', async e => {
    if (closing) return;
    e.preventDefault(); closing = true;
    try {
      await Promise.race([
        new Promise(res => { ipcMain.once('app:flushed', res); win.webContents.send('app:flush'); }),
        new Promise(res => setTimeout(res, 3000))
      ]);
      await Promise.race([store.queue(async () => {}), new Promise(res => setTimeout(res, 5000))]);
    } catch (x) { /* yine de kapat */ }
    store.stop(); win.destroy();
  });
  win.on('closed', () => { win = null; });
}

function buildMenu() {
  const t = [
    { label: 'Dosya', submenu: [
      { label: 'Şimdi kaydet', accelerator: 'CmdOrCtrl+S', click: () => win && win.webContents.send('app:saveNow') },
      { label: 'Veri klasörünü aç', click: () => shell.openPath(store.paths.dataDir) },
      { label: 'Yedekler klasörünü aç', click: () => shell.openPath(store.paths.bakDir) },
      { type: 'separator' }, { role: 'quit', label: 'Çıkış' } ] },
    { label: 'Düzen', submenu: [
      { role: 'undo', label: 'Geri al' }, { role: 'redo', label: 'Yinele' }, { type: 'separator' },
      { role: 'cut', label: 'Kes' }, { role: 'copy', label: 'Kopyala' }, { role: 'paste', label: 'Yapıştır' }, { role: 'selectAll', label: 'Tümünü seç' } ] },
    { label: 'Görünüm', submenu: [
      { role: 'zoomIn', label: 'Yakınlaştır' }, { role: 'zoomOut', label: 'Uzaklaştır' }, { role: 'resetZoom', label: 'Yakınlaştırmayı sıfırla' },
      { type: 'separator' }, { role: 'togglefullscreen', label: 'Tam ekran' },
      ...(app.isPackaged ? [] : [{ role: 'toggleDevTools', label: 'Geliştirici araçları' }]) ] },
    { label: 'Yardım', submenu: [
      { label: 'Hakkında', click: () => dialog.showMessageBox(win, { type: 'info', title: 'Hakkında', message: 'İlaç Sipariş Takip', detail: 'Sürüm ' + app.getVersion() + '\nVeri klasörü: ' + store.paths.dataDir, buttons: ['Tamam'] }) } ] }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(t));
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('window-all-closed', () => app.quit());

app.whenReady().then(async () => {
  store = createStore({
    userDir: app.getPath('userData'), msgBox,
    notify: s => { if (win && !win.isDestroyed()) win.webContents.send('status', s); },
    reload: () => { if (win && !win.isDestroyed()) win.webContents.reload(); }
  });
  await store.start();

  ipcMain.on('boot', e => { e.returnValue = store.boot(); });
  ipcMain.handle('data:save', (_e, json, epoch) => store.save(json, epoch));
  ipcMain.handle('info', () => ({ ...store.info(), version: app.getVersion() }));
  ipcMain.handle('shared:choose', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Ortak klasörü seçin', properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return store.status();
    return store.setSharedDir(r.filePaths[0]);
  });
  ipcMain.handle('shared:sync', () => store.syncShared());
  ipcMain.handle('shared:clear', () => store.clearShared());
  ipcMain.handle('open:data', () => shell.openPath(store.paths.dataDir));
  ipcMain.handle('open:backups', () => shell.openPath(store.paths.bakDir));

  buildMenu();
  createWindow();
});
