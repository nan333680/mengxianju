// e2e-diag.mjs — 诊断页 / 全局错误日志（0.5.3.5）
//
// 这一套钉的是「出问题的时候，手机上有没有东西可看」：
//   A. 全局异常真的被接住了（window.onerror / unhandledrejection 两条路都走一遍）；
//   B. 环形缓冲不会无限长（200 条上限），最早的那些会被挤掉；
//   C. Key 形态的串一定被打码 —— 这份日志会被复制出去贴给人看；
//   D. 设置页那一块能点开、能显示版本与库版本、能清空、能复制而不抛。
//
// ⚠️ 第 2、3 节【故意】制造未捕获异常，所以最后那条「全程无报错」必须把它们排除掉。
//    以前吃过一次亏：断言写「errs.length === 0」，结果这一套永远是红的。
import puppeteer from 'puppeteer-core';
import http from 'http'; import fs from 'fs'; import path from 'path';
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
const URL0 = 'http://127.0.0.1:' + port + '/';
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 120000,
  args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
const page = await browser.newPage();
await page.evaluateOnNewDocument(() => {
  Object.defineProperty(navigator, 'language', { get: () => 'zh-CN', configurable: true });
  Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh'], configurable: true });
});
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = []; page.on('pageerror', e => errs.push(e.message));
const sleep = ms => new Promise(r => setTimeout(r, ms));
// 第 8/9 节共用的假回复。第 9 节要让它带一句「我认」，好让去味层产生记录。
let SSE_REPLY = '（她把杯子放下）嗯。';
const entries = () => page.evaluate(() => (window.__diag ? window.__diag.entries() : null));
const text = () => page.evaluate(() => (window.__diag ? window.__diag.text({ 版本: 'test' }) : ''));

await page.goto(URL0, { waitUntil: 'networkidle0', timeout: 40000 });
await sleep(1200);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil: 'networkidle0' }); await sleep(900);

console.log('');
console.log('=== 1. 启动自检 ===');
{
  const has = await page.evaluate(() => !!(window.__diag && window.__diag.entries && window.__diag.text && window.__diag.clear && window.__diag.log));
  t('window.__diag 装上了（手动排错入口）', has);
  const es = await entries();
  t('启动就记了日志（不是空数组）', Array.isArray(es) && es.length > 0, es && es.length);
  const hasBoot = Array.isArray(es) && es.some(e => e.kind === 'boot');
  t('里面有 boot 这一类', hasBoot, es && es.map(e => e.kind).join(','));
  const withCtx = Array.isArray(es) && es.some(e => e.ctx && Object.keys(e.ctx).length > 0);
  t('日志带上下文（页签 / 角色 / 模型）', withCtx, es && es[0] && es[0].ctx);
}

console.log('');
console.log('=== 2. 未捕获异常 ===');
{
  // ⚠️ 必须用 addScriptTag 注入【页面自己的内联脚本】，不能用 page.evaluate ——
  //    evaluate 走 CDP 注入，Chrome 把它当跨源脚本，抛出来的错误会被脱敏成
  //    "Script error." 且 ev.error 为 null。用 evaluate 测这条会得到假红。
  await page.addScriptTag({ content: 'setTimeout(function(){ throw new Error("boom-xyz"); }, 0);' });
  await sleep(600);
  const es = await entries();
  const hit = (es || []).find(e => e.kind === 'err' && e.msg.includes('boom-xyz'));
  t('window error 被接住', !!hit, es && es.map(e => e.kind + ':' + e.msg.slice(0, 40)).join(' | '));
  t('留下了栈（不是只有一句话）', !!(hit && hit.stack && hit.stack.split('\n').length >= 2), hit && hit.stack);
}

console.log('');
console.log('=== 3. 未处理的 Promise rejection ===');
{
  await page.addScriptTag({ content: 'Promise.reject(new Error("rej-xyz"));' });
  await sleep(600);
  const es = await entries();
  t('unhandledrejection 被接住', (es || []).some(e => e.kind === 'reject' && e.msg.includes('rej-xyz')),
    es && es.map(e => e.kind).join(','));
}

console.log('');
console.log('=== 4. 环形上限 200 ===');
{
  await page.evaluate(() => { window.__diag.clear(); for (let i = 0; i < 250; i++) window.__diag.log('act', 'n' + i); });
  const es = await entries();
  t('长度夹在 200', es.length === 200, es.length);
  t('最早的被挤掉了（第一条是 n50）', es[0].msg === 'n50', es[0].msg);
  t('最新的还在（最后一条是 n249）', es[199].msg === 'n249', es[199].msg);
}

console.log('');
console.log('=== 5. Key 一定要打码 ===');
{
  await page.evaluate(() => { window.__diag.clear(); window.__diag.log('act', 'key=sk-abcdefgh12345678 后面正常'); });
  const txt = await text();
  t('sk- 形态被打码', txt.includes('sk-***'), txt.slice(0, 120));
  t('原文没有漏出去', !txt.includes('sk-abcdefgh12345678'), txt.slice(0, 120));
  t('没被误伤的正文还在', txt.includes('后面正常'), txt.slice(0, 120));
}

console.log('');
console.log('=== 6. 设置页那一块能打开、有内容 ===');
{
  await page.evaluate(() => document.getElementById('btn-settings').click()); await sleep(700);
  await page.evaluate(() => { const b = [...document.querySelectorAll('#drawer-menu [data-wb-drawer]')].find(x => x.dataset.wbDrawer === 'settings'); if (b) b.click(); }); await sleep(900);
  const hasFold = await page.evaluate(() => !!document.getElementById('diag-fold') && !!document.getElementById('diag-wrap'));
  t('设置页有诊断折叠区', hasFold);
  // 折叠着也点得动（fold 只是 grid 收起，DOM 一直在）—— 这条顺带证明按钮不是靠展开才存在
  await page.evaluate(() => { const b = document.getElementById('btn-diag-open'); if (b) b.click(); });
  await sleep(700);
  const shown = await page.evaluate(() => { const m = document.getElementById('diag-modal'); return !!m && !m.classList.contains('hidden'); });
  t('诊断弹层打开了', shown);
  const meta = await page.evaluate(() => (document.getElementById('diag-meta') || {}).textContent || '');
  console.log('   meta: ' + JSON.stringify(meta));
  t('显示版本号', /版本：\S+/.test(meta), meta);
  t('显示库版本', /库：v\d+/.test(meta), meta);
  t('显示内核 UA', /内核：.*Chrome/.test(meta), meta);
  t('日志区有文本', (await page.evaluate(() => (document.getElementById('diag-log') || {}).value || '')).length > 0);
}

console.log('');
console.log('=== 7. 复制不抛、清空真清 ===');
{
  const before = errs.length;
  await page.evaluate(() => { const b = document.getElementById('diag-copy'); if (b) b.click(); });
  await sleep(500);
  t('点复制没有冒未捕获异常', errs.length === before, errs.slice(before));
  await page.evaluate(() => { const b = document.getElementById('diag-clear'); if (b) b.click(); });
  await sleep(400);
  const es = await entries();
  t('清空之后一条都不剩', es.length === 0, es.length);
  t('日志区也空了', (await page.evaluate(() => (document.getElementById('diag-log') || {}).value || '')).length === 0);
  const hint = await page.evaluate(() => (document.getElementById('diag-hint') || {}).textContent || '');
  t('折叠角标回到「—」', hint.trim() === '—', hint);
  await page.evaluate(() => { const b = document.getElementById('diag-close'); if (b) b.click(); });
  await sleep(300);
  t('关闭之后弹层收起来', await page.evaluate(() => document.getElementById('diag-modal').classList.contains('hidden')));
}

// 第 8/9 节共用：进设置页 / 回聊天页（设置页左上返回按钮是 btn-set-back）
const openSettings = async () => {
  await page.evaluate(() => document.getElementById('btn-settings').click()); await sleep(700);
  await page.evaluate(() => { const b = [...document.querySelectorAll('#drawer-menu [data-wb-drawer]')].find(x => x.dataset.wbDrawer === 'settings'); if (b) b.click(); }); await sleep(900);
};
const backToChat = async () => {
  await page.evaluate(() => { const b = document.getElementById('btn-set-back'); if (b) b.click(); }); await sleep(700);
};

console.log('');
console.log('=== 8. 提示词检查器：空态 → 发一条 → 看得到真正的提示词 ===');
{
  // 这一段要用假 SSE（不发真请求、不花钱），并且必须 seed 一个角色 + settings.apiKey：
  //   没有 apiKey 前端【根本不发请求】，lastPromptSnap 永远是 null，整节会假通过。
  await page.setRequestInterception(true);
  page.on('request', req => {
    if (req.url().includes('/chat/completions')) {
      // ⚠️ 预检要放行 content-type / authorization，否则浏览器直接判 Failed to fetch，
      //    AI 那条气泡变成错误卡（第一版就是这样：请求其实从没成功，peek 却已经通过了）。
      if (req.method() === 'OPTIONS') {
        req.respond({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' } }); return;
      }
      const chunk = JSON.stringify({ choices: [{ delta: { content: SSE_REPLY }, finish_reason: 'stop' }] });
      req.respond({ status: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }, contentType: 'text/event-stream',
        body: 'data: ' + chunk + '\n\n' + 'data: [DONE]\n\n' }); return;
    }
    req.continue();
  });
  const closePeek = async () => { await page.evaluate(() => { const b = document.getElementById('peek-close'); if (b) b.click(); }); await sleep(300); };

  // 先清库重来 —— 上一节把日志清空了，这里要的是「从没发过消息」那个状态
  await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
  await page.reload({ waitUntil: 'networkidle0' }); await sleep(800);
  await openSettings();
  await page.evaluate(() => { const b = document.getElementById('btn-peek-open'); if (b) b.click(); });
  await sleep(500);
  const meta0 = await page.evaluate(() => (document.getElementById('peek-meta') || {}).textContent || '');
  t('还没发消息时给的是空态文案，不是空白', /还没发过消息/.test(meta0), meta0);
  await closePeek();

  // seed：settings 里要有 apiKey，否则一条请求都不会发（channel 套踩过这个坑）
  await page.evaluate(async (id) => {
    const rq = indexedDB.open('ai-companion');
    const db = await new Promise(r => { rq.onsuccess = () => r(rq.result); });
    const put = (st, rec) => new Promise(r => { const tx = db.transaction(st, 'readwrite'); tx.objectStore(st).put(rec); tx.oncomplete = r; });
    await put('kv', { k: 'settings', v: { apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash',
      longMemory: false, worldbookOn: false, myProfile: '', myEnv: '', splitMax: 1, clockMode: false,
      ttsOn: false, kaomojiFreq: 0, emojiFreq: 0 } });
    await put('characters', { id, name: '甲', greeting: '（开场）', persona: '你是甲。', avatar: null,
      presetKey: 'blank', createdAt: Date.now(), temperature: 1, maxTokens: 2048,
      verbosity: 'medium', descLevel: 'mid', detailDrive: 'mid', povStyle: '', thinkMode: false,
      appearance: '', appearanceOn: false, splitMessages: false, hesitation: true, longMemory: false,
      kaomojiFreq: 0, emojiFreq: 0, contextRounds: 20 });
    db.close();
  }, 'ch1');
  await page.goto(URL0, { waitUntil: 'networkidle0' }); await sleep(900);
  await page.evaluate(() => { const c = [...document.querySelectorAll('#char-list .char-card')][0]; if (c) c.click(); });
  await sleep(1200);
  t('进到聊天页', await page.evaluate(() => document.querySelector('#view-chat').classList.contains('active')));
  await page.evaluate(() => { const i = document.getElementById('input'); i.value = '在吗'; i.dispatchEvent(new Event('input', { bubbles: true })); });
  await sleep(150);
  await page.evaluate(() => document.getElementById('btn-send').click());
  for (let i = 0; i < 40; i++) { await sleep(250); const b = await page.$eval('#btn-stop', e => !e.classList.contains('hidden')).catch(() => false); if (!b) break; }
  await sleep(600);

  const okBubble = await page.evaluate(() => {
    const last = [...document.querySelectorAll('#messages .msg')].pop();
    return last ? { err: !!last.querySelector('.err-bub'), t: last.textContent.slice(0, 40) } : null;
  });
  t('这一轮真有回复（不是错误卡）', okBubble && !okBubble.err, okBubble);

  await openSettings();
  await page.evaluate(() => { const b = document.getElementById('btn-peek-open'); if (b) b.click(); });
  await sleep(600);
  t('发过之后弹层打开了', await page.evaluate(() => { const m = document.getElementById('peek-modal'); return !!m && !m.classList.contains('hidden'); }));
  const meta = await page.evaluate(() => (document.getElementById('peek-meta') || {}).textContent || '');
  console.log('   peek-meta: ' + JSON.stringify(meta));
  t('显示用的是哪个模型', /模型：deepseek-flash/.test(meta), meta);
  t('显示总字数与条数', /总字数：约 \d+ 字/.test(meta) && /消息 \d+ 条/.test(meta), meta);
  const heads = await page.evaluate(() => [...document.querySelectorAll('#peek-list .peek-head b')].map(e => e.textContent));
  console.log('   段头: ' + JSON.stringify(heads));
  t('按请求顺序列了三段（稳定前缀 / 历史 / 本轮重建）',
    heads[0] === '稳定前缀' && heads.includes('聊天历史') && heads[heads.length - 1] === '本轮重建', heads);
  const secChars = await page.evaluate(() => [...document.querySelectorAll('#peek-list .peek-row')]
    .map(d => { const em = d.querySelector('summary > em'); const n = em ? parseInt(em.textContent, 10) : -1; return n; }));
  t('每一段都标了字数', secChars.length > 0 && secChars.every(n => n > 0), secChars.slice(0, 12));
  const secTxt = await page.evaluate(() => (document.querySelector('#peek-list .peek-row pre') || {}).textContent || '');
  t('段里是真的提示词正文（不是占位）', secTxt.length > 20, secTxt.slice(0, 60));
  const pure = await page.evaluate(async () => {
    const m = await import('/js/promptpeek.js');
    const a = m.splitPromptSections('# A\nxx\n# B\nyy');
    const b = m.splitPromptSections('前言\n# C\nzz');
    return { aN: a.length, aHeads: a.map(s => s.head), bHeads: b.map(s => s.head) };
  });
  t('切段：两个标题 → 两段', pure.aN === 2 && pure.aHeads[0] === 'A' && pure.aHeads[1] === 'B', pure);
  t('切段：没有标题的前导算一段「（开头）」', pure.bHeads[0] === '（开头）', pure);
  const before = errs.length;
  await page.evaluate(() => { const b = document.getElementById('peek-copy'); if (b) b.click(); });
  await sleep(400);
  t('点复制没有冒未捕获异常', errs.length === before, errs.slice(before));
  await closePeek();
  t('关闭之后收起来', await page.evaluate(() => document.getElementById('peek-modal').classList.contains('hidden')));
}

console.log('');
console.log('=== 9. 去味记录：洗了要看得见，而且历史与导出不动 ===');
{
  // 发一条【带套话】的回复：入库前会被洗掉「这个我认了。」，并留下一条记录。
  // ⚠️ 上一节结束时停在设置页，必须先回聊天页 —— 否则 #input 在隐藏视图里，
  //    点发送什么都不会发生，然后断言拿到的还是那条开场白（第一版就这样假红）。
  await backToChat();
  SSE_REPLY = '（她抬手把杯子推过来）这个我认了。';
  await page.evaluate(() => { const i = document.getElementById('input'); i.value = '再来一句'; i.dispatchEvent(new Event('input', { bubbles: true })); });
  await sleep(150);
  await page.evaluate(() => document.getElementById('btn-send').click());
  for (let i = 0; i < 40; i++) { await sleep(250); const b = await page.$eval('#btn-stop', e => !e.classList.contains('hidden')).catch(() => false); if (!b) break; }
  await sleep(700);

  const lastAi = await page.evaluate(() => {
    const last = [...document.querySelectorAll('#messages .msg')].filter(e => !e.querySelector('.err-bub')).pop();
    return last ? last.textContent : '';
  });
  console.log('   最后一条气泡: ' + JSON.stringify(lastAi));
  t('入库的是洗过的（气泡里没有「我认」）', !/我认/.test(lastAi), lastAi);
  t('动作还在（只删套话，不删正文）', /把杯子推过来/.test(lastAi), lastAi);

  // 折叠区里的入口应当已经有角标
  await openSettings();
  const defHint = await page.evaluate(() => (document.getElementById('diag-hint') || {}).textContent || '');
  t('折叠头角标带上了去味条数', /洗 1/.test(defHint), defHint);
  await page.evaluate(() => { const b = document.getElementById('btn-def-open'); if (b) b.click(); });
  await sleep(500);
  t('去味记录弹层打开了', await page.evaluate(() => { const m = document.getElementById('def-modal'); return !!m && !m.classList.contains('hidden'); }));
  const dmeta = await page.evaluate(() => (document.getElementById('def-meta') || {}).textContent || '');
  t('记录里有一条', /最近 1 条/.test(dmeta), dmeta);
  const before = await page.evaluate(() => { const e = document.querySelector('#def-list .def-before pre'); return e ? e.textContent : ''; });
  const after = await page.evaluate(() => { const e = document.querySelector('#def-list .def-after pre'); return e ? e.textContent : ''; });
  t('「洗之前」保留了原文（含「我认」）', /我认/.test(before), before);
  t('「洗之后」里没有了', !/我认/.test(after), after);
  const bh = errs.length;
  await page.evaluate(() => { const b = document.getElementById('def-copy'); if (b) b.click(); });
  await sleep(400);
  t('点复制没有冒未捕获异常', errs.length === bh, errs.slice(bh));
  await page.evaluate(() => { const b = document.getElementById('def-close'); if (b) b.click(); });
  await sleep(300);
  t('关闭之后收起来', await page.evaluate(() => document.getElementById('def-modal').classList.contains('hidden')));

  // 导出/气泡走的是原文 —— 这一条已经被洗过，所以库里本来就干净；这里反过来验「洗历史不动库」：
  // 再发一条不带套话的，确认历史里那条洗过的记录没有被二次处理成空气泡。
  const msgN = await page.evaluate(() => document.querySelectorAll('#messages .msg').length);
  t('气泡数正常（没有被洗成空消息）', msgN >= 4, msgN);
}

console.log('');
console.log('=== 10. 备份提醒条：超过一天才说，空库不说 ===');
{
  // 0.5.3.5（方向文档 P0-4）：备份面板住在「我的设置 → 数据」里，那是要去才看的地方，
  // 而「三天没备份了」正好是看的时候才发现、等要用时已经晚了的账 —— 所以搬到聊天页顶部。
  const seedKV = (pairs) => page.evaluate(async (ps) => {
    const rq = indexedDB.open('ai-companion');
    const db = await new Promise(r => { rq.onsuccess = () => r(rq.result); });
    for (const [k, v] of ps) {
      await new Promise(r => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put({ k, v }); tx.oncomplete = r; });
    }
    db.close();
  }, pairs);
  const bannerShown = () => page.evaluate(() => {
    const b = document.getElementById('backup-banner');
    return b ? !b.classList.contains('hidden') : null;
  });
  const DAY = 24 * 3600 * 1000;

  // ⚠️ dataAudit 不能用 seed 伪造 —— 启动时 renderDataBanner() 会重算并覆盖。
  //    要让它看见「有东西可丢」，就得真的往 messages 表里放够条数。
  await page.evaluate(async () => {
    const rq = indexedDB.open('ai-companion');
    const db = await new Promise(r => { rq.onsuccess = () => r(rq.result); });
    const chars = await new Promise(r => {
      const q = db.transaction('characters').objectStore('characters').getAll(); q.onsuccess = () => r(q.result);
    });
    const cid = (chars[0] || {}).id;
    if (cid) {
      for (let i = 0; i < 12; i++) {
        await new Promise(r => {
          const tx = db.transaction('messages', 'readwrite');
          tx.objectStore('messages').put({ id: 'nud' + i, charId: cid, role: i % 2 ? 'assistant' : 'user', content: '第 ' + i + ' 条', ts: Date.now() + i });
          tx.oncomplete = r;
        });
      }
    }
    db.close();
  });

  // ① 上一次备份在两天前 → 要说
  await seedKV([
    ['backupHealth', { write: { ran: true, at: Date.now() - 2 * DAY, dir: 'DOCUMENTS', name: 'x.json' } }],
  ]);
  await page.reload({ waitUntil: 'networkidle0' }); await sleep(2400);
  t('两天没备份 → 提醒条出现', (await bannerShown()) === true);
  const bTxt = await page.evaluate(() => (document.getElementById('backup-banner-txt') || {}).textContent || '');
  t('  文案说的是"一天多以前"，不是笼统的一句', /一天多以前/.test(bTxt), bTxt);

  // ② 点它 → 直达「我的设置 → 数据」（导出按钮就在那一栏）
  await page.evaluate(() => document.getElementById('backup-banner').click());
  await sleep(900);
  t('点提醒条直达我的设置', await page.evaluate(() => document.getElementById('view-mine').classList.contains('active')));
  t('  数据那一栏在页面上（导出入口就在里面）', await page.evaluate(() => !!document.getElementById('data-sec')));
  await backToChat();

  // ③ 刚备份过 → 一个字都不出现
  await seedKV([['backupHealth', { write: { ran: true, at: Date.now(), dir: 'DOCUMENTS', name: 'y.json' } }]]);
  await page.reload({ waitUntil: 'networkidle0' }); await sleep(2400);
  t('刚备份过 → 提醒条不出现', (await bannerShown()) === false);

  // ④ 空库（没聊天记录）→ 也不出现，哪怕从没备份过
  await page.evaluate(async () => {
    const rq = indexedDB.open('ai-companion');
    const db = await new Promise(r => { rq.onsuccess = () => r(rq.result); });
    for (const st of ['messages', 'kv']) {
      await new Promise(r => { const tx = db.transaction(st, 'readwrite'); tx.objectStore(st).clear(); tx.oncomplete = r; });
    }
    db.close();
  });
  await page.reload({ waitUntil: 'networkidle0' }); await sleep(2400);
  // 结论（实测）：清库之后 ensureChar 会补一条开场白，库里并不是真空的。
  // 所以门槛写成「至少有 10 条」，一句问候语不值得催人备份。
  t('只剩一条开场白 → 不提示', (await bannerShown()) === false);
}

console.log('');
const real = errs.filter(m => !/boom-xyz|rej-xyz/.test(m));
t('除了故意制造的两条，全程无 JS 错误', real.length === 0, real.slice(0, 3));
console.log('');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close(); server.close();
process.exit(fail > 0 ? 1 : 0);
