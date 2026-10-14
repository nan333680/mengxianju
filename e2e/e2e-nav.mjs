import puppeteer from 'puppeteer-core';
import { seedChar, seedChars } from './e2e-helper.mjs';
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
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
const page = await browser.newPage();
// ⚠️ CI 的 runner 报 prefers-reduced-motion: reduce，而产品在那种情况下【故意】把 .view 的过渡关掉
//    （style.css 的 @media (prefers-reduced-motion: reduce)）—— 于是这套量到的位移恒为 0、
//    过渡时长恒为 0s，三条断言全红。这里显式要求"要有动画"，测的才是动画那条路径。
{
  const cdp = await page.target().createCDPSession();
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
}
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
const t=(n,ok,ex='')=>{ if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));} };
const view = () => page.evaluate(() => (document.querySelector('.view.active')||{}).id);
const chatName = () => page.$eval('#chat-name', el => el.textContent.trim());

await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
await sleep(1500);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil:'networkidle0' });
await sleep(400)   // [提速] 原 1800：探针实测 reload 后 app 就绪只要 ~1ms;

// 造 3 个角色（直接塞库，不依赖内置模板）
await seedChars(page, [{ name:'角色甲' }, { name:'角色乙' }, { name:'角色丙' }]);
await page.reload({ waitUntil:'networkidle0' }); await sleep(400)   // [提速] 原 1800：探针实测 reload 后 app 就绪只要 ~1ms;

console.log('=== 场景：在角色B的对话里 → 角色列表 → 编辑角色C → 逐层返回 ===');
await page.click('#btn-chars'); await sleep(400);
await page.evaluate(() => document.querySelectorAll('#char-list .char-card')[1].click());  // 选第 2 个角色
await sleep(700);
const whoB = await chatName();
t('已切到第 2 个角色的对话界面', await view() === 'view-chat', await view());
console.log('   当前角色: ' + whoB);

await page.click('#btn-chars'); await sleep(400);
t('打开角色列表', await view() === 'view-chars', await view());

await page.evaluate(() => document.querySelectorAll('#char-list .char-card button[data-edit]')[2].click());
await sleep(700);
t('进入第 3 个角色的编辑页', await view() === 'view-edit', await view());

await page.click('#btn-edit-back'); await sleep(500);
t('返回 → 回到角色列表（不是对话）', await view() === 'view-chars', await view());

await page.click('#btn-chars-back'); await sleep(500);
t('再返回 → 回到第 2 个角色的对话', await view() === 'view-chat', await view());
t('角色还是刚才那个', (await chatName()) === whoB, await chatName());

console.log('');
console.log('=== 新建角色那条路径也要能逐层退 ===');
await page.click('#btn-chars'); await sleep(400);
await page.click('#btn-new-char'); await sleep(600);
t('进入模板选择', await view() === 'view-preset', await view());
await page.evaluate(() => document.querySelectorAll('#preset-list .char-card')[0].click());
await sleep(600);
t('进入编辑页', await view() === 'view-edit', await view());
await page.click('#btn-edit-back'); await sleep(500);
t('返回 → 模板选择', await view() === 'view-preset', await view());
await page.click('#btn-preset-back'); await sleep(500);
t('再返回 → 角色列表', await view() === 'view-chars', await view());
await page.click('#btn-chars-back'); await sleep(500);
t('再返回 → 对话界面', await view() === 'view-chat', await view());

console.log('');
console.log('=== 记忆页与设置页也走同一条栈 ===');
await openSettings(page, sleep);
t('打开设置', await view() === 'view-settings', await view());
await page.click('#btn-set-back'); await sleep(500);
  // v1.15.2 起栈多了 drawer 一层，退到设置页的上一层是抽屉，还要再关一次
  await page.evaluate(() => { const b = document.getElementById('btn-drawer-close'); if (b && document.querySelector('#view-drawer.active')) b.click(); });
  await sleep(500);
// v1.15.2 起 ⚙ 开抽屉，栈多了 drawer 一层，要退两次才回聊天页
await sleep(500);
t('返回 → 对话界面', await view() === 'view-chat', await view());
// 记忆现在是设置页里的折叠面板，原地展开，不再跳页
await openSettings(page, sleep);
await page.click('#mem-fold'); await sleep(700);
t('展开折叠后仍停在设置页（没跳页）', await view() === 'view-settings', await view());
await page.click('#btn-set-back'); await sleep(500);
  // v1.15.2 起栈多了 drawer 一层，退到设置页的上一层是抽屉，还要再关一次
  await page.evaluate(() => { const b = document.getElementById('btn-drawer-close'); if (b && document.querySelector('#view-drawer.active')) b.click(); });
  await sleep(500);
await sleep(500);
t('一路退回对话界面', await view() === 'view-chat', await view());

console.log('');
console.log('=== 关掉软件再打开：回到上次那个角色 ===');
await page.click('#btn-chars'); await sleep(400);
await page.evaluate(() => document.querySelectorAll('#char-list .char-card')[2].click());
await sleep(700);
const whoC = await chatName();
await page.reload({ waitUntil:'networkidle0' });
await sleep(400)   // [提速] 原 2000：探针实测 reload 后 app 就绪只要 ~1ms;
t('重新打开后是对话界面', await view() === 'view-chat', await view());
t('而且是上次那个角色（' + whoC + '）', (await chatName()) === whoC, await chatName());

console.log('');
console.log('');
console.log('=== 转场：两页同时在动（不是闪一下）===');
const X = (id) => page.evaluate((id) => {
  const el = document.querySelector(id);
  return Math.round(new DOMMatrixReadOnly(getComputedStyle(el).transform).m41);
}, id);
const durOf = (id) => page.evaluate((id) => getComputedStyle(document.querySelector(id)).transitionDuration, id);
await page.click('#btn-chars');
await sleep(130);
const midC = await X('#view-chat'), midS = await X('#view-chars');
console.log('   打开角色列表中途: 对话页=' + midC + 'px  角色列表=' + midS + 'px');
t('角色列表从左边推出来', midS < 0, 'chars=' + midS);
t('对话页留在原地被盖住（不跟着动）', midC === 0, 'chat=' + midC);
await sleep(500);
t('停下后角色列表归位到 0', (await X('#view-chars')) === 0, String(await X('#view-chars')));
t('过渡时长 0.36s', Math.abs(parseFloat(await durOf('#view-chars')) - 0.36) < 0.06, await durOf('#view-chars'));
await page.click('#btn-chars-back');
await sleep(130);
const bC = await X('#view-chat'), bS = await X('#view-chars');
console.log('   返回中途: 对话页=' + bC + 'px  角色列表=' + bS + 'px');
t('返回时角色列表收回左边', bS < 0, 'chars=' + bS);
await sleep(500);
t('返回后对话页回到 0', (await X('#view-chat')) === 0, String(await X('#view-chat')));

console.log('');
console.log('=== 逐帧采样：chat -> chars -> 返回 ===');
const framewise = async (label, fn) => {
  const xs = [];
  const t0 = Date.now();
  await fn();
  while (Date.now() - t0 < 460) {
    xs.push({ t: Date.now() - t0, c: await X('#view-chat'), s: await X('#view-chars'), cls: await page.evaluate(() => document.querySelector('#view-chars').className), z: await page.evaluate(() => new Set([...document.querySelectorAll('.view')].map(v => getComputedStyle(v).zIndex)).size) });
    await sleep(45);
  }
  console.log('   ' + label);
  for (const r of xs) console.log('     t=' + String(r.t).padStart(3) + 'ms  chat=' + String(r.c).padStart(5) + '  chars=' + String(r.s).padStart(5) + '   [' + r.cls + ']  不同z层数=' + r.z);
};
await framewise('点 ☰ 打开角色列表', async () => { await page.click('#btn-chars'); });
await sleep(500);
await framewise('点左上角返回', async () => { await page.click('#btn-chars-back'); });
await sleep(300);

console.log('');
console.log('=== 深层页面仍然从右边进 ===');
await page.click('#btn-chars'); await sleep(500);
await page.evaluate(() => document.querySelectorAll('#char-list .char-card button[data-edit]')[0].click());
await sleep(130);
const eS = await X('#view-edit'), eC = await X('#view-chars');
console.log('   进入编辑页中途: 编辑页=' + eS + 'px  角色列表=' + eC + 'px');
t('编辑页从右边推入', eS > 0, 'edit=' + eS);
t('角色列表向左让位（约 -28%）', eC < 0, 'chars=' + eC);
await sleep(500);
await page.click('#btn-edit-back'); await sleep(500);
await page.click('#btn-chars-back'); await sleep(500);

t('全程无 JS 错误', errs.length === 0, errs.slice(0,3).join(' | '));
console.log('');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close(); server.close();
process.exit(fail>0?1:0);
