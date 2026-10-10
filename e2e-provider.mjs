// v1.21.47：接别家的模型 API。
//
// 这个项目只说 OpenAI 兼容协议，各家真正的差别收在 api.js 的 PROVIDERS 档案里：
//   推理档位映射 / 用量字段 / 思考字段名 / 有没有余额接口。
// 这一套就盯这些差别，加上"端点不认某字段时自动摘掉重试"。
import puppeteer from 'puppeteer-core';
import http from 'http'; import fs from 'node:fs'; import path from 'node:path';
const R = path.resolve(import.meta.dirname).split(path.sep).join('/');
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
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 180000, args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = []; page.on('pageerror', e => errs.push(e.message));
page.on('dialog', async d => { await d.accept(); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const t = (n, ok, ex) => { if (ok) { pass++; console.log('  OK   ' + n); } else { fail++; console.log('  FAIL ' + n + (ex !== undefined ? '  -> ' + ex : '')); } };
const jsClick = s => page.evaluate(x => { const e = document.querySelector(x); if (e) e.click(); }, s);

// —— 拦下所有 /chat/completions，记录请求体，按队列回响应 ——
const bodies = [];
let queue = [];
const okSse = { status: 200, contentType: 'application/json',
  headers: { 'Access-Control-Allow-Origin': '*' },
  body: 'data: {"choices":[{"delta":{"content":"嗨"}}]}\n\ndata: [DONE]\n\n' };
await page.setRequestInterception(true);
page.on('request', req => {
  const u = req.url();
  if (!u.includes('/chat/completions') && !u.includes('/user/balance')) { req.continue(); return; }
  if (req.method() === 'OPTIONS') {
    req.respond({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' } });
    return;
  }
  let body = {};
  try { body = JSON.parse(req.postData() || '{}'); } catch { /* 不是 JSON 就算了 */ }
  bodies.push({ url: u, body });
  const r = queue.length ? queue.shift() : okSse;
  req.respond(r);
});

const openSettings = async () => {
  for (let i = 0; i < 6; i++) {
    const cur = await page.evaluate(() => (document.querySelector('.view.active') || {}).id);
    if (cur === 'view-chat') break;
    await page.evaluate(() => {
      const b = document.getElementById('btn-edit-back') || document.getElementById('btn-chars-back')
             || document.getElementById('btn-set-back') || document.getElementById('btn-drawer-close');
      if (b) b.click();
    });
    await sleep(400);
  }
  await jsClick('#btn-settings'); await sleep(700);
  await page.evaluate(() => { const b = [...document.querySelectorAll('#drawer-menu [data-wb-drawer]')].find(x => x.dataset.wbDrawer === 'settings'); if (b) b.click(); });
  await sleep(800);
};
/** 直接调 streamChat，跑完整个流；返回这次请求打出去的 body */
const callChat = (opts) => page.evaluate(async (o) => {
  const { streamChat } = await import('/js/api.js');
  let text = '';
  for await (const d of streamChat(o)) text += d;
  return text;
}, { apiKey: 'sk-test', baseUrl: 'https://mock.local/v1', model: 'm', messages: [{ role: 'user', content: 'hi' }], ...opts });

await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
await sleep(1500);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil:'networkidle0' }); await sleep(1200);

console.log('=== 1. 档案表 ===');
const list = await page.evaluate(async () => (await import('/js/api.js')).providerList());
console.log('   服务商: ' + JSON.stringify(list.map(x => x.label)));
t('有 8 家可选', list.length === 8, String(list.length));
t('含 DeepSeek / 自定义', list.some(x => x.value === 'deepseek') && list.some(x => x.value === 'custom'));
const specFallback = await page.evaluate(async () => (await import('/js/api.js')).providerSpec('不存在的服务商').label);
t('认不出来的 id 回落 DeepSeek', specFallback === 'DeepSeek', specFallback);

console.log('');
console.log('=== 2. 请求体按服务商组装 ===');
bodies.length = 0;
await callChat({ provider: 'deepseek', reasoningEffort: 'high' });
const bDeep = bodies[bodies.length - 1].body;
t('DeepSeek：带 reasoning_effort', bDeep.reasoning_effort === 'high', JSON.stringify(bDeep.reasoning_effort));
t('DeepSeek：带 stream_options（要用量）', !!(bDeep.stream_options && bDeep.stream_options.include_usage));
await callChat({ provider: 'kimi', reasoningEffort: 'high' });
const bKimi = bodies[bodies.length - 1].body;
t('Kimi：不发 reasoning_effort（它不认）', bKimi.reasoning_effort === undefined, JSON.stringify(bKimi.reasoning_effort));
t('Kimi：仍然要用量', !!(bKimi.stream_options));
await callChat({ provider: 'custom', reasoningEffort: 'high' });
const bCust = bodies[bodies.length - 1].body;
t('自定义：两个可选字段都不发（最安全）', bCust.reasoning_effort === undefined && bCust.stream_options === undefined);
await callChat({ provider: 'openai', reasoningEffort: 'max' });
const bOai = bodies[bodies.length - 1].body;
t('OpenAI：max 映射成 high（它没有 max 这档）', bOai.reasoning_effort === 'high', JSON.stringify(bOai.reasoning_effort));
await callChat({ provider: 'openai', reasoningEffort: 'none' });
const bOai2 = bodies[bodies.length - 1].body;
t('OpenAI：none 映射成"不发"', bOai2.reasoning_effort === undefined, JSON.stringify(bOai2.reasoning_effort));

console.log('');
console.log('=== 2.5 思考字段：真的把内容接住了吗 ===');
// ⚠️ 这一段是【行为】验证，不是读源码 ——
// v1.21.47 把流式解析里的字段名改成按档案取了（此前写死 reasoning_content），
// e2e-v30fix 里那条"源码字面匹配"的静态断言因此失效。功能到底还对不对，得真跑一遍。
const callChatWithThink = (opts) => page.evaluate(async (o) => {
  const { streamChat } = await import('/js/api.js');
  let text = '', think = '';
  for await (const d of streamChat({ ...o, onThink: (v) => { think = v; } })) text += d;
  return { text, think };
}, { apiKey: 'sk-test', baseUrl: 'https://mock.local/v1', model: 'm', messages: [{ role: 'user', content: 'hi' }], ...opts });

queue = [{ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' },
  body: 'data: {"choices":[{"delta":{"reasoning_content":"我在想"}}]}\n\ndata: {"choices":[{"delta":{"content":"嗨"}}]}\n\ndata: [DONE]\n\n' }];
const th1 = await callChatWithThink({ provider: 'deepseek' });
t('DeepSeek 的 reasoning_content 照样累积（改了写法没改行为）', th1.think === '我在想', JSON.stringify(th1));
t('思考内容没混进正文', th1.text === '嗨', JSON.stringify(th1.text));
queue = [{ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' },
  body: 'data: {"choices":[{"delta":{"reasoning":"想想想"}}]}\n\ndata: {"choices":[{"delta":{"content":"嗨"}}]}\n\ndata: [DONE]\n\n' }];
const th2 = await callChatWithThink({ provider: 'openrouter' });
t('OpenRouter 的 reasoning 字段也认（以前不认）', th2.think === '想想想', JSON.stringify(th2));
t('同样没混进正文', th2.text === '嗨', JSON.stringify(th2.text));

console.log('');
console.log('=== 3. 端点不认某个字段 → 自动摘掉重试 ===');
bodies.length = 0;
queue = [{ status: 400, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' },
           body: JSON.stringify({ error: { message: 'Unrecognized request argument supplied: reasoning_effort' } }) }];
const txt = await callChat({ provider: 'deepseek', reasoningEffort: 'high' });
t('重试后拿到了内容', txt === '嗨', txt);
t('一共打了两次', bodies.length === 2, String(bodies.length));
t('第一次带着 reasoning_effort', bodies[0].body.reasoning_effort === 'high');
t('第二次摘掉了它', bodies[1].body.reasoning_effort === undefined);
bodies.length = 0;
queue = [{ status: 400, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' },
           body: JSON.stringify({ error: { message: 'unknown parameter: stream_options' } }) }];
await callChat({ provider: 'deepseek', reasoningEffort: 'high' });
t('stream_options 不认时同样摘掉重试',
  bodies.length === 2 && bodies[1].body.stream_options === undefined,
  JSON.stringify(bodies.map(b => ({ ro: b.body.reasoning_effort, so: !!b.body.stream_options }))));
bodies.length = 0;
queue = [{ status: 400, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' },
           body: JSON.stringify({ error: { message: '模型名不对' } }) }];
let threw = '';
try { await callChat({ provider: 'custom' }); } catch (e) { threw = String(e.message || e); }
t('不认识的错误照旧抛出来（不乱重试）', /400/.test(threw) && bodies.length === 1, threw + ' / 次数=' + bodies.length);

console.log('');
console.log('=== 4. 余额接口只有 DeepSeek 有 ===');
const balKimi = await page.evaluate(async () => {
  const { fetchBalance } = await import('/js/api.js');
  try { await fetchBalance({ apiKey:'sk-x', baseUrl:'https://mock.local/v1', provider:'kimi' }); return 'ok'; }
  catch (e) { return String(e.message || e); }
});
t('非 DeepSeek 直接给人话，不是 404', /没有余额查询接口/.test(balKimi), balKimi);

console.log('');
console.log('=== 5. 设置页 UI ===');
await openSettings();
// v1.21.57：「接口」收成折叠了，page.select 要求元素可见，得先展开
await page.evaluate(() => { const f = document.getElementById('api-fold'); if (f && !f.classList.contains('open')) f.click(); });
await sleep(600);
t('有服务商下拉', !!(await page.$('#s-provider')));
const opts = await page.$$eval('#s-provider option', els => els.map(e => e.value));
t('下拉里有 8 家', opts.length === 8, JSON.stringify(opts));
t('默认选中 DeepSeek', (await page.$eval('#s-provider', el => el.value)) === 'deepseek');
t('余额行默认可见（DeepSeek 有接口）', (await page.$eval('#balance-row', el => el.style.display)) !== 'none');
const note0 = await page.$eval('#s-provider-note', el => el.textContent);
t('下面有一句说明', note0.length > 4, note0);
await page.select('#s-provider', 'kimi'); await sleep(900);
const kimiUi = await page.evaluate(() => ({
  base: document.getElementById('s-baseurl').value,
  model: document.getElementById('s-model').value,
  bal: document.getElementById('balance-row').style.display,
}));
t('切到 Kimi：Base URL 换成它的', kimiUi.base === 'https://api.moonshot.cn/v1', kimiUi.base);
t('切到 Kimi：模型换成它的', kimiUi.model === 'moonshot-v1-8k', kimiUi.model);
t('切到 Kimi：余额行藏起来', kimiUi.bal === 'none', kimiUi.bal);
const kept = await page.evaluate(async () => {
  const { kv } = await import('/js/db.js');
  const s = await kv.get('settings', {});
  return { provider: s.provider, baseUrl: s.baseUrl, model: s.model };
});
t('选择已经存下来了', kept.provider === 'kimi' && kept.baseUrl.includes('moonshot'), JSON.stringify(kept));
// 切到「自定义」不能把刚填好的地址清空
await page.select('#s-provider', 'custom'); await sleep(900);
const custBase = await page.$eval('#s-baseurl', el => el.value);
t('切到「自定义」保留已填的地址（不清空）', custBase === 'https://api.moonshot.cn/v1', custBase);

console.log('');
console.log('=== 6. 老数据（没有 provider 字段）默认走 DeepSeek ===');
await page.evaluate(async () => {
  const { kv } = await import('/js/db.js');
  const s = Object.assign({}, await kv.get('settings', {}));
  delete s.provider;
  await kv.set('settings', s);
});
await page.reload({ waitUntil:'networkidle0' }); await sleep(1200);
bodies.length = 0;
await callChat({ reasoningEffort: 'low' });   // 不传 provider，模拟老设置
const bOld = bodies[bodies.length - 1].body;
t('不传 provider 时按 DeepSeek 发（reasoning_effort 原样）', bOld.reasoning_effort === 'low', JSON.stringify(bOld.reasoning_effort));

console.log('');
if (errs.length) console.log('  JS 错误: ' + JSON.stringify(errs.slice(0,3)));
t('全程无 JS 错误', errs.length === 0, errs.slice(0,2).join(' | '));
console.log('');
console.log('通过 ' + pass + ' / 失败 ' + fail);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
