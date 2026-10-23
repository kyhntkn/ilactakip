'use strict';
// Kayıt, yedekleme ve ortak klasör eşitleme mantığı.
// Electron'a bağımlı değildir; arayüz işleri (diyalog, bildirim, yeniden yükleme) dışarıdan verilir.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const SHARED_NAME = 'siparis_verileri_ortak.json';
const SH_TIMEOUT = 6000;           // ortak alan işlemleri için zaman aşımı (ms)
const BAK_EVERY = 10 * 60 * 1000;  // en sık 10 dakikada bir yedek
const KEEP = { yedek_: 40, gunluk_: 90, ortak_onceki_: 20, yerel_onceki_: 20 };

const withTimeout = (p, ms = SH_TIMEOUT) => Promise.race([
  p, new Promise((_, rej) => setTimeout(() => rej(new Error('Ortak alana ulaşılamadı (zaman aşımı)')), ms))
]);
const pad = n => String(n).padStart(2, '0');
const stamp = (d = new Date()) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const who = () => { let u = 'kullanici'; try { u = os.userInfo().username; } catch (e) {} return u + '@' + os.hostname(); };
const fmtDate = iso => { const d = new Date(iso); return isNaN(d) ? '-' : d.toLocaleString('tr-TR'); };

async function writeAtomic(file, text) {
  const tmp = file + '.' + process.pid + '.tmp';
  await fsp.writeFile(tmp, text, 'utf8');
  try { await fsp.rename(tmp, file); }
  catch (e) { await fsp.copyFile(tmp, file); await fsp.unlink(tmp).catch(() => {}); }
}

// Kayıt zarfı: ham S verisi "data" alanında; kimlik/tarih/kaydeden bilgisi ayrıca tutulur.
function makeEnv(json) {
  const meta = { id: crypto.randomUUID(), savedAt: new Date().toISOString(), savedBy: who() };
  const text = '{"format":"ilac-siparis-takip","v":1,"id":' + JSON.stringify(meta.id) +
    ',"savedAt":' + JSON.stringify(meta.savedAt) + ',"savedBy":' + JSON.stringify(meta.savedBy) + ',"data":' + json + '}';
  return { text, meta, json };
}

// Dosyayı oku. Yoksa null. Eski (zarfsız) ham JSON dosyalarını da kabul eder.
async function readEnv(file) {
  let text;
  try { text = await fsp.readFile(file, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  if (!text.trim()) return null;
  const o = JSON.parse(text);
  if (o && o.format === 'ilac-siparis-takip' && o.data && Array.isArray(o.data.customers)) {
    return { text, json: JSON.stringify(o.data), meta: { id: o.id || null, savedAt: o.savedAt, savedBy: o.savedBy } };
  }
  if (o && Array.isArray(o.customers)) { // eski ham yedek
    const st = await fsp.stat(file);
    const env = makeEnv(text);
    return { text: env.text, json: text, meta: { id: null, savedAt: st.mtime.toISOString(), savedBy: '?' } };
  }
  throw new Error('Dosya biçimi tanınmadı');
}

function createStore({ userDir, msgBox, notify, reload }) {
  const dataDir = path.join(userDir, 'veri');
  const bakDir = path.join(dataDir, 'yedekler');
  const LOCAL = path.join(dataDir, 'siparis_verileri.json');
  const CFG = path.join(userDir, 'ayarlar.json');

  let cfg = { sharedDir: null, lastSharedId: null, pendingShared: false };
  const st = { initialJson: null, localEnv: null, lastSavedAt: null, err: null, shared: { state: 'off' } };
  let epoch = 1, lastBak = 0, conflictDeferred = false, dialogOpen = false, q = Promise.resolve(), timer = null;

  const queue = fn => { const r = q.then(fn, fn); q = r.catch(() => {}); return r; };
  const sharedFile = () => path.join(cfg.sharedDir, SHARED_NAME);
  const saveCfg = () => writeAtomic(CFG, JSON.stringify(cfg, null, 1)).catch(() => {});
  const status = () => ({
    lastSavedAt: st.lastSavedAt, err: st.err,
    shared: { enabled: !!cfg.sharedDir, state: cfg.sharedDir ? st.shared.state : 'off', at: st.shared.at || null, dir: cfg.sharedDir }
  });
  const push = () => { try { notify(status()); } catch (e) {} };
  const setShared = (state, extra = {}) => { st.shared = { state, ...extra }; };

  async function prune(prefix) {
    const names = (await fsp.readdir(bakDir)).filter(n => n.startsWith(prefix)).sort().reverse();
    for (const n of names.slice(KEEP[prefix])) await fsp.unlink(path.join(bakDir, n)).catch(() => {});
  }
  async function copyToBak(srcText, prefix) {
    await fsp.mkdir(bakDir, { recursive: true });
    await fsp.writeFile(path.join(bakDir, prefix + stamp() + '.json'), srcText, 'utf8');
    await prune(prefix).catch(() => {});
  }
  // Kayıt öncesi, bir önceki sürümü en fazla 10 dakikada bir yedekle
  async function rotateBackup() {
    const now = Date.now();
    if (now - lastBak < BAK_EVERY) return;
    let prev; try { prev = await fsp.readFile(LOCAL, 'utf8'); } catch (e) { return; }
    lastBak = now;
    await fsp.mkdir(bakDir, { recursive: true });
    const s = stamp();
    await fsp.writeFile(path.join(bakDir, 'yedek_' + s + '.json'), prev, 'utf8');
    await fsp.writeFile(path.join(bakDir, 'gunluk_' + s.slice(0, 8) + '.json'), prev, 'utf8');
    await prune('yedek_').catch(() => {}); await prune('gunluk_').catch(() => {});
  }

  async function loadLocal() {
    try { return await readEnv(LOCAL); }
    catch (e) {
      // Bozuk dosya: en yeni geçerli yedeğe dön
      let names = []; try { names = (await fsp.readdir(bakDir)).filter(n => /^(yedek_|gunluk_)/.test(n)).sort().reverse(); } catch (x) {}
      for (const n of names) { try { const r = await readEnv(path.join(bakDir, n)); if (r) { st.err = 'Kayıt dosyası okunamadı; son yedekten yüklendi (' + n + ')'; return r; } } catch (x) {} }
      throw e;
    }
  }

  async function adoptShared(cur) {
    if (st.localEnv) await copyToBak(st.localEnv.text, 'yerel_onceki_').catch(() => {});
    await writeAtomic(LOCAL, cur.text);
    st.localEnv = cur; st.initialJson = cur.json; st.lastSavedAt = cur.meta.savedAt;
    cfg.lastSharedId = cur.meta.id; cfg.pendingShared = false; await saveCfg();
    conflictDeferred = false; epoch++; setShared('ok', { at: new Date().toISOString() });
    push(); reload();
  }

  async function pushLocal(force) {
    if (!cfg.sharedDir || !st.localEnv) return;
    try {
      await withTimeout(fsp.mkdir(cfg.sharedDir, { recursive: true }));
      const cur = await withTimeout(readEnv(sharedFile()));
      if (cur && cur.meta.id !== cfg.lastSharedId && !force) {
        if (!st.initialJson) return adoptShared(cur);
        if (conflictDeferred) { setShared('conflict'); return; }
        return resolveConflict(cur);
      }
      if (cur && force) await copyToBak(cur.text, 'ortak_onceki_').catch(() => {});
      await withTimeout(writeAtomic(sharedFile(), st.localEnv.text));
      cfg.lastSharedId = st.localEnv.meta.id; cfg.pendingShared = false; await saveCfg();
      conflictDeferred = false; setShared('ok', { at: new Date().toISOString() });
    } catch (e) { setShared('offline', { err: e.message }); }
  }

  async function resolveConflict(cur) {
    if (dialogOpen) return; dialogOpen = true;
    try {
      const mine = st.localEnv && st.localEnv.meta;
      const r = await msgBox({
        type: 'warning', title: 'Ortak alan çakışması', noLink: true, defaultId: 2, cancelId: 2,
        message: 'Ortak klasördeki veri, bu bilgisayarla en son eşitlendiğinizden beri değişmiş.',
        detail: 'Ortak dosya: ' + (cur.meta.savedBy || '?') + ' — ' + fmtDate(cur.meta.savedAt) +
          '\nBu bilgisayardaki kayıt: ' + (mine ? fmtDate(mine.savedAt) : '-') +
          '\n\nHangisi korunsun? Diğeri “yedekler” klasörüne alınır, kaybolmaz.',
        buttons: ['Ortak veriyi yükle', 'Benim verimi yaz', 'Şimdilik bekle']
      });
      if (r === 0) await adoptShared(cur);
      else if (r === 1) await pushLocal(true);
      else { conflictDeferred = true; setShared('conflict'); }
    } finally { dialogOpen = false; }
  }

  async function doSave(json, ep) {
    if (ep !== epoch) return { ...status(), stale: true };
    const env = makeEnv(json);
    try {
      await fsp.mkdir(bakDir, { recursive: true });
      await rotateBackup().catch(() => {});
      await writeAtomic(LOCAL, env.text);
    } catch (e) { st.err = 'Yerel kayıt hatası: ' + e.message; push(); return status(); }
    st.err = null; st.localEnv = env; st.initialJson = json; st.lastSavedAt = env.meta.savedAt;
    if (cfg.sharedDir) {
      if (!cfg.pendingShared) { cfg.pendingShared = true; await saveCfg(); }
      if (!conflictDeferred) await pushLocal(false); else setShared('conflict');
    }
    push(); return status();
  }

  async function poll() {
    if (!cfg.sharedDir) return;
    try {
      const cur = await withTimeout(readEnv(sharedFile()));
      if (!cur) { if (st.localEnv) await pushLocal(false); }
      else if (cur.meta.id === cfg.lastSharedId) {
        if (cfg.pendingShared) await pushLocal(false); else setShared('ok', { at: st.shared.at });
      } else if (!st.initialJson) await adoptShared(cur);
      else if (cfg.pendingShared) { if (conflictDeferred) setShared('conflict'); else await resolveConflict(cur); }
      else setShared('newer');
    } catch (e) { setShared('offline', { err: e.message }); }
    push();
  }

  async function syncShared() {
    if (!cfg.sharedDir) { await msgBox({ type: 'info', message: 'Önce bir ortak klasör seçin.', buttons: ['Tamam'] }); return status(); }
    conflictDeferred = false;
    return queue(async () => {
      try {
        const cur = await withTimeout(readEnv(sharedFile()));
        if (!cur) await pushLocal(false);
        else if (cur.meta.id === cfg.lastSharedId) {
          if (cfg.pendingShared) await pushLocal(false);
          setShared('ok', { at: new Date().toISOString() });
          await msgBox({ type: 'info', message: 'Ortak alan ile eşitlendi.', buttons: ['Tamam'] });
        } else if (!st.initialJson || !cfg.pendingShared) await adoptShared(cur);
        else await resolveConflict(cur);
      } catch (e) {
        setShared('offline', { err: e.message });
        await msgBox({ type: 'error', message: 'Ortak alana ulaşılamadı.', detail: e.message, buttons: ['Tamam'] });
      }
      push(); return status();
    });
  }

  async function setSharedDir(dir) {
    cfg.sharedDir = dir; cfg.lastSharedId = null; cfg.pendingShared = true; conflictDeferred = false;
    await saveCfg(); setShared('offline');
    try { await withTimeout(fsp.mkdir(dir, { recursive: true })); const t = path.join(dir, '.yazma_testi_' + process.pid); await withTimeout(fsp.writeFile(t, 'x')); await fsp.unlink(t).catch(() => {}); }
    catch (e) { await msgBox({ type: 'error', message: 'Bu klasöre yazılamıyor.', detail: e.message, buttons: ['Tamam'] }); cfg.sharedDir = null; await saveCfg(); setShared('off'); push(); return status(); }
    return syncShared();
  }
  async function clearShared() { cfg.sharedDir = null; cfg.lastSharedId = null; cfg.pendingShared = false; conflictDeferred = false; await saveCfg(); setShared('off'); push(); return status(); }

  async function start() {
    await fsp.mkdir(bakDir, { recursive: true });
    try { cfg = { ...cfg, ...JSON.parse(await fsp.readFile(CFG, 'utf8')) }; } catch (e) {}
    const loc = await loadLocal().catch(e => { st.err = 'Kayıt dosyası okunamadı: ' + e.message; return null; });
    if (loc) { st.localEnv = loc; st.initialJson = loc.json; st.lastSavedAt = loc.meta.savedAt; }
    if (cfg.sharedDir) { setShared('offline'); await queue(poll); }
    timer = setInterval(() => queue(poll), 45000);
  }
  function stop() { clearInterval(timer); }

  return {
    start, stop, status, queue,
    save: (json, ep) => queue(() => doSave(json, ep)),
    syncShared, setSharedDir, clearShared,
    boot: () => ({ json: st.initialJson, epoch, status: status() }),
    info: () => ({ dataFile: LOCAL, dataDir, backupDir: bakDir, sharedDir: cfg.sharedDir, sharedFile: cfg.sharedDir ? sharedFile() : null }),
    paths: { dataDir, bakDir, LOCAL }
  };
}

module.exports = { createStore, readEnv, makeEnv, SHARED_NAME };
