import puppeteer from 'puppeteer-core';
import http from 'http'; import fs from 'fs'; import path from 'path';
const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');
const WWW=`${R}/www`;
const CHROME='C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const KEY = process.env.DSH_API_KEY || 'sk-test';
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'};
const server=http.createServer((req,res)=>{let p=decodeURIComponent(req.url.split('?')[0]);if(p==='/')p='/index.html';const f=path.join(WWW,p);if(!fs.existsSync(f)){res.writeHead(404);res.end('404');return;}res.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream'});res.end(fs.readFileSync(f));});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const port=server.address().port;
const browser=await puppeteer.launch({executablePath:CHROME,headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
const page=await browser.newPage();
await page.setViewport({width:393,height:851,deviceScaleFactor:2,isMobile:true,hasTouch:true});
const errs=[]; page.on('pageerror',e=>errs.push(e.message));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let pass=0,fail=0;
const t=(n,ok,ex='')=>{if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));}};

const openSettings = async (page, sleep) => {
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
// 展开一个折叠头（已经展开就跳过）
const openFold = async id => {
  await page.evaluate(i => { const f = document.getElementById(i); if (f && !f.classList.contains('open')) f.click(); }, id);
  await sleep(600);
};
const setRangesInput = (k, i, v) => page.evaluate((k, i, v) => {
  const el = document.querySelector('#clock-ranges input[data-k="' + k + '"][data-i="' + i + '"]');
  el.value = v; el.dispatchEvent(new Event('change', { bubbles: true }));
}, k, i, v);
const readRanges = () => page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const kv = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get('settings'); q.onsuccess = () => r(q.result); });
  db.close(); return (kv && kv.v && kv.v.clockRanges) || null;
});
const isOpen = id => page.$eval('#' + id, el => el.classList.contains('open'));

await page.goto('http://127.0.0.1:'+port+'/',{waitUntil:'networkidle0',timeout:40000});
await sleep(1500);
await page.evaluate(()=>indexedDB.deleteDatabase('ai-companion'));
await page.reload({waitUntil:'networkidle0'}); await sleep(600);
await openSettings(page, sleep);

console.log('=== 1. 接口：默认收起，角标说话 ===');
t('有接口折叠头', !!(await page.$('#api-fold')));
t('默认收起', !(await isOpen('api-wrap')));
const hApi = await page.$eval('#api-wrap', el => Math.round(el.getBoundingClientRect().height));
t('收起时高度是 0（真收起来了，不是只藏了内容）', hApi === 0, hApi + 'px');
t('角标说「还没填 key」', (await page.$eval('#api-hint', el => el.textContent.trim())) === '还没填 key',
  await page.$eval('#api-hint', el => el.textContent.trim()));

console.log('');
console.log('=== 2. 角标跟着 key / 服务商走 ===');
await page.$eval('#s-apikey', (el, k) => { el.value = k; el.dispatchEvent(new Event('change', { bubbles: true })); }, KEY);
await sleep(400);
const hint1 = await page.$eval('#api-hint', el => el.textContent.trim());
t('填了 key 之后角标变成「服务商 · 模型」', hint1.includes('·') && !hint1.includes('还没填'), hint1);
const model1 = await page.$eval('#s-model', el => el.value);
t('角标里的模型名和输入框一致', hint1.includes(model1), hint1 + ' / ' + model1);
await openFold('api-fold');
t('点开后展开', await isOpen('api-wrap'));
const hApiOpen = await page.$eval('#api-wrap', el => Math.round(el.getBoundingClientRect().height));
t('展开后真的有内容', hApiOpen > 200, hApiOpen + 'px');
await page.select('#s-provider', 'kimi'); await sleep(900);
const hint2 = await page.$eval('#api-hint', el => el.textContent.trim());
t('换服务商后角标跟着换', hint2 !== hint1 && hint2.includes('·'), hint1 + ' → ' + hint2);

console.log('');
console.log('=== 3. 时段划分：折叠 + 入口 + 弹窗草稿 ===');
t('有时段折叠头', !!(await page.$('#clock-fold')));
t('默认收起', !(await isOpen('clock-wrap')));
const hClock = await page.$eval('#clock-wrap', el => Math.round(el.getBoundingClientRect().height));
t('收起时高度是 0', hClock === 0, hClock + 'px');
// ⚠️ 不能写死「手动」：全新库的 clockMode 默认就是开（跟现实走）——
// 一开始我按"默认手动"写，断言直接红了，是测试的前提错、不是代码错。
const hintOf = () => page.$eval('#clock-hint', el => el.textContent.trim());
const mode0 = await page.$eval('#s-clock-mode', el => el.checked);
t('角标跟「时间跟现实走」开关一致', (await hintOf()) === (mode0 ? '跟现实走' : '手动'),
  '开关=' + mode0 + ' 角标=' + (await hintOf()));
t('入口右侧显示「默认划分」', (await page.$eval('#ranges-brief', el => el.textContent.trim())) === '默认划分');
await openFold('clock-fold');
t('展开后能看到弹窗入口', !!(await page.$('#s-ranges-open')));
t('设置页上不再平铺那 8 行', (await page.$$('#clock-wrap .clock-range')).length === 0);

await page.click('#s-ranges-open'); await sleep(500);
t('弹窗打开了', !(await page.$eval('#phase-modal', el => el.classList.contains('hidden'))));
t('弹窗里有 8 行', (await page.$$('#phase-modal #clock-ranges .clock-range')).length === 8);

await setRangesInput('evening', 1, '20');
await page.click('#phase-cancel'); await sleep(500);
let rr = await readRanges();
t('点取消：改动不落库（傍晚还是 17-19）', JSON.stringify(rr && rr.evening) === '[17,19]', JSON.stringify(rr && rr.evening));
t('取消后弹窗关掉', await page.$eval('#phase-modal', el => el.classList.contains('hidden')));
t('取消后输入框退回原值', (await page.$eval('#clock-ranges input[data-k="evening"][data-i="1"]', el => el.value)) === '19');

await page.click('#s-ranges-open'); await sleep(500);
await setRangesInput('evening', 1, '20');
await page.click('#phase-ok'); await sleep(700);
rr = await readRanges();
t('点确定：改动落库（傍晚 17-20）', JSON.stringify(rr && rr.evening) === '[17,20]', JSON.stringify(rr && rr.evening));
t('确定后弹窗关掉', await page.$eval('#phase-modal', el => el.classList.contains('hidden')));
t('入口右侧变成「已改过」', (await page.$eval('#ranges-brief', el => el.textContent.trim())) === '已改过');

console.log('');
console.log('=== 4. 结束不能早于开始（弹窗里也算）===');
await page.click('#s-ranges-open'); await sleep(500);
await setRangesInput('dawn', 0, '10');
const dawn = await page.evaluate(() => [...document.querySelectorAll('#clock-ranges input[data-k="dawn"]')].map(e => e.value));
t('开始改成 10，结束自动跟到 11', JSON.stringify(dawn) === '["10","11"]', JSON.stringify(dawn));
await page.click('#phase-cancel'); await sleep(400);

console.log('');
console.log('=== 5. 拨「时间跟现实走」，角标立刻跟着翻 ===');
await page.click('#s-clock-mode'); await sleep(1500);
t('拨一下：角标跟着翻', (await hintOf()) === (mode0 ? '手动' : '跟现实走'), await hintOf());
await page.click('#s-clock-mode'); await sleep(1500);
t('拨回来：角标也回来', (await hintOf()) === (mode0 ? '跟现实走' : '手动'), await hintOf());

console.log('');
console.log('=== 6. 这两块折叠到底省了多少 ===');
await page.evaluate(() => { ['api-fold','clock-fold'].forEach(id => { const f = document.getElementById(id); if (f && f.classList.contains('open')) f.click(); }); });
await sleep(700);
const hClosed = await page.$eval('#view-settings main.scroll', el => el.scrollHeight);
await page.evaluate(() => { ['api-fold','clock-fold'].forEach(id => { const f = document.getElementById(id); if (f && !f.classList.contains('open')) f.click(); }); });
await sleep(700);
const hOpen = await page.$eval('#view-settings main.scroll', el => el.scrollHeight);
console.log('   设置页内容高度：两块收起 ' + hClosed + 'px / 两块展开 ' + hOpen + 'px');
t('收起后设置页明显短了', hOpen - hClosed > 400, '短了 ' + (hOpen - hClosed) + 'px');

console.log('');
t('全程无 JS 错误', errs.length===0, errs.slice(0,3).join(' | '));
console.log('');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close(); server.close();
process.exit(fail>0?1:0);
