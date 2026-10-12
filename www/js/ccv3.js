/**
 * 角色卡 V3 里那些"V2 没有的东西" —— 装饰器、宏、CHARX 容器。
 *
 * 为什么单独一个文件：这三样都跟 charcard.js 那段 PNG 读写没关系，
 * 而且都是纯函数（只有 readZip 用 DecompressionStream），可以单独测。
 *
 * 规范：github.com/kwaroran/character-card-spec-v3
 *   · 装饰器写在世界书条目的 content 里：以 @@ 开头、到行尾结束的一行，
 *     「值」用逗号分隔。@@@ 是【回退装饰器】—— 只有前面那条本软件不认时才看它。
 *     回填成 V2 时规范要求把所有装饰器删掉。
 *   · 宏写在正文里：{{random:a,b,c}} / {{pick:}} / {{roll:N}} / {{//注释}} 等。
 *   · CHARX 就是一个 zip：根目录 card.json 是卡片本体，assets/ 里是立绘等资源
 *     （用 embeded:// 路径引用，注意规范里就是这个拼写，少一个 d）。
 */

// ============================================================
//  @@ 装饰器
// ============================================================

/**
 * 本软件能【真的照做】的装饰器。
 * 值那边一律按字符串处理，数字的自己转。
 */
const DECO_ACT = new Set([
  'activate',                    // 无论如何都生效
  'dont_activate',               // 无论如何都不生效
  'additional_keys',             // 追加触发词
  'exclude_keys',                // 这些词出现时不生效
  'activate_only_after',         // 对话到第 N 条之后才生效
  'activate_only_every',         // 每 N 条生效一次
  'keep_activate_after_match',   // 触发过一次就一直生效
  'dont_activate_after_match',   // 触发过一次就不再生效
  'position',                    // 插在角色卡前 / 后 —— 恰好对得上我们的 front / tail
]);

/**
 * 规范里有、但本软件【做不到】的装饰器。
 * 单独列出来是为了「如实报数」：让用户知道卡里有几条设定没生效，
 * 而不是把它们跟"不认识的野装饰器"混在一起报。
 */
const DECO_UNSUPPORTED = new Set([
  'depth', 'instruct_depth', 'reverse_depth', 'reverse_instruct_depth',
  'role', 'scan_depth', 'instruct_scan_depth',
  'is_greeting', 'ignore_on_max_context', 'is_user_icon', 'disable_ui_prompt',
]);

/**
 * 从世界书条目的 content 里剥出装饰器。
 *
 * ⚠️ 只有【开头连续的那几行】算装饰器。正文中间出现一行 "@@xxx" 不当装饰器 ——
 *    规范说的是"加在 content 字段里"，实际实现都是放在最前面；
 *    按"任何位置都算"去剥，会把正文里正常写到的 @@ 也吃掉。
 *
 * @param {string} content
 * @returns {{text:string, act:any, unsupported:string[], unknown:string[]}}
 */
export function parseDecorators(content) {
  const src = String(content == null ? '' : content);
  const out = { text: src, act: {}, unsupported: [], unknown: [] };
  if (!src.trim()) return out;
  const lines = src.split(/\r?\n/);
  // 先找出开头连续的装饰器行
  const groups = [];
  let i = 0;
  for (; i < lines.length; i++) {
    const m = /^\s*(@@@?)([A-Za-z_][A-Za-z0-9_]*)\s*(.*)$/.exec(lines[i]);
    if (!m) break;
    const isFallback = m[1] === '@@@';
    const name = m[2].toLowerCase();
    const value = m[3].trim();
    if (!isFallback || !groups.length) groups.push({ name, value, fallbacks: [] });
    else groups[groups.length - 1].fallbacks.push({ name, value });
  }
  if (!groups.length) return out;
  out.text = lines.slice(i).join('\n');

  for (const g of groups) {
    // 回退链：先看主装饰器，不认再按顺序看 @@@ 那些
    const chain = [{ name: g.name, value: g.value }, ...g.fallbacks];
    const hit = chain.find(x => DECO_ACT.has(x.name) || DECO_UNSUPPORTED.has(x.name));
    if (!hit) {
      // 一个都不认识 —— 记下来（第一个名字就够，报数用）
      out.unknown.push(g.name);
      continue;
    }
    if (DECO_UNSUPPORTED.has(hit.name)) { out.unsupported.push(hit.name); continue; }
    const v = hit.value;
    const num = Number(v);
    switch (hit.name) {
      case 'activate': out.act.always = true; break;
      case 'dont_activate': out.act.off = true; break;
      case 'keep_activate_after_match': out.act.keepAfter = true; break;
      case 'dont_activate_after_match': out.act.dontAfter = true; break;
      case 'additional_keys':
        out.act.addKeys = (out.act.addKeys || []).concat(v.split(',').map(s => s.trim()).filter(Boolean));
        break;
      case 'exclude_keys':
        out.act.excludeKeys = (out.act.excludeKeys || []).concat(v.split(',').map(s => s.trim()).filter(Boolean));
        break;
      case 'activate_only_after':
        if (Number.isFinite(num) && num >= 0) out.act.onlyAfter = num;
        break;
      case 'activate_only_every':
        if (Number.isFinite(num) && num >= 1) out.act.onlyEvery = num;
        break;
      case 'position':
        out.act.position = v;
        break;
      default: break;
    }
  }
  return out;
}

/** 内容里还有没有装饰器（导入时用来判断"这张卡是 V3 的那些"） */
export function hasDecorators(content) {
  return /^\s*@@@?[A-Za-z_]/.test(String(content == null ? '' : content));
}

// ============================================================
//  宏
// ============================================================

/** 稳定的字符串哈希（{{pick}} 要"每次看到同一个值"） */
function hash32(s) {
  let h = 2166136261;
  const str = String(s);
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/**
 * 展开正文里的宏。
 *
 * ⚠️ 认不出来的 {{xxx}} 【原样留着】—— 外面来的卡什么宏都有，
 *    一律删掉会把用户看不懂的东西变成"内容凭空少了一截"。
 *
 * @param {string} text
 * @param {{char?:string, user?:string, seed?:string}} [ctx]
 * @param {Function} [rng] 返回 [0,1) 的随机函数；测试用得上
 * @returns {string}
 */
export function expandMacros(text, ctx, rng) {
  const src = String(text == null ? '' : text);
  if (src.indexOf('{{') < 0) return src;
  const c = ctx || {};
  const charName = c.char || '她';
  const userName = c.user || '你';
  const random = typeof rng === 'function' ? rng : Math.random;
  const seed = String(c.seed || '');
  const pick = (list) => list[Math.floor(random() * list.length) % list.length];
  // ⚠️ {{//注释}} 要先单独处理：它不是「名字:值」的形状，通用正则匹配不到它，
  //    留在正文里就是一句谁看都莫名其妙的注释。规范里它就是"整段删掉"。
  const stripped = src.replace(/\{\{\s*\/\/[\s\S]*?\}\}/g, '');
  return stripped.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?::([\s\S]*?))?\}\}/g, (whole, nameRaw, valRaw) => {
    const name = String(nameRaw).toLowerCase();
    const val = valRaw == null ? '' : String(valRaw);
    if (name === 'char') return charName;
    if (name === 'user') return userName;
    // 空宏 {{}} / {{//}} 是注释
    if (name === '//' || name === 'comment') return '';
    if (name === 'hidden_key') return '';
    if (name === 'reverse') return val.split('').reverse().join('');
    if (name === 'random') {
      const list = val.split(',');
      return empty(list) ? '' : pick(list);
    }
    if (name === 'pick') {
      const list = val.split(',');
      if (empty(list)) return '';
      // 稳定：同一个 seed + 同一段宏 ⇒ 每次都挑同一个
      return list[hash32(seed + '|' + whole) % list.length];
    }
    if (name === 'roll') {
      const m = /^\s*(\d*)\s*[dD]\s*(\d+)\s*$/.exec(val);
      if (m) {
        const n = Math.max(1, Math.min(100, Number(m[1]) || 1));
        const faces = Math.max(1, Math.min(1000000, Number(m[2])));
        let sum = 0;
        for (let k = 0; k < n; k++) sum += 1 + Math.floor(random() * faces);
        return String(sum);
      }
      const mx = Number(val);
      if (Number.isFinite(mx) && mx >= 1) return String(1 + Math.floor(random() * mx));
      return whole;
    }
    return whole;   // 不认识的原样留着
  });
}

function empty(list) { return !list.length || (list.length === 1 && !list[0].trim()); }

// ============================================================
//  CHARX（zip 容器）
// ============================================================

export function isZip(buf) {
  const u8 = new Uint8Array(buf);
  return u8.length > 4 && u8[0] === 0x50 && u8[1] === 0x4B && (u8[2] === 0x03 || u8[2] === 0x05 || u8[2] === 0x07);
}

function latin1At(u8, from, to) {
  let s = '';
  for (let i = from; i < to; i++) s += String.fromCharCode(u8[i]);
  return s;
}

/**
 * 读一个 zip：返回 [{ name, bytes }]。
 *
 * 只认 store(0) 和 deflate(8) 两种压缩方式 —— 那是 zip 的绝对主流，
 * CHARX 打包工具产出的就是它们。别的直接跳过，不猜。
 * deflate 交给浏览器自带的 DecompressionStream('deflate-raw')：
 * 手写 inflate 是几百行，而且 WebView 里本来就有现成的。
 */
export async function readZip(buf) {
  const u8 = new Uint8Array(buf);
  if (!isZip(u8)) throw new Error('不是 zip 容器');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  // 从尾部往前找 EOCD（0x06054b50）
  let eocd = -1;
  for (let i = u8.length - 22; i >= 0 && i > u8.length - 66000; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip 结构异常：找不到结尾目录');
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (off + 46 > u8.length) break;
    if (dv.getUint32(off, true) !== 0x02014b50) break;
    const method = dv.getUint16(off + 10, true);
    const compSize = dv.getUint32(off + 20, true);
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const cmtLen = dv.getUint16(off + 32, true);
    const localOff = dv.getUint32(off + 42, true);
    const name = latin1At(u8, off + 46, off + 46 + nameLen);
    off += 46 + nameLen + extraLen + cmtLen;
    if (!compSize || name.endsWith('/')) continue;   // 目录项
    if (localOff + 30 > u8.length) continue;
    if (dv.getUint32(localOff, true) !== 0x04034b50) continue;
    const lNameLen = dv.getUint16(localOff + 26, true);
    const lExtraLen = dv.getUint16(localOff + 28, true);
    const dataAt = localOff + 30 + lNameLen + lExtraLen;
    const comp = u8.subarray(dataAt, dataAt + compSize);
    let bytes = null;
    if (method === 0) bytes = comp;
    else if (method === 8) bytes = await inflateRaw(comp);
    if (bytes) out.push({ name, bytes });
  }
  return out;
}

async function inflateRaw(comp) {
  if (typeof DecompressionStream !== 'function') return null;
  try {
    const ds = new DecompressionStream('deflate-raw');
    const blob = new Blob([comp]);
    const stream = blob.stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch { return null; }
}

/** 这个运行环境能不能解 CHARX（WebView 太老就不行，要如实告诉用户） */
export function canUnzip() {
  return typeof DecompressionStream === 'function';
}

/**
 * 从 CHARX 里取出 card.json 和资源表。
 * @returns {Promise<{json:string, files:Array<{name:string,bytes:Uint8Array}>}>}
 */
export async function readCharx(buf) {
  if (!canUnzip()) throw new Error('这台设备的 WebView 太老，解不开 .charx 压缩包 —— 请让作者导出 PNG 或 JSON 卡');
  const files = await readZip(buf);
  const cardFile = files.find(f => /(^|\/)card\.json$/i.test(f.name));
  if (!cardFile) throw new Error('这个 .charx 里没有 card.json（不像是角色卡）');
  const json = new TextDecoder('utf-8').decode(cardFile.bytes);
  return { json, files };
}

/** embeded://path → 这个资源在 zip 里的原始字节（规范里就是这个拼写） */
export function findAsset(files, uri) {
  const u = String(uri || '');
  const m = /^embeded:\/\/(.+)$/i.exec(u);
  if (!m) return null;
  const want = m[1].replace(/^\.?\//, '');
  const hit = (files || []).find(f => f.name === want || f.name.toLowerCase() === want.toLowerCase());
  return hit ? hit.bytes : null;
}

/** 字节 → data URL（立绘落到头像上用） */
export function bytesToDataUrl(bytes, mime) {
  let bin = '';
  const CH = 0x8000;
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < u8.length; i += CH) bin += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  return 'data:' + (mime || 'image/png') + ';base64,' + btoa(bin);
}

/** 按扩展名猜图片类型 */
export function mimeOf(name) {
  const n = String(name || '').toLowerCase();
  if (n.endsWith('.jpg') || n.endsWith('.jpeg')) return 'image/jpeg';
  if (n.endsWith('.webp')) return 'image/webp';
  if (n.endsWith('.gif')) return 'image/gif';
  if (n.endsWith('.avif')) return 'image/avif';
  return 'image/png';
}

export default {
  parseDecorators, hasDecorators, expandMacros,
  isZip, readZip, readCharx, canUnzip, findAsset, bytesToDataUrl, mimeOf,
};
