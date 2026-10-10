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
await page.setRequestInterception(true);
page.on('request', req => {
  const u = req.url();
  if (u.includes('deepseek') || u.includes('/chat/completions')) {
    if (req.method() === 'OPTIONS') { req.respond({ status:204, headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'*'} }); return; }
    const body = JSON.parse(req.postData() || '{}');
    if (body.stream) { req.respond({ status:200, headers:{'Access-Control-Allow-Origin':'*'}, contentType:'text/event-stream', body:'data: '+JSON.stringify({choices:[{delta:{content:'好'}}]})+'\n\ndata: [DONE]\n\n' }); return; }
    // 整理时故意"改写"：把所有条目换成"被她改写过"
    const sys = (body.messages||[]).map(m=>m.content).join('\n');
    let input = []; try { input = JSON.parse((body.messages||[]).slice(-1)[0].content); } catch {}
    // ⚠️ 判据更新（v1.21.29）：产品提示词早已从 '重新回想一遍' 改成 '重新整理一遍'，
    // 这条过期后一直走 else 分支（返回 1 条），本套件从未测到"被改写"那条路径。
    const items = (sys.includes('重新整理一遍') || sys.includes('合并同主题'))
      ? (Array.isArray(input)?input:[]).map((x,i)=>({ text:'被她改写过'+i, kind:'fact', untilDay:null, freq:'normal' }))
      : [{ text:'她新记的', kind:'fact', untilDay:null, freq:'normal' }];
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
const jsClick = (s) => page.evaluate(x => document.querySelector(x).click(), s);
const memList = () => page.evaluate(async () => {
  const open = () => new Promise(r => { const o = indexedDB.open('ai-companion'); o.onsuccess = () => r(o.result); });
  const db = await open();
  const ms = await new Promise(r => { const q = db.transaction('memories').objectStore('memories').getAll(); q.onsuccess = () => r(q.result); });
  db.close(); return ms.map(m => ({ text:m.text, kind:m.kind, untilDay:m.untilDay, mine:!!m.mine }));
});

await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
await sleep(1500);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil:'networkidle0' }); await sleep(400)   // [提速] 原 1800：探针实测 reload 后 app 就绪只要 ~1ms;
// v1.21.59：全新安装不再自动建角色（产品改空），测试自己塞一个
await seedChar(page, '测试角色', { greeting: '' });   // 空开场白：不额外多出一条消息
await page.reload({waitUntil:'networkidle0'}); await sleep(500);
await openSettings(page, sleep);
await page.evaluate(() => document.getElementById('s-apikey') && (document.getElementById('s-apikey').value='k', document.getElementById('s-apikey').dispatchEvent(new Event('change',{bubbles:true}))));
await page.$eval('#s-baseurl',(el,p)=>{el.value=p;el.dispatchEvent(new Event('change',{bubbles:true}));},'http://127.0.0.1:'+port+'/api');
await sleep(400);
await page.evaluate(() => document.getElementById('btn-set-back').click()); await sleep(600);
  await page.evaluate(() => { const b = document.getElementById('btn-drawer-close'); if (b && document.querySelector('#view-drawer.active')) b.click(); });
  await sleep(500);

console.log('=== 1. 角色页有开关，默认关 ===');
await page.evaluate(() => document.getElementById('btn-chars').click()); await sleep(700);
await page.evaluate(() => document.querySelectorAll('#char-list .char-card button[data-edit]')[0].click()); await sleep(900);
t('有「允许她整理时修改我自己加的」开关', !!(await page.$('#e-allow-edit-mine')));
t('默认是关的', (await page.$eval('#e-allow-edit-mine', el => el.checked)) === false);

console.log('');
console.log('=== 2. 加一条自定义记忆，带「自定义」标签 ===');
await page.evaluate(() => document.getElementById('e-mem-fold').click()); await sleep(800);
await page.evaluate(() => {
  const i = document.getElementById('e-mem-input');
  i.value = '你必须记住我最爱吃辣';
  i.dispatchEvent(new Event('input', { bubbles: true }));
});
await sleep(200);
await jsClick('#e-mem-add'); await sleep(900);
const after1 = await memList();
console.log('   ' + JSON.stringify(after1));
t('入库了', after1.length === 1, JSON.stringify(after1.length));
t('带 mine 标记', after1[0].mine === true, JSON.stringify(after1[0]));
const tags = await page.$$eval('#e-mem-list .mem-item .mem-foot .mem-tag', els => els.map(e => e.textContent.trim()));
console.log('   标签: ' + JSON.stringify(tags));
t('显示「长期」标签', tags.includes('长期'), JSON.stringify(tags));
t('显示「自定义」标签', tags.includes('自定义'), JSON.stringify(tags));
const order = await page.$$eval('#e-mem-list .mem-item .mem-foot', els => els[0].textContent.replace(/\s+/g,''));
t('长期在前、自定义在后', order === '长期自定义', order);

// 布局：标签必须在正文【下面】，且和正文【左对齐】
// 以前的 bug：.mem-item 是横排 flex，标签被挤到正文右边去了
const geo = await page.evaluate(() => {
  const item = document.querySelector('#e-mem-list .mem-item');
  const txt = item.querySelector('.txt').getBoundingClientRect();
  const foot = item.querySelector('.mem-foot').getBoundingClientRect();
  return { txtTop: Math.round(txt.top), txtLeft: Math.round(txt.left),
           footTop: Math.round(foot.top), footLeft: Math.round(foot.left) };
});
console.log('   布局: ' + JSON.stringify(geo));
t('标签在正文下方（另起一行）', geo.footTop > geo.txtTop + 10, JSON.stringify(geo));
t('标签和正文左对齐（左下角）', Math.abs(geo.footLeft - geo.txtLeft) <= 2, JSON.stringify(geo));

console.log('');
console.log('=== 3. 点开弹窗改时间 ===');
await page.evaluate(() => document.querySelector('#e-mem-list .mem-item').click());
await sleep(700);
t('弹窗打开了', !(await page.$eval('#modal', el => el.classList.contains('hidden'))));
t('有内容输入框', !!(await page.$('#mem-edit-text')));
t('有有效期勾选框', !!(await page.$('#mem-edit-hasexp')));
t('有天数输入框', !!(await page.$('#mem-edit-exp')));
await page.evaluate(() => {
  const c = document.getElementById('mem-edit-hasexp');
  c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true }));
  const n = document.getElementById('mem-edit-exp');
  n.value = '7';
});
await sleep(300);
await jsClick('#modal-ok'); await sleep(900);
const after2 = await memList();
console.log('   ' + JSON.stringify(after2));
t('时间写进去了', after2[0].untilDay === 7, JSON.stringify(after2[0]));
t('kind 自动变成 event', after2[0].kind === 'event', after2[0].kind);
const tags2 = await page.$$eval('#e-mem-list .mem-item .mem-foot .mem-tag', els => els.map(e => e.textContent.trim()));
console.log('   标签: ' + JSON.stringify(tags2));
t('显示「第 7 天」', tags2.includes('第 7 天'), JSON.stringify(tags2));

console.log('');
console.log('=== 4. 开关关着时，整理不改我的 ===');
// 切到设置页手动整理记忆
await page.evaluate(() => document.getElementById('btn-edit-back').click()); await sleep(600);
await openSettings(page, sleep);
await page.evaluate(() => document.getElementById('mem-set-fold').click()); await sleep(800);
await jsClick('#btn-mem-tidy');
for (let i=0;i<30;i++){ await sleep(400); const d=await page.$eval('#btn-mem-tidy',e=>e.disabled).catch(()=>false); if(!d) break; }
await sleep(1200);
const after3 = await memList();
console.log('   ' + JSON.stringify(after3));
const mineKept = after3.find(m => m.mine);
t('自定义那条没被改写', mineKept && mineKept.text === '你必须记住我最爱吃辣', JSON.stringify(mineKept));

console.log('');
console.log('=== 5. 开关打开后，允许她整理 ===');
await page.evaluate(() => document.getElementById('btn-set-back').click()); await sleep(600);
  await page.evaluate(() => { const b = document.getElementById('btn-drawer-close'); if (b && document.querySelector('#view-drawer.active')) b.click(); });
  await sleep(500);
await page.evaluate(() => document.getElementById('btn-chars').click()); await sleep(700);
await page.evaluate(() => document.querySelectorAll('#char-list .char-card button[data-edit]')[0].click()); await sleep(900);
await page.evaluate(() => { const c=document.getElementById('e-allow-edit-mine'); c.checked=true; });
await jsClick('#btn-edit-save'); await sleep(1500);
const savedFlag = await page.evaluate(async () => {
  const open = () => new Promise(r => { const o = indexedDB.open('ai-companion'); o.onsuccess = () => r(o.result); });
  const db = await open();
  const cs = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').getAll(); q.onsuccess = () => r(q.result); });
  db.close(); return cs[0].allowEditMine;
});
t('开关存进了角色', savedFlag === true, String(savedFlag));

console.log('');
if (errs.length) console.log('  JS 错误: ' + JSON.stringify(errs.slice(0,3)));
t('全程无 JS 错误', errs.length === 0, errs.slice(0,2).join(' | '));
console.log('');
console.log('========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
