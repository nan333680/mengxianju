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
  t('加两拍后计数是 2 / 5', cnt === '2 / 5', cnt);
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

// —— 起步 ——
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
t('默认文案就是「剧情」', bar && bar.text === '剧情', bar && bar.text);
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
t('换到没卡的角色，顶栏复位', bar && bar.on === false && bar.text === '剧情', JSON.stringify(bar));
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
t('关掉后顶栏复位', bar && bar.on === false && bar.text === '剧情', JSON.stringify(bar));
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
  // 把两拍全删掉（确认框用原生的，先答应它）
  window.confirm = () => true;
});
for (let i = 0; i < 2; i++) {
  await page.evaluate(() => {
    const b = document.querySelector('#arc-beats .arc-beat');
    if (b) b.querySelector('[data-act="del"]').click();
  });
  await sleep(200);
}
const emptyCnt = await page.$eval('#arc-beats-cnt', el => el.textContent.trim());
t('删空后计数是 0 / 5', emptyCnt === '0 / 5', emptyCnt);
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
await page.evaluate(() => {
  window.confirm = () => true;
  document.getElementById('chat-arc').click();
});
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
await page.evaluate(() => {
  const b = document.querySelectorAll('#arc-beats .arc-beat')[1];
  b.querySelector('[data-act="del"]').click();
});
await sleep(200);
await page.evaluate(() => document.getElementById('arc-save').click());
await sleep(400);
const c2 = await kvGet('arc:' + C1);
t('删掉当前拍后 currentBeat 夹回 0', c2 && c2.currentBeat === 0, c2 && c2.currentBeat);
t('只剩一拍', c2 && c2.beats.length === 1, c2 && c2.beats && c2.beats.length);

console.log('— 9. 没有未捕获报错 —');
t('页面没有异常', errs.length === 0, errs.join(' | '));

console.log('');
console.log('通过 ' + pass + ' 项 / 失败 ' + fail + ' 项');
await browser.close();
server.close();
process.exit(fail > 0 ? 1 : 0);
