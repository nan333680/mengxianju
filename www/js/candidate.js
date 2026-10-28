// www/js/candidate.js —— 一次写三条候选（活人感 v2）
//
// 为什么不是"生成一条，不满意再重来"：
//   重来拿到的是【同一个模型、同一套提示词】下的另一个说法，风格是同一个模子。
//   三条同时在跑，评审才有得挑 —— 挑比改便宜，也比"重写一次"更像人。
//
// ⚠️ 温度拉不开三条（0.6.x 复查，一手：api-docs.deepseek.com/guides/thinking_mode/）：
//   DeepSeek 官方写明「思考模式不支持 temperature / presence_penalty / frequency_penalty，
//   设了不报错也没有任何效果」，并且 deepseek-flash 在【非思考模式】下 top_p 固定 1.0、
//   你的值被忽略。梦弦居默认就是 deepseek-flash + reasoningEffort:'none'（见 api.js:27/346），
//   也就是说：三条候选的 temperature 全都不起作用，三条的差别只剩采样随机性本身。
//   真正能拉开三条的是【结尾那句写法取向】—— 见 CAND_HINTS。温度照旧传，
//   换到认温度的服务商（ollama / openrouter / 硅基流动…）时它仍然管用。
//
// ⚠️ 三条共用一个 AbortController：用户点停止、切角色、发新消息，
//   三路必须一起断。留着两条在后台跑完，既浪费钱，也可能在切角色后
//   把另一个角色的候选写进当前会话。
//
// ⚠️ 全失败要【抛】出去。调用方（app.js）看到 throw 才知道这一轮得走老路径
//   （单条流式生成）。这里不许"返回空数组让上层自己判断"—— 那种契约
//   迟早会有人忘了判断，然后她发了一条空消息。

import { streamChat } from './api.js';

/** 三条候选的温度。改这里就是改"她今天有多敢"。（对不认温度的服务商无效，见文件头） */
export const TEMPS = [0.85, 1.0, 1.15];

/**
 * 附在第 2、3 条末尾的【写法取向】。第 1 条不附 —— 它是要先滚到屏幕上的那条，
 * 必须和平时完全一致，否则「先显示的那条」和「最终落库的那条」会是两种笔法。
 *
 * ⚠️ 这两句是加在 messages 末尾的一条 user 消息，不是 system：
 *     system 必须与历史逐字节相同（前缀缓存），往那儿加东西会让整轮缓存失效。
 */
export const CAND_HINTS = [
  '',
  '（这一条收着写：能两句说完就别三句。动作少一点，话留一截，不用把这一轮的事交代圆。）',
  '（这一条放开写：想到什么先说什么，允许有半句没说完，别修饰，别给这一轮收尾。）',
];

/**
 * 这一轮实际用的三条温度。
 * 基准取【角色自己的温度档位】（默认 1.0）—— v2 不能让「角色设置里的温度」静默失效：
 *   角色 0.5 → 0.35 / 0.50 / 0.65     角色 1.5 → 1.35 / 1.50 / 1.65
 *   默认 1.0 → 0.85 / 1.00 / 1.15（正好是文档里那三个数）
 * 这样既保住了三个候选的区分度，角色的档位又还管用。
 */
export function temperList(base) {
  const n = Number(base);
  const b = Number.isFinite(n) ? Math.min(1.8, Math.max(0.2, n)) : 1.0;
  const r = x => Math.round(Math.min(2, Math.max(0, x)) * 100) / 100;
  const t = [r(b - 0.15), r(b), r(b + 0.15)];
  // 贴边时（0.2 / 1.8）±0.15 被夹平了，三条会变成同一个温度 —— 拉开一点点。
  if (t[0] === t[2]) return [r(Math.max(0, b - 0.05)), r(b), r(Math.min(2, b + 0.05))];
  return t;
}

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
    const hint = CAND_HINTS[idx] || '';
    const msgs = hint ? baseMsgs.concat([{ role: 'user', content: hint }]) : baseMsgs;
    const stream = streamChat({
      ...opts,
      messages: msgs,
      temperature: temp,
      signal: ctl.signal,
      onFinish: (r) => { finish = r || ''; },
      onUsage: (u) => { usage = u || null; }
    });
    try {
      for await (const chunk of stream) {
        text += chunk;
        // 只有第 0 条喂给屏幕：气泡里滚动的必须是最后会被采纳的那条，
        // 否则用户会看到一段话然后被换成另一段 —— 比转圈更让人不安。
        if (idx === 0 && typeof onDelta === 'function') {
          try { onDelta(text); } catch { /* 显示失败不该影响生成 */ }
        }
      }
    } catch (e) {
      // 用户点了停止：把已经流出来的这半截带出去 —— 上层要落「（已中断）」的正文。
      // 不带的话中断那一轮落库的是空字符串，聊天记录里只剩一句「（已中断）」。
      if (e && (e.name === 'AbortError' || ctl.signal.aborted)) {
        throw Object.assign(new Error('已停止'), { name: 'AbortError', partial: cutText(text) });
      }
      throw e;
    }
    return { temp, text: cutText(text), finish, usage };
  }

  const temps = temperList(/** @type {any} */ (opts).temperature);
  let settled;
  try {
    settled = await Promise.allSettled(temps.map((t, i) => runOne(t, i)));
  } finally {
    if (signal && typeof signal.removeEventListener === 'function') {
      try { signal.removeEventListener('abort', onAbort); } catch { /* 无所谓 */ }
    }
  }

  // 用户点了停止 / 切了角色：这一轮作废，不挑候选。
  // 这不是「生成失败」—— 上层要能把它当成 AbortError 安静收场，而不是弹一张错误卡。
  if (ctl.signal.aborted) {
    // 三路里已经流出来的那半截，取最长的一条带出去（上层落「（已中断）」用）。
    let partial = '';
    for (const s of settled) {
      const v = (s && s.status === 'fulfilled' && s.value) || (s && s.reason) || null;
      const txt = v && typeof v.partial === 'string' ? v.partial : (v && typeof v.text === 'string' ? v.text : '');
      if (txt.length > partial.length) partial = txt;
    }
    throw Object.assign(new Error('已停止'), { name: 'AbortError', partial });
  }

  const list = [];
  let sum = null;
  for (const s of settled) {
    if (!s || s.status !== 'fulfilled' || !s.value) continue;
    const v = s.value;
    // ⚠️ 用量先记（0.5.3.6 复查）：下面两个 continue 会丢掉被截断的和空的候选，
    //    但那条请求的 token 是真花出去了 —— 记在用量的位置如果放在 continue 之后，
    //    「三条回来一条可用」时账上只记一条的钱，实际花了三条。
    sum = addUsage(sum, v.usage);
    // 被截断的和空的一律不要：截断的那条读到一半就没了，进评审只会把评审带偏。
    if (!v.text.trim()) continue;
    if (v.finish === 'length') continue;
    list.push({ idx: list.length, temp: v.temp, text: v.text, finish: v.finish, usage: v.usage });
  }

  if (!list.length) {
    const first = settled.find(s => s && s.status === 'rejected');
    const why = first && first.reason;
    const err = /** @type {any} */ (new Error('三条候选全都没回来' + (why ? ('：' + ((why && why.message) || why)) : '')));
    err.cause = why;
    // ⚠️ 错误卡是按 status / kind 分类的（errorkit.kindOfError）：
    //    原样把身份带过去，否则「服务商 5xx」会被归到「出了点问题」——
    //    用户看到的文案反而比 0.5.3.5 更含糊，等于用 v2 把有用的提示吞掉了。
    if (why) {
      if (why.status) err.status = why.status;
      if (why.kind) err.kind = why.kind;
      if (why.detail) err.detail = why.detail;
    }
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
