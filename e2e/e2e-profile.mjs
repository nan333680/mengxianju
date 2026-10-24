// 「他的设定 / 他的居处」—— v1.21.47 从 ⚙ 设置搬到了角色编辑页。
// 这一套原来是测设置页那块面板的，现在整套跟着搬：先在设置页确认【旧位置已经撤掉】，
// 再进角色编辑页做剩下的断言。
import puppeteer from 'puppeteer-core';
import { seedChar } from './e2e-helper.mjs';
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
page.on('dialog', async d => { await d.accept(); });
const sleep = ms => new Promise(r=>setTimeout(r,ms));

const toChat = async () => {
  for (let i = 0; i < 6; i++) {
    const cur = await page.evaluate(() => (document.querySelector('.view.active') || {}).id);
    if (cur === 'view-chat') return;
    await page.evaluate(() => {
      const b = document.getElementById('btn-edit-back')
             || document.getElementById('btn-chars-back')
             || document.getElementById('btn-set-back')
             || document.getElementById('btn-drawer-close')
             || document.getElementById('btn-wb-back');
      if (b) b.click();
    });
    await sleep(450);
  }
};
// v1.15.2 起右上角 ⚙ 拉开【抽屉】，设置页要从抽屉里的「全部设置」进。
const openSettings = async () => {
  await toChat();
  await page.evaluate(() => document.getElementById('btn-settings').click());
  await sleep(800);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('#drawer-menu [data-wb-drawer]')].find(x => x.dataset.wbDrawer === 'settings');
    if (b) b.click();
  });
  await sleep(900);
};
/** 进当前角色的编辑页：点聊天页顶部标题（tap-edit） */
const openEdit = async () => { await toChat(); await page.evaluate(() => document.getElementById('chat-titletxt').click()); await sleep(800); };
const readChar = (id) => page.evaluate(async (cid) => {
  const { chars } = await import('/js/db.js');
  const all = await chars.all();
  const c = cid ? await chars.get(cid) : all[0];
  return c || null;
}, id);

let pass=0, fail=0;
const t=(n,ok,ex='')=>{if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));}};
const jsClick = (s) => page.evaluate(x => document.querySelector(x).click(), s);

await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
await sleep(1500);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil:'networkidle0' }); await sleep(1200);
// v1.21.59：全新安装不再自动建角色（产品改空），测试自己塞一个
await seedChar(page, '测试角色', { greeting: '' });   // 空开场白：不额外多出一条消息
await page.reload({waitUntil:'networkidle0'}); await sleep(500);

console.log('=== 1. ⚙ 设置页里旧的那块已经撤掉 ===');
await openSettings();
t('没有「我的相关设定」大折叠头', !(await page.$('#mine-fold')));
t('没有「她该怎么理解你」输入框', !(await page.$('#s-profile')));
t('没有「我居住的环境」输入框', !(await page.$('#s-env')));
t('没有旧的保存按钮', !(await page.$('#btn-profile-save')));

console.log('');
console.log('=== 2. 角色编辑页里有了 ===');
await openEdit();
t('在角色编辑页', (await page.$eval('#view-edit', el => el.classList.contains('active'))));
t('有「他的设定」折叠头', !!(await page.$('#e-mine-fold')));
t('有「他的居处」折叠头', !!(await page.$('#e-home-fold')));

console.log('');
console.log('=== 3. 默认内容 / 摘要 / 字数 ===');
const pre = await page.$eval('#e-mine', el => el.value);
t('默认已预填内容', pre.length > 100, '长度=' + pre.length);
// v1.21.51：出厂默认从「私人自述」换成通用模板，关键词跟着换
  t('默认是通用模板（上班族）', /上班族|工作日|通勤/.test(pre), pre.slice(0, 40));
const brief0 = await page.$eval('#e-mine-brief', el => el.textContent);
console.log('   摘要: ' + brief0);
t('摘要显示行数', /\d+\s*行/.test(brief0), brief0);
await jsClick('#e-mine-fold'); await sleep(500);
const cnt = await page.$eval('#e-mine-count', el => el.textContent);
console.log('   字数: ' + cnt);
t('显示字数', /\d+\s*字/.test(cnt), cnt);

console.log('');
console.log('=== 4. 改内容 → 点 ✓ → 写进角色自己的字段 ===');
await page.evaluate(() => {
  const a = document.getElementById('e-mine');
  a.value = '【称呼】叫我阿澈就好。\n【雷区】别提工作。';
  a.dispatchEvent(new Event('input', { bubbles: true }));
});
await sleep(400);
const cnt2 = await page.$eval('#e-mine-count', el => el.textContent);
console.log('   实时字数: ' + cnt2);
t('边打字边更新字数', /共\s*2[0-9]\s*字/.test(cnt2), cnt2);
await jsClick('#btn-edit-save'); await sleep(1200);
const mineId = await page.evaluate(async () => {
  const { kv } = await import('/js/db.js');
  return await kv.get('lastCharId', null);
});
const c1 = await readChar(mineId);
t('写进了角色的 myProfile（不再是全局那份）', c1 && c1.myProfile === '【称呼】叫我阿澈就好。\n【雷区】别提工作。', JSON.stringify(c1 && c1.myProfile));

console.log('');
console.log('=== 5. 保存后立刻生效（这一轮 prompt 里就带上）===');
const inPrompt = await page.evaluate(async () => {
  const { buildStablePrompt } = await import('/js/persona.js');
  return buildStablePrompt({ persona: '你是灵梦。', myProfile: '【称呼】叫我阿澈就好。' }, {});
});
t('prompt 含「关于对方」段', inPrompt.includes('# 关于对方'), inPrompt.slice(0,120));
t('prompt 含我的内容', inPrompt.includes('叫我阿澈就好'));

console.log('');
console.log('=== 6. 「关于对方」排在角色设定之后 ===');
const iChar = inPrompt.indexOf('# 你的角色设定');
const iMe = inPrompt.indexOf('# 关于对方');
t('角色设定在前', iChar >= 0 && iMe > iChar, iChar + ' vs ' + iMe);

console.log('');
console.log('=== 7. 清空也可以（不发这一段）===');
const empty = await page.evaluate(async () => {
  const { buildStablePrompt } = await import('/js/persona.js');
  return buildStablePrompt({ persona: '你是灵梦。', myProfile: '' }, { myProfile: '全局那份' });
});
t('空的时候没有这一段（明确留空 = 不要，不是回落全局）', !empty.includes('# 关于对方'));

console.log('');
console.log('=== 8. 「填回默认」只填框、不直接保存 ===');
await openEdit();
await page.evaluate(() => { const a=document.getElementById('e-mine'); a.value='乱写的'; a.dispatchEvent(new Event('input',{bubbles:true})); });
await sleep(300);
await jsClick('#btn-e-mine-reset'); await sleep(700); await jsClick('#modal-ok'); await sleep(700);
const boxVal = await page.$eval('#e-mine', el => el.value);
t('框里变回默认内容', boxVal.length > 100);
const stillSaved = await readChar(mineId);
t('还没保存，库里仍是刚才那份', stillSaved.myProfile === '【称呼】叫我阿澈就好。\n【雷区】别提工作。', JSON.stringify(stillSaved.myProfile));
await jsClick('#btn-edit-save'); await sleep(1200);
const nowSaved = await readChar(mineId);
t('点 ✓ 之后才真的换掉', nowSaved.myProfile.length > 100 && nowSaved.myProfile !== stillSaved.myProfile);

console.log('');
console.log('=== 9. 非对话描写程度条：新建角色的路径 ===');
// ⚠️ 必须走【新建】这条路（点预设进来，c 为 null）：
//    启动时自动建的那个角色身上已经被 pickCharParams 复制了 descLevel，
//    显示的是具体档位而不是「跟随全局」—— 那是另一条路径，别混着测。
await toChat();
await jsClick('#btn-chars'); await sleep(700);
await jsClick('#btn-new-char2'); await sleep(900);
await page.evaluate(() => { const b = document.querySelector('#preset-list button, #preset-list .char-item, #preset-list [data-key]'); if (b) b.click(); });
await sleep(1400);
t('进到编辑页', (await page.$eval('#view-edit', el => el.classList.contains('active'))));
t('有描写程度条', (await page.$$eval('#e-desc button', els => els.length)) > 0);
const segs = await page.$$eval('#e-desc .seg-item, #e-desc button, #e-desc .seg-btn', els => els.map(e => e.textContent.trim()));
console.log('   档位: ' + JSON.stringify(segs));
// ⚠️ 断言更新（v1.21.36）：descLevel 加了「跟随全局」档 → 5 个档位（复审 #3 三态）。
t('有五个档位（含跟随全局）', segs.length === 5, JSON.stringify(segs));
const defSel = await page.$eval('#e-desc', el => el.dataset.v);
// ⚠️ 断言更新（v1.21.36）：角色没设过 descLevel 时默认显示「跟随全局」。
t('默认是跟随全局', defSel === 'global', String(defSel));

console.log('');
console.log('=== 10. 两个上限是分开的：短话 + 足描写 ===');
const both = await page.evaluate(async () => {
  const { buildStablePrompt } = await import('/js/persona.js');
  return buildStablePrompt({ persona: '你是灵梦。' },
    { myProfile:'', verbosity:'short', descLevel:'high', splitMessages:false });
});
t('话限制在 40 字左右', /40 字左右/.test(both), '');
// ⚠️ 断言更新（v0.5.3.4）：descLevel 冻结，high 不再注入「具体的动作细节」那套档位文案，
//    改成三通道写法（括号=外面 / 一对星号=里面 / 括号外=台词）。
t('描写走三通道，不再由档位决定', /一对 \*/.test(both) && !/具体的动作细节/.test(both));
const off = await page.evaluate(async () => {
  const { buildStablePrompt } = await import('/js/persona.js');
  return buildStablePrompt({ persona: '你是灵梦。' }, { myProfile:'', verbosity:'medium', descLevel:'off', splitMessages:false });
});
t('off 时不写括号', /不要写括号/.test(off));
t('off 时没有「括号里写动作」那句', !/写法：括号里写动作/.test(off));

console.log('');
console.log('=== 11. 页面没有报错 ===');
t('无 pageerror', errs.length === 0, errs.join(' | '));

console.log('');
console.log('通过 ' + pass + ' / 失败 ' + fail);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
