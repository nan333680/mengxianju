// e2e-memos.mjs — 记忆 OS：收件箱 + 本轮注入检查器
//
// 这一版最容易被做假的正是"记忆到底进没进提示词"：
//   · draft（待确认）绝不能注入 —— 模型猜的东西不该悄悄变成她的记忆
//   · 收下之后下一轮必须真的带上，不收就真的不进
//   · 「这一轮用了什么」要把 used 和 dropped 都摊开，还要能点回原话
// 所以这里全部走【真实行为】：发消息看真发出去的请求体、点按钮看库里的 status。
import puppeteer from 'puppeteer-core';
import { seedChars } from './e2e-helper.mjs';
import http from 'http'; import fs from 'fs'; import path from 'path';
const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');
const WWW = R + '/www';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8' };
const NL = String.fromCharCode(10);
let pass = 0, fail = 0;
const t = (n, ok, ex) => { if (ok) { pass++; console.log('  OK   ' + n); } else { fail++; console.log('  FAIL ' + n + (ex !== undefined ? '  -> ' + JSON.stringify(ex) : '')); } };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = path.join(WWW, p);
  if (!fs.existsSync(f)) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 120000,
  args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
const page = await browser.newPage();
// CI 是 en-US：界面语言默认跟随系统，不钉住中文的话所有中文断言都会红。
await page.evaluateOnNewDocument(() => {
  Object.defineProperty(navigator, 'language', { get: () => 'zh-CN', configurable: true });
  Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh'], configurable: true });
});
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = []; page.on('pageerror', e => errs.push(e.message));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let chatReq = null, chatN = 0;
await page.setRequestInterception(true);
page.on('request', req => {
  if (req.url().includes('/chat/completions')) {
    if (req.method() === 'OPTIONS') { req.respond({ status: 204, headers: { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Headers':'*', 'Access-Control-Allow-Methods':'*' } }); return; }
    let body = {}; try { body = JSON.parse(req.postData() || '{}'); } catch (e) { /* ignore */ }
    if (body.stream) {
      chatReq = body; chatN++;
      const chunk = JSON.stringify({ choices: [{ delta: { content: '嗯，我记着呢。' } }] });
      req.respond({ status: 200, headers: { 'Access-Control-Allow-Origin':'*' }, contentType: 'text/event-stream',
        body: 'data: ' + chunk + NL + NL + 'data: [DONE]' + NL + NL }); return;
    }
    // 剧情卡的进度判定（记忆 OS §8 的来源）：必须回一段真 JSON，否则它判不出 done，
    // 这条测试就变成"什么也没发生"的假通过。
    const joined = JSON.stringify(body.messages || []);
    if (joined.indexOf('剧情进度判定器') >= 0) {
      req.respond({ status: 200, headers: { 'Access-Control-Allow-Origin':'*' }, contentType: 'application/json',
        body: JSON.stringify({ choices: [{ message: { role: 'assistant',
          content: '{"done":true,"result":"她把伞塞给他，自己淋着雨走了","confidence":0.92}' } }] }) });
      return;
    }
    // 记忆整理那条：一律回空，免得测试中途多出记忆把断言搅乱
    req.respond({ status: 200, headers: { 'Access-Control-Allow-Origin':'*' }, contentType: 'application/json',
      body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: '[]' } }] }) });
    return;
  }
  req.continue();
});
const sysOf = () => ((chatReq && chatReq.messages) || []).filter(m => m.role === 'system').map(m => String(m.content || '')).join('\n@@\n');
const send = async (s) => {
  for (let k = 0; k < 8; k++) {
    const before = chatN;
    await page.evaluate(x => { const el = document.getElementById('input'); el.value = x; el.dispatchEvent(new Event('input', { bubbles: true })); }, s);
    await sleep(120);
    await page.evaluate(() => document.getElementById('btn-send').click());
    for (let i = 0; i < 100; i++) { await sleep(200); const b = await page.$eval('#btn-stop', e => !e.classList.contains('hidden')).catch(() => false); if (!b) break; }
    await sleep(500);
    if (chatN > before) return true;
    await sleep(1500);
  }
  return false;
};
const mems = () => page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const all = await new Promise(r => { const q = db.transaction('memories').objectStore('memories').getAll(); q.onsuccess = () => r(q.result); });
  db.close();
  return all.map(m => ({ id: m.id, text: m.text, status: m.status || '', kind: m.kind || '', key: m.key || '' }));
});
const memStatus = async (txt) => { const a = await mems(); const m = a.find(x => String(x.text).indexOf(txt) >= 0); return m ? m.status : '(没有这条)'; };

await page.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'networkidle0', timeout: 40000 });
await sleep(1200);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil: 'networkidle0' }); await sleep(600);
await seedChars(page, [{ name: '小满', id: 'mm1' }]);
await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const put = (st, rec) => new Promise(r => { const tx = db.transaction(st, 'readwrite'); tx.objectStore(st).put(rec); tx.oncomplete = r; });
  const rec = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get('settings'); q.onsuccess = () => r(q.result); });
  await put('kv', { k: 'settings', v: Object.assign({}, (rec && rec.v) || {}, {
    apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash',
    longMemory: true, memLimit: 20, clockMode: false }) });
  // ⚠️ seedChars 给角色的 longMemory 是 false，而 effSettings 是"角色设过的压过全局"，
  //    所以只开全局开关这一轮一条记忆都不会注入（第一版就是这么全红的）。
  const ch = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').get('mm1'); q.onsuccess = () => r(q.result); });
  await put('characters', Object.assign({}, ch, { longMemory: true }));
  const base = Date.now() - 600000;
  await put('messages', { id: 'src2', charId: 'mm1', role: 'user', content: '我最近在写一本小说，写得很慢。', ts: base + 1000 });
  await put('messages', { id: 'src3', charId: 'mm1', role: 'assistant', content: '慢慢写，写完给我看。', ts: base + 2000 });
  // 三条记忆，故意各占一种状态：
  //   a1  active    —— 一定会被注入
  //   d1  draft     —— 收件箱里，绝不能注入
  //   x1  expired   —— 过期，不能注入，但要在检查器的「没进来的」里出现
  // a1 带 quote：用于「原话」那一行的断言（v0.5.3.7 修主客对调时加的显示）
  await put('memories', { id: 'a1', charId: 'mm1', text: '他在写一本小说', kind: 'goal', key: 'goal.current',
    quote: '我想写本小说',
    scope: 'character', subject: 'user', status: 'active', sourceKind: 'message', sourceMsgIds: ['src2'], ts: base + 3000, createdAt: base + 3000 });
  await put('memories', { id: 'd1', charId: 'mm1', text: '他妈妈住在杭州', kind: 'fact', key: 'location.home',
    scope: 'character', subject: 'user', status: 'draft', sourceKind: 'message', sourceMsgIds: ['src2'], ts: base + 4000, createdAt: base + 4000 });
  await put('memories', { id: 'x1', charId: 'mm1', text: '他上一份工作在银行', kind: 'fact', key: 'identity.job',
    scope: 'character', subject: 'user', status: 'expired', sourceKind: 'message', sourceMsgIds: ['src2'], ts: base + 5000, createdAt: base + 5000 });
  db.close();
});
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForFunction(() => document.querySelectorAll('#char-list .char-card').length > 0, { timeout: 20000 });
await page.evaluate(() => { const c = [...document.querySelectorAll('#char-list .char-card')].find(x => x.dataset.id === 'mm1'); if (c) c.click(); });
await page.waitForFunction(() => document.querySelectorAll('#messages .msg').length > 0, { timeout: 20000 });
await sleep(600);

console.log('=== 1. 种子：三条记忆各占一种状态 ===');
let a = await mems();
t('库里三条记忆', a.length === 3, a.length);

console.log('=== 2. 待确认的绝不注入，过期的也不注入 ===');
chatReq = null;
t('发出去了一轮', await send('你还记得我在写什么吗'));
let sys = sysOf();
t('active 的 goal 进了提示词', sys.indexOf('他在写一本小说') >= 0, '');
t('draft【不】进提示词', sys.indexOf('他妈妈住在杭州') < 0, '');
t('expired【不】进提示词', sys.indexOf('他上一份工作在银行') < 0, '');
t('goal 在提示词里带了「她想做的」语气', sys.indexOf('还没做到') >= 0 || sys.indexOf('她想做') >= 0, '');

console.log('=== 3. 收件箱视图 ===');
await page.evaluate(() => {
  const h = document.getElementById('mem-fold'); if (h) h.click();
  const w = document.getElementById('mem-wrap'); if (w) w.classList.add('open');
});
await sleep(400);
const inboxN = await page.evaluate(() => { const el = document.getElementById('mem-inbox-n'); return el ? el.textContent.trim() : '(没有这个元素)'; });
t('「待确认」按钮上标了 1', inboxN === '1', inboxN);
await page.evaluate(() => { const b = document.getElementById('mem-view-inbox'); if (b) b.click(); });
await sleep(500);
const inbox = await page.evaluate(() => {
  const box = document.getElementById('mem-groups');
  return { txt: box ? box.innerText : '', accept: document.querySelectorAll('#mem-groups [data-accept]').length,
    reject: document.querySelectorAll('#mem-groups [data-reject]').length };
});
t('收件箱里列着那条 draft', inbox.txt.indexOf('他妈妈住在杭州') >= 0, inbox.txt.slice(0, 120));
t('收件箱里【没有】active 那条', inbox.txt.indexOf('他在写一本小说') < 0, '');
t('每条都有「收下」', inbox.accept === 1, inbox.accept);
t('每条都有「不收」', inbox.reject === 1, inbox.reject);

console.log('=== 4. 收下 → 下一轮真的带上 ===');
await page.evaluate(() => { const b = document.querySelector('#mem-groups [data-accept]'); if (b) b.click(); });
await sleep(1200);
t('点「收下」后 status 变成 active', await memStatus('他妈妈住在杭州') === 'active', await memStatus('他妈妈住在杭州'));
chatReq = null;
await send('那我妈呢');
sys = sysOf();
t('下一轮提示词里带上了它', sys.indexOf('他妈妈住在杭州') >= 0, '');
const inboxN2 = await page.evaluate(() => { const el = document.getElementById('mem-inbox-n'); return el ? (el.classList.contains('hidden') ? '' : el.textContent.trim()) : ''; });
t('收件箱的数字清零了', inboxN2 === '', inboxN2);

console.log('=== 5. 不收 → 软删，不进提示词 ===');
await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const tx = db.transaction('memories', 'readwrite');
  tx.objectStore('memories').put({ id: 'd2', charId: 'mm1', text: '他养了一只叫团子的猫', kind: 'fact', key: 'item.cat',
    scope: 'character', subject: 'user', status: 'draft', sourceKind: 'message', sourceMsgIds: ['src2'], ts: Date.now(), createdAt: Date.now() });
  tx.oncomplete = () => db.close();
});
// 切走再切回来，让 renderMem 真的重跑（已经在 inbox 时点同一个按钮不会重渲染）
await page.evaluate(() => { const b = document.getElementById('mem-view-list'); if (b) b.click(); });
await sleep(300);
await page.evaluate(() => { const b = document.getElementById('mem-view-inbox'); if (b) b.click(); });
await sleep(700);
const hasD2 = await page.evaluate(() => { const box = document.getElementById('mem-groups'); return !!box && box.innerText.indexOf('他养了一只叫团子的猫') >= 0; });
t('新 draft 出现在收件箱里', hasD2, '');
await page.evaluate(() => { const b = document.querySelector('#mem-groups [data-reject]'); if (b) b.click(); });
await sleep(1200);
t('点「不收」后变成已删除（不是物理删）', await memStatus('他养了一只叫团子的猫') === 'deleted', await memStatus('他养了一只叫团子的猫'));
chatReq = null;
await send('我最近养了猫');
sys = sysOf();
t('被拒的那条不进提示词', sys.indexOf('他养了一只叫团子的猫') < 0, '');

console.log('=== 6. 本轮注入检查器 ===');
await sleep(400);
await page.evaluate(() => {
  const els = document.querySelectorAll('#messages .msg');
  const el = els[els.length - 1];
  el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
});
await page.waitForFunction(() => !!document.querySelector('.msg-menu'), { timeout: 8000 }).catch(() => {});
await sleep(300);
const hasInj = await page.evaluate(() => [...document.querySelectorAll('.msg-menu button')].some(b => b.textContent.indexOf('这一轮用了什么') >= 0));
t('长按菜单里有「这一轮用了什么」', hasInj, '');
await page.evaluate(() => { const b = [...document.querySelectorAll('.msg-menu button')].find(x => x.textContent.indexOf('这一轮用了什么') >= 0); if (b) b.click(); });
await page.waitForFunction(() => { const m = document.getElementById('modal'); return m && !m.classList.contains('hidden'); }, { timeout: 8000 }).catch(() => {});
await sleep(300);
const inj = await page.evaluate(() => {
  const box = document.getElementById('modal-text');
  // 用 textContent 而不是 innerText：innerText 只算可见文本，折叠着的 details 里读不到
  return { txt: box ? box.textContent : '', srcs: document.querySelectorAll('#modal-text .inj-src').length };
});
t('检查器列出了注入的那条记忆', inj.txt.indexOf('他在写一本小说') >= 0, inj.txt.slice(0, 160));
t('每条写明为什么进来（类型/作用）', inj.txt.indexOf('她想做') >= 0 || inj.txt.indexOf('较早的事实') >= 0, '');
t('每条写了大约占多少 token', /约 \d+ token/.test(inj.txt), '');
t('有「没进来的」那一节', inj.txt.indexOf('没进来的') >= 0, '');
t('没进来的写了原因（已过期）', inj.txt.indexOf('已过期') >= 0, '');
t('没进来的写了原因（已删除）', inj.txt.indexOf('已删除') >= 0, '');
t('有「看原话」按钮', inj.srcs >= 1, inj.srcs);

console.log('=== 7. 「看原话」跳回来源消息 ===');
await page.evaluate(() => { const b = document.querySelector('#modal-text .inj-src'); if (b) b.click(); });
await sleep(700);
const jumped = await page.evaluate(() => {
  const m = document.getElementById('modal');
  const flash = document.querySelector('#messages .msg.flash');
  return { closed: !m || m.classList.contains('hidden'), flash: flash ? flash.dataset.id : '' };
});
t('点「看原话」把弹层关掉了', jumped.closed, jumped.closed);
t('目标消息被滚到并闪了一下', !!jumped.flash, jumped.flash);

console.log('=== 8. 事实卡视图：同一槽位的当前说法 / 以前的说法 / 她以为 ===');
// 造一组同槽位的记忆：同一件事有新说法、旧说法，再加一条只是推断的。
await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const put = (rec) => new Promise(r => { const tx = db.transaction('memories', 'readwrite'); tx.objectStore('memories').put(rec); tx.oncomplete = r; });
  const now = Date.now();
  await put({ id: 'h1', charId: 'mm1', text: '他现在住在城西', kind: 'state', key: 'location.home',
    scope: 'character', subject: 'user', status: 'active', sourceKind: 'message', sourceMsgIds: ['src2'], ts: now, createdAt: now });
  await put({ id: 'h2', charId: 'mm1', text: '他以前住在城南', kind: 'fact', key: 'location.home',
    scope: 'character', subject: 'user', status: 'superseded', supersededBy: 'h1',
    sourceKind: 'message', sourceMsgIds: ['src2'], ts: now - 1000, createdAt: now - 1000 });
  await put({ id: 'b1', charId: 'mm1', text: '他大概不会骗她', kind: 'belief', key: 'belief.trust', who: 'mm1',
    scope: 'character', subject: 'user', status: 'active', sourceKind: 'message', sourceMsgIds: ['src3'], ts: now - 2000, createdAt: now - 2000 });
  await put({ id: 'n1', charId: 'mm1', text: '他很喜欢下雨天', kind: 'fact',
    scope: 'character', subject: 'user', status: 'active', sourceKind: 'message', sourceMsgIds: ['src3'], ts: now - 3000, createdAt: now - 3000 });
  db.close();
});
await page.evaluate(() => { const b = document.getElementById('mem-view-list'); if (b) b.click(); });
await sleep(300);
await page.evaluate(() => { const b = document.getElementById('mem-view-key'); if (b) b.click(); });
await sleep(600);
const kc = await page.evaluate(() => {
  const box = document.getElementById('mem-groups');
  return {
    txt: box ? box.textContent : '',
    cards: document.querySelectorAll('#mem-groups .mem-keycard').length,
    old: document.querySelectorAll('#mem-groups .mem-old').length,
    swHidden: (document.getElementById('mem-belief-sw') || {}).classList ? document.getElementById('mem-belief-sw').classList.contains('hidden') : null,
  };
});
t('事实卡按槽位分组了', kc.cards >= 3, kc.cards);
t('槽位印成人话（location.home → 他住哪）', kc.txt.indexOf('他住哪') >= 0 && kc.txt.includes('location.home'), kc.txt.slice(0, 160));
t('当前说法在卡面上', kc.txt.indexOf('他现在住在城西') >= 0, '');
t('旧说法收进「以前的说法」折叠', kc.txt.indexOf('以前的说法（1）') >= 0 && kc.txt.indexOf('他以前住在城南') >= 0, '');
t('没有归槽的分到「没归槽的」', kc.txt.indexOf('没归槽的') >= 0 && kc.txt.indexOf('他很喜欢下雨天') >= 0, '');
t('「她以为」默认不露面', kc.txt.indexOf('他大概不会骗她') < 0, '');
t('事实卡视图里才露出「她以为」开关', kc.swHidden === false, kc.swHidden);
await page.evaluate(() => { const b = document.getElementById('mem-belief-on'); if (b) { b.checked = true; b.onchange(); } });
await sleep(600);
const kb = await page.evaluate(() => { const box = document.getElementById('mem-groups'); return box ? box.textContent : ''; });
t('勾上之后「她以为」单独成节', kb.indexOf('她以为（不一定真）') >= 0, '');
t('推断的那条出现在那一节里', kb.indexOf('他大概不会骗她') >= 0, '');
await page.evaluate(() => { const b = document.getElementById('mem-view-list'); if (b) b.click(); });
await sleep(300);
const swBack = await page.evaluate(() => { const s = document.getElementById('mem-belief-sw'); return s ? s.classList.contains('hidden') : null; });
t('离开事实卡后开关收起来', swBack === true, swBack);

console.log('=== 9. 编辑：改槽位/类型 → 先问再顶掉 ===');
// 造一条和 h1 抢同一个槽位的（同 kind 才有资格抢：fact 不会被 event 顶掉）
await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const tx = db.transaction('memories', 'readwrite');
  const now = Date.now();
  tx.objectStore('memories').put({ id: 'c1', charId: 'mm1', text: '他住在老城区', kind: 'fact', key: 'identity.job',
    scope: 'character', subject: 'user', status: 'active', sourceKind: 'message', sourceMsgIds: ['src2'], ts: now - 4000, createdAt: now - 4000 });
  tx.oncomplete = () => db.close();
});
await page.evaluate(() => { const b = document.getElementById('mem-view-list'); if (b) b.click(); });
await sleep(300);
await page.evaluate(() => { const b = document.getElementById('mem-view-key'); if (b) b.click(); });
await sleep(600);
// 点开「他住在老城区」这条
await page.evaluate(() => {
  const el = [...document.querySelectorAll('#mem-groups .mem-item')].find(x => x.textContent.indexOf('他住在老城区') >= 0);
  if (el) el.click();
});
await page.waitForFunction(() => { const m = document.getElementById('modal'); return m && !m.classList.contains('hidden'); }, { timeout: 8000 }).catch(() => {});
await sleep(300);
const ed = await page.evaluate(() => ({
  hasKind: !!document.getElementById('mem-edit-kind'),
  hasScope: !!document.getElementById('mem-edit-scope'),
  hasKey: !!document.getElementById('mem-edit-key'),
  keyVal: (document.getElementById('mem-edit-key') || {}).value,
}));
t('编辑弹窗能改类型', ed.hasKind, ed);
t('编辑弹窗能改作用域', ed.hasScope, '');
t('编辑弹窗能改槽位（带出原值）', ed.hasKey && ed.keyVal === 'identity.job', ed.keyVal);
// 改成 state + location.home → 和 h1（state / location.home / user）抢同一个槽位
await page.evaluate(() => {
  document.getElementById('mem-edit-key').value = 'location.home';
  document.getElementById('mem-edit-kind').value = 'state';
  document.getElementById('modal-ok').click();
});
await sleep(500);
const warn = await page.evaluate(() => {
  const m = document.getElementById('modal');
  return { open: m && !m.classList.contains('hidden'), txt: (document.getElementById('modal-text') || {}).textContent || '' };
});
// 弹层里说的是【已经在生效的那条】（h1），不是正在被编辑的 c1
t('改到已被占用的槽位会先问一句', warn.open && warn.txt.indexOf('他现在住在城西') >= 0, warn.txt.slice(0, 100));
await page.evaluate(() => { document.getElementById('modal-cancel').click(); });
await sleep(500);
const afterCancel = await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const rec = await new Promise(r => { const q = db.transaction('memories').objectStore('memories').get('c1'); q.onsuccess = () => r(q.result); });
  db.close();
  return { key: rec.key, kind: rec.kind };
});
t('点了取消就真的没改', afterCancel.key === 'identity.job' && afterCancel.kind === 'fact', afterCancel);
// 再来一次，这回确认顶掉
await page.evaluate(() => {
  const el = [...document.querySelectorAll('#mem-groups .mem-item')].find(x => x.textContent.indexOf('他住在老城区') >= 0);
  if (el) el.click();
});
await page.waitForFunction(() => { const m = document.getElementById('modal'); return m && !m.classList.contains('hidden'); }, { timeout: 8000 }).catch(() => {});
await sleep(300);
await page.evaluate(() => {
  document.getElementById('mem-edit-key').value = 'location.home';
  document.getElementById('mem-edit-kind').value = 'state';
  document.getElementById('modal-ok').click();
});
await sleep(500);
await page.evaluate(() => { const b = document.getElementById('modal-ok'); if (b) b.click(); });
await sleep(1000);
const afterOk = await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const get = (id) => new Promise(r => { const q = db.transaction('memories').objectStore('memories').get(id); q.onsuccess = () => r(q.result); });
  const c1 = await get('c1'), h1 = await get('h1');
  db.close();
  return { c1key: c1.key, c1kind: c1.kind, c1st: c1.status, h1st: h1.status, h1by: h1.supersededBy || '' };
});
t('确认后槽位和类型都改了', afterOk.c1key === 'location.home' && afterOk.c1kind === 'state', afterOk);
// state 走的是「过期」不是「被取代」（记忆 OS §6.1）：她不再认为他住老城区，
// 但"他以前住老城区"是一段真实发生过的过去，不该被说成"被新说法顶掉"。
t('原来那条 state 标成已过期（不是删掉）', afterOk.h1st === 'expired' && afterOk.c1st === 'active', afterOk);
// 槽位名写错：不能静默清空，要问一句
await page.evaluate(() => { const b = document.getElementById('mem-view-list'); if (b) b.click(); });
await sleep(300);
await page.evaluate(() => { const b = document.getElementById('mem-view-key'); if (b) b.click(); });
await sleep(600);
await page.evaluate(() => {
  const el = [...document.querySelectorAll('#mem-groups .mem-item')].find(x => x.textContent.indexOf('他住在老城区') >= 0);
  if (el) el.click();
});
await page.waitForFunction(() => { const m = document.getElementById('modal'); return m && !m.classList.contains('hidden'); }, { timeout: 8000 }).catch(() => {});
await sleep(300);
await page.evaluate(() => {
  document.getElementById('mem-edit-key').value = '随便写的';
  document.getElementById('modal-ok').click();
});
await sleep(500);
const badKey = await page.evaluate(() => {
  const m = document.getElementById('modal');
  return { open: m && !m.classList.contains('hidden'), txt: (document.getElementById('modal-text') || {}).textContent || '' };
});
t('槽位名不认时会说清楚（不静默改）', badKey.open && badKey.txt.indexOf('没归槽') >= 0, badKey.txt.slice(0, 100));
await page.evaluate(() => { document.getElementById('modal-ok').click(); });
await sleep(900);
const afterBad = await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const rec = await new Promise(r => { const q = db.transaction('memories').objectStore('memories').get('c1'); q.onsuccess = () => r(q.result); });
  db.close();
  return rec.key;
});
t('确认后槽位清空（不归槽），正文还在', afterBad === '', JSON.stringify(afterBad));

console.log('=== 10. 旧 blob：提示 + 手动拆开 ===');
await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const tx = db.transaction('memories', 'readwrite');
  const now = Date.now();
  // 典型的旧 blob：一条里塞了三件事
  tx.objectStore('memories').put({ id: 'g1', charId: 'mm1',
    text: '他在一家小公司做前端。他住在城东的老小区。他养了一只叫团子的猫。',
    kind: 'fact', key: 'identity.job', scope: 'character', subject: 'user',
    status: 'active', legacy: true, needsSplit: true, sourceKind: 'message',
    sourceMsgIds: ['src2'], ts: now - 5000, createdAt: now - 5000 });
  tx.oncomplete = () => db.close();
});
await page.evaluate(() => { const b = document.getElementById('mem-view-key'); if (b) b.click(); });
await sleep(300);
await page.evaluate(() => { const b = document.getElementById('mem-view-list'); if (b) b.click(); });
await sleep(700);
const blobUi = await page.evaluate(() => {
  const bn = document.querySelector('.mem-banner');
  // ⚠️ 必须按 id 找，不能按文本找：第 5 节那条「团子的猫」也是同一个人名下，
  //    textContent 一找就命中它，断言会在错误的对象上通过/失败。
  const item = document.querySelector('#mem-groups .mem-item[data-mid="g1"]');
  return {
    banner: bn ? bn.textContent : '',
    hasSplitBtn: !!document.querySelector('#mem-groups [data-split]'),
    tag: item ? item.textContent.indexOf('建议拆开') >= 0 : false,
  };
});
t('顶部提示有 N 条旧记忆', blobUi.banner.indexOf('旧记忆') >= 0 && blobUi.banner.indexOf('1') >= 0, blobUi.banner.slice(0, 90));
t('这种条目上标着「建议拆开」', blobUi.tag, '');
t('给了「拆」的入口', blobUi.hasSplitBtn, '');
// 原话（v0.5.3.7 修主客对调）：记忆是改写过的，改写时「我/你」会调个个儿，
// 正文读着通顺、方向却是反的 —— 所以条目下面要把原话照抄摆出来。
const qUi = await page.evaluate(() => {
  const el = document.querySelector('#mem-groups .mem-item[data-mid="a1"] .mem-quote');
  return el ? el.textContent : '';
});
t('记忆条目下面摆着原话', qUi.indexOf('我想写本小说') >= 0, qUi.slice(0, 40));
await page.evaluate(() => { const b = document.querySelector('#mem-groups [data-split]'); if (b) b.click(); });
await page.waitForFunction(() => {
  const m = document.getElementById('modal'); const ta = document.getElementById('mem-split-text');
  return m && !m.classList.contains('hidden') && ta && ta.value.length > 0;
}, { timeout: 8000 }).catch(() => {});
await sleep(300);
const pre = await page.evaluate(() => {
  const ta = document.getElementById('mem-split-text');
  return { lines: ta ? ta.value.split('\n').filter(Boolean).length : 0, n: (document.getElementById('mem-split-n') || {}).textContent || '' };
});
t('弹窗里按句子切好了（3 行）', pre.lines === 3, pre.lines);
t('行数写出来了', pre.n.indexOf('3') >= 0, pre.n);
await page.evaluate(() => { document.getElementById('modal-ok').click(); });
await sleep(1500);
const afterSplit = await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const all = await new Promise(r => { const q = db.transaction('memories').objectStore('memories').getAll(); q.onsuccess = () => r(q.result); });
  db.close();
  const g1 = all.find(x => x.id === 'g1') || {};
  // 三句原文各自成一条（id 是新的，不能靠 id 认；靠原句认）
  const SENT = ['他在一家小公司做前端。', '他住在城东的老小区。', '他养了一只叫团子的猫。'];
  const kids = all.filter(x => x && x.charId === 'mm1' && x.id !== 'g1' && SENT.indexOf(String(x.text)) >= 0);
  return { g1st: g1.status, kids: kids.length,
    kidKeys: kids.map(x => x.key || ''), kidActive: kids.every(x => x.status === 'active'),
    kidsMine: kids.map(x => x.mine === true),
    oldStillThere: !!g1.text };
});
t('原来那条标成已被取代（没删）', afterSplit.g1st === 'superseded' && afterSplit.oldStillThere, afterSplit.g1st);
t('拆成了 3 条，都算数', afterSplit.kids === 3 && afterSplit.kidActive, afterSplit);
t('拆出来的【不带槽位】（否则会互相顶掉）', afterSplit.kidKeys.every(k => k === ''), afterSplit.kidKeys);
t('拆完横幅就不嚷嚷了', await page.evaluate(() => !document.querySelector('.mem-banner')), '');
chatReq = null;
await send('团子最近怎么样');
sys = sysOf();
t('拆出来的那条下一轮真的被带上', sys.indexOf('团子') >= 0, '');

console.log('=== 11. 剧情卡判定出的结果 → 只进收件箱，不自动当事实 ===');
// 一张开着自动判定的卡：判完会把 result 落成一条待确认记忆
await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const tx = db.transaction('kv', 'readwrite');
  tx.objectStore('kv').put({ k: 'arc:mm1', v: { v: 2, title: '雨夜', direction: '她把伞给他', constraints: [],
    beats: [{ t: '递伞', goal: '她把伞塞给他', obs: '他不肯要', turn: '她自己淋着雨走了', turns: 9 }],
    currentBeat: 0, status: 'on', autoJudge: true, minTurns: 1, updatedAt: Date.now() } });
  tx.oncomplete = () => db.close();
});
// ⚠️ 不 reload：reload 之后记忆页的按钮 onclick 还没挂上（renderMem 没跑过），
//    点「待确认」等于点空气 —— 这一整节会静默失去意义。
//    剧情卡每轮都从 kv 现读，写进库立刻生效，本来就不需要重启。
chatReq = null;
await send('伞给你，我走了');
await sleep(2500);
const arcMem = await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const all = await new Promise(r => { const q = db.transaction('memories').objectStore('memories').getAll(); q.onsuccess = () => r(q.result); });
  db.close();
  const m = all.find(x => x && x.sourceKind === 'arc');
  return m ? { text: m.text, status: m.status, kind: m.kind, scope: m.scope, src: (m.sourceMsgIds || []).length } : null;
});
t('判定出的结果落成了一条记忆', !!arcMem, arcMem);
t('它是【待确认】，不是直接算数', arcMem && arcMem.status === 'draft', arcMem && arcMem.status);
t('记为事件型，不是事实', arcMem && arcMem.kind === 'event', arcMem && arcMem.kind);
t('带着来源消息（切支时能跟着走）', arcMem && arcMem.src === 1, arcMem && arcMem.src);
await sleep(300);
chatReq = null;
await send('那你呢');
sys = sysOf();
// ⚠️ 断言用【整句】：剧情卡的提示词里本来就有「她自己淋着雨走了」（那是这一拍的终点），
//    只查半句会永远命中，这条测试就成了假绿。
t('没确认之前它不进提示词', sys.indexOf('她把伞塞给他，自己淋着雨走了') < 0, '');
await page.evaluate(() => { const b = document.getElementById('mem-view-inbox'); if (b) b.click(); });
await sleep(1500);
const inboxDbg = await page.evaluate(() => {
  const box = document.getElementById('mem-groups');
  return { hasBtn: !!document.getElementById('mem-view-inbox'), on: (document.getElementById('mem-view-inbox') || {}).className || '',
    txt: box ? box.textContent.slice(0, 120) : '(没有 mem-groups)', acc: document.querySelectorAll('#mem-groups [data-accept]').length };
});
t('它出现在收件箱里', inboxDbg.acc >= 1, inboxDbg);
await page.evaluate(() => { const b = document.querySelector('#mem-groups [data-accept]'); if (b) b.click(); });
await sleep(1200);
chatReq = null;
await send('刚才那事');
sys = sysOf();
t('收下之后下一轮就记得了', sys.indexOf('自己淋着雨走了') >= 0, '');

console.log('=== 12. 全程无 JS 错误 ===');
t('没有页面报错', errs.length === 0, errs.slice(0, 3));

await browser.close(); server.close();
console.log(NL + '========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail > 0 ? 1 : 0);
