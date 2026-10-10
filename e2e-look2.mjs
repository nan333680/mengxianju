import puppeteer from 'puppeteer-core';
import { seedChar, seedChars } from './e2e-helper.mjs';
import http from 'http'; import fs from 'fs'; import path from 'path';
// 工作目录自适应（原来写死 C:/A-DSH-Tool/ai-companion）
const R = path.resolve(import.meta.dirname).split(path.sep).join('/');
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
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 120000, args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = []; page.on('pageerror', e => errs.push(e.message));
page.on('dialog', async d => { await d.accept(); });
const sleep = ms => new Promise(r=>setTimeout(r,ms));
let pass=0, fail=0;
const t=(n,ok,ex='')=>{if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));}};
const jsClick = (s) => page.evaluate(x => document.querySelector(x).click(), s);
const dbChar = (name) => page.evaluate(async (n) => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const cs = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').getAll(); q.onsuccess = () => r(q.result); });
  db.close();
  const c = cs.find(x => x.name === n);
  return c ? { appearance: c.appearance, appearanceLive: c.appearanceLive, appearanceOn: c.appearanceOn } : null;
}, name);

await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
await sleep(1500);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil:'networkidle0' }); await sleep(400)   // [提速] 原 1800：探针实测 reload 后 app 就绪只要 ~1ms，1800 里有 800+ 是白等;

console.log('=== 1. 排版：按新顺序 ===');
await seedChar(page, '排版测试', { greeting: '（她看了你一眼）你来了。' });
await page.reload({ waitUntil:'networkidle0' }); await sleep(400)   // [提速] 原 1800：探针实测 reload 后 app 就绪只要 ~1ms，1800 里有 800+ 是白等;
await page.click('#btn-chars'); await sleep(700);
await page.evaluate(() => {
  const c = [...document.querySelectorAll('#char-list .char-card')]
    .find(x => x.textContent.includes('排版测试'));
  if (c) { const b = c.querySelector('[data-edit]'); if (b) b.click(); }
});
await sleep(1300);
t('进了编辑页', await page.$eval('#view-edit', el => el.classList.contains('active')));
await jsClick('#look-fold'); await sleep(600);
const order = await page.evaluate(() => {
  const inner = document.querySelector('#look-wrap .fold-inner');
  const kids = [...inner.children];
  const idx = (sel) => kids.findIndex(k => k.matches(sel) || k.querySelector(sel));
  return {
    on: idx('#e-look-on'),
    hint: kids.findIndex(k => k.classList.contains('hint-text')),
    box: idx('#e-look'),
    apply: idx('#e-look-apply'),
    clear: idx('#e-look-clearlive'),
    img: idx('#e-look-img'),
    n: kids.length,
    // 两个按钮在同一个 span.btns 里，容器索引相同 —— 得比容器内部的顺序
    btnOrder: (() => {
      // 限定在外貌块内 —— 设置页的「我的设定」也用了 .profile-foot
      const btns = [...document.querySelectorAll('#look-wrap .profile-foot .btns button')];
      return btns.map(b => b.textContent.trim());
    })(),
  };
});
console.log('   顺序: ' + JSON.stringify(order));
t('开关在最上面', order.on === 0, JSON.stringify(order));
t('开关下面有提示', order.hint > order.on, JSON.stringify(order));
t('提示下面是文本框', order.box > order.hint, JSON.stringify(order));
t('文本框下面是两个按钮', order.apply > order.box && order.clear > order.box);
t('「立即生效」在最右', order.btnOrder.join(',') === '清除,立即生效', JSON.stringify(order.btnOrder));
t('选图按钮在最下面', order.img > order.apply, JSON.stringify(order));

console.log('');
console.log('=== 2. 按钮文案 ===');
const labels = await page.evaluate(() => ({
  apply: document.getElementById('e-look-apply').textContent.trim(),
  clear: document.getElementById('e-look-clearlive').textContent.trim(),
  img: document.getElementById('e-look-img').textContent.trim(),
  on: document.querySelector('.look-switch span').textContent.trim(),
}));
console.log('   ' + JSON.stringify(labels));
t('开关叫「是否启用」', labels.on === '是否启用', labels.on);
t('有「立即生效」', labels.apply === '立即生效', labels.apply);
t('有「清除」', labels.clear === '清除', labels.clear);
t('有「选择图片」', labels.img === '选择图片', labels.img);

console.log('');
console.log('=== 3.「立即生效」独立保存，不看右上角 ✓ ===');
await page.evaluate(() => {
  const b = document.getElementById('e-look');
  b.value = '穿着紫色连衣裙，外套脱了搭在椅背上';
  b.dispatchEvent(new Event('input', { bubbles: true }));
});
await sleep(300);
t('还没保存时库里是空的', (await dbChar('排版测试')).appearance === '');
await jsClick('#e-look-apply'); await sleep(1200);
const afterApply = await dbChar('排版测试');
console.log('   库里: ' + JSON.stringify(afterApply));
// v1.14.0 起「立即生效」写的是临时层 appearanceLive（长期基线 appearance 由右上角 ✓ 写）
t('点一下就直接存了（写进临时层）', afterApply && (afterApply.appearanceLive || '').includes('紫色连衣裙'), JSON.stringify(afterApply));

console.log('');
console.log('=== 4. 立刻进 prompt（不用等保存）===');
await jsClick('#btn-edit-back'); await sleep(800);
await page.click('#btn-chars'); await sleep(600);
await page.evaluate(() => {
  const c = [...document.querySelectorAll('#char-list .char-card')]
    .find(x => x.textContent.includes('排版测试'));
  if (c) c.click();
});
await sleep(1200);
const p1 = await page.evaluate(async () => {
  const { buildStablePrompt } = await import('/js/persona.js');
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const cs = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').getAll(); q.onsuccess = () => r(q.result); });
  db.close();
  const c = cs.find(x => x.name === '排版测试');
  return buildStablePrompt(c, { ...c });
});
t('prompt 里有外貌段', p1.includes('# 你此刻的样子'));
t('prompt 里有刚写的内容', p1.includes('紫色连衣裙'));

console.log('');
console.log('=== 5.「清除」抹除并独立保存 ===');
await page.click('#btn-chars'); await sleep(600);
await page.evaluate(() => {
  const c = [...document.querySelectorAll('#char-list .char-card')]
    .find(x => x.textContent.includes('排版测试'));
  if (c) { const b = c.querySelector('[data-edit]'); if (b) b.click(); }
});
await sleep(1300);
await jsClick('#look-fold'); await sleep(500);
t('打开时框里有内容', (await page.$eval('#e-look', el => el.value)).includes('紫色连衣裙'));
await jsClick('#e-look-clearlive'); await sleep(700);
await jsClick('#modal-ok'); await sleep(1200);
const afterClear = await dbChar('排版测试');
console.log('   库里: ' + JSON.stringify(afterClear));
// v1.14.0 起「清除」= 丢掉临时层、回落到长期基线（不再清空用户输入）
t('清除后临时层被清空', afterClear && !(afterClear.appearanceLive || '').trim(), JSON.stringify(afterClear));
t('框里回落到长期基线（基线为空所以框也空）', (await page.$eval('#e-look', el => el.value)) === '');

console.log('');
console.log('=== 6. 开关也跟着独立存 ===');
await page.evaluate(() => { const c = document.getElementById('e-look-on'); c.checked = false; });
await jsClick('#e-look-apply'); await sleep(1200);
const offSaved = await dbChar('排版测试');
t('开关存成 false', offSaved && offSaved.appearanceOn === false, JSON.stringify(offSaved));

console.log('');
console.log('=== 7. 长按聊天里她的头像 → 进编辑页 ===');
await jsClick('#btn-edit-back'); await sleep(800);
await page.click('#btn-chars'); await sleep(600);
await page.evaluate(() => {
  const c = [...document.querySelectorAll('#char-list .char-card')]
    .find(x => x.textContent.includes('排版测试'));
  if (c) c.click();
});
await sleep(1300);
t('进了聊天页', await page.$eval('#view-chat', el => el.classList.contains('active')));
// 她的消息里应该有 av-her
const hasHerAv = await page.evaluate(() => document.querySelectorAll('.msg .av-her').length);
console.log('   av-her 数量: ' + hasHerAv);
t('她那条消息的头像有标记', hasHerAv > 0);

// 模拟长按：touchstart 后等 1.3 秒
await page.evaluate(() => {
  const av = document.querySelector('.msg .av-her');
  const ev = new TouchEvent('touchstart', { bubbles: true, cancelable: true });
  av.dispatchEvent(ev);
});
await sleep(1600);
t('长按后进了编辑页', await page.$eval('#view-edit', el => el.classList.contains('active')));
const editName = await page.$eval('#e-name', el => el.value);
t('编辑的正是她', editName === '排版测试', editName);

console.log('');
console.log('=== 8. 短按不该进（防误触）===');
await jsClick('#btn-edit-back'); await sleep(900);
t('回到聊天页', await page.$eval('#view-chat', el => el.classList.contains('active')));
await page.evaluate(() => {
  const av = document.querySelector('.msg .av-her');
  av.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true }));
});
await sleep(400);
await page.evaluate(() => {
  const av = document.querySelector('.msg .av-her');
  av.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true }));
});
await sleep(700);
t('短按没进编辑页', await page.$eval('#view-chat', el => el.classList.contains('active')));

console.log('');
console.log('=== 9. 长按头像：中途不该弹出消息菜单，最终进编辑页 ===');
await page.evaluate(() => {
  const av = document.querySelector('.msg .av-her');
  av.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true }));
});
await sleep(1400);
t('长按后进了编辑页', await page.$eval('#view-edit', el => el.classList.contains('active')));
t('长按头像没弹出消息菜单', (await page.$$('.msg-menu')).length === 0);

console.log('');
if (errs.length) console.log('  JS 错误: ' + JSON.stringify(errs.slice(0,3)));
t('无 pageerror', errs.length === 0, errs.slice(0,2).join(' | '));

console.log('');
console.log('========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close(); server.close();
process.exit(fail ? 1 : 0);