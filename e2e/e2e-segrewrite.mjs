// e2e-segrewrite.mjs —— 「从这段起重写」（v0.5.4.6）
//
// 要的是：她一条回复里前面几段很好、后面一小段方向偏了，只重写后半段，
// 前面原样保留。现在只能整条重抽，好的一半也跟着没了。
//
// 这个套件钉四件事：
//   1. 多段的消息才有入口，单段没有（没有"部分"可保留）
//   2. 点开是分段模式：按空行切、每块可点、第 1 块不可点
//   3. 点第 N 块 → 请求里带着保留段，且明确写了「不要重复/改写/总结」
//   4. 落库的正文 = 保留段一字不差 + 新写的那段；旧版还在，有 2 个版本
import puppeteer from 'puppeteer-core';
import http from 'http'; import fs from 'fs'; import path from 'path';
import { seedChar } from './e2e-helper.mjs';
const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');
const WWW = R + '/www';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8' };
const server = http.createServer((req,res) => {
  let q = decodeURIComponent(req.url.split('?')[0]); if (q==='/') q='/index.html';
  const f = path.join(WWW, q);
  if (!fs.existsSync(f)) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f));
});
await new Promise(r => server.listen(0,'127.0.0.1',r));
const port = server.address().port;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 120000,
  args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = []; page.on('pageerror', e => errs.push(e.message));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass=0, fail=0;
const t=(n,ok,ex='')=>{ if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));} };
const waitFor = async (fn, ms = 25000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(300); }
  return false;
};

const P1 = '第一段：她把杯子放下，没说话。';
const P2 = '第二段：她往窗边看了一眼。';
const P3 = '第三段：她突然问他要不要一起走。';
const NEWP = '新第三段：她没问，直接把外套递过去。';

// 第一次请求给三段；后面（重写那次）给一段新的
await page.evaluateOnNewDocument(({P1,P2,P3,NEWP}) => {
  window.__hits = [];
  let n = 0;
  const realFetch = window.fetch.bind(window);
  window.fetch = async function (url, opts) {
    if (!String(url).includes('/chat/completions')) return realFetch(url, opts);
    let body = {};
    try { body = JSON.parse((opts && opts.body) || '{}'); } catch (e) {}
    if (body.stream !== true) return new Response(JSON.stringify({ choices: [{ message: { content: '[]' } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
    window.__hits.push(JSON.stringify(body));
    n++;
    const text = n === 1 ? (P1 + String.fromCharCode(10,10) + P2 + String.fromCharCode(10,10) + P3) : NEWP;
    const chunk = (o) => 'data: ' + JSON.stringify(o) + String.fromCharCode(10,10);
    const stream = new ReadableStream({ start(c) {
      c.enqueue(new TextEncoder().encode(chunk({ choices: [{ delta: { content: text } }] })));
      c.enqueue(new TextEncoder().encode('data: [DONE]' + String.fromCharCode(10,10)));
      c.close();
    }});
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
}, {P1,P2,P3,NEWP});

await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
await sleep(800);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil:'networkidle0' }); await sleep(600);

const cid = await seedChar(page, '分段重写', { greeting: '（开场）', longMemory: false });
await page.evaluate(async ({cid, port}) => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => o.onsuccess = () => r(o.result));
  const ktx = db.transaction('kv','readwrite'); const ks = ktx.objectStore('kv');
  const g = await new Promise(r => { const q = ks.get('settings'); q.onsuccess = () => r(q.result); });
  const val = Object.assign({}, (g && g.v) || {});
  val.apiKey = 'sk-test'; val.baseUrl = 'http://127.0.0.1:' + port + '/v1';
  // 关掉活人感 v2：开着会一次生成三条候选，hits 里就分不清哪条是重写那一次了
  val.liveV2 = false;
  ks.put({ k:'settings', v: val });
  await new Promise(r => ktx.oncomplete = r);
  db.close();
}, {cid, port});
await page.reload({ waitUntil:'networkidle0' }); await sleep(600);
await page.evaluate(() => { const b = document.getElementById('btn-chars'); if (b) b.click(); });
await sleep(700);
await page.evaluate(() => {
  const c = [...document.querySelectorAll('#char-list .char-card')].find(x => x.textContent.includes('分段重写'));
  if (c) c.click();
});
await sleep(1200);
await page.evaluate(() => {
  const i = document.querySelector('#input');
  if (i) { i.value = '走吧'; i.dispatchEvent(new Event('input', { bubbles: true })); }
});
await waitFor(async () => await page.evaluate(() => {
  const b = document.querySelector('#btn-send'); return !!b && !b.disabled;
}), 10000);

await page.click('#btn-send');
// 等那条三段回复落库
const got = await waitFor(async () => await page.evaluate(() => {
  const els = [...document.querySelectorAll('#messages .msg')];
  const last = els[els.length - 1];
  return !!last && String(last.content || '').includes('第二段');
}), 25000);
if (!got) console.log('   [诊断] 没等到回复，hits=' + JSON.stringify(await page.evaluate(() => window.__hits.length)));
await sleep(800);

const menuOf = async (which) => page.evaluate((which) => {
  const els = [...document.querySelectorAll('#messages .msg')];
  const last = els[els.length - 1];
  last.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
  return new Promise(res => setTimeout(() => {
    const items = [...document.querySelectorAll('.msg-menu button')].map(b => ({ k: b.dataset.k, t: b.textContent }));
    res(items);
  }, 400));
}, which);

const dbg = await page.evaluate(async (cid) => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => o.onsuccess = () => r(o.result));
  const q = db.transaction('messages').objectStore('messages').getAll();
  const all = await new Promise(r => q.onsuccess = () => r(q.result));
  db.close();
  return all.filter(m => m.charId === cid && m.role === 'assistant').map(m => JSON.stringify(m.content));
}, cid);
console.log('   落库的 her 消息: ' + JSON.stringify(dbg));

console.log('=== 1. 多段消息有入口 ===');
const menu = await menuOf();
t('菜单里有「从这段起重写」', menu.some(x => x.k === 'fromseg'), JSON.stringify(menu.map(x => x.k)));
// 关掉菜单
await page.evaluate(() => document.body.click());
await sleep(400);

console.log('=== 2. 分段模式：按空行切、第 1 块不可点 ===');
await page.evaluate(() => {
  const els = [...document.querySelectorAll('#messages .msg')];
  els[els.length - 1].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
});
await sleep(400);
await page.evaluate(() => {
  const b = [...document.querySelectorAll('.msg-menu button')].find(x => x.dataset.k === 'fromseg');
  if (b) b.click();
});
await sleep(500);
const segs = await page.evaluate(() => {
  const els = [...document.querySelectorAll('#messages .msg')];
  const last = els[els.length - 1];
  return [...last.querySelectorAll('.seg-pick')].map((el, i) => ({
    i, n: el.querySelector('.seg-n') ? el.querySelector('.seg-n').textContent : '',
    hasClick: !!el.onclick,
  }));
});
t('切出 3 块', segs.length === 3, 'n=' + segs.length);
t('第 1 块不可点（上面没有可保留的）', segs[0] && segs[0].hasClick === false, JSON.stringify(segs[0]));
t('第 2、3 块可点', segs[1] && segs[1].hasClick && segs[2] && segs[2].hasClick, JSON.stringify(segs.map(s => s.hasClick)));

console.log('=== 3. 点第 3 块 → 请求带上保留段和三句禁令 ===');
await page.evaluate(() => {
  const els = [...document.querySelectorAll('#messages .msg')];
  const last = els[els.length - 1];
  const picks = [...last.querySelectorAll('.seg-pick')];
  picks[2].click();
});
await waitFor(async () => (await page.evaluate(() => window.__hits.length)) >= 2, 25000);
await sleep(1500);
const hits = await page.evaluate(() => window.__hits);
// ⚠️ 取【最后一条】而不是第二条：v2 开着时第一次发送本身就会产生多条请求
const req2 = hits.length ? hits[hits.length - 1] : '';

t('真的又发了一次生成', hits.length >= 2, 'hits=' + hits.length);
t('提示词里有「这一段你刚才已经写过了」', req2.includes('这一段你刚才已经写过了'), '');
t('三句禁令都在', req2.includes('不要重复') && req2.includes('不要改写') && req2.includes('不要总结'), '');
t('保留段（前两段）进了提示词', req2.includes('第一段') && req2.includes('第二段'), '');
t('偏掉的那段不在保留段里', !req2.includes('第三段：她突然问'), '');

console.log('=== 4. 落库正文 = 保留段一字不差 + 新段；旧版还在 ===');
const fin = await page.evaluate(async (cid) => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => o.onsuccess = () => r(o.result));
  const q = db.transaction('messages').objectStore('messages').getAll();
  const all = await new Promise(r => q.onsuccess = () => r(q.result));
  db.close();
  const hers = all.filter(m => m.charId === cid && m.role === 'assistant');
  const last = hers[hers.length - 1] || {};
  return { text: String(last.content || ''), vs: Array.isArray(last.variants) ? last.variants.length : 0 };
}, cid);
t('前两段一字不差地在开头', fin.text.startsWith(P1 + '\n\n' + P2), JSON.stringify(fin.text.slice(0, 60)));
t('新写的那段接在后面', fin.text.includes('新第三段'), JSON.stringify(fin.text.slice(-40)));
t('偏掉的旧第三段没被保留', !fin.text.includes('她突然问他要不要一起走'), '');
t('有 2 个版本，能切回原来那版', fin.vs >= 2, 'vs=' + fin.vs);

t('无未捕获报错', errs.length === 0, errs.slice(0,2).join(' | '));
console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
