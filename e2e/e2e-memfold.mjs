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

await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
await sleep(1500);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil:'networkidle0' });
// v1.21.59：全新安装不再自动建角色（产品改空），测试自己塞一个
await seedChar(page, '测试角色', { greeting: '' });   // 空开场白：不额外多出一条消息
await page.reload({waitUntil:'networkidle0'}); await sleep(500);
await sleep(400)   // [提速] 原 1800：探针实测 reload 后 app 就绪只要 ~1ms;

// 造第二个角色
await page.click('#btn-chars'); await sleep(500);
await seedChar(page, '第二个角色'); await sleep(900);
await page.reload({ waitUntil:'networkidle0' }); await sleep(400)   // [提速] 原 1800：探针实测 reload 后 app 就绪只要 ~1ms;

const names = await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const cs = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').getAll(); q.onsuccess = () => r(q.result); });
  db.close(); return cs.map(c => ({ id: c.id, name: c.name }));
});
const A = names[0], B = names[1];
console.log('   角色: ' + JSON.stringify(names.map(n => n.name)));

// 各塞两条记忆
await page.evaluate(async (a, b) => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const tm = db.transaction('memories','readwrite');
  const st = tm.objectStore('memories');
  st.put({ id:'a1', charId:a.id, text:'A记的第一条', kind:'fact', untilDay:null, ts: Date.now() });
  st.put({ id:'a2', charId:a.id, text:'A记的第二条', kind:'event', untilDay:5, ts: Date.now()+1 });
  st.put({ id:'b1', charId:b.id, text:'B记的第一条', kind:'fact', untilDay:null, ts: Date.now()+2 });
  await new Promise(r => { tm.oncomplete = r; });
  db.close();
}, A, B);
await page.reload({ waitUntil: 'networkidle0' });
await sleep(400)   // [提速] 原 2000：探针实测 reload 后 app 就绪只要 ~1ms;

console.log('');
console.log('=== 1. 第一层：打开设置 → 展开「已记住的事」===');
await openSettings(page, sleep);
t('「已记住的事」默认收起', !(await page.$eval('#mem-wrap', el => el.classList.contains('open'))));
// 计数是展开时才渲染的（renderMem 由折叠回调触发），所以先展开再看
await jsClick('#mem-fold'); await sleep(800);
const cnt0 = await page.$eval('#mem-count', el => el.textContent.trim());
console.log('   折叠头计数: ' + cnt0);
t('折叠头显示总数和人数', /3\s*条/.test(cnt0) && /2\s*人/.test(cnt0), cnt0);
// 收起时条目仍在 DOM 里（折叠是靠 grid-template-rows 收高度，不是移除节点），
// 所以这里验证「收起状态」和「分组卡片都在但都收起」，而不是节点数为 0。
await jsClick('#mem-fold'); await sleep(800);
t('能收回去', !(await page.$eval('#mem-wrap', el => el.classList.contains('open'))));
const allClosed = await page.$$eval('.mem-group', els => els.every(e => !e.classList.contains('open')));
t('收起时人物卡片也都是合上的', allClosed);
await jsClick('#mem-fold'); await sleep(800);

console.log('');
console.log('=== 2. 第二层：按人物分组的卡片 ===');
const groups = await page.$$eval('.mem-group', els => els.map(e => ({
  cid: e.dataset.cid,
  name: e.querySelector('[data-head] span').textContent.trim(),
  num: e.querySelector('.fold-num').textContent.trim(),
  open: e.classList.contains('open')
})));
console.log('   分组: ' + JSON.stringify(groups));
t('按人物分成了两组', groups.length === 2, '组数=' + groups.length);
t('组名就是角色名', groups.map(g => g.name).join(',') === names.map(n => n.name).join(','), JSON.stringify(groups.map(g => g.name)));
t('每组显示自己有几条', groups.find(g => g.name === A.name)?.num === '2 条', JSON.stringify(groups.map(g => g.num)));
t('默认都是收起的', groups.every(g => !g.open));

console.log('');
console.log('=== 3. 第三层：点开某个人，只看到他的记忆 ===');
await page.evaluate((name) => {
  const g = [...document.querySelectorAll('.mem-group')].find(e => e.querySelector('[data-head] span').textContent.trim() === name);
  g.querySelector('[data-head]').click();
}, A.name);
await sleep(700);
const opened = await page.evaluate(() => {
  const g = [...document.querySelectorAll('.mem-group')].find(e => e.classList.contains('open'));
  if (!g) return null;
  return {
    name: g.querySelector('[data-head] span').textContent.trim(),
    items: [...g.querySelectorAll('.mem-item .txt')].map(e => e.textContent.trim()),
    hasInput: !!g.querySelector('[data-inp]')
  };
});
console.log('   展开的组: ' + JSON.stringify(opened));
t('展开的是 A 那组', opened && opened.name === A.name, JSON.stringify(opened && opened.name));
t('只列出 A 自己的两条', opened && opened.items.length === 2, JSON.stringify(opened && opened.items));
t('里面没有 B 的记忆', opened && !opened.items.some(x => x.includes('B记')), JSON.stringify(opened && opened.items));
t('这一组里有「加一条」输入框', opened && opened.hasInput === true);
const otherStillClosed = await page.evaluate((name) => {
  const g = [...document.querySelectorAll('.mem-group')].find(e => e.querySelector('[data-head] span').textContent.trim() === name);
  return !g.classList.contains('open');
}, B.name);
t('B 那组还是收起的（互不影响）', otherStillClosed);

console.log('');
console.log('=== 4. 在某个人的分组里加一条 ===');
await page.evaluate((name) => {
  const g = [...document.querySelectorAll('.mem-group')].find(e => e.querySelector('[data-head] span').textContent.trim() === name);
  const inp = g.querySelector('[data-inp]');
  inp.value = 'A手动加的新条目';
  inp.dispatchEvent(new Event('input', { bubbles: true }));
}, A.name);
await sleep(200);
await page.evaluate((name) => {
  const g = [...document.querySelectorAll('.mem-group')].find(e => e.querySelector('[data-head] span').textContent.trim() === name);
  g.querySelector('[data-add]').click();
}, A.name);
await sleep(900);
const afterAdd = await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const ms = await new Promise(r => { const q = db.transaction('memories').objectStore('memories').getAll(); q.onsuccess = () => r(q.result); });
  db.close(); return ms.map(m => ({ t: m.text, c: m.charId }));
});
const added = afterAdd.find(x => x.t === 'A手动加的新条目');
console.log('   新条目: ' + JSON.stringify(added));
t('新条目入库了', !!added);
t('归属是 A（不是当前角色）', added && added.c === A.id, added && added.c);
const stillOpen = await page.evaluate((name) => {
  const g = [...document.querySelectorAll('.mem-group')].find(e => e.querySelector('[data-head] span').textContent.trim() === name);
  return g.classList.contains('open');
}, A.name);
t('加完之后 A 那组还是展开的（没被重绘收回去）', stillOpen);

console.log('');
console.log('=== 5. 删某一条 ===');
const delId = await page.evaluate((name) => {
  const g = [...document.querySelectorAll('.mem-group')].find(e => e.querySelector('[data-head] span').textContent.trim() === name);
  const items = [...g.querySelectorAll('.mem-item')];
  const target = items.find(x => x.textContent.includes('A记的第一条'));
  // 删除按钮的属性名统一成了 data-cdel（两处渲染共用一个函数）
  const btn = target.querySelector('[data-cdel]');
  const id = btn.dataset.cdel;
  btn.click();
  return id;
}, A.name);
await sleep(600);
// ⚠️ 0.5.2.2 起界面上的删除是【软删】，先弹一次确认 —— 不点确认就什么都没发生。
//    这套原来是按下就断言"库里没了"，那是物理删时代的写法，会一直红。
await page.evaluate(() => { const b = document.getElementById('modal-ok'); if (b) b.click(); });
await sleep(900);
const afterDel = await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const ms = await new Promise(r => { const q = db.transaction('memories').objectStore('memories').getAll(); q.onsuccess = () => r(q.result); });
  db.close(); return ms.map(m => ({ id: m.id, st: m.status || 'active' }));
});
console.log('   删除的 id: ' + delId + ' / 剩余: ' + JSON.stringify(afterDel));
t('那条被软删了（还在库里，状态 deleted）', (afterDel.find(x => x.id === delId) || {}).st === 'deleted', JSON.stringify(afterDel.find(x => x.id === delId)));
t('别人的记忆没被误删', afterDel.some(x => x.id === 'b1' && x.st === 'active'), JSON.stringify(afterDel));

console.log('');
console.log('=== 6. 删掉一个角色后，他的记忆还能看到和清理 ===');
await page.evaluate(async (b) => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const tx = db.transaction('characters','readwrite');
  tx.objectStore('characters').delete(b.id);
  await new Promise(r => { tx.oncomplete = r; });
  db.close();
}, B);
await page.reload({ waitUntil: 'networkidle0' });
await sleep(400)   // [提速] 原 2000：探针实测 reload 后 app 就绪只要 ~1ms;
await openSettings(page, sleep);
await jsClick('#mem-fold'); await sleep(700);
const withOrphan = await page.$$eval('.mem-group [data-head] span', els => els.map(e => e.textContent.trim()));
console.log('   分组: ' + JSON.stringify(withOrphan));
t('已删角色的记忆仍有分组（不会消失得删不掉）', withOrphan.includes('已删除的角色'), JSON.stringify(withOrphan));

console.log('');
if (errs.length) console.log('  JS 错误: ' + JSON.stringify(errs));
t('全程无 JS 错误', errs.length === 0, errs.join(' | '));

console.log('');
console.log('========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
