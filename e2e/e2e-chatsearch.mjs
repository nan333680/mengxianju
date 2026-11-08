// e2e-chatsearch.mjs —— 全库搜聊天记录（v0.5.4.7）
//
// ⚠️ 名字不能叫 e2e-search —— 那个测的是【联网搜索/搜命令】，是另一件事。
//
// 只搜消息正文。要钉四件事：
//   1. 角色列表页有入口，聊天页菜单里也有
//   2. 输入即搜（300ms 防抖），少于 2 个字不搜
//   3. 命中的按角色分组、带片段和高亮
//   4. 归档里的也搜得到、点了能跳回去（展开归档区再滚）—— 这是最容易漏的一条
import puppeteer from 'puppeteer-core';
import http from 'http'; import fs from 'fs'; import path from 'path';
import { seedChar } from './e2e-helper.mjs';
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
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 120000,
  args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
const page = await browser.newPage();
// ⚠️ CI 的 runner 是 en-US，界面默认「跟随系统」。钉成中文，否则英文界面下断言中文文案的地方会红。
await page.evaluateOnNewDocument(() => {
  Object.defineProperty(navigator, 'language', { get: () => 'zh-CN', configurable: true });
  Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh'], configurable: true });
});
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = []; page.on('pageerror', e => errs.push(e.message));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass=0, fail=0;
const t=(n,ok,ex='')=>{ if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));} };
const waitFor = async (fn, ms = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(250); }
  return false;
};

await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
await sleep(700);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil:'networkidle0' }); await sleep(900);
// ⚠️ 别在这里自己 open('ai-companion') 去"等库"——不带版本会先建出一个空 v1，
//    把 app 的 upgrade 路堵死，然后 seedChar 一路 NotFoundError（踩过）。
if (errs.length) console.log('   [诊断] 启动报错: ' + errs.slice(0, 3).join(' | '));

const a = await seedChar(page, '搜索甲', { greeting: '', longMemory: false });
const b = await seedChar(page, '搜索乙', { greeting: '', longMemory: false });
await page.evaluate(async ({a, b}) => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => o.onsuccess = () => r(o.result));
  const tx = db.transaction('messages','readwrite'); const st = tx.objectStore('messages');
  const now = Date.now();
  st.put({ id:'sa1', charId:a, role:'assistant', content:'她提起过那只青瓷碗，说摔了。', ts:now });
  st.put({ id:'sa2', charId:a, role:'assistant', content:'旧话：那只青瓷碗其实没摔。', ts:now+10, archived:true });
  st.put({ id:'sb1', charId:b, role:'assistant', content:'另一头也在说青瓷碗的事。', ts:now+20 });
  st.put({ id:'sb2', charId:b, role:'assistant', content:'跟这件事无关的一句。', ts:now+30 });
  await new Promise(r => tx.oncomplete = r);
  db.close();
}, {a, b});
await page.reload({ waitUntil:'networkidle0' }); await sleep(900);
await page.evaluate(() => { const e = document.getElementById('btn-chars'); if (e) e.click(); });
await sleep(900);

console.log('=== 1. 入口在 ===');
t('角色列表页有放大镜', await page.evaluate(() => !!document.getElementById('btn-search-open')));
await page.evaluate(() => document.getElementById('btn-search-open').click());
await sleep(500);
t('点了弹出搜索框', await page.evaluate(() => !document.getElementById('search-modal').classList.contains('hidden')));

console.log('=== 2. 少于 2 个字不搜 ===');
await page.evaluate(() => {
  const i = document.getElementById('search-input');
  i.value = '青';
  i.dispatchEvent(new Event('input', { bubbles: true }));
});
await sleep(700);
const one = await page.evaluate(() => (document.getElementById('search-results') || {}).innerHTML || '');
t('一个字只给提示、不给列表', one.includes('至少 2 个字') && !one.includes('sr-item'), one.slice(0, 60));

console.log('=== 3. 搜到了、分组、有高亮 ===');
await page.evaluate(() => {
  const i = document.getElementById('search-input');
  i.value = '青瓷碗';
  i.dispatchEvent(new Event('input', { bubbles: true }));
});
const got = await waitFor(async () => await page.evaluate(() => {
  const b = document.getElementById('search-results');
  return b && b.querySelectorAll('.sr-item').length > 0;
}), 8000);
t('出结果了', got);
const res = await page.evaluate(() => {
  const b = document.getElementById('search-results');
  return {
    items: b.querySelectorAll('.sr-item').length,
    groups: b.querySelectorAll('.sr-group').length,
    marks: b.querySelectorAll('mark').length,
    archivedTag: b.innerHTML.includes('归档'),
  };
});
// 甲两条（一条普通 + 一条归档）、乙一条 —— 共 3 条
t('三条命中都出来了（含归档那条）', res.items === 3, JSON.stringify(res));
t('按角色分组（2 组）', res.groups === 2, 'groups=' + res.groups);
t('命中词有高亮', res.marks >= 2, 'marks=' + res.marks);
t('归档那条标了「归档」', res.archivedTag === true, String(res.archivedTag));

console.log('=== 4. 点一条 → 跳到聊天页 ===');
await page.evaluate(() => { document.querySelector('.sr-item').click(); });
await sleep(1200);
const afterJump = await page.evaluate(() => ({
  modalHidden: document.getElementById('search-modal').classList.contains('hidden'),
  view: (document.querySelector('.view.active') || {}).id,
}));
t('搜索框关了', afterJump.modalHidden === true);
t('跳到了聊天页', afterJump.view === 'view-chat', String(afterJump.view));

console.log('=== 5. 归档那条也搜得到、点得回去 ===');
await page.evaluate(() => { const e = document.getElementById('btn-chars'); if (e) e.click(); });
await sleep(800);
await page.evaluate(() => document.getElementById('btn-search-open').click());
await sleep(500);
await page.evaluate(() => {
  const i = document.getElementById('search-input');
  i.value = '其实没摔';
  i.dispatchEvent(new Event('input', { bubbles: true }));
});
await waitFor(async () => await page.evaluate(() => document.querySelectorAll('.sr-item').length > 0), 8000);
await page.evaluate(() => { document.querySelector('.sr-item').click(); });
await sleep(1800);
const arch = await page.evaluate(() => {
  const el = document.querySelector('#messages .msg[data-id="sa2"]');
  const list = document.getElementById('arch-list');
  return { found: !!el, visible: el ? !!el.offsetParent : false,
           archOpen: list ? !list.classList.contains('hidden') : false };
});
t('归档那条被找到了', arch.found === true, JSON.stringify(arch));
t('归档区自动展开了', arch.archOpen === true, JSON.stringify(arch));
t('那条在屏幕上（没被藏起来）', arch.visible === true, JSON.stringify(arch));

console.log('=== 6. 长按菜单里有这一项（在二级） ===');
await page.evaluate(() => { const e = document.getElementById('btn-chars'); if (e) e.click(); });
await sleep(800);
await page.evaluate(() => {
  const c = [...document.querySelectorAll('#char-list .char-card')].find(x => x.textContent.includes('搜索甲'));
  if (c) c.click();
});
await sleep(1200);
await page.evaluate(() => {
  const els = [...document.querySelectorAll('#messages .msg')];
  if (els.length) els[els.length - 1].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
});
await sleep(500);
const direct = await page.evaluate(() => document.querySelectorAll('.msg-menu [data-k="search"]').length > 0);
if (!direct) {
  await page.evaluate(() => { const m = document.querySelector('.msg-menu [data-more]'); if (m) m.click(); });
  await sleep(400);
}
const viaMore = await page.evaluate(() => document.querySelectorAll('.msg-menu [data-k="search"]').length > 0);
t('长按菜单里能找到「在这段里搜」', direct || viaMore, direct ? '一级' : (viaMore ? '二级' : '都没有'));

t('无未捕获报错', errs.length === 0, errs.slice(0,2).join(' | '));
console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
