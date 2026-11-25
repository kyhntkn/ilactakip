'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const { createStore } = require('./store');

app.setAppUserModelId('tr.ilac.siparistakip');
if (!app.requestSingleInstanceLock()) { app.quit(); return; }

let win = null, store = null, closing = false;
const alive = () => win && !win.isDestroyed();
const msgBox = o => (alive() ? dialog.showMessageBox(win, o) : dialog.showMessageBox(o)).then(r => r.response);

// Sayfadaki bekleyen (henüz kaydedilmemiş) değişikliği kaydettir
function flushRenderer(ms = 3000) {
  if (!alive()) return Promise.resolve();
  return Promise.race([
    new Promise(res => { ipcMain.once('app:flushed', res); win.webContents.send('app:flush'); }),
    new Promise(res => setTimeout(res, ms))
  ]);
}

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

  // Kapanırken: bekleyen değişikliği kaydet, ortak alana gönder, düzenleme kilidini bırak, sonra kapat
  win.on('close', async e => {
    if (closing) return;
    e.preventDefault(); closing = true;
    try {
      await flushRenderer();
      await Promise.race([store.shutdown(), new Promise(res => setTimeout(res, 10000))]);
    } catch (x) { /* yine de kapat */ }
    win.destroy();
  });
  win.on('closed', () => { win = null; });
}

function buildMenu() {
  const t = [
    { label: 'Dosya', submenu: [
      { label: 'Şimdi kaydet', accelerator: 'CmdOrCtrl+S', click: () => alive() && win.webContents.send('app:saveNow') },
      { label: 'Veri klasörünü aç (bu bilgisayar)', click: () => shell.openPath(store.paths.dataDir) },
      { label: 'Yedekler klasörünü aç (bu bilgisayar)', click: () => shell.openPath(store.paths.bakDir) },
      { label: 'Ortak yedekler klasörünü aç', click: () => { const i = store.info(); if (i.sharedBackupDir) shell.openPath(i.sharedBackupDir); } },
      { label: 'Kayıt defterini aç', click: () => { const i = store.info(); if (i.logFile) shell.openPath(i.logFile); } },
      { type: 'separator' }, { role: 'quit', label: 'Çıkış' } ] },
    { label: 'Düzen', submenu: [
      { role: 'undo', label: 'Geri al' }, { role: 'redo', label: 'Yinele' }, { type: 'separator' },
      { role: 'cut', label: 'Kes' }, { role: 'copy', label: 'Kopyala' }, { role: 'paste', label: 'Yapıştır' }, { role: 'selectAll', label: 'Tümünü seç' } ] },
    { label: 'Görünüm', submenu: [
      { role: 'zoomIn', label: 'Yakınlaştır' }, { role: 'zoomOut', label: 'Uzaklaştır' }, { role: 'resetZoom', label: 'Yakınlaştırmayı sıfırla' },
      { type: 'separator' }, { role: 'togglefullscreen', label: 'Tam ekran' },
      ...(app.isPackaged ? [] : [{ role: 'toggleDevTools', label: 'Geliştirici araçları' }]) ] },
    { label: 'Yardım', submenu: [
      { label: 'Hakkında', click: () => { const i = store.info(); dialog.showMessageBox(win, { type: 'info', title: 'Hakkında', message: 'İlaç Sipariş Takip',
        detail: 'Sürüm ' + app.getVersion() + '\nKullanıcı: ' + store.status().me + '\nVeri klasörü: ' + store.paths.dataDir + (i.sharedDir ? '\nOrtak klasör: ' + i.sharedDir : ''), buttons: ['Tamam'] }); } } ] }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(t));
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('window-all-closed', () => app.quit());

app.whenReady().then(async () => {
  store = createStore({
    userDir: app.getPath('userData'), msgBox, flushRenderer,
    notify: s => { if (alive()) win.webContents.send('status', s); },
    pushData: (json, epoch) => { if (alive()) win.webContents.send('data', { json, epoch }); }
  });
  await store.start();

  ipcMain.on('boot', e => { e.returnValue = store.boot(); });
  ipcMain.handle('data:save', (_e, json, epoch) => store.save(json, epoch));
  ipcMain.handle('info', () => ({ ...store.info(), version: app.getVersion() }));
  ipcMain.handle('shared:choose', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Ortak klasörü seçin (şirket ağındaki paylaşım klasörü)', properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return store.status();
    return store.setSharedDir(r.filePaths[0]);
  });
  ipcMain.handle('shared:clear', async () => {
    const r = await msgBox({ type: 'question', buttons: ['Bağlantıyı kaldır', 'Vazgeç'], defaultId: 1, cancelId: 1,
      message: 'Ortak klasör bağlantısı kaldırılsın mı?',
      detail: 'Bu bilgisayar bundan sonra ortak alanı görmez; son alınan veriyle tek başına çalışır. Ortak klasördeki veri silinmez.' });
    return r === 0 ? store.clearShared() : store.status();
  });
  ipcMain.handle('shared:refresh', () => store.refresh());
  ipcMain.handle('edit:request', () => store.requestEdit());
  ipcMain.handle('edit:cancel', () => store.cancelRequest());
  ipcMain.handle('edit:release', () => store.release('kendisi bıraktı'));
  ipcMain.handle('notice:dismiss', () => store.dismissNotice());
  ipcMain.handle('edit:takeover', async () => {
    const l = store.status().lock || {};
    const dk = Math.max(1, Math.round((l.ageMs || 0) / 60000));
    const r = await msgBox({ type: 'warning', buttons: ['Düzenlemeyi devral', 'Vazgeç'], defaultId: 1, cancelId: 1, noLink: true,
      message: (l.by || 'Önceki kullanıcı') + ' düzenleme hakkını bırakmadan bağlantısı kesilmiş görünüyor.',
      detail: 'Son sinyal yaklaşık ' + dk + ' dakika önce geldi (bilgisayarı kapanmış, uykuya geçmiş ya da ağdan kopmuş olabilir).\n\n' +
        'Devralırsanız, o kişinin ortak alana gönderemediği değişiklikler bağlandığında ayrı bir "çakışma" kopyasına alınır; kaybolmaz.' });
    return r === 0 ? store.takeover() : store.status();
  });
  // Windows'ta alert/confirm sonrası giriş alanlarının donmasını önler
  ipcMain.on('refocus', () => { if (alive()) { win.blur(); win.focus(); win.webContents.focus(); } });
  ipcMain.handle('open:data', () => shell.openPath(store.paths.dataDir));
  ipcMain.handle('open:backups', () => shell.openPath(store.paths.bakDir));
  ipcMain.handle('open:sharedBackups', () => { const i = store.info(); return i.sharedBackupDir ? shell.openPath(i.sharedBackupDir) : ''; });
  ipcMain.handle('open:log', () => { const i = store.info(); return i.logFile ? shell.openPath(i.logFile) : ''; });

  buildMenu();
  createWindow();
});
