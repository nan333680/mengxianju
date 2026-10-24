// diag.js — 运行日志环形缓冲 + 全局异常捕获（0.5.3.5）
//
// 为什么要有这个文件（用户给的方向文档 P0-1）：
//   这个项目原来【一个 window.onerror 都没有】，也没有 unhandledrejection。
//   于是任何一个「点了没反应」「白屏」「发不出去」都只能靠肉眼复现 + 猜根因，
//   而作者本人是在手机上用，连控制台都看不到。
//
// 设计取舍：
//   1. 只留在内存里（不上报、不写盘）：这是个人自用工具，没有后端，
//      而 IndexedDB 里写的日志会跟着备份一起导出到公共目录 —— 那是泄漏面。
//   2. 环形 200 条：够覆盖一次「出问题 → 切到诊断页」的时间窗，不会吃内存。
//   3. 绝不记录聊天正文与 API Key：只记 kind / 一句话 / 栈 / 当前上下文（角色名、页签、模型）。
//      主体文字里如果带了 key 形态的串（sk-xxxx）会被打码。
//   4. 出错时【自己不能再抛】—— 整个模块从头到尾 try/catch 包住。

const RING = 200;
/** @type {Array<{t:number,kind:string,msg:string,stack:string,ctx:any}>} */
const logs = [];
let ctxFn = () => ({});

/** 注册「当前上下文」提供者（角色名 / 页签 / 模型…），每次记日志时现取 */
export function setDiagCtx(fn) { ctxFn = typeof fn === 'function' ? fn : () => ({}); }

function safeCtx() {
  try {
    const c = ctxFn();
    if (!c || typeof c !== 'object') return {};
    const out = {};
    for (const [k, v] of Object.entries(c)) {
      if (v == null || v === '') continue;
      if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
      else out[k] = String(v).slice(0, 80);
    }
    return out;
  } catch { return {}; }
}

/** Key 形态的串一律打码（诊断文本会被复制出去、粘到聊天里） */
function redact(s) {
  return String(s == null ? '' : s)
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{8,}|tvly-[A-Za-z0-9_-]{8,})\b/g, '***');
}

/**
 * 记一条。
 * @param {string} kind 归类（err / reject / api / send / render / act …）
 * @param {any} msg 一句话，或 Error
 * @param {any} [extra] 附加对象（会被 JSON 化后截断）
 */
export function dlog(kind, msg, extra) {
  try {
    let text, stack = '';
    if (msg instanceof Error) {
      text = msg.name + ': ' + msg.message;
      stack = String(msg.stack || '').slice(0, 1200);
      // apiErr 挂上来的字段（状态码 / 服务端原文前 200 字）是排障的关键
      const m = /** @type {any} */ (msg);
      if (m.status || m.detail || m.kind) {
        text += ' [' + (m.kind || '') + ' ' + (m.status || '') + '] ' + String(m.detail || '').slice(0, 200);
      }
    } else {
      text = String(msg == null ? '' : msg);
    }
    if (extra !== undefined) {
      try { text += ' | ' + JSON.stringify(extra).slice(0, 400); } catch { /* 循环引用就别记 */ }
    }
    logs.push({ t: Date.now(), kind: String(kind || 'log').slice(0, 16), msg: redact(text).slice(0, 2000), stack: redact(stack), ctx: safeCtx() });
    if (logs.length > RING) logs.splice(0, logs.length - RING);
  } catch { /* 记日志本身不许把主流程带崩 */ }
}

/** 拿一份副本（诊断页用） */
export function diagEntries() { return logs.slice(); }
export function diagCount() { return logs.length; }
export function diagClear() { logs.length = 0; }

function two(n) { return String(n).padStart(2, '0'); }
function stamp(t) {
  const d = new Date(t);
  return two(d.getHours()) + ':' + two(d.getMinutes()) + ':' + two(d.getSeconds());
}

/** 拼成一段可复制的纯文本 */
export function diagText(meta) {
  const head = [];
  const m = meta || {};
  for (const k of Object.keys(m)) if (m[k] != null && m[k] !== '') head.push(k + ' ' + m[k]);
  const body = logs.map(r => {
    const c = r.ctx && Object.keys(r.ctx).length ? ' {' + Object.keys(r.ctx).map(k => k + '=' + r.ctx[k]).join(' ') + '}' : '';
    return '[' + stamp(r.t) + '] ' + r.kind + ' ' + r.msg + c + (r.stack ? '\n    ' + r.stack.split('\n').slice(1, 6).join('\n    ') : '');
  });
  return head.join('\n') + (head.length ? '\n\n' : '') + (body.length ? body.join('\n') : '（还没有日志）');
}

/**
 * 装全局异常捕获。幂等，重复调用不会重复挂。
 * ⚠️ 用 addEventListener 而不是 window.onerror = ——
 *    后者会把别的脚本（或未来某处的赋值）覆盖掉，而这里是要【兜底】。
 */
export function installDiag() {
  try {
    // 标成 any：window 上没有这两个属性的声明，checkJs 会报 TS2339；
    // 它们本来就是运行时插上去的一次性标记（不是类型定义）。
    const W = /** @type {any} */ (window);
    if (W.__diagInstalled) return;
    W.__diagInstalled = true;
    window.addEventListener('error', (ev) => {
      // error 事件有三种来源，靠"有没有 error 对象 / 有没有 message"分开记：
      //   ① 同源脚本抛的异常 → ev.error 是完整 Error（有栈）
      //   ② 跨源脚本抛的 → ev.error 是 null、message 被脱敏成 "Script error."
      //      （Chrome 的跨源错误脱敏；Puppeteer 用 CDP 注入的脚本也吃这一条）
      //   ③ 资源加载失败（img/script/link 404）→ 没有 error、没有 message，target 是那个元素
      // 把 ② 和 ③ 混成一句"资源加载失败"会误导排错方向，所以分开。
      const e = ev && ev.error;
      if (e) dlog('err', e, { at: (ev.filename || '') + ':' + (ev.lineno || 0) });
      else if (ev && ev.message) dlog('err', '跨源脚本报错（拿不到详情）：' + ev.message, { at: (ev.filename || '') + ':' + (ev.lineno || 0) });
      else {
        const t = /** @type {any} */ (ev && ev.target);
        dlog('err', '资源加载失败', { src: (t && (t.src || t.href)) || '' });
      }
    });
    window.addEventListener('unhandledrejection', (ev) => {
      const r = ev && ev.reason;
      dlog('reject', r instanceof Error ? r : String(r));
    });
    // 给「自己在手机上看不到控制台」留一个入口：诊断页之外也能用开发者工具取
    // log 也露出来：e2e 要能造日志（也方便在开发者工具里手动记一条再复现）
    W.__diag = { entries: diagEntries, text: diagText, clear: diagClear, log: dlog };
  } catch { /* 装不上也不能影响启动 */ }
}
