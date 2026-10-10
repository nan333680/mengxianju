import puppeteer from 'puppeteer-core';
import { seedChar } from './e2e-helper.mjs';
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
// mock：整理时返回合并后的 2 条（模拟"认真合并+压缩"）
let mode = 'merge';
await page.setRequestInterception(true);
page.on('request', req => {
  const u = req.url();
  if (u.includes('/chat/completions')) {
    if (req.method()==='OPTIONS'){ req.respond({status:204,headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'*'}}); return; }
    const body = JSON.parse(req.postData()||'{}');
    if (body.stream) { req.respond({status:200,headers:{'Access-Control-Allow-Origin':'*'},contentType:'text/event-stream',body:'data: ' + JSON.stringify({choices:[{delta:{content:'好'}}]}) + String.fromCharCode(10,10) + 'data: [DONE]' + String.fromCharCode(10,10)}); return; }
    const sys = (body.messages||[]).map(m=>m.content).join('\n');
    let out = '[]';
    if (sys.includes('JSON 数组') && sys.includes('整理')) {
      out = mode === 'merge'
        ? JSON.stringify([{text:'你有喝咖啡的习惯，最近改喝拿铁',kind:'fact',untilDay:null,freq:'often'},
                          {text:'你怕冷，过冬靠暖气',kind:'fact',untilDay:null,freq:'normal'}])
        : '';  // 空字符串 = 解析失败路径
    }
    req.respond({status:200,headers:{'Access-Control-Allow-Origin':'*'},contentType:'application/json',body:JSON.stringify({choices:[{message:{content:out}}]})});
    return;
  }
  req.continue();
});
const sleep = ms => new Promise(r=>setTimeout(r,ms));
let pass=0, fail=0;
const t=(n,ok,ex='')=>{if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));}};
await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
await sleep(1500);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil:'networkidle0' }); await sleep(400)   // [提速] 原 1800：探针实测 reload 后 app 就绪只要 ~1ms;

const cid = await seedChar(page, '优化测试', { greeting:'（开场）' });
// 塞 6 条啰嗦的记忆（模拟"没整理过"的状态）
await page.evaluate(async (id) => {
  const { mem, kv, uid } = await import('./js/db.js');
  const items = [
    '你喜欢美式咖啡', '你改喝拿铁了', '你喝咖啡不加糖', '你每天要喝两杯咖啡',
    '你很怕冷', '你冬天总要开暖气',
  ];
  for (const s of items) await mem.add({ id: uid(), charId: id, text: s, kind:'fact', untilDay:null, freq:'normal', ts: Date.now() });
  await kv.set('settings', Object.assign({}, await kv.get('settings', {}), {
    apiKey:'sk-test', baseUrl:'http://127.0.0.1:'+location.port+'/v1', memLimit: 30, memDedupeEvery: 1, memSummarizeEvery: 999
  }));
}, cid);
await page.reload({ waitUntil:'networkidle0' }); await sleep(400)   // [提速] 原 2000：探针实测 reload 后 app 就绪只要 ~1ms;
await page.click('#btn-chars'); await sleep(700);
await page.evaluate(() => {
  const c = [...document.querySelectorAll('#char-list .char-card')].find(x => x.textContent.includes('优化测试'));
  if (c) c.click();
});
await sleep(1200);

console.log('=== 1. 撤销按钮存在 ===');
await page.evaluate(() => document.getElementById('btn-settings').click()); await sleep(800);
await page.evaluate(() => {
  const b = [...document.querySelectorAll('#drawer-menu [data-wb-drawer]')].find(x => x.dataset.wbDrawer === 'settings');
  if (b) b.click();
});
await sleep(900);
await page.evaluate(() => { const f=document.querySelector('#mem-set-fold'); if(f && !f.classList.contains('open')) f.click(); });
await sleep(700);
t('有「撤销上次整理」按钮', !!(await page.$('#btn-mem-undo')));

console.log('=== 2. 没有备份时撤销会给提示，不崩 ===');
await page.evaluate(() => document.getElementById('btn-mem-undo').click());
await sleep(1200);
const noBk = await page.evaluate(() => { const el=document.getElementById('toast'); return el && !el.classList.contains('hidden') ? el.textContent : ''; });
t('提示还没有可撤销的整理', /还没有可撤销/.test(noBk), noBk);
const afterNoBk = await page.evaluate(async (id) => {
  const { mem } = await import('./js/db.js'); return (await mem.list(id)).length;
}, cid);
t('记忆没被动', afterNoBk === 6, 'n='+afterNoBk);

console.log('=== 3. 整理 → 有备份 + 报告 ===');
await page.evaluate(() => document.getElementById('btn-mem-tidy').click());
for (let i=0;i<40;i++){ await sleep(400); const d=await page.$eval('#btn-mem-tidy',e=>e.disabled).catch(()=>false); if(!d) break; }
await sleep(1500);
const st = await page.evaluate(async (id) => {
  const { mem, kv } = await import('./js/db.js');
  const list = await mem.list(id);
  const bk = await kv.get('memTidyBackup:'+id, null);
  const el = document.getElementById('toast');
  return { n: list.length, texts: list.map(m=>m.text),
           bk: bk ? bk.items.length : 0,
           toast: el && !el.classList.contains('hidden') ? el.textContent : '' };
}, cid);
console.log('   整理后: ' + JSON.stringify({n: st.n, bk: st.bk}));
console.log('   toast: ' + st.toast);
t('整理生效（6 → 2 条）', st.n === 2, 'n='+st.n);
t('形成了备份（6 条）', st.bk === 6, 'bk='+st.bk);
t('报告里有条数变化', /6 → 2/.test(st.toast), st.toast);
t('报告里有字数变化', /字数/.test(st.toast), st.toast);

console.log('=== 4. 撤销 → 回到整理前 ===');
await page.evaluate(() => document.getElementById('btn-mem-undo').click());
await sleep(1000);
// 确认框
await page.evaluate(() => document.getElementById('modal-ok').click());
await sleep(2000);
const undone = await page.evaluate(async (id) => {
  const { mem, kv } = await import('./js/db.js');
  const list = await mem.list(id);
  const bk = await kv.get('memTidyBackup:'+id, null);
  return { n: list.length, hasOld: list.some(m=>m.text.includes('美式')), bk };
}, cid);
console.log('   ' + JSON.stringify({n: undone.n, hasOld: undone.hasOld, bkCleared: undone.bk === null}));
t('回到 6 条', undone.n === 6, 'n='+undone.n);
t('原来的记忆内容回来了', undone.hasOld);
t('备份用掉后清掉', undone.bk === null);

console.log('=== 5. 模型返回空 → 条数字数都没变时如实说 ===');
await page.evaluate(async (id) => {
  const { mem, kv, uid } = await import('./js/db.js');
  const list = await mem.list(id);
  for (const m of list) await mem.del(m.id);
  for (const s of ['你喜欢美式','你改喝拿铁','你不加糖']) {
    await mem.add({ id: uid(), charId: id, text: s, kind:'fact', untilDay:null, freq:'normal', ts: Date.now() });
  }
}, cid);
mode = 'bad';   // Node 侧变量，不能放进 page.evaluate（那是另一个上下文）
await page.evaluate(() => document.getElementById('btn-mem-tidy').click());
for (let i=0;i<40;i++){ await sleep(400); const d=await page.$eval('#btn-mem-tidy',e=>e.disabled).catch(()=>false); if(!d) break; }
await sleep(1500);
const bad = await page.evaluate(async (id) => {
  const { mem } = await import('./js/db.js');
  const list = await mem.list(id);
  const el = document.getElementById('toast');
  return { n: list.length, toast: el && !el.classList.contains('hidden') ? el.textContent : '' };
}, cid);
console.log('   n=' + bad.n + ' | toast=' + bad.toast);
t('模型没返回有效结果时，记忆保持原样（3 条）', bad.n === 3, 'n='+bad.n);

console.log('\nJS 错误: ' + (errs.length ? errs.join(' | ') : '无'));
t('无 JS 报错', errs.length === 0, errs.join(' | '));
console.log('\n结果: pass='+pass+' fail='+fail);
await browser.close(); server.close();
process.exit(fail?1:0);
