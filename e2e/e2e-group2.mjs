// e2e-group2.mjs — 群聊第二轮：身份、续写、删除、导入重映射（v0.4.0 复查）
//
// 这一套对着《群聊诊断与建议》里的缺陷逐条钉住：
//   缺陷 1  说话人从不进提示词 → 历史每条要带【名字】，本轮段要直接说"你现在是谁"
//   缺陷 2  长按气泡头像会进普通角色编辑页 → 群里应该进"改成员"
//   缺陷 3  续写/重新生成会换人（用户拍板按 A：刚才那人继续说）
//   缺陷 4  群没有删除入口
//   导入    群成员的 id 没重映射（外部报告 W1）+ speakerId 没重映射
import puppeteer from 'puppeteer-core';
import { seedChars } from './e2e-helper.mjs';
import { pickImportMode } from './e2e-helper.mjs';
import { readCode } from './e2e-src.mjs';
import http from 'http'; import fs from 'fs'; import path from 'path'; import os from 'os';
const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');
const WWW = R + '/www';
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
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 120000,
  args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = []; page.on('pageerror', e => errs.push(e.message));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let lastReq = null;
await page.setRequestInterception(true);
page.on('request', req => {
  if (req.url().includes('/chat/completions')) {
    if (req.method() === 'OPTIONS') { req.respond({ status: 204, headers: { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Headers':'*', 'Access-Control-Allow-Methods':'*' } }); return; }
    try { lastReq = JSON.parse(req.postData() || '{}'); } catch { lastReq = null; }
    const NL = String.fromCharCode(10);
    req.respond({ status: 200, headers: { 'Access-Control-Allow-Origin':'*' }, contentType: 'text/event-stream',
      body: 'data: ' + JSON.stringify({ choices: [{ delta: { content: '嗯。' } }] }) + NL + NL + 'data: [DONE]' + NL + NL }); return;
  }
  req.continue();
});
await page.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'networkidle0', timeout: 40000 });
await sleep(1200);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil: 'networkidle0' }); await sleep(1000);
await seedChars(page, [
  { name: '甲', greeting: '（甲在）', id: 'ga' },
  { name: '乙', greeting: '（乙在）', id: 'gb' },
  { name: '丙', greeting: '（丙在）', id: 'gc' },
]);
await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const put = (st, rec) => new Promise(r => { const tx = db.transaction(st, 'readwrite'); tx.objectStore(st).put(rec); tx.oncomplete = r; });
  const rec = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get('settings'); q.onsuccess = () => r(q.result); });
  await put('kv', { k: 'settings', v: Object.assign({}, (rec && rec.v) || {}, { apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com', longMemory: false }) });
  await put('characters', { id: 'ggrp1', name: '周末茶会', isGroup: true, memberIds: ['ga','gb','gc'],
    groupNote: '', speakMode: 'round', turnIndex: 0, avatar: null, greeting: '（三个人都在。）',
    presetKey: 'blank', createdAt: Date.now() });
  db.close();
});
await page.reload({ waitUntil: 'networkidle0' }); await sleep(1200);
await page.evaluate(() => { [...document.querySelectorAll('#char-list .char-card')].find(x => x.dataset.id === 'ggrp1').click(); });
await sleep(1400);

const waitDone = async () => { for (let i = 0; i < 80; i++) { await sleep(300); const b = await page.$eval('#btn-stop', e => !e.classList.contains('hidden')).catch(() => false); if (!b) break; } await sleep(700); };
const send = async (s) => {
  await page.evaluate(x => { const el = document.getElementById('input'); el.value = x; el.dispatchEvent(new Event('input', { bubbles: true })); }, s);
  await sleep(150);
  await page.evaluate(() => document.getElementById('btn-send').click());
  await waitDone();
};
const aiMessages = async () => page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const all = await new Promise(r => { const q = db.transaction('messages').objectStore('messages').getAll(); q.onsuccess = () => r(q.result); });
  db.close();
  return all.filter(m => m.charId === 'ggrp1').sort((a, b) => (a.ts || 0) - (b.ts || 0)).map(m => ({ role: m.role, c: m.content, s: m.speakerId || null }));
});

const reqAll = () => (lastReq && lastReq.messages ? lastReq.messages : []).map(m => String(m.content || '')).join(String.fromCharCode(10));
const sysOf = () => (lastReq.messages || []).filter(m => m.role === 'system').map(m => String(m.content || ''));

console.log('=== 1. 群的历史里每条都要带【谁说的】 ===');
await send('大家都在吗');
let msgs = await aiMessages();
// 第一轮时历史里只有开场白（没有说话人），甲还没说过话 —— 所以【甲】要等第二轮才出现
t('开场白没有说话人 → 标成【旁白】（不是"我说的"）', /【旁白】/.test(reqAll()), reqAll().slice(0, 300));
t('没有【】的那条是用户自己说的', msgs.filter(m => m.role === 'user').every(m => !m.s), msgs);

console.log('=== 2. 稳定前缀的标题在群里换掉（不能叫"你的角色设定"）===');
const sys1 = sysOf();
t('群聊的稳定前缀标题是「这个场合」', sys1.some(s => s.startsWith('# 这个场合')), sys1.map(s => s.slice(0, 20)));
t('不再出现「你的角色设定」', !sys1.some(s => s.includes('# 你的角色设定')), '');
t('本轮段直接点名"你现在是「甲」"（第一轮轮到甲）', sys1.some(s => s.includes('你现在是「甲」')), '');
t('并且解释了历史里【名字】前缀是什么意思', sys1.some(s => s.includes('标的是')), '');

await send('甲你在吗');   // 第二轮：甲说过的那条现在进了历史
t('甲说过的历史带【甲】前缀', /【甲】/.test(reqAll()), reqAll().slice(-260));

console.log('=== 3. 续写（⟳）应该是"刚才那人继续说"（用户拍板 A）===');
msgs = await aiMessages();
let spk = msgs.filter(m => m.role === 'assistant').map(m => m.s);
const beforeCont = spk[spk.length - 1];
t('续写之前那一条有说话人', !!beforeCont, spk);
await page.evaluate(() => document.getElementById('btn-continue').click());
await waitDone();
msgs = await aiMessages();
spk = msgs.filter(m => m.role === 'assistant').map(m => m.s);
t('续写仍然是刚才那个人（不是换个人）', spk[spk.length - 1] === beforeCont, { before: beforeCont, after: spk });
t('续写那条【也】记了说话人', spk[spk.length - 1] !== null, spk);

console.log('=== 4. 重新生成也不换人 ===');
await page.evaluate(() => {
  const el = [...document.querySelectorAll('#messages .msg.ai')].pop();
  el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
});
await sleep(400);
await page.evaluate(() => {
  const b = [...document.querySelectorAll('.msg-menu button')].find(x => x.textContent.trim() === '重新生成');
  b.click();
});
await waitDone();
await sleep(1200);
msgs = await aiMessages();
spk = msgs.filter(m => m.role === 'assistant').map(m => m.s);
t('重新生成之后还是同一个人', spk[spk.length - 1] === beforeCont, { before: beforeCont, after: spk });

console.log('=== 4b. 群里「换一个版本」也要保持同一个人 ===');
// 变体那条路会先删掉这一轮再重发，而且版本表里存着 speakerId ——
// 两处都碰了"谁说的"，所以必须单独验一次（v0.4.0 复查）。
await page.evaluate(() => {
  const el = [...document.querySelectorAll('#messages .msg.ai')].pop();
  el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
});
await sleep(400);
await page.evaluate(() => {
  const b = [...document.querySelectorAll('.msg-menu button')].find(x => x.textContent.trim() === '换一个版本');
  b.click();
});
await waitDone();
await sleep(1500);
msgs = await aiMessages();
const lastAi = msgs.filter(m => m.role === 'assistant').pop();
t('换版本之后还是同一个人', !!lastAi && lastAi.s === beforeCont, { before: beforeCont, after: lastAi && lastAi.s });
const variants = await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const all = await new Promise(r => { const q = db.transaction('messages').objectStore('messages').getAll(); q.onsuccess = () => r(q.result); });
  db.close();
  const mine = all.filter(m => m.charId === 'ggrp1' && m.role === 'assistant').sort((a, b) => (a.ts || 0) - (b.ts || 0)).pop();
  return mine ? { n: (mine.variants || []).length, spk: (mine.variants || []).map(v => v && v.speakerId) } : null;
});
console.log('   ' + JSON.stringify(variants));
t('版本表里每个版本都记着说话人', !!variants && variants.n >= 2 && variants.spk.every(s => !!s), variants);
t('每个版本的说话人都一样（不会串人）', !!variants && new Set(variants.spk).size === 1, variants);

// ⚠️ v0.4.1.4：删群入口从「选人弹窗里的一个按钮」搬到了【群设置整页】的底部。
//    这一节原来查的是 #pk-del（弹窗里那个），跟着改。
console.log('=== 5. 群里长按气泡头像进的是「群设置页」，不是普通编辑页 ===');
await page.evaluate(() => {
  const av = document.querySelector('#messages .msg.ai .av-her');
  av.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
});
await sleep(900);
const picker = await page.evaluate(() => ({
  page: document.getElementById('view-group').classList.contains('active'),
  modal: !document.querySelector('#modal').classList.contains('hidden'),
  editPage: document.getElementById('view-edit').classList.contains('active'),
  name: (document.getElementById('g-name') || {}).value,
  del: !!document.getElementById('g-del'),
}));
console.log('   ' + JSON.stringify(picker));
t('进的是群设置整页（不是弹窗、不是编辑页）', picker.page === true && picker.modal === false, picker);
t('没有进普通角色编辑页', picker.editPage === false, picker);
t('页面上就是这个群', picker.name === '周末茶会', picker);
t('这个页里有「删除这个群」', picker.del === true, picker);

console.log('=== 6. 删群：群没了、成员都还在 ===');
await page.evaluate(() => document.getElementById('g-del').click());
await sleep(800);
const confirmShown = await page.evaluate(() => !document.querySelector('#modal').classList.contains('hidden'));
t('弹了删除确认（说要删什么）', confirmShown === true, confirmShown);
const confirmText = await page.evaluate(() => document.querySelector('#modal-text').textContent);
t('确认文案说清了成员不受影响', confirmText.includes('成员') && confirmText.includes('不受影响'), confirmText.slice(0, 120));
await page.evaluate(() => document.getElementById('modal-ok').click());
await sleep(1500);
const afterDel = await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const cs = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').getAll(); q.onsuccess = () => r(q.result); });
  const ms = await new Promise(r => { const q = db.transaction('messages').objectStore('messages').getAll(); q.onsuccess = () => r(q.result); });
  db.close();
  return { chars: cs.map(c => c.id), groupMsgs: ms.filter(m => m.charId === 'ggrp1').length };
});
console.log('   ' + JSON.stringify(afterDel));
t('群记录没了', !afterDel.chars.includes('ggrp1'), afterDel.chars);
t('三个成员都还在', ['ga','gb','gc'].every(id => afterDel.chars.includes(id)), afterDel.chars);
t('群的聊天记录一起清掉了', afterDel.groupMsgs === 0, afterDel.groupMsgs);

console.log('=== 7. 导入：群成员 id 和 speakerId 都要重映射（W1 + 同类第六处）===');
// 本机建一个「小满」（id=local_xiaoman）；备份里的小满叫 bk_xiaoman —— 走"同名认领"
// 备份里的群成员写的是备份 id：认领之后群里必须指向本机 id，否则群里少人且不报错。
await seedChars(page, [{ name: '小满', greeting: '（在）', id: 'local_xiaoman' }]);
const backup = {
  version: 1, kind: 'mengxianju-backup', exportedAt: new Date().toISOString(),
  characters: [
    { id: 'bk_xiaoman', name: '小满', greeting: '（备份里的）', persona: '备份里的小满。', presetKey: 'blank', createdAt: 1 },
    { id: 'bk_aqi', name: '阿七', greeting: '（在）', persona: '阿七。', presetKey: 'blank', createdAt: 2 },
    { id: 'bk_group', name: '周末茶会', isGroup: true, memberIds: ['bk_xiaoman', 'bk_aqi'], groupNote: '',
      speakMode: 'round', turnIndex: 0, greeting: '（都在。）', presetKey: 'blank', createdAt: 3,
      // v0.4.1.6：memberCfg 的【键】是成员 charId，views 的【内层键】也是 ——
      // 导入时必须一起翻，否则认领过的成员在新机上"群内设置全部消失"。
      memberCfg: {
        bk_xiaoman: { note: '备份里的群内补充', talk: 0, views: { bk_aqi: '比他细心' } },
        bk_aqi: { muted: true },
      } },
  ],
  messages: { bk_group: [
    { id: 'm1', charId: 'bk_group', role: 'assistant', content: '小满说的第一句', speakerId: 'bk_xiaoman', ts: 1000 },
    { id: 'm2', charId: 'bk_group', role: 'assistant', content: '阿七说的第二句', speakerId: 'bk_aqi', ts: 2000 },
  ] },
  memories: [
    { id: 'mm1', charId: 'bk_group', who: 'bk_xiaoman', text: '芙兰对他的好感太明显了',
      kind: 'fact', freq: 'normal', ts: 5000 },
  ],
};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mxj-g2-'));
const bkFile = path.join(dir, 'bk.json');
fs.writeFileSync(bkFile, JSON.stringify(backup), 'utf8');
const inp = await page.$('#file-import');
await inp.uploadFile(bkFile);
// ⚠️ 用「仅角色」而不是「完全还原」（v0.4.0 复查时实测出来的）：
//    「完全还原」会【先清空本机】再导入（applyImport 里的 clearStores 在 chars.all() 之前），
//    于是本机那个「小满」已经没了 —— 同名认领那条分支根本走不到，备份 id 原样落库。
//    会触发认领的是【不清空】的那两个模式：仅角色 / 设置与角色。
//    这也说明报告里那类 bug 的真实触发场景就是它们。
await pickImportMode(page, 'chars', sleep);
await sleep(2500);
const afterImp = await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const cs = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').getAll(); q.onsuccess = () => r(q.result); });
  const ms = await new Promise(r => { const q = db.transaction('messages').objectStore('messages').getAll(); q.onsuccess = () => r(q.result); });
  db.close();
  const g = cs.find(c => c.name === '周末茶会');
  const xm = cs.find(c => c.name === '小满');
  return {
    ids: cs.map(c => c.id),
    xiaoman: xm && xm.id,
    members: g ? g.memberIds : null,
    // ⚠️ 只数【这个群】的消息，不是全库 —— 「仅角色」模式下别的角色本来就有消息。
    //    （IMPORT_MODES 里 chars 的 parts 没有 msgs，所以这里应当是 0。）
    msgCount: g ? ms.filter(m => m.charId === g.id).length : -1,
  };
});
console.log('   ' + JSON.stringify(afterImp));
t('小满走的是「同名认领」，用的是本机 id', afterImp.xiaoman === 'local_xiaoman', afterImp.xiaoman);
t('群成员 id 被重映射了（不是备份里的 bk_*）',
  !!afterImp.members && afterImp.members.includes('local_xiaoman'), afterImp.members);
t('另一个新成员按备份 id 建出来了', !!afterImp.members && afterImp.members.some(id => afterImp.ids.includes(id) && id !== 'local_xiaoman'), afterImp.members);
t('「仅角色」确实不带聊天记录（所以 speakerId 那条单独说）', afterImp.msgCount === 0, afterImp.msgCount);

// v0.4.1.6：memberCfg 的键也要重映射（不然她的群内设置全静默失效）
const cfgAfter = await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const cs = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').getAll(); q.onsuccess = () => r(q.result); });
  db.close();
  const g = cs.find(c => c.name === '周末茶会');
  const aqi = cs.find(c => c.name === '阿七');
  return { keys: Object.keys((g && g.memberCfg) || {}), one: (g && g.memberCfg && g.memberCfg['local_xiaoman']) || null,
           aqiId: aqi && aqi.id, persona: (g && g.persona) || '', members: (g && g.memberIds) || [] };
});
console.log('   ' + JSON.stringify(cfgAfter));
// 判据要写成"每个键都指向本机真实成员"，不能写成"不许有 bk_ 前缀"：
// 阿七在本机没有同名角色，是按【备份 id 原样建出来】的 —— 它的本机 id 就是 bk_aqi，
// 那个键本来就该保持 bk_aqi。留在旧 id 上的情况（认领过的成员）才是 bug，
// 而它表现为"键不在 memberIds 里"。
const badKeys = cfgAfter.keys.filter(k => cfgAfter.members.indexOf(k) < 0);
t('群内设置的键全都指向本机真实成员（认领过的那位也翻过来了）',
  badKeys.length === 0 && cfgAfter.keys.includes('local_xiaoman'), { keys: cfgAfter.keys, members: cfgAfter.members, bad: badKeys });
t('活跃度 0 也活下来了（不是被当成空壳删掉）', !!cfgAfter.one && Number(cfgAfter.one.talk) === 0, cfgAfter.one);
t('views 的内层键也翻成了本机 id', !!cfgAfter.one && cfgAfter.one.views && cfgAfter.one.views[cfgAfter.aqiId] === '比他细心', cfgAfter.one && cfgAfter.one.views);
t('群人设里带上了这份群内补充（说明设置真的生效）', cfgAfter.persona.indexOf('备份里的群内补充') >= 0, '');
t('「她私下怎么看别人」也进了群人设', cfgAfter.persona.indexOf('她私下怎么看别人') >= 0, '');

// 再导一次「仅聊天记录」（这个模式带记忆）—— 验 memories.who 的重映射
const inp2 = await page.$('#file-import');
await inp2.uploadFile(bkFile);
await pickImportMode(page, 'msgs', sleep);
await sleep(2500);
const memAfter = await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const ms = await new Promise(r => { const q = db.transaction('memories').objectStore('memories').getAll(); q.onsuccess = () => r(q.result); });
  db.close();
  return ms.map(m => ({ text: m.text, who: m.who || '' }));
});
console.log('   ' + JSON.stringify(memAfter));
const whoOne = memAfter.find(m => m.text.indexOf('芙兰对他的好感') >= 0);
t('记忆的 who 也翻成了本机 id（不然谁都不会被注入到）', !!whoOne && whoOne.who === 'local_xiaoman', whoOne);

console.log('=== 8. speakerId 的重映射：诚实说清它现在【到不了】 ===');
// 实测结论（v0.4.0 复查）：五个导入模式里，会【同名认领】的两个（仅角色 / 设置与角色）
// 都不带 messages（IMPORT_MODES 的 parts 里没有 msgs）；
// 会带 messages 的两个（完全还原 / 仅聊天记录）在这条路上认领不了 ——
// 前者先清空本机（chars.all() 读到的是空表），后者根本不导入角色。
// 也就是说：**当前没有任何一个模式能同时触发"认领"和"导入聊天记录"**。
// 所以 speakerId 的重映射现在是一段【防御性代码】：今天到不了，
// 但它是同一类（charId 在数据模型里有六处）里唯一剩下的一个，
// 不补的话，将来一旦加一个"带记录的角色导入"模式，它就会立刻变成静默缺陷。
const SRC = readCode(WWW + '/js/app.js');
t('speakerId 的重映射代码在（防御性，理由见这条的注释）',
  SRC.includes('if (rec.speakerId) rec.speakerId = remap(rec.speakerId);'));
// ⚠️ 断言要看【代码】不是注释 —— readCode 把注释剥掉了（这正是它存在的意义）。
t('群成员 id 的重映射代码在（这条是真会撞到的）',
  SRC.includes('const gid = remap(c.id);') && SRC.includes('droppedMembers'));

console.log('');
console.log('JS 错误: ' + (errs.length ? errs.join(' | ') : '无'));
t('无 JS 报错', errs.length === 0, errs.join(' | '));
console.log('');
console.log('通过 ' + pass + ' / 失败 ' + fail);
await browser.close(); server.close();
fs.rmSync(dir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
