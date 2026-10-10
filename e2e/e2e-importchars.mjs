import puppeteer from 'puppeteer-core';
import { pickImportMode } from './e2e-helper.mjs';
import http from 'http'; import fs from 'fs'; import path from 'path';
// 工作目录自适应（原来写死 C:/A-DSH-Tool/ai-companion）
const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');
const WWW = `${R}/www`;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const FIX = `${R}/_fixtures`;
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8' };
fs.mkdirSync(FIX, { recursive: true });
// 测试素材放工程内（不读桌面 —— 桌面文件会被用户改动/删除，测试会假失败）
const fixture = path.join(FIX, 'import-chars.json');
fs.writeFileSync(fixture, JSON.stringify({
  version: 1, exportedAt: Date.now(), settings: {},
  characters: [
    { id:'fixtest_kaikei', name:'测试袿姬', greeting:'（测试开场）', persona:'你是测试用的造形神。'.repeat(60),
      createdAt: Date.now(), presetKey:'blank', temperature:1, maxTokens:2048, reasoningEffort:'low',
      contextRounds:20, kaomojiFreq:0.15, kaomojiStyle:'jp-soft', emojiFreq:0.1, verbosity:'medium',
      splitMessages:false, typingDelay:1, hesitation:true, longMemory:true, descLevel:'high',
      showTyping:true, povLock:true, appearance:'', appearanceOn:true, avatar:null },
    { id:'fixtest_koakuma', name:'测试小恶魔', greeting:'（测试开场）', persona:'你是测试用的小恶魔。'.repeat(60),
      createdAt: Date.now(), presetKey:'blank', temperature:1, maxTokens:2048, reasoningEffort:'low',
      contextRounds:20, kaomojiFreq:0.3, kaomojiStyle:'jp-cute', emojiFreq:0.15, verbosity:'medium',
      splitMessages:true, typingDelay:1, hesitation:false, longMemory:true, descLevel:'high',
      showTyping:true, povLock:true, appearance:'', appearanceOn:true, avatar:null },
  ],
  messages: {}, memories: [],
}), 'utf8');

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
const t=(n,ok,ex='')=>{if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));}};
await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
await sleep(1500);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil:'networkidle0' }); await sleep(400)   // [提速] 原 1800：探针实测 reload 后 app 就绪只要 ~1ms，1800 里有 800+ 是白等;

console.log('=== 导入角色文件（不会覆盖已有角色）===');
// 先塞一个"已有角色"
await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => o.onsuccess = () => r(o.result));
  const tx = db.transaction('characters','readwrite');
  tx.objectStore('characters').put({ id:'existing_test', name:'原有角色', greeting:'（原有）', persona:'原有设定', createdAt: Date.now() });
  await new Promise(r => tx.oncomplete = r);
  db.close();
});
await page.reload({ waitUntil:'networkidle0' }); await sleep(400)   // [提速] 原 1800：探针实测 reload 后 app 就绪只要 ~1ms，1800 里有 800+ 是白等;
await openSettings(page, sleep);
const input = await page.$('#file-import');
t('导入入口存在', !!input);
await input.uploadFile(fixture);
// v1.19.11：上传后会弹「选导入模式」，不点它导入不执行。这份 fixture 是纯角色文件 → 「仅角色」。
await pickImportMode(page, 'chars', sleep);
await sleep(2500);
const res = await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => o.onsuccess = () => r(o.result));
  const q = db.transaction('characters').objectStore('characters').getAll();
  const cs = await new Promise(r => q.onsuccess = () => r(q.result));
  db.close();
  return cs.map(c => ({ id:c.id, name:c.name, plen:(c.persona||'').length, glen:(c.greeting||'').length }));
});
const names = res.map(c=>c.name);
t('角色 A 已导入', names.includes('测试袿姬'), JSON.stringify(names));
t('角色 B 已导入', names.includes('测试小恶魔'));
t('原有角色未被覆盖', names.includes('原有角色'));
const a = res.find(c=>c.name==='测试袿姬');
t('persona 完整', a && a.plen > 500, a ? 'len='+a.plen : 'n/a');
t('开场白在', a && a.glen > 0);
t('无 JS 报错', errs.length === 0, errs.join(' | '));
console.log('\n结果: pass='+pass+' fail='+fail);
await browser.close(); server.close();
process.exit(fail?1:0);
