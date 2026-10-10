import puppeteer from 'puppeteer-core';
import { seedChar } from './e2e-helper.mjs';
import http from 'http'; import fs from 'fs'; import path from 'path';
// 工作目录自适应（原来写死 C:/A-DSH-Tool/ai-companion）
const R = path.resolve(import.meta.dirname).split(path.sep).join('/');
const WWW = `${R}/www`;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8' };
const server = http.createServer((req,res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p==='/') p='/index.html';
  const f = path.join(WWW, p);
  if (!fs.existsSync(f)) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f));
});
await new Promise(r => server.listen(0,'127.0.0.1',r));
const port = server.address().port;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, timeout: 60000, args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = []; page.on('pageerror', e => errs.push(e.message));
const sleep = ms => new Promise(r=>setTimeout(r,ms));
let pass=0, fail=0;
const t=(n,ok,ex='')=>{if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));}};
await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
await sleep(1500);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil:'networkidle0' }); await sleep(400)   // [提速] 原 1800：探针实测 reload 后 app 就绪只要 ~1ms;
const cid = await seedChar(page, '强制聊天测试', { greeting:'（开场）', povLock: false, thinkMode: false });
await page.reload({ waitUntil:'networkidle0' }); await sleep(400)   // [提速] 原 2000：探针实测 reload 后 app 就绪只要 ~1ms;

console.log('=== 1. UI 有开关，默认关 ===');
await page.click('#btn-chars'); await sleep(700);
await page.evaluate(() => {
  const c = [...document.querySelectorAll('#char-list .char-card')].find(x => x.textContent.includes('强制聊天测试'));
  if (c) { const b = c.querySelector('[data-edit]'); if (b) b.click(); }
});
await sleep(1300);
const ui0 = await page.evaluate(() => {
  const el = document.getElementById('e-think');
  if (!el) return null;
  const on = [...el.querySelectorAll('button,.seg-item,[data-v]')].find(b => b.classList.contains('on') || b.classList.contains('active'));
  return { exists: true, val: el.dataset.v, txt: el.textContent.trim().slice(0,20) };
});
console.log('   ' + JSON.stringify(ui0));
t('开关存在', ui0 && ui0.exists);
t('默认关（false）', ui0 && ui0.val === 'false', ui0 && ui0.val);
t('标签是「关/开」', ui0 && ui0.txt.includes('关'), ui0 && ui0.txt);

console.log('=== 2. 打开开关并保存 ===');
await page.evaluate(() => {
  // 点「开」
  const el = document.getElementById('e-think');
  const btns = [...el.querySelectorAll('button')];
  const openBtn = btns.find(b => b.textContent.includes('开'));
  if (openBtn) openBtn.click();
});
await sleep(400);
await page.evaluate(() => document.getElementById('btn-edit-save').click());
await sleep(1500);
const saved = await page.evaluate(async (id) => {
  const { chars } = await import('./js/db.js');
  const c = await chars.get(id);
  return c ? { think: c.thinkMode, pov: c.povLock } : null;
}, cid);
console.log('   ' + JSON.stringify(saved));
t('thinkMode 存成 true', saved && saved.think === true, JSON.stringify(saved));

console.log('=== 3. 提示词只在开着时注入 ===');
const promptTest = await page.evaluate(async () => {
  const { buildStablePrompt } = await import('./js/persona.js');
  const base = { persona:'你是紫。', descLevel:'mid', verbosity:'medium', kaomojiFreq:0.15, kaomojiStyle:'jp-soft', emojiFreq:0.1, splitMessages:false, hesitation:true, longMemory:true };
  const off = buildStablePrompt(base, { ...base, thinkMode: false });
  const on  = buildStablePrompt(base, { ...base, thinkMode: true });
  return {
    offHas: off.includes('# 关于括号'), onHas: on.includes('# 关于括号'),
    onText: on.slice(on.indexOf('# 关于括号'), on.indexOf('# 关于括号') + 200),
    cacheSame: (() => {
      const a = buildStablePrompt(base, { ...base, thinkMode: true });
      const b = buildStablePrompt(base, { ...base, thinkMode: true });
      return a === b;   // 同设置下两次生成必须逐字一致（缓存前提）
    })(),
  };
});
console.log('   ' + JSON.stringify({ offHas: promptTest.offHas, onHas: promptTest.onHas, cacheSame: promptTest.cacheSame }));
t('关着时不注入', promptTest.offHas === false);
t('开着时注入', promptTest.onHas === true);
t('同设置下两次生成一致（能命中缓存）', promptTest.cacheSame === true);
console.log('   注入内容: ' + promptTest.onText.replace(/\n/g,' | ').slice(0, 170));

console.log('=== 4. 关键点都在提示词里 ===');
const txt = promptTest.onText;
t('说明她听不见括号', /听不见|听不到/.test(txt), txt.slice(0,60));
t('说明只能靠观察', /样子|观察|看出/.test(txt), '');

console.log('=== 5. 关掉后恢复正常 ===');
await page.click('#btn-chars'); await sleep(700);
await page.evaluate(() => {
  const c = [...document.querySelectorAll('#char-list .char-card')].find(x => x.textContent.includes('强制聊天测试'));
  if (c) { const b = c.querySelector('[data-edit]'); if (b) b.click(); }
});
await sleep(1200);
await page.evaluate(() => {
  const btns = [...document.getElementById('e-think').querySelectorAll('button')];
  const offBtn = btns.find(b => b.textContent.includes('关'));
  if (offBtn) offBtn.click();
});
await sleep(400);
await page.evaluate(() => document.getElementById('btn-edit-save').click());
await sleep(1500);
const off = await page.evaluate(async (id) => {
  const { chars } = await import('./js/db.js');
  return (await chars.get(id)).thinkMode;
}, cid);
t('关掉后存成 false', off === false, String(off));

console.log('\nJS 错误: ' + (errs.length ? errs.join(' | ') : '无'));
t('无 JS 报错', errs.length === 0, errs.join(' | '));
console.log('\n结果: pass='+pass+' fail='+fail);
await browser.close(); server.close();
process.exit(fail?1:0);
