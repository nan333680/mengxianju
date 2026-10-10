import puppeteer from 'puppeteer-core';
import { seedChars } from './e2e-helper.mjs';
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
await seedChars(page, [{name:'紫'},{name:'袿姬'}]);
await page.reload({ waitUntil:'networkidle0' }); await sleep(400)   // [提速] 原 2000：探针实测 reload 后 app 就绪只要 ~1ms;
// 开总开关
await openSettings(page, sleep);
await page.evaluate(() => {
  const b = [...document.querySelectorAll('#drawer-menu [data-wb-drawer]')].find(x => x.dataset.wbDrawer === 'worldbook');
  b.click();
});
await sleep(800);
await page.evaluate(() => { document.querySelector('#s-wb-on').click(); });
await sleep(800);

console.log('=== 单独角色：弹窗选人 ===');
await jsClick('#btn-wb-solo'); await sleep(800);
const pick = await page.evaluate(() => ({
  shown: !document.querySelector('#modal').classList.contains('hidden'),
  title: document.querySelector('#modal-title').textContent,
  rows: [...document.querySelectorAll('#pk-list .pick-row')].map(r => r.textContent.trim()),
  scrollable: (() => { const el = document.querySelector('#pk-list'); return el ? getComputedStyle(el).overflowY : ''; })(),
}));
console.log('   ' + JSON.stringify(pick));
t('弹出选角色窗', pick.shown);
t('标题是「选择角色」', pick.title === '选择角色', pick.title);
t('列出了角色', pick.rows.length >= 2, JSON.stringify(pick.rows));
t('列表可滑动（overflow auto/scroll）', /auto|scroll/.test(pick.scrollable), pick.scrollable);

console.log('=== 点角色 → 进编辑界面 ===');
await page.evaluate(() => {
  const r = [...document.querySelectorAll('#pk-list .pick-row')].find(x => x.textContent.includes('紫'));
  r.click();
});
await sleep(1000);
const soloPage = await page.evaluate(() => ({
  active: document.querySelector('#view-wbsolo').classList.contains('active'),
  title: document.querySelector('#wbs-title').textContent,
}));
console.log('   ' + JSON.stringify(soloPage));
t('进了单独角色编辑页', soloPage.active);
t('标题带角色名', soloPage.title.includes('紫'), soloPage.title);

console.log('=== 单独角色：加条目 ===');
await jsClick('#btn-wb-newentry2'); await sleep(700);
await page.evaluate(() => {
  document.querySelector('#we-title').value = '隙间';
  const inp = document.querySelector('#we-key-input');
  inp.value = '隙间'; inp.dispatchEvent(new KeyboardEvent('keydown', { key:'Enter', bubbles:true }));
});
await sleep(400);
await page.evaluate(() => { document.querySelector('#we-content').value = '隙间是紫开的空间裂隙。'; });
await jsClick('#modal-ok'); await sleep(1200);
const solo = await page.evaluate(async () => {
  const { wb } = await import('./js/db.js');
  const all = await wb.soloAll();
  return all.map(s => ({ charId: s.charId, n: (s.entries||[]).length, t: (s.entries||[])[0] ? s.entries[0].title : null }));
});
console.log('   ' + JSON.stringify(solo));
t('单独条目已保存', solo.length === 1 && solo[0].n === 1, JSON.stringify(solo));
t('条目标题正确', solo[0] && solo[0].t === '隙间');

console.log('=== 隔离性：只影响这一个角色 ===');
const iso = await page.evaluate(async () => {
  const { wb, chars } = await import('./js/db.js');
  const cs = await chars.all();
  const zi = cs.find(c => c.name === '紫');
  const kk = cs.find(c => c.name === '袿姬');
  const a = await wb.solo(zi.id);
  const b = await wb.solo(kk.id);
  return { zi: a ? a.entries.length : 0, keiki: b ? b.entries.length : 0 };
});
console.log('   ' + JSON.stringify(iso));
t('紫有 1 条', iso.zi === 1);
t('袿姬 0 条（不受影响）', iso.keiki === 0);

console.log('=== 组列自定义：改组名和成员 ===');
await page.evaluate(() => document.querySelector('#btn-wbs-back').click());
await sleep(700);
await jsClick('#btn-wb-global'); await sleep(700);
await jsClick('#btn-wb-newgroup'); await sleep(700);
await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#pk-list .pick-row')];
  rows[0].click();
  document.querySelector('#pk-name').value = '旧名';
});
await jsClick('#modal-ok'); await sleep(1200);
const gid = await page.evaluate(async () => {
  const { wb } = await import('./js/db.js');
  const gs = await wb.groups();
  return gs[0].id;
});
// 点「组列自定义」
await page.evaluate(() => document.querySelector('[data-wb-custom]').click());
await sleep(900);
const custom = await page.evaluate(() => ({
  shown: !document.querySelector('#modal').classList.contains('hidden'),
  title: document.querySelector('#modal-title').textContent,
  nameVal: document.querySelector('#pk-name') ? document.querySelector('#pk-name').value : null,
  selected: document.querySelectorAll('#pk-list .pick-row.on').length,
  hasDel: !!document.querySelector('#pk-del'),
}));
console.log('   ' + JSON.stringify(custom));
t('弹出自定义窗', custom.shown);
t('标题是「组列自定义」', custom.title === '组列自定义', custom.title);
t('回填了现有组名', custom.nameVal === '旧名', String(custom.nameVal));
t('回填了已选成员', custom.selected === 1, 'sel='+custom.selected);
t('有删除组按钮', custom.hasDel);
// 改名 + 加人
await page.evaluate(() => {
  document.querySelector('#pk-name').value = '新名字';
  const rows = [...document.querySelectorAll('#pk-list .pick-row')];
  const notSel = rows.find(r => !r.classList.contains('on'));
  if (notSel) notSel.click();
});
await jsClick('#modal-ok'); await sleep(1200);
const after = await page.evaluate(async (gid) => {
  const { wb } = await import('./js/db.js');
  const g = await wb.group(gid);
  return { name: g.name, members: (g.members||[]).length };
}, gid);
console.log('   ' + JSON.stringify(after));
t('组名已改', after.name === '新名字', after.name);
t('成员已加', after.members === 2, 'n='+after.members);

console.log('\nJS 错误: ' + (errs.length ? errs.join(' | ') : '无'));
t('无 JS 报错', errs.length === 0, errs.join(' | '));
console.log('\n结果: pass='+pass+' fail='+fail);
await browser.close(); server.close();
process.exit(fail?1:0);
