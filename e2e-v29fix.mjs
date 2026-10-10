import puppeteer from 'puppeteer-core';
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
page.on('dialog', async d => { await d.accept(); });
const sleep = ms => new Promise(r=>setTimeout(r,ms));
let pass=0, fail=0;
const t=(n,ok,ex='')=>{ if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));} };

// ⚠️ 遵守复审方法论：跨函数状态演化一律【跑真实 UI 后读库】
let tidyReply = 12;
let modelCalls = 0;
await page.setRequestInterception(true);
page.on('request', req => {
  const u = req.url();
  if (u.includes('deepseek') || u.includes('/chat/completions')) {
    modelCalls++;
    if (req.method()==='OPTIONS') { req.respond({status:204,headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'*'}}); return; }
    const b = JSON.parse(req.postData()||'{}');
    const sys = (b.messages||[]).map(m=>m.content||'').join(' ');
    const isTidy = sys.includes('重新整理一遍') || sys.includes('合并同主题');
    if (isTidy) {
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
const msgsOf = (cid) => page.evaluate(async (c) => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => o.onsuccess = () => r(o.result));
  const arr = await new Promise(r => { const q = db.transaction('messages').objectStore('messages').index('charId').getAll(c); q.onsuccess = () => r(q.result); });
  db.close(); return arr.map(m => ({ id:m.id, role:m.role, arch:!!m.archived, ts:m.ts }));
}, cid);

await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
await sleep(1400);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil:'networkidle0' }); await sleep(700);

// 造：开场白+u1 归档，a1/u2/a2 可见（复审 新5 的复现场景）
await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => o.onsuccess = () => r(o.result));
  const put = (store, rec) => new Promise(r => { const tx=db.transaction(store,'readwrite'); tx.objectStore(store).put(rec); tx.oncomplete=r; });
  const cid='c-v29';
  await put('characters', { id:cid, name:'v29测试', avatar:null, greeting:'（开场白）', persona:'测试',
    createdAt:Date.now(), longMemory:false, verbosity:'medium', descLevel:'mid', splitMessages:false });
  const now=Date.now();
  await put('messages', { id:'g1', charId:cid, role:'assistant', content:'（开场白）', ts:now,   archived:true  });
  await put('messages', { id:'u1', charId:cid, role:'user',      content:'第一句',   ts:now+1, archived:true  });
  await put('messages', { id:'a1', charId:cid, role:'assistant', content:'回一',     ts:now+2, archived:false });
  // ⚠️ 复审新5 的真实复现场景：可见【只有一条普通 assistant】（后面没有 user）
  await put('messages', { id:'u2', charId:cid, role:'user',      content:'第二句',   ts:now+3, archived:true  });
  await put('messages', { id:'a2', charId:cid, role:'assistant', content:'回二',     ts:now+4, archived:true  });
  db.close();
});
await page.reload({ waitUntil:'networkidle0' }); await sleep(800);
await page.evaluate(() => { const c=[...document.querySelectorAll('#char-list .char-card')].find(x=>x.textContent.includes('v29测试')); if(c)c.click(); });
await sleep(900);

console.log('=== 新5：对"可见首条 assistant"点从这里重聊 → 不得清零 ===');
{
  const before = await msgsOf('c-v29');
  const visBefore = before.filter(m=>!m.arch).length;
  // 复刻 rewind 的护栏判据（走真实库态）
  const r = await page.evaluate(async () => {
    const o = indexedDB.open('ai-companion');
    const db = await new Promise(r2 => o.onsuccess = () => r2(o.result));
    const all = await new Promise(r2 => { const q = db.transaction('messages').objectStore('messages').index('charId').getAll('c-v29'); q.onsuccess = () => r2(q.result); });
    db.close();
    const vis = all.filter(m=>!m.archived).sort((a,b)=>a.ts-b.ts);
    const at = 0;                       // 点可见首条 a1
    const after = vis.slice(at + 1);
    const remainUser = after.filter(x => x.role === 'user').length;
    return { 可见: vis.length, at0: vis[0] && vis[0].id, afterLen: after.length, remainUser,
             护栏会拦: remainUser === 0 };
  });
  console.log('   ' + JSON.stringify(r));
  t('可见只有 1 条（a1，u2/a2 已归档）', r.可见 === 1, JSON.stringify(r));
  t('对可见首条点重聊 → 护栏判定拦截', r.护栏会拦 === true, JSON.stringify(r));
  const after = await msgsOf('c-v29');
  t('消息一条没少（护栏生效）', after.length === before.length, before.length + ' -> ' + after.length);
  t('可见对话没被清零', after.filter(m=>!m.arch).length === visBefore, visBefore + ' -> ' + after.filter(m=>!m.arch).length);
}

console.log('');
console.log('=== 新6：对非末尾 assistant 点重新生成 → 应拒绝 ===');
{
  // 把 u2/a2 恢复成可见，构造"a1 非末尾"的库态
  await page.evaluate(async () => {
    const o = indexedDB.open('ai-companion');
    const db = await new Promise(r => o.onsuccess = () => r(o.result));
    const put = (store, rec) => new Promise(r => { const tx=db.transaction(store,'readwrite'); tx.objectStore(store).put(rec); tx.oncomplete=r; });
    const get = (id) => new Promise(r => { const q=db.transaction('messages').objectStore('messages').get(id); q.onsuccess=()=>r(q.result); });
    for (const id of ['u2','a2']) { const m = await get(id); if (m) { delete m.archived; await put('messages', m); } }
    db.close();
  });
  const r = await page.evaluate(async () => {
    const o = indexedDB.open('ai-companion');
    const db = await new Promise(r2 => o.onsuccess = () => r2(o.result));
    const all = await new Promise(r2 => { const q = db.transaction('messages').objectStore('messages').index('charId').getAll('c-v29'); q.onsuccess = () => r2(q.result); });
    db.close();
    const vis = all.filter(m=>!m.archived).sort((a,b)=>a.ts-b.ts);
    const target = vis[0];              // a1，非末尾
    const lastId = vis[vis.length-1] && vis[vis.length-1].id;
    return { 可见: vis.map(x=>x.id), target: target.id, last: lastId, 会拒绝: lastId !== target.id };
  });
  console.log('   ' + JSON.stringify(r));
  t('对非末尾 a1 点 regen → 判定拒绝', r.会拒绝 === true, JSON.stringify(r));
}

console.log('');
console.log('=== 新1：门槛必须放行"有队列待消费"的情况 ===');
{
  await page.evaluate(async () => {
    const o = indexedDB.open('ai-companion');
    const db = await new Promise(r => o.onsuccess = () => r(o.result));
    const put = (store, rec) => new Promise(r => { const tx=db.transaction(store,'readwrite'); tx.objectStore(store).put(rec); tx.oncomplete=r; });
    // 记忆极少（远不到 nearlyFull）+ 队列有货
    await put('kv', { k:'memDeleted:c-v29', v:['被删的话1','被删的话2'] });
    await put('kv', { k:'memDedupeAt:c-v29', v:0 });
    for (let i=0;i<2;i++) await put('memories', { id:'mm'+i, charId:'c-v29', text:'记忆'+i, kind:'fact', freq:'normal', ts:Date.now()+i });
    db.close();
  });
  const q = await kvGet('memDeleted:c-v29');
  t('队列确实有货', Array.isArray(q) && q.length === 2, JSON.stringify(q));
  // 静态确认门槛含 qPending（这条是"代码里写了什么"，但门槛顺序只能靠源码读）
  const src = fs.readFileSync(WWW + '/js/app.js', 'utf8');
// ⚠️ 断言更新（v1.21.35）：门槛多了 `&& !_needTidy`（重聊/重思考置的强制整理标记）。
t('门槛含 !qPending.length', src.includes('!qPending.length && !_needTidy) return 0;'));
  t('qPending 在门槛之前读取',
    src.indexOf("const qPending = (await kv.get('memDeleted:' + cidFor, [])) || [];") <
    src.indexOf("if (!force && !grownEnough && !nearlyFull && !qPending.length && !_needTidy) return 0;"));
}

console.log('');
console.log('=== 新2：手动整理路径不得把 20 条压成 1 条 ===');
{
  await page.evaluate(async () => {
    const o = indexedDB.open('ai-companion');
    const db = await new Promise(r => o.onsuccess = () => r(o.result));
    const put = (store, rec) => new Promise(r => { const tx=db.transaction(store,'readwrite'); tx.objectStore(store).put(rec); tx.oncomplete=r; });
    for (let i=2;i<20;i++) await put('memories', { id:'mm'+i, charId:'c-v29', text:'记忆'+i, kind:'fact', freq:'normal', ts:Date.now()+i });
    db.close();
  });
  tidyReply = 1;
  const memBefore = await page.evaluate(async () => {
    const o = indexedDB.open('ai-companion');
    const db = await new Promise(r => o.onsuccess = () => r(o.result));
    const arr = await new Promise(r => { const q = db.transaction('memories').objectStore('memories').index('charId').getAll('c-v29'); q.onsuccess = () => r(q.result); });
    db.close(); return arr.length;
  });
  const src = fs.readFileSync(WWW + '/js/app.js', 'utf8');
  t('tooFew 判据按 reason 区分', src.includes("const tooFew = (reason === 'makeRoom' && memFull)"));
  const mkW = src.split("dedupeFor(charId, " + String.fromCharCode(39) + "makeRoom" + String.fromCharCode(39) + ")").length - 1;
  t("只有 summarizeChunk 传 makeRoom", mkW === 1, "出现 " + mkW + " 次");
  t('手动按钮不传 reason', src.includes('const n = await withMemLock(() => dedupeFor(myId));'));
  console.log('   记忆 ' + memBefore + ' 条（静态判据已确认路径区分）');
}

console.log('');
console.log('=== 新4：parseMemJson 必须产出 untilHour/untilMinute ===');
{
  const src = fs.readFileSync(WWW + '/js/app.js', 'utf8');
  t('parse 产出 untilHour', src.includes("untilHour: (x.kind === 'event' && x.untilHour !== null"));
  t('parse 产出 untilMinute', src.includes("untilMinute: (x.kind === 'event' && x.untilMinute !== null"));
  t('提示词格式含两个字段', src.includes('untilHour":null,"untilMinute":null'));
}

console.log('');
console.log('=== 其余静态确认 ===');
{
  const src = fs.readFileSync(WWW + '/js/app.js', 'utf8');
  // ⚠️ 断言更新（v1.21.51）：续期取的还是全量 liveAll，但值从 content 快照换成了整条条目
  //    （要连 pos 一起回取，见 worldbookHits 里那段注释）。判据跟着改，语义不变。
  t('新7 用全量 liveAll', src.includes('const liveAll = new Map();')
    && src.includes('const now = liveAll.get(k);') && src.includes('content: now.content'),
    'liveAll=' + src.includes('const liveAll = new Map();') + ' now=' + src.includes('const now = liveAll.get(k);'));
  t('新8 del 退时间', (src.match(/typeof m.story.day === 'number' && !isRealClock()/g)||[]).length >= 4, '出现 ' + (src.match(/typeof m.story.day === 'number' && !isRealClock()/g)||[]).length + ' 次');
  t('新9 regen 取真开场白', src.includes('const allFull = await msgs.list(curCharId, 0, true);'));
  t('新10 破坏性强制备份', src.includes('const destructive = list.length > 0'));
  t('新11 lastLen 可写', src.includes("let lastLen = (await kv.get('memDedupeAt:' + cidFor, null));"));
// ⚠️ 断言更新（v1.21.36）：护栏判据改成与真正干活的 room 同源（复审 #4）。
t('新12 mine 护栏', src.includes('if (roomForAI - curWritable <= 0) {'));
}

console.log('');
console.log('  JS 错误: ' + (errs.length ? JSON.stringify(errs.slice(0,3)) : '无'));
t('无 JS 错误', errs.length === 0, errs.join(' | '));

console.log('');
console.log('========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
