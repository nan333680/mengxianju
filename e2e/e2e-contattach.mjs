// e2e-contattach.mjs —— 续写（⟳）也要认「＋」里挂的附加功能（0.5.4.2）
//
// 用户 2026-10-31 报的：
//   「点了『让她继续输出』按键后，我选了的附加功能能去影响。目前软件是主要聊天框没内容，
//    那么附加功能对她直接继续输出是没有影响的，我想要附加功能调用后能对她输出的内容
//    产生影响来控制发展方向」
//
// 根因：附加功能只在「发送」那条路上装配（app.js 的 if (!cont && !noUser) 分支），
//   续写走 else，_cmds 恒为空 —— 剧情方向 / 本轮更改 / 联网搜索 一个都不进提示词。
//
// 这一套全部走真实点击与真实请求体（hijack fetch），不读源码、不 grep 文案。
// ⚠️ liveV2: false —— 续写的契约是「一次点击 = 一次请求」，v2 一轮三条候选会把它数成 3。

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
const BASE = 'http://127.0.0.1:' + port + '/index.html';
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = [];
page.on('pageerror', e => errs.push(e.message));
const sleep = ms => new Promise(r=>setTimeout(r,ms));
let pass=0, fail=0;
const t=(n,ok,ex='')=>{ if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));} };

await page.evaluateOnNewDocument(() => {
  window.__reqAll = [];
  const realFetch = window.fetch.bind(window);
  window.fetch = async function (url, opts) {
    const u = String(url);
    let body = {};
    try { body = JSON.parse((opts && opts.body) || '{}'); } catch (e) {}
    if (u.includes('/chat/completions')) {
      // 非流式（记忆 / 判断之类）：回一个空 JSON，不参与计数
      if (body.stream === false) {
        return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      window.__reqAll.push(body);
      const chunk = (o) => 'data: ' + JSON.stringify(o) + String.fromCharCode(10,10);
      const payload =
        chunk({ choices: [{ delta: { content: '新写的一段。' } }] }) +
        chunk({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 5 } }) +
        'data: [DONE]' + String.fromCharCode(10,10);
      return new Response(payload, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    return realFetch(url, opts);
  };
});

async function hardReset() {
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'language', { get: () => 'zh-CN', configurable: true });
    Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh'], configurable: true });
  });
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  const cdp = await page.target().createCDPSession();
  await cdp.send('Storage.clearDataForOrigin', { origin: 'http://127.0.0.1:' + port, storageTypes: 'indexeddb' });
  await cdp.detach();
  await page.goto('about:blank');
}

async function seed(spec) {
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await sleep(500);
  await page.evaluate(async (s) => {
    const o = indexedDB.open('ai-companion');
    const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
    const put = (store, rec) => new Promise(r => { const tx = db.transaction(store,'readwrite'); tx.objectStore(store).put(rec); tx.oncomplete = r; });
    for (const c of (s.chars||[])) await put('characters', c);
    for (const e of (s.kv||[])) await put('kv', e);
    for (const m of (s.msgs||[])) await put('messages', m);
    db.close();
  }, spec);
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await sleep(1200);
  await page.evaluate(() => { window.__reqAll.length = 0; });
}

const baseChar = (id, name) => ({
  id, name, greeting: '（' + name + '）你在啊。', persona: '你是' + name + '。',
  avatar: null, temperature: 1.0, maxTokens: 2048, topP: 1.0, reasoningEffort: 'low',
  contextRounds: 20, kaomojiFreq: 0, emojiFreq: 0,
  verbosity: 'medium', splitMessages: false, typingDelay: 0, hesitation: false,
  showTyping: true, longMemory: false, allowEditMine: false,
  descLevel: 'low', povLock: false, appearance: '', appearanceOn: true,
  presetKey: 'blank', createdAt: Date.now()
});

const SETTINGS = { apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash',
  clockMode: false, historyTime: false, liveV2: false };

const CID = 'contattach1';
const T0 = 1790000000000;
const M = (id, role, content, ts, parentId) => ({ id, charId: CID, role, content, ts, parentId });

const waitIdle = async () => {
  await sleep(300);
  for (let i = 0; i < 400; i++) {
    const busyNow = await page.$eval('#btn-stop', el => !el.classList.contains('hidden')).catch(()=>false);
    if (!busyNow) return;
    await sleep(80);
  }
};
/** 续写契约是「不落用户消息」—— 所以数的是 user 那几条，不是全部（她自己的回复当然会落库） */
const userCount = () => page.evaluate(async (id) => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const rows = await new Promise(r => { const q = db.transaction('messages').objectStore('messages').index('charId').getAll(id); q.onsuccess = () => r(q.result || []); });
  db.close();
  return rows.filter(x => x.role === 'user').length;
}, CID);

/** 点 ⟳ 续写一次，等它跑完，返回这一次的请求体文本 */
async function contOnce() {
  await page.evaluate(() => { window.__reqAll.length = 0; });
  await page.evaluate(() => document.getElementById('btn-continue').click());
  await waitIdle();
  await sleep(300);
  return page.evaluate(() => {
    const r = window.__reqAll[window.__reqAll.length - 1];
    return r ? (r.messages || []).map(m => String(m.content || '')).join('\n') : '';
  });
}

/** 挂一个附加功能并填参数（走真实的 ＋ 抽屉，不碰内部变量） */
async function mountCmd(k, arg) {
  await page.evaluate((kk, aa) => {
    const dr = document.getElementById('cmd-drawer');
    if (dr && dr.classList.contains('hidden')) document.getElementById('btn-plus').click();
    const b = document.querySelector('#cmd-drawer [data-cmd="' + kk + '"]');
    if (b) b.click();
    const inp = document.querySelector('#cmd-slots textarea[data-cmd="' + kk + '"]');
    if (inp) {
      inp.value = aa;
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, k, arg);
  await sleep(200);
}

async function sendOnce(text) {
  await page.evaluate(() => { window.__reqAll.length = 0; });
  await page.type('#input', text);
  await page.evaluate(() => document.getElementById('btn-send').click());
  await waitIdle();
  await sleep(300);
  return page.evaluate(() => {
    const r = window.__reqAll[window.__reqAll.length - 1];
    return r ? (r.messages || []).map(m => String(m.content || '')).join('\n') : '';
  });
}

// ============================================================
await hardReset();
await seed({
  chars: [baseChar(CID, '阿紫')],
  kv: [{ k: 'settings', v: SETTINGS }, { k: 'lastCharId', v: CID },
       { k: 'greeted:' + CID, v: true }, { k: 'branch:' + CID, v: 'a2' }],
  msgs: [
    M('u1', 'user',      '今天有点冷。', T0 + 1, ''),
    M('a1', 'assistant', '那就把窗关上。', T0 + 2, 'u1'),
    M('u2', 'user',      '关上了。',     T0 + 3, 'a1'),
    M('a2', 'assistant', '嗯。',         T0 + 4, 'u2')
  ]
});

const n0 = await userCount();
t('★ 基线：seed 里有 2 条用户消息', n0 === 2, '实际 ' + n0);

console.log('');
console.log('=== 1. 什么都没挂：续写的提示词里不该有那两段 ===');
const base = await contOnce();
t('★ 续写真的发出了请求（1 次）', base.length > 0, '空');
t('没挂剧情方向时，提示词里没有「这一轮的剧情方向」', !base.includes('# 这一轮的剧情方向'), '');
t('没挂本轮更改时，提示词里没有「这一轮的额外要求」', !base.includes('# 这一轮的额外要求'), '');
t('续写不落用户消息（user 条数没变）', (await userCount()) === 2, '实际 ' + (await userCount()));

console.log('');
console.log('=== 2. 挂「剧情方向」再续写（用户报的那条） ===');
await mountCmd('plot', '她开始起疑心，气氛往下沉');
const withPlot = await contOnce();
t('★ 续写带上了剧情方向那一段', withPlot.includes('# 这一轮的剧情方向'), withPlot.slice(-300));
t('★ 方向原文逐字进了提示词', withPlot.includes('她开始起疑心，气氛往下沉'), '');
t('续写还是不落用户消息', (await userCount()) === 2, '实际 ' + (await userCount()));
const stillMounted = await page.evaluate(() => !!document.querySelector('#cmd-slots textarea[data-cmd="plot"]'));
t('★ 续写后功能还挂着（下一次还认）', stillMounted, '');

console.log('');
console.log('=== 3. 再挂「本轮更改」，两个一起续写 ===');
await mountCmd('direct', '说短一点，别铺开');
const withBoth = await contOnce();
t('★ 剧情方向还在', withBoth.includes('# 这一轮的剧情方向') && withBoth.includes('她开始起疑心'), '');
t('★ 本轮更改也进来了', withBoth.includes('# 这一轮的额外要求') && withBoth.includes('说短一点，别铺开'), '');

console.log('');
console.log('=== 4. 发送一轮带「本轮更改」，再续写（余温要接上） ===');
await page.evaluate(() => {
  document.querySelectorAll('#cmd-slots [data-del]').forEach(b => b.click());
});
await sleep(200);
await mountCmd('direct', '用可爱一点的口气');
const sendReq = await sendOnce('那你睡吧');
t('发送那一轮带上了本轮更改', sendReq.includes('# 这一轮的额外要求') && sendReq.includes('用可爱一点的口气'), '');
const leftAfterSend = await page.evaluate(() => document.querySelectorAll('#cmd-slots textarea[data-cmd]').length);
t('发送之后挂着的功能被清掉了（老契约没变）', leftAfterSend === 0, '剩 ' + leftAfterSend);
const afterSend = await contOnce();
t('★ 续写带上「上一轮的要求」那一段', afterSend.includes('# 上一轮的要求（还没过去）'), afterSend.slice(-300));
t('★ 上一轮那句逐字在', afterSend.includes('用可爱一点的口气'), '');

console.log('');
console.log('=== 5. 撤掉功能之后再续写，就不该再带 ===');
await page.evaluate(() => {
  document.querySelectorAll('#cmd-slots [data-del]').forEach(b => b.click());
});
const bare2 = await contOnce();
t('撤掉之后没有剧情方向段', !bare2.includes('# 这一轮的剧情方向'), '');
t('撤掉之后没有本轮更改段', !bare2.includes('# 这一轮的额外要求'), '');

t('无 JS 报错', errs.length === 0, errs.join(' | '));

console.log('');
console.log('汇总：通过 ' + pass + ' / 失败 ' + fail);
await browser.close();
server.close();
process.exit(fail ? 1 : 0);
