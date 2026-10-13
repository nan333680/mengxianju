// e2e-groupspeak.mjs — 发言调度：概率 / 连发 / 冷场 / 自动续一幕（v0.4.1.4）
//
// 用户说的"固定轮次"其实是四件不同的事（复查清单 §8.1）：
//   ① 用户说完，谁先开口           → 概率（talk 权重）
//   ② 这一幕里有几个人开口          → 交给提示词 / 篇幅档位
//   ③ 一个人能不能连发几条          → 解析器早支持，但提示词写的是【反的】，两下抵消
//   ④ 用户不说话时会不会自己继续     → 自动续一幕（默认关，token 成倍）
//   ⑤ 会不会没人接话                → 允许冷场（默认关）
//「轮」本身去不掉：一轮 = 一次请求，这是物理事实。
import puppeteer from 'puppeteer-core';
import { seedChars } from './e2e-helper.mjs';
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
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 120000,
  args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = []; page.on('pageerror', e => errs.push(e.message));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let replyText = '嗯。';
let chatReq = null, chatN = 0;
await page.setRequestInterception(true);
page.on('request', req => {
  if (req.url().includes('/chat/completions')) {
    if (req.method() === 'OPTIONS') { req.respond({ status: 204, headers: { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Headers':'*', 'Access-Control-Allow-Methods':'*' } }); return; }
    let body = {}; try { body = JSON.parse(req.postData() || '{}'); } catch (e) { /* ignore */ }
    if (body.stream) {
      chatReq = body; chatN++;
      const chunk = JSON.stringify({ choices: [{ delta: { content: replyText } }] });
      req.respond({ status: 200, headers: { 'Access-Control-Allow-Origin':'*' }, contentType: 'text/event-stream',
        body: 'data: ' + chunk + NL + NL + 'data: [DONE]' + NL + NL }); return;
    }
    req.respond({ status: 200, headers: { 'Access-Control-Allow-Origin':'*' }, contentType: 'application/json',
      body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: '[]' } }] }) }); return;
  }
  req.continue();
});
const sysOf = (req) => ((req && req.messages) || []).filter(m => m.role === 'system').map(m => String(m.content || '')).join('\n@@\n');
const aiMsgs = () => page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const all = await new Promise(r => { const q = db.transaction('messages').objectStore('messages').getAll(); q.onsuccess = () => r(q.result); });
  db.close();
  return all.filter(m => m.charId === 'ggrp1' && m.role === 'assistant').sort((a, b) => (a.ts || 0) - (b.ts || 0))
    .map(m => ({ c: m.content, s: m.speakerId || null, n: m.narration === true }));
});
const setGroup = (patch) => page.evaluate(async (p) => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const g = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').get('ggrp1'); q.onsuccess = () => r(q.result); });
  Object.assign(g, p);
  await new Promise(r => { const tx = db.transaction('characters', 'readwrite'); tx.objectStore('characters').put(g); tx.oncomplete = r; });
  db.close();
}, patch);
const send = async (s) => {
  await page.evaluate(x => { const el = document.getElementById('input'); el.value = x; el.dispatchEvent(new Event('input', { bubbles: true })); }, s);
  await sleep(150);
  await page.evaluate(() => document.getElementById('btn-send').click());
  for (let i = 0; i < 100; i++) { await sleep(300); const b = await page.$eval('#btn-stop', e => !e.classList.contains('hidden')).catch(() => false); if (!b) break; }
  await sleep(900);
};

await page.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'networkidle0', timeout: 40000 });
await sleep(1200);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil: 'networkidle0' }); await sleep(600);
await seedChars(page, [{ name: '甲', id: 'ga' }, { name: '乙', id: 'gb' }, { name: '丙', id: 'gc' }]);
await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const put = (st, rec) => new Promise(r => { const tx = db.transaction(st, 'readwrite'); tx.objectStore(st).put(rec); tx.oncomplete = r; });
  const rec = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get('settings'); q.onsuccess = () => r(q.result); });
  await put('kv', { k: 'settings', v: Object.assign({}, (rec && rec.v) || {}, { apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com', longMemory: false }) });
  await put('characters', { id: 'ggrp1', name: '周末茶会', isGroup: true, memberIds: ['ga','gb','gc'],
    speakMode: 'round', turnIndex: 0, avatar: null, greeting: '（三个人都在。）', presetKey: 'blank', createdAt: Date.now() });
  db.close();
});
await page.reload({ waitUntil: 'networkidle0' }); await sleep(1200);
await page.evaluate(() => { [...document.querySelectorAll('#char-list .char-card')].find(x => x.dataset.id === 'ggrp1').click(); });
await sleep(1400);

// ⚠️ v0.4.1.6：这一幕几个人是【抽】的（1/2/3）。抽到 1 个人会换成"只写她一个人"
//    那套提示词，而这一套断言是冲着"小说式一幕"的措辞来的 —— 先把随机数压在
//    "2 个人"那一档让它可以复现。用带计数的小扰动，别用常数（uid 会撞车）。
await page.evaluate(() => { let n = 0; Math.random = () => { n++; return 0.45 + (n % 97) / 100000; }; });

console.log('=== 1. 一个人连发几条：提示词不再和解析器对着干 ===');
chatReq = null;
replyText = '【甲】我先去倒杯水。' + NL + '【甲】你要吗？';
await send('在吗');
let sys = sysOf(chatReq);
t('提示词里要它「一个人连着说几句就写几行」', sys.indexOf('同一个人连着说几句') >= 0, '');
t('删掉了原来那句反的（放在同一行里）', sys.indexOf('放在同一行里') < 0, '');
let ai = await aiMsgs();
const last2 = ai.slice(-2);
t('两条同名行 → 两个气泡，都挂在甲名下',
  last2.length === 2 && last2[0].s === 'ga' && last2[1].s === 'ga'
  && last2[0].c.indexOf('倒杯水') >= 0 && last2[1].c.indexOf('你要吗') >= 0,
  last2);

console.log('=== 2. 概率发言：谁开口由 talk 决定 ===');
await setGroup({ speakMode: 'weight', turnIndex: 0, lastSpeakerId: '',
  memberCfg: { ga: { talk: 100 }, gb: { talk: 0 }, gc: { talk: 0 } } });
await page.reload({ waitUntil: 'networkidle0' }); await sleep(1200);
await page.evaluate(() => { [...document.querySelectorAll('#char-list .char-card')].find(x => x.dataset.id === 'ggrp1').click(); });
await sleep(1300);
replyText = '嗯。';
let names = [];
for (let i = 0; i < 3; i++) {
  chatReq = null;
  await send('第' + (i + 1) + '句');
  const s = sysOf(chatReq);
  const mt = s.match(/你现在是「([^」]+)」/);
  names.push(mt ? mt[1] : '(没读到)');
}
t('甲权重 100、其他 0 → 三轮都是甲', names.join(',') === '甲,甲,甲', names);
await setGroup({ memberCfg: { ga: { talk: 0 }, gb: { talk: 100 }, gc: { talk: 0 } } });
await page.reload({ waitUntil: 'networkidle0' }); await sleep(1200);
await page.evaluate(() => { [...document.querySelectorAll('#char-list .char-card')].find(x => x.dataset.id === 'ggrp1').click(); });
await sleep(1300);
names = [];
for (let i = 0; i < 3; i++) {
  chatReq = null;
  await send('再第' + (i + 1) + '句');
  const s = sysOf(chatReq);
  const mt = s.match(/你现在是「([^」]+)」/);
  names.push(mt ? mt[1] : '(没读到)');
}
t('换成乙权重 100 → 三轮都是乙', names.join(',') === '乙,乙,乙', names);

console.log('=== 3. 允许冷场（默认关） ===');
await page.evaluate(() => document.getElementById('chat-titletxt').click());
await sleep(800);
t('界面上的开关默认不勾', await page.evaluate(() => document.getElementById('g-silence').checked === false), '');
t('自动续一幕默认 0', (await page.evaluate(() => document.getElementById('g-auto').value)) === '0', '');
// 随机数压到 0.01 以下（但保持各不相同，别把 uid 也压成同一个）
await page.evaluate(() => {
  window.__rnd = Math.random;
  let i = 0;
  Math.random = () => { i++; return (i % 991) / 100000; };
});
await setGroup({ speakMode: 'round', turnIndex: 0, allowSilence: true, memberCfg: {} });
await page.reload({ waitUntil: 'networkidle0' }); await sleep(1200);
await page.evaluate(() => { [...document.querySelectorAll('#char-list .char-card')].find(x => x.dataset.id === 'ggrp1').click(); });
await sleep(1300);
await page.evaluate(() => {
  let i = 0;
  Math.random = () => { i++; return (i % 991) / 100000; };
});
const nBefore = chatN;
await send('在吗');
const ai2 = await aiMsgs();
const silent = ai2.filter(m => m.c.indexOf('没人接话') >= 0);
t('产出了一条「（没人接话）」', silent.length === 1, ai2.slice(-2));
t('它是旁白（没有 speakerId）', !!silent[0] && silent[0].s === null && silent[0].n === true, silent[0]);
t('这一轮压根没调 API', chatN === nBefore, { before: nBefore, after: chatN });

console.log('=== 4. 点了名就不会冷场 ===');
const nBefore2 = chatN;
let tries = 0, dbgToast = '';
for (let k = 0; k < 4; k++) {
  tries++;
  await send('@甲 在吗');
  if (chatN > nBefore2) break;
  dbgToast = await page.evaluate(() => { const el = document.getElementById('toast'); return el ? el.textContent : ''; });
  await sleep(1500);
}
console.log('   DBG tries=', tries, 'toast=', dbgToast);
t('点名了照常请求', chatN > nBefore2, { before: nBefore2, after: chatN, tries: tries, toast: dbgToast });
await page.evaluate(() => { Math.random = window.__rnd; });

console.log('=== 5. 自动续一幕（默认关；开了才自己往下演） ===');
await page.reload({ waitUntil: 'networkidle0' }); await sleep(1200);
await page.evaluate(() => { [...document.querySelectorAll('#char-list .char-card')].find(x => x.dataset.id === 'ggrp1').click(); });
await sleep(1300);
await setGroup({ allowSilence: false, autoScene: 0, speakMode: 'round', turnIndex: 0 });
await page.reload({ waitUntil: 'networkidle0' }); await sleep(1200);
await page.evaluate(() => { [...document.querySelectorAll('#char-list .char-card')].find(x => x.dataset.id === 'ggrp1').click(); });
await sleep(1300);
let n0 = chatN;
await send('在吗');
const withZero = chatN - n0;
t('autoScene=0 时只请求一次', withZero === 1, withZero);
await setGroup({ autoScene: 1 });
await page.reload({ waitUntil: 'networkidle0' }); await sleep(1200);
await page.evaluate(() => { [...document.querySelectorAll('#char-list .char-card')].find(x => x.dataset.id === 'ggrp1').click(); });
await sleep(1300);
n0 = chatN;
await send('再说说');
await sleep(3000);
const withOne = chatN - n0;
t('autoScene=1 时自动再来一幕', withOne >= 2, withOne);
const ai3 = await aiMsgs();
t('两幕都落了库', ai3.length >= 3, ai3.length);
t('没有页面报错', errs.length === 0, errs.slice(0, 3));

console.log('');
console.log('通过 ' + pass + ' / 失败 ' + fail);
await browser.close();
server.close();
process.exit(fail ? 1 : 0);
