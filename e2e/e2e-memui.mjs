import puppeteer from 'puppeteer-core';
import { seedChar, seedChars } from './e2e-helper.mjs';
import http from 'http';
import fs from 'fs';
import path from 'path';
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
const errs = [];
page.on('pageerror', e => errs.push(e.message));
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
const t=(n,ok,ex='')=>{ if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));} };
const jsClick = (sel) => page.evaluate(s => document.querySelector(s).click(), sel);
const openEdit = async (idx) => {
  await page.click('#btn-chars'); await sleep(500);
  await page.evaluate(i => document.querySelectorAll('#char-list .char-card button[data-edit]')[i].click(), idx);
  await sleep(900);
};

await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
await sleep(1500);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil:'networkidle0' });
// v1.21.59：全新安装不再自动建角色（产品改空），测试自己塞一个
await seedChar(page, '测试角色', { greeting: '' });   // 空开场白：不额外多出一条消息
await page.reload({waitUntil:'networkidle0'}); await sleep(500);
await sleep(400)   // [提速] 原 1800：探针实测 reload 后 app 就绪只要 ~1ms;

// 造第二个角色 + 塞记忆
await page.click('#btn-chars'); await sleep(500);
await seedChar(page, '第二个角色'); await sleep(900);
await page.reload({ waitUntil:'networkidle0' }); await sleep(400)   // [提速] 原 1800：探针实测 reload 后 app 就绪只要 ~1ms;
const names = await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const cs = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').getAll(); q.onsuccess = () => r(q.result); });
  db.close(); return cs.map(c => ({ id: c.id, name: c.name }));
});
// v1.21.59：种子角色的 id 是随机串，getAll() 按 id 字典序返回 ——
// names[0] 不一定是「当前选中的角色」。这里按 lastCharId 认，A 就是当前那个。
const curId = await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const row = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get('lastCharId'); q.onsuccess = () => r(q.result); });
  db.close(); return row && row.v;
});
const A = names.find(x => x.id === curId) || names[0];
const B = names.find(x => x.id !== A.id) || names[1];
await page.evaluate(async (a, b) => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const tm = db.transaction('memories','readwrite');
  const st = tm.objectStore('memories');
  st.put({ id:'a1', charId:a.id, text:'A记住的事一', kind:'fact', untilDay:null, ts: Date.now() });
  st.put({ id:'a2', charId:a.id, text:'A记住的事二', kind:'event', untilDay:5, ts: Date.now()+1 });
  st.put({ id:'b1', charId:b.id, text:'B记住的事一', kind:'fact', untilDay:null, ts: Date.now()+2 });
  await new Promise(r => { tm.oncomplete = r; });
  db.close();
}, A, B);
await page.reload({ waitUntil: 'networkidle0' });
await sleep(400)   // [提速] 原 2000：探针实测 reload 后 app 就绪只要 ~1ms;

console.log('=== 1. 三个轮次参数回到设置页（全局）===');
await openSettings(page, sleep);
t('设置页有「记忆节奏」折叠头', !!(await page.$('#mem-set-fold')));
t('默认收起', !(await page.$eval('#mem-set-wrap', el => el.classList.contains('open'))));
await jsClick('#mem-set-fold'); await sleep(700);
t('展开后有三个参数', (await page.$$('#mem-set-wrap input[type=number]')).length === 3);
const vals = await page.evaluate(() => ({
  sum: document.querySelector('#s-mem-sum').value,
  dedupe: document.querySelector('#s-mem-dedupe').value,
  limit: document.querySelector('#s-mem-limit').value
}));
console.log('   默认值: ' + JSON.stringify(vals));
// v1.14.0 起默认放宽（30/10 → 50/20）：反馈记忆太频繁、太杂
t('默认值读得到（50/20/20）', vals.sum === '50' && vals.dedupe === '20' && vals.limit === '20', JSON.stringify(vals));
// 改一个
await page.evaluate(() => { const i = document.querySelector('#s-mem-dedupe'); i.value = '8'; i.dispatchEvent(new Event('change', { bubbles: true })); });
await sleep(600);
const savedGlobal = await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const kv = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get('settings'); q.onsuccess = () => r(q.result); });
  const cs = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').getAll(); q.onsuccess = () => r(q.result); });
  db.close(); return { global: kv.v.memDedupeEvery, perChar: cs.map(c => c.memDedupeEvery) };
});
console.log('   改后: ' + JSON.stringify(savedGlobal));
t('全局值改成了 8', savedGlobal.global === 8, String(savedGlobal.global));
// 角色上可能残留 null（那是「没设过」的占位，effSettings 会跳过），
// 关键是不能再有真实的数值——参数已经归全局了。
t('角色身上不再有这个参数的真实值', savedGlobal.perChar.every(v => v === undefined || v === null), JSON.stringify(savedGlobal.perChar));
await jsClick('#mem-set-fold'); await sleep(500);

console.log('');
console.log('=== 2. 设置页仍然按人物分组看全部 ===');
t('有「已记住的事」', !!(await page.$('#mem-fold')));
await jsClick('#mem-fold'); await sleep(800);
const cntText = await page.$eval('#mem-count', el => el.textContent.trim());
console.log('   计数: ' + cntText);
t('计数显示总数和人数', /3\s*条/.test(cntText) && /2\s*人/.test(cntText), cntText);
const grp = await page.$$eval('.mem-group [data-head] span', els => els.map(e => e.textContent.trim()));
console.log('   分组: ' + JSON.stringify(grp));
t('按人物分成两组', grp.length === 2, JSON.stringify(grp));
await page.click('#btn-set-back'); await sleep(500);
  // v1.15.2 起栈多了 drawer 一层，退到设置页的上一层是抽屉，还要再关一次
  await page.evaluate(() => { const b = document.getElementById('btn-drawer-close'); if (b && document.querySelector('#view-drawer.active')) b.click(); });
  await sleep(500);

console.log('');
console.log('=== 3. 角色编辑页：能看到并增删自己的记忆 ===');
await openEdit(0);
const editName = await page.$eval('#e-name', el => el.value);
console.log('   编辑的角色: ' + editName);
t('角色页有「她记住的事」折叠头', !!(await page.$('#e-mem-fold')));
t('角色页没有那三个节奏参数了', !(await page.$('#e-mem-sum')) && !(await page.$('#e-mem-dedupe')));
await jsClick('#e-mem-fold'); await sleep(800);
const cItems = await page.$$eval('#e-mem-list .mem-item .txt', els => els.map(e => e.textContent.trim()));
console.log('   列出的: ' + JSON.stringify(cItems));
t('列出了这个角色自己的记忆', cItems.length === 2, JSON.stringify(cItems));
t('没有别人的记忆', !cItems.some(x => x.includes('B记住')), JSON.stringify(cItems));
const cCnt = await page.$eval('#e-mem-count', el => el.textContent.trim());
t('折叠头显示条数', cCnt === '2 条', cCnt);

console.log('');
console.log('=== 4. 在角色页加一条 ===');
await page.evaluate(() => {
  const i = document.querySelector('#e-mem-input');
  i.value = '我在角色页手动加的';
  i.dispatchEvent(new Event('input', { bubbles: true }));
});
await sleep(200);
await jsClick('#e-mem-add'); await sleep(900);
const afterAdd = await page.evaluate(async (a) => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const ms = await new Promise(r => { const q = db.transaction('memories').objectStore('memories').getAll(); q.onsuccess = () => r(q.result); });
  db.close();
  return { mine: ms.filter(m => m.charId === a.id).map(m => m.text), all: ms.length };
}, A);
console.log('   加完: ' + JSON.stringify(afterAdd));
t('新条目归到这个角色名下', afterAdd.mine.includes('我在角色页手动加的'), JSON.stringify(afterAdd.mine));
t('总数从 3 变成 4', afterAdd.all === 4, String(afterAdd.all));
t('加完后列表里能看到', (await page.$$eval('#e-mem-list .mem-item', e => e.length)) === 3);

console.log('');
console.log('=== 5. 在角色页删一条 ===');
const beforeDel = await page.$$eval('#e-mem-list .mem-item', e => e.length);
await page.evaluate(() => {
  const item = [...document.querySelectorAll('#e-mem-list .mem-item')].find(x => x.textContent.includes('A记住的事一'));
  item.querySelector('[data-cdel]').click();
});
await sleep(900);
const afterDel = await page.evaluate(async (a, b) => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const ms = await new Promise(r => { const q = db.transaction('memories').objectStore('memories').getAll(); q.onsuccess = () => r(q.result); });
  db.close();
  return { mine: ms.filter(m => m.charId === a.id).length, other: ms.filter(m => m.charId === b.id).length };
}, A, B);
console.log('   删前 ' + beforeDel + ' 条 → 删后 A 剩 ' + afterDel.mine + ' 条 / B 有 ' + afterDel.other + ' 条');
t('自己那条删掉了', afterDel.mine === beforeDel - 1, String(afterDel.mine));
t('别人的记忆没被误删', afterDel.other === 1, String(afterDel.other));

console.log('');
console.log('=== 6. 角色页显示的内容，和设置页按人物分组的对得上 ===');
await page.click('#btn-edit-back'); await sleep(600);
await openSettings(page, sleep);
await jsClick('#mem-fold'); await sleep(800);
const groupCounts = await page.$$eval('.mem-group', els => els.map(e => ({
  name: e.querySelector('[data-head] span').textContent.trim(),
  num: e.querySelector('.fold-num').textContent.trim()
})));
console.log('   设置页分组: ' + JSON.stringify(groupCounts));
const aGroup = groupCounts.find(g => g.name === A.name);
t('设置页里 A 的条数和角色页一致', aGroup && aGroup.num === `${afterDel.mine} 条`, JSON.stringify(aGroup));

console.log('');
if (errs.length) console.log('  JS 错误: ' + JSON.stringify(errs));
t('全程无 JS 错误', errs.length === 0, errs.join(' | '));

console.log('');
console.log('========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
