import puppeteer from 'puppeteer-core';
import { seedChar, seedChars } from './e2e-helper.mjs';
import http from 'http';
import fs from 'fs';
import path from 'path';
// 工作目录自适应（原来写死 C:/A-DSH-Tool/ai-companion）
const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');

const WWW = `${R}/www`;
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
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = [];
page.on('pageerror', e => errs.push(e.message));
const sleep = ms => new Promise(r=>setTimeout(r,ms));
let pass=0, fail=0;
const t=(n,ok,ex='')=>{ if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));} };

await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
await sleep(1500);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil:'networkidle0' });
await sleep(400)   // [提速] 原 1800：探针实测 reload 后 app 就绪只要 ~1ms;

// 建一个【带开场白】的角色并进去 —— 这个测试后面要断言
// 「清空后重新补的正是开场白」，所以角色必须有 greeting。
// 原来靠默认模板（键山雏有开场白），模板删了就得自己准备。
await seedChar(page, '清空测试', { greeting: '（她放下手里的杯子）你来了。' });
await page.reload({ waitUntil:'networkidle0' });
await sleep(400)   // [提速] 原 1800：探针实测 reload 后 app 就绪只要 ~1ms;
await page.click('#btn-chars'); await sleep(700);
await page.evaluate(() => {
  const c = [...document.querySelectorAll('#char-list .char-card')]
    .find(x => x.textContent.includes('清空测试'));
  if (c) c.click();
});
await sleep(1500);

const src = fs.readFileSync(WWW + '/js/app.js', 'utf8');
const openSettings = async () => {
  // 先退到聊天页：栈底是 chat，其它页面连点返回即可。
  // ⚠️ 只在 view-chat 时点 ⚙ 是不够的 —— 从角色列表/编辑页进来时
  //    当前页不是 chat，会跳过这一步，后续所有断言都打在不可见的页面上（踩过）。
  for (let i = 0; i < 6; i++) {
    const cur = await page.evaluate(() => (document.querySelector('.view.active') || {}).id);
    if (cur === 'view-chat') break;
    await page.evaluate(() => {
      const b = document.getElementById('btn-edit-back')
             || document.getElementById('btn-chars-back')
             || document.getElementById('btn-set-back')
             || document.getElementById('btn-drawer-close')
             || document.getElementById('btn-wb-back');
      if (b) b.click();
    });
    await sleep(500);
  }
  await page.evaluate(() => document.getElementById('btn-settings').click());
  await sleep(800);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('#drawer-menu [data-wb-drawer]')].find(x => x.dataset.wbDrawer === 'mine');
    if (b) b.click();
  });
  await sleep(900);
};
const backFromSettings = async () => { await page.click('#btn-mine-back'); await sleep(400);
  // v1.15.2 起栈多了 drawer 一层，退到设置页的上一层是抽屉，还要再关一次
  await page.evaluate(() => { const b = document.getElementById('btn-drawer-close'); if (b && document.querySelector('#view-drawer.active')) b.click(); });
  await sleep(500); };

console.log('=== 1. token 使用量开关存在 ===');
await openSettings();
t('设置页有「显示 token 使用量」', !!(await page.$('#s-showusage')));
t('老设置没这个键时默认勾上', (await page.$eval('#s-showusage', el => el.checked)) === true);

console.log('');
console.log('=== 2. 关掉后角标消失（实测渲染结果）===');
// 先塞一条带 usage 的消息进库
await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const chars = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').getAll(); q.onsuccess = () => r(q.result); });
  // 按名字取，别用 [0] —— 列表顺序不保证
  const cid = (chars.find(c => c.name === '清空测试') || chars[0]).id;
  await new Promise(r => { const q = db.transaction('messages','readwrite').objectStore('messages').put({
    id: 'm1', charId: cid, role: 'assistant', content: '测试回复',
    usage: { prompt_tokens: 111, completion_tokens: 22 }, ts: Date.now() }); q.onsuccess = () => r(); });
  db.close();
});
await backFromSettings();
await page.evaluate(() => document.querySelector('#messages').innerHTML = '');
// 切走再切回，触发重绘
await page.evaluate(() => location.reload());
await sleep(1800);
const onBadge = await page.evaluate(() => {
  const tk = document.querySelector('#messages .tk');
  return tk ? tk.textContent.trim() : null;
});
console.log('   开着时角标: ' + JSON.stringify(onBadge));
t('开着时能看到角标', !!onBadge && onBadge.includes('111'));

await openSettings();
await page.click('#s-showusage');            // 关掉
await sleep(900);
t('关掉后勾选框为未勾', (await page.$eval('#s-showusage', el => el.checked)) === false);
await backFromSettings();
const offBadge = await page.evaluate(() => document.querySelectorAll('#messages .tk').length);
console.log('   关掉后角标个数: ' + offBadge);
t('关掉后角标立刻消失（不用等下一次发消息）', offBadge === 0);
t('关掉后消息本身还在', (await page.$$eval('#messages .msg', e => e.length)) > 0);

console.log('');
console.log('=== 3. 重开设置，开关状态读得回来 ===');
await openSettings();
t('关掉的状态被记住', (await page.$eval('#s-showusage', el => el.checked)) === false);
await page.click('#s-showusage'); await sleep(700);   // 开回来
t('开回来后勾上', (await page.$eval('#s-showusage', el => el.checked)) === true);
await backFromSettings();

console.log('');
console.log('=== 4. 清空聊天记录：要点两次确认 ===');
t('清空按钮用的是自定义弹窗（不是原生 confirm）', /confirmBox\(\s*'清空聊天记录'/.test(src));
t('有第二层确认', /真的确定/.test(src));
t('清空后会重置 greeted 标记', /kv\.del\('greeted:' \+ id\)/.test(src));

await openSettings();
await page.click('#btn-clear-chat');
await sleep(600);
const d1 = await page.evaluate(() => {
  const m = document.querySelector('#modal');
  return { open: !m.classList.contains('hidden'), text: document.querySelector('#modal-text').textContent, ok: document.querySelector('#modal-ok').textContent };
});
console.log('   第一层: ' + JSON.stringify(d1));
t('第一层确认弹出来了', d1.open === true);
t('第一层说明了会变回新角色', d1.text.includes('刚创建时的样子'));
t('第一层说明了人设不动', d1.text.includes('人设'));
t('第一层说明了不能撤销', d1.text.includes('不能撤销'));

await page.click('#modal-cancel');   // 第一层取消
await sleep(500);
const afterCancel = await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const n = await new Promise(r => { const q = db.transaction('messages').objectStore('messages').count(); q.onsuccess = () => r(q.result); });
  db.close(); return n;
});
t('第一层取消 → 消息没被删', afterCancel > 0, '剩 ' + afterCancel);

console.log('');
console.log('=== 5. 第一层确定 → 还有第二层 ===');
await page.click('#btn-clear-chat');
await sleep(600);
await page.click('#modal-ok');       // 第一层确定
await sleep(600);
const d2 = await page.evaluate(() => {
  const m = document.querySelector('#modal');
  return { open: !m.classList.contains('hidden'), title: document.querySelector('#modal-title').textContent, ok: document.querySelector('#modal-ok').textContent };
});
console.log('   第二层: ' + JSON.stringify(d2));
t('第二层确认弹出来了', d2.open === true);
t('第二层标题是「真的确定？」', d2.title.includes('真的确定'));
const stillThere = await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const n = await new Promise(r => { const q = db.transaction('messages').objectStore('messages').count(); q.onsuccess = () => r(q.result); });
  db.close(); return n;
});
t('第二层还没点之前，消息仍然在（没提前删）', stillThere > 0, '剩 ' + stillThere);

console.log('');
console.log('=== 6. 第二层取消 → 依然不删 ===');
await page.click('#modal-cancel'); await sleep(600);
const afterCancel2 = await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const n = await new Promise(r => { const q = db.transaction('messages').objectStore('messages').count(); q.onsuccess = () => r(q.result); });
  db.close(); return n;
});
t('第二层取消 → 消息还在', afterCancel2 > 0, '剩 ' + afterCancel2);
t('弹窗已关闭', (await page.$eval('#modal', el => el.classList.contains('hidden'))) === true);

console.log('');
console.log('=== 7. 两层都确定 → 清空并变回新角色 ===');
const greetingBefore = await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const cs = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').getAll(); q.onsuccess = () => r(q.result); });
  db.close();
  const c = cs.find(x => x.name === '清空测试') || cs[0];
  return { name: c.name, greeting: c.greeting || '' };
});
console.log('   角色: ' + greetingBefore.name + ' / 开场白长度 ' + greetingBefore.greeting.length);
t('这个角色本来有开场白', greetingBefore.greeting.length > 0);

t('仍停在我的设置页', await page.$eval('#view-mine', el => el.classList.contains('active')));
// 统一用 JS 直接触发点击：弹窗有关闭动画，元素在动画期间不可点，
// 这不是功能问题，是测试的等待时机问题。
const jsClick = (sel) => page.evaluate(s => document.querySelector(s).click(), sel);
const waitModal = async (want, ms = 3000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const hidden = await page.$eval('#modal', el => el.classList.contains('hidden'));
    if (hidden !== want) return true;
    await sleep(80);
  }
  return false;
};
t('弹窗已关闭（关闭动画走完）', (await page.$eval('#modal', el => el.classList.contains('hidden'))) === true);
await jsClick('#btn-clear-chat'); await waitModal(false); await sleep(200);
t('第一层又弹出来了', (await page.$eval('#modal', el => el.classList.contains('hidden'))) === false);
await jsClick('#modal-ok'); await waitModal(false, 1500); await sleep(200);
await jsClick('#modal-ok'); await sleep(1800);

const after = await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const ms = await new Promise(r => { const q = db.transaction('messages').objectStore('messages').getAll(); q.onsuccess = () => r(q.result); });
  const cs = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').getAll(); q.onsuccess = () => r(q.result); });
  const kv = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').getAll(); q.onsuccess = () => r(q.result); });
  db.close();
  const mine = cs.find(x => x.name === '清空测试') || cs[0];
  const myMsgs = ms.filter(m => m.charId === mine.id);
  return { msgs: myMsgs.length, role: myMsgs[0] ? myMsgs[0].role : null,
           content: myMsgs[0] ? myMsgs[0].content : null,
           chars: cs.length, greeted: kv.filter(x => String(x.k).startsWith('greeted:')),
           name: mine.name, greeting: mine.greeting || '' };
});
console.log('   清空后: 消息数=' + after.msgs + ' 首条角色=' + after.role);
console.log('   角色数=' + after.chars + ' 名字=' + after.name + ' 人设长度=' + after.greeting.length);
t('旧记录确实被清光了（只剩开场白）', after.msgs === 1, '实际 ' + after.msgs);
t('重新补的正是开场白', after.content === after.greeting, JSON.stringify(after.content).slice(0,40));
t('人设没被动过', after.greeting.length === greetingBefore.greeting.length);
t('角色没被删', after.chars >= 1);
// 注意：补完开场白后 renderMessages 会立刻把 greeted 设回 true —— 这是对的，
// 否则每次重绘都会再补一次开场白。所以这里验证的是"开场白确实重新出现了"
// （上面那条），而不是"标记最终不存在"。
console.log('   greeted 最终状态: ' + JSON.stringify(after.greeted.map(x => x.k)));
t('清空后 greeted 被重新置位（不会再重复补开场白）', after.greeted.length === 1);
t('界面显示的是新角色状态（有开场白气泡）', (await page.$$eval('#messages .msg', e => e.length)) >= 1);

console.log('');
if (errs.length) console.log('  JS 错误: ' + JSON.stringify(errs));
t('全程无 JS 错误', errs.length === 0, errs.join(' | '));

console.log('');
console.log('========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close();
server.close();
process.exit(fail ? 1 : 0);
