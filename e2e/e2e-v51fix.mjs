// v1.21.51 的静态验收 —— 把那些原来只能靠人肉解包看的东西钉成断言。
//
// 这些是"改了就出事、但跑别套件看不出来"的东西：
//   · 明文 HTTP 那三道拦截（config + manifest + xml 资源）各自都要在
//   · androidScheme 必须还是 https（改成 http 会换掉页面 origin，
//     localStorage / IndexedDB 全部对不上 = 老用户数据凭空消失）
//   · 头像 src 一律走 esc()（导入别人的备份时 avatar 是外来数据）
//   · 常驻世界书只能进稳定前缀，绝不能混进本轮段
import fs from 'fs';
import path from 'path';

const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');
let pass = 0, fail = 0;
const t = (n, ok, ex = '') => { if (ok) { pass++; console.log('  OK   ' + n); } else { fail++; console.log('  FAIL ' + n + (ex ? '  -> ' + ex : '')); } };
const readOr = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } };

console.log('=== 1. 明文 HTTP：三道拦截都要拆掉 ===');
const cfgRaw = readOr(R + '/capacitor.config.json');
const cfg = cfgRaw ? JSON.parse(cfgRaw) : null;
t('capacitor.config.json 读得到', !!cfg);
t('allowMixedContent 开了（https 页面发 http 请求要过 WebView 这一关）',
  !!cfg && cfg.android && cfg.android.allowMixedContent === true, cfg ? JSON.stringify(cfg.android) : '');
t('androidScheme 仍是 https（改了这个会丢用户数据，别动）',
  !!cfg && cfg.server && cfg.server.androidScheme === 'https', cfg ? JSON.stringify(cfg.server) : '');
const manifest = readOr(R + '/android/app/src/main/AndroidManifest.xml');
t('manifest 读得到', !!manifest);
t('application 上挂了 networkSecurityConfig',
  !!manifest && manifest.includes('android:networkSecurityConfig="@xml/network_security_config"'));
const nsc = readOr(R + '/android/app/src/main/res/xml/network_security_config.xml');
t('network_security_config.xml 在', !!nsc);
t('base-config 放行明文', !!nsc && nsc.includes('<base-config cleartextTrafficPermitted="true">'));

console.log('');
console.log('=== 2. 头像 src 一律转义 ===');
const appJs = readOr(R + '/www/js/app.js');
t('app.js 读得到', !!appJs);
// ⚠️ 正则要写成 <img ... src=，不能只认 <img src= ——
//    v1.21.51 第一遍就是这么漏的：消息气泡里那条是 `<img class="pic" src="${i}">`，
//    模式匹配不到，于是头像全修了、气泡里的图还漏着。
const rawSrc = appJs ? (appJs.match(/<img [^>]*src="\$\{(?!esc\()/g) || []).length : -1;
t('没有漏转义的 <img src>', rawSrc === 0, '漏了 ' + rawSrc + ' 处');
const escSrc = appJs ? (appJs.match(/<img [^>]*src="\$\{esc\(/g) || []).length : 0;
t('确实有若干处走了 esc（不是一条都没匹配到）', escSrc >= 6, escSrc + ' 处');
// 这几个属性位的值是【外来的】（导入的备份 / 角色卡里带的），必须转义。
// 其余没转义的属性位（菜单 key、预设 value、时段 key）都是代码里的常量，不在此列。
t('消息 id 已转义', !!appJs && !appJs.includes('data-id="${m.id}"'));
t('角色 id 已转义', !!appJs && !appJs.includes('data-id="${c.id}"') && !appJs.includes('data-edit="${c.id}"'));
t('时段范围的值已转义', !!appJs && !appJs.includes('value="${a}"') && !appJs.includes('value="${b}"'));
t('记忆分组用的是 CSS.escape（那是选择器不是 HTML）', !!appJs && appJs.includes('data-cid="${CSS.escape(cid)}"'));

console.log('');
console.log('=== 3. 常驻世界书只能进稳定前缀 ===');
// 混进本轮段 = 每轮改一次前缀 = 前缀缓存全废、token 翻十倍。
t('发送路径把常驻条目喂给 buildStablePrompt',
  !!appJs && appJs.includes('const wbConst = await worldbookConst(myCharId)') && appJs.includes('buildStablePrompt(myChar, P, wbConst)'));
t('worldbookHits 跳过 always 档（不然就同时进了两处）',
  !!appJs && appJs.includes("if (e.pos === 'always') continue;"));
t('稳定前缀里那段叫「基础设定」', (readOr(R + '/www/js/persona.js') || '').includes('# 基础设定'));
t('本轮段里那两档叫「相关设定」「临场设定」',
  (readOr(R + '/www/js/persona.js') || '').includes('# 相关设定')
  && (readOr(R + '/www/js/persona.js') || '').includes('# 临场设定'));

console.log('');
console.log('通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);