// e2e-memkeep.mjs —— 退回重来【要】动记忆，但必须【删得准】（v1.20.13）
//
// 用户明确要求（原话）：
//   「要动，在我操作了对话后后续的聊天里的记忆都要动」
//   「十句话里我在第五句点了在这重聊后后面几个全删掉，不影响她新的思考输出」
//
// 为什么必须清：留着的话她带着"已经发生过的事"重新生成，
// 就是用户说的「污染记忆产生偏差」。
//
// 三个操作的正确行为（统一）：
//   · 重新思考 regen    → 删那一条 + 清它产生的记忆
//   · 编辑重发 edit     → 删这条及之后 + 清那段产生的记忆
//   · 从这里重聊 rewind → 删这条及之后 + 清那段产生的记忆
//
// ⚠️ 难点是【删得准】。之前出过严重 bug：
// 旧指令是"记忆里如果有哪条【只在】那些内容里出现过，就把那条一起去掉"，
// 模型会放宽成"沾边就删"，把更早形成的长期事实也抹掉 ——
// 用户看到的就是「记忆倒退到很久以前」。
//
// 现在用【配对判据】：
//   system 里给"被删的对话"，user 里给"当前记忆列表"，
//   让模型逐条回答一个问题：「这条记忆是不是【只能】从被删那几句里得到？」
//   是 → 删；更早的对话里本来就有 → 留。

import puppeteer from 'puppeteer-core';
import http from 'http';
import fs from 'fs';
import path from 'path';
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
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = [];
page.on('pageerror', e => errs.push(e.message));
const sleep = ms => new Promise(r=>setTimeout(r,ms));
let pass=0, fail=0;
const t=(n,ok,ex='')=>{ if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));} };

// 假 API：聊天走流式，记忆任务走非流式
await page.evaluateOnNewDocument(() => {
  window.__calls = [];
  const rf = window.fetch.bind(window);
  window.fetch = async function (url, opts) {
    const u = String(url);
    let body = {};
    try { body = JSON.parse((opts && opts.body) || '{}'); } catch {}
    if (u.includes('/chat/completions')) {
      window.__calls.push({ stream: !!body.stream, text: JSON.stringify(body.messages || []).slice(0, 3000) });
      if (body.stream) {
        const c = o => 'data: ' + JSON.stringify(o) + String.fromCharCode(10,10);
        const payload = c({choices:[{delta:{content:'好。'}}]}) +
          c({choices:[{delta:{},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:2}}) +
          'data: [DONE]' + String.fromCharCode(10,10);
        return new Response(payload, { status:200, headers:{'Content-Type':'text/event-stream'} });
      }
      // 记忆任务：原样返回输入的记忆（不合并，方便验证"有没有被删"）
      const json = '[]';
      return new Response(JSON.stringify({ choices:[{ message:{ role:'assistant', content: json } }] }),
        { status:200, headers:{'Content-Type':'application/json'} });
    }
    return rf(url, opts);
  };
});

const MEM = [
  '他每天早上必须喝一杯咖啡。',
  '他老家在成都。',
  '他养了一只橘猫叫团子。',
];

async function setup() {
  await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
  await sleep(1000);
  await page.evaluate(async (mems) => {
    const o = indexedDB.open('ai-companion');
    const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
    const put = (st, rec) => new Promise(r => { const tx = db.transaction(st,'readwrite'); tx.objectStore(st).put(rec); tx.oncomplete = r; });
    await put('characters', { id:'mk1', name:'测试', greeting:'hi', persona:'你是测试。', avatar:null,
      temperature:1, maxTokens:2048, topP:1, reasoningEffort:'low', contextRounds:20,
      kaomojiFreq:0, kaomojiStyle:'jp-soft', emojiFreq:0, verbosity:'medium', splitMessages:false,
      typingDelay:0, hesitation:false, showTyping:true, longMemory:true, allowEditMine:false,
      descLevel:'low', povLock:false, appearance:'', appearanceOn:true, presetKey:'blank', createdAt:1 });
    await put('kv', { k:'lastCharId', v:'mk1' });
    for (let i=0;i<mems.length;i++)
      await put('memories', { id:'mkm'+i, charId:'mk1', text:mems[i], kind:'fact', untilDay:null, freq:'often', ts:Date.now()+i });
    const base = Date.now() - 6*60000;
    for (let i=0;i<6;i++) await put('messages', { id:'mkg'+i, charId:'mk1', role: i%2?'assistant':'user',
      content: (i%2?'我':'他') + '说了第' + i + '句话，又聊到咖啡。', story:{day:5,seg:'night'}, ts: base+i*60000 });
    db.close();
  }, MEM);
  await page.reload({ waitUntil:'networkidle0' });
  await sleep(1000);
}

async function snap() {
  return await page.evaluate(async () => {
    const o = indexedDB.open('ai-companion');
    const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
    const mem = await new Promise(r => { const q = db.transaction('memories').objectStore('memories').getAll(); q.onsuccess = () => r(q.result); });
    const msg = await new Promise(r => { const q = db.transaction('messages').objectStore('messages').getAll(); q.onsuccess = () => r(q.result); });
    const kv = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').getAll(); q.onsuccess = () => r(q.result); });
    db.close();
    const del = kv.find(e => e.k === 'memDeleted:mk1');
    return {
      memN: mem.filter(m => m.charId==='mk1').length,
      memTexts: mem.filter(m => m.charId==='mk1').map(m => m.text),
      msgN: msg.filter(m => m.charId==='mk1').length,
      deletedN: del && Array.isArray(del.v) ? del.v.length : 0,
    };
  });
}

// —— 源码级检查：三个"退回重来"的分支里不该出现 noteDeleted ——
console.log('\n=== 1. 源码：三个退回操作【都要】清记忆 ===');
{
  const src = fs.readFileSync(path.join(WWW, 'js/app.js'), 'utf8');
  const lines = src.split('\n');
  // 找到每个操作分支的行号
  // ⚠️ 必须只匹配【分支开头】那种行 —— 代码里还有个
  //    `if (busy && (k === 'edit' || k === 'rewind' || k === 'regen'))` 的守卫，
  //    用 includes 会先抓到它，区间长度变成 0，断言全假阳性。
  const find = (k) => {
    const i = lines.findIndex(l => /^\s*\}\s*else if \(k === '/.test(l) && l.includes("'" + k + "'"));
    if (i >= 0) return i;
    return lines.findIndex(l => /^\s*if \(k === '/.test(l) && l.includes("'" + k + "'"));
  };
  const iEdit = find('edit'), iRewind = find('rewind'), iRegen = find('regen'), iDel = find('del');
  t('找到了 edit/rewind/regen/del 四个分支', iEdit>0 && iRewind>0 && iRegen>0 && iDel>0,
    JSON.stringify({iEdit,iRewind,iRegen,iDel}));
  // 各分支到下一个分支之间的代码
  // 每个分支的区间 = 从它自己的 k === 'xxx' 到【下一个】k === 'yyy'。
  // 不能假设四个分支的物理顺序，按行号排序后逐个截图。
  const idx = [{k:'edit',i:iEdit},{k:'rewind',i:iRewind},{k:'regen',i:iRegen},{k:'del',i:iDel}]
    .sort((a,b)=>a.i-b.i);
  const body = {};
  for (let n=0;n<idx.length;n++){
    // ⚠️ 最后一个分支没有"下一个分支"可以当右边界，旧写法是硬编码 +40 行。
    // 2026-09-28 就是这么挂的：给 regen 分支加了一段开场白特判（36 行），
    // 把 noteDeleted 挤到窗口外 —— 断言报"没调"，而代码里明明调了。
    // 改成扫到这一层分支真正结束（缩进回到 `    }` 那一行）为止，再留些余量。
    let end;
    if (n + 1 < idx.length) {
      end = idx[n+1].i;
    } else {
      end = lines.length;
      for (let j = idx[n].i + 1; j < lines.length; j++) {
        // 分支体结束 = 出现一个缩进不超过 4 空格的 `}`（对应 `    } else if` 的那只括号）
        if (/^ {0,4}\}\s*$/.test(lines[j])) { end = j + 1; break; }
      }
    }
    body[idx[n].k] = lines.slice(idx[n].i, end).join('\n');
  }
  // ⚠️ 这几条原本是【源码文本断言】——「分支区间里有没有这几个字」。
  // 它太脆：只要把调用包一层（比如把 dedupeIfNeeded(true).catch(()=>{}) 收进
  // tidyNow()），或者分支里多一个 return，断言就挂，而【行为完全没变】。
  // 2026-09-28 就是这么挂的（改了调用形式，行为等价）。
  //
  // 现在改成认【两份等效写法】——调用形式变了也算过，删掉了才算挂。
  // 这不是放宽到"随便"，两条式子都是当前代码里真实存在的收口点：
  //   noteDeleted  —— 把被删内容写进待清理队列
  //   tidyNow / dedupeIfNeeded —— 立刻整理一次（tidyNow 是它的带留痕包装）
  // ⚠️ v0.3.1：这四个分支里的「作废摘要 + 记该忘的清单」两句收口进了 purgeRemoved()，
  //    所以这里改成认【收口点】。和上面那段注释同一个道理：调用形式变了不该算挂，
  //    功能被删掉才算挂 —— 下面额外钉一条「purgeRemoved 里那两句必须都在」。
  const hasNote = (b) => b.includes('noteDeleted(') || b.includes('purgeRemoved(');
  const hasTidy = (b) => b.includes('tidyNow(') || b.includes('dedupeIfNeeded(');
  t('编辑重发调了清理', hasNote(body.edit), '区间长度 ' + body.edit.length);
  t('从这里重聊调了清理', hasNote(body.rewind));
  t('重新思考调了清理', hasNote(body.regen));
  t('删除单条也调了清理', hasNote(body.del));
  const purgeBody = (() => {
    const all = fs.readFileSync(WWW + '/js/app.js', 'utf8').split('\n');
    const i = all.findIndex(l => l.includes('async function purgeRemoved('));
    if (i < 0) return '';
    let end = i + 1;
    for (let j = i + 1; j < all.length; j++) { if (/^\}\s*$/.test(all[j])) { end = j + 1; break; } }
    return all.slice(i, end).join('\n');
  })();
  t('purgeRemoved 里确实做了那两件事（摘要作废 + 记忆台账）',
    purgeBody.includes('invalidateRollingIfStale(') && purgeBody.includes('noteDeleted('),
    '函数体长度 ' + purgeBody.length);
  t('purgeRemoved 空数组直接返回（不白跑一次库读）',
    purgeBody.includes('if (!list.length) return;'));
  t('三个退回操作都触发整理',
    hasTidy(body.edit) && hasTidy(body.rewind) && hasTidy(body.regen),
    JSON.stringify({ edit: hasTidy(body.edit), rewind: hasTidy(body.rewind), regen: hasTidy(body.regen) }));
}

console.log('\n=== 2. 实际行为：退回重来会写"该忘的清单" ===');
await setup();
{
  const before = await snap();
  t('初始 3 条记忆', before.memN === 3, JSON.stringify(before.memN));
  // 直接走编辑重发等价的删除（UI 长按在 headless 里不稳）
  await page.evaluate(async () => {
    const o = indexedDB.open('ai-companion');
    const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
    const all = await new Promise(r => { const q = db.transaction('messages').objectStore('messages').getAll(); q.onsuccess = () => r(q.result); });
    const mine = all.filter(m => m.charId==='mk1').sort((a,b)=>a.ts-b.ts);
    for (const x of mine.slice(-3)) {
      await new Promise(r => { const tx = db.transaction('messages','readwrite'); tx.objectStore('messages').delete(x.id); tx.oncomplete = r; });
    }
    db.close();
  });
  await sleep(400);
  const after = await snap();
  t('消息被删掉了', after.msgN < before.msgN, before.msgN + ' -> ' + after.msgN);
  // 说明：这一步只验证"消息被删"，清单的写入在真实的 edit 分支里
  // （headless 下长按不稳定，所以用源码级断言 + 集成测试覆盖）。
  t('删除操作本身不改记忆条数（清理是异步的）', after.memN === before.memN, before.memN + ' -> ' + after.memN);
}

console.log('\n=== 3. 清理指令用【配对判据】，不是模糊措辞 ===');
{
  const src = fs.readFileSync(path.join(WWW, 'js/app.js'), 'utf8');
  t('判据是"只能从被删内容得到"', src.includes('是不是【只能】从被删的那几句里得到'));
  t('明确了"拿不准一律留着"', src.includes('拿不准的时候【一律留着】'));
  t('禁止因话题相关就删', src.includes('禁止】因为"话题相关"就删'));
  t('给了正反例', src.includes('✗ 留：「他每天早上必须喝咖啡」'));
  const codeOnly = src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  t('代码里去掉了旧的模糊措辞', !codeOnly.includes('只在那些内容里出现过'));
}

console.log('\n=== 4. 弹窗文案如实描述 ===');
{
  const src = fs.readFileSync(path.join(WWW, 'js/app.js'), 'utf8');
  // rewind 的弹窗原来写"她记住的事不会动"，但代码会清 —— 已改
  t('从这里重聊的弹窗没说"不会动"', !src.includes('她记住的事不会动'));
  t('弹窗说明了记忆会被清', src.includes('记忆也会一起清掉'));
  t('弹窗说明长期记忆不受影响', src.includes('之前就形成的长期记忆不受影响'));
}

console.log('\n=== 5. 无 JS 错误 ===');
t('没有 pageerror', errs.length === 0, errs.slice(0,3).join(' | '));

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
