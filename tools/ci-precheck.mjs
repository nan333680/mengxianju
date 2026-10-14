// tools/ci-precheck.mjs —— 在本地复刻 CI 的环境跑那 20 套（v0.4.1 加）
//
// 为什么要有它：一天里连踩三次「本地全绿、CI 全红」，全是环境差异，不是代码差异：
//   ① 系统语言：GitHub runner 是 en-US，本机是中文 → 任何断言中文文案的套件必红
//      （i18n / menu / empty / group2 就是这么红的）
//   ② prefers-reduced-motion：runner 报 reduce，本机没有 → 产品对 reduce 是【故意】关掉过渡的
//      （无障碍），于是"量位移/量时长"的断言恒为 0（nav 就是这么红的）
//   ③ 工作区里存在被 gitignore 的素材：本地有 tmp/av.png，CI 上没有（group3 就是这么红的）
//
// 这个脚本把 ①② 真的模拟出来跑一遍；③ 用静态检查拦（扫描套件里引用的路径是否被忽略）。
//
// 用法：node tools/ci-precheck.mjs [--only 套件名片段] [--lint-only]
//
// ⚠️ 它不改任何真套件：副本生成在 e2e/cipre-<名字>.mjs（不匹配 e2e-* 通配，回归扫不到），跑完删掉。
import fs from 'fs';
import path from 'path';
import { execFileSync, execSync } from 'child_process';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const only = (() => { const i = process.argv.indexOf('--only'); return i >= 0 ? process.argv[i + 1] : ''; })();
const lintOnly = process.argv.includes('--lint-only');

// 套件清单以 CI 的 workflow 为【唯一来源】，免得两边漂移
const ci = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
const block = ci.match(/\$suites\s*=\s*@\(([\s\S]*?)\)/);
if (!block) { console.error('读不出 ci.yml 里的 $suites 清单'); process.exit(2); }
const suites = block[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
console.log('CI 套件清单：' + suites.length + ' 套');

// ---------- ③ 静态检查：CI 套件不许引用被 gitignore 的路径 ----------
const IGNORED = ['tmp/', '_archive/', '_fixtures/', '_research/'];
let lintBad = 0;
console.log('\n[1/2] 静态检查：CI 套件里有没有引用被 gitignore 的路径');
for (const s of suites) {
  const file = path.join(root, 'e2e', s + '.mjs');
  const src = fs.readFileSync(file, 'utf8');
  // ⚠️ 只看"读"的引用：套件自己 writeFileSync 出来的路径不算问题
  //    （e2e-autobackup 就是先把 _archive/xxx 写出来再用，第一版把它误报了）。
  const READ = /(existsSync|readFileSync|uploadFile|import\(|require\(|createReadStream|statSync)/;
  const WRITE = /(writeFileSync|mkdirSync|createWriteStream|appendFileSync|copyFileSync)/;
  const hits = [];
  for (const line of src.split('\n')) {
    if (line.trim().startsWith('//')) continue;
    if (!READ.test(line)) continue;
    for (const ig of IGNORED) {
      if (!(line.includes("'" + ig) || line.includes('"' + ig))) continue;
      // 这个文件里有没有在别处把它写出来？有就算自造素材，放过
      const wroteIt = src.split('\n').some(l2 => WRITE.test(l2) && (l2.includes("'" + ig) || l2.includes('"' + ig)));
      if (wroteIt) continue;
      hits.push(ig + '  ←  ' + line.trim().slice(0, 80));
    }
  }
  if (hits.length) {
    lintBad++;
    console.log('  ✗ ' + s + ' 引用了被忽略的路径（CI 上不存在）：');
    hits.slice(0, 3).forEach(h => console.log('      ' + h));
  }
}
if (!lintBad) console.log('  ✓ ' + suites.length + ' 套都没有引用被忽略的路径');
if (lintOnly) process.exit(lintBad ? 1 : 0);

// ---------- ①② 生成副本：en-US + 强制关动画 ----------
// ⚠️ configurable: true —— 套件自己要用 defineProperty 钉成中文时，不能在这里被锁死
//    （第一版没写，套件一钉就抛 "Cannot redefine property: language"）。
const spoofLang = "\n/* ci-precheck: 伪装 en-US（可被套件覆盖） */\nawait page.evaluateOnNewDocument(() => { Object.defineProperty(navigator, 'language', { get: () => 'en-US', configurable: true }); Object.defineProperty(navigator, 'languages', { get: () => ['en-US','en'], configurable: true }); });\n";
const list = suites.filter(s => !only || s.includes(only));
console.log('\n[2/2] 用 CI 的环境跑 ' + list.length + ' 套（en-US + prefers-reduced-motion: reduce）');
let pass = 0, fail = 0, skipped = 0;
const made = [];
for (const s of list) {
  const file = path.join(root, 'e2e', s + '.mjs');
  let src = fs.readFileSync(file, 'utf8');
  const np = src.match(/await browser\.newPage\([^)]*\);/);
  const args = src.match(/args:\s*\[([^\]]*)\]/);
  if (!np || !args) {
    // 纯 Node 的套件（不启浏览器）不受这两个环境差异影响，跳过是对的
    const pureNode = !src.includes('puppeteer');
    console.log('  – ' + s.padEnd(20) + (pureNode ? '纯 Node，不启浏览器 → 不受这两个差异影响' : '有浏览器但没找到可注入的启动参数（自己看一眼）'));
    skipped++; continue;
  }
  src = src.replace(np[0], () => np[0] + spoofLang);
  src = src.replace(args[0], () => args[0].replace(']', ", '--force-prefers-reduced-motion']"));
  const copy = path.join(root, 'e2e', 'cipre-' + s + '.mjs');
  fs.writeFileSync(copy, src, 'utf8');
  made.push(copy);
  let out = '', code = 0;
  try {
    out = execSync('node "' + copy + '"', { cwd: root, encoding: 'utf8', timeout: 300000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    out = String((e && e.stdout) || '') + String((e && e.stderr) || '');
    code = (e && e.status) || 1;
  }
  const m = out.match(/通过\s+(\d+)\s*[\/项][^0-9]*失败\s+(\d+)/);
  const nFail = m ? Number(m[2]) : (code === 0 ? 0 : 1);
  const nPass = m ? Number(m[1]) : 0;
  if (nFail === 0 && code === 0) { pass++; console.log('  ✓ ' + s.padEnd(20) + (m ? '通过 ' + nPass + ' / 失败 0' : '(无汇总) 退出码 0')); }
  else {
    fail++;
    console.log('  ✗ ' + s.padEnd(20) + (m ? '通过 ' + nPass + ' / 失败 ' + nFail : '退出码 ' + code));
    const fails = out.split('\n').filter(l => l.includes('FAIL')).slice(0, 4);
    fails.forEach(l => console.log('      ' + l.trim()));
  }
}
for (const f of made) { try { fs.unlinkSync(f); } catch (e) { /* 忽略 */ } }
console.log('\n结果：通过 ' + pass + ' / 失败 ' + fail + ' / 跳过 ' + skipped + (lintBad ? '（静态检查还有 ' + lintBad + ' 项）' : ''));
process.exit(fail || lintBad ? 1 : 0);
