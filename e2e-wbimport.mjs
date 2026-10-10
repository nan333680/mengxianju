import puppeteer from 'puppeteer-core';
import { seedChars } from './e2e-helper.mjs';
import http from 'http'; import fs from 'fs'; import path from 'path';
// 工作目录自适应（原来写死 C:/A-DSH-Tool/ai-companion）
const R = path.resolve(import.meta.dirname).split(path.sep).join('/');
const WWW = `${R}/www`;
const FIX = `${R}/_fixtures`;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8' };
fs.mkdirSync(FIX, { recursive: true });
// 测试素材放工程内（不读桌面）
const wbFile = path.join(FIX, 'worldbook-test.json');
fs.writeFileSync(wbFile, JSON.stringify({
  version: 1, kind: 'worldbook', exportedAt: Date.now(),
  groups: [{ id:'wbg_test1', name:'测试幻想乡', members:[], createdAt: Date.now(), entries:[
    { id:'wbe1', title:'红魔馆', keys:['红魔馆','帕秋莉'], content:'红魔馆是蕾米莉亚的宅邸。', on:true },
  ]}],
  solo: [],
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
const openSettings = async () => {
  await page.evaluate(() => document.getElementById('btn-settings').click()); await sleep(800);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('#drawer-menu [data-wb-drawer]')].find(x => x.dataset.wbDrawer === 'worldbook');
    if (b) b.click();
  }); await sleep(900);
};
await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
await sleep(1500);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil:'networkidle0' }); await sleep(400)   // [提速] 原 1800：探针实测 reload 后 app 就绪只要 ~1ms;
await seedChars(page, [{name:'紫'}]);
await page.reload({ waitUntil:'networkidle0' }); await sleep(400)   // [提速] 原 2000：探针实测 reload 后 app 就绪只要 ~1ms;

console.log('=== 1. 有导入导出入口 ===');
await openSettings();
const ui = await page.evaluate(() => ({
  page: document.querySelector('#view-worldbook').classList.contains('active'),
  imp: !!document.querySelector('#btn-wb-import'),
  exp: !!document.querySelector('#btn-wb-export'),
  file: !!document.querySelector('#wb-import-file'),
}));
console.log('   ' + JSON.stringify(ui));
t('在世界书页', ui.page);
t('有导入按钮', ui.imp);
t('有导出按钮', ui.exp);
t('有隐藏的文件输入', ui.file);

console.log('=== 2. 导入世界书文件 ===');
const input = await page.$('#wb-import-file');
await input.uploadFile(wbFile);
await sleep(2500);
const after = await page.evaluate(async () => {
  const { wb } = await import('./js/db.js');
  const gs = await wb.groups();
  return gs.map(g => ({ name: g.name, n: (g.entries||[]).length, key: (g.entries||[])[0] ? g.entries[0].keys[0] : null }));
});
console.log('   ' + JSON.stringify(after));
t('角色组导进来了', after.length === 1 && after[0].name === '测试幻想乡', JSON.stringify(after));
t('组里的条目也在', after[0] && after[0].n === 1);
t('触发词完整', after[0] && after[0].key === '红魔馆');

console.log('=== 3. 导入是追加，不清空已有 ===');
// 先手动建一个组，再导一次，应该变成 2 个
await page.evaluate(async () => {
  const { wb, uid } = await import('./js/db.js');
  await wb.putGroup({ id: uid(), name: '我自己建的', members: [], entries: [], createdAt: Date.now() + 1000 });
});
await sleep(500);
const input2 = await page.$('#wb-import-file');
await input2.uploadFile(wbFile);
await sleep(2500);
const after2 = await page.evaluate(async () => {
  const { wb } = await import('./js/db.js');
  const gs = await wb.groups();
  return gs.map(g => g.name);
});
console.log('   ' + JSON.stringify(after2));
t('原有组还在（追加不是覆盖）', after2.includes('我自己建的'), JSON.stringify(after2));
t('导入的组也在', after2.includes('测试幻想乡'));

console.log('=== 4. 坏文件不崩 ===');
const badFile = path.join(FIX, 'worldbook-bad.json');
fs.writeFileSync(badFile, '{ 这不是合法 JSON', 'utf8');
const input3 = await page.$('#wb-import-file');
await input3.uploadFile(badFile);
await sleep(2000);
const alive = await page.evaluate(() => ({
  app: !!document.querySelector('#view-worldbook'),
  toast: (() => { const el = document.getElementById('toast'); return el && !el.classList.contains('hidden') ? el.textContent : ''; })(),
}));
t('页面没崩', alive.app);
t('给出了失败提示', /失败/.test(alive.toast), alive.toast);

console.log('\nJS 错误: ' + (errs.length ? errs.join(' | ') : '无'));
t('无 JS 报错', errs.length === 0, errs.join(' | '));
console.log('\n结果: pass='+pass+' fail='+fail);
await browser.close(); server.close();
process.exit(fail?1:0);
