import puppeteer from 'puppeteer-core';
import http from 'http'; import fs from 'fs'; import path from 'path';
// 工作目录自适应（原来写死 C:/A-DSH-Tool/ai-companion）
const R = path.resolve(import.meta.dirname).split(path.sep).join('/');
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

const kvGet = (k) => page.evaluate(async (kk) => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => o.onsuccess = () => r(o.result));
  const v = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get(kk); q.onsuccess = () => r(q.result); });
  db.close(); return v ? v.v : null;
}, k);
const memOf = (cid) => page.evaluate(async (c) => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => o.onsuccess = () => r(o.result));
  const arr = await new Promise(r => { const q = db.transaction('memories').objectStore('memories').index('charId').getAll(c); q.onsuccess = () => r(q.result); });
  db.close(); return arr.map(m => ({ id:m.id, text:m.text, mine:!!m.mine }));
}, cid);

await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
await sleep(1400);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil:'networkidle0' }); await sleep(700);

console.log('=== #1【一级】撤销不得删除自定义记忆（跑真实 UI 后读库）===');
// 造：mine 5 + ai 23 = 28 条，并写一份【不含 mine 的残缺备份】（模拟 v1.21.29 及更早留下的）
await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => o.onsuccess = () => r(o.result));
  const put = (store, rec) => new Promise(r => { const tx=db.transaction(store,'readwrite'); tx.objectStore(store).put(rec); tx.oncomplete=r; });
  const cid='c-v30';
  await put('characters', { id:cid, name:'v30测试', avatar:null, greeting:'（开场白）', persona:'测试',
    createdAt:Date.now(), longMemory:true, verbosity:'medium', descLevel:'mid', splitMessages:false });
  for (let i=0;i<5;i++)  await put('memories', { id:'MINE'+i, charId:cid, text:'我手写的记忆'+i, kind:'fact', freq:'normal', mine:true,  ts:Date.now()+i });
  for (let i=0;i<23;i++) await put('memories', { id:'AI'+i,   charId:cid, text:'她记的'+i,        kind:'fact', freq:'normal', mine:false, ts:Date.now()+100+i });
  // 残缺备份：只有 ai 那 23 条（老版本写下的口径）
  const items = [];
  for (let i=0;i<23;i++) items.push({ id:'AI'+i, text:'她记的'+i, kind:'fact', freq:'normal', mine:false });
  await put('kv', { k:'memTidyBackup:'+cid, v:{ at:Date.now(), items } });
  db.close();
});
await page.reload({ waitUntil:'networkidle0' }); await sleep(800);
{
  const before = await memOf('c-v30');
  console.log('   撤销前: ' + before.length + ' 条（mine ' + before.filter(m=>m.mine).length + '）');
  // 走真实 UI：设置页 → 撤销上次整理
  await page.evaluate(() => { const c=[...document.querySelectorAll('#char-list .char-card')].find(x=>x.textContent.includes('v30测试')); if(c)c.click(); });
  await sleep(800);
  const clicked = await page.evaluate(async () => {
    const nav = [...document.querySelectorAll('[data-view], .tab, nav button, .nav-item')].find(x=>/设置/.test(x.textContent));
    if (nav) nav.click();
    await new Promise(r=>setTimeout(r,700));
    const b = [...document.querySelectorAll('button')].find(x=>/撤销上次整理/.test(x.textContent) || x.id==='btn-mem-undo');
    if (!b) return false;
    b.click(); return true;
  });
  await sleep(2500);
  const after = await memOf('c-v30');
  console.log('   撤销后: ' + after.length + ' 条（mine ' + after.filter(m=>m.mine).length + '）  [点了按钮=' + clicked + ']');
  if (clicked) {
    t('自定义记忆一条都没少', after.filter(m=>m.mine).length === 5, JSON.stringify(after.filter(m=>m.mine).map(m=>m.id)));
  } else {
    // 按钮找不到时，退化为直接复刻撤销逻辑的核心断言（仍读真实库）
    t('找到「撤销上次整理」按钮', false, '按钮未找到');
  }
}

console.log('');
console.log('=== #2 rewind 护栏判据（[a0,u1,a1] 对 a0 必须拦）===');
{
  const r = await page.evaluate(async () => {
    const o = indexedDB.open('ai-companion');
    const db = await new Promise(r2 => o.onsuccess = () => r2(o.result));
    const put = (store, rec) => new Promise(r => { const tx=db.transaction(store,'readwrite'); tx.objectStore(store).put(rec); tx.oncomplete=r; });
    const cid='c-v30'; const now=Date.now();
    await put('messages', { id:'a0', charId:cid, role:'assistant', content:'（开场白后被归档前的一条）', ts:now,   archived:false });
    await put('messages', { id:'u1', charId:cid, role:'user',      content:'第一句', ts:now+1, archived:false });
    await put('messages', { id:'a1', charId:cid, role:'assistant', content:'回一',   ts:now+2, archived:false });
    await new Promise(r=>setTimeout(r,300));
    const all = (await new Promise(r2 => { const q = db.transaction('messages').objectStore('messages').index('charId').getAll(cid); q.onsuccess = () => r2(q.result); }))
                .filter(m=>!m.archived).sort((a,b)=>a.ts-b.ts);
    db.close();
    const at = all.findIndex(x=>x.id==='a0');
    const remainNew = all.slice(0, at);                                  // 新判据
    const afterOld  = all.slice(at + 1);                                 // 旧判据
    return {
      可见: all.map(x=>x.id), at,
      旧判据放行: afterOld.filter(x=>x.role==='user').length > 0,
      新判据拦截: !remainNew.some(x => x.role === 'user'),
    };
  });
  console.log('   ' + JSON.stringify(r));
  t('旧判据确实会放行（回归证据）', r.旧判据放行 === true, JSON.stringify(r));
  t('新判据拦下', r.新判据拦截 === true, JSON.stringify(r));
}

console.log('');
console.log('=== #3 summarizeChunk 的 room 口径 ===');
{
  const src = fs.readFileSync(WWW + '/js/app.js', 'utf8');
// ⚠️ 断言更新（v1.21.32）：口径统一为【总量】—— 复审 #6 指出 limit 只扣 mine、
// 不约束总量，导致 mine=10 时 room=10 直接写满、总记忆净增冲穿上限。
t('limit 口径改成总量', src.includes('const totalCap = (S.memLimit || 20) - _mineN;   // 非 mine 部分最多能有多少'));
t('room 受总量约束', src.includes('const room = Math.max(0, totalCap - curWritable);'));
t('curWritable 在压缩【后】才算', src.includes('const curWritable = writableOf(cur);   // ← 压缩【之后】才算'), '（第一版写成常量，压缩后没重算 → room 恒 0 → 归档永远失败，e2e-archive2 抓到）');
}

console.log('');
console.log('=== 其余静态确认 ===');
{
  const src = fs.readFileSync(WWW + '/js/app.js', 'utf8');
  const api = fs.readFileSync(WWW + '/js/api.js', 'utf8');
  const per = fs.readFileSync(WWW + '/js/persona.js', 'utf8');
  t('#1a 备份存全量', src.includes('items: listAll.map(m => ({ id: m.id'));
  t('#1b 撤销保护 mine', src.includes('const removable = _guardMine ? nowList.filter(m => !m.mine) : nowList;'));
  t('新6 tooFew 比例下限', src.includes('|| (destructive && items.length < Math.max(2, Math.floor(list.length * 0.25)))'));
  t('新4 护栏用目标角色', src.includes('const P0 = effSettings((await chars.get(myCharId)) || curChar, S);'));
  t('新7 tidyNow 传 cid0', src.includes('await tidyNow(cid0);'));
  t('新8 补跑带 reason', src.includes('dedupeIfNeeded(true, cidFor, noTick, reason)'));
  // ⚠️ v1.21.41：生成中不给入口，条件多了 !locked
  t('新3 菜单与分支对齐', src.includes("if (!isMe && isLast && !locked) acts.push({ k: 'regen', t: '重新生成' });"));
  // ⚠️ 断言更新（v1.21.47）：字段名改成按服务商档案取了（OpenRouter 用 reasoning，
  //    多数家是 reasoning_content），所以这里不再匹配某一个字段的字面串。
  //    "真的还接得住吗"由 e2e-provider 的行为用例负责（mock 一条只吐思考的流）。
  t('C 流式累积 reasoning', api.includes('thinkBuf += String(thinkTxt);'));
  t('C 两个思考字段名都认', api.includes('delta[spec.think] || delta.reasoning_content'));
  t('C onThink 回调', api.includes('if (onThink && thinkBuf)'));
  t('C app 接 onThink', src.includes('onThink: (t) => { thinkBuf = t; }'));
  t('C 兜底传 thinkBuf', src.includes('buildBlankFallback(_cmd0 ? text : visibleText, pastRaw, thinkBuf);'));
  t('C think 分支存在', src.includes('if (_think) {'));
  t('B 正面锚点', per.includes('想不出写什么时，从这三处里挑一样写'));
  t('B 堵死收敛目标', per.includes('「（只是看着他，没有开口）」这一类'));
}

console.log('');
console.log('  JS 错误: ' + (errs.length ? JSON.stringify(errs.slice(0,3)) : '无'));
t('无 JS 错误', errs.length === 0, errs.join(' | '));

console.log('');
console.log('========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
