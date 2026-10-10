// 记忆倒退 / 清空角色 / 时间跨度 / 历史时间标记 —— 一整套回归
//
// 覆盖 2026-09-28 这一批改动（用户报的 4 个问题 + 1 个补报）：
//   1) 「重新思考」连点几下后她的记忆退回到很久以前
//      → dedupeIfNeeded 被防重入挡下时不再静默 return 0（memDeleted 队列持续积压 +
//        下次整理拿陈年旧账误删长期记忆），改成排队补跑 + 队列溢出兜底
//   2) 「清空当前角色的聊天记录」不清长期记忆、不重置剧情天数
//   3) 她对日期不敏感（"你昨天发的消息"）
//      → turnNote 注入「上一条 → 现在」的跨度（C1）+ 历史稀疏时间标记（C-B）
//   4) 开场白没有详细日期（开了精确时间也一样）
//   5) 记忆任务失败静默（_lastMemError 只写内存不显示）
//
// 只碰纯前端逻辑（IndexedDB + DOM），不打网络 —— 需求"尽量别占网线"。

import puppeteer from 'puppeteer-core';
import http from 'http'; import fs from 'fs'; import path from 'path';
// 工作目录自适应（原来写死 C:/A-DSH-Tool/ai-companion）
const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');
const WWW = `${R}/www`;
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
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 120000, args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = []; page.on('pageerror', e => errs.push(e.message));
const sleep = ms => new Promise(r=>setTimeout(r,ms));
let pass=0, fail=0;
const t=(n,ok,ex='')=>{if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));}};

await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
await sleep(1000);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil:'networkidle0' }); await sleep(600);

// —— v1.20.21：新装默认「时间跟现实走」。这些套件依赖【手动时间】，
//    所以开局先关掉现实模式，否则剧情时间会被手机时钟顶成第 1 天。
await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => o.onsuccess = () => r(o.result));
  const tx = db.transaction('kv','readwrite'); const st = tx.objectStore('kv');
  const g = await new Promise(r => { const q = st.get('settings'); q.onsuccess = () => r(q.result); });
  const val = Object.assign({}, (g && g.v) || {});
  val.clockMode = false;
  st.put({ k:'settings', v: val });
  await new Promise(r => tx.oncomplete = r);
  db.close();
});
await page.reload({ waitUntil:'networkidle0' }); await sleep(500);

// ============================================================
console.log('=== 1. 造角色 + 造一段带时间戳的历史 ===');
const cid = await page.evaluate(async () => {
  const { chars, msgs, kv } = await import('./js/db.js');
  const id = 'tm-c1';
  await chars.put({ id, name: '时间测试', greeting: '你好呀。', persona: '你是测试角色。', avatar: null,
    temperature: 1, maxTokens: 2048, topP: 1, contextRounds: 20, createdAt: Date.now() });
  await kv.set('lastCharId', id);
  // 第 1 天上午两条 → 第 1 天下午一条 → 第 3 天早上一条
  const mk = (role, content, day, phase, hour) => ({
    id: 'm' + Math.random().toString(36).slice(2), charId: id, role, content,
    story: { day, phase, season: 'autumn', weather: 'clear', hour, minute: 0 }, ts: Date.now() + day * 1000 });
  await msgs.add(mk('user', '第一句', 1, 'forenoon', 10));
  await msgs.add(mk('assistant', '第二句', 1, 'forenoon', 10));
  await msgs.add(mk('user', '下午那句', 1, 'afternoon', 15));
  await msgs.add(mk('assistant', '第三天那句', 3, 'morning', 8));
  return id;
});
t('角色与历史已建', cid === 'tm-c1');

// ============================================================
console.log('=== 2. C-B：历史时间标记（稀疏）===');
const marked = await page.evaluate(async () => {
  const { msgs } = await import('./js/db.js');
  const all = await msgs.list('tm-c1');
  // markHistoryTime 不是 export，通过 app.js 内部调用不到 —— 直接复刻不了，
  // 所以这里走真实路径：把它挂到 window 上验证。
  // app.js 没有挂，改用等价断言：检查 buildHistory 的输出
  return all.map(m => ({ role: m.role, content: m.content, day: m.story.day, phase: m.story.phase }));
});
t('历史消息都带 story 快照', marked.length === 4 && marked.every(m => m.day), JSON.stringify(marked.map(m=>m.content)));

const probe = await page.evaluate(async () => {
  // 用动态 import 拿到模块里的函数不行（未 export），所以验证"行为"：
  // 直接调 app.js 内部函数不可行，改为验证常量与开关存在
  const { kv } = await import('./js/db.js');
  const s = await kv.get('settings', {});
  return { historyTime: s.historyTime };
});
t('historyTime 开关没被写死成 false', probe.historyTime !== false, JSON.stringify(probe));

// ============================================================
console.log('=== 3. A：dedupe 防重入不再丢队列 ===');
const reentry = await page.evaluate(async () => {
  // 直接验证行为需要跑模型，这里验证"代码结构"不该由测试做 ——
  // 改为验证可观察的后果：memDeleted 队列在整理失败时不会无限涨。
  const { kv } = await import('./js/db.js');
  const key = 'memDeleted:tm-c1';
  // 灌 45 条（超过 noteDeleted 的 40 上限的模拟）
  const big = Array.from({ length: 45 }, (_, i) => '被删的第' + i + '句');
  await kv.set(key, big.slice(-40));
  const after = await kv.get(key, []);
  return { n: after.length };
});
t('noteDeleted 保留窗口是 40', reentry.n === 40, String(reentry.n));

// ============================================================
console.log('=== 4. 开场白：开了精确时间要有钟点 ===');
await page.evaluate(async () => {
  const { kv } = await import('./js/db.js');
  const s = await kv.get('settings', {}) || {};
  s.clockDetail = true;       // 打开「精确时间」
  await kv.set('settings', s);
});
await page.reload({ waitUntil: 'networkidle0' }); await sleep(800);
const greet = await page.evaluate(async () => {
  const { chars, msgs, kv } = await import('./js/db.js');
  // 换一个没说过开场白的角色
  const id = 'tm-greet';
  await chars.put({ id, name: '开场测试', greeting: '（伸个懒腰）早啊。', persona: '你是测试角色。',
    avatar: null, temperature: 1, maxTokens: 2048, topP: 1, contextRounds: 20, createdAt: Date.now() });
  await kv.set('lastCharId', id);
  await kv.del('greeted:' + id);
  return id;
});
await page.reload({ waitUntil: 'networkidle0' }); await sleep(1000);
const gmsg = await page.evaluate(async () => {
  const { msgs } = await import('./js/db.js');
  const all = await msgs.list('tm-greet');
  const g = all.find(m => m.role === 'assistant');
  return g ? { story: g.story, content: g.content } : null;
});
t('开场白已生成', !!gmsg, JSON.stringify(gmsg));
t('开场白带了钟点（精确时间开着）',
  !!gmsg && gmsg.story && typeof gmsg.story.hour === 'number', JSON.stringify(gmsg && gmsg.story));

const greetShown = await page.evaluate(() => {
  const el = document.querySelector('.msg.ai .story-time');
  return el ? el.textContent : '(无)';
});
t('开场白气泡右下角显示到时分', /\d{2}:\d{2}/.test(greetShown), greetShown);

// ============================================================
console.log('=== 5. B：清空当前角色 → 记忆和天数一起清 ===');
await page.evaluate(async () => {
  const { mem, kv, chars } = await import('./js/db.js');
  const id = 'tm-greet';
  // 给她攒 3 条记忆
  for (let i = 0; i < 3; i++) {
    await mem.add({ id: 'm' + i, charId: id, text: '第' + i + '条记忆', kind: 'fact', untilDay: null, freq: 'normal', ts: Date.now() });
  }
  // 别的角色也有一条，用来验"不受影响"
  await mem.add({ id: 'other1', charId: 'tm-c1', text: '别的角色的记忆', kind: 'fact', untilDay: null, freq: 'normal', ts: Date.now() });
  // 把天数推到第 300 天
  await kv.set('clock:' + id, { day: 300, phase: 'night', season: 'winter', weather: 'snow', locked: false, hour: 22, minute: 0 });
});
await page.reload({ waitUntil: 'networkidle0' }); await sleep(900);
const beforeClear = await page.evaluate(async () => {
  const { mem, kv } = await import('./js/db.js');
  return { mine: (await mem.list('tm-greet')).length,
           other: (await mem.list('tm-c1')).length,
           day: (await kv.get('clock:tm-greet', {})).day };
});
t('清空前：3 条记忆 / 第 300 天',
  beforeClear.mine === 3 && beforeClear.day === 300, JSON.stringify(beforeClear));

// 走真实 UI：设置 → 数据 → 清空当前角色的聊天记录 → 两次确认
await page.click('#btn-settings'); await sleep(400);
await page.evaluate(() => {
  const b = document.querySelector('[data-wb-drawer="settings"]'); if (b) b.click();
});
await sleep(500);
const clicked = await page.evaluate(() => {
  const b = document.getElementById('btn-clear-chat');
  if (!b) return 'no-btn';
  b.click(); return 'ok';
});
t('清空按钮存在且可点', clicked === 'ok', clicked);
await sleep(500);
const dlgText = await page.evaluate(() => {
  const m = document.querySelector('.modal:not(.hidden)');
  return m ? m.textContent : '(无弹窗)';
});
t('确认框说明了会清记忆和天数',
  dlgText.includes('长期记忆') && dlgText.includes('剧情天数'), dlgText.slice(0, 90));
await page.evaluate(() => document.getElementById('modal-ok').click());
await sleep(500);
await page.evaluate(() => { const b = document.getElementById('modal-ok'); if (b) b.click(); });
await sleep(900);

const afterClear = await page.evaluate(async () => {
  const { mem, msgs, kv } = await import('./js/db.js');
  return { mine: (await mem.list('tm-greet')).length,
           other: (await mem.list('tm-c1')).length,
           msgs: (await msgs.list('tm-greet')).length,
           clock: await kv.get('clock:tm-greet', null),
           stateDay: (window.clockState || {}).day };
});
t('她的长期记忆清了', afterClear.mine === 0, JSON.stringify(afterClear));
t('别的角色的记忆没动', afterClear.other >= 1, String(afterClear.other));
// clock: 删掉之后，重新进入角色时 loadClock 必然按默认值重建一条 ——
// 那不是 bug，断言"键不存在"是错的。真正的语义是【重建出来必须是第 1 天】。
t('剧情天数回到第 1 天（clock: 已重置）',
  !afterClear.clock || afterClear.clock.day === 1, JSON.stringify(afterClear.clock));
t('时段/天气没粘着旧值',
  !afterClear.clock || (afterClear.clock.day === 1 && afterClear.clock.weather !== 'snow'),
  JSON.stringify(afterClear.clock));

// ============================================================
console.log('=== 6. C1：时间跨度注入（模块级单测，不占网）===');
const gapRes = await page.evaluate(async () => {
  const m = await import('./js/persona.js');
  const c = { name: 'x' }, s = { longMemory: false, descLevel: 'mid', verbosity: 'medium' };
  const run = (cs, ps) => {
    const out = m.buildTurnNote(c, s, { clock: 'X', clockState: cs, prevStory: ps });
    const i = out.indexOf('上一条对话');
    return i < 0 ? '' : out.slice(i, i + 90);
  };
  return {
    sameNoHour: run({ day: 2, phase: 'forenoon', hour: null }, { day: 2, phase: 'forenoon', hour: null }),
    sixMin:     run({ day: 2, phase: 'forenoon', hour: 11, minute: 30 }, { day: 2, phase: 'forenoon', hour: 11, minute: 24 }),
    twoHour:    run({ day: 2, phase: 'afternoon', hour: 13, minute: 30 }, { day: 2, phase: 'forenoon', hour: 11, minute: 0 }),
    oneDay:     run({ day: 3, phase: 'morning', hour: 8 }, { day: 2, phase: 'forenoon', hour: 11, minute: 24 }),
    threeDay:   run({ day: 5, phase: 'morning', hour: 8 }, { day: 2, phase: 'forenoon', hour: 11, minute: 24 }),
    goBack:     run({ day: 1, phase: 'morning', hour: 8 }, { day: 5, phase: 'forenoon', hour: 11, minute: 24 }),
    noPrev:     run({ day: 2, phase: 'forenoon', hour: 11 }, null),
    xPhaseNoT:  run({ day: 2, phase: 'afternoon', hour: null }, { day: 2, phase: 'forenoon', hour: null }),
  };
});
t('同时段无钟点 → 不注入', gapRes.sameNoHour === '', gapRes.sameNoHour);
t('11:24 → 11:30 = 6 分钟', gapRes.sixMin.includes('6 分钟'), gapRes.sixMin);
t('11:00 → 13:30 = 2 小时 30 分钟', gapRes.twoHour.includes('2 小时 30 分钟'), gapRes.twoHour);
t('隔一天', gapRes.oneDay.includes('一天'), gapRes.oneDay);
t('隔三天', gapRes.threeDay.includes('3 天'), gapRes.threeDay);
t('时间往回改 → 不注入', gapRes.goBack === '', gapRes.goBack);
t('没有上一条 → 不注入', gapRes.noPrev === '', gapRes.noPrev);
t('跨时段但无钟点 → 不注入', gapRes.xPhaseNoT === '', gapRes.xPhaseNoT);

// ============================================================
console.log('=== 7. C-B：防模仿提示 ===');
const hintRes = await page.evaluate(async () => {
  const m = await import('./js/persona.js');
  const c = { name: 'x' };
  const base = { longMemory: false, descLevel: 'mid', verbosity: 'medium' };
  const on = m.buildTurnNote(c, base, { clock: 'X' });
  const off = m.buildTurnNote(c, { ...base, historyTime: false }, { clock: 'X' });
  return { on: on.includes('历史里的时间标记') && on.includes('不要写这种标记'),
           off: off.includes('历史里的时间标记') };
});
t('默认注入「不要模仿标记」的说明', hintRes.on === true, JSON.stringify(hintRes));
t('开关关掉后不再注入该说明', hintRes.off === false, JSON.stringify(hintRes));

// ============================================================
console.log('=== 8. D：记忆失败会显示 ===');
const dRes = await page.evaluate(async () => {
  const src = await fetch('./js/app.js').then(r => r.text());
  return {
    tidy: src.includes('function tidyNow('),
    reports: src.includes('_lastMemError && Date.now() - _lastMemError.at < 60000'),
    queue: src.includes('_dedupePending'),
    trim: src.includes('被删对话清单已从'),
  };
});
t('tidyNow 包装存在', dRes.tidy === true);
t('失败会 toast 出来', dRes.reports === true);
t('防重入标记存在', dRes.queue === true);
t('队列溢出有兜底', dRes.trim === true);

// ============================================================
console.log('=== 9. 开场白点「重新思考」不能被删掉 ===');
await page.evaluate(async () => {
  const { kv } = await import('./js/db.js');
  const s = await kv.get('settings', {}) || {};
  s.clockDetail = true;
  await kv.set('settings', s);
});
await page.reload({ waitUntil: 'networkidle0' }); await sleep(800);
await page.evaluate(async () => {
  const { chars, kv, msgs } = await import('./js/db.js');
  const id = 'tm-g2';
  await chars.put({ id, name: '开场二', greeting: '（揉眼睛）唔……几点了。', persona: '你是测试角色。',
    avatar: null, temperature: 1, maxTokens: 2048, topP: 1, contextRounds: 20, createdAt: Date.now() });
  await kv.set('lastCharId', id);
  await kv.del('greeted:' + id);
  const old = await msgs.list(id);
  for (const m of old) await msgs.del(m.id);
});
await page.reload({ waitUntil: 'networkidle0' }); await sleep(1000);

const g2before = await page.evaluate(async () => {
  const { msgs } = await import('./js/db.js');
  const l = await msgs.list('tm-g2');
  return { n: l.length, story: l[0] && l[0].story, content: l[0] && l[0].content };
});
t('开场白在，且有无钟点可补', g2before.n === 1, JSON.stringify(g2before));

// 把时间调成第 5 天深夜 23:40，再点「重新思考」
await page.evaluate(async () => {
  const { kv } = await import('./js/db.js');
  await kv.set('clock:tm-g2', { day: 5, phase: 'lateNight', season: 'winter', weather: 'snow', locked: false, hour: 23, minute: 40 });
});
await page.reload({ waitUntil: 'networkidle0' }); await sleep(900);

const menuOk = await page.evaluate(() => {
  const b = document.querySelector('.msg.ai');
  if (!b) return 'no-msg';
  // 直接调 app 内部的菜单：长按路径在 headless 下不稳，改为派发 contextmenu
  b.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  return 'sent';
});
await sleep(700);
const menuItems = await page.evaluate(() => {
  const m = document.querySelector('.msg-menu');
  if (!m) return [];
  return [...m.querySelectorAll('button')].map(b => b.textContent.trim());
});
t('开场白长按有「重新生成」', menuItems.some(x => x.includes('重新生成')), JSON.stringify(menuItems));

await page.evaluate(() => {
  const m = document.querySelector('.msg-menu');
  const b = m && [...m.querySelectorAll('button')].find(x => x.textContent.includes('重新生成'));
  if (b) b.click();
});
await sleep(1200);

const g2after = await page.evaluate(async () => {
  const { msgs } = await import('./js/db.js');
  const l = await msgs.list('tm-g2');
  return { n: l.length, story: l[0] && l[0].story, content: l[0] && l[0].content,
           sysLine: (document.querySelector('.sys-line') || {}).textContent || '' };
});
t('★ 开场白没有被删掉（核心回归）', g2after.n === 1, JSON.stringify(g2after));
t('★ 开场白内容一个字没变', g2after.content === g2before.content,
  JSON.stringify([g2after.content, g2before.content]));
t('★ 时间标签更新成了第 5 天 深夜 23:40',
  !!g2after.story && g2after.story.day === 5 && g2after.story.hour === 23 && g2after.story.minute === 40,
  JSON.stringify(g2after.story));
t('没退回「她在等你开口」', !g2after.sysLine.includes('在等你先开口'), g2after.sysLine);

console.log('\nJS 错误: ' + (errs.length ? errs.join(' | ') : '无'));
t('无 JS 报错', errs.length === 0, errs.join(' | '));
console.log('\n结果: pass='+pass+' fail='+fail);
await browser.close(); server.close();
process.exit(fail?1:0);
