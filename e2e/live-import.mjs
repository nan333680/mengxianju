import puppeteer from 'puppeteer-core';
import http from 'http';
import fs from 'fs';
import path from 'path';

const BACKUP = (process.argv[2] || '').trim();
if (!BACKUP || !fs.existsSync(BACKUP)) {
  console.log('用法: node e2e/live-import.mjs <备份.json>');
  process.exit(2);
}
const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');
const WWW = R + '/www';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.ico': 'image/x-icon' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  const f = path.join(WWW, u === '/' ? 'index.html' : u);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('no'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store, no-cache, must-revalidate' });
  res.end(fs.readFileSync(f));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const URL0 = 'http://127.0.0.1:' + PORT + '/index.html';

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await page.setCacheEnabled(false);
const errs = [];
page.on('pageerror', e => errs.push(e.message));

// 拦截导出：不真下载，留下 blob 地址
await page.evaluateOnNewDocument(() => {
  window.__exp = {};
  const oc = URL.createObjectURL;
  URL.createObjectURL = function (b) { const u = oc.call(URL, b); window.__exp.blobUrl = u; return u; };
  const clk = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () { if (this.download) { window.__exp.name = this.download; window.__exp.href = this.href; return; } return clk.call(this); };
});

let pass = 0, fail = 0;
const t = (n, ok, ex) => { if (ok) { pass++; console.log('OK   ' + n); } else { fail++; console.log('FAIL ' + n + (ex ? ' -> ' + ex : '')); } };

await page.goto(URL0, { waitUntil: 'domcontentloaded' });
await new Promise(r => setTimeout(r, 2500));

// 导入过程里 wipeAll 会关连接重建库，所以每次单独开一个连接，出错就当"还没好"
const SNAP = async () => {
  try {
    return await page.evaluate(async () => {
      const db = await new Promise((res, rej) => { const r = indexedDB.open('ai-companion'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      const names = [...db.objectStoreNames];
      const bad = { chars: -1, msgs: -1, mems: -1, ws: -1, wg: -1, kv: -1, ok: false };
      if (!names.includes('characters') || !names.includes('messages')) { db.close(); return bad; }
      const one = (store) => new Promise(r => { try { const q = db.transaction([store], 'readonly').objectStore(store).count(); q.onsuccess = () => r(q.result); q.onerror = () => r(-1); } catch (e) { r(-1); } });
      const out = { chars: await one('characters'), msgs: await one('messages'), mems: await one('memories'), ws: await one('wbSolo'), wg: await one('wbGroups'), kv: await one('kv'), ok: true };
      db.close();
      return out;
    });
  } catch (e) { return { chars: -1, msgs: -1, mems: -1, ws: -1, wg: -1, kv: -1, ok: false }; }
};
const CNT = SNAP;

// 用软件自己的 db.js 建库（直接 indexedDB.open 无版本号会造一个没 store 的空库）
await page.evaluate(async () => { await (await import('/js/db.js')).openDB(); });

// 先在"本机"填一个 key，验证导入不会把它抹掉
await page.evaluate(async () => {
  const db = await (await import('/js/db.js')).openDB();
  await new Promise(r => { const tx = db.transaction(['kv'], 'readwrite'); tx.objectStore('kv').put({ k: 'settings', v: { apiKey: 'LOCALKEY123', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' } }); tx.oncomplete = r; });
  db.close();
});
await page.reload({ waitUntil: 'domcontentloaded' });
await new Promise(r => setTimeout(r, 2500));

const raw = JSON.parse(fs.readFileSync(BACKUP, 'utf8'));
const srcChars = (raw.characters || []).length;
const srcMsgs = Object.values(raw.messages || {}).reduce((a, b) => a + b.length, 0);
const srcMems = (raw.memories || []).length;
const srcWg = ((raw.worldbook || {}).groups || []).length;
const srcWs = ((raw.worldbook || {}).solo || []).length;
console.log('备份: 角色 ' + srcChars + ' / 消息 ' + srcMsgs + ' / 记忆 ' + srcMems + ' / 世界书 ' + srcWg + '+' + srcWs);

// 上传
const input = await page.$('#file-import');
await input.uploadFile(BACKUP);
await new Promise(r => setTimeout(r, 1200));
const modalShown = await page.evaluate(() => !document.getElementById('import-modal').classList.contains('hidden'));
t('选文件后弹出导入方式', modalShown);

await page.evaluate(() => {
  const r = document.querySelector('input[name="imp-mode"][value="all"]');
  if (r) { r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); }
});
await new Promise(r => setTimeout(r, 300));
const radioOk = await page.evaluate(() => { const r = document.querySelector('input[name="imp-mode"][value="all"]'); return !!(r && r.checked && !r.disabled); });
t('「完全还原」可选', radioOk);

await page.evaluate(() => document.getElementById('import-ok').click());
await new Promise(r => setTimeout(r, 800));
const confirmShown = await page.evaluate(() => !document.getElementById('modal').classList.contains('hidden'));
t('弹二次确认（要删多少条都写出来）', confirmShown);
const confirmText = await page.evaluate(() => document.getElementById('modal-text').textContent);
t('二次确认里写清了要删/要导入什么', /聊天记录/.test(confirmText) && /长期记忆/.test(confirmText) && confirmText.includes(String(srcChars)));

// 确认导入
const t0 = Date.now();
await page.evaluate(() => document.getElementById('modal-ok').click());
let counts = null;
for (let i = 0; i < 120; i++) {
  await new Promise(r => setTimeout(r, 500));
  counts = await CNT();
  if (counts.chars >= srcChars && counts.msgs >= srcMsgs) break;
}
console.log('导入耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's -> ' + JSON.stringify(counts));
t('角色数一致', counts.chars === srcChars, counts.chars + ' vs ' + srcChars);
t('消息数一致', counts.msgs === srcMsgs, counts.msgs + ' vs ' + srcMsgs);
t('记忆数一致', counts.mems === srcMems, counts.mems + ' vs ' + srcMems);
t('世界书组数一致', counts.wg === srcWg, counts.wg + ' vs ' + srcWg);
t('世界书单条数一致', counts.ws === srcWs, counts.ws + ' vs ' + srcWs);

// 逐角色消息数
const perChar = await page.evaluate(async () => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('ai-companion'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const all = await new Promise(r => { const q = db.transaction(['messages'], 'readonly').objectStore('messages').getAll(); q.onsuccess = () => r(q.result); });
  db.close();
  const o = {};
  for (const m of all) o[m.charId] = (o[m.charId] || 0) + 1;
  return o;
});
let bad = [];
for (const [cid, arr] of Object.entries(raw.messages || {})) if ((perChar[cid] || 0) !== arr.length) bad.push(cid + ':' + (perChar[cid] || 0) + '/' + arr.length);
t('每个角色的消息条数都对得上', bad.length === 0, bad.slice(0, 3).join(' '));

// 本机 key 没被抹
const keyAfter = await page.evaluate(async () => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('ai-companion'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const rec = await new Promise(r => { const q = db.transaction(['kv'], 'readonly').objectStore('kv').get('settings'); q.onsuccess = () => r(q.result); });
  db.close();
  return rec && rec.v && rec.v.apiKey;
});
t('导入没有抹掉本机的 apiKey', keyAfter === 'LOCALKEY123', String(keyAfter));

// 导出往返
await page.evaluate(() => document.getElementById('btn-export').click());
await new Promise(r => setTimeout(r, 1200));
const expInfo = await page.evaluate(() => ({ name: window.__exp.name || '', hasUrl: !!window.__exp.blobUrl }));
t('导出触发了下载', /梦弦居备份-/.test(expInfo.name), expInfo.name);
const expStats = await page.evaluate(async () => {
  const txt = await (await fetch(window.__exp.blobUrl)).text();
  const d = JSON.parse(txt);
  const msgTotal = Object.values(d.messages || {}).reduce((a, b) => a + b.length, 0);
  const c0 = (d.characters || [])[0] || {};
  const m0 = (Object.values(d.messages || {})[0] || [])[0] || {};
  return {
    keys: Object.keys(d).join(','),
    chars: (d.characters || []).length,
    msgs: msgTotal,
    mems: (d.memories || []).length,
    wg: ((d.worldbook || {}).groups || []).length,
    ws: ((d.worldbook || {}).solo || []).length,
    kv: (d.kv || []).length,
    scenes: (d.scenes || []).length,
    apiKey: String((d.settings || {}).apiKey || ''),
    charKeys: Object.keys(c0).length,
    msgKeys: Object.keys(m0).length,
    bytes: txt.length
  };
});
console.log('导出: ' + JSON.stringify(expStats));
t('导出顶层键齐全', expStats.keys === 'version,exportedAt,settings,characters,messages,memories,worldbook,kv,scenes', expStats.keys);
t('导出角色数一致', expStats.chars === srcChars, expStats.chars + ' vs ' + srcChars);
t('导出消息数一致', expStats.msgs === srcMsgs, expStats.msgs + ' vs ' + srcMsgs);
t('导出记忆数一致', expStats.mems === srcMems, expStats.mems + ' vs ' + srcMems);
t('导出世界书一致', expStats.wg === srcWg && expStats.ws === srcWs, expStats.wg + '+' + expStats.ws);
t('导出不含 apiKey', expStats.apiKey === '', expStats.apiKey.slice(0, 6));
t('导出的角色带完整字段（>=25 个）', expStats.charKeys >= 25, String(expStats.charKeys));
t('导出的消息带完整字段（>=8 个）', expStats.msgKeys >= 8, String(expStats.msgKeys));
t('页内没有异常', errs.length === 0, errs.slice(0, 2).join(' | '));

console.log('');
console.log('通过 ' + pass + ' 项 / 失败 ' + fail + ' 项');
await browser.close();
server.close();
process.exit(fail ? 1 : 0);
