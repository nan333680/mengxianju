// tools/ci-check.mjs —— CI 的第一步：Web 资源必须"能解析"。
//
// 为什么不直接拿 tsc 的退出码卡：
//   这是 JS 项目，app.js 有三百多处 DOM 相关的类型推断噪音（见 app.js 里 $ 的说明），
//   目前稳定在 30 条上下、全部是 Element/动态键那一类，不是真错误。
//   拿它当闸门 = CI 永远红，等于没有 CI。
//
// 所以这里只认【语法错】（TS1xxx：括号没配平、字符串没闭合这种）。
// 语法错一条都不许有；类型噪音只报数、不拦，并和基线比一比 ——
// 数量突然涨了会打一行警告出来，让人看得见。
//
// 用法：node tools/ci-check.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const BASELINE = 28;   // 已知的类型噪音条数（全是 Element / 动态键那一类）。涨了就提醒，但不拦。

function run(cmd, args, opts) {
  try {
    return { code: 0, out: execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }) };
  } catch (e) {
    return { code: e.status == null ? 1 : e.status, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}

console.log('== 1. tsc（只看语法错）==');
// Windows 上 .cmd 必须经 cmd /c 起（execFile 直接起 .cmd 会 EINVAL）；
// 用 cmd /c 而不是 shell:true，是为了避开 Node 那条「参数不转义」的弃用警告。
const r = process.platform === 'win32'
  ? run('cmd', ['/c', 'npx.cmd', 'tsc'], { cwd: ROOT })
  : run('npx', ['tsc'], { cwd: ROOT });
const lines = r.out.split(/\r?\n/).filter(l => l.includes('error TS'));
const syntax = lines.filter(l => /error TS1\d\d\d:/.test(l));
const other = lines.length - syntax.length;
console.log('   错误总数 ' + lines.length + '（语法 ' + syntax.length + ' / 其余 ' + other + '）');
if (syntax.length) {
  console.log('   ✗ 有语法错，必须修：');
  for (const l of syntax.slice(0, 20)) console.log('     ' + l);
  process.exit(1);
}
console.log('   ✓ 没有语法错');
if (other > BASELINE) {
  console.log('   ⚠ 类型噪音 ' + other + ' 条，比基线 ' + BASELINE + ' 多了 ' + (other - BASELINE) + ' 条 —— 看一眼是不是新引入的');
}

console.log('== 2. www 里的 js 都得在（app 少一个文件就整个白屏）==');
const need = ['app.js', 'api.js', 'db.js', 'persona.js', 'presets.js', 'charcard.js', 'ccv3.js',
  'stchat.js', 'stregex.js', 'autobackup.js', 'exportmd.js', 'i18n.js', 'storyarc.js', 'memory.js',
  'cliche.js', 'deflavor.js', 'psyche.js', 'director.js',
  // ⚠️ 新模块必须进这个清单（v0.5.6）：少了它 ci-check 不会报，
  //    App 白屏了才知道 —— 这份列表是硬编码的，加文件的人得自己记得补。
  'memaudit.js', 'mempick.js', 'innerthought.js', 'cadence.js', 'scenectx.js', 'reflect.js', 'theme.js'];
const miss = need.filter(f => !fs.existsSync(path.join(ROOT, 'www/js', f)));
if (miss.length) { console.log('   ✗ 少了：' + miss.join(', ')); process.exit(1); }
console.log('   ✓ ' + need.length + ' 个都在');

console.log('== 3. 版本号三方一致（web 兜底 / android 名 / package.json）==');
const appSrc = fs.readFileSync(path.join(ROOT, 'www/js/app.js'), 'utf8');
const webV = (appSrc.match(/WEB_VERSION_FALLBACK\s*=\s*'([^']+)'/) || [])[1];
const gradle = fs.readFileSync(path.join(ROOT, 'android/app/build.gradle'), 'utf8');
const gradleV = (gradle.match(/versionName\s+"([^"]+)"/) || [])[1];
const pkgV = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
console.log('   web=' + webV + '  android=' + gradleV + '  package=' + pkgV);
if (!webV || webV !== gradleV) { console.log('   ✗ web 兜底版本号和 android versionName 对不上'); process.exit(1); }
if (pkgV !== webV) console.log('   ⚠ package.json 的版本号和上面两个不一样（它只被打包脚本抄一次，不影响 App）');
console.log('   ✓ 一致');

console.log('');

console.log('== 4. i18n 里没有重复 key（JS 对象重复 key 不报错，后者静默覆盖前者）==');
// ⚠️ 加这条的原因（v0.5.6）：这一版自己在 BY_ZH 里撞了一次 '先选一个角色'，
//    而 tsc 只查语法、ci-check 其余三步也不看这个 —— 重复 key 在 JS 里是
//    【合法】的，后者静默覆盖前者，中文界面永远看不出问题，等有人翻英文才发现某句是错的。
{
  const src = fs.readFileSync(path.join(ROOT, 'www/js/i18n.js'), 'utf8');
  const lines = src.split('\n');
  const dups = [];
  // 按「顶层 const X = {」到「^};」切段。不用括号深度计数 ——
  // 第一版就是栽在这上面：把整个文件算成一个对象，于是跨对象的同名 key 全报成重复。
  let cur = null;
  let startLine = 0;
  let seen = null;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (!cur) {
      const open = ln.match(/^const\s+([A-Za-z_$][\w$]*)\s*=\s*\{/);
      if (open) {
        cur = open[1]; startLine = i + 1; seen = new Map();
        // ⚠️ 单行对象（i18n.js:72 的 `const MAP = { en: EN };`）在这一行就闭合了，
        //    没有单独的 `^};` 结尾 —— 不认这个的话，下一个对象（EXTRA_ZH，82-538 行）
        //    整段都会被算成 MAP 的块：重复还能抓到，但报错会写「MAP 里的 X」，
        //    照着名字去找会找错地方。
        if (/\}\s*;?\s*$/.test(ln)) {
          for (const mm of ln.matchAll(/(['"])((?:\\.|(?!\1).)*)\1\s*:/g)) {
            const kk = mm[2];
            if (seen.has(kk)) dups.push(open[1] + ' 里的「' + kk + '」（同一行内重复）');
            else seen.set(kk, i + 1);
          }
          cur = null;
        }
      }
      continue;
    }
    if (/^\};/.test(ln)) { cur = null; continue; }         // 这一块结束
    // 只认「缩进 + 引号 key + 冒号」这种行首键
    const m = ln.match(/^\s*(['"])((?:\\.|(?!\1).)*)\1\s*:/);
    if (!m) continue;
    const k = m[2];
    if (seen.has(k)) dups.push(cur + ' 里的「' + k + '」（第 ' + seen.get(k) + ' 行和第 ' + (i + 1) + ' 行）');
    else seen.set(k, i + 1);
  }
  if (dups.length) {
    console.log('   ✗ 有重复 key（后一条会静默覆盖前一条）：');
    for (const d of dups.slice(0, 20)) console.log('     ' + d);
    process.exit(1);
  }
  console.log('   ✓ 没有重复');
}

console.log('== 5. CHANGELOG 的更新说明块不越界（发版脚本按节切片，切错了会静默拿上一版的说明）==');
{
  // ⚠️ 加这条的原因（0.5.8.1 轮）：publish-version.ps1 / build-apk.ps1 原来从本节标题
  //    一直截到【文件末尾】再找 <!-- release-notes -->，于是本节没写标记时，
  //    会抓到后面某一节的块 —— 弹窗里显示成上一版的说明，而且不报任何错。
  //    这里用同一套切法复刻一遍，锁住「哪个版本拿到哪份说明」。
  //    ⚠️ 以后改那两个 ps1 的提取逻辑，这一段要同步改。
  const escapeRe = s => s.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  const cl = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  const vers = [...cl.matchAll(/^###\s*([0-9][0-9.]*)\s*（/gm)].map(m => m[1]);
  const notesOf = ver => {
    const head = new RegExp('###\\s*' + escapeRe(ver) + '\\s*（').exec(cl);
    if (!head) return null;
    const after = cl.slice(head.index + head[0].length);
    const next = /^###\s/m.exec(after);
    const rest = next ? after.slice(0, next.index) : after;
    const rn = /<!--\s*release-notes\s*-->\s*([\s\S]*?)\s*<!--\s*\/release-notes\s*-->/.exec(rest);
    if (rn) return { text: rn[1].replace(/<!--[\s\S]*?-->/g, '').trim(), block: true };
    const hm = new RegExp('###\\s*' + escapeRe(ver) + '\\s*（([^）]*)）').exec(cl);
    return { text: hm ? hm[1].replace(/^versionCode\s+\d+\s*·\s*/, '').trim() : '', block: false };
  };
  const problems = [];
  if (vers.length < 2) problems.push('CHANGELOG 里能认出来的版本节少于两个，这条检查没意义了');
  const v0 = vers[0];
  const v1 = vers[1];
  const n0 = v0 ? notesOf(v0) : null;
  const n1 = v1 ? notesOf(v1) : null;
  if (!n0 || !n0.text) problems.push('最新一节 v' + v0 + ' 抓不到任何说明（块和标题括号都是空的？）');
  if (!n1 || !n1.text) problems.push('上一节 v' + v1 + ' 抓不到任何说明');
  // ⚠️ 只有「本节没写块 + 上一节写了块 + 两者文本一模一样」才是越界。
  //    两节都没写块时会一起回退到标题括号，剥掉 versionCode 后只剩「测试版，未进 version.json」
  //    这一句，两节当然相同 —— 那不是越界，是四位数测试版的正常形态（0.5.8.1 / 0.5.8.2 都这样）。
  //    这一条是 0.5.8.2 轮补的：原来的 n0 === n1 会把「都没写块」判成越界，假红。
  if (n0 && n1 && n0.text === n1.text && !n0.block && n1.block) {
    problems.push('v' + v0 + ' 和 v' + v1 + ' 抓到同一份说明 —— v' + v0 + ' 自己没有块，脚本越界抓了 v' + v1 + ' 的');
  }
  if (problems.length) {
    console.log('   ✗ ' + problems.join('；'));
    process.exit(1);
  }
  const tag = n => (n.block ? '块' : '回退标题括号');
  console.log('   ✓ v' + v0 + ' → ' + tag(n0) + ' ' + n0.text.length + ' 字；v' + v1 + ' → ' + tag(n1) + ' ' + n1.text.length + ' 字（各自独立，没串到隔壁）');
}

console.log('');
console.log('== 6. 每套的汇总行都得能被判定正则认出来（认不出 = 白重试一次 + 计数漏掉）==');
// 起因（0.5.8.3）：e2e-viewmode 的 `===== ... 38 通过 / 1 失败 =====` 不在原来那三种
// 格式里。后果不是「少了个数字」—— 它的【真断言失败】被当成 puppeteer 崩溃、
// 白重试了一次（违反「断言失败绝不重试」），那 38 项也从总数里消失了。
// e2e-channel（54 项）、e2e-writer（31 项）一直在漏，只是它们一直绿，没人发现。
//
// 这里不跑套件：把每个 console.log 的字符串字面量按顺序拼起来，中间的表达式
// 一律当成数字 1，模拟出「它会打印的那一行」，再用同一组分正则对号。
// 格式爱怎么写怎么写，能对上号就行 —— 这比要求 173 套统一格式便宜得多。
// ⚠️ 三个已知边界（现在没有套件这么写；将来谁这么写，会【误报】成「汇总行对不上」）：
//   · 模板字符串：console.log(`通过 ${pass} / 失败 ${fail}`) —— 整段被当字面量，
//     ${pass} 原样留着，正则找不到数字；
//   · process.stdout.write(...) —— 不是 console.log，logExprs 根本抓不到；
//   · 汇总行里出现转义引号（'他说\'好\''）：/'[^']*'/ 会切错边界，
//     lits.shift() 按出现顺序塞回占位符的假设就不成立了。
//   真遇到这三条报错，先看它是不是没走 console.log，而不是去改正则。
const SUM_RE = [
  /pass=(\d+)\s+fail=(\d+)/,
  /通过\s+(\d+)\s*项[^0-9]*失败\s+(\d+)/,
  /通过\s+(\d+)\s*\/\s*失败\s+(\d+)/,
  /(\d+)\s*项?\s*通过\s*[\/／]\s*(\d+)\s*项?\s*失败/,
  /通过\s+(\d+)\s*项\s*[\/／]\s*失败\s+(\d+)\s*项?/,
];
// ⚠️ 上面五条必须和 tools/run-regression.ps1:70 起、.github/workflows/ci.yml 的
//    Test-HasSummary 保持一致 —— 那是两份独立实现，改一处不改另一处就是新坑。
function logExprs(src) {
  const out = []; const re = /console\.log\(/g; let m;
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length, depth = 1;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (c === "'" || c === '"' || c === '`') {
        const q = c; i++;
        while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++; }
      }
      i++;
    }
    out.push(src.slice(m.index + m[0].length, i - 1));
  }
  return out;
}
function simOf(expr) {
  const lits = [];
  let s = expr.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, m => { lits.push(m.slice(1, -1)); return '\u0001'; });
  // 占位符以外：空白丢掉（表达式里的空格不进输出），其余（变量、运算符）一律当数字
  s = s.split('').map(c => (c === '\u0001' ? c : (/\s/.test(c) ? '' : '#'))).join('');
  s = s.replace(/\u0001/g, () => (lits.length ? lits.shift() : ''));
  return s.replace(/#+/g, '1').replace(/\s+/g, ' ').trim();
}
{
  const e2eDir = path.join(ROOT, 'e2e');
  const files = fs.readdirSync(e2eDir).filter(n => n.startsWith('e2e-') && n.endsWith('.mjs'));
  const missing = [];
  let counted = 0;
  for (const f of files) {
    const src = fs.readFileSync(path.join(e2eDir, f), 'utf8');
    // 实况型（没有 pass++ / fail++，只打印过程）：本来就不该有汇总行，跳过
    if (!/fail\+\+|pass\+\+/.test(src)) continue;
    counted++;
    if (!logExprs(src).map(simOf).some(s => SUM_RE.some(r => r.test(s)))) missing.push(f);
  }
  if (missing.length) {
    console.log('   ✗ 这些套件有断言计数，但汇总行对不上任何一条判定规则：');
    missing.forEach(f => console.log('     - ' + f));
    console.log('   后果：它们的通过数不进总数，而且失败会被当成崩溃、白重试一次。');
    console.log('   改法：照现有五种格式之一写汇总行，或者给上面五条正则 + 两个 PowerShell 实现同时加规则。');
    process.exit(1);
  }
  console.log('   ✓ ' + counted + ' 套（另有 ' + (files.length - counted) + ' 套实况型/工具文件不要求汇总）都能对上号');
}

console.log('CI 静态检查通过');
