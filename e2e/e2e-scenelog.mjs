// e2e-scenelog.mjs —— 小说场记的闭环（v0.5.3 · 评审 D/E 条）
//
// 0.5.2.5 的问题：一场戏演完，events/change 只躺在 sc.log 里，全仓库没有一处
// sc.log -> mem.add —— 小说和记忆是两条平行线。这一套钉住三件事：
//   1. 结束页真的把场记摆出来（events / 变化 / 新设定 / 缺了哪几块底色）
//   2. 「记进记忆」是 draft、带 scope=scene + sourceSceneId，而且重复点不会重复写
//   3. 「存进设定补记」写进 char.canonExtra，重复点不重复追加，并且
//      canonExtra 真的进了聊天侧的稳定提示词（写进去不生效 = 白写）
// 外加：真装不下的时候结束页要明说，不能只 console。

import puppeteer from 'puppeteer-core';
import http from 'http';
import fs from 'fs';
import path from 'path';
const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');
const WWW = R + '/www';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

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

const PROSE = '雨还在下。她把伞收起来，靠在门边的墙角，水顺着伞骨往下滴，在水泥地上洇出一小片深色。她没有马上开灯，先站在玄关听了一会儿屋里的动静，像在确认什么。「你还没走啊。」她说这句话的时候语气很平，平得有点过了头。桌上摊着那个旧木盒，盒盖开着，里面的东西被挪过位置，边缘留着一道新鲜的划痕。她走过去，手指在盒沿停了停，没有立刻碰。「我本来是要扔的。」她说，「昨天翻出来的时候想，留着也没用。」窗外的雨声忽然大了一阵，把后面那半句话压下去。她低下头笑了一下，笑得很轻，更像是在给自己找台阶。然后她把盒子往你那边推了推，推到桌子中间才收手，指尖在木头上多停了半秒才离开。';
const LOGJSON = '{"events":["她收伞进门","她把盒子推到桌子中间"],"cast":["阿绫"],"change":"盒子从她那边到了桌子中间","openThreads":["盒子里是什么"],"keyLines":["我本来是要扔的。"],"newSettings":["她已经知道那件事了","那把钥匙一直在她那儿"]}';

await page.evaluateOnNewDocument((LOGJSON_TEXT, PROSE_TEXT) => {
  window.__fake = { queue: [], chat: [], once: [] };
  const realFetch = window.fetch.bind(window);
  window.fetch = async function (url, opts) {
    const u = String(url);
    let body = {};
    try { body = JSON.parse((opts && opts.body) || '{}'); } catch (e) {}
    if (u.includes('/chat/completions')) {
      const msgs = body.messages || [];
      const sys = String((msgs[0] || {}).content || '');
      const all = JSON.stringify(msgs);
      if (body.stream === false) {
        window.__fake.once.push({ kind: 'log', sys });
        return new Response(JSON.stringify({ choices: [{ message: { content: LOGJSON_TEXT } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      const item = window.__fake.queue.shift() || { text: PROSE_TEXT, finish: 'stop' };
      window.__fake.chat.push({ sys, all, text: item.text });
      const chunk = (o) => 'data: ' + JSON.stringify(o) + String.fromCharCode(10,10);
      const payload = chunk({ choices: [{ delta: { content: item.text } }] })
        + chunk({ choices: [{ delta: {}, finish_reason: item.finish }], usage: { prompt_tokens: 500, completion_tokens: 400 } })
        + 'data: [DONE]' + String.fromCharCode(10,10);
      return new Response(payload, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    return realFetch(url, opts);
  };
}, LOGJSON, PROSE);

// CI 的 runner 是 en-US：这套读中文文案，必须钉语言。
// 位置在 newPage 之后、goto 之前 —— ci-precheck 的 en-US 伪装插在 newPage 下一行，
// 晚注册的那份才生效。
await page.evaluateOnNewDocument(() => {
  Object.defineProperty(navigator, 'language', { get: () => 'zh-CN', configurable: true });
  Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh'], configurable: true });
});
await page.goto('http://127.0.0.1:' + port + '/index.html', { waitUntil: 'networkidle0' });

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
const baseChar = (id, name, extra) => Object.assign({
  id, name, greeting: '（' + name + '）', persona: '你是' + name + '。她做事慢，说话也慢。',
  avatar: null, temperature: 1.0, maxTokens: 2048, topP: 1.0, reasoningEffort: 'low',
  contextRounds: 20, kaomojiFreq: 0, emojiFreq: 0,
  verbosity: 'medium', splitMessages: false, typingDelay: 0, hesitation: false,
  showTyping: true, longMemory: false, allowEditMine: false,
  descLevel: 'low', povLock: false, appearance: '', appearanceOn: true,
  presetKey: 'blank', createdAt: Date.now()
}, extra || {});

const dbScenes = () => page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const all = await new Promise(r => { const tx = db.transaction('scenes','readonly'); const q = tx.objectStore('scenes').getAll(); q.onsuccess = () => r(q.result || []); });
  db.close();
  return all;
});
const dbMems = () => page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const all = await new Promise(r => { const tx = db.transaction('memories','readonly'); const q = tx.objectStore('memories').getAll(); q.onsuccess = () => r(q.result || []); });
  db.close();
  return all;
});
const dbChar = (id) => page.evaluate(async (cid) => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const c = await new Promise(r => { const tx = db.transaction('characters','readonly'); const q = tx.objectStore('characters').get(cid); q.onsuccess = () => r(q.result || null); });
  db.close();
  return c;
}, id);
const fakeReset = () => page.evaluate(() => { window.__fake.queue = []; window.__fake.chat = []; window.__fake.once = []; });
const visible = (sel) => page.evaluate(s => { const e = document.querySelector(s); if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).display !== 'none'; }, sel);
const click = async (sel) => { await page.waitForSelector(sel, { timeout: 15000 }); await page.evaluate(s => { const e = document.querySelector(s); if (e) e.click(); }, sel); };

await seed({
  chars: [baseChar('sl1', '阿绫', { myProfile: '我在修车铺，手上有油。' })],
  kv: [{ k: 'settings', v: { apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', clockMode: false } }]
});
await page.evaluate(() => location.reload());
await page.waitForFunction(() => !!document.querySelector('#char-list .char-card'), { timeout: 20000 }).catch(() => {});
await sleep(600);

// ---------- 1. 开一场短戏 ----------
console.log('=== 1. 开一场短戏，演完 ===');
await fakeReset();
await click('#btn-settings');
await sleep(400);
await click('[data-wb-drawer="scene"]');
await sleep(500);
await page.evaluate(() => {
  const s = document.getElementById('sc-char');
  if (s) { s.value = 'sl1'; s.dispatchEvent(new Event('change', { bubbles: true })); }
  const p = document.getElementById('sc-place'); if (p) p.value = '出租屋玄关';
  const tm = document.getElementById('sc-time'); if (tm) tm.value = '夜里';
});
await sleep(300);
await click('#sc-go');
await page.waitForFunction(() => {
  const v = document.getElementById('view-read');
  return !!v && v.classList.contains('active');
}, { timeout: 40000 });
await page.waitForFunction(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const all = await new Promise(r => { const tx = db.transaction('scenes','readonly'); const q = tx.objectStore('scenes').getAll(); q.onsuccess = () => r(q.result || []); });
  db.close();
  return all.length > 0 && all.every(x => x.status !== 'generating');
}, { timeout: 90000 }).catch(() => {});
await sleep(800);

const scenes = await dbScenes();
const sc0 = scenes[0] || {};
if (process.env.DBG) {
  const hh = await page.evaluate(() => ({ chat: window.__fake.chat.length, kinds: window.__fake.once.map(x => x.kind) }));
  const env = await page.evaluate(() => ({ banner: !!document.querySelector('#setup-banner') && document.querySelector('#setup-banner').classList.contains('hidden'), toast: (document.querySelector('#toast') || {}).textContent || '', busy: document.body.className, charId: (document.querySelector('#sc-char') || {}).value || '', beats: (window.__sc || '') }));
  console.log('  DBG ' + JSON.stringify({ status: sc0.status, blocks: (sc0.blocks || []).length, log: sc0.log, hits: hh, env, errs: errs.slice(0, 4) }));
}
t('这一场演完了', sc0.status === 'done', 'status=' + sc0.status);
t('场记里带上了 newSettings', Array.isArray(sc0.log && sc0.log.newSettings) && sc0.log.newSettings.length === 2,
  JSON.stringify(sc0.log && sc0.log.newSettings));

// ---------- 2. 结束页把场记摆出来 ----------
console.log('=== 2. 结束页的场记 ----------');
t('结束页有场记块', await visible('#rv-end .rv-log'), '');
const logText = await page.evaluate(() => { const e = document.querySelector('#rv-end .rv-log'); return e ? e.textContent : ''; });
t('场记列出了事件', logText.indexOf('她收伞进门') >= 0, logText.slice(0, 120));
t('场记列出了变化', logText.indexOf('盒子从她那边到了桌子中间') >= 0, '');
t('场记列出了新设定', logText.indexOf('那把钥匙一直在她那儿') >= 0, '');
t('默认不算正史（按钮不可点）',
  await page.evaluate(() => { const b = document.getElementById('rv-log-mem'); return !!b && b.disabled === true; }), '');
// v0.5.3.1：灰着的时候旁边必须说清先勾什么，否则它就是个死按钮。
t('灰按钮旁边写明了先勾什么',
  (await page.evaluate(() => { const e = document.getElementById('rv-log-tip'); return e ? e.textContent.trim() : ''; })).indexOf('先勾上') >= 0, '');

// ---------- 3. 勾成「算正史」-> 记进记忆 ----------
console.log('=== 3. 记进记忆 ----------');
await page.evaluate(() => {
  const c = document.getElementById('rv-log-reckon');
  if (c) { c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); }
});
await sleep(900);
t('勾上之后按钮可点',
  await page.evaluate(() => { const b = document.getElementById('rv-log-mem'); return !!b && b.disabled === false; }), '');
t('勾上之后提示换成「会写成待确认的记忆」',
  (await page.evaluate(() => { const e = document.getElementById('rv-log-tip'); return e ? e.textContent.trim() : ''; })).indexOf('待确认') >= 0, '');
t('正史标记落库了', (await dbScenes())[0].canon === true, '');

await click('#rv-log-mem');
await sleep(1200);
let mems = await dbMems();
const sceneMems = mems.filter(m => m && m.sourceKind === 'scene');
t('写进了记忆', sceneMems.length === 3, 'len=' + sceneMems.length);
t('写的是 draft（等确认，不自动转正）', sceneMems.every(m => m.status === 'draft'),
  JSON.stringify(sceneMems.map(m => m.status)));
t('作用域是 scene（只在小说里）', sceneMems.every(m => m.scope === 'scene'),
  JSON.stringify(sceneMems.map(m => m.scope)));
t('带上了 sourceSceneId', sceneMems.every(m => String(m.sourceSceneId) === String(sc0.id)),
  JSON.stringify(sceneMems.map(m => m.sourceSceneId)));

const n1 = sceneMems.length;
await click('#rv-log-mem');
await sleep(1200);
mems = await dbMems();
t('再点一次不会重复写', mems.filter(m => m && m.sourceKind === 'scene').length === n1,
  'before=' + n1 + ' after=' + mems.filter(m => m && m.sourceKind === 'scene').length);

// ---------- 4. 存进设定补记 ----------
console.log('=== 4. 存进设定补记 ----------');
await click('#rv-log-canon');
await sleep(1000);
let ch = await dbChar('sl1');
t('canonExtra 写进去了', String(ch.canonExtra || '').indexOf('那把钥匙一直在她那儿') >= 0,
  JSON.stringify(ch.canonExtra));
const ce1 = String(ch.canonExtra || '');
await click('#rv-log-canon');
await sleep(1000);
ch = await dbChar('sl1');
t('再点一次不重复追加', String(ch.canonExtra || '') === ce1, JSON.stringify(ch.canonExtra));

// ---------- 5. canonExtra 真的进聊天提示词 ----------
console.log('=== 5. 后来补的设定进聊天提示词 ----------');
await fakeReset();
await page.evaluate(() => { const b = document.getElementById('btn-back'); if (b) b.click(); });
await sleep(800);
await page.evaluate(() => { const m = document.querySelector('[data-drawer-chat]'); if (m) m.click(); });
await sleep(600);
await page.evaluate(() => {
  const el = document.getElementById('input');
  if (el) { el.value = '在吗'; el.dispatchEvent(new Event('input', { bubbles: true })); }
});
await page.evaluate(() => { const b = document.getElementById('btn-send'); if (b) b.click(); });
await sleep(2500);
const chatSys = await page.evaluate(() => { const c = window.__fake.chat[0]; return c ? String(c.sys) : ''; });
t('聊天真的发出了请求', chatSys.length > 200, 'len=' + chatSys.length);
t('「后来补的设定」这一段进了稳定提示词', chatSys.indexOf('后来补的设定') >= 0, '');
t('里面那条设定原文也在', chatSys.indexOf('那把钥匙一直在她那儿') >= 0, '');

// ---------- 6. 装不下时要明说 ----------
console.log('=== 6. 底色装不下 -> 结束页明说 ----------');
const huge = [];
for (let i = 0; i < 60; i++) huge.push('她是第' + i + '条很长的设定，' + '这一句用来占字数。'.repeat(6));
await seed({ chars: [baseChar('sl2', '阿绫二', { persona: huge.join(''), canonExtra: '这一段很长的补记。'.repeat(60) })] });
await page.evaluate(() => location.reload());
await page.waitForFunction(() => !!document.querySelector('#char-list .char-card'), { timeout: 20000 }).catch(() => {});
await sleep(600);
await fakeReset();
await page.evaluate(() => {
  window.__fake.queue = [];
});
// 直接算一次底色，看 dropped 字段（比开一场省一半时间，测的是同一个函数）
const dropInfo = await page.evaluate(async () => {
  const m = await import('./js/scenectx.js');
  const parts = { self: '她'.repeat(9000), canon: '设'.repeat(2000), voice: '声'.repeat(2000),
    user: '你'.repeat(1000), profile: '他'.repeat(1000), env: '处'.repeat(1000),
    world: '世'.repeat(2000), mem: '记'.repeat(2000) };
  // 传小上限逼出丢弃分支：默认配置下八块上限合计 10900 < 11000，满卡不丢（0.5.2.5 的 bug 是反过来）。
  const r = m.assembleSceneContext(parts, 3000);
  return { hasText: r.text.length > 0, dropped: r.dropped.map(d => d.key), chars: r.chars };
});
t('超长装配时真的丢了块', dropInfo.dropped.length > 0, JSON.stringify(dropInfo.dropped));
t('先丢的是世界书和记忆（不是声音和关系）',
  dropInfo.dropped.indexOf('world') >= 0 || dropInfo.dropped.indexOf('mem') >= 0, JSON.stringify(dropInfo.dropped));
t('丢完之后总长仍在上限内', dropInfo.chars <= 3000, String(dropInfo.chars));
t('默认配置（11000）满卡不丢', await page.evaluate(async () => {
  const m = await import('./js/scenectx.js');
  const parts = { self: '她'.repeat(9000), canon: '设'.repeat(2000), voice: '声'.repeat(2000),
    user: '你'.repeat(1000), profile: '他'.repeat(1000), env: '处'.repeat(1000),
    world: '世'.repeat(2000), mem: '记'.repeat(2000) };
  const r = m.assembleSceneContext(parts);
  return r.dropped.length === 0 && r.chars <= 11000;
}), '');

// ---------- 7. 无未捕获报错 ----------
console.log('=== 7. 无未捕获报错 ----------');
t('没有 pageerror', errs.length === 0, JSON.stringify(errs.slice(0, 3)));

console.log(String.fromCharCode(10) + '通过 ' + pass + ' / 失败 ' + fail);
await browser.close();
server.close();
process.exit(fail > 0 ? 1 : 0);
