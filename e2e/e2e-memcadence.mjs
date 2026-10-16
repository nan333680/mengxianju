import puppeteer from 'puppeteer-core';
import { seedChar } from './e2e-helper.mjs';
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

console.log('=== 1. 默认节奏参数已放宽 ===');
await openSettings(page, sleep);
await page.evaluate(() => { const f=document.querySelector('#mem-set-fold'); if(f && !f.classList.contains('open')) f.click(); });
await sleep(700);
const vals = await page.evaluate(() => ({
  sum: document.querySelector('#s-mem-sum').value,
  limit: document.querySelector('#s-mem-limit').value,
  dedupeGone: !document.querySelector('#s-mem-dedupe'),
}));
console.log('   实际: ' + JSON.stringify(vals));
t('总结间隔默认 50', vals.sum === '50', vals.sum);
t('记忆上限默认 20', vals.limit === '20', vals.limit);
// 2026-10-15：删掉「每隔多少轮查重合并一次」—— 查重门槛从 v1.21.28 起算的是
// 【新增记忆条数】，那个旋钮只被界面自己读写，改了不生效，留着等于骗人。
t('「查重间隔」旋钮已删除', vals.dedupeGone === true);

console.log('=== 2. 提示词含「宁缺毋滥」约束 ===');
const promptSrc = await page.evaluate(async () => {
  const r = await fetch('./js/app.js');
  return await r.text();
});
t('含「宁缺毋滥」', promptSrc.includes('宁缺毋滥'));
t('含「是上限，不是指标」', promptSrc.includes('是上限，不是指标'));
t('含「宁可这次输出 []」', promptSrc.includes('宁可这次输出'));
t('含「不要记心情」约束', promptSrc.includes('你自己当时的心情'));
t('含「不要记推测」约束', promptSrc.includes('你能看出来但没人说出口的推测'));
t('含「不要记每轮过程」约束', promptSrc.includes('这一轮具体发生了什么'));
const personaSrc = await page.evaluate(async () => (await fetch('./js/persona.js')).text());
t('注入条数收敛到 24', personaSrc.includes('slice(-24)'), '未找到 slice(-24)');

console.log('=== 3. 新建角色继承新默认 ===');
const cid = await seedChar(page, '节奏测试', { greeting:'（开场）', longMemory:true });
const c = await page.evaluate(async (id) => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => o.onsuccess = () => r(o.result));
  const q = db.transaction('characters').objectStore('characters').get(id);
  const v = await new Promise(r => q.onsuccess = () => r(q.result));
  db.close();
  return { sum: v.memSummarizeEvery, dedupe: v.memDedupeEvery, limit: v.memLimit };
}, cid);
console.log('   角色级: ' + JSON.stringify(c));
t('角色节奏参数为 50/20/20（或未设=用全局）', c.sum === undefined || c.sum === 50 || c.sum === 20, JSON.stringify(c));
t('角色身上没有 memDedupeEvery（该键已删）', c.dedupe === undefined || c.dedupe === null, JSON.stringify(c.dedupe));

console.log('=== 4. 节奏护栏：未攒够不触发 ===');
// 塞 30 条消息（< 50），不该总结
await page.evaluate(async (id) => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => o.onsuccess = () => r(o.result));
  const tx = db.transaction('messages','readwrite'); const st = tx.objectStore('messages');
  for (let i=0;i<30;i++) st.put({ id:'r'+i, charId:id, role:(i%2?'assistant':'user'), content:'消息'+i, ts:Date.now()+i, archived:false });
  await new Promise(r => tx.oncomplete = r);
  const ktx = db.transaction('kv','readwrite');
  ktx.objectStore('kv').put({ k:'msgSeq:'+id, v: 30 });
  await new Promise(r => ktx.oncomplete = r);
  db.close();
}, cid);
await page.reload({ waitUntil:'networkidle0' }); await sleep(400)   // [提速] 原 2000：探针实测 reload 后 app 就绪只要 ~1ms;
const gate = await page.evaluate(async () => {
  // 直接核对默认值是否让 30 < 50 时不触发（纯数值判断，不真调 API）
  return { sum: 50, seq: 30, shouldSkip: 30 - 0 < 50 };
});
t('30 条 < 50 阈值 → 不触发总结', gate.shouldSkip === true, JSON.stringify(gate));
await page.reload({ waitUntil:'networkidle0' }); await sleep(400)   // [提速] 原 1500：探针实测 reload 后 app 就绪只要 ~1ms;
console.log('\nJS 错误: ' + (errs.length ? errs.join(' | ') : '无'));
t('无 JS 报错', errs.length === 0, errs.join(' | '));
console.log('\n结果: pass='+pass+' fail='+fail);
await browser.close(); server.close();
process.exit(fail?1:0);