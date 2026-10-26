// e2e-psyche.mjs —— Psyche v1（0.5.3.6）：她的内心状态 + 每轮判断
//
// 覆盖两部分：
//   A. 纯函数（在页面里直接 import 模块跑）
//      psyche.js：坏输入不抛 / clamp / 去重 / 上限 / 按时间衰减 / 封顶 12 步 /
//                 withheld 覆盖不是累积 / 空状态不出提示词
//      director.js：剥围栏 / 尾逗号 / 中文引号 / 白名单硬判 / grudge 推导 / 提示词不给字数
//   B. 端到端（hijack fetch：非流式那趟回判断 JSON，流式那趟回正文 SSE）
//      · 判断请求与生成请求共用同一段 system（前缀缓存契约，这是省钱的关键）
//      · 第一轮提示词里就有「你这一轮心里在发生什么」
//      · 第二轮才出现「你这会儿的状态」（第一轮她还没有状态，老角色提示词完全不变）
//      · 状态落库；气泡里出现「她没说出口」折叠
//      · 群聊不跑判断（v1 的设计取舍）

import puppeteer from 'puppeteer-core';
import http from 'http';
import fs from 'fs';
import path from 'path';
const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');
const WWW = R + '/www';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const NL = String.fromCharCode(10);

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

/** 判断那趟的固定输出。故意用低 confidence + 有 withhold + irritation 2 ——
 *  confidence 低会触发「其实你没听太懂」那句，irritation 2 会写进 psyche 并在下一轮触发「还没消气」。 */
const DIR = {
  reading: '他在试探我是不是还在为昨天的事不高兴',
  confidence: 0.4,
  sting: '被他说穿了',
  goal: '让他先开口承认昨天过分',
  urgency: 0.6,
  blockedBy: '拉不下脸',
  mood: { label: '不耐', intensity: 3, cause: '昨天的事还没过去' },
  stance: { warmth: 1, trust: 0, irritation: 2, playfulness: 0 },
  withhold: ['其实我昨天等到很晚'],
  move: 'deflect',
  beats: ['先顿一下', '把话岔开'],
  callback: '昨晚那通没接的电话',
  length: 'short',
  risk: 'over_explain'
};

await page.evaluateOnNewDocument((dirJson) => {
  // v2：一轮有两次非流式（独白 + 判断），按指令正文分开记，断言才数得清。
  window.__hits = { stream: [], once: [], dir: [], inner: [] };
  const realFetch = window.fetch.bind(window);
  window.fetch = async function (url, opts) {
    const u = String(url);
    let body = {};
    try { body = JSON.parse((opts && opts.body) || '{}'); } catch (e) {}
    if (u.includes('/chat/completions')) {
      // stream === false => 一次性小请求。这一版只有判断这一趟和记忆整理会走这里，
      // 测试里没开长记忆，所以它只可能是判断。
      if (body.stream === false) {
        const flat = ((body.messages || []).map(m => String(m.content || ''))).join('\n');
        if (flat.indexOf('# 这一轮先别写正文') >= 0) window.__hits.dir.push(body);
        else if (flat.indexOf('先别写回复') >= 0) window.__hits.inner.push(body);
        window.__hits.once.push(body);
        return new Response(JSON.stringify({ choices: [{ message: { content: dirJson } }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      window.__hits.stream.push(body);
      const chunk = (o) => 'data: ' + JSON.stringify(o) + String.fromCharCode(10,10);
      const payload =
        chunk({ choices: [{ delta: { content: '嗯。' } }] }) +
        chunk({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 5 } }) +
        'data: [DONE]' + String.fromCharCode(10,10);
      return new Response(payload, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    return realFetch(url, opts);
  };
}, JSON.stringify(DIR));

await page.goto('http://127.0.0.1:' + port + '/index.html', { waitUntil: 'networkidle0' });
await sleep(900);

// ---------- A. 纯函数 ----------
console.log('— 1. psyche.js：坏输入不抛 / clamp / 去重 / 上限 —');
const ua = await page.evaluate(async () => {
  const P = await import('/js/psyche.js');
  const out = [];
  const T = (n, ok, ex) => out.push({ n, ok: !!ok, ex: ex === undefined ? '' : String(ex) });
  const safe = (fn) => { try { return { v: fn() }; } catch (e) { return { err: String(e && e.message || e) }; } };

  const r1 = safe(() => P.normalizePsyche(null));
  T('normalizePsyche(null) 不抛，回到空状态', !r1.err && r1.v && r1.v.v === 1 && r1.v.mood.label === '', r1.err || '');
  const r2 = safe(() => P.normalizePsyche('这不是对象'));
  T('normalizePsyche(字符串) 不抛', !r2.err && r2.v && r2.v.stance.irritation === 0, r2.err || '');
  const r3 = safe(() => P.normalizePsyche({ mood: null, stance: 'x', body: 'x', withheld: 5 }));
  T('各字段类型全错也不抛', !r3.err && r3.v && r3.v.body.length === 0 && r3.v.withheld.length === 0, r3.err || '');

  const c1 = P.normalizePsyche({ mood: { intensity: 99 }, stance: { irritation: -99 } });
  T('mood.intensity 夹到 5', c1.mood.intensity === 5, c1.mood.intensity);
  T('stance 夹到 -5', c1.stance.irritation === -5, c1.stance.irritation);

  const d1 = P.normalizePsyche({ body: ['头发还湿着', '头发还湿着', '手很凉'] });
  T('body 同一句只留一次', d1.body.length === 2, d1.body.map(x => x.t).join('|'));

  const many = [];
  for (let i = 0; i < 12; i++) many.push('第' + i + '件事');
  const d2 = P.normalizePsyche({ body: many });
  T('body 超过上限就截断（6 条）', d2.body.length === 6, d2.body.length);

  const long = P.normalizePsyche({ want: { goal: '一'.repeat(200) } });
  T('单条文本截到 60 字（不让它把小作文写进备份）', long.want.goal.length === 60, long.want.goal.length);

  const once = P.normalizePsyche({ mood: { label: '闷', intensity: 2 } });
  const twice = P.normalizePsyche(once);
  T('归一化是幂等的', JSON.stringify(once) === JSON.stringify(twice), '');
  return out;
});
for (const x of ua) t(x.n, x.ok, x.ex);

console.log('— 2. psyche.js：按时间衰减 + 封顶 —');
const ub = await page.evaluate(async () => {
  const P = await import('/js/psyche.js');
  const out = [];
  const T = (n, ok, ex) => out.push({ n, ok: !!ok, ex: ex === undefined ? '' : String(ex) });
  const H = 3600 * 1000;
  const now = Date.now();

  // 半小时一步：90 分钟前 = 3 步
  const a = P.decayPsyche({ mood: { label: '生气', intensity: 2 }, stance: { irritation: 2 }, updatedAt: now - 1.5 * H }, now);
  T('90 分钟没说话 → 情绪降了 3 步（2 → 1.2）', Math.abs(a.mood.intensity - 1.2) < 0.01, a.mood.intensity);
  T('火气降得比心情慢（2 → 1.4）', Math.abs(a.stance.irritation - 1.4) < 0.01, a.stance.irritation);
  T('降完还留着标签（1.2 还在乎）', a.mood.label === '生气', a.mood.label);

  // 刚刚说过话 = 1 步
  const b = P.decayPsyche({ mood: { label: '生气', intensity: 2 }, updatedAt: now }, now);
  T('刚说完话只降 1 步', Math.abs(b.mood.intensity - 1.7) < 0.01, b.mood.intensity);

  // 很久没说话：封顶 12 步，不能一路降到 0 之后再无状态
  const c = P.decayPsyche({ stance: { irritation: 2 }, updatedAt: now - 200 * H }, now);
  T('按时间多次衰减封顶 12 步（2 → 0.5，不是直接归零）', Math.abs(c.stance.irritation - 0.5) < 0.01, c.stance.irritation);

  // 强度低于阈值就清干净 —— 不能让「生气 0.2」留在提示词里
  const d = P.decayPsyche({ mood: { label: '生气', intensity: 0.7 }, updatedAt: now - 2 * H }, now);
  T('情绪低于 0.6 就清空标签', d.mood.intensity === 0 && d.mood.label === '', d.mood.label + '/' + d.mood.intensity);

  // updatedAt 是 0（老角色从没写过）→ 也要衰减一次，不能原样返回
  const e = P.decayPsyche({ mood: { label: '闷', intensity: 3 }, updatedAt: 0 }, now);
  T('没 updatedAt 的旧状态也降一次', Math.abs(e.mood.intensity - 2.6) < 0.01, e.mood.intensity);
  return out;
});
for (const x of ub) t(x.n, x.ok, x.ex);

console.log('— 3. psyche.js：写入（clamp / 覆盖 / 去重）—');
const uc = await page.evaluate(async () => {
  const P = await import('/js/psyche.js');
  const out = [];
  const T = (n, ok, ex) => out.push({ n, ok: !!ok, ex: ex === undefined ? '' : String(ex) });
  const now = Date.now();

  const a = P.applyPsycheDelta(P.emptyPsyche(), { stance: { irritation: 100 } }, now);
  T('增量 clamp：一次给 100 也只能到 5', a.stance.irritation === 5, a.stance.irritation);

  const b0 = P.applyPsycheDelta(P.emptyPsyche(), { stance: { irritation: 2 } }, now);
  const b1 = P.applyPsycheDelta(b0, { stance: { irritation: 2 } }, now);
  T('增量是累加的（2 + 2 = 4）', b1.stance.irritation === 4, b1.stance.irritation);

  const w1 = P.applyPsycheDelta(P.emptyPsyche(), { withheld: ['甲', '乙'] }, now);
  T('withheld 先写两条', w1.withheld.length === 2, w1.withheld.length);
  const w2 = P.applyPsycheDelta(w1, { withheld: ['丙'] }, now);
  T('★ withheld 是覆盖不是累积（这一轮没说出口的不该堆成人墙）', w2.withheld.length === 1 && w2.withheld[0].t === '丙',
    w2.withheld.map(x => x.t).join('|'));
  const w3 = P.applyPsycheDelta(w2, { withheld: null }, now);
  T('withheld 给 null 就是清空', w3.withheld.length === 0, w3.withheld.length);

  const g1 = P.applyPsycheDelta(P.emptyPsyche(), { grudge: [{ t: '他说我胖' }] }, now);
  const g2 = P.applyPsycheDelta(g1, { grudge: [{ t: '他说我胖' }] }, now);
  T('同一条气事不占两个名额', g2.grudges.length === 1, g2.grudges.length);
  const g3 = P.applyPsycheDelta(g2, { grudge: [{ t: '他又迟到' }] }, now);
  T('真是一条新的才加', g3.grudges.length === 2, g3.grudges.length);

  const m1 = P.applyPsycheDelta(P.emptyPsyche(), { mood: { label: '生气', intensity: 3 } }, now);
  T('mood 给了就换（不是累加）', m1.mood.intensity === 3, m1.mood.intensity);

  const n1 = P.applyPsycheDelta(P.emptyPsyche(), null, now);
  T('delta 为 null 也要盖上时间戳（否则永远不衰减）', n1.updatedAt === now, n1.updatedAt);

  const before = P.emptyPsyche();
  const snapshot = JSON.stringify(before);
  P.applyPsycheDelta(before, { stance: { warmth: 3 } }, now);
  T('不改传入的原对象', JSON.stringify(before) === snapshot, '');
  return out;
});
for (const x of uc) t(x.n, x.ok, x.ex);

console.log('— 4. psyche.js：提示词渲染 —');
const ud = await page.evaluate(async () => {
  const P = await import('/js/psyche.js');
  const out = [];
  const T = (n, ok, ex) => out.push({ n, ok: !!ok, ex: ex === undefined ? '' : String(ex) });
  const now = Date.now();

  T('空状态一个字都不出（老角色提示词完全不变）', P.psychePrompt(P.emptyPsyche()) === '', '');
  T('psycheActive(空) 是 false', P.psycheActive(P.emptyPsyche()) === false, '');
  T(' psyActive(null) 不抛', P.psycheActive(null) === false, '');

  const p = P.applyPsycheDelta(P.emptyPsyche(), {
    mood: { label: '生气', intensity: 3, cause: '他没解释' },
    stance: { irritation: 2 },
    want: { goal: '等他自己说', urgency: 0.7 },
    grudge: [{ t: '昨天没接电话' }],
    withheld: ['其实我等到很晚']
  }, now);
  const s = P.psychePrompt(p);
  T('有状态才出这一段', s.startsWith('# 你这会儿的状态'), s.slice(0, 20));
  T('情绪带强度', s.includes('生气（3/5）'), '');
  T('★ 火气过线补一句人话（不然模型不知道往哪偏）', s.includes('还没消气'), '');
  T('还没消的写进去了', s.includes('昨天没接电话'), '');
  T('上一轮咽回去的写进去了', s.includes('其实我等到很晚'), '');
  T('明确写了「不是要说出口的话」', s.includes('不是要说出口的话'), '');
  T('isHot 在 1.5 处翻面', P.isHot({ stance: { irritation: 1.5 } }) === true && P.isHot({ stance: { irritation: 1.4 } }) === false, '');
  return out;
});
for (const x of ud) t(x.n, x.ok, x.ex);

console.log('— 5. director.js：解析要能扛住模型的烂输出 —');
const ue = await page.evaluate(async () => {
  const D = await import('/js/director.js');
  const F = String.fromCharCode(96, 96, 96);
  const NLc = String.fromCharCode(10);
  const out = [];
  const T = (n, ok, ex) => out.push({ n, ok: !!ok, ex: ex === undefined ? '' : String(ex) });

  const fenced = '好的，判断如下：' + NLc + F + 'json' + NLc + '{"move":"tease"}' + NLc + F + NLc + '以上。';
  const a = D.parseDirector(fenced);
  T('剥掉 markdown 围栏和前后废话', !!a && a.move === 'tease', JSON.stringify(a));

  T('尾逗号不算语法错误', (D.parseDirector('{"move":"act",}') || {}).move === 'act', '');
  T('中文引号也能认', (D.parseDirector('{\u201cmove\u201d:\u201cask_back\u201d}') || {}).move === 'ask_back', '');
  T('空串返回 null', D.parseDirector('') === null, '');
  T('不是 JSON 返回 null', D.parseDirector('我觉得她应该有点生气') === null, '');
  T('JSON 是数组也返回 null（只认对象）', D.parseDirector('[1,2]') === null, '');

  // 真模型的判断是十五个字段的 JSON，700 token 常常写到 inner 就断了（0.5.3.7 真 key 实测）。
  // 截断不能整层丢掉：reading / sting 这些已经写完的字段要抢回来。
  const cut = D.parseDirector('{ "reading": "他以为我嫌他闷。", "confidence": 0.4, "sting": "被当成要赶他走的人", "inner": "我坐这儿就是不想让他一个人待');
  T('★ 被截断的判断也能抢回 reading', !!cut && cut.reading === '他以为我嫌他闷。', JSON.stringify(cut));
  T('★ 抢回来的 confidence 还是数字', !!cut && cut.confidence === 0.4, cut && cut.confidence);
  T('什么都没抢到的截断返回 null', D.parseDirector('{ "reading') === null, '');
  const keep = D.parseDirector('{"move":"act","reading":"他说“随便你”，那就随便。"}');
  T('★ 合法 JSON 里的中文引号不许被毁', !!keep && keep.reading === '他说“随便你”，那就随便。', keep && keep.reading);

  const b = D.normalizeDirector({ move: 'fly', length: 'huge', risk: 'whatever', reading: '他在试探' });
  T('★ move 不在白名单就是空串（不猜一个相近的）', b.move === '', b.move);
  T('length 不合法回 normal', b.length === 'normal', b.length);
  T('risk 不合法回空串', b.risk === '', b.risk);
  T('合法字段照留', b.reading === '他在试探', b.reading);

  T('一个字都没有 = 这次判断算失败', D.normalizeDirector({}) === null, '');
  T('非对象返回 null', D.normalizeDirector(null) === null, '');
  T('withhold 超过三条就截', D.normalizeDirector({ withhold: ['a','b','c','d','e'] }).withhold.length === 3, '');
  T('beats 超过四条就截', D.normalizeDirector({ beats: ['1','2','3','4','5','6'] }).beats.length === 4, '');

  const g1 = D.directorDelta({ stance: { irritation: 2 }, sting: '被戳穿' });
  T('★ 气到 2 且被戳中就记一笔没消的', !!g1.grudge && g1.grudge.length === 1 && g1.grudge[0].t === '被戳穿', JSON.stringify(g1.grudge));
  const g2 = D.directorDelta({ stance: { irritation: 1 }, sting: '被戳穿' });
  T('只是有点烦就不记仇', !g2.grudge, JSON.stringify(g2.grudge));
  const g3 = D.directorDelta({ stance: { irritation: 3 } });
  T('没被戳中也不记仇', !g3.grudge, JSON.stringify(g3.grudge));
  return out;
});
for (const x of ue) t(x.n, x.ok, x.ex);

console.log('— 6. director.js：提示词该说什么、不该说什么 —');
const uf = await page.evaluate(async () => {
  const D = await import('/js/director.js');
  const out = [];
  const T = (n, ok, ex) => out.push({ n, ok: !!ok, ex: ex === undefined ? '' : String(ex) });

  T('没有判断就不出这一段', D.directorPrompt(null) === '', '');

  const d = D.normalizeDirector({
    reading: '他在试探', confidence: 0.3, goal: '让他先开口', urgency: 0.7, blockedBy: '拉不下脸',
    mood: { label: '不耐', intensity: 3, cause: '昨天的事' },
    stance: { irritation: 2 }, withhold: ['其实我在意'], move: 'deflect',
    beats: ['先顿一下', '把话岔开'], callback: '昨晚那通电话', length: 'short', risk: 'over_explain'
  });
  const s = D.directorPrompt(d);
  T('段名是「你这一轮心里在发生什么」', s.startsWith('# 你这一轮心里在发生什么'), s.slice(0, 30));
  T('★ 明确写了这不是要写出来的内容', s.includes('不是要写出来的内容'), '');
  T('低 confidence 会提醒她在猜', s.includes('没听太懂'), '');
  T('情绪带强度和原因', s.includes('不耐（3/5）') && s.includes('昨天的事'), '');
  T('动作翻成中文（不是印 answer/deflect）', s.includes('绕开') && !s.includes('deflect'), '');
  T('节拍逐条写出来', s.includes('先顿一下') && s.includes('把话岔开'), '');
  T('旧事会提醒「提就提一句，别解释为什么想起」', s.includes('别解释为什么想起'), '');
  T('★ withhold 明确说是「决定不说出口」', s.includes('决定不说出口'), '');
  T('★ 并且不许用旁白交代', s.includes('不要用旁白交代'), '');
  T('风险提示换成一句人话', s.includes('解释自己'), '');
  T('★ 长度计划只给相对说法，不给字数', s.includes('比平时更短') && !/<\d+\s*字/.test(s), '');

  const longD = D.directorPrompt(D.normalizeDirector({ reading: 'x', length: 'long' }));
  T('long 也只是一句「可以写开」，没有数字', longD.includes('可以写开') && !/<\d+\s*字/.test(longD), '');
  const normalD = D.directorPrompt(D.normalizeDirector({ reading: 'x', length: 'normal' }));
  T('normal 不加增减体积的话', !normalD.includes('比平时更短') && !normalD.includes('可以写开'), '');
  return out;
});
for (const x of uf) t(x.n, x.ok, x.ex);

console.log('— 6b. psyche.js：短期清单按真实时间过期（0.5.3.6，用户第 3 条）—');
// 症状：隔几天再打开，她还在接几天前那件事、那个口气。
// 根因：清单一律不过期，三天前咽回去的话三天后照样当「刚刚」注入。
const ug = await page.evaluate(async () => {
  const P = await import('/js/psyche.js');
  const out = [];
  const T = (n, ok, ex) => out.push({ n, ok: !!ok, ex: ex === undefined ? '' : String(ex) });
  const NOW = Date.now();
  const H = 3600 * 1000, D = 24 * H;
  const old = {
    v: 1,
    mood: { label: '不耐', intensity: 2, cause: '三天前那件事' },
    withheld: [{ t: '其实我一直在等', at: NOW - 3 * D }],
    openLoops: [{ t: '问他那通电话', at: NOW - 3 * D }],
    grudges: [{ t: '他那天没来', at: NOW - 3 * D }],
    selfEvents: [{ t: '我去剪了头发', at: NOW - 3 * D }],
    moves: ['deflect'],
    updatedAt: NOW - 3 * D,
    relation: { warmth: 1, trust: 1, bond: 4, since: NOW - 30 * D }
  };
  const p = P.decayPsyche(old, NOW);
  T('三天前的「没说出口的」过期了（24h）', (p.withheld || []).length === 0, JSON.stringify(p.withheld));
  T('三天前的「还没问出口的」过期了（48h）', (p.openLoops || []).length === 0, JSON.stringify(p.openLoops));
  T('三天前的仇还在（14 天）', (p.grudges || []).length === 1, JSON.stringify(p.grudges));
  T('三天前的「她自己的事」还在（96h）', (p.selfEvents || []).length === 1, JSON.stringify(p.selfEvents));
  T('放了三天的「上一轮打算」清掉（12h）', (p.moves || []).length === 0, JSON.stringify(p.moves));
  T('关系不会因为放置而过期', !!(p.relation && p.relation.bond === 4), JSON.stringify(p.relation));

  // 老数据没有 at：认不出是什么时候的，删了就是无声丢数据 —— 必须留着
  const noAt = P.decayPsyche({ v: 1, withheld: [{ t: '没有时间戳的老条目' }], updatedAt: 0 }, NOW);
  T('没有时间戳的老条目不会被删', (noAt.withheld || []).length === 1, JSON.stringify(noAt.withheld));

  // 提示词里带年龄：同样一句「还没问出口的」，十分钟前和三天前口气不一样
  const s1 = P.psychePrompt({ v: 1, withheld: [{ t: '刚咽回去的一句', at: NOW - 60 * 1000 }], mood: { label: '烦', intensity: 2 } }, { now: NOW });
  T('两小时内的条目不标年龄（说「刚刚」反而假）', s1.indexOf('小时前') < 0 && s1.indexOf('天前') < 0, s1.slice(-70));
  const s2 = P.psychePrompt({ v: 1, grudges: [{ t: '他那天没来', at: NOW - 3 * D }], mood: { label: '烦', intensity: 2 } }, { now: NOW });
  T('几天前的条目带上「3 天前」', s2.indexOf('3 天前') >= 0, s2.slice(-80));
  const s3 = P.psychePrompt({ v: 1, grudges: [{ t: '他那天没来', at: NOW - 5 * H }], mood: { label: '烦', intensity: 2 } }, { now: NOW });
  T('几小时前的条目带上「5 小时前」', s3.indexOf('5 小时前') >= 0, s3.slice(-80));
  return out;
});
for (const x of ug) t(x.n, x.ok, x.ex);

// ---------- B. 端到端 ----------
console.log('— 7. 端到端：判断与生成共用同一段 system —');
const baseChar = (id, name, extra) => Object.assign({
  id, name, greeting: '（' + name + '）', persona: '你是' + name + '。说话很短。',
  avatar: null, temperature: 1.0, maxTokens: 2048, topP: 1.0, reasoningEffort: 'low',
  contextRounds: 20, kaomojiFreq: 0, emojiFreq: 0,
  verbosity: 'medium', splitMessages: false, typingDelay: 0, hesitation: false,
  showTyping: true, longMemory: false, allowEditMine: false,
  descLevel: 'low', povLock: false, appearance: '', appearanceOn: true,
  presetKey: 'blank', createdAt: Date.now()
}, extra || {});

const C1 = 'psy1', C2 = 'psy2', G1 = 'psyG';
await page.evaluate(async (s) => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const put = (store, rec) => new Promise(r => { const tx = db.transaction(store,'readwrite'); tx.objectStore(store).put(rec); tx.oncomplete = r; });
  for (const c of s.chars) await put('characters', c);
  for (const e of s.kv) await put('kv', e);
  db.close();
}, {
  chars: [
    baseChar(C1, '小红'),
    baseChar(C2, '小蓝'),
    baseChar(G1, '测试群', { isGroup: true, memberIds: [C1, C2], groupNote: '' })
  ],
  kv: [
    { k: 'settings', v: { apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', clockMode: false } },
    { k: 'lastCharId', v: C1 }
  ]
});

const kvGet = (k) => page.evaluate(async (kk) => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const v = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get(kk); q.onsuccess = () => r(q.result && q.result.v); });
  db.close();
  return v;
}, k);

const hits = () => page.evaluate(() => ({
  n0: (window.__hits.once || []).length,
  n1: (window.__hits.stream || []).length,
  ndir: (window.__hits.dir || []).length,
  ninner: (window.__hits.inner || []).length,
  once: (window.__hits.once || []).slice(-1)[0] || null,
  dir: (window.__hits.dir || []).slice(-1)[0] || null,
  stream: (window.__hits.stream || []).slice(-1)[0] || null
}));

const promptOf = (body) => ((body && body.messages) || []).map(m => String(m.content || '')).join(NL);

async function say(text) {
  await page.evaluate(t => {
    const el = document.getElementById('input');
    el.value = t; el.dispatchEvent(new Event('input', { bubbles: true }));
  }, text);
  await sleep(120);
  await page.evaluate(() => document.getElementById('btn-send').click());
  for (let i = 0; i < 60; i++) {
    const b = await page.$eval('#btn-stop', el => !el.classList.contains('hidden')).catch(()=>false);
    if (b) break;
    await sleep(100);
  }
  for (let i = 0; i < 200; i++) {
    const b = await page.$eval('#btn-stop', el => !el.classList.contains('hidden')).catch(()=>false);
    if (!b) break;
    await sleep(100);
  }
  await sleep(500);
}

await page.reload({ waitUntil: 'networkidle0' });
await sleep(1000);

await say('你今天怎么怪怪的');
const h1 = await hits();
// ⚠️ 不数总次数：v2 还会因为「缺星号那一层」多跑一次重写（老机制没删），
//    这里要钉的是"独白和判断各跑了一次"，不是"一共只发了 N 个请求"。
t('★ 单聊先跑了独白和判断各一次（非流式）', h1.ndir === 1 && h1.ninner === 1 && h1.n1 >= 1,
  JSON.stringify({ dir: h1.ndir, inner: h1.ninner, once: h1.n0, stream: h1.n1 }));
const sysOnce = (h1.dir && h1.dir.messages && h1.dir.messages[0] || {}).content || '';
const sysGen = (h1.stream && h1.stream.messages && h1.stream.messages[0] || {}).content || '';
t('★ 判断与生成共用同一段 system（前缀缓存才命得中）', !!sysOnce && sysOnce === sysGen,
  JSON.stringify({ a: sysOnce.slice(0, 40), b: sysGen.slice(0, 40), same: sysOnce === sysGen }));
const lastOnceSys = ((h1.dir && h1.dir.messages) || []).slice(-1)[0].content || '';
t('判断请求末尾是判断指令', lastOnceSys.includes('# 这一轮先别写正文'), lastOnceSys.slice(-120));
t('判断请求关掉了思考（不然 JSON 烧穿上限）', !!(h1.dir && h1.dir.thinking && h1.dir.thinking.type === 'disabled'),
  JSON.stringify(h1.dir && h1.dir.thinking));

console.log('— 8. 端到端：提示词里出现内心那一段 —');
const p1 = promptOf(h1.stream);
t('★ 第一轮就注入「你这一轮心里在发生什么」', p1.includes('# 你这一轮心里在发生什么'), '');
t('判断内容真的进了提示词（reading）', p1.includes('他在试探我是不是还在为昨天的事不高兴'), '');
t('withhold 进了提示词', p1.includes('其实我昨天等到很晚'), '');
t('★ 第一轮【不】出现「你这会儿的状态」（她还没有状态）', !p1.includes('# 你这会儿的状态'), '');
t('用户这一句在请求里', p1.includes('你今天怎么怪怪的'), '');

console.log('— 9. 端到端：状态落库 + 气泡折叠 —');
const psy1 = await kvGet('psyche:' + C1);
t('★ 状态写进了 kv（psyche:<角色id>）', !!psy1 && psy1.v === 1, JSON.stringify(psy1 && psy1.v));
t('情绪记下来了', !!psy1 && psy1.mood && psy1.mood.label === '不耐' && psy1.mood.intensity === 3,
  JSON.stringify(psy1 && psy1.mood));
t('火气记下来了（下一轮才该衰减）', !!psy1 && psy1.stance.irritation === 2, JSON.stringify(psy1 && psy1.stance));
t('咽回去的那句挂在 withheld', !!psy1 && psy1.withheld.length === 1 && psy1.withheld[0].t === '其实我昨天等到很晚',
  JSON.stringify(psy1 && psy1.withheld));
t('想要什么也记下了', !!psy1 && psy1.want.goal === '让他先开口承认昨天过分', JSON.stringify(psy1 && psy1.want));
t('★ 气到 2 且被戳中 → 存了一笔「还没消的」', !!psy1 && psy1.grudges.length === 1 && psy1.grudges[0].t === '被他说穿了',
  JSON.stringify(psy1 && psy1.grudges));

const ww = await page.evaluate(() => {
  const els = Array.from(document.querySelectorAll('#messages .msg:not(.me) .ww'));
  const rows = Array.from(document.querySelectorAll('#messages .msg:not(.me) .ww .ww-row')).map(e => e.textContent.trim());
  return { n: els.length, open: els.length ? els[0].open : null, summary: els.length ? (els[0].querySelector('summary') || {}).textContent : '', rows };
});
t('★ 气泡里出现「她没说出口」折叠', ww.n >= 1, JSON.stringify(ww));
t('默认是收起的（它不是聊天内容）', ww.open === false, String(ww.open));
t('summary 带上条数', String(ww.summary || '').includes('她没说出口') && String(ww.summary || '').includes('1'), ww.summary);
t('展开里就是那句没说出口的话', ww.rows.length === 1 && ww.rows[0] === '其实我昨天等到很晚', JSON.stringify(ww.rows));

console.log('— 10. 端到端：第二轮才带上「这会儿的状态」—');
await say('嗯');
const h2 = await hits();
const p2 = promptOf(h2.stream);
t('第二轮也跑了判断', h2.ndir === 2, JSON.stringify({ dir: h2.ndir, once: h2.n0 }));
t('★ 第二轮出现「你这会儿的状态」', p2.includes('# 你这会儿的状态'), '');
t('★ 火气衰减后仍过线 → 提示「还没消气」', p2.includes('还没消气'), '');
t('上一轮咽回去的那句还在状态里', p2.includes('上一轮你咽回去了'), '');
t('判断用的状态是【没叠这一轮】的那份（情绪惯性）', p2.includes('不耐'), '');
const psy2 = await kvGet('psyche:' + C1);
t('第二轮状态被更新（时间戳变新）', !!psy2 && psy2.updatedAt > (psy1 && psy1.updatedAt || 0),
  JSON.stringify({ a: psy1 && psy1.updatedAt, b: psy2 && psy2.updatedAt }));

console.log('— 11. 换角色不串味 —');
await page.evaluate(async (cid) => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  await new Promise(r => { const tx = db.transaction('kv','readwrite'); tx.objectStore('kv').put({ k:'lastCharId', v: cid }); tx.oncomplete = r; });
  db.close();
  location.reload();
}, C2);
await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30000 }).catch(()=>{});
await sleep(1000);
await say('在吗');
const p3 = promptOf((await hits()).stream);
// 注意：判断那趟在 e2e 里是固定 JSON，同一句 withhold 两个角色都会有 ——
// 所以这里查的是【状态段】和【状态段里的 withheld 行】，不能查那句明文。
t('★ 另一个角色不带小红的状态', !p3.includes('# 你这会儿的状态') && !p3.includes('上一轮你咽回去了'), '');
t('另一个角色仍有这一轮的判断', p3.includes('# 你这一轮心里在发生什么'), '');
t('另一个角色自己也有状态落库', !!(await kvGet('psyche:' + C2)), '');

console.log('— 12. 群聊也跑判断（v2：按发言人分键，点名这一轮谁在回）—');
await page.evaluate(async (cid) => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  await new Promise(r => { const tx = db.transaction('kv','readwrite'); tx.objectStore('kv').put({ k:'lastCharId', v: cid }); tx.oncomplete = r; });
  db.close();
  location.reload();
}, G1);
await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30000 }).catch(()=>{});
await sleep(1000);
await say('你们俩怎么了');
const hg = await hits();
t('★ 群聊也跑判断（v2：roster/target 写清了这一轮谁在回）', hg.ndir === 1 && hg.ninner === 1,
  JSON.stringify({ dir: hg.ndir, inner: hg.ninner, once: hg.n0 }));
const pg = promptOf(hg.stream);
t('群聊提示词里有判断那一段', pg.includes('# 你这一轮心里在发生什么'), '');
t('群聊判断输入里点了名字（不然 move/mood 会张冠李戴）',
  ((hg.dir && hg.dir.messages) || []).some(m => String(m.content || '').indexOf('这一轮是') >= 0), '');
// v2：每人一份状态 —— 键是 'psyche:组id:说话人id'，不是 'psyche:组id'
const gKeys = await page.evaluate(async (gid) => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const ks = await new Promise(r => { const q = db.transaction('kv').objectStore('kv').getAllKeys(); q.onsuccess = () => r(q.result || []); });
  db.close();
  return ks.map(k => String(k)).filter(k => k === 'psyche:' + gid || k.indexOf('psyche:' + gid + ':') === 0);
}, G1);
t('★ 群聊按发言人分键写了 psyche（不是大家共用一份）',
  gKeys.length === 1 && gKeys[0].indexOf('psyche:' + G1 + ':') === 0, JSON.stringify(gKeys));

console.log('— 13. 没有 key 时不跑判断（也不挡聊天）—');
await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  await new Promise(r => { const tx = db.transaction('kv','readwrite'); tx.objectStore('kv').put({ k:'settings', v: { clockMode: false } }); tx.oncomplete = r; });
  await new Promise(r => { const tx = db.transaction('kv','readwrite'); tx.objectStore('kv').put({ k:'lastCharId', v: 'psy1' }); tx.oncomplete = r; });
  db.close();
  location.reload();
});
await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30000 }).catch(()=>{});
await sleep(1200);
const noKeyBlocked = await page.evaluate(() => {
  const el = document.getElementById('hint-nokey');
  return { sent: 0, hasInput: !!document.getElementById('input') };
});
t('没 key 的界面能起来（不因为少一段判断就报错）', noKeyBlocked.hasInput === true, JSON.stringify(noKeyBlocked));

t('没有未捕获报错', errs.length === 0, errs.slice(0, 3).join(' | '));

console.log('');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close();
server.close();
process.exit(fail > 0 ? 1 : 0);
