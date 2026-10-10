// v1.21.49 复现：续写时模型只吐思考（reasoning）不吐正文时，界面会不会一直「思考中」、停止管不管用
import puppeteer from 'puppeteer-core';
import { seedChar } from './e2e-helper.mjs';
import http from 'http';
import fs from 'fs';
import path from 'path';
const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');
const WWW = `${R}/www`;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.png':'image/png' };
const site = http.createServer((req,res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = path.join(WWW, p);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f));
});
await new Promise(r => site.listen(0,'127.0.0.1',r));
const port = site.address().port;
// mock 模型：只吐 reasoning_content，永远不吐 content、也不发 [DONE]（模拟它一直在想）
let closed = 0;
const mock = http.createServer((req,res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'*'}); return res.end(); }
  res.writeHead(200, { 'Content-Type':'text/event-stream','Cache-Control':'no-cache','Access-Control-Allow-Origin':'*' });
  let i = 0;
  const t = setInterval(() => {
    i++;
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: '我在想第' + i + '件事。' } }] }) + String.fromCharCode(10,10));
  }, 120);
  req.on('close', () => { clearInterval(t); closed++; res.end(); });
});
await new Promise(r => mock.listen(0,'127.0.0.1',r));
const mockPort = mock.address().port;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = [];
page.on('pageerror', e => errs.push(String(e.message)));
await page.goto('http://127.0.0.1:' + port + '/', { waitUntil:'networkidle0', timeout:40000 });
await sleep(1300);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion')); await sleep(600);
await page.reload({ waitUntil:'networkidle0' }); await sleep(1400);
await page.evaluate(async (u) => {
  const req = indexedDB.open('ai-companion');
  const db = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
  const cur = await new Promise((res) => { const t = db.transaction('kv','readonly').objectStore('kv').get('settings'); t.onsuccess = () => res((t.result && t.result.v) || {}); });
  const next = Object.assign({}, cur, { apiKey: 'sk-test', baseUrl: u, provider: 'deepseek', model: 'deepseek-flash' });
  await new Promise((res) => { const t = db.transaction('kv','readwrite'); t.objectStore('kv').put({ k:'settings', v: next }); t.oncomplete = res; });
  db.close();
}, 'http://127.0.0.1:' + mockPort);
await seedChar(page, '续写测试', { greeting: '（她抬头）' });
await page.reload({ waitUntil:'networkidle0' }); await sleep(1400);
await page.evaluate(() => { const c = [...document.querySelectorAll('#char-list .char-card')].find(x => x.textContent.includes('续写测试')); if (c) c.click(); });
await sleep(900);

console.log('=== 点续写 ===');
await page.evaluate(() => document.getElementById('btn-continue').click());
await sleep(6000);
const mid = await page.evaluate(() => {
  const ph = document.querySelector('.bub.dots');
  return {
    停止按钮可见: !document.getElementById('btn-stop').classList.contains('hidden'),
    还在思考中: !!ph,
    界面文字: (document.querySelector('#messages').textContent || '').slice(-40),
  };
});
console.log('6 秒后: ' + JSON.stringify(mid));
console.log('=== 点停止 ===');
await page.evaluate(() => document.getElementById('btn-stop').click());
await sleep(4000);
const after = await page.evaluate(() => ({
  停止按钮还可见: !document.getElementById('btn-stop').classList.contains('hidden'),
  发送按钮已回来: !document.getElementById('btn-send').classList.contains('hidden'),
  还在思考中: !!document.querySelector('.bub.dots'),
  toast: (document.getElementById('toast') || {}).textContent,
  errBub: (document.querySelector('.err-bub') || {}).textContent,
}));
console.log('停止 4 秒后: ' + JSON.stringify(after));
console.log('mock 收到的断开次数=' + closed);
console.log('JS 错误=' + JSON.stringify(errs.slice(0, 3)));
await browser.close(); site.close(); mock.close();