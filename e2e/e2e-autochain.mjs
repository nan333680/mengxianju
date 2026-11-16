// e2e-autochain.mjs —— 0.5.7.2：自动连写两个 P0
//
// 这两条都是"代码看起来没问题、要连起来跑才露"的病，所以单独一套：
//
//   1. 第 2 段起丢掉「剧情方向」。
//      pendingCmds 在落库那段被清空（"发出去就清空"），而续写走的是 cont 分支，
//      读到的已经是空数组 —— 于是方向只在第一段生效。
//      判据：3 段生成请求里，每一段都得带着那句方向。
//
//   2. 续写消息挂在根节点上。
//      cont 分支没给 _parent0 赋值，落库时 parentId 写成空串 = 挂到根。
//      而 pathTo 走到空串就停 → 活动路径断掉 → 第 3 段历史只剩 1 条。
//      判据：所有新消息 parentId 非空；活动路径长度 == 库里条数。
//
// 另外顺带守住那条「第 3 段失忆」的推论：如果 parentId 断了，
// 第 3 段的请求里根本读不到第 1 段写的内容。

import puppeteer from 'puppeteer-core';
import { seedChar, waitIdle } from './e2e-helper.mjs';
import http from 'http';
import fs from 'fs';
import path from 'path';

const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');
const WWW = R + '/www';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.png':'image/png' };

const site = http.createServer((req,res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = path.join(WWW, p);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f));
});
await new Promise(r => site.listen(0,'127.0.0.1',r));
const port = site.address().port;

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = [];
page.on('pageerror', e => errs.push(String(e.message)));
let pass = 0, fail = 0;
const t = (n, ok, ex='') => { if (ok) { pass++; console.log('  OK   ' + n); } else { fail++; console.log('  FAIL ' + n + (ex ? '  -> ' + ex : '')); } };

// ⚠️ 所有请求都在页面里拦（和 e2e-v517 一个路子）。理由：这一套要按【请求顺序 + 时间】
// 判断"这是第几段"，走真服务器的话分不清，而且 mock 端拿不到页面里的 epoch。
await page.evaluateOnNewDocument(() => {
  window.__reqAll = [];
  window.__genN = 0;
  const realFetch = window.fetch.bind(window);
  window.fetch = async function (url, opts) {
    const u = String(url);
    let b = {};
    try { b = JSON.parse((opts && opts.body) || '{}'); } catch (e) {}
    if (!u.includes('/chat/completions')) return realFetch(url, opts);
    window.__reqAll.push({ body: b, at: Date.now() });
    const chunk = (o) => 'data: ' + JSON.stringify(o) + String.fromCharCode(10,10);
    // 非流式 = 判断层 / 独白。给一个空对象：这一套不关心它们的返回值，
    // 但必须立刻应答 —— 挂住的话 send() 会一直等，后面的段根本不发。
    if (b.stream === false) {
      return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    window.__genN++;
    const n = window.__genN;
    const payload =
      chunk({ choices: [{ delta: { content: '这是第' + n + '段。【段' + n + '】' } }] }) +
      chunk({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 8 } }) +
      'data: [DONE]' + String.fromCharCode(10,10);
    return new Response(payload, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
});

await page.goto('http://127.0.0.1:' + port + '/', { waitUntil:'networkidle0', timeout:40000 });
await sleep(1200);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion')).catch(() => {});
await sleep(600);
await page.reload({ waitUntil:'networkidle0' }); await sleep(1400);

// 设置：liveV2 关掉。这一套测的是"分段/父节点"，活人感那 6 次调用会把
// "第几段"搅乱（一轮 3 候选 + 评审），关掉才隔离得干净。
await page.evaluate(async () => {
  const req = indexedDB.open('ai-companion');
  const db = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
  const cur = await new Promise((res) => { const t = db.transaction('kv','readonly').objectStore('kv').get('settings'); t.onsuccess = () => res((t.result && t.result.v) || {}); });
  const next = Object.assign({}, cur, {
    apiKey: 'sk-test', baseUrl: 'http://127.0.0.1:1', provider: 'deepseek', model: 'deepseek-flash',
    liveV2: false
  });
  await new Promise((res) => { const t = db.transaction('kv','readwrite'); t.objectStore('kv').put({ k:'settings', v: next }); t.oncomplete = res; });
  db.close();
});

const CID = await seedChar(page, '连写测', { verbosity: 'epic', epicChain: 3, splitMessages: false });
await page.evaluate(async (cid) => {
  const req = indexedDB.open('ai-companion');
  const db = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
  await new Promise((res) => {
    const t = db.transaction('kv','readwrite');
    t.objectStore('kv').put({ k: 'greeted:' + cid, v: true });
    t.objectStore('kv').put({ k: 'lastCharId', v: cid });
    t.oncomplete = res;
  });
  db.close();
}, CID);
await page.reload({ waitUntil:'networkidle0' }); await sleep(1400);
await page.evaluate((cid) => {
  const c = [...document.querySelectorAll('#char-list .char-card')].find(x => x.dataset && x.dataset.id === cid)
    || [...document.querySelectorAll('#char-list .char-card')].find(x => x.textContent.includes('连写测'));
  if (c) c.click();
}, CID);
await sleep(900);

const PLOT = '她开始起疑心';
console.log('=== 挂上剧情方向，开自动连写 3 段 ===');
await page.evaluate((plot) => {
  const i = document.getElementById('input');
  i.value = '/向 ' + plot;
  i.dispatchEvent(new Event('input', { bubbles: true }));
}, PLOT);
await sleep(200);
await page.evaluate(() => document.getElementById('btn-send').click());

// 等它自己写完 3 段（每段之间有 2500ms 的排程间隔）。
// 判据不是"数到 3 就停"，而是"等到不再有新请求"—— 只有一次重写就会把计数冲高。
await waitIdle(page, 8000, 60000);
let last = -1, stableAt = Date.now(), reqN = 0;
for (let i = 0; i < 80; i++) {
  await sleep(500);
  reqN = await page.evaluate(() => window.__reqAll.length);
  if (reqN !== last) { last = reqN; stableAt = Date.now(); }
  else if (reqN >= 1 && Date.now() - stableAt > 4000) break;
}

const info = await page.evaluate(() => {
  const gens = window.__reqAll.filter(x => x.body && x.body.stream !== false)
    .map(x => ({ at: x.at, text: JSON.stringify(x.body.messages || []) }));
  return { genCount: gens.length, gens };
});
console.log('   生成请求数 = ' + info.genCount);

// 段 = 相邻时间差超过 2000ms（排程间隔是 2500ms，足够分开）
const groups = [];
for (const g of info.gens) {
  const cur = groups[groups.length - 1];
  if (!cur || g.at - cur[cur.length - 1].at > 2000) groups.push([g]);
  else cur.push(g);
}
console.log('   按时间分出来的段数 = ' + groups.length);

t('自动连写真的跑了 3 段', groups.length === 3, '分到 ' + groups.length + ' 段 / 生成请求 ' + info.genCount);
// ⚠️ 判据必须是【段落标题】，不能只看方向原文：
//    '/向 xxx' 会把 xxx 存成那条用户消息的正文（visibleText = 命令参数），
//    于是后面每一段的历史里都有这段文字 —— 只看原文的话，
//    哪怕方向彻底没注入，第 2 段也会假阳性通过。
//    '# 这一轮的剧情方向' 只在真正挂了方向时才出现（persona.js 那一段的标题）。
const withPlot = groups.map(gr => gr.some(g => g.text.includes('# 这一轮的剧情方向') && g.text.includes(PLOT)));
t('★ 第 1 段带着剧情方向', withPlot[0] === true);
t('★ 第 2 段也带着剧情方向（0.5.7.2 修的就是这条）', withPlot[1] === true);
t('★ 第 3 段也带着剧情方向', withPlot[2] === true);
if (withPlot.some(x => !x)) console.log('   方向注入情况: ' + JSON.stringify(withPlot));

// 第 3 段能不能看见第 1 段写的东西 —— 这是 parentId 断链的直接后果。
// 断链时第 3 段的历史只剩它自己，提示词里不会有「这是第 1 段」。
const seg3 = groups[2] ? groups[2].map(g => g.text).join('\n') : '';
t('★ 第 3 段的提示词里能看见第 1 段写的内容（历史没断）',
  seg3.includes('这是第1段'), seg3.slice(0, 200));

console.log('');
console.log('=== 落库形状：parentId 与活动路径 ===');
const shape = await page.evaluate(async (cid) => {
  const req = indexedDB.open('ai-companion');
  const db = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
  const all = await new Promise((res) => {
    const r = db.transaction('messages','readonly').objectStore('messages').getAll();
    r.onsuccess = () => res(r.result || []);
  });
  const kv = await new Promise((res) => {
    const r = db.transaction('kv','readonly').objectStore('kv').get('branch:' + cid);
    r.onsuccess = () => res(r.result ? r.result.v : '');
  });
  db.close();
  const mine = all.filter(m => m.charId === cid).sort((a, b) => (a.ts || 0) - (b.ts || 0));
  const domN = document.querySelectorAll('#messages .msg').length;
  return {
    n: mine.length, domN, leaf: kv,
    rows: mine.map(m => ({ id: m.id, role: m.role, parent: typeof m.parentId === 'string' ? m.parentId : ('<' + typeof m.parentId + '>') })),
    emptyParent: mine.filter((m, i) => i > 0 && (typeof m.parentId !== 'string' || m.parentId === '')).length,
    dangling: mine.filter((m, i) => i > 0 && m.parentId && !mine.some(x => x.id === m.parentId)).length
  };
}, CID);
console.log('   库里 ' + shape.n + ' 条，屏幕上 ' + shape.domN + ' 条，叶子=' + shape.leaf);
console.log('   ' + shape.rows.map(r => r.role[0] + '(' + (r.parent || '根') + ')').join(' '));

t('★ 没有一条新消息挂在根上（parentId 都非空）', shape.emptyParent === 0, '空父指针 ' + shape.emptyParent + ' 条');
t('★ 没有一条父指针指向不存在的消息', shape.dangling === 0, '悬空 ' + shape.dangling + ' 条');
t('★ 屏幕上就是整条活动路径（没有消息被切走）', shape.domN === shape.n, '屏幕 ' + shape.domN + ' / 库 ' + shape.n);
t('叶子落在最后一条上', shape.leaf === (shape.rows[shape.rows.length - 1] || {}).id, String(shape.leaf));

console.log('');
console.log('JS 错误=' + JSON.stringify(errs.slice(0, 3)));
t('全程没有未捕获异常', errs.length === 0, JSON.stringify(errs.slice(0, 2)));

console.log('');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close();
site.close();
process.exit(fail ? 1 : 0);
