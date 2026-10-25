// www/js/critique.js —— 挑一条，并说清另外几条差在哪（活人感 v2）
//
// 为什么让同一个模型自己挑，而不是打分排序：
//   三条是同一个人的三种写法，差别不在"好坏"，在"像不像她"。
//   让一个 0.2 温度的调用去挑，等于让它做一次冷判断 ——
//   冷判断最擅长抓"客服腔 / 把话说满 / 金句收尾"这些硬毛病，这正是我们要的。
//
//   flaws 不是为了给用户看，是为了【触发重写】：两条以上毛病，或者它自己说
//   "三条都不行"，就带着 rewrite 方向重写一次。没有这一环，三条全烂时
//   她只能挑烂得最轻的那条发出去。
//
// ⚠️ 评审失败【不能挡聊天】：pick 拿不到就取候选 0（温度 0.85 那条最稳）。
//   挑错了顶多这一条平庸，卡住就是她一句话都发不出来。

import { onceChat } from './api.js';

/** 评审的输出上限。JSON + 几条 flaws，700 够。 */
const CRITIQUE_MAX_TOKENS = 700;

/** flaws 条数与每条字数上限。写长了它就开始写小作文，而不是挑毛病。 */
const MAX_FLAWS = 6;
const FLAW_MAX = 40;
const REWRITE_MAX = 80;

/** 围栏记号单独拼（同 director.js：直接写三个反引号容易和模板串打架）。 */
const FENCE = String.fromCharCode(96, 96, 96);
const FENCE_RE = new RegExp(FENCE + '(?:json)?\\s*([\\s\\S]*?)' + FENCE, 'i');

function cut(v, n) {
  const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) : s;
}

/**
 * 评审指令。评分标准那一段是逐字的 —— 它决定了"像 AI"在她这里的具体所指，
 * 改一个词（比如加上"不要用 fancy 的比喻"）就会把权重带偏。
 *
 * @param {{pool?:Array, inner?:string, userText?:string, moveName?:string}} o
 * @returns {string}
 */
export function critiqueAsk(o = {}) {
  const pool = Array.isArray(o.pool) ? o.pool : [];
  const n = pool.length || 1;
  const inner = String(o.inner == null ? '' : o.inner).trim() || '（没写）';
  const userText = String(o.userText == null ? '' : o.userText).trim() || '（他没说具体的）';
  const moveName = String(o.moveName == null ? '' : o.moveName).trim() || '（没定）';

  const head = [
    '（她这一轮没说出口的是：' + inner + '）',
    '（他这一轮说的是：' + userText + '）',
    '（这一轮她打算的是：' + moveName + '）',
    '',
    '下面是同一个人对同一句话写的 ' + n + ' 条回复。挑出【最像这个人、最不像 AI】的那一条。',
    '',
    '像 AI 的，扣分：',
    '- 解释自己为什么这么说 / 为什么这么想',
    '- 把情绪总结出来（「一时间百感交集」这一类）',
    '- 把话说满、说完、给出结论',
    '- 客服腔、共情腔（「我理解你的感受」）',
    '- 堆比喻、堆形容词',
    '- 每句都语法完整、句句都在收尾',
    '- 金句收尾、排比、突然升华',
    '',
    '像她的，加分：',
    '- 里面有具体的动作或具体的物件',
    '- 有停顿、有留白、有说了半句不说了',
    '- 句子长短不齐、有的话不完整',
    '- 答非所问但符合她这个人',
    '- 说出口的只是她心里的一部分，不是全部'
  ].join('\n');

  const cand = [];
  for (let i = 0; i < pool.length; i++) {
    const t = String((pool[i] && pool[i].text) || '').trim();
    cand.push('候选 ' + (i + 1) + '：');
    cand.push(t || '（空）');
    if (i < pool.length - 1) cand.push('');
  }

  const tail = [
    '只输出 JSON，不要解释：',
    '{"pick": 编号, "flaws": ["这条为什么不行", ...], "rewrite": "三条都不行时给一句重写方向，否则空串"}'
  ].join('\n');

  return head + '\n\n————\n\n' + cand.join('\n') + '\n\n————\n\n' + tail;
}

/**
 * 从评审输出里抠出判断。
 *
 * 容忍：markdown 围栏、前后废话、尾逗号、中文引号、单引号。
 * 不容忍：没有 pick（那就当这次评审作废，返回 null → 走候选 0）。
 *
 * @param {string} text 模型输出
 * @param {number} [n] 候选条数。给了就校验越界（越界 → null）
 * @returns {{pick:number, flaws:string[], rewriteHint:string, rewrite:string, usage?:object|null}|null}
 *          pick 是【0 起】的下标；flaws 最多 6 条每条 40 字；rewriteHint 最多 80 字
 */
export function parseCritique(text, n) {
  let s = String(text == null ? '' : text).trim();
  if (!s) return null;
  const fence = s.match(FENCE_RE);
  if (fence) s = fence[1].trim();
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  // 尾逗号 / 中文引号 / 单引号包裹的键值：模型偶尔会这么写。
  s = s.replace(/,\s*([}\]])/g, '$1')
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/'([^'\\]*)'/g, '"$1"');
  let raw;
  try {
    raw = JSON.parse(s);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const pv = Number(raw.pick);
  if (!Number.isFinite(pv)) return null;
  const pick = Math.floor(pv) - 1;   // 模型按 1..N 编号，这里换成 0 起下标
  if (pick < 0) return null;
  if (Number.isFinite(Number(n)) && Number(n) > 0 && pick >= Number(n)) return null;

  const flaws = (Array.isArray(raw.flaws) ? raw.flaws : [])
    .map(f => cut(typeof f === 'string' ? f : (f && (f.t || f.text)), FLAW_MAX))
    .filter(Boolean).slice(0, MAX_FLAWS);
  const rewriteHint = cut(raw.rewrite != null ? raw.rewrite : raw.rewriteHint, REWRITE_MAX);

  // rewrite 与 rewriteHint 是同一个东西的两个名字：文档里两处写法不一致，
  // 与其在调用点猜，不如两个都挂上，谁读都对。
  return { pick, flaws, rewriteHint, rewrite: rewriteHint };
}

/**
 * 跑一次评审。
 *
 * @param {object} o
 * @param {Array}  o.pool     候选 [{text}]
 * @param {string} [o.inner]  她这一轮的独白
 * @param {string} [o.userText] 他这一轮说的
 * @param {string} [o.moveName] 这一轮的动作中文名
 * @param {string} [o.stable] 人设稳定前缀（为了命中缓存）
 * @param {{apiKey?:string, baseUrl?:string, provider?:string, model?:string, timeoutMs?:number}} o.api
 * @param {AbortSignal} [o.signal]
 * @returns {Promise<object|null>} 失败/中断一律 null
 */
export async function runCritique(o) {
  const { pool, inner, userText, moveName, stable, api, signal } = o || {};
  if (!api || !api.apiKey) return null;
  if (signal && signal.aborted) return null;
  if (!Array.isArray(pool) || !pool.length) return null;

  const msgs = [];
  if (stable) msgs.push({ role: 'system', content: stable });
  msgs.push({ role: 'user', content: critiqueAsk({ pool, inner, userText, moveName }) });

  let out = '';
  let usage = null;   // v2：评审自己的用量，调用方要累加进这一轮
  try {
    out = await onceChat({
      apiKey: api.apiKey,
      baseUrl: api.baseUrl,
      provider: api.provider,
      model: api.model,
      messages: msgs,
      // 极低温：这一步是挑，不是写。温度高了它会开始偏心"更煽情"的那条。
      temperature: 0.2,
      maxTokens: CRITIQUE_MAX_TOKENS,
      // 关思考：只输出 JSON 的活，开思考会把 700 上限烧穿（同 director.js）。
      noThink: true,
      timeoutMs: Number(api.timeoutMs) || 20000,
      onUsage: (u) => { usage = u || null; }
    });
  } catch (err) {
    console.warn('[critique] 评审失败，这一轮直接用候选 1：' + ((err && err.message) || err));
    return null;
  }
  const got = parseCritique(out, pool.length);
  if (got) got.usage = usage;   // 拿不到就是 null（老端点不回 usage）
  if (!got) {
    console.warn('[critique] 评审输出看不懂，这一轮直接用候选 1：' + String(out).slice(0, 120));
    return null;
  }
  return got;
}
