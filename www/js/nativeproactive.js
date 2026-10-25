// www/js/nativeproactive.js —— 主动消息的"原生交接"层（0.5.3.6，实施规格 §6 方案 C）
//
// 这里只有【桥】：把 JS 的队列交给原生、把原生弹过通知的那条取回来。
// 「写什么句子」「什么时候写」全在 app.js 里 —— 这个文件不许 import 任何东西，
// 它要能在没有数据库、没有网络的情况下单独用起来（设置页、诊断页都会直接调）。
//
// 为什么通知要绕到原生：WebView 一进后台就被系统冻结，JS 定时器全停。
// 想让"她隔几小时想起你"这件事真的发生，叫醒手机的必须是原生。

/** 取插件本体（取不到返回 null，绝不抛）。 */
function plugin() {
  try {
    const C = /** @type {any} */ (window).Capacitor;
    return (C && C.Plugins && C.Plugins.LocalProactive) || null;
  } catch { return null; }
}

/** 这套通知功能在这台设备上能用吗（只看插件在不在；权限另外查 status）。 */
export function proactiveAvailable() { return !!plugin(); }

/** 整批覆盖原生队列。items: [{text, charId, charName}] */
export async function proactiveSetQueue(items) {
  const p = plugin();
  if (!p) return { ok: false, count: 0 };
  try { return await p.setQueue({ items: Array.isArray(items) ? items : [] }); }
  catch { return { ok: false, count: 0 }; }
}

/**
 * 取走「已经弹过通知、还没在聊天里出现」的那一条。取走即清空。
 * @returns {Promise<{text:string, charId:string, charName:string, at:number}|null>}
 */
export async function proactiveTakePending() {
  const p = plugin();
  if (!p) return null;
  try {
    const r = await p.takePending();
    const it = r && r.item;
    if (!it || !it.text) return null;
    return {
      text: String(it.text),
      charId: String(it.charId || ''),
      charName: String(it.charName || ''),
      at: Number(it.at) || 0
    };
  } catch { return null; }
}

/** 队列条数 / 有没有待展示 / 通知权限 / 间隔。 */
export async function proactiveStatus() {
  const p = plugin();
  if (!p) return { queue: 0, hasPending: false, perm: false, hours: 6, sdk: 0 };
  try { return await p.status(); }
  catch { return { queue: 0, hasPending: false, perm: false, hours: 6, sdk: 0 }; }
}

/** 设定间隔（小时，原生侧会 clamp 到 2~12）并重新调度。 */
export async function proactiveSchedule(hours) {
  const p = plugin();
  if (!p) return { ok: false, hours: 6 };
  try { return await p.schedule({ hours: Number(hours) || 6 }); }
  catch { return { ok: false, hours: 6 }; }
}

/** 停掉定时任务（关掉功能 / 卸载前）。 */
export async function proactiveStop() {
  const p = plugin();
  if (!p) return;
  try { await p.stop(); } catch { /* ignore */ }
}

/** 清空队列与待展示（换角色、清数据时用，别让旧角色的句子冒出来）。 */
export async function proactiveClear() {
  const p = plugin();
  if (!p) return;
  try { await p.clear(); } catch { /* ignore */ }
}

/** 申请通知权限（Android 13+ 不给就静默不弹）。 */
export async function proactiveRequestPermission() {
  const p = plugin();
  if (!p) return { granted: false };
  try { return await p.requestPermission(); }
  catch { return { granted: false }; }
}
