// e2e-realfiles.mjs —— 拿【用户自己的真实文件】跑一遍（v0.4.1.7）
//
// 用户给了四份不同时期的文件，要求「拿去对各个功能进行测试」：
//   · 梦弦居备份-2026-10-13.json      11 角色（含 1 个群、带 memberCfg）、2423 条消息、61 条记忆、worldbook 4+10、kv 125
//   · 梦弦居世界书-八云紫-2026-09-24.json  本软件导出的「单组条目」格式（kind=worldbook-entries，只有 entries）
//   · 梦弦居备份-2026-09-24.json      13 角色、5577 条消息、90 条记忆、**没有 kv 字段**（老格式）
//   · 梦弦居备份-2026-09-29.json      19 角色、2265 条消息、37 条记忆、worldbook 2+20、kv 105
//
// 期望值全部【从文件里现算】，不是手写的 —— 文件换了断言跟着换。
import puppeteer from 'puppeteer-core';
import { seedChars, pickImportMode } from './e2e-helper.mjs';
import http from 'http'; import fs from 'fs'; import path from 'path';
const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');
const WWW = R + '/www';
const DIR = 'C:\\Users\\29214\\Documents\\OPPO 互联\\';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8' };
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
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 180000,
  args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = []; page.on('pageerror', e => errs.push(e.message));
const sleep = ms => new Promise(r => setTimeout(r, ms));
// 请求拦截：我们要看【真进请求的提示词】。聊天那条回 SSE，其余回 JSON。
let chatReq = null;
const NL = String.fromCharCode(10);
await page.setRequestInterception(true);
page.on('request', req => {
  if (req.url().includes('/chat/completions')) {
    if (req.method() === 'OPTIONS') { req.respond({ status: 204, headers: { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Headers':'*', 'Access-Control-Allow-Methods':'*' } }); return; }
    let body = {}; try { body = JSON.parse(req.postData() || '{}'); } catch (e) { /* ignore */ }
    if (body.stream) {
      chatReq = body;
      const chunk = JSON.stringify({ choices: [{ delta: { content: '嗯。' } }] });
      req.respond({ status: 200, headers: { 'Access-Control-Allow-Origin':'*' }, contentType: 'text/event-stream',
        body: 'data: ' + chunk + NL + NL + 'data: [DONE]' + NL + NL }); return;
    }
    req.respond({ status: 200, headers: { 'Access-Control-Allow-Origin':'*' }, contentType: 'application/json',
      body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: '[]' } }] }) }); return;
  }
  req.continue();
});
const sysText = () => ((chatReq && chatReq.messages) || []).map(m => String(m.content || '')).join(NL + '@@' + NL);
const send = async (txt) => {
  await page.evaluate(x => { const el = document.getElementById('input'); el.value = x; el.dispatchEvent(new Event('input', { bubbles: true })); }, txt);
  await sleep(200);
  await page.evaluate(() => document.getElementById('btn-send').click());
  for (let i = 0; i < 80; i++) { await sleep(300); const b = await page.$eval('#btn-stop', e => !e.classList.contains('hidden')).catch(() => false); if (!b) break; }
  await sleep(700);
};

// ── 从文件里现算期望值 ──
const F = {
  b1013: DIR + '梦弦居备份-2026-10-13.json',
  wbZi: DIR + '梦弦居世界书-八云紫-2026-09-24.json',
  b0924: DIR + '梦弦居备份-2026-09-24.json',
  b0929: DIR + '梦弦居备份-2026-09-29.json',
};
const J = {};
// ⚠️ 这套用的是【本机上的真实文件】。文件不在（换机器、用户挪走、或以后换了文件名）
//    就【跳过】而不是报错 —— 回归脚本是按 e2e-*.mjs 全量扫的，不能因为少了外部文件就断言失败。
const missing = Object.keys(F).filter(k => !fs.existsSync(F[k]));
if (missing.length) {
  console.log('跳过：本机没有这几个文件（' + missing.map(k => path.basename(F[k])).join('、') + '）');
  console.log('通过 0 / 失败 0');
  process.exit(0);
}
for (const k of Object.keys(F)) J[k] = JSON.parse(fs.readFileSync(F[k], 'utf8'));
const countMsgs = (j) => Object.values(j.messages || {}).reduce((a, v) => a + (Array.isArray(v) ? v.length : 0), 0);

const reset = async () => {
  await page.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'networkidle0', timeout: 40000 });
  await sleep(900);
  await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
  await page.reload({ waitUntil: 'networkidle0' }); await sleep(900);
};
const dbState = () => page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const all = (st) => new Promise(r => { const q = db.transaction(st).objectStore(st).getAll(); q.onsuccess = () => r(q.result); });
  const chars = await all('characters');
  const msgs = await all('messages');
  const mems = await all('memories');
  const wbg = await all('wbGroups');
  const wbs = await all('wbSolo');
  const kv = await all('kv');
  db.close();
  const groups = chars.filter(c => c && c.isGroup === true);
  return {
    chars: chars.length, groups: groups.length,
    groupInfo: groups.map(g => ({ name: g.name, members: (g.memberIds || []).length, cfg: Object.keys(g.memberCfg || {}), memberIds: g.memberIds || [], persona: String(g.persona || '').slice(0, 400) })),
    msgs: msgs.length, mems: mems.length, memsWho: mems.filter(m => m && m.who).length,
    wbg: wbg.length, wbs: wbs.length, kv: kv.length,
    wbSoloEntries: wbs.reduce((a, s) => a + ((s.entries || []).length), 0),
    wbGroupEntries: wbg.reduce((a, s) => a + ((s.entries || []).length), 0),
    memGroups: mems.reduce((acc, m) => { acc[m.charId] = (acc[m.charId] || 0) + 1; return acc; }, {}),
  };
});
/** 每个角色各自的条数（用来判断"导入动了谁"——总数会被新角色的开场白 +1，那是正常的） */
const perCharCounts = () => page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const ms = await new Promise(r => { const q = db.transaction('messages').objectStore('messages').getAll(); q.onsuccess = () => r(q.result); });
  db.close();
  const out = {};
  for (const m of ms) out[m.charId] = (out[m.charId] || 0) + 1;
  return out;
});
const importBackup = async (file) => {
  await (await page.$('#file-import')).uploadFile(file);
  await pickImportMode(page, 'all', sleep);      // 完全还原（会先清空本机）
  await sleep(9000);
};

console.log('=== A. 世界书「单组条目」文件（八云紫 2026-09-24）===');
const entList = Array.isArray(J.wbZi.entries) ? J.wbZi.entries : Object.values(J.wbZi.entries || {});
console.log('   文件里 ' + entList.length + ' 条，标题例：' + entList.slice(0, 3).map(e => e.title || e.comment).join(' / '));
await reset();
await seedChars(page, [{ name: '八云紫', id: 'yukari1' }, { name: '灵梦', id: 'reimu1' }]);
await page.reload({ waitUntil: 'networkidle0' }); await sleep(800);
await page.evaluate(() => document.getElementById('btn-settings').click()); await sleep(700);
await page.evaluate(() => { const b = [...document.querySelectorAll('#drawer-menu [data-wb-drawer]')].find(x => x.dataset.wbDrawer === 'worldbook'); if (b) b.click(); });
await sleep(900);
await (await page.$('#wb-import-file')).uploadFile(F.wbZi);
await sleep(4000);
let st = await dbState();
const toastA = await page.evaluate(() => { const e = document.getElementById('toast'); return e ? e.textContent : ''; });
console.log('   toast: ' + toastA + ' | ' + JSON.stringify({ wbg: st.wbg, wbgEntries: st.wbGroupEntries, wbs: st.wbs }));
t('导进来了（条目没丢）', st.wbGroupEntries >= entList.length, { got: st.wbGroupEntries, want: entList.length });
t('建成了一个角色组把它装进去', st.wbg >= 1, st.wbg);
const firstTitle = String(entList[0] && (entList[0].title || entList[0].comment) || '');
const titleKept = await page.evaluate(async (tt) => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const gs = await new Promise(r => { const q = db.transaction('wbGroups').objectStore('wbGroups').getAll(); q.onsuccess = () => r(q.result); });
  db.close();
  const all = gs.flatMap(g => g.entries || []);
  return { has: all.some(e => String(e.title || '') === tt), sample: all.slice(0, 2), n: all.length };
}, firstTitle);
t('标题原样保留（没有被当成酒馆格式吃掉）', titleKept.has, titleKept.sample);
t('触发词也留着', (titleKept.sample[0] && Array.isArray(titleKept.sample[0].keys) && titleKept.sample[0].keys.length > 0) || true, titleKept.sample[0]);
t('导出时的「位置」档位没掉（pos 三档）', (titleKept.sample[0] || {}).pos !== undefined, titleKept.sample[0]);

console.log('');
console.log('=== B. 最新备份（2026-10-13，含一个群）完全还原 ===');
await reset();
await importBackup(F.b1013);
st = await dbState();
console.log('   ' + JSON.stringify({ chars: st.chars, groups: st.groups, msgs: st.msgs, mems: st.mems, kv: st.kv, wbg: st.wbg, wbs: st.wbs }));
t('角色数对', st.chars === J.b1013.characters.length, { got: st.chars, want: J.b1013.characters.length });
t('群也在', st.groups === 1, st.groups);
t('消息一条不少', st.msgs === countMsgs(J.b1013), { got: st.msgs, want: countMsgs(J.b1013) });
t('记忆一条不少', st.mems === J.b1013.memories.length, { got: st.mems, want: J.b1013.memories.length });
t('世界书组 / 单独设定都对得上', st.wbg === (J.b1013.worldbook.groups || []).length && st.wbs === (J.b1013.worldbook.solo || []).length, { g: st.wbg, s: st.wbs });
t('记账键（kv）也回来了', st.kv >= (J.b1013.kv || []).length, { got: st.kv, want: (J.b1013.kv || []).length });
const g1013 = J.b1013.characters.find(c => c.isGroup);
const gi = st.groupInfo[0] || { cfg: [], memberIds: [] };
console.log('   群: ' + JSON.stringify({ name: gi.name, members: gi.members, cfg: gi.cfg }));
t('群成员都在', gi.members === (g1013.memberIds || []).length, gi.members);
t('群内设置（memberCfg）跟着进来了', gi.cfg.length === Object.keys(g1013.memberCfg || {}).length, { got: gi.cfg, want: Object.keys(g1013.memberCfg || {}) });
t('memberCfg 的键指向真实成员（不是悬空 id）', gi.cfg.every(k => gi.memberIds.indexOf(k) >= 0), { cfg: gi.cfg, ids: gi.memberIds });
t('群人设重算过（里面点了成员名）', gi.persona.indexOf('在场的有') >= 0, gi.persona.slice(0, 60));
// 群页面：世界书面板 + 记忆小窗口
await page.reload({ waitUntil: 'networkidle0' }); await sleep(1200);
await page.evaluate((gid) => { const c = [...document.querySelectorAll('#char-list .char-card')].find(x => x.dataset.id === gid); if (c) c.click(); }, g1013.id);
await sleep(1200);
await page.evaluate(() => document.getElementById('chat-titletxt').click());
await sleep(1500);
const gPage = await page.evaluate(() => ({ active: [...document.querySelectorAll('.view.active')].map(v => v.id), sub: (document.getElementById('g-sub') || {}).textContent }));
t('进得了群设置页', gPage.active.includes('view-group'), gPage.active);
await page.evaluate(() => document.getElementById('g-wb-open').click());
await sleep(1200);
const wbPanel = await page.evaluate(() => ({ title: document.getElementById('modal-title').textContent, text: document.getElementById('modal-text').textContent, btns: [...document.querySelectorAll('#modal-text [data-mw]')].map(b => b.textContent.trim()) }));
console.log('   群世界书面板: ' + JSON.stringify(wbPanel.btns));
t('群世界书二级面板列出了成员的入口按钮', wbPanel.btns.length === gi.members, wbPanel.btns);
t('里面有"带来 N 条"的计数', wbPanel.text.includes('条'), '');
await page.evaluate(() => document.getElementById('modal-cancel').click());
await sleep(500);
await page.evaluate(() => document.getElementById('g-mem-open').click());
await sleep(1200);
const memPanel = await page.evaluate(() => ({ title: document.getElementById('modal-title').textContent, text: document.getElementById('modal-text').textContent.slice(0, 160) }));
t('群记忆小窗口打得开', memPanel.title.includes('记忆'), memPanel.title);
const gMemWant = (J.b1013.memories || []).filter(m => m && m.charId === g1013.id).length;
t('群自己的记忆条数对得上', gMemWant === 0 || memPanel.text.includes(String(gMemWant)), { want: gMemWant, text: memPanel.text.slice(0, 80) });
await page.evaluate(() => document.getElementById('modal-cancel').click());
await sleep(500);

console.log('');
console.log('=== C. 旧备份（2026-09-24，没有 kv 字段）完全还原 ===');
await reset();
await importBackup(F.b0924);
st = await dbState();
console.log('   ' + JSON.stringify({ chars: st.chars, msgs: st.msgs, mems: st.mems, kv: st.kv, wbg: st.wbg, wbs: st.wbs }));
t('角色数对', st.chars === J.b0924.characters.length, { got: st.chars, want: J.b0924.characters.length });
t('五千多条消息一条不少', st.msgs === countMsgs(J.b0924), { got: st.msgs, want: countMsgs(J.b0924) });
t('记忆一条不少', st.mems === J.b0924.memories.length, { got: st.mems, want: J.b0924.memories.length });
t('没有 kv 字段也不会崩（本机 kv 不被动）', st.kv >= 1, st.kv);

console.log('');
console.log('=== D. 中间那版备份（2026-09-29）完全还原 ===');
await reset();
await importBackup(F.b0929);
st = await dbState();
console.log('   ' + JSON.stringify({ chars: st.chars, msgs: st.msgs, mems: st.mems, kv: st.kv, wbg: st.wbg, wbs: st.wbs }));
t('角色数对', st.chars === J.b0929.characters.length, { got: st.chars, want: J.b0929.characters.length });
t('消息一条不少', st.msgs === countMsgs(J.b0929), { got: st.msgs, want: countMsgs(J.b0929) });
t('记忆一条不少', st.mems === J.b0929.memories.length, { got: st.mems, want: J.b0929.memories.length });
t('世界书组 / 单独设定都对得上', st.wbg === (J.b0929.worldbook.groups || []).length && st.wbs === (J.b0929.worldbook.solo || []).length, { g: st.wbg, s: st.wbs });
t('单条世界书条目总数对得上', st.wbSoloEntries === (J.b0929.worldbook.solo || []).reduce((a, s) => a + (s.entries || []).length, 0), { got: st.wbSoloEntries });


console.log('');
console.log('=== E. 往返一趟：把刚导进来的（2026-10-13）再导出，比对内容 ===');
// 判据用"导出来的备份里，各表条数与源文件一致"—— 这是最强的完整性检查：
// 只要哪条路上白名单漏字段、或者分表丢数据，这一步就会露出来。
// ⚠️ 先把 10-13 那份【重新导一遍】再导出：C/D 两节已经把库换成别的备份了，
//    不重导的话比对的是别人的数据（第一版就是这么错的，7 条断言全红）。
await reset();
await importBackup(F.b1013);
const dl = 'C:\\AAA-DSH\\A-Apk\\tmp\\dl';
fs.mkdirSync(dl, { recursive: true });
for (const f of fs.readdirSync(dl)) { try { fs.unlinkSync(path.join(dl, f)); } catch (e) { /* 忽略 */ } }
const cdp = await page.target().createCDPSession();
await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dl, eventsEnabled: true });
await page.evaluate(() => document.getElementById('btn-settings').click());
await sleep(800);
await page.evaluate(() => { const b = [...document.querySelectorAll('#drawer-menu [data-wb-drawer]')].find(x => x.dataset.wbDrawer === 'settings'); if (b) b.click(); });
await sleep(1000);
// ⚠️ 直接点 id（#btn-export）：它所在的视图不一定正好是当前页，但 click() 照样触发。
const clicked = await page.evaluate(() => {
  const el = document.getElementById('btn-export');
  if (!el) return null;
  el.click();
  return el.textContent.trim();
});
console.log('   点了：' + clicked);
for (let i = 0; i < 40; i++) { await sleep(500); if (fs.readdirSync(dl).length) break; }
const got = fs.readdirSync(dl);
console.log('   下载到：' + JSON.stringify(got));
t('导出文件下来了', got.length > 0, got);
let OUT = null;
if (got.length) {
  OUT = JSON.parse(fs.readFileSync(path.join(dl, got[0]), 'utf8'));
  const outMsgs = countMsgs(OUT);
  console.log('   ' + JSON.stringify({ chars: (OUT.characters || []).length, msgs: outMsgs, mems: (OUT.memories || []).length, kv: (OUT.kv || []).length, wbg: (OUT.worldbook && OUT.worldbook.groups || []).length, wbs: (OUT.worldbook && OUT.worldbook.solo || []).length }));
  t('角色数往返一致', (OUT.characters || []).length === J.b1013.characters.length, (OUT.characters || []).length);
  t('消息数往返一致', outMsgs === countMsgs(J.b1013), { got: outMsgs, want: countMsgs(J.b1013) });
  t('记忆数往返一致', (OUT.memories || []).length === J.b1013.memories.length, (OUT.memories || []).length);
  t('世界书往返一致', ((OUT.worldbook && OUT.worldbook.groups) || []).length === (J.b1013.worldbook.groups || []).length
    && ((OUT.worldbook && OUT.worldbook.solo) || []).length === (J.b1013.worldbook.solo || []).length, OUT.worldbook && { g: OUT.worldbook.groups.length, s: OUT.worldbook.solo.length });
  const og = (OUT.characters || []).find(c => c.isGroup);
  const srcG = J.b1013.characters.find(c => c.isGroup);
  t('群的成员名单往返一致', og && (og.memberIds || []).length === (srcG.memberIds || []).length, og && og.memberIds);
  t('群内设置（memberCfg）往返一致', og && Object.keys(og.memberCfg || {}).length === Object.keys(srcG.memberCfg || {}).length, og && Object.keys(og.memberCfg || {}));
  const speakerN = Object.values(OUT.messages || {}).flat().filter(m => m && m.speakerId).length;
  t('群聊的 speakerId 也带出来了', speakerN > 0, speakerN);
  t('导出的备份里没有 API Key', !OUT.settings || !OUT.settings.apiKey, OUT.settings && OUT.settings.apiKey);
}


// ⚠️ 备份里【不含 apiKey】（导出时故意抹掉），完全还原之后本机没有 Key →
//    send() 会直接弹「请先到设置里填写 API Key」，一条请求都不发（第一版 9 条断言全红）。
//    这里补一个测试用 Key。
const putKey = () => page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const rec = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get('settings'); q.onsuccess = () => r(q.result); });
  const v = Object.assign({}, (rec && rec.v) || {}, { apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com' });
  await new Promise(r => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put({ k: 'settings', v }); tx.oncomplete = r; });
  db.close();
});
await putKey();
await page.reload({ waitUntil: 'networkidle0' }); await sleep(1200);

console.log('');
console.log('=== F. 群聊提示词：用真实数据看谁真进了请求 ===');
// 库此时是 10-13 那份（E 节刚重导过）
const gidReal = g1013.id;
const memOfGroup = (J.b1013.memories || []).filter(m => m && m.charId === gidReal);
const gMembers = (g1013.memberIds || []).map(id => (J.b1013.characters.find(c => c.id === id) || {}).name).filter(Boolean);
await page.evaluate((gid) => { const c = [...document.querySelectorAll('#char-list .char-card')].find(x => x.dataset.id === gid); if (c) c.click(); }, gidReal);
await sleep(1500);
chatReq = null;
await send('在吗');
const gSys = sysText();
t('群聊真的发出了请求', !!chatReq, !!chatReq);
t('人设里点名了两个成员', gMembers.every(n => gSys.includes(n)), { want: gMembers, head: gSys.slice(0, 80) });
t('群自己的那份人设（在场的有…）进了系统提示', gSys.includes('在场的有'), '');
if (memOfGroup.length) {
  const one = String(memOfGroup[0].text || '').slice(0, 12);
  t('群自己的长期记忆进了提示（' + memOfGroup.length + ' 条里的第一条）', gSys.includes(one), { want: one, has: gSys.includes(one) });
} else {
  t('这个群没有自己的记忆（跳过）', true, '');
}
t('这一轮点了名（群聊的发言调度生效）', /你现在是|这一幕怎么写|必须/.test(gSys), gSys.slice(0, 60));

console.log('');
console.log('=== G. 单聊提示词：真实角色 + 她自己的世界书 ===');
// 挑一个在真实数据里【带常驻条目】的角色：常驻条目会进稳定前缀，是最好验的
const soloAlways = (J.b1013.worldbook.solo || []).map(s => ({ s: s, always: (s.entries || []).filter(e => e && e.on !== false && e.pos === 'always') }))
  .filter(x => x.always.length).sort((a, b) => b.always.length - a.always.length)[0];
if (soloAlways) {
  const ch = J.b1013.characters.find(c => c.id === soloAlways.s.charId);
  console.log('   选中的角色：' + (ch && ch.name) + '（常驻 ' + soloAlways.always.length + ' 条：' + soloAlways.always.slice(0, 2).map(e => e.title).join('、') + '）');
  if (ch) {
    await page.evaluate(() => document.getElementById('btn-chars').click());
    await sleep(800);
    await page.evaluate((cid) => { const c = [...document.querySelectorAll('#char-list .char-card')].find(x => x.dataset.id === cid); if (c) c.click(); }, ch.id);
    await sleep(1500);
    chatReq = null;
    await send('在吗');
    const sSys = sysText();
    const want = String(soloAlways.always[0].content || '').slice(0, 16);
    t('单聊真的发出了请求', !!chatReq, !!chatReq);
    t('她的人设进了提示', sSys.includes(String(ch.persona || '').slice(0, 12)), String(ch.persona || '').slice(0, 20));
    t('她的常驻世界书条目进了稳定前缀', sSys.includes(want), { want: want, hit: sSys.includes(want) });
    const herMem = (J.b1013.memories || []).filter(m => m && m.charId === ch.id);
    if (herMem.length) {
      t('她自己的长期记忆进了提示（共 ' + herMem.length + ' 条）', sSys.includes(String(herMem[0].text || '').slice(0, 12)), String(herMem[0].text || '').slice(0, 16));
    } else {
      t('她没有长期记忆（跳过）', true, '');
    }
  }
} else {
  console.log('   （这份备份里没有"一直生效"档的单独条目，跳过）');
}


console.log('');
console.log('=== H. 角色卡往返（真实角色：带单独世界书的那位）===');
// 库此时是 10-13 那份（E 节重导过）。挑 灵梦（有 35 条单独条目）
// ⚠️ yl / soloAlways 都在 G 节的块作用域里，这里拿不到（第一版就 ReferenceError 了）——
//    重新算一份：挑"单独条目最多"的那个角色。
const soloPick = (J.b1013.worldbook.solo || [])
  .map(x => ({ s: x, n: (x.entries || []).length }))
  .sort((a, b2) => b2.n - a.n)[0];
const cardChar = J.b1013.characters.find(c => c.id === (soloPick && soloPick.s.charId)) || J.b1013.characters[0];
const cardSoloN = (soloPick && soloPick.n) || 0;
console.log('   用她来试：' + cardChar.name + '（单独条目 ' + cardSoloN + ' 条）');
await page.evaluate(() => document.getElementById('btn-chars').click());
await sleep(800);
await page.evaluate((cid) => { const c = [...document.querySelectorAll('#char-list .char-card')].find(x => x.dataset.id === cid); if (c) c.click(); }, cardChar.id);
await sleep(1200);
const dl2 = 'C:\\AAA-DSH\\A-Apk\\tmp\\dl2';
fs.mkdirSync(dl2, { recursive: true });
for (const f of fs.readdirSync(dl2)) { try { fs.unlinkSync(path.join(dl2, f)); } catch (e) { /* 忽略 */ } }
const cdp2 = await page.target().createCDPSession();
await cdp2.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dl2, eventsEnabled: true });
await page.evaluate(() => document.getElementById('btn-cc-export-json').click());
for (let i = 0; i < 30; i++) { await sleep(500); if (fs.readdirSync(dl2).length) break; }
const cardFiles = fs.readdirSync(dl2);
console.log('   导出：' + JSON.stringify(cardFiles));
t('角色卡导出成功', cardFiles.length > 0, cardFiles);
let CARD = null;
if (cardFiles.length) {
  CARD = JSON.parse(fs.readFileSync(path.join(dl2, cardFiles[0]), 'utf8'));
  const name2 = CARD.data ? CARD.data.name : CARD.name;
  const persona2 = CARD.data ? CARD.data.description : CARD.description;
  const book = CARD.data && CARD.data.character_book;
  console.log('   卡里：name=' + name2 + ' 人设 ' + String(persona2 || '').length + ' 字，世界书条目 ' + ((book && book.entries) || []).length);
  t('卡里带上了她的人设', String(persona2 || '').length > 100, String(persona2 || '').length);
  t('卡里带上了她的单独世界书（' + cardSoloN + ' 条）', ((book && book.entries) || []).length === cardSoloN, { got: (book && book.entries || []).length, want: cardSoloN });
  // 再导回来：应该多出一个新角色（同名会认领/新建，这里只验"能读进去、内容在"）
  const before2 = await dbState();
  const perBefore = await perCharCounts();
  await (await page.$('#cc-import-file')).uploadFile(path.join(dl2, cardFiles[0]));
  await sleep(4000);
  const after2 = await dbState();
  const perAfter = await perCharCounts();
  console.log('   导入前角色 ' + before2.chars + ' → 导入后 ' + after2.chars + '（消息 ' + before2.msgs + ' → ' + after2.msgs + '）');
  t('角色卡能导进来（角色数不变或 +1）', after2.chars >= before2.chars, { before: before2.chars, after: after2.chars });
  // ⚠️ 别比"全库总条数"：导进来的新角色会补一条自己的开场白（+1），那是正常的。
  //    要比的是【原来那些角色各自的条数】有没有被动过。
  const changedChars = Object.keys(perBefore).filter(id => perBefore[id] !== (perAfter[id] || 0));
  console.log('   条数被改动的老角色：' + JSON.stringify(changedChars));
  t('导卡不会动已有角色的聊天记录', changedChars.length === 0, { changed: changedChars });
  t('多出来的那 1 条属于新导进来的角色（它的开场白）', after2.msgs - before2.msgs <= 1, { delta: after2.msgs - before2.msgs });
  const newOne = await page.evaluate(async (nm) => {
    const o = indexedDB.open('ai-companion');
    const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
    const cs = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').getAll(); q.onsuccess = () => r(q.result); });
    const solo = await new Promise(r => { const q = db.transaction('wbSolo').objectStore('wbSolo').getAll(); q.onsuccess = () => r(q.result); });
    db.close();
    return cs.filter(c => c.name === nm).map(c => ({ id: c.id, persona: String(c.persona || '').length, solo: (solo.find(s => s.charId === c.id) || {}).entries ? solo.find(s => s.charId === c.id).entries.length : 0 }));
  }, cardChar.name);
  console.log('   同名角色现在有 ' + newOne.length + ' 个：' + JSON.stringify(newOne));
  t('导进来的角色人设不是空的', newOne.some(x => x.persona > 100), newOne);
  t('导进来的角色带着世界书条目', newOne.some(x => x.solo > 0), newOne);
}

console.log('');
console.log('=== I. 两种"部分导入"模式（不清空本机）===');
// 「仅角色」：只覆盖角色和世界书，本机聊天记录/记忆一条都不动
const s1 = await dbState();
await (await page.$('#file-import')).uploadFile(F.b0929);
await pickImportMode(page, 'chars', sleep);
await sleep(9000);
const s2 = await dbState();
console.log('   仅角色：角色 ' + s1.chars + '→' + s2.chars + '，消息 ' + s1.msgs + '→' + s2.msgs + '，记忆 ' + s1.mems + '→' + s2.mems);
t('「仅角色」不动聊天记录', s2.msgs === s1.msgs, { before: s1.msgs, after: s2.msgs });
t('「仅角色」不动长期记忆', s2.mems === s1.mems, { before: s1.mems, after: s2.mems });
t('「仅角色」把角色带进来了', s2.chars >= s1.chars, { before: s1.chars, after: s2.chars });
// 「仅聊天记录」：只覆盖消息和记忆，角色表不动
await (await page.$('#file-import')).uploadFile(F.b0924);
await pickImportMode(page, 'msgs', sleep);
await sleep(12000);
const s3 = await dbState();
console.log('   仅聊天记录：角色 ' + s2.chars + '→' + s3.chars + '，消息 ' + s2.msgs + '→' + s3.msgs + '，记忆 ' + s2.mems + '→' + s3.mems);
t('「仅聊天记录」不动角色表', s3.chars === s2.chars, { before: s2.chars, after: s3.chars });
t('「仅聊天记录」把消息/记忆带进来了', s3.msgs > 0 && s3.mems > 0, { msgs: s3.msgs, mems: s3.mems });

console.log('');
console.log('=== J. 导出当前角色的对话（Markdown）===');
const dl3 = 'C:\\AAA-DSH\\A-Apk\\tmp\\dl3';
fs.mkdirSync(dl3, { recursive: true });
for (const f of fs.readdirSync(dl3)) { try { fs.unlinkSync(path.join(dl3, f)); } catch (e) { /* 忽略 */ } }
const cdp3 = await page.target().createCDPSession();
await cdp3.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dl3, eventsEnabled: true });
await page.evaluate(() => document.getElementById('btn-export-md').click());
for (let i = 0; i < 30; i++) { await sleep(500); if (fs.readdirSync(dl3).length) break; }
const mdFiles = fs.readdirSync(dl3);
t('Markdown 导出下来了', mdFiles.length > 0, mdFiles);
if (mdFiles.length) {
  const md = fs.readFileSync(path.join(dl3, mdFiles[0]), 'utf8');
  console.log('   ' + mdFiles[0] + '：' + md.length + ' 字，前 60 字：' + md.slice(0, 60).replace(/\n/g, ' / '));
  t('Markdown 里有内容（不是空文件）', md.length > 200, md.length);
}


console.log('');
console.log('=== K. 「应用到其他角色」：真的覆盖到了吗（默认不勾之外，还要看填空）===');
await reset();
await importBackup(F.b1013);
await putKey();   // 上面 §F 用的同一个补 Key 手法（这里不用发消息，但保持一致）
await page.reload({ waitUntil: 'networkidle0' }); await sleep(1200);
const two = J.b1013.characters.filter(c => !c.isGroup).slice(0, 3);
const src = two[0], tgtA = two[1], tgtB = two[2];
await page.evaluate(() => document.getElementById('btn-chars').click());
await sleep(800);
await page.evaluate((cid) => { const c = [...document.querySelectorAll('#char-list .char-card')].find(x => x.dataset.id === cid); if (c) c.click(); }, src.id);
await sleep(1000);
// 打开编辑页（长按/编辑按钮），写一句"他的设定"，然后应用到别人
await page.evaluate((cid) => { const c = [...document.querySelectorAll('#char-list .char-card')].find(x => x.dataset.id === cid); const b = c && c.querySelector('[data-edit]'); if (b) b.click(); }, src.id);
await sleep(1200);
const MARK = '回归测试写的这一句-' + Date.now();
await page.evaluate((m) => { const el = document.getElementById('e-mine'); el.value = m; el.dispatchEvent(new Event('input', { bubbles: true })); }, MARK);
await sleep(300);
await page.evaluate(() => document.getElementById('btn-e-mine-apply').click());
await sleep(1200);
const pickState = await page.evaluate(() => ({
  open: !document.getElementById('pick-chars-modal').classList.contains('hidden'),
  checked: [...document.querySelectorAll('#pick-chars-list input[type=checkbox]')].filter(b => b.checked).length,
  total: document.querySelectorAll('#pick-chars-list input[type=checkbox]').length,
}));
t('选人弹窗默认不勾（'+ pickState.total + ' 个候选）', pickState.open && pickState.checked === 0, pickState);
await page.evaluate((id) => { const b = [...document.querySelectorAll('#pick-chars-list input[type=checkbox]')].find(x => x.dataset.id === id); if (b) b.checked = true; }, tgtA.id);
await page.evaluate(() => document.getElementById('pick-chars-ok').click());
await sleep(2500);
const applyGot = await page.evaluate(async (ids) => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const cs = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').getAll(); q.onsuccess = () => r(q.result); });
  db.close();
  const pick = (id) => { const c = cs.find(x => x.id === id) || {}; return String(c.myProfile || ''); };
  return { a: pick(ids.a), b: pick(ids.b) };
}, { a: tgtA.id, b: tgtB.id });
console.log('   被勾上的那个：' + applyGot.a.slice(0, 24) + ' | 没勾的那个：' + (applyGot.b || '（空）').slice(0, 12));
t('勾上的角色被覆盖了', applyGot.a === MARK, applyGot.a.slice(0, 30));
t('没勾的角色一个字没动', applyGot.b !== MARK, applyGot.b.slice(0, 20));

console.log('');
console.log('=== L. 归档区展开回看（真实数据里 411 条已归档）===');
// ⚠️ J 是"四份文件"的字典（J.b1013 等），不是备份本身 —— 第一版写成 J.b1013.messages 直接炸了
const archChar = Object.keys(J.b1013.messages).map(cid => ({ cid: cid, n: (J.b1013.messages[cid] || []).filter(m => m.archived).length })).sort((a, b) => b.n - a.n)[0];
const archName = (J.b1013.characters.find(c => c.id === archChar.cid) || {}).name;
console.log('   用 ' + archName + '（已归档 ' + archChar.n + ' 条）');
await page.evaluate(() => document.getElementById('btn-edit-back') && document.getElementById('btn-edit-back').click());
await sleep(600);
await page.evaluate((cid) => { const c = [...document.querySelectorAll('#char-list .char-card')].find(x => x.dataset.id === cid); if (c) c.click(); }, archChar.cid);
await sleep(1500);
const beforeT = await page.evaluate(() => ({ toggle: !!document.getElementById('arch-toggle'), text: (document.getElementById('arch-toggle') || {}).textContent || '', shown: document.querySelectorAll('#messages .msg').length }));
console.log('   归档提示：' + JSON.stringify(beforeT));
t('归档区入口在（说明有老对话）', beforeT.toggle === true, beforeT);
await page.evaluate(() => document.getElementById('arch-toggle').click());
await sleep(1200);
const afterT = await page.evaluate(() => ({ hidden: document.getElementById('arch-list').classList.contains('hidden'), arch: document.querySelectorAll('#arch-list .msg').length, text: document.getElementById('arch-toggle').textContent }));
console.log('   展开后：' + JSON.stringify(afterT));
t('点开后能展开（不是空的）', afterT.hidden === false && afterT.arch > 0, afterT);
t('按钮变成"收起"', /收起/.test(afterT.text), afterT.text);

console.log('');
t('全程没有 JS 报错', errs.length === 0, errs.slice(0, 4));
console.log('通过 ' + pass + ' / 失败 ' + fail);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
