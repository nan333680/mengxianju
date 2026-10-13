// e2e-grouppages.mjs — 群设置页（一级）/ 群成员页（二级）（v0.4.1.4）
//
// 起因（用户的原话）：群设置要"参考 QQ/微信群设置那个形态" ——
//   ① 一级页：群头像 + 群名 + 成员九宫格 + 群设定 + 发言方式 + 输出
//   ② 点群员头像 → 二级页"像单独角色那样"改她的东西
//   ③ 群内改【绝不】影响单聊
// 顺带钉住两处静默截断（复查清单 §9.1/§9.2）：保存 slice(0,3000) 而注入 slice(0,400)，
// 用户写了 3000 字只有 400 字进上下文，界面上一个字都没提。
import puppeteer from 'puppeteer-core';
import { seedChars } from './e2e-helper.mjs';
import http from 'http'; import fs from 'fs'; import path from 'path';
const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');
const WWW = R + '/www';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8' };
const NL = String.fromCharCode(10);
let pass = 0, fail = 0;
const t = (n, ok, ex) => { if (ok) { pass++; console.log('  OK   ' + n); } else { fail++; console.log('  FAIL ' + n + (ex !== undefined ? '  -> ' + JSON.stringify(ex) : '')); } };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = path.join(WWW, p);
  if (!fs.existsSync(f)) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 120000,
  args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = []; page.on('pageerror', e => errs.push(e.message));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let chatReq = null;
await page.setRequestInterception(true);
page.on('request', req => {
  if (req.url().includes('/chat/completions')) {
    if (req.method() === 'OPTIONS') { req.respond({ status: 204, headers: { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Headers':'*', 'Access-Control-Allow-Methods':'*' } }); return; }
    try { const b = JSON.parse(req.postData() || '{}'); if (b.stream) chatReq = b; } catch (e) { /* ignore */ }
    const chunk = JSON.stringify({ choices: [{ delta: { content: '【甲】嗯。' } }] });
    req.respond({ status: 200, headers: { 'Access-Control-Allow-Origin':'*' }, contentType: 'text/event-stream',
      body: 'data: ' + chunk + NL + NL + 'data: [DONE]' + NL + NL }); return;
  }
  req.continue();
});
// ── 工具 ────────────────────────────────────────────────
const gGet = () => page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const g = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').get('ggrp1'); q.onsuccess = () => r(q.result); });
  const a = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').get('ga'); q.onsuccess = () => r(q.result); });
  db.close();
  return { g: g, a: a };
});
const val = (id) => page.evaluate((x) => { const el = document.getElementById(x); return el ? el.value : null; }, id);
const txt = (id) => page.evaluate((x) => { const el = document.getElementById(x); return el ? el.textContent : null; }, id);
const setVal = async (id, v) => page.evaluate((o) => {
  const el = document.getElementById(o.id);
  el.value = o.v;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}, { id: id, v: v });
const click = async (id) => { await page.evaluate((x) => { const el = document.getElementById(x); if (el) el.click(); }, id); await sleep(500); };
const active = () => page.evaluate(() => [...document.querySelectorAll('.view.active')].map(v => v.id));
const send = async (s) => {
  await page.evaluate(x => { const el = document.getElementById('input'); el.value = x; el.dispatchEvent(new Event('input', { bubbles: true })); }, s);
  await sleep(150);
  await page.evaluate(() => document.getElementById('btn-send').click());
  for (let i = 0; i < 80; i++) { await sleep(300); const b = await page.$eval('#btn-stop', e => !e.classList.contains('hidden')).catch(() => false); if (!b) break; }
  await sleep(500);
};

await page.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'networkidle0', timeout: 40000 });
await sleep(1200);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil: 'networkidle0' }); await sleep(600);
await seedChars(page, [{ name: '甲', id: 'ga' }, { name: '乙', id: 'gb' }, { name: '丙', id: 'gc' }]);
await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const put = (st, rec) => new Promise(r => { const tx = db.transaction(st, 'readwrite'); tx.objectStore(st).put(rec); tx.oncomplete = r; });
  const rec = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get('settings'); q.onsuccess = () => r(q.result); });
  await put('kv', { k: 'settings', v: Object.assign({}, (rec && rec.v) || {}, { apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com', longMemory: false }) });
  await put('characters', { id: 'ggrp1', name: '周末茶会', isGroup: true, memberIds: ['ga','gb','gc'],
    groupNote: '每周六喝茶', speakMode: 'round', turnIndex: 0, avatar: null, greeting: '（三个人都在。）',
    presetKey: 'blank', createdAt: Date.now() });
  db.close();
});
await page.reload({ waitUntil: 'networkidle0' }); await sleep(1200);
await page.evaluate(() => { [...document.querySelectorAll('#char-list .char-card')].find(x => x.dataset.id === 'ggrp1').click(); });
await sleep(1400);

console.log('=== 1. 一级页：点顶栏群名进的是整页，不是弹窗 ===');
await page.evaluate(() => document.getElementById('chat-titletxt').click());
await sleep(800);
t('进的是 view-group', (await active()).includes('view-group'), await active());
t('通用弹窗没有弹出来', await page.evaluate(() => document.getElementById('modal').classList.contains('hidden')), '');
t('群名回填了', (await val('g-name')) === '周末茶会', await val('g-name'));
t('成员九宫格画了 3 个人', (await page.evaluate(() => document.querySelectorAll('#g-members [data-gm]').length)) === 3, '');
t('末尾有一个「＋ 加人」格子', await page.evaluate(() => !!document.querySelector('#g-members [data-gm-add]')), '');
t('副标题写了人数和发言方式', String(await txt('g-sub')).includes('3 个人'), await txt('g-sub'));
for (const id of ['g-note','g-he','g-place','g-home','g-mode','g-len','g-narr','g-silence','g-auto','g-ownparams','g-temp','g-maxtok','g-wb-open','g-mem-open','g-del','g-avatar-pick']) {
  t('一级页有 #' + id, await page.evaluate((x) => !!document.getElementById(x), id), '');
}
t('群设定回填了', (await val('g-note')) === '每周六喝茶', '');

console.log('=== 1.5 群世界书：先给一个"带进来了什么"的面板 ===');
// v0.4.1.6：这一行原来直接跳去"这个群自己的条目页"—— 那一页默认是空的，
// 用户看到空页就以为"世界书在群里没生效"（他实测就是这么问的）。
await page.evaluate(() => document.getElementById('g-wb-open').click());
await sleep(900);
const wbPanel = await page.evaluate(() => ({
  open: !document.getElementById('modal').classList.contains('hidden'),
  title: document.getElementById('modal-title').textContent,
  text: document.getElementById('modal-text').textContent,
}));
t('开的是面板，不是一个空页', wbPanel.open === true && wbPanel.title.includes('世界书'), wbPanel.title);
t('面板里说清了"成员带进来的也生效"', wbPanel.text.includes('成员带进来的'), '');
t('并且报了这个群里一共有多少条在生效', wbPanel.text.includes('在生效'), '');
await page.evaluate(() => document.getElementById('modal-ok').click());
await sleep(900);
t('面板上的按钮能进这个群自己的条目页', (await active()).includes('view-wbsolo'), await active());
t('条目页标题是这个群', String(await txt('wbs-title')).includes('茶会'), await txt('wbs-title'));
await page.evaluate(() => document.getElementById('btn-wbs-back').click());
await sleep(700);
t('返回一级页', (await active()).includes('view-group'), await active());

console.log('=== 1.6 折叠 / 加人只有一个入口 / 表达方式 / 旁白开关 ===');
const foldSt = await page.evaluate(() => ['members','set','talk','scene','style','params','data'].map(k => {
  const w = document.getElementById('gfw-' + k);
  return k + ':' + (w && w.classList.contains('open') ? 'open' : 'closed');
}));
console.log('   ' + JSON.stringify(foldSt));
t('群设定那一块是折叠块，而且默认展开', foldSt.includes('set:open'), foldSt);
t('表达方式默认收着', foldSt.includes('style:closed'), foldSt);
t('「加人」只有一个入口（九宫格末尾那个 ＋）', !(await page.evaluate(() => !!document.getElementById('g-add-member'))) && await page.evaluate(() => !!document.querySelector('#g-members [data-gm-add]')), '');
await page.evaluate(() => document.getElementById('gf-style').click());
await sleep(300);
t('点折叠头能展开', await page.evaluate(() => document.getElementById('gfw-style').classList.contains('open')), '');
t('不勾"用自己的表达方式"时整块是灰的、点不动', await page.evaluate(() => document.getElementById('g-style-box').classList.contains('off-box')), '');
await page.evaluate(() => { const c = document.getElementById('g-ownstyle'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); });
await sleep(400);
t('勾上之后控件活了', await page.evaluate(() => !document.getElementById('g-style-box').classList.contains('off-box')), '');
t('叙事视角那一排画出来了（5 档）', (await page.evaluate(() => document.getElementById('g-pov').children.length)) === 5, '');
t('视角说明跟着当前档位走', String(await page.evaluate(() => document.getElementById('g-pov-note').textContent)).length > 8, '');
await page.evaluate(() => {
  document.getElementById('g-verbosity').value = 'short';
  document.getElementById('g-pov').dataset.v = 'L2';
  document.getElementById('g-narr-on').checked = false;
});
await click('btn-group-save');
await sleep(900);
// ⚠️ 变量名别再用 st —— 下面第 2 节才 `let st`，在这里赋值会撞 TDZ
const st16 = await gGet();
t('表达方式写进了群记录', st16.g.verbosity === 'short' && st16.g.povStyle === 'L2', { v: st16.g.verbosity, p: st16.g.povStyle });
t('旁白开关也存下来了', st16.g.showNarration === false, st16.g.showNarration);
t('小字变成「本群自定义」', (await txt('g-style-brief')) === '本群自定义', await txt('g-style-brief'));
t('她的角色卡没被改', !st16.a || st16.a.verbosity !== 'short', st16.a && st16.a.verbosity);

console.log('=== 2. 改群名 → 保存 → 库里和列表都变 ===');
await setVal('g-name', '周六茶会');
await click('btn-group-save');
await sleep(500);
let st = await gGet();
t('库里群名变了', st.g.name === '周六茶会', st.g.name);
t('角色列表跟着变了', await page.evaluate(() => document.getElementById('char-list').textContent.includes('周六茶会')), '');
t('人设重算过（成员名单还在）', String(st.g.persona).includes('甲'), '');

console.log('=== 3. 二级页：点她的头像进去 ===');
await page.evaluate(() => document.querySelector('#g-members [data-gm]').click());
await sleep(700);
t('进的是 view-gmember', (await active()).includes('view-gmember'), await active());
t('标题是她的名字', (await txt('gm-name')) === '甲', await txt('gm-name'));
t('写清了只影响这个群', String(await txt('gm-sub')).includes('只影响这个群'), await txt('gm-sub'));
for (const id of ['gm-persona-open','gm-note-open','gm-views-open','gm-params-open','gm-talk','gm-muted','gm-full','gm-reset']) {
  t('二级页有 #' + id, await page.evaluate((x) => !!document.getElementById(x), id), '');
}
t('群内人设默认写「跟随她本人」', (await txt('gm-persona-brief')) === '跟随她本人', await txt('gm-persona-brief'));
t('群内补充默认写「没写」', (await txt('gm-note-brief')) === '没写', '');

console.log('=== 4. 群内补充：上限 300（原来存 500 / 注入 200，静默丢字） ===');
const NOTE = 'x'.repeat(280) + 'MARKER280' + 'y'.repeat(600);
await click('gm-note-open');
await setVal('gn-note', NOTE);
const cntTxt = await txt('gn-cnt');
t('编辑框报了字数和上限', String(cntTxt).includes('300'), cntTxt);
await click('modal-ok');
await sleep(700);
st = await gGet();
t('库里只存 300 字', String(st.g.memberCfg.ga.note).length === 300, String(st.g.memberCfg.ga.note).length);
t('第 280 字之后的内容真的进了群人设（旧上限 200 会截掉它）', String(st.g.persona).includes('MARKER280'), '');
t('二级页小字跟着变', String(await txt('gm-note-brief')).startsWith('xxxxxxxxxxxxxx'), await txt('gm-note-brief'));

console.log('=== 5. 群内人设：条目化（可增删）+ 上限放开到 1500（旧上限 400） ===');
await click('gm-persona-open');
t('编辑器里有「＋ 加一条」', await page.evaluate(() => !!document.getElementById('gp-add')), '');
await page.evaluate(() => document.getElementById('gp-add').click());
await sleep(300);
t('能加成两条', (await page.evaluate(() => document.querySelectorAll('.gp-item').length)) === 2, '');
const BODY = 'z'.repeat(500) + 'MARKER500' + 'w'.repeat(200);
await page.evaluate((o) => {
  document.querySelector('[data-t="0"]').value = '她的性格';
  document.querySelector('[data-x="0"]').value = o.b;
  document.querySelector('[data-t="1"]').value = '她跟乙';
  document.querySelector('[data-x="1"]').value = '她跟乙最熟。';
}, { b: BODY });
await click('modal-ok');
await sleep(800);
st = await gGet();
t('库里存成了条目数组', Array.isArray(st.g.memberCfg.ga.personaItems) && st.g.memberCfg.ga.personaItems.length === 2, JSON.stringify(st.g.memberCfg.ga.personaItems || null).slice(0, 120));
t('条目正文超过 400 字也没被截（旧上限 400 会截掉 MARKER500）', String(st.g.persona).includes('MARKER500'), '');
t('群人设里带上了条目标题', String(st.g.persona).includes('她的性格'), '');
t('二级页小字变成「已覆盖 · 2 条」', (await txt('gm-persona-brief')) === '已覆盖 · 2 条', await txt('gm-persona-brief'));
await click('gm-persona-open');
const filled = await page.evaluate(() => [...document.querySelectorAll('.gp-item')].map(x => x.querySelector('[data-t]').value));
t('再打开时内容回填了', filled.length === 2 && filled[0] === '她的性格', filled);
await click('modal-cancel');
await sleep(300);

console.log('=== 6. 她怎么看群里这些人（v0.4.1.4 新增） ===');
await click('gm-views-open');
const rows = await page.evaluate(() => [...document.querySelectorAll('#modal-text [data-v]')].map(x => x.dataset.v));
t('给她列了另外两个人（不含她自己）', rows.length === 2 && !rows.includes('ga'), rows);
await page.evaluate(() => { document.querySelector('[data-v="gb"]').value = '比他细心，也更会照顾人'; });
await click('modal-ok');
await sleep(700);
st = await gGet();
t('存进了 memberCfg.views', st.g.memberCfg.ga.views && st.g.memberCfg.ga.views.gb === '比他细心，也更会照顾人', JSON.stringify(st.g.memberCfg.ga.views || null));
t('群人设里出现「她私下怎么看别人：乙——…」', String(st.g.persona).includes('她私下怎么看别人：乙——比他细心'), '');
t('二级页小字变成 1 条', (await txt('gm-views-brief')) === '1 条', await txt('gm-views-brief'));

console.log('=== 7. 群所在的地方 + 这个群里的「他住哪」 ===');
await click('btn-gm-back');
await sleep(600);
t('返回一级页', (await active()).includes('view-group'), await active());
await setVal('g-place', '南方小城，梅雨季。老居民楼六层。');
await setVal('g-home', '群里的他住在城西一间带院子的平房。');
await click('btn-group-save');
await sleep(700);
st = await gGet();
t('placeNote 进了库', st.g.placeNote === '南方小城，梅雨季。老居民楼六层。', st.g.placeNote);
t('群人设里有【这个地方】', String(st.g.persona).includes('【这个地方】'), '');
t('myEnv 进了库', st.g.myEnv === '群里的他住在城西一间带院子的平房。', st.g.myEnv);

console.log('=== 8. 群自己的参数（三态：勾了才写，不勾就删） ===');
await page.evaluate(() => { const el = document.getElementById('g-ownparams'); el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); });
await setVal('g-temp', '1.7');
await click('btn-group-save');
await sleep(700);
st = await gGet();
t('勾上后写进群记录', Number(st.g.temperature) === 1.7, st.g.temperature);
await page.evaluate(() => { const el = document.getElementById('g-ownparams'); el.checked = false; el.dispatchEvent(new Event('change', { bubbles: true })); });
await click('btn-group-save');
await sleep(700);
st = await gGet();
t('不勾后键被删掉（跟随全局，不是留一份快照）', !('temperature' in st.g) && !('maxTokens' in st.g), Object.keys(st.g).filter(k => k === 'temperature' || k === 'maxTokens'));

console.log('=== 9. 她自己的参数：群里真的生效（复查清单 §9.3） ===');
await page.evaluate(() => document.querySelector('#g-members [data-gm="ga"]').click());
await sleep(700);
await click('gm-params-open');
await page.evaluate(() => { const el = document.getElementById('gmp-own'); el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); });
await setVal('gmp-temp', '1.8');
await click('modal-ok');
await sleep(700);
st = await gGet();
t('存进 memberCfg.params', st.g.memberCfg.ga.params && Number(st.g.memberCfg.ga.params.temperature) === 1.8, JSON.stringify(st.g.memberCfg.ga.params || null));
t('二级页小字显示温度', String(await txt('gm-params-brief')).includes('1.80'), await txt('gm-params-brief'));
t('她的角色卡【没有】被改', !st.a || st.a.temperature === undefined || st.a.temperature !== 1.8, st.a && st.a.temperature);
await click('btn-gm-back');
await sleep(500);
chatReq = null;
await send('在吗');
t('这一轮的请求温度就是她的 1.8', chatReq && Number(chatReq.temperature) === 1.8, chatReq && chatReq.temperature);
t('稳定前缀里带上了「群里的他住哪」', !!chatReq && (chatReq.messages || []).some(m => String(m.content || '').includes('群里的他住在城西')), '');
t('本轮段里带上了「她私下怎么看别人」', !!chatReq && (chatReq.messages || []).some(m => String(m.content || '').includes('她私下怎么看别人')), '');

console.log('=== 10. 发言方式：概率 + 试一次 ===');
await page.evaluate(() => document.getElementById('chat-titletxt').click());
await sleep(700);
await setVal('g-mode', 'weight');
await click('btn-group-save');
await sleep(600);
t('在场条的标签变成「概率」', await page.evaluate(() => document.getElementById('group-roster').textContent.includes('概率')), '');
t('副标题也跟着变', String(await txt('g-sub')).includes('抽人开口'), await txt('g-sub'));
await click('g-try');
const prev = await txt('g-try-out');
t('「试一次」给出了每个人的概率', String(prev).includes('%') && String(prev).includes('甲'), prev);
// 活跃度：甲 0、乙 100
await page.evaluate(() => document.querySelector('#g-members [data-gm="ga"]').click());
await sleep(600);
await setVal('gm-talk', '0');
await click('btn-gm-save');
await sleep(600);
st = await gGet();
t('活跃度 0 存进库', Number(st.g.memberCfg.ga.talk) === 0, JSON.stringify(st.g.memberCfg.ga.talk));
await click('btn-gm-back');
await sleep(500);
await click('g-try');
const prev2 = await txt('g-try-out');
t('概率预览里甲是 0%', String(prev2).includes('甲 0%'), prev2);
await page.evaluate(() => document.querySelector('#g-members [data-gm="ga"]').click());
await sleep(600);
await page.evaluate(() => { const el = document.getElementById('gm-muted'); el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); });
await click('btn-gm-save');
await sleep(600);
st = await gGet();
t('少开口存进库', st.g.memberCfg.ga.muted === true, '');
await click('btn-gm-back');
await sleep(500);
t('九宫格上标了「少开口」', await page.evaluate(() => document.querySelector('#g-members [data-gm="ga"]').textContent.includes('少开口')), '');

console.log('=== 11. 恢复成跟随她本人 / 长按移出 ===');
await page.evaluate(() => document.querySelector('#g-members [data-gm="ga"]').click());
await sleep(600);
await click('gm-reset');
await sleep(400);
await page.evaluate(() => document.getElementById('modal-ok').click());
await sleep(800);
st = await gGet();
t('清完之后这个人整个从 memberCfg 里消失（不留空壳）', !(st.g.memberCfg && st.g.memberCfg.ga), JSON.stringify(Object.keys((st.g.memberCfg) || {})));
t('她的角色卡还是原样', !!st.a && st.a.name === '甲', st.a && st.a.name);
await click('btn-gm-back');
await sleep(500);
// 长按（合成 touchstart + 等 600ms）
await page.evaluate(() => {
  const el = document.querySelector('#g-members [data-gm="gb"]');
  const ev = new Event('touchstart', { bubbles: true });
  el.dispatchEvent(ev);
});
await sleep(900);
const confirmShown = await page.evaluate(() => !document.getElementById('modal').classList.contains('hidden'));
t('长按成员弹出确认框', confirmShown, '');
if (confirmShown) { await click('modal-cancel'); await sleep(300); }
t('没有页面报错', errs.length === 0, errs.slice(0, 3));

console.log('');
console.log('通过 ' + pass + ' / 失败 ' + fail);
await browser.close();
server.close();
process.exit(fail ? 1 : 0);
