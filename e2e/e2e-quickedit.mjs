import puppeteer from 'puppeteer-core';
import { LEGACY_TEMPLATES } from './e2e-helper.mjs';
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
let pass=0, fail=0;
const t=(n,ok,ex='')=>{if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));}};
const jsClick = (s) => page.evaluate(x => document.querySelector(x).click(), s);

await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
await sleep(1500);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil:'networkidle0' }); await sleep(400)   // [提速] 原 1800：探针实测 reload 后 app 就绪只要 ~1ms;

console.log('=== 1. 模板列表只剩「空白角色」===');
await jsClick('#btn-chars'); await sleep(700);
await jsClick('#btn-new-char2'); await sleep(900);
t('进了选模板页', await page.$eval('#view-preset', el => el.classList.contains('active')));
const names = await page.$$eval('#preset-list .char-list-item, #preset-list > *', els => els.map(e => e.textContent.trim()).filter(Boolean));
const html = await page.$eval('#preset-list', el => el.textContent);
console.log('   列表内容: ' + JSON.stringify(html.replace(/\s+/g,' ').trim().slice(0,120)));
t('只剩空白角色', html.includes('空白角色') && LEGACY_TEMPLATES.every(n => !html.includes(n)), html.slice(0,80));
for (const n of LEGACY_TEMPLATES) t('没有' + n, !html.includes(n));

console.log('');
console.log('=== 2. 空白角色还能正常建 ===');
await page.evaluate(() => { const b = document.querySelector('#preset-list [data-key], #preset-list .char-item, #preset-list > *'); if (b) b.click(); });
await sleep(1300);
t('进到编辑页', await page.$eval('#view-edit', el => el.classList.contains('active')));
const presetName = await page.$eval('#e-name', el => el.value);
console.log('   预设带出的名字: ' + JSON.stringify(presetName));
t('带出了空白角色的名字', presetName === '空白角色' || presetName === '', presetName);
await jsClick('#btn-edit-back'); await sleep(700);

console.log('');
console.log('=== 3. 点聊天栏头像 → 进她的编辑页 ===');
// 先建一个角色并进入聊天
await jsClick('#btn-chars'); await sleep(700);
await jsClick('#btn-new-char2'); await sleep(800);
await page.evaluate(() => { const b = document.querySelector('#preset-list [data-key], #preset-list .char-item, #preset-list > *'); if (b) b.click(); });
await sleep(1300);
await page.evaluate(() => { document.getElementById('e-name').value = '点头像测试'; });
await jsClick('#btn-edit-save'); await sleep(1500);
await page.evaluate(() => {
  const cards = document.querySelectorAll('#char-list .char-card');
  for (const c of cards) { if (c.textContent.includes('点头像测试')) { c.click(); return; } }
});
await sleep(1500);
t('进到聊天页', await page.$eval('#view-chat', el => el.classList.contains('active')));
const chatName = await page.$eval('#chat-name', el => el.textContent);
t('聊天栏显示她的名字', chatName === '点头像测试', chatName);
t('头像可点（有 tap-edit 类）', await page.$eval('#chat-avatar', el => el.classList.contains('tap-edit')));

// 点头像
await jsClick('#chat-avatar'); await sleep(1400);
t('点头像进了编辑页', await page.$eval('#view-edit', el => el.classList.contains('active')));
const editName = await page.$eval('#e-name', el => el.value);
t('编辑的正是她', editName === '点头像测试', editName);

console.log('');
console.log('=== 4. 返回能回到聊天（不是回角色列表）===');
await jsClick('#btn-edit-back'); await sleep(900);
const backTo = await page.evaluate(() => {
  if (document.getElementById('view-chat').classList.contains('active')) return 'chat';
  if (document.getElementById('view-chars').classList.contains('active')) return 'chars';
  return 'other';
});
console.log('   返回到: ' + backTo);
t('回到了聊天页', backTo === 'chat', backTo);

console.log('');
console.log('=== 5. 点名字区域也能进 ===');
await jsClick('#chat-titletxt'); await sleep(1300);
t('点名字也进编辑页', await page.$eval('#view-edit', el => el.classList.contains('active')));
await jsClick('#btn-edit-back'); await sleep(800);

console.log('');
console.log('=== 6. 没选角色时点头像不崩 ===');
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil:'networkidle0' }); await sleep(400)   // [提速] 原 1800：探针实测 reload 后 app 就绪只要 ~1ms;
await jsClick('#chat-avatar'); await sleep(800);
t('没报错', errs.length === 0, errs.join(' | '));

console.log('');
console.log('通过 ' + pass + ' / 失败 ' + fail);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
