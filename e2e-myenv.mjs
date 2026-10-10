import puppeteer from 'puppeteer-core';
import { seedChar } from './e2e-helper.mjs';
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

// v1.15.2 起右上角 ⚙ 拉开【抽屉】，设置页要从抽屉里的「全部设置」进。
// 这个函数兼容两种点法，且可重复调用（已进设置页就直接返回）。
const openSettings = async (page, sleep) => {
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
    const b = [...document.querySelectorAll('#drawer-menu [data-wb-drawer]')].find(x => x.dataset.wbDrawer === 'settings');
    if (b) b.click();
  });
  await sleep(900);
};
let pass=0, fail=0;
const t=(n,ok,ex='')=>{if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));}};
const jsClick = s => page.evaluate(x => document.querySelector(x).click(), s);
await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
await sleep(1500);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil:'networkidle0' }); await sleep(400)   // [提速] 原 1800：探针实测 reload 后 app 就绪只要 ~1ms;
// v1.21.59：全新安装不再自动建角色（产品改空），测试自己塞一个
await seedChar(page, '测试角色', { greeting: '' });   // 空开场白：不额外多出一条消息
await page.reload({waitUntil:'networkidle0'}); await sleep(500);

console.log('=== 1. 角色编辑页：他的设定 / 他的居处 ===');
// ⚠️ v1.21.47：这两块从 ⚙ 设置搬到了【角色编辑页】，每个角色一份。
//    这一套原来测的是设置页那个大类，现在跟着搬（点聊天页顶部标题进编辑页）。
await page.evaluate(() => document.getElementById('chat-titletxt').click());
await sleep(900);
t('「他的设定」折叠头存在', !!(await page.$('#e-mine-fold')));
t('「他的居处」折叠头存在', !!(await page.$('#e-home-fold')));
t('居处输入框存在', !!(await page.$('#e-home')));
const collapsed = await page.evaluate(() => getComputedStyle(document.querySelector('#e-home-wrap')).gridTemplateRows);
t('默认收起时子项被折叠', collapsed === '0px' || collapsed.startsWith('0'), 'rows='+collapsed);
await jsClick('#e-mine-fold'); await sleep(500);
await jsClick('#e-home-fold'); await sleep(500);

console.log('=== 2. 居住环境：跟着角色一起保存 ===');
await page.evaluate(() => {
  const t = document.querySelector('#e-home');
  t.value = '住在城南老小区六层，卧室朝南，窗台有书和旧台灯，窗外几棵梧桐。';
  t.dispatchEvent(new Event('input', {bubbles:true}));
});
await sleep(300);
const cnt = await page.$eval('#e-home-count', e => e.textContent);
t('字数统计工作', /共 \d+ 字/.test(cnt), cnt);
// 角色页没有单独的保存按钮：内容跟着右上角 ✓ 一起进角色
await jsClick('#btn-edit-save'); await sleep(1300);
const saved = await page.evaluate(async () => {
  const { chars, kv } = await import('/js/db.js');
  const id = await kv.get('lastCharId', null);
  const c = await chars.get(id);
  return c ? c.myEnv : 'missing';
});
t('myEnv 写进了角色自己的字段', typeof saved === 'string' && saved.includes('梧桐'), String(saved).slice(0,30));

console.log('=== 3. 排版：无重叠 ===');
// 保存后回到了聊天页，重新进编辑页并把两块都展开（上面量的是展开态）
await page.evaluate(() => document.getElementById('chat-titletxt').click());
await sleep(900);
await jsClick('#e-mine-fold'); await sleep(500);
await jsClick('#e-home-fold'); await sleep(500);
// 只量【同一个父容器】里的兄弟 —— 跨容器比会把折叠容器的坐标也算进来，得出假重叠
const groups = await page.evaluate(() => {
  const pick = (sel) => {
    const inner = document.querySelector(sel);
    if (!inner) return [];
    return [...inner.children]
      .map(k => ({ id: k.id || k.className, r: k.getBoundingClientRect() }))
      .filter(x => x.r.height > 0)
      .map(x => ({ id: x.id, top: Math.round(x.r.top), bot: Math.round(x.r.bottom) }));
  };
  return { mine: pick('#e-mine-wrap .fold-inner'), home: pick('#e-home-wrap .fold-inner') };
});
for (const [name, list] of Object.entries(groups)) {
  console.log('   [' + name + '] ' + JSON.stringify(list));
  for (let i=1;i<list.length;i++) {
    const gap = list[i].top - list[i-1].bot;
    t('无重叠(' + name + '): ' + list[i-1].id + ' -> ' + list[i].id, gap >= 0, 'gap='+gap);
  }
}

console.log('=== 4. 外貌两层：立即生效 / 清除 ===');
const cid = await seedChar(page, '两层测试', { greeting:'（开场）', appearance: '长期：紫色洋服', appearanceLive: '' });
await page.reload({ waitUntil:'networkidle0' }); await sleep(400)   // [提速] 原 1800：探针实测 reload 后 app 就绪只要 ~1ms;
await page.click('#btn-chars'); await sleep(700);
await page.evaluate(() => {
  const c = [...document.querySelectorAll('#char-list .char-card')].find(x => x.textContent.includes('两层测试'));
  if (c) { const b = c.querySelector('[data-edit]'); if (b) b.click(); }
});
await sleep(1300);
await jsClick('#look-fold'); await sleep(600);
const initVal = await page.$eval('#e-look', e => e.value);
t('文本框显示长期基线', initVal.includes('紫色洋服'), initVal);
// 改内容 → 立即生效
await page.evaluate(() => {
  const t = document.querySelector('#e-look');
  t.value = '临时：穿着红色和服';
  t.dispatchEvent(new Event('input', {bubbles:true}));
});
await jsClick('#e-look-apply'); await sleep(1000);
const two = await page.evaluate(async (id) => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => o.onsuccess = () => r(o.result));
  const q = db.transaction('characters').objectStore('characters').get(id);
  const c = await new Promise(r => q.onsuccess = () => r(q.result));
  db.close();
  return { base: c.appearance, live: c.appearanceLive };
}, cid);
console.log('   立即生效后: ' + JSON.stringify(two));
t('长期基线未被改动', two.base.includes('紫色洋服'), two.base);
t('临时层写入新内容', two.live.includes('红色和服'), two.live);
// 点清除
await jsClick('#e-look-clearlive'); await sleep(700);
const modalShown = await page.evaluate(() => !document.querySelector('#modal').classList.contains('hidden'));
t('弹出确认框', modalShown);
await jsClick('#modal-ok'); await sleep(1400);
const afterClear = await page.evaluate(async (id) => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => o.onsuccess = () => r(o.result));
  const q = db.transaction('characters').objectStore('characters').get(id);
  const c = await new Promise(r => q.onsuccess = () => r(q.result));
  db.close();
  return { base: c.appearance, live: (c.appearanceLive||''), box: document.querySelector('#e-look').value };
}, cid);
console.log('   清除后: ' + JSON.stringify(afterClear));
t('清除后临时层为空', !afterClear.live.trim(), afterClear.live);
t('清除后长期基线还在', afterClear.base.includes('紫色洋服'), afterClear.base);
t('清除后文本框还原为长期基线', afterClear.box.includes('紫色洋服'), afterClear.box);

console.log('\nJS 错误: ' + (errs.length ? errs.join(' | ') : '无'));
t('无 JS 报错', errs.length === 0, errs.join(' | '));
console.log('\n结果: pass='+pass+' fail='+fail);
await browser.close(); server.close();
process.exit(fail?1:0);