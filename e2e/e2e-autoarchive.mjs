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

// mock 模型：非流式/流式都给空结果，带 CORS
const mock = http.createServer((req,res)=>{
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Headers','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  if (req.method==='OPTIONS'){ res.writeHead(204); res.end(); return; }
  if (req.url.includes('/user/balance')) {
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({ is_available:true, balance_infos:[{currency:'CNY', total_balance:'100'}], balance_infos2:[] }));
    return;
  }
  // 收集 body 判断流式/非流式：总结走非流式，必须返回合法 JSON 数组
  let body='';
  req.on('data',c=>body+=c);
  req.on('end',()=>{
    const isStream = /"stream"\s*:\s*true/.test(body);
    if (!isStream) {
      res.writeHead(200,{'Content-Type':'application/json'});
      // ⚠️ mock 改为返回【真实形状】的记忆（v1.21.35）。
      // 原来恒返回 []（0 条），而 0 产出现在语义是"这批先不归档、留待重试"——
      // 恒返回 0 等于永远不归档，那不是真实场景（真模型会提炼出内容）。
      res.end(JSON.stringify({ choices:[{message:{content:JSON.stringify([{text:'他喜欢红茶',kind:'fact',untilDay:null,freq:'normal'}])}}] }));
      return;
    }
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});
    res.write('data: ' + JSON.stringify({choices:[{delta:{content:'嗯。'}}]}) + '\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
await new Promise(r=>mock.listen(0,'127.0.0.1',r));
const mockPort = mock.address().port;

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 120000, args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs=[]; page.on('pageerror', e => errs.push(e.message));
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
const getSettings = () => page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => o.onsuccess = () => r(o.result));
  const q = db.transaction('kv').objectStore('kv').get('settings');
  const v = await new Promise(r => { q.onsuccess = () => r(q.result); });
  db.close();
  return v && v.v ? v.v : null;
});
const getSettingsStore = () => page.evaluate(() => indexedDB.open('ai-companion').objectStoreNames.contains('kv'));

await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
await sleep(1500);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil:'networkidle0' }); await sleep(200);
// v1.21.59：全新安装不再自动建角色（产品改空），测试自己塞一个
await seedChar(page, '测试角色', { greeting: '' });   // 空开场白：不额外多出一条消息
await page.reload({waitUntil:'networkidle0'}); await sleep(500);

console.log('=== 1. UI：开关存在、默认勾选、不重叠 ===');
await openSettings(page, sleep);
await page.evaluate(() => {
  const f = document.querySelector('#arch-fold');
  if (f && !f.classList.contains('open')) f.click();
});
await sleep(800);
const ui = await page.evaluate(() => {
  const b = document.querySelector('#s-arch-auto');
  const tip = document.querySelector('.arch-auto-tip');
  const lab = document.querySelector('#auto-arch-switch');
  if (!b) return null;
  const rb = lab.getBoundingClientRect(), rt = tip.getBoundingClientRect();
  const keepRow = document.querySelector('#s-arch-keep').closest('.field').getBoundingClientRect();
  return { checked: b.checked, hasTip: !!tip, gap: Math.round(rt.top - rb.bottom),
           gap2: Math.round(keepRow.top - rt.bottom),
           labelTxt: lab.textContent.trim() };
});
console.log('   UI: ' + JSON.stringify(ui));
t('开关存在且默认勾选', ui && ui.checked === true, JSON.stringify(ui));
t('说明文字存在', ui && ui.hasTip);
t('开关与说明不重叠（gap>=0）', ui && ui.gap >= 0, ui ? 'gap='+ui.gap : 'n/a');
t('说明与下一项不重叠（gap2>0）', ui && ui.gap2 > 0, ui ? 'gap2='+ui.gap2 : 'n/a');

console.log('=== 2. 关闭/开启会持久化 ===');
await page.evaluate(() => document.querySelector('#s-arch-auto').click());
await sleep(900);
const off = await getSettings();
t('关闭后 autoArchive=false', off && off.autoArchive === false, JSON.stringify(off && off.autoArchive));
await page.evaluate(() => document.querySelector('#s-arch-auto').click());
await sleep(900);
const on = await getSettings();
t('再打开后 autoArchive=true', on && on.autoArchive === true, JSON.stringify(on && on.autoArchive));

console.log('=== 3. 核心：发消息后自动归档真的跑 ===');
const cid = await seedChar(page, '自动归档测试', { greeting:'（开场）', longMemory:true });
await page.reload({ waitUntil:'networkidle0' }); await sleep(200);
// 塞 100 条未归档消息 + 设置：保留 10、开关开、apiKey 指向 mock
await page.evaluate(async ({cid, mockPort}) => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => o.onsuccess = () => r(o.result));
  const tx = db.transaction('messages','readwrite'); const st = tx.objectStore('messages');
  for (let i=0;i<100;i++) {
    st.put({ id:'m'+i, charId:cid, role:(i%2?'assistant':'user'), content:'消息'+i, ts:Date.now()+i, archived:false });
  }
  await new Promise(r => tx.oncomplete = r);
  const ktx = db.transaction('kv','readwrite'); const ks = ktx.objectStore('kv');
  const g = await new Promise(r => { const q = ks.get('settings'); q.onsuccess = () => r(q.result); });
  const val = Object.assign({}, (g && g.v) || {});
  val.archiveKeep = 10; val.autoArchive = true; val.apiKey='sk-test';
  val.baseUrl = 'http://127.0.0.1:'+mockPort+'/v1';
  ks.put({ k:'settings', v: val });
  await new Promise(r => ktx.oncomplete = r);
  db.close();
}, {cid, mockPort});
await page.reload({ waitUntil:'networkidle0' }); await sleep(200);
await page.click('#btn-chars'); await sleep(700);
await page.evaluate(() => {
  const c = [...document.querySelectorAll('#char-list .char-card')].find(x => x.textContent.includes('自动归档测试'));
  if (c) c.click();
});
await sleep(1500);
const beforeSend = await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => o.onsuccess = () => r(o.result));
  const q = db.transaction('messages').objectStore('messages').getAll();
  const all = await new Promise(r => q.onsuccess = () => r(q.result));
  db.close();
  return { live: all.filter(m=>!m.archived).length, arch: all.filter(m=>m.archived).length };
});
console.log('   发送前: ' + JSON.stringify(beforeSend));
t('发送前未归档=100（自动归档还没跑）', beforeSend.live === 100, JSON.stringify(beforeSend));

// 发一条消息 → 走 app 真实链路
await page.evaluate(() => {
  const i = document.querySelector('#input');
  if (i) { i.value = '测试触发'; i.dispatchEvent(new Event('input', {bubbles:true})); }
});
await page.evaluate(() => {
  const b = document.querySelector('#btn-send');
  if (b) b.click();
});
// 原来盲等 9000ms；改成轮询到「归档数稳定且满足断言条件」，通常 1~3s 退出。
// ⚠️ 语义没变：仍然等到归档真的跑完 —— 只是不再固定空等 9 秒。
const readCounts = async () => await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => o.onsuccess = () => r(o.result));
  const q = db.transaction('messages').objectStore('messages').getAll();
  const all = await new Promise(r => q.onsuccess = () => r(q.result));
  db.close();
  return { live: all.filter(m=>!m.archived).length, arch: all.filter(m=>m.archived).length, total: all.length };
});
let _prev = null;
for (let _i = 0; _i < 40; _i++) {          // 上限 20s，比原来的 9s 更宽容；条件满足就提前退出
  const c = await readCounts();
  if (c.total > 0 && c.arch > 0 && _prev && _prev.arch === c.arch && c.live <= 12) break;
  _prev = c;
  await sleep(500);
}
const after = await readCounts();
console.log('   发送后: ' + JSON.stringify(after));
t('自动归档生效（已归档 > 0）', after.arch > 0, JSON.stringify(after));
t('未归档数降到保留数附近（<=12）', after.live <= 12, 'live='+after.live);

console.log('=== 4. 关掉开关后不再自动归档 ===');
await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => o.onsuccess = () => r(o.result));
  const ktx = db.transaction('kv','readwrite'); const ks = ktx.objectStore('kv');
  const g = await new Promise(r => { const q = ks.get('settings'); q.onsuccess = () => r(q.result); });
  const val = Object.assign({}, (g && g.v) || {});
  val.autoArchive = false; val.archiveKeep = 10;
  ks.put({ k:'settings', v: val });
  await new Promise(r => ktx.oncomplete = r);
  // 再塞 60 条，全部设为未归档
  const tx = db.transaction('messages','readwrite'); const st = tx.objectStore('messages');
  const q2 = st.getAll();
  const all = await new Promise(r => q2.onsuccess = () => r(q2.result));
  const cid = all[0].charId;
  for (let i=0;i<60;i++) st.put({ id:'n'+i, charId:cid, role:'user', content:'新'+i, ts:Date.now()+1000+i, archived:false });
  await new Promise(r => tx.oncomplete = r);
  db.close();
});
await page.reload({ waitUntil:'networkidle0' }); await sleep(200);
const archBefore = await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => o.onsuccess = () => r(o.result));
  const q = db.transaction('messages').objectStore('messages').getAll();
  const all = await new Promise(r => q.onsuccess = () => r(q.result));
  db.close();
  return all.filter(m=>m.archived).length;
});
await page.click('#btn-chars'); await sleep(700);
await page.evaluate(() => {
  const c = [...document.querySelectorAll('#char-list .char-card')].find(x => x.textContent.includes('自动归档测试'));
  if (c) c.click();
});
await sleep(1200);
await page.evaluate(() => {
  const i = document.querySelector('#input');
  if (i) { i.value = '关开关后'; i.dispatchEvent(new Event('input', {bubbles:true})); }
});
await page.evaluate(() => { const b = document.querySelector('#btn-send'); if (b) b.click(); });
// 原来盲等 8000ms；改成轮询到「归档数稳定」——关开关后预期不变，所以只等稳定，
// 不掺入业务条件（否则会变成"等到我希望的结果"，那就成假通过了）。
{ let _p = null;
  for (let _i = 0; _i < 30; _i++) {        // 上限 12s，比原来 8s 更宽容
    const c = await readCounts();
    if (_p && _p.arch === c.arch && _p.total === c.total) break;
    _p = c; await sleep(400);
  } }
const archAfter = await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => o.onsuccess = () => r(o.result));
  const q = db.transaction('messages').objectStore('messages').getAll();
  const all = await new Promise(r => q.onsuccess = () => r(q.result));
  db.close();
  return all.filter(m=>m.archived).length;
});
console.log('   已归档 before=' + archBefore + ' after=' + archAfter);
t('关掉开关后不再自动归档（已归档数不变）', archAfter === archBefore, archBefore+' -> '+archAfter);

console.log('\n页面错误: ' + (errs.length ? errs.join(' | ') : '无'));
t('无 JS 报错', errs.length === 0, errs.join(' | '));
console.log('\n结果: pass='+pass+' fail='+fail);
await browser.close(); server.close(); mock.close();
process.exit(fail?1:0);