// e2e-memsum.mjs —— 总结判据重构验证（v1.20.15）
//
// 背景：memSumAt 这个键同时存过两种量纲（序号 / 条数），护栏怎么写都堵不严：
//   · 序号 > 条数 → 归零 → 差值虚高，把已总结的又算一遍（白花 token）
//   · 序号 < 条数 → 放行 → 差值偏小/为负 → 该总结的不总结（永久卡死）
// 实测用户数据：小恶魔 70 条待总结、memSumAt=22 → 70-22=48 < 50 → 记忆一直是空的。
//
// 现在判据直接数 pendingNow.length（= 未进 memSummed 的消息条数），
// 不存在第二种量纲能污染它。

import puppeteer from 'puppeteer-core';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { readCode } from './e2e-src.mjs';
// 工作目录自适应（原来写死 C:/A-DSH-Tool/ai-companion）
const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');

const WWW = `${R}/www`;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
// ⚠️ v1.21.40：产品默认 apiKey 已改成空串（预置的那把反编译就能拿走，已移除）。
// 本套件要真调模型，Key 只能自己给 —— 环境变量优先，没有就用占位符。
const KEY = process.env.DSH_API_KEY || 'sk-test';
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8' };
const server = http.createServer((req,res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p==='/') p='/index.html';
  const f = path.join(WWW, p);
  if (!fs.existsSync(f)) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f));
});
await new Promise(r => server.listen(0,'127.0.0.1',r));
const port = server.address().port;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = [];
page.on('pageerror', e => errs.push(e.message));
const sleep = ms => new Promise(r=>setTimeout(r,ms));
let pass=0, fail=0;
const t=(n,ok,ex='')=>{ if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));} };

await page.evaluateOnNewDocument(() => {
  const rf = window.fetch.bind(window);
  window.fetch = async function (url, opts) {
    const u = String(url);
    if (u.includes('/chat/completions')) {
      let body = {};
      try { body = JSON.parse((opts && opts.body) || '{}'); } catch {}
      if (body.stream) {
        const c = o => 'data: ' + JSON.stringify(o) + String.fromCharCode(10,10);
        return new Response(c({choices:[{delta:{content:'嗯。'}}]}) + c({choices:[{delta:{},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:2}}) + 'data: [DONE]' + String.fromCharCode(10,10),
          { status:200, headers:{'Content-Type':'text/event-stream'} });
      }
      return new Response(JSON.stringify({ choices:[{ message:{ role:'assistant',
        content: '[{"text":"他老家在成都。","kind":"fact","untilDay":null,"freq":"once"}]' } }] }),
        { status:200, headers:{'Content-Type':'application/json'} });
    }
    return rf(url, opts);
  };
});

async function setup(msgN, kvExtra) {
  await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
  await sleep(900);
  await page.evaluate(async (o) => {
    const req = indexedDB.open('ai-companion');
    const db = await new Promise(r => { req.onsuccess = () => r(req.result); });
    const put = (st, rec) => new Promise(r => { const tx = db.transaction(st,'readwrite'); tx.objectStore(st).put(rec); tx.oncomplete = r; });
    const clear = (st) => new Promise(r => { const tx = db.transaction(st,'readwrite'); tx.objectStore(st).clear(); tx.oncomplete = r; });
    await clear('messages'); await clear('memories'); await clear('kv'); await clear('characters');
    await put('characters', { id:'ms1', name:'测试', greeting:'hi', persona:'你是测试。', avatar:null,
      temperature:1, maxTokens:2048, topP:1, reasoningEffort:'low', contextRounds:20,
      kaomojiFreq:0, kaomojiStyle:'jp-soft', emojiFreq:0, verbosity:'medium', splitMessages:false,
      typingDelay:0, hesitation:false, showTyping:true, longMemory:true, allowEditMine:false,
      descLevel:'low', povLock:false, appearance:'', appearanceOn:true, presetKey:'blank', createdAt:1 });
    await put('kv', { k:'lastCharId', v:'ms1' });
    const base = Date.now() - o.msgN*60000;
    for (let i=0;i<o.msgN;i++)
      await put('messages', { id:'y'+i, charId:'ms1', role: i%2?'assistant':'user',
        content:(i%2?'我':'他')+'说了第'+i+'件事', story:null, ts: base+i*60000 });
    for (const k of (o.kv||[])) await put('kv', k);
    db.close();
  }, { msgN, kv: kvExtra || [] });
  await page.reload({ waitUntil:'networkidle0' });
  await sleep(1000);
// ⚠️ 把 Key 写进库再重载（v1.21.40）。
// 【读-改-写】而不是整表覆盖：settings 里还有 clockMode 等一堆字段，
// 整体替换会让 app 当成本机是"老数据升级"，把 clockMode 迁移成 false。
await page.evaluate(async (k) => {
  await new Promise((res) => {
    const o = indexedDB.open('ai-companion');
    o.onsuccess = () => {
      const db = o.result;
      const g = db.transaction('kv').objectStore('kv').get('settings');
      g.onsuccess = () => {
        const v = Object.assign({}, (g.result && g.result.v) || {}, { apiKey: k });
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put({ k: 'settings', v });
        tx.oncomplete = () => { db.close(); res(); };
      };
      g.onerror = () => { db.close(); res(); };
    };
    o.onerror = () => res();
  });
}, KEY);
await page.reload({ waitUntil:'networkidle0' }); await sleep(700);
}

const memN = () => page.evaluate(async () => {
  const req = indexedDB.open('ai-companion');
  const db = await new Promise(r => { req.onsuccess = () => r(req.result); });
  const all = await new Promise(r => { const q = db.transaction('memories').objectStore('memories').getAll(); q.onsuccess = () => r(q.result); });
  const kv = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').getAll(); q.onsuccess = () => r(q.result); });
  db.close();
  const s = kv.find(e => e.k === 'memSummed:ms1');
  return { n: all.length, summed: Array.isArray(s && s.v) ? s.v.length : 0 };
});

async function sendOnce() {
  await page.evaluate(() => { const el=document.getElementById('input'); el.value='在吗'; el.dispatchEvent(new Event('input',{bubbles:true})); });
  await sleep(150);
  await page.evaluate(() => document.getElementById('btn-send').click());
  let started=false;
  for (let i=0;i<80;i++){ const b=await page.$eval('#btn-stop',el=>!el.classList.contains('hidden')).catch(()=>false); if(b){started=true;break;} await sleep(150); }
  if (started) for (let i=0;i<200;i++){ const b=await page.$eval('#btn-stop',el=>!el.classList.contains('hidden')).catch(()=>false); if(!b)break; await sleep(200); }
  for (let i=0;i<40;i++){ const r=await memN(); if(r.n) break; await sleep(500); }
}

console.log('\n=== 1. 源码：判据不再读 memSumAt ===');
{
  const src = readCode(path.join(WWW, 'js/app.js'));
  t('判据是 pendingNow.length', src.includes('if (pendingNow.length < (S.memSummarizeEvery || 50)) return;'));
  t('不再有 sumCap', !src.includes('const sumCap'));
  t('不再有 lastSum 计算', !src.includes('const lastSum ='));
  t('memSumAt 键仍保留（兼容）', src.includes("'memSumAt:'"));
  t('sumMark 仍定义', src.includes('const sumMark = pendingNow.length;'));
}

console.log('\n=== 2. 序号污染场景：70 条消息 + memSumAt=22（用户实测那个）===');
await setup(70, [{ k:'memSumAt:ms1', v:22 }, { k:'msgSeq:ms1', v:22 }]);
await sendOnce();
{
  const r = await memN();
  t('序号污染不再挡住总结', r.n > 0, '记忆 ' + r.n + ' 条 / memSummed ' + r.summed);
}

console.log('\n=== 3. 序号远大于条数：2000 / 70 ===');
await setup(70, [{ k:'memSumAt:ms1', v:2000 }, { k:'msgSeq:ms1', v:2000 }]);
await sendOnce();
{
  const r = await memN();
  t('照样能总结', r.n > 0, '记忆 ' + r.n + ' 条');
}

console.log('\n=== 4. 负数污染 ===');
await setup(70, [{ k:'memSumAt:ms1', v:-999 }]);
await sendOnce();
{
  const r = await memN();
  t('负数不影响', r.n > 0, '记忆 ' + r.n + ' 条');
}

console.log('\n=== 5. 消息不够阈值 → 自动总结不触发 ===');
//   ⚠️ 这里测的是【send 触发的那条路】（summarizeIfNeeded 的阈值）。
//   但归档（runArchiveNow）会【顺带】总结一批，它不走这个阈值 ——
//   条数超过 archiveKeep（默认 30）就会触发归档，于是照样出记忆。
//   所以条数要压到归档也不会启动的范围。
await setup(20, [{ k:'memSumAt:ms1', v:0 }]);
await sendOnce();
await sleep(1500);
{
  const r = await memN();
  t('20 条（不到阈值 50、也不触发归档）→ 不总结', r.n === 0, '记忆 ' + r.n + ' 条');
}
console.log('\n=== 6. 总结完不会立刻重复总结 ===');
await setup(70, []);
await sendOnce();
{
  // ⚠️ 先等第一次总结【写完】再取基线（v1.21.43 修测试自身）。
  //
  // 原来 sendOnce() 之后立刻读 a —— 而总结是异步的（要调一次 API），
  // 那一刻可能只落了第一条、后面的还在路上。于是 a=1、b=2 被判成"重复总结"。
  //
  // 判据是"稳不稳定"，不是"快不快"：如果真发生了二次总结，
  // 数量会是 5→10 这种量级，而不是 1→2。
  await sleep(2500);
  const a = await memN();
  await sleep(2000);
  const b = await memN();
  t('总结后 memSummed 有记录', b.summed > 0, 'summed=' + b.summed);
  t('没有立刻再来一次（记忆条数稳定）', a.n === b.n, a.n + ' -> ' + b.n);
}

console.log('\n=== 7. 无 JS 报错 ===');
t('没有 pageerror', errs.length === 0, errs.slice(0,3).join(' | '));

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
