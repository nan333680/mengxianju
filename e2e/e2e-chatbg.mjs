import puppeteer from 'puppeteer-core';
import http from 'http';
import fs from 'fs';
import path from 'path';
const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');

// 聊天背景（v0.5.7.4）。
// 验的是「图真的挂到聊天页上了、遮罩和模糊是分开的两层、没图时滑杆是灰的」。
// 观感（暗化多少合适、模糊好不好看）回归证明不了，只能真机看。
const WWW = `${R}/www`;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
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
await page.evaluateOnNewDocument(() => {
  Object.defineProperty(navigator, 'language', { get: () => 'zh-CN', configurable: true });
  Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh'], configurable: true });
});
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = [];
page.on('pageerror', e => errs.push(e.message));
let pass=0, fail=0;
const t=(n,ok,ex='')=>{ if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));} };
const sleep = ms => new Promise(r=>setTimeout(r,ms));

await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
await page.waitForSelector('#view-chat', { timeout:20000 }).catch(()=>{});
await sleep(1200);

console.log('=== 没设图时 ===');
const none = await page.evaluate(() => ({
  parent: document.getElementById('chat-bg')?.parentElement?.id || '',
  imgVar: getComputedStyle(document.documentElement).getPropertyValue('--bg-img').trim(),
  dimVar: getComputedStyle(document.documentElement).getPropertyValue('--bg-dim').trim(),
  blurVar: getComputedStyle(document.documentElement).getPropertyValue('--bg-blur').trim(),
  sliders: ['s-bgdim','s-bgblur','s-bg-clear'].map(id => { const e = document.getElementById(id); return e ? e.hasAttribute('disabled') : null; })
}));
t('#chat-bg 挂在 #view-chat 里（不是 body）', none.parent === 'view-chat', '父节点=' + none.parent);
t('没图时 --bg-img 是 none', none.imgVar === 'none', none.imgVar);
t('暗化默认 50%', none.dimVar === '0.5', none.dimVar);
t('模糊默认 0px', none.blurVar === '0px', none.blurVar);
t('没图时两个滑杆和「清除」都是灰的', none.sliders.every(x => x === true), JSON.stringify(none.sliders));

console.log('=== 塞一张图进库，重载 ===');
const dataUrl = await page.evaluate(() => {
  const c = document.createElement('canvas'); c.width = 8; c.height = 8;
  const x = c.getContext('2d'); x.fillStyle = '#c62828'; x.fillRect(0,0,8,8);
  return c.toDataURL('image/png');
});
await page.evaluate(async (u) => {
  const { kv } = await import('./js/db.js');
  await kv.set('bgImg', u);
}, dataUrl);
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForSelector('#view-chat', { timeout: 20000 }).catch(()=>{});
await sleep(1200);

const has = await page.evaluate(() => {
  const bg = document.querySelector('#chat-bg .bg-img');
  const dim = document.querySelector('#chat-bg .bg-dim');
  const cs = (el) => el ? getComputedStyle(el) : null;
  const b = cs(bg), d = cs(dim);
  return {
    imgVar: getComputedStyle(document.documentElement).getPropertyValue('--bg-img').trim().slice(0, 30),
    bgImage: b ? b.backgroundImage.slice(0, 30) : '',
    bgFilter: b ? b.filter : '',
    dimBg: d ? d.backgroundColor : '',
    dimOpacity: d ? d.opacity : '',
    sliders: ['s-bgdim','s-bgblur'].map(id => { const e = document.getElementById(id); return e ? e.hasAttribute('disabled') : null; }),
    thumb: document.getElementById('s-bg-thumb')?.className || ''
  };
});
t('有图时 --bg-img 是 url(data:)', /^url\("?data:/.test(has.imgVar) || /url\(&quot;?data:/.test(has.imgVar), has.imgVar);
t('图那一层真的有背景图', has.bgImage.includes('data:image'), has.bgImage);
t('遮罩那一层在（不和图同一层）', has.dimBg !== '' && has.dimBg !== 'rgba(0, 0, 0, 0)', has.dimBg);
t('遮罩不透明度是 0.5', Math.abs(Number(has.dimOpacity) - 0.5) < 0.001, has.dimOpacity);
t('有图后滑杆解除禁用', has.sliders[0] === false && has.sliders[1] === false, JSON.stringify(has.sliders));
t('缩略图有 has 类', has.thumb.includes('has'), has.thumb);

// 清空聊天不删背景图：bgImg 不命中任何 WIPE 前缀
const keep = await page.evaluate(async () => {
  const { kv } = await import('./js/db.js');
  const v = await kv.get('bgImg', '');
  return typeof v === 'string' && v.startsWith('data:image');
});
t('清空/重载之后 bgImg 仍在库里', keep === true, String(keep));

console.log('=== 清除背景（v0.5.7.5） ===');
// 背景这组控件的事件是在「我的设置」页初始化时绑的（不随启动绑），
// 所以必须先真的进一次设置页，否则 onclick 是 null。
await page.evaluate(() => document.getElementById('btn-settings').click()); await sleep(700);
await page.evaluate(() => { const b=[...document.querySelectorAll('#drawer-menu [data-wb-drawer]')].find(x=>x.dataset.wbDrawer==='mine'); if(b)b.click(); }); await sleep(800);
console.log('=== 气泡不透明度（v0.5.7.5） ===');
const a1 = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bubble-alpha').trim());
t('有图、默认 100% 时 alpha 是 1', a1 === '1', a1);
await page.evaluate(() => { const el = document.getElementById('s-bubblealpha'); el.value = '70'; el.dispatchEvent(new Event('input', { bubbles: true })); });
await sleep(400);
const a2 = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bubble-alpha').trim());
t('拉到 70% 后 alpha 是 0.7', a2 === '0.7', a2);
await page.evaluate(() => { const s = document.getElementById('s-theme'); s.value = 'light'; s.dispatchEvent(new Event('change', { bubbles: true })); });
await sleep(450);
const a3 = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bubble-alpha').trim());
t('切浅色后 alpha 仍跟随滑杆', a3 === '0.7', a3);
await page.evaluate(() => { const s = document.getElementById('s-theme'); s.value = 'dark'; s.dispatchEvent(new Event('change', { bubbles: true })); });
await sleep(450);

const diag = await page.evaluate(() => {
  const el = document.getElementById('s-bg-clear');
  return { exists: !!el, handler: el ? typeof el.onclick : 'no-el', disabled: el ? el.hasAttribute('disabled') : null };
});
console.log('   [诊断] ' + JSON.stringify(diag));
const clearBefore = await page.evaluate(() => document.getElementById('s-bg-clear').hasAttribute('disabled'));
t('有图时「清除」可点', clearBefore === false, String(clearBefore));
await page.evaluate(() => document.getElementById('s-bg-clear').click());
await sleep(450);
const afterClear = await page.evaluate(async () => {
  const { kv } = await import('./js/db.js');
  return {
    imgVar: getComputedStyle(document.documentElement).getPropertyValue('--bg-img').trim(),
    bgImage: document.querySelector('#chat-bg .bg-img') ? getComputedStyle(document.querySelector('#chat-bg .bg-img')).backgroundImage : '',
    clearDisabled: document.getElementById('s-bg-clear').hasAttribute('disabled'),
    inDb: await kv.get('bgImg', '')
  };
});
t('点清除后 --bg-img 变 none', afterClear.imgVar === 'none', afterClear.imgVar);
t('图那一层的背景也清掉了', afterClear.bgImage === 'none' || afterClear.bgImage === '', afterClear.bgImage);
t('kv 里的 bgImg 真的删了', !afterClear.inDb, String(afterClear.inDb));
t('清除后按钮自己变灰', afterClear.clearDisabled === true, String(afterClear.clearDisabled));
const a4 = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bubble-alpha').trim());
t('清除背景后 alpha 回到 1（没图就不透）', a4 === '1', a4);

t('页内没有 JS 异常', errs.length === 0, errs.join(' | '));
console.log('');
console.log('通过 ' + pass + ' 项 / 失败 ' + fail + ' 项');
await browser.close();
server.close();
process.exit(fail ? 1 : 0);
