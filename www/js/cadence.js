// www/js/cadence.js —— 让几条消息"一条一条地"出现（活人感 v2）
//
// 为什么需要它：她本来就常常拆成两三条发（splitMessages），但以前是
// 350ms 一条地"哔哔哔"贴上去，节奏是机器的 —— 真实的人打字有快有慢，
// 会先停一下，会先"嗯"一声再说话，会因为手头有事而隔很久。
//
// ⚠️ 这一层【只管显示】，不碰落库。落库的 still 是 pieces 本身，
//   这里插进去的那声"嗯"不会被写进聊天记录 —— 下次打开还是干净的几条。
//
// ⚠️ 它必须【可中断】：用户发新消息、切角色，上屏循环要立刻停，
//   不能让她在后台继续把剩下三条吐完。（app.js 的 curCharId 校验）
//
// 纯函数，不碰 DOM、不调模型、不读时间以外的任何东西 —— 这样 e2e 能
// 用固定的 rnd() 把每一条 delayMs 断言死。

/** 前插用的极短回应。只有这几个 —— 更长的就不是"先应一声"了。 */
const SHORTS = ['嗯', '……', '在', '？'];

/** 总要等一会儿才出第一条：0 毫秒的第一条比 350ms 还假。 */
const BASE_DELAY = 700;

/** 每个字多等多久。中文打字差不多这个量级。 */
const PER_CHAR = 30;

/** 打一个字要多久（显示用）。比真实打字快一点，否则长消息要等太久。 */
const TYPING_PER_CHAR = 18;
const TYPING_MIN = 500;

/** 整轮上屏的时间上限。超过就整体压缩 —— 宁可快一点，不能让她"卡住不动"。 */
const TOTAL_MAX = 12000;

function rndOf(o) {
  return (o && typeof o.rnd === 'function') ? o.rnd : Math.random;
}

function pickShort(rnd) {
  return SHORTS[Math.min(SHORTS.length - 1, Math.floor(rnd() * SHORTS.length))];
}

/**
 * 排一条上屏时间线。
 *
 * @param {Array<string|{text:string}>} pieces 要发的几条（按顺序）
 * @param {{busy?:boolean, energy?:number, mood?:string, rnd?:()=>number}} [o]
 * @returns {{steps:Array<{text:string, delayMs:number, typingMs:number}>, totalMs:number}}
 */
export function planCadence(pieces, o = {}) {
  const arr = (Array.isArray(pieces) ? pieces : [])
    .map(p => (p == null ? '' : (typeof p === 'string' ? p : String(p.text == null ? '' : p.text))))
    .map(s => String(s))
    .filter(s => s.trim().length);
  const rnd = rndOf(o);
  const busy = !!o.busy;
  const energy = Number(o.energy);
  const lowEnergy = Number.isFinite(energy) && energy < 0.4;

  const steps = [];

  // ④ 先"嗯"一声再说正事。只在第一条本来就长的时候插 ——
  //    "嗯" + "好" 这种就是画蛇添足。
  if (arr.length && arr[0].length > 12 && rnd() < 0.12) {
    steps.push({ text: pickShort(rnd), delayMs: 0, typingMs: TYPING_MIN });
  }

  for (const text of arr) {
    let delay = BASE_DELAY + text.length * PER_CHAR;
    if (busy) delay *= 1.6;          // 手头有事，回得慢
    if (lowEnergy) delay *= 1.4;     // 没力气，懒得回
    delay *= (0.75 + rnd() * 0.6);   // 随机的"呼吸"
    if (rnd() < 0.08) delay *= 2;    // 偶尔走神一下
    const typingMs = Math.max(TYPING_MIN, text.length * TYPING_PER_CHAR);
    steps.push({ text, delayMs: Math.max(0, Math.round(delay)), typingMs: Math.round(typingMs) });
  }

  let totalMs = steps.reduce((a, s) => a + s.delayMs + s.typingMs, 0);
  // ⑤ 整体压：两边等比缩，保证"顺序和比例"不变，只把总时长压进上限。
  if (totalMs > TOTAL_MAX && totalMs > 0) {
    const k = TOTAL_MAX / totalMs;
    for (const s of steps) {
      s.delayMs = Math.max(0, Math.round(s.delayMs * k));
      s.typingMs = Math.max(1, Math.round(s.typingMs * k));
    }
    totalMs = steps.reduce((a, s) => a + s.delayMs + s.typingMs, 0);
  }

  return { steps, totalMs };
}
