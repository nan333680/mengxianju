
import puppeteer from 'puppeteer-core';
import { seedChar, seedChars } from './e2e-helper.mjs';
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

// 拦截发往 DeepSeek 的请求，记录参数
await page.evaluateOnNewDocument(() => {
  window.__cap = [];
  const orig = window.fetch;
  window.fetch = function(...args) {
    try {
      const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url);
      if (url && url.includes('deepseek') && args[1] && args[1].body) {
        const b = JSON.parse(args[1].body);
        window.__cap.push({ model: b.model, temperature: b.temperature, reasoning_effort: b.reasoning_effort, max_tokens: b.max_tokens, stream: b.stream });
      }
    } catch(e) {}
    return orig.apply(this, args);
  };
});

const errs = [];
page.on('pageerror', e => errs.push(e.message));

let pass=0, fail=0;
const t=(n,ok,ex='')=>{ if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));} };

const setSlider = async (sel, val) => {
  await page.$eval(sel, (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, String(val));
};
const setCheck = async (sel, val) => {
  await page.$eval(sel, (el, v) => { el.checked = v; el.dispatchEvent(new Event('change', { bubbles: true })); }, val);
};
// 频率类控件 v0.4.1.7 起不是分段按钮了：右边一个"当前档位"的入口行，点开是五档弹窗。
const pickFreq = async (rowSel, label) => {
  await page.click(rowSel);
  await new Promise(r => setTimeout(r, 450));
  const ok = await page.evaluate((l) => {
    const x = [...document.querySelectorAll('#drive-list button')].find(y => (y.querySelector('b') || y).textContent.trim() === l);
    if (x) { x.click(); return true; }
    return false;
  }, label);
  await new Promise(r => setTimeout(r, 350));
  return ok;
};
const pickSeg = async (sel, label) => {
  await page.evaluate((s, l) => {
    const b = [...document.querySelectorAll(s + ' button')].find(x => x.textContent.trim() === l);
    if (b) b.click();
  }, sel, label);
};
const sendMsg = async (text) => {
  await page.click('#input');
  await page.type('#input', text, { delay: 8 });
  await page.click('#btn-send');
  for (let i = 0; i < 240; i++) {
    await new Promise(r => setTimeout(r, 400));
    const busy = await page.$eval('#btn-stop', el => !el.classList.contains('hidden'));
    if (!busy) break;
  }
};
const lastCap = () => page.evaluate(() => window.__cap[window.__cap.length - 1] || null);

await page.goto('http://127.0.0.1:' + port + '/', { waitUntil:'networkidle0', timeout:40000 });
await new Promise(r => setTimeout(r, 1600));

// 建一个角色（原来靠默认模板，模板删了要自己准备）
await seedChar(page, '键山雏', { greeting: '（她看了你一眼）你来了。' });
await page.reload({ waitUntil:'networkidle0' });
await sleep(400)   // [提速] 原 1800：探针实测 reload 后 app 就绪只要 ~1ms;
await page.click('#btn-chars');
await new Promise(r => setTimeout(r, 700));
await page.evaluate(() => {
  const c = [...document.querySelectorAll('#char-list .char-card')]
    .find(x => x.textContent.includes('键山雏'));
  if (c) c.click();
});
await new Promise(r => setTimeout(r, 1200));

// 填 Key
await page.click('#btn-settings');
await new Promise(r => setTimeout(r, 800));
// v1.15.2 起 ⚙ 拉开抽屉，设置页要从抽屉里的「全部设置」进
await page.evaluate(() => {
  const b = [...document.querySelectorAll('#drawer-menu [data-wb-drawer]')].find(x => x.dataset.wbDrawer === 'settings');
  if (b) b.click();
});
await new Promise(r => setTimeout(r, 500));
await page.$eval('#s-apikey',(el,k)=>{el.value=k;el.dispatchEvent(new Event('change',{bubbles:true}));},API_KEY);
await page.click('#btn-set-back');
await new Promise(r => setTimeout(r, 500));

console.log('=== 1. 角色编辑页是否出现完整参数入口 ===');
await page.click('#btn-chars');
await new Promise(r => setTimeout(r, 600));
// 按名字点编辑 —— 列表顺序不保证，别用第一个
await page.evaluate(() => {
  const c = [...document.querySelectorAll('#char-list .char-card')]
    .find(x => x.textContent.includes('键山雏'));
  if (c) { const b = c.querySelector('[data-edit]'); if (b) b.click(); }
});
await new Promise(r => setTimeout(r, 900));

for (const [id, name] of [['#e-temp','温度'],['#e-maxtok','最大长度'],['#e-reasoning','推理强度'],['#e-ctx','上下文轮数'],['#e-kao-freq','颜文字频率'],['#e-emoji','emoji频率'],['#e-split','分段发送'],['#e-longmem','长期记忆']]) {
  const ok = await page.$(id);
  t('角色编辑页有「' + name + '」', !!ok);
}
await page.screenshot({ path: OUT + '/20-角色参数.png' });

console.log('');
console.log('=== 2. 给键山雏设 温度0.5 / 颜文字关闭 ===');
await setSlider('#e-temp', 0.5);
await pickFreq('#e-kao-freq', '关闭');
await new Promise(r => setTimeout(r, 300));
await page.click('#btn-edit-save');
await new Promise(r => setTimeout(r, 1000));

await sendMsg('测试一下');
const c1 = await lastCap();
console.log('  捕获请求:', JSON.stringify(c1));
t('键山雏用了温度 0.5', c1 && Math.abs(c1.temperature - 0.5) < 0.001, c1 ? c1.temperature : 'null');

console.log('');
console.log('=== 3. 新建角色「测试乙」设 温度1.5 / 颜文字总是 ===');
await page.click('#btn-chars');
await new Promise(r => setTimeout(r, 600));
await page.click('#btn-new-char');
await new Promise(r => setTimeout(r, 700));
// 新建角色会先落到预设选择页，得挑一个才进编辑页（选「空白角色」自己填）
await page.evaluate(() => document.querySelector('#preset-list .char-card')?.click());
await new Promise(r => setTimeout(r, 800));
await page.$eval('#e-name', el => { el.value = '测试乙'; });
await setSlider('#e-temp', 1.5);
await pickFreq('#e-kao-freq', '总是');
await new Promise(r => setTimeout(r, 300));
await page.click('#btn-edit-save');
await new Promise(r => setTimeout(r, 1200));

const nameNow = await page.$eval('#chat-name', el => el.textContent.trim());
t('已切到新角色「测试乙」', nameNow === '测试乙', nameNow);

await sendMsg('再测一下');
const c2 = await lastCap();
console.log('  捕获请求:', JSON.stringify(c2));
t('测试乙用了温度 1.5', c2 && Math.abs(c2.temperature - 1.5) < 0.001, c2 ? c2.temperature : 'null');
t('两个角色温度确实不同', c1 && c2 && c1.temperature !== c2.temperature, 'A=' + (c1?c1.temperature:'?') + ' B=' + (c2?c2.temperature:'?'));

console.log('');
console.log('=== 4. 切回键山雏，参数应复原为 0.5 ===');
await page.click('#btn-chars');
await new Promise(r => setTimeout(r, 600));
// 点第一个卡片（键山雏）
await page.evaluate(() => {
  const cards = [...document.querySelectorAll('.char-card')];
  const c = cards.find(x => x.querySelector('.info b').textContent.trim() === '键山雏');
  if (c) c.click();
});
await new Promise(r => setTimeout(r, 900));
const backName = await page.$eval('#chat-name', el => el.textContent.trim());
t('已切回键山雏', backName === '键山雏', backName);

await page.click('#btn-chars');
await new Promise(r => setTimeout(r, 500));
await page.evaluate(() => {
  const cards = [...document.querySelectorAll('.char-card')];
  const c = cards.find(x => x.querySelector('.info b').textContent.trim() === '键山雏');
  const b = c.querySelector('.icon-btn[data-edit]');
  if (b) b.click();
});
await new Promise(r => setTimeout(r, 800));
const tempBack = await page.$eval('#e-temp', el => el.value);
t('编辑页显示键山雏自己的温度 0.5', Math.abs(Number(tempBack) - 0.5) < 0.001, tempBack);

const kaoOn = await page.$eval('#e-kao-freq-brief', el => el.textContent.trim());
t('颜文字频率显示「关闭」', kaoOn === '关闭', JSON.stringify(kaoOn));
await page.click('#btn-edit-back');
await new Promise(r => setTimeout(r, 700));

console.log('');
// 原来的第 5、6 段测的是「设置页里的全局统一开关」。v1.5.4.1 起那个开关已经从
// 设置页拿掉了，改成角色编辑页的「覆盖全局设定」——同一件事由 e2e-settings.mjs
// 负责（那里第 6 段专门验证广播给所有角色）。这里不再重复，免得测一个不存在的控件。

t('无 JS 错误', errs.length === 0, errs.slice(0,2).join(' | '));

console.log('');
console.log('========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close();
server.close();
process.exit(fail>0?1:0);
