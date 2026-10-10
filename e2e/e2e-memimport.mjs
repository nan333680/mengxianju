import puppeteer from 'puppeteer-core';
import { pickImportMode, seedChar } from './e2e-helper.mjs';
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

await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
await sleep(1500);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil:'networkidle0' }); await sleep(400)   // [提速] 原 1800：探针实测 reload 后 app 就绪只要 ~1ms;
// v1.21.59：全新安装不再自动建角色（产品改空），测试自己塞一个
await seedChar(page, '测试角色', { greeting: '' });   // 空开场白：不额外多出一条消息
await page.reload({waitUntil:'networkidle0'}); await sleep(500);

// 导入一份含 mine / freq 的备份
await openSettings(page, sleep);
const cid = await page.evaluate(async () => {
  const open = () => new Promise(r => { const o = indexedDB.open('ai-companion'); o.onsuccess = () => r(o.result); });
  const db = await open();
  const c = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').getAll(); q.onsuccess = () => r(q.result[0]); });
  db.close(); return c.id;
});
const backup = {
  version: 1,
  characters: [{ id: cid, name: '测试角色', greeting: '嗨', persona: '测试', longMemory: true }],
  messages: { [cid]: [{ id:'x1', charId: cid, role:'user', content:'你好', ts: Date.now() }] },
  memories: [
    { id:'k1', charId: cid, text:'我自己写的：爱吃辣', kind:'fact', untilDay:null, mine:true, freq:'pinned', ts: Date.now() },
    { id:'k2', charId: cid, text:'她记的：爱喝咖啡', kind:'fact', untilDay:null, freq:'often', ts: Date.now()+1 },
    { id:'k3', charId: cid, text:'她记的限时：周末有假', kind:'event', untilDay:9, freq:'normal', ts: Date.now()+2 }
  ]
};
await page.evaluate((b) => {
  const f = new File([JSON.stringify(b)], 'b.json', { type: 'application/json' });
  const inp = document.getElementById('file-import');
  const dt = new DataTransfer(); dt.items.add(f);
  inp.files = dt.files; inp.dispatchEvent(new Event('change', { bubbles: true }));
}, backup);
// v1.19.11：会先弹「选导入模式」。这份备份里只有 memories + characters，
// 用「仅聊天记录」（它把 memories 一起带上）。
await pickImportMode(page, 'msgs', sleep);
await sleep(2000);

console.log('=== 导入后字段是否完整 ===');
const mems = await page.evaluate(async () => {
  const open = () => new Promise(r => { const o = indexedDB.open('ai-companion'); o.onsuccess = () => r(o.result); });
  const db = await open();
  const ms = await new Promise(r => { const q = db.transaction('memories').objectStore('memories').getAll(); q.onsuccess = () => r(q.result); });
  db.close();
  return ms.map(m => ({ t:m.text.slice(0,8), mine:!!m.mine, freq:m.freq, kind:m.kind, untilDay:m.untilDay }));
});
console.log('   ' + JSON.stringify(mems));
const mineOne = mems.find(m => m.t.includes('我自己写的'));
t('导入保留了 mine 标记', mineOne && mineOne.mine === true, JSON.stringify(mineOne));
t('导入保留了 freq', mems.find(m => m.t.includes('她记的：爱'))?.freq === 'often', JSON.stringify(mems.map(m=>m.freq)));
t('导入保留了 pinned', mineOne && mineOne.freq === 'pinned', JSON.stringify(mineOne));
// 注意：m.t 是 slice(0,8) 截断过的，所以要按前几个字匹配
const evOne = mems.find(m => m.t.includes('她记的限'));
t('导入保留了 event 型', evOne && evOne.kind === 'event', JSON.stringify(evOne));
t('导入保留了 untilDay', evOne && evOne.untilDay === 9, JSON.stringify(evOne));

console.log('');
console.log('=== 界面显示「自定义」标签 ===');
await page.evaluate(() => document.getElementById('btn-set-back').click()); await sleep(600);
  await page.evaluate(() => { const b = document.getElementById('btn-drawer-close'); if (b && document.querySelector('#view-drawer.active')) b.click(); });
  await sleep(500);
await page.evaluate(() => document.getElementById('btn-chars').click()); await sleep(700);
await page.evaluate(() => document.querySelectorAll('#char-list .char-card button[data-edit]')[0].click()); await sleep(900);
await page.evaluate(() => document.getElementById('e-mem-fold').click()); await sleep(900);
const tags = await page.$$eval('#e-mem-list .mem-item', els => els.map(e => ({
  text: e.querySelector('.txt').textContent.slice(0,8),
  tags: [...e.querySelectorAll('.mem-foot .mem-tag')].map(x => x.textContent.trim())
})));
console.log('   ' + JSON.stringify(tags));
const mineItem = tags.find(x => x.text.includes('我自己写的'));
t('自定义那条带「自定义」标签', mineItem && mineItem.tags.includes('自定义'), JSON.stringify(mineItem));
t('她记的那条没有「自定义」', !tags.find(x => x.text.includes('她记的：爱'))?.tags.includes('自定义'));

console.log('');
if (errs.length) console.log('  JS 错误: ' + JSON.stringify(errs.slice(0,3)));
t('全程无 JS 错误', errs.length === 0, errs.slice(0,2).join(' | '));
console.log('');
console.log('========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
