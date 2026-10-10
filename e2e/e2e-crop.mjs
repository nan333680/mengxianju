
import puppeteer from 'puppeteer-core';
import { seedChar } from './e2e-helper.mjs';
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
const canvasSig = () => page.evaluate(() => document.querySelector('#crop-canvas').toDataURL().length + ':' + document.querySelector('#crop-canvas').toDataURL().slice(500, 560));

await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
await new Promise(r=>setTimeout(r,1500));
// v1.21.59：全新安装不再自动建角色（产品改空），测试自己塞一个
await seedChar(page, '测试角色', { greeting: '' });   // 空开场白：不额外多出一条消息
await page.reload({waitUntil:'networkidle0'}); await new Promise(r=>setTimeout(r,900));

// 打开角色编辑
await page.click('#btn-chars');
await new Promise(r=>setTimeout(r,700));
await page.click('.char-card .icon-btn[data-edit]');
await new Promise(r=>setTimeout(r,800));

console.log('=== 头像裁剪 ===');
// 选图
const [chooser] = await Promise.all([ page.waitForFileChooser({timeout:15000}), page.click('#btn-pick-avatar') ]);
await chooser.accept([IMG]);
await new Promise(r=>setTimeout(r,2000));

const cropOpen = await page.$eval('#view-crop', el => el.classList.contains('active'));
t('选图后进入裁剪页', cropOpen);
await page.screenshot({ path: OUT + '/30-裁剪界面.png' });

const stage = await page.$eval('#crop-stage', el => ({ w: el.offsetWidth, h: el.offsetHeight }));
t('裁剪框是正方形', stage.w === stage.h && stage.w > 150, JSON.stringify(stage));

const sig0 = await canvasSig();

// 拖动
const box = await page.$eval('#crop-stage', el => { const r = el.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; });
await page.mouse.move(box.x, box.y);
await page.mouse.down();
await page.mouse.move(box.x - 90, box.y, { steps: 12 });
await page.mouse.up();
await new Promise(r=>setTimeout(r,600));
const sig1 = await canvasSig();
t('拖动后画面改变', sig0 !== sig1);
await page.screenshot({ path: OUT + '/31-拖动后.png' });

// 缩放
await page.$eval('#crop-zoom', el => { el.value = 200; el.dispatchEvent(new Event('input',{bubbles:true})); });
await new Promise(r=>setTimeout(r,600));
const sig2 = await canvasSig();
t('缩放后画面改变', sig1 !== sig2);
await page.screenshot({ path: OUT + '/32-放大后.png' });

// 拖动边界限制：使劲往右拖，不应该露出空白
await page.mouse.move(box.x, box.y);
await page.mouse.down();
await page.mouse.move(box.x + 600, box.y, { steps: 15 });
await page.mouse.up();
await new Promise(r=>setTimeout(r,500));
const edgeOk = await page.evaluate(() => {
  const cv = document.querySelector('#crop-canvas');
  const ctx = cv.getContext('2d');
  // 检查四个角是否有透明像素（说明图片被拖出框了）
  const pts = [[2,2],[cv.width-3,2],[2,cv.height-3],[cv.width-3,cv.height-3]];
  for (const [x,y] of pts) {
    const d = ctx.getImageData(x,y,1,1).data;
    if (d[3] < 250) return false;
  }
  return true;
});
t('拖到边界也不会露空', edgeOk);

// 确定
await page.click('#btn-crop-ok');
await new Promise(r=>setTimeout(r,900));
t('回到角色编辑页', await page.$eval('#view-edit', el => el.classList.contains('active')));
const prevHasImg = await page.$eval('#e-avatar-prev', el => !!el.querySelector('img'));
t('头像预览已更新', prevHasImg);

// 保存
await page.click('#btn-edit-save');
await new Promise(r=>setTimeout(r,1200));
const topImg = await page.$eval('#chat-avatar', el => el.querySelector('img') ? el.querySelector('img').src.slice(0,30) : '');
t('聊天页头像已换', topImg.startsWith('data:image/jpeg'), topImg);

// 刷新持久化
await page.reload({ waitUntil:'networkidle0' });
await sleep(400)   // [提速] 原 1800：探针实测 reload 后 app 就绪只要 ~1ms;
const afterReload = await page.$eval('#chat-avatar', el => !!el.querySelector('img'));
t('刷新后头像仍保留', afterReload);
await page.screenshot({ path: OUT + '/33-头像已应用.png' });

// 取消路径
await page.click('#btn-chars');
await new Promise(r=>setTimeout(r,600));
await page.click('.char-card .icon-btn[data-edit]');
await new Promise(r=>setTimeout(r,700));
const before = await page.$eval('#e-avatar-prev img', el => el.src.length);
const [ch2] = await Promise.all([ page.waitForFileChooser({timeout:15000}), page.click('#btn-pick-avatar') ]);
await ch2.accept([IMG]);
await new Promise(r=>setTimeout(r,1800));
await page.click('#btn-crop-cancel');
await new Promise(r=>setTimeout(r,800));
t('取消后回到编辑页', await page.$eval('#view-edit', el => el.classList.contains('active')));
const after = await page.$eval('#e-avatar-prev img', el => el.src.length);
t('取消不会改动原头像', before === after);

t('无 JS 错误', errs.length === 0, errs.slice(0,2).join(' | '));

console.log('');
console.log('========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close();
server.close();
process.exit(fail>0?1:0);
