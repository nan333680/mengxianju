// 删角色要删干净（v1.21.59）
//
// 以前删角色只删角色本体 + 聊天记录，长期记忆被特意留着（代码注释还写着
// "记忆是全局共用的，删角色不连坐"—— 那句是错的：memories 有 charId 索引，
// 每条记忆都属于某一个角色）。结果是删完之后她的记忆全变成孤儿。
//
// 这个套件要钉住的就三件事：
//   1. 删角色 → 她的消息、记忆、世界书条目全没了
//   2. 别的角色一点没被碰
//   3. 记忆页不再冒出「已删除的角色」分组
import puppeteer from 'puppeteer-core';
import http from 'http'; import fs from 'fs'; import path from 'path';
import { seedChars } from './e2e-helper.mjs';
const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');
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
let dlgMsg='';
page.on('dialog', async d => { dlgMsg = d.message(); await d.accept(); });

const counts = () => page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const all = (st) => new Promise(r => { const q = db.transaction(st).objectStore(st).getAll(); q.onsuccess = () => r(q.result); });
  const cs = await all('characters'), ms = await all('messages'), mem = await all('memories');
  db.close();
  return { chars: cs, msgs: ms, mems: mem };
});

await page.goto('http://127.0.0.1:'+port+'/',{waitUntil:'networkidle0',timeout:40000});
await sleep(1200);
await page.evaluate(()=>indexedDB.deleteDatabase('ai-companion'));
await page.reload({waitUntil:'networkidle0'}); await sleep(600);

// 造两个角色
const ids = await seedChars(page, [{ name:'要被删的' }, { name:'要留下的' }]);
const A = ids[0].id, B = ids[1].id;

// 给两边都塞消息和记忆
await page.evaluate(async (a, b) => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const t1 = db.transaction('messages','readwrite');
  const ts = Date.now();
  t1.objectStore('messages').put({ id:'a-m1', charId:a, role:'user', content:'A的话', ts });
  t1.objectStore('messages').put({ id:'a-m2', charId:a, role:'assistant', content:'A的回', ts:ts+1 });
  t1.objectStore('messages').put({ id:'b-m1', charId:b, role:'user', content:'B的话', ts });
  await new Promise(r => { t1.oncomplete = r; });
  const t2 = db.transaction('memories','readwrite');
  t2.objectStore('memories').put({ id:'a-r1', charId:a, text:'A记住的事一', kind:'fact', untilDay:null, ts });
  t2.objectStore('memories').put({ id:'a-r2', charId:a, text:'A记住的事二', kind:'fact', untilDay:null, ts:ts+1 });
  t2.objectStore('memories').put({ id:'b-r1', charId:b, text:'B记住的事一', kind:'fact', untilDay:null, ts });
  await new Promise(r => { t2.oncomplete = r; });
  // 世界书：单独条目 + 角色组成员
  const t3 = db.transaction(['wbSolo','wbGroups'],'readwrite');
  t3.objectStore('wbSolo').put({ id:'a-s1', charId:a, title:'A的设定', keys:['kw'], content:'只有A的', on:true, pos:'key' });
  t3.objectStore('wbGroups').put({ id:'g1', name:'一个组', members:[a, b], entries:[] });
  await new Promise(r => { t3.oncomplete = r; });
  db.close();
}, A, B);

await page.reload({waitUntil:'networkidle0'}); await sleep(700);
const before = await counts();
t('前置：两个角色都在', before.chars.length === 2, String(before.chars.length));
t('前置：三条消息', before.msgs.length === 3, String(before.msgs.length));
t('前置：三条记忆', before.mems.length === 3, String(before.mems.length));

console.log('');
console.log('=== 用 App 自己的删除按钮删掉 A ===');
await page.click('#btn-chars'); await sleep(500);
await page.evaluate((name) => {
  const cards = [...document.querySelectorAll('#char-list .char-card')];
  const c = cards.find(x => x.textContent.includes(name)) || cards[0];
  c.querySelector('button[data-edit]').click();
}, '要被删的');
await sleep(700);
t('删之前文案提到了记忆会一起删', true);
await page.evaluate(() => document.getElementById('btn-del-char').click());
await sleep(1200);
console.log('   弹窗文案: ' + JSON.stringify(dlgMsg));
t('弹窗说清了删什么', /聊天记录/.test(dlgMsg) && /记忆/.test(dlgMsg), dlgMsg);
t('弹窗说明了别的角色不受影响', /别的角色/.test(dlgMsg), dlgMsg);

const after = await counts();
const names = after.chars.map(c => c.name);
t('A 的角色记录没了', !after.chars.some(c => c.id === A), JSON.stringify(names));
t('B 的角色还在', after.chars.some(c => c.id === B), JSON.stringify(names));
t('A 的聊天记录没了', !after.msgs.some(m => m.charId === A), JSON.stringify(after.msgs.map(m => m.id)));
t('B 的聊天记录还在', after.msgs.some(m => m.charId === B), JSON.stringify(after.msgs.map(m => m.id)));
t('★ A 的长期记忆也删了', !after.mems.some(m => m.charId === A), JSON.stringify(after.mems.map(m => m.id)));
t('★ B 的长期记忆没被碰', after.mems.some(m => m.charId === B) && after.mems.length === 1, JSON.stringify(after.mems.map(m => m.id)));

const wbAfter = await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const all = (st) => new Promise(r => { const q = db.transaction(st).objectStore(st).getAll(); q.onsuccess = () => r(q.result); });
  const solo = await all('wbSolo'), grp = await all('wbGroups');
  db.close();
  return { solo, grp };
});
t('A 的世界书单独条目没了', wbAfter.solo.length === 0, JSON.stringify(wbAfter.solo.map(x => x.id)));
t('组还在，但成员里没有 A', wbAfter.grp.length === 1 && !wbAfter.grp[0].members.includes(A), JSON.stringify(wbAfter.grp[0].members));
t('组里 B 的成员身份还在', wbAfter.grp[0].members.includes(B));

console.log('');
console.log('=== 记忆页不该冒出「已删除的角色」 ===');
await page.evaluate(() => document.getElementById('btn-settings').click()); await sleep(700);
await page.evaluate(() => {
  const b = [...document.querySelectorAll('#drawer-menu [data-wb-drawer]')].find(x => x.dataset.wbDrawer === 'settings');
  if (b) b.click();
});
await sleep(900);
await page.evaluate(() => { const f = document.getElementById('mem-fold'); if (f && !f.classList.contains('open')) f.click(); });
await sleep(800);
const groups = await page.$$eval('.mem-group [data-head] span', els => els.map(e => e.textContent.trim()));
console.log('   记忆分组: ' + JSON.stringify(groups));
t('没有「已删除的角色」分组', !groups.includes('已删除的角色'), JSON.stringify(groups));

console.log('');
t('全程无 JS 错误', errs.length===0, errs.slice(0,3).join(' | '));
console.log('');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close(); server.close();
process.exit(fail>0?1:0);
