/**
 * 酒馆（SillyTavern）聊天记录 —— 解析 .jsonl / .json。
 *
 * 为什么值得单独做：酒馆用户的行李里，角色卡能重下、世界书能重下，
 * 【聊天记录没了就是没了】。而本软件原来完全没有 jsonl 这条路（全 www 树 0 命中），
 * 拖进去只会得到一个「文件格式不对」。
 *
 * 这个文件不碰 DOM、不碰数据库，纯函数 —— 可以直接在 node 里单测。
 *
 * 酒馆导出的 .jsonl 长这样（一行一条）：
 *   第一行可能是元信息 {"user_name":"我","character_name":"她","create_date":"..."}
 *   之后每行一条 {"name":"她","is_user":false,"mes":"……","send_date":"..."}
 * 也见过整体是一个 JSON 数组 / { messages: [...] } 的导出，一并认。
 */

/** 一行一条地解析；单行坏掉只跳过那一行，不整份判死 */
export function parseStChatJsonl(text) {
  const raw = String(text == null ? '' : text);
  const lines = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (!lines.length) return { ok: false, reason: '文件是空的' };
  const out = [];
  let meta = null;
  let bad = 0;
  let sawArray = false;
  for (const line of lines) {
    let o;
    try { o = JSON.parse(line); } catch { bad++; continue; }
    if (Array.isArray(o)) { sawArray = true; for (const x of o) if (x && typeof x === 'object') out.push(x); continue; }
    if (!o || typeof o !== 'object') { bad++; continue; }
    // 元信息行：有 user_name / character_name 但【没有 mes】的，当头部处理
    if (!('mes' in o) && ('user_name' in o || 'character_name' in o || 'chat_metadata' in o)) {
      meta = meta || {};
      if (o.user_name) meta.userName = String(o.user_name);
      if (o.character_name) meta.charName = String(o.character_name);
      if (o.create_date) meta.createDate = String(o.create_date);
      continue;
    }
    if ('mes' in o || 'message' in o) { out.push(o); continue; }
    bad++;
  }
  if (!out.length) return { ok: false, reason: bad ? '每一行都解析不出消息' : '里面没有消息' };
  return finish(out, meta, bad, sawArray);
}

/** 整体是一个 JSON（数组，或 { messages: [...] }）的导出 */
export function parseStChatJson(text) {
  let o;
  try { o = JSON.parse(String(text == null ? '' : text)); }
  catch (e) { return { ok: false, reason: '不是合法的 JSON：' + ((e && e.message) || e) }; }
  let arr = null;
  let meta = null;
  if (Array.isArray(o)) arr = o;
  else if (o && typeof o === 'object') {
    if (Array.isArray(o.messages)) arr = o.messages;
    else if (Array.isArray(o.chat)) arr = o.chat;
    if (o.user_name || o.character_name) meta = {
      userName: o.user_name ? String(o.user_name) : '',
      charName: o.character_name ? String(o.character_name) : '',
    };
  }
  if (!arr) return { ok: false, reason: '里面没有消息数组' };
  const list = arr.filter(x => x && typeof x === 'object');
  if (!list.length) return { ok: false, reason: '里面没有消息' };
  return finish(list, meta, arr.length - list.length, true);
}

/** 自动选：看着像 jsonl 就按行解析，否则按整份 JSON */
export function parseStChat(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return { ok: false, reason: '文件是空的' };
  if (s[0] === '[' || s[0] === '{') {
    // 单行 JSON 走 JSON 那条；多行且每行都是对象 = 换行分隔的 JSONL
    const lines = s.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    if (lines.length > 1) {
      const multi = lines.every(l => l[0] === '{' || l[0] === '[');
      if (multi) return parseStChatJsonl(s);
    }
    return parseStChatJson(s);
  }
  return parseStChatJsonl(s);
}

/** 时间戳：酒馆存过好几种格式，能认出哪种算哪种 */
export function parseStDate(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) {
    // 秒 / 毫秒都见过：小于 1e12 的当秒
    return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
  }
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

/** 把解析出来的原始行整成 { name, isUser, mes, ts } */
function finish(list, meta, bad, isJson) {
  const msgs = [];
  let noText = 0;
  let noTime = 0;
  for (const o of list) {
    const mes = String(o.mes != null ? o.mes : (o.message != null ? o.message : ''));
    if (!mes.trim()) { noText++; continue; }
    const isUser = o.is_user === true || o.is_user === 1 || o.is_user === 'true';
    const name = String(o.name || (isUser ? (meta && meta.userName) : (meta && meta.charName)) || '');
    let ts = parseStDate(o.send_date);
    if (ts == null) ts = parseStDate(o.create_date);
    if (ts == null) { ts = null; noTime++; }
    msgs.push({ name, isUser, mes, ts });
  }
  if (!msgs.length) return { ok: false, reason: '消息都是空的（没有正文）' };
  // 说话的人统计 —— 认不出谁是谁时说清楚，别猜
  const byName = new Map();
  for (const m of msgs) {
    const k = m.name || '(没写名字)';
    const cur = byName.get(k) || { name: k, count: 0, user: 0, ai: 0 };
    cur.count++;
    if (m.isUser) cur.user++; else cur.ai++;
    byName.set(k, cur);
  }
  const times = msgs.map(m => m.ts).filter(t => t != null).sort((a, b) => a - b);
  return {
    ok: true,
    meta: meta || {},
    msgs,
    senders: [...byName.values()].sort((a, b) => b.count - a.count),
    badLines: bad,
    noText,
    noTime,
    from: times.length ? times[0] : null,
    to: times.length ? times[times.length - 1] : null,
    isJson: !!isJson,
  };
}

/**
 * 解析结果 → 本软件的消息形状。**不做任何删改，也不猜角色归属。**
 *
 * @param {any} parsed      parseStChat 的结果（外面来的数据整出来的，不设死类型）
 * @param {string} charId   导进哪个角色（由用户在界面上选，这里不猜）
 * @param {number} startTs  第一条的时间戳（调用方决定要不要整体平移，见 shiftTo）
 * @param {Function} [uid]  生成 id；不传就自己生成
 */
export function toMessages(parsed, charId, startTs, uid) {
  const mkId = uid || (() => 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
  const base = parsed.msgs[0] && parsed.msgs[0].ts != null ? parsed.msgs[0].ts : 0;
  const out = [];
  parsed.msgs.forEach((m, i) => {
    // 相对间隔保留：没有时间的那些按顺序每 60 秒排一个，不至于全挤在同一毫秒
    const rel = (m.ts != null && base) ? (m.ts - base) : i * 60000;
    out.push({
      id: mkId(),
      charId,
      role: m.isUser ? 'user' : 'assistant',
      content: m.mes,
      story: null,
      ts: startTs + rel,
    });
  });
  return out;
}

export default { parseStChat, parseStChatJsonl, parseStChatJson, parseStDate, toMessages };
