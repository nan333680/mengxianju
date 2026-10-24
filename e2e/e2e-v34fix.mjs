import puppeteer from 'puppeteer-core';
import http from 'http'; import fs from 'fs'; import path from 'path';
// 工作目录自适应（原来写死 C:/A-DSH-Tool/ai-companion）
const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');
const WWW = `${R}/www`;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
// ⚠️ v1.21.40：产品默认 apiKey 已改成空串（预置的那把反编译就能拿走，已移除）。
// 本套件要真调模型，Key 只能自己给 —— 环境变量优先，没有就用占位符。
const KEY = process.env.DSH_API_KEY || 'sk-test';
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
let pass=0, fail=0;
const t=(n,ok,ex='')=>{ if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));} };

// ⚠️ 本轮按复审第四节的元观察写测试：
// 涉及「两处是否一致」的，必须比【行为】而非字符串 grep。
// （v32fix 几乎全是 src.includes，恰好测不出新2 那种「A 处认了、B 处没用」的断链。）
let sysAll = '';
await page.setRequestInterception(true);
page.on('request', req => {
  const u = req.url();
  if (u.includes('deepseek') || u.includes('/chat/completions')) {
    if (req.method()==='OPTIONS') { req.respond({status:204,headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'*'}}); return; }
    const b = JSON.parse(req.postData()||'{}');
    sysAll = (b.messages||[]).filter(m=>m.role==='system').map(m=>m.content||'').join('\n');
    if (b.stream) {
      const pl='data: '+JSON.stringify({choices:[{delta:{content:'好。'}}]})+String.fromCharCode(10,10)+'data: [DONE]'+String.fromCharCode(10,10);
      req.respond({status:200,headers:{'Access-Control-Allow-Origin':'*'},contentType:'text/event-stream',body:pl}); return;
    }
    req.respond({status:200,headers:{'Access-Control-Allow-Origin':'*'},contentType:'application/json',body:JSON.stringify({choices:[{message:{content:'[]'}}]})}); return;
  }
  req.continue();
});
const kvGet = (k) => page.evaluate(async (kk) => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => o.onsuccess = () => r(o.result));
  const v = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get(kk); q.onsuccess = () => r(q.result); });
  db.close(); return v ? v.v : null;
}, k);
const charGet = (id) => page.evaluate(async (i) => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => o.onsuccess = () => r(o.result));
  const c = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').get(i); q.onsuccess = () => r(q.result); });
  db.close(); return c || null;
}, id);
const send = async (txt) => {
  await page.evaluate(t => { const i=document.getElementById('input'); i.value=t; i.dispatchEvent(new Event('input',{bubbles:true})); }, txt);
  await page.evaluate(() => document.getElementById('btn-send').click());
  for (let i=0;i<25;i++){ await sleep(400); const b=await page.$eval('#btn-stop',e=>!e.classList.contains('hidden')).catch(()=>false); if(!b) break; }
  await sleep(600);
};

await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
await sleep(1400);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil:'networkidle0' }); await sleep(700);
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
        // ⚠️ followKeysMigrated（v0.3.1）：启动迁移会把角色身上 descLevel/detailDrive 的
        //    历史快照清掉，而本套件要测的恰恰是「角色自己有值」那一档 —— 不立这个标记的话，
        //    造数写完下一次 reload 就被迁移删掉，第 111 行会假失败（实测踩到）。
        const v = Object.assign({}, (g.result && g.result.v) || {}, { apiKey: k, followKeysMigrated: true });
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

console.log('=== 新1「跟随全局」必须真的回得去（行为断言，不比字符串）===');
{
  // 造：角色已有 detailDrive='mid'
  await page.evaluate(async () => {
    const o = indexedDB.open('ai-companion');
    const db = await new Promise(r => o.onsuccess = () => r(o.result));
    const put = (s, r2) => new Promise(r => { const tx = db.transaction(s,'readwrite'); tx.objectStore(s).put(r2); tx.oncomplete = r; });
    await put('characters', { id:'c-a', name:'甲', avatar:null, greeting:'g', persona:'p',
      createdAt:Date.now(), longMemory:false, verbosity:'medium', descLevel:'mid', detailDrive:'mid' });
    db.close();
  });
  await page.reload({ waitUntil:'networkidle0' }); await sleep(1000);
  await page.evaluate(() => {
    const card = [...document.querySelectorAll('#char-list .char-card')].find(x => x.textContent.includes('甲'));
    const b = card && card.querySelector('button[data-edit]'); if (b) b.click();
  });
  await sleep(900);
  const shown0 = await page.$eval('#e-drive-brief', e => e.textContent.trim()).catch(()=>null);
  console.log('   初始显示: ' + JSON.stringify(shown0));
  t('已有值时显示「中」', shown0 === '中', shown0);
  // 选「跟随全局」
  await page.evaluate(() => { const b=document.getElementById('e-drive'); if(b) b.click(); });
  await sleep(500);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('#drive-list button')].find(x => x.textContent.includes('跟随全局'));
    if (b) b.click();
  });
  await sleep(400);
  await page.evaluate(() => { const b=document.getElementById('btn-edit-save'); if(b) b.click(); });
  await sleep(1500);
  const c = await charGet('c-a');
  const has = c && ('detailDrive' in c);
  console.log('   保存后 role.detailDrive: has=' + has + ' val=' + JSON.stringify(c && c.detailDrive));
  t('保存后该键被【删掉】（不是留旧值）', has === false, 'has=' + has + ' val=' + JSON.stringify(c && c.detailDrive));
}

console.log('');
console.log('=== 新2 自己导出的世界书文件必须能导回来（走真实上传）===');
{
  const wbFile = 'C:\\A-DSH-Apk\\_check\\wb-charnames.json';
  fs.writeFileSync(wbFile, JSON.stringify({
    version:1, kind:'worldbook', exportedAt:Date.now(),
    charNames:[{ id:'OLD-1', name:'乙' }],       // ← 只有 charNames，没有 characters
    groups:[{ id:'g1', name:'组X', members:['OLD-1'], entries:[] }],
    solo:[{ id:'s1', charId:'OLD-1', entries:[{ id:'e1', title:'T', keys:['k'], content:'C' }] }]
  }));
  // 本机建一个同名角色「乙」
  await page.evaluate(async () => {
    const o = indexedDB.open('ai-companion');
    const db = await new Promise(r => o.onsuccess = () => r(o.result));
    const put = (s, r2) => new Promise(r => { const tx = db.transaction(s,'readwrite'); tx.objectStore(s).put(r2); tx.oncomplete = r; });
    await put('characters', { id:'LOC-1', name:'乙', avatar:null, greeting:'g', persona:'p',
      createdAt:Date.now(), longMemory:false, verbosity:'medium', descLevel:'mid' });
    db.close();
  });
  await page.reload({ waitUntil:'networkidle0' }); await sleep(1000);
  const inp = await page.$('#wb-import-file');
  if (!inp) { t('找到世界书导入入口', false); }
  else {
    await inp.uploadFile(wbFile);
    await sleep(2500);
    const res = await page.evaluate(async () => {
      const o = indexedDB.open('ai-companion');
      const db = await new Promise(r => o.onsuccess = () => r(o.result));
      const gs = await new Promise(r => { const q = db.transaction('wbGroups').objectStore('wbGroups').getAll(); q.onsuccess = () => r(q.result); });
      const ss = await new Promise(r => { const q = db.transaction('wbSolo').objectStore('wbSolo').getAll(); q.onsuccess = () => r(q.result); });
      db.close();
      return { members: (gs[0] && gs[0].members) || [], soloCharIds: ss.map(x => x.charId) };
    });
    console.log('   ' + JSON.stringify(res));
    t('组成员被认领到本机 id', res.members.includes('LOC-1'), JSON.stringify(res.members));
    t('solo 落在本机 id 上', res.soloCharIds.includes('LOC-1'), JSON.stringify(res.soloCharIds));
    t('没有把旧 id 写进库', !res.soloCharIds.includes('OLD-1') && !res.members.includes('OLD-1'));
  }
}

console.log('');
console.log('=== 新3 同名条目不得互相顶掉（滞回行为）===');
{
  // 两个同名条目，keys 不同
  await page.evaluate(async () => {
    const o = indexedDB.open('ai-companion');
    const db = await new Promise(r => o.onsuccess = () => r(o.result));
    const put = (s, r2) => new Promise(r => { const tx = db.transaction(s,'readwrite'); tx.objectStore(s).put(r2); tx.oncomplete = r; });
    await put('wbSolo', { id:'s-x', charId:'c-a', entries:[
      { id:'ea', title:'同名条目', keys:['苹果'], on:true, content:'甲的设定' },
      { id:'eb', title:'同名条目', keys:['香蕉'], on:true, content:'乙的设定' } ] });
    const cur = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get('settings'); q.onsuccess = () => r(q.result); });
    const S = (cur && cur.v) || {};
    S.worldbookOn = true;
    await put('kv', { k:'settings', v:S });
    db.close();
  });
  await page.reload({ waitUntil:'networkidle0' }); await sleep(1000);
  await page.evaluate(() => {
    const card = [...document.querySelectorAll('#char-list .char-card')].find(x => x.textContent.includes('甲'));
    if (card) card.click();
  });
  await sleep(800);
  const rounds = [];
  // ⚠️ 场景要选对（复审第四节教训）：世界书用【最近 6 条】撞触发词，
  // 所以「苹果」还留在看回窗里时，每轮都会重新命中 —— 那是设计，不是滞回没过期。
  // 必须发足够多轮，让触发词【完全滑出看回窗】再看它是否还在。
  const qs = ['我喜欢苹果', '今天天气不错', '还是聊聊天气', '再说说天气吧', '继续聊天气',
              '嗯这个不错', '随手记一下', '没什么特别的', '就这样吧', '好']  ;
  for (const txt of qs) {
    await send(txt);
    rounds.push({ q: txt, 甲: sysAll.includes('甲的设定'), 乙: sysAll.includes('乙的设定') });
  }
  rounds.forEach(r => console.log('   ' + JSON.stringify(r)));
  t('命中甲的那轮注入了甲', rounds[0].甲 === true, JSON.stringify(rounds[0]));
  const last = rounds[rounds.length - 1];
  t('甲的条目最终会过期（触发词滑出看回窗后）', last.甲 === false, JSON.stringify(last));
  t('从未命中的乙【不得】被注入', !rounds.some(r => r.乙 === true), JSON.stringify(rounds.map(r=>r.乙)));
  t('过期过程是渐进的（不是一直挂着）', rounds.filter(r=>r.甲).length < rounds.length, '注入轮数 ' + rounds.filter(r=>r.甲).length + '/' + rounds.length);
}

console.log('');
console.log('=== 新4 描写档与驱动档各自独立（v0.4.3.3 起不再按字数降档）===');
{
  await page.evaluate(async () => {
    const o = indexedDB.open('ai-companion');
    const db = await new Promise(r => o.onsuccess = () => r(o.result));
    const put = (s, r2) => new Promise(r => { const tx = db.transaction(s,'readwrite'); tx.objectStore(s).put(r2); tx.oncomplete = r; });
    const c = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').get('c-a'); q.onsuccess = () => r(q.result); });
    c.descLevel = 'low'; c.detailDrive = 'mid';
    await put('characters', c);
    db.close();
  });
  await page.reload({ waitUntil:'networkidle0' }); await sleep(1000);
  await page.evaluate(() => {
    const card = [...document.querySelectorAll('#char-list .char-card')].find(x => x.textContent.includes('甲'));
    if (card) card.click();
  });
  await sleep(800);
  await send('测试降级');
  const has8 = sysAll.includes('不超过 20 个字');
  const hasChain = sysAll.includes('动作链');
  const hasDowngrade = sysAll.includes('按最低档执行');
  console.log('   8字上限=' + has8 + ' 动作链=' + hasChain + ' 降级说明=' + hasDowngrade);
  // ⚠️ 断言反转（v0.4.3.3）：用户实测「三个档都拉高、输出却没变长」，
  // 根因是这一层字数预算降档把「中/详」静默降成了「简」，界面还显示原档。
  // 他明确要求不要档位↔固定字数绑定，机制已整体删除，所以这里反过来断言。
  // ⚠️ 断言反转（v0.5.3.4，三通道）：两个档位已冻结，不再进提示词。
  // 原来这条守的是「low 的上限还在、mid 的动作链不被降掉」——
  // 现在两张表整个退出注入（控件隐藏、数据保留），所以反过来断言。
  t('low 档的字数上限不再注入', has8 === false, '还在：不超过 20 个字');
  t('mid 的动作链也不再注入（三通道取代）', hasChain === false, '动作链还在');
  t('不再出现降级说明', hasDowngrade === false);
  t('三通道确实在', sysAll.includes('一对 *'), '');
}

console.log('');
console.log('=== 新5 设置页必须有全局 descLevel 控件（且真的能改）===');
{
  await page.evaluate(() => {
    const nav = [...document.querySelectorAll('[data-view], .tab, nav button')].find(x=>/设置/.test(x.textContent));
    if (nav) nav.click();
  });
  await sleep(600);
  const ok = await page.evaluate(() => {
    const d = document.getElementById('btn-settings'); if (d) d.click();
    return true;
  });
  await sleep(600);
  await page.evaluate(() => { const b = document.querySelector('[data-wb-drawer="settings"]'); if (b) b.click(); });
  await sleep(900);
  const has = await page.$('#s-desc') !== null;
  t('设置页有 s-desc 控件', has);
  if (has) {
    // 真的点它，看是否写进 settings
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('#s-desc button')].find(x => /丰富/.test(x.textContent));
      if (b) b.click();
    });
    await sleep(900);
    const S = await kvGet('settings');
    console.log('   settings.descLevel = ' + JSON.stringify(S && S.descLevel));
    t('点它能真的改全局 descLevel', S && S.descLevel === 'high', JSON.stringify(S && S.descLevel));
  }
}

console.log('');
console.log('  JS 错误: ' + (errs.length ? JSON.stringify(errs.slice(0,3)) : '无'));
t('无 JS 错误', errs.length === 0, errs.join(' | '));

console.log('');
console.log('========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
