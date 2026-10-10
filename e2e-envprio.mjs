import puppeteer from 'puppeteer-core';
import http from 'http'; import fs from 'fs'; import path from 'path';
// 工作目录自适应（原来写死 C:/A-DSH-Tool/ai-companion）
const R = path.resolve(import.meta.dirname).split(path.sep).join('/');
const WWW = `${R}/www`;
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
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = []; page.on('pageerror', e => errs.push(e.message));
page.on('dialog', async d => { await d.accept(); });
const sleep = ms => new Promise(r=>setTimeout(r,ms));
let pass=0, fail=0;
const t=(n,ok,ex='')=>{ if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));} };

let sysAll = '';
await page.setRequestInterception(true);
page.on('request', req => {
  const u = req.url();
  if (u.includes('deepseek') || u.includes('/chat/completions')) {
    if (req.method()==='OPTIONS') { req.respond({status:204,headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'*'}}); return; }
    const b = JSON.parse(req.postData()||'{}');
    sysAll = (b.messages||[]).filter(m=>m.role==='system').map(m=>m.content||'').join('\n---\n');
    if (b.stream) {
      const pl='data: '+JSON.stringify({choices:[{delta:{content:'好。'}}]})+String.fromCharCode(10,10)+'data: [DONE]'+String.fromCharCode(10,10);
      req.respond({status:200,headers:{'Access-Control-Allow-Origin':'*'},contentType:'text/event-stream',body:pl}); return;
    }
    req.respond({status:200,headers:{'Access-Control-Allow-Origin':'*'},contentType:'application/json',body:JSON.stringify({choices:[{message:{content:'[]'}}]})}); return;
  }
  req.continue();
});

await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
await sleep(1400);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil:'networkidle0' }); await sleep(700);

// 造：住所设定 + 一个专写"他的房子"的世界书组
await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => o.onsuccess = () => r(o.result));
  const put = (s, r2) => new Promise(r => { const tx = db.transaction(s,'readwrite'); tx.objectStore(s).put(r2); tx.oncomplete = r; });
  const cid = 'c-env';
  await put('characters', { id:cid, name:'环境测试', avatar:null, greeting:'（她在）', persona:'你是一个测试角色。',
    createdAt:Date.now(), longMemory:false, verbosity:'medium', descLevel:'mid', splitMessages:false });
  await put('kv', { k:'settings', v:{ apiKey:'sk-x', model:'deepseek-flash', myEnv:'他住在一栋两层的独栋小楼里，楼下是客厅和厨房。',
    worldbookOn:true, memLimit:20, contextRounds:20 } });
  // 世界书：单独角色，词条专写"他的房子"
  await put('wbSolo', { id:'s-env', charId:cid, entries:[
    { id:'e1', title:'他的房子', keys:['房子','家','住处','房间'], on:true,
      content:'他住的地方其实是一间老式公寓，只有一间半，窗户朝北。' } ] });
  db.close();
});
await page.reload({ waitUntil:'networkidle0' }); await sleep(1200);
await page.evaluate(() => { const c=[...document.querySelectorAll('#char-list .char-card')].find(x=>x.textContent.includes('环境测试')); if(c)c.click(); });
await sleep(900);

// 发一条会命中"房子"的消息
await page.evaluate(() => { const i=document.getElementById('input'); i.value='你家房子什么样的'; i.dispatchEvent(new Event('input',{bubbles:true})); });
await page.evaluate(() => document.getElementById('btn-send').click());
for (let i=0;i<25;i++){ await sleep(400); const b=await page.$eval('#btn-stop',e=>!e.classList.contains('hidden')).catch(()=>false); if(!b) break; }
await sleep(600);

console.log('=== 真实提示词里两段都在，且仲裁语已注入 ===');
console.log('  含住所设定: ' + sysAll.includes('独栋小楼'));
console.log('  含世界书条目: ' + sysAll.includes('老式公寓'));
console.log('  含仲裁语: ' + sysAll.includes('以世界书那条为准'));
t('住所设定注入', sysAll.includes('独栋小楼'));
t('世界书条目注入（关键词命中）', sysAll.includes('老式公寓'));
t('仲裁语已写入', sysAll.includes('以世界书那条为准'));
t('仲裁语点明"世界书优先"', sysAll.includes('那条是他为这个地方单独写的'));
t('旧的硬措辞保留（领域声明还在）', sysAll.includes('写到他家、房间、窗外、周边环境时以此为准'));

console.log('');
console.log('=== 位置关系 ===');
const iEnv = sysAll.indexOf('# 他住的地方');
const iWb  = sysAll.indexOf('# 相关设定');
console.log('  住所段下标=' + iEnv + '  世界书段下标=' + iWb);
t('两段都在', iEnv >= 0 && iWb >= 0);

console.log('');
console.log('  JS 错误: ' + (errs.length ? JSON.stringify(errs.slice(0,3)) : '无'));
t('无 JS 错误', errs.length === 0, errs.join(' | '));

console.log('');
console.log('========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
