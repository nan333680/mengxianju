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
page.on('dialog', async d => { await d.accept(); });

// 拦截识图请求，返回固定的外貌描述
const visionCalls = [];
await page.setRequestInterception(true);
page.on('request', req => {
  const u = req.url();
  if (u.includes('deepseek') || u.includes('/chat/completions')) {
    if (req.method() === 'OPTIONS') { req.respond({ status:204, headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'*'} }); return; }
    let body = {};
    try { body = JSON.parse(req.postData() || '{}'); } catch {}
    const hasImg = JSON.stringify(body.messages || []).includes('image_url');
    if (hasImg) visionCalls.push(body.messages);
    const content = hasImg
      ? '紫色连衣裙，裙摆到膝下\n金长发，末端系红色蝴蝶结\n戴白色帽子，手里撑一把大阳伞\n整体风格端庄'
      : '[]';
    req.respond({ status:200, headers:{'Access-Control-Allow-Origin':'*'}, contentType:'application/json',
      body: JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }) });
    return;
  }
  req.continue();
});
const sleep = ms => new Promise(r=>setTimeout(r,ms));
let pass=0, fail=0;
const t=(n,ok,ex='')=>{if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));}};
const jsClick = (s) => page.evaluate(x => document.querySelector(x).click(), s);

await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
await sleep(1500);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil:'networkidle0' }); await sleep(400)   // [提速] 原 1800：探针实测 reload 后 app 就绪只要 ~1ms;
await page.evaluate(async () => {
  const req = indexedDB.open('ai-companion');
  const db = await new Promise(r => { req.onsuccess = () => r(req.result); });
  await new Promise(r => {
    const tx = db.transaction('kv','readwrite');
    tx.objectStore('kv').put({ k:'settings', v:{ apiKey:'sk-test', baseUrl:'https://api.deepseek.com', model:'deepseek-flash', visionModel:'deepseek-flash', theme:'dark', fontSize:15 } });
    tx.oncomplete = r;
  });
});
await page.reload({ waitUntil:'networkidle0' }); await sleep(400)   // [提速] 原 1800：探针实测 reload 后 app 就绪只要 ~1ms;

console.log('=== 1. prompt 层：空着不注入 ===');
const emptyP = await page.evaluate(async () => {
  const { buildStablePrompt } = await import('/js/persona.js');
  return buildStablePrompt({ persona:'你是灵梦。' }, { myProfile:'', appearance:'', appearanceOn:true, verbosity:'medium', descLevel:'mid', splitMessages:false });
});
t('空着时没有外貌段', !emptyP.includes('# 你此刻的样子'));

console.log('');
console.log('=== 2. 填了内容就注入，位置在整段最末尾 ===');
const filledP = await page.evaluate(async () => {
  const { buildStablePrompt } = await import('/js/persona.js');
  return buildStablePrompt({ persona:'你是灵梦。' }, { myProfile:'我的设定', appearance:'穿着紫色连衣裙', appearanceOn:true, verbosity:'medium', descLevel:'mid', splitMessages:false });
});
t('有外貌段', filledP.includes('# 你此刻的样子'));
t('含外貌内容', filledP.includes('穿着紫色连衣裙'));
const iChar = filledP.indexOf('# 你的角色设定');
const iLook = filledP.indexOf('# 你此刻的样子');
const iMe = filledP.indexOf('# 关于对方');
t('排在角色设定之后', iLook > iChar, iChar + ' vs ' + iLook);

// ⚠️ 断言更新（v1.21.42）：原来是「排在我的设定之前」（iLook < iMe）。
//
// 外貌段现在【挪到了整段最末尾】—— 这是为了前缀缓存主动改的，不是位置写错：
// 它是最常改的一项（还有「立即生效」按钮），而 DeepSeek 缓存按前缀匹配，
// 它一变，排在它后面的每一段（关于对方 / 他住的地方 / 表达方式 / 视角 / 关于括号）
// 都要重新计费。旧位置在第 2 位，一改就作废 5 段。
//
// 所以这条改成正向断言：它必须是【最后一段】—— 比"排在谁之前"更强，
// 因为将来再往后面加段落时，这条会立刻失败、提醒去重新评估缓存顺序。
const headers = [...filledP.matchAll(/^# (.+)$/gm)].map(m => m[1]);
t('排在所有段落之后（末段）', iLook > iMe && headers[headers.length - 1] === '你此刻的样子',
  '末段=' + headers[headers.length - 1]);
t('段里有对照说明', /不要写出和这里矛盾/.test(filledP));

console.log('');
console.log('=== 3. 开关关掉 → 内容留着但不注入 ===');
const offP = await page.evaluate(async () => {
  const { buildStablePrompt } = await import('/js/persona.js');
  return buildStablePrompt({ persona:'你是灵梦。' }, { myProfile:'', appearance:'穿着紫色连衣裙', appearanceOn:false, verbosity:'medium', descLevel:'mid', splitMessages:false });
});
t('关掉后不注入', !offP.includes('穿着紫色连衣裙'));

console.log('');
console.log('=== 4. 编辑页有「外貌」折叠栏 ===');
await jsClick('#btn-chars'); await sleep(700);
await jsClick('#btn-new-char2'); await sleep(800);
await page.evaluate(() => { const b = document.querySelector('#preset-list .char-card, #preset-list button, #preset-list [data-key]'); if (b) b.click(); });
await sleep(1300);
t('有折叠头', !!(await page.$('#look-fold')));
t('有文本框', !!(await page.$('#e-look')));
t('有开关', !!(await page.$('#e-look-on')));
t('有「清除」按钮', !!(await page.$('#e-look-clearlive')));
t('有「立即生效」按钮', !!(await page.$('#e-look-apply')));
t('有识图按钮', !!(await page.$('#e-look-img')));
t('开关默认开着', (await page.$eval('#e-look-on', el => el.checked)) === true);

console.log('');
console.log('=== 5. 展开 + 输入 → 字数实时更新 ===');
await jsClick('#look-fold'); await sleep(500);
await page.evaluate(() => { const b = document.getElementById('e-look'); b.value = '穿着紫色连衣裙，外套脱了搭在椅背上'; b.dispatchEvent(new Event('input',{bubbles:true})); });
await sleep(400);
const cnt = await page.$eval('#e-look-count', el => el.textContent);
console.log('   字数: ' + cnt);
t('显示了字数', /1[0-9] 字/.test(cnt), cnt);
const brief = await page.$eval('#look-brief', el => el.textContent);
t('折叠头显示字数', /1[0-9] 字/.test(brief), brief);

console.log('');
console.log('=== 6. 保存后写进角色数据（开关也存）===');
await page.evaluate(() => { document.getElementById('e-name').value = '外貌测试'; });
await page.evaluate(() => { document.getElementById('e-look-on').checked = true; });
await jsClick('#btn-edit-save'); await sleep(1500);
const saved = await page.evaluate(async () => {
  const req = indexedDB.open('ai-companion');
  const db = await new Promise(r => { req.onsuccess = () => r(req.result); });
  const all = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').getAll(); q.onsuccess = () => r(q.result); });
  const c = all.find(x => x.name === '外貌测试');
  if (c) window.__lid = c.id;
  return c ? { appearance: c.appearance, appearanceOn: c.appearanceOn } : null;
});
t('外貌存住了', saved && saved.appearance === '穿着紫色连衣裙，外套脱了搭在椅背上', JSON.stringify(saved));
t('开关存住了', saved && saved.appearanceOn === true, JSON.stringify(saved));

console.log('');
console.log('=== 7. 重新打开编辑页 → 记得住 ===');
await jsClick('#btn-chars'); await sleep(800);
await page.evaluate(() => {
  const cards = document.querySelectorAll('#char-list .char-card');
  for (const c of cards) { if (c.textContent.includes('外貌测试')) { const b = c.querySelector('[data-edit]'); if (b) b.click(); return; } }
});
await sleep(1400);
t('又进了编辑页', await page.$eval('#view-edit', el => el.classList.contains('active')));
const reopen = await page.$eval('#e-look', el => el.value);
t('文本框内容还在', reopen === '穿着紫色连衣裙，外套脱了搭在椅背上', reopen);

console.log('');
console.log('=== 8. 关掉开关 → 保存 → 存住 false，内容不丢 ===');
await page.evaluate(() => { const c = document.getElementById('e-look-on'); c.checked = false; });
await jsClick('#btn-edit-save'); await sleep(1400);
const offSaved = await page.evaluate(async () => {
  const req = indexedDB.open('ai-companion');
  const db = await new Promise(r => { req.onsuccess = () => r(req.result); });
  const all = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').getAll(); q.onsuccess = () => r(q.result); });
  const c = all.find(x => x.name === '外貌测试');
  return c ? { appearance: c.appearance, appearanceOn: c.appearanceOn } : null;
});
t('开关存成 false', offSaved && offSaved.appearanceOn === false, JSON.stringify(offSaved));
t('内容还留着（没被清）', offSaved && offSaved.appearance.length > 5, JSON.stringify(offSaved));

console.log('');
console.log('=== 9. 识图按钮：选图 → 追加到框尾另起一行 ===');
await page.evaluate(() => {
  const cards = document.querySelectorAll('#char-list .char-card');
  for (const c of cards) { if (c.textContent.includes('外貌测试')) { const b = c.querySelector('[data-edit]'); if (b) b.click(); return; } }
});
await sleep(1400);
// 先在框里写一句，验证"追加"而不是"覆盖"
await page.evaluate(() => { const b = document.getElementById('e-look'); b.value = '我自己写的第一行'; b.dispatchEvent(new Event('input',{bubbles:true})); });
await sleep(300);
// 构造一个假文件塞进 file input
const fakeImg = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
await page.evaluate(async (dataUrl) => {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  const file = new File([blob], 'test.png', { type: 'image/png' });
  const dt = new DataTransfer();
  dt.items.add(file);
  const inp = document.getElementById('e-look-file');
  inp.files = dt.files;
  inp.dispatchEvent(new Event('change', { bubbles: true }));
}, fakeImg);
await sleep(3000);
const afterImg = await page.$eval('#e-look', el => el.value);
console.log('   框内容: ' + JSON.stringify(afterImg.slice(0, 80)));
t('发出了识图请求', visionCalls.length > 0);
t('原来的内容还在', afterImg.includes('我自己写的第一行'));
t('识图结果追加在后面', afterImg.includes('紫色连衣裙'));
const lines = afterImg.split('\n');
t('另起了一行', lines.length >= 2 && lines[0] === '我自己写的第一行', JSON.stringify(lines.slice(0,2)));
t('识图提示词要求不猜身份', visionCalls.length > 0 && /不要猜人物身份/.test(JSON.stringify(visionCalls[0])));
t('识图要求中文', visionCalls.length > 0 && /用中文/.test(JSON.stringify(visionCalls[0])));

console.log('');
console.log('=== 10. 识图后没自动保存（要手动点 ✓）===');
const notSaved = await page.evaluate(async () => {
  const req = indexedDB.open('ai-companion');
  const db = await new Promise(r => { req.onsuccess = () => r(req.result); });
  const all = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').getAll(); q.onsuccess = () => r(q.result); });
  const c = all.find(x => x.name === '外貌测试');
  return c ? c.appearance : null;
});
t('库里还是旧的（没自动存）', notSaved === '穿着紫色连衣裙，外套脱了搭在椅背上', String(notSaved));

console.log('');
console.log('=== 11. 点保存后才写入识图结果 ===');
await jsClick('#btn-edit-save'); await sleep(1400);
const afterSave = await page.evaluate(async () => {
  const req = indexedDB.open('ai-companion');
  const db = await new Promise(r => { req.onsuccess = () => r(req.result); });
  const all = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').getAll(); q.onsuccess = () => r(q.result); });
  const c = all.find(x => x.name === '外貌测试');
  return c ? c.appearance : null;
});
t('保存后写进去了', afterSave && afterSave.includes('紫色连衣裙') && afterSave.includes('我自己写的第一行'), String(afterSave).slice(0,60));

console.log('');
console.log('=== 12. 无报错 ===');
t('无 pageerror', errs.length === 0, errs.join(' | '));

console.log('');
console.log('通过 ' + pass + ' / 失败 ' + fail);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
