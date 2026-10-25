// www/js/candidate.js —— 一次写三条候选（活人感 v2）
//
// 为什么不是"生成一条，不满意再重来"：
//   重来拿到的是【同一个模型、同一个温度】下的另一个说法，风格是同一个模子。
//   真正有区分度的是【温度区间】：0.85 稳、1.00 平时、1.15 敢写半截话。
//   三条同时在跑，评审才有得挑 —— 挑比改便宜，也比"重写一次"更像人。
//
// ⚠️ 三条共用一个 AbortController：用户点停止、切角色、发新消息，
//   三路必须一起断。留着两条在后台跑完，既浪费钱，也可能在切角色后
//   把另一个角色的候选写进当前会话。
//
// ⚠️ 全失败要【抛】出去。调用方（app.js）看到 throw 才知道这一轮得走老路径
//   （单条流式生成）。这里不许"返回空数组让上层自己判断"—— 那种契约
//   迟早会有人忘了判断，然后她发了一条空消息。

import { streamChat } from './api.js';

/** 三条候选的温度。改这里就是改"她今天有多敢"。 */
export const TEMPS = [0.85, 1.0, 1.15];

function cutText(v) {
  return String(v == null ? '' : v);
}

/**
 * 生成候选。并行跑，等全部落定再回来。
 *
 * @param {object} o
 * @param {Array}  o.baseMsgs  完整消息数组（system + 历史 + 用户这句）
 * @param {object} o.genOpts   其余生成参数（apiKey/baseUrl/provider/model/maxTokens/topP/...）
 *                              messages 与 temperature 会被这里覆盖
 * @param {AbortSignal} [o.signal]
 * @param {(text:string)=>void} [o.onDelta] 只给第 0 条的增量 —— 屏幕上先显示它
 * @returns {Promise<{list:Array<{idx:number,temp:number,text:string,finish:string,usage:any}>, usage:any}>}
 */
export async function genCandidates(o) {
  const { baseMsgs, genOpts, signal, onDelta } = o || {};
  const opts = genOpts && typeof genOpts === 'object' ? genOpts : {};

  const ctl = new AbortController();
  const onAbort = () => { try { ctl.abort(); } catch { /* 已经断了 */ } };
  if (signal) {
    if (signal.aborted) onAbort();
    else if (typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort, { once: true });
  }

  async function runOne(temp, idx) {
    let text = '';
    let finish = '';
    let usage = null;
    const stream = streamChat({
      ...opts,
      messages: baseMsgs,
      temperature: temp,
      signal: ctl.signal,
      onFinish: (r) => { finish = r || ''; },
      onUsage: (u) => { usage = u || null; }
    });
    for await (const chunk of stream) {
      text += chunk;
      // 只有第 0 条喂给屏幕：气泡里滚动的必须是最后会被采纳的那条，
      // 否则用户会看到一段话然后被换成另一段 —— 比转圈更让人不安。
      if (idx === 0 && typeof onDelta === 'function') {
        try { onDelta(text); } catch { /* 显示失败不该影响生成 */ }
      }
    }
    return { temp, text: cutText(text), finish, usage };
  }

  let settled;
  try {
    settled = await Promise.allSettled(TEMPS.map((t, i) => runOne(t, i)));
  } finally {
    if (signal && typeof signal.removeEventListener === 'function') {
      try { signal.removeEventListener('abort', onAbort); } catch { /* 无所谓 */ }
    }
  }

  // 用户点了停止 / 切了角色：这一轮作废，不挑候选。
  // 这不是「生成失败」—— 上层要能把它当成 AbortError 安静收场，而不是弹一张错误卡。
  if (ctl.signal.aborted) {
    throw Object.assign(new Error('已停止'), { name: 'AbortError' });
  }

  const list = [];
  let sum = null;
  for (const s of settled) {
    if (!s || s.status !== 'fulfilled' || !s.value) continue;
    const v = s.value;
    // 被截断的和空的一律不要：截断的那条读到一半就没了，进评审只会把评审带偏。
    if (!v.text.trim()) continue;
    if (v.finish === 'length') continue;
    list.push({ idx: list.length, temp: v.temp, text: v.text, finish: v.finish, usage: v.usage });
    sum = addUsage(sum, v.usage);
  }

  if (!list.length) {
    const first = settled.find(s => s && s.status === 'rejected');
    const why = first && first.reason;
    const err = new Error('三条候选全都没回来' + (why ? ('：' + ((why && why.message) || why)) : ''));
    err.cause = why;
    throw err;
  }
  return { list, usage: sum };
}

/** 把两次调用的用量加起来。字段名跟 api.js 的 usage 一致，缺一个就当场跳过。 */
export function addUsage(a, b) {
  if (!b) return a || null;
  const out = a ? { ...a } : {};
  for (const k of Object.keys(b)) {
    const n = Number(b[k]);
    if (Number.isFinite(n)) out[k] = (Number(out[k]) || 0) + n;
  }
  return out;
}
