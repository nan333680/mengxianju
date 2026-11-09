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
// mock：整理时返回合并后的 2 条（模拟"认真合并+压缩"）
let mode = 'merge';
await page.setRequestInterception(true);
page.on('request', req => {
  const u = req.url();
  if (u.includes('/chat/completions')) {
    if (req.method()==='OPTIONS'){ req.respond({status:204,headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'*'}}); return; }
    const body = JSON.parse(req.postData()||'{}');
    if (body.stream) { req.respond({status:200,headers:{'Access-Control-Allow-Origin':'*'},contentType:'text/event-stream',body:'data: ' + JSON.stringify({choices:[{delta:{content:'好'}}]}) + String.fromCharCode(10,10) + 'data: [DONE]' + String.fromCharCode(10,10)}); return; }
    const sys = (body.messages||[]).map(m=>m.content).join('\n');
    let out = '[]';
    if (sys.includes('JSON 数组') && sys.includes('整理')) {
      if (mode === 'merge') {
        // ⚠️ 审计 F25 之后，整理的下限是「至少留住一半」——6 条记忆回 2 条（33%）
        //    会被判成抽风拦下，所以这条路径改成回 3 条（正好一半）。
        out = JSON.stringify([{text:'你有喝咖啡的习惯，最近改喝拿铁，每天两杯不加糖',kind:'fact',untilDay:null,freq:'often'},
                              {text:'你怕冷，过冬靠暖气',kind:'fact',untilDay:null,freq:'normal'},
                              {text:'你冬天常待在有暖气的地方',kind:'fact',untilDay:null,freq:'normal'}]);
      } else if (mode === 'few') {
        // 刻意只合出一半以下（6 → 2）：专门喂给下面的抽风保护断言
        out = JSON.stringify([{text:'你有喝咖啡的习惯，最近改喝拿铁',kind:'fact',untilDay:null,freq:'often'},
                              {text:'你怕冷，过冬靠暖气',kind:'fact',untilDay:null,freq:'normal'}]);
      } else if (mode === 'flip') {
        // 4 条里只有第 1 条翻转（1/4 = 25%，低于总量闸的 1/3，所以会真写回）。
        out = JSON.stringify([{text:'你住这屋子，那扇门是你的',kind:'fact',untilDay:null,freq:'normal'},
                              {text:'我认识你，你不记得',kind:'fact',untilDay:null,freq:'normal'},
                              {text:'你怕冷，冬天要开暖气',kind:'fact',untilDay:null,freq:'normal'},
                              {text:'你家在八楼，电梯有两部',kind:'fact',untilDay:null,freq:'normal'}]);
      } else if (mode === 'alldraft') {
        // 4 条【全都】和旧条目对不上（4/4 = 100%，超过总量闸的 1/3）
        // → 应该整批放弃、旧的留着，而不是把正式记忆清空
        // ⚠️ 这 4 条必须【一个「我」「你」都不带】—— 带一个 guessSubject 就判出主人了，
        //    闸根本不会触发。真实场景里这种"完全没有第二人称"的记忆很少，
        //    所以这道闸正常情况下不响，它防的是模型整批胡写。
        out = JSON.stringify([{text:'工具箱在储物间，扳手少了一把',kind:'fact',untilDay:null,freq:'normal'},
                              {text:'早上先喝一杯温水',kind:'fact',untilDay:null,freq:'normal'},
                              {text:'母亲住在别的城市',kind:'fact',untilDay:null,freq:'normal'},
                              {text:'睡觉不打呼',kind:'fact',untilDay:null,freq:'normal'}]);
      } else { out = ''; }  // 空字符串 = 解析失败路径
    }
    req.respond({status:200,headers:{'Access-Control-Allow-Origin':'*'},contentType:'application/json',body:JSON.stringify({choices:[{message:{content:out}}]})});
    return;
  }
  req.continue();
});
const sleep = ms => new Promise(r=>setTimeout(r,ms));
let pass=0, fail=0;
const t=(n,ok,ex='')=>{if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));}};
await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
await sleep(1500);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil:'networkidle0' }); await sleep(400)   // [提速] 原 1800：探针实测 reload 后 app 就绪只要 ~1ms;

const cid = await seedChar(page, '优化测试', { greeting:'（开场）' });
// 塞 6 条啰嗦的记忆（模拟"没整理过"的状态）
await page.evaluate(async (id) => {
  const { mem, kv, uid } = await import('./js/db.js');
  const items = [
    '你喜欢美式咖啡', '你改喝拿铁了', '你喝咖啡不加糖', '你每天要喝两杯咖啡',
    '你很怕冷', '你冬天总要开暖气',
  ];
  for (const s of items) await mem.add({ id: uid(), charId: id, text: s, kind:'fact', untilDay:null, freq:'normal', ts: Date.now() });
  await kv.set('settings', Object.assign({}, await kv.get('settings', {}), {
    apiKey:'sk-test', baseUrl:'http://127.0.0.1:'+location.port+'/v1', memLimit: 30, memSummarizeEvery: 999
  }));
}, cid);
await page.reload({ waitUntil:'networkidle0' }); await sleep(400)   // [提速] 原 2000：探针实测 reload 后 app 就绪只要 ~1ms;
await page.click('#btn-chars'); await sleep(700);
await page.evaluate(() => {
  const c = [...document.querySelectorAll('#char-list .char-card')].find(x => x.textContent.includes('优化测试'));
  if (c) c.click();
});
await sleep(1200);

console.log('=== 0. memPronounFlip 纯函数（v0.5.5.5）===');
const PF = await page.evaluate(async () => {
  const S = await import('./js/memory.js');
  const o = (t) => ({ text: t });
  return {
    hasFn: typeof S.memPronounFlip === 'function',
    gainI: S.memPronounFlip([o('你怕黑，晚上要留一盏灯')], '我怕黑，晚上要留一盏灯'),
    loseI: S.memPronounFlip([o('我早就见过你，你不记得')], '你早就见过他，他不记得'),
    mixedOK: S.memPronounFlip([o('你怕黑'), o('我不怕黑，真到暗处可以找我')], '你怕黑，我不怕，真到暗处可以找我'),
    sameText: S.memPronounFlip([o('我住里面')], '我住里面'),
    unrelated: S.memPronounFlip([o('你老家在成都，喜欢吃辣')], '我住里面'),
    // 【你那一笔】（app.js:9096）：纯讲他的事实，提示词要求补上「我」的立场。
    // 这是照提示词改的，不是反的 —— 1/3 阈值时代会被误判成翻转，所以这里钉死它。
    stance: S.memPronounFlip([o('你怕黑')], '你怕黑。我不怕，真到黑暗里的时候可以找我'),
    // 压缩：同一句话删枝叶、人称没动
    compress: S.memPronounFlip([o('我说我一千年都在等这么一下，日子都一个样，头一回见面就凑得很近')], '我等他等了一千年，头回见面就凑得很近'),
    // subject 兜底（guessSubject）
    gsChar: S.guessSubject('我住里面'),
    gsUser: S.guessSubject('你住八楼'),
    gsMixed: S.guessSubject('你怕黑，我不怕'),
    gsNone: S.guessSubject('工具箱在储物间'),
    gsEmpty: S.guessSubject(''),
    emptyNew: S.memPronounFlip([o('你怕黑')], ''),
    emptyList: S.memPronounFlip([], '我怕黑'),
    nullList: S.memPronounFlip(null, '我怕黑'),
  };
});
t('memory.js 导出了 memPronounFlip', PF.hasFn === true);
t('旧条目全无「我」、新的冒出「我」→ 判翻转', PF.gainI === true, String(PF.gainI));
t('旧条目有「我」、新的没有 → 判翻转', PF.loseI === true, String(PF.loseI));
t('正确合并（旧条目里两种都有）→ 不判翻转', PF.mixedOK === false, String(PF.mixedOK));
t('原文没改动 → 不判翻转', PF.sameText === false, String(PF.sameText));
t('没有相似的旧条目 → 不判翻转', PF.unrelated === false, String(PF.unrelated));
t('★「你怕黑」补上「我不怕」→ 不判翻转（这是「你那一笔」，照提示词改的）', PF.stance === false, String(PF.stance));
t('压缩掉枝叶、人称没动 → 不判翻转', PF.compress === false, String(PF.compress));
t('guessSubject：「我」开头 → char', PF.gsChar === 'char', String(PF.gsChar));
t('guessSubject：「你」开头 → user', PF.gsUser === 'user', String(PF.gsUser));
t('guessSubject：平手算她自己', PF.gsMixed === 'char', String(PF.gsMixed));
t('guessSubject：都没有人称 → 空（交给 draft）', PF.gsNone === '' && PF.gsEmpty === '',
  JSON.stringify({ n: PF.gsNone, e: PF.gsEmpty }));
t('空新文本 / 空列表 / null 都不判、不抛', PF.emptyNew === false && PF.emptyList === false && PF.nullList === false,
  JSON.stringify({ e: PF.emptyNew, l: PF.emptyList, n: PF.nullList }));

console.log('=== 1. 撤销按钮存在 ===');
await page.evaluate(() => document.getElementById('btn-settings').click()); await sleep(800);
await page.evaluate(() => {
  const b = [...document.querySelectorAll('#drawer-menu [data-wb-drawer]')].find(x => x.dataset.wbDrawer === 'settings');
  if (b) b.click();
});
await sleep(900);
await page.evaluate(() => { const f=document.querySelector('#mem-set-fold'); if(f && !f.classList.contains('open')) f.click(); });
await sleep(700);
t('有「撤销上次整理」按钮', !!(await page.$('#btn-mem-undo')));

console.log('=== 2. 没有备份时撤销会给提示，不崩 ===');
await page.evaluate(() => document.getElementById('btn-mem-undo').click());
await sleep(1200);
const noBk = await page.evaluate(() => { const el=document.getElementById('toast'); return el && !el.classList.contains('hidden') ? el.textContent : ''; });
t('提示还没有可撤销的整理', /还没有可撤销/.test(noBk), noBk);
const afterNoBk = await page.evaluate(async (id) => {
  const { mem } = await import('./js/db.js'); return (await mem.list(id)).length;
}, cid);
t('记忆没被动', afterNoBk === 6, 'n='+afterNoBk);

console.log('=== 3. 整理 → 有备份 + 报告 ===');
await page.evaluate(() => document.getElementById('btn-mem-tidy').click());
for (let i=0;i<40;i++){ await sleep(400); const d=await page.$eval('#btn-mem-tidy',e=>e.disabled).catch(()=>false); if(!d) break; }
await sleep(1500);
const st = await page.evaluate(async (id) => {
  const { mem, kv } = await import('./js/db.js');
  const list = await mem.list(id);
  const bk = await kv.get('memTidyBackup:'+id, null);
  const el = document.getElementById('toast');
  return { n: list.length, texts: list.map(m=>m.text),
           bk: bk ? bk.items.length : 0,
           toast: el && !el.classList.contains('hidden') ? el.textContent : '' };
}, cid);
console.log('   整理后: ' + JSON.stringify({n: st.n, bk: st.bk}));
console.log('   toast: ' + st.toast);
t('整理生效（6 → 3 条）', st.n === 3, 'n='+st.n);
t('形成了备份（6 条）', st.bk === 6, 'bk='+st.bk);
t('报告里有条数变化', /6 → 3/.test(st.toast), st.toast);
t('报告里有字数变化', /字数/.test(st.toast), st.toast);

console.log('=== 4. 撤销 → 回到整理前 ===');
await page.evaluate(() => document.getElementById('btn-mem-undo').click());
await sleep(1000);
// 确认框
await page.evaluate(() => document.getElementById('modal-ok').click());
await sleep(2000);
const undone = await page.evaluate(async (id) => {
  const { mem, kv } = await import('./js/db.js');
  const list = await mem.list(id);
  const bk = await kv.get('memTidyBackup:'+id, null);
  return { n: list.length, hasOld: list.some(m=>m.text.includes('美式')), bk };
}, cid);
console.log('   ' + JSON.stringify({n: undone.n, hasOld: undone.hasOld, bkCleared: undone.bk === null}));
t('回到 6 条', undone.n === 6, 'n='+undone.n);
t('原来的记忆内容回来了', undone.hasOld);
t('备份用掉后清掉', undone.bk === null);

console.log('=== 4b. 抽风保护：只合出一半以下 → 拦下、记忆原样不动（审计 F25）===');
mode = 'few';   // 6 条只合出 2 条 = 33%，低于新的「至少留住一半」下限
await page.evaluate(() => document.getElementById('btn-mem-tidy').click());
for (let i=0;i<40;i++){ await sleep(400); const d=await page.$eval('#btn-mem-tidy',e=>e.disabled).catch(()=>false); if(!d) break; }
await sleep(1500);
const few = await page.evaluate(async (id) => {
  const { mem } = await import('./js/db.js');
  const list = await mem.list(id);
  const el = document.getElementById('toast');
  return { n: list.length, hasOld: list.some(m=>m.text.includes('美式')),
           toast: el && !el.classList.contains('hidden') ? el.textContent : '' };
}, cid);
console.log('   ' + JSON.stringify({ n: few.n }));
console.log('   toast: ' + few.toast);
t('只合出一半以下 → 记忆原样保留（6 条）', few.n === 6, 'n='+few.n);
t('原有记忆没有被换掉', few.hasOld);
t('toast 如实说「判定为抽风」', /抽风/.test(few.toast), few.toast);

console.log('=== 5. 模型返回空 → 条数字数都没变时如实说 ===');
await page.evaluate(async (id) => {
  const { mem, kv, uid } = await import('./js/db.js');
  const list = await mem.list(id);
  for (const m of list) await mem.del(m.id);
  for (const s of ['你喜欢美式','你改喝拿铁','你不加糖']) {
    await mem.add({ id: uid(), charId: id, text: s, kind:'fact', untilDay:null, freq:'normal', ts: Date.now() });
  }
}, cid);
mode = 'bad';   // Node 侧变量，不能放进 page.evaluate（那是另一个上下文）
await page.evaluate(() => document.getElementById('btn-mem-tidy').click());
for (let i=0;i<40;i++){ await sleep(400); const d=await page.$eval('#btn-mem-tidy',e=>e.disabled).catch(()=>false); if(!d) break; }
await sleep(1500);
const bad = await page.evaluate(async (id) => {
  const { mem } = await import('./js/db.js');
  const list = await mem.list(id);
  const el = document.getElementById('toast');
  return { n: list.length, toast: el && !el.classList.contains('hidden') ? el.textContent : '' };
}, cid);
console.log('   n=' + bad.n + ' | toast=' + bad.toast);
t('模型没返回有效结果时，记忆保持原样（3 条）', bad.n === 3, 'n='+bad.n);

console.log('=== 6. 整理把人称改反 / 对不上旧条目 → 落收件箱（v0.5.5.5）===');
// 为什么这一节只管整理：另外两条路（滚动总结 / 归档总结）反了只多一条错的；
// 整理反了是把本来对的那条也改坏 —— 而且新的直接以 active 落库、下一轮就注入。
await page.evaluate(async (id) => {
  const { mem, uid } = await import('./js/db.js');
  const list = await mem.list(id);
  for (const m of list) await mem.del(m.id);
  for (const s of ['我住这屋子，那扇门是我的','我认识你，你不记得','你怕冷，冬天要开暖气','你家在八楼，电梯有两部']) {
    await mem.add({ id: uid(), charId: id, text: s, kind:'fact', untilDay:null, freq:'normal', ts: Date.now(), subject: s.indexOf('我') === 0 ? 'char' : 'user' });
  }
}, cid);
mode = 'flip';
await page.evaluate(() => document.getElementById('btn-mem-tidy').click());
for (let i=0;i<40;i++){ await sleep(400); const d=await page.$eval('#btn-mem-tidy',e=>e.disabled).catch(()=>false); if(!d) break; }
await sleep(1500);
const flip = await page.evaluate(async (id) => {
  const { mem } = await import('./js/db.js');
  const list = await mem.list(id);
  return list.map(m => ({ t: m.text, s: m.status, why: m.memReviewWhy || '' }));
}, cid);
console.log('   ' + JSON.stringify(flip));
const flipped = flip.find(m => m.t.indexOf('你住这屋子') >= 0);
const kept = flip.find(m => m.t.indexOf('我认识你') >= 0);
t('整理出来的条目落库了（4 条）', flip.length === 4, 'n='+flip.length);
t('★ 人称被改反的那条 → draft（不进正式记忆）', !!flipped && flipped.s === 'draft', JSON.stringify(flipped));
t('★ 并且写明原因「整理后主客可疑」', !!flipped && flipped.why === '整理后主客可疑', JSON.stringify(flipped));
t('没被改动的条目 → active', !!kept && kept.s === 'active', JSON.stringify(kept));
t('只有 1 条进收件箱（1/4，低于总量闸）', flip.filter(m => m.s === 'draft').length === 1,
  JSON.stringify(flip.map(m => m.s)));

console.log('=== 6b. 整批对不上旧条目 → 整批放弃，旧的原地不动（总量闸）===');
// 为什么必须有这一节：整理的写回是「旧的全删、新的重写」，draft 不注入。
// 没有这道闸的话，判据一失灵，用户点一次整理 = 她的正式记忆整体消失。
// 从「反了但还在库里」变成「对的不见了」—— 比原来的故障更糟。
mode = 'alldraft';
await page.evaluate(() => document.getElementById('btn-mem-tidy').click());
for (let i=0;i<40;i++){ await sleep(400); const d=await page.$eval('#btn-mem-tidy',e=>e.disabled).catch(()=>false); if(!d) break; }
await sleep(1500);
const gate = await page.evaluate(async (id) => {
  const { mem } = await import('./js/db.js');
  const list = await mem.list(id);
  const el = document.getElementById('toast');
  return {
    n: list.length,
    hasOld: list.some(m => String(m.text).indexOf('你住这屋子') >= 0),
    hasNew: list.some(m => String(m.text).indexOf('修水管') >= 0),
    toast: el && !el.classList.contains('hidden') ? el.textContent : ''
  };
}, cid);
console.log('   n=' + gate.n + ' | toast=' + gate.toast);
t('★ 整批放弃：旧的 4 条还在', gate.n === 4 && gate.hasOld, JSON.stringify({n:gate.n, old:gate.hasOld}));
t('★ 新的那批一条都没写进去', gate.hasNew === false, String(gate.hasNew));
t('如实说「整批放弃、原样没动」', /整批放弃/.test(gate.toast), gate.toast);
t('不会误报成「没有需要合并的」', !/没有需要合并/.test(gate.toast), gate.toast);

console.log('=== 7. 记忆写入记录（v0.5.6 审计）===');
// 这一节测的是「下次出事能不能翻到过程」—— 前三次排查拿到的都只有最终状态。
const aud = await page.evaluate(async (id) => {
  const M = await import('./js/memaudit.js');
  const list = await M.auditList(id);
  const empty = M.auditToText(id, [], '');
  return {
    n: list.length,
    from: list.map(b => b.from),
    reason: list.map(b => b.reason),
    items: list.map(b => (b.items || []).length),
    ops: list.map(b => (b.items || []).map(x => x.op).join(',')),
    text: M.auditToText(id, list, '测试角色'),
    empty,
  };
}, cid);
console.log('   ' + JSON.stringify({ n: aud.n, from: aud.from, reason: aud.reason, items: aud.items }));
t('整理跑过之后留下了审计（前面 6/6b 各一批）', aud.n >= 2, 'n=' + aud.n);
t('记了是哪条路（dedupe）', aud.from.indexOf('dedupe') >= 0, JSON.stringify(aud.from));
t('记了来路（manual / auto / makeRoom 之一，不是空）',
  aud.reason.every(r => ['manual', 'auto', 'makeRoom'].indexOf(r) >= 0), JSON.stringify(aud.reason));
t('一批里既有「写」也有「删」', aud.ops.some(o => o.indexOf('add') >= 0 && o.indexOf('del') >= 0), JSON.stringify(aud.ops));
t('整批放弃那批留了 abort 痕迹', aud.ops.some(o => o.indexOf('abort') >= 0), JSON.stringify(aud.ops));
t('导出文本里有人能读的批次头和原文', /■/.test(aud.text) && /原:/.test(aud.text), aud.text.slice(0, 200));
t('没有记录时导出文本是一句人话', /还没有记忆写入记录/.test(aud.empty), aud.empty);

console.log('=== 8. 验收判据：设置页能看见、能导出（不开角色对话）===');
t('设置里有「记忆写入记录」按钮', !!(await page.$('#btn-mem-audit')));
t('设置里有「导出记录」按钮', !!(await page.$('#btn-mem-audit-export')));
t('设置里有「清空记录」按钮（和"清空聊天时跟着清"配套）', !!(await page.$('#btn-mem-audit-clear')));
await page.evaluate(() => document.getElementById('btn-mem-audit').click());
await sleep(700);
const ui = await page.evaluate(() => {
  const box = document.getElementById('modal');
  const txt = document.getElementById('modal-text');
  return {
    open: !box.classList.contains('hidden'),
    title: (document.getElementById('modal-title').textContent || '').trim(),
    hasPre: !!txt.querySelector('.mem-audit-pre'),
    hasBatch: /■/.test(txt.textContent || ''),
    len: (txt.textContent || '').length,
  };
});
console.log('   ' + JSON.stringify(ui));
t('点开弹出记录', ui.open === true, JSON.stringify(ui));
t('标题是「记忆写入记录」', ui.title.indexOf('记忆写入记录') >= 0, ui.title);
t('弹层里摊出了批次（不是空壳）', ui.hasPre && ui.hasBatch && ui.len > 40, JSON.stringify(ui));
await page.evaluate(() => document.getElementById('modal-ok').click());
await sleep(400);
const closed = await page.evaluate(() => document.getElementById('modal').classList.contains('hidden'));
t('点「知道了」能关掉', closed === true, String(closed));

console.log('\nJS 错误: ' + (errs.length ? errs.join(' | ') : '无'));
t('无 JS 报错', errs.length === 0, errs.join(' | '));
console.log('\n结果: pass='+pass+' fail='+fail);
await browser.close(); server.close();
process.exit(fail?1:0);
