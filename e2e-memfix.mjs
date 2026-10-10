// e2e-memfix.mjs —— 记忆总结的两个静默失败（v1.20.13 修）
//
// 背景：这两个 bug 叠在一起，让「长期记忆」从 v1.18.10 起就没成功写进过库。
// 两个都不会报错到界面上，只在 console 留一行 —— 所以必须有用例锁住。
//
//   ① api.js onceChat 没关思考模式
//      模型把该输出的 JSON 全写进 reasoning_content，message.content 是空串。
//      → parseMemJson('') 解析失败 → 记忆 0 条。
//      修：显式传 reasoning_effort='none'，并在 content 为空时从 reasoning 里抠 JSON。
//
//   ② app.js summarizeIfNeeded 里写成了 cidFor
//      cidFor 是另一个函数 dedupeIfNeeded 的局部变量，这里访问不到。
//      → 模型正常返回后，写库那行抛 ReferenceError，被 step() 吞掉 → 记忆 0 条。
//      修：改成 curCharId。
//
// 这个套件用「假 API」把两种响应都造出来，不需要真 key、不花钱。

import puppeteer from 'puppeteer-core';
import http from 'http';
import fs from 'fs';
import path from 'path';
// 工作目录自适应（原来写死 C:/A-DSH-Tool/ai-companion）
const R = path.resolve(import.meta.dirname).split(path.sep).join('/');

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
const pageLogs = [];
page.on('console', m => pageLogs.push(m.text()));
const sleep = ms => new Promise(r=>setTimeout(r,ms));
let pass=0, fail=0;
const t=(n,ok,ex='')=>{ if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));} };

// —— 假 API ——
// memMode 控制 /chat/completions（非流式，即 onceChat）怎么回：
//   'thinking'  → 复现旧 bug：content 空，JSON 在 reasoning_content 里
//   'normal'    → 正常：content 直接是 JSON
await page.evaluateOnNewDocument(() => {
  window.__memCalls = [];
  window.__memMode = 'normal';
  const rf = window.fetch.bind(window);
  window.fetch = async function (url, opts) {
    const u = String(url);
    let body = {};
    try { body = JSON.parse((opts && opts.body) || '{}'); } catch {}
    if (u.includes('/chat/completions')) {
      window.__memCalls.push({ stream: !!body.stream, effort: body.reasoning_effort });
      const json = '[{"text":"他老家在成都","kind":"fact","untilDay":null,"freq":"once"},'
                 + '{"text":"他怕黑，睡觉要留灯","kind":"fact","untilDay":null,"freq":"once"}]';
      if (body.stream) {
        const c = o => 'data: ' + JSON.stringify(o) + String.fromCharCode(10,10);
        const payload = c({choices:[{delta:{content:'好。'}}]}) +
          c({choices:[{delta:{},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:2}}) +
          'data: [DONE]' + String.fromCharCode(10,10);
        return new Response(payload, { status:200, headers:{'Content-Type':'text/event-stream'} });
      }
      const mode = window.__memMode;
      const msg = mode === 'thinking'
        ? { role:'assistant', content:'', reasoning_content: '思考中…最终输出：' + json }
        : { role:'assistant', content: json };
      return new Response(JSON.stringify({ choices:[{ message: msg }] }),
        { status:200, headers:{'Content-Type':'application/json'} });
    }
    return rf(url, opts);
  };
});

async function seedMsgs(n) {
  await page.evaluate(async (count) => {
    const o = indexedDB.open('ai-companion');
    const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
    const put = (st, rec) => new Promise(r => { const tx = db.transaction(st,'readwrite'); tx.objectStore(st).put(rec); tx.oncomplete = r; });
    await put('kv', { k:'lastCharId', v:'mf1' });
    const base = Date.now() - count * 60000;
    for (let i = 0; i < count; i++) {
      await put('messages', { id:'mf'+i, charId:'mf1', role: i%2?'assistant':'user',
        content: (i%2?'我':'他') + '说了关于' + (['老家','怕黑','吃饭','上班'][i%4]) + '的事' + i,
        story:null, ts: base + i*60000 });
    }
    db.close();
  }, n);
}

async function memCount() {
  return await page.evaluate(async () => {
    const o = indexedDB.open('ai-companion');
    const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
    const all = await new Promise(r => { const q = db.transaction('memories').objectStore('memories').getAll(); q.onsuccess = () => r(q.result); });
    db.close();
    return all.filter(m => m.charId === 'mf1').map(m => m.text);
  });
}

async function sendOnce(text) {
  await page.evaluate(t => { const el=document.getElementById('input'); el.value=t; el.dispatchEvent(new Event('input',{bubbles:true})); }, text);
  await sleep(150);
  await page.evaluate(() => document.getElementById('btn-send').click());
  let started = false;
  for (let i=0;i<80;i++){ const b=await page.$eval('#btn-stop',el=>!el.classList.contains('hidden')).catch(()=>false); if(b){started=true;break;} await sleep(150); }
  if (started) for (let i=0;i<200;i++){ const b=await page.$eval('#btn-stop',el=>!el.classList.contains('hidden')).catch(()=>false); if(!b)break; await sleep(200); }
  await sleep(500);
}

await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
await sleep(1200);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
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

const put = async (rec) => { await page.evaluate(async (c) => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  await new Promise(r => { const tx = db.transaction('characters','readwrite'); tx.objectStore('characters').put(c); tx.oncomplete = r; });
  db.close();
}, rec); };

const mk = (extra={}) => Object.assign({
  id:'mf1', name:'记忆测试', greeting:'hi', persona:'你是测试。', avatar:null,
  temperature:1, maxTokens:2048, topP:1, reasoningEffort:'low', contextRounds:20,
  kaomojiFreq:0, kaomojiStyle:'jp-soft', emojiFreq:0, verbosity:'medium', splitMessages:false,
  typingDelay:0, hesitation:false, showTyping:true, longMemory:true, allowEditMine:false,
  descLevel:'low', povLock:false, appearance:'', appearanceOn:true, presetKey:'blank', createdAt:1,
}, extra);

console.log('\n=== 1. onceChat 必须关掉思考模式 ===');
await put(mk());
await seedMsgs(80);
await page.reload({ waitUntil:'networkidle0' });
await sleep(1200);
await page.evaluate(() => { window.__memCalls.length = 0; });
await sendOnce('在吗');
// 等记忆任务
for (let i=0;i<40;i++){ const n=await memCount(); if(n.length) break; await sleep(1000); }
{
  const calls = await page.evaluate(() => window.__memCalls.filter(c => !c.stream));
  t('有非流式调用（记忆任务）', calls.length > 0, '实际 ' + calls.length);
  t('每个都显式传了 reasoning_effort', calls.length > 0 && calls.every(c => c.effort !== undefined),
    JSON.stringify(calls.map(c=>c.effort)));
  t('reasoning_effort 是 none', calls.every(c => c.effort === 'none'), JSON.stringify(calls.map(c=>c.effort)));
}

console.log('\n=== 2. 记忆能真正写进库（cidFor 笔误回归）===');
{
  const n = await memCount();
  t('记忆不为空', n.length > 0, '实际 ' + n.length + ' 条');
  t('内容正确', n.some(x => x.includes('成都')), JSON.stringify(n));
  const bad = pageLogs.filter(l => l.includes('cidFor is not defined') || l.includes('charId is not defined') || l.includes('is not defined'));
  t('没有 ReferenceError', bad.length === 0, bad.slice(0,2).join(' | '));
  const memErr = pageLogs.filter(l => l.includes('[记忆任务') && l.includes('失败'));
  t('记忆任务没有失败日志', memErr.length === 0, memErr.slice(0,2).join(' | '));
}

console.log('\n=== 3. 兜底：content 为空时从 reasoning_content 里抠 JSON ===');
{
  await page.evaluate(() => { window.__memMode = 'thinking'; });
  // 清掉记账，让它再总结一次
  await page.evaluate(async () => {
    const o = indexedDB.open('ai-companion');
    const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
    const del = (st) => new Promise(r => { const tx = db.transaction(st,'readwrite'); tx.objectStore(st).clear(); tx.oncomplete = r; });
    await del('memories');
    const kvAll = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').getAll(); q.onsuccess = () => r(q.result); });
    for (const e of kvAll) if (e.k.indexOf('memSummed') === 0 || e.k.indexOf('memSumAt') === 0) {
      await new Promise(r => { const tx = db.transaction('kv','readwrite'); tx.objectStore('kv').delete(e.k); tx.oncomplete = r; });
    }
    db.close();
  });
  await page.reload({ waitUntil:'networkidle0' });
  await sleep(1200);
  await sendOnce('再来一次');
  for (let i=0;i<40;i++){ const n=await memCount(); if(n.length) break; await sleep(1000); }
  const n2 = await memCount();
  t('content 为空时仍能拿到记忆（兜底生效）', n2.length > 0, '实际 ' + n2.length + ' 条');
}

console.log('\n=== 4. 整理文案不再劝人白点 ===');
{
  const src = fs.readFileSync(path.join(WWW, 'js/app.js'), 'utf8');
  // 只检查【代码行】，排除注释 —— 说明修改原因的注释里会引用旧文案，那是正常的。
  const codeLines = src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  t('代码里去掉了「再点一次通常会好一些」', !codeLines.includes('再点一次通常会好一些'));
  t('改成了明确的「不用再点了」', codeLines.includes('不用再点了'));
  t('保留了真故障时的重试建议', codeLines.includes('可以直接再点一次'));
}

console.log('\n=== 5. 没有 JS 报错 ===');
t('无 pageerror', errs.length === 0, errs.slice(0,3).join(' | '));

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
