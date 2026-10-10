// v1.21.47：「他的设定 / 他的居处」从全局搬到角色级 + 覆盖给其他角色
//          + 临时场景 + 角色卡带上我们自己的私有参数。
//
// 覆盖：
//   1. 设置页里那两块【没了】，角色编辑页里【有了】
//   2. prompt 取角色级的那一份（角色没设才回落全局）
//   3. 保存写进角色自己的字段
//   4. 「应用到其他角色」：列出别人、全选/全不选、批量写
//   5. 临时场景：顶部入口 → 小窗 → 保存并应用 → 落库 → 进本轮段（不进稳定前缀）
//   6. 角色卡 extensions 带【角色自己的】参数，能原样读回；老卡不炸。
//      ⚠️ v1.21.52 起 myProfile / myEnv / scene 不进卡（是你自己的私事，卡会分享出去）
//   7. 老数据迁移：全局那份复制给还没有这个字段的角色，只做一次
import puppeteer from 'puppeteer-core';
import { seedChar } from './e2e-helper.mjs';
import http from 'http'; import fs from 'node:fs'; import path from 'node:path';
const R = path.resolve(import.meta.dirname).split(path.sep).join('/');
const WWW = R + '/www';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8' };
const server = http.createServer((req,res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p==='/') p='/index.html';
  const f = path.join(WWW, p);
  if (!fs.existsSync(f)) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f));
});
await new Promise(r => server.listen(0,'127.0.0.1',r));
const port = server.address().port;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 180000, args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = []; page.on('pageerror', e => errs.push(e.message));
page.on('dialog', async d => { await d.accept(); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const t = (n, ok, ex) => { if (ok) { pass++; console.log('  OK   ' + n); } else { fail++; console.log('  FAIL ' + n + (ex !== undefined ? '  -> ' + ex : '')); } };
const jsClick = s => page.evaluate(x => { const e = document.querySelector(x); if (e) e.click(); }, s);
const openSettings = async () => {
  for (let i = 0; i < 6; i++) {
    const cur = await page.evaluate(() => (document.querySelector('.view.active') || {}).id);
    if (cur === 'view-chat') break;
    await page.evaluate(() => {
      const b = document.getElementById('btn-edit-back') || document.getElementById('btn-chars-back')
             || document.getElementById('btn-set-back') || document.getElementById('btn-drawer-close');
      if (b) b.click();
    });
    await sleep(400);
  }
  await jsClick('#btn-settings'); await sleep(700);
  await page.evaluate(() => { const b = [...document.querySelectorAll('#drawer-menu [data-wb-drawer]')].find(x => x.dataset.wbDrawer === 'settings'); if (b) b.click(); });
  await sleep(800);
};
const toChat = async () => {
  for (let i = 0; i < 6; i++) {
    const cur = await page.evaluate(() => (document.querySelector('.view.active') || {}).id);
    if (cur === 'view-chat') return;
    await page.evaluate(() => {
      const b = document.getElementById('btn-edit-back') || document.getElementById('btn-chars-back')
             || document.getElementById('btn-set-back') || document.getElementById('btn-drawer-close');
      if (b) b.click();
    });
    await sleep(400);
  }
};
const openEdit = async () => { await toChat(); await jsClick('#chat-titletxt'); await sleep(800); };

await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
await sleep(1300);
// v1.21.59：全新安装不再自动建角色（产品改空），测试自己塞一个
await seedChar(page, '测试角色', { greeting: '' });   // 空开场白：不额外多出一条消息
await page.reload({waitUntil:'networkidle0'}); await new Promise(r=>setTimeout(r,900));
// 全新库：indexedDB 在 headless 里本来就是空的，这里只确保现实模式关掉（免得时钟条只读）
await page.evaluate(async () => {
  const { kv } = await import('/js/db.js');
  const s = Object.assign({}, await kv.get('settings', {}), { clockMode: false });
  await kv.set('settings', s);
});
await page.reload({ waitUntil:'networkidle0' }); await sleep(1200);

console.log('=== 1. 设置页里那两块没了 ===');
await openSettings();
t('设置页不再有「我的相关设定」', !(await page.$('#mine-fold')));
t('设置页不再有「她该怎么理解你」输入框', !(await page.$('#s-profile')));
t('设置页不再有「我居住的环境」输入框', !(await page.$('#s-env')));

console.log('');
console.log('=== 2. 角色编辑页有了 ===');
await openEdit();
t('有「他的设定」折叠头', !!(await page.$('#e-mine-fold')));
t('有「他的居处」折叠头', !!(await page.$('#e-home-fold')));
t('有设定输入框', !!(await page.$('#e-mine')));
t('有居处输入框', !!(await page.$('#e-home')));
const dv = await page.$eval('#e-mine', el => el.value);
t('默认带着出厂那份「他的设定」', dv.length > 100, '长度=' + dv.length);
const brief0 = await page.$eval('#e-mine-brief', el => el.textContent);
t('折叠头上写着行数', /\d+\s*行/.test(brief0), brief0);
await jsClick('#e-mine-fold'); await sleep(500);
t('点开能展开', !!(await page.$('#e-mine-wrap.open')));

console.log('');
console.log('=== 3. prompt 取角色级的那一份 ===');
const pp = await page.evaluate(async () => {
  const { buildStablePrompt } = await import('/js/persona.js');
  const base = { verbosity:'medium', descLevel:'mid' };
  const a = buildStablePrompt({ persona:'A', myProfile:'甲专属的理解' }, { ...base, myProfile:'全局那份' });
  const b = buildStablePrompt({ persona:'B' }, { ...base, myProfile:'全局那份' });
  const c = buildStablePrompt({ persona:'C', myProfile:'' }, { ...base, myProfile:'全局那份' });
  return { aOwn: a.includes('甲专属的理解'), aGlob: a.includes('全局那份'),
           bGlob: b.includes('全局那份'), cGlob: c.includes('全局那份') };
});
t('角色自己那份生效', pp.aOwn && !pp.aGlob);
t('角色没设过 → 回落全局', pp.bGlob);
t('角色明确留空 → 不回落（# 关于对方 整段不出现）', !pp.cGlob);

console.log('');
console.log('=== 4. 保存写进角色自己的字段 ===');
await page.evaluate(() => {
  const el = document.getElementById('e-mine');
  el.value = '甲专属的理解';
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
await jsClick('#btn-edit-save'); await sleep(900);
const saved = await page.evaluate(async () => {
  const { chars } = await import('/js/db.js');
  const all = await chars.all();
  const hit = all.find(c => c.myProfile === '甲专属的理解');
  return { n: all.length, hit: !!hit, id: hit && hit.id };
});
t('落库到 char.myProfile', saved.hit, JSON.stringify({ n: saved.n }));
const meId = saved.id;

console.log('');
console.log('=== 5. 覆盖给其他角色 ===');
await page.evaluate(async () => {
  const { chars } = await import('/js/db.js');
  await chars.put({ id:'v47-b', name:'乙角色', persona:'乙', createdAt: Date.now(), myProfile:'乙自己的' });
});
await page.reload({ waitUntil:'networkidle0' }); await sleep(1300);
await openEdit();
await jsClick('#btn-e-mine-apply'); await sleep(600);
t('多选弹窗打开了', !(await page.$eval('#pick-chars-modal', el => el.classList.contains('hidden'))));
const listed = await page.$$eval('#pick-chars-list label', els => els.map(e => e.querySelector('.nm').textContent));
t('列出来的是"别的"角色（不含自己）', listed.length === 1 && listed[0] === '乙角色', JSON.stringify(listed));
t('默认全勾上', await page.$eval('#pick-chars-list input', el => el.checked));
const cntAll = await page.$eval('#pick-chars-count', el => el.textContent);
t('计数写对了', cntAll === '已选 1 / 1', cntAll);
await jsClick('#pick-chars-none'); await sleep(250);
t('「全不选」生效', (await page.$eval('#pick-chars-count', el => el.textContent)) === '已选 0 / 1');
await jsClick('#pick-chars-all'); await sleep(250);
await jsClick('#pick-chars-ok'); await sleep(900);
const applied = await page.evaluate(async () => {
  const { chars } = await import('/js/db.js');
  const c = await chars.get('v47-b');
  return c.myProfile;
});
t('对方的被这一份替掉了', applied === '甲专属的理解', String(applied));

console.log('');
console.log('=== 6. 临时场景 ===');
await toChat();
t('顶部有场景入口', !!(await page.$('#chat-scene')));
t('没场景时写着「场景」', (await page.$eval('#chat-scene', el => el.textContent)) === '场景');
await jsClick('#chat-scene'); await sleep(600);
t('场景弹窗打开', !(await page.$eval('#scene-modal', el => el.classList.contains('hidden'))));
const cur0 = await page.$eval('#scene-cur', el => el.textContent);
t('小字提醒当前场景（还没设）', /当前场景：无/.test(cur0), cur0);
await page.evaluate(() => { document.getElementById('scene-text').value = '祭典的夜里，街上人多'; });
await jsClick('#scene-save'); await sleep(900);
t('点保存并应用后弹窗关掉', await page.$eval('#scene-modal', el => el.classList.contains('hidden')));
const bar = await page.$eval('#chat-scene', el => el.textContent);
t('条上显示场景摘要', /场景 · 祭典的夜里/.test(bar), bar);
t('条亮起来了', await page.$eval('#chat-scene', el => el.classList.contains('on')));
const inDb = await page.evaluate(async () => {
  const { chars } = await import('/js/db.js');
  const all = await chars.all();
  const c = all.find(x => x.scene);
  return c ? { id: c.id, scene: c.scene } : null;
});
t('场景存在角色自己身上', !!inDb && inDb.scene === '祭典的夜里，街上人多', JSON.stringify(inDb));
t('存在的是当前这个角色', !!inDb && inDb.id === meId);
const tn = await page.evaluate(async () => {
  const { buildTurnNote } = await import('/js/persona.js');
  const withScene = buildTurnNote({ name:'甲' }, { longMemory:false, historyTime:false }, { scene:'祭典的夜里', clock:'第 1 天 晚上' });
  const without = buildTurnNote({ name:'甲' }, { longMemory:false, historyTime:false }, { scene:'', clock:'第 1 天 晚上' });
  return { has: withScene.includes('# 当前场景') && withScene.includes('祭典的夜里'),
           none: !without.includes('# 当前场景'),
           idxScene: withScene.indexOf('# 当前场景'), idxClock: withScene.indexOf('# 现在的时间') };
});
t('本轮段里带上了场景', tn.has);
t('没设场景时不写这一节', tn.none);
t('场景排在时间之前', tn.idxScene >= 0 && tn.idxClock > tn.idxScene, tn.idxScene + ' vs ' + tn.idxClock);
// 清除
await jsClick('#chat-scene'); await sleep(500);
await jsClick('#scene-clear'); await sleep(300);
const cur1 = await page.$eval('#scene-cur', el => el.textContent);
t('清除后输入框空了、小字回到"无"', (await page.$eval('#scene-text', el => el.value)) === '' && /当前场景：无/.test(cur1));
await jsClick('#scene-save'); await sleep(700);
const afterClear = await page.evaluate(async () => {
  const { chars } = await import('/js/db.js');
  const c = await chars.get('v47-b');
  const all = await chars.all();
  return all.some(x => x.scene);
});
t('保存空内容 = 场景被删掉', !afterClear);
const bar2 = await page.$eval('#chat-scene', el => el.textContent);
t('条回到「场景」', bar2 === '场景', bar2);

console.log('');
console.log('=== 7. 角色卡带上私有参数 ===');
// ⚠️ 走【真实导入链路】：buildCardV2 出卡 → JSON 文本 → parseCardJson（normalizeCard）
//    → readMkParams。少了中间那步就会漏掉"normalizeCard 把 extensions 丢了"这种坑
//    —— 第一版就是这么写的，断言直接炸在 undefined 上。
const card = await page.evaluate(async () => {
  const { buildCardV2, parseCardJson, readMkParams } = await import('/js/charcard.js');
  const c = { name:'甲', persona:'她是谁', greeting:'嗨', verbosity:'long', descLevel:'high',
              myProfile:'我的理解', myEnv:'我的居处', scene:'祭典' };
  const data = buildCardV2(c, []);
  const parsed = parseCardJson(JSON.stringify(data));
  return { ext: data.data.extensions, back: readMkParams(parsed), parsedHas: !!parsed.extensions };
});
t('卡里挂上了 extensions.mengxianju', !!(card.ext && card.ext.mengxianju && card.ext.mengxianju.params));
t('参数写进去了', card.ext.mengxianju.params.verbosity === 'long' && card.ext.mengxianju.params.descLevel === 'high');
// ⚠️ 这两项不进卡（v1.21.52）：myProfile / myEnv 是【你自己的】私事
//    （我是谁 / 我住哪），而卡是会被随手分享出去的东西。整机搬家走「导出全部数据」。
//    ⚠️ v1.21.53 起 scene 单独放行：它是【角色的】当前情境（c.scene），
//       和上面那两项不同类 —— 用户要的是"角色卡上的设置全同步"。
t('私人那两项不进卡',
  card.ext.mengxianju.params.myProfile === undefined
  && card.ext.mengxianju.params.myEnv === undefined,
  JSON.stringify(Object.keys(card.ext.mengxianju.params)));
t('临时场景进卡了', card.ext.mengxianju.params.scene === '祭典');
t('「立即生效」那一层也进卡了', card.ext.mengxianju.params.appearanceLive === undefined || typeof card.ext.mengxianju.params.appearanceLive === 'string');
t('解析时 extensions 没被丢掉', card.parsedHas);
t('角色自己的参数原样读回（走真实导入链路）',
  card.back.verbosity === 'long' && card.back.descLevel === 'high', JSON.stringify(card.back));
t('私人那两项读回来也没有', card.back.myEnv === undefined && card.back.myProfile === undefined);
t('临时场景读回来了', card.back.scene === '祭典');
t('标准字段没被动过', card.ext.mengxianju.params.name === undefined);
const oldCard = await page.evaluate(async () => (await import('/js/charcard.js')).readMkParams({ name:'别家导的卡', extensions:{} }));
t('老卡 / 别家的卡不炸，返回空对象', Object.keys(oldCard).length === 0);

console.log('');
console.log('=== 8. 老数据迁移（全局那份复制给角色，只做一次）===');
await page.evaluate(async () => {
  const { chars, kv } = await import('/js/db.js');
  await chars.put({ id:'v47-old', name:'老角色', persona:'老', createdAt: 1 });
  const s = Object.assign({}, await kv.get('settings', {}), { myProfile:'老全局那份', myEnv:'老居处', mkProfileMigrated: false });
  await kv.set('settings', s);
});
await page.reload({ waitUntil:'networkidle0' }); await sleep(1400);
const mig = await page.evaluate(async () => {
  const { chars, kv } = await import('/js/db.js');
  const c = await chars.get('v47-old');
  const s = await kv.get('settings', {});
  return { p: c.myProfile, e: c.myEnv, flag: !!s.mkProfileMigrated };
});
t('老角色拿到了全局那份', mig.p === '老全局那份' && mig.e === '老居处', JSON.stringify(mig));
t('迁移打完标记（只做一次）', mig.flag === true);
// 再改全局 → 不该影响已经迁过的角色
await page.evaluate(async () => {
  const { chars, kv } = await import('/js/db.js');
  const s = Object.assign({}, await kv.get('settings', {}), { myProfile:'第二版全局' });
  await kv.set('settings', s);
  await chars.put({ id:'v47-old2', name:'又一个老角色', persona:'老2', createdAt: 2 });
});
await page.reload({ waitUntil:'networkidle0' }); await sleep(1300);
const mig2 = await page.evaluate(async () => {
  const { chars } = await import('/js/db.js');
  return { old: (await chars.get('v47-old')).myProfile, fresh: (await chars.get('v47-old2')).myProfile };
});
t('已经迁过的不再被改', mig2.old === '老全局那份', mig2.old);
t('迁移只跑一次（新造的老角色不会被自动补）', mig2.fresh === undefined, String(mig2.fresh));

console.log('');
if (errs.length) console.log('  JS 错误: ' + JSON.stringify(errs.slice(0,3)));
t('全程无 JS 错误', errs.length === 0, errs.slice(0,2).join(' | '));
console.log('');
console.log('通过 ' + pass + ' / 失败 ' + fail);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
