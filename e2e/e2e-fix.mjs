
import puppeteer from 'puppeteer-core';
import { waitIdle, tap, seedChar } from './e2e-helper.mjs';
import http from 'http';
import fs from 'fs';
import path from 'path';
// 工作目录自适应（原来写死 C:/A-DSH-Tool/ai-companion）
const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');

const WWW = `${R}/www`;
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

const errs = [];
page.on('pageerror', e => errs.push(e.message));
const consoleErrs = [];
page.on('console', m => { if (m.type() === 'error') consoleErrs.push(m.text()); });

let pass=0, fail=0;
const t=(n,ok,ex='')=>{ if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));} };

await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
await new Promise(r=>setTimeout(r,1600));
// v1.21.59：全新安装不再自动建角色（产品改空），测试自己塞一个
await seedChar(page, '测试角色', { greeting: '' });   // 空开场白：不额外多出一条消息
await page.reload({waitUntil:'networkidle0'}); await new Promise(r=>setTimeout(r,900));

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

console.log('=== 复现你的场景：第一句就发消息 ===');
await tap(page, '#input');
await page.type('#input', '你好呀', { delay: 15 });
// ⚠️ 必须用 evaluate 点击，不能用 page.click()。
// page.click 走真实鼠标事件，要求元素在视口内且没被遮挡；
// 这个布局下点击会静默落空（不报错、不发消息），测试却以为发过了。
// 血泪第 9 条记的就是这个坑。实测：page.click → msg=1；evaluate 点击 → msg=3。
await page.evaluate(() => document.getElementById('btn-send').click());

// 等生成结束（先等按钮出现、再等它消失，见 e2e-helper.mjs）
const _w = await waitIdle(page);
const done = _w.ended;
t('生成流程跑完（没卡住）', done, _w.started ? '' : '（停止按钮从未出现＝请求没发出去）');

const all = await page.$$eval('.msg .bub', els => els.map(e=>e.textContent.trim()));
const reply = all[all.length-1];
console.log('  她的回复: ' + reply);
t('收到了实际回复', reply && reply.length > 2 && !reply.includes('已中断'), JSON.stringify(reply).slice(0,80));

const refErr = errs.filter(e => /is not defined|ReferenceError/.test(e));
t('没有 ReferenceError', refErr.length === 0, refErr.join(' | '));
t('没有其他 JS 错误', errs.length === 0, errs.slice(0,3).join(' | '));

// 再测颜文字关闭的情况（这条路径正是出错的那行）
console.log('');
console.log('=== 再测「颜文字关闭」路径（报错那行的分支）===');
await tap(page, '#btn-chars');
await new Promise(r=>setTimeout(r,700));
await tap(page, '.char-card .icon-btn[data-edit]');
await new Promise(r=>setTimeout(r,800));
await page.evaluate(() => {
  const b = [...document.querySelectorAll('#e-kao-freq button')].find(x => x.textContent.trim() === '关闭');
  if (b) b.click();
});
await new Promise(r=>setTimeout(r,300));
await tap(page, '#btn-edit-save');
await new Promise(r=>setTimeout(r,1200));

await tap(page, '#input');
await page.type('#input', '再试一句', { delay: 15 });
// ⚠️ 必须用 evaluate 点击，不能用 page.click()。
// page.click 走真实鼠标事件，要求元素在视口内且没被遮挡；
// 这个布局下点击会静默落空（不报错、不发消息），测试却以为发过了。
// 血泪第 9 条记的就是这个坑。实测：page.click → msg=1；evaluate 点击 → msg=3。
await page.evaluate(() => document.getElementById('btn-send').click());
await waitIdle(page);
const all2 = await page.$$eval('.msg .bub', els => els.map(e=>e.textContent.trim()));
const reply2 = all2[all2.length-1];
console.log('  回复: ' + reply2);
t('颜文字关闭路径也正常', reply2 && reply2.length > 2 && !reply2.includes('已中断'), JSON.stringify(reply2).slice(0,60));

const refErr2 = errs.filter(e => /is not defined/.test(e));
t('该路径也没报错', refErr2.length === 0, refErr2.join(' | '));

console.log('');
console.log('========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close();
server.close();
process.exit(fail>0?1:0);
