import puppeteer from 'puppeteer-core';
import http from 'http'; import fs from 'fs'; import path from 'path';
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
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 120000, args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = []; page.on('pageerror', e => errs.push(e.message));
page.on('dialog', async d => { await d.accept(); });
const sleep = ms => new Promise(r=>setTimeout(r,ms));
let pass=0, fail=0;
const t=(n,ok,ex='')=>{ if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));} };

// ⚠️ 本套件遵守复审第七节的方法论警告：
// 涉及"跨函数状态演化"的断言一律【跑真实 UI 后读库】，
// 不用字符串切片 —— 切片只能证明"代码里写了什么"，证明不了"运行时发生了什么"。
let tidyReply = 12;   // 模型对/整理请求 返回几条
await page.setRequestInterception(true);
page.on('request', req => {
  const u = req.url();
  if (u.includes('deepseek') || u.includes('/chat/completions')) {
    if (req.method()==='OPTIONS') { req.respond({status:204,headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'*'}}); return; }
    const b = JSON.parse(req.postData()||'{}');
    const sys = (b.messages||[]).map(m=>m.content||'').join(' ');
    const isTidy = sys.includes('重新整理一遍') || sys.includes('合并同主题');
    if (isTidy) {
      // 从 user 消息里取出原记忆数组，按 tidyReply 条数回
      const usr = (b.messages||[]).filter(m=>m.role==='user').pop();
      let arr=[]; try { arr = JSON.parse((usr||{}).content||'[]'); } catch(e){ arr=[]; }
      const n = Math.min(tidyReply, arr.length);
      const out = arr.slice(0,n).map((x,i)=>({ text:'合'+i, kind:x.kind||'fact', untilDay:x.untilDay??null, freq:x.freq||'normal' }));
      req.respond({status:200,headers:{'Access-Control-Allow-Origin':'*'},contentType:'application/json',body:JSON.stringify({choices:[{message:{content:JSON.stringify(out)}}]})});
      return;
    }
    if (b.stream) {
      const pl='data: '+JSON.stringify({choices:[{delta:{content:'收到。'}}]})+String.fromCharCode(10,10)+'data: [DONE]'+String.fromCharCode(10,10);
      req.respond({status:200,headers:{'Access-Control-Allow-Origin':'*'},contentType:'text/event-stream',body:pl}); return;
    }
    req.respond({status:200,headers:{'Access-Control-Allow-Origin':'*'},contentType:'application/json',body:JSON.stringify({choices:[{message:{content:'[]'}}]})}); return;
  }
  req.continue();
});

const kvGet = (k) => page.evaluate(async (kk) => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => o.onsuccess = () => r(o.result));
  const v = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get(kk); q.onsuccess = () => r(q.result); });
  db.close(); return v ? v.v : null;
}, k);

await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
await sleep(1400);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil:'networkidle0' }); await sleep(700);
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

// 造：20 条记忆 + 水位 500（老数据 seq 量纲）+ 角色
await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => o.onsuccess = () => r(o.result));
  const put = (store, rec) => new Promise(r => { const tx=db.transaction(store,'readwrite'); tx.objectStore(store).put(rec); tx.oncomplete=r; });
  const cid='c-v28';
  await put('characters', { id:cid, name:'v28测试', avatar:null, greeting:'（开场白）', persona:'测试',
    createdAt:Date.now(), longMemory:true, verbosity:'medium', descLevel:'mid', splitMessages:false, maxTokens:2000 });
  for (let i=0;i<20;i++) await put('memories', { id:'m'+i, charId:cid, text:'记忆条目'+i, kind:'fact', freq:'normal', ts:Date.now()+i });
  await put('kv', { k:'memDedupeAt:'+cid, v:500 });          // ← 老数据的 seq 量纲
  await put('kv', { k:'memDeleted:'+cid, v:['被删的对话1','被删的对话2'] });
  db.close();
});
await page.reload({ waitUntil:'networkidle0' }); await sleep(800);
await page.evaluate(() => { const c=[...document.querySelectorAll('#char-list .char-card')].find(x=>x.textContent.includes('v28测试')); if(c)c.click(); });
await sleep(900);

console.log('=== 新1_ 量纲自愈：水位 500 → 应被夹紧到 20（跑真实链路后读库）===');
// 触发一次自动整理：发一条消息（会走 runMemTasks）
await page.evaluate(() => { const i=document.getElementById('input'); i.value='触发'; i.dispatchEvent(new Event('input',{bubbles:true})); });
await page.evaluate(() => document.getElementById('btn-send').click());
for (let i=0;i<30;i++){ await sleep(400); const b=await page.$eval('#btn-stop',e=>!e.classList.contains('hidden')).catch(()=>false); if(!b) break; }
await sleep(2500);
{
  const wl = await kvGet('memDedupeAt:c-v28');
  console.log('   memDedupeAt = ' + JSON.stringify(wl));
  t('水位不再停留在 500（量纲自愈生效）', wl !== 500, 'value=' + JSON.stringify(wl));
  t('水位被修正为记忆条数（<=20）', typeof wl === 'number' && wl <= 20, 'value=' + JSON.stringify(wl));
}

console.log('');
console.log('=== 新6_ 手动按钮：模型抽风时【不得】推进水位（跑真实 UI）===');
// 把水位设成一个已知值，然后点手动整理，让模型只回 1 条（触发 tooFew）
await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => o.onsuccess = () => r(o.result));
  const put = (store, rec) => new Promise(r => { const tx=db.transaction(store,'readwrite'); tx.objectStore(store).put(rec); tx.oncomplete=r; });
  await put('kv', { k:'memDedupeAt:c-v28', v:3 });
  db.close();
});
tidyReply = 1;   // 触发 tooFew
const memBefore = await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => o.onsuccess = () => r(o.result));
  const idx = db.transaction('memories').objectStore('memories').index('charId');
  const arr = await new Promise(r => { const q = idx.getAll('c-v28'); q.onsuccess = () => r(q.result); });
  db.close(); return arr.length;
});
console.log('   点击前记忆 ' + memBefore + ' 条');
await page.reload({ waitUntil:'networkidle0' }); await sleep(800);
await page.evaluate(() => { const c=[...document.querySelectorAll('#char-list .char-card')].find(x=>x.textContent.includes('v28测试')); if(c)c.click(); });
await sleep(700);
// 打开设置页并点「立即整理记忆」
const clicked = await page.evaluate(async () => {
  const nav = [...document.querySelectorAll('[data-view], .tab, nav button, .nav-item')].find(x=>/设置/.test(x.textContent));
  if (nav) nav.click();
  await new Promise(r=>setTimeout(r,600));
  const b = document.getElementById('btn-mem-tidy') || [...document.querySelectorAll('button')].find(x=>/立即整理记忆/.test(x.textContent));
  if (!b) return false;
  b.click(); return true;
});
if (clicked) {
  await sleep(4000);
  const wl2 = await kvGet('memDedupeAt:c-v28');
  const memN = await page.evaluate(async () => {
    const o = indexedDB.open('ai-companion');
    const db = await new Promise(r => o.onsuccess = () => r(o.result));
    const idx = db.transaction('memories').objectStore('memories').index('charId');
    const arr = await new Promise(r => { const q = idx.getAll('c-v28'); q.onsuccess = () => r(q.result); });
    db.close(); return arr.length;
  });
  console.log('   memDedupeAt = ' + JSON.stringify(wl2) + ' | 记忆 ' + memN + ' 条');
  t('抽风后水位没有被写成当前条数', wl2 !== memN, 'wl=' + wl2 + ' memN=' + memN);
  t('抽风后记忆条数没变（保护生效）', memN === memBefore, memBefore + ' -> ' + memN);
} else {
  t('找到「立即整理记忆」按钮', false, '按钮未找到');
}

console.log('');
console.log('=== 新2_ 队列裁剪出口可达（跑真实 UI 后读库）===');
{
  const q = await kvGet('memDeleted:c-v28');
  console.log('   memDeleted 队列 = ' + JSON.stringify(q));
  t('队列仍存在且不超过 20 条', Array.isArray(q) && q.length <= 20, JSON.stringify(q));
}

console.log('');
console.log('=== 新8_ 世界书导出文件能被导入入口接受 ===');
// 用真实世界书导出 payload 形状（无 characters）
const wbPayload = { version:1, kind:'worldbook', exportedAt:Date.now(),
  groups:[{ id:'g1', name:'组1', members:[], entries:[] }], solo:[{ id:'s1', charId:'c-v28', entries:[{ id:'e1', title:'T', keys:['k'], content:'C' }] }] };
fs.writeFileSync('C:\\A-DSH-Apk\\_check\\wbonly.json', JSON.stringify(wbPayload));
// 静态确认校验放宽（这条确实是"代码里写了什么"，但入口校验本身就只取决于源码）
const src = fs.readFileSync(WWW + '/js/app.js', 'utf8');
t('两处入口校验都放宽了', (src.match(/!data\.characters && !data\.groups/g)||[]).length === 2);

console.log('');
console.log('=== 其余静态确认 ===');
t('新2_ 抽了 pruneDeletedQueue', src.includes('async function pruneDeletedQueue(cidFor, cached) {'));
t('新3_ 满额时只拦 0 条', src.includes('const memFull = listAll.length >= (S.memLimit || 20);'));
t('新5_ rewind 不再排除首条（且非生成中）', src.includes("if (!isMe && !isLast && !locked) acts.push({ k: 'rewind', t: '从这里重聊' });"));
t('新7_ regen 退回时间', src.includes("typeof m.story.day === 'number' && !isRealClock()"));
t('新9_ toast 判 aborted', src.includes("if (aborted === 'tooFew') {"));

console.log('');
console.log('  JS 错误: ' + (errs.length ? JSON.stringify(errs.slice(0,3)) : '无'));
t('无 JS 错误', errs.length === 0, errs.join(' | '));

console.log('');
console.log('========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
