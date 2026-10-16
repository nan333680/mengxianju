// e2e-scene-clock.mjs — 临时场景的冲突规则与快照、历史时间标记、括号的三类（v0.4.3）
//
// 这一套钉四件事，全部来自用户 m00744 的六点反馈：
//   1. 场景和他的描述冲突时，提示词里必须写清【听谁的】+【要让他看得见】（新的"点一句"要求）
//   2. 每条消息要存下【发出时的场景】（sceneSnap）—— 他事后要能查，长按菜单里能看到
//   3. 历史时间标记的 key 必须细到【分钟】（原来只到小时 → 同一小时内的推进没有标记，
//      于是"洗澡"停在刚放水那一下：#138 18:00 → #140 18:50）
//   4. 时间被往回拨时要有说明（#127 19:00 → #128 17:20）；括号要有【旁白/剧本】这第三类
//
// 判据分两半：进模型的提示词看请求体；场景快照看库里的消息对象。
import puppeteer from 'puppeteer-core';
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
let lastBody = null;
await page.setRequestInterception(true);
page.on('request', req => {
  if (req.url().includes('/chat/completions')) {
    if (req.method() === 'OPTIONS') { req.respond({ status: 204, headers: { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Headers':'*', 'Access-Control-Allow-Methods':'*' } }); return; }
    try { const b = JSON.parse(req.postData() || '{}'); if (b.stream) lastBody = b; } catch (e) { /* ignore */ }
    const chunk = JSON.stringify({ choices: [{ delta: { content: '好。' } }] });
    req.respond({ status: 200, headers: { 'Access-Control-Allow-Origin':'*' }, contentType: 'text/event-stream',
      body: 'data: ' + chunk + NL + NL + 'data: [DONE]' + NL + NL }); return;
  }
  req.continue();
});

const CHAR_ID = 'sc1';
const APP_URL = 'http://127.0.0.1:' + port + '/';
// ⚠️ 改库之前必须先离开 App 页面 —— App 卸载时会把设置回写，和测试写的值打架。
const offline = () => page.goto(APP_URL + 'js/presets.js', { waitUntil: 'domcontentloaded' });
const openDb = async (fn, arg) => page.evaluate(fn, arg);

const putKV = (patch) => openDb(async (o) => {
  const req = indexedDB.open('ai-companion');
  const db = await new Promise(r => { req.onsuccess = () => r(req.result); });
  const rec = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get('settings'); q.onsuccess = () => r(q.result); });
  const v = Object.assign({}, (rec && rec.v) || {}, o);
  await new Promise(r => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put({ k: 'settings', v }); tx.oncomplete = r; });
  db.close();
}, patch);
const putChar = (patch) => openDb(async (o) => {
  const req = indexedDB.open('ai-companion');
  const db = await new Promise(r => { req.onsuccess = () => r(req.result); });
  const c = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').get(o.id); q.onsuccess = () => r(q.result); });
  Object.assign(c, o.patch);
  await new Promise(r => { const tx = db.transaction('characters', 'readwrite'); tx.objectStore('characters').put(c); tx.oncomplete = r; });
  db.close();
}, { id: CHAR_ID, patch });
const setClock = (v) => openDb(async (o) => {
  const req = indexedDB.open('ai-companion');
  const db = await new Promise(r => { req.onsuccess = () => r(req.result); });
  await new Promise(r => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put({ k: 'clock:' + o.id, v: o.v }); tx.oncomplete = r; });
  db.close();
}, { id: CHAR_ID, v });
const clearMsgs = () => openDb(async () => {
  const req = indexedDB.open('ai-companion');
  const db = await new Promise(r => { req.onsuccess = () => r(req.result); });
  await new Promise(r => { const tx = db.transaction('messages', 'readwrite'); tx.objectStore('messages').clear(); tx.oncomplete = r; });
  db.close();
});
const seedMsgs = (list) => openDb(async (o) => {
  const req = indexedDB.open('ai-companion');
  const db = await new Promise(r => { req.onsuccess = () => r(req.result); });
  await new Promise(r => { const tx = db.transaction('messages', 'readwrite'); const st = tx.objectStore('messages'); for (const m of o.list) st.put(m); tx.oncomplete = r; });
  db.close();
}, { list });
const readMsgs = () => openDb(async () => {
  const req = indexedDB.open('ai-companion');
  const db = await new Promise(r => { req.onsuccess = () => r(req.result); });
  const all = await new Promise(r => { const q = db.transaction('messages').objectStore('messages').getAll(); q.onsuccess = () => r(q.result); });
  db.close();
  return all;
});
const enterChat = async () => {
  await page.goto(APP_URL, { waitUntil: 'networkidle0' }); await sleep(900);
  await page.evaluate(() => { const c = [...document.querySelectorAll('#char-list .char-card')][0]; if (c) c.click(); });
  await sleep(1200);
};
const send = async (text) => {
  lastBody = null;
  await page.evaluate(x => { const i = document.getElementById('input'); i.value = x; i.dispatchEvent(new Event('input', { bubbles: true })); }, text);
  await sleep(150);
  await page.evaluate(() => document.getElementById('btn-send').click());
  for (let i = 0; i < 60; i++) { await sleep(250); const b = await page.$eval('#btn-stop', e => !e.classList.contains('hidden')).catch(() => false); if (!b) break; }
  await sleep(500);
  return lastBody ? (lastBody.messages || []).map(m => m.content || '').join(NL) : '';
};
const menuItems = async (id) => {
  await page.evaluate(x => {
    const el = document.querySelector('#messages [data-id="' + x + '"]');
    if (el) el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  }, id);
  await sleep(600);
  const items = await page.$$eval('.msg-menu button', els => els.map(e => e.textContent.trim())).catch(() => []);
  await page.evaluate(() => document.querySelectorAll('.msg-menu').forEach(m => m.remove()));
  return items;
};
const st = (day, phase, hour, minute) => ({ day, phase, season: 'autumn', weather: 'clear', hour, minute });

// ---------- 建库 ----------
await page.goto(APP_URL, { waitUntil: 'networkidle0', timeout: 40000 });
await sleep(1200);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil: 'networkidle0' }); await sleep(700);
await openDb(async (id) => {
  const req = indexedDB.open('ai-companion');
  const db = await new Promise(r => { req.onsuccess = () => r(req.result); });
  const put = (st, rec) => new Promise(r => { const tx = db.transaction(st, 'readwrite'); tx.objectStore(st).put(rec); tx.oncomplete = r; });
  const rec = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get('settings'); q.onsuccess = () => r(q.result); });
  await put('kv', { k: 'settings', v: Object.assign({}, (rec && rec.v) || {}, {
    apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com', worldbookOn: false,
    // ⚠️ clockMode 必须显式关掉：清库之后 App 认为是"全新安装"，
    //    于是保留 DEFAULTS.clockMode = true（跟现实走），storyStamp 会走 realNow()，
    //    clockState 被整个绕开 —— 时间相关的断言全部失真（实测踩过）。
    myProfile: '', myEnv: '', splitMax: 3, clockMode: false, clockDetail: true, historyTime: true, autoArchive: false }) });
  await put('characters', { id, name: '甲', greeting: '（开场）', persona: '你是甲。', avatar: null,
    presetKey: 'blank', createdAt: Date.now(), temperature: 1, maxTokens: 2048,
    verbosity: 'medium', descLevel: 'mid', detailDrive: 'mid', povStyle: '', thinkMode: false,
    appearance: '', appearanceOn: true, splitMessages: false, hesitation: true, longMemory: true,
    kaomojiFreq: 0.15, kaomojiStyle: 'jp-soft', emojiFreq: 0.1, contextRounds: 20 });
  db.close();
}, CHAR_ID);
await setClock(st(7, 'evening', 18, 50));
await enterChat();
t('进到聊天页', await page.evaluate(() => document.querySelector('#view-chat').classList.contains('active')));

console.log('');
console.log('=== 1. 场景冲突规则（m00744 第 6 点）===');
{
  await offline(); await putChar({ scene: '外界 · 山里那个山洞' }); await enterChat();
  const sys = await send('在吗');
  t('有「# 当前场景」', sys.includes('# 当前场景'));
  t('场景正文进去了', sys.includes('外界 · 山里那个山洞'));
  t('写明了他写的地方优先', sys.includes('以他写的为准'));
  t('写明了"场景只是底色"', sys.includes('只是底色'));
  t('写明了明显对不上要点一句', sys.includes('明显对不上') && sys.includes('当场点一句'));
  t('不要求每轮声明', sys.includes('不必每轮声明'));

  await offline(); await putChar({ scene: '' }); await enterChat();
  const sys2 = await send('在吗');
  t('清掉场景 → 整段不再出现', !sys2.includes('# 当前场景'));
}

console.log('');
console.log('=== 2. 场景快照：消息带上发出时的场景 ===');
{
  await offline(); await putChar({ scene: '外界 · 山洞' }); await clearMsgs(); await enterChat();
  await send('在吗');
  let all = await readMsgs();
  t('发了一轮 → 库里有两条', all.length === 2);
  t('用户消息带 scene', all.find(m => m.role === 'user')?.scene === '外界 · 山洞');
  t('她那条也带 scene', all.find(m => m.role === 'assistant')?.scene === '外界 · 山洞');

  await offline(); await putChar({ scene: '家里' }); await enterChat();
  await send('还在吗');
  all = await readMsgs();
  const old4 = all.filter(m => m.content === '在吗' || (m.role === 'assistant' && all.filter(x => x.role === 'user').length === 2 && m.ts < all.find(u => u.content === '还在吗').ts));
  t('老消息的快照不被改写', all.filter(m => m.scene === '外界 · 山洞').length === 2);
  t('新消息用新场景', all.filter(m => m.scene === '家里').length === 2);

  await offline(); await putChar({ scene: '' }); await enterChat();
  await send('没事');
  all = await readMsgs();
  const bare = all.filter(m => m.content === '没事');
  t('没设场景 → 消息上不留 scene 字段', bare.length === 1 && !('scene' in bare[0]));

  console.log('  -- 长按菜单 --');
  const withScene = all.find(m => m.scene === '家里');
  const without = all.find(m => m.content === '没事');
  const a = await menuItems(withScene.id);
  t('长按有快照的消息 → 菜单里有「当时的场景」', a.includes('当时的场景'), a);
  const b = await menuItems(without.id);
  t('没有快照的消息不显示这一项', !b.includes('当时的场景'), b);
}

console.log('');
console.log('=== 3. 历史时间标记：细到分钟（v0.4.3 修）===');
{
  // ⚠️ clockState 必须【晚于最后一条历史消息】才有"过了多久"可算 ——
  //    正常发消息时新消息的 story 就等于当时的 clockState，所以末条与当前时刻永远相同（m=0）。
  //    有时间差只可能是他【发消息之前手动拨了时间条】（用户 m00717 第 3/4 点的实际用法）。
  //    这里设成 19:40，末条历史是 18:50 → 差 50 分钟。
  await offline(); await clearMsgs(); await setClock(st(7, 'evening', 19, 40));
  await seedMsgs([
    { id: 'h1', charId: CHAR_ID, role: 'assistant', content: '（他刚进浴室）', story: st(7, 'evening', 18, 0), ts: Date.now() - 60000 },
    { id: 'h2', charId: CHAR_ID, role: 'assistant', content: '（水声还没停）', story: st(7, 'evening', 18, 50), ts: Date.now() - 50000 },
  ]);
  await enterChat();
  const sys = await send('在吗');
  t('18:00 那条带时间标记', sys.includes('【第 7 天 傍晚 18:00】'));
  t('18:50 那条也带时间标记（同小时内推进不再丢）', sys.includes('【第 7 天 傍晚 18:50】'));
  t('两条间隔写清楚了', sys.includes('中间过了 **50 分钟**'));
  t('给了"手头那件小事该做完了"的常识锚点', sys.includes('通常已经做完了'));
  t('锚点是软的：以他说的为准', sys.includes('就以他说的为准'));

  // ⚠️ 自查补（v0.4.3）：这句锚点原来是【无条件】注入的，而它的开头「隔了这么久」
  //    是在指代上面 clockGap 那一段。同一条时间、没过多久时那句没有前提，
  //    反而会让模型把刚发生的动作当成已完成。改成"有跨度才给"之后必须反向钉一次，
  //    否则哪天又变回无条件注入，没有测试会说话。
  await offline(); await clearMsgs(); await setClock(st(7, 'evening', 18, 50));
  await seedMsgs([
    { id: 'h3', charId: CHAR_ID, role: 'assistant', content: '（水声停了）', story: st(7, 'evening', 18, 50), ts: Date.now() - 60000 },
  ]);
  await enterChat();
  const sysNoGap = await send('在吗');
  t('同一时刻、没有跨度 → 不给「隔了这么久」那句', !sysNoGap.includes('通常已经做完了'));
}

console.log('');
console.log('=== 4. 时间被往回拨（m00744 第 1/2 点）===');
{
  await offline(); await clearMsgs(); await setClock(st(7, 'evening', 17, 20));
  await seedMsgs([
    { id: 'b1', charId: CHAR_ID, role: 'assistant', content: '（天已经黑了）', story: st(7, 'evening', 19, 0), ts: Date.now() - 60000 },
  ]);
  await enterChat();
  const sys = await send('在吗');
  t('明说时间被往回拨了', sys.includes('【时间被他往回拨了】'));
  t('两个时刻都写出来', sys.includes('19:00') && sys.includes('17:20'));
  t('给了"按新的时间写"的规则', sys.includes('按新的时间来写'));
  t('不报"过了多久"（负间隔不硬算）', !sys.includes('中间过了'));

  await offline(); await clearMsgs(); await setClock(st(7, 'evening', 18, 50));
  await seedMsgs([
    { id: 'b2', charId: CHAR_ID, role: 'assistant', content: '（水声还没停）', story: st(7, 'evening', 18, 50), ts: Date.now() - 60000 },
  ]);
  await enterChat();
  const sys2 = await send('在吗');
  t('同一分钟 → 不写那一段（省 token）', !sys2.includes('【上一条对话到现在过了多久】') && !sys2.includes('【时间被他往回拨了】'));

  // ⚠️ 自查补（v0.4.3）：没开「精确时间」时（这是默认档）历史里只有时段，
  //    原来"傍晚 → 早上"这种倒退两处判定都要求有钟点 → 全都漏掉，
  //    她只会看到历史里时间倒着排，没有任何解释。这里用纯时段倒退钉住。
  await offline(); await clearMsgs(); await setClock(st(7, 'morning'));
  await seedMsgs([
    { id: 'b3', charId: CHAR_ID, role: 'assistant', content: '（天已经黑了）', story: st(7, 'evening'), ts: Date.now() - 60000 },
  ]);
  await enterChat();
  const sys3 = await send('在吗');
  t('没开精确时间时，时段倒退也明说', sys3.includes('【时间被他往回拨了】'));
  t('倒推的两个时刻用时段名写出来', sys3.includes('傍晚') && sys3.includes('早上'));

  // ⚠️ 自查补（v0.4.3）：locked 的文案原来是「这个时间是定死的，他说什么都不会改变它」，
  //    而同一份 prompt 里可能正说着"时间被他往回拨了" —— 两句对不上。
  //    现在按真实语义（detectClock 里 locked 只关掉自动识别）限定成"光靠对话推不动"。
  await offline(); await clearMsgs();
  await setClock({ ...st(7, 'evening', 18, 0), locked: true });
  await seedMsgs([
    { id: 'b4', charId: CHAR_ID, role: 'assistant', content: '（刚坐下）', story: st(7, 'evening', 17, 30), ts: Date.now() - 60000 },
  ]);
  await enterChat();
  const sys4 = await send('在吗');
  t('锁定档仍说时间是定死的', sys4.includes('定死'));
  t('锁定档的措辞不再和"往回拨"打架', sys4.includes('光靠对话推不动'));
}

console.log('');
console.log('=== 5. 括号的第三类：旁白和剧本（m00744 第 4 点）===');
{
  await offline(); await putChar({ thinkMode: true }); await enterChat();
  const sys = await send('（她把我按在床上）');
  t('有「# 关于括号」', sys.includes('# 关于括号'));
  t('点明第三类是旁白/剧情', sys.includes('第三种写法') && sys.includes('旁白和剧情'));
  t('要求当成既成事实接住', sys.includes('已经发生的事') && sys.includes('顺着往下演'));
  t('给了分辨办法（主语是"她/他"就是旁白）', sys.includes('环境怎么变了'));
  t('复述旁白不算复述他心里的话', sys.includes('复述【旁白和剧情】不算复述'));

  await offline(); await putChar({ thinkMode: false }); await enterChat();
  const sys2 = await send('在吗');
  t('关掉 → 整段不再出现', !sys2.includes('# 关于括号'));
}

t('全程没有页面报错', errs.length === 0, errs.slice(0, 3));
console.log('');
console.log((fail === 0 ? 'PASS' : 'FAIL') + '  通过 ' + pass + ' / 失败 ' + fail);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
