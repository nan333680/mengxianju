// v1.21.49 回归：叙事视角四档 / 续写 / 导出 Markdown / 表达预设
//
// 为什么必须有一套：这几件事都是「点了看起来有反应」的类型 ——
// 视角档位改的是 prompt（界面完全看不出来对不对），导出是拼字符串
// （少一段、时间分组错位都很难肉眼发现），续写更容易被当成「按钮坏了」。
//
// 本套不外网：续写只验证「它不写用户消息、输入框不动」，不真的等模型回。
import puppeteer from 'puppeteer-core';
import { seedChar } from './e2e-helper.mjs';
import { buildChatMarkdown, markdownFileName, dayText } from './www/js/exportmd.js';
import http from 'http';
import fs from 'fs';
import path from 'path';

const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');
const WWW = `${R}/www`;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
};

// ── 1. 纯函数：Markdown 拼装（不启浏览器，先把最容易错的这段钉死）──
console.log('\n【1】导出 Markdown 的拼装');
const msgs1 = [
  { role: 'assistant', content: '（抬头看你）你来了。', story: { day: 3, phase: 'afternoon', hour: null, minute: 0 }, ts: 1 },
  { role: 'user', content: '嗯。', story: { day: 3, phase: 'afternoon', hour: null, minute: 0 }, ts: 2 },
  { role: 'assistant', content: '第二天的第一句。', story: { day: 4, phase: 'morning', hour: null, minute: 0 }, ts: 3 },
  { role: 'assistant', content: '带图的。', images: ['data:image/png;base64,AAA'], imageNotes: ['这是猫'], story: { day: 4, phase: 'morning', hour: null, minute: 0 }, ts: 4 },
  { role: 'user', content: '归档过的。', story: { day: 5, phase: 'night', hour: null, minute: 0 }, ts: 5, archived: true },
];
const md = buildChatMarkdown({ char: { name: '小恶魔' }, messages: msgs1, now: Date.UTC(2026, 9, 8, 5, 30) });
ok('标题带角色名', md.indexOf('# 小恶魔 · 对话记录') === 0, md.slice(0, 40));
ok('统计里写了总条数 5', md.indexOf('消息：5 条') >= 0, md.split('\n')[3]);
ok('统计里点出已归档 1 条', md.indexOf('已归档 1 条') >= 0);
ok('剧情时间范围写出来了', md.indexOf('第 3 天 · 下午') >= 0 && md.indexOf('第 5 天 · 晚上') >= 0);
ok('换剧情时间就开新小节', (md.match(/^## /gm) || []).length === 3, (md.match(/^## .*/gm) || []));
ok('说话人按「她 / 我」标', md.indexOf('**小恶魔**') >= 0 && md.indexOf('**我**') >= 0);
ok('正文原样保留（含括号动作）', md.indexOf('（抬头看你）你来了。') >= 0);
ok('图片只留占位，不塞 dataURL', md.indexOf('［图片：这是猫］') >= 0 && md.indexOf('base64') < 0);
ok('归档那条也导出了，并带标记', md.indexOf('（已归档）') >= 0 && md.indexOf('归档过的。') >= 0);
ok('空对话不会崩', buildChatMarkdown({ char: { name: 'A' }, messages: [] }).indexOf('还没有聊天记录') >= 0);
ok('messages 传 undefined 也不崩', typeof buildChatMarkdown({ char: { name: 'A' } }) === 'string');
ok('没有 story 的老消息不分节但正文在', buildChatMarkdown({ char: { name: 'A' }, messages: [{ role: 'user', content: '老消息' }] }).indexOf('老消息') >= 0);
ok('文件名里没有路径字符', !/[\\/:*?"<>|]/.test(markdownFileName('a/b:c*d?e')), markdownFileName('a/b:c*d?e'));
ok('文件名以 .md 结尾', markdownFileName('小恶魔').endsWith('.md'), markdownFileName('小恶魔'));
ok('第 400 天显示成第 2 年 35 天', dayText(400) === '第 2 年 35 天', dayText(400));

// ── 2. 界面：视角四档 / 续写按钮 / 导出按钮 / 表达预设 ──
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
const jsErrs = [];
page.on('pageerror', e => jsErrs.push(String((e && e.message) || e)));
const clickIt = async (sel) => {
  await page.waitForSelector(sel, { timeout: 8000 });
  return await page.evaluate(s => { const el = document.querySelector(s); if (!el) return false; el.click(); return true; }, sel);
};
/**
 * 进某个角色的聊天页。
 * ⚠️ 必须【按名字】点卡片，不能点 `#char-list .char-card`（第一个）。
 * 起因：app 启动时 ensureChar() 会自动建一个「空白角色」并选中它，
 * 于是「第一个卡片」永远是它 —— 测试改的是空白角色、断言查的是自己 seed 的那个，
 * 结果看起来像「保存没生效」：实测库里有两条角色，povStyle 落在空白角色身上。
 */
const openChar = async (name) => {
  await clickIt('#btn-chars'); await sleep(700);
  const hit = await page.evaluate(n => {
    const c = [...document.querySelectorAll('#char-list .char-card')].find(x => x.textContent.includes(n));
    if (!c) return false;
    c.click(); return true;
  }, name);
  await sleep(900);
  return hit;
};

await page.goto('http://127.0.0.1:' + port + '/', { waitUntil:'networkidle0', timeout:40000 });
await sleep(1300);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await sleep(600);
await page.reload({ waitUntil:'networkidle0' });
await sleep(1400);
await seedChar(page, '视角测试', { greeting: '（她抬头）', povLock: true });
await page.reload({ waitUntil:'networkidle0' });
await sleep(1400);
ok('能进到刚建的角色', await openChar('视角测试'));

console.log('\n【2】角色编辑页：老数据读成 L1');
await clickIt('#chat-titletxt'); await sleep(900);
const pov = await page.evaluate(() => ({
  btns: [...document.querySelectorAll('#e-pov button')].map(b => b.textContent.trim()),
  on: [...document.querySelectorAll('#e-pov button')].filter(b => b.classList.contains('on')).map(b => b.textContent.trim()),
  note: (document.getElementById('e-pov-note') || {}).textContent,
}));
ok('视角五档都在（关 + L1~L4）', JSON.stringify(pov.btns) === JSON.stringify(['关','L1','L2','L3','L4']), pov.btns);
ok('老角色 povLock=true 读成 L1（不是「关」）', pov.on.length === 1 && pov.on[0] === 'L1', pov.on);
ok('L1 的说明写的是「她的眼睛」', String(pov.note).indexOf('她的眼睛') >= 0, pov.note);

console.log('\n【3】点 L3，说明行和存档位都跟着走');
await page.evaluate(() => { const b = [...document.querySelectorAll('#e-pov button')].find(x => x.textContent.trim() === 'L3'); b.click(); });
await sleep(400);
const l3 = await page.evaluate(() => ({
  note: document.getElementById('e-pov-note').textContent,
  on: [...document.querySelectorAll('#e-pov button')].filter(b => b.classList.contains('on')).map(b => b.textContent.trim()),
  ds: document.getElementById('e-pov').dataset.v,
}));
ok('高亮换成 L3', l3.on.length === 1 && l3.on[0] === 'L3', l3.on);
ok('dataset.v 跟着变成 L3', l3.ds === 'L3', l3.ds);
ok('说明行换成第三人称那段', String(l3.note).indexOf('第三人称') >= 0, l3.note);

console.log('\n【4】表达预设：点「作家」把几项一次填好');
await page.evaluate(() => { const b = [...document.querySelectorAll('#e-mode button')].find(x => x.textContent.trim() === '作家'); b.click(); });
await sleep(500);
const w = await page.evaluate(() => ({
  pov: document.getElementById('e-pov').dataset.v,
  desc: document.getElementById('e-desc').dataset.v,
  drive: document.getElementById('e-drive-brief').textContent.trim(),
  verb: document.getElementById('e-verbosity').value,
  ctx: document.getElementById('e-ctx').value,
  kao: document.getElementById('e-kao-freq').dataset.v,
  emoji: document.getElementById('e-emoji').dataset.v,
  note: document.getElementById('e-mode-note').textContent,
}));
ok('视角被填成 L3', w.pov === 'L3', w.pov);
ok('非对话描写填成 high', w.desc === 'high', w.desc);
ok('描写结构填成「极详」', w.drive === '极详', w.drive);
ok('回复长度填成 long', w.verb === 'long', w.verb);
ok('上下文轮数填成 30', w.ctx === '30', w.ctx);
ok('颜文字填成 0', Number(w.kao) === 0, w.kao);
ok('表情填成 0', Number(w.emoji) === 0, w.emoji);
ok('说明行说清了「要点 ✓ 才保存」', String(w.note).indexOf('✓') >= 0, w.note);

console.log('\n【5】保存后落库的是 povStyle');
await clickIt('#btn-edit-save'); await sleep(900);
const saved = await page.evaluate(async () => {
  const req = indexedDB.open('ai-companion');
  const db = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
  const all = await new Promise((res) => { const t = db.transaction('characters').objectStore('characters').getAll(); t.onsuccess = () => res(t.result); });
  db.close();
  const c = all.find(x => x.name === '视角测试');
  return c ? { povStyle: c.povStyle, povLock: c.povLock, verbosity: c.verbosity, detailDrive: c.detailDrive } : null;
});
ok('角色上存了 povStyle=L3', saved && saved.povStyle === 'L3', saved);
ok('回复长度也存进去了', saved && saved.verbosity === 'long', saved);
ok('描写结构存进去了', saved && saved.detailDrive === 'max', saved);

console.log('\n【6】续写按钮：不写用户消息、不动输入框');
await openChar('视角测试');
const before = await page.$$eval('.msg', els => els.length);
await page.$eval('#input', el => { el.value = '写了一半的草稿'; el.dispatchEvent(new Event('input', { bubbles: true })); });
await sleep(200);
const hasBtn = await page.$eval('#btn-continue', el => !!el).catch(() => false);
ok('续写按钮在输入框旁边', hasBtn === true);
await clickIt('#btn-continue');
await sleep(1500);
const after = await page.$$eval('.msg', els => els.length);
ok('续写不往聊天记录里塞用户消息', after === before, { before, after });
const draft = await page.$eval('#input', el => el.value);
ok('续写不清空你写了一半的草稿', draft === '写了一半的草稿', draft);

console.log('\n【7】设置页有导出按钮');
await clickIt('#btn-settings'); await sleep(800);
await page.evaluate(() => {
  const b = [...document.querySelectorAll('#drawer-menu [data-wb-drawer]')].find(x => x.dataset.wbDrawer === 'settings');
  if (b) b.click();
});
await sleep(600);
const btn = await page.evaluate(() => {
  const b = document.getElementById('btn-export-md');
  return b ? { text: b.textContent.trim(), hasHandler: typeof b.onclick === 'function' } : null;
});
ok('「导出当前角色的对话（Markdown）」按钮在', !!btn, btn);
ok('按钮挂着点击处理', btn && btn.hasHandler === true, btn);

ok('全程没有未捕获的 JS 错误', jsErrs.length === 0, jsErrs.slice(0, 4));

console.log('\n===== e2e-viewmode: ' + pass + ' 通过 / ' + fail + ' 失败 =====');
await browser.close();
server.close();
process.exit(fail ? 1 : 0);