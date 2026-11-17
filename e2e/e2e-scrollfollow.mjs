import puppeteer from 'puppeteer-core';
import http from 'http'; import fs from 'fs'; import path from 'path';
// 滚动跟随（v0.5.7.6）：输出中用户上滑看历史时不再被拽回底部。
//
// 验的是状态机（上滑 → 停止跟随 → 输出期间位置不变 → 回底按钮 → 恢复跟随），
// 以及「发送 / 重新渲染仍然是强制到底」这条相反的规则。
// ⚠️ 验不了「rAF 补帧有没有把最后几个字画上去」—— 流结束后气泡立刻被落库那条
//    正式消息取代（paintFlow / 老节奏贴条），屏幕上那个 .gen-text 已经没了。
//    补帧只能靠代码审查 + 真机看最后几个字。
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
// CI（en-US）上也会跑：界面语言必须钉住（tools/ci-precheck.mjs 查这一条）
await page.evaluateOnNewDocument(() => { Object.defineProperty(navigator, 'language', { get: () => 'zh-CN' }); });
const errs = []; page.on('pageerror', e => errs.push(e.message));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const t = (n, ok, ex='') => { if (ok) { pass++; console.log('  OK   ' + n); } else { fail++; console.log('  FAIL ' + n + (ex ? '  -> ' + ex : '')); } };

const LONG = '这是一段很长的回复，用来把气泡撑高。'.repeat(6) + '尾巴标记XYZ';
const sse = (txt) => 'data: ' + JSON.stringify({ choices: [{ delta: { content: txt } }] }) + NL + NL + 'data: [DONE]' + NL + NL;
let streamReq = 0;
await page.setRequestInterception(true);
page.on('request', req => {
  const u = req.url();
  if (u.includes('/chat/completions')) {
    if (req.method() === 'OPTIONS') { try { req.respond({ status:204, headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'*'} }); } catch {} return; }
    let b = {}; try { b = JSON.parse(req.postData() || '{}'); } catch {}
    if (b.stream) {
      streamReq++;
      // 第一条故意慢 2.5 秒回：这段时间里用户上滑，然后输出才到 ——
      // 只有这样才测得到「输出中的滚动被 followScroll 拦住」。
      const delay = streamReq === 1 ? 2500 : 0;
      const body = streamReq === 1 ? sse(LONG) : sse('好。');
      setTimeout(() => { try { req.respond({ status:200, headers:{'Access-Control-Allow-Origin':'*'}, contentType:'text/event-stream', body }); } catch {} }, delay);
      return;
    }
    try { req.respond({ status:200, headers:{'Access-Control-Allow-Origin':'*'}, contentType:'application/json', body: JSON.stringify({ choices: [{ message: { content: '{}' } }] }) }); } catch {}
    return;
  }
  try { req.continue(); } catch {}
});

const ID = 'c-scroll';
await page.goto('http://127.0.0.1:' + port + '/index.html', { waitUntil:'networkidle0', timeout:40000 });
await sleep(1000);
await page.evaluate(() => { try { indexedDB.deleteDatabase('ai-companion'); } catch {} });
await page.reload({ waitUntil:'networkidle0' }); await sleep(700);

// seed：一个角色 + 40 条消息（把消息区撑到可滚动）+ 关掉活人感 v2（走单条流式那条路）
await page.evaluate(async (cid) => {
  const d = await import('/js/db.js');
  await d.chars.put({ id:cid, name:'滚动测试', avatar:null, greeting:'（在）', persona:'p', createdAt: Date.now(), longMemory:false, verbosity:'medium' });
  const base = Date.now() - 200000;
  for (let i = 0; i < 40; i++) {
    await d.msgs.add({ id:'s'+i, charId:cid, role: i % 2 ? 'assistant' : 'user', content:'第 ' + i + ' 条消息，用来把消息区撑到可滚动的高度。', parentId: i ? 's' + (i - 1) : '', ts: base + i * 1000 });
  }
  await d.kv.set('branch:' + cid, 's39');
  const cur = (await d.kv.get('settings', {})) || {};
  await d.kv.set('settings', Object.assign({}, cur, { apiKey:'sk-test', liveV2:false }));
}, ID);
await page.reload({ waitUntil:'networkidle0' }); await sleep(900);
await page.evaluate(() => { const c = document.querySelectorAll('#char-list .char-card')[0]; if (c) c.click(); });
await sleep(1300);

const snap = () => page.evaluate(() => {
  const b = document.getElementById('messages');
  const btn = document.getElementById('btn-back-bottom');
  return {
    scrollable: b.scrollHeight > b.clientHeight + 20,
    top: Math.round(b.scrollTop),
    dist: Math.round(b.scrollHeight - b.scrollTop - b.clientHeight),
    btnHidden: btn ? btn.classList.contains('hidden') : null,
    title: btn ? (btn.getAttribute('title') || '') : '',
    aria: btn ? (btn.getAttribute('aria-label') || '') : '',
    gen: (document.querySelector('#messages .gen-text') || {}).textContent || ''
  };
});
// 上滑：先 touchmove（用户意图），再改位置 + 派发 scroll —— 顺序不能反
const userScrollUp = () => page.evaluate(() => {
  const b = document.getElementById('messages');
  b.dispatchEvent(new TouchEvent('touchmove', { bubbles: true, cancelable: true }));
  b.scrollTop = 0;
  b.dispatchEvent(new Event('scroll'));
});
const progBottom = () => page.evaluate(() => {
  const b = document.getElementById('messages');
  b.scrollTop = b.scrollHeight;
  b.dispatchEvent(new Event('scroll'));
});

console.log('=== 默认状态 ===');
const s0 = await snap();
t('消息区可滚动（40 条撑起来了）', s0.scrollable === true, 'scrollHeight/clientHeight 不够');
t('渲染完停在底部', s0.dist < 40, 'dist=' + s0.dist);
t('默认不显示「回到最新」', s0.btnHidden === true, JSON.stringify(s0.btnHidden));
t('按钮有中文 title', s0.title.includes('回到最新'), s0.title);
t('aria-label 跟着 title（i18n 末尾统一同步）', s0.aria === s0.title && !!s0.aria, 'aria=' + s0.aria);

console.log('=== 上滑 → 停止跟随 ===');
await userScrollUp(); await sleep(200);
const s1 = await snap();
t('上滑后离开底部', s1.dist > 300, 'dist=' + s1.dist);
t('上滑后按钮出现', s1.btnHidden === false, JSON.stringify(s1.btnHidden));

console.log('=== 发送仍然是强制到底 ===');
await page.evaluate(() => { const i = document.getElementById('input'); i.value = '你在干什么'; i.dispatchEvent(new Event('input', { bubbles:true })); });
await page.evaluate(() => document.getElementById('btn-send').click());
await sleep(500);
const s2 = await snap();
t('发送后立刻回到最底部（自己的消息必须看得见）', s2.dist < 40, 'dist=' + s2.dist);
t('到底之后按钮自己收起来', s2.btnHidden === true, JSON.stringify(s2.btnHidden));

console.log('=== 输出期间：上滑位置不能被拽走 ===');
await userScrollUp(); await sleep(150);
const before = await snap();
t('第二条：上滑后按钮出现', before.btnHidden === false, JSON.stringify(before.btnHidden));
// 2.5 秒后那条长回复才到；等到它落地再读位置
await sleep(3200);
const s3 = await snap();
t('输出期间 scrollTop 没有被拽回底部', s3.top < 200, 'top=' + s3.top);
t('输出期间按钮一直在', s3.btnHidden === false, JSON.stringify(s3.btnHidden));

console.log('=== 点「回到最新」→ 恢复跟随 ===');
await page.evaluate(() => document.getElementById('btn-back-bottom').click());
await sleep(400);
const s4 = await snap();
t('点击后回到最底部', s4.dist < 40, 'dist=' + s4.dist);
t('点击后按钮收起', s4.btnHidden === true, JSON.stringify(s4.btnHidden));

console.log('=== 恢复跟随之后，再输出还跟不跟 ===');
await page.evaluate(() => { const i = document.getElementById('input'); i.value = '再来一句'; i.dispatchEvent(new Event('input', { bubbles:true })); });
await page.evaluate(() => document.getElementById('btn-send').click());
await sleep(1500);
const s5 = await snap();
t('跟随状态下输出结束仍在底部', s5.dist < 40, 'dist=' + s5.dist);
t('跟随状态下不显示按钮', s5.btnHidden === true, JSON.stringify(s5.btnHidden));

console.log('=== 长文本完整性（full 落库，不经补帧） ===');
const lastMsg = await page.evaluate(async (cid) => {
  const d = await import('/js/db.js');
  const all = await d.msgs.list(cid, 0, true);
  const ai = all.filter(m => m.role === 'assistant' && String(m.content || '').includes('尾巴标记'));
  return ai.length ? ai[ai.length - 1].content : '';
}, ID);
t('落库里是完整长文本（含尾巴标记）', lastMsg.includes('尾巴标记XYZ'), lastMsg.slice(-30));

t('页内没有 JS 异常', errs.length === 0, errs.slice(0, 2).join(' | '));

console.log('通过 ' + pass + ' 项 / 失败 ' + fail + ' 项');
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
