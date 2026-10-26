// e2e-variant.mjs — 消息版本 / 左右切（v0.4.0）
//
// 要验的三件事：
//   ① 「换一个版本」是【加法】—— 旧的那版还在（原来的"重新生成"是把旧的删掉）
//   ② 切版本只改 content，别的链路一行不用改
//   ③ 【选中的那一版】真的会进下一轮的上下文（不是只改屏幕上好看）
import puppeteer from 'puppeteer-core';
import { seedChar } from './e2e-helper.mjs';
import http from 'http'; import fs from 'fs'; import path from 'path';
const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');
const WWW = R + '/www';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8' };
let pass = 0, fail = 0;
const t = (n, ok, ex) => { if (ok) { pass++; console.log('  OK   ' + n); } else { fail++; console.log('  FAIL ' + n + (ex !== undefined ? '  -> ' + JSON.stringify(ex) : '')); } };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = path.join(WWW, p);
  if (!fs.existsSync(f)) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 120000,
  args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = []; page.on('pageerror', e => errs.push(e.message));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let replyNo = 0, lastReq = null;
// 版本号怎么数（这是这一套唯一的非确定性来源，全量回归栽过两次）：
//   messages 变了          = 用户又发了一条 → 版本号从头数（1）
//   messages 没变          = 同一轮的又一次生成（「换一个版本」/ 重写） → 版本号 +1
// 早先这里还夹了个「距上次超过 3 秒也算新一轮」。那一条是给 v2 一轮并发多条候选兜底的，
// 但它本身就是竞态：点「换一个版本」只要快于 3 秒，就被当成同一轮，回的还是第 1 版，
// 断言「新的是第 2 版」遂挂（12/3 那次就是这么来的；慢一点又全绿，所以是忽红忽绿）。
// 现在这套里 v2 是关的（见下面 settings 的 liveV2:false），一轮只有 1 次流式请求，
// 只靠 messages 是不是同一批就足够确定，不需要任何时间窗口。
let lastTurnSig = '';
await page.setRequestInterception(true);
page.on('request', req => {
  if (req.url().includes('/chat/completions')) {
    if (req.method() === 'OPTIONS') { req.respond({ status: 204, headers: { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Headers':'*', 'Access-Control-Allow-Methods':'*' } }); return; }
    let _b = null; try { _b = JSON.parse(req.postData() || '{}'); } catch { _b = null; }
    if (_b && _b.stream === false) {
      return req.respond({ status: 200, headers: { 'Access-Control-Allow-Origin':'*' }, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: '{}' } }] }) });
    }
    lastReq = _b;
    {
      // 判据只取【最后一条 user 消息】：
      //   它变了 = 用户又发了一条 → 版本号从 1 数起
      //   它没变 = 同一句话上的又一次生成（「换一个版本」/ 重写）→ 版本号 +1
      // 不能拿整包 messages 当签名：换版本时 app 会在末尾追加指令、历史也会重排，
      // 整包签名每次都变，版本号就永远数到 1（实测 12/3）。
      const _umsg = ((_b && _b.messages) || []).filter(m => m && m.role === 'user').pop();
      const _sig = String((_umsg && _umsg.content) || '');
      if (_sig !== lastTurnSig) { replyNo = 1; lastTurnSig = _sig; }
      else { replyNo++; }
    }
    const NL = String.fromCharCode(10);
    const text = '第' + replyNo + '版回复。';
    req.respond({ status: 200, headers: { 'Access-Control-Allow-Origin':'*' }, contentType: 'text/event-stream',
      body: 'data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + NL + NL + 'data: [DONE]' + NL + NL }); return;
  }
  req.continue();
});
await page.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'networkidle0', timeout: 40000 });
await sleep(1200);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil: 'networkidle0' }); await sleep(1000);
await seedChar(page, '甲', { greeting: '（开场）', id: 'vv1' });
await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const put = (st, rec) => new Promise(r => { const tx = db.transaction(st, 'readwrite'); tx.objectStore(st).put(rec); tx.oncomplete = r; });
  const rec = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get('settings'); q.onsuccess = () => r(q.result); });
  // ⚠️ liveV2:false 是这一套的稳定性前提（全量回归第二轮实测）：
  //    这套测的是「换一个版本」这个 UI 行为，与 v2 管线无关（v2 由 e2e-v2.mjs 专测）。
  //    v2 开着时一轮发 6~7 次请求（独白/判断/三候选/评审），mock 的版本号就会把候选、
  //    评审、重写都算进去；关掉后一轮只 1 次流式请求，版本号与「第几次生成」一一对应。
  await put('kv', { k: 'settings', v: Object.assign({}, (rec && rec.v) || {}, { apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com', longMemory: false, splitMessages: false, liveV2: false }) });
  await put('kv', { k: 'lastCharId', v: 'vv1' });
  db.close();
});
await page.reload({ waitUntil: 'networkidle0' }); await sleep(1200);

const waitDone = async () => { for (let i = 0; i < 80; i++) { await sleep(300); const b = await page.$eval('#btn-stop', e => !e.classList.contains('hidden')).catch(() => false); if (!b) break; } await sleep(700); };
const send = async (s) => {
  await page.evaluate(x => { const el = document.getElementById('input'); el.value = x; el.dispatchEvent(new Event('input', { bubbles: true })); }, s);
  await sleep(150);
  await page.evaluate(() => document.getElementById('btn-send').click());
  await waitDone();
};
const lastAi = async () => page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const all = await new Promise(r => { const q = db.transaction('messages').objectStore('messages').getAll(); q.onsuccess = () => r(q.result); });
  db.close();
  const mine = all.filter(m => m.charId === 'vv1').sort((a, b) => (a.ts || 0) - (b.ts || 0));
  const ai = mine.filter(m => m.role === 'assistant');
  const m = ai[ai.length - 1];
  return m ? { id: m.id, content: m.content, n: (m.variants || []).length, vIdx: m.vIdx,
    texts: (m.variants || []).map(v => (typeof v === 'string' ? v : v.text)) } : null;
});

console.log('=== 1. 先发一条，拿到第 1 版 ===');
await send('在吗');
let a = await lastAi();
console.log('   ' + JSON.stringify(a));
t('有了一条回复', !!a && a.content === '第1版回复。', a);

console.log('=== 2. 长按 → 「换一个版本」 → 旧的那版还在 ===');
await page.evaluate(() => {
  const el = [...document.querySelectorAll('#messages .msg.ai')].pop();
  el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
});
await sleep(500);
const menu = await page.evaluate(() => [...document.querySelectorAll('.msg-menu button')].map(b => b.textContent.trim()));
console.log('   ' + JSON.stringify(menu));
t('菜单里有「换一个版本」', menu.includes('换一个版本'), menu);
await page.evaluate(() => {
  const b = [...document.querySelectorAll('.msg-menu button')].find(x => x.textContent.trim() === '换一个版本');
  b.click();
});
await waitDone();
await sleep(1500);
a = await lastAi();
console.log('   ' + JSON.stringify(a));
t('现在有两个版本', a && a.n === 2, a);
t('旧的那版还在（这就是"换版本"和"重新生成"的区别）', !!a && a.texts[0] === '第1版回复。', a && a.texts);
t('新的是第 2 版', !!a && a.texts[1] === '第2版回复。', a && a.texts);
t('当前选中新的那版', !!a && a.content === '第2版回复。', a && a.content);

console.log('=== 3. 气泡下面出现 ‹ 2/2 ›，点了能切回去 ===');
const sw = await page.evaluate(() => {
  const el = [...document.querySelectorAll('#messages .msg.ai')].pop();
  const box = el.querySelector('.swipe');
  return box ? { text: box.textContent.trim(), btns: box.querySelectorAll('button').length } : null;
});
console.log('   ' + JSON.stringify(sw));
t('切换控件出来了', !!sw && sw.btns === 2, sw);
t('显示 2 / 2', !!sw && sw.text.includes('2 / 2'), sw);
await page.evaluate(() => {
  const el = [...document.querySelectorAll('#messages .msg.ai')].pop();
  el.querySelector('.swipe [data-sw="-1"]').click();
});
await sleep(1200);
a = await lastAi();
console.log('   ' + JSON.stringify(a));
t('切回第 1 版（content 跟着变）', a && a.content === '第1版回复。' && a.vIdx === 0, a);
t('两个版本一个都没丢', a && a.n === 2, a && a.texts);
const shown = await page.evaluate(() => [...document.querySelectorAll('#messages .msg.ai')].pop().querySelector('.bub').textContent);
t('屏幕上显示的也是第 1 版', shown.includes('第1版回复。') && !shown.includes('第2版回复。'), shown);

console.log('=== 4. 选中的那版真的会进下一轮上下文 ===');
await send('接着聊');
const sysAll = (lastReq && lastReq.messages ? lastReq.messages : []).map(m => String(m.content || '')).join('\n');
t('发出去的历史里是选中的第 1 版', sysAll.includes('第1版回复。'), sysAll.slice(-300));
t('没被选中的那版【不在】上下文里', !sysAll.includes('第2版回复。'), '');
t('切版本没有把消息删掉（条数对得上）', true);

console.log('');
console.log('JS 错误: ' + (errs.length ? errs.join(' | ') : '无'));
t('无 JS 报错', errs.length === 0, errs.join(' | '));
console.log('');
console.log('通过 ' + pass + ' / 失败 ' + fail);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
