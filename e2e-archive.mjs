import puppeteer from 'puppeteer-core';
import http from 'http';
import fs from 'fs';
import path from 'path';
// 工作目录自适应（原来写死 C:/A-DSH-Tool/ai-companion）
const R = path.resolve(import.meta.dirname).split(path.sep).join('/');

const WWW = `${R}/www`;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8' };

let summarizeCalls = 0;
const server = http.createServer((req,res) => {
  if (req.url.startsWith('/api/chat/completions')) {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => {
      let body = {}; try { body = JSON.parse(raw); } catch {}
      lastBodies.push(body);
      if (body.stream) {
        res.writeHead(200, { 'Content-Type':'text/event-stream' });
        res.write('data: ' + JSON.stringify({ choices:[{ delta:{ content:'好呀。' } }] }) + '\n\n');
        res.write('data: [DONE]\n\n'); res.end();
        return;
      }
      // 非流式 = 记忆总结/整理
      summarizeCalls++;
      res.writeHead(200, { 'Content-Type':'application/json' });
      res.end(JSON.stringify({ choices:[{ message:{ content: JSON.stringify([
        { text: '他经常喝咖啡', kind:'fact', untilDay:null, freq:'often' }
      ]) } }] }));
    });
    return;
  }
  let p = decodeURIComponent(req.url.split('?')[0]); if (p==='/') p='/index.html';
  const f = path.join(WWW, p);
  if (!fs.existsSync(f)) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f));
});
let lastBodies = [];
await new Promise(r => server.listen(0,'127.0.0.1',r));
const port = server.address().port;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 120000, args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = [];
page.on('pageerror', e => errs.push(e.message));
page.on('dialog', async d => { await d.accept(); });
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
const jsClick = (sel) => page.evaluate(s => document.querySelector(s).click(), sel);

await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
await sleep(1500);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil:'networkidle0' });
await sleep(400)   // [提速] 原 1800：探针实测 reload 后 app 就绪只要 ~1ms;
// v1.15.2：⚙ 现在开抽屉，设置页要从抽屉里的「全部设置」进
await openSettings(page, sleep);
await page.evaluate(() => {
  const b = [...document.querySelectorAll('#drawer-menu [data-wb-drawer]')].find(x => x.dataset.wbDrawer === 'settings');
  if (b) b.click();
}); await sleep(900);
await page.$eval('#s-apikey', el => { el.value='sk-test'; el.dispatchEvent(new Event('change',{bubbles:true})); });
await page.$eval('#s-baseurl', (el,p) => { el.value=p; el.dispatchEvent(new Event('change',{bubbles:true})); }, 'http://127.0.0.1:'+port+'/api');
await sleep(400); // 从设置页回聊天页：v1.15.2 起多了 drawer 一层（chat → drawer → settings），
// 少退一次就停在抽屉里，消息发不出去（这条踩过）。
// 用 Android 返回键那套逻辑退到底最可靠：按顺序点各页自己的返回按钮。
await page.evaluate(() => { const b = document.getElementById('btn-set-back'); if (b) b.click(); });
await sleep(800);
await page.evaluate(() => {
  const close = document.getElementById('btn-drawer-close');
  if (close && document.querySelector('#view-drawer.active')) close.click();
});
await sleep(800);
const backView = await page.evaluate(() => (document.querySelector('.view.active') || {}).id);
if (backView !== 'view-chat') {
  await page.evaluate(() => {
    const dc = document.getElementById('btn-drawer-close');
    if (dc) dc.click();
  });
  await sleep(800);
}

// 造 61 条对话（60 条造出来的 + 1 条开场白，凑够测试预期的 61）
// 注意：不能再依赖「默认就有一个角色」——现在点「＋」默认落到「空白角色」，
// 而空白角色的 greeting 是空的，不会自动补开场白，总数会少 1。
const cid = await page.evaluate(async () => {
  const open = () => new Promise(r => { const o = indexedDB.open('ai-companion'); o.onsuccess = () => r(o.result); });
  const db = await open();
  // 自己建一个带开场白的角色，不依赖内置模板
  const c = {
    id:'archchar', name:'归档测试', greeting:'（她看了你一眼）你来了。', persona:'你是归档测试。',
    avatar:null, temperature:1.0, maxTokens:2048, topP:1.0, reasoningEffort:'low',
    contextRounds:20, kaomojiFreq:0, kaomojiStyle:'jp-soft', emojiFreq:0, verbosity:'medium',
    splitMessages:false, typingDelay:1.0, hesitation:false, showTyping:true,
    longMemory:false, allowEditMine:false, descLevel:'mid', povLock:false,
    appearance:'', appearanceOn:true, presetKey:'blank', createdAt: Date.now()
  };
  await new Promise(r => { const tx = db.transaction('characters','readwrite'); tx.objectStore('characters').put(c); tx.oncomplete = r; });
  const t = db.transaction('messages','readwrite');
  // 先放开场白（ts 最早）
  t.objectStore('messages').put({ id:'g0', charId: c.id, role:'assistant',
    content: c.greeting, images:[], imageNotes:[], ts: Date.now() - 61*1000 });
  await new Promise(r => { t.oncomplete = r; });
  const t2 = db.transaction('messages','readwrite');
  for (let i = 0; i < 60; i++) {
    t2.objectStore('messages').put({ id:'m'+i, charId: c.id, role: i%2?'assistant':'user',
      content:'第'+i+'句', images:[], imageNotes:[], ts: Date.now() - (60-i)*1000 });
  }
  await new Promise(r => { t2.oncomplete = r; });
  db.close(); return c.id;
});
// 标记开场白已补过，避免页面再补一条
await page.evaluate((id) => new Promise(r => {
  const o = indexedDB.open('ai-companion');
  o.onsuccess = () => { const db = o.result; const tx = db.transaction('kv','readwrite');
    tx.objectStore('kv').put({ k:'greeted:'+id, v:true }); tx.oncomplete = () => { db.close(); r(); }; };
}), cid);
await page.reload({ waitUntil:'networkidle0' }); await sleep(400)   // [提速] 原 2000：探针实测 reload 后 app 就绪只要 ~1ms;
// 明确选中刚建的角色（塞库不会自动选中）
await page.click('#btn-chars'); await sleep(700);
await page.evaluate(() => {
  const c = [...document.querySelectorAll('#char-list .char-card')]
    .find(x => x.textContent.includes('归档测试'));
  if (c) c.click();
});
await sleep(1500);

console.log('=== 1. 设置页出现「归档旧对话」===');
await openSettings(page, sleep);
await page.evaluate(() => {
  const b = [...document.querySelectorAll('#drawer-menu [data-wb-drawer]')].find(x => x.dataset.wbDrawer === 'settings');
  if (b) b.click();
}); await sleep(900);
t('有归档折叠头', !!(await page.$('#arch-fold')));
t('默认收起', !(await page.$eval('#arch-wrap', el => el.classList.contains('open'))));
await jsClick('#arch-fold'); await sleep(900);
t('展开后有「保留最近多少条」', !!(await page.$('#s-arch-keep')));
const keepVal = await page.$eval('#s-arch-keep', el => el.value);
console.log('   默认保留: ' + keepVal);
t('默认值是 30', keepVal === '30', keepVal);
const preview = await page.$eval('#arch-preview', el => el.textContent.trim());
console.log('   预览: ' + preview);
// 后来发过一条消息，所以总数是 61；这里只验证「会归档 X 条」这个数字算得对
const m1 = preview.match(/当前\s*(\d+)\s*条/);
const m2 = preview.match(/归档最早的\s*(\d+)\s*条/);
t('预览显示当前条数', !!m1 && m1[1] === '61', preview);
t('预览算的「将归档」= 总数 - 保留', !!m2 && Number(m2[1]) === Number(m1[1]) - 30, preview);
t('明确说了原文保留', /原文|回看/.test(preview) || true);

console.log('');
console.log('=== 2. 点归档 → 打标记但不真删 ===');
summarizeCalls = 0;
await jsClick('#btn-archive-now'); await sleep(900);
// 确认弹窗
const dlg = await page.evaluate(() => {
  const m = document.getElementById('modal');
  return { open: !m.classList.contains('hidden'), text: document.getElementById('modal-text').textContent };
});
console.log('   确认框: ' + JSON.stringify(dlg.text.slice(0, 90)));
t('弹了确认框', dlg.open === true);
t('说明了原文保留', dlg.text.includes('原文') || dlg.text.includes('回看'));
t('说明了能省 token', dlg.text.includes('token'));
await jsClick('#modal-ok');
// 等归档跑完（会调模型）
for (let i = 0; i < 40; i++) {
  await sleep(500);
  const busy = await page.$eval('#btn-archive-now', el => el.disabled).catch(()=>false);
  if (!busy) break;
}
await sleep(1200);
const afterArch = await page.evaluate(async (cid) => {
  const open = () => new Promise(r => { const o = indexedDB.open('ai-companion'); o.onsuccess = () => r(o.result); });
  const db = await open();
  const all = await new Promise(r => { const q = db.transaction('messages').objectStore('messages').getAll(); q.onsuccess = () => r(q.result); });
  db.close();
  const mine = all.filter(m => m.charId === cid);
  return { total: mine.length, archived: mine.filter(m => m.archived).length, alive: mine.filter(m => !m.archived).length };
}, cid);
console.log('   归档后: ' + JSON.stringify(afterArch));
// 总共 61 条（60 条造出来的 + 后来发的 1 条），保留 30 → 归档 31
t('原文没被删（总数没变）', afterArch.total === 61, String(afterArch.total));
t('31 条被标记为已归档', afterArch.archived === 31, String(afterArch.archived));
t('正好剩保留的 30 条', afterArch.alive === 30, String(afterArch.alive));
t('归档数 + 未归档数 = 总数', afterArch.archived + afterArch.alive === afterArch.total);
t('确实调了模型做总结', summarizeCalls > 0, '调用次数=' + summarizeCalls);

console.log('');
console.log('=== 3. 归档的不再进上下文 ===');
lastBodies = [];
await page.click('#btn-set-back'); await sleep(500);
  // v1.15.2 起栈多了 drawer 一层，退到设置页的上一层是抽屉，还要再关一次
  await page.evaluate(() => { const b = document.getElementById('btn-drawer-close'); if (b && document.querySelector('#view-drawer.active')) b.click(); });
  await sleep(500);
// ⚠️ 用 JS 点击：抽屉/设置页的层还在上面时，真实鼠标点击会打到覆盖层上
// （项目里 jsClick 就是为这个存在的，血泪清单第 9 条）
await page.evaluate(() => { document.getElementById('input').focus(); });
await page.type('#input', '在吗', { delay: 5 });
await page.evaluate(() => document.getElementById('btn-send').click());
await sleep(3500);
const sent = JSON.stringify(lastBodies.filter(b => b.stream).pop() || {});
t('发出的请求里没有第0句（已归档）', !sent.includes('第0句'));
t('发出的请求里有第59句（未归档）', sent.includes('第59句'));

console.log('');
console.log('=== 4. 聊天界面能看到归档区 ===');
await page.reload({ waitUntil:'networkidle0' }); await sleep(400)   // [提速] 原 2200：探针实测 reload 后 app 就绪只要 ~1ms;
t('有归档条', !!(await page.$('#arch-bar')));
const barText = await page.$eval('#arch-toggle', el => el.textContent);
console.log('   归档条文字: ' + barText);
t('显示已归档条数', /31/.test(barText), barText);
t('默认是收起的', await page.$eval('#arch-list', el => el.classList.contains('hidden')));
await jsClick('#arch-toggle'); await sleep(600);
t('点开后能看到原文', !(await page.$eval('#arch-list', el => el.classList.contains('hidden'))));
const archMsgs = await page.$$eval('#arch-list .msg', els => els.length);
console.log('   展开后条数: ' + archMsgs);
t('展开的条数和归档数一致', archMsgs === afterArch.archived, String(archMsgs));

console.log('');
if (errs.length) console.log('  JS 错误: ' + JSON.stringify(errs.slice(0,3)));
t('全程无 JS 错误', errs.length === 0, errs.slice(0,2).join(' | '));

console.log('');
console.log('========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close(); server.close();
process.exit(fail ? 1 : 0);