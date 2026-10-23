// e2e-stylecard.mjs —— 风格卡（v0.5.3.2 · 清单 §7.3）
//
// 覆盖：
//   1. 没填过的角色：提示词里一个字符都不多
//   2. 填了样例 + 禁用词：都进【表达方式】这一段的最后
//   3. 样例里的换行保留、缩进后不会和规则行混成一片
//   4. 外部卡里的脏数据（超长 / 重复 / 非数组 ban）被 normalize 洗掉
//   5. 走过界面：编辑页两个框 → 存进角色
//   6. 端到端：带风格卡的角色真发一句，模型收到的是带样例的提示词
//   7. 导出角色卡时带上 styleCard（换台机器导回来腔调不变）

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
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f));
});
await new Promise(r => server.listen(0,'127.0.0.1',r));
const port = server.address().port;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
// CI 的 runner 是 en-US，界面会翻成英文 —— 断言里全是中文文案，必须钉住语言。
await page.evaluateOnNewDocument(() => {
  Object.defineProperty(navigator, 'language', { get: () => 'zh-CN', configurable: true });
  Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh'], configurable: true });
});
const errs = [];
page.on('pageerror', e => errs.push(e.message));
const sleep = ms => new Promise(r=>setTimeout(r,ms));
let pass=0, fail=0;
const t=(n,ok,ex='')=>{ if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));} };
const jsClick = (sel) => page.evaluate(s => { const el = document.querySelector(s); if (el) el.click(); }, sel);

await page.evaluateOnNewDocument(() => {
  window.__hits = { chat: [] };
  const realFetch = window.fetch.bind(window);
  window.fetch = async function (url, opts) {
    const u = String(url);
    let body = {};
    try { body = JSON.parse((opts && opts.body) || '{}'); } catch (e) {}
    if (u.includes('/chat/completions')) {
      if (body.stream === false) {
        return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      window.__hits.chat.push(body);
      const chunk = (o) => 'data: ' + JSON.stringify(o) + String.fromCharCode(10,10);
      const payload =
        chunk({ choices: [{ delta: { content: '嗯。' } }] }) +
        chunk({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 5 } }) +
        'data: [DONE]' + String.fromCharCode(10,10);
      return new Response(payload, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    return realFetch(url, opts);
  };
});

async function seed(spec) {
  return await page.evaluate(async (s) => {
    const o = indexedDB.open('ai-companion');
    const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
    const put = (store, rec) => new Promise(r => { const tx = db.transaction(store,'readwrite'); tx.objectStore(store).put(rec); tx.oncomplete = r; });
    for (const c of (s.chars||[])) await put('characters', c);
    for (const e of (s.kv||[])) await put('kv', e);
    for (const m of (s.msgs||[])) await put('messages', m);
    db.close();
  }, spec);
}

const baseChar = (id, name, extra) => Object.assign({
  id, name, greeting: '（' + name + '）', persona: '你是' + name + '。',
  avatar: null, temperature: 1.0, maxTokens: 2048, topP: 1.0, reasoningEffort: 'low',
  contextRounds: 20, kaomojiFreq: 0, emojiFreq: 0,
  verbosity: 'medium', splitMessages: false, typingDelay: 0, hesitation: false,
  showTyping: false, longMemory: false, allowEditMine: false,
  descLevel: 'low', povLock: false, appearance: '', appearanceOn: true,
  presetKey: 'blank', createdAt: Date.now()
}, extra || {});

async function pickChar(id) {
  await page.evaluate(async (cid) => {
    const o = indexedDB.open('ai-companion');
    const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
    await new Promise(r => { const tx = db.transaction('kv','readwrite'); tx.objectStore('kv').put({ k:'lastCharId', v: cid }); tx.oncomplete = r; });
    db.close();
    location.reload();
  }, id);
  await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30000 }).catch(()=>{});
  await page.waitForFunction(() => !!document.querySelector('#messages .msg'), { timeout: 25000 }).catch(()=>{});
  await sleep(400);
}

async function say(text) {
  await page.evaluate(t => {
    const el = document.getElementById('input');
    el.value = t; el.dispatchEvent(new Event('input', { bubbles: true }));
  }, text);
  await sleep(120);
  await page.evaluate(() => document.getElementById('btn-send').click());
  for (let i = 0; i < 60; i++) {
    const b = await page.$eval('#btn-stop', el => !el.classList.contains('hidden')).catch(()=>false);
    if (b) break;
    await sleep(100);
  }
  for (let i = 0; i < 200; i++) {
    const b = await page.$eval('#btn-stop', el => !el.classList.contains('hidden')).catch(()=>false);
    if (!b) break;
    await sleep(100);
  }
  await sleep(400);
}

const lastPrompt = async () => {
  const h = await page.evaluate(() => window.__hits.chat);
  if (!h.length) return '';
  const b = h[h.length - 1];
  return (b.messages || []).map(m => m.content || '').join(String.fromCharCode(10));
};

const SAMPLE = '她把伞收在门边，水滴在水泥地上洇开一小片深色。' + String.fromCharCode(10) + '「你还没走啊。」';

const CID = 'cstyle1';
await page.goto('http://127.0.0.1:' + port + '/index.html', { waitUntil: 'networkidle0' });
await seed({
  chars: [
    baseChar(CID, '风格甲'),
    baseChar('cstyle2', '风格乙', { styleCard: { sample: SAMPLE, ban: ['好的呢', '嗯嗯', '好的呢'] } }),
    baseChar('cstyle3', '风格丙', {
      // 脏数据：超长样例 + 13 条禁用（其中重复）+ ban 是字符串
      styleCard: { sample: '字'.repeat(2000), ban: '甲,乙，甲' + String.fromCharCode(10) + '丙' },
    }),
  ],
  kv: [
    { k: 'settings', v: { apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', clockMode: false } },
  ],
  msgs: [
    { id: 'm' + CID + '1', charId: CID, role: 'assistant', content: '（等着）', ts: Date.now() - 5000 },
    { id: 'mcs2-1', charId: 'cstyle2', role: 'assistant', content: '（等着）', ts: Date.now() - 5000 },
    { id: 'mcs3-1', charId: 'cstyle3', role: 'assistant', content: '（等着）', ts: Date.now() - 5000 },
  ],
});

console.log('=== 1. 没填过的角色：提示词里一个字符都不多 ===');
await pickChar(CID);
await say('在吗');
const p0 = await lastPrompt();
t('这一轮真的发出去了', p0.length > 0, String(p0.length));
t('没有风格样例段', !p0.includes('【范例】'), p0.slice(0, 60));
t('没有禁用段', !p0.includes('这几样【不要写进正文】'));

console.log('');
console.log('=== 2. 填了之后：样例和禁用都进提示词 ===');
await pickChar('cstyle2');
await say('在吗');
const p1 = await lastPrompt();
t('有【范例】', p1.includes('【范例】'));
t('样例原文进来了', p1.includes('水滴在水泥地上洇开一小片深色'));
t('要她只学写法、不复述', p1.includes('不要复述') && p1.includes('那是别的场合'));
t('禁用词进来了', p1.includes('这几样【不要写进正文】：好的呢、嗯嗯'));
t('重复的禁用词只留一条', (p1.match(/好的呢/g) || []).length === 1, String((p1.match(/好的呢/g) || []).length));
t('风格段在表达方式里（不是单独一段）', p1.indexOf('【范例】') > p1.indexOf('# 表达方式'));
t('样例排在禁用之前', p1.indexOf('【范例】') < p1.indexOf('这几样【不要写进正文】'));

console.log('');
console.log('=== 3. 脏数据被洗掉 ===');
const norm = await page.evaluate(async () => {
  const m = await import('/js/stylecard.js');
  const a = m.normalizeStyleCard({ sample: '字'.repeat(2000), ban: '甲,乙，甲' +
    String.fromCharCode(10) + '丙' });
  const b = m.normalizeStyleCard({ sample: 12345, ban: { x: 1 } });
  const c = m.normalizeStyleCard(null);
  return { len: a.sample.length, ban: a.ban, b, c };
});
t('超长样例截到 800 字', norm.len === 800, String(norm.len));
t('字符串 ban 按换行/逗号切开并去重', JSON.stringify(norm.ban) === JSON.stringify(['甲', '乙', '丙']), JSON.stringify(norm.ban));
t('数字样例转成字符串', norm.b.sample === '12345', JSON.stringify(norm.b.sample));
t('ban 不是数组时不炸、当成空', Array.isArray(norm.b.ban) && norm.b.ban.length === 0, JSON.stringify(norm.b.ban));
t('null 进得去', norm.c.sample === '' && norm.c.ban.length === 0);
const capBan = await page.evaluate(async () => {
  const m = await import('/js/stylecard.js');
  return m.normalizeStyleCard({ ban: Array.from({ length: 20 }, (_, i) => 'x' + i) }).ban.length;
});
t('禁用词最多 12 条', capBan === 12, String(capBan));

console.log('');
console.log('=== 4. 走过界面：编辑页两个框 → 存进角色 ===');
// 走"新建角色"这条路进编辑页 —— 点已有的卡是【选进聊天】，不是编辑。
await page.reload({ waitUntil: 'networkidle0' });
await sleep(700);
await jsClick('#btn-chars'); await sleep(700);
await jsClick('#btn-new-char2'); await sleep(800);
await page.evaluate(() => { const b = document.querySelector('#preset-list button, #preset-list .char-item, #preset-list [data-key]'); if (b) b.click(); });
await sleep(1200);
const opened = await page.evaluate(() => !!document.getElementById('e-name'));
t('打开了角色编辑页', opened === true);
const hasBox = await page.evaluate(() => !!document.getElementById('e-stylesample') && !!document.getElementById('e-styleban'));
t('编辑页有两个框', hasBox === true);
const ph = await page.$eval('#e-stylesample', el => el.getAttribute('placeholder') || '');
t('样例框有通用例子（不写死某个角色）', ph.length > 10 && !ph.includes('红蓝'), ph.slice(0, 30));
await page.evaluate((s) => {
  document.getElementById('e-name').value = '风格丁';
  const a = document.getElementById('e-stylesample'); a.value = s;
  const b = document.getElementById('e-styleban'); b.value = '别用这个' + String.fromCharCode(10) + '也别用那个';
}, SAMPLE);
await sleep(200);
await jsClick('#btn-edit-save'); await sleep(1200);
const saved = await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const all = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').getAll(); q.onsuccess = () => r(q.result || []); });
  db.close();
  return all.find(x => x.name === '风格丁') || null;
});
t('样例存进了角色', !!saved && !!saved.styleCard && saved.styleCard.sample.includes('水滴在水泥地上'), JSON.stringify(saved && saved.styleCard));
t('禁用词存成数组', !!saved && !!saved.styleCard && Array.isArray(saved.styleCard.ban) && saved.styleCard.ban.join() === '别用这个,也别用那个', JSON.stringify(saved && saved.styleCard && saved.styleCard.ban));

console.log('');
console.log('=== 5. 导出角色卡带上 styleCard ===');
const card = await page.evaluate(async (cid) => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const c = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').get(cid); q.onsuccess = () => r(q.result); });
  const ents = await new Promise(r => { const q = db.transaction('wbSolo').objectStore('wbSolo').getAll(); q.onsuccess = () => r(q.result || []); });
  db.close();
  const m = await import('/js/charcard.js');
  const built = m.buildCardV2(c, ents.filter(e => e && e.charId === cid), {});
  return built && built.data && built.data.extensions && built.data.extensions.mengxianju
    ? built.data.extensions.mengxianju.params.styleCard : null;
}, 'cstyle2');
t('卡里带上了 styleCard', !!card && !!card.sample && Array.isArray(card.ban) && card.ban.length === 2, JSON.stringify(card));
t('卡里的样例是原文', !!card && card.sample.includes('水滴在水泥地上'), JSON.stringify(card && card.sample));

console.log('');
console.log('=== 6. 没有未捕获报错 ===');
t('页面没有异常', errs.length === 0, errs.join(' | '));

console.log('');
console.log('通过 ' + pass + ' 项 / 失败 ' + fail + ' 项');
await browser.close();
server.close();
process.exit(fail > 0 ? 1 : 0);
