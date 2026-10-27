// live-group.mjs —— 真 key 验群聊 + v2 群聊 psyche（§4.7：每个发言人各存一份读数）
// （不进回归：文件名不是 e2e-*.mjs）
//
// 断言：
//   ① 群聊发一句，有人回（生成链路在群聊下也能走通 —— v2 的候选/评审/节奏都在里面）
//   ② 回了之后 kv 里有 'psyche:<群id>:<发言人id>'，且它不是串到别的成员名下
//   ③ 页内异常 0
// 用法：$env:DSH_API_KEY='...'; node e2e/live-group.mjs
import puppeteer from 'puppeteer-core';
import { waitIdle } from './e2e-helper.mjs';
import http from 'http';
import fs from 'fs';
import path from 'path';
const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');
const WWW = R + '/www';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const KEY = (process.env.DSH_API_KEY || '').trim();
if (!KEY || KEY.length < 20) { console.log('没有 DSH_API_KEY，退出'); process.exit(2); }
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const server = http.createServer((req, res) => {
  let q = decodeURIComponent(req.url.split('?')[0]); if (q === '/') q = '/index.html';
  const f = path.join(WWW, q);
  if (!fs.existsSync(f)) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(fs.readFileSync(f));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
const page = await browser.newPage();
await page.setCacheEnabled(false);
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = [];
page.on('pageerror', e => errs.push(e.message));
const sleep = ms => new Promise(r => setTimeout(r, ms));

await page.goto('http://127.0.0.1:' + port + '/index.html', { waitUntil: 'domcontentloaded' });
await sleep(1000);

const base = (id, name, persona) => ({ id, name, greeting: '（' + name + '抬了下眼）', persona, avatar: null,
  temperature: 1.0, maxTokens: 2048, topP: 1.0, reasoningEffort: 'low', contextRounds: 20,
  kaomojiFreq: 0, emojiFreq: 0, verbosity: 'medium', splitMessages: true, typingDelay: 0.15,
  hesitation: false, showTyping: true, longMemory: false, allowEditMine: false,
  descLevel: 'high', detailDrive: 'max', povLock: false, appearance: '', appearanceOn: true, presetKey: 'blank', createdAt: Date.now() });

await page.evaluate(async (k, c1, c2, g) => {
  const db = await new Promise((res, rej) => { const rq = indexedDB.open('ai-companion'); rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); });
  const put = (s, v) => new Promise((res, rej) => { const tx = db.transaction(s, 'readwrite'); tx.objectStore(s).put(v); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  await put('characters', c1);
  await put('characters', c2);
  await put('characters', g);
  await put('kv', { k: 'settings', v: { apiKey: k, baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', clockMode: false, liveV2: true } });
  await put('kv', { k: 'lastCharId', v: g.id });
  db.close();
}, KEY,
  base('GC1', '阿绫', '你是阿绫，二十岁，脾气直，句子短，不爱解释。'),
  base('GC2', '小满', '你是小满，话多一点，爱笑，说话带点起哄。'),
  { ...base('GG1', '桥洞三人', '这是一个群聊。'), isGroup: true, memberIds: ['GC1', 'GC2'], narrative: true });

await page.reload({ waitUntil: 'domcontentloaded' });
await sleep(3000);

await page.evaluate(() => { const i = document.getElementById('input'); i.value = '你们俩这会儿在干嘛？'; i.dispatchEvent(new Event('input', { bubbles: true })); });
await page.click('#btn-send');
const idle = await waitIdle(page, 20000, 300000);

const res = await page.evaluate(async () => {
  const db = await new Promise((res, rej) => { const rq = indexedDB.open('ai-companion'); rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); });
  const msgsList = await new Promise(r => { const q = db.transaction(['messages'], 'readonly').objectStore('messages').getAll(); q.onsuccess = () => r(q.result); });
  const keysList = await new Promise(r => { const q = db.transaction(['kv'], 'readonly').objectStore('kv').getAll(); q.onsuccess = () => r(q.result); });
  db.close();
  const mine = msgsList.filter(m => m.charId === 'GG1').sort((a, b) => a.ts - b.ts);
  const psyKeys = keysList.map(x => x.k).filter(x => String(x).startsWith('psyche:GG1:'));
  const psyDetail = psyKeys.map(k => {
    const v = (keysList.find(x => x.k === k) || {}).v || {};
    return { k, bond: (v.relation && v.relation.bond), life: !!(v.life && v.life.activity), mood: (v.mood && v.mood.label) || '' };
  });
  return {
    reply: mine.filter(m => m.role === 'assistant'),
    psyKeys, psyDetail
  };
});

console.log('  回复 ' + res.reply.length + ' 条：' + res.reply.map(m => '「' + m.content.slice(0, 60) + '」').join(' / '));
console.log('  群聊 psyche 键：' + (res.psyKeys.length ? res.psyKeys.join(', ') : '（没有）'));
console.log('  各份读数：' + JSON.stringify(res.psyDetail));

const okReply = res.reply.length >= 1;
const speakerOf = (m) => String(m.speakerId || '');
const anyKey = res.psyKeys.length >= 1;
const okKey = anyKey && res.psyKeys.every(k => ['psyche:GG1:GC1', 'psyche:GG1:GC2'].indexOf(k) >= 0);
const okLife = res.psyDetail.length > 0 && res.psyDetail.every(x => x.life);
const pass = [okReply, okKey, okLife, errs.length === 0].filter(Boolean).length;
console.log('');
console.log('通过 ' + pass + ' 项 / 失败 ' + (4 - pass) + ' 项');
console.log('  群聊有回复：' + (okReply ? 'OK' : 'FAIL'));
console.log('  psyche 是「群+发言人」双键：' + (okKey ? 'OK' : 'FAIL'));
console.log('  读数里带生活状态 life：' + (okLife ? 'OK' : 'FAIL'));
console.log('  页内异常：' + errs.length + (errs.length ? ' | ' + errs.slice(0, 3).join(' || ') : ''));
console.log('  结束标志：' + idle.ended);
await browser.close();
server.close();
process.exit(pass === 4 ? 0 : 1);
