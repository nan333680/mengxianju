import puppeteer from 'puppeteer-core';
import http from 'http'; import fs from 'fs'; import path from 'path';
import { seedChar } from './e2e-helper.mjs';
const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');
const WWW=`${R}/www`;
const CHROME='C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png'};
const server=http.createServer((req,res)=>{let p=decodeURIComponent(req.url.split('?')[0]);if(p==='/')p='/index.html';const f=path.join(WWW,p);if(!fs.existsSync(f)){res.writeHead(404);res.end('404');return;}res.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream'});res.end(fs.readFileSync(f));});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const port=server.address().port;
const browser=await puppeteer.launch({executablePath:CHROME,headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
const page=await browser.newPage();
await page.setViewport({width:393,height:851,deviceScaleFactor:2,isMobile:true,hasTouch:true});
const errs=[]; page.on('pageerror',e=>errs.push(e.message));
const failed=[]; page.on('requestfailed', r => failed.push(r.url() + ' ' + (r.failure()||{}).errorText));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let pass=0,fail=0;
const t=(n,ok,ex='')=>{if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));}};

await page.goto('http://127.0.0.1:'+port+'/',{waitUntil:'networkidle0',timeout:40000});
await sleep(1200);
await page.evaluate(()=>indexedDB.deleteDatabase('ai-companion'));
await page.reload({waitUntil:'networkidle0'}); await sleep(600);
await seedChar(page, '关于页测试');
await page.reload({waitUntil:'networkidle0'}); await sleep(700);

console.log('=== 从抽屉进关于页 ===');
await page.evaluate(() => document.getElementById('btn-settings').click()); await sleep(700);
const items = await page.$$eval('#drawer-menu [data-wb-drawer]', els => els.map(e => e.dataset.wbDrawer));
t('抽屉里有 about 这一项', items.includes('about'), JSON.stringify(items));
await page.evaluate(() => { const b=[...document.querySelectorAll('#drawer-menu [data-wb-drawer]')].find(x=>x.dataset.wbDrawer==='about'); if(b)b.click(); });
await sleep(800);
t('关于页打开了', await page.$eval('#view-about', el => el.classList.contains('active')));

console.log('');
console.log('=== 内容 ===');
const txt = await page.$eval('#view-about', el => el.textContent);
for (const [k, s] of [['版权行', 'Copyright (C) 2026 DaRiko'], ['无担保', '不提供任何担保'],
                      ['许可证名', 'AGPL-3.0'], ['源码地址', 'github.com/nan333680'],
                      ['联系方式', '3780117926@qq.com'], ['名称与图标说明', 'TRADEMARK']]) {
  t('有「' + k + '」', txt.includes(s), s);
}
// 不写死版本号（写死了每次升版都会假红）：和设置页那行动态比
const ver = await page.$eval('#about-ver', el => el.textContent.trim());
const setVer = await page.$eval('#app-ver', el => el.textContent.trim());
t('关于页版本号和设置页那行一致', ver === setVer && /^v\d+\.\d+(\.\d+)*$/.test(ver), ver + ' vs ' + setVer);

console.log('');
console.log('=== 图标（这次改的就是它）===');
const img = await page.evaluate(() => {
  const el = document.querySelector('#view-about img.about-logo');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { src: el.getAttribute('src'), w: Math.round(r.width), h: Math.round(r.height), complete: el.complete, nat: el.naturalWidth };
});
console.log('   ' + JSON.stringify(img));
t('关于页用的是图片不是 emoji', !!img, JSON.stringify(img));
t('图片加载成功（naturalWidth > 0）', !!img && img.nat > 0, img ? String(img.nat) : 'n/a');
t('图片是真图标（192px 源）', !!img && img.nat === 192, img && String(img.nat));
t('显示尺寸 64×64', !!img && img.w === 64 && img.h === 64, img ? img.w + 'x' + img.h : '');
t('没有任何资源加载失败', failed.length === 0, failed.join(' | '));

console.log('');
t('全程无 JS 错误', errs.length===0, errs.slice(0,3).join(' | '));
console.log('');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close(); server.close();
process.exit(fail>0?1:0);
