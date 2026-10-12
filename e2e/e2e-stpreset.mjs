// e2e-stpreset.mjs — 酒馆预设导入（v0.3.1，清单 2.2 的「中间态」）
//
// 这一步【只解析展示，不执行】。所以断言分两层：
//   ① 报告里真的列出了段数 / 正则条数 / 每条的 find-replace 与作用对象
//   ② 【什么都没被执行】—— 导入前后设置和消息逐字节一致
//      （预设里的正则会对提示词和显示做全局替换，本软件没有这个能力，也不该有）
import puppeteer from 'puppeteer-core';
import { seedChar } from './e2e-helper.mjs';
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

// 取一份「页面当前状态」的快照，用来证明导入没有动任何东西
const snapshot = () => page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => o.onsuccess = () => r(o.result));
  const get = (s) => new Promise(r => { const q = db.transaction(s).objectStore(s).getAll(); q.onsuccess = () => r(q.result || []); });
  const kvS = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get('settings'); q.onsuccess = () => r(q.result); });
  const msgs = await get('messages');
  db.close();
  return { settings: JSON.stringify((kvS && kvS.v) || {}),
           msgCount: msgs.length,
           msgText: msgs.map(m => (m.content || '')).join(String.fromCharCode(10)) };
});

await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
await sleep(1300);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil:'networkidle0' }); await sleep(900);
await seedChar(page, '紫', { greeting:'（开场）' });
await page.reload({ waitUntil:'networkidle0' }); await sleep(900);

console.log('=== 1. 导入酒馆预设：报告里列全了 ===');
{
  await page.evaluate(() => document.getElementById('btn-settings').click()); await sleep(700);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('#drawer-menu [data-wb-drawer]')].find(x => x.dataset.wbDrawer === 'settings');
    if (b) b.click();
  }); await sleep(900);
  const input = await page.$('#preset-import-file');
  t('设置页有预设导入入口', !!input);
  const before = await snapshot();
  await input.uploadFile(R + '/_fixtures/st-preset.json');
  await sleep(1600);
  const rep = await page.$eval('#preset-report', e => e.textContent).catch(() => '');
  console.log('   报告前 200 字: ' + JSON.stringify(rep.slice(0, 200)));
  t('报告非空', rep.length > 0);
  t('报了提示词段数 3', rep.includes('3'));
  t('报了正则条数 2', rep.includes('2'));
  t('列出了第一条规则的脚本名', rep.includes('去掉括号'));
  t('列出了第二条规则的脚本名', rep.includes('占位符换人'));
  t('列出了 find', rep.includes('findRegex') || rep.includes('（[^）]*）') || rep.includes('{{char}}'));
  t('列出了 replace', rep.includes('她'));
  t('标明了作用对象（只改显示 / 只改提示词）', rep.includes('只改') || rep.includes('都改'));
  // v0.4.0 起正则【真的能用了】（只作用于副本，存档原文不动），所以文案从
  // "本软件不执行这些正则"改成"可以收进来、逐条开关"。断言跟着改成新的实话。
  t('说清了这些正则可以收进来', rep.includes('收进来'));
  t('并且说清了只改副本（不动聊天记录）', rep.includes('提示词') && rep.includes('屏幕上的字'));
  t('列出了提示词段名', rep.includes('主提示') && rep.includes('破限段'));

  const after = await snapshot();
  t('导入没有改设置（逐字节相同）', before.settings === after.settings, 'len ' + before.settings.length + ' vs ' + after.settings.length);
  t('导入没有改消息', before.msgCount === after.msgCount && before.msgText === after.msgText);
}

console.log('');
console.log('=== 2. 不是预设的文件要说清楚 ===');
{
  fs.writeFileSync(R + '/_fixtures/_tmp-notpreset.json', JSON.stringify({ hello: 'world' }), 'utf8');
  const input = await page.$('#preset-import-file');
  await input.uploadFile(R + '/_fixtures/_tmp-notpreset.json');
  await sleep(1300);
  const rep = await page.$eval('#preset-report', e => e.textContent).catch(() => '');
  console.log('   报告: ' + JSON.stringify(rep.slice(0, 120)));
  t('给了明确原因（不是「未知错误」）', rep.includes('prompts') || rep.includes('不像是酒馆预设'), rep);
  fs.rmSync(R + '/_fixtures/_tmp-notpreset.json', { force: true });
}

console.log('');
console.log('=== 3. 坏 JSON 不崩 ===');
{
  fs.writeFileSync(R + '/_fixtures/_tmp-badjson.json', '{ not json', 'utf8');
  const input = await page.$('#preset-import-file');
  await input.uploadFile(R + '/_fixtures/_tmp-badjson.json');
  await sleep(1200);
  t('坏 JSON 之后页面还活着', await page.evaluate(() => !!document.getElementById('preset-import-file')));
  fs.rmSync(R + '/_fixtures/_tmp-badjson.json', { force: true });
}

console.log('');
console.log('  JS 错误: ' + (errs.length ? JSON.stringify(errs.slice(0,3)) : '无'));
t('无 JS 错误', errs.length === 0, errs.join(' | '));

console.log('');
console.log('========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close(); server.close();
process.exit(fail ? 1 : 0);