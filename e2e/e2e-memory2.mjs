import puppeteer from 'puppeteer-core';
import { seedChar, seedChars } from './e2e-helper.mjs';
import http from 'http';
import fs from 'fs';
import path from 'path';
// 工作目录自适应（原来写死 C:/A-DSH-Tool/ai-companion）
const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');

const WWW = `${R}/www`;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8' };

// 同一个服务器：静态文件 + 假 API。假 API 把每次请求体记下来，
// 好让我们看清「发给模型的那份 prompt 里到底带了谁的记忆」。
let lastBodies = [];
const server = http.createServer((req,res) => {
  if (req.url.startsWith('/api/chat/completions')) {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => {
      let body = {}; try { body = JSON.parse(raw); } catch {}
      lastBodies.push(body);
      if (body.stream) {
        res.writeHead(200, { 'Content-Type':'text/event-stream', 'Cache-Control':'no-cache' });
        res.write('data: ' + JSON.stringify({ choices:[{ delta:{ content:'好呀。' } }] }) + '\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      // 非流式（记忆总结/查重）：回一个空的 JSON 数组，免得它们往库里塞新记忆
      res.writeHead(200, { 'Content-Type':'application/json' });
      res.end(JSON.stringify({ choices:[{ message:{ content:'[]' } }] }));
    });
    return;
  }
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
const errs = [];
page.on('pageerror', e => errs.push(e.message));
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

await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
await sleep(1500);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil:'networkidle0' });
// v1.21.59：全新安装不再自动建角色（产品改空），测试自己塞一个
await seedChar(page, '测试角色', { greeting: '' });   // 空开场白：不额外多出一条消息
await page.reload({waitUntil:'networkidle0'}); await sleep(500);

// —— v1.20.21：新装默认「时间跟现实走」。这些套件依赖【手动时间】，
//    所以开局先关掉现实模式，否则剧情时间会被手机时钟顶成第 1 天。
await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => o.onsuccess = () => r(o.result));
  const tx = db.transaction('kv','readwrite'); const st = tx.objectStore('kv');
  const g = await new Promise(r => { const q = st.get('settings'); q.onsuccess = () => r(q.result); });
  const val = Object.assign({}, (g && g.v) || {});
  val.clockMode = false;
  st.put({ k:'settings', v: val });
  await new Promise(r => tx.oncomplete = r);
  db.close();
});
await page.reload({ waitUntil:'networkidle0' }); await sleep(500);
await sleep(200);

// 指到假端点
await openSettings(page, sleep);
await page.$eval('#s-apikey', el => { el.value = 'sk-test'; el.dispatchEvent(new Event('change', { bubbles: true })); });
await page.$eval('#s-baseurl', (el, p) => { el.value = p; el.dispatchEvent(new Event('change', { bubbles: true })); }, 'http://127.0.0.1:' + port + '/api');
await sleep(400);
await page.click('#btn-set-back'); await sleep(500);
  // v1.15.2 起栈多了 drawer 一层，退到设置页的上一层是抽屉，还要再关一次
  await page.evaluate(() => { const b = document.getElementById('btn-drawer-close'); if (b && document.querySelector('#view-drawer.active')) b.click(); });
  await sleep(500);

// 造第二个角色
await page.click('#btn-chars'); await sleep(500);
await seedChar(page, '第二个角色'); await sleep(900);
await page.reload({ waitUntil:'networkidle0' }); await sleep(200);
const names = await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const cs = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').getAll(); q.onsuccess = () => r(q.result); });
  db.close(); return cs.map(c => ({ id: c.id, name: c.name }));
});
console.log('   角色: ' + JSON.stringify(names.map(n => n.name)));
t('有两个角色', names.length === 2, JSON.stringify(names.map(n => n.name)));

// 给两个角色各插一条记忆，并都打开长期记忆
const A = names[0], B = names[1];
await page.evaluate(async (a, b) => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const cs = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').getAll(); q.onsuccess = () => r(q.result); });
  const tx = db.transaction('characters','readwrite');
  for (const c of cs) tx.objectStore('characters').put({ ...c, longMemory: true });
  await new Promise(r => { tx.oncomplete = r; });
  const tm = db.transaction('memories','readwrite');
  tm.objectStore('memories').put({ id:'memA', charId:a.id, text:'AAA只属于她的秘密', kind:'fact', untilDay:null, ts: Date.now() });
  tm.objectStore('memories').put({ id:'memB', charId:b.id, text:'BBB只属于她的秘密', kind:'fact', untilDay:null, ts: Date.now()+1 });
  await new Promise(r => { tm.oncomplete = r; });
  db.close();
}, A, B);
await page.reload({ waitUntil: 'networkidle0' });
await sleep(200);

console.log('');
console.log('=== 1. 设置页的记忆管理：看全部（按人物分组）===');
await openSettings(page, sleep);
await page.evaluate(() => document.getElementById('mem-fold').click());
await sleep(900);
// 归属现在不是胶囊了，改成按人物分组：先展开每个人的卡片再看他的条目
const groups = await page.$$eval('.mem-group', els => els.map(e => ({
  name: e.querySelector('[data-head] span').textContent.trim(),
  num: e.querySelector('.fold-num').textContent.trim()
})));
console.log('   分组: ' + JSON.stringify(groups));
t('按人物分成了两组', groups.length === 2, JSON.stringify(groups));
t('两组就是 A 和 B', groups.map(g => g.name).join(',') === [A.name, B.name].join(','), JSON.stringify(groups.map(g => g.name)));
const groupDetail = {};
for (const name of [A.name, B.name]) {
  await page.evaluate((n) => {
    const g = [...document.querySelectorAll('.mem-group')].find(e => e.querySelector('[data-head] span').textContent.trim() === n);
    if (!g.classList.contains('open')) g.querySelector('[data-head]').click();
  }, name);
  await sleep(600);
  groupDetail[name] = await page.evaluate((n) => {
    const g = [...document.querySelectorAll('.mem-group')].find(e => e.querySelector('[data-head] span').textContent.trim() === n);
    return [...g.querySelectorAll('.mem-item .txt')].map(e => e.textContent.trim());
  }, name);
}
console.log('   A 组: ' + JSON.stringify(groupDetail[A.name]));
console.log('   B 组: ' + JSON.stringify(groupDetail[B.name]));
t('A 那组里是 A 的记忆', groupDetail[A.name].some(x => x.includes('AAA')), JSON.stringify(groupDetail[A.name]));
t('A 那组里没有 B 的', !groupDetail[A.name].some(x => x.includes('BBB')), JSON.stringify(groupDetail[A.name]));
t('B 那组里是 B 的记忆', groupDetail[B.name].some(x => x.includes('BBB')), JSON.stringify(groupDetail[B.name]));
t('B 那组里没有 A 的', !groupDetail[B.name].some(x => x.includes('AAA')), JSON.stringify(groupDetail[B.name]));
const cntText = await page.$eval('#mem-count', el => el.textContent.trim());
console.log('   折叠头计数: ' + cntText);
t('计数里带了人数', /2\s*人/.test(cntText), cntText);

console.log('');
console.log('=== 2. 发给模型时只带「当前角色」自己的记忆 ===');
await page.click('#btn-set-back'); await sleep(500);
  // v1.15.2 起栈多了 drawer 一层，退到设置页的上一层是抽屉，还要再关一次
  await page.evaluate(() => { const b = document.getElementById('btn-drawer-close'); if (b && document.querySelector('#view-drawer.active')) b.click(); });
  await sleep(500);
// 塞库建的角色不会自动选中，这里手动选 B（原来走 UI 新建会自动切过去）
await page.click('#btn-chars'); await sleep(700);
await page.evaluate((id) => {
  const el = document.querySelector('#char-list .char-card[data-id="' + id + '"]');
  if (el) el.click();
}, B.id);
await sleep(1200);
const curName = await page.$eval('#chat-name', el => el.textContent.trim());
console.log('   当前角色: ' + curName);
lastBodies = [];
await page.click('#input'); await page.type('#input', '在吗', { delay: 5 });
await page.click('#btn-send');
// 原来盲等 2500ms；改成轮询 mock 端是否已收到 stream 请求 —— 正是断言要读的那个对象，
// 比固定等待更准（等到即走，没到才继续等，上限 20s 反而更宽容）。
for (let _i = 0; _i < 100; _i++) {
  if (lastBodies.some(b => b.stream)) break;
  await sleep(100);
}
const streamBody = lastBodies.filter(b => b.stream).pop();
const dumpB = JSON.stringify(streamBody || {});
console.log('   请求里含 AAA? ' + dumpB.includes('AAA') + ' / 含 BBB? ' + dumpB.includes('BBB'));
t('当前角色是 B', curName === B.name, curName);
t('请求里带上了 B 自己的记忆', dumpB.includes('BBB'));
t('请求里没有 A 的记忆（不会串台）', !dumpB.includes('AAA'));

// 切到 A 再发一次
await page.click('#btn-chars'); await sleep(500);
await page.evaluate((id) => { document.querySelector('#char-list .char-card[data-id="' + id + '"]')?.click(); }, A.id);
await sleep(300);
const switched = await page.evaluate((name) => {
  const cards = [...document.querySelectorAll('#char-list .char-card')];
  const c = cards.find(x => x.querySelector('.info b').textContent.trim() === name);
  if (c) { c.click(); return true; }
  return false;
}, A.name);
await sleep(1100);
const curA = await page.$eval('#chat-name', el => el.textContent.trim());
console.log('   切换后当前角色: ' + curA);
t('已切到 A', curA === A.name, curA);
lastBodies = [];
await page.click('#input'); await page.type('#input', '在吗', { delay: 5 });
await page.click('#btn-send');
for (let _i = 0; _i < 100; _i++) {
  if (lastBodies.some(b => b.stream)) break;
  await sleep(100);
}
const dumpA = JSON.stringify(lastBodies.filter(b => b.stream).pop() || {});
console.log('   请求里含 AAA? ' + dumpA.includes('AAA') + ' / 含 BBB? ' + dumpA.includes('BBB'));
t('请求里带上了 A 自己的记忆', dumpA.includes('AAA'));
t('请求里没有 B 的记忆（不会串台）', !dumpA.includes('BBB'));

console.log('');
console.log('=== 3. 记忆节奏参数是全局的（不按角色分）===');
// 内容按角色分，但「攒多少条总结一次 / 条数上限」是全局统一的（查重门槛由上限决定，没有单独旋钮）。
await openSettings(page, sleep);
await page.evaluate(() => document.getElementById('mem-set-fold').click());
await sleep(700);
await page.evaluate(() => {
  const i = document.querySelector('#s-mem-limit');
  i.value = '33';
  i.dispatchEvent(new Event('change', { bubbles: true }));
});
await sleep(600);
const params = await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const kv = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get('settings'); q.onsuccess = () => r(q.result); });
  const cs = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').getAll(); q.onsuccess = () => r(q.result); });
  db.close();
  return { global: kv.v.memLimit, perChar: cs.map(c => c.memLimit) };
});
console.log('   落库: ' + JSON.stringify(params));
t('改的是全局设置（上限 33）', params.global === 33, String(params.global));
t('没有往任何一个角色身上写', params.perChar.every(v => v === undefined || v === null), JSON.stringify(params.perChar));

console.log('');
console.log('=== 4. 每个角色只清自己的过期记忆 ===');
await page.evaluate(async (a, b) => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const tm = db.transaction('memories','readwrite');
  tm.objectStore('memories').put({ id:'evA', charId:a.id, text:'A的过期事件', kind:'event', untilDay:1, ts: Date.now() });
  tm.objectStore('memories').put({ id:'evB', charId:b.id, text:'B的过期事件', kind:'event', untilDay:1, ts: Date.now() });
  await new Promise(r => { tm.oncomplete = r; });
  // A 的剧情时间推到第 9 天；B 保持第 1 天（不写 clock，默认就是第 1 天）
  const tk = db.transaction('kv','readwrite');
  tk.objectStore('kv').put({ k:'clock:'+a.id, v:{ day:9, phase:'morning', season:'autumn', weather:'clear', locked:true } });
  await new Promise(r => { tk.oncomplete = r; });
  db.close();
}, A, B);
await page.reload({ waitUntil: 'networkidle0' });
await sleep(200);
// 当前角色是 A（reload 后回到 lastCharId），发一条消息触发 prune
await page.click('#input'); await page.type('#input', '触发清理', { delay: 5 });
await page.click('#btn-send');
// 原来盲等 3000ms；改成轮询"过期记忆 evA 是否已被清掉"——正是断言要读的落库结果。
// 上限 20s 比原来更宽容；evB 的留存仍由断言独立判定，不会等成"我希望的结果"。
for (let _i = 0; _i < 100; _i++) {
  const ids = await page.evaluate(async () => {
    const o = indexedDB.open('ai-companion');
    const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
    const ms = await new Promise(r => { const q = db.transaction('memories').objectStore('memories').getAll(); q.onsuccess = () => r(q.result); });
    db.close(); return ms.map(m => ({ id: m.id, status: m.status || 'active' }));
  });
  // ⚠️ v0.5.1.1 起过期不物理删，只标 status:'expired'（memory.js:15-18）。
  //    等的是「被停用」，不是「从库里消失」。
  if ((ids.find(m => m.id === 'evA') || {}).status === 'expired') break;
  await sleep(100);
}
const after = await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const ms = await new Promise(r => { const q = db.transaction('memories').objectStore('memories').getAll(); q.onsuccess = () => r(q.result); });
  db.close(); return ms.map(m => ({ id: m.id, status: m.status || 'active' }));
});
console.log('   剩余记忆: ' + JSON.stringify(after));
const st2 = (id) => (after.find(m => m.id === id) || {}).status || 'missing';
t('A 那条过期的被停用（expired）', st2('evA') === 'expired', st2('evA'));
t('B 那条过期的还是 active（她的剧情时间还没到）', st2('evB') === 'active', st2('evB'));

console.log('');
if (errs.length) console.log('  JS 错误: ' + JSON.stringify(errs));
t('全程无 JS 错误', errs.length === 0, errs.join(' | '));

console.log('');
console.log('========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
