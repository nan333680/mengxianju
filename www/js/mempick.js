// 记忆检索（0.6.0 记忆 OS · 规格 §5）
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
const KIND_ORDER = { goal: 0, relationship: 1, state: 2, event: 3, item: 4, belief: 5, fact: 6 };
const KIND_WHY = { goal: '她想做但还没做到', relationship: '两人关系', state: '当前状态', event: '最近发生的', item: '物品', belief: '她以为的', fact: '较早的事实' };

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
 * @returns {{used: any[], dropped: any[], tokens: number, limit: number, budget: number, nowDay: number}}
 */
export function pickMemories(opts = {}) {
  const list = Array.isArray(opts.list) ? opts.list : [];
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
    if (scope === 'scene') { dropped.push({ id: m.id, text, reason: '只在小说里用' }); continue; }
    if (scope === 'branch' && !inBranch(m, pathIds)) { dropped.push({ id: m.id, text, reason: '不在这条故事线上' }); continue; }
    // 同文本只留一条：去重是写入时该做的事，走到这里说明库里已经有重复
    // （比如老备份导入），这时静默合并比报错有用。
    if (seenText.has(text)) { dropped.push({ id: m.id, text, reason: '和另一条完全一样，只留一条' }); continue; }
    seenText.add(text);
    candidates.push(m);
  }

  candidates.sort((a, b) => {
    const pa = a.pinned === true ? 0 : 1;
    const pb = b.pinned === true ? 0 : 1;
    if (pa !== pb) return pa - pb;
    const ka = KIND_ORDER[String(a.kind || 'fact')];
    const kb = KIND_ORDER[String(b.kind || 'fact')];
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
    const line = memoryLine(m);
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
      why: m.pinned === true ? '你钉住的' : (KIND_WHY[String(m.kind || 'fact')] || '较早的事实')
    });
  }

  return { used, dropped, tokens, limit, budget, nowDay };
}

/** 把 used 拼成提示词里那一段（不带标题，标题由 persona.js 加） */
export function memoryBlockText(used) {
  const arr = Array.isArray(used) ? used : [];
  if (!arr.length) return '';
  return arr.map(x => '· ' + x.line).join('\n');
}

/** 给 UI 用的一句话摘要：用了 8 条 / 挤掉 3 条 */
export function pickSummary(pick) {
  const p = pick || {};
  const u = Array.isArray(p.used) ? p.used.length : 0;
  const d = Array.isArray(p.dropped) ? p.dropped.length : 0;
  const t = Number(p.tokens) || 0;
  return '这一轮用了 ' + u + ' 条记忆（约 ' + t + ' token）' + (d ? '，另有 ' + d + ' 条没进来' : '');
}
