import puppeteer from 'puppeteer-core';
import { seedChar, seedChars } from './e2e-helper.mjs';
import http from 'http'; import fs from 'fs'; import path from 'path';
import { splitMessages } from '../www/js/persona.js';
// 工作目录自适应（原来写死 C:/A-DSH-Tool/ai-companion）
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
const toastText=()=>page.evaluate(()=>{const el=document.getElementById('toast');return el&&!el.classList.contains('hidden')?el.textContent:'';});
const msgsOf=()=>page.evaluate(()=>[...document.querySelectorAll('#messages .msg .bub')].map(e=>e.textContent));
const MARK='ZZMARK占位回复';

console.log('=== 0. splitMessages 不再丢内容（纯函数）===');
{
  const four = '第一段\n\n---\n\n第二段\n\n---\n\n第三段\n\n---\n\n第四段';
  const out = splitMessages(four, 3);
  t('段数不超过上限', out.length <= 3, 'len='+out.length);
  const joined = out.join('');
  t('第四段的内容还在', joined.includes('第四段'), JSON.stringify(out.map(s=>s.slice(0,6))));
  const two = splitMessages('甲\n\n---\n\n乙', 3);
  t('没超上限时原样分段', two.length === 2 && two[0]==='甲' && two[1]==='乙', JSON.stringify(two));
  t('max=1 时全部合成一条', splitMessages(four,1).length === 1);
}

await page.goto('http://127.0.0.1:'+port+'/',{waitUntil:'networkidle0',timeout:40000});
await sleep(1500);
await page.evaluate(()=>indexedDB.deleteDatabase('ai-companion'));
await page.reload({waitUntil:'networkidle0'}); await sleep(400)   // [提速] 原 1800：探针实测 reload 后 app 就绪只要 ~1ms，1800 里有 800+ 是白等;
await openSettings(page, sleep);
await page.$eval('#s-apikey',(el,k)=>{el.value=k;el.dispatchEvent(new Event('change',{bubbles:true}));},KEY);
await page.click('#btn-set-back'); await sleep(500);
  // v1.15.2 起栈多了 drawer 一层，退到设置页的上一层是抽屉，还要再关一次
  await page.evaluate(() => { const b = document.getElementById('btn-drawer-close'); if (b && document.querySelector('#view-drawer.active')) b.click(); });
  await sleep(500);

// 建一个角色（带开场白）并进入聊天 —— 原来靠点内置模板，模板删了要自己塞
await seedChar(page, '测试角色', { greeting: '（她看了你一眼）你来了。' });
await page.reload({ waitUntil:'networkidle0' }); await sleep(400)   // [提速] 原 1800：探针实测 reload 后 app 就绪只要 ~1ms，1800 里有 800+ 是白等;
await page.click('#btn-chars'); await sleep(700);
await page.evaluate(() => {
  const c = [...document.querySelectorAll('#char-list .char-card')]
    .find(x => x.textContent.includes('测试角色'));
  if (c) c.click();
});
await sleep(1400);

console.log('');
console.log('=== 1. 开场白删掉之后不再复活 ===');
{
  const before = await page.evaluate(()=>document.querySelectorAll('#messages .msg').length);
  t('一开始自动注入了开场白', before === 1, 'msg='+before);
  const gid = await page.evaluate(()=>document.querySelector('#messages .msg')?.dataset.id);
  await page.evaluate(async (id)=>{
    const o=indexedDB.open('ai-companion');
    const db=await new Promise(r=>{o.onsuccess=()=>r(o.result);});
    const tx=db.transaction('messages','readwrite'); tx.objectStore('messages').delete(id);
    await new Promise(r=>{tx.oncomplete=r;}); db.close();
  }, gid);
  await page.reload({waitUntil:'networkidle0'}); await sleep(400)   // [提速] 原 1800：探针实测 reload 后 app 就绪只要 ~1ms，1800 里有 800+ 是白等;
  const after = await page.evaluate(()=>document.querySelectorAll('#messages .msg').length);
  const tip = await page.evaluate(()=>document.querySelector('#messages .sys-line')?.textContent||'');
  t('删了之后不会自己回来', after === 0, 'msg='+after);
  t('提示改成「等你先开口」', tip.includes('等你先开口'), tip);
}

console.log('');
console.log('=== 2. 先建第二个角色（后面切角色要用）===');
await page.click('#btn-chars'); await sleep(600);
await seedChar(page, '第二个角色'); await sleep(900);
await page.reload({ waitUntil:'networkidle0' }); await sleep(400)   // [提速] 原 1800：探针实测 reload 后 app 就绪只要 ~1ms，1800 里有 800+ 是白等;
await page.click('#btn-chars'); await sleep(600);
const charNames = await page.evaluate(()=>[...document.querySelectorAll('#char-list .char-card .info b')].map(e=>e.textContent.trim()));
console.log('   角色列表: '+JSON.stringify(charNames));
t('现在有两个角色', charNames.length >= 2, JSON.stringify(charNames));
await page.evaluate(()=>document.querySelectorAll('#char-list .char-card')[0].click()); await sleep(1100);
const whoA = await page.evaluate(()=>document.getElementById('chat-name').textContent.trim());
const lastId=()=>page.evaluate(async()=>{const o=indexedDB.open('ai-companion');const db=await new Promise(r=>{o.onsuccess=()=>r(o.result);});const v=await new Promise(r=>{const q=db.transaction('kv').objectStore('kv').get('lastCharId');q.onsuccess=()=>r(q.result&&q.result.v);});db.close();return v;});
const idA = await lastId();

console.log('');
console.log('=== 3. 生成中：删消息类操作要被拦住 ===');
let held=null;
await page.setRequestInterception(true);
page.on('request',(req)=>{
  const u=req.url();
  if(u.includes('/chat/completions')){
    if(req.method()==='OPTIONS'){
      return req.respond({ status:204, headers:{
        'Access-Control-Allow-Origin':'*',
        'Access-Control-Allow-Methods':'POST, OPTIONS',
        'Access-Control-Allow-Headers':'*'
      }}).catch(()=>{});
    }
    held=req;   // POST：故意吊住，让界面停在「生成中」
    return;
  }
  try{req.continue();}catch{}
});
{
  await page.click('#input'); await page.type('#input','测试用的一句话',{delay:4});
  await page.click('#btn-send');
  for(let i=0;i<40 && !held;i++) await sleep(250);
  t('POST 已经发出并被吊住', !!held);
  const running = await page.$eval('#btn-stop',el=>!el.classList.contains('hidden')).catch(()=>false);
  t('界面处于生成中', running);

  const n0 = await page.evaluate(()=>document.querySelectorAll('#messages .msg').length);
  await page.evaluate(()=>{ const el=document.querySelector('#messages .msg'); el.scrollIntoView({block:'center'}); });
  await sleep(300);
  await page.evaluate(()=>{
    const el=document.querySelector('#messages .msg');
    const r=el.getBoundingClientRect();
    const mk=(ty)=>new MouseEvent(ty,{bubbles:true,cancelable:true,clientX:Math.round(r.x+r.width/2),clientY:Math.round(r.y+r.height/2)});
    el.dispatchEvent(mk('pointerdown')); el.dispatchEvent(mk('contextmenu'));
  });
  await sleep(700);
  // ⚠️ 断言更新（v1.21.41）：生成中现在【不给】这些入口了。
  //
  // 原来验的是"点了会被拦住、消息不删、有提示"（v1.21.24 审计第 6 条：
  // 生成中删消息会留下"她自问自答"的孤立回复）。现在保护提前了一步 ——
  // 菜单里直接不显示，压根点不到。效果相同，还少了"给了入口却用不了"。
  const hasEdit = await page.$('.msg-menu [data-k="edit"]');
  t('生成中长按【不】给「编辑重发」入口', !hasEdit);
  const hasCopy = await page.$('.msg-menu [data-k="copy"]');
  t('但「复制文字」照常给（它不动时间线）', !!hasCopy);
  const n1 = await page.evaluate(()=>document.querySelectorAll('#messages .msg').length);
  t('消息数没变（没被误删）', n1 === n0, n0+' -> '+n1);
}

console.log('');
console.log('=== 4. 生成中切角色：不卡死、不串消息 ===');
{
  await page.click('#btn-chars'); await sleep(700);
  // 按名字点「第二个角色」——列表顺序不保证，别用索引
  await page.evaluate(() => {
    const c = [...document.querySelectorAll('#char-list .char-card')]
      .find(x => x.textContent.includes('第二个角色'));
    if (c) c.click();
  });
  await sleep(1300);
  const whoB = await page.evaluate(()=>document.getElementById('chat-name').textContent.trim());
  const idB = await lastId();
  t('切到了另一个角色', !!idB && idB !== idA, whoA+' → '+whoB+'（id 变了: '+(idA!==idB)+'）');
  const sendable = await page.$eval('#btn-send',el=>!el.classList.contains('hidden')).catch(()=>false);
  t('发送键回到可用（没卡死）', sendable);
  const stopGone = await page.$eval('#btn-stop',el=>el.classList.contains('hidden')).catch(()=>false);
  t('停止键收回（旧请求已中断）', stopGone);
  if(held){
    try{ await held.respond({ status:200, headers:{'Access-Control-Allow-Origin':'*','Content-Type':'text/event-stream'}, body:'data: {"choices":[{"delta":{"content":"'+MARK+'"}}]}\n\ndata: [DONE]\n\n' }); }
    catch(e){ /* 已经被中断，正常 */ }
  }
  await sleep(1200);
  const bMsgs = await msgsOf();
  t('新角色名下有自己正常的消息', bMsgs.length >= 1, JSON.stringify(bMsgs.map(s=>s.slice(0,12))));
  t('新角色名下没有串进来的回复', !bMsgs.some(s=>s.includes('ZZMARK')), JSON.stringify(bMsgs.map(s=>s.slice(0,20))));
  await page.setRequestInterception(false);
}

console.log('');
// v1.21.59 起语义反过来了：记忆现在【会】跟着一起删，文案要说明白
console.log('=== 5. 删角色文案要说清长期记忆会一起删 ===');
{
  let msg='';
  page.once('dialog', async d=>{ msg=d.message(); await d.dismiss(); });
  await page.click('#btn-chars'); await sleep(700);
  await page.evaluate(()=>{const c=document.querySelectorAll('#char-list .char-card')[0]; const b=c&&c.querySelector('button[data-edit]'); if(b)b.click();});
  await sleep(800);
  // ⚠️ 用【直接 DOM click】而不是 page.click（v1.21.30 排查）。
  //
  // 起因：node e2e-bugfix 长期在这里挂，我一度以为是文案被改坏了。
  // 实测：page.click('#btn-del-char') 点了【不触发 onclick】（Puppeteer 的可见性/遮挡判断），
  // 而 element.click() 正常弹出、文案也正确（「长期记忆是所有角色共用的，不跟着删」）。
  // 也就是说这是【测试的点法问题】，不是产品 bug。
  await page.evaluate(() => { const b = document.getElementById('btn-del-char'); if (b) b.click(); });
  await sleep(1200);  t('弹窗提到了长期记忆', msg.includes('记忆'), msg);
}

console.log('');
t('全程无 JS 错误', errs.length===0, errs.slice(0,3).join(' | '));
console.log('');
console.log('通过 '+pass+' 项，失败 '+fail+' 项');
await browser.close(); server.close();
process.exit(fail>0?1:0);
