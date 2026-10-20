// 长期记忆的时间锚与来源（M0.6 / 0.5.2）
//
// 这一层只做纯数据变换，不碰 IndexedDB、不碰 DOM、不调模型。
//
// 为什么需要它：
//   旧记忆只存一句自由文本。第 2 天记下「他明天休息一天」，到第 3 天提示词里
//   仍然只有「他明天休息一天」——模型没有"这句话是第 2 天说的"这个信息，
//   只能按今天重新解释「明天」，于是第 3 天还在说「你明天休息一天」。
//
//   修法不是让模型更聪明，而是把【记下这条时的剧情天数】一起存下来：
//     · 正文在写入时就把「今天/明天/后天/昨天」换算成「第 N 天」；
//     · 注入时在每条前面加「第 N 天记下：」，并把当天是第几天写进提示词；
//     · 来源消息 id 一起存，后面做记忆回链/审计时不用再猜。

// EXPIRED（v0.5.1.1）：事件型记忆过了限期不再【物理删掉】，只标成过期。
// 原来 pruneMemories 直接 mem.del —— 用户只会觉得"她忘了"，而且没有任何痕迹可查。
// 现在留在库里、记忆页看得见、点一下还能恢复（恢复时把限期清掉，否则下一轮又过期）。
export const MEMORY_STATUS = { ACTIVE: 'active', SUPERSEDED: 'superseded', EXPIRED: 'expired' };

// 记忆的「槽位」（v0.5.1.1 / M0.6）。
//
// 为什么要有 key：
//   记忆是流水账，同一个人「在做什么工作」可能被记三条：程序员 → 被裁员 → 接了外包。
//   三条都 active 一起注入，模型会同时在三个状态里挑，说出「你是程序员」还是
//   「你刚失业」全靠运气 —— 这就是"记忆混乱"里除时间错乱之外的另一半。
//
// 为什么只认白名单：
//   模型是自由给 key 的。要是任何字符串都算槽位，它给两条不相干的事实随手填同一个
//   key（比如都填「他」），就会把一条活记忆顶成 superseded —— 用户看着记忆凭空消失。
//   所以这里只认一组固定槽位；不在表里的 key 一律当空，宁可不取代，也不误伤。
export const MEMORY_KEYS = ['职业', '住处', '关系', '称呼', '年龄', '身体', '宠物', '爱好', '计划', '物品'];
const KEY_SET = new Set(MEMORY_KEYS);

/** 槽位归一：只保留白名单里的，其它一律成空串 */
export function memoryKey(v) {
  const s = String(v == null ? '' : v).trim();
  return KEY_SET.has(s) ? s : '';
}

/**
 * 一条新记忆会把哪些旧记忆顶成 superseded。
 *
 * 条件全部满足才算同一个槽位的新旧说法：
 *   · 两边 key 都在白名单里且相同
 *   · kind 相同（事实不会被一条带限期的安排顶掉）
 *   · mine 相同（他自己写的，不会被模型抽出来的顶掉；反之亦然）
 *   · 正文不完全一样（一模一样的交给去重，不叫取代）
 *
 * 只返回 id 列表，不碰存储：真正的写入在 db.js 的 mem.add 里做，
 * 这样 7 个写入点不用各改一遍。
 * @returns {string[]}
 */
export function planSupersede(rec, list) {
  const key = memoryKey(rec && rec.key);
  if (!key) return [];
  const kind = String((rec && rec.kind) || 'fact');
  const mine = (rec && rec.mine) === true;
  const out = [];
  for (const old of (Array.isArray(list) ? list : [])) {
    if (!old || !old.id || old.id === rec.id) continue;
    if (!isActiveMemory(old)) continue;
    if (memoryKey(old.key) !== key) continue;
    if (String(old.kind || 'fact') !== kind) continue;
    if ((old.mine === true) !== mine) continue;
    if (sameMemory(old, rec)) continue;
    out.push(old.id);
  }
  return out;
}

/** 取一个合法的剧情天数；不合法返回 null */
export function memoryDay(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : null;
}

/**
 * 记忆记录归一化。
 * - 老数据补 status/sourceMsgIds/day/legacy，避免页面和提示词到处判 undefined
 * - 新数据显式传 legacy:false
 * - 不覆盖已有合法字段；未知字段原样保留（导入/撤销要能带回来）
 */
/**
 * @param {any} m
 * @param {number} [now]
 * @returns {any}
 */
export function normalizeMemory(m = {}, now = Date.now()) {
  const out = { ...m };
  if (!out.id) out.id = 'mem-' + now.toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  out.text = String(out.text == null ? '' : out.text);
  out.status = (out.status === MEMORY_STATUS.SUPERSEDED || out.status === MEMORY_STATUS.EXPIRED)
    ? out.status : MEMORY_STATUS.ACTIVE;
  out.day = memoryDay(out.day);
  const src = Array.isArray(out.sourceMsgIds) ? out.sourceMsgIds : (Array.isArray(out.srcIds) ? out.srcIds : []);
  out.sourceMsgIds = [...new Set(src.filter(x => typeof x === 'string' && x))].slice(0, 200);
  // 注意：这里默认 true 是给【老数据/老备份】用的；新写入必须显式传 false。
  out.legacy = out.legacy === true;
  // 槽位（见上面 MEMORY_KEYS 的说明）。白名单外的一律清空。
  out.key = memoryKey(out.key);
  if (typeof out.ts !== 'number' || !Number.isFinite(out.ts)) out.ts = now;
  return out;
}

/** 只有 active 才进提示词、才算"她还记得" */
export function isActiveMemory(m) {
  return !!m && m.status !== MEMORY_STATUS.SUPERSEDED && m.status !== MEMORY_STATUS.EXPIRED;
}

/**
 * 两条记忆是不是同一件事（用于写入前挡重复）。
 * 只比较正文、类型、失效日；空格差异不算不同。
 * 注意：这不是语义查重 —— 换个说法讲同一件事仍然要等 dedupe 去合并。
 */
export function sameMemory(a, b) {
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, '');
  if (norm(a && a.text) !== norm(b && b.text)) return false;
  if (String((a && a.kind) || 'fact') !== String((b && b.kind) || 'fact')) return false;
  const da = a && a.untilDay != null ? Number(a.untilDay) : null;
  const db = b && b.untilDay != null ? Number(b.untilDay) : null;
  return da === db || (Number.isNaN(da) && Number.isNaN(db));
}

export function activeOnly(list) {
  return (Array.isArray(list) ? list : []).filter(isActiveMemory);
}

/**
 * 把相对日期换算成绝对剧情天数。
 *
 * 例：day=2 时「他明天休息一天」→「他第 3 天休息一天」
 *     day=2 时「昨晚他来过」→「第 1 天晚上他来过」
 *
 * 只做词面替换，不尝试理解句子。替换不改变句子其余部分。
 * 第 1 天说「昨天」时不能写成「第 0 天」——改成「故事开始前」。
 */
/** @type {[string, number, string][]} */
const REL_DAY_WORDS = [
  // 长词必须先替换，否则「大后天」会先命中「后天」
  ['大后天', 3, ''],
  ['大前天', -3, ''],
  ['后天', 2, ''],
  ['前天', -2, ''],
  ['明天早上', 1, '早上'],
  ['明天早晨', 1, '早上'],
  ['明天晚上', 1, '晚上'],
  ['明天', 1, ''],
  ['明日', 1, ''],
  ['明早', 1, '早上'],
  ['明晨', 1, '早上'],
  ['明晚', 1, '晚上'],
  ['今天早上', 0, '早上'],
  ['今天早晨', 0, '早上'],
  ['今天晚上', 0, '晚上'],
  ['今天', 0, ''],
  ['今日', 0, ''],
  ['今早', 0, '早上'],
  ['今晨', 0, '早上'],
  ['今晚', 0, '晚上'],
  ['昨天早上', -1, '早上'],
  ['昨天早晨', -1, '早上'],
  ['昨天晚上', -1, '晚上'],
  ['昨天', -1, ''],
  ['昨日', -1, ''],
  ['昨晚', -1, '晚上'],
];

export function hasRelativeDay(text) {
  const s = String(text || '');
  return REL_DAY_WORDS.some(([w]) => s.includes(w));
}

export function absolutizeMemoryText(text, day) {
  let s = String(text == null ? '' : text);
  const d = memoryDay(day);
  if (!d) return s;
  for (const [word, delta, suffix] of REL_DAY_WORDS) {
    if (!s.includes(word)) continue;
    const target = d + delta;
    const label = target >= 1 ? ('第 ' + target + ' 天' + suffix) : '故事开始前';
    s = s.split(word).join(label);
  }
  return s;
}

/** 给模型看的时间规则；day 非法时返回空串 */
export function memoryTimeRule(day) {
  const d = memoryDay(day);
  if (!d) return '';
  const yesterday = d > 1 ? ('第 ' + (d - 1) + ' 天') : '故事开始前';
  return '【时间锚 · 必须遵守】现在是剧情第 ' + d + ' 天。记忆正文里不要出现「今天/明天/后天/昨天/前天」这类相对日期——'
    + '过几天再看就不知道是哪天了。一律换算成绝对天数：今天=第 ' + d + ' 天，明天=第 ' + (d + 1) + ' 天，'
    + '后天=第 ' + (d + 2) + ' 天，昨天=' + yesterday + '。'
    + '例如「他明天休息」要写成「他第 ' + (d + 1) + ' 天休息」。'
    + '如果他原话是「第二天」「过两天」，也按他说话的那天往后数，写成具体第几天。\n\n';
}

/**
 * 注入提示词时的一行。
 * day 已知就带「第 N 天记下」；event 还带失效日，避免模型把过期的事当现在。
 */
export function memoryLine(m) {
  const rec = m || {};
  const text = String(rec.text == null ? '' : rec.text);
  let out = text;
  if (memoryDay(rec.day)) out = '第 ' + memoryDay(rec.day) + ' 天记下：' + out;
  // 老记忆没有 day，正文里又留着「明天/昨天」：模型会按【今天】重新解释，
  // 于是第 3 天还在说「你明天休息」。这里明确告诉它这句的日期不可信。
  else if (rec.legacy === true && hasRelativeDay(text)) {
    out = text + '（旧记忆·日期不明，里面的今天/明天/昨天不要按现在推算）';
  }
  if (rec.kind === 'event' && memoryDay(rec.untilDay)) {
    const hh = (typeof rec.untilHour === 'number')
      ? ' ' + String(rec.untilHour).padStart(2, '0') + ':' + String(rec.untilMinute || 0).padStart(2, '0')
      : '';
    out += '（第 ' + memoryDay(rec.untilDay) + ' 天' + hh + '前有效）';
  }
  return out;
}

/** 中文/字母数字的二元组；标点与空白不参与，避免「，」把相似度抬高 */
function grams(text) {
  const s = String(text || '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '');
  const set = new Set();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}

/** 给 app.js 的旧记忆修复用；不导出内部实现，只暴露二元组集合 */
export function memoryGrams(text) {
  return grams(text);
}

/**
 * 整理记忆（合并/压缩）后，为新条目找回来源。
 *
 * 模型只被允许输出 text/kind/untilDay/untilHour/untilMinute/freq/key 这几个字段，
 * 不会带回 day/sourceMsgIds。这里用二元组重合度找最像的旧条目：
 *   · 取重合度最高、且不低于阈值的前几条
 *   · day 取其中最早的那天（合并后仍能追溯到"最早什么时候记下的"）
 *   · sourceMsgIds 取并集
 *   · 全都没来源时才标记 legacy
 *
 * 这是启发式，不保证精确；但比整理一次就丢掉全部来源强得多。
 */
export function provenanceFor(text, oldList) {
  const list = (Array.isArray(oldList) ? oldList : []).filter(m => m && m.text);
  const g = grams(text);
  if (!g.size || !list.length) return { day: null, sourceMsgIds: [], legacy: true };
  const scored = list.map(m => {
    const og = grams(m.text);
    let hit = 0;
    for (const x of g) if (og.has(x)) hit++;
    return { m, hit };
  }).filter(x => x.hit > 0).sort((a, b) => b.hit - a.hit);
  if (!scored.length) return { day: null, sourceMsgIds: [], legacy: true };
  const best = scored[0].hit;
  const need = Math.max(1, Math.min(2, Math.ceil(g.size * 0.15)));
  if (best < need) return { day: null, sourceMsgIds: [], legacy: true };
  // 只收和最佳条目接近的，避免把整个记忆库的来源全并进来
  const picked = scored.filter(x => x.hit >= Math.max(need, Math.ceil(best * 0.6))).slice(0, 4);
  const days = picked.map(x => memoryDay(x.m.day)).filter(Boolean);
  const source = [];
  for (const x of picked) {
    for (const id of (x.m.sourceMsgIds || [])) if (!source.includes(id)) source.push(id);
  }
  return {
    day: days.length ? Math.min(...days) : null,
    sourceMsgIds: source.slice(0, 200),
    legacy: picked.every(x => x.m.legacy === true),
  };
}
