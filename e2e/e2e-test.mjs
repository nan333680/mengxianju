
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
const OUT = `${R}/e2e`;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const API_KEY = process.env.DSH_API_KEY || 'sk-test';

const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.png':'image/png' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const f = path.join(WWW, p);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
  res.end(fs.readFileSync(f));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']
});
const page = await browser.newPage();
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

const fails404 = [];
page.on('response', r => { if (r.status() === 404) fails404.push(r.url()); });
const pageErrs = [];
page.on('pageerror', e => pageErrs.push(e.message));

let pass = 0, fail = 0;
const t = (n, ok, ex='') => { if (ok) { pass++; console.log('  OK   ' + n); } else { fail++; console.log('  FAIL ' + n + (ex?'  -> '+ex:'')); } };

await page.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'networkidle0', timeout: 40000 });
await new Promise(r => setTimeout(r, 1500));

// 建一个带开场白的角色（原来靠环境里残留的角色，换环境就挂）
await seedChar(page, '测试角色', { greeting: '（抬眼看了看你）……嗯，来了。' });
await page.reload({ waitUntil: 'networkidle0' });
await sleep(400)   // [提速] 原 1800：探针实测 reload 后 app 就绪只要 ~1ms;
await page.evaluate(() => {
  const c = [...document.querySelectorAll('#char-list .char-card')]
    .find(x => x.textContent.includes('测试角色'));
  if (c) c.click();
});
await new Promise(r => setTimeout(r, 1500));

// 填 Key
await tap(page, '#btn-settings');
await new Promise(r => setTimeout(r, 800));
// v1.15.2 起 ⚙ 拉开抽屉，设置页要从抽屉里的「全部设置」进
await page.evaluate(() => {
  const b = [...document.querySelectorAll('#drawer-menu [data-wb-drawer]')].find(x => x.dataset.wbDrawer === 'settings');
  if (b) b.click();
});
await new Promise(r => setTimeout(r, 500));
await page.$eval('#s-apikey', (el,k) => { el.value = k; el.dispatchEvent(new Event('change',{bubbles:true})); }, API_KEY);
await tap(page, '#btn-set-back');
await new Promise(r => setTimeout(r, 500));

console.log('=== 发消息并等待「生成真正结束」 ===');
await tap(page, '#input');
await page.type('#input', '你好呀，我今天有点累', { delay: 15 });
const t0 = Date.now();
// ⚠️ 必须用 evaluate 点击，不能用 page.click()。
// page.click 走真实鼠标事件，要求元素在视口内且没被遮挡；
// 这个布局下点击会静默落空（不报错、不发消息），测试却以为发过了。
// 血泪第 9 条记的就是这个坑。实测：page.click → msg=1；evaluate 点击 → msg=3。
await page.evaluate(() => document.getElementById('btn-send').click());

// 等生成真正结束。
// ⚠️ 不能写 "点完立刻查 #btn-stop 是否隐藏" —— 点击返回时按钮还没显示出来，
// 第一次轮询会误判成"已结束"（实测 0.4s），后面断言读到空回复。
// 统一用 waitIdle：先等按钮出现，再等它消失。
// 阶段一：等【首字】出现。
// ⚠️ 不能等到"停止按钮出现"就退出 —— 按钮几乎是瞬间出现的，
// 而首字要等模型吐第一个 chunk（真实 API 约 1~3 秒）。
// 早退会让 firstChunkAt 永远是 null，报出 "首字延迟 nullms" 这种假失败。
// 这一阶段同时兼顾"确认请求真的发出去了"：8 秒内首字和按钮都没动 = 没发出去。
let done = false, firstChunkAt = null, _st = false;
{
  const startedAt = Date.now();
  while (Date.now() - startedAt < 20000) {
    const shown = await page.$eval('#btn-stop', el => !el.classList.contains('hidden')).catch(() => false);
    if (shown) _st = true;
    const cur = await page.$$eval('.msg.ai .bub', els => els.length ? els[els.length-1].textContent.trim() : '');
    // ⚠️ 拿到首字就 break，但【不能假设此刻 _st 已经是 true】（2026-08-28 修）。
    //
    // 这是一个"越快越容易挂"的反向竞态：
    //   实测网络快的时候首字 2.3s 就到了，而 #btn-stop 可能还没被这一圈查到 ——
    //   于是 _st 仍是 false，break 出去后 `if (_st)` 不成立，
    //   done 永远是 false，断言报「生成正常结束」失败 ——
    //   可她的回复明明是完整的（截图和气泡内容都正常）。
    //   网络慢的时候反而没事：首字要 3~5s，中间转好几圈，_st 早被置 true 了。
    //
    // 所以这里不看 _st 了：只要首字出现过，就说明请求确实发出去了、
    // 流已经开始了，直接进 waitIdle 等它收尾。
    if (!firstChunkAt && cur && cur !== '…' && cur.length > 1) { firstChunkAt = Date.now() - t0; break; }
    if (!shown && _st) break;   // 按钮出现过又消失，说明已经结束
    await new Promise(r => setTimeout(r, 120));
  }
  // 首字出现过 || 停止按钮出现过 —— 两者任一都足以说明"这一轮真的开始了"。
  if (firstChunkAt || _st) {
    const r = await waitIdle(page, 1, 120000);   // 已经开始了，只等结束
    done = r.ended;
  }
}
const total = ((Date.now() - t0)/1000).toFixed(1);
t('生成正常结束', done, '总耗时 ' + total + 's');
console.log('  首字延迟约: ' + (firstChunkAt ? (firstChunkAt/1000).toFixed(1) + 's' : '未捕获'));
console.log('  总耗时: ' + total + 's');

const all = await page.$$eval('.msg .bub', els => els.map(e => e.textContent.trim()));
const aiMsg = all[all.length-1];
console.log('');
console.log('  她的回复全文:');
console.log('  ' + aiMsg);
console.log('');
t('AI 回复非空', aiMsg.length > 3, JSON.stringify(aiMsg));
t('回复不是占位符', aiMsg !== '……');
t('首字延迟可接受(<8s)', firstChunkAt !== null && firstChunkAt < 8000, firstChunkAt + 'ms');

await page.screenshot({ path: OUT + '/08-完整回复.png' });

console.log('');
console.log('=== 再发一条，测颜文字是否自然 ===');
await tap(page, '#input');
await page.type('#input', '今天遇到点麻烦事，心里不太舒服', { delay: 15 });
// ⚠️ 必须用 evaluate 点击，不能用 page.click()。
// page.click 走真实鼠标事件，要求元素在视口内且没被遮挡；
// 这个布局下点击会静默落空（不报错、不发消息），测试却以为发过了。
// 血泪第 9 条记的就是这个坑。实测：page.click → msg=1；evaluate 点击 → msg=3。
await page.evaluate(() => document.getElementById('btn-send').click());
await waitIdle(page);   // 先等开始，再等结束（见 e2e-helper.mjs 的说明）
const all2 = await page.$$eval('.msg .bub', els => els.map(e => e.textContent.trim()));
console.log('  第三条回复: ' + all2[all2.length-1]);
await page.screenshot({ path: OUT + '/09-多轮对话.png' });

console.log('');
console.log('=== 持久化检查 ===');
await page.reload({ waitUntil: 'networkidle0' });
await sleep(400)   // [提速] 原 1800：探针实测 reload 后 app 就绪只要 ~1ms;
const n3 = await page.$$eval('.msg .bub', els => els.length);
t('刷新后记录完整保留', n3 >= 5, '消息数=' + n3);

if (fails404.length) {
  console.log('');
  console.log('=== 404 资源 ===');
  [...new Set(fails404)].forEach(u => console.log('  ' + u));
}
t('无 JS 运行错误', pageErrs.length === 0, pageErrs.join(' | '));

console.log('');
console.log('========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');

await browser.close();
server.close();
process.exit(fail > 0 ? 1 : 0);
