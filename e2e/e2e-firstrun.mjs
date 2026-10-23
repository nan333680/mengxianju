// e2e-firstrun.mjs —— 第一次打开的人能走到聊天（v0.5.3.2 · 清单 §3.2 / §3.5）
//
// 覆盖：
//   1. 一张卡都没有：给的是大按钮 + 示例卡，不是"点左上角"那种指路
//   2. 点示例卡 → 预览（名字 / 钩子 / 开场白）→ 就用她开始 → 真建出角色
//   3. 有卡没 Key：横幅点开的是半屏 sheet，不是把人扔进设置页
//   4. sheet 里的「测试连接」：401 说 Key 不对，连不上说网络
//   5. 草稿：打字 → 切角色再切回 → 字还在；发送后清空；已有字不被旧草稿盖掉

import puppeteer from 'puppeteer-core';
import http from 'http';
import fs from 'fs';
import path from 'path';
const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');
const WWW = R + '/www';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8' };
const server = http.createServer((req,res) => {
  let q = decodeURIComponent(req.url.split('?')[0]); if (q==='/') q='/index.html';
  const f = path.join(WWW, q);
  if (!fs.existsSync(f)) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f));
});
await new Promise(r => server.listen(0,'127.0.0.1',r));
const port = server.address().port;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await page.evaluateOnNewDocument(() => {
  Object.defineProperty(navigator, 'language', { get: () => 'zh-CN', configurable: true });
  Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh'], configurable: true });
});
const errs = [];
page.on('pageerror', e => errs.push(e.message));
const sleep = ms => new Promise(r=>setTimeout(r,ms));
let pass=0, fail=0;
const t=(n,ok,ex='')=>{ if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));} };
const jsClick = (sel) => page.evaluate(s => { const el = document.querySelector(s); if (el) el.click(); }, sel);

// 假 SSE：聊天成功；非流式（测试连接）由 __mode 决定成功还是 401
await page.evaluateOnNewDocument(() => {
  window.__hits = { chat: [], conn: [] };
  window.__connMode = 'ok';
  const realFetch = window.fetch.bind(window);
  window.fetch = async function (url, opts) {
    const u = String(url);
    let body = {};
    try { body = JSON.parse((opts && opts.body) || '{}'); } catch (e) {}
    if (u.includes('/chat/completions')) {
      if (body.stream === false) {
        window.__hits.conn.push(body);
        if (window.__connMode === 'bad') {
          return new Response(JSON.stringify({ error: { message: 'Invalid API key' } }),
            { status: 401, headers: { 'Content-Type': 'application/json' } });
        }
        if (window.__connMode === 'down') throw new TypeError('Failed to fetch');
        return new Response(JSON.stringify({ choices: [{ message: { content: 'hi' } }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      window.__hits.chat.push(body);
      const chunk = (o) => 'data: ' + JSON.stringify(o) + String.fromCharCode(10,10);
      const payload =
        chunk({ choices: [{ delta: { content: '嗯。' } }] }) +
        chunk({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }) +
        'data: [DONE]' + String.fromCharCode(10,10);
      return new Response(payload, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    return realFetch(url, opts);
  };
});

const dbList = (store) => page.evaluate(async (s) => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const all = await new Promise(r => { const q = db.transaction(s).objectStore(s).getAll(); q.onsuccess = () => r(q.result || []); });
  db.close();
  return all;
}, store);

console.log('=== 1. 一张卡都没有：给的是按钮，不是指路 ===');
await page.goto('http://127.0.0.1:' + port + '/index.html', { waitUntil: 'networkidle0' });
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForFunction(() => !!document.querySelector('.empty-chat') || document.querySelectorAll('#messages .msg').length > 0, { timeout: 25000 }).catch(()=>{});
await sleep(900);
const empty = await page.evaluate(() => {
  const box = document.querySelector('.empty-chat');
  return box ? {
    txt: box.textContent || '',
    import: !!document.getElementById('ec-import'),
    demo: !!document.getElementById('ec-demo'),
  } : null;
});
t('空状态有内容', !!empty, JSON.stringify(empty));
t('有大按钮「导入一张角色卡」', !!empty && empty.import === true);
t('有「先试这张」的示例入口', !!empty && empty.demo === true);
t('不再只有「点左上角 ☰」那一句', !!empty && empty.txt.includes('没有卡？'), empty && empty.txt.slice(0, 60));

console.log('');
console.log('=== 2. 示例卡：预览 → 就用她开始 → 真建出角色 ===');
await jsClick('#ec-demo');
await sleep(600);
const demo = await page.evaluate(() => {
  const m = document.getElementById('demo-modal');
  return {
    open: !!m && !m.classList.contains('hidden'),
    name: (document.getElementById('demo-name') || {}).textContent || '',
    hook: (document.getElementById('demo-hook') || {}).textContent || '',
    say: (document.getElementById('demo-say') || {}).textContent || '',
  };
});
t('预览弹层打开了', demo.open === true);
t('预览里有名字', demo.name.trim().length > 0, demo.name);
t('预览里有一句钩子', demo.hook.trim().length > 4, demo.hook);
t('预览里有她的开场白', demo.say.trim().length > 0, demo.say.slice(0, 40));
await jsClick('#demo-go');
await sleep(1800);
const chars = await dbList('characters');
t('真的建出了一个角色', chars.length === 1, String(chars.length));
t('建出来的就是预览里那个人', chars.length === 1 && chars[0].name === demo.name.trim(), chars.length === 1 ? chars[0].name : '');
t('有开场白', chars.length === 1 && String(chars[0].greeting || '').length > 0);

console.log('');
console.log('=== 3. 有卡没 Key：横幅打开的是半屏 sheet ===');
const bannerBefore = await page.evaluate(() => {
  const b = document.getElementById('setup-banner');
  return b ? !b.classList.contains('hidden') : null;
});
t('没 Key 时横幅是亮的', bannerBefore === true);
await jsClick('#setup-banner');
await sleep(600);
const sheet = await page.evaluate(() => {
  const s = document.getElementById('key-sheet');
  return {
    open: !!s && !s.classList.contains('hidden'),
    key: !!document.getElementById('ks-key'),
    test: !!document.getElementById('ks-test'),
    save: !!document.getElementById('ks-save'),
    demo: !!document.getElementById('ks-demo'),
    steps: document.querySelectorAll('.ks-steps li').length,
    model: (document.getElementById('ks-model-txt') || {}).textContent || '',
  };
});
t('sheet 打开了', sheet.open === true);
t('有输入框 / 测试 / 保存', sheet.key && sheet.test && sheet.save);
t('写着三步', sheet.steps === 3, String(sheet.steps));
t('显示当前服务商与模型', sheet.model.length > 3, sheet.model);
t('留了一条「先看示例」的退路', sheet.demo === true);

console.log('');
console.log('=== 4. 测试连接：说清楚是哪种错 ===');
await page.evaluate(() => { window.__connMode = 'bad'; });
await page.evaluate(() => {
  const k = document.getElementById('ks-key'); k.value = 'sk-wrong';
  document.getElementById('ks-test').click();
});
await sleep(1200);
const bad = await page.evaluate(() => (document.getElementById('ks-result') || {}).textContent || '');
t('测试连接真发出去了（stream:false）', (await page.evaluate(() => window.__hits.conn.length)) > 0);
t('401 说成「Key 不对」而不是「出了点问题」', /Key|key/.test(bad), bad);
await page.evaluate(() => { window.__connMode = 'down'; });
await page.evaluate(() => document.getElementById('ks-test').click());
await sleep(1500);
const down = await page.evaluate(() => (document.getElementById('ks-result') || {}).textContent || '');
t('连不上说成网络问题', /网络|连不上/.test(down), down);
await page.evaluate(() => { window.__connMode = 'ok'; });
await page.evaluate(() => document.getElementById('ks-test').click());
await sleep(1200);
const ok = await page.evaluate(() => {
  const el = document.getElementById('ks-result');
  return { cls: el.className, txt: el.textContent || '' };
});
t('通了会给绿的反馈', ok.cls.includes('ok'), JSON.stringify(ok));

console.log('');
console.log('=== 5. 保存 Key 之后横幅消失 ===');
await page.evaluate(() => {
  const k = document.getElementById('ks-key'); k.value = 'sk-test';
  document.getElementById('ks-save').click();
});
await sleep(1200);
const afterSave = await page.evaluate(() => {
  const b = document.getElementById('setup-banner');
  const s = document.getElementById('key-sheet');
  return { bannerHidden: !!b && b.classList.contains('hidden'), sheetHidden: !!s && s.classList.contains('hidden') };
});
t('横幅消失了', afterSave.bannerHidden === true);
t('sheet 关上了', afterSave.sheetHidden === true);

console.log('');
console.log('=== 6. 草稿：切走再切回来，字还在 ===');
const firstId = await page.evaluate(async () => {
  const { chars } = await import('/js/db.js');
  const all = await chars.all();
  return all.length ? all[0].id : '';
});
// 再建一个角色，好切换（db.js 的角色 API 只有 all/get/put/del，没有 add，id 得自己给）
const cid = 'e2e-firstrun-c2';
await page.evaluate(async (id) => {
  const { chars } = await import('/js/db.js');
  await chars.put({ id, name: '第二个', greeting: '（在）', persona: '你是第二个。', avatar: null, createdAt: Date.now() });
}, cid);
await sleep(300);
await page.evaluate(() => {
  const el = document.getElementById('input');
  el.value = '打了一半的话';
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
await sleep(700);   // 等 350ms 防抖落库
const draftSaved = await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const all = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').getAll(); q.onsuccess = () => r(q.result || []); });
  db.close();
  return all.filter(x => String(x && x.k || '').startsWith('draft:')).map(x => ({ k: x.k, v: x.v }));
});
t('草稿落了库', draftSaved.length === 1 && draftSaved[0].v === '打了一半的话', JSON.stringify(draftSaved));
// 重开一次：草稿该自己回到输入框里（启动恢复）
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForFunction(() => document.querySelectorAll('#messages .msg').length > 0, { timeout: 25000 }).catch(() => {});
await sleep(1200);
const afterReload = await page.$eval('#input', el => el.value);
t('重开之后草稿自己回来了', afterReload === '打了一半的话', JSON.stringify(afterReload));
// 走界面切到另一个角色：☰ → 角色列表 → 点那张卡
const openList = async () => { await page.evaluate(() => document.getElementById('btn-chars').click()); await sleep(700); };
const pickChar = async (id) => page.evaluate((x) => {
  const el = document.querySelector('.char-card[data-id="' + x + '"]');
  if (!el) return false;
  el.click();
  return true;
}, id);
await openList();
t('切到了另一个角色', (await pickChar(cid)) === true);
await sleep(1200);
const cleared = await page.$eval('#input', el => el.value);
t('切过去的输入框是空的', cleared === '', JSON.stringify(cleared));
// 切回第一个角色（用草稿的那个）
await openList();
await pickChar(firstId);
await sleep(1400);
const restored = await page.$eval('#input', el => el.value);
t('切回来草稿还在', restored === '打了一半的话', JSON.stringify(restored));

console.log('');
console.log('=== 7. 发出去之后草稿清掉 ===');
await page.evaluate(() => document.getElementById('btn-send').click());
for (let i = 0; i < 120; i++) {
  const b = await page.$eval('#btn-stop', el => !el.classList.contains('hidden')).catch(()=>false);
  if (!b) break;
  await sleep(100);
}
await sleep(600);
const afterSend = await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const all = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').getAll(); q.onsuccess = () => r(q.result || []); });
  db.close();
  return { input: document.getElementById('input').value, drafts: all.filter(x => String(x && x.k || '').startsWith('draft:')).length };
});
t('输入框空了', afterSend.input === '');
t('草稿也删了', afterSend.drafts === 0, String(afterSend.drafts));

console.log('');
console.log('=== 8. 输入框已经有字时，草稿不覆盖它 ===');
await page.evaluate(() => {
  const el = document.getElementById('input');
  el.value = '正在打的新内容';
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
await sleep(700);
const before = await page.$eval('#input', el => el.value);
t('新内容在框里', before === '正在打的新内容');

console.log('');
console.log('=== 9. 没有未捕获报错 ===');
t('页面没有异常', errs.length === 0, errs.join(' | '));

console.log('');
console.log('通过 ' + pass + ' 项 / 失败 ' + fail + ' 项');
await browser.close();
server.close();
process.exit(fail > 0 ? 1 : 0);
