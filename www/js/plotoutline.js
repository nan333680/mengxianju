// www/js/plotoutline.js —— 剧情小纲（0.5.8.9）
//
// 他要的：发送前先看到这一轮大概怎么演，能改，改完再发。
// 为什么必须单独一次调用：正文那一趟是按【已经落库的历史】算的，改不了；
//   小纲是发之前定下来的安排，所以只能提前跑、提前给他看。
//
// ⚠️ 这一趟【不跑判断层】（director / inner）。那两个是每轮现算的，
//   两次请求天然不同，硬凑「一致」只会制造「看着一致、其实不一致」。
//   小纲是【上游输入】，不是下游结论 —— 由 send() 把 outline 传给 director
//   （app.js 里 buildTurnNote / runDirector 那两处），而不是这里去读 director。
//
// ⚠️ 失败一律返回 ''。生成失败 = 什么都没发生，参数槽保持原样 ——
//   绝不能把用户手写了一半的内容清掉。

import { onceChat } from './api.js';

/** 输出上限。三行 × 40 字 ≈ 120~180 token，384 有余量。
 *
 * ⚠️ 但【必须同时关思考】：思考是从 max_tokens 里扣的，开着思考时 384
 *    会被思维链吃光、content 返回空串（api.js onceChat 头部那段实测记着）。
 *    三行规划本来不需要推理，所以这一路直接 noThink。 */
const OUTLINE_MAX_TOKENS = 384;

/** 喂进去的历史条数。和独白/判断一样取 8：再多就是在重读整段聊天。 */
const OUTLINE_N = 8;

/** 三行的固定前缀。既是给模型的格式，也是 normalizeOutline 的锚点。 */
export const OUTLINE_HEAD = '她这轮怎么演：';
export const OUTLINE_REACH = '到哪儿为止：';
export const OUTLINE_AVOID = '别碰：';

/**
 * 小纲指令。逐字使用 —— 这三行怎么写是调出来的，改一个词效果就散。
 *
 * 第二行（到哪儿为止）是治「B 型偏」的主力：
 *   实测的失控链是「给空位填东西 → 给填进去的东西加情绪 → 情绪变成线」
 *   （11-24 那条：芙兰进场 → 补一个蹭门槛的动作 → 「她笑得怪」 → 多出一条「怕姐姐」）。
 *   所以这一行必须要求【按人写】：谁出声、各说几句、给不给动作 ——
 *   这些能被转录核对。抽象负向约束（「别写成对峙」）模型会自己解释，然后绕过去。
 */
const OUTLINE_ASK_TAIL = [
  '',
  '先别写回复。把这一轮【怎么演】定下来，写成三行。',
  '',
  '第一行「' + OUTLINE_HEAD + '」—— 这一轮实际发生什么，一两句说清。',
  '第二行「' + OUTLINE_REACH + '」—— 戏到哪儿为止。按【人】写，不按气氛写：',
  '  写清这一轮谁出声、各说几句、给不给动作。',
  '  例：「只撂话，不真把人带走；芙兰这轮只说一句，不给她动作」。',
  '  ⚠️ 不要写「不把气氛写成对峙」这种 —— 谁都能自己解释，等于没说。',
  '第三行「' + OUTLINE_AVOID + '」—— 这一轮不许出现的东西，一行。',
  '',
  '规则：',
  '- 不要替他说话，也不要复述他的原话。他这一轮要说什么，上面已经给了。',
  '- 不要写正文、不要写描写、不要写心理分析。',
  '- 只写这三行，不编号、不加前缀、不加解释。'
].join('\n');

/** 拼出完整的小纲指令。extra 是他这一轮挂着的东西（方向/更改/绝对指令）。 */
export function outlineAsk(o) {
  const { userText, extra } = o || {};
  const t = String(userText == null ? '' : userText).trim() || '（他这一轮没打字）';
  let s = '（他这一轮打算说的话：\n' + t + '\n）';
  const ex = String(extra || '').trim();
  if (ex) s += '\n（他这一轮另外挂着的：\n' + ex + '\n）';
  return s + OUTLINE_ASK_TAIL;
}

/** 把模型写的三行收干净。
 *
 * 模型爱加东西：编号、markdown 星号、还有「以下是这一轮的安排」之类的前言。
 * 这些一旦进了参数槽，用户改起来别扭；进了提示词，它又会当成格式。
 *
 * ⚠️ 不截断、不裁行：他要是写了四行，四行都留着 —— 裁由他自己裁。
 *    这里只做「去壳」：行首标记、空行、明显的开场白。
 *
 * @returns {string} 空串 = 没有可用的小纲
 */
export function normalizeOutline(text) {
  const raw = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
  const out = [];
  for (const line of raw.split('\n')) {
    let s = line.trim();
    if (!s) continue;
    // 行首编号：1. / 2、/ 3) / - / · / • / 一、
    s = s.replace(/^\s*(?:\d+\s*[.、)）]|[-*·•]\s+|一[、.]\s*)/, '').trim();
    // 行首 markdown：# / > / *
    s = s.replace(/^[#>]+\s*/, '').trim();
    s = s.replace(/^\*+\s*/, '').replace(/\*+$/, '').trim();
    if (!s) continue;
    // 前言：第一行、没有三行里任何一个前缀、且以「以下/这是/好的/可以」开头
    if (!out.length && !s.includes('：') && !s.includes(':')
        && /^(以下|这是|好的|可以|这一轮)/.test(s)) continue;
    out.push(s);
  }
  return out.join('\n');
}

/**
 * 跑一次小纲。
 *
 * @param {object} o
 * @param {string} o.stable   人设稳定前缀（与正文那趟逐字相同 —— 为了命中前缀缓存）
 * @param {Array}  o.recent   最近的历史消息 [{role, content}]
 * @param {string} o.userText 他这一轮要发的话（还没入库）
 * @param {string} [o.extra]  他这一轮挂着的功能（拼好的一段文本）
 * @param {{apiKey?: string, baseUrl?: string, provider?: string, model?: string}} o.api
 * @param {AbortSignal} [o.signal]
 * @returns {Promise<string>} 收起干净的三行；失败/被中断一律 ''（调用方保留原内容）
 */
export async function runOutline(o) {
  const { stable, recent, userText, extra, api, signal } = o || {};
  if (!api || !api.apiKey) return '';
  if (signal && signal.aborted) return '';

  const msgs = [];
  if (stable) msgs.push({ role: 'system', content: stable });
  for (const m of (recent || []).slice(-OUTLINE_N)) {
    const c = String((m && m.content) || '').trim();
    if (!c) continue;
    msgs.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: c });
  }
  msgs.push({ role: 'user', content: outlineAsk({ userText, extra }) });

  let out = '';
  try {
    out = await onceChat({
      apiKey: api.apiKey,
      baseUrl: api.baseUrl,
      provider: api.provider,
      model: api.model,
      messages: msgs,
      // 低温：这是"定安排"，不是"写话"。高了会写成一段正文。
      temperature: 0.4,
      maxTokens: OUTLINE_MAX_TOKENS,
      // ⚠️ 必须 noThink，不能只写 reasoningEffort:'none' ——
      //    api.js 那段实测：'none' 关不掉思考，384 会被思维链烧穿、content 返回空串。
      noThink: true,
      timeoutMs: 30000,
      signal: signal || null
    });
  } catch (err) {
    console.warn('[outline] 生成失败：' + ((err && err.message) || err));
    return '';
  }
  return normalizeOutline(out);
}
