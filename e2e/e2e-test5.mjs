
import puppeteer from 'puppeteer-core';
import { seedChar, seedChars, waitIdle , tap } from './e2e-helper.mjs';
import http from 'http';
import fs from 'fs';
import path from 'path';
// 工作目录自适应（原来写死 C:/A-DSH-Tool/ai-companion）
const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');

// [提速] 批量替换时统一用了 sleep(N) 写法，这里补上定义
const sleep = ms => new Promise(r => setTimeout(r, ms));


const WWW = `${R}/www`;

// 期望值直接从预设源码读，不再硬编码 —— 以前写死的 1.2/1.0 和预设里的
// 1.25/1.05 对不上（加上滑条 step 吸附），长期误报。
// 内置模板已删除（只留「空白角色」），这里改成直接给两个角色设不同的参数
const P_SUIKA = { temperature: 1.25, typingDelay: 1.0 };
const P_YUYU = { temperature: 1.05, typingDelay: 1.5 };
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
await page.evaluateOnNewDocument(() => {
  window.__cap = [];
  const orig = window.fetch;
  window.fetch = function(...args) {
    try {
      const url = typeof args[0]==='string'?args[0]:(args[0]&&args[0].url);
      if (url && url.includes('deepseek') && args[1] && args[1].body) {
        window.__cap.push(JSON.parse(args[1].body));
      }
    } catch(e){}
    return orig.apply(this, args);
  };
});
const errs = [];
page.on('pageerror', e => errs.push(e.message));

let pass=0, fail=0;
const t=(n,ok,ex='')=>{ if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));} };
const sendMsg = async (text) => {
  await tap(page, '#input');
  await page.type('#input', text, { delay: 8 });
  // ⚠️ 必须用 evaluate 点击，不能用 page.click()。
// page.click 走真实鼠标事件，要求元素在视口内且没被遮挡；
// 这个布局下点击会静默落空（不报错、不发消息），测试却以为发过了。
// 血泪第 9 条记的就是这个坑。实测：page.click → msg=1；evaluate 点击 → msg=3。
await page.evaluate(() => document.getElementById('btn-send').click());
  await waitIdle(page);   // 先等按钮出现、再等它消失
};
const lastCap = () => page.evaluate(() => window.__cap[window.__cap.length-1] || null);

await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
await new Promise(r=>setTimeout(r,1600));
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

console.log('=== 1. 点「＋」进预设选择页（现在只剩空白角色）===');
await tap(page, '#btn-chars');
await new Promise(r=>setTimeout(r,700));
await tap(page, '#btn-new-char');
await new Promise(r=>setTimeout(r,800));
const presetVisible = await page.$eval('#view-preset', el => el.classList.contains('active'));
t('点「＋」进入预设选择', presetVisible);

const names = await page.$$eval('#preset-list .char-card .info b', els => els.map(e=>e.textContent.trim()));
console.log('  预设列表:', JSON.stringify(names));
t('只剩 1 个预设（空白角色）', names.length === 1, names.length);
t('是「空白角色」', names.includes('空白角色'));
for (const n of ['键山雏','冴月麟','伊吹萃香','西行寺幽幽子']) {
  t('已删除「'+n+'」', !names.includes(n));
}

console.log('');
console.log('=== 2. 每个角色的参数互相独立（这是原来的核心价值）===');
// 建两个参数不同的角色，直接塞库
await seedChars(page, [
  { name: '萃香测试', extra: { temperature: 1.25, typingDelay: 1.0, verbosity: 'veryShort', splitMessages: true, kaomojiStyle: 'jp-cute', kaomojiFreq: 0.5 } },
  { name: '幽幽子测试', extra: { temperature: 1.05, typingDelay: 1.5, verbosity: 'long', splitMessages: false } }
]);
await page.reload({ waitUntil: 'networkidle0' });
await sleep(400)   // [提速] 原 1800：探针实测 reload 后 app 就绪只要 ~1ms;

// 选萃香
await tap(page, '#btn-chars');
await new Promise(r=>setTimeout(r,700));
await page.evaluate(() => {
  const c = [...document.querySelectorAll('#char-list .char-card')]
    .find(x => x.textContent.includes('萃香测试'));
  if (c) c.click();
});
await new Promise(r=>setTimeout(r,1200));
const cur = await page.$eval('#chat-name', el => el.textContent.trim());
t('已切到萃香测试', cur === '萃香测试', cur);

await sendMsg('你好呀');
const c = await lastCap();
console.log('  捕获:', JSON.stringify(c).slice(0,180));
t('请求温度 = ' + P_SUIKA.temperature, c && Math.abs(c.temperature-P_SUIKA.temperature) < 0.001, c?c.temperature:'null');

console.log('');
console.log('=== 3. 切到幽幽子，参数应各自独立 ===');
await tap(page, '#btn-chars');
await new Promise(r=>setTimeout(r,700));
await page.evaluate(() => {
  const el = [...document.querySelectorAll('#char-list .char-card')]
    .find(x => x.textContent.includes('幽幽子测试'));
  if (el) el.click();
});
await new Promise(r=>setTimeout(r,1200));
const cur2 = await page.$eval('#chat-name', el => el.textContent.trim());
t('已切到幽幽子测试', cur2 === '幽幽子测试', cur2);
await sendMsg('你好');
const c2 = await lastCap();
t('幽幽子请求温度 = ' + P_YUYU.temperature, c2 && Math.abs(c2.temperature-P_YUYU.temperature) < 0.001, c2?c2.temperature:'null');
t('两人温度确实不同', c && c2 && c.temperature !== c2.temperature);

console.log('');
console.log('=== 4. 编辑页读的也是各自的参数 ===');
await tap(page, '#btn-chars');
await new Promise(r=>setTimeout(r,700));
await page.evaluate(() => {
  const el = [...document.querySelectorAll('#char-list .char-card')]
    .find(x => x.textContent.includes('萃香测试'));
  if (el) { const b = el.querySelector('[data-edit]'); if (b) b.click(); }
});
await new Promise(r=>setTimeout(r,1200));
const tempInEdit = await page.$eval('#e-temp', el => el.value);
t('编辑页显示萃香自己的温度', Math.abs(Number(tempInEdit) - P_SUIKA.temperature) < 0.001, tempInEdit);
const verbInEdit = await page.$eval('#e-verbosity', el => el.value);
t('编辑页显示萃香自己的回复长度', verbInEdit === 'veryShort', verbInEdit);
await tap(page, '#btn-edit-back');
await new Promise(r=>setTimeout(r,600));

console.log('');
console.log('=== 5. 切回萃香，请求参数仍是它自己的 ===');
await tap(page, '#btn-chars');
await new Promise(r=>setTimeout(r,700));
await page.evaluate(() => {
  const el = [...document.querySelectorAll('#char-list .char-card')]
    .find(x => x.textContent.includes('萃香测试'));
  if (el) el.click();
});
await new Promise(r=>setTimeout(r,1200));
t('已切回萃香测试', (await page.$eval('#chat-name', el=>el.textContent.trim())) === '萃香测试');
await sendMsg('再聊一句');
const c3 = await lastCap();
t('萃香温度仍是 ' + P_SUIKA.temperature, c3 && Math.abs(c3.temperature-P_SUIKA.temperature) < 0.001, c3?c3.temperature:'null');

t('无 JS 错误', errs.length === 0, errs.slice(0,2).join(' | '));

console.log('');
console.log('========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close();
server.close();
process.exit(fail>0?1:0);
