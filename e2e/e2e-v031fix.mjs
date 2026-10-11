// e2e-v031fix.mjs — v0.3.1 的两处「手感」修复
//   1) 空状态那句导航提示指的是右上角那个 ＋（原来写「右下角」），并且要能翻成英文
//   2) 「跟随系统」主题要当场跟着变（原来只在启动 / 改设置 / 退出设置页三个时刻重算）
import puppeteer from 'puppeteer-core';
import http from 'http'; import fs from 'fs'; import path from 'path';
const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');
const WWW = R + '/www';
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
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 120000, args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = []; page.on('pageerror', e => errs.push(e.message));
page.on('dialog', async d => { await d.accept(); });
const sleep = ms => new Promise(r=>setTimeout(r,ms));
let pass=0, fail=0;
const t=(n,ok,ex='')=>{ if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));} };

const patchSettings = (patch) => page.evaluate(async (p) => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => o.onsuccess = () => r(o.result));
  const cur = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get('settings'); q.onsuccess = () => r(q.result); });
  const v = Object.assign({}, (cur && cur.v) || {}, p);
  await new Promise(r => { const tx = db.transaction('kv','readwrite'); tx.objectStore('kv').put({ k:'settings', v }); tx.oncomplete = r; });
  db.close();
}, patch);

await page.goto('http://127.0.0.1:' + port + '/', { waitUntil:'networkidle0', timeout:40000 });
await sleep(1200);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil:'networkidle0' }); await sleep(1300);

console.log('=== 1. 空状态：文案说的位置就是那个 ＋ 的位置 ===');
{
  const txt = await page.$eval('.empty-chat', e => e.textContent).catch(() => '');
  console.log('   文案: ' + JSON.stringify(txt));
  t('空状态确实出现了', txt.length > 0);
  t('说的是「右上角」', txt.includes('右上角'), txt);
  t('不再出现「右下角」', !txt.includes('右下角'), txt);
  // ⚠️ 不能用 getBoundingClientRect 量：此时角色列表页是隐藏的 side view，
  //    量出来是负坐标（实测 center=-32）—— 那是在测隐藏元素，不是测产品。
  //    改用 DOM 结构判据：这个 ＋ 必须是角色列表页 topbar 的【最后一个】子元素，
  //    也就是行尾 = 右上角。
  const pos = await page.evaluate(() => {
    const b = document.getElementById('btn-new-char');
    if (!b) return null;
    const bar = b.closest('.topbar');
    if (!bar) return null;
    const kids = [...bar.children];
    return { isLast: kids[kids.length - 1] === b, view: (bar.parentElement || {}).id };
  });
  console.log('   ＋ 在 topbar 里的位置: ' + JSON.stringify(pos));
  t('那个 ＋ 在角色列表页 topbar 的行尾（= 右上角）',
    !!pos && pos.isLast === true && pos.view === 'view-chars');
}

console.log('');
console.log('=== 2. 英文界面下这一屏也要翻 ===');
{
  await patchSettings({ lang: 'en' });
  await page.reload({ waitUntil:'networkidle0' }); await sleep(1200);
  const txt = await page.$eval('.empty-chat', e => e.textContent).catch(() => '');
  console.log('   en 文案: ' + JSON.stringify(txt));
  t('空状态有英文（原来这里是硬拼中文，没走 tt()）', /No characters yet/.test(txt), txt);
  t('第二句也翻了', /top-right/i.test(txt), txt);
  await patchSettings({ lang: 'zh' });
}

console.log('');
console.log('=== 3. 「跟随系统」当场跟着变 ===');
{
  await page.emulateMediaFeatures([{ name:'prefers-color-scheme', value:'dark' }]);
  await patchSettings({ theme: 'system' });
  await page.reload({ waitUntil:'networkidle0' }); await sleep(1100);
  const d1 = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  console.log('   系统=深色 → data-theme=' + d1);
  t('跟随系统：初始是深色', d1 === 'dark', String(d1));

  await page.emulateMediaFeatures([{ name:'prefers-color-scheme', value:'light' }]);
  await sleep(700);
  const d2 = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  console.log('   切成浅色（不刷新、不进设置页）→ data-theme=' + d2);
  t('系统切浅色后界面当场跟着变', d2 === 'light', String(d2));

  await page.emulateMediaFeatures([{ name:'prefers-color-scheme', value:'dark' }]);
  await sleep(700);
  const d3 = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  t('切回深色同样跟着变', d3 === 'dark', String(d3));

  await patchSettings({ theme: 'dark' });
  await page.reload({ waitUntil:'networkidle0' }); await sleep(1000);
  await page.emulateMediaFeatures([{ name:'prefers-color-scheme', value:'light' }]);
  await sleep(700);
  const d4 = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  console.log('   选了具体主题（深色）后系统切浅色 → data-theme=' + d4);
  t('选了具体主题时，系统切不动它', d4 === 'dark', String(d4));
}

console.log('');
console.log('  JS 错误: ' + (errs.length ? JSON.stringify(errs.slice(0,3)) : '无'));
t('无 JS 错误', errs.length === 0, errs.join(' | '));

console.log('');
console.log('========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
