// live-mem.mjs —— 真 key 真链路：长期记忆提炼的人称检查（不进回归：文件名不是 e2e-*.mjs）
//
// 为什么单独建一个：记忆条目是永久注入的东西，人称一旦写反，之后每一轮都在用错的那条。
// mock 只能证明「代码按约定走」，证明不了「真模型有没有把人称搞反」。
// 这里拿一段【外部传入的】真实对话当输入，跑一遍真提炼，把请求体和结果都打出来。
// 输入从命令行传（备份 json + 角色 id），脚本自己不记任何人的对话内容 ——
// 备份是拿来复现问题的，不是素材库。
import puppeteer from 'puppeteer-core';
import http from 'http';
import fs from 'fs';
import path from 'path';
const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');
const WWW = R + '/www';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const KEY = (process.env.DSH_API_KEY || '').trim();
if (!KEY || KEY.length < 20) { console.log('没有 DSH_API_KEY，退出'); process.exit(2); }
// 用法：node e2e/live-mem.mjs <备份.json> <charId>
// ⚠️ 不给默认值：这个脚本不该替谁记住备份放在哪，也不该默认某个人的某个角色。
const BAK = process.argv[2];
const CID = process.argv[3];
if (!BAK || !CID) { console.log('用法：node e2e/live-mem.mjs <备份.json> <charId>'); process.exit(2); }
const BAKJ = JSON.parse(fs.readFileSync(BAK, 'utf8'));
const CH = (BAKJ.characters || []).find(c => c && c.id === CID);
if (!CH) { console.log('备份里没有这个角色：' + CID); process.exit(2); }
const ALLMSG = ((BAKJ.messages || {})[CID] || []).slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));
// ⚠️ 只取最后 40 条：提炼窗口本来也只吃这么久（app.js 的 pending.slice(0, backlog-20)），
//    全量 seed 进去反而要重连父指针、还烧更多 token。
const MSGS = ALLMSG.slice(-40);
if (MSGS.length < 10) { console.log('这个角色的消息太少，没法提炼'); process.exit(2); }
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const server = http.createServer((req, res) => {
  let q = decodeURIComponent(req.url.split('?')[0]);
  if (q === '/') q = '/index.html';
  const f = path.join(WWW, q);
  if (!fs.existsSync(f)) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(fs.readFileSync(f));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
const page = await browser.newPage();
await page.setCacheEnabled(false);
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = [];
page.on('pageerror', e => errs.push(e.message));
const sleep = ms => new Promise(r => setTimeout(r, ms));
// 抓提炼请求（非流式 + system 里有「正在回顾」）
let memReq = null;
page.on('request', r => {
  if (r.method() !== 'POST') return;
  if (r.url().indexOf('/chat/completions') < 0) return;
  let b = {}; try { b = JSON.parse(r.postData() || '{}'); } catch (e) { return; }
  const all = ((b.messages || []).map(m => String(m.content || ''))).join(String.fromCharCode(10));
  if (b.stream === false && all.indexOf('正在回顾') >= 0) memReq = b;
});
await page.goto('http://127.0.0.1:' + port + '/index.html', { waitUntil: 'networkidle0' });
await sleep(400);
await page.evaluate(async (arg) => {
  const { key, ch, msgs } = arg;
  const db = await new Promise((res, rej) => { const rq = indexedDB.open('ai-companion'); rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); });
  const put = (s, v) => new Promise((res, rej) => { const tx = db.transaction(s, 'readwrite'); tx.objectStore(s).put(v); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  const now = Date.now();
  await put('characters', Object.assign({}, ch, {
    maxTokens: 220,           // 这一趟只关心记忆，回复短一点省钱
    longMemory: true,         // runMemTasks 的闸门
    splitMessages: false, typingDelay: 0.1,
    descLevel: 'high', detailDrive: 'max',
  }));
  let prev = '';
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    const id = 'LM' + String(i).padStart(4, '0');
    await put('messages', { id, charId: ch.id, role: m.role, content: m.content,
      parentId: i === 0 ? '' : prev, ts: now - (msgs.length - i) * 60000 });
    prev = id;
  }
  await put('kv', { k: 'settings', v: {
    apiKey: key, baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', clockMode: false,
    liveV2: false,                 // 这一趟测记忆，不测 v2
    userName: '',                  // ← 关键：没设名字（用户实际就是这样）
    memSummarizeEvery: 1, memLimit: 40, memDedupeEvery: 999,
    longMemory: true
  } });
  await put('kv', { k: 'lastCharId', v: ch.id });
  db.close();
}, { key: KEY, ch: CH, msgs: MSGS });
await page.reload({ waitUntil: 'domcontentloaded' });
await sleep(1200);
console.log('=== 发送一条，触发提炼 ===');
await page.evaluate(() => { const el = document.getElementById('input'); el.value = '你今天怎么这么安静'; el.dispatchEvent(new Event('input', { bubbles: true })); });
await sleep(200);
await page.evaluate(() => document.getElementById('btn-send').click());
// 等提炼请求出去 + 落库（真模型 15~40 秒）
let waited = 0;
while (waited < 90000) {
  await sleep(1000); waited += 1000;
  const done = await page.evaluate(async (cid) => {
    const db = await new Promise((res, rej) => { const rq = indexedDB.open('ai-companion'); rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); });
    const list = await new Promise((res, rej) => { const tx = db.transaction('memories', 'readonly'); const rq = tx.objectStore('memories').getAll(); rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); });
    db.close();
    return list.filter(m => m && m.charId === cid).length;
  }, CH.id);
  if (done > 0 && memReq) break;
}
const out = await page.evaluate(async (cid) => {
  const db = await new Promise((res, rej) => { const rq = indexedDB.open('ai-companion'); rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); });
  const list = await new Promise((res, rej) => { const tx = db.transaction('memories', 'readonly'); const rq = tx.objectStore('memories').getAll(); rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); });
  db.close();
  return list.filter(m => m && m.charId === cid).map(m => ({ text: m.text, quote: m.quote, kind: m.kind, status: m.status }));
}, CH.id);
console.log('=== 提炼请求里的 system（前 2400 字）===');
const sysAll = memReq ? ((memReq.messages || []).filter(m => m.role === 'system').map(m => String(m.content || '')).join('\n---\n')) : '（没抓到提炼请求）';
console.log(sysAll.slice(0, 2400));
console.log('=== 提炼请求里的转录（前 900 字）===');
const userAll = memReq ? ((memReq.messages || []).filter(m => m.role === 'user').map(m => String(m.content || '')).join('\n')) : '';
console.log(userAll.slice(0, 900));
console.log('=== 落库的记忆 ' + out.length + ' 条 ===');
for (const m of out) console.log('[' + (m.status||'') + '|' + (m.kind||'') + '] ' + m.text + (m.quote ? '\n      原话: ' + m.quote : ''));
console.log('=== 页内错误 ' + errs.length + ' ===');
for (const e of errs.slice(0, 5)) console.log(e);
await browser.close();
server.close();