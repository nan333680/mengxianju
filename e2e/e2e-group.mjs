// e2e-group.mjs — 群聊（v0.4.0）
//
// 设计取舍见 app.js 里那段注释：群聊不是平行数据通路，它就是一个
// "成员是一组人的角色"（characters 表里一条 isGroup:true 的记录）。
// 所以这一套要验的正是【复用了主流程之后还对不对】：
//   · 群里发言要记名（不记的话重开 App 谁说的就分不清了）
//   · 轮流要真的轮（推轮次必须在落库之后）
//   · 提示词里要写清"这一轮只有谁说话"
//   · 世界书要并上成员各自的（不然一进群集体失忆）
//   · 点名要真的能点
import puppeteer from 'puppeteer-core';
import {seedChars } from './e2e-helper.mjs';
import http from 'http'; import fs from 'fs'; import path from 'path';
import { readCode } from './e2e-src.mjs';
const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');
const WWW = R + '/www';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8' };
let pass = 0, fail = 0;
const t = (n, ok, ex) => { if (ok) { pass++; console.log('  OK   ' + n); } else { fail++; console.log('  FAIL ' + n + (ex !== undefined ? '  -> ' + JSON.stringify(ex) : '')); } };
const SRC = readCode(WWW + '/js/app.js');

console.log('=== 1. 源码：群聊的几条关键约定还在 ===');
t('群 = 带 isGroup + memberIds 的角色', SRC.includes('function isGroup(c)'));
t('群的人设是从成员拼出来的（buildStablePrompt 一行没改）', SRC.includes('function composeGroupPersona'));
// ⚠️ 断言改成【比顺序】而不是【比字面】（v0.4.1）：
//    原来写的是 SRC.includes('if (speaker) await advanceGroupTurn(myChar, speaker);') ——
//    那是在断言"这行代码长这样"，句子一改就假红，而它真正想守的是【先后顺序】。
t('推轮次在落库之后（先推会"有人被跳过"）',
  SRC.indexOf('await advanceGroupTurn(myChar, adv)') > SRC.indexOf('await msgs.add(am)'),
  { add: SRC.indexOf('await msgs.add(am)'), adv: SRC.indexOf('await advanceGroupTurn(myChar, adv)') });
t('说话的人记在消息上（每一段按自己的说话人记）',
  SRC.includes('if (piece.speakerId) am.speakerId = piece.speakerId;'));
t('世界书并上成员的', SRC.includes('function wbEffectiveIds'));
t('选成员时不会把"群"选进来（群不是人）', SRC.includes('excludeGroups'));
t('正则预览只要最近 30 条，不读全量', SRC.includes('msgs.list(curCharId, 30, true)'));

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
let lastReq = null;   // 最近一次发给模型的消息数组（要看提示词里写了什么）
await page.setRequestInterception(true);
page.on('request', req => {
  const u = req.url();
  if (u.includes('/chat/completions')) {
    if (req.method() === 'OPTIONS') {
      req.respond({ status: 204, headers: { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Headers':'*', 'Access-Control-Allow-Methods':'*' } }); return;
    }
    let _b = null; try { _b = JSON.parse(req.postData() || '{}'); } catch { _b = null; }
    // 活人感 v2：独白/判断/评审是非流式辅助请求，不是「这一轮发给模型的正文」——
    // 既不该记录进 lastReq（提示词断言全靠它），也不该用 SSE 回它。
    if (_b && _b.stream === false) {
      return req.respond({ status: 200, headers: { 'Access-Control-Allow-Origin':'*' }, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: '{}' } }] }) });
    }
    lastReq = _b;
    const NL = String.fromCharCode(10);
    const payload = 'data: ' + JSON.stringify({ choices: [{ delta: { content: '嗯。' } }] }) + NL + NL + 'data: [DONE]' + NL + NL;
    req.respond({ status: 200, headers: { 'Access-Control-Allow-Origin':'*' }, contentType: 'text/event-stream', body: payload }); return;
  }
  req.continue();
});
await page.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'networkidle0', timeout: 40000 });
await sleep(1200);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil: 'networkidle0' }); await sleep(1000);

console.log('=== 2. 三个人 + 一个群 ===');
const seeded = await seedChars(page, [
  { name: '甲', greeting: '（甲在）', id: 'ga' },
  { name: '乙', greeting: '（乙在）', id: 'gb' },
  { name: '丙', greeting: '（丙在）', id: 'gc' },
]);
t('三个角色种好了', seeded.length === 3, seeded);
const GID = 'ggrp1';
await page.evaluate(async (gid) => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const put = (st, rec) => new Promise(r => { const tx = db.transaction(st, 'readwrite'); tx.objectStore(st).put(rec); tx.oncomplete = r; });
  const rec = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get('settings'); q.onsuccess = () => r(q.result); });
  await put('kv', { k: 'settings', v: Object.assign({}, (rec && rec.v) || {}, {
    apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com', longMemory: false, worldbookOn: true }) });
  // 群：成员顺序 甲 → 乙 → 丙
  await put('characters', {
    id: gid, name: '周末茶会', isGroup: true, memberIds: ['ga', 'gb', 'gc'], groupNote: '每周六下午在她家。',
    speakMode: 'round', turnIndex: 0, avatar: null, greeting: '（三个人都在。）',
    presetKey: 'blank', createdAt: Date.now(),
  });
  // ⚠️ 世界书挂在【乙】名下（不在群名下）—— 这正是要验的：群要并上成员的。
  await put('wbSolo', { id: 'wbg1', charId: 'gb', entries: [
    { id: 'wbe1', title: '乙的秘密', keys: [], content: '乙养了一只叫团子的猫。', on: true, pos: 'always' },
  ] });
  db.close();
}, GID);
await page.reload({ waitUntil: 'networkidle0' }); await sleep(1200);

console.log('=== 3. 角色列表里认得出这是个群 ===');
const list = await page.evaluate(() => [...document.querySelectorAll('#char-list .char-card')].map(el => ({
  name: el.querySelector('b').textContent.trim(),
  sub: el.querySelector('small').textContent.trim(),
  grp: el.classList.contains('grp'),
})));
console.log('   ' + JSON.stringify(list));
const gcard = list.find(x => x.name.startsWith('周末茶会'));
t('群显示在同一个列表里', !!gcard, list.map(x => x.name));
t('带「群聊」标记', !!gcard && gcard.grp === true && gcard.name.includes('群聊'), gcard);
t('副标题写清几个人、都有谁', !!gcard && gcard.sub.includes('3 个人') && gcard.sub.includes('甲') && gcard.sub.includes('丙'), gcard && gcard.sub);

console.log('=== 4. 进群：在场名单 + 第一个是甲 ===');
await page.evaluate((gid) => {
  const el = [...document.querySelectorAll('#char-list .char-card')].find(x => x.dataset.id === gid);
  el.click();
}, GID);
await sleep(1400);
let roster = await page.evaluate(() => ({
  hidden: document.querySelector('#group-roster').classList.contains('hidden'),
  chips: [...document.querySelectorAll('#group-roster .gr-chip')].map(x => ({ n: x.textContent.trim(), on: x.classList.contains('on') })),
  view: (document.querySelector('.view.active') || {}).id,
}));
console.log('   ' + JSON.stringify(roster));
t('进了聊天页', roster.view === 'view-chat', roster.view);
t('在场名单出来了（不是 hidden）', roster.hidden === false);
t('三个人都在', roster.chips.length === 3, roster.chips);
t('高亮的是甲（轮次的第一个人）', roster.chips[0] && roster.chips[0].on === true && roster.chips[0].n === '甲', roster.chips);

console.log('=== 5. 第一轮：甲说，而且提示词里写明了"只有甲" ===');
const send = async (text) => {
  await page.evaluate(x => { const el = document.getElementById('input'); el.value = x; el.dispatchEvent(new Event('input', { bubbles: true })); }, text);
  await sleep(150);
  await page.evaluate(() => document.getElementById('btn-send').click());
  for (let i = 0; i < 60; i++) { await sleep(300); const busy = await page.$eval('#btn-stop', e => !e.classList.contains('hidden')).catch(() => false); if (!busy) break; }
  await sleep(900);
};
await send('大家都在吗');
const sysAll = (lastReq && lastReq.messages ? lastReq.messages : []).map(m => String(m.content || '')).join('\n');
t('提示词里点名了这一轮演谁', sysAll.includes('你现在是「甲」'), sysAll.slice(-400));
t('并且解释了历史里【名字】前缀是什么意思', sysAll.includes('标的是'), '');
t('提示词里带了群的人设（名单 + 每人的设定）', sysAll.includes('在场的有') && sysAll.includes('甲：'), sysAll.slice(0, 300));
t('提示词里并上了【乙】名下的常驻世界书（群要并成员的）', sysAll.includes('乙养了一只叫团子的猫'), '');
const afterOne = await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const all = await new Promise(r => { const q = db.transaction('messages').objectStore('messages').getAll(); q.onsuccess = () => r(q.result); });
  const g = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').get('ggrp1'); q.onsuccess = () => r(q.result); });
  db.close();
  return { last: all.filter(m => m.charId === 'ggrp1').slice(-1)[0] || null, turnIndex: g && g.turnIndex };
});
t('回复落在【群】名下（不是某个成员名下）', !!afterOne.last && afterOne.last.charId === 'ggrp1', afterOne.last);
t('这条记了是谁说的（speakerId = 甲）', !!afterOne.last && afterOne.last.speakerId === 'ga', afterOne.last && afterOne.last.speakerId);
t('轮次推到了下一个（turnIndex = 1）', afterOne.turnIndex === 1, afterOne.turnIndex);

console.log('=== 6. 第二轮轮到乙，第三轮丙，第四轮绕回甲 ===');
await send('乙你说呢');
let l2 = await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const all = await new Promise(r => { const q = db.transaction('messages').objectStore('messages').getAll(); q.onsuccess = () => r(q.result); });
  const g = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').get('ggrp1'); q.onsuccess = () => r(q.result); });
  db.close();
  return { last: all.filter(m => m.charId === 'ggrp1' && m.role === 'assistant').slice(-1)[0], turnIndex: g && g.turnIndex };
});
t('第二轮是乙说的', l2.last && l2.last.speakerId === 'gb', l2.last && l2.last.speakerId);
t('轮次到 2', l2.turnIndex === 2, l2.turnIndex);
await send('丙呢');
await send('再来一轮');
const l4 = await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const all = await new Promise(r => { const q = db.transaction('messages').objectStore('messages').getAll(); q.onsuccess = () => r(q.result); });
  const g = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').get('ggrp1'); q.onsuccess = () => r(q.result); });
  db.close();
  // ⚠️ getAll 是按【主键（id）】顺序返回的，不是时间！拿它当"最后一条"就是掷骰子。
  const mine = all.filter(m => m.charId === 'ggrp1').sort((a, b) => (a.ts || 0) - (b.ts || 0));
  // 开场白那条没有 speakerId（它不是谁"说"的），所以从第 2 条回复开始看
  const spk = mine.filter(m => m.role === 'assistant').map(m => m.speakerId || null).slice(1);
  return { spk, turnIndex: g && g.turnIndex };
});
console.log('   ' + JSON.stringify(l4));
t('三个人轮流说，第四个绕回甲', JSON.stringify(l4.spk) === JSON.stringify(['ga', 'gb', 'gc', 'ga']), l4.spk);

console.log('=== 7. 点名：@谁 谁答（不管轮次）===');
await send('@丙 你说说看');
const l5 = await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const all = await new Promise(r => { const q = db.transaction('messages').objectStore('messages').getAll(); q.onsuccess = () => r(q.result); });
  db.close();
  return all.filter(m => m.charId === 'ggrp1' && m.role === 'assistant').slice(-1)[0];
});
t('点名丙，就是丙答（轮次本来该到乙）', l5 && l5.speakerId === 'gc', l5 && l5.speakerId);

console.log('=== 8. 界面上气泡分得清谁在说 ===');
const bubbles = await page.evaluate(() => [...document.querySelectorAll('#messages .msg.ai .who')].map(x => x.textContent.trim()));
console.log('   ' + JSON.stringify(bubbles));
t('每条回复顶上都有说话人的名字', bubbles.length >= 5 && bubbles.every(Boolean), bubbles);
t('名字不是清一色同一个人', new Set(bubbles).size >= 3, bubbles);
const rosterAfter = await page.evaluate(() => [...document.querySelectorAll('#group-roster .gr-chip.on')].map(x => x.textContent.trim()));
t('顶部高亮跟着走到下一个', rosterAfter.length === 1, rosterAfter);

console.log('=== 9. 单聊不受影响 ===');
await page.evaluate(() => document.getElementById('btn-chars').click());
await sleep(800);
await page.evaluate(() => {
  const el = [...document.querySelectorAll('#char-list .char-card')].find(x => x.dataset.id === 'ga');
  el.click();
}, null);
await sleep(1200);
const solo = await page.evaluate(() => ({
  hidden: document.querySelector('#group-roster').classList.contains('hidden'),
  whos: document.querySelectorAll('#messages .who').length,
}));
t('单聊里在场名单是收起来的', solo.hidden === true, solo);
t('单聊气泡上没有"谁说的"（不需要）', solo.whos === 0, solo.whos);

console.log('');
console.log('JS 错误: ' + (errs.length ? errs.join(' | ') : '无'));
t('无 JS 报错', errs.length === 0, errs.join(' | '));
console.log('');
console.log('通过 ' + pass + ' / 失败 ' + fail);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
