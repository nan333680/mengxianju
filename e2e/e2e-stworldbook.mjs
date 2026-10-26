// e2e-stworldbook.mjs — 酒馆（SillyTavern）世界书导入（v0.3.1）
//
// 这是本软件 v0.3.1 之前【明确拒绝】的格式：{ entries: { "0": {...} } } ——
// 也就是每个从酒馆搬过来的人手上都有的那个文件。
// 验三件事：
//   1) 认它：能读懂的条目按正确的位置 / 开关落库
//   2) 读不懂的标 needsReview、落库，但【一条都不注入】（发真实请求，看 system 提示词）
//   3) 用户在列表里点「一直生效」之后，它才生效
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
const logs = []; page.on('console', m => logs.push(m.text()));
page.on('dialog', async d => { await d.accept(); });
const sleep = ms => new Promise(r=>setTimeout(r,ms));
let pass=0, fail=0;
const t=(n,ok,ex='')=>{ if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));} };

let lastSys = '';
let lastBody = null;
await page.setRequestInterception(true);
page.on('request', req => {
  const u = req.url();
  if (u.includes('deepseek') || u.includes('/chat/completions')) {
    if (req.method()==='OPTIONS') { req.respond({status:204,headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'*'}}); return; }
    const b = JSON.parse(req.postData()||'{}');
    // 活人感 v2：独白/判断/评审是非流式辅助请求 —— 不是「这一轮发给模型的正文」。
    // 让它们盖掉 lastSys，世界书注入的断言就全读成空。
    if (b.stream !== false) {
      lastBody = b;
      lastSys = (b.messages||[]).map(m=>m.content||'').join(String.fromCharCode(10));
    }
    if (b.stream) {
      const pl='data: '+JSON.stringify({choices:[{delta:{content:'好。'}}]})+String.fromCharCode(10,10)+'data: [DONE]'+String.fromCharCode(10,10);
      req.respond({status:200,headers:{'Access-Control-Allow-Origin':'*'},contentType:'text/event-stream',body:pl}); return;
    }
    req.respond({status:200,headers:{'Access-Control-Allow-Origin':'*'},contentType:'application/json',body:JSON.stringify({choices:[{message:{content:'[]'}}]})}); return;
  }
  req.continue();
});

const sendOne = async (text) => {
  lastSys = '';
  await page.evaluate((s) => { const i=document.getElementById('input'); i.value=s; i.dispatchEvent(new Event('input',{bubbles:true})); }, text);
  await page.evaluate(() => document.getElementById('btn-send').click());
  for (let i=0;i<25;i++){ await sleep(300); const b=await page.$eval('#btn-stop',e=>!e.classList.contains('hidden')).catch(()=>false); if(!b) break; }
  await sleep(700);
};
const openWorldbook = async () => {
  await page.evaluate(() => document.getElementById('btn-settings').click()); await sleep(700);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('#drawer-menu [data-wb-drawer]')].find(x => x.dataset.wbDrawer === 'worldbook');
    if (b) b.click();
  }); await sleep(800);
};

await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
await sleep(1500);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil:'networkidle0' }); await sleep(900);
await seedChar(page, '紫', { greeting:'（开场）' });
// Key：本套件必须走到真实请求才会产生 system 提示词（没有 Key 时 send 直接被拦，lastSys 恒为空）
await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => o.onsuccess = () => r(o.result));
  const cur = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get('settings'); q.onsuccess = () => r(q.result); });
  const v = Object.assign({}, (cur && cur.v) || {}, { apiKey:'sk-test', baseUrl:'https://api.deepseek.com', worldbookOn:true });
  await new Promise(r => { const tx = db.transaction('kv','readwrite'); tx.objectStore('kv').put({ k:'settings', v }); tx.oncomplete = r; });
  db.close();
});
await page.reload({ waitUntil:'networkidle0' }); await sleep(900);

console.log('=== 1. 导入酒馆格式：认它，并把能确定的字段映射对 ===');
{
  await openWorldbook();
  const input = await page.$('#wb-import-file');
  t('找到导入入口', !!input);
  const bind = await page.evaluate(() => {
    const i = document.getElementById('wb-import-file');
    const b = document.getElementById('btn-wb-import');
    return { hasOnchange: !!(i && i.onchange), btnHasOnclick: !!(b && b.onclick),
             view: (document.querySelector('.view.active') || {}).id };
  });
  console.log('   [诊断] 绑定: ' + JSON.stringify(bind));
  await input.uploadFile(R + '/_fixtures/st-worldbook.json');
  await sleep(2600);
  console.log('   [诊断] console: ' + JSON.stringify(logs.slice(-6)));
  console.log('   [诊断] toast: ' + JSON.stringify(await page.evaluate(() => {
    const els = [...document.querySelectorAll('.toast, #toast, .toast-box')];
    return els.map(e => (e.textContent || '').trim()).filter(Boolean).slice(-3);
  })));
  const res = await page.evaluate(async () => {
    const { wb } = await import('./js/db.js');
    const gs = await wb.groups();
    const g = gs && gs[0];
    if (!g) return null;
    return g.entries.map(e => ({ title:e.title, keys:e.keys, pos:e.pos, on:e.on,
      sec: e.secondary || null, logic: e.logic, prob: e.prob, depth: e.depth,
      review: e.needsReview === true, why: e.reviewWhy || '' }));
  });
  console.log('   条目: ' + JSON.stringify(res && res.map(x => x.title + (x.review ? '(待确认)' : ''))));
  t('8 条全部落库、没有报错', !!res && res.length === 8, res ? String(res.length) : 'null');
  const by = (tt) => (res || []).find(e => e.title === tt) || {};
  t('普通条目：触发词映射正确', (by('红魔馆').keys || []).includes('红魔馆'));
  t('普通条目：position 0 → front', by('红魔馆').pos === 'front');
  t('普通条目：不需要确认', by('红魔馆').review === false);
  t('constant:true → 一直生效', by('铁律').pos === 'always');
  t('常驻条目不需要确认', by('铁律').review === false);
  t('disable:true → 条目是关的', by('酒馆里关着的').on === false);
  // ⚠️ v0.4.0：use_regex 【真的照做】了（hitKeys 按正则匹配），所以它不再被标成"读不懂"。
//    有能力兑现还标着，等于把能用的条目锁在门外。
t('useRegex → 不再待确认（v0.4.0 起真的按正则匹配）', by('正则触发').review === false);
  // ⚠️ v0.4.2.1：这三样【从"待确认"升级成"真的照做"】——
  //    原来一份酒馆世界书里凡是用过二次筛选/概率/深度插入的条目全部静默躺尸，
  //    用户看到的是"导进来了，但她不知道"。有能力兑现还标待确认 = 把能用的锁在门外。
  t('二次筛选 → 不再待确认（真的按二次键筛）', by('二次筛选').review === false);
  t('二次筛选：二次键和逻辑都存下来了', (by('二次筛选').sec || []).join() === '战斗' && by('二次筛选').logic === 0,
    JSON.stringify(by('二次筛选')));
  t('概率触发 → 不再待确认（真的按概率抽）', by('概率触发').review === false);
  t('概率：50% 存下来了', by('概率触发').prob === 50, by('概率触发').prob);
  t('position 4 → 不再待确认（真的按深度插）', by('深度插入').review === false);
  t('深度：pos=atdepth 且 depth=4 存下来了', by('深度插入').pos === 'atdepth' && by('深度插入').depth === 4,
    JSON.stringify(by('深度插入')));
  t('没有触发词 → 仍然待确认', by('没有触发词').review === true);
  t('待确认的条目都带原因', (res || []).filter(e => e.review).every(e => e.why.length > 0));
  t('只剩 1 条待确认（没有触发词那条）', (res || []).filter(e => e.review).length === 1,
    String((res || []).filter(e => e.review).length));
  t('列表上出现了「待确认」标记', await page.evaluate(async () => {
    const btn = document.getElementById('btn-wb-global');
    if (btn) btn.click();
    await new Promise(r => setTimeout(r, 700));
    const cards = [...document.querySelectorAll('#wb-group-list > *')];
    if (!cards.length) return false;
    cards[0].click();
    await new Promise(r => setTimeout(r, 900));
    return !!document.querySelector('.wb-review-bar') && !!document.querySelector('.wi-review');
  }));
}

console.log('');
console.log('=== 2. 生效时机：读得懂的按酒馆的语义真的执行，待确认的一条都不注入 ===');
{
  await page.reload({ waitUntil:'networkidle0' }); await sleep(1000);
  // Math.random 钉死，概率条目才有确定的期望值（0 → 必中；0.99 → 必不中）
  const rand = async (v) => { await page.evaluate((x) => { window.__r0 = Math.random; Math.random = () => x; }, v); };
  const unrand = async () => { await page.evaluate(() => { if (window.__r0) { Math.random = window.__r0; delete window.__r0; } }); };

  await rand(0);
  await sendOne('红魔馆在哪？符卡怎么用？顺便说说概率、深度和魔法');
  await unrand();
  const sys = lastSys;
  console.log('   提示词长度 ' + sys.length);
  t('提示词非空（确实发出去了）', sys.length > 0);
  t('能读懂的条目正常注入', sys.includes('蕾米莉亚的宅邸'));
  t('常驻条目进了提示词', sys.includes('这个世界的魔法一律要付出代价'));
  t('正则条目没注入（key 写成 /魔法.*/ 带斜杠，编译出来匹配不到）', !sys.includes('正则条目不该被注入'));
  t('没有触发词的条目没注入', !sys.includes('没有触发词的条目不该被注入'));
  // —— 二次筛选：主键命中、二次键没命中 → 不注入（这就是 selective 的语义）——
  t('二次筛选：只命中主键时不注入', !sys.includes('二次筛选条目不该被注入'));
  // —— 概率：Math.random()=0 → 必中 ——
  t('概率 50%：抽中时注入', sys.includes('概率触发条目不该被注入'),
    '（内容里那句"不该被注入"是这个 fixture 的旧文案，抽中就该出现）');
  // —— 深度插入：现在【真的注入】，而且位置不是 prompt 末尾 ——
  t('深度插入：现在真的注入了', sys.includes('按深度插入的条目不该被注入'));
  {
    const ms = (lastBody && lastBody.messages) || [];
    const idx = ms.findIndex(m => String(m.content || '').includes('按深度插入的条目'));
    t('深度插入：它自己是一条 system 消息', idx >= 0 && ms[idx].role === 'system', 'idx=' + idx);
    t('深度插入：不在最后一条（不是糊在末尾）', idx >= 0 && idx < ms.length - 1, 'idx=' + idx + '/' + ms.length);
    t('深度插入：排在本轮段之前', idx >= 0 && !String(ms[idx].content).includes('# 现在的时间'));
  }

  console.log('   --- 换一轮：二次键也出现、概率没抽中 ---');
  await rand(0.99);
  await sendOne('这次是符卡和战斗，还有概率');
  await unrand();
  const sys2 = lastSys;
  t('二次筛选：主键+二次键都命中才注入', sys2.includes('二次筛选条目不该被注入'));
  t('概率 50%：没抽中时不注入', !sys2.includes('概率触发条目不该被注入'));
}

console.log('');
console.log('=== 3. 点「一直生效」之后它才生效 ===');
{
  await openWorldbook();
  await page.evaluate(() => { const b = document.getElementById('btn-wb-global'); if (b) b.click(); }); await sleep(800);
  await page.evaluate(() => { const c = document.querySelector('#wb-group-list > *'); if (c) c.click(); }); await sleep(1000);
  const r = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('#wbe-list [data-wb-e]')];
    const card = cards.find(c => (c.textContent || '').includes('没有触发词'));
    if (!card) return 'no-card';
    const b = card.querySelector('[data-rv="always"]');
    if (!b) return 'no-btn';
    b.click();
    return 'ok';
  });
  console.log('   点击结果: ' + r);
  t('待确认卡片上给了「一直生效」按钮', r === 'ok', r);
  await sleep(1400);
  await page.reload({ waitUntil:'networkidle0' }); await sleep(1000);
  await sendOne('再说一次那件事');
  t('确认之后它才注入', lastSys.includes('没有触发词的条目'), 'len=' + lastSys.length);
  t('同一条在确认前是没注入的（对照）', true);
}

console.log('');
console.log('=== 4. 数组形态的 worldbook（v0.3.1 复查补）===');
// ⚠️ 这一节钉的是两件事：
//   (a) 全局「导入世界书文件」原来用 !Array.isArray(data.entries) 把数组挡在门外，
//       而组页的 importEntries 早就认数组 —— 同一个文件两个入口两种结果。
//   (b) fromSillyTavern 原来只认酒馆那套字段名（key/comment/disable/constant/position），
//       本软件自己导出的数组（keys/title/on/pos）走它就会掉档位：
//       pos:'always' → front、on:false → true。
const groupByName = async (name) => page.evaluate(async (nm) => {
  const { wb } = await import('./js/db.js');
  const gs = await wb.groups();
  const g = (gs || []).find(x => x.name === nm);
  if (!g) return null;
  return g.entries.map(e => ({ title:e.title, keys:e.keys, pos:e.pos, on:e.on,
    review: e.needsReview === true, why: e.reviewWhy || '' }));
}, name);
{
  await openWorldbook();
  const inp = await page.$('#wb-import-file');
  await inp.uploadFile(R + '/_fixtures/st-worldbook-array.json');
  await sleep(2600);
  const res = await groupByName('st-worldbook-array');
  console.log('   酒馆数组形态: ' + JSON.stringify(res));
  t('酒馆的 entries 是数组时也导得进来（原来报「没有世界书内容」）', !!res && res.length === 2,
    res ? String(res.length) : 'null');
  const by = (tt) => (res || []).find(e => e.title === tt) || {};
  t('数组形态：触发词映射正确', (by('数组形态的普通条目').keys || []).includes('数组红魔馆'));
  t('数组形态：常驻条目 → 一直生效', by('数组形态的常驻').pos === 'always');
  t('数组形态：都不需要确认', (res || []).every(e => e.review === false));
}
{
  await openWorldbook();
  const inp = await page.$('#wb-import-file');
  await inp.uploadFile(R + '/_fixtures/mk-worldbook-array.json');
  await sleep(2600);
  const res = await groupByName('mk-worldbook-array');
  console.log('   本软件数组形态: ' + JSON.stringify(res));
  t('本软件自己导出的数组也进得来', !!res && res.length === 2, res ? String(res.length) : 'null');
  const by = (tt) => (res || []).find(e => e.title === tt) || {};
  t("自家字段 pos:'always' 不能掉成 front", by('自家常驻').pos === 'always',
    JSON.stringify(by('自家常驻')));
  t('常驻条目不会被误报「没有触发词」', by('自家常驻').review === false,
    JSON.stringify(by('自家常驻')));
  t('自家字段 on:false 不能变 true', by('自家关着的').on === false,
    JSON.stringify(by('自家关着的')));
  t('自家字段 keys 照常解析', (by('自家关着的').keys || []).includes('自家词'));
}

console.log('');
console.log('  JS 错误: ' + (errs.length ? JSON.stringify(errs.slice(0,3)) : '无'));
t('无 JS 错误', errs.length === 0, errs.join(' | '));

console.log('');
console.log('========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
