import puppeteer from 'puppeteer-core';
import { seedChar } from './e2e-helper.mjs';
import http from 'http'; import fs from 'fs'; import path from 'path';
// 工作目录自适应（原来写死 C:/A-DSH-Tool/ai-companion）
const R = path.resolve(import.meta.dirname).split(path.sep).join('/');
const WWW = `${R}/www`;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const KEY = process.env.DSH_API_KEY || 'sk-test';
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8' };
const server = http.createServer((req,res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p==='/') p='/index.html';
  const f = path.join(WWW, p);
  if (!fs.existsSync(f)) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f));
});
await new Promise(r => server.listen(0,'127.0.0.1',r));
const port = server.address().port;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = []; page.on('pageerror', e => errs.push(e.message));
const sleep = ms => new Promise(r=>setTimeout(r,ms));

// v1.15.2 起右上角 ⚙ 拉开【抽屉】，设置页要从抽屉里的「全部设置」进。
// 这个函数兼容两种点法，且可重复调用（已进设置页就直接返回）。
const openSettings = async (page, sleep) => {
  // 先退到聊天页：栈底是 chat，其它页面连点返回即可。
  // ⚠️ 只在 view-chat 时点 ⚙ 是不够的 —— 从角色列表/编辑页进来时
  //    当前页不是 chat，会跳过这一步，后续所有断言都打在不可见的页面上（踩过）。
  for (let i = 0; i < 6; i++) {
    const cur = await page.evaluate(() => (document.querySelector('.view.active') || {}).id);
    if (cur === 'view-chat') break;
    await page.evaluate(() => {
      const b = document.getElementById('btn-edit-back')
             || document.getElementById('btn-chars-back')
             || document.getElementById('btn-set-back')
             || document.getElementById('btn-drawer-close')
             || document.getElementById('btn-wb-back');
      if (b) b.click();
    });
    await sleep(500);
  }
  await page.evaluate(() => document.getElementById('btn-settings').click());
  await sleep(800);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('#drawer-menu [data-wb-drawer]')].find(x => x.dataset.wbDrawer === 'settings');
    if (b) b.click();
  });
  await sleep(900);
};
let pass=0, fail=0;
const t=(n,ok,ex='')=>{ if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));} };
const clock = () => page.$eval('#chat-clock', el => el.textContent.trim());

await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
await sleep(1500);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil:'networkidle0' });
// v1.21.59：全新安装不再自动建角色（产品改空），测试自己塞一个
await seedChar(page, '测试角色', { greeting: '' });   // 空开场白：不额外多出一条消息
await page.reload({waitUntil:'networkidle0'}); await sleep(500);

// —— v1.20.21：新装默认「时间跟现实走」。这几套测的是【手动调时间】，
//    所以开局先把现实模式关掉，否则时间条只读、弹窗打不开。
await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => o.onsuccess = () => r(o.result));
  const tx = db.transaction('kv','readwrite'); const st = tx.objectStore('kv');
  const g = await new Promise(r => { const q = st.get('settings'); q.onsuccess = () => r(q.result); });
  const val = Object.assign({}, (g && g.v) || {});
  val.clockMode = false;
  st.put({ k:'settings', v: val });
  await new Promise(r => tx.oncomplete = r);
  db.close();
});
await page.reload({ waitUntil:'networkidle0' }); await sleep(500);
await sleep(400)   // [提速] 原 1800：探针实测 reload 后 app 就绪只要 ~1ms，1800 里有 800+ 是白等;
await openSettings(page, sleep);
await page.$eval('#s-apikey',(el,k)=>{el.value=k;el.dispatchEvent(new Event('change',{bubbles:true}));},KEY);
await page.click('#btn-set-back'); await sleep(500);
  // v1.15.2 起栈多了 drawer 一层，退到设置页的上一层是抽屉，还要再关一次
  await page.evaluate(() => { const b = document.getElementById('btn-drawer-close'); if (b && document.querySelector('#view-drawer.active')) b.click(); });
  await sleep(500);

console.log('=== 1. 时间条 ===');
const c0 = await clock();
console.log('   初始: ' + c0);
t('时间条从大到小：季节 · 天 · 时段 · 天气', /^(春|夏|秋|冬) · 第 \d+ 天 · (凌晨|早上|上午|中午|下午|傍晚|晚上|深夜) · (晴|多云|阴|雨|雷雨|雪|风|雾)$/.test(c0), c0);
t('顶部按钮可点（能打开调整窗）', !!(await page.$('#chat-clock')));

console.log('');
console.log('=== 2. 手动调整 ===');
await page.click('#chat-clock'); await sleep(400);
t('弹出的调整窗可见', await page.$eval('#clock-modal', el => !el.classList.contains('hidden')));
await page.click('#clock-day-plus'); await sleep(150);
await page.click('#clock-day-plus'); await sleep(150);
// 天数现在是个输入框（可以直接打字，不用点加减号点半天）
const dl = await page.$eval('#clock-day', el => el.value);
t('天数可以加（第 1 → 第 3 天）', dl === '3', dl);
// 顺带验证"直接输入"这条新路径
await page.evaluate(() => { const i = document.getElementById('clock-day'); i.value = '7'; i.dispatchEvent(new Event('input', { bubbles: true })); });
await sleep(150);
const dl2 = await page.$eval('#clock-day', el => el.value);
t('天数可以直接输入（改成 7）', dl2 === '7', dl2);
await page.evaluate(() => { const i = document.getElementById('clock-day'); i.value = '3'; i.dispatchEvent(new Event('input', { bubbles: true })); });
await sleep(150);
await page.click('#clock-phase button[data-v="evening"]'); await sleep(150);
await page.click('#clock-ok'); await sleep(500);
const c1 = await clock();
t('手动设定生效（天数+时段）', c1.includes('第 3 天 · 傍晚'), c1);

console.log('');
console.log('=== 3. 刷新后时间还在（存在 kv 里，每个角色各一份）===');
await page.reload({ waitUntil:'networkidle0' }); await sleep(400)   // [提速] 原 1800：探针实测 reload 后 app 就绪只要 ~1ms，1800 里有 800+ 是白等;
const c2 = await clock();
t('刷新后仍是 第 3 天 · 傍晚', c2.includes('第 3 天 · 傍晚'), c2);

console.log('');
console.log('=== 4. 从他说的话里自动识别 ===');
await page.click('#input');
await page.type('#input', '（第二天早上）我醒了，天刚亮', { delay: 4 });
await page.click('#btn-send'); await sleep(1200);
const c3 = await clock();
console.log('   说了「（第二天早上）」之后: ' + c3);
t('自动推进到 第 4 天 · 早上', c3.includes('第 4 天 · 早上'), c3);

console.log('');
// 等上一轮回复彻底结束——流式期间页面每帧都在重排，puppeteer 算不出输入框的可点位置
for (let i = 0; i < 80; i++) { await sleep(500); const b = await page.$eval('#btn-stop', el => !el.classList.contains('hidden')).catch(() => false); if (!b) break; }
await sleep(500);

console.log('');
console.log('=== 4.4 「以我设定的为准」开关 ===');
await page.click('#chat-clock'); await sleep(400);
t('弹窗里有这个开关', !!(await page.$('#clock-lock')));
await page.click('#clock-lock'); await sleep(200);
await page.click('#clock-phase button[data-v="night"]'); await sleep(150);
await page.click('#clock-ok'); await sleep(500);
const locked0 = await clock();
await page.click('#input');
await page.type('#input', '（第二天早上）早啊', { delay: 4 });
await page.click('#btn-send'); await sleep(1500);
const locked1 = await clock();
t('锁定后，聊天内容不再改动时间', locked0 === locked1, locked0 + ' -> ' + locked1);
for (let i = 0; i < 80; i++) { await sleep(500); const b = await page.$eval('#btn-stop', el => !el.classList.contains('hidden')).catch(() => false); if (!b) break; }
await page.click('#chat-clock'); await sleep(400);
await page.click('#clock-lock'); await sleep(200);   // 关掉
await page.click('#clock-ok'); await sleep(400);

console.log('');
console.log('=== 4.5 季节与天气 ===');
await page.click('#chat-clock'); await sleep(400);
t('调整窗里有「季节」一组', (await page.$$('#clock-season button')).length === 4, String((await page.$$('#clock-season button')).length) + ' 个');
t('调整窗里有「天气」一组', (await page.$$('#clock-weather button')).length >= 6, String((await page.$$('#clock-weather button')).length) + ' 个');
await page.click('#clock-season button[data-v="winter"]'); await sleep(150);
await page.click('#clock-weather button[data-v="snow"]'); await sleep(150);
await page.click('#clock-ok'); await sleep(500);
const c4 = await clock();
t('手动选 冬 + 雪 生效', c4.includes('冬') && c4.includes('雪'), c4);
await page.click('#input');
await page.type('#input', '（外面下起了小雨）', { delay: 4 });
await page.click('#btn-send'); await sleep(1500);
const c5 = await clock();
t('说了「下起了小雨」→ 天气自动变雨', c5.includes('雨'), c5);
t('自动识别保留了手动选的季节', c5.includes('冬'), c5);
for (let i = 0; i < 80; i++) { await sleep(500); const b = await page.$eval('#btn-stop', el => !el.classList.contains('hidden')).catch(() => false); if (!b) break; }
await sleep(400);

console.log('');
console.log('=== 5. 注入的是剧情时间，不再是真实日期（关键）===');
let captured = null;
await page.setRequestInterception(true);
page.on('request', (req) => {
  // 注意：别在这个回调里调 page.evaluate，会把页面挂住
  if (req.url().includes('/chat/completions')) { try { captured = req.postData(); } catch {} }
  req.continue();
});
await sleep(300);
await page.click('#input');
await page.type('#input', '今天想做什么', { delay: 4 });
await page.click('#btn-send');
for (let i = 0; i < 40 && !captured; i++) await sleep(500);   // 等抓到请求
const raw = captured;
let sys = '';
if (raw) { const j = JSON.parse(raw); sys = j.messages.filter(m => m.role === 'system').map(m => m.content).join('\n'); }
t('抓到了发出去的请求', !!raw && sys.length > 0, raw ? '' : '没捕获到');
t('system 里注入了剧情时间', sys.includes('剧情里现在是'), sys.slice(0, 120));
t('注入了当前时段', /\d+ 天 · (凌晨|早上|上午|中午|下午|傍晚|晚上|深夜)/.test(sys), (sys.match(/剧情里现在是[^\n]*/) || [''])[0]);
t('注入了季节和天气', /春|夏|秋|冬/.test(sys) && /晴|多云|阴|雨|雷雨|雪|风|雾/.test(sys), (sys.match(/剧情里现在是[^\n]*/) || [''])[0]);
t('不再注入真实世界日期', !/20\d{2}年\d{1,2}月\d{1,2}日 星期/.test(sys), (sys.match(/20\d{2}年[^\n]*/) || ['无'])[0]);
t('带了「日子翻篇不等于前面的事作废」的提醒', sys.includes('日子翻篇'), '');

console.log('');
console.log('');
console.log('=== 6. 时段划分（设置页折叠 → 弹窗）+ 锁定语义 ===');
await openSettings(page, sleep);
// v1.21.57：「时段划分」整体收成折叠、「每个时段对应几点」搬进弹窗，两步都要先点开
await page.evaluate(() => { const f = document.getElementById('clock-fold'); if (f && !f.classList.contains('open')) f.click(); });
await sleep(600);
await page.click('#s-ranges-open'); await sleep(500);
const rows = await page.$$eval('#clock-ranges .clock-range', els => els.length);
t('弹窗里有 8 行时段划分', rows === 8, String(rows));
await page.evaluate(() => {
  const inp = document.querySelector('#clock-ranges input[data-k="evening"][data-i="1"]');
  inp.value = '20'; inp.dispatchEvent(new Event('change', { bubbles: true }));
});
// 改动只进草稿，点「确定」才落库（这是 v1.21.57 的新语义）
await page.click('#phase-ok');
await sleep(500);
const saved = await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const kv = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get('settings'); q.onsuccess = () => r(q.result); });
  db.close(); return kv && kv.v ? kv.v.clockRanges && kv.v.clockRanges.evening : null;
});
t('改完后端存下来了（傍晚 17-20）', JSON.stringify(saved) === '[17,20]', JSON.stringify(saved));
await page.click('#btn-set-back'); await sleep(400);
  // v1.15.2 起栈多了 drawer 一层，退到设置页的上一层是抽屉，还要再关一次
  await page.evaluate(() => { const b = document.getElementById('btn-drawer-close'); if (b && document.querySelector('#view-drawer.active')) b.click(); });
  await sleep(500);
// 锁死时间，再发一条，看注入文本
await page.click('#chat-clock'); await sleep(400);
if (!(await page.$eval('#clock-lock', el => el.checked))) { await page.click('#clock-lock'); await sleep(150); }
await page.click('#clock-phase button[data-v="evening"]'); await sleep(150);
await page.click('#clock-ok'); await sleep(500);
captured = null;
await page.click('#input');
await page.type('#input', '（其实已经是第二天早上了）', { delay: 4 });
await page.click('#btn-send');
for (let i = 0; i < 40 && !captured; i++) await sleep(500);
const sys2 = captured ? JSON.parse(captured).messages.filter(m => m.role === 'system').map(m => m.content).join('\n') : '';
t('注入里带了小时范围（17:00-20:00）', sys2.includes('17:00-20:00'), (sys2.match(/剧情里现在是[^\n]*/) || [''])[0]);
t('锁定时注入了「这个时间是定死的」', sys2.includes('定死'), '');
t('他乱说时间也没改（仍是傍晚）', (await clock()).includes('傍晚'), await clock());

t('全程无 JS 错误', errs.length === 0, errs.slice(0,3).join(' | '));
console.log('');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close(); server.close();
process.exit(fail>0?1:0);
