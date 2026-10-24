/**
 * 去 AI 味（0.5.3.4）
 *
 * 为什么放在这一层：提示词已经试过两轮（0.4.3.1 加「两三个字的短句收尾」「'我认'整段只许一次」，
 * 0.5.3.3 又调了一遍），用户 0.5.3.3 实测仍然出现。原因不难看：
 *   · 提示词是软约束，模型在长上下文里会漂；
 *   · 更要命的是【历史污染】—— 她自己的旧消息里有 45 个「我认」，每一轮都被当成范例回灌，
 *     每一轮都在教她继续说。提示词管不过历史。
 *
 * 所以在软件层做两件事：
 *   1. 发给 API 的历史副本里，把套话洗掉（只改副本，库里一个字不动）；
 *   2. 新生成的消息入库前洗一遍（从这一条起，历史不再被污染）。
 *
 * ⚠️ 能做什么、不能做什么，别夸大：
 *   能做到：这几个词不再出现（确定性删除，100%）。
 *   做不到：整条读起来"不像 AI"。真正的 AI 味在骨架里 —— 同一份语料里
 *           「了一下」出现 528 次、「一会儿」179 次、「低头看他」149 次，
 *           这才是"看多了恶心"的来源。删词删不掉骨架，那要靠频率惩罚和禁用动作。
 *
 * ⚠️ 不许用 lookbehind（(?<=…)）—— 旧 WebView 会在【解析】阶段就 SyntaxError，
 *    整份文件随之不加载。要"前面必须是标点"就用捕获组把前缀抓回来。
 *
 * 词表依据（她 2026-10-18 的备份，1708 条 assistant / 19 个角色）：
 *   我认系 53 次（我认 45 / 我不认 4 / 这话我认 2 / 我认了 2，跨 8 个角色）
 *   「顿了」99 条消息里出现（顿了顿 / 顿了一下）
 * ⚠️ 词级匹配会误伤：「我认得」「我认出来」「我认错人」都是正常说法，
 *    所以认输系必须带【边界】（后面直接跟句末标点）才算。
 */

/** 命中即整句删除的短句（去掉标点后完全相等才算） */
export const DROP_SENTENCE = [
  '我认', '我认了', '我不认', '这话我认', '我认栽', '行我认', '行吧我认', '好我认',
  '成我认', '那我认', '我认输', '算我认',
  // 0.5.3.4 追加：整句只有「认」这一个动作的其它形态
  '认了', '认下', '认账', '认输', '认栽', '认罚', '认怂',
];

/**
 * 句子中间要删掉的整块。
 *
 * 两条实测出来的约束，别拆：
 *   1. 认输系只删【句尾】那一截，且删完剩下的正文必须还有 6 个字以上。
 *      否则「这个我认了。」会被啃成「这个。」—— 那是她在承认一件事，不是套话，
 *      语义被删断了（芙兰朵露「我认你是我哥。这个我认了。」实测踩过）。
 *   2. 停顿套话【前面必须是行首、标点或左括号】（用捕获组 $1 把前缀留住）。
 *      否则「被压下来的时候整个人顿了一下」会变成「整个人，嘴巴被堵住」——
 *      主语被删掉，句子残了（小恶魔那条实测踩过）。
 *
 * 每条形如 { re, minRest?, prefix? }：
 *   minRest —— 删完剩下的正文至少还要有这么多字，否则不动
 *   prefix  —— true 表示 re 的第一个捕获组是"前缀"，替换时原样留下
 */
export const DROP_CLAUSE = [
  // 认输系：句尾，且整句够长。
  //
  // ⚠️ 必须带「我」（0.5.3.4 用户反馈后收窄）：她从来不用「承认」这个词，
  //    凡是服软一律写「认」——「我认 / 认了 / 认下 / 认账 / 认输」。
  //    这里只抓【她自己的】服软表态，不碰「他认错」「认得」「认出来」。
  // ⚠️ dropWhole：删完只剩「这个」「那」这类指代（≤3 字）时整句删掉。
  //    否则「这个我认了。」被啃成「这个。」—— 半句话留在历史里，
  //    比原句更像套话（用户 0.5.3.4 明确说「认」这个字本身就不能再出现）。
  // ⚠️ 句尾字符类里必须有 \n（v0.5.3.4 自查）：splitSentences 把换行当句末标点
  //    一起切进这一段，于是「这个我认。\n（她低下头）」第一句的结尾是 '\n' 不是 '。'，
  //    原来那版规则匹配不上，整条 seed 历史原样喂进了模型 —— e2e-channel 第 7 节就是这样假红的。
  { re: /[，、,]?\s*(?:这话|这句)?我(?:就)?认(?:了|下|账|输|栽|罚|怂)?[。！？…~」』\n]*$/g, minRest: 6, dropWhole: true },
  { re: /[，、,]?\s*我(?:就)?不认(?:了|账|输)?[。！？~」』\n]*$/g, minRest: 6, dropWhole: true },
  // 停顿套话：前面必须是行首 / 标点 / 左括号
  { re: /(^|[，、。！？…~（(「『\n])(?:他|她|我)?顿了(?:顿|一下|一瞬)(?:[，、,])?/g, prefix: true },
  { re: /(^|[，、。！？…~（(「『\n])(?:他|她|我)?怔了怔(?:[，、,])?/g, prefix: true },
];

/** 切句：保留句末标点，换行也算一刀 */
// ⚠️ 切句【不能用省略号当分隔符】：中文省略号是「……」，一按「…」切，
//    「谁家好人……」就碎成「谁家好人…」+「…」，后半截还会被当成独立句删掉。
//    省略号本身就是一个停顿，不该断开句子。只按 。！？和换行切。
function splitSentences(s) {
  return s.match(/[^。！？\n]*[。！？\n]+|[^。！？\n]+$/g) || [];
}

const PUNCT_ONLY = /^[\s。！？…~，、；：,.!?;:]*$/;
const BARE_TAIL = /[，、；：,;:]\s*(?=[。！？…~】」』）)]|$)/g;
// ⚠️ 不能把省略号折叠（…… 是合法的六个点，不是重复标点）
const DUP_PUNCT = /([，、。！？])\1+/g;
const LEAD_PUNCT = /(^|[。！？…~\n「『【（(])\s*[，、；：,;:]\s*/g;
const EMPTY_PAREN = /[（(]\s*[）)]/g;
const CH_RE = /[\u4e00-\u9fff]/g;

const coreLen = (s) => (s.match(CH_RE) || []).length;

/**
 * 洗一条正文。
 * @param {string} text 原文
 * @param {string[]} [extraBanned] 用户自己加的禁用词（整词删除，不区分位置）
 * @returns {{ text: string, hits: string[] }} hits 是"命中了什么"，用来给用户看，也用来做测试断言
 */
export function deflavor(text, extraBanned = []) {
  const src = String(text ?? '');
  if (!src) return { text: src, hits: [] };
  const hits = [];
  const note = (w) => { const k = String(w).trim(); if (k && !hits.includes(k)) hits.push(k); };

  for (const w of DROP_SENTENCE) if (src.includes(w)) note(w);
  for (const w of extraBanned) if (w && src.includes(w)) note(w);

  let out = splitSentences(src).map(seg => {
    // 1) 整句就是一句认输 —— 连句带标点一起没了
    const bare = seg.replace(/[\s。！？…~，、；：,.!?;:（()）]/g, '');
    if (DROP_SENTENCE.includes(bare)) return '';

    // 2) 句内整块删除
    let s = seg;
    for (const rule of DROP_CLAUSE) {
      rule.re.lastIndex = 0;
      const mm = s.match(rule.re);
      if (!mm) continue;
      const cand = rule.prefix
        ? s.replace(rule.re, '$1')
        : s.replace(rule.re, '');
      if (rule.minRest && coreLen(cand) < rule.minRest) {
        // dropWhole：删完只剩「这个」「那」这类指代，整句已经没有信息了 —— 整句删。
        // 不加这条的话「这个我认了。」会被啃成「这个。」，比原句更像套话。
        if (rule.dropWhole && coreLen(cand) <= 3) {
          for (const x of mm) note(x);
          return '';
        }
        continue;
      }
      if (PUNCT_ONLY.test(cand)) continue;
      for (const x of mm) note(rule.prefix ? x.replace(/^[，、。！？…~（(「『\n]/, '') : x);
      s = cand;
    }

    // 3) 用户词表：整词删（连它前面的逗号一起）
    for (const w of extraBanned) {
      if (!w) continue;
      s = s.split(w).join('');
    }

    // 4) 删完只剩标点/空白 → 整句不要
    if (PUNCT_ONLY.test(s)) return '';
    return s;
  }).join('');

  // 收尾清理：句尾残留逗号、重复标点、句首冒出的逗号、空括号
  out = out.replace(BARE_TAIL, '').replace(DUP_PUNCT, '$1').replace(LEAD_PUNCT, '$1').replace(EMPTY_PAREN, '');
  out = out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
  return { text: out, hits };
}

/** 只是想知道有没有命中（历史清洗前的快速判断） */
export function hasFlavor(text, extraBanned = []) {
  return deflavor(text, extraBanned).hits.length > 0;
}
