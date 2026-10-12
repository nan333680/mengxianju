import puppeteer from 'puppeteer-core';
import { seedChar, seedChars, pickImportMode } from './e2e-helper.mjs';
import http from 'http';
import fs from 'fs';
import path from 'path';
// 工作目录自适应（原来写死 C:/A-DSH-Tool/ai-companion）
const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');

const WWW = `${R}/www`;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
// ⚠️ v1.21.40：产品默认 apiKey 已改成空串（预置的那把反编译就能拿走，已移除）。
// 本套件要真调模型，Key 只能自己给 —— 环境变量优先，没有就用占位符。
const KEY = process.env.DSH_API_KEY || 'sk-test';
// 第 8 步「数据兼容」用的 1.1.2 时期真实备份样本。
// ⚠️ 别再指向 DSH 的附件缓存目录（\.dsh\attachments\...）——那份是上传时的临时副本，
// 缓存被清理后文件就没了。实测踩到：文件消失后测试读空 → 导入 0 角色 0 消息 0 记忆，
// 5 项断言全挂，而且挂得像是代码坏了（实际是样本没了）。
// 样本的 SHA256：2ee833b9a224f2f54827b8a13abc6c0a98de75d44a40df1be032e5890b7552f5
const BACKUP = `${R}\\_fixtures\\梦弦居备份-2026-09-16.json`;
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8' };
const server = http.createServer((req,res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p==='/') p='/index.html';
  const f = path.join(WWW, p);
  if (!fs.existsSync(f)) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f));
});
await new Promise(r => server.listen(0,'127.0.0.1',r));
const port = server.address().port;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = [];
page.on('pageerror', e => errs.push(e.message));
const sleep = ms => new Promise(r=>setTimeout(r,ms));

// v1.15.2 起右上角 ⚙ 拉开【抽屉】，设置页要从抽屉里的「全部设置」进。
// 这个函数兼容两种点法，且可重复调用（已进设置页就直接返回）。
const openSettings = async (page, sleep) => {
  // 先退到聊天页：栈底是 chat，其它页面连点返回即可。
  // ⚠️ 只在 view-chat 时点 ⚙ 是不够的 —— 从角色列表/编辑页进来时
  //    当前页不是 chat，会跳过这一步，后续所有断言都打在不可见的页面上（踩过）。
  for (let i = 0; i < 6; i++) {
    const cur = await page.evaluate(() => (document.querySelector('.view.active') || {}).id);
    if (cur === 'view-chat') break;
    await page.evaluate(() => {
      const b = document.getElementById('btn-edit-back')
             || document.getElementById('btn-chars-back')
             || document.getElementById('btn-set-back')
             || document.getElementById('btn-drawer-close')
             || document.getElementById('btn-wb-back');
      if (b) b.click();
    });
    await sleep(500);
  }
  await page.evaluate(() => document.getElementById('btn-settings').click());
  await sleep(800);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('#drawer-menu [data-wb-drawer]')].find(x => x.dataset.wbDrawer === 'settings');
    if (b) b.click();
  });
  await sleep(900);
};
let pass=0, fail=0;
const t=(n,ok,ex='')=>{ if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));} };

await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
await sleep(1500);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil:'networkidle0' });
await sleep(200);
// ⚠️ 把 Key 写进库再重载（v1.21.40）。
// 【读-改-写】而不是整表覆盖：settings 里还有 clockMode 等一堆字段，
// 整体替换会让 app 当成本机是"老数据升级"，把 clockMode 迁移成 false。
await page.evaluate(async (k) => {
  await new Promise((res) => {
    const o = indexedDB.open('ai-companion');
    o.onsuccess = () => {
      const db = o.result;
      const g = db.transaction('kv').objectStore('kv').get('settings');
      g.onsuccess = () => {
        const v = Object.assign({}, (g.result && g.result.v) || {}, { apiKey: k });
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put({ k: 'settings', v });
        tx.oncomplete = () => { db.close(); res(); };
      };
      g.onerror = () => { db.close(); res(); };
    };
    o.onerror = () => res();
  });
}, KEY);
await page.reload({ waitUntil:'networkidle0' }); await sleep(700);

console.log('=== 1. 设置页只剩全局的东西 ===');
await openSettings(page, sleep);
const groups = await page.$$eval('#view-settings .group h3', els => els.map(e => e.textContent.trim()));
console.log('   实际栏目: ' + JSON.stringify(groups));
// v1.14.0 起「我的设定」改成了「我的相关设定」折叠头（不再是 <h3> 栏目），
// 所以 h3 列表里不该再有它 —— 用折叠头 id 单独确认它在
// v1.20.13 起多了「联网搜索」一栏
// v1.21.31 起多了「描写详细程度」一栏（detailDrive 全局档）
// v1.21.34 起「描写详细程度」改名为「描写与表达」（同时容纳 descLevel 与 detailDrive 两项）
// v1.21.40 起多了「角色卡」一栏（导入导出 SillyTavern / chub.ai 的卡，实验性）
// v1.21.48 起多了「写字台」一栏（输入框高度 / 回车键行为）—— 排在「描写与表达」后面
// v1.21.57 起「接口」「时段划分」也收成了折叠头（不再是 <h3>），h3 列表里没有它们 ——
// 和上面 #mine-fold / #mem-fold 一样，用折叠头 id 单独确认还在。
// v1.21.61 起设置页拆成两个：「全局设置」管她和全局（接口/描写/写字台/记忆/联网/时段），
// 「我的设置」管你自己（头像/外观/数据/角色卡）。所以这里只看全局那页的 h3。
// v0.3.1 加了第 5 个栏目「酒馆预设」（酒馆预设导入的入口，见 CHANGELOG 2.2）
// v0.4.0 又加了「酒馆正则」（从卡/预设带过来的正则，逐条开关）
//        和「酒馆聊天记录」（.jsonl 导入）—— 都在「我的设置」这页里
// 「我的设置」那页单独确认
await page.evaluate(() => document.getElementById('btn-set-back').click()); await sleep(400);
await page.evaluate(() => { const b = document.getElementById('btn-drawer-close'); if (b && document.querySelector('#view-drawer.active')) b.click(); }); await sleep(400);
await page.evaluate(() => document.getElementById('btn-settings').click()); await sleep(600);
await page.evaluate(() => { const b = [...document.querySelectorAll('#drawer-menu [data-wb-drawer]')].find(x => x.dataset.wbDrawer === 'mine'); if (b) b.click(); }); await sleep(700);
const mineGroups = await page.$$eval('#view-mine .group h3', els => els.map(e => e.textContent.trim()));
console.log('   我的设置栏目: ' + JSON.stringify(mineGroups));
t('我的设置页栏目正确（我的头像/外观/数据/角色卡/酒馆正则/酒馆聊天记录）',
  JSON.stringify(mineGroups) === JSON.stringify(['我的头像','外观','数据','角色卡 实验','酒馆正则 实验','酒馆聊天记录']),
  JSON.stringify(mineGroups));
t('「我的设置」页里没有接口那些全局项', mineGroups.indexOf('记忆管理') < 0 && !(await page.$('#view-mine #api-fold')));
t('「接口」收成了折叠头', (await page.$$eval('#view-settings #api-fold', els => els.length)) === 1);
t('「时段划分」收成了折叠头', (await page.$$eval('#view-settings #clock-fold', els => els.length)) === 1);
// ⚠️ 断言反转（v1.21.47）：「他的设定 / 他的居处」已从设置页搬到【角色编辑页】
// （每个角色一份，不再是全局共用）。设置页里不该再看到它们。
t('「我的相关设定」已从设置页撤掉', (await page.$$eval('#view-settings #mine-fold', els => els.length)) === 0);
t('设置页不再有「我的设定」输入框', !(await page.$('#s-profile')));
t('设置页不再有「我居住的环境」输入框', !(await page.$('#s-env')));
t('已移除「全局统一」', !(await page.$('#s-global-override')));
t('已移除「全局默认参数」', !(await page.$('#s-temp')));
t('设置页里有记忆折叠入口', (await page.$$eval('#view-settings #mem-fold', els => els.length)) === 1);
t('API Key 还在', !!(await page.$('#s-apikey')));
// 现在可能停在「全局设置」也可能是「我的设置」（上面切过去看过栏目），
// 所以点当前这一页的返回按钮，别写死 id。
await page.evaluate(() => {
  const v = document.querySelector('.view.active');
  const b = v && v.querySelector('header .icon-btn');
  if (b) b.click();
});
await sleep(300);
  // v1.15.2 起栈多了 drawer 一层，退到设置页的上一层是抽屉，还要再关一次
  await page.evaluate(() => { const b = document.getElementById('btn-drawer-close'); if (b && document.querySelector('#view-drawer.active')) b.click(); });
  await sleep(500);

console.log('');
console.log('=== 2. 造两个角色，验证「覆盖全局」 ===');
await seedChars(page, [{ name:'角色一' }, { name:'角色二' }]);
await page.reload({ waitUntil:'networkidle0' }); await sleep(200);
const charCount = await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const n = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').count(); q.onsuccess = () => r(q.result); });
  db.close(); return n;
});
// v1.21.59 起不再自动补内置角色 —— 清库后进来就是空的，这里就该是 2 个
t('已创建 2 个角色', charCount === 2, '实际 ' + charCount);

console.log('');
console.log('=== 3. 角色编辑页的新栏目 ===');
await page.click('#btn-chars'); await sleep(400);
await page.evaluate(() => document.querySelectorAll('#char-list .char-card button[data-edit]')[0].click());
await sleep(600);
const eGroups = await page.$$eval('#view-edit .group h3', els => els.map(e => e.textContent.trim()));
console.log('   实际栏目: ' + JSON.stringify(eGroups));
t('角色页含「长期记忆」', eGroups.includes('长期记忆'));
t('角色页含「覆盖全局设定」', eGroups.includes('覆盖全局设定'));
t('角色页不再有记忆入口（搬去设置页了）', (await page.$$eval('#view-edit #btn-view-mem', els => els.length)) === 0);

console.log('');
console.log('=== 4. 记忆是原地展开的折叠面板 ===');
await page.click('#btn-edit-back'); await sleep(500);      // edit → chars
await page.click('#btn-chars-back'); await sleep(500);     // chars → chat
await openSettings(page, sleep);       // chat → settings
await page.click('#mem-fold'); await sleep(700);           // 原地展开
t('展开后没跳页，还在设置里', await page.$eval('#view-settings', el => el.classList.contains('active')));
await page.click('#mem-fold'); await sleep(700);
t('再点一次收回去了', !(await page.$eval('#mem-wrap', el => el.classList.contains('open'))));
// 回到角色编辑页，后面几组还要用它
await page.click('#btn-set-back'); await sleep(400);
  // v1.15.2 起栈多了 drawer 一层，退到设置页的上一层是抽屉，还要再关一次
  await page.evaluate(() => { const b = document.getElementById('btn-drawer-close'); if (b && document.querySelector('#view-drawer.active')) b.click(); });
  await sleep(500);
await page.click('#btn-chars'); await sleep(400);
await page.evaluate(() => document.querySelectorAll('#char-list .char-card button[data-edit]')[0].click());
await sleep(600);
t('已回到角色编辑页', await page.$eval('#view-edit', el => el.classList.contains('active')));

console.log('');
console.log('=== 5. 覆盖全局：取消 → 勾退回 ===');
await page.click('#e-override-global');
await page.waitForSelector('#modal:not(.hidden)', { timeout: 3000 }).catch(()=>{});
t('勾选后弹出确认窗口', await page.$eval('#modal', el => !el.classList.contains('hidden')));
await page.click('#modal-cancel'); await sleep(400);
t('点取消 → 勾退回', await page.$eval('#e-override-global', el => el.checked) === false);
t('确认窗口已关闭', await page.$eval('#modal', el => el.classList.contains('hidden')));

console.log('');
console.log('=== 6. 覆盖全局：确认 → 保存 → 广播给所有角色 ===');
await page.$eval('#e-temp', el => { el.value = '1.5'; el.dispatchEvent(new Event('input', { bubbles: true })); });
await page.click('#e-override-global');
await page.waitForSelector('#modal:not(.hidden)', { timeout: 3000 }).catch(()=>{});
await page.click('#modal-ok'); await sleep(300);
t('确认后勾保持勾上', await page.$eval('#e-override-global', el => el.checked) === true);
await page.click('#btn-edit-save'); await sleep(1200);
const temps = await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const cs = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').getAll(); q.onsuccess = () => r(q.result); });
  db.close(); return cs.map(c => c.temperature);
});
console.log('   所有角色温度: ' + JSON.stringify(temps));
t('两个角色都被同步成 1.5', temps.every(v => Math.abs(v - 1.5) < 0.001), JSON.stringify(temps));

console.log('');
console.log('=== 7. 重开编辑页，覆盖勾应重置 ===');
await page.click('#btn-chars'); await sleep(400);
await page.evaluate(() => document.querySelectorAll('#char-list .char-card button[data-edit]')[1].click());
await sleep(600);
t('覆盖勾默认不勾（不会手滑）', await page.$eval('#e-override-global', el => el.checked) === false);

console.log('');
console.log('=== 8. 数据兼容：导入 1.1.2 时期的真实备份 ===');
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil:'networkidle0' });
await sleep(200);
const before = await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const cnt = (s) => new Promise(r => { const q = db.transaction(s).objectStore(s).count(); q.onsuccess = () => r(q.result); });
  const out = { chars: await cnt('characters'), msgs: await cnt('messages'), mems: await cnt('memories') };
  db.close(); return out;
});
console.log('   导入前基线: ' + JSON.stringify(before));
const inp = await page.$('#file-import');
await inp.uploadFile(BACKUP);
// v1.19.11：上传后会弹「选导入模式」。这一步测的是"老备份能不能完整读回来"，
// 所以走「完全还原」（本机在第 8 步开头已经清过库了，清不清空效果一样）。
// 不点弹窗的话导入根本不执行，后面 5 条断言会全挂且挂得像代码坏了。
await pickImportMode(page, 'all', sleep);
// ⚠️ 原来盲等 6000ms，改成轮询"导入真的写完"。
// 血泪：不能只等角色数 —— 导入是分步写入，角色先到、消息/记忆后到。
// 实测只等角色数会在 101ms 就误判完成，那时消息才 865/1709、记忆 0/43（差点假通过）。
// 必须等【角色、消息、记忆三个数都不再变化】。
{
  let _last = null;
  for (let _i = 0; _i < 200; _i++) {
    const n = await page.evaluate(async () => {
      const o = indexedDB.open('ai-companion');
      const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
      const cnt = (s) => new Promise(r => { const q = db.transaction(s).objectStore(s).count(); q.onsuccess = () => r(q.result); });
      const out = { chars: await cnt('characters'), msgs: await cnt('messages'), mems: await cnt('memories') };
      db.close(); return out;
    });
    // 导入是分步写入的：角色先到、消息后到。必须等【三个数都不再变化】才算完，
    // 只看角色数会在 101ms 就误判完成（实测：那时消息才 865/1709、记忆 0/43）。
    if (n.chars - before.chars >= 5 && n.msgs > 0 && n.mems > 0) {
      if (_last && _last.msgs === n.msgs && _last.mems === n.mems) break;
    }
    _last = n;
    await sleep(100);
  }
}
const after = await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const cnt = (s) => new Promise(r => { const q = db.transaction(s).objectStore(s).count(); q.onsuccess = () => r(q.result); });
  const cs = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').getAll(); q.onsuccess = () => r(q.result); });
  const out = { chars: await cnt('characters'), msgs: await cnt('messages'), mems: await cnt('memories'),
                names: cs.map(c => c.name) };
  db.close(); return out;
});
console.log('   导入后: 角色=' + after.chars + ' 消息=' + after.msgs + ' 记忆=' + after.mems);
console.log('   角色名: ' + JSON.stringify(after.names));
// ⚠️ 不能用 after-before：导入走的是「完全还原」，会先清空，
//    而 before 是在页面 reload 之前读的 —— app 自动建的「空白角色」还没落库（实测读到 1）。
//    清空之后本机剩几个已经无关，直接看【导入后正好是备份里的 5 个】才准确。
t('5 个角色全部导入', after.chars === 5 && !after.names.includes('空白角色'),
  '角色数=' + after.chars + ' 名单=' + JSON.stringify(after.names));
t('1709 条消息全部导入', after.msgs - before.msgs === 1709, '+' + (after.msgs - before.msgs));
t('43 条记忆全部导入', after.mems - before.mems === 43, '+' + (after.mems - before.mems));

const yy = await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const cs = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').getAll(); q.onsuccess = () => r(q.result); });
  db.close(); return cs.find(c => c.name === '幽幽子') || null;
});
t('幽幽子的参数完整保留（温度 1.1）', yy && Math.abs(yy.temperature - 1.1) < 0.001, yy ? String(yy.temperature) : 'not found');
t('幽幽子的人设没丢', !!yy && (yy.persona || '').length > 1000, yy ? String((yy.persona||'').length) + ' 字符' : '');

console.log('');
t('全程无 JS 错误', errs.length === 0, errs.slice(0,3).join(' | '));
console.log('');
console.log('========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close();
server.close();
process.exit(fail>0?1:0);
