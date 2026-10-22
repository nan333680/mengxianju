import puppeteer from 'puppeteer-core';
import http from 'http'; import fs from 'fs'; import path from 'path';
import { seedChar, pinLang } from './e2e-helper.mjs';
const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');
const WWW=`${R}/www`;
const CHROME='C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png'};
const server=http.createServer((req,res)=>{let p=decodeURIComponent(req.url.split('?')[0]);if(p==='/')p='/index.html';const f=path.join(WWW,p);if(!fs.existsSync(f)){res.writeHead(404);res.end('404');return;}res.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream'});res.end(fs.readFileSync(f));});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const port=server.address().port;
const browser=await puppeteer.launch({executablePath:CHROME,headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
const page=await browser.newPage();
// ⚠️ CI 的 runner 是 en-US，而界面语言默认「跟随系统」。钉成中文，否则英文界面下
//    断言中文文案的地方都会红（界面翻译补完之后尤其明显，v0.4.2）。
//    用 defineProperty 而不是改库：不用等 reload、也不动 DOM，跟断言不抢。
//    configurable: true 是为了能和预检工具自己的伪装共存。
await page.evaluateOnNewDocument(() => {
  Object.defineProperty(navigator, 'language', { get: () => 'zh-CN', configurable: true });
  Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh'], configurable: true });
});


await page.setViewport({width:393,height:851,deviceScaleFactor:2,isMobile:true,hasTouch:true});
const errs=[]; page.on('pageerror',e=>errs.push(e.message));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let pass=0,fail=0;
const t=(n,ok,ex='')=>{if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));}};
const drawer = () => page.$$eval('#drawer-menu .drawer-item span', els => els.map(e=>e.textContent.trim()));
const h3s = () => page.$$eval('#view-settings .group h3', els => els.map(e=>e.textContent.trim()));

await page.goto('http://127.0.0.1:'+port+'/',{waitUntil:'networkidle0',timeout:40000});
await sleep(1200);
await page.evaluate(()=>indexedDB.deleteDatabase('ai-companion'));
await page.reload({waitUntil:'networkidle0'}); await sleep(600);
await seedChar(page, '语言测试');
// ⚠️ CI 的 runner 是 en-US，而语言默认「跟随系统」→ 不钉中文的话下面第一批断言必红
await pinLang(page, 'zh');
await page.reload({waitUntil:'networkidle0'}); await sleep(700);

console.log('=== 默认是中文，且和以前逐字相同 ===');
await page.evaluate(() => document.getElementById('btn-settings').click()); await sleep(700);
const dZh = await drawer();
console.log('   抽屉: ' + JSON.stringify(dZh));
// v1.21.61：「全部设置」改名「全局设置」，并拆出「我的设置」
t('抽屉是中文', dZh.includes('世界书') && dZh.includes('全局设置') && dZh.includes('我的设置') && dZh.includes('关于'), JSON.stringify(dZh));
await page.evaluate(() => { const b=[...document.querySelectorAll('#drawer-menu [data-wb-drawer]')].find(x=>x.dataset.wbDrawer==='settings'); if(b)b.click(); });
await sleep(900);
const hZh = await h3s();
console.log('   设置栏目: ' + JSON.stringify(hZh));
// v1.21.61 起设置拆成两页，这里看「全局设置」那一页
// v0.3.1：多了一个「酒馆预设」栏目（预设导入入口）

console.log('');
console.log('=== 切到 English ===');
const hasSel = await page.$('#s-lang');
t('设置里出现了语言选择', !!hasSel);
await page.evaluate(v => { const s = document.getElementById('s-lang'); s.value = v; s.dispatchEvent(new Event('change', { bubbles: true })); }, 'en'); await sleep(700);
const hEn = await h3s();
console.log('   设置栏目: ' + JSON.stringify(hEn));
t('栏目变成英文', hEn.includes('Description & expression') && hEn.includes('Web search'), JSON.stringify(hEn));
const drawerBtn = await page.evaluate(() => { const b=[...document.querySelectorAll('#drawer-menu [data-wb-drawer]')].find(x=>x.dataset.wbDrawer==='settings'); return b ? b.textContent : ''; });
t('抽屉也变英文', drawerBtn.includes('Global settings'), drawerBtn);

console.log('');
console.log('=== 切回中文，要逐字还原 ===');
await page.evaluate(v => { const s = document.getElementById('s-lang'); s.value = v; s.dispatchEvent(new Event('change', { bubbles: true })); }, 'zh'); await sleep(700);
const hBack = await h3s();
t('★ 栏目逐字还原', JSON.stringify(hBack) === JSON.stringify(hZh), JSON.stringify(hBack));
console.log('   还原后: ' + JSON.stringify(hBack));

console.log('');
console.log('=== 角色编辑页 ===');
const editLabels = () => page.$$eval('#view-edit .field > span', els => els.map(e => e.textContent.trim()));
await page.evaluate(() => document.getElementById('btn-edit-back') && document.getElementById('btn-edit-back').click());
await sleep(400);
await page.evaluate(() => { const b = document.getElementById('btn-set-back'); if (b) b.click(); });
await sleep(400);
await page.evaluate(() => { const b = document.getElementById('btn-drawer-close'); if (b && document.querySelector('#view-drawer.active')) b.click(); });
await sleep(500);
await page.evaluate(() => document.getElementById('btn-chars').click()); await sleep(600);
await page.evaluate(() => { const c = document.querySelectorAll('#char-list .char-card')[0]; const b = c && c.querySelector('button[data-edit]'); if (b) b.click(); });
await sleep(800);
const zhEdit = await editLabels();
console.log('   中文: ' + JSON.stringify(zhEdit));
t('编辑页标签是中文（含尚未翻译的那些）', zhEdit.includes('名字') && zhEdit.includes('头像') && zhEdit.some(x => x.includes('温度')), JSON.stringify(zhEdit.slice(0, 4)));
const phZh = await page.$eval('#e-name', el => el.getAttribute('placeholder'));
t('placeholder 是中文', phZh === '给她起个名字', phZh);

await page.evaluate(() => document.getElementById('btn-edit-back').click()); await sleep(500);
await page.evaluate(() => document.getElementById('btn-settings').click()); await sleep(700);
await page.evaluate(() => { const b=[...document.querySelectorAll('#drawer-menu [data-wb-drawer]')].find(x=>x.dataset.wbDrawer==='settings'); if(b)b.click(); });
await sleep(800);
await page.evaluate(v => { const s = document.getElementById('s-lang'); s.value = v; s.dispatchEvent(new Event('change', { bubbles: true })); }, 'en'); await sleep(600);
await page.evaluate(() => { const b = document.getElementById('btn-set-back'); if (b) b.click(); });
await sleep(400);
await page.evaluate(() => { const b = document.getElementById('btn-drawer-close'); if (b && document.querySelector('#view-drawer.active')) b.click(); });
await sleep(500);
await page.evaluate(() => document.getElementById('btn-chars').click()); await sleep(600);
await page.evaluate(() => { const c = document.querySelectorAll('#char-list .char-card')[0]; const b = c && c.querySelector('button[data-edit]'); if (b) b.click(); });
await sleep(800);
const enEdit = await editLabels();
console.log('   英文: ' + JSON.stringify(enEdit));
t('已标记的标签变英文', enEdit.includes('Name') && enEdit.includes('Avatar'), JSON.stringify(enEdit.slice(0, 4)));
// 这条换了个更有价值的判据：切语言不能让标签【变少】——
// 之前 textContent 整块替换会把 <b> 子元素吃掉，表现就是数量对不上。
t('切换语言不会丢标签', enEdit.length === zhEdit.length, zhEdit.length + ' -> ' + enEdit.length);
const phEn = await page.$eval('#e-name', el => el.getAttribute('placeholder'));
t('placeholder 也变英文', phEn === 'Give her a name', phEn);

// 切回中文，逐字还原
await page.evaluate(() => document.getElementById('btn-edit-back').click()); await sleep(500);
await page.evaluate(() => document.getElementById('btn-settings').click()); await sleep(700);
await page.evaluate(() => { const b=[...document.querySelectorAll('#drawer-menu [data-wb-drawer]')].find(x=>x.dataset.wbDrawer==='settings'); if(b)b.click(); });
await sleep(800);
await page.evaluate(v => { const s = document.getElementById('s-lang'); s.value = v; s.dispatchEvent(new Event('change', { bubbles: true })); }, 'zh'); await sleep(600);
await page.evaluate(() => { const b = document.getElementById('btn-set-back'); if (b) b.click(); });
await sleep(400);
await page.evaluate(() => { const b = document.getElementById('btn-drawer-close'); if (b && document.querySelector('#view-drawer.active')) b.click(); });
await sleep(500);
await page.evaluate(() => document.getElementById('btn-chars').click()); await sleep(600);
await page.evaluate(() => { const c = document.querySelectorAll('#char-list .char-card')[0]; const b = c && c.querySelector('button[data-edit]'); if (b) b.click(); });
await sleep(800);
const back = await editLabels();
t('★ 编辑页标签逐字还原', JSON.stringify(back) === JSON.stringify(zhEdit), JSON.stringify(back));
t('★ placeholder 逐字还原', (await page.$eval('#e-name', el => el.getAttribute('placeholder'))) === '给她起个名字');
await page.evaluate(() => document.getElementById('btn-edit-back').click()); await sleep(500);

console.log('');
console.log('=== 重新打开软件，语言要记住 ===');
await page.evaluate(v => { const s = document.getElementById('s-lang'); s.value = v; s.dispatchEvent(new Event('change', { bubbles: true })); }, 'en'); await sleep(600);
await page.reload({waitUntil:'networkidle0'}); await sleep(900);
const hEn2 = await h3s();
t('重启后仍是英文', hEn2.includes('Description & expression'), JSON.stringify(hEn2));
await page.evaluate(v => { const s = document.getElementById('s-lang'); s.value = v; s.dispatchEvent(new Event('change', { bubbles: true })); }, 'zh'); await sleep(600);   // 收尾还原成中文

console.log('');
console.log('=== 跟随系统语言（v1.21.61）===');
// ⚠️ 必须先进一次设置页：语言下拉的选项和 onchange 都是在 bindSettings() 里准备的。
// reload 之后直接 dispatchEvent 会石沉大海（这一条我栽过一次）。
await page.evaluate(() => document.getElementById('btn-settings').click()); await sleep(700);
await page.evaluate(() => { const b = [...document.querySelectorAll('#drawer-menu [data-wb-drawer]')].find(x => x.dataset.wbDrawer === 'mine'); if (b) b.click(); });
await sleep(800);
const langOpts = await page.$$eval('#s-lang option', els => els.map(e => e.value));
t('语言有三个选项（跟随系统/中文/英文）', JSON.stringify(langOpts) === JSON.stringify(['system','zh','en']), JSON.stringify(langOpts));
await page.evaluate(() => { const s = document.getElementById('s-lang'); s.value = 'system'; s.dispatchEvent(new Event('change', { bubbles: true })); });
await sleep(700);
const sys = await page.evaluate(() => navigator.language);
const expect = String(sys).toLowerCase().startsWith('zh') ? 'zh' : 'en';
console.log('   系统语言 = ' + sys + ' → 期望界面语言 = ' + expect);
const hSys = await h3s();
const isZh = hSys.includes('记忆管理');
t('★「跟随系统」按 navigator.language 解析', expect === 'zh' ? isZh : !isZh, JSON.stringify(hSys) + ' sys=' + sys);
// 再明确选回英文，确认覆盖系统
await page.evaluate(() => { const s = document.getElementById('s-lang'); s.value = 'en'; s.dispatchEvent(new Event('change', { bubbles: true })); });
await sleep(600);
t('选具体语言时覆盖系统', (await h3s()).includes('Memory'), JSON.stringify(await h3s()));
await page.evaluate(() => { const s = document.getElementById('s-lang'); s.value = 'zh'; s.dispatchEvent(new Event('change', { bubbles: true })); });
await sleep(600);

console.log('');
console.log('=== 动态文案（长按菜单那种，代码里拼出来的）===');
const dyn = await page.evaluate(async () => {
  const m = await import('/js/i18n.js');
  m.setLang('en');
  const en = { copy: m.tt('复制文字'), rewind: m.tt('从这里重聊'), cancel: m.tt('取消'), unknown: m.tt('没登记过的文案') };
  m.setLang('zh');
  const zh = { copy: m.tt('复制文字'), unknown: m.tt('没登记过的文案') };
  m.setLang('zh');
  return { en, zh };
});
console.log('   ' + JSON.stringify(dyn));
t('英文下菜单项是英文', dyn.en.copy === 'Copy text' && dyn.en.rewind === 'Rewind to here', JSON.stringify(dyn.en));
t('没登记的文案原样返回（不会变空或变 key）', dyn.en.unknown === '没登记过的文案', dyn.en.unknown);
t('★ 中文下原样返回', dyn.zh.copy === '复制文字', dyn.zh.copy);

console.log('');
console.log('=== 属性类文案（placeholder / title，审计 F20）===');
// applyI18n 只扫【文本节点】，title / placeholder 这类属性全靠 tt() 自己走 ——
// 而 JS 运行时光拼出来的元素（参数槽、「说明这张图…」、只读弹层的按钮）拿不到
// index.html 上那 6 个 data-i18n-en-ph 标注，所以这里直接钉死它们的译文。
const attr = await page.evaluate(async () => {
  const m = await import('/js/i18n.js');
  const keys = ['知道了', '去掉这个功能', '要搜什么？例如：今天北京天气', '这一轮想怎么演？例如：用可爱向的写法', '说明这张图…', '上一批图片还在处理，稍等一下'];
  m.setLang('en'); const en = keys.map(k => m.tt(k));
  m.setLang('zh'); const zh = keys.map(k => m.tt(k));
  return { keys, en, zh };
});
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/;
console.log('   ' + JSON.stringify(attr.en));
t('★ 属性类文案英文下不含中文', attr.en.every(s => !CJK.test(s)), JSON.stringify(attr.en));
t('★ 属性类文案中文下逐字还原', JSON.stringify(attr.zh) === JSON.stringify(attr.keys), JSON.stringify(attr.zh));

console.log('');
console.log('=== 全站 title / placeholder 在英文下不留中文 ===');
// v0.5.0.1：applyI18n 的属性分支只认 data-i18n-en-ph / data-i18n-en-title。
// index.html 里静态写的中文 placeholder/title 全都要标；运行时拼出来的走 tt()。
// 命令字面量 /真实文件夹名/ 语言选项的原名是刻意保留的，白名单放行。
const scanAttr = () => page.evaluate(() => {
  const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/;
  const OK = ['/搜', '梦弦居备份', '中文'];
  const out = [];
  for (const e of document.querySelectorAll('[title],[placeholder]')) {
    for (const k of ['title', 'placeholder']) {
      const v = e.getAttribute(k) || '';
      if (!CJK.test(v)) continue;
      if (OK.some(w => v.includes(w))) continue;
      out.push(k + '=' + v);
    }
  }
  return out;
});
await page.evaluate(() => document.getElementById('btn-settings').click()); await sleep(700);
await page.evaluate(() => { const b=[...document.querySelectorAll('#drawer-menu [data-wb-drawer]')].find(x=>x.dataset.wbDrawer==='mine'); if(b)b.click(); }); await sleep(800);
await page.evaluate(v => { const s = document.getElementById('s-lang'); s.value = v; s.dispatchEvent(new Event('change', { bubbles: true })); }, 'en'); await sleep(900);
const attrEn = await scanAttr();
t('★ 我的设置页：title/placeholder 无中文', attrEn.length === 0, attrEn.slice(0, 6).join(' | '));
await page.evaluate(() => { const b=document.getElementById('btn-mine-back'); if(b)b.click(); }); await sleep(400);
await page.evaluate(() => { const b=[...document.querySelectorAll('#drawer-menu [data-wb-drawer]')].find(x=>x.dataset.wbDrawer==='settings'); if(b)b.click(); }); await sleep(900);
const attrEn2 = await scanAttr();
t('★ 全局设置页：title/placeholder 无中文', attrEn2.length === 0, attrEn2.slice(0, 6).join(' | '));
// 角色编辑页也扫一遍（那里有一批「点这里编辑她的设定」）
await page.evaluate(() => { const b=document.getElementById('btn-drawer-close'); if(b) b.click(); }); await sleep(500);
await page.evaluate(() => document.getElementById('btn-chars').click()); await sleep(700);
await page.evaluate(() => { const c=document.querySelectorAll('#char-list .char-card')[0]; const b=c&&c.querySelector('button[data-edit]'); if(b)b.click(); }); await sleep(900);
const attrEn3 = await scanAttr();
t('★ 角色编辑页：title/placeholder 无中文', attrEn3.length === 0, attrEn3.slice(0, 6).join(' | '));
await page.evaluate(() => { const b=document.getElementById('btn-edit-back'); if(b)b.click(); }); await sleep(500);
// ⚠️ 0.6.0 记忆 OS：收件箱 / 事实卡 / 槽位标签 / 旧记忆横幅这一批文案几乎全是
//    innerHTML 拼出来的，i18n-report 扫不到、静态 data-i18n 也标不了 —— 只能在
//    英文界面下把整屏的界面文字抓出来查一遍。这里就是那道闸。
console.log('');
console.log('=== 0.6.0 记忆页（按人看 / 时间线 / 事实卡 / 待确认）英文下不留中文 ===');
await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const ch = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').getAll(); q.onsuccess = () => r(q.result[0]); });
  const put = (st, v) => new Promise(r => { const tx = db.transaction(st, 'readwrite'); tx.objectStore(st).put(v); tx.oncomplete = () => r(); });
  // 角色名也要换成英文：它会被当成用户内容跳过，混在这里会让断言看不出真假
  await put('characters', Object.assign({}, ch, { name: 'Tester' }));
  const base = { charId: ch.id, ts: Date.now(), subject: 'char', scope: 'character',
    sourceKind: 'manual', sourceMsgIds: ['i18n-src'], who: '', quote: '',
    legacy: false, needsSplit: false, pinned: false, day: 3 };
  await put('memories', Object.assign({}, base, { id: 'i18n-a', text: 'mem-one', kind: 'fact', key: 'identity.job', status: 'active' }));
  await put('memories', Object.assign({}, base, { id: 'i18n-b', text: 'mem-two', kind: 'goal', key: 'goal.current', status: 'active' }));
  await put('memories', Object.assign({}, base, { id: 'i18n-c', text: 'mem-three', kind: 'fact', key: 'identity.job', status: 'superseded' }));
  await put('memories', Object.assign({}, base, { id: 'i18n-d', text: 'mem-four', kind: 'fact', key: 'location.home', status: 'draft' }));
  await put('memories', Object.assign({}, base, { id: 'i18n-e', text: 'mem-five', kind: 'belief', key: 'belief.user.x', status: 'active', who: ch.id }));
  await put('memories', Object.assign({}, base, { id: 'i18n-f', text: 'mem-six', kind: 'fact', key: '', status: 'active', legacy: true, needsSplit: true }));
  db.close();
});
await page.evaluate(() => { const b = document.getElementById('btn-settings'); if (b) b.click(); }); await sleep(700);
await page.evaluate(() => { const b = [...document.querySelectorAll('#drawer-menu [data-wb-drawer]')].find(x => x.dataset.wbDrawer === 'settings'); if (b) b.click(); }); await sleep(1000);
await page.evaluate(() => { const g = document.getElementById('mem-fold'); if (g) { const s = g.closest('.group'); if (s && !s.classList.contains('open')) g.click(); } }); await sleep(500);
// 从整屏里挑【界面文字】：跳过正文（.txt / 时间线正文）和角色名（fold-head 的 span），
// 她的台词、用户输入、记忆正文都不该被翻译，混进来只会把真问题淹掉。
const uiCjk = () => page.evaluate(() => {
  const CJK = /[\u3400-\u9fff\uff00-\uffef\u3000-\u303f]/;
  const box = document.getElementById('mem-groups');
  if (!box) return ['(没有 mem-groups)'];
  const out = [];
  for (const el of box.querySelectorAll('*')) {
    for (const n of el.childNodes) {
      if (n.nodeType !== 3) continue;
      const t = n.textContent.replace(/\s+/g, ' ').trim();
      if (!t || !CJK.test(t)) continue;
      if (el.closest('.txt')) continue;
      if (el.classList.contains('tl-b')) continue;
      if (el.matches('.fold-head > span')) continue;
      out.push(t);
    }
  }
  return [...new Set(out)];
});
// ⚠️ 切视图后的文案是 innerHTML 拼出来再插进 DOM 的，英文模式下靠 MutationObserver
//    （i18n.js 里 200ms 防抖）补翻。CI 的 runner 慢，固定 sleep(700) 有时翻不完 ——
//    实测 CI 上「事实卡」那一屏会剩下「有 1 条旧记忆里装着好几件事…」「怎么拆」「6 条」
//    「长期」这几条，本地同代码恒绿。所以这里轮询到「中文消失」为止（最多 6 秒），
//    而不是把断言放宽：真缺翻译条目的话，轮询到超时一样会红。
const waitNoCjk = async (ms = 6000) => {
  const t0 = Date.now();
  let last = [];
  while (Date.now() - t0 < ms) {
    last = await uiCjk();
    if (!last.length) return last;
    await sleep(200);
  }
  return last;
};
for (const [v, label] of [['list', '按人看'], ['time', '时间线'], ['key', '事实卡'], ['inbox', '待确认']]) {
  await page.evaluate(v => { const b = document.getElementById('mem-view-' + v); if (b) b.click(); }, v); await sleep(700);
  const bad = await waitNoCjk();
  t('★ 记忆页「' + label + '」英文下不留中文', bad.length === 0, bad.slice(0, 5).join(' | '));
}
// 各视图都点过一遍之后，确认【真的渲染出东西了】—— 否则上面四条全是空屏假绿。
// 统计要在「按人看」上做：上一步停在「待确认」，那里本来就只有 1 条 draft。
await page.evaluate(() => { const b = document.getElementById('mem-view-list'); if (b) b.click(); }); await sleep(700);
const rows = await page.evaluate(() => document.querySelectorAll('#mem-groups .mem-item').length);
t('记忆页确实渲染出了条目（不是空屏假绿）', rows >= 4, String(rows));
const keyRows = await page.evaluate(() => { const b = document.getElementById('mem-view-key'); if (b) b.click(); return 0; }); await sleep(700);
const kb = await page.evaluate(() => document.querySelectorAll('#mem-groups .mem-keycard').length);
t('事实卡按槽位分出了卡片', kb >= 3, String(kb));

console.log('');
t('全程无 JS 错误', errs.length===0, errs.slice(0,3).join(' | '));
console.log('');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close(); server.close();
process.exit(fail>0?1:0);
