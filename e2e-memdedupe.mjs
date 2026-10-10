import puppeteer from 'puppeteer-core';
import http from 'http'; import fs from 'fs'; import path from 'path';
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
await page.reload({ waitUntil:'networkidle0' }); await sleep(400)   // [提速] 原 1800：探针实测 reload 后 app 就绪只要 ~1ms;

console.log('=== 查重提示词内容 ===');
const src = await page.evaluate(async () => (await fetch('./js/app.js')).text());
t('含「动手整理」（非"看看要不要"）', src.includes('动手整理'));
t('含「原样返回等于这次白做」', src.includes('原样返回等于这次白做'));
t('含第一步：合并同主题（必做）', src.includes('第一步：合并同主题的条目'));
t('含第二步：压成大意（必做）', src.includes('第二步：合并之后再压成大意') || src.includes('第二步：合并之后再压成'));
t('含「合并后条数必须少于原来」', src.includes('必须少于'));
t('含压缩不能砍主干', src.includes('不能把主干砍了'));
t('含保护忌讳/承诺不压', src.includes('不要压，原样保留措辞'));
t('含输出前自检', src.includes('输出前自检'));
t('含三个合并范例', (src.match(/例：/g)||[]).length >= 5);
t('条数改成"参考不是硬指标"', src.includes('这是参考不是硬指标'));

console.log('=== 误导文案已改 ===');
// 注释里会引用旧文案做说明，所以要精确断言「toast(...)」里不再出现它
const toastCalls = src.match(/toast\([^)]*模型认为[^)]*\)/g) || [];
t('toast 里不再有误导文案', toastCalls.length === 0, JSON.stringify(toastCalls));
t('新文案说明"没找到可合并的"', src.includes('多半是这次没找到可合并的条目'));
// 注意：src 是【源码文本】，不是运行时的 toast 文案。
// v1.16.3 起报告改成"条数 + 字数"双变化，检查源码里有没有这两段拼接逻辑。
t('源码里有条数变化报告', src.includes('条（') && src.includes('short('));
t('源码里有字数变化报告', src.includes('，字数 '));

console.log('=== 页面能正常加载 ===');
await openSettings(page, sleep);
t('设置页可打开', await page.$eval('#view-settings', el => el.classList.contains('active')));
await page.evaluate(() => { const f=document.querySelector('#mem-set-fold'); if(f && !f.classList.contains('open')) f.click(); });
await sleep(700);
const vals = await page.evaluate(() => ({
  sum: document.querySelector('#s-mem-sum').value,
  dedupe: document.querySelector('#s-mem-dedupe').value,
}));
t('节奏参数仍是 50/20', vals.sum === '50' && vals.dedupe === '20', JSON.stringify(vals));

console.log('\nJS 错误: ' + (errs.length ? errs.join(' | ') : '无'));
t('无 JS 报错', errs.length === 0, errs.join(' | '));
console.log('\n结果: pass='+pass+' fail='+fail);
await browser.close(); server.close();
process.exit(fail?1:0);