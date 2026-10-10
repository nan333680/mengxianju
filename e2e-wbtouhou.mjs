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
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, timeout: 60000, args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = []; page.on('pageerror', e => errs.push(e.message));
const sleep = ms => new Promise(r=>setTimeout(r,ms));
let pass=0, fail=0;
const t=(n,ok,ex='')=>{if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));}};
await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
await sleep(1500);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil:'networkidle0' }); await sleep(400)   // [提速] 原 1800：探针实测 reload 后 app 就绪只要 ~1ms;
await seedChar(page, '紫', { greeting:'（开场）' });
await page.reload({ waitUntil:'networkidle0' }); await sleep(400)   // [提速] 原 2000：探针实测 reload 后 app 就绪只要 ~1ms;

// 进世界书页
await page.evaluate(() => document.getElementById('btn-settings').click()); await sleep(800);
await page.evaluate(() => {
  const b = [...document.querySelectorAll('#drawer-menu [data-wb-drawer]')].find(x => x.dataset.wbDrawer === 'worldbook');
  if (b) b.click();
}); await sleep(900);
// 开总开关
await page.evaluate(() => { const c=document.querySelector('#s-wb-on'); if(!c.checked) c.click(); });
await sleep(800);
// 导入
const input = await page.$('#wb-import-file');
// 读工程内副本，不读桌面 —— 桌面文件会被打包清理误删，测试会假红（踩过两次）
await input.uploadFile(`${R}/_fixtures/touhou-worldbook.json`);
await sleep(2500);

console.log('=== 导入结果 ===');
const res = await page.evaluate(async () => {
  const { wb } = await import('./js/db.js');
  const gs = await wb.groups();
  const g = gs[0];
  return g ? { name: g.name, n: g.entries.length,
               keysHasRedMagic: g.entries.some(e=>e.keys.includes('红魔馆')),
               allOn: g.entries.every(e=>e.on === true),
               titles: g.entries.map(e=>e.title) } : null;
});
t('组导进来了', res && res.name.includes('东方幻想乡'), JSON.stringify(res && res.name));
t('条目数量正常（>=15）', res && res.n >= 15, res ? 'n='+res.n : 'null');
t('触发词正确（红魔馆）', res && res.keysHasRedMagic);
t('条目默认启用', res && res.allOn);
console.log('   条目: ' + (res ? res.titles.join('、') : ''));

console.log('=== 全局设置页能看到 ===');
await page.evaluate(() => document.getElementById('btn-wb-global').click());
await sleep(1200);
const listTxt = await page.evaluate(() => (document.querySelector('#wb-group-list') || {}).textContent || '(空)');
console.log('   列表: ' + listTxt.replace(/\s+/g,' ').slice(0,80));
t('显示该组', listTxt.includes('东方幻想乡'), listTxt.slice(0,50));
t('显示了条目数', /\d+ 条/.test(listTxt), listTxt.slice(0,60));

console.log('=== 点进去能看到条目 ===');
await page.evaluate(() => document.querySelector('#wb-group-list .wb-group .wg-body').click());
await sleep(1200);
const eTxt = await page.evaluate(() => (document.querySelector('#wbe-list') || {}).textContent || '');
t('条目列表渲染出来了', eTxt.includes('红魔馆') && eTxt.includes('符卡'), eTxt.slice(0,70));

console.log('\nJS 错误: ' + (errs.length ? errs.join(' | ') : '无'));
t('无 JS 报错', errs.length === 0, errs.join(' | '));
console.log('\n结果: pass='+pass+' fail='+fail);
await browser.close(); server.close();
process.exit(fail?1:0);
