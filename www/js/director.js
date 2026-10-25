// www/js/director.js —— 每轮先判断，再让她开口（Psyche v1 的判断层，0.5.3.6）
//
// 为什么要有这一层（这是整个 0.5.3.6 的核心假设）：
//   同一套提示词、同一段历史，模型一次性生成时【必须先"有用"】：它要一边写一边
//   找"最合理的回答"。而最合理的回答通常就是客服那套 —— 完整、礼貌、解释到位。
//   不是它不会写潜台词，是它没有一个"先决定不说什么"的环节。
//
//   所以这里插一次【不出正文】的判断调用：让她先想清楚
//   「我怎么理解他这句 → 我这一轮想干什么 → 我决定不说什么」，
//   再把这些交给真正的生成。判断结果本身就是提示词的一部分。
//
// ⚠️ 这一层失败【不能挡住聊天】。网络抖、模型不吐 JSON、返回被截断 ——
//   一律返回 null，走老路径（提示词里不出现内心那一层）。
//   宁可退回"应答器"，也不能让她不回消息。
//
// ⚠️ 与人设前缀共用同一段 system：判断调用和生成调用的人设【逐字相同】，
//   这样 DeepSeek 的前缀缓存能命中，第二趟几乎不花钱、也快。
//   为此判断调用不额外拼人设摘要 —— 摘要会和稳定前缀不一致，缓存全废。
//   （方向文档建议"用人设摘要避免重读几万字"。这里没照做：那几万字本来就在缓存里，
//    为了省几百 token 的输入而让缓存失效，反而更贵。）
//
// ⚠️ 群聊【不跑】这一层（v1）。群里"他"指代不定：红白可能在跟蓝白说话，
//   同一句话对不同成员是不同的刺激，一份 appraisal 会张冠李戴。
//   群聊继续走原来的机制，等单聊这一层稳定了再按成员各跑一次。

import { onceChat } from './api.js';
import { psychePrompt } from './psyche.js';

/** 这一轮的动作类型。它不是给用户看的标签，是给她自己定的调子。 */
export const MOVES = ['answer', 'deflect', 'tease', 'ask_back', 'act', 'silence', 'leave'];
export const MOVE_NAME = {
  answer: '直接答',
  deflect: '绕开',
  tease: '调侃',
  ask_back: '反问',
  act: '只做动作',
  silence: '几乎不接',
  leave: '走开'
};

/** 这一轮的体积。不是档位 —— 档位是用户设的上限，这个是这一轮实际用多少。 */
export const LENGTHS = ['short', 'normal', 'long'];

/** 判断调用的输出上限。JSON 有 400 字就够，给 700 是留思考的余量。 */
const DIRECTOR_MAX_TOKENS = 700;

/** 喂给判断的历史条数。8 条：太少读不出情绪惯性，太多变成重读整段。 */
const RECENT_N = 8;

/**
 * 判断指令。写成"你是她的脑子"，不是"你必须遵守以下规则" ——
 * 规则墙只会拿到合规输出，而合规输出正是这一层要避开的东西。
 *
 * ⚠️ 用数组拼而不是模板串：里面的 JSON 样例有很多引号和括号，
 *    写成模板串容易被后续改动带进来的反引号打断，没有必要冒这个险。
 */
const ASK = [
  '# 这一轮先别写正文',
  '',
  '你现在不是她，是她的脑子。她这一轮怎么听你那句话、想干什么、决定不说哪句 —— 先想清楚。',
  '',
  '只回一段 JSON，不要解释、不要 markdown 围栏：',
  '',
  '{',
  '  "reading": "他怎么理解他这句话（一句，具体到这句，不要通稿）",',
  '  "confidence": 0.5,',
  '  "sting": "被戳中的地方；没有就空串",',
  '  "inner": "她这一轮心里最想说的那一句（第一人称，一句话，不超过 60 字）；想不出就空串",',
  '  "goal": "这一轮她想达成什么（一句）",',
  '  "urgency": 0.5,',
  '  "blockedBy": "她想做但拉不下脸的地方；没有就空串",',
  '  "mood": { "label": "平静/愉快/不耐/难受/生气/紧张/心虚/倦/兴奋/闷 里挑一个", "intensity": 0, "cause": "为什么（短）" },',
  '  "stance": { "warmth": 0, "trust": 0, "irritation": 0, "playfulness": 0 },',
  '  "withhold": ["她决定不说出口的一句（最多三条）"],',
  '  "secret": ["她瞒着、这一轮也不打算说的事（最多两条）；没有就空数组"],',
  '  "selfEvent": ["她自己这两天的事，跟他没关系（最多两条）；没有就空数组"],',
  '  "boundary": ["她这一轮明确不接受的那一套（最多一条）；没有就空数组"],',
  '  "revealSecret": ["这一轮被问住了、她决定说破的那一件（最多一条）；没有就空数组"],',
  '  "move": "answer / deflect / tease / ask_back / act / silence / leave 里挑一个",',
  '  "beats": ["这一轮的表达节拍，2~3 条；写怎么演，不要写台词"],',
  '  "callback": "历史里可以主动提起来的一件旧事；没有就空串",',
  '  "length": "short / normal / long 里挑一个（这一轮用多少体积）",',
  '  "risk": "over_explain / service_tone / repeat / ooc 里挑一个最该防的；没有就空串"',
  '}',
  '',
  '几条要求：',
  '- reading 允许是错的。人不总是听懂了才反应 —— 拿不准就把 confidence 写低一点，别硬编成"他很关心我"。',
  '- withhold 是她这一轮【故意不说的】。一条都想不出来，说明你想得太正面了。',
  '- beats 写她这一轮怎么演（先做什么、卡在哪、尾巴怎么收），不是剧情大纲，也不是台词。',
  '- mood.intensity 是 0~5；stance 四个数是【这一轮的变化量】，-5~5，没变就写 0。',
  '- length 只影响这一条多大：short = 一两个词或者一句；normal = 平时那样；long = 这一轮值得写开。',
  '- secret 是【她明知、但没告诉你】的具体一件事 —— 这是信息差，不是悬念。selfEvent 是她自己生活里的事：跟他无关，也不是"你们之间"的事。',
  '- boundary 是她这一轮不吃的那一套（比如"别拿这种玩笑试探我""别替我安排"）。踩上去她会真的不高兴，不用哄好。',
  '- revealSecret 只能从 secret 里挑一件：他这一轮真的问到了、或者她自己想赌一把，才填。',
  '- 不要为了显得有内容而编细节。想不出就留空。'
].join('\n');

/** 围栏记号单独拼：这里是三个反引号，直接写进源码容易和模板串打架。 */
const FENCE = String.fromCharCode(96, 96, 96);
const FENCE_RE = new RegExp(FENCE + '(?:json)?\\s*([\\s\\S]*?)' + FENCE, 'i');

/** 从模型输出里抠出 JSON 对象。围栏、前后废话、尾逗号、中文引号都认。 */
export function parseDirector(text) {
  let s = String(text == null ? '' : text).trim();
  if (!s) return null;
  const fence = s.match(FENCE_RE);
  if (fence) s = fence[1].trim();
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  // 尾逗号 / 中文引号：模型偶尔写出来。不修的话整段判断作废。
  s = s.replace(/,\s*([}\]])/g, '$1').replace(/[\u201c\u201d]/g, '"');
  try {
    const o = JSON.parse(s);
    // 只认对象：模型偶尔吐一个数组（[{"move":...}]），数组进 normalizeDirector 只会变成空判断，
    // 不如在这里就认成失败 —— 调用方看到 null 才知道这一轮退回老路径。
    return (o && typeof o === 'object' && !Array.isArray(o)) ? o : null;
  } catch {
    return null;
  }
}

function cut(v, n) {
  const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) : s;
}
function num(v, lo, hi, def = 0) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(lo, Math.min(hi, n));
}

/**
 * 把解析出来的原始 JSON 归一成"能进提示词、也能落库"的形状。
 *
 * 白名单是硬的：move 不在 MOVES 里就是空串（不是猜一个相近的）。
 * 猜错会让提示词说"这一轮绕开"，而她本来要直接答 —— 比没有这一层更糟。
 */
export function normalizeDirector(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const beats = (Array.isArray(raw.beats) ? raw.beats : [])
    .map(b => cut(typeof b === 'string' ? b : (b && (b.t || b.text)), 60))
    .filter(Boolean).slice(0, 4);
  const withhold = (Array.isArray(raw.withhold) ? raw.withhold : [])
    .map(w => cut(typeof w === 'string' ? w : (w && (w.t || w.text)), 60))
    .filter(Boolean).slice(0, 3);
  // 信息差 / 她自己 / 底线：三样都限条数。堆多了她这一轮就变成"心里装着事的人偶"，
  // 一开口全是伏笔 —— 而真人大部分时候什么都没瞒、什么也没发生。
  const txt = (x) => cut(typeof x === 'string' ? x : (x && (x.t || x.text)), 60);
  const secret = (Array.isArray(raw.secret) ? raw.secret : []).map(txt).filter(Boolean).slice(0, 2);
  const selfEvent = (Array.isArray(raw.selfEvent) ? raw.selfEvent : []).map(txt).filter(Boolean).slice(0, 2);
  const boundary = (Array.isArray(raw.boundary) ? raw.boundary : []).map(txt).filter(Boolean).slice(0, 1);
  const revealSecret = (Array.isArray(raw.revealSecret) ? raw.revealSecret : []).map(txt).filter(Boolean).slice(0, 1);
  const move = MOVES.includes(raw.move) ? raw.move : '';
  const length = LENGTHS.includes(raw.length) ? raw.length : 'normal';
  const risk = ['over_explain', 'service_tone', 'repeat', 'ooc'].includes(raw.risk) ? raw.risk : '';
  const mood = raw.mood && typeof raw.mood === 'object' ? raw.mood : {};
  const st = raw.stance && typeof raw.stance === 'object' ? raw.stance : {};
  const out = {
    reading: cut(raw.reading, 80),
    confidence: num(raw.confidence, 0, 1, 0.5),
    sting: cut(raw.sting, 60),
    inner: cut(raw.inner, 60),
    goal: cut(raw.goal, 60),
    urgency: num(raw.urgency, 0, 1, 0),
    blockedBy: cut(raw.blockedBy, 60),
    stance: {
      warmth: num(st.warmth, -5, 5, 0),
      trust: num(st.trust, -5, 5, 0),
      irritation: num(st.irritation, -5, 5, 0),
      playfulness: num(st.playfulness, -5, 5, 0)
    },
    withhold,
    move,
    beats,
    callback: cut(raw.callback, 60),
    secret,
    selfEvent,
    boundary,
    revealSecret,
    length,
    risk
  };
  if (mood.label || mood.intensity != null || mood.cause) {
    out.mood = {
      label: cut(mood.label, 8),
      intensity: num(mood.intensity, 0, 5, null),
      cause: cut(mood.cause, 60)
    };
  }
  // 一个字都没有 = 这次判断没有产出，等于失败。不要拿空对象去拼提示词。
  if (!out.reading && !out.goal && !out.beats.length && !out.withhold.length && !out.inner
    && !out.secret.length && !out.selfEvent.length && !out.boundary.length) return null;
  return out;
}

/**
 * 从判断结果推导出要写进 psyche 的增量。
 *
 * ⚠️ 方向文档让模型同时输出顶层 stance/goal 和 stateDelta，两份同一件事。
 *   这里改成只让模型写一份，增量在这边推导 —— 同一件事写两遍必然出现
 *   两处矛盾，解析时还得挑一个，那是给自己造 bug。
 */
export function directorDelta(d) {
  if (!d) return null;
  const delta = {
    stance: d.stance || {},
    want: { goal: d.goal || '', urgency: d.urgency || 0, blockedBy: d.blockedBy || '' },
    withheld: d.withhold || [],
    move: d.move || ''
  };
  if (d.mood) delta.mood = d.mood;
  // 气到一定程度就记一笔"还没消的" —— 下一轮 decay 之后它还在，
  // 这才是"上一轮恼火、这一轮不会立刻好"的载体。
  const irr = Number((d.stance || {}).irritation) || 0;
  if (irr >= 2 && d.sting) delta.grudge = [{ t: d.sting }];
  // 信息差 / 她自己 / 底线：判断层顺手记下的三样，直接落进 psyche（applyPsycheDelta 认这些键）。
  // 只传非空的 —— 空数组传下去等于每轮清一次，她攒不住任何东西。
  if (Array.isArray(d.secret) && d.secret.length) delta.secret = d.secret;
  if (Array.isArray(d.selfEvent) && d.selfEvent.length) delta.selfEvent = d.selfEvent;
  if (Array.isArray(d.boundary) && d.boundary.length) delta.boundary = d.boundary;
  if (Array.isArray(d.revealSecret) && d.revealSecret.length) delta.revealSecret = d.revealSecret;

  // 关系增量：慢变量，从这里推一个很小的位移（applyRelation 里还会再 clamp 一次）。
  // ⚠️ 挂在 delta 上而不是返回 {delta, relationDelta} 二元组 —— e2e 和 app.js 都
  //    直接拿返回值的 .grudge 用，改形状会连带炸掉一整片调用点。
  const w = Number((d.stance || {}).warmth) || 0;
  const t = Number((d.stance || {}).trust) || 0;
  const rel = {
    warmth: num(w * 0.1, -0.15, 0.15, 0),
    trust: num(t * 0.1, -0.15, 0.15, 0)
  };
  if (w > 0 && t > 0) rel.bond = 0.05;   // 两边都在变好，才算"关系往前挪了一格"
  delta.relationDelta = rel;
  return delta;
}

/**
 * 把判断结果渲染成提示词里的一段。
 *
 * 这一段和 psychePrompt 分开写：psyche 是【存量】（她还记着什么），
 * 这一段是【这一轮现场】（她这会儿怎么听、想干什么）。混在一起会让模型
 * 把"这一轮的反问"也当成一种长期状态。
 */
export function directorPrompt(d) {
  if (!d) return '';
  const L = [];
  if (d.reading) {
    L.push('· 你听到的是：' + d.reading
      + (d.confidence < 0.5 ? '（其实你没听太懂，在猜）' : ''));
  }
  if (d.mood && d.mood.label) {
    L.push('· 你这一轮的情绪：' + d.mood.label
      + (d.mood.intensity ? '（' + d.mood.intensity + '/5）' : '')
      + (d.mood.cause ? ' —— ' + d.mood.cause : ''));
  }
  if (d.sting) L.push('· 被戳到的地方：' + d.sting);
  // 判断层顺手写下的那一句"最想说的"。它比独白短，但独白失败时就是唯一的内心线索。
  if (d.inner) L.push('· 你心里冒出来的那句（别直接说出来）：' + d.inner);
  if (d.goal) {
    L.push('· 这一轮你想：' + d.goal
      + (d.urgency >= 0.6 ? '（很急）' : '')
      + (d.blockedBy ? ' —— 但 ' + d.blockedBy : ''));
  }
  if (d.move) L.push('· 你打算：' + (MOVE_NAME[d.move] || d.move));
  if (d.beats.length) {
    L.push('· 怎么演（按顺序，别写成台词）：');
    for (const b of d.beats) L.push('  - ' + b);
  }
  if (d.callback) L.push('· 可以自己提起的一件旧事：' + d.callback + '（提就提一句，别解释为什么想起）');
  // 体积计划：只给相对说法，绝不给字数 —— 用户明确要求过「不要弄对应挡位固定对应的字数要求」，
  // 而且档位上限在稳定前缀里由 LEN_HINT 管，这里只管「这一轮用掉多少」。
  if (d.length === 'short') L.push('· 这一条比平时更短：能一个词回就别写一句，能一句就别写两句。');
  else if (d.length === 'long') L.push('· 这一条可以写开：多给一点过程和反应 —— 照样不许为了长而凑。');
  if (d.withhold.length) {
    L.push('· **这几句你决定不说出口**：' + d.withhold.map(x => '「' + x + '」').join('、'));
    L.push('  不要说破、不要复述、不要用旁白交代。可以靠动作、停顿、语气泄一点 —— 也可以一点不泄。');
  }
  // 说破这件事只在这一轮有效，所以放在【现场】这一段，不进 psychePrompt：
  // psychePrompt 里那几件是"一直瞒着的"，写在一起会变成两份互相矛盾的说法。
  if (Array.isArray(d.revealSecret) && d.revealSecret.length) {
    L.push('· 这一轮你决定说破：' + d.revealSecret.map(x => '「' + x + '」').join('、'));
    L.push('  说破也要用你自己的说法 —— 别交代来龙去脉，别一次全说完，说完也不必解释。');
  }
  if (d.risk) {
    const R = {
      over_explain: '这一轮最容易犯的毛病是【解释自己】：会想把情绪说明白、把原因讲清楚。别讲，让她把话咽一半。',
      service_tone: '这一轮最容易犯的毛病是【客服腔】：会想总结他的话、给建议、把话说完整。别。',
      repeat: '这一轮最容易犯的毛病是【复读】：会重复上一轮用过的句式和动作。换一个。',
      ooc: '这一轮最容易犯的毛病是【出戏】：会说她不会说的话。守住她的语气和知识范围。'
    };
    if (R[d.risk]) L.push('· ' + R[d.risk]);
  }
  if (!L.length) return '';
  return '# 你这一轮心里在发生什么\n（这是你脑子里的过程，不是要写出来的内容。别把下面任何一条直接说成台词。）\n' + L.join('\n');
}

/** 这一轮要不要跑判断。群聊 v1 不跑（见文件头）。 */
export function shouldDirect(o) {
  if (!o) return false;
  if (!o.apiKey) return false;
  // v2：群聊也跑这一层了。v1 的顾虑（"他"指代不定）靠 roster/target 解决：
  // 判断输入里明确写出"这一轮是 X 在回"，move/mood 就只作用在 X 身上。
  return true;
}

/**
 * 跑一次判断。
 *
 * @param {object} o
 * @param {string} o.stable      人设稳定前缀（与生成那趟逐字相同 —— 为了命中缓存）
 * @param {Array}  o.recent      最近的历史消息 [{role, content}]
 * @param {string} o.userText    他这一轮说的话（续写时为空）
 * @param {object} o.psyche      当前状态（已经 decay 过）
 * @param {{apiKey?: string, baseUrl?: string, provider?: string, model?: string, timeoutMs?: number}} o.api
 * @param {AbortSignal} [o.signal]
 * @param {Array<string>} [o.roster] v2：在场的人名（群聊点名用）
 * @param {string} [o.target]      v2：这一轮该谁说话（群聊里 move/mood 只作用在他身上）
 * @returns {Promise<object|null>} 归一后的判断结果；失败/被中断一律 null
 */
export async function runDirector(o) {
  const { stable, recent, userText, psyche, api, signal, roster, target } = o || {};
  if (!api || !api.apiKey) return null;
  if (signal && signal.aborted) return null;

  const msgs = [];
  if (stable) msgs.push({ role: 'system', content: stable });
  for (const m of (recent || []).slice(-RECENT_N)) {
    const c = String(m && m.content || '').trim();
    if (!c) continue;
    msgs.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: c });
  }
  if (userText && String(userText).trim()) msgs.push({ role: 'user', content: String(userText).trim() });
  // 状态块放在指令前面：先让她知道自己现在什么状态，再问"你怎么理解他这句"。
  const psyBlock = psychePrompt(psyche);
  // 群聊：明确"这一轮是谁在回"。没有这一句，判断会写成"几个人一起的反应"，
  // 而 move/mood 只能作用在一个人身上。
  let whoBlock = '';
  const rl = Array.isArray(roster) ? roster.filter(Boolean) : [];
  if (rl.length) {
    whoBlock = '# 这一轮是谁在回\n'
      + '现在这一轮是 ' + (target || '其中一个人') + ' 在回。'
      + '在场：' + rl.join('、') + '。\n'
      + '（下面的 move 和 mood 只作用在 ' + (target || '这个人') + ' 身上 —— 其他人这一轮只是旁听。）\n\n';
  }
  msgs.push({ role: 'system', content: (psyBlock ? psyBlock + '\n\n' : '') + whoBlock + ASK });

  let out = '';
  try {
    out = await onceChat({
      apiKey: api.apiKey,
      baseUrl: api.baseUrl,
      provider: api.provider,
      model: api.model,
      messages: msgs,
      // 低温：这一步要的是判断，不是发挥。同一个场景两次跑出两个相反的理解，会很割裂。
      temperature: 0.3,
      maxTokens: DIRECTOR_MAX_TOKENS,
      // 关思考：这是"给一段文本、只输出 JSON"的活，打开思考会把 700 上限烧穿
      // （api.js onceChat 头部的注释记着实测：content 空串、JSON 全在 reasoning_content）。
      noThink: true,
      // 判断是用来帮忙的，不是用来卡人的：20 秒拿不到就退回老路径。
      // （onceChat 默认 90 秒 —— 手机上遇到慢网会让用户盯着转圈，
      //   这个代价比「这一轮没有内心戏」大得多。）
      timeoutMs: Number(api.timeoutMs) || 20000
    });
  } catch (err) {
    console.warn('[director] 判断失败，这一轮退回老路径：' + ((err && err.message) || err));
    return null;
  }
  const raw = parseDirector(out);
  if (!raw) {
    console.warn('[director] 输出不是 JSON，这一轮退回老路径：' + String(out).slice(0, 120));
    return null;
  }
  return normalizeDirector(raw);
}
