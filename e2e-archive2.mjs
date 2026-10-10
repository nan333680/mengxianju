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
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 180000, args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = []; page.on('pageerror', e => errs.push(e.message));
page.on('dialog', async d => { await d.accept(); });
let mode = { tidy: 'compress', summary: [] };
await page.setRequestInterception(true);
page.on('request', req => {
  const u = req.url();
  if (u.includes('deepseek') || u.includes('/chat/completions')) {
    if (req.method() === 'OPTIONS') { req.respond({ status:204, headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'*'} }); return; }
    const body = JSON.parse(req.postData() || '{}');
    if (body.stream) { req.respond({ status:200, headers:{'Access-Control-Allow-Origin':'*'}, contentType:'text/event-stream', body: 'data: '+JSON.stringify({choices:[{delta:{content:'好'}}]})+'\n\ndata: [DONE]\n\n' }); return; }
    const sys = (body.messages||[]).map(m=>m.content).join('\n');
    // ⚠️ 判据更新（v1.21.24 修）。
    // 原来认的是 '重新回想一遍'，但整理提示词早就改成 '重新整理一遍' 了 ——
    // 于是一直把整理请求误判成【普通总结】，返回 mode.summary。
    // 表现：场景 1 的 summary=[] → 0 条、场景 2 的 summary=[1条] → 1 条，
    // 这条测试【早就没在测它该测的东西】。
    const isTidy = sys.includes('重新整理一遍') || sys.includes('合并同主题');
    let input = []; try { input = JSON.parse((body.messages||[]).slice(-1)[0].content); } catch {}
    let items;
    if (isTidy) {
      items = mode.tidy === 'cannot' ? (Array.isArray(input)?input:[]).map((x,i)=>({text:x.text||('归'+i),kind:'fact',untilDay:null,freq:'normal'}))
                                     : (Array.isArray(input)?input:[]).slice(0,8).map((x,i)=>({text:'归'+i,kind:'fact',untilDay:null,freq:'normal'}));
    } else { items = mode.summary; }
    req.respond({ status:200, headers:{'Access-Control-Allow-Origin':'*'}, contentType:'application/json', body: JSON.stringify({choices:[{message:{content:JSON.stringify(items)}}]}) });
    return;
  }
  req.continue();
});
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
const readKv = (k) => page.evaluate(async (key) => {
  const open = () => new Promise(r => { const o = indexedDB.open('ai-companion'); o.onsuccess = () => r(o.result); });
  const db = await open();
  const v = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get(key); q.onsuccess = () => r(q.result); });
  db.close(); return v ? v.v : null;
}, k);
const msgStat = () => page.evaluate(async () => {
  const open = () => new Promise(r => { const o = indexedDB.open('ai-companion'); o.onsuccess = () => r(o.result); });
  const db = await open();
  const all = await new Promise(r => { const q = db.transaction('messages').objectStore('messages').getAll(); q.onsuccess = () => r(q.result); });
  db.close(); return { total: all.length, arch: all.filter(m=>m.archived).length };
});

await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
await sleep(1500);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil:'networkidle0' }); await sleep(400)   // [提速] 原 1800：探针实测 reload 后 app 就绪只要 ~1ms;
// v1.21.59：全新安装不再自动建角色（产品改空），测试自己塞一个
await seedChar(page, '测试角色', { greeting: '' });   // 空开场白：不额外多出一条消息
await page.reload({waitUntil:'networkidle0'}); await sleep(500);
const cid = await page.evaluate(async () => {
  const open = () => new Promise(r => { const o = indexedDB.open('ai-companion'); o.onsuccess = () => r(o.result); });
  const db = await open();
  const c = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').getAll(); q.onsuccess = () => r(q.result[0]); });
  const t2 = db.transaction('messages','readwrite');
  for (let i=0;i<120;i++) t2.objectStore('messages').put({ id:'h'+i, charId:c.id, role:i%2?'assistant':'user', content:'内容'+i, images:[], imageNotes:[], ts: Date.now()-(120-i)*1000 });
  await new Promise(r => { t2.oncomplete = r; });
  const tm = db.transaction('memories','readwrite');
  for (let i=0;i<20;i++) tm.objectStore('memories').put({ id:'s'+i, charId:c.id, text:'满'+i, kind:'fact', untilDay:null, ts: Date.now() });
  await new Promise(r => { tm.oncomplete = r; });
  db.close(); return c.id;
});
await page.reload({ waitUntil:'networkidle0' }); await sleep(400)   // [提速] 原 2200：探针实测 reload 后 app 就绪只要 ~1ms;

console.log('=== 1. 记忆满且压不动 → 不归档，并说明原因 ===');
mode = { tidy: 'cannot', summary: [] };
// v1.15.2 起右上角⚙改成拉开【抽屉】，设置页要从抽屉里的「全部设置」进
await openSettings(page, sleep);
await page.evaluate(() => {
  const b = [...document.querySelectorAll('#drawer-menu [data-wb-drawer]')].find(x => x.dataset.wbDrawer === 'settings');
  if (b) b.click();
}); await sleep(900);
// ⚠️ 必须自己把 Key 摆上（v1.21.40 修）。
//    产品从这一版起默认 apiKey 是空串（原来预置的那把反编译就能拿走，已移除），
//    而本套件从来没设过 Key —— 归档要调模型，api.js:47 会在 fetch 之前就抛
//    「未配置 API Key，请到「设置」里填写」，于是"能腾出位置时正常归档"必然失败。
//    教训：测试依赖的产品默认值变了，得跟着把前置条件显式写出来。
await page.$eval('#s-apikey', el => { el.value = 'sk-test'; el.dispatchEvent(new Event('change', { bubbles: true })); });
await sleep(300);
await page.evaluate(() => document.getElementById('arch-fold').click()); await sleep(900);
await page.evaluate(() => document.getElementById('btn-archive-now').click()); await sleep(800);
await page.evaluate(() => document.getElementById('modal-ok').click());
for (let i=0;i<40;i++){ await sleep(400); const d=await page.$eval('#btn-archive-now',e=>e.disabled).catch(()=>false); if(!d) break; }
await sleep(1200);
const st1 = await msgStat();
const toast1 = await page.evaluate(() => { const el=document.getElementById('toast'); return el && !el.classList.contains('hidden') ? el.textContent : '(无)'; });
console.log('   ' + JSON.stringify(st1) + ' | ' + toast1);
t('记忆腾不出位置时不归档（对话保住）', st1.arch === 0, String(st1.arch));
t('说明了失败原因', /记忆已满|没整理成功/.test(toast1), toast1);

console.log('');
console.log('=== 2. 记忆能压缩 → 正常归档 ===');
mode = { tidy: 'compress', summary: [{ text:'新记忆', kind:'fact', untilDay:null, freq:'normal' }] };
await page.evaluate(() => document.getElementById('btn-archive-now').click()); await sleep(800);
await page.evaluate(() => document.getElementById('modal-ok').click());
for (let i=0;i<60;i++){ await sleep(400); const d=await page.$eval('#btn-archive-now',e=>e.disabled).catch(()=>false); if(!d) break; }
await sleep(1200);
const st2 = await msgStat();
console.log('   ' + JSON.stringify(st2));
t('能腾出位置时正常归档', st2.arch > 0, String(st2.arch));

console.log('');
console.log('=== 3. 清空聊天会重置全部记账键 ===');
await page.evaluate(() => document.getElementById('btn-clear-chat').click()); await sleep(800);
await page.evaluate(() => { const b=document.getElementById('modal-ok'); if(b) b.click(); }); await sleep(800);
await page.evaluate(() => { const b=document.getElementById('modal-ok'); if(b&&!document.getElementById('modal').classList.contains('hidden')) b.click(); }); await sleep(2000);
const keys = ['memSummed:','memSumAt:','memDedupeAt:','memArchiveAt:','memDeleted:','msgSeq:'];
const left = [];
for (const k of keys) { const v = await readKv(k + cid); if (v !== null) left.push(k + '=' + JSON.stringify(v).slice(0,20)); }
console.log('   残留的键: ' + (left.length ? JSON.stringify(left) : '(无，全清了)'));
t('六个记账键全部清空', left.length === 0, JSON.stringify(left));

console.log('');
if (errs.length) console.log('  JS 错误: ' + JSON.stringify(errs.slice(0,3)));
t('全程无 JS 错误', errs.length === 0, errs.slice(0,2).join(' | '));
console.log('');
console.log('========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close(); server.close();
process.exit(fail ? 1 : 0);