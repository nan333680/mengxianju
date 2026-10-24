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
  'cliche.js', 'deflavor.js'];
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
console.log('CI 静态检查通过');
