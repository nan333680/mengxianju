
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const require = createRequire(path.resolve(import.meta.dirname, '..') + '/package.json');
const puppeteer = require('puppeteer-core');

const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');
const WWW = `${R}/www`;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.png':'image/png' };
const server = http.createServer((req,res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = path.join(WWW, p);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
  res.end(fs.readFileSync(f));
});
await new Promise(r => server.listen(0,'127.0.0.1',r));
const port = server.address().port;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = [];
page.on('pageerror', e => errs.push(String(e && e.message || e)));

let pass = 0, fail = 0;
const t = (n, ok, ex = '') => { if (ok) { pass++; console.log('  OK   ' + n); } else { fail++; console.log('  FAIL ' + n + (ex ? '  -> ' + ex : '')); } };
const click = async (sel) => page.evaluate((s) => { const e = document.querySelector(s); if (e) { e.click(); return true; } return false; }, sel);
const clickId = async (id) => page.evaluate((i) => { const e = document.getElementById(i); if (e) { e.click(); return true; } return false; }, id);
const activeView = () => page.evaluate(() => { const v = [...document.querySelectorAll('.view')].find(x => x.classList.contains('active')); return v ? v.id : ''; });

await page.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'networkidle0', timeout: 60000 });
await sleep(1600);
await page.evaluate(() => new Promise(res => { const r = indexedDB.deleteDatabase('ai-companion'); r.onsuccess = r.onerror = r.onblocked = () => res(); }));
await page.reload({ waitUntil: 'networkidle0' });
await sleep(1400);

// ---------- 造数据 ----------
await page.evaluate(async () => {
  const req = indexedDB.open('ai-companion');
  const db = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
  const base = { avatar:null, temperature:1, maxTokens:2048, topP:1, reasoningEffort:'low', contextRounds:20,
    kaomojiFreq:.15, kaomojiStyle:'jp-soft', emojiFreq:.1, verbosity:'medium', splitMessages:false, typingDelay:1,
    hesitation:true, showTyping:true, longMemory:false, allowEditMine:false, descLevel:'mid', povLock:false,
    appearance:'', appearanceOn:true, presetKey:'blank' };
  const tx = db.transaction(['characters','wbSolo'], 'readwrite');
  const cs = tx.objectStore('characters');
  cs.put({ id:'A', name:'角色甲', greeting:'', persona:'你是角色甲。', createdAt: 1000, ...base });
  cs.put({ id:'B', name:'角色乙', greeting:'', persona:'你是角色乙。', createdAt: 2000, ...base });
  cs.put({ id:'G', name:'测试群', greeting:'', persona:'', isGroup:true, memberIds:['A','B'], createdAt: 3000, ...base });
  const ws = tx.objectStore('wbSolo');
  ws.put({ id:'soloA', charId:'A', entries:[{ id:'ea', title:'甲的原标题', content:'甲的原始内容', keys:['甲'], on:true }] });
  ws.put({ id:'soloB', charId:'B', entries:[{ id:'eb', title:'乙的原标题', content:'乙的原始内容', keys:['乙'], on:true }] });
  await new Promise(r => tx.oncomplete = r);
});
await page.reload({ waitUntil: 'networkidle0' });
await sleep(1400);

const dumpSolo = (cid) => page.evaluate(async (id) => {
  const req = indexedDB.open('ai-companion');
  const db = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
  const tx = db.transaction('wbSolo');
  const all = await new Promise(res => { const g = tx.objectStore('wbSolo').getAll(); g.onsuccess = () => res(g.result); });
  const s = all.find(x => x && x.charId === id);
  return s && Array.isArray(s.entries) ? s.entries.map(e => ({ id:e.id, title:e.title, content:e.content })) : null;
}, cid);

const goGroupMemberEdit = async () => {
  await clickId('btn-chars'); await sleep(600);
  await click('.char-card[data-id="G"] [data-edit]'); await sleep(900);
  const v = await activeView();
  if (v !== 'view-group') return 'view=' + v;
  await clickId('g-wb-open'); await sleep(800);
  await click('[data-mw="B"]'); await sleep(800);
  await click('[data-med="0"]'); await sleep(800);
  return 'ok';
};

console.log('=== #6 (b) _wbCtx 指向别的角色时，编辑群成员 ===');
// 让 _wbCtx = {solo, A}
await clickId('btn-wb-solo'); await sleep(500);
await click('#pk-list .pick-row[data-pk="A"]'); await sleep(800);
const baseA = await dumpSolo('A');
t('#6 基线：A 有 1 条', Array.isArray(baseA) && baseA.length === 1, JSON.stringify(baseA));

const g1 = await goGroupMemberEdit();
t('#6 导航到条目编辑弹窗', g1 === 'ok', g1);
await page.evaluate(() => { const c = document.getElementById('we-content'); if (c) c.value = '乙改过的内容'; });
await clickId('modal-ok'); await sleep(1200);
const afterB = await dumpSolo('B');
const afterA = await dumpSolo('A');
t('#6 B 的条目真的改了', !!afterB && afterB.some(e => e.content === '乙改过的内容'), JSON.stringify(afterB));
t('#6 A 的条目一个字节没动', JSON.stringify(afterA) === JSON.stringify(baseA), JSON.stringify({ before: baseA, after: afterA }));

console.log('');
console.log('=== #6 (a) reload 后 _wbCtx = null，编辑群成员 ===');
await page.reload({ waitUntil: 'networkidle0' });
await sleep(1400);
const g2 = await goGroupMemberEdit();
t('#6 导航到条目编辑弹窗（_wbCtx=null）', g2 === 'ok', g2);
await page.evaluate(() => { const c = document.getElementById('we-content'); if (c) c.value = '乙第二次改'; });
await clickId('modal-ok'); await sleep(1200);
const afterB2 = await dumpSolo('B');
t('#6 (a) 不抛错且真的存进去了', !!afterB2 && afterB2.some(e => e.content === '乙第二次改'), JSON.stringify(afterB2));

// ---------- #7 ----------
console.log('');
console.log('=== #7 撤销整理要还原状态/作用域/钉住/删除时间 ===');
await page.evaluate(async () => {
  const req = indexedDB.open('ai-companion');
  const db = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
  const tx = db.transaction('memories', 'readwrite');
  const s = tx.objectStore('memories');
  const now = Date.now();
  const mk = (o) => Object.assign({ charId:'A', text:'', kind:'fact', scope:'character', subject:'char', status:'active',
    day:3, ts:now, freq:'normal', mine:false, v:2, legacy:false, heat:0, open:false, pinned:false, sourceMsgIds:[] }, o);
  s.put(mk({ id:'m1', text:'删掉的那条记忆', status:'deleted', deletedAt: now - 1000 }));
  s.put(mk({ id:'m2', text:'待确认的那条草稿', status:'draft' }));
  s.put(mk({ id:'m3', text:'只在这条线上的那条', scope:'branch', pinned:true, key:'identity.job' }));
  await new Promise(r => tx.oncomplete = r);
});
await page.reload({ waitUntil: 'networkidle0' });
await sleep(1400);
await clickId('btn-chars'); await sleep(600);
await click('.char-card[data-id="A"]'); await sleep(1400);
// ⚠️ #btn-mem-tidy / #btn-mem-undo 的 onclick 只在 bindSettings() 里绑，
//    而 bindSettings 只在【打开设置页】时调用（app.js:5505 / 5509）。
//    不进设置页直接点，按钮上压根没有处理器 —— 第一次跑就是栽在这儿（备份读到 null）。
//    这是脚本的问题，不是产品的：真实用户在设置页里点，一定有绑定。
await clickId('btn-settings'); await sleep(700);
await click('[data-wb-drawer="settings"]'); await sleep(1200);

const dumpMem = () => page.evaluate(async () => {
  const req = indexedDB.open('ai-companion');
  const db = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
  const tx = db.transaction('memories');
  const all = await new Promise(res => { const g = tx.objectStore('memories').getAll(); g.onsuccess = () => res(g.result); });
  return all.filter(m => m && m.charId === 'A')
    .map(m => ({ id:m.id, text:m.text, status:m.status, scope:m.scope, pinned:m.pinned, deletedAt: m.deletedAt == null ? null : 'set' }))
    .sort((a,b) => String(a.id).localeCompare(String(b.id)));
});

const memBefore = await dumpMem();
console.log('  整理前:', JSON.stringify(memBefore));
t('#7 整理了 3 条（含 deleted/draft/branch）', memBefore.length === 3, JSON.stringify(memBefore.map(m => m.id)));

await clickId('btn-mem-tidy');
await sleep(5000);
const bk = await page.evaluate(async () => {
  const req = indexedDB.open('ai-companion');
  const db = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
  const tx = db.transaction('kv');
  const g = await new Promise(res => { const q = tx.objectStore('kv').get('memTidyBackup:A'); q.onsuccess = () => res(q.result); });
  return g ? { n: (g.v && g.v.items || []).length } : null;
});
console.log('  备份条数:', JSON.stringify(bk));
t('#7 整理前已写好备份（3 条）', !!bk && bk.n === 3, JSON.stringify(bk));

// 模拟「整理后」：三条被合并成一条
await page.evaluate(async () => {
  const req = indexedDB.open('ai-companion');
  const db = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
  const tx = db.transaction('memories', 'readwrite');
  const s = tx.objectStore('memories');
  const all = await new Promise(res => { const g = s.getAll(); g.onsuccess = () => res(g.result); });
  for (const m of all) if (m && m.charId === 'A') s.delete(m.id);
  s.put({ id:'merged', charId:'A', text:'整理后合并成的一条', kind:'fact', scope:'character', subject:'char',
    status:'active', day:3, ts:Date.now(), freq:'often', mine:false, v:2, legacy:false, heat:0, open:false,
    pinned:false, sourceMsgIds:[] });
  await new Promise(r => tx.oncomplete = r);
});
const memMid = await dumpMem();
console.log('  模拟整理后:', JSON.stringify(memMid.map(m => m.id)));

await clickId('btn-mem-undo'); await sleep(800);
await clickId('modal-ok'); await sleep(5000);
const memAfter = await dumpMem();
console.log('  撤销后:', JSON.stringify(memAfter));

t('#7 条数回到 3', memAfter.length === 3, JSON.stringify(memAfter.map(m => m.id)));
t('#7 id 集合完全相同（没有重复条目）',
  JSON.stringify(memAfter.map(m => m.id)) === JSON.stringify(memBefore.map(m => m.id)),
  JSON.stringify({ before: memBefore.map(m => m.id), after: memAfter.map(m => m.id) }));
const byId = (arr, id) => arr.find(m => m && m.id === id) || {};
const m1b = byId(memBefore,'m1'), m1a = byId(memAfter,'m1');
const m2b = byId(memBefore,'m2'), m2a = byId(memAfter,'m2');
const m3b = byId(memBefore,'m3'), m3a = byId(memAfter,'m3');
t('#7 deleted 没有复活', m1a.status === m1b.status && m1a.status === 'deleted', JSON.stringify(m1a));
t('#7 deletedAt 跟着回来了', m1a.deletedAt === 'set', JSON.stringify(m1a));
t('#7 draft 没有变 active', m2a.status === m2b.status && m2a.status === 'draft', JSON.stringify(m2a));
t('#7 branch 没有变成 character', m3a.scope === m3b.scope && m3a.scope === 'branch', JSON.stringify(m3a));
t('#7 pinned 没有掉钉', m3a.pinned === true, JSON.stringify(m3a));


console.log('');
console.log('pageerror:', errs.length ? errs.slice(0, 5) : '无');
console.log('pass=' + pass + ' fail=' + fail);
await browser.close(); server.close();
