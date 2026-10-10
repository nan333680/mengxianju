import puppeteer from 'puppeteer-core';
import { seedChar } from './e2e-helper.mjs';
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
page.on('dialog', async d => { await d.accept(); });
await page.setRequestInterception(true);
page.on('request', req => {
  const u = req.url();
  if (u.includes('deepseek') || u.includes('/chat/completions')) {
    if (req.method() === 'OPTIONS') { req.respond({ status:204, headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'*'} }); return; }
    const body = JSON.parse(req.postData() || '{}');
    if (body.stream) { req.respond({ status:200, headers:{'Access-Control-Allow-Origin':'*'}, contentType:'text/event-stream', body:'data: '+JSON.stringify({choices:[{delta:{content:'她回复了'}}]})+'\n\ndata: [DONE]\n\n' }); return; }
    req.respond({ status:200, headers:{'Access-Control-Allow-Origin':'*'}, contentType:'application/json', body: JSON.stringify({choices:[{message:{content:'[]'}}]}) });
    return;
  }
  req.continue();
});
const sleep = ms => new Promise(r=>setTimeout(r,ms));

// v1.15.2 起右上角 ⚙ 拉开【抽屉】，设置页要从抽屉里的「全部设置」进。
// 这个函数兼容两种点法，且可重复调用（已进设置页就直接返回）。
const openSettings = async (page, sleep) => {
  // 先退到聊天页：栈底是 chat，其它页面连点返回即可。
  // ⚠️ 只在 view-chat 时点 ⚙ 是不够的 —— 从角色列表/编辑页进来时
  //    当前页不是 chat，会跳过这一步，后续所有断言都打在不可见的页面上（踩过）。
  for (let i = 0; i < 6; i++) {
    const cur = await page.evaluate(() => (document.querySelector('.view.active') || {}).id);
    if (cur === 'view-chat') break;
    await page.evaluate(() => {
      const b = document.getElementById('btn-edit-back')
             || document.getElementById('btn-chars-back')
             || document.getElementById('btn-set-back')
             || document.getElementById('btn-drawer-close')
             || document.getElementById('btn-wb-back');
      if (b) b.click();
    });
    await sleep(500);
  }
  await page.evaluate(() => document.getElementById('btn-settings').click());
  await sleep(800);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('#drawer-menu [data-wb-drawer]')].find(x => x.dataset.wbDrawer === 'settings');
    if (b) b.click();
  });
  await sleep(900);
};
let pass=0, fail=0;
const t=(n,ok,ex='')=>{if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));}};
const jsClick = (s) => page.evaluate(x => document.querySelector(x).click(), s);
const readClock = () => page.evaluate(async () => {
  const open = () => new Promise(r => { const o = indexedDB.open('ai-companion'); o.onsuccess = () => r(o.result); });
  const db = await open();
  const cs = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').getAll(); q.onsuccess = () => r(q.result); });
  const v = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get('clock:'+cs[0].id); q.onsuccess = () => r(q.result); });
  db.close(); return v ? v.v : null;
});

await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
await sleep(1500);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil:'networkidle0' }); await sleep(400)   // [提速] 原 1800：探针实测 reload 后 app 就绪只要 ~1ms;
// v1.21.59：全新安装不再自动建角色（产品改空），测试自己塞一个
await seedChar(page, '测试角色', { greeting: '' });   // 空开场白：不额外多出一条消息
await page.reload({waitUntil:'networkidle0'}); await sleep(500);

// —— v1.20.21：新装默认「时间跟现实走」。这几套测的是【手动调时间】，
//    所以开局先把现实模式关掉，否则时间条只读、弹窗打不开。
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
await openSettings(page, sleep);
await page.$eval('#s-apikey', el => { el.value='k'; el.dispatchEvent(new Event('change',{bubbles:true})); });
await page.$eval('#s-baseurl',(el,p)=>{el.value=p;el.dispatchEvent(new Event('change',{bubbles:true}));},'http://127.0.0.1:'+port+'/api');
await page.evaluate(() => { const c = document.getElementById('s-clock-detail'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); });
await sleep(500);
await jsClick('#btn-set-back'); await sleep(600);
  await page.evaluate(() => { const b = document.getElementById('btn-drawer-close'); if (b && document.querySelector('#view-drawer.active')) b.click(); });
  await sleep(500);

console.log('=== 1. 时间弹窗：天数可直接输入 ===');
await jsClick('#chat-clock'); await sleep(700);
t('天数是个输入框', !!(await page.$('#clock-day')));
await page.evaluate(() => { const i = document.getElementById('clock-day'); i.value = '3'; i.dispatchEvent(new Event('input', { bubbles: true })); });
await sleep(200);
await jsClick('#clock-ok'); await sleep(800);
const c1 = await readClock();
console.log('   时间: ' + JSON.stringify(c1));
t('天数改成了 3', c1.day === 3, String(c1.day));

console.log('');
console.log('=== 2. 设置小时 → 时段自动跟着变（不再"晚上 14:20"）===');
await jsClick('#chat-clock'); await sleep(700);
await page.evaluate(() => {
  const h = document.getElementById('clock-hour'); h.value = '14'; h.dispatchEvent(new Event('input', { bubbles: true }));
  const m = document.getElementById('clock-min'); m.value = '20'; m.dispatchEvent(new Event('input', { bubbles: true }));
});
await sleep(300);
await jsClick('#clock-ok'); await sleep(800);
const c2 = await readClock();
const label = await page.$eval('#chat-clock', el => el.textContent);
console.log('   存: ' + JSON.stringify({ day:c2.day, phase:c2.phase, hour:c2.hour, minute:c2.minute }));
console.log('   显示: ' + label);
t('时段跟着 14 点变成 afternoon', c2.phase === 'afternoon', c2.phase);
t('聊天栏不再出现矛盾的"晚上 14:20"', !/晚上 14/.test(label), label);
t('聊天栏显示 14:20', /14:20/.test(label), label);

console.log('');
console.log('=== 3. 消息显示剧情时间（不是真实时钟）===');
await page.click('#input'); await page.type('#input', '测试一句话', { delay: 5 });
await page.click('#btn-send');
await sleep(2500);
const msgTime = await page.evaluate(() => {
  // :last-of-type 对 class 不生效，用最后一个 .msg.me 里的 .story-time
  const items = [...document.querySelectorAll('#messages .msg.me')];
  const el = items[items.length - 1]?.querySelector('.story-time');
  return el ? el.textContent.trim() : '(没找到)';
});
console.log('   消息右下角: ' + JSON.stringify(msgTime));
t('显示的是剧情时间', /第 3 天/.test(msgTime), msgTime);
t('带时段', /下午/.test(msgTime), msgTime);
t('带具体时刻', /14:20/.test(msgTime), msgTime);

console.log('');
console.log('=== 4. 老消息（没有 story）不显示时间 ===');
const storyCheck = await page.evaluate(async () => {
  const open = () => new Promise(r => { const o = indexedDB.open('ai-companion'); o.onsuccess = () => r(o.result); });
  const db = await open();
  const cs = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').getAll(); q.onsuccess = () => r(q.result); });
  const t2 = db.transaction('messages','readwrite');
  t2.objectStore('messages').put({ id:'old1', charId: cs[0].id, role:'assistant', content:'老消息', ts: Date.now()-99999 });
  await new Promise(r => { t2.oncomplete = r; });
  db.close(); return true;
});
await page.reload({ waitUntil:'networkidle0' }); await sleep(400)   // [提速] 原 2000：探针实测 reload 后 app 就绪只要 ~1ms;
const times = await page.$$eval('#messages .msg .t', els => els.map(e => e.textContent.trim()));
console.log('   所有时间块: ' + JSON.stringify(times));
t('老消息那一条没有时间', times.some(x => x === ''), JSON.stringify(times));

console.log('');
console.log('=== 5. 编辑重发 → 时间条自动退回 ===');
// 先把时间推到第 9 天
await jsClick('#chat-clock'); await sleep(700);
await page.evaluate(() => { const i = document.getElementById('clock-day'); i.value = '9'; i.dispatchEvent(new Event('input', { bubbles: true })); });
await sleep(200);
await jsClick('#clock-ok'); await sleep(800);
const c3 = await readClock();
console.log('   先推到: 第 ' + c3.day + ' 天');
// 长按第一条自己发的消息 → 编辑重发
const edited = await page.evaluate(() => {
  const el = [...document.querySelectorAll('#messages .msg.me')][0];
  if (!el) return false;
  el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  return true;
});
await sleep(800);
const hasEdit = await page.$$eval('.msg-menu [data-k="edit"]', els => els.length);
t('弹出菜单且有「编辑重发」', hasEdit === 1, String(hasEdit));
await jsClick('.msg-menu [data-k="edit"]');
await sleep(1500);
const c4 = await readClock();
console.log('   编辑后时间: ' + JSON.stringify({ day: c4.day, phase: c4.phase, hour: c4.hour }));
t('时间退回到第 3 天', c4.day === 3, String(c4.day));
t('小时也退回了', c4.hour === 14, String(c4.hour));

console.log('');
if (errs.length) console.log('  JS 错误: ' + JSON.stringify(errs.slice(0,3)));
t('全程无 JS 错误', errs.length === 0, errs.slice(0,2).join(' | '));
console.log('');
console.log('========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
