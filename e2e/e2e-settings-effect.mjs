// e2e-settings-effect.mjs — 单聊侧的设置到底进没进提示词（v0.4.2.1）
//
// 和 e2e-group-effect 一对：那一套钉群聊设置，这一套钉角色级 / 全局的设置。
// 判据只有一条：**发出去的那份请求里有没有对应的那一段**。
// 不查界面、不查库 —— 那两样别的套件已经查过了；这里要抓的是"设置改了，提示词没跟着变"。
//
// ⚠️ 每个用例都是：改库 → 重新进聊天（让 curChar 重新读一次）→ 发一句 → 看请求体。
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

const CHAR_ID = 'se1';
const putChar = (patch) => page.evaluate(async (o) => {
  const req = indexedDB.open('ai-companion');
  const db = await new Promise(r => { req.onsuccess = () => r(req.result); });
  const c = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').get(o.id); q.onsuccess = () => r(q.result); });
  Object.assign(c, o.patch);
  await new Promise(r => { const tx = db.transaction('characters', 'readwrite'); tx.objectStore('characters').put(c); tx.oncomplete = r; });
  db.close();
}, { id: CHAR_ID, patch });
const putKV = (patch) => page.evaluate(async (o) => {
  const req = indexedDB.open('ai-companion');
  const db = await new Promise(r => { req.onsuccess = () => r(req.result); });
  const rec = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get('settings'); q.onsuccess = () => r(q.result); });
  const v = Object.assign({}, (rec && rec.v) || {}, o);   // ⚠️ 这里原来是 o.patch —— putKV 的参数就是 patch 本身，写成 o.patch 等于什么都没改（写 4 读回来还是 3）
  await new Promise(r => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put({ k: 'settings', v }); tx.oncomplete = r; });
  db.close();
}, patch);
// ⚠️ 用 goto 而不是 reload：第 8 节会先把页面导航到同源的一个静态文件上（为了绕开
//    "App 卸载时把设置写回库"这件事），那时候 reload 会把那个静态文件再读一遍。
const APP_URL = 'http://127.0.0.1:' + port + '/';
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

await page.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'networkidle0', timeout: 40000 });
await sleep(1200);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil: 'networkidle0' }); await sleep(700);
await page.evaluate(async (id) => {
  const req = indexedDB.open('ai-companion');
  const db = await new Promise(r => { req.onsuccess = () => r(req.result); });
  const put = (st, rec) => new Promise(r => { const tx = db.transaction(st, 'readwrite'); tx.objectStore(st).put(rec); tx.oncomplete = r; });
  const rec = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get('settings'); q.onsuccess = () => r(q.result); });
  await put('kv', { k: 'settings', v: Object.assign({}, (rec && rec.v) || {}, {
    // ⚠️ 角色没写「他是谁 / 他住哪」时会【回落到全局那一份】—— 基线要干净，
    //    所以这两项在全局也得清空，否则第一条"不该出现"的断言测的是全局的默认自述。
    apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com', longMemory: true, worldbookOn: false,
    myProfile: '', myEnv: '', splitMax: 3 }) });
  await put('characters', { id, name: '甲', greeting: '（开场）', persona: '你是甲。', avatar: null,
    presetKey: 'blank', createdAt: Date.now(), temperature: 1, maxTokens: 2048,
    verbosity: 'medium', descLevel: 'mid', detailDrive: 'mid', povStyle: '', thinkMode: false,
    appearance: '', appearanceOn: true, splitMessages: false, hesitation: true, longMemory: true,
    kaomojiFreq: 0.15, kaomojiStyle: 'jp-soft', emojiFreq: 0.1, contextRounds: 20 });
  // 一条记忆：用来验 longMemory 开关
  await put('memories', { id: 'm1', charId: id, text: '他喜欢喝咖啡', ts: Date.now() });
  db.close();
}, CHAR_ID);
await enterChat();
t('进到聊天页', await page.evaluate(() => document.querySelector('#view-chat').classList.contains('active')));

console.log('');
console.log('=== 1. 基线：该有的段在，不该有的段不在 ===');
{
  const sys = await send('在吗');
  t('发出了请求', sys.length > 0);
  t('有「# 表达方式」', sys.includes('# 表达方式'));
  t('没开视角 → 没有「# 视角」', !sys.includes('# 视角'));
  t('没开强制聊天模式 → 没有「# 关于括号」', !sys.includes('# 关于括号'));
  t('没设临时场景 → 没有「# 当前场景」', !sys.includes('# 当前场景'));
  t('没设外貌 → 没有「# 你此刻的样子」', !sys.includes('# 你此刻的样子'));
  t('没写「他是谁」→ 没有「# 关于对方」', !sys.includes('# 关于对方'));
  t('longMemory 开着且有记忆 → 有「# 你记得关于他的事」', sys.includes('# 你记得关于他的事'));
  t('记忆内容进去了', sys.includes('他喜欢喝咖啡'));
}

console.log('');
console.log('=== 2. 叙事视角：改了、同一轮就出现在稳定前缀里 ===');
{
  await putChar({ povStyle: 'L3' }); await enterChat();
  const sys = await send('在吗');
  t('有「# 视角」', sys.includes('# 视角'));
  t('是 L3 那一段', sys.includes('跟着「我」走的叙述者'));
  await putChar({ povStyle: 'L1' }); await enterChat();
  const sys2 = await send('在吗');
  t('切回 L1 立刻换回来', sys2.includes('只能站在【你自己的视角】') && !sys2.includes('跟着「我」走的叙述者'));
}

console.log('');
console.log('=== 3. 强制聊天模式（关于括号）===');
{
  await putChar({ thinkMode: true }); await enterChat();
  const sys = await send('在吗');
  t('开了就出现「# 关于括号」', sys.includes('# 关于括号'));
  await putChar({ thinkMode: false });
}

console.log('');
console.log('=== 4. 外貌：基线 / 立即生效 / 关掉 ===');
{
  await putChar({ appearance: '她穿着一件洗得发白的衬衫', appearanceLive: '', appearanceOn: true });
  await enterChat();
  const sys = await send('在吗');
  t('设了外貌 → 有「# 你此刻的样子」', sys.includes('# 你此刻的样子'));
  t('外貌正文进去了', sys.includes('洗得发白的衬衫'));

  await putChar({ appearanceLive: '此刻她披着浴巾' }); await enterChat();
  const sys2 = await send('在吗');
  t('「立即生效」盖过长期那条', sys2.includes('此刻她披着浴巾') && !sys2.includes('洗得发白的衬衫'));

  await putChar({ appearanceLive: '', appearanceOn: false }); await enterChat();
  const sys3 = await send('在吗');
  t('关掉开关 → 整段不注入（内容还留着）', !sys3.includes('# 你此刻的样子'));
  await putChar({ appearanceOn: true, appearance: '' });
}

console.log('');
console.log('=== 5. 临时场景 ===');
{
  await putChar({ scene: '外面在下雨，两个人刚进屋' }); await enterChat();
  const sys = await send('在吗');
  t('有「# 当前场景」', sys.includes('# 当前场景'));
  t('场景正文进去了', sys.includes('外面在下雨'));
  await putChar({ scene: '' });
}

console.log('');
console.log('=== 6. 「他是谁 / 他住哪」===');
{
  await putChar({ myProfile: '他是个上班族，话不多', myEnv: '他租了个小房子' });
  await enterChat();
  const sys = await send('在吗');
  t('有「# 关于对方」', sys.includes('# 关于对方'));
  t('他的设定进去了', sys.includes('他是个上班族'));
  t('有「# 他住的地方」', sys.includes('# 他住的地方'));
  t('居处进去了', sys.includes('租了个小房子'));
  await putChar({ myProfile: '', myEnv: '' });
}

console.log('');
console.log('=== 7. 卡里那几项（cardFields）真的进了设定 ===');
{
  await putChar({ cardFields: { personality: '性格：慢热，认生', scenario: '场景：在一间旧书店', mesExample: '对话范例：<START>甲：你好' } });
  await enterChat();
  const sys = await send('在吗');
  t('有「# 卡里另外带来的设定」', sys.includes('# 卡里另外带来的设定'));
  // 标签是【性格】【场景】【对话范例】（persona.js 拼的），不是 markdown 标题
  t('性格进去了', sys.includes('【性格】') && sys.includes('慢热，认生'));
  t('场景进去了', sys.includes('【场景】') && sys.includes('在一间旧书店'));
  t('对话范例进去了', sys.includes('【对话范例】') && sys.includes('照这个的写法说话'));
  await putChar({ cardFields: {} });
}

console.log('');
console.log('=== 8. 分段发送 / 迟疑 两个开关 ===');
{
  // ⚠️ splitMessages 是角色级键，而 splitMax【不在 CHAR_KEYS 里】= 只能全局设，
  //    而且它【没有界面入口】—— 只能写库。
  //    这里先把页面挪到一个【同源的静态文件】上（不跑脚本）再写，写完再回 App ——
  //    免得和 App 自己那份设置回写抢（App 会在页面卸载时把内存里的 S 写回库）。
  //    实测：写完立刻读回，值是 4；回到 App 之后提示词里也就是 2-4 条。
  await page.goto('http://127.0.0.1:' + port + '/js/presets.js', { waitUntil: 'domcontentloaded' });
  await sleep(1200);   // 等旧页面的卸载刷新落库
  await putKV({ splitMax: 4 });
  await putChar({ splitMessages: true, hesitation: false });
  await enterChat();
  const sys = await send('在吗');
  t('开分段 → 提示里写了拆成 2-4 条', sys.includes('拆成 2-4 条'));
  t('关迟疑 → 没有「适当用「……」」那条', !sys.includes('适当用「……」'));
  await putChar({ splitMessages: false, hesitation: true }); await putKV({ splitMax: 3 }); await enterChat();
  const sys2 = await send('在吗');
  t('关分段 → 一次只发一条', sys2.includes('一次只发一条消息'));
  t('开迟疑 → 那条回来了', sys2.includes('适当用「……」'));
}

console.log('');
console.log('=== 9. 记忆开关 ===');
{
  await putChar({ longMemory: false }); await enterChat();
  const sys = await send('在吗');
  t('关掉长期记忆 → 记忆段整段不注入', !sys.includes('# 你记得关于他的事'));
  t('记忆正文也不在', !sys.includes('他喜欢喝咖啡'));
  await putChar({ longMemory: true });
}

console.log('');
console.log('=== 10. 描写上限 × 驱动力的降级（两者互相打架时要降级并说明）===');
{
  await putChar({ descLevel: 'low', detailDrive: 'max' });
  await enterChat();
  const sys = await send('在吗');
  t('上限压到 low 时驱动降级', sys.includes('按最低档执行'));
  await putChar({ descLevel: 'mid', detailDrive: 'mid' });
  await enterChat();
  const sys2 = await send('在吗');
  t('不冲突时不出现降级提示', !sys2.includes('按最低档执行'));
}

console.log('');
console.log('=== 11. 没有 JS 错误 ===');
t('无 pageerror', errs.length === 0, errs.slice(0, 3));

console.log('');
console.log('通过 ' + pass + ' / 失败 ' + fail);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
