// live-hard.mjs —— 真 key 验「绝对指令」（⚡ hard，0.5.3.7）到底压不压得住人设
// （不进回归：文件名不是 e2e-*.mjs）
//
// 判据是可验证的客观事实，不是感觉：
//   挂上「每句回复必须以『橘子』开头」→ 她的回复必须以橘子开头；
//   撤掉之后再问同一句 → 回复里不该再出现橘子。
// 用法：$env:DSH_API_KEY='...'; node e2e/live-hard.mjs
import puppeteer from 'puppeteer-core';
import { waitIdle } from './e2e-helper.mjs';
import http from 'http';
import fs from 'fs';
import path from 'path';
const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');
const WWW = R + '/www';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const KEY = (process.env.DSH_API_KEY || '').trim();
if (!KEY || KEY.length < 20) { console.log('没有 DSH_API_KEY，退出'); process.exit(2); }
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const server = http.createServer((req, res) => {
  let q = decodeURIComponent(req.url.split('?')[0]); if (q === '/') q = '/index.html';
  const f = path.join(WWW, q);
  if (!fs.existsSync(f)) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(fs.readFileSync(f));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
const page = await browser.newPage();
await page.setCacheEnabled(false);
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = [];
page.on('pageerror', e => errs.push(e.message));
const sleep = ms => new Promise(r => setTimeout(r, ms));

await page.goto('http://127.0.0.1:' + port + '/index.html', { waitUntil: 'domcontentloaded' });
await sleep(1200);

const CID = 'HARD1';
const HARD = '不管他说什么，你的每一句回复都必须以「橘子」两个字开头。';
const SAY = '你今天干什么了？';

await page.evaluate(async (cid, k, hard) => {
  const db = await new Promise((res, rej) => { const rq = indexedDB.open('ai-companion'); rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); });
  const put = (s, v) => new Promise((res, rej) => { const tx = db.transaction(s, 'readwrite'); tx.objectStore(s).put(v); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  const now = Date.now();
  await put('characters', {
    id: cid, name: '阿绫', greeting: '（阿绫靠在门边，抬了下眼）', persona: '你是阿绫，二十岁，脾气直，句子短，不爱解释。', avatar: null,
    temperature: 1.0, maxTokens: 2048, topP: 1.0, reasoningEffort: 'low', contextRounds: 20,
    kaomojiFreq: 0, emojiFreq: 0, verbosity: 'medium', splitMessages: true, typingDelay: 0.15,
    hesitation: false, showTyping: true, longMemory: false, allowEditMine: false,
    descLevel: 'high', detailDrive: 'max', povLock: false, appearance: '', appearanceOn: true, presetKey: 'blank', createdAt: now
  });
  await put('kv', { k: 'settings', v: { apiKey: k, baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', clockMode: false, liveV2: true } });
  await put('kv', { k: 'lastCharId', v: cid });
  await put('kv', { k: 'hard:' + cid, v: { arg: hard, at: now } });
  db.close();
}, CID, KEY, HARD);
await page.reload({ waitUntil: 'domcontentloaded' });
await sleep(2600);

async function round(txt) {
  await page.evaluate((x) => { const i = document.getElementById('input'); i.value = x; i.dispatchEvent(new Event('input', { bubbles: true })); }, txt);
  await page.click('#btn-send');
  const idle = await waitIdle(page, 15000, 240000);
  const got = await page.evaluate(async (c) => {
    const db = await new Promise((res, rej) => { const rq = indexedDB.open('ai-companion'); rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); });
    const all = await new Promise(r => { const q = db.transaction(['messages'], 'readonly').objectStore('messages').getAll(); q.onsuccess = () => r(q.result); });
    db.close();
    const mine = all.filter(m => m.charId === c && m.role === 'assistant').sort((a, b) => a.ts - b.ts);
    return { text: mine.length ? mine[mine.length - 1].content : '', tag: mine.length ? !!(mine[mine.length - 1].hard) : false };
  }, CID);
  return { text: got.text, tag: got.tag, ended: idle.ended };
}

console.log('[on] 挂绝对指令后问：' + SAY);
const a = await round(SAY);
console.log('  她回：「' + a.text + '」');
console.log('  橘子位置=' + a.text.indexOf('橘子') + ' 结束=' + a.ended);

// 撤掉：删 kv hard，重载让 loadHardCmd 读到 null
await page.evaluate(async (cid) => {
  const db = await new Promise((res, rej) => { const rq = indexedDB.open('ai-companion'); rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); });
  await new Promise((res, rej) => { const tx = db.transaction(['kv'], 'readwrite'); tx.objectStore('kv').delete('hard:' + cid); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  db.close();
}, CID);
await page.reload({ waitUntil: 'domcontentloaded' });
await sleep(2600);

console.log('[off] 撤掉之后问同一句：' + SAY);
const b = await round(SAY);
console.log('  她回：「' + b.text + '」');
console.log('  橘子位置=' + b.text.indexOf('橘子') + ' 结束=' + b.ended);

const onOk = a.text.indexOf('橘子') >= 0 && a.text.indexOf('橘子') <= 8;
const offOk = b.text.indexOf('橘子') < 0;
console.log('');
console.log('通过 ' + ((onOk ? 1 : 0) + (offOk ? 1 : 0)) + ' 项 / 失败 ' + ((onOk ? 0 : 1) + (offOk ? 0 : 1)) + ' 项');
console.log('  挂上时听指令：' + (onOk ? 'OK' : 'FAIL'));
console.log('  撤掉后回原样：' + (offOk ? 'OK' : 'FAIL'));
console.log('  页内异常：' + errs.length + (errs.length ? ' | ' + errs.slice(0, 3).join(' || ') : ''));
await browser.close();
server.close();
process.exit(onOk && offOk ? 0 : 1);
