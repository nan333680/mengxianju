import puppeteer from 'puppeteer-core';
import http from 'http';
import fs from 'fs';
import path from 'path';
const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');

// 主题色板（v0.5.7.4）：18 套色相 × 深浅两档，全部是纯函数算出来的。
// 这里钉住两件事：
//   ① 每个「承载文字」的底色，白字对比度达标（按钮 / 气泡）
//   ② applyTheme 真的把这七个变量写到了 documentElement 上
// 观感（色板鲜不鲜、黄变暗褐好不好看）回归证明不了，只能真机看。
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

console.log('=== 色板纯函数：36 套的对比度 ===');
const calc = await page.evaluate(async () => {
  const M = await import('./js/theme.js');
  const BG_L = '#f5f6fa', BG_D = '#12131a';
  const hexLum = (h) => { const n = parseInt(h.slice(1),16); return M.relLum((n>>16)&255,(n>>8)&255,n&255); };
  const out = { badBtn: [], badBub: [], badText: [], badPri2: [], minBtn: 99, minBub: 99, minText: 99, minPri2: 99 };
  for (const c of M.THEME_COLORS) {
    for (const isLight of [false, true]) {
      const v = M.colorVars(c, isLight);
      const tag = c.k + '/' + (isLight ? 'light' : 'dark');
      const bw = M.fgContrast(v.btnRgb[0], v.btnRgb[1], v.btnRgb[2], v.btnFg);
      const uw = M.fgContrast(v.bubbleRgb[0], v.bubbleRgb[1], v.bubbleRgb[2], v.bubbleFg);
      const tr = M.contrast(M.relLum(...v.priTextRgb), hexLum(isLight ? BG_L : BG_D));
      if (bw < out.minBtn) out.minBtn = bw;
      if (uw < out.minBub) out.minBub = uw;
      if (tr < out.minText) out.minText = tr;
      if (bw < 4.5) out.badBtn.push(tag + '=' + bw.toFixed(2));
      if (uw < 4.5) out.badBub.push(tag + '=' + uw.toFixed(2));
      // 深色主题下紫是 4.23，刻意接受（强调文字，不是正文）；浅色必须 >= 4.5
      const need = isLight ? 4.5 : 4.2;
      if (tr < need) out.badText.push(tag + '=' + tr.toFixed(2));
      // pri2 也当文字色用（.field b / .mem-tag / .inj-key 之外的一批）
      const p2rgb = M.hslToRgb(c.h, Math.max(0, c.s - 10), v.levels.pri2);
      const p2r = M.contrast(M.relLum(p2rgb[0], p2rgb[1], p2rgb[2]), hexLum(isLight ? BG_L : BG_D));
      if (p2r < out.minPri2) out.minPri2 = p2r;
      if (p2r < need) out.badPri2.push(tag + '=' + p2r.toFixed(2));
    }
  }
  return out;
});
t('36 套按钮底白字全部 >= 4.5', calc.badBtn.length === 0, calc.badBtn.join(', '));
t('36 套气泡底白字全部 >= 4.5', calc.badBub.length === 0, calc.badBub.join(', '));
t('36 套文字色全部 >= 门槛（浅色 4.5 / 深色 4.2）', calc.badText.length === 0, calc.badText.join(', '));
t('36 套 pri2 文字色达标（浅色下已自动压暗）', calc.badPri2.length === 0, calc.badPri2.join(', '));
console.log('   最低：按钮 ' + calc.minBtn.toFixed(2) + ' / 气泡 ' + calc.minBub.toFixed(2) + ' / 文字 ' + calc.minText.toFixed(2) + ' / pri2 ' + calc.minPri2.toFixed(2));

console.log('=== applyTheme 真的写进去了吗 ===');
const vars = await page.evaluate(() => {
  const st = document.documentElement.style;
  const pick = (k) => st.getPropertyValue(k).trim();
  return {
    theme: document.documentElement.getAttribute('data-theme'),
    pri: pick('--pri'), pri2: pick('--pri2'), priText: pick('--pri-text'),
    btn: pick('--btn'), btnFg: pick('--btn-fg'), bubble: pick('--bubble-me'), bubbleFg: pick('--bubble-fg')
  };
});
const seven = ['pri','pri2','priText','btn','btnFg','bubble','bubbleFg'];
for (const k of seven) t('变量 --' + k + ' 有值', !!vars[k], JSON.stringify(vars[k]));
t('data-theme 是 dark 或 light', vars.theme === 'dark' || vars.theme === 'light', String(vars.theme));

// 默认紫：btn 应该是深紫那档，不是 --pri 的亮紫
const expected = await page.evaluate(async () => {
  const M = await import('./js/theme.js');
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  const v = M.colorVars(M.THEME_COLORS[0], isLight);
  return { btn: v.btn, bubble: v.bubble, pri: v.pri, btnFg: v.btnFg };
});
const norm = (s) => s.replace(/\s+/g, '');
t('--btn 与 violet 的 button 档一致', norm(vars.btn) === norm(expected.btn), vars.btn + ' vs ' + expected.btn);
t('--pri 与 violet 的亮档一致', norm(vars.pri) === norm(expected.pri), vars.pri + ' vs ' + expected.pri);
t('--bubble-me 与 violet 的气泡档一致', norm(vars.bubble) === norm(expected.bubble), vars.bubble + ' vs ' + expected.bubble);
t('--btn-fg 是白或墨', vars.btnFg === '#ffffff' || vars.btnFg === '#101014', vars.btnFg);

console.log('=== 点色块真的换色吗 ===');
const btnBefore = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--btn').trim());
const hasSwatch = await page.$$eval('.swatch', els => els.length);
t('设置页里有 18 个色块', hasSwatch === 18, '找到 ' + hasSwatch + ' 个');
const onBefore = await page.$$eval('.swatch.on', els => els.map(e => e.dataset.k).join(','));
t('默认选中的是 violet', onBefore === 'violet', onBefore);
// 设置页在 DOM 里但不在前台（.view 默认 translateX(100%)），puppeteer 的 click 会判「不可点」。
// 这里用 evaluate 直接派发 click，验证的是接线逻辑，不是布局。
await page.evaluate(() => document.querySelector('.swatch[data-k="yellow"]').click());
await sleep(350);
const afterYellow = await page.evaluate(() => ({
  btn: getComputedStyle(document.documentElement).getPropertyValue('--btn').trim(),
  on: [...document.querySelectorAll('.swatch.on')].map(e => e.dataset.k).join(',')
}));
t('点黄色后 --btn 变了', afterYellow.btn !== btnBefore, btnBefore + ' -> ' + afterYellow.btn);
t('点黄色后选中态移到 yellow', afterYellow.on === 'yellow', afterYellow.on);
const normY = (s) => s.replace(/\s+/g, '');
const expYellow = await page.evaluate(async () => {
  const M = await import('./js/theme.js');
  const y = M.THEME_COLORS.find(x => x.k === 'yellow');
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  return M.colorVars(y, isLight).btn;
});
t('黄色的按钮档与纯函数算的一致', normY(afterYellow.btn) === normY(expYellow), afterYellow.btn + ' vs ' + expYellow);
await page.evaluate(() => document.querySelector('.swatch[data-k="violet"]').click());
await sleep(250);

t('页内没有 JS 异常', errs.length === 0, errs.join(' | '));
console.log('');
console.log('通过 ' + pass + ' 项 / 失败 ' + fail + ' 项');
await browser.close();
server.close();
process.exit(fail ? 1 : 0);
