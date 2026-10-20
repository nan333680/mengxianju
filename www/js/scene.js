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
export const SCENE_VER = 1;

/** 两档长度：字数 = 上限，不是任务（§3） */
export const SCENE_LENGTHS = {
  short: { min: 300, max: 600, beats: 1, label: '短' },
  medium: { min: 600, max: 1200, beats: 2, label: '中' }
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
    log: { events: [], cast: [], change: '', openThreads: [], keyLines: [] },
    status: 'draft',
    canon: false,
    quality: 'ok',
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
}

/** 一份拍的空白。短场只要一拍，中场最多两拍。 */
export function emptyBeat() {
  return { start: '', change: '', stop: '', guardrails: [] };
}

/** 这一场最多几拍：短场 1，中场 2（§5） */
export function beatCountFor(length) {
  const L = SCENE_LENGTHS[length] || SCENE_LENGTHS.short;
  return L.beats;
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
    excerpt: S(src.excerpt, 2000)
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
    keyLines: LINES(o.keyLines, 200, 3)
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
export function checkQuality(text, scene) {
  const t = String(text || '');
  const reasons = [];
  const L = SCENE_LENGTHS[(scene && scene.length) || 'short'] || SCENE_LENGTHS.short;
  const n = countChars(t);

  if (!t.trim()) reasons.push('这一版是空的');
  if (n && (n < L.min * 0.8 || n > L.max * 1.2)) {
    reasons.push('字数 ' + n + '，不在 ' + L.min + '–' + L.max + ' 之间');
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

  const p = [];
  p.push('你是这场戏的叙述者，不是助手。');
  p.push('');
  p.push('【场景卡】');
  p.push('地点：' + (a.setting.place || '沿用角色现在所在的地方'));
  p.push('时间：' + (a.setting.time || '接着上一段'));
  p.push('天气：' + (a.setting.weather || '不用特意写'));
  p.push('在场：' + (inScene || (main ? main.name : '她')));
  p.push(MODE_NOTE[a.userMode].join('\n'));
  p.push('这一拍要改变什么：' + (beat.change || '把这一段往前推一步，让某件事不一样'));
  if (beat.guardrails.length) p.push('不能出现什么：' + beat.guardrails.join('；'));
  p.push('长度：' + L.min + '–' + L.max + ' 字（上限，不是任务）');
  p.push('');
  // 「从聊天成章」时把那段聊天的快照带上：只当背景，不让它复述（§2）。
  if (a.source.kind === 'chat' && a.source.excerpt) {
    p.push('【前情（从你们的聊天里截的，只当背景）】');
    p.push(a.source.excerpt);
    p.push('上面这段是【以前发生过的】，不是这一场要写的内容：不要复述它，不要照抄原话，只让这一场接着它的关系往下走。');
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
  p.push('- 不写「作为 AI」「希望你喜欢」「总结一下」。');
  p.push('');
  p.push('【长度】');
  p.push('写到这一场自然结束，但不超过上限。');
  p.push('接近上限时，停在完整句子，不要半句截断。');
  p.push('');
  if (opts.prevText) {
    p.push('【前面已经写到这里，接住它，不要复述】');
    p.push(String(opts.prevText).slice(-600));
    p.push('');
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

/** 中场分镜提示词（§8）：先出 1~2 拍，他确认/改拍，再按拍写正文 */
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
  p.push('总长：' + L.min + '–' + L.max + ' 字，分 ' + L.beats + ' 拍。' + (L.beats > 1 ? '第二拍必须有一个小转折。' : ''));
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
    '  "keyLines": ["最多 3 句关键台词"]',
    '}',
    '',
    '不要编造正文里没有的事。',
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
