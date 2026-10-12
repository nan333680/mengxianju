/**
 * 酒馆（SillyTavern）正则脚本 —— 解析 + 应用。
 *
 * ⚠️ 红线（改这个文件之前先读这一段）：
 *   正则【只作用于副本】—— 送进模型的提示词、和显示到屏幕上的字。
 *   绝不回写数据库，原始消息一个字都不动。
 *   存档里永远是用户和模型当时写的那个样子；正则只是"看的时候过一道"。
 *   这条红线是 app.js 里 describeStPreset 那段注释定下来的（原来只写了
 *   "本软件不执行这些正则"），这里只是把它实现出来。
 *
 * 为什么不做"白名单子集"：有了上面那条红线，做完整引擎也不会碰到原始数据。
 * 只做子集反而会让用户看到「正则开着却没生效」，那比不做更糟。
 *
 * 这个文件不碰 DOM、不碰数据库，纯函数 —— 所以可以直接在 node 里单测
 * （e2e/e2e-stregex.mjs 就是这么跑的，不用起浏览器）。
 */

/** 单条正则最多这么长（外面来的东西，超长的直接不编） */
const MAX_PATTERN = 4000;
/** 一份卡 / 一份预设最多收这么多条，防畸形文件塞爆设置页 */
const MAX_SCRIPTS = 200;
const OK_FLAGS = 'gimsuy';

/**
 * 把酒馆的 findRegex 拆成 { src, flags }。
 *
 * 酒馆存的是 `/pattern/flags` 这种带斜杠的写法，但也有卡里直接存裸 pattern。
 * 判据：以 / 开头、且【最后一个】/ 不在第 0 位 —— 这样 `/a\/b/gi` 也切得对
 * （找第一个 / 会把 \/ 里的那个当成结尾）。
 */
export function splitRegex(raw) {
  const s = String(raw == null ? '' : raw);
  if (s.length > 1 && s[0] === '/') {
    const last = s.lastIndexOf('/');
    if (last > 0) {
      const flags = s.slice(last + 1).replace(/[^gimsuy]/g, '');
      return { src: s.slice(1, last), flags };
    }
  }
  return { src: s, flags: '' };
}

/** 编一个正则，编不出来返回 null（外面来的 pattern 什么都有） */
export function safeRegExp(src, flags) {
  const pattern = String(src == null ? '' : src);
  if (!pattern || pattern.length > MAX_PATTERN) return null;
  const f = String(flags || '').split('').filter(c => OK_FLAGS.includes(c)).join('');
  try { return new RegExp(pattern, f); } catch { return null; }
}

/**
 * 把一条酒馆正则脚本规整成本软件的形状。认不出来返回 null。
 *
 * 字段对应（左边酒馆 / 右边我们）：
 *   scriptName|name      → name
 *   findRegex|regex      → find + flags
 *   replaceString|replacement → replace
 *   trimStrings          → trim
 *   disabled             → enabled（取反）
 *   markdownOnly         → 只改显示
 *   promptOnly           → 只改提示词
 *   两个都没有           → 两边都改
 *   minDepth / maxDepth  → 深度窗口（0 = 最新那条；null = 不限）
 *
 * @param {any} raw 酒馆脚本对象（外面来的，字段名有历史包袱，不设死类型）
 * @param {string} source 来源说明（"卡：xxx" / "预设：xxx"），只用于显示
 */
export function parseStRegex(raw, source = '') {
  if (!raw || typeof raw !== 'object') return null;
  const findRaw = raw.findRegex != null ? raw.findRegex : (raw.regex != null ? raw.regex : '');
  const { src, flags } = splitRegex(findRaw);
  if (!src) return null;
  const replace = String(raw.replaceString != null ? raw.replaceString
    : (raw.replacement != null ? raw.replacement : ''));
  // 编不出来的 pattern 也照样收下来 —— 用户至少能看到"卡里有这么一条"，
  // 而不是它凭空消失。应用的时候会跳过（safeRegExp 返回 null）。
  const bad = !safeRegExp(src, flags);
  const placement = Array.isArray(raw.placement) ? raw.placement.map(Number).filter(Number.isFinite) : null;
  // 酒馆的 placement：1 = 用户输入，2 = AI 回复，3 = 斜杠命令，4 = 世界书，5 = 思考。
  // 只挂在 3/4/5 上的，本软件没有对应位置 —— 如实标出来并默认关着，别让它误伤。
  const onlyOdd = !!placement && placement.length > 0
    && !placement.includes(1) && !placement.includes(2);
  const notes = [];
  if (bad) notes.push('这条正则在浏览器里编不出来，开了也不会生效');
  if (onlyOdd) notes.push('只对酒馆的斜杠命令 / 世界书生效，本软件没有对应位置');
  const num = (x) => (x == null || x === '' ? null : (Number.isFinite(Number(x)) ? Number(x) : null));
  return {
    id: 'sr' + Math.random().toString(36).slice(2, 10),
    name: String(raw.scriptName || raw.name || '(没写名字)').slice(0, 120),
    find: src.slice(0, MAX_PATTERN),
    flags,
    replace: replace.slice(0, MAX_PATTERN),
    trim: Array.isArray(raw.trimStrings) ? raw.trimStrings.map(String).filter(Boolean).slice(0, 20) : [],
    // markdownOnly = 只改屏幕上显示的字；promptOnly = 只改送进去的提示词
    display: raw.promptOnly !== true,
    prompt: raw.markdownOnly !== true,
    enabled: raw.disabled !== true && !bad && !onlyOdd,
    minDepth: num(raw.minDepth),
    maxDepth: num(raw.maxDepth),
    source: String(source || '').slice(0, 120),
    note: notes.join('；'),
  };
}

/** 一整份 regex_scripts 数组 → 我们的形状（逐条过 parseStRegex） */
export function parseStRegexList(arr, source = '') {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const raw of arr) {
    if (out.length >= MAX_SCRIPTS) break;
    const one = parseStRegex(raw, source);
    if (one) out.push(one);
  }
  return out;
}

/**
 * 把一批脚本作用到一段文字上 —— 【只返回新字符串，不改任何存档】。
 *
 * @param {string} text   原文（调用方自己保证是副本）
 * @param {Array}  scripts 脚本表
 * @param {'display'|'prompt'} mode 这一遍是给屏幕看还是给模型看
 * @param {number} depth  这条消息离最新那条有多远（0 = 最新）
 * @returns {string}
 */
export function applyStRegex(text, scripts, mode, depth = 0) {
  if (!text) return text;
  const list = Array.isArray(scripts) ? scripts : [];
  if (!list.length) return text;
  let out = String(text);
  const d = Number.isFinite(depth) ? depth : 0;
  for (const s of list) {
    if (!s || s.enabled !== true) continue;
    if (mode === 'display' ? s.display === false : s.prompt === false) continue;
    // 深度窗口：null = 不限
    if (s.minDepth != null && d < s.minDepth) continue;
    if (s.maxDepth != null && d > s.maxDepth) continue;
    const re = safeRegExp(s.find, s.flags);
    if (!re) continue;
    try {
      out = out.replace(re, s.replace);
      if (Array.isArray(s.trim) && s.trim.length) {
        for (const tr of s.trim) out = out.split(tr).join('');
      }
    } catch { /* 替换串写坏了不该让整屏白掉，跳过这条 */ }
  }
  return out;
}

/** 这条脚本现在会不会生效（设置页拿它显示状态） */
export function scriptActive(s, mode) {
  if (!s || s.enabled !== true) return false;
  if (mode === 'display') return s.display !== false;
  if (mode === 'prompt') return s.prompt !== false;
  return true;
}

/** 给设置页看的预览：这条脚本作用到一段示例文字上会变成什么 */
export function previewOne(s, sample) {
  if (!s) return '';
  try {
    const re = safeRegExp(s.find, s.flags);
    if (!re) return '';
    let out = String(sample == null ? '' : sample).replace(re, s.replace);
    if (Array.isArray(s.trim)) for (const tr of s.trim) out = out.split(tr).join('');
    return out;
  } catch { return ''; }
}

export default { splitRegex, safeRegExp, parseStRegex, parseStRegexList, applyStRegex, scriptActive, previewOne };
