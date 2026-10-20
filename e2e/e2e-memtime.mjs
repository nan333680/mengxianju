// e2e-memtime.mjs —— 长期记忆的时间锚（0.5.2 / M0.6）
//
// 用户实测：第 2 天记下「他明天休息一天」，到第 3 天她仍在说「你明天休息一天」。
// 根因不是模型笨，而是记忆只存了自由文本，没有「这句话是第几天记的」。
//
// 本套件锁住四件事：
//   ① 纯函数：明天/昨天 → 绝对天数；第 1 天的「昨天」不能出现「第 0 天」。
//   ② 写入：总结出的「他明天休息一天」在 day=2 时必须落库成「他第 3 天休息一天」，
//      并带上 day=2、sourceMsgIds、status=active、legacy=false。
//   ③ 注入：第 3 天发消息时，系统提示词里必须有「第 2 天记下：他第 3 天休息一天」。
//   ④ 迁移：老记忆（没有新字段）读出来补 active / 空来源 / legacy=true，不能崩。
//
// 全部用假 API，不花钱。

import puppeteer from 'puppeteer-core';
import http from 'http';
import fs from 'fs';
import path from 'path';

const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');
const WWW = `${R}/www`;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const KEY = process.env.DSH_API_KEY || 'sk-test';

const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8' };
const server = http.createServer((req,res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p==='/') p='/index.html';
  // 迁移测试要先在这个 origin 上建一个 v2 库，再让 app 以 v3 打开它。
  if (p === '/seed.html') { res.writeHead(200, { 'Content-Type':'text/html; charset=utf-8' }); res.end('<!doctype html><meta charset="utf-8"><title>seed</title>'); return; }
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
const logs = [];
page.on('console', m => logs.push(m.text()));
const sleep = ms => new Promise(r=>setTimeout(r,ms));
let pass=0, fail=0;
const t=(n,ok,ex='')=>{ if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));} };

// 假 API：流式回「好。」；非流式回一条 event 记忆，正文故意写「明天」。
await page.evaluateOnNewDocument(() => {
  window.__streamSys = [];
  window.__memCalls = 0;
  const rf = window.fetch.bind(window);
  window.fetch = async function (url, opts) {
    const u = String(url);
    let body = {};
    try { body = JSON.parse((opts && opts.body) || '{}'); } catch {}
    if (u.includes('/chat/completions')) {
      if (body.stream) {
        // 系统提示词不止一条：稳定前缀在 messages[0]，本轮段（记忆/时间锚）在后面单独一条。
        // 只抓 messages[0] 会漏掉记忆，这是第一轮误判的原因。
        window.__streamSys.push((body.messages || []).filter(m => m && m.role === 'system').map(m => m.content || '').join('\n---\n'));
        const c = o => 'data: ' + JSON.stringify(o) + String.fromCharCode(10,10);
        const payload = c({choices:[{delta:{content:'好。'}}]}) +
          c({choices:[{delta:{},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:2}}) +
          'data: [DONE]' + String.fromCharCode(10,10);
        return new Response(payload, { status:200, headers:{'Content-Type':'text/event-stream'} });
      }
      window.__memCalls++;
      const json = '[{"text":"他明天休息一天","kind":"event","untilDay":3,"untilHour":null,"untilMinute":null,"freq":"once"}]';
      return new Response(JSON.stringify({ choices:[{ message:{ role:'assistant', content: json } }] }),
        { status:200, headers:{'Content-Type':'application/json'} });
    }
    return rf(url, opts);
  };
});

async function db(fn, arg) {
  return await page.evaluate(async (src, a) => {
    const o = indexedDB.open('ai-companion');
    const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
    const out = await (new Function('db','arg', 'return (async()=>{' + src + '})()'))(db, a);
    db.close();
    return out;
  }, fn, arg);
}

async function seed() {
  await db(`
    const put = (st, rec) => new Promise(r => { const tx=db.transaction(st,'readwrite'); tx.objectStore(st).put(rec); tx.oncomplete=r; });
    await put('characters', { id:'mf1', name:'记忆测试', greeting:'hi', persona:'你是测试。', avatar:null,
      temperature:1, maxTokens:2048, topP:1, reasoningEffort:'low', contextRounds:20,
      kaomojiFreq:0, kaomojiStyle:'jp-soft', emojiFreq:0, verbosity:'medium', splitMessages:false,
      typingDelay:0, hesitation:false, showTyping:true, longMemory:true, allowEditMine:false,
      descLevel:'low', povLock:false, appearance:'', appearanceOn:true, presetKey:'blank', createdAt:1 });
    await put('kv', { k:'lastCharId', v:'mf1' });
    await put('kv', { k:'clock:mf1', v:{ day:2, phase:'evening', season:'autumn', weather:'clear', locked:false, hour:18, minute:0 } });
    const base = Date.now() - 60 * 60000;
    for (let i = 0; i < 60; i++) {
      await put('messages', { id:'mt'+i, charId:'mf1', role: i%2?'assistant':'user',
        content: i === 59 ? '他说他明天休息一天' : '第 ' + i + ' 条普通对话',
        story:null, ts: base + i*60000 });
    }
  `);
}

async function memRows() {
  return await db(`
    const all = await new Promise(r => { const q=db.transaction('memories').objectStore('memories').getAll(); q.onsuccess=()=>r(q.result); });
    return all.filter(m => m.charId === 'mf1');
  `);
}
async function setClockDay(d) {
  await db(`
    const tx = db.transaction('kv','readwrite');
    tx.objectStore('kv').put({ k:'clock:mf1', v:{ day:arg, phase:'evening', season:'autumn', weather:'clear', locked:false, hour:18, minute:0 } });
    await new Promise(r => tx.oncomplete = r);
  `, d);
}
async function memCount() { return (await memRows()).length; }
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
await sleep(1000);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil:'networkidle0' });
await sleep(1000);

// 关掉现实时钟（默认是开的），否则 day 会被 realNow 覆盖。
await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const g = db.transaction('kv').objectStore('kv').get('settings');
  const v = await new Promise(r => { g.onsuccess = () => r(Object.assign({}, (g.result && g.result.v) || {}, { apiKey:'sk-test', clockMode:false })); });
  await new Promise(r => { const tx=db.transaction('kv','readwrite'); tx.objectStore('kv').put({ k:'settings', v }); tx.oncomplete=r; });
  db.close();
});
await seed();
await page.reload({ waitUntil:'networkidle0' });
await sleep(1200);

console.log('\n=== 1. 纯函数：相对日期必须变绝对天数 ===');
{
  const p = await page.evaluate(async () => {
    const m = await import('./js/memory.js');
    return {
      a: m.absolutizeMemoryText('他明天休息一天', 2),
      b: m.absolutizeMemoryText('昨晚他来过', 2),
      c: m.absolutizeMemoryText('昨天他来过', 1),
      d: m.memoryLine({ text:'他第 3 天休息', day:2, kind:'fact' }),
      e: m.memoryLine({ text:'旧记忆', day:null, kind:'fact' }),
      f: m.normalizeMemory({ text:'x' }),
      g: m.provenanceFor('他第 3 天休息一天', [{ text:'他明天休息一天', day:2, sourceMsgIds:['m1'], legacy:false }]),
    };
  });
  t('明天 → 第 3 天', p.a === '他第 3 天休息一天', p.a);
  t('昨晚 → 第 1 天晚上', p.b === '第 1 天晚上他来过', p.b);
  t('第 1 天的昨天 → 故事开始前（不出现第 0 天）', p.c === '故事开始前他来过', p.c);
  t('注入行带「第 2 天记下」', p.d === '第 2 天记下：他第 3 天休息', p.d);
  t('旧记忆没有 day 时原样返回', p.e === '旧记忆', p.e);
  t('归一化补 status/sourceMsgIds/legacy', p.f.status === 'active' && Array.isArray(p.f.sourceMsgIds) && p.f.legacy === false, JSON.stringify(p.f));
  t('整理后能找回 day 与来源', p.g.day === 2 && p.g.sourceMsgIds.includes('m1') && p.g.legacy === false, JSON.stringify(p.g));
}

console.log('\n=== 2. 写入：day=2 总结「明天休息」必须落成第 3 天 ===');
await sendOnce('在吗');
for (let i=0;i<50;i++){ if (await memCount()) break; await sleep(1000); }
{
  const rows = await memRows();
  const m = rows.find(x => x.text.includes('休息'));
  t('记忆已写进库', !!m, JSON.stringify(rows.map(x=>x.text)));
  t('正文绝对化：第 3 天休息', !!m && m.text.includes('第 3 天休息'), m && m.text);
  t('正文里没有「明天」', !!m && !m.text.includes('明天'), m && m.text);
  t('day=2', !!m && m.day === 2, m && String(m.day));
  t('sourceMsgIds 非空', !!m && Array.isArray(m.sourceMsgIds) && m.sourceMsgIds.length > 0, m && JSON.stringify(m.sourceMsgIds));
  t('status=active', !!m && m.status === 'active', m && m.status);
  t('legacy=false', !!m && m.legacy === false, m && String(m.legacy));
}

console.log('\n=== 3. 注入：第 3 天提示词必须带「第 2 天记下」 ===');
await setClockDay(3);
await page.reload({ waitUntil:'networkidle0' });
await sleep(1200);
await page.evaluate(() => { window.__streamSys.length = 0; });

await sendOnce('今天呢');
{
  const sys = await page.evaluate(() => window.__streamSys.join('\n---\n'));
  t('提示词里有「第 2 天记下：他第 3 天休息一天」', sys.includes('第 2 天记下：他第 3 天休息一天'), 'len=' + sys.length + ' 含注入标题=' + sys.includes('你记得关于他的事') + ' 尾部=' + sys.slice(-300));
  t('提示词里有「今天是第 3 天」', sys.includes('今天是第 3 天'), 'len=' + sys.length);
}

console.log('\n=== 4. 迁移：真正的 DB v2 → v3 ===');
{
  // 先离开 app（关掉它的 IndexedDB 连接），在同一个 origin 上建一个 v2 库。
  await page.goto('http://127.0.0.1:' + port + '/seed.html', { waitUntil:'domcontentloaded' });
  const made = await page.evaluate(async () => {
    await new Promise((res, rej) => {
      const q = indexedDB.deleteDatabase('ai-companion');
      q.onsuccess = res; q.onerror = () => rej(q.error); q.onblocked = res;
    });
    const req = indexedDB.open('ai-companion', 2);
    await new Promise((res, rej) => {
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('characters', { keyPath: 'id' });
        const m = db.createObjectStore('messages', { keyPath: 'id' });
        m.createIndex('charId_ts', ['charId','ts']);
        m.createIndex('charId', 'charId');
        db.createObjectStore('kv', { keyPath: 'k' });
        const mem = db.createObjectStore('memories', { keyPath: 'id' });
        mem.createIndex('charId', 'charId');
        db.createObjectStore('wbGroups', { keyPath: 'id' });
        const wb = db.createObjectStore('wbSolo', { keyPath: 'id' });
        wb.createIndex('charId', 'charId');
      };
      req.onsuccess = res; req.onerror = () => rej(req.error);
    });
    const db = req.result;
    await new Promise((res, rej) => {
      const tx = db.transaction('memories','readwrite');
      tx.objectStore('memories').put({ id:'old1', charId:'mf1', text:'老记忆：他明天休息一天', kind:'fact', ts: 1 });
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
    db.close();
    return true;
  });
  t('v2 库已建好（含一条没有新字段的老记忆）', made === true);

  // 让 app 以 v3 打开它 —— 这一步才会触发 onupgradeneeded 的迁移。
  await page.goto('http://127.0.0.1:' + port + '/', { waitUntil:'networkidle0', timeout:40000 });
  await sleep(1000);
  const r = await db(`
    const all = await new Promise(r => { const q=db.transaction('memories').objectStore('memories').getAll(); q.onsuccess=()=>r(q.result); });
    return all.find(m => m.id === 'old1');
  `);
  t('迁移后记录还在', !!r, JSON.stringify(r));
  t('迁移补 status=active', !!r && r.status === 'active', r && r.status);
  t('迁移补空 sourceMsgIds', !!r && Array.isArray(r.sourceMsgIds) && r.sourceMsgIds.length === 0, r && JSON.stringify(r.sourceMsgIds));
  t('迁移标 legacy=true（不伪造来源）', !!r && r.legacy === true, r && String(r.legacy));
  t('迁移不编造 day', !!r && r.day === null, r && String(r.day));
  t('迁移不改写老正文（没有依据就不动）', !!r && r.text === '老记忆：他明天休息一天', r && r.text);
}

console.log('\n=== 4b. 旧记忆修复：能匹配到原话就反推 day，匹配不到就只警告 ===');
{
  // 模拟用户升级后最真实的状态：库里已经有一条「他明天休息一天」，
  // 但没有 day/sourceMsgIds；消息里那句原话带 story.day=2。
  await db(`
    const put = (st, rec) => new Promise(r => { const tx=db.transaction(st,'readwrite'); tx.objectStore(st).put(rec); tx.oncomplete=r; });
    await put('characters', { id:'mf2', name:'旧记忆测试', greeting:'hi', persona:'你是测试。', avatar:null,
      temperature:1, maxTokens:2048, topP:1, reasoningEffort:'low', contextRounds:20,
      kaomojiFreq:0, kaomojiStyle:'jp-soft', emojiFreq:0, verbosity:'medium', splitMessages:false,
      typingDelay:0, hesitation:false, showTyping:true, longMemory:true, allowEditMine:false,
      descLevel:'low', povLock:false, appearance:'', appearanceOn:true, presetKey:'blank', createdAt:1 });
    await put('kv', { k:'lastCharId', v:'mf2' });
    await put('kv', { k:'clock:mf2', v:{ day:2, phase:'evening', season:'autumn', weather:'clear', locked:false, hour:18, minute:0 } });
    await put('messages', { id:'r1', charId:'mf2', role:'user', content:'他说他明天休息一天',
      story:{ day:2, phase:'evening', season:'autumn', weather:'clear' }, ts: 2 });
    await put('messages', { id:'r2', charId:'mf2', role:'assistant', content:'那你今晚早点睡。',
      story:{ day:2, phase:'night', season:'autumn', weather:'clear' }, ts: 3 });
    await put('memories', { id:'old2', charId:'mf2', text:'他明天休息一天', kind:'fact', legacy:true, ts:1 });
    await put('memories', { id:'old3', charId:'mf2', text:'他明天去海边', kind:'fact', legacy:true, ts:1 });
    await put('memories', { id:'old4', charId:'mf2', text:'他明天休息一天', kind:'fact', mine:true, legacy:true, ts:1 });
  `);
  await page.reload({ waitUntil:'networkidle0' });
  await sleep(1500);
  const rows = await db(`
    const all = await new Promise(r => { const q=db.transaction('memories').objectStore('memories').getAll(); q.onsuccess=()=>r(q.result); });
    return all.filter(m => m.charId === 'mf2');
  `);
  const fixed = rows.find(m => m.id === 'old2');
  const missed = rows.find(m => m.id === 'old3');
  const mine = rows.find(m => m.id === 'old4');
  t('能匹配到原话的旧记忆：正文改成第 3 天', !!fixed && fixed.text === '他第 3 天休息一天', fixed && fixed.text);
  t('能匹配到原话的旧记忆：day=2', !!fixed && fixed.day === 2, fixed && String(fixed.day));
  t('能匹配到原话的旧记忆：legacy=false / dayInferred=true', !!fixed && fixed.legacy === false && fixed.dayInferred === true, fixed && JSON.stringify({legacy:fixed.legacy, inferred:fixed.dayInferred}));
  t('能匹配到原话的旧记忆：来源补上 r1', !!fixed && Array.isArray(fixed.sourceMsgIds) && fixed.sourceMsgIds.includes('r1'), fixed && JSON.stringify(fixed.sourceMsgIds));
  t('匹配不到的旧记忆：正文与 day 都不动', !!missed && missed.text === '他明天去海边' && missed.day == null && missed.legacy === true, missed && JSON.stringify({text:missed.text, day:missed.day, legacy:missed.legacy}));
  const line = await page.evaluate(async () => {
    const m = await import('./js/memory.js');
    return m.memoryLine({ text:'他明天去海边', legacy:true, day:null });
  });
  t('匹配不到的旧记忆：注入时带「旧记忆·日期不明」警告', line.includes('旧记忆·日期不明') && line.includes('不要按现在推算'), line);
  t('手写记忆不反推：正文与 day 都不动', !!mine && mine.text === '他明天休息一天' && mine.day == null, mine && JSON.stringify({text:mine.text, day:mine.day}));
}

console.log('\n=== 5. 没有 JS 报错 ===');
t('无 pageerror', errs.length === 0, errs.slice(0,3).join(' | '));
const bad = logs.filter(l => l.includes('is not defined') || l.includes('记忆任务失败'));
t('没有 ReferenceError / 记忆任务失败', bad.length === 0, bad.slice(0,3).join(' | '));

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
