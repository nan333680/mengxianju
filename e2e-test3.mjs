
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
const IMG = OUT + '/test-image.png';

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
await new Promise(r=>setTimeout(r,1500));
// v1.21.59：全新安装不再自动建角色（产品改空），测试自己塞一个
await seedChar(page, '测试角色', { greeting: '' });   // 空开场白：不额外多出一条消息
await page.reload({waitUntil:'networkidle0'}); await new Promise(r=>setTimeout(r,900));

console.log('=== 走一遍换头像流程 ===');

// 1. 打开角色列表
await page.click('#btn-chars');
await new Promise(r=>setTimeout(r,700));
t('角色列表打开', await page.$eval('#view-chars', el=>el.classList.contains('active')));

// 2. 点编辑按钮（✎）
const editBtn = await page.$('.char-card .icon-btn[data-edit]');
t('列表里有编辑按钮', !!editBtn);
await editBtn.click();
await new Promise(r=>setTimeout(r,700));
t('进入角色编辑页', await page.$eval('#view-edit', el=>el.classList.contains('active')));

// 3. 检查头像区是否存在
const hasAvatarBtn = await page.$('#btn-pick-avatar');
t('编辑页有「选择图片」按钮', !!hasAvatarBtn);
const avatarBtnText = await page.$eval('#btn-pick-avatar', el=>el.textContent.trim());
console.log('  按钮文字: ' + avatarBtnText);

// 4. 点它，模拟选图
const [chooser] = await Promise.all([
  page.waitForFileChooser({ timeout: 15000 }),
  page.click('#btn-pick-avatar')
]);
t('文件选择器被唤起', !!chooser);
await chooser.accept([IMG]);

// 选图后进的是裁剪页（v1.1.x 之后加了 QQ 式裁剪），不是直接回编辑页。
// 老版本测试在这里直接查预览，所以一直失败。
await page.waitForFunction(() => document.querySelector('#view-crop').classList.contains('active'), { timeout: 8000 }).catch(()=>{});
t('选图后进入裁剪页', await page.$eval('#view-crop', el => el.classList.contains('active')));
await new Promise(r=>setTimeout(r,700));
await page.click('#btn-crop-ok');
await page.waitForFunction(() => document.querySelector('#view-edit').classList.contains('active'), { timeout: 8000 }).catch(()=>{});
await new Promise(r=>setTimeout(r,1000));

// 5. 检查预览（裁剪确认之后才回到编辑页预览）
const prevHasImg = await page.$eval('#e-avatar-prev', el => !!el.querySelector('img'));
t('裁剪确认后预览显示了新头像', prevHasImg);
const prevSrc = await page.$eval('#e-avatar-prev', el => { const i = el.querySelector('img'); return i ? i.src.slice(0,30) : ''; });
console.log('  预览 src 前缀: ' + prevSrc);
await page.screenshot({ path: OUT + '/12-换头像.png' });

// 6. 保存
await page.click('#btn-edit-save');
await new Promise(r=>setTimeout(r,1200));
t('保存后回到聊天页', await page.$eval('#view-chat', el=>el.classList.contains('active')));

// 7. 检查聊天页顶部头像
const topHasImg = await page.$eval('#chat-avatar', el => !!el.querySelector('img'));
t('聊天页顶部头像已换成图片', topHasImg);

// 8. 刷新验证持久化
await page.reload({ waitUntil:'networkidle0' });
await sleep(400)   // [提速] 原 1800：探针实测 reload 后 app 就绪只要 ~1ms;
const afterReload = await page.$eval('#chat-avatar', el => !!el.querySelector('img'));
t('刷新后头像仍是图片', afterReload);
await page.screenshot({ path: OUT + '/13-头像已换.png' });

t('无 JS 错误', errs.length===0, errs.join('|'));

console.log('');
console.log('========================================');
console.log('通过 '+pass+' 项，失败 '+fail+' 项');
await browser.close();
server.close();
process.exit(fail>0?1:0);
