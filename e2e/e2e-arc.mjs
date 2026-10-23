// e2e-arc.mjs —— 剧情卡（v0.5.0）
//
// 覆盖：
//   1. 顶栏按钮存在、默认不带卡
//   2. 新建一张卡：方向 + 两拍 → 落库、顶栏变成「剧情 · 1/2」
//   3. 提示词：只注入当前拍，后面那拍的「终点」写在「别一轮演完」里
//   4. 换到第 2 拍再发 → 注入的是第 2 拍
//   5. 「不能发生什么」进了提示词
//   6. 关掉剧情 → 顶栏复位、提示词里不再有剧情段，但内容还在库
//   7. 换角色：另一个人的卡不串味
//   8. 一张空卡保存 → status=off，不注入
//   9. 删掉一拍 → 当前拍越界自动夹回
//  11. 空拍卡不能假装开启；删卡 / 撤销 / 清空的写失败要说失败
//  10. 旁路（关掉 / 重新开启 / 推进）也要问约束超限；取消完成清 result；空推进不出撤销条

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
      // 非流式 = 一次性小请求（记忆整理 / 剧情卡自动判定走 onceChat）。
      // 剧情卡自动判定会问「这一拍演完没有」，这里一律回 done:true —— 好让 e2e 验证
      // 「判到 done 就标记、但绝不自己推进」这条契约。
      if (body.stream === false) {
        window.__hits.once = (window.__hits.once || 0) + 1;
        return new Response(JSON.stringify({ choices: [{ message: { content: '{"done":true,"result":"她松口了","confidence":0.9}' } }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      window.__hits.chat.push(body);
      const chunk = (o) => 'data: ' + JSON.stringify(o) + String.fromCharCode(10,10);
      const payload =
        chunk({ choices: [{ delta: { content: '嗯。' } }] }) +
        chunk({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 5 } }) +
        'data: [DONE]' + String.fromCharCode(10,10);
      return new Response(payload, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    return realFetch(url, opts);
  };
});

async function seed(spec) {
  return await page.evaluate(async (s) => {
    const o = indexedDB.open('ai-companion');
    const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
    const put = (store, rec) => new Promise(r => { const tx = db.transaction(store,'readwrite'); tx.objectStore(store).put(rec); tx.oncomplete = r; });
    for (const c of (s.chars||[])) await put('characters', c);
    for (const e of (s.kv||[])) await put('kv', e);
    for (const m of (s.msgs||[])) await put('messages', m);
    db.close();
  }, spec);
}

const baseChar = (id, name, extra) => Object.assign({
  id, name, greeting: '（' + name + '）', persona: '你是' + name + '。',
  avatar: null, temperature: 1.0, maxTokens: 2048, topP: 1.0, reasoningEffort: 'low',
  contextRounds: 20, kaomojiFreq: 0, emojiFreq: 0,
  verbosity: 'medium', splitMessages: false, typingDelay: 0, hesitation: false,
  showTyping: true, longMemory: false, allowEditMine: false,
  descLevel: 'low', povLock: false, appearance: '', appearanceOn: true,
  presetKey: 'blank', createdAt: Date.now()
}, extra || {});

async function pickChar(id) {
  await page.evaluate(async (cid) => {
    const o = indexedDB.open('ai-companion');
    const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
    await new Promise(r => { const tx = db.transaction('kv','readwrite'); tx.objectStore('kv').put({ k:'lastCharId', v: cid }); tx.oncomplete = r; });
    db.close();
    location.reload();
  }, id);
  await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30000 }).catch(()=>{});
  await sleep(900);
}

async function say(text) {
  await page.evaluate(t => {
    const el = document.getElementById('input');
    el.value = t; el.dispatchEvent(new Event('input', { bubbles: true }));
  }, text);
  await sleep(120);
  await page.evaluate(() => document.getElementById('btn-send').click());
  for (let i = 0; i < 60; i++) {
    const b = await page.$eval('#btn-stop', el => !el.classList.contains('hidden')).catch(()=>false);
    if (b) break;
    await sleep(100);
  }
  for (let i = 0; i < 200; i++) {
    const b = await page.$eval('#btn-stop', el => !el.classList.contains('hidden')).catch(()=>false);
    if (!b) break;
    await sleep(100);
  }
  await sleep(400);
}

const kvGet = (k) => page.evaluate(async (kk) => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const v = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get(kk); q.onsuccess = () => r(q.result && q.result.v); });
  db.close();
  return v;
}, k);

const arcBar = () => page.$eval('#chat-arc', el => ({ text: el.textContent.trim(), on: el.classList.contains('on') })).catch(() => null);

/** 最后一次发给模型的 system+全部消息拼一起 —— 剧情卡只在提示词里，不看正文。 */
const lastPrompt = async () => {
  const h = await page.evaluate(() => window.__hits.chat);
  if (!h.length) return '';
  const b = h[h.length - 1];
  return (b.messages || []).map(m => m.content || '').join(String.fromCharCode(10));
};
const clearHits = () => page.evaluate(() => { window.__hits.chat = []; });

/** 长按（contextmenu）打开某条消息的菜单 —— 和 e2e-composer 里同一套。 */
async function menuOpen(id) {
  await page.evaluate(mid => {
    const el = [...document.querySelectorAll('#messages .msg')].find(e => e.dataset.id === mid);
    if (el) el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  }, id);
  await sleep(320);
}
async function menuClick(k) {
  await page.evaluate(kk => {
    const b = [...document.querySelectorAll('.msg-menu button')].find(x => x.dataset.k === kk);
    if (b) b.click();
  }, k);
  await sleep(500);
  const open = await page.$eval('#modal', el => !el.classList.contains('hidden')).catch(() => false);
  if (open) { await page.evaluate(() => document.getElementById('modal-ok').click()); await sleep(500); }
}
const msgsOf = (cid) => page.evaluate(async (id) => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const all = await new Promise(r => { const q = db.transaction('messages').objectStore('messages').getAll(); q.onsuccess = () => r(q.result || []); });
  db.close();
  return all.filter(m => m.charId === id).sort((a, b) => (a.ts || 0) - (b.ts || 0));
}, cid);
/** 整张卡一共演了多少轮 —— 重抽不该动它。 */
const sumTurns = (a) => (a && a.beats ? a.beats.reduce((x, b) => x + (b.turns || 0), 0) : 0);

/** 走界面开卡：填方向、加两拍、填第一拍、保存。 */
async function makeStory(title, dir, cons) {
  await page.evaluate(() => document.getElementById('chat-arc').click());
  await sleep(200);
  const open = await page.$eval('#arc-modal', el => !el.classList.contains('hidden'));
  t('点顶栏能打开剧情卡弹窗', open === true);
  await page.evaluate((d) => {
    const el = document.getElementById('arc-direction');
    el.value = d; el.dispatchEvent(new Event('input', { bubbles: true }));
  }, dir);
  if (title) await page.evaluate((x) => {
    const el = document.getElementById('arc-title');
    el.value = x; el.dispatchEvent(new Event('input', { bubbles: true }));
  }, title);
  if (cons) await page.evaluate((x) => {
    const el = document.getElementById('arc-constraints');
    el.value = x; el.dispatchEvent(new Event('input', { bubbles: true }));
  }, cons);
  // 加两拍
  await page.evaluate(() => document.getElementById('arc-add-beat').click());
  await sleep(150);
  await page.evaluate(() => document.getElementById('arc-add-beat').click());
  await sleep(150);
  const cnt = await page.$eval('#arc-beats-cnt', el => el.textContent.trim());
  t('加两拍后计数是 2 / 12', cnt === '2 / 12', cnt);
  // 填第一拍
  await page.evaluate(() => {
    const b = document.querySelectorAll('#arc-beats .arc-beat')[0];
    const set = (f, v) => { const el = b.querySelector('[data-f="' + f + '"]'); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
    set('t', '试探');
    set('goal', '她先开口问那件旧物');
    set('obs', '他不肯承认还记得');
    set('turn', '她把东西摔了');
  });
  // 第二拍
  await page.evaluate(() => {
    const b = document.querySelectorAll('#arc-beats .arc-beat')[1];
    const set = (f, v) => { const el = b.querySelector('[data-f="' + f + '"]'); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
    set('t', '摊牌');
    set('goal', '两个人把话说开');
    set('obs', '谁都不想先低头');
    set('turn', '她走了');
  });
  await sleep(120);
  await page.evaluate(() => document.getElementById('arc-save').click());
  await sleep(400);
}

/**
 * 点某一拍的 ✕，走【应用自己的确认弹窗】（v0.5.0.1 起不再是原生 confirm）。
 * @param idx 索引；'last' 表示最后一拍
 */
async function delBeat(idx) {
  await page.evaluate((i) => {
    const list = document.querySelectorAll('#arc-beats .arc-beat');
    const b = i === 'last' ? list[list.length - 1] : list[i];
    if (b) b.querySelector('[data-act="del"]').click();
  }, idx);
  await sleep(250);
  const shown = await page.$eval('#modal', el => !el.classList.contains('hidden')).catch(() => false);
  t('删拍先弹应用自己的确认框', shown === true);
  await page.evaluate(() => document.getElementById('modal-ok').click());
  await sleep(250);
}

// —— 起步 ——
// ⚠️ CI 的 runner 是 en-US，而界面语言默认「跟随系统」——不钉中文，
//    下面所有读中文文案的断言在 CI 上必红（e2e-i18n 里踩过同一次）。
await page.evaluateOnNewDocument(() => {
  Object.defineProperty(navigator, 'language', { get: () => 'zh-CN', configurable: true });
  Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh'], configurable: true });
});

await page.goto('http://127.0.0.1:' + port + '/index.html', { waitUntil: 'networkidle0' });
await sleep(600);
const C1 = 'arcA', C2 = 'arcB';
await seed({
  chars: [
    baseChar(C1, '红白', { greeting: '在。' }),
    baseChar(C2, '蓝白', { greeting: '……' }),
  ],
  // 没有 key 的话前端根本不会发请求，提示词就无从查起
  kv: [ { k: 'settings', v: { apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', clockMode: false } } ],
});
await pickChar(C1);
await sleep(600);

console.log('— 1. 默认没有卡 —');
let bar = await arcBar();
t('顶栏有剧情按钮', !!bar);
t('默认不亮', bar && bar.on === false, JSON.stringify(bar));
// v0.5.3.2（清单 §7.5）：空卡不再在顶栏占一个像"有内容"的位置，改写成「＋剧情」
t('默认文案就是「＋剧情」（空卡不装成有内容）', bar && bar.text === '＋剧情', bar && bar.text);
const before = await kvGet('arc:' + C1);
t('默认库里没有这张卡', !before, JSON.stringify(before));

console.log('— 2. 新建一张卡 —');
await makeStory('红蓝的旧物', '从互相试探到摊牌，但谁都不先承认在意。', '不无故和解\n不突然失忆');
const modalOpen = await page.$eval('#arc-modal', el => !el.classList.contains('hidden'));
t('保存后弹窗关掉', modalOpen === false);
bar = await arcBar();
t('顶栏亮了', bar && bar.on === true, JSON.stringify(bar));
t('顶栏显示第 1 拍 / 共 2 拍', bar && bar.text === '剧情 · 1/2', bar && bar.text);
const card = await kvGet('arc:' + C1);
t('卡落到 kv 里', !!card && card.status === 'on', JSON.stringify(card && card.status));
t('卡里有 2 拍', card && Array.isArray(card.beats) && card.beats.length === 2, card && card.beats && card.beats.length);
t('第 1 拍的名字存下来了', card && card.beats[0].t === '试探', card && card.beats[0] && card.beats[0].t);
t('不能发生的事存下来了', card && card.constraints.length === 2 && card.constraints[1] === '不突然失忆', card && JSON.stringify(card.constraints));
t('当前拍是第 0 拍', card && card.currentBeat === 0, card && card.currentBeat);

console.log('— 3. 提示词里只有当前这一拍 —');
await clearHits();
await say('……');
let sys = await lastPrompt();
t('提示词里有剧情段', sys.includes('这段剧情的走向'), sys.slice(0, 120));
t('带上了段名', sys.includes('「红蓝的旧物」'), '');
t('带上了方向', sys.includes('从互相试探到摊牌'), '');
t('演的是第 1 拍', sys.includes('试探') && sys.includes('她先开口问那件旧物'), '');
t('第 1 拍的障碍也进去了', sys.includes('他不肯承认还记得'), '');
t('终点标明是「别这一轮给」', sys.includes('她把东西摔了') && sys.includes('这一轮别给'), '');
t('没把第 2 拍的内容当成本轮要演的', !sys.includes('第 2 拍（共 2 拍）'), '');
t('「不能发生」进了提示词', sys.includes('不无故和解') && sys.includes('不突然失忆'), '');

console.log('— 4. 换到第 2 拍 —');
await page.evaluate(() => document.getElementById('chat-arc').click());
await sleep(250);
await page.evaluate(() => {
  const b = document.querySelectorAll('#arc-beats .arc-beat')[1];
  b.querySelector('[data-act="set"]').click();
});
await sleep(200);
const nowCur = await page.evaluate(() => {
  const i = [...document.querySelectorAll('#arc-beats .arc-beat')].findIndex(el => el.classList.contains('cur'));
  return i;
});
t('点「设为当前」后第 2 拍高亮', nowCur === 1, String(nowCur));
await page.evaluate(() => document.getElementById('arc-save').click());
await sleep(400);
bar = await arcBar();
t('顶栏变成 2/2', bar && bar.text === '剧情 · 2/2', bar && bar.text);
await clearHits();
await say('……');
sys = await lastPrompt();
t('这一轮演的是第 2 拍', sys.includes('摊牌') && sys.includes('两个人把话说开'), '');
t('第 1 拍不再出现', !sys.includes('她先开口问那件旧物'), '');

console.log('— 5. 换角色不串味 —');
await pickChar(C2);
await sleep(600);
bar = await arcBar();
t('换到没卡的角色，顶栏复位', bar && bar.on === false && bar.text === '＋剧情', JSON.stringify(bar));
await clearHits();
await say('嗯。');
sys = await lastPrompt();
t('她的提示词里没有别人的剧情', !sys.includes('这段剧情的走向'), sys.slice(0, 120));

console.log('— 6. 关掉剧情 —');
await pickChar(C1);
await sleep(600);
await page.evaluate(() => document.getElementById('chat-arc').click());
await sleep(250);
await page.evaluate(() => document.getElementById('arc-off').click());
await sleep(400);
bar = await arcBar();
// v0.5.0.2：关掉的卡显示「剧情 · 关」，不再和「从没建过」共用裸「剧情」
t('关掉后顶栏显示「剧情 · 关」', bar && bar.on === false && bar.text === '剧情 · 关', JSON.stringify(bar));
const offCard = await kvGet('arc:' + C1);
t('关掉后内容还在库里', !!offCard && offCard.status === 'off' && offCard.beats.length === 2, JSON.stringify(offCard && offCard.status));
t('关掉后方向也还在', offCard && offCard.direction.includes('互相试探'), offCard && offCard.direction);
await clearHits();
await say('……');
sys = await lastPrompt();
t('关掉后不再注入剧情段', !sys.includes('这段剧情的走向'), '');
t('关掉后拍也没进提示词', !sys.includes('她先开口问那件旧物'), '');

console.log('— 7. 空卡 —');
await page.evaluate(() => document.getElementById('chat-arc').click());
await sleep(250);
await page.evaluate(() => {
  ['arc-title','arc-direction','arc-constraints'].forEach(id => {
    const el = document.getElementById(id); el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true }));
  });
});
// 把两拍全删掉
for (let i = 0; i < 2; i++) await delBeat(0);
const emptyCnt = await page.$eval('#arc-beats-cnt', el => el.textContent.trim());
t('删空后计数是 0 / 12', emptyCnt === '0 / 12', emptyCnt);
const emptyTip = await page.$eval('#arc-beats .arc-empty', el => el.textContent.trim()).catch(() => '');
t('空的时候有提示语', emptyTip.includes('还没拍'), emptyTip);
await page.evaluate(() => document.getElementById('arc-save').click());
await sleep(400);
const emptyCard = await kvGet('arc:' + C1);
t('空卡存成 off', !!emptyCard && emptyCard.status === 'off', JSON.stringify(emptyCard && emptyCard.status));
t('空卡没有拍', emptyCard && emptyCard.beats.length === 0, emptyCard && emptyCard.beats && emptyCard.beats.length);
bar = await arcBar();
t('空卡顶栏不亮', bar && bar.on === false, JSON.stringify(bar));

console.log('— 8. 删拍时当前拍越界夹回 —');
await page.evaluate(() => document.getElementById('chat-arc').click());
await sleep(250);
await page.evaluate(() => {
  const el = document.getElementById('arc-direction');
  el.value = '测试越界'; el.dispatchEvent(new Event('input', { bubbles: true }));
  document.getElementById('arc-add-beat').click();
});
await sleep(150);
await page.evaluate(() => document.getElementById('arc-add-beat').click());
await sleep(150);
// 两拍都填点东西 —— 空拍存盘时会被丢掉，这节测的是「删拍后索引夹回」
await page.evaluate(() => {
  [...document.querySelectorAll('#arc-beats .arc-beat')].forEach((b, i) => {
    const el = b.querySelector('[data-f="t"]');
    el.value = '拍' + (i + 1); el.dispatchEvent(new Event('input', { bubbles: true }));
  });
});
await sleep(120);
await page.evaluate(() => {
  const b = document.querySelectorAll('#arc-beats .arc-beat')[1];
  b.querySelector('[data-act="set"]').click();
});
await sleep(150);
await delBeat('last');
await page.evaluate(() => document.getElementById('arc-save').click());
await sleep(400);
const c2 = await kvGet('arc:' + C1);
t('删掉当前拍后 currentBeat 夹回 0', c2 && c2.currentBeat === 0, c2 && c2.currentBeat);
t('只剩一拍', c2 && c2.beats.length === 1, c2 && c2.beats && c2.beats.length);

console.log('— 9. 英文界面（v0.5.0.1）—');
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/;
/** 把弹窗里所有【可见文本节点】收出来 —— input 的 value 不算，那是用户填的 */
const arcTexts = () => page.evaluate(() => {
  const out = [];
  const walk = (n) => {
    if (n.nodeType === 3) { const s = n.textContent.trim(); if (s) out.push(s); }
    else if (n.nodeType === 1) {
      // #arc-now-b 是「Beat 1: 拍1」—— 界面词 + 用户自己填的拍名拼起来的，
      // 用户数据不该被翻译，所以整块跳过，单独断言前缀。
      if (n.id === 'arc-now-b') return;
      for (const c of n.childNodes) walk(c);
    }
  };
  walk(document.getElementById('arc-modal'));
  return out;
});

await page.evaluate(() => document.getElementById('chat-arc').click());
await sleep(300);
const zhTexts = await arcTexts();
console.log('   中文: ' + JSON.stringify(zhTexts));
t('中文下弹窗文案是中文（有「这段叫什么」）', zhTexts.includes('这段叫什么'), JSON.stringify(zhTexts.slice(0, 6)));
await page.evaluate(() => document.getElementById('arc-cancel').click());
await sleep(200);

// 走界面切英文（和用户真实路径一致）
await page.evaluate(() => document.getElementById('btn-settings').click()); await sleep(700);
await page.evaluate(() => { const b = [...document.querySelectorAll('#drawer-menu [data-wb-drawer]')].find(x => x.dataset.wbDrawer === 'mine'); if (b) b.click(); }); await sleep(800);
await page.evaluate(() => { const s = document.getElementById('s-lang'); s.value = 'en'; s.dispatchEvent(new Event('change', { bubbles: true })); }); await sleep(800);
await page.evaluate(() => { const b = document.getElementById('btn-mine-back'); if (b) b.click(); }); await sleep(400);
await page.evaluate(() => { const b = document.getElementById('btn-drawer-close'); if (b && document.querySelector('#view-drawer.active')) b.click(); }); await sleep(600);

bar = await arcBar();
t('★ 英文下顶栏带进度（不是裸 Plot）', bar && bar.text === 'Plot 1/1', bar && bar.text);
// ⚠️ 这一条是防 applyI18n 的：它 200ms 后会拿 data-i18n-en 覆盖剧情条
await sleep(700);
bar = await arcBar();
t('★ 等过观察者之后进度还在', bar && bar.text === 'Plot 1/1', bar && bar.text);

await page.evaluate(() => document.getElementById('chat-arc').click());
await sleep(400);
const enTexts = await arcTexts();
console.log('   英文: ' + JSON.stringify(enTexts));
const enBad = enTexts.filter(s => CJK.test(s));
t('★ 英文下弹窗里没有中文文本', enBad.length === 0, JSON.stringify(enBad));
const nowB = await page.$eval('#arc-now-b', el => el.textContent);
t('英文下「现在演到」用英文前缀（拍名是用户数据，不翻）', /^Beat 1/.test(nowB), nowB);
const enPh = await page.evaluate(() => [...document.querySelectorAll('#arc-modal [placeholder]')].map(e => e.getAttribute('placeholder')));
t('★ 英文下 placeholder 也翻完了', enPh.every(s => !CJK.test(s)), JSON.stringify(enPh));
const enTitle = await page.$eval('#chat-arc', el => el.getAttribute('title'));
t('英文下剧情条的 title 是英文', !CJK.test(enTitle || ''), enTitle);
// 英文下删拍的确认框也得是英文
await page.evaluate(() => {
  const b = document.querySelector('#arc-beats .arc-beat');
  if (b) b.querySelector('[data-act="del"]').click();
});
await sleep(350);
const modalTxt = await page.evaluate(() => document.getElementById('modal-title').textContent + '|' + document.getElementById('modal-text').textContent);
t('英文下删拍确认框是英文', !CJK.test(modalTxt), modalTxt);
await page.evaluate(() => document.getElementById('modal-cancel').click());
await sleep(250);
const stillOne = await page.$eval('#arc-beats-cnt', el => el.textContent.trim());
t('取消确认后拍还在', stillOne === '1 / 12', stillOne);
await page.evaluate(() => document.getElementById('arc-cancel').click());
await sleep(200);

// 切回中文
await page.evaluate(() => document.getElementById('btn-settings').click()); await sleep(700);
await page.evaluate(() => { const b = [...document.querySelectorAll('#drawer-menu [data-wb-drawer]')].find(x => x.dataset.wbDrawer === 'mine'); if (b) b.click(); }); await sleep(800);
await page.evaluate(() => { const s = document.getElementById('s-lang'); s.value = 'zh'; s.dispatchEvent(new Event('change', { bubbles: true })); }); await sleep(800);
await page.evaluate(() => { const b = document.getElementById('btn-mine-back'); if (b) b.click(); }); await sleep(400);
await page.evaluate(() => { const b = document.getElementById('btn-drawer-close'); if (b && document.querySelector('#view-drawer.active')) b.click(); }); await sleep(600);
bar = await arcBar();
t('★ 切回中文逐字还原', bar && bar.text === '剧情 · 1/1', bar && bar.text);
await page.evaluate(() => document.getElementById('chat-arc').click());
await sleep(300);
const backTexts = await arcTexts();
t('★ 中文下弹窗文案逐字还原', JSON.stringify(backTexts) === JSON.stringify(zhTexts), JSON.stringify(backTexts));
await page.evaluate(() => document.getElementById('arc-cancel').click());
await sleep(200);

console.log('— 10. 推进 / 结果 / 撤销 / 终态（v0.5.0.3）—');
// 第 9 节结束时 C1 只剩一拍、currentBeat=0。先加一拍变成两拍。
await page.evaluate(() => document.getElementById('chat-arc').click());
await sleep(300);
const agaHidden = await page.evaluate(() => document.getElementById('arc-aga').classList.contains('hidden'));
t('单聊里没有「各人的目的」那一块', agaHidden === true, agaHidden);
await page.evaluate(() => document.getElementById('arc-add-beat').click());
await sleep(200);
const cnt2 = await page.$eval('#arc-beats-cnt', el => el.textContent.trim());
t('加一拍之后是 2 / 12', cnt2 === '2 / 12', cnt2);
// 第 1 拍写结果、第 2 拍写名字和目标（推进之后提示词里要能看见它们）
await page.evaluate(() => {
  const bs = document.querySelectorAll('#arc-beats .arc-beat');
  const r = bs[0].querySelector('[data-f="result"]');
  r.value = '他把旧物收进了抽屉'; r.dispatchEvent(new Event('input', { bubbles: true }));
  const t2 = bs[1].querySelector('[data-f="t"]');
  t2.value = '收尾'; t2.dispatchEvent(new Event('input', { bubbles: true }));
  const g2 = bs[1].querySelector('[data-f="goal"]');
  g2.value = '两个人把话说开'; g2.dispatchEvent(new Event('input', { bubbles: true }));
});
const nowZh = await page.$eval('#arc-now-b', el => el.textContent.trim());
t('「现在演到」显示当前拍', nowZh.startsWith('第 1 拍'), nowZh);
const nextTxt = await page.$eval('#arc-next', el => el.textContent.trim());
t('还有下一拍时按钮是「演下一拍 →」', nextTxt === '演下一拍 →', nextTxt);

// ① 推进即落盘：点完【不点保存】，库里就该已经是新的
await page.evaluate(() => document.getElementById('arc-next').click());
await sleep(350);
const nowZh2 = await page.$eval('#arc-now-b', el => el.textContent.trim());
t('★ 点推进后走到第 2 拍', nowZh2.startsWith('第 2 拍'), nowZh2);
const done1 = await page.evaluate(() => document.querySelectorAll('#arc-beats .arc-beat')[0].classList.contains('done'));
t('★ 第 1 拍被标成演完了', done1 === true, done1);
const nextTxt2 = await page.$eval('#arc-next', el => el.textContent.trim());
t('最后一拍的按钮变成「这一段演完了 →」', nextTxt2 === '这一段演完了 →', nextTxt2);
const c3 = await kvGet('arc:' + C1);
t('★ 推进立刻落盘（一次都没点保存）',
  !!c3 && c3.currentBeat === 1 && c3.beats.length === 2
  && c3.beats[0].done === true && c3.beats[0].result === '他把旧物收进了抽屉'
  && c3.beats[1].done === false && c3.status === 'on',
  JSON.stringify(c3 && { cb: c3.currentBeat, st: c3.status, d: c3.beats.map(x => x.done), r: c3.beats[0].result }));
// v0.5.0.4：ARC_SCHEMA 2 → 3。这个数字以前是只写不读的装饰品，现在
// normalizeArc 真的会拿它判断要不要做老形态转换（v1 的 agenda 数组 → v2 的对象）。
t('★ 卡上记了结构版本 v=3', !!c3 && c3.v === 3, String(c3 && c3.v));

// ② 撤销：一次点击把刚才那步退回去（推进是可以后悔的）
const undoShown = await page.evaluate(() => !document.getElementById('arc-undo').classList.contains('hidden'));
t('★ 推进后出现「撤销」', undoShown === true, undoShown);
await page.evaluate(() => document.getElementById('arc-undo').click());
await sleep(350);
const c4 = await kvGet('arc:' + C1);
t('★ 撤销把当前拍退回去、done 也清了',
  !!c4 && c4.currentBeat === 0 && c4.beats[0].done === false,
  JSON.stringify(c4 && { cb: c4.currentBeat, d: c4.beats.map(x => x.done) }));
// 再推一次，回到第 2 拍（后面要验提示词）
await page.evaluate(() => document.getElementById('arc-next').click());
await sleep(350);
await page.evaluate(() => document.getElementById('arc-cancel').click());
await sleep(250);
bar = await arcBar();
t('顶栏停在第 2 拍', bar && bar.text === '剧情 · 2/2', bar && bar.text);

// ③ 上一拍的结果、节奏轮数都要进提示词
await say('嗯');
const up = await lastPrompt();
t('★ 上一拍的结果进了提示词', up.includes('他把旧物收进了抽屉'), up.slice(-400));
t('★ 并且明说上一拍已经过去、别再演一遍', up.includes('别再演一遍'), '');
const t1 = await kvGet('arc:' + C1);
t('每说一轮，当前拍的轮数 +1', !!t1 && t1.beats[1].turns === 1, String(t1 && t1.beats[1].turns));
await say('嗯');
const up2 = await lastPrompt();
t('★ 还没够最少轮数时明确说不准收',
  up2.includes('现在还不够') && up2.includes('至少 4 轮'), up2.slice(-500));
const t2 = await kvGet('arc:' + C1);
t('轮数继续累加', !!t2 && t2.beats[1].turns === 2, String(t2 && t2.beats[1].turns));

// ③-b 点「继续」也是一段叙事（v0.5.1.6 修，外部评审 §五）
// 以前条件是「!regen && !cont」：自动串联 4 段只记 1 轮，
// 提示词却对模型说"这一拍才演 1 轮，至少 4 轮才算演完" —— 她会照这个假数字拖节奏。
await page.evaluate(() => { const b = document.getElementById('btn-continue'); if (b) b.click(); });
for (let i = 0; i < 40; i++) {
  const b = await page.$eval('#btn-stop', el => !el.classList.contains('hidden')).catch(() => false);
  if (b) break;
  await sleep(100);
}
for (let i = 0; i < 200; i++) {
  const b = await page.$eval('#btn-stop', el => !el.classList.contains('hidden')).catch(() => false);
  if (!b) break;
  await sleep(100);
}
await sleep(400);
const t2b = await kvGet('arc:' + C1);
t('★ 点「继续」也计一轮（续写也是一段叙事）', !!t2b && t2b.beats[1].turns === 3,
  String(t2b && t2b.beats[1].turns));

// ④ 最后一拍也收掉 → 整段进终态，之后不再进提示词
await page.evaluate(() => document.getElementById('chat-arc').click());
await sleep(350);
await page.evaluate(() => document.getElementById('arc-next').click());
await sleep(450);
const c7 = await kvGet('arc:' + C1);
t('★ 演完最后一拍，整段进 done',
  !!c7 && c7.status === 'done' && c7.beats[1].done === true,
  JSON.stringify(c7 && { st: c7.status, cb: c7.currentBeat, d: c7.beats.map(x => x.done) }));
const finTxt = await page.$eval('#arc-now-b', el => el.textContent.trim());
t('弹窗里显示「这一段演完了」', finTxt === '这一段演完了', finTxt);
const finBtn = await page.$eval('#arc-next', el => el.textContent.trim());
t('出口变成「开新一段」', finBtn === '开新一段', finBtn);
await page.evaluate(() => document.getElementById('arc-cancel').click());
await sleep(250);
bar = await arcBar();
t('★ 顶栏变成「剧情 · 完」', bar && bar.text === '剧情 · 完', bar && bar.text);
await say('嗯');
const up3 = await lastPrompt();
t('★ 演完之后不再进提示词', !up3.includes('这段剧情的走向'), up3.slice(-300));

// ⑤ 开新一段：清空白，聊天记录不动
await page.evaluate(() => document.getElementById('chat-arc').click());
await sleep(350);
await page.evaluate(() => document.getElementById('arc-next').click());
await sleep(400);
const nvTitle = await page.$eval('#modal-title', el => el.textContent.trim());
t('终态点那颗按钮走的是「开新一段」确认', nvTitle === '开新一段', nvTitle);
await page.evaluate(() => document.getElementById('modal-ok').click());
await sleep(500);
const c8 = await kvGet('arc:' + C1);
t('开新一段之后卡是空的、也不注入',
  !!c8 && !c8.direction && c8.beats.length === 0 && c8.status === 'off',
  JSON.stringify(c8 && { st: c8.status, n: c8.beats.length }));
bar = await arcBar();
t('顶栏回到「＋剧情」', bar && bar.text === '＋剧情', bar && bar.text);

console.log('— 11. 自动判定 beta（v0.5.0.3）—');
await page.evaluate(() => {
  document.getElementById('arc-direction').value = '自动判定用';
  document.getElementById('arc-add-beat').click();
});
await sleep(250);
await page.evaluate(() => {
  const b = document.querySelector('#arc-beats .arc-beat');
  const g = b.querySelector('[data-f="goal"]');
  g.value = '两个人把话说开'; g.dispatchEvent(new Event('input', { bubbles: true }));
  document.getElementById('arc-auto').checked = true;
});
await page.evaluate(() => document.getElementById('arc-save').click());
await sleep(500);
const a1 = await kvGet('arc:' + C1);
t('自动判定开关落库、一拍没演完',
  !!a1 && a1.autoJudge === true && a1.beats.length === 1 && a1.beats[0].done === false,
  JSON.stringify(a1 && { a: a1.autoJudge, n: a1.beats.length, d: a1.beats.map(x => x.done) }));
// 界面没有 minTurns 入口（默认 4 轮），这里直接改库把它调成 1 —— 否则要真跑 4 轮
await page.evaluate(async (cid) => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const key = 'arc:' + cid;
  const cur = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get(key); q.onsuccess = () => r(q.result && q.result.v); });
  cur.minTurns = 1;
  await new Promise(r => { const tx = db.transaction('kv','readwrite'); tx.objectStore('kv').put({ k: key, v: cur }); tx.oncomplete = r; });
  db.close();
}, C1);
await say('嗯');
await sleep(1600);   // onceChat 是 fire-and-forget，等它回来落库
const c9 = await kvGet('arc:' + C1);
t('★ 自动判定把当前拍标成演完了，但不自己推进',
  !!c9 && c9.beats[0].done === true && c9.currentBeat === 0,
  JSON.stringify(c9 && { cb: c9.currentBeat, d: c9.beats.map(x => x.done) }));
t('★ 判定顺手把「实际发生了什么」写进了 result', !!c9 && c9.beats[0].result === '她松口了', JSON.stringify(c9 && c9.beats[0].result));
const inlineShown = await page.evaluate(() => !document.getElementById('arc-inline').classList.contains('hidden'));
t('★ 底部出现内联推进条', inlineShown === true, inlineShown);
await page.evaluate(() => { const b = document.querySelector('#arc-inline [data-act="go"]'); if (b) b.click(); });
await sleep(500);
const c10 = await kvGet('arc:' + C1);
t('内联条点推进 → 这一段演完了', !!c10 && c10.status === 'done', String(c10 && c10.status));

console.log('— 12. 群聊的各人目的 —');
// 群聊：卡里有「各人的目的」，单聊没有
await seed({ chars: [Object.assign(baseChar('G1', '群聊', { isGroup: true, memberIds: [C1, C2] }))] });
await pickChar('G1');
await page.evaluate(() => document.getElementById('chat-arc').click());
await sleep(450);
const agaShown = await page.evaluate(() => !document.getElementById('arc-aga').classList.contains('hidden'));
t('★ 群聊里出现「各人的目的」', agaShown === true, agaShown);
const agaRows = await page.evaluate(() => document.querySelectorAll('#arc-aga-list [data-aga]').length);
t('每个成员一行', agaRows === 2, agaRows);
await page.evaluate(() => {
  document.getElementById('arc-direction').value = '群聊方向测试';
  document.getElementById('arc-add-beat').click();
});
await sleep(250);
await page.evaluate(() => {
  const el = document.querySelector('#arc-aga-list [data-aga]');
  el.value = '想让她先开口'; el.dispatchEvent(new Event('input', { bubbles: true }));
});
await sleep(150);
await page.evaluate(() => document.getElementById('arc-save').click());
await sleep(450);
const g1 = await kvGet('arc:G1');
t('★ 群聊的 agenda 落库', !!g1 && Object.keys(g1.agenda || {}).length === 1,
  JSON.stringify(g1 && g1.agenda));
// 群聊真的把「谁想要什么」写进提示词（只给名字的话模型会让所有人替同一件事说话）
await say('嗯');
const gp = await lastPrompt();
t('★ 群聊提示词里有各人的目的', gp.includes('这一场里各人想要的东西不一样') && gp.includes('想让她先开口'),
  gp.slice(-600));

console.log('— 13. 删卡 —');
await page.evaluate(() => document.getElementById('chat-arc').click());
await sleep(450);
await page.evaluate(() => document.getElementById('arc-del-card').click());
await sleep(400);
const delTitle = await page.$eval('#modal-title', el => el.textContent.trim());
t('删卡走的是 confirmBox', delTitle === '删掉这张卡', delTitle);
await page.evaluate(() => document.getElementById('modal-ok').click());
await sleep(500);
const goneG = await kvGet('arc:G1');
t('★ 删卡后库里没有这张卡', !goneG || !goneG.direction, JSON.stringify(goneG));
t('别的角色的卡不受影响', !!(await kvGet('arc:' + C1)), '');
bar = await arcBar();
t('删卡后顶栏回到「＋剧情」', bar && bar.text === '＋剧情', bar && bar.text);

console.log('— 14. 状态诚实：off 是真暂停 / 推进可撤销 / 重抽不涨轮（v0.5.0.4）—');
await pickChar(C2);
await sleep(500);
await page.evaluate(() => document.getElementById('chat-arc').click());
await sleep(350);
await page.evaluate(() => {
  const d = document.getElementById('arc-direction');
  d.value = '状态测试'; d.dispatchEvent(new Event('input', { bubbles: true }));
  document.getElementById('arc-add-beat').click();
});
await sleep(260);
await page.evaluate(() => {
  const b = document.querySelector('#arc-beats .arc-beat');
  const g = b.querySelector('[data-f="goal"]');
  g.value = '把话说开'; g.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.evaluate(() => document.getElementById('arc-save').click());
await sleep(450);
let s1 = await kvGet('arc:' + C2);
t('新建的卡是 on', !!s1 && s1.status === 'on', String(s1 && s1.status));

await page.evaluate(() => document.getElementById('chat-arc').click());
await sleep(350);
await page.evaluate(() => document.getElementById('arc-off').click());
await sleep(450);
s1 = await kvGet('arc:' + C2);
t('关掉之后是 off，内容留着',
  !!s1 && s1.status === 'off' && s1.direction === '状态测试' && s1.beats.length === 1,
  JSON.stringify(s1 && { st: s1.status, d: s1.direction, n: s1.beats.length }));

await page.evaluate(() => document.getElementById('chat-arc').click());
await sleep(350);
const offbarOn = await page.evaluate(() => !document.getElementById('arc-offbar').classList.contains('hidden'));
t('★ off 卡的弹窗顶上有黄条', offbarOn === true, offbarOn);
const nextDis = await page.evaluate(() => document.getElementById('arc-next').disabled);
t('★ off 卡的「这一拍演完了」是禁用的（点了也不会静默成功）', nextDis === true, nextDis);

await page.evaluate(() => {
  const d = document.getElementById('arc-direction');
  d.value = '状态测试改过'; d.dispatchEvent(new Event('input', { bubbles: true }));
  document.getElementById('arc-save').click();
});
await sleep(450);
s1 = await kvGet('arc:' + C2);
t('★ off 卡改内容再保存 → 仍然是 off（不再偷偷重开）',
  !!s1 && s1.status === 'off' && s1.direction === '状态测试改过',
  JSON.stringify(s1 && { st: s1.status, d: s1.direction }));

await page.evaluate(() => document.getElementById('chat-arc').click());
await sleep(350);
await page.evaluate(() => document.getElementById('arc-add-beat').click());
await sleep(260);
await page.evaluate(() => document.getElementById('arc-save').click());
await sleep(450);
s1 = await kvGet('arc:' + C2);
t('★ off 卡加一拍再保存 → 仍然是 off', !!s1 && s1.status === 'off' && s1.beats.length === 2,
  JSON.stringify(s1 && { st: s1.status, n: s1.beats.length }));

await page.evaluate(() => document.getElementById('chat-arc').click());
await sleep(350);
await page.evaluate(() => document.getElementById('arc-on').click());
await sleep(450);
s1 = await kvGet('arc:' + C2);
t('★「重新开启」把它变回 on', !!s1 && s1.status === 'on', String(s1 && s1.status));
t('重开之后黄条消失',
  (await page.evaluate(() => !document.getElementById('arc-offbar').classList.contains('hidden'))) === false);
await page.evaluate(() => document.getElementById('arc-cancel').click());
await sleep(260);

// —— 推进可撤销 ——
// 界面没有 minTurns 入口（默认 4 轮），直接改库调成 1，否则要真跑 4 轮。
await page.evaluate(async (cid) => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const key = 'arc:' + cid;
  const cur = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get(key); q.onsuccess = () => r(q.result && q.result.v); });
  cur.minTurns = 1;
  cur.autoJudge = true;
  await new Promise(r => { const tx = db.transaction('kv','readwrite'); tx.objectStore('kv').put({ k: key, v: cur }); tx.oncomplete = r; });
  db.close();
}, C2);
await say('嗯');
await sleep(1600);
const u1 = await kvGet('arc:' + C2);
const inlineUp = await page.evaluate(() => !document.getElementById('arc-inline').classList.contains('hidden'));
t('自动判定之后底部出现内联条', inlineUp === true, inlineUp);
await page.evaluate(() => { const b = document.querySelector('#arc-inline [data-act="go"]'); if (b) b.click(); });
await sleep(600);
const u2 = await kvGet('arc:' + C2);
t('inline 推进 → 走到下一拍', u2.currentBeat === u1.currentBeat + 1,
  JSON.stringify({ before: u1.currentBeat, after: u2.currentBeat }));
const undoThere = await page.evaluate(() => !!document.querySelector('#arc-inline [data-act="undo"]'));
t('★ 推进后内联条变成「撤销」', undoThere === true, undoThere);
await page.evaluate(() => { const b = document.querySelector('#arc-inline [data-act="undo"]'); if (b) b.click(); });
await sleep(600);
const u3 = await kvGet('arc:' + C2);
t('★ 点「撤销」→ 回到推进前那一拍', u3.currentBeat === u1.currentBeat,
  JSON.stringify({ want: u1.currentBeat, got: u3.currentBeat }));

// —— 重抽不涨轮 ——
const lastBot = (await msgsOf(C2)).filter(m => m.role !== 'user').pop();
const a0 = await kvGet('arc:' + C2);
await menuOpen(lastBot.id);
await menuClick('regen');
await sleep(1500);
const a1x = await kvGet('arc:' + C2);
t('★ 重新生成不涨 turns（重抽不算新的一轮）', sumTurns(a1x) === sumTurns(a0),
  JSON.stringify({ before: sumTurns(a0), after: sumTurns(a1x) }));

// —— 结构版本真的参与收编（不再只是写进去当记号）——
const vconv = await page.evaluate(async () => {
  const m = await import('/js/storyarc.js');
  const old = m.normalizeArc({ v: 1, direction: 'x', agenda: [{ id: 'u1', want: '想回去' }] });
  const neu = m.normalizeArc({ v: 3, direction: 'x', agenda: { u1: '想回去' } });
  return { v: old.v, ag: old.agenda, same: JSON.stringify(old.agenda) === JSON.stringify(neu.agenda) };
});
t('★ v1 的数组形态 agenda 被转成对象', !!vconv.ag && vconv.ag.u1 === '想回去', JSON.stringify(vconv));
t('转出来的结果和直接存对象形态一模一样', vconv.same === true, JSON.stringify(vconv));
t('收编之后版本号写成当前值', vconv.v === 3, String(vconv.v));

// —— 约束超上限：不再静默截断 ——
// ⚠️ 上一步重抽之后弹窗是关着的，这里得先打开 —— 否则下面的 #arc-save 是在隐藏容器里被点中的，
//    照样能触发保存，但「取消之后留在弹窗里」这条断言就测不到真东西。
await page.evaluate(() => document.getElementById('chat-arc').click());
await sleep(400);
const tenLines = Array.from({ length: 10 }, (_, i) => '第' + (i + 1) + '条').join(String.fromCharCode(10));
await page.evaluate((v) => {
  const el = document.getElementById('arc-constraints');
  el.value = v; el.dispatchEvent(new Event('input', { bubbles: true }));
}, tenLines);
await sleep(200);
const cntTxt = await page.$eval('#arc-cnt-c', el => el.textContent.trim());
t('约束计数上限定在 8', cntTxt === '10 / 8', cntTxt);
await page.evaluate(() => document.getElementById('arc-save').click());
await sleep(400);
const cTitle = await page.$eval('#modal-title', el => el.textContent.trim());
t('★ 超过 8 条时保存先问一句，不静默丢', cTitle === '「不能发生什么」写多了', cTitle);
await page.evaluate(() => document.getElementById('modal-cancel').click());
await sleep(300);
const stillOpen = await page.evaluate(() =>
  !document.getElementById('arc-modal').classList.contains('hidden')
  && document.getElementById('modal').classList.contains('hidden'));
t('取消之后就留在弹窗里，什么都没存', stillOpen === true, stillOpen);
const aNoSave = await kvGet('arc:' + C2);
t('取消之后库里一条约束都没多', !!aNoSave && (aNoSave.constraints || []).length === 0,
  JSON.stringify(aNoSave && aNoSave.constraints));
await page.evaluate(() => document.getElementById('arc-save').click());
await sleep(400);
await page.evaluate(() => document.getElementById('modal-ok').click());
await sleep(500);
const a2x = await kvGet('arc:' + C2);
t('★ 确认之后只留 8 条', !!a2x && a2x.constraints.length === 8, JSON.stringify(a2x && a2x.constraints));

console.log('— 16. 旁路不静默 / 取消完成清 result / 空推进不吭声（v0.5.0.4 追加）—');

/** 直接写一张剧情卡进 kv（跳过界面，好构造"已经坏了"的状态）。 */
const putArc = (arc) => page.evaluate(async (a) => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  await new Promise(r => { const tx = db.transaction('kv','readwrite'); tx.objectStore('kv').put({ k: 'arc:' + a.owner, v: a.arc }); tx.oncomplete = r; });
  db.close();
}, arc);

const mkArc = (over) => Object.assign({
  v: 3, status: 'on', title: '旁路', direction: '测一遍旁路', constraints: ['不和解'],
  currentBeat: 0, minTurns: 1, autoJudge: false,
  beats: [
    { t: '第一拍', goal: '往前走', obs: '有人不肯动', turn: '走到底', done: false, doneBy: '', result: '', turns: 1 },
    { t: '第二拍', goal: '收尾', obs: '', turn: '', done: false, doneBy: '', result: '', turns: 0 },
  ],
}, over || {});

const tenC = Array.from({ length: 10 }, (_, i) => '第' + (i + 1) + '条').join('\n');
const setCons = (v) => page.evaluate((x) => {
  const el = document.getElementById('arc-constraints');
  el.value = x; el.dispatchEvent(new Event('input', { bubbles: true }));
}, v);

await putArc({ owner: C2, arc: mkArc() });
await pickChar(C2);
await sleep(600);
await page.evaluate(() => document.getElementById('chat-arc').click());
await sleep(400);

// —— ① 关掉剧情也会落盘，超限照样得问 ——
await setCons(tenC);
await sleep(160);
await page.evaluate(() => document.getElementById('arc-off').click());
await sleep(420);
const offAsk = await page.$eval('#modal-title', el => el.textContent.trim()).catch(() => '');
t('★ 点「关掉剧情」时约束超限也要先问一句', offAsk === '「不能发生什么」写多了', offAsk);
await page.evaluate(() => document.getElementById('modal-cancel').click());
await sleep(320);
const aStill = await kvGet('arc:' + C2);
t('★ 取消之后卡还是 on、库里的约束一条没动',
  !!aStill && aStill.status === 'on' && (aStill.constraints || []).length === 1,
  JSON.stringify(aStill && { st: aStill.status, c: aStill.constraints }));

// —— ② 推进前也会落盘，同样得问 ——
await page.evaluate(() => document.getElementById('arc-next').click());
await sleep(420);
const nxAsk = await page.$eval('#modal-title', el => el.textContent.trim()).catch(() => '');
t('★ 点「这一拍演完了」也一样先问', nxAsk === '「不能发生什么」写多了', nxAsk);
await page.evaluate(() => document.getElementById('modal-cancel').click());
await sleep(320);
const aStill2 = await kvGet('arc:' + C2);
t('取消之后一拍都没推进', !!aStill2 && aStill2.currentBeat === 0, String(aStill2 && aStill2.currentBeat));

// —— ③ 重新开启同样走守卫 ——
await setCons('不和解');
await sleep(140);
await page.evaluate(() => document.getElementById('arc-off').click());
await sleep(460);
const off1 = await kvGet('arc:' + C2);
t('约束没超时照常关掉', !!off1 && off1.status === 'off', String(off1 && off1.status));
await page.evaluate(() => document.getElementById('chat-arc').click());
await sleep(400);
await setCons(tenC);
await sleep(160);
await page.evaluate(() => document.getElementById('arc-on').click());
await sleep(420);
const onAsk = await page.$eval('#modal-title', el => el.textContent.trim()).catch(() => '');
t('★ 点「重新开启」时约束超限也要先问', onAsk === '「不能发生什么」写多了', onAsk);
await page.evaluate(() => document.getElementById('modal-cancel').click());
await sleep(320);
const off2 = await kvGet('arc:' + C2);
t('取消之后仍然是 off', !!off2 && off2.status === 'off', String(off2 && off2.status));

// —— ④ 取消「已演完」要把 result 一起清掉 ——
await putArc({ owner: C2, arc: mkArc({
  beats: [
    { t: '第一拍', goal: '往前走', done: true, doneBy: 'user', result: '旧结论不成立', turns: 1 },
    { t: '第二拍', goal: '收尾', turns: 0 },
  ],
}) });
await pickChar(C2);
await sleep(600);
await page.evaluate(() => document.getElementById('chat-arc').click());
await sleep(400);
await page.evaluate(() => {
  const b = document.querySelectorAll('#arc-beats .arc-beat')[0];
  const x = b && b.querySelector('[data-act="done"]');
  if (x) x.click();
});
await sleep(220);
await page.evaluate(() => document.getElementById('arc-save').click());
await sleep(460);
const dr = await kvGet('arc:' + C2);
t('★ 手点取消「已演完」→ result 一起清（旧结论不许诈尸）',
  !!dr && dr.beats[0].done === false && dr.beats[0].result === '',
  JSON.stringify(dr && { done: dr.beats[0].done, result: dr.beats[0].result }));

// —— ⑤ 一步没动就别摆「撤销」 ——
await putArc({ owner: C2, arc: mkArc({ autoJudge: true }) });
await pickChar(C2);
await sleep(600);
await clearHits();
await say('嗯');
await sleep(1900);
const inkUp = await page.evaluate(() => !document.getElementById('arc-inline').classList.contains('hidden'));
t('自动判定照旧弹内联条（前置条件）', inkUp === true, inkUp);
// 条还在屏幕上，但卡"已经从别处被关掉了" —— 点推进应该一声不响，而不是装作推进成功
await putArc({ owner: C2, arc: mkArc({ status: 'off' }) });
await page.evaluate(() => { const b = document.querySelector('#arc-inline [data-act="go"]'); if (b) b.click(); });
await sleep(650);
const goUndo = await page.evaluate(() => !!document.querySelector('#arc-inline [data-act="undo"]'));
t('★ 空推进不出现「撤销」按钮', goUndo === false, goUndo);
const s5 = await kvGet('arc:' + C2);
t('库里的当前拍没被动过', !!s5 && s5.currentBeat === 0, String(s5 && s5.currentBeat));

// —— ⑥ 状态不变量：status==='on' ⟺ 有方向或有写了字的拍 ——
const inv = await page.evaluate(async () => {
  const m = await import('/js/storyarc.js');
  const emptyOnly = m.normalizeArc({ v: 3, status: 'on', direction: '', beats: [{ t: '', goal: '', obs: '', turn: '' }] });
  const withDir = m.normalizeArc({ v: 3, status: 'on', direction: 'x', beats: [{ t: '', goal: '', obs: '', turn: '' }] });
  const jump = m.prevDoneBeat({ v: 3, status: 'on', direction: 'x', currentBeat: 2,
    beats: [{ t: 'a', done: true }, { t: 'b' }, { t: 'c' }] });
  const near = m.prevDoneBeat({ v: 3, status: 'on', direction: 'x', currentBeat: 2,
    beats: [{ t: 'a', done: true }, { t: 'b', done: true }, { t: 'c' }] });
  const cases = [];
  for (const d of ['', 'x']) {
    for (const bs of [[], [{ t: '' }], [{ t: 'a' }], [{ t: '', done: true }]]) {
      cases.push(m.normalizeArc({ v: 3, status: 'on', direction: d, beats: bs.map(b => Object.assign({}, b)) }));
    }
  }
  const aligned = cases.every(a => (a.status === 'on') === (!!a.direction || a.beats.some(b => b.t || b.goal || b.obs || b.turn)));
  return { emptyOnly: emptyOnly.status, withDir: withDir.status, dirActive: m.arcActive(withDir), jump, near, aligned, n: cases.length };
});
t('★ 只有空拍的卡被强制成 off（不再是 on 但 arcActive=false）', inv.emptyOnly === 'off', inv.emptyOnly);
t('有方向 + 空拍仍然是 on，不算空卡', inv.withDir === 'on' && inv.dirActive === true, JSON.stringify(inv));
t('★ status 与 arcActive 在 ' + inv.n + ' 种组合上全部一致', inv.aligned === true, String(inv.aligned));
t('★ 跳过中间拍时不再把更早的拍当成「上一拍」', inv.jump === -1, String(inv.jump));
t('紧邻的上一拍演完了就认它', inv.near === 1, String(inv.near));

// —— ⑦ 静态：新弹的内联条必须先把旧定时器掐掉 ——
const appSrc = fs.readFileSync(WWW + '/js/app.js', 'utf8');
const inlBody = (appSrc.match(/function showArcInline\([\s\S]*?\n}/) || [''])[0];
t('★ showArcInline 先 clearTimeout（旧条不会把新条提前藏掉）',
  /clearTimeout\(_arcInlineTimer\)/.test(inlBody), inlBody.slice(0, 200).replace(/\n/g, ' '));

console.log('— 17. 写失败要说失败 / 空卡不能假装开启 —');

// —— ① 空拍的卡点「重新开启」必须开不了 ——
await putArc({ owner: C2, arc: {
  v: 3, status: 'off', title: '', direction: '', constraints: [], currentBeat: 0, minTurns: 1, autoJudge: false,
  beats: [{ t: '', goal: '', obs: '', turn: '', done: false, doneBy: '', result: '', turns: 0 }],
} });
await pickChar(C2);
await sleep(600);
await page.evaluate(() => document.getElementById('chat-arc').click());
await sleep(420);
const offbarOpen = await page.evaluate(() => !document.getElementById('arc-offbar').classList.contains('hidden'));
t('空拍的卡确实是 off（弹窗顶上有黄条）', offbarOpen === true, offbarOpen);
await page.evaluate(() => document.getElementById('arc-on').click());
await sleep(450);
const emptyOn = await kvGet('arc:' + C2);
t('★ 空拍卡点「重新开启」→ 库里仍是 off（不假开启）',
  !!emptyOn && emptyOn.status === 'off', String(emptyOn && emptyOn.status));
const barEmpty = await arcBar();
t('★ 顶栏没有被点亮（status 与 arcActive 仍然一致）', barEmpty && barEmpty.on === false, JSON.stringify(barEmpty));
const toastEmpty = await page.$eval('#toast', el => el.textContent.trim()).catch(() => '');
t('★ 说的是「还是空的」，不是「已重新开启」',
  toastEmpty.includes('还是空的') && !toastEmpty.includes('已重新开启'), toastEmpty);

// —— ①b 开新一段写失败：界面不许先清空 ——
await putArc({ owner: C2, arc: mkArc({
  status: 'done',
  beats: [{ t: '演完的一拍', goal: '走到终点', turn: '', done: true, doneBy: 'user', result: '真发生了', turns: 2 }],
}) });
await pickChar(C2);
await sleep(600);
await page.evaluate(() => document.getElementById('chat-arc').click());
await sleep(420);
await page.evaluate(() => {
  window.__putN = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function () { throw new DOMException('quota', 'QuotaExceededError'); };
});
await page.evaluate(() => document.getElementById('arc-next').click());   // done 卡 → 开新一段
await sleep(350);
await page.evaluate(() => document.getElementById('modal-ok').click());
await sleep(500);
const newArcToast = await page.$eval('#toast', el => el.textContent.trim()).catch(() => '');
t('★ 开新一段写失败时说「保存失败」', newArcToast.includes('保存失败'), newArcToast);
t('★ 没说过「清空了」', !newArcToast.includes('清空了'), newArcToast);
const keepOld = await kvGet('arc:' + C2);
t('★ 旧卡还在库里（方向没被清）', !!keepOld && keepOld.direction === '测一遍旁路',
  JSON.stringify(keepOld && keepOld.direction));
const dirBox = await page.$eval('#arc-direction', el => el.value).catch(() => '');
t('★ 界面上的方向也没被清空（清了一半等于骗了一半）', dirBox === '测一遍旁路', dirBox);
await page.evaluate(() => { IDBObjectStore.prototype.put = window.__putN; });

// —— ② 删卡写失败：不许说「已删掉」——
await putArc({ owner: C2, arc: mkArc() });
await pickChar(C2);
await sleep(600);
await page.evaluate(() => document.getElementById('chat-arc').click());
await sleep(420);
await page.evaluate(() => {
  window.__del0 = IDBObjectStore.prototype.delete;
  window.__put0 = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.delete = function () { throw new DOMException('quota', 'QuotaExceededError'); };
  IDBObjectStore.prototype.put = function () { throw new DOMException('quota', 'QuotaExceededError'); };
});
await page.evaluate(() => document.getElementById('arc-del-card').click());
await sleep(350);
await page.evaluate(() => document.getElementById('modal-ok').click());
await sleep(500);
const delToast = await page.$eval('#toast', el => el.textContent.trim()).catch(() => '');
t('★ 删卡写失败时说的是「删不掉」', delToast.includes('删不掉'), delToast);
t('★ 没说过「剧情卡已删掉」', !delToast.includes('已删掉'), delToast);
const worldAfterDel = await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const v = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get('arc:arcB'); q.onsuccess = () => r(q.result && q.result.v); });
  db.close();
  return v;
});
t('★ 卡还在库里（没有假装删掉）', !!worldAfterDel && worldAfterDel.direction === '测一遍旁路',
  JSON.stringify(worldAfterDel && worldAfterDel.direction));
const modalStill = await page.evaluate(() => !document.getElementById('arc-modal').classList.contains('hidden'));
t('★ 弹窗没关（关了就等于宣布删成功）', modalStill === true, modalStill);
await page.evaluate(() => {
  IDBObjectStore.prototype.delete = window.__del0;
  IDBObjectStore.prototype.put = window.__put0;
});

// —— ③ 撤销推进写失败：按钮留着、别报「撤回上一拍」——
await putArc({ owner: C2, arc: mkArc({
  beats: [
    { t: '第一拍', goal: '往前走', done: false, doneBy: '', result: '', turns: 1 },
    { t: '第二拍', goal: '收尾', turns: 0 },
  ],
}) });
await pickChar(C2);
await sleep(600);
await page.evaluate(() => document.getElementById('chat-arc').click());
await sleep(420);
await page.evaluate(() => document.getElementById('arc-next').click());
await sleep(700);
const afterAdv = await kvGet('arc:' + C2);
t('推进成功一次（前置）', !!afterAdv && afterAdv.currentBeat === 1, String(afterAdv && afterAdv.currentBeat));
const undoVisible = await page.evaluate(() => !document.getElementById('arc-undo').classList.contains('hidden'));
t('撤销按钮出来了（前置）', undoVisible === true, undoVisible);
await page.evaluate(() => {
  window.__put1 = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function () { throw new DOMException('quota', 'QuotaExceededError'); };
});
await page.evaluate(() => document.getElementById('arc-undo').click());
await sleep(600);
const undoToast = await page.$eval('#toast', el => el.textContent.trim()).catch(() => '');
t('★ 撤销写失败时说的是「撤销失败」', undoToast.includes('撤销失败'), undoToast);
t('★ 没说过「撤回上一拍」', !undoToast.includes('撤回上一拍'), undoToast);
const stillUndo = await page.evaluate(() => !document.getElementById('arc-undo').classList.contains('hidden'));
t('★ 撤销按钮还在（还能再试一次）', stillUndo === true, stillUndo);
await page.evaluate(() => { IDBObjectStore.prototype.put = window.__put1; });
const afterUndo = await kvGet('arc:' + C2);
t('★ 当前拍没被无声退回去', !!afterUndo && afterUndo.currentBeat === 1, String(afterUndo && afterUndo.currentBeat));

// —— ④ 旧数据：done=false 却带着 result（存着，但不许进提示词）——
const mig = await page.evaluate(async () => {
  const m = await import('/js/storyarc.js');
  const stale = m.normalizeArc({ v: 3, status: 'off', direction: 'x', beats: [
    { t: 'a', done: false, result: '旧结论' },
    { t: 'b', done: false },
  ], currentBeat: 1 });
  const live = m.normalizeArc({ v: 3, status: 'on', direction: 'x', beats: [
    { t: 'a', done: true, result: '真的发生了' },
    { t: 'b', done: false },
  ], currentBeat: 1 });
  return {
    staleKept: stale.beats[0].result,
    stalePrompt: m.arcPrompt(Object.assign({}, stale, { status: 'on' })),
    livePrompt: m.arcPrompt(live),
  };
});
t('done=false 的 result 不会被静默删掉（界面里填的字不能凭空消失）',
  mig.staleKept === '旧结论', JSON.stringify(mig.staleKept));
t('★ 但 done=false 的 result 绝不进提示词', !mig.stalePrompt.includes('旧结论'), mig.stalePrompt);
t('done=true 的 result 照旧注入', mig.livePrompt.includes('真的发生了'), mig.livePrompt);

// —— ⑤ 判定回来要核对拍身份 ——
t('★ 自动判定回来核对「还是不是这一拍」', /cur\.currentBeat !== beatIdx/.test(appSrc), '');
t('写卡的公共出口只有一处失败文案', /async function writeArc\(/.test(appSrc), '');

console.log('— 18. 新卡：先加拍、后写方向（v0.5.1）—');
// 评审给的真实操作顺序：新建空卡 → 先点「＋ 加一拍」→ 再写方向 → 保存。
//   旧代码用 _arcEdit 判「打开时有没有内容」，而加拍已经把 _arcEdit.beats 改成 1 条，
//   于是刚写的新卡被判成「原本就有内容」→ 存成 off，顶栏「剧情 · 关」，一句都不进提示词。
const C3 = 'arcC';
await seed({ chars: [baseChar(C3, '绿白', { greeting: '嗯。' })] });
await pickChar(C3);
await sleep(700);
t('换到新角色，库里本来没有卡', !(await kvGet('arc:' + C3)), '');
await page.evaluate(() => document.getElementById('chat-arc').click());
await sleep(320);
await page.evaluate(() => document.getElementById('arc-add-beat').click());
await sleep(220);
const c3cnt = await page.$eval('#arc-beats-cnt', el => el.textContent.trim());
t('先加一拍，界面是 1 / 12', c3cnt === '1 / 12', c3cnt);
await page.evaluate(() => {
  const el = document.getElementById('arc-direction');
  el.value = '先加拍后写方向的一条';
  el.dispatchEvent(new Event('input', { bubbles: true }));
  const b = document.querySelectorAll('#arc-beats .arc-beat')[0];
  const put = (f, v) => { const e = b.querySelector('[data-f="' + f + '"]'); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); };
  put('t', '开头');
  put('goal', '她先说话');
});
await sleep(160);
await page.evaluate(() => document.getElementById('arc-save').click());
await sleep(480);
const newArc = await kvGet('arc:' + C3);
t('★ 先加拍后写方向，存下来是 on（不是 off）', !!newArc && newArc.status === 'on', JSON.stringify(newArc && newArc.status));
t('★ 方向存下来了', !!newArc && newArc.direction === '先加拍后写方向的一条', newArc && newArc.direction);
t('★ 那一拍也在', !!newArc && newArc.beats.length === 1 && newArc.beats[0].t === '开头', JSON.stringify(newArc && newArc.beats));
const c3bar = await arcBar();
t('★ 顶栏亮着（不是「剧情 · 关」）', !!c3bar && c3bar.on === true, JSON.stringify(c3bar));
t('★ 顶栏写的是 1/1', !!c3bar && c3bar.text === '剧情 · 1/1', c3bar && c3bar.text);
await clearHits();
await say('嗯。');
const p3 = await lastPrompt();
t('★ 这张新卡真的进了提示词', p3.includes('先加拍后写方向的一条'), p3.slice(0, 160));
// 同一条路对「已经关掉的卡」还得是 off —— 救新卡不能顺手把暂停的卡复活
await page.evaluate(() => document.getElementById('chat-arc').click());
await sleep(340);
await page.evaluate(() => document.getElementById('arc-off').click());
await sleep(420);
const c3off = await kvGet('arc:' + C3);
t('关掉之后是 off（前置）', !!c3off && c3off.status === 'off', c3off && c3off.status);
await page.evaluate(() => document.getElementById('chat-arc').click());
await sleep(340);
await page.evaluate(() => document.getElementById('arc-add-beat').click());
await sleep(200);
await page.evaluate(() => {
  const el = document.getElementById('arc-direction');
  el.value = '关掉的卡再加一拍';
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
await sleep(140);
await page.evaluate(() => document.getElementById('arc-save').click());
await sleep(460);
const c3off2 = await kvGet('arc:' + C3);
t('★ 关掉的卡加拍 + 改方向再保存，仍然是 off', !!c3off2 && c3off2.status === 'off', c3off2 && c3off2.status);

console.log('— 19. 开新一段之后「撤销」不能残留（v0.5.1）—');
// 残留的 _arcUndo 是上一段的快照：点一下会把上一段的 currentBeat / done / turns 写回刚清空的新卡。
await putArc({ owner: C2, arc: mkArc({ status: 'on', currentBeat: 0, beats: [
  { t: '第一拍', goal: '往前走', done: false, doneBy: '', result: '', turns: 1 },
  { t: '第二拍', goal: '收尾', done: false, doneBy: '', result: '', turns: 0 },
] }) });
await pickChar(C2);
await sleep(700);
await page.evaluate(() => document.getElementById('chat-arc').click());
await sleep(400);
await page.evaluate(() => document.getElementById('arc-next').click());   // 第 1 拍 → 第 2 拍
await sleep(650);
await page.evaluate(() => document.getElementById('arc-next').click());   // 最后一拍 → done
await sleep(700);
const doneArc = await kvGet('arc:' + C2);
t('推到最后一拍并进 done（前置）', !!doneArc && doneArc.status === 'done', doneArc && doneArc.status);
const undo1 = await page.evaluate(() => !document.getElementById('arc-undo').classList.contains('hidden'));
t('撤销按钮出来了（前置）', undo1 === true, undo1);
await page.evaluate(() => document.getElementById('arc-next').click());   // done 状态再点 = 开新一段
await sleep(420);
await page.evaluate(() => document.getElementById('modal-ok').click());
await sleep(700);
const fresh = await kvGet('arc:' + C2);
t('卡被清空（前置）', !!fresh && !fresh.direction && fresh.beats.length === 0, JSON.stringify(fresh && { d: fresh.direction, n: fresh.beats.length }));
const undo2 = await page.evaluate(() => !document.getElementById('arc-undo').classList.contains('hidden'));
t('★ 开新一段之后撤销按钮不见了', undo2 === false, undo2);
const beforeU = await kvGet('arc:' + C2);
await page.evaluate(() => { const b = document.getElementById('arc-undo'); if (b) b.click(); });
await sleep(550);
const afterU = await kvGet('arc:' + C2);
t('★ 点也点不到：新卡状态没被上一段的快照改回去',
  !!afterU && afterU.status === (beforeU && beforeU.status)
  && afterU.currentBeat === (beforeU && beforeU.currentBeat)
  && afterU.beats.length === (beforeU && beforeU.beats.length),
  JSON.stringify(afterU && { st: afterU.status, cb: afterU.currentBeat, n: afterU.beats.length }));
t('★ 开新一段顺手重置「打开时有内容」= 下一按保存进 on', /_arcOpenedHad = false/.test(appSrc), '');

console.log('— 15. 没有未捕获报错 —');
t('页面没有异常', errs.length === 0, errs.join(' | '));

console.log('');
console.log('通过 ' + pass + ' 项 / 失败 ' + fail + ' 项');
await browser.close();
server.close();
process.exit(fail > 0 ? 1 : 0);
