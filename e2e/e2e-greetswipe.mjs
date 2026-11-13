// e2e-greetswipe.mjs —— 0.5.7.1：开场白不能变成「几个一模一样的版本」
//
// 起因（用户实测）：对开场白长按，菜单里有「换一个版本」。开场白没有对应的用户消息，
//   regenerate() 直接返回，但 regenAsVariant 在这之后仍然把原文再并进版本表一次 ——
//   每点一次 +1 版，内容全都一样。气泡下面于是出现 ‹ 1/3 ›，翻到第 3 页还是同一段。
//
// 验三件事：
//   A. 已经坏掉的数据（那条消息带 3 个相同版本）读进来就被归一，不显示分页器
//   B. 新数据不会再坏：开场白没有「换一个版本」入口
//   C. 换一个开场白之后，旧版本被清掉，而且能继续往后换

import puppeteer from 'puppeteer-core';
import http from 'http';
import fs from 'fs';
import path from 'path';

const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');
const WWW = R + '/www';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CARD = 'C:\\Users\\29214\\Desktop\\梦弦居导入文件\\八云紫.json';

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
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const t = (n, ok, ex='') => { if (ok) { pass++; console.log('  OK   ' + n); } else { fail++; console.log('  FAIL ' + n + (ex ? '  -> ' + ex : '')); } };

await page.goto('http://127.0.0.1:' + port + '/index.html', { waitUntil: 'domcontentloaded' });
await sleep(2500);

// 走真实导入路径：库由 app 自己建，不用在这里抢时序
const input = await page.$('#cc-import-file');
t('找得到角色卡导入框', !!input);
await input.uploadFile(CARD);
await sleep(4500);

const imported = await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const all = await new Promise(r => {
    const q = db.transaction('characters').objectStore('characters').getAll();
    q.onsuccess = () => r(q.result || []);
  });
  db.close();
  const c = all[all.length - 1];
  return c ? { id: c.id, name: c.name, alt: (c.alternateGreetings || []).length } : null;
});
t('导入成功', !!imported, JSON.stringify(imported));
t('卡片 4 条备选都存下了', imported && imported.alt === 4, imported && String(imported.alt));

// 进聊天（点角色卡片），让开场白落库
await page.evaluate(async (cid) => {
  await new Promise(r => {
    const o = indexedDB.open('ai-companion');
    o.onsuccess = async () => {
      const db = o.result;
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put({ k: 'lastCharId', v: cid });
      tx.oncomplete = () => { db.close(); r(); };
    };
  });
  location.reload();
}, imported.id);
await sleep(3000);

const before = await page.evaluate(() => {
  const el = document.querySelector('#messages .msg');
  const bub = el ? el.querySelector('.bub') : null;
  const sw = bub ? bub.querySelector('.swipe') : null;
  return { n: document.querySelectorAll('#messages .msg').length, swipe: sw ? sw.textContent.trim() : null, head: bub ? String(bub.textContent).trim().slice(0, 16) : null };
});
t('开场白渲染出来了', before.n === 1 && !!before.head, JSON.stringify(before));
t('正常数据下没有分页器', before.swipe === null, JSON.stringify(before.swipe));

// —— A. 造一个「已经坏掉」的状态：同一条消息塞 3 个一模一样的版本 ——
await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const all = await new Promise(r => {
    const q = db.transaction('messages').objectStore('messages').getAll();
    q.onsuccess = () => r(q.result || []);
  });
  const m = all[0];
  const same = [{ text: m.content }, { text: m.content }, { text: m.content }];
  await new Promise(r => {
    const tx = db.transaction('messages', 'readwrite');
    tx.objectStore('messages').put({ ...m, variants: same, vIdx: 2 });
    tx.oncomplete = r;
  });
  db.close();
  location.reload();
});
await sleep(2600);
const broken = await page.evaluate(() => {
  const el = document.querySelector('#messages .msg');
  const bub = el ? el.querySelector('.bub') : null;
  const sw = bub ? bub.querySelector('.swipe') : null;
  return { n: document.querySelectorAll('#messages .msg').length, swipe: sw ? sw.textContent.trim() : null, head: bub ? String(bub.textContent).trim().slice(0, 16) : null };
});
t('★ 3 个相同版本不再显示 ‹ 1/3 ›（读时归一）', broken.swipe === null, JSON.stringify(broken.swipe));
t('归一之后正文还在', !!broken.head, broken.head);

// —— B. 菜单里对开场白没有「换一个版本」——
await page.evaluate(() => {
  const m = document.querySelector('#messages .msg');
  if (m) m.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
});
await sleep(900);
const labels = await page.evaluate(() => {
  const box = document.querySelector('.msg-menu');
  if (!box) return null;
  const more = box.querySelector('[data-more]');
  if (more) more.click();
  return [...box.querySelectorAll('button')].map(b => b.textContent.trim());
});
t('菜单弹出来了', Array.isArray(labels), JSON.stringify(labels));
t('★ 开场白【没有】「换一个版本」入口', Array.isArray(labels) && !labels.some(x => x.includes('换一个版本')), JSON.stringify(labels));
t('「换一个开场白」还在', Array.isArray(labels) && labels.some(x => x.includes('换一个开场白')), JSON.stringify(labels));

// —— C. 换开场白：版本被清掉，且能继续往后换 ——
const clickRotate = async () => {
  await page.evaluate(() => {
    const m = document.querySelector('#messages .msg');
    if (m) m.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
  });
  await sleep(800);
  return page.evaluate(() => {
    const box = document.querySelector('.msg-menu');
    if (!box) return 'no-menu';
    const find = () => [...box.querySelectorAll('button')].find(x => (x.textContent || '').includes('换一个开场白'));
    let b = find();
    if (!b) { const more = box.querySelector('[data-more]'); if (more) { more.click(); b = find(); } }
    if (!b) return 'no-item';
    b.click(); return 'ok';
  });
};
const r1 = await clickRotate();
await sleep(1300);
const after1 = await page.evaluate(() => {
  const el = document.querySelector('#messages .msg');
  const bub = el ? el.querySelector('.bub') : null;
  const sw = bub ? bub.querySelector('.swipe') : null;
  return { n: document.querySelectorAll('#messages .msg').length, swipe: sw ? sw.textContent.trim() : null, head: bub ? String(bub.textContent).trim().slice(0, 16) : null };
});
t('点了换一个开场白', r1 === 'ok', r1);
t('换完之后正文变了', after1.head !== broken.head, broken.head + ' -> ' + after1.head);
t('换完之后仍然没有分页器', after1.swipe === null, JSON.stringify(after1.swipe));
t('消息条数还是 1（没有叠加）', after1.n === 1, String(after1.n));

const dbState = await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const all = await new Promise(r => {
    const q = db.transaction('messages').objectStore('messages').getAll();
    q.onsuccess = () => r(q.result || []);
  });
  db.close();
  const m = all[0];
  return { hasVariants: m && 'variants' in m, hasVIdx: m && 'vIdx' in m };
});
t('库里那条的 variants 已清掉', dbState.hasVariants === false, JSON.stringify(dbState));
t('vIdx 也清掉了', dbState.hasVIdx === false, JSON.stringify(dbState));

const r2 = await clickRotate();
await sleep(1300);
const after2 = await page.evaluate(() => {
  const el = document.querySelector('#messages .msg');
  const bub = el ? el.querySelector('.bub') : null;
  return bub ? String(bub.textContent).trim().slice(0, 16) : null;
});
t('第二次换继续往后走（不是回到第一条）', r2 === 'ok' && after2 !== after1.head && after2 !== broken.head, after1.head + ' -> ' + after2);

if (errs.length) console.log('（页面报错 ' + errs.length + ' 条）' + errs.slice(0, 2).join(' | '));
console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close();
server.close();
process.exit(fail ? 1 : 0);
