// API 调用层：流式对话 + 图片识图（OpenAI 兼容协议）
//
// v1.21.47 起不再是"只服务 DeepSeek"：任何说 OpenAI 兼容协议的服务商都能接，
// 差异（推理强度档位、用量字段、思考字段名、余额接口）收进下面的档案表。

import { kindOfStatus } from './errorkit.js';

// ============================================================
// 服务商档案
// ============================================================
// 本项目只会说一种协议：OpenAI 兼容（POST {base}/chat/completions + Bearer）。
// 各家真正的差异不在协议，而在这些细节，所以每家一条档案：
//   reasoning —— 认不认 reasoning_effort，我们内部那四档怎么映射（null = 不发这个字段）
//   usage     —— 认不认 stream_options.include_usage
//   think     —— 思考内容放在哪个字段名里
//   balance   —— 有没有 /user/balance（已知只有 DeepSeek 有）
//
// ⚠️ baseUrl / model 只是【填进去的初值】，用户随时能改；写死的是"能力"，不是"地址"。
// ⚠️ 没列进来的服务商不等于不能用：选「自定义」把地址填上就行；
//    端点不认某个可选字段时，postChat 还会按报错自动摘掉重试一次。
const R_NONE = { none: null, low: null, high: null, max: null };   // 完全不发 reasoning_effort

export const PROVIDERS = {
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash', vision: 'deepseek-flash',
    reasoning: { none: 'none', low: 'low', high: 'high', max: 'max' },
    // 「这个请求不用想，直接答」—— 只给那些真的要一句话就答的活（剧情判定器）。
    // 只写 reasoning_effort 关不掉：实测 reasoning_effort:'none' 时它照样先在
    // reasoning_content 里盘算一大段，content 有时是空的、有时被 max_tokens 截断。
    thinkOff: { thinking: { type: 'disabled' } },
    usage: true, think: 'reasoning_content', balance: true,
    note: '默认。自带看图能力，能查余额。',
  },
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini', vision: 'gpt-4o-mini',
    reasoning: { none: null, low: 'low', high: 'high', max: 'high' },
    usage: true, think: 'reasoning_content', balance: false,
    note: '只有 o 系列/新模型认 reasoning_effort，不认的会自动摘掉重试。',
  },
  kimi: {
    label: 'Kimi（月之暗面）',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k', vision: 'moonshot-v1-8k',
    reasoning: R_NONE,
    usage: true, think: 'reasoning_content', balance: false,
    note: 'moonshot-v1-8k 便宜够聊；要长上下文自己换成 32k / 128k。',
  },
  zhipu: {
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash', vision: 'glm-4v-flash',
    reasoning: R_NONE,
    usage: true, think: 'reasoning_content', balance: false,
    note: 'glm-4-flash 有免费档；看图用 glm-4v-flash。',
  },
  siliconflow: {
    label: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen2.5-7B-Instruct', vision: 'Qwen/Qwen2.5-VL-7B-Instruct',
    reasoning: R_NONE,
    usage: true, think: 'reasoning_content', balance: false,
    note: '模型名要写全（带斜杠那种），换模型以官网列表为准。',
  },
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'deepseek/deepseek-chat', vision: '',
    reasoning: { none: null, low: 'low', high: 'high', max: 'high' },
    usage: true, think: 'reasoning', balance: false,
    note: '一个 key 调很多家模型，代价是加价和延迟。',
  },
  ollama: {
    label: '本地（Ollama）',
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen2.5:7b', vision: '',
    reasoning: R_NONE,
    usage: false, think: 'reasoning_content', balance: false,
    note: '跑在自己电脑上：手机里填 localhost 没用，要填那台电脑的局域网 IP。',
  },
  custom: {
    label: '自定义（OpenAI 兼容）',
    baseUrl: '', model: '', vision: '',
    reasoning: R_NONE,
    usage: false, think: 'reasoning_content', balance: false,
    note: '任何 OpenAI 兼容的中转或自建服务，地址填到 .../v1 这一层。',
  },
};

export function providerSpec(id) {
  return PROVIDERS[id] || PROVIDERS.deepseek;
}

/** 给设置页的下拉用 */
export function providerList() {
  return Object.keys(PROVIDERS).map(k => ({ value: k, label: PROVIDERS[k].label, note: PROVIDERS[k].note || '' }));
}

/**
 * 发一次对话请求；端点不认某个可选字段时，按报错摘掉它重发一次。
 *
 * 为什么要这样：OpenAI 兼容只是"大致兼容"。实测不少端点（各家中转、自建 vLLM、
 * 老版本 Ollama）收到不认识的字段直接 400，而错误信息里往往就点着字段名。
 * 与其让用户自己去猜是 reasoning_effort 还是 stream_options 惹的祸，
 * 不如按报错摘掉重试 —— 只降一次，不无限重试。
 */
/**
 * 400 / 422 时 postChat 会把响应体读出来，看是哪个字段惹的祸。
 *
 * ⚠️ Response 的 body 【只能读一次】—— 读过之后下游再 `res.text()` 只会得到
 * 空串。于是下游拼错误信息时拿不到服务端的原话，用户看到的永远是
 * 「API 错误 400: Bad Request」这种什么都没说的东西，
 * 而服务端其实明明白白写了原因（"context length exceeded" / "invalid model" …）。
 * 读过的原文存在这里，下游优先取它。
 */
const bodyTextCache = new WeakMap();

/**
 * 把 HTTP 层失败包成一个【带结构】的错误（v0.5.3.2，清单 §3.1）。
 * message 仍是老格式（e2e 与日志靠它 grep），多出来的是 status / detail / kind：
 * 界面拿 kind 去翻成人话，日志拿 detail 去排错，谁也不吃掉谁。
 * @param {number} status
 * @param {string} detail
 */
function apiErr(status, detail) {
  // 抛给界面的对象要多挂几个字段（status/detail/kind），Error 的类型里没有它们
  const e = /** @type {any} */ (new Error('API 错误 ' + status + (detail ? ': ' + detail : '')));
  e.status = status;
  e.detail = detail || '';
  e.kind = kindOfStatus(status, detail);
  return e;
}

/** 读失败响应体。400/422 的 body 已被 postChat 读走，必须用缓存那份。 */
async function readErrDetail(res) {
  const cached = bodyTextCache.get(res);
  if (cached !== undefined) return errorMessageOf(cached);
  try { return errorMessageOf(await res.text()); } catch { return ''; }
}

/** 可被打断的等待（用户按停止时立刻结束，不留一个睡着的定时器） */
function nap(ms, signal) {
  return new Promise(done => {
    const t = setTimeout(done, ms);
    if (!signal) return;
    const bail = () => { clearTimeout(t); done(undefined); };
    if (signal.aborted) bail(); else signal.addEventListener('abort', bail, { once: true });
  });
}

/** 从错误响应里挑出人话：优先 JSON 的 error.message，退回落原文。 */
function errorMessageOf(text) {
  try { return JSON.parse(text).error?.message || text; } catch { return text; }
}

async function postChat(url, apiKey, body, signal) {
  const send = (b) => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
    body: JSON.stringify(b), signal
  });
  let res = await send(body);
  if (res.status === 400 || res.status === 422) {
    const txt = await res.text().catch(() => '');
    // 存一份给下游（见 bodyTextCache 的说明）—— 这里读了，外面就读不到了
    if (txt) bodyTextCache.set(res, txt);
    const drop = /reasoning_effort/i.test(txt) ? 'reasoning_effort'
               : /thinking/i.test(txt) ? 'thinking'
               : /stream_options|include_usage/i.test(txt) ? 'stream_options'
               : null;
    if (drop && body[drop] !== undefined) {
      const b2 = { ...body };
      delete b2[drop];
      console.warn('[api] 这个端点不认 ' + drop + '，摘掉重试一次');
      res = await send(b2);
    }
  }
  return res;
}

function joinUrl(baseUrl, path) {
  const b = (baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
  return b + path;
}

/**
 * 把内部消息格式转成 OpenAI 兼容格式
 * 内部: { role, content, images?: [dataUrl] }
 */
function toApiMessage(m) {
  if (m.images && m.images.length) {
    const parts = [];
    if (m.content) parts.push({ type: 'text', text: m.content });
    for (let i = 0; i < m.images.length; i++) {
      const note = String((m.imageNotes && m.imageNotes[i]) || '').trim();
      // 说明紧贴在这张图前面，标明「这是给图看的」——
      // 免得被当成台词。人设里括号是动作，所以这里用方括号另开一个通道。
      if (note) parts.push({ type: 'text', text: `［第 ${i + 1} 张图的说明：${note}］` });
      parts.push({ type: 'image_url', image_url: { url: m.images[i] } });
    }
    return { role: m.role, content: parts };
  }
  return { role: m.role, content: m.content || '' };
}

/**
 * 判断这轮请求是否需要视觉模型
 */
export function needsVision(messages) {
  return messages.some(m => m.images && m.images.length);
}

// ================= 上下文预算（v1.21.54） =================
//
// 目的：在"撞爆模型窗口"之前就知道大概用了多少，好提前砍历史。
// 为什么不用真 tokenizer：APK 是纯前端，塞一份 BPE 词表要多几百 KB、
// 还要跟着模型换代；这里只需要"够用的保守估计"。
// 保守的方向是【往多了算】—— 高估的代价只是少带几条历史，
// 低估的代价是请求被服务端打回、用户看到一句报错。

/**
 * 估一段文本的 token 数。
 * 规则：非 ASCII（中日文、全角标点、emoji）1 token/字；
 *       ASCII 按 3.5 字符/token（真值约 4 —— 取小就是往多了算）。
 * 参照：DeepSeek 中文实测约 0.6~1 token/字，英文约 4 字符/token。
 */
export function estimateTokens(text) {
  const s = text == null ? '' : String(text);
  if (!s) return 0;
  let wide = 0, ascii = 0;
  for (const ch of s) { if (ch.codePointAt(0) > 0x7f) wide++; else ascii++; }
  return wide + Math.ceil(ascii / 3.5);
}

/**
 * 一张图算多少 token。
 * ⚠️ 绝不能去量 images 里那个 dataURL 的 base64 长度 ——
 * 一张 1024px 的图有几十万字符，按字符估会算出十几万 token，
 * 结果是把历史全砍光、她当场失忆。
 * 视觉模型对一张 1024px 图实际约 700~1100 token，这里取 1200。
 */
export const TOKENS_PER_IMAGE = 1200;

/** 估一条消息（含图）。+4 ≈ 每条的 role / 分隔开销。 */
export function estimateMsgTokens(m) {
  if (!m) return 0;
  let n = estimateTokens(m.content) + 4;
  const imgs = (m.images && m.images.length) ? m.images.length : 0;
  if (imgs) n += imgs * TOKENS_PER_IMAGE;
  // ⚠️ 用 Array.isArray 而不是只判 length：imageNotes 可能是从外面导进来的
  // 字符串（导入路径有归一化，但这不是唯一入口），对字符串调 .filter 会 TypeError ——
  // 而它发生在拼请求体的路上，一炸就是整条消息发不出去。
  if (Array.isArray(m.imageNotes) && m.imageNotes.length) {
    n += estimateTokens(m.imageNotes.filter(Boolean).join('\n'));
  }
  return n;
}

/** 估一整段消息。 */
export function estimateMessagesTokens(list) {
  const arr = Array.isArray(list) ? list : [];
  let n = 0;
  for (const m of arr) n += estimateMsgTokens(m);
  return n;
}

/**
 * 按 token 预算从【最新往回】截历史。
 *
 * 放在 api.js 而不是 app.js，是为了能被单测直接 import ——
 * 它不认识 DOM，只认识消息数组（e2e-ctxbudget 就是这么测它的）。
 *
 * 只裁历史这一件事：调用方负责保证传进来的就是"可以丢的那一段"。
 * 人设 / 世界书 / 记忆 / 本轮时间不该出现在这里 ——
 * 砍了它们等于她当场失忆、设定崩掉，比报错难查得多。
 *
 * 不做"从中间挑几条凑"：断在中间会让对话逻辑错位，
 * 只从最旧的一端整段丢掉。
 *
 * @param {Array} list 历史消息（旧 → 新）
 * @param {number} budget 这一段的 token 上限
 * @param {number} minKeep 无论如何至少留几条
 * @returns {{kept: Array, dropped: number, tokens: number}}
 */
export function fitHistoryByBudget(list, budget, minKeep = 2) {
  const all = Array.isArray(list) ? list : [];
  if (!all.length) return { kept: [], dropped: 0, tokens: 0 };
  const cap = Number(budget);
  // ⚠️ 预算【读不到】（NaN/undefined，比如设置项还没写进库）时不裁 ——
  // 宁可原样发出去让服务端报错，也不要因为一个配置缺失就静默清空历史。
  // 但 cap === 0 是另一回事：那是"固定段已经吃满预算"的合法结果，
  // 这时必须裁到只剩 minKeep 条，否则预算机制在极端情况下等于没生效。
  if (!Number.isFinite(cap)) return { kept: all.slice(), dropped: 0, tokens: estimateMessagesTokens(all) };
  const limit = Math.max(0, cap);

  const kept = [];
  let used = 0;
  for (let i = all.length - 1; i >= 0; i--) {
    const cost = estimateMsgTokens(all[i]);
    if (kept.length >= minKeep && used + cost > limit) break;
    kept.push(all[i]);
    used += cost;
  }
  kept.reverse();
  return { kept, dropped: all.length - kept.length, tokens: used };
}

/**
 * 这个报错是不是「上下文超长」。
 *
 * ⚠️ 模式必须写具体。判错的代价是把一次网络抖动当成超长，
 * 白白砍掉一段历史重发 —— 用户看到的是"她突然忘事"，比报错更难查。
 * 所以只认各家明确写在错误文本里的那几种说法。
 */
const OVERFLOW_PATTERNS = [
  /context[_ ]length[_ ]exceeded/i,
  /maximum context length/i,
  /context window/i,
  /reduce the length of the messages/i,
  /too many tokens/i,
  /max(?:imum)?[_ ]?tokens?[^.]{0,24}exceed/i,
  /exceed[^.]{0,32}(?:context|token)/i,
  /(?:input|prompt|messages?)[^.]{0,32}(?:is )?too long/i,
  /上下文[^。；]{0,24}(?:超|过长|上限|溢出)/,
  /(?:输入|提示|消息)[^。；]{0,24}(?:过长|太长|超出)/,
];

/** @returns {boolean} 这个错误是不是"上下文超长" */
export function isContextOverflow(err) {
  const msg = String((err && (err.message || err)) || '');
  if (!msg) return false;
  return OVERFLOW_PATTERNS.some(re => re.test(msg));
}

/**
 * 流式对话。yield 文本增量。
 */
export async function* streamChat(opts) {
  let thinkBuf = '';   // 累积思考内容，收尾时交出去（v1.21.30）
  const {
    apiKey, baseUrl, model, messages, provider,
    temperature = 1.0, maxTokens = 2048, topP = 1.0,
    reasoningEffort = 'none',
    signal, onUsage, onThink, onFinish
  } = opts;
  const spec = providerSpec(provider);

  if (!apiKey) throw new Error('未配置 API Key，请到「设置」里填写');

  // —— 卡死保护 ——
  // 服务端连上了却不吐数据（或首包永远不来）时，以前只能干等：busy 一直挂着，
  // 除非他自己想起来按「停止」。这里 60 秒没有新数据就主动断开。
  // 用一个普通 Error 而不是 AbortError：app.js 会走「这条没发出去 + 重试一次」
  // 那条分支，而不是当成用户主动停止。
  const ctl = new AbortController();
  const onOuterAbort = () => ctl.abort();
  if (signal) {
    if (signal.aborted) ctl.abort();
    else signal.addEventListener('abort', onOuterAbort, { once: true });
  }
  let stallTimer = null;
  const bump = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(
      () => ctl.abort(new Error('等太久了：服务器 60 秒没有回数据，检查下网络或稍后重试')),
      60000);
  };
  bump();

  const body = {
    model,
    messages: messages.map(toApiMessage),
    temperature: Number(temperature),
    max_tokens: Number(maxTokens),
    top_p: Number(topP),
    stream: true
  };
  // 让最后一帧带上用量（这轮花了多少、缓存命中多少）。认不认这个字段各家不一样。
  if (spec.usage) body.stream_options = { include_usage: true };
  // ⚠️ reasoning_effort 的档位各家不同：DeepSeek 是 none/low/high/max，
  //    OpenAI 是 minimal/low/medium/high，还有一批根本不认这个字段（发了就 400）。
  //    所以走档案映射；映射成 null = 这家不认，干脆不发。
  //    （DeepSeek 上实测：传 "off" 会报错，关闭思考必须用 "none"。）
  const eff = (spec.reasoning || {})[reasoningEffort];
  if (eff) body.reasoning_effort = eff;

  // 整个请求过程都包在 try 里，收尾统一走 finally。
  // 以前只有 [DONE] 和正常扫完才 clearTimeout：API 报错、网络中断、用户点停止
  // 这几条路径上，那个 60 秒的看门狗会一直挂到最后，再对废弃的 controller 调 abort。
  try {
    // ⚠️ 限流与 5xx 在【HTTP 层】退避重试（v0.5.3.2，清单 §3.1）。
    //    为什么放在这里而不是上层：此刻一个字都还没吐出去，重试没有任何副作用；
    //    上层重试时已经分不清「这是第二次」还是「用户又发了一条」。
    //    429 只重试【限流】，额度用完（quota）重试一百次也不会变。
    //    401/402/403/404/400/422 一律不重试 —— 换一秒再问一遍，答案还是一样。
    let res;
    for (let attempt = 0; ; attempt++) {
      res = await postChat(joinUrl(baseUrl, '/chat/completions'), apiKey, body, ctl.signal);
      if (res.ok) break;
      const detail = await readErrDetail(res);
      const kind = kindOfStatus(res.status, detail);
      const retryable = (kind === 'rate' || kind === 'server') && attempt < 2;
      if (!retryable) throw apiErr(res.status, detail || res.statusText);
      const waitMs = (kind === 'rate' ? 1500 : 900) * (attempt + 1);
      console.warn('[api] ' + res.status + ' ' + kind + '，' + waitMs + 'ms 后重试（第 ' + (attempt + 1) + ' 次）');
      await nap(waitMs, ctl.signal);
      bump();
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      // ⚠️ 收尾（v1.21.52）：reader 结束时 buf 里可能还压着最后一行。
      // 自建端点（vLLM / Ollama / 部分中转）最后一个事件常常不带结尾换行，
      // 原来 done 直接 break，那半句就永远没人解析 —— 表现为回复被静默截断。
      // 现在：还有残留就补个换行，让它当成完整行走一遍下面的解析；
      // 下一轮 read() 依旧返回 done，而此时 buf 已空 → 正常退出。
      if (done) {
        buf += decoder.decode();      // 把解码器里那半个字符也冲出来
        if (!buf.trim()) break;
        buf += '\n';
      } else {
        bump();   // 有新数据 → 重新计时
        buf += decoder.decode(value, { stream: true });
      }

      const lines = buf.split('\n');
      buf = lines.pop();  // 最后一段可能不完整，留到下一轮

      for (const line of lines) {
        const s = line.trim();
        if (!s || !s.startsWith('data:')) continue;
        const payload = s.slice(5).trim();
        if (payload === '[DONE]') return;   // 收尾交给 finally
        try {
          const j = JSON.parse(payload);
          if (j.usage && onUsage) onUsage(j.usage);
          // ⚠️ 收尾标记（v1.21.54）：finish_reason 以前从头到尾没人读。
          //    被 max_tokens 截断时服务端给的是 'length'，而客户端一无所知 ——
          //    半句话当完整回复落库、还成为后续上下文，用户只看到"她话说一半停了"，
          //    连个重试入口都没有（非流式的 onceChat 那边至少有"可能被截断"的兜底提示）。
          const fr = j.choices?.[0]?.finish_reason;
          if (fr && onFinish) onFinish(String(fr));
          const delta = j.choices?.[0]?.delta;
          if (!delta) continue;
          // 思考模式的内容单独走，不混进正文
          // ⚠️ 思考内容【累积但不丢弃】（v1.21.30 修，复审省略号专项 C）。
          //
          // 起因：原来这里是裸 `continue` —— 直接扔。而非流式 onceChat 那边有兜底
          // （content 为空时从 reasoning 里抠内容）。两条链路处理不一致。
          // 后果：模型把话写进 reasoning_content、content 留空时，聊天链路【拿不到内容】
          // → 只能走兜底 → 用户看到的是兜底句，不是模型本来想说的话。
          // 这也解释了「兜底修了但还差了点」：兜底是遮盖症状，没把内容取回来。
          //
          // ⚠️ reasoning 通常含大量自我盘算，【不能直接当正文】（会把内心戏说出口）。
          // 思考字段各家叫法不同：多数是 reasoning_content，OpenRouter 用 reasoning
          const thinkTxt = delta[spec.think] || delta.reasoning_content;
          if (thinkTxt) {
            thinkBuf += String(thinkTxt);
            continue;
          }
          if (delta.content) yield delta.content;
        } catch { /* 忽略半截 JSON */ }
      }
    }
  } finally {
    clearTimeout(stallTimer);
    // 把累积的思考内容交出去（可能为空串）。调用方用来给兜底当素材，不直接当正文。
    if (onThink && thinkBuf) { try { onThink(thinkBuf); } catch { /* 回调出错不该影响主流程 */ } }
  }
}

/** 非流式调用（用于记忆总结等） */
export async function onceChat(opts) {
  const {
    apiKey, baseUrl, model, messages, provider, temperature = 0.3, maxTokens = 1024,
    reasoningEffort = 'none',   // 见下面 ⚠️
    noThink = false,            // 见下面 ⚠️⚠️
    onUsage = null,             // v2：要把这一步的用量交给调用方累加时传回调
    // v0.5.2：小说正文一次要写 1200 字，90 秒不够用（记忆整理那种短活仍用默认）。
    timeoutMs = 90000,
  } = opts;
  const spec = providerSpec(provider);
  const eff = (spec.reasoning || {})[reasoningEffort];
  if (!apiKey) throw new Error('未配置 API Key');
  // 记忆总结 / 查重走这里。没有超时的话，一次卡住会让 _summarizing / _deduping
  // 永远保持 true，之后所有记忆任务都静默不再执行。
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(new Error('等太久了：' + Math.round(timeoutMs / 1000) + ' 秒没有回数据')), timeoutMs);
  let res;
  try {
    // ⚠️ 必须显式关掉思考模式（2026-09-26 修）
    //
    // 起因（实测抓到的响应）：这三个调用（记忆总结 / 查重 / 滚动摘要）都是
    // "给你一段文本，只输出 JSON" 的活。但模型默认开着思考模式时，
    // 它会把整段推理【连同该输出的 JSON】全写进 reasoning_content，
    // 而 message.content 是空串 ——
    //
    //   {"message":{"content":"", "reasoning_content":"输出 JSON 数组...[{...}]"}}
    //
    // 旧代码只取 message.content，于是拿到 ''，parseMemJson 解析失败，
    // 记忆一条都写不进去。表现就是用户看到的「整理没生效」「记忆一直是空的」。
    // 实测：塞 100 条有内容的对话，归档了 72 条，记忆 0 条。
    //
    // v1.21.47：档位按服务商映射；映射成 null 就【不带这个字段】——
    // 有些兼容端点收到不认识的字段直接 400。
    // ⚠️⚠️ 光靠 reasoning_effort 关不掉思考（v0.5.0.2 实测，deepseek-flash）：
    //   reasoning_effort:'none' 时它照样先在 reasoning_content 里盘算，
    //   300~400 上限会被思考烧穿（finish_reason=length、content 为空串）；
    //   同一批样本换成 thinking:{type:'disabled'} 后 10 条全对、输出只剩 20 来个 token。
    // 只有真要「一句话就答」的活才传 noThink —— 别的活想一想是好事，而且这字段
    // 不是家家都认（不认的由 postChat 按报错摘掉重试）。
    const thinkOff = noThink && spec.thinkOff ? spec.thinkOff : null;
    res = await postChat(joinUrl(baseUrl, '/chat/completions'), apiKey, {
      model, messages: messages.map(toApiMessage), temperature, max_tokens: maxTokens, stream: false,
      ...(eff ? { reasoning_effort: eff } : {}),
      ...(thinkOff || {}),
    }, ctl.signal);
  } finally { clearTimeout(t); }
  if (!res.ok) {
    // 同 streamChat：400/422 的 body 已被 postChat 读走，取缓存那份；
    // 这里以前只报状态码，服务端说了什么一概看不到（v1.21.54 修）。
    // v0.5.3.2：附带 status / detail / kind，界面才能翻成人话（清单 §3.1）。
    throw apiErr(res.status, await readErrDetail(res));
  }
  const j = await res.json();
  // v2（活人感）：评审这一趟也要能记用量 —— 它是一次实打实的 700 上限请求，
  // 不记的话「这一轮到底花了多少」永远少一笔。回调出错不该影响正文。
  if (j && j.usage && typeof onUsage === 'function') {
    try { onUsage(j.usage); } catch { /* 记用量失败不影响这次拿到的东西 */ }
  }
  const msg = j.choices?.[0]?.message || {};
  const main = (msg.content || '').trim();
  if (main) return main;
  // 兜底：万一某些模型/参数组合仍然只填了 reasoning_content，
  // 就从里面把 JSON 抠出来，别让整条链路白跑。
  const think = String(msg.reasoning_content || '');
  const m = think.match(/\[[\s\S]*\]|\{[\s\S]*\}/);
  return m ? m[0] : '';
}

/**
 * 查账户余额（GET /user/balance）
 *
 * ⚠️ 这是【DeepSeek 专有】的接口，别家没有。档案里 balance:false 的服务商
 * 直接给一句人话，而不是让用户去猜那个 404 是什么意思（设置页那边也会把
 * 这一行藏起来，这里只是兜底）。
 */
/**
 * 试一下这个 Key / 地址 / 模型能不能用（v0.5.3.2，清单 §3.2 L2）。
 *
 * ⚠️ 只发 1 个 token 的hello，不写提示词、不落聊天记录 —— 点一下最多花掉几厘钱。
 * ⚠️ 失败时要把「是 key 的问题、是余额的问题、是模型名不对、还是根本连不上」
 *    分出来。全都报「请求失败」等于什么都没说，用户只能挨个猜。
 * 返回 { ok, kind, status?, msg, ms }；kind 与 errorkit 的 ERR_KIND 同一套词。
 * @param {{apiKey:string, baseUrl:string, model:string, provider?:string, timeoutMs?:number}} opts
 */
export async function testConnection(opts) {
  const { apiKey, baseUrl, model, provider, timeoutMs = 20000 } = opts || {};
  if (!apiKey) return { ok: false, kind: 'auth', msg: '还没填 Key', ms: 0 };
  if (!model) return { ok: false, kind: 'notfound', msg: '还没选模型', ms: 0 };
  const spec = providerSpec(provider);
  const ctl = new AbortController();
  const timer = setTimeout(() => { try { ctl.abort(); } catch { /* 已结束 */ } }, timeoutMs);
  const t0 = Date.now();
  let res;
  try {
    res = await postChat(joinUrl(baseUrl, '/chat/completions'), apiKey, {
      model,
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 1,
      stream: false,
      ...(spec.thinkOff || {}),
    }, ctl.signal);
  } catch (e) {
    const aborted = !!(e && (e.name === 'AbortError' || ctl.signal.aborted));
    return {
      ok: false,
      kind: aborted ? 'timeout' : 'net',
      msg: aborted ? ('等了 ' + Math.round(timeoutMs / 1000) + ' 秒没回话') : String((e && e.message) || e),
      ms: Date.now() - t0,
    };
  } finally { clearTimeout(timer); }
  const ms = Date.now() - t0;
  if (res.ok) return { ok: true, kind: '', msg: '通了', ms };
  const detail = await readErrDetail(res);
  return { ok: false, kind: kindOfStatus(res.status, detail), status: res.status, msg: detail, ms };
}

export async function fetchBalance(opts) {
  const { apiKey, baseUrl, provider } = opts;
  if (!apiKey) throw new Error('还没填 API Key');
  if (!providerSpec(provider).balance) {
    throw new Error('这个服务商没有余额查询接口（只有 DeepSeek 有）');
  }
  const res = await fetch(joinUrl(baseUrl, '/user/balance'), {
    headers: { 'Authorization': 'Bearer ' + apiKey }
  });
  if (!res.ok) throw new Error('查询失败 ' + res.status);
  const j = await res.json();
  const info = (j.balance_infos || [])[0];
  return {
    available: !!j.is_available,
    currency: info ? info.currency : '',
    total: info ? info.total_balance : '',
    granted: info ? info.granted_balance : '',
    toppedUp: info ? info.topped_up_balance : '',
  };
}

/**
 * 联网搜索。返回 { answer, results:[{title,url,content}] }
 *
 * ⚠️ 只在用户明确打了「/搜」时才调用 —— 默认纯本地，不自动联网。
 * key 由用户自己填，不预置在包里（写死的 key 反编译就能拿走）。
 *
 * v0.4.0：从"只能 Tavily"扩成多后端。理由不是"竞品有"，
 * 而是原来那条路【必须让用户再注册一家、再填一个 key】——
 * 而"陪伴向"的用户里，最容易被这一步劝退的恰恰是不折腾的人。
 * 所以：能复用主 API key 的（智谱）就不用再填。
 */
export const SEARCH_BACKENDS = {
  tavily: {
    label: 'Tavily',
    hint: 'tvly-...',
    where: 'tavily.com',
    how: '注册免费、每月 1000 次，不用绑卡。key 是 <code>tvly-</code> 开头。',
    reuse: false,
  },
  zhipu: {
    label: '智谱 GLM（可用同一个 key）',
    hint: '智谱的 key',
    where: 'open.bigmodel.cn',
    how: '如果你聊天用的就是智谱，这里<b>留空也行</b> —— 直接复用上面那个 key。',
    reuse: true,
  },
  exa: {
    label: 'Exa',
    hint: 'exa-...',
    where: 'exa.ai',
    how: '按次计费，注册后在 Dashboard 拿 key。',
    reuse: false,
  },
  brave: {
    label: 'Brave Search',
    hint: 'Brave 的 subscription token',
    where: 'brave.com/search/api',
    how: '有免费档（每月若干次），不用绑卡就能开。',
    reuse: false,
  },
};

function searchTimeout(signal, ms) {
  const ctl = new AbortController();
  const onOuter = () => ctl.abort();
  if (signal) {
    if (signal.aborted) ctl.abort();
    else signal.addEventListener('abort', onOuter, { once: true });
  }
  // 搜索本身要快。15 秒不回来就放弃，别把整轮对话拖死。
  const timer = setTimeout(() => ctl.abort(new Error('搜索超时（15 秒）')), ms || 15000);
  return { ctl, done: () => clearTimeout(timer) };
}

/** 后端各自的报错说清楚一点，别让他以为是网络不好 */
function searchHttpError(provider, res, detail) {
  if (res.status === 401 || res.status === 403) {
    return new Error((SEARCH_BACKENDS[provider] || {}).label + ' 的 key 无效（' + res.status + '）');
  }
  if (res.status === 402 || res.status === 429 || res.status === 432) {
    return new Error((SEARCH_BACKENDS[provider] || {}).label + ' 的额度用完了（' + res.status + '）');
  }
  return new Error('搜索失败 ' + res.status + (detail ? ': ' + detail : ''));
}

async function searchTavily({ apiKey, query, max, signal }) {
  const { ctl, done } = searchTimeout(signal);
  let res;
  try {
    res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        search_depth: 'basic',      // basic = 1 credit；advanced = 2
        max_results: max,
        include_answer: true,       // 让它先给一段总结，省得我们再拼
      }),
      signal: ctl.signal
    });
  } finally { done(); }
  if (!res.ok) {
    let detail = ''; try { detail = (await res.text()).slice(0, 200); } catch { /* 拿不到就算了 */ }
    throw searchHttpError('tavily', res, detail);
  }
  const j = await res.json();
  return {
    answer: String(j.answer || '').trim(),
    results: (j.results || []).slice(0, max).map(r => ({
      title: String(r.title || '').trim(), url: r.url || '', content: String(r.content || '').trim(),
    })),
  };
}

async function searchExa({ apiKey, query, max, signal }) {
  const { ctl, done } = searchTimeout(signal);
  let res;
  try {
    res = await fetch('https://api.exa.ai/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ query, numResults: max, contents: { text: { maxCharacters: 1200 } } }),
      signal: ctl.signal,
    });
  } finally { done(); }
  if (!res.ok) {
    let detail = ''; try { detail = (await res.text()).slice(0, 200); } catch { /* 同上 */ }
    throw searchHttpError('exa', res, detail);
  }
  const j = await res.json();
  return {
    // Exa 不返回"摘要"，交给模型自己看片段
    answer: '',
    results: (j.results || []).slice(0, max).map(r => ({
      title: String(r.title || '').trim(),
      url: r.url || '',
      content: String((r.text || r.summary || '')).trim(),
    })),
  };
}

async function searchBrave({ apiKey, query, max, signal }) {
  const { ctl, done } = searchTimeout(signal);
  const url = 'https://api.search.brave.com/res/v1/web/search?count=' + Math.max(1, Math.min(20, max))
    + '&q=' + encodeURIComponent(query);
  let res;
  try {
    res = await fetch(url, {
      headers: { 'Accept': 'application/json', 'X-Subscription-Token': apiKey },
      signal: ctl.signal,
    });
  } finally { done(); }
  if (!res.ok) {
    let detail = ''; try { detail = (await res.text()).slice(0, 200); } catch { /* 同上 */ }
    throw searchHttpError('brave', res, detail);
  }
  const j = await res.json();
  const list = ((j.web && j.web.results) || []).slice(0, max);
  return {
    answer: String((j.summarizer && j.summarizer.text) || '').trim(),
    results: list.map(r => ({
      title: String(r.title || '').trim(),
      url: r.url || '',
      content: String(r.description || '').trim(),
    })),
  };
}

async function searchZhipu({ apiKey, query, max, signal }) {
  const { ctl, done } = searchTimeout(signal);
  let res;
  try {
    res = await fetch('https://open.bigmodel.cn/api/paas/v4/web_search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      body: JSON.stringify({
        search_engine: 'search_std',
        search_query: query,
        count: Math.max(1, Math.min(50, max)),   // 官方参数名就是 count（默认 10）
      }),
      signal: ctl.signal,
    });
  } finally { done(); }
  if (!res.ok) {
    let detail = ''; try { detail = (await res.text()).slice(0, 200); } catch { /* 同上 */ }
    throw searchHttpError('zhipu', res, detail);
  }
  const j = await res.json();
  const list = (j.search_result || []).slice(0, max);
  return {
    answer: '',
    results: list.map(r => ({
      title: String(r.title || '').trim(),
      url: r.link || r.url || '',
      content: String(r.content || '').trim(),
    })),
  };
}

/**
 * 联网搜索（多后端，v0.4.0）。
 *
 * @param {object} o
 * @param {string} [o.provider] tavily | zhipu | exa | brave，不认的一律按 tavily
 * @param {string} o.apiKey
 * @param {string} o.query
 * @param {number} [o.max]
 * @param {AbortSignal} [o.signal]
 */
export async function webSearch(opts) {
  const { provider, apiKey, query, max = 5, signal } = opts || {};
  if (!apiKey) throw new Error('还没填搜索 API Key');
  const p = (provider && SEARCH_BACKENDS[provider]) ? provider : 'tavily';
  if (p === 'exa') return searchExa({ apiKey, query, max, signal });
  if (p === 'brave') return searchBrave({ apiKey, query, max, signal });
  if (p === 'zhipu') return searchZhipu({ apiKey, query, max, signal });
  return searchTavily({ apiKey, query, max, signal });
}

/** 把搜索结果拼成一段给模型看的资料。只在这一轮注入，不写进历史。 */
export function formatSearch(re, query) {
  const lines = ['［以下是刚刚从网上查到的资料，请据此回答，不要再说你查不到。］', '检索词：' + query, ''];
  if (re.answer) lines.push('摘要：' + re.answer, '');
  re.results.forEach((r, i) => {
    lines.push('[' + (i + 1) + '] ' + r.title);
    if (r.url) lines.push('来源：' + r.url);
    if (r.content) lines.push(r.content);
    lines.push('');
  });
  lines.push('［资料结束。引用时说清楚哪条来自哪个来源；资料里没有的就直说没查到。］');
  return lines.join('\n');
}

/** 把 File/Blob 转 dataURL */
export function fileToDataUrl(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(file);
  });
}

/** 压缩图片，避免 base64 过大 */
export function compressImage(dataUrl, maxSide = 1024, quality = 0.8) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      let { width: w, height: h } = img;
      if (w > maxSide || h > maxSide) {
        const r = Math.min(maxSide / w, maxSide / h);
        w = Math.round(w * r); h = Math.round(h * r);
      }
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(c.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}
