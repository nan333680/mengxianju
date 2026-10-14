// tools/release-check.mjs —— 发布前/发布后自检（v0.4.1 加）
//
// 起因：v0.4.1 发布后才发现 tag 还钉在旧 commit 上（tag -> d379b16 versionCode 129，
// 而上传的 APK 是 7a25615 的 versionCode 130）——「下载到的包」和「checkout tag 拿到的源码」
// 不是同一个东西。这类错不会报错、不会红 CI，只能靠一条明确的检查拦住。
//
// 查四件事（全部只看事实，不看心情）：
//   ① 四处版本号一致（package.json / 锁文件根包 / build.gradle / app.js 兜底）
//   ② tag v<版本> 正好指向 HEAD，且工作区干净 —— 否则 checkout tag 拿到的源码 ≠ 发布源码
//   ③ 桌面上那个交付包存在，且它的 Android 版本名/版本号和 ① 对得上
//   ④ 包里的 assets/public 与工作区的 www【逐字节相同】—— 这一条才是"包就是这份源码"
//
// 用法：node tools/release-check.mjs [版本]      （默认取 package.json 的版本）
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import os from 'os';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const pkg = JSON.parse(read('package.json'));
const version = process.argv[2] || pkg.version;
let bad = 0;
const ok = (n, cond, extra = '') => { console.log((cond ? '  ✓ ' : '  ✗ ') + n + (extra ? '  [' + extra + ']' : '')); if (!cond) bad++; };

console.log('版本：' + version);
// ① 四处一致
const lock = JSON.parse(read('package-lock.json'));
const gradle = read('android/app/build.gradle');
const appjs = read('www/js/app.js');
const gName = (gradle.match(/versionName\s+"([^"]+)"/) || [])[1];
const gCode = (gradle.match(/versionCode\s+(\d+)/) || [])[1];
const webName = (appjs.match(/WEB_VERSION_FALLBACK\s*=\s*'([^']+)'/) || [])[1];
ok('package.json = ' + version, pkg.version === version, pkg.version);
ok('锁文件根包两处一致', lock.version === version && lock.packages[''].version === version, lock.version + ' / ' + lock.packages[''].version);
ok('build.gradle versionName 一致', gName === version, gName + ' (versionCode ' + gCode + ')');
ok('app.js 兜底一致', webName === version, webName);

// ② tag + 工作区
const git = (args) => execFileSync('git', args, { cwd: root }).toString().trim();
const head = git(['rev-parse', 'HEAD']);
const dirty = git(['status', '--porcelain']);
let tagSha = '';
try { tagSha = git(['rev-list', '-n1', 'v' + version]); } catch (e) { /* 没有这个 tag */ }
ok('tag v' + version + ' 存在', !!tagSha);
ok('tag 正好指向 HEAD', !!tagSha && tagSha === head, 'tag ' + tagSha.slice(0, 7) + ' / HEAD ' + head.slice(0, 7));
ok('工作区干净（checkout 出来的才是发布源码）', dirty === '', dirty ? '有未提交改动' : 'clean');

// ③ 桌面交付包
const desk = path.join(os.homedir(), 'Desktop', 'mxj', '梦弦居-v' + version + '.apk');
ok('桌面交付包存在 ' + desk, fs.existsSync(desk));
if (fs.existsSync(desk)) {
  const sha = crypto.createHash('sha256').update(fs.readFileSync(desk)).digest('hex');
  console.log('     sha256 ' + sha + '  ' + fs.statSync(desk).size + ' 字节');
  // 版本名从包里读（用 aapt2，路径跟 local.env 一致）
  const sdk = process.env.ANDROID_HOME || 'C:\\AAA-DSH\\Android\\sdk';
  const aapt2 = path.join(sdk, 'build-tools', '36.0.0', 'aapt2.exe');
  if (fs.existsSync(aapt2)) {
    const out = execFileSync(aapt2, ['dump', 'badging', desk]).toString();
    const m = out.match(/versionCode='(\d+)'\s+versionName='([^']+)'/);
    ok('包里的 versionName 一致', !!m && m[2] === version, m ? m[2] : '读不到');
    ok('包里的 versionCode 与 gradle 一致', !!m && m[1] === gCode, m ? m[1] + ' vs ' + gCode : '读不到');
  } else {
    console.log('  – 找不到 aapt2，跳过包内版本名校验（' + aapt2 + '）');
  }

  // ④ 包里的 www 与工作区逐字节比
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mxj-relcheck-'));
  try {
    execFileSync('tar', ['-xf', desk, '-C', tmpDir, 'assets/public'], { stdio: 'ignore' });
    const inside = path.join(tmpDir, 'assets', 'public');
    const walk = (dir, base = '') => {
      const out = [];
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = base ? base + '/' + e.name : e.name;
        if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), rel));
        else out.push(rel);
      }
      return out;
    };
    const shaOf = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    const src = walk(path.join(root, 'www'));
    const inApk = walk(inside);
    const missing = src.filter(f => !inApk.includes(f));
    const differ = src.filter(f => inApk.includes(f) && shaOf(path.join(root, 'www', f)) !== shaOf(path.join(inside, f)));
    ok('包里的 assets/public 就是这份 www（逐字节）', missing.length === 0 && differ.length === 0,
      '缺 ' + missing.length + ' 个 / 不一样 ' + differ.length + ' 个');
    const extra = inApk.filter(f => !src.includes(f));
    if (extra.length) console.log('     （包里多出来的，Capacitor 自带：' + extra.join('、') + '）');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

console.log(bad === 0 ? '\n✓ 发布自检通过' : '\n✗ 发布自检没过（' + bad + ' 项）');
process.exit(bad ? 1 : 0);
