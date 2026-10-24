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

/**
 * 按模型/厂商分档的词表（0.5.3.5，方向文档 P0-3）。
 *
 * ⚠️ 为什么只有 deepseek 一档、别的一律空着：
 *    我们手上有实测语料（1708 条）的只有 deepseek-flash 这一个模型。
 *    「我认」「顿了顿」在别的模型里出不出、出多少，没有数据。
 *    没有数据就不猜 —— 猜错的代价是把正常文案删掉，比漏删严重得多。
 *    换到 gpt/claude 这些时，通用表里那几条（目前为空）才会生效。
 *
 * 想让某个厂商也分到档：拿它的真实输出统计一遍跨角色高频，
 * 有数了再往 FLAVOR_BY_MODEL 里加，别照抄中文写作圈的"AI 味词表"——
 * 那类表全是「标志着 / 见证了 / 彰显了」这种公文营销词，
 * 在角色扮演对话里一次都命中不了（实测 0/1708）。
 */
export const FLAVOR_BY_MODEL = { deepseek: 'deepseek' };

/**
 * 命中即整句删除的短句（去掉标点后完全相等才算）
 * @type {string[]}
 */
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
  //
  // ⚠️ 不能用「标点 + $」这种写法把句尾标点一起吃掉（v0.5.3.4 复查实测 4/1708 条黏句）：
  //    「你要我认手重，我认。你要问我从哪学的」→「你要我认手重你要问我从哪学的」
  //    —— 句号被吞，前后两句黏成一句。现在改成【前瞻】：只删「认」那一块，句号原样留下。
  { re: /[，、,]?\s*(?:这话|这句)?我(?:就)?认(?:了|下|账|输|栽|罚|怂)?(?=[，、。！？…~」』\n]|$)/g, minRest: 2, dropWhole: true, tailPron: true },
  { re: /[，、,]?\s*我(?:就)?不认(?:了|账|输)?(?=[，、。！？…~」』\n]|$)/g, minRest: 2, dropWhole: true, tailPron: true },
  // 停顿套话：前面必须是行首 / 标点 / 左括号。
  //
  // ⚠️ 「顿了X」后面【必须紧跟标点或行尾】才算套话（v0.5.3.4 复查实测）：
  //    「他顿了顿才开口。」原来会删成「才开口。」（主语+连词，句子残了）；
  //    「他顿了顿神。」会删成「神。」、「她顿了顿脚，」删成「脚，」—— 顿神/顿脚是正常动作。
  //    所以加前瞻 (?=[标点]|$)，再顺手吃掉紧跟的那个标点（否则「（她顿了顿。然后抬起头）」
  //    会剩「（。然后抬起头）」）。后面跟才/就/便/又时不动 —— 那是「顿了一下，才反应过来」。
  { re: /(^|[，、。！？…~（(「『\n])(?:他|她|我)?顿了(?:顿|一下|一瞬)(?=[，、。！？…~）)」』\n]|$)(?![，、。！？…~][才就又便])[，、。！？…~]?/g, prefix: true, minRest: 2, dropWhole: true },
  { re: /(^|[，、。！？…~（(「『\n])(?:他|她|我)?怔了怔(?=[，、。！？…~）)」』\n]|$)(?![，、。！？…~][才就又便])[，、。！？…~]?/g, prefix: true, minRest: 2, dropWhole: true },
];

/** 切句：保留句末标点，换行也算一刀 */
// ⚠️ 切句【不能用省略号当分隔符】：中文省略号是「……」，一按「…」切，
//    「谁家好人……」就碎成「谁家好人…」+「…」，后半截还会被当成独立句删掉。
//    省略号本身就是一个停顿，不该断开句子。只按 。！？和换行切。
function splitSentences(s) {
  return s.match(/[^。！？\n]*[。！？\n]+|[^。！？\n]+$/g) || [];
}

/**
 * 把括号/引号还没闭合的段并回下一段。
 * ⚠️ 切句是按「。」切的，括号会跨段：「（顿了一下，才反应过来…玩笑。）」切出来是
 *    「（顿了一下…玩笑。」+「）」，第二段只剩一个右括号。这一版之前它被当成
 *    「删完只剩标点」整段扔掉，「）」就没了；而「（她顿了顿。）」反过来剩一个孤零零的「（」。
 *    所以先按括号/引号配对把段拼回去，再洗。
 */
function mergeOpen(segs) {
  const out = [];
  let buf = '';
  for (const s of segs) {
    buf += s;
    const o = (buf.match(/[（(「『]/g) || []).length;
    const c = (buf.match(/[）)」』]/g) || []).length;
    if (o > c) continue;
    out.push(buf); buf = '';
  }
  if (buf) out.push(buf);
  return out;
}

const PUNCT_ONLY = /^[\s。！？…~，、；：,.!?;:]*$/;
const BARE_TAIL = /[，、；：,;:]\s*(?=[。！？…~】」』）)]|$)/g;
// ⚠️ 不能把省略号折叠（…… 是合法的六个点，不是重复标点）
const DUP_PUNCT = /([，、。！？])\1+/g;
const LEAD_PUNCT = /(^|[。！？…~\n「『【（(])\s*[，、；：,;:]\s*/g;
// ⚠️ 不能只认真正的空括号：删掉「（她顿了顿。）」之后剩的是「（。）」，只留一个句号。
const EMPTY_PAREN = /[（(][\s。！？…~，、；：]*[）)]/g;
// 同理，删完只剩空引号对（「他说「。」然后低下头。」）
const EMPTY_QUOTE = /[「『][\s。！？…~，、；：]*[」』]/g;
// 删完剩「这个」「那」这类纯指代时，整句已经没有信息了（见 dropWhole 注释）
const PRON_ONLY = /^(?:这|那|个|它|他|她|我|你|们|嗯|哦|行|好|是|啊|的|了|吧|呢|呀|喂|一|下)*$/;
// 删掉「我认了」之后，句子尾巴可能剩一个孤零零的指代。
// 例：「（她抬手把杯子推过来）这个我认了。」→ 删完是「（她抬手把杯子推过来）这个。」
//     —— 整句有 11 个汉字，minRest 和 dropWhole 都拦不住，可读起来就是半截话。
// ⚠️ 只在【认输系规则真的命中过】时才清句尾指代，不能全局清：
//    「我喜欢这个。」是正常句子，清了就是删人话。
const TAIL_PRON = /[，、,；;]?\s*(?:这个|那个|这话|这句|这点|这些)\s*([。！？…~」』]?)\s*$/;
const CH_RE = /[\u4e00-\u9fff]/g;

const coreLen = (s) => (s.match(CH_RE) || []).length;

const ORNAMENT = /[\s。！？…~，、；：,.!?;:（()）「」『』“”‘’【】《》]/g;

/**
 * 这一句里有没有【没闭合】的左括号。
 * ⚠️ splitSentences 按「。」切句，括号会跨段：「（她顿了顿。然后抬起头）」切出来是
 *    「（她顿了顿。」+「然后抬起头）」。第一段被整句删掉时如果连「（」一起扔了，
 *    剩下的那一半就变成一个没有开头的孤儿段（v0.5.3.4 复查实测）。
 *    所以删整句时把没配对的左括号还回去。
 */
function openTail(x) {
  const last = Math.max(x.lastIndexOf('（'), x.lastIndexOf('('));
  if (last < 0) return '';
  const rest = x.slice(last);
  const o = (rest.match(/[（(]/g) || []).length;
  const c = (rest.match(/[）)]/g) || []).length;
  return o > c ? x[last] : '';
}

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

  // ⚠️ 这里原来用 src.includes(w) 判定（v0.5.3.4 复查）：'我认得他。' 文本一个字没动，
  //    却因为含「我认」记了一条 hits，[去味] 日志里就成了假命中。改成只在【真删掉】时 note。
  for (const w of extraBanned) if (w && src.includes(w)) note(w);

  let out = mergeOpen(splitSentences(src)).map(seg => {
    // 1) 整句就是一句认输 —— 连句带标点一起没了
    // ⚠️ 引号也要剥（v0.5.3.4 复查）：'「我认。」' 原来剥完是「「我认」」，对不上表，
    //    结果只剩一个孤立的后引号留在正文里。
    const bare = seg.replace(ORNAMENT, '');
    if (DROP_SENTENCE.includes(bare)) { note(bare); return openTail(seg); }

    // 2) 句内整块删除
    let s = seg;
    for (const rule of DROP_CLAUSE) {
      rule.re.lastIndex = 0;
      const mm = s.match(rule.re);
      if (!mm) continue;
      let cand = rule.prefix
        ? s.replace(rule.re, '$1')
        : s.replace(rule.re, '');
      // 尾巴上的孤立指代（见 TAIL_PRON）：只对认输系做，且保留句末标点
      if (rule.tailPron) cand = cand.replace(TAIL_PRON, '$1');
      // dropWhole 先判：剩「这个」「那」这种纯指代时整句删，不受 minRest 限制。
      // （minRest 是 2，而「这个。」正好剩 2 个汉字，改之前刚好卡在边界上被放行。）
      if (rule.dropWhole) {
        const rest = cand.replace(/[^\u4e00-\u9fff]/g, '');
        if (rest.length <= 3 && PRON_ONLY.test(rest)) {
          for (const x of mm) note(x);
          return openTail(seg);
        }
      }
      if (rule.minRest && coreLen(cand) < rule.minRest) {
        // dropWhole：删完只剩「这个」「那」这类指代，整句已经没有信息了 —— 整句删。
        // 不加这条的话「这个我认了。」会被啃成「这个。」，比原句更像套话。
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

    // 4) 删完只剩标点/空白/装饰符号 → 整句不要
    //    ⚠️ 加 ORNAMENT 判据：「「我认。」」被切句切成「「我认。」+「」」两段，
    //    第二段只有一个后引号，PUNCT_ONLY 不认识引号，于是留了一个孤儿「」」在正文里。
    if (PUNCT_ONLY.test(s) || !s.replace(ORNAMENT, '')) return '';
    return s;
  }).join('');

  // 收尾清理：句尾残留逗号、重复标点、句首冒出的逗号、空括号
  out = out.replace(BARE_TAIL, '').replace(DUP_PUNCT, '$1').replace(LEAD_PUNCT, '$1').replace(EMPTY_PAREN, '').replace(EMPTY_QUOTE, '');
  out = out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
  return { text: out, hits };
}

/** 这个模型要不要吃这张表（模型名或厂商名里带 deepseek 就算） */
function usesTable(model) {
  const m = String(model || '').toLowerCase();
  return m.includes('deepseek') || m === '';
}

/**
 * 按模型洗。
 *
 * 分档的意义不是"多删点"，而是"换模型时别乱删"：
 * 你把接口换成一家我们没测过的模型，它正常用「认」这个词表达"承认"，
 * 整句照删就会把她的话删残。所以只有实测过的模型才套那张表。
 *
 * 替换层（方案里写的「整句删 → 词 → 词替换」）故意【没有做】：
 *   词替换要有「哪个词该换成什么」的可靠映射。我们没有这个数据 ——
 *   能确定的只有"这个词出现得太频繁"，不确定"换成什么才像她"。
 *   硬编一张同义表，等于把我自己的措辞当成她的，比不换更糟。
 *   真要做，得先有「同一情境下不同角色的说法」语料，再谈映射。
 *
 * @param {string} text
 * @param {{model?: string, provider?: string, extraBanned?: string[]}} [opts]
 * @returns {{ text: string, hits: string[] }}
 */
export function deflavorFor(text, opts = {}) {
  const o = opts || {};
  const extra = Array.isArray(o.extraBanned) ? o.extraBanned : [];
  if (usesTable(o.model)) return deflavor(text, extra);
  // 没实测过的模型：只跑用户自己加的禁用词，不套 DeepSeek 那张表
  const src = String(text ?? '');
  if (!src) return { text: src, hits: [] };
  const hits = [];
  let out = src;
  for (const w of extra) {
    if (!w) continue;
    if (out.includes(w)) { hits.push(w); out = out.split(w).join(''); }
  }
  return { text: out, hits };
}

