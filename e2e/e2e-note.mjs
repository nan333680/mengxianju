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
await openSettings(page, sleep);
await page.$eval('#s-apikey',(el,k)=>{el.value=k;el.dispatchEvent(new Event('change',{bubbles:true}));},KEY);
await page.click('#btn-set-back'); await sleep(500);
  // v1.15.2 起栈多了 drawer 一层，退到设置页的上一层是抽屉，还要再关一次
  await page.evaluate(() => { const b = document.getElementById('btn-drawer-close'); if (b && document.querySelector('#view-drawer.active')) b.click(); });
  await sleep(500);

// 塞一条「带图 + 带说明」的消息
const b64 = fs.readFileSync(R + '/tmp/meme1.png').toString('base64');
const url = 'data:image/png;base64,' + b64;
await page.evaluate(async ({u}) => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const cs = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').getAll(); q.onsuccess = () => r(q.result); });
  const tx = db.transaction('messages','readwrite');
  tx.objectStore('messages').put({ id:'note-1', charId: cs[0].id, role:'user', content:'你看', images:[u], imageNotes:['这是表情包，不是真猫'], ts: Date.now()-5000 });
  await new Promise(r => { tx.oncomplete = r; }); db.close();
}, {u:url});
await page.reload({waitUntil:'networkidle0'}); await sleep(400)   // [提速] 原 1800：探针实测 reload 后 app 就绪只要 ~1ms;

console.log('=== 1. 界面把说明显示出来了 ===');
const shown = await page.$$eval('.msg .pic-note', els=>els.map(e=>e.textContent.trim()));
console.log('   气泡上的说明: ' + JSON.stringify(shown));
t('气泡里显示了「说明：…」', shown.length===1 && shown[0].includes('表情包'), JSON.stringify(shown));

console.log('');
console.log('=== 2. 说明有没有真发进请求 ===');
let captured=null;
await page.setRequestInterception(true);
page.on('request',(req)=>{ if(req.url().includes('/chat/completions')){try{captured=req.postData();}catch{}} req.continue(); });
await page.click('#input');
await page.type('#input','再发一句',{delay:4});
await page.click('#btn-send');
for(let i=0;i<60&&!captured;i++) await sleep(500);
await sleep(400);
if (captured) {
  const j = JSON.parse(captured);
  const withImg = j.messages.find(m => Array.isArray(m.content) && m.content.some(p=>p.type==='image_url'));
  if (withImg) {
    console.log('   带图消息的 parts: ' + JSON.stringify(withImg.content.map(p => p.type === 'text' ? ('text:' + p.text.slice(0,40)) : 'image_url')));
    const notePart = withImg.content.find(p => p.type==='text' && p.text.includes('图的说明'));
    t('说明作为独立条目发出去了', !!notePart, notePart ? notePart.text : '没找到');
    t('说明内容正确', !!notePart && notePart.text.includes('这是表情包，不是真猫'), notePart ? notePart.text : '');
    const iImg = withImg.content.findIndex(p=>p.type==='image_url');
    const iNote = withImg.content.findIndex(p=>p.type==='text' && p.text.includes('图的说明'));
    t('说明排在它那张图前面（贴在一起）', iNote >= 0 && iNote < iImg, 'note='+iNote+' img='+iImg);
    t('说明带方括号（不走人设里的动作括号）', !!notePart && notePart.text.startsWith('［'), notePart ? notePart.text.slice(0,6) : '');
  }
}
for(let i=0;i<90;i++){await sleep(500);const b=await page.$eval('#btn-stop',el=>!el.classList.contains('hidden')).catch(()=>false);if(!b)break;}

console.log('');
console.log('=== 3. 编辑重发时说明会恢复 ===');
// 长按要靠屏幕坐标，而消息在图片加载/流式回复时会移位——量到的点和真正压下去的点可能不是同一条。
// 所以整段重试最多 3 次，每次都重新量一次坐标，并校验「确实编辑到了那条带图消息」。
let idx = -1;
for (let attempt = 0; attempt < 3; attempt++) {
  await page.reload({waitUntil:'networkidle0'}); await sleep(400)   // [提速] 原 1800：探针实测 reload 后 app 就绪只要 ~1ms;
  idx = await page.evaluate(()=>[...document.querySelectorAll('.msg')].findIndex(el=>el.dataset.id==='note-1'));
  if (attempt === 0) t('找到那条带图消息', idx>=0, 'idx='+idx);
  if (idx < 0) break;
  await page.evaluate((i)=>{const el=document.querySelectorAll('.msg')[i];if(el)el.scrollIntoView({block:'center'});},idx);
  await sleep(300);
  const box = await page.evaluate((i)=>{const r=document.querySelectorAll('.msg')[i].getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};},idx);
  await page.touchscreen.touchStart(box.x,box.y); await sleep(650);
  await page.evaluate((i)=>{const el=document.querySelectorAll('.msg')[i];if(el)el.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));},idx);
  await sleep(400); await page.touchscreen.touchEnd(); await sleep(400);
  // 菜单是异步建的，等它真的出现再点
  for(let i=0;i<20;i++){ if(await page.$('.msg-menu [data-k="edit"]')) break; await sleep(200); }
  await page.click('.msg-menu [data-k="edit"]');
  for(let i=0;i<25;i++){
    const ok = await page.evaluate(()=>!document.getElementById('attach-preview').classList.contains('hidden')).catch(()=>false);
    if(ok) break;
    await sleep(200);
  }
  await sleep(300);
  const check = await page.evaluate(()=>({ pics: document.querySelectorAll('#attach-preview .pic').length, val: document.getElementById('input').value }));
  if (check.pics === 1 && check.val === '你看') break;
  console.log('   （第 ' + (attempt+1) + ' 次长按没打中那条消息，重试）');
}
// 诊断：如果编辑被确认框拦下，预览区当然还是空的
const diag = await page.evaluate(()=>{
  const m = document.getElementById('modal');
  return {
    modalShown: m ? !m.classList.contains('hidden') : null,
    modalText: m ? (m.textContent||'').replace(/\s+/g,' ').slice(0,120) : '',
    msgCount: document.querySelectorAll('.msg').length,
    inputVal: (document.getElementById('input')||{}).value,
  };
});
console.log('   诊断: ' + JSON.stringify(diag));
const preview = await page.evaluate(() => {
  const box = document.getElementById('attach-preview');
  const notes = [...box.querySelectorAll('.note')].map(i => i.value);
  const pics = box.querySelectorAll('.pic').length;
  return { pics, notes, hidden: box.classList.contains('hidden') };
});
console.log('   预览区: ' + JSON.stringify(preview));
t('图回到了附件区', preview.pics === 1, JSON.stringify(preview));
t('图的说明也一起恢复了', preview.notes[0] === '这是表情包，不是真猫', JSON.stringify(preview.notes));
const inpVal = await page.$eval('#input', el => el.value);
t('文字也回填了（你看）', inpVal === '你看', inpVal);

console.log('');
t('全程无 JS 错误', errs.length===0, errs.slice(0,3).join(' | '));
console.log('');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close(); server.close();
process.exit(fail>0?1:0);
