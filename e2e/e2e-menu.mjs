import puppeteer from 'puppeteer-core';
import { seedChar, seedChars, pinLang } from './e2e-helper.mjs';
import http from 'http';
import fs from 'fs';
import path from 'path';
// 工作目录自适应（原来写死 C:/A-DSH-Tool/ai-companion）
const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');

// 复现：长按消息菜单「点了删除/重新生成却不消失」+ 顺序错乱
// 关键：桌面 Chrome 长按不派发 contextmenu，Android WebView 会派发，
// 所以这里显式补上 contextmenu，让测试走真实触发路径。
const WWW = `${R}/www`;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.png':'image/png' };
const server = http.createServer((req,res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const f = path.join(WWW, p);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
  res.end(fs.readFileSync(f));
});
await new Promise(r => server.listen(0,'127.0.0.1',r));
const port = server.address().port;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
const page = await browser.newPage();
// ⚠️ CI 的 runner 是 en-US，而界面语言默认「跟随系统」。钉成中文，否则英文界面下
//    断言中文文案的地方都会红（界面翻译补完之后尤其明显，v0.4.2）。
//    用 defineProperty 而不是改库：不用等 reload、也不动 DOM，跟断言不抢。
//    configurable: true 是为了能和预检工具自己的伪装共存。
await page.evaluateOnNewDocument(() => {
  Object.defineProperty(navigator, 'language', { get: () => 'zh-CN', configurable: true });
  Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh'], configurable: true });
});


await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = [];
page.on('pageerror', e => errs.push(e.message));

let pass=0, fail=0;
const t=(n,ok,ex='')=>{ if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));} };
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const menuCount = () => page.$$eval('.msg-menu', els => els.length);
const clearMenus = () => page.evaluate(() => document.querySelectorAll('.msg-menu').forEach(m=>m.remove()));

await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
await sleep(1500);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil:'networkidle0' });
await sleep(400)   // [提速] 原 1800：探针实测 reload 后 app 就绪只要 ~1ms;

// 建一个角色并进去（原来靠默认模板，模板删了要自己准备）
await seedChar(page, '菜单测试', { greeting: '（她看了你一眼）你来了。' });
// ⚠️ CI 的 runner 是 en-US，语言默认「跟随系统」→ 不钉中文，菜单文案断言必红
await pinLang(page, 'zh');
await page.reload({ waitUntil:'networkidle0' }); await sleep(400)   // [提速] 原 1800：探针实测 reload 后 app 就绪只要 ~1ms;
await page.click('#btn-chars'); await sleep(700);
await page.evaluate(() => {
  const c = [...document.querySelectorAll('#char-list .char-card')]
    .find(x => x.textContent.includes('菜单测试'));
  if (c) c.click();
});
await sleep(1300);

// 直接塞 4 条消息进 IndexedDB —— 无需 API Key、无需联网，让循环又快又确定
const cid = await page.evaluate(async () => {
  const open = indexedDB.open('ai-companion');
  const db = await new Promise(r => { open.onsuccess = () => r(open.result); });
  const cs = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').getAll(); q.onsuccess=()=>r(q.result); });
  const cid = (cs.find(c => c.name === '菜单测试') || cs[0]).id;
  const tx = db.transaction('messages','readwrite');
  const st = tx.objectStore('messages');
  // ⚠️ seed 的时间必须【晚于开场白】（v0.5.1.5）：第一次串链是按 ts 升序串的，
  //    早于开场白的 seed 会被串到开场白【前面】—— 开场白成了链尾，
  //    后面「删中间一条」「再塞一条」全跟着错位，看着像功能坏了。
  const base = Date.now() + 1000;
  for (let i=0;i<4;i++) st.put({ id:'seed-'+i, charId:cid, role: i%2 ? 'assistant':'user', content:'种子消息 '+i, images:[], ts: base + i*1000 });
  await new Promise(r => { tx.oncomplete = r; });
  db.close();
  return cid;
});
await page.reload({ waitUntil:'networkidle0' });
// ⚠️ 原来这里是固定 sleep(400)（"探针实测就绪只要 ~1ms"）。这个结论只在
// 【库里没有需要串链的消息】时成立 —— 4 条 seed 消息都要先跑一遍 seedParents
// 才画得出来，而那是一轮 getAll + 写入。固定 400ms 一旦不够，屏幕上只剩 1 条，
// 后面 msgCenter 直接崩在 getBoundingClientRect 上（错的是等待，不是功能）。
await page.waitForFunction(() => document.querySelectorAll('#messages .msg').length >= 4, { timeout: 20000 }).catch(()=>{});
console.log('  角色=' + cid + '，渲染消息数=' + await page.$$eval('.msg', e=>e.length));

// ⚠️ 先等这条消息真的在 DOM 里（v0.5.1.5）。renderMessages 是
// 「先 box.innerHTML = '' 再 await seedParents/curMsgs 后填充」，
// 那中间有一小段列表是空的 —— 固定 sleep 撞进去就取到 undefined，
// 崩在 getBoundingClientRect 上，看着像功能坏了。
const msgCenter = async (i) => {
  await page.waitForFunction((i) => !!document.querySelectorAll('.msg')[i], { timeout: 10000 }, i).catch(()=>{});
  return page.evaluate((i) => {
  const el = document.querySelectorAll('.msg')[i];
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
}, i);
};

// Android 真实长按：550ms 定时器 + 系统 contextmenu 都会触发 showMsgMenu
const longPressAndroid = async (i) => {
  const { x, y } = await msgCenter(i);
  await page.touchscreen.touchStart(x, y);
  await sleep(620);
  await page.evaluate((i) => {
    const el = document.querySelectorAll('.msg')[i];
    if (el) el.dispatchEvent(new MouseEvent('contextmenu', { bubbles:true, cancelable:true }));
  }, i);
  await sleep(350);
  await page.touchscreen.touchEnd();
  await sleep(250);
};

console.log('');
console.log('=== 1. 一次长按只该有 1 个菜单 ===');
await clearMenus();
await longPressAndroid(1);
let n = await menuCount();
t('一次长按 → 屏幕上只有 1 个菜单', n===1, '实际='+n+' 个');

console.log('');
console.log('=== 2. 连续长按不该累积 ===');
await clearMenus();
await longPressAndroid(1);
await longPressAndroid(3);   // 隔开一条：菜单贴着消息弹，紧邻的那条可能被盖住
n = await menuCount();
t('连续长按两条 → 累计只有 1 个菜单', n===1, '实际='+n+' 个');

console.log('');
console.log('=== 3. 点菜单内空白/gap 也要关闭 ===');
await clearMenus();
await longPressAndroid(1);
const nBefore = await page.$$eval('.msg', e => e.length);
// ⚠️ 这里【不按坐标点】（v0.5.1.5）。
// 菜单的 padding 只有 6px，而 touchscreen.tap 的落点和 elementFromPoint 对不齐
// （差一两像素就滑到第一个按钮上）—— 那一下等于点了「编辑重发」，
// 它按设计会连带删掉后面所有消息，于是本节看着像「点空白把记录删光了」。
// 要验的是「点到菜单本体（不是按钮）也得关」，直接对菜单派发 click 就覆盖了这条路径。
await page.evaluate(() => {
  const m = document.querySelector('.msg-menu');
  if (m) m.dispatchEvent(new MouseEvent('click', { bubbles: true }));
});
await sleep(350);
n = await menuCount();
t('点菜单内边缘空白 → 菜单关闭', n===0, '实际='+n+' 个');
t('点空白不会误删消息', (await page.$$eval('.msg', e => e.length)) === nBefore, nBefore + ' -> ' + await page.$$eval('.msg', e => e.length));

console.log('');
console.log('=== 4. 点「删除这条」后必须全消失 ===');
await clearMenus();
const before = await page.$$eval('.msg', e=>e.length);
await longPressAndroid(1);
const had = await menuCount();
if (had === 0) t('菜单出现', false, '菜单没出现');
// ⚠️ 轮询等待（v1.21.37）：del 分支现在 await tidyNow()，固定 900ms 不够。
await page.click('.msg-menu [data-k="del"]');
for (let _w = 0; _w < 40; _w++) {
  await sleep(250);
  const _n = await page.$$eval('.msg', els => els.length);
  if (_n === 5 - 1) break;
}
n = await menuCount();
t('点「删除这条」→ 菜单完全消失', n===0, '实际='+n+' 个');
const after = await page.$$eval('.msg', e=>e.length);
t('消息数减少 1', after===before-1, before+' -> '+after);

console.log('');
console.log('=== 5. 点「重新生成」后必须全消失 ===');
await clearMenus();
await longPressAndroid(3);
const had2 = await menuCount();
if (had2 === 0) t('末条菜单出现', false, '菜单没出现');
await page.click('.msg-menu [data-k="regen"]');
// ⚠️ 等消息数【稳定】（v1.21.37）：重新生成会走真实 API 并改写消息，
// 固定 1200ms 会在流式过程中就往下走 → 后面的索引全错位。
let _prevN = -1, _stable = 0;
for (let _w = 0; _w < 60; _w++) {
  await sleep(300);
  const _n = await page.$$eval('.msg', els => els.length);
  if (_n === _prevN) { _stable++; if (_stable >= 3) break; } else { _stable = 0; _prevN = _n; }
}
n = await menuCount();
t('点「重新生成」→ 菜单完全消失', n===0, '实际='+n+' 个');

console.log('');
console.log('=== 菜单位置贴着被长按的消息 ===');
// ⚠️ 加边界检查（v1.21.37）：前面的删除/重生成会改变消息数，
// 固定索引 3 可能越界 → querySelector 返回 null → 整条测试崩。
const _total = await page.$$eval('.msg', e => e.length);
for (const idx of [1, 2, 3].filter(i => i < _total)) {
  await clearMenus();
  const box = await page.evaluate((i) => {
    const r = document.querySelectorAll('.msg')[i].getBoundingClientRect();
    return { cx: r.left + r.width / 2, top: r.top, bottom: r.bottom, vh: window.innerHeight };
  }, idx);
  await longPressAndroid(idx);
  const mp = await page.evaluate(() => {
    const el = document.querySelector('.msg-menu');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  });
  if (!mp) { t('.msg[' + idx + '] 菜单出现', false, '菜单没出现'); continue; }
  const dx = Math.abs((mp.left + mp.right) / 2 - box.cx);
  const near = mp.top >= box.bottom - 6 || mp.bottom <= box.top + 6;
  const inView = mp.left >= 0 && mp.right <= 393 && mp.top >= 0 && mp.bottom <= box.vh + 1;
  console.log('   .msg[' + idx + '] 中心x=' + Math.round(box.cx) + '  菜单x=[' + Math.round(mp.left) + ',' + Math.round(mp.right) + ']  y=[' + Math.round(mp.top) + ',' + Math.round(mp.bottom) + ']');
  t('.msg[' + idx + '] 菜单水平对齐消息', dx < 40, 'dx=' + Math.round(dx));
  t('.msg[' + idx + '] 菜单紧邻消息上方或下方', near, JSON.stringify({ msg: [Math.round(box.top), Math.round(box.bottom)], menu: [Math.round(mp.top), Math.round(mp.bottom)] }));
  t('.msg[' + idx + '] 菜单完整在屏幕内', inView, JSON.stringify(mp));
}

console.log('');
console.log('=== 自己的消息可以编辑重发 ===');
await clearMenus();
await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const cs = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').getAll(); q.onsuccess = () => r(q.result); });
  const tx = db.transaction('messages', 'readwrite');
  tx.objectStore('messages').put({ id: 'edit-test-1', charId: (cs.find(x => x.name === '菜单测试') || cs[0]).id, role: 'user', content: '这句要改', images: [], ts: Date.now() + 10000 });
  await new Promise(r => { tx.oncomplete = r; }); db.close();
});
await page.reload({ waitUntil: 'networkidle0' });
// 这条没有 parentId，要先被 seedParents 串进链里才画得出来（v0.5.1.5）。
await page.waitForFunction(() => !!document.querySelector('#messages .msg[data-id="edit-test-1"]'), { timeout: 20000 }).catch(()=>{});
const idx = await page.evaluate(() => [...document.querySelectorAll('.msg')].findIndex(el => el.dataset.id === 'edit-test-1'));
t('找到了自己发的那条', idx >= 0, 'index=' + idx);
await longPressAndroid(idx);
const hasEdit = await page.$$eval('.msg-menu [data-k="edit"]', els => els.length);
t('菜单里有「编辑重发」', hasEdit === 1, '找到 ' + hasEdit + ' 个');
const editLabel = await page.$eval('.msg-menu [data-k="edit"]', el => el.textContent.trim()).catch(() => '');
t('菜单项文案是「编辑重发」', editLabel === '编辑重发', editLabel);
await clearMenus();
const aiIdx = await page.evaluate(() => [...document.querySelectorAll('.msg')].findIndex(el => el.classList.contains('ai')));
if (aiIdx >= 0) {
  await longPressAndroid(aiIdx);
  const aiEdit = await page.$$eval('.msg-menu [data-k="edit"]', els => els.length);
  t('AI 的消息没有「编辑重发」', aiEdit === 0, '找到 ' + aiEdit + ' 个');
}
await clearMenus();
await longPressAndroid(idx);
await page.click('.msg-menu [data-k="edit"]');
// ⚠️ 轮询等待（v1.21.37）：edit 分支现在 await tidyNow()，固定 700ms 不够。
for (let _w = 0; _w < 40; _w++) {
  await sleep(250);
  const _v = await page.$eval('#input', el => el.value).catch(() => '');
  if (_v) break;
}
const val = await page.$eval('#input', el => el.value);
t('内容回填到了输入框', val === '这句要改', JSON.stringify(val));
// ⚠️ 轮询等界面更新（v1.21.37）：edit 分支现在 await tidyNow()，
// 输入框回填和消息移除【不是同时发生】的，前面那个等到不代表这个也好了。
for (let _w = 0; _w < 40; _w++) {
  const _gone = await page.evaluate(() => !document.querySelector('[data-id="edit-test-1"]'));
  if (_gone) break;
  await sleep(250);
}
// ⚠️ 必须在轮询【之后】再取一次（v1.21.37）——
// 第一版把 stillThere 取在轮询之前，等于轮询白做。
const stillThere = await page.evaluate(() => !!document.querySelector('[data-id="edit-test-1"]'));
t('原消息已从界面移除', stillThere === false);
const dbGone = await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const m = await new Promise(r => { const q = db.transaction('messages').objectStore('messages').get('edit-test-1'); q.onsuccess = () => r(q.result); });
  db.close(); return m;
});
t('数据库里也删掉了（不会变成两条）', !dbGone);
const focused = await page.evaluate(() => document.activeElement && document.activeElement.id);
t('输入框自动获得焦点', focused === 'input', String(focused));

t('无 JS 错误', errs.length===0, errs.slice(0,2).join(' | '));

console.log('');
console.log('========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close();
server.close();
process.exit(fail>0?1:0);
