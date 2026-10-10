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

console.log('=== 1. 设置页有时间细化开关，默认关 ===');
await openSettings(page, sleep);
t('有开关', !!(await page.$('#s-clock-detail')));
t('默认关着', (await page.$eval('#s-clock-detail', el => el.checked)) === false);

console.log('');
console.log('=== 2. 关着时：时间弹窗不显示具体时刻那一行 ===');
await jsClick('#btn-set-back'); await sleep(500);
  await page.evaluate(() => { const b = document.getElementById('btn-drawer-close'); if (b && document.querySelector('#view-drawer.active')) b.click(); });
  await sleep(500);
await jsClick('#chat-clock'); await sleep(700);
t('弹窗打开了', !(await page.$eval('#clock-modal', el => el.classList.contains('hidden'))));
const rowHidden = await page.$eval('#clock-time-row', el => el.style.display === 'none');
t('具体时间那一行隐藏了', rowHidden);
await jsClick('#clock-cancel'); await sleep(500);

console.log('');
console.log('=== 3. 打开开关 → 出现输入框 ===');
await openSettings(page, sleep);
await page.evaluate(() => { const c = document.getElementById('s-clock-detail'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); });
await sleep(600);
await jsClick('#btn-set-back'); await sleep(500);
  await page.evaluate(() => { const b = document.getElementById('btn-drawer-close'); if (b && document.querySelector('#view-drawer.active')) b.click(); });
  await sleep(500);
await jsClick('#chat-clock'); await sleep(700);
const rowShown = await page.$eval('#clock-time-row', el => el.style.display !== 'none');
t('具体时间那一行出现了', rowShown);
t('有小时输入框', !!(await page.$('#clock-hour')));
t('有分钟输入框', !!(await page.$('#clock-min')));
t('有「用当前时段」按钮', !!(await page.$('#clock-now-set')));

console.log('');
console.log('=== 4. 设定时间 → 聊天栏显示 ===');
await page.evaluate(() => {
  const h = document.getElementById('clock-hour'); h.value = '14'; h.dispatchEvent(new Event('input', { bubbles: true }));
  const m = document.getElementById('clock-min'); m.value = '20'; m.dispatchEvent(new Event('input', { bubbles: true }));
});
await sleep(300);
await jsClick('#clock-ok'); await sleep(900);
const label = await page.$eval('#chat-clock', el => el.textContent);
console.log('   聊天栏: ' + label);
t('聊天栏显示小时:分钟', /14:20/.test(label), label);

console.log('');
console.log('=== 5. 关掉开关 → 聊天栏回到只有时段 ===');
await openSettings(page, sleep);
await page.evaluate(() => { const c = document.getElementById('s-clock-detail'); c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })); });
await sleep(600);
await jsClick('#btn-set-back'); await sleep(500);
  await page.evaluate(() => { const b = document.getElementById('btn-drawer-close'); if (b && document.querySelector('#view-drawer.active')) b.click(); });
  await sleep(500);
const label2 = await page.$eval('#chat-clock', el => el.textContent);
console.log('   聊天栏: ' + label2);
t('关掉后不显示时刻', !/14:20/.test(label2), label2);

console.log('');
console.log('=== 6. 记忆能设到小时 ===');
await openSettings(page, sleep);
await page.evaluate(() => { const c = document.getElementById('s-clock-detail'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); });
await sleep(600);
await jsClick('#btn-set-back'); await sleep(500);
  await page.evaluate(() => { const b = document.getElementById('btn-drawer-close'); if (b && document.querySelector('#view-drawer.active')) b.click(); });
  await sleep(500);
// 加一条记忆
await jsClick('#btn-chars'); await sleep(700);
await page.evaluate(() => document.querySelectorAll('#char-list .char-card button[data-edit]')[0].click()); await sleep(900);
await page.evaluate(() => document.getElementById('e-mem-fold').click()); await sleep(800);
await page.evaluate(() => {
  const i = document.getElementById('e-mem-input');
  i.value = '第4天下午3点出去玩';
  i.dispatchEvent(new Event('input', { bubbles: true }));
});
await sleep(200);
await jsClick('#e-mem-add'); await sleep(900);
// 点开弹窗设时间
await page.evaluate(() => document.querySelector('#e-mem-list .mem-item').click()); await sleep(700);
t('记忆弹窗有小时输入（开着细化时）', !!(await page.$('#mem-edit-hour')));
await page.evaluate(() => {
  const c = document.getElementById('mem-edit-hasexp'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true }));
  document.getElementById('mem-edit-exp').value = '4';
  document.getElementById('mem-edit-hour').value = '15';
  document.getElementById('mem-edit-min').value = '0';
});
await sleep(300);
await jsClick('#modal-ok'); await sleep(900);
const memInfo = await page.evaluate(async () => {
  const open = () => new Promise(r => { const o = indexedDB.open('ai-companion'); o.onsuccess = () => r(o.result); });
  const db = await open();
  const ms = await new Promise(r => { const q = db.transaction('memories').objectStore('memories').getAll(); q.onsuccess = () => r(q.result); });
  db.close(); return ms[0];
});
console.log('   ' + JSON.stringify({ untilDay: memInfo.untilDay, untilHour: memInfo.untilHour, untilMinute: memInfo.untilMinute, kind: memInfo.kind }));
t('存了 untilDay=4', memInfo.untilDay === 4);
t('存了 untilHour=15', memInfo.untilHour === 15, String(memInfo.untilHour));

console.log('');
console.log('=== 7. 记忆标签显示到小时 ===');
const tags = await page.$$eval('#e-mem-list .mem-item .mem-foot .mem-tag', els => els.map(e => e.textContent.trim()));
console.log('   标签: ' + JSON.stringify(tags));
t('标签显示「第 4 天 15:00」', tags.some(x => x.includes('第 4 天') && x.includes('15:00')), JSON.stringify(tags));

console.log('');
if (errs.length) console.log('  JS 错误: ' + JSON.stringify(errs.slice(0,3)));
t('全程无 JS 错误', errs.length === 0, errs.slice(0,2).join(' | '));
console.log('');
console.log('========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
