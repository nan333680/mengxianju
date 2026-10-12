import puppeteer from 'puppeteer-core';
import { seedChar } from './e2e-helper.mjs';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { readCode } from './e2e-src.mjs';
// 工作目录自适应（原来写死 C:/A-DSH-Tool/ai-companion）
const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');

const WWW = `${R}/www`;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
// ⚠️ v1.21.40：产品默认 apiKey 已改成空串（预置的那把反编译就能拿走，已移除）。
// 本套件要真调模型，Key 只能自己给 —— 环境变量优先，没有就用占位符。
const KEY = process.env.DSH_API_KEY || 'sk-test';
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8' };
const server = http.createServer((req,res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p==='/') p='/index.html';
  const f = path.join(WWW, p);
  if (!fs.existsSync(f)) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f));
});
await new Promise(r => server.listen(0,'127.0.0.1',r));
const port = server.address().port;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = [];
page.on('pageerror', e => errs.push(e.message));
const sleep = ms => new Promise(r=>setTimeout(r,ms));
let pass=0, fail=0;
const t=(n,ok,ex='')=>{ if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));} };
// 「显示正在输入」现在收在「节奏与细节」折叠面板里，点它之前要先展开
const openMoreFold = async () => {
  await page.evaluate(() => {
    const w = document.getElementById('e-more-wrap');
    if (w && !w.classList.contains('open')) document.getElementById('e-more-fold').click();
  });
  await new Promise(r => setTimeout(r, 700));
};

// 把 DeepSeek 的流式响应吊住，好在"生成中"这一刻观察指示器
await page.setRequestInterception(true);
let heldRes = null;
page.on('request', req => {
  if (req.method() === 'OPTIONS') {
    req.respond({ status: 204, headers: {
      'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'*' } });
    return;
  }
  if (req.url().includes('/chat/completions')) { heldRes = req; return; }   // 吊住，不回
  req.continue();
});

await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
await sleep(1500);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil:'networkidle0' })
// v1.21.59：全新安装不再自动建角色（产品改空），测试自己塞一个
await seedChar(page, '测试角色', { greeting: '' });   // 空开场白：不额外多出一条消息
await page.reload({waitUntil:'networkidle0'}); await sleep(500);
// ⚠️ 把 Key 写进库再重载（v1.21.40）。
// 【读-改-写】而不是整表覆盖：settings 里还有 clockMode 等一堆字段，
// 整体替换会让 app 当成本机是"老数据升级"，把 clockMode 迁移成 false。
await page.evaluate(async (k) => {
  await new Promise((res) => {
    const o = indexedDB.open('ai-companion');
    o.onsuccess = () => {
      const db = o.result;
      const g = db.transaction('kv').objectStore('kv').get('settings');
      g.onsuccess = () => {
        const v = Object.assign({}, (g.result && g.result.v) || {}, { apiKey: k });
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put({ k: 'settings', v });
        tx.oncomplete = () => { db.close(); res(); };
      };
      g.onerror = () => { db.close(); res(); };
    };
    o.onerror = () => res();
  });
}, KEY);
await page.reload({ waitUntil:'networkidle0' }); await sleep(700);;
await sleep(400)   // [提速] 原 1800：探针实测 reload 后 app 就绪只要 ~1ms;

console.log('=== 1. 默认值：指示器开着 ===');
// app.js 是 ES module，内部常量在页面里够不到 —— 直接读源码验证默认值
const src = readCode(WWW + '/js/app.js');
t('DEFAULTS 里 showTyping 默认为 true', /showTyping:\s*true/.test(src));
t('showTyping 已进 CHAR_KEYS（角色可单独设）', /'showTyping'/.test(src));
t('占位气泡会读 showTyping 决定加不加 no-dots', /P\.showTyping === false \? ' no-dots'/.test(src));

console.log('');
console.log('=== 2. 编辑页有开关，且默认勾上 ===');
await page.click('#btn-chars'); await sleep(400);
await page.evaluate(() => document.querySelectorAll('#char-list .char-card button[data-edit]')[0].click());
await sleep(700);
t('编辑页存在「显示「正在输入」」勾选框', !!(await page.$('#e-showtyping')));
t('默认勾选（老数据也当成开着）', (await page.$eval('#e-showtyping', el => el.checked)) === true);

console.log('');
console.log('=== 3. 开关是角色级参数，能被「覆盖全局设定」广播 ===');
t('pickCharParams 会带上它（靠 CHAR_KEYS 遍历）', /for \(const k of CHAR_KEYS\) if \(s\[k\] !== undefined\) o\[k\] = s\[k\]/.test(src));

console.log('');
console.log('=== 4. 关掉并保存 → 落库到角色 ===');
await openMoreFold();
await page.click('#e-showtyping');            // 取消勾选
await sleep(200);
t('已取消勾选', (await page.$eval('#e-showtyping', el => el.checked)) === false);
await page.click('#btn-edit-save'); await sleep(1000);
const saved = await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const all = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').getAll(); q.onsuccess = () => r(q.result); });
  db.close();
  return all.map(c => ({ name: c.name, v: c.showTyping }));
});
console.log('   角色落库值: ' + JSON.stringify(saved));
t('被编辑的角色存成 false', saved.some(c => c.v === false));
t('库里只有这一个角色（清库后的正常状态）', saved.length === 1, '实际 ' + saved.length);

console.log('');
console.log('=== 4.5 保存后确认没有别的角色被误改 ===');
const cnt = await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const n = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').count(); q.onsuccess = () => r(q.result); });
  db.close(); return n;
});
t('角色数量正常', cnt >= 1, '实际 ' + cnt);

console.log('');
console.log('=== 5. 重开编辑页，勾选状态能读回来 ===');
// 列表顺序 = DB 顺序，先从 DB 找出被关掉的那个是第几个
await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const all = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').getAll(); q.onsuccess = () => r(q.result); });
  db.close();
  window.__idxOfOff = all.findIndex(c => c.showTyping === false);
});
await page.click('#btn-chars'); await sleep(400);
await page.evaluate(() => {
  const idx = window.__idxOfOff;
  document.querySelectorAll('#char-list .char-card button[data-edit]')[idx].click();
});
await sleep(700);
t('关掉的角色读回来是没勾', (await page.$eval('#e-showtyping', el => el.checked)) === false);

console.log('');
console.log('=== 6. 实测：关掉时占位气泡不闪 ===');
// 此刻停在编辑页（第 5 组打开的那个角色，showTyping=false），直接退回聊天
await page.click('#btn-edit-back'); await sleep(400);
await page.click('#btn-chars-back'); await sleep(400);
await page.type('#input', '测试一下');
await sleep(300);
await page.click('#btn-send');
await sleep(1200);
const off = await page.evaluate(() => {
  const bub = document.querySelector('#messages .msg.ai:last-child .bub');
  if (!bub) return null;
  return { hasDots: !!bub.querySelector('.typing-dots'), noDots: bub.classList.contains('no-dots') };
});
console.log('   关掉时: ' + JSON.stringify(off));
t('关掉时有占位气泡（还知道在等）', off !== null);
t('关掉时气泡带 no-dots 类', off && off.noDots === true);
await page.click('#btn-stop').catch(()=>{});
await sleep(600);

console.log('');
console.log('=== 7. 实测：打开时占位气泡会闪 ===');
await page.click('#btn-chars'); await sleep(400);
await page.evaluate(() => {
  const idx = window.__idxOfOff;
  document.querySelectorAll('#char-list .char-card button[data-edit]')[idx].click();
});
await sleep(700);
await openMoreFold();
await page.click('#e-showtyping');   // 勾回来
await sleep(200);
await page.click('#btn-edit-save'); await sleep(1000);   // 保存后会自动退回聊天页
await page.type('#input', '再测一次');
await sleep(300);
await page.click('#btn-send');
await sleep(1200);
const on = await page.evaluate(() => {
  const bub = document.querySelector('#messages .msg.ai:last-child .bub');
  if (!bub) return null;
  return { noDots: bub.classList.contains('no-dots'), dots: bub.querySelectorAll('.typing-dots i').length };
});
console.log('   打开时: ' + JSON.stringify(on));
t('打开时占位气泡不带 no-dots', on && on.noDots === false);
t('打开时三个点都在（会动）', on && on.dots === 3);
const anim = await page.evaluate(() => {
  const i = document.querySelector('#messages .msg.ai:last-child .typing-dots i');
  return i ? getComputedStyle(i).animationName : null;
});
t('点上有动画（真的在动，不是装饰）', anim === 'typingBounce', String(anim));
await page.click('#btn-stop').catch(()=>{});
await sleep(600);

console.log('');
console.log('=== 8. 数据兼容：没有 showTyping 的老角色按开启算 ===');
const old = await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const all = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').getAll(); q.onsuccess = () => r(q.result); });
  const c = all[0];
  delete c.showTyping;
  await new Promise(r => { const q = db.transaction('characters','readwrite').objectStore('characters').put(c); q.onsuccess = () => r(); });
  db.close();
  return true;
});
t('已构造一条缺 showTyping 的老数据', old === true);
// 删掉字符后重新选一次角色，看编辑页是否把它当成「开着」
await page.click('#btn-chars-back').catch(()=>{});
await sleep(300);
await page.click('#btn-chars').catch(()=>{});
await sleep(400);
await page.evaluate(() => document.querySelectorAll('#char-list .char-card button[data-edit]')[0].click());
await sleep(700);
t('老角色打开编辑页时勾选框是勾上的', (await page.$eval('#e-showtyping', el => el.checked)) === true);

console.log('');
if (errs.length) console.log('  JS 错误: ' + JSON.stringify(errs));
t('全程无 JS 错误', errs.length === 0, errs.join(' | '));

console.log('');
console.log('========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close();
server.close();
process.exit(fail ? 1 : 0);
