import puppeteer from 'puppeteer-core';
import { seedChars } from './e2e-helper.mjs';
import http from 'http'; import fs from 'fs'; import path from 'path';

// 世界书全库搜索（v0.5.6.3）
//
// 为什么这套测试要【造数据】而不是用真实备份：
// 真实数据里「紫」49 条、「时候」666 条，这些数字每次改动条目都会变，
// 断言就没法判。这里造一份小规模的、数字完全可控的库，把规则钉死：
//   · 只命中触发词的那行不许空白（真实数据里「隙间」11 条有 5 条是这种）
//   · 组间按最高段位排（标题命中压过正文命中）
//   · 同名两份不许合并
//   · 每份 30 + 展开 / 总闸 300 行 + 触发时不给展开
//   · 跳转定位 + 高亮 + 返回后重跑
const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');
const WWW = R + '/www';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8' };
const server = http.createServer((req,res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p==='/') p='/index.html';
  const f = path.join(WWW, p);
  if (!fs.existsSync(f)) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f));
});
await new Promise(r => server.listen(0,'127.0.0.1',r));
const port = server.address().port;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 120000, args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
const errs = []; page.on('pageerror', e => errs.push(e.message));
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const t = (n, ok, ex = '') => { if (ok) { pass++; console.log('  OK   ' + n); } else { fail++; console.log('  FAIL ' + n + (ex ? '  -> ' + ex : '')); } };
const jsClick = s => page.evaluate(x => { const el = document.querySelector(x); if (el) el.click(); }, s);

await page.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'networkidle0', timeout: 40000 });
await sleep(1200);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil: 'networkidle0' }); await sleep(500);

// ---- 角色：白灵梦 / 两个同名 / 12 个爆量 ----
const specs = [{ id: 'c1', name: '白灵梦' }, { id: 'c2', name: '同名' }, { id: 'c3', name: '同名' }];
for (let i = 0; i < 12; i++) specs.push({ id: 'c' + (10 + i), name: '爆量' + (i + 1) });
await seedChars(page, specs);
await page.reload({ waitUntil: 'networkidle0' }); await sleep(500);

// ---- 世界书：数字全部可算 ----
// g1 命中「紫」4 条（1 个标题命中 → 段位1，其余 3 条正文命中 → 段位3）
// g2 命中「紫」1 条（纯正文 → 段位3）
// s2 / s3 各 1 条（两个角色同名「同名」）
// → 共 7 条 / 4 份，第一组必须是 g1（段位1 压过段位3）
await page.evaluate(async () => {
  const req = indexedDB.open('ai-companion');
  const db = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
  const put = (store, rec) => new Promise(res => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(rec);
    tx.oncomplete = res;
  });
  const groups = [
    { id: 'g1', name: '东方幻想乡 · 人物志', members: [], createdAt: 1, order: 0, entries: [
      // keys 故意写成别的词：下面第 7 组会把 title 改掉，那时三个字段就都不含「灵梦」了，
      // 这条才会从结果里消失 —— 用它验「返回搜索页时重跑」
      { id: 'e1', title: '灵梦', keys: ['旧名'], content: '她住在神社里。', on: true },
      { id: 'e2', title: '日常', keys: ['日常'], content: '幻想乡的日子过得很慢，灵梦偶尔会来。', on: true },
      // 这一条【只有触发词】含「隙间」，标题和正文都没有 —— 搜「隙间」时那行不许空白
      { id: 'e3', title: '门', keys: ['隙间', '境界'], content: '门缝后面是别的世界。', on: true },
      { id: 'e5', title: '旧设定', keys: [], content: '灵梦的旧设定。', on: false },
      { id: 'e6', title: '待办', keys: [], content: '灵梦的待确认条目。', needsReview: true },
    ] },
    { id: 'g2', name: '东方幻想乡 · 风情与日常', members: [], createdAt: 2, order: 1, entries: [
      { id: 'e4', title: '吃喝', keys: ['吃喝'], content: '灵梦喜欢喝酒，灵梦也喜欢睡觉，灵梦还喜欢捉弄人。', on: true },
    ] },
  ];
  const solos = [
    // 96 条都含「看你」→ 首屏 30 + 「还有 66 条 · 展开」
    { id: 's1', charId: 'c1', entries: Array.from({ length: 96 }, (_, i) => ({ id: 'b' + i, title: '条' + i, keys: ['看'], content: '（看你一眼）' + i, on: true })) },
    { id: 's2', charId: 'c2', entries: [{ id: 'x1', title: '甲的设定', keys: [], content: '灵梦', on: true }] },
    { id: 's3', charId: 'c3', entries: [{ id: 'x2', title: '乙的设定', keys: [], content: '灵梦', on: true }] },
  ];
  // 12 份 × 30 条都含「爆量」→ 360 条 / 12 份。
  // 首屏按份累计 min(30,30)=30：10 份正好 300，第 11 份放不下就停 → 10 份 / 300 行。
  for (let i = 0; i < 12; i++) {
    const cid = 'c' + (10 + i);
    solos.push({ id: 's' + (10 + i), charId: cid, entries: Array.from({ length: 30 }, (_, j) => ({ id: 'q' + i + '_' + j, title: '爆' + j, keys: [], content: '爆量 ' + j, on: true })) });
  }
  for (const g of groups) await put('wbGroups', g);
  for (const s of solos) await put('wbSolo', s);
  db.close();
});

const enterWorldbook = async () => {
  for (let i = 0; i < 6; i++) {
    const cur = await page.evaluate(() => (document.querySelector('.view.active') || {}).id);
    if (cur === 'view-chat' || cur === 'view-drawer') break;
    await page.evaluate(() => {
      const b = document.getElementById('btn-wb-back') || document.getElementById('btn-set-back')
             || document.getElementById('btn-wbe-back') || document.getElementById('btn-wbs-back')
             || document.getElementById('btn-wbs2-back') || document.getElementById('btn-drawer-close');
      if (b) b.click();
    });
    await sleep(400);
  }
  await page.evaluate(() => document.getElementById('btn-settings').click());
  await sleep(600);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('#drawer-menu [data-wb-drawer]')].find(x => x.dataset.wbDrawer === 'worldbook');
    if (b) b.click();
  });
  await sleep(700);
};

const search = async (q) => {
  await page.evaluate((v) => {
    const i = document.getElementById('wbs2-input');
    i.value = v;
    i.dispatchEvent(new Event('input', { bubbles: true }));
  }, q);
  await sleep(700);
};

console.log('=== 1. 入口与副标题 ===');
await enterWorldbook();
const wbActive = await page.evaluate(() => (document.querySelector('.view.active') || {}).id);
t('进到世界书主页', wbActive === 'view-worldbook', wbActive);
const sub = await page.$eval('#wb-search-sub', el => el.textContent.trim());
const subN = Number((sub.match(/(\d+)/) || [])[1] || 0);
// 5 + 1 + 96 + 1 + 1 + 360 = 464
t('副标题报出全库总条数 464', /^共 \d+ 条$/.test(sub) && subN === 464, sub);

await jsClick('#btn-wb-search');
await sleep(600);
t('进入搜索页', await page.evaluate(() => document.getElementById('view-wbsearch').classList.contains('active')));
t('刚进来提示最小字数', (await page.$eval('#wbs2-results', el => el.textContent)).includes('输入至少 2 个字'));

console.log('=== 2. 单字不出结果 ===');
await search('灵');
t('单字仍然提示最小字数', (await page.$eval('#wbs2-results', el => el.textContent)).includes('输入至少 2 个字'));

console.log('=== 3. 只命中触发词的那行不许空白 ===');
await search('隙间');
const seg2 = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#wbs2-results .wbs-row')];
  return { n: rows.length, text: rows.map(r => r.textContent.trim()), html: rows.map(r => r.innerHTML) };
});
t('「隙间」命中 1 行', seg2.n === 1, JSON.stringify(seg2.text));
t('那一行有字（不是空行）', (seg2.text[0] || '').length > 0, JSON.stringify(seg2.text[0]));
t('那一行只列命中触发的那个词', (seg2.text[0] || '') === '隙间', seg2.text[0]);
t('触发词被高亮', /<mark>隙间<\/mark>/.test(seg2.html[0] || ''), seg2.html[0]);

console.log('=== 4. 组间排序 / 同名 / 角标 ===');
// ⚠️ 这里用两字词：「紫」是单字，会被 SEARCH_MIN = 2 挡掉（规格里那条验收用例本身
//    和「灵（单字）不出结果」互相矛盾 —— 单字一律不搜）。
await search('灵梦');
const zi = await page.evaluate(() => ({
  meta: document.getElementById('wbs2-meta').textContent,
  heads: [...document.querySelectorAll('#wbs2-results .wbs-head')].map(h => ({
    name: (h.querySelector('.wbs-name') || {}).textContent || '',
    kind: (h.querySelector('.wbs-kind') || {}).textContent || '',
    count: (h.querySelector('.wbs-count') || {}).textContent || '',
  })),
  tags: [...document.querySelectorAll('#wbs2-results .wbs-tag')].map(x => x.textContent),
}));
t('「灵梦」共 7 条 / 4 份', zi.meta === '共 7 条 / 4 份', zi.meta);
t('标题命中的那份排第一（段位1 压段位3）', zi.heads[0] && zi.heads[0].name === '东方幻想乡 · 人物志', JSON.stringify(zi.heads.map(x => x.name)));
t('同名两份没有被合并', zi.heads.filter(x => x.name === '同名').length === 2, JSON.stringify(zi.heads.map(x => x.name)));
t('组头带「共 M 条」', zi.heads.every(x => /共 \d+ 条/.test(x.count)), JSON.stringify(zi.heads.map(x => x.count)));
t('组头区分组/单独', zi.heads.some(x => x.kind.includes('角色组')) && zi.heads.some(x => x.kind.includes('单独设定')), JSON.stringify(zi.heads.map(x => x.kind)));
t('「已关闭」角标在', zi.tags.includes('已关闭'), JSON.stringify(zi.tags));
t('「待确认」角标在', zi.tags.includes('待确认'), JSON.stringify(zi.tags));

console.log('=== 5. 每份 30 + 展开 ===');
await search('看你');
const kn = await page.evaluate(() => ({
  groups: document.querySelectorAll('#wbs2-results .wbs-group').length,
  rows: document.querySelectorAll('#wbs2-results .wbs-row').length,
  more: [...document.querySelectorAll('#wbs2-results .wbs-more')].map(b => b.textContent.trim()),
  foot: (document.querySelector('#wbs2-results .wbs-foot') || {}).textContent || '',
}));
t('「看你」1 份 30 行', kn.groups === 1 && kn.rows === 30, JSON.stringify(kn));
t('折叠报出 66 条', kn.more.length === 1 && kn.more[0] === '还有 66 条 · 展开', JSON.stringify(kn.more));
t('没触发闸时没有底部截断提示', kn.foot === '', kn.foot);
await jsClick('#wbs2-results .wbs-more');
await sleep(400);
const kn2 = await page.evaluate(() => document.querySelectorAll('#wbs2-results .wbs-row').length);
t('展开后 96 行', kn2 === 96, String(kn2));

console.log('=== 6. 总闸：300 行 + 触发时不给展开 ===');
await search('爆量');
const boom = await page.evaluate(() => ({
  groups: document.querySelectorAll('#wbs2-results .wbs-group').length,
  rows: document.querySelectorAll('#wbs2-results .wbs-row').length,
  more: document.querySelectorAll('#wbs2-results .wbs-more').length,
  foot: (document.querySelector('#wbs2-results .wbs-foot') || {}).textContent || '',
  meta: document.getElementById('wbs2-meta').textContent,
}));
t('触发闸：只出 10 份', boom.groups === 10, JSON.stringify(boom));
t('触发闸：首屏正好 300 行', boom.rows === 300, String(boom.rows));
t('触发闸：一律不给展开', boom.more === 0, String(boom.more));
t('底部写清截断与份数', boom.foot === '只列了最相关的前 10 份 —— 加个字会更快', boom.foot);
t('顶部报真实总数与份数', boom.meta === '共 360 条 / 12 份', boom.meta);

console.log('=== 7. 跳转 + 高亮 + 返回后重跑 ===');
await search('灵梦');
// 点第二行（e2，正文命中）→ 应跳到 g1 的条目页并把 e2 滚到中间
await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#wbs2-results .wbs-row')];
  if (rows[1]) rows[1].click();
});
await sleep(700);
const jumped = await page.evaluate(() => ({
  active: (document.querySelector('.view.active') || {}).id,
  flash: document.querySelectorAll('.wb-flash').length,
  lastText: (document.querySelector('.wb-flash') || {}).textContent || '',
}));
t('跳到条目页', jumped.active === 'view-wbentries', JSON.stringify(jumped.active));
t('到达后高亮一闪', jumped.flash >= 1, JSON.stringify(jumped));
t('高亮的正是那一条', jumped.lastText.includes('幻想乡的日子过得很慢'), jumped.lastText.slice(0, 40));

// 改掉 e1 的标题（改完它三个字段都不含「紫」，应该从结果里消失）
await page.evaluate(async () => {
  const req = indexedDB.open('ai-companion');
  const db = await new Promise(res => { req.onsuccess = () => res(req.result); });
  const g = await new Promise(res => {
    const tx = db.transaction('wbGroups');
    const r = tx.objectStore('wbGroups').get('g1');
    r.onsuccess = () => res(r.result);
  });
  g.entries[0].title = '改过的标题';
  await new Promise(res => {
    const tx = db.transaction('wbGroups', 'readwrite');
    tx.objectStore('wbGroups').put(g);
    tx.oncomplete = res;
  });
  db.close();
});
await jsClick('#btn-wbe-back');
await sleep(1000);
const back = await page.evaluate(() => ({
  active: (document.querySelector('.view.active') || {}).id,
  meta: document.getElementById('wbs2-meta').textContent,
  input: document.getElementById('wbs2-input').value,
}));
t('返回到搜索页', back.active === 'view-wbsearch', back.active);
t('输入框内容保留', back.input === '灵梦', back.input);
t('结果已按新数据重跑（7 条 → 6 条）', back.meta === '共 6 条 / 4 份', back.meta);

console.log('=== 8. 总开关关着要有提示 ===');
await page.evaluate(() => {
  const c = document.getElementById('s-wb-on');
  c.checked = false;
  c.dispatchEvent(new Event('change', { bubbles: true }));
});
await sleep(400);
await search('灵梦');
const warn = await page.evaluate(() => {
  const w = document.getElementById('wbs2-warn');
  return { shown: w.style.display !== 'none', text: w.textContent };
});
t('关着的时候搜索页有提示', warn.shown && warn.text.includes('关着'), JSON.stringify(warn));

console.log('=== 9. 没有页面异常 ===');
t('没有 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | '));

console.log('\n结果: 通过 ' + pass + ' / 失败 ' + fail);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
