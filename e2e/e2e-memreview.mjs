// e2e-memreview.mjs —— 记忆方向复核（v0.5.4.4）
//
// 起因：2026-11-03 实测那条记忆 —— 有出处、有动作、人格卡里还明写着，
// 方向照样反了（"我念错咒语把你召出来"）。0.5.3.7 / 0.5.3.8 各加过一次禁令都漏了，
// 这一版改成写入前另起一次请求做二分类，判出问题的进收件箱、不删不改写。
//
// 这个套件验的是「复核真的跑了、真的拦住了、拦住的东西没丢」：
//   1. 总结之后确实多了一次复核请求，且它带着转录（不是只有记忆正文）
//   2. 判 bad 的落成 draft + memReviewWhy，正文原样保留
//   3. 判 bad 的不会被「重复」那条捷径转正（用户点名的坑）
//   4. 收下之后标记清掉，下次重复命中不会再被打回
//   5. 复核失败时按正常写入 —— 复核是锦上添花，不能连带记忆失效
//
// ⚠️ 每轮用【新角色 + reload】：一句话之后分支逻辑会变，塞进去的裸消息
//    可能挂在非活动分支上，pending 数瞬间掉到门槛以下，总结根本不跑。
//    表现是「这一轮什么都没发生」，断言会全部变成假通过（踩过）。
import puppeteer from 'puppeteer-core';
import http from 'http'; import fs from 'fs'; import path from 'path';
import { seedChar } from './e2e-helper.mjs';
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

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 120000,
  args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = []; page.on('pageerror', e => errs.push(e.message));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass=0, fail=0;
const t=(n,ok,ex='')=>{ if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));} };
const waitFor = async (fn, ms = 25000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(400); }
  return false;
};

const BAD_TEXT = '我念错咒语把你召出来，你嘴上说怕我，却要我留下。';

// 整条链路都走 window.fetch：总结（非流式）+ 复核（非流式）+ 聊天（流式）。
// 用 body 里的问句区分「复核」和「总结」—— 复核的问句里有「逐条核对」。
// 两个开关：__memText（这次提炼出的正文）、__reviewMode（复核成功/失败）。
await page.evaluateOnNewDocument((BAD_TEXT) => {
  window.__hits = { sum: [], review: [], chat: 0 };
  window.__memText = BAD_TEXT;
  window.__reviewMode = 'ok';
  const realFetch = window.fetch.bind(window);
  window.fetch = async function (url, opts) {
    const u = String(url);
    if (!u.includes('/chat/completions')) return realFetch(url, opts);
    let body = {};
    try { body = JSON.parse((opts && opts.body) || '{}'); } catch (e) {}
    const text = JSON.stringify(body);
    if (text.indexOf('逐条核对') >= 0) {
      window.__hits.review.push(body);
      if (window.__reviewMode === 'fail') return new Response('boom', { status: 500 });
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"bad":[1]}' } }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (body.stream !== true) {
      window.__hits.sum.push(body);
      const one = { text: window.__memText, kind: 'event', quote: '行行行你留下', subject: 'char',
                    scope: 'character', freq: 'once', key: null };
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify([one]) } }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    window.__hits.chat++;
    const chunk = (o) => 'data: ' + JSON.stringify(o) + String.fromCharCode(10,10);
    const stream = new ReadableStream({ start(c) {
      c.enqueue(new TextEncoder().encode(chunk({ choices: [{ delta: { content: '嗯。' } }] })));
      c.enqueue(new TextEncoder().encode('data: [DONE]' + String.fromCharCode(10,10)));
      c.close();
    }});
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
}, BAD_TEXT);

const memOf = (cid) => page.evaluate(async (cid) => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => o.onsuccess = () => r(o.result));
  const q = db.transaction('memories').objectStore('memories').getAll();
  const all = await new Promise(r => q.onsuccess = () => r(q.result));
  db.close();
  return all.filter(m => m.charId === cid);
}, cid);

/** 塞一批「和召出来这件事有关」的对话，凑够 memSummarizeEvery=35 */
const pushMsgs = (cid, prefix, n = 40) => page.evaluate(async ({cid, prefix, n}) => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => o.onsuccess = () => r(o.result));
  const tx = db.transaction('messages','readwrite'); const st = tx.objectStore('messages');
  for (let i = 0; i < n; i++) {
    st.put({ id: prefix + i, charId: cid, role: (i % 2 ? 'assistant' : 'user'),
      content: (i % 2 ? '你念错了词。叫出来的是我。' : '你把我叫出来的。'),
      ts: Date.now() + i, archived: false });
  }
  await new Promise(r => tx.oncomplete = r); db.close();
}, {cid, prefix, n});

/** 预写一条 draft（模拟"上一版已经把它记进收件箱了"），用来验重复守卫 */
const seedDraft = (cid, text) => page.evaluate(async ({cid, text}) => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => o.onsuccess = () => r(o.result));
  const tx = db.transaction('memories','readwrite');
  tx.objectStore('memories').put({
    id: 'pre-' + cid, charId: cid, text, kind: 'event', key: '', subject: 'char', scope: 'character',
    quote: '行行行你留下', sourceKind: 'message', sourceMsgIds: [], status: 'draft',
    memReviewWhy: '方向待核', legacy: false, ts: Date.now(), day: 1,
  });
  await new Promise(r => tx.oncomplete = r); db.close();
}, {cid, text});

const setFlags = (memText, reviewMode) => page.evaluate(({memText, reviewMode}) => {
  window.__memText = memText; window.__reviewMode = reviewMode;
}, {memText, reviewMode});

const inChat = () => page.evaluate(() => {
  const v = document.querySelector('.view.active');
  return !!(v && v.id === 'view-chat' && document.querySelector('#input'));
});

const enterChar = async (name) => {
  // reload 之后页面可能还停在自动打开的上一个角色上：先确认真的进了目标角色。
  for (let i = 0; i < 4; i++) {
    if (await inChat()) {
      const who = await page.evaluate(() => (document.querySelector('#chat-title') || {}).textContent || '');
      if (who.includes(name)) return true;
    }
    await page.evaluate(() => {
      const b = document.getElementById('btn-chars') || document.getElementById('btn-chat-back');
      if (b) b.click();
    });
    await sleep(600);
    const clicked = await page.evaluate((name) => {
      const c = [...document.querySelectorAll('#char-list .char-card')].find(x => x.textContent.includes(name));
      if (c) { c.click(); return true; }
      return false;
    }, name);
    if (!clicked) { await sleep(500); continue; }
    await sleep(1200);
  }
  return await inChat();
};

const sendOne = async (v) => {
  // 发送按钮在开场白流式生成期间是禁用的，盲点会被吞掉（踩过：整轮静默没跑）。
  await waitFor(async () => await page.evaluate(() => {
    const b = document.querySelector('#btn-send');
    return !!b && !b.disabled;
  }), 12000);
  await page.evaluate((v) => {
    const i = document.querySelector('#input');
    if (i) { i.value = v; i.dispatchEvent(new Event('input', { bubbles: true })); }
    const b = document.querySelector('#btn-send'); if (b) b.click();
  }, v);
};

/** 写全局设置：没有 apiKey 时点发送只会弹提示，一个请求都不会发出去 */
const initSettings = () => page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => o.onsuccess = () => r(o.result));
  const ktx = db.transaction('kv','readwrite'); const ks = ktx.objectStore('kv');
  const g = await new Promise(r => { const q = ks.get('settings'); q.onsuccess = () => r(q.result); });
  const val = Object.assign({}, (g && g.v) || {});
  val.apiKey = 'sk-test';
  val.baseUrl = 'http://127.0.0.1:' + location.port + '/v1';
  val.longMemory = true; val.memSummarizeEvery = 35; val.memLimit = 25;
  ks.put({ k:'settings', v: val });
  await new Promise(r => ktx.oncomplete = r);
  db.close();
});

/** 一轮 = 新角色 + 40 条消息 + reload + 发一条 → 等总结真的跑完 */
const runRound = async (name, memText, reviewMode, preDraftText) => {
  const cid = await seedChar(page, name, { greeting: '（开场）', longMemory: true, persona: '你是' + name + '。' });
  await pushMsgs(cid, 'm' + name.length + '_');
  if (preDraftText) await seedDraft(cid, preDraftText);
  await page.reload({ waitUntil: 'networkidle0' }); await sleep(700);
  await setFlags(memText, reviewMode);
  const entered = await enterChar(name);
  await sendOne('你把我叫出来的');
  const ok = await waitFor(async () => (await memOf(cid)).length > 0);
  await sleep(1500);
  const diag = await page.evaluate(() => ({
    view: (document.querySelector('.view.active') || {}).id,
    chat: window.__hits.chat, sum: window.__hits.sum.length, review: window.__hits.review.length,
    // 只有这一句能证明是【记忆总结】发了，而不是别的非流式请求凑数
    ranSum: window.__hits.sum.some(b => JSON.stringify(b).includes('正在回顾')),
  }));
  // ⚠️ 判"这一轮真的跑了"必须看 ranSum，不能看"库里有没有记忆"：
  //    预写的那条 draft 会让后者恒为真，整轮静默没跑也照样"通过"（踩过）。
  if (!diag.ranSum) console.log('   [诊断] 这一轮没产出记忆 ' + JSON.stringify({ entered, ...diag }));
  return { cid, ok: ok && diag.ranSum, ranSum: diag.ranSum, diag };
};

// ============================================================
await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
await sleep(800);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil:'networkidle0' }); await sleep(600);

console.log('=== 0. 静态：接线都在 ===');
const src = await page.evaluate(async () => (await fetch('./js/app.js')).text());
t('有 reviewMemoryDirection', src.includes('async function reviewMemoryDirection'));
t('两条写入路径都调了它',
  (src.match(/await reviewMemoryDirection\(items, txt,/g) || []).length === 2,
  String((src.match(/await reviewMemoryDirection\(items, txt,/g) || []).length));
t('重复守卫存在（两处）',
  (src.match(/if \(merged\.memReviewWhy \|\| it\.memReviewWhy\)/g) || []).length === 2,
  String((src.match(/if \(merged\.memReviewWhy \|\| it\.memReviewWhy\)/g) || []).length));
// 用户点名要的一条：落 draft 必须在 shouldAutoCommit 之后，否则被它的 ACTIVE 盖掉
const fnStart = src.indexOf('function memRecFromItem');
const fnBody = src.slice(fnStart, src.indexOf('\n}', fnStart));
t('memReviewWhy 判定在 shouldAutoCommit 之后',
  fnBody.indexOf('shouldAutoCommit') >= 0 && fnBody.indexOf('it.memReviewWhy') > fnBody.indexOf('shouldAutoCommit'));
t('有熔断上限', src.includes('MEM_REVIEW_MAX_FAILS'));
t('收下时清标记', src.includes("memReviewWhy: ''"));

await initSettings();

console.log('=== 1. 跑一次真实总结：复核被调用、带上了转录 ===');
const r1 = await runRound('复核甲', BAD_TEXT, 'ok');
t('总结真的跑了、记忆落了库', r1.ok && (await memOf(r1.cid)).length >= 1);
const hits1 = await page.evaluate(() => window.__hits);
t('真的发了一次复核请求', hits1.review.length === 1, 'review=' + hits1.review.length);
t('复核请求带上了转录原文',
  hits1.review.length > 0 && JSON.stringify(hits1.review[0]).includes('你念错了词'));
t('复核请求带上了待核的正文',
  hits1.review.length > 0 && JSON.stringify(hits1.review[0]).includes('念错咒语'));

console.log('=== 2. 判 bad 的落成 draft + 标记，不进提示词 ===');
const m1 = (await memOf(r1.cid))[0] || {};
t('status=draft', m1.status === 'draft', String(m1.status));
t('memReviewWhy=方向待核', m1.memReviewWhy === '方向待核', String(m1.memReviewWhy));
t('正文原样保留（没删没改）', String(m1.text).includes('念错咒语'));

console.log('=== 3. 收件箱里看得见、带原因 ===');
await page.evaluate(() => document.getElementById('btn-settings').click());
await sleep(700);
await page.evaluate(() => {
  const b = [...document.querySelectorAll('#drawer-menu [data-wb-drawer]')].find(x => x.dataset.wbDrawer === 'settings');
  if (b) b.click();
});
await sleep(900);
await page.evaluate(() => {
  const w = document.getElementById('mem-wrap');
  if (w && !w.classList.contains('open')) { const h = document.getElementById('mem-fold'); if (h) h.click(); }
});
await sleep(1200);
await page.evaluate(() => { const b = document.getElementById('mem-view-inbox'); if (b) b.click(); });
await sleep(900);
const inboxHtml = await page.evaluate(() => (document.getElementById('mem-groups') || {}).innerHTML || '');
t('收件箱里能看到这条', inboxHtml.includes('念错咒语'), inboxHtml.slice(0, 100));
t('标签里写了「方向待核」', inboxHtml.includes('方向待核'));

console.log('=== 4. 重复命中不会把待核条目转正 ===');
// 预写一条同正文的 draft（=上一版留下的），再跑一轮总结让它"重复命中"。
// 守卫没接上的话，重复路径会把这条 draft 转回 active —— 复核就白做了。
const r2 = await runRound('复核乙', BAD_TEXT, 'ok', BAD_TEXT);
await sleep(1500);
const m2 = await memOf(r2.cid);
t('这一轮总结真的跑了', r2.ranSum, JSON.stringify(r2.diag));
t('重复命中后仍然只有 1 条（并进旧条目）', m2.length === 1, 'n=' + m2.length);
t('重复命中后仍然是 draft（没被转正）', (m2[0] || {}).status === 'draft', String((m2[0] || {}).status));
t('重复命中后标记还在', (m2[0] || {}).memReviewWhy === '方向待核', String((m2[0] || {}).memReviewWhy));

console.log('=== 5. 收下之后标记清掉（下次重复命中不会再被打回） ===');
await page.evaluate(() => document.getElementById('btn-settings').click());
await sleep(700);
await page.evaluate(() => {
  const b = [...document.querySelectorAll('#drawer-menu [data-wb-drawer]')].find(x => x.dataset.wbDrawer === 'settings');
  if (b) b.click();
});
await sleep(900);
await page.evaluate(() => {
  const w = document.getElementById('mem-wrap');
  if (w && !w.classList.contains('open')) { const h = document.getElementById('mem-fold'); if (h) h.click(); }
});
await sleep(1000);
await page.evaluate(() => { const b = document.getElementById('mem-view-inbox'); if (b) b.click(); });
await sleep(800);
// 收件箱是按角色分组的，前面几轮的 draft 也在里面 —— 必须点【本角色】那一组，
// 不然会收下别人的条目，然后对着 untouched 的这条断言"没生效"。
await page.evaluate((cid) => {
  const g = document.querySelector('#mem-groups .mem-group[data-cid="' + cid + '"]');
  const b = g && g.querySelector('[data-accept]');
  if (b) b.click();
}, r2.cid);
await sleep(1400);
const m3 = (await memOf(r2.cid))[0] || {};
t('收下后 status=active', m3.status === 'active', String(m3.status));
t('收下后 memReviewWhy 已清空', !m3.memReviewWhy, String(m3.memReviewWhy));

console.log('=== 6. 复核失败时按正常写入（不连带记忆失效） ===');
const NEW_TEXT = '你把我带回家，让我住下。';
const r3 = await runRound('复核丙', NEW_TEXT, 'fail');
const m4 = (await memOf(r3.cid))[0] || {};
t('复核挂了，记忆照样写进去了', !!m4.id, JSON.stringify(m4).slice(0, 100));
t('这条是 active（不因为复核失败被挡）', m4.status === 'active', String(m4.status));
t('这条没有复核标记', !m4.memReviewWhy, String(m4.memReviewWhy));
t('复核确实尝试过（所以不是"没跑"）', (await page.evaluate(() => window.__hits.review.length)) >= 1);

t('无未捕获报错', errs.length === 0, errs.slice(0, 3).join(' | '));
// 汇总要和其它套件同一格式，回归脚本才数得进去（写成"26 通过, 0 失败"会被记成「无汇总」）
console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
