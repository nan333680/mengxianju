// e2e-settings-blind.mjs — 四个"从来没有任何 e2e 提到过"的设置键（v0.4.3 设置审计）
//
// 审计 61 个设置键的读点时，把 e2e 目录（137 套）逐键 grep 了一遍，
// 剩下这四个键在任何套件里都没出现过：
//   inputMaxH（输入框最多长到几行）/ enterSend（回车就发还是换行）
//   globalOverride（已废弃的「全局统一」）/ searchProvider（搜索后端）
// 静态读点都核对过是真的，这里补上可执行的证据 —— 每个键都走
// 【界面点一下 → 落库的值 → 产物上看得见的差别】这三段。
import puppeteer from 'puppeteer-core';
import http from 'http'; import fs from 'fs'; import path from 'path';
const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');
const WWW = R + '/www';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8' };
const NL = String.fromCharCode(10);
let pass = 0, fail = 0;
const t = (n, ok, ex) => { if (ok) { pass++; console.log('  OK   ' + n); } else { fail++; console.log('  FAIL ' + n + (ex !== undefined ? '  -> ' + JSON.stringify(ex) : '')); } };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = path.join(WWW, p);
  if (!fs.existsSync(f)) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 120000,
  args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
const page = await browser.newPage();
await page.evaluateOnNewDocument(() => {
  Object.defineProperty(navigator, 'language', { get: () => 'zh-CN', configurable: true });
  Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh'], configurable: true });
});
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = []; page.on('pageerror', e => errs.push(e.message));
const sleep = ms => new Promise(r => setTimeout(r, ms));

let lastBody = null;
const searchUrls = [];
// 搜索后端各家的响应体形状不一样，统一回一份"每家都能解析"的假数据 ——
// 断言只看【请求打到了哪个 host】，返回内容只要能解析就行。
const SEARCH_FAKE = JSON.stringify({
  results: [{ title: '假结果', url: 'https://example.com/a', content: '假内容', text: '假内容', description: '假内容' }],
  web: { results: [{ title: '假结果', url: 'https://example.com/a', description: '假内容' }] },
  search_result: [{ title: '假结果', link: 'https://example.com/a', content: '假内容' }],
});
await page.setRequestInterception(true);
page.on('request', req => {
  const u = req.url();
  if (u.includes('/chat/completions')) {
    if (req.method() === 'OPTIONS') { req.respond({ status: 204, headers: { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Headers':'*', 'Access-Control-Allow-Methods':'*' } }); return; }
    try { const b = JSON.parse(req.postData() || '{}'); if (b.stream) lastBody = b; } catch (e) { /* ignore */ }
    const chunk = JSON.stringify({ choices: [{ delta: { content: '好。' } }] });
    req.respond({ status: 200, headers: { 'Access-Control-Allow-Origin':'*' }, contentType: 'text/event-stream',
      body: 'data: ' + chunk + NL + NL + 'data: [DONE]' + NL + NL }); return;
  }
  // 搜索后端：只记 URL，不出网
  if (/tavily\.com|exa\.ai|search\.brave\.com|bigmodel\.cn\/api\/paas\/v4\/web_search/.test(u)) {
    searchUrls.push(u);
    req.respond({ status: 200, headers: { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Headers':'*' },
      contentType: 'application/json', body: SEARCH_FAKE }); return;
  }
  req.continue();
});

const CHAR_ID = 'sb1';
const APP_URL = 'http://127.0.0.1:' + port + '/';
// ⚠️ 改库之前必须先离开 App 页面 —— App 卸载时会把设置回写，和测试写的值打架。
const offline = () => page.goto(APP_URL + 'js/presets.js', { waitUntil: 'domcontentloaded' });
const openDb = async (fn, arg) => page.evaluate(fn, arg);
const putKV = (patch) => openDb(async (o) => {
  const req = indexedDB.open('ai-companion');
  const db = await new Promise(r => { req.onsuccess = () => r(req.result); });
  const rec = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get('settings'); q.onsuccess = () => r(q.result); });
  const v = Object.assign({}, (rec && rec.v) || {}, o);
  await new Promise(r => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put({ k: 'settings', v }); tx.oncomplete = r; });
  db.close();
}, patch);
const readKV = () => openDb(async () => {
  const req = indexedDB.open('ai-companion');
  const db = await new Promise(r => { req.onsuccess = () => r(req.result); });
  const rec = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get('settings'); q.onsuccess = () => r(q.result); });
  db.close();
  return (rec && rec.v) || {};
});
const putChar = (patch) => openDb(async (o) => {
  const req = indexedDB.open('ai-companion');
  const db = await new Promise(r => { req.onsuccess = () => r(req.result); });
  const c = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').get(o.id); q.onsuccess = () => r(q.result); });
  for (const k of Object.keys(o.patch)) { if (o.patch[k] === '__DELETE__') delete c[k]; else c[k] = o.patch[k]; }
  await new Promise(r => { const tx = db.transaction('characters', 'readwrite'); tx.objectStore('characters').put(c); tx.oncomplete = r; });
  db.close();
}, { id: CHAR_ID, patch });
const readMsgs = () => openDb(async () => {
  const req = indexedDB.open('ai-companion');
  const db = await new Promise(r => { req.onsuccess = () => r(req.result); });
  const all = await new Promise(r => { const q = db.transaction('messages').objectStore('messages').getAll(); q.onsuccess = () => r(q.result); });
  db.close();
  return all;
});
const enterChat = async () => {
  await page.goto(APP_URL, { waitUntil: 'networkidle0' }); await sleep(900);
  await page.evaluate(() => { const c = [...document.querySelectorAll('#char-list .char-card')][0]; if (c) c.click(); });
  await sleep(1200);
};
const send = async (text) => {
  lastBody = null;
  await page.evaluate(x => { const i = document.getElementById('input'); i.value = x; i.dispatchEvent(new Event('input', { bubbles: true })); }, text);
  await sleep(150);
  await page.evaluate(() => document.getElementById('btn-send').click());
  for (let i = 0; i < 60; i++) { await sleep(250); const b = await page.$eval('#btn-stop', e => !e.classList.contains('hidden')).catch(() => false); if (!b) break; }
  await sleep(400);
  return lastBody;
};
// 回车键真的按下去（不是点发送按钮）
const pressEnter = async (text) => {
  await page.evaluate(x => {
    const i = document.getElementById('input');
    i.value = x; i.dispatchEvent(new Event('input', { bubbles: true }));
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
  }, text);
  await sleep(1200);
};
const clickSeg = async (boxId, v) => page.evaluate((o) => {
  const b = document.querySelector('#' + o.boxId + ' button[data-v="' + o.v + '"]');
  if (b) b.click();
}, { boxId, v });
// ⚠️ 设置页里的控件是【进设置页那一刻】才绑定和渲染的（app.js:3423 → bindSettings）。
//    不先走一遍抽屉，`#s-input-h` / `#s-search-vendor` 这些节点还在，但里面是空的、
//    onclick 也没挂 —— 点了没反应，测出来会像是产品坏了。
const openSettings = async () => {
  await page.evaluate(() => document.getElementById('btn-settings').click());
  await sleep(400);
  await page.evaluate(() => { const b = document.querySelector('[data-wb-drawer="settings"]'); if (b) b.click(); });
  await sleep(900);
};
const closeSettings = async () => {
  await page.evaluate(() => document.getElementById('btn-set-back').click());
  await sleep(700);
};

// ---------- 建库 ----------
await page.goto(APP_URL, { waitUntil: 'networkidle0', timeout: 40000 });
await sleep(1200);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil: 'networkidle0' }); await sleep(700);
await openDb(async (id) => {
  const req = indexedDB.open('ai-companion');
  const db = await new Promise(r => { req.onsuccess = () => r(req.result); });
  const put = (st, rec) => new Promise(r => { const tx = db.transaction(st, 'readwrite'); tx.objectStore(st).put(rec); tx.oncomplete = r; });
  const rec = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get('settings'); q.onsuccess = () => r(q.result); });
  await put('kv', { k: 'settings', v: Object.assign({}, (rec && rec.v) || {}, {
    apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com', worldbookOn: false,
    myProfile: '', myEnv: '', splitMax: 3, clockMode: false, clockDetail: true,
    historyTime: true, autoArchive: false, temperature: 1.5 }) });
  await put('characters', { id, name: '甲', greeting: '（开场）', persona: '你是甲。', avatar: null,
    presetKey: 'blank', createdAt: Date.now(), temperature: 0.2, maxTokens: 2048,
    verbosity: 'medium', descLevel: 'mid', detailDrive: 'mid', povStyle: '', thinkMode: false,
    appearance: '', appearanceOn: true, splitMessages: false, hesitation: true, longMemory: true,
    kaomojiFreq: 0.15, kaomojiStyle: 'jp-soft', emojiFreq: 0.1, contextRounds: 20 });
  db.close();
}, CHAR_ID);
await enterChat();
t('进到聊天页', await page.evaluate(() => document.querySelector('#view-chat').classList.contains('active')));

// ---------- 1. enterSend：回车就发 / 回车换行 ----------
console.log(NL + '--- 1. enterSend（回车到底发不发）');
t('默认是「回车就发」（KV 里没写这个键也算开着）', (await readKV()).enterSend !== false);
const before = (await readMsgs()).length;
await pressEnter('回车就该发出去');
const after1 = (await readMsgs()).length;
t('回车就发：按一下回车，消息真的出去了（+2 条：他 + 她）', after1 === before + 2, { before, after: after1 });
t('回车就发：输入框被清空', await page.evaluate(() => document.getElementById('input').value === ''));

await openSettings();
await clickSeg('s-enter-send', 'off');   // 界面上的「回车换行」
await sleep(500);
await closeSettings();
t('点「回车换行」落库：enterSend = false', (await readKV()).enterSend === false);
const b2 = (await readMsgs()).length;
await pressEnter('这行应该留在框里');
const a2 = (await readMsgs()).length;
t('回车换行：按回车【不】发消息', a2 === b2, { before: b2, after: a2 });
t('回车换行：内容还留在输入框里', await page.evaluate(() => document.getElementById('input').value === '这行应该留在框里'));
await page.evaluate(() => document.getElementById('btn-send').click());
for (let i = 0; i < 60; i++) { await sleep(250); const b = await page.$eval('#btn-stop', e => !e.classList.contains('hidden')).catch(() => false); if (!b) break; }
await sleep(400);
t('回车换行时「发送」按钮照常能发（不是把功能弄坏了）', (await readMsgs()).length === b2 + 2);

await openSettings();
await clickSeg('s-enter-send', 'on');     // 换回来
await sleep(500);
await closeSettings();
await sleep(300);
t('换回「回车就发」落库：enterSend = true（界面上也高亮回来了）', (await readKV()).enterSend === true);

// ---------- 2. inputMaxH：输入框最多长到几行 ----------
console.log(NL + '--- 2. inputMaxH（输入框最高几行）');
const boxVar = () => page.evaluate(() => {
  const el = document.getElementById('input');
  const b = el.parentElement;
  return { v: b.style.getPropertyValue('--input-max'), maxH: getComputedStyle(b).maxHeight };
});
t('默认 3 行 = 120px（老版本的观感）', (await boxVar()).v === '120px', await boxVar());
await openSettings();
t('设置页里「输入框行数」有 5 个档位（1/2/3/5/8）',
  await page.$$eval('#s-input-h button', els => els.map(e => e.dataset.v).join(',')) === '1,2,3,5,8');
await clickSeg('s-input-h', '8');
await sleep(500);
t('点「8 行」落库：inputMaxH = 8', (await readKV()).inputMaxH === 8);
const v8 = await boxVar();
t('8 行 → --input-max = 320px', v8.v === '320px', v8);
t('8 行 → 说明行同步改写', (await page.$eval('#s-input-h-note', e => e.textContent)).includes('8 行'));
await clickSeg('s-input-h', '1');
await sleep(500);
const v1 = await boxVar();
t('点「1 行」→ 40px，且提示改成"只有一行"', v1.v === '40px' && (await page.$eval('#s-input-h-note', e => e.textContent)).includes('只有一行'), v1);
await clickSeg('s-input-h', '3');
await sleep(400);
await closeSettings();

// ---------- 3. globalOverride：废弃的「全局统一」不能再静默废掉角色参数 ----------
console.log(NL + '--- 3. globalOverride（旧备份里还开着它）');
await putChar({ temperature: 0.2 });
await offline();
await putKV({ globalOverride: true });          // 模拟一份老备份导进来
await enterChat();
const body3 = await send('温度是多少');
t('角色自己设的 temperature 仍然进请求体（0.2，不是全局的 1.5）', body3 && body3.temperature === 0.2, body3 && body3.temperature);
t('启动时把 globalOverride 强制写回 false（v1.21.52 的修复）', (await readKV()).globalOverride === false);
await putChar({ temperature: '__DELETE__' });   // 角色没设过 → 回退全局
await offline(); await putKV({ globalOverride: false }); await enterChat();
const body3b = await send('再来一次');
t('角色没设过时回退到全局（1.5）', body3b && body3b.temperature === 1.5, body3b && body3b.temperature);

// ---------- 4. searchProvider：搜索到底打给哪一家 ----------
console.log(NL + '--- 4. searchProvider（搜索后端）');
await offline();
await putKV({ searchKey: 'sk-search-test', searchProvider: 'brave' });
await enterChat();
await openSettings();
t('界面下拉框回显 brave', await page.$eval('#s-search-vendor', e => e.value) === 'brave');
searchUrls.length = 0;
await page.evaluate(() => document.getElementById('btn-search-test').click());
await sleep(1500);
t('brave：请求打到 api.search.brave.com', searchUrls.some(u => u.includes('api.search.brave.com')), searchUrls);

await page.evaluate(() => {
  const sv = document.getElementById('s-search-vendor');
  sv.value = 'exa'; sv.dispatchEvent(new Event('change', { bubbles: true }));
});
await sleep(600);
t('下拉框改 exa 落库：searchProvider = exa', (await readKV()).searchProvider === 'exa');
searchUrls.length = 0;
await page.evaluate(() => document.getElementById('btn-search-test').click());
await sleep(1500);
t('exa：请求打到 api.exa.ai', searchUrls.some(u => u.includes('api.exa.ai')), searchUrls);

await page.evaluate(() => {
  const sv = document.getElementById('s-search-vendor');
  sv.value = 'zhipu'; sv.dispatchEvent(new Event('change', { bubbles: true }));
});
await sleep(600);
searchUrls.length = 0;
await page.evaluate(() => document.getElementById('btn-search-test').click());
await sleep(1500);
t('zhipu：请求打到 open.bigmodel.cn 的 web_search', searchUrls.some(u => u.includes('/web_search')), searchUrls);

await page.evaluate(() => {
  const sv = document.getElementById('s-search-vendor');
  sv.value = 'tavily'; sv.dispatchEvent(new Event('change', { bubbles: true }));
});
await sleep(600);
searchUrls.length = 0;
await page.evaluate(() => document.getElementById('btn-search-test').click());
await sleep(1500);
t('tavily：请求打到 api.tavily.com', searchUrls.some(u => u.includes('api.tavily.com')), searchUrls);

// ---------- 收尾 ----------
t('全程没有页面报错', errs.length === 0, errs.slice(0, 3));
console.log(NL + '通过 ' + pass + ' / 失败 ' + fail);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
