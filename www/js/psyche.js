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
  moves: 6
};

/** 单条文本的字符上限。超了截断，不报错 —— 提示词里一条气事写 200 字没有意义。 */
const TEXT_MAX = 60;

/** 情绪强度 / 关系读数的范围。stance 用 -5..5，mood.intensity 用 0..5。 */
const CLAMP = { mood: [0, 5], stance: [-5, 5] };

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

/** 截断 + 压空白。模型给的文本可以直接用，但长度必须由我们定。 */
function cut(v, n = TEXT_MAX) {
  const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) : s;
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
    if (out.some(y => y.t === s)) continue;   // 同一句只说一次，重复的没有信息量
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
    updatedAt: Number(raw.updatedAt) || 0
  };
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
  }
  return p;
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
  const i = findItem(list, item.t);
  if (i >= 0) { list[i] = { ...list[i], ...item }; return; }   // 同一件事不叠加，只更新
  list.push(item);
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
    || q.openLoops.length || q.withheld.length || q.grudges.length || q.beliefs.length);
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
      : (p.stance.warmth >= 3 ? '。这会儿你对他是有好感的，别端着' : '');
    L.push('· 对他的读数：' + sl + extra);
  }
  if (p.want.goal) {
    L.push('· 你这会儿想要的：' + p.want.goal
      + (p.want.urgency >= 0.6 ? '（很急）' : '')
      + (p.want.blockedBy ? ' —— 但 ' + p.want.blockedBy : ''));
  }
  const gr = p.grudges.filter(g => g && !g.dead && g.t).map(g => g.t);
  if (gr.length) L.push('· 还没消的：' + gr.join('；'));
  const op = p.openLoops.map(x => x.t).filter(Boolean);
  if (op.length) L.push('· 还没问出口的：' + op.join('；'));
  const bl = p.beliefs.filter(b => b.t).map(b => b.t + (b.conf >= 0.6 ? '（你比较确信）' : '（你自己也没底）'));
  if (bl.length) L.push('· 你心里认定的：' + bl.join('；'));
  const wd = p.withheld.map(x => x.t).filter(Boolean);
  if (wd.length) L.push('· 上一轮你咽回去了：' + wd.join('；'));

  if (!L.length) return '';
  return '# 你这会儿的状态\n'
    + '（这些是你私底下的状态，不是要说出口的话 —— 不要自述情绪，也不要把它当成本轮要完成的任务。'
    + '它只决定你怎么听、怎么答、答多少。）\n'
    + L.join('\n');
}
