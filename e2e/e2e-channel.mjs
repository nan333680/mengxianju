// e2e-channel.mjs — 三通道（0.5.3.4）到底有没有进提示词、有没有真渲染、有没有真洗
//
// 这一套钉三件事：
//   A. 提示词层：括号 / 星号 / 台词三层都在，旧的两张档位表（DESC_HINT / DETAIL_DRIVE）
//      不再进提示词 —— 它们是「把心里写成违规内容」的源头，必须确认真的退出了注入。
//   B. 渲染层：一对星号变斜体，双星号仍是加粗，尖括号仍被转义；朗读时不念心里话。
//   C. 去味层：发出去的历史里没有「我认」这种独立认输句，新回复入库前被洗过，
//      惯性动作短语会进「这几样这一轮别再用」。
//
// ⚠️ 全部走真实路径（真发请求、真落库、真渲染），不读源码断言 ——
//    源码断言只能证明"写了"，证明不了"跑了"。
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
const URL0 = 'http://127.0.0.1:' + port + '/';
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 120000,
  args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
const page = await browser.newPage();
await page.evaluateOnNewDocument(() => {
  Object.defineProperty(navigator, 'language', { get: () => 'zh-CN', configurable: true });
  Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh'], configurable: true });
  // 朗读捕获：不装真的语音引擎，只记下 speak() 收到了什么
  window.__spoken = [];
  // speak() 要回调 onstart —— app.js 里有个 2.5 秒探针，用来判定「引擎叫不醒」，
  // 假的引擎不回调就会被判成哑的（真引擎都会回调）。
  const fake = { speak: (u) => { window.__spoken.push(String(u && u.text || ''));
    try { if (u && typeof u.onstart === 'function') setTimeout(() => u.onstart(), 0); } catch (e) {} },
    cancel() {}, pause() {}, resume() {}, getVoices: () => [], addEventListener() {}, removeEventListener() {},
    speaking: false, paused: false, pending: false, onvoiceschanged: null };
  try { Object.defineProperty(window, 'speechSynthesis', { get: () => fake, configurable: true }); } catch (e) {}
  window.SpeechSynthesisUtterance = function (txt) { this.text = String(txt == null ? '' : txt); };
});
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = []; page.on('pageerror', e => errs.push(e.message));
const sleep = ms => new Promise(r => setTimeout(r, ms));

let lastBody = null;
let NEXT_REPLY = '嗯，我在。';
// 一次性回复队列：第 12 节要模拟「第一次写坏了 → 重写回路再要一次」，
// 所以按顺序发不同内容，队列空了才退回 NEXT_REPLY。
const REPLAY_QUEUE = [];
let REQ_N = 0;
await page.setRequestInterception(true);
page.on('request', req => {
  if (req.url().includes('/chat/completions')) {
    if (req.method() === 'OPTIONS') { req.respond({ status: 204, headers: { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Headers':'*', 'Access-Control-Allow-Methods':'*' } }); return; }
    try { const b = JSON.parse(req.postData() || '{}'); if (b.stream) lastBody = b; } catch (e) { /* ignore */ }
    // 0.5.3.6：单聊每轮会先跑一次【非流式】判断（Psyche v1）。它不属于这一套要钉的三件事，
    // 而且会吃掉 REPLAY_QUEUE 里预置的响应（第 12/13 节就是靠队列顺序模拟「写坏 → 重写」）。
    // 所以判断那趟单独走：回一段不是 JSON 的文本，让它失败退回老路径 —— 正文请求拿到的还是
    // 队列里该拿的那一条，REQ_N 也只数正文请求。
    let isJudge = false;
    try { isJudge = JSON.parse(req.postData() || '{}').stream === false; } catch (e) { /* ignore */ }
    if (isJudge) {
      req.respond({ status: 200, headers: { 'Access-Control-Allow-Origin':'*' }, contentType: 'application/json',
        body: JSON.stringify({ choices: [{ message: { content: '这一轮先不判断。' } }] }) });
      return;
    }
    REQ_N++;
    const reply = REPLAY_QUEUE.length ? REPLAY_QUEUE.shift() : NEXT_REPLY;
    // 队列项可以是字符串，也可以是 { text, finish }（第 13 节要伪造「重写版被截断」）
    const rText = typeof reply === 'string' ? reply : String(reply.text || '');
    const rFin = typeof reply === 'string' ? 'stop' : String(reply.finish || 'stop');
    const chunk = JSON.stringify({ choices: [{ delta: { content: rText }, finish_reason: rFin }] });
    req.respond({ status: 200, headers: { 'Access-Control-Allow-Origin':'*' }, contentType: 'text/event-stream',
      body: 'data: ' + chunk + NL + NL + 'data: [DONE]' + NL + NL }); return;
  }
  req.continue();
});

const CHAR_ID = 'ch1';
const dbDo = (fn, arg) => page.evaluate(fn, arg);
const putChar = (patch) => page.evaluate(async (o) => {
  const req = indexedDB.open('ai-companion');
  const db = await new Promise(r => { req.onsuccess = () => r(req.result); });
  const c = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').get(o.id); q.onsuccess = () => r(q.result); });
  Object.assign(c, o.patch);
  await new Promise(r => { const tx = db.transaction('characters', 'readwrite'); tx.objectStore('characters').put(c); tx.oncomplete = r; });
  db.close();
}, { id: CHAR_ID, patch });
const putKV = (patch) => page.evaluate(async (o) => {
  const req = indexedDB.open('ai-companion');
  const db = await new Promise(r => { req.onsuccess = () => r(req.result); });
  const rec = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get('settings'); q.onsuccess = () => r(q.result); });
  const v = Object.assign({}, (rec && rec.v) || {}, o);
  await new Promise(r => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put({ k: 'settings', v }); tx.oncomplete = r; });
  db.close();
}, patch);
const enterChat = async () => {
  await page.goto(URL0, { waitUntil: 'networkidle0' }); await sleep(900);
  await page.evaluate(() => { const c = [...document.querySelectorAll('#char-list .char-card')][0]; if (c) c.click(); });
  await sleep(1200);
};
const send = async (text) => {
  lastBody = null;
  await page.evaluate(x => { const i = document.getElementById('input'); i.value = x; i.dispatchEvent(new Event('input', { bubbles: true })); }, text);
  await sleep(150);
  await page.evaluate(() => document.getElementById('btn-send').click());
  for (let i = 0; i < 60; i++) { await sleep(250); const b = await page.$eval('#btn-stop', e => !e.classList.contains('hidden')).catch(() => false); if (!b) break; }
  await sleep(600);
  return lastBody ? (lastBody.messages || []).map(m => m.content || '').join(NL) : '';
};

// ---------- 清库 + 造一个干净的角色 ----------
await page.goto(URL0, { waitUntil: 'networkidle0', timeout: 40000 });
await sleep(1200);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil: 'networkidle0' }); await sleep(700);
await page.evaluate(async (id) => {
  const req = indexedDB.open('ai-companion');
  const db = await new Promise(r => { req.onsuccess = () => r(req.result); });
  const put = (st, rec) => new Promise(r => { const tx = db.transaction(st, 'readwrite'); tx.objectStore(st).put(rec); tx.oncomplete = r; });
  await put('kv', { k: 'settings', v: { apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com',
    longMemory: false, worldbookOn: false, myProfile: '', myEnv: '', splitMax: 1, clockMode: false,
    ttsOn: false, kaomojiFreq: 0, emojiFreq: 0 } });
  await put('characters', { id, name: '甲', greeting: '（开场）', persona: '你是甲。', avatar: null,
    presetKey: 'blank', createdAt: Date.now(), temperature: 1, maxTokens: 2048,
    verbosity: 'medium', descLevel: 'mid', detailDrive: 'mid', povStyle: '', thinkMode: false,
    appearance: '', appearanceOn: false, splitMessages: false, hesitation: true, longMemory: false,
    kaomojiFreq: 0, emojiFreq: 0, contextRounds: 20 });
  db.close();
}, CHAR_ID);
await enterChat();
t('进到聊天页', await page.evaluate(() => document.querySelector('#view-chat').classList.contains('active')));

console.log('');
console.log('=== 1. 三通道进没进提示词 ===');
{
  const sys = await send('在吗');
  t('发出了请求', sys.length > 0);
  t('有「# 表达方式」段', sys.includes('# 表达方式'));
  t('括号里【外面】那条在', sys.includes('括号里【外面】'));
  t('星号里【里面】那条在', sys.includes('星号里【里面】'));
  t('括号外【之间】那条在', sys.includes('括号外【之间】'));
  t('说了星号怎么标（一对 * 包住）', sys.includes('整句用一对 * 包住'));
  t('说了不许用两个星号', sys.includes('不要用两个星号'));
  t('心里要具体（不是情绪标签）', sys.includes('不要写「我感到难过」这种情绪标签'));
  t('不许替对方写心理', sys.includes('不要替对方写他的心理'));
  t('不必每轮都有心里', sys.includes('不要每轮都有心里'));
  t('长度改成「该有几段就几段」', sys.includes('该有几段就几段'));
}

console.log('');
console.log('=== 2. 旧的两张档位表真的退出注入 ===');
{
  const sys = await send('在吗');
  t('不再出现「三段式」', !sys.includes('三段式'), sys.includes('三段式') ? '还有三段式' : '');
  t('不再出现「每一段都要有感官锚点」', !sys.includes('每一段都要有感官锚点'));
  t('不再出现「按最低档执行」', !sys.includes('按最低档执行'));
  t('不再出现「不要写心理」', !sys.includes('不要写心理'));
  t('括号不再有 60 字硬上限', !sys.includes('硬上限：每个括号内不超过'));
}

console.log('');
console.log('=== 3. descLevel=off：不写括号，但心里这条通道还在 ===');
{
  await putChar({ descLevel: 'off' }); await enterChat();
  const sys = await send('在吗');
  t('还是要求不写括号', sys.includes('不要写括号里的动作/神态描写'), sys.includes('不要写括号里的动作/神态描写') ? '' : '缺 off 硬规则');
  t('off 档也说清了星号', sys.includes('星号里：你心里真正在想'));
  t('off 档不再有「括号里【外面】」', !sys.includes('括号里【外面】'));
  t('off 档不要求「看见/听见/碰到的东西」', !sys.includes('能看见/听见/碰到的东西'));
  await putChar({ descLevel: 'mid' });
}

console.log('');
console.log('=== 4. 星号渲染：一对 = 斜体，两个 = 加粗，尖括号照样转义 ===');
{
  NEXT_REPLY = '（她把杯子放下）*这话我才不说。*\n<b>不是标签</b> **这是加粗** <script>alert(1)</script>';
  await enterChat();
  await send('说句话');
  const dom = await page.evaluate(() => {
    const last = [...document.querySelectorAll('#messages .msg')].filter(e => !e.querySelector('.err-bub')).pop();
    if (!last) return null;
    const em = last.querySelectorAll('em.inner-thought');
    return { emN: em.length, emText: em.length ? em[0].textContent : '',
      html: last.querySelector('.t') ? last.querySelector('.t').innerHTML : last.innerHTML,
      text: last.textContent,
      strongN: last.querySelectorAll('strong,b').length,
      scriptN: last.querySelectorAll('script').length };
  });
  t('渲染出了 inner-thought', dom && dom.emN === 1, dom && dom.emN);
  t('斜体里是心里那句话', dom && dom.emText === '这话我才不说。', dom && dom.emText);
  t('单个星号包裹已经没了（只剩 markdown 的双星号）', dom && !(dom.text || '').includes('*这话'), dom && (dom.text || '').slice(0, 80));
  t('双星号没被当成心里话', dom && dom.emN === 1);
  t('尖括号被转义（没有 script 节点）', dom && dom.scriptN === 0, dom && dom.scriptN);
}

console.log('');
console.log('=== 5. 朗读时不念心里话 ===');
{
  NEXT_REPLY = '（她把杯子放下）*这话我才不说。*「水凉了。」';
  await putKV({ ttsOn: true }); await enterChat();
  await page.evaluate(() => { window.__spoken = []; });
  await send('说句话');
  await sleep(800);
  const spoken = await page.evaluate(() => (window.__spoken || []).join('|'));
  t('确实调了朗读', spoken.length > 0, spoken.slice(0, 60));
  t('念到了台词', spoken.includes('水凉了'));
  t('没有念心里话', !spoken.includes('这话我才不说'), spoken.slice(0, 80));
  t('没有念括号里的动作', !spoken.includes('她把杯子放下'));
  await putKV({ ttsOn: false });
}

console.log('');
console.log('=== 6. 历史里的星号不丢、旧消息照样能显示 ===');
{
  // 造一条"上一版留下的、带星号的老消息"，重开聊天看它渲染成斜体
  await page.evaluate(async (id) => {
    const req = indexedDB.open('ai-companion');
    const db = await new Promise(r => { req.onsuccess = () => r(req.result); });
    await new Promise(r => { const tx = db.transaction('messages', 'readwrite');
      tx.objectStore('messages').put({ id: 'old1', charId: id, role: 'assistant', content: '*早就想说了。* 你说呢。', ts: Date.now() - 5000 });
      tx.oncomplete = r; });
    db.close();
  }, CHAR_ID);
  await enterChat();
  const old = await page.evaluate(() => [...document.querySelectorAll('#messages em.inner-thought')].map(e => e.textContent));
  t('老消息的星号也被渲染成斜体', old.includes('早就想说了。'), old);
}

console.log('');
console.log('=== 7. 去味：历史里的「我认」不再喂给模型 ===');
{
  await page.evaluate(async (id) => {
    const req = indexedDB.open('ai-companion');
    const db = await new Promise(r => { req.onsuccess = () => r(req.result); });
    const put = (rec) => new Promise(r => { const tx = db.transaction('messages', 'readwrite'); tx.objectStore('messages').put(rec); tx.oncomplete = r; });
    const putKV = (k, v) => new Promise(r => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put({ k, v }); tx.oncomplete = r; });
    // ⚠️ 必须写 parentId 并挪叶子（v0.5.3.4 修）：这段历史走的是 activePath，
    //    而 seedParents() 只在打开角色时补链、且老消息补过一次就不再补 ——
    //    第 6 节已经跑过一轮，这里新塞的 d1/d2 没有 parentId，就【不在任何一条链上】，
    //    从叶子回溯永远走不到。断言于是全部假通过（这是它们一直假红的原因）。
    const all = await new Promise(r => { const q = db.transaction('messages').objectStore('messages').index('charId').getAll(id); q.onsuccess = () => r(q.result || []); });
    all.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    const tail = all.length ? all[all.length - 1].id : '';
    await put({ id: 'd1', charId: id, role: 'assistant', content: '这个我认。\n（她低下头）', ts: Date.now() - 4000, parentId: tail });
    await put({ id: 'd2', charId: id, role: 'assistant', content: '我认得他。', ts: Date.now() - 3000, parentId: 'd1' });
    await putKV('branch:' + id, 'd2');
    db.close();
  }, CHAR_ID);
  await enterChat();
  const sys = await send('在吗');
  t('seed 的历史确实进了请求（探针）', sys.includes('（她低下头）'), sys.includes('（她低下头）') ? '' : '这条 seed 根本没进上下文，下面两条断言会假通过');
  t('历史里那句「这个我认。」没进请求', !sys.includes('这个我认。'), sys.includes('这个我认。') ? '还带着' : '');
  t('「我认得他」这种正常用法不被误删', sys.includes('我认得他'), sys.includes('我认得他') ? '' : '误删了');
}

console.log('');
console.log('=== 8. 去味：新回复入库前洗干净（显示和库一起干净）===');
{
  NEXT_REPLY = '（她把碗推过来）\n我认。';
  await enterChat();
  await send('吃了吗');
  const db = await page.evaluate(async (id) => {
    const req = indexedDB.open('ai-companion');
    const d = await new Promise(r => { req.onsuccess = () => r(req.result); });
    const all = await new Promise(r => { const q = d.transaction('messages').objectStore('messages').index('charId').getAll(id); q.onsuccess = () => r(q.result || []); });
    d.close();
    return all.map(m => m.content || '');
  }, CHAR_ID);
  const joined = db.join(NL);
  // ⚠️ 只看【这一条新回复】：整屏 textContent 里带着前面几节留下的旧消息
  //    （第 7 节那条 seed 的「这个我认。」原文还在库里），会把它误判成没洗干净。
  const lastBub = await page.evaluate(() => {
    const n = [...document.querySelectorAll('#messages .msg.ai')];
    return n.length ? n[n.length - 1].textContent : '';
  });
  t('屏幕上也没有', !lastBub.includes('我认。'), lastBub.slice(-60));
  t('别的内容还在（没把这整条删空）', joined.includes('她把碗推过来'), joined.slice(-60));
}

console.log('');
console.log('=== 9. 惯性动作：反复出现的括号短语进「别再用」 ===');
{
  await page.evaluate(async (id) => {
    const req = indexedDB.open('ai-companion');
    const db = await new Promise(r => { req.onsuccess = () => r(req.result); });
    const put = (rec) => new Promise(r => { const tx = db.transaction('messages', 'readwrite'); tx.objectStore('messages').put(rec); tx.oncomplete = r; });
    const lines = ['（抬手把他按住）', '（抬手把他推开）', '（抬手把他往里带）', '（抬手把他扶正）',
      '（低头看他一眼）', '（低头看他笑）', '（低头看他，没说话）', '（低头看他，摇头）'];
    for (let i = 0; i < lines.length; i++) await put({ id: 'c' + i, charId: id, role: 'assistant', content: lines[i], ts: Date.now() - (50 - i) * 1000 });
    db.close();
  }, CHAR_ID);
  await enterChat();
  const sys = await send('在吗');
  t('有「这几样这一轮别再用」段', sys.includes('# 这几样这一轮别再用'), sys.includes('# 这几样这一轮别再用') ? '' : '没这一段');
  const seg = sys.slice(sys.indexOf('# 这几样这一轮别再用'), sys.indexOf('# 这几样这一轮别再用') + 400);
  t('抓到了「抬手把他」', seg.includes('抬手把他'), seg.slice(0, 160));
  t('说了「不是换个词说同一件事」', seg.includes('不是让你换个词说同一件事'), seg.slice(0, 200));
}

console.log('');
console.log('=== 10. 两个档位控件：隐藏了，但数据还在 ===');
{
  await putChar({ descLevel: 'low', detailDrive: 'max' });
  const vis = await page.evaluate(() => {
    const out = {};
    for (const id of ['s-desc', 's-drive']) {
      const el = document.getElementById(id);
      if (!el) { out[id] = 'MISSING'; continue; }
      // 两个控件的包裹层不一样：#s-desc 是 div.seg，外面还有 .field；#s-drive 自己就是那行 button
      const box = el.closest('.field') || el;
      out[id] = getComputedStyle(box).display;
    }
    return out;
  });
  t('#s-desc 不可见', vis['s-desc'] === 'none', vis['s-desc']);
  t('#s-drive 不可见', vis['s-drive'] === 'none', vis['s-drive']);
  await enterChat();
  const keep = await page.evaluate(async (id) => {
    const req = indexedDB.open('ai-companion');
    const d = await new Promise(r => { req.onsuccess = () => r(req.result); });
    const c = await new Promise(r => { const q = d.transaction('characters').objectStore('characters').get(id); q.onsuccess = () => r(q.result); });
    d.close();
    return { desc: c.descLevel, drive: c.detailDrive };
  }, CHAR_ID);
  t('角色上的 descLevel 还是 low', keep.desc === 'low', keep.desc);
  t('角色上的 detailDrive 还是 max', keep.drive === 'max', keep.drive);
  const sys = await send('在吗');
  t('旧值不再改变提示词（low/max 都不注入旧表）', !sys.includes('三段式') && !sys.includes('按最低档执行'));
  await putChar({ descLevel: 'mid', detailDrive: 'mid' });
}

console.log('');
console.log('=== 12. 万能动作命中 → 自动重写一次 ===');
{
  // 第一次写坏了（偏头 / 后颈 都是跨角色统计出来的模型模板动作），
  // 第二次是它按「把这条摆在面前重写」的要求给出的干净版本。
  REPLAY_QUEUE.push('（她偏头看他，后颈一凉）' + NL + '「水凉了。」');
  REPLAY_QUEUE.push('（她把杯子往他那边推了推）' + NL + '「水凉了。」');
  REQ_N = 0;
  await enterChat();
  await send('说句话');
  const lastAi = await page.evaluate(async (id) => {
    const req = indexedDB.open('ai-companion');
    const d = await new Promise(r => { req.onsuccess = () => r(req.result); });
    const all = await new Promise(r => { const q = d.transaction('messages').objectStore('messages').index('charId').getAll(id); q.onsuccess = () => r(q.result || []); });
    d.close();
    all.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    const ai = all.filter(m => m.role === 'assistant');
    return ai.length ? String(ai[ai.length - 1].content || '') : '';
  }, CHAR_ID);
  t('一共发了两次请求（重写回路真的跑了）', REQ_N === 2, REQ_N);
  t('留下的是重写后的版本', lastAi.includes('往他那边推了推'), lastAi.slice(-40));
  t('模板动作没有落库', !lastAi.includes('偏头') && !lastAi.includes('后颈'), lastAi.slice(-40));
  const bub = await page.evaluate(() => {
    const n = [...document.querySelectorAll('#messages .msg.ai')];
    return n.length ? n[n.length - 1].textContent : '';
  });
  t('屏幕上也是重写后的版本', bub.includes('推了推'), bub.slice(-40));
  REPLAY_QUEUE.length = 0;
}

console.log('');
console.log('=== 13. 重写版被 max_tokens 截断 → 不采用，保留完整首版 ===');
{
  // 首版写了好几个模板动作（触发重写），重写版虽然干净、但被截断在半个句子上。
  // 原来这一趟没传 onFinish，重写版会带着首版的 'stop' 混过关 —— 用一条半截话
  // 顶掉本来完整的那条，而且界面上还不报截断。
  REPLAY_QUEUE.push('（她偏头看他）' + NL + '「水凉了，你先喝。」');
  REPLAY_QUEUE.push({ text: '（她把杯子往他那边推了推）' + NL + '「水凉', finish: 'length' });
  REQ_N = 0;
  await enterChat();
  await send('说句话');
  const lastAi = await page.evaluate(async (id) => {
    const req = indexedDB.open('ai-companion');
    const d = await new Promise(r => { req.onsuccess = () => r(req.result); });
    const all = await new Promise(r => { const q = d.transaction('messages').objectStore('messages').index('charId').getAll(id); q.onsuccess = () => r(q.result || []); });
    d.close();
    all.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    const ai = all.filter(m => m.role === 'assistant');
    return ai.length ? String(ai[ai.length - 1].content || '') : '';
  }, CHAR_ID);
  t('重写确实发了第二趟', REQ_N === 2, REQ_N);
  // ⚠️ 首版自己就含「水凉了」（那是台词），所以判据必须是【重写版独有的那半句】在不在，
  //    不能拿「水凉」当标记 —— 否则断言永远红（这一条第一版就写错了）。
  t('被截断的重写版没有被采用', !lastAi.includes('推了推'), lastAi.slice(-40));
  t('完整的首版还在', lastAi.includes('你先喝'), lastAi.slice(-40));
  REPLAY_QUEUE.length = 0;
}

console.log('');
console.log('=== 14. 跨行的心里话也不会被念出来 ===');
{
  // ttsClean 原来靠 INNER_RE 的 [^*\n]{1,300} 剥星号 —— 它不跨行，
  // 跨行的心里话剥不掉，剩下的 * 又被记号清理删掉，于是整段心里话变成正文被念出来。
  await putKV({ ttsOn: true });
  NEXT_REPLY = '（她点头）*我' + NL + '其实不想说*' + NL + '「水凉了。」';
  await enterChat();
  await send('说句话');
  await sleep(900);
  const spoken = await page.evaluate(() => (window.__spoken || []).join(' | '));
  t('跨行的心里话没有被念出来', !spoken.includes('其实不想说'), spoken.slice(0, 120));
  t('台词照常念了', spoken.includes('水凉了'), spoken.slice(0, 120));
  await putKV({ ttsOn: false });
  NEXT_REPLY = '嗯，我在。';
}

console.log('');
console.log('=== 11. 没冒出未捕获异常 ===');
t('pageerror 为空', errs.length === 0, errs.slice(0, 3));

console.log('');
console.log(pass + ' 项通过 / ' + fail + ' 项失败');
await browser.close(); server.close();
process.exit(fail > 0 ? 1 : 0);
