// www/js/posecard.js —— 状态卡片（0.5.8.10）
//
// 治的是「细节丢」：她把眼镜摘下放桌上，五六轮之后只剩「摘下」；
// 咲夜把换洗的衣物放在门口，十五轮之后她还在为「没有干净衣服」发愁。
//
// 为什么必须是【单独一条通道】，不能挂在判断层里：
//   ① 判断层是「角色怎么想」的一部分（liveV2），关掉它整条链就不存在 ——
//      而实测用户就是关着的（全库 1253 条注入快照里 pose 非空 0 条）。
//   ② 就算开着，now 也只有 15~30 字（normalizeDirector 还压到 40），
//      和 reading / inner / mood / stance / withhold / secret / beats 挤在
//      同一个 1100 token 的 JSON 里 —— 每轮都有别的字段跟它抢。
//      这不是「扩容」能根治的，是结构性挤压。
//   ③ 「她怎么想」和「东西在哪」本来就是两件事，一个请求干两件，哪件都会让位。
//
// 所以：一个 200 token 的小请求，只回一行，只记画面，不写情绪、不写打算。
// 和正文【并行发】（正文本身 5~15 秒，这一趟 2~4 秒，藏在里面）。
// 失败返回 ''，调用方照旧这一轮不注入 —— 绝不拿上一轮的旧值顶，
// 过时的位置进正文就是 0.5.8.4 治的那个病（她明明站着，提示词说她躺着）。
//
// ⚠️ 和判断层的 now 不打架：唯一写 'pose:<charId>' 这个 kv 的是这里。
//    director 的 now 只在【这一趟没记成】时兜底注入，不落库 ——
//    两边都写就会互相覆盖，而且每覆盖一次就缩一次（40 字 vs 五槽）。

import { onceChat } from './api.js';

/** 输出上限。五槽 × 20 字 ≈ 100 字，260 token 有余量。
 *
 * ⚠️ 必须同时 noThink：思考从 max_tokens 里扣，开着思考会被思维链烧穿、
 *    content 返回空串（api.js onceChat 头部那段实测记着）。这一趟只是抄写，不需要推理。 */
const POSE_MAX_TOKENS = 260;

/** 喂进去的历史条数。和判断层/独白取同一个数：再多就是在重读整段聊天。 */
const POSE_N = 8;

/** 单槽字数上限。超过就砍，但一个槽砍到底也就 24 字 —— 这是「整槽丢」的前提。 */
const SLOT_MAX = 24;

/** 槽内超长时按标点收尾，不切在字中间。
 *
 * 「门口台阶上搁着咲夜送来的两叠换洗衣裳，一叠她的，一叠是他的」砍到 24 字是
 * 「…一叠她的，」—— 半句、还挂着逗号。收到最后一个逗号前就是完整的
 * 「门口台阶上搁着咲夜送来的两叠换洗衣裳」。
 * ⚠️ 前面不足 6 字时不收（会把一整个槽砍成一个词），宁可硬切。 */
function cutSlot(v, n) {
  const s = String(v == null ? '' : v).trim();
  if (s.length <= n) return s;
  const head = s.slice(0, n);
  const m = head.match(/^(.*)[，、；。,;]/);
  if (m && m[1].length >= 6) return m[1];
  return head.replace(/[，、；。,;\s]+$/, '');
}

/** 一行总字数上限。超过时【整槽丢掉】，不砍半句（半句比没有更糟）。 */
export const POSE_MAX_LEN = 100;

/** 分隔符。全角竖线：半角和 markdown 表格字符容易被模型混用，统一成一个。
 *  归一化时两种都认（见 parseSlots）。 */
export const POSE_SEP = '｜';

/** 五个槽的固定标签。顺序就是注入顺序 —— 变了这一行就读不通。 */
export const POSE_LABEL = ['在哪', '姿势', '手里', '身上', '身边'];

/** 模型可能写的别名 → 槽序号。它不照着标签写的时候靠这张表归位。 */
const ALIAS = {
  在哪: 0, 位置: 0, 地点: 0, 所在: 0, 场景: 0, 哪儿: 0, 何处: 0,
  姿势: 1, 姿态: 1, 动作: 1, 身体: 1, 样子: 1, 身形: 1,
  手里: 2, 手上: 2, 手中: 2, 手持: 2, 拿着: 2, 握着: 2, 手上拿的: 2,
  身上: 3, 穿着: 3, 衣着: 3, 衣物: 3, 穿的: 3, 衣服: 3, 上身: 3,
  身边: 4, 旁边: 4, 周围: 4, 身旁: 4, 搁着: 4, 放着: 4, 物件: 4, 东西: 4, 周围的东西: 4
};

const ASK = [
  '# 只记一样东西：这一秒的画面',
  '',
  '看完下面的聊天记录，只回一行 —— 记下【她这一刻】是什么样子。',
  '',
  '一个槽一个槽地填，顺序固定，用「' + POSE_SEP + '」隔开：',
  '在哪：她在什么地方｜姿势：站着坐着还是躺着，身体怎么摆｜手里：手里拿着什么，没有就写「空着」｜身上：穿的是什么｜身边：她旁边搁着什么',
  '',
  '规则：',
  '- 每槽 4~15 字，一行总共四五十字。想不出就写「空着」，不许编。',
  '- 「身边」这一项最容易漏，宁可短也要写：他给的、别人送来的、她自己脱下来搁的 —— 写清是谁的、搁在哪儿。',
  '- 只写画面：不写情绪、不写打算、不写台词、不评价。',
  '- 上一轮记下的那一行在最后。一个槽一个槽地看：',
  '  · 聊天记录里【明确写了】这一槽变了（穿上了、拿走了、用完了、换地方了），才改；',
  '  · 聊天记录里【没提】这一槽，就照抄上一轮那几个字，一个字都别改；',
  '  · 上一轮有、这一轮没提到 —— 留着，不要删。',
  '- 聊天记录里没写她在哪，就照抄上一轮；上一轮也没有，写你从这一轮的话里读得出来的位置；读不出就写「空着」。',
  '- 不要复述聊天记录，不要前言后语、不要编号、不要 markdown，只回那一行。'
].join('\n');

/**
 * 拼出这一趟的指令（放进【最后一条 system】）。
 *
 * ⚠️ 为什么是 system 而不是 user（0.5.8.10 修）：
 *   第一版把它拼成一条 user 消息塞在最后，等于把「只回一行、五个槽」
 *   当成对话里的下一句 —— 模型有可能顺着接话，或者被上面那些戏带着写起来。
 *   system 是「给它的规矩」，user 是「对它说的话」，这一趟要的是前者。
 *   （坏结果本身不会污染正文：normalizePose 解析不出来会返回空串，那一轮就不注入。
 *     但那时界面上只会显示「这一轮没记成」，不知道为什么 —— 所以从源头堵。）
 *
 * ⚠️ 他这一轮的话仍然走【独立的 user 消息】，见 runPose ——
 *    和判断层同一个结构：历史 → user(本轮) → system(指令)。
 *
 * @param {object} o
 * @param {string} [o.prev] 上一轮记下的那一行（继承源，没有就空）
 */
export function poseAsk(o) {
  const { prev } = o || {};
  const p = String(prev == null ? '' : prev).trim();
  return '（上一轮记下的：\n' + (p || '（没有，这是第一次记）') + '\n）\n\n' + ASK;
}

/** 把一段文字洗干净：去围栏、去行首标记、压空白。 */
function clean(s) {
  return String(s == null ? '' : s)
    .replace(/```[a-z]*/gi, ' ')
    .replace(/\r\n?/g, '\n')
    .trim();
}

/**
 * 把模型写的那一行收成【五槽格式】。
 *
 * 步骤：按「｜」/「|」切段 → 每段剥掉标签、按别名归位 → 按标准槽序重排
 *      → 逐槽累加，超长时【整槽丢掉】，绝不砍半句。
 *
 * ⚠️ 少于两槽一律当失败（返回 ''）。模型不照着格式写的时候，
 *    塞一行乱七八糟的东西进正文提示词，比这一轮没有更糟。
 *
 * @param {string} text
 * @param {number} [maxLen] 一行字数上限
 * @returns {string} 空串 = 没记成
 */
export function normalizePose(text, maxLen = POSE_MAX_LEN) {
  let s = clean(text);
  if (!s) return '';
  // 围栏里取第一块（模型偶尔包一层）
  const fence = s.match(/```(?:[a-z]*)\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  // 逐行洗：丢掉「好的 / 我记一下 / 以下是要记的」这类开场白，
  // 但【保留】任何带分隔符或冒号的行（那里有内容）。
  const keep = [];
  for (const line of s.split('\n')) {
    let t = line.trim();
    if (!t) continue;
    t = t.replace(/^\s*(?:\d+\s*[.、)）]|[-*·•]\s+)/, '').replace(/^[#>]+\s*/, '').trim();
    if (!t) continue;
    const hasBody = t.includes('：') || t.includes(':') || t.includes(POSE_SEP) || t.includes('|');
    if (!hasBody) continue;
    keep.push(t);
  }
  if (!keep.length) return '';
  s = keep.join(POSE_SEP);

  // 切段。半角竖线、全角竖线、还有模型偶尔用的「、」都不算分隔 —— 只认竖线，
  // 因为「、」在中文句子里太常见（「床沿、箱子」是一个槽里的两个东西）。
  const parts = s.split(/[｜|]/).map(x => x.trim()).filter(Boolean);
  if (!parts.length) return '';

  const slots = new Array(POSE_LABEL.length).fill('');
  let next = 0;    // 没有标签的段按顺序落座
  for (const raw of parts) {
    let t = raw;
    let idx = -1;
    const m = t.match(/^([^：:]{1,6})[：:]\s*/);
    if (m) {
      const key = m[1].replace(/\s+/g, '');
      if (Object.prototype.hasOwnProperty.call(ALIAS, key)) { idx = ALIAS[key]; t = t.slice(m[0].length).trim(); }
    }
    if (idx < 0) {
      // 没认出标签：先把「好的，我记一下：床沿」这种前后粘连的引子砍掉，再按顺序落座。
      // 只有引子没有内容的段（「好的，我记一下：」）直接丢掉 —— 不然它会占掉「在哪」那一槽。
      const tail = t.replace(/^[^：:]{1,12}[：:]\s*/, '').trim();
      if (!tail) continue;
      t = tail;
      idx = next;
    }
    if (idx < 0 || idx >= POSE_LABEL.length) continue;
    if (slots[idx]) continue;                       // 同一槽写了两次，只认先来的
    const v = t.replace(/^[「『"']+|[」』"']+$/g, '').replace(/\s+/g, ' ').trim();
    if (!v) continue;
    slots[idx] = cutSlot(v, SLOT_MAX);
    if (next <= idx) next = idx + 1;
  }

  // 至少两槽才算记成
  const filled = slots.filter(Boolean).length;
  if (filled < 2) return '';

  const out = [];
  let len = 0;
  for (let i = 0; i < POSE_LABEL.length; i++) {
    const v = slots[i];
    if (!v) continue;
    const piece = POSE_LABEL[i] + '：' + v;
    const add = (out.length ? 1 : 0) + piece.length;
    // 放不下就【跳过这一槽】继续试后面的 —— 跳过比 break 好：
    // 最后一个槽是「身边」，正是最容易被忘、最该保住的那一项。
    if (out.length && len + add > maxLen) continue;
    out.push(piece);
    len += add;
  }
  return out.join(POSE_SEP);
}

/**
 * 跑一次状态卡片。
 *
 * @param {object} o
 * @param {Array}  o.recent   最近的历史消息 [{role, content}]
 * @param {string} [o.userText] 他这一轮刚说的话
 * @param {string} [o.prev]   上一轮记下的那一行（'pose:<charId>' 里那份）
 * @param {{apiKey?: string, baseUrl?: string, provider?: string, model?: string}} o.api
 * @param {AbortSignal} [o.signal]
 * @returns {Promise<string>} 五槽一行；失败/被中断一律 ''
 */
export async function runPose(o) {
  const { recent, userText, prev, api, signal } = o || {};
  if (!api || !api.apiKey) return '';
  if (signal && signal.aborted) return '';

  const msgs = [];
  for (const m of (recent || []).slice(-POSE_N)) {
    const c = String((m && m.content) || '').trim();
    if (!c) continue;
    msgs.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: c });
  }
  // 他这一轮的话走独立的 user 消息；指令走 system（理由见 poseAsk 的注释）。
  const ut = String(userText == null ? '' : userText).trim();
  if (ut) msgs.push({ role: 'user', content: ut });
  msgs.push({ role: 'system', content: poseAsk({ prev }) });

  let out = '';
  try {
    out = await onceChat({
      apiKey: api.apiKey,
      baseUrl: api.baseUrl,
      provider: api.provider,
      model: api.model,
      messages: msgs,
      // 低温：这一趟是【抄写】，不是发挥。高了它就开始替你写戏了。
      temperature: 0.2,
      maxTokens: POSE_MAX_TOKENS,
      // ⚠️ 必须 noThink，不能只写 reasoningEffort:'none'（api.js 那段实测：关不掉思考）
      noThink: true,
      // 它和正文并行跑，所以上限要短：正文本身 5~15 秒，这一趟 2~4 秒藏在里面。
      // 6 秒还没回来就放弃 —— 失败只是这一轮没记上，绝不能拖慢正文。
      timeoutMs: 6000,
      signal: signal || null
    });
  } catch (err) {
    console.warn('[posecard] 这一轮没记成：' + ((err && err.message) || err));
    return '';
  }
  return normalizePose(out);
}
