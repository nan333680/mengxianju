import puppeteer from 'puppeteer-core';
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

await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
await sleep(1500);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil:'networkidle0' }); await sleep(400)   // [提速] 原 1800：探针实测 reload 后 app 就绪只要 ~1ms;

console.log('=== 1. prompt 层：关着时不写视角段 ===');
const offP = await page.evaluate(async () => {
  const { buildStablePrompt } = await import('/js/persona.js');
  return buildStablePrompt({ persona: '你是灵梦。' }, { verbosity:'medium', descLevel:'mid', splitMessages:false });
});
t('关着时没有视角段', !offP.includes('# 视角'));
t('关着时提示词不变（有表达方式段）', offP.includes('# 表达方式'));

console.log('');
console.log('=== 2. 开着时写入视角段 ===');
const onP = await page.evaluate(async () => {
  const { buildStablePrompt } = await import('/js/persona.js');
  return buildStablePrompt({ persona: '你是灵梦。' }, { verbosity:'medium', descLevel:'mid', splitMessages:false, povLock:true });
});
t('有视角段', onP.includes('# 视角'));
t('强调只写自己感知到的', /只能站在【你自己的视角】/.test(onP));
t('允许写环境', /窗外在下雪/.test(onP));
t('禁止旁白总结', /不要写「屋里安静下来」/.test(onP));
t('禁止替对方写心理', /不要替对方写他/.test(onP));
// v1.20.17 起：原来写的是「人称不限，用『我』或『她』都行」，
// 结果模型偶尔滑进第三人称写自己 —— 现在收死成只能用「我」。
t('强制第一人称（不许用「她」）', /指你自己，一律用「我」/.test(onP) && /不许用「她」/.test(onP));

console.log('');
console.log('=== 3. 视角段排在最后（权重最高）===');
const iExp = onP.indexOf('# 表达方式');
const iPov = onP.indexOf('# 视角');
t('视角段在表达方式之后', iPov > iExp, iExp + ' vs ' + iPov);
t('视角段是最后一段', onP.trimEnd().endsWith('不是别人在旁观你。'), onP.slice(-40));

console.log('');
console.log('=== 4. 编辑页有开关 ===');
await jsClick('#btn-chars'); await sleep(700);
await jsClick('#btn-new-char2'); await sleep(800);
await page.evaluate(() => { const b = document.querySelector('#preset-list button, #preset-list .char-item, #preset-list [data-key]'); if (b) b.click(); });
await sleep(1200);
const btns = await page.$$eval('#e-pov button', els => els.map(e => e.textContent.trim()));
console.log('   档位: ' + JSON.stringify(btns));
// ⚠️ 断言更新（v1.21.49）：视角从一个开关改成 关 / L1 / L2 / L3 / L4 五档。
t('有五档', btns.length === 5, JSON.stringify(btns));
t('档位是 关/L1/L2/L3/L4', btns.join() === '关,L1,L2,L3,L4', JSON.stringify(btns));
const def = await page.$eval('#e-pov', el => el.dataset.v);
// 「关」这一档的值是空串（不是 'false'）—— 空串 = 不注入任何视角段落 = 旧版关着的行为。
t('默认是关（dataset 为空串）', def === '', String(def));

console.log('');
console.log('=== 5. 点 L1 会亮、dataset 跟着变 ===');
await page.evaluate(() => { const bs = document.querySelectorAll('#e-pov button'); bs[1].click(); });   // 五档里第 2 个就是 L1
await sleep(400);
const after = await page.$eval('#e-pov', el => el.dataset.v);
t('dataset 变 L1', after === 'L1', String(after));
const onCls = await page.$$eval('#e-pov button', els => els.map(e => e.className.trim()));
t('「L1」高亮了', onCls[1].includes('on'), JSON.stringify(onCls));

console.log('');
console.log('=== 6. 保存后写进角色数据 ===');
await page.evaluate(() => { document.getElementById('e-name').value = '测试视角'; });
await jsClick('#btn-edit-save'); await sleep(1200);
const saved = await page.evaluate(async () => {
  const req = indexedDB.open('ai-companion');
  const db = await new Promise((res,rej) => { req.onsuccess=()=>res(req.result); req.onerror=()=>rej(req.error); });
  const tx = db.transaction('characters','readonly').objectStore('characters').getAll();
  const all = await new Promise(res => { tx.onsuccess = () => res(tx.result); });
  const c = all.find(x => x.name === '测试视角');
  return c ? { povStyle: c.povStyle, povLock: c.povLock, descLevel: c.descLevel } : null;
});
// v1.21.49 起判定只认 povStyle；povLock 还写（给认老字段的地方读），值 = (povStyle === 'L1')。
t('存住了 povStyle=L1', saved && saved.povStyle === 'L1', JSON.stringify(saved));
t('老键 povLock 也跟着写成 true', saved && saved.povLock === true, JSON.stringify(saved));
// ⚠️ 断言更新（v1.21.36）：descLevel 现在是三态 —— 用户没动过就不写进角色，
// 所以【不该存在】这个键才是正确行为（复审 #3）。
t('descLevel 没被污染（三态生效）', saved && !('descLevel' in saved), JSON.stringify(saved));

console.log('');
console.log('=== 7. 重新打开编辑页，开关状态记得住 ===');
await sleep(500);
await page.evaluate(async () => {
  const req = indexedDB.open('ai-companion');
  const db = await new Promise((res,rej) => { req.onsuccess=()=>res(req.result); req.onerror=()=>rej(req.error); });
  const tx = db.transaction('characters','readonly').objectStore('characters').getAll();
  const all = await new Promise(res => { tx.onsuccess = () => res(tx.result); });
  const c = all.find(x => x.name === '测试视角');
  window.__testCharId = c.id;
});
// 回到列表再点进编辑
await jsClick('#btn-edit-back'); await sleep(700);
await page.evaluate(() => { document.getElementById('btn-chars').click(); });
await sleep(700);
await page.evaluate(() => {
  const items = document.querySelectorAll('#char-list [data-edit]');
  for (const it of items) { if (it.dataset.edit === window.__testCharId) { it.click(); return; } }
});
await sleep(1200);
const reopen = await page.$eval('#e-pov', el => el.dataset.v);
t('重开后仍是 L1', reopen === 'L1', String(reopen));

console.log('');
console.log('=== 8. 关掉后提示词恢复原样 ===');
await page.evaluate(() => { const bs = document.querySelectorAll('#e-pov button'); bs[0].click(); });
await sleep(300);
await jsClick('#btn-edit-save'); await sleep(1000);
const offAgain = await page.evaluate(async () => {
  const { buildStablePrompt } = await import('/js/persona.js');
  return buildStablePrompt({ persona: '你是灵梦。' }, { verbosity:'medium', descLevel:'mid', splitMessages:false, povLock:false });
});
t('关掉后没有视角段', !offAgain.includes('# 视角'));

console.log('');
console.log('=== 9. 无报错 ===');
t('无 pageerror', errs.length === 0, errs.join(' | '));

console.log('');
console.log('通过 ' + pass + ' / 失败 ' + fail);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
