import puppeteer from 'puppeteer-core';
import { seedChar, seedChars } from './e2e-helper.mjs';
import http from 'http'; import fs from 'fs'; import path from 'path';
// 工作目录自适应（原来写死 C:/A-DSH-Tool/ai-companion）
const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');
const WWW = `${R}/www`;
const FIX = `${R}/_fixtures`;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8' };
fs.mkdirSync(FIX, { recursive: true });
const entryFile = path.join(FIX, 'entries-传进来.json');
fs.writeFileSync(entryFile, JSON.stringify({ version:1, kind:'worldbook-entries', name:'别人写的',
  entries:[{ id:'x1', title:'隙间', keys:['隙间','空间裂隙'], content:'隙间是紫开的空间裂隙。', on:true },
           { id:'x2', title:'蓝', keys:['蓝','式神'], content:'蓝是紫的式神，九尾妖狐。', on:true }] }), 'utf8');
const server = http.createServer((req,res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p==='/') p='/index.html';
  const f = path.join(WWW, p);
  if (!fs.existsSync(f)) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f));
});
await new Promise(r => server.listen(0,'127.0.0.1',r));
const port = server.address().port;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, timeout: 60000, args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
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
await page.reload({ waitUntil:'networkidle0' }); await sleep(400)   // [提速] 原 1800：探针实测 reload 后 app 就绪只要 ~1ms;
await seedChars(page, [{name:'紫'},{name:'袿姬'}]);
await page.reload({ waitUntil:'networkidle0' }); await sleep(400)   // [提速] 原 2000：探针实测 reload 后 app 就绪只要 ~1ms;
await page.evaluate(async () => {
  const { kv } = await import('./js/db.js');
  await kv.set('settings', Object.assign({}, await kv.get('settings', {}), { worldbookOn: true }));
});
await page.reload({ waitUntil:'networkidle0' }); await sleep(400)   // [提速] 原 2000：探针实测 reload 后 app 就绪只要 ~1ms;
await goWb();

console.log('=== 1. 单独角色页有两个小按钮，且同一行 ===');
await page.evaluate(() => document.getElementById('btn-wb-solo').click()); await sleep(800);
await page.evaluate(() => {
  const r = [...document.querySelectorAll('#pk-list .pick-row')].find(x => x.textContent.includes('紫'));
  r.click();
});
await sleep(1000);
const btns = await page.evaluate(() => {
  const i = document.getElementById('btn-wbs-import'), e = document.getElementById('btn-wbs-export');
  if (!i || !e) return null;
  const ri = i.getBoundingClientRect(), re = e.getBoundingClientRect();
  const row = i.closest('.top-actions');
  return {
    both: true, sameRow: ri.top === re.top,
    small: ri.width <= 36 && ri.height <= 36,
    inHeader: !!row,
    w: Math.round(ri.width), h: Math.round(ri.height),
  };
});
console.log('   ' + JSON.stringify(btns));
t('两个按钮都在', btns && btns.both);
t('在同一行（top 相同）', btns && btns.sameRow);
t('尺寸小（<=36px）', btns && btns.small, btns ? btns.w + 'x' + btns.h : '');
t('在标题栏里，不占整行', btns && btns.inHeader);

console.log('=== 2. 导入条目 ===');
const inp = await page.$('#wbs-import-file');
await inp.uploadFile(entryFile);
await sleep(2000);
const after = await page.evaluate(async () => {
  const { wb, chars } = await import('./js/db.js');
  const cs = await chars.all();
  const zi = cs.find(c => c.name === '紫');
  const s = await wb.solo(zi.id);
  return s ? s.entries.map(e => e.title) : [];
});
console.log('   ' + JSON.stringify(after));
t('导入了 2 条', after.length === 2, JSON.stringify(after));
t('标题正确', after.includes('隙间') && after.includes('蓝'));
const listTxt = await page.evaluate(() => document.querySelector('#wbs-list').textContent);
t('列表渲染出来了', listTxt.includes('隙间'), listTxt.slice(0,40));

console.log('=== 3. 重复导入会跳过，不灌副本 ===');
const inp2 = await page.$('#wbs-import-file');
await inp2.uploadFile(entryFile);
await sleep(2000);
const after2 = await page.evaluate(async () => {
  const { wb, chars } = await import('./js/db.js');
  const cs = await chars.all();
  const zi = cs.find(c => c.name === '紫');
  return ((await wb.solo(zi.id)) || {entries:[]}).entries.length;
});
t('还是 2 条（没重复灌）', after2 === 2, 'n='+after2);

console.log('=== 4. 条目页也有这两个按钮 ===');
await page.evaluate(() => document.getElementById('btn-wbs-back').click()); await sleep(700);
await page.evaluate(() => document.getElementById('btn-wb-global').click()); await sleep(900);
await page.evaluate(() => document.getElementById('btn-wb-newgroup').click()); await sleep(800);
await page.evaluate(() => {
  document.querySelector('#pk-list .pick-row').click();
  document.querySelector('#pk-name').value = '测试组';
});
await page.evaluate(() => document.getElementById('modal-ok').click()); await sleep(1500);
await page.evaluate(() => document.querySelector('#wb-group-list .wb-group .wg-body').click());
await sleep(1000);
const eBtns = await page.evaluate(() => ({
  imp: !!document.getElementById('btn-wbe-import'),
  exp: !!document.getElementById('btn-wbe-export'),
  cust: !!document.getElementById('btn-wbe-custom'),
  sameRow: (() => {
    const i = document.getElementById('btn-wbe-import'), c = document.getElementById('btn-wbe-custom');
    return i && c ? Math.abs(i.getBoundingClientRect().top - c.getBoundingClientRect().top) < 4 : false;
  })(),
}));
console.log('   ' + JSON.stringify(eBtns));
t('条目页也有导入导出', eBtns.imp && eBtns.exp);
t('和「组列自定义」同一行', eBtns.sameRow);
t('组列自定义按钮还在', eBtns.cust);

console.log('=== 5. 完全没条目时导出给提示，不崩 ===');
await page.evaluate(() => document.getElementById('btn-wbe-export').click());
await sleep(900);
const toast = await page.evaluate(() => { const el = document.getElementById('toast'); return el && !el.classList.contains('hidden') ? el.textContent : ''; });
t('提示还没有条目', /还没有条目/.test(toast), toast);

console.log('\nJS 错误: ' + (errs.length ? errs.join(' | ') : '无'));
t('无 JS 报错', errs.length === 0, errs.join(' | '));
console.log('\n结果: pass='+pass+' fail='+fail);
await browser.close(); server.close();
process.exit(fail?1:0);
