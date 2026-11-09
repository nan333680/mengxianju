// 记忆写入审计（v0.5.6）
//
// 为什么要有它：排查「长期记忆对象反了」三次，每次拿到的都只有最终状态 ——
// 备份里是结果，而「谁在什么时候把哪条改成了什么」完全看不见，只能靠
// ts 聚集（相差几毫秒 = 同一次写入）和 sourceMsgIds 反推是哪条路干的。
//
// 它只做一件事：把「三条路」（滚动总结 / 归档总结 / 整理）缩到「一条」。
//
// ⚠️ 不记 prompt。一次整理几 KB，10 批就是几十 KB，而真要看 prompt 的时候
//    promptpeek.js 已经能看 —— 审计的价值是缩小范围，不是保存现场。
// ⚠️ 旁路。任何写失败都只 warn，绝不冒泡：审计死了，记忆也得活着。
// ⚠️ 默认开、不给关。提供开关等于大部分人不会打开，等于回到没记录。
// ⚠️ oldText 只留 40 字：这里要的是「认出是哪条」，不是「留一份全文」。
//    全文在备份里。留全文还有个隐私问题 —— 用户删掉的记忆会躺在审计里。
//
// 存储：kv 键 memAudit:<charId>，值是 { batches: [...] }，只留最近 10 个批次
//     （一次整理 = 1 批）。按批次存而不是按条存，否则事后分不清哪 20 条
//     是同一次整理写的、哪 20 条是上一轮对话写的。

import { kv, uid } from './db.js';

const KEY = 'memAudit:';
// 20 批：按「新增到上限一半（至少 3 条）才整理」的门槛，memLimit 默认 20 →
// 每新增 10 条记忆触发一次整理，两天一次很常见 = 一个月 15 次左右。
// 10 批只够覆盖 20 天，月底反了、月初的记录已经被挤掉（v0.5.6 复查时改的）。
const MAX_BATCHES = 20;      // 最近 20 批（一次整理/总结 = 一批）
const MAX_ITEMS = 60;        // 一批最多记这么多条（整理 20 删 + 20 写，够用）
const OLD_MAX = 40;          // oldText 只留前 40 字
const NEW_MAX = 80;          // newText 只留前 80 字

function cut(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

/**
 * 开一批。
 * @param {string} charId
 * @param {string} from 哪条路：'summarize' | 'chunk' | 'dedupe'
 * @param {string} reason 更细的来路（整理才有）：'manual' | 'auto' | 'makeRoom'
 *   ⚠️ reason 必须分开记。同样叫整理，用户点的、攒够了自动跑的、归档催着腾位置的
 *      是三种完全不同的场景 —— 第三种最容易出冤案：用户什么都没点，
 *      她在后台自动归档，记忆被压缩重写了一遍。只写 from:'dedupe' 会让人以为
 *      是自动整理，查错方向。
 */
export function auditStart(charId, from, reason = '') {
  return {
    id: uid(),
    charId: String(charId || ''),
    at: Date.now(),
    from: String(from || ''),
    reason: String(reason || ''),
    items: [],
  };
}

/** 往这一批里记一条。batch 为空或已满就静默跳过（审计不该因为满了就报错）。 */
export function auditPush(batch, it = {}) {
  if (!batch || !Array.isArray(batch.items)) return;
  // ⚠️ 满了不能只是 return —— 那会让导出看起来像"这次只动了 60 条"。
  //    memLimit 调到 30 以上时，一次整理是 80 条（N 写 + N 删），必须看得出来被截了。
  if (batch.items.length >= MAX_ITEMS) { batch.truncated = (batch.truncated || 0) + 1; return; }
  batch.items.push({
    op: String(it.op || 'add'),          // 'add' | 'del'
    old: cut(it.old, OLD_MAX),           // 被改写/被删之前的原文（前 40 字）
    now: cut(it.now, NEW_MAX),           // 写进去的正文（前 80 字）
    status: String(it.status || ''),     // active / draft
    why: cut(it.why, 24),                // memReviewWhy（方向待核等）
  });
}

/**
 * 落库。⚠️ 任何失败都只 warn —— 这一条写在 mem.add 的链上，
 * 让审计的异常冒出去会把整批记忆写入打断，那是把旁路做成了主路。
 * @returns {Promise<boolean>} 成功与否（调用方不用管，只给测试用）
 */
export async function auditCommit(batch) {
  if (!batch || !batch.charId || !batch.items.length) return false;
  try {
    const key = KEY + batch.charId;
    const prev = await kv.get(key, null);
    const list = Array.isArray(prev && prev.batches) ? prev.batches.slice() : [];
    list.push({
      id: batch.id, at: batch.at,
      from: batch.from, reason: batch.reason,
      items: batch.items,
      // 被截断的条数（0 = 没截）。导出时要说出来，否则看的人以为只动了这么多条。
      truncated: Number(batch.truncated) || 0,
    });
    // 只留最近 MAX_BATCHES 批：旧的一直堆着没有意义，而且 kv 是整条读写的
    while (list.length > MAX_BATCHES) list.shift();
    await kv.set(key, { batches: list });
    return true;
  } catch (e) {
    try { console.warn('[记忆审计] 写失败，不影响记忆本身', e); } catch { /* 控制台不在也不影响 */ }
    return false;
  }
}

/** 读某个角色的审计批次（新的在前）。 */
export async function auditList(charId) {
  if (!charId) return [];
  try {
    const prev = await kv.get(KEY + charId, null);
    const list = Array.isArray(prev && prev.batches) ? prev.batches.slice() : [];
    return list.reverse();
  } catch { return []; }
}

/** 清空某个角色的审计记录（清空聊天 / 删角色时跟着清 —— 它属于那个角色）。 */
export async function auditClear(charId) {
  if (!charId) return;
  try { await kv.del(KEY + charId); } catch { /* 清不掉不影响 */ }
}

const FROM_NAME = { summarize: '滚动总结', chunk: '归档总结', dedupe: '整理' };
const REASON_NAME = { manual: '手动点的', auto: '攒够了自动跑', makeRoom: '归档催着腾位置' };

/** 把批次摊成人能读的文本（导出用）。 */
export function auditToText(charId, batches, charName = '') {
  const list = Array.isArray(batches) ? batches : [];
  if (!list.length) return '（还没有记忆写入记录）';
  const lines = [];
  lines.push('记忆写入记录' + (charName ? ' · ' + charName : '') + '（最近 ' + list.length + ' 批，新的在前）');
  lines.push('注意：每条只留前 40/80 字。要全文去备份里找。');
  for (const b of list) {
    const t = new Date(Number(b.at) || 0);
    const from = FROM_NAME[b.from] || b.from || '?';
    const why = b.reason ? '（' + (REASON_NAME[b.reason] || b.reason) + '）' : '';
    lines.push('');
    const tr = Number(b.truncated) || 0;
    lines.push('■ ' + t.toLocaleString() + ' · ' + from + why + ' · '
      + (b.items || []).length + ' 条' + (tr ? '（还有 ' + tr + ' 条没记下，这一批被截断了）' : ''));
    for (const it of (b.items || [])) {
      // ⚠️ 三种 op 都要认。原来只分 del / 其他，abort 会显示成「写」——
      //    而 abort 恰恰是"整批放弃、一条都没写"，显示成「写」是反的。
      const op = it.op === 'abort' ? '放弃' : (it.op === 'del' ? '删' : '写');
      lines.push('  [' + op + ']' + (it.status ? ' ' + it.status : '') + (it.why ? ' · ' + it.why : ''));
      if (it.old) lines.push('    原: ' + it.old);
      if (it.now) lines.push('    新: ' + it.now);
    }
  }
  return lines.join('\n');
}
