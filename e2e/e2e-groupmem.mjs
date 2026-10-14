// e2e-groupmem.mjs — 群的长期记忆「按人分视角」（v0.4.1.4）
//
// 用户的例子：「文文记住了芙兰对他的好感太明显了；芙兰觉得文文比自己会照顾人」。
// 这两句其实是两种东西：
//   · "芙兰对他的好感太明显了" = 观察积累出的【事件/事实】→ 长期记忆，但要记住【是谁看到的】
//   · "芙兰比自己会照顾人"     = 稳定的【看法】→ 二级页的「她怎么看群里这些人」（另一套测）
// 群的记忆原来全群共用一份、连主语都没有（标题写死"你记得关于他的事"），
// 于是甲私下的事会被读成"大家都知道" —— 把甲的私事塞进乙的嘴里，比"她不知道"更糟。
//
// 这套钉住四件事：
//   ① 总结出来的记忆【就近归属】到说话人（不让模型自己填 who，它会把人名写错）
//   ② 判断不了的落成全群共识（who 为空）
//   ③ 注入时只带【她自己】+【全群共识】，别人视角的不进来
//   ④ 老备份里的记忆没有 who → 一律当共识（导入兼容）
import puppeteer from 'puppeteer-core';
import {seedChars } from './e2e-helper.mjs';
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
// ⚠️ CI 的 runner 是 en-US，而界面语言默认「跟随系统」。钉成中文，否则英文界面下
//    断言中文文案的地方都会红（界面翻译补完之后尤其明显，v0.4.2）。
//    用 defineProperty 而不是改库：不用等 reload、也不动 DOM，跟断言不抢。
//    configurable: true 是为了能和预检工具自己的伪装共存。
await page.evaluateOnNewDocument(() => {
  Object.defineProperty(navigator, 'language', { get: () => 'zh-CN', configurable: true });
  Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh'], configurable: true });
});


await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = []; page.on('pageerror', e => errs.push(e.message));
const sleep = ms => new Promise(r => setTimeout(r, ms));
// 总结那条路要的是 JSON，聊天那条要 SSE
let memBurst = 0;
const MEM_JSON = JSON.stringify([
  { text: '芙兰对他的好感太明显了', kind: 'fact', untilDay: null, freq: 'often' },
  { text: '上周六在她家喝茶', kind: 'event', untilDay: null, freq: 'once' },
]);
let chatReq = null, chatN = 0;
await page.setRequestInterception(true);
page.on('request', req => {
  if (req.url().includes('/chat/completions')) {
    if (req.method() === 'OPTIONS') { req.respond({ status: 204, headers: { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Headers':'*', 'Access-Control-Allow-Methods':'*' } }); return; }
    let body = {}; try { body = JSON.parse(req.postData() || '{}'); } catch (e) { /* ignore */ }
    if (body.stream) {
      chatReq = body; chatN++;
      const chunk = JSON.stringify({ choices: [{ delta: { content: '【甲】嗯。' } }] });
      req.respond({ status: 200, headers: { 'Access-Control-Allow-Origin':'*' }, contentType: 'text/event-stream',
        body: 'data: ' + chunk + NL + NL + 'data: [DONE]' + NL + NL }); return;
    }
    req.respond({ status: 200, headers: { 'Access-Control-Allow-Origin':'*' }, contentType: 'application/json',
      body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: (memBurst++ === 0 ? MEM_JSON : '[]') } }] }) }); return;
  }
  req.continue();
});
const memAll = () => page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const all = await new Promise(r => { const q = db.transaction('memories').objectStore('memories').getAll(); q.onsuccess = () => r(q.result); });
  db.close();
  return all.map(m => ({ text: m.text, who: m.who || '', charId: m.charId }));
});
const sysOf = () => ((chatReq && chatReq.messages) || []).filter(m => m.role === 'system').map(m => String(m.content || '')).join('\n@@\n');
const once = async (s) => {
  await page.evaluate(x => { const el = document.getElementById('input'); el.value = x; el.dispatchEvent(new Event('input', { bubbles: true })); }, s);
  await sleep(150);
  await page.evaluate(() => document.getElementById('btn-send').click());
  for (let i = 0; i < 100; i++) { await sleep(300); const b = await page.$eval('#btn-stop', e => !e.classList.contains('hidden')).catch(() => false); if (!b) break; }
  await sleep(600);
};
// ⚠️ 记忆任务在跑的时候 send 会被拦下来（"她还在整理记忆…"）—— 第一版没重试，
//    第二次发消息压根没发出去，断言读到的是一份空提示词。
const send = async (s) => {
  for (let k = 0; k < 8; k++) {
    const before = chatN;
    await once(s);
    if (chatN > before) return true;
    await sleep(3000);
  }
  return false;
};
const waitMem = async (n) => { for (let i = 0; i < 60; i++) { const a = await memAll(); if (a.length >= n) return a; await sleep(500); } return await memAll(); };

await page.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'networkidle0', timeout: 40000 });
await sleep(1200);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil: 'networkidle0' }); await sleep(600);
await seedChars(page, [{ name: '甲', id: 'ga' }, { name: '乙', id: 'gb' }, { name: '单聊她', id: 'gsolo' }]);
await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const put = (st, rec) => new Promise(r => { const tx = db.transaction(st, 'readwrite'); tx.objectStore(st).put(rec); tx.oncomplete = r; });
  const rec = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get('settings'); q.onsuccess = () => r(q.result); });
  await put('kv', { k: 'settings', v: Object.assign({}, (rec && rec.v) || {}, {
    apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com', longMemory: true,
    memSummarizeEvery: 4, memLimit: 40 }) });
  await put('characters', { id: 'ggrp1', name: '周末茶会', isGroup: true, memberIds: ['ga','gb'],
    groupNote: '', speakMode: 'round', turnIndex: 0, avatar: null, greeting: '（两个人都在。）',
    presetKey: 'blank', createdAt: Date.now(), longMemory: true });
  // 两个人各说了一句，内容刻意差得远 —— 用来验"就近归属"
  // ⚠️ 总结的取样窗口是 pending.slice(0, backlog - 20) ——
  //    它【故意留最近 20 条不总结】（还在用的上下文不必急着提炼）。
  //    所以特征句必须落在最老那一批里，总数也得超过 20，否则 chunk 是空的、
  //    连一次 API 都不会发（第一版就是只种了 4 条，四条断言全空）。
  const base = Date.now() - 3600000;
  await put('messages', { id: 'm1', charId: 'ggrp1', role: 'user', content: '你们在聊什么', ts: base });
  await put('messages', { id: 'm2', charId: 'ggrp1', role: 'assistant', speakerId: 'ga',
    content: '芙兰对他的好感太明显了，谁都看得出来。', ts: base + 1000 });
  await put('messages', { id: 'm3', charId: 'ggrp1', role: 'assistant', speakerId: 'gb',
    content: '外面的雨下得很大，我不想出门。', ts: base + 2000 });
  for (let i = 4; i <= 30; i++) {
    const isUser = i % 2 === 0;
    await put('messages', { id: 'm' + i, charId: 'ggrp1', role: isUser ? 'user' : 'assistant',
      speakerId: isUser ? undefined : (i % 4 === 1 ? 'ga' : 'gb'),
      content: isUser ? ('闲聊第' + i + '句') : ('无关的第' + i + '句话，天气不错。'), ts: base + i * 1000 });
  }
  db.close();
});
await page.reload({ waitUntil: 'networkidle0' }); await sleep(1200);
await page.evaluate(() => { [...document.querySelectorAll('#char-list .char-card')].find(x => x.dataset.id === 'ggrp1').click(); });
await sleep(1400);

console.log('=== 1. 总结出来的记忆，按发言人就近归属 ===');
await send('@甲 你刚才说什么');
let mems = await waitMem(2);
t('记忆写进了库（两条）', mems.length >= 2, mems);
const m1 = mems.find(m => m.text.indexOf('芙兰对他的好感太明显了') >= 0);
const m2 = mems.find(m => m.text.indexOf('上周六在她家喝茶') >= 0);
t('这句归档到甲名下（who = ga）', !!m1 && m1.who === 'ga', m1);
t('跟谁都不像的那句落成全群共识（who 为空）', !!m2 && m2.who === '', m2);
t('两条都挂在群 id 下', !!m1 && m1.charId === 'ggrp1', m1 && m1.charId);

console.log('=== 2. 注入：只带她自己的 + 全群共识 ===');
chatReq = null;
await send('@甲 再说说');
let sys = sysOf();
t('标题点明了这是【甲】记得的', sys.indexOf('你（甲）自己看在眼里的事') >= 0, sys.slice(0, 60));
t('甲自己那条带上了', sys.indexOf('芙兰对他的好感太明显了') >= 0, '');
t('共识那条也带上了', sys.indexOf('上周六在她家喝茶') >= 0, '');
t('共识有单独一段小标题', sys.indexOf('这个群里大家都知道的事') >= 0, '');

chatReq = null;
await send('@乙 你说呢');
sys = sysOf();
// ⚠️ 乙自己一条记忆都没有 —— 所以【不该】出现"她自己看在眼里的事"那一段，
//    只剩全群共识。第一版这里断言"标题里要有乙"，是把设计写反了。
t('乙没有自己的记忆时，不出现「她自己看在眼里的事」那一段', sys.indexOf('自己看在眼里的事') < 0, '');
t('甲视角那条【不进】乙的上下文', sys.indexOf('芙兰对他的好感太明显了') < 0, '');
t('共识那条仍然在', sys.indexOf('上周六在她家喝茶') >= 0, '');

console.log('=== 3. 老数据兼容：没有 who 的记忆 = 全群共识 ===');
await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  await new Promise(r => { const tx = db.transaction('memories', 'readwrite');
    tx.objectStore('memories').put({ id: 'old1', charId: 'ggrp1', text: '三个人认识很多年了。', kind: 'fact', ts: Date.now() }); tx.oncomplete = r; });
  db.close();
});
chatReq = null;
await send('@乙 再说一句');
sys = sysOf();
t('老记忆（没有 who）当共识注入', sys.indexOf('三个人认识很多年了。') >= 0, '');
t('它出现在「大家都知道的事」那一段', (function () {
  const i = sys.indexOf('这个群里大家都知道的事');
  const j = sys.indexOf('三个人认识很多年了。');
  return i >= 0 && j > i;
})(), '');

console.log('=== 4. 单聊一点没变（记忆全是共识，走老标题） ===');
await page.evaluate(() => { [...document.querySelectorAll('#drawer-menu [data-wb-drawer]')]; });
await page.evaluate(() => document.getElementById('btn-chars').click());
await sleep(700);
await page.evaluate(() => { [...document.querySelectorAll('#char-list .char-card')].find(x => x.dataset.id === 'gsolo').click(); });
await sleep(1200);
chatReq = null;
await send('在吗');
sys = sysOf();
t('单聊还是老标题「你记得关于他的事」或压根没有记忆段', sys.indexOf('你记得关于他的事') >= 0 || sys.indexOf('你自己看在眼里的事') < 0, sys.slice(0, 80));
t('单聊不出现群那两段小标题', sys.indexOf('这个群里大家都知道的事') < 0, '');

console.log('=== 5. 群设置页的「群记忆」入口 + 按「谁记得的」分组 ===');
await page.evaluate(() => document.getElementById('btn-chars').click());
await sleep(700);
await page.evaluate(() => { [...document.querySelectorAll('#char-list .char-card')].find(x => x.dataset.id === 'ggrp1').click(); });
await sleep(1200);
await page.evaluate(() => document.getElementById('chat-titletxt').click());
await sleep(800);
t('群设置页上有「群记忆」入口', await page.evaluate(() => !!document.getElementById('g-mem-open')), '');
// v0.4.1.6：群记忆不再"跳去全局设置"，就地开一个小窗口（用户原话：太笨了）
await page.evaluate(() => document.getElementById('g-mem-open').click());
await sleep(1200);
const memPanel = await page.evaluate(() => ({
  open: !document.getElementById('modal').classList.contains('hidden'),
  title: document.getElementById('modal-title').textContent,
  text: document.getElementById('modal-text').textContent,
}));
console.log('   ' + JSON.stringify({ title: memPanel.title }));
t('群记忆就地开小窗口（不跳全局设置）', memPanel.open === true && memPanel.title.includes('记忆'), memPanel.title);
t('里面按"谁的视角"分了组', memPanel.text.includes('记得的') && memPanel.text.includes('大家都知道'), '');
t('甲私下的那条看得见', memPanel.text.includes('芙兰对他的好感太明显了'), '');
t('还说明了"别人的私事她看不到"', memPanel.text.includes('别人的私事'), '');
await page.evaluate(() => document.getElementById('modal-cancel').click());
await sleep(500);
const memHtml = memPanel.text;
t('群那一组里有「甲」记得的', memHtml.indexOf('甲') >= 0 && memHtml.indexOf('记得的') >= 0, memHtml.slice(0, 100));
t('也有「大家都知道的事」', memHtml.indexOf('大家都知道的事') >= 0, '');
t('甲私下的那条在界面里看得到', memHtml.indexOf('芙兰对他的好感太明显了') >= 0, '');
t('没有页面报错', errs.length === 0, errs.slice(0, 3));

console.log('');
console.log('通过 ' + pass + ' / 失败 ' + fail);
await browser.close();
server.close();
process.exit(fail ? 1 : 0);
