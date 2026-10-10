import puppeteer from 'puppeteer-core';
import { seedChar } from './e2e-helper.mjs';
import http from 'http'; import fs from 'fs'; import path from 'path';
// 工作目录自适应（原来写死 C:/A-DSH-Tool/ai-companion）
const R = path.resolve(import.meta.dirname).split(path.sep).join('/');
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
page.on('dialog', async d => { await d.accept(); });
const sleep = ms => new Promise(r=>setTimeout(r,ms));
let pass=0, fail=0;
const t=(n,ok,ex='')=>{ if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));} };
const jsClick = (s) => page.evaluate(x => { const e=document.querySelector(x); if(e) e.click(); }, s);

const openSettings = async () => {
  for (let i = 0; i < 6; i++) {
    const cur = await page.evaluate(() => (document.querySelector('.view.active') || {}).id);
    if (cur === 'view-chat') break;
    await page.evaluate(() => {
      const b = document.getElementById('btn-edit-back') || document.getElementById('btn-chars-back')
             || document.getElementById('btn-set-back') || document.getElementById('btn-drawer-close')
             || document.getElementById('btn-wb-back');
      if (b) b.click();
    });
    await sleep(400);
  }
  await page.evaluate(() => document.getElementById('btn-settings').click());
  await sleep(700);
  // ⚠️ 判据必须是「设置页是否**激活**」，不能拿 #s-clock-mode 这种静态元素当依据 ——
  //    它在 HTML 里一直存在，那个写法会让本函数永远提前 return、从没真正进设置页，
  //    于是 bindSettings() 没跑、checkbox 的 onchange 也没绑上。
  const inSet = await page.evaluate(() => (document.querySelector('.view.active') || {}).id === 'view-settings');
  if (inSet) return;
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('#drawer-menu [data-wb-drawer]')].find(x => x.dataset.wbDrawer === 'settings');
    if (b) b.click();
  });
  await sleep(700);
};
const backToChat = async () => {
  await jsClick('#btn-set-back'); await sleep(400);
  await page.evaluate(() => { const b = document.getElementById('btn-drawer-close'); if (b && document.querySelector('#view-drawer.active')) b.click(); });
  await sleep(400);
};
const clockText = () => page.$eval('#chat-clock', el => el.textContent.trim());
const setMode = async (on) => await page.evaluate(async (v) => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => o.onsuccess = () => r(o.result));
  const tx = db.transaction('kv','readwrite'); const st = tx.objectStore('kv');
  const g = await new Promise(r => { const q = st.get('settings'); q.onsuccess = () => r(q.result); });
  const val = Object.assign({}, (g && g.v) || {});
  val.clockMode = v;
  st.put({ k:'settings', v: val });
  await new Promise(r => tx.oncomplete = r);
  db.close();
}, on);
const readKv = (k) => page.evaluate(async (key) => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => o.onsuccess = () => r(o.result));
  const v = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get(key); q.onsuccess = () => r(q.result); });
  db.close(); return v ? v.v : null;
}, k);

// ============ 启动 ============
await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
await sleep(1200);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil:'networkidle0' }); await sleep(500);
// v1.21.59：全新安装不再自动建角色（产品改空），测试自己塞一个
await seedChar(page, '测试角色', { greeting: '' });   // 空开场白：不额外多出一条消息
await page.reload({waitUntil:'networkidle0'}); await sleep(500);

console.log('=== 1. 全新安装 → 默认开启 ===');
await openSettings();
t('设置页有这个开关', !!(await page.$('#s-clock-mode')));
t('全新安装默认【开着】', (await page.$eval('#s-clock-mode', el => el.checked)) === true);
await backToChat();

console.log('');
console.log('=== 2. 开着时：时间条是只读小字 ===');
const c1 = await clockText();
console.log('   时间条: ' + c1);
t('带「跟随手机时间」标记', c1.includes('跟随手机时间'), c1);
t('加了 readonly 类', await page.$eval('#chat-clock', el => el.classList.contains('readonly')));
t('显示第 1 天', /第 1 天/.test(c1), c1);

console.log('');
console.log('=== 3. 开着时：点时间条调不了 ===');
await jsClick('#chat-clock'); await sleep(600);
t('弹窗没打开（被拦住）', await page.$eval('#clock-modal', el => el.classList.contains('hidden')));

console.log('');
console.log('=== 4. 开着时：时段跟真实钟点一致 ===');
const nowPh = await page.evaluate(() => { const h = new Date().getHours();
  if (h<5) return '凌晨'; if (h<9) return '早上'; if (h<11) return '上午'; if (h<13) return '中午';
  if (h<17) return '下午'; if (h<19) return '傍晚'; if (h<23) return '晚上'; return '深夜'; });
t('时段 = 手机当前时段（' + nowPh + '）', c1.includes(nowPh), c1 + ' 期望含 ' + nowPh);

console.log('');
console.log('=== 5. 存档位写进去了 ===');
const cid = await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => o.onsuccess = () => r(o.result));
  const cs = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').getAll(); q.onsuccess = () => r(q.result); });
  db.close(); return cs[0] && cs[0].id;
});
const realKv = await readKv('clock:' + cid + ':real');
t('clock:<id>:real 已写', realKv && typeof realKv.day === 'number' && typeof realKv.ts === 'number', JSON.stringify(realKv));
t('存档位 day = 1', realKv && realKv.day === 1, JSON.stringify(realKv));

console.log('');
console.log('=== 6. 关掉 → 回到手动 ===');
await openSettings();
await page.evaluate(async () => { const c = document.getElementById('s-clock-mode'); c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })); });
await sleep(800);
const st6 = await readKv('settings');
t('kv 里 clockMode = false', !!(st6 && st6.clockMode === false), JSON.stringify(st6 && {clockMode: st6.clockMode}));
await backToChat();
const c2 = await clockText();
console.log('   时间条: ' + c2);
t('不再带「跟随手机时间」', !c2.includes('跟随手机时间'), c2);
t('readonly 类去掉了', !(await page.$eval('#chat-clock', el => el.classList.contains('readonly'))));

console.log('');
console.log('=== 7. 关掉后：时间条能点开了 ===');
await jsClick('#chat-clock'); await sleep(700);
t('弹窗打开了', !(await page.$eval('#clock-modal', el => el.classList.contains('hidden'))));
await jsClick('#clock-cancel'); await sleep(400);

console.log('');
console.log('=== 8. 关掉后：手动调时间生效 ===');
await jsClick('#chat-clock'); await sleep(600);
await page.evaluate(() => { const i = document.getElementById('clock-day'); i.value = '7'; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('blur')); });
await sleep(300);
await jsClick('#clock-ok'); await sleep(800);
const c3 = await clockText();
t('手动改成第 7 天生效', /第 7 天/.test(c3), c3);

console.log('');
console.log('=== 9. 再开回来：接着上次关闭时的进度（不补关闭期）===');
await openSettings();
await page.evaluate(async () => { const c = document.getElementById('s-clock-mode'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); });
await sleep(900);
await backToChat();
const c4 = await clockText();
console.log('   时间条: ' + c4);
const realKv2 = await readKv('clock:' + cid + ':real');
t('存档位重置为第 1 天（从关到开=重新开始）', realKv2 && realKv2.day === 1, JSON.stringify(realKv2));
t('显示第 1 天', /第 1 天/.test(c4), c4);

console.log('');
console.log('=== 10. 升级安装不继承新默认（老数据保持手动）===');
// 模拟老数据：settings 存在但没有 clockMode 键
await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => o.onsuccess = () => r(o.result));
  const tx = db.transaction('kv','readwrite'); const st = tx.objectStore('kv');
  const g = await new Promise(r => { const q = st.get('settings'); q.onsuccess = () => r(q.result); });
  const val = Object.assign({}, (g && g.v) || {});
  delete val.clockMode;
  st.put({ k:'settings', v: val });
  await new Promise(r => tx.oncomplete = r);
  db.close();
});
await page.reload({ waitUntil:'networkidle0' }); await sleep(1200);
const migrated = await readKv('settings');
t('老数据启动后 clockMode 被迁移成 false', !!(migrated && migrated.clockMode === false), JSON.stringify(migrated && {clockMode: migrated.clockMode}));
const c5 = await clockText();
t('时间条回到手动样式', !c5.includes('跟随手机时间'), c5);
await jsClick('#chat-clock'); await sleep(600);
t('手工模式弹窗能开', !(await page.$eval('#clock-modal', el => el.classList.contains('hidden'))));
await jsClick('#clock-cancel'); await sleep(400);

console.log('');
console.log('=== 关掉「时间跟现实走」要回到开之前的时间（v1.21.60 修）===');
// 起因：磁盘那份一直是对的（saveClock 在现实模式下不写 clock:<id>），
// 但内存里的 clockState 在开启时被 realNow() 覆盖过，关掉时没重读 ——
// 于是界面和后续对话用的还是现实时间，"手动时间没回来"。
const cid2 = await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const row = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get('lastCharId'); q.onsuccess = () => r(q.result); });
  const cs = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').getAll(); q.onsuccess = () => r(q.result); });
  db.close();
  return (row && row.v) || (cs[0] && cs[0].id);
});
// 手写一个好认的手动时间：第 42 天 18:30 秋 晴
await page.evaluate(async (id) => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const t = db.transaction('kv','readwrite');
  t.objectStore('kv').put({ k: 'clock:' + id, v: { day: 42, phase: 'evening', season: 'autumn', weather: 'clear', locked: false, hour: 18, minute: 30 } });
  await new Promise(r => { t.oncomplete = r; });
  db.close();
}, cid2);
await page.reload({ waitUntil:'networkidle0' }); await sleep(1000);
const before = await clockText();
t('前置：手动时间是第 42 天傍晚', before.includes('42'), before);

// ⚠️ 必须先打开一次设置页：s-clock-mode 的 onchange 是在 bindSettings() 里绑的，
// 没进过设置页就没有处理器，改了 checked 也不会触发（我第一版就栽在这儿）。
await openSettings();
await sleep(400);
// 打开「时间跟现实走」（直接改控件，绕开折叠的可见性）
await page.evaluate(() => { const c = document.getElementById('s-clock-mode'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); });
await sleep(1500);
const during = await clockText();
t('开着的时候显示的是现实时间（不再是第 42 天）', !during.includes('42'), during);
const diskDuring = await page.evaluate(async (id) => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const row = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get('clock:' + id); q.onsuccess = () => r(q.result); });
  db.close(); return row && row.v;
}, cid2);
t('开着的时候磁盘上那份也没被动', !!diskDuring && diskDuring.day === 42, JSON.stringify(diskDuring));

// 关掉
await page.evaluate(() => { const c = document.getElementById('s-clock-mode'); c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })); });
await sleep(1500);
const after = await clockText();
console.log('   关掉后时间条: ' + JSON.stringify(after));
t('★ 关掉之后回到了第 42 天', after.includes('42'), after);
t('★ 关掉之后不再显示「跟随手机时间」', !after.includes('跟随手机时间'), after);
const diskAfter = await page.evaluate(async (id) => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const row = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get('clock:' + id); q.onsuccess = () => r(q.result); });
  db.close(); return row && row.v;
}, cid2);
t('磁盘上仍是第 42 天（没被现实时间写脏）', !!diskAfter && diskAfter.day === 42 && diskAfter.hour === 18, JSON.stringify(diskAfter));

console.log('');
console.log('  JS 错误: ' + (errs.length ? JSON.stringify(errs) : '无'));
t('全程无 JS 错误', errs.length === 0, errs.join(' | '));

console.log('');
console.log('========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
