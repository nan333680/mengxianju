import puppeteer from 'puppeteer-core';
import { seedChar, seedChars, pickImportMode } from './e2e-helper.mjs';
import http from 'http'; import fs from 'fs'; import path from 'path';
// 工作目录自适应（原来写死 C:/A-DSH-Tool/ai-companion）
const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');
const WWW=`${R}/www`;
const CHROME='C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const FILE=`${R}\\_fixtures\\backup-roles.json`;
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'};
const server=http.createServer((req,res)=>{let p=decodeURIComponent(req.url.split('?')[0]);if(p==='/')p='/index.html';const f=path.join(WWW,p);if(!fs.existsSync(f)){res.writeHead(404);res.end('404');return;}res.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream'});res.end(fs.readFileSync(f));});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const port=server.address().port;
const browser=await puppeteer.launch({executablePath:CHROME,headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
const page=await browser.newPage();
await page.setViewport({width:393,height:851,deviceScaleFactor:2,isMobile:true,hasTouch:true});
const errs=[]; page.on('pageerror',e=>errs.push(e.message));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

// ⚠️ 这份 fixture 是完整备份格式的角色卡导出，里面的角色名、人设、开场白都属于私人内容。
// 所以【代码里一个都不写死】：名字和参数全部从文件读出来，仓库里只留「怎么读」这套逻辑 ——
// 换任何一份 fixture 都能照跑。（这也是当初把文件名改成 backup-roles.json 的原因。）
const FIX = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const FIXC = (FIX.characters || []).filter(c => c && c.name);
const N0 = FIXC[0] ? FIXC[0].name : '';
const N1 = FIXC[1] ? FIXC[1].name : '';
const T0 = FIXC[0] ? FIXC[0].temperature : null;
const T1 = FIXC[1] ? FIXC[1].temperature : null;

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

console.log('=== 导入前 ===');
const before = await page.evaluate(async()=>{const o=indexedDB.open('ai-companion');const db=await new Promise(r=>{o.onsuccess=()=>r(o.result);});const cs=await new Promise(r=>{const q=db.transaction('characters').objectStore('characters').getAll();q.onsuccess=()=>r(q.result);});db.close();return cs.map(c=>c.name);});
console.log('   现有角色: ' + JSON.stringify(before));

await openSettings(page, sleep);
const input = await page.$('#file-import');
await input.uploadFile(FILE);
// v1.19.11：上传后会弹「选导入模式」。不点它导入不执行 —— 老写法直接 sleep 会全挂。
// 这份 fixture 是纯角色文件（无 messages/memories）→ 选「仅角色」。
const picked = await pickImportMode(page, 'chars', sleep);
console.log('   模式弹窗: ' + (picked ? '已选「仅角色」' : '没出现'));
await sleep(2500);

const after = await page.evaluate(async()=>{const o=indexedDB.open('ai-companion');const db=await new Promise(r=>{o.onsuccess=()=>r(o.result);});const cs=await new Promise(r=>{const q=db.transaction('characters').objectStore('characters').getAll();q.onsuccess=()=>r(q.result);});db.close();return cs;});
console.log('   导入后: ' + JSON.stringify(after.map(c=>c.name)));
t('两张卡都进去了', after.length === before.length + FIXC.length, before.length + ' -> ' + after.length);
const fan = after.find(c=>c.name===N0);
const fj  = after.find(c=>c.name===N1);
t('找到第一张卡', !!fan, N0 ? '（名字长度 ' + N0.length + '）' : 'fixture 里没有角色');
t('找到第二张卡', !!fj, N1 ? '（名字长度 ' + N1.length + '）' : '');
t('第一张卡的人设没被截断（4000+字）', fan && fan.persona.length > 4000, fan ? fan.persona.length+'字' : '');
t('第二张卡的人设没被截断（4000+字）', fj && fj.persona.length > 4000, fj ? fj.persona.length+'字' : '');
t('第一张卡开场白在', fan && fan.greeting.length > 50, fan ? fan.greeting.length+'字' : '');
t('第二张卡开场白在', fj && fj.greeting.length > 50, fj ? fj.greeting.length+'字' : '');
// v0.4.2.2 审计 F3：kaomojiStyle 这个字段整个删了（四档旋钮改了看不出区别），
// 角色卡导入不再保留它，所以断言里也不再比它 —— 其余参数照旧比对。
// 温度也按 fixture 里写的比 —— 写死数字等于把这份卡的参数抄进仓库，换卡就失效。
t('第一张卡参数对（温度同卡 / 分段开）', fan && fan.temperature===T0 && fan.splitMessages===true, fan?JSON.stringify({t:fan.temperature,sp:fan.splitMessages}):'');
t('第二张卡参数对（温度同卡）', fj && fj.temperature===T1, fj?JSON.stringify({t:fj.temperature}):'');
t('两人长期记忆都开着', fan && fan.longMemory===true && fj && fj.longMemory===true);
t('presetKey 是 blank（不进模板）', fan && fan.presetKey==='blank' && fj && fj.presetKey==='blank');

console.log('');
console.log('=== 能不能真的选中她们聊天 ===');
await page.click('#btn-set-back'); await sleep(400);
  // v1.15.2 起栈多了 drawer 一层，退到设置页的上一层是抽屉，还要再关一次
  await page.evaluate(() => { const b = document.getElementById('btn-drawer-close'); if (b && document.querySelector('#view-drawer.active')) b.click(); });
  await sleep(500);
await page.click('#btn-chars'); await sleep(600);
const names = await page.$$eval('#char-list .char-card .info b', els=>els.map(e=>e.textContent.trim()));
console.log('   角色列表: ' + JSON.stringify(names));
t('列表里有第一张卡', names.includes(N0), names.length + ' 个');
t('列表里有第二张卡', names.includes(N1));
// 点第一张卡
const idx = names.indexOf(N0);
await page.evaluate((i)=>{document.querySelectorAll('#char-list .char-card')[i].click();}, idx);
await sleep(900);
const cur = await page.$eval('#chat-name', el=>el.textContent.trim());
t('选中后顶栏显示第一张卡', cur===N0, cur);
const msgs = await page.$$eval('.msg .bub', els=>els.map(e=>e.textContent.trim()));
// 不再断言开场白里具体那句话（那是卡作者的台词），只要求它真的被写进了聊天。
t('开场白自动出现了', msgs.length>0 && msgs[0].length>20, msgs.length ? msgs[0].length+'字' : '没有消息');

console.log('');
console.log('=== 模板列表不该多出她们 ===');
await page.click('#btn-chars'); await sleep(500);
await page.click('#btn-new-char'); await sleep(700);
const presets = await page.$$eval('#preset-list .char-card .info b', els=>els.map(e=>e.textContent.trim()));
console.log('   模板列表: ' + JSON.stringify(presets));
t('模板里没有第一张卡', !presets.includes(N0), presets.length + ' 个模板');
t('模板里没有第二张卡', !presets.includes(N1));

console.log('');
t('全程无 JS 错误', errs.length===0, errs.slice(0,3).join(' | '));
console.log('');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close(); server.close();
process.exit(fail>0?1:0);
