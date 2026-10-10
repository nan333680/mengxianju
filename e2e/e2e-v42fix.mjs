// v1.21.42 的两处修复 —— 单套验证，不是全套回归。
//
// 验两件事：
//   A. 剧情天数上限从 9999 放宽（原来超了会被【悄悄夹回】，界面上看不出来）
//   B. 改/删一条"曾归档又取消"的消息之后，滚动摘要要失效
//      （否则她带着已经不存在的那段事继续聊）
import puppeteer from 'puppeteer-core';
import { seedChar } from './e2e-helper.mjs';
import http from 'http'; import fs from 'node:fs'; import path from 'node:path';
const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');
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
// 网络全 mock：本套件不该花钱
await page.setRequestInterception(true);
page.on('request', req => {
  const u = req.url();
  if (!u.includes('deepseek') && !u.includes('/chat/completions')) { req.continue(); return; }
  if (req.method() === 'OPTIONS') { req.respond({ status:204, headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'*'} }); return; }
  req.respond({ status:200, contentType:'application/json', headers:{'Access-Control-Allow-Origin':'*'},
    body: JSON.stringify({ choices:[{ message:{ content:'[]' } }] }) });
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const t = (n, ok, ex) => { if (ok) { pass++; console.log('  OK   ' + n); } else { fail++; console.log('  FAIL ' + n + (ex !== undefined ? '  -> ' + ex : '')); } };

await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
await sleep(1200);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil:'networkidle0' }); await sleep(800);
// v1.21.59：全新安装不再自动建角色（产品改空），测试自己塞一个
await seedChar(page, '测试角色', { greeting: '' });   // 空开场白：不额外多出一条消息
await page.reload({waitUntil:'networkidle0'}); await sleep(500);

// ================= A. 天数上限 =================
// ⚠️ 必须先关掉「时间跟现实走」（v1.21.42 修测试自身）。
//    它默认是【开】的，而现实模式下时间条是只读的：
//    openClockEditor 会提前 return、clockDraft 保持 null，手动改天数根本不生效。
//    第一版没关它，于是"365250 被夹回 9999"是个假失败 —— 那时显示的是手机时间。
console.log('=== A. 剧情天数上限 ===');
await page.evaluate(async () => {
  const open = () => new Promise(r => { const o = indexedDB.open('ai-companion'); o.onsuccess = () => r(o.result); });
  const db = await open();
  const g = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get('settings'); q.onsuccess = () => r(q.result); });
  const v = Object.assign({}, (g && g.v) || {}, { clockMode: false });
  await new Promise(r => { const tx = db.transaction('kv','readwrite'); tx.objectStore('kv').put({ k:'settings', v }); tx.oncomplete = r; });
  db.close();
});
await page.reload({ waitUntil:'networkidle0' }); await sleep(800);
const barText = await page.evaluate(() => (document.querySelector('#chat-clock') || {}).textContent || '');
console.log('   关掉现实模式后时间条: ' + barText.trim());
await page.evaluate(() => document.getElementById('chat-clock').click());
await sleep(600);
const hasEditor = await page.$('#clock-day');
t('时间编辑器打开了', !!hasEditor);

const limit = await page.$eval('#clock-day', el => Number(el.getAttribute('max')));
t('输入框 max 已放宽（> 9999）', limit > 9999, 'max=' + limit);

// 直接输入一个大数，看会不会被夹回去
await page.$eval('#clock-day', el => { el.value = '365250'; el.dispatchEvent(new Event('input', { bubbles: true })); });
await sleep(200);
await page.evaluate(() => { const b = document.getElementById('clock-ok'); if (b) b.click(); });
await sleep(500);
// ⚠️ 断言更新（v1.21.43）：显示改成「年」之后，界面文本【反推不出精确天数】了
//    （"第 1001 年 250 天" 是有损的）。所以"没被夹回"这条要直接读库验实质，
//    界面文本另立一条验格式 —— 两条各管一件事，别混。
const dayInKv = await page.evaluate(async () => {
  const open = () => new Promise(r => { const o = indexedDB.open('ai-companion'); o.onsuccess = () => r(o.result); });
  const db = await open();
  const cs = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').getAll(); q.onsuccess = () => r(q.result); });
  const cid = cs[0] && cs[0].id;
  // clock 存在 kv 里，键名 clock:<charId>
  const all = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').getAllKeys(); q.onsuccess = () => r(q.result); });
  const key = all.find(k => String(k).startsWith('clock:'));
  const v = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get(key); q.onsuccess = () => r(q.result); });
  db.close();
  return { key, day: v ? v.v.day : null, cid };
});
console.log('   库里的 clock: ' + JSON.stringify(dayInKv));
t('365250 天真的存进了库（没被夹回）', dayInKv.day === 365250, 'day=' + dayInKv.day);

const dayAfter = await page.evaluate(() => {
  const el = document.querySelector('#chat-clock');
  return el ? el.textContent.trim() : '(none)';
});
console.log('   时间条显示: ' + dayAfter);
t('时间条按「年」显示（>365 天时）', /第 1001 年 250 天/.test(dayAfter), dayAfter);

// 再验一个千百年量级
await page.evaluate(() => document.getElementById('chat-clock').click());
await sleep(500);
await page.$eval('#clock-day', el => { el.value = '9999999'; el.dispatchEvent(new Event('input', { bubbles: true })); });
await sleep(200);
await page.evaluate(() => { const b = document.getElementById('clock-ok'); if (b) b.click(); });
await sleep(500);
// 同上：读库验实质，不靠界面文本反推
const dayMaxKv = await page.evaluate(async () => {
  const open = () => new Promise(r => { const o = indexedDB.open('ai-companion'); o.onsuccess = () => r(o.result); });
  const db = await open();
  const all = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').getAllKeys(); q.onsuccess = () => r(q.result); });
  const key = all.find(k => String(k).startsWith('clock:'));
  const v = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get(key); q.onsuccess = () => r(q.result); });
  db.close();
  return v ? v.v.day : null;
});
t('上限 9999999 可用（存进库）', dayMaxKv === 9999999, 'day=' + dayMaxKv);
const dayMaxTxt = await page.evaluate(() => (document.querySelector('#chat-clock') || {}).textContent || '');
t('时间条显示为年第 27398 年', /第 27398 年/.test(dayMaxTxt), dayMaxTxt);

// ================= B. 滚动摘要失效 =================
console.log('');
console.log('=== B. 改旧消息后滚动摘要失效 ===');
const cid = await page.evaluate(async () => {
  const open = () => new Promise(r => { const o = indexedDB.open('ai-companion'); o.onsuccess = () => r(o.result); });
  const db = await open();
  const cs = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').getAll(); q.onsuccess = () => r(q.result); });
  const c = cs[0];
  // 造一条"曾归档又取消"的消息：ts 早于摘要水位
  const ts = Date.now() - 100000;
  const tx = db.transaction(['messages','kv'], 'readwrite');
  tx.objectStore('messages').put({ id:'old-1', charId:c.id, role:'user', content:'这是很早以前说过的话', images:[], ts });
  tx.objectStore('messages').put({ id:'old-2', charId:c.id, role:'assistant', content:'她当时的回应', images:[], ts: ts + 1000 });
  // 摘要水位设在这两条【之后】—— 表示它们已经被折进摘要了
  tx.objectStore('kv').put({ k:'memRolling:'+c.id, v:{ text:'很久以前你们聊过一些事', upTo: ts + 5000, day: 1 } });
  await new Promise(r => { tx.oncomplete = r; });
  db.close();
  return c.id;
});
await page.reload({ waitUntil:'networkidle0' }); await sleep(900);

const readRolling = () => page.evaluate(async (id) => {
  const open = () => new Promise(r => { const o = indexedDB.open('ai-companion'); o.onsuccess = () => r(o.result); });
  const db = await open();
  const v = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get('memRolling:'+id); q.onsuccess = () => r(q.result); });
  db.close();
  return v ? v.v : null;
}, cid);

const before = await readRolling();
t('前置：摘要有内容', !!(before && before.text), JSON.stringify(before && before.text));

// 长按 old-1 → 删除这条
const idx = await page.evaluate(() => [...document.querySelectorAll('.msg')].findIndex(el => el.dataset.id === 'old-1'));
t('找到了那条老消息', idx >= 0, 'idx=' + idx);
if (idx >= 0) {
  await page.evaluate((i) => {
    const el = document.querySelectorAll('.msg')[i];
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    const mk = (ty) => new MouseEvent(ty, { bubbles:true, cancelable:true, clientX: Math.round(r.x+r.width/2), clientY: Math.round(r.y+r.height/2) });
    el.dispatchEvent(mk('pointerdown')); el.dispatchEvent(mk('contextmenu'));
  }, idx);
  await sleep(700);
  const hasDel = await page.$('.msg-menu [data-k="del"]');
  t('菜单里有「删除这条」', !!hasDel);
  if (hasDel) {
    await page.click('.msg-menu [data-k="del"]');
    await sleep(1500);
    const after = await readRolling();
    console.log('   删除后 memRolling: ' + JSON.stringify(after));
    t('滚动摘要已失效（text 清空）', !after || !after.text, JSON.stringify(after && after.text));
  }
}

// 反面：删一条【比摘要水位新】的消息，摘要不该被误伤
console.log('');
console.log('=== B2. 反例：新消息不该殃及摘要 ===');
await page.evaluate(async (id) => {
  const open = () => new Promise(r => { const o = indexedDB.open('ai-companion'); o.onsuccess = () => r(o.result); });
  const db = await open();
  const ts = Date.now();   // 比水位新
  const tx = db.transaction(['messages','kv'], 'readwrite');
  tx.objectStore('messages').put({ id:'newer-1', charId:id, role:'user', content:'刚说的话', images:[], ts });
  tx.objectStore('kv').put({ k:'memRolling:'+id, v:{ text:'摘要又写上了', upTo: ts - 100000, day: 1 } });
  await new Promise(r => { tx.oncomplete = r; });
  db.close();
}, cid);
await page.reload({ waitUntil:'networkidle0' }); await sleep(900);
const idx2 = await page.evaluate(() => [...document.querySelectorAll('.msg')].findIndex(el => el.dataset.id === 'newer-1'));
if (idx2 >= 0) {
  await page.evaluate((i) => {
    const el = document.querySelectorAll('.msg')[i];
    el.scrollIntoView({ block:'center' });
    const r = el.getBoundingClientRect();
    const mk = (ty) => new MouseEvent(ty, { bubbles:true, cancelable:true, clientX: Math.round(r.x+r.width/2), clientY: Math.round(r.y+r.height/2) });
    el.dispatchEvent(mk('pointerdown')); el.dispatchEvent(mk('contextmenu'));
  }, idx2);
  await sleep(700);
  const hasDel2 = await page.$('.msg-menu [data-k="del"]');
  if (hasDel2) {
    await page.click('.msg-menu [data-k="del"]');
    await sleep(1500);
    const keep = await readRolling();
    t('删新消息不误伤摘要', !!(keep && keep.text), JSON.stringify(keep && keep.text));
  }
}

console.log('');
if (errs.length) console.log('  JS 错误: ' + JSON.stringify(errs.slice(0,3)));
t('全程无 JS 错误', errs.length === 0, errs.slice(0,2).join(' | '));
console.log('');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
