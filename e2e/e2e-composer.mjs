// e2e-composer.mjs —— 输入框「附加功能」（v0.4.4）
//
// 覆盖：
//   1. 「＋」抽屉：开合、三个功能、选完自动缩回
//   2. 参数槽（输入行上方）与输入行下面的功能 chip
//   3. 发出去之后：落库 tags（不再写 searched）、搜索只此一轮
//   4. 气泡上的 chip 与「附加内容」弹层
//   5. 挂了功能不填参数 → 不触发、不报错
//   6. 手打 /搜（独占一行，正文只剩其他行）
//   7. 手打 /改 = 本轮更改；v0.4.2.2 起它有一轮余温（下一轮还作数一次，之后就没有了）
//   8. 编辑重发把挂着的功能一起还原（原来会丢）
//   9. 重新生成把挂着的功能一起还原（原来会丢，她就不搜了）
//  10. 老消息（只有 searched 字段）照样显示 chip
//  11. 没挂功能的消息没有「附加内容」按钮

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

let searchHits = [], chatHits = [];
await page.evaluateOnNewDocument(() => {
  window.__hits = { search: [], chat: [] };
  const realFetch = window.fetch.bind(window);
  window.fetch = async function (url, opts) {
    const u = String(url);
    let body = {};
    try { body = JSON.parse((opts && opts.body) || '{}'); } catch (e) {}
    if (u.includes('api.tavily.com')) {
      window.__hits.search.push({ url: u, body });
      const results = [
        { title: '北京天气 - 中国天气网', url: 'https://weather.example/bj', content: '北京今天晴，18~26℃，北风 3 级。' },
        { title: '上海天气', url: 'https://weather.example/sh', content: '上海小雨。' },
      ];
      return new Response(JSON.stringify({ answer: '搜索答案。', results }), { status: 200, headers: { 'Content-Type': 'application/json' } });
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

async function syncHits() {
  const h = await page.evaluate(() => ({ search: window.__hits.search, chat: window.__hits.chat }));
  searchHits = h.search; chatHits = h.chat;
}
// v2 起一轮里有多次非流式调用（独白 / 判断 / 评审），它们只带稳定前缀 + 指令，
// 【不带 turnNote】—— 所以"最后一条请求"不再等于"生成请求"。查提示词一律用这个。
const genReqs = () => chatHits.filter(b => b && b.stream !== false);
const lastGen = () => genReqs().slice(-1)[0] || {};

async function clearHits() {
  await page.evaluate(() => { window.__hits.search = []; window.__hits.chat = []; });
  searchHits = []; chatHits = [];
}

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
  id, name, greeting: '（' + name + '）', persona: '你是' + name + '。',
  avatar: null, temperature: 1.0, maxTokens: 2048, topP: 1.0, reasoningEffort: 'low',
  contextRounds: 20, kaomojiFreq: 0, kaomojiStyle: 'jp-soft', emojiFreq: 0,
  verbosity: 'medium', splitMessages: false, typingDelay: 0, hesitation: false,
  showTyping: true, longMemory: false, allowEditMine: false,
  descLevel: 'low', povLock: false, appearance: '', appearanceOn: true,
  presetKey: 'blank', createdAt: Date.now()
}, extra || {});

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

async function say(text) {
  await page.evaluate(t => {
    const el = document.getElementById('input');
    el.value = t; el.dispatchEvent(new Event('input', { bubbles: true }));
  }, text);
  await sleep(120);
  await page.evaluate(() => document.getElementById('btn-send').click());
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
  await sleep(400);
  return started;
}

async function msgsOf(cid) {
  return await page.evaluate(async (id) => {
    const o = indexedDB.open('ai-companion');
    const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
    const all = await new Promise(r => { const q = db.transaction('messages').objectStore('messages').getAll(); q.onsuccess = () => r(q.result); });
    db.close();
    return all.filter(m => m.charId === id).sort((a,b)=>a.ts-b.ts).map(m => ({
      id: m.id, role: m.role, content: m.content, ts: m.ts,
      searched: m.searched || '', tags: m.tags || null,
    }));
  }, cid);
}
const lastUser = async (cid) => (await msgsOf(cid)).filter(m => m.role === 'user').pop();

// —— 小工具 ——
const isHidden = (sel) => page.$eval(sel, el => el.classList.contains('hidden')).catch(() => null);
const textOf = (sel) => page.$eval(sel, el => el.textContent).catch(() => '');
const valOf = (sel) => page.$eval(sel, el => el.value).catch(() => null);
const exists = (sel) => page.$(sel).then(x => !!x).catch(() => false);

const openDrawer = async () => { await page.evaluate(() => document.getElementById('btn-plus').click()); await sleep(250); };
const pickDrawer = async (k) => {
  await page.evaluate(kk => {
    const b = [...document.querySelectorAll('#cmd-drawer .cmd-item')].find(x => x.dataset.cmd === kk);
    if (b) b.click();
  }, k);
  await sleep(300);
};
const fillSlot = async (k, v) => {
  await page.evaluate((kk, vv) => {
    const i = document.querySelector('#cmd-slots [data-cmd="' + kk + '"]');
    if (i) { i.value = vv; i.dispatchEvent(new Event('input', { bubbles: true })); }
  }, k, v);
  await sleep(150);
};
const menuOpen = async (id) => {
  await page.evaluate(mid => {
    const el = [...document.querySelectorAll('#messages .msg')].find(e => e.dataset.id === mid);
    if (el) el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  }, id);
  await sleep(320);
};
const menuClick = async (k) => {
  await page.evaluate(kk => {
    const b = [...document.querySelectorAll('.msg-menu button')].find(x => x.dataset.k === kk);
    if (b) b.click();
  }, k);
  await sleep(400);
  // 有些操作会先弹确认框
  const open = await isHidden('#modal');
  if (open === false) { await page.evaluate(() => document.getElementById('modal-ok').click()); await sleep(400); }
};
const lastBotId = async (cid) => { const ms = await msgsOf(cid); const b = ms.filter(m => m.role !== 'user').pop(); return b ? b.id : null; };

// ================= 开始 =================
await page.goto('http://127.0.0.1:'+port+'/', { waitUntil: 'networkidle0', timeout: 40000 });
await sleep(1200);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil: 'networkidle0' });
await sleep(1000);

const CID = 'ccomp1';
const CID_OLD = 'ccomp2';

await seed({
  chars: [ baseChar(CID, '附加功能'), baseChar(CID_OLD, '老消息') ],
  kv: [ { k: 'settings', v: { apiKey: 'sk-test', searchKey: 'tvly-test', searchOn: true, searchCount: 5,
        baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', clockMode: false } } ],
  msgs: [
    { id: 'oldm1', charId: CID_OLD, role: 'user', content: '老消息问一句', searched: '老关键词', ts: 1000 },
    { id: 'oldm2', charId: CID_OLD, role: 'assistant', content: '老消息答一句', ts: 2000 },
  ],
});

await pickChar(CID);

console.log('');
console.log('=== 1. 「＋」抽屉 ===');
t('一开始抽屉是收着的', (await isHidden('#cmd-drawer')) === true);
await openDrawer();
t('点 ＋ 拉出抽屉', (await isHidden('#cmd-drawer')) === false);
const items = await page.$$eval('#cmd-drawer .cmd-item', e => e.map(x => x.dataset.cmd));
t('抽屉里有四个功能', items.length === 4, JSON.stringify(items));
t('四个是 search / direct / plot / image', items.join(',') === 'search,direct,plot,image', JSON.stringify(items));
const dtext = await textOf('#cmd-drawer');
t('抽屉里写着「联网搜索」', dtext.includes('联网搜索'));
t('抽屉里写着「本轮更改」', dtext.includes('本轮更改'));
t('抽屉里写着「发送图片」', dtext.includes('发送图片'));
t('抽屉里写着「剧情方向」', dtext.includes('剧情方向'));
await page.evaluate(() => document.getElementById('btn-plus').click());
await sleep(200);
t('再点一次 ＋ 缩回', (await isHidden('#cmd-drawer')) === true);

console.log('');
console.log('=== 2. 参数槽与 chip ===');
t('没挂功能时参数槽是藏着的', (await isHidden('#cmd-slots')) === true);
await openDrawer();
await pickDrawer('search');
t('选完功能抽屉自动缩回', (await isHidden('#cmd-drawer')) === true);
t('输入行上方出现参数槽', (await isHidden('#cmd-slots')) === false);
t('参数槽里是「联网搜索」那一行', (await textOf('#cmd-slots')).includes('联网搜索'));
t('槽里有它自己的输入框', await exists('#cmd-slots [data-cmd="search"]'));
t('输入行下面挂上 chip', (await textOf('#input-tags')).includes('联网搜索'));
await fillSlot('search', '今天北京天气');
t('填了参数，chip 带上内容', (await textOf('#input-tags')).includes('今天北京天气'));
await openDrawer();
await pickDrawer('direct');
t('再挂第二个功能，两行都在', (await page.$$eval('#cmd-slots .cmd-slot', e => e.length)) === 2);
t('第二个功能是「本轮更改」', (await textOf('#cmd-slots')).includes('本轮更改'));
await page.evaluate(() => { const b = document.querySelector('#cmd-slots [data-del="direct"]'); if (b) b.click(); });
await sleep(250);
t('点 ✕ 去掉「本轮更改」', (await page.$$eval('#cmd-slots .cmd-slot', e => e.length)) === 1);
t('chip 也只剩一个', (await page.$$eval('#input-tags .tag-chip', e => e.length)) === 1);

console.log('');
console.log('=== 3. 发出去：落库与注入 ===');
await clearHits();
await say('帮我看看');
await syncHits();
t('搜索请求发了 1 次', searchHits.length === 1, '实际 ' + searchHits.length);
t('搜索词就是槽里填的', searchHits[0] && searchHits[0].body.query === '今天北京天气', searchHits[0] ? String(searchHits[0].body.query) : '(无)');
t('搜索结果进了这一轮提示词', chatHits.some(b => (b.messages||[]).some(m => (m.content||'').includes('北京今天晴'))));
{
  const u = await lastUser(CID);
  t('正文只有他写的那句', u && u.content === '帮我看看', JSON.stringify(u && u.content));
  t('落库的是 tags', u && Array.isArray(u.tags) && u.tags[0].k === 'search', JSON.stringify(u && u.tags));
  t('tags 里存着搜索词', u && u.tags[0].arg === '今天北京天气', JSON.stringify(u && u.tags));
  t('不再写 searched 字段', u && u.searched === '', JSON.stringify(u && u.searched));
  t('正文里没有命令串', u && !u.content.includes('/搜'));
}
t('发完之后参数槽收起来了', (await isHidden('#cmd-slots')) === true);
t('发完之后 chip 也清了', (await textOf('#input-tags')).trim() === '');

console.log('');
console.log('=== 4. 气泡上的 chip 与「附加内容」 ===');
{
  const chip = await textOf('#messages .msg.me .tag-chip');
  t('气泡上有搜索 chip', chip.includes('联网搜索'), JSON.stringify(chip));
  const btn = await exists('#messages .msg.me .more-btn');
  t('气泡上有「附加内容」按钮', btn);
  if (btn) {
    await page.evaluate(() => document.querySelector('#messages .msg.me .more-btn').click());
    await sleep(400);
    t('弹层打开了', (await isHidden('#modal')) === false);
    t('标题是「这一轮的附加内容」', (await textOf('#modal-title')).includes('附加内容'), await textOf('#modal-title'));
    t('弹层里写着他填的内容', (await textOf('#modal-text')).includes('今天北京天气'), await textOf('#modal-text'));
    t('只读弹层里没有「取消」', (await isHidden('#modal-cancel')) === true);
    await page.evaluate(() => document.getElementById('modal-ok').click());
    await sleep(350);
    t('点「知道了」关掉弹层', (await isHidden('#modal')) === true);
    t('关掉之后「取消」回来了', (await isHidden('#modal-cancel')) === false);
  }
  const plain = await exists('#messages .msg:not(.me) .more-btn');
  t('她那条没挂功能，没有按钮', !plain);
}

console.log('');
console.log('=== 5. 挂了功能不填参数 ===');
await clearHits();
await openDrawer();
await pickDrawer('search');
await say('不填参数的一句');
await syncHits();
t('空的搜索词不发搜索请求', searchHits.length === 0, '实际 ' + searchHits.length);
t('消息照常发出去', chatHits.length >= 1);
{
  const u = await lastUser(CID);
  t('这条也记了 tags（只是没内容）', u && Array.isArray(u.tags) && u.tags[0].k === 'search');
  t('参数是空串', u && u.tags[0].arg === '', JSON.stringify(u && u.tags));
}

console.log('');
console.log('=== 6. 手打 /搜（独占一行）===');
await clearHits();
await say('/搜 上海天气\n顺便说一句');
await syncHits();
t('手打的 /搜 也走搜索', searchHits.length === 1, '实际 ' + searchHits.length);
t('搜索词取的是那一行剩下的', searchHits[0] && searchHits[0].body.query === '上海天气', searchHits[0] ? String(searchHits[0].body.query) : '(无)');
{
  const u = await lastUser(CID);
  t('正文只剩别的行', u && u.content === '顺便说一句', JSON.stringify(u && u.content));
  t('tags 是 search', u && u.tags && u.tags[0].k === 'search');
  t('tags 里是搜索词', u && u.tags[0].arg === '上海天气');
}

console.log('');
console.log('=== 7. /改 = 本轮更改，只这一轮 ===');
await clearHits();
await say('/改 用可爱向的写法\n你今天怎么样');
await syncHits();
{
  const blob = JSON.stringify(lastGen());
  t('「本轮更改」的内容进了这一轮提示词', blob.includes('用可爱向的写法'), '生成请求 ' + genReqs().length + ' 次');
  t('提示词里有「这一轮的额外要求」那一节', blob.includes('这一轮的额外要求'));
  const u = await lastUser(CID);
  t('正文只剩正文', u && u.content === '你今天怎么样', JSON.stringify(u && u.content));
  t('tags 是 direct', u && u.tags && u.tags[0].k === 'direct');
}
await clearHits();
await say('继续');
await syncHits();
{
  const blob = JSON.stringify(lastGen());
  // ⚠️ v0.4.2.2 起「本轮更改」有【一轮余温】：下一轮还会再作数一次，但换成了
  //    「上一轮的要求（还没过去）」那一节，并且明写它正在淡出。
  //    这里原来断言的是「下一轮完全不带」—— 那是 v0.4.4 的行为，已经过时。
  t('下一轮带一轮余温', blob.includes('上一轮的要求（还没过去）') && blob.includes('用可爱向的写法'));
  t('下一轮不再是「这一轮的额外要求」', !blob.includes('这一轮的额外要求'));
  const u = await lastUser(CID);
  t('下一轮没有 tags', u && !u.tags, JSON.stringify(u && u.tags));
}
await clearHits();
await say('再继续');
await syncHits();
t('再下一轮余温就没了', !JSON.stringify(lastGen()).includes('用可爱向的写法'));

console.log('');
console.log('=== 8. 编辑重发要还原挂着的功能 ===');
await openDrawer();
await pickDrawer('search');
await fillSlot('search', '重发用的词');
await clearHits();
await say('这条要重发');
await syncHits();
t('先确认这一条搜了', searchHits.length === 1, '实际 ' + searchHits.length);
{
  const u = await lastUser(CID);
  await menuOpen(u.id);
  await menuClick('edit');
  t('编辑重发后正文回到输入框', (await valOf('#input')) === '这条要重发', String(await valOf('#input')));
  t('参数槽又出现了', (await isHidden('#cmd-slots')) === false);
  t('槽里是原来填的词', (await valOf('#cmd-slots [data-cmd="search"]')) === '重发用的词', String(await valOf('#cmd-slots [data-cmd="search"]')));
  t('输入行下面 chip 也回来了', (await textOf('#input-tags')).includes('重发用的词'));
}
// 收尾：把输入框清空，免得影响后面
await page.evaluate(() => { const el = document.getElementById('input'); el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); });
await page.evaluate(() => { const b = document.querySelector('#cmd-slots [data-del="search"]'); if (b) b.click(); });
await sleep(200);

console.log('');
console.log('=== 9. 重新生成要还原挂着的功能 ===');
await openDrawer();
await pickDrawer('search');
await fillSlot('search', '再搜一次的词');
await clearHits();
await say('这条要重新生成');
await syncHits();
t('第一次搜索发了 1 次', searchHits.length === 1, '实际 ' + searchHits.length);
const bid = await lastBotId(CID);
await clearHits();
await menuOpen(bid);
await menuClick('regen');
await sleep(1500);
await syncHits();
t('重新生成会重新搜一次', searchHits.length >= 1, '实际 ' + searchHits.length);
{
  const u = await lastUser(CID);
  t('重新生成后 tags 还在', u && Array.isArray(u.tags) && u.tags[0].k === 'search', JSON.stringify(u && u.tags));
  t('重新生成后搜索词还在', u && u.tags && u.tags[0].arg === '再搜一次的词', JSON.stringify(u && u.tags));
}
await page.evaluate(() => { const el = document.getElementById('input'); el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); });
await page.evaluate(() => { const b = document.querySelector('#cmd-slots [data-del="search"]'); if (b) b.click(); });
await sleep(200);

console.log('');
console.log('=== 10. 老消息（只有 searched 字段）===');
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil: 'networkidle0' });
await sleep(900);
await seed({
  chars: [ baseChar(CID_OLD, '老消息') ],
  kv: [ { k: 'settings', v: { apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', clockMode: false } } ],
  msgs: [
    { id: 'oldm1', charId: CID_OLD, role: 'user', content: '老消息问一句', searched: '老关键词', ts: 1000 },
    { id: 'oldm2', charId: CID_OLD, role: 'assistant', content: '老消息答一句', ts: 2000 },
  ],
});
await pickChar(CID_OLD);
{
  const chip = await textOf('#messages .msg.me .tag-chip');
  t('老消息照样显示 chip', chip.includes('联网搜索'), JSON.stringify(chip));
  t('老消息也带出老关键词', (await page.$eval('#messages .msg.me .tag-chip', el => el.getAttribute('title') || '')).includes('老关键词'), await page.$eval('#messages .msg.me .tag-chip', el => el.getAttribute('title') || ''));
  const btn = await exists('#messages .msg.me .more-btn');
  t('老消息也有「附加内容」按钮', btn);
  if (btn) {
    await page.evaluate(() => document.querySelector('#messages .msg.me .more-btn').click());
    await sleep(400);
    t('弹层里是老的搜索词', (await textOf('#modal-text')).includes('老关键词'), await textOf('#modal-text'));
    await page.evaluate(() => document.getElementById('modal-ok').click());
    await sleep(300);
  }
}

console.log('');
console.log('=== 12. 长参数不许把输入区撑破（用户截图上的 bug）===');
// 截图实证的三个挤爆点，根因都是 flex 子项不肯收缩：
//   ① 余温条的 ✕ 被 overflow 切到可视区外（量到 ✕ left=548 / 胶囊 right=400）——用户根本点不到它
//   ② 「已写 N 字」被压成 19px 宽、71px 高的一竖排
//   ③ 功能 chip 左端跑出屏幕 108px
// 这一节把它们钉在 393px 与 320px 两种屏宽上。
const LONG_ARG = '（她自己可以继续转化直到完全变成鬼，但她不准备继续，目前这样够她玩弄了）';
const LONG_TEXT = '感知到对方位置。高烧退了，人还是半快的在她怀里）';
const typeInto = (t2) => page.evaluate(v => {
  const el = document.getElementById('input');
  el.value = v; el.dispatchEvent(new Event('input', { bubbles: true }));
}, t2);

// 字数只在「回车换行」时出现（设置页写死了这句话），所以先把它切成 false
await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const get = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get('settings'); q.onsuccess = () => r(q.result); });
  const rec = get || { k: 'settings', v: {} };
  rec.v = Object.assign({}, rec.v, { enterSend: false });
  await new Promise(r => { const tx = db.transaction('kv','readwrite'); tx.objectStore('kv').put(rec); tx.oncomplete = r; });
  db.close();
});
await pickChar(CID);
await openDrawer(); await pickDrawer('direct'); await fillSlot('direct', LONG_ARG);   // 余温正文也必须是长的那条（截图里就是它）
await say('布局用第一句');            // 发完 → carryOver 有值 → 余温条出现
await sleep(350);
await openDrawer(); await pickDrawer('direct'); await fillSlot('direct', LONG_ARG);   // 再挂一个长参数 → 参数槽 + chip
await typeInto(LONG_TEXT);            // 输入框里又写着长正文 → 字数
await sleep(350);

const probe = () => page.evaluate(() => {
  const chip = document.querySelector('.carry-chip'), x = document.querySelector('.carry-chip .x');
  const cl = document.querySelector('.carry-chip .cl'), bb = document.querySelector('.carry-chip b');
  const cnt = document.querySelector('#input-count'), tags = document.querySelector('#input-tags');
  if (!chip || !x || !cl || !bb || !cnt || !tags) return { missing: true };
  const cr = chip.getBoundingClientRect(), xr = x.getBoundingClientRect();
  const nr = cnt.getBoundingClientRect(), tr = tags.getBoundingClientRect();
  const ci = document.querySelector('#cmd-slots [data-cmd]');
  return {
    xInside: xr.right <= cr.right + 0.5 && xr.left >= cr.left - 0.5,
    bEllipsis: bb.scrollWidth > bb.clientWidth,
    clFull: cl.scrollWidth <= cl.clientWidth + 1,
    countOneLine: nr.height < 26 && nr.width > 40,
    tagsInside: tr.left >= -0.5,
    noOverlap: tr.right <= nr.left + 0.5,
    slotOk: !!ci && ci.getBoundingClientRect().width > 40,
    // 参数槽（用户 2026-10-16 的反馈）：长参数必须自己换行、全文可见可改，
    // 不许像以前那样一路往右延伸（屏幕上只剩开头，后半截看不见也改不了）。
    slotNoHScroll: !!ci && ci.scrollWidth <= ci.clientWidth + 1,
    slotWrapped: !!ci && ci.getBoundingClientRect().height > 44,
    slotFullText: !!ci && ci.value === '（她自己可以继续转化直到完全变成鬼，但她不准备继续，目前这样够她玩弄了）',
    slotTag: ci ? ci.tagName : '',
    vw: document.documentElement.clientWidth,
  };
});

t('三者同时在场：余温条 + 长功能 chip + 长正文的字数', (await probe()).missing !== true, JSON.stringify(await probe()));
for (const W of [393, 320]) {
  await page.setViewport({ width: W, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await sleep(350);
  const box = await page.evaluate(() => { const c = document.querySelector('.composer'); const r = c.getBoundingClientRect(); return { x: 0, y: Math.max(0, r.top), width: document.documentElement.clientWidth, height: r.height }; });
  await page.screenshot({ path: R + '/tmp/composer-fixed-' + W + '.png', clip: box });
  const m = await probe();
  t(W + 'px：余温条的 ✕ 在可视区内（以前被切掉）', m.xInside === true, JSON.stringify(m));
  t(W + 'px：余温正文出省略号，不是硬裁', m.bEllipsis === true, JSON.stringify(m));
  t(W + 'px：前缀「上一轮的要求还在延续：」完整可读', m.clFull === true, JSON.stringify(m));
  t(W + 'px：字数是一行，没被压成竖排', m.countOneLine === true, JSON.stringify(m));
  t(W + 'px：功能 chip 没跑出屏幕左边', m.tagsInside === true, JSON.stringify(m));
  t(W + 'px：chip 与字数不重叠', m.noOverlap === true, JSON.stringify(m));
  t(W + 'px：参数槽的输入框还有正经宽度', m.slotOk === true, JSON.stringify(m));
  t(W + 'px：★ 参数槽里的长参数换行了、没有横向延伸', m.slotNoHScroll === true && m.slotWrapped === true, JSON.stringify(m));
  t(W + 'px：★ 长参数全文都在槽里（读得完、改得了）', m.slotFullText === true, JSON.stringify(m));
}
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await sleep(200);

console.log('');
console.log('');
console.log('=== 参数槽的高度上限跟设置里的「输入框行数」走 ===');

// 用户 2026-10-16：不要把上限写死在代码里，用设置里那个档位（写字台 → 输入框行数）。
// 做法就是改库里的 settings.inputMaxH + reload，再挂同一条长参数，看槽长多高。
const setRows = async (n) => {
  await page.evaluate(async (nn) => {
    const o = indexedDB.open('ai-companion');
    const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
    const get = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get('settings'); q.onsuccess = () => r(q.result); });
    const rec = get || { k: 'settings', v: {} };
    rec.v = Object.assign({}, rec.v, { inputMaxH: nn });
    await new Promise(r => { const tx = db.transaction('kv','readwrite'); tx.objectStore('kv').put(rec); tx.oncomplete = r; });
    db.close();
  }, n);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(700);
};
const slotAt = async (n) => {
  await setRows(n);
  await pickChar(CID);
  await sleep(300);
  await openDrawer(); await pickDrawer('direct'); await fillSlot('direct', LONG_ARG);
  await sleep(250);
  return page.evaluate(() => {
    const el = document.querySelector('#cmd-slots [data-cmd]');
    return el ? { h: Math.round(el.getBoundingClientRect().height), scroll: el.scrollHeight } : null;
  });
};
const s1 = await slotAt(1);       // 1 行档
const s8 = await slotAt(8);       // 8 行档
t('参数槽高度吃设置：1 行档明显比 8 行档矮', !!s1 && !!s8 && s8.h > s1.h + 20, JSON.stringify({ s1, s8 }));
t('8 行档装得下整条长参数，不用滚动', !!s8 && s8.h >= s8.scroll - 2, JSON.stringify(s8));
t('1 行档顶到上限，就在框里滚', !!s1 && s1.scroll > s1.h, JSON.stringify(s1));
await setRows(3);                 // 收尾：改回默认 3 行，后面的小节照旧
await pickChar(CID);
await sleep(250);

console.log('');
console.log('=== 审计 F12/F16/F18：抽屉会自己收、长按不打架、标签不说谎 ===');

// —— F18：「＋」抽屉不能只认加号自己 ——
await openDrawer();
t('加号能把抽屉展开', (await isHidden('#cmd-drawer')) === false);
await page.evaluate(() => document.getElementById('input').click());
await sleep(280);
t('★ 点输入框，抽屉自己收起来（F18）', (await isHidden('#cmd-drawer')) === true);
await openDrawer();
await page.evaluate(() => document.getElementById('messages').click());
await sleep(280);
t('★ 点聊天区，抽屉自己收起来（F18）', (await isHidden('#cmd-drawer')) === true);

// —— F16：长按「附加内容」不该把长按菜单也叫出来 ——
// 用一个本节自己建的角色：前面几节可能删过角色，借别人的 id 会读到空库
await seed({ chars: [baseChar('cf16', 'F16角色')] });
await pickChar('cf16');
await openDrawer(); await pickDrawer('direct'); await fillSlot('direct', '看看这句');
await say('这一轮带着附加内容'); await sleep(700);
const tagged = await lastUser('cf16');
t('这条消息带上了标签（所以有「附加内容」按钮）', !!(tagged && tagged.tags && tagged.tags.length));
const pressed = await page.evaluate((mid) => {
  const el = [...document.querySelectorAll('#messages .msg')].find(e => e.dataset.id === mid);
  const b = el && el.querySelector('.more-btn');
  if (!b) return 'no-btn';
  const r = b.getBoundingClientRect();
  const mk = () => new Touch({ identifier: 7, target: b, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 });
  b.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true,
    touches: [mk()], targetTouches: [mk()], changedTouches: [mk()] }));
  return 'ok';
}, tagged.id);
t('「附加内容」按钮在', pressed === 'ok', pressed);
await sleep(900);
const menus = await page.$$eval('.msg-menu', els => els.length).catch(() => 0);
t('★ 按住它 900ms 不再弹出长按菜单（F16）', menus === 0, '弹出了 ' + menus + ' 个');
await page.evaluate((mid) => {
  const el = [...document.querySelectorAll('#messages .msg')].find(e => e.dataset.id === mid);
  const b = el && el.querySelector('.more-btn');
  if (b) { b.dispatchEvent(new TouchEvent('touchend', { bubbles: true })); b.click(); }
}, tagged.id);
await sleep(500);
t('★ 松手后只弹「附加内容」这一个窗（F16）', (await isHidden('#modal')) === false);
await page.evaluate(() => document.getElementById('modal-ok').click());
await sleep(300);

// —— F12：没搜成，标签要说实话 ——
await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const rec = await new Promise(r => { const q = db.transaction('kv','readonly').objectStore('kv').get('settings'); q.onsuccess = () => r(q.result); });
  rec.v.searchOn = false;   // 关掉联网搜索 → 这一轮必然搜不成
  await new Promise(r => { const tx = db.transaction('kv','readwrite'); tx.objectStore('kv').put(rec); tx.oncomplete = r; });
  db.close();
  location.reload();
});
await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30000 }).catch(() => {});
await sleep(1100);
await openDrawer(); await pickDrawer('search'); await fillSlot('search', '今天北京天气');
await say('搜一下再回答'); await sleep(700);
const su = await lastUser('cf16');
const sk = su && su.tags ? su.tags.find(x => x.k === 'search') : null;
t('这条消息确实带了「联网搜索」标签', !!sk, JSON.stringify(su && su.tags));
t('★ 没搜成时标签被标成 skipped（F12）', !!(sk && sk.skipped === true), JSON.stringify(sk));
await page.evaluate((mid) => {
  const el = [...document.querySelectorAll('#messages .msg')].find(e => e.dataset.id === mid);
  const b = el && el.querySelector('.more-btn');
  if (b) b.click();
}, su.id);
await sleep(500);
const ttxt = await textOf('#modal-text');
t('★ 「附加内容」里照实写「没搜成」（F12）', ttxt.includes('没搜成'), ttxt.slice(0, 90));
await page.evaluate(() => document.getElementById('modal-ok').click());
await sleep(300);

console.log('');
console.log('=== 剧情方向（v0.4.3.2）：挂得上、带得走、留得住 ===');
await openDrawer();
await pickDrawer('plot');
t('参数槽里出现「剧情方向」那一行', (await textOf('#cmd-slots')).includes('剧情方向'));
await fillSlot('plot', '她开始起疑心，气氛往下沉');
const chipTxt = await textOf('#input-tags');
t('★ 输入行上方的 chip 写着「剧情方向」', chipTxt.includes('剧情方向'), chipTxt);
await say('顺着刚才那句往下演'); await sleep(700);
const pu = await lastUser('cf16');
const pk = pu && pu.tags ? pu.tags.find(x => x.k === 'plot') : null;
t('★ 消息带上了「剧情方向」标签', !!pk, JSON.stringify(pu && pu.tags));
t('★ 标签里存着这一轮写的方向', (pk && pk.arg) === '她开始起疑心，气氛往下沉', JSON.stringify(pk));
t('参数槽用完就清空了', (await isHidden('#cmd-slots')) === true);
await page.evaluate((mid) => {
  const el = [...document.querySelectorAll('#messages .msg')].find(e => e.dataset.id === mid);
  const b = el && el.querySelector('.more-btn');
  if (b) b.click();
}, pu.id);
await sleep(500);
const ptxt = await textOf('#modal-text');
t('★ 「附加内容」里能回看这一轮的方向', ptxt.includes('剧情方向') && ptxt.includes('起疑心'), ptxt.slice(0, 90));
await page.evaluate(() => document.getElementById('modal-ok').click());
await sleep(300);
// 手打 /向 也认（命令必须独占一行）
await page.evaluate(() => { document.getElementById('input').value = ''; });
await say('/向 往告白的方向走'); await sleep(700);
const hu = await lastUser('cf16');
const hk = hu && hu.tags ? hu.tags.find(x => x.k === 'plot') : null;
t('★ 手打 /向 也认，且不进正文', !!(hk && hk.arg === '往告白的方向走') && !(hu.content || '').includes('/向'), JSON.stringify(hk) + ' | ' + (hu.content || '').slice(0, 40));

t('全程没有页面报错', errs.length === 0, errs.slice(0,3).join(' | '));

console.log('');
console.log('附加功能：通过 ' + pass + ' 项 / 失败 ' + fail + ' 项');
await browser.close();
server.close();
process.exit(fail ? 1 : 0);
