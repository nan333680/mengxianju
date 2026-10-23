// v0.5.1.6 的静态验收 —— 外部评审「六件止血事」各钉一条。
//
// 这一版一行界面都没改（除了剧情卡的 placeholder），改的全是【数据怎么流转】：
// 总结/归档读哪条线、切支会不会把归档消息落下、备份丢不丢分支叶子、
// 外壳收不收、被截断还续不续、续写算不算一轮、记忆写入是不是原子的。
// 这些东西在界面上看不出来，坏了也不报错，只能靠断言钉住。
import fs from 'fs';
import path from 'path';

const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');
let pass = 0, fail = 0;
const t = (n, ok, ex = '') => { if (ok) { pass++; console.log('  OK   ' + n); } else { fail++; console.log('  FAIL ' + n + (ex ? '  -> ' + ex : '')); } };
const readOr = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } };
const appJs = readOr(R + '/www/js/app.js') || '';
const dbJs = readOr(R + '/www/js/db.js') || '';
const css = readOr(R + '/www/css/style.css') || '';
const html = readOr(R + '/www/index.html') || '';

/** 粗取一个函数体：从签名往后切 n 个字符。够用，不必真解析。 */
const bodyOf = (src, sig, n = 2600) => {
  const i = src.indexOf(sig);
  return i < 0 ? '' : src.slice(i, i + n);
};

console.log('=== 1. 总结 / 归档读的是【活动分支】，且含归档 ===');
t('app.js 读得到', !!appJs);
t('新增了 curMsgsAll（含归档的活动路径）', /async function curMsgsAll\s*\(/.test(appJs));
const cma = bodyOf(appJs, 'async function curMsgsAll', 600);
t('它先取全量（含归档）', cma.includes('msgs.list(charId, 0, true)'), cma.slice(0, 200));
t('再按活动路径筛', cma.includes('activePath(charId, all)'), cma.slice(0, 200));
const sumIf = bodyOf(appJs, 'async function summarizeIfNeeded', 4000);
t('★ 总结走 curMsgsAll（以前读全量，旁支的内容也被算进摘要）',
  sumIf.includes('curMsgsAll('), sumIf.slice(0, 200));
const archNow = bodyOf(appJs, 'async function runArchiveNow', 4000);
t('★ 归档走 curMsgsAll', archNow.includes('curMsgsAll('), archNow.slice(0, 200));
t('归档只收未归档的老消息（旁支一条不碰）', archNow.includes('!m.archived'), '');

console.log('');
console.log('=== 2. 切分支不会把归档消息落下 ===');
const sw = bodyOf(appJs, 'async function switchBranch', 3000);
t('★ 切支读全量（含归档）', sw.includes('msgs.list(curCharId, 0, true)'), sw.slice(0, 240));
// v0.5.3.1 把 switchBranch 拆成「内核 gotoBranch + 薄壳」，放回归档那段搬进了内核 ——
// 断言跟着查内核，否则拆一次就红一次。
const gb = bodyOf(appJs, 'async function gotoBranch', 3500);
t('★ 切过去先把它那条线的归档放回来',
  gb.includes('unarchiveOne'), gb.slice(0, 200));
t('放回来的是【这条支上的】归档（不是全部）',
  gb.includes('pathTo(all, leaf)') && gb.includes('.archived'), '');
t('离开这条线时把临时放回的再收回去（v0.5.1.7）',
  gb.includes('putUnarchSet') && gb.includes('msgs.archive(back)'), '');

console.log('');
console.log('=== 3. 备份带上分支叶子 ===');
const bp = bodyOf(appJs, 'const BACKUP_KV_PREFIXES', 900);
t("★ 备份前缀含 'branch:'（丢了它 = 备份恢复后所有消息都看不见）",
  bp.includes("'branch:'"), bp.slice(0, 300));
t('清聊天时也清叶子（branch 跟着走，不是白名单）',
  bodyOf(appJs, 'const WIPE_CHAT_PREFIXES', 300).includes("'arc:'"), '');
t('合并导入后切到导入末端（否则新消息全在旁支上）',
  appJs.includes('tipTs > curTs') && appJs.includes('setLeaf(cid,'), '');

console.log('');
console.log('=== 4. 阅读模式收起外壳 ===');
t('setReading 切 reading-shell', appJs.includes("classList.toggle('reading-shell', _reading)"));
t('★ CSS 收起顶栏 / 输入栏 / 群名单',
  /#view-chat\.reading-shell \.topbar/.test(css) &&
  /#view-chat\.reading-shell \.composer/.test(css) &&
  /#view-chat\.reading-shell \.group-roster/.test(css), '');
t('阅读条自己让出状态栏（否则「退出」被刘海吃掉）',
  /#view-chat\.reading-shell \.read-bar\{[^}]*--sat/.test(css.replace(/\s+/g, ' ')), '');

console.log('');
console.log('=== 5. 被 max_tokens 截断就【不】自动续写 ===');
const chain = bodyOf(appJs, 'const canChain', 400);
t('★ 续写条件排除了 length 截断',
  chain.includes("finishReason !== 'length'"), chain.slice(0, 200));
t('群聊自动串联用它', appJs.includes('if (canChain && isGroup(myChar))'));
t('单聊自动串联用它', appJs.includes('} else if (canChain && !isGroup(myChar)'));

console.log('');
console.log('=== 6. 「继续」也算一轮（minTurns 不被假数字骗） ===');
t('★ bumpArcTurns 只在 regen 时跳过',
  appJs.includes('if (!(opts && opts.regen)) await bumpArcTurns(myCharId);'), '');
t('旧条件（!regen && !cont）已经不在',
  !appJs.includes('if (!(opts && opts.regen) && !cont) await bumpArcTurns'), '');

console.log('');
console.log('=== 7. 记忆写入是单事务（不会写到一半丢掉） ===');
// ⚠️ 不能用 bodyOf('async add(m) {') —— messages 那边也有一个同名签名，
//    indexOf 会命中前一个，断言就变成了在测消息表。
//    这里靠「签名后面紧跟 normalizeMemory」认人，取最后一处匹配。
const _addRe = /async add\(m\) \{[\s\S]{0,400}?normalizeMemory\(/g;
let _hit, _addAt = -1;
while ((_hit = _addRe.exec(dbJs))) _addAt = _hit.index;
const memAdd = _addAt < 0 ? '' : dbJs.slice(_addAt, _addAt + 2600);
t('mem.add 读得到', memAdd.length > 200, String(memAdd.length));
t('★ 读旧条 / 标旧条 / 写新条都在同一个 readwrite 事务里',
  memAdd.includes("db.transaction('memories', 'readwrite')") &&
  memAdd.includes("st.index('charId').getAll(rec.charId)"), '');
t('不再有「先 await 提交一次、再另起一个事务」',
  !memAdd.includes("req2p(db.transaction('memories')"), '');
t('事务回调里没有 await（会跳出事件循环、事务提前提交）',
  !/rq\.onsuccess = async/.test(memAdd), '');

console.log('');
console.log('=== 8. 剧情卡的输入提示是【解释作用】，不是某个人的场景 ===');
t('不再出现「红蓝的旧物」', !html.includes('红蓝的旧物'));
t('不再出现「从互相试探到摊牌」', !html.includes('从互相试探到摊牌'));
t('不再出现「不无故和解」', !html.includes('不无故和解'));
const ph = (id) => {
  const m = html.match(new RegExp('id="' + id + '"[^>]*placeholder="([^"]*)"'));
  return m ? m[1] : '';
};
const ph1 = ph('arc-title'), ph2 = ph('arc-direction'), ph3 = ph('arc-constraints');
t('段名提示写的是「只有你自己看」', ph1.includes('自己'), ph1);
t('方向提示说的是「最后要走到哪儿」', ph2.includes('走到哪儿'), ph2);
t('约束提示说的是「你最不想看到什么」', ph3.includes('不想'), ph3);
t('三条都配了英文 placeholder（data-i18n-en-ph）',
  (html.match(/data-i18n-en-ph="[^"]+"/g) || []).length >= 3, '');

console.log('');
console.log('========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail > 0 ? 1 : 0);
