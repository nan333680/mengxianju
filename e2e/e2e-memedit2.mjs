import puppeteer from 'puppeteer-core';
import { seedChar } from './e2e-helper.mjs';
import http from 'http'; import fs from 'fs'; import path from 'path';
// 工作目录自适应（原来写死 C:/A-DSH-Tool/ai-companion）
const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');
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
await page.setRequestInterception(true);
page.on('request', req => {
  const u = req.url();
  if (u.includes('deepseek') || u.includes('/chat/completions')) {
    if (req.method() === 'OPTIONS') { req.respond({ status:204, headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'*'} }); return; }
    const body = JSON.parse(req.postData() || '{}');
    if (body.stream) { req.respond({ status:200, headers:{'Access-Control-Allow-Origin':'*'}, contentType:'text/event-stream', body:'data: '+JSON.stringify({choices:[{delta:{content:'好'}}]})+'\n\ndata: [DONE]\n\n' }); return; }
    const sys = (body.messages||[]).map(m=>m.content).join('\n');
    let input = []; try { input = JSON.parse((body.messages||[]).slice(-1)[0].content); } catch {}
    // ⚠️ 判定条件要【只在查重提示里出现】。
    // 踩过两次：① 用「重新回想一遍」当特征，改版后失配；
    // ② 用「整理 + JSON 数组」，但录入记忆的提示里也有这两个词 → 两条路径都走整理分支。
    // 现在用查重提示独有的「第一步：合并同主题」当特征。
    const items = sys.includes('第一步：合并同主题')
      ? (Array.isArray(input)?input:[]).map((x,i)=>({ text:'改写'+i, kind:'fact', untilDay:null, freq:'normal' }))
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
const memList = () => page.evaluate(async () => {
  const open = () => new Promise(r => { const o = indexedDB.open('ai-companion'); o.onsuccess = () => r(o.result); });
  const db = await open();
  const ms = await new Promise(r => { const q = db.transaction('memories').objectStore('memories').getAll(); q.onsuccess = () => r(q.result); });
  db.close(); return ms.map(m => ({ text:m.text, kind:m.kind, untilDay:m.untilDay, mine:!!m.mine }));
});

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
const cid = await page.evaluate(async () => {
  const open = () => new Promise(r => { const o = indexedDB.open('ai-companion'); o.onsuccess = () => r(o.result); });
  const db = await open();
  const c = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').getAll(); q.onsuccess = () => r(q.result[0]); });
  // 塞：2 条她的(event) + 1 条她的(fact) + 1 条你的(mine)
  const t2 = db.transaction('memories','readwrite');
  const st = t2.objectStore('memories');
  st.put({ id:'h1', charId:c.id, text:'她的长期事实', kind:'fact', untilDay:null, ts: Date.now() });
  st.put({ id:'h2', charId:c.id, text:'她的限时事件', kind:'event', untilDay:5, ts: Date.now()+1 });
  st.put({ id:'h3', charId:c.id, text:'她记的另一条', kind:'fact', untilDay:null, ts: Date.now()+2 });
  st.put({ id:'m1', charId:c.id, text:'你必须记住我喜欢辣', kind:'fact', untilDay:null, mine:true, ts: Date.now()+3 });
  await new Promise(r => { t2.oncomplete = r; });
  db.close(); return c.id;
});
await page.reload({ waitUntil:'networkidle0' }); await sleep(400)   // [提速] 原 2000：探针实测 reload 后 app 就绪只要 ~1ms;

console.log('=== 1. 她的 event 型取消有效期 → kind 应变回 fact ===');
await page.evaluate(() => document.getElementById('btn-chars').click()); await sleep(700);
await page.evaluate(() => document.querySelectorAll('#char-list .char-card button[data-edit]')[0].click()); await sleep(900);
await page.evaluate(() => document.getElementById('e-mem-fold').click()); await sleep(900);
// 点开"她的限时事件"
await page.evaluate(() => {
  const it = [...document.querySelectorAll('#e-mem-list .mem-item')].find(x => x.textContent.includes('她的限时事件'));
  it.click();
});
await sleep(700);
const preChecked = await page.$eval('#mem-edit-hasexp', el => el.checked);
t('打开时有效期是勾上的', preChecked === true);
await page.evaluate(() => {
  const c = document.getElementById('mem-edit-hasexp');
  c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true }));
});
await sleep(200);
await page.evaluate(() => document.getElementById('modal-ok').click()); await sleep(900);
const l1 = await memList();
const h2 = l1.find(m => m.text === '她的限时事件');
console.log('   ' + JSON.stringify(h2));
t('untilDay 清空了', h2 && h2.untilDay === null, JSON.stringify(h2));
t('kind 变回 fact（不留脏数据）', h2 && h2.kind === 'fact', JSON.stringify(h2 && h2.kind));

console.log('');
console.log('=== 2. 关闭弹窗（点取消）不改数据 ===');
const before = JSON.stringify(await memList());
await page.evaluate(() => {
  const it = [...document.querySelectorAll('#e-mem-list .mem-item')].find(x => x.textContent.includes('她的长期事实'));
  it.click();
});
await sleep(700);
await page.evaluate(() => { document.getElementById('mem-edit-text').value = '被改过的内容'; });
await page.evaluate(() => document.getElementById('modal-cancel').click());
await sleep(700);
const after = JSON.stringify(await memList());
t('点取消 → 数据没变', before === after, '');
t('弹窗关掉了', await page.$eval('#modal', el => el.classList.contains('hidden')));

console.log('');
console.log('=== 3. 开关关着 → 整理不动 mine 的 ===');
await page.evaluate(() => document.getElementById('btn-edit-back').click()); await sleep(600);
await openSettings(page, sleep);
await page.evaluate(() => document.getElementById('mem-set-fold').click()); await sleep(800);
const vBefore = await page.evaluate(() => (document.querySelector('.view.active')||{}).id);
console.log('   点整理前所在页: ' + vBefore);
const tidyExists = await page.evaluate(() => !!document.getElementById('btn-mem-tidy'));
console.log('   整理按钮存在: ' + tidyExists);
await page.evaluate(() => { const b = document.getElementById('btn-mem-tidy'); if (b) b.click(); });
for (let i=0;i<30;i++){ await sleep(400); const d=await page.$eval('#btn-mem-tidy',e=>e.disabled).catch(()=>false); if(!d) break; }
await sleep(1200);
const l3 = await memList();
console.log('   ' + JSON.stringify(l3.map(m => ({ t:m.text.slice(0,10), mine:m.mine }))));
const kept = l3.find(m => m.mine);
t('自定义那条没被改写', kept && kept.text === '你必须记住我喜欢辣', JSON.stringify(kept));
t('她的那些被改写了（正常参与整理）', l3.some(m => !m.mine && m.text.startsWith('改写')), JSON.stringify(l3.map(m=>m.text.slice(0,6))));

console.log('');
console.log('=== 4. 开关打开 → 允许一起整理 ===');
await page.evaluate(() => document.getElementById('btn-set-back').click()); await sleep(600);
  await page.evaluate(() => { const b = document.getElementById('btn-drawer-close'); if (b && document.querySelector('#view-drawer.active')) b.click(); });
  await sleep(500);
await page.evaluate(() => document.getElementById('btn-chars').click()); await sleep(700);
await page.evaluate(() => document.querySelectorAll('#char-list .char-card button[data-edit]')[0].click()); await sleep(900);
await page.evaluate(() => { document.getElementById('e-allow-edit-mine').checked = true; });
await page.evaluate(() => document.getElementById('btn-edit-save').click()); await sleep(1500);
await openSettings(page, sleep);
await page.evaluate(() => document.getElementById('mem-set-fold').click()); await sleep(800);
await page.evaluate(() => document.getElementById('btn-mem-tidy').click());
for (let i=0;i<30;i++){ await sleep(400); const d=await page.$eval('#btn-mem-tidy',e=>e.disabled).catch(()=>false); if(!d) break; }
await sleep(1200);
const l4 = await memList();
console.log('   ' + JSON.stringify(l4.map(m => m.text.slice(0,8))));
t('打开后自定义那条也被整理了', !l4.some(m => m.text === '你必须记住我喜欢辣'), JSON.stringify(l4.map(m=>m.text.slice(0,8))));

console.log('');
if (errs.length) console.log('  JS 错误: ' + JSON.stringify(errs.slice(0,3)));
t('全程无 JS 错误', errs.length === 0, errs.slice(0,2).join(' | '));
console.log('');
console.log('========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
