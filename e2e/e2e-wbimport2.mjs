// 世界书导入的第二套（v0.4.1.3）—— 起因是用户实测反馈：
//   「为什么导入没用？几个导入功能都试了，一个报错两个显提示导入成功了但没显示」
// 调查结论（用他本人那份导出文件复现）：
//   ① 世界书总开关【默认关着】→ 导入报成功却一条不注入；
//   ② 关着时「全局设置 / 单独角色」两个入口是 disabled，点了一点反应都没有
//      → 用户看到的正是「提示导入成功了但没显示」（他连内容都进不去）；
//   ③ 在「单独角色」页点 ⤓ 导入整份世界书文件时，只吃 data.groups 那一支，
//      solo 的条目一条都进不来（实测：导入前后 solo 都是 34 条 = 白导）。
// 这套把三条都钉住。
import puppeteer from 'puppeteer-core';
import { seedChars, pickImportMode } from './e2e-helper.mjs';
import http from 'http'; import fs from 'fs'; import path from 'path';
const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');
const WWW = R + '/www';
const FIX = R + '/_fixtures';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8' };
fs.mkdirSync(FIX, { recursive: true });
// 形状与用户那份「梦弦居世界书-博丽灵梦.json」一致：charNames + groups + solo
const wbFile = FIX + '/worldbook-full.json';
fs.writeFileSync(wbFile, JSON.stringify({
  version: 1, kind: 'worldbook', exportedAt: Date.now(),
  charNames: [{ id: 'reimu0v1', name: '灵梦' }],
  groups: [{ id: 'gsg-home', name: '他 · 住处与家', members: ['reimu0v1'], createdAt: Date.now(),
    entries: [{ id:'g1', title:'他·这个家', keys:[], content:'住在八楼。', on:true, pos:'always' }] }],
  solo: [{ id: 'solo-reimu', charId: 'reimu0v1', entries: [
    { id:'s1', title:'灵·处境', keys:[], content:'她不当巫女了。', on:true, pos:'always' },
    { id:'s2', title:'灵·飞行', keys:['飞'], content:'她可以停在空中。', on:true, pos:'front' },
  ]}],
}), 'utf8');
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
let pass=0, fail=0;
const t=(n,ok,ex='')=>{if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));}};
const openWb = async () => {
  await page.evaluate(() => document.getElementById('btn-settings').click()); await sleep(700);
  await page.evaluate(() => { const b=[...document.querySelectorAll('#drawer-menu [data-wb-drawer]')].find(x=>x.dataset.wbDrawer==='worldbook'); if(b) b.click(); }); await sleep(800);
};
const setSwitch = async (val) => {
  await page.evaluate((v) => { const el=document.getElementById('s-wb-on'); el.checked=v; el.dispatchEvent(new Event('change')); }, val); await sleep(600);
};
const toastText = () => page.evaluate(() => { const el=document.getElementById('toast'); return el ? el.textContent : ''; });
await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
await sleep(1200);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil:'networkidle0' }); await sleep(500);
await seedChars(page, [{ id:'reimu0v1', name:'灵梦' }]);
await page.reload({ waitUntil:'networkidle0' }); await sleep(700);
console.log('=== 1. 新装默认：世界书总开关是开的 ===');
await openWb();
t('总开关默认开着（导入的东西直接生效）', await page.evaluate(() => document.getElementById('s-wb-on').checked) === true);
t('关着时的提示条此时不存在', await page.evaluate(() => !document.getElementById('wb-off-warn')));
console.log('=== 2. 关掉开关：入口不许变灰，要有醒目提示 ===');
await setSwitch(false);
const off = await page.evaluate(() => ({ warn: !!document.getElementById('wb-off-warn'), warnText: (document.getElementById('wb-off-warn')||{}).textContent || '', gDis: document.getElementById('btn-wb-global').disabled, sDis: document.getElementById('btn-wb-solo').disabled, gCls: document.getElementById('btn-wb-global').classList.contains('disabled') }));
t('出现了「关着」提示条', off.warn);
t('提示条写明不会注入', /不会注入/.test(off.warnText), off.warnText);
t('全局设置入口不再 disabled', !off.gDis, JSON.stringify(off));
t('单独角色入口不再 disabled', !off.sDis, JSON.stringify(off));
t('单独角色入口不再带 disabled 类', (await page.evaluate(() => document.getElementById('btn-wb-solo').classList.contains('disabled'))) === false);
console.log('=== 3. 关着时导入 → 自动打开 + 说清 ===');
await (await page.$('#wb-import-file')).uploadFile(wbFile); await sleep(3000);
const to = await toastText();
const st = await page.evaluate(async () => { const { wb } = await import('./js/db.js'); const gs = await wb.groups(); const ss = await wb.soloAll(); return { sw: document.getElementById('s-wb-on').checked, groups: gs.map(g=>({name:g.name,members:g.members,n:(g.entries||[]).length})), solo: ss.map(s=>({charId:s.charId,n:(s.entries||[]).length})), warn: !!document.getElementById('wb-off-warn') }; });
console.log('   toast: ' + to);
t('导入报的数量对', /已导入 1 个角色组、1 个角色的单独设定/.test(to), to);
t('toast 说明已帮他把开关打开', /已帮你打开/.test(to), to);
t('开关真的变成开', st.sw === true);
t('提示条跟着消失', !st.warn);
t('组落库且成员正确', st.groups.length === 1 && st.groups[0].members[0] === 'reimu0v1', JSON.stringify(st.groups));
t('单独设定落库', st.solo.length === 1 && st.solo[0].n === 2, JSON.stringify(st.solo));
console.log('=== 4. 关着也能进去看（原来点了没反应）===');
await setSwitch(false);
await page.evaluate(() => document.getElementById('btn-wb-global').click()); await sleep(800);
const gv = await page.evaluate(() => ({ view: document.querySelector('#view-wbglobal').classList.contains('active'), text: (document.getElementById('wb-group-list')||{}).innerText || '' }));
t('关着也能进「全局设置」', gv.view);
t('组列表显示得出来', /住处与家/.test(gv.text) && /灵梦/.test(gv.text), gv.text);
await page.evaluate(() => document.getElementById('btn-wbg-back').click()); await sleep(600);
await page.evaluate(() => document.getElementById('btn-wb-solo').click()); await sleep(700);
await page.evaluate(() => { const r=document.querySelector('#pk-list .pick-row'); if(r) r.click(); }); await sleep(900);
const sv = await page.evaluate(() => ({ view: document.querySelector('#view-wbsolo').classList.contains('active'), items: document.querySelectorAll('#wbs-list .wb-item').length }));
t('关着也能进「单独角色」', sv.view);
t('条目看得见（2 条）', sv.items === 2, 'items=' + sv.items);
console.log('=== 5. 单独角色页导入整份世界书 → 吃自己那份 solo，不吃组的 ===');
await page.evaluate(async () => { const { wb } = await import('./js/db.js'); const ss = await wb.soloAll(); for (const s of ss) await wb.putSolo({ ...s, entries: [] }); });
await page.reload({ waitUntil:'networkidle0' }); await sleep(700);
await openWb();
const before5 = await page.evaluate(async () => { const { wb } = await import('./js/db.js'); const ss = await wb.soloAll(); return ss.length ? ss[0].entries.length : -1; });
t('先把 solo 条目清成 0', before5 === 0, 'before=' + before5);
await setSwitch(true);
await page.evaluate(() => document.getElementById('btn-wb-solo').click()); await sleep(700);
await page.evaluate(() => { const r=document.querySelector('#pk-list .pick-row'); if(r) r.click(); }); await sleep(800);
await (await page.$('#wbs-import-file')).uploadFile(wbFile); await sleep(2500);
const solo5 = await page.evaluate(async () => { const { wb } = await import('./js/db.js'); const ss = await wb.soloAll(); const gs = await wb.groups(); return { soloN: ss.length ? ss[0].entries.length : -1, titles: ss.length ? ss[0].entries.map(e=>e.title) : [], groupN: gs.length ? gs[0].entries.length : -1, items: document.querySelectorAll('#wbs-list .wb-item').length, toast: document.getElementById('toast').textContent }; });
console.log('   ' + JSON.stringify(solo5));
t('进的是该角色的 solo 条目（2 条）', solo5.soloN === 2, JSON.stringify(solo5));
t('进的是「灵·处境 / 灵·飞行」', solo5.titles.join(',') === '灵·处境,灵·飞行', solo5.titles.join(','));
t('界面当场渲染出来', solo5.items === 2, 'items=' + solo5.items);
console.log('=== 6. 本机没有这个角色：不许报假成功 ===');
await page.evaluate(async () => {
  const { chars, wb } = await import('./js/db.js');
  for (const c of await chars.all()) await chars.del(c.id);
  const gs = await wb.groups(); for (const g of gs) await wb.delGroup(g.id);
  const ss = await wb.soloAll(); for (const s of ss) await wb.delSolo(s.id);
});
await seedChars(page, [{ id:'other-1', name:'魔理沙' }]);
await page.reload({ waitUntil:'networkidle0' }); await sleep(700);
await openWb(); await setSwitch(false);
await (await page.$('#wb-import-file')).uploadFile(wbFile); await sleep(3000);
const to6 = await toastText();
console.log('   toast: ' + to6);
t('如实报「跳过本机不存在的角色」', /跳过 2 个本机不存在的角色/.test(to6), to6);
t('并且说明那个组暂时不生效', /暂时对谁都不生效/.test(to6), to6);
console.log('=== 7. 「导入数据」这条路也把开关打开 ===');
await page.evaluate(async () => { const { wb } = await import('./js/db.js'); const gs = await wb.groups(); for (const g of gs) await wb.delGroup(g.id); const ss = await wb.soloAll(); for (const s of ss) await wb.delSolo(s.id); });
await setSwitch(false);
await page.evaluate(() => { document.getElementById('btn-settings').click(); }); await sleep(600);
await page.evaluate(() => { const b=[...document.querySelectorAll('#drawer-menu [data-wb-drawer]')].find(x=>x.dataset.wbDrawer==='settings'); if(b) b.click(); }); await sleep(700);
await (await page.$('#file-import')).uploadFile(wbFile); await sleep(2000);
const okMode = await pickImportMode(page, 'wb', sleep); await sleep(2500);
const st7 = await page.evaluate(async () => { const { wb } = await import('./js/db.js'); return { sw: (await import('./js/db.js')).kv ? true : true, groups: (await wb.groups()).length, solo: (await wb.soloAll()).length, toast: document.getElementById('toast').textContent }; });
const sw7 = await page.evaluate(() => document.getElementById('s-wb-on') ? document.getElementById('s-wb-on').checked : null);
console.log('   ' + JSON.stringify(st7) + ' sw=' + sw7);
t('弹窗走过来了', okMode === true);
t('世界书进库了', st7.groups === 1 && st7.solo === 1, JSON.stringify(st7));
const swAfter = await page.evaluate(async () => { const { kv } = await import('./js/db.js'); const s = await kv.get('settings'); return s ? s.worldbookOn : null; });
t('开关被打开并落盘', swAfter === true, 'worldbookOn=' + swAfter);
console.log('\nJS 错误: ' + (errs.length ? errs.join(' | ') : '无'));
t('无 JS 报错', errs.length === 0, errs.join(' | '));
console.log('\n结果: pass='+pass+' fail='+fail);
await browser.close(); server.close();
process.exit(fail?1:0);