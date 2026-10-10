import puppeteer from 'puppeteer-core';
import { seedChar, tap, waitIdle } from './e2e-helper.mjs';
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
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 120000, args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = []; page.on('pageerror', e => errs.push(e.message));
const consoleErr = []; page.on('console', m => { if (m.type() === 'error') consoleErr.push(m.text()); });
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass=0, fail=0;
const t=(n,ok,ex='')=>{if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));}};

// 记忆任务走的是【非流式】，必须用 application/json 回，不能回 SSE
// （回错了会 SyntaxError，而且错误被吞在 step() 里，测试会以为"没触发"）
let memCalls = 0;
await page.setRequestInterception(true);
page.on('request', req => {
  const u = req.url();
  if (!u.includes('api.deepseek.com')) return req.continue();
  const cors = { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Headers':'*', 'Access-Control-Allow-Methods':'POST,OPTIONS' };
  if (req.method() === 'OPTIONS') return req.respond({ status:204, headers:cors });
  const body = req.postData() || '';
  const isMem = body.includes('记到心里') || body.includes('重新整理一遍');
  if (isMem) {
    memCalls++;
    return req.respond({ status:200, headers:{...cors,'Content-Type':'application/json'},
      body: JSON.stringify({ choices:[{ message:{ content: JSON.stringify([{text:'他喜欢红茶',kind:'fact',untilDay:null,freq:'normal'}]) } }] }) });
  }
  req.respond({ status:200, headers:{...cors,'Content-Type':'text/event-stream'},
    body: 'data: {"choices":[{"delta":{"content":"嗯。"}}]}\n\ndata: [DONE]\n\n' });
});

await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
await sleep(600);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil:'networkidle0' }); await sleep(500);

// 造一个"积压"角色：600 条未归档消息、archiveKeep=40、autoArchive 开着。
// 这正是用户真实数据踩到的场景（他那台是 1990 条，从装包起一条都没归档过）。
const CID = 'pipeline-test';
await seedChar(page, '积压测试', { id: CID, greeting:'（开场）', longMemory:true, extra:{} });
await page.evaluate(async (id) => {
  const o = indexedDB.open('ai-companion', 2);
  const db = await new Promise(r => o.onsuccess = () => r(o.result));
  // 600 条消息
  for (let i = 0; i < 600; i += 50) {
    const tx = db.transaction('messages','readwrite'); const st = tx.objectStore('messages');
    for (let j = i; j < i + 50 && j < 600; j++) {
      st.put({ id:'p'+j, charId:id, role:(j%2?'assistant':'user'), content:'积压消息'+j, ts:Date.now()+j });
    }
    await new Promise(r => tx.oncomplete = r);
  }
  // 设置：archiveKeep 很小 + autoArchive 开
  const ktx = db.transaction('kv','readwrite'); const kv = ktx.objectStore('kv');
  const cur = await new Promise(r => { const q = kv.get('settings'); q.onsuccess = () => r(q.result ? q.result.v : {}); });
  kv.put({ k:'settings', v: Object.assign({}, cur, {
    apiKey:'sk-test-fake', baseUrl:'https://api.deepseek.com', model:'deepseek-flash',
    archiveKeep: 40, autoArchive: true, memSummarizeEvery: 60, memDedupeEvery: 15, memLimit: 25,
  })});
  kv.put({ k:'lastCharId', v: id });
  await new Promise(r => ktx.oncomplete = r);
  db.close();
}, CID);

await page.reload({ waitUntil: 'networkidle0' }); await sleep(800);

const snap = async () => await page.evaluate(async (id) => {
  const o = indexedDB.open('ai-companion', 2);
  const db = await new Promise(r => o.onsuccess = () => r(o.result));
  const idx = db.transaction('messages').objectStore('messages').index('charId_ts');
  const all = await new Promise(r => { const q = idx.getAll(IDBKeyRange.bound([id,-Infinity],[id,Infinity])); q.onsuccess = () => r(q.result); });
  const ks = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').getAllKeys(); q.onsuccess = () => r(q.result); });
  const keys = {};
  for (const k of ks.filter(k => typeof k === 'string' && /^(msgSeq|memSumAt|memDedupeAt|memArchiveLastAt):/.test(k))) {
    keys[k] = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => r(q.result ? q.result.v : null); });
  }
  db.close();
  return { total: all.length, archived: all.filter(m => m.archived).length, keys };
}, CID);

console.log('=== 1. 前置：造出积压现场 ===');
const s0 = await snap();
console.log('   消息 ' + s0.total + ' 条，已归档 ' + s0.archived + ' 条');
t('造出 600 条未归档积压', s0.total === 600 && s0.archived === 0, JSON.stringify({total:s0.total, archived:s0.archived}));

console.log('');
console.log('=== 2. 发一条消息 → 归档链路应当自己跑起来 ===');
// 关键：这一条断言的是"用户什么都不用做，积压会自己开始消化"。
// 以前四个记忆任务串行无隔离，autoArchiveIfNeeded 排最后——
// 前面任一步抛错它就永远轮不到，积压从装包那天起就没动过（真实数据实测 1990 条）。
await tap(page, '#input');
await page.type('#input', '在吗', { delay: 8 });
await page.evaluate(() => document.getElementById('btn-send').click());
// 等归档真的发生（轮询到"已归档 > 0"，最多 40 秒）
let s1 = null;
for (let i = 0; i < 100; i++) {
  await sleep(400);
  s1 = await snap();
  if (s1.archived > 0) break;
}
console.log('   归档后: 消息 ' + s1.total + ' 条，已归档 ' + s1.archived + ' 条');
t('归档自动跑起来了（已归档 > 0）', s1.archived > 0, 'archived=' + s1.archived);

console.log('');
console.log('=== 3. 单次归档有上限（不是一口气全收）===');
// AUTO_ARCHIVE_MAX = 200。500 条可归档时，一次不该收超过 200+余量。
// 没有这个上限的话，1990 条会一次跑 49 批 API，要十几分钟且中途失败停半路。
t('单次归档不超过 220 条（AUTO_ARCHIVE_MAX=200 生效）', s1.archived <= 220, 'archived=' + s1.archived);

console.log('');
console.log('=== 4. 再发几条 → 积压持续收敛 ===');
let prev = s1.archived;
for (let round = 0; round < 2; round++) {
  await tap(page, '#input');
  await page.type('#input', '继续' + round, { delay: 8 });
  await page.evaluate(() => document.getElementById('btn-send').click());
  await sleep(12000);
  const s = await snap();
  console.log('   第 ' + (round+2) + ' 轮: 已归档 ' + s.archived);
  prev = s.archived;
}
t('积压持续收敛（第 3 轮时 > 第 1 轮）', prev > s1.archived, s1.archived + ' -> ' + prev);

console.log('');
console.log('=== 5. 记账键已写入（说明自动链路确实走到了）===');
const s2 = await snap();
console.log('   ' + JSON.stringify(s2.keys));
t('msgSeq 已写入', typeof s2.keys['msgSeq:' + CID] === 'number', JSON.stringify(s2.keys));
t('memArchiveLastAt 已写入（自动归档跑过）', typeof s2.keys['memArchiveLastAt:' + CID] === 'number', JSON.stringify(s2.keys));

console.log('');
console.log('=== 6. 没有记忆任务报错 ===');
const memErrs = consoleErr.filter(x => x.includes('记忆任务'));
t('四个子任务都没有抛错', memErrs.length === 0, memErrs.join(' | ').slice(0, 200));

console.log('');
console.log('  记忆类 API 调用: ' + memCalls + ' 次');
console.log('  JS 错误: ' + (errs.length ? errs.join(' | ') : '无'));
t('无 JS 报错', errs.length === 0, errs.join(' | '));

console.log('');
console.log('结果: pass=' + pass + ' fail=' + fail);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
