// e2e-outline.mjs — 剧情小纲（0.5.8.9）端到端回归
//
// 这一版加的是「发之前先看一眼这一轮怎么演，能改，改完再发」。
// 本套件盯的是它最容易坏、且坏了不报错的地方：
//   1) 表驱动：加一行 TURN_CMDS 之后，抽屉 / 参数槽 / 气泡 chip / 手打命令全都得跟上
//      —— 特别是手打命令，原来是三元兜底，新命令会被【静默算成剧情方向】
//   2) 不挂小纲时提示词逐字不变（注入条件是 if (outline)）
//   3) 挂了之后正文提示词里真有那一段，且措辞是「别再多推一步」
//   4) 判断层也读得到小纲（B 型偏就发生在 director → 正文 这条链上）
//   5) 重生成【不重跑】小纲 —— 这条是免费的（restoreTurn 回填 tag），所以只防"别做坏"
import puppeteer from 'puppeteer-core';
import http from 'http'; import fs from 'fs'; import path from 'path';
import { readCode } from './e2e-src.mjs';
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

// 小纲那趟的识别标记：outlineAsk 的指令里独有的一句。
// ⚠️ 不能用 stream:true/false 区分 —— 判断层、独白也是非流式。
const OUTLINE_MARK = '先别写回复';
const OUTLINE_REPLY = [
  '她这轮怎么演：蕾米不接你的话，先把杯子放下，笑了一下才开口',
  '到哪儿为止：芙兰这轮只说一句，不给她动作',
  '别碰：这轮只有蕾米和芙兰出声'
].join(String.fromCharCode(10));

let outlineReqs = 0, mainReqs = 0;
let lastMainSys = '', lastOutlineSys = '';
await page.setRequestInterception(true);
page.on('request', req => {
  const u = req.url();
  if (u.includes('deepseek') || u.includes('/chat/completions')) {
    if (req.method()==='OPTIONS') { req.respond({status:204,headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'*'}}); return; }
    const b = JSON.parse(req.postData()||'{}');
    const joined = (b.messages||[]).map(m=>m.content||'').join(String.fromCharCode(10));
    if (joined.includes(OUTLINE_MARK)) {
      outlineReqs++; lastOutlineSys = joined;
      req.respond({status:200,headers:{'Access-Control-Allow-Origin':'*'},contentType:'application/json',
        body:JSON.stringify({choices:[{message:{content:OUTLINE_REPLY}}]})}); return;
    }
    mainReqs++; lastMainSys = joined;
    if (b.stream) {
      const pl='data: '+JSON.stringify({choices:[{delta:{content:'好。'}}]})+String.fromCharCode(10,10)+'data: [DONE]'+String.fromCharCode(10,10);
      req.respond({status:200,headers:{'Access-Control-Allow-Origin':'*'},contentType:'text/event-stream',body:pl}); return;
    }
    req.respond({status:200,headers:{'Access-Control-Allow-Origin':'*'},contentType:'application/json',body:JSON.stringify({choices:[{message:{content:'{}'}}]})}); return;
  }
  req.continue();
});

const putDB = (store, rec) => page.evaluate(async (s, r2) => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => o.onsuccess = () => r(o.result));
  await new Promise(r => { const tx = db.transaction(s,'readwrite'); tx.objectStore(s).put(r2); tx.oncomplete = r; });
  db.close();
}, store, rec);
const getDB = (store, key) => page.evaluate(async (s, k) => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => o.onsuccess = () => r(o.result));
  const v = await new Promise(r => { const q = db.transaction(s).objectStore(s).get(k); q.onsuccess = () => r(q.result); });
  db.close(); return v || null;
}, store, key);
const allMsgs = () => page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => o.onsuccess = () => r(o.result));
  const v = await new Promise(r => { const q = db.transaction('messages').objectStore('messages').getAll(); q.onsuccess = () => r(q.result||[]); });
  db.close(); return v;
});
const gotoChar = async (name) => {
  await page.evaluate((n) => { const c=[...document.querySelectorAll('#char-list .char-card')].find(x=>x.textContent.includes(n)); if(c)c.click(); }, name);
  await sleep(800);
};
const waitIdle = async () => {
  for (let i=0;i<30;i++){ await sleep(300); const b=await page.$eval('#btn-stop',e=>!e.classList.contains('hidden')).catch(()=>false); if(!b) break; }
  await sleep(500);
};
const typeText = (s) => page.evaluate((x) => { const i=document.getElementById('input'); i.value=x; i.dispatchEvent(new Event('input',{bubbles:true})); }, s);

await page.goto('http://127.0.0.1:'+port+'/index.html', { waitUntil:'networkidle0' });
await sleep(900);

console.log('=== 1. 表驱动：一张表要派生五处（源码契约）===');
{
  const app = readCode(WWW + '/js/app.js');
  const po = readCode(WWW + '/js/plotoutline.js');
  t('TURN_CMDS 里有剧情小纲（cmd = 纲）',
    app.includes("k: 'outline'") && app.includes("cmd: '纲'") && app.includes("label: '剧情小纲'"));
  // ⚠️ 这条是「改成查表会砍掉现成命令」的守门人：
  //    原来的正则里写着「剧情」，靠三元兜底映射到 plot；表里没有这个 cmd 就失效了。
  t('plot 把「剧情」这个别名搬进了表里（aliases）',
    /k: 'plot'[^}]*aliases: \['剧情'\]/.test(app), '');
  t('手打命令改成了查表，没有三元兜底',
    app.includes('const _SLASH_CMD_K') && !app.includes("m[1] === '搜' ? 'search'"));
  t('正则从表里拼，且做了转义',
    app.includes("const names = [..._SLASH_CMD_K.keys()].map(_reEsc).join('|')"));
  t('输入行下面那排 chip：小纲只显示名字，不拼三行参数',
    app.includes("const arg = (c.k === 'outline' ? '' : c.arg);"));
  t('参数槽里只有小纲那一行有「生成」按钮',
    app.includes('data-gen="outline"') && app.includes("c.k === 'outline'"));
  t('生成请求：384 + 关思考（noThink，不是 reasoningEffort:off）',
    po.includes('const OUTLINE_MAX_TOKENS = 384') && po.includes('noThink: true') && !po.includes('reasoningEffort'),
    '');
  t('生成失败不碰参数槽（原内容没动）', app.includes('小纲没生成出来，原内容没动'));
  t('参数槽已有内容时先确认再覆盖', app.includes('会覆盖你现在写的内容'));
  // 重生成不重跑小纲：regenerate 里不许出现 genOutline 调用。
  const rStart = app.indexOf('async function regenerate(');
  const rEnd = app.indexOf('async function', rStart + 10);
  t('regenerate() 里没有调 genOutline（⟳ 不重跑小纲）',
    rStart > 0 && rEnd > rStart && !app.slice(rStart, rEnd).includes('genOutline'));
}

console.log('');
console.log('=== 2. 注入段：位置、措辞、三处接线（源码契约）===');
{
  const per = readCode(WWW + '/js/persona.js');
  const dir = readCode(WWW + '/js/director.js');
  const app = readCode(WWW + '/js/app.js');
  t('persona 有「这一轮按这个演」那一段', per.includes('# 这一轮按这个演'));
  t('措辞含「别自己再往下多推一步」', per.includes('别自己再往下多推一步'));
  t('措辞含「只改发生什么，不改怎么写」', per.includes('它只改「发生什么」，不改「怎么写」'));
  // 位置：必须在「本轮更改」之前 push —— parts 按顺序，越靠后权重越高，
  // 而小纲是硬性安排，要贴着生成点给。放在 plot 后面（2309）会排到判断层前面。
  const iInj = per.indexOf('# 这一轮按这个演');
  const iDir = per.indexOf('# 这一轮的额外要求');
  t('注入段排在「额外要求」之前（pin 在 askAvoid 与 directives 之间）',
    iInj > 0 && iDir > 0 && iInj < iDir, { iInj, iDir });
  t('判断层也读小纲（director.js 有那一段）', dir.includes('# 他这一轮已经定好的安排'));
  t('判断层的措辞也写了「别越过它再自己往前推一步」', dir.includes('不要越过它再自己往前推一步'));
  t('send() 把 outline 传给判断层 / 正文 / turnInj（三处）',
    (app.match(/outline: \(_cmds\.find\(c => c\.k === 'outline' && c\.arg\) \|\| \{\}\)\.arg \|\| ''/g) || []).length === 3,
    '');
  t('turnInj 里的小纲没被 _cut 截断', !app.includes("outline: _cut("));
}

console.log('');
console.log('=== 3. 造数 + 参数槽：空正文时「生成」必须禁用 ===');
await putDB('characters', { id:'c-ok', name:'小纲测试', avatar:null, greeting:'（她抬眼看你）',
  persona:'你是一个测试角色，说话简短。', createdAt:Date.now(),
  longMemory:false, splitMessages:false });
{
  const st = await getDB('kv', 'settings') || { k:'settings', v:{} };
  st.v = st.v || {};
  st.v.apiKey = 'sk-test';
  st.v.baseUrl = st.v.baseUrl || 'https://api.deepseek.com';
  await putDB('kv', st);
}
await page.reload({ waitUntil:'networkidle0' }); await sleep(1100);
await gotoChar('小纲测试');
await page.evaluate(() => document.getElementById('btn-plus').click());
await sleep(250);
{
  const items = await page.evaluate(() => [...document.querySelectorAll('#cmd-drawer .cmd-item')].map(b => b.textContent.trim()));
  console.log('   抽屉: ' + JSON.stringify(items));
  t('抽屉里有「剧情小纲」', items.some(x => x.includes('剧情小纲')), JSON.stringify(items));
}
await page.evaluate(() => { const b = document.querySelector('#cmd-drawer [data-cmd="outline"]'); if (b) b.click(); });
await sleep(350);
{
  const s = await page.evaluate(() => {
    const ta = document.querySelector('#cmd-slots textarea[data-cmd="outline"]');
    const btn = document.querySelector('#cmd-slots [data-gen="outline"]');
    return { hasTa: !!ta, hasBtn: !!btn, disabled: btn ? btn.disabled : null };
  });
  t('参数槽出现一行小纲', s.hasTa);
  t('那一行有「生成」按钮', s.hasBtn);
  t('正文框空着时「生成」禁用（空着生成 = 小纲必瞎编）', s.disabled === true, JSON.stringify(s));
}
await typeText('我来看看');
await sleep(250);
{
  const disabled = await page.evaluate(() => {
    const b = document.querySelector('#cmd-slots [data-gen="outline"]');
    return b ? b.disabled : null;
  });
  t('打了字之后「生成」可点', disabled === false, String(disabled));
}

console.log('');
console.log('=== 4. 生成：请求带正文框内容，结果填回参数槽 ===');
{
  const before = outlineReqs;
  await page.evaluate(() => { const b = document.querySelector('#cmd-slots [data-gen="outline"]'); if (b) b.click(); });
  for (let i=0;i<40;i++){ await sleep(250); if (outlineReqs > before) break; }
  await sleep(600);
  t('点「生成」发出了小纲请求', outlineReqs === before + 1, 'before=' + before + ' now=' + outlineReqs);
  // 验收第 5 条：两次请求的上下文可以不同（小纲不带判断层），但正文框必须带。
  t('小纲请求里带着他刚打的字', lastOutlineSys.includes('我来看看'));
  t('小纲请求里没有「这一轮按这个演」（它还没发）', !lastOutlineSys.includes('# 这一轮按这个演'));
  const val = await page.evaluate(() => {
    const ta = document.querySelector('#cmd-slots textarea[data-cmd="outline"]');
    return ta ? ta.value : '';
  });
  console.log('   槽里: ' + JSON.stringify(val.slice(0, 80)));
  t('三行原样填回了参数槽', val.includes('她这轮怎么演：') && val.includes('到哪儿为止：') && val.includes('别碰：'), val.slice(0, 120));
  t('没有截断：三行都在', val.split(String.fromCharCode(10)).filter(Boolean).length === 3, JSON.stringify(val));
}

console.log('');
console.log('=== 5. 发送：正文提示词里真有那一段，消息 tags 里也有 ===');
{
  await page.evaluate(() => document.getElementById('btn-send').click());
  await waitIdle();
  t('正文请求确实带上了小纲那一段', lastMainSys.includes('# 这一轮按这个演'), String(lastMainSys.length));
  t('正文请求里含「具体处按这份来」', lastMainSys.includes('具体处按这份来'));
  t('正文请求里含「别自己再往下多推一步」', lastMainSys.includes('别自己再往下多推一步'));
  t('正文请求里含「别碰」那句约束', lastMainSys.includes('「别碰」里列的，这一轮不要出现'));
  const ms = await allMsgs();
  const u = ms.find(m => m.role === 'user' && String(m.content||'').includes('我来看看'));
  console.log('   user tags: ' + JSON.stringify(u && u.tags));
  t('小纲落进了那条用户消息的 tags', !!u && Array.isArray(u.tags) && u.tags.some(x => x.k === 'outline' && String(x.arg||'').includes('到哪儿为止')));
  // 气泡 chip 只显示名字（带 title 看全文），三行不能糊在时间行上
  const chip = await page.evaluate(() => {
    const c = [...document.querySelectorAll('.msg .tag-chip')].find(x => x.textContent.includes('剧情小纲'));
    return c ? { text: c.textContent, title: c.title } : null;
  });
  t('气泡 chip 只显示名字，不含三行正文',
    !!chip && !chip.text.includes('到哪儿为止') && chip.text.includes('剧情小纲'), JSON.stringify(chip));
}

console.log('');
console.log('=== 6. 不挂小纲时：提示词里一个字都不多 ===');
{
  // 把这一轮挂着的小纲撤掉，再发一条 —— 这是验收第 1 条。
  await page.evaluate(() => {
    const x = document.querySelector('#cmd-slots [data-del="outline"]');
    if (x) x.click();
  });
  await sleep(300);
  await typeText('再来一句');
  await sleep(200);
  await page.evaluate(() => document.getElementById('btn-send').click());
  await waitIdle();
  t('没挂小纲时提示词里没有那一段', !lastMainSys.includes('# 这一轮按这个演'));
  t('也没挂住「按这个演」的残留行', !lastMainSys.includes('具体处按这份来'));
}

console.log('');
console.log('=== 7. 手打命令：/剧情 还是剧情方向，/纲 是剧情小纲 ===');
{
  await typeText('/剧情 她开始起疑心');
  await sleep(200);
  await page.evaluate(() => document.getElementById('btn-send').click());
  await waitIdle();
  let ms = await allMsgs();
  let last = ms.filter(m => m.role === 'user').slice(-1)[0];
  const k1 = last && Array.isArray(last.tags) ? last.tags.map(x => x.k) : [];
  console.log('   /剧情 -> ' + JSON.stringify(k1));
  t('/剧情 仍然映射到剧情方向（别名没因为改成查表而丢）', k1.includes('plot'), JSON.stringify(k1));
  t('/剧情 没有被当成剧情小纲', !k1.includes('outline'), JSON.stringify(k1));

  await typeText('/纲 只撂话，不真把人带走');
  await sleep(200);
  await page.evaluate(() => document.getElementById('btn-send').click());
  await waitIdle();
  ms = await allMsgs();
  last = ms.filter(m => m.role === 'user').slice(-1)[0];
  const k2 = last && Array.isArray(last.tags) ? last.tags.map(x => x.k) : [];
  const a2 = last && Array.isArray(last.tags) ? (last.tags.find(x => x.k === 'outline') || {}).arg : '';
  console.log('   /纲 -> ' + JSON.stringify(k2) + ' arg=' + JSON.stringify(a2));
  t('/纲 映射到剧情小纲（不是三元兜底到剧情方向）', k2.includes('outline') && !k2.includes('plot'), JSON.stringify(k2));
  t('/纲 的参数原样落库', String(a2||'').includes('只撂话'));
}

console.log('');
console.log('  JS 错误: ' + (errs.length ? JSON.stringify(errs.slice(0,3)) : '无'));
t('无 JS 错误', errs.length === 0, errs.join(' | '));

console.log('');
console.log('========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
