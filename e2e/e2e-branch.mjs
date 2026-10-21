// e2e-branch.mjs —— 非破坏分支（v0.5.1.2 / 0.5.4）
//
// 覆盖：
//   1. 老数据进角色时被串成链（parentId 补齐，且只补一次）
//   2. 屏幕上只画活动那一条线
//   3. 「从这里重聊」不再删消息：旧的那一版还在库里，输入框拿回那条用户消息
//   4. 重聊后新回复挂在同一条用户消息下 = 与旧版成为兄弟
//   5. 喂给模型的上下文只有活动线，被切走的那段不进去
//   6. 菜单里能切回另一个走向，切回去后旧分支整段回来
//   7. 归档预览仍算全量（分支不掉队）

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
  window.__hits = { chat: [] };
  const realFetch = window.fetch.bind(window);
  window.fetch = async function (url, opts) {
    const u = String(url);
    let body = {};
    try { body = JSON.parse((opts && opts.body) || '{}'); } catch (e) {}
    if (u.includes('/chat/completions')) {
      if (body.stream === false) {
        return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      window.__hits.chat.push(body);
      const chunk = (o) => 'data: ' + JSON.stringify(o) + String.fromCharCode(10,10);
      const payload =
        chunk({ choices: [{ delta: { content: '新的一条。' } }] }) +
        chunk({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 5 } }) +
        'data: [DONE]' + String.fromCharCode(10,10);
      return new Response(payload, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    return realFetch(url, opts);
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

const CID = 'br1';
const baseChar = (id, name, extra) => Object.assign({
  id, name, greeting: '（' + name + '）你在啊。', persona: '你是' + name + '。',
  avatar: null, temperature: 1.0, maxTokens: 2048, topP: 1.0, reasoningEffort: 'low',
  contextRounds: 20, kaomojiFreq: 0, emojiFreq: 0,
  verbosity: 'medium', splitMessages: false, typingDelay: 0, hesitation: false,
  showTyping: true, longMemory: false, allowEditMine: false,
  descLevel: 'low', povLock: false, appearance: '', appearanceOn: true,
  presetKey: 'blank', createdAt: Date.now()
}, extra || {});

const M = (id, role, content, ts) => ({ id, charId: CID, role, content, ts, story: null });

const T0 = 1790000000000;

// ⚠️ CI 的 runner 是 en-US，而界面语言默认「跟随系统」。这套要读菜单里的中文文案
//    （「从这里重聊」），不钉语言的话 CI 上拿到的是 "Rewind to here"，必红 ——
//    v0.5.2 的 CI #29 就是这么红的（本地中文机器恒绿，看不见）。
//    位置必须在 newPage 之后、goto 之前：tools/ci-precheck.mjs 会把 en-US 伪装插在
//    newPage 紧跟的下一行，晚注册的那份才生效，才能盖过它。
await page.evaluateOnNewDocument(() => {
  Object.defineProperty(navigator, 'language', { get: () => 'zh-CN', configurable: true });
  Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh'], configurable: true });
});

// 先让页面起来（about:blank 里 IndexedDB 是被拒的），再往里灌数据，最后 reload 一遍。
await page.goto('http://127.0.0.1:' + port + '/index.html', { waitUntil: 'networkidle0' });
await sleep(600);
await seed({
  chars: [baseChar(CID, '蓝白')],
  kv: [
    { k: 'settings', v: { apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', clockMode: false, historyTime: false } },
    { k: 'lastCharId', v: CID },
    { k: 'greeted:' + CID, v: true }
  ],
  msgs: [
    M('m1', 'user', '第一句', T0 + 1),
    M('m2', 'assistant', '第一答', T0 + 2),
    M('m3', 'user', '第二句', T0 + 3),
    M('m4', 'assistant', '第二答', T0 + 4)
  ]
});

const openApp = async () => {
  await page.goto('http://127.0.0.1:' + port + '/index.html', { waitUntil: 'networkidle0' });
  await sleep(1200);
};
await openApp();

const allMsgs = () => page.evaluate(async (cid) => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const rows = await new Promise(r => { const q = db.transaction('messages').objectStore('messages').index('charId').getAll(cid); q.onsuccess = () => r(q.result || []); });
  db.close();
  return rows;
}, CID);
const kvGet = (k) => page.evaluate(async (kk) => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const v = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get(kk); q.onsuccess = () => r(q.result && q.result.v); });
  db.close();
  return v;
}, k);
const shown = () => page.evaluate(() => [...document.querySelectorAll('#messages .msg')].map(e => e.dataset.id));
const inputVal = () => page.$eval('#input', el => el.value);

const menuOpen = async (id) => {
  await page.evaluate(mid => {
    const el = [...document.querySelectorAll('#messages .msg')].find(e => e.dataset.id === mid);
    if (el) el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  }, id);
  for (let i = 0; i < 60; i++) {
    if (await page.evaluate(() => !!document.querySelector('.msg-menu'))) return;
    await sleep(100);
  }
};
const menuItems = () => page.evaluate(() => [...document.querySelectorAll('.msg-menu button')].map(b => b.textContent.trim()));
const clickMenu = async (label, ms = 8000) => {
  for (let i = 0; i < Math.ceil(ms / 120); i++) {
    const ok = await page.evaluate((lb) => {
      const b = [...document.querySelectorAll('.msg-menu button')].find(x => x.textContent.trim() === lb);
      if (b) { b.click(); return true; }
      return false;
    }, label);
    if (ok) return true;
    await sleep(120);
  }
  throw new Error('菜单里一直没出现「' + label + '」');
};

// ---- 1. 老数据串成链 ----
let rows = await allMsgs();
const byId = Object.fromEntries(rows.map(r => [r.id, r]));
t('进角色时老消息都补上了 parentId', rows.every(r => typeof r.parentId === 'string'), JSON.stringify(rows.map(r => [r.id, r.parentId])));
t('链是按时间串的：m2←m1 / m3←m2 / m4←m3',
  byId.m2.parentId === 'm1' && byId.m3.parentId === 'm2' && byId.m4.parentId === 'm3',
  JSON.stringify([byId.m2.parentId, byId.m3.parentId, byId.m4.parentId]));
t('串链只做一次（有 brSeeded 标记）', (await kvGet('brSeeded:' + CID)) === true);
t('活动叶子落在最后一条', (await kvGet('branch:' + CID)) === 'm4', String(await kvGet('branch:' + CID)));

// ---- 2. 只画活动线 ----
t('屏幕上 4 条都在', (await shown()).length === 4, JSON.stringify(await shown()));

// ---- 3. 从这里重聊：不删，直接重走这一段 ----
await menuOpen('m2');
t('非最后一条的菜单里有「从这里重聊」', (await menuItems()).includes('从这里重聊'), JSON.stringify(await menuItems()));
await clickMenu('从这里重聊');
await sleep(400);
for (let i = 0; i < 200; i++) {
  const b2 = await page.$eval('#btn-stop', el => !el.classList.contains('hidden')).catch(()=>false);
  if (!b2 && i > 4) break;
  await sleep(100);
}
await sleep(700);
rows = await allMsgs();
t('★ 重聊没有删掉任何消息', ['m1','m2','m3','m4'].every(x => rows.some(r => r.id === x)), '共 ' + rows.length + ' 条');
t('重聊之后自动重走了一段（多一条回复）', rows.length === 5, '共 ' + rows.length + ' 条：' + rows.map(r => r.role[0] + ':' + r.content).join(' | '));
const newA = rows.find(r => r.role === 'assistant' && r.content === '新的一条。');
t('新回复落库了', !!newA);
t('★ 新回复挂在【同一条】用户消息下（与旧版是兄弟）', !!newA && newA.parentId === 'm1', JSON.stringify(newA && newA.parentId));
t('屏幕上只有这条线：m1 + 新回复', JSON.stringify(await shown()) === JSON.stringify(['m1', newA && newA.id]), JSON.stringify(await shown()));
t('活动叶子推到了新回复', (await kvGet('branch:' + CID)) === (newA && newA.id), String(await kvGet('branch:' + CID)));

// ---- 5. 上下文只喂活动线 ----
const prompt = await page.evaluate(() => {
  const h = window.__hits.chat;
  if (!h.length) return '';
  return (h[h.length - 1].messages || []).map(m => m.content || '').join(String.fromCharCode(10));
});
t('★ 这一轮真的发出去了（提示词非空）', prompt.length > 0, prompt.slice(0, 200));
 t('★ 提示词里没有旧分支的「第二句」', !prompt.includes('第二句'), prompt.slice(0, 200));
t('提示词里有当前这条线的内容', prompt.includes('第一句'));
t('提示词里没有把同一句问两遍', (prompt.match(/第一句/g) || []).length <= 2, String((prompt.match(/第一句/g) || []).length));

// ---- 6. 切回另一个走向 ----
await menuOpen(newA.id);
const items2 = await menuItems();
const brItem = items2.find(x => x.includes('切到另一个走向'));
t('★ 有兄弟的消息菜单里出现「切到另一个走向」', !!brItem, JSON.stringify(items2));
await clickMenu(brItem);
await sleep(800);
t('切回去后屏幕上 4 条（整段旧分支回来了）', (await shown()).length === 4, JSON.stringify(await shown()));
t('活动叶子回到旧分支末端', (await kvGet('branch:' + CID)) === 'm4', String(await kvGet('branch:' + CID)));

// ---- 7. 归档预览仍算全量 ----
const total = await page.evaluate(async (cid) => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const n = await new Promise(r => { const q = db.transaction('messages').objectStore('messages').index('charId').getAll(cid); q.onsuccess = () => r((q.result || []).length); });
  db.close();
  return n;
}, CID);
t('库里 5 条（两条分支都在），归档统计按全量', total === 5, '共 ' + total + ' 条');

t('全程没有未捕获异常', errs.length === 0, errs.join(' | '));

console.log('');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close();
server.close();
process.exit(fail > 0 ? 1 : 0);
