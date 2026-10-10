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
await seedChars(page, [{name:'八云紫'}]);
await page.reload({ waitUntil:'networkidle0' }); await sleep(400)   // [提速] 原 2000：探针实测 reload 后 app 就绪只要 ~1ms;
await page.evaluate(async () => {
  const { kv } = await import('./js/db.js');
  await kv.set('settings', Object.assign({}, await kv.get('settings', {}), { worldbookOn: true }));
});
await page.reload({ waitUntil:'networkidle0' }); await sleep(400)   // [提速] 原 2000：探针实测 reload 后 app 就绪只要 ~1ms;
// 进单独角色 → 选紫 → 导入
await page.evaluate(() => document.getElementById('btn-settings').click()); await sleep(800);
await page.evaluate(() => {
  const b = [...document.querySelectorAll('#drawer-menu [data-wb-drawer]')].find(x => x.dataset.wbDrawer === 'worldbook');
  if (b) b.click();
}); await sleep(900);
await page.evaluate(() => document.getElementById('btn-wb-solo').click()); await sleep(800);
await page.evaluate(() => {
  const r = [...document.querySelectorAll('#pk-list .pick-row')].find(x => x.textContent.includes('八云紫'));
  r.click();
});
await sleep(1000);
const inp = await page.$('#wbs-import-file');
// ⚠️ 素材放工程内 _fixtures，别指向桌面 —— 桌面那个文件早就没了，
// 测试读不到 → 导入结果是 null → 4 项断言全挂，而且挂得像功能坏了。
await inp.uploadFile(`${R}/_fixtures/zi-solo.json`);
await sleep(2200);
const res = await page.evaluate(async () => {
  const { wb, chars } = await import('./js/db.js');
  const cs = await chars.all();
  const zi = cs.find(c => c.name === '八云紫');
  const s = await wb.solo(zi.id);
  return s ? s.entries.map(e => ({ t: e.title, k: e.keys.length, on: e.on })) : null;
});
console.log('   导入结果: ' + JSON.stringify(res ? res.length + ' 条' : 'null'));
t('11 条都导入了', res && res.length === 11, res ? 'n='+res.length : 'null');
t('触发词都在', res && res.every(e => e.k > 0));
t('全部启用', res && res.every(e => e.on === true));
const listTxt = await page.evaluate(() => document.querySelector('#wbs-list').textContent);
t('列表渲染正常', listTxt.includes('隙间') && listTxt.includes('八云蓝'), listTxt.slice(0,50));
console.log('\nJS 错误: ' + (errs.length ? errs.join(' | ') : '无'));
t('无 JS 报错', errs.length === 0, errs.join(' | '));
console.log('\n结果: pass='+pass+' fail='+fail);
await browser.close(); server.close();
process.exit(fail?1:0);
