import puppeteer from 'puppeteer-core';
import { pickImportMode, seedChar } from './e2e-helper.mjs';
import http from 'http';
import fs from 'fs';
import path from 'path';
// 工作目录自适应（原来写死 C:/A-DSH-Tool/ai-companion）
const R = path.resolve(import.meta.dirname).split(path.sep).join('/');

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
const errs = [];
page.on('pageerror', e => errs.push(e.message));
page.on('dialog', async d => { await d.accept(); });   // 删角色走原生 confirm
const sleep = ms => new Promise(r=>setTimeout(r,ms));
let pass=0, fail=0;
const t=(n,ok,ex='')=>{ if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));} };
const jsClick = (sel) => page.evaluate(s => document.querySelector(s).click(), sel);

await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
await sleep(1500);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil:'networkidle0' });
// v1.21.59：全新安装不再自动建角色（产品改空），测试自己塞一个
await seedChar(page, '测试角色', { greeting: '' });   // 空开场白：不额外多出一条消息
await page.reload({waitUntil:'networkidle0'}); await sleep(500);
await sleep(400)   // [提速] 原 1800：探针实测 reload 后 app 就绪只要 ~1ms;

const src = fs.readFileSync(WWW + '/js/app.js', 'utf8');

console.log('=== 1. 天气识别不再被单字误判（实测判定）===');
// 把天气规则从源码里抠出来，在页面里跑（detectClock 依赖模块内变量，够不到）
const rulesSrc = src.slice(src.indexOf('const weatherRules'), src.indexOf('let day = clockState.day'));
const cases = await page.evaluate((rulesCode) => {
  const fn = new Function('rules', 'scan', `
    let weather = null;
    for (const [re, w] of rules) if (re.test(scan)) { weather = w; break; }
    return weather;
  `);
  const rules = eval(rulesCode.replace('const weatherRules =', ''));
  const test = [
    ['（我买了双雪地靴）', null],
    ['（今天大雪）', 'snow'],
    ['（雾散了，天晴了）', 'clear'],
    ['（雨停了，放晴）', 'clear'],
    ['（外面下着小雨）', 'rain'],
    ['（今天大雨）', 'storm'],
    ['（风好大）', 'wind'],
    ['（阴天了）', 'overcast'],
    ['（我穿了件羽绒服）', null],
    ['（雨夹雪）', 'sleet']
  ];
  return test.map(([text, expect]) => ({ text, expect, got: fn(rules, text) }));
}, rulesSrc);
for (const c of cases) {
  const ok = c.got === c.expect;
  console.log('  ' + (ok?'OK  ':'FAIL') + ' ' + c.text + ' -> ' + c.got + (ok ? '' : '（期望 ' + c.expect + '）'));
  if (ok) pass++; else fail++;
}

console.log('');
console.log('=== 2. 删角色会清干净所有按角色存的 KV ===');
// v1.20.21：clock:<id>:real 也属于「按角色存」的键，必须一起清。
// 后来又加了 msgSeq / memSumAt / memArchiveAt 三个按角色存的键，现在一共 7 个
// ⚠️ 断言更新（v1.21.32）：键清单已改成【从 BACKUP_KV_PREFIXES 常量派生】，
// 不再是硬编码数组 —— 这正是复审 #11 要求的"根治漂移"。
t('源码里所有按角色存的键都会清', src.includes("...BACKUP_KV_PREFIXES, 'memTidyBackup:']") && src.includes("'memArchiveLastAt:',"),
  (src.match(/for \(const k of \[[^\]]+\]/) || [''])[0]);
// 实测：删一个角色，看这四个键还在不在
await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const cs = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').getAll(); q.onsuccess = () => r(q.result); });
  const cid = cs[0].id;
  const tk = db.transaction('kv','readwrite');
  // v1.20.21 起多了 clock:<id>:real（现实时间模式的存档位）—— 一并造出来，
  // 确保删角色时它也被清掉。
  const stk = tk.objectStore('kv');
  for (const k of ['clock:','greeted:','memDeleted:','memDedupeAt:','msgSeq:','memSumAt:','memArchiveAt:']) stk.put({ k: k + cid, v: 1 });
  stk.put({ k: 'clock:' + cid + ':real', v: 1 });   // v1.20.21 新增的存档位
  await new Promise(r => { tk.oncomplete = r; });
  db.close();
});
await page.reload({ waitUntil:'networkidle0' });
await sleep(400)   // [提速] 原 2000：探针实测 reload 后 app 就绪只要 ~1ms;
const before = await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const all = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').getAll(); q.onsuccess = () => r(q.result); });
  db.close(); return all.map(x => x.k).filter(k => /^(clock|greeted|memDeleted|memDedupeAt|msgSeq|memSumAt|memArchiveAt):/.test(k));
});
console.log('   删前这些键: ' + JSON.stringify(before));
t('八个键都造出来了（含 :real）', before.length === 8, JSON.stringify(before));
// 通过界面删掉这个角色
await page.click('#btn-chars'); await sleep(500);
await page.evaluate(() => document.querySelectorAll('#char-list .char-card button[data-edit]')[0].click());
await sleep(800);
await page.evaluate(() => { document.getElementById('btn-del-char').click(); });
await sleep(1500);
const after = await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const all = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').getAll(); q.onsuccess = () => r(q.result); });
  db.close(); return all.map(x => x.k).filter(k => /^(clock|greeted|memDeleted|memDedupeAt|msgSeq|memSumAt|memArchiveAt):/.test(k));
});
console.log('   删后剩: ' + JSON.stringify(after));
// 删完之后应用会自动补一个内置角色并渲染，渲染时会给"新角色"写 greeted: —— 
// 所以剩下一条是正常的，关键是：被删那个角色的 id 不能再出现在任何键里。
const deletedId = before[0].split(':')[1];
console.log('   被删角色 id: ' + deletedId);
t('被删角色的键全部清干净了', !after.some(k => k.endsWith(':' + deletedId)),
  '被删 id=' + deletedId + ' 剩余=' + JSON.stringify(after));
t('剩下的只能是新角色的键', after.every(k => !k.includes(deletedId)), JSON.stringify(after));

console.log('');
console.log('=== 3. 导入消息缺字符段不再变成「黑洞数据」===');
t('导入会给缺的字段兜底', /rec.charId = cid/.test(src) && /typeof rec.ts !== 'number'/.test(src));
t('导入会跳过非数组的消息组', /if \(!Array\.isArray\(arr\)\) \{ badMsgs\+\+; continue; \}/.test(src));
t('导入结束会提示跳过了多少条', /条记录格式不对，已跳过/.test(src));

console.log('');
console.log('=== 4. 导入会把设置读回来（原来丢了）===');
// ⚠️ v1.19.11 起 settings 的处理挪进了 applyImport()（导入分 5 种模式后，
//    "要不要读 settings" 变成模式相关的了）。断言的本意是"代码真的会读 data.settings"，
//    不是"必须写在 importData 这个函数里" —— 所以匹配整份源码即可，语义不变。
// v1.19.11 起这里多了个模式门禁：只有包含 settings 的模式才会读它。
// 断言本意是"代码真的会读 data.settings"，门禁是新增的正确行为，一起匹配。
t('导入会读 data.settings', /data\.settings && typeof data\.settings === 'object'/.test(src));
// ⚠️ 断言更新（v1.21.45）：原来盯的是 `delete incoming.apiKey` 这一行。
//    而那一行只护住了 apiKey —— 备份里的 searchKey 会照样盖掉本机填的那个。
//    现在两个 Key 收进 SECRET_SETTINGS 一份清单，「导出抹掉 + 导入拒绝覆盖」一起生效。
//    所以断言改成盯【清单机制 + 两个名字都在】，而不是某一行具体的 delete ——
//    下次再有人改这里的写法，只要清单还在就不会无谓地红。
t('本机 Key 永不被备份覆盖（清单机制）',
  /SECRET_SETTINGS = \['apiKey', 'searchKey'\]/.test(src) &&
  // ⚠️ 断言更新（v1.21.52）：导入侧换了清单 —— NO_IMPORT_SETTINGS 在密钥之外
  //    还挡住 baseUrl / provider / model（防"导一份备份就把 Key 送去别人的地址"）。
  /NO_IMPORT_SETTINGS = \[[^\]]*'apiKey'[^\]]*'searchKey'/.test(src) &&
  /for \(const k of NO_IMPORT_SETTINGS\) delete incoming\[k\]/.test(src),
  (src.match(/NO_IMPORT_SETTINGS = \[[^\]]*\]/) || [''])[0]);
t('导出侧也从同一份清单抹 Key', /settings: stripSecrets\(S\)/.test(src));
// 实测：改个设置 → 导出 payload → 清库 → 导入 → 看设置回没回来
const roundTrip = await page.evaluate(async () => {
  const open = () => new Promise(r => { const o = indexedDB.open('ai-companion'); o.onsuccess = () => r(o.result); });
  let db = await open();
  // 改一个全局设置
  const kv = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get('settings'); q.onsuccess = () => r(q.result); });
  const s = { ...(kv ? kv.v : {}), memLimit: 42, fontSize: 19, theme: 'light' };
  const tw = db.transaction('kv','readwrite'); tw.objectStore('kv').put({ k:'settings', v:s });
  await new Promise(r => { tw.oncomplete = r; });
  db.close();
  return s.memLimit;
});
console.log('   先把全局 memLimit 改成 ' + roundTrip + '，fontSize=19，theme=light');
await page.reload({ waitUntil:'networkidle0' });
await sleep(400)   // [提速] 原 2000：探针实测 reload 后 app 就绪只要 ~1ms;
// 用导出逻辑造一份备份（直接调页面的 exportData 会下载文件，这里手工构造同结构）
const mkBackup = await page.evaluate(async () => {
  const open = () => new Promise(r => { const o = indexedDB.open('ai-companion'); o.onsuccess = () => r(o.result); });
  const db = await open();
  const cs = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').getAll(); q.onsuccess = () => r(q.result); });
  const kv = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get('settings'); q.onsuccess = () => r(q.result); });
  db.close();
  return { version:1, characters: cs, messages: {}, memories: [], settings: { ...kv.v, apiKey: '' } };
});
console.log('   备份里的设置: memLimit=' + mkBackup.settings.memLimit + ' theme=' + mkBackup.settings.theme);
// 把设置改回去，再导入备份，看会不会被还原
await page.evaluate(async () => {
  const open = () => new Promise(r => { const o = indexedDB.open('ai-companion'); o.onsuccess = () => r(o.result); });
  const db = await open();
  const kv = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get('settings'); q.onsuccess = () => r(q.result); });
  const s = { ...kv.v, memLimit: 20, fontSize: 15, theme: 'dark' };
  const tw = db.transaction('kv','readwrite'); tw.objectStore('kv').put({ k:'settings', v:s });
  await new Promise(r => { tw.oncomplete = r; });
  db.close();
});
await page.reload({ waitUntil:'networkidle0' });
await sleep(400)   // [提速] 原 1800：探针实测 reload 后 app 就绪只要 ~1ms;
await page.evaluate((payload) => {
  window.__importPayload = JSON.stringify(payload);
  // 伪造一个 File 对象喂给导入
  const f = new File([window.__importPayload], 'backup.json', { type: 'application/json' });
  const inp = document.getElementById('file-import');
  const dt = new DataTransfer(); dt.items.add(f);
  inp.files = dt.files;
  inp.dispatchEvent(new Event('change', { bubbles: true }));
}, mkBackup);
// v1.19.11：会先弹「选导入模式」。这一步测的是「设置能不能被导入还原」，
// 所以必须选一个【包含 settings】的模式 —— 「仅角色」不含 settings，选了就测不到东西。
await pickImportMode(page, 'config', sleep);
await sleep(1500);
const restored = await page.evaluate(async () => {
  const open = () => new Promise(r => { const o = indexedDB.open('ai-companion'); o.onsuccess = () => r(o.result); });
  const db = await open();
  const kv = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get('settings'); q.onsuccess = () => r(q.result); });
  db.close(); return { memLimit: kv.v.memLimit, theme: kv.v.theme, fontSize: kv.v.fontSize };
});
console.log('   导入后: ' + JSON.stringify(restored));
t('导入把 memLimit 还原成 42', restored.memLimit === 42, String(restored.memLimit));
t('导入把 theme 还原成 light', restored.theme === 'light', String(restored.theme));
t('导入把 fontSize 还原成 19', restored.fontSize === 19, String(restored.fontSize));

console.log('');
console.log('=== 5. 记忆模块：重复绑定 / 竞态 / 死代码 ===');
t('e-mem-input 用 onkeydown（不再累加监听）', /\$\('e-mem-input'\)\.onkeydown =/.test(src));
t('不再用 addEventListener 绑它', !/\$\('e-mem-input'\)\.addEventListener/.test(src));
t('renderCharMem 在 await 后校验 id', /if \(id !== editingId\) return;/.test(src));
// 删除/编辑的绑定统一挪到了 bindMemItems(box, charId, after)，
// 调用方传的是 () => renderCharMem(editingId) —— 「用此刻的角色」这个意图没变
t('删按钮用此刻的 editingId', /renderCharMem\(editingId\)/.test(src) && /function bindMemItems/.test(src));
t('不再有 P.id 死代码', !/renderCharMem\(P\.id/.test(src));
t('孤儿组状态会被清', /_memOpen\.delete\('__orphan__'\)/.test(src));

console.log('');
console.log('=== 6. 其余修复 ===');
t('regenerate 有 busy 保护', /async function regenerate\(\) \{[\s\S]{0,400}if \(busy\)/.test(src));
t('retrySend 也挡图片处理中', /if \(_pickingImages\) \{ toast\('图片还在处理，稍等一下再重试'\); return; \}/.test(src));
// v1.21.54 改：原来断言的是"usage = null; 紧挨着 if (bubble)"——中间插任何一行都会假红
// （这次插的是 thinkBuf = ''）。改成断言【行为】：重试分支里 usage 与思考缓冲都要清掉。
// 思考缓冲那条是本次新加的：不清的话，第二次真回空白时兜底会拿上一次已作废请求的思考当素材。
t('自动重试会重置 usage 与思考缓冲', /usage = null;[\s\S]{0,260}thinkBuf = '';/.test(src));
t('保存角色有 try/catch', /try \{ await saveCharEdit\(\); \}/.test(src));

console.log('');
if (errs.length) console.log('  JS 错误: ' + JSON.stringify(errs.slice(0, 3)));
t('全程无 JS 错误', errs.length === 0, errs.slice(0,2).join(' | '));

console.log('');
console.log('========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
