// 记忆检索（记忆 OS · 规格 §5）
//
// 这一层回答一个问题：**这一轮到底该把哪几条记忆喂给她，为什么是这几条。**
//
// 为什么单独一个文件：
//   app.js 已经 79 万字节，再往里堆"过滤 + 排序 + 切预算"必然又是一团。
//   这里只有纯函数：进来一个记忆数组和一个当前分支消息 id 集合，出去
//   { used, dropped }。不碰 IndexedDB、不碰 DOM、不调模型 —— 所以能单独测。
//
// used 里每条都带 why（为什么进来），dropped 里每条都带 reason（为什么没进来）。
// dropped 不是日志：它会原样显示在「这一轮用了什么」里，让用户看见被挤掉的记忆，
// 而不是让它们静默消失（规格 §5.3 的硬要求）。

import { memoryDay, memoryLine, MEMORY_STATUS } from './memory.js';

// 记忆在上下文预算里占的份额。从 contextBudget 切，不新增滑杆（规格 §5.3）。
// 20% 是对着"历史 50% / 稳定提示词 25% / 世界书 5%"分完之后的余量取的：
// 记忆再重要也不该挤掉最近几轮对话，那是模型判断语气的主要依据。
export const MEMORY_BUDGET_SHARE = 0.2;

// 默认估算：中文按 0.65 token/字，英文按 0.28。
// app.js 里有更准的 estimateMsgTokens，接线时注入进来覆盖它。
export function defaultMemoryTokens(text) {
  const s = String(text == null ? '' : text);
  let cjk = 0, other = 0;
  for (const ch of s) {
    if (/[\u3400-\u9fff\uf900-\ufaff\u3041-\u30ff]/.test(ch)) cjk++;
    else other++;
  }
  return Math.max(1, Math.ceil(cjk * 0.65 + other * 0.28));
}

// kind 的注入优先级（规格 §5.3）：pinned 之后，goal → relationship → state →
// 最近的 event → 较早的 fact。belief 排在 fact 前面一点：她自己的误解比世界事实
// 更容易说错，宁可不进也别让模型把误解当事实讲。
const KIND_ORDER = { goal: 0, promise: 1, relationship: 1, state: 2, event: 3, item: 4, belief: 5, fact: 6 };
const KIND_WHY = { goal: '她想做但还没做到', promise: '她答应过的事', relationship: '两人关系', state: '当前状态', event: '最近发生的', item: '物品', belief: '她以为的', fact: '较早的事实' };

// 小说模式（v0.5.2.5）单独一套顺序：写一场戏要的是【此刻的张力】，
// 不是编年史。event 排到最后、belief / item 提到前面 ——
// 「她以为他是谁」「他手上还戴着那枚戒指」比「三个月前他们去过哪」更能推动这一场。
// relationship / state 仍然最前：一场戏里的关系与状态就是张力本身。
// goal 不放在最后：她想做但没做到的事，正是这一场最该被推的东西。
const KIND_ORDER_SCENE = { relationship: 0, state: 1, goal: 2, belief: 3, item: 4, event: 5, fact: 6 };

// ---------- 记忆经历化：相关度打分 ----------
//
// 原来 chat 模式完全按 kind 顺序进（goal → relationship → state → event → item →
// belief → fact），同 kind 内按新近。问题不是排序错了，而是它【只能这么排】：
// 她这一轮明明在问「那天那把伞呢」，进来的却是 8 条 goal，因为 goal 永远排最前。
// 固定顺序不是检索，是固定席位。
//
// 现在给每条打一个分（权重取自方案 §记忆检索）：
//   0.35 语义相关 —— 和这一轮他说的话有几个两字重合
//   0.25 情绪强度 —— heat/5（memory.js 里那个 1~5）
//   0.20 未完成   —— open：承诺、没解决的事
//   0.10 新近
//   0.10 关系权重 —— kind=relationship
// pinned 仍然绝对优先（用户手点的，不参与打分）；kind 顺序降级成同分时的次序。
// 小说模式（forScene）不参与打分：写一场戏要的是张力分布，不是对话相关度。
/**
 * 选择性遗忘的天数门槛。
 *
 * 方案 §记忆七类：「核心钉住、琐事模糊、遗忘不是删库」。
 * 45 天是"过了季"的量级 —— 一周前的琐事当事人还记得，两个月前的细节本来就该糊。
 * ⚠️ 只模糊 event（琐事），不模糊 fact：事实一模糊她就会答错
 *    （"你上次说你在哪儿上班"答成别的地方，那是 bug 不是人味）。
 */
export const FOG_DAYS = 45;

/** 模糊行。只留个影子，不给细节 —— 人回忆琐事就是这个形状。 */
function fogLine(text) {
  const t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  const head = t.length > 14 ? t.slice(0, 14) : t;
  return '（记不太清了，大概是：' + head + '……）';
}

export function bigramsOf(s) {
  const t = String(s == null ? '' : s).replace(/[\s\p{P}\p{S}]/gu, '');
  const out = new Set();
  for (let i = 0; i + 1 < t.length; i++) out.add(t.slice(i, i + 2));
  return out;
}

/** 两段文字的两字重合率（以记忆那条为分母）。0~1。 */
export function semanticScore(text, userGrams) {
  if (!userGrams || !userGrams.size) return 0;
  const a = bigramsOf(text);
  if (!a.size) return 0;
  let hit = 0;
  for (const g of a) if (userGrams.has(g)) hit++;
  return hit / a.size;
}

export function heatNorm(m) {
  const n = Number(m && m.heat);
  if (Number.isFinite(n) && n > 0) return Math.max(0, Math.min(5, n)) / 5;
  // 没标 heat 的老记忆：按类型给一个保守值，保证它不会因为「没标」就永远排在最后。
  //
  // ⚠️ 只给 relationship 破格（0.6），event / state 一律 0.2。
  // 原来给 event / state 0.4，代价是所有事件叙述都压过所有计划 ——
  // 「他昨天踢了下凳子」会挤掉「她想搬走」，KIND_ORDER 里 goal 首位就成了摆设。
  // 事件要排前面，让它靠【新近】去赢（event 一般都带 day，rec 自然高），
  // 而不是靠一个猜出来的情绪强度。
  const k = String((m && m.kind) || '');
  if (k === 'relationship') return 0.6;
  return 0.2;
}

export function scoreOf(m, ctx) {
  const sem = semanticScore(m && m.text, ctx.userGrams);
  const heat = heatNorm(m);
  const open = m && m.open === true ? 1 : 0;
  let rec = 0.5;
  if (ctx.nowDay) {
    const d = recency(m);
    // 没有日期的记忆：给中间值，不让它凭空垫底也不让它霸榜
    if (d) rec = 1 / (1 + Math.max(0, ctx.nowDay - d) / 7);
  }
  const rel = String((m && m.kind) || '') === 'relationship' ? 1 : 0;
  return 0.35 * sem + 0.25 * heat + 0.20 * open + 0.10 * rec + 0.10 * rel;
}

function statusReason(m) {
  const st = String((m && m.status) || '');
  if (st === MEMORY_STATUS.SUPERSEDED) return '已被取代';
  if (st === MEMORY_STATUS.EXPIRED) return '已过期';
  if (st === MEMORY_STATUS.DELETED) return '已删除';
  if (st === MEMORY_STATUS.DRAFT) return '待在收件箱里确认';
  return '不是算数状态';
}

/** scope=branch 的记忆：来源消息里至少有一条在当前活动路径上才算这一条线的 */
function inBranch(m, pathIds) {
  const src = Array.isArray(m.sourceMsgIds) ? m.sourceMsgIds : [];
  if (!src.length) return m.pinned === true;   // 无来源的分支记忆：只有手动钉住才注入
  // ⚠️ "拿不到路径"和"路径是空的"不是一回事（v0.5.2.2，外部评审 P1-4）。
  // null = 读活动路径时抛了异常，这时候宁可不丢记忆；空 Set = 确实一条消息都没有
  // （新角色 / 导入后叶子没对上），这时所有 branch 记忆都不在线上，放行就成了跨分支泄漏。
  if (!pathIds) return true;
  if (!pathIds.size) return m.pinned === true;
  for (const id of src) if (pathIds.has(id)) return true;
  return false;
}

function recency(m) {
  return memoryDay(m.day) || memoryDay(m.sinceDay) || 0;
}

/**
 * 挑这一轮要注入的记忆。
 *
 * @param {object} opts
 * @param {any[]} [opts.list] 该角色的全部记忆（含非 active，函数自己过滤）
 * @param {Set<string>|string[]|null} [opts.pathIds] 当前活动路径上的消息 id
 * @param {number} [opts.limit] 最多注入几条
 * @param {number} [opts.budgetTokens] 记忆块最多占多少 token
 * @param {number} [opts.nowDay] 当前剧情天数
 * @param {(t: string) => number} [opts.estimate] 自定义 token 估算
 * @param {string} [opts.userText] 他这一轮说的原话（记忆经历化，打分要用：
 *   不传就只有情绪/未完成/新近/关系四项，等于回到"固定顺序 + 情绪"的旧行为）
 * @param {boolean} [opts.forScene] 这次是给【小说】挑（v0.5.2.5）：
 *   scope='scene' 的记忆只有它自己那一场才进；kind 顺序也换成场景那套。
 * @param {string} [opts.sceneId] 当前这一场的 id（配 forScene 用）
 * @returns {{used: any[], dropped: any[], tokens: number, limit: number, budget: number, nowDay: number}}
 */
export function pickMemories(opts = {}) {
  const list = Array.isArray(opts.list) ? opts.list : [];
  const forScene = opts.forScene === true;
  const sceneId = String(opts.sceneId || '');
  const rawPath = opts.pathIds;
  const pathIds = rawPath instanceof Set ? rawPath : (Array.isArray(rawPath) ? new Set(rawPath) : null);
  const limit = Math.max(1, Math.floor(Number(opts.limit) || 20));
  const budget = Math.max(0, Math.floor(Number(opts.budgetTokens) || 0));
  const nowDay = memoryDay(opts.nowDay);
  const est = typeof opts.estimate === 'function' ? opts.estimate : defaultMemoryTokens;

  const used = [];
  const dropped = [];
  const candidates = [];
  const seenText = new Set();

  for (const m of list) {
    const text = String((m && m.text) || '');
    if (!m || !text.trim()) continue;
    // ⚠️ 先过滤状态 / 作用域，最后才判重（v0.5.2.2，外部评审 P1-3）。
    //
    // 原来 seenText.add(text) 排在 status 检查【之前】：列表里先出现一条
    // superseded / deleted / draft 的同文本死副本，后面那条真正 active 的
    // 会被判成"重复"直接 continue —— 既不进提示词，也不进 dropped。
    // 检查器里看不到它，用户只会觉得"这条明明还在，她怎么不用"。
    // IndexedDB 的 index.getAll 不保证顺序，所以这不是理论问题。
    //
    // status 缺失 = v2 之前的老记录 / 老备份导入（没走过 normalizeMemory）→ 当 active。
    if (m.status && m.status !== MEMORY_STATUS.ACTIVE) { dropped.push({ id: m.id, text, reason: statusReason(m) }); continue; }
    const scope = String(m.scope || 'character');
    // scope='scene'（v0.5.2.5）：原来这里一律丢掉，理由写「只在小说里用」——
    // 可小说那边调用的也是这个函数，没有开关，于是这个 scope 变成只写不读的死字段。
    // 现在：给小说挑的时候，只有【这一场自己产生的】才进；聊天侧维持丢弃。
    if (scope === 'scene') {
      const own = forScene && sceneId && String(m.sourceSceneId || '') === sceneId;
      if (!own && m.pinned !== true) {
        dropped.push({ id: m.id, text, reason: forScene ? '不是这一场里的' : '只在小说里用' });
        continue;
      }
    }
    if (scope === 'branch' && !inBranch(m, pathIds)) { dropped.push({ id: m.id, text, reason: '不在这条故事线上' }); continue; }
    // 同文本只留一条：去重是写入时该做的事，走到这里说明库里已经有重复
    // （比如老备份导入），这时静默合并比报错有用。
    if (seenText.has(text)) { dropped.push({ id: m.id, text, reason: '和另一条完全一样，只留一条' }); continue; }
    seenText.add(text);
    candidates.push(m);
  }

  const order = forScene ? KIND_ORDER_SCENE : KIND_ORDER;
  const ctx = { userText: String(opts.userText == null ? '' : opts.userText), userGrams: null, nowDay };
  if (!forScene && ctx.userText) ctx.userGrams = bigramsOf(ctx.userText);
  const scored = new Map();
  if (!forScene) for (const m of candidates) scored.set(m, scoreOf(m, ctx));
  candidates.sort((a, b) => {
    const pa = a.pinned === true ? 0 : 1;
    const pb = b.pinned === true ? 0 : 1;
    if (pa !== pb) return pa - pb;
    if (!forScene) {
      const sa = scored.get(a) || 0;
      const sb = scored.get(b) || 0;
      if (Math.abs(sa - sb) > 1e-9) return sb - sa;
    }
    const ka = order[String(a.kind || 'fact')];
    const kb = order[String(b.kind || 'fact')];
    const oa = ka == null ? 6 : ka;
    const ob = kb == null ? 6 : kb;
    if (oa !== ob) return oa - ob;
    const ra = recency(a), rb = recency(b);
    if (ra !== rb) return rb - ra;                    // 越近越靠前
    return (b.ts || 0) - (a.ts || 0);
  });

  let tokens = 0;
  for (const m of candidates) {
    const text = String(m.text);
    if (used.length >= limit) { dropped.push({ id: m.id, text, reason: '条数满了（已用 ' + limit + ' 条）' }); continue; }
    // —— 选择性遗忘 ——
    // 判定只用库里已有的三个信号：多久了 / 有没有标强度 / 是不是琐事。
    // 12 字是"一句完整的话"的下限：比它更短的（"他把伞弄丢了"）模糊完就只剩噪音。
    // 不新加字段、不删库：原文还在 text 里（检查器、导出、备份都是原文），
    // 只有【喂给模型的那一行】换成了模糊版。
    const _d = recency(m) || 0;
    const blur = !forScene && m.pinned !== true && String(m.kind || 'fact') === 'event'
      && (Number(m.heat) || 0) === 0 && _d > 0 && nowDay > 0 && (nowDay - _d) >= FOG_DAYS
      && text.length >= 12;
    const line = blur ? fogLine(text) : memoryLine(m);
    const cost = Math.max(1, est(line));
    // pinned 是用户手点的，宁可超一点预算也要留下（规格 §5.3 pinned 排第一）
    if (budget && tokens + cost > budget && m.pinned !== true) { dropped.push({ id: m.id, text, reason: '预算不足' }); continue; }
    tokens += cost;
    used.push({
      id: m.id,
      text,
      line,
      kind: String(m.kind || 'fact'),
      key: String(m.key || ''),
      scope: String(m.scope || 'character'),
      subject: String(m.subject || 'char'),
      who: String(m.who || ''),
      legacy: m.legacy === true,
      needsSplit: m.needsSplit === true,
      pinned: m.pinned === true,
      sources: Array.isArray(m.sourceMsgIds) ? m.sourceMsgIds.slice() : [],
      tokens: cost,
      // —— 记忆经历化：把打分依据一起带出去，检查器里能看见为什么是它 ——
      score: forScene ? 0 : Math.round((scored.get(m) || 0) * 1000) / 1000,
      sem: forScene ? 0 : Math.round(semanticScore(m.text, ctx.userGrams) * 1000) / 1000,
      heat: Number(m.heat) || 0,
      open: m.open === true,
      day: recency(m) || 0,
      cb: false,
      blur,
      why: m.pinned === true ? '你钉住的' : (KIND_WHY[String(m.kind || 'fact')] || '较早的事实')
    });
  }

  // —— 「她突然想起来」——
  //
  // 方案 §记忆检索要求每轮注入里至少有 1~2 条【不是当场相关】的记忆：
  // 全是当场相关的，读起来像检索结果；偶尔翻出来一件很久以前的事，才像一个人。
  // 抽的条件（都要满足）：
  //   · 不是 pinned —— 钉住的已经足够显眼，不用再提醒
  //   · 距这一轮 >= 3 天 —— 今天刚说的不叫「想起来」
  //   · 有情绪（heat>=3）或者没完（open）—— 琐事翻出来没有意义
  //   · 这一轮他说的话没有直接提到它（语义重合 < 0.34）—— 提了就不算突然
  // 最多 2 条（注入 >= 8 条时才给第二条）：多了会把这一轮变成回忆录。
  // 只对聊天模式生效；小说模式要按场次的张力来，不玩「突然想起来」。
  if (!forScene && used.length >= 4) {
    const cbPool = used.filter(x =>
      x.cb !== true && x.pinned !== true && !x.legacy &&
      x.day && nowDay && (nowDay - x.day) >= 3 &&
      (x.heat >= 3 || x.open === true) &&
      (x.sem || 0) < 0.34
    );
    cbPool.sort((a, b) => (b.score || 0) - (a.score || 0));
    const want = used.length >= 8 ? 2 : 1;
    for (let i = 0; i < Math.min(want, cbPool.length); i++) cbPool[i].cb = true;
  }

  return { used, dropped, tokens, limit, budget, nowDay };
}

/** 把 used 拼成提示词里那一段（不带标题，标题由 persona.js 加） */
export function memoryBlockText(used) {
  const arr = Array.isArray(used) ? used : [];
  if (!arr.length) return '';
  // 「她突然想起来」的那条前面加一句：不是给读者看的，是给模型一个语气提示 ——
  // 这条不是这一轮的话题，它是自己冒上来的，写法上就不该像在回答他。
  return arr.map(x => '· ' + (x.cb ? '（她突然想起来）' : '') + x.line).join('\n');
}

/** 给 UI 用的一句话摘要：用了 8 条 / 挤掉 3 条 */
export function pickSummary(pick) {
  const p = pick || {};
  const u = Array.isArray(p.used) ? p.used.length : 0;
  const d = Array.isArray(p.dropped) ? p.dropped.length : 0;
  const t = Number(p.tokens) || 0;
  return '这一轮用了 ' + u + ' 条记忆（约 ' + t + ' token）' + (d ? '，另有 ' + d + ' 条没进来' : '');
}
