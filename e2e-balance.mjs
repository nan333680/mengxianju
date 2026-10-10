import puppeteer from 'puppeteer-core';
import { seedChar } from './e2e-helper.mjs';
import http from 'http'; import fs from 'fs'; import path from 'path';
// 工作目录自适应（原来写死 C:/A-DSH-Tool/ai-companion）
const R = path.resolve(import.meta.dirname).split(path.sep).join('/');
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

// ⚠️ 余额查询必须 mock（v1.21.40 修）。
// 这一步是真的 GET api.deepseek.com/user/balance —— 依赖外部服务、依赖一把真 Key，
// 而且每跑一次回归就花一次钱。回归要能离线重复跑，所以这里只验
// "UI 拿到数据后显示得对不对"；真实接口通不通是产品运行时的事，不该由自动回归承担。
await page.setRequestInterception(true);
page.on('request', req => {
  const u = req.url();
  const isBalance = u.includes('/user/balance');
  // ⚠️ /chat/completions 也得 mock（v1.21.40）。
  //    本套件后半段点「删除」会走 del 分支 → await tidyNow() → 一次真实的模型调用。
  //    原来的注释写着"无 mock 环境下会失败"，能通过纯粹是因为产品里预置了真 Key。
  //    Key 一撤，这次调用就 401，队列不被消费，最后那条断言必然挂。
  //    记忆库此时是空的，模型自然回 []，正好对上 1.4「合法空数组要消费队列」的预期。
  const isChat = u.includes('/chat/completions');
  if (!isBalance && !isChat) { req.continue(); return; }
  if (req.method() === 'OPTIONS') {
    req.respond({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' } });
    return;
  }
  if (isBalance) {
    req.respond({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        is_available: true,
        balance_infos: [{ currency: 'CNY', total_balance: '12.34', granted_balance: '0.00', topped_up_balance: '12.34' }],
      }),
    });
    return;
  }
  // ⚠️ 故意延迟 900ms 再回（v1.21.40）。
  // 本套件在点「删除」后 150ms 就去读待清理清单，断言那时里面【有】1 条。
  // mock 秒回的话，del 分支的 await tidyNow() 会在 150ms 内跑完并把队列消费掉，
  // 读到的是空 —— 那是 mock 太快导致的假失败，真实接口要 1~2 秒。
  setTimeout(() => {
    try {
      req.respond({
        status: 200,
        contentType: 'application/json',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ choices: [{ message: { content: '[]' } }] }),
      });
    } catch (e) { /* 页面可能已经关了 */ }
  }, 900);
});

// v1.15.2 起右上角 ⚙ 拉开【抽屉】，设置页要从抽屉里的「全部设置」进。
// 这个函数兼容旧点法，且可重复调用（已在设置页就跳过第一步）。
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
let pass=0,fail=0;
const t=(n,ok,ex='')=>{if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));}};

await page.goto('http://127.0.0.1:'+port+'/',{waitUntil:'networkidle0',timeout:40000});
await sleep(1500);
await page.evaluate(()=>indexedDB.deleteDatabase('ai-companion'));
await page.reload({waitUntil:'networkidle0'}); await sleep(400)   // [提速] 原 1800：探针实测 reload 后 app 就绪只要 ~1ms，1800 里有 800+ 是白等;
// v1.21.59：全新安装不再自动建角色（产品改空），测试自己塞一个
await seedChar(page, '测试角色', { greeting: '' });   // 空开场白：不额外多出一条消息
await page.reload({waitUntil:'networkidle0'}); await sleep(500);
await openSettings(page, sleep);
// v1.21.57：「接口」收成折叠了，要点里面的按钮（余额查询）得先展开
await page.evaluate(() => { const f = document.getElementById('api-fold'); if (f && !f.classList.contains('open')) f.click(); });
await sleep(600);
await page.$eval('#s-apikey',(el,k)=>{el.value=k;el.dispatchEvent(new Event('change',{bubbles:true}));},KEY);
await sleep(300);

console.log('=== 1. 余额查询 ===');
t('接口栏里有余额显示位', !!(await page.$('#s-balance')));
t('有查询按钮', !!(await page.$('#btn-balance')));
await page.click('#btn-balance');
await sleep(3500);
const bal = await page.$eval('#s-balance', el => el.textContent.trim());
console.log('   余额显示: ' + bal);
t('查到了余额（不是「查询失败」）', bal !== '查询失败' && bal !== '—' && bal !== '查询中…', bal);
t('带货币单位', /CNY|USD/.test(bal), bal);

console.log('');
console.log('=== 2. 删掉的对话会进「待清理」清单 ===');
// 「谁删了什么」现在按角色分开存：memDeleted:<charId>
const readDeleted = async () => page.evaluate(async()=>{
  const o=indexedDB.open('ai-companion');
  const db=await new Promise(r=>{o.onsuccess=()=>r(o.result);});
  const cs=await new Promise(r=>{const q=db.transaction('characters').objectStore('characters').getAll();q.onsuccess=()=>r(q.result);});
  const k='memDeleted:'+cs[0].id;
  const v=await new Promise(r=>{const q=db.transaction('kv').objectStore('kv').get(k);q.onsuccess=()=>r(q.result);});
  db.close();return v?v.v:[];
});
const before = await readDeleted();
t('一开始清单是空的', before.length===0, JSON.stringify(before));
await page.click('#btn-set-back'); await sleep(400);
  // v1.15.2 起栈多了 drawer 一层，退到设置页的上一层是抽屉，还要再关一次
  await page.evaluate(() => { const b = document.getElementById('btn-drawer-close'); if (b && document.querySelector('#view-drawer.active')) b.click(); });
  await sleep(500);
await page.evaluate(async()=>{
  const o=indexedDB.open('ai-companion');
  const db=await new Promise(r=>{o.onsuccess=()=>r(o.result);});
  const cs=await new Promise(r=>{const q=db.transaction('characters').objectStore('characters').getAll();q.onsuccess=()=>r(q.result);});
  const tx=db.transaction('messages','readwrite');const st=tx.objectStore('messages');
  st.put({id:'del-1',charId:cs[0].id,role:'user',content:'我明天要去看花展',images:[],ts:Date.now()-5000});
  await new Promise(r=>{tx.oncomplete=r;});db.close();
});
await page.reload({waitUntil:'networkidle0'}); await sleep(400)   // [提速] 原 1800：探针实测 reload 后 app 就绪只要 ~1ms，1800 里有 800+ 是白等;
const i1 = await page.evaluate(()=>[...document.querySelectorAll('.msg')].findIndex(el=>el.dataset.id==='del-1'));
const box = await page.evaluate((i)=>{const r=document.querySelectorAll('.msg')[i].getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};},i1);
await page.touchscreen.touchStart(box.x,box.y); await sleep(620);
await page.evaluate((i)=>{const el=document.querySelectorAll('.msg')[i];if(el)el.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));},i1);
await sleep(400); await page.touchscreen.touchEnd(); await sleep(400);
await page.click('.msg-menu [data-k="del"]');
await sleep(150);
const imm = await readDeleted();
// ⚠️ 等久一点（v1.21.37）：del 分支现在会 await tidyNow()，
// 而它要等一次 API 调用（无 mock 环境下会失败），900ms 不够。
await sleep(3000);
const after = await readDeleted();
console.log('   清单: ' + JSON.stringify(after));
// ⚠️ 断言更新（v1.21.37）：del 分支现在【await tidyNow()】（复审 贯穿性根因），
// 而复审 1.4 又要求「模型返回合法空数组时消费队列」——
// 这套测试记忆库为空，模型自然回 []，所以队列【会被正确消费掉】。
// 真正要验的是【删除的动作确实记了账】，用点完立刻那次读：
t('被删的内容进了清单（供整理时核对）', imm.length===1 && imm[0].includes('花展'), JSON.stringify(imm));
t('清单随后被整理消费掉（1.4 的预期行为）', after.length===0, JSON.stringify(after));

console.log('');
t('全程无 JS 错误', errs.length===0, errs.slice(0,3).join(' | '));
console.log('');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close(); server.close();
process.exit(fail>0?1:0);
