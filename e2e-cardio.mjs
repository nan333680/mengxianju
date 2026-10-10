// 角色卡的【端到端】导入（v1.21.53）。
//
// 为什么单开一套：e2e-charcard 测的是纯函数（buildCardV2 / readMkParams 的往返），
// 而「点设置页那个入口、选一个 .json 文件、角色真的被建出来」这条路以前【一套都没覆盖】——
// 用户报「导入导出要全同步」时，出问题的恰恰可能是中间这段接线。
//
// 导出那一侧不在这里测：它要经 Filesystem / Share 插件，headless 里落不了地；
// 打包逻辑本身由 e2e-charcard 的纯函数断言盯着。
import puppeteer from 'puppeteer-core';
import http from 'http'; import fs from 'fs'; import path from 'path';
const R = path.resolve(import.meta.dirname).split(path.sep).join('/');
const WWW = `${R}/www`;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const FIX = `${R}/_fixtures`;
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8' };
fs.mkdirSync(FIX, { recursive: true });
const AVATAR = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const fixture = path.join(FIX, 'card-full.json');
fs.writeFileSync(fixture, JSON.stringify({
  spec: 'chara_card_v2', spec_version: '2.0',
  data: {
    name: '测试卡角色', description: '你是测试卡里的人物。', first_mes: '（卡里的开场白）',
    extensions: { mengxianju: { spec: 1,
      params: { temperature: 0.7, contextRounds: 33, verbosity: 'long', descLevel: 'high',
        detailDrive: 'max', povStyle: 'L3', appearance: '基线：白裙', appearanceLive: '此刻：红裙',
        scene: '祭典', splitMessages: true, longMemory: true },
      avatar: AVATAR } },
    character_book: { name: '她的世界书', entries: [
      { keys: ['红魔馆'], content: '红魔馆是宅邸。', enabled: true,
        extensions: { mengxianju: { title: '红魔馆', pos: 'front' } } },
      { keys: [], content: '世界永远黄昏。', enabled: true,
        extensions: { mengxianju: { title: '世界观', pos: 'always' } } },
    ] },
  },
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
let pass=0, fail=0;
const t=(n,ok,ex='')=>{if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));}};

const openSettings = async () => {
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

await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
await sleep(1500);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil:'networkidle0' }); await sleep(1200);

console.log('=== 从设置页导入一张带全套设置的卡 ===');
await openSettings();
const input = await page.$('#cc-import-file');
t('角色卡导入入口存在', !!input);
await input.uploadFile(fixture);
await sleep(1200);
const diag = await page.evaluate(() => {
  const inp = document.getElementById('cc-import-file');
  const el = document.getElementById('toast');
  return {
    files: inp ? inp.files.length : -1,
    hasHandler: !!(inp && inp.onchange),
    toast: (el && !el.classList.contains('hidden')) ? el.textContent : '(无)',
    view: (document.querySelector('.view.active') || {}).id,
  };
});
console.log('   诊断: ' + JSON.stringify(diag));
await sleep(1500);

const c = await page.evaluate(async () => {
  const { chars } = await import('./js/db.js');
  const all = await chars.all();
  return all.find(x => x.name === '测试卡角色') || null;
});
t('角色被建出来了', !!c, c ? c.name : '没找到');
t('人设与开场白对上', !!c && c.persona.includes('测试卡里的人物') && c.greeting.includes('卡里的开场白'));
t('温度 / 上下文轮数 同步', !!c && c.temperature === 0.7 && c.contextRounds === 33);
t('表达方式 / 描写档 同步', !!c && c.verbosity === 'long' && c.descLevel === 'high' && c.detailDrive === 'max');
t('叙事视角 L3 同步（v1.21.52 之前会丢）', !!c && c.povStyle === 'L3');
t('外貌基线同步', !!c && c.appearance === '基线：白裙');
t('「立即生效」那一层同步（v1.21.53 新增）', !!c && c.appearanceLive === '此刻：红裙');
t('临时场景同步（v1.21.53 新增）', !!c && c.scene === '祭典');
t('布尔设置同步', !!c && c.splitMessages === true && c.longMemory === true);
t('头像从卡里还原（JSON 卡没有别的图源）', !!c && typeof c.avatar === 'string' && c.avatar.startsWith('data:image/png;base64,'));
// 「我的设定」是用户明确豁免的那一类：卡里不带，导入时用【本机全局那份】——
// 和「新建角色」完全一致（app.js 里那句 typeof S.myProfile === 'string' ? S.myProfile : ''）。
const gp = await page.evaluate(async () => {
  const { kv } = await import('./js/db.js');
  const st = await kv.get('settings', {});
  return { p: typeof st.myProfile === 'string' ? st.myProfile : '', e: typeof st.myEnv === 'string' ? st.myEnv : '' };
});
t('私人那两项用的是本机那份（卡里没带、也没被顶掉）', !!c && c.myProfile === gp.p && c.myEnv === gp.e,
  JSON.stringify({ mine: c && c.myProfile.slice(0, 12), global: gp.p.slice(0, 12) }));

const entries = await page.evaluate(async () => {
  const { wb, kv } = await import('./js/db.js');
  const cid = await kv.get('lastCharId', null);
  const all = await wb.soloAll();
  const mine = all.find(s => (s.entries || []).some(e => e.content === '世界永远黄昏。'));
  return mine ? mine.entries.map(e => ({ t: e.title, p: e.pos, k: (e.keys || []).length, c: e.content })) : [];
});
t('世界书两条都进来了', entries.length === 2, JSON.stringify(entries));
t('常驻那条（没触发词）也进来了', entries.some(e => e.p === 'always' && e.k === 0), JSON.stringify(entries));
t('标题跟着进来了', entries.some(e => e.t === '世界观'), JSON.stringify(entries.map(e => e.t)));

console.log('');
console.log('JS 错误: ' + (errs.length ? errs.join(' | ') : '无'));
t('无 JS 报错', errs.length === 0, errs.join(' | '));
console.log('');
console.log('通过 ' + pass + ' / 失败 ' + fail);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);