// e2e-prose.mjs —— 反复读检测（v0.5.5）
//
// 覆盖：
//   1. grams4 / repeatRate 的基本行为（纯函数，直接 import）
//   2. 阈值 0.45 落在自然分布之外
//   3. 生成结果跟历史撞车 → 消息上记下 rep，气泡挂「复读」角标
//   4. 下一轮的提示词里出现「这一轮要避开的东西」
//   5. 没撞车的普通消息不写 rep 字段
//   6. 无 pageerror

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

// ---------- 1/2. 纯函数 ----------
const { grams4, repeatRate, REPEAT_WARN } = await import('file:///' + WWW + '/js/prose.js');
console.log('');
console.log('=== 1. grams4 / repeatRate ===');
const A = '她把毛巾往椅背上一搭，没说话，只是低头看了一眼窗台上那盆快枯的薄荷。';
const B = '他把伞收起来靠在门边，抖了两下，水珠溅在她手背上。';
t('同一句自比 = 1', repeatRate(A, [A]) === 1, String(repeatRate(A, [A])));
t('★ 两句不相干的话重合 < 0.45', repeatRate(A, [B]) < REPEAT_WARN, String(repeatRate(A, [B])));
t('太短的（不到 8 个 gram）不算复读', repeatRate('嗯。', ['嗯。']) === 0, String(repeatRate('嗯。', ['嗯。'])));
t('标点不同不算差别', repeatRate(A, [A.replace(/[，。]/g, ' ')]) === 1, String(repeatRate(A, [A.replace(/[，。]/g, ' ')])));
t('空输入不炸', repeatRate('', []) === 0 && repeatRate(null, null) === 0, '');

console.log('');
console.log('=== 2. 阈值确实在自然分布之外 ===');
t('★ 阈值 0.45', REPEAT_WARN === 0.45, String(REPEAT_WARN));
const sample = [
  '雨还在下，她把窗子推开一条缝，冷气立刻钻进来。',
  '她伸手把窗关回去，说了一句"凉"。',
  '屋子里安静了一会儿，只有水壶在响。',
];
t('三句正常的连贯对话互相之间都不算复读',
  sample.every(x => repeatRate(x, sample.filter(y => y !== x)) < REPEAT_WARN),
  sample.map(x => repeatRate(x, sample.filter(y => y !== x)).toFixed(2)).join(','));

// ---------- 3~5. 端到端 ----------
await page.evaluateOnNewDocument(() => {
  window.__hits = { chat: [] };
  window.__reply = '';
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
        chunk({ choices: [{ delta: { content: String(window.__reply || '哦。') } }] }) +
        chunk({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 5 } }) +
        'data: [DONE]' + String.fromCharCode(10,10);
      return new Response(payload, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    return realFetch(url, opts);
  };
});

const CID = 'pr1';
const T0 = 1790000000000;
const REPEATED = '她把毛巾往椅背上一搭，没说话，只是低头看了一眼窗台上那盆快枯的薄荷。';
const OTHER = '他把伞收起来靠在门边，抖了两下，水珠溅在她手背上，凉得她缩了一下手。';

await page.goto('http://127.0.0.1:' + port + '/index.html', { waitUntil: 'networkidle0' });
await sleep(500);
await page.evaluate(async (v) => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const put = (store, rec) => new Promise(r => { const tx = db.transaction(store,'readwrite'); tx.objectStore(store).put(rec); tx.oncomplete = r; });
  const del = (store) => new Promise(r => { const tx = db.transaction(store,'readwrite'); tx.objectStore(store).clear(); tx.oncomplete = r; });
  for (const s2 of ['characters','messages']) await del(s2);
  await put('kv', { k: 'settings', v: { apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', clockMode: false, historyTime: false } });
  await put('kv', { k: 'lastCharId', v: v.cid });
  await put('kv', { k: 'greeted:' + v.cid, v: true });
  await put('characters', {
    id: v.cid, name: '蓝白', greeting: '', persona: '你是蓝白。', avatar: null,
    temperature: 1.0, maxTokens: 2048, topP: 1.0, reasoningEffort: 'low', contextRounds: 20,
    kaomojiFreq: 0, emojiFreq: 0, verbosity: 'medium', splitMessages: false, typingDelay: 0,
    hesitation: false, showTyping: true, longMemory: false, allowEditMine: false,
    descLevel: 'low', povLock: false, appearance: '', appearanceOn: true, presetKey: 'blank',
    createdAt: v.t0
  });
  await put('messages', { id: 'h1', charId: v.cid, role: 'user', content: '回来了。', ts: v.t0 + 1000 });
  await put('messages', { id: 'h2', charId: v.cid, role: 'assistant', content: v.rep, ts: v.t0 + 2000 });
  await put('messages', { id: 'h3', charId: v.cid, role: 'user', content: '你刚才说什么？', ts: v.t0 + 3000 });
  db.close();
}, { cid: CID, t0: T0, rep: REPEATED });
await page.goto('http://127.0.0.1:' + port + '/index.html', { waitUntil: 'networkidle0' });
await sleep(1200);

const sendOne = async (reply) => {
  await page.evaluate((r) => { window.__reply = r; }, reply);
  await page.evaluate(() => { const i = document.getElementById('input'); i.value = ''; });
  await page.type('#input', '嗯。');
  const before = await page.evaluate(() => window.__hits.chat.length);
  await page.evaluate(() => document.getElementById('btn-send').click());
  for (let i = 0; i < 120; i++) {
    const n = await page.evaluate(() => window.__hits.chat.length);
    if (n > before) {
      await page.waitForFunction(() => !document.getElementById('btn-send').classList.contains('hidden'), { timeout: 15000 }).catch(()=>{});
      await sleep(400);
      return await page.evaluate(() => window.__hits.chat[window.__hits.chat.length - 1]);
    }
    await sleep(100);
  }
  console.log('   DBG 没发出请求：hits=' + (await page.evaluate(() => window.__hits.chat.length)) + ' toast=' + (await page.evaluate(() => { const t = document.querySelector('.toast'); return t ? t.textContent : '(无)'; })) + ' msgs=' + (await page.evaluate(() => document.querySelectorAll('#messages .msg').length)));
  return null;
};
const dbg = async () => await page.evaluate(async (cid) => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const all = await new Promise(r => { const q = db.transaction('messages').objectStore('messages').getAll(); q.onsuccess = () => r(q.result || []); });
  db.close();
  const ai = all.filter(m => m.charId === cid && m.role === 'assistant').sort((a,b) => a.ts - b.ts);
  return ai.map(m => ({ id: m.id, rep: m.rep === undefined ? null : m.rep, repId: m.repId || null, text: String(m.content || '').slice(0, 20) }));
}, CID);

console.log('');
console.log('=== 3. 撞车的那一条被记下来 ===');
const r1 = await sendOne(REPEATED);
t('第一轮真的发出去了', !!r1, '');
await sleep(600);
const d1 = await dbg();
const last1 = d1[d1.length - 1] || {};
t('★ 新的那条跟历史撞车，记了 rep', last1.rep !== null && last1.rep >= REPEAT_WARN, JSON.stringify(last1));
t('记下了跟哪条像（repId）', !!last1.repId, String(last1.repId));
const chip1 = await page.evaluate(() => document.querySelectorAll('#messages .rep-chip').length);
t('★ 气泡上挂了「复读」角标', chip1 >= 1, '角标 ' + chip1 + ' 个');

console.log('');
console.log('=== 4. 下一轮的提示词里出现提醒 ===');
const r2 = await sendOne(OTHER);
t('第二轮真的发出去了', !!r2, '');
const sys2 = JSON.stringify(r2 || {});
t('★ 提示词里有「这一轮要避开的东西」', sys2.includes('这一轮要避开的东西'), '');
t('提醒里带了具体重合率', /字面重合 \d+%/.test(sys2), '');
const d2 = await dbg();
const last2 = d2[d2.length - 1] || {};
t('★ 没撞车的那条不写 rep 字段', last2.rep === null, JSON.stringify(last2));

console.log('');
console.log('=== 5. 没有未捕获错误 ===');
t('无 pageerror', errs.length === 0, errs.join(' | '));

console.log('');
console.log('========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close();
server.close();
process.exit(fail > 0 ? 1 : 0);
