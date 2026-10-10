
import puppeteer from 'puppeteer-core';
import http from 'http';
import fs from 'fs';
import path from 'path';
// 工作目录自适应（原来写死 C:/A-DSH-Tool/ai-companion）
const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');

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

// 全量捕获
const logs = [];
page.on('console', m => logs.push('[' + m.type() + '] ' + m.text()));
page.on('pageerror', e => logs.push('[PAGEERROR] ' + e.message));
page.on('requestfailed', r => logs.push('[REQFAIL] ' + r.url().slice(0,80) + ' :: ' + (r.failure()?r.failure().errorText:'')));
page.on('response', async r => {
  if (r.url().includes('deepseek')) {
    logs.push('[RESP] ' + r.status() + ' ' + r.url().slice(0,60));
  }
});

// 记录每个时刻消息区状态
const snap = async (tag) => {
  const n = await page.$$eval('.msg', els => els.length);
  const txt = await page.$$eval('.msg .bub', els => els.map(e => e.textContent.trim().slice(0,24)));
  const stopVisible = await page.$eval('#btn-stop', el => !el.classList.contains('hidden')).catch(()=>false);
  logs.push('[SNAP ' + tag + '] msg数=' + n + ' 停止按钮=' + stopVisible + ' 内容=' + JSON.stringify(txt));
};

await page.goto('http://127.0.0.1:' + port + '/', { waitUntil:'networkidle0', timeout:40000 });
await new Promise(r=>setTimeout(r,1600));

// 全新状态：清掉旧数据后重载，模拟"第一次"
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil:'networkidle0' });
await sleep(400)   // [提速] 原 1800：探针实测 reload 后 app 就绪只要 ~1ms;

await snap('全新启动');

// 填 Key
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
await snap('填完Key');

console.log('=== 模拟：全新状态下立刻发第一条消息 ===');
await page.click('#input');
await page.type('#input', '你好', { delay: 12 });
await page.click('#btn-send');

// 高频采样，抓气泡消失的时刻
for (let i = 0; i < 40; i++) {
  await new Promise(r=>setTimeout(r,500));
  await snap('t+' + ((i+1)*0.5).toFixed(1) + 's');
  const busy = await page.$eval('#btn-stop', el => !el.classList.contains('hidden')).catch(()=>false);
  if (!busy && i > 2) break;
}

await new Promise(r=>setTimeout(r,1000));
await snap('结束');

console.log('');
console.log('=== 完整日志 ===');
logs.forEach(l => console.log('  ' + l));

await browser.close();
server.close();
