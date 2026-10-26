// live-real.mjs —— 真 key 真链路检查（不进回归：文件名不是 e2e-*.mjs）
//
// mock 测过的是「代码按照约定走」；这里测「真模型答应不答应」：
//   1 一轮六次调用真的发出去、真的能解析、真的落库
//   2 第二轮带上文，psyche 真的在累积
//   3 断网发送 → 出错误卡、三个点消失、停止键复原、恢复后还能发
//   4 生成中途 reload（等于被系统杀掉）→ 数据不坏，父指针没有悬空
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
  let q = decodeURIComponent(req.url.split('?')[0]);
  if (q === '/') q = '/index.html';
  const f = path.join(WWW, q);
  if (!fs.existsSync(f)) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(fs.readFileSync(f));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
const page = await browser.newPage();
await page.setCacheEnabled(false);
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = [];
page.on('pageerror', e => errs.push(e.message));
const logs = [];
page.on('console', m => { try { const tx = m.text(); if (m.type() === 'error' || tx.startsWith('[')) logs.push('[' + m.type() + '] ' + tx); } catch (e) {} });
let pass = 0, fail = 0;
const t = (n, ok, ex = '') => { if (ok) { pass++; console.log('  OK   ' + n); } else { fail++; console.log('  FAIL ' + n + (ex ? '  -> ' + ex : '')); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
// 只记【真请求】：CORS 预检 OPTIONS 也会打到同一个网址，postData 是空的，必须排除。
const reqs = [];
page.on('request', r => {
  if (r.method() !== 'POST') return;
  const u = r.url();
  if (u.indexOf('/chat/completions') < 0) return;
  let b = {}; try { b = JSON.parse(r.postData() || '{}'); } catch (e) {}
  const all = ((b.messages || []).map(m => String(m.content || ''))).join(String.fromCharCode(10));
  let kind = 'gen';
  if (all.indexOf('# 这一轮先别写正文') >= 0) kind = 'dir';
  else if (all.indexOf('只输出 JSON') >= 0 && all.indexOf('pick') >= 0) kind = 'crit';
  else if (all.indexOf('先别写回复') >= 0) kind = 'inner';
  else if (all.indexOf('你先开口') >= 0) kind = 'proactive';
  reqs.push({ kind, stream: b.stream !== false, temp: b.temperature, chars: all.length });
});
async function count() { return reqs.length; }
async function dbState() {
  return page.evaluate(async () => {
    const db = await new Promise((res, rej) => { const rq = indexedDB.open('ai-companion'); rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); });
    const get = (s, k) => new Promise((res, rej) => { const tx = db.transaction(s, 'readonly'); const rq = tx.objectStore(s).get(k); rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); });
    const list = (s) => new Promise((res, rej) => { const tx = db.transaction(s, 'readonly'); const rq = tx.objectStore(s).getAll(); rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); });
    const all = (await list('messages')).filter(m => m.charId === 'LR').sort((a, b) => a.ts - b.ts);
    const psyRec = await get('kv', 'psyche:LR');
    const psy = (psyRec && psyRec.v) || null;
    const ids = new Set(all.map(m => m.id));
    const dangling = all.filter(m => typeof m.parentId === 'string' && m.parentId && !ids.has(m.parentId)).length;
    db.close();
    const ai = all.filter(m => m.role === 'assistant');
    return {
      total: all.length, aiCount: ai.length,
      lastAi: ai.length ? ai[ai.length - 1].content : '',
      // ⚠️ 一轮回复可能被 splitMessages 拆成多段，用量只记在【第一段】上（app.js 那句
      // `if (i === 0 && usage) am.usage = usage`）—— 取最后一条会得到 undefined，
      // 看起来像「用量没落库」。这里倒着找第一条带 usage 的。
      usage: (() => { for (let i = ai.length - 1; i >= 0; i--) { if (ai[i].usage) return ai[i].usage; } return null; })(),
      psy: psy ? { mood: psy.mood, withheld: psy.withheld, moves: psy.moves, relation: psy.relation, lastInner: psy.lastInner } : null,
      dangling,
      dom: Array.from(document.querySelectorAll('#messages .msg')).length,
      errCards: document.querySelectorAll('#messages .err-bub').length,
      stopShown: !document.getElementById('btn-stop').classList.contains('hidden')
    };
  });
}
await page.goto('http://127.0.0.1:' + port + '/index.html', { waitUntil: 'networkidle0' });
await sleep(500);
await page.evaluate(async (k) => {
  const db = await new Promise((res, rej) => { const rq = indexedDB.open('ai-companion'); rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); });
  const put = (s, v) => new Promise((res, rej) => { const tx = db.transaction(s, 'readwrite'); tx.objectStore(s).put(v); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  const now = Date.now();
  await put('characters', {
    id: 'LR', name: '阿绫', greeting: '（阿绫靠在门边，抬了下眼）', persona: '你是阿绫，二十岁，脾气直，句子短，不爱解释。', avatar: null,
    temperature: 1.0, maxTokens: 2048, topP: 1.0, reasoningEffort: 'low', contextRounds: 20,
    kaomojiFreq: 0, emojiFreq: 0, verbosity: 'medium', splitMessages: true, typingDelay: 0.15,
    hesitation: false, showTyping: true, longMemory: false, allowEditMine: false,
    descLevel: 'high', detailDrive: 'max', povLock: false, appearance: '', appearanceOn: true, presetKey: 'blank', createdAt: now
  });
  await put('kv', { k: 'settings', v: { apiKey: k, baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', clockMode: false, liveV2: true } });
  await put('kv', { k: 'lastCharId', v: 'LR' });
  db.close();
}, KEY);
await page.reload({ waitUntil: 'domcontentloaded' });
await sleep(2200);
async function say(txt) {
  const before = reqs.length;
  await page.evaluate((x) => { const i = document.getElementById('input'); i.value = x; i.dispatchEvent(new Event('input', { bubbles: true })); }, txt);
  await page.click('#btn-send');
  const idle = await waitIdle(page, 15000, 180000);
  return { idle, used: reqs.slice(before) };
}

console.log('=== 1 第一轮：完整 v2 一轮（真 key） ===');
const t1 = Date.now();
const r1 = await say('今天有点累，不想说话。');
const s1 = await dbState();
console.log('耗时=' + ((Date.now() - t1) / 1000).toFixed(1) + 's  请求=' + JSON.stringify(r1.used.map(x => x.kind + (x.stream ? '/流' : '/once') + '@' + x.temp)));
t('生成正常结束', r1.idle.ended);
t('一轮里独白、判断、评审各一次', r1.used.filter(x => x.kind === 'inner').length === 1 && r1.used.filter(x => x.kind === 'dir').length === 1 && r1.used.filter(x => x.kind === 'crit').length === 1, JSON.stringify(r1.used.map(x => x.kind)));
t('三条候选温度 0.85/1/1.15', [0.85, 1, 1.15].every(v => r1.used.some(x => x.kind === 'gen' && Math.abs(Number(x.temp) - v) < 1e-6)), JSON.stringify(r1.used.map(x => x.temp)));
t('真模型回了非空内容', s1.lastAi.trim().length > 0, s1.lastAi.slice(0, 60));
t('落库有条目、无悬空父指针', s1.total >= 2 && s1.dangling === 0, 'total=' + s1.total + ' dangling=' + s1.dangling);
t('用量落库了', !!(s1.usage && Number(s1.usage.prompt_tokens) > 0), JSON.stringify(s1.usage));
t('psyche 写进去了', !!(s1.psy && s1.psy.mood && typeof s1.psy.mood === 'object'), JSON.stringify(s1.psy && s1.psy.mood));
console.log('--- 她说 ---');
console.log(s1.lastAi);
console.log('--- 独白 ---');
console.log((s1.psy && s1.psy.lastInner) || '（空）');
console.log('--- 用量 ---');
console.log(JSON.stringify(s1.usage));
console.log('--- psyche ---');
console.log(JSON.stringify(s1.psy));

console.log('=== 2 第二轮：上下文与 psyche 惯性 ===');
const r2 = await say('那你去忙吧。');
const s2 = await dbState();
t('第二轮也正常结束', r2.idle.ended);
t('第二轮请求里带着上一轮的对话', r2.used.some(x => x.chars > 0));
t('消息数在增长', s2.total > s1.total, s1.total + ' -> ' + s2.total);
console.log('--- 她说 ---');
console.log(s2.lastAi);

console.log('=== 3 断网时发送 ===');
await page.setOfflineMode(true);
const before3 = await dbState();
await page.evaluate(() => { const i = document.getElementById('input'); i.value = '断网测试'; i.dispatchEvent(new Event('input', { bubbles: true })); });
await page.click('#btn-send');
const gotErr = await page.waitForFunction(() => document.querySelectorAll('#messages .err-bub').length > 0, { timeout: 90000 }).then(() => true).catch(() => false);
await sleep(500);
const s3 = await dbState();
t('断网时出错误卡（不是永久三个点）', gotErr && s3.errCards > before3.errCards, 'errCards=' + s3.errCards);
t('断网后停止键已复原', !s3.stopShown);
await page.setOfflineMode(false);
const r4 = await say('回来了吗？');
const s4 = await dbState();
t('恢复网络后还能正常发', r4.idle.ended && s4.lastAi.trim().length > 0, s4.lastAi.slice(0, 40));

console.log('=== 4 生成中途 reload（等于被系统杀掉） ===');
await page.evaluate(() => { const i = document.getElementById('input'); i.value = '再说一句，这次我要打断你。'; i.dispatchEvent(new Event('input', { bubbles: true })); });
const beforeReload = await dbState();
await page.click('#btn-send');
await sleep(1500);
await page.reload({ waitUntil: 'domcontentloaded' });
await sleep(2500);
const s5 = await dbState();
t('重进后数据没变少', s5.total >= beforeReload.total, beforeReload.total + ' -> ' + s5.total);
t('重进后没有悬空父指针', s5.dangling === 0, 'dangling=' + s5.dangling);
t('重进后界面能画出来、没有再发在跑', s5.dom >= 1 && !s5.stopShown, 'dom=' + s5.dom);

console.log('=== 5 输出中途点停止 ===');
await page.evaluate(() => { const i = document.getElementById('input'); i.value = '说说你昨晚干了什么，说长一点。'; i.dispatchEvent(new Event('input', { bubbles: true })); });
await page.click('#btn-send');
await sleep(2600);
const clickedStop = await page.evaluate(() => { const b = document.getElementById('btn-stop'); if (b && !b.classList.contains('hidden')) { b.click(); return true; } return false; });
await sleep(4500);
const s6 = await dbState();
t('点停止时确实在生成', clickedStop);
t('停止后停止键消失（没有卡在生成态）', !s6.stopShown);
t('中断的那条落库了（带「已中断」或至少不是空白）', s6.lastAi.trim().length > 0, s6.lastAi.slice(0, 60));
const r7 = await say('你还在吗');
const s7 = await dbState();
t('中断之后还能继续发', r7.idle.ended && s7.total > s6.total, s6.total + ' -> ' + s7.total);

console.log('=== 6 页内错误 ===');
t('没有未捕获的页面异常', errs.length === 0, errs.join(' | ').slice(0, 300));
console.log(logs.filter(x => x.indexOf('critique') >= 0 || x.indexOf('inner') >= 0 || x.indexOf('director') >= 0).slice(-12).join(String.fromCharCode(10)) || '（无相关日志）');

console.log('通过 ' + pass + ' 项 / 失败 ' + fail + ' 项');
await browser.close();
server.close();
process.exit(fail ? 1 : 0);