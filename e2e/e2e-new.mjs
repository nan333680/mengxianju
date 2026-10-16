import puppeteer from 'puppeteer-core';
import { seedChar } from './e2e-helper.mjs';
import http from 'http'; import fs from 'fs'; import path from 'path';
// 工作目录自适应（原来写死 C:/A-DSH-Tool/ai-companion）
const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');
const WWW=`${R}/www`;
const CHROME='C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
// 测试用的 Key：优先取环境变量，没有就用占位符。
// ⚠️ 绝不在这里写死真 Key —— 那等于把 Key 提交进版本库。
//    这些套件需要 Key，只是因为产品的默认值（v1.21.40 起）变成了空串。
const KEY = process.env.DSH_API_KEY || 'sk-test';
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'};
const server=http.createServer((req,res)=>{
  // v0.4.3：第 3 节要验「气泡上的 token 用量角标」，就得有个会回 usage 帧的模型。
  // 照 e2e/e2e-archive.mjs 的做法，把 /api/chat/completions 挂在本机这台 server 上
  // （不出网），再把产品的 baseUrl 指过来 —— 见下面设 #s-baseurl 那两行。
  // 在此之前这一节是打真网的：没有真 Key 时必然拿不到 usage，3 条断言长期红着。
  if(req.url.startsWith('/api/chat/completions')){
    let raw='';req.on('data',c=>raw+=c);
    req.on('end',()=>{
      res.writeHead(200,{'Content-Type':'text/event-stream'});
      res.write('data: '+JSON.stringify({choices:[{delta:{content:'用量测试。'}}]})+'\n\n');
      res.write('data: '+JSON.stringify({choices:[{delta:{}}],usage:{prompt_tokens:12,completion_tokens:7,total_tokens:19}})+'\n\n');
      res.write('data: [DONE]\n\n');res.end();
    });
    return;
  }
  let p=decodeURIComponent(req.url.split('?')[0]);if(p==='/')p='/index.html';const f=path.join(WWW,p);if(!fs.existsSync(f)){res.writeHead(404);res.end('404');return;}res.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream'});res.end(fs.readFileSync(f));});
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

await page.goto('http://127.0.0.1:'+port+'/',{waitUntil:'networkidle0',timeout:40000});
await sleep(1500);
await page.evaluate(()=>indexedDB.deleteDatabase('ai-companion'));
await page.reload({waitUntil:'networkidle0'}); await sleep(400)   // [提速] 原 1800：探针实测 reload 后 app 就绪只要 ~1ms;
// v1.21.59：全新安装不再自动建角色（产品改空），测试自己塞一个
await seedChar(page, '测试角色', { greeting: '' });   // 空开场白：不额外多出一条消息
await page.reload({waitUntil:'networkidle0'}); await sleep(500);
await openSettings(page, sleep);
await page.$eval('#s-apikey',(el,k)=>{el.value=k;el.dispatchEvent(new Event('change',{bubbles:true}));},KEY);
await sleep(300);
// v0.4.3：把 baseUrl 指到本机 server（它挂着会回 usage 帧的 /api/chat/completions），别再打真网。
await page.$eval('#s-baseurl',(el,p)=>{el.value=p;el.dispatchEvent(new Event('change',{bubbles:true}));},'http://127.0.0.1:'+port+'/api');
await sleep(300);

console.log('=== 1. 时段划分收成折叠 + 8 行时段搬进弹窗 ===');
t('有时段划分的折叠头', !!(await page.$('#clock-fold')));
t('默认是收起的', !(await page.$eval('#clock-wrap', el => el.classList.contains('open'))));
await page.click('#clock-fold'); await sleep(600);
t('点开后展开了', await page.$eval('#clock-wrap', el => el.classList.contains('open')));
t('展开后是「每个时段对应几点」的入口', !!(await page.$('#s-ranges-open')));
t('设置页上不再平铺那 8 行', (await page.$$('#clock-wrap .clock-range')).length === 0);
await page.click('#s-ranges-open'); await sleep(500);
t('弹窗里有 8 行时段', (await page.$$('#phase-modal #clock-ranges .clock-range')).length === 8);
await page.click('#phase-cancel'); await sleep(400);
t('取消后弹窗关掉', await page.$eval('#phase-modal', el => el.classList.contains('hidden')));
await page.click('#clock-fold'); await sleep(600);

console.log('');
console.log('=== 2. 记忆管理里有「记忆节奏」和「已记住的事」===');
t('有「记忆节奏」折叠头（全局参数）', !!(await page.$('#mem-set-fold')));
t('有「已记住的事」折叠头', !!(await page.$('#mem-fold')));
t('默认收起', !(await page.$eval('#mem-wrap', el => el.classList.contains('open'))));
await page.click('#mem-fold'); await sleep(700);
t('展开后有按人物分组的容器', !!(await page.$('#mem-groups')));
t('说明文字指向了角色编辑页', (await page.$eval('#view-settings', el => el.textContent)).includes('角色编辑页'));
await page.click('#mem-fold'); await sleep(600);
t('收回去', !(await page.$eval('#mem-wrap', el => el.classList.contains('open'))));

console.log('');
console.log('=== 3. token 用量 ===');
await page.click('#btn-set-back'); await sleep(400);
  // v1.15.2 起栈多了 drawer 一层，退到设置页的上一层是抽屉，还要再关一次
  await page.evaluate(() => { const b = document.getElementById('btn-drawer-close'); if (b && document.querySelector('#view-drawer.active')) b.click(); });
  await sleep(500);
await page.click('#input');
await page.type('#input','说句话',{delay:4});
await page.click('#btn-send');
for(let i=0;i<80;i++){await sleep(500);const b=await page.$eval('#btn-stop',el=>!el.classList.contains('hidden')).catch(()=>false);if(!b)break;}
await sleep(1500);
const tk = await page.$$eval('.msg .tk', els=>els.map(e=>e.textContent.trim()));
console.log('   气泡上的用量: ' + JSON.stringify(tk));
t('AI 气泡上显示了 token 用量', tk.length>0, JSON.stringify(tk));
t('格式是 ↑输入 ↓输出', tk.some(x=>/↑\d+ ↓\d+/.test(x)), JSON.stringify(tk));
const hasUsage = await page.evaluate(async()=>{const o=indexedDB.open('ai-companion');const db=await new Promise(r=>{o.onsuccess=()=>r(o.result);});const all=await new Promise(r=>{const q=db.transaction('messages').objectStore('messages').getAll();q.onsuccess=()=>r(q.result);});db.close();const a=all.find(m=>m.role==='assistant'&&m.usage);return a?a.usage:null;});
console.log('   存下来的 usage: ' + JSON.stringify(hasUsage));
t('usage 存进了消息（刷新也在）', !!hasUsage && hasUsage.prompt_tokens>0, JSON.stringify(hasUsage));

console.log('');
console.log('=== 4. 回溯重聊 ===');
// 造几条：让 AI 消息不在最后
const cnt0 = await page.evaluate(async()=>{const o=indexedDB.open('ai-companion');const db=await new Promise(r=>{o.onsuccess=()=>r(o.result);});const cs=await new Promise(r=>{const q=db.transaction('characters').objectStore('characters').getAll();q.onsuccess=()=>r(q.result);});const cid=cs[0].id;const tx=db.transaction('messages','readwrite');const st=tx.objectStore('messages');const base=Date.now();st.put({id:'rw-a',charId:cid,role:'assistant',content:'中间这句',ts:base-3000});st.put({id:'rw-b',charId:cid,role:'user',content:'后面的话',ts:base-2000});st.put({id:'rw-c',charId:cid,role:'assistant',content:'最后一句',ts:base-1000});await new Promise(r=>{tx.oncomplete=r;});db.close();return 1;});
await page.reload({waitUntil:'networkidle0'}); await sleep(400)   // [提速] 原 1800：探针实测 reload 后 app 就绪只要 ~1ms;
const idxA = await page.evaluate(()=>[...document.querySelectorAll('.msg')].findIndex(el=>el.dataset.id==='rw-a'));
t('找到中间那条 AI 消息', idxA>=0, 'idx='+idxA);
const box = await page.evaluate((i)=>{const r=document.querySelectorAll('.msg')[i].getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};},idxA);
await page.touchscreen.touchStart(box.x,box.y); await sleep(620);
await page.evaluate((i)=>{const el=document.querySelectorAll('.msg')[i];if(el)el.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));},idxA);
await sleep(400); await page.touchscreen.touchEnd(); await sleep(400);
const hasRw = await page.$$eval('.msg-menu [data-k="rewind"]', els=>els.length);
t('菜单里有「从这里重聊」', hasRw===1, '找到 '+hasRw+' 个');
const lastIdx = await page.evaluate(()=>[...document.querySelectorAll('.msg')].findIndex(el=>el.dataset.id==='rw-c'));
if (lastIdx>=0) {
  const b2 = await page.evaluate((i)=>{const r=document.querySelectorAll('.msg')[i].getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};},lastIdx);
  await page.touchscreen.touchStart(b2.x,b2.y); await sleep(620);
  await page.evaluate((i)=>{const el=document.querySelectorAll('.msg')[i];if(el)el.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));},lastIdx);
  await sleep(400); await page.touchscreen.touchEnd(); await sleep(400);
  t('最后一条 AI 消息没有「从这里重聊」（它该用重新生成）', (await page.$$eval('.msg-menu [data-k="rewind"]', els=>els.length))===0);
}

console.log('');
t('全程无 JS 错误', errs.length===0, errs.slice(0,3).join(' | '));
console.log('');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close(); server.close();
process.exit(fail>0?1:0);
