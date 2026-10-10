// 世界书「触发词」输入框 —— 安卓软键盘回车 bug 的回归测试
//
// 现场（用户真机 v1.20.17）：在触发词框里打字，按回车不加标签，
// 光标跑到下面的「内容」textarea 里换行，保存时被 toast 拦住「至少写一个触发词」。
//
// 根因两条：
//   1) 安卓软键盘的回车不一定报 key==='Enter'（组合态给 'Unidentified'/229）
//   2) 输入框没套 form，安卓把它当普通文本域，回车默认行为 = 跑到下一个控件
//
// 这个套件用合成的 KeyboardEvent 覆盖 WebView 的真实失败模式，逐个验：
//   · 标准 Enter（桌面）
//   · 安卓组合态回车（key='Unidentified', keyCode=229）—— 不许误加
//   · 只发 form submit（软键盘"前往"键）—— 必须能加
//   · keydown 什么都不给、只发 keyup —— 必须能加
//   · 点「加」按钮 —— 必须能加
//   · 内容框回车必须仍然换行
//   · 重词 / 空词 / 删标签 / 焦点位置

import puppeteer from 'puppeteer-core';
import http from 'http'; import fs from 'fs'; import path from 'path';
// 工作目录自适应（原来写死 C:/A-DSH-Tool/ai-companion）
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
await sleep(1200);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil:'networkidle0' }); await sleep(600);

console.log('=== 1. 造角色 + 开条目编辑器 ===');
const cid = await page.evaluate(async () => {
  const { chars } = await import('./js/db.js');
  const id = 'wbkey-c1';
  await chars.put({ id, name: '测试角色', greeting: 'hi', persona: '你是测试角色。', avatar: null,
    temperature: 1, maxTokens: 2048, topP: 1, contextRounds: 20, createdAt: Date.now() });
  const { kv } = await import('./js/db.js');
  await kv.set('lastCharId', id);      // 选中她，世界书「单独角色」才认得
  return id;
});
t('角色已建', cid === 'wbkey-c1');

// 走真实 UI：⚙ 抽屉 → 世界书 → 单独角色 → 选人 → ＋新建条目
// ⚠️ 世界书总开关默认是关的，关着时「单独角色」不响应（见 app.js:1966）
await page.evaluate(async () => {
  const { kv } = await import('./js/db.js');
  const s = await kv.get('settings', {});
  s.worldbookOn = true;
  await kv.set('settings', s);
});
await page.reload({ waitUntil: 'networkidle0' });
await sleep(600);
await page.click('#btn-settings');
await sleep(400);
const wbOpened = await page.evaluate(async () => {
  const b = document.querySelector('[data-wb-drawer="worldbook"]');
  if (!b) return 'no-item';
  b.click();
  return 'ok';
});
await sleep(500);
const soloOpened = await page.evaluate(async () => {
  const b = document.getElementById('btn-wb-solo');
  if (!b) return 'no-btn';
  b.click();
  return 'ok';
});
await sleep(500);
const picked = await page.evaluate(() => {
  const r = document.querySelector('#pk-list .pick-row');
  if (!r) {
    const m = document.getElementById('modal');
    return 'no-row | modalHidden=' + (m ? m.classList.contains('hidden') : '?') +
      ' | popup=' + document.getElementById('popup') + ' | rows=' + document.querySelectorAll('#pk-list > *').length;
  }
  r.click();
  return 'ok';
});
await sleep(600);
const opened = await page.evaluate(async () => {
  const b = document.getElementById('btn-wb-newentry2');
  if (!b) return 'no-newentry2';
  b.click();
  await new Promise(r => setTimeout(r, 500));
  return document.getElementById('we-key-input') ? 'ok' : 'no-input';
});
console.log('   世界书入口: ' + wbOpened + ' / 单独: ' + soloOpened + ' / 选人: ' + picked);
t('条目编辑器打开了', opened === 'ok', opened + ' | ' + errs.join('|'));
if (opened !== 'ok') {
  console.log('\nJS 错误: ' + (errs.length ? errs.join(' | ') : '无'));
  console.log('\n结果: pass='+pass+' fail='+fail);
  await browser.close(); server.close(); process.exit(1);
}

const keyCount = () => page.$$eval('.key-box .key-tag', els => els.length);
const keyTexts = () => page.$$eval('.key-box .key-tag', els => els.map(e => e.textContent.replace('✕','').trim()));
const focused  = () => page.evaluate(() => document.activeElement && document.activeElement.id);
const val      = sel => page.$eval(sel, el => el.value);

console.log('=== 2. 标准 Enter（桌面） ===');
await page.click('#we-key-input');
await page.type('#we-key-input', '红魔馆');
await page.keyboard.press('Enter');
await sleep(150);
t('标准 Enter 加上了标签', (await keyCount()) === 1, 'count=' + await keyCount());
t('标签内容正确', (await keyTexts())[0] === '红魔馆', JSON.stringify(await keyTexts()));
t('加完焦点还在触发词框（不会跑掉）', (await focused()) === 'we-key-input', await focused());

console.log('=== 3. 安卓组合态回车（key=Unidentified, keyCode=229） ===');
await page.type('#we-key-input', '巫女服');
await page.evaluate(() => {
  document.getElementById('we-key-input').dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Unidentified', keyCode: 229, bubbles: true, cancelable: true }));
});
await sleep(150);
t('拼音组合态的回车不误加标签', (await keyCount()) === 1, 'count=' + await keyCount());
t('输入内容还在框里没被吞', (await val('#we-key-input')) === '巫女服', await val('#we-key-input'));

console.log('=== 4. 软键盘"前往"键：只发 form submit（焦点在触发词框） ===');
await page.evaluate(() => {
  document.getElementById('we-key-input').focus();
  document.getElementById('we-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
});
await sleep(150);
t('form submit 能加上标签', (await keyCount()) === 2, 'count=' + await keyCount());
t('第二条是「巫女服」', (await keyTexts())[1] === '巫女服', JSON.stringify(await keyTexts()));

console.log('=== 5. 只发 keyup（有些输入法 keydown 什么都不给） ===');
await page.type('#we-key-input', '符卡');
await page.evaluate(() => {
  document.getElementById('we-key-input').dispatchEvent(
    new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
});
await sleep(150);
t('只发 keyup 也能加上', (await keyCount()) === 3, 'count=' + await keyCount());

console.log('=== 6. 焦点位置 ===');
t('焦点没跑到 we-content', (await focused()) !== 'we-content', await focused());

console.log('=== 7. 内容框回车必须仍然换行 ===');
await page.click('#we-content');
await page.evaluate(() => { document.getElementById('we-content').value = '第一行'; });
await page.keyboard.press('Enter');
await page.type('#we-content', '第二行');
const cv = await val('#we-content');
t('内容框回车是换行', cv.includes('\n') && cv.includes('第一行') && cv.includes('第二行'), JSON.stringify(cv));
t('内容框回车没多出触发词', (await keyCount()) === 3, 'count=' + await keyCount());

console.log('=== 8. 重复词 / 空词 ===');
await page.click('#we-key-input');
await page.type('#we-key-input', '红魔馆');
await page.keyboard.press('Enter');
await sleep(200);
t('重复词不重复加', (await keyCount()) === 3, 'count=' + await keyCount());
t('重复词留在框里（让人看清打了什么）', (await val('#we-key-input')) === '红魔馆', JSON.stringify(await val('#we-key-input')));
await page.evaluate(() => { document.getElementById('we-key-input').value = ''; });
await page.keyboard.press('Enter');
await sleep(150);
t('空输入回车不加也不炸', (await keyCount()) === 3, 'count=' + await keyCount());

console.log('=== 9. 删标签 ===');
await page.click('.key-box .key-tag .kt-x');
await sleep(200);
t('删标签生效', (await keyCount()) === 2, 'count=' + await keyCount());

console.log('=== 10. 回车被 preventDefault（不会冒泡到外层） ===');
const prevented = await page.evaluate(() => {
  const inp = document.getElementById('we-key-input');
  inp.value = '测试词';
  const ev = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true });
  inp.dispatchEvent(ev);
  return ev.defaultPrevented;
});
t('Enter 被 preventDefault', prevented === true, String(prevented));

console.log('=== 11. 填齐后能保存 ===');
await page.evaluate(() => {
  document.getElementById('we-title').value = '测试条目';
  document.getElementById('we-content').value = '这是一段内容';
});
await page.click('#modal-ok');
await sleep(700);
const hidden = await page.evaluate(() => document.getElementById('modal').classList.contains('hidden'));
t('保存后弹窗关掉了', hidden === true, String(hidden));
const stored = await page.evaluate(async () => {
  const { wb } = await import('./js/db.js');
  const all = await wb.soloAll();
  const s = all.find(x => x.charId === 'wbkey-c1') || all[0];
  return { n: all.length, rec: s ? { id: s.id, charId: s.charId } : null,
           ents: s ? s.entries.map(e => ({ title: e.title, keys: e.keys })) : null };
});
t('条目真的落库了', stored && stored.ents && stored.ents.length === 1, JSON.stringify(stored));
t('落库的触发词对（测试词 + 删剩的）',
  stored && stored.ents && stored.ents[0] && stored.ents[0].keys.length >= 3,
  JSON.stringify(stored && stored.ents && stored.ents[0] && stored.ents[0].keys));

console.log('=== 12. 重新打开编辑器，旧触发词还在 ===');
await page.evaluate(() => { document.querySelector('#wbs-list .wb-item').click(); });
await sleep(500);
const reopened = await page.evaluate(() => {
  const tags = [...document.querySelectorAll('.key-box .key-tag')].map(e => e.textContent.replace('✕','').trim());
  return { hasInput: !!document.getElementById('we-key-input'), tags };
});
t('重新打开能看到旧标签', reopened.hasInput && reopened.tags.length >= 3, JSON.stringify(reopened));


console.log('=== 13. 已有的条目：点开 → 改 → 保存（用户报的第二个问题）===');
await page.evaluate(() => {
  const m = document.getElementById('modal');
  if (m) m.classList.add('hidden');
});
await sleep(200);
const clickExisting = await page.evaluate(() => {
  const it = document.querySelector('#wbs-list .wb-item');
  if (!it) return 'no-item';
  it.click();
  return document.getElementById('we-key-input') ? 'opened' : 'no-input';
});
await sleep(500);
t('点已有条目能打开编辑器', clickExisting === 'opened', clickExisting);
const before = await page.evaluate(() => ({
  title: (document.getElementById('we-title') || {}).value,
  content: (document.getElementById('we-content') || {}).value,
  keys: [...document.querySelectorAll('.key-box .key-tag')].map(e => e.textContent.replace('✕','').trim()),
}));
t('编辑器里带出了原值', before.title === '测试条目' && before.content === '这是一段内容',
  JSON.stringify(before));
t('编辑器里带出了原触发词', before.keys.length >= 3, JSON.stringify(before.keys));

// 加一个新触发词（走回车）
await page.click('#we-key-input');
await page.type('#we-key-input', '新增词');
await page.keyboard.press('Enter');
await sleep(200);
t('已有条目里加触发词成功', (await keyCount()) === before.keys.length + 1, 'count=' + await keyCount());

// 改内容再存
await page.evaluate(() => { document.getElementById('we-content').value = '改过的内容'; });
await page.click('#modal-ok');
await sleep(700);
const after = await page.evaluate(async () => {
  const { wb } = await import('./js/db.js');
  const all = await wb.soloAll();
  const s = all.find(x => x.charId === 'wbkey-c1') || all[0];
  return s ? s.entries.map(e => ({ title: e.title, content: e.content, keys: e.keys })) : null;
});
t('改动落库了（内容变了）', after && after[0] && after[0].content === '改过的内容', JSON.stringify(after));
t('新触发词落库了', after && after[0] && after[0].keys.includes('新增词'), JSON.stringify(after && after[0] && after[0].keys));
t('没有变成两条（是改不是加）', after && after.length === 1, 'entries=' + (after ? after.length : 'null'));

console.log('=== 14. 条目「启用/停用」开关 ===');
await page.evaluate(() => { document.querySelector('#wbs-list .wb-item').click(); });
await sleep(500);
await page.evaluate(() => { const c = document.getElementById('we-on'); c.checked = false; });
await page.click('#modal-ok');
await sleep(700);
const off = await page.evaluate(async () => {
  const { wb } = await import('./js/db.js');
  const all = await wb.soloAll();
  const s = all.find(x => x.charId === 'wbkey-c1') || all[0];
  return s ? s.entries[0].on : 'none';
});
t('停用状态存下来了', off === false, String(off));
const shownOff = await page.evaluate(() => !!document.querySelector('#wbs-list .wi-off'));
t('列表里显示了「已关闭」', shownOff === true, String(shownOff));

console.log('\nJS 错误: ' + (errs.length ? errs.join(' | ') : '无'));
t('无 JS 报错', errs.length === 0, errs.join(' | '));
console.log('\n结果: pass='+pass+' fail='+fail);
await browser.close(); server.close();
process.exit(fail?1:0);