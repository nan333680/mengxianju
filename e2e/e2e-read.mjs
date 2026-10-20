// e2e-read.mjs —— 小说阅读模式（v0.5.1.5）
//
// 覆盖：
//   1. 默认不在阅读模式（.reading / read-bar / 顶部三条操作条都正常）
//   2. 抽屉菜单里有「阅读模式」，点它进得去
//   3. 进去以后：气泡摊平（头像、时间、token 角标全部不可见）、顶部换成 read-bar
//   4. 分章：按【剧情第几天】切，第 1/2/3 天各一个标题
//   5. 菜单项文案随之变成「退出阅读」
//   6. 退出以后全部还原，分章标题消失
//   7. 英文界面下 read-bar 与分章标题都是英文
//   8. 无 pageerror

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

const CID = 'rd1';
const T0 = 1790000000000;
const day = d => ({ day: d, phase: 'night', season: '秋', weather: '雨' });
const SEED = [
  { id: 'm1', role: 'user',      content: '我回来了。',        ts: T0 + 1000, story: day(1) },
  { id: 'm2', role: 'assistant', content: '她没回头，只把杯子往桌上一放。', ts: T0 + 2000, story: day(1) },
  { id: 'm3', role: 'assistant', content: '窗外的雨还在下，她终于开口了。', ts: T0 + 3000, story: day(2) },
  { id: 'm4', role: 'user',      content: '那你到底想说什么。', ts: T0 + 4000, story: day(2) },
  { id: 'm5', role: 'assistant', content: '她把那件旧物推到我面前，什么都没说。', ts: T0 + 5000, story: day(3) },
];

const seed = async (lang) => {
  await page.evaluate(async (v) => {
    const o = indexedDB.open('ai-companion');
    const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
    const put = (store, rec) => new Promise(r => { const tx = db.transaction(store,'readwrite'); tx.objectStore(store).put(rec); tx.oncomplete = r; });
    const del = (store) => new Promise(r => { const tx = db.transaction(store,'readwrite'); tx.objectStore(store).clear(); tx.oncomplete = r; });
    for (const s2 of ['characters','messages']) await del(s2);
    await put('kv', { k: 'settings', v: { apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', clockMode: false, historyTime: !!v.hist, clockDetail: !!v.hist, lang: v.lang } });
    await put('kv', { k: 'lastCharId', v: v.cid });
    await put('kv', { k: 'greeted:' + v.cid, v: true });
    await put('characters', {
      id: v.cid, name: '蓝白', greeting: '', persona: '你是蓝白。', avatar: null,
      temperature: 1.0, maxTokens: 2048, topP: 1.0, reasoningEffort: 'low', contextRounds: 20,
      kaomojiFreq: 0, emojiFreq: 0, verbosity: 'medium', splitMessages: false, typingDelay: 0,
      hesitation: false, showTyping: true, longMemory: false, allowEditMine: false,
      descLevel: 'low', povLock: false, appearance: '', appearanceOn: true, presetKey: 'blank',
      createdAt: v.t0
    });
    // ⚠️ 故意【不写 parentId】：seedParents 把"有 parentId（含空串）"当成已连好的链，
    //    写一个空串进去等于把每条消息都声明成根 —— 活动路径只剩叶子一条。
    //    留空字段，让 seedParents 自己按 ts 串成一条链（和真实导入旧备份的路径一致）。
    for (const m of v.msgs) {
      await put('messages', { charId: v.cid, archived: false, ...m });
    }
    db.close();
  }, { cid: CID, t0: T0, msgs: SEED, lang, hist: true });
};

const openDrawer = async () => {
  await page.evaluate(() => document.getElementById('btn-settings').click());
  await page.waitForSelector('[data-wb-drawer="read"]', { timeout: 8000 });
  await sleep(200);
};
const clickRead = async () => {
  await openDrawer();
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('#drawer-menu [data-wb-drawer]')].find(x => x.dataset.wbDrawer === 'read');
    if (b) b.click();
  });
  await sleep(500);
};

await page.goto('http://127.0.0.1:' + port + '/index.html', { waitUntil: 'networkidle0' });
await sleep(400);
await seed('zh');
await page.goto('http://127.0.0.1:' + port + '/index.html', { waitUntil: 'networkidle0' });
await sleep(1200);

console.log('');
console.log('=== 1. 默认不是阅读模式 ===');
const s1 = await page.evaluate(() => ({
  n: document.querySelectorAll('#messages .msg').length,
  reading: document.getElementById('messages').classList.contains('reading'),
  barHidden: document.getElementById('read-bar').classList.contains('hidden'),
  rowHidden: document.querySelector('#view-chat .bar-row').classList.contains('hidden'),
  chap: document.querySelectorAll('#messages .chap').length,
  avShown: (() => { const a = document.querySelector('#messages .msg .av'); return a ? getComputedStyle(a).display !== 'none' : false; })(),
  timeShown: (() => { const a = document.querySelector('#messages .bub .t'); return a ? getComputedStyle(a).display !== 'none' : false; })(),
}));
t('五条消息都画出来了', s1.n === 5, String(s1.n));
t('★ 默认没有 reading class', s1.reading === false, '');
t('默认不显示阅读条', s1.barHidden === true, '');
t('默认顶部三条操作条在', s1.rowHidden === false, '');
t('默认没有分章标题', s1.chap === 0, String(s1.chap));
t('默认头像可见', s1.avShown === true, '');
t('默认时间可见', s1.timeShown === true, '');

console.log('');
console.log('=== 2. 抽屉里有入口，点得进去 ===');
await openDrawer();
const label0 = await page.evaluate(() => {
  const b = [...document.querySelectorAll('#drawer-menu [data-wb-drawer]')].find(x => x.dataset.wbDrawer === 'read');
  return b ? b.textContent : '';
});
t('★ 抽屉菜单里有「阅读模式」', label0.includes('阅读模式'), label0);
await clickRead();
const s2 = await page.evaluate(() => {
  const disp = (sel) => { const e = document.querySelector(sel); return e ? getComputedStyle(e).display : '?'; };
  return {
    reading: document.getElementById('messages').classList.contains('reading'),
    barHidden: document.getElementById('read-bar').classList.contains('hidden'),
    rowHidden: document.querySelector('#view-chat .bar-row').classList.contains('hidden'),
    shell: document.getElementById('view-chat').classList.contains('reading-shell'),
    topbar: disp('#view-chat .topbar'),
    composer: disp('#view-chat .composer'),
  };
});
t('★ 进了阅读模式（messages.reading）', s2.reading === true, '');
t('★ 顶部换成阅读条（三条操作条收起）', s2.barHidden === false && s2.rowHidden === true, JSON.stringify(s2));
// v0.5.1.6：上一版只收了操作条，顶栏和输入栏还在 —— 屏幕上永远摆着一个输入框
t('★ 顶栏也收起来', s2.shell === true && s2.topbar === 'none', s2.topbar);
t('★ 输入栏也收起来', s2.composer === 'none', s2.composer);

console.log('');
console.log('=== 3. 气泡摊成段落 ===');
const s3 = await page.evaluate(() => {
  const av = document.querySelector('#messages .msg .av');
  const tm = document.querySelector('#messages .bub .t');
  const bub = document.querySelector('#messages .bub');
  const cs = getComputedStyle(bub);
  return {
    av: av ? getComputedStyle(av).display : '?',
    tm: tm ? getComputedStyle(tm).display : '?',
    bg: cs.backgroundColor,
    border: cs.borderTopWidth,
    radius: cs.borderTopLeftRadius,
    font: cs.fontFamily,
  };
});
t('★ 头像收起来', s3.av === 'none', s3.av);
t('★ 时间 / token 收起来', s3.tm === 'none', s3.tm);
t('气泡底色去掉', s3.bg === 'rgba(0, 0, 0, 0)' || s3.bg === 'transparent', s3.bg);
t('气泡圆角去掉', s3.radius === '0px', s3.radius);
t('换成衬线字体', /serif|Songti|Georgia/i.test(s3.font), s3.font);

console.log('');
console.log('=== 4. 按剧情天数分章 ===');
const chaps = await page.evaluate(() => [...document.querySelectorAll('#messages .chap')].map(x => x.textContent.trim()));
t('★ 三天三条分章标题', chaps.length === 3, JSON.stringify(chaps));
t('★ 标题内容对得上', chaps.join('|') === '第 1 天|第 2 天|第 3 天', JSON.stringify(chaps));
const order = await page.evaluate(() => {
  const kids = [...document.getElementById('messages').children];
  const firstChap = kids.findIndex(k => k.classList.contains('chap'));
  const firstMsg = kids.findIndex(k => k.classList.contains('msg'));
  return { firstChap, firstMsg };
});
t('第一章标题排在第一条消息之前', order.firstChap >= 0 && order.firstChap < order.firstMsg, JSON.stringify(order));

console.log('');
console.log('=== 5. 菜单项变成「退出阅读」 ===');
await openDrawer();
const label1 = await page.evaluate(() => {
  const b = [...document.querySelectorAll('#drawer-menu [data-wb-drawer]')].find(x => x.dataset.wbDrawer === 'read');
  return b ? b.textContent : '';
});
t('★ 阅读中菜单项写着「退出阅读」', label1.includes('退出阅读'), label1);
// 关掉抽屉（点遮罩）回到聊天
await page.evaluate(() => { const m = document.getElementById('drawer'); if (m) m.click(); });
await sleep(400);

console.log('');
console.log('=== 6. 退出还原 ===');
await page.evaluate(() => document.getElementById('read-exit').click());
await sleep(500);
const s6 = await page.evaluate(() => {
  const disp = (sel) => { const e = document.querySelector(sel); return e ? getComputedStyle(e).display : '?'; };
  return {
    reading: document.getElementById('messages').classList.contains('reading'),
    barHidden: document.getElementById('read-bar').classList.contains('hidden'),
    rowHidden: document.querySelector('#view-chat .bar-row').classList.contains('hidden'),
    shell: document.getElementById('view-chat').classList.contains('reading-shell'),
    topbar: disp('#view-chat .topbar'),
    composer: disp('#view-chat .composer'),
    chap: document.querySelectorAll('#messages .chap').length,
    n: document.querySelectorAll('#messages .msg').length,
  };
});
t('★ 退出后不再有 reading', s6.reading === false, '');
t('★ 阅读条收起、操作条回来', s6.barHidden === true && s6.rowHidden === false, JSON.stringify(s6));
t('★ 顶栏和输入栏都回来了', s6.shell === false && s6.topbar !== 'none' && s6.composer !== 'none', s6.topbar + '/' + s6.composer);
t('★ 分章标题全部撤掉', s6.chap === 0, String(s6.chap));
t('消息一条没少（只改怎么看，不改数据）', s6.n === 5, String(s6.n));

console.log('');
console.log('=== 7. 英文界面 ===');
await seed('en');
await page.goto('http://127.0.0.1:' + port + '/index.html', { waitUntil: 'networkidle0' });
await sleep(1400);
await clickRead();
const s7 = await page.evaluate(() => ({
  bar: document.getElementById('read-bar').textContent.replace(/\s+/g, ' ').trim(),
  chap: [...document.querySelectorAll('#messages .chap')].map(x => x.textContent.trim()),
  cjk: /[\u4e00-\u9fff]/.test(document.getElementById('read-bar').textContent),
}));
t('★ 阅读条是英文', s7.cjk === false && /Reading mode/.test(s7.bar), s7.bar);
t('★ 分章标题是英文 Day N', s7.chap.join('|') === 'Day 1|Day 2|Day 3', JSON.stringify(s7.chap));

console.log('');
console.log('=== 8. 没有未捕获错误 ===');
t('无 pageerror', errs.length === 0, errs.join(' | '));

console.log('');
console.log('========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close();
server.close();
process.exit(fail > 0 ? 1 : 0);
