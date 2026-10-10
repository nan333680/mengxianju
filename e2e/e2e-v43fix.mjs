// v1.21.45：「第 __ 年 __ 天」两个分量 —— 单套验证。
//
// ⚠️ 这一版**改掉了 v1.21.43 的语义**，所以断言整段换了：
//   v1.21.43：编辑器是「第 N 天」+「或跳到第 N 年」两个独立入口 ——
//             改年 = 落到那一年的第 1 天，把已经设好的"日"抹掉（这就是用户说的"奇怪"）。
//   v1.21.45：年和日是【同一个 day 的两个分量】，day = (年-1)×365 + 日。
//             改年保留日；日填超过 365 会自动折进年（第 1 年 400 天 → 第 2 年 35 天）。
//
// 覆盖：
//   1. 分量合成：第 3 年 100 天 = 第 830 天
//   2. ★ 改年保留日（这条就是 v1.21.43 的病：旧实现会给出「第 3 年 1 天」= 731）
//   3. ★ 日超过 365 自动折进年（框自己变成「第 2 年 35 天」；v1.21.46 起不再有文字提示）
//   4. 显示：第 731 天 → 「第 3 年 1 天」；≤365 仍只说「第 N 天」
//   5. prompt 里的时间串也带年
//   6. 上限 9999999 仍然可用（超出会被夹回，而不是溢出）
import puppeteer from 'puppeteer-core';
import http from 'http'; import fs from 'node:fs'; import path from 'node:path';
import { seedChar } from './e2e-helper.mjs';
const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');
const WWW = R + '/www';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8' };
const server = http.createServer((req,res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p==='/') p='/index.html';
  const f = path.join(WWW, p);
  if (!fs.existsSync(f)) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f));
});
await new Promise(r => server.listen(0,'127.0.0.1',r));
const port = server.address().port;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 180000, args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = []; page.on('pageerror', e => errs.push(e.message));
page.on('dialog', async d => { await d.accept(); });
await page.setRequestInterception(true);
page.on('request', req => {
  const u = req.url();
  if (!u.includes('deepseek') && !u.includes('/chat/completions')) { req.continue(); return; }
  if (req.method() === 'OPTIONS') { req.respond({ status:204, headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'*'} }); return; }
  req.respond({ status:200, contentType:'application/json', headers:{'Access-Control-Allow-Origin':'*'},
    body: JSON.stringify({ choices:[{ message:{ content:'[]' } }] }) });
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const t = (n, ok, ex) => { if (ok) { pass++; console.log('  OK   ' + n); } else { fail++; console.log('  FAIL ' + n + (ex !== undefined ? '  -> ' + ex : '')); } };

await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
await sleep(1200);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil:'networkidle0' }); await sleep(800);
// v1.21.61：清库后不再自动建角色（产品改空），测试自己塞一个 ——
// 没有当前角色的话，openClockEditor 会直接提示"还没有角色"而不开弹窗。
await seedChar(page, '测试角色', { greeting: '' });
await page.reload({ waitUntil:'networkidle0' }); await sleep(600);
// 关掉现实模式，否则时间编辑器是只读的（openClockEditor 会提前 return）
await page.evaluate(async () => {
  const open = () => new Promise(r => { const o = indexedDB.open('ai-companion'); o.onsuccess = () => r(o.result); });
  const db = await open();
  const g = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get('settings'); q.onsuccess = () => r(q.result); });
  const v = Object.assign({}, (g && g.v) || {}, { clockMode: false, clockDetail: true });
  await new Promise(r => { const tx = db.transaction('kv','readwrite'); tx.objectStore('kv').put({ k:'settings', v }); tx.oncomplete = r; });
  db.close();
});
await page.reload({ waitUntil:'networkidle0' }); await sleep(800);

// ---------- 工具 ----------
const openEditor = async () => {
  await page.evaluate(() => document.getElementById('chat-clock').click());
  await sleep(450);
};
const okEditor = async () => {
  await page.evaluate(() => document.getElementById('clock-ok').click());
  await sleep(400);
};
/** 同时往两个框填值再失焦 —— 归一化发生在 blur（输入中途故意不归一化） */
const setParts = async (y, d) => {
  await page.evaluate((y, d) => {
    const ye = document.getElementById('clock-year');
    const de = document.getElementById('clock-day');
    ye.value = String(y); de.value = String(d);
    ye.dispatchEvent(new Event('input', { bubbles: true }));
    de.dispatchEvent(new Event('input', { bubbles: true }));
    de.dispatchEvent(new Event('blur', { bubbles: true }));
  }, y, d);
  await sleep(250);
};
/** 只改年（触发 change → commit），用来验"改年保留日" */
const setYearOnly = async (y) => {
  await page.$eval('#clock-year', (el, v) => { el.value = String(v); el.dispatchEvent(new Event('change', { bubbles: true })); }, y);
  await sleep(250);
};
/** 只改日（input + blur） */
const setDayOnly = async (d) => {
  await page.$eval('#clock-day', (el, v) => {
    el.value = String(v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }, d);
  await sleep(250);
};
const readParts = () => page.evaluate(() => ({
  y: Number(document.getElementById('clock-year').value),
  d: Number(document.getElementById('clock-day').value)
}));
/** 断言失败时的现场：两个框里到底是什么 */
const partsText = async () => JSON.stringify(await readParts());
/**
 * 「这两个框合起来是第几天」。
 * v1.21.46：弹窗里那行「= 第 N 天」的换算提示按需求删了，
 * 落点不再从提示文本里抠，直接按 app.js 的同一个公式（dayFromParts）从框里的值算。
 * 上限与 app.js 的 DAY_MAX 一致 —— 框被夹回来时报的也是同一个数。
 */
const dayFromBoxes = async () => {
  const { y, d } = await readParts();
  if (!isFinite(y) || !isFinite(d) || y < 1 || d < 1) return null;
  return Math.min(9999999, (y - 1) * 365 + d);
};
const barText = () => page.evaluate(() => (document.querySelector('#chat-clock') || {}).textContent || '');

await openEditor();
t('编辑器里有年输入框', !!(await page.$('#clock-year')));
t('编辑器里有日输入框', !!(await page.$('#clock-day')));
t('换算提示行已删除（v1.21.46 按需求去掉）', !(await page.$('#clock-year-hint')));

// ---------- 1. 分量合成 ----------
console.log('');
console.log('=== 1. day = (年-1)×365 + 日 ===');
await setParts(1, 1);
t('第 1 年 1 天 = 第 1 天', (await dayFromBoxes()) === 1, await partsText());
await setParts(1, 200);
t('第 1 年 200 天 = 第 200 天', (await dayFromBoxes()) === 200, await partsText());
await setParts(3, 100);
t('第 3 年 100 天 = 第 830 天', (await dayFromBoxes()) === 830, await partsText());
await setParts(1000, 1);
t('第 1000 年 1 天 = 第 364636 天', (await dayFromBoxes()) === 364636, await partsText());

// ---------- 2. 改年保留日（v1.21.43 的病） ----------
console.log('');
console.log('=== 2. ★ 改年保留日 ===');
await setParts(2, 35);
t('第 2 年 35 天 = 第 400 天', (await dayFromBoxes()) === 400, await partsText());
await setYearOnly(3);
const p2 = await readParts();
t('★ 改年后日还在（第 2 年 35 天 → 年改 3 → 第 3 年 35 天）',
  p2.y === 3 && p2.d === 35, JSON.stringify({ y: p2.y, d: p2.d }));
t('★ 落点是第 765 天，不是旧实现的 731（那会把 35 抹成 1）', (await dayFromBoxes()) === 765, await partsText());

// ---------- 3. 日超过 365 → 折进年 ----------
console.log('');
console.log('=== 3. ★ 日填超过 365，折进年 ===');
// 分两拍看：输入【中途】框里原样留着 400（绝不归一化，否则打 1000 会在第一个 1 就跳走），
// 失焦后才真正折进年。两拍都要有 —— 只看后者就证明不了"输入途中不会跳走"。
await page.evaluate(() => {
  const ye = document.getElementById('clock-year');
  const de = document.getElementById('clock-day');
  ye.value = '1'; de.value = '400';
  ye.dispatchEvent(new Event('input', { bubbles: true }));
  de.dispatchEvent(new Event('input', { bubbles: true }));
});
await sleep(200);
const mid = await readParts();
t('★ 输入中途不归一化：框里仍是 1 年 400 天，没跳到第 2 年 35 天',
  mid.y === 1 && mid.d === 400, JSON.stringify(mid));
await page.$eval('#clock-day', el => el.dispatchEvent(new Event('blur', { bubbles: true })));
await sleep(250);
const p3 = await readParts();
t('★ 失焦后归一化落地：两个框自己变成第 2 年 35 天',
  p3.y === 2 && p3.d === 35, JSON.stringify({ y: p3.y, d: p3.d }));
t('落点是第 400 天', (await dayFromBoxes()) === 400, await partsText());

// 反过来：改日保留年
await setParts(5, 1);
await setDayOnly(100);
const p5 = await readParts();
t('★ 改日保留年（第 5 年 1 天 → 日改 100 → 第 5 年 100 天）',
  p5.y === 5 && p5.d === 100, JSON.stringify({ y: p5.y, d: p5.d }));
t('落点 = 4×365+100 = 第 1560 天', (await dayFromBoxes()) === 1560, await partsText());

// ---------- 4. 时间条显示 ----------
console.log('');
console.log('=== 4. 时间条 / dayLabel ===');
await setParts(1, 731);
await okEditor();
const bar731 = await barText();
t('第 731 天显示「第 3 年 1 天」', /第 3 年 1 天/.test(bar731), bar731.trim());

await openEditor(); await setParts(1, 365); await okEditor();
const bar365 = await barText();
t('第 365 天不出现「年」', !/年/.test(bar365), bar365.trim());
t('仍然是「第 365 天」', /第 365 天/.test(bar365), bar365.trim());

await openEditor(); await setParts(1, 366); await okEditor();
const bar366 = await barText();
t('第 366 天变成「第 2 年 1 天」', /第 2 年 1 天/.test(bar366), bar366.trim());

// ---------- 5. 提示词里的时间串 ----------
console.log('');
console.log('=== 5. 提示词里的时间串 ===');
const note = await page.evaluate(async () => {
  const { buildTurnNote } = await import('/js/persona.js');
  return buildTurnNote({ name: '测试' }, { longMemory: false, historyTime: false },
    { clock: '秋 · 第 1001 年 250 天 · 傍晚 · 晴', clockState: { day: 365250 } });
});
t('prompt 里有年', /第 1001 年 250 天/.test(note), note.slice(0, 120));

// ---------- 6. 上限 ----------
console.log('');
console.log('=== 6. 上限 9999999 仍然可用 ===');
await openEditor();
await setParts(27398, 1);
t('第 27398 年 1 天 = 第 9999906 天', (await dayFromBoxes()) === 9999906, await partsText());
await setParts(27398, 400);
t('溢出被夹到 9999999（不是溢出成更大的数）', (await dayFromBoxes()) === 9999999, await partsText());

console.log('');
if (errs.length) console.log('  JS 错误: ' + JSON.stringify(errs.slice(0,3)));
t('全程无 JS 错误', errs.length === 0, errs.slice(0,2).join(' | '));
console.log('');
console.log('通过 ' + pass + ' / 失败 ' + fail);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
