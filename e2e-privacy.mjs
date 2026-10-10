// 出厂默认文本的隐私检查 —— 纯静态，不起 Chrome（几毫秒跑完）。
//
// 背景（v1.21.51）：DEFAULTS.myProfile 原本是一段 691 字的私人自述，
// 以字符串字面量编译进 APK —— 反编译不需要 root、不需要运行就能逐字读到。
// 现在出厂那份换成通用模板，这个套件守住它别再变回私人内容。
// 顺带守 apiKey / searchKey：v1.20.13 曾经把一把真 Key 写死进 DEFAULTS。
import fs from 'fs';
import path from 'path';

const R = path.resolve(import.meta.dirname).split(path.sep).join('/');
const WWW = R + '/www';

let pass = 0, fail = 0;
function t(name, ok, extra) {
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (extra ? '  [' + extra + ']' : ''));
  if (ok) pass++; else fail++;
}

// 旧那份私人自述的特征词。任何一处再出现，就是有人把它写回源码了。
const FORBIDDEN = ['情绪、需求、表达', '还没传出来', '沉默 ≠ 拒绝', '我会关掉自己'];

const read = p => fs.readFileSync(p, 'utf8');
const appJs = read(WWW + '/js/app.js');

console.log('=== 1. 出厂默认那份「他的设定」' );
const dIdx = appJs.indexOf('const DEFAULTS = {');
t('找得到 DEFAULTS', dIdx >= 0);
let profile = '', literals = 0;
if (dIdx >= 0) {
  const re = /\n\s*myProfile:\s*("(?:[^"\\]|\\.)*")/g;
  const tail = appJs.slice(dIdx);
  let m;
  while ((m = re.exec(tail))) {
    literals++;
    if (!profile) { try { profile = JSON.parse(m[1]); } catch (e) { /* 留给下面报错 */ } }
  }
}
t('源码里只有一份 myProfile 字面量（不该再有第二份硬编码文案）', literals === 1, '找到 ' + literals + ' 处');
t('默认那份不是空的、有实际内容', profile.length >= 100, profile.length + ' 字');
t('默认那份是通用模板（上班族），不是私人自述', /上班族|工作日|通勤/.test(profile), profile.slice(0, 24));
const hitSelf = FORBIDDEN.filter(w => profile.indexOf(w) >= 0);
t('默认那份不含旧私人自述的特征词', hitSelf.length === 0, hitSelf.join(' / '));

console.log('');
console.log('=== 2. 整个 www/ 里都不该再有这些词' );
function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = dir + '/' + e.name;
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|html|css|json)$/.test(e.name)) out.push(p);
  }
  return out;
}
const files = walk(WWW, []);
t('扫到了文件', files.length > 5, files.length + ' 个');
const bad = [];
for (const f of files) {
  const s = read(f);
  for (const w of FORBIDDEN) if (s.indexOf(w) >= 0) bad.push(f.replace(R + '/', '') + ' → ' + w);
}
t('www/ 全目录零命中', bad.length === 0, bad.join(' | '));

console.log('');
console.log('=== 3. 密钥不该写死进 DEFAULTS' );
function defRaw(key) {
  const at = appJs.indexOf(key + ":", dIdx);
  if (at < 0) return null;
  const eol = appJs.indexOf(String.fromCharCode(10), at);
  const line = appJs.slice(at, eol < 0 ? appJs.length : eol);
  return line.slice(line.indexOf(":") + 1).replace(/,/g, "").trim();
}
const ak = dIdx >= 0 ? defRaw('apiKey') : null;
const sk = dIdx >= 0 ? defRaw('searchKey') : null;
t('DEFAULTS.apiKey 是空串', ak === "''" || ak === '""', JSON.stringify(ak));
t('DEFAULTS.searchKey 是空串', sk === "''" || sk === '""', JSON.stringify(sk));

console.log('');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
