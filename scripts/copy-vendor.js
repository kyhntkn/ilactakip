// Excel kütüphanelerini (xlsx-js-style, exceljs) uygulamanın içine kopyalar, böylece program internetsiz çalışır.
const fs = require('fs'), path = require('path');
const out = path.join(__dirname, '..', 'app', 'vendor');
fs.mkdirSync(out, { recursive: true });
const nm = path.join(__dirname, '..', 'node_modules');
const jobs = [
  ['xlsx.bundle.js', ['xlsx-js-style/dist/xlsx.bundle.js', 'xlsx-js-style/dist/xlsx.full.min.js']],
  ['exceljs.min.js', ['exceljs/dist/exceljs.min.js', 'exceljs/dist/exceljs.js']]
];
let fail = false;
for (const [name, cands] of jobs) {
  const src = cands.map(c => path.join(nm, c)).find(p => fs.existsSync(p));
  if (!src) { console.error('BULUNAMADI:', name, '<-', cands.join(' | ')); fail = true; continue; }
  fs.copyFileSync(src, path.join(out, name));
  console.log('kopyalandı:', name, '<-', path.relative(nm, src));
}
if (fail) process.exit(1);
