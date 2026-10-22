// e2e-scenectx.mjs —— 小说模式的「底色」装配（v0.5.2.5）
//
// 这一套针对评审 0.5.2.5 的 P0-4：原来 e2e-scene 的 8b 节用的是
// 【28 字人设 + 1 条世界书 + 1 条记忆】，刚好不触发任何截断 ——
// 挑了不会失败的样本。这里反过来：真实长卡，长到一定会超上限。
//
// 覆盖：
//   1. 纯函数 assembleSceneContext：块级上限 / 按句截 / 超了先丢世界书 / voice+user 不丢
//   2. 真实长卡：人设 / 卡字段 / 对话范例 / 你怎么称呼他 / 关于对方 / 他住的地方
//      全都真的进了正文提示词
//   3. item / belief 两类记忆不再被整类丢掉；scope=scene 只认这一场
//   4. 分支记忆：B 支的场景里不出现 A 支独占的记忆

import puppeteer from 'puppeteer-core';
import http from 'http';
import fs from 'fs';
import path from 'path';
const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');
const WWW = R + '/www';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8' };
const server = http.createServer((req,res) => {
  let q = decodeURIComponent(req.url.split('?')[0]); if (q==='/') q='/index.html';
  const f = path.join(WWW, q);
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

// 一段过得了 checkQuality 的正文（同 e2e-scene）
const PROSE = '雨还在下。她把伞收起来，靠在门边的墙角，水顺着伞骨往下滴，在水泥地上洇出一小片深色。她没有马上开灯，先站在玄关听了一会儿屋里的动静，像在确认什么。「你还没走啊。」她说这句话的时候语气很平，平得有点过了头。桌上摊着那个旧木盒，盒盖开着，里面的东西被挪过位置，边缘留着一道新鲜的划痕。她走过去，手指在盒沿停了停，没有立刻碰。「我本来是要扔的。」她说，「昨天翻出来的时候想，留着也没用。」窗外的雨声忽然大了一阵，把后面那半句话压下去。她低下头笑了一下，笑得很轻，更像是在给自己找台阶。然后她把盒子往你那边推了推，推到桌子中间才收手，指尖在木头上多停了半秒才离开。';
const LOGJSON = '{"events":["她收伞进门"],"cast":["红白"],"change":"盒子到了桌子中间","openThreads":[],"keyLines":["我本来是要扔的。"]}';

await page.evaluateOnNewDocument((LOGJSON_TEXT) => {
  window.__fake = { queue: [], chat: [], once: [] };
  const realFetch = window.fetch.bind(window);
  window.fetch = async function (url, opts) {
    const u = String(url);
    let body = {};
    try { body = JSON.parse((opts && opts.body) || '{}'); } catch (e) {}
    if (u.includes('/chat/completions')) {
      const sys = String(((body.messages || [])[0] || {}).content || '');
      if (body.stream === false) {
        window.__fake.once.push({ kind: 'log', sys });
        return new Response(JSON.stringify({ choices: [{ message: { content: LOGJSON_TEXT } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      const item = window.__fake.queue.shift() || { text: '（没有预置内容）', finish: 'stop' };
      window.__fake.chat.push({ sys, text: item.text });
      const chunk = (o) => 'data: ' + JSON.stringify(o) + String.fromCharCode(10,10);
      const payload = chunk({ choices: [{ delta: { content: item.text } }] })
        + chunk({ choices: [{ delta: {}, finish_reason: item.finish }], usage: { prompt_tokens: 900, completion_tokens: 400 } })
        + 'data: [DONE]' + String.fromCharCode(10,10);
      return new Response(payload, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    return realFetch(url, opts);
  };
}, LOGJSON);

// CI 的 runner 是 en-US，这套要读中文文案 -> 钉住语言。
// 位置必须在 newPage 之后、goto 之前（ci-precheck 的 en-US 伪装插在 newPage 紧跟的下一行）。
await page.evaluateOnNewDocument(() => {
  Object.defineProperty(navigator, 'language', { get: () => 'zh-CN', configurable: true });
  Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh'], configurable: true });
});

// ---------- 真实长卡的素材 ----------
// 人设 950 字，中间埋一句「她不会主动说爱，但会一直等你」——
// 它在 900 字上限附近，正好用来验证「按句截，不切半句」。
const TAIL_SENT = '她不会主动说爱，但会一直等你。';
const personaHead = [];
// 前 8 段 ≈ 610 字，把 TAIL_SENT 顶到 700 字上限附近 —— 那一句必须整句在场
for (let i = 0; i < 8; i++) {
  personaHead.push('第' + (i + 1) + '段：她做事慢，说话更慢，先把手上的东西放下才开口。她记性好，别人顺口说过的一句闲话她能放上几年。她不喜欢解释自己，被问急了就沉默，沉默不是生气，是她还没想好怎么说。');
}
const personaTail = [];
for (let i = 9; i <= 18; i++) {
  personaTail.push('第' + i + '段：她做事慢，说话更慢，先把手上的东西放下才开口。她记性好，别人顺口说过的一句闲话她能放上几年。');
}
const PERSONA = personaHead.join('') + TAIL_SENT + personaTail.join('') + '（后面还有一段：她从来不看别人的手机。）';

const cf = (tag) => {
  const a = [];
  for (let i = 0; i < 4; i++) a.push('【' + tag + (i + 1) + '】这一项是卡里带来的设定，长度和真实长卡差不多，专门用来压上限。');
  return a.join('');
};
const CARD_FIELDS = {
  personality: cf('性格'),
  scenario: cf('场景'),
  systemPrompt: cf('说明'),
  postHistory: cf('记着'),
  mesExample: '{{char}}把烟按在窗台上，没抬头。' + String.fromCharCode(10) + '<START>' + String.fromCharCode(10) + '{{user}}：你还没吃饭。' + String.fromCharCode(10) + '{{char}}：吃了。' + String.fromCharCode(10) + '她把外套往椅背上一搭，转身去洗碗，水声开得很大。'
};

const WB_ENTRIES = [];
for (let i = 0; i < 6; i++) {
  WB_ENTRIES.push({
    id: 'wbsx' + i,
    title: '设定第' + (i + 1) + '条',
    content: (i === 0 ? '这一带的芦苇荡比人高，芦苇荡后面没有电。' : '第' + (i + 1) + '条的内容：' + '这一条也写得够长，长到六条加起来一定超上限，用来逼出「整条丢」的行为。'.repeat(4)) + ' 第' + (i + 1) + '条结尾。',
    on: true,
    pos: 'always'
  });
}

// 关键词型（pos 不是 always）：只有场景卡自己写的字命中才进来。
// 真实卡 39 条世界书全是这一类，一条常驻都没有 —— 上一版小说底色因此整块是空的。
WB_ENTRIES.push({
  id: 'wbsx-keys-1',
  title: '修车铺',
  content: '修车铺后墙漏风，冬天要用旧棉被堵上。暗号：这一条是靠地点命中的。',
  keys: ['修车铺', '铺子'],
  on: true
});
WB_ENTRIES.push({
  id: 'wbsx-keys-2',
  title: '灯塔',
  content: '灯塔相关的设定。暗号：这一条不该出现。',
  keys: ['灯塔'],
  on: true
});

const MEMS = [
  { id: 'sxm1', charId: 'sx1', text: '他手上还戴着那枚旧戒指。', kind: 'item', status: 'active', day: '3' },
  { id: 'sxm2', charId: 'sx1', text: '她以为他从来没看过她写的东西。', kind: 'belief', status: 'active', day: '3' },
  { id: 'sxm3', charId: 'sx1', text: 'A支独有她在河堤上说过那句话。', kind: 'event', status: 'active', day: '4', scope: 'branch', sourceMsgIds: ['m2'] },
  { id: 'sxm4', charId: 'sx1', text: 'B支独有他把扳手递给了她。', kind: 'event', status: 'active', day: '4', scope: 'branch', sourceMsgIds: ['m4'] },
  { id: 'sxm5', charId: 'sx1', text: '别的场次的事不该进这一场。', kind: 'event', status: 'active', day: '4', scope: 'scene', sourceSceneId: 'some-other-scene' },
  { id: 'sxm6', charId: 'sx1', text: '两人最近说话像在试探。', kind: 'relationship', status: 'active', day: '4' },
  { id: 'sxm7', charId: 'sx1', text: '她这几天睡得很少。', kind: 'state', status: 'active', day: '4' },
  { id: 'sxm8', charId: 'sx1', text: '她想把那件事问清楚。', kind: 'goal', status: 'active', day: '4' },
  { id: 'sxm9', charId: 'sx1', text: '她在城郊住过两年。', kind: 'fact', status: 'active', day: '1' },
  { id: 'sxm10', charId: 'sx1', text: '这条是草稿不该进提示词。', kind: 'fact', status: 'draft', day: '4' }
];

const CHAR = {
  id: 'sx1', name: '红白', greeting: '（红白）', persona: PERSONA,
  avatar: null, temperature: 1.0, maxTokens: 2048, topP: 1.0, reasoningEffort: 'low',
  contextRounds: 20, kaomojiFreq: 0, emojiFreq: 0,
  verbosity: 'medium', splitMessages: false, typingDelay: 0, hesitation: false,
  showTyping: true, longMemory: true, allowEditMine: false,
  descLevel: 'low', povLock: false, appearance: '银白长发，总穿深色外套', appearanceOn: true,
  cardFields: CARD_FIELDS,
  userAddress: '阿岩',
  userPerception: '以为他还在跑长途，其实早就辞职了。',
  userKnowledge: '知道他怕黑。',
  userAttitude: '欠他一句话没还。',
  myProfile: '他在城郊开了个修车铺，手上常年有机油味。',
  myEnv: '铺子后面隔出一间小屋，只有一张床和一盏灯。',
  presetKey: 'blank', createdAt: Date.now()
};

async function seed() {
  await page.evaluate(async (S) => {
    const o = indexedDB.open('ai-companion');
    const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
    const put = (store, rec) => new Promise(r => { const tx = db.transaction(store,'readwrite'); tx.objectStore(store).put(rec); tx.oncomplete = r; });
    await put('characters', S.char);
    for (const e of S.kv) await put('kv', e);
    for (const m of S.msgs) await put('messages', m);
    await put('wbSolo', { id: 'wbs1', charId: 'sx1', entries: S.wb });
    for (const m of S.mems) await put('memories', m);
    db.close();
  }, {
    char: CHAR,
    wb: WB_ENTRIES,
    mems: MEMS,
    kv: [
      { k: 'settings', v: { apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', clockMode: false, lang: 'zh', worldbookOn: true, memLimit: 20 } },
      { k: 'lastCharId', v: 'sx1' },
      // 活动叶子钉在 B 支：m1 -> m4。A 支的 m2 / m3 还在库里，但不在线上。
      { k: 'branch:sx1', v: 'm4' }
    ],
    msgs: [
      { id: 'm1', charId: 'sx1', role: 'user', content: '扳手放哪了', ts: 1000, parentId: '' },
      { id: 'm2', charId: 'sx1', role: 'assistant', content: '（A支）在抽屉里。', ts: 2000, parentId: 'm1' },
      { id: 'm3', charId: 'sx1', role: 'user', content: '（A支继续）知道了', ts: 3000, parentId: 'm2' },
      { id: 'm4', charId: 'sx1', role: 'assistant', content: '（B支）给你。', ts: 4000, parentId: 'm1' }
    ]
  });
}

const click = async (sel) => { await page.waitForSelector(sel, { timeout: 15000 }); await page.evaluate(s => { const e = document.querySelector(s); if (e) e.click(); }, sel); };
const clickSoft = async (sel, ms = 8000) => { try { await page.waitForSelector(sel, { timeout: ms }); await page.evaluate(s => { const e = document.querySelector(s); if (e) e.click(); }, sel); return true; } catch (e) { return false; } };
const visible = (sel) => page.evaluate(s => { const e = document.querySelector(s); if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).display !== 'none'; }, sel);

await page.goto('http://127.0.0.1:' + port + '/index.html', { waitUntil: 'networkidle0' });
await seed();
await page.reload({ waitUntil: 'networkidle0' });
await sleep(900);

// ---------- 1. 纯函数：块级装配 ----------
console.log('=== 1. assembleSceneContext ===');
const pure = await page.evaluate(async () => {
  const M = await import('./js/scenectx.js');
  const out = {};
  // ① 按句截：max 落在句子中间时，停在句号后
  out.cut = M.cutAtSentence('第一句大概十二个字。第二句也差不多这么长。第三句相同。', 22);
  // ② 超上限：世界书先被丢，记忆留下。
  //    显式传一个小 cap —— 七个块的默认上限加起来 8450 > 8000，
  //    真实长卡会走到这里；这里用 1200 把它压成必现。
  const big = M.assembleSceneContext({
    self: '我是她。'.repeat(200),
    voice: '她说话很短。',
    user: '- 你叫他阿岩。',
    profile: '他在修车。',
    env: '一条小巷。',
    world: '世界书很长。'.repeat(200),
    mem: '他手上戴着戒指。'
  }, 1200);
  out.big = { keys: (big.dropped || []).map(d => d.key), chars: big.chars, has: { voice: big.text.indexOf('她说话很短') >= 0, user: big.text.indexOf('阿岩') >= 0, mem: big.text.indexOf('戒指') >= 0, world: big.text.indexOf('世界书很长') >= 0 } };
  // ③ 一句都装不下时也不切半句：self 被缩短时仍以句号结尾
  const tiny = M.assembleSceneContext({ self: '短句一。短句二。短句三。', voice: '她也说短句。' }, 40);
  out.tiny = { text: tiny.text, chars: tiny.chars };
  return out;
});
t('按句截停在句号后，不切半句', pure.cut === '第一句大概十二个字。第二句也差不多这么长。', JSON.stringify(pure.cut) + ' len=' + String(pure.cut).length);
t('总长超上限时整条丢世界书', pure.big.keys.indexOf('world') >= 0, JSON.stringify(pure.big.keys));
t('丢块之后总长仍在上限内', pure.big.chars <= 1200, String(pure.big.chars));
t('丢世界书之后「她说话的样子」还在', pure.big.has.voice === true, JSON.stringify(pure.big.has));
t('「你怎么称呼他」还在（永不丢）', pure.big.has.user === true, '');
t('记忆那块也还在（世界书排它前面）', pure.big.has.mem === true, '');

t('极小上限下也不是半句', /[。！？…]$/.test(String(pure.tiny.text).trim().slice(-1)), JSON.stringify(pure.tiny.text));

// ---------- 2. 真实长卡：开一场短戏 ----------
console.log('=== 2. 真实长卡开戏 ===');
await page.evaluate(() => { window.__fake.chat = []; window.__fake.queue = [{ text: '', finish: 'stop' }]; });
await page.evaluate((text) => { window.__fake.queue = [{ text, finish: 'stop' }]; }, PROSE);
await click('#btn-settings');
await sleep(400);
await click('[data-wb-drawer="scene"]');
await sleep(500);
t('开戏弹窗打开了', await visible('#scn-modal'));
await page.evaluate(() => {
  const s = document.getElementById('sc-char');
  if (s) { s.value = 'sx1'; s.dispatchEvent(new Event('change', { bubbles: true })); }
  const p = document.getElementById('sc-place'); if (p) p.value = '修车铺';
  const tm = document.getElementById('sc-time'); if (tm) tm.value = '傍晚';
});
await sleep(300);
await click('#sc-go');
await page.waitForFunction(() => !!document.getElementById('view-read') && document.getElementById('view-read').classList.contains('active'), { timeout: 40000 });
await page.waitForFunction(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const all = await new Promise(r => { const tx = db.transaction('scenes','readonly'); const q = tx.objectStore('scenes').getAll(); q.onsuccess = () => r(q.result || []); });
  db.close();
  return all.length > 0 && all.every(x => x.status !== 'generating');
}, { timeout: 90000 }).catch(() => {});

const sys = await page.evaluate(() => { const c = window.__fake.chat[0]; return c ? String(c.sys) : ''; });
t('真的发出了正文请求', sys.length > 500, 'len=' + sys.length);

// —— 她是谁 ——
t('人设进了提示词', sys.indexOf('她做事慢') >= 0);
t('人设里那句关键的整句在场（5000 字上限附近）', sys.indexOf('她不会主动说爱') >= 0 && sys.indexOf('但会一直等你') >= 0, '半句了');
t('卡里的性格进了提示词', sys.indexOf('【性格1】') >= 0);
t('卡里的场景进了提示词', sys.indexOf('【场景1】') >= 0);
t('卡里的角色说明进了提示词', sys.indexOf('【说明1】') >= 0);
t('卡里的「一直记着的」进了提示词', sys.indexOf('【记着1】') >= 0);

// —— 她说话的样子（v0.5.2.5 新接的一层） ——
t('对话范例进了提示词', sys.indexOf('把烟按在窗台上') >= 0);
t('范例里的模板变量已经展开', sys.indexOf('{{char}}') < 0 && sys.indexOf('{{user}}') < 0, '');
t('范例里的 <START> 分隔符被吃掉', sys.indexOf('<START>') < 0, '');
t('范例注明了「只学怎么说话」', sys.indexOf('只学句长') >= 0, '');

// —— 你 / 对方 / 环境（评审说小说侧一项都没读的三样） ——
t('「你怎么称呼他」进了提示词', sys.indexOf('阿岩') >= 0, '');
t('「她以为他是谁」进了提示词', sys.indexOf('以为他还在跑长途') >= 0, '');
t('「关于对方」进了提示词', sys.indexOf('修车铺，手上常年有机油味') >= 0 || sys.indexOf('手上常年有机油味') >= 0, '');
t('「他住的地方」进了提示词', sys.indexOf('只有一张床和一盏灯') >= 0, '');

// —— 记忆 ——
t('item 类记忆进了（以前整类被丢）', sys.indexOf('那枚旧戒指') >= 0, '');
t('belief 类记忆进了', sys.indexOf('没看过她写的东西') >= 0, '');
t('草稿状态的不进', sys.indexOf('这条是草稿') < 0, '');
t('别的场次的记忆不进', sys.indexOf('别的场次的事') < 0, '');
t('B 支自己的记忆进了', sys.indexOf('B支独有') >= 0, '');
t('A 支独占的记忆没漏进来', sys.indexOf('A支独有') < 0, sys.slice(Math.max(0, sys.indexOf('你们之间')), sys.indexOf('你们之间') + 400));

// —— 世界书：每条要么整条在，要么整条不在 ——
// 拼成半条是最坏情况：模型会拿半句自己往下编，还以为是设定。
const half = [];
for (let i = 1; i <= 6; i++) {
  const head = sys.indexOf('第' + i + '条的内容') >= 0 || (i === 1 && sys.indexOf('芦苇荡后面没有电') >= 0);
  const tail = sys.indexOf('第' + i + '条结尾') >= 0;
  if (head !== tail) half.push(i);
}
t('六条世界书没有一条是半条', half.length === 0, '半条：' + JSON.stringify(half));
t('世界书至少装进了第一条', sys.indexOf('芦苇荡后面没有电') >= 0, '');

// —— 总量与必留块 ——
const ctxSaved = await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const all = await new Promise(r => { const q = db.transaction('scenes','readonly').objectStore('scenes').getAll(); q.onsuccess = () => r(q.result || []); });
  db.close();
  return (all[0] && all[0].context) || '';
});
t('底色快照不超过 8000 字', ctxSaved.length > 0 && ctxSaved.length <= 8000, String(ctxSaved.length));
t('快照里没有半句话的残尾（结尾不是逗号/顿号）', !/[，、；]$/.test(ctxSaved.trim()), JSON.stringify(ctxSaved.slice(-30)));
t('快照里「她说话的样子」那块在', ctxSaved.indexOf('她说话的样子') >= 0, '');
t('快照里「你怎么称呼他」那块在', ctxSaved.indexOf('你怎么称呼他') >= 0, '');
// 关键词型世界书：地点「修车铺」命中 -> 进；「灯塔」没人提 -> 不进
t('场景卡的地点命中关键词世界书', sys.indexOf('这一条是靠地点命中的') >= 0, '地点没带出条目');
t('没被提到的关键词型世界书不进', sys.indexOf('这一条不该出现') < 0, '');

// ---------- 3. 没有未捕获报错 ----------
console.log('=== 3. 控制台 ===');
t('没有未捕获的 pageerror', errs.length === 0, errs.join(' | '));

console.log('');
console.log('通过 ' + pass + ' / 失败 ' + fail);
await browser.close();
server.close();
process.exit(fail > 0 ? 1 : 0);
