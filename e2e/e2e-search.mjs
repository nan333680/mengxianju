// e2e-search.mjs —— 联网搜索（/搜 手动触发）
//
// 覆盖：
//   1. 默认关：不打 /搜 就完全不联网（不发 search 请求）
//   2. /搜 xxx → 发一次 search 请求，结果注入这一轮
//   3. 聊天记录里存的是关键词，不是 "/搜 xxx" 原文
//   4. 搜索结果只注入这一轮，不写进历史（下一轮不再带）
//   5. 全局关 → /搜 不触发，按本地回答
//   6. 没有 key → /搜 不触发
//   7. 角色级「强制关」压过全局开
//   8. 角色级「强制开」在没有全局时也能生效
//   9. 搜索失败（500）→ 对话照常继续，不卡死
//  10. 只打「/搜」不给词 → 不触发
//  11. 搜索标记渲染在气泡里
//  12. 设置页有搜索区，开关/key/状态能读写
//  13. 老角色（没有 searchPolicy 字段）默认跟随全局

import puppeteer from 'puppeteer-core';
import http from 'http';
import fs from 'fs';
import path from 'path';
// 工作目录自适应（原来写死 C:/A-DSH-Tool/ai-companion）
const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');

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
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = [];
page.on('pageerror', e => errs.push(e.message));
const sleep = ms => new Promise(r=>setTimeout(r,ms));
let pass=0, fail=0;
const t=(n,ok,ex='')=>{ if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));} };

// —— 网络桩 ——
// ⚠️ 不用 CDP 的 setRequestInterception + req.postData()：
// fetch() 发的 body 是 ReadableStream，拦截回调里 postData() 拿到的是空 ——
// 实测第一版就踩了这个坑：搜索确实发出去了，但断言读到 body.query=undefined。
// 改成在页面里 hook window.fetch，参数百分百拿得到。
let searchHits = [];
let chatHits = [];

await page.evaluateOnNewDocument(() => {
  window.__hits = { search: [], chat: [] };
  window.__searchMode = 'ok';
  const realFetch = window.fetch.bind(window);
  window.fetch = async function (url, opts) {
    const u = String(url);
    let body = {};
    try { body = JSON.parse((opts && opts.body) || '{}'); } catch {}
    if (u.includes('api.tavily.com')) {
      window.__hits.search.push({ url: u, body });
      const mode = window.__searchMode;
      if (mode === 'fail') {
        return new Response('{"detail":"boom"}', { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
      const results = mode === 'empty' ? [] : [
        { title: '北京天气 - 中国天气网', url: 'https://weather.example/bj', content: '北京今天晴，18~26℃，北风 3 级。' },
        { title: '北京天气预报', url: 'https://t2.example/bj', content: '未来三天以晴为主。' },
      ];
      return new Response(JSON.stringify({ answer: '北京今天晴，18~26℃。', results }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (u.includes('/chat/completions')) {
      window.__hits.chat.push(body);
      const chunk = (o) => 'data: ' + JSON.stringify(o) + String.fromCharCode(10,10);
      const payload =
        chunk({ choices: [{ delta: { content: '收到。' } }] }) +
        chunk({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 5 } }) +
        'data: [DONE]' + String.fromCharCode(10,10);
      return new Response(payload, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    return realFetch(url, opts);
  };
});

/** 把页面里记的命中同步出来 */
async function syncHits() {
  const h = await page.evaluate(() => ({ search: window.__hits.search, chat: window.__hits.chat }));
  searchHits = h.search; chatHits = h.chat;
}
async function setMode(m) {
  await page.evaluate(mm => { window.__searchMode = mm; }, m);
  const back = await page.evaluate(() => window.__searchMode);
  if (back !== m) console.log('  [warn] setMode(' + m + ') 回读=' + back);
}
async function clearHits() {
  await page.evaluate(() => { window.__hits.search = []; window.__hits.chat = []; });
  searchHits = []; chatHits = [];
}



/** 改全局设置并让页面内存里的 S 跟上（设置页读的是内存 S，不是库） */
async function setSettings(patch) {
  await page.evaluate(async (p) => {
    const o = indexedDB.open('ai-companion');
    const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
    const cur = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get('settings'); q.onsuccess = () => r(q.result); });
    const next = Object.assign({}, (cur && cur.v) || {}, p);
    await new Promise(r => { const tx = db.transaction('kv','readwrite'); tx.objectStore('kv').put({ k:'settings', v: next }); tx.oncomplete = r; });
    db.close();
  }, patch);
  await page.reload({ waitUntil: 'networkidle0' });
  await sleep(800);
}

/** 打开设置页 —— 必须先点 ⚙ 打开抽屉，再点「全部设置」才会 bindSettings。
 *  直接点 #btn-settings 只是开抽屉，控件不会绑定，改了也不生效。 */
async function openSettings() {
  await page.evaluate(() => document.getElementById('btn-settings').click());
  await sleep(700);
  await page.evaluate(() => {
    const x = [...document.querySelectorAll('#drawer-menu [data-wb-drawer]')].find(y => y.dataset.wbDrawer === 'settings');
    if (x) x.click();
  });
  await sleep(900);
}

/** 往库塞角色 */
async function seed(spec) {
  return await page.evaluate(async (s) => {
    const o = indexedDB.open('ai-companion');
    const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
    const put = (store, rec) => new Promise(r => { const tx = db.transaction(store,'readwrite'); tx.objectStore(store).put(rec); tx.oncomplete = r; });
    for (const c of (s.chars||[])) await put('characters', c);
    for (const e of (s.kv||[])) await put('kv', e);
    db.close();
  }, spec);
}

const baseChar = (id, name, extra={}) => ({
  id, name, greeting: '（' + name + '）', persona: '你是' + name + '。',
  avatar: null, temperature: 1.0, maxTokens: 2048, topP: 1.0, reasoningEffort: 'low',
  contextRounds: 20, kaomojiFreq: 0, kaomojiStyle: 'jp-soft', emojiFreq: 0,
  verbosity: 'medium', splitMessages: false, typingDelay: 0, hesitation: false,
  showTyping: true, longMemory: false, allowEditMine: false,
  descLevel: 'low', povLock: false, appearance: '', appearanceOn: true,
  presetKey: 'blank', createdAt: Date.now(), ...extra
});

/** 进聊天页并选中角色 */
async function pickChar(id) {
  await page.evaluate(async (cid) => {
    const o = indexedDB.open('ai-companion');
    const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
    await new Promise(r => { const tx = db.transaction('kv','readwrite'); tx.objectStore('kv').put({ k:'lastCharId', v: cid }); tx.oncomplete = r; });
    db.close();
    location.reload();
  }, id);
  await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30000 }).catch(()=>{});
  await sleep(900);
}

/** 发一条消息并等回复结束 */
async function say(text) {
  await page.evaluate(t => {
    const el = document.getElementById('input');
    el.value = t; el.dispatchEvent(new Event('input', { bubbles: true }));
  }, text);
  await sleep(120);
  await page.evaluate(() => document.getElementById('btn-send').click());
  // 等 stop 出现再消失
  let started = false;
  for (let i = 0; i < 60; i++) {
    const b = await page.$eval('#btn-stop', el => !el.classList.contains('hidden')).catch(()=>false);
    if (b) { started = true; break; }
    await sleep(100);
  }
  if (started) {
    for (let i = 0; i < 200; i++) {
      const b = await page.$eval('#btn-stop', el => !el.classList.contains('hidden')).catch(()=>false);
      if (!b) break;
      await sleep(100);
    }
  }
  await sleep(350);
  return started;
}

async function msgsOf(cid) {
  return await page.evaluate(async (id) => {
    const o = indexedDB.open('ai-companion');
    const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
    const all = await new Promise(r => { const q = db.transaction('messages').objectStore('messages').getAll(); q.onsuccess = () => r(q.result); });
    db.close();
    return all.filter(m => m.charId === id).sort((a,b)=>a.ts-b.ts)
              .map(m => ({ role: m.role, content: m.content, searched: m.searched || '', tags: m.tags || null }));
  }, cid);
}

const reset = async () => { await clearHits(); };

// ================= 开始 =================
await page.goto('http://127.0.0.1:'+port+'/', { waitUntil: 'networkidle0', timeout: 40000 });
await sleep(1200);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil: 'networkidle0' });
await sleep(1000);

const CID = 'csrch1';
const CID_OFF = 'csrch2';
const CID_ON  = 'csrch3';

await seed({
  chars: [
    baseChar(CID, '搜索测试', {}),                                   // 无 searchPolicy = 跟随全局
    baseChar(CID_OFF, '强制关', { searchPolicy: 'off' }),
    baseChar(CID_ON, '强制开', { searchPolicy: 'on' }),
  ],
  kv: [
    { k: 'settings', v: { apiKey: 'sk-test', searchKey: 'tvly-test', searchOn: true, searchCount: 5,
                          baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' } },
  ],
});

console.log('\n=== 1. 默认关：不打 /搜 不联网 ===');
await pickChar(CID);
await reset();
await say('今天北京天气怎么样');
await syncHits(); t('普通消息不发搜索请求', searchHits.length === 0, '实际 ' + searchHits.length);
t('普通消息正常发出', chatHits.length >= 1);
{
  const ms = await msgsOf(CID);
  const u = ms.find(m => m.role === 'user');
  t('用户消息原样落库', u && u.content === '今天北京天气怎么样', JSON.stringify(u));
  t('没有搜索标记', u && !u.tags && !u.searched);
}

console.log('\n=== 2. /搜 触发联网 ===');
await reset();
await say('/搜 今天北京天气');
await syncHits(); t('发了 1 次搜索请求', searchHits.length === 1, '实际 ' + searchHits.length);
t('搜索词正确', searchHits[0] && searchHits[0].body.query === '今天北京天气',
  searchHits[0] ? JSON.stringify(searchHits[0].body.query) : '(无)');
t('带了 key', searchHits[0] && searchHits[0].body.api_key === 'tvly-test');
t('用的是 basic 档', searchHits[0] && searchHits[0].body.search_depth === 'basic');
{
  const injected = chatHits.some(b => (b.messages||[]).some(m => (m.content||'').includes('北京今天晴')));
  t('搜索结果注入到这一轮', injected);
  const hasTail = chatHits.some(b => (b.messages||[]).some(m => (m.content||'').includes('[1] 北京天气')));
  t('结果带编号和标题', hasTail);
}

console.log('\n=== 3. 聊天记录存关键词，不存命令 ===');
{
  const ms = await msgsOf(CID);
  const u = ms.filter(m => m.role === 'user').pop();
  t('存的是关键词', u && u.content === '今天北京天气', JSON.stringify(u && u.content));
  t('不带 /搜 前缀', u && !u.content.startsWith('/搜'));
  // v0.4.4：命令标记统一存进 tags 数组（searched 只读兼容老数据，不再写新的）
  t('记了 tags 字段', u && Array.isArray(u.tags) && u.tags[0].k === 'search' && u.tags[0].arg === '今天北京天气',
    JSON.stringify(u && u.tags));
  t('不再写 searched 字段', u && !u.searched, JSON.stringify(u && u.searched));

  // 气泡里应该渲染出搜索标记（v0.4.4 起 class 是 .tag-chip）
  const tag = await page.evaluate(() => {
    const el = document.querySelector('#messages .msg.me .tag-chip');
    return el ? el.textContent.trim() : null;
  });
  t('气泡里有搜索标记', tag && tag.includes('联网搜索'), JSON.stringify(tag));
  const title = await page.evaluate(() => {
    const el = document.querySelector('#messages .msg.me .tag-chip');
    return el ? (el.getAttribute('title') || '') : '';
  });
  t('气泡标记上挂着关键词', title.includes('今天北京天气'), JSON.stringify(title));
}

console.log('\n=== 4. 结果只注入这一轮 ===');
await reset();
await say('那明天呢');
await syncHits(); t('下一轮不发搜索请求', searchHits.length === 0, '实际 ' + searchHits.length);
{
  const carried = chatHits.some(b => (b.messages||[]).some(m => (m.content||'').includes('北京今天晴')));
  t('上一轮的搜索结果没被带进来', !carried);
}

console.log('\n=== 5. 全局关 → /搜 不触发 ===');
await setSettings({ searchOn: false });
await pickChar(CID);
await reset();
await say('/搜 今天北京天气');
await syncHits(); t('全局关 → 不发搜索请求', searchHits.length === 0, '实际 ' + searchHits.length);
t('对话照常进行', chatHits.length >= 1);
{
  const ms = await msgsOf(CID);
  const u = ms.filter(m => m.role === 'user').pop();
  t('仍按关键词落库', u && u.content === '今天北京天气', JSON.stringify(u && u.content));
}

console.log('\n=== 6. 角色「强制开」压过全局关 ===');
await pickChar(CID_ON);
await reset();
await say('/搜 今天北京天气');
await syncHits(); t('强制开 → 全局关也能搜', searchHits.length === 1, '实际 ' + searchHits.length);

console.log('\n=== 7. 角色「强制关」压过全局开 ===');
await setSettings({ searchOn: true });
await pickChar(CID_OFF);
await reset();
await say('/搜 今天北京天气');
await syncHits(); t('强制关 → 不发搜索请求', searchHits.length === 0, '实际 ' + searchHits.length);
t('对话照常', chatHits.length >= 1);

console.log('\n=== 8. 没有搜索 key 时的行为（v1.21.40 起）===');
// ⚠️ 这一节原来验的是「空 key 会被补成 DEFAULTS 里的预置值」。
// v1.21.40 把那把预置 key 整个删了（写死在包里 = 反编译就能拿走），
// loadSettings 里配套的补值迁移也一并删掉 —— DEFAULTS.searchKey 成了空串，
// 补了还是空，那段代码永远不生效。
// 于是「完全没有 key」这个状态重新变得可达，这里改回验证它本身。
await setSettings({ searchKey: '' });
await pickChar(CID);
{
  const k = await page.evaluate(async () => {
    const o = indexedDB.open('ai-companion');
    const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
    const s = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get('settings'); q.onsuccess = () => r(q.result); });
    db.close();
    return s.v.searchKey;
  });
  t('空 key 保持为空（不再补预置值）', !k, JSON.stringify(String(k).slice(0, 12)));
}
// 没 key 时打 /搜 应该【不发出搜索请求】，而是提示去填 key
await reset();
await say('/搜 今天北京天气');
await syncHits();
t('没 key 时 /搜 不发出搜索请求', searchHits.length === 0, '实际 ' + searchHits.length);

console.log('\n=== 8b. 自己填的 key 不被预置值覆盖 ===');
await setSettings({ searchKey: 'tvly-我自己填的' });
await pickChar(CID);
{
  const k = await page.evaluate(async () => {
    const o = indexedDB.open('ai-companion');
    const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
    const s = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get('settings'); q.onsuccess = () => r(q.result); });
    db.close();
    return s.v.searchKey;
  });
  t('自填 key 保持原样', k === 'tvly-我自己填的', JSON.stringify(k));
}
await setSettings({ searchKey: 'tvly-test' });

console.log('\n=== 9. 搜索失败 → 对话继续 ===');
await setSettings({ searchKey: 'tvly-test' });
await setMode('fail');
await reset();
await say('/搜 今天北京天气');
await syncHits(); t('失败也发了搜索请求', searchHits.length === 1);
t('对话照常进行', chatHits.length >= 1, '失败时应该降级为本地回答');
{
  const injected = chatHits.some(b => (b.messages||[]).some(m => (m.content||'').includes('北京今天晴')));
  t('失败时不注入假资料', !injected);
}
await setMode('ok');

console.log('\n=== 10. 只打 /搜 不给词 ===');
await reset();
await say('/搜');
await syncHits(); t('不给词 → 不发搜索请求', searchHits.length === 0, '实际 ' + searchHits.length);
t('对话照常', chatHits.length >= 1);

console.log('\n=== 11. 空结果 ===');
await setMode('empty');
await reset();
await say('/搜 一个查不到的东西xyz');
await syncHits(); t('发了搜索请求', searchHits.length === 1);
t('空结果不注入', !chatHits.some(b => (b.messages||[]).some(m => (m.content||'').includes('资料开始'))));
t('对话照常', chatHits.length >= 1);
await setMode('ok');

console.log('\n=== 12. 设置页控件 ===');
await openSettings();
{
  const has = await page.evaluate(() => ({
    on: !!document.getElementById('s-search-on'),
    key: !!document.getElementById('s-search-key'),
    state: !!document.getElementById('search-state'),
    test: !!document.getElementById('btn-search-test'),
    count: !!document.getElementById('s-search-count'),
  }));
  t('设置页有开关', has.on);
  t('设置页有 key 输入', has.key);
  t('设置页有状态显示', has.state);
  t('设置页有测试按钮', has.test);
  t('设置页有条数设置', has.count);

  const paint = () => page.evaluate(() => document.getElementById('search-state').textContent.trim());
  const flip = (on) => page.evaluate((v) => {
    const el = document.getElementById('s-search-on');
    el.checked = v; el.dispatchEvent(new Event('change', { bubbles: true }));
  }, on);

  // 1) 先关掉（此时 key 是上一组留下的 tvly-test）→ 未启用
  await flip(false); await sleep(400);
  t('关掉后显示未启用', (await paint()) === '未启用', await paint());

  // 2) 再打开 → 有 key，应该是「就绪」
  await flip(true); await sleep(400);
  t('开+有key → 就绪', (await paint()) === '就绪', await paint());

  // 3) 重载后设置还在（真正验证持久化）
  await page.reload({ waitUntil: 'networkidle0' });
  await sleep(900);
  await openSettings();
  const st = await page.evaluate(() => ({
    on: document.getElementById('s-search-on').checked,
    key: document.getElementById('s-search-key').value,
    state: document.getElementById('search-state').textContent.trim(),
  }));
  t('重载后开关还是开的', st.on === true, JSON.stringify(st));
  t('重载后 key 还在', st.key === 'tvly-test', JSON.stringify(st.key));
  t('重载后状态是就绪', st.state === '就绪', st.state);

  const saved = await page.evaluate(async () => {
    const o = indexedDB.open('ai-companion');
    const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
    const s = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get('settings'); q.onsuccess = () => r(q.result); });
    db.close();
    return s.v;
  });
  t('开关写入 settings', saved.searchOn === true, JSON.stringify(saved.searchOn));
  t('key 写入 settings', saved.searchKey === 'tvly-test');
}

console.log('\n=== 13. 角色编辑页三态 ===');
await page.evaluate(() => {
  document.getElementById('btn-set-back')?.click();
  document.getElementById('btn-drawer-close')?.click();
});
await sleep(500);
await page.evaluate(() => document.getElementById('btn-chars').click());
await sleep(700);
{
  const ids = await page.$$eval('#char-list .char-card', els => els.map(e => e.dataset.id));
  // 编辑入口是卡片里的 [data-edit] 按钮，不是 #btn-edit
  await page.evaluate((id) => {
    const b = document.querySelector('#char-list .char-card[data-id="' + id + '"] [data-edit]');
    if (b) b.click();
  }, 'csrch2');
  await sleep(900);
  const seg = await page.evaluate(() => {
    const el = document.getElementById('e-search');
    if (!el) return null;
    return { v: el.dataset.v, text: el.textContent.replace(/\s+/g,' ').trim(),
             opts: [...el.querySelectorAll('button,div')].map(b=>b.textContent.trim()).filter(Boolean) };
  });
  t('角色页有搜索三态控件', !!seg);
  t('显示当前值 off', seg && seg.v === 'off', JSON.stringify(seg && seg.v));
  t('三个选项都在', seg && seg.text.includes('跟随全局') && seg.text.includes('强制开') && seg.text.includes('强制关'),
    JSON.stringify(seg && seg.text));
}

console.log('\n=== 14. 老角色默认跟随全局 ===');
{
  const pol = await page.evaluate(async () => {
    const o = indexedDB.open('ai-companion');
    const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
    const c = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').get('csrch1'); q.onsuccess = () => r(q.result); });
    db.close();
    return c.searchPolicy;
  });
  t('老角色没有 searchPolicy 字段', pol === undefined, String(pol));
}


console.log('\nJS 错误: ' + (errs.length ? errs.slice(0,3).join(' | ') : '无'));
t('没有 JS 报错', errs.length === 0, errs.slice(0,3).join(' | '));

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
