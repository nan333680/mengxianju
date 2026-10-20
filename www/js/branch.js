// www/js/branch.js —— 消息分支树（v0.5.1.2 / 0.5.4 的第一刀）
//
// 为什么要有这个文件：
//   v0.5.1.1 之前「从这里重聊」是【真删】—— 回到第 5 条，后面那 20 条连同它们产生的
//   记忆一起没了，而且不可逆。0.5.4 要把它改成【非破坏】：消息带 parentId 连成一棵树，
//   「重聊」只是把【活动叶子】挪回那个分叉点，旧的那一支原地留着，随时能切回来。
//
// 老数据怎么办（这是最容易骗自己的地方）：
//   0.5.4 之前的消息【没有 parentId】。这里不猜、也不静默改写 —— 打开角色时跑一次
//   seedParents()：按 ts 升序把缺 parentId 的那些串成一条链，写回库，然后记一个
//   kv 标记（'brSeeded:<charId>'），以后不再跑。串链是【按时间顺序】串的，
//   而 0.5.4 之前的历史本来就是一条直线，所以这个推断是确定的，不是猜测。
//
// ⚠️ 分支只影响【看得见的东西】和【喂给模型的历史】。归档、统计、导出、记忆整理
//    仍走全量消息 —— 一条被切走的分支不该从备份里消失。

import { kv, msgs } from './db.js';

/** 这条消息属于哪一支的叶子（每个角色一份）。空 = 用时间上最后那条。 */
export const leafKey = (charId) => 'branch:' + charId;
const seededKey = (charId) => 'brSeeded:' + charId;

const ts = (m) => Number(m && m.ts) || 0;

/**
 * 给老消息补 parentId。只补【缺的】。
 *
 * 为什么按 ts 串：0.5.4 之前的历史是线性的（send 一条条追加），ts 就是它的顺序。
 * 分段发送时同批消息的 ts 是 base-(n-1-i)，仍然严格递增，所以串出来的链是对的。
 *
 * 返回被改动的条数（0 = 本来就是新数据，或者已经补过）。
 */
export async function seedParents(charId) {
  if (!charId) return 0;
  // ⚠️ 这里【不能】因为"串过一次"就整体跳过（v0.5.1.4 修）。
  // 起因（e2e-new 崩在「找到中间那条 AI 消息」之后）：串过链之后，任何
  // 【直接写库】进来的消息（导入旧备份、测试 seed、以后可能还有同步）都没有
  // parentId。它们不在任何一条链上 —— 从叶子回溯永远走不到，屏幕上就是
  // "消息明明在库里，却不见了"。所以每次都扫一遍，只补缺的那些；
  // 一条都不缺的时候它就是一次 getAll + 一次遍历，没有任何写入。
  const all = await msgs.list(charId, 0, true);
  const sorted = all.slice().sort((a, b) => ts(a) - ts(b));
  const missing = sorted.filter(m => typeof m.parentId !== 'string');
  if (missing.length) {
    // ⚠️ 孤儿的接法：整串接在【已连好的链末端】，不要按 ts 往中间插（v0.5.1.4 修）。
    //
    // 起因（e2e-new 的「找到中间那条 AI 消息」一直是 idx=-1）：测试往库里塞的
    // rw-a/b/c 没有 parentId，而 ts 恰好落在两条老消息【之间】。按 ts 混排着串，
    // rw-a 会被排到最前面、parentId 变成空 = 它成了新的根，老链在中间断成两截；
    // 结果 rw-a / rw-b 挂在一条断掉的链上，从叶子回溯永远走不到。
    //
    // 语义上也不该按 ts 插：已经连好的链是【定型的】，孤儿是刚被直接写进库的东西
    // （导入旧备份 / 同步 / 测试 seed），它只可能是"接着往下发生的"。所以接在末端。
    const linked = sorted.filter(m => typeof m.parentId === 'string');
    let prev = linked.length ? linked[linked.length - 1].id : '';
    for (const m of missing) { m.parentId = prev; prev = m.id; }
    await msgs.addMany(missing);
    // 补完链还要把活动叶子跟到末端（v0.5.1.4）。
    // 缺 parentId = 刚被直接写进库的东西（导入 / 同步 / 测试 seed），它一定是【新的】；
    // 叶子还停在老消息上，新补进来这几条就又看不见了。只在"末尾确实比叶子新"时推，
    // 免得把用户手动选好的分支一脚踢开。
    // ⚠️ 叶子要跟到【刚补进来的这一串的末端】，不能按 ts 推（v0.5.1.5 修）。
    //
    // 起因（e2e-menu 崩在 getBoundingClientRect 上、"渲染消息数=1"）：
    // 测试往一个已有对话里塞了 4 条 ts【更早】的消息。它们被接在老链末端
    // （拓扑上新，时间上旧），而原来这里按 ts 挑最后一条当叶子 —— 挑中的还是
    // 老链那条。于是 4 条 seed 全都在这条链上、却没有任何路径能走到它们，
    // 屏幕上只剩 1 条。真实用户会遇到的版本：把一份旧备份导进正在聊的角色。
    //
    // 边界：叶子停在【链尾】= 用户没手动选过旧分支（或者选的就是最新那条），
    // 跟上新补的这一串是本分；叶子停在链中间 = 用户明确切到了某一支，
    // 那就一条不许动 —— 补消息不该把人家正在看的分支抢走。
    const cur = await kv.get(leafKey(charId), '');
    const tailOfLinked = linked.length ? linked[linked.length - 1].id : '';
    if ((!cur || cur === tailOfLinked) && missing.length) await kv.set(leafKey(charId), missing[missing.length - 1].id);
  }
  // 标记只用来回答"这个角色串过链没有"，不再当开关用（理由见上面）。
  if (missing.length && !(await kv.get(seededKey(charId), false))) await kv.set(seededKey(charId), true);
  return missing.length;
}

/** 从一条消息回溯到根，返回【正序】的路径。遇到断链就停在那儿。 */
export function pathTo(all, leafId) {
  const byId = new Map();
  for (const m of all) if (m && m.id) byId.set(m.id, m);
  const out = [];
  const seen = new Set();
  let cur = leafId ? byId.get(leafId) : null;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.push(cur);
    cur = (typeof cur.parentId === 'string' && cur.parentId) ? byId.get(cur.parentId) : null;
  }
  out.reverse();
  return out;
}

/** 这个角色的活动叶子。存的那个已经不在了（被删 / 清了）就退回最后一条。 */
export function pickLeaf(all, want) {
  if (!all.length) return '';
  const has = want && all.some(m => m.id === want);
  if (has) return want;
  let best = all[0];
  for (const m of all) if (ts(m) >= ts(best)) best = m;
  return best.id;
}

/** 某个父节点下面、除自己以外的兄弟（按时间）。 */
export function siblings(all, m) {
  if (!m) return [];
  const p = (typeof m.parentId === 'string') ? m.parentId : '';
  return all.filter(x => x.id !== m.id && ((typeof x.parentId === 'string' ? x.parentId : '') === p))
    .sort((a, b) => ts(a) - ts(b));
}

/** 从某条往下走到这一支的末端（一直走「最新的那个孩子」）。 */
export function deepestIn(all, id) {
  const kids = new Map();
  for (const m of all) {
    const p = (typeof m.parentId === 'string') ? m.parentId : '';
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push(m);
  }
  let cur = all.find(x => x.id === id);
  const seen = new Set();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    const ch = (kids.get(cur.id) || []).sort((a, b) => ts(a) - ts(b));
    if (!ch.length) break;
    cur = ch[ch.length - 1];
  }
  return cur ? cur.id : id;
}

/** 活动路径。limit > 0 时只取末尾 N 条（和 msgs.list 的语义一致）。 */
export async function activePath(charId, all, limit = 0) {
  // ⚠️ 兜底（v0.5.1.3）：整份数据一条 parentId 都没有 = 还没串过链的老数据。
  // 这时候按 parentId 回溯只能得到叶子自己，屏幕上就只剩一条消息。
  // 与其指望调用方每次都先 seedParents，不如在这里退化成「按时间全量」——
  // 这正是串链【会】得到的那条直线，所以结果和串过链完全一致，不是另一种猜测。
  if (all.length > 1 && all.every(m => typeof m.parentId !== 'string')) {
    const flat = all.slice().sort((a, b) => ts(a) - ts(b));
    return limit > 0 ? flat.slice(-limit) : flat;
  }
  const leaf = pickLeaf(all, await kv.get(leafKey(charId), ''));
  const path = pathTo(all, leaf);
  return limit > 0 ? path.slice(-limit) : path;
}

/** 把活动点挪到这条消息（切分支 / 重聊都用它）。 */
export async function setLeaf(charId, leafId) {
  await kv.set(leafKey(charId), leafId || '');
}
