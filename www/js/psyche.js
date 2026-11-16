// www/js/psyche.js —— 她的内心状态（Psyche v1，0.5.3.6）
//
// 为什么要有这一层：
//   在这之前，她每轮的"态度"都是从提示词规则和历史里【现算】出来的 ——
//   上一轮被戳痛了，这一轮没有任何地方记着"她还在生气"，于是模型只能
//   重新从语气里猜，猜的结果通常是最安全的那个：配合、理解、解释清楚。
//   那不是人，是应答器。
//
//   这一层做的事很小：把一个跨轮存在的小状态存下来（情绪 / 身体 / 想要什么 /
//   关系读数 / 没消的气 / 没问出口的事），每轮由 Director 更新一次，再注入提示词。
//   她"记着"这件事，才可能"还在气"。
//
// ⚠️ 这一层【不是记忆系统】。分工必须说清，否则两套东西会互相打架：
//   · memory.js / db.js 的 mem  = 档案。发生过什么、他是谁、什么承诺。
//                                 长、累积、按相关度检索、可以过期。
//   · psyche.js（这个文件）     = 读数。此刻她的情绪、关系张力、没消的气。
//                                 短、每轮覆盖、永远全部注入、不进检索。
//   一条"他上次敷衍我，没解释"如果记进 mem，那是事实，但模型只会把它当资料；
//   记进 psyche.grudges，它才会影响这一轮的语气。两边都要，但不要写同一份。
//
// ⚠️ 这一层不碰 DOM、不碰 IndexedDB、不调模型 —— 纯数据变换。
//   写库在 app.js（它知道 charId 和 kv），调模型在 director.js（它知道 apiKey）。
//
// 数据结构刻意小：整个对象序列化后一般 300~800 字节。
// 它会跟着备份进导出文件，所以每个字段都有长度上限（见 CAP），
// 不能让模型随手写一篇小作文把一份备份撑大。

/** 各列表的长度上限。超出丢最旧的 —— 她记不住二十件气事，人也记不住。 */
export const CAP = {
  body: 6,
  openLoops: 8,
  withheld: 4,
  grudges: 4,
  beliefs: 6,
  moves: 6,
  // 信息差 / 她自己 / 底线（活人感 v2）：这三样都是「她自己的东西」——
  // 不在聊天记录里、也不是对他这个人的读数，所以必须存在状态里，
  // 否则每一轮都从零开始：她永远没有瞒着的事，也永远没有跟他无关的生活。
  secrets: 4,
  selfEvents: 5,
  boundaries: 4
};

/** 单条文本的字符上限。超了截断，不报错 —— 提示词里一条气事写 200 字没有意义。 */
const TEXT_MAX = 60;

/** 情绪强度 / 关系读数的范围。stance 用 -5..5，mood.intensity 用 0..5。 */
const CLAMP = { mood: [0, 5], stance: [-5, 5] };

/** relation 的 warmth/trust 范围。和 stance 不同：这两个是"底子"，从 1.0 起步。 */
const REL_CLAMP = [-5, 5];

/** 一轮里 relation 最多能动多少。关系是慢变量 —— 一句话不该让陌生人变生死之交。 */
export const REL_STEP = 0.15;

/**
 * 情绪衰减系数（每轮乘一次）。
 *
 * 为什么是 0.85：文档要求"至少持续 3–5 轮"。
 *   2.0 → 1.70 → 1.45 → 1.23 → 1.05 → 0.89（第 5 轮）
 * 也就是一条 2 度的火气在 5 轮之后还剩 0.9 —— 够她"还没完全消"，
 * 又不至于 10 轮之后还在记仇。1.0 那种不衰减会让一次争吵永远不结束。
 */
const MOOD_DECAY = 0.85;

/** mood.intensity 低于这个就当没事了（0.6 以下在提示词里没有区分度）。 */
const MOOD_FADE = 0.6;

/** 情绪标签。故意用中文短词 —— 它要出现在提示词里，英文会让她改口说英文。 */
export const MOOD_LABELS = ['平静', '愉快', '不耐', '难受', '生气', '紧张', '心虚', '倦', '兴奋', '闷'];

/** 关系读数四个轴的中文名（提示词和 UI 共用一份，别各写一遍）。 */
export const STANCE_NAME = { warmth: '温度', trust: '信任', irritation: '火气', playfulness: '好玩' };

/**
 * 动作类型的中文名。判断层（director.js）和状态提示词（本文件 psychePrompt）共用一份。
 * ⚠️ 单一来源：director.js 的 MOVE_NAME 直接指向这个对象。
 *    两边各写一份的后果是加了新档以后 psychePrompt 那边只会显示英文原文 ——
 *    而这一行恰恰是用来让她看见「自己前几轮在重复」的，显示成 ask_back 就没用了。
 */
export const MOVE_CN = {
  answer: '直接答',
  deflect: '绕开',
  tease: '调侃',
  ask_back: '反问',
  act: '只做动作',
  silence: '几乎不接',
  leave: '走开',
  push: '逼到底',
  do: '自己把事办了'
};

/** 截断 + 压空白。模型给的文本可以直接用，但长度必须由我们定。 */
function cut(v, n = TEXT_MAX) {
  const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) : s;
}

/**
 * 两条短句的字符 bigram 重合度（Dice 系数），0~1。
 *
 * 用来认「同一件事换个说法」。secrets / grudges / boundaries 这三个列表按字面
 * 去重抓不到它们，而 embedding 是 async 且要过原生桥 —— applyPsycheDelta 是同步
 * 纯函数（app.js 直接调），不能改成异步。
 *
 * 实测（布都那份 50 轮备份）：
 *   「…没核实过。」/「…没核实过」               = 1.000
 *   「他拿难受当回答…」/「他这副样子…」         = 0.625  ← 0.6 抓得到
 *   「别拿抱小孩那套…」/「别拿看小孩的…」       = 0.333  ← 0.6 不误伤
 *   两条不同含义的 reading                        = 0.333
 */
export function diceBigram(a, b) {
  const norm = (s) => String(s == null ? '' : s).replace(/[\s，。、；：！？…—"“”'‘’（）()【】\[\]]/g, '');
  const A = norm(a), B = norm(b);
  if (!A || !B) return 0;
  const ma = new Map(), mb = new Map();
  for (let i = 0; i < A.length - 1; i++) { const g = A.slice(i, i + 2); ma.set(g, (ma.get(g) || 0) + 1); }
  for (let i = 0; i < B.length - 1; i++) { const g = B.slice(i, i + 2); mb.set(g, (mb.get(g) || 0) + 1); }
  let inter = 0, tot = 0;
  for (const [g, n] of ma) { tot += n; if (mb.has(g)) inter += Math.min(n, mb.get(g)); }
  for (const [, n] of mb) tot += n;
  return tot ? (2 * inter) / tot : 0;
}

/**
 * 两条记录是不是「同一件事」。三层判据，缺一层就会漏：
 *
 *   ① 一模一样               → 字面相等
 *   ② 一句是另一句的子串     → includes（「…没核实过。」/「…没核实过」）
 *   ③ 换个说法但说的是同一件 → dice > 0.6
 *      grudges 那对就在这一层：「他拿难受当回答，吾再问一句就成了欺负他。」
 *      和「他这副样子，吾再问一句就成了欺负他。」—— 前半不同、后半相同，
 *      includes 两头都不成立（实测 dice 0.625）。
 *
 * 0.6 这条线是实测卡出来的：同一件事 0.625~1.000，不同的事 0.308~0.444。
 *
 * ⚠️ ② 必须带长度下限。列表里可能有「血」「累」这种一两个字的条目，
 *    不加下限的话「血」会吞掉「手上的血还没干」—— 那不是去重，是删信息。
 */
export function sameThing(a, b) {
  const x = String(a == null ? '' : a), y = String(b == null ? '' : b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (y.length >= 4 && x.includes(y)) return true;
  if (x.length >= 4 && y.includes(x)) return true;
  return diceBigram(x, y) > 0.6;
}

/** 夹到区间里。range 用 number[] 而不是元组：CLAMP 里的两项是普通数组字面量。
 * @param {any} v
 * @param {number[]} range
 * @param {any} def
 */
function num(v, range, def = 0) {
  const lo = Number(range[0]), hi = Number(range[1]);
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(lo, Math.min(hi, n));
}

function strList(v, cap) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const x of v) {
    const s = cut(typeof x === 'string' ? x : (x && (x.t || x.text)));
    if (!s) continue;
    // ⚠️ 这里必须是 sameThing，不能只是精确相等。
    //    strList 是【读路径】：normalizePsyche 用它把库里的数据归一化。
    //    只做精确相等的话，老角色升级以后那几条近似条目会原样留着
    //    （「…没核实过。」和「…没核实过」不等），psychePrompt 每轮把几条
    //    同一件事全塞进提示词 —— 要等下次重新提到这件事、触发 pushCapped 才会并掉，
    //    如果她再也不提，就一直挂着。用 sameThing 就是「一读进来就自愈」。
    const hit = out.findIndex(y => sameThing(y.t, s));
    if (hit >= 0) {
      // 和 pushCapped 同一条规则：留信息量大的那句（不是「先到的」），at 取新的。
      // 只做 `continue` 会丢两样东西：
      //   ① 后来的说法更长更具体（「…没核实过，也没问那人到底骂没骂」）时，长句被丢；
      //   ② 后来的条目带着更新的 at，被丢掉以后 grudges 的 14 天 TTL 会提前到期 ——
      //      她最近还在提这件事，档案里却显示它快过期了。
      const cur = out[hit];
      const fresh = makeItem(x, s);
      // ⚠️ 必须从 cur 继承，不能直接把 makeItem 的新对象放回去。
      //    makeItem 只从【新条目】读 at/conf/dead/reveal，而模型每轮通常只给 t ——
      //    直接 out[hit] = fresh 会把旧条目的元数据全冲掉：
      //      · secrets 的 reveal 丢了 → psychePrompt 那句「（除非对方先问起X，否则别主动说）」
      //        整句消失，她会主动把瞒着的事讲出来；
      //      · beliefs 的 conf 丢了 → 原本「（你比较确信）」变成「（你自己也没底）」。
      //    升级时最明显：老角色那份 psyche 一读进来就合并，带 reveal 的秘密全部丢提示。
      //    pushCapped 那边是 { ...list[base], ...item }，本来就不会丢 —— 两条路径必须一致。
      const nx = { ...cur };
      if (fresh.at) nx.at = Math.max(Number(cur.at) || 0, Number(fresh.at));
      if (fresh.conf != null) nx.conf = fresh.conf;
      if (fresh.reveal) nx.reveal = fresh.reveal;
      if (!fresh.dead) { delete nx.dead; delete nx.deadAt; }   // 复活：她还在提这件事
      if (s.length >= String(cur.t).length) nx.t = s;          // 留信息量大的那句
      out[hit] = nx;
      continue;
    }
    out.push(makeItem(x, s));
    if (out.length >= cap) break;
  }
  return out;
}

/** 列表项统一形状。字符串也认 —— 模型有时候给的是裸字符串数组。 */
function makeItem(x, s) {
  const it = { t: s };
  if (x && typeof x === 'object') {
    if (Number.isFinite(Number(x.at))) it.at = Number(x.at);
    if (Number.isFinite(Number(x.conf))) it.conf = num(x.conf, [0, 1], 0.5);
    if (x.dead) it.dead = true;
    // reveal：这件事在什么条件下才肯说。空 = 一直瞒着。
    if (x.reveal) it.reveal = cut(x.reveal, 20);
  }
  return it;
}

/** 一份空状态。所有字段都有默认值 —— 老库、新角色、备份里没这个键，都从这里开始。 */
export function emptyPsyche() {
  return {
    v: 1,
    mood: { label: '', intensity: 0, cause: '' },
    energy: '',
    body: [],
    want: { goal: '', urgency: 0, blockedBy: '' },
    stance: { warmth: 0, trust: 0, irritation: 0, playfulness: 0 },
    openLoops: [],
    withheld: [],
    grudges: [],
    beliefs: [],
    moves: [],
    // v2：她这会儿在做什么 + 关系深度。life 每轮由 deriveLife() 现算（会覆盖），
    // relation 是慢变量：几十轮才动一点，所以和 stance（快变量）分开存。
    life: { activity: '', busy: false, energyNow: 0.7, lastSeenAt: 0 },
    relation: { warmth: 1.0, trust: 1.0, bond: 0, since: 0 },
    // v2：她自己那一部分 —— 瞒着他的事 / 跟他无关的生活 / 底线。
    // 三者都只增不换（说破了才删），因为"每轮重新决定瞒什么"不是人。
    secrets: [],
    selfEvents: [],
    boundaries: [],
    // v2：上一轮她没说出口的那一层（独白原文）。只存不算 —— psychePrompt 不读它、
    // psycheActive 也不看它，所以老角色不会因为多了这个字段就突然换一套提示词。
    lastInner: '',
    updatedAt: 0
  };
}

/**
 * 把任意输入归一成一份合法状态。
 *
 * ⚠️ 它【不抛异常】。这个函数的输入有三个来源：库里的旧数据、模型写的 stateDelta、
 *    导入的备份文件。任何一个写坏了都不该让聊天发不出去 —— 最差的情况是
 *    内心状态归零（等价于这一版之前的行为），而不是整条链路崩掉。
 */
export function normalizePsyche(raw) {
  const base = emptyPsyche();
  if (!raw || typeof raw !== 'object') return base;
  const mood = raw.mood && typeof raw.mood === 'object' ? raw.mood : {};
  const st = raw.stance && typeof raw.stance === 'object' ? raw.stance : {};
  const w = raw.want && typeof raw.want === 'object' ? raw.want : {};
  const life = raw.life && typeof raw.life === 'object' ? raw.life : {};
  const rel = raw.relation && typeof raw.relation === 'object' ? raw.relation : {};
  return {
    v: 1,
    mood: {
      label: cut(mood.label, 8),
      intensity: num(mood.intensity, CLAMP.mood, 0),
      cause: cut(mood.cause)
    },
    energy: cut(raw.energy, 8),
    body: strList(raw.body, CAP.body),
    want: {
      goal: cut(w.goal),
      urgency: num(w.urgency, [0, 1], 0),
      blockedBy: cut(w.blockedBy)
    },
    stance: {
      warmth: num(st.warmth, CLAMP.stance, 0),
      trust: num(st.trust, CLAMP.stance, 0),
      irritation: num(st.irritation, CLAMP.stance, 0),
      playfulness: num(st.playfulness, CLAMP.stance, 0)
    },
    openLoops: strList(raw.openLoops, CAP.openLoops),
    withheld: strList(raw.withheld, CAP.withheld),
    grudges: strList(raw.grudges, CAP.grudges),
    beliefs: strList(raw.beliefs, CAP.beliefs),
    moves: (Array.isArray(raw.moves) ? raw.moves : []).map(m => cut(m, 12)).filter(Boolean).slice(-CAP.moves),
    secrets: strList(raw.secrets, CAP.secrets),
    selfEvents: strList(raw.selfEvents, CAP.selfEvents),
    boundaries: strList(raw.boundaries, CAP.boundaries),
    life: {
      activity: cut(life.activity, 20),
      busy: !!life.busy,
      energyNow: num(life.energyNow, [0, 1], 0.7),
      lastSeenAt: Number(life.lastSeenAt) || 0
    },
    relation: {
      warmth: num(rel.warmth, REL_CLAMP, 1.0),
      trust: num(rel.trust, REL_CLAMP, 1.0),
      bond: num(rel.bond, [0, 99], 0),
      since: Number(rel.since) || 0
    },
    // 独白原文留一份（v2）。400 字够 INNER_ASK 让她一口气说完 3~5 句。
    lastInner: cut(raw.lastInner, 400),
    updatedAt: Number(raw.updatedAt) || 0
  };
}

// —— 短期记忆的保质期（0.5.3.6，用户 m02892 第 3 条）——
//
// 症状：隔了几天再打开，她还在说「上一次那件事」「还没问出口的」。
// 根因：psyche 里原来【只有情绪会衰减，清单一律不过期】——
//   三天前咽回去的那句话，三天后照样被当成「刚刚」注入进提示词。
//
// 判据只用条目自己的 at（写进去的时间戳）：
//   · 没有 at 的老数据【不删】—— 老库认不出它是什么时候的，删了就是无声丢数据。
//   · 情绪 / 火气仍走 decayPsyche 的按次数衰减（那是另一套语义，别混）。
//   · 关系（relation）、秘密（secrets）、底线（boundaries）、认定（beliefs）不设期限 ——
//     那些本来就是慢变量，过期反而会让她忘掉自己瞒着什么。
//
// 0.5.4.1：到期【封存，不删除】（过时事实标失效而不是丢掉了 —— 见 Zep 的
// temporal knowledge graph：valid_at / invalid_at 两列，被取代的标失效）。
// 理由不是洁癖：
//   · 删了以后她再提起同一件事，状态里是空的，等于这件事从没发生过；
//   · 封存以后 pushCapped 还能靠 findItem 认出来「这事她想过」，一拍就复活（见下）。
// 封存的条目不注入 psychePrompt（和 dead 的仇一样），原文留着给检查器和导出看。
const TTL = {
  withheld: 24 * 3600 * 1000,     // 这一轮没说出口的：过了今天就不算「刚刚」
  openLoops: 48 * 3600 * 1000,    // 还没问出口的事：两天还没问，基本就是没打算问
  selfEvents: 96 * 3600 * 1000,   // 她自己这两天的事：四天
  grudges: 14 * 24 * 3600 * 1000, // 记仇比什么都久，但也不是一辈子
  moves: 12 * 3600 * 1000,        // 上一轮打算怎么应付：只对上一轮有意义
  body: 12 * 3600 * 1000          // 头发还湿着、手上还沾着 —— 半天后就不成立了
};

function pruneByAge(p, now) {
  if (!now) return p;
  const keep = (list, ttl) => (Array.isArray(list) ? list.map(x => {
    const at = Number(x && x.at) || 0;
    if (!at || (now - at) < ttl) return x;
    return { ...x, dead: true, deadAt: now };   // 封存：还在数组里，但不进提示词
  }) : []);
  p.withheld = keep(p.withheld, TTL.withheld);
  p.openLoops = keep(p.openLoops, TTL.openLoops);
  p.selfEvents = keep(p.selfEvents, TTL.selfEvents);
  p.grudges = keep(p.grudges, TTL.grudges);
  const last = Number(p.updatedAt) || 0;
  if (last && (now - last) > TTL.moves) p.moves = [];
  if (last && (now - last) > TTL.body) p.body = [];
  return p;
}

/**
 * 这条是多久以前的。给提示词用 —— 她得知道自己想的是「刚才」还是「前几天」。
 * 不写具体分钟数（模型会对齐到分钟上，反而假），只给量级。
 */
function ageNote(at, now) {
  const a = Number(at) || 0;
  if (!a || !now || now <= a) return '';
  const h = (now - a) / 3600000;
  if (h < 2) return '';
  if (h < 24) return '（' + Math.round(h) + ' 小时前）';
  const d = Math.round(h / 24);
  if (d < 2) return '（昨天）';
  if (d < 30) return '（' + d + ' 天前）';
  return '（一个多月前）';
}

/**
 * 每轮开始前先让她"冷静一点"。
 *
 * 为什么在应用 delta 之前而不是之后：这一轮她刚受的刺激不该当场打折。
 * 顺序是「上一轮的火气先自然降一点 → 这一轮新的 appraisal 再叠上去」。
 */
export function decayPsyche(raw, now = Date.now(), stepMs = 30 * 60 * 1000) {
  const p = normalizePsyche(raw);
  let n = 1;
  const last = Number(p.updatedAt) || 0;
  if (now && last > 0 && now > last) {
    n = Math.max(1, Math.min(12, Math.floor((now - last) / stepMs)));
  }
  for (let i = 0; i < n; i++) {
    const m = p.mood;
    if (m.intensity > 0) {
      m.intensity = Math.round(m.intensity * MOOD_DECAY * 10) / 10;
      if (m.intensity < MOOD_FADE) { m.intensity = 0; m.label = ''; m.cause = ''; }
    }
    // 火气也降，但降得比情绪慢一点（气比心情更黏）。
    p.stance.irritation = Math.round(p.stance.irritation * 0.9 * 10) / 10;
    if (Math.abs(p.stance.irritation) < 0.3) p.stance.irritation = 0;
    // 其余三个轴同样要往 0 回（v0.5.7.1）。
    // 在 0.5.7.1 之前它们只累加、永不回归：applyPsycheDelta 是加法，
    // 而 ASK 里写的是「这一轮的变化量」—— 语义是增量，实现却是存量，
    // 推到 CLAMP 边界（[-5,5]）就永久卡死。布都那份 50 轮里 warmth=5、
    // trust=-5、playfulness=-5 三个轴全顶在边界上，她再也回不来。
    // ⚠️ 0.97/步只治「冷却」，治不了那 50 轮 —— 她是连续 40 轮往负向推
    //    才到底的。真正的问题在「什么让她一直读不出正面」，那是注入层的事。
    for (const k of ['warmth', 'trust', 'playfulness']) {
      p.stance[k] = Math.round(p.stance[k] * 0.97 * 10) / 10;
      if (Math.abs(p.stance[k]) < 0.3) p.stance[k] = 0;
    }
  }
  // 清单一的过期（见上面 TTL）：跨过一段真实时间再回来，她不该还停在三天前那口气上。
  pruneByAge(p, now);
  return p;
}

/**
 * 剥掉 psychePrompt 给 beliefs 追加的尾注（「（你比较确信）」/「（你自己也没底）」）。
 *
 * 为什么需要它：unbelieve 走精确匹配（见下），而模型抄原文时经常把那个括号
 * 一起带上 —— 不剥的话「那杯茶我掺了自己的东西」和「那杯茶我掺了自己的东西（你比较确信）」
 * 就不相等，这个出口会永远对不上，等于没开。
 */
function stripBeliefNote(s) {
  return cut(String(s == null ? '' : s).replace(/（你(?:比较确信|自己也没底)）\s*$/, ''));
}

/** 按文本前缀/包含关系找列表项 —— 模型复述原话时很少一字不差。 */
function findItem(list, text) {
  const t = cut(text);
  if (!t) return -1;
  const exact = list.findIndex(x => x.t === t);
  if (exact >= 0) return exact;
  return list.findIndex(x => x.t.includes(t) || t.includes(x.t));
}

function pushCapped(list, item, cap) {
  if (!item || !item.t) return;
  const it = cut(item.t);
  if (!it) return;
  // ⚠️ 这里不能直接用 findItem：它是 `findIndex`，只返回【第一条】命中的。
  //    「…没核实过。」和「…没核实过」并存时，写入后者会精确命中自己那条就返回，
  //    前者永远没人处理 —— 两条近似条目从此长在列表里，且 normalizePsyche 的
  //    strList 只做精确相等去重（那句带句号，不等），于是【永不自愈】。
  //    实测（真实 4 条 secrets 再写一次同一条）：4 条一字未变。
  //    更糟的是每次重复都在刷新自己那条的 at，让它看起来永远新鲜。
  // 所以：找出整组近似的，留信息量最大的那条当基底，其余一起清掉。
  let base = -1;
  for (let k = 0; k < list.length; k++) {
    const o = list[k];
    if (!o || !o.t) continue;
    if (sameThing(o.t, it)) {
      if (base < 0 || String(o.t).length > String(list[base].t).length) base = k;
    }
  }
  if (base >= 0) {
    // 同一件事不叠加，只更新。原来是【封存】的那条也要复活 ——
    // 她隔了一周又提起同一件事，这就不是过期条目，是这件事还活着。
    const old = String(list[base].t);
    const merged = { ...list[base], ...item, t: old.length > it.length ? old : it };
    if (!item.dead) { delete merged.dead; delete merged.deadAt; }
    if (item.at) merged.at = item.at;
    list[base] = merged;
    // 从后往前删，不影响 base 之前的下标，也不用重算 base。
    for (let k = list.length - 1; k >= 0; k--) {
      if (k === base) continue;
      const o = list[k];
      if (!o || !o.t) continue;
      if (sameThing(o.t, merged.t)) list.splice(k, 1);
    }
    return;
  }
  list.push({ ...item, t: it });
  while (list.length > cap) list.shift();
}

/**
 * 把 Director 给的 stateDelta 落到状态上。
 *
 * 这是整个 Psyche 唯一的写入口。所有增量都做 clamp 和去重 ——
 * 模型给「irritation: 9」不该让她一辈子在生气，给重复的一条气事不该占两个名额。
 *
 * @returns {object} 新状态（不改原对象）
 */
export function applyPsycheDelta(raw, delta, now = Date.now()) {
  const p = normalizePsyche(raw);
  if (!delta || typeof delta !== 'object') { p.updatedAt = now; return p; }

  // 情绪：给了就换，没给就保持（decay 已经把强度降过了）
  if (delta.mood && typeof delta.mood === 'object') {
    const label = cut(delta.mood.label, 8);
    const intensity = num(delta.mood.intensity, CLAMP.mood, null);
    if (label || intensity != null) {
      if (label) p.mood.label = label;
      if (intensity != null) p.mood.intensity = intensity;
      if (delta.mood.cause != null) p.mood.cause = cut(delta.mood.cause);
    }
  }

  // 关系读数：增量（可以是负数）
  if (delta.stance && typeof delta.stance === 'object') {
    for (const k of ['warmth', 'trust', 'irritation', 'playfulness']) {
      const d = Number(delta.stance[k]);
      if (Number.isFinite(d) && d !== 0) {
        p.stance[k] = num(p.stance[k] + d, CLAMP.stance, 0);
        p.stance[k] = Math.round(p.stance[k] * 10) / 10;
      }
    }
  }

  if (delta.want && typeof delta.want === 'object') {
    if (delta.want.goal != null) p.want.goal = cut(delta.want.goal);
    if (delta.want.urgency != null) p.want.urgency = num(delta.want.urgency, [0, 1], 0);
    if (delta.want.blockedBy != null) p.want.blockedBy = cut(delta.want.blockedBy);
  }
  if (delta.energy != null) p.energy = cut(delta.energy, 8);

  // 身体状态：只增不减（她会一直湿着头发直到洗过），但满了就顶掉最旧的
  for (const b of strList(delta.body, CAP.body)) pushCapped(p.body, b, CAP.body);

  // 没说完的话：这一轮给的【覆盖】上一轮的 —— 它天然是"这一轮没说出口的"，
  // 不是终身清单。留到最后会变成一整墙旧台词，反而稀释当前这一条。
  if (Array.isArray(delta.withheld)) {
    p.withheld = strList(delta.withheld, CAP.withheld).map(x => ({ ...x, at: x.at || now }));
  } else if (delta.withheld === null) {
    p.withheld = [];
  }

  for (const l of strList(delta.openLoops, CAP.openLoops)) pushCapped(p.openLoops, { ...l, at: l.at || now }, CAP.openLoops);
  for (const c of (Array.isArray(delta.closeLoop) ? delta.closeLoop : [])) {
    const i = findItem(p.openLoops, c);
    if (i >= 0) p.openLoops.splice(i, 1);   // 关掉就是关掉 —— 她不会同时"还悬着"和"已经问过"
  }

  for (const g of strList(delta.grudge, CAP.grudges)) pushCapped(p.grudges, { ...g, at: g.at || now }, CAP.grudges);
  for (const h of (Array.isArray(delta.healGrudge) ? delta.healGrudge : [])) {
    const i = findItem(p.grudges, h);
    if (i >= 0) p.grudges.splice(i, 1);
  }

  for (const b of strList(delta.belief, CAP.beliefs)) pushCapped(p.beliefs, { ...b, conf: b.conf == null ? 0.5 : b.conf }, CAP.beliefs);
  // 想通了 / 被推翻了（0.5.7.2）。
  //
  // 为什么必须有这个口：beliefs 原来【纯只增】—— secrets 还有 revealSecret 能删，
  // 而「认定」这两字一旦写进去就永远在 psychePrompt 里，每轮都被当成"她确信的事实"。
  // 后果不是理论上的：她给自己编一个理由（"那杯茶我掺了自己的东西"），
  // 之后每次对话都绕着它走，用户在世界书、记忆、聊天原文里都找不到它，也删不掉。
  // 那句「（你比较确信）」还会让判断层把它当成前提继续推理 —— 自我强化，绕不出去。
  // 现在判断层自己可以撤回一条（模型偶尔真会想通），用户也能在「她心里的账」里删。
  //
  // ⚠️ 匹配必须【精确】，不能用上面的 findItem。它是双向 includes 且没有长度下限
  //    （那 4 字门槛在 sameThing 里，不在它这里），模型写 unbelieve: ["那杯茶"]
  //    就会把「那杯茶我掺了自己的东西」一起抹掉 —— 「她心里的账」面板已经避开了这个坑，
  //    这条路径也得避开。
  //    宁可漏删，不可错删：模型要撤回某一条时有原文可抄（psychePrompt 把整张清单
  //    都列给它了），抄不准说明它其实不是在撤回那一条。
  //    不再认定 ≠ 这事没发生过：secrets / 聊天记录都不动，这一条只是离开 beliefs。
  for (const b of (Array.isArray(delta.unbelieve) ? delta.unbelieve : [])) {
    const want = stripBeliefNote(b);
    if (!want) continue;
    const i = p.beliefs.findIndex(x => x && stripBeliefNote(x.t) === want);
    if (i >= 0) p.beliefs.splice(i, 1);
  }

  // 信息差 / 她自己 / 底线：只增不换。
  // 覆盖式写法（像 withheld 那样每轮换掉）会让"她瞒着什么"每一轮重掷一次骰子，
  // 于是她永远瞒不住同一件事三轮 —— 而隐瞒这件事的全部意义就是它一直在那儿。
  for (const s of strList(delta.secret, CAP.secrets)) pushCapped(p.secrets, { ...s, at: s.at || now }, CAP.secrets);
  for (const r of (Array.isArray(delta.revealSecret) ? delta.revealSecret : [])) {
    const i = findItem(p.secrets, r);
    if (i >= 0) p.secrets.splice(i, 1);   // 说破了就不再是秘密（但也不会变成"没发生过"）
  }
  for (const e of strList(delta.selfEvent, CAP.selfEvents)) pushCapped(p.selfEvents, { ...e, at: e.at || now }, CAP.selfEvents);
  for (const b of strList(delta.boundary, CAP.boundaries)) pushCapped(p.boundaries, { ...b, at: b.at || now }, CAP.boundaries);

  if (delta.move) {
    const mv = cut(delta.move, 12);
    if (mv) { p.moves.push(mv); while (p.moves.length > CAP.moves) p.moves.shift(); }
  }

  p.updatedAt = now;
  return p;
}

/** 这个状态有没有实质内容。全空 = 提示词里一个字都不出现（老角色提示词完全不变）。 */
export function psycheActive(p) {
  if (!p) return false;
  const q = normalizePsyche(p);
  return !!(q.mood.label || q.mood.intensity > 0 || q.energy || q.body.length
    || q.want.goal || q.stance.warmth || q.stance.trust || q.stance.irritation || q.stance.playfulness
    || q.openLoops.length || q.withheld.length || q.grudges.length || q.beliefs.length
    || q.secrets.length || q.selfEvents.length || q.boundaries.length);
}

/** 火气到这一档就算"还在气头上" —— 好几个地方要问这一个问题，别各写一遍。 */
export const HOT_IRRITATION = 1.5;
export function isHot(p) {
  const q = normalizePsyche(p);
  return q.stance.irritation >= HOT_IRRITATION;
}

function stanceLine(s) {
  const bits = [];
  for (const k of ['warmth', 'trust', 'irritation', 'playfulness']) {
    const v = s[k];
    if (!v) continue;
    bits.push(STANCE_NAME[k] + (v > 0 ? '+' : '') + v);
  }
  return bits.join(' / ');
}

/**
 * 把状态渲染成提示词里的一段。
 *
 * 写作原则（这几条踩过）：
 *   · 用【第二人称、当下时】描述她的状态，不用"角色感到……"这种旁白口吻 ——
 *     旁白口吻会被模型当成"要写进正文的描写"，于是她开口就自述情绪。
 *   · 数字只在括号里给，而且【不解释】。写"火气 2/5"是为了让它有个量级，
 *     写"火气 2 表示你相当不高兴"就是在教它背规则。
 *   · 明确写"别说出来"。没有这一句，状态块会被当成新的写作要求，变成
 *     「我有点生气」这种自陈。
 *
 * @returns {string} 空串 = 没有可写的内容
 */
export function psychePrompt(raw, opts = {}) {
  const p = normalizePsyche(raw);
  if (!psycheActive(p)) return '';
  // 用现在的时间给每条标个年龄：同样一句「还没问出口的」，
  // 是十分钟前还是三天前，她该说出来的口气完全不一样（用户 m02892 第 3 条）。
  const now = Number(opts && opts.now) || Date.now();
  const L = [];
  const moodTxt = p.mood.label
    ? p.mood.label + (p.mood.intensity ? '（' + p.mood.intensity + '/5）' : '')
      + (p.mood.cause ? ' —— ' + p.mood.cause : '')
    : '';
  if (moodTxt) L.push('· 情绪：' + moodTxt);
  if (p.energy) L.push('· 身上：' + p.energy);
  const body = p.body.filter(b => b && !b.dead).map(b => b.t);
  if (body.length) L.push('· 身体：' + body.join('、'));
  const sl = stanceLine(p.stance);
  if (sl) {
    // 读数超过阈值时补一句人话 —— 光给数字，模型不知道该往哪偏。
    const extra = p.stance.irritation >= HOT_IRRITATION
      ? '。你还没消气，别急着翻篇，也别主动示好'
      : (p.stance.warmth >= 3 ? '。这会儿你对对方是有好感的，别端着' : '');
    L.push('· 对对方的读数：' + sl + extra);
  }
  if (p.want.goal) {
    L.push('· 你这会儿想要的：' + p.want.goal
      + (p.want.urgency >= 0.6 ? '（很急）' : '')
      + (p.want.blockedBy ? ' —— 但 ' + p.want.blockedBy : ''));
  }
  // 前几轮她实际是怎么接的（v0.5.7.1）。
  //
  // moves 一直在写（:402），但从来没有任何一段提示词读过它 —— 判断层每轮都是
  // 从零开始「我这一轮想干什么」，它不知道同一个动作已经连着用了四遍。
  // 布都那份 50 轮里 #30–#36 四连 ask_back，每轮的 beats 还都是「问完就停」——
  // 不是模型想复读，是它看不到自己在复读。
  //
  // ⚠️ 只摆事实，不加「该换了」的暗示：#42–#49 那八轮全 act 是在推进
  //    （接住 → 扶上床 → 没扶稳 → 探鼻息），带了引导她反而会打断那一段。
  // ⚠️ 至少两条才显示：只做过一个动作的一轮，这句没有信息量，还占提示词。
  // ⚠️ opts.omitMoves（v0.5.7.1）：正文那一趟不渲染这一行。
  //    正文层已经能看见那几轮的原文，再给一句概括，它可能为了「不复读」而
  //    打断自己的节奏 —— #42–#49 那八轮 act 正在推进时最怕这个。
  //    判断层照旧渲染：它看不到具体历史里的重复，只有这一行能让它看见。
  const mvs = opts.omitMoves ? [] : (Array.isArray(p.moves) ? p.moves : []).filter(Boolean).slice(-5);
  if (mvs.length >= 2) {
    L.push('· 前几轮你是这么接的：' + mvs.map(m => MOVE_CN[m] || m).join(' → '));
  }
  const gr = p.grudges.filter(g => g && !g.dead && g.t).map(g => g.t + ageNote(g.at, now));
  if (gr.length) L.push('· 还没消的：' + gr.join('；'));
  const op = p.openLoops.filter(x => x && x.t && !x.dead).map(x => x.t + ageNote(x.at, now)).filter(Boolean);
  if (op.length) L.push('· 还没问出口的：' + op.join('；'));
  const bl = p.beliefs.filter(b => b && b.t && !b.dead).map(b => b.t + (b.conf >= 0.6 ? '（你比较确信）' : '（你自己也没底）'));
  if (bl.length) L.push('· 你心里认定的：' + bl.join('；'));
  // 信息差（活人感 v2）：她瞒着的事。这里必须写「别主动交代」——
  // 只要列出来不约束，模型会把它当成"待揭示的剧情"顺手讲掉，隐瞒就消失了。
  const sc = p.secrets.filter(x => x && x.t && !x.dead)
    .map(x => x.t + ageNote(x.at, now) + (x.reveal ? '（除非对方先问起' + x.reveal + '，否则别主动说）' : ''));
  if (sc.length) L.push('· 你瞒着对方的：' + sc.join('；'));
  // 她自己的生活（活人感 v2）：跟他没关系的事。人是先有自己的日子，才有他的话。
  // 不给"所以要不要提"的指令 —— 提不提都行，她不是来汇报的。
  const se = p.selfEvents.filter(x => x && !x.dead).map(x => (x && x.t) ? x.t + ageNote(x.at, now) : '').filter(Boolean);
  if (se.length) L.push('· 你自己这两天：' + se.join('；'));
  // 底线（活人感 v2）：她不吃的那一套。写「不需要假装没事」是为了防她
  // 被踩了还替对方圆场 —— 那是最典型的 AI 式懂事。
  const bd = p.boundaries.filter(x => x && !x.dead).map(x => x && x.t).filter(Boolean);
  if (bd.length) L.push('· 你的底线：' + bd.join('；') + '。踩到你会真的不高兴，不需要假装没事');
  // ⚠️ opts.omitWithheld（v0.5.6.2）：判断那趟不读这一行。
  //    起因：判断层每轮都要再输出一遍 withhold，而这一行刚好就是它上一轮写的 ——
  //    等于把答案摆在它面前让它抄。实测见 director.js 调用处的数据。
  const wd = opts.omitWithheld
    ? []
    : p.withheld.filter(x => x && x.t && !x.dead).map(x => x.t + ageNote(x.at, now)).filter(Boolean);
  if (wd.length) L.push('· 上一轮你咽回去了：' + wd.join('；'));

  if (!L.length) return '';
  return '# 你这会儿的状态\n'
    + '（这些是你私底下的状态，不是要说出口的话 —— 不要自述情绪，也不要把它当成本轮要完成的任务。'
    + '它只决定你怎么听、怎么答、答多少。）\n'
    + L.join('\n');
}

/**
 * 二十四小时里的作息槽。lib：哪个时段她在干嘛、忙不忙、电量多少。
 *
 * ⚠️ 这是「默认作息」，不是她的设定。要按角色不同，就从 ctx 里给 override —— 
 *    不要在这里按角色名写 if。签名留了口子（见 deriveLife 的 ctx.override）。
 *
 * ⚠️ v0.5.5.4：这个表里【不许再出现手机】（原文案四处带「手机」：被窝里刷手机 /
 *    还没开手机 / 手机放一边 / 躺着刷手机）。理由不是"用户不喜欢"，
 *    而是它每轮都被原样写进「你本来在做这件事：X」，等于软件自己往 prompt 里
 *    塞一件她未必有的物件。实测证据：袿姬 5 条「我把手机按灭/塞到床单底下」，
 *    全部落在深夜档；她 115 条世界书里 0 条含「手机」，卡里 0 次 —— 只能是从这里来的。
 *    ⚠️ 换词只换措辞、不动 busy/energy：那两个档位决定回车速度和语气，
 *       改了会把「她这会儿回得慢」也跟着改掉。
 */
const LIFE_SLOTS = [
  { from: 0, to: 6, act: ['睡着了', '半夜醒着，没开灯', '在被窝里躺着，还没睡'], busy: true, energy: 0.2 },
  { from: 7, to: 9, act: ['在洗漱准备出门', '刚醒，还没起', '在吃早饭'], busy: false, energy: 0.6 },
  { from: 10, to: 12, act: ['在工作/上课', '在忙，顾不上别的', '在等人'], busy: true, energy: 0.8 },
  { from: 13, to: 14, act: ['在吃饭', '刚吃完，懒着', '在午休'], busy: false, energy: 0.8 },
  { from: 15, to: 18, act: ['在忙', '在收拾东西', '在外面'], busy: true, energy: 0.8 },
  { from: 19, to: 22, act: ['刚回家', '在洗澡', '躺着，不想动', '在吃晚饭'], busy: false, energy: 0.7 },
  { from: 23, to: 24, act: ['准备睡了', '在关灯', '还没困'], busy: false, energy: 0.4 }
];

/** 某个钟点落在哪个槽。越界一律落到深夜槽（宁可当她睡了，也不当她清醒着敷衍你）。 */
function lifeSlot(hour) {
  const h = Number(hour);
  if (!Number.isFinite(h)) return LIFE_SLOTS[0];
  const hh = ((Math.floor(h) % 24) + 24) % 24;
  for (const s of LIFE_SLOTS) if (hh >= s.from && hh <= s.to) return s;
  return LIFE_SLOTS[0];
}

/**
 * 现算「她这会儿在做什么」。
 *
 * 为什么每轮现算而不是存下来：作息是钟点的函数，存下来就会过夜过期 ——
 * 早上八点她还"在被窝里躺着，还没睡"，就露馅了。只把结果写回 psyche.life 供 UI 显示。
 *
 * @param {any} psyche
 * @param {{now?:number, hour?:number, char?:any, lastMsgAt?:number, rnd?:()=>number, override?:any}} ctx
 * @returns {{activity:string, busy:boolean, energyNow:number, lastSeenAt:number}}
 */
export function deriveLife(psyche, ctx = {}) {
  const now = Number(ctx.now) || Date.now();
  const hour = Number.isFinite(Number(ctx.hour)) ? Number(ctx.hour) : new Date(now).getHours();
  const rnd = typeof ctx.rnd === 'function' ? ctx.rnd : Math.random;
  const ov = ctx.override && typeof ctx.override === 'object' ? ctx.override : null;
  const slot = ov || lifeSlot(hour);
  const act = Array.isArray(slot.act) && slot.act.length ? slot.act : ['在忙'];
  const activity = act[Math.min(act.length - 1, Math.floor(rnd() * act.length))] || act[0];
  let busy = !!slot.busy;
  // 忙不忙是随机的：同一个时段她不会每轮都在忙，也不会每轮都闲着。
  if (busy && rnd() >= 0.5) busy = false;
  const energyNow = num(slot.energy, [0, 1], 0.7);
  return { activity: cut(activity, 20), busy, energyNow, lastSeenAt: now };
}

/**
 * 关系读数的中文表述。
 *
 * 只在够熟的时候才出一句 —— 刚认识就写"你们已经很熟了"是假的，
 * 而且会让模型直接演熟络，跳过该有的生分。
 *
 * @returns {string} 空串 = 还没到该说的时候
 */
export function relationLine(raw) {
  const p = normalizePsyche(raw);
  const bond = p.relation.bond;
  if (bond < 3) return '';
  if (bond < 10) return '你们不算生人，但还没到能随便说话的地步。';
  if (bond < 25) return '你们已经熟到不用客气了。';
  return '你们之间已经没什么好客气的，但也有些话谁都不提。';
}

/**
 * 关系增量落地。和 applyPsycheDelta 分开是因为它动的是慢变量，
 * 而且调用点在 app.js 里独立于 stateDelta（Director 可能没给 stateDelta 但给了关系变化）。
 *
 * @returns {object} 新状态（不改原对象）
 */
export function applyRelation(raw, relationDelta, now = Date.now()) {
  const p = normalizePsyche(raw);
  if (!relationDelta || typeof relationDelta !== 'object') return p;
  for (const k of ['warmth', 'trust']) {
    const d = Number(relationDelta[k]);
    if (Number.isFinite(d) && d !== 0) {
      const step = Math.max(-REL_STEP, Math.min(REL_STEP, d));   // 一轮最多 ±0.15
      // ⚠️ 留两位：步长是 0.15，按一位四舍五入会把 1.0+0.15=1.15 舍成 1.2，
      //    等于一轮走了 0.2 —— 与「一轮最多 ±0.15」的约定对不上。
      p.relation[k] = Math.round(num(p.relation[k] + step, REL_CLAMP, 1.0) * 100) / 100;
    }
  }
  const db = Number(relationDelta.bond);
  if (Number.isFinite(db) && db !== 0) {
    const step = Math.max(-REL_STEP * 2, Math.min(REL_STEP * 2, db));
    p.relation.bond = Math.round(num(p.relation.bond + step, [0, 99], 0) * 100) / 100;
  }
  if (!p.relation.since) p.relation.since = now;
  return p;
}

/**
 * 把「这会儿的生活」写成提示词里的一行。
 * 忙的时候补一句提示：她可能回得慢、回得短 —— 这不是敷衍，是她真的在忙。
 */
export function lifeLine(raw) {
  const p = normalizePsyche(raw);
  const a = p.life.activity;
  if (!a) return '';
  return a + (p.life.busy ? '（这会儿腾不出手，回得慢）' : '');
}

