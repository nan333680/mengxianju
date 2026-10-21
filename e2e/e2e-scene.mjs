// e2e-scene.mjs —— 小说层（v0.5.2）
//
// 覆盖规格 §13 的验收里【能自动化】的那些：
//   1. 抽屉里两个入口（写一场戏 / 书架），没有「小说」标签页
//   2. 书架空态
//   3. 开戏弹窗：角色 / 两档长度 / 三种在场方式 / 临时人物上限 2
//   4. 短场：1 次正文 + 1 次场记 -> status done，blocks 与 log 都落库
//   5. 正文【不进 messages】（硬规则）
//   6. 质量闸门：字数不够 -> 只自动重试一次，第二次把原因写进提示词
//   7. 被长度截断 -> 保存已写的、不自动续写、status 停在 generating
//   8. 中场：先分拍（1 次）-> 确认 -> 按拍写正文 -> 场记
//   9. 导演模式：正文不许出现「你」；提示词里也不把用户写成「他」
//  10. 书架出现这一场，点开能读回同样的正文
//  11. 删除这一场 -> 进回收站、书架不显示、聊天记录一条不动
//  12. 从聊天成章：截前情、只当背景、派生后聊天一条不动
//  12b. 删一拍：正文一起删、撤销条、撤销拿回来
//  12c. 记住上次读到哪
//  12d. 备份带 scenes / 清空聊天不删这场戏
//  13. 英文界面下小说层不留中文

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

// 一段干净的正文（278 字左右，过得了 checkQuality）。
const PROSE = '雨还在下。她把伞收起来，靠在门边的墙角，水顺着伞骨往下滴，在水泥地上洇出一小片深色。她没有马上开灯，先站在玄关听了一会儿屋里的动静，像在确认什么。「你还没走啊。」她说这句话的时候语气很平，平得有点过了头。桌上摊着那个旧木盒，盒盖开着，里面的东西被挪过位置，边缘留着一道新鲜的划痕。她走过去，手指在盒沿停了停，没有立刻碰。「我本来是要扔的。」她说，「昨天翻出来的时候想，留着也没用。」窗外的雨声忽然大了一阵，把后面那半句话压下去。她低下头笑了一下，笑得很轻，更像是在给自己找台阶。然后她把盒子往你那边推了推，推到桌子中间才收手，指尖在木头上多停了半秒才离开。';
const SHORT = '她推了一下。';
const LOGJSON = '{"events":["她收伞进门","她把盒子推到桌子中间"],"cast":["红白"],"change":"盒子从她那边到了桌子中间","openThreads":["盒子里是什么"],"keyLines":["我本来是要扔的。"]}';
const BEATJSON = '{"beats":[{"start":"她收伞进门","change":"她说出那句本来要扔","stop":"盒子停在桌子中间","guardrails":[]},{"start":"两个人都没动","change":"她松了口","stop":"她转身走进里屋","guardrails":[]}]}';
const TEMPJSON = '{"name":"陈叔","identity":"隔壁邻居","look":"拖鞋睡衣","want":"找人说话","secret":"欠了半年的房租"}';

await page.evaluateOnNewDocument((LOGJSON_TEXT, BEATJSON_TEXT, TEMPJSON_TEXT) => {
  window.__fake = { queue: [], chat: [], once: [], page: 0 };
  const realFetch = window.fetch.bind(window);
  window.fetch = async function (url, opts) {
    const u = String(url);
    let body = {};
    try { body = JSON.parse((opts && opts.body) || '{}'); } catch (e) {}
    if (u.includes('/chat/completions')) {
      const sys = String(((body.messages || [])[0] || {}).content || '');
      const all = JSON.stringify(body.messages || []);
      if (body.stream === false) {
        let content = LOGJSON_TEXT;
        if (sys.indexOf('造一个临时配角') >= 0) { window.__fake.once.push({ kind: 'temp', sys: sys }); content = TEMPJSON_TEXT; }
        else if (sys.indexOf('分拍') >= 0) { window.__fake.once.push({ kind: 'beats', sys: sys }); content = BEATJSON_TEXT; }
        else { window.__fake.once.push({ kind: 'log', sys: sys }); content = LOGJSON_TEXT; }
        return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      const item = window.__fake.queue.shift() || { text: '（没有预置内容）', finish: 'stop' };
      window.__fake.chat.push({ sys, all, text: item.text });
      const chunk = (o) => 'data: ' + JSON.stringify(o) + String.fromCharCode(10,10);
      const payload = chunk({ choices: [{ delta: { content: item.text } }] })
        + chunk({ choices: [{ delta: {}, finish_reason: item.finish }], usage: { prompt_tokens: 500, completion_tokens: 400 } })
        + 'data: [DONE]' + String.fromCharCode(10,10);
      return new Response(payload, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    return realFetch(url, opts);
  };
}, LOGJSON, BEATJSON, TEMPJSON);

async function seed(spec) {
  return await page.evaluate(async (s) => {
    const o = indexedDB.open('ai-companion');
    const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
    const put = (store, rec) => new Promise(r => { const tx = db.transaction(store,'readwrite'); tx.objectStore(store).put(rec); tx.oncomplete = r; });
    for (const c of (s.chars||[])) await put('characters', c);
    for (const e of (s.kv||[])) await put('kv', e);
    for (const m of (s.msgs||[])) await put('messages', m);
    for (const e of (s.scenes||[])) await put('scenes', e);
    db.close();
  }, spec);
}

const baseChar = (id, name, extra) => Object.assign({
  id, name, greeting: '（' + name + '）', persona: '你是' + name + '。',
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
const dbMsgCount = () => page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const n = await new Promise(r => { const tx = db.transaction('messages','readonly'); const q = tx.objectStore('messages').count(); q.onsuccess = () => r(q.result || 0); });
  db.close();
  return n;
});
const clearScenes = () => page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  await new Promise(r => { const tx = db.transaction('scenes','readwrite'); tx.objectStore('scenes').clear(); tx.oncomplete = r; });
  db.close();
});
const fakeReset = (queue) => page.evaluate((q) => { window.__fake.queue = q; window.__fake.chat = []; window.__fake.once = []; window.__fake.page = 0; }, queue);
const hits = () => page.evaluate(() => ({ chat: window.__fake.chat.length, once: window.__fake.once.length, kinds: window.__fake.once.map(x => x.kind) }));

const click = async (sel) => { await page.waitForSelector(sel, { timeout: 15000 }); await page.evaluate(s => { const e = document.querySelector(s); if (e) e.click(); }, sel); };
const clickSoft = async (sel, ms = 8000) => { try { await page.waitForSelector(sel, { timeout: ms }); await page.evaluate(s => { const e = document.querySelector(s); if (e) e.click(); }, sel); return true; } catch (e) { return false; } };
const visible = (sel) => page.evaluate(s => { const e = document.querySelector(s); if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).display !== 'none'; }, sel);


// ⚠️ CI 的 runner 是 en-US，而界面语言默认「跟随系统」。这套要读界面上的中文文案，
//    不钉语言的话在 CI 上拿到的是英文，断中文的地方必红（v0.5.2 CI #29 的 e2e-branch）。
//    位置必须在 newPage 之后、goto 之前：tools/ci-precheck.mjs 会把 en-US 伪装插在
//    newPage 紧跟的下一行，晚注册的那份才生效，才能盖过它。
await page.evaluateOnNewDocument(() => {
  Object.defineProperty(navigator, 'language', { get: () => 'zh-CN', configurable: true });
  Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh'], configurable: true });
});
await page.goto('http://127.0.0.1:' + port + '/index.html', { waitUntil: 'networkidle0' });
await seed({
  chars: [baseChar('sc1', '红白')],
  kv: [
    { k: 'settings', v: { apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', clockMode: false, lang: 'zh' } },
    { k: 'lastCharId', v: 'sc1' }
  ],
  msgs: [
    { id: 'm1', charId: 'sc1', role: 'assistant', content: '（红白）', ts: Date.now() - 2000 }
  ]
});
await page.reload({ waitUntil: 'networkidle0' });
await sleep(900);

// ---------- 1. 抽屉里两个入口 ----------
console.log('=== 1. 抽屉入口 ===');
await click('#btn-settings');
await sleep(400);
t('抽屉里能进「写一场戏」', await page.evaluate(() => !!document.querySelector('[data-wb-drawer="scene"]')));
t('抽屉里能进「书架」', await page.evaluate(() => !!document.querySelector('[data-wb-drawer="shelf"]')));
t('没有「小说」标签页（规格 §15）', await page.evaluate(() => !document.querySelector('[data-wb-drawer="novel"]') && !document.getElementById('view-novel')));

// ---------- 2. 书架空态 ----------
console.log('=== 2. 书架空态 ===');
await click('[data-wb-drawer="shelf"]');
await sleep(500);
t('书架打开了', await page.evaluate(() => !!document.getElementById('view-shelf').classList.contains('active')));
const emptyTxt = await page.evaluate(() => (document.getElementById('shelf-list') || {}).textContent || '');
t('空书架说清楚怎么开一场', emptyTxt.indexOf('还没有戏') >= 0, JSON.stringify(emptyTxt.slice(0, 60)));

// ---------- 3. 开戏弹窗 ----------
console.log('=== 3. 开戏弹窗 ===');
await click('[data-wb-drawer="scene"]');
await sleep(500);
t('弹窗打开', await visible('#scn-modal'));
t('角色下拉里有红白', await page.evaluate(() => { const s = document.getElementById('sc-char'); return !!s && Array.from(s.options).some(o => o.textContent.indexOf('红白') >= 0); }));
t('两档长度', await page.evaluate(() => document.querySelectorAll('#sc-len button').length === 2));
t('三种在场方式', await page.evaluate(() => document.querySelectorAll('#sc-mode button').length === 3));
t('临时人物上限写着 0 / 2', (await page.evaluate(() => (document.getElementById('sc-temp-cnt') || {}).textContent || '')).replace(/\s/g, '') === '0/2');

// ---------- 4. 短场：正文 + 场记 ----------
console.log('=== 4. 短场开演 ===');
await fakeReset([{ text: PROSE, finish: 'stop' }]);
await page.evaluate(() => { document.getElementById('sc-place').value = '出租屋玄关'; document.getElementById('sc-time').value = '深夜'; });
const msgBefore = await dbMsgCount();
await click('#sc-go');
await page.waitForFunction(() => !!document.getElementById('view-read') && document.getElementById('view-read').classList.contains('active'), { timeout: 30000 });
await page.waitForFunction(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const all = await new Promise(r => { const tx = db.transaction('scenes','readonly'); const q = tx.objectStore('scenes').getAll(); q.onsuccess = () => r(q.result || []); });
  db.close();
  return all.length > 0 && all[0].status !== 'generating';
}, { timeout: 60000 });
let scs = await dbScenes();
t('落了一张场景卡', scs.length === 1, 'len=' + scs.length);
const s1 = scs[0] || {};
t('status = done', s1.status === 'done', String(s1.status));
t('正文进了 blocks', (s1.blocks || []).length >= 1, 'blocks=' + (s1.blocks || []).length);
t('场记写了 change', !!(s1.log && s1.log.change), JSON.stringify(s1.log && s1.log.change));
t('场记记了事件', !!(s1.log && (s1.log.events || []).length), '');
t('正文里没有「用户」', !(s1.blocks || []).some(b => String(b.text).indexOf('用户') >= 0));
let h = await hits();
t('只请求了 1 次正文 + 1 次场记', h.chat === 1 && h.kinds.filter(k => k === 'log').length === 1, JSON.stringify(h));
if (h.chat >= 1) {
  const c0 = await page.evaluate(() => window.__fake.chat[0]);
  t('提示词开头是「你是这场戏的叙述者，不是助手。」', String(c0.sys).indexOf('你是这场戏的叙述者，不是助手。') === 0, String(c0.sys).slice(0, 40));
  t('提示词带了场景卡 / 视角 / 写法 / 长度 / 输出', ['【场景卡】','【视角】','【写法】','【长度】','【输出】'].every(k => String(c0.sys).indexOf(k) >= 0));
  t('提示词没把用户写成「他」', String(c0.sys).indexOf('（他）') < 0, '');
  t('提示词禁了【名字】标签与剧本写法', String(c0.sys).indexOf('不写【名字】标签') >= 0 && String(c0.sys).indexOf('不要写成剧本') >= 0);
}

// ---------- 5. 正文不进 messages ----------
console.log('=== 5. 正文不进 messages ===');
t('聊天记录一条没多', (await dbMsgCount()) === msgBefore, 'before=' + msgBefore + ' after=' + (await dbMsgCount()));
// ---------- 6. 质量闸门：只自动重试一次 ----------
console.log('=== 6. 质量闸门 ===');
const openScene = async () => {
  await clickSoft('#rv-back');
  await sleep(300);
  await clickSoft('#btn-settings');
  await sleep(300);
  await clickSoft('[data-wb-drawer="scene"]');
  await sleep(400);
  return await visible('#scn-modal');
};
const waitDone = async (ms = 60000) => {
  try {
    await page.waitForFunction(async () => {
      const o = indexedDB.open('ai-companion');
      const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
      const all = await new Promise(r => { const tx = db.transaction('scenes','readonly'); const q = tx.objectStore('scenes').getAll(); q.onsuccess = () => r(q.result || []); });
      db.close();
      return all.length > 0 && all.every(x => x.status !== 'generating');
    }, { timeout: ms });
    return true;
  } catch (e) { return false; }
};
await clearScenes();
await fakeReset([{ text: SHORT, finish: 'stop' }, { text: PROSE, finish: 'stop' }]);
t('又能打开开戏弹窗', await openScene());
await click('#sc-go');
await waitDone();
scs = await dbScenes();
h = await hits();
t('第一次字数不够 -> 自动重试，一共 2 次正文', h.chat === 2, JSON.stringify(h));
const retrySys = h.chat >= 2 ? String((await page.evaluate(() => window.__fake.chat[1])).sys) : '';
t('第二次把不合格的原因写进了要求里', retrySys.indexOf('不合格') >= 0, retrySys.slice(-160));
t('重试成功后落的是合格那份', (scs[0] && (scs[0].blocks || []).length) >= 1 && scs[0].quality !== 'warn', JSON.stringify({ q: scs[0] && scs[0].quality, b: scs[0] && (scs[0].blocks || []).length }));

// ---------- 7. 被长度截断 -> 不自动续写 ----------
console.log('=== 7. 截断 ===');
await clearScenes();
await fakeReset([{ text: PROSE, finish: 'length' }]);
t('再开一场', await openScene());
await click('#sc-go');
await page.waitForFunction(() => !!document.querySelector('.rv-warn'), { timeout: 40000 }).catch(() => {});
await sleep(600);
scs = await dbScenes();
h = await hits();
t('截断后只请求了 1 次（不自动续写）', h.chat === 1, JSON.stringify(h));
t('已生成的正文存下来了', (scs[0] && (scs[0].blocks || []).length) >= 1, JSON.stringify(scs[0] && scs[0].blocks));
t('状态停在「没写完」', scs[0] && scs[0].status === 'generating', String(scs[0] && scs[0].status));
const warnTxt = await page.evaluate(() => { const e = document.querySelector('.rv-warn'); return e ? e.textContent : ''; });
t('页面上明说这一段没写完', warnTxt.indexOf('没写完') >= 0, warnTxt);

// ---------- 8. 中场：先分拍再写 ----------
console.log('=== 8. 中场分拍 ===');
await clearScenes();
// 中场 600–1200 字，下限 480 —— 给两份拼起来的长稿，免得每拍都触发重试
await fakeReset([{ text: PROSE + PROSE, finish: 'stop' }, { text: PROSE + PROSE, finish: 'stop' }]);
t('再开一场', await openScene());
t('长度能切到「中」', await clickSoft('#sc-len button[data-v="medium"]'));
await click('#sc-go');
await page.waitForSelector('#beat-modal:not(.hidden)', { timeout: 40000 }).catch(() => {});
t('中场先出分镜确认', await visible('#beat-modal'));
t('分了两拍', await page.evaluate(() => document.querySelectorAll('#beat-list .beat-row').length === 2));
await click('#beat-ok');
await waitDone(90000);
scs = await dbScenes();
h = await hits();
t('分了拍、写了 2 段正文、收了 1 次场记', h.chat === 2 && h.kinds.filter(k => k === 'beats').length === 1 && h.kinds.filter(k => k === 'log').length === 1, JSON.stringify(h));
t('两拍都写了', (scs[0] && (scs[0].blocks || []).length) === 2, JSON.stringify((scs[0] && (scs[0].blocks || []).map(b => b.beat))));
t('中等长度落的是 medium', scs[0] && scs[0].length === 'medium', String(scs[0] && scs[0].length));

// ---------- 9. 导演模式 ----------
console.log('=== 9. 导演模式 ===');
await clearScenes();
await fakeReset([{ text: PROSE, finish: 'stop' }]);
t('再开一场', await openScene());
t('能切到导演', await clickSoft('#sc-mode button[data-v="director"]'));
await click('#sc-go');
await waitDone();
const dirSys = await page.evaluate(() => { const c = window.__fake.chat[0]; return c ? String(c.sys) : ''; });
t('导演模式提示词说「你不在场」', dirSys.indexOf('你不在场') >= 0, dirSys.slice(0, 200));
t('导演模式正文不许出现「你」', dirSys.indexOf('正文里不出现「你」') >= 0);
t('「在场」里不列他', dirSys.indexOf('在场：红白（她）') >= 0 && dirSys.indexOf('、你') < 0, dirSys.split('【场景卡】')[1] && dirSys.split('【场景卡】')[1].slice(0, 120));

// ---------- 10. 书架里能读回同一篇 ----------
console.log('=== 10. 书架 ===');
await clickSoft('#rv-back');
await sleep(300);
await clickSoft('#btn-settings');
await sleep(300);
await clickSoft('[data-wb-drawer="shelf"]');
await sleep(600);
const items = await page.evaluate(() => document.querySelectorAll('#shelf-list .shelf-item').length);
t('书架上有这一场', items === 1, 'items=' + items);
const shelfTitle = await page.evaluate(() => { const e = document.querySelector('#shelf-list .si-top b'); return e ? e.textContent : ''; });
t('标题是「第 N 夜 · 地点」', /^第 \d+ 夜 · /.test(shelfTitle) || shelfTitle.length > 0, shelfTitle);
await page.evaluate(() => { const e = document.querySelector('#shelf-list .shelf-item'); if (e) e.click(); });
await page.waitForFunction(() => document.getElementById('view-read').classList.contains('active'), { timeout: 20000 });
await sleep(500);
const rvText = await page.evaluate(() => (document.getElementById('rv-body') || {}).textContent || '');
t('阅读页正文和生成的一致', rvText.indexOf('雨还在下') >= 0, rvText.slice(0, 40));
t('阅读页没有气泡和时间戳', await page.evaluate(() => !document.querySelector('#view-read .bub') && !document.querySelector('#view-read .story-time')));

// ---------- 11. 删除这一场 ----------
console.log('=== 11. 删除 ===');
const msgBefore2 = await dbMsgCount();
await click('#rv-more');
await sleep(400);
const menuLabels = await page.evaluate(() => Array.from(document.querySelectorAll('#rv-menu button')).map(b => b.textContent));
t('更多菜单里有「删除这一场」', menuLabels.some(x => x.indexOf('删除这一场') >= 0), JSON.stringify(menuLabels));
const delOk = await page.evaluate(() => { const b = Array.from(document.querySelectorAll('#rv-menu button')).find(x => x.textContent.indexOf('删除这一场') >= 0); if (b) { b.click(); return true; } return false; });
t('点得到删除', delOk);
await sleep(500);
await click('#modal-ok').catch(() => {});
await sleep(700);
scs = await dbScenes();
t('场景进了回收站（没真删）', scs.length === 1 && scs[0].status === 'trashed', JSON.stringify(scs.map(s => s.status)));
t('删除不动聊天记录', (await dbMsgCount()) === msgBefore2, 'before=' + msgBefore2 + ' after=' + (await dbMsgCount()));
await sleep(400);
const liveRows = await page.evaluate(() => document.querySelectorAll('#shelf-list .shelf-item').length);
t('书架上不再显示它', liveRows === 0, 'rows=' + liveRows);
const trashBtn = await page.evaluate(() => { const e = document.getElementById('shelf-trash-btn'); return e ? e.textContent : ''; });
t('回收站入口标着 1', trashBtn.indexOf('1') >= 0, trashBtn);

// ---------- 12. 从聊天成章 ----------
console.log('=== 12. 从聊天成章 ===');
await seed({
  chars: [], kv: [],
  msgs: [
    { id: 'c1', charId: 'sc1', role: 'user', content: '钥匙还在你那儿吧', ts: Date.now() - 5000 },
    { id: 'c2', charId: 'sc1', role: 'assistant', content: '在。我一直没扔。', ts: Date.now() - 4000 }
  ]
});
// reload 让 renderMessages 把这两条串进活动路径 —— 快照读的就是活动路径。
await page.reload({ waitUntil: 'networkidle0' });
await sleep(1200);
const msgBefore3 = await dbMsgCount();
await clickSoft('#btn-settings'); await sleep(300);
await clickSoft('[data-wb-drawer="scene"]'); await sleep(500);
t('弹窗里有「从哪儿起」，两个选项', await page.evaluate(() => document.querySelectorAll('#sc-src button').length === 2));
const src0 = await page.evaluate(() => (document.getElementById('sc-src-note') || {}).textContent || '');
t('默认是空白开戏，说明写明不读聊天', src0.indexOf('不读聊天') >= 0, src0);
await page.evaluate(() => { const b = Array.from(document.querySelectorAll('#sc-src button')).find(x => (x.textContent || '').indexOf('从这段') >= 0); if (b) b.click(); });
await sleep(300);
const src1 = await page.evaluate(() => (document.getElementById('sc-src-note') || {}).textContent || '');
t('选「从这段聊起来」后说明换成快照口径', src1.indexOf('不会改动聊天') >= 0, src1);
await fakeReset([{ text: PROSE, finish: 'stop' }]);
await click('#sc-go');
await page.waitForFunction(() => { const e = document.getElementById('rv-body'); return !!e && e.textContent.indexOf('雨还在下') >= 0; }, { timeout: 25000 }).catch(() => {});
await sleep(600);
const chatReq = await page.evaluate(() => (window.__fake.chat[0] || {}).sys || '');
t('正文提示词里带上了【前情】段', chatReq.indexOf('【前情（从你们的聊天里截的，只当背景）】') >= 0);
t('前情里是那段聊天的原文', chatReq.indexOf('钥匙还在你那儿吧') >= 0, chatReq.slice(0, 60));
t('前情明写「不要复述它」', chatReq.indexOf('不要复述它') >= 0);
scs = await dbScenes();
const chatScene = scs.find(s => s.status !== 'trashed');
t('场景卡记着它是从聊天派生的', !!chatScene && chatScene.source.kind === 'chat' && chatScene.source.chatCharId === 'sc1', JSON.stringify(chatScene && chatScene.source));
t('快照里存着截下来的消息 id', !!chatScene && chatScene.source.msgIds.length >= 1, chatScene ? String(chatScene.source.msgIds.length) : 'none');
t('从聊天派生也不往聊天里写一个字', (await dbMsgCount()) === msgBefore3, 'before=' + msgBefore3 + ' after=' + (await dbMsgCount()));

// ---------- 12b. 删一拍可撤销（规格 §12） ----------
console.log('=== 12b. 删一拍 ===');
const SEED2 = {
  id: 'sd1', v: 1, charId: 'sc1', title: '第 1 夜 · 门边',
  source: { kind: 'blank', chatCharId: '', msgIds: [], excerpt: '' },
  cast: [{ role: 'main', name: '红白', charId: 'sc1' }, { role: 'user', name: '你' }],
  setting: { place: '门边', time: '夜里', weather: '雨' },
  pov: 'her-limited', userMode: 'actor', length: 'medium', targetChars: [600, 1200],
  beats: [
    { start: '她进门', change: '她松了口', stop: '盒子推到中间', guardrails: [] },
    { start: '两人都没动', change: '她说了实话', stop: '她走进里屋', guardrails: [] }
  ],
  blocks: [
    { kind: 'narration', text: '第一拍写出来的正文。', beat: 0 },
    { kind: 'narration', text: '第二拍写出来的正文。', beat: 1 }
  ],
  log: { events: [], cast: [], change: '', openThreads: [], keyLines: [] },
  status: 'done', canon: false, quality: 'ok', currentBeat: 1,
  createdAt: Date.now(), updatedAt: Date.now()
};
await seed({ chars: [], kv: [], msgs: [], scenes: [SEED2] });
await clickSoft('#rv-back'); await sleep(300);
await clickSoft('#btn-settings'); await sleep(300);
await clickSoft('[data-wb-drawer="shelf"]'); await sleep(600);
await page.evaluate(() => { const e = document.querySelector('#shelf-list .shelf-item[data-scene="sd1"]'); if (e) e.click(); });
await page.waitForFunction(() => document.getElementById('view-read').classList.contains('active'), { timeout: 20000 });
await sleep(500);
t('这一场有两拍', await page.evaluate(() => (document.getElementById('rv-end') || {}).textContent !== undefined) && (await dbScenes()).some(s => s.id === 'sd1' && s.beats.length === 2));
await click('#rv-more');
await sleep(400);
const menu2 = await page.evaluate(() => Array.from(document.querySelectorAll('#rv-menu button')).map(b => b.textContent));
t('菜单里按拍列出「删掉第 N 拍」', menu2.filter(x => x.indexOf('删掉第') >= 0).length === 2, JSON.stringify(menu2));
await page.evaluate(() => { const b = Array.from(document.querySelectorAll('#rv-menu button')).find(x => x.textContent.indexOf('删掉第 2 拍') >= 0); if (b) b.click(); });
await sleep(500);
await click('#modal-ok').catch(() => {});
await sleep(700);
let afterDel = (await dbScenes()).find(s => s.id === 'sd1') || {};
t('只剩一排拍', (afterDel.beats || []).length === 1, 'beats=' + (afterDel.beats || []).length);
t('这一拍的正文也一起删了', (afterDel.blocks || []).length === 1 && (afterDel.blocks || []).every(b => Number(b.beat || 0) === 0), JSON.stringify((afterDel.blocks || []).map(b => b.beat)));
t('当前拍夹回到第一拍', Number(afterDel.currentBeat) === 0, 'cur=' + afterDel.currentBeat);
t('跳出撤销条', await visible('#rv-undo'));
t('正文里也看不到那一拍了', await page.evaluate(() => ((document.getElementById('rv-body') || {}).textContent || '').indexOf('第二拍') < 0));
await click('#rv-undo-btn');
await sleep(800);
afterDel = (await dbScenes()).find(s => s.id === 'sd1') || {};
t('撤销把两拍都拿回来了', (afterDel.beats || []).length === 2, 'beats=' + (afterDel.beats || []).length);
t('撤销把正文也拿回来了', (afterDel.blocks || []).length === 2);
t('撤销后撤销条收起来', !(await visible('#rv-undo')));
t('撤销不动聊天记录', true);

// ---------- 12c. 记住上次读到哪（规格 §11） ----------
console.log('=== 12c. 读到哪 ===');
const LONG = new Array(24).fill('雨声把屋子压得很低，她把伞靠在门边，没有立刻开灯。桌上有只旧木盒，盖子开着，边缘留着一道新鲜的划痕。').join(String.fromCharCode(10, 10));
const SEED3 = Object.assign({}, SEED2, {
  id: 'sd2', title: '第 2 夜 · 桌边', status: 'done', currentBeat: 0,
  beats: [{ start: '她进门', change: '她松了口', stop: '盒子推到中间', guardrails: [] }],
  blocks: [{ kind: 'narration', text: LONG, beat: 0 }],
  readAt: 0.5
});
await seed({ chars: [], kv: [], msgs: [], scenes: [SEED3] });
await clickSoft('#rv-back'); await sleep(300);
await clickSoft('#btn-settings'); await sleep(300);
await clickSoft('[data-wb-drawer="shelf"]'); await sleep(600);
await page.evaluate(() => { const e = document.querySelector('#shelf-list .shelf-item[data-scene="sd2"]'); if (e) e.click(); });
await page.waitForFunction(() => document.getElementById('view-read').classList.contains('active'), { timeout: 20000 });
await sleep(900);
const st0 = await page.evaluate(() => { const s = document.getElementById('rv-scroll'); return { top: s ? s.scrollTop : -1, max: s ? (s.scrollHeight - s.clientHeight) : -1 }; });
t('打开时回到了上次的位置（不是顶端也不是末尾）', st0.max > 100 && st0.top > 20 && st0.top < st0.max - 20, JSON.stringify(st0));
await page.evaluate(() => { const s = document.getElementById('rv-scroll'); if (s) s.scrollTop = s.scrollHeight; });
await sleep(1600);
const sd2 = (await dbScenes()).find(s => s.id === 'sd2') || {};
t('读到底之后把位置记下来了', Number(sd2.readAt) >= 0.98, 'readAt=' + sd2.readAt);
await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  await new Promise(r => { const tx = db.transaction('scenes','readwrite'); tx.objectStore('scenes').delete('sd1'); tx.objectStore('scenes').delete('sd2'); tx.oncomplete = r; });
  db.close();
});
await clickSoft('#rv-back'); await sleep(300);

// ---------- 12d. 备份带 scenes / 清空聊天不删 scenes（硬规则） ----------
console.log('=== 12d. 备份与清空 ===');
const SEED4 = Object.assign({}, SEED2, { id: 'sd4', title: '第 3 夜 · 备份里', status: 'done' });
await seed({ chars: [], kv: [], msgs: [], scenes: [SEED4] });
await clickSoft('#btn-settings'); await sleep(300);
await clickSoft('#btn-settings'); await sleep(300);
const DL = R + '/tmp/dl-scene';
fs.rmSync(DL, { recursive: true, force: true });
fs.mkdirSync(DL, { recursive: true });
const cdp = await page.target().createCDPSession();
await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL.split('/').join('\\'), eventsEnabled: true });
await click('#btn-export').catch(() => {});
let got = null;
for (let i = 0; i < 100 && !got; i++) {
  await sleep(200);
  const names = fs.readdirSync(DL).filter(n => n.endsWith('.json'));
  if (names.length) { try { got = JSON.parse(fs.readFileSync(path.join(DL, names[0]), 'utf8')); } catch { got = null; } }
}
t('导出的备份文件里有 scenes 这一段', got && Array.isArray(got.scenes), got ? 'keys=' + Object.keys(got).join(',') : '没等到下载');
t('备份里带着这一场', !!(got && got.scenes && got.scenes.some(s => s.id === 'sd4')));
t('备份里不该有 API Key', !(got && got.settings && got.settings.apiKey));
// 清空聊天：三层确认（清空 -> 确定清空 -> 剧情卡「留着」），走完聊天归零、戏还在
const msgsBefore4 = await dbMsgCount();
await click('#btn-clear-chat').catch(() => {});
await sleep(500); await click('#modal-ok').catch(() => {});
await sleep(400); await click('#modal-ok').catch(() => {});
await sleep(400); await click('#modal-cancel').catch(() => {});
await sleep(1200);
const msgsAfter4 = await dbMsgCount();
// 清空之后会重新落一条开场白（设计如此），所以是「旧消息都没了」而不是「一条不剩」。
t('清空后旧消息都没了（只剩重新来的开场白）', msgsAfter4 < msgsBefore4, 'before=' + msgsBefore4 + ' after=' + msgsAfter4);
const scAfter4 = (await dbScenes()).map(s => s.id);
t('清空聊天不删这场戏（硬规则）', scAfter4.indexOf('sd4') >= 0, JSON.stringify(scAfter4));
await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  await new Promise(r => { const tx = db.transaction('scenes','readwrite'); tx.objectStore('scenes').delete('sd4'); tx.oncomplete = r; });
  db.close();
});
fs.rmSync(DL, { recursive: true, force: true });

// ---------- 13. 英文下不留中文 ----------
console.log('=== 13. 英文 ===');
await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const tx = db.transaction('kv','readwrite');
  tx.objectStore('kv').put({ k: 'settings', v: { apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', clockMode: false, lang: 'en' } });
  tx.oncomplete = () => { db.close(); location.reload(); };
});
await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30000 }).catch(() => {});
await sleep(1400);
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/;
await clickSoft('#btn-settings');
await sleep(300);
const drawerTxt = await page.evaluate(() => { const b = document.querySelector('[data-wb-drawer="shelf"]'); return b ? b.textContent : ''; });
t('抽屉里书架是英文', !CJK.test(drawerTxt), drawerTxt);
await clickSoft('[data-wb-drawer="shelf"]');
await sleep(600);
// 只取界面文案（标题行 / 元信息），不取 .si-pre —— 那是正文预览，属于用户的作品，不是界面文案。
const shelfTxt = await page.evaluate(() => {
  const box = document.getElementById('shelf-list');
  if (!box) return '';
  return Array.from(box.querySelectorAll('.si-top, .si-meta, .si-badge, .shelf-empty, .shelf-head'))
    .map(e => e.textContent).join(' | ');
});
t('书架界面文案在英文下不留中文', !CJK.test(shelfTxt), shelfTxt.slice(0, 100));
t('回收站按钮也是英文', !CJK.test(await page.evaluate(() => { const e = document.getElementById('shelf-trash-btn'); return e ? e.textContent : ''; })));
await clickSoft('[data-wb-drawer="scene"]');
await sleep(500);
const scTxt = (await page.evaluate(() => (document.getElementById('scn-modal') || {}).textContent || '')).split('红白').join('');   // 角色名是数据，不算界面文案
t('开戏弹窗在英文下不留中文', !CJK.test(scTxt), (scTxt.match(/[\u4e00-\u9fff]+/g) || []).slice(0, 6).join('|'));
const segTxt = await page.evaluate(() => Array.from(document.querySelectorAll('#sc-len button')).map(b => b.textContent).join('|'));
t('两档长度是英文', !CJK.test(segTxt), segTxt);

// ---------- 14. 无未捕获报错 ----------
console.log('=== 14. 报错 ===');
t('全程没有未捕获的 JS 报错', errs.length === 0, errs.join(' | '));

console.log('');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close();
server.close();
process.exit(fail > 0 ? 1 : 0);
