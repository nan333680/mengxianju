// 人设 / 开场白：入口行 + 弹窗（v1.21.58）
//
// 要证明的三件事：
//   1. 编辑页上那两个大文本框真的收起来了（不是只盖住）
//   2. 取消不写回、确定才写回（草稿语义）
//   3. 保存链路没断 —— 点 ✓ 之后库里拿到的是弹出窗里写的新值
import puppeteer from 'puppeteer-core';
import http from 'http'; import fs from 'fs'; import path from 'path';
const R = path.resolve(import.meta.dirname).split(path.sep).join('/');
const WWW=`${R}/www`;
const CHROME='C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
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
const txt = sel => page.$eval(sel, el => el.textContent.trim());
const setModal = v => page.evaluate(v => { const b=document.getElementById('txt-input'); b.value=v; b.dispatchEvent(new Event('input',{bubbles:true})); }, v);
const P0 = '她是旧书店的店主。';
const openCharEdit = async () => {
  await page.evaluate(() => {
    const cards = [...document.querySelectorAll('#char-list .char-card')];
    const c = cards.find(x => x.textContent.includes('弹窗测试')) || cards[0];
    c.querySelector('button[data-edit]').click();
  });
  await sleep(700);
};

await page.goto('http://127.0.0.1:'+port+'/',{waitUntil:'networkidle0',timeout:40000});
await sleep(1200);
await page.evaluate(()=>indexedDB.deleteDatabase('ai-companion'));
await page.reload({waitUntil:'networkidle0'}); await sleep(600);
await page.evaluate(async (p0) => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const tx = db.transaction('characters','readwrite');
  tx.objectStore('characters').put({ id:'tx1', name:'弹窗测试', greeting:'（她看了你一眼）你来了。', persona:p0, avatar:null, createdAt: Date.now() });
  await new Promise(r => { tx.oncomplete = r; });
  db.close();
}, P0);
await page.reload({waitUntil:'networkidle0'}); await sleep(700);
await page.evaluate(() => document.getElementById('btn-chars').click()); await sleep(500);
await openCharEdit();

console.log('=== 1. 编辑页上：只留入口行，原来的大文本框收起来了 ===');
t('有开场白入口', !!(await page.$('#e-greeting-open')));
t('有人设入口', !!(await page.$('#e-persona-open')));
const vis = await page.evaluate(() => ({
  p: Math.round(document.getElementById('e-persona').getBoundingClientRect().height),
  g: Math.round(document.getElementById('e-greeting').getBoundingClientRect().height),
  disp: getComputedStyle(document.getElementById('e-persona')).display,
}));
t('原 textarea 高度 0 且 display:none', vis.p === 0 && vis.g === 0 && vis.disp === 'none', JSON.stringify(vis));

console.log('');
console.log('=== 2. 角标显示写了多少字 ===');
const briefP0 = await txt('#e-persona-brief');
const briefG0 = await txt('#e-greeting-brief');
t('人设角标是「N 字」', briefP0 === P0.length + ' 字', briefP0);
t('开场白角标是「N 字」', briefG0 === '（她看了你一眼）你来了。'.length + ' 字', briefG0);

console.log('');
console.log('=== 3. 点开弹窗：带出当前内容 ===');
await page.click('#e-persona-open'); await sleep(500);
t('弹窗打开了', !(await page.$eval('#txt-modal', el => el.classList.contains('hidden'))));
t('标题是「人设」', (await txt('#txt-title')) === '人设');
t('内容就是当前人设', (await page.$eval('#txt-input', el => el.value)) === P0);
const hArea = await page.$eval('#txt-input', el => Math.round(el.getBoundingClientRect().height));
t('弹窗里的框够大（>300px）', hArea > 300, hArea + 'px');

console.log('');
console.log('=== 4. 取消 = 不写回 ===');
await setModal('改了一半不想要');
t('字数跟着变', (await txt('#txt-count')) === '共 7 字', await txt('#txt-count'));
await page.click('#txt-cancel'); await sleep(400);
t('取消后源框没变', (await page.$eval('#e-persona', el => el.value)) === P0);
t('取消后角标没变', (await txt('#e-persona-brief')) === briefP0);
t('弹窗关掉了', await page.$eval('#txt-modal', el => el.classList.contains('hidden')));

console.log('');
console.log('=== 5. 确定 = 写回 ===');
const NEWP = '她是一家旧书店的店主，说话慢，喜欢在句尾加「呢」。';
await page.click('#e-persona-open'); await sleep(500);
await setModal(NEWP);
await page.click('#txt-ok'); await sleep(500);
t('确定后源框是新内容', (await page.$eval('#e-persona', el => el.value)) === NEWP);
t('弹窗关掉了', await page.$eval('#txt-modal', el => el.classList.contains('hidden')));
t('角标跟着更新', (await txt('#e-persona-brief')) === NEWP.length + ' 字', await txt('#e-persona-brief'));

console.log('');
console.log('=== 6. 开场白走同一条路 ===');
await page.click('#e-greeting-open'); await sleep(500);
t('标题换成「开场白」', (await txt('#txt-title')) === '开场白');
const NEWG = '（放下手里的书）你来啦。';
await setModal(NEWG);
await page.click('#txt-ok'); await sleep(400);
t('开场白写回了源框', (await page.$eval('#e-greeting', el => el.value)) === NEWG);
t('开场白角标跟着变', (await txt('#e-greeting-brief')) === NEWG.length + ' 字', await txt('#e-greeting-brief'));

console.log('');
console.log('=== 7. 点 ✓ 保存：真的落库（保存链路没断）===');
await page.click('#btn-edit-save'); await sleep(1000);
const saved = await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const c = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').get('tx1'); q.onsuccess = () => r(q.result); });
  db.close(); return c ? { p: c.persona, g: c.greeting } : null;
});
t('人设落库了', !!saved && saved.p === NEWP, JSON.stringify(saved));
t('开场白落库了', !!saved && saved.g === NEWG, JSON.stringify(saved));

console.log('');
console.log('=== 8. 重开编辑页：角标按库里那份显示 ===');
await page.reload({waitUntil:'networkidle0'}); await sleep(800);
await page.evaluate(() => document.getElementById('btn-chars').click()); await sleep(500);
await openCharEdit();
t('重开后角标 = 库里人设的字数', (await txt('#e-persona-brief')) === NEWP.length + ' 字', await txt('#e-persona-brief'));
t('重开后角标 = 库里开场白的字数', (await txt('#e-greeting-brief')) === NEWG.length + ' 字', await txt('#e-greeting-brief'));

console.log('');
console.log('=== 9. 到底省了多少 ===');
const cmp = await page.evaluate(() => {
  const p = document.getElementById('e-persona'), g = document.getElementById('e-greeting');
  const hRow = Math.round(document.getElementById('e-persona-open').getBoundingClientRect().height
                + document.getElementById('e-greeting-open').getBoundingClientRect().height);
  p.classList.remove('hidden-src'); g.classList.remove('hidden-src');
  const hBox = Math.round(p.getBoundingClientRect().height + g.getBoundingClientRect().height);
  p.classList.add('hidden-src'); g.classList.add('hidden-src');
  return { hRow, hBox };
});
console.log('   两个入口行 ' + cmp.hRow + 'px  ←→  原来两个文本框 ' + cmp.hBox + 'px');
t('确实短了（省 >200px）', cmp.hBox - cmp.hRow > 200, '省 ' + (cmp.hBox - cmp.hRow) + 'px');
t('收起来后两个入口行还很矮', cmp.hRow < 130, cmp.hRow + 'px');

console.log('');
t('全程无 JS 错误', errs.length===0, errs.slice(0,3).join(' | '));
console.log('');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close(); server.close();
process.exit(fail>0?1:0);
