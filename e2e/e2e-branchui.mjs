// e2e-branchui.mjs —— 分支面板 + 断链修复（v0.5.3.1）
//
// 覆盖：
//   1. 老数据的 parentId 是【空字符串】时也算缺父（爱丽丝那种两棵根的备份）——
//      修复前 pathTo 走到空串就停，屏幕上只剩后面那一截，前面的历史看起来'没了'。
//   2. 有岔路时顶栏下面出现提示条，没岔路时收起
//   3. 面板列出当前线上每一个岔路口，标出「当前」，点一下就跳过去
import puppeteer from 'puppeteer-core';
import http from 'http';
import fs from 'fs';
import path from 'path';
const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');
const WWW = R + '/www';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8' };
const server = http.createServer((req,res) => {
  let q = decodeURIComponent(req.url.split('?')[0]); if (q==='/') q='/index.html';
  const f = path.join(WWW, q);
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
  Object.defineProperty(navigator, 'language', { get: () => 'zh-CN', configurable: true });
  Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN','zh'], configurable: true });
  window.fetch = async function (url, opts) {
    const u = String(url);
    if (u.includes('/chat/completions')) {
      const chunk = (o) => 'data: ' + JSON.stringify(o) + String.fromCharCode(10,10);
      const payload = chunk({ choices: [{ delta: { content: '好。' } }] }) +
        chunk({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }) +
        'data: [DONE]' + String.fromCharCode(10,10);
      return new Response(payload, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
});

async function seed(spec) {
  return await page.evaluate(async (s) => {
    const o = indexedDB.open('ai-companion');
    const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
    const put = (store, rec) => new Promise(r => { const tx = db.transaction(store,'readwrite'); tx.objectStore(store).put(rec); tx.oncomplete = r; });
    for (const c of (s.chars||[])) await put('characters', c);
    for (const e of (s.kv||[])) await put('kv', e);
    for (const m of (s.msgs||[])) await put('messages', m);
    db.close();
  }, spec);
}
const ch = (id, name) => ({ id, name, greeting: '（'+name+'）嗯。', persona: '你是'+name+'。', avatar: null,
  temperature: 1.0, maxTokens: 2048, topP: 1.0, reasoningEffort: 'low', contextRounds: 20,
  kaomojiFreq: 0, emojiFreq: 0, verbosity: 'medium', splitMessages: false, typingDelay: 0,
  hesitation: false, showTyping: true, longMemory: false, allowEditMine: false,
  descLevel: 'low', povLock: false, appearance: '', appearanceOn: true, presetKey: 'blank', createdAt: Date.now() });
const M = (cid, id, role, content, ts, parentId) => ({ id, charId: cid, role, content, ts, story: null, parentId });
const T = 1790000000000;

await page.goto('http://127.0.0.1:'+port+'/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => document.querySelectorAll('#messages *').length > 0, { timeout: 40000 }).catch(()=>{});

// ---------- 1. 有岔路的对话 ----------
await seed({
  chars: [ch('bui1','岔路'), ch('bui2','断链')],
  kv: [ { k:'settings', v:{ apiKey:'sk-test', baseUrl:'https://api.deepseek.com', model:'deepseek-flash', clockMode:false } },
        { k:'leaf:bui1', v:'m6' }, { k:'leaf:bui2', v:'d4' } ],
  msgs: [
    M('bui1','m1','user','你好',T),
    M('bui1','m2','assistant','第一版回答',T+1,'m1'),
    M('bui1','m3','user','继续',T+2,'m2'),
    M('bui1','m4','assistant','第一版结尾',T+3,'m3'),
    M('bui1','m5','assistant','第二版回答',T+4,'m1'),
    M('bui1','m6','user','另一条路',T+5,'m5'),
    M('bui2','d1','user','开头那句',T+10,''),
    M('bui2','d2','assistant','接着回',T+11,'d1'),
    M('bui2','d3','assistant','断链接上',T+12,''),
    M('bui2','d4','user','后来又说了',T+13,'d3')
  ]
});
await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => document.querySelectorAll('#messages .msg').length > 0, { timeout: 40000 }).catch(()=>{});
await sleep(800);

async function openChar(id) {
  await page.evaluate(async (cid) => {
    const o = indexedDB.open('ai-companion');
    const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
    const tx = db.transaction('kv','readwrite');
    tx.objectStore('kv').put({ k:'lastCharId', v: cid });
    await new Promise(r => tx.oncomplete = r);
    db.close();
  }, id);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => document.querySelectorAll('#messages .msg').length > 0, { timeout: 40000 }).catch(()=>{});
  await sleep(900);
}

await openChar('bui1');
const texts1 = await page.$$eval('#messages .msg', els => els.map(e => (e.textContent||'').trim().slice(0,20)));
console.log('bui1 屏幕: ' + JSON.stringify(texts1));
t('活动路径 3 条（另一支不在屏上）', texts1.length === 3, String(texts1.length));
const barVis = await page.evaluate(() => { const b = document.getElementById('chat-branch'); return b ? { hidden: b.classList.contains('hidden'), text: b.textContent.trim() } : null; });
console.log('提示条: ' + JSON.stringify(barVis));
t('提示条出现了', !!barVis && !barVis.hidden, JSON.stringify(barVis));
t('提示条说 1 个岔路口', !!barVis && barVis.text.includes('1'), barVis && barVis.text);

await page.evaluate(() => document.getElementById('chat-branch').click());
await sleep(500);
const panel = await page.evaluate(() => {
  const m = document.getElementById('branch-modal');
  const opts = Array.from(document.querySelectorAll('#branch-list .br-opt')).map(b => ({ goto: b.dataset.goto, txt: b.textContent.trim(), on: b.classList.contains('on') }));
  return { hidden: m.classList.contains('hidden'), opts };
});
console.log('面板: ' + JSON.stringify(panel));
t('面板打开了', !panel.hidden);
t('列出两个走向', panel.opts.length === 2, String(panel.opts.length));
t('当前那条标着「当前」', panel.opts.filter(o => o.on).length === 1);

const other = panel.opts.find(o => !o.on);
await page.evaluate((g) => { document.querySelector('#branch-list .br-opt[data-goto="'+g+'"]').click(); }, other.goto);
await sleep(900);
const texts2 = await page.$$eval('#messages .msg', els => els.map(e => (e.textContent||'').trim().slice(0,20)));
console.log('切过去之后: ' + JSON.stringify(texts2));
t('切到了另一支（4 条）', texts2.length === 4, String(texts2.length));
t('屏幕上是第一版的内容', texts2.join('|').includes('第一版结尾'), texts2.join('|'));

// ---------- 2. 断链（假根 parentId 为空串） ----------
await openChar('bui2');
const texts3 = await page.$$eval('#messages .msg', els => els.map(e => (e.textContent||'').trim().slice(0,20)));
console.log('bui2 屏幕: ' + JSON.stringify(texts3));
t('断链接回了一条线（4 条都看得见）', texts3.length === 4, String(texts3.length));
t('屏幕上确实是这个角色的对话（不是上一个）', texts3.join('|').includes('断链接上') && texts3.join('|').includes('后来又说了'), texts3.join('|'));
const bar2 = await page.evaluate(() => { const b = document.getElementById('chat-branch'); return { hidden: b.classList.contains('hidden'), text: b.textContent.trim() }; });
t('接回一条线之后没有岔路，提示条收起', bar2.hidden === true, JSON.stringify(bar2));

t('没有未捕获报错', errs.length === 0, errs.join(' | '));
console.log('');
console.log('通过 ' + pass + ' / 失败 ' + fail);
await browser.close(); server.close();
process.exit(fail>0?1:0);