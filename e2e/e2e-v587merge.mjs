// e2e-v587merge.mjs — 0.5.8.7 合并酒馆三入口（预设并入「导入角色卡」）
//
// 这版唯一有逻辑的地方是 pickImportKind 的判种（十个分支，顺序有讲究）。
// 所以分两段：
//   ① 纯 Node 表驱动 —— charcard.js 顶层零 DOM，可以直接 import，秒级跑完
//   ② Puppeteer —— 真实文件上传，验四型各自的报告文案 + 「导一张卡只弹一条 toast」
import puppeteer from 'puppeteer-core';
import { seedChar } from './e2e-helper.mjs';
import http from 'http'; import fs from 'fs'; import path from 'path';
import { pickImportKind } from '../www/js/charcard.js';

const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');
const WWW = R + '/www';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const t = (n, ok, ex='') => { if (ok) { pass++; console.log('  OK   ' + n); } else { fail++; console.log('  FAIL ' + n + (ex ? '  -> ' + ex : '')); } };

console.log('');
console.log('=== 1. 判种表（纯 Node，import 的是真函数）===');
{
  const cases = [
    ['真预设', { prompts: [{ content: 'x' }] }, 'preset'],
    ['带 name + description 的预设（顺序回归：预设必须排在卡前面）', { name: '我的预设', description: 'd', prompts: [{ content: 'x' }] }, 'preset'],
    ['空 prompts 数组 → unknown（和 describeStPreset 的 length 判据对齐）', { name: 'x', prompts: [] }, 'unknown'],
    ['只有正则的预设', { extensions: { regex_scripts: [{ findRegex: 'a' }] } }, 'preset'],
    ['V2 卡', { spec: 'chara_card_v2', data: { name: 'F' } }, 'card'],
    ['V1 卡', { name: 'F', description: 'd' }, 'card'],
    ['TavernAI 老卡', { char_name: 'F', char_persona: 'p' }, 'card'],
    ['备份 {characters}', { characters: [] }, 'backup'],
    ['备份 {kind:worldbook, groups}', { kind: 'worldbook', groups: [] }, 'backup'],
    ['酒馆世界书 {entries:{0:…}}', { entries: { 0: { key: ['a'] } } }, 'worldbook'],
    ['世界书裸数组 [{key,content}]', [{ key: ['a'], content: 'x' }], 'worldbook'],
    ['聊天记录对象 {messages}', { messages: [{ mes: 'x' }] }, 'chat'],
    ['聊天记录数组 [{mes}]', [{ name: 'u', mes: 'x' }], 'chat'],
    ['空数组', [], 'chat'],
    ['null', null, 'unknown'],
    ['数字', 5, 'unknown'],
    ['字符串', 'abc', 'unknown'],
    ['空对象', {}, 'unknown'],
    ['{hello:world}', { hello: 'world' }, 'unknown'],
  ];
  for (const [n, data, want] of cases) {
    const got = pickImportKind(data);
    t(n + ' -> ' + want, got === want, 'got=' + got);
  }
  // 这一条是给「数组天生带 Array.prototype.entries」那个坑留的：
  // 只要有人把 data.entries 的判断挪到 Array.isArray 前面，聊天记录数组就会被判成世界书。
  t('数组的判种不能假命中 Array.prototype.entries',
    pickImportKind([{ name: 'u', mes: 'x' }]) === 'chat'
    && pickImportKind([{ key: ['a'] }]) === 'worldbook');
}

console.log('');
console.log('=== 2. 设置页结构 ===');
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

await page.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'networkidle0', timeout: 40000 });
await sleep(1200);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil: 'networkidle0' }); await sleep(900);
await seedChar(page, '阿紫', { greeting: '（开场）' });
await page.reload({ waitUntil: 'networkidle0' }); await sleep(900);

// 记下每一次 toast 的文本。#toast 是【同一个元素】改 textContent（app.js:663），
// 所以双 toast 的表现是"后一条直接覆盖前一条"——只能靠监听子节点变化抓。
await page.evaluate(() => {
  window.__toastLog = [];
  const el = document.getElementById('toast');
  if (!el) return;
  new MutationObserver(() => {
    const s = el.textContent;
    if (s && window.__toastLog[window.__toastLog.length - 1] !== s) window.__toastLog.push(s);
  }).observe(el, { childList: true, characterData: true, subtree: true });
});
const toastLog = () => page.evaluate(() => (window.__toastLog || []).slice());

const goMine = async () => {
  await page.evaluate(() => document.getElementById('btn-settings').click()); await sleep(600);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('#drawer-menu [data-wb-drawer]')].find(x => x.dataset.wbDrawer === 'mine');
    if (b) b.click();
  }); await sleep(700);
};
await goMine();

t('「酒馆」折叠头没了', (await page.$$eval('#view-mine #tavern-fold', els => els.length)) === 0);
t('「酒馆」折叠体也没了', (await page.$$eval('#view-mine #tavern-wrap', els => els.length)) === 0);
t('「导入酒馆预设 JSON」按钮没了', (await page.$$eval('#btn-preset-import', els => els.length)) === 0);
t('旧预设文件框没了', (await page.$$eval('#preset-import-file', els => els.length)) === 0);
t('「导入角色卡」还在，且是唯一入口', (await page.$$eval('#view-mine #btn-cc-import', els => els.length)) === 1);
t('报告区搬到了角色卡区，且只有一个', (await page.$$eval('#view-mine #preset-report', els => els.length)) === 1);
t('「酒馆正则」跟着角色卡走', (await page.$$eval('#view-mine #stregex-list', els => els.length)) === 1);
t('聊天记录入口归到数据区', (await page.$$eval('#view-mine #data-sec #btn-stchat-import', els => els.length)) === 1);
t('聊天记录的文件框和报告区也在数据区',
  (await page.$$eval('#view-mine #data-sec #stchat-file', els => els.length)) === 1
  && (await page.$$eval('#view-mine #data-sec #stchat-report', els => els.length)) === 1);
{
  // 「导入酒馆聊天记录」是加法，「导入数据」是整机覆盖（能换掉全部角色和聊天）——
  // 中间必须隔着「导出全部数据」。这条顺序是这版的核心约束，钉死。
  const ids = await page.$$eval('#data-sec button', els => els.map(e => e.id));
  console.log('   数据区按钮: ' + JSON.stringify(ids));
  const iChat = ids.indexOf('btn-stchat-import'), iExp = ids.indexOf('btn-export'), iImp = ids.indexOf('btn-import');
  t('聊天记录入口在「导出全部数据」之前', iChat >= 0 && iExp >= 0 && iChat < iExp);
  t('「导出全部数据」在「导入数据」之前（加法不紧挨着整机覆盖）', iExp >= 0 && iImp >= 0 && iExp < iImp);
}
t('「角色卡 实验」标题没被改动', (await page.$$eval('#view-mine .group h3', els => els.map(e => e.textContent.trim()))).includes('角色卡 实验'));

console.log('');
console.log('=== 3. 五种文件各传一次 ===');
const tmp = (name, obj) => {
  const p = R + '/_fixtures/_tmp_v587_' + name + '.json';
  fs.writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj), 'utf8');
  return p;
};
const upload = async (file) => {
  const inp = await page.$('#cc-import-file');
  await inp.uploadFile(file);
  await sleep(1300);
  return page.$eval('#preset-report', e => e.textContent).catch(() => '');
};
const report = (s) => s.replace(/\s+/g, '');

{
  const f = tmp('backup', { characters: [], groups: [], solo: [] });
  const rep = await upload(f);
  console.log('   备份报告: ' + JSON.stringify(rep.slice(0, 90)));
  t('备份 → 指路「导入数据」', report(rep).includes('导入数据'));
  t('备份 → 说清了它不是角色卡', report(rep).includes('备份'));
  fs.rmSync(f, { force: true });
}
{
  const f = tmp('wb', { entries: { 0: { key: ['a'], content: 'x' } } });
  const rep = await upload(f);
  console.log('   世界书报告: ' + JSON.stringify(rep.slice(0, 90)));
  t('独立世界书 → 指路「世界书」页', report(rep).includes('世界书页') || report(rep).includes('「世界书」页'));
  t('独立世界书 → 说清了卡自带的跟着卡走', report(rep).includes('跟着'));
  fs.rmSync(f, { force: true });
}
{
  const f = tmp('chat', { messages: [{ mes: 'hi' }] });
  const rep = await upload(f);
  console.log('   聊天记录报告: ' + JSON.stringify(rep.slice(0, 90)));
  t('聊天记录 → 指路「数据」里的聊天记录入口', report(rep).includes('聊天记录'));
  fs.rmSync(f, { force: true });
}
{
  const f = tmp('unknown', { hello: 'world' });
  const rep = await upload(f);
  console.log('   不认识报告: ' + JSON.stringify(rep.slice(0, 90)));
  // 用户点的是「导入角色卡」，回他「这不是酒馆预设」是答非所问
  t('不认识 → 说「认不出」，不说「这不是酒馆预设」', report(rep).includes('认不出'));
  t('不认识 → 列出了这个入口收什么', report(rep).includes('角色卡') && report(rep).includes('预设'));
  fs.rmSync(f, { force: true });
}
{
  const before = (await toastLog()).length;
  const charsBefore = await page.evaluate(async () => {
    const o = indexedDB.open('ai-companion');
    const db = await new Promise(r => o.onsuccess = () => r(o.result));
    const n = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').count(); q.onsuccess = () => r(q.result); });
    db.close(); return n;
  });
  const f = tmp('card', { spec: 'chara_card_v2', data: { name: '合并测试卡', description: '她是谁' } });
  const rep = await upload(f);
  console.log('   角色卡报告: ' + JSON.stringify(rep.slice(0, 90)));
  t('角色卡 → 报告说「已作为新角色导入」', report(rep).includes('新角色'));
  const charsAfter = await page.evaluate(async () => {
    const o = indexedDB.open('ai-companion');
    const db = await new Promise(r => o.onsuccess = () => r(o.result));
    const n = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').count(); q.onsuccess = () => r(q.result); });
    db.close(); return n;
  });
  t('角色卡 → 真的建出了新角色', charsAfter === charsBefore + 1, charsBefore + ' -> ' + charsAfter);
  const logs = (await toastLog()).slice(before);
  console.log('   这次新增的 toast: ' + JSON.stringify(logs));
  t('导一张卡只弹一条 toast（防「外层再 toast 一次」的回归）', logs.length === 1, JSON.stringify(logs));
  t('那一条是 importCharacterCard 自己弹的（带「已导入」）', logs.length === 1 && logs[0].includes('已导入'), JSON.stringify(logs));
  fs.rmSync(f, { force: true });
}

console.log('');
console.log('  JS 错误: ' + (errs.length ? JSON.stringify(errs.slice(0, 3)) : '无'));
t('无 JS 错误', errs.length === 0, errs.join(' | '));

await browser.close();
server.close();
console.log('');
console.log('========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
