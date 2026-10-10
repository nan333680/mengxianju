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

const captured = [];
await page.setRequestInterception(true);
page.on('request', req => {
  const u = req.url();
  if (u.includes('deepseek') || u.includes('/chat/completions')) {
    if (req.method() === 'OPTIONS') { req.respond({ status:204, headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'*'} }); return; }
    let body = {};
    try { body = JSON.parse(req.postData() || '{}'); } catch {}
    if (body.messages) captured.push(body.messages);
    if (body.stream) {
      const reply = ['测试回复'];
      const payload = 'data: ' + JSON.stringify({ choices: [{ delta: { content: reply[0] } }] }) + String.fromCharCode(10,10) + 'data: [DONE]' + String.fromCharCode(10,10);
      req.respond({ status:200, headers:{'Access-Control-Allow-Origin':'*'}, contentType:'text/event-stream', body: payload });
      return;
    }
    req.respond({ status:200, headers:{'Access-Control-Allow-Origin':'*'}, contentType:'application/json', body: JSON.stringify({choices:[{message:{content:'[]'}}]}) });
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

// 预置 API Key（免得弹窗拦住）
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

console.log('=== 用 UI 建一个角色，把「锁定她的视角」打开 ===');
await jsClick('#btn-chars'); await sleep(700);
await jsClick('#btn-new-char2'); await sleep(800);
await page.evaluate(() => { const b = document.querySelector('#preset-list .char-card, #preset-list button, #preset-list [data-key]'); if (b) b.click(); });
await sleep(1300);
t('进到编辑页', await page.$eval('#view-edit', el => el.classList.contains('active')));
await page.evaluate(() => { document.getElementById('e-name').value = '紫测试'; });
// 把视角切开
await page.evaluate(() => { const bs = document.querySelectorAll('#e-pov button'); bs[1].click(); });
await sleep(300);
t('视角已切到 L1', (await page.$eval('#e-pov', el => el.dataset.v)) === 'L1');   // v1.21.49：开关→五档，bs[1] 是 L1
await jsClick('#btn-edit-save'); await sleep(1500);

console.log('');
console.log('=== 1. 进聊天发一句 → 真实请求里应带视角段 ===');
await page.evaluate(() => {
  const cards = document.querySelectorAll('#char-list .char-card');
  for (const c of cards) { if (c.textContent.includes('紫测试')) { c.click(); return; } }
});
await sleep(1500);
t('进到聊天页', await page.$eval('#view-chat', el => el.classList.contains('active')));
captured.length = 0;
await page.evaluate(() => { const i = document.getElementById('input'); i.value = '在吗'; i.dispatchEvent(new Event('input',{bubbles:true})); });
await sleep(300);
await jsClick('#btn-send');
await sleep(3500);
const sysOn = captured.length ? ((captured[0].find(m => m.role === 'system') || {}).content || '') : '';
console.log('   捕获请求: ' + captured.length + ' | system 长度: ' + sysOn.length);
t('发出了请求', captured.length > 0);
t('system 含「# 视角」', sysOn.includes('# 视角'), sysOn.slice(-150));
t('含「只能站在【你自己的视角】」', sysOn.includes('只能站在【你自己的视角】'));
t('含环境说明', sysOn.includes('你注意到的环境'));

console.log('');
console.log('=== 2. 关掉开关 → 视角段消失 ===');
await jsClick('#btn-chars'); await sleep(900);
await page.evaluate(() => {
  const cards = document.querySelectorAll('#char-list .char-card');
  for (const c of cards) { if (c.textContent.includes('紫测试')) { const b = c.querySelector('[data-edit]'); if (b) b.click(); return; } }
});
await sleep(1300);
t('又进了编辑页', await page.$eval('#view-edit', el => el.classList.contains('active')));
t('视角还记得是 L1', (await page.$eval('#e-pov', el => el.dataset.v)) === 'L1');
await page.evaluate(() => { const bs = document.querySelectorAll('#e-pov button'); bs[0].click(); });
await sleep(300);
await jsClick('#btn-edit-save'); await sleep(1500);
await page.evaluate(() => {
  const cards = document.querySelectorAll('#char-list .char-card');
  for (const c of cards) { if (c.textContent.includes('紫测试')) { c.click(); return; } }
});
await sleep(1500);
captured.length = 0;
await page.evaluate(() => { const i = document.getElementById('input'); i.value = '在吗'; i.dispatchEvent(new Event('input',{bubbles:true})); });
await sleep(300);
await jsClick('#btn-send');
await sleep(3500);
const sysOff = captured.length ? ((captured[0].find(m => m.role === 'system') || {}).content || '') : '';
console.log('   system 长度: ' + sysOff.length);
t('关了之后没有视角段', !sysOff.includes('# 视角'), sysOff.slice(-120));
t('表达方式段还在', sysOff.includes('# 表达方式'));
t('两轮长度不同（证明确实少了东西）', sysOn.length !== sysOff.length, sysOn.length + ' vs ' + sysOff.length);

console.log('');
console.log('=== 3. 无报错 ===');
t('无 pageerror', errs.length === 0, errs.join(' | '));

console.log('');
console.log('通过 ' + pass + ' / 失败 ' + fail);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
