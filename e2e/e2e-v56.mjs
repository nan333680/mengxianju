// v1.21.56 的三项：明文地址防护 / 朗读 / 记忆召回。
//
// 记忆召回是纯函数，直接 import 来测（能精确造出「旧逻辑会漏、新逻辑不漏」的场景）；
// 明文防护是行为，走端到端真填地址、真看弹窗。
import fs from 'fs';
import path from 'path';
import os from 'os';
import { pathToFileURL } from 'url';
import puppeteer from 'puppeteer-core';
import { tap } from './e2e-helper.mjs';
import http from 'http';

const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');
const WWW = R + '/www';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
let pass = 0, fail = 0;
const t = (n, ok, ex = '') => { if (ok) { pass++; console.log('  OK   ' + n); } else { fail++; console.log('  FAIL ' + n + (ex ? '  -> ' + ex : '')); } };
const readOr = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

console.log('=== 1. 记忆召回：挑的是「相关的」，不是「最新的」 ===');
// 拷到临时目录再 import：这条路上 persona.js 的相对 import 会按【临时目录】解析。
// v0.5.0 的 persona.js 多了一行 import ./storyarc.js，
// 只拷 persona.js 会在 temp 里找不到它 —— ERR_MODULE_NOT_FOUND，整套直接崩（退出码 1，0.2s）。
// 所以整个 js 目录一起拷，以后再加相对 import 也不会崩。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-v56-persona-'));
for (const f of fs.readdirSync(R + '/www/js')) {
  if (f.endsWith('.js')) fs.copyFileSync(R + '/www/js/' + f, path.join(tmpDir, f));
}
const tmp = path.join(tmpDir, 'persona.js');
const P = await import(pathToFileURL(tmp).href);

const COFFEE = ['你喜欢咖啡', '你常去巷口那家咖啡店', '咖啡要加奶不加糖'];
const mems = [];
for (let i = 0; i < 30; i++) {
  // 关键安排：含「咖啡」的三条放在【最前面】，后面 27 条全是无关的。
  // 旧逻辑 slice(-24) 取的是索引 6..29 —— 正好把那三条挤在外面。
  // ⚠️ 无关的那批【不能含话题里的词】：第一版我写的是「无关的旧事」，
  //    而话题里有「无关」两个字 —— 于是它们全都命中、把 pinned 挤掉了，
  //    看起来像函数有 bug，其实是测试数据自己撞上去的。
  mems.push({ id: 'm' + i, text: i < 3 ? COFFEE[i] : ('日常记录' + i), freq: 'normal' });
}
const picked = P.rankMemories(mems, '今天想去咖啡店坐坐', 24);
t('挑出来还是 24 条（上限没变、token 不变）', picked.length === 24, String(picked.length));
t('★ 含「咖啡」的三条全被选中（旧逻辑 slice(-24) 会把它们丢掉）',
  picked.filter(m => m.text.indexOf('咖啡') >= 0).length === 3,
  '选中 ' + picked.filter(m => m.text.indexOf('咖啡') >= 0).length + ' 条');
t('返回的仍是时间顺序（注入给模型的文本不该乱）', (() => {
  const idx = picked.map(m => mems.indexOf(m));
  return idx.every((v, i) => i === 0 || v > idx[i - 1]);
})());
t('不超过上限时原样返回、不折腾', P.rankMemories(mems.slice(0, 10), '咖啡', 24).length === 10);
t('空数组 / null 不会炸', P.rankMemories([], 'x').length === 0 && P.rankMemories(null, 'x').length === 0);
t('话题为空时也不炸（续写那一轮就没有用户输入）', P.rankMemories(mems, '', 24).length === 24);
t('★ 被点名记住的（pinned）在强相关记忆面前也不被挤掉', (() => {
  const m2 = mems.slice();
  m2[0] = { id: 'pinned-1', text: '这条是他点名要记住的', freq: 'pinned' };
  // 故意用「咖啡」这个话题（那 3 条会靠关键词拿高分）+ 30 条记忆抢 24 个名额。
  // pinned 是保底进，不参与争夺 —— 第一版给的是 +2 分加成，这里就会落选。
  const out = P.rankMemories(m2, '今天想去咖啡店坐坐', 24);
  return out.some(x => x.id === 'pinned-1') && out.length === 24;
})());

console.log('');
console.log('=== 2. 源码接线 ===');
const appJs = readOr(R + '/www/js/app.js');
const personaJs = readOr(R + '/www/js/persona.js');
const html = readOr(R + '/www/index.html');
t('app.js 有 isPrivateHttpHost', !!appJs && appJs.includes('function isPrivateHttpHost'));
t('★ 保存接口地址前会拦公网明文', !!appJs && appJs.includes('!isPrivateHttpHost(v)'));
t('app.js 有朗读三件套', !!appJs && appJs.includes('function speak(') && appJs.includes('function stopSpeak(') && appJs.includes('function ttsAvailable('));
t('★ 自动朗读接在整段落库之后', !!appJs && appJs.includes('if (S.ttsOn) speak('));
t('长按菜单里有「朗读这条」', !!appJs && appJs.includes("{ k: 'tts', t: '朗读这条' }"));
t('朗读默认关', !!appJs && appJs.includes('ttsOn: false'));
t('设置页有朗读开关', !!html && html.includes('id="s-tts"'));
t('persona.js 导出了 rankMemories', !!personaJs && personaJs.includes('export function rankMemories'));
t('★ 注入的是挑过的记忆', !!personaJs && personaJs.includes('rankMemories(memories, topic, 24)'));
// 注：不能断言「文件里不含 memories.slice(-24)」—— 注释里为了说明改动写了这串字，
// 那是文本层面的假阳性（第一版就这么红了一次）。要看的是调用点。
t('app.js 把话题传给了 buildTurnNote', !!appJs && appJs.includes('topic: memTopic'));

console.log('');
console.log('=== 3. 端到端：填明文地址时的实际行为 ===');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = path.join(WWW, p);
  if (!fs.existsSync(f)) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = []; page.on('pageerror', e => errs.push(e.message));
await page.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'networkidle0', timeout: 40000 });
await sleep(1600);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil: 'networkidle0' }); await sleep(1300);
await tap(page, '#btn-settings'); await sleep(800);
await page.evaluate(() => { const b = [...document.querySelectorAll('#drawer-menu [data-wb-drawer]')].find(x => x.dataset.wbDrawer === 'settings'); if (b) b.click(); });
await sleep(600);

const pub = await page.evaluate(async () => {
  const el = document.getElementById('s-baseurl');
  const before = el.value;
  el.value = 'http://example.com/v1';
  el.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 700));
  const m = document.getElementById('modal');
  return { before, shown: !!(m && !m.classList.contains('hidden')) };
});
t('★ 填公网 http 会弹确认（不是静默接受）', pub.shown);
await page.evaluate(() => document.getElementById('modal-cancel').click());
await sleep(500);
const after = await page.evaluate(() => document.getElementById('s-baseurl').value);
t('★ 取消之后地址退回原值（没有偷偷存下去）', after === pub.before, JSON.stringify(after));

const priv = await page.evaluate(async () => {
  const el = document.getElementById('s-baseurl');
  el.value = 'http://192.168.1.5:11434/v1';
  el.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 700));
  const m = document.getElementById('modal');
  return { shown: !!(m && !m.classList.contains('hidden')) };
});
t('★ 局域网 http 不打扰（Ollama / 自建端点就住这儿）', !priv.shown);
const savedUrl = await page.evaluate(async () => {
  const { kv } = await import('./js/db.js');
  const s = await kv.get('settings', {});
  return s.baseUrl;
});
t('局域网地址直接存下来了', savedUrl === 'http://192.168.1.5:11434/v1', JSON.stringify(savedUrl));

const ttsEnv = await page.evaluate(() => ({
  api: ('speechSynthesis' in window),
  box: !!document.getElementById('s-tts'),
  checked: document.getElementById('s-tts') ? document.getElementById('s-tts').checked : null,
}));
t('页面上有朗读开关', ttsEnv.box);
t('默认不勾（不打扰）', ttsEnv.checked === false);
console.log('       [环境] 这个浏览器里 window.speechSynthesis 存在: ' + ttsEnv.api + '（真机 WebView 是 Chrome 内核，同源）');
t('没有 JS 报错', errs.length === 0, errs.join(' | '));

try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
console.log('');
console.log('通过 ' + pass + ' / 失败 ' + fail);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);