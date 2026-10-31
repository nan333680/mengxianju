/**
 * 周期性反思（0.5.4.1，借 Generative Agents 的 reflection）。
 *
 * 为什么要它：现在 psyche.beliefs 只有 director 每轮顺手给的一两条，
 * 那种"当场认定"的东西永远是最近一轮的形状 —— 她不会因为过了几天
 * 而把几件事串成一个更稳的看法。Generative Agents 的解法是：
 * 把一段时间里攒下的观察【合成】成一条更高层的印象，写回记忆流。
 * 我们只借这一点，不借整套记忆流（那要重做存储层）。
 *
 * 边界（很重要）：
 *   · 一天最多跑一次（REFLECT_GAP_MS = 12 小时，实际节奏由调用点控）。
 *   · 只写一条 belief，不写事实、不改关系读数、不动 secrets/boundaries。
 *   · 任何失败都返回 null，绝不挡住聊天。
 *   · 素材不够（清单里不到 2 条）不发请求 —— 没有素材的反思 = 让模型自己编。
 */
import { onceChat } from './api.js';
import { normalizePsyche, applyPsycheDelta, psycheActive } from './psyche.js';

/** 两次反思之间至少隔多久。调用点还会再叠一层"每天一次"的日期判据。 */
export const REFLECT_GAP_MS = 12 * 3600 * 1000;
/** 反思出来的这一条最多多少字。超过就是开始写小作文了。 */
export const REFLECT_MAX = 40;

/**
 * 这一轮值不值得反思。
 *
 * @param {any} psyche 状态
 * @param {number} lastAt 上次反思的时间戳（0 = 从没反思过）
 * @param {number} [now]
 * @returns {boolean}
 */
export function shouldReflect(psyche, lastAt, now = Date.now()) {
  const p = normalizePsyche(psyche);
  if (!psycheActive(p)) return false;
  const last = Number(lastAt) || 0;
  if (last > 0 && now - last < REFLECT_GAP_MS) return false;
  // 素材：她自己的事、还没问出口的、没消的气、瞒着的。
  // 四条清单加起来不到 2 条就不跑 —— 一条孤零零的"还没问出口的"反思不出什么。
  const n = (p.selfEvents || []).filter(x => x && !x.dead).length
    + (p.openLoops || []).filter(x => x && !x.dead).length
    + (p.grudges || []).filter(x => x && !x.dead).length
    + (p.secrets || []).filter(x => x && !x.dead).length;
  return n >= 2;
}

/** 把几条清单拼成「你这几天心里存着的」那一段。dead 的不给 —— 封存了就是过去了。 */
function materialOf(p) {
  const out = [];
  const add = (label, list) => {
    const arr = (list || []).filter(x => x && x.t && !x.dead).map(x => x.t);
    if (arr.length) out.push(label + arr.join('；'));
  };
  add('还没问出口的：', p.openLoops);
  add('还没消的：', p.grudges);
  add('你自己这两天：', p.selfEvents);
  add('瞒着他的：', p.secrets);
  add('你心里认定的：', p.beliefs);
  return out.join('\n');
}

/**
 * 反思用的提示词。
 *
 * 为什么这么写：
 *   · 要「认定的事」而不是心情 —— 心情已经有 mood 字段了，再来一条就是重复。
 *   · 明说不要"我发现/我意识到"：模型一旦用这两个词开头，后面必然是总结句，
 *     而总结句正是她说话最像 AI 的地方。
 *   · 给「想不出来就空着」的出口 —— 不给出口，模型一定会硬编一条。
 */
export function reflectAsk(o = {}) {
  const p = normalizePsyche(o.psyche);
  const mat = materialOf(p) || '（没什么特别的）';
  const recent = String(o.recent == null ? '' : o.recent).trim();
  const L = [
    '（你这几天心里存着的：',
    mat,
    '）'
  ];
  if (recent) {
    L.push('', '（他最近说的几句：', recent.slice(0, 400), '）');
  }
  L.push(
    '',
    '隔了一段时间，回头想这些。有没有哪一句，是你现在真的认了的？',
    '',
    '只输出一行，最多 ' + REFLECT_MAX + ' 个字。第一人称，写「你认定的那件事」，不是心情，不是经历，也不是总结你们的关系。',
    '不要用「我发现」「我意识到」「原来」开头，不要引号，不要解释，不要编号。',
    '想不出来就什么都不输出。'
  );
  return L.join('\n');
}

/** 把模型那一行洗干净：去编号/引号/星号，超长截断，太离谱（>60 字）当没给。 */
export function parseReflect(text) {
  let s = String(text == null ? '' : text).trim();
  if (!s) return '';
  // 只取第一行非空
  s = s.split(/\r?\n/).map(x => x.trim()).find(Boolean) || '';
  s = s.replace(/^[-*·•\d.、)\s]+/, '').replace(/^#+\s*/, '');
  s = s.replace(/^["'「『（(]+/, '').replace(/["'」』）)]+$/, '').replace(/\*/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) return '';
  // 明显跑偏（模型写了一大段）：宁可不要，也不要往状态里塞一段散文。
  if (s.length > REFLECT_MAX * 2) return '';
  return s.slice(0, REFLECT_MAX);
}

/**
 * 跑一次反思。
 *
 * 前缀缓存约束（规格 §3）：system 必须逐字节等于 sysStable，额外指令只能挂在 user 上。
 *
 * @param {{stable?:string, psyche?:any, recent?:string, api?:{apiKey?:string, baseUrl?:string, model?:string, provider?:string}, signal?:AbortSignal, onUsage?:Function}} [o]
 * @returns {Promise<{belief:string, usage:any}|null>}
 */
export async function runReflect(o = {}) {
  const api = o.api || {};
  if (!api.apiKey) return null;
  const stable = String(o.stable == null ? '' : o.stable);
  if (!stable.trim()) return null;   // 没有稳定前缀就别跑：那样等于把人设丢掉
  let usage = null;
  let raw = '';
  try {
    raw = await onceChat({
      apiKey: api.apiKey,
      baseUrl: api.baseUrl,
      model: api.model,
      provider: api.provider,
      messages: [
        { role: 'system', content: stable },
        { role: 'user', content: reflectAsk({ psyche: o.psyche, recent: o.recent }) }
      ],
      maxTokens: 200,
      temperature: 1.0,
      noThink: true,
      timeoutMs: 15000,
      signal: o.signal,
      onUsage: u => { usage = u; }
    });
  } catch (err) {
    console.warn('[reflect] 这次没反思成：' + ((err && err.message) || err));
    return null;
  }
  const belief = parseReflect(raw);
  if (!belief) return null;
  if (typeof o.onUsage === 'function' && usage) { try { o.onUsage(usage); } catch { /* 用量记不上不影响结果 */ } }
  return { belief, usage };
}

/**
 * 把反思结果写回状态。单独拎出来，是为了 e2e 能不启浏览器就测到这一段。
 * 已经认过的事不重复堆（交给 applyPsycheDelta 的 findItem 去重）。
 */
export function applyReflect(psyche, belief, now = Date.now()) {
  if (!belief) return normalizePsyche(psyche);
  return applyPsycheDelta(psyche, { belief: [{ t: belief, conf: 0.6 }] }, now);
}
