// 人物（角色卡）导入导出的【同步完整性】—— 这条线以前四个按钮零覆盖。
//
// v1.21.52 的致命 bug 就出在这里：函数、调用点都在，签名没改，导入任何卡都崩，
// 而当时 97 套回归全绿 —— 因为"点导出按钮 / 点导入按钮"这条路没有任何测试走过。
//
// 这套测两件事：
//   ① 静态：角色编辑页保存的每个字段，卡片是不是都能带回来（防止以后加了新参数忘了进卡）
//   ② 端到端：真点「导出为 JSON 卡」→ 真从「导入角色卡」入口喂回去 → 逐字段比对
import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer-core';
import http from 'http';

const R = path.resolve(import.meta.dirname).split(path.sep).join('/');
const WWW = R + '/www';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
let pass = 0, fail = 0;
const t = (n, ok, ex = '') => { if (ok) { pass++; console.log('  OK   ' + n); } else { fail++; console.log('  FAIL ' + n + (ex ? '  -> ' + ex : '')); } };

console.log('=== 1. 静态：角色上的字段 vs 卡片能带回来的字段 ===');
const src = fs.readFileSync(R + '/www/js/app.js', 'utf8');
const start = src.indexOf('async function saveCharEdit()');
const dataAt = src.indexOf('const data = {', start);
const body = src.slice(dataAt, src.indexOf('\n  };', dataAt));
const charKeys = [...new Set([...body.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:/g)].map(m => m[1]))].sort();
const cardSrc = fs.readFileSync(R + '/www/js/charcard.js', 'utf8');
const mkStart = cardSrc.indexOf('const MK_CARD_KEYS = [');
const mkBlock = cardSrc.slice(mkStart, cardSrc.indexOf('];', mkStart));
const mkKeys = [...new Set([...mkBlock.matchAll(/'([a-zA-Z][a-zA-Z0-9]*)'/g)].map(m => m[1]))];
t('提取到角色编辑页的字段（不是 0 个）', charKeys.length >= 25, charKeys.length + ' 个');
t('提取到卡片字段表', mkKeys.length >= 20, mkKeys.length + ' 个');

// 这四个走卡片的标准字段（name / description / first_mes / 头像），不走 extensions；
// myProfile / myEnv 是【用户本人】的私事，明确不进卡（用户 2026-10-09 复核过这条边界）。
const EXPECTED_OUT = ['name', 'greeting', 'persona', 'avatar', 'myProfile', 'myEnv'];
const missing = charKeys.filter(k => !mkKeys.includes(k) && !EXPECTED_OUT.includes(k));
t('★ 角色上没有任何「卡片带不回来」的字段', missing.length === 0, missing.join(', '));
t('myProfile / myEnv 确实不在卡里（卡是会被分享出去的东西）',
  !mkKeys.includes('myProfile') && !mkKeys.includes('myEnv'));
t('scene / appearanceLive 在卡里（v1.21.53 补的两个）',
  mkKeys.includes('scene') && mkKeys.includes('appearanceLive'));

console.log('');
console.log('=== 2. 端到端：真的点导出、真的从导入入口喂回去 ===');
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
const sleep = ms => new Promise(r => setTimeout(r, ms));

await page.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'networkidle0', timeout: 40000 });
await sleep(1500);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil: 'networkidle0' }); await sleep(1200);

// 每个字段给一个【有辨识度的值】—— 默认值会让"没同步"看起来像"同步成功"
const SPEC = {
  temperature: 1.23, maxTokens: 3456, contextRounds: 17, reasoningEffort: 'high',
  kaomojiFreq: 0.42, kaomojiStyle: 'jp-soft', emojiFreq: 0.33, verbosity: 'short',
  descLevel: 'low', detailDrive: 'rich', splitMessages: true,
  povStyle: 'L3', povLock: false, thinkMode: true,
  searchPolicy: 'off', clockPolicy: 'global',
  appearance: '银发红瞳，黑色风衣', appearanceOn: true,
  longMemory: true, allowEditMine: true,
  typingDelay: 1.7, hesitation: false, showTyping: false,
  appearanceLive: '此刻披着外套', scene: '深夜的便利店门口',
};

const setup = await page.evaluate(async (spec) => {
  const { chars, kv, wb } = await import('./js/db.js');
  const id = 'cc-src-1';
  await chars.put({ id, name: '测试人物阿绫', greeting: '你来了。', persona: '她是旧书店的店主。',
    avatar: null, presetKey: 'blank', createdAt: Date.now(),
    myProfile: '我是本机的他', myEnv: '我住在城东', ...spec });
  await wb.putSolo({ id: 'cc-solo-1', charId: id, entries: [
    { id: 'e1', title: '书店', keys: ['书店'], content: '旧书店在巷子最里面。', on: true, pos: 'front' },
    { id: 'e2', title: '底色', keys: [], content: '这座城市常年下雨。', on: true, pos: 'always' },
  ] });
  await kv.set('lastCharId', id);
  const s = (await kv.get('settings', {})) || {};
  s.myProfile = '全局的他'; s.myEnv = '全局的居处';
  await kv.set('settings', s);
  return id;
}, SPEC);
t('测试角色建好了', !!setup);
await page.reload({ waitUntil: 'networkidle0' }); await sleep(1200);

// 拦下导出产生的 blob —— 那就是"导出的文件"
await page.evaluate(() => {
  window.__blobs = [];
  const orig = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (b) => { window.__blobs.push(b); return orig(b); };
});
await page.evaluate(() => document.getElementById('btn-cc-export-json').click());
await sleep(1200);
const cardText = await page.evaluate(async () => {
  if (!window.__blobs || !window.__blobs.length) return '';
  return await window.__blobs[0].text();
});
t('★ 点「导出为 JSON 卡」真的产出了一份文件', !!cardText && cardText.length > 50, cardText ? cardText.length + ' 字节' : '空');

let card = null;
try { card = JSON.parse(cardText); } catch (e) { card = null; }
t('产出的是合法 JSON 卡', !!card && !!card.data);
if (card) {
  t('卡里带人物名', card.data.name === '测试人物阿绫', String(card.data.name));
  t('卡里带人物设定（description）', card.data.description === '她是旧书店的店主。');
  t('卡里带开场白（first_mes）', card.data.first_mes === '你来了。');
  const p = (card.data.extensions && card.data.extensions.mengxianju && card.data.extensions.mengxianju.params) || {};
  const notInCard = Object.keys(SPEC).filter(k => p[k] === undefined);
  t('★ 26 项角色参数一项不少地进了卡', notInCard.length === 0, '缺: ' + notInCard.join(', '));
  t('参数的值原样保留', p.temperature === 1.23 && p.scene === '深夜的便利店门口' && p.povStyle === 'L3');
  const entries = (card.data.character_book && card.data.character_book.entries) || [];
  t('世界书两条都进卡了', entries.length === 2, entries.length + ' 条');
  t('常驻那条（没有触发词）没被滤掉', entries.some(e => e.content.includes('常年下雨')));
  t('标题与档位跟着进卡', entries.some(e => e.extensions && e.extensions.mengxianju && e.extensions.mengxianju.pos === 'always'));
  // ★ 隐私：卡是会被随手分享出去的东西
  t('★ 卡里不含 myProfile 的内容', !cardText.includes('我是本机的他'));
  t('★ 卡里不含 myEnv 的内容', !cardText.includes('我住在城东'));
}

console.log('');
console.log('=== 3. 从「导入角色卡」入口喂回去，逐字段比对 ===');
await page.evaluate((text) => {
  const dt = new DataTransfer();
  dt.items.add(new File([text], 'card.json', { type: 'application/json' }));
  const inp = document.getElementById('cc-import-file');
  inp.files = dt.files;
  inp.dispatchEvent(new Event('change'));
}, cardText);
await sleep(2500);

const after = await page.evaluate(async () => {
  const { chars } = await import('./js/db.js');
  const all = await chars.all();
  const mine = all.find(c => c.name === '测试人物阿绫' && c.id !== 'cc-src-1');
  if (!mine) return { found: false, count: all.length, names: all.map(c => c.name + '/' + c.id) };
  const { wb } = await import('./js/db.js');
  const solo = await wb.solo(mine.id);
  return { found: true, char: mine, entries: (solo && solo.entries) || [] };
});
t('★ 导入后多出了一个新角色', after.found, JSON.stringify(after.names || []));
if (after.found) {
  const c = after.char;
  const diff = [];
  for (const k of Object.keys(SPEC)) if (c[k] !== SPEC[k]) diff.push(k + '=' + JSON.stringify(c[k]) + '(want ' + JSON.stringify(SPEC[k]) + ')');
  t('★ 26 项参数逐项对得上', diff.length === 0, diff.join('; '));
  t('人物设定 / 开场白也回来了', c.persona === '她是旧书店的店主。' && c.greeting === '你来了。');
  t('★ myProfile 回落本机全局（卡里那份不进来）', c.myProfile === '全局的他', JSON.stringify(c.myProfile));
  t('★ myEnv 同样回落本机全局', c.myEnv === '全局的居处', JSON.stringify(c.myEnv));
  t('新角色是新的 id（卡片不覆盖本机角色）', c.id !== 'cc-src-1');
  t('世界书 2 条跟着进来了', after.entries.length === 2, after.entries.length + ' 条');
  t('世界书的标题/档位还原了',
    after.entries.some(e => e.pos === 'always' && e.title === '底色'),
    JSON.stringify(after.entries.map(e => e.title + '/' + e.pos)));
}
t('没有 JS 报错', errs.length === 0, errs.join(' | '));

console.log('');
console.log('=== 4. PNG 卡：导出 → 从 PNG 里读回卡片 ===');
const png = await page.evaluate(async () => {
  window.__blobs = [];
  document.getElementById('btn-cc-export-png').click();
  await new Promise(r => setTimeout(r, 2500));
  if (!window.__blobs || !window.__blobs.length) return { none: true };
  const buf = await window.__blobs[0].arrayBuffer();
  const mod = await import('./js/charcard.js');
  const isPng = mod.isPng(buf);
  if (!isPng) return { png: false, size: buf.byteLength };
  try {
    const card = mod.extractCardFromPng(buf);
    return { png: true, size: buf.byteLength, card };
  } catch (e) { return { png: true, size: buf.byteLength, err: String(e && e.message) }; }
});
t('★ 点「导出为 PNG 卡」产出了一张图', !!png && !png.none, JSON.stringify({ none: png && png.none }));
t('产出的是合法 PNG', !!png && png.png === true, JSON.stringify(png && png.size));
if (png && png.card) {
  // ⚠️ 注意结构：extractCardFromPng 返回的是 normalizeCard 处理过的【扁平】对象
  //    （extensions / entries 都在顶层），不是文件里那种 { data: {...} } 信封。
  //    第一版就是照 JSON 文件的结构写的，于是 png.card.data 是 undefined，
  //    测试自己在第 187 行崩了 —— 而真正该看的代码其实好好的。
  const box = (png.card.extensions && png.card.extensions.mengxianju) || {};
  const p2 = box.params || {};
  const miss2 = Object.keys(SPEC).filter(k => p2[k] === undefined);
  t('★ PNG 卡里参数同样一项不少', miss2.length === 0, '缺: ' + miss2.join(', '));
  t('PNG 卡里【不】再塞一份头像 dataURL（图本身就是头像，塞了等于翻倍）', box.avatar === undefined);
  t('PNG 卡里的世界书也在', (png.card.entries || []).length === 2, (png.card.entries || []).length + ' 条');
} else if (png && png.err) {
  t('PNG 卡能解析回卡片', false, png.err);
}

console.log('');
console.log('=== 5. 导出全部数据：备份里该有的都在 ===');
await page.evaluate(async () => {
  const { kv, msgs, mem } = await import('./js/db.js');
  const id = 'cc-src-1';
  await kv.set('clock:' + id, { day: 12, phase: 'night', season: '秋', locked: false });
  await kv.set('memRolling:' + id, { text: '我们一起过了第十二天。', upTo: 5, day: 12 });
  await msgs.add({ id: 'm1', charId: id, role: 'user', content: '在吗', ts: Date.now() });
  await msgs.add({ id: 'm2', charId: id, role: 'assistant', content: '在。', ts: Date.now() + 1, archived: true });
  await mem.add({ id: 'mem1', charId: id, text: '他喜欢雨天。', ts: Date.now() });
});
const backupText = await page.evaluate(async () => {
  window.__blobs = [];
  document.getElementById('btn-export').click();
  await new Promise(r => setTimeout(r, 2000));
  if (!window.__blobs || !window.__blobs.length) return '';
  return await window.__blobs[0].text();
});
t('★ 点「导出全部数据」产出了备份文件', !!backupText && backupText.length > 100, backupText ? backupText.length + ' 字节' : '空');
let bk = null;
try { bk = JSON.parse(backupText); } catch (e) { bk = null; }
if (bk) {
  t('备份里有角色', Array.isArray(bk.characters) && bk.characters.length >= 1);
  t('备份里有聊天记录（含已归档那条）',
    Object.values(bk.messages || {}).flat().some(m => m.archived === true),
    '消息总数 ' + Object.values(bk.messages || {}).flat().length);
  t('备份里有记忆', Array.isArray(bk.memories) && bk.memories.length >= 1);
  t('备份里有世界书', Array.isArray(bk.worldbook && bk.worldbook.solo) && bk.worldbook.solo.length >= 1);
  const kvKeys = (bk.kv || []).map(e => e.k);
  t('★ 备份带上了剧情时间（换机后不会回到第一天）', kvKeys.includes('clock:cc-src-1'), kvKeys.join(', ').slice(0, 120));
  t('★ 备份带上了滚动摘要（换机后不会失忆）', kvKeys.includes('memRolling:cc-src-1'));
  t('★ 备份里没有 API Key', !/"apiKey"\s*:\s*"[^"]+"/.test(backupText));
}

console.log('');
console.log('=== 6. 数据导入入口：坏文件要给出人话 ===');
await page.evaluate(() => {
  const dt = new DataTransfer();
  dt.items.add(new File(['{"foo":1}'], 'bad.json', { type: 'application/json' }));
  const inp = document.getElementById('file-import');
  inp.files = dt.files;
  inp.dispatchEvent(new Event('change'));
});
await sleep(1500);
const toastText = await page.evaluate(() => {
  const els = document.querySelectorAll('#toast');
  return Array.from(els).map(e => e.textContent).join(' ');
});
t('★ 喂一个不是备份的文件，提示说得清', /文件格式不对|导入失败/.test(toastText), JSON.stringify(toastText).slice(0, 160));
t('没有 JS 报错（收尾）', errs.length === 0, errs.join(' | '));

console.log('');
console.log('通过 ' + pass + ' / 失败 ' + fail);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
