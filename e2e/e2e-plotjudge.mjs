// e2e-plotjudge.mjs —— 0.5.7.1：剧情方向进判断层 / 复读看得见 / 近似去重
//
// 这一套测的都是「用户看得见但回归测不到」的部分：
//   A. move 表加了 push/do（hurt/quit 故意没加）
//   B. 白名单接受新档、拒绝没加的档
//   C. diceBigram 的阈值落在两个簇中间（同一件事 0.625~1，不同的事 0.308~0.444）
//   D. pushCapped 能把「换个说法」的条目并掉（这是 0.5.7.1 之前不自愈的那个 bug）
//   E. stance 三个轴会往 0 回
//   F. psychePrompt 会把 moves 摆给判断层看（中文，不是 ask_back）
//   G. /剧情方向 真的进了判断请求，而且在 ASK 之前
//   H. inj.psy 存了 gl/ur/by（翻「这一轮用了什么」能看到她要什么）

import puppeteer from 'puppeteer-core';
import http from 'http';
import fs from 'fs';
import path from 'path';

const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');
const WWW = R + '/www';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

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
let pass=0, fail=0;
const t=(n,ok,ex='')=>{ if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));} };

await page.goto('http://127.0.0.1:' + port + '/index.html', { waitUntil: 'domcontentloaded' });

console.log('— A. move 表 —');
const A = await page.evaluate(async () => {
  const dir = await import('./js/director.js');
  const psy = await import('./js/psyche.js');
  return {
    moves: dir.MOVES,
    moveName: dir.MOVE_NAME,
    cn: psy.MOVE_CN,
    same: dir.MOVE_NAME === psy.MOVE_CN
  };
});
t('MOVES 里有 push', A.moves.includes('push'));
t('MOVES 里有 do', A.moves.includes('do'));
t('MOVES 里【没有】hurt（这版故意不加）', !A.moves.includes('hurt'));
t('MOVES 里【没有】quit', !A.moves.includes('quit'));
t('push 有中文名', A.moveName.push === '逼到底', String(A.moveName.push));
t('do 有中文名', A.moveName.do === '自己把事办了', String(A.moveName.do));
t('MOVE_NAME 和 MOVE_CN 是同一个对象（单一来源）', A.same === true);

console.log('— B. 判断结果的白名单 —');
const B = await page.evaluate(async () => {
  const dir = await import('./js/director.js');
  const one = (mv) => {
    const d = dir.normalizeDirector({ reading: '他在看我', move: mv, beats: ['停一下'] });
    return d ? d.move : null;
  };
  return { push: one('push'), do: one('do'), hurt: one('hurt'), old: one('ask_back') };
});
t('白名单接受 push', B.push === 'push', String(B.push));
t('白名单接受 do', B.do === 'do', String(B.do));
t('白名单把 hurt 判成空串（不是猜一个相近的）', B.hurt === '', String(B.hurt));
t('老档 ask_back 照旧', B.old === 'ask_back', String(B.old));

console.log('— C. diceBigram —');
const C = await page.evaluate(async () => {
  const psy = await import('./js/psyche.js');
  return {
    secret: psy.diceBigram('是听人说那人骂了主人才去的，没核实过。', '是听人说那人骂了主人才去的，没核实过'),
    grudge: psy.diceBigram('他拿难受当回答，吾再问一句就成了欺负他。', '他这副样子，吾再问一句就成了欺负他。'),
    boundary: psy.diceBigram('别拿抱小孩那套把吾的话糊过去', '别拿难受当回答，把吾问的话糊过去'),
    diff: psy.diceBigram('主人让吾把头处理干净，是嫌这活脏、嫌吾脏。', '主人让吾自己看着办，是嫌这活脏，躲进浴室去了'),
    self: psy.diceBigram('同一句话', '同一句话')
  };
});
t('只差一个标点 = 1', Math.abs(C.secret - 1) < 0.001, String(C.secret));
t('「他拿难受」/「他这副样子」> 0.6（抓得到）', C.grudge > 0.6, String(C.grudge));
t('boundaries 那对 < 0.6（不误伤）', C.boundary < 0.6, String(C.boundary));
t('两条不同 reading < 0.6（不误伤）', C.diff < 0.6, String(C.diff));
t('完全相同的两句 = 1', Math.abs(C.self - 1) < 0.001, String(C.self));

console.log('— D. pushCapped：换个说法的条目要被并掉 —');
const D = await page.evaluate(async () => {
  const psy = await import('./js/psyche.js');
  const run = (secrets) => {
    let p = psy.normalizePsyche({ secrets });
    p = psy.applyPsycheDelta(p, { secret: [{ t: '是听人说那人骂了主人才去的，没核实过' }] }, Date.now());
    return p.secrets.map(x => x.t);
  };
  const bugfix = run([
    { t: '是听人说那人骂了主人才去的，没核实过。', at: 1794389555733 },
    { t: '是听人说那人骂了主人才去的，没核实过', at: 1794389586281 }
  ]);

  const grudge = (() => {
    let p = psy.normalizePsyche({ grudges: [{ t: '他拿难受当回答，吾再问一句就成了欺负他。', at: 1 }] });
    p = psy.applyPsycheDelta(p, { grudge: [{ t: '他这副样子，吾再问一句就成了欺负他。' }] }, Date.now());
    return p.grudges.map(x => x.t);
  })();

  const keep = (() => {
    let p = psy.normalizePsyche({ secrets: [{ t: '动手前没跟主人说一声', at: 1 }] });
    p = psy.applyPsycheDelta(p, { secret: [{ t: '是听人说那人骂了主人才去的，没核实过' }] }, Date.now());
    return p.secrets.map(x => x.t);
  })();

  const cap = (() => {
    let p = psy.normalizePsyche({});
    const items = ['甲甲甲第一件事', '乙乙乙第二件事', '丙丙丙第三件事', '丁丁丁第四件事', '戊戊戊第五件事'];
    for (const it of items) p = psy.applyPsycheDelta(p, { boundary: [{ t: it }] }, Date.now());
    return p.boundaries.length;
  })();

  return { bugfix, grudge, keep, cap, CAP: psy.CAP.secrets };
});
t('「…没核实过。」+「…没核实过」→ 只剩 1 条（0.5.7.1 前是 2 条，永不自愈）', D.bugfix.length === 1, JSON.stringify(D.bugfix));
t('并掉之后保留信息量大的那句', D.bugfix[0] && D.bugfix[0].indexOf('。') === D.bugfix[0].length - 1, D.bugfix[0] || '');
t('「他拿难受」+「他这副样子」→ 只剩 1 条（dice 才抓得到，includes 抓不到）', D.grudge.length === 1, JSON.stringify(D.grudge));
t('不相干的两条都留着', D.keep.length === 2, JSON.stringify(D.keep));
t('超过上限仍然只留 CAP 条', D.cap === D.CAP, String(D.cap) + ' vs ' + D.CAP);

console.log('— D2. 读路径也自愈（老角色升级后不用等下次写入）—');
const D2 = await page.evaluate(async () => {
  const psy = await import('./js/psyche.js');
  const raw = {
    secrets: [
      { t: '是听人说那人骂了主人才去的，没核实过。', at: 1 },
      { t: '是听人说那人骂了主人才去的，没核实过', at: 2 },
      { t: '没核实过那人到底骂没骂。', at: 3 },
      { t: '动手前没跟主人说一声', at: 4 }
    ]
  };
  const got = psy.normalizePsyche(raw).secrets.map(x => x.t);
  return {
    got,
    short: psy.sameThing('血', '手上的血还没干'),
    sameShort: psy.sameThing('血', '血'),
    four: psy.sameThing('手上的血', '手上的血还没干'),
    grudge: psy.sameThing('他拿难受当回答，吾再问一句就成了欺负他。', '他这副样子，吾再问一句就成了欺负他。'),
    // 合并时 at 要取新的（旧的会让 14 天 TTL 提前到期）
    atNew: (() => {
      const n = psy.normalizePsyche({ grudges: [{ t: '同一件事甲', at: 100 }, { t: '同一件事甲。', at: 900 }] });
      return { n: n.grudges.length, at: n.grudges[0] && n.grudges[0].at, t: n.grudges[0] && n.grudges[0].t };
    })(),
    // 合并时旧条目的元数据不能丢（reveal / conf）
    revealKeep: (() => {
      const n = psy.normalizePsyche({ secrets: [
        { t: '我杀过人，没跟他说', at: 1, reveal: '他问起那个头' },
        { t: '我杀过人，没跟他说。', at: 2 }
      ] });
      return { n: n.secrets.length, reveal: n.secrets[0] && n.secrets[0].reveal };
    })(),
    confKeep: (() => {
      const n = psy.normalizePsyche({ beliefs: [
        { t: '他其实在乎我', at: 1, conf: 0.8 },
        { t: '他其实在乎我。', at: 2 }
      ] });
      return { n: n.beliefs.length, conf: n.beliefs[0] && n.beliefs[0].conf };
    })()
  };
});
t('老数据 normalize 一次就把近似两条并掉（4 条 → 3 条）', D2.got.length === 3, JSON.stringify(D2.got));
t('保住的是带句号那条（信息量大）', D2.got[0] === '是听人说那人骂了主人才去的，没核实过。', D2.got[0]);
t('「血」不会吞掉「手上的血还没干」（长度下限）', D2.short === false);
t('短条目一模一样还是算同一件', D2.sameShort === true);
t('四个字以上才走包含判断', D2.four === true);
t('grudges 那对仍然是同一件（dice 层）', D2.grudge === true);
t('合并后 at 取新的那个（不是先到的旧时间）', D2.atNew.at === 900, String(D2.atNew.at));
t('合并后留信息量大的那句（带句号的）', D2.atNew.t === '同一件事甲。', String(D2.atNew.t));
t('合并时保留旧的 reveal（不然后面憋不住就自己说了）',
  D2.revealKeep.n === 1 && D2.revealKeep.reveal === '他问起那个头', JSON.stringify(D2.revealKeep));
t('合并时保留旧的 conf（不然「你比较确信」会变「你自己也没底」）',
  D2.confKeep.n === 1 && D2.confKeep.conf === 0.8, JSON.stringify(D2.confKeep));

console.log('— E. stance 三个轴会往 0 回 —');
const E = await page.evaluate(async () => {
  const psy = await import('./js/psyche.js');
  const t0 = 1000;
  const raw = { updatedAt: t0, stance: { warmth: 5, trust: -5, playfulness: -5, irritation: 2 } };
  const r = psy.decayPsyche(raw, t0 + 90 * 60 * 1000);
  const small = psy.decayPsyche({ updatedAt: t0, stance: { warmth: 0.2, trust: -0.2, playfulness: 0.1, irritation: 0 } }, t0 + 30 * 60 * 1000);
  return { r: r.stance, small: small.stance };
});
t('warmth 5 掉了（不再是上限）', E.r.warmth < 5, String(E.r.warmth));
t('trust -5 往上回了', E.r.trust > -5, String(E.r.trust));
t('playfulness -5 往上回了', E.r.playfulness > -5, String(E.r.playfulness));
t('火气照旧按 0.9 降（老行为没动；每步都 round 到一位，2 → 1.8 → 1.6 → 1.4）', Math.abs(E.r.irritation - 1.4) < 0.01, String(E.r.irritation));
t('绝对值很小的读数直接归零', E.small.warmth === 0 && E.small.trust === 0 && E.small.playfulness === 0,
  JSON.stringify(E.small));

console.log('— F. psychePrompt 把 moves 摆给判断层看 —');
const F = await page.evaluate(async () => {
  const psy = await import('./js/psyche.js');
  const withMv = (moves, opts) => psy.psychePrompt({ moves, mood: { label: '不耐', intensity: 2 }, updatedAt: Date.now() }, opts);
  return {
    one: withMv(['ask_back']),
    four: withMv(['ask_back', 'ask_back', 'ask_back', 'ask_back']),
    mixed: withMv(['act', 'ask_back', 'do']),
    none: withMv([]),
    omit: withMv(['ask_back', 'ask_back', 'ask_back'], { omitMoves: true })
  };
});
t('只有一条动作不出那一行（没信息量）', F.one.indexOf('前几轮') < 0);
t('四条动作会出「前几轮你是这么接的」', F.four.indexOf('前几轮你是这么接的') >= 0);
t('渲染成中文（反问），不是 ask_back', F.four.indexOf('反问') >= 0 && F.four.indexOf('ask_back') < 0);
t('带箭头连成一串', F.mixed.indexOf('只做动作') >= 0 && F.mixed.indexOf('自己把事办了') >= 0 && F.mixed.indexOf('→') >= 0);
t('没动作时整段不出现', F.none.indexOf('前几轮') < 0);
t('正文层传 omitMoves 时不渲染这一行（判断层照旧）', F.omit.indexOf('前几轮') < 0);

console.log('— G. /剧情方向 真的进了判断请求 —');
const G = await page.evaluate(async (plots) => {
  const dir = await import('./js/director.js');
  const hit = [];
  const realFetch = window.fetch.bind(window);
  window.fetch = async (url, opts) => {
    const u = String(url);
    if (u.indexOf('/chat/completions') >= 0) {
      let body = {};
      try { body = JSON.parse((opts && opts.body) || '{}'); } catch (e) {}
      const flat = (body.messages || []).map(m => String(m.content || '')).join(String.fromCharCode(10));
      if (flat.indexOf('# 这一轮先别写正文') >= 0) hit.push(flat);
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"reading":"她在猜","beats":["停一下"]}' } }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return realFetch(url, opts);
  };
  const call = async (plot) => {
    hit.length = 0;
    const out = await dir.runDirector({
      stable: '人设前缀', recent: [], userText: '嗯', psyche: null,
      api: { apiKey: 'k', baseUrl: 'https://api.deepseek.com', model: 'm' },
      plot
    });
    return { flat: hit[0] || '', ok: !!out };
  };
  const withPlot = await call(['她开始怀疑自己是不是做错了']);
  const without = await call([]);
  const two = await call(['他晕过去了', '她不明白他为什么这样']);
  // 带状态的那次：用来验「局面 → 状态 → 指令」的顺序
  hit.length = 0;
  await dir.runDirector({
    stable: '人设前缀', recent: [], userText: '嗯',
    psyche: { mood: { label: '不耐', intensity: 2 }, want: { goal: '问清楚', urgency: 0.8 }, moves: ['ask_back', 'ask_back'], updatedAt: Date.now() },
    api: { apiKey: 'k', baseUrl: 'https://api.deepseek.com', model: 'm' },
    plot: ['她开始怀疑自己是不是做错了']
  });
  const withState = hit[0] || '';
  window.fetch = realFetch;
  return { withPlot, without, two, withState };
}, null);

t('判断请求里出现「# 这一轮的局面」', G.withPlot.flat.indexOf('# 这一轮的局面') >= 0);
t('方向原文在里面', G.withPlot.flat.indexOf('她开始怀疑自己是不是做错了') >= 0);
t('写的是「已经成立的事实」，不是「作者给的走向」', G.withPlot.flat.indexOf('已经成立的事实') >= 0 && G.withPlot.flat.indexOf('他给的走向') < 0);
t('plotBlock 排在 ASK 前面（先定局面，再问怎么理解）',
  G.withPlot.flat.indexOf('# 这一轮的局面') < G.withPlot.flat.indexOf('# 这一轮先别写正文'));
t('判断照常跑成功', G.withPlot.ok === true);
t('没有方向时这段整段不出现（老行为不变）', G.without.flat.indexOf('# 这一轮的局面') < 0);
t('两条方向用分号连起来', G.two.flat.indexOf('他晕过去了') >= 0 && G.two.flat.indexOf('她不明白他为什么这样') >= 0
  && G.two.flat.indexOf('；') >= 0);
t('有状态时：局面排在状态前面（先定这一轮是什么，再说我此刻什么状态）',
  G.withState.indexOf('# 这一轮的局面') >= 0
  && G.withState.indexOf('# 这一轮的局面') < G.withState.indexOf('# 你这会儿的状态'),
  'plot@' + G.withState.indexOf('# 这一轮的局面') + ' state@' + G.withState.indexOf('# 你这会儿的状态'));

console.log('— H. inj.psy 存了 gl/ur/by（翻「这一轮用了什么」要能看到）—');
const appSrc = fs.readFileSync(R + '/www/js/app.js', 'utf8');
t('inj.psy 有 gl（这一轮想干什么）', /gl:\s*_cut\(psyDir\.goal/.test(appSrc));
t('inj.psy 有 ur（多急）', /ur:\s*Number\(psyDir\.urgency\)/.test(appSrc));
t('inj.psy 有 by（卡在哪）', /by:\s*_cut\(psyDir\.blockedBy/.test(appSrc));
t('runDirector 收到了 plot', /plot:\s*_cmds\.filter\(c => c\.k === 'plot'/.test(appSrc));
// 存进 inj 不等于用户看得见 —— 面板不渲染的话，第 0 步等于白做。
t('面板外层条件里有 psy.gl（只给 goal 不给 reading 也要显示）', /if \(psy && \(psy\.rd \|\| psy\.gl/.test(appSrc));
t('面板真的渲染了「这一轮她想」', /if \(psy\.gl\)/.test(appSrc) && appSrc.indexOf('这一轮她想：') >= 0);
t('面板显示 urgency 和 blockedBy', appSrc.indexOf('psy.ur') >= 0 && appSrc.indexOf('psy.by') >= 0);
const i18nSrc = fs.readFileSync(R + '/www/js/i18n.js', 'utf8');
t('i18n 补了三条新文案', i18nSrc.indexOf("'这一轮她想：'") >= 0 && i18nSrc.indexOf("'（很急）'") >= 0 && i18nSrc.indexOf("'但 '") >= 0);

if (errs.length) console.log('\n（页面报错 ' + errs.length + ' 条，仅供参考）\n  ' + errs.slice(0, 3).join('\n  '));
console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close();
server.close();
process.exit(fail ? 1 : 0);
