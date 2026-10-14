// tools/bump-version.mjs —— 改版本号只走这一条路（v0.4.1 修）
//
// 为什么要有它：
//   v0.4.1.3 那次改版本号是拿字符串替换去改 package-lock.json 的，
//   结果把【第三方依赖】的版本号也改了 —— node_modules/webdriver-bidi-protocol
//   的真实版本是 0.4.3，被写成 0.4.1.3（非法 semver），npm ci 第一秒就
//   "Invalid Version: 0.4.1.3" 退出，CI 从 v0.4.1.3 起一路红到发布版，
//   而且本地跑回归完全看不出来（本地 node_modules 已经装好，没人再跑 npm ci）。
//
//   字符串替换在锁文件上是不安全的：锁文件里"版本号"这个形状的字段有一百多个，
//   其中只有【根包那两个】属于我们。所以这里只碰该碰的，并且碰完自己验一遍。
//
// 用法：
//   node tools/bump-version.mjs 0.4.2          改版本名（versionCode 不变）
//   node tools/bump-version.mjs 0.4.2 130      同时改 versionCode
//   node tools/bump-version.mjs --check        只检查四处是否一致（不写）
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = path.join(root, 'package.json');
const lockPath = path.join(root, 'package-lock.json');
const gradlePath = path.join(root, 'android', 'app', 'build.gradle');
const appPath = path.join(root, 'www', 'js', 'app.js');

const args = process.argv.slice(2);
const checkOnly = args[0] === '--check';
const version = checkOnly ? null : String(args[0] || '').trim();
const code = args[1] ? String(args[1]).trim() : null;

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
const gradle = fs.readFileSync(gradlePath, 'utf8');
const appjs = fs.readFileSync(appPath, 'utf8');

const gradleName = (gradle.match(/versionName\s+"([^"]+)"/) || [])[1];
const gradleCode = (gradle.match(/versionCode\s+(\d+)/) || [])[1];
const webFallback = (appjs.match(/WEB_VERSION_FALLBACK\s*=\s*'([^']+)'/) || [])[1];
const lockRoot = lock.packages && lock.packages[''] ? lock.packages[''].version : undefined;

const show = () => {
  console.log('  package.json        ' + pkg.version);
  console.log('  package-lock 根包    ' + lock.version + ' / packages[""] ' + lockRoot);
  console.log('  build.gradle        ' + gradleName + ' (versionCode ' + gradleCode + ')');
  console.log('  app.js WEB_ 兜底     ' + webFallback);
};

if (checkOnly) {
  console.log('当前四处：'); show();
  const ok = pkg.version === gradleName && pkg.version === webFallback
    && pkg.version === lock.version && pkg.version === lockRoot;
  console.log(ok ? '✓ 一致' : '✗ 不一致 —— 跑 node tools/bump-version.mjs <版本> 对齐');
  process.exit(ok ? 0 : 1);
}

if (!version) { console.log('用法：node tools/bump-version.mjs <版本> [versionCode]'); process.exit(2); }
if (!/^\d+\.\d+\.\d+(\.\d+)?$/.test(version)) { console.log('版本号形状不对：' + version); process.exit(2); }

// ① package.json
pkg.version = version;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');

// ② package-lock：只改【根包的两处】。依赖条目一个都不许碰 —— 上面那段注释就是为这个写的。
const depVersions = Object.entries(lock.packages || {})
  .filter(([k]) => k !== '')
  .map(([k, v]) => [k, v.version]);
lock.version = version;
if (lock.packages && lock.packages['']) lock.packages[''].version = version;
fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n', 'utf8');

// ③ build.gradle
let g = gradle.replace(/(versionName\s+)"[^"]+"/, '$1"' + version + '"');
if (code) g = g.replace(/(versionCode\s+)\d+/, '$1' + code);
fs.writeFileSync(gradlePath, g, 'utf8');

// ④ app.js 的 Web 兜底版本
if (webFallback) {
  // ⚠️ 分组必须【连标识符一起】捕获再放回去 —— 第一版只捕获了 = 号那一段，
  //    替换完变成 `const  = '0.4.1';`，标识符被吃掉了（ci-check 立刻报语法错，算它尽责）。
  fs.writeFileSync(appPath, appjs.replace(/(WEB_VERSION_FALLBACK\s*=\s*)'[^']+'/, "$1'" + version + "'"), 'utf8');
}

// 事后自检：形状对 + 四处一致 + 依赖版本一个没动
const after = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
const moved = Object.entries(after.packages || {})
  .filter(([k]) => k !== '')
  .filter(([k, v]) => {
    const before = depVersions.find(d => d[0] === k);
    return before && before[1] !== v.version;
  });
if (moved.length) {
  console.error('✗ 有依赖的版本被动了（这是绝不允许的）：' + JSON.stringify(moved));
  process.exit(1);
}
console.log('✓ 改好了：'); show();
try {
  execFileSync(process.execPath, [path.join(root, 'tools', 'ci-check.mjs')], { cwd: root, stdio: 'inherit' });
} catch (e) {
  console.error('✗ ci-check 没过，别打包');
  process.exit(1);
}
