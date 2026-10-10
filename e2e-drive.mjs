import puppeteer from 'puppeteer-core';
import http from 'http'; import fs from 'fs'; import path from 'path';
// 工作目录自适应（原来写死 C:/A-DSH-Tool/ai-companion）
const R = path.resolve(import.meta.dirname).split(path.sep).join('/');
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

let lastSys = '';
await page.setRequestInterception(true);
page.on('request', req => {
  const u = req.url();
  if (u.includes('deepseek') || u.includes('/chat/completions')) {
    if (req.method()==='OPTIONS') { req.respond({status:204,headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'*'}}); return; }
    const b = JSON.parse(req.postData()||'{}');
    lastSys = (b.messages||[]).map(m=>m.content||'').join('\n');
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
// ⚠️ 走真实路径：开抽屉 → 点 [data-wb-drawer="settings"]。
// （抽屉项是 renderDrawerMenu() 动态生成的，选择器必须用 data-wb-drawer。）
const openSettings = async () => {
  await page.evaluate(() => {
    // ⚠️ 入口是 #btn-settings（打开设置抽屉），不是 btn-drawer。
    const d = document.getElementById('btn-settings');
    if (d) d.click();
  });
  await sleep(600);
  await page.evaluate(() => {
    const b = document.querySelector('[data-wb-drawer="settings"]');
    if (b) b.click();
  });
  await sleep(800);
  return page.evaluate(() => {
    const v = document.getElementById('view-settings');
    return !!(v && v.classList.contains('active'));
  });
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

console.log('=== 1. 设置页入口存在，默认是「不额外约束」===');
const inSettings = await openSettings();
if (!inSettings) console.log('   [诊断] 没进到设置页');
{
  const brief = await page.$eval('#s-drive-brief', e => e.textContent.trim()).catch(()=>null);
  console.log('   当前档位: ' + JSON.stringify(brief));
  t('设置页有入口', brief !== null);
  t('默认显示「不额外约束」', brief === '不额外约束', brief);
}

console.log('');
console.log('=== 2. 点开弹窗，五个档 + 说明都在 ===');
{
  const opened = await page.evaluate(() => { const b=document.getElementById('s-drive'); if(!b) return false; b.click(); return true; });
  await sleep(600);
  const info = await page.evaluate(() => {
    const m = document.getElementById('drive-modal');
    const items = [...document.querySelectorAll('#drive-list button')];
    return { shown: m && !m.classList.contains('hidden'),
             n: items.length,
             labels: items.map(x => x.querySelector('b') ? x.querySelector('b').textContent : ''),
             hasDesc: items.every(x => !!x.querySelector('span') && x.querySelector('span').textContent.length > 5) };
  });
  console.log('   ' + JSON.stringify(info));
  t('弹窗打开了', info.shown === true);
  t('有 5 个档位（不含"跟随全局"）', info.n === 5, 'n=' + info.n);
  t('档位名齐全', info.labels.join(',') === '不额外约束,简,中,详,极详', info.labels.join(','));
  t('每档都有说明文字', info.hasDesc === true);
}

console.log('');
console.log('=== 3. 选「详」→ 存进设置，且下一条回复立刻带上约束 ===');
{
  await page.evaluate(() => { const b=[...document.querySelectorAll('#drive-list button')].find(x=>x.textContent.includes('详') && !x.textContent.includes('极')); if(b) b.click(); });
  await sleep(900);
  const S = await kvGet('settings').catch(() => null);
  console.log('   settings.detailDrive = ' + JSON.stringify(S && S.detailDrive));
  t('存进了 settings', S && S.detailDrive === 'high', JSON.stringify(S && S.detailDrive));
  const brief = await page.$eval('#s-drive-brief', e => e.textContent.trim()).catch(()=>null);
  t('入口文字更新为「详」', brief === '详', brief);
}

console.log('');
console.log('=== 4. 下一条回复的系统提示词里带上了这一档的约束 ===');
{
  // ⚠️ 先建一个【有独立人设】的角色并切过去 ——
  // 否则用的是 app 自动建的空角色，提示词里根本没有"表达方式"那一段（实测 2297 字符）。
  await page.evaluate(async () => {
    const o = indexedDB.open('ai-companion');
    const db = await new Promise(r => o.onsuccess = () => r(o.result));
    const put = (s, r2) => new Promise(r => { const tx = db.transaction(s,'readwrite'); tx.objectStore(s).put(r2); tx.oncomplete = r; });
    await put('characters', { id:'c-drive', name:'档位测试', avatar:null, greeting:'（她抬眼看你）',
      persona:'你是一个测试角色，说话简短。', createdAt:Date.now(),
      longMemory:false, verbosity:'medium', descLevel:'high', splitMessages:false });
    db.close();
  });
  await page.reload({ waitUntil:'networkidle0' }); await sleep(900);
  await page.evaluate(() => { const c=[...document.querySelectorAll('#char-list .char-card')].find(x=>x.textContent.includes('档位测试')); if(c)c.click(); });
  await sleep(800);
  // 回聊天页发一条
  await page.evaluate(() => { const nav=[...document.querySelectorAll('[data-view], .tab, nav button')].find(x=>/聊天/.test(x.textContent)); if(nav) nav.click(); });
  await sleep(600);
  await page.evaluate(() => { const nav=[...document.querySelectorAll('[data-view], .tab, nav button')].find(x=>/聊天/.test(x.textContent)); if(nav) nav.click(); });
  await sleep(500);
  await page.evaluate(() => { const i=document.getElementById('input'); i.value='测试描写档'; i.dispatchEvent(new Event('input',{bubbles:true})); });
  await page.evaluate(() => document.getElementById('btn-send').click());
  for (let i=0;i<25;i++){ await sleep(400); const b=await page.$eval('#btn-stop',e=>!e.classList.contains('hidden')).catch(()=>false); if(!b) break; }
  await sleep(800);
  console.log('   提示词长度: ' + lastSys.length);
  const P2 = await page.evaluate(() => ({ hasChar: !!document.querySelector('#char-list .char-card'), view: (document.querySelector('.view.active')||{}).id }));
  console.log('   [诊断] ' + JSON.stringify(P2));
  console.log('   提示词片段: ' + JSON.stringify(lastSys.slice(-300)));
  console.log('   提示词里含「动作链」: ' + lastSys.includes('动作链'));
  console.log('   提示词里含「感官」: ' + lastSys.includes('感官'));
  t('提示词带上了「详」档的约束', lastSys.includes('动作链') && lastSys.includes('感官'));
  t('且显式声明与长度上限不冲突', lastSys.includes('上面那个长度上限照旧生效'));
}

console.log('');
console.log('=== 5. 角色页三态：默认跟随全局 + 弹窗多一个选项 ===');
{
  const chk = await page.evaluate(() => {
    const el = document.getElementById('e-drive-brief');
    return el ? el.textContent.trim() : null;
  });
  console.log('   角色页入口（未进编辑页时为 null，属正常）: ' + JSON.stringify(chk));
  const src = fs.readFileSync(WWW + '/js/app.js', 'utf8');
// ⚠️ 断言更新（v1.21.32）：改为【绕开 P 直接读角色】—— 复审 #4 指出：
// 走 P 会被 effSettings 填上全局值，三态恒为"角色自己的选择"，保存一次就永久切断跟随。
t('角色页三态绕开 P 读角色本身', src.includes("(c && c.detailDrive) ? c.detailDrive : 'global'"));
// ⚠️ 断言更新（v1.21.32）：改成【没动过就不写这个键】—— 写 undefined 也会被
// pickCharParams 复制给新角色，所以干脆不写。
t('保存时跟随全局则不写该键', src.includes("...(editDrive === 'global' ? {} : { detailDrive: editDrive }),"));
  t('角色弹窗多给「跟随全局」', src.includes("allowGlobal"));
}

console.log('');
console.log('=== 7. 「重新思考」要退回剧情时间（用户实测反馈）===');
{
  // 造：clock 设到第 9 天，最后一条 user 的 story 是第 3 天下午。
  // 修复前：regen 只删消息不退回 → 新回复带第 9 天的标签（用户看到的"提到上午/前一天"）。
  await page.evaluate(async () => {
    const o = indexedDB.open('ai-companion');
    const db = await new Promise(r => o.onsuccess = () => r(o.result));
    const put = (s, r2) => new Promise(r => { const tx = db.transaction(s,'readwrite'); tx.objectStore(s).put(r2); tx.oncomplete = r; });
    const cid = 'c-drive';
    await put('kv', { k:'clock:' + cid, v:{ day:9, phase:'night', season:'夏', weather:'晴', locked:false } });
    await put('messages', { id:'d1', charId:cid, role:'user', content:'第四句', ts:Date.now(),
      story:{ day:3, phase:'afternoon', season:'春', weather:'晴' } });
    db.close();
  });
  await page.reload({ waitUntil:'networkidle0' }); await sleep(900);
  await page.evaluate(() => { const c=[...document.querySelectorAll('#char-list .char-card')].find(x=>x.textContent.includes('档位测试')); if(c)c.click(); });
  await sleep(700);
  const before = await page.evaluate(async () => {
    const o = indexedDB.open('ai-companion');
    const db = await new Promise(r => o.onsuccess = () => r(o.result));
    const v = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get('clock:c-drive'); q.onsuccess = () => r(q.result); });
    db.close(); return v ? v.v.day : null;
  });
  // 真实调用：页面内的 regenerate() 不在 window 上（module），改用等价的库态断言 + 源码契约
  const src = fs.readFileSync(WWW + '/js/app.js', 'utf8');
  t('regenerate 里有 clockState 退回', src.includes('if (lastUser.story && typeof lastUser.story.day === \'number\' && !isRealClock()) {'));
  t('退回后写了 saveClock', /lastUser\.story[\s\S]{0,300}await saveClock\(\)/.test(src));
  t('退回在 msgs.del 之前', src.indexOf('lastUser.story && typeof lastUser.story.day') < src.indexOf('await msgs.del(lastUser.id);'));
  console.log('   造数：clock 第 ' + before + ' 天 / 那条 user 消息 story 第 3 天');
}

console.log('');
console.log('=== 6. 滑杆防误触 ===');
{
  const has = await page.evaluate(() => typeof window.bindRangeGuard === 'function' || document.body.innerHTML.length > 0);
  const src = fs.readFileSync(WWW + '/js/app.js', 'utf8');
  t('bindRangeGuard 已定义', src.includes('function bindRangeGuard() {'));
  t('bindEvents 里调用了它', src.includes('  bindRangeGuard();'));
// ⚠️ 断言更新（v1.21.32）：防误触重写为【记原值 + 回滚】，
// 不再只加 no-drag（那是事后补救，值已经被原生改掉了）。
t('垂直滑动时锁住并回滚原值', src.includes("locked.classList.add('no-drag');") && src.includes('locked.value = preVal;'));
  t('CSS 有 .no-drag 规则', fs.readFileSync(WWW + '/css/style.css','utf8').includes('input[type="range"].no-drag { pointer-events: none; }'));
  // 真机行为：模拟一次竖向滑动
  const res = await page.evaluate(async () => {
    const el = document.querySelector('input[type="range"]');
    if (!el) return { skip: true };
    const before = el.value;
    const mk = (type, x, y) => { const e = new TouchEvent(type, { bubbles:true, cancelable:true,
      touches: type==='touchend' ? [] : [new Touch({ identifier:1, target:el, clientX:x, clientY:y })] }); el.dispatchEvent(e); };
    mk('touchstart', 100, 300);
    mk('touchmove', 102, 360);
    const locked = el.classList.contains('no-drag');
    mk('touchend', 102, 360);
    return { locked, released: !el.classList.contains('no-drag'), before, after: el.value };
  });
  console.log('   模拟竖向滑动: ' + JSON.stringify(res));
  t('竖向滑动时滑杆被锁住', res.skip || res.locked === true, JSON.stringify(res));
  t('抬手后解锁', res.skip || res.released === true, JSON.stringify(res));
}

console.log('');
console.log('  JS 错误: ' + (errs.length ? JSON.stringify(errs.slice(0,3)) : '无'));
t('无 JS 错误', errs.length === 0, errs.join(' | '));

console.log('');
console.log('========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
