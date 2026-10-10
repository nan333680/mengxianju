
import puppeteer from 'puppeteer-core';
import { waitIdle, tap, seedChar } from './e2e-helper.mjs';
import http from 'http';
import fs from 'fs';
import path from 'path';
// 工作目录自适应（原来写死 C:/A-DSH-Tool/ai-companion）
const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');

// [提速] 批量替换时统一用了 sleep(N) 写法，这里补上定义
const sleep = ms => new Promise(r => setTimeout(r, ms));

const WWW = `${R}/www`;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const KEY = process.env.DSH_API_KEY || 'sk-test';
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
const errs = [];
page.on('pageerror', e => errs.push(e.message));

let pass=0, fail=0;
const t=(n,ok,ex='')=>{ if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));} };

await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
await new Promise(r=>setTimeout(r,1600));
// v1.21.59：全新安装不再自动建角色（产品改空），测试自己塞一个
await seedChar(page, '测试角色', { greeting: '' });   // 空开场白：不额外多出一条消息
await page.reload({waitUntil:'networkidle0'}); await new Promise(r=>setTimeout(r,900));
await tap(page, '#btn-settings');
await new Promise(r => setTimeout(r, 800));
// v1.15.2 起 ⚙ 拉开抽屉，设置页要从抽屉里的「全部设置」进
await page.evaluate(() => {
  const b = [...document.querySelectorAll('#drawer-menu [data-wb-drawer]')].find(x => x.dataset.wbDrawer === 'settings');
  if (b) b.click();
});
await new Promise(r=>setTimeout(r,500));
await page.$eval('#s-apikey',(el,k)=>{el.value=k;el.dispatchEvent(new Event('change',{bubbles:true}));},KEY);
await tap(page, '#btn-set-back');
await new Promise(r=>setTimeout(r,500));

// 造几条消息
for (let i = 1; i <= 3; i++) {
  await tap(page, '#input');
  await page.type('#input', '测试消息' + i, { delay: 6 });
  // ⚠️ 必须用 evaluate 点击，不能用 page.click()。
// page.click 走真实鼠标事件，要求元素在视口内且没被遮挡；
// 这个布局下点击会静默落空（不报错、不发消息），测试却以为发过了。
// 血泪第 9 条记的就是这个坑。实测：page.click → msg=1；evaluate 点击 → msg=3。
await page.evaluate(() => document.getElementById('btn-send').click());
  await waitIdle(page);   // 先等按钮出现、再等它消失
}

const msgCount = await page.$$eval('.msg', els => els.length);
console.log('  消息总数: ' + msgCount);

console.log('');
console.log('=== 新消息有出场动画，全量重绘不重播 ===');
const anim = await page.evaluate(() => {
  const el = document.querySelector('.msg.fresh');
  if (!el) return null;
  const cs = getComputedStyle(el);
  return { name: cs.animationName, dur: cs.animationDuration };
});
t('刚发出的消息带出场动画', !!anim, '没找到 .fresh 元素');
t('动画是 msgIn 且时长合理', !!anim && anim.name === 'msgIn' && parseFloat(anim.dur) > 0.1 && parseFloat(anim.dur) < 0.4, JSON.stringify(anim));
// 切换角色会 renderMessages 全量重绘 —— 这时不该带 fresh，否则几十条一起飞
const nap = (ms) => new Promise(r => setTimeout(r, ms));
await tap(page, '#btn-chars'); await nap(500);
await page.evaluate(() => { const c = document.querySelectorAll('#char-list .char-card')[0]; if (c) c.click(); });
await nap(900);
const freshLeft = await page.$$eval('.msg.fresh', els => els.length);
t('全量重绘后没有 fresh（不会几十条一起飞）', freshLeft === 0, 'fresh 数量=' + freshLeft);

console.log('');
console.log('=== 1. 菜单不会堆叠 ===');
const longPress = async (idx) => {
  // 先清掉已有菜单：菜单现在贴着消息弹，可能正好盖住目标消息，让长按落空。
  // （真实使用里用户也会先点别处关掉菜单再长按下一条）
  await page.evaluate(() => document.querySelectorAll('.msg-menu').forEach(m => m.remove()));
  // 先把目标消息滚进视口。否则消息一多它就在屏幕外，长按的是屏幕坐标，
  // touchstart 落不到 .msg 上，测的是空气（旧版脚本因此假通过）。
  const ok = await page.evaluate((i) => {
    const el = document.querySelectorAll('.msg')[i];
    if (!el) return false;
    el.scrollIntoView({ block: 'center' });
    return true;
  }, idx);
  if (!ok) { console.log('    (跳过：.msg[' + idx + '] 不存在)'); return; }
  await new Promise(r=>setTimeout(r,300));
  const box = await page.evaluate((i) => {
    const el = document.querySelectorAll('.msg')[i];
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width/2, y: r.y + r.height/2 };
  }, idx);
  await page.touchscreen.touchStart(box.x, box.y);
  await new Promise(r=>setTimeout(r,750));
  await page.touchscreen.touchEnd();
  await new Promise(r=>setTimeout(r,400));
};

await longPress(1);
let n = await page.$$eval('.msg-menu', els => els.length);
t('长按第1条 → 出现1个菜单', n === 1, '数量='+n);

await longPress(2);
n = await page.$$eval('.msg-menu', els => els.length);
t('再长按第2条 → 仍只有1个菜单（旧的被清掉）', n === 1, '数量='+n);

await longPress(0);
n = await page.$$eval('.msg-menu', els => els.length);
t('再长按第0条 → 仍只有1个菜单', n === 1, '数量='+n);

await longPress(3);
n = await page.$$eval('.msg-menu', els => els.length);
t('连续第4次长按 → 还是只有1个', n === 1, '数量='+n);

console.log('');
console.log('=== 2. 点外部关闭 ===');
await page.mouse.click(200, 120);   // 点顶部空白区
await new Promise(r=>setTimeout(r,400));
n = await page.$$eval('.msg-menu', els => els.length);
t('点空白处 → 菜单消失', n === 0, '数量='+n);

console.log('');
console.log('=== 3. 点取消关闭 ===');
await longPress(1);
n = await page.$$eval('.msg-menu', els => els.length);
t('菜单出现', n === 1);
await tap(page, '.msg-menu [data-k="cancel"]');
await new Promise(r=>setTimeout(r,400));
n = await page.$$eval('.msg-menu', els => els.length);
t('点取消 → 消失', n === 0, '数量='+n);

console.log('');
console.log('=== 4. 删除只影响被删的那条 ===');
const before = await page.$$eval('.msg', els => els.length);
// 内容要在长按前取：longPress 会滚动列表
const textsBefore = await page.$$eval('.msg .bub', els => els.map(e=>e.textContent.trim()));
await longPress(1);
await tap(page, '.msg-menu [data-k="del"]');
// ⚠️ 改成【轮询等待】而不是固定 700ms（v1.21.37）：
// del 分支现在会 await tidyNow()（一次 API 调用，无 mock 时也可能较慢），
// 固定等待会读到还没删完的中间状态。
await tap(page, '.msg-menu [data-k="del"]');
for (let _w = 0; _w < 40; _w++) {
  await new Promise(r=>setTimeout(r,250));
  const _n = await page.$$eval('.msg', els => els.length);
  if (_n === before - 1) break;
}
const after = await page.$$eval('.msg', els => els.length);
const textsAfter = await page.$$eval('.msg .bub', els => els.map(e=>e.textContent.trim()));
t('消息数减少 1', after === before - 1, before + ' -> ' + after);
// 被删的是 index 1，其余条目应按原顺序原样保留。
// 旧断言拿“前两条”比对，而被删的正好在里面，删后 index 1 变成原 index 2 —— 永远不可能通过。
const expected = textsBefore.filter((_, i) => i !== 1);
t('只有被删的那条消失，其余内容与顺序不变',
  JSON.stringify(textsAfter) === JSON.stringify(expected),
  '期望 ' + expected.length + ' 条，实际 ' + textsAfter.length + ' 条');

console.log('');
console.log('=== 5. 长列表渲染耗时 ===');
// 塞 200 条消息进 DB 再渲染，测耗时
await page.evaluate(async () => {
  const open = indexedDB.open('ai-companion');
  const db = await new Promise(r => { open.onsuccess = () => r(open.result); });
  const cs = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').getAll(); q.onsuccess = () => r(q.result); });
  const cid = cs[0].id;
  const tx = db.transaction('messages', 'readwrite');
  const st = tx.objectStore('messages');
  for (let i = 0; i < 200; i++) {
    st.put({ id: 'bulk-' + i, charId: cid, role: i%2 ? 'user':'assistant', content: '压测消息 ' + i + ' 内容内容内容', ts: Date.now() - (200-i)*1000 });
  }
  await new Promise(r => { tx.oncomplete = r; });
  db.close();
});
await page.reload({ waitUntil:'networkidle0' });
await sleep(400)   // [提速] 原 2000：探针实测 reload 后 app 就绪只要 ~1ms;
const total = await page.$$eval('.msg', els => els.length);
console.log('  渲染消息数: ' + total);

const t0 = Date.now();
await tap(page, '#btn-chars');
await new Promise(r=>setTimeout(r,400));
await page.evaluate(() => {
  const c = [...document.querySelectorAll('.char-card')][0];
  if (c) c.click();
});
await new Promise(r=>setTimeout(r,900));
const cost = Date.now() - t0;
console.log('  切换角色并重绘耗时: ' + cost + 'ms');
t('200+ 条消息下切换角色 < 2.5s', cost < 2500, cost + 'ms');

t('无 JS 错误', errs.length === 0, errs.slice(0,2).join(' | '));

console.log('');
console.log('========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close();
server.close();
process.exit(fail>0?1:0);
