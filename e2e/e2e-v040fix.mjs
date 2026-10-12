// e2e-v040fix.mjs — v0.4.0 这一轮抓到的静默缺陷
//
// 全是「没人报错、用户只看到行为不对」那一类，所以必须钉住：
//
//   1) app.js 里 clockState = tick（【整段换掉】）——
//      detectClock 只返回 { day, phase, season, weather } 四个字段，于是每写一句
//      「（第二天）」，就把 locked / hour / minute 一起冲掉：
//        · 开了「精确时间」的话，顶部时间条的时分当场消失
//        · saveClock() 把这个残缺对象写进库，刷新也回不来
//      本文件其它 9 处赋值用的都是 {...clockState, ...xxx}，只有这一处不是。
//      这条是 tsconfig 纳入 app.js 之后第一次跑 tsc 抓到的（TS2739）。
//
//   2) _renderView(name, 'back') —— 第二个参数一直是【被丢掉】的。
//      翻页动效由 .view 上同一条 transition 决定，本来就区分不了方向。
//
//   3) style.css 里 .wb-list-empty{' 多一个单引号 → 选择器非法 →
//      整条规则被 CSS 解析器丢掉（"还没有条目"那块一直是无样式的裸文字）。
import puppeteer from 'puppeteer-core';
import { seedChar } from './e2e-helper.mjs';
import http from 'http'; import fs from 'fs'; import path from 'path';
import { readCode } from './e2e-src.mjs';
const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');
const WWW = R + '/www';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8' };
let pass = 0, fail = 0;
const t = (n, ok, ex) => { if (ok) { pass++; console.log('  OK   ' + n); } else { fail++; console.log('  FAIL ' + n + (ex ? '  -> ' + ex : '')); } };

const SRC = readCode(WWW + '/js/app.js');
const CSS = readCode(WWW + '/css/style.css');

console.log('=== 1. 源码：修复都在（改回去就红）===');
t('clockState 改成展开赋值（不再整段换掉）',
  SRC.includes('clockState = { ...clockState, ...tick }'));
t('原来那句 clockState = tick 没了',
  !SRC.includes('clockState = tick;'));
t('_renderView 被丢掉的那个 back 参数删了',
  !SRC.includes("_renderView(name, 'back')") && !SRC.includes("_renderView(_stack[_stack.length - 1], 'back')"));
t('CSS 那条规则真的成形了（不再是 .wb-list-empty{\' 这种非法选择器）',
  CSS.includes('.wb-list-empty{'), 'STOP');
t('原来那个多出来的单引号只留在注释里，不在选择器里',
  !/^\.wb-list-empty\{'/m.test(CSS));
t('显示侧正则挂点还在 msgHtml', SRC.includes("stRe(m.content, 'display', depth)"));
t('提示词侧正则挂点还在 composeApiMsgs', SRC.includes("stRe(m.content, 'prompt'"));
t('角色卡入口读了 extensions.regex_scripts', SRC.includes('addStRegex(cardRegs'));
t('预设报告有「把正则收进来」按钮', SRC.includes('id="stp-add-regs"'));
// 酒馆正则那份表是【用户自己的设置】（收进来哪些、哪条开着），换机导回去必须跟着走 ——
// 它没有冒号，前缀表装不下，得单独列一份。
t('酒馆正则跟着备份走（漏了它"导出全部数据"就是半个备份）',
  SRC.includes("const BACKUP_EXACT_KEYS = ['stRegex']"));
t('群聊不会导成角色卡', SRC.includes('群聊导不成角色卡'));

console.log('=== 2. 造一个开着「精确时间」的角色，钟点定在 09:30 ===');
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
await page.setRequestInterception(true);
page.on('request', req => {
  const u = req.url();
  if (u.includes('/chat/completions')) {
    if (req.method() === 'OPTIONS') {
      req.respond({ status: 204, headers: { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Headers':'*', 'Access-Control-Allow-Methods':'*' } }); return;
    }
    const NL = String.fromCharCode(10);
    const payload = 'data: ' + JSON.stringify({ choices: [{ delta: { content: '好，走吧。' } }] }) + NL + NL + 'data: [DONE]' + NL + NL;
    req.respond({ status: 200, headers: { 'Access-Control-Allow-Origin':'*' }, contentType: 'text/event-stream', body: payload }); return;
  }
  req.continue();
});
await page.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'networkidle0', timeout: 40000 });
await sleep(1200);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil: 'networkidle0' }); await sleep(1000);
const CID = 'ck1';
await seedChar(page, '钟', { greeting: '（开场）', id: CID });
await page.evaluate(async (cid) => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const put = (st, rec) => new Promise(r => { const tx = db.transaction(st, 'readwrite'); tx.objectStore(st).put(rec); tx.oncomplete = r; });
  const rec = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get('settings'); q.onsuccess = () => r(q.result); });
  const v = Object.assign({}, (rec && rec.v) || {}, {
    apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com',
    clockDetail: true, clockMode: false, longMemory: false });
  await put('kv', { k: 'settings', v });
  await put('kv', { k: 'lastCharId', v: cid });
  // 第 1 天 上午 09:30，没锁
  await put('kv', { k: 'clock:' + cid, v: { day: 1, phase: 'morning', season: 'spring', weather: 'clear', locked: false, hour: 9, minute: 30 } });
  db.close();
}, CID);
await page.reload({ waitUntil: 'networkidle0' }); await sleep(1200);

const barBefore = await page.$eval('#chat-clock', el => el.textContent);
console.log('   发之前顶部时间条: ' + JSON.stringify(barBefore));
t('发之前时间条上有 09:30', barBefore.includes('09:30'), barBefore);

console.log('=== 3. 发一句带「（第二天）」的话 → 剧情时间推进 ===');
await page.evaluate(x => { const el = document.getElementById('input'); el.value = x; el.dispatchEvent(new Event('input', { bubbles: true })); }, '（第二天）我们出门吧');
await sleep(200);
await page.evaluate(() => document.getElementById('btn-send').click());
for (let i = 0; i < 60; i++) { await sleep(300); const busy = await page.$eval('#btn-stop', e => !e.classList.contains('hidden')).catch(() => false); if (!busy) break; }
await sleep(1500);

const clock = await page.evaluate(async (cid) => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const rec = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get('clock:' + cid); q.onsuccess = () => r(q.result); });
  db.close();
  return rec ? rec.v : null;
}, CID);
console.log('   发之后库里存的时钟: ' + JSON.stringify(clock));
t('日期推进到第 2 天（这条本来就该走）', !!clock && clock.day === 2, JSON.stringify(clock));
t('钟点没丢（hour 还是 9）', !!clock && clock.hour === 9, JSON.stringify(clock));
t('分钟没丢（minute 还是 30）', !!clock && clock.minute === 30, JSON.stringify(clock));
t('locked 没丢（还在对象里，且是 false）', !!clock && clock.locked === false, JSON.stringify(clock));
const barAfter = await page.$eval('#chat-clock', el => el.textContent);
console.log('   发之后顶部时间条: ' + JSON.stringify(barAfter));
t('顶部时间条上 09:30 还在（用户看得见的那个现象）', barAfter.includes('09:30'), barAfter);

console.log('');
console.log('JS 错误: ' + (errs.length ? errs.join(' | ') : '无'));
t('无 JS 报错', errs.length === 0, errs.join(' | '));
console.log('');
console.log('通过 ' + pass + ' / 失败 ' + fail);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
