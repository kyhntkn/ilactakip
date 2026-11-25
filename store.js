'use strict';
// Kayıt, yedekleme, ortak klasör ve düzenleme kilidi mantığı.
// Electron'a bağımlı değildir; arayüz işleri (diyalog, bildirim, veri gönderme) dışarıdan verilir.
//
// İki çalışma biçimi vardır:
//  - "local": Ortak klasör seçilmemiştir. Tek kullanıcı, veri bu bilgisayarda (eski davranış).
//  - Ortak klasör seçiliyse ASIL KAYIT ortak klasördedir. Aynı anda tek kişi düzenler ("edit"),
//    diğerleri salt okunur görür ("view"). Yerel dosya yalnızca son görülen verinin önbelleğidir.
//
// Ortak klasör içeriği:
//   siparis_verileri_ortak.json  asıl veri (sürüm no + SHA-256 sağlama ile)
//   siparis_kilit.json           düzenleme kilidi (kim, hangi bilgisayar; ~15 sn'de bir tazelenir)
//   siparis_istek.json           "düzenleme hakkını iste" isteği
//   kayit_defteri.txt            kim, ne zaman kaydetti / düzenlemeyi aldı-bıraktı
//   yedekler/                    sürüm, günlük ve çakışma yedekleri
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const SHARED_NAME = 'siparis_verileri_ortak.json';
const LOCK_NAME = 'siparis_kilit.json';
const REQ_NAME = 'siparis_istek.json';
const LOG_NAME = 'kayit_defteri.txt';

const DEFAULT_T = {
  op: 8000,           // tek bir ortak alan işlemi için zaman aşımı
  poll: 4000,         // ortak alanı kontrol sıklığı
  beat: 15000,        // kilit tazeleme sıklığı
  stale: 90000,       // bu kadar süre tazelenmeyen kilit "terk edilmiş" sayılır
  reqAnswer: 120000,  // düzenleme isteğine cevap verilmezse kilit bu süre sonra bırakılır
  reqMaxAge: 300000,  // bundan eski istekler yok sayılır
  bakEvery: 10 * 60 * 1000
};
const KEEP_LOCAL = { yedek_: 40, gunluk_: 90, yerel_onceki_: 20, cakisma_: 50 };
const KEEP_SHARED = { surum_: 200, gunluk_: 180, cakisma_: 100, ortak_onceki_: 50, bozuk_: 20 };

const pad = n => String(n).padStart(2, '0');
const stamp = (d = new Date()) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const sha = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const ident = () => {
  let user = 'kullanici'; try { user = os.userInfo().username; } catch (e) {}
  const host = os.hostname();
  return { user, host, by: user + '@' + host };
};
const fmtDate = iso => { const d = new Date(iso); return isNaN(d) ? '-' : d.toLocaleString('tr-TR'); };
const safe = s => String(s).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 40);
const sleep = ms => new Promise(r => setTimeout(r, ms));

class CorruptError extends Error { constructor(m) { super(m); this.corrupt = true; } }

// Yazma: geçici dosya → diske zorla (fsync) → tek adımda yerine koy (rename).
// Ağ sürücüsünde dosya o an başka biri tarafından okunuyorsa rename kısa süre reddedilebilir; birkaç kez denenir.
// Yarım dosya oluşturabilecek "doğrudan kopyala" yedek yolu bilinçli olarak YOKTUR.
async function writeAtomic(file, text) {
  const tmp = path.join(path.dirname(file), '.' + path.basename(file) + '.' + process.pid + '.' + crypto.randomBytes(3).toString('hex') + '.tmp');
  const fh = await fsp.open(tmp, 'w');
  try { await fh.writeFile(text, 'utf8'); await fh.sync(); } finally { await fh.close(); }
  for (let i = 0; ; i++) {
    try { await fsp.rename(tmp, file); return; }
    catch (e) {
      if (i < 8 && ['EPERM', 'EBUSY', 'EACCES', 'EEXIST'].includes(e.code)) { await sleep(150 + i * 100); continue; }
      await fsp.unlink(tmp).catch(() => {});
      throw e;
    }
  }
}

// Kayıt zarfı. "data" ham S verisidir; sha, data'nın JSON metninin SHA-256 özetidir.
function makeEnv(json, rev, idn = ident()) {
  const meta = { id: crypto.randomUUID(), rev: rev || 1, savedAt: new Date().toISOString(), savedBy: idn.by, sha: sha(json) };
  const text = '{"format":"ilac-siparis-takip","v":2,"id":' + JSON.stringify(meta.id) + ',"rev":' + meta.rev +
    ',"savedAt":' + JSON.stringify(meta.savedAt) + ',"savedBy":' + JSON.stringify(meta.savedBy) +
    ',"sha":' + JSON.stringify(meta.sha) + ',"data":' + json + '}';
  return { text, json, meta };
}

function parseEnv(text, mtime) {
  if (!text.trim()) throw new CorruptError('Dosya boş');
  let o; try { o = JSON.parse(text); } catch (e) { throw new CorruptError('Dosya okunamadı (yarım ya da bozuk): ' + e.message); }
  if (o && o.format === 'ilac-siparis-takip' && o.data && Array.isArray(o.data.customers)) {
    const json = JSON.stringify(o.data);
    if (o.sha && sha(json) !== o.sha) throw new CorruptError('Sağlama tutmadı (dosya bozuk)');
    return { text, json, meta: { id: o.id || null, rev: o.rev || 0, savedAt: o.savedAt, savedBy: o.savedBy, sha: o.sha || sha(json) } };
  }
  if (o && Array.isArray(o.customers)) { // eski ham yedek
    const env = makeEnv(text, 0);
    return { text: env.text, json: text, meta: { id: null, rev: 0, savedAt: (mtime || new Date()).toISOString(), savedBy: '?', sha: env.meta.sha } };
  }
  throw new CorruptError('Dosya biçimi tanınmadı');
}

// Dosyayı oku. Yoksa null.
async function readEnv(file) {
  let text;
  try { text = await fsp.readFile(file, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  let mtime; try { mtime = (await fsp.stat(file)).mtime; } catch (e) {}
  return parseEnv(text, mtime);
}

function createStore({ userDir, msgBox, notify, pushData, flushRenderer, timing, identity }) {
  const T = { ...DEFAULT_T, ...(timing || {}) };
  const me = identity || ident();
  const session = crypto.randomUUID();
  const dataDir = path.join(userDir, 'veri');
  const bakDir = path.join(dataDir, 'yedekler');
  const LOCAL = path.join(dataDir, 'siparis_verileri.json');
  const CFG = path.join(userDir, 'ayarlar.json');
  flushRenderer = flushRenderer || (async () => {});
  pushData = pushData || (() => {});

  // pending: ortak alana henüz yazılamamış yerel değişiklik var. baseId: bu değişikliğin dayandığı ortak sürüm.
  let cfg = { sharedDir: null, sharedId: null, pending: null };
  const st = {
    mode: 'local', env: null, err: null, notice: null,
    shared: { state: 'off', at: null }, lock: null, req: null,
    lastStat: null, corrupt: 0, myIds: new Set(), configuring: false, lastShBak: 0, lastLocBak: 0, lastBeat: 0, beatNo: 0, prompting: false
  };
  let epoch = 1, q = Promise.resolve(), timer = null, polling = false, stopped = false, latestJson = null;

  const queue = fn => { const r = q.then(fn, fn); q = r.catch(() => {}); return r; };
  const op = (p, ms = T.op) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('Ortak alana ulaşılamadı (zaman aşımı)')), ms))]);
  const S = name => path.join(cfg.sharedDir, name);
  const shBak = () => path.join(cfg.sharedDir, 'yedekler');
  const saveCfg = () => writeAtomic(CFG, JSON.stringify(cfg, null, 1)).catch(() => {});
  const ask = o => Promise.resolve().then(() => msgBox(o)).catch(() => -1);
  const tell = o => { ask({ type: 'info', buttons: ['Tamam'], ...o }); }; // beklemeden göster

  const status = () => ({
    mode: st.mode, err: st.err, notice: st.notice, pending: !!cfg.pending,
    lastSavedAt: st.env ? st.env.meta.savedAt : null, savedBy: st.env ? st.env.meta.savedBy : null, rev: st.env ? st.env.meta.rev : null,
    shared: { enabled: !!cfg.sharedDir, state: cfg.sharedDir ? st.shared.state : 'off', at: st.shared.at, dir: cfg.sharedDir },
    lock: st.lock, req: st.req, me: me.by
  });
  const push = () => { try { notify(status()); } catch (e) {} };
  const setShared = (state, extra) => { st.shared = { ...st.shared, state, ...(extra || {}) }; };

  // ---------- yedekler ----------
  async function prune(dir, prefix, keep) {
    const names = (await fsp.readdir(dir)).filter(n => n.startsWith(prefix)).sort().reverse();
    for (const n of names.slice(keep[prefix])) await fsp.unlink(path.join(dir, n)).catch(() => {});
  }
  async function bakLocal(text, prefix) {
    await fsp.mkdir(bakDir, { recursive: true });
    await fsp.writeFile(path.join(bakDir, prefix + stamp() + '.json'), text, 'utf8');
    await prune(bakDir, prefix, KEEP_LOCAL).catch(() => {});
  }
  async function bakShared(text, name, prefix) {
    await op(fsp.mkdir(shBak(), { recursive: true }));
    await op(writeAtomic(path.join(shBak(), name), text));
    await prune(shBak(), prefix, KEEP_SHARED).catch(() => {});
  }
  // Yerel dosyanın bir önceki sürümünü en fazla 10 dakikada bir yedekle
  async function rotateLocal() {
    const now = Date.now();
    if (now - st.lastLocBak < T.bakEvery) return;
    let prev; try { prev = await fsp.readFile(LOCAL, 'utf8'); } catch (e) { return; }
    st.lastLocBak = now;
    const s = stamp();
    await fsp.mkdir(bakDir, { recursive: true });
    await fsp.writeFile(path.join(bakDir, 'yedek_' + s + '.json'), prev, 'utf8');
    await fsp.writeFile(path.join(bakDir, 'gunluk_' + s.slice(0, 8) + '.json'), prev, 'utf8');
    await prune(bakDir, 'yedek_', KEEP_LOCAL).catch(() => {}); await prune(bakDir, 'gunluk_', KEEP_LOCAL).catch(() => {});
  }
  // Ortak dosyanın üzerine yazmadan önce mevcut hâlini en fazla 10 dakikada bir ortak yedeklere al
  async function rotateShared(cur) {
    const now = Date.now();
    if (!cur || now - st.lastShBak < T.bakEvery) return;
    st.lastShBak = now;
    const s = stamp();
    await bakShared(cur.text, 'surum_' + s + '_r' + (cur.meta.rev || 0) + '.json', 'surum_');
    await bakShared(cur.text, 'gunluk_' + s.slice(0, 8) + '.json', 'gunluk_');
  }
  async function log(what) {
    if (!cfg.sharedDir) return;
    const line = new Date().toLocaleString('tr-TR') + '\t' + me.by + '\t' + what + '\n';
    await op(fsp.appendFile(S(LOG_NAME), line, 'utf8')).catch(() => {});
  }

  async function loadLocal() {
    try { return await readEnv(LOCAL); }
    catch (e) {
      let names = []; try { names = (await fsp.readdir(bakDir)).filter(n => /^(yedek_|gunluk_)/.test(n)).sort().reverse(); } catch (x) {}
      for (const n of names) { try { const r = await readEnv(path.join(bakDir, n)); if (r) { st.err = 'Kayıt dosyası okunamadı; son yedekten yüklendi (' + n + ')'; return r; } } catch (x) {} }
      throw e;
    }
  }

  // ---------- ortak dosya ----------
  // Windows'ta erişilemeyen ağ yolu da "dosya yok" (ENOENT) hatası verir. "Dosya yok" demeden önce
  // klasörün kendisine ulaşılabildiğini doğrula; ulaşılamıyorsa bu bir bağlantı sorunudur.
  async function reachable() {
    try { const s = await op(fsp.stat(cfg.sharedDir)); if (!s.isDirectory()) throw new Error('Ortak klasör bulunamadı'); }
    catch (e) { const x = new Error('Ortak klasöre ulaşılamıyor: ' + (e.code || e.message)); x.offline = true; throw x; }
  }
  async function statShared() {
    try { const s = await op(fsp.stat(S(SHARED_NAME))); return s.mtimeMs + ':' + s.size; }
    catch (e) { if (e.code === 'ENOENT') { await reachable(); return null; } throw e; }
  }
  async function readShared() { const r = await op(readEnv(S(SHARED_NAME))); if (!r) await reachable(); return r; }

  // Veriyi göster (ve yerel önbelleğe yaz). Ekranı yeniler.
  async function adopt(cur) {
    st.env = cur; cfg.sharedId = cur.meta.id; await saveCfg();
    await writeAtomic(LOCAL, cur.text).catch(e => { st.err = 'Yerel önbellek yazılamadı: ' + e.message; });
    epoch++; pushData(cur.json, epoch);
  }

  // Ortak alana yazılamamış değişikliği kaybetmemek için ayrı kopyaya al.
  async function conflictCopy(why) {
    if (!st.env || !cfg.pending) return null;
    const name = 'cakisma_' + safe(me.user) + '_' + stamp() + '.json';
    let where = 'bu bilgisayardaki yedekler klasörü';
    await bakLocal(st.env.text, 'cakisma_').catch(() => {});
    try { await bakShared(st.env.text, name, 'cakisma_'); where = 'ortak klasördeki "yedekler" klasörü'; } catch (e) {}
    cfg.pending = null; await saveCfg();
    await log('çakışma kopyası oluşturuldu: ' + name + ' (' + why + ')');
    st.notice = 'Ortak alana gönderilemeyen değişiklikleriniz "' + name + '" adıyla ' + where + 'na kaydedildi.';
    tell({ type: 'warning', title: 'Değişiklikleriniz ayrı kopyaya alındı', message: 'Ortak alana gönderilemeyen değişiklikleriniz kaybolmadı.',
      detail: why + '\n\nDosya: ' + name + '\nYer: ' + where + '\n\nGerekirse bu dosyayı, düzenleme hakkını aldıktan sonra "Yedek / Rapor → Yedekten geri yükle" ile açabilirsiniz.' });
    return name;
  }

  // ---------- kilit ----------
  async function readLock() {
    let text, s;
    try { [text, s] = await op(Promise.all([fsp.readFile(S(LOCK_NAME), 'utf8'), fsp.stat(S(LOCK_NAME))])); }
    catch (e) { if (e.code === 'ENOENT') { await reachable(); return null; } throw e; }
    try { return { ...JSON.parse(text), mtimeMs: s.mtimeMs }; }
    catch (e) { return { busy: true, mtimeMs: s.mtimeMs }; } // tam o an yazılıyor
  }
  // Sunucunun saatini öğren: küçük bir dosya yaz, değişiklik zamanına bak.
  // Böylece bilgisayar saatleri farklı olsa da "kilit ne kadar süredir tazelenmedi" doğru hesaplanır.
  async function serverNow() {
    const f = S('.saat_' + session.slice(0, 8));
    await op(fsp.writeFile(f, String(Date.now())));
    return (await op(fsp.stat(f))).mtimeMs;
  }
  async function lockState() {
    const lk = await readLock();
    if (!lk) return { free: true };
    if (lk.session === session) return { mine: true };
    const age = Math.max(0, (await serverNow()) - lk.mtimeMs);
    return { by: lk.by || '?', since: lk.since || null, ageMs: age, stale: !lk.busy && age > T.stale,
      sameMe: lk.user === me.user && lk.host === me.host, busy: !!lk.busy };
  }
  const lockText = () => JSON.stringify({ format: 'ilac-siparis-kilit', session, by: me.by, user: me.user, host: me.host, pid: process.pid,
    since: st.lockSince, beat: ++st.beatNo, at: new Date().toISOString() });

  async function tryCreateLock() {
    if (st.mode !== 'edit' || !st.lockSince) st.lockSince = new Date().toISOString();
    let fh;
    try { fh = await op(fsp.open(S(LOCK_NAME), 'wx')); }
    catch (e) { if (e.code === 'EEXIST') return false; throw e; }
    try { await fh.writeFile(lockText(), 'utf8'); await fh.sync(); } finally { await fh.close(); }
    return true;
  }

  // Düzenleme hakkını almayı dene. force: terk edilmiş kilidi devral.
  async function acquire(force) {
    let got = await tryCreateLock(), how = 'düzenlemeyi aldı';
    if (!got) {
      const ls = await lockState();
      if (ls.mine) got = true;
      else if ((ls.stale && force) || ls.sameMe) { // terk edilmiş kilit ya da bu bilgisayarda kapanmadan kalmış oturum
        // Önceki kilidi kenara al (tek adımlık rename; aynı anda iki kişi denerse yalnızca biri başarır)
        try { await op(fsp.rename(S(LOCK_NAME), S('.kilit_eski_' + session.slice(0, 8) + '.json'))); } catch (e) { return false; }
        await op(fsp.unlink(S('.kilit_eski_' + session.slice(0, 8) + '.json'))).catch(() => {});
        got = await tryCreateLock();
        how = 'düzenlemeyi devraldı (önceki: ' + ls.by + ')';
      }
    }
    if (!got) return false;
    st.mode = 'edit'; st.lastBeat = Date.now(); st.lock = { mine: true }; st.req = null; st.notice = null;
    await log(how);
    // İsteğimiz varsa sil
    try { const r = JSON.parse(await op(fsp.readFile(S(REQ_NAME), 'utf8'))); if (r.session === session) await op(fsp.unlink(S(REQ_NAME))); } catch (e) {}
    // En güncel veriyi al; bekleyen yerel değişiklik varsa uygunsa gönder, değilse ayrı kopyaya al
    const cur = await readShared().catch(e => { if (e.corrupt) return { corrupt: e }; throw e; });
    st.lastStat = await statShared();
    if (cfg.pending) {
      if (!cur || cur.corrupt || cur.meta.id === cfg.pending.baseId) await pushPending();
      else { await conflictCopy('Siz ortak alana bağlı değilken başka biri veriyi değiştirmiş.'); await adopt(cur); }
    } else if (cur && !cur.corrupt) {
      if (!st.env || cur.meta.id !== st.env.meta.id) await adopt(cur);
      else cfg.sharedId = cur.meta.id;
    } else if (!cur && st.env) { cfg.pending = { baseId: null }; await saveCfg(); await pushPending(); }
    else if (cur && cur.corrupt) st.err = 'Ortak veri dosyası bozuk görünüyor. Yedekten geri yükleyin ya da kaydettiğinizde düzeltilir (bozuk dosya yedeklere alınır).';
    return true;
  }

  // Düzenleyen bizken kilit dosyası yoksa (ör. elle silindi) yeniden oluşturmayı dene.
  async function ensureMine() {
    let lk = await readLock();
    if (!lk && await tryCreateLock()) lk = await readLock();
    if (!lk || (lk.session && lk.session !== session)) { await lostLock(lk); return false; }
    return true;
  }
  async function heartbeat() {
    if (!(await ensureMine())) return;
    await op(fsp.writeFile(S(LOCK_NAME), lockText(), 'utf8'));
    st.lastBeat = Date.now();
  }

  async function lostLock(lk) {
    st.mode = 'view'; st.lock = null;
    const by = lk && lk.by ? lk.by : 'başka biri';
    if (cfg.pending) await conflictCopy('Bağlantınız koptuğu sırada düzenleme hakkı ' + by + ' tarafından devralındı.');
    else st.notice = 'Düzenleme hakkı ' + by + ' tarafından devralındı. Şimdi salt okunur moddasınız.';
    const cur = await readShared().catch(() => null);
    if (cur && (!st.env || cur.meta.id !== st.env.meta.id)) await adopt(cur);
    else { epoch++; } // ekrandaki bekleyen kayıtlar reddedilsin
  }

  async function releaseLock(note) {
    if (st.mode !== 'edit') return;
    await pushPending().catch(() => {});
    try { const lk = await readLock(); if (lk && lk.session === session) await op(fsp.unlink(S(LOCK_NAME))); } catch (e) {}
    st.mode = 'view'; st.lock = { free: true }; epoch++;
    await log('düzenlemeyi bıraktı' + (note ? ' (' + note + ')' : ''));
  }

  // ---------- düzenleme isteği ----------
  async function readReq() {
    try {
      const [t, s] = await op(Promise.all([fsp.readFile(S(REQ_NAME), 'utf8'), fsp.stat(S(REQ_NAME))]));
      return { ...JSON.parse(t), mtimeMs: s.mtimeMs };
    } catch (e) { return null; }
  }
  async function checkRequestAsEditor() {
    if (st.prompting) return;
    const r = await readReq();
    if (!r || r.session === session || r.state !== 'bekliyor') return;
    if ((await serverNow()) - r.mtimeMs > T.reqMaxAge) return;
    st.prompting = true;
    promptRelease(r).finally(() => { st.prompting = false; });
  }
  async function promptRelease(r) {
    const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const tm = setTimeout(() => ac && ac.abort(), T.reqAnswer);
    const ans = await ask({
      type: 'question', title: 'Düzenleme isteği', noLink: true, defaultId: 0, cancelId: 1, signal: ac ? ac.signal : undefined,
      message: r.by + ' düzenleme yapmak istiyor.',
      detail: 'Düzenlemeyi bırakırsanız tüm değişiklikleriniz kaydedilir ve siz salt okunur moda geçersiniz.\n\n' +
        Math.round(T.reqAnswer / 60000) + ' dakika içinde cevap verilmezse düzenleme otomatik olarak bırakılır.',
      buttons: ['Düzenlemeyi bırak', 'Ben devam ediyorum']
    });
    clearTimeout(tm);
    const timedOut = ac && ac.signal.aborted;
    if (st.mode !== 'edit') return;
    if (ans === 0 || timedOut) {
      await queue(async () => { await op(writeAtomic(S(REQ_NAME), JSON.stringify({ ...r, mtimeMs: undefined, state: 'onaylandi', answeredBy: me.by }))).catch(() => {}); });
      await release(timedOut ? 'istek cevapsız kaldı, ' + r.by + ' için' : r.by + ' istedi');
      if (timedOut) tell({ title: 'Düzenleme bırakıldı', message: r.by + ' düzenleme istedi; cevap verilmediği için düzenleme hakkı bırakıldı.', detail: 'Değişiklikleriniz kaydedildi. Şimdi salt okunur moddasınız.' });
    } else {
      await queue(async () => { await op(writeAtomic(S(REQ_NAME), JSON.stringify({ ...r, mtimeMs: undefined, state: 'reddedildi', answeredBy: me.by }))).catch(() => {}); });
    }
    push();
  }

  // ---------- kaydetme ----------
  async function pushPending() {
    if (!cfg.sharedDir || !cfg.pending || !st.env) return;
    try {
      if (!(await ensureMine())) return;
      let cur = null;
      const sNow = await statShared();
      if (sNow !== st.lastStat) {
        try { cur = await readShared(); }
        catch (e) {
          if (!e.corrupt) throw e;
          // Kilit bizdeyken ortak dosya bozuk: bozuk hâlini sakla, üzerine sağlam veriyi yaz
          const raw = await op(fsp.readFile(S(SHARED_NAME), 'utf8')).catch(() => '');
          await bakShared(raw, 'bozuk_' + stamp() + '.json', 'bozuk_').catch(() => {});
          await log('ortak dosya bozuk bulundu, yedeklere alındı');
        }
        if (cur && cur.meta.id !== cfg.pending.baseId && !st.myIds.has(cur.meta.id)) {
          // Kilit bizdeyken başkası yazmış (beklenmez). Hiçbir veri ezilmesin.
          await conflictCopy('Ortak veri, düzenleme sizdeyken beklenmedik şekilde değişti.');
          await adopt(cur); st.lastStat = await statShared(); return;
        }
      }
      if (sNow && Date.now() - st.lastShBak >= T.bakEvery && !cur) cur = await readShared().catch(() => null);
      if (cur) await rotateShared(cur).catch(() => {});
      st.myIds.add(st.env.meta.id);
      await op(writeAtomic(S(SHARED_NAME), st.env.text));
      const back = await readShared(); // geri oku ve doğrula
      if (!back || back.meta.id !== st.env.meta.id || back.meta.sha !== st.env.meta.sha) throw new Error('Ortak alana yazılan veri doğrulanamadı');
      st.lastStat = await statShared();
      cfg.sharedId = st.env.meta.id; cfg.pending = null; await saveCfg();
      await log('kaydetti (sürüm ' + st.env.meta.rev + ')');
      st.err = null; setShared('ok', { at: new Date().toISOString() });
    } catch (e) { setShared('offline', { err: e.message }); }
  }

  async function doSave() {
    if (latestJson === null) return status();
    const json = latestJson; latestJson = null;
    // Ortak alana gönderilmeyi bekleyen değişiklik varsa aynı sürüm numarası korunur; yoksa bir artar.
    const base = st.env ? st.env.meta.rev || 0 : 0;
    const env = makeEnv(json, cfg.sharedDir && cfg.pending ? Math.max(1, base) : base + 1, me);
    try {
      await fsp.mkdir(bakDir, { recursive: true });
      await rotateLocal().catch(() => {});
      await writeAtomic(LOCAL, env.text);
    } catch (e) { st.err = 'Yerel kayıt hatası: ' + e.message; push(); return status(); }
    st.err = null; st.env = env;
    if (cfg.sharedDir) {
      if (!cfg.pending) { cfg.pending = { baseId: cfg.sharedId }; await saveCfg(); }
      await pushPending();
    }
    push(); return status();
  }

  function save(json, ep) {
    if (ep !== epoch) return Promise.resolve({ ...status(), stale: true });
    if (st.mode === 'view') return Promise.resolve({ ...status(), rejected: true });
    latestJson = json; // art arda gelen kayıtlar birleştirilir, en son hâl yazılır
    return queue(doSave);
  }

  // ---------- düzenli kontrol ----------
  async function poll() {
    if (!cfg.sharedDir || stopped || st.configuring) return;
    try {
      // 1) Veri değişti mi?
      const sNow = await statShared();
      if (sNow && sNow !== st.lastStat) {
        let cur = null;
        try { cur = await readShared(); st.corrupt = 0; }
        catch (e) {
          if (!e.corrupt) throw e;
          if (++st.corrupt >= 3) st.err = 'Ortak veri dosyası okunamıyor (' + e.message + '). Yedeklerden geri yükleme gerekebilir.';
        }
        if (cur) {
          st.lastStat = sNow;
          if (cur.meta.id !== cfg.sharedId && (!st.env || cur.meta.id !== st.env.meta.id)) {
            if (st.mode === 'edit') {
              if (!(await ensureMine())) { /* lostLock halletti */ }
              else if (cfg.pending) { await conflictCopy('Ortak veri, düzenleme sizdeyken beklenmedik şekilde değişti.'); await adopt(cur); }
              else await adopt(cur);
            } else await adopt(cur);
          } else cfg.sharedId = cur.meta.id;
          if (st.err && /okunamıyor/.test(st.err)) st.err = null;
        }
      }
      // 2) Kilit / istek
      if (st.mode === 'edit') {
        if (cfg.pending) await pushPending();
        if (st.mode === 'edit' && Date.now() - st.lastBeat >= T.beat) await heartbeat();
        if (st.mode === 'edit') await checkRequestAsEditor();
      }
      if (st.mode === 'view') {
        const ls = await lockState();
        const r = await readReq();
        const rAge = r ? (await serverNow()) - r.mtimeMs : 0;
        const myReq = r && r.session === session;
        if (st.req && st.req.mine && !myReq && Date.now() - Date.parse(st.req.at) > 20000) st.req = null;
        if (myReq && r.state === 'reddedildi') {
          st.req = { denied: true, by: r.answeredBy || ls.by };
          await op(fsp.unlink(S(REQ_NAME))).catch(() => {});
        } else if (myReq && rAge > T.reqMaxAge + T.reqAnswer) {
          st.req = null; await op(fsp.unlink(S(REQ_NAME))).catch(() => {});
        }
        if (ls.free) {
          const reservedFor = r && !myReq && r.state !== 'reddedildi' && rAge < 60000 ? r.by : null;
          if (myReq && r.state !== 'reddedildi') { await acquire(false); }
          else st.lock = { free: true, reservedFor };
        } else if (ls.sameMe) {
          await acquire(false); // bu bilgisayarda önceden kapanmadan kalmış oturum
        } else if (!ls.busy || !st.lock) st.lock = ls;
      }
      if (!cfg.pending || st.mode === 'view') setShared('ok', { at: new Date().toISOString() });
    } catch (e) { setShared('offline', { err: e.message }); }
    push();
  }
  function schedulePoll() { if (polling || stopped) return; polling = true; queue(poll).finally(() => { polling = false; }); }

  // ---------- dışarıya açılan işlemler ----------
  async function release(note) {
    if (st.mode !== 'edit') return status();
    await flushRenderer();          // ekrandaki son değişikliği kaydettir
    await queue(() => releaseLock(note));
    push(); return status();
  }
  async function requestEdit() {
    if (!cfg.sharedDir || st.mode !== 'view') return status();
    return queue(async () => {
      try {
        const ls = await lockState();
        if (ls.free || ls.mine) { await acquire(false); }
        else {
          await op(writeAtomic(S(REQ_NAME), JSON.stringify({ format: 'ilac-siparis-istek', session, by: me.by, at: new Date().toISOString(), state: 'bekliyor' })));
          st.req = { mine: true, at: new Date().toISOString(), to: ls.by };
        }
      } catch (e) { setShared('offline', { err: e.message }); }
      push(); return status();
    });
  }
  async function cancelRequest() {
    return queue(async () => {
      const r = await readReq();
      if (r && r.session === session) await op(fsp.unlink(S(REQ_NAME))).catch(() => {});
      st.req = null; push(); return status();
    });
  }
  async function takeover() {
    if (!cfg.sharedDir || st.mode !== 'view') return status();
    return queue(async () => {
      try {
        const ls = await lockState();
        if (!ls.free && !ls.mine && !ls.stale) {
          st.notice = ls.by + ' hâlâ bağlı görünüyor; devralmak yerine düzenleme hakkı isteyin.';
        } else if (!(await acquire(true))) st.notice = 'Düzenleme hakkı alınamadı, biraz sonra tekrar deneyin.';
      } catch (e) { setShared('offline', { err: e.message }); }
      push(); return status();
    });
  }
  function dismissNotice() { st.notice = null; if (st.req && st.req.denied) st.req = null; push(); return status(); }
  async function refresh() { await queue(poll); return status(); }

  async function setSharedDir(dir) {
    if (st.mode === 'edit' && cfg.sharedDir) await release('ortak klasör değiştirildi');
    // Yazılabilir mi?
    try {
      await op(fsp.mkdir(dir, { recursive: true }));
      const t = path.join(dir, '.yazma_testi_' + process.pid);
      await op(fsp.writeFile(t, 'x')); await fsp.unlink(t).catch(() => {});
    } catch (e) { await ask({ type: 'error', message: 'Bu klasöre yazılamıyor.', detail: e.message, buttons: ['Tamam'] }); return status(); }

    const prevDir = cfg.sharedDir;
    await queue(async () => { st.configuring = true; });
    try { return await configureShared(dir, prevDir); } finally { st.configuring = false; push(); }
  }
  async function configureShared(dir, prevDir) {
    cfg.sharedDir = dir;
    let cur = null, ls = { free: true };
    try { cur = await readShared(); } catch (e) { if (!e.corrupt) { cfg.sharedDir = prevDir; await ask({ type: 'error', message: 'Ortak dosya okunamadı.', detail: e.message, buttons: ['Tamam'] }); return status(); } }
    try { ls = await lockState(); } catch (e) {}
    let pending = null;
    if (cur && st.env && cur.meta.id !== st.env.meta.id) {
      const busy = !ls.free && !ls.mine && !ls.stale;
      const r = await ask({
        type: 'question', title: 'Ortak klasörde veri var', noLink: true, defaultId: 0, cancelId: busy ? 1 : 2,
        message: 'Bu klasörde daha önce kaydedilmiş veri bulundu.',
        detail: 'Ortak veri: ' + (cur.meta.savedBy || '?') + ' — ' + fmtDate(cur.meta.savedAt) +
          '\nBu bilgisayardaki veri: ' + fmtDate(st.env.meta.savedAt) +
          (busy ? '\n\nŞu anda ' + ls.by + ' düzenliyor; bu yüzden yalnızca ortak veriyi kullanabilirsiniz.' : '') +
          '\n\nHangisi kullanılsın? Diğeri yedeklere alınır, kaybolmaz.',
        buttons: busy ? ['Ortak veriyi kullan', 'Vazgeç'] : ['Ortak veriyi kullan', 'Bu bilgisayardaki veriyi ortak alana yaz', 'Vazgeç']
      });
      if ((busy && r !== 0) || (!busy && r === 2) || r < 0) { cfg.sharedDir = prevDir; return status(); }
      if (r === 0) await bakLocal(st.env.text, 'yerel_onceki_').catch(() => {});
      else { await bakShared(cur.text, 'ortak_onceki_' + stamp() + '.json', 'ortak_onceki_').catch(() => {}); pending = { baseId: cur.meta.id }; }
    } else if (!cur && st.env) pending = { baseId: null };
    cfg.sharedId = null; cfg.pending = pending; st.lastStat = null; st.mode = 'view'; st.lock = null; st.req = null;
    await saveCfg();
    await queue(async () => {
      try { if (!(await acquire(false))) { const c = await readShared().catch(() => null); if (c) await adopt(c); } }
      catch (e) { setShared('offline', { err: e.message }); }
    });
    await queue(poll);
    return status();
  }

  async function clearShared() {
    if (st.mode === 'edit') await release('ortak bağlantı kaldırıldı');
    cfg.sharedDir = null; cfg.sharedId = null; cfg.pending = null;
    await saveCfg();
    st.mode = 'local'; st.lock = null; st.req = null; setShared('off'); epoch++;
    if (st.env) pushData(st.env.json, epoch);
    push(); return status();
  }

  async function start() {
    await fsp.mkdir(bakDir, { recursive: true });
    try { cfg = { ...cfg, ...JSON.parse(await fsp.readFile(CFG, 'utf8')) }; } catch (e) {}
    // 1.0.x ayarlarından geçiş
    if (cfg.lastSharedId !== undefined) {
      if (!cfg.sharedId) cfg.sharedId = cfg.lastSharedId;
      if (cfg.pendingShared && !cfg.pending) cfg.pending = { baseId: cfg.lastSharedId };
      delete cfg.lastSharedId; delete cfg.pendingShared; await saveCfg();
    }
    const loc = await loadLocal().catch(e => { st.err = 'Kayıt dosyası okunamadı: ' + e.message; return null; });
    if (loc) st.env = loc;
    if (cfg.sharedDir) {
      st.mode = 'view'; setShared('offline');
      // Açılışta: kilit boşsa (ya da bu bilgisayarda kapanmadan kalmışsa) düzenleme hakkını al
      await queue(async () => {
        try {
          const ls = await lockState();
          if (ls.free || ls.mine || ls.sameMe) await acquire(false);
          else st.lock = ls;
          if (st.mode === 'view') { const c = await readShared().catch(() => null); if (c && (!st.env || c.meta.id !== st.env.meta.id)) await adopt(c); }
          setShared('ok', { at: new Date().toISOString() });
        } catch (e) { setShared('offline', { err: e.message }); }
      });
      await queue(poll);
    }
    timer = setInterval(schedulePoll, T.poll);
  }

  // Program kapanırken: bekleyen yazmayı bitir, kilidi bırak
  async function shutdown() {
    stopped = true; clearInterval(timer);
    await queue(async () => {
      if (st.mode === 'edit') {
        await pushPending().catch(() => {});
        try { const lk = await readLock(); if (lk && lk.session === session) await op(fsp.unlink(S(LOCK_NAME)), 4000); } catch (e) {}
        await log('programı kapattı, düzenlemeyi bıraktı');
      }
      if (cfg.sharedDir) await op(fsp.unlink(S('.saat_' + session.slice(0, 8))), 3000).catch(() => {});
    });
  }

  return {
    start, shutdown, status, queue, save, release, requestEdit, cancelRequest, takeover, dismissNotice, refresh,
    setSharedDir, clearShared,
    boot: () => ({ json: st.env ? st.env.json : null, epoch, status: status() }),
    info: () => ({ dataFile: LOCAL, dataDir, backupDir: bakDir, sharedDir: cfg.sharedDir,
      sharedFile: cfg.sharedDir ? S(SHARED_NAME) : null, sharedBackupDir: cfg.sharedDir ? shBak() : null, logFile: cfg.sharedDir ? S(LOG_NAME) : null }),
    paths: { dataDir, bakDir, LOCAL },
    _debug: () => ({ cfg, st, epoch, session })
  };
}

module.exports = { createStore, readEnv, parseEnv, makeEnv, writeAtomic, SHARED_NAME, LOCK_NAME, REQ_NAME };
