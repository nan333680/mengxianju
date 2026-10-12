// e2e-memfix2.mjs —— 记忆总结的两处遗留 bug（v1.20.15）
//
// ① 总结护栏的 sumCap 被抬高一倍（app.js summarizeIfNeeded）
//    sumCap = liveAll.length + pendingNow.length
//    而 pendingNow 是 liveAll 的子集 → 上限约 2 倍条数
//    → 【序号】又能蒙混过关：70 条消息、memSumAt=22（序号），
//      22 <= 140 通过 → 70-22=48 < 阈值 50 → 永远不总结。
//    用户实测：小恶魔 70 条待总结、记忆 0 条。
//    修：sumCap = liveAll.length（只认真实条数）。
//
// ② 撤销整理靠文本比对（app.js 撤销按钮）
//    备份只存 text，撤销时按"文本完全相等"保留。
//    整理会改措辞，改完对不上 → 旧的没删干净、新的又写进来 → 重复条目。
//    修：备份连 id 一起存；写回时用原 id；删除按 id 比对。
//    （老备份没存 id 时，退回文本比对。）

import puppeteer from 'puppeteer-core';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { readCode } from './e2e-src.mjs';
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
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = [];
page.on('pageerror', e => errs.push(e.message));
const sleep = ms => new Promise(r=>setTimeout(r,ms));
let pass=0, fail=0;
const t=(n,ok,ex='')=>{ if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));} };

await page.evaluateOnNewDocument(() => {
  window.__chat = [];
  const rf = window.fetch.bind(window);
  window.fetch = async function (url, opts) {
    const u = String(url);
    if (u.includes('/chat/completions')) {
      let body = {};
      try { body = JSON.parse((opts && opts.body) || '{}'); } catch {}
      window.__chat.push(body);
      if (body.stream) {
        const c = o => 'data: ' + JSON.stringify(o) + String.fromCharCode(10,10);
        return new Response(c({choices:[{delta:{content:'嗯。'}}]}) + c({choices:[{delta:{},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:2}}) + 'data: [DONE]' + String.fromCharCode(10,10),
          { status:200, headers:{'Content-Type':'text/event-stream'} });
      }
      // 记忆任务：返回一条固定记忆，方便观察
      return new Response(JSON.stringify({ choices:[{ message:{ role:'assistant',
        content: '[{"text":"他老家在成都。","kind":"fact","untilDay":null,"freq":"once"}]' } }] }),
        { status:200, headers:{'Content-Type':'application/json'} });
    }
    return rf(url, opts);
  };
});

const mkChar = (extra={}) => Object.assign({
  id:'mf2', name:'测试', greeting:'hi', persona:'你是测试。', avatar:null,
  temperature:1, maxTokens:2048, topP:1, reasoningEffort:'low', contextRounds:20,
  kaomojiFreq:0, kaomojiStyle:'jp-soft', emojiFreq:0, verbosity:'medium', splitMessages:false,
  typingDelay:0, hesitation:false, showTyping:true, longMemory:true, allowEditMine:false,
  descLevel:'low', povLock:false, appearance:'', appearanceOn:true, presetKey:'blank', createdAt:1,
}, extra);

async function setup(opts) {
  await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
  await sleep(900);
  await page.evaluate(async (o) => {
    const req = indexedDB.open('ai-companion');
    const db = await new Promise(r => { req.onsuccess = () => r(req.result); });
    const put = (st, rec) => new Promise(r => { const tx = db.transaction(st,'readwrite'); tx.objectStore(st).put(rec); tx.oncomplete = r; });
    const clear = (st) => new Promise(r => { const tx = db.transaction(st,'readwrite'); tx.objectStore(st).clear(); tx.oncomplete = r; });
    await clear('messages'); await clear('memories'); await clear('kv'); await clear('characters');
    await put('characters', o.char);
    await put('kv', { k:'lastCharId', v: o.char.id });
    const base = Date.now() - 200*60000;
    for (let i=0;i<o.msgN;i++)
      await put('messages', { id:'x'+i, charId:o.char.id, role: i%2?'assistant':'user',
        content:(i%2?'我':'他')+'说了第'+i+'件事', story:null, ts: base+i*60000 });
    for (const k of (o.kv||[])) await put('kv', k);
    db.close();
  }, opts);
  await page.reload({ waitUntil:'networkidle0' });
  await sleep(1000);
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
}

const memTexts = () => page.evaluate(async () => {
  const req = indexedDB.open('ai-companion');
  const db = await new Promise(r => { req.onsuccess = () => r(req.result); });
  const all = await new Promise(r => { const q = db.transaction('memories').objectStore('memories').getAll(); q.onsuccess = () => r(q.result); });
  db.close();
  return all.map(m => ({ id:m.id, text:m.text }));
});

async function sendOnce(text) {
  await page.evaluate(tx => { const el=document.getElementById('input'); el.value=tx; el.dispatchEvent(new Event('input',{bubbles:true})); }, text);
  await sleep(150);
  await page.evaluate(() => document.getElementById('btn-send').click());
  let started=false;
  for (let i=0;i<80;i++){ const b=await page.$eval('#btn-stop',el=>!el.classList.contains('hidden')).catch(()=>false); if(b){started=true;break;} await sleep(150); }
  if (started) for (let i=0;i<200;i++){ const b=await page.$eval('#btn-stop',el=>!el.classList.contains('hidden')).catch(()=>false); if(!b)break; await sleep(200); }
  await sleep(400);
}

console.log('\n=== ① 序号（越界值）不该被当成条数 ===');
// 70 条消息，memSumAt = 22（序号污染）。
// 老逻辑：sumCap = 70 + 70 = 140，22 <= 140 通过 → 70-22=48 < 50 → 不总结
// 新逻辑：sumCap = 70，22 <= 70 通过 …… 仍然通过（22 确实小于 70）
//   ⚠️ 所以真正能验证的是【大于条数】的序号：比如 seq=2000、条数=70
await setup({
  char: mkChar(),
  msgN: 70,
  kv: [{ k:'memSumAt:mf2', v: 2000 }, { k:'msgSeq:mf2', v: 2000 }],
});
await sendOnce('在吗');
for (let i=0;i<30;i++){ const m=await memTexts(); if(m.length) break; await sleep(500); }
{
  const m = await memTexts();
  t('序号 2000 远大于条数 70 → 归零后能正常总结', m.length > 0, '记忆 ' + m.length + ' 条');
}

console.log('\n=== ② 撤销整理：备份带 id，写回用原 id ===');
{
  const src = readCode(path.join(WWW, 'js/app.js'));
  t('备份里存了 id', /items: before\.map\(m => \(\{ id: m\.id/.test(src));
  t('写回时用原 id', src.includes('id: it.id || uid()'));
  t('删除按 id 比对', src.includes('const keepIds = hasIds ? new Set(bk.items.map(x => x.id)) : null'));
  t('保留了老备份的文本兜底', src.includes('const keepTexts = hasIds ? null : new Set(bk.items.map(x => x.text))'));
}

console.log('\n=== ③ 判据已重构，不再依赖水位 ===');
{
  // v1.20.15 起，summarizeIfNeeded 直接数 pendingNow.length，
  // sumCap / lastSum / memSumAt 的读取全部删掉了。
  // 详见 e2e-memsum.mjs（那套专门测这个）。
  const src = readCode(path.join(WWW, 'js/app.js'));
  t('判据是 pendingNow.length', src.includes('if (pendingNow.length < (S.memSummarizeEvery || 50)) return;'));
  t('sumCap 已删除', !src.includes('const sumCap'));
  t('lastSum 已删除', !src.includes('const lastSum ='));
}
console.log('\n=== ④ 撤销的实际行为（写回 + 删新增）===');
{
  await setup({ char: mkChar(), msgN: 3 });
  // 放一批记忆（模拟"整理前"），并手工写一份带 id 的备份
  await page.evaluate(async () => {
    const req = indexedDB.open('ai-companion');
    const db = await new Promise(r => { req.onsuccess = () => r(req.result); });
    const put = (st, rec) => new Promise(r => { const tx = db.transaction(st,'readwrite'); tx.objectStore(st).put(rec); tx.oncomplete = r; });
    const items = [
      { id:'old1', text:'他老家在成都。', kind:'fact', untilDay:null, freq:'once', mine:false },
      { id:'old2', text:'他怕黑。', kind:'fact', untilDay:null, freq:'once', mine:false },
    ];
    await put('kv', { k:'memTidyBackup:mf2', v: { at: Date.now(), items } });
    // 当前库里是"整理后"的一批（id 不同、措辞也变了）
    await put('memories', { id:'new1', charId:'mf2', text:'他老家在成都，口味偏辣。', kind:'fact', untilDay:null, freq:'once', ts:Date.now() });
    await put('memories', { id:'new2', charId:'mf2', text:'他怕黑，睡觉要留灯。', kind:'fact', untilDay:null, freq:'once', ts:Date.now()+1 });
    db.close();
  });
  await page.reload({ waitUntil:'networkidle0' });
  await sleep(900);
  // 进设置页 → 记忆管理 → 点撤销
  await page.evaluate(() => document.getElementById('btn-settings').click());
  await sleep(600);
  await page.evaluate(() => { const x=[...document.querySelectorAll('#drawer-menu [data-wb-drawer]')].find(y=>y.dataset.wbDrawer==='settings'); if(x)x.click(); });
  await sleep(800);
  await page.evaluate(() => { const f=document.getElementById('mem-set-fold'); if(f)f.click(); });
  await sleep(400);
  const hasUndo = await page.evaluate(() => !!document.getElementById('btn-mem-undo'));
  t('撤销按钮存在', hasUndo);
  if (hasUndo) {
    await page.evaluate(() => document.getElementById('btn-mem-undo').click());
    await sleep(500);
    // 确认弹窗
    await page.evaluate(() => { const b=document.getElementById('modal-ok'); if(b)b.click(); });
    await sleep(1200);
    const after = await memTexts();
    t('撤销后回到备份的 2 条', after.length === 2, '实际 ' + after.length + ' 条: ' + JSON.stringify(after.map(x=>x.text)));
    t('内容是备份里的原文', after.every(x => ['他老家在成都。','他怕黑。'].includes(x.text)),
      JSON.stringify(after.map(x=>x.text)));
    t('没有重复条目', new Set(after.map(x=>x.id)).size === after.length);
  }
}

console.log('\n=== ⑤ 无 JS 报错 ===');
t('没有 pageerror', errs.length === 0, errs.slice(0,3).join(' | '));

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
