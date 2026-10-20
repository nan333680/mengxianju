// prose.js —— 反复读检测（v0.5.5）
//
// 要解决的问题：长对话里她会绕回同一套句子。「你今天怎么这么安静」这种话
// 第一次是体贴，第五次就是复读机 —— 而且模型自己看不出来（历史里全是它写的，
// 它觉得这就是自己的语气）。
//
// 做法：把这一条回复切成 4-gram（汉字/字母连续片段，跳掉标点空白），
// 和最近 5 条回复比较，取重合率里最高的那一个。
//
// 阈值是【量出来的】，不是拍的：
//   用 2026-10-18 的备份（19 个角色 / 1697 条 assistant 消息）跑了一遍，
//   相邻 5 条内的最高重合率分布是
//     p50 0.017 · p75 0.037 · p90 0.064 · p95 0.081 · p99 0.143 · max 0.296
//   也就是说真实对话里最"像"的一对也只有 29.6%。取 0.45 —— 比历史最高还高
//   0.15，落在自然分布之外，只抓真正的整段复读。
//
// ⚠️ 4-gram 而不是 3-gram：3-gram 在中文里太容易撞（「我不知」「了一下」这类
//    在正常对话里反复出现），实测会大面积误报。
// ⚠️ 只在【同一角色】的回复之间比。跨角色的语气当然可以像。

/** 重合率到这个数就算复读（见上面那张分布表） */
export const REPEAT_WARN = 0.45;

/** 取过去几条比。比得越远，"复读"就越不像随口，但这个窗口够抓近期了。 */
export const REPEAT_LOOKBACK = 5;

/** 把文本切成 4-gram 集合（去掉标点、符号、空白） */
export function grams4(text) {
  const s = String(text == null ? '' : text).replace(/[\s\p{P}\p{S}]+/gu, '');
  const g = new Set();
  for (let i = 0; i + 4 <= s.length; i++) g.add(s.slice(i, i + 4));
  return g;
}

/**
 * 这一条跟 prevTexts 里最像的那条有多像（0–1）。
 * 分母用两条里【较短】的那个 gram 数 —— 一条长回复里塞一句短重复，
 * 用长的那条当分母会被稀释成 0.05，什么都抓不到。
 */
export function repeatRate(text, prevTexts) {
  const a = grams4(text);
  if (a.size < 8) return 0;              // 太短，比不出意义（"嗯。"这种）
  let best = 0;
  for (const t of (prevTexts || [])) {
    const b = grams4(t);
    if (!b.size) continue;
    let inter = 0;
    for (const g of a) if (b.has(g)) inter++;
    const r = inter / Math.min(a.size, b.size);
    if (r > best) best = r;
  }
  return best;
}

/** 找出最像的那一条（给界面说"跟第几条像"用）。返回 {rate, id} */
export function worstRepeat(text, prevMsgs) {
  const a = grams4(text);
  if (a.size < 8) return { rate: 0, id: '' };
  let best = 0, id = '';
  for (const m of (prevMsgs || [])) {
    const b = grams4(m && m.content);
    if (!b.size) continue;
    let inter = 0;
    for (const g of a) if (b.has(g)) inter++;
    const r = inter / Math.min(a.size, b.size);
    if (r > best) { best = r; id = (m && m.id) || ''; }
  }
  return { rate: best, id };
}
