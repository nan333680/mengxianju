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
//
// ── 记忆 OS（0.5.2.1 实装）追加了什么 ──────────────────────────────
//   一条记忆从"一句话"变成"一张卡"。新增字段全部有默认值，老数据老备份直接读：
//     kind    事实/事件/状态/信念/关系/物品/计划 —— 决定能不能自动取代（§6.1）
//     scope   character/branch/scene —— 决定在当前分支下算不算数（§5.2）
//     subject 这条话说的是谁（user/char/npc/world）
//     who     谁知道（fact 留空；belief 必填，且只和同 who 的 belief 冲突）
//     quote   来源原话（最多 80 字，没有就留空，绝不编）
//     status  多了 deleted（软删）/ draft（收件箱，不注入）
//     pinned  用户手动钉住，预算不够时第一个留下（§5.3）
//   key 也从"10 个中文白名单词"扩成"点号命名空间"（identity.job / location.home …）。
//   中文白名单仍然认，否则老库里那些 key 一夜之间全变成空槽位、再也不取代。

// EXPIRED（v0.5.1.1）：事件型记忆过了限期不再【物理删掉】，只标成过期。
// 原来 pruneMemories 直接 mem.del —— 用户只会觉得"她忘了"，而且没有任何痕迹可查。
// 现在留在库里、记忆页看得见、点一下还能恢复（恢复时把限期清掉，否则下一轮又过期）。
//
// DELETED（记忆 OS §6.3）：用户点删除 = 软删。不物理删的理由和 EXPIRED 一样，
// 但更强：误删一条关系记忆是没法从聊天记录里找回来的。30 天后才允许清理。
// DRAFT（记忆 OS §4.3）：进收件箱、等用户确认，**不注入**。分不清新旧的冲突进这里。
export const MEMORY_STATUS = {
  ACTIVE: 'active',
  SUPERSEDED: 'superseded',
  EXPIRED: 'expired',
  DELETED: 'deleted',
  DRAFT: 'draft'
};
const STATUS_SET = new Set([MEMORY_STATUS.ACTIVE, MEMORY_STATUS.SUPERSEDED, MEMORY_STATUS.EXPIRED, MEMORY_STATUS.DELETED, MEMORY_STATUS.DRAFT]);

// promise（记忆经历化）：答应过的事。它和 goal 的区别是【有对家】——
// 「她想考个好成绩」是 goal，「她答应过他明天把书还回来」是 promise。
// 承诺没兑现之前一直算数，所以它默认参与注入，也不会被同类新条目取代（见 planSupersede）。
export const MEMORY_KINDS = ['fact', 'event', 'state', 'belief', 'relationship', 'item', 'goal', 'promise'];
const KIND_SET = new Set(MEMORY_KINDS);
export const MEMORY_KIND_NAME = { fact: '事实', event: '事件', state: '状态', belief: '她以为', relationship: '关系', item: '物品', goal: '计划', promise: '约定' };

export const MEMORY_SCOPES = ['character', 'branch', 'scene'];
const SCOPE_SET = new Set(MEMORY_SCOPES);
export const MEMORY_SCOPE_NAME = { character: '一直算数', branch: '只在这一条线', scene: '只在小说里' };

export const MEMORY_SUBJECTS = ['user', 'char', 'npc', 'world'];
const SUBJECT_SET = new Set(MEMORY_SUBJECTS);
export const MEMORY_SUBJECT_NAME = { user: '他', char: '她', npc: '旁人', world: '世界' };

export const MEMORY_SOURCES = ['message', 'summary', 'arc', 'scene', 'manual'];
const SOURCE_SET = new Set(MEMORY_SOURCES);
export const MEMORY_SOURCE_NAME = { message: '聊天原话', summary: '总结', arc: '剧情卡', scene: '小说', manual: '手动添加' };

export const MEMORY_STATUS_NAME = {
  active: '算数',
  superseded: '已被取代',
  expired: '已过期',
  deleted: '已删除',
  draft: '待确认'
};

// 记忆的「槽位」（v0.5.1.1 / M0.6）。
//
// 为什么要有 key：
//   记忆是流水账，同一个人「在做什么工作」可能被记三条：程序员 → 被裁员 → 接了外包。
//   三条都 active 一起注入，模型会同时在三个状态里挑，说出「你是程序员」还是
//   「你刚失业」全靠运气 —— 这就是"记忆混乱"里除时间错乱之外的另一半。
//
// 为什么只认有限的形式：
//   模型是自由给 key 的。要是任何字符串都算槽位，它给两条不相干的事实随手填同一个
//   key（比如都填「他」），就会把一条活记忆顶成 superseded —— 用户看着记忆凭空消失。
//   所以只认两组：老的中文白名单（兼容老库），和 8 个点号前缀 + 短后缀（记忆 OS 规格）。
//   其余一律当空，宁可不取代，也不误伤。
export const MEMORY_KEYS = ['职业', '住处', '关系', '称呼', '年龄', '身体', '宠物', '爱好', '计划', '物品'];
const KEY_SET = new Set(MEMORY_KEYS);

// 点号槽位：前缀固定，后缀 1-24 个字符、不许有点和空白。
// 后缀允许中文（item.钥匙 / location.老家院子 这种用户自己写的也认）。
export const MEMORY_KEY_PREFIXES = ['identity', 'location', 'body', 'relationship', 'address', 'goal', 'item', 'belief'];
const KEY_DOTTED = /^(identity|location|body|relationship|address|goal|item|belief)\.[^\s.]{1,24}$/;

/** 槽位归一：认中文白名单 + 点号命名空间，其余一律成空串 */
export function memoryKey(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  if (KEY_SET.has(s)) return s;
  const low = s.toLowerCase();
  return KEY_DOTTED.test(low) ? low : '';
}

/** key 是不是「用户自己起的名字」（不在白名单也不合点号格式）—— 存的时候会被清空，UI 要提示 */
export function keyWasDropped(v) {
  const s = String(v == null ? '' : v).trim();
  return !!s && memoryKey(s) === '';
}

/**
 * 一条新记忆会把哪些旧记忆标成 superseded。
 *
 * 条件全部满足才算同一个槽位的新旧说法（记忆 OS §6.1）：
 *   · 两边 key 都合法且相同（空槽位不参与取代）
 *   · subject 相同（说的是同一个人）
 *   · kind 相同（事实不会被一条带限期的安排顶掉）
 *   · belief 只和同 who 的 belief 冲突 —— 她以为 A 和她以为 B 可以并存
 *   · mine 相同（他自己写的，不会被模型抽出来的顶掉；反之亦然）
 *   · 正文不完全一样（一模一样的交给去重，不叫取代）
 *
 * event 不参与（发生过的事不该被后来说法抹掉）；state 走 planExpire
 * （标"过期"而不是"被取代"，语义不同，记忆页要分开显示）。
 *
 * 只返回 id 列表，不碰存储：真正的写入在 db.js 的 mem.add 里做，
 * 这样所有写入点不用各改一遍。
 * @returns {string[]}
 */
export function planSupersede(rec, list) {
  const key = memoryKey(rec && rec.key);
  if (!key) return [];
  const kind = String((rec && rec.kind) || 'fact');
  if (kind === 'event' || kind === 'state') return [];
  const subject = String((rec && rec.subject) || 'char');
  const mine = (rec && rec.mine) === true;
  const who = String((rec && rec.who) || '').trim();
  const out = [];
  for (const old of (Array.isArray(list) ? list : [])) {
    if (!old || !old.id || old.id === rec.id) continue;
    if (!isActiveMemory(old)) continue;
    if (memoryKey(old.key) !== key) continue;
    if (String(old.subject || 'char') !== subject) continue;
    // scope 不同不算同一个槽位（v0.5.2.2，外部评审 P1-2）：
    // 「只在这一条线上」的说法不该顶掉「一直算数」的说法，反过来也不行。
    if (String(old.scope || 'character') !== String(rec.scope || 'character')) continue;
    if (String(old.kind || 'fact') !== kind) continue;
    // 没兑现的承诺不该被新的顶掉：一个人可以同时答应过好几件事，
    // 用「同槽位」那套去取代，等于她答应第二件事的那一秒就把第一件忘了。
    if (kind === 'promise' && old.open === true) continue;
    if (kind === 'belief') {
      if (String(old.who || '').trim() !== who) continue;
    }
    if ((old.mine === true) !== mine) continue;
    if (sameMemory(old, rec)) continue;
    out.push(old.id);
  }
  return out;
}

/**
 * 同槽位的旧 state 该怎么过期（记忆 OS §6.1）。
 *
 * 状态不是"被新说法取代"，而是"到某个时点为止是这样"：
 *   新 state 的 sinceDay 比旧的晚、旧的又没有 untilDay → 旧的 untilDay = 新的 sinceDay，标 expired
 *   起始日不知道 → 也不能两条 active 并存，旧的一样过期，只是没有准确限期
 *
 * @returns {{id: string, untilDay: number|null}[]}
 */
export function planExpire(rec, list) {
  const key = memoryKey(rec && rec.key);
  if (!key) return [];
  if (String((rec && rec.kind) || '') !== 'state') return [];
  // 起点不知道就退回"记下它的那一天"；两个都拿不到就是 0（未知）。
  const since = memoryDay(rec.sinceDay) || memoryDay(rec.day) || 0;
  const subject = String((rec && rec.subject) || 'char');
  const mine = (rec && rec.mine) === true;
  const scope = String((rec && rec.scope) || 'character');
  const out = [];
  for (const old of (Array.isArray(list) ? list : [])) {
    if (!old || !old.id || old.id === rec.id) continue;
    if (!isActiveMemory(old)) continue;
    if (memoryKey(old.key) !== key) continue;
    if (String(old.kind || '') !== 'state') continue;
    // ⚠️ 只有"同一个人的同一件事"才互斥（v0.5.2.2，外部评审 P1-2）。
    // 原来一个字都不比，于是「关于他」的 state 会把「关于她」的同 key state 顶掉，
    // 模型抽的会把用户手写的顶掉，A 分支的会把 B 分支的顶掉。
    if (String(old.subject || 'char') !== subject) continue;
    if ((old.mine === true) !== mine) continue;
    if (String(old.scope || 'character') !== scope) continue;
    if (sameMemory(old, rec)) continue;
    const oSince = memoryDay(old.sinceDay) || memoryDay(old.day) || 0;
    const oUntil = memoryDay(old.untilDay);
    // ⚠️ 新的不比旧的晚就别动旧的（v0.5.2.2，外部评审 P1-8）。
    // 原来是 since 为空或 since <= oSince 时照样把旧 state 推进 out ——
    // 历史回填 / 导入旧备份 / 模型漏填 sinceDay 都会把当前状态误过期，
    // 再叠上 pruneMemories 每轮重跑，就是"她莫名其妙忘了自己住哪"。
    if (since && oSince && since <= oSince) continue;
    out.push({ id: old.id, untilDay: (since && (!oUntil || oUntil >= since)) ? since : (oUntil || null) });
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
 * - 老数据补 v/kind/scope/subject/sourceKind/status/sourceMsgIds/day/legacy 等，
 *   避免页面和提示词到处判 undefined
 * - 新数据显式传 legacy:false
 * - 不覆盖已有合法字段；未知字段原样保留（导入/撤销要能带回来）
 * - 幂等：同一条记录跑两遍结果一样（迁移会反复跑到它）
 */
/**
 * @param {any} m
 * @param {number} [now]
 * @returns {any}
 */
export function normalizeMemory(m = {}, now = Date.now()) {
  const out = { ...m };
  if (!out.id) out.id = 'mem-' + now.toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  out.v = 2;
  out.text = String(out.text == null ? '' : out.text);
  out.kind = KIND_SET.has(out.kind) ? out.kind : (out.kind === 'event' ? 'event' : 'fact');
  out.scope = SCOPE_SET.has(out.scope) ? out.scope : 'character';
  out.subject = SUBJECT_SET.has(out.subject) ? out.subject : 'char';
  out.status = STATUS_SET.has(out.status) ? out.status : MEMORY_STATUS.ACTIVE;
  out.day = memoryDay(out.day);
  out.sinceDay = memoryDay(out.sinceDay);
  out.untilDay = memoryDay(out.untilDay);
  const src = Array.isArray(out.sourceMsgIds) ? out.sourceMsgIds : (Array.isArray(out.srcIds) ? out.srcIds : []);
  out.sourceMsgIds = [...new Set(src.filter(x => typeof x === 'string' && x))].slice(0, 200);
  // 来源类型：没写就按"有没有来源消息"倒推（§9 的迁移规则）
  out.sourceKind = SOURCE_SET.has(out.sourceKind)
    ? out.sourceKind
    : (out.sourceMsgIds.length ? 'message' : 'manual');
  out.sourceSceneId = String(out.sourceSceneId == null ? '' : out.sourceSceneId);
  out.quote = String(out.quote == null ? '' : out.quote).slice(0, 80);
  out.who = String(out.who == null ? '' : out.who).trim().slice(0, 40);
  // 注意：这里默认 false 是给【老数据/老备份】用的；新写入可以显式传 false。
  out.legacy = out.legacy === true;
  out.needsSplit = out.needsSplit === true;
  out.pinned = out.pinned === true;
  // —— 记忆经历化新增的两个维度 ——
  // heat：这条记忆【有多重】。1~5，0 = 没标（老数据）。检索评分里占 0.25 权重：
  //       同样是「他来过」，「他摔门走了」该压过「他敲了两下门」。
  //       不让模型自己报数字——它也报不准；由提炼器按措辞判，判不出就留 0。
  // open：这件事【还没完】。承诺、没问出口的话、没解决的矛盾都算。占 0.20 权重，
  //       也是「她突然想起来」的抽取条件之一（见 mempick 的 pickCallback）。
  out.heat = (() => { const n = Number(out.heat); return Number.isFinite(n) ? Math.max(0, Math.min(5, Math.round(n))) : 0; })();
  out.open = out.open === true;
  // 槽位（见上面 MEMORY_KEYS 的说明）。不合格式的一律清空。
  out.key = memoryKey(out.key);
  out.supersedes = (Array.isArray(out.supersedes) ? out.supersedes : []).filter(x => typeof x === 'string' && x).slice(0, 20);
  out.supersededBy = typeof out.supersededBy === 'string' ? out.supersededBy : '';
  out.deletedAt = (typeof out.deletedAt === 'number' && Number.isFinite(out.deletedAt)) ? out.deletedAt : null;
  if (typeof out.createdAt !== 'number' || !Number.isFinite(out.createdAt)) out.createdAt = now;
  if (typeof out.updatedAt !== 'number' || !Number.isFinite(out.updatedAt)) out.updatedAt = now;
  if (typeof out.ts !== 'number' || !Number.isFinite(out.ts)) out.ts = now;
  return out;
}

/**
 * 只有 active 才进提示词、才算"她还记得"（deleted/draft 也不进）
 *
 * ⚠️ status 缺失也当 active。库里那些没走过 normalizeMemory 的记录（v2 之前的老库、
 * 老备份直接导入、以及外部脚本/测试直接 put 的）status 是 undefined，收紧成
 * `=== ACTIVE` 会让存量记忆一夜之间全部静默消失 —— 这是"数据看起来还在、她却不记得"
 * 最典型的一种。deleted/draft 这些是明确写进去的，照样排除。
 */
export function isActiveMemory(m) {
  return !!m && (!m.status || m.status === MEMORY_STATUS.ACTIVE);
}

/**
 * 这条能不能不经用户确认就落库（记忆 OS §4.3）。
 *
 * 进收件箱（status=draft，不注入）的三条硬理由：
 *   · 信念 / 计划 —— 她的看法和打算不能由提炼器替她定，必须他点头
 *   · 没有来源消息 —— 连"从哪听来的"都答不上，不该算发生过
 *   · 措辞含糊（可能 / 也许 / 似乎…）—— 这是推测，不是事实
 *
 * ⚠️ 规格原文还有两条：槽位为空、来源是摘要。实测下来【不能当拒绝理由】，
 *    这里故意降级成"记录原因但不拦"：
 *
 *    · 槽位：提炼器（deepseek-flash，实测 2026-10-22）绝大多数输出不带 key ——
 *      模型能写出「他在城西租了房」，但不习惯同时给出 location.home。
 *      照字面执行 = 几乎所有记忆都落进收件箱 = 长期记忆整体不进提示词，
 *      用户感受到的是"记忆功能坏了"，而收件箱里躺着几百条没人看。
 *      槽位为空的代价只是这一条不参与自动取代（planSupersede 本来就要求 key 非空），
 *      不会顶掉任何东西。
 *    · 来源类型：sourceMsgIds 是【确定的】那一批消息，summary 只表示
 *      "定位不到具体某一句"。它影响的是能不能一键跳到原话，
 *      不影响这件事有没有发生过 —— 而 §1 要求的"知道从哪来"，靠 id 已经成立。
 *
 * 这条判断写在这里、而不是散在 app.js 的三处调用点上，就是为了将来只改一处。
 *
 * @returns {{ok: boolean, why: string, note?: string}}
 */
const HEDGE_RE = /可能|也许|似乎|大概|或许|好像|应该是/;
export function shouldAutoCommit(rec) {
  if (!rec || !String(rec.text || '').trim()) return { ok: false, why: '内容为空' };
  const kind = String(rec.kind || 'fact');
  if (kind === 'belief' || kind === 'goal') return { ok: false, why: '信念和计划要先确认' };
  const src = Array.isArray(rec.sourceMsgIds) ? rec.sourceMsgIds.filter(Boolean) : [];
  if (!src.length) return { ok: false, why: '没有来源消息' };
  if (HEDGE_RE.test(String(rec.text))) return { ok: false, why: '措辞不确定' };
  const notes = [];
  if (!memoryKey(rec.key)) notes.push('没有槽位');
  if (String(rec.sourceKind || '') === 'summary') notes.push('来源是整批摘要');
  return { ok: true, why: '', note: notes.join('、') };
}

/**
 * 两条记忆是不是同一件事（用于写入前挡重复）。
 * 只比较正文、类型、失效日；空格差异不算不同。
 * 注意：这不是语义查重 —— 换个说法讲同一件事仍然要等去重去合并。
 */
export function sameMemory(a, b) {
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, '');
  if (norm(a && a.text) !== norm(b && b.text)) return false;
  if (String((a && a.kind) || 'fact') !== String((b && b.kind) || 'fact')) return false;
  // ⚠️ subject / scope / mine 也要一致（v0.5.2.2，外部评审 P1-5）。
  // 原来只比正文 + kind + 失效日 → 同一句话出现在「他」和「她」两个 subject、
  // 或 character / branch 两个 scope 时会被当成同一条：来源并进错的那条，
  // 新记忆干脆不写（静默丢一条）。mine 不同同理：用户手写的和模型抽的不是一回事。
  if (String((a && a.subject) || 'char') !== String((b && b.subject) || 'char')) return false;
  if (String((a && a.scope) || 'character') !== String((b && b.scope) || 'character')) return false;
  if (((a && a.mine) === true) !== ((b && b.mine) === true)) return false;
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
 * belief（她以为）要单独标明 —— 不然模型会把她的误解当成世界事实复述给用户。
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
  if (rec.kind === 'belief') out = '（她以为，不一定真）' + out;
  if (rec.kind === 'goal') out = '（她想做的，还没做到）' + out;
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
