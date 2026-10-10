
import puppeteer from 'puppeteer-core';
import { seedChar } from './e2e-helper.mjs';
import http from 'http';
import fs from 'fs';
import path from 'path';
// 工作目录自适应（原来写死 C:/A-DSH-Tool/ai-companion）
const R = path.resolve(import.meta.dirname).split(path.sep).join('/');

// [提速] 批量替换时统一用了 sleep(N) 写法，这里补上定义
const sleep = ms => new Promise(r => setTimeout(r, ms));


const WWW = `${R}/www`;
const OUT = `${R}/e2e`;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const API_KEY = process.env.DSH_API_KEY || 'sk-test';
const IMG = OUT + '/crop-test.png';

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

let pass=0, fail=0;
const t=(n,ok,ex='')=>{ if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));} };

await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
await new Promise(r=>setTimeout(r,1600));
// v1.21.59：全新安装不再自动建角色（产品改空），测试自己塞一个
await seedChar(page, '测试角色', { greeting: '' });   // 空开场白：不额外多出一条消息
await page.reload({waitUntil:'networkidle0'}); await new Promise(r=>setTimeout(r,900));
await page.click('#btn-settings');
await new Promise(r => setTimeout(r, 800));
// v1.15.2 起 ⚙ 拉开抽屉，设置页要从抽屉里的「全部设置」进
await page.evaluate(() => {
  const b = [...document.querySelectorAll('#drawer-menu [data-wb-drawer]')].find(x => x.dataset.wbDrawer === 'settings');
  if (b) b.click();
});
await new Promise(r=>setTimeout(r,500));
await page.$eval('#s-apikey',(el,k)=>{el.value=k;el.dispatchEvent(new Event('change',{bubbles:true}));},API_KEY);
await new Promise(r=>setTimeout(r,300));

console.log('=== 我的头像 ===');
// v1.21.61 起设置拆成两页，「我的头像」在「我的设置」里 —— 要先切过去。
// 不切的话 page.click 会因为按钮不可见而抛 "Node is either not clickable"。
await page.evaluate(() => document.getElementById('btn-set-back').click());
await new Promise(r=>setTimeout(r,400));
await page.evaluate(() => { const b = document.getElementById('btn-drawer-close'); if (b && document.querySelector('#view-drawer.active')) b.click(); });
await new Promise(r=>setTimeout(r,400));
await page.evaluate(() => document.getElementById('btn-settings').click());
await new Promise(r=>setTimeout(r,600));
await page.evaluate(() => { const b = [...document.querySelectorAll('#drawer-menu [data-wb-drawer]')].find(x => x.dataset.wbDrawer === 'mine'); if (b) b.click(); });
await new Promise(r=>setTimeout(r,800));
t('「我的设置」页有「我的头像」预览框', !!(await page.$('#my-avatar-prev')));
t('有「选择图片」按钮', !!(await page.$('#btn-pick-my-avatar')));
t('有「恢复默认」按钮', !!(await page.$('#btn-clear-my-avatar')));
const initTxt = await page.$eval('#my-avatar-prev', el => el.textContent.trim());
t('默认显示 🧑', initTxt === '🧑', initTxt);

// 选图 → 裁剪
const [ch] = await Promise.all([ page.waitForFileChooser({timeout:15000}), page.click('#btn-pick-my-avatar') ]);
await ch.accept([IMG]);
await new Promise(r=>setTimeout(r,2000));
t('进入裁剪页', await page.$eval('#view-crop', el => el.classList.contains('active')));
await page.screenshot({ path: OUT + '/40-我的头像裁剪.png' });

// 拖动一下
const box = await page.$eval('#crop-stage', el => { const r = el.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; });
await page.mouse.move(box.x, box.y);
await page.mouse.down();
await page.mouse.move(box.x - 70, box.y, { steps: 10 });
await page.mouse.up();
await new Promise(r=>setTimeout(r,400));

// 确定
await page.click('#btn-crop-ok');
await new Promise(r=>setTimeout(r,1200));
// 从「我的设置」进来的，裁剪完就回「我的设置」（v1.21.61 拆页后）
t('确定后回到我的设置页', await page.$eval('#view-mine', el => el.classList.contains('active')));
const nowImg = await page.$eval('#my-avatar-prev', el => el.querySelector('img') ? el.querySelector('img').src.slice(0,25) : '');
t('预览换成图片', nowImg.startsWith('data:image/jpeg'), nowImg);
await page.screenshot({ path: OUT + '/41-我的头像已设.png' });

// 发消息看聊天里自己那侧的头像
// v1.15.2：栈是 chat → drawer → settings，要退两层才回聊天页（少退一层会停在抽屉，
// 消息发不出去，头像断言自然全红）
// 当前页可能是「我的设置」也可能是「全局设置」，点当前这页的返回
await page.evaluate(() => { const v = document.querySelector('.view.active'); const b = v && v.querySelector('header .icon-btn'); if (b) b.click(); });
await new Promise(r=>setTimeout(r,700));
await page.evaluate(() => { const b = document.getElementById('btn-drawer-close'); if (b) b.click(); });
await new Promise(r=>setTimeout(r,700));
await page.evaluate(() => { document.getElementById('input').focus(); });
await page.type('#input', '测试我的头像', { delay: 12 });
// 用 JS 点击：抽屉层还在时真实鼠标点击会打到覆盖层上
await page.evaluate(() => document.getElementById('btn-send').click());
for (let i=0;i<240;i++){ await new Promise(r=>setTimeout(r,400)); const b=await page.$eval('#btn-stop',el=>!el.classList.contains('hidden')); if(!b) break; }

const myAvHasImg = await page.$$eval('.msg.me .av img', els => els.length);
t('聊天里我的头像是图片', myAvHasImg >= 1, '数量=' + myAvHasImg);
const aiAvIsEmoji = await page.$$eval('.msg.ai .av', els => els.filter(e => !e.querySelector('img')).length);
t('她那一侧头像不受影响', aiAvIsEmoji >= 1);
await page.screenshot({ path: OUT + '/42-聊天双头像.png' });

// 刷新持久化
await page.reload({ waitUntil:'networkidle0' });
await sleep(400)   // [提速] 原 1800：探针实测 reload 后 app 就绪只要 ~1ms;
const afterReload = await page.$$eval('.msg.me .av img', els => els.length);
t('刷新后我的头像保留', afterReload >= 1);

// 恢复默认（此时应已在聊天页；若上次没退干净，先退回去）
await page.evaluate(() => {
  for (let i = 0; i < 4; i++) {
    if (document.querySelector('#view-chat.active')) break;
    const b = document.getElementById('btn-drawer-close') || document.getElementById('btn-set-back');
    if (b) b.click();
  }
});
await new Promise(r => setTimeout(r, 800));
await page.click('#btn-settings');
await new Promise(r => setTimeout(r, 800));
// v1.21.61 起「我的头像」在「我的设置」页
await page.evaluate(() => {
  const b = [...document.querySelectorAll('#drawer-menu [data-wb-drawer]')].find(x => x.dataset.wbDrawer === 'mine');
  if (b) b.click();
});
await new Promise(r=>setTimeout(r,600));
await page.click('#btn-clear-my-avatar');
await new Promise(r=>setTimeout(r,900));
const backTxt = await page.$eval('#my-avatar-prev', el => el.textContent.trim());
t('恢复默认后变回 🧑', backTxt === '🧑', backTxt);
// 退到聊天页再查：栈是 chat → drawer → settings，要多退一层
for (let i = 0; i < 4; i++) {
  const v = await page.evaluate(() => (document.querySelector('.view.active') || {}).id);
  if (v === 'view-chat') break;
  await page.evaluate(() => {
    if (document.querySelector('#view-settings.active')) {
      const b = document.getElementById('btn-set-back'); if (b) b.click();
      return;
    }
    const dc = document.getElementById('btn-drawer-close'); if (dc) dc.click();
  });
  await new Promise(r=>setTimeout(r,700));
}
// 用 $eval，不能用 $eval —— 没有匹配元素时 $eval 会直接抛错
const myAvNow = await page.$$eval('.msg.me .av img', els => els.length);
t('聊天里也恢复为 emoji', myAvNow === 0, '图片数=' + myAvNow);

t('无 JS 错误', errs.length === 0, errs.slice(0,2).join(' | '));

console.log('');
console.log('========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close();
server.close();
process.exit(fail>0?1:0);
