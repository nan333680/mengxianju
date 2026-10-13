// e2e-group3.mjs — 群聊「小说式一幕」（v0.4.1）
//
// 用户要的效果：群聊读起来像小说，而不是"一个人一句台词"。
// 做法是放开"这一轮只写你自己"，改成"把这一幕写下来"：换人说话另起一段、段首标【名字】，
// 不带【】的段落算旁白。前端按标记把一条回复拆成几条消息，各自挂各自的说话人。
//
// ⚠️ 这一套的重点不是"模型会不会照做"，而是**解析和兜底**：
//    诊断文档 §6 那张表说得很清楚 —— 让模型在正文里夹带归属可靠性低。
//    所以三种情况都要钉死：认得出人 / 认不出人（当旁白，不猜）/ 一个都没认出来（整段归主说话人）。
import puppeteer from 'puppeteer-core';
import { seedChars } from './e2e-helper.mjs';
import http from 'http'; import fs from 'fs'; import path from 'path';
const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');
const WWW = R + '/www';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8' };
let pass = 0, fail = 0;
const t = (n, ok, ex) => { if (ok) { pass++; console.log('  OK   ' + n); } else { fail++; console.log('  FAIL ' + n + (ex !== undefined ? '  -> ' + JSON.stringify(ex) : '')); } };
const NL = String.fromCharCode(10);

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = path.join(WWW, p);
  if (!fs.existsSync(f)) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 120000,
  args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = []; page.on('pageerror', e => errs.push(e.message));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let replyText = '嗯。';
let lastReq = null;
// 记忆总结那条路的请求（要断言"谁说的"标的是成员名，不是群名）
let memReqs = [];
let chatReq = null;
let allReqs = [];
await page.setRequestInterception(true);
page.on('request', req => {
  if (req.url().includes('/chat/completions')) {
    if (req.method() === 'OPTIONS') { req.respond({ status: 204, headers: { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Headers':'*', 'Access-Control-Allow-Methods':'*' } }); return; }
    allReqs.push(req.url().slice(-40));
    try { lastReq = JSON.parse(req.postData() || '{}'); } catch { lastReq = null; }
    // 记忆总结那条路要的是 JSON 数组；回正文会把它当成格式错
    // ⚠️ 判据别认「长期记住」——群聊那套开场换成了「目的是给这个群留下长期记忆」，
    //    一改断言就静默失效（第一次跑还全绿，是因为当时还没换）。
    //    改成认所有记忆总结共有的那句输出格式要求。
    // ⚠️ 「只输出 JSON 数组」这句【查重】的提示词里也有 —— 第一版就抓错了请求，
    //    断言全打在"重新整理一遍"那条上。用总结独有的那句。
    const isSum = !!(lastReq && (lastReq.messages || []).some(x => String(x.content || '').includes('【不要记】')));
    if (isSum) { memReqs.push(lastReq); }
    // ⚠️ 生成完之后后台记忆任务还会发请求，lastReq 会被它顶掉 ——
    //    所以"聊天那次"要单独留一份，不然后面读提示词读到的全是记忆提示词。
    else chatReq = lastReq;
    // 流式：把 replyText 一次性吐出去（换行用 \n 转义成真换行再拼进 SSE）
    const chunk = JSON.stringify({ choices: [{ delta: { content: isSum ? '[]' : replyText } }] });
    req.respond({ status: 200, headers: { 'Access-Control-Allow-Origin':'*' }, contentType: 'text/event-stream',
      body: 'data: ' + chunk + NL + NL + 'data: [DONE]' + NL + NL }); return;
  }
  req.continue();
});
await page.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'networkidle0', timeout: 40000 });
await sleep(1200);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil: 'networkidle0' }); await sleep(1000);
await seedChars(page, [
  { name: '甲', greeting: '（甲在）', id: 'ga' },
  { name: '乙', greeting: '（乙在）', id: 'gb' },
  { name: '丙', greeting: '（丙在）', id: 'gc' },
]);
await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const put = (st, rec) => new Promise(r => { const tx = db.transaction(st, 'readwrite'); tx.objectStore(st).put(rec); tx.oncomplete = r; });
  const rec = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get('settings'); q.onsuccess = () => r(q.result); });
  await put('kv', { k: 'settings', v: Object.assign({}, (rec && rec.v) || {}, { apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com', longMemory: false }) });
  await put('characters', { id: 'ggrp1', name: '周末茶会', isGroup: true, memberIds: ['ga','gb','gc'],
    groupNote: '', speakMode: 'round', turnIndex: 0, avatar: null, greeting: '（三个人都在。）',
    presetKey: 'blank', createdAt: Date.now() });
  db.close();
});
await page.reload({ waitUntil: 'networkidle0' }); await sleep(1200);
await page.evaluate(() => { [...document.querySelectorAll('#char-list .char-card')].find(x => x.dataset.id === 'ggrp1').click(); });
await sleep(1400);

// ⚠️ v0.4.1.6：这一幕【几个人】是抽的（1/2/3）。抽到 1 个人时会换成"只写她一个人"
//    那套提示词，而下面大部分断言是冲着"小说式一幕"来的 —— 先把随机数压在
//    "2 个人"那一档，让这一套可复现；要测随机本身，第 9d 节自己会重设。
//    用【带计数的】小扰动而不是常数：常数会让 uid() 在同一毫秒里撞车。
await page.evaluate(() => { let n = 0; Math.random = () => { n++; return 0.45 + (n % 97) / 100000; }; });

const waitDone = async () => { for (let i = 0; i < 80; i++) { await sleep(300); const b = await page.$eval('#btn-stop', e => !e.classList.contains('hidden')).catch(() => false); if (!b) break; } await sleep(800); };
const send = async (s) => {
  // ⚠️ 上一轮的记忆任务还在跑时 send 会被拦下（"她还在打字"），输入框不会被清空 ——
  //    判据就用【输入框有没有被清掉】：清了 = 过了 busy 检查、真的发出去了。
  for (let k = 0; k < 4; k++) {
    await page.evaluate(x => { const el = document.getElementById('input'); el.value = x; el.dispatchEvent(new Event('input', { bubbles: true })); }, s);
    await sleep(150);
    await page.evaluate(() => document.getElementById('btn-send').click());
    await waitDone();
    const left = await page.evaluate(() => document.getElementById('input').value);
    if (!left) break;
    await sleep(2500);
  }
};
const aiMsgs = async () => page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const all = await new Promise(r => { const q = db.transaction('messages').objectStore('messages').getAll(); q.onsuccess = () => r(q.result); });
  const g = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').get('ggrp1'); q.onsuccess = () => r(q.result); });
  db.close();
  return {
    ai: all.filter(m => m.charId === 'ggrp1' && m.role === 'assistant').sort((a, b) => (a.ts || 0) - (b.ts || 0))
      .map(m => ({ c: m.content, s: m.speakerId || null, narr: m.narration === true })),
    turnIndex: g && g.turnIndex,
  };
});
const sysOf = () => ((chatReq || lastReq) && (chatReq || lastReq).messages ? (chatReq || lastReq).messages : []).filter(m => m.role === 'system').map(m => String(m.content || ''));

console.log('=== 1. 默认就该是"小说式一幕"，而且提示词里说清了格式 ===');
// ⚠️ v0.4.1.6：中间那行必须【用括号包住】才算旁白 —— 没包住的裸行现在归上一个说话人
replyText = '【甲】我先说。' + NL + '（窗外的雨小了些，谁都没急着接话）' + NL + '【乙】那我接着说。';
await send('开始吧');
const sys1 = sysOf();
t('本轮段走的是「这一幕怎么写」', sys1.some(s => s.includes('这一幕怎么写')), sys1.map(s => s.slice(0, 16)));
t('明确要求换人说话另起一行、行首标【名字】', sys1.some(s => s.includes('行首用【名字】标出来')), '');
t('说清了「场面描写整行用括号包起来」', sys1.some(s => s.includes('场面描写整行用括号包起来')), '');
t('并且说明了没标名字、又没括号的会被算成上一个人说的', sys1.some(s => s.includes('系统会算成【上一个说话人】说的')), '');
t('旁白只写大家都看得见的（不许拿旁白写某个人的动作）', sys1.some(s => s.includes('别丢给旁白')), '');
t('旁白里不许出现不指名的「她」', sys1.some(s => s.includes('不要出现不指名的「她」')), '');
// ⚠️ v0.4.1.6：这一场到场的【只是抽到的那几个人】（不再是把全群名单报一遍）——
//    断言改成"列出来的名字是一部分、而且都在成员里"，顺便钉住"这一幕只有 2 个人"。
const rosterLine = sys1.find(s => s.includes('名字只能用这几个')) || '';
const listed = ((rosterLine.match(/只能用这几个[：:]\s*([^\n]+)/) || [])[1] || '').trim();
const listedArr = listed ? listed.split('、').map(x => x.trim()) : [];
t('把这一场到场的名单给了它（只列抽到的那几个）',
  listedArr.length === 2 && listedArr.every(n => ['甲','乙','丙'].indexOf(n) >= 0), listed);
t('并且仍然点名"你现在是「甲」"', sys1.some(s => s.includes('你现在是「甲」')), '');
t('写明了"要点是她们之间真的在互动"', sys1.some(s => s.includes('真的在互动')), '');
t('要求后开口的人接住前一个人的话', sys1.some(s => s.includes('接住前一个人的话')), '');
t('要求这一幕结束时事情要往前走一点', sys1.some(s => s.includes('往前走一点')), '');
t('要求旁白写"人对人"的动作、不只是环境', sys1.some(s => s.includes('人对人')), '');

console.log('=== 2. 一条回复被拆成三条，各归各的人 ===');
let r = await aiMsgs();
console.log('   ' + JSON.stringify(r.ai));
// ⚠️ r.ai[0] 是群的开场白（建成群时自动补的那条），不是这一轮的产物 ——
//    所以看的是【最后三条】。这个坑第一版就踩了，断言全打在开场白上。
const scene = r.ai.slice(-3);
t('拆成了三条消息', scene.length === 3 && scene[0].c.includes('我先说'), scene.map(x => x.c));
t('第一条归甲', scene[0] && scene[0].s === 'ga' && scene[0].c.includes('我先说'), scene[0]);
t('第二条是旁白（没有 speakerId，带 narration 标记）', scene[1] && scene[1].s === null && scene[1].narr === true, scene[1]);
t('第三条归乙', scene[2] && scene[2].s === 'gb' && scene[2].c.includes('那我接着说'), scene[2]);
t('旁白那条的正文里没有【】残留', scene[1] && !scene[1].c.includes('【'), scene[1]);
t('轮次从【最后开口的那个人】往后推（乙 → 丙）', r.turnIndex === 2, r.turnIndex);

console.log('=== 2b. 模型漏标名字的台词：归【上一个说话人】，不再变成旁白 ===');
// 用户实测截图里的那条：「回来了就好。那半句话你发了一半，我没看明白。」
// 前面是【芙兰】的一句（旁白），后面是【文文】的一句 —— 中间那行没标名字。
// ⚠️ 第一行必须是【裸的】括号行 —— 带【甲】标记的行本来就归甲（那是她的动作），
//    不是旁白（第一版把断言打在"有标记的行"上了）。
replyText = '（她往前挪了半步）' + NL + '回来了就好。那半句话你发了一半，我没看明白。'
  + NL + '【乙】（锅盖响了）' + NL + '我去看看。';
await send('接着说');
const r2b = await aiMsgs();
const last3b = r2b.ai.slice(-4);
console.log('   ' + JSON.stringify(last3b));
t('拆成了四条（两句台词各自成段）', last3b.length === 4, last3b.map(x => x.c));
// ⚠️ 这一段前面【没有】带名字的行（第一行是裸旁白），所以它会归到"这一轮的起头人"——
//    而起头人每轮都在转（不是固定甲）。从提示词里把她读出来对一下。
const starterName = (sysOf().find(x => x.includes('必须有「')) || '').match(/必须有「([^」]+)」/);
const NAME2ID = { '甲': 'ga', '乙': 'gb', '丙': 'gc' };
const starterId = starterName ? NAME2ID[starterName[1]] : '';
t('没标名字的台词归【这一轮的起头人】', last3b[1] && !!starterId && last3b[1].s === starterId && last3b[1].c.indexOf('回来了就好') >= 0,
  { got: last3b[1], starter: starterName && starterName[1], starterId: starterId });
t('它【不再】是旁白', last3b[1] && last3b[1].narr !== true, last3b[1]);
t('括号包住的那行仍然是旁白', last3b[0] && last3b[0].s === null && last3b[0].narr === true, last3b[0]);
t('换了名字之后归到乙', last3b[3] && last3b[3].s === 'gb' && last3b[3].c.indexOf('我去看看') >= 0, last3b[3]);

console.log('=== 3. 界面上旁白和"谁说的"看得出来 ===');
const dom = await page.evaluate(() => {
  const els = [...document.querySelectorAll('#messages .msg.ai')];
  return els.map(e => ({ narr: e.classList.contains('narr'), who: (e.querySelector('.who') || {}).textContent || '' }));
});
console.log('   ' + JSON.stringify(dom));
t('旁白那条带了 narr 类', dom.some(x => x.narr === true), dom);
t('甲、乙那两条顶上有名字', dom.some(x => x.who === '甲') && dom.some(x => x.who === '乙'), dom);
t('旁白那条没有名字', dom.filter(x => x.narr).every(x => !x.who), dom);

console.log('=== 4. 兜底：模型完全不按格式来 → 整段归主说话人（不许丢内容）===');
replyText = '嗯，那就这样吧。没有名字的一段话。';
await send('嗯');
r = await aiMsgs();
const lastOne = r.ai[r.ai.length - 1];
t('没有【】时不分段，整段归主说话人（丙）', !!lastOne && lastOne.s === 'gc' && lastOne.c.includes('没有名字的一段话'), lastOne);
t('而且没有标成旁白', !!lastOne && lastOne.narr !== true, lastOne);

console.log('=== 5. 兜底：名字认不出来 → 当旁白，【不许猜】 ===');
replyText = '【丁】我不是这个群的人。';
await send('咦');
r = await aiMsgs();
const unknown = r.ai[r.ai.length - 1];
t('认不出的名字不硬挂给在场的人', !!unknown && unknown.s === null, unknown);
t('按旁白处理，而且把【名字】原样留着（看得见"模型用了个不认识的名字"）',
  !!unknown && unknown.narr === true && unknown.c.includes('【丁】'), unknown);

console.log('=== 5b. 被点名的人必须接话（提示词里直接说）===');
replyText = '【乙】来了。';
await send('@乙 你说说看');
const sysN = sysOf();
t('被点名时提示词明说"你必须接话"', sysN.some(s => s.includes('你必须接话')), sysN.map(s => s.slice(0, 20)));
t('而且这一轮的锚点就是他点名的那个人（乙）', sysN.some(s => s.includes('你现在是「乙」')), '');
r = await aiMsgs();
const namedOne = r.ai[r.ai.length - 1];
t('回复归乙', !!namedOne && namedOne.s === 'gb', namedOne);
// 没点名的那一轮不该出现这句 —— 否则这句话就成了噪音
await send('你们聊');
const sysFree = sysOf();
t('没点名时不出现"你必须接话"', !sysFree.some(s => s.includes('你必须接话')), '');

console.log('=== 6. 群设定：这两个入口原来一个都没有 ===');
await page.evaluate(() => { [...document.querySelectorAll('#char-list .char-card')].find(x => x.dataset.id === 'ggrp1').querySelector('[data-edit]').click(); });
await sleep(900);
const fields = await page.evaluate(() => ({
  note: !!document.getElementById('g-note'),
  narr: !!document.getElementById('g-narr'),
  narrChecked: (document.getElementById('g-narr') || {}).checked,
}));
console.log('   ' + JSON.stringify(fields));
t('「这个群是怎么回事」有输入框了', fields.note === true, fields);
t('「小说式一幕」有开关了，而且默认开着', fields.narr === true && fields.narrChecked === true, fields);
await page.evaluate(() => { document.getElementById('g-note').value = '每周六下午在她家喝茶。'; });
await page.evaluate(() => document.getElementById('btn-group-save').click());   // v0.4.1.4：整页的保存键
await sleep(1400);
await send('继续');
const sys2 = sysOf();
t('群设定进了稳定前缀（「这个群是怎么回事」那段）', sys2.some(s => s.includes('每周六下午在她家喝茶')), '');

console.log('=== 7. 关掉小说模式 → 回到"一轮一个人" ===');
await page.evaluate(() => { [...document.querySelectorAll('#char-list .char-card')].find(x => x.dataset.id === 'ggrp1').querySelector('[data-edit]').click(); });
await sleep(900);
await page.evaluate(() => { document.getElementById('g-narr').checked = false; });
await page.evaluate(() => document.getElementById('btn-group-save').click());
await sleep(1400);
replyText = '【甲】这一句不该被拆开。' + NL + '【乙】这一句也不该。';
await send('试试');
const sys3 = sysOf();
t('关掉之后本轮段换成「这一轮你演谁」', sys3.some(s => s.includes('这一轮你演谁')), sys3.map(s => s.slice(0, 16)));
t('并且不再出现「这一幕怎么写」', !sys3.some(s => s.includes('这一幕怎么写')), '');
r = await aiMsgs();
const afterOff = r.ai.slice(-1)[0];
t('整段是一条消息（不再按名字拆）', !!afterOff && afterOff.c.includes('不该被拆开') && afterOff.c.includes('也不该'), afterOff);

console.log('=== 8. 记忆总结喂进去的输入：必须标【成员名】，不能标【群名】 ===');
// 起因（v0.4.1 复查时自己找出来的）：滚动摘要 / 记忆整理 / 归档总结三处都写成
//   (m.role === 'user' ? '他：' : who + '：')，而 who 是这条 characters 记录的名字 ——
//   群记录的名字是「周末茶会」。于是三个成员的话全被标成同一个名字，
//   总结模型只能当成"一个人说的"，而且结果【永久写进长期记忆】，每一轮都注入。
//   比聊天里那个身份串台更糟：那个只影响一轮，这个一直留在库里。
await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const put = (st, rec) => new Promise(r => { const tx = db.transaction(st, 'readwrite'); tx.objectStore(st).put(rec); tx.oncomplete = r; });
  const now = Date.now();
  for (let i = 0; i < 26; i++) {
    const role = i % 2 === 0 ? 'user' : 'assistant';
    const rec = { id: 'seed' + i, charId: 'ggrp1', role, content: '第' + i + '句', ts: now - (100 - i) * 1000, images: [], imageNotes: [] };
    if (role === 'assistant') {
      if (i === 3) rec.speakerId = 'ga';
      else if (i === 5) rec.speakerId = 'gb';
      else if (i === 7) { rec.narration = true; }
      else rec.speakerId = 'ga';
    }
    await put('messages', rec);
  }
  // 先塞 3 条已有记忆 —— 「立即整理记忆」按钮有闸门：记忆少于 3 条直接"没什么可整理的"返回
  // （app.js:8699）。第一版没塞，点了按钮什么都没发生，5 条断言全红。
  for (let i = 0; i < 3; i++) {
    await put('memories', { id: 'm' + i, charId: 'ggrp1', text: '旧记忆' + i, kind: 'fact', freq: 'normal', ts: now - 5000 + i });
  }
  // memSummed 留空 = 这 26 条全是"还没总结过"的
  const kvRec = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get('settings'); q.onsuccess = () => r(q.result); });
  await put('kv', { k: 'settings', v: Object.assign({}, (kvRec && kvRec.v) || {}, { apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com', longMemory: true }) });
  db.close();
});
await page.reload({ waitUntil: 'networkidle0' }); await sleep(1200);
// ⚠️ 不去点导航 —— 那个 id 不是 nav-mine（第一版就栽在这，报的是"null.click"）。
//    #btn-mem-tidy 是静态 HTML 里的按钮，不管当前在哪个视图，click() 都会触发它的处理函数。
await sleep(600);
// ⚠️ 必须先把当前角色【切回这个群】再点整理 —— 整理读的是 curCharId（app.js:8696）。
//    reload 之后恢复的是 lastCharId，前面几节开过编辑页，不保证还是群；
//    切错了人，pending 就是空的，总结那一步根本不会发起（第一版就是这个问题）。
await page.evaluate(() => {
  const c = [...document.querySelectorAll('#char-list .char-card')].find(x => x.dataset.id === 'ggrp1');
  if (c) c.click();
});
await sleep(1200);
// ⚠️ 「立即整理记忆」那个按钮【只跑查重（dedupeFor）】，不跑总结 ——
//    总结在 runMemTasks 里，而它是 send() 的 finally 里 fire-and-forget 触发的。
//    所以这一节要【发一条消息】，然后等后台那一步自己发起请求。
//    （第一版点按钮点了半天，7 次模型调用全是查重的，总结一次都没发。）
memReqs = [];
await send('那我们接着说吧');
for (let i = 0; i < 120 && !memReqs.length; i++) await sleep(500);
await sleep(2000);
// 临时诊断：按钮点下去之后到底发生了什么
const dbg = await page.evaluate(() => {
  const b = document.getElementById('btn-mem-tidy');
  const tst = document.getElementById('toast');
  return {
    hasBtn: !!b, disabled: b && b.disabled, label: b && b.textContent,
    toast: tst ? tst.textContent : '(no toast el)',
    cur: (window.__dbgCur !== undefined) ? window.__dbgCur : 'n/a',
  };
});
console.log('   DBG ' + JSON.stringify(dbg) + '  reqs=' + allReqs.length + ' sumReqs=' + memReqs.length);
console.log('   DBG urls: ' + allReqs.slice(-6).join(' | '));
// ⚠️ 整理记忆会先跑"查重"，那也是模型调用 —— 所以要挑出【长期记忆总结】那一次，
//    不能拿到最后一次请求就当成它。
const sumReq = (memReqs || [])[0] || null;
const memBody = sumReq ? (sumReq.messages || []).map(x => String(x.content || '')).join(String.fromCharCode(10)) : '';
console.log('   总结请求片段: ' + memBody.slice(-420));
console.log('   DBG 总结请求条数=' + memReqs.length + ' 头=' + memBody.slice(0, 120).replace(/\n/g, ' / '));
t('记忆总结真的发起了（拿到了请求）', !!memBody, memBody.slice(-120));
t('输入里标了成员名（甲）', memBody.includes('甲：'), '');
t('输入里标了成员名（乙）', memBody.includes('乙：'), '');
t('旁白标成「旁白：」，不算在某个人头上', memBody.includes('旁白：'), '');
t('用户的话还是「他：」', memBody.includes('他：'), '');
// ⚠️ 只看【正文行】—— 提示词里自己会引用一次 `【群名：】` 来解释规则，
//    拿 includes 整个 body 去判会假红（第一版就是这么错的）。
const txLines = memBody.split(String.fromCharCode(10));
t('⚠️ 正文里没有一行是「群名：」（那正是这一版修的静默污染）',
  !txLines.some(l => l.startsWith('周末茶会：')), txLines.filter(l => l.includes('周末茶会')).slice(0, 2));
t('群聊用的是【群那一套】开场（不是"回顾你和他的对话"）',
  memBody.includes('这个群聊里发生的事') && !memBody.includes('正在回顾你和他的对话'), '');
t('并且明说"不要用「我」"（群里「我」指谁不清楚）', memBody.includes('不要用「我」'), '');

console.log('=== 9. v0.4.1.4：群设置是整页了（群头像 / 篇幅 / 成员二级设置） ===');
// ⚠️ 第 7 节把小说模式关掉了，这里要先把开关开回来 ——
//    篇幅那句提示词只在小说模式下出现，不然这条断言永远测不到东西。
//
// ⚠️ v0.4.1.4：群设置从「选人弹窗 + extraHtml」改成了【整页 view-group】，
//    二级设置也从弹窗里那个 ⚙ 改成了【点头像进 view-gmember】。
//    这一节原来查的是 #g-avatar / #pk-list .pk-gear / #mc-note，全部跟着改。
await page.evaluate(() => { [...document.querySelectorAll('#char-list .char-card')].find(x => x.dataset.id === 'ggrp1').querySelector('[data-edit]').click(); });
await sleep(1000);
const pageOn = await page.evaluate(() => ({
  active: document.getElementById('view-group').classList.contains('active'),
  modal: !document.getElementById('modal').classList.contains('hidden'),
  avatar: !!document.getElementById('g-avatar-pick'),
  avatarFile: !!document.getElementById('g-avatar-file'),
  len: !!document.getElementById('g-len'),
  lenVal: (document.getElementById('g-len') || {}).value,
  tiles: document.querySelectorAll('#g-members [data-gm]').length,
  add: !!document.querySelector('#g-members [data-gm-add]'),
}));
console.log('   ' + JSON.stringify(pageOn));
t('群设置进的是整页（不再是弹窗）', pageOn.active === true && pageOn.modal === false, pageOn);
t('「群头像」有入口了（用户反馈：原来改不了）', pageOn.avatar === true && pageOn.avatarFile === true, pageOn);
t('「这一幕写多长」有入口了，默认中档', pageOn.len === true && pageOn.lenVal === 'mid', pageOn);
t('成员是头像九宫格（点她 = 进她的二级设置）', pageOn.tiles === 3 && pageOn.add === true, pageOn);
await page.evaluate(() => { const c = document.getElementById('g-narr'); if (c) c.checked = true; });

// 篇幅：切成"短"，提示词里的篇幅要求要跟着换
await page.evaluate(() => { document.getElementById('g-len').value = 'short'; });
await page.evaluate(() => document.getElementById('btn-group-save').click());
await sleep(1200);
const saved = await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const g = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').get('ggrp1'); q.onsuccess = () => r(q.result); });
  db.close();
  return g && { sceneLen: g.sceneLen, narrative: g.narrative };
});
console.log('   DBG 存进去的: ' + JSON.stringify(saved));
t('篇幅和小说模式都存进了群记录', !!saved && saved.sceneLen === 'short' && saved.narrative === true, saved);
// ⚠️ 这一幕几个人是【抽】的：抽到 1 个人就会换成"只写她一个人"那套提示词，
//    里面没有篇幅那句话。要测篇幅，先把随机数压到"2 个人"那一档。
await page.evaluate(() => { window.__rndS = Math.random; let n = 0; Math.random = () => { n++; return 0.45 + (n % 97) / 100000; }; });
replyText = '【甲】短一点。';
await send('试试短档');
const sysS = sysOf();
await page.evaluate(() => { if (window.__rndS) Math.random = window.__rndS; });
{
  const blk = sysS.find(s => s.includes('这一幕怎么写')) || '';
  console.log('   DBG 这一幕段: ' + blk.replace(/\n/g, ' | ').slice(0, 400));
}
t('切到短档后提示词要 120~220 字', sysS.some(s => s.includes('120~220 字')), '');

// 二级设置：点她的头像 → 写群内补充 + 少开口 → 保存
await page.evaluate(() => document.querySelector('#g-members [data-gm="gb"]').click());
await sleep(1000);
const gmUi = await page.evaluate(() => ({
  active: document.getElementById('view-gmember').classList.contains('active'),
  name: document.getElementById('gm-name').textContent,
  sub: document.getElementById('gm-sub').textContent,
  persona: !!document.getElementById('gm-persona-open'),
  note: !!document.getElementById('gm-note-open'),
  views: !!document.getElementById('gm-views-open'),
  params: !!document.getElementById('gm-params-open'),
  talk: !!document.getElementById('gm-talk'),
  muted: !!document.getElementById('gm-muted'),
}));
console.log('   ' + JSON.stringify({ name: gmUi.name }));
t('点她的头像进的是她的二级页', gmUi.active === true && gmUi.name === '乙', gmUi);
t('写清了"她在哪个群里"', gmUi.sub.includes('周末茶会'), gmUi.sub);
t('四样都能改：群内人设 / 群内补充 / 她怎么看 / 群内参数',
  gmUi.persona && gmUi.note && gmUi.views && gmUi.params, gmUi);
t('活跃度和「少开口」也在这一页', gmUi.talk === true && gmUi.muted === true, gmUi);
await page.evaluate(() => document.getElementById('gm-note-open').click());
await sleep(600);
await page.evaluate(() => { document.getElementById('gn-note').value = '在这个群里她只喊甲「姐」。'; });
await page.evaluate(() => document.getElementById('modal-ok').click());
await sleep(1200);
await page.evaluate(() => { const c = document.getElementById('gm-muted'); c.checked = true; });
await page.evaluate(() => document.getElementById('btn-gm-save').click());
await sleep(1400);
const after = await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const cs = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').getAll(); q.onsuccess = () => r(q.result); });
  db.close();
  const g = cs.find(c => c.id === 'ggrp1');
  const b = cs.find(c => c.id === 'gb');
  return { cfg: (g && g.memberCfg && g.memberCfg.gb) || null, persona: g && g.persona, bPersona: b && b.persona, bHasCfg: !!(b && b.memberCfg) };
});
console.log('   ' + JSON.stringify({ cfg: after.cfg, bHasCfg: after.bHasCfg }));
t('群内补充存进了【群】这条记录', !!after.cfg && after.cfg.note === '在这个群里她只喊甲「姐」。', after.cfg);
t('静音也存下来了', !!after.cfg && after.cfg.muted === true, after.cfg);
t('⚠️ 她自己的角色记录【一个字都没改】（这是这个设计的关键）', after.bHasCfg === false, after.bHasCfg);
t('群人设里带上了那句群内补充', String(after.persona || '').includes('在这个群里：'), String(after.persona || '').slice(0, 160));
t('群人设里注明了她这会儿少开口', String(after.persona || '').includes('不开口'), '');
await page.evaluate(() => document.getElementById('btn-gm-back').click());
await sleep(900);

console.log('=== 9b. 群头像要走裁剪器（用户反馈：选完直接存太敷衍）===');
await page.evaluate(() => { [...document.querySelectorAll('#char-list .char-card')].find(x => x.dataset.id === 'ggrp1').querySelector('[data-edit]').click(); });
await sleep(1000);
const avIn = await page.$('#g-avatar-file');
t('群头像的选图入口在', !!avIn, !!avIn);
if (avIn) {
  await avIn.uploadFile(R + '/tmp/av.png');
  await sleep(1800);
  const cropOn = await page.evaluate(() => {
    const v = document.getElementById('view-crop');
    return { active: !!(v && v.classList.contains('active')), zoom: !!document.getElementById('crop-zoom'), ok: !!document.getElementById('btn-crop-ok') };
  });
  console.log('   ' + JSON.stringify(cropOn));
  t('选完图进的是【裁剪/预览】页（能挪位置、能缩放）', cropOn.active === true && cropOn.zoom && cropOn.ok, cropOn);
  await page.evaluate(() => document.getElementById('btn-crop-ok').click());
  await sleep(2200);
  const avSaved = await page.evaluate(async () => {
    const o = indexedDB.open('ai-companion');
    const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
    const g = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').get('ggrp1'); q.onsuccess = () => r(q.result); });
    db.close();
    return g && String(g.avatar || '').slice(0, 30);
  });
  t('裁剪结果存进了群记录', String(avSaved || '').startsWith('data:image'), avSaved);
  t('裁剪完回到的是群设置页（不是废弃的弹窗）',
    await page.evaluate(() => document.getElementById('view-group').classList.contains('active')), '');
}

console.log('=== 9c. 群级的「他是谁」（用户反馈：各自的设定容易打架）===');
await page.evaluate(() => { [...document.querySelectorAll('#char-list .char-card')].find(x => x.dataset.id === 'ggrp1').querySelector('[data-edit]').click(); });
await sleep(1000);
t('「在她们眼里，他是谁」有输入框了', await page.evaluate(() => !!document.getElementById('g-he')), '');
await page.evaluate(() => { document.getElementById('g-he').value = '他是常来的老客，三个人都认识他。'; });
await page.evaluate(() => document.getElementById('btn-group-save').click());
await sleep(1400);
const heOut = await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const g = await new Promise(r2 => { const q = db.transaction('characters').objectStore('characters').get('ggrp1'); q.onsuccess = () => r2(q.result); });
  db.close();
  return g && { he: g.heNote, persona: g.persona };
});
console.log('   ' + JSON.stringify({ he: heOut && heOut.he }));
t('存进了群记录', !!heOut && heOut.he === '他是常来的老客，三个人都认识他。', heOut && heOut.he);
t('进了群人设，而且标明【优先于】她们各自的说法', String((heOut && heOut.persona) || '').includes('在她们眼里，他是谁')
  && String((heOut && heOut.persona) || '').includes('优先于'), String((heOut && heOut.persona) || '').slice(-160));

console.log('=== 9d. 这一幕几个人开口：抽 1/2/3 人，抽到 1 人就用"只写她一个人"那套 ===');
// Math.random 换成"带计数的小值"，既能落进想要的档，又不会让 uid() 撞车
await page.evaluate(() => { window.__rnd0 = Math.random; });
const stubRandom = (band) => page.evaluate((b) => {
  let n = 0;
  Math.random = () => { n++; return b + (n % 97) / 100000; };
}, band);
const sceneSys = () => sysOf().filter(x => x.includes('这一幕怎么写') || x.includes('这一轮你演谁')).join(' | ');
// ⚠️ 第 9 节把乙设成了"少开口"，而少开口的人不进这一幕的池子 ——
//    live 只有 2 个人的话，抽到 3 个人那条断言永远测不到（上限被池子卡在 2）。
await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const g = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').get('ggrp1'); q.onsuccess = () => r(q.result); });
  if (g && g.memberCfg && g.memberCfg.gb) { delete g.memberCfg.gb.muted; if (!Object.keys(g.memberCfg.gb).length) delete g.memberCfg.gb; }
  await new Promise(r => { const tx = db.transaction('characters', 'readwrite'); tx.objectStore('characters').put(g); tx.oncomplete = r; });
  db.close();
});
await page.reload({ waitUntil: 'networkidle0' }); await sleep(1200);
await page.evaluate(() => { [...document.querySelectorAll('#char-list .char-card')].find(x => x.dataset.id === 'ggrp1').click(); });
await sleep(1000);
await page.evaluate(() => { [...document.querySelectorAll('#char-list .char-card')].find(x => x.dataset.id === 'ggrp1').querySelector('[data-edit]').click(); });
// ⚠️ renderGroupSettings 是【异步】的（里面要读记忆和世界书），它会把 g-len 按库里的值重写一遍 ——
//    改早了会被它覆盖，于是"明明设成 mid，实际还是 short"（第一版就栽在这儿）。
await sleep(1600);
const lenOk = await page.evaluate(() => {
  const n = document.getElementById('g-narr'); if (n) n.checked = true;
  const c = document.getElementById('g-len'); if (c) c.value = 'mid';
  return (document.getElementById('g-len') || {}).value;
});
t('篇幅先切成中档（这一幕人数上限跟着它走）', lenOk === 'mid', lenOk);
await page.evaluate(() => document.getElementById('btn-group-save').click());
await sleep(1200);
for (const [band, want, note] of [[0.05, 1, '抽到 1 个人'], [0.45, 2, '抽到 2 个人'], [0.95, 3, '抽到 3 个人']]) {
  await stubRandom(band);
  await send('这一幕几个人');
  const sys2 = sceneSys();
  if (want === 1) {
    t(note + ' → 换成「这一轮你演谁」那套', sys2.includes('这一轮你演谁') && !sys2.includes('这一幕怎么写'), sys2.slice(0, 80));
    t('并且明确"这一轮只写她一个人的反应"', sys2.includes('一个人的反应'), '');
  } else {
    t(note + ' → 还是「这一幕怎么写」', sys2.includes('这一幕怎么写'), sys2.slice(0, 60));
    t(note + ' → 人数上限写成「最多' + (want === 2 ? '两' : '三') + '个人开口」',
      sys2.includes('最多' + (want === 2 ? '两' : '三') + '个人开口'), sys2.slice(sys2.indexOf('最多'), sys2.indexOf('最多') + 40));
  }
}
await page.evaluate(() => { if (window.__rnd0) Math.random = window.__rnd0; });

console.log('=== 10. 自查抓到的两个 bug ===');
// bug 1：点"在场的人"里被设成"少开口"的那个 —— 界面说轮到她，实际会被静音跳过。
// 用户明确点名的意愿必须压过静音设置。
await page.evaluate(() => {
  const chip = [...document.querySelectorAll('#group-roster .gr-chip')].find(x => x.textContent === '乙');
  if (chip) chip.click();
});
await sleep(900);
replyText = '【乙】我说。';
await send('你说');
let rr = await aiMsgs();
t('点了"少开口"的成员，还是她来说（点名压过静音）', rr.ai[rr.ai.length - 1].s === 'gb', rr.ai.slice(-1));
// 而且点名的有效期只有这一轮：下一轮要回到她后面那个，不能一直钉着
replyText = '【丙】那我。';
await send('嗯');
rr = await aiMsgs();
t('点名只管这一轮（下一轮回到正常轮转，不是一直钉着她）',
  rr.ai[rr.ai.length - 1].s !== 'gb', rr.ai.slice(-1));

// bug 2：把人移出群后，她的群内设置不能留在群里（否则回来时旧设置静默复活）
// v0.4.1.4：移出成员从「弹窗里取消勾选」改成【长按她的头像】→ 确认
await page.evaluate(() => { [...document.querySelectorAll('#char-list .char-card')].find(x => x.dataset.id === 'ggrp1').querySelector('[data-edit]').click(); });
await sleep(1000);
const tileThere = await page.evaluate(() => !!document.querySelector('#g-members [data-gm="gb"]'));
t('成员九宫格里有乙', tileThere, '');
await page.evaluate(() => {
  const el = document.querySelector('#g-members [data-gm="gb"]');
  el.dispatchEvent(new Event('touchstart', { bubbles: true }));
});
await sleep(900);
const askShown = await page.evaluate(() => !document.getElementById('modal').classList.contains('hidden'));
t('长按弹出「移出这个群」确认', askShown, '');
await page.evaluate(() => document.getElementById('modal-ok').click());
await sleep(1400);
const pruned = await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const g = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').get('ggrp1'); q.onsuccess = () => r(q.result); });
  db.close();
  return g && { members: g.memberIds, cfgKeys: Object.keys(g.memberCfg || {}) };
});
console.log('   ' + JSON.stringify(pruned));
t('乙被移出群了', !!pruned && !pruned.members.includes('gb'), pruned);
t('她的群内设置也跟着清掉了（不留孤儿）', !!pruned && !pruned.cfgKeys.includes('gb'), pruned);

console.log('');
console.log('JS 错误: ' + (errs.length ? errs.join(' | ') : '无'));
t('无 JS 报错', errs.length === 0, errs.join(' | '));
console.log('');
console.log('通过 ' + pass + ' / 失败 ' + fail);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
