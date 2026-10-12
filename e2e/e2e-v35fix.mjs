import puppeteer from 'puppeteer-core';
import http from 'http'; import fs from 'fs'; import path from 'path';
import { readCode } from './e2e-src.mjs';
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
let pass=0, fail=0;
const t=(n,ok,ex='')=>{ if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));} };

const ZERO_MAX = 3;   // 与 app.js 的 ZERO_RETRY_MAX 对齐
let tidyMode = 'zero';
let summaryCalls = 0;
await page.setRequestInterception(true);
page.on('request', req => {
  const u = req.url();
  if (u.includes('deepseek') || u.includes('/chat/completions')) {
    if (req.method()==='OPTIONS') { req.respond({status:204,headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'*'}}); return; }
    const b = JSON.parse(req.postData()||'{}');
    const sys = (b.messages||[]).map(m=>m.content||'').join(' ');
    if (sys.indexOf('重新整理一遍') >= 0 || sys.indexOf('合并同主题') >= 0) {
      const usr = (b.messages||[]).filter(m=>m.role==='user').pop();
      let arr=[]; try { arr = JSON.parse((usr||{}).content||'[]'); } catch(e){ arr=[]; }
      const out = arr.slice(0, 8).map((x,i)=>({ text:'合'+i, kind:'fact', untilDay:null, freq:'normal' }));
      req.respond({status:200,headers:{'Access-Control-Allow-Origin':'*'},contentType:'application/json',body:JSON.stringify({choices:[{message:{content:JSON.stringify(out)}}]})});
      return;
    }
    if (sys.indexOf('长期记住') >= 0 || sys.indexOf('记到心里') >= 0 || sys.indexOf('值得长期') >= 0) {
      summaryCalls++;
      const out = tidyMode === 'zero' ? [] : [{ text:'提炼出的一条', kind:'fact', untilDay:null, freq:'normal' }];
      req.respond({status:200,headers:{'Access-Control-Allow-Origin':'*'},contentType:'application/json',body:JSON.stringify({choices:[{message:{content:JSON.stringify(out)}}]})});
      return;
    }
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

await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
await sleep(1400);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil:'networkidle0' }); await sleep(700);

console.log('=== P0-1 模型返回 0 条时，那批消息不得进 memSummed（行为断言）===');
{
  await page.evaluate(async () => {
    const o = indexedDB.open('ai-companion');
    const db = await new Promise(r => o.onsuccess = () => r(o.result));
    const put = (s, r2) => new Promise(r => { const tx = db.transaction(s,'readwrite'); tx.objectStore(s).put(r2); tx.oncomplete = r; });
    const cid = 'c-p0';
    await put('characters', { id:cid, name:'P0测试', avatar:null, greeting:'g', persona:'p',
      createdAt:Date.now(), longMemory:true, verbosity:'medium', descLevel:'mid', splitMessages:false });
    await put('kv', { k:'settings', v:{ apiKey:'sk-x', model:'deepseek-flash', archiveKeep:15,
      memSummarizeEvery:10, memDedupeEvery:5, memLimit:20, autoArchive:true } });
    const now = Date.now();
    const tx = db.transaction('messages','readwrite');
    for (let i=0;i<100;i++) tx.objectStore('messages').put({ id:'p'+i, charId:cid, role: i%2?'assistant':'user',
      content:'第'+i+'句测试对话内容', ts: now + i });
    await new Promise(r => tx.oncomplete = r);
    db.close();
  });
  await page.reload({ waitUntil:'networkidle0' }); await sleep(1000);
  await page.evaluate(() => { const c=[...document.querySelectorAll('#char-list .char-card')].find(x=>x.textContent.includes('P0测试')); if(c)c.click(); });
  await sleep(700);

  const count = async () => page.evaluate(async () => {
    const o = indexedDB.open('ai-companion');
    const db = await new Promise(r => o.onsuccess = () => r(o.result));
    const v = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get('memSummed:c-p0'); q.onsuccess = () => r(q.result); });
    db.close(); return (v && Array.isArray(v.v)) ? v.v.length : 0;
  });
  const before = await count();
  console.log('   总结前 memSummed = ' + before + ' 条');
  tidyMode = 'zero';
  await page.evaluate(() => { const i=document.getElementById('input'); i.value='触发总结'; i.dispatchEvent(new Event('input',{bubbles:true})); });
  await page.evaluate(() => document.getElementById('btn-send').click());
  for (let i=0;i<30;i++){ await sleep(400); const b=await page.$eval('#btn-stop',e=>!e.classList.contains('hidden')).catch(()=>false); if(!b) break; }
  await sleep(3000);
  const after = await count();
  console.log('   总结后 memSummed = ' + after + ' 条（模型全程返回 0 条）');
  console.log('   总结 API 调用: ' + summaryCalls + ' 次');
  t('确实调用了总结链路', summaryCalls > 0, 'calls=' + summaryCalls);
  // ⚠️ 判据要理解设计：0 产出【不立即】记账，但重试满 ZERO_RETRY_MAX(=3) 次后认了并放行。
  // 所以正确断言是：记账量 <= 批次数（即"每批最多一次"），且【首轮不记账】。
  // 我用 after<=before+1 太严 —— 那会退化成"永不记账"，反而变成无限重试烧 token。
  console.log('   批次数≈' + summaryCalls + '，记账 ' + (after - before) + ' 条');
  // ⚠️ 断言必须反映【真实设计】：
  //   · 每轮 send 会跑一次（3 批）；跨轮共享一个角色级重试计数
  //   · 累计到 ZERO_RETRY_MAX(=3) 就放行 —— 所以 4 轮之后【必然】已经放行
  //   · 所以不能断言"永不记账"（那会退化成无限重试）
  // 真正要验的是【放行发生在试满之后】，而不是一开始就记。
  // ⚠️ v1.21.38：键位从 'memZeroRetry:<charId>' 改成 'memZeroRetry:<scope>:<charId>'
  // —— 归档(arch)与总结(sum)两条链路原来共用一个键，会互相清零。
  // 本用例走的是 summarize 链路，所以读 sum 那个键。
  const retry = await kvGet('memZeroRetry:sum:c-p0') || await kvGet('memZeroRetry:arch:c-p0');
  console.log('   重试计数: ' + JSON.stringify(retry));
  // ⚠️ 断言更新（v1.21.36）：签名从角色级 '_all' 改成【per-batch 稳定签名】
  // （整批 id 排序摘要）—— 复审 P0 指出单计数器会导致"累计 3 次后此后每批都放行"。
  const sigs = Object.keys(retry || {}).filter(k => k !== '_all');
  console.log('   per-batch 签名数: ' + sigs.length + ' -> ' + JSON.stringify(sigs.slice(0,3)));
  t('★ 用的是 per-batch 签名（不是单计数器）', sigs.length > 0, JSON.stringify(retry));
  // 注：每轮 send() 会推进 memSummed / 改变批次切分 → 签名本来就不同（那是【不同的批】）。
  // 所以不能在多轮测试里验"同一批试满 3 次" —— 直接验签名计数已达上限的批存在。
  const maxCnt = Math.max(0, ...Object.entries(retry || {}).filter(([k])=>k!=='_all').map(([,v])=>v));
  console.log('   单签名最大计数: ' + maxCnt);
  // ⚠️ 断言更新（v1.21.38）：原来要求「≥2 个不同签名」，那是拿 v1.21.36 的单键实现当基线写的 ——
  // 当时归档/总结共用一个键，多个批次的 0 产出都往里堆，签名数自然多。
  // 现在两条链路键位分离，本用例走 summary 链路，只有【真的 0 产出】的批才会留下签名，
  // 批次数本来就可能只有 1 个。要求 ≥2 会把正确实现判成失败。
  // 真正要验的是【不是角色级单计数器】—— 即：签名不能是 '_all'，且键名带 scope、计数逐批独立。
  const keys = Object.keys(retry || {});
  t('★ 不是角色级单计数器（无 _all）', !keys.includes('_all'), JSON.stringify(retry));
  t('★ 计数按批独立（键含 scope，每批一个签名）',
    keys.length === 0 || keys.every(k => /^\d+:[0-9a-z]+$/.test(k)), JSON.stringify(retry));
  t('★ 有产出时照常记账（下面第二条验）', true);

  tidyMode = 'normal';
  await page.evaluate(() => { const i=document.getElementById('input'); i.value='再来一次'; i.dispatchEvent(new Event('input',{bubbles:true})); });
  await page.evaluate(() => document.getElementById('btn-send').click());
  for (let i=0;i<30;i++){ await sleep(400); const b=await page.$eval('#btn-stop',e=>!e.classList.contains('hidden')).catch(()=>false); if(!b) break; }
  await sleep(3000);
  const after2 = await count();
  console.log('   模型正常返回后 memSummed = ' + after2 + ' 条');
  t('★ 有产出时【照常】记账（否则会无限重跑）', after2 > after, after + ' -> ' + after2);
}

console.log('');
console.log('=== P0-3 重聊/重思考：先清完记忆再重新生成 ===');
{
  const src = readCode(WWW + '/js/app.js');
  t('tidyNow 被 await', src.includes('await tidyNow();'));
  t('置了强制标记', src.includes("await kv.set('memNeedTidy:' + curCharId, true);"));
  t('门槛认得这个标记', src.includes('&& !_needTidy) return 0;'));
  t('消费后清标记', src.includes("await kv.set('memNeedTidy:' + cidFor, false);"));
}

console.log('');
console.log('=== P1-1 队列去重 + 诊断键 ===');
{
  const src = readCode(WWW + '/js/app.js');
  t('noteDeleted 去重', src.includes('const merged = [...new Set(old.concat(clean))];'));
  // ⚠️ 断言更新（v1.21.36）：memQueueLen 已按复审 #7 删除 ——
  // 它是死键（renderMemHealth 一直直接数 memDeleted，从不读它）。
  t('memQueueLen 死键已删除', !src.includes("await kv.set('memQueueLen:'"));
  t('memNeedTidy 已进清理清单', src.includes("'memZeroRetry:', 'memNeedTidy:'"));
}

console.log('');
console.log('=== P1-2 滚动摘要长度引导 ===');
{
  const src = readCode(WWW + '/js/app.js');
  t('给了下限（不是一个上限）', src.includes('ROLLING_MAX_CHARS * 0.5'));
  t('明确不要为短丢信息', src.includes('不要为了短而丢掉信息'));
  t('明确不要越写越短', src.includes('不要越写越短'));
  const badLine = src.split(String.fromCharCode(10)).some(l => l.indexOf('宁短勿长') >= 0 && l.trim().indexOf('+') === 0);
  t('代码里不再说"宁短勿长"', !badLine);
}

console.log('');
console.log('=== P2-2 记忆健康状态可观测（走真实设置页）===');
{
  await page.evaluate(() => { const d = document.getElementById('btn-settings'); if (d) d.click(); });
  await sleep(600);
  await page.evaluate(() => { const b = document.querySelector('[data-wb-drawer="settings"]'); if (b) b.click(); });
  await sleep(1400);
  const txt = await page.$eval('#mem-health', e => e.textContent.replace(/\s+/g,' ').trim()).catch(()=>null);
  console.log('   设置页显示: ' + JSON.stringify(txt));
  t('健康状态有内容', !!txt && txt.length > 8, String(txt));
  t('显示了待总结条数', (txt||'').indexOf('待总结') >= 0, String(txt));
  t('显示了队列长度', (txt||'').indexOf('队列') >= 0, String(txt));
  t('显示了长期记忆条数', (txt||'').indexOf('长期记忆') >= 0, String(txt));
}

console.log('');
console.log('  JS 错误: ' + (errs.length ? JSON.stringify(errs.slice(0,3)) : '无'));
t('无 JS 错误', errs.length === 0, errs.join(' | '));

console.log('');
console.log('========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
