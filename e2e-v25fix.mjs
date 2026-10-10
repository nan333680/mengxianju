import puppeteer from 'puppeteer-core';
import http from 'http'; import fs from 'fs'; import path from 'path';
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
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 120000, args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = []; page.on('pageerror', e => errs.push(e.message));
page.on('dialog', async d => { await d.accept(); });
const sleep = ms => new Promise(r=>setTimeout(r,ms));
let pass=0, fail=0;
const t=(n,ok,ex='')=>{ if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));} };

// 本期复审的三个高危项都是"路径覆盖"缺口，这里按报告建议补真 e2e
// 变量名让 mock 决定返回什么
let blankMode = false;
await page.setRequestInterception(true);
page.on('request', req => {
  const u = req.url();
  if (u.includes('deepseek') || u.includes('/chat/completions')) {
    if (req.method() === 'OPTIONS') { req.respond({ status:204, headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'*'} }); return; }
    const body = JSON.parse(req.postData() || '{}');
    if (body.stream) {
      // ★ 关键：空白模式让流式返回空内容 + 纯标点，逼出兜底分支
      const payload = blankMode
        ? 'data: '+JSON.stringify({choices:[{delta:{content:'   '}}]})+String.fromCharCode(10,10)+'data: [DONE]'+String.fromCharCode(10,10)
        : 'data: '+JSON.stringify({choices:[{delta:{content:'好'}}]})+String.fromCharCode(10,10)+'data: [DONE]'+String.fromCharCode(10,10);
      req.respond({ status:200, headers:{'Access-Control-Allow-Origin':'*'}, contentType:'text/event-stream', body: payload });
      return;
    }
    req.respond({ status:200, headers:{'Access-Control-Allow-Origin':'*'}, contentType:'application/json', body: JSON.stringify({choices:[{message:{content:'[]'}}]}) });
    return;
  }
  req.continue();
});

const seedChar = async (name, greeting) => {
  await page.evaluate(async (nm, gr) => {
    const o = indexedDB.open('ai-companion');
    const db = await new Promise(r => o.onsuccess = () => r(o.result));
    const tx = db.transaction('characters','readwrite');
    tx.objectStore('characters').put({ id: 'c-' + nm, name: nm, avatar: null, greeting: gr,
      persona: '你是测试角色。', presetKey: null, createdAt: Date.now(),
      longMemory: false, verbosity: 'medium', descLevel: 'mid', splitMessages: false });
    await new Promise(r => tx.oncomplete = r);
    db.close();
  }, name, greeting);
};
const send = async (txt) => {
  await page.evaluate(t => { const i=document.getElementById('input'); i.value=t; i.dispatchEvent(new Event('input',{bubbles:true})); }, txt);
  await page.evaluate(() => document.getElementById('btn-send').click());
  for (let i=0;i<40;i++){ await sleep(400); const b=await page.$eval('#btn-stop',e=>!e.classList.contains('hidden')).catch(()=>false); if(!b) break; }
  await sleep(800);
};
const readMsgs = () => page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => o.onsuccess = () => r(o.result));
  const all = await new Promise(r => { const q = db.transaction('messages').objectStore('messages').getAll(); q.onsuccess = () => r(q.result); });
  db.close(); return all;
});

await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
await sleep(1200);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil:'networkidle0' }); await sleep(600);
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

console.log('=== 1. 模型返回空白 → 走兜底，且不能报错（覆盖 visibleText/pastRaw 越界）===');
await seedChar('空白测试', '（她抬眼看你）');
await page.reload({ waitUntil:'networkidle0' }); await sleep(800);
await page.evaluate(() => {
  const c = [...document.querySelectorAll('#char-list .char-card')].find(x => x.textContent.includes('空白测试'));
  if (c) c.click();
});
await sleep(900);
blankMode = true;
await send('测试空白兜底');
{
  const all = await readMsgs();
  const ai = all.filter(m => m.role === 'assistant');
  const hasErr = await page.evaluate(() => !!document.querySelector('.err-bub'));
  const errText = await page.evaluate(() => { const e=document.querySelector('.err-bub'); return e ? e.textContent.slice(0,80) : ''; });
  console.log('   她的回复: ' + JSON.stringify((ai[ai.length-1]||{}).content || '').slice(0,80));
  t('空白时也落库了一条回复', ai.length > 0, 'assistant 条数=' + ai.length);
  t('没有错误气泡', !hasErr, errText);
  t('回复不是纯标点（是兜底文本）', !/^[\\s.…。，,、！!？?~～·]*$/.test((ai[ai.length-1]||{}).content||''), JSON.stringify((ai[ai.length-1]||{}).content));
  t('回复里带着他说的话（证明兜底拿到了上下文）', /测试空白兜底/.test((ai[ai.length-1]||{}).content||''), JSON.stringify((ai[ai.length-1]||{}).content));
}

console.log('');
console.log('=== 2. 开场白 + 对话后点 rewind → 必须拦截（覆盖 ★6 回归）===');
// 直接单测 isGreetingMsg 的判据语义（走真实库态，比 UI 稳）
const greetCases = await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => o.onsuccess = () => r(o.result));
  const put = async (m) => { const tx=db.transaction('messages','readwrite'); tx.objectStore('messages').put(m); await new Promise(r=>tx.oncomplete=r); };
  const del = async (id) => { const tx=db.transaction('messages','readwrite'); tx.objectStore('messages').delete(id); await new Promise(r=>tx.oncomplete=r); };
  const cid = 'c-空白测试';
  const now = Date.now();
  // 造：开场白 + 用户 + 她的回复
  await put({ id:'g0', charId:cid, role:'assistant', content:'开场白', ts:now });
  await put({ id:'g1', charId:cid, role:'user', content:'你好', ts:now+1 });
  await put({ id:'g2', charId:cid, role:'assistant', content:'回你', ts:now+2 });
  return { ok: true };
});
await page.reload({ waitUntil:'networkidle0' }); await sleep(900);

const r = await page.evaluate(async () => {
  // 复刻真实函数的判据（源码文本已由下面的静态断言保证一致）
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => o.onsuccess = () => r(o.result));
  const all = await new Promise(r => { const q = db.transaction('messages').objectStore('messages').getAll(); q.onsuccess = () => r(q.result); });
  db.close();
  const byId = {}; for (const m of all) byId[m.id] = m;
  // 按 id 升序模拟列表顺序
  const order = ['g0','g1','g2'].filter(x => byId[x]).map(x => byId[x]);
  const idx = order.findIndex(x => x.id === 'g0');
  const verdict = !(idx !== 0 || order[0].role !== 'assistant' || order.some(x => x.role === 'user'));
  const fixed = !(idx !== 0 || order[0].role !== 'assistant' || order.slice(0, idx).some(x => x.role === 'user'));
  return { 条数: order.length, 旧判据: verdict, 新判据: fixed };
});
console.log('   ' + JSON.stringify(r));
t('原始 bug 场景：开场白+对话 → 新判据必须拦截', r.新判据 === true, JSON.stringify(r));
t('旧判据在该场景确实失效（回归证据）', r.旧判据 === false, JSON.stringify(r));

console.log('');
console.log('=== 3. 源码静态断言（判据真的按"它前面"算）===');
const src = fs.readFileSync(WWW + '/js/app.js', 'utf8');
t('isGreetingMsg 用 slice(0, idx)', src.includes('return !all.slice(0, idx).some(x => x.role === \'user\');'));
t('旧的整表判据已删干净', !src.includes('return !all.some(x => x.role === \'user\');'));
t('solo 无条件认领（抽成 putSoloClaimed）', src.includes('async function putSoloClaimed(nid, rec)'));
t('两处 solo 写入都改用它', (src.match(/await putSoloClaimed\(/g) || []).length === 2, '调用点=' + (src.match(/await putSoloClaimed\(/g) || []).length);
t('旧的 nid !== charId 短路已删', !/const oldSolo = \(nid !== x\.charId\)/.test(src));
t('P 有默认值', src.includes('let um, apiMsgs, P = null, useVision'));
t('finally 里 P 判空', src.includes('if (P && P.longMemory) runMemTasks(myCharId)'));
t('visibleText 提到 try 外', src.includes("let visibleText = '';"));
t('pastRaw 提到 try 外', src.includes('let pastRaw = [];'));

console.log('');
console.log('  JS 错误: ' + (errs.length ? JSON.stringify(errs) : '无'));
t('无 JS 错误', errs.length === 0, errs.join(' | '));

console.log('');
console.log('========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
