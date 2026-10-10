// 400 错误的【原文透传】（v1.21.54 修）—— 一个既有缺陷的防回归。
//
// 缺陷：postChat 在 400/422 时会把响应体读出来，查是不是某个可选字段惹的祸
// （reasoning_effort / stream_options）。而 Response 的 body 只能读一次 ——
// 下游 streamChat 再 res.text() 只能拿到空串，于是错误提示永远是
//     API 错误 400: Bad Request
// 服务端明明白白写的原因（哪个字段不认、模型不存在、上下文超长）全被丢掉了。
//
// 要看的现象：发一条消息、服务端回 400 带一句话，界面上弹出的提示里
// 【必须有那句话】。
import puppeteer from 'puppeteer-core';
import { seedChar } from './e2e-helper.mjs';
import http from 'http'; import fs from 'fs'; import path from 'path';
const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');
const WWW = R + '/www';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = path.join(WWW, p);
  if (!fs.existsSync(f)) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 120000, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = []; page.on('pageerror', e => errs.push(e.message));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const t = (n, ok, ex = '') => { if (ok) { pass++; console.log('  OK   ' + n); } else { fail++; console.log('  FAIL ' + n + (ex ? '  -> ' + ex : '')); } };

// 服务端要说的话 —— 特意选一句【不含 reasoning_effort / stream_options】的，
// 免得 postChat 的字段降级抢在前面把请求重发一遍，掩盖了这里要测的东西。
const SERVER_SAYS = '模型 foo-bar-9 不存在，请检查模型名';

await page.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'networkidle0', timeout: 40000 });
await sleep(1500);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil: 'networkidle0' }); await sleep(1200);
// v1.21.59：全新安装不再自动建角色（产品改空），测试自己塞一个
await seedChar(page, '测试角色', { greeting: '' });   // 空开场白：不额外多出一条消息
await page.reload({waitUntil:'networkidle0'}); await sleep(500);

console.log('=== 1. 准备设置 ===');
const cid = await page.evaluate(async () => {
  const { kv } = await import('./js/db.js');
  const s = (await kv.get('settings', {})) || {};
  const id = await kv.get('lastCharId', null);
  s.apiKey = 'sk-test'; s.baseUrl = 'https://api.deepseek.com'; s.model = 'foo-bar-9';
  s.longMemory = false; s.autoArchive = false; s.searchOn = false; s.worldbookOn = false;
  await kv.set('settings', s);
  return id;
});
t('拿到角色 id', !!cid);
await page.reload({ waitUntil: 'networkidle0' }); await sleep(1200);

console.log('');
console.log('=== 2. 服务端一律回 400，带一句人话 ===');
let hits = 0;
await page.setRequestInterception(true);
page.on('request', (req) => {
  const u = req.url();
  if (u.includes('/chat/completions')) {
    if (req.method() === 'OPTIONS') {
      return req.respond({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': '*' } }).catch(() => {});
    }
    hits++;
    return req.respond({
      status: 400,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: { message: SERVER_SAYS, type: 'invalid_request_error' } })
    }).catch(() => {});
  }
  try { req.continue(); } catch (e) {}
});

await page.click('#input');
await page.type('#input', '在吗', { delay: 4 });
await page.click('#btn-send');

// 失败是写进【消息区】的（占位气泡换成一条"没发出去"），不是 toast ——
// 所以看 #messages 的文本，不要看 #toast（第一版就盯错了地方，抓到一片空）。
let shown = '';
for (let i = 0; i < 120; i++) {
  shown = await page.evaluate(() => {
    const a = document.getElementById('messages');
    const b = document.getElementById('toast');
    return ((a && a.textContent) || '') + ' || ' + ((b && b.textContent) || '');
  });
  if (/没发出去|发送失败/.test(shown)) break;
  await sleep(250);
}

console.log('');
console.log('=== 3. 看现象 ===');
t('请求确实发出去了（且被拒）', hits >= 1, hits + ' 次');
console.log('       界面上出现的：' + JSON.stringify(shown.slice(-320)));
// ★ 这一条就是这个套件存在的理由
t('★ 界面上带着服务端的原话', shown.includes(SERVER_SAYS), JSON.stringify(shown.slice(-200)));
t('★ 不再是空壳的「API 错误 400: Bad Request」', !shown.includes('API 错误 400: Bad Request'), JSON.stringify(shown.slice(-200)));
t('没有 JS 报错', errs.length === 0, errs.join(' | '));

console.log('');
console.log('通过 ' + pass + ' / 失败 ' + fail);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
