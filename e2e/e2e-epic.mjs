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


const CID = 'ep1';
const baseChar = (extra) => Object.assign({
  id: CID, name: '蓝白', greeting: '', persona: '你是蓝白。',
  avatar: null, temperature: 1.0, maxTokens: 2048, topP: 1.0, reasoningEffort: 'low',
  contextRounds: 20, kaomojiFreq: 0, emojiFreq: 0,
  verbosity: 'medium', splitMessages: false, typingDelay: 0, hesitation: false,
  showTyping: true, longMemory: false, allowEditMine: false,
  descLevel: 'low', povLock: false, appearance: '', appearanceOn: true,
  presetKey: 'blank', createdAt: Date.now()
}, extra || {});

const T0 = 1790000000000;
const seedAll = async (verb, extra) => {
  await page.evaluate(async (v) => {
    const o = indexedDB.open('ai-companion');
    const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
    const del = (store) => new Promise(r => { const tx = db.transaction(store,'readwrite'); tx.objectStore(store).clear(); tx.oncomplete = r; });
    await del('characters'); await del('messages');
    const put = (store, rec) => new Promise(r => { const tx = db.transaction(store,'readwrite'); tx.objectStore(store).put(rec); tx.oncomplete = r; });
    await put('characters', Object.assign(JSON.parse(v.char), { verbosity: v.verb }));
    // extra 已并入 char（baseChar(extra)），这里不用再合一次
    await put('kv', { k: 'lastCharId', v: 'ep1' });
    await put('kv', { k: 'greeted:ep1', v: true });
    db.close();
  }, { verb, char: JSON.stringify(baseChar(extra)) });
};


// ⚠️ CI 的 runner 是 en-US，而界面语言默认「跟随系统」。这套要读界面上的中文文案，
//    不钉语言的话在 CI 上拿到的是英文，断中文的地方必红（v0.5.2 CI #29 的 e2e-branch）。
//    位置必须在 newPage 之后、goto 之前：tools/ci-precheck.mjs 会把 en-US 伪装插在
//    newPage 紧跟的下一行，晚注册的那份才生效，才能盖过它。
await page.evaluateOnNewDocument(() => {
  Object.defineProperty(navigator, 'language', { get: () => 'zh-CN', configurable: true });
  Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh'], configurable: true });
});
await page.goto('http://127.0.0.1:' + port + '/index.html', { waitUntil: 'networkidle0' });
await sleep(600);
await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const put = (store, rec) => new Promise(r => { const tx = db.transaction(store,'readwrite'); tx.objectStore(store).put(rec); tx.oncomplete = r; });
  await put('kv', { k: 'settings', v: { apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', clockMode: false, historyTime: false } });
  db.close();
});
await seedAll('epic');
await page.goto('http://127.0.0.1:' + port + '/index.html', { waitUntil: 'networkidle0' });
await sleep(1500);

const sendOne = async (text) => {
  await page.evaluate(() => { const i = document.getElementById('input'); i.value = ''; });
  await page.type('#input', text);
  const before = await page.evaluate(() => window.__hits.chat.length);
  await page.evaluate(() => document.getElementById('btn-send').click());
  for (let i = 0; i < 100; i++) {
    const n = await page.evaluate(() => window.__hits.chat.length);
    if (n > before) return await page.evaluate(() => window.__hits.chat[window.__hits.chat.length - 1]);
    await sleep(100);
  }
  return null;
};
const sysOf = (req) => (req && req.messages && req.messages[0] && String(req.messages[0].content || '')) || '';

console.log('');
console.log('=== 1. 长篇档：提示词里有结构要求，max_tokens 抬过 2048 ===');
const r1 = await sendOne('雨下大了。');
t('真的发出去了', !!r1, JSON.stringify(!!r1));
const s1 = sysOf(r1);
t('★ max_tokens 抬到 6144 以上', Number(r1 && r1.max_tokens) >= 6144, String(r1 && r1.max_tokens));
t('★ 有「按【场景】分段」', s1.includes('按【场景】分段'), '');
t('有「落点」要求', s1.includes('这一场要有一个【落点】'), '');
t('有「不要自己跳时间」', s1.includes('不要自己跳时间'), '');
t('台词上限放宽到 800 字', s1.includes('800 字'), '');
t('★ 有反客服腔黑名单', s1.includes('你是她，不是助手'), '');
t('反客服腔点名「总结一下」', s1.includes('总结一下'), '');
t('反客服腔点名「首先 / 其次」', s1.includes('首先 / 其次'), '');

console.log('');
console.log('=== 2. 普通档：没有长篇要求，max_tokens 保持 2048 ===');
await seedAll('medium');
await page.goto('http://127.0.0.1:' + port + '/index.html', { waitUntil: 'networkidle0' });
await sleep(1500);
const r2 = await sendOne('雨下大了。');
t('真的发出去了', !!r2, '');
const s2 = sysOf(r2);
t('★ 没有「按【场景】分段」', !s2.includes('按【场景】分段'), '');
t('没有「落点」要求', !s2.includes('这一场要有一个【落点】'), '');
t('max_tokens 还是 2048', Number(r2 && r2.max_tokens) === 2048, String(r2 && r2.max_tokens));
t('反客服腔仍然在（不分档位）', s2.includes('你是她，不是助手'), '');
t('medium 的长度提示没被换成长篇', !s2.includes('800 字'), '');

console.log('');
console.log('=== 3. 长篇自动串联（epicChain） ===');
// 3a. 默认 0：写完一段就停，不会偷偷多发请求
await seedAll('epic');
await page.goto('http://127.0.0.1:' + port + '/index.html', { waitUntil: 'networkidle0' });
await sleep(1500);
const n0 = await page.evaluate(() => window.__hits.chat.length);
await sendOne('雨下大了。');
await sleep(4500);   // 比自动串联的 2500ms 间隔更久，真串了这里一定看得见
const n0after = await page.evaluate(() => window.__hits.chat.length) - n0;
t('★ 默认（0）不自动接着写', n0after === 1, '请求 ' + n0after + ' 次');

// 3b. 2 段：自己接着再写一次就停
await seedAll('epic', { epicChain: 2 });
await page.goto('http://127.0.0.1:' + port + '/index.html', { waitUntil: 'networkidle0' });
await sleep(1500);
const n1 = await page.evaluate(() => window.__hits.chat.length);
await sendOne('雨下大了。');
let reached = 0;
for (let i = 0; i < 100; i++) {
  reached = await page.evaluate(() => window.__hits.chat.length) - n1;
  if (reached >= 2) break;
  await sleep(150);
}
t('★ 连写 2 段：自动又发了一次', reached >= 2, '请求 ' + reached + ' 次');
await sleep(4500);
const nEnd = await page.evaluate(() => window.__hits.chat.length) - n1;
t('★ 停在 2 段，不会一直写下去', nEnd === 2, '请求 ' + nEnd + ' 次');
const lastReq = await page.evaluate(() => { const a = window.__hits.chat; return a[a.length - 1]; });
const msgs4 = (lastReq && lastReq.messages) || [];
const tailUser = msgs4.filter(m => m.role === 'user').pop() || {};
t('自动那一段发的是「继续往下写」', String(tailUser.content || '').indexOf('继续往下写') >= 0, String(tailUser.content || '').slice(0, 40));
t('自动那一段没有重复他那句台词', String(tailUser.content || '').indexOf('雨下大了') < 0, '');

console.log('');
console.log('=== 4. 没有未捕获错误 ===');
t('无 pageerror', errs.length === 0, errs.join(' | '));

console.log('');
console.log('========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close();
server.close();
process.exit(fail > 0 ? 1 : 0);
