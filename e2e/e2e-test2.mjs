
import puppeteer from 'puppeteer-core';
import { waitIdle, tap, seedChar } from './e2e-helper.mjs';
import http from 'http';
import fs from 'fs';
import path from 'path';
// 工作目录自适应（原来写死 C:/A-DSH-Tool/ai-companion）
const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');

const WWW = `${R}/www`;
const OUT = `${R}/e2e`;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const API_KEY = process.env.DSH_API_KEY || 'sk-test';
// 识图素材必须放在工程内，不能放 OUT —— OUT 是截图输出目录，
// 测试产物被清理后素材就没了，FileChooser 直接超时。
// 图是现生成的白底黑字「7」（见 _fixtures/test-image.png），
// 对应下面"她认出了数字 7"那条断言。
const IMG = `${R}/_fixtures/test-image.png`;

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

let pass = 0, fail = 0;
const t = (n, ok, ex='') => { if (ok) { pass++; console.log('  OK   ' + n); } else { fail++; console.log('  FAIL ' + n + (ex?'  -> '+ex:'')); } };

await page.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'networkidle0', timeout: 40000 });
await new Promise(r => setTimeout(r, 1500));
// v1.21.59：全新安装不再自动建角色（产品改空），测试自己塞一个
await seedChar(page, '测试角色', { greeting: '' });   // 空开场白：不额外多出一条消息
await page.reload({waitUntil:'networkidle0'}); await new Promise(r=>setTimeout(r,900));

// 填 Key
await tap(page, '#btn-settings');
await new Promise(r => setTimeout(r, 800));
// v1.15.2 起 ⚙ 拉开抽屉，设置页要从抽屉里的「全部设置」进
await page.evaluate(() => {
  const b = [...document.querySelectorAll('#drawer-menu [data-wb-drawer]')].find(x => x.dataset.wbDrawer === 'settings');
  if (b) b.click();
});
await new Promise(r => setTimeout(r, 500));
await page.$eval('#s-apikey',(el,k)=>{el.value=k;el.dispatchEvent(new Event('change',{bubbles:true}));},API_KEY);
await tap(page, '#btn-set-back');
await new Promise(r => setTimeout(r, 500));
// ⚠️ 从这里返回会停在【抽屉】页（view-drawer），不是聊天页。
// 而且 v0.4.4 起选图按钮搬进了输入框的「＋」抽屉里（原来的 #btn-image 已从输入行移除），
// 所以下面要先回到聊天页、再点 ＋ 拉出抽屉、然后点「发送图片」那一格。
// 实测现场：view=view-drawer，按钮 40x40@10,803（在视口内但被遮）。
for (let i = 0; i < 4; i++) {
  const v = await page.evaluate(() => document.querySelector('.view.active')?.id);
  if (v === 'view-chat') break;
  await page.evaluate(() => {
    const b = document.getElementById('btn-drawer-close') || document.getElementById('btn-set-back');
    if (b) b.click();
  });
  await new Promise(r => setTimeout(r, 500));
}

console.log('=== 发图片 ===');
// ⚠️ 这里必须用 page.click，不能用 tap（el.click()）——
// 文件选择框是浏览器的原生对话框，只有真实鼠标事件才会触发，
// el.click() 点了按钮但不会弹框，waitForFileChooser 会一直等到超时。
//
// 另一个坑：从设置页返回后立刻点会落空（界面还在切）。
// 所以先等图片按钮真的可见，再点；失败重试一次。
await page.waitForFunction(() => {
  const e = document.getElementById('btn-plus');
  return e && e.offsetParent !== null && !e.classList.contains('hidden');
}, { timeout: 8000 });
await new Promise(r => setTimeout(r, 600));
// 点 ＋ 拉出抽屉，等「发送图片」那一格真的画出来、可见
await page.click('#btn-plus');
await page.waitForFunction(() => {
  const e = document.querySelector('#cmd-drawer .cmd-item[data-cmd="image"]');
  return e && e.offsetParent !== null;
}, { timeout: 8000 });
await new Promise(r => setTimeout(r, 400));
// 打印现场，超时时能一眼看出是"没回到聊天页"还是"按钮真的点不动"
console.log('  现场: view=' + await page.evaluate(() => document.querySelector('.view.active')?.id)
  + ' 抽屉项可见=' + await page.evaluate(() => { const e = document.querySelector('#cmd-drawer .cmd-item[data-cmd="image"]');
      const r = e.getBoundingClientRect(); return r.width + 'x' + r.height + '@' + Math.round(r.x) + ',' + Math.round(r.y); }));

let chooser = null;
for (let attempt = 0; attempt < 2 && !chooser; attempt++) {
  try {
    [chooser] = await Promise.all([
      page.waitForFileChooser({ timeout: 10000 }),
      page.click('#cmd-drawer .cmd-item[data-cmd="image"]')
    ]);
  } catch (e) {
    if (attempt === 1) throw e;
    await new Promise(r => setTimeout(r, 800));
    const open = await page.evaluate(() => !document.getElementById('cmd-drawer').classList.contains('hidden'));
    if (!open) { await page.click('#btn-plus'); await new Promise(r2 => setTimeout(r2, 400)); }
  }
}
await chooser.accept([IMG]);
await new Promise(r => setTimeout(r, 2000));

// 检查预览缩略图出现
const thumbs = await page.$$eval('#attach-preview .thumb img', els => els.length);
t('图片预览出现', thumbs === 1, '缩略图数=' + thumbs);
const previewVisible = await page.$eval('#attach-preview', el => !el.classList.contains('hidden'));
t('预览区可见', previewVisible);
await page.screenshot({ path: OUT + '/10-图片预览.png' });

// 带上文字一起发
await tap(page, '#input');
await page.type('#input', '这张图上写的是什么数字？只回答数字', { delay: 12 });
const t0 = Date.now();
// ⚠️ 必须用 evaluate 点击，不能用 page.click()。
// page.click 走真实鼠标事件，要求元素在视口内且没被遮挡；
// 这个布局下点击会静默落空（不报错、不发消息），测试却以为发过了。
// 血泪第 9 条记的就是这个坑。实测：page.click → msg=1；evaluate 点击 → msg=3。
await page.evaluate(() => document.getElementById('btn-send').click());

// 先等按钮出现、再等它消失（原来点完立刻查会误判成"已结束"）
const _w = await waitIdle(page, 8000, 150000);
const done = _w.ended;
console.log('  生成耗时: ' + ((Date.now()-t0)/1000).toFixed(1) + 's');
t('生成正常结束', done, _w.started ? '' : '（停止按钮从未出现）');

const all = await page.$$eval('.msg .bub', els => els.map(e => e.textContent.trim()));
const reply = all[all.length-1];
console.log('');
console.log('  她的回复: ' + reply);
console.log('');
t('有回复', reply.length > 0);

// 图片是否真的发出去了（我的消息里应有 img）
const myImgs = await page.$$eval('.msg.me .bub img.pic', els => els.length);
t('我的消息里带上了图片', myImgs === 1, 'img 数=' + myImgs);

// 是否真的识图（回复里含 7）
const sawSeven = /7|七/.test(reply);
t('她认出了数字 7', sawSeven, reply.slice(0,60));

await page.screenshot({ path: OUT + '/11-识图结果.png' });

t('无 JS 错误', errs.length === 0, errs.join('|'));

console.log('');
console.log('========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');

await browser.close();
server.close();
process.exit(fail>0?1:0);
