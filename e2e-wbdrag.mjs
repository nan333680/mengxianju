import puppeteer from 'puppeteer-core';
import { seedChars } from './e2e-helper.mjs';
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
const sleep = ms => new Promise(r=>setTimeout(r,ms));
let pass=0, fail=0;
const t=(n,ok,ex='')=>{if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));}};
const goWb = async () => {
  await page.evaluate(() => document.getElementById('btn-settings').click()); await sleep(800);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('#drawer-menu [data-wb-drawer]')].find(x => x.dataset.wbDrawer === 'worldbook');
    if (b) b.click();
  }); await sleep(900);
};
await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
await sleep(1500);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil:'networkidle0' }); await sleep(300);
await seedChars(page, [{name:'紫'},{name:'袿姬'}]);
await page.reload({ waitUntil:'networkidle0' }); await sleep(300);
// 建 3 个组
await page.evaluate(async () => {
  const { wb, uid } = await import('./js/db.js');
  for (const n of ['组A','组B','组C']) {
    await wb.putGroup({ id: uid(), name: n, members: [], entries: [], createdAt: Date.now() });
    await new Promise(r => setTimeout(r, 12));
  }
  await (await import('./js/db.js')).kv.set('settings', Object.assign({}, await (await import('./js/db.js')).kv.get('settings', {}), { worldbookOn: true }));
});
await page.reload({ waitUntil:'networkidle0' }); await sleep(300);

console.log('=== 1. bug1：删组后总览小字要立刻更新 ===');
await goWb();
const sub0 = await page.evaluate(() => document.querySelector('#wb-global-sub').textContent);
console.log('   初始: ' + sub0);
t('显示 3 个组', /3 个/.test(sub0), sub0);
// 进全局设置删掉一个
await page.evaluate(() => document.getElementById('btn-wb-global').click()); await sleep(900);
await page.evaluate(() => document.querySelector('[data-wb-custom]').click()); await sleep(800);
await page.evaluate(() => { const d = document.getElementById('pk-del'); if (d) d.click(); }); await sleep(800);
await page.evaluate(() => document.getElementById('modal-ok').click()); await sleep(1500);
const left = await page.evaluate(() => document.querySelectorAll('#wb-group-list .wb-group').length);
t('组列表剩 2 个', left === 2, 'n='+left);
// 退回世界书总览（关键：不重新点抽屉）
await page.evaluate(() => document.getElementById('btn-wbg-back').click()); await sleep(1000);
const sub1 = await page.evaluate(() => document.querySelector('#wb-global-sub').textContent);
console.log('   返回后: ' + sub1);
t('总览小字立刻变成 2 个（不用退出去重进）', /2 个/.test(sub1), sub1);

console.log('=== 2. bug2：长按拖动排序 ===');
// 先补齐 3 个组（上一步删了一个）
await page.evaluate(async () => {
  const { wb, uid, kv } = await import('./js/db.js');
  await wb.putGroup({ id: uid(), name: '组D', members: [], entries: [], createdAt: Date.now() + 5000 });
});
await page.evaluate(() => document.getElementById('btn-wbg-back').click()); await sleep(600);
await page.evaluate(() => document.getElementById('btn-wb-global').click()); await sleep(1000);
const orderBefore = await page.evaluate(() => [...document.querySelectorAll('#wb-group-list .wb-group')].map(x => x.querySelector('.wg-name').textContent));
console.log('   拖动前: ' + JSON.stringify(orderBefore));
// 模拟长按（按住 600ms）再拖动
const box = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#wb-group-list .wb-group')];
  const a = rows[0].getBoundingClientRect(), c = rows[rows.length-1].getBoundingClientRect();
  return { n: rows.length, ax: a.x + a.width/2, ay: a.y + a.height/2, cy: c.y + c.height/2 };
});
await page.mouse.move(box.ax, box.ay);
await page.mouse.down();
await sleep(700);            // 超过 500ms 长按阈值
const armed = await page.evaluate(() => !!document.querySelector('.wb-group.dragging'));
t('长按进入拖动模式', armed);
// 拖到最后一行
await page.mouse.move(box.ax, box.cy, { steps: 12 });
await sleep(300);
const during = await page.evaluate(() => [...document.querySelectorAll('#wb-group-list .wb-group')].map(x => x.querySelector('.wg-name').textContent));
console.log('   拖动中: ' + JSON.stringify(during));
t('拖动中顺序变了', JSON.stringify(during) !== JSON.stringify(orderBefore), JSON.stringify(during));
await page.mouse.up();
await sleep(1500);
const orderAfter = await page.evaluate(async () => {
  const { wb } = await import('./js/db.js');
  const gs = await wb.groups();
  return gs.map(g => g.name);
});
console.log('   拖动后（库里）: ' + JSON.stringify(orderAfter));
t('顺序已存进库', JSON.stringify(orderAfter) !== JSON.stringify(orderBefore), JSON.stringify(orderAfter));
t('原来的第一个现在不在首位', orderAfter[0] !== orderBefore[0], orderAfter[0]);
t('order 字段写进去了', await page.evaluate(async () => {
  const { wb } = await import('./js/db.js');
  const gs = await wb.groups();
  return gs.every(g => typeof g.order === 'number');
}));

console.log('=== 3. 刷新后顺序保持 ===');
await page.reload({ waitUntil:'networkidle0' }); await sleep(300);
const afterReload = await page.evaluate(async () => {
  const { wb } = await import('./js/db.js');
  return (await wb.groups()).map(g => g.name);
});
t('刷新后顺序不变', JSON.stringify(afterReload) === JSON.stringify(orderAfter), JSON.stringify(afterReload));

console.log('=== 4. 普通点击仍能进编辑（拖动没抢掉点击）===');
await goWb();
await page.evaluate(() => document.getElementById('btn-wb-global').click()); await sleep(900);
await page.evaluate(() => document.querySelector('#wb-group-list .wb-group .wg-body').click());
await sleep(1000);
t('点组名能进编辑页', await page.evaluate(() => document.querySelector('#view-wbentries').classList.contains('active')));

console.log('\nJS 错误: ' + (errs.length ? errs.join(' | ') : '无'));
t('无 JS 报错', errs.length === 0, errs.join(' | '));
console.log('\n结果: pass='+pass+' fail='+fail);
await browser.close(); server.close();
process.exit(fail?1:0);
