/**
 * 惯性动作检测（0.5.3.4）
 *
 * 为什么需要它：
 *   用户的原话是「她捏后颈我就不知道为什么要捏后颈，还改不过来，完全不符合她的设定」。
 *   查过 2026-10-18 的备份（1708 条 assistant / 19 个角色）：
 *     · 「后颈」出现在 86 条消息里，跨 12 个角色；而 19 个角色的人设里一次都没有。
 *     · 世界书里只有 5 个角色写到「颈侧 / 颈窝 / 下巴、后颈」—— 只能解释一半，
 *       另一半是模型自己的动作模板，以及【她写过的每一条都在下一轮被当范例回灌】。
 *   所以提示词里写「不要重复同一个动作」没有用（抽象禁令服从度低），
 *   得给它一份【具体的、这一轮不许出现的清单】。
 *
 * 做法：扫最近 N 条她说过的话，只在括号内（动作描写里）取 4-6 字片段，
 * 按「出现在多少条消息里」计数，挑出 ≥3 条的。清单每轮重算，用过一次自然掉出去。
 *
 * ⚠️ n-gram 不许跨标点。早先没做这条隔离，抓出来的是「的时候，我」「。翅膀还」
 *    这种碎片，喂给模型等于噪音。
 */

/** 只在括号里找 —— 动作描写在括号里，说出口的话不算「动作惯性」 */
const PAREN_RE = /[（(]([^）)]*)[）)]/g;

/** 切标点：n-gram 不许跨过它 */
const SEPS = /[，。！？…、；：""''「」『』（）()\-—~\s\u3000]/;

/** 这些是通用功能词，不管出现多少次都不算"动作惯性" */
const STOP = new Set([
  '了一下', '一会儿', '一下子', '已经', '自己', '什么', '这个', '那个', '现在', '还是',
  '不是', '这样', '那样', '有点', '一点', '似乎', '好像', '其实', '所以', '但是', '因为',
  '而且', '然后', '起来', '下来', '出来', '过来', '不过', '只是', '就是', '的时候',
  '了一', '一下', '那只', '没有', '可以', '知道', '觉得', '一个人', '的时候我',
]);

/** 一条消息里所有可参与计数的片段（去重，同一条里重复出现只算 1 次） */
function gramsIn(text) {
  const out = new Set();
  PAREN_RE.lastIndex = 0;
  let m;
  while ((m = PAREN_RE.exec(text))) {
    for (const seg of m[1].split(SEPS)) {
      if (seg.length < 4) continue;
      for (let n = 4; n <= 6; n++) {
        for (let i = 0; i + n <= seg.length; i++) {
          const g = seg.slice(i, i + n);
          if (!/[\u4e00-\u9fff]/.test(g)) continue;
          if (STOP.has(g)) continue;
          if (/(.)\1{2,}/.test(g)) continue;
          out.add(g);
        }
      }
    }
  }
  return out;
}

/**
 * 找出她最近反复用的动作短语。
 * @param {string[]} msgs 最近若干条【她】的正文（越多越准，30 条够）
 * @param {{min?: number, limit?: number}} [opts] min=至少出现在几条消息里（默认 3），limit=最多给几条（默认 6）
 * @returns {string[]} 从高频到低频；样本不够时返回空数组（宁可不说，也别乱说）
 */
export function findCliches(msgs, opts = {}) {
  const min = opts.min ?? 3;
  const limit = opts.limit ?? 6;
  const list = (msgs || []).filter(Boolean).map(String);
  if (list.length < 6) return [];

  const cnt = new Map();
  for (const t of list) for (const g of gramsIn(t)) cnt.set(g, (cnt.get(g) || 0) + 1);

  const ranked = [...cnt]
    .filter(([, c]) => c >= min)
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length);

  // 同一族的变体只留一个：既去掉被更长短语包含的短短语（留「他后颈上」不留「后颈上」），
  // 也去掉只差一两个字的兄弟（「他后颈上」和「在他后颈上」同时列出来是废话）。
  // 判据：和已留下的任何一条共享 ≥4 字的连续片段，就算同族。
  const share4 = (a, b) => {
    for (let i = 0; i + 4 <= a.length; i++) if (b.includes(a.slice(i, i + 4))) return true;
    return false;
  };
  const keep = [];
  for (const [g, c] of ranked) {
    if (keep.some(([k]) => k.includes(g) || g.includes(k) || share4(k, g))) continue;
    keep.push([g, c]);
    if (keep.length >= limit) break;
  }
  return keep.map(([g]) => g);
}

/**
 * 模型自带的万能动作（0.5.3.4）
 *
 * 和 findCliches 的分工：
 *   findCliches 是【相对于当前这段对话】的高频 —— 动态，用来在提示词里说「这几轮别再用」；
 *   templateHits 是【跨角色都出现】的模型模板 —— 静态判据，用来在生成后决定「这条要重写」。
 *
 * 为什么这几个词能定罪：19 个人设里一个「颈」字都没有，但「后颈」跨 12 个角色出现 86 次；
 * 「偏头」跨 11 个角色 140 次。人设解释不了，只能解释成模型在填模板。
 * 「愣 / 声音低 / 慢慢 / 呼吸」故意不在这里 —— 那是中文常用词，拿来定罪会把正常句子也判死。
 */
export const TEMPLATE_ACTS = ['偏头', '后颈', '喉结', '眼底', '顿了一下', '顿了顿'];

/** @returns {string[]} 命中的词，按出现次数展开（一条里出现两次就是两项） */
export function templateHits(text) {
  const s = String(text || '');
  const hits = [];
  for (const w of TEMPLATE_ACTS) {
    let i = s.indexOf(w);
    while (i >= 0) { hits.push(w); i = s.indexOf(w, i + w.length); }
  }
  return hits;
}
