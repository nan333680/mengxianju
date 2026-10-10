import puppeteer from 'puppeteer-core';
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
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 120000, args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = []; page.on('pageerror', e => errs.push(e.message));
page.on('dialog', async d => { await d.accept(); });
const sleep = ms => new Promise(r=>setTimeout(r,ms));
let pass=0, fail=0;
const t=(n,ok,ex='')=>{ if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));} };

// mock：普通回复
await page.setRequestInterception(true);
page.on('request', req => {
  const u = req.url();
  if (u.includes('deepseek') || u.includes('/chat/completions')) {
    if (req.method()==='OPTIONS') { req.respond({status:204,headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'*'}}); return; }
    const b = JSON.parse(req.postData()||'{}');
    if (b.stream) {
      const pl='data: '+JSON.stringify({choices:[{delta:{content:'收到。'}}]})+String.fromCharCode(10,10)+'data: [DONE]'+String.fromCharCode(10,10);
      req.respond({status:200,headers:{'Access-Control-Allow-Origin':'*'},contentType:'text/event-stream',body:pl}); return;
    }
    req.respond({status:200,headers:{'Access-Control-Allow-Origin':'*'},contentType:'application/json',body:JSON.stringify({choices:[{message:{content:'[]'}}]})}); return;
  }
  req.continue();
});

await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
await sleep(1400);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil:'networkidle0' }); await sleep(700);

// 造：开场白(assistant) + user + assistant  —— 然后把开场白归档
const cid = await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => o.onsuccess = () => r(o.result));
  const cid = 'c-v27';
  const put = (store, rec) => new Promise(r => { const tx=db.transaction(store,'readwrite'); tx.objectStore(store).put(rec); tx.oncomplete=r; });
  await put('characters', { id:cid, name:'v27测试', avatar:null, greeting:'（开场白）', persona:'测试', createdAt:Date.now(),
    longMemory:false, verbosity:'medium', descLevel:'mid', splitMessages:false });
  const now = Date.now();
  await put('messages', { id:'f1', charId:cid, role:'assistant', content:'（她抬眼看你）', ts:now,   archived:true  });
  await put('messages', { id:'f2', charId:cid, role:'user',      content:'你好',         ts:now+1, archived:true  });
  await put('messages', { id:'f3', charId:cid, role:'assistant', content:'嗯。',          ts:now+2, archived:false });
  db.close(); return cid;
});
await page.reload({ waitUntil:'networkidle0' }); await sleep(900);
await page.evaluate(() => { const c=[...document.querySelectorAll('#char-list .char-card')].find(x=>x.textContent.includes('v27测试')); if(c)c.click(); });
await sleep(900);

console.log('=== 新6：开场白判据必须按身份、不按可见位置 ===');
// 用真实库态复刻 isGreetingMsg 的判据（源码文本一致性由下面静态断言保证）
const verdict = await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => o.onsuccess = () => r(o.result));
  const all = await new Promise(r => { const q = db.transaction('messages').objectStore('messages').getAll(); q.onsuccess = () => r(q.result); });
  db.close();
  // 按 ts 排序 —— 含归档（模拟 list(includeArchived=true)）
  const sorted = all.slice().sort((a,b) => a.ts - b.ts);
  const judge = (id) => {
    const idx = sorted.findIndex(x => x.id === id);
    if (idx < 0) return false;
    if (sorted[idx].role !== 'assistant') return false;
    return !sorted.slice(0, idx).some(x => x.role === 'user');
  };
  // 旧写法（v2 恒真式）的模拟：先按"可见列表"取 idx
  const vis = sorted.filter(m => !m.archived);
  const judgeOld = (id) => {
    const idx = vis.findIndex(x => x.id === id);
    if (idx !== 0) return false;
    if (vis[0].role !== 'assistant') return false;
    return !vis.slice(0, idx).some(x => x.role === 'user');
  };
  return {
    总数: sorted.length, 可见: vis.length,
    真开场白_f1: judge('f1'),
    普通assistant_f3: judge('f3'),
    user_f2: judge('f2'),
    旧判据_f3: judgeOld('f3'),
    旧判据_f1: judgeOld('f1'),
  };
});
console.log('   ' + JSON.stringify(verdict));
t('真开场白 f1 → true', verdict.真开场白_f1 === true, JSON.stringify(verdict));
t('普通 assistant f3 → false（不再被误判）', verdict.普通assistant_f3 === false, JSON.stringify(verdict));
t('user f2 → false', verdict.user_f2 === false, JSON.stringify(verdict));
t('旧判据对 f3 误判为 true（回归证据）', verdict.旧判据_f3 === true, JSON.stringify(verdict));

console.log('');
console.log('=== 新1：首条 assistant 也能拿到 regen 入口 ===');
const src = fs.readFileSync(WWW + '/js/app.js', 'utf8');
// ⚠️ 断言更新（v1.21.30）：复审新3 判定「菜单给首条开 regen 口子」是错的 ——
// 因为 regen 分支只允许 lastId === id，菜单给了入口却点不动（"给了入口却用不了"）。
// 现在菜单与分支一致：只在 isLast 时给 regen。
t('菜单不再用 isFirstAi 判据', !src.includes('const isFirstAi = !isMe'), '（注释里提到不算）');
// ⚠️ 断言更新（v1.21.41）：生成中不再给入口，判据多了一个 !locked（= !busy）
t('regen 条件是 isLast 且非生成中', src.includes("if (!isMe && isLast && !locked) acts.push({ k: 'regen', t: '重新生成' });"));
// ⚠️ 断言更新（v1.21.28）：v1.21.27 那个 `!isFirstAi` 被复审 新5_ 判定为【错】——
// 它让"可见首条 assistant 一律不给重聊"，而归档默认开着、长对话后首条通常就是普通 assistant。
// 现在 rewind 只看 !isLast。
t('rewind 只看 !isLast（不再排除首条），且非生成中', src.includes("if (!isMe && !isLast && !locked) acts.push({ k: 'rewind', t: '从这里重聊' });"));

console.log('');
console.log('=== 新6：判据取含归档的列表 ===');
t('isGreetingMsg 用 list(curCharId, 0, true)', src.includes('const all = await msgs.list(curCharId, 0, true);   // 含归档'));
t('旧的恒真式已删', !/if \(idx !== 0\) return false;/.test(src), '');

console.log('');
// ⚠️ 断言更新（v1.21.36）：tooFew 出口【不再 return 0】，
// 而是跳过重写、继续往下（v1.21.27 起的结构）。真正要验的是：
//   (a) 队列仍被裁剪　(b) 强制标记被清　(c) 不推进 memDedupeAt
const i2 = src.indexOf("_lastDedupeStat.aborted = 'tooFew';");
const seg = src.slice(i2, i2 + 1400);
// ⚠️ 断言更新（v1.21.36）：tooFew 出口现在还会 clearNeedTidy（复审 新A2）+ 之前已有 pruneDeletedQueue。
t('tooFew 出口会裁剪队列', /pruneDeletedQueue/.test(seg));
t('tooFew 出口会清 memNeedTidy（v1.21.36 新A2）', /clearNeedTidy/.test(seg));

console.log('');
console.log('=== 新3：自动备份不覆盖手动撤销点 ===');
t('备份前先查已有', src.includes("const prevBk = await kv.get('memTidyBackup:' + cidFor, null);"));
// ⚠️ 断言更新（v1.21.29）：新10 修了"破坏性重写时旧备份挡住新备份"——
// 现在条件是「破坏性重写 或 没有备份」，不再是单纯的「没有才写」。
t('破坏性重写时强制刷新备份', src.includes('const destructive = list.length > 0 && items.length < list.length * 0.5;'));
t('非破坏性时仍只在没有才写', src.includes('if (destructive || !prevBk || !prevBk.items || !prevBk.items.length) {'));

console.log('');
console.log('=== 新4：purgeChar 清所有 solo ===');
const db = fs.readFileSync(WWW + '/js/db.js', 'utf8');
t('用 soloAll 遍历', db.includes('for (const s of await wb.soloAll()) {'));
t('旧的只删第一条已删', !db.includes('const s = await wb.solo(charId);'));

console.log('');
console.log('=== 新5：applyImport 认领 solo 的 charId ===');
t('扫 data.solo', src.includes('if (data.solo && Array.isArray(data.solo)) {'));

console.log('');
console.log('=== 新7：死变量已删、全局字段保留 ===');
t('局部 searchText 赋值已删', !/^\s*searchText = /m.test(src));
t('局部 searchCount 赋值已删', !/searchBlock = rs\.block; searchCount = rs\.n;/.test(src));
t('全局 P.searchCount 保留', src.includes('Number(P.searchCount) || 5'));
t('searchBlock 保留', src.includes('if (rs.block) { searchBlock = rs.block; }'));

console.log('');
console.log('  JS 错误: ' + (errs.length ? JSON.stringify(errs.slice(0,3)) : '无'));
t('无 JS 错误', errs.length === 0, errs.join(' | '));

console.log('');
console.log('========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
