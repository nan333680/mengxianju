// 小说模式的「底色」装配（v0.5.2.5）
//
// 为什么单独一个文件：
//   0.5.2.4 是在 app.js 里「先拼字符串、拼完 slice(0, 2400)」。真实长卡上
//   「她是谁」+「世界」两块就已经 3500 字，最后那段记忆永远被切掉，
//   切点还可能落在半句中间（persona.slice(0,900) 是按字符切的）。
//   这一层把它改成【块级装入】：每块有独立上限、各自按句子截；
//   总长超了就整条丢块，绝不从中间截断一句话。
//
// 顺序就是重要性顺序（评审 0.5.2.5 的 P0-2）：
//   她是谁 → 她说话的样子 → 你怎么称呼他/怎么看他 → 关于对方 → 他住的地方
//   → 这个世界的底色 → 你们之间已经这样了
//
// 丢弃顺序是世界书在前、记忆在后：世界书模型自己能编一半，
// 而「她以为他是谁」「两人之间已经到哪一步」是编不出来的 ——
// 这也是评审那句「先砍世界书，不要砍声音和关系」。
//
// 纯函数，不碰 IndexedDB / DOM，能单独测（见 e2e/e2e-scenectx.mjs）。

import { SCENE_CONTEXT_MAX } from './scene.js';

/**
 * 每块的独立上限（字）。
 *
 * ⚠️ 这七块加起来（8700）**故意**比 SCENE_CONTEXT_MAX(8000) 多：
 *    真实长卡上本来就装不下 —— 与其假装装得下，不如让"装不下就整条丢"
 *    成为真的会发生的机制（第一版把两块调小、和刚好小于上限，
 *    那段丢弃代码永远走不到，等于写了一行自我安慰）。
 *
 * 分配的依据（按真实备份里 19 个角色量出来的量级，不是拍脑袋）：
 *   self 5800  —— 人设 5000 + 卡里的性格/场景/说明/记着 各 100 + 外貌 100
 *                （人设是主体，但卡字段整类被挤掉等于用户白填）
 *   voice 500  —— 卡里的对话范例，她"怎么说话"唯一的样本
 *   user 450   —— 你怎么称呼他，逐字排出来的 bullets
 *   profile 300 / env 200 —— 他那个人、他待的地方
 *   world 900 / mem 550 —— 可以整条丢的那两块
 */
export const SCENE_CTX_BLOCKS = [
  { key: 'self', title: '她是谁', max: 5800, essential: true },
  { key: 'voice', title: '她说话的样子', max: 500, essential: true },
  { key: 'user', title: '你怎么称呼他、怎么看他', max: 450, essential: true },
  { key: 'profile', title: '关于对方', max: 300, essential: true },
  { key: 'env', title: '他住的地方', max: 200, essential: true },
  // 下面两块可以整条丢：世界书模型能编一半，记忆是"能编但会编错"，
  // 都比不上声音和关系要紧。
  { key: 'world', title: '这个世界的底色', max: 900, essential: false },
  { key: 'mem', title: '你们之间已经这样了', max: 550, essential: false }
];

/** 句子结束符：中文句号/叹号/问号/省略号，以及换行（卡片里的分段也是句界） */
const SENT_END = /[。！？!?…\n]/;

/**
 * 按句子边界截到 max 字以内。
 *
 * 为什么不直接 slice：真实长卡上「她不会主动说爱，但会一直等你」在 900 字处
 * 被切一下就变成「她不会主动说爱，但会」—— 语义正好反了。宁可短一点、
 * 也要停在一个句子说完的地方。
 *
 * 找不到合适的句界（比如整段没有一个标点）时退回硬截：
 * 这时候截断总比整块丢掉有用。
 */
export function cutAtSentence(s, max) {
  const t = String(s == null ? '' : s).trim();
  const lim = Math.max(0, Math.floor(Number(max) || 0));
  if (!lim || t.length <= lim) return t;
  const head = t.slice(0, lim);
  let cut = -1;
  for (let i = head.length - 1; i >= 0; i--) {
    if (SENT_END.test(head[i])) { cut = i + 1; break; }
  }
  // 句界落在前 60% 之后才认；太靠前说明这一句特别长，硬截更划算
  if (cut > lim * 0.6) return head.slice(0, cut).trim();
  return head.trim();
}

/**
 * 卡里的「对话范例」清洗（v0.5.2.5）。
 *
 * 为什么小说侧要单独清洗，聊天侧却是原样塞进提示词：
 *   聊天那边 mesExample 只是众多设定的一段，模型看得见上下文里的真实对话来校准；
 *   小说这边它被当成"她的声音"的唯一样本，一旦带着模板残留就会出现
 *   「{{char}} 抬起头」这种字面大括号。
 *
 * 已经在 charcard.js:130 导入时展开过一次宏，这里是第二道：
 *   老数据、手改过的卡、从备份恢复的卡都可能还带着。
 *
 * ⚠️ 说话人标签我【保留】了（评审说"清洗说话人标签"，我不同意）：
 *    范例里通常是「她：…… 你：……」交替，去掉标签就分不清哪句是她说的，
 *    而这一段存在的唯一理由就是让她照着自己的句子说话。
 *    改成在提示词里说明「哪几句是她的、别照抄内容」。
 */
export function cleanExample(raw, max = 600) {
  let t = String(raw == null ? '' : raw)
    .replace(/\{\{\s*char\s*\}\}/gi, '她')
    .replace(/\{\{\s*user\s*\}\}/gi, '你')
    .replace(/\{\{[^}]{1,40}\}\}/g, '')
    .replace(/<\s*START\s*>/gi, '\n\n')
    .replace(/\r/g, '');
  t = t.replace(/\n{3,}/g, '\n\n').trim();
  return cutAtSentence(t, max);
}

/**
 * 把七个块装配成一段提示词。
 *
 * @param {object} parts  { self, voice, user, profile, env, world, mem } 各自的正文（不含标题）
 * @param {number} [cap]  总长上限，默认 SCENE_CONTEXT_MAX
 * @returns {{text: string, dropped: Array<{key: string, why: string}>, chars: number}}
 */
export function assembleSceneContext(parts = {}, cap = SCENE_CONTEXT_MAX) {
  const limit = Math.max(0, Math.floor(Number(cap) || SCENE_CONTEXT_MAX));
  const chunks = [];
  const dropped = [];

  for (const b of SCENE_CTX_BLOCKS) {
    const raw = String((parts && parts[b.key]) || '').trim();
    if (!raw) continue;
    const body = cutAtSentence(raw, b.max);
    if (!body) continue;
    chunks.push({ key: b.key, title: b.title, body, essential: b.essential === true });
  }

  const size = () => chunks.reduce((n, c) => n + c.title.length + c.body.length + 3, 0);

  // ① 超了就整条丢非要紧的。从前往后找 —— world 排在 mem 前面，
  //    所以世界书先被丢，然后才是记忆（评审的取舍，我也认同）。
  while (chunks.length && size() > limit) {
    const i = chunks.findIndex(c => !c.essential);
    if (i < 0) break;
    dropped.push({ key: chunks[i].key, why: '装不下，整条丢掉了' });
    chunks.splice(i, 1);
  }

  // ② 还有超的只能缩 self —— 但绝不动 voice / user：那两块是「同一个人」的根。
  let guard = 0;
  while (chunks.length && size() > limit && guard++ < 8) {
    const self = chunks.find(c => c.key === 'self');
    if (!self) break;
    const over = size() - limit;
    const keep = Math.max(120, self.body.length - over - 8);
    if (keep >= self.body.length) break;
    self.body = cutAtSentence(self.body, keep);
    dropped.push({ key: 'self', why: '总长超上限，她是谁这一块被缩短了' });
    if (self.body.length <= 120) break;
  }

  const text = chunks.map(c => '# ' + c.title + '\n' + c.body).join('\n\n');
  return { text, dropped, chars: text.length };
}
