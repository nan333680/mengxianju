import puppeteer from 'puppeteer-core';
import http from 'http'; import fs from 'fs'; import path from 'path';
// www/js/app.js send() 的 AbortError 分支（0.5.4 修的一个真 bug）单测：
//   用户在她还没吐出任何字时点停止 → 那条 user 消息必须【还活着】：
//   长按有菜单、下一次重绘不消失、下一条消息以它为父（不是和它并排成兄弟）。
// 起因（用户 m06455）：停止后长按无菜单；再发一条它从屏幕消失；
//   重新编辑之后又冒出来，变成「我连发了两条」。
// 根因：AbortError 且一个字都没收到时，catch 里 umSaved 那段的判据排除了 AbortError，
//   leaf 还停在上一轮那条 assistant 上 → 这条 user 消息成了 activePath 走不到的旁支。
const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');
const WWW = R + '/www';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const NL = String.fromCharCode(10);
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8', '.png':'image/png', '.svg':'image/svg+xml', '.woff2':'font/woff2', '.ico':'image/x-icon' };
const server = http.createServer((req,res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = path.join(WWW, p);
  if (!fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store, no-cache, must-revalidate' });
  res.end(fs.readFileSync(f));
});
await new Promise(r => server.listen(0,'127.0.0.1',r));
const port = server.address().port;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 120000, args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await page.setCacheEnabled(false);
// CI（en-US）上也会跑：界面语言必须钉住（tools/ci-precheck.mjs 会查这一条）
await page.evaluateOnNewDocument(() => { Object.defineProperty(navigator, 'language', { get: () => 'zh-CN' }); });
const errs = []; page.on('pageerror', e => errs.push(e.message));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const t = (n, ok, ex='') => { if (ok) { pass++; console.log('  OK   ' + n); } else { fail++; console.log('  FAIL ' + n + (ex ? '  -> ' + ex : '')); } };

// ---- mock：第一次流式请求【一个 chunk 都不发】，等着用户点停止 ----
let streamReq = 0;
const sse = (txt) => 'data: ' + JSON.stringify({ choices: [{ delta: { content: txt } }] }) + NL + NL + 'data: [DONE]' + NL + NL;
await page.setRequestInterception(true);
page.on('request', req => {
  const u = req.url();
  if (u.includes('/chat/completions')) {
    if (req.method() === 'OPTIONS') { try { req.respond({ status:204, headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'*'} }); } catch {} return; }
    let b = {}; try { b = JSON.parse(req.postData() || '{}'); } catch {}
    if (b.stream) {
      streamReq++;
      if (streamReq === 1) {
        // 4 秒后才回：这段时间里用户按下了停止
        setTimeout(() => { try { req.respond({ status:200, headers:{'Access-Control-Allow-Origin':'*'}, contentType:'text/event-stream', body: sse('（来晚了）') }); } catch {} }, 4000);
      } else {
        try { req.respond({ status:200, headers:{'Access-Control-Allow-Origin':'*'}, contentType:'text/event-stream', body: sse('好。') }); } catch {}
      }
      return;
    }
    try { req.respond({ status:200, headers:{'Access-Control-Allow-Origin':'*'}, contentType:'application/json', body: JSON.stringify({ choices: [{ message: { content: '{}' } }] }) }); } catch {}
    return;
  }
  try { req.continue(); } catch {}
});

const ID = 'c-stop';
const dbEval = (fn, arg) => page.evaluate(fn, arg);
const leafNow = () => dbEval(async (cid) => { const d = await import('/js/db.js'); const v = await d.kv.get('branch:' + cid, ''); return v; }, ID);
const pathIds = () => dbEval(async (cid) => {
  const d = await import('/js/db.js'); const { activePath } = await import('/js/branch.js');
  const all = await d.msgs.list(cid, 0, true);
  const p = await activePath(cid, all);
  return p.map(m => m.id);
}, ID);
const allRows = () => dbEval(async (cid) => {
  const d = await import('/js/db.js');
  const all = await d.msgs.list(cid, 0, true);
  return all.map(m => ({ id:m.id, role:m.role, content:m.content, parentId:m.parentId, ts:m.ts }));
}, ID);

await page.goto('http://127.0.0.1:' + port + '/index.html', { waitUntil:'networkidle0', timeout:40000 });
await sleep(1200);
await page.evaluate(() => { try { indexedDB.deleteDatabase('ai-companion'); } catch {} });
await page.reload({ waitUntil:'networkidle0' }); await sleep(700);
// seed：一个角色 + 一条她在上一轮说的话 + 关掉活人感 v2（本套只测「停止」这一条路）
await page.evaluate(async (cid) => {
  const d = await import('/js/db.js');
  await d.chars.put({ id:cid, name:'停止测试', avatar:null, greeting:'（在）', persona:'p', createdAt: Date.now(), longMemory:false, verbosity:'medium' });
  await d.msgs.add({ id:'m0', charId:cid, role:'assistant', content:'我在这儿呢。', parentId:'', ts:1000 });
  const cur = (await d.kv.get('settings', {})) || {};
  await d.kv.set('settings', Object.assign({}, cur, { apiKey:'sk-test', liveV2:false }));
}, ID);
await page.reload({ waitUntil:'networkidle0' }); await sleep(1100);

console.log('=== 停止：一个字都没收到的时候 ===');
await page.evaluate(() => { const c = document.querySelectorAll('#char-list .char-card')[0]; if (c) c.click(); });
await sleep(1200);
// 发一条，然后【等到请求真的发出去】再点停止 —— 定时点停止是碰运气
await page.evaluate((txt) => { const i = document.getElementById('input'); i.value = txt; i.dispatchEvent(new Event('input', { bubbles:true })); }, '你在干什么');
await page.evaluate(() => document.getElementById('btn-send').click());
let waited = 0;
for (; waited < 60 && streamReq === 0; waited++) await sleep(100);
t('这一条真的发出去了（请求已到达）', streamReq >= 1, 'streamReq=' + streamReq);
const rows0 = await allRows();
const u0 = rows0.filter(m => m.role === 'user').pop();
t('用户消息已落库', !!u0, JSON.stringify(rows0.map(m => m.id)));
const stopShown = await page.$eval('#btn-stop', e => !e.classList.contains('hidden')).catch(() => false);
t('生成中「停止」按钮可用', stopShown === true);
await page.evaluate(() => document.getElementById('btn-stop').click());
await sleep(260);
const toastText = await page.evaluate(() => (document.body.textContent || ''));
t('弹了「已停止生成」', toastText.includes('已停止生成'));
await sleep(1200);

const leaf1 = await leafNow();
t('活动叶子推到了这条用户消息', leaf1 === (u0 && u0.id), 'leaf=' + leaf1 + ' um=' + (u0 && u0.id));
const p1 = await pathIds();
t('它在活动路径上（重绘时不会消失）', !!u0 && p1.includes(u0.id), JSON.stringify(p1));
const rows1 = await allRows();
t('一个字都没收到时不留「（已中断）」', !rows1.some(m => m.role === 'assistant' && String(m.content).includes('已中断')), JSON.stringify(rows1.map(m => m.content.slice(0, 10))));

// 长按：showMsgMenu 里 curMsgs 找不到就直接 return —— 旁支的典型症状是没有菜单
const longPressed = await page.evaluate((id) => {
  const el = document.querySelector('#messages .msg[data-id="' + id + '"]');
  if (!el) return false;
  el.dispatchEvent(new Event('touchstart', { bubbles:true }));
  return true;
}, u0 && u0.id);
t('长按的那条在屏幕上', longPressed === true);
await sleep(950);
const menuInfo = await page.evaluate(() => {
  const m = document.querySelector('.msg-menu');
  if (!m) return { open:false, hasEdit:false };
  return { open:true, hasEdit: (m.textContent || '').includes('编辑重发') };
});
t('长按有菜单弹出', menuInfo.open === true);
t('菜单里有「编辑重发」', menuInfo.hasEdit === true);
await page.evaluate(() => { document.querySelectorAll('.msg-menu').forEach(e => e.remove()); });

console.log('=== 再发一条：它不许消失，也不许变成兄弟 ===');
await page.evaluate((txt) => { const i = document.getElementById('input'); i.value = txt; i.dispatchEvent(new Event('input', { bubbles:true })); }, '再来一条');
await page.evaluate(() => document.getElementById('btn-send').click());
for (let i = 0; i < 80; i++) { await sleep(300); const b = await page.$eval('#btn-stop', e => !e.classList.contains('hidden')).catch(() => false); if (!b) break; }
await sleep(900);
const rows2 = await allRows();
const users = rows2.filter(m => m.role === 'user');
const u1 = users.pop();
t('第二条用户消息发出去了', !!u1 && u1.id !== (u0 && u0.id), JSON.stringify(users.map(m => m.id)));
t('新的这条接在停止那条后面（不是跟它并排的兄弟）', !!u1 && !!u0 && u1.parentId === u0.id, 'parent=' + (u1 && u1.parentId) + ' u0=' + (u0 && u0.id));
const p2 = await pathIds();
t('停止那条仍在活动路径上', !!u0 && p2.includes(u0.id), JSON.stringify(p2));
const domIds = await page.evaluate(() => [...document.querySelectorAll('#messages .msg')].map(e => e.dataset.id));
t('停止那条仍在屏幕上', !!u0 && domIds.includes(u0.id), JSON.stringify(domIds));
t('没有出两条并排的用户消息', users.length === 1, JSON.stringify(users.map(m => m.id)));

t('页内没有异常', errs.length === 0, errs.join(' | '));
console.log('');
console.log('通过 ' + pass + ' 项 / 失败 ' + fail + ' 项');
await browser.close();
server.close();
process.exit(fail ? 1 : 0);
