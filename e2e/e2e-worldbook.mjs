import puppeteer from 'puppeteer-core';
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
let pass=0, fail=0;
const t=(n,ok,ex='')=>{if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));}};
await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
await sleep(1500);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil:'networkidle0' }); await sleep(400)   // [提速] 原 1800：探针实测 reload 后 app 就绪只要 ~1ms;

console.log('=== 1. 数据库升级到 v2（老数据不能丢）===');
const info = await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => o.onsuccess = () => r(o.result));
  const stores = [...db.objectStoreNames];
  db.close();
  return { version: db.version, stores };
});
console.log('   ' + JSON.stringify(info));
t('有 wbGroups 表', info.stores.includes('wbGroups'));
t('有 wbSolo 表', info.stores.includes('wbSolo'));
t('老表都还在（characters/messages/kv/memories）',
  ['characters','messages','kv','memories'].every(s => info.stores.includes(s)), JSON.stringify(info.stores));

console.log('=== 2. 世界书数据读写 ===');
const dbTest = await page.evaluate(async () => {
  const { wb, uid } = await import('./js/db.js');
  const gid = uid();
  await wb.putGroup({ id: gid, name: '东方幻想乡', members: ['c1','c2'], entries: [
    { id: 'e1', title: '红魔馆', keys: ['红魔馆','帕秋莉'], content: '红魔馆是蕾米莉亚的宅邸。', on: true },
    { id: 'e2', title: '符卡', keys: ['符卡'], content: '符卡是弹幕规则。', on: true },
  ], createdAt: Date.now() });
  await wb.putSolo({ id: 's1', charId: 'c1', entries: [
    { id: 'e3', title: '隙间', keys: ['隙间'], content: '隙间是紫的空间裂隙。', on: true },
  ] });
  const gs = await wb.groups();
  const s1 = await wb.solo('c1');
  const s2 = await wb.solo('c2');
  return { groupCount: gs.length, gname: gs[0].name, members: gs[0].members, soloC1: s1 ? s1.entries.length : 0, soloC2: s2 };
});
console.log('   ' + JSON.stringify(dbTest));
t('组写入成功', dbTest.groupCount === 1 && dbTest.gname === '东方幻想乡');
t('成员保存正确', JSON.stringify(dbTest.members) === JSON.stringify(['c1','c2']));
t('单独角色条目按 charId 隔离', dbTest.soloC1 === 1 && dbTest.soloC2 === null);

console.log('=== 3. purgeChar 清理（删角色不留幽灵引用）===');
const purge = await page.evaluate(async () => {
  const { wb } = await import('./js/db.js');
  await wb.purgeChar('c1');
  const gs = await wb.groups();
  const s1 = await wb.solo('c1');
  return { members: gs[0].members, solo: s1 };
});
t('成员里去掉 c1', JSON.stringify(purge.members) === JSON.stringify(['c2']), JSON.stringify(purge.members));
t('单独条目被清掉', purge.solo === null);

console.log('=== 4. 总开关默认开着（v0.4.1.3 起）===');
const on = await page.evaluate(async () => {
  const { kv } = await import('./js/db.js');
  const s = await kv.get('settings', {});
  return { v: s && s.worldbookOn };
});
// ⚠️ v0.4.1.3 改成默认【开】：默认关着时导入世界书报成功却一条不注入，
//    用户的原话是「导入没用…提示导入成功了但没显示」。
t('worldbookOn 默认开（导入完直接生效）', on.v === undefined || on.v === true, JSON.stringify(on));

// v0.4.1.3 起默认就是开的；这里仍然显式写一遍，免得以后改默认值时这一节跟着失效
await page.evaluate(async () => {
  const { kv } = await import('./js/db.js');
  const s = (await kv.get('settings', {})) || {};
  s.worldbookOn = true;
  await kv.set('settings', s);
});
await page.reload({ waitUntil: 'networkidle0' });
await sleep(900);
console.log('=== 5. 条目「什么时候生效」三档（v1.21.51）===');
await page.evaluate(() => document.getElementById('btn-wb-global').click());
await sleep(700);
t('组列表里有组卡片', !!(await page.$('#wb-group-list .wb-group')));
await page.evaluate(() => document.querySelector('#wb-group-list .wb-group').click());
await sleep(800);
t('进了条目页', await page.evaluate(() => document.getElementById('view-wbentries').classList.contains('active')));
await page.evaluate(() => document.getElementById('btn-wb-newentry').click());
await sleep(800);
const segs = await page.$$eval('#we-pos button', bs => bs.map(b => b.textContent.trim()));
t('弹窗里有三档', segs.length === 3, JSON.stringify(segs));
const hint0 = await page.$eval('#we-pos-hint', el => el.textContent);
t('默认第一档是「背景设定」且有说明', segs[0] === '背景设定' && hint0.length > 5, JSON.stringify({ segs, hint0 }));
await page.evaluate(() => document.querySelectorAll('#we-pos button')[2].click());
await sleep(300);
const hint2 = await page.$eval('#we-pos-hint', el => el.textContent);
t('切到「一直生效」说明跟着换', hint2.includes('铁律'), hint2);
await page.evaluate(() => {
  document.getElementById('we-title').value = '世界观';
  document.getElementById('we-content').value = '这里永远是黄昏。';
});
await page.evaluate(() => document.getElementById('modal-ok').click());
await sleep(1200);
const savedWb = await page.evaluate(async () => {
  const { wb } = await import('./js/db.js');
  const gs = await wb.groups();
  const hit = (gs[0].entries || []).find(e => e.title === '世界观');
  return hit ? { pos: hit.pos, keys: hit.keys, content: hit.content } : null;
});
t('常驻档不填触发词也能存下来', !!savedWb && (savedWb.keys || []).length === 0, JSON.stringify(savedWb));
t('pos 落库为 always', !!savedWb && savedWb.pos === 'always', JSON.stringify(savedWb));
t('列表上标了「一直生效」', (await page.$eval('#wbe-list', el => el.textContent)).includes('一直生效'));

console.log('\nJS 错误: ' + (errs.length ? errs.join(' | ') : '无'));
t('无 JS 报错', errs.length === 0, errs.join(' | '));
console.log('\n结果: pass='+pass+' fail='+fail);
await browser.close(); server.close();
process.exit(fail?1:0);
