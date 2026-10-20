import puppeteer from 'puppeteer-core';
import { seedChar } from './e2e-helper.mjs';
import http from 'http'; import fs from 'fs'; import path from 'path';
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

await page.goto('http://127.0.0.1:'+port+'/',{waitUntil:'networkidle0',timeout:40000});
await sleep(1500);
await page.evaluate(()=>indexedDB.deleteDatabase('ai-companion'));
await page.reload({waitUntil:'networkidle0'}); await sleep(400)   // [提速] 原 1800：探针实测 reload 后 app 就绪只要 ~1ms;
// v1.21.59：全新安装不再自动建角色（产品改空），测试自己塞一个
await seedChar(page, '测试角色', { greeting: '' });   // 空开场白：不额外多出一条消息
await page.reload({waitUntil:'networkidle0'}); await sleep(500);

// —— v1.20.21：新装默认「时间跟现实走」。这些套件依赖【手动时间】，
//    所以开局先关掉现实模式，否则剧情时间会被手机时钟顶成第 1 天。
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
await openSettings(page, sleep);
await page.$eval('#s-apikey',(el,k)=>{el.value=k;el.dispatchEvent(new Event('change',{bubbles:true}));},KEY);
await sleep(300);

console.log('=== 1. 记忆节奏参数在设置页（全局统一）===');
await openSettings(page, sleep);
t('设置页有「记忆节奏」折叠头', !!(await page.$('#mem-set-fold')));
await page.evaluate(()=>document.getElementById('mem-set-fold').click());
await sleep(700);
t('设置页有「总结间隔」', !!(await page.$('#s-mem-sum')));
t('设置页已经没有「查重间隔」这个死旋钮', !(await page.$('#s-mem-dedupe')));
t('设置页有「条数上限」', !!(await page.$('#s-mem-limit')));
await page.click('#btn-set-back'); await sleep(400);
  // v1.15.2 起栈多了 drawer 一层，退到设置页的上一层是抽屉，还要再关一次
  await page.evaluate(() => { const b = document.getElementById('btn-drawer-close'); if (b && document.querySelector('#view-drawer.active')) b.click(); });
  await sleep(500);
await page.click('#btn-chars'); await sleep(500);
await page.evaluate(()=>document.querySelectorAll('#char-list .char-card button[data-edit]')[0].click());
await sleep(800);
t('角色页已经不放这三个节奏参数了', !(await page.$('#e-mem-sum')) && !(await page.$('#e-mem-dedupe')) && !(await page.$('#e-mem-limit')));
t('角色页有「她记住的事」入口', !!(await page.$('#e-mem-fold')));
await page.click('#btn-edit-back'); await sleep(500);
await openSettings(page, sleep);
await page.evaluate(()=>document.getElementById('mem-set-fold').click());
await sleep(600);
const defs = await page.evaluate(()=>({a:document.querySelector('#s-mem-sum').value,c:document.querySelector('#s-mem-limit').value}));
console.log('   默认值: 总结=' + defs.a + ' 上限=' + defs.c);
await page.evaluate(()=>{const i=document.querySelector('#s-mem-limit');i.value='6';i.dispatchEvent(new Event('change',{bubbles:true}));});
await sleep(600);
const saved = await page.evaluate(async()=>{const o=indexedDB.open('ai-companion');const db=await new Promise(r=>{o.onsuccess=()=>r(o.result);});const kv=await new Promise(r=>{const q=db.transaction('kv').objectStore('kv').get('settings');q.onsuccess=()=>r(q.result);});db.close();return kv.v.memLimit;});
t('改完存进全局设置（上限 6）', saved===6, String(saved));

console.log('');
console.log('=== 2. 时效清理（纯代码，不花 token）===');
// 开长期记忆 + 把剧情时间定到第 5 天
await page.evaluate(async()=>{
  const o=indexedDB.open('ai-companion');
  const db=await new Promise(r=>{o.onsuccess=()=>r(o.result);});
  const cs=await new Promise(r=>{const q=db.transaction('characters').objectStore('characters').getAll();q.onsuccess=()=>r(q.result);});
  const cid=cs[0].id;
  const tx=db.transaction('characters','readwrite');
  tx.objectStore('characters').put({...cs[0],longMemory:true});
  await new Promise(r=>{tx.oncomplete=r;});
  const t2=db.transaction('kv','readwrite');
  t2.objectStore('kv').put({k:'clock:'+cid, v:{day:5,phase:'morning',season:'autumn',weather:'clear',locked:true}});
  const t3=db.transaction('memories','readwrite');
  const st=t3.objectStore('memories');
  st.put({id:'m-fact',charId:cid,text:'你喜欢坐在窗边发呆',kind:'fact',untilDay:null,ts:Date.now()});
  st.put({id:'m-expired',charId:cid,text:'你中秋有三天假',kind:'event',untilDay:3,ts:Date.now()});
  st.put({id:'m-alive',charId:cid,text:'你下周末要来白玉楼',kind:'event',untilDay:10,ts:Date.now()});
  await new Promise(r=>{t2.oncomplete=r;});
  await new Promise(r=>{t3.oncomplete=r;});
  db.close();
});
await page.reload({waitUntil:'networkidle0'}); await sleep(400)   // [提速] 原 1800：探针实测 reload 后 app 就绪只要 ~1ms;
const before = await page.evaluate(async()=>{const o=indexedDB.open('ai-companion');const db=await new Promise(r=>{o.onsuccess=()=>r(o.result);});const n=await new Promise(r=>{const q=db.transaction('memories').objectStore('memories').count();q.onsuccess=()=>r(q.result);});db.close();return n;});
t('清理前有 3 条记忆', before===3, String(before));
// ⚠️ 这一节要的是【纯代码的时效清理】，不能让真模型参与（v0.5.1.5）。
// 带真 key 跑回归时，这一轮会真调模型 → 总结/整理顺手写进新记忆 →
// 种子那三条被换成新 id、status 重置成 active，然后整套报假红。
// 这里把 /chat/completions 拦成一句普通回复（不带记忆 JSON），模型不参与，记忆链路不受干扰。
await page.setRequestInterception(true);
page.on('request', (req) => {
  if (!req.url().includes('/chat/completions')) { try { req.continue(); } catch {} return; }
  if (req.method() === 'OPTIONS') {
    return req.respond({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': '*' } }).catch(() => {});
  }
  return req.respond({ status: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'text/event-stream' },
    body: 'data: {"choices":[{"delta":{"content":"在"}}]}\n\ndata: [DONE]\n\n' }).catch(() => {});
});
// 发一条消息触发 prune
await page.click('#input');
await page.type('#input','在吗',{delay:4});
await page.click('#btn-send');
for(let i=0;i<60;i++){await sleep(500);const b=await page.$eval('#btn-stop',el=>!el.classList.contains('hidden')).catch(()=>false);if(!b)break;}
await sleep(1500);
const after = await page.evaluate(async()=>{const o=indexedDB.open('ai-companion');const db=await new Promise(r=>{o.onsuccess=()=>r(o.result);});const all=await new Promise(r=>{const q=db.transaction('memories').objectStore('memories').getAll();q.onsuccess=()=>r(q.result);});db.close();return all.map(m=>({id:m.id,kind:m.kind,untilDay:m.untilDay,status:m.status||'active'}));});
console.log('   清理后剩: ' + JSON.stringify(after));
// ⚠️ 断言不能按 id 找（v0.5.1.5）：带真 key 跑回归时这一轮会真调模型，
//    记忆自动整理有可能把种子那条换 id 重写（日志里就是三个陌生 id 而语义还在）。
//    按【语义】找：kind + untilDay，这两样整理不会动。
const pick = (f) => after.find(f) || {};
const exp = pick(m => m.kind === 'event' && m.untilDay === 3);
const alive = pick(m => m.kind === 'event' && m.untilDay === 10);
const fact = pick(m => m.kind === 'fact' && !m.untilDay);
t('过期的 event 被停用（标成 expired）', exp.status === 'expired', JSON.stringify(exp));
t('没过期的 event 仍然是 active', alive.status === 'active', JSON.stringify(alive));
t('永久事实仍然是 active', fact.status === 'active', JSON.stringify(fact));

console.log('');
console.log('=== 3. 记忆页标签 ===');
await openSettings(page, sleep);
await page.click('#mem-fold'); await sleep(700);   // 原地展开，不跳页
t('展开后仍停在设置页', await page.$eval('#view-settings', el => el.classList.contains('active')));
t('折叠头显示了条数', /\d+ 条|还没有/.test(await page.$eval('#mem-count', el => el.textContent)), await page.$eval('#mem-count', el => el.textContent));
// 记忆现在按人物分组，标签在每个人的卡片里 —— 先把各组展开再收标签
await page.evaluate(() => {
  document.querySelectorAll('.mem-group:not(.open) [data-head]').forEach(h => h.click());
});
await sleep(700);
const tags = await page.$$eval('.mem-group .mem-tag', els=>els.map(e=>e.textContent.trim()));
console.log('   标签: ' + JSON.stringify(tags));
t('记忆条目带类型标签', tags.length>=2, JSON.stringify(tags));
t('事件型显示到期日', tags.some(x=>x.includes('天')), JSON.stringify(tags));

console.log('');
t('全程无 JS 错误', errs.length===0, errs.slice(0,2).join(' | '));
console.log('');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close(); server.close();
process.exit(fail>0?1:0);
