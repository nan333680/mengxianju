// perf-bench.mjs —— 真性能基准（不进回归，文件名故意不带 e2e- 前缀）
//
// 为什么另开一支：e2e-perf.mjs 测的是【行为】（出场动画有没有播、重绘会不会重播 fresh），
// 一行性能数字都没有。用户说「主要优化流畅程度」，那就得先有数字 ——
// 没有基线就没法证明改完真的快，也没法证明没改坏。
//
// 用法：
//   node e2e/perf-bench.mjs            # 默认 1200 条
//   node e2e/perf-bench.mjs 3000       # 施压
//
// 量五件事（都是他在真机上能直接感觉到的）：
//   1. 点角色卡 → 消息全部画出来，多久（首屏）
//   2. 已经画好之后再重绘一次，多久（切角色回来 / 删一条 / 改设置）
//   3. 滚动 60 帧的平均帧间隔（卡不卡）
//   4. 输入框连续敲 30 个字，多久（打字跟不跟手）
//   5. DOM 节点数（几千条消息时到底堆了多少东西）
//
// ⚠️ 不联网、不发真请求：fetch 全部被拦下。它只量渲染，不量模型。
// ⚠️ 结果和机器有关，只看【改前 vs 改后】的差值，不要拿绝对值跟别的手机比。

import puppeteer from 'puppeteer-core';
import http from 'http';
import fs from 'fs';
import path from 'path';

const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');
const WWW = R + '/www';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const NL = String.fromCharCode(10);
const N = Math.max(50, Number(process.argv[2] || 1200));

const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8' };
const server = http.createServer((req, res) => {
  let q = decodeURIComponent(req.url.split('?')[0]); if (q === '/') q = '/index.html';
  const f = path.join(WWW, q);
  if (!fs.existsSync(f)) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(fs.readFileSync(f));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
});
const page = await browser.newPage();
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await page.setCacheEnabled(false);
const errs = [];
page.on('pageerror', e => errs.push(e.message));

// 所有请求一律本地挡掉：这个脚本只关心渲染，网络不该影响数字。
await page.evaluateOnNewDocument(() => {
  window.__hits = 0;
  const realFetch = window.fetch.bind(window);
  window.fetch = async function (url, opts) {
    const u = String(url);
    if (u.indexOf('/chat/completions') >= 0) {
      window.__hits++;
      const chunk = (o) => 'data: ' + JSON.stringify(o) + String.fromCharCode(10, 10);
      const payload = chunk({ choices: [{ delta: { content: '嗯。' } }] })
        + chunk({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } })
        + 'data: [DONE]' + String.fromCharCode(10, 10);
      return new Response(payload, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    return realFetch(url, opts);
  };
});

await page.goto('http://127.0.0.1:' + port + '/index.html', { waitUntil: 'networkidle0' });
await new Promise(r => setTimeout(r, 700));

// ---------- 造数据 ----------
// 文本故意做得像真的：长短不齐、有标点有换行、偶尔带星号动作。
// 全是「测试消息 1/2/3」那种等长文本，测出来的数字是骗人的。
const FILL = [
  '今天风大，出门忘了戴围巾，脖子被吹得生疼。',
  '我刚从楼下上来，顺手买了杯热的。你要不要？',
  '*把杯子推过去一点*',
  '……算了，你自己看着办。',
  '你上次说的那件事，我后来想了一下。其实也没那么要紧，就是我那会儿有点在意。',
  '（她把手机翻过来扣在桌上，过了好一会儿才拿起来）',
  '嗯。',
  '你要是忙就先去忙，我这边不急。',
  '刚才看到一只很胖的猫，蹲在便利店门口的台阶上，谁走过去都不理。',
  '那个词我记不太清了，好像是「含糊」？还是「含混」？反正就是那个意思。'
];

const seeded = await page.evaluate(async (s) => {
  const o = indexedDB.open('ai-companion', 5);
  const db = await new Promise((res, rej) => { o.onsuccess = () => res(o.result); o.onerror = () => rej(o.error); });
  if (!db.objectStoreNames.contains('messages')) { db.close(); return 'no-store'; }
  const put = (store, rec) => new Promise(r => { const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).put(rec); tx.oncomplete = r; });
  const base = {
    greeting: '（她抬起头看了你一眼）', persona: '你是她。说话短。', avatar: null,
    temperature: 1.0, maxTokens: 2048, topP: 1.0, reasoningEffort: 'low',
    contextRounds: 20, kaomojiFreq: 0, emojiFreq: 0, verbosity: 'medium',
    splitMessages: true, typingDelay: 0, hesitation: false, showTyping: true,
    longMemory: false, allowEditMine: false, descLevel: 'low', povLock: false,
    appearance: '', appearanceOn: true, presetKey: 'blank', createdAt: Date.now()
  };
  await put('characters', Object.assign({ id: 'big', name: '大号角色' }, base));
  await put('characters', Object.assign({ id: 'small', name: '空角色' }, base));
  const now = Date.now();
  const gap = 90 * 1000;
  for (let i = 0; i < s.n; i++) {
    const txt = s.fill[i % s.fill.length] + (i % 7 === 0 ? '' : ' ' + (i + 1));
    await put('messages', {
      id: 'b' + i, charId: 'big', role: i % 2 ? 'assistant' : 'user', content: txt,
      // 带上 parentId：真实库里（分支功能上线后）都是有链的。
      // 不带的话每次进角色 seedParents 都要把几千条补一遍链、写回库 ——
      // 那是「老备份第一次进角色」的一次性成本，会污染基准。
      parentId: i === 0 ? '' : ('b' + (i - 1)),
      ts: now - (s.n - i) * gap,
      story: { day: 1 + Math.floor(i / 120), phase: '上午', season: '', weather: '', hour: 10, minute: 0 }
    });
  }
  await put('kv', { k: 'settings', v: { apiKey: 'sk-bench', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', clockMode: false } });
  await put('kv', { k: 'lastCharId', v: 'small' });
  db.close();
  return 'ok';
}, { n: N, fill: FILL });
if (seeded !== 'ok') { console.log('造数据失败: ' + seeded); await browser.close(); server.close(); process.exit(1); }

await page.reload({ waitUntil: 'networkidle0' });
await new Promise(r => setTimeout(r, 600));

const waitMsgs = (n) => page.waitForFunction(
  (k) => document.querySelectorAll('#messages .msg').length >= k, { timeout: 60000, polling: 25 }, n);

const clickCard = (id) => page.evaluate((cid) => {
  const el = document.querySelector('#char-list .char-card[data-id="' + cid + '"]');
  if (!el) return false;
  el.click();
  return true;
}, id);

// 0.5.4 起首屏只画最近一页（MSG_PAGE=300），所以期望条数是 min(N, 300)。
const PAGED = Math.min(N, 300);

// ---------- 1. 首屏：点角色卡 → 一页消息出来 ----------
const t0 = Date.now();
const clicked = await clickCard('big');
const tClick = Date.now() - t0;
await waitMsgs(PAGED);
const firstPaint = Date.now() - t0;
const dom0 = await page.evaluate(() => document.querySelectorAll('*').length);
const domMsgs = await page.evaluate(() => document.querySelectorAll('#messages .msg').length);
console.log('1. 首屏渲染 ' + domMsgs + '/' + N + ' 条：' + firstPaint + ' ms（点卡 ' + tClick + ' ms），DOM 节点 ' + dom0);

// 1b. 数据层拆账：首屏那几百毫秒到底花在「读库」还是「拼 HTML」上。
// 不拆清楚就会去优化错的地方（0.5.4 实测：分页之后首屏还有 895ms，就不是 HTML 的事了）。
const diag = await page.evaluate(async () => {
  const db = await import('/js/db.js');
  const br = await import('/js/branch.js');
  const t = async (fn) => { const a = performance.now(); const v = await fn(); return [Math.round(performance.now() - a), v]; };
  const [t1, all] = await t(() => db.msgs.list('big', 0, true));
  const [t2, noarch] = await t(() => db.msgs.list('big'));
  const [t3, path] = await t(() => br.activePath('big', noarch));
  const [t4] = await t(() => br.seedParents('big'));
  const [t5, arch] = await t(() => db.msgs.archived('big'));
  return { t1, t2, t3, t4, t5, n: all.length, pn: path.length, an: arch.length };
});
console.log('1b. 读库拆账：getAll(带归档) ' + diag.t1 + ' / getAll(不带) ' + diag.t2 + ' / activePath ' + diag.t3 + ' / seedParents ' + diag.t4 + ' / archived ' + diag.t5 + ' ms（' + diag.n + ' 条中活动 ' + diag.pn + '）');

// ---------- 2. 重绘：切到空角色再切回来 ----------
const repaint = async () => {
  await clickCard('small');
  await page.waitForFunction(() => document.querySelectorAll('#messages .msg').length === 0, { timeout: 20000, polling: 20 }).catch(() => {});
  const a = Date.now();
  await clickCard('big');
  await waitMsgs(PAGED);
  return Date.now() - a;
};
const rp1 = await repaint();
const rp2 = await repaint();
console.log('2. 重绘一次：第一次 ' + rp1 + ' ms / 第二次 ' + rp2 + ' ms');

// ---------- 2b. 点「更早的 N 条」展开一页 ----------
let earlierMs = null;
if (N > PAGED) {
  const b = Date.now();
  await page.evaluate(() => { const el = document.getElementById('load-earlier'); if (el) el.click(); });
  await waitMsgs(PAGED * 2);
  earlierMs = Date.now() - b;
  console.log('2b. 展开一页（' + PAGED + ' → ' + PAGED * 2 + ' 条）：' + earlierMs + ' ms');
}

// ---------- 3. 滚动 60 帧 ----------
const scrollStat = await page.evaluate(async () => {
  const box = document.getElementById('messages');
  const el = document.getElementById('view-chat');
  const sc = box && box.scrollHeight > box.clientHeight ? box : (el || box);
  const gaps = [];
  let last = performance.now();
  sc.scrollTop = 0;
  await new Promise((done) => {
    let i = 0;
    const tick = (now) => {
      gaps.push(now - last); last = now;
      sc.scrollTop = sc.scrollTop + 60;
      if (++i < 60) requestAnimationFrame(tick); else done();
    };
    requestAnimationFrame(tick);
  });
  gaps.shift();
  const avg = gaps.reduce((a, b) => a + b, 0) / Math.max(1, gaps.length);
  const worst = Math.max.apply(null, gaps);
  const over = gaps.filter(g => g > 32).length;
  return { avg: Math.round(avg * 10) / 10, worst: Math.round(worst * 10) / 10, over, n: gaps.length, top: sc.scrollTop };
});
console.log('3. 滚动 60 帧：平均 ' + scrollStat.avg + ' ms/帧（最差 ' + scrollStat.worst + ' ms，超过 32ms 的 ' + scrollStat.over + ' 帧）');

// ---------- 4. 输入 30 个字 ----------
const typing = await page.evaluate(() => {
  const el = document.getElementById('input');
  if (!el) return { err: 'input 不存在' };
  el.focus();
  const txt = '今天风很大我出门的时候忘了戴围巾';
  const a = performance.now();
  for (let i = 1; i <= txt.length; i++) {
    el.value = txt.slice(0, i);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  const b = performance.now();
  el.value = '';
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return { total: Math.round((b - a) * 10) / 10, per: Math.round((b - a) / txt.length * 100) / 100 };
});
console.log('4. 输入 30 字：共 ' + typing.total + ' ms（每字 ' + typing.per + ' ms）');

// ---------- 5. 长按菜单（长按一条消息 → 菜单出现） ----------
const menu = await page.evaluate(async () => {
  const msg = document.querySelector('#messages .msg');
  if (!msg) return { err: '没有消息' };
  const a = performance.now();
  msg.dispatchEvent(new Event('contextmenu', { bubbles: true, cancelable: true }));
  // showMsgMenu 是 async（要先读分支/余温那些），派发完当场查一定查不到 —— 等它一下。
  await new Promise(r => setTimeout(r, 80));
  const el = document.querySelector('.msg-menu');
  const b = performance.now();
  if (el) el.remove();
  return { ms: Math.round((b - a) * 10) / 10, ok: !!el };
});
console.log('5. 长按菜单：' + (menu.err || (menu.ms + ' ms（' + (menu.ok ? '出现了' : '没出现') + '）')));

// ---------- 汇总 ----------
const out = {
  n: N, shown: domMsgs, firstPaint, repaint1: rp1, repaint2: rp2, earlierMs,
  dom: dom0, scrollAvg: scrollStat.avg, scrollWorst: scrollStat.worst,
  scrollOver32: scrollStat.over, typePer: typing.per, menu: menu.ms || null,
  errs
};
console.log(NL + 'PERF-JSON ' + JSON.stringify(out));
await browser.close();
server.close();
