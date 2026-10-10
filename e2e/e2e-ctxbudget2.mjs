// 上下文预算（v1.21.54）的【端到端】验证 —— 光测纯函数不算数。
//
// 要看的现象只有三个：
//   1. 服务端第一次回 400 context_length_exceeded 后，客户端【自己又发了一次】
//   2. 第二次带的历史【比第一次短】（而不是原样重发一遍）
//   3. 第二次的第一条 system（人设）【一字未动】—— 砍的只能是最旧的历史
// 外加一条收尾：降级之后这轮真的把回复显示出来了（不是重发完还是失败）。
import puppeteer from 'puppeteer-core';
import { seedChar } from './e2e-helper.mjs';
import http from 'http'; import fs from 'fs'; import path from 'path';
const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');
const WWW = R + '/www';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = path.join(WWW, p);
  if (!fs.existsSync(f)) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 120000, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = []; page.on('pageerror', e => errs.push(e.message));
const logs = []; page.on('console', m => logs.push(m.text()));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const t = (n, ok, ex = '') => { if (ok) { pass++; console.log('  OK   ' + n); } else { fail++; console.log('  FAIL ' + n + (ex ? '  -> ' + ex : '')); } };

await page.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'networkidle0', timeout: 40000 });
await sleep(1500);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil: 'networkidle0' }); await sleep(1200);
// v1.21.59：全新安装不再自动建角色（产品改空），测试自己塞一个
await seedChar(page, '测试角色', { greeting: '' });   // 空开场白：不额外多出一条消息
await page.reload({waitUntil:'networkidle0'}); await sleep(500);

console.log('=== 1. 造场景：预算故意调小 + 塞一大段历史 ===');
const seeded = await page.evaluate(async () => {
  const { msgs, kv } = await import('./js/db.js');
  const s = (await kv.get('settings', {})) || {};
  const cid = await kv.get('lastCharId', null);
  s.apiKey = 'sk-test';
  s.baseUrl = 'https://api.deepseek.com';
  s.model = 'deepseek-flash';
  s.contextBudget = 4000;          // 故意压小：一段长历史就顶满
  s.longMemory = false;
  s.autoArchive = false;
  s.searchOn = false;
  s.worldbookOn = false;
  await kv.set('settings', s);
  // 50 条 × 200 字 ≈ 一万 token —— 远超 4000 的预算，一定有东西可丢
  for (let i = 0; i < 50; i++) {
    // ⚠️ ts 不能省：messages 的索引是 [charId, ts]，msgs.list() 走的就是它，
    //    少了 ts 的消息写进去了但【查不出来】—— 第一版就栽在这（列表返回 0 条，
    //    整套断言在原地空转还以为通过了）。
    await msgs.add({ id: 'seed-' + i, charId: cid, role: i % 2 ? 'assistant' : 'user', content: '字'.repeat(200), ts: Date.now() + i });
  }
  const all = await msgs.list(cid);
  return { cid, count: all.length };
});
t('拿到了当前角色 id', !!seeded.cid, JSON.stringify(seeded));
t('历史塞进去了（50 条以上，含开场白）', seeded.count >= 50, String(seeded.count));
await page.reload({ waitUntil: 'networkidle0' }); await sleep(1200);

console.log('');
console.log('=== 2. 第一次请求故意回 400 context_length_exceeded ===');
const caught = [];
await page.setRequestInterception(true);
page.on('request', (req) => {
  const u = req.url();
  if (u.includes('/chat/completions')) {
    if (req.method() === 'OPTIONS') {
      return req.respond({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': '*' } }).catch(() => {});
    }
    caught.push(req.postData() || '');
    if (caught.length === 1) {
      // 第一次：装作"上下文太长"，看客户端怎么办
      return req.respond({
        status: 400,
        headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: { message: "This model's maximum context length is 65536 tokens. Please reduce the length of the messages.", type: 'invalid_request_error' } })
      }).catch(() => {});
    }
    // 第二次（以及万一有的第三次）：正常流式回一句话
    return req.respond({
      status: 200,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'text/event-stream' },
      body: 'data: {"choices":[{"delta":{"content":"我在"}}]}\n\ndata: {"choices":[{"delta":{"content":"。"}}]}\n\ndata: [DONE]\n\n'
    }).catch(() => {});
  }
  try { req.continue(); } catch (e) {}
});

await page.click('#input');
await page.type('#input', '你在吗', { delay: 4 });
await page.click('#btn-send');
for (let i = 0; i < 80 && caught.length < 2; i++) await sleep(250);
await sleep(1500);

console.log('');
console.log('=== 3. 看现象 ===');
t('★ 客户端自己又发了一次（不是把错误甩给用户）', caught.length >= 2, '发出 ' + caught.length + ' 次');
if (caught.length < 2) {
  console.log('  第一次就被拒之后没有重发 —— 后面的断言无法进行');
} else {
  const first = JSON.parse(caught[0]).messages || [];
  const second = JSON.parse(caught[1]).messages || [];
  t('第一次确实带了历史', first.length > 3, first.length + ' 条');
  console.log('       条数：' + first.length + ' -> ' + second.length
    + '   |   降级日志：' + (logs.filter(x => x.includes('[ctx]'))[0] || '（没有）'));
  // 说明：这里【不】重复断言"错误原文有没有透传"—— 那是 e2e-errbody 的专职。
  // 但要知道这条链路依赖它：超长检测读的就是服务端那段文本，
  // 原文一旦被丢掉（v1.21.54 修掉的那个 body 只能读一次的坑），
  // 这套测试会先倒在这里 —— 降级根本不会发生。
  t('★ 第二次带的历史比第一次短', second.length < first.length, first.length + ' -> ' + second.length);
  t('★ 两次的第一条 system（人设）一字未动',
    first[0] && second[0] && first[0].role === 'system' && first[0].content === second[0].content);
  t('★ 最后一条（本轮用户消息）没被裁掉',
    second[second.length - 1] && String(second[second.length - 1].content || '').includes('你在吗'),
    JSON.stringify(second[second.length - 1] || {}).slice(0, 120));
  t('★ 本轮段（system）还在', second.some(m => m.role === 'system' && m !== second[0]));
}

const bubbleText = await page.evaluate(() => {
  const els = document.querySelectorAll('#messages .msg.ai .bub');
  const last = els[els.length - 1];
  return last ? last.textContent : '';
});
t('★ 降级之后这轮真的出话了（不是重发完还是失败）', bubbleText.includes('我在'), JSON.stringify(bubbleText).slice(0, 120));
t('没有 JS 报错', errs.length === 0, errs.join(' | '));

console.log('');
console.log('通过 ' + pass + ' / 失败 ' + fail);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
