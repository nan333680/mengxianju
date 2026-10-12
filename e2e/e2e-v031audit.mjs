// e2e-v031audit.mjs — v0.3.1 全面复查修掉的那批缺陷（钉住，防止回退）
//
// 这一批全部来自「全方面检查 bug」那一轮，共同点是【静默】：
// 不报错、不弹提示，用户只看到行为不对（她忘了 / 记忆不涨 / 按钮没反应）。
// 所以必须有用例锁住，否则下次很容易又改回去。
//
//   1) parseMemJson 对「合法数组但元素没有 text」静默返回 [] ——
//      tidyNow 会把它当成「模型明确说没有要改的」，于是把「被删对话清单」清掉。
//      那份清单是唯一凭据（消息本体早删了），清掉之后「删了她还记得」永久复发。
//   2) untilDay 只排 null/''，0 和负数过得去 —— 记忆被静默删掉。
//   3) 清空聊天按「前缀+id」拼键，打不中三段键 memZeroRetry:<scope>:<id>。
//   4) 「完全还原」不清 memTidyBackup: —— 之后点「撤销上次整理」会毁掉还原结果。
//   5) 无角色时归档按钮 → IDBKeyRange.bound([null,…]) 抛错，裸 onclick 无 catch → 没反应。
//   6) 删记忆后「记忆健康」的条数不重算。
//   7) 后台记忆任务不挡破坏性操作 —— 删掉的角色又被写回记忆。
//   8) 重试计数表成功后【整表】清空 —— 同一趟里 0 产出的批次永远攒不到 3 次。
//
// 前两类既能断言源码、也能断言行为；后面几类以源码断言为主（行为要靠 IM 交互，
// 成本高且脆），外加一条最要紧的行为用例（直到期 <= 0 的记忆不许被静默删掉）。
import puppeteer from 'puppeteer-core';
import { seedChar } from './e2e-helper.mjs';
import http from 'http'; import fs from 'fs'; import path from 'path';
import { readCode } from './e2e-src.mjs';
const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');
const WWW = R + '/www';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8' };
const SRC = readCode(WWW + '/js/app.js');
let pass = 0, fail = 0;
const t = (n, ok, ex = '') => { if (ok) { pass++; console.log('  OK   ' + n); } else { fail++; console.log('  FAIL ' + n + (ex ? '  -> ' + ex : '')); } };

console.log('=== 1. 源码：这批修复都还在（改回去就红）===');
t('parseMemJson 对「非空数组却一条都用不了」抛错',
  SRC.includes('个元素里没有 text 字段'));
t('prune 对 untilDay <= 0 兜底跳过（保护库里已有的坏数据）',
  SRC.includes('if (!(m.untilDay >= 1)) continue;'));
t('编辑弹窗按【取整后】的值判 untilDay',
  SRC.includes('const expDay = isFinite(expRaw) ? Math.floor(expRaw) : NaN;'));
t('模型输出的 untilDay 也要 >= 1',
  SRC.includes('&& Number(x.untilDay) >= 1)'));
t('清空聊天改成扫尾缀（能删到三段键）',
  SRC.includes("k.endsWith(':' + id + ':real')"));
t('导入翻键改成逐段 remap（三段键也翻得对）',
  SRC.includes('逐段找 id') || SRC.includes('let changed = false;'));
t('完全还原会清 memTidyBackup:',
  SRC.includes("k.startsWith('memTidyBackup:')"));
t('归档按钮有无角色守卫',
  SRC.includes("if (!curCharId) { toast('还没有选择角色'); return; }"));
t('archivePreview 自身也有守卫（不只靠调用方）',
  SRC.includes("if (!curCharId) return { total: 0, kept: 0, archived: 0 };"));
t('删记忆后重算记忆健康',
  SRC.includes('await renderMem(); await renderMemHealth();'));
t('破坏性操作挡 _memBusy',
  SRC.includes('function destructiveBlocked(what)') && SRC.includes("destructiveBlocked('删角色')"));
t('重试计数不再整表清空（两处都只删自己那个签名）',
  SRC.includes('delete zrKeep[batchSig(batches[i])];') && SRC.includes('delete zrKeep[batchSig(chunk)];'));
t('迁移闸门在写入失败时不落下',
  SRC.includes('本次不落闸门，下次启动重试'));
t('导入记账只遍历备份里出现过的角色',
  SRC.includes('for (const rawCid of Object.keys(imported))'));
// ================= 行为用例 ================= 
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

// 假 API：流式请求（聊天）回一句正常回复；非流式（记忆总结 / 查重）回一个
// 【合法 JSON 数组、但元素没有 text 字段】—— 正是修 1 要拦的那种形状。
await page.setRequestInterception(true);
page.on('request', req => {
  const u = req.url();
  if (u.includes('/chat/completions')) {
    if (req.method() === 'OPTIONS') {
      req.respond({ status: 204, headers: { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Headers':'*', 'Access-Control-Allow-Methods':'*' } }); return;
    }
    const b = JSON.parse(req.postData() || '{}');
    if (b.stream) {
      const c = o => 'data: ' + JSON.stringify(o) + String.fromCharCode(10, 10);
      const payload = c({ choices: [{ delta: { content: '好。' } }] }) + 'data: [DONE]' + String.fromCharCode(10, 10);
      req.respond({ status: 200, headers: { 'Access-Control-Allow-Origin':'*' }, contentType: 'text/event-stream', body: payload }); return;
    }
    const bad = '[{"content":"字段名写错了"}]';
    req.respond({ status: 200, headers: { 'Access-Control-Allow-Origin':'*' }, contentType: 'application/json',
      body: JSON.stringify({ choices: [{ message: { content: bad } }] }) }); return;
  }
  req.continue();
});

await page.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'networkidle0', timeout: 40000 });
await sleep(1200);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil: 'networkidle0' }); await sleep(900);
// ⚠️ 两个坑（第一次写这套件时踩了，导致那条行为断言其实是假的）：
//   ① 角色 id 必须是下面用的那个 —— 只往 memories/messages 里写 charId:'va1'
//      而不建 id 为 va1 的角色，ensureChar 会回落到 allChars[0]，
//      pruneMemories 查的是【另一个角色】的记忆（空），压根碰不到种下的数据。
//   ② seedChar 给角色写的是 longMemory:false，而 effSettings 是【角色值优先】——
//      它会盖掉下面设的全局 true，于是 send() 的 finally 里那句
//      if (P && P.longMemory) runMemTasks(...) 根本不成立，记忆任务整条不跑。
//      所以 extra 里必须显式给 longMemory:true。
await seedChar(page, '紫', { greeting: '（开场）', id: 'va1', longMemory: true });

const CID = 'va1';
await page.evaluate(async (cid) => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const put = (st, rec) => new Promise(r => { const tx = db.transaction(st, 'readwrite'); tx.objectStore(st).put(rec); tx.oncomplete = r; });
  const rec = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get('settings'); q.onsuccess = () => r(q.result); });
  const v = Object.assign({}, (rec && rec.v) || {}, {
    apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com', longMemory: true,
    memSummarizeEvery: 50, memLimit: 20, clockDetail: false });
  await put('kv', { k: 'settings', v });
  await put('kv', { k: 'lastCharId', v: cid });
  await put('memories', { id: 'm1', charId: cid, text: '他喜欢美式', kind: 'fact', untilDay: null, untilHour: null, untilMinute: 0, freq: 'often', ts: Date.now() });
  await put('memories', { id: 'm2', charId: cid, text: '他老家在成都', kind: 'fact', untilDay: null, untilHour: null, untilMinute: 0, freq: 'once', ts: Date.now() });
  await put('memories', { id: 'm3', charId: cid, text: '他怕黑', kind: 'fact', untilDay: null, untilHour: null, untilMinute: 0, freq: 'once', ts: Date.now() });
  await put('memories', { id: 'mBAD', charId: cid, text: '这条限期是坏的（第 0 天）', kind: 'event',
    untilDay: 0, untilHour: null, untilMinute: 0, freq: 'once', ts: Date.now() });
  await put('kv', { k: 'memDeleted:' + cid, v: ['他其实不喝咖啡', '他换工作了', '他养了只猫'] });
  await put('kv', { k: 'memNeedTidy:' + cid, v: true });
  const base = Date.now() - 5 * 60000;
  for (let i = 0; i < 5; i++) {
    await put('messages', { id: 'vam' + i, charId: cid, role: i % 2 ? 'assistant' : 'user',
      content: (i % 2 ? '我' : '他') + '说了第' + i + '件事', story: null, ts: base + i * 60000 });
  }
  db.close();
}, CID);
await page.reload({ waitUntil: 'networkidle0' }); await sleep(1000);

const memIds = async () => page.evaluate(async (cid) => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const all = await new Promise(r => { const q = db.transaction('memories').objectStore('memories').getAll(); q.onsuccess = () => r(q.result); });
  db.close();
  return all.filter(m => m.charId === cid).map(m => m.id);
}, CID);
const before = await memIds();
console.log('   种下 ' + before.length + ' 条记忆: ' + JSON.stringify(before));

console.log('');
console.log('=== 2. 限期 <= 0 的记忆不许被静默删掉 ===');
// 发一条消息 → send 的 finally 跑 runMemTasks → pruneMemories（时效清理）。
// 剧情时间是第 1 天，nowMin = 1440；而 memExpireMin(untilDay 0) = 1439 ——
// 没有那道兜底的话 1440 > 1439 成立，这条记忆当场被删，用户看不到任何提示。
await page.evaluate(x => { const el = document.getElementById('input'); el.value = x; el.dispatchEvent(new Event('input', { bubbles: true })); }, '在吗');
await sleep(200);
await page.evaluate(() => document.getElementById('btn-send').click());
for (let i = 0; i < 60; i++) { await sleep(300); const busy = await page.$eval('#btn-stop', e => !e.classList.contains('hidden')).catch(() => false); if (!busy) break; }
await sleep(2500);
const after = await memIds();
console.log('   之后 ' + after.length + ' 条记忆: ' + JSON.stringify(after));
t('限期 0 的那条还在（兜底把它当没有限期，而不是早就过期）', after.includes('mBAD'), JSON.stringify(after));
t('3 条正常记忆都在，没被清空', ['m1','m2','m3'].every(id => after.includes(id)), JSON.stringify(after));

console.log('');
console.log('  JS 错误: ' + (errs.length ? JSON.stringify(errs.slice(0, 3)) : '无'));
t('无 JS 错误', errs.length === 0, errs.join(' | '));
console.log('');
console.log('========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
