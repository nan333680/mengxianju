// e2e-reflect.mjs —— 周期性反思（0.5.4.1，借 Generative Agents 的 reflection）
//
// 覆盖：
//   A. 纯函数：shouldReflect 的四个门槛 / parseReflect 洗文本 / reflectAsk 给素材 /
//              applyReflect 写回 beliefs 且去重
//   B. 一次真请求（hijack fetch）：system 逐字等于 stable（前缀缓存契约）、
//      stream=false、max_tokens=200、temperature=1、noThink（thinking:disabled）
//   C. 接线：app.js 收尾在 LIVE 开关下调用 maybeReflect，且 12 小时判据落地
//
// 进 CI 清单（v0.5.5.1 起，见 .github/workflows/ci.yml 的 $suites）；本地也能单跑。
import puppeteer from 'puppeteer-core';
import http from 'http';
import fs from 'fs';
import path from 'path';
const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');
const WWW = R + '/www';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8' };
const server = http.createServer((req,res) => {
  let q = decodeURIComponent(req.url.split('?')[0]); if (q==='/') q='/index.html';
  const f = path.join(WWW, q);
  if (!fs.existsSync(f)) { res.writeHead(404); res.end('404'); return; }
  // 禁缓存：Chrome 的启发式缓存会把旧 app.js 混进来，制造假的失败
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store, no-cache, must-revalidate' });
  res.end(fs.readFileSync(f));
});
await new Promise(r => server.listen(0,'127.0.0.1',r));
const port = server.address().port;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
const page = await browser.newPage();
// ⚠️ CI 的 runner 是 en-US，界面默认「跟随系统」。钉成中文，否则英文界面下断言中文文案的地方会红。
await page.evaluateOnNewDocument(() => {
  Object.defineProperty(navigator, 'language', { get: () => 'zh-CN', configurable: true });
  Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh'], configurable: true });
});
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await page.setCacheEnabled(false);
const errs = [];
page.on('pageerror', e => errs.push(e.message));
const sleep = ms => new Promise(r=>setTimeout(r,ms));
let pass=0, fail=0;
const t=(n,ok,ex='')=>{ if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));} };

await page.evaluateOnNewDocument(() => {
  window.__rh = [];
  const real = window.fetch.bind(window);
  window.fetch = async function (url, opts) {
    const u = String(url);
    if (u.indexOf('/chat/completions') >= 0) {
      let b = {};
      try { b = JSON.parse((opts && opts.body) || '{}'); } catch (e) {}
      window.__rh.push(b);
      return new Response(JSON.stringify({
        choices: [{ message: { content: '「我其实是在等他先低头」' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 120, completion_tokens: 14 }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return real(url, opts);
  };
});

await page.goto('http://127.0.0.1:' + port + '/index.html', { waitUntil: 'networkidle0' });
await sleep(800);

// ---------- A. 纯函数 ----------
console.log('— 1. shouldReflect：四个门槛 —');
const a1 = await page.evaluate(async () => {
  const M = await import('/js/reflect.js');
  const out = [];
  const T = (n, ok, ex) => out.push({ n, ok: !!ok, ex: ex === undefined ? '' : String(ex) });
  const H = 3600 * 1000;
  const NOW = 1700000000000;
  const mat = { v: 1, openLoops: [{ t: '问他那通电话', at: NOW - 2 * H }], selfEvents: [{ t: '我去剪了头发', at: NOW - H }] };

  T('空状态不反思（没有可反思的东西）', M.shouldReflect({ v: 1 }, 0, NOW) === false);
  T('只有一条素材不反思（一条孤零零的清单反思不出什么）',
    M.shouldReflect({ v: 1, openLoops: [{ t: '一件事', at: NOW }] }, 0, NOW) === false);
  T('两条素材 + 从没反思过 → 反思', M.shouldReflect(mat, 0, NOW) === true);
  T('11 小时前刚反思过 → 不反思', M.shouldReflect(mat, NOW - 11 * H, NOW) === false);
  T('13 小时前反思过 → 反思', M.shouldReflect(mat, NOW - 13 * H, NOW) === true);
  T('封存的条目不算素材',
    M.shouldReflect({ v: 1, openLoops: [{ t: 'a', at: NOW, dead: true }, { t: 'b', at: NOW, dead: true }] }, 0, NOW) === false);
  T('坏输入不抛', (() => { try { M.shouldReflect(null, 'x', NOW); return true; } catch (e) { return false; } })());
  return out;
});
for (const x of a1) t(x.n, x.ok, x.ex);

console.log('— 2. parseReflect：洗文本 —');
const a2 = await page.evaluate(async () => {
  const M = await import('/js/reflect.js');
  const out = [];
  const T = (n, ok, ex) => out.push({ n, ok: !!ok, ex: ex === undefined ? '' : String(ex) });
  T('去掉外面那对中文引号', M.parseReflect('「他其实是在等我先开口」') === '他其实是在等我先开口', M.parseReflect('「他其实是在等我先开口」'));
  T('去掉编号和星号', M.parseReflect('1. *他不想让我看出他在意*') === '他不想让我看出他在意', M.parseReflect('1. *他不想让我看出他在意*'));
  T('只取第一行（模型爱多写）', M.parseReflect('这不算什么\n第二行胡说八道') === '这不算什么', M.parseReflect('这不算什么\n第二行胡说八道'));
  T('空输入返回空串', M.parseReflect('   \n\n  ') === '', JSON.stringify(M.parseReflect('   \n\n  ')));
  T('null 不抛', M.parseReflect(null) === '', JSON.stringify(M.parseReflect(null)));
  const long = '好'.repeat(200);
  T('写了三大段的当没给（宁可不要也不塞散文）', M.parseReflect(long) === '', String(M.parseReflect(long).length));
  const mid = '好'.repeat(60);
  T('超 40 字但不是长篇 → 截到 40', M.parseReflect(mid).length === 40, String(M.parseReflect(mid).length));
  return out;
});
for (const x of a2) t(x.n, x.ok, x.ex);

console.log('— 3. reflectAsk：给素材、给出口 —');
const a3 = await page.evaluate(async () => {
  const M = await import('/js/reflect.js');
  const NOW = 1700000000000;
  const s = M.reflectAsk({
    psyche: { v: 1, openLoops: [{ t: '问他那通电话', at: NOW }], grudges: [{ t: '他那天没来', at: NOW }] },
    recent: '他今天问我要不要一起吃饭'
  });
  const out = [];
  const T = (n, ok, ex) => out.push({ n, ok: !!ok, ex: ex === undefined ? '' : String(ex) });
  T('带上「还没问出口的」那条素材', s.indexOf('问他那通电话') >= 0, s.slice(0, 120));
  T('带上「还没消的」那条素材', s.indexOf('他那天没来') >= 0);
  T('带上他最近说的那几句（有就带）', s.indexOf('要不要一起吃饭') >= 0);
  T('要求只输出一行', s.indexOf('只输出一行') >= 0);
  T('给了「想不出来就什么都不输出」的出口', s.indexOf('想不出来') >= 0);
  T('不要字数的味道：不写"每句最多X字"这种写作要求', s.indexOf('每句') < 0);
  return out;
});
for (const x of a3) t(x.n, x.ok, x.ex);

console.log('— 4. applyReflect：写回 beliefs —');
const a4 = await page.evaluate(async () => {
  const M = await import('/js/reflect.js');
  const P = await import('/js/psyche.js');
  const NOW = 1700000000000;
  const out = [];
  const T = (n, ok, ex) => out.push({ n, ok: !!ok, ex: ex === undefined ? '' : String(ex) });
  const p1 = M.applyReflect({ v: 1, mood: { label: '闷', intensity: 2 } }, '他其实是在等我先低头', NOW);
  T('写进 beliefs', (p1.beliefs || []).some(x => x.t === '他其实是在等我先低头'), JSON.stringify(p1.beliefs));
  T('conf 给 0.6（不是满分，她自己也没底）', (p1.beliefs[0] || {}).conf === 0.6, String((p1.beliefs[0] || {}).conf));
  const p2 = M.applyReflect(p1, '他其实是在等我先低头', NOW + 1000);
  T('同一条不重复堆两条', (p2.beliefs || []).length === 1, JSON.stringify(p2.beliefs));
  const p3 = M.applyReflect({ v: 1 }, '', NOW);
  T('空结论不写', (p3.beliefs || []).length === 0, JSON.stringify(p3.beliefs));
  T('写回去的状态还是 psyche 的形状', !!(p3.stance && p3.mood), JSON.stringify(Object.keys(p3)));
  return out;
});
for (const x of a4) t(x.n, x.ok, x.ex);

// ---------- B. 一次真请求 ----------
console.log('— 5. runReflect：前缀缓存契约 + 请求形状 —');
const b1 = await page.evaluate(async () => {
  const M = await import('/js/reflect.js');
  window.__rh.length = 0;
  const stable = '你是一个有自己生活的人。'.repeat(20);
  const got = await M.runReflect({
    stable,
    psyche: { v: 1, openLoops: [{ t: '一件事', at: Date.now() }, { t: '又一件事', at: Date.now() }] },
    api: { apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', provider: 'deepseek' }
  });
  const req = window.__rh[0] || {};
  const msgs = req.messages || [];
  const out = [];
  const T = (n, ok, ex) => out.push({ n, ok: !!ok, ex: ex === undefined ? '' : String(ex) });
  T('只发了一次请求', window.__rh.length === 1, String(window.__rh.length));
  T('system 逐字等于 stable（前缀缓存就在这一条上）', String((msgs[0] || {}).content || '') === stable, String((msgs[0] || {}).content || '').slice(0, 40));
  T('只有两条消息（system + user）', msgs.length === 2, String(msgs.length));
  T('额外指令挂在 user 上（不往 system 里塞）', String((msgs[1] || {}).role) === 'user');
  T('非流式', req.stream === false, String(req.stream));
  T('max_tokens = 200', req.max_tokens === 200, String(req.max_tokens));
  T('temperature = 1', req.temperature === 1, String(req.temperature));
  T('noThink：deepseek 上把思考关掉', !!(req.thinking && req.thinking.type === 'disabled'), JSON.stringify(req.thinking));
  T('拿回一条洗干净的结论', got && got.belief === '我其实是在等他先低头', JSON.stringify(got));
  T('用量带回来了', !!(got && got.usage), JSON.stringify(got && got.usage));
  return out;
});
for (const x of b1) t(x.n, x.ok, x.ex);

console.log('— 6. runReflect：该缺的东西缺了就不跑 —');
const b2 = await page.evaluate(async () => {
  const M = await import('/js/reflect.js');
  const out = [];
  const T = (n, ok, ex) => out.push({ n, ok: !!ok, ex: ex === undefined ? '' : String(ex) });
  window.__rh.length = 0;
  const r1 = await M.runReflect({ stable: 'stable', psyche: { v: 1 }, api: {} });
  T('没有 apiKey 直接返回 null（不发请求）', r1 === null && window.__rh.length === 0, String(window.__rh.length));
  const r2 = await M.runReflect({ stable: '   ', psyche: { v: 1 }, api: { apiKey: 'sk-x' } });
  T('没有 stable 也返回 null（那等于把人设丢掉）', r2 === null && window.__rh.length === 0, String(window.__rh.length));
  return out;
});
for (const x of b2) t(x.n, x.ok, x.ex);

// ---------- C. 接线 ----------
console.log('— 7. 接线：收尾在 LIVE 开关下调用，12 小时判据落地 —');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const appSrc = strip(fs.readFileSync(WWW + '/js/app.js', 'utf8'));
t('app.js 在收尾调用 maybeReflect', /if \(LIVE\) maybeReflect\(myCharId\)/.test(appSrc));
t('app.js 有 maybeReflect 的定义', /async function maybeReflect\(charId\)/.test(appSrc));
t('反思的时间戳用 kv 单独记（不塞进 psyche）', appSrc.indexOf("'reflect:' + charId") >= 0);
t('群聊不反思（反思的是一个人，不是一群人）', appSrc.indexOf('!c || isGroup(c)') >= 0);
const refSrc = strip(fs.readFileSync(WWW + '/js/reflect.js', 'utf8'));
t('12 小时的门槛写在常量里', /REFLECT_GAP_MS = 12 \* 3600 \* 1000/.test(refSrc));
t('反思不碰 relation（关系读数只由 director 给）', refSrc.indexOf('applyRelation') < 0);
t('反思不写 secrets / boundaries', refSrc.indexOf('secret:') < 0 && refSrc.indexOf('boundary:') < 0);

t('页面里没有未捕获异常', errs.length === 0, errs.join(' | '));

console.log('');
console.log('通过 ' + pass + ' 项 / 失败 ' + fail + ' 项');
await browser.close();
server.close();
process.exit(fail ? 1 : 0);
