import puppeteer from 'puppeteer-core';
import http from 'http'; import fs from 'fs'; import path from 'path';
import { readCode } from './e2e-src.mjs';
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
// ⚠️ 必须开 touch 仿真 —— 复审 #5 说得很清楚：合成 TouchEvent 复现不出原生行为，
// 必须让 Chrome 自己把它当触摸设备。
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = []; page.on('pageerror', e => errs.push(e.message));
page.on('dialog', async d => { await d.accept(); });
const sleep = ms => new Promise(r=>setTimeout(r,ms));
let pass=0, fail=0;
const t=(n,ok,ex='')=>{ if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));} };

let lastSys = '';
await page.setRequestInterception(true);
page.on('request', req => {
  const u = req.url();
  if (u.includes('deepseek') || u.includes('/chat/completions')) {
    if (req.method()==='OPTIONS') { req.respond({status:204,headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'*'}}); return; }
    const b = JSON.parse(req.postData()||'{}');
    lastSys = (b.messages||[]).map(m=>m.content||'').join('\n');
    if (b.stream) {
      const pl='data: '+JSON.stringify({choices:[{delta:{content:'好。'}}]})+String.fromCharCode(10,10)+'data: [DONE]'+String.fromCharCode(10,10);
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

await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
await sleep(1400);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil:'networkidle0' }); await sleep(700);

console.log('=== #5 滑杆防误触：必须用【真实触摸】验证（合成事件不算）===');
{
  // 进角色编辑页（那里有 e-temp 等滑杆）
  await page.evaluate(async () => {
    const o = indexedDB.open('ai-companion');
    const db = await new Promise(r => o.onsuccess = () => r(o.result));
    const put = (s, r2) => new Promise(r => { const tx = db.transaction(s,'readwrite'); tx.objectStore(s).put(r2); tx.oncomplete = r; });
    await put('characters', { id:'c-g', name:'滑杆测试', avatar:null, greeting:'x', persona:'x',
      createdAt:Date.now(), longMemory:false, temperature:1.0, verbosity:'medium', descLevel:'mid' });
    db.close();
  });
  await page.reload({ waitUntil:'networkidle0' }); await sleep(900);
  await page.evaluate(() => { const c=[...document.querySelectorAll('#char-list .char-card')].find(x=>x.textContent.includes('滑杆测试')); if(c)c.click(); });
  await sleep(500);
  await page.evaluate(() => { const b=document.querySelector('#char-list .char-card button[data-edit]') || document.querySelector('button[data-edit]'); if(b)b.click(); });
  await sleep(900);

  const box = await page.evaluate(() => {
    const el = document.getElementById('e-temp');
    if (!el) return null;
    el.scrollIntoView({ block:'center' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width/2, y: r.top + r.height/2, v: el.value };
  });
  if (!box) { t('找到温度滑杆', false); }
  else {
    const cdp = await page.target().createCDPSession();
    // 真实触摸：按下 → 竖向移动 → 抬起（正是"想滚页面"的手势）
    await cdp.send('Input.dispatchTouchEvent', { type:'touchStart', touchPoints:[{ x: box.x, y: box.y }] });
    await sleep(60);
    const afterStart = await page.$eval('#e-temp', e => e.value);
    for (const dy of [20, 45, 70, 95]) {
      await cdp.send('Input.dispatchTouchEvent', { type:'touchMove', touchPoints:[{ x: box.x + 2, y: box.y + dy }] });
      await sleep(40);
    }
    await cdp.send('Input.dispatchTouchEvent', { type:'touchEnd', touchPoints:[] });
    await sleep(250);
    const afterEnd = await page.$eval('#e-temp', e => e.value);
    console.log('   起始=' + box.v + ' touchstart 后=' + afterStart + ' 手势结束=' + afterEnd);
    // 判据：无论中途被原生改成什么，【结束时必须回到起始值】
    t('竖向滑动后滑杆值被还原', afterEnd === box.v, box.v + ' -> ' + afterEnd + '（touchstart 后曾为 ' + afterStart + '）');
  }
}

console.log('');
console.log('=== #4 detailDrive「跟随全局」不得被保存动作污染 ===');
{
  // 造：全局 = high，角色没设过 detailDrive
  await page.evaluate(async () => {
    const o = indexedDB.open('ai-companion');
    const db = await new Promise(r => o.onsuccess = () => r(o.result));
    const put = (s, r2) => new Promise(r => { const tx = db.transaction(s,'readwrite'); tx.objectStore(s).put(r2); tx.oncomplete = r; });
    const cur = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get('settings'); q.onsuccess = () => r(q.result); });
    const S = (cur && cur.v) || {};
    S.detailDrive = 'high';
    await put('kv', { k:'settings', v:S });
    // 角色上加一个名字，等下改它
    const c = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').get('c-g'); q.onsuccess = () => r(q.result); });
    c.name = '滑杆测试';
    delete c.detailDrive;   // ⚠️ 测试自身要保证"角色没设过"这个前提
    await put('characters', c);
    db.close();
  });
  // ⚠️ 必须 reload：allChars 是内存缓存，直接改库不会反映到编辑页。
  await page.reload({ waitUntil:'networkidle0' }); await sleep(1200);
  // ⚠️ 必须点【目标角色卡自己的】编辑按钮 —— 全局 querySelector 会点到第一个角色。
  await page.evaluate(() => {
    const card = [...document.querySelectorAll('#char-list .char-card')].find(x => x.textContent.includes('滑杆测试'));
    if (!card) return;
    const b = card.querySelector('button[data-edit]');
    if (b) b.click();
  });
  await sleep(1000);
  const dbg2 = await page.evaluate(() => ({
    editTitle: (document.getElementById('edit-title')||{}).textContent,
    name: (document.getElementById('e-name')||{}).value,
    brief: (document.getElementById('e-drive-brief')||{}).textContent,
  }));
  console.log('   [诊断-页面] ' + JSON.stringify(dbg2));
  const dbg = await page.evaluate(async () => {
    const o = indexedDB.open('ai-companion');
    const db = await new Promise(r => o.onsuccess = () => r(o.result));
    const all = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').getAll(); q.onsuccess = () => r(q.result); });
    db.close();
    const c = all.find(x => x.name && x.name.indexOf('滑杆测试') === 0);
    return { names: all.map(x=>x.name), hasKey: c ? ('detailDrive' in c) : null, val: c ? c.detailDrive : null };
  });
  console.log('   [诊断] ' + JSON.stringify(dbg));
  const shown = await page.$eval('#e-drive-brief', e => e.textContent.trim()).catch(()=>null);
  console.log('   编辑页显示: ' + JSON.stringify(shown));
  t('角色没设过时显示「跟随全局」', shown === '跟随全局', shown);
  // 只改名字就保存
  await page.evaluate(() => { const i=document.getElementById('e-name'); i.value = i.value + 'X'; });
  await page.evaluate(() => { const b=document.getElementById('btn-edit-save'); if(b) b.click(); });
  await sleep(1500);
  const saved = await page.evaluate(async () => {
    const o = indexedDB.open('ai-companion');
    const db = await new Promise(r => o.onsuccess = () => r(o.result));
    const c = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').get('c-g'); q.onsuccess = () => r(q.result); });
    db.close();
    return c ? ('detailDrive' in c ? c.detailDrive : '<absent>') : null;
  });
  console.log('   保存后 role.detailDrive = ' + JSON.stringify(saved));
  t('只改名字保存后【不写入】detailDrive', saved === '<absent>', String(saved));
}

console.log('');
console.log('=== #7 low 档下高驱动降级（prompt 不自相矛盾）===');
{
  const src = readCode(WWW + '/js/persona.js');
// ⚠️ 断言更新（v1.21.34）：降级范围从"只挡 high/max"放宽到"除 off/low 外全挡" ——
// 复审 新4 指出 mid 的「动作链 + 具体感受」同样是结构要求，与 low 的 8 字上限物理冲突。
// ⚠️ 断言更新（v1.21.36）：改用【显式字数映射】而不是硬编码 low 特例（复审 #6）。
t('有降级逻辑（按字数预算）', src.includes('DRIVE_CAP') && src.includes('DRIVE_NEED') && src.includes('capChars < (DRIVE_NEED[drive] || 0)'));
  t('降级到 low', src.includes("drive = 'low';"));
  t('有降级说明', src.includes('按最低档执行'));
  t('删掉了假的「不冲突」', !src.includes('上面那个长度上限照旧生效、不冲突'));
}

console.log('');
console.log('=== #1 regen 护栏 / #2 #3 #9 #10 #11 ===');
{
  const src = readCode(WWW + '/js/app.js');
  t('#1 regen 有删除范围护栏', src.includes('const remainForRegen = allNow.filter(x => !afterIds.includes(x.id));'));
  t('#1 无 user 时拒绝并提示', src.includes('这条前面没有能重发的消息了'));
  t('#2 判据用 wipe', src.includes('const scoped = !p.wipe && !p.wbAll;'));
  t('#2 报跳过数', src.includes('条世界书条目的角色本机没有，已跳过'));
  t('#3 导出带 charNames', src.includes('charNames: _chars.map(c => ({ id: c.id, name: c.name })),'));
  t('#3 导入认 charNames', src.includes('data.charNames'));
  t('#6 总量口径', src.includes('const totalCap = (S.memLimit || 20) - _mineN;'));
  t('#6 room 用 totalCap', src.includes('const room = Math.max(0, totalCap - curWritable);'));
  t('#9 记忆 live 校验', src.includes('条记忆的角色本机没有，已跳过'));
  t('#10 新建组带 order', src.includes('order: _maxOrder + 1 });'));
  t('#11 从常量派生（两处）', (src.split("...BACKUP_KV_PREFIXES, 'memTidyBackup:'").length - 1) === 2);
  t('#11 常量含 memArchiveLastAt', src.includes("'memArchiveLastAt:',"));
}

console.log('');
console.log('  JS 错误: ' + (errs.length ? JSON.stringify(errs.slice(0,3)) : '无'));
t('无 JS 错误', errs.length === 0, errs.join(' | '));

console.log('');
console.log('========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
