// www/js/innerthought.js —— 她这一轮没说出口的那一层（活人感 v2）
//
// 为什么单独一次调用写"心里话"，而不是让正文顺手带一句：
//   正文是【要发出去的话】，它天然被"有用、得体、说得清"约束；
//   心里话是【不打算发出去的话】，它才允许难听、模糊、答非所问。
//   同一趟生成里写这两样，模型永远会把心里话写成"正文的铺垫"（"其实我想说……"）。
//   分开写，它才有机会写出真正咽回去的那句。
//
// ⚠️ 这一层失败【不能挡聊天】。超时、空串、乱码 —— 一律返回 ''，
//   提示词里就不出现这一层（等价于 v1 的行为）。
//
// ⚠️ system 必须是【逐字节相同】的人设前缀（和生成那趟共用 sysStable），
//   否则 DeepSeek 的前缀缓存全废，这一趟会按全价重读整段人设。
//   所以这里只允许 [{system: stable}, ...额外指令] 的形状 ——
//   不往 system 塞人设摘要、不塞场景、不塞状态。

import { onceChat } from './api.js';

/** 独白的输出上限。3~5 句中文，500 够，也给模型的呼吸留余量。 */
const INNER_MAX_TOKENS = 500;

/** 喂进去的历史条数。和 director 一样取 8：再多就是在重读整段聊天。 */
const RECENT_N = 8;

/** 独白最多留几行、几个字。它只是提示词里的一小段，不是日记。 */
const INNER_LINES = 5;
const INNER_MAX = 400;

/**
 * 独白指令。逐字使用 —— 这几十个字的措辞是调出来的，
 * 改一个词（比如把"不要写台词"换成"尽量别写台词"）效果就散了。
 *
 * 用户原话的意思：这里要的是【她脑子里那几句】，不是旁白、不是心理分析。
 */
const INNER_ASK_HEAD = '（他这一轮说的是：';
const INNER_ASK_TAIL = [
  '）',
  '',
  '先别写回复。用第一人称，把她这一轮【没说出口】的那一层写下来。',
  '3 到 5 句，一句一行，不要编号，不要加任何前缀。',
  '',
  '写这些：',
  '- 她看到这句话的第一反应（是疼、是想笑、是没懂，还是根本没在听）',
  '- 身上有没有反应（手停没停、呼吸、视线落在哪）',
  '- 哪一句她其实想说出来，又咽回去了',
  '- 她打算怎么应付这一轮（往下接、岔开、刺一句、装作没听懂、不理）',
  '',
  '不要写：台词、动作描写、对他的评价、任何总结性的话、任何解释氛围的话。',
  '只写她脑子里那几句。'
].join('\n');

/** 拼出完整的独白指令。userText 为空时也要有个占位，否则句式读不通。 */
export function innerAsk(userText) {
  const t = String(userText == null ? '' : userText).trim() || '（他没说话）';
  return INNER_ASK_HEAD + t + INNER_ASK_TAIL;
}

/**
 * 把模型写的独白收干净。
 *
 * 模型很爱加东西：编号、小标题、markdown 星号、还有一句"以下是她的内心"之类的
 * 前言。这些东西一旦进了提示词，她就可能把它当成"要写进正文的格式"。
 * 所以这里只留【裸的行】，别的全砍。
 *
 * @returns {string} 空串 = 没有可用的独白
 */
export function normalizeInner(text) {
  const raw = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
  const out = [];
  for (const line of raw.split('\n')) {
    let s = line.trim();
    if (!s) continue;
    // 行首编号：1. / 2、/ 3) / - / · / • / 一、
    s = s.replace(/^\s*(?:\d+\s*[.、)）]|[-*·•]\s+|一[、.]\s*)/, '').trim();
    // 行首 markdown 标记：# / > / *
    s = s.replace(/^[#>*]+\s*/, '').trim();
    // 行尾残留的星号：「**咽回去了**」削掉行首后还剩尾巴，它进提示词会被当成 markdown 格式
    s = s.replace(/\*+$/, '').trim();
    if (!s) continue;
    out.push(s);
    if (out.length >= INNER_LINES) break;
  }
  let joined = out.join('\n');
  if (joined.length > INNER_MAX) joined = joined.slice(0, INNER_MAX);
  return joined;
}

/**
 * 跑一次独白。
 *
 * @param {object} o
 * @param {string} o.stable   人设稳定前缀（与生成那趟逐字相同 —— 为了命中缓存）
 * @param {Array}  o.recent   最近的历史消息 [{role, content}]
 * @param {string} o.userText 他这一轮说的话
 * @param {{apiKey?: string, baseUrl?: string, provider?: string, model?: string, timeoutMs?: number}} o.api
 * @param {AbortSignal} [o.signal]
 * @returns {Promise<string>} 归一后的独白；失败/被中断一律 ''
 */
export async function runInner(o) {
  const { stable, recent, userText, api, signal } = o || {};
  if (!api || !api.apiKey) return '';
  if (signal && signal.aborted) return '';

  const msgs = [];
  if (stable) msgs.push({ role: 'system', content: stable });
  for (const m of (recent || []).slice(-RECENT_N)) {
    const c = String((m && m.content) || '').trim();
    if (!c) continue;
    msgs.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: c });
  }
  msgs.push({ role: 'user', content: innerAsk(userText) });

  let out = '';
  try {
    out = await onceChat({
      apiKey: api.apiKey,
      baseUrl: api.baseUrl,
      provider: api.provider,
      model: api.model,
      messages: msgs,
      // 高温：这里要的是"她那几句"，不是判断。低温会写出通稿式的内心独白。
      temperature: 0.9,
      maxTokens: INNER_MAX_TOKENS,
      // 思考照开：写"没说出口的话"需要一点琢磨，关掉反而容易写成语录。
      noThink: false,
      timeoutMs: Number(api.timeoutMs) || 20000
    });
  } catch (err) {
    console.warn('[inner] 独白失败，这一轮没有内心那一层：' + ((err && err.message) || err));
    return '';
  }
  return normalizeInner(out);
}
