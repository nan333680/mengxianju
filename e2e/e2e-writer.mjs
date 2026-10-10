// v1.21.48 写字台（输入形态）回归：输入框自动长高 / 高度上限 / 回车键行为 / 字数
//
// 为什么需要这一套：改动前输入框高度写死 120px（CSS 与 JS 各一份），
// 而且没有任何 e2e 碰过输入框 —— 高度这种「看起来能跑」的东西最容易改完就回退。
//
// 打法：设置一律【从设置页真点】，不直接改 IndexedDB。
// 起因：第一版用 db.put(value, 'settings') 直接写库 —— kv 是 keyPath:'k' 的库，
// 直接抛 DataError，测试根本没跑起来。而且绕过 UI 就测不到「点一下有没有生效」。
//
// 本套不外网：发送用例只验证消息进了列表（地址指向必然连不上的端口）。
import puppeteer from 'puppeteer-core';
import { seedChar } from './e2e-helper.mjs';
import http from 'http';
import fs from 'fs';
import path from 'path';

const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');
const WWW = `${R}/www`;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.png':'image/png' };
const server = http.createServer((req,res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const f = path.join(WWW, p);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
  res.end(fs.readFileSync(f));
});
await new Promise(r => server.listen(0,'127.0.0.1',r));
const port = server.address().port;

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const jsErrs = [];
page.on('pageerror', e => jsErrs.push(String((e && e.message) || e)));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
};

const inputBox = () => page.$eval('#input', el => {
  const cs = getComputedStyle(el);
  return { h: Math.round(el.getBoundingClientRect().height), scrollH: el.scrollHeight,
           clientH: el.clientHeight, overflowY: cs.overflowY,
           maxH: cs.maxHeight, val: el.value };
});
const countBox = () => page.$eval('#input-count', el => ({ text: el.textContent, shown: getComputedStyle(el).display !== 'none' }));
/**
 * 往输入框里放内容。
 * ⚠️ 用直接赋值 + 派发 input，不用 page.type：
 * page.type 敲 '\n' 走的是「按回车键」，而回车在【回车就发】档会把内容发出去 ——
 * 结果就是「多行」根本没进框（实测 7 行只量到 62px 高）。
 * 赋值 + 派发 input 才是这个 app 真实走的路径（回填草稿、编辑重发都是这么干的）。
 */
const setInput = async (t) => {
  await page.$eval('#input', (el, v) => {
    el.value = v; el.dispatchEvent(new Event('input', { bubbles: true }));
  }, t || '');
  await sleep(120);
};
const msgCount = () => page.$$eval('.msg', els => els.length);

/** 打开设置页（⚙ → 抽屉里的「全部设置」） */
const openSettings = async () => {
  await page.click('#btn-settings'); await sleep(700);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('#drawer-menu [data-wb-drawer]')].find(x => x.dataset.wbDrawer === 'settings');
    if (b) b.click();
  });
  await sleep(600);
};
/**
 * 从设置页回到聊天。
 * ⚠️ 三步都要先等元素【可点】再点：
 * 页面切换带 .34s 的滑出动画，sleep 死等会撞在动画中间 ——
 * 实测报 'Node is either not clickable or not an Element'，看不出是哪一步的问题。
 */
/**
 * 点一个元素。
 * ⚠️ 用 DOM 的 click()，不用 page.click()：
 * 页面切换有 .34s 滑出动画，page.click 会算可点坐标 —— 动画中间算出来的点
 * 落在别的元素上，直接抛 'Node is either not clickable or not an Element'，
 * 而且看不出是哪一步。DOM click 不关心动画，和用户点的是同一个 handler。
 */
const clickWhenReady = async (sel, ms = 8000) => {
  await page.waitForSelector(sel, { timeout: ms });
  const hit = await page.evaluate((s) => { const el = document.querySelector(s); if (!el) return false; el.click(); return true; }, sel);
  if (!hit) throw new Error('点不到: ' + sel);
};
const backToChat = async () => {
  await clickWhenReady('#btn-set-back'); await sleep(700);
  await clickWhenReady('#btn-chars'); await sleep(700);
  await clickWhenReady('#char-list .char-card'); await sleep(900);
};
/** 点设置页里的某一档（真实点击路径） */
const pickSeg = async (segId, label) => {
  const hit = await page.evaluate((id, lb) => {
    const b = [...document.querySelectorAll('#' + id + ' button')].find(x => x.textContent.trim() === lb);
    if (!b) return false;
    b.click(); return true;
  }, segId, label);
  await sleep(900);   // 设置项都带一次异步写库 + 重绘，读太早会读到旧文案
  return hit;
};

// ── 起场景 ──────────────────────────────────────────────
await page.goto('http://127.0.0.1:' + port + '/', { waitUntil:'networkidle0', timeout:40000 });
await sleep(1200);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await sleep(600);
await page.reload({ waitUntil:'networkidle0' });
await sleep(1400);
await page.click('#btn-settings'); await sleep(800);
await page.evaluate(() => {
  const b = [...document.querySelectorAll('#drawer-menu [data-wb-drawer]')].find(x => x.dataset.wbDrawer === 'settings');
  if (b) b.click();
});
await sleep(600);
await page.$eval('#s-apikey', (el) => { el.value = 'sk-test'; el.dispatchEvent(new Event('change', { bubbles: true })); });
await page.$eval('#s-baseurl', (el) => { el.value = 'http://127.0.0.1:1'; el.dispatchEvent(new Event('change', { bubbles: true })); });
await sleep(300);
await page.click('#btn-set-back'); await sleep(600);
await seedChar(page, '写字台测试', { greeting: '（她抬头看你）' });
await page.reload({ waitUntil:'networkidle0' });
await sleep(1400);
await page.click('#btn-chars'); await sleep(700);
await page.click('#char-list .char-card'); await sleep(900);

console.log('\n【1】默认形状（老观感不能变）');
let b = await inputBox();
ok('空框是 42px 的胶囊高度', b.h === 42, b);   // 老版本同高：起步就同步一次，别等打字才变
ok('空框不出现滚动条', b.overflowY === 'hidden', b);
ok('高度上限默认 3 行 = 120px（和旧版写死的一样）', b.maxH === '120px', b);
let c = await countBox();
ok('回车就发时字数一个字都不显示', c.text === '', c);

console.log('\n【2】打字自动长高');
await setInput('第一行');
const b1 = await inputBox();
await setInput('第一行\n第二行');
const b2 = await inputBox();
await setInput('一\n二\n三\n四\n五\n六\n七');
const b7 = await inputBox();
ok('一行正好装下，和空框一样高', b1.h === 42, { h1: b1.h });
ok('两行时比一行高', b2.h > b1.h, { h1: b1.h, h2: b2.h });
ok('两行还没到顶，不滚', b2.overflowY === 'hidden', b2);
ok('到顶后卡在 120px 不再长', b7.h === 120, b7);
ok('到顶后出现滚动条', b7.overflowY === 'auto', b7);
ok('框内文字确实超出可视高度（真的会滚）', b7.scrollH > b7.clientH, b7);

console.log('\n【3】设置页两个开关都在');
await openSettings();
const ui = await page.evaluate(() => {
  const h = [...document.querySelectorAll('#s-input-h button')];
  const e = [...document.querySelectorAll('#s-enter-send button')];
  return { hCount: h.length, hOn: h.filter(x => x.classList.contains('on')).map(x => x.textContent.trim()),
           eCount: e.length, eOn: e.filter(x => x.classList.contains('on')).map(x => x.textContent.trim()),
           note: (document.getElementById('s-input-h-note') || {}).textContent };
});
ok('高度五档都在', ui.hCount === 5, ui);
ok('当前档高亮在 3 行', ui.hOn.length === 1 && ui.hOn[0] === '3 行', ui);
ok('回车两档都在', ui.eCount === 2, ui);
ok('当前档高亮在「回车就发」', ui.eOn.length === 1 && ui.eOn[0] === '回车就发', ui);
ok('说明行写的是当前行数', String(ui.note).indexOf('3 行') >= 0, ui);

console.log('\n【4】在设置页点「8 行」，回聊天当场长高');
const hit8 = await pickSeg('s-input-h', '8 行');
const note8 = await page.$eval('#s-input-h-note', el => el.textContent);
await backToChat();
b = await inputBox();
ok('点得动 8 行', hit8 === true);
ok('说明行跟着改成 8 行', String(note8).indexOf('8 行') >= 0, note8);
ok('回到聊天：上限当场变成 320px', b.maxH === '320px', b);
await setInput('一\n二\n三\n四\n五\n六\n七\n八');
b = await inputBox();
// 八行 = 8 × 21（行高）+ 20（上下内边距）= 188；老版本到 120 就封顶了，现在跟着设置走
ok('八行真的长到 188px（不再是 120 封顶）', b.h === 188, b);
await setInput('一\n二\n三\n四\n五\n六\n七\n八\n九\n十\n十一\n十二\n十三\n十四\n十五\n十六');
b = await inputBox();
ok('超过上限后卡在 320px', b.h === 320, b);
ok('超过上限后在框里滚', b.overflowY === 'auto', b);

console.log('\n【5】切「回车换行」这一档');
await openSettings();
await pickSeg('s-enter-send', '回车换行');
await backToChat();
await setInput('写了一半');
c = await countBox();
ok('这一档才显示字数', c.text === '已写 4 字', c);
ok('字数真的画出来了（不是 display:none）', c.shown === true, c);
const n0 = await msgCount();
await page.focus('#input');
await page.keyboard.press('Enter');
await sleep(800);
const n1 = await msgCount();
ok('回车不发送了', n1 === n0, { n0, n1 });
b = await inputBox();
ok('内容留下了，而且是换行不是发出去', b.val.indexOf('写了一半') === 0 && b.val.indexOf('\n') >= 0, b);
c = await countBox();
ok('换行后字数跟着涨', c.text === '已写 5 字', c);
await page.keyboard.down('Shift');
await page.keyboard.press('Enter');
await page.keyboard.up('Shift');
await sleep(400);
c = await countBox();
ok('Shift+Enter 也是换行', c.text === '已写 6 字', c);

console.log('\n【6】切回「回车就发」，回车真的发得出去');
await openSettings();
await pickSeg('s-enter-send', '回车就发');
await backToChat();
await setInput('回车发出去');
c = await countBox();
ok('切回这一档字数立刻消失', c.text === '', c);
const m0 = await msgCount();
await page.focus('#input');
await page.keyboard.press('Enter');
await sleep(1500);
const m1 = await msgCount();
ok('回车把消息发出去了（列表里多了一条）', m1 > m0, { m0, m1 });
b = await inputBox();
ok('发完框缩回 42px', b.h === 42, b);

ok('全程没有未捕获的 JS 错误', jsErrs.length === 0, jsErrs.slice(0, 5));

console.log('\n===== e2e-writer: ' + pass + ' 通过 / ' + fail + ' 失败 =====');
await browser.close();
server.close();
process.exit(fail ? 1 : 0);