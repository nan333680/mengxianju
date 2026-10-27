// live-proactive.mjs —— 真 key 验「主动开场」（v2 §4.8）：她该不该先开口
// （不进回归：文件名不是 e2e-*.mjs）
//
// 两组合成现场，只差 relation.bond 一个变量：
//   PRO1 bond=5 → 满足全部条件（单聊 / 最后一条是她 / 隔 7 小时 / 今天没开口 / 掷签 0.1<0.3）→ 应该先开口
//   PRO0 bond=0 → 不满足「够熟」→ 一句话都不该说
// 用法：$env:DSH_API_KEY='...'; node e2e/live-proactive.mjs
import puppeteer from 'puppeteer-core';
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
// 掷签只放行 maybeProactiveOpen 那一次；cadence 等的随机照旧
await page.evaluateOnNewDocument(() => {
  const orig = Math.random;
  Object.defineProperty(Math, 'random', { value: function () {
    try { if (String(new Error().stack || '').indexOf('maybeProactiveOpen') >= 0) return 0.1; } catch (e) {}
    return orig();
  }, writable: true, configurable: true });
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
const N = String.fromCharCode(10);

function charObj(id, name) {
  return { id, name, greeting: '（' + name + '靠在门边，抬了下眼）', persona: '你是' + name + '，二十岁，脾气直，句子短，不爱解释。', avatar: null,
    temperature: 1.0, maxTokens: 2048, topP: 1.0, reasoningEffort: 'low', contextRounds: 20,
    kaomojiFreq: 0, emojiFreq: 0, verbosity: 'medium', splitMessages: true, typingDelay: 0.15,
    hesitation: false, showTyping: true, longMemory: false, allowEditMine: false,
    descLevel: 'high', detailDrive: 'max', povLock: false, appearance: '', appearanceOn: true, presetKey: 'blank', createdAt: Date.now() };
}

await page.goto('http://127.0.0.1:' + port + '/index.html', { waitUntil: 'domcontentloaded' });
await sleep(1000);

// 造现场：两个角色各一条 7 小时前的 assistant 消息，只差 bond
await page.evaluate(async (k, a, b) => {
  const db = await new Promise((res, rej) => { const rq = indexedDB.open('ai-companion'); rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); });
  const put = (s, v) => new Promise((res, rej) => { const tx = db.transaction(s, 'readwrite'); tx.objectStore(s).put(v); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  const now = Date.now();
  const old = now - 7 * 3600 * 1000;
  await put('characters', a);
  await put('characters', b);
  await put('messages', { id: 'm-' + a.id, charId: a.id, role: 'assistant', content: '（把手机扣在膝盖上）行，那你去忙。', ts: old, archived: false });
  await put('messages', { id: 'm-' + b.id, charId: b.id, role: 'assistant', content: '（把手机扣在膝盖上）行，那你去忙。', ts: old, archived: false });
  await put('kv', { k: 'psyche:' + a.id, v: { v: 1, relation: { warmth: 2, trust: 2, bond: 5, since: now - 86400000 } } });
  await put('kv', { k: 'psyche:' + b.id, v: { v: 1, relation: { warmth: 0, trust: 0, bond: 0, since: now } } });
  await put('kv', { k: 'settings', v: { apiKey: k, baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', clockMode: false, liveV2: true } });
  await put('kv', { k: 'lastCharId', v: a.id });
  db.close();
}, KEY, charObj('PRO1', '阿绫'), charObj('PRO0', '冷冷'));

async function openAs(cid) {
  await page.evaluate(async (c) => {
    const db = await new Promise((res, rej) => { const rq = indexedDB.open('ai-companion'); rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); });
    await new Promise((res, rej) => { const tx = db.transaction(['kv'], 'readwrite'); tx.objectStore('kv').put({ k: 'lastCharId', v: c }); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    db.close();
  }, cid);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(3000);
}
async function proactiveMsgs(cid) {
  return await page.evaluate(async (c) => {
    const db = await new Promise((res, rej) => { const rq = indexedDB.open('ai-companion'); rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); });
    const all = await new Promise(r => { const q = db.transaction(['messages'], 'readonly').objectStore('messages').getAll(); q.onsuccess = () => r(q.result); });
    db.close();
    return all.filter(m => m.charId === c && m.proactive).map(m => ({ text: m.content, parent: !!m.parentId, len: String(m.content).length, ts: m.ts }));
  }, cid);
}

console.log('[熟] bond=5，隔 7 小时，掷签放行 —— 等她先开口…');
await openAs('PRO1');
let got = [];
for (let i = 0; i < 40 && got.length === 0; i++) { await sleep(1000); got = await proactiveMsgs('PRO1'); }
console.log('  主动消息：' + (got.length ? got.map(x => '「' + x.text + '」').join(' / ') : '（没有）'));
if (got[0]) console.log('  字数=' + got[0].len + ' 带parentId=' + got[0].parent);

console.log('[生] bond=0，同样隔 7 小时 —— 不该主动…');
await openAs('PRO0');
await sleep(6000);
const got2 = await proactiveMsgs('PRO0');
console.log('  主动消息：' + (got2.length ? got2.map(x => '「' + x.text + '」').join(' / ') : '（没有）'));

const ok1 = got.length === 1 && got[0].len <= 60 && got[0].parent && !/^在吗[？?。！!]*$/.test(got[0].text);
const ok2 = got2.length === 0;
const pass = (ok1 ? 1 : 0) + (ok2 ? 1 : 0);
console.log('');
console.log('通过 ' + pass + ' 项 / 失败 ' + (2 - pass) + ' 项');
console.log('  够熟会先开口：' + (ok1 ? 'OK' : 'FAIL'));
console.log('  不熟不开口：' + (ok2 ? 'OK' : 'FAIL'));
console.log('  页内异常：' + errs.length + (errs.length ? ' | ' + errs.slice(0, 3).join(' || ') : ''));
await browser.close();
server.close();
process.exit(pass === 2 ? 0 : 1);
