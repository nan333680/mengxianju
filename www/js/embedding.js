// www/js/embedding.js —— 本地向量（辅助层）
//
// 谁在用：重复检测（"这句是不是又把上次的话说了一遍"）和候选重排的对照。
// 谁不用：正文生成。主生成永远走云端 —— 本地模型只负责"像不像、是不是同一件事"。
//
// 模型在 APK 自带 assets 里（bge-small-zh-v1.5 量化版 24MB），原生层用 ONNX Runtime 跑，
// 这里只负责：取插件 → 带缓存地调 → 把错误吞掉。
//
// ⚠️ 一句话都不能因为它失败：
//   插件取不到（浏览器 / e2e / 老版本壳）→ 全部返回 null；
//   模型加载失败（内存、ABI、文件损坏）→ 返回 null，并记住失败原因，别每轮重试。
//   上层拿到 null 就走原来的关键词路径，行为与 0.5.3.5 完全一致。

/** 向量维度（bge-small-zh = 512）。只在自己算 cosine 时用到，实际以原生返回为准。 */
export const DIM = 512;

/** 缓存条数上限。一条 512 维 float 约 2KB（JS 里更胖，按 4~8KB 算），200 条 1MB 级。 */
const CACHE_MAX = 200;

/** 首次调用要加载 24MB 模型，给足时间；之后一次 10~80ms。 */
const TIMEOUT_MS = 20000;

const cache = new Map();      // text -> Float32Array
let pluginCache;              // undefined=还没取过, null=没有
let brokenReason = '';        // 一旦确定不可用就记住，别反复试

/** 取原生插件（取不到返回 null，绝不抛） */
function plugin() {
  if (pluginCache !== undefined) return pluginCache;
  try {
    // ⚠️ 必须这么写：直接取 window.Capacitor 会多出一条 tsc 类型噪音（CI 基线会飘）
    const C = typeof window !== 'undefined' ? /** @type {any} */ (window).Capacitor : null;
    pluginCache = (C && C.Plugins && C.Plugins.LocalEmbed) || null;
  } catch { pluginCache = null; }
  return pluginCache;
}

/** 这条文本的缓存键。用整串文本，不做 hash（撞了会把两句话当成同一句）。 */
function keyOf(text) { return String(text == null ? '' : text); }

/**
 * 本地向量可用吗（同步判断，只看插件在不在，不加载模型）。
 * 真正的可用性要等 embedTexts 第一次返回非 null。
 */
export function localEmbedAvailable() {
  return !!plugin() && !brokenReason;
}

/** 为什么不可用（给诊断页/控制台看）。 */
export function localEmbedError() { return brokenReason; }

function withTimeout(p, ms) {
  let timer = null;
  const t = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error('local-embed 超时 ' + ms + 'ms')), ms);
  });
  return Promise.race([p, t]).finally(() => { if (timer) clearTimeout(timer); });
}

/**
 * 批量取向量。失败/不可用一律返回 null（不是空数组 —— 空数组会让"没取到"和"空文本"混在一起）。
 *
 * @param {string[]} texts
 * @returns {Promise<Array<Float32Array>|null>}
 */
export async function embedTexts(texts) {
  const list = (Array.isArray(texts) ? texts : []).map(keyOf);
  if (!list.length) return [];
  const p = plugin();
  if (!p) { brokenReason = '没有 LocalEmbed 插件（浏览器环境）'; return null; }
  if (brokenReason) return null;

  // 命中缓存的直接拿，没命中的才发一批
  const miss = [];
  const missIdx = [];
  for (let i = 0; i < list.length; i++) {
    if (!cache.has(list[i])) { miss.push(list[i]); missIdx.push(i); }
  }
  if (miss.length) {
    try {
      const r = await withTimeout(p.embed({ texts: miss }), TIMEOUT_MS);
      const vecs = (r && r.vectors) || [];
      if (vecs.length !== miss.length) throw new Error('返回条数对不上：' + vecs.length + '/' + miss.length);
      for (let i = 0; i < miss.length; i++) {
        const v = vecs[i] && vecs[i].length ? Float32Array.from(vecs[i]) : null;
        if (!v) throw new Error('第 ' + i + ' 条向量是空的');
        cache.set(miss[i], v);
        // 简单 LRU：超上限就删最老的一条（Map 保持插入顺序）
        if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
      }
    } catch (e) {
      // 模型加载失败这类"重试也没用"的错误要记住；单次超时可以下次再试
      const msg = String((e && e.message) || e);
      if (!/超时/.test(msg)) brokenReason = msg;
      console.warn('[embed] 本地向量不可用：' + msg);
      return null;
    }
  }
  const out = new Array(list.length);
  for (let i = 0; i < list.length; i++) {
    const v = cache.get(list[i]);
    if (!v) return null;
    out[i] = v;
  }
  return out;
}

/** 单条（带缓存）。 */
export async function embedOne(text) {
  const r = await embedTexts([text]);
  return r ? r[0] : null;
}

/** 余弦相似度。向量已 L2 归一化，所以就是点积；长度不同的按短的算。 */
export function cosine(a, b) {
  if (!a || !b) return 0;
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

/**
 * 在池子里找最像 vec 的一条。
 * @returns {{idx:number, score:number}} 池子空时 {idx:-1, score:0}
 */
export function bestMatch(vec, pool) {
  let bi = -1, bs = -1;
  if (!vec || !Array.isArray(pool)) return { idx: bi, score: 0 };
  for (let i = 0; i < pool.length; i++) {
    const s = cosine(vec, pool[i]);
    if (s > bs) { bs = s; bi = i; }
  }
  return { idx: bi, score: Math.max(0, bs) };
}

/** 清空缓存（换角色 / 设置里手动重载时用）。 */
export function clearEmbedCache() { cache.clear(); }
