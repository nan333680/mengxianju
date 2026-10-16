// e2e-v040card.mjs — 角色卡入口必须把「待确认」带住（v0.4.0 修）
//
// 病根：charcard.js 的 extractEntries 已经算好了 needsReview / reviewWhy
// （概率触发 / 正则触发 / 二次筛选 / 没触发词），注释里写着
// 「别让同一个文件从两个入口进来得到两种结果」。
// 但 app.js 的角色卡导入在重建条目对象时只带 title/keys/content/on/pos，
// 这两个字段在这里丢了 —— 于是世界书页看不到「待确认」，
// worldbookHits / worldbookConst 那两道闸门（if (e.needsReview === true) continue）
// 也拦不住，条目照常注入：
//   概率条目变成每次都出现、正则被当字面量、二次筛选条件失效。
// 同一个文件从【世界书】入口进来标记带得住，从【角色卡】入口进来就没了。
//
// 这一套从【角色卡】入口走完整条路，最后看世界书页上的标记。
// 把 app.js 里那行 ...(en.needsReview === true ? ...) 删掉就会红。
import puppeteer from 'puppeteer-core';
import http from 'http'; import fs from 'fs'; import path from 'path'; import os from 'os';
import { readCode } from './e2e-src.mjs';
const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');
const WWW = R + '/www';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8' };
let pass = 0, fail = 0;
const t = (n, ok, ex) => { if (ok) { pass++; console.log('  OK   ' + n); } else { fail++; console.log('  FAIL ' + n + (ex ? '  -> ' + ex : '')); } };

console.log('=== 1. 源码：标记不再被逐字段重建丢掉 ===');
const SRC = readCode(WWW + '/js/app.js');
// ⚠️ v0.4.2.1：这条断言原来钉的是"把 needsReview/reviewWhy 逐字段抄一遍"。
//    逐字段重建本身就是病根 —— 每加一个字段就得记得回来补一次，漏了没有守卫
//    （needsReview 漏过一次、useRegex 漏过一次、概率/二次筛选/深度又漏一次）。
//    现在改成整条带过来，断言也跟着改成钉【这个形状】：
//    只要有人再把这行写回逐字段重建，这里就会红。
t('app.js 把卡片条目整条带过来（不再逐字段重建）',
  SRC.includes('entries: card.entries.map(en => ({ ...en, id: uid(),'));
t('pos 的白名单清洗还在（别一起丢了）',
  SRC.includes('pos: WBP_ORDER.indexOf(en.pos) >= 0'));

console.log('=== 2. 造一张带四种特殊触发条件的 V2 卡 ===');
const CARD = { spec: 'chara_card_v2', spec_version: '2.0', data: {
  name: '卡片待确认测试', description: '测试用角色。', first_mes: '（开场）',
  character_book: { name: '书', entries: [
    { comment: '概率', keys: ['迷雾'], content: '三成概率才出现的内容。', enabled: true, probability: 30 },
    { comment: '正则', keys: ['^魔.*法$'], content: '正则触发的内容。', enabled: true, useRegex: true },
    { comment: '二次', keys: ['霜'], keysecondary: ['冬'], content: '要满足二次条件的内容。', enabled: true },
    { comment: '没触发词', keys: [], content: '没有触发词的内容。', enabled: true },
    { comment: '普通', keys: ['晴'], content: '普通条目的内容。', enabled: true },
    { comment: '常驻', keys: [], content: '常驻条目的内容。', enabled: true, constant: true },
  ] } } };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mxj-v040-'));
const cardFile = path.join(dir, 'card.json');
fs.writeFileSync(cardFile, JSON.stringify(CARD), 'utf8');

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = path.join(WWW, p);
  if (!fs.existsSync(f)) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 120000,
  args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
const page = await browser.newPage();
// ⚠️ CI 的 runner 是 en-US，而界面语言默认「跟随系统」。钉成中文，否则英文界面下
//    断言中文文案的地方都会红（界面翻译补完之后尤其明显，v0.4.2）。
//    用 defineProperty 而不是改库：不用等 reload、也不动 DOM，跟断言不抢。
//    configurable: true 是为了能和预检工具自己的伪装共存。
await page.evaluateOnNewDocument(() => {
  Object.defineProperty(navigator, 'language', { get: () => 'zh-CN', configurable: true });
  Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh'], configurable: true });
});


await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = []; page.on('pageerror', e => errs.push(e.message));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const openSettings = async () => {
  for (let i = 0; i < 6; i++) {
    const cur = await page.evaluate(() => (document.querySelector('.view.active') || {}).id);
    if (cur === 'view-chat') break;
    await page.evaluate(() => {
      const b = document.getElementById('btn-edit-back') || document.getElementById('btn-chars-back')
             || document.getElementById('btn-set-back') || document.getElementById('btn-drawer-close')
             || document.getElementById('btn-wb-back');
      if (b) b.click();
    });
    await sleep(400);
  }
  await page.evaluate(() => document.getElementById('btn-settings').click());
  await sleep(700);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('#drawer-menu [data-wb-drawer]')].find(x => x.dataset.wbDrawer === 'settings');
    if (b) b.click();
  });
  await sleep(800);
};

await page.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'networkidle0', timeout: 40000 });
await sleep(1200);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil: 'networkidle0' }); await sleep(1200);

console.log('=== 3. 从设置页把卡导进来 ===');
await openSettings();
const input = await page.$('#cc-import-file');
t('角色卡导入入口存在', !!input);
await input.uploadFile(cardFile);
await sleep(1800);

const got = await page.evaluate(async () => {
  const { wb } = await import('./js/db.js');
  const all = await wb.soloAll();
  const mine = all.find(s => (s.entries || []).some(e => e.content === '普通条目的内容。'));
  return mine ? mine.entries.map(e => ({ title: e.title, keys: e.keys.length, pos: e.pos,
    on: e.on, rev: e.needsReview === true, why: e.reviewWhy || '',
    useRegex: e.useRegex === true, content: e.content,
    prob: e.prob, sec: e.secondary || null })) : null;
});
console.log('   ' + JSON.stringify(got));
t('世界书六条都进来了', !!got && got.length === 6, got ? String(got.length) : 'null');
const by = (c) => (got || []).find(e => e.content === c) || {};
// ⚠️ v0.4.2.1：概率 / 二次筛选 / 深度插入三样【从"待确认"升级成"真的照做"】——
//    有能力兑现还标着待确认，等于把能用的条目锁在门外（导进来却一条都不生效）。
t('概率条目 → 不再待确认，而且 30% 存下来了', by('三成概率才出现的内容。').rev === false && by('三成概率才出现的内容。').prob === 30,
  JSON.stringify(by('三成概率才出现的内容。')));
// ⚠️ v0.4.0 起 use_regex 【真的照做】了（hitKeys 按正则匹配），
//    所以它不再被标成"读不懂" —— 有能力兑现还标着，等于把能用的条目锁在门外。
t('正则条目 → 不再是待确认（v0.4.0 起真的按正则匹配）', by('正则触发的内容。').rev === false);
t('而且 useRegex 标记带过来了（否则又变成拿正则当字面量）', by('正则触发的内容。').useRegex === true);
t('二次筛选条目 → 不再待确认，二次键存下来了', by('要满足二次条件的内容。').rev === false
  && (by('要满足二次条件的内容。').sec || []).join() === '冬',
  JSON.stringify(by('要满足二次条件的内容。')));
t('没触发词条目 → 待确认', by('没有触发词的内容。').rev === true);
t('普通条目【不】该被标（别误伤）', by('普通条目的内容。').rev === false);
t('常驻条目【不】该被标', by('常驻条目的内容。').rev === false);
t('真正读不懂的那条仍然带原因', !!by('没有触发词的内容。').why, by('没有触发词的内容。').why);
t('只有「没有触发词」这一条还需要人确认',
  got.filter(e => e.rev).length === 1, JSON.stringify(got.filter(e => e.rev).map(e => e.content)));
t('普通条目没被误标', by('普通条目的内容。').rev === false);

console.log('=== 4. 世界书页上真的显示「待确认」 ===');
await openSettings();
await page.evaluate(() => document.getElementById('btn-settings').click()); await sleep(700);
await page.evaluate(() => {
  const b = [...document.querySelectorAll('#drawer-menu [data-wb-drawer]')].find(x => x.dataset.wbDrawer === 'worldbook');
  if (b) b.click();
});
await sleep(800);
await page.evaluate(() => {
  const b = document.querySelector('#s-wb-on');
  if (b && !b.checked) { b.checked = true; b.dispatchEvent(new Event('change')); }
});
await sleep(600);
await page.evaluate(() => document.getElementById('btn-wb-solo').click());
await sleep(800);
const picked = await page.evaluate(() => {
  const r = [...document.querySelectorAll('#pk-list .pick-row')].find(x => x.textContent.includes('卡片待确认测试'));
  if (!r) return false;
  r.click(); return true;
});
t('选人弹窗里能找到刚导入的角色', picked);
await sleep(1000);
const dom = await page.evaluate(() => {
  const list = document.querySelector('#wbs-list');
  return {
    active: document.querySelector('#view-wbsolo').classList.contains('active'),
    total: list ? list.querySelectorAll('[data-wb-e]').length : 0,
    review: list ? list.querySelectorAll('.wi-review').length : 0,
    bar: (document.querySelector('.wb-review-bar') || {}).textContent || '',
  };
});
console.log('   ' + JSON.stringify(dom));
t('进了单独角色世界书页', dom.active);
t('页面上六条都在', dom.total === 6, String(dom.total));
t('只有 1 条带「待确认」标（正则/概率/二次筛选现在都能用了）', dom.review === 1, String(dom.review));
t('顶部报数条说 1 条不生效', dom.bar.includes('1'), dom.bar);

console.log('');
console.log('JS 错误: ' + (errs.length ? errs.join(' | ') : '无'));
t('无 JS 报错', errs.length === 0, errs.join(' | '));
console.log('');
console.log('通过 ' + pass + ' / 失败 ' + fail);
await browser.close(); server.close();
fs.rmSync(dir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
