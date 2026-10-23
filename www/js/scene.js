// 小说层：一场戏 = 场景卡 + 1~2 拍 + 一个停点。
//
// 这一层只做三件事：把场景卡规范化、拼提示词、检查生成出来的正文。
// 故意【不 import db.js / app.js】—— 纯函数才能被 e2e 直接 import 进来测，
// 也才能在没有浏览器的环境里跑单测（e2e-scene 有一半是这么测的）。
//
// 硬约束（来自 0.5.2 规格）：
//   · 小说正文不进 messages 表，不走群聊的【名字】协议，不用聊天气泡模型。
//   · 聊天是素材，不是小说数据：派生之后两边互不影响（快照隔离）。
//   · 第一版照抄规格 §5 的字段，一个不多加 —— 加字段之前先问「它服务哪一句裁决」。

/** 场景卡结构版本。以后改字段就 +1，normalize 里按版本分别认。 */
export const SCENE_VER = 2;

/**
 * 场景上下文的字数上限（v0.5.2.5）。
 *
 * 这一块是「开戏那一刻世界长什么样」的快照：她是谁、她怎么说话、你怎么称呼他、
 * 你们之间发生过什么、这个世界的底色。它进的是【稳定前缀之外、每拍都在】的位置，
 * 所以必须封顶。
 *
 * 这个数不是拍的：v0.5.2.5 拿一份真实的 19 个角色的备份量过 ——
 *   最长 12478 / 其次 8892 / 6887 / 5583 / 5000 / 4664 / 4348 / 3741，其余更短。
 * 第一版按评审建议写 3200，等于「最大那张卡的人设只进前 5%」，写出来必然不像她。
 * 而聊天侧一直把全量 persona 放在稳定前缀里（用户已经长期在付这笔钱），
 * 所以小说侧给 5000 字人设并不越界：19 个角色里 14 个能整份进去。
 *
 * v0.5.3 抬到 11000：8000 时七块上限加起来（8700）本来就超过总量，
 * 满卡必丢「这个世界的底色」—— 用户把设定写进世界书，小说里一个字都进不去。
 * 11000 字 ≈ 7100 token，仍是聊天侧稳定前缀的一半左右；多花的那点钱换
 * 「设定不会因为预算表打架而静默消失」。真装不下时的丢弃会写进 scene.ctxDropped，
 * 在结束页明说丢了哪几块，不再只进 console。
 * 具体怎么分块、装不下丢谁，见 www/js/scenectx.js 的块级预算。
 */
export const SCENE_CONTEXT_MAX = 11000;

/**
 * 四档长度：字数 = 上限，不是任务（§3）。
 *
 * v0.5.3.1 补 long / chapter 两档。原来只有 300–600 和 600–1200，「从聊天写小说」
 * 这件事在几千字的需求上根本没法用 —— 用户选了现成的一大段对话，给回来的
 * 是三百字片段，看着像模型没读前情，其实是档位上限就写到那里。
 *
 * beats 是【分批发写的批数】：长档不能一次让模型吐 8000 字（会被 token 上限截断，
 * 而且越往后越潦草），所以拆成几拍写、每拍一次请求、中间跑场记接力。
 * 每拍的字数由 beatChars() 从总长除出来，不要在这里写死。
 */
export const SCENE_LENGTHS = {
  short: { min: 300, max: 600, beats: 1, label: '短' },
  medium: { min: 600, max: 1200, beats: 2, label: '中' },
  long: { min: 2000, max: 4000, beats: 3, label: '长' },
  chapter: { min: 4000, max: 8000, beats: 5, label: '章' }
};

/** 在场方式（§10）。每场开时选一次，写进场景卡。 */
export const USER_MODES = ['actor', 'director', 'audience'];
export const USER_MODE_NAME = {
  actor: '演员',
  director: '导演',
  audience: '观众'
};

export const SCENE_STATUS = ['draft', 'generating', 'done', 'trashed'];

export const GUARDRAILS_MAX = 5;
export const TEMP_CAST_MAX = 2;
/** 回收站保留天数（§12：整篇进回收站 30 天） */
export const TRASH_DAYS = 30;

const S = (v, n = 400) => String(v == null ? '' : v).replace(/\r/g, '').trim().slice(0, n);
const LINES = (arr, n, cap) => (Array.isArray(arr) ? arr : [])
  .map(x => S(x, n)).filter(Boolean).slice(0, cap);

export function newSceneId() {
  return 'sc' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** 一张空卡。charId 给了就带上，其余全空 —— 空白开戏从这张开始填。 */
export function emptyScene(charId = '') {
  return {
    id: newSceneId(),
    v: SCENE_VER,
    charId,
    title: '',
    source: { kind: 'blank', chatCharId: '', msgIds: [], excerpt: '' },
    cast: [],
    setting: { place: '', time: '', weather: '' },
    pov: 'her-limited',
    userMode: 'actor',
    length: 'short',
    targetChars: [300, 600],
    beats: [emptyBeat()],
    blocks: [],
    log: { events: [], cast: [], change: '', openThreads: [], keyLines: [], newSettings: [] },
    status: 'draft',
    canon: false,
    context: '',
    // v0.5.3：开戏装配时哪几块装不下被整条丢了（'world' / 'mem' / 'self'）。
    // 存进卡里而不是只打 console —— 结束页要明说"这次丢了什么"，不能让用户猜。
    ctxDropped: [],
    quality: 'ok',
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
}

/** 一份拍的空白。短场只要一拍，中场最多两拍。 */
export function emptyBeat() {
  return { start: '', change: '', stop: '', guardrails: [] };
}

/** 这一场最多几拍：短场 1，中场 2，长场 3，整章 5（v0.5.3.1） */
export function beatCountFor(length) {
  const L = SCENE_LENGTHS[length] || SCENE_LENGTHS.short;
  return L.beats;
}

/**
 * 一拍该写多少字：总长按拍数除。
 *
 * 多拍是【分批写】的 —— 每一拍一次请求，只带着前面几拍的尾巴和场记。
 * 所以提示词和质检都得以「这一拍」的字数为准，拿整场的 4000–8000 去卡一拍，
 * 每一拍都会被判不合格然后白重试一次。
 */
export function beatChars(length) {
  const L = SCENE_LENGTHS[length] || SCENE_LENGTHS.short;
  const b = Math.max(1, L.beats);
  return { min: Math.round(L.min / b), max: Math.round(L.max / b) };
}

/**
 * 拍收进区间：多了截掉（不静默留着），少了补空拍 ——
 * 「一场 = 一张场景卡 + 1~2 拍」是定义，不是可选项。
 */
export function clampBeats(beats, length) {
  const max = beatCountFor(length);
  const out = (Array.isArray(beats) ? beats : [])
    .map(b => ({
      start: S(b && b.start, 200),
      change: S(b && b.change, 200),
      stop: S(b && b.stop, 200),
      guardrails: LINES(b && b.guardrails, 80, GUARDRAILS_MAX)
    }))
    .slice(0, max);
  while (out.length < 1) out.push(emptyBeat());
  return out;
}

/**
 * 把任何来源（库里读出来的、导入进来的、向导拼出来的）的卡修成合法形状。
 * 原则：认不出的字段丢掉，缺的补默认，越界的夹回区间 —— 宁可丢一点，不可崩。
 */
export function normalizeScene(raw) {
  const a = (raw && typeof raw === 'object') ? raw : {};
  const out = emptyScene(S(a.charId, 80) || '');
  out.id = S(a.id, 80) || out.id;
  out.v = SCENE_VER;
  out.title = S(a.title, 120);
  const src = (a.source && typeof a.source === 'object') ? a.source : {};
  out.source = {
    kind: (src.kind === 'chat' ? 'chat' : 'blank'),
    chatCharId: S(src.chatCharId, 80),
    msgIds: LINES(src.msgIds, 80, 400),
    // 「从聊天成章」派生时把前情【快照】进来存着（规格 §2「派生但快照隔离」）：
    // 之后聊天被改了、分支被切了，这场戏读到的还是当初那段。
    // v0.5.3.1：原来截 2000 字。他选了一段长对话让它改写，后半段在落库这一刻就被砍了 ——
    // 截断点在 prompt 之前，看上去像模型没读到。放到 8000（app.js 的 scChatSnapshot 同一条线）。
    excerpt: S(src.excerpt, 8000)
  };
  // 导入冲突时保留原 id（§12），不是内部字段，照实存着。
  out.sourceSceneId = S(a.sourceSceneId, 80);
  const set = (a.setting && typeof a.setting === 'object') ? a.setting : {};
  out.setting = { place: S(set.place, 80), time: S(set.time, 80), weather: S(set.weather, 80) };
  out.userMode = USER_MODES.includes(a.userMode) ? a.userMode : 'actor';
  out.length = SCENE_LENGTHS[a.length] ? a.length : 'short';
  // targetChars 【不认外部值】：它是长度的函数，存进库里只是为了少算一次。
  const L = SCENE_LENGTHS[out.length];
  out.targetChars = [L.min, L.max];
  out.pov = 'her-limited';           // 第一版固定，不开放切换（§5）
  out.cast = normalizeCast(a.cast);
  out.beats = clampBeats(a.beats, out.length);
  out.blocks = normalizeBlocks(a.blocks);
  out.log = normalizeLog(a.log);
  // 演到第几拍了。这个字段不在 §5 的字段表里，是 0.5.2 实现时加的实现状态：
  // 少掉它，从库里读回来的卡会从第 1 拍重写（writeScene 的 from 就取它）。
  {
    const cb = Math.round(Number(a.currentBeat) || 0);
    out.currentBeat = Math.max(0, Math.min(out.beats.length - 1, cb));
  }
  // 上次读到哪（0–1 的滚动比例）。规格 §11「记住上次读到哪」—— 不存这个，回来就永远在最顶上。
  {
    const p = Number(a.readAt);
    out.readAt = (isFinite(p) && p > 0 && p <= 1) ? Math.round(p * 1000) / 1000 : 0;
  }
  // 开戏时拍下来的上下文快照（v0.5.2.4）。存成字符串而不是每次生成重读库：
  // 聊天被改了、分支切了、记忆被整理掉了，这场戏读到的还是当初那一份 ——
  // 和 source.excerpt 的快照隔离是同一个原则。
  out.context = S(a.context, SCENE_CONTEXT_MAX);
  out.ctxDropped = (Array.isArray(a.ctxDropped) ? a.ctxDropped : [])
    .map(x => String(x || '').trim()).filter(Boolean).slice(0, 8);
  out.status = SCENE_STATUS.includes(a.status) ? a.status : 'draft';
  out.canon = a.canon === true;
  out.quality = (a.quality === 'warn') ? 'warn' : 'ok';
  out.createdAt = Number(a.createdAt) || Date.now();
  out.updatedAt = Number(a.updatedAt) || out.createdAt;
  return out;
}

function normalizeCast(list) {
  const arr = (Array.isArray(list) ? list : []).map(c => {
    const o = (c && typeof c === 'object') ? c : {};
    const role = (o.role === 'user' || o.role === 'temp') ? o.role : 'main';
    const item = { role, name: S(o.name, 40) || (role === 'user' ? '你' : '') };
    if (role === 'main') item.charId = S(o.charId, 80);
    if (role === 'temp') {
      // 5 行小卡（§6）：名字 / 身份 / 外表 / 想要 / 瞒着。
      const card = (o.card && typeof o.card === 'object') ? o.card : {};
      item.ephemeral = true;
      item.card = {
        name: S(card.name, 40) || item.name,
        identity: S(card.identity, 80),
        look: S(card.look, 120),
        want: S(card.want, 120),
        secret: S(card.secret, 120)
      };
    }
    return item;
  }).filter(c => c.name || c.charId);
  // 上限：1 main + 1 user + 最多 2 temp（§5）。不做多 main，群像后置。
  const main = arr.filter(c => c.role === 'main').slice(0, 1);
  const user = arr.filter(c => c.role === 'user').slice(0, 1);
  const temp = arr.filter(c => c.role === 'temp').slice(0, TEMP_CAST_MAX);
  return [...main, ...user, ...temp];
}

function normalizeBlocks(list) {
  return (Array.isArray(list) ? list : []).map(b => {
    const o = (b && typeof b === 'object') ? b : {};
    const kind = ['narration', 'dialogue', 'user'].includes(o.kind) ? o.kind : 'narration';
    const text = String(o.text == null ? '' : o.text).replace(/\r/g, '').replace(/[ \t]+$/gm, '').trim();
    if (!text) return null;
    const item = { kind, text };
    if (o.ghost === true) item.ghost = true;      // 观众模式的代笔（§10）
    if (o.hasDialogue === true) item.hasDialogue = true;
    if (o.speaker) item.speaker = S(o.speaker, 40);
    if (Number.isInteger(o.beat) && o.beat >= 0) item.beat = o.beat;
    return item;
  }).filter(Boolean).slice(0, 400);
}

function normalizeLog(raw) {
  const o = (raw && typeof raw === 'object') ? raw : {};
  return {
    events: LINES(o.events, 200, 40),
    cast: LINES(o.cast, 40, TEMP_CAST_MAX + 2),
    change: S(o.change, 300),
    openThreads: LINES(o.openThreads, 200, 20),
    keyLines: LINES(o.keyLines, 200, 3),
    // v0.5.3：这一场【新确立的设定】（她左手有旧伤 / 码头归黑帮管 / 她开始怕水）。
    // 和 events 的区别：events 是"发生过什么"，newSettings 是"从现在起什么为真"。
    // 场记只负责把它读出来，写不写进角色设定由用户在结束页点。
    newSettings: LINES(o.newSettings, 40, 3)
  };
}

// ---------------- 名字 ----------------
//
// 规格 §9.3 第 3 条要求「所有名字都在 cast 或名字登记表里」。
// 中文正文里认人名没有可靠办法（没有空格、没有大小写），所以这里【只认一种信号】：
// 紧跟在说话动词前面的那个 2~4 字片段。「沈砚说」「掌柜问」这种。
// 别的写法（沈砚把那盏灯挪开）一律不判 —— 宁可漏判，不可把正常句子判成未登记名字。
// 这条近似写在这里，也写进 CHANGELOG：它不是完备的检查。

const SPEAK_VERBS = ['说', '问', '道', '笑', '答', '喊', '叫', '骂', '叹', '应', '开口', '接话'];
const NAME_TAIL = new Set(['说', '问', '道', '笑', '答', '喊', '叫', '骂', '叹', '应', '开', '接', '低', '轻', '沉', '冷']);
const NOT_NAME_HEAD = /^(于是|然后|只是|可是|但是|因为|所以|如果|虽然|不过|终于|立刻|马上|突然|慢慢|这才|本来|后来|接着|随即|转身|抬头|低头|回头|停下|起身|坐下)/;

/** 所有合法的「人」：主角色 + 你 + 临时人物（名字/卡片名都算） */
export function sceneNames(scene) {
  const out = new Set();
  for (const c of ((scene && scene.cast) || [])) {
    if (c && c.name) out.add(c.name);
    if (c && c.card && c.card.name) out.add(c.card.name);
  }
  return out;
}

/**
 * 找出正文里「像是人名、但不在登记表里」的片段。
 * 返回去重后的名字数组（空数组 = 没找到可疑的）。
 */
export function unknownNames(text, scene) {
  const known = sceneNames(scene);
  const src = String(text || '');
  const bad = new Set();
  // 后向要标点：不然「一道新鲜的划痕」里的「道」会被当说话动词，
  // 抽出「缘留着一」这种不是名字的东西，把好句子判成不合格（实测踩过）。
  // 代价是会漏掉「沈砚说完」这类写法 —— 沿袭上面的「宁可漏判」。
  const AFTER_VERB = "(?=[\\u3000-\\u303f\\uff01-\\uff0c\\s:,.!?\"" + "])";
  for (const v of SPEAK_VERBS) {
    const re = new RegExp('([\\u4e00-\\u9fff]{2,4})' + v + AFTER_VERB, 'g');
    let m;
    while ((m = re.exec(src))) {
      const raw = m[1];
      if (known.has(raw)) continue;
      if (NAME_TAIL.has(raw[raw.length - 1])) continue;
      if (/^[你我他她它们这那其每某]/.test(raw)) continue;
      if (NOT_NAME_HEAD.test(raw)) continue;
      bad.add(raw);
    }
  }
  return [...bad];
}

// ---------------- 字数与文本体检 ----------------

/** 中文字数：算 CJK 字 + 数字/字母串（标点与空白不算）—— 和「300–600 字」给人的直觉一致 */
export function countChars(text) {
  const s = String(text || '');
  const cjk = (s.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g) || []).length;
  const words = (s.match(/[A-Za-z0-9]+/g) || []).length;
  return cjk + words;
}

/**
 * 提示词里点名禁掉的句子（v0.5.2.4，照聊天侧那套「不合格」清单搬过来的）。
 *
 * 为什么单列一份而不是直接复用 AI_TELL：AI_TELL 是【检查器】，宁可漏判不可误伤，
 * 所以只留最没有歧义的几条；这里是【禁令】，多写几条没有代价 —— 模型看见了会绕开，
 * 真绕开了也就不用检查了。两边都留着，但职责不同。
 */
export const PROSE_BAN = [
  '作为 AI', '作为人工智能', '希望你喜欢', '希望这能帮到你', '希望对你有帮助',
  '总结一下', '以下是', '如果需要', '随时告诉我', '祝你',
  '这段文字', '本段', '字数：', '未完待续',
  '让我们一起', '不得不说', '值得一提的是', '总而言之',
  '空气中弥漫着', '仿佛时间静止', '心中五味杂陈',
  // v0.5.3：客服腔的两个固定句式（评审给的，确实最常见）
  '需要我做什么', '有什么可以帮你'
];

const AI_TELL = [
  '作为AI', '作为 AI', '作为人工智能', '希望你喜欢', '希望这能帮到你', '总结一下',
  '如果需要', '随时告诉我', '祝你', '希望对你有帮助', '以下是', '这段文字', '本段',
  '字数：', '未完待续'
];
const TIME_JUMP = [
  '第二天', '次日', '翌日', '隔天', '几天后', '三天后', '一周后', '一个月后', '半年后',
  '一年后', '多年后', '多年以后', '后来', '从此', '那次之后', '再后来'
];
const EMPTY_CHANGE = ['聊了很久', '气氛很好', '相处融洽', '关系更近', '感情升温', '度过了一段', '相谈甚欢'];

/** 把引号里的台词剥掉，剩下的就是旁白（用来判「旁白有没有大段我」） */
export function narrationOnly(text) {
  return String(text || '')
    .replace(/「[^」]*」/g, '')
    .replace(/“[^”]*”/g, '')
    .replace(/"[^"]*"/g, '')
    .replace(/「[^」]*$/g, '');
}

/**
 * 质量闸门（§9.3）。返回 { ok, reasons, chars }。
 * reasons 里的每一条都是给人看的一句话，会原样显示在界面上（§8「显示原因」）。
 */
export function checkQuality(text, scene, beatIdx) {
  const t = String(text || '');
  const reasons = [];
  const L = SCENE_LENGTHS[(scene && scene.length) || 'short'] || SCENE_LENGTHS.short;
  const n = countChars(t);
  // 多拍是分批写的（v0.5.3.1）：字数要按【这一拍】判，不能拿整场的区间。
  // medium 侥幸过是因为 600/2 = 300，正好等于下限；long 3 拍、chapter 5 拍
  // 每一拍都只有总长的几分之一，按整场判就永远「字数不在区间内」，白重试一次。
  const per = (L.beats > 1 && Number.isInteger(beatIdx)) ? beatChars(scene && scene.length) : null;
  const lo = per ? per.min : L.min;
  const hi = per ? per.max : L.max;

  if (!t.trim()) reasons.push('这一版是空的');
  if (n && (n < lo * 0.8 || n > hi * 1.2)) {
    reasons.push('字数 ' + n + '，不在 ' + lo + '–' + hi + ' 之间');
  }
  const want = S(scene && scene.beats && scene.beats[0] && scene.beats[0].change, 200);
  if (want && n > 0 && EMPTY_CHANGE.some(x => t.includes(x))) {
    reasons.push('正文里只有空话（聊了很久 / 气氛很好 这一类），没有具体变化');
  }
  const names = unknownNames(t, scene);
  if (names.length) reasons.push('出现没登记过的名字：' + names.join('、'));
  if (t.includes('用户')) reasons.push('正文里出现了「用户」');
  const tell = AI_TELL.find(x => t.includes(x));
  if (tell) reasons.push('出现了不该有的说法：' + tell);
  const jump = TIME_JUMP.find(x => t.includes(x));
  if (jump) reasons.push('跳时间了：' + jump);
  // her-limited：旁白不许用「我」讲故事。
  const woCount = (narrationOnly(t).match(/我/g) || []).length;
  if (woCount >= 3) reasons.push('旁白里出现了 ' + woCount + ' 次「我」，视角漂了');
  if (/^#{1,6}\s|\n#{1,6}\s/.test(t)) reasons.push('混进了 Markdown 标题');
  if (/^\s*[-*]\s|\n\s*[-*]\s/.test(t)) reasons.push('写成了分点列表');
  return { ok: reasons.length === 0, reasons, chars: n };
}

// ---------------- 提示词 ----------------

const MODE_NOTE = {
  actor: [
    '你的位置：演员（你在场，你自己写自己的话和动作）。',
    '不替你写新的话、不替你做决定；你没动，就只写环境、她、旁白。'
  ],
  director: [
    '你的位置：导演（你不在场）。',
    '所有人由你写。你给的是导演指令，不是台词 —— 指令不进正文，正文里也不出现「你」。'
  ],
  audience: [
    '你的位置：观众（你在场，允许代写）。',
    '可以代写你的动作和台词，但要短、要像你会说的话；你什么时候接手由你决定。',
    '代写的那几句要写成普通正文，不要标注是谁写的。'
  ]
};

/**
 * 正文提示词（§9.1）。beatIdx 给了就只写那一拍。
 * opts.userLine：这一轮他刚说的话（演员/观众模式）；opts.directive：导演指令。
 * opts.prevText：已经写完的上一拍结尾，用来接住。
 */
export function sceneProsePrompt(scene, opts = {}) {
  const a = normalizeScene(scene);
  const L = SCENE_LENGTHS[a.length];
  const bi = Number.isInteger(opts.beatIdx) ? opts.beatIdx : 0;
  const beat = a.beats[Math.min(bi, a.beats.length - 1)] || emptyBeat();
  const main = a.cast.find(c => c.role === 'main');
  const temps = a.cast.filter(c => c.role === 'temp');
  // 导演模式正文里不出现「你」，所以「在场」也不列他（§10）。
  const inScene = a.cast.filter(c => !(a.userMode === 'director' && c.role === 'user')).map(c => {
    if (c.role === 'user') return c.name;
    if (c.role === 'temp') return c.name + '（临时人物：' + [(c.card && c.card.identity), (c.card && c.card.look)].filter(Boolean).join('，') + '）';
    return c.name + '（她）';
  }).join('、');

  // 开戏那一刻拍下来的底色（v0.5.2.4）。opts.context 优先，没传就用卡里存的。
  const ctx = S(opts.context != null && opts.context !== '' ? opts.context : a.context, SCENE_CONTEXT_MAX);

  const p = [];
  p.push('你是这场戏的叙述者，不是助手。');
  p.push('');
  if (ctx) {
    p.push('【她是谁、这是个什么世界（开这一场时定下的底色）】');
    p.push(ctx);
    p.push('上面这些是【底色】，不是这一场要写的内容：不要复述它，不要把它当旁白念出来；');
    p.push('但写出来的每一句都不能跟它打架 —— 她的说话方式、她的习惯、这个世界的规矩，都按上面来。');
    p.push('');
  }
  p.push('【场景卡】');
  p.push('地点：' + (a.setting.place || '沿用角色现在所在的地方'));
  p.push('时间：' + (a.setting.time || '接着上一段'));
  p.push('天气：' + (a.setting.weather || '不用特意写'));
  p.push('在场：' + (inScene || (main ? main.name : '她')));
  p.push(MODE_NOTE[a.userMode].join('\n'));
  p.push('这一拍要改变什么：' + (beat.change || '把这一段往前推一步，让某件事不一样'));
  if (beat.guardrails.length) p.push('不能出现什么：' + beat.guardrails.join('；'));
  // 多拍时给的是【这一拍】的字数（v0.5.3.1）：写整场的 4000–8000 会让第一拍
  // 就把整场铺开写掉，后面几拍无处可去。
  const per = beatChars(a.length);
  p.push(L.beats > 1
    ? '这一场一共 ' + L.beats + ' 拍，这一拍只写 ' + per.min + '–' + per.max + ' 字（上限，不是任务）'
    : '长度：' + L.min + '–' + L.max + ' 字（上限，不是任务）');
  p.push('');
  // 「从聊天成章」时把那段聊天的快照带上（§2）。
  // v0.5.3.1 改了这里的口径：以前写「只当背景，接着它往下走」，结果模型拿它当人物关系表，
  // 另起一件不相干的事来写 —— 他要的是「把我选的这段写成小说」。改成【素材】。
  if (a.source.kind === 'chat' && a.source.excerpt) {
    p.push('【素材：你们聊天里的一段】');
    p.push(a.source.excerpt);
    p.push('这是【素材】不是概述：这一场要把其中发生过的事写成正文 —— 挑出里面真正发生的那几件事，一件一件铺开，让它具体到能看见。');
    p.push('不要另起一件和它无关的事，也不要原话照抄对话（把「她说」写成旁白和动作）。');
    p.push('素材里没写到、但这一场需要的东西（天气、声音、手上的动作）可以补，但不能改写素材里已经定下的事实。');
    p.push('');
  }
  p.push('【这一拍】');
  if (beat.start) p.push('从这儿开始：' + beat.start);
  if (beat.stop) p.push('停在这儿：' + beat.stop);
  p.push('');
  p.push('【视角】');
  p.push('跟随' + (main ? main.name : '她') + '。旁白用「她」，她的台词用「我」，对「你」用「你」。');
  p.push('不要用「我」写旁白。');
  p.push('不要写「用户」。');
  p.push('');
  p.push('【写法】');
  p.push('- 只写这一场，不写前情提要，不写下一场。');
  p.push('- 不写「他们聊了很久」「气氛很好」这种总结。');
  p.push('- 每个动作、每句台词都要具体。');
  p.push('- 对白用中文引号。');
  p.push('- 不写【名字】标签；不要写成剧本。');
  if (a.userMode === 'actor') p.push('- 不替「你」说新的话、做新的决定。');
  if (a.userMode === 'director') p.push('- 正文里不出现「你」。');
  p.push('- 不新增未登记的名字' + (temps.length ? '（临时人物只有 ' + temps.map(c => c.name).join('、') + '）' : '') + '。');
  p.push('- 不跳时间；不写「第二天」「后来」「多年后」。');
  p.push('- 结尾停在具体动作、未说完的话、或一个物件上。');
  // 客服腔 / 陈词滥调（v0.5.2.4）：原来只禁三句，等于只堵了最显眼的那个洞。
  // 清单本身在 PROSE_BAN（和检查器共用一份素材，检查器只用其中最没歧义的几条）。
  p.push('- 下面这些说法一个都不许出现：' + PROSE_BAN.join('、') + '。');
  p.push('');
  p.push('【长度】');
  p.push(L.beats > 1 ? '这一拍自然停下就停，后面还有几拍，不要替它们把事做完。' : '写到这一场自然结束，但不超过上限。');
  p.push('接近上限时，停在完整句子，不要半句截断。');
  p.push('');
  if (opts.prevText) {
    p.push('【前面已经写到这里，接住它，不要复述】');
    // 2400 字（v0.5.2.4）：原来只给最后 600 字，中场写第 2 拍时第 1 拍的
    // 前半段已经看不见了 —— 人还在门口，模型已经开始写屋里，或者反过来。
    p.push(String(opts.prevText).slice(-2400));
    p.push('');
  }
  // 场记（v0.5.2.4）：多拍时上一拍的「发生了什么」也要带进来。
  // 只靠 prevText 的正文尾巴不够 —— 正文写的是【怎么写的】，场记写的是【发生了什么】，
  // 前者 2400 字之后就开始丢，后者一句话就够。
  const lg = (opts.log && typeof opts.log === 'object') ? opts.log : null;
  if (lg) {
    const evs = Array.isArray(lg.events) ? lg.events.filter(Boolean).slice(0, 8) : [];
    const ths = Array.isArray(lg.openThreads) ? lg.openThreads.filter(Boolean).slice(0, 4) : [];
    if (lg.change || evs.length) {
      p.push('【前面几拍已经发生的事（照着往下走，不要重演）】');
      if (evs.length) p.push(evs.map(x => '· ' + String(x).slice(0, 120)).join('\n'));
      if (lg.change) p.push('到现在为止变成什么样了：' + String(lg.change).slice(0, 200));
      if (ths.length) p.push('还悬着的事：' + ths.map(x => String(x).slice(0, 100)).join('；'));
      p.push('');
    }
  }
  if (a.userMode === 'actor' && opts.userLine) {
    p.push('【他已经说过的话（不要重复，不要替他再说一遍）】');
    p.push(String(opts.userLine).slice(0, 400));
    p.push('');
  }
  // 质量闸门重试时把「上一次不合格在哪」塞进提示词（v0.5.2 修：
  //   原来重试走的是 opts.directive，而 directive 只有导演模式才用 ——
  //   演员/观众模式下重试等于原样重发一遍，模型多半再写一遍同样的东西。
  if (opts.fixup) {
    p.push('【这一次重写要改的地方（上一遍不合格）】');
    p.push(String(opts.fixup).slice(0, 400));
    p.push('');
  }
  if (a.userMode === 'director' && opts.directive) {    p.push('【导演指令（照它写，但不要把它写进正文）】');
    p.push(String(opts.directive).slice(0, 400));
    p.push('');
  }
  if (temps.length) {
    p.push('【临时人物（只在这一场里，不许改设定）】');
    for (const c of temps) {
      const k = c.card || {};
      p.push('- ' + c.name + '：' + [k.identity, k.look, k.want ? '想要' + k.want : '', k.secret ? '瞒着' + k.secret : ''].filter(Boolean).join('；'));
    }
    p.push('');
  }
  p.push('【输出】');
  p.push('只输出正文。不要标题、不要分点、不要解释。');
  return p.join('\n');
}

/** 分镜提示词（§8）：按档位出 1–5 拍，他确认/改拍，再按拍写正文（v0.5.3.1 起长档要 3、整章要 5） */
export function sceneBeatPlanPrompt(scene) {
  const a = normalizeScene(scene);
  const L = SCENE_LENGTHS[a.length];
  const main = a.cast.find(c => c.role === 'main');
  const p = [];
  p.push('给这一场戏分拍。只输出 JSON，不要解释。');
  p.push('');
  p.push('这一场要改变什么：' + (S(a.beats[0] && a.beats[0].change, 300) || '（没填）'));
  if (a.setting.place) p.push('地点：' + a.setting.place);
  if (main) p.push('主视角：' + main.name);
  p.push('总长：' + L.min + '–' + L.max + ' 字，分 ' + L.beats + ' 拍。' + (L.beats > 1 ? '从第二拍起，每一拍都要有一个小转折。' : ''));
  p.push('');
  p.push('每拍的格式：');
  p.push('{ "start": "从哪个动作或哪句话开始", "change": "这一拍结束时什么和开始时不一样", "stop": "停在哪句话或哪个动作", "guardrails": ["不能出现什么"] }');
  p.push('');
  p.push('输出：{ "beats": [ ... ] }');
  return p.join('\n');
}

/** 场记提示词（§9.2） */
export function sceneLogPrompt(text) {
  return [
    '读下面的正文，输出 JSON：',
    '',
    '{',
    '  "events": ["这一场实际发生了什么，按顺序"],',
    '  "cast": ["实际开口或被写到的人"],',
    '  "change": "这一场结束时，什么和开始时不一样",',
    '  "openThreads": ["没解决的事"],',
    '  "keyLines": ["最多 3 句关键台词"],',
    '  "newSettings": ["这一场新确立的设定，最多 3 条，每条不超过 40 字；没有就 []"]',
    '}',
    '',
    '不要编造正文里没有的事。',
    'newSettings 只收【这一场之后一直成立】的事实（她左手有旧伤 / 码头归黑帮管 / 她开始怕水），',
    '不收"这一场发生了什么"（那是 events）。没有新设定就给空数组。',
    '不要写评价。',
    '只输出 JSON。',
    '',
    '【正文】',
    String(text || '').slice(0, 8000)
  ].join('\n');
}

/**
 * 临时人物取名提示词（§6）。
 * 风格从他在场角色的世界书/设定里推 —— 这里只把素材递进去，不替他决定。
 * used：已经在用的名字（在场角色 + 这一场已经出现过的临时人物）。
 */
export function tempCastPrompt(scene, used = [], extra = '') {
  const a = normalizeScene(scene);
  const p = [];
  p.push('给这一场戏造一个临时配角。只输出 JSON，不要解释。');
  p.push('');
  p.push('【这一场】');
  if (a.setting.place) p.push('地点：' + a.setting.place);
  if (a.title) p.push('这段叫什么：' + a.title);
  const main = a.cast.find(c => c.role === 'main');
  if (main) p.push('主视角角色：' + main.name);
  if (extra) { p.push(''); p.push('【世界的样子】'); p.push(String(extra).slice(0, 1500)); }
  p.push('');
  p.push('【取名的规矩】');
  p.push('- 名字要跟上面那个世界的风格走：现代都市就是张伟、李婷、陈叔这种；西幻就是艾琳、罗兰、老陶；古风就是沈砚、阿蘅、掌柜。');
  p.push('- 不能西幻里冒出「王小明」这种。');
  p.push('- 避开这些已经在用的名字：' + (used.length ? used.join('、') : '（没有）'));
  p.push('');
  p.push('【格式】');
  p.push('{ "name": "名字", "identity": "身份（店伙计/邻居/同门/路人 这类）", "look": "外表一句话", "want": "他想要什么", "secret": "他瞒着什么" }');
  return p.join('\n');
}

/** 把模型吐出来的一坨文本里那个 JSON 抠出来（有代码围栏包着也认） */
export function parseJsonLoose(text) {
  const s = String(text || '');
  const fenced = s.match(/\x60\x60\x60(?:json)?\s*([\s\S]*?)\x60\x60\x60/i);
  const body = fenced ? fenced[1] : s;
  const a = body.indexOf('{');
  const b = body.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(body.slice(a, b + 1)); } catch { return null; }
}

/** 把生成的整段正文切成 blocks（按段落）。带引号的段落标 dialogue，方便「删/转旁白」。 */
export function textToBlocks(text, beatIdx = 0) {
  const paras = String(text || '')
    .replace(/\r/g, '')
    .split(/\n\s*\n|\n/)
    .map(x => x.trim())
    .filter(Boolean);
  return paras.map(t => {
    const quoted = /「[^」]*」|“[^”]*”/.test(t);
    // 只有引号的段落 = 纯台词；带叙述的段落算旁白（中文小说里叙述和对白常在同一段）。
    const onlyQuote = /^[「“"].*[」”"]$/.test(t);
    const b = { kind: onlyQuote ? 'dialogue' : 'narration', text: t, beat: beatIdx };
    if (quoted && !onlyQuote) b.hasDialogue = true;
    return b;
  });
}

/** 「转旁白」：把台词剥成叙述（§12 删角色台词二选一里的那一个） */
export function dialogueToNarration(text) {
  const keep = String(text || '')
    .replace(/「[^」]*」/g, '')
    .replace(/“[^”]*”/g, '')
    .replace(/"[^"]*"/g, '')
    .replace(/[，、]\s*[，、]/g, '，')
    .replace(/\s{2,}/g, ' ')
    .trim();
  // 剥完只剩标点的，等于整段都是话 —— 返回空串，调用方按删除处理。
  return /^[，。、；：…—\s]*$/.test(keep) ? '' : keep;
}

export function sceneWordCount(scene) {
  return ((scene && scene.blocks) || []).reduce((n, b) => n + countChars(b.text), 0);
}

/** 这一场写过了没有（有正文或已有场记） */
export function sceneFilled(scene) {
  const a = normalizeScene(scene);
  return a.blocks.length > 0 || (a.log && a.log.change) !== '';
}
