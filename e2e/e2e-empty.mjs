// 没有角色时，哪些事不该能做（v1.21.60）
//
// 起因：v1.21.59 改成"全新安装进来是空的、不自动建角色"，
// 但有几处入口是按"一定有当前角色"写的。审计出来的四处：
//   send()              能带着 charId=null 发出去 → 回复落库成孤儿消息
//   openClockEditor()   能开弹窗改时间，保存被 saveClock 挡掉 → 白改
//   renderClock()       会把上一个角色残留的 clockState 显示在空聊天页
//   openSceneEditor()   能开空弹窗
import puppeteer from 'puppeteer-core';
import http from 'http'; import fs from 'fs'; import path from 'path';
import { pinLang } from './e2e-helper.mjs';
const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');
const WWW=`${R}/www`;
const CHROME='C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png'};
const server=http.createServer((req,res)=>{let p=decodeURIComponent(req.url.split('?')[0]);if(p==='/')p='/index.html';const f=path.join(WWW,p);if(!fs.existsSync(f)){res.writeHead(404);res.end('404');return;}res.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream'});res.end(fs.readFileSync(f));});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const port=server.address().port;
const browser=await puppeteer.launch({executablePath:CHROME,headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
const page=await browser.newPage();
// ⚠️ CI 的 runner 是 en-US，而界面语言默认「跟随系统」。钉成中文，否则英文界面下
//    断言中文文案的地方都会红（界面翻译补完之后尤其明显，v0.4.2）。
//    用 defineProperty 而不是改库：不用等 reload、也不动 DOM，跟断言不抢。
//    configurable: true 是为了能和预检工具自己的伪装共存。
await page.evaluateOnNewDocument(() => {
  Object.defineProperty(navigator, 'language', { get: () => 'zh-CN', configurable: true });
  Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh'], configurable: true });
});


await page.setViewport({width:393,height:851,deviceScaleFactor:2,isMobile:true,hasTouch:true});
const errs=[]; page.on('pageerror',e=>errs.push(e.message));
let apiCalls = 0;
page.on('request', r => { const u = r.url(); if (u.includes('api.deepseek.com') || u.includes('/chat/completions')) apiCalls++; });
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let pass=0,fail=0;
const t=(n,ok,ex='')=>{if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));}};
const toastText = () => page.$eval('#toast', el => el.classList.contains('hidden') ? '' : el.textContent.trim()).catch(() => '');
const dbCount = (st) => page.evaluate(s => new Promise(res => {
  const o = indexedDB.open('ai-companion');
  o.onsuccess = () => { const db = o.result; const q = db.transaction(s).objectStore(s).count(); q.onsuccess = () => { const n = q.result; db.close(); res(n); }; };
}), st);

// 原来这里是 waitUntil:'networkidle0' + 40 秒超时。CI 上偶发
// 「Navigation timeout of 40000 ms exceeded」（这一套前面的 menu 就已经跑了 36 秒，
// 那台 runner 本来就慢），而 networkidle0 还要额外等 500ms 静默。
// 改成 domcontentloaded + 显式等 app 渲染完空态：判据是 #messages 里有子节点，
// 这和「页面真的起来了」是同义词，且不受网络空闲计时的影响。
const URL='http://127.0.0.1:'+port+'/';
const waitApp = () => page.waitForFunction(() => document.querySelectorAll('#messages *').length > 0, { timeout: 90000 }).catch(() => {});
await page.goto(URL,{waitUntil:'domcontentloaded',timeout:90000});
await waitApp();
await sleep(1200);
await page.evaluate(()=>indexedDB.deleteDatabase('ai-companion'));
await page.reload({waitUntil:'domcontentloaded',timeout:90000}); await waitApp(); await sleep(900);
// ⚠️ CI 的 runner 是 en-US，语言默认「跟随系统」→ 空态引导那类文案断言会读成英文。
//    必须在【App 建好库之后】钉（也就是上面这次 reload 之后），钉完再 reload 一次让语言生效。
await pinLang(page, 'zh');
await page.reload({waitUntil:'domcontentloaded',timeout:90000}); await waitApp(); await sleep(900);

console.log('=== 前置：一个角色都没有 ===');
t('角色数 0', (await dbCount('characters')) === 0);
t('聊天页显示空态引导', (await page.$eval('#messages', el => el.textContent)).includes('还没有角色'));
const clockTxt = await page.$eval('#chat-clock', el => el.textContent.trim());
t('★ 时间条是空的（不残留别人的时间）', clockTxt === '', JSON.stringify(clockTxt));

console.log('');
console.log('=== ① 没有角色时发消息 ===');
await page.evaluate(() => { const i = document.getElementById('input'); i.value = '你好'; });
await page.evaluate(() => document.getElementById('btn-send').click());
await sleep(1200);
console.log('   提示: ' + JSON.stringify(await toastText()));
t('给了「还没有角色」的提示', /还没有角色/.test(await toastText()), await toastText());
t('★ 一条消息都没落库', (await dbCount('messages')) === 0);
t('★ 一个网络请求都没发出去', apiCalls === 0, 'apiCalls=' + apiCalls);

console.log('');
console.log('=== ② 没有角色时点时间条 ===');
const before = await dbCount('kv');
await page.evaluate(() => document.getElementById('chat-clock').click());
await sleep(600);
t('时间弹窗没有打开', await page.$eval('#clock-modal', el => el.classList.contains('hidden')));
t('提示了还没角色', /还没有角色/.test(await toastText()), await toastText());
t('没往库里写东西', (await dbCount('kv')) === before);

console.log('');
console.log('=== ③ 没有角色时点场景条 ===');
await page.evaluate(() => document.getElementById('chat-scene').click());
await sleep(600);
t('场景弹窗没有打开', await page.$eval('#scene-modal', el => el.classList.contains('hidden')).catch(() => true));
t('提示了还没角色', /还没有角色/.test(await toastText()), await toastText());

console.log('');
console.log('=== ④ 建一个角色之后，这些入口要恢复 ===');
await page.evaluate(() => document.getElementById('btn-chars').click()); await sleep(500);
// 一个角色都没有时，列表是空的 —— 要走「＋ 创建新角色」那条路
await page.evaluate(() => { const b = document.getElementById('btn-new-char2'); if (b) b.click(); });
await sleep(600);
t('进到了模板选择页', await page.$eval('#view-preset', el => el.classList.contains('active')));
await page.evaluate(() => { const c = document.querySelector('#preset-list .char-card'); if (c) c.click(); });
await sleep(600);
const inEdit = await page.$eval('#view-edit', el => el.classList.contains('active'));
t('★ 能进角色编辑页（建角色这条路是通的）', inEdit);
await page.evaluate(() => { const i = document.getElementById('e-name'); i.value = '空态测试'; });
await page.evaluate(() => document.getElementById('btn-edit-save').click());
await sleep(1200);
t('建好之后有 1 个角色', (await dbCount('characters')) === 1, String(await dbCount('characters')));
await page.evaluate(() => document.getElementById('chat-clock').click());
await sleep(600);
// ⚠️ 不能断言"弹窗一定打开"：全新安装 clockMode 默认是 true（跟现实走），
// 那种情况下时间条本来就只该提示一句「跟随手机时间」。要验的是【不再被空角色守卫拦住】。
const opened = !(await page.$eval('#clock-modal', el => el.classList.contains('hidden')));
const tip2 = await toastText();
t('★ 时间条有反应了（开弹窗 或 提示跟随手机时间）',
  opened || /跟随手机时间/.test(tip2), 'opened=' + opened + ' tip=' + tip2);
await page.evaluate(() => document.getElementById('clock-cancel').click());
await sleep(300);

console.log('');
t('全程无 JS 错误', errs.length===0, errs.slice(0,3).join(' | '));
console.log('');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close(); server.close();
process.exit(fail>0?1:0);
