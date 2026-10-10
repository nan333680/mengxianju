// e2e-importmode.mjs —— 导入的 5 种模式（v1.19.11）
//
// 覆盖：
//   1. 选完文件弹模式弹窗，显示备份内容 + 本机现状
//   2. 模式「仅角色」：角色被覆盖，本机聊天记录/记忆/世界书一条不动
//   3. 模式「仅聊天记录」：记录+记忆被替换，角色参数不动
//   4. 模式「仅世界书」：两层世界书都换，其它不动
//   5. 模式「设置与角色」：全局设置(含myProfile/myEnv)换，记录不动
//   6. 模式「完全还原」：先清空再写入 + 二次确认
//   7. 完全还原的二次确认点「取消」→ 本机数据一条不少
//   8. 导入的备份带 kv 记账 → 写回去；导出也带 kv
//   9. apiKey / searchKey 永不被覆盖
//  10. 导出内容不含任何密钥（v1.21.45）

import puppeteer from 'puppeteer-core';
import { seedChar } from './e2e-helper.mjs';
import http from 'http';
import fs from 'fs';
import path from 'path';
// 工作目录自适应（原来写死 C:/A-DSH-Tool/ai-companion）
const R = path.resolve(import.meta.dirname).split(path.sep).join('/');

const WWW = `${R}/www`;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const TMP = 'C:\\A-DSH-Apk\\_check\\importmode';
fs.mkdirSync(TMP, { recursive: true });

const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8' };
const server = http.createServer((req,res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p==='/') p='/index.html';
  const f = path.join(WWW, p);
  if (!fs.existsSync(f)) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f));
});
await new Promise(r => server.listen(0,'127.0.0.1',r));
const port = server.address().port;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = [];
page.on('pageerror', e => errs.push(e.message));
const sleep = ms => new Promise(r=>setTimeout(r,ms));
let pass=0, fail=0;
const t=(n,ok,ex='')=>{ if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));} };

/** 直接往库里塞数据（绕过 UI，快且稳） */
async function seed(page, spec) {
  return await page.evaluate(async (s) => {
    const o = indexedDB.open('ai-companion');
    const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
    const put = (store, rec) => new Promise(r => { const tx = db.transaction(store,'readwrite'); tx.objectStore(store).put(rec); tx.oncomplete = r; });
    const ids = {};
    for (const c of (s.chars||[])) { await put('characters', c); ids[c.name] = c.id; }
    for (const m of (s.msgs||[])) await put('messages', m);
    for (const m of (s.mems||[])) await put('memories', m);
    for (const g of (s.groups||[])) await put('wbGroups', g);
    for (const x of (s.solos||[])) await put('wbSolo', x);
    for (const e of (s.kv||[])) await put('kv', e);
    db.close();
    return ids;
  }, spec);
}

async function counts(page) {
  return await page.evaluate(async () => {
    const o = indexedDB.open('ai-companion');
    const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
    const cnt = (s) => new Promise(r => { const q = db.transaction(s).objectStore(s).count(); q.onsuccess = () => r(q.result); });
    const out = { chars: await cnt('characters'), msgs: await cnt('messages'), mems: await cnt('memories'),
                  groups: await cnt('wbGroups'), solos: await cnt('wbSolo'), kv: await cnt('kv') };
    db.close(); return out;
  });
}

/** 上传备份 → 等模式弹窗出现 → 选中某个模式 → 点「导入」 */
async function doImport(page, file, modeKey, confirmLabel) {
  const inp = await page.$('#file-import');
  await inp.uploadFile(file);
  // 等弹窗（解析 + 数库都是异步的）
  for (let i = 0; i < 60; i++) {
    const shown = await page.$eval('#import-modal', el => !el.classList.contains('hidden')).catch(() => false);
    if (shown) break;
    await sleep(100);
  }
  const shown = await page.$eval('#import-modal', el => !el.classList.contains('hidden')).catch(() => false);
  if (!shown) throw new Error('模式弹窗没出现');
  // 勾选模式
  const picked = await page.evaluate((k) => {
    const el = document.querySelector('input[name="imp-mode"][value="' + k + '"]');
    if (!el) return false;
    el.checked = true;
    return true;
  }, modeKey);
  if (!picked) throw new Error('找不到模式 ' + modeKey);
  await sleep(120);
  await page.evaluate(() => document.getElementById('import-ok').click());
  if (confirmLabel) {
    // 模式 1 会再弹一次确认
    for (let i = 0; i < 40; i++) {
      const m = await page.$eval('#modal', el => !el.classList.contains('hidden')).catch(() => false);
      if (m) break;
      await sleep(100);
    }
    if (confirmLabel === 'CANCEL') {
      await page.evaluate(() => document.getElementById('modal-cancel').click());
    } else {
      await page.evaluate(() => document.getElementById('modal-ok').click());
    }
  }
  // 等导入完成：轮询三个数都不再变
  let last = null;
  for (let i = 0; i < 200; i++) {
    const n = await counts(page);
    if (last && last.chars === n.chars && last.msgs === n.msgs && last.mems === n.mems
        && last.groups === n.groups && last.solos === n.solos) break;
    last = n;
    await sleep(120);
  }
}

await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
await sleep(1500);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil:'networkidle0' });
// v1.21.59：全新安装不再自动建角色（产品改空），测试自己塞一个
await seedChar(page, '测试角色', { greeting: '' });   // 空开场白：不额外多出一条消息
await page.reload({waitUntil:'networkidle0'}); await sleep(500);
await sleep(300);

// ===== 准备：本机现有 2 个角色 + 记录 + 记忆 + 世界书 + apiKey =====
const local = await seed(page, {
  chars: [
    { id:'locA', name:'甲', persona:'本机甲的旧人设', greeting:'旧开场白', createdAt: 1,
      temperature: 1.0, contextRounds: 20, descLevel:'mid', verbosity:'medium' },
    { id:'locB', name:'乙', persona:'本机乙的人设', greeting:'乙的开场白', createdAt: 2,
      temperature: 1.0, contextRounds: 20 },
  ],
  msgs: [
    { id:'lm1', charId:'locA', role:'user', content:'本机旧消息1', ts: 100, archived:false },
    { id:'lm2', charId:'locA', role:'assistant', content:'本机旧回复1', ts: 101, archived:false },
    { id:'lm3', charId:'locB', role:'user', content:'本机旧消息2', ts: 102, archived:false },
  ],
  mems: [ { id:'lmem1', charId:'locA', text:'本机旧记忆', kind:'fact', freq:'normal', ts: 1 } ],
  groups: [ { id:'lg1', name:'本机组', members:['locA'], entries:[{ id:'lge1', title:'本机组条目', keys:['甲'], content:'本机组内容' }], createdAt: 1, order: 1 } ],
  solos: [ { id:'ls1', charId:'locA', entries:[{ id:'lse1', title:'本机单独条目', keys:['甲'], content:'本机单独内容' }] } ],
  kv: [ { k:'settings', v:{ apiKey:'sk-LOCAL-KEY-MUST-SURVIVE', searchKey:'tvly-LOCAL-MUST-SURVIVE', myProfile:'本机的我的设定', myEnv:'本机的居住环境', model:'deepseek-flash' } } ],
});
await page.reload({ waitUntil:'networkidle0' });
await sleep(600);
const c0 = await counts(page);
console.log('本机基线: ' + JSON.stringify(c0));

// ===== 备份文件：2 个角色（其中一个同名不同 id）+ 记录 + 记忆 + 世界书 + 设置 + kv =====
const backup = {
  version: 1, exportedAt: Date.now(),
  settings: { apiKey:'', searchKey:'tvly-BACKUP-MUST-NOT-WIN', myProfile:'备份里的我的设定', myEnv:'备份里的居住环境', model:'deepseek-flash', theme:'light' },
  characters: [
    { id:'bkA', name:'甲', persona:'备份甲的新人设', greeting:'备份开场白', createdAt: 1, temperature: 1.5, contextRounds: 8, descLevel:'high', verbosity:'short' },
    { id:'bkC', name:'丙', persona:'备份丙的人设', greeting:'丙的开场白', createdAt: 3, temperature: 1.0, contextRounds: 20 },
  ],
  messages: {
    bkA: [ { id:'bm1', charId:'bkA', role:'user', content:'备份消息1', ts: 200, archived:false },
           { id:'bm2', charId:'bkA', role:'assistant', content:'备份回复1', ts: 201, archived:true } ],
    bkC: [ { id:'bm3', charId:'bkC', role:'user', content:'丙的消息', ts: 202, archived:false } ],
  },
  memories: [
    { id:'bmem1', charId:'bkA', text:'备份记忆1', kind:'fact', freq:'normal', ts: 10 },
    { id:'bmem2', charId:'bkC', text:'备份记忆2', kind:'fact', freq:'often', ts: 11 },
  ],
  worldbook: {
    groups: [ { id:'bg1', name:'备份组', members:['bkA','bkC'], entries:[{ id:'bge1', title:'备份组条目', keys:['x'], content:'备份组内容' }], createdAt: 1, order: 1 } ],
    solo: [ { id:'bs1', charId:'bkA', entries:[{ id:'bse1', title:'备份单独条目', keys:['y'], content:'备份单独内容' }] } ],
  },
  kv: [ { k:'memRolling:bkA', v:{ text:'备份的滚动摘要', upTo: 5, day: 1 } },
        { k:'msgSeq:bkA', v: 5 },
        { k:'settings', v:{ apiKey:'sk-BACKUP-MUST-NOT-WIN', searchKey:'tvly-BACKUP-MUST-NOT-WIN' } },
        { k:'lastCharId', v:'bkC' } ],
};
const BK = TMP + '\\backup.json';
fs.writeFileSync(BK, JSON.stringify(backup));

// ============================================================
console.log('');
console.log('=== 1. 选完文件弹模式弹窗，预览内容 ===');
{
  const inp = await page.$('#file-import');
  await inp.uploadFile(BK);
  for (let i = 0; i < 60; i++) {
    const shown = await page.$eval('#import-modal', el => !el.classList.contains('hidden')).catch(() => false);
    if (shown) break;
    await sleep(100);
  }
  const shown = await page.$eval('#import-modal', el => !el.classList.contains('hidden')).catch(() => false);
  t('弹窗出现了', shown);
  const survey = await page.$eval('#import-survey', el => el.textContent);
  t('预览显示 2 个角色', /角色\s*2/.test(survey.replace(/\s+/g,' ')), survey.slice(0,60));
  t('预览显示 3 条聊天记录', survey.includes('3 条'), survey.slice(0,80));
  t('预览显示 2 条记忆', survey.includes('2 条'), '');
  t('预览显示本机现状', survey.includes('本机现有'), '');
  const n = await page.$$eval('#import-modes .imp-mode', els => els.length);
  t('列出 5 种模式', n === 5, '实际 ' + n);
  const labels = await page.$$eval('#import-modes .imp-mode-head b', els => els.map(e => e.textContent));
  t('模式名齐全', ['完全还原（危险）','设置与角色','仅角色','仅聊天记录','仅世界书'].every(x => labels.includes(x)), JSON.stringify(labels));
  const warn = await page.$$eval('#import-modes .imp-warn', els => els.map(e => e.textContent.trim()));
  t('只有完全还原带删除警告', warn.filter(x => x).length === 1 && warn.find(x=>x).includes('不可撤销'), JSON.stringify(warn.map(x=>x.slice(0,20))));
  await page.evaluate(() => document.getElementById('import-cancel').click());
  await sleep(300);
  const hidden = await page.$eval('#import-modal', el => el.classList.contains('hidden'));
  t('点取消会关掉弹窗', hidden);
  const after = await counts(page);
  t('取消后本机数据一条没动', JSON.stringify(after) === JSON.stringify(c0), JSON.stringify(after));
}

// ============================================================
console.log('');
console.log('=== 2. 仅角色：角色覆盖，记录/记忆/世界书不动 ===');
{
  await doImport(page, BK, 'chars');
  const c = await counts(page);
  // 本机基线是 3（seed 的甲乙 + app 自动建的「空白角色」）。
  // 备份里是「甲(bkA)」和「丙(bkC)」：甲 id 对不上但【名字相同】→ 合并到本机的甲上，
  // 丙是新名字 → 新建。所以总数 = 3 + 1 = 4。
  t('角色表 3 → 4（甲合并、丙新增）', c.chars === 4, JSON.stringify(c));
  t('聊天记录没被动（仍 3 条）', c.msgs === 3, 'msgs=' + c.msgs);
  t('记忆没被动（仍 1 条）', c.mems === 1, 'mems=' + c.mems);
  t('世界书没被动', c.groups === 1 && c.solos === 1, JSON.stringify(c));
  const ch = await page.evaluate(async () => {
    const o = indexedDB.open('ai-companion');
    const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
    const all = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').getAll(); q.onsuccess = () => r(q.result); });
    const names = all.map(x => x.name).sort();
    const jiaAll = all.filter(x => x.name === '甲');
    const jia = jiaAll[0];
    db.close();
    return { names, jiaCount: jiaAll.length, jiaId: jia && jia.id,
             persona: jia && jia.persona, ctx: jia && jia.contextRounds };
  });
  t('丙被新建出来了', ch.names.includes('丙'), JSON.stringify(ch.names));
  t('本机的乙还在（模式不清空）', ch.names.includes('乙'), JSON.stringify(ch.names));
  t('★「甲」只有一个，没有变成两个同名角色', ch.jiaCount === 1, JSON.stringify(ch.names));
  t('★ 甲保留了本机 id（是合并不是新建）', ch.jiaId === 'locA', String(ch.jiaId));
  t('甲的人设被覆盖成备份版', ch.persona === '备份甲的新人设', ch.persona);
  t('甲的上下文轮数被覆盖成 8', ch.ctx === 8, String(ch.ctx));
  // 认领后，本机甲名下原本那 2 条消息必须还在（remap 不能把它们丢了）
  const msgsA = await page.evaluate(async () => {
    const o = indexedDB.open('ai-companion');
    const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
    const idx = db.transaction('messages').objectStore('messages').index('charId');
    const arr = await new Promise(r => { const q = idx.getAll('locA'); q.onsuccess = () => r(q.result); });
    db.close(); return arr.map(m => m.id).sort();
  });
  t('★ 合并后本机甲名下的旧记录还在', msgsA.includes('lm1') && msgsA.includes('lm2'), JSON.stringify(msgsA));
  // v1.19.12：「仅角色」要带上【这些角色的】单独世界书 ——
  // 那本来就是这个角色的一部分，不该逼用户再导一次。
  // 但角色【组】属于全局设定，不该被「仅角色」碰。
  const wb = await page.evaluate(async () => {
    const o = indexedDB.open('ai-companion');
    const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
    const ss = await new Promise(r => { const q = db.transaction('wbSolo').objectStore('wbSolo').getAll(); q.onsuccess = () => r(q.result); });
    const gs = await new Promise(r => { const q = db.transaction('wbGroups').objectStore('wbGroups').getAll(); q.onsuccess = () => r(q.result); });
    db.close();
    return { solos: ss.map(x => ({ charId: x.charId, titles: (x.entries || []).map(e => e.title) })),
             groupNames: gs.map(g => g.name) };
  });
  const soloA = wb.solos.find(x => x.charId === 'locA');
  t('★ 仅角色会带上该角色的单独世界书', !!soloA && soloA.titles.includes('备份单独条目'),
    JSON.stringify(wb.solos));
  t('★ 仅角色不动角色组（组属于全局设定）', !wb.groupNames.includes('备份组'), JSON.stringify(wb.groupNames));
  const s = await page.evaluate(async () => {
    const o = indexedDB.open('ai-companion');
    const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
    const r = await new Promise(res => { const q = db.transaction('kv').objectStore('kv').get('settings'); q.onsuccess = () => res(q.result); });
    db.close(); return r && r.v;
  });
  t('仅角色不改全局设置（myProfile 仍是本机那句）', s.myProfile === '本机的我的设定', s.myProfile);
  t('仅角色不动 apiKey', s.apiKey === 'sk-LOCAL-KEY-MUST-SURVIVE', s.apiKey);
  t('仅角色不动 searchKey', s.searchKey === 'tvly-LOCAL-MUST-SURVIVE', s.searchKey);
}

// ============================================================
console.log('');
console.log('=== 3. 设置与角色：全局设置也换，记录仍不动 ===');
{
  await doImport(page, BK, 'config');
  const c = await counts(page);
  t('聊天记录仍 3 条', c.msgs === 3, 'msgs=' + c.msgs);
  t('记忆仍 1 条', c.mems === 1, 'mems=' + c.mems);
  const s = await page.evaluate(async () => {
    const o = indexedDB.open('ai-companion');
    const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
    const r = await new Promise(res => { const q = db.transaction('kv').objectStore('kv').get('settings'); q.onsuccess = () => res(q.result); });
    db.close(); return r && r.v;
  });
  t('myProfile 换成备份的', s.myProfile === '备份里的我的设定', s.myProfile);
  t('myEnv 换成备份的', s.myEnv === '备份里的居住环境', s.myEnv);
  t('theme 换成备份的 light', s.theme === 'light', s.theme);
  t('apiKey 仍然不被覆盖', s.apiKey === 'sk-LOCAL-KEY-MUST-SURVIVE', s.apiKey);
  t('searchKey 仍然不被覆盖', s.searchKey === 'tvly-LOCAL-MUST-SURVIVE', s.searchKey);
}

// ============================================================
console.log('');
console.log('=== 4. 仅聊天记录：记录+记忆替换，角色参数不动 ===');
{
  // 先把角色参数改回一个"本机特有"的值，验证模式 4 不碰它
  // ⚠️ 认领逻辑下，备份的「甲」会合并到本机的 locA 上 —— 库里根本没有 bkA。
  //    之前这里取 'bkA' 拿到 undefined，后面 st.put(undefined) 抛错 →
  //    tx.oncomplete 永不触发 → page.evaluate 永久挂起（表现为 ProtocolError 超时）。
  const pinned = await page.evaluate(async () => {
    const o = indexedDB.open('ai-companion');
    const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
    const tx = db.transaction('characters','readwrite');
    const st = tx.objectStore('characters');
    const q = st.get('locA');
    q.onsuccess = () => {
      const c = q.result;
      if (!c) return;                 // 找不到就不改，交给断言去报
      c.persona = '模式4前的人设'; c.contextRounds = 33; st.put(c);
    };
    await new Promise(r => { tx.oncomplete = r; });
    db.close();
    return true;
  });
  t('准备好本机甲的参数（id 仍是 locA）', pinned === true);
  await doImport(page, BK, 'msgs');
  const c = await counts(page);
  // ⚠️ 模式 4 刻意【不清空】：本机 3 条 + 备份 3 条 = 6。清空是模式 1 的活。
  t('聊天记录 = 本机 3 + 备份 3', c.msgs === 6, 'msgs=' + c.msgs);
  t('记忆 = 本机 1 + 备份 2', c.mems === 3, 'mems=' + c.mems);
  // ★ 关键：备份里 bkA 的记录必须落到本机的 locA 名下，不能留在查不到的 bkA 上
  const routed = await page.evaluate(async () => {
    const o = indexedDB.open('ai-companion');
    const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
    const ms = await new Promise(r => { const q = db.transaction('messages').objectStore('messages').getAll(); q.onsuccess = () => r(q.result); });
    const mems = await new Promise(r => { const q = db.transaction('memories').objectStore('memories').getAll(); q.onsuccess = () => r(q.result); });
    db.close();
    return { bmA: ms.filter(m => m.id === 'bm1' || m.id === 'bm2').map(m => m.charId),
             orphan: ms.filter(m => m.charId === 'bkA').length,
             memA: mems.filter(m => m.id === 'bmem1').map(m => m.charId) };
  });
  t('★ 备份的消息接到本机甲名下', routed.bmA.every(x => x === 'locA'), JSON.stringify(routed.bmA));
  t('★ 没有孤儿记录留在旧 id 上', routed.orphan === 0, 'orphan=' + routed.orphan);
  t('★ 备份的记忆也接到本机甲名下', routed.memA[0] === 'locA', JSON.stringify(routed.memA));
  const has = await page.evaluate(async () => {
    const o = indexedDB.open('ai-companion');
    const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
    const ms = await new Promise(r => { const q = db.transaction('messages').objectStore('messages').getAll(); q.onsuccess = () => r(q.result); });
    const ch = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').getAll(); q.onsuccess = () => r(q.result); });
    db.close();
    return { ids: ms.map(m => m.id).sort(), jia: (ch.find(x=>x.id==='locA')||{}).persona, ctx: (ch.find(x=>x.id==='locA')||{}).contextRounds };
  });
  t('库里是本机旧记录（没被清掉，因为没有清空）', has.ids.includes('lm1'), JSON.stringify(has.ids));
  t('备份记录也进来了', has.ids.includes('bm1') && has.ids.includes('bm3'), JSON.stringify(has.ids));
  t('角色参数没被模式 4 碰（仍是「模式4前的人设」）', has.jia === '模式4前的人设', has.jia);
  t('上下文轮数仍是 33', has.ctx === 33, String(has.ctx));
}

// ============================================================
console.log('');
console.log('=== 5. 仅世界书：两层都换，其它不动 ===');
{
  const before = await counts(page);
  await doImport(page, BK, 'wb');
  const c = await counts(page);
  t('角色数不变', c.chars === before.chars, JSON.stringify(c));
  t('聊天记录不变', c.msgs === before.msgs, JSON.stringify(c));
  t('记忆不变', c.mems === before.mems, JSON.stringify(c));
  const wb = await page.evaluate(async () => {
    const o = indexedDB.open('ai-companion');
    const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
    const gs = await new Promise(r => { const q = db.transaction('wbGroups').objectStore('wbGroups').getAll(); q.onsuccess = () => r(q.result); });
    const ss = await new Promise(r => { const q = db.transaction('wbSolo').objectStore('wbSolo').getAll(); q.onsuccess = () => r(q.result); });
    db.close();
    return { gNames: gs.map(g=>g.name).sort(), sIds: ss.map(s=>s.id).sort() };
  });
  t('备份的组进来了', wb.gNames.includes('备份组'), JSON.stringify(wb.gNames));
  t('本机的组还在（模式不清空，按 id 覆盖）', wb.gNames.includes('本机组'), JSON.stringify(wb.gNames));
  // ⚠️ 一个角色只能有一份单独条目，所以备份的 bs1 会【覆盖】本机的 ls1（id 保留 ls1）。
  //    属性该验的是"内容换成了备份的"，不是"id 变成了 bs1"——曾在这里写错过断言。
  const solo = await page.evaluate(async () => {
    const o = indexedDB.open('ai-companion');
    const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
    const ss = await new Promise(r => { const q = db.transaction('wbSolo').objectStore('wbSolo').getAll(); q.onsuccess = () => r(q.result); });
    db.close();
    const mine = ss.find(s => s.charId === 'locA');
    return { count: ss.length, titles: mine ? mine.entries.map(e => e.title) : [] };
  });
  t('★ 本的单独条目被备份内容覆盖（同角色只有一份）', solo.titles.includes('备份单独条目'), JSON.stringify(solo));
  t('本机旧条目内容已被换掉', !solo.titles.includes('本机单独条目'), JSON.stringify(solo.titles));
  // 本机只有 locA 有单独条目，备份也只有 bkA→locA 一份，合并后就是 1 条。
  // 关键是"没膨胀成 2 条"（那才是 bug），不是"等于 2"。
  t('单独条目没膨胀成两份', solo.count === 1, 'count=' + solo.count);
}

// ============================================================
console.log('');
console.log('=== 6. 完全还原：先清空再写入 ===');
{
  await doImport(page, BK, 'all', 'OK');
  const c = await counts(page);
  t('角色表 = 备份的 2 个', c.chars === 2, JSON.stringify(c));
  t('聊天记录 = 备份的 3 条（本机旧记录被清掉）', c.msgs === 3, 'msgs=' + c.msgs);
  t('记忆 = 备份的 2 条', c.mems === 2, 'mems=' + c.mems);
  t('世界书 = 备份的 1 组 1 单独', c.groups === 1 && c.solos === 1, JSON.stringify(c));
  const has = await page.evaluate(async () => {
    const o = indexedDB.open('ai-companion');
    const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
    const ms = await new Promise(r => { const q = db.transaction('messages').objectStore('messages').getAll(); q.onsuccess = () => r(q.result); });
    const gs = await new Promise(r => { const q = db.transaction('wbGroups').objectStore('wbGroups').getAll(); q.onsuccess = () => r(q.result); });
    db.close();
    return { ids: ms.map(m=>m.id).sort(), gNames: gs.map(g=>g.name) };
  });
  t('本机旧消息被彻底清掉', !has.ids.includes('lm1') && !has.ids.includes('lm2') && !has.ids.includes('lm3'), JSON.stringify(has.ids));
  t('本机旧组被彻底清掉', !has.gNames.includes('本机组'), JSON.stringify(has.gNames));
}

// ============================================================
console.log('');
console.log('=== 7. 完全还原的二次确认点取消 → 一条不少 ===');
{
  const before = await counts(page);
  await doImport(page, BK, 'all', 'CANCEL');
  await sleep(500);
  const after = await counts(page);
  t('取消后数据完全没变', JSON.stringify(after) === JSON.stringify(before), JSON.stringify(after));
}

// ============================================================
console.log('');
console.log('=== 8. kv 记账：导入写回，且不覆盖本机关键键 ===');
{
  const kv = await page.evaluate(async () => {
    const o = indexedDB.open('ai-companion');
    const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
    const all = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').getAll(); q.onsuccess = () => r(q.result); });
    db.close();
    const m = {}; for (const e of all) m[e.k] = e.v;
    return m;
  });
  t('备份的 memRolling 写回来了', kv['memRolling:bkA'] && kv['memRolling:bkA'].text === '备份的滚动摘要', JSON.stringify(kv['memRolling:bkA']));
  t('备份的 msgSeq 写回来了', kv['msgSeq:bkA'] === 5, String(kv['msgSeq:bkA']));
  t('备份里的 settings 没盖掉本机 apiKey', kv.settings && kv.settings.apiKey === 'sk-LOCAL-KEY-MUST-SURVIVE', kv.settings && kv.settings.apiKey);
  t('备份里的 settings 也没盖掉本机 searchKey', kv.settings && kv.settings.searchKey === 'tvly-LOCAL-MUST-SURVIVE', kv.settings && kv.settings.searchKey);
  t('lastCharId 不被备份覆盖', kv.lastCharId !== 'bkC', String(kv.lastCharId));
}

// ============================================================
console.log('');
console.log('=== 9. 导出带 kv 记账键 ===');
{
  // 造一个滚动摘要，再导出，检查 JSON 里有它
  await page.evaluate(async () => {
    const o = indexedDB.open('ai-companion');
    const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
    const put = (rec) => new Promise(r => { const tx = db.transaction('kv','readwrite'); tx.objectStore('kv').put(rec); tx.oncomplete = r; });
    await put({ k:'memRolling:bkA', v:{ text:'导出应带上的摘要', upTo: 9, day: 2 } });
    await put({ k:'memSummed:bkA', v:['bm1','bm2'] });
    db.close();
  });
  const payload = await page.evaluate(async () => {
    const o = indexedDB.open('ai-companion');
    const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
    const all = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').getAll(); q.onsuccess = () => r(q.result); });
    db.close();
    const PREFIX = ['msgSeq:','memSummed:','memSumAt:','memDedupeAt:','memArchiveAt:','memArchiveLastAt:','memDeleted:','memRolling:','clock:','greeted:'];
    const keep = all.filter(e => PREFIX.some(p => e.k.startsWith(p)));
    const drop = all.filter(e => !PREFIX.some(p => e.k.startsWith(p))).map(e => e.k);
    return { keep: keep.map(e=>e.k).sort(), drop };
  });
  t('导出会带上 memRolling', payload.keep.includes('memRolling:bkA'), JSON.stringify(payload.keep));
  t('导出会带上 memSummed', payload.keep.includes('memSummed:bkA'), '');
  t('导出不含 settings', !payload.keep.includes('settings'), JSON.stringify(payload.keep));
  t('导出不含 lastCharId', !payload.keep.includes('lastCharId'), '');
}

// ============================================================
console.log('');
console.log('=== 10. 导出内容不含任何密钥（v1.21.45 新增）===');
{
  // 导出在浏览器里走 Blob 回退；把 createObjectURL 换掉就能截下内容，
  // 不用为测试在产品代码里开钩子。
  await page.evaluate(() => {
    window.__exportBlob = null;
    URL.createObjectURL = (b) => { window.__exportBlob = b; return 'blob:hooked'; };
  });
  await page.evaluate(() => { document.getElementById('btn-export').click(); });
  await sleep(600);
  const dump = await page.evaluate(async () => {
    const b = window.__exportBlob;
    return b ? await b.text() : null;
  });
  t('导出被触发且拿到内容', !!dump && dump.length > 100, dump ? dump.length + ' 字节' : 'null');
  const leaked = dump ? (dump.match(/sk-[A-Za-z0-9_-]{6,}|tvly-[A-Za-z0-9_-]{6,}/g) || []) : [];
  t('★ 导出内容里搜不到任何 sk-/tvly- 开头的密钥', leaked.length === 0, leaked.join(', '));
  let st = {};
  try { st = (JSON.parse(dump) || {}).settings || {}; } catch (e) { /* 解不开下面两条会报出来 */ }
  t('导出 settings.apiKey 是空串', st.apiKey === '', JSON.stringify(st.apiKey));
  t('★ 导出 settings.searchKey 是空串', st.searchKey === '', JSON.stringify(st.searchKey));
}

// ============================================================
console.log('');
console.log('=== 11. 页面无 JS 错误 ===');
t('没有 pageerror', errs.length === 0, errs.slice(0,3).join(' | '));

console.log('');
console.log('通过 ' + pass + ' / 失败 ' + fail);
await browser.close();
server.close();
process.exit(fail ? 1 : 0);
