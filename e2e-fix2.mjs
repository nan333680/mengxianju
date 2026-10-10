
import puppeteer from 'puppeteer-core';
import { seedChar, seedChars, waitIdle , tap } from './e2e-helper.mjs';
import http from 'http';
import fs from 'fs';
import path from 'path';
// 工作目录自适应（原来写死 C:/A-DSH-Tool/ai-companion）
const R = path.resolve(import.meta.dirname).split(path.sep).join('/');

// [提速] 批量替换时统一用了 sleep(N) 写法，这里补上定义
const sleep = ms => new Promise(r => setTimeout(r, ms));

const WWW = `${R}/www`;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const KEY = process.env.DSH_API_KEY || 'sk-test';
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
const errs = [];
page.on('pageerror', e => errs.push(e.message));
const reqFail = [];
page.on('requestfailed', r => reqFail.push(r.url().slice(0,70)));

let pass=0, fail=0;
const t=(n,ok,ex='')=>{ if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));} };

await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
await new Promise(r=>setTimeout(r,1800));

t('页面没有加载失败', errs.length === 0, errs.slice(0,3).join(' | '));
t('没有模块加载失败', reqFail.length === 0, reqFail.join(' | '));

// 建一个带开场白的角色并进去 —— 原来这里靠浏览器里残留的角色，
// 是测试设计的缺陷（换个环境就挂）。改成自己准备。
await seedChar(page, '测试角色', { greeting: '（抬头看你）嗯，你来了。' });
await page.reload({ waitUntil:'networkidle0' });
await sleep(400)   // [提速] 原 1800：探针实测 reload 后 app 就绪只要 ~1ms;
await page.evaluate(() => {
  const c = [...document.querySelectorAll('#char-list .char-card')]
    .find(x => x.textContent.includes('测试角色'));
  if (c) c.click();
});
await new Promise(r=>setTimeout(r,1500));

const name = await page.$eval('#chat-name', el => el.textContent.trim()).catch(()=>'');
t('界面正常渲染（角色名显示）', name.length > 0, name);

// 填 key 并发一条
await tap(page, '#btn-settings');
await new Promise(r => setTimeout(r, 800));
// v1.15.2 起 ⚙ 拉开抽屉，设置页要从抽屉里的「全部设置」进
await page.evaluate(() => {
  const b = [...document.querySelectorAll('#drawer-menu [data-wb-drawer]')].find(x => x.dataset.wbDrawer === 'settings');
  if (b) b.click();
});
await new Promise(r=>setTimeout(r,500));
await page.$eval('#s-apikey',(el,k)=>{el.value=k;el.dispatchEvent(new Event('change',{bubbles:true}));},KEY);
await tap(page, '#btn-set-back');
await new Promise(r=>setTimeout(r,500));
await tap(page, '#input');
await page.type('#input','测试记录是否还在',{delay:8});
// ⚠️ 必须用 evaluate 点击，不能用 page.click()。
// page.click 走真实鼠标事件，要求元素在视口内且没被遮挡；
// 这个布局下点击会静默落空（不报错、不发消息），测试却以为发过了。
// 血泪第 9 条记的就是这个坑。实测：page.click → msg=1；evaluate 点击 → msg=3。
await page.evaluate(() => document.getElementById('btn-send').click());
await waitIdle(page);   // 先等按钮出现、再等它消失（原来点完立刻查会误判成已结束）
const n1 = await page.$$eval('.msg', els=>els.length);
t('能正常发消息收到回复', n1 >= 3, '消息数='+n1);

// 刷新验证持久化
await page.reload({ waitUntil:'networkidle0' });
await sleep(400)   // [提速] 原 1800：探针实测 reload 后 app 就绪只要 ~1ms;
const n2 = await page.$$eval('.msg', els=>els.length);
t('刷新后记录仍在', n2 >= 3, '消息数='+n2);

t('仍然没有 JS 错误', errs.length === 0, errs.slice(0,2).join(' | '));

console.log('');
console.log('通过 '+pass+' 项，失败 '+fail+' 项');
await browser.close();
server.close();
process.exit(fail>0?1:0);
