// e2e-v517.mjs —— 0.5.1.7 四条止血的【真行为】验证（外部评审 §二 / §六）
//
// 评审的原话：「新测试是读源码，不是用产品」。所以这一套不进源码、只动界面：
//   1. 切支归档对称：来回切两趟，A 支的归档必须还在（旧版会被洗成未归档）
//   2. 清空聊天 + 剧情卡：卡留着，但演到第几拍 / 每拍几轮 / 上一拍结果必须清零
//   3. 自动串联能停：先证明它真的会自己往下写，再证明"进阅读模式/拉抽屉"能刹住
//   4. 阅读模式的外壳：顶栏 / 横幅 / 群名单 / 输入栏在浏览器里真的是 display:none
//
// 全部走真实点击与真实 IndexedDB 读回，不 grep CSS、不 grep 源码。

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
  window.__hits = { chat: [] };
  const realFetch = window.fetch.bind(window);
  window.fetch = async function (url, opts) {
    const u = String(url);
    let body = {};
    try { body = JSON.parse((opts && opts.body) || '{}'); } catch (e) {}
    if (u.includes('/chat/completions')) {
      if (body.stream === false) {
        return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      window.__hits.chat.push(body);
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
  await page.evaluate(() => { window.__hits.chat.length = 0; });
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await sleep(1200);
}

const baseChar = (id, name, extra) => Object.assign({
  id, name, greeting: '（' + name + '）你在啊。', persona: '你是' + name + '。',
  avatar: null, temperature: 1.0, maxTokens: 2048, topP: 1.0, reasoningEffort: 'low',
  contextRounds: 20, kaomojiFreq: 0, emojiFreq: 0,
  verbosity: 'medium', splitMessages: false, typingDelay: 0, hesitation: false,
  showTyping: true, longMemory: false, allowEditMine: false,
  descLevel: 'low', povLock: false, appearance: '', appearanceOn: true,
  presetKey: 'blank', createdAt: Date.now()
}, extra || {});

const SETTINGS = { apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', clockMode: false, historyTime: false };

const dbRows = (cid) => page.evaluate(async (id) => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const rows = await new Promise(r => { const q = db.transaction('messages').objectStore('messages').index('charId').getAll(id); q.onsuccess = () => r(q.result || []); });
  db.close();
  return rows;
}, cid);
const kvGet = (k) => page.evaluate(async (kk) => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const v = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get(kk); q.onsuccess = () => r(q.result && q.result.v); });
  db.close();
  return v;
}, k);
const shown = () => page.evaluate(() => [...document.querySelectorAll('#messages .msg')].map(e => e.dataset.id));

const menuOpen = async (id) => {
  await page.evaluate(mid => {
    const el = [...document.querySelectorAll('#messages .msg')].find(e => e.dataset.id === mid);
    if (el) el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  }, id);
  for (let i = 0; i < 80; i++) {
    if (await page.evaluate(() => !!document.querySelector('.msg-menu'))) return true;
    await sleep(100);
  }
  return false;
};
const clickMenu = async (label, ms = 8000) => {
  for (let i = 0; i < Math.ceil(ms / 120); i++) {
    const ok = await page.evaluate((lb) => {
      const b = [...document.querySelectorAll('.msg-menu button')].find(x => x.textContent.trim() === lb);
      if (b) { b.click(); return true; }
      return false;
    }, label);
    if (ok) return true;
    await sleep(120);
  }
  return false;
};
const waitIdle = async () => {
  await sleep(400);
  for (let i = 0; i < 300; i++) {
    const busyNow = await page.$eval('#btn-stop', el => !el.classList.contains('hidden')).catch(()=>false);
    if (!busyNow) return;
    await sleep(80);
  }
};

// ============================================================
console.log('');
console.log('=== 1. 切支归档对称（来回切两趟，A 支的归档必须还在） ===');
// 结构：B 支的入口那条一开始就在归档里，A 支那条是正常展开的 ——
// 状态完全真实（归档区里就长这样），而且两条支各有自己的入口，单向漏气藏不住：
//   r ─→ aA1 ─┬→ uA2(未归档) ─→ aA2   ← A 支，初始活动叶子
//             └→ uB2(归档)   ─→ aB2   ← B 支
// 要验证的三件事：切过去把目标支的归档放回来 / 切回来把它收回去 /
// 再切一趟不会把 A 支那条正常展开的也收掉。
const CA = 'v517br';
const T0 = 1790000000000;
const MA = (id, role, content, ts, parentId, archived) =>
  ({ id, charId: CA, role, content, ts, parentId, ...(archived ? { archived: true } : {}) });
await hardReset();
await seed({
  chars: [baseChar(CA, '归档测')],
  kv: [{ k: 'settings', v: SETTINGS }, { k: 'lastCharId', v: CA }, { k: 'greeted:' + CA, v: true },
       { k: 'branch:' + CA, v: 'aA2' }],
  msgs: [
    MA('r',   'user',      '开头',     T0 + 1, ''),
    MA('aA1', 'assistant', 'A 的第一答', T0 + 2, 'r'),
    MA('uA2', 'user',      'A 第二句',  T0 + 3, 'aA1'),
    MA('aA2', 'assistant', 'A 的第二答', T0 + 4, 'uA2'),
    MA('uB2', 'user',      'B 第二句',  T0 + 5, 'aA1', true),
    MA('aB2', 'assistant', 'B 的第二答', T0 + 6, 'uB2')
  ]
});
const archOf = async () => {
  const rows = await dbRows(CA);
  const m = Object.fromEntries(rows.map(r => [r.id, !!r.archived]));
  return m;
};
let A = await archOf();
t('★ 初始：B 支入口还在归档里，A 支是展开的', A.uA2 === false && A.uB2 === true, JSON.stringify(A));
t('初始活动叶子是 A 支末端', (await kvGet('branch:' + CA)) === 'aA2', String(await kvGet('branch:' + CA)));

// 切到 B 支（从 A 支入口那条的兄弟切过去）
await menuOpen('uA2');
const it1 = await page.evaluate(() => [...document.querySelectorAll('.msg-menu button')].map(b => b.textContent.trim()));
t('★ 界面上真的能切（菜单里有「切到另一个走向」）', it1.some(x => x.includes('切到另一个走向')), JSON.stringify(it1));
await clickMenu(it1.find(x => x.includes('切到另一个走向')));
await waitIdle(); await sleep(600);
A = await archOf();
t('★ 切到 B 支：B 支入口那条归档被放回来了（不然屏幕是空的）', A.uB2 === false, JSON.stringify(A));
t('切到 B 支：A 支那条没被碰', A.uA2 === false, JSON.stringify(A));
t('切到 B 支后活动叶子落到 B 支末端', (await kvGet('branch:' + CA)) === 'aB2', String(await kvGet('branch:' + CA)));

// 切回 A 支
await menuOpen('uB2');
const it2 = await page.evaluate(() => [...document.querySelectorAll('.msg-menu button')].map(b => b.textContent.trim()));
await clickMenu(it2.find(x => x.includes('切到另一个走向')));
await waitIdle(); await sleep(600);
A = await archOf();
t('★ 切回 A 支：B 支那条归档【收回去】了（放回去 ≠ 取消归档）', A.uB2 === true, JSON.stringify(A));
t('切回 A 支：A 支那条没被误收', A.uA2 === false, JSON.stringify(A));
const kept1 = await kvGet('unarch:' + CA);
t('记账已清空（没有要还原的了）', Array.isArray(kept1) && kept1.length === 0, JSON.stringify(kept1));

// 再切到 B 支 —— 这一趟是旧版漏气的那一步
await menuOpen('uA2');
const it3 = await page.evaluate(() => [...document.querySelectorAll('.msg-menu button')].map(b => b.textContent.trim()));
await clickMenu(it3.find(x => x.includes('切到另一个走向')));
await waitIdle(); await sleep(600);
A = await archOf();
t('★ 第二趟切到 B：B 支的归档又放回来了', A.uB2 === false, JSON.stringify(A));
t('★ 第二趟切到 B：A 支那条依然展开（旧版这里会把归档状态洗掉）', A.uA2 === false, JSON.stringify(A));
const kept2 = await kvGet('unarch:' + CA);
t('记账里现在只有 B 支那条', Array.isArray(kept2) && kept2.includes('uB2') && !kept2.includes('uA2'), JSON.stringify(kept2));

// ============================================================
console.log('');
console.log('=== 2. 清空聊天：剧情卡留着，但"演到哪儿"必须清零 ===');
const CC = 'v517arc';
await hardReset();
await seed({
  chars: [baseChar(CC, '剧情测')],
  kv: [
    { k: 'settings', v: SETTINGS }, { k: 'lastCharId', v: CC }, { k: 'greeted:' + CC, v: true },
    { k: 'branch:' + CC, v: 'c2' },
    { k: 'arc:' + CC, v: {
      v: 3, title: '旧物', direction: '从互相试探到摊牌', constraints: ['不无故和解'],
      beats: [
        { t: '试探', goal: '她先开口问那件旧物', obs: '他不肯承认还记得', turn: '她把东西摔了',
          done: true, doneBy: 'user', result: '她真摔了', turns: 5 },
        { t: '僵住', goal: '两个人都停在原地', obs: '谁也不先低头', turn: '她转身走了',
          done: false, doneBy: '', result: '', turns: 3 }
      ],
      agenda: {}, autoJudge: false, currentBeat: 1, status: 'on', minTurns: 4, updatedAt: 1
    } }
  ],
  msgs: [
    { id: 'c1', charId: CC, role: 'user', content: '一句', ts: T0 + 1, parentId: '' },
    { id: 'c2', charId: CC, role: 'assistant', content: '一答', ts: T0 + 2, parentId: 'c1' }
  ]
});
t('剧情卡初始在第 2 拍（索引 1）', (await kvGet('arc:' + CC)).currentBeat === 1, JSON.stringify((await kvGet('arc:' + CC)).currentBeat));
t('顶栏显示「剧情 · 2/2」', (await page.$eval('#chat-arc', el => el.textContent)).includes('2/2'), await page.$eval('#chat-arc', el => el.textContent));

await page.evaluate(() => document.getElementById('btn-clear-chat').click());
await sleep(400);
const clickModal = async (which) => {
  for (let i = 0; i < 100; i++) {
    const ok = await page.evaluate(w => {
      const box = document.getElementById('modal');
      if (!box || box.classList.contains('hidden')) return false;
      const b = document.getElementById(w === 'ok' ? 'modal-ok' : 'modal-cancel');
      if (!b || b.classList.contains('hidden')) return false;
      const txt = (document.querySelector('#modal .modal-box') || {}).textContent || '';
      b.click(); return txt;
    }, which);
    if (ok) return ok;
    await sleep(100);
  }
  return '';
};
const txt1 = await clickModal('ok');      // 清空聊天记录 → 清空
await sleep(400);
const txt2 = await clickModal('ok');      // 真的确定？→ 确定清空
await sleep(600);
const txt3 = await clickModal('cancel');  // 剧情卡也清掉吗？→ 取消 = 留着
await waitIdle(); await sleep(800);
t('★ 弹窗明说会从第 1 拍重新开始', String(txt3).includes('第 1 拍重新开始'), String(txt3).slice(0, 160));

const arc = await kvGet('arc:' + CC);
t('★ 卡还在（方向没被清）', !!arc && arc.direction === '从互相试探到摊牌' && arc.beats.length === 2, JSON.stringify(arc && arc.direction));
t('★ 清空后回到第 1 拍', arc.currentBeat === 0, String(arc.currentBeat));
t('★ 每拍的轮数清零', arc.beats.every(b => b.turns === 0), JSON.stringify(arc.beats.map(b => b.turns)));
t('★ 演完的标记与上一拍结果清掉',
  arc.beats.every(b => b.done === false && b.doneBy === '' && b.result === ''),
  JSON.stringify(arc.beats.map(b => [b.done, b.doneBy, b.result])));
t('★ 卡仍在跑（status=on），不是 done', arc.status === 'on', arc.status);
t('拍的正文一个字没动', arc.beats[0].goal === '她先开口问那件旧物' && arc.beats[1].turn === '她转身走了', JSON.stringify(arc.beats.map(b => b.goal)));
t('顶栏回到「剧情 · 1/2」', (await page.$eval('#chat-arc', el => el.textContent)).includes('1/2'), await page.$eval('#chat-arc', el => el.textContent));
const left = await dbRows(CC);
t('聊天记录清空了（只剩开场白补回来的一条）',
  left.length <= 1 && left.every(r => r.role === 'assistant'), JSON.stringify(left.map(r => r.role)));

// ============================================================
console.log('');
console.log('=== 3. 自动串联：先证明它会自己写，再证明能停 ===');
const CE = 'v517ch';
await hardReset();
await seed({
  chars: [baseChar(CE, '串联测', { verbosity: 'epic', epicChain: 3 })],
  kv: [{ k: 'settings', v: SETTINGS }, { k: 'lastCharId', v: CE }, { k: 'greeted:' + CE, v: true }],
  msgs: [
    { id: 'e1', charId: CE, role: 'user', content: '写一段', ts: T0 + 1, parentId: '' },
    { id: 'e2', charId: CE, role: 'assistant', content: '先写过一段。', ts: T0 + 2, parentId: 'e1' }
  ]
});
await page.evaluate(() => document.getElementById('btn-continue') && document.getElementById('btn-continue').click());
await waitIdle();
await sleep(6000);
let hits = await page.evaluate(() => window.__hits.chat.length);
t('★ 对照组：不管它，它真的会自己接着往下写（至少 2 次请求）', hits >= 2, '请求数 ' + hits);
t('对照组：连续写到了第 3 段就停（epicChain=3）', hits === 3, '请求数 ' + hits);

// 实验组：重来一次，第一段一结束就拉抽屉
await page.evaluate(() => { window.__hits.chat.length = 0; });
await page.evaluate(() => document.getElementById('btn-continue').click());
// 等第一段结束（btn-stop 从显示到隐藏）
await sleep(300);
for (let i = 0; i < 300; i++) {
  const busyNow = await page.$eval('#btn-stop', el => !el.classList.contains('hidden')).catch(()=>false);
  if (!busyNow) break;
  await sleep(50);
}
await page.evaluate(() => document.getElementById('btn-settings').click());
await sleep(6000);
hits = await page.evaluate(() => window.__hits.chat.length);
t('★ 拉抽屉之后不再往下写（只剩第 1 段那一次请求）', hits === 1, '请求数 ' + hits);

// 阅读模式同样能刹住
await page.evaluate(() => { window.__hits.chat.length = 0; const m = document.getElementById('drawer'); if (m) m.click(); });
await sleep(500);
await page.evaluate(() => document.getElementById('btn-continue').click());
await sleep(300);
for (let i = 0; i < 300; i++) {
  const busyNow = await page.$eval('#btn-stop', el => !el.classList.contains('hidden')).catch(()=>false);
  if (!busyNow) break;
  await sleep(50);
}
await page.evaluate(() => {
  // 直接点阅读模式：从抽屉进
  document.getElementById('btn-settings').click();
});
await sleep(400);
await page.evaluate(() => {
  const b = [...document.querySelectorAll('#drawer-menu [data-wb-drawer]')].find(x => x.dataset.wbDrawer === 'read');
  if (b) b.click();
});
await sleep(6000);
hits = await page.evaluate(() => window.__hits.chat.length);
t('★ 进阅读模式之后也不往下写', hits === 1, '请求数 ' + hits);

// ============================================================
console.log('');
console.log('=== 4. 阅读模式的外壳在浏览器里真的不可见 ===');
const shell = await page.evaluate(() => {
  const disp = (sel) => { const e = document.querySelector(sel); return e ? getComputedStyle(e).display : 'missing'; };
  return {
    inReading: document.getElementById('messages').classList.contains('reading'),
    topbar: disp('#view-chat .topbar'),
    banner: disp('#setup-banner'),
    roster: disp('#group-roster'),
    composer: disp('#view-chat .composer'),
    barrow: disp('#view-chat .bar-row'),
  };
});
t('★ 现在确实在阅读模式', shell.inReading === true, JSON.stringify(shell));
t('★ 顶栏不可见', shell.topbar === 'none', shell.topbar);
t('★ API 横幅不可见', shell.banner === 'none' || shell.banner === 'missing', shell.banner);
t('★ 群聊名单不可见', shell.roster === 'none' || shell.roster === 'missing', shell.roster);
t('★ 输入栏不可见', shell.composer === 'none', shell.composer);
t('★ 三条操作条不可见', shell.barrow === 'none', shell.barrow);

t('全程没有未捕获异常', errs.length === 0, errs.join(' | '));

console.log('');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close();
server.close();
process.exit(fail > 0 ? 1 : 0);
