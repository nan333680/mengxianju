import puppeteer from 'puppeteer-core';
import { seedChars } from './e2e-helper.mjs';
import http from 'http'; import fs from 'fs'; import path from 'path';
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
await seedChars(page, [{name:'紫'},{name:'袿姬'},{name:'小恶魔'}]);
await page.reload({ waitUntil:'networkidle0' }); await sleep(400)   // [提速] 原 2000：探针实测 reload 后 app 就绪只要 ~1ms;

console.log('=== 1. 抽屉能拉开 ===');
// 这一条测的就是"点 ⚙ 直接拉出抽屉"，不能用 openSettings（那个会继续进设置页）
await page.evaluate(() => document.getElementById('btn-settings').click());
await sleep(800);
const drawerOpen = await page.evaluate(() => ({
  active: document.querySelector('#view-drawer').classList.contains('active'),
  chatStay: document.querySelector('#view-chat').classList.contains('stay'),
  items: document.querySelectorAll('#drawer-menu .drawer-item').length,
}));
console.log('   ' + JSON.stringify(drawerOpen));
t('抽屉拉出来了', drawerOpen.active);
t('聊天页原地不动（stay）', drawerOpen.chatStay);
t('菜单有内容', drawerOpen.items > 0);

console.log('=== 2. 世界书页：总开关默认关 → 入口灰 ===');
await page.evaluate(() => {
  const b = [...document.querySelectorAll('#drawer-menu [data-wb-drawer]')].find(x => x.dataset.wbDrawer === 'worldbook');
  b.click();
});
await sleep(900);
const wb0 = await page.evaluate(() => ({
  page: document.querySelector('#view-worldbook').classList.contains('active'),
  on: document.querySelector('#s-wb-on').checked,
  gDisabled: document.querySelector('#btn-wb-global').disabled,
  sDisabled: document.querySelector('#btn-wb-solo').disabled,
}));
console.log('   ' + JSON.stringify(wb0));
t('进了世界书页', wb0.page);
t('总开关默认关', wb0.on === false);
t('全局设置灰着（点不进去）', wb0.gDisabled === true);
t('单独角色灰着', wb0.sDisabled === true);

console.log('=== 3. 开总开关 → 入口变可用 ===');
await page.evaluate(() => { document.querySelector('#s-wb-on').click(); });
await sleep(900);
const wb1 = await page.evaluate(() => ({
  on: document.querySelector('#s-wb-on').checked,
  gDisabled: document.querySelector('#btn-wb-global').disabled,
  sDisabled: document.querySelector('#btn-wb-solo').disabled,
}));
t('开关变开', wb1.on === true);
t('全局设置可点了', wb1.gDisabled === false);
t('单独角色可点了', wb1.sDisabled === false);

console.log('=== 4. 全局设置：新建组（弹窗全选 + 命名）===');
await jsClick('#btn-wb-global'); await sleep(800);
const gPage = await page.evaluate(() => document.querySelector('#view-wbglobal').classList.contains('active'));
t('进了全局设置页', gPage);
await jsClick('#btn-wb-newgroup'); await sleep(800);
const picker = await page.evaluate(() => ({
  shown: !document.querySelector('#modal').classList.contains('hidden'),
  rows: document.querySelectorAll('#pk-list .pick-row').length,
  hasAll: !!document.querySelector('#pk-all'),
  allTxt: document.querySelector('#pk-all') ? document.querySelector('#pk-all').textContent : '',
}));
console.log('   ' + JSON.stringify(picker));
t('弹出选角色窗', picker.shown);
// 页面上除了塞的 3 个，还有 app 自动建的「空白角色」，所以是 4
t('列出所有角色', picker.rows >= 3, 'rows='+picker.rows);
t('有全选按钮', picker.hasAll);
t('全选框存在（可滑动列表）', picker.rows > 0);
// 全选
await jsClick('#pk-all'); await sleep(300);
const afterAll = await page.evaluate(() => ({
  on: document.querySelectorAll('#pk-list .pick-row.on').length,
  txt: document.querySelector('#pk-all').textContent,
}));
t('点全选 → 全部选中', afterAll.on === picker.rows, JSON.stringify(afterAll));
t('按钮变成"取消全选"', afterAll.txt.includes('取消'), afterAll.txt);
// 再点一次 = 全不选
await jsClick('#pk-all'); await sleep(300);
const afterNone = await page.evaluate(() => document.querySelectorAll('#pk-list .pick-row.on').length);
t('再点一下 → 全不选', afterNone === 0, 'on='+afterNone);
// 手动选 2 个 + 命名
await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#pk-list .pick-row')];
  rows[0].click(); rows[1].click();
  document.querySelector('#pk-name').value = '东方幻想乡';
});
await sleep(300);
await jsClick('#modal-ok'); await sleep(1200);
const grp = await page.evaluate(async () => {
  const { wb } = await import('./js/db.js');
  const gs = await wb.groups();
  return { n: gs.length, name: gs[0] ? gs[0].name : null, members: gs[0] ? gs[0].members.length : 0 };
});
console.log('   ' + JSON.stringify(grp));
t('组建成功', grp.n === 1 && grp.name === '东方幻想乡', JSON.stringify(grp));
t('2 个成员', grp.members === 2, 'members='+grp.members);
const rowText = await page.evaluate(() => document.querySelector('#wb-group-list').textContent);
t('列表里显示该组', rowText.includes('东方幻想乡'), rowText.slice(0,40));

console.log('=== 5. 点组名 → 进条目编辑 ===');
await page.evaluate(() => document.querySelector('#wb-group-list .wb-group .wg-body').click());
await sleep(900);
const ePage = await page.evaluate(() => ({
  active: document.querySelector('#view-wbentries').classList.contains('active'),
  title: document.querySelector('#wbe-title').textContent,
}));
console.log('   ' + JSON.stringify(ePage));
t('进了条目编辑页', ePage.active);
t('标题是组名', ePage.title === '东方幻想乡', ePage.title);

console.log('=== 6. 新建条目（触发词标签式）===');
await jsClick('#btn-wb-newentry'); await sleep(700);
await page.evaluate(() => {
  document.querySelector('#we-title').value = '红魔馆';
  const inp = document.querySelector('#we-key-input');
  inp.value = '红魔馆';
  inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
});
await sleep(400);
await page.evaluate(() => {
  const inp = document.querySelector('#we-key-input');
  inp.value = '帕秋莉';
  inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
});
await sleep(400);
const tagN = await page.evaluate(() => document.querySelectorAll('#we-box .key-tag').length);
t('回车生成 2 个触发词标签', tagN === 2, 'tags='+tagN);
await page.evaluate(() => {
  document.querySelector('#we-content').value = '红魔馆是蕾米莉亚的宅邸，帕秋莉住在里面的图书馆。';
});
await jsClick('#modal-ok'); await sleep(1200);
const ent = await page.evaluate(async () => {
  const { wb } = await import('./js/db.js');
  const gs = await wb.groups();
  const e = (gs[0].entries || [])[0];
  return e ? { title: e.title, keys: e.keys, len: e.content.length, on: e.on } : null;
});
console.log('   ' + JSON.stringify(ent));
t('条目已保存', ent && ent.title === '红魔馆', JSON.stringify(ent));
t('触发词存了 2 个', ent && ent.keys.length === 2, JSON.stringify(ent && ent.keys));
t('内容完整', ent && ent.len > 10);
const itemText = await page.evaluate(() => document.querySelector('#wbe-list').textContent);
t('列表显示条目', itemText.includes('红魔馆') && itemText.includes('帕秋莉'), itemText.slice(0,50));

console.log('\nJS 错误: ' + (errs.length ? errs.join(' | ') : '无'));
t('无 JS 报错', errs.length === 0, errs.join(' | '));
console.log('\n结果: pass='+pass+' fail='+fail);
await browser.close(); server.close();
process.exit(fail?1:0);