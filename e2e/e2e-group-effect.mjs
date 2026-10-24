// e2e-group-effect.mjs —— 群设置【全部】是否【同一轮就生效】（v0.4.2.1）
//
// 起因（用户原话）：
//   「我记得有次是旁白还是视角问题还是『小说式一幕』有延迟生效，没记错的话。」
// 这句话是一份【可证伪的指控】：改完设置之后，那一轮到底用没用上新值。
// 所以这套件不查界面回填、不查库里的值 —— 那些 e2e-grouppages 已经查过了。
// 它查的是【发出去的那一份请求】和【落库的那几条消息】：
//   · 小说式一幕（narrative）→ 提示词里有没有「# 这一幕怎么写」
//   · 篇幅档位（sceneLen）  → 提示词里写的是不是那一档的字数
//   · 旁白开关（showNarration）→ ①提示词里是"要求括号旁白"还是"每行都要名字"
//                                ②【解析结果】：没标名字又被括号包住的那一行，
//                                  是变成一条旁白（.narr），还是挂在上一个说话人头上
//   · 叙事视角（povStyle）  → 稳定前缀里是哪一档（还是整段不注入）
//   · 自动续一幕（autoScene）→ 这一轮完了之后有没有真的自己再接一轮
//   · 允许冷场（allowSilence）→ 会不会插那条「（没人接话）」
//
// ⚠️ 每个开关都【改完立刻发】，绝不"改完再进一次聊天"—— 那样就算有延迟也看不出来。
//    这正是"延迟生效"这类 bug 唯一能被抓住的姿势：设置页是从聊天页顶栏进去的，
//    改完点 ✓ 就退回聊天页，所以在聊天页里的 curChar 必须已经换成了新对象。
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
await page.evaluateOnNewDocument(() => {
  Object.defineProperty(navigator, 'language', { get: () => 'zh-CN', configurable: true });
  Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh'], configurable: true });
});
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = []; page.on('pageerror', e => errs.push(e.message));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 模型这一轮的回复刻意写成两行：
//   第 1 行有名字 → 归甲
//   第 2 行没名字、又被括号包住 → 【旁白开关就决定它属于谁】
const REPLY = '【甲】嗯，我知道了。' + NL + '（窗外风停了，屋里安静下来。）';
const reqs = [];
await page.setRequestInterception(true);
page.on('request', req => {
  if (req.url().includes('/chat/completions')) {
    if (req.method() === 'OPTIONS') { req.respond({ status: 204, headers: { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Headers':'*', 'Access-Control-Allow-Methods':'*' } }); return; }
    let b = null;
    try { b = JSON.parse(req.postData() || '{}'); } catch (e) { b = null; }
    if (b && b.stream) reqs.push(b);
    const chunk = JSON.stringify({ choices: [{ delta: { content: REPLY } }] });
    req.respond({ status: 200, headers: { 'Access-Control-Allow-Origin':'*' }, contentType: 'text/event-stream',
      body: 'data: ' + chunk + NL + NL + 'data: [DONE]' + NL + NL }); return;
  }
  req.continue();
});

const sysOf = (b) => ((b.messages || []).filter(m => m.role === 'system').map(m => m.content).join(NL));
const turnOf = (b) => { const ms = (b.messages || []).filter(m => m.role === 'system'); return ms.length ? ms[ms.length - 1].content : ''; };
const txt = (id) => page.evaluate(x => { const el = document.getElementById(x); return el ? el.textContent : null; }, id);
const val = (id) => page.evaluate(x => { const el = document.getElementById(x); return el ? el.value : null; }, id);
const click = async (id) => { await page.evaluate(x => { const el = document.getElementById(x); if (el) el.click(); }, id); await sleep(400); };
const active = () => page.evaluate(() => [...document.querySelectorAll('.view.active')].map(v => v.id));
const gGet = () => page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const g = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').get('gg2'); q.onsuccess = () => r(q.result); });
  db.close(); return g;
});
/** 进群设置页 → 改值 → 点 ✓ → 退回聊天页（一次都不离开聊天） */
async function groupSave(patch) {
  await click('chat-titletxt');
  await sleep(700);
  await page.evaluate((p) => {
    const $ = (x) => document.getElementById(x);
    if (p.ownStyle !== undefined) { const c = $('g-ownstyle'); if (!!c.checked !== !!p.ownStyle) { c.checked = !!p.ownStyle; c.dispatchEvent(new Event('change', { bubbles: true })); } }
    if (p.narr !== undefined) $('g-narr').checked = !!p.narr;
    if (p.narrOn !== undefined) $('g-narr-on').checked = !!p.narrOn;
    if (p.silence !== undefined) $('g-silence').checked = !!p.silence;
    if (p.len !== undefined) $('g-len').value = p.len;
    if (p.auto !== undefined) $('g-auto').value = String(p.auto);
    if (p.mode !== undefined) $('g-mode').value = p.mode;
    if (p.pov !== undefined) $('g-pov').dataset.v = p.pov;
    if (p.mix !== undefined) $('g-scenemix').value = p.mix;
  }, patch);
  await sleep(250);
  await click('btn-group-save');
  await sleep(800);
  await click('btn-group-back');
  await sleep(500);
}
const msgCount = () => page.evaluate(() => document.querySelectorAll('#messages .msg').length);
const tailMsgs = (n) => page.evaluate((k) => [...document.querySelectorAll('#messages .msg')].slice(-k).map(m => ({
  narr: m.classList.contains('narr'),
  who: (m.querySelector('.who') || {}).textContent || '',
  text: (m.querySelector('.bub') || {}).textContent || ''
})), n);
/** 补写/重写请求（v0.5.3.4）：重写回路会多发一次，带这条指令的就是它，不算「内容请求」 */
const isRetry = (r) => {
  const ms = (r && r.messages) || [];
  const last = ms.filter(m => m.role === 'user').pop() || {};
  return String(last.content || '').includes('上面这条不合格');
};

/** 发一句，等回复结束；返回这一轮新增的请求条数 */
async function send(text, opts = {}) {
  const before = reqs.length;
  const n0 = await msgCount();
  if (opts.random !== undefined) await page.evaluate((v) => { window.__rand0 = Math.random; Math.random = () => v; }, opts.random);
  if (text !== null) {
    await page.evaluate(x => { const el = document.getElementById('input'); el.value = x; el.dispatchEvent(new Event('input', { bubbles: true })); }, text);
    await sleep(150);
    await click('btn-send');
  }
  for (let i = 0; i < 100; i++) { await sleep(300); const b = await page.$eval('#btn-stop', e => !e.classList.contains('hidden')).catch(() => false); if (!b) break; }
  await sleep(600);
  if (opts.random !== undefined) await page.evaluate(() => { if (window.__rand0) { Math.random = window.__rand0; delete window.__rand0; } });
  const added = (await msgCount()) - n0;
  return { newReqs: reqs.slice(before), msgs: await tailMsgs(added), added };
}

// ── 起 App ─────────────────────────────────────────────
await page.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'networkidle0', timeout: 40000 });
await sleep(1200);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil: 'networkidle0' }); await sleep(700);
await seedChars(page, [{ name: '甲', id: 'ga' }, { name: '乙', id: 'gb' }]);
await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const put = (st, rec) => new Promise(r => { const tx = db.transaction(st, 'readwrite'); tx.objectStore(st).put(rec); tx.oncomplete = r; });
  const rec = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get('settings'); q.onsuccess = () => r(q.result); });
  await put('kv', { k: 'settings', v: Object.assign({}, (rec && rec.v) || {}, { apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com', longMemory: false }) });
  await put('characters', { id: 'gg2', name: '测试群', isGroup: true, memberIds: ['ga','gb'],
    groupNote: '', speakMode: 'weight', turnIndex: 0, avatar: null, greeting: '（两个人都在。）',
    presetKey: 'blank', createdAt: Date.now(), narrative: true, showNarration: true, sceneLen: 'mid',
    autoScene: 0, allowSilence: false, povStyle: 'L1', memberCfg: { ga: { joinedAt: Date.now() }, gb: { joinedAt: Date.now() } } });
  db.close();
});
await page.reload({ waitUntil: 'networkidle0' }); await sleep(1200);
await page.evaluate(() => { [...document.querySelectorAll('#char-list .char-card')].find(x => x.dataset.id === 'gg2').click(); });
await sleep(1400);
t('进到聊天页', (await active()).includes('view-chat'), await active());

console.log('');
console.log('=== 1. 小说式一幕 = 开（默认）：同一轮就有「# 这一幕怎么写」 ===');
{
  const r = await send('在吗');
  t('这一轮发出去了一次请求', r.newReqs.length === 1, r.newReqs.length);
  const b = r.newReqs[0];
  t('本轮段里有「# 这一幕怎么写」', !!b && turnOf(b).includes('# 这一幕怎么写'), b ? turnOf(b).slice(0, 60) : null);
  t('本轮段里写了篇幅档（mid = 200~350 字）', !!b && turnOf(b).includes('200~350 字'));
  t('提示词要求「场面描写整行用括号包起来」', !!b && turnOf(b).includes('场面描写整行用括号包起来'));
  t('落库 3 条（他一句 + 拆出来的两条）', r.added === 3, r.added);
  t('最后一条是旁白（.narr），没有说话人', r.msgs[2] && r.msgs[2].narr === true && r.msgs[2].who === '', r.msgs);
}

console.log('');
console.log('=== 2. 旁白开关 关 → 同一轮就改判：那一行归上一个说话人 ===');
{
  await groupSave({ narrOn: false });
  const g = await gGet();
  t('库里的 showNarration 已经是 false', g.showNarration === false, g.showNarration);
  const r = await send('在吗');
  const b = r.newReqs[0];
  t('本轮段改口成「这个群关掉了旁白」', !!b && turnOf(b).includes('这个群关掉了旁白'), b ? turnOf(b).slice(0, 60) : null);
  t('不再要求「场面描写整行用括号包起来」', !!b && !turnOf(b).includes('场面描写整行用括号包起来'));
  t('这一轮没有任何 .narr', r.added === 3 && !r.msgs.some(m => m.narr), r.msgs);
  t('那一行挂到了上一个说话人（甲）名下', r.msgs.some(m => m.who === '甲' && m.text.includes('窗外风停了')), r.msgs);
}

console.log('');
console.log('=== 3. 旁白开关 开回来 → 同一轮就恢复旁白 ===');
{
  await groupSave({ narrOn: true });
  const r = await send('在吗');
  t('又出现 .narr 旁白条', r.msgs.some(m => m.narr && m.text.includes('窗外风停了')), r.msgs);
}

console.log('');
console.log('=== 4. 篇幅档位 long → 同一轮就换成 350~600 字 ===');
{
  await groupSave({ len: 'long' });
  const r = await send('在吗');
  const b = r.newReqs[0];
  t('本轮段写的是 350~600 字', !!b && turnOf(b).includes('350~600 字'), b ? turnOf(b).slice(0, 80) : null);
  t('不再是 200~350 字', !!b && !turnOf(b).includes('200~350 字'));
}

console.log('');
console.log('=== 5. 小说式一幕 关 → 同一轮就退回单人说一句 ===');
{
  await groupSave({ narr: false });
  const r = await send('在吗');
  const b = r.newReqs[0];
  t('本轮段里没有「# 这一幕怎么写」', !!b && !turnOf(b).includes('# 这一幕怎么写'), b ? turnOf(b).slice(0, 80) : null);
  t('落库 2 条（他一句 + 她一条，不再按名字拆）', r.added === 2, r.added);
  t('她那条里两行原样都在', r.msgs[1] && r.msgs[1].text.includes('窗外风停了'), r.msgs);
}

console.log('');
console.log('=== 6. 叙事视角 L3 → 稳定前缀同一轮就换成叙述者那一段 ===');
{
  await groupSave({ ownStyle: true, pov: 'L3' });
  const g = await gGet();
  t('库里的 povStyle 是 L3', g.povStyle === 'L3', g.povStyle);
  const r = await send('在吗');
  const b = r.newReqs[0];
  t('system 里有「# 视角」', !!b && sysOf(b).includes('# 视角'), b ? sysOf(b).slice(-120) : null);
  t('system 里是 L3 那一段', !!b && sysOf(b).includes('跟着「我」走的叙述者'));
  t('system 里【没有】 L1 那一段', !!b && !sysOf(b).includes('只能站在【你自己的视角】'));
}

console.log('');
console.log('=== 7. 叙事视角 切回 L1 → 同一轮就换回来 ===');
{
  await groupSave({ pov: 'L1' });
  const r = await send('在吗');
  const b = r.newReqs[0];
  t('system 里是 L1 那一段', !!b && sysOf(b).includes('只能站在【你自己的视角】'));
  t('system 里没有 L3 那一段', !!b && !sysOf(b).includes('跟着「我」走的叙述者'));
}

console.log('');
console.log('=== 8. 叙事视角 选「关」→ 整段不注入 ===');
{
  await groupSave({ pov: '' });
  const r = await send('在吗');
  const b = r.newReqs[0];
  t('system 里没有「# 视角」整段', !!b && !sysOf(b).includes('# 视角'), b ? sysOf(b).slice(-160) : null);
}

console.log('');
console.log('=== 9. 允许冷场 开 → 同一轮就可能「（没人接话）」 ===');
{
  await groupSave({ silence: true });
  // Math.random()=0 → 稳稳落在 10% 那一支里（见 app.js 冷场那段的 Math.random() < 0.1）
  const r = await send('在吗', { random: 0 });
  t('插了一条「（没人接话）」', r.msgs.some(m => m.text.includes('没人接话')), r.msgs);
  t('这一轮没有真的发请求出去', r.newReqs.length === 0, r.newReqs.length);
  t('发送键回来了（冷场自己解锁，没卡死）', await page.$eval('#btn-send', e => !e.classList.contains('hidden')));
}

console.log('');
console.log('=== 10. 允许冷场 关 → 同一轮就不再有冷场 ===');
{
  await groupSave({ silence: false });
  const r = await send('在吗', { random: 0 });
  t('没有「没人接话」', !r.msgs.some(m => m.text.includes('没人接话')), r.msgs);
  // ⚠️ v0.5.3.4：历史里一直没出现过星号时，重写回路会补发一次「补一句心里话」——
  //    那是同一条回复的一部分，不是额外的一幕，所以只数内容请求。
  const real10 = r.newReqs.filter(q => !isRetry(q));
  t('这一轮真的发请求了（补写不算）', real10.length === 1, real10.length + ' / 全部 ' + r.newReqs.length);
}

console.log('');
console.log('=== 11. 自动续一幕 = 1 → 这一轮完了自己再接一轮 ===');
{
  await groupSave({ auto: 1 });
  const n0 = reqs.length;
  await send('在吗');
  // 自动续一幕是 setTimeout 1200ms 之后才发的，等它
  for (let i = 0; i < 60 && reqs.length < n0 + 2; i++) await sleep(300);
  await sleep(2500);
  const real11 = reqs.slice(n0).filter(q => !isRetry(q));
  t('一共发了 2 次内容请求（手动 1 + 自动 1）', real11.length === 2, real11.length + ' / 全部 ' + (reqs.length - n0));
  t('第二次是自动续的一幕', real11.length === 2);
}

console.log('');
console.log('=== 12. 自动续一幕 关回来 → 同一轮就不再多发 ===');
{
  await groupSave({ auto: 0 });
  const before = reqs.length;
  await send('在吗');
  await sleep(2500);
  t('只发了 1 次，没有自动续', reqs.length - before === 1, reqs.length - before);
}

console.log('');
console.log('=== 13. 「这一幕几个人开口」三档（Math.random 钉死，结果可预测） ===');
{
  // Math.random()=0 → 起头的人固定是甲（概率模式下第一圈就减到负数）；
  // 抽人数时 r=0 → auto/solo 都是 1 人，duo 一定是 2 人。
  // ⚠️ 第 5 节把小说式一幕关掉了，这里必须先开回来 —— 否则测的是"关掉那一套"
  await groupSave({ narr: true, narrOn: true, mix: 'auto' });
  const r1 = await send('在吗', { random: 0 });
  t('auto：抽到 1 人时提示词写「只有一个人开口」', !!r1.newReqs[0] && turnOf(r1.newReqs[0]).includes('只有「甲」一个人开口'), r1.newReqs[0] ? turnOf(r1.newReqs[0]).slice(0, 90) : null);
  t('auto：1 人时【仍然】是小说式那一套（有「# 这一幕怎么写」）', !!r1.newReqs[0] && turnOf(r1.newReqs[0]).includes('# 这一幕怎么写'));

  await groupSave({ mix: 'duo' });
  const r2 = await send('在吗', { random: 0 });
  t('duo：这一场里有 甲、乙 两个人', !!r2.newReqs[0] && turnOf(r2.newReqs[0]).includes('这一场里有 甲、乙'), r2.newReqs[0] ? turnOf(r2.newReqs[0]).slice(0, 90) : null);

  await groupSave({ mix: 'solo' });
  const r3 = await send('在吗', { random: 0.99 });
  t('solo：起头的人换成乙，且只有乙一个人开口', !!r3.newReqs[0] && turnOf(r3.newReqs[0]).includes('只有「乙」一个人开口'), r3.newReqs[0] ? turnOf(r3.newReqs[0]).slice(0, 90) : null);
  const g = await gGet();
  t('duo/solo 会写进群记录，auto 不写（三态）', g.sceneMix === 'solo', g.sceneMix);
  await groupSave({ mix: 'auto' });
  const g2 = await gGet();
  t('切回 auto 时键被删掉（不留快照）', g2.sceneMix === undefined, g2.sceneMix);
}

console.log('');
console.log('=== 14. 页面没报错 ===');
t('没有 pageerror', errs.length === 0, errs.slice(0, 3));

console.log('');
console.log('通过 ' + pass + ' / 失败 ' + fail);
await browser.close();
server.close();
process.exit(fail ? 1 : 0);
