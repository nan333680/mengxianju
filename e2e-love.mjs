
import puppeteer from 'puppeteer-core';
import { seedChar, seedChars } from './e2e-helper.mjs';
import http from 'http';
import fs from 'fs';
import path from 'path';
// 工作目录自适应（原来写死 C:/A-DSH-Tool/ai-companion）
const R = path.resolve(import.meta.dirname).split(path.sep).join('/');

// [提速] 批量替换时统一用了 sleep(N) 写法，这里补上定义
const sleep = ms => new Promise(r => setTimeout(r, ms));


const WWW = `${R}/www`;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const API_KEY = process.env.DSH_API_KEY || 'sk-test';

const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.png':'image/png' };
const server = http.createServer((req,res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const f = path.join(WWW, p);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
  res.end(fs.readFileSync(f));
});
await new Promise(r => server.listen(0,'127.0.0.1',r));
const port = server.address().port;

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

const waitDone = async () => {
  for (let i=0;i<220;i++){
    await new Promise(r=>setTimeout(r,400));
    const b = await page.$eval('#btn-stop', el => !el.classList.contains('hidden')).catch(()=>false);
    if (!b) return;
  }
};
const say = async (text) => {
  await page.click('#input');
  await page.type('#input', text, { delay: 8 });
  await page.click('#btn-send');
  await waitDone();
  await new Promise(r=>setTimeout(r,400));
  const all = await page.$$eval('.msg .bub', els => els.map(e=>e.textContent.trim()));
  return all[all.length-1];
};

await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
await new Promise(r=>setTimeout(r,1600));
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil:'networkidle0' });
await sleep(400)   // [提速] 原 1800：探针实测 reload 后 app 就绪只要 ~1ms;

await page.click('#btn-settings');
await new Promise(r => setTimeout(r, 800));
// v1.15.2 起 ⚙ 拉开抽屉，设置页要从抽屉里的「全部设置」进
await page.evaluate(() => {
  const b = [...document.querySelectorAll('#drawer-menu [data-wb-drawer]')].find(x => x.dataset.wbDrawer === 'settings');
  if (b) b.click();
});
await new Promise(r=>setTimeout(r,500));
await page.$eval('#s-apikey',(el,k)=>{el.value=k;el.dispatchEvent(new Event('change',{bubbles:true}));},API_KEY);
await page.click('#btn-set-back');
await new Promise(r=>setTimeout(r,500));

// 用新预设建键山雏
await page.click('#btn-chars');
await new Promise(r=>setTimeout(r,700));
await seedChar(page, '键山雏'); await new Promise(r=>setTimeout(r,600));
await page.reload({ waitUntil:'networkidle0' }); await sleep(400)   // [提速] 原 1800：探针实测 reload 后 app 就绪只要 ~1ms;


const greeting = await page.$$eval('.msg .bub', els => els.map(e=>e.textContent.trim()));
console.log('=== 开场白 ===');
console.log(greeting[0]);
console.log('');

console.log('=== 实测对话（看是否还疏离）===');
const cases = ['在吗？我想你了', '能抱抱你吗', '今天上班好累啊'];
for (const c of cases) {
  console.log('我 > ' + c);
  const r = await say(c);
  console.log('她 < ' + r);
  console.log('');
}

await page.screenshot({ path: `${R}/e2e/60-恋爱向雏.png`, fullPage: false });

await browser.close();
server.close();
