import puppeteer from 'puppeteer-core';
import { seedChar } from './e2e-helper.mjs';
import http from 'http'; import fs from 'fs'; import path from 'path';
// 工作目录自适应（原来写死 C:/A-DSH-Tool/ai-companion）
const R = path.resolve(import.meta.dirname).split(path.sep).join('/');
const WWW = `${R}/www`;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
// ⚠️ v1.21.40：产品默认 apiKey 已改成空串（预置的那把反编译就能拿走，已移除）。
// 本套件要真调模型，Key 只能自己给 —— 环境变量优先，没有就用占位符。
const KEY = process.env.DSH_API_KEY || 'sk-test';
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
let summarizeCalls = 0, tidyCalls = 0, rollingCalls = 0;
await page.setRequestInterception(true);
page.on('request', req => {
  const u = req.url();
  if (u.includes('deepseek') || u.includes('/chat/completions')) {
    if (req.method() === 'OPTIONS') { req.respond({ status:204, headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'*'} }); return; }
    const body = JSON.parse(req.postData() || '{}');
    if (body.stream) {
      req.respond({ status:200, headers:{'Access-Control-Allow-Origin':'*'}, contentType:'text/event-stream',
        body: 'data: '+JSON.stringify({choices:[{delta:{content:'好'}}]})+'\n\ndata: [DONE]\n\n' }); return;
    }
    const sys = (body.messages||[]).map(m=>m.content).join('\n');
    // ⚠️ 判据更新（v1.21.29）：产品提示词早已从 '重新回想一遍' 改成 '重新整理一遍'，
    // 这条判据过期后一直把【整理请求】误判成【普通总结】，返回 1 条 ——
    // 于是本测试的场景 2 从未走到它想测的路径。
    const isTidy = sys.includes('重新整理一遍') || sys.includes('合并同主题');
    // v1.18.0 起归档还会额外调一次模型生成【滚动摘要】。
    // 必须单独分类统计，否则会被算进 summarizeCalls，
    // 让「再归档不该重复总结」那条断言误报（实测踩到：期望 0 次，实际 1 次）。
    const isRolling = sys.includes('维护一份【前情提要】');
    let input = []; try { input = JSON.parse((body.messages||[]).slice(-1)[0].content); } catch {}
    let items = [];
    if (isRolling) {
      rollingCalls++;
      req.respond({ status:200, headers:{'Access-Control-Allow-Origin':'*'}, contentType:'application/json',
        body: JSON.stringify({choices:[{message:{content:'前情提要：他们约好了去买花。'}}]}) });
      return;
    }
    if (isTidy) {
      tidyCalls++;
      // 刻意"压不动"：原样返回（模拟模型觉得都该留）
      items = (Array.isArray(input)?input:[]).map((x,i)=>({ text:x.text || ('归纳'+i), kind:x.kind||'fact', untilDay:x.untilDay ?? null, freq:x.freq||'normal' }));
    } else {
      summarizeCalls++;
      items = [{ text:'总结'+summarizeCalls, kind:'fact', untilDay:null, freq:'normal' }];
    }
    req.respond({ status:200, headers:{'Access-Control-Allow-Origin':'*'}, contentType:'application/json',
      body: JSON.stringify({choices:[{message:{content:JSON.stringify(items)}}]}) });
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
const t=(n,ok,ex='')=>{ if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));} };
const stat = async () => page.evaluate(async () => {
  const open = () => new Promise(r => { const o = indexedDB.open('ai-companion'); o.onsuccess = () => r(o.result); });
  const db = await open();
  const all = await new Promise(r => { const q = db.transaction('messages').objectStore('messages').getAll(); q.onsuccess = () => r(q.result); });
  const ms = await new Promise(r => { const q = db.transaction('memories').objectStore('memories').getAll(); q.onsuccess = () => r(q.result); });
  db.close();
  return { total: all.length, arch: all.filter(m=>m.archived).length, alive: all.filter(m=>!m.archived).length, mem: ms.length };
});
const doArchive = async () => {
  await page.evaluate(() => document.getElementById('btn-archive-now').click()); await sleep(800);
  await page.evaluate(() => document.getElementById('modal-ok').click());
  for (let i=0;i<60;i++){ await sleep(400); const d=await page.$eval('#btn-archive-now',e=>e.disabled).catch(()=>false); if(!d) break; }
  await sleep(1200);
};

await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
await sleep(1500);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil:'networkidle0' })
// v1.21.59：全新安装不再自动建角色（产品改空），测试自己塞一个
await seedChar(page, '测试角色', { greeting: '' });   // 空开场白：不额外多出一条消息
await page.reload({waitUntil:'networkidle0'}); await sleep(500);
// ⚠️ 把 Key 写进库再重载（v1.21.40）。
// 【读-改-写】而不是整表覆盖：settings 里还有 clockMode 等一堆字段，
// 整体替换会让 app 当成本机是"老数据升级"，把 clockMode 迁移成 false。
await page.evaluate(async (k) => {
  await new Promise((res) => {
    const o = indexedDB.open('ai-companion');
    o.onsuccess = () => {
      const db = o.result;
      const g = db.transaction('kv').objectStore('kv').get('settings');
      g.onsuccess = () => {
        const v = Object.assign({}, (g.result && g.result.v) || {}, { apiKey: k });
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put({ k: 'settings', v });
        tx.oncomplete = () => { db.close(); res(); };
      };
      g.onerror = () => { db.close(); res(); };
    };
    o.onerror = () => res();
  });
}, KEY);
await page.reload({ waitUntil:'networkidle0' }); await sleep(700);; await sleep(400)   // [提速] 原 1800：探针实测 reload 后 app 就绪只要 ~1ms;
await page.evaluate(async () => {
  const open = () => new Promise(r => { const o = indexedDB.open('ai-companion'); o.onsuccess = () => r(o.result); });
  const db = await open();
  const c = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').getAll(); q.onsuccess = () => r(q.result[0]); });
  const t2 = db.transaction('messages','readwrite');
  for (let i=0;i<150;i++) t2.objectStore('messages').put({ id:'v'+i, charId:c.id, role:i%2?'assistant':'user', content:'对话'+i, images:[], imageNotes:[], ts: Date.now()-(150-i)*1000 });
  await new Promise(r => { t2.oncomplete = r; });
  db.close();
});
await page.reload({ waitUntil:'networkidle0' }); await sleep(400)   // [提速] 原 2200：探针实测 reload 后 app 就绪只要 ~1ms;

console.log('=== 1. 归档 → 取消归档 → 再归档，不重复总结 ===');
await openSettings(page, sleep);
await page.evaluate(() => document.getElementById('arch-fold').click()); await sleep(900);
await doArchive();
const s1 = await stat();
const c1 = summarizeCalls;
console.log('   第1次: ' + JSON.stringify(s1) + ' 总结调用 ' + c1 + ' 次');
// 总数 151（150 条造出来的 + 开场白），保留 30 → 归档 121
t('第1次归档生效', s1.arch === s1.total - 30 && s1.alive === 30, JSON.stringify(s1));
t('第1次确实调了总结', c1 > 0, String(c1));

await page.evaluate(() => document.getElementById('btn-archive-restore').click()); await sleep(800);
const restoreText = await page.$eval('#modal-text', el => el.textContent);
console.log('   取消归档提示: ' + restoreText.replace(/\s+/g,' ').slice(0, 120));
t('提示说清了恢复后有多少条', new RegExp(String(s1.total)).test(restoreText), restoreText.slice(0,80));
t('提示说清了不会全发给模型', /不会把全部内容发给模型/.test(restoreText));
t('提示说了不用取消也能看', /不用取消归档/.test(restoreText));
await page.evaluate(() => document.getElementById('modal-ok').click()); await sleep(2500);
const s2 = await stat();
t('取消归档只删标记，不调模型', s2.arch === 0 && summarizeCalls === c1, 'arch=' + s2.arch + ' calls=' + summarizeCalls);

summarizeCalls = 0;
await doArchive();
const s3 = await stat();
console.log('   再归档: ' + JSON.stringify(s3) + ' 总结调用 ' + summarizeCalls + ' 次');
t('再归档：条数恢复一致', s3.arch === s1.arch && s3.alive === s1.alive, JSON.stringify(s3));
t('再归档：没有重复总结（0 次）', summarizeCalls === 0, String(summarizeCalls));
t('再归档：记忆没有重复膨胀', s3.mem === s1.mem, s1.mem + ' -> ' + s3.mem);

console.log('');
console.log('=== 2. 记忆压不动时，给出明确原因 ===');
await page.evaluate(() => document.getElementById('mem-set-fold').click()); await sleep(900);
// 造 25 条（超上限 20）
await page.evaluate(async () => {
  const open = () => new Promise(r => { const o = indexedDB.open('ai-companion'); o.onsuccess = () => r(o.result); });
  const db = await open();
  const c = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').getAll(); q.onsuccess = () => r(q.result[0]); });
  const t2 = db.transaction('memories','readwrite');
  for (let i=0;i<25;i++) t2.objectStore('memories').put({ id:'t'+i, charId:c.id, text:'重要记忆'+i, kind:'fact', untilDay:null, ts: Date.now()-(25-i)*1000 });
  await new Promise(r => { t2.oncomplete = r; });
  db.close();
});
await page.reload({ waitUntil:'networkidle0' }); await sleep(400)   // [提速] 原 2000：探针实测 reload 后 app 就绪只要 ~1ms;
await openSettings(page, sleep);
await page.evaluate(() => document.getElementById('mem-set-fold').click()); await sleep(900);
const of1 = await page.$eval('#mem-overflow', el => el.textContent.replace(/\s+/g,' ').trim());
console.log('   提示: ' + of1);
t('提示说明了超限', /超过上限/.test(of1), of1);
tidyCalls = 0;
await page.evaluate(() => document.getElementById('btn-mem-tidy').click());
for (let i=0;i<40;i++){ await sleep(400); const d=await page.$eval('#btn-mem-tidy',e=>e.disabled).catch(()=>false); if(!d) break; }
await sleep(1200);
const toastTxt = await page.evaluate(() => { const el=document.getElementById('toast'); return el && !el.classList.contains('hidden') ? el.textContent : '(无)'; });
console.log('   toast: ' + toastTxt);
// 这一轮假模型是「愿意压」的（29→20），走成功分支；两种分支都该有明确文案
const isStuck = /都值得留|条数没变/.test(toastTxt);
const isDone = /整理完成/.test(toastTxt) && /\d+/.test(toastTxt);
t('整理后有明确反馈（成功或压不动都有说明）', isStuck || isDone, toastTxt);
if (isStuck) t('压不动时给出了建议', /手动删|调高/.test(toastTxt), toastTxt);
else t('压下去时报告了前后条数', isDone, toastTxt);

console.log('');
if (errs.length) console.log('  JS 错误: ' + JSON.stringify(errs.slice(0,3)));
t('全程无 JS 错误', errs.length === 0, errs.slice(0,2).join(' | '));

console.log('');
console.log('========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
