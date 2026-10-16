// e2e-foreign-import.mjs — 外部文件导入的"边角料"（v0.4.2.1）
//
// 为什么单开一套：已有的 e2e-charcard / e2e-v040card / e2e-stworldbook / e2e-stchat /
// e2e-stregex / e2e-stpreset 把【主流格式】都钉住了，但"外面来的文件"真正会咬人的
// 是这几类边角料 —— 它们每一条都能让用户得到一个说不清的失败：
//   ① 老 TavernAI / Pygmalion 的卡（字段名完全不同：char_name / char_persona …）
//   ② 带 BOM 的 JSON（Windows 记事本"另存为 UTF-8"就是这个形状）
//   ③ 扩展名是假的（JSON 存成 .png、PNG 改叫 .json）—— 一律按文件头认
//   ④ 根本不是卡的文件（乱码 / 空文件）—— 要报清楚，不能白屏、不能建出半个角色
//   ⑤ __proto__ / constructor 这种键名 —— 外来 JSON 直接进对象的高风险面
//   ⑥ 同一份世界书从【两个入口】进来必须得到同一个结果（卡片 vs 世界书页）
import puppeteer from 'puppeteer-core';
import http from 'http'; import fs from 'fs'; import path from 'path'; import os from 'os';
const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');
const WWW = R + '/www';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8' };
let pass = 0, fail = 0;
const t = (n, ok, ex) => { if (ok) { pass++; console.log('  OK   ' + n); } else { fail++; console.log('  FAIL ' + n + (ex !== undefined ? '  -> ' + JSON.stringify(ex) : '')); } };

// ── 造边角料文件 ────────────────────────────────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mxj-foreign-'));
const W = (name, content) => { const p = path.join(dir, name); fs.writeFileSync(p, content); return p; };

const legacy = W('legacy-tavern.json', JSON.stringify({
  char_name: '老卡少女', char_persona: '她是很老的那一代卡。',
  world_scenario: '在旧时代的外界。', char_greeting: '（老卡的开场）',
  example_dialogue: '<START>' + String.fromCharCode(10) + '{{char}}: 你好。',
  personality: '冷静', creatorcomment: '来自 Pygmalion 时代',
}));

const v2 = { spec: 'chara_card_v2', spec_version: '2.0', data: {
  name: '带BOM的卡', description: '描述', personality: '性格', scenario: '场景',
  first_mes: '（开场）', mes_example: '<START>', creator_notes: '备注',
  tags: ['标签A'], alternate_greetings: ['（另一个开场）'],
  character_book: { name: '书', entries: [
    { keys: ['雾'], content: '普通的条目。', enabled: true },
    { keys: [], content: '没有触发词的条目。', enabled: true },
  ] },
} };
const bomFile = W('bom-card.json', '\uFEFF' + JSON.stringify(v2));
const wrongExt = W('card-actually-json.png', JSON.stringify(v2));

const garbage = W('garbage.png', '这不是 JSON，也不是 PNG。');
const emptyFile = W('empty.json', '');

const pollutedCard = W('polluted.json', JSON.stringify({
  spec: 'chara_card_v2', spec_version: '2.0',
  data: { name: '污染测试卡', description: 'x', first_mes: 'y',
    extensions: { __proto__: { hacked: 'yes' }, constructor: { hacked2: 'yes' } },
    character_book: { name: 'b', entries: { __proto__: { key: ['甲'], content: '不该出现' },
      0: { key: ['乙'], content: '正常的条目。' } } } },
}));

const loreArr = W('lorebook-array.json', JSON.stringify([
  { comment: '数组条目', key: ['风'], content: '数组形态的内容。', position: 0 },
  { comment: '数组常驻', key: [], content: '数组常驻的内容。', constant: true },
]));

const namedLore = W('named-lorebook.json', JSON.stringify({
  name: '我给它起的名字',
  entries: [{ comment: '带名字的条目', key: ['名字词'], content: '带名字外壳的内容。', position: 0 }],
}));

const cardWithBook = W('card-with-book-map.json', JSON.stringify({
  spec: 'chara_card_v2', spec_version: '2.0',
  data: { name: '卡内世界书', description: 'x', first_mes: '（开场）',
    // ⚠️ 规范写的是数组，但现实里【映射】形态大量存在（酒馆世界书就是这个形状）
    character_book: { name: '书', entries: {
      0: { key: ['卡内词'], comment: '卡内条目一', content: '卡内世界书的内容一。' },
      1: { key: [], comment: '卡内常驻', content: '卡内世界书的内容二。', constant: true },
    } } },
}));

// KoboldAI 的世界书：key / keysecondary 是【逗号分隔字符串】，不是数组
const koboldWi = W('kobold-wi.json', JSON.stringify({
  entries: [{
    key: '甲,乙,丙', keysecondary: '战斗,夜晚', comment: '科博德风格',
    content: '科博德风格的内容。', constant: false, selective: true, position: 0,
  }],
}));

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
await page.setRequestInterception(true);
page.on('request', req => {
  if (req.url().includes('/chat/completions')) {
    req.respond({ status: 200, headers: { 'Access-Control-Allow-Origin':'*' }, contentType: 'application/json',
      body: JSON.stringify({ choices: [{ message: { content: '好。' } }] }) });
    return;
  }
  req.continue();
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
const chars = () => page.evaluate(async () => {
  const { chars } = await import('./js/db.js');
  const all = await chars.all();
  return all.map(c => ({ id: c.id, name: c.name, greeting: c.greeting || '', persona: c.persona || '',
    tags: c.tags || [], alts: c.alternateGreetings || [], cf: c.cardFields || {} }));
});
const charByName = async (nm) => (await chars()).find(c => c.name === nm) || null;
const soloOf = (cid) => page.evaluate(async (id) => {
  const { wb } = await import('./js/db.js');
  const s = await wb.solo(id);
  return s ? (s.entries || []).map(e => ({ title: e.title, keys: e.keys, pos: e.pos, on: e.on,
    review: e.needsReview === true, why: e.reviewWhy || '', content: e.content })) : null;
}, cid);
const toasts = () => page.evaluate(() => [...document.querySelectorAll('.toast, #toast, .toast-box')]
  .map(e => (e.textContent || '').trim()).filter(Boolean));

const openSettings = async () => {
  for (let i = 0; i < 6; i++) {
    const cur = await page.evaluate(() => (document.querySelector('.view.active') || {}).id);
    if (cur === 'view-chat') break;
    await page.evaluate(() => {
      const b = document.getElementById('btn-edit-back') || document.getElementById('btn-chars-back')
             || document.getElementById('btn-set-back') || document.getElementById('btn-drawer-close')
             || document.getElementById('btn-wb-back');
      if (b) b.click();
    });
    await sleep(400);
  }
  await page.evaluate(() => document.getElementById('btn-settings').click()); await sleep(700);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('#drawer-menu [data-wb-drawer]')].find(x => x.dataset.wbDrawer === 'settings');
    if (b) b.click();
  }); await sleep(800);
};
const backToChat = async () => {
  for (let i = 0; i < 8; i++) {
    const cur = await page.evaluate(() => (document.querySelector('.view.active') || {}).id);
    if (cur === 'view-chat') return;
    await page.evaluate(() => {
      const b = document.getElementById('btn-edit-back') || document.getElementById('btn-chars-back')
             || document.getElementById('btn-set-back') || document.getElementById('btn-drawer-close')
             || document.getElementById('btn-wbs-back') || document.getElementById('btn-wb-back')
             || document.getElementById('btn-wbg-back') || document.getElementById('btn-wbe-back');
      if (b) b.click();
    });
    await sleep(350);
  }
};
const openWorldbookPage = async () => {
  await backToChat();
  await page.evaluate(() => document.getElementById('btn-settings').click()); await sleep(700);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('#drawer-menu [data-wb-drawer]')].find(x => x.dataset.wbDrawer === 'worldbook');
    if (b) b.click();
  }); await sleep(900);
};
const importCard = async (file) => {
  await openSettings();
  const inp = await page.$('#cc-import-file');
  await inp.uploadFile(file);
  await sleep(2200);
};

await page.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'networkidle0', timeout: 40000 });
await sleep(1200);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil: 'networkidle0' }); await sleep(800);
await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => o.onsuccess = () => r(o.result));
  const put = (st, rec) => new Promise(r => { const tx = db.transaction(st, 'readwrite'); tx.objectStore(st).put(rec); tx.oncomplete = r; });
  const rec = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get('settings'); q.onsuccess = () => r(q.result); });
  await put('kv', { k: 'settings', v: Object.assign({}, (rec && rec.v) || {}, { apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com' }) });
  db.close();
});
await page.reload({ waitUntil: 'networkidle0' }); await sleep(900);

console.log('');
console.log('=== 1. 老 TavernAI / Pygmalion 的卡（字段名完全不一样） ===');
{
  await importCard(legacy);
  const c = await charByName('老卡少女');
  t('卡建出来了（原来只会报「卡片里没有 name 字段」）', !!c, await chars());
  t('char_persona → 人设', !!c && c.persona.includes('很老的那一代卡'), c && c.persona.slice(0, 40));
  t('char_greeting → 开场白', !!c && c.greeting === '（老卡的开场）', c && c.greeting);
  // ⚠️ 卡里那几项（personality / scenario / mes_example）落在 c.cardFields 上（v0.4.2），
  //    不是 c.scenario 这种平铺字段 —— 读错地方会得出"没导进来"的假结论。
  const p = await page.evaluate(async () => {
    const { chars } = await import('./js/db.js');
    const c = (await chars.all()).find(x => x.name === '老卡少女');
    if (!c) return null;
    const cf = c.cardFields || {};
    return { scenario: cf.scenario || '', personality: cf.personality || '', mes: cf.mesExample || '', notes: c.creatorNotes || '' };
  });
  t('world_scenario → 场景', !!p && String(p.scenario).includes('旧时代'), p);
  t('example_dialogue → 对话范例', !!p && String(p.mes).includes('你好'), p);
  t('personality → 性格', !!p && String(p.personality).includes('冷静'), p);
  t('creatorcomment → 作者的话', !!p && String(p.notes).includes('Pygmalion'), p);
}

console.log('');
console.log('=== 2. 带 BOM 的 JSON（记事本另存为 UTF-8 的形状） ===');
{
  await importCard(bomFile);
  const c = await charByName('带BOM的卡');
  t('BOM 被剥掉了，卡照样进来', !!c, (await chars()).map(x => x.name));
  t('tags 存下来了（原来读了就扔）', !!c && (c.tags || []).includes('标签A'), c && c.tags);
  t('备选开场白存下来了（原来只 toast 一句"没有这个概念"）',
    !!c && (c.alts || []).includes('（另一个开场）'), c && c.alts);
}

console.log('');
console.log('=== 3. 扩展名是假的：内容其实是 JSON，文件名写 .png ===');
{
  await importCard(wrongExt);
  const n = (await chars()).filter(c => c.name === '带BOM的卡').length;
  t('按文件头认出是 JSON，导入成功（不看扩展名）', n === 2, n);
}

console.log('');
console.log('=== 4. 世界书：同一份内容从【两个入口】进来结果一致 ===');
{
  // ① 裸数组文件（外壳就是一个 [ … ]）—— 原来这一类会走到"已导入 0 个角色组"【假成功】
  await openWorldbookPage();
  await (await page.$('#wb-import-file')).uploadFile(loreArr);
  await sleep(2600);
  console.log('   toast: ' + JSON.stringify((await toasts()).slice(-2)));
  const g1 = await page.evaluate(async () => {
    const { wb } = await import('./js/db.js');
    const gs = await wb.groups();
    const g = (gs || []).find(x => x.name === 'lorebook-array');
    return g ? g.entries.map(e => ({ title: e.title, keys: e.keys, pos: e.pos, review: e.needsReview === true })) : null;
  });
  t('裸数组形态的世界书导进来了', !!g1 && g1.length === 2, g1);
  t('普通条目 → front，常驻 → always', !!g1 && g1[0].pos === 'front' && g1[1].pos === 'always', g1);
  t('两条都不需要人确认', !!g1 && g1.every(e => e.review === false), g1);

  // ② 带名字的外壳：{ name, entries } —— 名字该当组名
  await openWorldbookPage();
  await (await page.$('#wb-import-file')).uploadFile(namedLore);
  await sleep(2600);
  const g2 = await page.evaluate(async () => {
    const { wb } = await import('./js/db.js');
    const gs = await wb.groups();
    const g = (gs || []).find(x => x.name === '我给它起的名字');
    return g ? g.entries.map(e => ({ title: e.title, keys: e.keys })) : null;
  });
  t('{name, entries} 的组名用的是文件里的 name（不是文件名）', !!g2 && g2.length === 1, g2);

  // ③ 同一份内容从【角色卡】进来：形状要一致
  await importCard(cardWithBook);
  const cb = await charByName('卡内世界书');
  const solo = cb ? await soloOf(cb.id) : null;
  t('卡里的 character_book（entries 是【映射】）也导进来了', !!solo && solo.length === 2, solo);
  t('映射形态的条目触发词正确', !!solo && solo[0].keys.includes('卡内词'), solo);
}

console.log('');
console.log('=== 4b. KoboldAI 的世界书：key 是逗号分隔的字符串 ===');
{
  await openWorldbookPage();
  await (await page.$('#wb-import-file')).uploadFile(koboldWi);
  await sleep(2600);
  const g = await page.evaluate(async () => {
    const { wb } = await import('./js/db.js');
    const gs = await wb.groups();
    const one = (gs || []).find(x => x.name === 'kobold-wi');
    return one ? one.entries.map(e => ({ keys: e.keys, sec: e.secondary || null, review: e.needsReview === true })) : null;
  });
  console.log('   ' + JSON.stringify(g));
  t('逗号分隔的 key 被拆成三个触发词（整串当一个 = 永远匹配不上）',
    !!g && JSON.stringify(g[0].keys) === JSON.stringify(['甲', '乙', '丙']), g);
  t('逗号分隔的 keysecondary 也被拆开', !!g && JSON.stringify(g[0].sec) === JSON.stringify(['战斗', '夜晚']), g);
}

console.log('');
console.log('=== 5. 乱码 / 空文件：报清楚，不建半个角色，不白屏 ===');
{
  const before = (await chars()).length;
  await importCard(garbage);
  await importCard(emptyFile);
  const after = (await chars()).length;
  const ts = await toasts();
  console.log('   toast: ' + JSON.stringify(ts.slice(-3)));
  t('两次都失败了，但一个角色都没建出来', after === before, { before, after });
  t('给了明确的失败提示（不是静默）', ts.some(x => x.includes('导入失败') || x.includes('读不了')), ts.slice(-3));
  t('页面还活着（能读到角色列表）', Array.isArray(await chars()));
}

console.log('');
console.log('=== 6. 外来 JSON 里的 __proto__ / constructor ===');
{
  const safe = await page.evaluate(async () => {
    const { parseJsonSafe } = await import('./js/charcard.js');
    const o = parseJsonSafe('{"a":1,"__proto__":{"hacked":"yes"},"constructor":{"x":1}}');
    return {
      proto: Object.getPrototypeOf(o) === Object.prototype,
      hacked: ({}).hacked === undefined,
      hasOwn: Object.prototype.hasOwnProperty.call(o, '__proto__'),
      a: o.a,
    };
  });
  t('parseJsonSafe：__proto__ 没有被当成键建出来', safe.hasOwn === false, safe);
  t('parseJsonSafe：原型没被换掉', safe.proto === true, safe);
  t('parseJsonSafe：正常字段照常解析', safe.a === 1, safe);
  t('全局对象没被污染', safe.hacked === true, safe);

  await importCard(pollutedCard);
  const c = await charByName('污染测试卡');
  t('带污染键的卡照样导得进来', !!c, (await chars()).map(x => x.name));
  t('全局对象依然干净', await page.evaluate(() => ({}).hacked === undefined && ({}).hacked2 === undefined));
  const es = c ? await soloOf(c.id) : null;
  console.log('   条目: ' + JSON.stringify(es));
  t('映射形态的 character_book 现在导得进来（原来整块静默消失）', !!es && es.length === 1, es);
  t('条目映射里那个 __proto__ 键没有被当成一条条目', !!es && es.every(e => !String(e.content).includes('不该出现')), es);
  t('正常那条还在', !!es && es.some(e => String(e.content).includes('正常的条目')), es);
}

console.log('');
console.log('=== 7. 备选开场白：长按开场白能一条条换 ===');
{
  // 切到这个角色的聊天页
  await backToChat();
  await page.evaluate(() => document.getElementById('btn-chars').click()); await sleep(900);
  const ok = await page.evaluate(() => {
    const card = [...document.querySelectorAll('#char-list .char-card')].find(x => (x.textContent || '').includes('带BOM的卡'));
    if (!card) return false;
    card.click(); return true;
  });
  t('从角色列表进了她的聊天', ok, (await chars()).map(c => c.name));
  await sleep(1500);
  const first = await page.evaluate(() => {
    const m = document.querySelector('#messages .msg');
    return m ? (m.querySelector('.bub') || {}).textContent : null;
  });
  t('开场白是她卡里的 first_mes', String(first || '').includes('（开场）'), first);
  // 长按 = contextmenu（桌面端等价路径，和 touchstart 550ms 走同一个 showMsgMenu）
  await page.evaluate(() => {
    const m = document.querySelector('#messages .msg');
    if (m) m.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
  });
  await sleep(700);
  const hasItem = await page.evaluate(() => {
    const box = document.querySelector('.msg-menu');
    if (!box) return null;
    const b = [...box.querySelectorAll('button')].find(x => (x.textContent || '').includes('换一个开场白'));
    if (!b) return null;
    b.click();
    return b.textContent.trim();
  });
  t('菜单里有「换一个开场白」', !!hasItem, hasItem);
  await sleep(1200);
  const now = await page.evaluate(() => {
    const m = document.querySelector('#messages .msg');
    return m ? (m.querySelector('.bub') || {}).textContent : null;
  });
  t('开场白换成了备选那一条', String(now || '').includes('另一个开场'), now);
  // 再换一次应该循环回第一条
  await page.evaluate(() => {
    const m = document.querySelector('#messages .msg');
    if (m) m.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
  });
  await sleep(700);
  await page.evaluate(() => {
    const box = document.querySelector('.msg-menu');
    const b = box && [...box.querySelectorAll('button')].find(x => (x.textContent || '').includes('换一个开场白'));
    if (b) b.click();
  });
  await sleep(1200);
  const back2 = await page.evaluate(() => {
    const m = document.querySelector('#messages .msg');
    return m ? (m.querySelector('.bub') || {}).textContent : null;
  });
  t('再换一次循环回第一条', String(back2 || '').includes('（开场）'), back2);
}

console.log('');
console.log('=== 8. 全程没有 JS 错误 ===');
t('无 pageerror', errs.length === 0, errs.slice(0, 3));

console.log('');
console.log('通过 ' + pass + ' / 失败 ' + fail);
await browser.close(); server.close();
fs.rmSync(dir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
