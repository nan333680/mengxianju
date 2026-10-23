
import puppeteer from 'puppeteer-core';
import { seedChar, seedChars, waitIdle , tap } from './e2e-helper.mjs';
import http from 'http';
import fs from 'fs';
import path from 'path';
// 工作目录自适应（原来写死 C:/A-DSH-Tool/ai-companion）
const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');

// [提速] 批量替换时统一用了 sleep(N) 写法，这里补上定义
const sleep = ms => new Promise(r => setTimeout(r, ms));


const WWW = `${R}/www`;
const OUT = `${R}/e2e`;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const API_KEY = process.env.DSH_API_KEY || 'sk-test';

const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.png':'image/png' };
const server = http.createServer((req,res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const f = path.join(WWW, p);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
  res.end(fs.readFileSync(f));
});
await new Promise(r => server.listen(0,'127.0.0.1',r));
const port = server.address().port;

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

let failMode = false;
let apiCallCount = 0;
await page.setRequestInterception(true);
page.on('request', req => {
  const u = req.url();
  if (u.includes('deepseek')) {
    // 必须先把 OPTIONS 预检放行并补上 CORS 头。
    // 否则被拦下来的是预检，浏览器直接报 "Failed to fetch"，
    // POST 根本不发 —— 拿到的错误信息也就不是我们模拟的那个了。
    if (req.method() === 'OPTIONS') {
      req.respond({ status: 204, headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': '*' } });
      return;
    }
    apiCallCount++;   // 只统计真正的 POST，预检不算一次调用
    if (failMode) {
      // 跨域响应必须带 Access-Control-Allow-Origin，否则浏览器不把响应交给 fetch，
      // 前端只能拿到 TypeError「Failed to fetch」，读不到我们模拟的错误消息。
      req.respond({ status: 500, contentType: 'application/json',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: { message: '模拟服务器错误(测试用)' } }) });
    } else {
      // ⚠️ v0.5.3.2：这里原来 req.continue() 真打 api.deepseek.com。
      //   key 是 sk-test，必然 401 —— 第 1 节「正常路径」其实一直靠错误气泡冒充回复，
      //   断言只检查"最后一条不短于 2 个字"（错误文案满足）就绿了。
      //   改成假造一条 SSE，这一节才真的在测正常链路，也不再依赖网络。
      const sse = 'data: ' + JSON.stringify({ choices: [{ delta: { content: '好的，我在。' } }] })
        + '\n\ndata: [DONE]\n\n';
      req.respond({ status: 200, contentType: 'text/event-stream',
        headers: { 'Access-Control-Allow-Origin': '*' }, body: sse });
    }
  } else req.continue();
});

const errs = [];
page.on('pageerror', e => errs.push(e.message));

let pass=0, fail=0;
const t=(n,ok,ex='')=>{ if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));} };

// 等生成结束。
// ⚠️ 不能写 "点完立刻查 #btn-stop 是否隐藏" —— 点击返回时按钮还没显示，
// 第一次轮询误判成"已结束"（实测 0.4s），后面读到空回复。
// waitIdle 会先等按钮出现，再等它消失。
const waitDone = async () => { await waitIdle(page); };

await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
await new Promise(r=>setTimeout(r,1600));
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil:'networkidle0' });
await sleep(400)   // [提速] 原 1800：探针实测 reload 后 app 就绪只要 ~1ms;
// 建一个带开场白的角色（原来靠环境里残留的角色）
await seedChar(page, '测试角色', { greeting: '（放下杯子）嗯，怎么了。' });
await page.reload({ waitUntil:'networkidle0' });
await sleep(400)   // [提速] 原 1800：探针实测 reload 后 app 就绪只要 ~1ms;
await page.evaluate(() => {
  const c = [...document.querySelectorAll('#char-list .char-card')]
    .find(x => x.textContent.includes('测试角色'));
  if (c) c.click();
});
await new Promise(r=>setTimeout(r,1500));
await tap(page, '#btn-settings');
await new Promise(r => setTimeout(r, 800));
// v1.15.2 起 ⚙ 拉开抽屉，设置页要从抽屉里的「全部设置」进
await page.evaluate(() => {
  const b = [...document.querySelectorAll('#drawer-menu [data-wb-drawer]')].find(x => x.dataset.wbDrawer === 'settings');
  if (b) b.click();
});
await new Promise(r=>setTimeout(r,500));
await page.$eval('#s-apikey',(el,k)=>{el.value=k;el.dispatchEvent(new Event('change',{bubbles:true}));},API_KEY);
await tap(page, '#btn-set-back');
await new Promise(r=>setTimeout(r,500));

console.log('=== 1. 回归：正常发送仍然工作 ===');
await tap(page, '#input');
await page.type('#input', '正常测试', { delay: 10 });
// ⚠️ 必须用 evaluate 点击，不能用 page.click()。
// page.click 走真实鼠标事件，要求元素在视口内且没被遮挡；
// 这个布局下点击会静默落空（不报错、不发消息），测试却以为发过了。
// 血泪第 9 条记的就是这个坑。实测：page.click → msg=1；evaluate 点击 → msg=3。
await page.evaluate(() => document.getElementById('btn-send').click());
await waitDone();
const normal = await page.$$eval('.msg .bub', els => els.map(e=>e.textContent.trim()));
t('正常路径仍能收到回复', normal.length >= 3 && normal[normal.length-1].length > 2, JSON.stringify(normal[normal.length-1]).slice(0,40));
t('正常路径没有错误气泡', (await page.$$('.err-bub')).length === 0);

console.log('');
console.log('=== 2. 模拟请求失败 ===');
failMode = true;
apiCallCount = 0;
await tap(page, '#input');
await page.type('#input', '这条应该失败', { delay: 10 });
// ⚠️ 必须用 evaluate 点击，不能用 page.click()。
// page.click 走真实鼠标事件，要求元素在视口内且没被遮挡；
// 这个布局下点击会静默落空（不报错、不发消息），测试却以为发过了。
// 血泪第 9 条记的就是这个坑。实测：page.click → msg=1；evaluate 点击 → msg=3。
await page.evaluate(() => document.getElementById('btn-send').click());
await waitDone();
await new Promise(r=>setTimeout(r,800));

const errBub = await page.$$('.msg.ai .bub.err-bub');
t('气泡没有凭空消失', errBub.length === 1, '错误气泡数=' + errBub.length);
t('自动重试确实发了两次', apiCallCount >= 2, 'API 调用次数=' + apiCallCount);

const errTxt = await page.$eval('.err-bub', el => el.textContent);
console.log('  气泡内容: ' + errTxt.replace(/\s+/g,' ').slice(0, 120));
// v0.5.3.2：错误卡改成「一句话原因 + 步骤」，不再有「没发出去」这句
t('显示了失败提示', errTxt.includes('服务商那边繁忙或出错'), errTxt.slice(0, 40));
t('显示了具体原因', /模拟服务器错误|500|API 错误/.test(errTxt), errTxt.slice(0,80));
t('有重试按钮', (await page.$$('.retry-btn')).length === 1);
await page.screenshot({ path: OUT + '/50-失败留痕.png' });

console.log('');
console.log('=== 3. 修好后点重试 ===');
failMode = false;
await tap(page, '.retry-btn');
await waitDone();
await new Promise(r=>setTimeout(r,900));
const after = await page.$$eval('.msg .bub', els => els.map(e=>e.textContent.trim()));
console.log('  消息总数: ' + after.length + '  最后一条: ' + JSON.stringify(after[after.length-1]).slice(0,50));
t('重试后收到正常回复', after[after.length-1].length > 2 && !after[after.length-1].includes('没发出去'));
t('错误气泡已消失', (await page.$$('.err-bub')).length === 0);
// ⚠️ 断言收窄（v1.21.30）：原来用 includes 匹配【全部气泡】，
// 而兜底文案会把用户的话原样引进去（'（听他说完「这条应该失败」…）'）——
// 于是兜底句被误判成"重复的用户消息"。改成只数【用户气泡】。
const userBubs = await page.$$eval('.msg.me .bub', els => els.map(e => e.textContent.trim()));
t('没有重复堆积用户消息', userBubs.filter(x => x.includes('这条应该失败')).length <= 1, JSON.stringify(userBubs.map(x=>x.slice(0,20))));
await page.screenshot({ path: OUT + '/51-重试成功.png' });

t('无 JS 错误', errs.length === 0, errs.slice(0,2).join(' | '));

console.log('');
console.log('========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close();
server.close();
process.exit(fail>0?1:0);
