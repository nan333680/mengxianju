// 世界书「一直生效」这一档的【端到端】验证（v1.21.51）。
//
// e2e-wbpos 测的是纯函数（buildStablePrompt 怎么拼），e2e-v51fix 测的是源码里有没有那句调用。
// 这一套补中间那段：库里真放一条 always，真发一条消息，抓发出去的请求体看它在哪。
//
// 要看的现象只有两个：
//   · always 那条进【稳定前缀】（第 1 条 system），不进本轮段
//   · front 那条（靠触发词命中）进【本轮段】，绝不进稳定前缀
import puppeteer from 'puppeteer-core';
import { seedChar } from './e2e-helper.mjs';
import http from 'http'; import fs from 'fs'; import path from 'path';
const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');
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
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 120000, args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = []; page.on('pageerror', e => errs.push(e.message));
const sleep = ms => new Promise(r=>setTimeout(r,ms));
let pass=0, fail=0;
const t=(n,ok,ex='')=>{if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));}};

await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
await sleep(1500);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil:'networkidle0' }); await sleep(1200);
// v1.21.59：全新安装不再自动建角色（产品改空），测试自己塞一个
await seedChar(page, '测试角色', { greeting: '' });   // 空开场白：不额外多出一条消息
await page.reload({waitUntil:'networkidle0'}); await sleep(500);

console.log('=== 1. 造数据：一条 always、一条 front，都挂在当前角色名下 ===');
const seeded = await page.evaluate(async () => {
  const { wb, kv } = await import('./js/db.js');
  const s = (await kv.get('settings', {})) || {};
  const cid = await kv.get('lastCharId', null);
  s.worldbookOn = true; s.apiKey = 'sk-test';
  s.baseUrl = 'https://api.deepseek.com'; s.model = 'deepseek-flash';
  await kv.set('settings', s);
  await wb.putSolo({ id: "solo-1", charId: cid, entries: [
    { id: 'e-always', title: '世界观', keys: [], content: '这个世界的天空永远是黄昏色。', on: true, pos: 'always' },
    { id: 'e-front', title: '红魔馆', keys: ['红魔馆'], content: '红魔馆是蕾米莉亚的宅邸。', on: true, pos: 'front' },
  ] });
  return { cid };
});
t('拿到当前角色 id', !!seeded.cid, JSON.stringify(seeded));
await page.reload({ waitUntil:'networkidle0' }); await sleep(1000);

console.log('');
console.log('=== 2. 发一条消息，抓住发出去的请求体 ===');
let held = null;
await page.setRequestInterception(true);
page.on("request", (req) => {
  const u = req.url();
  if (u.includes("/chat/completions")) {
    if (req.method() === "OPTIONS") {
      return req.respond({ status:204, headers:{
        "Access-Control-Allow-Origin":"*",
        "Access-Control-Allow-Methods":"POST, OPTIONS",
        "Access-Control-Allow-Headers":"*"
      }}).catch(()=>{});
    }
    // 活人感 v2：最后一发可能是评审/独白（非流式辅助请求），它不是正文 ——
    // 只认流式那条（3 条候选的 messages 一样，取哪条都行），辅助请求给个合法 JSON 就放走。
    try {
      if (JSON.parse(req.postData()||'{}').stream === false) {
        return req.respond({ status:200, headers:{ "Access-Control-Allow-Origin":"*" }, contentType:"application/json",
          body: JSON.stringify({ choices:[{ message:{ content:'{}' } }] }) }).catch(()=>{});
      }
    } catch (e) {}
    held = req;
    return;
  }
  try { req.continue(); } catch (e) {}
});
await page.click('#input');
await page.type('#input', '红魔馆那边怎么样了', { delay: 4 });
await page.click('#btn-send');
for (let i = 0; i < 60 && !held; i++) await sleep(250);
t('请求发出去了', !!held);

console.log('');
console.log('=== 3. 拆请求体，看两档各落在哪 ===');
let msgs = [];
try { msgs = JSON.parse(held.postData()).messages || []; } catch (e) { msgs = []; }
t('解析出 messages', msgs.length > 0, msgs.length + ' 条');
const sysIdx = msgs.map((m, i) => m.role === "system" ? i : -1).filter(i => i >= 0);
const first = msgs[0] || { content: "" };
const all = msgs.map(m => m.content || '').join('\n');
t('第 1 条是 system（稳定前缀在最前）', msgs[0] && msgs[0].role === 'system');
t('稳定前缀含角色设定', first.content.includes('# 你的角色设定'));
t('稳定前缀含「基础设定」段', first.content.includes('# 基础设定'));
t('always 那条的内容在稳定前缀里', first.content.includes('天空永远是黄昏色'));
t('front 那条【不在】稳定前缀里（它靠命中，进了前缀就等于每轮重算）', !first.content.includes('红魔馆是蕾米莉亚的宅邸'));
t('本轮段含「相关设定」', all.includes('# 相关设定'));
t('命中的 front 那条在本轮段里', all.includes('红魔馆是蕾米莉亚的宅邸'));
t('always 那条【不在】本轮段里（不然就注了两遍）',
  (all.split('天空永远是黄昏色').length - 1) === 1, '出现 ' + (all.split('天空永远是黄昏色').length - 1) + ' 次');

console.log('');
console.log('JS 错误: ' + (errs.length ? errs.join(' | ') : '无'));
t('无 JS 报错', errs.length === 0, errs.join(' | '));
try { held.abort(); } catch (e) {}
console.log('');
console.log('通过 ' + pass + ' / 失败 ' + fail);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);