import puppeteer from 'puppeteer-core';
import { seedChar, tap, waitIdle } from './e2e-helper.mjs';
import http from 'http'; import fs from 'fs'; import path from 'path';
// 工作目录自适应（原来写死 C:/A-DSH-Tool/ai-companion）
const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');
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
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 120000, args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = []; page.on('pageerror', e => errs.push(e.message));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass=0, fail=0;
const t=(n,ok,ex='')=>{if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));}};

let memCalls = 0, sumCalls = 0, lastSummaryPrompt = '';
await page.setRequestInterception(true);
page.on('request', req => {
  const u = req.url();
  if (!u.includes('api.deepseek.com')) return req.continue();
  const cors = { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Headers':'*', 'Access-Control-Allow-Methods':'POST,OPTIONS' };
  if (req.method() === 'OPTIONS') return req.respond({ status:204, headers:cors });
  const body = req.postData() || '';
  const isSum = body.includes('维护一份【前情提要】');
  const isMem = body.includes('记到心里') || body.includes('重新整理一遍');
  const isTidy = body.includes('重新整理一遍');
  if (isSum) { sumCalls++; lastSummaryPrompt = body; }
  else if (isMem) memCalls++;
  if (isMem || isSum) {
    return req.respond({ status:200, headers:{...cors,'Content-Type':'application/json'},
      body: JSON.stringify({ choices:[{ message:{ content: isSum ? '我们约好了明天去买花，还欠着一顿团子。' : (isTidy ? JSON.stringify([{text:'整理后的',kind:'fact',untilDay:null,freq:'normal'}]) : (isMem ? JSON.stringify([{text:'他喜欢红茶',kind:'fact',untilDay:null,freq:'normal'}]) : '[]')) } }] }) });
  }
  req.respond({ status:200, headers:{...cors,'Content-Type':'text/event-stream'},
    body: 'data: {"choices":[{"delta":{"content":"嗯。"}}]}\n\ndata: [DONE]\n\n' });
});

await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
await sleep(600);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil:'networkidle0' }); await sleep(500);

const CID = 'rolling-test';
await seedChar(page, '摘要测试', { id: CID, greeting:'（开场）', longMemory:true });
await page.evaluate(async (id) => {
  const o = indexedDB.open('ai-companion', 2);
  const db = await new Promise(r => o.onsuccess = () => r(o.result));
  for (let i = 0; i < 300; i += 50) {
    const tx = db.transaction('messages','readwrite'); const st = tx.objectStore('messages');
    for (let j = i; j < i + 50 && j < 300; j++) {
      st.put({ id:'r'+j, charId:id, role:(j%2?'assistant':'user'), content:'第'+j+'句：这轮聊的是花和团子。', ts:Date.now()+j });
    }
    await new Promise(r => tx.oncomplete = r);
  }
  const ktx = db.transaction('kv','readwrite'); const kv = ktx.objectStore('kv');
  const cur = await new Promise(r => { const q = kv.get('settings'); q.onsuccess = () => r(q.result ? q.result.v : {}); });
  kv.put({ k:'settings', v: Object.assign({}, cur, {
    apiKey:'sk-test-fake', baseUrl:'https://api.deepseek.com', model:'deepseek-flash',
    archiveKeep: 40, autoArchive: true, memSummarizeEvery: 60, memLimit: 25,
  })});
  kv.put({ k:'lastCharId', v: id });
  await new Promise(r => ktx.oncomplete = r);
  db.close();
}, CID);
await page.reload({ waitUntil:'networkidle0' }); await sleep(800);

const getRolling = async () => await page.evaluate(async (id) => {
  const o = indexedDB.open('ai-companion', 2);
  const db = await new Promise(r => o.onsuccess = () => r(o.result));
  const q = db.transaction('kv').objectStore('kv').get('memRolling:' + id);
  const v = await new Promise(r => { q.onsuccess = () => r(q.result ? q.result.v : null); });
  db.close();
  return v;
}, CID);

const snap = async () => await page.evaluate(async (id) => {
  const o = indexedDB.open('ai-companion', 2);
  const db = await new Promise(r => o.onsuccess = () => r(o.result));
  const idx = db.transaction('messages').objectStore('messages').index('charId_ts');
  const all = await new Promise(r => { const q = idx.getAll(IDBKeyRange.bound([id,-Infinity],[id,Infinity])); q.onsuccess = () => r(q.result); });
  db.close();
  return { total: all.length, archived: all.filter(m => m.archived).length };
}, CID);

console.log('=== 1. 前置 ===');
const s0 = await snap();
console.log('   消息 ' + s0.total + ' 条，已归档 ' + s0.archived);
t('造出 300 条积压', s0.total === 300 && s0.archived === 0);

console.log('');
console.log('=== 2. 发一条 → 触发归档 → 生成滚动摘要 ===');
await tap(page, '#input');
await page.type('#input', '在吗', { delay: 8 });
await page.evaluate(() => document.getElementById('btn-send').click());
let s1 = null;
for (let i = 0; i < 100; i++) {
  await sleep(400);
  s1 = await snap();
  if (s1.archived > 0) break;
}
await sleep(3000);
console.log('   已归档 ' + s1.archived + ' 条，摘要生成调用 ' + sumCalls + ' 次');
t('归档跑起来了', s1.archived > 0, 'archived=' + s1.archived);
t('滚动摘要被生成', sumCalls > 0, 'sumCalls=' + sumCalls);

console.log('');
console.log('=== 3. 摘要落库了 ===');
const roll = await getRolling();
console.log('   ' + JSON.stringify(roll).slice(0, 200));
t('memRolling 已写入', !!roll && typeof roll.text === 'string' && roll.text.length > 0, JSON.stringify(roll).slice(0,120));
t('摘要不是空的（兜底或模型都行）', roll && roll.text.length > 0, roll ? roll.text.length + ' 字' : 'null');

console.log('');
console.log('=== 4. 摘要被注入了请求（这是关键）===');
// 发第二条，检查请求体里带上滚动摘要
lastSummaryPrompt = '';
await tap(page, '#input');
await page.type('#input', '第二条', { delay: 8 });
const reqBodies = [];
page.on('request', r => { if (r.url().includes('deepseek')) reqBodies.push(r.postData() || ''); });
await page.evaluate(() => document.getElementById('btn-send').click());
await sleep(6000);
const chatReq = reqBodies.find(b => b.includes('之前发生过的事'));
console.log('   抓到 ' + reqBodies.length + ' 个请求，含摘要段的：' + (chatReq ? '有' : '无'));
t('聊天请求里带上了「之前发生过的事」段', !!chatReq, JSON.stringify(reqBodies.map(b=>b.slice(0,60))));
if (chatReq) {
  const m = chatReq.match(/之前发生过的事[^"]{0,200}/);
  console.log('   摘要在请求里的样子: ' + (m ? m[0].slice(0,160) : '(未提取到)'));
}

console.log('');
console.log('=== 5. 摘要长度受控（没超上限）===');
t('摘要 ≤ 600 字', roll && roll.text.length <= 600, roll ? roll.text.length + ' 字' : 'null');

console.log('');
console.log('JS 错误: ' + (errs.length ? errs.join(' | ') : '无'));
t('无 JS 报错', errs.length === 0, errs.join(' | '));
console.log('结果: pass=' + pass + ' fail=' + fail);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
