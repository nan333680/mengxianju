import { kv, chars, msgs, mem, wb, uid, wipeAll, dbAdmin } from './db.js';
import { streamChat, onceChat, needsVision, fileToDataUrl, compressImage, fetchBalance, webSearch, formatSearch, providerSpec, providerList, estimateTokens, estimateMsgTokens, isContextOverflow, fitHistoryByBudget } from './api.js';
import { buildStablePrompt, buildTurnNote, decideKaomoji, stripKaomoji, splitMessages, FREQ_PRESETS, detectKaomoji, dayLabel, DAYS_PER_YEAR } from './persona.js';
import { PRESETS, getPreset, PARAM_DEFAULTS } from './presets.js';
import { t, tt, applyI18n, setLang, getLang, getActiveLang, refreshLang, LANGS } from './i18n.js';
// 角色卡（实验，v1.21.40）：解析与 PNG 打包都在这个独立文件里，
// 主文件只负责"选文件 / 落库 / 写出去"。
import { isPng, parseCardJson, extractCardFromPng, buildCardV2, makeCardPng, bytesToB64, readMkParams } from './charcard.js';
// 自动备份（v1.21.40）：纯逻辑，依赖全部注入，见该文件头部说明。
import { autoBackupIfDue } from './autobackup.js';
// 导出 Markdown（v1.21.48）：纯函数，接一组消息吐一个字符串
import { buildChatMarkdown, markdownFileName } from './exportmd.js';

// ⚠️ 这里绝对不能 import '@capacitor/xxx'！
// www/ 会被原样复制进 APK，WebView 里没有 node_modules，
// 裸模块名解析失败会导致整个 app.js 加载失败、界面卡死。
// 插件改为运行时从 Capacitor 注入的全局对象取，取不到就安全回退。

/** 是否跑在安卓原生壳里 */
function isNative() {
  try {
    const C = window.Capacitor;
    return !!(C && C.isNativePlatform && C.isNativePlatform());
  } catch { return false; }
}

/** 取原生插件（取不到返回 null，绝不抛错） */
function capPlugin(name) {
  try {
    const C = window.Capacitor;
    if (C && C.Plugins && C.Plugins[name]) return C.Plugins[name];
  } catch { /* ignore */ }
  return null;
}

// ================= 全局状态 =================
// 同一批总结最多重试几次（v1.21.35 新增）。
//
// 背景：0 产出时【不记账】（否则那批消息被标记"看过"却一条没留下，永久丢失），
// 但也不能无限重试 —— 有些批次内容确实重复，模型永远回 0。
// 试满这个次数就认为"确实没有可记的"，记账放行。
//
// ⚠️ 必须放模块级：runArchiveNow 和 summarizeIfNeeded 两条路都要用
//    （第一版写在 runArchiveNow 里，第二处引用直接 ReferenceError）。
const ZERO_RETRY_MAX = 3;

// ⚠️ 批签名与重试键（v1.21.38 修 P0-1/P0-2/P0-3）。
// 同样【必须放模块级】—— 归档（runArchiveNow）和总结（summarizeIfNeeded）两条路都用。
// 我这次第一版就是又写进了 runArchiveNow 内部，总结路径立刻 ReferenceError（上面那条注释白写了）。
//
// 签名：原来只用「长度 + 排序后首 id + 尾 id」，两个批次长度相同且首尾相同时会撞
// （中间 id 不同不影响）→ 同一段对话被重新切分、或导入数据 id 有规律重复时串批计数。
// 现在把全量 id 拼起来取哈希。
//
// 键：两条链路必须用不同 kv 键，否则互相清零 ——
// 归档成功时 kv.set(retryKey, {}) 会把总结路径攒的重试次数一并清空（退化成无限重试），
// 反之总结路径放行后 delete 也可能清掉归档的计数。
function zeroRetryKey(scope, charId) { return 'memZeroRetry:' + scope + ':' + charId; }
function batchSig(list) {
  const ids = list.map(m => m.id).sort();
  if (!ids.length) return '0:empty';
  const s = ids.join(',');
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
  return ids.length + ':' + (h >>> 0).toString(36);
}

const DEFAULTS = {
  // ⚠️ v1.21.40：默认留空，改成让用户自己填。
  //
  // 以前这里写死了一把真 Key，"装完即用"是真的 —— 但 APK 一反编译就能拿走，
  // 一旦把包发给别人，就是你在替全世界的用量付费。
  //
  // 老用户不受影响，不用重填：loadSettings 里是 { ...DEFAULTS, ...saved }，
  // 他们库里存的 apiKey 会盖掉这个空串，自动继承。
  apiKey: '',
  baseUrl: 'https://api.deepseek.com',
  // v1.21.47：服务商档案（能力差异全在 api.js 的 PROVIDERS 里，这里只记选了哪家）
  provider: 'deepseek',
  model: 'deepseek-flash', visionModel: 'deepseek-flash',
  temperature: 1.0, maxTokens: 2048, topP: 1.0, reasoningEffort: 'low', contextRounds: 20,
  // 上下文预算（v1.21.54）：整个请求（人设 + 世界书 + 历史 + 本轮段）的输入上限，
  // 单位是估算的 token。48000 是折中：常见 64K 窗口下留得下回复，
  // 128K 窗口的用户可以往大调。撞爆窗口时还有自动降级兜底（见 send 的重试循环）。
  contextBudget: 48000,
  kaomojiFreq: 0.15, kaomojiStyle: 'jp-soft', emojiFreq: 0.1,
  verbosity: 'medium', splitMessages: false, splitMax: 3,
  typingDelay: 1.0, showTyping: true, hesitation: true,
  longMemory: false, theme: 'dark', fontSize: 15, showUsage: true,
  // 朗读（v1.21.56）：她说完自动读出来。默认关 —— 不是所有人任何时候都想被念出声。
  ttsOn: false,
  // 默认【关】：你手动加的记忆，整理时原样保留，她不许改也不许删
  allowEditMine: false,
  // 剧情时间是否细化到「几点几分」（全局开关，默认关 = 保持只有"第几天+时段"）
  // 「我的设定」：角色级字段 char.myProfile 才是生效值（v1.21.47 起），
  //   这里这一份只剩【新建角色的初始值】一个身份。
  // ⚠️ 它会原样编译进 APK，反编译不需要运行就能逐字读到 ——
  //   所以这里只能放【不含个人信息的通用模板】，不要把私人自述写回来。
  //   （旧的那份 691 字自述已挪出源码，见 _archive/myprofile-original-1.21.50.txt）
  // 它每轮都注入 system、是稳定前缀（命中 prefix 缓存），改一次会整体失效一次。
  myProfile: "【我是谁】\n普通上班族。工作日朝九晚六，通勤要花上一段，白天基本不在线，晚上和周末才真正有空。\n\n【日常状态】\n日子过得平常，没什么大事。下班回来常常是累的，话比白天少 —— 那不是冷淡，是电量低。\n偶尔加班，偶尔什么都不想干，第二天一般就恢复了。\n\n【怎么跟我说话】\n· 不用一直找话题，安静一会儿也没关系。\n· 有事说事，别绕圈子。别催我、别教育我、别替我做决定。\n· 我说话偏直白，不爱绕弯子，那不是不耐烦。\n· 我忙或累的时候回得慢、回得短，别往心里去。\n\n【我在意的】\n被记住小事 比 被夸 更让我高兴\n不用刻意热闹 比 硬找话说 更舒服\n你是什么样就什么样 比 一直顺着我 更好\n\n这只是一份通用说明。相处久了，以你真正了解到的我为准。",
  // 「世界书」总开关（v1.15.2 起）：关掉就完全不注入任何世界书条目。
  // 三套库（角色组 / 单独角色）都受它控制。
  worldbookOn: false,
  // 「我的居住环境」：全局一份。他住的地方长什么样。
  // 加它的原因：模型没有环境设定时会自由发挥——凭空编窗外、编房间、编天气，
  // 跟用户实际的情况打架（长期记忆也拦不住，记忆记的是"事件"不是"环境"）。
  myEnv: '',
  // 非对话描写档位（角色级）：控制括号里的内容写多详细，和「回复长度」是两个独立的上限
  descLevel: 'mid',
  // 描写驱动力（v1.21.31 新增）：管【括号里必须写成什么样】，和 descLevel 并列。
  //   descLevel   管上限（最多写多长）
  //   detailDrive 管结构（必须写成什么形状）
  // 默认 off = 不额外约束，保持所有老角色的现状。
  detailDrive: 'off',
  // 视角开关（角色级，v1.21.47 及以前）：开着时强制她只从自己的视角写。
  // ⚠️ v1.21.48 起被 povStyle 取代 —— 这个键【只留给老数据读】，不再写、不再读进 prompt。
  //    不删它：老备份导回来还得认。
  povLock: false,
  // 叙事视角档位（角色级，v1.21.48）：'' / L1 / L2 / L3 / L4，见 persona.js 的 POV_STYLES。
  // 空串 = 不注入任何视角段落 = 老版本 povLock=false 的行为。
  povStyle: '',
  // 强制聊天模式（角色级）：开着后，他会"听不见"对方括号里的心理活动，
  // 只从观察里推 —— 治"像读心"的毛病。默认关（有读心设定的角色不需要）。
  thinkMode: false,
  // 「外貌」（角色级）：她此刻的穿着和状态。二十来字就够，随时改。
  // 和人物设定分开存 —— 人物设定是"她是谁"（基本不变），这里是"她此刻什么样"（随时会变）。
  appearance: '',       // 长期基线：右上角 ✓ 保存的
  appearanceLive: '',   // 临时覆盖：「立即生效」写的，优先于上面那条
  appearanceOn: true,   // 开关：关掉后内容留着但不再注入 prompt
  clockDetail: false,
  // 「写字台」（v1.21.48，全局）：输入框最多长到几行。默认 3 —— 比现在的 120px 长，
  // 又不会一打字就把聊天记录顶掉。想写长段的人自己在设置里往上调。
  inputMaxH: 3,
  // 回车键做什么：true = 回车即发（老行为，默认）；false = 回车换行、按按钮发。
  // ⚠️ 安卓上没有 Ctrl，所以「回车换行」这一档必须靠【发送】按钮，不能学桌面那套 Ctrl+Enter。
  enterSend: true,
  // 「时间跟现实走」（全局开关，v1.20.21 新增）。
  // 开着时：时间不再由你手动调，而是按手机真实时钟走 —— 第几天从开启那刻算起，
  // 时段和季节读系统时间。手动时间条会缩成只读的一行。
  //
  // ⚠️ 默认值是 true，但【升级安装会被迁移成 false】（见 loadSettings）。
  //    约定：新装默认全局开，更新安装继承旧行为（别把他手动设的时间顶掉）。
  clockMode: true,
  globalOverride: false,
  // —— 联网搜索（默认关，纯本地）——
  // 只在用户明确打「/搜 xxx」时才联网。不自动触发。
  // ⚠️ v1.21.40：同样改成留空（理由见上面 apiKey 那条）。
  //    searchOn 仍是 true —— 这个开关只管"允不允许联网"，
  //    真要用还得自己在设置里填 Key，没填时状态栏会写「缺 key」。
  searchOn: true,
  searchKey: '',
  searchCount: 5,          // 每次取几条结果
  // 记忆管理（可在设置里调）
  archiveKeep: 30,         // 归档时「保留最近多少条」不归档（独立于记忆节奏）
  autoArchive: true,       // 自动滚动归档：超过保留数就把最早的收起来（不用手点）
  // ⚠️ v1.14.0 调过：默认值原为 30 / 10 / 20，反馈"记忆太频繁、太杂"。
  //    30 条就总结一次 = 十几轮就来一轮，模型每次还倾向于凑满 5 条，
  //    很快就顶到上限，然后开始丢掉早先更重要的记忆。
  //    放宽到 50 / 20：总结更少、整理更少，单次质量比数量重要。
  memSummarizeEvery: 50,   // 攒够多少条消息，总结一次新记忆
  memDedupeEvery: 20,      // 每隔多少轮，查重整理一次
  memLimit: 20,            // 记忆条数上限
  // 历史消息带时间标记（C-B，2026-09-28 新增）。默认开。
  // 只在"时间变了"的接缝上标一条（换时段/换天），不是每条都标 —— 见 markHistoryTime。
  historyTime: true,
  // 界面语言（v1.21.61）。只影响界面文字，不影响模型输出。
  // 默认「跟随系统」：手机换语言，App 跟着变。
  lang: 'system',
  // 时段对应的小时范围（她按这个理解"早上""傍晚"具体几点）
  clockRanges: {
    dawn: [0, 5], morning: [5, 9], forenoon: [9, 11], noon: [11, 13],
    afternoon: [13, 17], evening: [17, 19], night: [19, 23], lateNight: [23, 24],
  }
};

// 可被角色单独设置的参数（其余如 API Key / 主题仍是全局的）
const CHAR_KEYS = [
  'temperature', 'maxTokens', 'topP', 'reasoningEffort', 'contextRounds',
  'kaomojiFreq', 'kaomojiStyle', 'emojiFreq', 'verbosity',
  'splitMessages', 'typingDelay', 'hesitation', 'showTyping', 'longMemory',
  // 非对话描写档位（控制括号里写多详细）—— 上限
  'descLevel',
  // 描写驱动力（控制括号里必须写成什么形状）—— 结构，与 descLevel 并列、互不覆盖
  'detailDrive',
  // 视角锁定（老字段，只读不写，见 DEFAULTS 里的说明）
  'povLock',
  // 叙事视角档位（v1.21.48）：'' / L1 / L2 / L3 / L4
  'povStyle',
  // 外貌：她此刻的样子（每轮注入，位置固定在角色设定之后）
  'appearance', 'appearanceOn', 'appearanceLive',
  // 强制聊天模式：把"括号"的语义掰正（他括号里的心理活动她听不见）
  'thinkMode',
  // 允许她整理记忆时改动"我自己加的那几条"。放角色页 = 每个角色各设各的。
  'allowEditMine',
  // 联网搜索（角色级三态）：'' / undefined = 跟随全局，'on' = 强制开，'off' = 强制关。
  // 单独一个键，不复用全局的 searchOn（那个是布尔，语义不同，混在一起会互相覆盖）。
  'searchPolicy',
  // 时间是否跟现实走（角色级三态，v1.20.21）：'' / undefined = 跟随全局，
  // 'on' = 这个角色强制跟现实走，'off' = 这个角色强制保持手动。
  // 和 searchPolicy 完全同构 —— 优先级：角色级 > 全局。
  'clockPolicy'
  // 注意：记忆的三个节奏参数（总结间隔 / 查重间隔 / 条数上限）**不在这里** ——
  // 它们是全局统一的，改在「设置 → 记忆管理 → 记忆节奏」。
  // 记忆的内容则完全按角色走（memories 表里按 charId 分）。
];

/** 从全局设置里抽一份角色参数（新建角色时作为初始值） */
function pickCharParams(s) {
  const o = {};
  // 跳过 undefined：编辑页的 data 里没有 topP（界面上也没这个控件），
  // 照抄会把全局设置里的 topP 抹成 undefined 并持久化。
  for (const k of CHAR_KEYS) if (s[k] !== undefined) o[k] = s[k];
  return o;
}

/**
 * 计算某角色实际生效的参数
 * - globalOverride = true  → 全部用全局设置
 * - globalOverride = false → 角色自己设过的用角色的，没设的回退到全局
 */
function effSettings(char, s) {
  const out = { ...s };
  if (s.globalOverride || !char) return out;
  for (const k of CHAR_KEYS) {
    const v = char[k];
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

let S = { ...DEFAULTS };
let curCharId = null;
let curChar = null;
let allChars = [];
// 续写指令（v1.21.54 提到模块级）：以前这串字面量写死在 apiMsgs 里，
// 现在拼装前要先估它的 token，两处必须用同一份，不能再各写一遍。
const CONT_NUDGE = '（继续往下写，接着上一段，不要重复已经写过的内容）';
// 上一轮请求的估算用量（含固定段），设置页拿它显示「现在占了多少」。
let lastPromptTokens = 0;

let pendingImages = [];
let pendingNotes = [];   // 和 pendingImages 一一对应，每张图自己的说明
let abortCtl = null;
let busy = false;
let _pickingImages = false;   // 正在读文件/压缩图片，这期间不要再叠一批，也别让发送抢跑
let editingId = null;
let editingAvatar = null;
let editPresetKey = null;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(msg, ms = 2200) {
  const t = $('toast');
  t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), ms);
}

/** 自定义确认弹窗（比原生 confirm 好看，也能带点排版） */
function confirmBox(title, html, okLabel = '确定') {
  return new Promise(resolve => {
    const m = $('modal');
    $('modal-title').textContent = title;
    $('modal-text').innerHTML = html;
    $('modal-ok').textContent = okLabel;
    m.classList.remove('hidden');
    const done = (v) => {
      m.classList.add('hidden');
      $('modal-ok').onclick = null;
      $('modal-cancel').onclick = null;
      resolve(v);
    };
    $('modal-ok').onclick = () => done(true);
    $('modal-cancel').onclick = () => done(false);
  });
}

// ================= 剧情时间 =================
// 真实世界的时间对聊天没用（用户是在演剧情）。所以这里维护一条"剧情时间线"，
// 由用户写的内容自动推进、也可以点时间条手动改，然后作为 system 注入给模型。

/**
 * 剧情天数的上限（v1.21.42）。
 *
 * 原来硬编码 9999（≈27 年）—— 想做"千百年"尺度的故事会被顶住，
 * 而且顶住的方式很糟：输入框照样接受更大的数，但 setDay 会把它【悄悄夹回 9999】，
 * 界面上完全看不出发生过截断。
 *
 * 现在放宽到 9999999（≈27,397 年）。配套一共四处，少改一处就出问题：
 *   · setDay / oninput 两处钳制（这里）
 *   · index.html 输入框的 max 属性
 *   · CSS 输入框宽度 —— 62px 只装得下 5 位数，7 位会显示不全
 *   · 记忆的「N 天之后不再记着」上限 —— ⚠️ 这个最隐蔽：
 *     不改的话它的最大值仍是 9999，而剧情时间一旦超过 9999，
 *     新建记忆的到期日【最大只能填 9999 < 当前天数】→ 一建就判过期。
 */
const DAY_MAX = 9999999;

const CLOCK_PHASES = [
  { k: 'dawn', label: '凌晨' },
  { k: 'morning', label: '早上' },
  { k: 'forenoon', label: '上午' },
  { k: 'noon', label: '中午' },
  { k: 'afternoon', label: '下午' },
  { k: 'evening', label: '傍晚' },
  { k: 'night', label: '晚上' },
  { k: 'lateNight', label: '深夜' },
];

const SEASONS = [
  { k: 'spring', label: '春' }, { k: 'summer', label: '夏' },
  { k: 'autumn', label: '秋' }, { k: 'winter', label: '冬' },
];

const WEATHERS = [
  { k: 'clear', label: '晴' }, { k: 'cloudy', label: '多云' },
  { k: 'overcast', label: '阴' }, { k: 'rain', label: '雨' },
  { k: 'storm', label: '雷雨' }, { k: 'snow', label: '雪' },
  { k: 'wind', label: '风' }, { k: 'fog', label: '雾' },
];

// hour / minute：精度到具体几点。只有开了「时间细化」才有意义，
// 关着的时候它们不显示、也不参与任何判断。
let clockState = { day: 1, phase: 'morning', season: 'spring', weather: 'clear', locked: false, hour: null, minute: 0 };
let clockDraft = null;

/** 带小时范围的完整写法，只用在注入给模型的文本里 */
/**
 * 把当前的剧情时间拍一张快照，存进消息里。
 * 消息显示的就是这个（不是真实时钟）—— 翻记录时看到的是"故事里的时间"。
 * 老消息没有这个字段，就什么都不显示。
 */
function storyStamp(c = clockState) {
  // ⚠️ 现实模式下【忽略传入的 c】，永远用算出来的真实时间（v1.20.21）。
  //
  // 这一条就把「重新思考 / 编辑重发 / 从这里重聊」三个操作全解决了：
  // 它们本来会拿旧的 m.story 当时间戳退回（clockState = {...clockState, ...m.story}），
  // 而这里不再认那个值 —— 角标一律变现实时间（约定的 A）。
  const src2 = isRealClock() ? realNow() : c;
  return { day: src2.day, phase: src2.phase, season: src2.season, weather: src2.weather,
           hour: typeof src2.hour === 'number' ? src2.hour : null,
           minute: typeof src2.minute === 'number' ? src2.minute : 0 };
}

// ⚠️ DAYS_PER_YEAR 和 dayLabel 现在住在 persona.js（v1.21.43）。
//
// 起因：锚点表（也在 persona.js）用的是原始天数，而"现在的时间"那段用的是 dayLabel，
// 同一个日子在【同一份 prompt 里】出现两种写法。要让它俩对得上，
// 换算函数必须两边都能拿到 —— 放 persona.js 导出最自然（那里本来就是管提示词文案的），
// app.js 这边 import 进来给界面用。
//
// 不这么做的后果我在自查时看到了：prompt 一边说「第 1001 年 250 天」、
// 一边说「现在是第 365250 天」，模型得自己猜这是不是同一天。

/**
 * 年 + 年内的第几天 → 绝对天数（v1.21.45）。
 *
 * 编辑器的「第 __ 年 __ 天」两个框合起来就是这一个公式，没有分支：
 *   第 3 年 100 天 → 830 天   （日 ≤ 365，直接落在该年内）
 *   第 1 年 400 天 → 400 天   （日 > 365，多出来的折进年 → 回显「第 2 年 35 天」）
 *
 * 上限仍是 DAY_MAX（日填满 7 位数时会顶到它）。
 */
function dayFromParts(year, dayOfYear) {
  const y = Math.max(1, Math.floor(Number(year) || 1));
  const d = Math.max(1, Math.floor(Number(dayOfYear) || 1));
  return Math.min(DAY_MAX, (y - 1) * DAYS_PER_YEAR + d);
}

/** 绝对天数 → { year, day } 两个分量。dayLabel 的逆运算，用来回填编辑器的两个框。 */
function partsFromDay(n) {
  const v = Math.min(DAY_MAX, Math.max(1, Math.floor(Number(n) || 1)));
  return {
    year: Math.floor((v - 1) / DAYS_PER_YEAR) + 1,
    day: ((v - 1) % DAYS_PER_YEAR) + 1
  };
}

/**
 * 把 clockDraft.day 写回编辑器的两个输入框。
 *
 * 每个改 day 的入口都必须调它 —— 两个框永远指向同一个 draft.day。
 * 漏掉一处就是"两套数并存"，那正是这次要修掉的东西。
 */
function syncClockInputs() {
  if (!clockDraft) return;
  const p = partsFromDay(clockDraft.day);
  const ye = $('clock-year'); if (ye) ye.value = p.year;
  const de = $('clock-day');  if (de) de.value = p.day;
}

/** 消息右下角显示什么：第 x 天 时段 [时:分] */
function fmtStory(s) {
  if (!s) return '';
  const ph = (CLOCK_PHASES.find(p => p.k === s.phase) || {}).label || '';
  const t = (S.clockDetail && typeof s.hour === 'number')
    ? ' ' + String(s.hour).padStart(2, '0') + ':' + String(s.minute || 0).padStart(2, '0')
    : '';
  return dayLabel(s.day) + (ph ? ' ' + ph : '') + t;
}

/** 把 hour/minute 格式化成 "14:05"；没设小时就返回空 */
function hhmm(c) {
  if (typeof c?.hour !== 'number') return '';
  return String(c.hour).padStart(2, '0') + ':' + String(c.minute || 0).padStart(2, '0');
}

function clockFull(c) {
  const ph = (CLOCK_PHASES.find(p => p.k === c.phase) || CLOCK_PHASES[1]).label;
  const [a, b] = rangeOf(c.phase);
  const t = hhmm(c);
  // 开了细化就用具体时刻，否则还是"时段（几点到几点）"
  const phFull = (S.clockDetail && t)
    ? `${ph} ${t}`
    : `${ph}（${a}:00-${b === 24 ? 24 : b}:00）`;
  const se = (SEASONS.find(s => s.k === c.season) || {}).label;
  const we = (WEATHERS.find(w => w.k === c.weather) || {}).label;
  return [se, dayLabel(c.day), phFull, we].filter(Boolean).join(' · ');
}

function clockLabel(c) {
  const ph = (CLOCK_PHASES.find(p => p.k === c.phase) || CLOCK_PHASES[1]).label;
  const se = (SEASONS.find(s => s.k === c.season) || {}).label;
  const we = (WEATHERS.find(w => w.k === c.weather) || {}).label;
  const t = S.clockDetail ? hhmm(c) : '';
  const phShow = t ? ph + ' ' + t : ph;
  // 从大到小：季节 → 天 → 时段（+时刻）→ 天气
  return [se, dayLabel(c.day), phShow, we].filter(Boolean).join(' · ');
}

/** 没有任何记录时，拿真实钟点猜个起始时段，比一律"早上"自然些 */
function phaseFromNow() {
  const h = new Date().getHours();
  if (h < 5) return 'dawn';
  if (h < 9) return 'morning';
  if (h < 11) return 'forenoon';
  if (h < 13) return 'noon';
  if (h < 17) return 'afternoon';
  if (h < 19) return 'evening';
  if (h < 23) return 'night';
  return 'lateNight';
}

function seasonFromNow() {
  const m = new Date().getMonth() + 1;
  if (m >= 3 && m <= 5) return 'spring';
  if (m >= 6 && m <= 8) return 'summer';
  if (m >= 9 && m <= 11) return 'autumn';
  return 'winter';
}

/**
 * 时间是否跟现实走（v1.20.21）。
 *
 * 三层判定，优先级从高到低：
 *   1. 角色的 clockPolicy（'on' / 'off'）—— 单独角色强制
 *   2. 全局 S.clockMode
 * 全局或角色级任一开着就走现实时间。
 *
 * ⚠️ 老数据里这两个键都不存在 → 判定为 false → 行为和以前一字不差。
 */
function isRealClock() {
  const pol = curChar && curChar.clockPolicy;
  if (pol === 'on') return true;
  if (pol === 'off') return false;
  return S.clockMode === true;
}

/** 按真实钟点算时段（原来叫 phaseFromNow，现在允许传时间戳） */
function phaseFromDate(d) {
  const h = d.getHours();
  if (h < 5) return 'dawn';
  if (h < 9) return 'morning';
  if (h < 11) return 'forenoon';
  if (h < 13) return 'noon';
  if (h < 17) return 'afternoon';
  if (h < 19) return 'evening';
  if (h < 23) return 'night';
  return 'lateNight';
}

/** 按真实月份算季节 */
function seasonFromDate(d) {
  const m = d.getMonth() + 1;
  if (m >= 3 && m <= 5) return 'spring';
  if (m >= 6 && m <= 8) return 'summer';
  if (m >= 9 && m <= 11) return 'autumn';
  return 'winter';
}

/**
 * 现实时间模式下的「现在」。纯计算，不写库。
 *
 * 第几天怎么来（v1.20.21，按约定的规则）：
 *   · 开启的那一刻把 (day=1, ts=当时) 存进 kv: clock:<charId>:real
 *   · 之后每次只算「经过了多少个自然日」→ day = 1 + 天数差
 *   · 【不补关闭期】—— 关掉期间不累计，再开时从冻结的 day 原地继续
 *   · 首次开启（没有存档）→ 第 1 天
 *
 * 时段 / 时:分 / 季节直接读手机当前时间。
 */
function realNow() {
  const now = new Date();
  const base = clockReal || { day: 1, ts: now.getTime() };
  const elapsedDays = Math.floor((now.getTime() - base.ts) / 86400000);
  return {
    day: Math.max(1, (base.day || 1) + Math.max(0, elapsedDays)),
    phase: phaseFromDate(now),
    season: seasonFromDate(now),
    // ⚠️ 天气【不能用 clockState.weather】（v1.21.24 修，审计第 9 条）。
    //
    // 那是手动模式残留的值。现实模式下季节/时段/钟点都读手机真实时间，
    // 唯独天气读残留值 → 会出现「秋 · 第 3 天 · 晚上 · 雪」这种自相矛盾的时间条，
    // 而且会原样注入提示词。实测证据就是这一行输出。
    //
    // 现实模式本来就无法得知天气，写死 clear 最诚实（UI 那边也不显示天气）。
    weather: 'clear',
    locked: false,
    hour: now.getHours(),
    minute: now.getMinutes(),
  };
}

// 现实模式的存档位：{ day, ts }。跟 clockState 分开存 ——
// 关掉再开时要接着走，就不能让手动调整污染它。
let clockReal = null;

async function loadClock(charId) {
  const saved = await kv.get('clock:' + charId, null);
  // 现实模式的存档位（v1.20.21）。和 clockState 分开放：
  // 手动调整绝不能污染它，否则关掉再开就接不上了。
  clockReal = await kv.get('clock:' + charId + ':real', null);
  // 旧数据里没有季节/天气，靠展开顺序兜底，不会把已有的值冲掉
  clockState = {
    day: 1, phase: phaseFromNow(), season: seasonFromNow(), weather: 'clear', locked: false,
    ...(saved || {}),
  };
  // 首次进这个角色、且是现实模式 → 现在就开一个存档位（第 1 天）
  if (isRealClock() && !clockReal) await startRealClock();
  if (isRealClock()) clockState = { ...clockState, ...realNow() };
  renderClock();
}

/**
 * 开启现实模式：开一个新存档位（第 1 天 = 此刻）。
 *
 * 约定的规则：从关到开，时间【从第一天默认时间重新开始】——
 * 第一次开、以及每次从时钟模式切回现实模式时都会走这里。
 */
/**
 * 开启现实模式：给指定角色开一个全新的存档位（第 1 天 = 此刻）。
 *
 * 约定的规则：从关到开，时间从第一天默认时间重新开始。
 *
 * @param only 只重置这一个角色；不传 = 当前角色
 * @param all  重置【所有跟随全局的角色】
 *
 * ⚠️ 「跟随全局」是重点（2026-09-29 自查发现）：全局开关是给所有角色的，
 *    只重置当前那个的话，切到别的角色会接上很久以前的旧存档位 ——
 *    第几天不是从 1 开始，直接违反规则。
 *    而 clockPolicy 显式设了 'on' / 'off' 的角色【不受全局开关影响】，
 *    不能动它们的存档位。
 */
async function startRealClock(only = undefined, all = false) {
  const now = Date.now();
  const fresh = { day: 1, ts: now };
  if (all) {
    for (const c of await chars.all()) {
      // 只处理「跟着全局走」的角色 —— 显式 'off' 的根本不在现实模式，
      // 显式 'on' 的本来就一直开着，全局开关不该重置它的进度。
      if (c.clockPolicy === 'on' || c.clockPolicy === 'off') continue;
      await kv.set('clock:' + c.id + ':real', fresh);
      if (c.id === curCharId) clockReal = fresh;
    }
    return fresh;
  }
  const id = only || curCharId;
  if (id) await kv.set('clock:' + id + ':real', fresh);
  if (id === curCharId) clockReal = fresh;
  return fresh;
}

async function saveClock() {
  // ⚠️ 现实模式下【不写 clockState】—— 那是个算出来的值，写回去等于把手动时间
  // 偷偷改成真实时间的快照；以后关掉现实模式，用户手动设的时间就没了。
  if (curCharId && !isRealClock()) await kv.set('clock:' + curCharId, clockState);
  renderClock();
}

function renderClock() {
  const el = $('chat-clock');
  if (!el) return;
  // 没有角色时留空（v1.21.60）。以前这里无条件写 clockState ——
  // 而空状态下 clockState 是上一个角色残留的，于是"空聊天页显示着别人的时间"。
  // （showEmptyChat 里那句 el.textContent = '' 也因此是死代码，被这句覆盖掉。）
  if (!curCharId) { el.textContent = ''; el.classList.remove('readonly'); return; }
  const real = isRealClock();
  el.textContent = clockLabel(clockState) + (real ? '　· 跟随手机时间' : '');
  // 现实模式下缩成一行只读小字（v1.20.21，需求「像抽屉那样缩进」）。
  // 保留位置让人看得见现在几点，但不再是可点的大按钮 —— 点了也调不了。
  el.classList.toggle('readonly', real);
  el.title = real ? '正在跟随手机时间，改不了（想手动调就去设置里关掉）' : '点这里调整剧情时间';
  renderSceneBar();   // 场景条和时间条共用这一行，一起刷新（v1.21.47）
}

/**
 * 从他写的内容里判断时间有没有往前走。
 * 只认明确的场景切换（「第二天」「傍晚」这种），拿不准就不动——
 * 宁可让他手动点一下，也别自作主张把日子推错。
 */
function detectClock(text) {
  if (!text) return null;
  // 现实模式下不自动推时间（v1.20.21）：时间归手机管，
  // 她写一句「第二天」不该把真实时钟顶掉。
  if (isRealClock()) return null;
  if (clockState.locked) return null;   // 开了「以我设定的为准」就别自动跟了
  // 优先只看括号里的内容（他习惯在里面写场景），括号里没有才扫全文
  const parens = (text.match(/[（(][^）)]*[）)]/g) || []).join(' ');
  // ⚠️ 括号内外的文字【都要扫】（v1.21.37 修，复审 P1-2）。
  //
  // 起因：原来是 `parens || text` —— 只要文本含任意括号，扫描范围就收窄到括号内，
  // 括号外的推进词被【静默忽略】。
  // 实测对照：「（跟她说）两天后出发。」→ 时间【不动】；「两天后出发。」→ 时间 +2 ✅
  const scan = parens ? (parens + ' ' + text) : text;

  const dayRules = [
    [/第二天|次日|隔天|翌日/, 1],
    [/第三天|两天后/, 2],
    [/几天后|数日后|过了几天/, 3],
    [/一周后|一个星期后|七天/, 7],
    [/一个月后|下个月/, 30],
  ];
  const phRules = [
    [/凌晨|深夜|半夜/, 'lateNight'],
    [/清晨|早上|早晨|一早/, 'morning'],
    [/上午/, 'forenoon'],
    [/中午|正午/, 'noon'],
    [/下午|午后/, 'afternoon'],
    [/傍晚|黄昏|日落/, 'evening'],
    [/晚上|夜里|夜晚|入夜/, 'night'],
  ];

  const seasonRules = [
    [/开春|初春|春天|春日|入春|春季/, 'spring'],
    [/入夏|初夏|夏天|夏日|盛夏|夏季/, 'summer'],
    [/入秋|初秋|秋天|秋日|深秋|秋季|秋风/, 'autumn'],
    [/入冬|初冬|冬天|冬日|严冬|冬季|下雪|飘雪/, 'winter'],
  ];
  // 天气规则。两条教训：
  // 1) 不能留单字（雪/雨/雾/晴）—— 实测「我买了双雪地靴」会被判成下雪，
  //    然后立刻落库、注入给模型，用户还看不出是哪来的。
  // 2) 顺序要按"信息量大的在前"排，同一条里出现多个词时取更具体的那个；
  //    原来「雨」排在「晴」前面，于是「雨停了，放晴」永远判成 rain。
  const weatherRules = [
    [/冰雹/, 'hail'],
    [/暴雨|大雨|雷阵雨|雷雨|打雷|雷声|闪电|电闪/, 'storm'],
    [/雨夹雪|雨雪/, 'sleet'],
    // 只认"天气"词，不收「雪地/雪景」这类名词 —— 它们会被"我买了双雪地靴"这种
    // 普通句子命中。宁可漏判，也别把天气改错。
    [/下雪|飘雪|落雪|大雪|小雪|雪花|积雪|雪天|雪中|雪里/, 'snow'],
    [/起雾|大雾|晨雾|浓雾|雾气|雾蒙蒙|有雾|薄雾/, 'fog'],
    // 「雨停了 / 雨过 / 转晴 / 放晴」这类"后面已转好"的说法，要先于「下雨」判定
    [/雨停|雨过|雨住|放晴|转晴|天晴|晴天|阳光|大太阳|艳阳|晴朗|万里无云/, 'clear'],
    [/小雨|细雨|下雨|雨点|雨声|落雨|阵雨|雨丝|雨里|雨中/, 'rain'],
    [/多云/, 'cloudy'],
    [/阴天|阴沉|乌云|天色发暗|灰蒙蒙/, 'overcast'],
    [/大风|起风|刮风|狂风|风很[大小]|风好大/, 'wind'],
  ];

  let day = clockState.day, phase = clockState.phase;
  let season = clockState.season, weather = clockState.weather;
  let hit = false;
  for (const [re, n] of dayRules) if (re.test(scan)) { day = clockState.day + n; phase = 'morning'; hit = true; break; }
  for (const [re, p] of phRules) if (re.test(scan)) { phase = p; hit = true; break; }
  for (const [re, s] of seasonRules) if (re.test(scan)) { season = s; hit = true; break; }
  for (const [re, w] of weatherRules) if (re.test(scan)) { weather = w; hit = true; break; }
  return hit ? { day, phase, season, weather } : null;
}

/**
 * 判断某条消息是不是【开场白】（v1.21.25 新增，复审 ★6）。
 *
 * 起因：rewind 分支的判据是「是不是第一条」（allNow[0].id === id），
 * 而 regen 分支用的是「只有一条」（allNow.length === 1）—— 两套判据不一致，
 * 同族操作本该一致（那边的注释自己就这么写的）。
 *
 * 只按位置判的话：开场白被归档过、或被删过（老数据）时首位会是别的正常消息，
 * 对它点「从这里重聊」会被误拦。
 *
 * 正确的判据是【身份】：它是第一条 assistant，且它前面没有任何 user 消息。
 */
async function isGreetingMsg(id) {
  // ⚠️ 第三版（v1.21.27 修，复审 新6）。前两版都错，记录在此免得再犯：
  //
  //   v1：`!all.some(x => x.role === 'user')` —— 查【整个列表】，
  //       只要聊过一句就恒 false，护卫完全失效（开场白清空聊天复活）。
  //   v2：`!all.slice(0, idx).some(...)` —— 方向对了，但上一行 `if (idx !== 0) return false`
  //       已经保证能走到这里的 idx 恒为 0，于是 slice 恒为空数组 → **恒真式**，
  //       判据彻底没有信息量。
  //
  // v2 的实测后果（复审复现，走真实 UI）：真开场白被归档后，可见首条变成一条【普通 assistant】；
  //   · 对那条点「重新生成」→ 被当成开场白 → 只走"补时间标签"那条路 → **模型请求 0 次**，
  //     而 toast 还说"开场白的时间已更新"，用户以为重想了其实什么都没发生
  //   · 那条普通消息的 story 被静默改写（数据被悄悄改了，看不出来）
  //   · 对普通消息点「从这里重聊」被"这是开场白"拦死
  //
  // 根因：判据不该依赖【可见列表里的位置】—— 归档会让位置整体前移。
  // 现在用 msgs.list 的第三个参数把归档也取进来，按【消息自身身份】判：
  // 它是 assistant，且它前面没有任何 user 消息。（db.js 的 list 早就支持这个参数。）
  const all = await msgs.list(curCharId, 0, true);   // 含归档
  const idx = all.findIndex(x => x.id === id);
  if (idx < 0) return false;
  if (all[idx].role !== 'assistant') return false;
  return !all.slice(0, idx).some(x => x.role === 'user');
}

function openClockEditor() {
  // 没有角色时时间条不该能点（v1.21.60）：开了也是改空气，
  // 保存那一步会被 saveClock 的守卫挡掉，用户只会觉得"改了没用"。
  if (!curCharId) { toast('还没有角色，先去建一个'); return; }
  // 现实模式下时间条是只读的（需求：关了后手动调的时间条不生效）。
  if (isRealClock()) {
    toast('现在跟随手机时间，手动调不了。想自己定时间先去设置里关掉「时间跟现实走」', 4200);
    return;
  }
  clockDraft = { ...clockState };
  // 两个框都是 draft.day 的显示（v1.21.45）：年 = 落在第几年，日 = 那一年的第几天
  syncClockInputs();
  const segs = (id, list, key) => renderSeg(id, list.map(x => ({ label: x.label, value: x.k })), clockDraft[key], v => { clockDraft[key] = v; });
  $('clock-lock').checked = !!clockDraft.locked;
  $('clock-lock').onchange = e => { clockDraft.locked = e.target.checked; };
  segs('clock-phase', CLOCK_PHASES, 'phase');
  segs('clock-season', SEASONS, 'season');
  segs('clock-weather', WEATHERS, 'weather');
  // 具体时刻那一行只在开了细化时出现
  $('clock-time-row').style.display = S.clockDetail ? '' : 'none';
  $('clock-hour').value = typeof clockDraft.hour === 'number' ? clockDraft.hour : '';
  $('clock-min').value = typeof clockDraft.minute === 'number' ? clockDraft.minute : 0;
  $('clock-modal').classList.remove('hidden');
}

// ⚠️ v1.21.46：原来这两个框下面还有一行「= 第 N 天」的换算提示，需求删掉 ——
//    年+日已经把话说完了，那行是多余的（而且它一占位，加减号就被挤得换行）。
//    连带的代价：日填 400 时框会自己变成「第 2 年 35 天」，没有文字点破。
//    归一化本身仍然发生（那是 day 的唯一来源），只是不再用文字解释。
//    函数本体、DOM 节点、以及下面 4 处调用点（openClockEditor / setDay /
//    clock-day 的 oninput / clock-year 的 oninput）已一并删除，
//    所以 clock-year 框现在没有 oninput —— 中途本来也没什么事要做。

// ===================== 临时场景（v1.21.47）=====================
// 一段「这一段对话发生在哪」的临时说明。刻意【不进人设、不进稳定前缀】：
// 它改得很勤，而稳定前缀一变，它后面所有内容都要重新计费（persona.js 里记着这笔账）。
// 所以它只走 buildTurnNote 的本轮段。
function sceneOf(c) {
  return (c && typeof c.scene === 'string') ? c.scene : '';
}

function renderSceneBar() {
  const el = $('chat-scene');
  if (!el) return;
  const st = sceneOf(curChar).trim();
  el.textContent = st ? ('场景 · ' + (st.length > 8 ? st.slice(0, 8) + '…' : st)) : '场景';
  el.classList.toggle('on', !!st);
  el.title = st ? ('当前场景：' + st) : '点这里给这一段对话设一个场景';
}

/** 弹窗里那行小字：当前环境到底是什么（用户要的"小字提醒当前的环境是什么"） */
function renderSceneCur(st) {
  const el = $('scene-cur');
  if (!el) return;
  const t = String(st || '').trim();
  el.textContent = t ? ('当前场景：' + t) : '当前场景：无（她按人设和上下文自己判断）';
}

function openSceneEditor() {
  const box = $('scene-text');
  if (!box) return;
  if (!curCharId) { toast('还没有角色，先去建一个'); return; }
  const st = sceneOf(curChar);
  box.value = st;
  renderSceneCur(st);
  $('scene-modal').classList.remove('hidden');
  setTimeout(() => box.focus(), 30);
}

/** 存进角色自己身上：换角色各有一套，关掉 App 再回来还在 */
async function saveScene(v) {
  if (!curCharId) { toast('先选一个角色'); return false; }
  const c = await chars.get(curCharId);
  if (!c) return false;
  const t = String(v || '').trim();
  if (t) c.scene = t; else delete c.scene;
  await chars.put(c);
  if (curChar) { if (t) curChar.scene = t; else delete curChar.scene; }
  renderSceneBar();
  return true;
}

// ============ 「他的设定 / 他的居处」：角色级 + 覆盖给别人（v1.21.47）============
/**
 * 这两项原来在 ⚙ 里、全局共用一份（键名 myProfile / myEnv，
 * 现在只剩"新角色的初始值"这一个身份）。搬进角色后每个角色一份，
 * 于是就有了"把这一份推给别人"的需求 —— 见 openPickChars。
 */
function refreshEditMineBrief() {
  const pv = ($('e-mine') ? $('e-mine').value : '') || '';
  const hv = ($('e-home') ? $('e-home').value : '') || '';
  const p = pv.trim(), h = hv.trim();
  const mc = $('e-mine-count'); if (mc) mc.textContent = p ? ('共 ' + pv.length + ' 字') : '（空的）';
  const hc = $('e-home-count'); if (hc) hc.textContent = h ? ('共 ' + hv.length + ' 字') : '（空的）';
  const mb = $('e-mine-brief');
  if (mb) mb.textContent = p ? (p.split('\n').filter(x => x.trim()).length + ' 行') : '未填';
  const hb = $('e-home-brief');
  if (hb) hb.textContent = h ? '已填' : '未填';
}

// ============ 长文本编辑弹窗（v1.21.58）============
/**
 * 人设 / 开场白这类"一写就是几百字"的字段，原来直接把 textarea 铺在角色编辑页上
 * （一个 14 行、一个 3 行），想看下面的参数得先划过它们。现在页面上只剩一行入口。
 *
 * ⚠️ 值最终写回【页面上那个隐藏的原 textarea】（o.srcId），不是存在弹窗里 ——
 * saveCharEdit() 读的还是 $('e-persona').value，那条链路一行都没改。
 * 「取消」= 不写回，所以天然就是"改了不算数"。
 */
let _txtSrcId = null;

function openTextEditor(o) {
  const src = $(o.srcId);
  if (!src) return;
  _txtSrcId = o.srcId;
  $('txt-title').textContent = o.title || '编辑';
  const hint = $('txt-hint');
  if (hint) {
    hint.textContent = o.hint || '';
    hint.style.display = o.hint ? '' : 'none';
  }
  const box = $('txt-input');
  box.value = src.value || '';
  box.placeholder = o.placeholder || src.placeholder || '';
  updateTxtCount();
  $('txt-modal').classList.remove('hidden');
  // 光标放到末尾：这类框十有八九是接着上次往下写
  setTimeout(() => { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }, 60);
}

function closeTextEditor() {
  _txtSrcId = null;
  $('txt-modal').classList.add('hidden');
}

function updateTxtCount() {
  const b = $('txt-input'), c = $('txt-count');
  if (b && c) c.textContent = b.value.trim() ? ('共 ' + b.value.length + ' 字') : '（空的）';
}

/** 入口行右边那个角标：不点开也知道里面写了多少 */
function refreshCharTextBriefs() {
  const g = $('e-greeting'), p = $('e-persona');
  const gb = $('e-greeting-brief'), pb = $('e-persona-brief');
  if (gb) gb.textContent = (g && g.value.trim()) ? (g.value.length + ' 字') : '未填';
  if (pb) pb.textContent = (p && p.value.trim()) ? (p.value.length + ' 字') : '未填';
}

let _pickCharsCtx = null;
function refreshPickCount() {
  const boxes = [...document.querySelectorAll('#pick-chars-list input[type=checkbox]')];
  const el = $('pick-chars-count');
  if (el) el.textContent = '已选 ' + boxes.filter(b => b.checked).length + ' / ' + boxes.length;
}

/**
 * 把当前这一份覆盖到勾选的角色上。
 * ⚠️ 是【复制快照】不是引用：覆盖完源角色再改，被覆盖的那些不会跟着变 ——
 *    用户要的是"覆盖"，这就是符合直觉的那个语义。
 */
function openPickChars(field, label, text) {
  const others = allChars.filter(c => c.id !== editingId);
  if (!others.length) { toast('还没有别的角色'); return; }
  _pickCharsCtx = { field, label, text };
  $('pick-chars-title').textContent = '把「' + label + '」应用到其他角色';
  $('pick-chars-sub').innerHTML = '勾上的会被<b>这一份整段替掉</b>，没勾的不动。<br>'
    + '覆盖之后两边就各是各的了 —— 你再改这一个，他们的不会跟着变。';
  $('pick-chars-list').innerHTML = others.map(c => {
    const cur = field === 'myProfile' ? (c.myProfile || '') : (c.myEnv || '');
    const sub = String(cur).trim() ? ('已有 ' + String(cur).trim().length + ' 字') : '还没有';
    return '<label><input type="checkbox" data-id="' + esc(c.id) + '" checked>'
      + '<span class="nm">' + esc(c.name || '未命名') + '</span>'
      + '<span class="sub">' + sub + '</span></label>';
  }).join('');
  refreshPickCount();
  $('pick-chars-modal').classList.remove('hidden');
}

function bindClockEditor() {
  $('chat-clock').onclick = openClockEditor;
  // —— 临时场景 ——
  $('chat-scene').onclick = openSceneEditor;
  $('scene-save').onclick = async () => {
    const ok = await saveScene($('scene-text').value);
    if (!ok) return;
    $('scene-modal').classList.add('hidden');
    toast('场景已应用，下一条回复生效');
  };
  // 「清除」只清输入框、不直接落库 —— 免得手一抖把写好的一段场景冲掉；
  // 想真的清掉就再看一眼点「保存并应用」（内容是空的 = 删掉场景）。
  $('scene-clear').onclick = () => {
    $('scene-text').value = '';
    renderSceneCur('');
    toast('输入框已清空；点「保存并应用」才会真的清掉场景', 3400);
  };
  // ⚠️ 下面每个 handler 都要判 clockDraft 非空（v1.21.42 补齐）。
  //
  // 起因：现实模式下 openClockEditor 会【提前 return】，clockDraft 保持 null
  // （这是有意的：那种模式下时间由手机决定，不许手改）。但这些 handler 是
  // 无条件绑在 DOM 上的 —— 只要被触发，就会撞 "Cannot set properties of null"。
  //
  // ⚠️ 这个坑【去年就发现过】：clock-ok 的 handler 里早就加了护栏，注释也写明了
  //    后果（clockState = {...null} = {} 会把整个时间状态清空）。
  //    但同一函数里其余 6 个 handler 全漏了 —— 典型的"修一处漏六处"。
  //    正常用户碰不到（模态框 hidden 时不可聚焦），但误触 / 脚本 / 将来的 UI 改动
  //    都会踩到，而且抛出的异常会打断整个事件处理。
  const setDay = (v) => {
    if (!clockDraft) return;
    clockDraft.day = Math.min(DAY_MAX, Math.max(1, Math.floor(v) || 1));
    syncClockInputs();   // 两个框一起回写，永远指向同一个 draft.day
  };
  // 把（年，日）两个框合成一个 day 落地。只在失焦 / 回车时调 —— 输入中途不折腾用户。
  const commitParts = () => {
    if (!clockDraft) return;
    setDay(dayFromParts($('clock-year').value, $('clock-day').value));
  };
  $('clock-day-minus').onclick = () => { if (clockDraft) setDay(clockDraft.day - 1); };
  $('clock-day-plus').onclick = () => { if (clockDraft) setDay(clockDraft.day + 1); };

  // —— 两个框都是 draft.day 的写法（v1.21.45）——
  // ⚠️ 每个 handler 都要判 clockDraft（现实模式下 openClockEditor 提前 return 时它是 null）
  //
  // 输入【中途】只更新 draft.day、不做归一化：否则想输 1000，刚敲下 1
  // 日就被重排成下一年的第几天了。归一化推迟到失焦 / 回车（commitParts）。
  $('clock-day').oninput = e => {
    if (!clockDraft) return;
    const v = Number(e.target.value);
    if (e.target.value !== '' && isFinite(v) && v >= 1) {
      clockDraft.day = dayFromParts($('clock-year').value, v);
    }
  };
  $('clock-day').onblur = commitParts;
  // 年框没有 oninput：输入中途什么都不做（不归一化、也没有提示要刷）。
  // 归一化只由下面的 change / blur 触发。
  $('clock-year').onchange = commitParts;
  $('clock-year').onblur = commitParts;
  $('clock-hour').oninput = e => {
    if (!clockDraft) return;
    const v = Number(e.target.value);
    clockDraft.hour = (e.target.value === '' || !isFinite(v)) ? null : Math.min(23, Math.max(0, Math.floor(v)));
    // 时段跟着小时走，免得出现"晚上 14:20"这种自相矛盾的显示。
    // 用户之后还是可以手动点时段把它改回去。
    if (typeof clockDraft.hour === 'number') {
      clockDraft.phase = phaseFromHour(clockDraft.hour);
      // 注意：不能调 openClockEditor 里那个局部函数 segs（作用域外）。
      // 这里直接用 renderSeg 重画时段那一排。
      renderSeg('clock-phase', CLOCK_PHASES.map(x => ({ label: x.label, value: x.k })),
                clockDraft.phase, v => { clockDraft.phase = v; });
    }
  };
  $('clock-min').oninput = e => {
    if (!clockDraft) return;
    const v = Number(e.target.value);
    clockDraft.minute = (e.target.value === '' || !isFinite(v)) ? 0 : Math.min(59, Math.max(0, Math.floor(v)));
  };
  // 懒得填就按当前时段的起始钟点填一个
  $('clock-now-set').onclick = () => {
    if (!clockDraft) return;
    const [a] = rangeOf(clockDraft.phase);
    clockDraft.hour = a;
    clockDraft.minute = 0;
    $('clock-hour').value = a;
    $('clock-min').value = 0;
  };
  $('clock-cancel').onclick = () => $('clock-modal').classList.add('hidden');
  $('clock-ok').onclick = async () => {
    // ⚠️ 护栏（2026-09-29 自查发现）：clockDraft 为 null 时【绝不能】赋值。
    //
    // 起因：现实模式下 openClockEditor 会提前 return，clockDraft 保持 null；
    // 而「确定」按钮的绑定是无条件挂上的 —— 一旦被点到（测试里点了，
    // 用户误触也一样），clockState = {...null} = {} 就把整个时间状态清空了：
    // 界面变成「第 undefined 天」，再往下写 hour 就是
    // Cannot set properties of null。
    if (!clockDraft) { $('clock-modal').classList.add('hidden'); return; }
    clockState = { ...clockDraft };
    $('clock-modal').classList.add('hidden');
    await saveClock();
    toast('时间已设为 ' + clockLabel(clockState));
  };
}

// ================= 视图切换（带返回栈）=================
// 栈底永远是 chat（主界面）。别的界面都是压进去的，返回就弹出来；
// 弹到只剩 chat 之后再按返回，才算退出软件。
let _stack = ['chat'];

/**
 * 只改类，位置交给 CSS 过渡：
 *   栈顶 → active（回到 0）
 *   栈里其余 → behind（停在 -28%）
 *   不在栈里 → 默认（滑到 100% 屏幕外）
 * 前进和返回因此都是两页同时在动，不需要分方向。
 */
function _renderView(name) {
  const target = $('view-' + name);
  // 抽屉 = 从侧边拉出来、下层页面【原地不动】的那种。
  // side-left（角色列表）和 side-right（设置抽屉）都算 —— 只认 side-left 的话，
  // 右侧抽屉会把聊天页一起推走，就不是"拉出来"的手感了。
  const isDrawer = !!(target && (target.classList.contains('side-left')
                                 || target.classList.contains('side-right')));
  document.querySelectorAll('.view').forEach(v => {
    const vn = v.id.slice(5);
    const isTop = vn === name;
    const inStack = _stack.includes(vn);
    v.classList.toggle('active', isTop);
    // 抽屉推入时，下面的页面原地不动（stay）；普通推入时才向左让位（behind）
    v.classList.toggle('stay', !isTop && inStack && isDrawer);
    v.classList.toggle('behind', !isTop && inStack && !isDrawer);
  });
}

/** 进一个界面（压栈） */
function showView(name) {
  if (_stack[_stack.length - 1] !== name) _stack.push(name);
  _renderView(name);
}

/** 把栈清成只剩它（选完角色 / 存完角色回主界面时用） */
function resetTo(name) {
  _stack = [name];
  _renderView(name, 'back');   // 回主界面，视觉上当退回来处理
}

/** 返回上一层。返回 false = 已经到栈底，该退出软件了 */
function goBack() {
  if (_stack.length <= 1) return false;
  _stack.pop();
  _renderView(_stack[_stack.length - 1], 'back');
  return true;
}

// ================= 设置 =================
async function loadSettings() {
  // 一次读出来，顺便记下「这个键到底存不存在」。
  // 判据用键本身而不是「有没有某个字段」—— 老数据的字段可能被清成空串，
  // 那种判法会误判成新装，把用户手动设的时间顶掉。
  // loadSettings 是启动第一步，跑过一次就一定会写库，所以「键不存在」＝全新安装。
  const rawSaved = await kv.get('settings', null);
  const isFreshInstall = rawSaved === null;
  const saved = rawSaved || {};
  S = { ...DEFAULTS, ...saved };

  // 「时间跟现实走」的默认值迁移（v1.20.21）。
  //
  // 约定：新装默认【开】，更新安装【继承旧行为】（即关）。
  //
  // 判据用 isFreshInstall 而不是「saved 里有没有 clockMode」——
  // 因为合并之后 S 里永远有这个键，分不出值是默认带来的还是用户设过的。
  // 这里看的是原始 saved：老数据里根本没有这个键，那就是升级来的。
  if (saved.clockMode === undefined && !isFreshInstall) {
    S.clockMode = false;
    await kv.set('settings', S);   // 写回库，否则导出备份里还是默认值
  }
  // 全新安装：把默认值落一次库。
  // 不写的话 settings 这个键一直是空的 —— 导出备份里没有它，
  // 恢复备份时又会被判成「全新安装」，行为对不上。
  if (isFreshInstall) await kv.set('settings', S);
  // 旧版的「全局统一」开关已废弃（改成角色编辑里的「覆盖全局设定」）。
  // 强制关掉：否则旧数据里还开着它，会让所有角色都用全局参数、忽略各自设置。
  S.globalOverride = false;
  // ⚠️ 顺手写回库（v1.21.52）：上面那句只改内存，库里（以及导出的备份里）
  // 一直是 true —— 别人拿这份备份导入，就会踩上面 NO_IMPORT_SETTINGS 里说的那个坑。
  try { if (saved.globalOverride !== false) await kv.set('settings', S); } catch { /* 写不进去也只是下次再关一遍 */ }

  // ⚠️ v1.21.40 删掉了这里的「预置 searchKey 迁移」。
  //
  // 它原本做的是：settings 里 searchKey 为空时，把 DEFAULTS.searchKey 补进去
  // （v1.20.13 起 DEFAULTS 里写死了一把真 Key，而老数据的空串会盖掉预置值）。
  // 现在 DEFAULTS.searchKey 本身是空串，这段补进去还是空 —— 成了永远不生效的死代码。
  //
  // 老用户不会因此丢 Key：他们 settings 里存的是自己填过的值，
  // {...DEFAULTS, ...saved} 会原样继承，跟 apiKey 一个道理。
}

async function saveSettings(patch) {
  S = { ...S, ...patch };
  await kv.set('settings', S);
}

function applyTheme() {
  let t = S.theme;
  if (t === 'system') {
    t = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  document.documentElement.setAttribute('data-theme', t);
  document.documentElement.style.setProperty('--fs', S.fontSize + 'px');
}

// ================= 角色 =================
async function loadChars() {
  allChars = await chars.all();
  allChars.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

function avatarHtml(c, cls = 'avatar-sm') {
  if (c && c.avatar) return `<span class="${cls}"><img src="${esc(c.avatar)}" alt=""></span>`;
  const p = PRESETS.find(p => p.key === c?.presetKey);
  return `<span class="${cls}">${p ? p.emoji : '🙂'}</span>`;
}

/**
 * 世界书孤儿自检（v1.21.36 新增，复审 #5）。
 *
 * 起因：真实备份里存在 charId=mu1di16jq12tqq1 的 solo（角色已删），
 * 而 openSoloPicker() 只列 allChars → 那个 charId 在列表里【0/1 可触达】，
 * 既打不开也删不掉；组里的幽灵成员同理。全 UI 无任何清理入口。
 *
 * 对照：孤儿【记忆】有 __orphan__ 出口，孤儿【世界书】没有。
 * 这里做静默自检：只清真正孤儿（本机角色表里没有的 id），不动别的。
 */
async function sweepWbOrphans() {
  try {
    const live = new Set((await chars.all()).map(c => c.id));
    // 1) 组里的幽灵成员
    for (const g of await wb.groups()) {
      const mem = (g.members || []);
      const kept = mem.filter(id => live.has(id));
      if (kept.length !== mem.length) {
        try { await wb.putGroup({ ...g, members: kept }); } catch { /* 单个组失败不影响其他 */ }
      }
    }
    // 2) solo 整条孤儿
    const solos = await wb.soloAll();
    for (const s of solos) {
      if (s && s.charId && !live.has(s.charId)) {
        try {
          // db.js 的 purgeChar 是按 charId 清，正好复用
          await wb.purgeChar(s.charId);
        } catch { /* 同上 */ }
      }
    }
  } catch { /* 自检失败绝不该挡住启动 */ }
}

/**
 * 一次性迁移（v1.21.47）：「他的设定 / 他的居处」从全局搬到角色级。
 *
 * 为什么要迁：老用户可能已经把全局那份改成自己的内容。不搬的话，升级后
 * 每个角色的「关于对方」会突然变回默认——数据没丢，但行为突变，
 * 用户看到的就是"我写的东西没了"。所以第一次启动把当时那份快照给还没设过的角色。
 *
 * 只做一次（mkProfileMigrated 标记）。迁完之后，全局那两个键就只剩
 * "新建角色的初始值"这一个身份，界面上不再有入口。
 */
async function migrateGlobalProfileToChars() {
  if (S.mkProfileMigrated) return;
  const gp = typeof S.myProfile === 'string' ? S.myProfile : '';
  const ge = typeof S.myEnv === 'string' ? S.myEnv : '';
  let n = 0;
  for (const c of allChars) {
    const patch = {};
    if (c.myProfile === undefined) patch.myProfile = gp;
    if (c.myEnv === undefined) patch.myEnv = ge;
    if (!Object.keys(patch).length) continue;
    // 单个角色写失败不该挡住启动
    try { await chars.put({ ...c, ...patch }); Object.assign(c, patch); n++; } catch { /* 跳过 */ }
  }
  try { await saveSettings({ mkProfileMigrated: true }); } catch { /* 同上 */ }
  if (n) console.log('[迁移 v1.21.47] 「他的设定 / 他的居处」已复制给 ' + n + ' 个角色');
}

async function ensureChar() {
  // 启动时顺手扫一次孤儿世界书（失败无所谓）。
  await sweepWbOrphans();
  await migrateGlobalProfileToChars();
  if (allChars.length) {
    // 回到上次离开时用的那个角色；她要是被删了，就退回第一个
    const last = await kv.get('lastCharId', null);
    const pick = allChars.find(c => c.id === last) || allChars[0];
    await selectChar(pick.id);
    return;
  }
  // 一个角色都没有：留空，不替用户建。
  // 以前这里会自动塞一个"空白角色"，刚装完的人一进来就看见一个自己没建过的东西。
  await showEmptyChat();
}

/**
 * 一个角色都没有时的样子。
 *
 * 聊天页是按"有个人在"设计的（头像、名字、时间条），空的时候要自己把这几处摆平，
 * 不能留着上一个人的残留。
 */
async function showEmptyChat() {
  curCharId = null;
  curChar = null;
  const nm = $('chat-name'); if (nm) nm.textContent = '还没有角色';
  const av = $('chat-avatar'); if (av) av.textContent = '🎎';
  const bar = $('chat-clock'); if (bar) bar.textContent = '';
  const box = $('messages');
  if (box) {
    box.innerHTML = '<div class="empty-chat">还没有角色。<br>'
      + '点左上角 ☰ → 角色列表 → 右下角 ＋ 建一个。</div>';
  }
  await renderClock();
}

async function selectChar(id) {
  // 生成中途切角色：先把在途请求停掉。否则它会拿着旧角色的上下文跑完，
  // 回来时把回复插进新角色的聊天里（落库已按发送时的角色修正，这里只是
  // 别让它在后台白跑）。
  if (busy && abortCtl && id !== curCharId) {
    try { abortCtl.abort(); } catch { /* 已经结束了 */ }
  }
  curCharId = id;
  curChar = await chars.get(id);
  if (!curChar) { await ensureChar(); return; }
  await kv.set('lastCharId', id);   // 记下来，下次打开还回到她这儿
  await loadClock(id);             // 每个角色的剧情时间各走各的
  $('chat-name').textContent = curChar.name || '未命名';
  const av = $('chat-avatar');
  if (curChar.avatar) {
    av.innerHTML = `<img src="${esc(curChar.avatar)}" alt="">`;
  } else {
    const p = PRESETS.find(p => p.key === curChar.presetKey);
    av.textContent = p ? p.emoji : '🙂';
  }
  await renderMessages();
  updateStatus();
}

function updateStatus() {
  const ok = !!S.apiKey;
  // 接的不止一家了，状态栏把服务商也写出来（否则换了家只在设置页看得见）
  $('chat-status').textContent = ok ? `${providerSpec(S.provider).label} · ${S.model}` : '未配置 API Key';
  // 引导条跟着 Key 走：填了就收起来（v1.21.40）。
  // 判断放在这里而不是启动时判一次 —— 设置页改完 Key 会回调 updateStatus（见 bindSettings），
  // 一处判断两处生效。
  $('setup-banner')?.classList.toggle('hidden', ok);
}

// ================= 渲染消息 =================
function fmtTime(ts) {
  const d = new Date(ts);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

function msgHtml(m) {
  const isMe = m.role === 'user';
  // 她那条的头像带 av-her 类 —— 长按它可以进她的编辑页（见 attachMsgActions）
  const av = isMe
    ? (S.myAvatar ? `<span class="av"><img src="${esc(S.myAvatar)}" alt=""></span>` : '<span class="av">🧑</span>')
    : avatarHtml(curChar, 'av av-her');
  let inner = '';
  if (m.images && m.images.length) {
    inner += m.images.map((i, idx) => {
      const note = (m.imageNotes && m.imageNotes[idx]) || '';
      return `<img class="pic" src="${esc(i)}" alt="">` + (note ? `<div class="pic-note">说明：${esc(note)}</div>` : '');
    }).join('');
  }
  if (m.content) inner += esc(m.content);
  // 这条是打了「/搜」发出去的 —— 在气泡里留个小标记，回头能看出哪几条是联网问的
  if (m.searched) inner += '<div class="search-tag" title="联网搜索：' + esc(m.searched) + '">🔍 ' + esc(m.searched) + '</div>';
  // token 角标：总开关关掉时整条不渲染（历史记录里的 usage 仍然留着，随时能开回来）
  // ⚠️ usage 有两个来源：导入的备份、以及【模型接口原样返回的】那个对象（api.js 直接透传）。
  //    所以这几个数字必须当成外来数据 —— 先 Number() 化再拼进 HTML（v1.21.52）。
  const u = S.showUsage === false ? null : m.usage;
  const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
  const tok = u
    ? `<span class="tk" title="输入 ${num(u.prompt_tokens)} / 输出 ${num(u.completion_tokens)}">`
      + `↑${num(u.prompt_tokens)} ↓${num(u.completion_tokens)}`
      + (u.prompt_cache_hit_tokens ? ` <i>缓存 ${num(u.prompt_cache_hit_tokens)}</i>` : '')
      + `</span>`
    : '';
  // 右下角显示【剧情时间】。老消息没有 story 字段 → 整块不显示
  // （用户明确要的：看不到时间比看到"真实时间"更不误导）
  const st = fmtStory(m.story);
  const time = st ? `<span class="story-time">${st}</span>` : '';
  return `<div class="msg ${isMe ? 'me' : 'ai'}" data-id="${esc(m.id)}">${av}<div class="bub">${inner}<div class="t">${time}${tok}</div></div></div>`;
}

let _archOpen = false;   // 归档区的展开状态（重绘后要保住）

/** 给刚追加的那条消息打上出场动画标记（全量重绘时不打） */
function markFresh(el) {
  if (el) el.classList.add('fresh');
}

// ⚠️ v1.21.39 修（复审第二轮 #3）：生成中【不许】做纯视觉重绘。
//
// 起因：renderMessages() 开头是无条件 `box.innerHTML = ''`，没有 busy 守卫。
// 用户在生成期间点设置页的开关（显示正在输入 / 历史时间标记 / 字号等），
// 就会把正在打字的气泡整个清掉 —— 表现是气泡突然消失，回复最后一次性蹦出来。
// 失败时占位气泡 id 已经为 null，连「重试一次」按钮都不会出现。
//
// 为什么不直接在 renderMessages() 里判 busy：它有 22 个调用点，其中
// 「发送失败回滚删消息」(3516)、切角色(1265/1278)、归档后刷新(5923) 等
// 【必须】重绘，一刀切会把它们一起拦掉。所以只包住纯视觉的那几个。
function renderMessagesIfIdle() {
  if (busy) return;   // 生成中：等这轮结束自然会重绘
  return renderMessages();
}

async function renderMessages() {
  if (!curCharId) { await showEmptyChat(); return; }
  const box = $('messages');
  const list = await msgs.list(curCharId);
  box.innerHTML = '';

  // 开场白只自动补一次。以前只要列表为空就补，导致删掉开场白后下一次
  // 重绘它又蹦回来——删不掉。
  const greeted = await kv.get('greeted:' + curCharId, false);

  // 先看有没有归档的：有的话即使当前列表为空，也说明这段关系早就开始了，
  // 不该再显示「在等你先开口」。
  const archEarly = await msgs.archived(curCharId);

  if (!list.length && !archEarly.length) {
    const nm = esc(curChar?.name || '她');
    const fresh = !!curChar?.greeting && !greeted;
    const tip = fresh ? `和「${nm}」的对话开始了` : `「${nm}」在等你先开口`;
    box.insertAdjacentHTML('beforeend', `<div class="sys-line">${tip}</div>`);

    if (fresh) {
      // ⚠️ 开场白也要有钟点（2026-09-28 修）。
      //
      // 起因（用户实测）："人物刚开始创立的开场白是没有详细日期的，哪怕我设置里
      // 开关都一样"—— 开了「精确时间」，开场白却只显示「第 1 天 上午」。
      //
      // 根因在 loadClock：新建角色的 clockState 里 hour 是 null（只有 day/phase/
      // season/weather 有默认值），而 storyStamp() 遇到非数字就存 null，
      // fmtStory() 再因为 typeof hour !== 'number' 把时分整段省掉。
      // 之后发了消息才会有钟点，只有开场白这一条永远是秃的。
      //
      // 修法：落库前补一个当前时段的起始钟点。只在开了精确时间时补 ——
      // 关着的话本来就不显示时分，补了也是白存（而且会让老数据的 story 结构变化）。
      const now = { ...clockState };
      if (S.clockDetail && typeof now.hour !== 'number') {
        // ⚠️ 这里【不能】用 rangeOf：它是后面的 const，执行到这儿时还在暂时性死区里
        // （ReferenceError）。直接读 DEFAULTS 是安全的 —— rangeOf 本身也只是拿
        // S.clockRanges 兜底到它。
        const rg = (S.clockRanges && S.clockRanges[now.phase]) || DEFAULTS.clockRanges[now.phase] || [9, 11];
        const a = rg[0];
        now.hour = a;
        now.minute = 0;
        // 同步回状态：顶部时间条也要显示同一时刻，不能消息里是 09:00、条上还是"上午"
        clockState = { ...clockState, hour: a, minute: 0 };
        // 落库失败不该挡住开场白本身，静默即可（下次进来自会重试）
        saveClock().catch(() => {});
      }
      const g = { id: uid(), charId: curCharId, role: 'assistant', content: curChar.greeting, story: storyStamp(now), ts: Date.now() };
      await msgs.add(g);
      await kv.set('greeted:' + curCharId, true);
      box.insertAdjacentHTML('beforeend', msgHtml(g));
      attachMsgActions();
    }
    scrollBottom();
    return;
  }

  // 已经有对话了，说明开场白那一关早过了 —— 补上标记，
  // 这样老数据升级上来、以后把消息删光，也不会把开场白捡回来。
  if (!greeted) await kv.set('greeted:' + curCharId, true);

  // 归档区：默认收起，点开才把原文放出来（原文一直在库里，没删）
  const arch = archEarly;
  let archHtml = '';
  if (arch.length) {
    // 展开状态存在外面：不然删一条消息触发重绘，看得好好的归档区会自己收回去
    archHtml = '<div class="arch-bar" id="arch-bar">'
      + '<button class="arch-toggle" id="arch-toggle">' + (_archOpen ? '收起已归档的对话' : '更早的 ' + arch.length + ' 条已归档（点开查看）') + '</button>'
      + '<div class="arch-list' + (_archOpen ? '' : ' hidden') + '" id="arch-list">'
      + arch.map(msgHtml).join('')
      + '</div></div>';
  }

  box.innerHTML = archHtml + list.map(msgHtml).join('');
  const tg = $('arch-toggle');
  if (tg) tg.onclick = () => {
    _archOpen = !_archOpen;
    $('arch-list').classList.toggle('hidden', !_archOpen);
    tg.textContent = _archOpen ? '收起已归档的对话' : '更早的 ' + arch.length + ' 条已归档（点开查看）';
  };
  attachMsgActions();
  scrollBottom();
}

// ===== 长按消息：复制 / 删除 / 重新生成 =====
// 一次长按会同时走两条路径：touchstart 的 550ms 定时器，以及 Android WebView 长按派发的
// contextmenu。showMsgMenu 里有 await，两次调用会各建一个菜单；而 .msg-menu 是 fixed 定位，
// 多个菜单完全重叠，点「删除」只关掉最上面那个，看上去就是「点了不消失」。
// 对策：单例 + 请求序号，让并发调用只保留最后一次；任何关闭动作都把残留清干净。
let _pressTimer = null;
let _msgMenu = null;    // 当前唯一菜单
let _menuSeq = 0;       // 关闭或新开时 +1，用来作废还在 await 中的旧请求

/**
 * 关掉菜单，并作废所有在途的 showMsgMenu 请求。
 * animate=false：立刻移除。马上要开新菜单时必须用它——
 * 否则旧菜单还在播退场、新菜单已经在同一位置弹入，两个叠在一起会很乱。
 */
function closeMsgMenu(animate = true) {
  _menuSeq++;
  const kill = (el) => {
    if (!animate) { el.remove(); return; }
    if (el.classList.contains('closing')) return;   // 已经在退场了，别重复计时
    el.classList.add('closing');
    setTimeout(() => el.remove(), 150);
  };
  if (_msgMenu) {
    if (_msgMenu._onOutside) document.removeEventListener('pointerdown', _msgMenu._onOutside, true);
    kill(_msgMenu);
    _msgMenu = null;
  }
  // 兜底：任何原因留下的残留菜单一并清掉
  document.querySelectorAll('.msg-menu').forEach(kill);
}

function attachMsgActions() {
  const box = $('messages');
  box.querySelectorAll('.msg').forEach(el => {
    if (el.dataset.bound) return;
    el.dataset.bound = '1';
    el.addEventListener('touchstart', () => {
      clearTimeout(_pressTimer);   // 前一根手指还没松开就按了另一条，别把定时器丢掉
      _pressTimer = setTimeout(() => showMsgMenu(el), 550);
    }, { passive: true });
    el.addEventListener('touchend', () => clearTimeout(_pressTimer));
    el.addEventListener('touchmove', () => clearTimeout(_pressTimer));
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); showMsgMenu(el); });
  });

  // 长按她的头像 → 进她的编辑页（和点聊天栏上面那个头像等效）。
  //
  // 为什么单独处理：头像是 .msg 的子元素，不拦住的话长按会冒泡到消息上，
  // 弹出「复制/删除/重新生成」菜单，和「进编辑页」抢同一次手势。
  // 这里 stopPropagation 把冒泡切断，两个功能各管各的。
  //
  // 时长用 1200ms：比消息菜单的 550ms 长，避免误触——
  // 用户想长按消息时手指落在头像上，也不会误进设置页。
  let _avTimer = null;
  box.querySelectorAll('.av-her').forEach(av => {
    if (av.dataset.avbound) return;
    av.dataset.avbound = '1';
    const stop = (e) => e.stopPropagation();
    av.addEventListener('touchstart', (e) => {
      stop(e);
      clearTimeout(_avTimer);
      _avTimer = setTimeout(() => {
        _avTimer = null;
        if (navigator.vibrate) { try { navigator.vibrate(15); } catch {} }
        openCharEdit(curCharId);
      }, 1200);
    }, { passive: true });
    av.addEventListener('touchend', (e) => { stop(e); clearTimeout(_avTimer); });
    av.addEventListener('touchmove', (e) => { stop(e); clearTimeout(_avTimer); });
    av.addEventListener('touchcancel', () => clearTimeout(_avTimer));
    // 桌面端右键也认（方便在电脑上调试）
    av.addEventListener('contextmenu', (e) => {
      e.preventDefault(); e.stopPropagation();
      openCharEdit(curCharId);
    });
  });
}

/**
 * 把菜单放到被长按的那条消息旁边。
 * 水平对齐消息中心（夹在视口内），垂直优先放消息下方，下方不够就翻到上方。
 * transform-origin 跟着翻转，让展开方向是从消息那一侧开始的。
 */
function placeMenu(menu, el) {
  const r = el.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  // 上下留白要避开系统栏（状态栏 / 挖孔 / 手势条）。只用一个 8px 常量的话，
  // edge-to-edge 下长按靠顶的消息时，菜单会被推到状态栏里面，最上面那个
  // 按钮露不出来也点不准。inset 由 CSS 落成变量，这里读回来用。
  const cs = getComputedStyle(document.documentElement);
  const sat = parseFloat(cs.getPropertyValue('--sat')) || 0;
  const sab = parseFloat(cs.getPropertyValue('--sab')) || 0;
  const padX = 8, padT = 8 + sat, padB = 8 + sab;
  const vw = window.innerWidth, vh = window.innerHeight;

  let left = r.left + r.width / 2 - mw / 2;
  left = Math.max(padX, Math.min(left, vw - mw - padX));

  let below = true;
  let top = r.bottom + padT;
  if (top + mh > vh - padB) { top = r.top - mh - padT; below = false; }
  top = Math.max(padT, Math.min(top, vh - mh - padB));

  menu.style.left = Math.round(left) + 'px';
  menu.style.top = Math.round(top) + 'px';
  menu.style.transformOrigin = below ? '50% 0%' : '50% 100%';
}

// ================= 朗读（v1.21.56）=================
//
// 为什么用 Web Speech API 而不是 Capacitor 插件：
//   · Android WebView 是 Chrome 内核，window.speechSynthesis 直接可用
//   · 插件版要引原生依赖 + cap sync，而它的原生部分在 PC 上验证不了 —— 装上去等于盲发
// 代价：音色由【系统 TTS 引擎】决定（多数手机自带中文语音包），我们只能调语速音调。
// 所以每一处入口都要先问 ttsAvailable()，不可用就明说，不给一个点了没反应的按钮。
let _ttsOn = false;   // 当前是否正在朗读（给"停止"用）

/** 这台设备有没有可用的朗读能力 */
function ttsAvailable() {
  try {
    return typeof window !== 'undefined'
      && 'speechSynthesis' in window
      && typeof window.SpeechSynthesisUtterance === 'function';
  } catch { return false; }
}

/**
 * 把正文处理成"能念"的样子。
 * ⚠️ 括号里的动作描写【不念】：那是给她演的画面，念出来是"（轻轻笑了一下）"，
 *    比不念还出戏。同理去掉 markdown 记号与多余的空白。
 */
function ttsClean(text) {
  return String(text || '')
    .replace(/[（(][^）)]{0,300}[）)]/g, '')
    .replace(/[*_~`#>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 读一段字；正在读的先停掉（不排队） */
function speak(text) {
  if (!ttsAvailable()) { toast('这台设备没有可用的朗读引擎', 3000); return; }
  const s = ttsClean(text);
  if (!s) return;
  try {
    window.speechSynthesis.cancel();
    const u = new window.SpeechSynthesisUtterance(s);
    u.lang = 'zh-CN';
    u.rate = 1;
    u.pitch = 1;
    u.onend = () => { _ttsOn = false; };
    u.onerror = () => { _ttsOn = false; };   // 引擎中途报错也要复位，否则"停止"永远亮着
    _ttsOn = true;
    window.speechSynthesis.speak(u);
  } catch (e) {
    _ttsOn = false;
    console.warn('[朗读] 失败', e);
  }
}

/** 停止朗读 */
function stopSpeak() {
  try { if (ttsAvailable()) window.speechSynthesis.cancel(); } catch { /* 停不掉也无所谓 */ }
  _ttsOn = false;
}

async function showMsgMenu(el) {
  const id = el.dataset.id;
  if (!id) return;

  clearTimeout(_pressTimer); _pressTimer = null;   // 两条触发路径只走一次
  closeMsgMenu(false);                             // 先立刻清掉上一个，绝不让菜单堆叠
  const seq = _menuSeq;                            // 记住本次请求的序号

  const all = await msgs.list(curCharId);
  if (seq !== _menuSeq) return;                    // 等待期间又有新请求 → 本次作废
  let m = all.find(x => x.id === id);
  let isArchived = false;
  if (!m) {
    // 可能是归档区里的消息。它们不在 all 里，但长按了总得有反应 ——
    // 尤其要让人能把「取消归档」找回来。
    const arch = await msgs.archived(curCharId);
    m = arch.find(x => x.id === id);
    if (!m) return;
    isArchived = true;
  }

  const isMe = m.role === 'user';
  const acts = [];
  if (isArchived) {
    // 归档的消息【不给】编辑重发 / 从这里重聊：那两条的语义是「删掉这条之后的一切」，
    // 而归档不在当前时间线上，算下去会删错一大片。只给安全的两项。
    acts.push({ k: 'copy', t: '复制文字' });
    acts.push({ k: 'unarch', t: '取消归档' });
  } else {
    // ⚠️ 生成中不显示这四项（v1.21.41）。
    //
    // 它们点下去本来就会被下面 onclick 里的 busy 拦截、只弹一句
    // 「她还在打字，先按停止再操作」—— 给了入口却用不了。
    // 现在直接在菜单里就不给，判据与那段拦截【同源】（都是 busy）。
    //
    // ⚠️ 为什么不在 renderMessages 里一把拦掉：那是另一回事。这四个操作
    //    （编辑/删除/从这里重聊/重新生成）本身就要「先删消息再调 send()」，
    //    生成中做会把库里搞成"她自问自答"的孤立回复（见 onclick 里的注释）。
    //    而「取消归档」不在拦截列表里 —— 它不动时间线，生成中也该能用。
    const locked = busy;
    if (isMe && !locked) acts.push({ k: 'edit', t: '编辑重发' });   // 只有自己发的才能改
    acts.push({ k: 'copy', t: '复制文字' });
    // 朗读（v1.21.56）：只给她的消息 —— 念自己打的那句没有意义。
    // 引擎不可用（系统没装中文语音包）时干脆不给这一项，免得点了没反应。
    if (!isMe && ttsAvailable()) acts.push({ k: 'tts', t: '朗读这条' });
    if (!locked) acts.push({ k: 'del', t: '删除这条' });
    const isLast = all[all.length - 1]?.id === m.id;
    // ⚠️ 首条 assistant 也要给 regen 入口（v1.21.27 修，复审 新1）。
    //
    // 起因：★6 把 regen 的开场白判据换成 isGreetingMsg（要求"是第一条"），
    // 但菜单原本只在 isLast 时给 regen —— 两个条件同时成立只有"列表只剩一条"，
    //
    // 上一版把它也放进了 rewind 的【非】条件，于是「可见首条 assistant 一律不给重聊」——
    // 而归档默认开着，长对话后可见首条通常就是一条普通 assistant，
    // 等于把「刷新开场白时间标签」这个特例扩大成了「首条不能重聊」。
    //
    // 更根本的错：这里用的是 msgs.list()（不含归档），
    // 而 isGreetingMsg 读的是含归档的全表 —— 两者不是一回事。
    // 上一轮刚学到的「判据不该依赖可见列表位置」，在菜单层原样重犯了。
    // 而且这个条件保护不了任何东西：regen 分支内部本来就有 isGreetingMsg 护卫。
    // ⚠️ 菜单与分支判据必须一致（v1.21.30 修，复审新3）。
    //
    // 上一版菜单给 "(isLast || isFirstAi)"，而 regen 分支只允许 lastId === id ——
    // 于是 [a0,u1,a1] 对 a0：菜单【给了 regen 入口】，点下去却被拦下并 toast
    // 「只能对最后一条重新生成」。不该给用不了的入口。
    //
    // 为什么直接删掉 isFirstAi 而不是放宽分支：
    //   · 分支放宽会重新引入新6 那个「删错消息、因果颠倒」的 bug
    //   · 而「开场白刷时间标签」那个需求不受影响 ——
    //     开场白要刷时间时列表里通常只有它一条（既是首条又是末条，isLast 成立）
    if (!isMe && isLast && !locked) acts.push({ k: 'regen', t: '重新生成' });
    // 回溯：丢掉这条之后的所有对话，从这里重新聊。记忆不删——她是记得的。
    if (!isMe && !isLast && !locked) acts.push({ k: 'rewind', t: '从这里重聊' });
  }

  const menu = document.createElement('div');
  menu.className = 'msg-menu';
  menu.innerHTML = acts.map(a => `<button data-k="${a.k}">${tt(a.t)}</button>`).join('') +
    '<button data-k="cancel" class="cancel">' + tt('取消') + '</button>';
  document.body.appendChild(menu);
  placeMenu(menu, el);
  _msgMenu = menu;

  // 点菜单以外的任何地方都关掉
  menu._onOutside = (ev) => { if (!menu.contains(ev.target)) closeMsgMenu(); };
  setTimeout(() => {
    if (_msgMenu === menu) document.addEventListener('pointerdown', menu._onOutside, true);
  }, 0);

  menu.onclick = async (e) => {
    const k = e.target.dataset.k;
    closeMsgMenu();   // ⚠️ 先关；点到按钮之间的空隙（k 为空）也必须关掉
    if (!k) return;
    // 她还在生成时不要做这三件事：它们都是「先删消息再调 send()」，
    // 而 send() 在 busy 时会直接返回 —— 结果消息删了、也没重新生成。
    // ⚠️ del 也要挡（v1.21.24 修，审计第 6 条）。
    //
    // 起因：生成中长按刚发出的用户消息点删除 → 消息没了，但 send() 那路请求
    // 仍会跑完，并在成功路径把 assistant 回复落库（落库不校验对应 user 消息还在）
    // → 库里只剩一条"她自问自答"的孤立回复。
    // 实测证据：删后库=[]，生成结束后库=["...:assistant:片1。片2。…"]。
    if (busy && (k === 'edit' || k === 'rewind' || k === 'regen' || k === 'del')) {
      toast('她还在打字，先按停止再操作');
      return;
    }
    if (k === 'edit') {
      // 改一条 = 从这里重新来过：这条以及它之后的对话都要清掉，
      // 否则她上一轮的回复还留在历史里，会把你改掉的内容继续往下带。
      const at = all.findIndex(x => x.id === id);
      // 归档的消息不在 all 里，findIndex 会给 -1 —— 而 slice(-1) 恰好是"最后一条"，
      // 会变成删掉一大堆无关消息。宁可不动，也不能删错。
      if (at < 0) { toast('这条已经归档了，先取消归档再操作'); return; }
      const rest = all.slice(at);                 // 这条 + 之后的
      const after = rest.length - 1;              // 之后的条数
      if (after > 5) {
        const ok = await confirmBox('编辑重发',
          '这条后面还有 <b>' + after + ' 条</b>对话，会一起删掉（她的回复也删）。<br>'
          + '这段对话里产生的<b>记忆也会一起清掉</b>，改完重发她会重新想。<br>'
          + '之前就形成的长期记忆不受影响。<br><br>确定吗？', '删掉并编辑');
        if (!ok) return;
      }
      const inp = $('input');
      inp.value = m.content || '';
      pendingImages = (m.images || []).slice();
      pendingNotes = pendingImages.map((_, i) => (m.imageNotes && m.imageNotes[i]) || '');
      renderAttachPreview();
      syncInput();
      for (const x of rest) await msgs.del(x.id);
      // ⚠️ 滚动摘要也要一并作废（v1.21.42 修）。
      // 被删的这条若是【曾归档过又取消归档】的，它的内容早折进摘要了 ——
      // 光清长期记忆不够，她照样带着那段"已经不存在的事"重新想。
      await invalidateRollingIfStale(curCharId, rest);
      // 被删的这段对话产生的记忆，要一起清掉（2026-09-26 最终版）。
      //
      // 用户明确要求（原话）：
      //   「我点了重新思考和编辑重发以及"这里重聊"了后后续的都会删掉，
      //     不会影响记忆，去让她重新输出」
      //   「要动，在我操作了对话后后续的聊天里的记忆都要动」
      //   「十句话里我在第五句点了在这重聊后后面几个全删掉，
      //     不影响她新的思考输出」
      //
      // 也就是说：删消息【必须】连带清记忆 —— 否则她带着"已经发生过的事"
      // 重新生成，就是用户说的「污染记忆产生偏差」。
      //
      // ⚠️ 但清理【必须精准】，这正是之前"记忆倒退到很久以前"的根因：
      // 旧实现只丢一堆原文 + 一句"只在那些内容里出现过就删掉"，
      // 模型会放宽成"沾边就删"，把更早形成的长期事实也一起抹掉。
      // 现在 noteDeleted 会把「被删的对话」和「当前记忆」配对送进去，
      // 让模型按「这条记忆是不是只能从被删内容里得到」来判（见 dedupeIfNeeded）。
      await noteDeleted(rest.map(x => x.content));
      // ⚠️ 必须 await（v1.21.37 修，复审 贯穿性根因）。
      // 起因：rewind / regen 两个分支补了 await，edit / del 没补 ——
      // 【同一路径两个入口行为不同】：不 await 的话紧接着的 regenerate()/renderMessages()
      // 会跟清理并发跑，她可能带着"被删那段产生的记忆"重新生成。
      // ⚠️ 先重绘再等整理（v1.21.54，审计发现）：tidyNow 里是一次模型调用（最长 90 秒），
      //    而重绘原来排在它后面 —— 这期间消息在库里已经删了，界面上气泡还在、
      //    没有 toast、没有转圈，用户以为没点中而重复操作；busy 也仍是 false，
      //    照常发送会让 send 的记忆任务和这里的整理同时改同一份记忆。
      await renderMessages();
      await tidyNow();

      // 时间条跟着退回去 —— 你回到那条消息重聊，剧情时间本来就该是当时那个。
      // 只有老消息（没有 story 字段）才不动。
      let timeBack = '';
      // 现实模式下【不退回】（v1.20.21，约定的 A）：
      // 时间跟手机走，退回一条旧消息的时间没有意义，反而会让角标忽前忽后。
      if (m.story && typeof m.story.day === 'number' && !isRealClock()) {
        clockState = { ...clockState, ...m.story };
        await saveClock();
        timeBack = '，时间退回 ' + fmtStory(m.story);
      }

      await renderMessages();
      inp.focus();
      inp.setSelectionRange(inp.value.length, inp.value.length);
      toast((after ? '后面 ' + after + ' 条也清掉了' : '已退回') + timeBack + '，改完点发送', 3200);
    } else if (k === 'tts') {
      speak(m.content);
    } else if (k === 'copy') {
      try { await navigator.clipboard.writeText(m.content || ''); toast('已复制'); }
      catch { toast('复制失败'); }
    } else if (k === 'unarch') {
      // ⚠️ 这个分支原来是【缺的】（v1.21.24 补，审计第 14 条）。
      // 菜单里构造了「取消归档」按钮，但分派链里没有 k === 'unarch' ——
      // 点下去菜单关闭、无 toast、无报错、归档状态不变，完全是哑的。
      // 全项目唯一的取消归档入口是设置页的「恢复全部」（全量），单条能力压根不存在。
      await msgs.unarchiveOne(id);
      await renderMessagesIfIdle();   // 归档状态变了要重画；生成中跳过，别清掉打字气泡
      toast('已取消归档，这条回到对话里了', 2600);
    } else if (k === 'del') {
      // ⚠️ 退回剧情时间（v1.21.29 修，复审 新8）。
      //
      // 起因：edit / rewind / regen 三个分支都有退回，唯独 del 没有 ——
      // 而下面那句注释还写着「四个操作行为一致」。
      // 现实时间模式下不退（与另外三个写法一致）。
      if (m && m.story && typeof m.story.day === 'number' && !isRealClock()) {
        clockState = { ...clockState, ...m.story };
        await saveClock();
        renderClock();
      }
      await msgs.del(id);
      // ⚠️ 删空了就把「已经打过招呼」的标记复位（v1.21.52）。
      // 开场白只在 !greeted 时自动补一次，而全项目【没有任何一处】把它复位 ——
      // 于是把开场白删掉之后它永远回不来：列表空着，界面却显示「她在等你先开口」，
      // 重启也一样，唯一出路是「清空聊天记录」。这里补上：删空了 = 从头再来。
      try {
        if (curCharId) {
          const left = await msgs.list(curCharId, 0, true);
          if (!left.length) await kv.set('greeted:' + curCharId, false);
        }
      } catch { /* 读不出来不影响删除本身 */ }
      // ⚠️ 滚动摘要一并作废（v1.21.42）：删的若是"曾归档又取消"的那条，摘要里还有它
      await invalidateRollingIfStale(curCharId, [m]);
      // 删除单条：这条产生的记忆一起清掉。
      // （四个操作【行为一致】—— 删除 / 重新思考 / 编辑重发 / 从这里重聊
      //   都会清掉被删那段产生的记忆，也都会退回剧情时间。区别只在删几条消息。）
      await noteDeleted([m.content]);
      // 立刻核对一遍：不然要等下一轮自动整理，用户会觉得「删了她还记得」。
      // 清理范围由 dedupe 里的配对判据控制（"只能从被删内容得到"的才删），
      // 更早形成的长期事实不会受牵连。
      // ⚠️ 同上：await（v1.21.37）。
      await kv.set('memNeedTidy:' + curCharId, true);
      // ⚠️ 重绘必须排在 tidyNow 之前（v1.21.54，审计发现）：tidyNow 是一次模型调用，
      //    最长 90 秒 —— 这期间气泡还在、没有任何反馈，用户会重复点。
      await renderMessages();
      toast('已删除（相关记忆会一并淡忘）', 2600);
      await tidyNow();
    } else if (k === 'rewind') {
      // ⚠️ 开场白特例（v1.21.24 修，审计第 3 条）。
      //
      // 起因：开场白是 role:'assistant' 的第一条，对它点「从这里重聊」→
      //   at = 0 → after = all.slice(1)（【后面全部对话】）→ 逐条删 →
      //   再删开场白 → regenerate() 找不到任何 user 消息，直接 return。
      // 结果：聊天记录清零，且 greeted:<id> 仍是 true，重开 app 开场白也回不来。
      // 实测证据：{"重聊前条数":5,"重聊后条数":0,"greeted标记":true}。
      //
      // ⚠️ regen 分支早就为此加了护卫（见那边的注释），这里漏了 —— 同一族操作必须一致。
      const isGreeting = await isGreetingMsg(id);
      if (isGreeting) {
        toast('这是开场白，不能从这里重聊。想重来请用「清空聊天记录」', 4200);
        return;
      }
      const at = all.findIndex(x => x.id === id);
      // 同上：-1 时 slice(0) 会返回全部，等于把整个聊天记录删光。
      if (at < 0) { toast('这条已经归档了，先取消归档再操作'); return; }
      const after = all.slice(at + 1);
      // ⚠️ 护栏：删完之后必须还剩你能重聊的东西（v1.21.29 修，复审 新5）。
      //
      // 起因：`all` 不含归档，而 isGreetingMsg 走含归档全表 —— 两者语义不同。
      // 归档后可见首条变成普通 assistant，对它点重聊：
      //   at = 0 → after = 全部可见对话 → 删光 → regenerate() 找不到 user，
      //   只 toast「没有可重新生成的内容」就 return，【没有回滚】→ 可见对话清零，不可逆。
      // 实测：g1(归档) u1(归档) a1 u2 a2 → 操作后可见 0 条，modelCalls=0。
      // 触发条件是【默认配置】（归档默认开），长对话必然进入该状态。
      //
      // 判据：删完（含本条）之后，剩下的可见消息里至少要有 1 条 user 才值得重聊。
      // ⚠️ 判据改对了（v1.21.30 修，复审新2）：要看【删完真正剩下的】，不是 after。
      //
      // 上一版查的是 after（本条之后还有没有 user），但实际删的是 after 全部 + 本条自己
      // → 剩下的是 all.slice(0, at)。
      // 实测：场景 [a0, u1, a1]（归档后可见首条的常见形态）对 a0 点重聊：
      //   at=0, after=[u1,a1] → remainUser=1 → 护栏【放行】→ 删完剩余 = [] ← 仍然清零。
      // 也就是说上一版没覆盖它自己注释里点名的那个场景。
      const remain = all.slice(0, at);
      if (!remain.some(x => x.role === 'user')) {
        toast('这条后面没有能重聊的内容了 —— 再往前就是开场白。想重来请用「清空聊天记录」', 4600);
        return;
      }
      if (after.length > 5) {
        const ok = await confirmBox('从这里重聊',
          '这条后面还有 <b>' + after.length + ' 条</b>对话，会一起删掉。<br>'
          + '这段对话里产生的<b>记忆也会一起清掉</b>，她会当成没发生过、重新想。<br>'
          + '之前就形成的长期记忆不受影响。<br><br>确定吗？', '删掉并重聊');
        if (!ok) return;
      }
      for (const x of after) await msgs.del(x.id);
      await msgs.del(id);
      // ⚠️ 滚动摘要一并作废（v1.21.42）：rewind 删的是"这条 + 之后"，
      // 里面若有曾归档又取消的，摘要里还驮着它。
      await invalidateRollingIfStale(curCharId, after.concat([m]));
      // 退回去的那段，产生的记忆也要一起清掉（2026-09-26 最终版）。
      // 用户场景：「十句话里我在第五句点了在这重聊，后面几个全删掉，
      //            不影响她新的思考输出」—— 留着就会污染重新生成的思考。
      // 清理范围由 dedupeIfNeeded 里的配对判据控制，只删"只能从被删内容得到"的那些。
      await noteDeleted(after.map(x => x.content).concat([m.content]));
      // ⚠️ 必须【等它清完】再重聊（v1.21.35 修，P0-3）。
      //
      // 起因：原来是 `tidyNow()` 不 await，紧接着就 regenerate() ——
      // 她带着"被删掉那段产生的记忆"重新生成 = 用户说的「重思考后反而更偏」。
      // 本文件 L1167 的注释早就承认了这个后果，但没修。
      //
      // 另配套一个强制标记：dedupeIfNeeded 有门槛，队列非空虽能放行，
      // 但模型抽风时它会 return 0，队列原样留着 —— 那样即使 await 了也白等。
      await kv.set('memNeedTidy:' + curCharId, true);
      // 同上（v1.21.54）：先让界面反映这次操作，再等那次可能 90 秒的整理。
      await renderMessages();
      await tidyNow();
      // ⚠️ 剧情时间也要退回这条消息当时的快照（v1.21.24 修，审计第 10 条）。
      //
      // 起因：edit（编辑重发）会退回时间，rewind 完全不碰 clockState ——
      // 两个同族操作行为不一致。用户"十句话里在第五句点重聊"，
      // 她重新生成时拿到的仍是"现在"的时间，而不是第五句那个时间点。
      // 实测证据：edit 后 kv clock 第 9 天→第 3 天；rewind 后仍是第 9 天。
      //
      // 现实模式下【两者都不该退】（时间跟手机走，退回去没有意义）——
      // 与 edit 分支的判断保持一致。
      let timeBack2 = '';
      if (m.story && typeof m.story.day === 'number' && !isRealClock()) {
        clockState = { ...clockState, ...m.story };
        await saveClock();
        timeBack2 = '，时间退回 ' + fmtStory(m.story);
      }
      await renderMessages();
      regenerate();
      toast((after.length ? '后面 ' + after.length + ' 条也退了' : '从这条重新聊') + timeBack2);
    } else if (k === 'regen') {
      // ⚠️ 开场白是个特例：它【没有对应的用户输入】（app.js 里 role:'assistant'
      // 且带 greeting 标记），重新生成 = 拿"最后一条用户消息"重发 ——
      // 而此刻一条用户消息都没有，regenerate() 会直接 return。
      //
      // 旧顺序是【先删她这条，再调 regenerate】，于是：
      //   msgs.del(id) 删掉开场白 → regenerate() 发现没有用户消息 → return
      //   = 开场白永久消失，界面只剩「她在等你开口」。
      // 用户实测报的正是这个（"点重新思考后开场白没了"）。
      //
      // 改成：先判断能不能重生成，能才删；开场白单独走"补时间标签"这条路。
      // 与 rewind 分支共用同一套判据（复审 ★6：两处不一致）
      const allNow = await msgs.list(curCharId);
      const isGreeting = await isGreetingMsg(id);
      if (isGreeting) {
        // 他已经调过具体时间 → 只把时间标签补上，不动开场白本身。
        // 这正是用户要的："我调了具体时间了后重新思考了只是去加个时间标签"。
        // ⚠️ 必须取【真正的开场白】，不能取 allNow[0]（v1.21.29 修，复审 新9）。
        //
        // 起因：isGreetingMsg 走的是【含归档全表】，而 allNow 是不含归档的 msgs.list()。
        // 归档后可见首条变成普通 assistant，allNow[0] 就是它自己 →
        // 于是把这条【普通消息】的 story 静默改写，还 toast「开场白的时间已更新」，modelCalls=0。
        //
        // 正确做法：按 id 从全表取那条真正的开场白。取不到就说明状态异常，直接放弃。
        const allFull = await msgs.list(curCharId, 0, true);
        const cur = allFull.find(x => x.id === id);
        if (!cur) { toast('找不到这条开场白，先刷新一下再试', 4200); return; }
        const fresh = storyStamp();
        const changed = JSON.stringify(cur.story || null) !== JSON.stringify(fresh);
        if (changed) {
          await msgs.add({ ...cur, story: fresh });   // id 不变 = 覆盖那一条
          await renderMessages();
          toast('开场白的时间已更新为 ' + fmtStory(fresh));
        } else {
          // 时间没变（或还没开「精确时间」需要先补钟点）
          const needHour = S.clockDetail && typeof (cur.story || {}).hour !== 'number';
          if (needHour) {
            await msgs.add({ ...cur, story: fresh });
            await renderMessages();
            toast('开场白的时间已补上钟点：' + fmtStory(fresh));
          } else {
            toast('开场白不用重新生成 —— 你还没发过消息，她没得重新想。'
                  + '想改时间就点上面的时间条。', 4200);
          }
        }
        return;
      }
      // ⚠️ 只能对【最后一条】重新生成（v1.21.29 修，复审 新6）。
      //
      // 起因：这里删的是【你点的那条】，而下面 regenerate() 删的是【最后一条 user】——
      // 两者不是同一条时就会错位。
      // 实测：g1(归档) u1(归档) a1回一 u2第二句 a2回二 → 操作后 a2回二 排在 第二句【之前】，
      // 读起来是「她先回了『回二』，然后他才说『第二句』」——【因果颠倒】。
      //
      // 判据：只有它就是列表最后一条时才允许 regen；否则引导用户用「从这里重聊」。
      const lastId = allNow[allNow.length - 1] && allNow[allNow.length - 1].id;
      if (lastId !== id) {
        toast('只能对最后一条重新生成。想从这条重来请用「从这里重聊」', 4600);
        return;
      }
      // ⚠️ 护栏：删完之后必须还剩你能重聊的东西（v1.21.32 修，复审 #1）。
      //
      // 起因：rewind 分支有这个护栏，【regen 分支漏了】—— 而它的删除范围一样狠：
      //   msgs.del(id) 删这条 + regenerate() 再删【最后一条 user】。
      // 当可见列表只剩 [a0, u1, a1] 且你点 a0（末条）时：
      //   lastId === id 通过 → 删 a0 → regenerate() 删 u1 → 再找 user 就没了 → return，
      //   而 a1 还留着 → 可见对话被清空且【不可逆】。
      //
      // 判据与 rewind 一致：删完（本条 + 它之后的）之后，剩下的可见消息里至少要有 1 条 user。
      const afterIds = allNow.slice(allNow.findIndex(x => x.id === id) + 1).map(x => x.id).concat([id]);
      const remainForRegen = allNow.filter(x => !afterIds.includes(x.id));
      if (!remainForRegen.some(x => x.role === 'user')) {
        toast('这条前面没有能重发的消息了 —— 再往前就是开场白。想重来请用「清空聊天记录」', 4600);
        return;
      }
      // 普通情况：这条产生的记忆同样要清掉 —— 和另外两个操作保持一致。
      // 需求三个操作行为统一：「我点了重新思考和编辑重发以及"这里重聊"了后
      // 后续的都会删掉……要动」。
      // ⚠️ 退回剧情时间（v1.21.28 修，复审 新7_）。
      //
      // 起因：edit(1160) 和 rewind(1237) 都会 clockState = {...clockState, ...m.story}，
      // del / regen / regenerate() 全程没有这段 —— 而 rewind 分支末尾就是调 regenerate()，
      // 【同一路径两个入口行为不同】。
      // 实测：edit 后 clock 回到 day 2；regen 后 clock 仍在 day 9，新消息带着第 9 天。
      //
      // 现实时间模式下不退（与 edit/rewind 的写法一致）。
      if (m && m.story && typeof m.story.day === 'number' && !isRealClock()) {
        clockState = { ...clockState, ...m.story };
        await saveClock();
        renderClock();
      }
      await msgs.del(id);
      // ⚠️ 滚动摘要一并作废（v1.21.42），与另外三个操作保持一致
      await invalidateRollingIfStale(curCharId, [m]);
      await noteDeleted([m.content]);
      await kv.set('memNeedTidy:' + curCharId, true);
      // 同上（v1.21.54）：先重绘再等整理，否则这条回复消失得无声无息。
      await renderMessages();
      await tidyNow();
      regenerate();
    }
  };
}

/**
 * 重发某条用户消息。
 * msgId 优先：失败气泡要重发的是「它自己那条」。
 * 以前不传参、一律找最后一条用户消息，所以点了旧的失败气泡，
 * 重发的其实是后来那条已经成功过的消息 —— 同一句话发两遍、回复重复。
 */
async function retrySend(msgId) {
  // 先挡一道：下面会「先删消息、再调 send()」，而 send() 遇到 busy 或
  // 图片还在处理时会直接 return —— 那样消息删掉了却发不出去，白丢一条。
  if (busy) { toast('还在生成中，先按停止再重试'); return; }
  if (_pickingImages) { toast('图片还在处理，稍等一下再重试'); return; }
  const all = await msgs.list(curCharId);
  let m = msgId ? all.find(x => x.id === msgId && x.role === 'user') : null;
  // 指定了 id 却没找到（比如那条已经被归档了）：直接说清楚，不要退而求其次。
  // 以前会兜底去拿"最后一条用户消息"——那条完全不相干，还会被删掉重发。
  if (msgId && !m) { toast('那条已经归档了，找不到可重试的内容'); return; }
  // ⚠️ v1.21.54：删掉了「没指定 id 就退回最后一条用户消息」那条静默回退。
  //    它看起来像兜底，实际是【删掉一条完全不相干的消息再重发】——
  //    续写路径传进来的正是 undefined（见错误气泡那里的注释），实测会把上一条真实消息
  //    挪到时间线末尾，变成"她先答、他后问"。要重试就必须指名道姓；
  //    全项目 retrySend 只有一个调用点，都带 id。
  if (!m) { toast('没有可重试的消息'); return; }
  $('input').value = m.content || '';
  pendingImages = (m.images || []).slice();
  pendingNotes = pendingImages.map((_, i) => (m.imageNotes && m.imageNotes[i]) || '');
  renderAttachPreview();
  await msgs.del(m.id);
  await renderMessages();
  send();
}

/** 用最后一条用户消息重新请求一次 */
async function regenerate() {
  // 和 retrySend 同理：下面会先删掉那条用户消息再调 send()，
  // 而 send() 在 busy / 图片处理中会直接 return —— 消息就白删了。
  if (busy) { toast('还在生成中，先按停止再重新生成'); return; }
  if (_pickingImages) { toast('图片还在处理，稍等一下再重新生成'); return; }
  const all = await msgs.list(curCharId);
  let lastUser = null;
  let lastIdx = -1;
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i].role === 'user') { lastUser = all[i]; lastIdx = i; break; }
  }
  if (!lastUser) { toast('没有可重新生成的内容'); return; }
  // ⚠️ 它后面的回复要【一起删】，不能只删被长按的那一条（v1.21.54 修，审计发现）。
  //
  // 起因：开了「分段发送」时，她一条回复会落成多条 assistant 消息（各有各的 id），
  // 而"重新生成"这条路上只删了被长按的那一段 —— 同一轮的其它段留在原地。
  // 实测顺序变化：操作前 [你, 她①, 她②, 她③] → 操作后 [她①, 她②, 你', 新①②③]，
  // 读起来成了"她先自说两句、你才开口"，而且这段错序会一直作为历史喂给模型，
  // 每点一次还在上面再叠一层。
  // 规则：删掉那条用户消息，就把它的整段回复（它后面的 assistant）一起带走。
  const followers = all.slice(lastIdx + 1).filter(m => m && m.role !== 'user' && m.id);
  // ⚠️ 退回剧情时间（v1.21.31 修，用户实测反馈）。
  //
  // 起因（复现）：「我设定下午 4 点发了消息，重新思考了几次后她会提到上午或者前一天的事物」。
  //
  // 根因：edit / del / regen / rewind 四处【菜单分支】都有 clockState 退回，
  // 唯独 regenerate() 没有 —— 而 rewind(L1291) 和 regen(L1373) 分支末尾【都会调它】。
  // 也就是说那两处的时间退回是【白做的】：刚退回，这里接着删消息、send() 又用当前时间生成，
  // 于是新回复带着"现在"的时间标签，和她刚说过的时间线对不上 → 读出穿越感。
  //
  // 修法：在这里统一退回（与 edit/del/rewind 的写法一致，现实时间模式下不退）。
  if (lastUser.story && typeof lastUser.story.day === 'number' && !isRealClock()) {
    clockState = { ...clockState, ...lastUser.story };
    await saveClock();
    renderClock();
  }
  $('input').value = lastUser.content || '';
  pendingImages = (lastUser.images || []).slice();
  pendingNotes = pendingImages.map((_, i) => (lastUser.imageNotes && lastUser.imageNotes[i]) || '');
  renderAttachPreview();
  // 删掉刚才那条用户消息（避免重复）+ 它后面的整段回复（见上面 followers 的说明）
  for (const m of followers) {
    try { await msgs.del(m.id); } catch (e2) { console.error('[重新生成] 删旧回复失败', e2); }
  }
  await msgs.del(lastUser.id);
  // ⚠️ 删了就要记账（v1.21.37 修，复审 问题① P0）。
  //
  // 起因：noteDeleted 全项目只有 4 个调用点，全在【菜单分支】（edit/rewind/regen/del）——
  // 而 regenerate() 自己【又删一次】（删最后一条 user），这个删除点排在那些之后，
  // 天然漏掉。
  // 实测（CDP 真实长按 → 菜单 → 重新生成）：
  //   操作后 memDeleted = ["回复1。"]  ← 只有那条 assistant，被删的 user 不在里面
  //   对照 del 分支同一条：被删内容【写进去了】
  // 后果：重新生成时被删掉的那条用户消息，产生的记忆【永远清不掉】。
  //
  // ⚠️ 本函数里【没有 myCharId】—— noteDeleted 用默认参数（curCharId）即可，
  //    写成 noteDeleted(x, myCharId) 会直接 ReferenceError。
  // ⚠️ 连带删掉的那几段也要记账（v1.21.54）：noteDeleted 是"删掉的消息所产生的记忆一并淡忘"，
  //    只记 user 那句的话，她残段产生的记忆会永远留着。
  await noteDeleted([lastUser.content].concat(followers.map(m => m.content || '')).filter(Boolean));
  await kv.set('memNeedTidy:' + curCharId, true);   // 让它下次整理务必跑一趟
  await renderMessages();
  send();
}

// 每帧最多真正滚一次。流式输出时每个 chunk 都会调它，以前是一次调用排一个
// rAF —— 一帧来 3 个 chunk 就是 3 次「读 scrollHeight → 写 scrollTop」的
// 强制同步布局，逐字输出掉帧就是这儿来的。
let _scrollPending = false;
function scrollBottom() {
  if (_scrollPending) return;
  _scrollPending = true;
  requestAnimationFrame(() => {
    _scrollPending = false;
    const box = $('messages');
    if (box) box.scrollTop = box.scrollHeight;
  });
}

/**
 * 这个角色的累计消息序号：每发一条 +1，永不回退。
 * 记忆的节奏全靠它计数，这样归档掉多少、清空多少次都不影响。
 */
async function bumpMsgSeq(charId) {
  const k = 'msgSeq:' + charId;
  const v = ((await kv.get(k, 0)) || 0) + 1;
  await kv.set(k, v);
  return v;
}
async function getMsgSeq(charId = curCharId) {
  return (await kv.get('msgSeq:' + charId, 0)) || 0;
}

// ================= 滚动摘要 =================
//
// 解决的问题：归档 = 永久离开上下文。
// msgs.list() 默认不返回已归档消息，所以一旦归档，那段对话就【再也不会被发出去】——
// 她只剩记忆里那几条零散事实，前情连续性直接断掉。
//
// 实测（用用户 2026-09-24 真实备份算）：
//   角色F每轮输入 8694 tk = 人设 3967 + 历史 3279 + 全局 839 + 记忆 609
//   把 40 条历史（1998 tk）换成一段摘要（约 400 字 = 297 tk），每轮省 1701 tk（-20%）
//
// ⚠️ 这是【有损压缩】，不是免费午餐：
//   同一段原文 2853 字里有 66 处具体信息（13 处承诺、44 处具体物、9 处时间），
//   挤进 400 字摘要必然丢细节。所以摘要只覆盖【已经归档的老内容】，
//   最近未归档的部分照旧原样发送 —— 近处无损，远处有损。
//
// 推进方式学 Smart-Memory：摘要【只折入新归档的内容】，不从零重写。
// 每轮重写会越写越短、细节持续蒸发；增量折叠才能保住早期信息。

const ROLLING_MAX_CHARS = 600;   // 摘要正文上限（约 420 tk）
const ROLLING_TAIL = 200;        // 合并时保留的近期原句，防止摘要太干

/** 读这个角色的滚动摘要 */
async function getRolling(charId) {
  const r = await kv.get('memRolling:' + charId, null);
  return (r && typeof r.text === 'string') ? r : { text: '', upTo: 0 };
}

/**
 * 把一批【刚归档】的消息折进滚动摘要。
 *
 * @param charId 角色
 * @param msgs   本次归档掉的消息（按时间正序）
 * @returns {Promise<string>} 新摘要
 */
async function foldIntoRolling(charId, msgs) {
  if (!msgs || !msgs.length) return '';
  const prev = await getRolling(charId);
  const who = (await chars.get(charId))?.name || curChar?.name || '她';
  // ⚠️ v1.21.39 修（复审第二轮 #2）：天数必须取【目标角色自己】的。
  //
  // 起因：原来无条件读全局 clockState.day，而归档是【逐批循环、每批一次 API】
  // （秒级到十几秒），这期间用户切角色，全局 clockState 已被 loadClock 换成新角色的。
  // 后果：滚动摘要被写上别人角色的剧情天数，而且【持久化】（本函数连 day 一起存），
  // 滚动摘要又是常驻上下文注入的，于是之后每轮注入的都是错的天数。
  // 同 summarizeChunk / summarizeIfNeeded 的口径：先读 clock:<charId>，读不到再退回全局。
  let day = clockState?.day || 1;
  try {
    const cl = await kv.get('clock:' + charId, null);
    if (cl && typeof cl.day === 'number') day = cl.day;
  } catch { /* 读不到就用全局的 */ }

  // ⚠️ 说话人标【名字】而不是「我：」（v1.20.20 修）。
  //
  // 和 summarizeChunk / summarizeIfNeeded 是同一个坑：模型看到一串「我：xxx」，
  // 会把它当成一段第一人称文本，复述时转成第三人称 ——
  // 角色O的长期记忆全变成第三人称就是这么来的。滚动摘要同样受害，
  // 只是它混在一段叙述里，不像记忆条目那么显眼，一直没被发现。
  const body = msgs.map(m => (m.role === 'user' ? '他：' : who + '：') + (m.content || '[图片]')).join('\n');

  // 摘要由模型生成；失败就退回"保留原文末尾"的兜底，
  // 绝不能让摘要为空 —— 空了等于这批内容彻底消失，比不生成还糟。
  let next = '';
  try {
    const out = await onceChat({
      apiKey: S.apiKey, baseUrl: S.baseUrl, provider: S.provider, model: S.model,
      messages: [
        { role: 'system', content:
          `你在帮「${who}」维护一份【前情提要】。这份提要会一直带在她的上下文里，\n`
          + `让她在很久之后仍然记得早先发生过什么。\n\n`
          + `【输入】两部分：\n`
          + `· 已有的前情提要（可能是空的）\n`
          + `· 刚归档的一批对话\n\n`
          + `【要做的事】把新对话【并进】已有提要，写成一段连贯的叙述。\n`
          + `  · 不是罗列，是一段话。像回忆那样自然地讲下来。\n`
          + `  · 保留【仍然有效】的信息：约定过的、答应过的、关系上的变化、\n`
          + `    重要的地点和物件、她和他之间形成习惯的事。\n`
          + `  · 【已经过时的丢掉】：某天吃了什么、当时的具体对话措辞、\n`
          + `    一次性的场景描写——这些不必留。\n`
          + `  · 时间线要清楚：现在是剧情第 ${day} 天，提到"那时""后来"要能对上。\n\n`
          + `【人称 —— 写错整段就废了】\n`
          + `  · 【${who}：】开头的是她自己说的话 → 换成「我」。\n`
          + `  · 【他：】开头的是他说的 → 换成「你」。\n`
          + `  · 提要正文一律第一人称：用「我」指她，用「你」指他。\n`
          + `  · 【不要用第三人称】，也不要写「${who}」这个名字。\n`
          + `  例：✓「那天你靠着我，说哪儿也不去了」　✗「她抱着他，他哪儿也不去」\n\n`
          // ⚠️ 长度的引导方向改对了（v1.21.35 修，P1-2 的【真问题】）。
          //
          // 起因：原话是「控制在 600 字以内。宁短勿长」—— 模型只看到上限和劝退，
          // 于是往最短写。实测用户备份：角色Q 归档 1196 条对话 → 摘要只有 230 字；
          //   角色K 292 条 → 117 字；角色G 411 条 → 187 字。
          // 而「超过 600 字被砍前面」那段代码【一次都没执行过】（最长 489 字）——
          // 所以真正的损失不是被裁掉，是【根本没写够】。
          //
          // 现在给出【下限】，并说明哪些必须留住。上限仍然保留（防超长挤占上下文）。
          + `【长度】按内容量来定，目标 ${Math.floor(ROLLING_MAX_CHARS * 0.5)}-${ROLLING_MAX_CHARS} 字。\n`
          + `  · 【不要为了短而丢掉信息】：他答应过的事、你们约定过的、关系上的变化、`
          + `重要的地点和物件、形成习惯的事 —— 这些哪怕只提一句也要留下。\n`
          + `  · 前面已有提要里的内容，除非确实过时了，否则【接着往下写】，不要越写越短。\n`
          + `  · 上限 ${ROLLING_MAX_CHARS} 字，超了会挤占她回话的上下文。\n\n`
          + `【输出】只输出提要正文，不要标题、不要解释、不要说话。\n\n`
          + `已有的前情提要：\n${prev.text || '（还没有）'}`},
        { role: 'user', content: body }
      ]
    });
    next = String(out || '').trim();
  } catch (err) {
    console.error('[滚动摘要] 生成失败，退回兜底：', err);
  }

  // 兜底：模型没返回可用内容时，别让这批内容凭空消失。
  // 保留原文末尾一段，虽粗糙但保住了信息。
  if (!next) {
    const raw = body.slice(-ROLLING_TAIL);
    next = prev.text ? (prev.text + '\n…后来：' + raw) : raw;
  }
  if (next.length > ROLLING_MAX_CHARS) {
    // 超长就砍【前面】——近期的事比远古的事更该留住
    next = '…' + next.slice(-(ROLLING_MAX_CHARS - 1));
  }

  // ⚠️ upTo 的语义（v1.21.42 起）：被折叠消息里【最大】的那个 ts。
  //
  // 原来存的是 Date.now()（归档动作发生的时刻）—— 它只能回答"摘要是什么时候写的"，
  // 回答不了"某条消息到底进没进摘要"。而消息菜单那边正需要后者：
  // 删/改一条老消息之前，要判断它是不是已经在摘要里了（见 invalidateRollingIfStale）。
  //
  // 旧数据存的是归档时刻，比消息 ts 大 → 判断偏保守（宁可多清一次摘要），无害。
  const upTo = msgs.reduce((mx, m) => Math.max(mx, Number(m.ts) || 0), 0) || Date.now();
  await kv.set('memRolling:' + charId, { text: next, upTo, day });
  return next;
}

/**
 * 改/删旧消息之后，滚动摘要可能已经过期 —— 作废它。
 *
 * 【为什么会过期】滚动摘要是【归档时】增量折叠出来的：某条消息一旦被折进去，
 * 就以自然语言的形式永久留在那儿。之后你再把这条改掉或删掉，摘要【不会跟着变】，
 * 她仍然带着"已经不存在的那段事"继续聊。
 *
 * 【触发路径不是"直接编辑可见消息"】—— 那些消息从没进过摘要。
 * 真实路径是【先取消归档、再改/删它】：它被取消归档之前已经在摘要里了。
 *
 * 【判据】被删的消息里，有没有比摘要水位更早的（ts <= upTo）。
 *
 * 【为什么是"作废"而不是"回退"】摘要是一整段自然语言，没有逐条结构，
 * 没法从里面精确剥离某几条消息的内容。清了会丢一点前情，
 * 但不清就是让她带着【错误信息】继续 —— 后者更糟。
 *
 * @returns {Promise<boolean>} 是否清掉了
 */
async function invalidateRollingIfStale(charId, removedMsgs) {
  if (!charId || !removedMsgs || !removedMsgs.length) return false;
  let cur = null;
  try { cur = await kv.get('memRolling:' + charId, null); } catch { return false; }
  if (!cur || typeof cur.text !== 'string' || !cur.text) return false;
  const upTo = Number(cur.upTo) || 0;
  if (!upTo) return false;
  const stale = removedMsgs.some(m => m && Number(m.ts) <= upTo);
  if (!stale) return false;
  try { await kv.set('memRolling:' + charId, { text: '', upTo: 0, day: 0 }); }
  catch { return false; }
  return true;
}

/**
 * 手动归档：归档 + 把这批内容整理进长期记忆。
 * 和自动任务共用同一个队列（_memBusy），避免和 prune/summarize 打架。
 */
async function runArchiveNow(onProgress, insideLock = false, maxPerRun = 0, charId = null) {
  // ⚠️ 角色必须一路透传（v1.21.25 修，复审 ★1）。
  //
  // 起因：上一版把 charId 透传到了 autoArchiveIfNeeded（它算了 cidA），
  // 但【下一跳断了】—— 这里没接形参、内部重读实时 curCharId。
  // 后果是「检查 A、归档 B」：
  //   A 有 100 条该归档、B 只有 5 条 → 发完消息切到 B →
  //   用 cidA 判定"该归档了"，实际归档的是 B → B 返回 ok:false →
  //   A 的积压永远清不掉，而 memArchiveLastAt 记在 A 名下，把问题掩盖了。
  const myCharId = charId || curCharId;
  // who 同理：原来读全局 curChar，归档别的角色时会写出错的名字。
  const who = ((charId && charId !== curCharId) ? await chars.get(charId) : curChar)?.name || '她';
  const keep = Math.max(0, Number(S.archiveKeep) || 0);

  // insideLock=true 表示调用方（runMemTasks 的自动链路）已经持有 _memBusy。
  // 这时绝不能再走 withMemLock —— 那把锁不可重入，会直接返回「忙碌中」，
  // 自动归档就永远跑不起来（实测踩到：_memBusy=true 时调进来必定返回 ok:false）。
  const body = async () => {
    const before = await msgs.list(myCharId);
    if (before.length <= keep) {
      return { ok: false, msg: `只有 ${before.length} 条，留 ${keep} 条的话没什么可归档的` };
    }
    const oldAll = before.slice(0, before.length - keep);

    // ⚠️ 单次归档量上限。
    // 起因（实测真实数据）：用户积压了 1990 条未归档、archiveKeep=40，
    // 一次要收 1950 条 —— 按每批 40 条算是 49 次 API 调用，
    // 要跑十几分钟，中途失败还只能停半路，用户根本没法用。
    // 而且这种积压是【一次性的遗留】，不是日常状态：
    // 日常聊天根本攒不到这么多，所以没必要为它放宽保留线（那会让每轮携带的历史更长，更费 token）。
    //
    // 现在每次最多收 200 条（5 批）。积压会在接下来几轮聊天里自己消化掉，
    // 用户什么都不用做。手点「归档」按钮时不受这个限制（ARHCIVE_MAX 传 0 = 不限制），
    // 因为手动操作本来就是"我现在就要它收完"。
    const capMax = (typeof maxPerRun === 'number' && maxPerRun > 0) ? maxPerRun : 0;
    const old = capMax ? oldAll.slice(0, capMax) : oldAll;

    // 分批总结：一次塞太多模型也吃不下。
    // ⚠️ 已经总结过的（memSummed 里有 id）要跳过：
    //   归档 → 全部取消归档 → 再归档 时，「保留最近 N 条」切出来的是同一段，
    //   不跳过就会把同一批对话重新总结一遍（白花 token + 记忆里出现重复条目）。
    const already = new Set(await kv.get('memSummed:' + myCharId, []) || []);
    const fresh = old.filter(m => !already.has(m.id));
    const BATCH = 40;
    const batches = [];
    for (let i = 0; i < fresh.length; i += BATCH) batches.push(fresh.slice(i, i + BATCH));

    let added = 0;
    let failAt = -1;
    let failMsg = '';
    // ⚠️ 0 产出的批次【既不记账也不归档】，但【不能阻止其他批次归档】
    //    （v1.21.35 二次修正）。
    //
    // 起因：我第一版用一个 `continue` 跳过记账 —— 结果 doneNow 只算 batches.slice(0, failAt)，
    // 而那批被排除后 doneNow 为空 → 【整轮一条都不归档】。
    // 讽刺的是本文件 L1683 的注释早就记过同一个坑：
    //   "第一版保护写成'一批 0 就整个停下'，结果把正常情况也挡了 —— 归档一条都跑不动"。
    // 我原样重犯了一遍。
    //
    // 现在用独立的 held 集合：这批留在原地（下次重试），其余照常总结+归档。
    const held = new Set();   // 这批先不动（内容还没进记忆，不能归档）
    // 连续几批零产出才认为"这批内容确实没东西可记"（v1.20.20）。
    //
    // ⚠️ 单个批次返回 0 是【正常】的：模型真的可能说"没有新的"。
    // 第一版保护写成"一批 0 就整个停下"，结果把正常情况也挡了 ——
    // e2e-archpipeline / e2e-autoarchive 立刻挂掉（归档一条都跑不动）。
    //
    // 现在改成数【连续】零产出：单批 0 继续往下走，连着 ZERO_STREAK 批都是 0
    // 才停下重试。真要丢内容得是模型【连续】抽风，那个概率远低于偶发。
    const ZERO_STREAK = 3;
    let zeroStreak = 0;
    for (let i = 0; i < batches.length; i++) {
      if (onProgress) onProgress(i + 1, batches.length, who);
      try {
        // ⚠️ 每批都回库核一遍（v1.21.52）：这段管线一跑就是十几秒到几十秒，
        // 期间用户长按删掉一条老消息完全来得及（菜单只拦 busy，归档时 busy 是 false）。
        // 而这里吃的是【归档开始那一刻的快照】—— 不核的话，被删的内容会被提炼成
        // 新的长期记忆，还会被折进滚动摘要（每轮都注入）：用户明明删了，她却记着，
        // 而且不可逆（del 那边的清理队列早就消费掉了，没有第二次机会）。
        let batch = batches[i];
        try {
          const alive = new Set((await msgs.list(myCharId, 0, true)).map(m => m.id));
          batch = batch.filter(m => alive.has(m.id));
          if (!batch.length) continue;   // 整批都被删了：跳过，也不必记进 held
        } catch { /* 读不到就按原样走，至少不比以前差 */ }
        const got = await summarizeChunk(myCharId, batch);
        // ⚠️ 返回 0 条【不推进水位】（v1.20.20 修）。
        //
        // 起因（2026-09-29 实测真实备份）：角色Q 的 memSummed 里记了 151 个 id，
        // 长期记忆却只有 1 条 —— 这 151 条被标记"看过"，内容却一条都没留下，
        // 而且因为进了 memSummed，【永远】不会再被总结。全库 2291 条消息
        // 只产出 36 条记忆，每一个角色都是这么被吃掉的。
        //
        // 0 条有两种可能：模型真的说"没有新的"，或者它这次没好好答。
        // 分不出来的时候【宁可留着下次再试】—— 重试一次的成本，
        // 远小于一批对话永久丢失。真正稳定重复的内容，下一批还是会说没有。
        // ⚠️ 【单向门】必须堵住（v1.21.35 修）—— 这是本项目丢记忆的最大单一来源。
        //
        // 起因（本文件自己的注释 + 用户真实备份双重证据）：下面那段【无条件】把整批 id
        // 记进 memSummed，而 summarizeIfNeeded 用 `!summedNow.has(m.id)` 过滤 ——
        // 一旦记账，这批对话【永远不会再被总结】。
        // 实测用户备份：3369 条消息被标记"看过"，长期记忆只有 65 条；
        //   角色B 标记 407 条 → 记忆 4 条；角色F 173 → 4；角色E 114 → 2；角色O 67 → 0。
        //
        // ZERO_STREAK=3 挡不住它：那个计数器只数【连续】3 批，
        // 中间只要有一批 got>0 就归零，前面所有 0 产出的批次已经被确认收下了。
        //
        // 现在：0 产出【不记账】，让这批下次重试。
        // ⚠️ 但要有出口 —— 有些批次内容就是重复的，模型永远回 0；
        //    给每个批次记一个重试次数，连试 3 次仍为 0 就认了并记账（否则会无限重试烧 token）。
        const retryKey = zeroRetryKey('arch', myCharId);
        if (got === 0) {
          zeroStreak++;
          const zr = (await kv.get(retryKey, {})) || {};
          // ⚠️ 计数用【角色级】而不是 per-batch 签名（v1.21.35 二次修正）。
          // 起因：第一版签名用 chunk[0].id，但每轮 chunk 划分可能不同 →
          // 计数永远累计不起来 → 退化成"永不记账" → 无限重试烧 token。
          // ⚠️ 签名必须是【per-batch 稳定】的，而且成功后要清零（v1.21.36 修，复审 P0）。
          //
          // 我 v1.21.35 的第一版用角色级单计数器 '_all'，报告实测出三重叠加缺陷：
          //   ① 计数器是角色级，不是"这一批试了几次"
          //   ② 成功后【不清零】（本函数全篇没有归零代码）
          //   ③ 放行判据 zr[sig] >= 3 却是逐批立即执行的
          // ⇒ 累计 3 个 0 产出批次后，此后【每一个】0 产出批次都一步放行，
          //    计入的还是别的批次的尝试次数。实测：模型有内容、记忆却不涨。
          //
          // 现在：签名用整批 id 的排序摘要（稳定，不受每轮切分影响）+ 成功后清零。
          // ⚠️ v1.21.38：改用 batchSig（全量 id 哈希）。
          // 原写法「长度+首id+尾id」在两个批次长度相同且首尾相同时会撞签名，导致计数串批。
          const sig = batchSig(batches[i]);
          zr[sig] = (zr[sig] || 0) + 1;
          await kv.set(retryKey, zr);
          if (zr[sig] >= ZERO_RETRY_MAX) {
            // 试够了：认为这批确实没东西可记，记账放行
            const acc0 = new Set(await kv.get('memSummed:' + myCharId, []) || []);
            for (const mm of batches[i]) acc0.add(mm.id);
            await kv.set('memSummed:' + myCharId, [...acc0]);
            console.warn('[记忆总结] 第', i + 1, '批连续', ZERO_RETRY_MAX, '次没提炼出内容，按\u201c确实没有\u201d记账放行');
          } else {
            held.add(i);   // ← 留待下次重试：不记账、本轮也不归档
            console.warn('[记忆总结] 第', i + 1, '批没提炼出内容（第', zr[sig], '次），本次不记账、留待下次重试');
          }
          if (zeroStreak >= ZERO_STREAK) {
            failAt = i - ZERO_STREAK + 1;
            failMsg = '连着 ' + ZERO_STREAK + ' 批都没提炼出记忆，先停下（下次会重试）';
            break;
          }
          continue;   // ← 关键：0 产出时跳过下面的记账
        }
        zeroStreak = 0;
        added += got;
        // ⚠️ 成功必须把重试计数清零（v1.21.36 修，复审 P0）。
        // 起因：v1.21.35 只写了"试满放行"，忘了归零 ——
        // 于是累计到 3 之后，此后每一个 0 产出批次都直接放行。
        // 对照 summarizeIfNeeded 那边是有的（kv.set(rk, {})），两处口径必须一致。
        try { await kv.set(retryKey, {}); } catch { /* 清不掉不影响正确性 */ }
        // 只有【真的提炼出内容】才把"总结到哪"往前推。
        const acc = new Set(await kv.get('memSummed:' + myCharId, []) || []);
        for (const mm of batches[i]) acc.add(mm.id);
        // 不截断：id 很短，几千个也就几十 KB。
        // 以前限 500 是错的 —— 被挤掉的 id，它对应的消息还在库里，
        // 下次归档会被当成"没总结过"再总结一遍（实测 700 条时重复调用 5 次）。
        await kv.set('memSummed:' + myCharId, [...acc]);
      } catch (err) {
        // 这一批没成功，就停在这儿：后面的不再处理，
        // 而这批也不会被记进 memSummed、不会被归档（见下面的 okMsgs）。
        failAt = i;
        failMsg = (err && err.message) || String(err);
        break;
      }
    }

    // 归档范围 = old 里"已经总结好了"的那些。两件事要分开看：
    //   · 本轮新总结成功的（fresh 的前几批）
    //   · 之前就总结过的（fresh 之外、已进 memSummed 的）—— 它们不需要再总结，
    //     但同样该被归档，否则"取消归档再归档"会只剩下一部分被收起来。
    // ⚠️ 排除 held（0 产出、内容还没进记忆的批次）—— 它们必须留在原地。
    const doneBatches = (failAt < 0 ? batches : batches.slice(0, failAt))
      .filter((_, idx) => !held.has(idx));
    const doneNow = failAt < 0 ? doneBatches.flat() : doneBatches.flat();
    const doneNowIds = new Set(doneNow.map(m => m.id));
    let okMsgs = old.filter(m => doneNowIds.has(m.id) || already.has(m.id));
    // ⚠️ 折进滚动摘要之前再核一次（v1.21.52）：同上，删掉的消息不该被折进去。
    // 这里特别隐蔽 —— msgs.archive 对被删的 id 是 no-op（db.js 里的 if (m) 护卫），
    // 所以界面上看不出任何异常，只有摘要里悄悄驮着一段用户已经删掉的话。
    try {
      const alive2 = new Set((await msgs.list(myCharId, 0, true)).map(m => m.id));
      okMsgs = okMsgs.filter(m => alive2.has(m.id));
    } catch { /* 同上 */ }
    if (okMsgs.length) {
      await msgs.archive(okMsgs.map(m => m.id));
      // 归档 = 这段对话从此不再进入上下文。折进滚动摘要，让她【仍然记得】。
      // ⚠️ 顺序不能反：先 archive 再 fold。fold 里如果调模型失败，
      //    消息已经收好了；反过来则可能摘要写了、归档没成，两处对不上。
      // ⚠️ 失败不影响归档结果：foldIntoRolling 内部自己兜底，不往外抛。
      try { await foldIntoRolling(myCharId, okMsgs); }
      catch (err) { console.error('[滚动摘要] 折叠失败（归档已完成，不影响）：', err); }
    }

    if (failAt >= 0) {
      // 失败了也要把节奏对齐：已总结的记上账，剩下的下次继续。
      // ⚠️ 用条数语义（v1.21.25）：以前这里写的是 seqNow - 1，量纲错。
      try { await kv.set('memDedupeAt:' + myCharId, (await mem.list(myCharId)).length); } catch { /* 同上 */ }
      return { ok: false, partial: true, archived: okMsgs.length, added,
               msg: `第 ${failAt + 1}/${batches.length} 批没整理成功（${failMsg}），`
                  + `已归档前面 ${okMsgs.length} 条，剩下的留在原处，解决了再点一次` };
    }

    // 计数从 0 重算：把"上次归档位置"设成当前累计序号，
    // 之后要再攒够间隔才会触发下一次自动动作。
    const seq = await getMsgSeq(myCharId);
    // ⚠️ memSumAt 【不能】在这里写（2026-09-26 修）。
    //
    // memSumAt 的语义是「上次总结到第几条」（条数），而这行原来写的是 seq（累计序号）——
    // 两者量纲完全不同，互相覆盖：
    //   · 归档完成 → 写入序号（比如 365）
    //   · 总结成功 → 写入条数（比如 20）
    // 读取侧 summarizeIfNeeded 有个护栏（sumRaw <= liveAll.length + pendingNow.length
    // 才认），只能挡住"序号远大于条数"的情况。**序号恰好接近条数时挡不住** ——
    // 于是 pendingNow.length - lastSum 变成 0 或负数，永远 < 阈值，总结永久卡死。
    // 实测用户数据：角色G 70 条待总结，memSumAt 被写成 22，正好卡在阈值边缘。
    //
    // 正确做法：归档不该碰任何**记忆节奏**的水位。
    //
    // ⚠️ 这段话上一版是错的（v1.21.25 修，复审 ★5）：它写"memDedupeAt 本来就是
    // 序号语义"，但实际上全项目有 5 处写的是【条数】、只有归档这 2 处写 seq ——
    // 真正统一的是条数语义。归档写 seq 反而制造了量纲冲突：
    //   · 归档后 lastLen=200 → grew = 12-200 = -188 恒为负 → 自动查重永久卡死
    //   · 而上一版的"猜"（值大于条数就当序号）只掩盖了症状，还带来反向副作用：
    //     猜成序号后 grew=null → grownEnough 恒真 → 归档后必多跑一次整理。
    //
    // 归档要表达的"别再立刻触发"，现在用【条数语义】写回去：
    // 记下归档结束那一刻的记忆条数，下次 grew 从这儿算起。
    //
    // ⚠️ 这里必须写条数、不能像以前那样写 seq（v1.21.25 定稿）：
    // seq 会让 grew 恒为负；而【完全不写】又会让归档后立刻再跑一次整理 ——
    // 归档内部本来就会总结一批，那一批会新增记忆，紧接着查重又触发。
    // e2e-memsum 场景 6 就是抓这个的（记忆 1 变 2）。
    try {
      await kv.set('memDedupeAt:' + myCharId, (await mem.list(myCharId)).length);
    } catch { /* 水位写不进去不影响归档结果 */ }
    // 附带的排查用时间戳（autoArchiveIfNeeded 会单独写一次，这里手动路径也记一笔）
    await kv.set('memArchiveLastAt:' + myCharId, Date.now());
    // ⚠️ memArchiveAt 目前没有任何读取点 —— 是为以后的「自动滚动归档」预留的锚点
    //    （用户已确认要那个功能：超过保留数就自动收，不用手点）。
    //    在那之前它只是个占位的死键，清理逻辑里带着它只是为了将来省事。
    await kv.set('memArchiveAt:' + myCharId, seq);

    // ⚠️ 报的必须是【真正收起来的条数】（v1.21.54，审计发现）。
    // 原来报 old.length（本轮全部候选），而里面有一部分可能进了 held
    // （模型对那批返回 0 条、内容还没进记忆，必须留在原地）——
    // 于是 toast 说「已归档 200 条」而实际只收走 160 条，
    // 归档提示里又还能看到「40 条可归档」，两个数字自相矛盾，用户以为省了 token 其实没收走。
    return { ok: true, archived: okMsgs.length, batches: batches.length, added, kept: keep };
  };
  return insideLock ? await body() : await withMemLock(body);
}

/**
 * 自动滚动归档：未归档条数超过「保留最近多少条」时，自动把最早的收起来。
 *
 * 为什么需要它：
 *   在 v1.13.0 之前，全项目只有「归档并整理进长期记忆」那一个按钮会调 runArchiveNow，
 *   自动链路（runMemTasks）只做 prune / summarize / dedupe —— summarize 会把对话
 *   变成记忆，但消息本体永远留在可见列表里。结果就是：攒了几百条也不会自动归档，
 *   每轮聊天都要把这几百条重复发出去。memArchiveAt 这个键当时只是"为将来预留"。
 *
 * 冷却用 memArchiveAt（累计序号水位）：归档完把水位推到当前 seq，
 * 之后要再攒够「保留数」才会触发下一次，不会每发一条消息都归档一遍。
 * 走 withMemLock 复用同一把锁，避免和 prune/summarize 并发改同一份数据。
 *
 * @returns {Promise<{ran:boolean, archived?:number, added?:number, reason?:string}>}
 */
// 单次自动归档最多收多少条（见 runArchiveNow:old 那段的说明）。
// 200 = 5 批，约十几秒；积压会在接下来几轮里自己消化完。
const AUTO_ARCHIVE_MAX = 200;

async function autoArchiveIfNeeded(charId = null) {
  // ⚠️ 角色显式传入（v1.21.24 修，审计第 20 条）：send() 冻结了 myCharId，
  // 但这批任务可能在切角色之后才轮到，读实时 curCharId 会归档错人。
  const cidA = charId || curCharId;
  if (!cidA) return { ran: false, reason: '没选角色' };
  if (S.autoArchive === false) return { ran: false, reason: '开关关着' };

  const myCharId = cidA;
  const keep = Math.max(0, Number(S.archiveKeep) || 0);
  const before = await msgs.list(myCharId);
  // 没超过保留数就什么都不做 —— 这是最常见的情况，必须放在最前面，零开销
  if (before.length <= keep) return { ran: false, reason: '没超过保留数' };

  // ⚠️ 护栏：自定义记忆把上限占满时，归档注定腾不出位置（v1.21.29 加，复审 新12）。
  //
  // 起因：两处各自的"正确设计"撞在一起 ——
  //   · dedupe 拒绝整理（不许模型动用户的记忆，allowEditMine=false 时保护 mine）
  //   · summarizeChunk 要求 room > 0（腾不出位置就别假装总结成功）
  // 但没人处理「腾位置的手段被永久拒绝」这个组合态：
  //   mine >= memLimit → dedupe return 0 → room = 0 → 抛「记忆已满」→ 归档 break。
  // 子代理四组对照实测：her=15/mine=10 归档收完 445→55，唯独 mine=25 那组停摆。
  //
  // 当前用户数据最多 10 条 mine（未达 memLimit=25 阈值），属【潜伏风险】。
  // 这里把"静默停摆"变成"可诊断状态"：不修好归档，但至少说清楚为什么。
  // ⚠️ 绝不能为此删掉 dedupe 里保护 mine 的那段 —— 那是防模型改写用户记忆的正确行为。
  try {
    // ⚠️ 用【目标角色】而不是全局 curChar（v1.21.30 修，复审新4）。
    // 同函数上面已经有 myCharId = cidA（发送时冻结的角色），
    // 而这里读全局 curChar 会在"归档跑完前切角色"时用错人的设置。
    // 对照：summarizeChunk 的写法是对的 —— (await chars.get(charId)) || curChar。
    const P0 = effSettings((await chars.get(myCharId)) || curChar, S);
    if (!P0.allowEditMine) {
      const allMem = await mem.list(myCharId);
      const mineN = allMem.filter(x => x.mine).length;
      const lim = S.memLimit || 20;
      // ⚠️ 判据要和真正干活的 room 同源（v1.21.36 修，复审 #4 —— 连续 2 轮未修）。
      //
      // 起因：真实停摆条件是 `mineN + curWritable >= lim`，而这里判的是 `mineN >= lim`。
      // mineN = lim-1 时护栏【放行】，但进到 summarizeChunk 后 room = totalCap - curWritable = 0
      // → 抛一句晦涩的「记忆已满（1/1，另有 9 条自定义记忆受保护）」。
      // 实测（memLimit=10, mine=9/ai=0）：只消化 40/120 条就卡住。
      //
      // 现在判 roomForAI - curWritable <= 0，与 summarizeChunk 的 room 完全一致。
      const curWritable = allMem.filter(x => !x.mine).length;
      const roomForAI = Math.max(0, lim - mineN);
      if (roomForAI - curWritable <= 0) {
        toast('你的「自定义记忆」占满了可写名额（自己 ' + mineN + ' 条 + 她那边 ' + curWritable + ' 条 = '
              + (mineN + curWritable) + '/' + lim + '），'
              + '归档需要腾位置但腾不出来 —— 先删几条自定义记忆再试。', 6000);
        return { ran: false, reason: '自定义记忆占满可写名额' };
      }
    }
  } catch { /* 护栏自己出错不该挡住归档 */ }
  // 防抖不靠 msgSeq 水位 —— 那个数只统计"这个 app 发出去的条数"，
  // 导入/老数据里的消息不会让它涨，用它当冷却会把归档永远挡在门外（实测踩到）。
  // 这里改成看"归档进度"：_archiving 保证同一时刻只跑一趟，
  // 而归档一次就会把未归档条数压到 keep，天然不会连着重复跑。
  if (_archiving) return { ran: false, reason: '归档进行中' };

  _archiving = true;
  try {
    // insideLock=true：runMemTasks 已经握着 _memBusy 了。
    // 第三个参数 200 = 单次自动归档上限（见 runArchiveNow 里的说明）。
    // 积压会分几轮消化掉，不会一口气跑 49 批把用户晾在那儿。
    const res = await runArchiveNow(null, true, AUTO_ARCHIVE_MAX, cidA);   // ★1：透传目标角色
    if (!res || !res.ok) return { ran: false, reason: (res && res.msg) || '归档没做成' };
    // runArchiveNow 成功时已经把 memArchiveAt 推到当前 seq 了（见函数尾部）。
    // 附带记一下"上次自动归档的时间"，纯为排查用，不参与判断。
    await kv.set('memArchiveLastAt:' + myCharId, Date.now());
    return { ran: true, archived: res.archived, added: res.added };
  } finally { _archiving = false; }
}

/**
 * 按指定角色压缩记忆（dedupeIfNeeded 绑定的是全局 curCharId，
 * 而归档可能正在处理别的角色，所以单独抽一个出来）。
 * 只管压缩，不碰节奏计数。
 */
async function dedupeFor(charId, reason = '') {
  // 薄封装：真正干活的是 dedupeIfNeeded（唯一实现，避免两份逻辑漂移）。
  // force=true 立刻跑；noTick=true 表示"别动节奏水位"，由调用方自己记账。
  // reason='makeRoom' 表示"归档腾位置"，那条路允许把记忆压得很狠（有后续写入兜底）。
  return await dedupeIfNeeded(true, charId, true, reason);
}

/**
 * 软上限裁剪：条数超了就按频次优先级丢，而不是一刀切截断。
 * 丢的顺序：once → normal → often → pinned（pinned 最后才动）。
 * 返回时保持原有顺序，只是少了末尾被丢的那些。
 */
function trimByFreq(items, limit) {
  if (items.length <= limit) return items;
  const keep = new Set(
    items.map((it, i) => ({ i, r: freqRank(it) }))
      .sort((a, b) => (b.r - a.r) || (a.i - b.i))      // 优先级高的在前，同级保持原序
      .slice(0, limit)
      .map(x => x.i)
  );
  return items.filter((_, i) => keep.has(i));
}

// ================= 世界书 =================
// 三套库，相互独立：
//   · 角色组（全局设置里的组）—— 角色【在组里】才生效；不在任何组 = 完全不受影响
//   · 单独角色 —— 只管那一个角色，和全局平行、互不影响
//   · 两者都由「是否启用世界书」总开关控制（关掉就全不注入）
//
// 匹配方式：拿【最近若干条对话文本】去撞每条目的触发词，命中就整条注入。

const WB_LOOKBACK = 6;   // 往回看几条消息（太多会让触发词长期挂着不消失）

/**
 * 世界书命中的【滞回】缓存（v1.20.20 新增，治"缓存突然从 11000 掉到 6000"）。
 *
 * 起因（2026-09-29 实测 角色Q 195 轮的真实 usage）：
 *   命中集一变，buildTurnNote 里【世界书之后】的整段就全部重算。
 *   9 个异常轮的 prompt_cache_hit_tokens 恰好停在 6784 / 6144 ——
 *   正好是"稳定前缀 + 历史 + clock + rolling"的长度，也就是世界书之前那一段。
 *   每轮白花 4000~5800 token。
 *
 * 为什么命中集会抖：匹配文本是「用户这句 + 最近 6 条」拼起来的。
 *   角色Q 有 347 个触发词，光「他」这种单字词命中面就极广。
 *   用户说 6 个字和说 20 个字，处在边界的条目就会进进出出。
 *
 * 治法：本轮命中的记下来，【下一轮继续带上】，最长留 WB_HOLD 轮。
 *   这样集合只会缓慢变化，不再一个字一个字地抖。
 *   代价：话题过去后条目还会多挂一两轮 —— 那是刻意的，省下的 token 远大于多注入的。
 *
 * ⚠️ 缓存按角色分开：切角色时不能把上一个角色的条目带过来。
 */
const WB_HOLD = 2;              // 命中后额外保留几轮
let _wbHold = { charId: null, map: new Map() };   // key = 标题，value = { title, content, left }

/** 收集某个角色当前该生效的世界书条目（已启用 + 已命中） */
async function worldbookHits(charId, recentText) {
  if (S.worldbookOn === false) {
    // ⚠️ 关掉总开关时要【清空滞回缓存】（v1.21.24 修）：
    // 不清的话，关掉再打开，上次留下的条目会复活注入。
    _wbHold.map.clear();
    return [];
  }
  if (!charId) return [];
  if (_wbHold.charId !== charId) _wbHold = { charId, map: new Map() };
  const out = [];
  const hitNow = new Set();
  // ⚠️ 另建一张【全量活表】（v1.21.29 修，复审 新7）。
  //
  // 起因：下面的续期逻辑原来只从 `out`（本轮命中集）建表，而它循环的 `k`
  // 恰恰是【本轮未命中】的条目 → nowContent 恒为 undefined → 必然 delete →
  // 滞回（WB_HOLD / v.left--）【从生效过】，是空转代码。
  // 实测：aa 轮注入 A，bb 轮注入 B 且 A 立刻消失（本应再留 2 轮）。
  // 现在 push 时顺手把"存在且开着"的条目都记进 liveAll，续期从那里面取。
  // value 存【整条条目】而不是 content 快照（v1.21.51）：续期时 pos 也要回取，
  // 否则把一条从「背景」改成「临场」后，它还会按旧档位注 2 轮。
  const liveAll = new Map();
  // ⚠️ key 必须用【e.id】，不能用 title（v1.21.34 修，复审 新3）。
  //
  // 起因：两个【不同条目同名】时，liveAll / _wbHold 里互相顶掉，滞回计数被反复重置。
  // 实测（两个同名条目，keys 分别是「苹果」「香蕉」，WB_HOLD=2）：
  //   第 3 轮甲该过期却不过期；第 5 轮【从未命中过的乙】被注入。
  //
  // ⚠️ 极易触发：下面的兜底标题就是 '角色组' / '单独设定' ——
  //    任何两条没写 title 的条目都会撞名。
  const push = (entries, title) => {
    for (const e of (entries || [])) {
      if (!e || e.on === false || !e.content) continue;
      // 常驻条目（pos === 'always'）进的是稳定前缀，见 worldbookConst（v1.21.51）
      if (e.pos === 'always') continue;
      if (!(e.keys || []).length) continue;
      const key = e.id || e.title || title;   // ← 隔离用 id；title 只用于显示
      const t = e.title || title;
      liveAll.set(key, e);
      if (hitKeys(e.keys, recentText)) {
        hitNow.add(key);
        out.push({ title: t, content: e.content, key, pos: e.pos || '' });
      }
    }
  };
  // 1) 角色组：只要它在组里，该组的条目就生效；不在任何组则不参与
  try {
    const groups = await wb.groups();
    for (const g of groups) {
      if ((g.members || []).includes(charId)) push(g.entries, g.name || '角色组');
    }
  } catch (e) { /* 读不到就当没有，别让聊天崩 */ }
  // 2) 单独角色：和全局平行，互不影响
  try {
    const solo = await wb.solo(charId);
    if (solo) push(solo.entries, '单独设定');
  } catch (e) { /* 同上 */ }
  // —— 滞回（v1.20.20）：本轮命中的续期，上一轮留下还没过期的接着带上 ——
  // 没有它时，用户说 6 个字还是 20 个字就能让边界条目进进出出，
  // 而 buildTurnNote 里世界书【之后】的整段会跟着全部重算（实测每轮多花 4000~5800 token）。
  //
  // ⚠️ 续期时【必须回库重取内容】（v1.21.24 修，审计第 11 条）。
  //
  // 起因：原来缓存的是 {title, content} 快照，续期直接 push 那份副本 ——
  // 于是改过的条目还会注 2 轮旧内容、删掉的条目照注 2 轮、
  // 关掉再开总开关（提前 return，不清缓存）旧条目还会复活。
  // 实测证据：库里已改成「他其实讨厌苹果」，注入的仍是「他喜欢红苹果」。
  //
  // 现在只缓存 title；续期时先确认这条【现在还存在、还开着】，再取当前内容。
  for (const h of out) _wbHold.map.set(h.key, { key: h.key, title: h.title, left: WB_HOLD });
  for (const [k, v] of [..._wbHold.map]) {
    if (hitNow.has(k)) continue;          // 本轮自己命中了，上面已经 push 过
    const now = liveAll.get(k);           // ← 用全量活表，不是本轮命中集
    if (now === undefined) { _wbHold.map.delete(k); continue; }   // 条目没了/关了就丢
    if (v.left <= 0) { _wbHold.map.delete(k); continue; }
    v.left--;
    out.push({ title: (v && v.title) || k, content: now.content, key: k, pos: now.pos || '' });
  }
  return out;
}

/**
 * 收集某个角色【常驻】的世界书条目（pos === 'always'，v1.21.51）。
 *
 * 和 worldbookHits 的分工：那些靠触发词命中、每轮可能不同 —— 只能进「本轮段」，
 * 进了稳定前缀就等于每轮让缓存失效。常驻条目每轮都在、内容不变，所以能进稳定前缀，
 * 她也会把它当铁律（见 persona.js 的 buildStablePrompt）。
 *
 * ⚠️ 因此输出【必须只取决于库里的内容】：同一个库要给出同样的结果。
 *    不能掺时间、随机数、命中集 —— 掺了前缀缓存就没了。
 */
async function worldbookConst(charId) {
  if (S.worldbookOn === false || !charId) return [];
  const out = [];
  const take = (entries, title) => {
    for (const e of (entries || [])) {
      if (!e || e.on === false || !e.content) continue;
      if (e.pos !== 'always') continue;
      out.push({ title: e.title || title, content: e.content, key: e.id || title, pos: 'always' });
    }
  };
  // 顺序必须稳定（组顺序 → 组内顺序 → 单独角色），否则前缀每轮都在变
  try {
    const groups = await wb.groups();
    for (const g of groups) {
      if ((g.members || []).includes(charId)) take(g.entries, g.name || '角色组');
    }
  } catch (e) { /* 读不到就当没有，别让聊天崩 */ }
  try {
    const solo = await wb.solo(charId);
    if (solo) take(solo.entries, '单独设定');
  } catch (e) { /* 同上 */ }
  return out;
}

/** 触发词命中判定：任意一个触发词出现在文本里就算命中（不区分大小写） */
function hitKeys(keys, text) {
  if (!text) return false;
  const t = String(text).toLowerCase();
  for (const k of keys) {
    const kk = String(k || '').trim().toLowerCase();
    if (kk && t.includes(kk)) return true;
  }
  return false;
}


// ================= 世界书 · 界面 =================
// 用户要的流程：
//   设置抽屉 → 世界书 → [总开关] + [全局设置] + [单独角色]
//   全局设置 → 一组组的角色组（未入组的角色不受影响）
//   点组名 → 编辑该组条目；点「组列自定义」→ 弹窗改成员/组名（可删组）
//   单独角色 → 弹窗选角色 → 编辑该角色的独立条目

let _wbTimer = null;   // 输入防抖（组名/条目内容）

/** 抽屉菜单项（点击后跳到对应界面）*/
// t / s 存的是 i18n 的 key，渲染时过一遍 t()。
//
// v1.21.61 重排：原来只有「全部设置」和「我的相关设定」两个入口 ——
// 前者把什么都塞进去（越滚越长），后者点进去其实也是设置页，等于两个入口指同一个地方。
// 现在按「管她的」和「管你的」分开：
//   全局设置 = 接口 / 描写与表达 / 写字台 / 记忆管理 / 联网搜索 / 已记住的事 / 时段划分
//   我的设置 = 我的头像 / 外观 / 数据 / 角色卡
const DRAWER_ITEMS = [
  { k: 'worldbook', ico: '📖', t: 'drawer.worldbook', s: 'drawer.worldbook.s' },
  { k: 'chars',     ico: '☰', t: 'drawer.chars',     s: '' },
  { sep: true },
  { k: 'settings',  ico: '⚙', t: 'drawer.global',    s: 'drawer.global.s' },
  { k: 'mine',      ico: '👤', t: 'drawer.mine',      s: 'drawer.mine.s' },
  { sep: true },
  { k: 'about',     ico: 'ⓘ', t: 'drawer.about',     s: 'drawer.about.s' },
];

function renderDrawerMenu() {
  const box = $('drawer-menu');
  if (!box) return;
  box.innerHTML = DRAWER_ITEMS.map((it, i) => {
    if (it.sep) return '<div class="drawer-sep"></div>';
    return '<button class="drawer-item" data-wb-drawer="' + it.k + '">'
      + '<span class="di-ico">' + it.ico + '</span>'
      + '<span>' + t(it.t) + '</span>'
      + (it.s ? '<span class="di-sub">' + t(it.s) + '</span>' : '')
      + '</button>';
  }).join('');
  box.querySelectorAll('[data-wb-drawer]').forEach(btn => {
    btn.onclick = async () => {
      const k = btn.dataset.wbDrawer;
      if (k === 'worldbook') { await renderWorldbook(); showView('worldbook'); }
      else if (k === 'settings') { bindSettings(); showView('settings'); }
      else if (k === 'chars') { await renderCharList(); showView('chars'); }
      // 「我的设置」和「全局设置」是同一批 DOM，所以还是 bindSettings()；
      // 只是显示哪个 view 不同。
      else if (k === 'mine') { bindSettings(); showView('mine'); }
      else if (k === 'about') { renderAbout(); showView('about'); }
    };
  });
}

function openDrawer() { renderDrawerMenu(); showView('drawer'); }

// ---------- 世界书总览 ----------
async function renderWorldbook() {
  const on = S.worldbookOn !== false;
  const box = $('s-wb-on');
  if (box) box.checked = on;
  // 「全局设置 / 单独角色」只在总开关打开时可点（关着是灰的）
  for (const id of ['btn-wb-global', 'btn-wb-solo']) {
    const el = $(id);
    if (!el) continue;
    el.disabled = !on;
    el.classList.toggle('disabled', !on);
  }
  const eg = $('wb-entry-group');
  if (eg) eg.classList.toggle('disabled', !on);
  // 副标题：让用户不点进去也知道有多少东西
  try {
    const gs = await wb.groups();
    const sub = $('wb-global-sub');
    if (sub) sub.textContent = gs.length ? (gs.length + ' 个角色组') : '还没建角色组';
    const ss = await wb.soloAll();
    const s2 = $('wb-solo-sub');
    if (s2) s2.textContent = ss.length ? (ss.length + ' 个角色有单独设定') : '给某一个角色单独写设定';
  } catch (e) { /* 读不到不影响打开页面 */ }
}

// ---------- 全局设置：角色组列表 ----------
async function renderWbGroups() {
  const box = $('wb-group-list');
  if (!box) return;
  let gs = [];
  try { gs = await wb.groups(); } catch (e) { gs = []; }
  if (!gs.length) {
    box.innerHTML = '<div class="wb-group-empty">还没有角色组。<br>点下面的按钮建一个，把同一批角色放进去。</div>';
    return;
  }
  box.innerHTML = gs.map(g => {
    const n = (g.members || []).length;
    const en = (g.entries || []).length;
    const names = (g.members || []).map(id => {
      const c = allChars.find(x => x.id === id);
      return c ? c.name : null;
    }).filter(Boolean);
    const preview = names.length ? names.slice(0, 4).join('、') + (names.length > 4 ? ' 等' : '') : '（没有成员）';
    return '<div class="wb-group" data-wb-g="' + esc(g.id) + '">'
      + '<div class="wg-body">'
      +   '<div class="wg-name">' + esc(g.name || '未命名') + '</div>'
      +   '<div class="wg-meta">' + n + ' 人 · ' + en + ' 条 · ' + esc(preview) + '</div>'
      + '</div>'
      + '<button class="wg-custom" data-wb-custom="' + esc(g.id) + '">组列自定义</button>'
      + '</div>';
  }).join('');
  // 点组名（整行，但避开自定义按钮）→ 进条目编辑
  box.querySelectorAll('.wb-group').forEach(row => {
    row.onclick = async (e) => {
      if (e.target.closest('[data-wb-custom]')) return;   // 自定义按钮自己处理
      await openWbEntries(row.dataset.wbG);
    };
  });
  box.querySelectorAll('[data-wb-custom]').forEach(b => {
    b.onclick = (e) => { e.stopPropagation(); openGroupEditor(b.dataset.wbCustom); };
  });
  bindGroupDrag(box);
}

// ---------- 长按拖动排序 ----------
// 交互：长按 500ms 进入"拖动模式"（本人抬起 + 边框高亮 + 轻微放大），
// 然后手指上下移动换位置；松手保存顺序。
//
// 为什么要长按才拖：直接拖会和"点一下进编辑"打架 —— 手指稍微一动就被判成拖动，
// 用户根本点不进组里。长按把两种意图分开，是移动端列表排序的通行做法。
let _drag = null;        // { el, ghostY, ids, startY }

function bindGroupDrag(box) {
  const rows = [...box.querySelectorAll('.wb-group')];
  rows.forEach(row => {
    let timer = null;
    let armed = false;        // 已进入拖动模式
    let startY = 0;
    let moved = false;

    const clear = () => { clearTimeout(timer); timer = null; };

    const beginArm = (y) => {
      if (armed) return;
      armed = true;
      startY = y;
      moved = false;
      row.classList.add('dragging');
      if (navigator.vibrate) { try { navigator.vibrate(12); } catch (e) {} }
    };

    const endDrag = async () => {
      clear();
      if (!armed) return;
      armed = false;
      row.classList.remove('dragging');
      document.querySelectorAll('.wb-group.drag-over').forEach(x => x.classList.remove('drag-over'));
      const ids = [...box.querySelectorAll('.wb-group')].map(x => x.dataset.wbG);
      if (moved) {
        try { await wb.reorderGroups(ids); toast('顺序已保存', 1600); }
        catch (e) { toast('保存顺序失败：' + ((e && e.message) || e), 3200); }
      }
    };

    // 长按计时：touchstart / pointerdown 都挂（不同 WebView 触发情况不同）
    const onDown = (e) => {
      if (e.target.closest('[data-wb-custom]')) return;   // 「组列自定义」按钮不参与拖动
      const y = (e.touches && e.touches[0] ? e.touches[0].clientY : e.clientY) || 0;
      startY = y;
      clear();
      // 进入拖动模式后把 move/up 挂到 document —— 挂在行自身上，
      // 鼠标/手指一移出行范围事件就断了，"拿起来放不下"（实测踩到）
      timer = setTimeout(() => {
        beginArm(y);
        document.addEventListener('mousemove', docMove);
        document.addEventListener('mouseup', docUp);
        document.addEventListener('touchmove', docMove, { passive: false });
        document.addEventListener('touchend', docUp);
        document.addEventListener('touchcancel', docUp);
      }, 500);
    };
    const docMove = (e) => { onMove(e); };
    const docUp = () => {
      document.removeEventListener('mousemove', docMove);
      document.removeEventListener('mouseup', docUp);
      document.removeEventListener('touchmove', docMove);
      document.removeEventListener('touchend', docUp);
      document.removeEventListener('touchcancel', docUp);
      endDrag();
    };

    const onMove = (e) => {
      const y = (e.touches && e.touches[0] ? e.touches[0].clientY : e.clientY) || 0;
      if (!armed) {
        // 还没进拖动模式就滑动了 → 当作滚动页面，取消长按
        if (Math.abs(y - startY) > 10) clear();
        return;
      }
      e.preventDefault && e.preventDefault();
      moved = true;
      // 找手指落在哪一行上，把它和当前行换位。
      // ⚠️ 用"最近的一行"而不是"严格在行矩形内" —— 手指在行与行的间隙、
      //    或者拖过了最后一行的一半、拖到列表外面时，严格判定会一个都命中不了，
      //    表现就是"能拿起来但放不下去"（实测踩到）。
      const others = [...box.querySelectorAll('.wb-group')].filter(x => x !== row);
      let target = null, best = Infinity;
      for (const o of others) {
        const r = o.getBoundingClientRect();
        const mid = r.top + r.height / 2;
        const d = Math.abs(y - mid);
        if (d < best) { best = d; target = o; }
      }
      // 只有手指确实靠近某一行（在它上下半个行高之内）才换位，避免远处乱跳
      if (target && best < 90) {
        const r1 = row.getBoundingClientRect();
        const r2 = target.getBoundingClientRect();
        if (r1.top < r2.top) target.after(row); else target.before(row);
      }
      document.querySelectorAll('.wb-group.drag-over').forEach(x => x.classList.remove('drag-over'));
      row.classList.add('drag-over');
    };

    row.addEventListener('touchstart', onDown, { passive: true });
    row.addEventListener('mousedown', onDown);
    // 没进入拖动模式时的滑动 = 滚动列表，在 onMove 里会取消长按
    row.addEventListener('touchmove', onMove, { passive: false });
  });
}

// ---------- 弹窗：选角色（新建组 / 组列自定义 共用同一个） ----------
// ★ 两处复用同一个弹窗组件，只是标题和初始选中不同（用户明确要求）
//   opts = { title, name, selected:[charId], onOk(name, ids), onDelete }
function openCharPicker(opts) {
  const o = opts || {};
  let sel = new Set(o.selected || []);
  const list = allChars.slice();
  if (!list.length) { toast('还没有角色，先去建一个'); return; }
  const rows = list.map(c => {
    const on = sel.has(c.id);
    return '<div class="pick-row' + (on ? ' on' : '') + '" data-pk="' + c.id + '">'
      + '<span class="pk-box">✓</span>'
      + '<span class="pk-name">' + esc(c.name) + '</span>'
      + '</div>';
  }).join('');
  // 复用通用 modal：它有 modal-title / modal-text / modal-ok / modal-cancel
  const m = $('modal');
  $('modal-title').textContent = o.title || '选择角色';
  $('modal-ok').textContent = '确定';
  $('modal-cancel').textContent = '取消';
  $('modal-text').innerHTML =
    '<button class="pick-all" id="pk-all">全选</button>'
    + '<div class="pick-list" id="pk-list">' + rows + '</div>'
    + '<label class="field" style="margin-bottom:0"><span>组列名称</span>'
    + '<input type="text" id="pk-name" placeholder="比如：东方幻想乡" value="' + esc(o.name || '') + '"></label>'
    + (o.onDelete ? '<button class="danger-btn" id="pk-del" style="margin-top:14px">删除这个组</button>' : '');
  m.classList.remove('hidden');

  const allBtn = $('pk-all');
  const syncAll = () => {
    allBtn.textContent = (sel.size === list.length && list.length) ? '取消全选' : '全选';
  };
  syncAll();
  // 全选/全不选：同一个按钮切换（用户明确要求）
  allBtn.onclick = () => {
    if (sel.size === list.length) sel.clear();
    else list.forEach(c => sel.add(c.id));
    document.querySelectorAll('#pk-list .pick-row').forEach(r => {
      r.classList.toggle('on', sel.has(r.dataset.pk));
    });
    syncAll();
  };
  document.querySelectorAll('#pk-list .pick-row').forEach(r => {
    r.onclick = () => {
      const id = r.dataset.pk;
      if (sel.has(id)) sel.delete(id); else sel.add(id);
      r.classList.toggle('on', sel.has(id));
      syncAll();
    };
  });
  const done = (v) => {
    m.classList.add('hidden');
    $('modal-ok').onclick = null;
    $('modal-cancel').onclick = null;
    if (allBtn) allBtn.onclick = null;
    return v;
  };
  $('modal-cancel').onclick = () => done(false);
  $('modal-ok').onclick = async () => {
    const nm = ($('pk-name').value || '').trim();
    if (!nm) { toast('给这个组起个名字吧'); return; }
    const ids = [...sel];
    done(true);
    if (o.onOk) await o.onOk(nm, ids);
  };
  const delBtn = $('pk-del');
  if (delBtn && o.onDelete) {
    delBtn.onclick = async () => {
      done(true);
      await o.onDelete();
    };
  }
}

// ---------- 新建角色组 ----------
function openGroupCreator() {
  openCharPicker({
    title: '新建角色组', name: '', selected: [],
    onOk: async (nm, ids) => {
      // ⚠️ 新建组要给它一个 order（v1.21.32 修，复审 #10）——
      // 起因：db.js 的 wb.groups() 把 order 非数字【按 0 算】，于是新组永远排最前：
      //   已有 组一(1)/组二(2)/组三(3) → 新建「新组X」→ 新组X, 组一, 组二, 组三。
      // 这与 v1.21.24 修过的 reorderGroups 是同一根因的漏网之鱼（那次只修了拖拽路径）。
      const _gs = await wb.groups();
      const _maxOrder = _gs.reduce((m, g) => Math.max(m, Number(g.order) || 0), 0);
      await wb.putGroup({ id: uid(), name: nm, members: ids, entries: [], createdAt: Date.now(), order: _maxOrder + 1 });
      await renderWbGroups();
      // ⚠️ 必须刷新小字（v1.21.24 修，审计第 12 条）：
      // 改建组/删组那两处都调了，就新建这处漏了 ——
      // 库里已有 1 个组，小字仍显示"还没建角色组"，退回去看还是旧数字。
      await refreshWbSubs();
      toast('已建「' + nm + '」，点它进去写内容', 2600);
    },
  });
}

// ---------- 组列自定义（改成员 + 改组名 + 删组）----------
async function openGroupEditor(gid) {
  const g = await wb.group(gid);
  if (!g) { toast('这个组不在了'); return; }
  openCharPicker({
    title: '组列自定义', name: g.name || '', selected: g.members || [],
    onOk: async (nm, ids) => {
      await wb.putGroup({ ...g, name: nm, members: ids });
      await renderWbGroups();
      await refreshWbSubs();      // ⚠️ 必须刷新：世界书总览页的小字要跟着变
      toast('已更新', 2000);
    },
    onDelete: async () => {
      const ok = await confirmBox('删除角色组',
        '<p>把「' + esc(g.name || '未命名') + '」和它里面的 <b>' + (g.entries || []).length + ' 条</b>设定一起删掉？</p>'
        + '<p>角色本身不受影响，只是这个组没了。</p>', '删除');
      if (!ok) return;
      await wb.delGroup(gid);
      await renderWbGroups();
      await refreshWbSubs();      // 同上：不刷的话退回总览页还显示旧数字（用户报过）
      toast('已删除');
    },
  });
}

// ---------- 条目编辑：一组 / 一个角色 共用 ----------
// ctx = { kind:'group'|'solo', id }  → id 是组 id 或 charId
let _wbCtx = null;

async function wbLoadEntries(ctx) {
  if (ctx.kind === 'group') {
    const g = await wb.group(ctx.id);
    return g ? (g.entries || []) : [];
  }
  const s = await wb.solo(ctx.id);
  return s ? (s.entries || []) : [];
}

async function wbSaveEntries(ctx, entries) {
  if (ctx.kind === 'group') {
    const g = await wb.group(ctx.id);
    if (!g) return;
    await wb.putGroup({ ...g, entries });
  } else {
    const s = await wb.solo(ctx.id);
    await wb.putSolo({ id: s ? s.id : uid(), charId: ctx.id, entries });
  }
}

async function openWbEntries(gid) {
  _wbCtx = { kind: 'group', id: gid };
  const g = await wb.group(gid);
  const ti = $('wbe-title');
  if (g && ti) ti.textContent = g.name || '条目';
  await renderWbEntries();
  showView('wbentries');
}

async function openWbSolo(charId) {
  _wbCtx = { kind: 'solo', id: charId };
  const c = allChars.find(x => x.id === charId);
  // ⚠️ 单独角色页的标题是 wbs-title，不是条目页的 wbe-title —— 写错会静默不改标题
  const ti = $('wbs-title');
  if (ti) ti.textContent = c ? (c.name + ' 的设定') : '单独设定';
  await renderWbEntries();
  showView('wbsolo');
}

async function renderWbEntries() {
  if (!_wbCtx) return;
  const target = _wbCtx.kind === 'group' ? $('wbe-list') : $('wbs-list');
  if (!target) return;
  const entries = await wbLoadEntries(_wbCtx);
  if (!entries.length) {
    target.innerHTML = '<div class="wb-list-empty">还没有条目。<br>点下面的按钮加一条，写上「什么时候用」和「内容」。</div>';
    return;
  }
  target.innerHTML = entries.map((e, i) => {
    const keys = (e.keys || []).map(k => '<span class="wi-key">' + esc(k) + '</span>').join('');
    return '<div class="wb-item" data-wb-e="' + i + '">'
      + '<div class="wi-head">'
      +   '<span class="wi-title">' + esc(e.title || ('条目 ' + (i + 1))) + '</span>'
      +   (e.pos === 'always' ? '<span class="wi-pos">一直生效</span>'
            : (e.pos === 'tail' ? '<span class="wi-pos">临场</span>' : ''))
      +   (e.on === false ? '<span class="wi-off">已关闭</span>' : '')
      + '</div>'
      + (keys ? '<div class="wi-keys">' + keys + '</div>' : '')
      + (e.content ? '<div class="wi-content">' + esc(e.content) + '</div>' : '')
      + '</div>';
  }).join('');
  target.querySelectorAll('[data-wb-e]').forEach(el => {
    el.onclick = () => openEntryEditor(Number(el.dataset.wbE));
  });
}

// ---------- 单条编辑弹窗 ----------
// 「什么时候生效」三档（v1.21.51）。
//
// 为什么要分档：同一条设定，放在提示词的什么位置，模型对它的态度完全不同 ——
//   front  命中才注入，放在本轮设定区最前 = 背景资料（原来的行为）
//   tail   命中才注入，放到记忆之后 = 眼下正在生效的事
//   always 不看触发词、每轮都在，进稳定前缀 = 铁律
//
// ⚠️ 只有 always 能进稳定前缀。其余两档是"命中集"驱动的，每轮可能不同，
//    进了前缀就等于每轮重算整段，token 直接翻十倍（见 persona.js 里的实测）。
const WBP_PRESETS = [
  { label: '背景设定', value: 'front' },
  { label: '临场提醒', value: 'tail' },
  { label: '一直生效', value: 'always' },
];
const WBP_HINT = {
  front: '命中后放到本轮设定区最前面，当背景资料用（默认）。',
  tail: '命中后放到靠后的位置（记忆之后），当成眼下正在生效的事。',
  always: '不看触发词、每轮都注入，并且进「稳定前缀」——她会当成铁律。这一档可以不填触发词。',
};
const WBP_ORDER = ["front", "tail", "always"];
async function openEntryEditor(index) {
  if (!_wbCtx) return;
  const entries = await wbLoadEntries(_wbCtx);
  const isNew = index < 0 || index >= entries.length;
  const e = isNew ? { title: '', keys: [], content: '', on: true } : entries[index];
  let keys = (e.keys || []).slice();

  const m = $('modal');
  $('modal-title').textContent = isNew ? '新建条目' : '编辑条目';
  $('modal-ok').textContent = '保存';
  $('modal-cancel').textContent = '取消';
  // ⚠️ 血泪 58：这里的结构是给安卓软键盘看的。
  //  · 整个弹窗套一个 <form>：让 WebView 知道"这一坨是一个可提交的表单"，
  //    安卓键盘才会把回车画成"完成/前往"；里面每个 input 都会被赋默认 type="submit"，
  //    所以 form 上的 onsubmit 就是通用的回车兜底 —— 哪个框里按回车都进得来。
  //  · 触发词框里的「加」和下面的「取消/保存」必须显式 type="button"，
  //    否则它们也成了提交按钮：回车会变成"点第一个按钮"，行为更难猜。
  //  · 内容那条故意用 textarea —— 回车在 textarea 里**就该**换行，不拦。
  $('modal-text').innerHTML =
    '<form id="we-form" autocomplete="off">'
    + '<label class="field"><span>标题（只给你自己看的）</span>'
    + '<input type="text" id="we-title" enterkeyhint="next" placeholder="比如：红魔馆" value="' + esc(e.title || '') + '"></label>'
    + '<div class="field"><span>什么时候用（触发词，回车添加，也可以点「加」）</span>'
    + '<div class="key-box" id="we-box"></div></div>'
    + '<label class="field"><span>内容（命中后注入的设定）</span>'
    + '<textarea id="we-content" rows="7" class="profile-box" style="min-height:110px">' + esc(e.content || '') + '</textarea>'
    + '<em class="hint-text">这一栏里回车是换行，写完点下面的「保存」。</em></label>'
    + '<div class="field"><span>什么时候生效（放哪儿）</span>'
    + '<div class="seg" id="we-pos"></div>'
    + '<em class="hint-text" id="we-pos-hint"></em></div>'
    + '<label class="look-switch"><input type="checkbox" id="we-on"' + (e.on === false ? '' : ' checked') + '><span>启用这条</span></label>'
    + '</form>'
    + (isNew ? '' : '<button type="button" class="danger-btn" id="we-del" style="margin-top:6px">删除这条</button>');
  m.classList.remove('hidden');

  // 「触发词」标签盒。
  //
  // ⚠️ 血泪 58：安卓手机上回车加不上触发词，光标跑到下面的「内容」里去。
  //   两个原因叠在一起：
  //   1) 安卓软键盘的回车不一定报 key==='Enter' —— Gboard/搜狗在组合态下
  //      给的是 'Unidentified' 或 keyCode 229，所以光判 e.key 会整个漏掉。
  //   2) 输入框没有 form，安卓把它当成"普通文本域"，回车默认行为是"下一个/
  //      换行"，直接 focus 到下面的 textarea，于是人就以为"跑到内容里去了"。
  //      而下面的内容框、标题框是「真」提交按钮（type 默认 submit），
  //      回车反而能提交 —— 一个 form 里混着两种默认行为，必然打架。
  //   修法 = 三件事一起做：套 form + 显式 type="button" / 多重 Enter 判定 /
  //      enterkeyhint + inputmode 告诉键盘"这是要提交的"。
  const box = $('we-box');
  // 加一个触发词。keydown / keyup / form submit / 「加」按钮 四条路都走到这里。
  const submitKey = () => {
    const inp = $('we-key-input');
    if (!inp) return;
    const v = (inp.value || '').trim();
    if (!v) return;                                   // 空输入：什么都不做，别清框
    const dup = keys.some(k => String(k).trim().toLowerCase() === v.toLowerCase());
    if (dup) { toast('这个触发词已经加过了'); return; }  // 重复：留着让人看清自己打了什么
    keys.push(v);
    renderKeys('');        // 只清空输入框，不重建它 —— 保住焦点和软键盘
    redrawTags();
    const n = $('we-key-input');
    if (n) n.focus();
  };
  const renderKeys = (keepVal) => {
    // 输入框只在第一次建，之后一直留着 —— 不能每次加标签都重建：
    // 安卓软键盘在 DOM 被换掉的那一瞬间会掉焦点收键盘，人正打着字就断了。
    // keepVal：重建时要把框里的值还原成什么（不传就是空）。
    box.querySelectorAll('.key-tag').forEach(x => x.remove());
    let inp = $('we-key-input');
    if (!inp) {
      box.insertAdjacentHTML('beforeend',
        '<input type="text" id="we-key-input" enterkeyhint="done" inputmode="text"'
        + ' autocomplete="off" autocorrect="off" spellcheck="false" placeholder="输入后回车">');
      inp = $('we-key-input');
    }
    if (keepVal !== undefined) inp.value = keepVal;
    // 兜底二：keydown。用多种判据，任何一个成立都算回车。
    const isEnter = ev => {
      if (ev.isComposing || ev.keyCode === 229) return false;   // 还在拼音组合态，这个回车是"选字"
      return ev.key === 'Enter' || ev.key === 'Return'
        || ev.code === 'Enter' || ev.code === 'NumpadEnter'
        || ev.keyCode === 13 || ev.which === 13;
    };
    inp.onkeydown = ev => {
      if (!isEnter(ev)) return;
      ev.preventDefault();
      ev.stopPropagation();
      submitKey();
    };
    // 兜底三：有些输入法 keydown 什么也不给，只发 keypress/keyup。
    inp.onkeyup = ev => {
      if (ev.isComposing || ev.keyCode === 229) return;
      if (ev.key === 'Enter' || ev.code === 'Enter' || ev.keyCode === 13) {
        ev.preventDefault(); submitKey();
      }
    };
  };
  // 标签用 insertBefore 插在输入框前面，这样输入框永远在最后。
  // （用 innerHTML 拼标签会连带把输入框冲掉 —— 那正是上面说的掉焦点。）
  const redrawTags = () => {
    const box2 = $('we-box');
    const inp2 = $('we-key-input');
    box2.querySelectorAll('.key-tag').forEach(x => x.remove());
    keys.forEach((k, i) => {
      const sp = document.createElement('span');
      sp.className = 'key-tag';
      sp.innerHTML = esc(k) + '<span class="kt-x" data-kx="' + i + '">✕</span>';
      sp.querySelector('.kt-x').onclick = () => {
        keys.splice(i, 1); redrawTags(); const n = $('we-key-input'); if (n) n.focus();
      };
      box2.insertBefore(sp, inp2);
    });
  };
  renderKeys('');
  redrawTags();
  // 档位（v1.21.51）：老条目没有 pos → 按 front 显示，和它实际生效的方式一致
  let posV = WBP_ORDER.indexOf(e.pos) >= 0 ? e.pos : 'front';
  const refreshPosHint = () => {
    const h = $('we-pos-hint');
    if (h) h.textContent = WBP_HINT[posV] || '';
  };
  renderSeg('we-pos', WBP_PRESETS, posV, v => { posV = v; refreshPosHint(); });
  refreshPosHint();

  // Escape 关掉：手机上不常用，但键盘/桌面端顺手
  const onKey = ev => { if (ev.key === 'Escape') done(); };
  // 弹窗关闭时的清理（取消、保存成功、删除都走这里）
  const cleanup = () => {
    m.classList.add('hidden');
    $('modal-ok').onclick = null; $('modal-cancel').onclick = null;
    document.removeEventListener('keydown', onKey);
    const f = $('we-form');
    if (f) f.onsubmit = null;
  };
  const done = () => cleanup();
  $('modal-cancel').onclick = () => done();
  document.addEventListener('keydown', onKey);

  // ⚠️ 校验失败时弹窗得留着让人接着改 —— 所以 save 不能先 done()
  const save = async () => {
    const t = ($('we-title').value || '').trim();
    const c = ($('we-content').value || '').trim();
    const on = $('we-on').checked;
    if (!t) { toast('给这条起个标题吧'); return; }
    if (!keys.length && posV !== 'always') { toast('至少写一个触发词，不然它不会生效'); return; }
    if (!c) { toast('内容不能是空的'); return; }
    const rec = { id: e.id || uid(), title: t, keys: keys.slice(), content: c, on, pos: posV };
    const next = entries.slice();
    if (isNew) next.push(rec); else next[index] = rec;
    await wbSaveEntries(_wbCtx, next);
    done();
    await renderWbEntries();
    await refreshWbSubs();
    toast(isNew ? '已添加' : '已保存');
  };
  $('modal-ok').onclick = ev => { if (ev) ev.preventDefault(); save(); };
  // 外层 form 的 submit 只兜「标题框里按回车」这一种：
  // 触发词框有自己的 form，事件在那儿就被 preventDefault 掉了，不会冒上来；
  // 内容框是 textarea，回车是换行，压根不触发 submit。
  // 这里只把光标送去触发词框 —— 人还没填完，别直接保存。
  const weForm = $('we-form');
  if (weForm) weForm.onsubmit = ev => {
    ev.preventDefault();
    // ⚠️ 触发词框是"裸" input（外面不能再套 <form>，嵌套 form 会被浏览器丢掉）。
    //    所以它按回车时 submit 事件是从这里冒上来的 —— 必须认出来。
    //    判据：当前焦点在触发词框上，或者事件源就是它。
    const el = document.activeElement;
    const fromKey = (el && el.id === 'we-key-input') || (ev.target && ev.target.id === 'we-key-input');
    if (fromKey) { submitKey(); return; }
    // 内容框是 textarea，回车就是换行 —— 它压根不触发 submit，这里是双保险
    if (el && el.id === 'we-content') return;
    // 其余（标题框回车）= 光标送去触发词框，人还没填完，别直接保存
    const k = $('we-key-input');
    if (k) k.focus();
  };
  const del = $('we-del');
  if (del) del.onclick = async () => {
    const next = entries.slice(); next.splice(index, 1);
    await wbSaveEntries(_wbCtx, next);
    done();
    await renderWbEntries();
    await refreshWbSubs();
    toast('已删除');
  };
}

// 刷新世界书总览的副标题（加了条目后回来要变）
async function refreshWbSubs() {
  try {
    const gs = await wb.groups();
    const sub = $('wb-global-sub');
    if (sub) sub.textContent = gs.length ? (gs.length + ' 个角色组') : '还没建角色组';
    const ss = await wb.soloAll();
    const s2 = $('wb-solo-sub');
    if (s2) s2.textContent = ss.length ? (ss.length + ' 个角色有单独设定') : '给某一个角色单独写设定';
  } catch (e) { /* 忽略 */ }
}

// ---------- 单独角色：弹窗选人 ----------
function openSoloPicker() {
  if (!allChars.length) { toast('还没有角色，先去建一个'); return; }
  const rows = allChars.map(c =>
    '<div class="pick-row" data-pk="' + c.id + '"><span class="pk-name">' + esc(c.name) + '</span><i class="fold-arrow">›</i></div>'
  ).join('');
  const m = $('modal');
  $('modal-title').textContent = '选择角色';
  $('modal-text').innerHTML = '<p class="hint-text" style="margin:0 0 4px">给哪个角色写单独设定？（和全局互不影响）</p>'
    + '<div class="pick-list" id="pk-list">' + rows + '</div>';
  m.classList.remove('hidden');
  $('modal-ok').textContent = '取消';
  $('modal-cancel').textContent = '取消';
  $('modal-ok').onclick = null;
  const close = () => { m.classList.add('hidden'); $('modal-cancel').onclick = null; $('modal-ok').onclick = null; };
  $('modal-cancel').onclick = close;
  document.querySelectorAll('#pk-list .pick-row').forEach(r => {
    r.onclick = async () => { close(); await openWbSolo(r.dataset.pk); };
  });
}

// ================= 世界书 · 事件绑定 =================
function bindWorldbook() {
  // 注意：右上角 ⚙ 的绑定在 bindEvents 里（这里再绑会互相覆盖）
  const closeBtn = $('btn-drawer-close');
  if (closeBtn) closeBtn.onclick = () => { if (!goBack()) resetTo('chat'); };

  // 总开关
  const sw = $('s-wb-on');
  if (sw) sw.onchange = async (e) => {
    await saveSettings({ worldbookOn: e.target.checked });
    await renderWorldbook();
    toast(e.target.checked ? '已启用世界书' : '已关闭世界书');
  };

  const toGlobal = $('btn-wb-global');
  if (toGlobal) toGlobal.onclick = async () => {
    if (S.worldbookOn === false) return;   // 灰的时候不响应
    await renderWbGroups(); showView('wbglobal');
  };
  const toSolo = $('btn-wb-solo');
  if (toSolo) toSolo.onclick = () => {
    if (S.worldbookOn === false) return;
    openSoloPicker();
  };

  const backWb = $('btn-wb-back');
  if (backWb) backWb.onclick = () => { if (!goBack()) resetTo('chat'); };
  const backG = $('btn-wbg-back');
  if (backG) backG.onclick = () => goBack();
  const backE = $('btn-wbe-back');
  if (backE) backE.onclick = () => goBack();
  const backS = $('btn-wbs-back');
  if (backS) backS.onclick = () => goBack();

  const newG = $('btn-wb-newgroup');
  if (newG) newG.onclick = () => openGroupCreator();
  const newE = $('btn-wb-newentry');
  if (newE) newE.onclick = () => openEntryEditor(-1);
  const newE2 = $('btn-wb-newentry2');
  if (newE2) newE2.onclick = () => openEntryEditor(-1);
  const impBtn = $('btn-wb-import');
  if (impBtn) impBtn.onclick = () => $('wb-import-file').click();

  const impFile = $('wb-import-file');
  if (impFile) impFile.onchange = async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    try {
      const txt = await f.text();
      const data = JSON.parse(txt);
      const gs = data.groups || (Array.isArray(data) ? [] : null);
      const so = data.solo || [];
      if (!gs && !so.length) { toast('这个文件里没有世界书内容', 3200); return; }
      // ⚠️ 先建 charId 映射（v1.21.24 修，审计第 8 条）——
      // 换机导入时旧 id 在本机不存在，直接写库等于写了一批幽灵引用。
      const { map: idMap, ghosts } = await buildCharIdMapFrom(data);
      const fix = (id) => (idMap.has(id) ? idMap.get(id) : id);
      let ng = 0, ns = 0, skipped = 0;
      for (const g of (gs || [])) {
        if (!g || !g.id) continue;
        const members = (g.members || []).map(fix).filter(id => !ghosts.has(id));
        skipped += (g.members || []).length - members.length;
        await wb.putGroup({ ...g, members });
        ng++;
      }
      for (const x of so) {
        if (!x || !x.charId) continue;
        if (ghosts.has(x.charId)) { skipped++; continue; }   // 本机没这个角色，别写
        // ⚠️ 主键也要认领（v1.21.25 修，复审 ★10）。
        //
        // 起因：只映射了 charId，保留了导入文件里的旧主键 x.id。
        // 换机导入走「按名字认领」时，本机同一角色已有一条 solo，
        // 于是库里出现两条 charId 相同的记录 —— 而 wb.solo() 只取第一条，
        // 第二条永远读不到，成了永久孤儿。
        // 极端情况：旧主键若与本机某条无关记录撞车，put 会整条覆盖，
        // 静默删掉那个角色的单独设定。
        //
        // applyImport 里早就做了主键认领，这条新路径没搬过来。
        await putSoloClaimed(fix(x.charId), x);
        ns++;
      }
      await renderWorldbook();
      await refreshWbSubs();
      // ⚠️ 如实报告跳过的，不再报假成功（原来无论如何都说"已导入 N 个"）
      toast('已导入 ' + ng + ' 个角色组、' + ns + ' 个角色的单独设定'
            + (skipped ? '（跳过 ' + skipped + ' 个本机不存在的角色）' : ''), 4000);
    } catch (err) {
      toast('导入失败：' + ((err && err.message) || err), 4000);
    } finally { e.target.value = ''; }   // 允许重复导同一个文件
  };
  const expBtn = $('btn-wb-export');
  if (expBtn) expBtn.onclick = async () => {
    try {
      // ⚠️ 带上 charNames 最小映射（v1.21.32 修，复审 #3）。
      //
      // 起因：世界书导出的文件【没有 characters 字段】，于是两件事都做不到 ——
      //   · buildCharIdMapFrom 查名字只扫 data.characters → 换机导入认领不到 → 静默不生效
      //   · 「完全还原」的 touched 过滤也依赖它
      // 根治办法是在【导出侧】附一份 {id, name} 的最小映射，导入侧优先用它。
      const _chars = await chars.all();
      const payload = { version: 1, kind: 'worldbook', exportedAt: Date.now(),
                        charNames: _chars.map(c => ({ id: c.id, name: c.name })),
                        groups: await wb.groups(), solo: await wb.soloAll() };
      const json = JSON.stringify(payload);
      const name = '梦弦居世界书-' + new Date().toISOString().slice(0, 10) + '.json';

      // 安卓端：和「数据导出」走同一条路 —— 写进应用缓存再调系统分享，
      // 这样会弹出"保存到哪 / 发给谁"，用户能自己选位置。
      // （以前这里只做了浏览器下载，手机上等于静默存到下载目录，看不见也找不着。）
      const FS = capPlugin('Filesystem');
      const SH = capPlugin('Share');
      if (isNative() && FS && SH) {
        try {
          const res = await FS.writeFile({
            path: name, data: json, directory: 'CACHE', encoding: 'utf8', recursive: true
          });
          await SH.share({
            title: '梦弦居 · 世界书',
            text: '梦弦居的世界书设定（角色组与单独角色条目）',
            url: res.uri,
            dialogTitle: '保存到哪，或发给谁'
          });
          toast('世界书已导出');
          return;
        } catch (err) {
          const msg = String((err && err.message) || err);
          if (/cancel|取消/i.test(msg)) { toast('已取消'); return; }
          console.error('[世界书导出] 分享失败', err);
          toast('这台设备不支持原生导出，已改用浏览器方式', 4000);
        }
      }

      // 浏览器回退（电脑上测试用）
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 3000);
      toast('世界书已导出');
    } catch (err) {
      toast('导出失败：' + ((err && err.message) || err), 4000);
    }
  };

  const cust = $('btn-wbe-custom');
  if (cust) cust.onclick = () => { if (_wbCtx && _wbCtx.kind === 'group') openGroupEditor(_wbCtx.id); };

  bindEntryIO();
}

/**
 * 条目级的导入 / 导出绑定。
 * 单独抽成函数并在 bindWorldbook 末尾调用，且内部自己 try —— 
 * 目的是：就算 bindWorldbook 前面某一行抛错，这两个按钮也不能跟着失效
 * （反馈过"点了没反应"，独立绑定能把影响面缩到最小）。
 */
function bindEntryIO() {
  const exportEntries = (btnId) => {
    const btn = $(btnId);
    if (!btn) return;
    btn.onclick = async () => {
      if (!_wbCtx) return;
      try {
        const entries = await wbLoadEntries(_wbCtx);
        if (!entries.length) { toast('这里还没有条目'); return; }
        let name = '条目';
        if (_wbCtx.kind === 'group') {
          const g = await wb.group(_wbCtx.id);
          name = (g && g.name) || '角色组';
        } else {
          const c = allChars.find(x => x.id === _wbCtx.id);
          name = c ? c.name : '单独角色';
        }
        const payload = { version: 1, kind: 'worldbook-entries', exportedAt: Date.now(), name, entries };
        const json = JSON.stringify(payload);
        const file = '梦弦居世界书-' + name + '-' + new Date().toISOString().slice(0, 10) + '.json';
        const FS = capPlugin('Filesystem'); const SH = capPlugin('Share');
        if (isNative() && FS && SH) {
          try {
            const res = await FS.writeFile({ path: file, data: json, directory: 'CACHE', encoding: 'utf8', recursive: true });
            await SH.share({ title: '梦弦居 · 世界书条目', text: name + ' 的设定条目',
                             url: res.uri, dialogTitle: '保存到哪，或发给谁' });
            toast('已导出 ' + entries.length + ' 条');
            return;
          } catch (err) {
            const msg = String((err && err.message) || err);
            if (/cancel|取消/i.test(msg)) { toast('已取消'); return; }
            console.error('[条目导出] 分享失败', err);
            toast('不支持原生导出，改用浏览器方式', 3600);
          }
        }
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = file; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 3000);
        toast('已导出 ' + entries.length + ' 条');
      } catch (err) {
        toast('导出失败：' + ((err && err.message) || err), 4000);
      }
    };
  };

  const importEntries = (btnId, fileId) => {
    const btn = $(btnId), inp = $(fileId);
    if (!btn || !inp) return;
    btn.onclick = () => inp.click();
    inp.onchange = async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file || !_wbCtx) return;
      try {
        const data = JSON.parse(await file.text());
        let incoming = [];
        if (Array.isArray(data)) incoming = data;
        else if (Array.isArray(data.entries)) incoming = data.entries;
        else if (data.groups && data.groups[0] && Array.isArray(data.groups[0].entries)) {
          incoming = data.groups.reduce((acc, g) => acc.concat(g.entries || []), []);
        } else if (data.solo && data.solo[0] && Array.isArray(data.solo[0].entries)) {
          incoming = data.solo.reduce((acc, s) => acc.concat(s.entries || []), []);
        }
        // 常驻档（pos === 'always'）不需要触发词，别把它一起滤掉（v1.21.51）
        incoming = incoming.filter(x => x && x.content && (x.pos === 'always' || (x.keys || []).length));
        // 限长（v1.21.53）：世界书文件同样是外面来的，一条塞几 MB 会撑爆提示词和存储
        incoming = incoming.map(x => ({
          ...x,
          title: String(x.title || '').slice(0, 120),
          content: String(x.content).slice(0, 20000),
          keys: (x.keys || []).map(k => String(k || '').trim().slice(0, 64)).filter(Boolean).slice(0, 64),
        }));
        if (!incoming.length) {
          // SillyTavern 的世界书长这样：{ entries: { "0": {...}, "1": {...} } } ——
          // entries 是【对象】不是数组，本软件认不了。
          // 不说清楚的话，用户只会看到「没有能用的条目」，分不清是格式不对还是自己写错了。
          const stEntries = (data && data.entries && !Array.isArray(data.entries)
            && typeof data.entries === 'object') ? Object.keys(data.entries).length : 0;
          if (stEntries) {
            toast('这个文件像是 SillyTavern 的世界书（' + stEntries + ' 条），本软件不认那种结构。'
              + '需要把每条整理成 { title, keys, content } 的数组再导入。', 7000);
            return;
          }
          toast('这个文件里没有能用的条目', 3400); return;
        }
        const cur = await wbLoadEntries(_wbCtx);
        // ⚠️ 同标题不再"跳过"，而是【更新内容】（v1.21.24 修，审计第 13 条）。
        //
        // 起因：老写法只比 title —— `new Set(cur.map(x => x.title))`。
        // 想导入更新版世界书时，同标题的新条目一个都进不来，
        // toast 还说"这些条目已经都有了，没有重复导入"，用户以为导成功了。
        // 实测证据：actuallyAdded:["雾之湖"]、silentlyDropped:["红魔馆（内容不同也被丢弃）"]。
        // 标题显然不是唯一标识，拿它当唯一键是错的。
        const byTitle = new Map(cur.map(x => [x.title, x]));
        let updated = 0;
        let onOnly = 0;   // 只有启用状态不同的条数（不动本地值，但如实报告）
        const add = [];
        for (const x of incoming) {
          const old = byTitle.get(x.title || '未命名');
          if (old) {
            // 内容或触发词有变才动，避免无意义的重写
            const sameContent = old.content === x.content;
            const sameKeys = JSON.stringify(old.keys || []) === JSON.stringify(x.keys || []);
            // pos 也算内容（v1.21.51）：它和内容是同一份设定的一部分，跟着文件走；
            // ⚠️ on 仍然不动 —— 开关是本地状态，理由见下面那段。
            const samePos = (old.pos || 'front') === (x.pos || 'front');
            if (!sameContent || !sameKeys || !samePos) {
              old.content = x.content;
              old.keys = x.keys;
              if (WBP_ORDER.indexOf(x.pos) >= 0) old.pos = x.pos;
              // ⚠️ 不再覆盖 old.on（v1.21.25 修，复审 ★9）。
              //
              // 起因：原来写 `if (x.on !== undefined) old.on = x.on !== false`，
              // 没有任何谁更新的判断 —— 而导出时 on 是被完整带上的，
              // 所以最自然的用法（导出 → 改内容 → 导回）必然触发：
              // 本地手动开启的条目会被文件里那个旧快照的 on:false 静默停用。
              //
              // 开关是【本地状态】，跟随文件会静默改变用户的设置，所以保留本地值。
              updated++;
            } else if (x.on !== undefined && (old.on !== false) !== (x.on !== false)) {
              // ⚠️ 只有开关不同时也不能静默跳过（v1.21.25 修，复审 ★8）。
              // 原来的判据不含 on，于是这种情况被整块跳过，
              // 紧接着还提前 return 说"没有要更新的"—— 把未生效的变更说成没变化。
              // 现在如实报告，但【不动本地值】（理由同上）。
              onOnly++;
            }
          } else {
            add.push({ id: uid(), title: x.title || '未命名', keys: x.keys, content: x.content,
                on: x.on !== false, pos: WBP_ORDER.indexOf(x.pos) >= 0 ? x.pos : 'front' });
          }
        }
        if (!add.length && !updated) {
          toast(onOnly ? ('有 ' + onOnly + ' 条只有启用状态不同 —— 开关按你本机的来，没有改动内容')
                        : '这些条目内容和触发词都一样，没有要更新的', 4000);
          return;
        }
        await wbSaveEntries(_wbCtx, cur.concat(add));
        await renderWbEntries();
        await refreshWbSubs();
        toast('导入完成：新增 ' + add.length + ' 条' + (updated ? '、更新 ' + updated + ' 条' : '') + (onOnly ? '（' + onOnly + ' 条只有开关不同，按本机设置保留）' : ''), 4000);
      } catch (err) {
        toast('导入失败：' + ((err && err.message) || err), 4000);
      } finally { e.target.value = ''; }
    };
  };

  exportEntries('btn-wbe-export');
  importEntries('btn-wbe-import', 'wbe-import-file');
  exportEntries('btn-wbs-export');
  importEntries('btn-wbs-import', 'wbs-import-file');
}




// ================= 联网搜索（手动触发）=================
// 设计：默认纯本地。只有用户明确打「/搜 xxx」才联网。
// 不自动判断、不自动触发 —— 省额度，也避免"我搜了半天没找到"这种话被误当成指令。

/** 解析 /搜 前缀。返回 { query } 或 null（不是搜索指令） */
function parseSearchCmd(text) {
  const m = String(text || '').match(/^\s*[/／]搜\s*[:：]?\s*([\s\S]*)$/);
  if (!m) return null;
  return { query: m[1].trim() };
}

/** 这个角色现在能不能搜：角色三态 > 全局开关 */
function canSearch(char, s) {
  const pol = char && char.searchPolicy;
  if (pol === 'off') return false;
  if (pol === 'on') return true;
  return !!s.searchOn;
}

/**
 * 执行搜索并返回要注入的一段文本。
 * 失败时返回 { block:null, err:'...' } —— 不抛，让对话照常进行。
 */
async function runSearch(query, P) {
  if (!S.searchKey) return { block: null, err: '还没填搜索 Key（设置 → 联网搜索）' };
  try {
    const re = await webSearch({
      apiKey: S.searchKey,
      query,
      max: Number(P.searchCount) || 5,
      signal: abortCtl ? abortCtl.signal : undefined,
    });
    if (!re.results.length && !re.answer) return { block: null, err: '没搜到相关内容' };
    return { block: formatSearch(re, query), err: null, n: re.results.length };
  } catch (e) {
    return { block: null, err: (e && e.message) || '搜索失败' };
  }
}

/**
 * 把一条 solo 记录写库前【先认领主键】（v1.21.25 抽取，复审 ★10）。
 *
 * ⚠️ 不能加「只有 charId 被映射过才认领」的短路条件。
 *
 * 起因：原来两处都写成 `nid !== s.charId ? await wb.solo(nid) : null`，
 * 于是备份里的 charId【本来就能命中本机角色】时 old = null，直接用外来主键 put：
 *   · 外来主键与本机某条撞车 → 整条覆盖，静默删掉本机那个角色的单独设定
 *   · 主键不同 → 库里出现两条同 charId 的 solo，而 wb.solo() 只取第一条，
 *     第二条成了永久孤儿
 * 实测：本机 OWN2/WW「WW的原设定」被外来同主键整条覆盖成「外来新」。
 *
 * 这个函数已经是【第三次】在 solo 上修的漂移了，抽出来给两条路径共用。
 */
/**
 * 把一份数据里出现的「旧 charId」映射到本机的角色 id（v1.21.24 新增，审计第 8 条）。
 *
 * 起因：世界书页那个「导入」是独立于 applyImport 的另一条路径，
 * 它把 groups/solo 【原样写库】，既不校验角色是否存在，也不做 charId 重映射。
 * 换设备（角色 id 不同）导入后，组指向一批本机不存在的 id →
 * 世界书对任何角色都不生效，而 toast 仍报"已导入 N 个角色组"，是【假成功】。
 *
 * 策略与 applyImport 保持一致：先按 id 命中，其次按【角色名】匹配本机同名角色。
 * 返回 { map, ghosts } —— ghosts 是本机找不到的旧 id，调用方要如实报告。
 */

async function buildCharIdMapFrom(data) {
  const map = new Map();
  const local = await chars.all();
  const byId = new Set(local.map(c => c.id));
  const byName = new Map(local.map(c => [String(c.name || '').trim(), c]));
  const ghosts = new Set();
  // 数据里出现过的 candidate id：characters[].id + solo[].charId + groups[].members[]
  const seen = new Set();
  // ⚠️ characters 和 charNames 都要认（v1.21.32 修，复审 #3）。
  // 世界书导出的文件只有 charNames。
  const _srcChars = (data.characters && data.characters.length) ? data.characters
                  : (Array.isArray(data.charNames) ? data.charNames : []);
  // ⚠️ v1.21.40：文件里【一个名字来源都没有】时，下面的 ghost 判定整个不成立。
  //
  // 判"这个 id 本机没有"需要知道它对应哪个角色：按 id 查不上时，只能按名字认领。
  // 而最小导出（只有 worldbook.solo、没有 characters/charNames）里，
  // solo 记录是 { id, charId, entries } —— 压根没存角色名（见 db.js 的 wbSolo）。
  // 于是每个 id 都落进 ghosts，调用方（2883 / 2890）据此 filter 掉，
  // 表现是【整份世界书导进来一条不剩，却报"跳过 N 个本机不存在的角色"】。
  //
  // 有名字来源却查不到这个 id，那才是真的外来角色。来源整体缺失时不该下判断：
  // 保留原 id 写进去，孤儿条目还有机会被「世界书孤儿自检」找回来；
  // 在这里静默过滤掉，就永远找不回来了。
  const _canResolve = _srcChars.length > 0;
  for (const c of _srcChars) if (c && c.id) seen.add(c.id);
  for (const s of (data.solo || [])) if (s && s.charId) seen.add(s.charId);
  for (const g of (data.groups || [])) for (const id of (g.members || [])) if (id) seen.add(id);
  for (const id of seen) {
    if (byId.has(id)) continue;                       // 本机就有这个 id
    if (!_canResolve) continue;                       // 文件里没有名字来源 → 无从判定，原样保留
    // ⚠️ 取名字必须和上面同源，用 _srcChars（v1.21.34 修，复审 新2）。
    //
    // 起因：v1.21.32 我只改了"候选 id 集合"用 _srcChars，忘了这里取名字仍查 data.characters ——
    // 而 charNames-only 的文件里 data.characters 是 undefined → nm 恒 undefined →
    // 【自己导出的世界书文件永远导不回来】（本机角色改认领的一律进 ghosts）。
    // 教训：改"数据来源"时，把同一函数里所有取该数据的地方一起改 —— 这是连续第 5 轮的同一个根因。
    const nm = _srcChars.find(c => c && c.id === id);
    const target = nm && byName.get(String(nm.name || '').trim());
    if (target && target.id !== id) map.set(id, target.id);   // 按名字认领
    else ghosts.add(id);
  }
  return { map, ghosts };
}

async function putSoloClaimed(nid, rec) {
  const old = await wb.solo(nid);
  // ⚠️ rec.id 可能是 undefined —— 手写的世界书文件里 solo 常常不带 id（v1.21.54 修，审计发现）。
  //    wbSolo 的 keyPath 是 'id'，undefined 主键会让 put 同步抛 DataError，
  //    而这一抛会从当条起中断【整段】世界书导入（组和后面的 solo 全不写），
  //    用户在 applyImport 那条路上还只看到一句「导入完成」（那里的 catch 是空的）。
  const id = old ? old.id : ((rec && rec.id) ? rec.id : uid());
  // 条目形状顺手净化：entries 不是数组、或里面混着 null / 非对象，
  // 会让条目页 entries.map 直接抛（页面点进去什么都不发生）。写入侧就该挡住。
  const entries = Array.isArray(rec && rec.entries)
    ? rec.entries.filter(e => e && typeof e === 'object')
    : [];
  await wb.putSolo({ ...rec, id, entries, charId: nid });
}

// ================= 发送 =================
async function buildHistory(charId = curCharId, rounds = S.contextRounds) {
  const all = await msgs.list(charId);
  // 以前这里读的是全局 S.contextRounds，角色编辑页那个「上下文轮数」滑条
  // 存进了角色却从来没被用过，拖了没反应。
  const n = (rounds || 20) * 2;
  return all.slice(-n);
}

/**
 * 给历史消息挂时间标记（C-B，2026-09-28 新增）。
 *
 * 做法是【稀疏】的：只在时间真的变了的那个"接缝"上标一条，
 * 同一天同一时段里连着说的几十条一个标记都不加。
 *
 * 为什么不用"每条都标"：40 条 × 8 token ≈ 320 token/轮，而且密集的
 * 【第3天】前缀会被模型当成叙述格式学过去（角色E那种动作流人设尤其容易）。
 * 稀疏标记只出现在换时段/换天的地方，模型几乎不会模仿。
 *
 * ⚠️ 标记是【拼进 content】的，不是加字段 —— OpenAI 兼容接口的 messages
 * 只吃 role/content，多出来的字段会被忽略。所以措辞上必须让它一眼看出
 * 这是系统标注、不是对话内容（用【】包起来，并在 turnNote 里明说别模仿）。
 */
function markHistoryTime(list) {
  if (S.historyTime === false) return list;
  const out = [];
  let prevKey = null;
  let marked = 0;
  for (const m of list) {
    const s = m.story;
    // ⚠️ v1.21.39 修（复审第二轮 #7）：无 story 的消息【不要】重置 prevKey。
    //
    // 起因：v1.21.37 把 key 的粒度对齐了 fmtStory（治「连着 3 条【第 3 天 下午】」），
    // 但这一行又把 prevKey 清空 —— 只要中间夹一条无 story 的老消息，
    // 后面同一天同一时段的消息就会【再打一次】标记，渲染出两条一模一样的日期前缀。
    // 实测：A(第1天morning) / B(无story) / C(第1天morning) → A、C 都被打上【第 1 天 morning】。
    // 那正是 v1.21.37 想治的现象，等于只治了一半。
    //
    // 不重置是对的：日期前缀的作用是「告诉模型时间跳到哪了」，
    // 无 story 的消息不改变时间，就不该让后面的标记重新出现。
    if (!s || typeof s.day !== 'number') { out.push(m); continue; }
    // ⚠️ key 的粒度必须和 fmtStory 的【渲染粒度】对齐（v1.21.37 修，复审 P1-1）。
    //
    // 起因：key 含 hour，但 fmtStory 在 clockDetail 关掉时会丢掉 hour ——
    // 于是同一天同一时段、钟点不同的多条消息会【各打一次标记】，
    // 而渲染出来的前缀文本【完全相同】（连着 3 条「【第 3 天 下午】」）。
    // 模型看到重复标记，无法区分实际间隔。
    //
    // ⚠️ 全项目有三处渲染时间：clockFull / fmtStory / 这里的 key —— 改一处要看另两处。
    const useHour = S.clockDetail && typeof s.hour === 'number';
    const key = s.day + '|' + s.phase + '|' + (useHour ? s.hour : '-');
    if (key !== prevKey) {
      out.push({ ...m, content: '【' + fmtStory(s) + '】\n' + (m.content || '') });
      prevKey = key;
      marked++;
    } else {
      out.push(m);
    }
  }
  // 一条都没标（老数据全无 story）→ 原样返回，别白建数组
  return marked ? out : list;
}

/**
 * 模型回了空白/纯标点时的兜底接话（v1.21.23）。
 *
 * 设计原则（约定）：
 *   【要带上他这一轮写的内容】—— 不能是"她看着你"这种跟上下文无关的通用句。
 *
 * 取词优先级（越靠前越具体）：
 *   1. 他这轮写的【具体动作】（凑近/退开/低头/抓住…）→ 直接接那个动作
 *   2. 他这轮说的【话】→ 接一句最短的回应
 *   3. 都没有 → 退回"她没接话"，但带上她上一轮的状态，不凭空编
 *
 * ⚠️ 这里【不替她说话】。绝不写台词（写什么台词都是我在替她演），
 *    只写"她怎么不说话"——但要是【从上下文长出来的】，不是通用模板。
 */
function buildBlankFallback(userText, past, think = '') {
  const t = String(userText || '');
  // ⚠️ think 是模型的思考内容（v1.21.30 加）。
  // 只在【真的没有可写的东西】时用它当兜底素材 —— 它是最后一道保险，不是首选。
  const _think = String(think || '');
  // 去掉括号，看他在【括号外面】说了什么（那才是她说得出口的）
  const spoken = t.replace(/[（(][^）)]*[）)]/g, '').replace(/[\s。，、！？…~～]/g, '');
  // 括号里的动作/描写。
  // ⚠️ 只取【第一个】括号（v1.21.23 自查）：
  //    原来把所有括号用「，」拼起来再 slice(0,36)，两个毛病 ——
  //    ① 他写三段括号时会拼成一长串，截断处断在半个词上（「他凑近，手撑着」→「他凑」）；
  //    ② 拼接本身读起来像流水账，不如只接第一件事。
  const parens = (t.match(/[（(][^）)]*[）)]/g) || []).map(s => s.replace(/^[（(]|[）)]$/g, ''));
  let act = (parens[0] || '').trim();
  // 太长就收短。⚠️ 优先按标点断（读起来完整），标点切出来太短才按字数截。
  //   原来只写了按标点切、且要求切出来 ≥4 字，结果「他凑近，手撑着…」切出「他凑近」3 字被放弃，
  //   退回按字数硬截，反而断在半句上（自查实测发现）。
  if (act.length > 24) {
    // ⚠️ 判据要宽松（自查实测踩过）：原来要求切出来的小句 ≥6 字才用，
    //   结果「他凑近，手撑着席子，…」切出「他凑近」3 字被否掉，退回硬截 →
    //   变成「他凑近，手撑着席子，脸低下来，气息都」这种断在半句上的。
    //   现在：按标点切成小句，取【前两小句】拼起来，再按字数收尾。
    const parts = act.split(/[，,、；;。！？!?]/).map(s => s.trim()).filter(Boolean);
    if (parts.length > 1) {
      let s2 = parts[0];
      if (s2.length < 8 && parts[1]) s2 += '，' + parts[1];
      act = s2.slice(0, 24);
    } else {
      act = act.slice(0, 24);
    }
  }

  // 她上一轮做了什么 —— 用来"接着刚才"，不凭空编
  let prevSelf = '';
  if (Array.isArray(past)) {
    for (let i = past.length - 1; i >= 0; i--) {
      if (past[i] && past[i].role === 'assistant' && past[i].content) {
        const m = String(past[i].content).match(/^[（(]([^）)]{2,40})[）)]/);
        if (m) prevSelf = m[1];
        break;
      }
    }
  }

  // —— 1. 他这轮有具体动作：接那个动作 ——
  if (act) {
    return '（' + act + '——我没接话，手还停在刚才的地方）';
  }

  // —— 2. 他只说了话：给一句最短的实际回应 ——
  if (spoken) {
    const s = spoken.slice(0, 24);
    return '（听他说完「' + s + '」，我停了一下，才开口）\n\n……嗯。';
  }

  // —— 3. 什么都没写清楚：退回"她没接话"，但带上一轮的状态 ——
  if (prevSelf) {
    return '（' + prevSelf.slice(0, 30) + '。我没接他的话）';
  }
  // —— 4. 最后一个素材：模型的思考内容（v1.21.30 加）——
  //
  // 什么时候会走到这里：他没写动作、没说话（或整条都是括号）、她上一轮也没有可接的话。
  // 这时模型的 content 是空的，但 reasoning 里【可能有它本来想说的方向】——
  // 从里面挑一个短的动作片段接上去，比凭空编一句"没接话"更贴近它本意。
  //
  // ⚠️ 只从 reasoning 里挑【带动作感的短片段】，不整段搬 ——
  // 那里面大多是自我盘算（"他是在等我吗？那我要不要…"），直接说出口会变成内心戏外泄。
  if (_think) {
    const cand = _think
      .replace(/[\n\r]+/g, ' ')
      .split(/[。！？!?；;]/)
      .map(s => s.trim())
      .filter(s => s.length >= 4 && s.length <= 22)
      // 挑像"动作/神态"的：含身体、动作、感官类词
      .filter(s => /(手|脚|头|眼|肩|背|嘴|唇|呼吸|顿|停|偏|低|抬|垂|碰|捻|握|松|靠|退|前进|转身|笑|叹)/.test(s));
    if (cand.length) {
      const pick = cand[0].replace(/^[（(【\[]|[）)】\]]$/g, '').slice(0, 24);
      return '（' + pick + '——我没接话）';
    }
  }
  return '（没接话，还在看他刚才那个样子）';
}

/**
 * 把一段文本当文件导出（安卓走系统分享，桌面走下载）。
 *
 * 和世界书导出走同一条路：安卓上写进应用缓存再调 Share，会弹「保存到哪 / 发给谁」；
 * 只做浏览器下载的话，手机上等于静默存到下载目录，看不见也找不着。
 */
async function shareTextFile(name, text, title, desc) {
  const FS = capPlugin('Filesystem');
  const SH = capPlugin('Share');
  if (isNative() && FS && SH) {
    try {
      const res = await FS.writeFile({
        path: name, data: text, directory: 'CACHE', encoding: 'utf8', recursive: true
      });
      await SH.share({ title, text: desc, url: res.uri, dialogTitle: '保存到哪，或发给谁' });
      toast('已导出：' + name, 3200);
      return;
    } catch (err) {
      const msg = String((err && err.message) || err);
      if (/cancel|取消/i.test(msg)) { toast('已取消'); return; }
      console.error('[文本导出] 分享失败', err);
      toast('这台设备不支持原生导出，已改用浏览器方式', 4000);
    }
  }
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
  toast('已导出：' + name, 3200);
}

/**
 * 导出当前角色的对话为 Markdown。
 *
 * ⚠️ 取消息用 includeArchived=true：归档只是「不再进上下文」，原文还在库里，
 * 导出时把它们丢掉，用户会以为「写过的那些没了」。
 */
async function exportChatMarkdown() {
  try {
    if (!curCharId) { toast('先在角色列表里选一个角色'); return; }
    const char = allChars.find(c => c.id === curCharId) || curChar;
    const list = await msgs.list(curCharId, 0, true);
    if (!list.length) { toast('这个角色还没有聊天记录'); return; }
    const md = buildChatMarkdown({ char, messages: list });
    await shareTextFile(markdownFileName(char && char.name), md,
      '梦弦居 · 对话导出', ((char && char.name) || '对话') + ' 的记录（Markdown）');
  } catch (e) {
    toast('导出失败：' + ((e && e.message) || e), 4200);
  }
}

/**
 * 发一条消息。
 *
 * @param opts.cont  true = 「续写」（v1.21.48）：不落用户消息、也不动输入框，
 *                   只让模型接着上一轮往下写。其余链路（历史 / 记忆 / 落库 / 渲染）完全一样。
 *
 * 为什么续写要做成 send 的一个分支、而不是另写一条生成路径：
 * 这条路径上挂着几十个已经踩过的坑（时间标记、记忆节奏、滚动摘要失效、
 * 中断后留半截、失败回滚…）。另写一条等于把这些坑全部重新踩一遍。
 */
async function send(opts) {
  const cont = !!(opts && opts.cont);
  // ⚠️ 没有角色就别往下走（v1.21.60）。
  // 全新安装进来是空的（不再自动建角色），此时点发送会带着 myCharId = null
  // 一路走到请求组装，回复落库时 charId 也是 null —— 变成一条看不见、导不出、
  // 也删不掉的孤儿消息。所有发送入口（按钮 / 回车 / 续写 / 图片 / 斜杠命令）
  // 都汇聚到这个函数，所以这里一道就够。
  if (!curCharId || !curChar) { toast('还没有角色，先去建一个'); return; }
  // ⚠️ 别静默 return（v1.21.52）：生成中按发送（或回车）什么都不发生、也没有任何提示，
  // 用户只会觉得"卡住了"。说明白一句，他就知道该先按停止。
  if (busy) { toast('她还在打字，等她说完再发下一条', 2400); return; }
  if (_pickingImages) { toast('图片还在处理，稍等一下再发'); return; }
  const input = $('input');
  const text = input.value.trim();
  // 续写允许空输入 —— 这正是它的用途：你不说话，她也往下写。
  if (!cont && !text && !pendingImages.length) return;
  if (!S.apiKey) { toast('请先到设置里填写 API Key'); return; }

  // 这一轮认准发送时的那张卡：中途切了角色，回复也只落到原来那个角色名下，
  // 不会写进别人的聊天里（下面所有落库/DOM 都用 myCharId 校验）。
  const myCharId = curCharId;
  const myChar = curChar;

  const images = pendingImages.slice();
  const imageNotes = pendingNotes.slice();

  // 立刻上锁。以前 busy 是在下面一串 await 之后才置 true 的，那一小段里
  // 「重试 / 重新生成」还能挤进来再开一路请求。
  busy = true;
  $('btn-send').classList.add('hidden');
  $('btn-stop').classList.remove('hidden');
  abortCtl = new AbortController();

  // ⚠️ _cmd0 必须声明在【try 外面】（v1.21.25 修）。
  //
  // 起因：它原来在 try 块里用 const 声明，而下面兜底那段（buildBlankFallback）
  // 在 try【外面】引用它 —— 作用域早已结束，直接 ReferenceError。
  // 表现：整条回复变成「⚠ 这条没发出去_cmd0 is not defined」，
  // e2e-test2 就是这么挂的（发图片那套）。
  // ⚠️ 下面这几个变量【必须在 try 外面声明】（v1.21.25 修完整版）。
  //
  // 起因（用户截图 + 复审报告）：send() 里有【两个顺序的 try】：
  //   try #1 —— 落库/拼上下文，局部变量都声明在这里
  //   try #2 —— 流式生成 + 兜底
  // 而兜底（buildBlankFallback）在 try #2 里引用了 try #1 的局部变量 ——
  // 块级作用域在 try #1 结束时已销毁，必然 ReferenceError。
  //
  // 表现：模型回空白/纯标点时（正是要兜底的场景），整条回复变成
  //   「⚠ 这条没发出去 visibleText is not defined」
  // 而且修完一个还会接着炸下一个（_cmd0 → visibleText → pastRaw）。
  // 第一版只提到 _cmd0，漏了另两个，被复审抓回来。
  //
  // 教训：跨 try 边界用到的变量，一律在函数顶部 let 声明。
  // ⚠️ clockSnapshot 必须声明在【try 外面】（v1.21.50 修）。
  // 起因：它原来在 try 里 `const` 声明，而 catch 的回滚段要用它 ——
  // 【catch 块看不到 try 块里的 const】，一旦真走到回滚就抛
  // 「clockSnapshot is not defined」，把真正的错误盖掉，界面卡在生成中。
  // 与上面 um / apiMsgs / visibleText 是同一类错（跨 try 边界用到的变量一律提到函数顶部）。
  // ⚠️ added 必须声明在【函数顶部】：catch 里要做失败回滚，
// 而 catch 看不到 try 块里的 const（v1.21.50 的 clockSnapshot 就是栽在这上面）。
let um, apiMsgs, P = null, useVision, umSaved = false, clockSnapshot = null, added = [];
  // 上下文预算（v1.21.54）：这几个同理 —— 撞超长后的重发发生在 try #2 里，
  // 而它们是在 try #1 里算出来的，块级作用域跨不过去（上面那段教训的又一例）。
  let ctxBudget = 0, histBudget = 0, ctxFit = null, ctxRetried = false, composeApiMsgs = null;
  // 这一轮服务端给的收尾原因（v1.21.54）。'length' = 撞到 max_tokens 被截断 ——
  // 以前没人读它，半句话当完整回复落库，用户只看到"她话说一半停了"。
  let finishReason = '';
  let _cmd0 = null;
  let visibleText = '';
  let pastRaw = [];
  // ⚠️ 累积模型的思考内容（v1.21.30 加，复审省略号专项 C）。
  // 模型的 content 为空、话都写在 reasoning_content 里时，兜底可以拿它当素材 ——
  // 而不是凭空编一句。注意：只当素材，不直接输出（reasoning 里有大量自我盘算）。
  let thinkBuf = '';
  try {
    // ⚠️ 续写不吞附件（v1.21.52）：续写发的是「继续往下写」那条指令，不带图
    //（见下面 cont 分支的 payload）。原来这里无条件把输入框里的图清掉 ——
    // 缩略图当场消失，用户以为图发出去了，其实既没发出去也没人告诉他。
    // 现在续写时把图【留着】，并说一句，让他改用发送。
    if (cont && pendingImages.length) {
      toast('续写不会带图片 —— 要发这张图请按发送', 3400);
    } else {
      pendingImages = [];
      pendingNotes = [];
      renderAttachPreview();
    }
    input.value = '';
    syncInput();

    // 1) 落库并渲染用户消息
    //
    // ⚠️ 续写整段跳过（v1.21.48）：um 保持 undefined、umSaved 保持 false。
    //    这两件事必须一起不动 —— 下面的 `pastRaw = history.filter(m => m.id !== um.id)`
    //    在 um 为 undefined 时天然放行全部历史（正是续写要的），
    //    而失败回滚那段看的是 umSaved，false 就不会去删一条不存在的消息。
    if (!cont) {
      // 打了「/搜 xxx」时，聊天记录里只留「xxx」和一个小标记 ——
      // 存「/搜 xxx」原文的话，历史里会一直拖着一串命令，读起来很出戏，
      // 而且下一轮拼上下文时会把它当台词再喂给模型。
      _cmd0 = parseSearchCmd(text);   // 声明在函数顶部，见那里的说明
      visibleText = _cmd0 ? (_cmd0.query || text) : text;   // 声明在函数顶部
      um = { id: uid(), charId: myCharId, role: 'user', content: visibleText, images, imageNotes,
             searched: _cmd0 ? (_cmd0.query || '') : '', story: storyStamp(), ts: Date.now() };
      await msgs.add(um);
      umSaved = true;   // 从这里开始，失败就要连这条一起撤，不然会跟输入框里的重复
      if (curCharId === myCharId) {
        $('messages').insertAdjacentHTML('beforeend', msgHtml(um));
        markFresh($('messages').lastElementChild);
        attachMsgActions();
        scrollBottom();
      }
    } else {
      // 续写：输入框原样留着（用户可能正写了一半，不该被清掉）
      input.value = text;
      syncInput();
    }

    // 全局发送计数。注意：记忆节奏【已经不用它了】——那些都改用按角色的 msgSeq。
    // 这里只作为全局统计保留着，别再往它上面挂新的节奏逻辑。
    await kv.set('sendCount', ((await kv.get('sendCount', 0)) || 0) + 1);
    // 这个角色的"累计消息序号"——只增不减。
    // 记忆的节奏（总结/查重/归档）都改用它来数：以前数的是"当前可见条数"，
    // 一旦归档或清空聊天记录，条数会变少甚至归零，节奏就静默停摆了。
    await bumpMsgSeq(myCharId);

    // 1.5) 他说的话里如果写了场景时间（「第二天」「傍晚」），把剧情时间跟上去。
    //      必须在拼 turnNote 之前做，否则这一轮注入的还是旧时间。
    const tick = detectClock(visibleText);
    // ⚠️ v1.21.39 修（复审第二轮 #4）：推进前先留一份快照，失败时回滚。
    // 起因：这里已经 saveClock() 落库，但下面 catch 的回滚段【只还原输入框/图片/消息】，
    // 不管 clockState —— 于是发送失败后剧情时间永久前进（刷新也回不去），
    // 用户重发一次，时间【又】前进一天。
    clockSnapshot = tick ? { ...clockState } : null;
    if (tick) { clockState = tick; await saveClock(); }

    // 2) 准备请求（P = 本角色实际生效的参数）
    P = effSettings(myChar, S);
    const history = await buildHistory(myCharId, P.contextRounds);
    // ⚠️ 撞触发词要用【没标时间】的原内容：标记里带着「下午」「晚上」这类词，
    // 会把只该被剧情文本命中的世界书条目误触发（比如天气/时段类条目）。
    // ⚠️ um 可能不存在（v1.21.50 修）：续写这一轮【不落用户消息】，um 一直是 undefined，
    // 原来的 `m.id !== um.id` 会直接抛 TypeError（读 undefined 的 id），
    // 表现是「发送失败：Cannot read properties of undefined (reading 'id')」——
    // 而续写本来就不需要排除任何一条，直接用整个 history 才对。
    pastRaw = um ? history.filter(m => m.id !== um.id) : history.slice();
    // 带时间标记的版本（C-B）—— 只给模型看，落库/渲染用的还是 history 本身。
    // 两者必须分开：如果把标记写回 msgs，它会进库、进气泡、下一轮再被标一次。
    const past = markHistoryTime(pastRaw);
    useVision = images.length > 0 || needsVision(history);

    // 颜文字决策（闭环：看最近实际使用率）
    const useKaomoji = decideKaomoji(P.kaomojiFreq, past);

    const memories = P.longMemory ? await mem.list(myCharId) : [];   // 只取这个角色自己的记忆
    // 滚动摘要：更早（已归档）的对话浓缩。和记忆是两回事——
    // 记忆是「关于他的事实」，摘要是「我们之间发生过什么」。两者互补。
    const rolling = P.longMemory ? (await getRolling(myCharId)).text : '';

    // 稳定前缀（人设 + 基础规则）——内容每轮完全一致，才能命中前缀缓存
    // 常驻世界书（v1.21.51）：只有「一直生效」那一档进稳定前缀，
    // 命中式的条目仍然走下面的 worldbookHits → 本轮段。
    const sysStable = buildStablePrompt(myChar, P, await worldbookConst(myCharId));
    // 世界书：拿"用户这句 + 最近几条"去撞触发词。
    // 必须用 past（不含刚才那条还没写进去的），再补上本轮 text ——
    // history 里最新一条就是本轮用户消息，重复拼会命中两次（虽然去重后无影响，但没必要）。
    const wbText = [visibleText].concat(pastRaw.slice(-WB_LOOKBACK).map(m => m.content || '')).join('\n');
    const worldbook = await worldbookHits(myCharId, wbText);

    // 上一条消息的剧情时间 —— 用来算"距现在过了多久"（C1，2026-09-28 新增）。
    // 取 pastRaw 里最后一条带 story 的：本轮用户消息 um 刚刚才落库，
    // 它的 story 就是"现在"，拿它算跨度恒等于 0，没有意义。
    let prevStory = null;
    for (let i = pastRaw.length - 1; i >= 0; i--) {
      if (pastRaw[i] && pastRaw[i].story && typeof pastRaw[i].story.day === 'number') { prevStory = pastRaw[i].story; break; }
    }

    // 会变化的内容（记忆 / 当前时间 / 本轮颜文字开关 / 命中的世界书）独立成一条，放到历史之后
    // 记忆召回的话题（v1.21.56）：用【本轮说的话 + 最近两条】。
    // 刻意不用上面那个 wbText —— 它带 6 条上下文，二元组命中会掺进太多噪声。
    const memTopic = [visibleText].concat(pastRaw.slice(-2).map(m => m.content || '')).join(' ');
    const turnNote = buildTurnNote(myChar, P, {
      memories, useKaomoji, worldbook, rolling, topic: memTopic,
      clock: clockFull(clockState), clockLocked: !!clockState.locked,
      clockState, prevStory,
      // 临时场景（v1.21.47）：只进本轮段，不进稳定前缀
      scene: sceneOf(myChar),
    });

    // —— 联网搜索（只有明确打了 /搜 才走这里）——
    // 必须在拼 apiMsgs 之前做：搜索结果要作为这一轮的额外 system 塞进去。
    // 只注入这一轮，不写进历史 —— 免得之后每一轮都拖着几千 token 的旧资料。
    let searchBlock = null;
    const cmd = parseSearchCmd(text);
    if (cmd) {
      if (!cmd.query) {
        // 只打了「/搜」没给关键词：退回普通消息，并提示一下
        toast('「/搜」后面要写要查什么，例如：/搜 今天北京天气', 3200);
      } else if (!canSearch(myChar, P)) {
        const why = (myChar && myChar.searchPolicy === 'off')
          ? '这个角色关掉了联网搜索'
          : '联网搜索没开（设置 → 联网搜索）';
        toast(why + '，这条按本地回答', 3200);
      } else {
        if (curCharId === myCharId) toast('正在搜「' + cmd.query + '」…', 1800);
        const rs = await runSearch(cmd.query, P);
        if (rs.block) { searchBlock = rs.block; }
        else toast('搜索没成功：' + rs.err + '（这条按本地回答）', 3600);
      }
    }

    // —— 上下文预算（v1.21.54）——
    // 固定段（人设 / 常驻世界书 / 本轮段 / 搜索）先扣掉，剩下的额度才给历史。
    // 固定段【不参与裁剪】：砍人设 = 她当场失忆，砍世界书 = 设定崩掉，
    // 两者都比"这轮少带几条聊天记录"严重。
    ctxBudget = Math.max(2000, Number(S.contextBudget) || DEFAULTS.contextBudget);
    // ⚠️ 本轮这条用户消息【必须按消息算，不能只算文字】——
    // 它带的图每张约 1200 token，只算 visibleText 的话一轮三张图就少算 3600：
    // 预算看着没满，发出去照样超长（然后白撞一次降级重发）。
    const turnTokens = estimateMsgTokens({ content: cont ? CONT_NUDGE : visibleText, images, imageNotes });
    const fixedTokens = estimateTokens(sysStable) + estimateTokens(turnNote)
      + (searchBlock ? estimateTokens(searchBlock) : 0)
      + turnTokens + 16;
    // 拼装抽成函数：撞上「上下文超长」时要按更小的额度重拼一次（见下面的重试循环）。
    composeApiMsgs = (budget) => {
      const fit = fitHistoryByBudget(past, budget);
      ctxFit = fit;   // 设置页的占用显示和降级提示都要读它
      return [
        { role: 'system', content: sysStable },
        ...fit.kept.map(m => ({ role: m.role, content: m.content, images: m.images, imageNotes: m.imageNotes })),
        { role: 'system', content: turnNote },
        ...(searchBlock ? [{ role: 'system', content: searchBlock }] : []),
        // 续写（v1.21.48）：不写用户消息，改成一条【只在本次请求里存在】的指令。
        // 它不落库（apiMsgs 只是这一轮的请求体），所以聊天记录里看不到这条 ——
        // 但它能让模型明白「现在是我一个人往下写」，而不是「他没说话，我该等他」。
        // 不给这条指令的话，最后一条是 turnNote（system），模型常常回一个短反应就停。
        cont ? { role: 'user', content: CONT_NUDGE }
             : { role: 'user', content: visibleText, images, imageNotes }
      ];
    };
    histBudget = Math.max(0, ctxBudget - fixedTokens);
    apiMsgs = composeApiMsgs(histBudget);
    // 给设置页「上一轮 ≈ 多少」留个数（含固定段）
    lastPromptTokens = fixedTokens + (ctxFit ? ctxFit.tokens : 0);
  } catch (err) {
    // 前置步骤（写库 / 读历史 / 读记忆）失败时：把内容还给输入框并马上解锁。
    // 以前这些 await 在 try 之外，抛出去等于白打一段话，界面上什么都不显示。
    console.error(err);
    input.value = text;   // 原文（含 /搜 前缀）还回去，重发即可
    pendingImages = images;
    pendingNotes = imageNotes;
    renderAttachPreview();
    syncInput();
    // 消息可能已经落库并显示出来了 —— 一起撤掉。
    // 原来只还原输入框：界面上留着一条用户消息、库里也有一条，
    // 而输入框里又是同一段话，用户照提示一重发就成了两条。
    if (umSaved) {
      try { await msgs.del(um.id); } catch { /* 删不掉也不该盖住真正的原因 */ }
      // ⚠️ 必须包 try（v1.21.54，审计发现）：这是整个 catch 里【唯一没有保护】的 await。
      //    它一抛，下面的 busy=false / 按钮复位 / toast 就全部执行不到 ——
      //    而 send() 是被 onclick 裸调的，没有外层 catch 兜底，
      //    结果 busy 永远停在 true：发送键消失、停止键常亮，之后每次发送只弹
      //    「她还在打字」，点停止也没用，只能重启 App。
      if (curCharId === myCharId) {
        try { await renderMessages(); } catch (e2) { console.error('[发送失败] 重绘消息时又出错', e2); }
      }
    }
    // ⚠️ v1.21.39 修（复审第二轮 #4）：把剧情时间退回发送前。
    // 只回滚【本次推进的那次】—— 快照为 null 说明本轮压根没检测到时间推进，别乱动。
    if (clockSnapshot && curCharId === myCharId) {
      clockState = clockSnapshot;
      try { await saveClock(); } catch { /* 回滚失败也不该盖住真正的原因 */ }
      renderClock();
    }
    busy = false;
    abortCtl = null;
    $('btn-send').classList.remove('hidden');
    $('btn-stop').classList.add('hidden');
    toast('发送失败：' + ((err && err.message) || err), 4200);
    return;
  }

  // 3) 渲染占位气泡
  const placeholderId = 'gen-' + uid();
  if (curCharId === myCharId) {
    $('messages').insertAdjacentHTML('beforeend',
      `<div class="msg ai" id="${placeholderId}">${avatarHtml(myChar, 'av')}<div class="bub${P.showTyping === false ? ' no-dots' : ''}"><span class="gen-text"><span class="typing-dots"><i></i><i></i><i></i></span></span></div></div>`);
    markFresh($('messages').lastElementChild);
    scrollBottom();
  }

  const bubble = document.querySelector('#' + placeholderId + ' .gen-text');
  // 注意：abortCtl 在最上面那段就建好了，这里不要再建第二个 ——
  // 否则切角色时发的中断会打在那个已经被丢弃的 controller 上。

  let full = '';
  try {
    // 模拟"正在输入"的思考延迟
    const delay = 400 + Math.random() * 500 * (P.typingDelay ?? 1);
    // ⚠️ 这段假打字延迟要能被打断（v1.21.52）：原来就是个裸 setTimeout，不认 abort ——
    // 用户在最长 2.5 秒里按「停止」，界面要等它走完才有反应，看着像卡死。
    await new Promise((res, rej) => {
      const t = setTimeout(res, Math.min(delay, 2500));
      const sig = abortCtl && abortCtl.signal;
      if (!sig) return;
      const bail = () => { clearTimeout(t); rej(Object.assign(new Error('已停止'), { name: 'AbortError' })); };
      if (sig.aborted) { bail(); return; }
      sig.addEventListener('abort', bail, { once: true });
    });

    const model = useVision ? (S.visionModel || S.model) : S.model;

    // 首次请求失败自动重试一次（手机网络首次连接常偏慢/抖动）
    let attempt = 0;
    let usage = null;
    for (;;) {
      try {
        const stream = streamChat({
      onThink: (t) => { thinkBuf = t; },   // 收尾时回调（v1.21.30）
          onFinish: (r) => { finishReason = r; },   // 收尾原因（v1.21.54）：'length' = 被 max_tokens 截断
          apiKey: S.apiKey, baseUrl: S.baseUrl, provider: S.provider, model,
          messages: apiMsgs, temperature: P.temperature,
          maxTokens: P.maxTokens, topP: P.topP,
          reasoningEffort: P.reasoningEffort,
          signal: abortCtl.signal,
          onUsage: (u) => { usage = u; }
        });
        bubble?.classList.remove('dots');
        for await (const chunk of stream) {
          full += chunk;
          if (bubble) bubble.textContent = full;   // 切了角色就没气泡了，别硬写
          scrollBottom();
        }
        break;
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        // 上下文超长（v1.21.54）：砍掉一截历史重拼重发，而不是把这个错甩给用户。
        // 只降一次 —— 降完还超，说明是单条内容本身太长，那时把原错误报出来；
        // 无限重试只会让用户干等着看转圈。
        if (!ctxRetried && ctxFit && ctxFit.dropped > 0 && isContextOverflow(err)) {
          ctxRetried = true;
          const before = ctxFit.dropped;
          histBudget = Math.max(0, Math.floor(histBudget * 0.6));
          apiMsgs = composeApiMsgs(histBudget);
          const droppedNow = ctxFit ? ctxFit.dropped : before;
          // ⚠️ 只有【真的少带了历史】才重发（v1.21.54，审计发现）。
          //    固定段自己就吃满预算时 histBudget 本来就是 0，乘 0.6 还是 0 ——
          //    重拼出来的请求与上一次逐字节相同：白花一次调用（服务端"连上不吐数据"时
          //    还要再等满 60 秒看门狗），而提示却写着"已少带一段历史重发"。
          //    没有可再丢的，就把原错误如实报出去。
          if (droppedNow > before) {
            full = '';
            usage = null;
            thinkBuf = '';   // 上一次的思考内容不能再当兜底素材（见下面重试分支的同一条）
            finishReason = '';
            if (bubble) { bubble.textContent = ''; bubble.classList.add('dots'); }
            console.warn('[ctx] 上下文超长，历史额度降到 ' + histBudget + '，多丢 ' + (droppedNow - before) + ' 条');
            toast('这轮超了模型窗口，已少带一段历史重发', 3400);
            continue;
          }
          console.warn('[ctx] 上下文超长，但已经没有可再丢的历史了（额度 ' + histBudget + '）—— 不重发，直接报错');
          throw err;
        }
        if (attempt >= 1) throw err;
        attempt++;
        full = '';
        // usage 也要清：第一次可能已经收到 usage 帧才失败（include_usage 是开的），
        // 不清的话重试成功后会把上一轮的用量记到这条新回复上。
        usage = null;
        // 思考内容同理（v1.21.54，审计发现）：第一次要是已经流出过 reasoning_content，
        // thinkBuf 里留着的是【那一次作废请求】的思考；第二次若真回空白，
        // 兜底会从里面挑一句动作当接话 —— 和这一轮的上下文对不上。
        thinkBuf = '';
        finishReason = '';
        if (bubble) { bubble.textContent = ''; bubble.classList.add('dots'); }
        await new Promise(r => setTimeout(r, 700));
      }
    }

    full = full.trim();

    // ⚠️ 撞到 max_tokens 被截断要让人知道（v1.21.54）。
    // 以前 finish_reason 从头到尾没人读：半句话当完整回复落库、还成为后续上下文，
    // 用户只看到"她话说一半停了"，既没有提示也没有重试入口。
    if (finishReason === 'length') {
      console.warn('[生成] 撞到 max_tokens 被截断（finish_reason=length）');
      toast('这条被 max_tokens 截断了（说到一半就停）—— 到角色设置里调大，或点重新生成', 5600);
    } else if (finishReason === 'content_filter' || finishReason === 'safety') {
      console.warn('[生成] 服务端的内容过滤截断了这条：' + finishReason);
      toast('这条被服务端的内容过滤截断了', 4800);
    }

    // 关闭颜文字时做兜底清理
    if (!P.kaomojiFreq || P.kaomojiFreq <= 0) full = stripKaomoji(full);
    // ⚠️ 空/纯标点的兜底（v1.21.22 改）。
    //
    // 旧写法是 `if (!full) full = '……'` —— 等于【主动把空白写成省略号】存进聊天记录。
    // 用户看到的是一次次「……」，只能不停点「重新思考」，而重试往往还是省略号
    // （那是模型主动选的，不是被截断）。实测 94 条回复里唯一那条的 reasoning
    // 占了 completion 的 100%，全花在纠结"此刻该不该说话"上。
    //
    // 提示词那边已经加了硬约束（persons.js 的「沉默必须写出来」），
    // 这里再兜一层：真的空了，就落一句有意义的话，而不是留个省略号让人重试。
    if (!full || /^[\s.…。，,、！!？?~～·]+$/.test(full)) {
      // ⚠️ 第二版兜底（v1.21.23）。第一版是五句「（平静地看着他）」——
      // 用户评价：【太人机了，不如不输出】。
      //
      // 错在哪：那五句是【通用描写】，不看他刚说了什么、不看她上一条在做什么，
      // 换成谁都成立，等于零信息。而且要连续触发几次，就是在反复播同一段录像。
      //
      // 现在改成【从他这一轮写的内容里取一样实在的东西，接下去】：
      // 他写了动作 → 就接那个动作；他写了话 → 就接那句话；
      // 他什么都没写清楚 → 退回"她没接话"，但带上她上一轮的状态，不再凭空编"看着你"。
      // ⚠️ 用 text 而不是 visibleText（v1.21.23 自查）：
      //    打了「/搜 xxx」时 visibleText 是搜索关键词，而 text 才是他真正打的那行。
      //    拿搜索词当兜底素材会写出「听他说完『今天北京天气』」这种莫名其妙的话。
      // ⚠️ 把模型的思考内容当【素材】传进去（v1.21.30，复审省略号专项 C）。
      // 它不直接当正文 —— buildBlankFallback 的设计本来就是"从上下文长出来的接话"，
      // 多一份素材能让它更贴近模型本来想说的方向。
      const FB = buildBlankFallback(_cmd0 ? text : visibleText, pastRaw, thinkBuf);
      full = FB;
      console.warn('[生成] 模型回了空白/纯标点，已用兜底接话替换：' + FB);
    }

    // 4) 分段发送
    const segs = P.splitMessages ? splitMessages(full, S.splitMax || 3) : [full];

    // 先把消息全部落库成功，再移除气泡——避免「气泡没了但回复也没出现」
    added = [];
    // 同批分段共用一个基准时间，逐段 +i（见下面 ts 的说明）
    const tsBase = Date.now();
    for (let i = 0; i < segs.length; i++) {
      // 用发送时那张卡的 id 落库：生成期间切了角色，这条也只回到她名下，
      // 不会跑到新角色的聊天记录里。
      // ⚠️ ts 必须【逐段递增】（v1.21.24 修，审计第 5 条）。
      //
      // 起因：分段发送时连续 await msgs.add()，每段 Date.now() 极易相同（实测
      // AAA/BBB 两段 ts 完全一致 = 1790769945060）。而 msgs.list 走的是
      // `charId_ts` 复合索引，IndexedDB 只保证按 key 排序，【相同 key 之间的
      // 顺序由实现决定】—— 于是 AAA/BBB 在读出时对调，且落库即固定，reload 后依然乱。
      //
      // ⚠️ 偏置要【向前】取（v1.21.25 修，复审 ★7）：原来写 base + i 把整批推到未来，
      // 若这 2~3ms 窗口内恰有别的消息落库，其 ts 会落在分段中间 →
      // 读出顺序变成「用户新消息插在她还没说完的话中间」。
      // 改成 base - (n-1-i)：整批仍在 base 及之前，不越过基准点。
      const am = { id: uid(), charId: myCharId, role: 'assistant', content: segs[i], story: storyStamp(), ts: tsBase - (segs.length - 1 - i) };
      if (i === 0 && usage) am.usage = usage;   // 这轮的用量记在第一条上
      await msgs.add(am);
      added.push(am);
    }
    // 她说完自动读出来（v1.21.56，开关默认关）。
    // ⚠️ 放在【整段都落库之后】：分段发送时逐段念会一顿一顿的，连起来念才像说话。
    if (S.ttsOn) speak(segs.join(''));
    document.getElementById(placeholderId)?.remove();
    if (curCharId === myCharId) {
      for (let i = 0; i < added.length; i++) {
        // ⚠️ 判据要在【循环里】再查一遍（v1.21.54，审计发现）：
        //    下面那句 350ms 的间隔里用户可以切角色，而切角色会立刻重画消息列表 ——
        //    只在外层判一次的话，剩下的分段会画进【新角色】的聊天里，跑出别人的台词
        //    （落库用的仍是 myCharId，数据没落错，坏的是画面），要等下一次重绘才消失。
        if (curCharId !== myCharId) break;
        $('messages').insertAdjacentHTML('beforeend', msgHtml(added[i]));
        if (i > 0) markFresh($('messages').lastElementChild);   // 第 1 条是替换占位气泡，内容没变，加动画会闪
        attachMsgActions();
        scrollBottom();
        if (i < added.length - 1) await new Promise(r => setTimeout(r, 350));
      }
    }

  } catch (e) {
    console.error(e);
    const ph = document.getElementById(placeholderId);

    // ⚠️ 不是「用户按了停止」，就把已经落库的段撤掉（v1.21.52）。
    // 不撤的话：库里留下 seg[0..k-1]，界面却写着「这条没发出去 + 重试一次」；
    // 用户点重试 → 删掉用户消息重发 → 新回复的 ts 更晚 →
    // 历史顺序变成「她说（半截）→ 他说 → 她说（完整）」，
    // 而且这个错序会一直作为历史喂给模型。已花的 token 也白花了。
    // （中断那条路故意【不回滚】：半截回复留着，是用户明确要的。）
    if (e.name !== 'AbortError' && added.length) {
      for (const a of added) {
        try { await msgs.del(a.id); } catch { /* 单条删不掉不影响其余 */ }
      }
      added = [];
    }

    if (e.name === 'AbortError') {
      ph?.remove();
      if (full.trim()) {
        const am = { id: uid(), charId: myCharId, role: 'assistant', content: full.trim() + '（已中断）', story: storyStamp(), ts: Date.now() };
        try { await msgs.add(am); } catch { /* 落库失败也不影响显示 */ }
        if (curCharId === myCharId) {
          $('messages').insertAdjacentHTML('beforeend', msgHtml(am));
          // 这条是手工拼进 DOM 的，必须补绑定，否则中断留下的半截回复
          // 长按没有任何反应（复制/删除/编辑重发全失效）。
          markFresh($('messages').lastElementChild);
          attachMsgActions();
        }
      } else if (curCharId === myCharId) {
        // 切角色导致的中断不弹这个提示，不然会莫名其妙跳一下
        toast('已停止生成');
      }
    } else if (ph) {
      // 保留气泡并写明原因，方便定位；不再让现场凭空消失
      const bub = ph.querySelector('.bub');
      if (bub) {
        bub.className = 'bub err-bub';
        bub.textContent = '';
        const line1 = document.createElement('div');
        line1.className = 'err-title';
        line1.textContent = '⚠ 这条没发出去';
        const line2 = document.createElement('div');
        line2.className = 'err-detail';
        line2.textContent = String((e && e.message) || e).slice(0, 200);
        const btn = document.createElement('button');
        btn.className = 'retry-btn';
        btn.textContent = '重试一次';
        // ⚠️ v1.21.54（审计发现）：续写这一轮【没有用户消息】，um 恒为 undefined，
        //    而 retrySend 遇到没指定 id 时会静默退回"最后一条用户消息"——
        //    于是点这个按钮会把【上一条真实消息】删掉、再以新时间重发一次：
        //    读出来成了「她先回答、他后提问」，正是下面那段注释明确要避免的错序，
        //    而且这条错序会一直作为历史喂给模型。续写的"重试"应该是"再续一次"。
        btn.onclick = () => { ph.remove(); if (cont) send({ cont: true }); else retrySend(um && um.id); };
        bub.appendChild(line1); bub.appendChild(line2); bub.appendChild(btn);
      }
      scrollBottom();
    } else {
      toast('出错：' + ((e && e.message) || e), 4200);
    }
  } finally {
    busy = false;
    $('btn-send').classList.remove('hidden');
    $('btn-stop').classList.add('hidden');
    abortCtl = null;
    scrollBottom();

    // 5) 长期记忆（异步，不阻塞）
    //
    // ⚠️ 必须放在 finally 里，不能放在 try 末尾。
    // 起因（实测）：以前它写在成功路径的最后一行，于是——
    //   · 这一轮回复失败（网络抖动、超时、CORS）→ 记忆任务整轮不做
    //   · 用户按了「停止」→ 同上
    //   · 而消息已经落库了，那几条内容就【永远】等不到总结（直到下次再发一条）
    // 用户在长对话里频繁中断/失败时，记忆和归档就是这样一点点攒不上的。
    // 现在无论这轮成不成，只要消息进了库，记忆任务都照跑。
    // ⚠️ 传 myCharId（v1.21.24 修，审计第 20 条）：
    // 这轮记忆任务属于【发送时那个角色】，不是执行时的 curCharId。
    // 不传的话，用户在归档跑完前切了角色，任务会作用到新人头上
    // （最坏是 pruneMemories 拿新角色天数误删旧角色的长期记忆）。
    // ⚠️ 必须判空（v1.21.25 修，复审一之四）：P 的赋值在 try 内，
    // 而这里在 finally —— try 在赋值前抛错（IndexedDB 配额超限等）时 P 仍是 null，
    // 直接读 .longMemory 会 TypeError，逃出 send() 成为未捕获异常。
    if (P && P.longMemory) runMemTasks(myCharId).catch(e => {
      // 不再静默吞掉：至少留在控制台，配 _lastMemError 一起排查
      console.error('[记忆任务] 整体失败：', e);
    });
  }
}

// ================= 长期记忆 =================
// 分三层：
//   写入（LLM，攒够 N 条触发）—— 抓重点，并标好这一条是「永久事实」还是「有时限的事」
//   查重（LLM，每 N 轮触发）—— 把重复的合并、压缩
//   时效（纯代码，每轮触发）—— 事件型记忆过了它的失效日就删掉，不花 token 也不会误判

// 记忆的频次标签。pinned=他明确要求记住的，once=只提过一次的。
const MEM_FREQ = new Set(['pinned', 'often', 'normal', 'once']);
// 排序用：数字越大越该留
const FREQ_RANK = { pinned: 3, often: 2, normal: 1, once: 0 };
const freqRank = (m) => FREQ_RANK[(m && m.freq) || 'normal'] ?? 1;

/** 从模型输出里抠出 JSON 数组（它常会裹一层 ```json 或在前面加一句话） */
function parseMemJson(s) {
  // ⚠️ 解析失败必须【抛错】，不能返回 []（v1.20.20 修）。
  //
  // 起因（2026-09-29 实测真实备份）：角色Q 的 memSummed 里记了 151 个 id，
  // 长期记忆却只有 1 条。根因就是这里静默返回 []：
  //   summarizeChunk 拿到 [] 会当成"模型说没有新记忆"，
  //   于是【照常推进 memSummed】—— 那 151 条对话被永久判为"看过了"。
  // 对照：全库 2291 条消息只产出 36 条记忆，每一个角色都被同一处吃掉。
  //
  // 模型输出被截断、裹了前言、或吐了非数组时都会走到这儿。
  // 空数组本身仍是【合法】结果（它真的可能说"没有新的"），所以：
  //   · s 是空串 → 抛错（根本没返回内容，多半是被 max_tokens 截断）
  //   · 抠不出 [] → 抛错
  //   · JSON.parse 失败 → 抛错
  //   · 解析出来不是数组 → 抛错
  //   · 是数组（哪怕是空的）→ 正常返回
  if (!String(s || '').trim()) throw new Error('记忆总结没有返回内容（可能被 max_tokens 截断）');
  const m = String(s).match(/\[[\s\S]*\]/);
  if (!m) throw new Error('记忆总结的输出里找不到 JSON 数组');
  let arr;
  try { arr = JSON.parse(m[0]); }
  catch (e) { throw new Error('记忆总结的 JSON 解析失败：' + ((e && e.message) || e)); }
  if (!Array.isArray(arr)) throw new Error('记忆总结返回的不是数组');
  return arr.filter(x => x && x.text).map(x => ({
      text: String(x.text).trim(),
      kind: x.kind === 'event' ? 'event' : 'fact',
      // 频次：让模型顺手标出来，代码这边判起来才可靠。
      // 模型偶尔漏填时退回正则兜底，双保险。
      // 兜底正则要避开否定句（"你不经常喝咖啡"不该被判成 often）
      freq: MEM_FREQ.has(x.freq) ? x.freq
            : (/不经常|很少|偶尔|不常|没怎么/.test(String(x.text)) ? 'once'
               : (/经常|常常|总是|老是|每天|一直|习惯|经常性/.test(String(x.text)) ? 'often' : 'normal')),
      // 注意：Number(null) === 0 且 Number.isFinite(0) === true，所以必须先把
      // null / 空串排除掉。否则模型按提示词填的 null 会变成 0，pruneMemories
      // 下一轮就把它当成"早就过期"静默删掉。
      untilDay: (x.kind === 'event' && x.untilDay !== null && x.untilDay !== ''
                 && Number.isFinite(Number(x.untilDay))) ? Number(x.untilDay) : null,
      // ⚠️ 小时/分钟也必须在这里产出（v1.21.29 修，复审 新4）。
      //
      // 起因：v1.21.25 的 ★4 只修了【下游搬运】（写回时带上这两个字段），
      // 但上游本函数根本不产出它们 → 写回那两处读到的恒为 undefined → 恒写 null。
      // 也就是 ★4 的下游修复一直是【死代码】。
      // 实测：模型给 {untilDay:5, untilHour:15, untilMinute:30} → parse 后只剩 untilDay
      // → 落库 {untilHour:null, untilMinute:0} →「第 5 天 15:30 前有效」退化成 23:59，多记 8 小时 29 分。
      //
      // 同样要排除 null / 空串（Number(null) === 0 会把「没填」变成「0 点」）。
      untilHour: (x.kind === 'event' && x.untilHour !== null && x.untilHour !== ''
                  && Number.isFinite(Number(x.untilHour))) ? Number(x.untilHour) : null,
      untilMinute: (x.kind === 'event' && x.untilMinute !== null && x.untilMinute !== ''
                    && Number.isFinite(Number(x.untilMinute))) ? Number(x.untilMinute) : 0,
  }));
}

/** 时效清理：事件型记忆过了失效日就删。纯代码，每轮跑都不花钱 */
/** 把"第几天 + 几点"折算成一个可比较的总分钟数 */
function clockToMin(c) {
  const day = c?.day || 1;
  const h = typeof c?.hour === 'number' ? c.hour : 0;
  const mi = typeof c?.minute === 'number' ? c.minute : 0;
  return day * 1440 + h * 60 + mi;
}
/** 记忆的到期时刻，同样折算成总分钟数。没设小时 = 那一天过完（23:59） */
function memExpireMin(m) {
  const day = m.untilDay;
  if (typeof m.untilHour === 'number') {
    return day * 1440 + m.untilHour * 60 + (m.untilMinute || 0);
  }
  return day * 1440 + 1439;   // 没有小时 → 那天 23:59 之前都算有效
}

async function pruneMemories(charId = null) {
  // ⚠️ 角色必须【显式传进来】（v1.21.24 修，审计第 20 条）。
  //
  // 起因：本函数原来全程读实时 curCharId / clockState。而 runMemTasks 是从
  // send() 的 finally 里调的，归档最长能跑十几秒 —— 期间用户切了角色，
  // 这批记忆任务就作用到【新】角色头上。
  // 最危险的就是这里：`await mem.list()` 和 `clockToMin(clockState)` 之间隔着 await，
  // 两行之间切角色就会【用新角色的剧情天数去判旧角色记忆该不该过期】→ 误删长期记忆。
  // （下面那句注释正好在警告这件事，但代码没做到。）
  const cid = charId || curCharId;
  if (!cid) return;
  // 剧情时间也按目标角色读：curCharId 与 cid 相同时直接用内存里的 clockState（最快），
  // 不同则从 kv 读该角色自己那份（send() 冻结角色后不能再用全局 clockState）。
  let clockOf = clockState;
  if (cid !== curCharId) {
    try {
      const cl = await kv.get('clock:' + cid, null);
      if (cl && typeof cl.day === 'number') clockOf = cl;
    } catch { /* 读不到就退回全局的，总比崩了强 */ }
  }
  const list = await mem.list(cid);
  const nowMin = clockToMin(clockOf);
  for (const m of list) {
    if (m.kind !== 'event' || typeof m.untilDay !== 'number') continue;
    if (nowMin > memExpireMin(m)) await mem.del(m.id);
  }
}

let _summarizing = false;
let _deduping = false;
// 上一次整理的结果统计（条数/字数），给「立即整理记忆」的提示用。
// 只在内存里，刷新就没了 —— 它只是给用户看一眼的证据，不需要持久化。
let _lastDedupeStat = null;
let _memBusy = false;   // 三个记忆任务必须排队，不能并发改同一份数据
let _archiving = false; // 自动归档防重入（和 _memBusy 不同：这个是"这一趟还没结束就别再开一趟"）
let _memPending = false;   // 忙的时候被挡下来的调用，跑完补一次（不再静默丢弃）
let _lastMemError = null;  // 最近一次记忆任务的失败原因，给排查用（以前全被 catch 吞了）
// ⚠️ 整理被防重入挡下来时，攒一个"跑完补一次"的标记（2026-09-28 修）。
//
// 起因（用户实测）：连点几下「重新思考」后，她的记忆退回到很久以前。
// 根因是这条早退路径：
//   if (_deduping) return 0;
// 而调用方在它之前【已经】把被删内容写进 memDeleted 队列了（noteDeleted）。
// 于是那一批内容【没有任何人消费】—— 队列一直涨：
//   点第 1 次 → dedupe 开跑
//   点第 2/3/4 次 → 全部被 return 0 挡掉，但队列已经塞进去了
// 下次任意一次整理时，模型拿到的是【一大坨早就不存在的旧对话】，
// 按「这条记忆是不是只能从被删内容得到」判据一逐条比，就会误删更早形成的长期记忆。
// 这正是用户说的「点了几下后记忆回到很之前」。
// 代码里 clearChat 的注释早就警告过这个键的风险，但三个操作都没清 —— 现在补上消费。
let _dedupePending = false;
async function summarizeIfNeeded(charId = null) {
  if (_summarizing) return;
  // ⚠️ 同 pruneMemories：角色显式传入，别再读实时的 curCharId（审计第 20 条）。
  const cid0 = charId || curCharId;
  if (!cid0) return;
  // ⚠️ 必须含归档（v1.21.36 修，复审 #8）。
  // 起因：memSummed 里存的是【含已归档在内】的全部 id（runArchiveNow 的 old 来自 msgs.list(cid,0,true)），
  // 而这里默认不含归档 → 两边口径不一致，"待总结"会被算大，触发时机也跟着偏。
  const all = await msgs.list(cid0, 0, true);
  // 内容按角色（只看自己的），节奏参数用全局的。
  //
  // ⚠️ 节奏改成数【还没总结过的消息条数】，不再用 msgSeq 的差值。
  // 起因（用户实测反馈）：设置写的是"攒够几条"，代码比的却是"发了几次"——
  // msgSeq 只在 send() 里 +1，一发一收 = 2 条消息，所以设 50 实际要聊 25 个来回，
  // 用户看到的永远是"和我设的数字对不上"（正好差 2 倍）。
  //
  // 新口径的好处不只是修掉 2 倍：它数的是"真正待总结的内容量"，
  // 导入的聊天、老数据、编辑重发都不会再让计数跑偏
  // （旧口径下导入的内容一条都不算，因为 Import 不走 send）。
  //
  // seq 仍然要取：下面"记满了放弃"那条路要把水位推进到当前值。
  const seq = await getMsgSeq(cid0);
  // 归档过的消息不算"待在聊天窗口里的内容"，但它们仍在 all 里；
  // 判断"攒够了没有"要用未归档的条数，否则归档一批就等于白攒一批。
  // ⚠️ 判据改用【全部未总结】而不是【未归档里没总结的】（v1.20.20 修）。
  //
  // 起因（2026-09-29 实测真实备份）：archiveKeep=55 而 memSummarizeEvery=50，
  // 归档把 live 条数常年压在 55 上下 —— 于是 pendingNow 永远到不了 50，
  // 总结一次都不触发。实测全库 2291 条消息只产出 36 条记忆：
  //   角色G 461 条 → 12 条，角色I 445 条 → 10 条，角色B 401 条 → 3 条，
  //   角色C 101 条 → 0 条，角色O 89 条 → 0 条。
  //
  // 归档本来就会先把内容总结掉（runArchiveNow 里 summarizeChunk 在前、archive 在后），
  // 所以已归档且已总结的不该再算；但【已归档却还没总结】的必须算 ——
  // 旧写法把它们一起排除掉了，那正是积压被吃掉的地方。
  const summedNow = new Set(await kv.get('memSummed:' + cid0, []) || []);
  const pendingNow = all.filter(m => !summedNow.has(m.id));
  // ⚠️ 判据改用【待总结条数】本身，不再依赖 memSumAt 水位（2026-09-27 重构）。
  //
  // 起因：memSumAt 被设计成「上次总结到第几条」，但它和 msgSeq 的【序号】
  // 在同一个键上互相覆盖过，护栏怎么写都堵不严：
  //   · 序号 > 条数 → 护栏归零 → 归零后差值虚高，把已经总结过的又算一遍（白花 token）
  //   · 序号 < 条数 → 护栏放行 → 差值偏小甚至为负 → 该总结的不总结（永久卡死）
  // 实测用户数据：角色G 70 条待总结、memSumAt 被写成 22 → 70-22=48 < 50 → 记忆一直是空的。
  // 根因是这个键【同时存过两种量纲】，靠「猜它是哪种」永远猜不全。
  //
  // 现在直接数 pendingNow.length：它是「库里还没进过 memSummed 的消息条数」，
  // 只由一个地方维护（summarizeChunk 成功后往 memSummed 里加 id），
  // 没有第二种量纲能污染它。总结完那批 id 立刻进 memSummed，pendingNow 自己就降下去了，
  // 天然不会重复总结 —— 水位这个概念是多余的。
  //
  // memSumAt 这个键保留不动：它还在导入导出的记账清单里，
  // 删了会让老备份的字段对不上。只是不再有人读它。
  if (pendingNow.length < (S.memSummarizeEvery || 50)) return;
  // 兼容用：仍然把 memSumAt 推进到当前待总结条数。
  // 判据已经不看它了，但导入导出/清理清单里还带着这个键，
  // 让它保持一个合理的值，免得老版本读到时看到乱七八糟的数。
  const sumMark = pendingNow.length;

  // 上限要扣掉"受保护的自定义记忆"占的名额，和 dedupe 那边保持一致。
  // 不扣的话会永远卡在临界点：existing(含自定义) >= limit → 每轮都先跑一次
  // dedupe（白花一次 API），压完总数还是超 → 新记忆永远写不进去。
  const all0 = await mem.list(cid0);
  const mineCount = all0.filter(m => m.mine).length;
  // ⚠️ limit 必须【在这里定义】（v1.21.32 修）——
  // 起因：v1.21.30 我改 summarizeChunk 的 limit 口径时，把两处同名变量的定义一起删了，
  // 而这里的两行引用还在 → 每次总结都抛 `ReferenceError: limit is not defined`。
  // 后果：记忆总结【整条链路静默失败】三个测试套件同时挂（archpipeline / autoarchive）。
  // 教训：删一个 `const` 之前，先全文 grep 这个名字在【同一作用域】里的引用。
  const limit = Math.max(1, (S.memLimit || 20) - mineCount);
  // 判断口径要和 limit 一致：只看【她那边】的条数（不含受保护的）
  const herCount = () => mem.list(cid0).then(l => l.filter(m => !m.mine).length);
  if (await herCount() >= limit) {
    // 满了不能直接放弃（以前就是直接 return，导致"记满了以后聊什么都是白聊"）。
    // 先把已有的整理一次腾出位置，再决定要不要继续总结。
    // 甲方案：只有真的超了上限才这么做，平时不多花这一次请求。
    await tidyNow(cid0);   // ⚠️ 传目标角色（v1.21.30 修，复审新7）
    // 压完还是满：这次不总结了，但【不推进 memSumAt】——
    // 旧写法在这里写 seq，等于把这一批直接判"看过了"，它们永远不会再被总结。
    // 不推进，下一轮会再试；真正撑满时由 dedupe 去腾位置。
    if (await herCount() >= limit) return;
  }
  const existing = await mem.list(cid0);

  _summarizing = true;
  try {
    // 取样窗口：从上次总结过的位置往后取，而不是"倒数第二批"。
    // 旧写法 slice(0, len-20).slice(-40) 在归档后会钉死在同一段：
    // 归档把可见条数固定成 keep，len-20 就成了常数，新内容永远进不了窗口。
    // 现在按"上次总结到第几条"来推进，归档与否都能往前走。
    // 「已经总结到第几条」按消息 id 记，而不是按数组下标 ——
    // 归档会让列表变短，下标会错位。
    const summedIds = new Set(await kv.get('memSummed:' + cid0, []) || []);
    const pending = all.filter(m => !summedIds.has(m.id));
    // 至少留最近 20 条不总结（还在用的上下文，不必急着提炼）
    // 一次提炼多少条（v1.20.20 调整）。
    //
    // 原来固定 slice(0, 60)，但 summarizeChunk 的输出上限写死 5 条 ——
    // 60 条对话只榨出 5 条记忆，比例低得离谱。现在按【积压量】动态决定：
    //   · 正常情况下取 30 条（够提炼 12 条，接近输入输出 2.5:1 的合理比）
    //   · 积压多（>120）时取 60，让积压能消化掉，不至于越攒越多
    //   · 积压少就取积压本身，别硬凑
    // 反正 summary 的输出上限已经放到 12 条，输入给足才有东西可提炼。
    const backlog = pending.length;
    const take = backlog > 120 ? 60 : 30;
    const chunk = pending.slice(0, Math.max(0, backlog - 20)).slice(0, take);
    // 没有可提炼的：把"看到哪儿了"推到当前位置，别每轮重算
    if (!chunk.length) { await kv.set('memSumAt:' + cid0, sumMark); return; }
    // ⚠️ 输入里的说话人标记必须写成【名字】，不能写「我：」（2026-09-27 修）
    //
    // 起因（用户实测）：角色O这个角色的长期记忆全变成了第三人称。
    // 根因就在这一行 —— 原来标成「他：」「我：」，
    // 而提示词只说了"输出时用『我』指你自己"，**没说输入里的「我：」就是她**。
    // 模型看到一串「我：xxx」，会理解成"这是一段第一人称文本"，
    // 复述时最容易的处理就是转成第三人称（"她说……"）。
    //
    // 角色还有自称时更乱：角色O自称「妾身」，人设里写着她用「妾身」，
    // 于是"我 / 妾身 / 她"三个指代在模型脑子里打架，输出的记忆人称就飘了。
    //
    // 改成直接用名字标：『角色O：…』/『他：…』，再在提示词里写清楚
    // "输出时把名字换成『我』，把『他』换成『你』"。指代唯一，没有解读空间。
    // ⚠️ 人称和天数都必须按【目标角色】取，不能读全局（v1.21.37 修，复审 问题③）。
    //
    // 起因（子代理实测 + 对照实验）：本函数【三条写记忆路径里唯一没修的】——
    //   summarizeChunk（归档）：chars.get(charId) || curChar  ✅
    //   dedupeIfNeeded（整理）：charT / cidFor                ✅
    //   summarizeIfNeeded（本函数）：curChar?.name ← 全局     ❌ 串台
    // 实测（发消息 → 生成期间切角色 → 流结束跑记忆任务）：
    //   你是「乙角色B」   ← 应为甲角色A
    //   user: 他：甲角色A 说的第0条话 | 乙角色B：甲角色A 说的第1条话   ← 说话人 A 却标成 B
    //   剧情第 77 天（A 的真实天数是 3）  ← day 取错 → event 类 untilDay 全算错
    //   写回: A=1 | B=0   ← 【数据写对了、人称写错了】
    //
    // 与 summarizeChunk 完全同构。
    const charT = (await chars.get(cid0)) || curChar;
    const who = charT?.name || '她';
    const txt = chunk.map(m => (m.role === 'user' ? '他：' : who + '：') + (m.content || '[图片]')).join('\n');
    // ⚠️ mine 单独分区（v1.21.37 修，复审 3.5）——
    // 它的人称【不统一】（用户自己写的可能用第三人称），而 AI 记忆强制用「我/你」。
    // 混在一起当示范会让模型模仿坏人称。
    const knownAI = existing.filter(m => !m.mine).map(m => '- ' + m.text).join('\n');
    const knownMine = existing.filter(m => m.mine).map(m => '- ' + m.text).join('\n');
    const known = (knownAI ? knownAI : '（还没有）')
      + (knownMine ? '\n\n【以下是他自己手写的，人称仅供参考、\u26a0\ufe0f不要模仿】\n' + knownMine : '');
    // 剧情天数同 summarizeChunk：一律取【目标角色自己】的那份。
    // ⚠️ v1.21.38 修：原来判据是 `if (cid0 !== curCharId)` —— 只在切了角色时才读 clock:<cid0>，
    // 同角色时直接吃全局 clockState.day。但 loadClock 是【按角色覆盖全局】的：
    // 生成期间切角色会把全局换成新角色的值，此时 cid0 === curCharId 但 day 已经是别人的天数。
    // 上方注释里实测到的「剧情第 77 天（A 的真实天数是 3）」就是这个形态。
    // 现在无条件读 clock:<cid0> —— 同角色时它本来就等于当前值，读了不会错。
    let day = clockState.day;
    try {
      const cl = await kv.get('clock:' + cid0, null);
      if (cl && typeof cl.day === 'number') day = cl.day;
    } catch { /* 读不到就用全局的，总比崩了强 */ }
    const out = await onceChat({
      apiKey: S.apiKey, baseUrl: S.baseUrl, provider: S.provider, model: S.model,
      // 输出最多 5 条，但已知列表（known）会让输入很长、模型也容易话多，
      // 给 2048 留足余量（默认 1024 偏紧，同样会截断 JSON）。
      maxTokens: 2048,
      messages: [
        { role: 'system', content:
          `你是「${who}」，正在回顾你和他的对话，把值得长期记住的事记到心里。\n\n`
          // ⚠️ 人称这一段必须写死"名字 → 我"的映射（2026-09-27 修）。
          // 起因：角色O的长期记忆全成了第三人称。
          // 原来只写"用『我』指你自己"，但模型不知道输入里的标记指谁；
          // 而且带自称的角色（角色O自称妾身）会让指代更乱。
          // 现在明确：输入里 `${who}：` 开头的是她自己，输出一律换成「我」。
          + `【人称 —— 最重要，写错整条记忆就废了】\n`
          + `  · 下面【${who}：】开头的是你自己说的话 → 输出时换成「我」。\n`
          + `  · 下面【他：】开头的是他说的 → 输出时换成「你」。\n`
          + `  · 【一律用「我」和「你」，不许用第三人称】。\n`
          + `    错误示范："${who}喜欢喝咖啡"、"他说她怕黑" —— 这样写等于在写别人的事。\n`
          + `    正确："我喜欢喝咖啡"、"你怕黑"。\n`
          + `  · 你自己怎么称呼自己（比如自称「妾身」）是【说话时】的事，\n`
          + `    记忆里统一用「我」，不要写成"妾身喜欢……"。\n\n`
          + `【分两类】\n`
          + `· fact = 关于他本人的稳定事实（喜好、习惯、经历、关系、忌讳、在意的东西），不会过期。\n`
          + `· event = 有时限的事（假期、约定、某段时间的状态），要给出失效的那一天。\n\n`
          + `【失效日】现在是剧情第 ${day} 天。他提到有时限的事（假期、约定、某段状态）时，`
          + `算出它到哪一天为止还算数，填进 untilDay；拿不准就填 null。\n\n`
          + `【不要记】今天在哪、什么天气、这一轮聊了什么这类【跟人无关的临时信息】。\n`
          + `  注意：这里说的是"不值得记的内容"，不是"只提过一次的内容"——\n`
          + `  只提过一次但关于他本人的事（老家在哪、养的猫叫什么），是要记的。\n\n`
          + `【频次】留意这件事他提到过几回：\n`
          + `· 反复出现、或他说过"经常/总是/每天"的 → freq 填 "often"，措辞也带上"经常"。\n`
          + `· 提过两三次的 → freq 填 "normal"。\n`
          + `· 只提过一次的 → freq 填 "once"。\n`
          + `· 他明确说过"记住这个""别忘"的 → freq 填 "pinned"，并且要写得具体。\n\n`
          + `【去重】下面给你已经记得的。只写新的；意思重复的不要写。\n\n`
          + `【宁缺毋滥 —— 这条最重要】\n`
          + `  上面「最多 5 条」是上限，不是指标。绝大多数轮次里，值得长期记住的只有 0~2 条。\n`
          + `  以下这些【不要记】：\n`
          + `  · 这一轮具体发生了什么（发生了"吵架""抱了一下"这类过程，不记；\n`
          + `    但如果是关于他的稳定偏好或关系变化，那要记）\n`
          + `  · 你自己当时的心情、想法、反应（"我觉得他……"、"我有点……"）\n`
          + `  · 你能看出来但没人说出口的推测（"他好像喜欢……"、"他可能不想……"）\n`
          + `  · 把一句话换个说法重记一遍\n`
          + `  宁可这次输出 []，也不要用不重要的事把记忆撑满 ——\n`
          + `  记忆满了就得丢掉旧的，丢掉的往往比新记的更有用。\n\n`

          // ⚠️ 必须给【可执行的判据】，不能只喊"宁缺毋滥"。
          // 起因（用户实测反馈）：以前这段只有一句"删掉它会有什么不同"，
          // 太抽象，模型照样每轮塞 2~3 条，20 条上限很快撑满 ——
          // 用户看到的就是"什么事都放进长期记忆"。
          // 抽象口号拦不住，必须给能当场数、能当场比的三条硬标准。
          + `【够不够格，逐条过这三关 —— 有一关不过就不记】\n`
          + `  第 1 关【三个月后还有用吗】：三个月后翻到这条，你还觉得有用吗？\n`
          + `    只对今天/这一阵有意义的，全部不记。\n`
          + `    过：「他老家在成都」「他怕黑」「他胃不好，不能吃辣」\n`
          + `    不过：「他今天加班到十点」「他刚洗完澡」「他心情不太好」\n`
          + `  第 2 关【能照着做出反应吗】：下次碰到相关场景，\n`
          + `    这条能让你做出不一样的反应吗？不能就是废话。\n`
          + `    过：「他不吃香菜」（点菜时记得避开）\n`
          + `    不过：「他今天吃了面」（知道了也不知道该干嘛）\n`
          + `  第 3 关【是不是换了个说法】：下面「已经记得的」里，\n`
          + `    有没有一条和它讲的是同一件事？有就【不要写】——\n`
          + `    合并是整理那一步的活，不是在这里再记一条。\n\n`
          + `  【输出前的自查】数一下你准备写的条数：\n`
          + `    如果超过 2 条，逐条再问一遍"这条真的过得了三关吗"。\n`
          + `    说得出"删了也没什么"的，删掉。\n\n`
          + `【输出】只输出 JSON 数组，不要别的话。最多 5 条（通常更少）；没有值得记的就输出 []。\n`
          + `格式：[{"text":"...","kind":"fact","untilDay":null,"untilHour":null,"untilMinute":null,"freq":"often"}]\n`
          // ⚠️ 小时/分钟要写进格式里（v1.21.29 修，复审 新4）——
          // 只有 kind="event" 且你知道【具体钟点】时才填，否则留 null。
          // 不写出来的话模型根本不知道能填，parseMemJson 那边加了字段也只收到 null。
          + `    （untilHour / untilMinute 只在 kind="event" 且你知道具体钟点时填，例如「今天 18:00 前」→ untilDay:1, untilHour:18, untilMinute:0；不知道就留 null）\n\n`
          + `已经记得的：\n${known}` },
        { role: 'user', content: txt }
      ]
    });
    const items = trimByFreq(parseMemJson(out), 5);
    for (const it of items) {
      // ⚠️ 用 cid0（本函数的形参 charId，没传就回落到当前角色）。
      // 这个函数 v1.21.25 起【有参数了】—— 下面这段历史说明保留，但结论已过时：
      //
      // 原来的写法是 cidFor，但 cidFor 是【另一个函数】dedupeIfNeeded 里的
      // 局部变量（const cidFor = charId || curCharId），本函数根本访问不到。
      // 于是每次模型【正常返回了记忆】之后，这一行都抛
      //   ReferenceError: cidFor is not defined
      // 而调用链上有 step() 包着 try/catch —— 异常被吞，只在 console 留一行，
      // 界面上什么都看不到。用户看到的就是「记忆整理没生效」，记忆永远是空的。
      //
      // 这个笔误从 v1.18.10 基线里就在（不是这次改出来的），
      // 意味着那之后所有版本的记忆总结【一次都没成功写进过库】。
      // 同一个错误还叠了一层：onceChat 没关思考模式，模型把 JSON 写进了
      // reasoning_content，content 是空串（见 api.js onceChat 的注释）。
      // 两层叠在一起 = 记忆功能整体失效，且完全静默。
      // ⚠️ untilHour/untilMinute 一起写（v1.21.25 修，复审 ★4 的同类遗漏 ——
      // 报告只点了 3 处，全库扫下来还有 2 处，这是其中一处）。
      await mem.add({ id: uid(), charId: cid0, text: it.text, kind: it.kind,
                      untilDay: it.untilDay,
                      untilHour: typeof it.untilHour === 'number' ? it.untilHour : null,
                      untilMinute: typeof it.untilMinute === 'number' ? it.untilMinute : 0,
                      freq: it.freq, ts: Date.now() });
    }
    // ⚠️ 【单向门】还有第二处（v1.21.35 修）。
    //
    // 起因：报告只点了 runArchiveNow 那一处（P0-1），我按它修完之后写行为测试，
    // 结果实测「模型返回 0 条，memSummed 仍涨了 30 条」——查出来是【这里】。
    // 原来无条件把整批 chunk 记进 memSummed，而上面 mem.add 的循环在 items 为空时不写任何东西 →
    // 这批消息被标记"看过了"，内容一条没留下，且【永远不会再被总结】。
    // 这正是用户备份里 3369 条标记 / 65 条记忆那条主路。
    //
    // 修法与 runArchiveNow 一致：没提炼出内容就不记账（留待下次重试），
    // 但要有出口 —— 同一批连续试 ZERO_RETRY_MAX 次仍为 0，就认了并放行。
    // ⚠️ 第一版这里我照抄 runArchiveNow 写了 `items.length`，但本函数【当时没有】这个变量
    //    （循环是内联的 trimByFreq(...)）→ ReferenceError，而调用链上 step() 把它 try/catch 吞了
    //    → 记忆总结整条链路静默失败（archpipeline / autoarchive 两套同时挂）。
    //    现在把结果提取成 items，循环和判断共用。
    // ⚠️ v1.21.38 修 P0（复发）：这里原来写的是 const sig = '_all' ——
    // 正是 v1.21.35 被定性为「本项目丢记忆的最大单一来源」的那个角色级单计数器。
    // 危害：判据 zr[sig] >= 3 是【逐批】执行的，而计数是【跨批累计】的 ——
    // 于是每 3 个 0 产出批次就有 1 批被记进 memSummed、永不重读。
    // 现在与 runArchiveNow 口径一致：per-batch 签名 + 独立键位（两路不再互相清零）。
    const rk = zeroRetryKey('sum', cid0);
    if (items.length > 0) {
      const nowSummed = [...summedIds, ...chunk.map(m => m.id)];
      await kv.set('memSummed:' + cid0, nowSummed);   // 同上：不截断
      await kv.set(rk, {});                          // 成功了，清掉本链路的重试计数
    } else {
      const zr = (await kv.get(rk, {})) || {};
      const sig = batchSig(chunk);
      zr[sig] = (zr[sig] || 0) + 1;
      await kv.set(rk, zr);
      if (zr[sig] >= ZERO_RETRY_MAX) {
        const nowSummed = [...summedIds, ...chunk.map(m => m.id)];
        await kv.set('memSummed:' + cid0, nowSummed);
        delete zr[sig];
        await kv.set(rk, zr);
      }
    }
    // 新口径：记"已经攒到第几条"，不再是 msgSeq 的序号
    await kv.set('memSumAt:' + cid0, sumMark);
  } finally { _summarizing = false; }
}

// ---------- 查重：每 N 轮把那堆记忆摆开来合并一次 ----------
/**
 * 整理记忆（唯一的实现 —— 手动归档、定时查重、设置页按钮都走这里）。
 * 以前 dedupeFor 是抄了一份出来的，两份逻辑已经开始漂移
 * （copy 少带了"被删对话"处理），所以合并成一个。
 *
 * @param force  忽略节奏门槛，立刻跑
 * @param charId 要整理哪个角色的记忆（默认当前正在聊的）
 * @param noTick true = 不改节奏水位（手动归档时用，它自己管记账）
 */
/**
 * 被删对话队列的【裁剪出口】（v1.21.28 抽取，复审 新2'）。
 *
 * 语义：攒满 20 条以上仍然没成功核对过，就只留最近 20 条 ——
 * 近的才是用户真正刚删的，远的（几次整理都没轮到）本来就是陈账，留着弊大于利。
 * 队列越长，下次整理时模型要逐条比对的旧内容越多，误删长期记忆的概率越高。
 *
 * ⚠️ 之所以抽成函数：原来这段写在 tooFew 的 return 之后，
 * 模型一抽风触发 tooFew 就【永远够不到】—— 而它的注释恰恰在描述那个场景。
 * 现在两条出口（tooFew / 模型没返回可用结果）都调用它。
 */
async function pruneDeletedQueue(cidFor, cached) {
  try {
    const deleted = cached || (await kv.get('memDeleted:' + cidFor, [])) || [];
    if (deleted.length > 20) {
      await kv.set('memDeleted:' + cidFor, deleted.slice(-20));
      console.warn('[记忆整理] 被删对话清单已从', deleted.length, '条裁剪到 20 条');
    }
  } catch { /* 裁剪失败不影响主流程 */ }
}

/**
 * 清掉「强制整理」标记（v1.21.36 新增，复审 新A2）。
 *
 * 背景：重聊/重思考会置 memNeedTidy=true，让下一次整理即使攒不够也务必跑一趟。
 * 但 v1.21.35 只有【成功重写之后】那一处清它 ——
 * 而 dedupeIfNeeded 有 5 个早退/失败出口在这之前（length<3 / mine 占满 / tooFew / 抛错…），
 * 一旦某次因网络或解析失败抛错，标记【永久为 true】→
 * 此后每条消息都被强制放行 → 每轮白花一次整理 API。
 *
 * 所以现在每个出口都调它。
 */
async function clearNeedTidy(cid) {
  try { await kv.set('memNeedTidy:' + cid, false); } catch { /* 清不掉不影响正确性 */ }
}

async function dedupeIfNeeded(force = false, charId = null, noTick = false, reason = '') {
  // ⚠️ 被挡下来时【必须记一笔】，不能静默 return 0（2026-09-28 修）。
  // 见 _dedupePending 的注释：调用方在进来之前已经把被删内容写进 memDeleted 队列了，
  // 直接丢掉这一趟 = 队列永远没人消费，攒到下次整理时误删更早的长期记忆。
  if (_deduping) { _dedupePending = true; return 0; }   // 忙碌：保留标记，让这次之后真的跑一趟
  const cidFor = charId || curCharId;
  // 记忆按角色分开，节奏也跟着分开。用累计序号（只增不减）数，
  // 数"当前可见条数"的话，归档或清空之后这个差值会变负，整理就再也不触发了。
  const cnt = await getMsgSeq(cidFor);
  // 必须只取当前角色的。以前是 mem.all()，而下面收尾会 del 掉整个 list 再写新的 ——
  // 等于把别的角色攒的记忆全删了、用当前角色的口吻重写一遍，互相串台。
  const listAll = await mem.list(cidFor);
  // ⚠️ 查重门槛改成数【记忆条数】，不再数"发了几次"。
  // 起因（用户实测反馈）：设置写的是"隔多少轮"，代码比的是 msgSeq 差值，
  // 而 msgSeq 只在 send() 里 +1 —— 一发一收算 1 次，导入/老数据一次都不算。
  // 两处错位叠加，用户看到的永远是"轮次对不上"。
  //
  // 更重要的是【语义】：「该不该查重」取决于记忆有多少条、有没有重复的，
  // 和你聊了几轮没有关系 —— 两个月没聊但记忆已经 20 条撑满，一样该整理。
  //
  // 新门槛用"自上次整理后又新增了几条"：新增到上限的一半（至少 3 条）才值得跑。
  // 上限 20 时 = 新增 10 条跑一次；配合"撑满必跑"两条一起生效。
  let lastLen = (await kv.get('memDedupeAt:' + cidFor, null));   // let：下面量纲自愈会夹紧它
  // ⚠️ 【量纲自愈】必须先做（v1.21.28 修，复审 新1'）。
  //
  // 起因：上一版删掉了 tooFew 分支里的 memDedupeAt = listAll.length。
  // 那行表面上是「推进水位」，实际还兼任【老数据量纲自愈】——
  // v1.21.25 之前归档往这个键写过 seq（可能几百），删掉后：
  //   记忆 30 条、水位 500 → grew = -470 恒负 → 水位恒为 500，永不自愈。
  // 而下面注释承诺的「每次成功整理都会把条数写回去，一次之后就自愈了」——
  // tooFew 是【失败】路径，现在失败了也不写回，自愈路径被切断。
  //
  // 后果：grownEnough 恒 false，自动整理只剩 nearlyFull（记忆 ≥ 16 条）一条命；
  // 一旦记忆掉到 16 条以下，自动整理【永久不触发】。
  //
  // 修法：把「节奏水位」与「量纲自愈」拆成两件事。
  // 这里无条件夹紧只修量纲，不改变「该不该跑整理」的判断 ——
  // 夹紧后的值就是当前真实条数，grew 算出来是 0，与「首次运行」等价。
  if (typeof lastLen === 'number' && lastLen > listAll.length) {
    await kv.set('memDedupeAt:' + cidFor, listAll.length);
    lastLen = listAll.length;   // ⚠️ 夹紧后同步给当次判断（v1.21.29 修，复审 新11）——
                                // 原来这里重复读了一次同一个键，而下面的 grew 仍用【夹紧前】的旧值。
                                // 实测影响为零（夹紧后 grew 恒 0，而过不了门槛），属冗余读取 + 语义误导。
  }
  // ⚠️ 量纲已统一为【记忆条数】（v1.21.25 根治，复审 ★5）。
  //
  // 历史：这个键被归档写过 msgSeq 序号（几百），被本函数写过条数（十几），
  // 读出来一律当条数 → grew 恒为负 → 自动查重永久卡死。
  // 上一版用"值大于条数就当序号"的启发式掩盖症状，副作用是归档后 grew=null →
  // grownEnough 恒真 → 每次归档后都多跑一次整理。
  //
  // 现在写侧全部统一成条数（归档不再碰这个键），这里的启发式一并删掉。
  //
  // ⚠️ 老数据兼容：库里可能还存着旧的 seq 值（例如 200）。不做专门迁移 ——
  // 那种情况下 grew 是负数，grownEnough 为 false，会靠 nearlyFull 兜底；
  // 而本函数每次成功整理都会把条数写回去，一次之后就自愈了。
  const grew = (typeof lastLen === 'number') ? listAll.length - lastLen : null;
  const grownEnough = grew === null || grew >= Math.max(3, Math.floor((S.memLimit || 20) / 2));
  const nearlyFull = listAll.length >= Math.max(3, Math.floor((S.memLimit || 20) * 0.8));
  // ⚠️ 门槛里必须带上【队列非空】（v1.21.29 修，复审 新1）。
  //
  // 起因：这行排在队列读取（下面几行）之前，于是记忆数 < nearlyFull 时
  // 队列【既不消费也不裁剪】—— 而下面那段的注释恰恰写着「或者有被删的对话要清理」，
  // 语义想表达，位置却写在门槛之后。
  //
  // 实测（用户的真实备份）：5 个角色卡死，其中 3 个队列已满 40 条 ——
  //   角色G 12 条 / 队列 40；角色H 0 条 / 队列 7；
  //   角色I 10 条 / 队列 40；角色J 0 条 / 队列 18；角色F 4 条 / 队列 40。
  // 后果是「删了她还记得」永不消失。
  const qPending = (await kv.get('memDeleted:' + cidFor, [])) || [];
  // ⚠️ 并入【强制整理标记】（v1.21.35 修，P0-3 配套）。
  // 重聊/重思考删完消息会置这个标记，让这次整理即使攒不够也务必跑一趟。
  const _needTidy = await kv.get('memNeedTidy:' + cidFor, false);
  if (!force && !grownEnough && !nearlyFull && !qPending.length && !_needTidy) return 0;   // 没够：标记没用上，不用清
  // ⚠️ 关键：整理是"全删重写"（下面 del 掉整个 list 再按模型结果写回）。
  // 所以要把【你自己加的】那几条先摘出来，不让模型碰 ——
  // 否则它会把"你必须记住我喜欢美式"改写成"他有喝咖啡的习惯"，甚至直接丢掉。
  // 角色页的开关 allowEditMine 打开时，才允许一起交给模型。
  // ⚠️ 按【目标角色】取参数和人称（v1.21.25 修，复审 ★2）。
  //
  // 起因：上一版算对了 cidFor 用它读写记忆【数据】，但送模型的"人称"和
  // "生效参数"仍读全局 curChar。给 A 跑整理时用户切到 B →
  // 提示词变成「你是「B角色」……「我」指你（B角色）」，整理的却是 A 的记忆
  // → 模型把 A 的记忆自称改成 B 的名字，【长期记忆人称串台】。
  // 3541 还会取错 allowEditMine，让 A 的自定义记忆保护失效。
  //
  // 同一个文件里 summarizeChunk 的写法是对的（chars.get(charId) || curChar），
  // 两处并存说明这是遗漏，不是设计。
  const charT = (await chars.get(cidFor)) || curChar;
  const P = effSettings(charT, S);
  const protectMine = !P.allowEditMine;
  const mineList = protectMine ? listAll.filter(m => m.mine) : [];
  const list = protectMine ? listAll.filter(m => !m.mine) : listAll;
  const deleted = (await kv.get('memDeleted:' + cidFor, [])) || [];
  // 只有当记忆够多、或者有被删的对话要清理时才值得跑一趟
  if (list.length < 3 && !deleted.length) { await kv.set('memDedupeAt:' + cidFor, listAll.length); await clearNeedTidy(cidFor); return 0; }

  _deduping = true;
  try {
    const who = charT?.name || curChar?.name || '她';
    // 受保护的自定义记忆占着名额，得从总上限里扣出来，
    // 否则整理完 total 会超出上限（她那边没超，加上你自己加的却超了）。
    // 受保护的占着名额，从上限里扣。但【不能扣成负数】——
    // 以前 Math.max(1, -5) = 1，等于告诉模型"只准留 1 条"，
    // 30 条记忆会被压成 1 条，方向完全反了。
    // 自定义的已经占满上限时，就别再整理她那边了（保持原样最安全）。
    const total = S.memLimit || 20;
    if (mineList.length >= total) {
      // 自定义记忆自己就占满了全部名额，她那边没地方可压。
      // 这里【故意不推进 memDedupeAt】：
      //   推进了就等于宣告"这一批整理过了"，之后无论照常还是撑满都不再试；
      //   不推进，用户删掉一条自定义记忆后下次就能自动接上。
      // 代价是每次触发都走到这儿 —— 纯内存判断，不花 token。
      //
      // ⚠️ 但【队列仍要裁剪】（v1.21.36 修，复审 新A3）。
      // 起因：这个 return 在 pruneDeletedQueue 之前，于是 mine 占满时
      // 队列【既不消费也不裁剪】，一路攒到 40 上限。
      // 与 v1.21.28 修的「tooFew 时队列出口够不到」是同一根因的漏网之鱼。
      // 真实数据佐证：memDeleted 已有 3 个角色顶着 40 条上限。
      await pruneDeletedQueue(cidFor);
      await clearNeedTidy(cidFor);
      return 0;
    }
    const limit = Math.max(1, total - mineList.length);
    // 带上 freq 和"是不是这一批新写的"——模型要靠它决定哪些保留细节、哪些可以抽象掉。
    // 用时间戳区分新旧，不需要改数据结构。
    const freshCut = Date.now() - 5 * 60 * 1000;
    const src = JSON.stringify(list.map(m => ({
      text: m.text,
      kind: m.kind || 'fact',
      untilDay: m.untilDay ?? null,
      // ⚠️ v1.21.39 修（复审第二轮 #5）：钟点必须跟着送出去。
      // 原来只送 untilDay，而输出白名单又写死「字段只有这四个」——
      // 模型看不到钟点、也不被允许回填，parseMemJson 的 untilHour 兜底（见 3771）
      // 于是永远拿不到值 → 「第 5 天 15:30 前有效」退化成 23:59，记忆多存活约 8.5 小时。
      // ⚠️ 注意：另两条写回路径（summarizeChunk / summarizeIfNeeded）本来就是对的，
      // 只有【整理这条】漏了 —— 属于同一处的疏忽，不是全局缺陷。
      untilHour: m.untilHour ?? null,
      untilMinute: m.untilMinute ?? null,
      freq: m.freq || 'normal',
      ...(m.ts > freshCut ? { isNew: true } : {}),
    })));
    const out = await onceChat({
      apiKey: S.apiKey, baseUrl: S.baseUrl, provider: S.provider, model: S.model,
      // ⚠️ 必须显式给足输出预算（2026-09-26 修）
      //
      // onceChat 默认 max_tokens=1024。整理是「把 N 条重新吐一遍」的活，
      // 输出长度和输入条数成正比 —— 实测 23 条记忆时模型需要 1200+ token，
      // 撞上 1024 就被截断，JSON 断在半截，正则匹配不到 ']'，
      // parseMemJson 返回 []，界面报「模型这次没返回可用的内容」。
      // 表现和"模型没认真合"一模一样，但完全是两码事。
      //
      // 这里按输入字数估算：整理后大约是原文的 70%，中文约 1 字 = 1 token，
      // 再留一倍余量防 JSON 结构开销。下限 2048，上限 8192。
      maxTokens: Math.min(8192, Math.max(2048,
        Math.ceil(list.reduce((n, m) => n + String(m.text || '').length, 0) * 1.4) + 512)),
      messages: [
        { role: 'system', content:
          `你是「${who}」。下面是你记下的关于他的事。请把它们重新整理一遍——\n`
          + `⚠️ 这不是「看看要不要整理」，是【动手整理】。把下面这些原样返回等于这次白做。\n\n`

          + `【第一步：合并同主题的条目 —— 必做】\n`
          + `  凡是【在讲同一件事、同一个人、同一个方面】的条目，一律并成一条。\n`
          + `  判定标准很宽：只要你一眼看过去觉得「这几条说的是一个事」，就要合。\n`
          + `  例：「你喜欢美式」「你改喝拿铁了」「你不加糖」「你每天要喝两杯」\n`
          + `      → 「你有喝咖啡的习惯，每天两杯，不加糖，最近从美式改喝拿铁」\n`
          + `  例：「你怕冷」「你冬天总开暖气」「你睡觉要盖厚被子」\n`
          + `      → 「你怕冷，冬天靠暖气，睡觉要盖厚被子」\n`
          + `  例：「你在做设计」「你最近接了个活」「你说客户很难缠」\n`
          + `      → 「你是做设计的，最近接了个难缠客户的活」\n`
          + `  ⚠️ 合并后条数【必须少于】原来的条数。整理完和原来一样多，就是没认真合。\n\n`

          // ⚠️ 上面那三个例子都是「同一件事的不同说法」，但真实数据里更难的是
          // 【同一件事的不同侧面】—— 模型看不出它们是"一个事"。
          // 实测（用户数据，角色E 23 条）：5 条在说他喜欢看她什么反应
          // （挣扎 / 呜呜叫 / 高潮的神态）、6 条在说他喜欢的衣物道具
          // （袜子 / 裤袜 / 裙摆），字面完全不同，模型认为"不是一回事"，一条都不合。
          // 所以必须补一组【侧面型】的例子。
          + `  ⚠️ 特别注意【同一件事的不同侧面】—— 这类最容易漏合：\n`
          + `     它们字面上完全不同，但说的其实是他的同一个偏好 / 同一段经历。\n`
          + `     例：「他喜欢看我挣扎」「他喜欢听我被堵嘴呜呜叫」「他喜欢看我高潮的样子」\n`
          + `        → 「他喜欢看我挣扎、被堵嘴、高潮时的样子」\n`
          + `     例：「他喜欢袜子丝袜裤袜」「他喜欢我穿蕾丝花边白袜」「他喜欢拿袜子堵我嘴」\n`
          + `        → 「他痴迷袜子类的东西，喜欢我穿，也喜欢拿来堵我嘴」\n`
          + `     例：「他住处隔音好」「他房子不大只有一间」「他房里没厨房只有饮水机」\n`
          + `        → 「他住处：隔音好、一间屋、没厨房（只有饮水机和烧水壶）」\n`
          + `     例：「他亲口说有你够了」「他说想对我负责像夫妻那样」「他说我既是老婆也是妹妹」\n`
          + `        → 「他明确说过：有你就够了，想对你负责像夫妻那样（也当你是妹妹）」\n`
          + `     判据：**如果这几条将来会在同一个场景里被一起回想起来，它们就是一件事。**\n\n`

          + `【第二步：合并之后再压成「大意」—— 必做】\n`
          + `  合完再往回收一层：每条压成【一句话大意】，能省几个字是几个字。\n`
          + `  只留「这件事是什么」，去掉「当时怎么说的、具体到某个数字」这类枝叶。\n`
          + `  例：「你有喝咖啡的习惯，每天两杯，不加糖，最近从美式改喝拿铁」\n`
          + `      → 「你有喝咖啡的习惯，最近改喝拿铁了」\n`
          + `  例：「你怕冷，冬天靠暖气，睡觉要盖厚被子」→「你怕冷，过冬靠暖气」\n`
          + `  ⚠️ 压缩【不能把主干砍了】——「喝咖啡」不能压成「有饮料习惯」，\n`
          + `     「怕冷」不能压成「体感偏敏感」。去掉的是枝叶，不是核心。\n`
          + `  ⚠️ 涉及【他的忌讳、他明确要求你记住的、他给过的承诺】不要压，原样保留措辞。\n\n`

          + `【第三步：该丢的丢掉】\n`
          + `  · 已经被后来说的内容覆盖掉的旧状态（说了「改喝拿铁」，「喜欢美式」就不必再单独留）\n`
          + `  · 你自己当时的心情、想法、反应（「我觉得他……」）\n`
          + `  · 你能看出来但没人说出口的推测\n`
          + `  条数目标 ${limit} 条以内，但这是参考不是硬指标 ——\n`
          + `  真正重要的是【合并和压缩到位】。宁可 12 条精炼的，不要 20 条啰嗦的。\n`
          + `  pinned 和 often 的不要丢。\n\n`

          + `【输出前自检】\n`
          + `  数一遍：有没有两条说的是一回事？有就再合一次。\n`
          + `  再看每条：还能不能更短、但意思没丢？能就再压。\n\n`

          + `【规则】\n`
          // ⚠️ 整理也要把人称写死（2026-09-27 修）——它会把记忆重新吐一遍，
          // 人称飘了就等于把好的也改坏了。
          + `  · 【人称 · 必须守住】「我」指你（${who}），「你」指他。\n`
          + `    不许出现「${who}怎么怎么样」「她说……」这种第三人称写法。\n`
          + `    你自己说话时怎么自称（比如「妾身」）不影响这里，记忆里统一用「我」。\n`
          // ⚠️ v1.21.39 修（复审第二轮 #5）：白名单从四个字段扩到六个，加上钟点。
          + `  · kind 和 untilDay 照原样保留；合并条目时取更晚的那个 untilDay。\n`
          + `  · untilHour / untilMinute 照原样保留；合并时取更晚的那个时刻。\n`
          + `  · freq 保留原样；合并时取优先级更高的那个（pinned > often > normal > once）。\n`
          + `  · 【字段只有这六个】text / kind / untilDay / untilHour / untilMinute / freq。\n`
          + `    不要加 isNew、id、reason、note 之类的额外字段 —— 没用，还占输出长度。\n`
          + `  · 只输出 JSON 数组，格式同输入，不要别的话。`
          // ⚠️ 这段是【删除】语义专用，必须写得很保守（2026-09-26 收紧）。
          //
          // 起因（用户实测）：编辑重发后记忆倒退到很久以前。
          // 根因是这条指令太宽 —— 原话是"记忆里如果有哪条【只在】那些内容里出现过，
          // 就把那条一起去掉"。模型执行时会放宽成"沾边就删"，
          // 把更早总结好的、同样提到这个主题的记忆一起抹掉。
          //
          // 现在加三道闸：
          //   ① 明确"只在"= 那条记忆【完全】来自被删内容，一个字都不在别处出现过
          //   ② 拿不准就【保留】—— 宁可多留一条，也不要错删
          //   ③ 禁止因为"主题相关"就删；必须是同一条具体的事
          // ⚠️【她已经删掉的那段对话，产生的记忆要一起清掉】（2026-09-26 重写）
          //
          // 用户需求（原话）：
          //   「要动，在我操作了对话后后续的聊天里的记忆都要动」
          //   「十句话里我在第五句点了在这重聊后后面几个全删掉，
          //     不影响她新的思考输出」
          //
          // 为什么要清：留着的话，她带着"已经发生过的事"重新生成，
          // 就是用户说的「污染记忆产生偏差」。
          //
          // ⚠️ 但清理【必须精准】—— 这正是之前"记忆倒退到很久以前"的根因：
          // 旧指令是"记忆里如果有哪条【只在】那些内容里出现过，就把那条一起去掉"，
          // 模型会放宽成"沾边就删"，把更早形成的长期事实也抹掉。
          //
          // 现在给【配对判据】而不是只丢一堆原文 ——
          // 让模型拿每条记忆去对照被删内容，回答一个具体问题：
          //   「这条记忆，是不是【只能】从被删的那几句里得到？」
          // 是 → 删；更早的对话里本来就有 → 留。
          // 判据具体、可逐条执行，比"只在……出现过"这种模糊措辞准得多。
          + (deleted.length
            ? `\n【另外：清理被删对话产生的记忆】\n`
              + `  他刚删掉了一段对话（在下面列出）。那段对话里产生的记忆，\n`
              + `  现在要一起清掉 —— 否则你会带着"已经发生过的事"继续，判断会偏。\n\n`
              + `  【逐条判断，就问一句话】\n`
              + `    这条记忆，是不是【只能】从被删的那几句里得到？\n`
              + `      · 是   → 删掉它\n`
              + `      · 不是 → 留着（说明它来自更早的对话，是已经形成的长期事实）\n\n`
              + `  【必须留着的情况】\n`
              + `    · 那条记忆的内容，在【更早的对话】里就已经成立 —— 就算被删内容也提到了它。\n`
              + `    · 拿不准的时候【一律留着】。多留一条没坏处，错删一条她的记忆就缺一块。\n\n`
              + `  【例子】\n`
              + `    被删的是：「今天又喝了两杯咖啡」「有点困」\n`
              + `      ✓ 删：「今天他说有点困」（只能从被删内容得到）\n`
              + `      ✗ 留：「他每天早上必须喝咖啡」（早就知道，跟今天这次聊天无关）\n`
              + `      ✗ 留：「他胃不好不能吃辣」（跟咖啡没关系，是被删内容之外的）\n\n`
              + `  【禁止】因为"话题相关"就删。必须是【同一条具体的事】。\n`
              + `    被删内容提到咖啡 ≠ 所有关于咖啡的记忆都要删。\n`
            : '')
          + (deleted.length ? `\n【他删掉的对话】\n- ` + deleted.join('\n- ') : '')
          + (deleted.length ? `\n\n【现在要整理的记忆】（逐条对照上面被删的内容判断）\n` : '') },
        { role: 'user', content: src }
      ]
    });
    // ⚠️ 这里【不再用 limit 当硬闸门】。
    // 起因（用户实测反馈）：提示词里写的是"条数目标是参考不是硬指标，
    // 宁可 12 条精炼的不要 20 条啰嗦的"，代码这边却拿 limit 当闸门一刀切。
    // 模型照提示词合出 12 条精炼的 —— limit 是 20，这一刀完全不起作用，
    // 条数一个字都没变，用户看到的是"整理没用"，实际是代码把结果原样放回去了。
    // 提示词和代码互相打架，代码这边赢，模型白干。
    //
    // 现在的分工：
    //   · 合并与压缩做没做到 → 交给提示词 + 输出前自检 + 整理报告去判断
    //   · 上限 → 只在【真的超了】时兜底，用 limit 的 1.5 倍留出"精炼但条数多"的空间
    //     （宁可多几条短的，也不要被代码砍成少几条但每条都啰嗦）
    // ⚠️ 这里【单独包一层】（v1.20.20）。
    //
    // parseMemJson 现在解析失败会抛错（以前静默返回 []）—— 那是对的行为，
    // 因为静默 [] 会被 summarizeChunk 当成“模型说没有新的”，把整批对话
    // 记进 memSummed 永久丢掉。
    //
    // 但整理这条路不一样：它已经走到准备重写这一步了，抛出去只会让
    // memDedupeAt 不更新 → 下一轮又跑一次 → 每轮白花一次 API 直到成功。
    // 所以这里就地降级成空数组 = 这次不整理，原样保留已有记忆，也不推进水位。
    //
    // 安全前提：下面的记忆删除在 if (items.length) 里面，空数组走不到那里，
    // 所以解析失败绝不会删掉任何一条已有记忆。
    // ⚠️ 必须区分【解析失败=抽风】和【合法空数组=模型明确说没东西】（v1.21.37 修，复审 1.4）。
    //
    // 起因：初值写 []，两种情况的 parsed 都是 [] → 下游分不出来 →
    // memDeleted 队列【只累积不消费】，撑到 40 上限反复截断。
    // 实测：角色G 40 / 角色I 40 / 角色F 40（全顶满 slice(-40)）。
    //
    // 现在：初值 null，解析成功才赋值 → parseOK 判"模型确实回了合法 JSON"。
    let parsed = null;
    let parseOK = false;
    try { parsed = parseMemJson(out); parseOK = true; }
    catch (e) { console.warn('[记忆整理] 输出解析失败，本次跳过（不改动已有记忆）：', (e && e.message) || e); }
    if (parsed === null) parsed = [];   // 解析失败：当空处理（但 parseOK=false，不清队列）
    const hardCap = Math.max(limit, Math.ceil(limit * 1.5));
    const items = trimByFreq(parsed, hardCap);
    // 整理报告用的统计：条数 + 字数（用户要看得见它到底干了什么）
    // 字数很关键 —— 只看条数的话，"合并 + 压成大意"有没有生效是看不出来的。
    //
    // rawLen：模型这次到底吐回了几条（解析后、被裁之前）。
    // 有这个数，"没变化"才能分出是哪种：
    //   · rawLen === 0        → 模型空返回/解析不出 JSON（功能没生效）
    //   · rawLen > items.length → 模型确实合了，是上限兜底裁掉的
    //   · rawLen === before   → 模型原样返回，真没认真合
    // 以前这四种情况共用一句"多半是这次没找到可合并的条目"，等于什么都没有说。
    _lastDedupeStat = {
      before: list.length,
      after: items.length,
      rawLen: parsed.length,
      charsBefore: list.reduce((n, m) => n + String(m.text || '').length, 0),
      charsAfter: items.reduce((n, it) => n + String(it.text || '').length, 0),
    };
    // ⚠️ 下限保护（v1.21.24 修，审计第 2 条）。
    //
    // 起因：整理是【先写新、再把整份旧记忆逐条 del】的全量重写。
    // 触发它不一定要用户点按钮 —— 归档过程中记忆写满时会调 dedupeFor(charId)
    // （force=true，绕过所有门槛）去"腾位置"，而那条路【不写备份】。
    // 模型那次若只回 1~2 条，旧记忆就被全部删光、且无备份可撤。
    // 实测证据：整理前 total=20（mine=5/AI=15），归档 30 条后 → total=7，AI 记忆 15→2。
    //
    // 判据：新条数不能少于原有的【一半】。模型抽风时宁可这次不整理，
    // 也不能让它把记忆库清空 —— 记忆丢了找不回来，多跑一次整理只是多花点 token。
    // ⚠️ 判据用【绝对下限】，不是比例（v1.21.24 定稿）。
    //
    // 一开始写的是"不少于原有的一半"，结果 e2e-archive2 挂掉 ——
    // 那个场景是记忆【满额】时需要压缩腾位置，模型把 20 条并成 1 条是【正常】的
    // （本来就该大幅合并）。按半数判就会误杀这条正常路径，归档直接失败。
    //
    // 现在只挡"把整库清空"这种极端情况：
    //   · 原有 ≥ 4 条，却只合出 0 条 → 一定是抽风
    //   · 原有 ≥ 8 条，却只合出 1 条 → 低于任何合理的合并比，判定异常
    // 记忆丢了找不回来，多跑一次整理只是多花点 token，所以宁严勿松地兜这一层。
    // ⚠️ 判据再收紧一档（v1.21.25 修，复审 ★3）。
    //
    // 上一版写成 `list.length >= 8 && items.length <= 1`，两个缺口：
    //   · 原有 2~7 条时保护【完全不生效】→ 7 条被合出 1 条照样销毁
    //   · items === 2 也不拦 → 20 条变 2 条照样发生
    // 实测矩阵（复审报告）：
    //   原有 7 → 回 1/2/3 条，全部销毁（完全没保护）
    //   原有 8 → 回 1 条才拦，回 2/3 条照样销毁
    //
    // 现在分两档：
    //   · 原有 ≥ 4 条，却只合出 ≤ 1 条 → 拦（比 1/4 还低，肯定是抽风）
    //   · 原有 ≥ 8 条，却合出不到 30% → 拦（20 → 5 以下就太离谱）
    // 保留 e2e-archive2 那种"满额压缩"的正常路径：20 → 8 条放行。
    // ⚠️ 【记忆已满时的强压缩】要放宽（v1.21.28 修，复审 新3_）。
    //
    // 起因：记忆满（20/20）时 summarizeChunk 会调 dedupeFor 腾位置，
    // 若它走 tooFew 分支则什么都不做，room 仍为 0 → 抛错 → 【整条归档链路停摆】。
    // 实测对照（同一造数，只改模型整理返回）：
    //   A) 模型回 1 条  → tooFew 拦 → 记忆 20 条不变 → 归档 0/106
    //   B) 模型回 12 条 → 正常重写   → 记忆 15 条    → 归档 72/106
    //
    // 而「20 条并成 1 条」在满额强压缩时是【正常】的（e2e-archive2 就靠它）。
    // 所以 force + 记忆满的场景只拦"一条都没合出来"。
    // ⚠️ 放宽只给【腾位置】那条路（v1.21.29 修，复审 新2）。
    //
    // 起因：上一版写成 `force && memFull`，把两种 force 路径混为一谈 ——
    //   路径A summarizeChunk 腾位置：压狠合理（e2e-archive2 靠它），有后续写入
    //   路径B 设置页「立即整理记忆」按钮：无后续写入，压狠是【纯损失】
    // 两者在本函数内部不可区分，于是 20 条可被压成 1 条 —— 保护恰好在最需要它的「满额」处失效。
    // 实测矩阵：原 3 条→1 条[重写]；原 4/7/8/10/15 条→原样[拦住]；原 20 条→1 条[重写]。
    //
    // 现在只有 reason === 'makeRoom' 才放宽。
    const memFull = listAll.length >= (S.memLimit || 20);
    // ⚠️ destructive 提到这里【复用】（v1.21.30 修，复审新6）。
    //
    // 起因：下面写备份那处已经识别出这是破坏性重写（所以刷新了备份），
    // 却没回流来拦截重写本身 —— 同一函数内两处结论矛盾。
    // 放宽后的唯一判据是 items.length === 0，返回 1 条就全放行：
    //   实测 模型回 1 条 → ai 15→1（toast 只说「整理出 1 条记忆」）★ 销毁
    //        模型回 12 条 → 正常 15→13
    //        模型回 []   → 正确拦下 ⇒ 反证仅「0 条」被拦
    const destructive = list.length > 0 && items.length < list.length * 0.5;
    const tooFew = (reason === 'makeRoom' && memFull)
      ? (items.length === 0
         || (destructive && items.length < Math.max(2, Math.floor(list.length * 0.25))))
      : ((list.length >= 4 && items.length <= 1)
         || (list.length >= 8 && items.length < Math.max(2, Math.floor(list.length * 0.3))));
    if (tooFew) {
      console.warn('[记忆整理] 模型只合出 ' + items.length + '/' + list.length
                   + ' 条（低于下限保护阈值），判定为抽风，本次放弃重写、保留原样');
      _lastDedupeStat.rawLen = parsed.length;
      _lastDedupeStat.aborted = 'tooFew';
      // ⚠️ 这里【什么都不推进】（v1.21.27 修，复审 新2）。
      //
      // 上一版注释写的是"不推进水位"，代码却写了 memDedupeAt = 当前条数 ——
      // 于是 grew 恒为 0、grownEnough 恒 false，而 nearlyFull（记忆 ≥ 16 条）仍成立 →
      // 反复触发、反复被拦，而 `return 0` 又跳过了后面清 memDeleted 队列那行：
      //   · 「删了她还记得」永久不自愈
      //   · 队列越攒越长，下次真跑整理时误删概率上升
      // 实测：连跑两次都是「tooFew 拦截 / 新水位 20 / 队列剩余 2」。
      //
      // 现在真的不推进水位：下次进来 grew 仍按旧水位算，攒够了自会重试。
      //
      // ⚠️ 但队列的【裁剪出口】必须在这里也走一次（v1.21.28 修，复审 新2_）。
      //
      // 起因：下面那个"攒满 20 条就只留最近 20 条"的兜底出口在 return 之后，
      // 模型一旦抽风到触发 tooFew，那段【永不执行】——
      // 而它的注释恰恰在描述这个场景（"模型连续几次抽风 → 队列只进不出 → 越攒越长"）。
      // 讽刺的是注释写在了够不到的位置。
      //
      // 现在两条出口都调用同一个裁剪逻辑。
      await pruneDeletedQueue(cidFor);
      await clearNeedTidy(cidFor);   // 同 mine 出口（v1.21.36，新A2）
      // ⚠️ v1.21.39 修（复审第二轮 #1）：这里【必须 return】，而且要在上面两行清理【之后】。
      //
      // 起因：这一版为了把 pruneDeletedQueue / clearNeedTidy 搬进 tooFew 分支，
      // 连原来那句 `return 0` 一起删了 —— 于是 tooFew 判定完【不停下】，
      // 直接掉进下面的 `if (items.length)`，用那 1~3 条残缺结果覆盖掉整库记忆。
      // 上面 4587 行的注释自己写着「return 0 又跳过了清 memDeleted 队列那行」，
      // 说明当时是【为了让它后面的清理能跑到】才动的 return，结果把保护本体一起删了。
      // 此后 v1.21.24/25/28/29/30 五轮「修复」都只是在改日志文本，保护一直是失效的。
      //
      // 顺序要求：先清理（那是 v1.21.28 特意搬进来的出口），再 return。
      return 0;
    }
    if (items.length) {
      // ⚠️ 重写前【先备份】，但有条件（v1.21.27 修，复审 新3）。
      //
      // 上一版是无条件覆盖 —— 用户点了「立即整理记忆」留下撤销点后，
      // 后台自动整理再跑一次就把这个点冲掉了。
      // 现在改成【没有备份才写】：首次自动整理仍有撤销点，但不会覆盖用户手动留下的那个。
      // 以前只有设置页那个手动按钮写备份，归档催出来的那次整理是全裸的。
      try {
        const prevBk = await kv.get('memTidyBackup:' + cidFor, null);
        // ⚠️ 破坏性重写时【强制刷新备份】（v1.21.29 修，复审 新10）。
        //
        // 起因：备份条件是「没有备份才写」，而满额强压缩放宽后模型回 1 条也放行 →
        // 20 条被重写成 1 条；若用户之前手动整理过（已有备份），这次【不写新备份】
        // → 撤销点仍是 7 天前那个旧快照 → 点撤销回不到销毁前。
        //
        // 判据：新条数不到原有的一半就算破坏性重写，无条件覆盖备份。
        // destructive 已在上面定义（新6 修复时上移复用）
        if (destructive || !prevBk || !prevBk.items || !prevBk.items.length) {
        await kv.set('memTidyBackup:' + cidFor, {
          at: Date.now(),
          // ⚠️ 备份必须存【全量 listAll】，不能存 list（v1.21.30 修，复审一级）。
          //
          // 起因：list = listAll.filter(m => !m.mine)（只含非 mine），
          // 而撤销那边按【全量差集】删（keepIds 里没有的一律 del）——
          // 两边口径不一致 → 自定义记忆的 id 不在 keepIds 里 → 【全部被删】。
          //
          // 实测复现：总数 28（mine 5 + ai 23）→ 备份只存 23 条、mine 0 条
          // → 撤销后 mine 0 条，5 条用户手写的记忆【静默消失】，
          // 而 toast 还报「已撤销，记忆回到 23 条」。
          //
          // 为什么以前没爆：设置页那个手动按钮会先写一份全量备份，
          // 把这里的 !prevBk 分支挡住；而归档 → makeRoom → dedupe 这条路没有预置备份，
          // 直接落到这份残缺备份上。v1.21.29 新增的 destructive 判据让这条路更常走。
          //
          // 语义上「撤销 = 回到整理前的样子」，本来就该存全量。
          items: listAll.map(m => ({ id: m.id, text: m.text, kind: m.kind, untilDay: m.untilDay,
                                    untilHour: m.untilHour, untilMinute: m.untilMinute,
                                    freq: m.freq, mine: !!m.mine })),
        });
        }
      } catch { /* 备份失败不该挡住整理本身 */ }
      // 先写新的再删旧的：中途出问题最多多点重复，不会把记忆清空
      for (const it of items) {
        // ⚠️ untilHour/untilMinute 不能丢（v1.21.25 修，复审 ★4）。
        // 丢了的话「第 5 天 15:30 前有效」会退化成「第 5 天 23:59」——
        // 到期时刻推迟 8 小时 29 分，她会在本该忘记之后还记得大半天。
        // （上面那个备份特意带了这个字段，这里却漏了，属于同一处的疏忽。）
        await mem.add({ id: uid(), charId: cidFor, text: it.text, kind: it.kind,
                        untilDay: it.untilDay,
                        untilHour: typeof it.untilHour === 'number' ? it.untilHour : null,
                        untilMinute: typeof it.untilMinute === 'number' ? it.untilMinute : 0,
                        freq: it.freq, ts: Date.now() });
      }
      // 只删【参与了整理】的那些。受保护的自定义记忆压根没进 list，所以不会被动。
      for (const m of list) await mem.del(m.id);
      // 只有真的核对过（拿到非空结果）才把"被删对话"清单清掉。
      // 以前这行在 if 外面：模型没返回可解析 JSON 时清单被白清，
      // 「删了她还记得」就会反复出现。
      await kv.set('memDeleted:' + cidFor, []);
      // ⚠️ 队列消费掉了，强制标记也一并清（v1.21.35，P0-3）。
      try { await kv.set('memNeedTidy:' + cidFor, false); } catch { /* 清不掉不影响 */ }
    } else if (parseOK && !parsed.length && deleted.length) {
      // ⚠️ 模型【明确返回了合法空数组】= 它说"按这些被删内容，没有记忆需要改"（v1.21.37 修，复审 1.4）。
      //
      // 这与"解析失败（抽风）"是两回事：
      //   · parseOK=false → 模型输出坏了，队列必须留着下次再判
      //   · parseOK=true 且空数组 → 它真的核对过了，队列可以清
      // 以前两者都走 else 分支 → 队列只进不出，撑到 40 反复截断。
      await kv.set('memDeleted:' + cidFor, []);
      await clearNeedTidy(cidFor);
    } else if (deleted.length) {
      // ⚠️ 模型没返回可用结果、队列里却攒着东西时的兜底（2026-09-28 新增）。
      //
      // 上面那个 if 保证了"核对过才清"，但反过来没有出口：
      // 模型连续几次抽风 → 队列只进不出 → 越攒越长。
      // 而队列越长，下次整理时模型要逐条比对的旧内容越多，误删长期记忆的概率越高
      // （noteDeleted 只保留最近 40 条，超过的会被 slice 挤掉，但那 40 条仍然是陈年旧账）。
      //
      // 所以这里设一个出口：攒满 20 条以上仍然没成功核对过，就只留最近 20 条 ——
      // 近的才是用户真正刚删的，远的（几次整理都没轮到）本来就是陈账，留着弊大于利。
      await pruneDeletedQueue(cidFor, deleted);
    }
    // 新口径：记"这次整理完还剩几条"，下次靠"又新增了多少条"决定要不要再跑。
    // 旧口径记的是 msgSeq 序号，和记忆内容完全无关，
    // 导致"手动整理一次"会把自动那条路的水位一起重置掉。
    if (!noTick) await kv.set('memDedupeAt:' + cidFor, await mem.list(cidFor).then(l => l.length));
    return items.length;   // 整理出几条（dedupeFor 的调用方要看这个）
  } finally {
    _deduping = false;
    // ⚠️ 抛错路径也要清 memNeedTidy（v1.21.37 修，复审 ④）。
    //
    // 起因：本函数的 try 块【只配了 finally、没有 catch】——
    // onceChat 网络失败 / parseMemJson 抛错 / mem.add 配额异常都会直接冒泡，
    // 而四个 clearNeedTidy 调用点【全在早退出口】（length<3 / mine 占满 / tooFew），
    // 抛出路径一个都够不到。
    // 后果：memNeedTidy 永久为 true → 门槛短路失效 →
    // 【此后每条消息都强制跑一次整理、白烧 token】，而 tidyNow 把异常 .catch 掉了，
    // 界面上完全看不到。
    //
    // ⚠️ 只加清理，【不要】改成 catch + return 0 ——
    //    异常必须继续冒泡给 tidyNow 记 _lastMemError，否则界面报不出"整理失败"。
    await clearNeedTidy(cidFor).catch(() => {});
    // 这趟期间有调用被防重入挡下来过 → 补跑一次，把 memDeleted 队列消费掉。
    // 只补一次、不递归堆积：补跑时若又有人进来，会再置一次标记，最多多跑一趟。
    // setTimeout(0) 而不是直接 await —— 补跑要重新走一遍防重入检查，
    // 直接递归调用会在 _deduping=false 的瞬间同步重入，语义反而更绕。
    if (_dedupePending) {
      _dedupePending = false;
      // ⚠️ 补跑也要带上 reason（v1.21.30 修，复审新8）——
    // 少了它，补跑会退回【严格 tooFew 判据】，memDeleted 队列延迟消费（非丢失）。
    setTimeout(() => { dedupeIfNeeded(true, cidFor, noTick, reason).catch(() => {}); }, 0);
    }
  }
}

/**
 * 记下被删掉的对话内容。
 * 记忆是模型总结出来的，一条记忆可能横跨好几条消息，没法精确对应到某条——
 * 所以这里只把「被删了什么」攒起来，等下次整理记忆时一并交给模型，
 * 让它判断哪几条记忆只在那段被删的对话里出现过，然后清掉。
 */
/**
 * 跑一次「立刻整理」，失败要留痕（D，2026-09-28）。
 *
 * 以前四处调用点全是 `dedupeIfNeeded(true).catch(() => {})` ——
 * 失败连 console 都不进。用户看到的是"我删了/我改了，她还记得"，
 * 而真实原因是整理那一步抛了（网络、JSON、记忆写满）。
 * 这里统一记进 _lastMemError，由「立即整理记忆」按钮和 runMemTasks 报出来。
 */
function tidyNow(charId = null, reason = '') {
  return dedupeIfNeeded(true, charId, false, reason).catch((err) => {
    console.error('[记忆整理] 失败：', err);
    _lastMemError = { step: '整理记忆', msg: (err && err.message) || String(err), at: Date.now() };
  });
}

async function noteDeleted(texts, charId = curCharId) {
  const clean = (texts || []).map(t => String(t || '').trim()).filter(Boolean);
  if (!clean.length) return;
  // 按角色分开攒：这是「谁的对话被删了」，混在一起会让 A 删的内容
  // 在 B 整理记忆时也生效，把 B 好好的记忆一起抹掉。
  const key = 'memDeleted:' + charId;
  const old = (await kv.get(key, [])) || [];
  // ⚠️ 去重后再截断（v1.21.35，P1-1 配套）。
  // 起因：同一段话被反复 noteDeleted（重聊多次）会在队列里留多份，
  // 队列越长，下次整理时模型要逐条比对的旧内容越多 → 越容易抽风 → 死结。
  const merged = [...new Set(old.concat(clean))];
  await kv.set(key, merged.slice(-40));   // 最多攒 40 条
  // 已删掉写入（白名单里也去掉了）。
}

/**
 * 三个记忆任务排队跑。
 * 必须串行：dedupe 是「先写新的、再删旧的」，要是 prune 中途插进来把新写的当过期删掉，
 * dedupe 随后又把旧的删掉，记忆就整个清空了。
 */
async function runMemTasks(charId = null) {
  // ⚠️ 角色一路透传（v1.21.24 修，审计第 20 条）。
  //
  // 起因：send() 用 myCharId 冻结了角色来保护【消息落库】（做得对），
  // 但 finally 里的 runMemTasks() 不带参数，内部四个任务各自读实时 curCharId。
  // 归档最长可跑十几秒，期间切角色 → 这批记忆任务作用到新角色头上。
  // 最危险的是 pruneMemories：可能用新角色的剧情天数误删旧角色的长期记忆。
  const cidM = charId || curCharId;
  if (_memBusy) {
    // ⚠️ 不丢弃：记一笔，等这一趟跑完自动补一次。
    // 起因（用户实测）：发消息触发的这轮如果撞上正在跑的归档（可能要十几秒），
    // 以前直接 return —— 这一轮的记忆工作【永久消失】，用户看到的是
    // "有时候不会自动整理"，而且完全没有提示。
    _memPending = true;
    return;
  }
  _memBusy = true;
  try {
    // ⚠️ 四个任务必须【各自 try/catch】，一个失败不能连累后面三个。
    // 起因（真实数据实测）：某个角色积压 1990 条未归档，同时记忆是 0 条。
    // 原因是这四步串行，前面任何一步抛错，后面全部跳过 ——
    // 而 autoArchiveIfNeeded 排在最后，所以它【永远】轮不到，
    // 积压从装包那天起就没动过。一个失败拖垮全部，而且错被吞掉看不见。
    await step('时效清理', () => pruneMemories(cidM));
    await step('记忆总结', () => summarizeIfNeeded(cidM));
    await step('查重整理', () => dedupeIfNeeded(false, cidM));
    // 滚动归档放在最后：它内部也会总结+整理，
    // 让 summarize/dedupe 先把"还在聊天窗口里的新内容"消化掉，
    // 归档再去收拾更早的，两边的账不会互相踩。
    await step('自动归档', () => autoArchiveIfNeeded(cidM));
  } finally {
    _memBusy = false;
    // 这一趟期间有别的调用被挡下来了 → 补跑一次（只补一次，不递归堆积）
    if (_memPending) {
      _memPending = false;
      setTimeout(() => { runMemTasks(cidM).catch(() => {}); }, 0);
    }
  }
}

/**
 * 跑一个记忆子任务，把异常拦在这一步之内。
 * 失败不抛出（否则整条链断掉），但要留下痕迹 ——
 * 以前 `runMemTasks().catch(() => {})` 把一切都吞了，
 * 出了事用户在界面上看不到、日志里也没有，只能靠"感觉不对"。
 */
async function step(name, fn) {
  try { return await fn(); }
  catch (err) {
    console.error('[记忆任务·' + name + '] 失败：', err);
    _lastMemError = { step: name, msg: (err && err.message) || String(err), at: Date.now() };
    return null;
  }
}

/**
 * 记忆任务的互斥锁。手动归档也要走这里 ——
 * 归档正在写记忆时若 prune 插进来把它当过期删掉，记忆就整个没了（这坑踩过）。
 * 拿不到锁时返回 null，调用方自己给提示，而不是默默什么都不做。
 */
async function withMemLock(fn) {
  // ⚠️ 这里【不再 toast】（v1.21.24 修，审计第 19 条）：
  // 调用方（设置页「立即整理记忆」）已经按返回值 toast 了一次，
  // 两处都弹用户会看到重复提示。让调用方当唯一出口，语义也更准。
  if (_memBusy) return { ok: false, msg: '忙碌中' };
  _memBusy = true;
  try { return await fn(); }
  finally { _memBusy = false; }
}

/**
 * 把一段对话交给模型总结成记忆（手动归档时按批调用）。
 * 和自动总结的区别：这个不自己判断门槛，也不改 memSumAt。
 */
async function summarizeChunk(charId, chunk) {
  if (!chunk || !chunk.length) return 0;
  const char = (await chars.get(charId)) || curChar;
  const who = char?.name || '她';
  // 日期要取这个角色自己的剧情时间。读全局 clockState 的话，
  // 归档跑到一半切了角色，后半批就会拿新角色的天数去算失效日。
  let day = clockState.day;
  if (charId !== curCharId) {
    try {
      const cl = await kv.get('clock:' + charId, null);
      if (cl && typeof cl.day === 'number') day = cl.day;
    } catch { /* 读不到就用全局的，总比崩了强 */ }
  }
  const existing = await mem.list(charId);
  const known = existing.length ? existing.map(m => '- ' + m.text).join('\n') : '（还没有）';
  // ⚠️ 说话人必须标【名字】，不能标「我：」（v1.20.20 修，和 summarizeIfNeeded 对齐）。
  // 起因：summarizeIfNeeded 那条路早就改成用名字了（见那边的长注释），
  // 归档这条路漏了 —— 模型看到一串「我：xxx」，会理解成一段第一人称文本，
  // 复述时转成第三人称，记忆里的人称就飘了（角色O那次就是这么来的）。
  const txt = chunk.map(m => (m.role === 'user' ? '他：' : who + '：') + (m.content || '[图片]')).join('\n');
  const out = await onceChat({
    apiKey: S.apiKey, baseUrl: S.baseUrl, provider: S.provider, model: S.model,
    messages: [
      { role: 'system', content:
        `你是「${who}」，正在回顾你和他的对话，把值得长期记住的事记到心里。\n\n`
        + `【人称 —— 最重要，写错整条记忆就废了】\n`
        + `  · 下面【${who}：】开头的是你自己说的话 → 输出时换成「我」。\n`
        + `  · 下面【他：】开头的是他说的 → 输出时换成「你」。\n`
        + `  · 一律用「我」指你自己，用「你」指他，【不要用第三人称】，也不要写名字。\n`
        + `  例：✓「你喜欢坐在窗边发呆」　✗「他喜欢坐在窗边发呆」　✗「${who}喜欢…」\n\n`
        + `【分两类】\n`
        + `· fact = 关于他本人的稳定事实（喜好、习惯、经历、关系、忌讳、在意的东西），不会过期。\n`
        + `· event = 有时限的事（假期、约定、某段时间的状态），要给出失效的那一天。\n\n`
        + `【失效日】现在是剧情第 ${day} 天。他提到有时限的事时，算出它到哪一天为止还算数，`
        + `填进 untilDay；拿不准就填 null。\n\n`
        + `【不要记】今天在哪、什么天气、这一轮聊了什么、一次性的话题。\n\n`
        + `【频次】反复出现或他说过"经常/总是/每天"的填 "often"；提过两三次填 "normal"；`
        + `只提过一次填 "once"；他明确说过"记住这个"的填 "pinned" 并写具体。\n\n`
        + `【去重】下面给你已经记得的。只写新的；意思重复的不要写。\n\n`
        + `【输出】只输出 JSON 数组，最多 12 条；没有新的就输出 []。\n`
        + `格式：[{"text":"...","kind":"fact","untilDay":null,"freq":"often"}]\n\n`
        + `已经记得的：\n${known}` },
      { role: 'user', content: txt }
    ]
  });
  // ⚠️ 模型跑完（最长 90 秒）之后再核一次活体（v1.21.54，审计发现）。
  //
  // 调用方在【调模型之前】核过一次，之后就不管了 —— 而用户长按删一条老消息，
  // 在这 90 秒里完全来得及（归档时 busy 是 false，菜单可用），
  // 且删除触发的清理队列（noteDeleted → tidyNow）很可能在这期间先跑完。
  // 结果：被删内容提炼出的记忆永久留下，用户看到的是「我明明删了她还记得」——
  // 正是这套代码声称已经修掉的那个场景。
  //
  // 处理：整批作废 —— 不写记忆、也不记账（返回 0，上层会把它放进 held 留待下次），
  // 于是下一轮归档会把这段重新总结一遍。宁可重花一次总结的钱，
  // 也不能把用户明确删掉的话记进她的长期记忆。
  try {
    const aliveAfter = new Set((await msgs.list(charId, 0, true)).map(m => m.id));
    const goneCount = chunk.filter(m => !aliveAfter.has(m.id)).length;
    if (goneCount) {
      console.warn('[记忆总结] 这批里有 ' + goneCount + ' 条在总结期间被删掉了，整批作废、下次重来');
      return 0;
    }
  } catch { /* 核不了就按原样走，至少不比以前差 */ }
  // 写之前先看还有没有位置。归档是"一批一批"写的，每批都无条件写 5 条的话，
  // 几批下来就把上限冲穿了 —— 实测上限 20、归档 7 批，记忆涨到 35。
  // ⚠️ limit 必须扣掉【受保护的自定义记忆】（v1.21.30 修，复审新1）。
  //
  // 起因：dedupeIfNeeded 那边算的是 `Math.max(1, total - mineList.length)`（扣了 mine），
  // 而这里用的是裸上限 —— 两处各写各的"上限"，口径不一致。
  // 当 mine + ai == memLimit 且 ai 很少时：
  //   cur（全量，含 mine）>= limit → 调 makeRoom →
  //   dedupe 因 list.length < 3 或 mineList >= total 而【什么都没压】→
  //   room 仍为 0 → 抛「记忆已满」→ 归档 break。
  //
  // 实测（同一造数，只改 mine 条数）：mine=10/ai=15 成功；mine=0/ai=15 成功；
  //   mine=25/ai=0 → 停摆，toast「记忆已满（25/25），整理不动了」，archived=0。
  // 新12 的护栏挡不住这种——它只判 mineN >= lim，挡不住 mineN = lim-1 的"差一点点"组合。
  //
  // ⚠️ 注意：下面 cur 取的是【全量】（含 mine），所以这里扣一次即可，别再重复扣。
  const _charT = (await chars.get(charId)) || curChar;
  const _P = effSettings(_charT, S);
  const _protectMine = !_P.allowEditMine;
  let _mineN = 0;
  if (_protectMine) {
    try { _mineN = (await mem.list(charId)).filter(m => m.mine).length; } catch { _mineN = 0; }
  }
  // ⚠️ 【总量】上限也要算（v1.21.32 修，复审 #6）。
  //
  // 起因：limit 只扣了 mine（= "可写名额"），但【没有约束总量】——
  // mine=10 时 limit=10、curWritable=0 → 判定没满 → room=10 → 直接写 10 条，
  // 总量变成 20 条（10 mine + 10 ai），正好等于 memLimit；
  // 而下一轮 writeable 又变 0 起点 …… 实测总记忆【净增 12 条】冲穿上限。
  //
  // 正确判据：room 应该同时受【总量上限】和【可写名额】约束 ——
  //   总上限：memLimit - cur.length（cur 是全量）
  //   可写名额：(memLimit - mineN) - curWritable
  // 两者取小。mine 占满时总上限那项会先归零 → room=0 → 正确抛出"记忆已满"。
  const totalCap = (S.memLimit || 20) - _mineN;   // 非 mine 部分最多能有多少
  let cur = await mem.list(charId);
  // 受保护的自定义记忆不占"可写名额"，但它们在 cur 里 —— 比较时要减掉，
  // 否则 mine 多的时候会误判"满了"。
  // ⚠️ 这里必须用【函数】而不是常量（v1.21.30 自查修正）。
  //
  // 起因：我第一版把 curWritable 算成常量，但它在【压缩前】就定值了 ——
  // dedupeFor 腾完位置后 cur 更新了，curWritable 还是旧值 → room 恒为 0 →
  // 归档永远"记忆已满"。e2e-archive2 场景 2 直接挂（归档 0 条）。
  const writableOf = (arr) => _protectMine ? arr.filter(m => !m.mine).length : arr.length;
  if (writableOf(cur) >= totalCap) {
    try { await dedupeFor(charId, 'makeRoom'); cur = await mem.list(charId); } catch { /* 压不动就按下面的来 */ }
  }
  const curWritable = writableOf(cur);   // ← 压缩【之后】才算
  // 两个约束取小：curWritable 不能超过 totalCap（总量口径）
  const room = Math.max(0, totalCap - curWritable);
  // 腾不出位置就抛错，让调用方【停下来】。
  // 以前这里 return 0，而归档那边只 catch 抛错 —— 返回 0 被当成"成功"，
  // 这批对话就被记了账并归档了，可它们根本没变成记忆，等于永久丢失。
  if (!room) throw new Error('记忆已满（' + curWritable + '/' + totalCap + (_mineN ? '，另有 ' + _mineN + ' 条自定义记忆受保护' : '') + '），整理不动了');
  // 一次多记几条（v1.20.20）：原来写死 5，而一批就是 40 条对话，
  // 只提炼 5 条等于把大部分内容丢掉。改成 12。
  // 上限仍受 room（剩余名额）约束，不会冲穿 memLimit。
  const items = trimByFreq(parseMemJson(out), Math.min(12, room));
  for (const it of items) {
    // ⚠️ 同上（v1.21.25 修）——这是【最常走】的一条写回路径。
    await mem.add({ id: uid(), charId, text: it.text, kind: it.kind,
                    untilDay: it.untilDay,
                    untilHour: typeof it.untilHour === 'number' ? it.untilHour : null,
                    untilMinute: typeof it.untilMinute === 'number' ? it.untilMinute : 0,
                    freq: it.freq, ts: Date.now() });
  }
  return items.length;
}

// ================= 输入框 =================
// ⚠️ 高度上限从 S.inputMaxH 现算，不再写死 120（v1.21.48）。
// 写死过一版，结果：设置里调到 10 行，autoGrow 仍然把它压回 120px ——
// 同一个数字【在 CSS 和 JS 里各有一份】，改一处等于没改。现在 CSS 吃 --input-max 变量，
// 两边都从 S.inputMaxH 来。
function autoGrow(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, inputMaxPx()) + 'px';
}

/** 当前设置下的输入框像素上限（3 行 ≈ 120px，就是老版本的默认观感）。 */
function inputMaxPx() {
  const n = Number(S.inputMaxH);
  return (Number.isFinite(n) && n > 0 ? n : 3) * 40;
}

/**
 * 输入框的最小高度。
 *
 * ⚠️ 写死 42，不要写「有内容就 46」——试过一版，结果【一行文本的框永远回不到 42】：
 * 实测 min(46, …) 把一行的高度也抬到 46，而一行自己只有 41，看起来就是「没打字的框变胖了」。
 * 一行的高度本来就由 scrollHeight 自己决定（41 内容 + 边框 = 43，和空框一样）。
 */
function inputMinPx() {
  return 42;
}

/**
 * 输入框的字数 + 自动增高（v1.21.48）。
 *
 * 改动前：高度靠 input 事件单独算，字数根本没有。
 * 现在合成一处，是因为「从失败里还原输入框内容」「编辑重发回填」那两处
 * 是直接给 input.value 赋值的 —— 不派发 input 事件，只调 autoGrow 的话字数不会更新。
 *
 * 字数只在【回车是换行】时显示：设置页自己写着这句话。
 * 回车即发的人不需要字数 —— 他没机会写长，字数是纯噪音。
 */
function syncInput() {
  const el = $('input');
  if (!el) return;
  const box = el.parentElement;
  if (box) box.style.setProperty('--input-max', inputMaxPx() + 'px');
  const full = el.scrollHeight > inputMaxPx() + 1;   // 已经顶到上限 → 让它能滚
  el.style.height = '';
  el.style.height = Math.max(inputMinPx(), Math.min(el.scrollHeight, inputMaxPx())) + 'px';
  el.style.overflowY = full ? 'auto' : 'hidden';
  // 字数只在「回车换行」且真有内容时出现（v1.21.50：连整行的显隐一起管）。
  // 空着必须【整行藏掉】—— 它现在是独立一行，留着就是一条空白（用户看到的那一截）。
  const showCount = (S.enterSend === false) && !!el.value;
  const meta = $('input-meta');
  if (meta) meta.classList.toggle('hidden', !showCount);
  const c = $('input-count');
  if (c) c.textContent = showCount ? ('已写 ' + el.value.length + ' 字') : '';
}

function renderAttachPreview() {
  const box = $('attach-preview');
  if (!pendingImages.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  box.classList.remove('hidden');
  box.innerHTML = pendingImages.map((src, i) =>
    `<div class="thumb">`
    + `<div class="pic"><img src="${esc(src)}"><button class="x" data-i="${i}">✕</button></div>`
    + `<input class="note" type="text" data-i="${i}" placeholder="说明这张图…" value="${esc(pendingNotes[i] || '')}">`
    + `</div>`).join('');
  box.querySelectorAll('.x').forEach(b => b.onclick = () => {
    const i = Number(b.dataset.i);
    pendingImages.splice(i, 1);
    pendingNotes.splice(i, 1);   // 图删了，它的说明也一起删
    renderAttachPreview();
  });
  box.querySelectorAll('.note').forEach(inp => {
    inp.oninput = () => { pendingNotes[Number(inp.dataset.i)] = inp.value; };
  });
}

// ================= 头像裁剪 =================
let cropImg = null, cropScale = 1, cropX = 0, cropY = 0, cropBase = 1, cropSize = 300;
let cropTarget = 'char';   // 'char' = 角色头像，'me' = 我的头像

function openCropper(dataUrl, target = 'char') {
  cropTarget = target;
  const img = new Image();
  img.onload = () => {
    cropImg = img;
    const stage = $('crop-stage');
    const size = Math.max(200, Math.min(window.innerWidth - 60, 330));
    cropSize = size;
    stage.style.width = size + 'px';
    stage.style.height = size + 'px';
    const cv = $('crop-canvas');
    cv.width = size * 2;      // 2 倍分辨率，输出更清晰
    cv.height = size * 2;
    // 基准缩放：让图片短边正好填满裁剪框
    cropBase = Math.max(size / img.width, size / img.height);
    cropScale = 1; cropX = 0; cropY = 0;
    $('crop-zoom').value = 100;
    drawCrop();
    showView('crop');
  };
  img.onerror = () => toast('图片读取失败，换一张试试');
  img.src = dataUrl;
}

function cropGeom() {
  const sc = cropBase * cropScale;
  const w = cropImg.width * sc, h = cropImg.height * sc;
  return { w, h, x: (cropSize - w) / 2 + cropX, y: (cropSize - h) / 2 + cropY };
}

function clampCrop() {
  const { w, h } = cropGeom();
  const mx = Math.max(0, (w - cropSize) / 2);
  const my = Math.max(0, (h - cropSize) / 2);
  cropX = Math.max(-mx, Math.min(mx, cropX));
  cropY = Math.max(-my, Math.min(my, cropY));
}

function drawCrop() {
  if (!cropImg) return;
  const cv = $('crop-canvas');
  const ctx = cv.getContext('2d');
  const k = cv.width / cropSize;
  ctx.clearRect(0, 0, cv.width, cv.height);
  const g = cropGeom();
  ctx.drawImage(cropImg, g.x * k, g.y * k, g.w * k, g.h * k);
}

function getCroppedDataUrl() {
  const cv = $('crop-canvas');
  const out = document.createElement('canvas');
  out.width = 256; out.height = 256;
  out.getContext('2d').drawImage(cv, 0, 0, cv.width, cv.height, 0, 0, 256, 256);
  return out.toDataURL('image/jpeg', 0.9);
}

function bindCropDrag() {
  const stage = $('crop-stage');
  let drag = null;
  stage.addEventListener('pointerdown', (e) => {
    if (!cropImg) return;
    drag = { x: e.clientX, y: e.clientY, ox: cropX, oy: cropY };
    try { stage.setPointerCapture(e.pointerId); } catch {}
  });
  stage.addEventListener('pointermove', (e) => {
    if (!drag) return;
    cropX = drag.ox + (e.clientX - drag.x);
    cropY = drag.oy + (e.clientY - drag.y);
    clampCrop(); drawCrop();
  });
  const stop = () => { drag = null; };
  stage.addEventListener('pointerup', stop);
  stage.addEventListener('pointercancel', stop);
  stage.addEventListener('pointerleave', stop);

  $('crop-zoom').oninput = (e) => {
    cropScale = Number(e.target.value) / 100;
    clampCrop(); drawCrop();
  };
}

// ================= 角色编辑 =================
async function openCharEdit(id, presetKey) {
  editingId = id;
  const c = id ? allChars.find(x => x.id === id) : null;
  const preset = presetKey ? getPreset(presetKey) : null;
  editPresetKey = presetKey || null;

  $('edit-title').textContent = c ? '编辑角色' : '新建角色';
  $('e-name').value = c?.name || preset?.name || '';
  $('e-greeting').value = c?.greeting || preset?.greeting || '';
  $('e-persona').value = c?.persona || preset?.persona || getPreset('blank').persona;
  editingAvatar = c?.avatar || null;

  const av = $('e-avatar-prev');
  if (editingAvatar) av.innerHTML = `<img src="${esc(editingAvatar)}" style="width:100%;height:100%;object-fit:cover">`;
  else av.textContent = '🎎';

  // 参数：已有角色读它自己的；新建角色 = 全局兜底 ← 预设推荐值
  const P = c
    ? effSettings(c, S)
    : Object.assign({}, PARAM_DEFAULTS, pickCharParams(S), preset?.params || {});

  $('e-temp').value = P.temperature;
  // 两位小数并去掉末尾的 0：1.25 显示「1.25」，1.1 显示「1.1」。
  // 原来固定 toFixed(1) 会把 1.25 显示成 1.3，和滑条实际值对不上。
  $('e-v-temp').textContent = String(Number(Number(P.temperature).toFixed(2)));
  $('e-maxtok').value = P.maxTokens;
  $('e-v-maxtok').textContent = P.maxTokens;
  $('e-ctx').value = P.contextRounds;
  $('e-v-ctx').textContent = P.contextRounds;
  $('e-delay').value = P.typingDelay;
  $('e-v-delay').textContent = Number(P.typingDelay).toFixed(1) + 'x';
  $('e-kao-style').value = P.kaomojiStyle;
  $('e-verbosity').value = P.verbosity;
  $('e-split').checked = !!P.splitMessages;
  $('e-hesit').checked = !!P.hesitation;
  $('e-showtyping').checked = P.showTyping !== false;   // 老角色没这个键，按默认开着算
  $('e-longmem').checked = !!P.longMemory;
  $('e-allow-edit-mine').checked = !!P.allowEditMine;
  // 这里显示的是「她记住的事」，内容按角色走，和全局的节奏参数无关
  await renderCharMem(editingId);   // P 里没有 id（settings 不含这个字段）
  $('e-override-global').checked = false;   // 每次打开都重置，避免手滑把别人也覆盖了

  // 「他的设定 / 他的居处」（v1.21.47）：角色级，各人一份。
  // 还没设过的角色（老数据、或迁移没赶上）显示全局那份 —— 那是它实际生效的值，
  // 不给她看空框（真生效的是 persona.js 里 char.myProfile ?? s.myProfile）。
  $('e-mine').value = (c && c.myProfile !== undefined) ? c.myProfile : (S.myProfile || '');
  $('e-home').value = (c && c.myEnv !== undefined) ? c.myEnv : (S.myEnv || '');
  refreshEditMineBrief();
  // 人设 / 开场白现在也是入口行（v1.21.58），角标同样要跟着刚填进去的值走
  refreshCharTextBriefs();

  $('e-kao-freq').dataset.v = P.kaomojiFreq;
  renderSeg('e-kao-freq', FREQ_PRESETS, P.kaomojiFreq, v => { $('e-kao-freq').dataset.v = v; });
  $('e-emoji').dataset.v = P.emojiFreq;
  renderSeg('e-emoji', EMOJI_PRESETS, P.emojiFreq, v => { $('e-emoji').dataset.v = v; });
  $('e-reasoning').dataset.v = P.reasoningEffort;
  renderSeg('e-reasoning', REASONING_PRESETS, P.reasoningEffort, v => { $('e-reasoning').dataset.v = v; });
  // ⚠️ 三态：绕开 P 直接读角色自己的字段（v1.21.36 修，复审 #3）。
  //
  // 起因（真实端到端实测）：descLevel 是 CHAR_KEYS 成员，而 effSettings 是【角色值优先】，
  // 本 app 建出来的角色【都有】descLevel 字段（pickCharParams 会把全局复制进角色）——
  // 于是设置页改全局 = 对这些角色【零效果】，可 toast 却承诺"下一条回复生效"。
  // 实测：全局改成 off，角色 u1 自己的仍是 mid，再发一条毫无变化。
  //
  // 与 detailDrive 保持同构（那边 v1.21.32 就修好了三态）。
  const descV = (c && c.descLevel) ? c.descLevel : 'global';
  editDesc = descV;
  $('e-desc').dataset.v = descV === 'global' ? 'global' : descV;
  renderSeg('e-desc', DESC_PRESETS, $('e-desc').dataset.v, v => { $('e-desc').dataset.v = v; editDesc = v; });
  // 描写详细程度（v1.21.31）：三态 —— 'global'（跟随全局）/ 'off' / 'low' / 'mid' / 'high' / 'max'。
  // 与上面的 descLevel 完全并列，互不覆盖。
  // ⚠️ 必须绕开 P，直接读【角色自己】的字段（v1.21.32 修，复审 #4）。
  //
  // 起因：effSettings 会把【全局值】填进角色没设过的键 → P.detailDrive 永远非空 →
  // 三态判断恒为"角色自己的选择" → 用户【只要点一次保存】（哪怕只改名字）
  // 就把 detailDrive 写进角色 → 「跟随全局」链【永久切断】。
  // 实测：全局=max 时新建角色，编辑页直接显示「极详」，保存后落库。
  //
  // 同段的 searchPolicy(4741) / clockPolicy(4745) 就是直接读 c.xxx 的 —— 这里照做。
  const driveV = (c && c.detailDrive) ? c.detailDrive : 'global';
  editDrive = driveV;
  $('e-drive-brief').textContent = driveLabel(driveV);
  $('e-drive').onclick = () => openDrivePicker(driveV, v => {
    if (v === null) return;              // 取消
    editDrive = v;
    $('e-drive-brief').textContent = driveLabel(v);
  }, true);                              // allowGlobal：角色页多给一个「跟随全局」
  // 叙事视角（v1.21.48）：原来是一个开关，现在是 关 / L1 / L2 / L3 / L4 五档。
  //
  // ⚠️ 老数据【不做写库迁移】，读的时候现推：
  //    povLock === true  → L1（就是原来那段提示词，逐字一样）
  //    其它（false / 没这个键）→ ''（不注入任何视角段落，也就是旧版的行为）
  //    这里最容易错：把 false 也映射成 L1 会【给 7 个关着锁的角色加上约束】，
  //    那是改行为，不是兼容。所以关闭档必须留着。
  // ⚠️ 直接读【角色自己的】字段，不要读 P —— 这是 v1.21.48 实测踩到的坑：
  // P 是 effSettings 的合并结果，而全局 DEFAULTS 里现在就有 povStyle:''，
  // 于是老角色自己的 povLock=true 永远被那个全局空串盖掉，编辑页一律显示「关」。
  // 同一个坑 descLevel / detailDrive 都踩过（见下面那段注释，这里是第三次）。
  const povKey = (c && POV_STYLE_PRESETS.some(x => x.value === c.povStyle)) ? c.povStyle
    : ((c && c.povLock) ? 'L1' : '');
  $('e-pov').dataset.v = povKey;
  const renderPovNote = (k) => {
    const p = POV_STYLE_PRESETS.find(x => x.value === k) || POV_STYLE_PRESETS[0];
    $('e-pov-note').innerHTML = p.note;
  };
  renderPovNote(povKey);
  renderSeg('e-pov', POV_STYLE_PRESETS, povKey, v => {
    $('e-pov').dataset.v = v;
    renderPovNote(v);
  });

  // 「表达预设」（v1.21.48）：陪伴 / 作家，点一下把一组值填进表单。
  //
  // ⚠️ 它【不新增任何字段】，只是几行赋值的快捷方式 —— 这正是设计建议里明确要求那条：
  //    模式不该变成第 26 个参数，否则「模式说作家、你手动把视角设成关，谁赢」
  //    立刻变成新的口径冲突（这个项目已经因为这类冲突吃过四次亏）。
  // 所以它连「当前是不是作家模式」都不记 —— 点了就填，之后你改任何一项，
  // 也不需要再维护一个「自定义」状态（那种状态一定会和真实值不一致）。
  const applyMode = (kind) => {
    const isWriter = kind === 'writer';
    const v = isWriter
      ? { pov: 'L3', desc: 'high', drive: 'max', verbosity: 'long', split: false, think: true, kao: 0, emoji: 0, ctx: 30 }
      : { pov: 'L1', desc: 'mid',  drive: 'off', verbosity: 'medium', split: false, think: false, kao: 0.15, emoji: 0.1, ctx: 20 };
    // 视角
    $('e-pov').dataset.v = v.pov;
    renderSeg('e-pov', POV_STYLE_PRESETS, v.pov, x => { $('e-pov').dataset.v = x; renderPovNote(x); });
    renderPovNote(v.pov);
    // 非对话描写（上限）—— editDesc 是它真正的存档位
    $('e-desc').dataset.v = v.desc;
    editDesc = v.desc;
    renderSeg('e-desc', DESC_PRESETS, v.desc, x => { $('e-desc').dataset.v = x; editDesc = x; });
    // 描写结构（drive）—— 存 editDrive
    editDrive = v.drive;
    $('e-drive-brief').textContent = driveLabel(v.drive);
    // 回复长度 / 分段 / 强制聊天模式
    $('e-verbosity').value = v.verbosity;
    $('e-split').checked = v.split;
    $('e-think').dataset.v = String(v.think);
    renderSeg('e-think', POV_PRESETS, v.think, x => { $('e-think').dataset.v = String(x); });
    // 颜文字 / 表情
    $('e-kao-freq').dataset.v = v.kao;
    renderSeg('e-kao-freq', FREQ_PRESETS, v.kao, x => { $('e-kao-freq').dataset.v = x; });
    $('e-emoji').dataset.v = v.emoji;
    renderSeg('e-emoji', EMOJI_PRESETS, v.emoji, x => { $('e-emoji').dataset.v = x; });
    // 上下文轮数
    $('e-ctx').value = v.ctx;
    $('e-v-ctx').textContent = v.ctx;
    $('e-mode-note').innerHTML = isWriter
      ? '已填入<b>作家</b>那套推荐值：第三人称跟随、描写拉满、长回复、不要颜文字和表情、上下文 30 轮。<br>想微调就改下面任意一项 —— 最后别忘了右上角 <b>✓</b>。'
      : '已填入<b>陪伴</b>那套推荐值：只写她感知到的、中等描写、中等长度、颜文字偶尔、上下文 20 轮。<br>想微调就改下面任意一项 —— 最后别忘了右上角 <b>✓</b>。';
    renderMode(kind);   // 按钮立刻亮成刚点的那一套
  };
  // 预设按钮该亮哪一个：【按当前参数值现算】，不存任何「模式」字段。
  //
  // ⚠️ v1.21.50 改。上一版是「点了就填、按钮永不高亮」——
  // 用户实测反馈：选作家（视角被填成 L3）→ 自己改成 L2 → 保存 → 再打开，
  // 预设那一排又变成没选中的样子，看起来像「我的选择没存住」。
  // 现算就解决了：参数值和哪一套完全一致就亮哪一套，不一致就不亮（= 自定义）。
  // 这样它依然【不新增字段】，但用户能一眼看出「我现在像哪一档」。
  const detectMode = () => {
    const cur = {
      pov: $('e-pov').dataset.v || '',
      desc: editDesc === 'global' ? '' : editDesc,
      drive: editDrive === 'global' ? '' : editDrive,
      verbosity: $('e-verbosity').value,
      split: !!$('e-split').checked,
      think: $('e-think').dataset.v === 'true',
      kao: Number($('e-kao-freq').dataset.v),
      emoji: Number($('e-emoji').dataset.v),
      ctx: Number($('e-ctx').value),
    };
    const near = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-6;
    if (cur.pov === 'L1' && cur.desc === 'mid' && cur.drive === 'off' && cur.verbosity === 'medium'
        && !cur.split && !cur.think && near(cur.kao, 0.15) && near(cur.emoji, 0.1) && cur.ctx === 20) return 'chat';
    if (cur.pov === 'L3' && cur.desc === 'high' && cur.drive === 'max' && cur.verbosity === 'long'
        && !cur.split && cur.think && near(cur.kao, 0) && near(cur.emoji, 0) && cur.ctx === 30) return 'writer';
    return '';   // 都不完全一致 = 自定义，不高亮
  };
  // 预设按钮的档位表。放这里（而不是模块级常量）：它只在本页用，
  // 和下面 detectMode 的判定条件挨着，改一套值的时候两处一起看，不容易漏。
  const MODE_PRESETS = [
    { label: '陪伴', value: 'chat' },
    { label: '作家', value: 'writer' },
  ];
  const renderMode = (cur) => renderSeg('e-mode', MODE_PRESETS, cur, k => applyMode(k));
  const modeNow = detectMode();
  renderMode(modeNow);
  $('e-mode-note').innerHTML = modeNow
    ? '当前这一套就是<b>「' + (modeNow === 'writer' ? '作家' : '陪伴') + '」</b>的推荐值。<br>改下面任意一项，它就会变成「自定义」（不高亮）—— 最后记得点右上角 <b>✓</b>。'
    : '当前是<b>自定义</b>（和「陪伴 / 作家」两套推荐值都不完全一样）。<br>点上面任一个可以一次性套用那套值，之后照样能逐项微调 —— 最后记得点右上角 <b>✓</b>。';
  // 强制聊天模式：同上一组开关（布尔存 'true'/'false'）
  const thinkOn = !!P.thinkMode;
  $('e-think').dataset.v = String(thinkOn);
  renderSeg('e-think', POV_PRESETS, thinkOn, v => { $('e-think').dataset.v = String(v); });
  // 联网搜索覆盖：三态。c 是正在编辑的角色（新建时是 null → 默认跟随全局）
  const sPol = (c && c.searchPolicy) || '';
  $('e-search').dataset.v = sPol;
  renderSeg('e-search', SEARCH_POLICY_PRESETS, sPol, v => { $('e-search').dataset.v = String(v); });
  // 时间跟现实走：同样是三态覆盖
  const cPol = (c && c.clockPolicy) || '';
  $('e-clock').dataset.v = cPol;
  renderSeg('e-clock', CLOCK_POLICY_PRESETS, cPol, v => { $('e-clock').dataset.v = String(v); });
  // 外貌：临时覆盖优先显示；没有临时层就显示长期基线
  $('e-look').value = (P.appearanceLive || '').trim() || P.appearance || '';
  $('e-look-on').checked = P.appearanceOn !== false;
  refreshLookCount();

  $('btn-del-char').style.display = c ? 'block' : 'none';
  showView('edit');
}

async function saveCharEdit() {
  const name = $('e-name').value.trim();
  if (!name) { toast('请填写名字'); return; }
  const num = (id, def) => { const v = Number($(id).value); return isNaN(v) ? def : v; };
  const data = {
    name, greeting: $('e-greeting').value, persona: $('e-persona').value,
    avatar: editingAvatar,
    // 角色级参数：始终写入角色自己的值
    temperature: num('e-temp', S.temperature),
    maxTokens: num('e-maxtok', S.maxTokens),
    contextRounds: num('e-ctx', S.contextRounds),
    reasoningEffort: $('e-reasoning').dataset.v || S.reasoningEffort,
    kaomojiFreq: Number($('e-kao-freq').dataset.v ?? S.kaomojiFreq),
    kaomojiStyle: $('e-kao-style').value,
    emojiFreq: Number($('e-emoji').dataset.v ?? S.emojiFreq),
    verbosity: $('e-verbosity').value,
    splitMessages: $('e-split').checked,
    // ⚠️ 三态（v1.21.36 修，复审 #3）：选「跟随全局」就【不写这个键】，
    // 让 effSettings 回落到全局值。与 detailDrive 同构。
    ...(editDesc === 'global' ? {} : { descLevel: editDesc }),
    // 描写详细程度（v1.21.31）：'global' 存成 undefined（= 跟随全局），
    // 这样 effSettings 的"角色值优先"逻辑才不会用一个 'global' 字符串把全局档盖掉。
    // ⚠️ 用户没动过这一项就【不写这个键】（v1.21.32 修，复审 #4）。
    // 写 undefined 也会让 chars.put 把键带上（值 undefined），
    // 而 pickCharParams 会把它复制给新角色 —— 所以干脆不写。
    ...(editDrive === 'global' ? {} : { detailDrive: editDrive }),
    // 叙事视角（v1.21.48）：存档位，空串 = 关。老键 povLock 一并写成一个可读的布尔 ——
  // 万一有别的分支还在看它（备份比对、外部脚本），不至于读到 undefined；
  // 但**判定只认 povStyle**（persona.js 里是先看 povStyle 的）。
  povStyle: $('e-pov').dataset.v || '',
  povLock: ($('e-pov').dataset.v || '') === 'L1',
    thinkMode: $('e-think') ? $('e-think').dataset.v === 'true' : false,
    appearance: $('e-look').value,
    appearanceOn: $('e-look-on').checked,
    // 「他的设定 / 他的居处」（v1.21.47）：从全局搬到角色级，随角色一起存
    myProfile: $('e-mine').value,
    myEnv: $('e-home').value,
    typingDelay: num('e-delay', S.typingDelay),
    hesitation: $('e-hesit').checked,
    showTyping: $('e-showtyping').checked,
    longMemory: $('e-longmem').checked,
    allowEditMine: $('e-allow-edit-mine').checked,
    searchPolicy: $('e-search') ? ($('e-search').dataset.v || '') : '',
    clockPolicy: $('e-clock') ? ($('e-clock').dataset.v || '') : ''
  };
  let id = editingId;
  if (id) {
    const c = await chars.get(id);
    // ⚠️ 展开 `{}` 只是"不覆盖"，删不掉 c 上已有的键（v1.21.34 修，复审 新1）。
    //
    // 起因：v1.21.32 我只修了"用户没动过就不写这个键"（新建角色那条路），
    // 而"已有值要删掉"这条路从没修过 —— 角色一旦有 detailDrive，
    // 用户就【再也回不到「跟随全局」】：界面显示已改，保存后又被旧值盖回来。
    // 实测：role.detailDrive='mid' → 选「跟随全局」→ 保存后仍是 {has:true, val:'mid'}。
    //
    // 修法：先 get 再 delete，然后 put。
    if (editDrive === 'global') delete c.detailDrive;
    // 同上：descLevel 也要能回退到「跟随全局」（v1.21.36，复审 #3）。
    if (editDesc === 'global') delete c.descLevel;
    // ⚠️ ✓ 保存要连「立即生效」那份一起盖掉（v1.21.52）。
    //
    // 起因：读取时是 appearanceLive || appearance（见 persona.js），
    // 而这条保存路径只写 appearance、从不碰 appearanceLive ——
    // 于是用过一次「立即生效」的角色，之后再怎么改文字、点 ✓，
    // 生效的都还是最早那次「立即生效」的内容，重开编辑页显示的也是旧那份：
    // 看起来像"刚写的字丢了"。用户按了 ✓ 就是"以框里这份为准"，所以这里把 live 清空。
    await chars.put({ ...c, ...data, appearanceLive: '' });
  } else {
    const c = { id: uid(), ...data, presetKey: editPresetKey, createdAt: Date.now() };
    await chars.put(c);
    id = c.id;
    curCharId = c.id;
  }

  // 「覆盖全局设定」：把这套参数广播给所有角色（后覆盖前）
  if ($('e-override-global').checked) {
    const params = pickCharParams(data);   // 只取角色级参数，不含名字/人设
    // ⚠️ 广播时把「外貌」摘掉（v1.21.52）：
    // 确认框写的是「这一页的对话参数和表达方式会覆盖其他所有角色」，
    // 而外貌是「她此刻的样子」—— 跟着广播过去，等于其他所有角色当场换上这套衣服，
    // 文案没提，用户也想不到。要统一外貌请逐个角色改。
    for (const k of ['appearance', 'appearanceOn', 'appearanceLive']) delete params[k];
    await saveSettings(params);            // 同时更新全局兜底值
    for (const c of allChars) {
      if (c.id === id) continue;
      await chars.put({ ...c, ...params });
    }
    toast('已覆盖：所有角色都同步成这套设置');
  } else {
    toast(editingId ? '已保存' : '已创建「' + name + '」');
  }

  await loadChars();
  await selectChar(curCharId);
  renderCharList();
  resetTo('chat');
}

// ================= 我的头像 =================
function renderMyAvatar() {
  const el = $('my-avatar-prev');
  if (!el) return;
  if (S.myAvatar) el.innerHTML = `<img src="${esc(S.myAvatar)}" style="width:100%;height:100%;object-fit:cover">`;
  else el.textContent = '🧑';
}

// ================= 预设选择 =================
function openPresetPicker() {
  renderPresetList();
  showView('preset');
}

function renderPresetList() {
  const box = $('preset-list');
  box.innerHTML = PRESETS.map(p => `
    <div class="char-card" data-key="${p.key}">
      <div class="avatar-lg">${p.emoji}</div>
      <div class="info">
        <b>${esc(p.name)}</b>
        <small>${esc(p.tagline || '')}</small>
      </div>
    </div>`).join('');
  box.querySelectorAll('.char-card').forEach(el => {
    el.onclick = () => { openCharEdit(null, el.dataset.key); };
  });
}

// ================= 角色列表 =================
function renderCharList() {
  const box = $('char-list');
  box.innerHTML = allChars.map(c => {
    const p = PRESETS.find(p => p.key === c.presetKey);
    const emoji = p ? p.emoji : '🙂';
    const av = c.avatar ? `<img src="${esc(c.avatar)}">` : emoji;
    return `<div class="char-card ${c.id === curCharId ? 'on' : ''}" data-id="${esc(c.id)}">
      <div class="avatar-lg">${av}</div>
      <div class="info">
        <b>${esc(c.name)}</b>
        <small>${esc((c.persona || '').replace(/[#*\n]/g, ' ').slice(0, 34))}…</small>
      </div>
      <span class="badge">编辑</span>
      <button class="icon-btn" data-edit="${esc(c.id)}">✎</button>
    </div>`;
  }).join('');

  box.querySelectorAll('.char-card').forEach(el => {
    el.onclick = async (e) => {
      if (e.target.dataset.edit) { openCharEdit(e.target.dataset.edit); return; }   // 内部自己切页
      await selectChar(el.dataset.id);
      resetTo('chat');   // 选完角色就回主界面，栈也清干净
    };
  });
}

// ================= 分段选择器 =================
function isSegOn(pv, value) {
  if (typeof pv === 'number' && typeof value === 'number') return Math.abs(pv - value) < 0.02;
  return String(pv) === String(value);
}

function renderSeg(containerId, presets, value, onPick) {
  const box = $(containerId);
  if (!box) return;
  // 当前值不在档位表里时补一个「当前值」档位，否则会出现一个按钮都不高亮、
  // 看不出实际设成了多少（默认 emojiFreq=0.1、角色A的 kaomojiFreq=0.2 都踩这个）。
  let list = presets;
  if (typeof value === 'number' && !presets.some(p => isSegOn(p.value, value))) {
    list = presets.concat([{ label: String(value), value }])
      .sort((a, b) => Number(a.value) - Number(b.value));
  }
  box.innerHTML = list.map(p =>
    `<button data-v="${p.value}" class="${isSegOn(p.value, value) ? 'on' : ''}">${p.label}</button>`).join('');
  box.querySelectorAll('button').forEach(b => b.onclick = () => {
    const raw = b.dataset.v;
    const v = (raw !== '' && !isNaN(Number(raw))) ? Number(raw) : raw;
    box.querySelectorAll('button').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    onPick(v);
  });
}

// ================= 设置页绑定 =================
const EMOJI_PRESETS = [
  { label: '关闭', value: 0 }, { label: '偶尔', value: 0.15 },
  { label: '经常', value: 0.5 }, { label: '总是', value: 0.9 }
];

// 非对话描写档位（管括号里的内容，和"回复长度"是两回事）
// 描写详细程度（v1.21.31 新增）：全局一个四档 + 角色可覆盖。
//
// ⚠️ 和 DESC_PRESETS（非对话描写）是【两个独立开关】：
//   DESC_PRESETS 管上限（最多写多长），这个管结构（必须写成什么形状）。
// 所以刻意不复用同一个键，也不做"设了这个就不用那个"的联动。
const DRIVE_PRESETS = [
  { v: 'off',  t: '不额外约束', d: '保持现状，不加任何描写要求。' },
  { v: 'low',  t: '简',
    d: '每轮至少写 1 个具体动作，不许整条只有台词和心理。' },
  { v: 'mid',  t: '中',
    d: '括号里写成动作链：他做了什么 → 你怎么应的 → 哪里因此变了。' },
  { v: 'high', t: '详',
    d: '动作链 + 每个动作落到具体感官（温度、黏、声音、重量）。' },
  { v: 'max',  t: '极详',
    d: '每段按三段式写，且每段都要有感官锚点；宁可一件事写透，不要铺三件事。' },
];

let _drivePick = null;   // 弹窗打开时挂着的回调；关掉就置空

/**
 * 打开「描写详细程度」选择弹窗。
 *
 * @param cur     当前值（全局档，或角色页的 'global' / 具体档）
 * @param onPick  选中后的回调；传 null 表示取消
 * @param allowGlobal  角色页传 true，多给一个「跟随全局」选项
 */
/** 档位值的显示名（'global' 是角色页特有的"跟随全局"） */
function driveLabel(v) {
  if (v === 'global' || v === undefined || v === null || v === '') return '跟随全局';
  const p = DRIVE_PRESETS.find(x => x.v === v);
  return p ? p.t : '不额外约束';
}

let editDrive = 'global';
let editDesc = 'global';   // 角色编辑页当前的「非对话描写」档（'global' = 跟随全局）

function openDrivePicker(cur, onPick, allowGlobal = false) {
  const box = $('drive-modal');
  const list = $('drive-list');
  if (!box || !list) return;
  const opts = allowGlobal
    ? [{ v: 'global', t: '跟随全局', d: '用设置页里那一档。' }].concat(DRIVE_PRESETS)
    : DRIVE_PRESETS;
  list.innerHTML = opts.map(o =>
    `<button data-v="${o.v}" class="drive-item${o.v === cur ? ' on' : ''}">`
    + `<b>${esc(o.t)}</b><span>${esc(o.d)}</span></button>`).join('');
  list.querySelectorAll('button').forEach(b => b.onclick = () => {
    const v = b.dataset.v;
    closeDrivePicker();
    onPick(v);
  });
  $('drive-cancel').onclick = () => { closeDrivePicker(); onPick(null); };
  _drivePick = onPick;
  box.classList.remove('hidden');
}

function closeDrivePicker() {
  $('drive-modal')?.classList.add('hidden');
  _drivePick = null;
}

// ⚠️ 'global' 是角色页专用的「跟随全局」档（v1.21.36 新增，复审 #3）。
// 不在设置页出现（设置页设的就是全局本身）。
const DESC_PRESETS = [
  { label: '跟随全局', value: 'global' },
  { label: '不写', value: 'off' },
  { label: '简', value: 'low' },
  { label: '中', value: 'mid' },
  { label: '丰富', value: 'high' }
];

// 布尔开关的通用两档（强制聊天模式等还在用）
const POV_PRESETS = [
  { label: '关', value: false },
  { label: '开', value: true }
];

// 叙事视角（v1.21.48）：一个开关拆成四档 + 关。
//
// 为什么要拆：老开关只能表达「不许跳出去」和「不管」两种意思 ——
// 而写小说真正要的是中间那几档：能写场面、能以对方为主语、能当叙述者。
// 这几段提示词都在 persona.js（POV_STYLES），这里只管界面文案。
//
// ⚠️ '关' 这一档必须留着：老版本 povLock=false 就是「不注入任何视角段落」，
// 砍掉它等于给所有关着锁的角色强行加上约束。
const POV_STYLE_PRESETS = [
  { label: '关', value: '',
    note: '不约束视角。她自己怎么顺手怎么写 —— 偶尔跳出她的眼睛当旁白也会发生。' },
  { label: 'L1', value: 'L1',
    note: '<b>她的眼睛</b>：只写她自己看到、听到、感觉到的。环境照样能写，不能写的是跳出去当旁白、用第三人称转播场面。<br>（老版本的「锁定她的视角=开」就是这一档。）' },
  { label: 'L2', value: 'L2',
    note: '<b>她的眼睛 + 场面</b>：在 L1 基础上放开<b>客观的场面</b> —— 雪停了、灯灭了一盏、窗外的车声远了。<br>仍然不许替对方写他心里在想什么。' },
  { label: 'L3', value: 'L3',
    note: '<b>跟着她走的第三人称</b>：可以用「他」作主语写对方（他推开门、他把杯子放下）。<br>镜头仍然只在她所在的现场，不写她看不见的事。' },
  { label: 'L4', value: 'L4',
    note: '<b>全知叙述者</b>：可以切场景、写别人的心理。<br>⚠️ 但对方（你）的台词和决定留给你自己 —— 叙述者最多写到他开口之前。' },
];

// 联网搜索（角色级三态）：'' = 跟随全局设置，其余强制。
// 用三态而不是布尔：老角色没有这个字段，默认应该"跟着全局走"，
// 存成 false 的话就变成"永久关闭"了，之后全局打开它们也不会跟着变。
const SEARCH_POLICY_PRESETS = [
  { label: '跟随全局', value: '' },
  { label: '强制开', value: 'on' },
  { label: '强制关', value: 'off' }
];

// 「时间跟现实走」的角色级覆盖（v1.20.21）。和上面完全同构：
// 用三态而不是布尔 —— 老角色没有这个字段，默认应该跟着全局走。
const CLOCK_POLICY_PRESETS = [
  { label: '跟随全局', value: '' },
  { label: '强制开', value: 'on' },
  { label: '强制关', value: 'off' }
];

// 实测：API 不认 "off"（会报错），关闭思考必须传 "none"
const REASONING_PRESETS = [
  { label: 'off', value: 'none' },
  { label: 'low', value: 'low' },
  { label: 'high', value: 'high' },
  { label: 'max', value: 'max' }
];

const rangeOf = (k) => (S.clockRanges && S.clockRanges[k]) || DEFAULTS.clockRanges[k];

/**
 * 按钟点反查该属于哪个时段。
 * 用【用户自己设的时段划分】（设置 → 时段划分），不是硬编码范围——
 * 否则改了划分之后，这里会和界面上显示的对不上。
 * 注意：必须定义在 rangeOf【之后】——const 有暂时性死区，
 * 放在前面的话第一次调用就会 ReferenceError。
 */
function phaseFromHour(h) {
  for (const p of CLOCK_PHASES) {
    const [a, b] = rangeOf(p.k);
    if (h >= a && h < b) return p.k;
  }
  return 'night';
}

/**
 * 时段划分弹窗里那 8 行（v1.21.57：改成草稿）。
 *
 * 为什么改：以前每敲一下输入框就直接落库，8 行里改错一个也只能将错就错
 * （连接口上那个"取消"都没有）。现在改动先进 phaseDraft，点「确定」才 saveSettings。
 * ⚠️ DOM 结构没动（#clock-ranges .clock-range + input[data-k][data-i]），
 * 样式和测试都按这个结构来。
 */
let phaseDraft = null;

function draftClockRanges() {
  const o = {};
  for (const p of CLOCK_PHASES) o[p.k] = [...rangeOf(p.k)];
  return o;
}

function renderClockRanges() {
  const box = $('clock-ranges');
  if (!box) return;
  const src = phaseDraft || draftClockRanges();
  box.innerHTML = CLOCK_PHASES.map(p => {
    const v = Array.isArray(src[p.k]) ? src[p.k] : rangeOf(p.k);
    const a = Number(v[0]), b = Number(v[1]);
    return `<div class="clock-range"><span>${p.label}</span>`
      + `<input type="number" min="0" max="24" data-k="${p.k}" data-i="0" value="${esc(a)}">`
      + `<i>—</i>`
      + `<input type="number" min="0" max="24" data-k="${p.k}" data-i="1" value="${esc(b)}">`
      + `<em>点</em></div>`;
  }).join('');
  box.querySelectorAll('input').forEach(inp => {
    inp.onchange = () => {
      const k = inp.dataset.k, i = Number(inp.dataset.i);
      // 弹窗没开着就点了（理论上到不了）→ 现造一份草稿，
      // 别把改动写进 S.clockRanges 本身，那样"取消"就失效了
      if (!phaseDraft) phaseDraft = draftClockRanges();
      const next = phaseDraft[k];
      next[i] = Math.max(0, Math.min(24, Number(inp.value) || 0));
      // 结束必须大于开始，不然这段时间就成了负数
      if (next[1] <= next[0]) next[1] = Math.min(24, next[0] + 1);
      // ⚠️ 同一行的两个框都要写回：改【开始】时结束会被自动推后，
      // 只写回被改的那个框，界面显示的还是旧值、草稿里却已是新值 ——
      // 用户看着「10 — 5」点确定，存进去的是「10 — 11」。
      // （旧实现是每敲一下直接落库，同样不同步，只是没人注意。）
      const row = inp.parentNode;
      row.querySelector('input[data-i="0"]').value = next[0];
      row.querySelector('input[data-i="1"]').value = next[1];
    };
  });
}

/** 打开弹窗 = 把当前设置拷一份当草稿；取消 = 草稿丢掉，界面退回已保存的值 */
function openPhaseModal() {
  phaseDraft = draftClockRanges();
  renderClockRanges();
  $('phase-modal').classList.remove('hidden');
}
function closePhaseModal() {
  phaseDraft = null;
  $('phase-modal').classList.add('hidden');
  renderClockRanges();
}

/**
 * 服务商那一行（v1.21.47）：下拉 + 一句说明 + 余额行的显隐。
 * 余额只有 DeepSeek 有接口，别的家整行藏起来 —— 点下去只会得到 404。
 */
function renderProviderUI() {
  const sel = $('s-provider');
  if (sel) {
    if (!sel.options.length) {
      sel.innerHTML = providerList().map(o =>
        '<option value="' + esc(o.value) + '">' + esc(o.label) + '</option>').join('');
    }
    sel.value = S.provider || 'deepseek';
  }
  const spec = providerSpec(S.provider);
  const note = $('s-provider-note');
  if (note) note.textContent = spec.note || '';
  const row = $('balance-row');
  if (row) row.style.display = spec.balance ? '' : 'none';
  refreshApiHint();
}

/**
 * 「接口」「时段划分」两个折叠头右侧的角标（v1.21.57）。
 *
 * 这两块原来平铺在设置页上，收起来之后如果角标什么都不说，
 * 用户每次都得点开确认"我接的到底是谁"—— 那就白收了。
 * 角标只放【一眼要用的那一个值】，长文本由 CSS 截断。
 */
function refreshApiHint() {
  const el = $('api-hint');
  if (!el) return;
  if (!S.apiKey) { el.textContent = '还没填 key'; return; }
  const spec = providerSpec(S.provider) || {};
  el.textContent = (spec.label || S.provider || '自定义') + ' · ' + (S.model || DEFAULTS.model);
}

function refreshClockHint() {
  const el = $('clock-hint');
  if (el) el.textContent = S.clockMode === true ? '跟现实走' : '手动';
  const rb = $('ranges-brief');
  if (!rb) return;
  // 这里只回答"我动过没有"：8 段范围全写上去会挤成两行，
  // 具体几点进弹窗就能看，不必塞在角标里。
  const isDefault = CLOCK_PHASES.every(p => {
    const a = rangeOf(p.k), b = DEFAULTS.clockRanges[p.k];
    return !!b && a[0] === b[0] && a[1] === b[1];
  });
  rb.textContent = isDefault ? '默认划分' : '已改过';
}

/**
 * 设置页那行「上一轮 ≈ 多少 token」（v1.21.54）。
 *
 * 只报数、不拦人：估算本来就不精确（见 api.js 的 estimateTokens），
 * 拿一个粗估值去阻拦用户发送是本末倒置。
 * 但顶满这件事必须说出来 —— 那意味着更早的历史正在被丢掉。
 */
/**
 * 这个地址是不是「可以放心走明文」的本机 / 局域网地址（v1.21.56）。
 *
 * 为什么需要它：network_security_config 全局放行了明文（局域网 Ollama 必须走 http），
 * 而 Android 的 NSC【不支持网段通配】（<domain> 只认具体主机名/IP），
 * 而且它是编译期静态 XML、运行时加域名不生效 —— 那一层收窄不了。
 * 能收窄的位置只有"用户填地址的那一刻"，判据就落在这个函数上。
 *
 * 保守方向：认不出来的一律当【公网】（会多问一次，不会漏放）。
 */
function isPrivateHttpHost(u) {
  let host = '';
  try { host = new URL(String(u)).hostname.toLowerCase(); } catch { return false; }
  if (!host) return false;
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1') return true;
  if (host.endsWith('.local')) return true;                 // mDNS 局域网名
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;                                     // 非 IP 的域名 → 当公网
  const a = Number(m[1]), b = Number(m[2]);
  if (a === 10) return true;                                // 10.0.0.0/8
  if (a === 192 && b === 168) return true;                  // 192.168.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true;         // 172.16.0.0/12
  if (a === 127) return true;                               // 本机
  if (a === 169 && b === 254) return true;                  // link-local
  return false;
}

function renderCtxNote() {
  const el = $('s-ctx-note');
  if (!el) return;
  const cap = Math.max(2000, Number(S.contextBudget) || DEFAULTS.contextBudget);
  if (!lastPromptTokens) { el.textContent = '还没发过消息，发一条就能看到占用。'; return; }
  const pct = Math.round(lastPromptTokens / cap * 100);
  el.textContent = '上一轮请求约 ' + lastPromptTokens.toLocaleString() + ' token'
    + '（预算 ' + cap.toLocaleString() + '，占 ' + pct + '%）'
    + (pct >= 100 ? ' —— 已顶满，更早的历史会被丢掉。调大这里，或者把世界书/人设写短些。' : '');
}

function bindSettings() {
  // 草稿是弹窗自己的事：每次进设置页都从"已保存的值"重画一遍，
  // 免得上一轮没走取消/确定就退出去时把旧草稿带进来。
  phaseDraft = null;
  renderMyAvatar();
  renderClockRanges();
  refreshClockHint();
  $('s-apikey').value = S.apiKey;
  $('s-baseurl').value = S.baseUrl;
  $('s-model').value = S.model;
  $('s-vmodel').value = S.visionModel;
  const ctxBox = $('s-ctx-budget');
  ctxBox.value = Number(S.contextBudget) || DEFAULTS.contextBudget;
  ctxBox.onchange = async e => {
    // 夹在 2000~200000：太小的值会让历史几乎全被丢掉（她当场失忆），
    // 太大的值没有意义（没有哪个模型的窗口开得到 200K 以上还便宜）。
    const v = Math.max(2000, Math.min(200000, Math.round(Number(e.target.value) || DEFAULTS.contextBudget)));
    e.target.value = v;
    await saveSettings({ contextBudget: v });
    renderCtxNote();
  };
  renderCtxNote();
  // 朗读开关（v1.21.56）
  const ttsBox = $('s-tts');
  if (ttsBox) {
    ttsBox.checked = !!S.ttsOn;
    ttsBox.onchange = async e => {
      await saveSettings({ ttsOn: e.target.checked });
      // 关掉时正在念的也要停 —— 否则开关关了声音还在响，看着像没生效
      if (!e.target.checked) stopSpeak();
      toast(e.target.checked ? '她说完会念出来' : '已关闭朗读');
    };
  }
  renderProviderUI();
  // 换服务商 = 地址和模型都要跟着换，所以直接把那一家的初值填上（用户马上能改）。
  // 「自定义」那家 baseUrl/model 是空的 —— 这种就【保留用户已经填的】，
  // 否则一切到自定义，刚打好的地址反而被清空了。
  $('s-provider').onchange = async (e) => {
    const id = e.target.value;
    const spec = providerSpec(id);
    const patch = { provider: id };
    if (spec.baseUrl) patch.baseUrl = spec.baseUrl;
    if (spec.model) patch.model = spec.model;
    if (spec.vision || spec.model) patch.visionModel = spec.vision || spec.model;
    await saveSettings(patch);
    $('s-baseurl').value = S.baseUrl;
    $('s-model').value = S.model;
    $('s-vmodel').value = S.visionModel;
    renderProviderUI();
    updateStatus();
    toast('已切到「' + spec.label + '」，地址和模型按它填好了，可以改', 3600);
  };
  // 归档（独立于记忆节奏：那边是「多久跑一次」，这边是「归档多少」）
  // 自动归档开关：不写进角色配置，是全局设置
  const autoBox = $('s-arch-auto');
  autoBox.checked = S.autoArchive !== false;
  autoBox.onchange = async e => {
    await saveSettings({ autoArchive: e.target.checked });
    toast(e.target.checked ? '已开启自动归档' : '已关闭自动归档');
  };
  $('s-arch-keep').value = S.archiveKeep ?? 30;
  $('s-arch-keep').onchange = async e => {
    const v = Math.max(0, Number(e.target.value) || 0);
    e.target.value = v;
    await saveSettings({ archiveKeep: v });
    await renderArchiveHint();
  };
  $('btn-archive-now').onclick = async () => {
    const keep = Math.max(0, Number(S.archiveKeep) || 0);
    const st = await archivePreview();
    if (st.total <= keep) { toast('没什么可归档的（当前 ' + st.total + ' 条）'); return; }
    const nm = esc(curChar?.name || '她');
    const ok = await confirmBox('归档旧对话',
      '<p>会把最早的 <b>' + (st.total - keep) + ' 条</b>收起来（原文保留，能展开回看），</p>'
      + '<p>并整理进「' + nm + '」的长期记忆。</p>'
      + '<p>· 会调用模型做总结，可能需要一点时间<br>· 归档后这些内容不再每轮发出去，能省 token</p>'
      + '<p>确定吗？</p>', '开始归档');
    if (!ok) return;
    await doArchive();
  };
  $('btn-archive-restore').onclick = async () => {
    const rbtn = $('btn-archive-restore');
    if (rbtn.disabled) return;                 // 防重入：连点会并发跑两个事务
    const n = await msgs.archived(curCharId);
    if (!n.length) { toast('没有已归档的对话'); return; }
    const total = (await msgs.list(curCharId)).length;
    const ok = await confirmBox('取消归档',
      '<p>把 <b>' + n.length + ' 条</b>已归档的对话恢复回正常聊天。</p>'
      + '<p>恢复后聊天页会有 <b>' + (total + n.length) + ' 条</b>消息，可能会卡一下。</p>'
      + '<p>不过发送时仍然只带最近几十条（受「上下文轮数」限制），<b>不会把全部内容发给模型</b>。</p>'
      + '<p>要是只想翻看老对话，<b>不用取消归档</b> —— 在归档区点开就能看，原文一直都在。</p>', '恢复');
    if (!ok) return;
    rbtn.disabled = true;
    try {
      const cnt = await msgs.unarchive(curCharId);
      await renderMessagesIfIdle();   // 同上：数据变了，但不值得为它打断正在生成的那轮
      await renderArchiveHint();
      toast('已恢复 ' + cnt + ' 条');
    } catch (err) {
      toast('恢复失败：' + ((err && err.message) || err), 4200);
    } finally {
      rbtn.disabled = false;
    }
  };

  $('btn-mem-tidy').onclick = async () => {
    const btn = $('btn-mem-tidy');
    if (btn.disabled || !curCharId) return;
    const myId = curCharId;
    const before = await mem.list(myId);
    if (before.length < 3) { toast('记忆太少，没什么可整理的'); return; }
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = '整理中…';
    try {
      // 【优化 C】整理前先备份一份。整理是"全删重写"，模型这次发挥不好就没得救，
      // 所以留一份上一次的样子，出问题能一键撤回。
      // 只留最近一份（够用且省地方）；备份是纯代码，不花 token。
      await kv.set('memTidyBackup:' + myId, {
        at: Date.now(),
        // ⚠️ 必须把 id 一起存下来（2026-09-27 修）。
        // 以前只存 text，撤销时靠"文本完全相等"来认哪些该留 ——
        // 但整理本来就会改措辞（合句、压缩），改完之后旧文本对不上，
        // 于是【备份的写回来 + 当前的没删干净】= 记忆里出现重复条目。
        // id 是稳定的，用它比对，不依赖文本有没有被改过。
        items: before.map(m => ({ id: m.id, text: m.text, kind: m.kind,
                                  untilDay: m.untilDay,
                                  untilHour: m.untilHour, untilMinute: m.untilMinute,
                                  freq: m.freq, mine: !!m.mine })),
      });
      _lastDedupeStat = null;
      _lastMemError = null;   // 清掉上一次的残留，否则这次成功也会报出上次的错
      const n = await withMemLock(() => dedupeFor(myId));
      if (n && n.ok === false) { toast('记忆任务正在跑，稍等一下再试'); return; }
      // ⚠️ 只在【真的整理过】时才补写水位（v1.21.28 修，复审 新6_）。
      //
      // 起因：上一版是无条件补写。而 dedupeFor 在 tooFew 时会 return 0，
      // 按钮【无法区分「整理成功」与「抽风放弃」】——
      // 于是模型抽风时水位被写成"当前条数"，grew 归零，
      // 与新2 修复前描述的旧循环完全一致：反复触发、反复被拦、队列无人消费。
      // 也就是说：新2 在【自动路径】修对了，在这里被抵消。
      //
      // 现在用"整理前后条数有没有变"来判断（更稳的判据，不看返回值语义）。
      const afterN = (await mem.list(myId)).length;
      if (afterN !== before.length) {
        try { await kv.set('memDedupeAt:' + myId, afterN); } catch { /* 水位写不进去不影响整理结果 */ }
      }
      // D（2026-09-28 新增）：把记忆子任务的失败说出来。
      //
      // 以前 _lastMemError 只写进内存变量、从不显示 —— 自动链路里
      // step() 会把异常吞掉只留 console，用户在手机上根本看不到控制台。
      // 表现就是「我明明整理过了，她还记得」/「整理好像没生效」，
      // 而真实原因是某一步抛错了（网络、JSON 解析、记忆写满……）。
      if (_lastMemError && Date.now() - _lastMemError.at < 60000) {
        toast('注意：上一轮' + _lastMemError.step + '失败了（' + _lastMemError.msg + '），'
              + '这次的结果可能不完整。', 6000);
        _lastMemError = null;
      }
      const after = await mem.list(myId);
      await renderMem();
      await refreshMemOverflow();
      // 【优化 A】报告：条数 + 字数。
      // 光看条数判断不了"压成大意"有没有生效，字数下降才是真证据。
      const st = _lastDedupeStat;
      const n0 = before.length, n1 = after.length;
      const c0 = before.reduce((s, m) => s + String(m.text || '').length, 0);
      const c1 = after.reduce((s, m) => s + String(m.text || '').length, 0);
      const short = (v) => (v > 0 ? '-' + v : '没变');
      // 三种结局分开报，别再共用一句"没找到可合并的" —— 那句话把
      // "模型没返回"、"模型原样吐回"、"被上限裁掉"混成了一种，用户没法判断该不该再点。
      if (n0 === n1 && c1 >= c0) {
        // ⚠️ 先判【被 tooFew 拦下】（v1.21.28 修，复审 新9_）。
        //
        // 起因：_lastDedupeStat.aborted 早就设好了，但这里只读 rawLen、从不读 aborted，
        // 于是「模型抽风」被当成「没有需要合并的」，还主动劝用户「不用再点了」——
        // 而真实情况是「再点一次可能就好了」。
        // ⚠️ 讽刺的是下面那段注释自己就写着这个目标：
        //    「把 没事可做 和 功能坏了 明确分开，别让他白点」—— 实现恰恰把两者混成了一种。
        const aborted = st ? st.aborted : null;
        if (aborted === 'tooFew') {
          const rawT = st ? st.rawLen : null;
          toast('整理没做成：模型这次只合出很少几条（' + (rawT === null ? '?' : rawT)
                + ' 条），判定为抽风，已保留原样没动。可以再点一次；'
                + '连续几次都这样，多半是模型或网络的问题。', 6000);
        } else {
        const raw = st ? st.rawLen : null;
        if (raw === 0) {
          toast('整理没生效：模型这次没返回可用的内容（不是"没有可合并的"）。'
                + '可以直接再点一次；连续两次这样，多半是模型或网络的问题。', 6000);
        } else if (raw !== null && raw > n1) {
          toast('整理完成，但结果被条数上限裁掉了（模型给了 ' + raw + ' 条，留下 ' + n1 + ' 条）。'
                + '可以去设置里调大「记忆条数上限」，或者再点一次整理。', 6000);
        } else {
          // ⚠️ 这句以前写的是「再点一次通常会好一些」—— 那是错的建议。
          // 模型原样返回，说明它认为这些条目本来就不重复，
          // 再点一百次结果也一样，而每点一次都真花一次 API 的钱。
          // 现在把"没事可做"和"功能坏了"明确分开，别让他白点。
          toast('整理完成：这次没有需要合并的。'
                + '现在这 ' + n1 + ' 条说的都是不同的事，模型觉得没必要动 —— '
                + '这是正常结果，不用再点了。', 6000);
        }
        }
      } else {
        toast('整理完成：' + n0 + ' → ' + n1 + ' 条（' + short(n0 - n1) + '）'
              + '，字数 ' + c0 + ' → ' + c1 + '（' + short(c0 - c1) + '）', 4200);
      }
    } catch (err) {
      toast('整理失败：' + ((err && err.message) || err), 4200);
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  };

  // 【优化 C】撤销上次整理：把备份写回去。
  // 只在有备份时可用；整理完条数/字数没变化的话也允许撤（等于回到备份的原样）。
  $('btn-mem-undo').onclick = async () => {
    const btn = $('btn-mem-undo');
    if (btn.disabled || !curCharId) return;
    const bk = await kv.get('memTidyBackup:' + curCharId, null);
    if (!bk || !Array.isArray(bk.items) || !bk.items.length) {
      toast('还没有可撤销的整理'); return;
    }
    const cur = await mem.list(curCharId);
    const ok = await confirmBox('撤销上次整理',
      '<p>把「' + esc(curChar?.name || '她') + '」的记忆<b>还原成整理之前的样子</b>？</p>'
      + '<p>会丢掉这次整理的结果，回到 <b>' + bk.items.length + ' 条</b>（'
      + new Date(bk.at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      + ' 的样子）。</p>'
      + '<p>当前是 ' + cur.length + ' 条。</p>', '撤销');
    if (!ok) return;
    btn.disabled = true;
    try {
      // ⚠️ 写回时【用备份里原来的 id】，不要重新生成（2026-09-27 修）。
      // 下面删"新增条目"靠 id 比对 —— 如果这里换了新 id，
      // 刚写回的这批自己也会被当成"新增的"删掉，等于撤销完一片空白。
      // （老备份没存 id，才退回 uid()。）
      for (const it of bk.items) {
        // ⚠️ 同样要带上 untilHour/untilMinute（v1.21.25 修，复审 ★4）——
        // 撤销如果丢了字段，用户点"撤销上次整理"反而把到期时刻改错，等于没救回来。
        await mem.add({ id: it.id || uid(), charId: curCharId, text: it.text, kind: it.kind || 'fact',
                        untilDay: typeof it.untilDay === 'number' ? it.untilDay : null,
                        untilHour: typeof it.untilHour === 'number' ? it.untilHour : null,
                        untilMinute: typeof it.untilMinute === 'number' ? it.untilMinute : 0,
                        freq: it.freq, mine: !!it.mine, ts: Date.now() });
      }
      // 删掉【备份之外新增的】—— 用 id 比对（2026-09-27 修）。
      //
      // 老写法是拿 text 做集合去比对，只要"文本完全相等"就保留。
      // 但整理本来就会改措辞（把两条合成一条、压成大意），
      // 改完的文本和备份里的对不上：
      //   · 备份的那批被重新写入（新 uid）
      //   · 当前那批因为文本对不上，被当成"新增的"删掉 —— 看起来没问题
      //   · 但如果模型只是微调（少一个字、多个标点），就会出现
      //     旧的没删、新的又写进来 → 记忆里同一件事两条。
      // 现在备份带了 id：备份里有的 id 原样保留，其余全删。
      // 兼容老备份（没存 id 的那种）—— 退回用文本比对。
      const hasIds = bk.items.some(x => x.id);
      const keepIds = hasIds ? new Set(bk.items.map(x => x.id)) : null;
      const keepTexts = hasIds ? null : new Set(bk.items.map(x => x.text));
      const nowList = await mem.list(curCharId);
      // ⚠️再兜一层：自定义记忆【永远不删】（v1.21.30 修，复审一级）。
      //
      // 即使 (a) 已让备份存全量，这里仍要防「老备份」（数据库里可能还留着
      // v1.21.29 及更早写下的、不含 mine 的残缺备份）——
      // 用户装了新版本后第一次点撤销，读到的就是那种旧备份。
      // 上层已经用 allowEditMine 决定要不要保护自定义记忆，这里与它保持一致。
      const _P = effSettings(curChar, S);
      const _guardMine = !_P.allowEditMine;
      const removable = _guardMine ? nowList.filter(m => !m.mine) : nowList;
      let removed = 0;
      for (const m of removable) {
        const keep = hasIds ? keepIds.has(m.id) : keepTexts.has(m.text);
        if (!keep) { await mem.del(m.id); removed++; }
      }
      await kv.set('memTidyBackup:' + curCharId, null);   // 用掉了就清掉，避免重复撤
      await renderMem();
      await refreshMemOverflow();
      toast('已撤销，记忆回到 ' + (await mem.list(curCharId)).length + ' 条', 3200);
    } catch (err) {
      toast('撤销失败：' + ((err && err.message) || err), 4200);
    } finally { btn.disabled = false; }
  };

  // 记忆节奏：全局统一，对所有角色生效
  $('s-mem-sum').value = S.memSummarizeEvery || 50;
  $('s-mem-dedupe').value = S.memDedupeEvery || 20;
  $('s-mem-limit').value = S.memLimit || 20;
  $('s-mem-sum').onchange = e => saveSettings({ memSummarizeEvery: Math.max(10, Number(e.target.value) || 50) });
  $('s-mem-dedupe').onchange = e => saveSettings({ memDedupeEvery: Math.max(2, Number(e.target.value) || 20) });
  $('s-mem-limit').onchange = e => saveSettings({ memLimit: Math.max(5, Number(e.target.value) || 20) });

  // 时间细化（全局）：控制聊天栏是否显示时:分、记忆能否设到小时
  $('s-clock-detail').checked = !!S.clockDetail;
  // 描写详细程度（v1.21.31）：全局档。点开弹窗选。
  const renderDriveGlobal = () => {
    $('s-drive-brief').textContent = driveLabel(S.detailDrive || 'off');
  };
  renderDriveGlobal();
  renderMemHealth();
  // ⚠️ 全局「非对话描写」控件（v1.21.34 修，复审 新5）——
  // 起因：以前【只有角色页有】descLevel，设置页只有 detailDrive。
  // 而设置页文案却写着"和角色页那个非对话描写是两个独立开关"，
  // 引导用户去找一个【根本不存在的开关】。
  renderSeg('s-desc', DESC_PRESETS, S.descLevel || 'mid', async v => {
    await saveSettings({ descLevel: v });
    toast('非对话描写已改为「' + (DESC_PRESETS.find(x => String(x.value) === String(v)) || {}).label + '」，下一条回复生效', 3000);
  });
  $('s-drive').onclick = () => openDrivePicker(S.detailDrive || 'off', async v => {
    if (v === null) return;
    await saveSettings({ detailDrive: v });
    renderDriveGlobal();
    toast('已改为「' + driveLabel(v) + '」，下一条回复立刻生效', 3000);
  });

  // 「写字台」（v1.21.48，全局）：输入框长什么样。
  // 它不碰 prompt、不碰存储格式 —— 换台手机同步过去也只是行数不同。
  // 默认 3 行 = 老版本的 120px，装上去观感不变，别让人以为 UI 坏了。
  const INPUT_H_PRESETS = [
    { label: '1 行', value: 1 }, { label: '2 行', value: 2 },
    { label: '3 行', value: 3 }, { label: '5 行', value: 5 }, { label: '8 行', value: 8 }
  ];
  const renderWriterBar = () => {
    const h = INPUT_H_PRESETS.some(p => p.value === Number(S.inputMaxH)) ? Number(S.inputMaxH) : 3;
    renderSeg('s-input-h', INPUT_H_PRESETS, h, async v => {
      await saveSettings({ inputMaxH: Number(v) });
      syncInput();
      renderWriterBar();   // 说明行跟着改；重画这一排不影响刚写进去的值
      toast('输入框最多长到 ' + v + ' 行', 2400);
    });
    $('s-input-h-note').textContent = h <= 1
      ? '只有一行，看不到的字会在框里滚动。'
      : '打字时框会自己长高，最多到 ' + h + ' 行，再长就在框里滚动。';
    renderSeg('s-enter-send', [{ label: '回车就发', value: 'on' }, { label: '回车换行', value: 'off' }],
      S.enterSend === false ? 'off' : 'on', async v => {
        await saveSettings({ enterSend: v !== 'off' });
        renderWriterBar();   // 让下面那句说明跟着这一档换文案
        syncInput();         // 字数要当场出现或消失，不能等我再打一个字
        toast(v === 'off' ? '回车改成换行了，用右边的「发送」按钮发' : '回车恢复成直接发送', 3000);
      });
  };
  renderWriterBar();
  // ⚠️ 打开设置页就同步一次输入框（v1.21.48）。
  // 起因：这两个值在【聊天页】才用得上，但聊天页是从头到尾不退出的 ——
  // 不主动推一次，用户切回聊天时框还是旧高度，得先打一个字才变。
  syncInput();
  // 「时间跟现实走」（v1.20.21）。切换时要处理存档位：
  //   开 → 若没有存档位就开一个（第 1 天 = 此刻）；有的话接着走。
  //   关 → 什么都不动，存档位留着，下次开回来接着算。
  $('s-clock-mode').checked = S.clockMode === true;
  $('s-clock-detail').onchange = async e => {
    await saveSettings({ clockDetail: e.target.checked });
    renderClock();          // 聊天栏立刻跟着变
    renderMessagesIfIdle(); // 记忆条目的时间标签也要重画（生成中不重绘，见该函数注释）
  };

  // 「时间跟现实走」（v1.20.21，全局开关）。
  $('s-clock-mode').onchange = async e => {
    const on = e.target.checked;
    await saveSettings({ clockMode: on });
    // ⚠️ 角标在这里就刷：后面 startRealClock / renderMessagesIfIdle 是一串慢活
    // （要给所有跟随全局的角色重开存档位）。等到函数末尾才刷的话，
    // 用户已经拨完开关、角标还停在旧值上。
    refreshClockHint();
    // 从【关】切到【开】：开一个全新存档位（第 1 天 = 此刻）。
    // 约定的规则 —— 从关到开，时间从第一天默认时间重新开始。
    // 从【开】切到【关】：什么都不动，存档位留着，下次开回来接着走。
    if (on) {
      // all=true：全局开关要给【所有跟随全局的角色】重开存档位。
      // 只做当前那个的话，切到别的角色会接上很久以前的旧进度。
      await startRealClock(undefined, true);
      // ⚠️ 只有当前角色【真的】跟现实走时才覆盖 clockState（2026-09-29 自查）。
      // 当前角色的 clockPolicy 若是 'off'，它是显式手动模式，全局开关管不着它 ——
      // 无条件覆盖会把 realNow() 的值塞进它的手动时间状态，而 isRealClock() 仍是
      // false，下一轮 storyStamp 就直接拿这份被污染的值当手动时间用了。
      if (isRealClock()) clockState = { ...clockState, ...realNow() };
      toast('已开启：跟随全局的角色都从第 1 天开始跟着手机走', 3600);
    } else {
      // ⚠️ 关掉时必须把时钟状态【重新从磁盘读回来】（v1.21.60 修）。
      //
      // 磁盘那份一直是干净的：saveClock() 在现实模式下不写 clock:<id>，
      // 所以手动设的时间没被覆盖过。问题出在内存里这份 ——
      // loadClock() 的最后一行、以及本函数开启分支，都会执行
      //   if (isRealClock()) clockState = { ...clockState, ...realNow() };
      // 把它换成"此刻的真实时间"。
      //
      // 原来这里只 toast 一句就往下 renderClock()，渲染的还是被污染的那份，
      // 于是现象就是：关掉「时间跟现实走」之后，时间没有回到开之前的状态。
      if (curCharId) await loadClock(curCharId);
      toast('已关闭：回到手动调时间', 2600);
    }
    renderClock();
    // ⚠️ 必须用 IfIdle 那个（v1.21.52）：这个开关【生成中也能拨】。
    // 直接用 renderMessages() 会把 box.innerHTML 清空，正在打字的占位气泡变成游离节点，
    // 后面所有增量都写进空气（字突然不滚，最后一次性蹦出来）；这轮要是再报错，
    // 「重试一次」按钮也找不到了（ph 已经是 null）。
    // 紧挨着它上面的几个回调早就换成 IfIdle 了，这里漏了一个。
    await renderMessagesIfIdle();
  };

  // —— 联网搜索（全局）——
  // 默认关。开关和 key 都在这；角色级可以在角色编辑页覆盖（跟随/强制开/强制关）。
  $('s-search-on').checked = !!S.searchOn;
  $('s-search-key').value = S.searchKey || '';
  $('s-search-count').value = S.searchCount || 5;

  const paintSearchState = () => {
    const el = $('search-state');
    if (!el) return;
    const hasKey = !!S.searchKey;
    if (!S.searchOn) { el.textContent = '未启用'; el.className = 'search-state'; }
    else if (!hasKey) { el.textContent = '缺 Key'; el.className = 'search-state'; }
    else { el.textContent = '就绪'; el.className = 'search-state on'; }
  };
  paintSearchState();

  $('s-search-on').onchange = async e => {
    await saveSettings({ searchOn: e.target.checked });
    paintSearchState();
    toast(e.target.checked
      ? (S.searchKey ? '联网搜索已开，打 /搜 就能用' : '已开，但还要填搜索 Key')
      : '联网搜索已关，恢复纯本地', 2600);
  };
  $('s-search-key').onchange = async e => {
    await saveSettings({ searchKey: e.target.value.trim() });
    paintSearchState();
  };
  $('s-search-count').onchange = e =>
    saveSettings({ searchCount: Math.min(10, Math.max(1, Number(e.target.value) || 5)) });

  $('btn-search-test').onclick = async () => {
    const btn = $('btn-search-test');
    if (!S.searchKey) { toast('先填上面的搜索 Key', 2600); return; }
    btn.disabled = true; btn.textContent = '测试中…';
    try {
      const re = await webSearch({ apiKey: S.searchKey, query: '今天有什么新闻', max: 3 });
      const n = re.results.length;
      toast(n ? '能搜到，返回 ' + n + ' 条。打 /搜 就能用了' : '连上了但没结果，换个词试试', 3400);
    } catch (err) {
      toast('测试失败：' + ((err && err.message) || err), 4200);
    } finally { btn.disabled = false; btn.textContent = '测试一下能不能搜'; }
  };

  // 界面语言（v1.21.60）。切换后立刻重刷界面文字 —— 不用退出去重进。
  const langSel = $('s-lang');
  if (langSel) {
    if (!langSel.options.length) {
      langSel.innerHTML = LANGS.map(l => '<option value="' + esc(l.key) + '">' + esc(l.label) + '</option>').join('');
    }
    langSel.value = getLang();
    langSel.onchange = async e => {
      const v = e.target.value;
      setLang(v);
      await saveSettings({ lang: v });
      applyI18n();          // 静态文本（h3 / 折叠头 / 提示）
      renderDrawerMenu();   // 抽屉是拼出来的
      toast(v === 'en' ? 'Language: English' : '界面语言：中文');
    };
  }
  $('s-theme').value = S.theme;
  $('s-font').value = S.fontSize; $('v-font').textContent = S.fontSize;
  $('s-showusage').checked = S.showUsage !== false;   // 老设置没这个键，按开着算

  $('s-apikey').onchange = e => { saveSettings({ apiKey: e.target.value.trim() }); updateStatus(); refreshApiHint(); };
  // ⚠️ 明文公网地址要先确认（v1.21.56）。
  //
  // 背景：network_security_config 是【全局】放行明文的（局域网 Ollama 要用 http），
  // 而那一层收窄不了 —— Android 的 NSC 里 <domain> 只认具体主机名/IP，
  // 不支持 192.168.* 这种网段；而且它是【编译期静态 XML】，运行时加域名不生效。
  // 所以闸只能设在"用户填地址的那一刻"：
  //   · 本机 / 局域网 → 照常放行，不打扰（Ollama、自建端点都在这儿）
  //   · 公网 http → 明确告诉他会发生什么，让他自己决定
  $('s-baseurl').onchange = async e => {
    const v = e.target.value.trim() || DEFAULTS.baseUrl;
    if (/^http:\/\//i.test(v) && !isPrivateHttpHost(v)) {
      const ok = await confirmBox('这个地址是明文的',
        '<p><b>' + esc(v) + '</b></p>'
        + '<p>它走的是 <b>http</b>，而且不是局域网地址。这意味着：</p>'
        + '<p>· 你的 API Key 和每一轮对话内容都会<b>以明文经过网络</b><br>'
        + '· 同一个 Wi-Fi 下的人有机会看到它们</p>'
        + '<p>建议换成 https 的地址，或者用局域网里的服务（192.168.x.x / 10.x.x.x）。</p>',
        '我还是要用');
      if (!ok) { e.target.value = S.baseUrl; return; }   // 用户取消 → 输入框退回原值
    }
    await saveSettings({ baseUrl: v });
  };
  $('s-model').onchange = e => { saveSettings({ model: e.target.value.trim() || DEFAULTS.model }); updateStatus(); refreshApiHint(); };
  $('s-vmodel').onchange = e => saveSettings({ visionModel: e.target.value.trim() || DEFAULTS.visionModel });
  $('btn-balance').onclick = async () => {
    const b = $('s-balance');
    b.textContent = '查询中…';
    try {
      const r = await fetchBalance({ apiKey: S.apiKey, baseUrl: S.baseUrl, provider: S.provider });
      if (!r.available) { b.textContent = '余额不足'; return; }
      b.textContent = r.total + ' ' + r.currency + (r.granted && r.granted !== '0.00' ? '（赠金 ' + r.granted + '）' : '');
    } catch (err) {
      b.textContent = '查询失败';
      toast(String(err.message || err));
    }
  };

  $('s-theme').onchange = async e => { await saveSettings({ theme: e.target.value }); applyTheme(); };
  $('s-font').oninput = e => { $('v-font').textContent = e.target.value; saveSettings({ fontSize: Number(e.target.value) }); applyTheme(); };
  $('s-showusage').onchange = async e => {
    await saveSettings({ showUsage: e.target.checked });
    renderMessagesIfIdle();   // 立刻按新开关重画；生成中跳过，免得清掉打字气泡
  };
}

/**
 * 归档区的实时提示：让用户点之前就知道会动多少条。
 */
async function archivePreview() {
  const all = await msgs.list(curCharId);
  const keep = Math.max(0, Number(S.archiveKeep) || 0);
  const arch = await msgs.archived(curCharId);
  return { total: all.length, kept: Math.min(keep, all.length), archived: arch.length };
}

async function renderArchiveHint() {
  const hint = $('arch-hint');
  const prev = $('arch-preview');
  if (!curCharId) { if (prev) prev.textContent = '还没有选择角色。'; return; }
  const st = await archivePreview();
  const willArchive = Math.max(0, st.total - st.kept);
  if (hint) {
    // 两个数都要显示：只看"已归档"的话，之后又攒了新的也看不出来
    const parts = [];
    if (willArchive) parts.push(willArchive + ' 条可归档');
    if (st.archived) parts.push(st.archived + ' 条已归档');
    hint.textContent = parts.length ? parts.join(' · ') : '暂无';
  }
  if (prev) {
    prev.innerHTML = st.total
      ? '当前 <b>' + st.total + '</b> 条未归档'
        + (willArchive ? '，按上面的设置会归档最早的 <b>' + willArchive + '</b> 条' : '，都在保留范围内')
        + (st.archived ? '<br>另有 <b>' + st.archived + '</b> 条已归档（不再发出，可展开回看）' : '')
      : '还没有聊天记录。';
  }
}

/**
 * 执行归档：带进度提示。
 * 归档是按批总结的，可能跑十几秒，所以要让用户看到进度、且中途不能重复点。
 */
async function doArchive() {
  const btn = $('btn-archive-now');
  const restore = $('btn-archive-restore');
  if (btn.disabled) return;
  btn.disabled = true; restore.disabled = true;
  const oldLabel = btn.textContent;
  try {
    const res = await runArchiveNow((i, n) => { btn.textContent = '整理中 ' + i + '/' + n + '…'; });
    if (!res.ok) { toast(res.msg || '归档没做成', 3200); return; }
    await renderMessagesIfIdle();   // ⚠️ 别改成 renderMessages：这个按钮【能在生成中点】，
                                    //    无条件重绘会把正在打字的气泡清掉。归档本身照做，
                                    //    记忆区和归档提示走各自的 render，不受影响。
    await renderArchiveHint();
    await renderMem();
    toast('已归档 ' + res.archived + ' 条，整理出 ' + res.added + ' 条记忆', 3600);
  } catch (err) {
    toast('归档失败：' + ((err && err.message) || err), 4200);
  } finally {
    btn.disabled = false; restore.disabled = false;
    btn.textContent = oldLabel;
  }
}

/**
 * 记忆超没超上限：让用户看得见，也能一键压回去。
 * 放在模块级 —— bindEvents 里的 fold() 也要用它，
 * 定义在 bindSettings 内部的话那边根本访问不到（会直接把整个初始化搞崩）。
 */
/**
 * 记忆健康状态（v1.21.35 新增，P2-2）。
 *
 * 起因：用户踩的坑（3369 条消息被标记"看过"、12 个角色总结长期不触发）
 * 在界面上【完全不可见】—— 只能感觉到"她忘了"，
 * 无法区分是"总结根本没跑"还是"模型没提炼出来"。
 *
 * 这里把三个关键数摆出来：待总结条数 / 队列长度 / 上次整理结果。
 * 待总结接近或超过门槛时会标红，用户就知道"该去聊两句了"。
 */
async function renderMemHealth() {
  const el = $('mem-health');
  if (!el) return;
  if (!curCharId) { el.textContent = '—'; return; }
  try {
    // 与 summarizeIfNeeded / runArchiveNow 保持同一口径（含归档）。
    const all = await msgs.list(curCharId, 0, true);
    const summed = new Set(await kv.get('memSummed:' + curCharId, []) || []);
    const pending = all.filter(m => !summed.has(m.id)).length;
    const limit = S.memSummarizeEvery || 50;
    const q = Math.min(((await kv.get('memDeleted:' + curCharId, [])) || []).length, 40);
    const mems = await mem.list(curCharId);
    const last = await kv.get('memArchiveLastAt:' + curCharId, 0);
    const lastTxt = last ? new Date(last).toLocaleString('zh-CN', { month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit' }) : '还没跑过';
    const pendCls = pending >= limit ? 'warn' : '';
    const qCls = q >= 30 ? 'warn' : '';
    el.innerHTML =
      '待总结 <b class="' + pendCls + '">' + pending + '</b> / ' + limit + ' 条'
      + (pending >= limit ? '<span class="warn">（够了，发一条消息就会整理）</span>' : '')
      + '<br>待清理队列 <b class="' + qCls + '">' + q + '</b> / 40 条'
      + (q >= 30 ? '<span class="warn">（积压较多，整理时容易出错）</span>' : '')
      + '<br>长期记忆 <b>' + mems.length + '</b> 条　上次归档 ' + lastTxt;
  } catch (e) {
    el.textContent = '（读取失败：' + ((e && e.message) || e) + '）';
  }
}

async function refreshMemOverflow() {
  const el = $('mem-overflow');
  if (!el) return;
  if (!curCharId) { el.textContent = '—'; return; }
  const n = (await mem.list(curCharId)).length;
  const lim = S.memLimit || 20;
  const nm = esc(curChar?.name || '她');
  el.innerHTML = n > lim
    ? `「${nm}」现在记着 <b>${n}</b> 条，超过上限 <b>${lim}</b> 条 —— 点下面可以整理回去。`
    : `「${nm}」现在记着 <b>${n}</b> 条（上限 ${lim}）。`;
}

// ================= 记忆页 =================
/**
 * 角色编辑页里的「她记住的事」：只显示这一个人的记忆，可以逐条删、也可以自己加。
 * 和设置页那套的区别：那边是看全部（按人物分组），这边是盯着一个人细看细改。
 */
/**
 * 渲染一条记忆的 HTML。角色页和设置页共用 —— 以前两处各写一份，
 * 改显示要改两遍，早晚会不一致。
 *
 * 排版：内容在上，下面另起一行放胶囊标签（左下角、从左往右排）。
 *   [长期] / [第 4 天]   然后 [自定义]（只有手动加的才有）
 */
function memItemHtml(m, opts = {}) {
  const clickable = opts.clickable !== false;
  const tags = [];
  if (m.kind === 'event' && typeof m.untilDay === 'number') {
    // 有小时就显示到分钟（"第 4 天 15:00"），没有就还是"第 4 天"
    const t = (typeof m.untilHour === 'number')
      ? ' ' + String(m.untilHour).padStart(2, '0') + ':' + String(m.untilMinute || 0).padStart(2, '0')
      : '';
    tags.push('<em class="mem-tag ev">第 ' + m.untilDay + ' 天' + t + '</em>');
  } else {
    tags.push('<em class="mem-tag">长期</em>');
  }
  if (m.mine) tags.push('<em class="mem-tag mine">自定义</em>');
  // 结构：左列（正文 + 下面另起一行的标签）｜右列（✕）
  // 标签必须包在左列里才会"在文字下面"；直接和 .txt 平级的话，
  // .mem-item 是横排 flex，标签会被挤到文字右边去。
  return '<div class="mem-item' + (clickable ? ' tap' : '') + '" data-mid="' + esc(m.id) + '">'
    + '<div class="mem-body">'
    +   '<div class="txt">' + esc(m.text) + '</div>'
    +   '<div class="mem-foot">' + tags.join('') + '</div>'
    + '</div>'
    + '<button class="del" data-cdel="' + esc(m.id) + '">✕</button></div>';
}

/**
 * 记忆编辑弹窗：改内容 / 改有效期 / 删除。
 * 有效期用「第几天」表示——就是聊天栏上面时间轴的那个天数。
 * 第 N 天表示「第 N 天为止有效」：当天不删，day > N 才删（和 pruneMemories 一致）。
 */
function openMemEditor(memId, charId) {
  return new Promise(async (resolve) => {
    const all = await mem.list(charId);
    const m = all.find(x => x.id === memId);
    if (!m) { resolve(false); return; }
    const isEvent = m.kind === 'event' && typeof m.untilDay === 'number';
    const modal = $('modal');
    $('modal-title').textContent = '修改这条记忆';
    $('modal-text').innerHTML =
      '<p><textarea id="mem-edit-text" rows="4" style="width:100%;resize:vertical"></textarea></p>'
      + '<p style="margin-top:10px"><label style="display:flex;gap:8px;align-items:center">'
      + '<input type="checkbox" id="mem-edit-hasexp"' + (isEvent ? ' checked' : '') + '>'
      + '<span>在某一天之后不再记着</span></label></p>'
      + '<p id="mem-edit-exprow" style="margin-top:6px;' + (isEvent ? '' : 'display:none') + '">'
      + '第 <input type="number" id="mem-edit-exp" min="1" max="' + DAY_MAX + '" style="width:104px" value="' + (isEvent ? m.untilDay : '') + '"> 天之后不再记着</p>'
      // 开了时间细化才让填"几点"（精确到分钟）
      + (S.clockDetail
          ? '<p id="mem-edit-hourrow" style="margin-top:6px;' + (isEvent ? '' : 'display:none') + '">'
            + '到 <input type="number" id="mem-edit-hour" min="0" max="23" style="width:70px" value="' + (typeof m.untilHour === 'number' ? m.untilHour : '') + '" placeholder="时">'
            + ' : <input type="number" id="mem-edit-min" min="0" max="59" style="width:70px" value="' + (typeof m.untilMinute === 'number' ? m.untilMinute : '') + '" placeholder="分">'
            + ' 为止（留空 = 那一天过完）</p>'
          : '');
    $('modal-ok').textContent = '保存';
    modal.classList.remove('hidden');
    const ta = $('mem-edit-text');
    ta.value = m.text;
    $('mem-edit-hasexp').onchange = (e) => {
      const show = e.target.checked ? '' : 'none';
      $('mem-edit-exprow').style.display = show;
      const hr = $('mem-edit-hourrow');
      if (hr) hr.style.display = show;
    };
    const done = (v) => {
      modal.classList.add('hidden');
      $('modal-ok').onclick = null;
      $('modal-cancel').onclick = null;
      resolve(v);
    };
    $('modal-ok').onclick = () => done(true);
    $('modal-cancel').onclick = () => done(false);
  });
}

/** 把弹窗里填的东西写回库 */
async function saveMemEdit(memId, charId) {
  const all = await mem.list(charId);
  const m = all.find(x => x.id === memId);
  if (!m) return false;
  const text = ($('mem-edit-text')?.value || '').trim() || m.text;
  const useExp = !!$('mem-edit-hasexp')?.checked;
  const n = Number($('mem-edit-exp')?.value);
  const untilDay = useExp && isFinite(n) && n > 0 ? Math.floor(n) : null;
  // 小时/分钟：只有开了时间细化、且有时限时才存。留空 = 那一天过完才过期（老行为）
  let untilHour = null, untilMinute = 0;
  if (untilDay !== null && S.clockDetail) {
    const hEl = $('mem-edit-hour'), mEl = $('mem-edit-min');
    const hv = Number(hEl?.value), mv = Number(mEl?.value);
    if (hEl && hEl.value.trim() !== '' && isFinite(hv)) {
      untilHour = Math.min(23, Math.max(0, Math.floor(hv)));
      untilMinute = (mEl && mEl.value.trim() !== '' && isFinite(mv)) ? Math.min(59, Math.max(0, Math.floor(mv))) : 0;
    }
  }
  // kind 跟着有效期走，两边必须一致：
  //   · 有有效期 → event（pruneMemories 只删 event 型，不写 event 就永远不会过期）
  //   · 没有效期 → fact（以前这里保留原 kind，会留下"event 但 untilDay=null"的
  //     脏数据 —— 虽然不会误删，但语义不清、显示也不对）
  await mem.add({ ...m, text, kind: untilDay === null ? 'fact' : 'event',
                  untilDay, untilHour, untilMinute, ts: m.ts });
  return true;
}

/**
 * 绑定一批记忆条目的交互：✕ 删除、点内容弹窗修改。
 * 回调 after() 用来让调用方重绘自己那一块。
 */
function bindMemItems(box, charId, after) {
  box.querySelectorAll('[data-cdel]').forEach(b => b.onclick = async (e) => {
    e.stopPropagation();                 // 别连带触发"点开编辑"
    await mem.del(b.dataset.cdel);
    await after();
  });
  box.querySelectorAll('.mem-item.tap').forEach(el => el.onclick = async () => {
    const ok = await openMemEditor(el.dataset.mid, charId);
    if (!ok) return;
    const saved = await saveMemEdit(el.dataset.mid, charId);
    await after();
    if (saved) toast('已保存', 1600);
  });
}

async function renderCharMem(charId) {
  const listEl = $('e-mem-list');
  if (!listEl) return;
  const id = charId || editingId;
  const cnt = $('e-mem-count');

  if (!id) {
    // 还没保存过的新角色：记忆要等存下来才有归属
    if (cnt) cnt.textContent = '还没有';
    listEl.innerHTML = '<div class="sys-line">先保存这个角色，之后她记住的事会出现在这里。</div>';
    return;
  }

  const items = await mem.list(id);
  // 这期间用户可能已经点开了别的角色（#e-mem-list 是全局唯一节点，所有角色共用）。
  // 不校验的话，A 的结果会写进"标题已经是 B"的页面里，用户对着 B 的界面删 A 的记忆。
  if (id !== editingId) return;
  items.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  if (cnt) cnt.textContent = items.length ? `${items.length} 条` : '还没有';

  if (!items.length) {
    listEl.innerHTML = '<div class="sys-line">她还没记住什么。开着长期记忆，她会自己攒；也可以在下面手动加。</div>';
    return;
  }
  listEl.innerHTML = items.map(m => memItemHtml(m)).join('');
  bindMemItems(listEl, id, () => renderCharMem(editingId));
}

// ================= 外貌（她此刻的样子）=================

/**
 * 识图 → 生成外貌描述（追加到外貌框用）。
 *
 * ⚠️ 只让它【描述穿什么】，不让它【猜这是谁】：
 * 模型认角色经常认错，一旦认错，错的就不只是这一句，而是污染整个外貌字段。
 * 描述衣服/发型/配饰是它的强项，准确率高得多。
 *
 * 也不写背景、剧情、表情心理——那些不属于"她此刻的样子"。
 */
async function describeAppearance(dataUrl) {
  const out = await onceChat({
    apiKey: S.apiKey, baseUrl: S.baseUrl, provider: S.provider, model: S.visionModel || S.model,
    temperature: 0.2,
    maxTokens: 400,
    messages: [
      { role: 'system', content:
        '你是一个服装与外貌描写的助手。看图，只描述图中人物的【外在特征】。\n\n'
        + '【只写这些】\n'
        + '· 服装：款式、颜色、长短\n'
        + '· 头发：发色、发型、有没有系发饰\n'
        + '· 配饰：帽子、伞、饰品、随身物品\n'
        + '· 整体风格（一到两字概括，比如端庄、活泼、神秘）\n\n'
        + '【绝对不要写】\n'
        + '· 不要猜人物身份或名字（不要说"这是某某"）\n'
        + '· 不要写背景、场景、光线、天气\n'
        + '· 不要写表情、情绪、心理活动\n'
        + '· 不要评价好不好看\n\n'
        + '【格式】\n'
        + '用中文，3-5 行短句，每行一件事，不要编号不要标题。\n'
        + '总字数控制在 60 字以内——这是给聊天用的速记，不是作文。\n'
        + '直接输出内容，不要开场白。' },
      { role: 'user', content: '请描述这张图里人物的外在特征。', images: [dataUrl] }
    ]
  });
  return String(out || '').trim();
}

/** 更新外貌的字数显示 + 折叠头摘要 */
function refreshLookCount() {
  const box = $('e-look');
  if (!box) return;
  const n = (box.value || '').trim().length;
  const cnt = $('e-look-count');
  if (cnt) {
    cnt.textContent = n ? n + ' 字 · 建议 20-50 字' : '还没写';
    // 超出建议范围给个颜色提示，但不阻止输入
    cnt.style.color = (n > 0 && (n < 10 || n > 80)) ? 'var(--danger)' : '';
  }
  const brief = $('look-brief');
  if (brief) brief.textContent = n ? n + ' 字' : '未填';
}

/** 把识图结果追加到外貌框末尾（另起一行），不覆盖已经写的 */
function appendLook(text) {
  const box = $('e-look');
  if (!box) return;
  const cur = box.value.replace(/\s+$/, '');
  box.value = cur ? cur + '\n' + text : text;
  refreshLookCount();
}

/**
 * 记忆管理：三层结构
 *   第 1 层「已记住的事」（在 index.html 里，静态的折叠头）
 *   第 2 层 人物卡片 —— 点开某个人
 *   第 3 层 那个人的记忆列表 —— 可以逐条删，也可以自己加
 *
 * 记忆按 charId 分开存，所以这里先分组再渲染。
 * 已经展开的人（_memOpen）、以及每个人里面正在输入的内容（_memDraft），
 * 都记在外面 —— 否则删一条就会整块重绘，把人家展开的、打了一半的字全弄没。
 */
let _memOpen = new Set();     // 展开了哪些角色（存 charId）
let _memDraft = {};           // charId -> 还没提交的输入内容

async function renderMem() {
  const all = await mem.all();
  const cs = await chars.all();
  const box = $('mem-groups');
  if (!box) return;

  const cnt = $('mem-count');
  if (cnt) {
    const owners = new Set(all.map(m => m.charId)).size;
    cnt.textContent = all.length ? `${all.length} 条 · ${owners} 人` : '还没有';
  }

  // 按角色分组。列表里已经不存在的角色（被删了）单独拎出来放最后，
  // 免得他的记忆在界面上彻底消失、再也删不掉。
  const groups = cs.map(c => ({ id: c.id, name: c.name || '未命名', items: [] }));
  const byId = new Map(groups.map(g => [g.id, g]));
  const orphan = { id: '__orphan__', name: '已删除的角色', items: [] };
  for (const m of all) (byId.get(m.charId) || orphan).items.push(m);
  const list = orphan.items.length ? groups.concat([orphan]) : groups;

  // 角色可能已经被删了，把它从「已展开」和输入暂存里摘掉，免得越攒越多
  const alive = new Set(list.map(g => g.id));
  // 孤儿组用的是固定的 '__orphan__' 占位 id。它不跟着某个角色消失：
  // 孤儿记忆被删光后这个组就没了，但 id 还留在 _memOpen 里 ——
  // 下次再删角色产生新孤儿时，那个组会莫名其妙地默认展开。
  if (!orphan.items.length) { _memOpen.delete('__orphan__'); delete _memDraft['__orphan__']; }
  for (const id of [..._memOpen]) if (!alive.has(id)) _memOpen.delete(id);
  for (const id of Object.keys(_memDraft)) if (!alive.has(id)) delete _memDraft[id];

  if (!all.length) {
    box.innerHTML = '<div class="sys-line">还没记住什么。开着长期记忆，她会自己攒。</div>';
    return;
  }

  box.innerHTML = list.map(g => {
    const open = _memOpen.has(g.id);
    const n = g.items.length;
    const num = n ? `${n} 条` : '还没有';
    // 用共用的渲染（和角色页一致：内容在上，标签另起一行）
    const body = g.items.map(m => memItemHtml(m)).join('')
      || '<div class="sys-line">她还没记住什么。</div>';
    return `<div class="mem-group${open ? ' open' : ''}" data-cid="${esc(g.id)}">`
      + `<button class="fold-head sub" data-head="1"><span>${esc(g.name)}</span>`
      + `<em class="fold-num">${num}</em><i class="fold-arrow">▾</i></button>`
      + `<div class="fold-wrap${open ? ' open' : ''}"><div class="fold-inner">`
      + body
      + `<div class="mem-add-row"><input type="text" data-inp="1" placeholder="给她加一条…" value="${esc(_memDraft[g.id] || '')}">`
      + `<button class="ghost-btn sm" data-add="1">加</button></div>`
      + `</div></div></div>`;
  }).join('');

  // 逐条绑定：折叠、删、加、输入暂存
  box.querySelectorAll('.mem-group').forEach(gEl => {
    const cid = gEl.dataset.cid;
    const head = gEl.querySelector('[data-head]');
    const wrap = gEl.querySelector('.fold-wrap');

    head.onclick = () => {
      const open = wrap.classList.toggle('open');
      head.classList.toggle('open', open);
      gEl.classList.toggle('open', open);
      if (open) _memOpen.add(cid); else _memOpen.delete(cid);
    };

    // 用共用的绑定（删除 + 点开弹窗修改），和角色页保持一致
    bindMemItems(gEl, cid, () => renderMem());

    const inp = gEl.querySelector('[data-inp]');
    inp.addEventListener('input', () => { _memDraft[cid] = inp.value; });
    const add = async () => {
      const txt = inp.value.trim();
      if (!txt) return;
      if (cid === '__orphan__') { toast('这个角色已经删掉了，没法再加'); return; }
      // mine:true = 这是你自己写的。整理记忆时要不要动它，由角色页那个开关决定。
      await mem.add({ id: uid(), charId: cid, text: txt, kind: 'fact', untilDay: null, mine: true, ts: Date.now() });
      _memDraft[cid] = '';
      await renderMem();
      const again = box.querySelector(`.mem-group[data-cid="${CSS.escape(cid)}"] [data-inp]`);
      if (again) again.focus();
    };
    gEl.querySelector('[data-add]').onclick = add;
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); add(); }
    });
  });
}

// ================= 数据导入导出 =================
// 备份要带上的 kv 键（记账 / 情景状态）。
//
// ⚠️ 不带这些的话，「完全还原」只还原一半：
//   memRolling  —— 滚动摘要。丢了 = 已归档的老对话永久失忆（归档原文不进上下文，
//                  上下文里那一段本来就是它）。换机后她完全不记得之前发生过什么。
//   memSummed   —— "哪些消息已经总结过"。丢了会把整段历史重嚼一遍（白花 token + 记忆重复）。
//   memSumAt / memDedupeAt —— 记忆节奏水位。丢了节奏从头算，导入后可能立刻触发一次总结。
//   msgSeq      —— 累计序号。
//   clock / greeted / memArchive* / memDeleted —— 剧情时间、开场白标记、归档记账。
//
// 不含：settings（单独一个字段）、memTidyBackup（"撤销上次整理"的临时快照，跨设备没意义）、
//       lastCharId（本机打开哪个角色，不该被备份覆盖）、sendCount（统计）。
const BACKUP_KV_PREFIXES = [
  'msgSeq:', 'memSummed:', 'memSumAt:', 'memDedupeAt:', 'memArchiveAt:', 'memArchiveLastAt:',
  'memDeleted:', 'memRolling:', 'clock:', 'greeted:',
  // v1.21.35 新增：0 产出批次的重试计数（P0-1 的配套键，漏了会留孤儿）
  'memZeroRetry:', 'memNeedTidy:'
];

function isBackupKey(k) {
  return BACKUP_KV_PREFIXES.some(p => String(k || '').startsWith(p));
}

// ================= 角色卡（实验，v1.21.40）=================
// 解析、CRC、PNG chunk 全在 www/js/charcard.js；这里只管落库与写文件。

/**
 * 把一张解析好的卡片落成一个【新】角色（连同它自带的世界书）。
 *
 * 不做 id 重映射：卡片是外来数据，本来就不带本机 id，直接新建最省事，
 * 也避免和 applyImport 那套"换成设备后 id 对不上"的认领逻辑纠缠。
 */
async function importCharacterCard(card, avatarDataUrl = '') {
  const preset = getPreset('blank');
  const c = {
    id: uid(),
    name: card.name,
    avatar: avatarDataUrl || null,   // PNG 卡带图时用它当头像（v1.21.52）
    // 卡片的 first_mes 就是开场白。空了退回空白模板的，免得点进去一片空白
    greeting: card.first_mes || (preset && preset.greeting) || '',
    // 卡片的 description 是"她是谁"，正对本项目的 persona
    persona: card.description || (preset && preset.persona) || '',
    presetKey: preset ? preset.key : 'blank',
    createdAt: Date.now(),
    ...pickCharParams(S),   // 新角色默认继承当前全局参数，与 ensureChar 一致
    // 「他的设定 / 他的居处」（v1.21.47）也是角色级，导入时同样给个初始值
    myProfile: typeof S.myProfile === 'string' ? S.myProfile : '',
    myEnv: typeof S.myEnv === 'string' ? S.myEnv : '',
    // 卡里若带梦弦居自己的参数，以卡为准 —— 放在最后覆盖上面的默认值。
    // 老卡（别家导出的、或 v1.21.47 之前我们自己导的）没有这一段，返回空对象。
    ...readMkParams(card),
  };
  await chars.put(c);

  let wroteEntries = 0;
  if (card.entries && card.entries.length) {
    await wb.putSolo({
      id: uid(),
      charId: c.id,
      // title / pos 一起带过来（v1.21.51）：原来只带 keys/content/on，
      // 卡片里写好的标题和档位导进来就没了。
      entries: card.entries.map(en => ({ id: uid(), title: en.title, keys: en.keys, content: en.content,
        on: en.on, pos: WBP_ORDER.indexOf(en.pos) >= 0 ? en.pos : 'front' })),
    });
    wroteEntries = card.entries.length;
  }

  await loadChars();
  await selectChar(c.id);
  renderCharList();

  const notes = [];
  if (wroteEntries) notes.push('世界书 ' + wroteEntries + ' 条');
  // ⚠️ 备选开场白本项目没有对应概念 —— 如实说出来，别假装导进去了
  if (card.alternate_greetings && card.alternate_greetings.length) {
    notes.push('忽略 ' + card.alternate_greetings.length + ' 条备选开场白（本软件没有这个概念）');
  }
  toast('已导入「' + card.name + '」' + (notes.length ? '：' + notes.join('；') : ''), 4000);
}

/**
 * 导出当前角色为卡片。
 * @param {'png'|'json'} kind
 */
async function exportCharacterCard(kind) {
  if (!curChar) { toast('先选一个角色'); return; }
  // 只导【该角色自己的】世界书。角色组（wbGroups）是全局的、可能横跨多个角色，
  // 塞进单张卡里对不上号，这里刻意不带。
  const solo = await wb.solo(curCharId);
  const entries = (solo && solo.entries) || [];
  const safeName = String(curChar.name || '未命名').replace(/[\\/:*?"<>|]/g, '_');
  const FS = capPlugin('Filesystem');
  const SH = capPlugin('Share');

  if (kind === 'json') {
    const data = buildCardV2(curChar, entries);
    await shareCardFile(safeName + '.json', JSON.stringify(data), 'application/json', FS, SH, false);
    return;
  }
  // PNG：Canvas 出一张底图（拿头像当封面），再把卡片 JSON 塞进 tEXt chunk
  const bytes = await makeCardPng(curChar, entries, curChar.avatar);
  await shareCardFile(safeName + '.png', bytesToB64(bytes), 'image/png', FS, SH, true);
}

/**
 * 把卡片交给系统分享；分享不可用就退回浏览器下载。
 * @param {boolean} binary true 时 data 是 base64，且【不能】传 encoding ——
 *   Capacitor 的 Filesystem 正是靠"没有 encoding"来判断这是二进制内容。
 */
async function shareCardFile(name, data, mime, FS, SH, binary) {
  if (isNative() && FS && SH) {
    try {
      const opts = { path: name, data, directory: 'CACHE', recursive: true };
      if (!binary) opts.encoding = 'utf8';
      const res = await FS.writeFile(opts);
      await SH.share({ title: '梦弦居 · 角色卡', text: name, url: res.uri, dialogTitle: '保存到哪，或发给谁' });
      toast('角色卡已生成');
      return;
    } catch (err) {
      const msg = String((err && err.message) || err);
      if (/cancel|取消/i.test(msg)) { toast('已取消'); return; }
      console.error('[角色卡] 分享失败', err);
      // 不 return：落到下面的下载兜底
    }
  }
  const blob = binary
    ? new Blob([Uint8Array.from(atob(data), ch => ch.charCodeAt(0))], { type: mime })
    : new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast('角色卡已下载');
}

/**
 * 私有设置项：**导出时抹掉、导入时拒绝覆盖**。
 *
 * v1.21.45 修。原来导出侧写的是 `{ ...S, apiKey: '' }`、导入侧只删 apiKey ——
 * 于是 searchKey 明文跟着备份文件走了出去，而备份正是要发微信/QQ/网盘的那种东西。
 * 导入侧同样只护了 apiKey，拿旧备份恢复会把本机新填的 searchKey 顶掉。
 *
 * 收成一份清单，以后新增任何 Key 只要往这里加一个名字，两边一起生效。
 */
const SECRET_SETTINGS = ['apiKey', 'searchKey'];

/**
 * 导入时【永不采纳】的设置键（v1.21.52）。
 *
 * 为什么 baseUrl / provider / model 也算进来：它们和 apiKey 是一对 ——
 * 决定「密钥发往哪里、用什么模型」。密钥本身早就不让覆盖了，端点却留了个口子：
 * 导入一份来源不可信的备份（备份按设计就是要发给别人、发到网盘的东西），
 * 就能把 baseUrl 改成攻击者的地址 —— 之后每一轮对话都会连 Key、历史、记忆、人设
 * 一起发过去，还能顺手改成 http:// 明文方便抓包。
 *
 * ⚠️ 和 SECRET_SETTINGS 的分工：那个管【导出时剥掉】，这个管【导入时不采纳】。
 *    导出仍然带着这几项 —— 备份里看得见自己用的哪家、哪个模型；
 *    换机后照着填一遍就行（apiKey 本来也要重填）。
 */
const NO_IMPORT_SETTINGS = ['apiKey', 'searchKey', 'baseUrl', 'provider', 'model', 'visionModel',
  // 废弃但【运行时还在被读】的开关：老备份里可能是 true，导进来会让
  // effSettings 直接返回全局设置 —— 所有角色的独立参数当场静默失效，
  // 界面还各显示各的，要重启才恢复。所以一律不采纳（v1.21.52）。
  'globalOverride'];
function stripSecrets(settings) {
  const out = { ...settings };
  for (const k of SECRET_SETTINGS) out[k] = '';
  return out;
}

/**
 * 收集一份完整备份对象。
 *
 * 从 exportData 里抽出来的（v1.21.40）—— 自动备份要的是同一份数据。
 * 两块各自维护的话迟早漂移，而"归档的对话也要带上"这条只要漏一次，
 * 备份里就静默少一大段历史，恢复后永远找不回来。
 */
async function collectBackupPayload() {
  const payload = {
    version: 1, exportedAt: Date.now(),
    settings: stripSecrets(S),        // 不导出 Key（apiKey / searchKey 都抹掉）
    characters: await chars.all(),
    messages: {}, memories: {},
    // 世界书（v1.15.2）：角色组 + 单独角色的条目。
    // 带着它导出，换机/重装后设定能一起回来。
    worldbook: { groups: [], solo: [] },
    // 记账 / 情景状态（v1.19.11）。字段独立，老版本读到会忽略，不会崩。
    kv: []
  };
  for (const c of payload.characters) {
    // 必须带上已归档的！list() 默认把它们过滤掉了，
    // 用默认的话备份里会静默少掉一大段老对话，恢复后永远找不回来。
    payload.messages[c.id] = await msgs.list(c.id, 0, true);
  }
  // 记忆是全局的一份，直接整个导出（以前按角色存，会漏掉别的角色名下的）
  payload.memories = await mem.all();
  try {
    payload.worldbook = { groups: await wb.groups(), solo: await wb.soloAll() };
  } catch (e) { /* 读不到就当没有，别让整个备份失败 */ }
  // 记账键：读不到就当没有，不能让整个备份失败
  try {
    payload.kv = (await kv.entries()).filter(e => isBackupKey(e.k));
  } catch (e) { payload.kv = []; }
  return payload;
}

async function exportData() {
  const payload = await collectBackupPayload();
  const json = JSON.stringify(payload);
  const name = '梦弦居备份-' + new Date().toISOString().slice(0, 10) + '.json';

  // 安卓端：写到应用缓存，再调系统分享（可存到文件/发微信/发 QQ）
  const FS = capPlugin('Filesystem');
  const SH = capPlugin('Share');

  if (isNative() && FS && SH) {
    try {
      const res = await FS.writeFile({
        path: name,
        data: json,
        directory: 'CACHE',      // Directory.Cache 的枚举值
        encoding: 'utf8',        // Encoding.UTF8 的枚举值
        recursive: true
      });
      await SH.share({
        title: '梦弦居 · 数据备份',
        text: '梦弦居的聊天记录与角色备份（不含 API Key）',
        url: res.uri,
        dialogTitle: '保存到哪，或发给谁'
      });
      toast('备份已生成');
      return;
    } catch (err) {
      const msg = String((err && err.message) || err);
      if (/cancel|取消/i.test(msg)) { toast('已取消'); return; }
      console.error('[导出] 分享失败', err);
      if (SH) {
        try {
          await SH.share({ title: '梦弦居备份(文本)', text: json.slice(0, 200000), dialogTitle: '保存备份内容' });
          toast('已用文本方式导出');
          return;
        } catch (e2) { /* 落到下面回退 */ }
      }
      toast('这台设备不支持原生导出，已改用浏览器方式', 4000);
    }
  }

  // 浏览器回退（电脑上测试用）
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
  toast('已导出（不含 API Key）');
}

// ================= 导入：5 种模式 =================
//
// 设计要点（每一处都是踩过的坑）：
//
// ① 【先看文件，再选模式】—— 反过来的话选完模式才发现文件不对，得从头再来一遍。
// ② 【模式 1 先清空再写】—— 只有它是破坏性的，所以额外要一次二次确认，
//    并在弹窗里写清"将删除本机 N 条消息 / N 条记忆"。
// ③ 【记忆和聊天记录绑定】—— 记忆是从对话总结出来的，只导一头会得到
//    "她记得结论但不知道来龙去脉"或反过来。所以不让单独勾。
// ④ 【apiKey 永不覆盖】—— 备份里它是空串，写回去会把本机填好的 Key 抹掉。
// ⑤ 【新角色自动新建，已有角色按 id 覆盖】—— id 一致就是同一个角色。
// ⑥ 【清空时不碰 kv 里的 settings】—— 那是本机的 apiKey 所在，清掉要用户重填。

const IMPORT_MODES = [
  {
    k: 'all', label: '完全还原（危险）', tag: '清空本机后全部导入',
    desc: '把本机的角色、聊天记录、记忆、世界书<b>全部删掉</b>，换成备份里的。' +
          '全局设置（含我的设定、居住环境）也一起换。<br>这是唯一会<b>删数据</b>的模式。',
    parts: ['settings', 'chars', 'msgs', 'mems', 'wb', 'kv'], wipe: true
  },
  {
    k: 'config', label: '设置与角色', tag: '不碰聊天记录',
    desc: '换掉全局设置、所有角色的设定与参数，以及世界书。<br>' +
          '本机的<b>聊天记录和记忆一条都不动</b>。适合改完人设导回去。',
    note: 'id 对得上就覆盖；id 对不上但<b>名字相同</b>的会合并成一个（用备份里的内容）。',
    parts: ['settings', 'chars', 'wb']
  },
  {
    k: 'chars', label: '仅角色', tag: '全局设置不动',
    desc: '只覆盖角色的设定与参数（人设、温度、上下文轮数、外貌…）和世界书。<br>' +
          '全局设置（apiKey、我的设定、居住环境、记忆节奏）保持本机不动。',
    note: 'id 对得上就覆盖；id 对不上但<b>名字相同</b>的会合并成一个（用备份里的内容）。' +
          '角色的<b>单独世界书</b>会跟着一起进来 —— 那本来就是这个角色的一部分。',
    parts: ['chars', 'wb']
  },
  {
    k: 'msgs', label: '仅聊天记录', tag: '含记忆',
    desc: '只导入聊天记录，并把长期记忆一起换成备份里的。<br>' +
          '⚠️ 只有<b>本机已存在的角色</b>的记录会进来；备份里本机没有的角色，其记录会跳过。',
    note: '同名但 id 不同的角色会按名字对应上，记录直接接到本机那个角色名下。',
    parts: ['msgs', 'mems']
  },
  {
    k: 'wb', label: '仅世界书', tag: '组 + 单独角色',
    desc: '只覆盖世界书：角色组条目和单独角色条目，两层都换。<br>角色、记录、设置都不动。',
    parts: ['wb'], wbAll: true, wbOnlyGroups: true
  }
];

/** 数一份备份里有什么，用于弹窗预览 */
function surveyBackup(data) {
  // ⚠️ 数的是【真的能落库的记录】，不是数组元素个数（v1.21.54，审计发现）。
  //
  // 起因：判据原来只数元素个数，于是一份 {characters:[{}]} 或 {messages:{x:[null]}}
  // 会被算成"有 1 个角色 / 1 条记录" —— 而它决定了「完全还原」这个
  // 【会先把本机清空】的模式能不能选。清完之后写入循环把没 id 的记录全部 continue，
  // 结果：本机数据没了、什么都没写回来、提示还是「导入完成」。
  // 判据必须和写入循环用同一把尺子（那边是 if (!c || !c.id) continue）。
  const chars = (Array.isArray(data.characters) ? data.characters : [])
    .filter(c => c && typeof c === 'object' && c.id);
  let msgsN = 0;
  for (const k of Object.keys(data.messages || {})) {
    const arr = data.messages[k];
    // 同上：写入侧是 if (!m || typeof m !== 'object') { badMsgs++; continue; }
    if (Array.isArray(arr)) msgsN += arr.filter(m => m && typeof m === 'object' && m.id).length;
  }
  const countMems = (arr) => (Array.isArray(arr) ? arr.filter(m => m && typeof m === 'object').length : 0);
  const mems = Array.isArray(data.memories)
    ? countMems(data.memories)
    : (data.memories && typeof data.memories === 'object')
      ? Object.keys(data.memories).reduce((n, k) => n + countMems(data.memories[k]), 0)
      : 0;
  // ⚠️ 两个键名都要认（2026-09-27 修）。
  // 本软件的导出用的是单数 worldbook（exportData 里写的就是它）；
  // 但早期格式/外部生成的文件用过复数 worldsbook ——
  // 只认单数的话，那种文件会被判成「世界书 0 条」，
  // 导入弹窗里「仅世界书」变灰、条目静默丢失。实测踩到过。
  const wbData = data.worldbook || data.worldsbook || (data.groups || data.solo ? data : null) || {};
  const gN = (wbData.groups || []).reduce((n, g) => n + ((g.entries || []).length), 0);
  const sN = (wbData.solo || []).reduce((n, s) => n + ((s.entries || []).length), 0);
  return {
    chars: chars.length, msgs: msgsN, mems,
    groups: (wbData.groups || []).length, solos: (wbData.solo || []).length,
    wbEntries: gN + sN,
    kv: Array.isArray(data.kv) ? data.kv.length : 0
  };
}

/**
 * 弹窗选模式。返回选中的模式对象，取消返回 null。
 *
 * 刻意不复用 confirmBox —— 那个只有「确定/取消」两个按钮，
 * 这里要 5 选 1 外加一段文件预览，塞不进去。
 */
function pickImportMode(survey, localCounts) {
  return new Promise(resolve => {
    const m = $('import-modal');
    const rows = IMPORT_MODES.map((mode, i) => {
      const has = mode.parts.some(p => {
        if (p === 'chars') return survey.chars > 0;
        if (p === 'msgs') return survey.msgs > 0;
        if (p === 'mems') return survey.mems > 0;
        if (p === 'wb') return survey.wbEntries > 0;
        return true;   // settings / kv
      });
      // ⚠️ 「完全还原」要多一条硬判据（v1.21.52）。
      // 它先把本机清空、再写回去，所以必须要求备份里【真的有东西可恢复】。
      // 原来只看上面那个 has，而 all 模式的 parts 里有 settings，最后那个
      // return true 让它【恒为真】—— 于是"仅世界书导出"那种 {groups, solo}
      // 文件也能选中完全还原：点下去本机角色/记录/记忆全被删光，
      // 而备份里一条角色、一条记录、一条记忆都没有，等于纯删。
      const recoverable = survey.chars + survey.msgs + survey.mems > 0;
      const usable = has && (!mode.wipe || recoverable);
      const warn = mode.wipe
        ? `<div class="imp-warn">将先删除本机 <b>${localCounts.messages}</b> 条聊天记录`
    + `<span style="opacity:.75">（含已归档的）</span>`
    + `、${localCounts.memories} 条记忆、${localCounts.characters} 个角色、${localCounts.wbGroups + localCounts.wbSolo} 组世界书。此操作不可撤销。</div>`
        : '';
      return `<label class="imp-mode${usable ? '' : ' imp-empty'}">
        <input type="radio" name="imp-mode" value="${mode.k}"${usable ? '' : ' disabled'}>
        <div class="imp-mode-body">
          <div class="imp-mode-head"><b>${esc(mode.label)}</b><span class="imp-tag">${esc(mode.tag)}</span></div>
          <div class="imp-mode-desc">${mode.desc}${usable ? '' : '<br><i>（' + (mode.wipe && !recoverable ? '这份备份里没有角色、记录、记忆 —— 还原只会把本机清空，所以不能选' : '这份备份里没有这类内容') + '）</i>'}${mode.note ? '<br>' + mode.note : ''}</div>
          ${warn}
        </div>
      </label>`;
    }).join('');

    $('import-modal-title').textContent = '这份备份里有';
    $('import-survey').innerHTML =
      `<div class="imp-grid">
        <span>角色</span><b>${survey.chars}</b>
        <span>聊天记录</span><b>${survey.msgs} 条（含已归档）</b>
        <span>长期记忆</span><b>${survey.mems} 条</b>
        <span>世界书</span><b>${survey.groups} 组 / ${survey.solos} 个单独角色（共 ${survey.wbEntries} 条）</b>
        <span>记账数据</span><b>${survey.kv ? survey.kv + ' 项' : '无（旧版备份）'}</b>
      </div>
      <div class="imp-grid imp-local">
        <span>本机现有</span><b>${localCounts.characters} 个角色 / ${localCounts.messages} 条记录 / ${localCounts.memories} 条记忆</b>
      </div>`;
    $('import-modes').innerHTML = rows;
    $('import-modal').classList.remove('hidden');

    const done = (v) => {
      $('import-modal').classList.add('hidden');
      $('import-ok').onclick = null;
      $('import-cancel').onclick = null;
      resolve(v);
    };
    $('import-ok').onclick = () => {
      const sel = document.querySelector('input[name="imp-mode"]:checked');
      if (!sel) { toast('先选一种导入方式'); return; }
      const mode = IMPORT_MODES.find(x => x.k === sel.value) || null;
      // 再兜一层（radio 上的 disabled 是界面手段，这里是真判据）
      if (mode && mode.wipe && (survey.chars + survey.msgs + survey.mems) === 0) {
        toast('这份备份里没有角色、聊天记录、记忆 —— 还原只会把本机清空，已拦下', 4200);
        return;
      }
      done(mode);
    };
    $('import-cancel').onclick = () => done(null);
  });
}

/**
 * 按模式写入。p = 选中的模式对象。
 * 前置：data 已解析、模式已确认（含模式 1 的二次确认）。
 */
async function applyImport(data, p, file) {
  const want = (name) => p.parts.includes(name);
  // ⚠️ 这几个计数必须声明在【函数顶部】（v1.21.54，审计发现）。
  // 原来 droppedSolo / ghostMems 是写在各自的 try / if 块里的 —— 块级 let 出了块就不可见，
  // 末尾那两段判断 typeof xxx !== 'undefined' 恒为 false，
  // 于是注释里写着「v1.21.32 修：不再静默丢弃」，实际仍然一声不吭。
  let badMsgs = 0;
  let droppedSolo = 0;   // 被范围过滤跳过的 solo 条数
  let ghostMems = 0;     // 角色本机没有、被跳过的记忆条数
  let badWb = 0;         // 写不进去的世界书条目（坏数据，逐条跳过而不是全废）

  // ---- 模式 1：先清空。顺序很重要：先清再写，中途失败至少不会两批混在一起 ----
  if (p.wipe) {
    const stores = [];
    if (want('chars')) stores.push('characters');
    if (want('msgs')) stores.push('messages');
    if (want('mems')) stores.push('memories');
    if (want('wb')) stores.push('wbGroups', 'wbSolo');
    await dbAdmin.clearStores(stores);
    // 记账键单独清：kv 表里还放着 settings（含本机 apiKey），整表清掉要用户重填。
    if (want('kv')) {
      const all = await kv.entries();
      for (const e of all) {
        if (isBackupKey(e.k)) { try { await kv.del(e.k); } catch { /* 单个失败不影响 */ } }
      }
    }
  }

  // ---- 全局设置 ----
  if (want('settings') && data.settings && typeof data.settings === 'object') {
    const incoming = { ...data.settings };
    // ⚠️ 永不覆盖本机 Key（apiKey / searchKey 都算）。
    // v1.21.45：原来只删了 apiKey，导入旧备份会把本机新填的 searchKey 顶回旧值。
    // ⚠️ 用 NO_IMPORT_SETTINGS（含 baseUrl / provider / model），不是 SECRET_SETTINGS ——
    //    理由见那个常量的注释：端点跟着文件走 = 本机 Key 被送去导入方指定的地址。
    for (const k of NO_IMPORT_SETTINGS) delete incoming[k];
    if (!incoming.myAvatar) delete incoming.myAvatar;   // 空头像也别盖
    if (Object.keys(incoming).length) await saveSettings(incoming);
  }

  // ---- 角色 ----
  //
  // 匹配规则（v1.19.11，约定）：
  //   ① id 相同 → 同一个角色，覆盖。（换手机导回来走这条，最准）
  //   ② id 对不上但【名字相同】→ 认领本机那个，把备份内容写进它的 id。
  //      否则同一人在两台设备上分别建过角色，导完会变成两个同名角色。
  //   ③ 都没有 → 新建。
  //
  // ⚠️ 认领之后必须【重映射 charId】：备份里的消息/记忆/世界书指向的是旧 id（bkA），
  //    改写进本机 id（locA）之后，那些数据还挂在旧 id 上 —— 会变成查不到的孤儿。
  //    charIdMap: 备份 id → 本机实际 id
  const charIdMap = new Map();
  const localChars = await chars.all();
  const byId = new Map(localChars.map(c => [c.id, c]));
  const byName = new Map();
  for (const c of localChars) if (c.name) byName.set(String(c.name).trim(), c);

  let claimed = 0;   // 按名字认领了几个（完成提示里要说）
  // 角色写失败几个（v1.21.52）。
  // 原来这三个 put 全是裸调用，任何一次抛错都一路冒到最外层 catch，只弹一句「导入失败」——
  // 而此时本机已经被 clearStores 清空了（完全还原模式），备份也只写进去一半，
  // 双向残缺，用户还不知道断在第几个。现在逐个兜住并计数。
  // ⚠️ 而且改成【写成功才记账】：失败还往 charIdMap 里记，后面的消息就会挂到一个不存在的角色上。
  let charFail = 0;
  if (want('chars')) {
    for (const c of (data.characters || [])) {
      if (!c || !c.id) continue;
      // ⚠️ 备份里 avatar 为空时，【保留本机已有的头像】（2026-09-27 修）。
      // 起因（用户实测）：导入角色文件后头像没了，每次都要重设。
      // 因为 put 是整条覆盖，而外部生成的角色文件（比如手写的设定包）
      // 通常不带头像 —— 一导就把本机设好的抹成 null。
      // 和上面 myAvatar 那条一个道理：空值不覆盖。
      const keepAvatar = (target) => {
        if (c.avatar) return c;                       // 备份里有，用它
        if (target && target.avatar) return { ...c, avatar: target.avatar };  // 备份没有，留本机的
        return c;
      };
      if (byId.has(c.id)) {
        try { await chars.put(keepAvatar(byId.get(c.id))); charIdMap.set(c.id, c.id); }
        catch { charFail++; }
      } else {
        const same = c.name ? byName.get(String(c.name).trim()) : null;
        if (same) {
          // 认领：保留本机 id，内容整个换成备份的
          try {
            await chars.put({ ...keepAvatar(same), id: same.id });
            charIdMap.set(c.id, same.id); claimed++;
          } catch { charFail++; }
        } else {
          try { await chars.put(c); charIdMap.set(c.id, c.id); byId.set(c.id, c); }
          catch { charFail++; }
          if (c.name) byName.set(String(c.name).trim(), c);
        }
      }
    }
  }
  // 没导角色时（模式 4「仅聊天记录」），备份里的 charId 一个都没映射过。
  // 但备份里是带角色的，可以拿"备份角色 id → 备份角色名 → 本机同名角色"补一层映射，
  // 否则同一台设备上改过角色 id 的话，记录会全部因为"角色不存在"被跳过。
  // ⚠️ v1.21.54（审计发现）：这里原来是一段【手写的简化映射】，只扫 data.characters。
  //
  // 起因：「世界书」页导出的文件是 {kind:'worldbook', charNames:[…], groups, solo} —— 没有 characters。
  // 于是从「设置 → 导入数据」这条路进来时 charIdMap 是空的，solo 按【旧 id】落库，
  // 组的 members 也全是旧 id：这些条目对本机任何角色都不生效，
  // 而且【下次启动】sweepWbOrphans() 会把 charId 不存在的 solo 当孤儿整条删掉 ——
  // 用户看到「导入完成」，重开 App 后一条世界书都没有了。
  // 同一个文件从「世界书」页导入却是好的：那条路走的是 buildCharIdMapFrom（认 charNames）。
  // 两条入口同一份数据、两套逻辑 —— 现在统一走 buildCharIdMapFrom。
  if (!want('chars')) {
    try {
      const { map } = await buildCharIdMapFrom(data);
      for (const [k, v] of map) if (!charIdMap.has(k)) charIdMap.set(k, v);
    } catch (e) {
      // 映射算不出来不该中断导入：按原样写进去，条目还有机会被孤儿自检找回来
      console.error('[导入] 角色 id 映射失败，按原 id 写入', e);
    }
  }
  // ⚠️ solo 里的 charId 也要纳入候选（v1.21.27 修，复审 新5）。
  //
  // 起因：上面两层映射都依赖 data.characters。但「仅世界书」导出的备份、
  // 或手写世界书文件，可能是【有 solo 但没有 characters 条目】的 ——
  // 这时 remap 原样返回旧 id，wb.solo(旧id) 查不到 → old=null → 用外来主键 put
  // → 本机同名角色的设定【不被更新】，表现是「提示导入了但没生效」。
  //
  // 世界书页那条独立导入路径用的是 buildCharIdMapFrom（会扫 solo[].charId）。
  //
  // ⚠️ 诚实说明（v1.21.28，复审 新4_）：这段的实际覆盖范围有限 ——
  // 下面 find(c => c.id === s.charId) 仍然要求 characters 里有该 id，
  // 而那种情况上面的循环【早已处理过】。所以对「完全没有 characters 条目」的备份，
  // 这里【依然认领不了】。要真正覆盖那个场景，得按 solo 自带的名字/触发词去匹配本机角色 ——
  // 那需要先确认世界书条目里是否稳定地带着角色名，暂不做（避免猜错反而改错数据）。
  // 现阶段：保持保守行为（认不到就原样写入，不覆盖本机同名角色的设定）。
  if (data.solo && Array.isArray(data.solo)) {
    for (const s of data.solo) {
      if (!s || !s.charId) continue;
      if (charIdMap.has(s.charId)) continue;
      if (byId.has(s.charId)) continue;                 // 本机就有这个 id
      // 没有 characters 条目可依据时，退一步看有没有名字 —— 没有就保持原样
      const ghost = (data.characters || []).find(c => c && c.id === s.charId);
      if (ghost && ghost.name) {
        const same = byName.get(String(ghost.name).trim());
        if (same && same.id !== s.charId) charIdMap.set(s.charId, same.id);
      }
    }
  }
  /** 把备份里的 charId 翻成本机实际 id；没映射过就原样返回 */
  const remap = (id) => (charIdMap.has(id) ? charIdMap.get(id) : id);

  // ---- 世界书（组 + 单独角色一起，两层本来就是一套）----
  if (want('wb')) {
    try {
      // 同上：复数 worldsbook 是早期格式，也要认
  const wbData = data.worldbook || data.worldsbook || (data.groups || data.solo ? data : null);
      if (wbData) {
        // ⚠️ 「仅角色 / 设置与角色」带世界书，是有【范围】的 —— 只带【本次导入的角色】的。
        //    全量备份走「仅角色」时，如果无差别地写入所有条目，
        //    用户以为只换了角色参数，实际上所有人的世界书都被覆盖了。
        //    角色在 data.characters 里出现过 → 它的条目才跟着来。
        const touched = new Set();
        for (const c of (data.characters || [])) {
          if (c && c.id) touched.add(remap(c.id));
        }
        // ⚠️ v1.21.54（审计发现）：组和单独角色以前共用一个 try，而且这里是
        //    (g.members || []).map(remap) —— 外来的 members 只要不是数组（字符串/数字/null）
        //    就会抛，抛点又在 solo 循环【之前】：于是一份文件里的 solo 一条都写不进去。
        //    对「完全还原」来说本机世界书早被清空，等于世界书净损失，
        //    而外层 catch 里连 console 都没有，用户只看到「导入完成」。
        //    现在：逐条 try，坏的那条只跳过它自己，并计数上报。
        for (const g of (Array.isArray(wbData.groups) ? wbData.groups : [])) {
          if (!g || !g.id) continue;
          const members = Array.isArray(g.members) ? g.members.map(remap) : [];
          // 「仅角色」不带角色组（组是全局设定，属于 settings 那一层）；
          // 只有「完全还原」和「仅世界书」才动组。
          if (!want('settings') && !p.wbOnlyGroups) continue;
          try {
            // entries 也顺手净化：不是数组、或混着 null，会让条目页 entries.map 直接抛
            await wb.putGroup({ ...g, members, entries: Array.isArray(g.entries) ? g.entries.filter(x => x && typeof x === 'object') : [] });
          } catch (e2) { badWb++; console.error('[导入] 这个角色组写不进去，已跳过：', g.id, e2); }
        }
        for (const s of (wbData.solo || [])) {
          if (!s || !s.charId) continue;
          const nid = remap(s.charId);
          // 带角色时只导这些角色的条目；纯「仅世界书」模式则全导
          // ⚠️ 判据用【wipe】而不是模式名（v1.21.32 修，复审 #2）。
          //
          // 起因：'all'（完全还原）的 parts 里没有 wbAll → 走 touched 过滤，
          // 而 touched 只装 data.characters 里出现过的 id ——
          // 【不在里面的 solo 整条被 continue 丢弃】，且 toast 不报。
          // 实测：文件含 characters=[甲]、solo=[甲,丙] → 丙被静默丢掉。
          // 用户真实备份：solo 21 条里那条 charId=mu1di16jq12tqq1（已删角色的）会被丢。
          //
          // 语义上：完全还原是【清空后全量导入】，本来就该全导，不该做范围过滤。
          const scoped = !p.wipe && !p.wbAll;
          if (scoped && touched.size && !touched.has(nid)) { droppedSolo++; continue; }
          // 逐条 try（v1.21.54）：一条坏数据不该让后面的条目全部落空
          try { await putSoloClaimed(nid, s); }
          catch (e2) { badWb++; console.error('[导入] 这一条单独设定写不进去，已跳过：', s.charId, e2); }
        }
      }
    } catch (e) {
      // ⚠️ 这里【不能】再是空的（v1.21.54，审计发现）：以前 catch 里连 console 都没有，
      // 世界书整段失败时用户只看到「导入完成」，而「完全还原」模式下本机那份已经被清掉了。
      console.error('[导入] 世界书这一整段失败了', e);
      badWb++;
    }
  }

  // ---- 聊天记录 ----
  // ⚠️ 模式 4 只导已存在角色的记录：消息靠 [charId, ts] 索引查，
  //    角色不在角色表里就永远读不出来（数据进库了却看不见，纯占空间）。
  let skippedChars = 0;
  // ⚠️ live 必须在【两个块之外】（v1.21.32 修）。
  // 起因：我第一版把它留在 if (want('msgs')) 里，而下面 if (want('mems')) 也要用它 ——
  // 块级作用域访问不到 → 记忆导入那条路整个失效（e2e-importmode / e2e-memimport 同时挂）。
  const live = new Set((await chars.all()).map(c => c.id));
  if (want('msgs')) {
    for (const rawCid of Object.keys(data.messages || {})) {
      const cid = remap(rawCid);   // 认领过的角色，消息要落到本机 id 上
      if (!live.has(cid)) { skippedChars++; continue; }
      const arr = data.messages[rawCid];
      if (!Array.isArray(arr)) { badMsgs++; continue; }
      for (const m of arr) {
        if (!m || typeof m !== 'object') { badMsgs++; continue; }
        const rec = { ...m };
        if (!rec.charId) rec.charId = cid;
        else rec.charId = remap(rec.charId);
        if (!rec.id) rec.id = uid();
        if (typeof rec.ts !== 'number' || !isFinite(rec.ts)) rec.ts = Date.now();
        if (!Array.isArray(rec.images)) rec.images = [];
        if (!Array.isArray(rec.imageNotes)) rec.imageNotes = [];
        try { await msgs.add(rec); } catch { badMsgs++; }
      }
    }
  }

  // ---- 记忆 ----
  if (want('mems')) {
    const memList = Array.isArray(data.memories)
      ? data.memories
      : (data.memories && typeof data.memories === 'object')
        ? Object.keys(data.memories).flatMap(cid =>
            (Array.isArray(data.memories[cid]) ? data.memories[cid] : []).map(m => ({ ...m, charId: (m && m.charId) || cid })))
        : [];
    // ⚠️ 和 msgs 一样做 live 校验，别写孤儿记忆（v1.21.32 修，复审 #9）。
    //
    // 起因：消息那边有 `if (!live.has(cid)) { skippedChars++; continue; }`，
    // 而记忆这边没有 —— 导入「只有 messages+memories、没有 characters」的备份时，
    // 记忆被写进库、charId 是个不存在的角色 → 【孤儿记忆】：读不到也回收不了。
    // （报告实测：消息【没有】进库，只有记忆进了 —— 上轮"消息写孤儿"的描述不成立。）
    // ⚠️ ghostMems 的声明已挪到函数顶部（v1.21.54）：写在这里的话，出了这个块就看不见，
    //    末尾那句 typeof ghostMems !== 'undefined' 恒为 false —— 「跳过了 N 条记忆」
    //    永远弹不出来，注释承诺的「不再静默丢弃」等于没做。
    for (const m of memList) {
      if (!m || typeof m !== 'object' || !m.text) continue;
      const _cid = remap(m.charId || '');
      // ⚠️ 空 charId 也要拦（v1.21.36 修，复审 #2 —— 连续 2 轮未修）。
      //
      // 起因：`remap('')` 原样返回 ''，而 '' 是 falsy → `_cid &&` 直接短路 →
      // 【不检查就进库】→ charId='' 的孤儿记忆，mem.list() 永远查不到、删角色也清不掉。
      // 对照：消息侧写的是 `if (!live.has(cid))`，没有这个短路。
      if (!_cid || !live.has(_cid)) { ghostMems++; continue; }
      try {
        // ⚠️ 【白名单式重建】，少写一个字段就丢了。
        // mine 尤其要紧：丢了之后你自己写的记忆会失去「自定义」标记，
        // 保护开关就再也护不住它们（会被当成她记的一起交给模型改写/删除）。
        await mem.add({ id: m.id || uid(), charId: _cid, text: String(m.text),
                        kind: m.kind === 'event' ? 'event' : 'fact',
                        untilDay: typeof m.untilDay === 'number' ? m.untilDay : null,
                        // ⚠️ 白名单式重建，少写一个字段就永久丢掉（v1.21.25 修，复审 ★4）。
                        // 注释上面自己就写着这句话，却漏了这两个。
                        untilHour: typeof m.untilHour === 'number' ? m.untilHour : null,
                        untilMinute: typeof m.untilMinute === 'number' ? m.untilMinute : 0,
                        mine: !!m.mine,
                        freq: MEM_FREQ.has(m.freq) ? m.freq : 'normal',
                        ts: typeof m.ts === 'number' ? m.ts : Date.now() });
      } catch { /* 单条坏掉不影响整体 */ }
    }
  }

  // ---- 记账 / 情景状态 ----
  let kvN = 0;
  if (want('kv') && Array.isArray(data.kv) && data.kv.length) {
    // ⚠️ 键名里嵌着 charId，必须跟着 remap（2026-09-29 自查发现）。
    //
    // 起因：这些键长这样 —— clock:<charId> / greeted:<charId> / memSummed:<charId>。
    // 单独角色导入时角色会被认领成新 id（见上面 remap 的说明），
    // 而这里原来是把备份里的键【原样】写回去 ——
    // 于是键指向一个本机根本不存在的旧 id：
    //   · 时间/开场白标记/记忆记账全部丢失（读的是新 id）
    //   · 旧 id 的键永远回收不了（删角色只按新 id 清）
    // clock:<id>:real 同理，多一段后缀也要一起翻。
    const pairs = data.kv.filter(e => e && isBackupKey(e.k)).map(e => {
      const k = String(e.k);
      const i = k.indexOf(':');
      if (i < 0) return e;
      const prefix = k.slice(0, i + 1);
      const rest = k.slice(i + 1);
      // rest 形态：<oldId>  或  <oldId>:real
      const j = rest.indexOf(':');
      const oldId = j < 0 ? rest : rest.slice(0, j);
      const suffix = j < 0 ? '' : rest.slice(j);
      const nid = remap(oldId);
      if (nid === oldId) return e;
      return { ...e, k: prefix + nid + suffix };
    });
    kvN = await kv.setMany(pairs);
  }

  // ---- 记账对齐（只在导入过聊天记录时做；没导记录就别动本机的账）----
  if (want('msgs')) {
    // 导入的对话要反映到累计序号上，否则节奏从头开始算，
    // 要再聊满一整个间隔才会首次总结（期间归档区有内容却毫无动作）。
    //
    // ⚠️ memSummed（"哪些已经总结过"）也要一起补上：备份里的记忆本来就是
    //    从这些对话总结出来的，不补的话导入后第一次总结会把整段历史重嚼一遍
    //    （白花 token + 记忆里出现重复条目）。
    for (const c of await chars.all()) {
      try {
        const all = await msgs.list(c.id, 0, true);
        const n = all.length;
        const cur = (await kv.get('msgSeq:' + c.id, 0)) || 0;
        if (n > cur) await kv.set('msgSeq:' + c.id, n);
        const acc = new Set(await kv.get('memSummed:' + c.id, []) || []);
        const beforeN = acc.size;
        for (const m of all) acc.add(m.id);
        if (acc.size !== beforeN) await kv.set('memSummed:' + c.id, [...acc]);
        // 节奏水位也对齐，免得刚导入就立刻触发一次总结
        await kv.set('memSumAt:' + c.id, n);
        // 这里必须写记忆条数，不是消息条数（v1.21.25 修）。
        // 上一版写的是 n（消息数，可能几百），而读取侧当记忆条数用，
        // 又一个量纲错：导入完自动查重就再也不触发了。
        await kv.set('memDedupeAt:' + c.id, (await mem.list(c.id)).length);
      } catch { /* 单条失败不影响整体导入 */ }
    }
  }

  await loadChars();
  renderCharList();
  if (curCharId && !(await chars.get(curCharId))) {
    // 完全还原后原来那个角色可能没了，退回角色列表，别停在空白聊天页
    curCharId = null; curChar = null;
    showView('chars');
  } else if (curCharId) {
    curChar = await chars.get(curCharId);
    await renderMessages();
  }

  const bits = [];
  if (badMsgs) bits.push(`${badMsgs} 条记录格式不对，已跳过`);
  if (skippedChars) bits.push(`${skippedChars} 个角色的记录本机没有对应角色，已跳过`);
  if (claimed) bits.push(`${claimed} 个同名角色已合并到本机角色上`);
  if (charFail) bits.push(`${charFail} 个角色没写进去（多半是存储空间不够）`);
  // 接口地址 / Key 这类本机配置不从备份采纳（见 NO_IMPORT_SETTINGS），
  // 不说一声的话，换机的人会以为端点也跟着回来了。
  if (want('settings')) bits.push('接口地址和 Key 按本机的来（备份里那份不采纳）');
  // ⚠️ 被范围跳过的 solo 要如实报（v1.21.32 修，复审 #2）——
  // 以前静默丢弃，用户以为"导入完成"就万事大吉。
  // ⚠️ 现在这几个计数真的在函数顶部（v1.21.54），这两段终于会执行了；
  //    typeof 检查保留着也无害（防的是老版本遗留的写法）。
  if (typeof ghostMems !== 'undefined' && ghostMems) {
    bits.push(`${ghostMems} 条记忆的角色本机没有，已跳过`);
  }
  // 坏数据被逐条跳过的也要说（v1.21.54）——以前这种情况要么静默、要么整段世界书消失
  if (typeof badWb !== 'undefined' && badWb) {
    bits.push(`${badWb} 条世界书内容格式不对，已跳过`);
  }
  if (typeof droppedSolo !== 'undefined' && droppedSolo) {
    bits.push(`${droppedSolo} 条世界书条目的角色本机没有，已跳过`);
  }
  if (kvN) bits.push(`记账 ${kvN} 项`);
  toast(bits.length ? `导入完成（${bits.join('；')}）` : '导入完成', bits.length ? 4500 : 2200);
}

async function importData(file, mode) {
  const txt = await file.text();
  const data = JSON.parse(txt);
  // ⚠️ 同上放宽（v1.21.28，复审 新8_）——世界书导出的文件没有 characters。
  if (!data.characters && !data.groups && !data.solo && !data.messages) throw new Error('文件格式不对');
  if (!mode) throw new Error('没有选择导入方式');

  const survey = surveyBackup(data);
  const localCounts = await dbAdmin.counts();

  // 模式 1 的二次确认：不可逆，必须让用户看清要删多少
  if (mode.wipe) {
    const ok = await confirmBox(
      '完全还原会先删掉本机数据',
      `<p>即将<b>永久删除</b>本机：</p>` +
      `<p>· ${localCounts.characters} 个角色<br>· ${localCounts.messages} 条聊天记录<br>` +
      `· ${localCounts.memories} 条长期记忆<br>· ${localCounts.wbGroups} 组 + ${localCounts.wbSolo} 个单独世界书</p>` +
      `<p>然后换成这份备份里的 ${survey.chars} 个角色 / ${survey.msgs} 条记录 / ${survey.mems} 条记忆。</p>` +
      `<p><b>无法撤销。</b>确定要继续吗？</p>`,
      '删除并导入'
    );
    if (!ok) { toast('已取消'); return; }
  }

  await applyImport(data, mode, file);
}

// ================= 事件绑定 =================
/**
 * 滑杆防误触（v1.21.31）。
 *
 * 起因（反馈）：「对于『对话参数』里的那些进度条设置会经常误触」——
 * 在设置页上下滚动时，手指落到 range 上就会被浏览器当成拖动，值被改掉。
 *
 * 做法：touchstart 记起点；touchmove 判断主方向 ——
 *   · 垂直为主（|dy| > |dx|）→ 给这个滑杆加 .no-drag（pointer-events:none），页面照常滚
 *   · 水平为主 → 正常拖动改值
 * touchend 时清掉标记，下次进来自会重判。
 *
 * 为什么不用 preventDefault：那会连页面滚动一起吃掉，反而更糟。
 * 为什么用 pointer-events 而不是 disabled：disabled 会让 :active 之类样式失效，
 * 而且用户真去拖它时要能立刻恢复 —— 单靠 CSS 类更容易撤。
 */
function bindRangeGuard() {
  // ⚠️ 第二版（v1.21.32 修，复审 #5）。第一版【根本没防住】，记录在此：
  //
  // 第一版只在【touchmove 判定为竖向】时才加 .no-drag —— 但那是【事后】的：
  //   range 滑杆在 `touchstart`（手指刚落下）那一刻就按落点改值了，这是浏览器原生行为。
  // 实测（CDP 派发真实触摸）：起始 1 → 仅 touchstart 后 = 1.65 → 点保存落库 1.65。
  // 而我当时的测试用 dispatchEvent(TouchEvent) 【合成事件】验证 —— 合成事件复现不出原生行为，
  // 于是我得到了"值没被改"的假通过。**合成事件 ≠ 真实触摸**，这是第四次同类假通过。
  //
  // 现在：touchstart 先【记原值】，判定为竖向滑动后【回滚并派发 input】。
  // 同时把 mouse/pointer 路径也纳入（桌面端拖滑杆同样不该被误触）。
  let sx = 0, sy = 0, locked = null, decided = false, preVal = null;
  const RANGES = 'input[type="range"]';
  const mark = (e) => {
    const el = e.target && e.target.closest ? e.target.closest(RANGES) : null;
    if (!el) { locked = null; return; }
    const p = e.touches ? e.touches[0] : e;
    sx = p.clientX; sy = p.clientY;
    locked = el; decided = false;
    preVal = el.value;              // ← 关键：原生改值【之前】先记下来
  };
  const judge = (e) => {
    if (!locked || decided) return;
    const p = e.touches ? e.touches[0] : e;
    const dx = Math.abs(p.clientX - sx);
    const dy = Math.abs(p.clientY - sy);
    if (dx < 6 && dy < 6) return;   // 手指刚落下的抖动，先不判
    decided = true;
    if (dy > dx) {
      // 竖着滑 = 想滚页面 → 锁住它，并把【已经被原生改掉的值】还原回去
      locked.classList.add('no-drag');
      if (preVal !== null && locked.value !== preVal) {
        locked.value = preVal;
        locked.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
  };
  const clear = () => {
    if (locked) locked.classList.remove('no-drag');
    locked = null; decided = false; preVal = null;
  };
  document.addEventListener('touchstart', mark, { passive: true });
  document.addEventListener('touchmove', judge, { passive: true });
  document.addEventListener('touchend', clear, { passive: true });
  document.addEventListener('touchcancel', clear, { passive: true });
  // 桌面/鼠标路径：拖滑杆本身是正常操作，不拦；这里只保证手势结束时清状态。
  document.addEventListener('mousedown', mark, { passive: true });
  document.addEventListener('mousemove', (e) => { if (e.buttons) judge(e); }, { passive: true });
  document.addEventListener('mouseup', clear, { passive: true });
}

function bindEvents() {
  bindRangeGuard();
  $('btn-chars').onclick = () => { renderCharList(); showView('chars'); };

  // 聊天栏点她的头像/名字 → 直接进她的编辑页（不用绕「角色列表」）
  const openCurCharEdit = () => {
    if (!curCharId) { toast('还没选角色'); return; }
    openCharEdit(curCharId);
  };
  $('chat-avatar').onclick = openCurCharEdit;
  $('chat-titletxt').onclick = openCurCharEdit;
  $('btn-chars-back').onclick = goBack;
  $('btn-new-char').onclick = () => openPresetPicker();
  $('btn-new-char2').onclick = () => openPresetPicker();
  $('btn-preset-back').onclick = () => { renderCharList(); goBack(); };
  $('btn-about-back').onclick = () => goBack();
  $('btn-about-copy').onclick = async () => {
    try { await navigator.clipboard.writeText(REPO_URL); toast('地址已复制'); }
    catch { toast('复制不了，长按上面那行手动选吧'); }
  };
  $('btn-edit-back').onclick = goBack;
  $('btn-edit-save').onclick = async () => {
    // 直接挂 saveCharEdit 的话，中途抛错（配额满、写入失败）会变成未处理的
    // rejection：界面卡在编辑页、也没有任何提示，用户只会以为是自己没点上。
    try { await saveCharEdit(); }
    catch (err) { toast('保存失败：' + ((err && err.message) || err), 4200); }
  };
  // 右上角 ⚙ → 拉开右侧抽屉（不再是整页设置）。
  // 旧设置页保留，从抽屉的「全部设置」进 —— 老用户习惯不变，e2e 也不会挂。
  $('btn-settings').onclick = () => openDrawer();

  // 引导条：点一下直接进设置，并滚到 / 聚焦到 API Key 输入框（v1.21.40）。
  // 那次 setTimeout 是必须的 —— 抽屉有 .34s 的滑出动画（见 style.css 的 .view），
  // 立刻 scrollIntoView 算的还是旧布局，会滚不到位。
  $('setup-banner').onclick = () => {
    openDrawer();
    setTimeout(() => {
      const el = $('s-apikey');
      if (!el) return;
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.focus();
    }, 400);
  };
  $('btn-set-back').onclick = () => { applyTheme(); updateStatus(); goBack(); };
  $('btn-mine-back').onclick = () => { applyTheme(); updateStatus(); goBack(); };
  bindWorldbook();

  // 「导出当前角色的对话（Markdown）」（v1.21.48）。
  // 用 ?. 是故意的：这个按钮在设置页里，而 bindEvents 里也有一段要跑 ——
  // 万一以后有人把按钮挪走，这里不该连带把后面的绑定全炸掉。
  $('btn-export-md') && ($('btn-export-md').onclick = exportChatMarkdown);

  $('btn-send').onclick = () => send();
  // 「续写」（v1.21.48）：你不打字，她也接着往下写。
  // ⚠️ 必须传 {cont:true}，不能直接 send —— 不带参数的 send 会去读输入框，
  //    空的时候第一行就 return 了，按钮看起来就是坏的。
  $('btn-continue').onclick = () => send({ cont: true });
  $('btn-stop').onclick = () => abortCtl && abortCtl.abort();

  $('input').addEventListener('input', () => syncInput());
  $('input').addEventListener('keydown', e => {
    if (e.isComposing || e.keyCode === 229) return;   // 输入法选词中，回车是在选候选词
    if (e.key !== 'Enter' && e.key !== 'Return') return;
    if (e.shiftKey) return;          // Shift+Enter 什么时候都换行，老习惯不变
    // 「回车换行」这一档（v1.21.48）：什么都不做、也不 preventDefault，
    // 让浏览器自己插换行。安卓上没有 Ctrl，所以这一档只能靠【发送】按钮发。
    if (S.enterSend === false) return;
    e.preventDefault();
    send();
  });

  // 图片
  $('btn-image').onclick = () => {
    const f = document.createElement('input');
    f.type = 'file'; f.accept = 'image/*'; f.multiple = true;
    f.onchange = async () => {
      if (_pickingImages) { toast('上一批图片还在处理，稍等一下'); return; }
      _pickingImages = true;
      try {
        // 先攒在局部数组里，读完再一次性并入。
        // 直接往 pendingImages 里 push 的话：压缩到一半时点发送，send() 会把
        // pendingImages 整个换成新数组，后面几张图就 push 进了"下一批"——
        // 既不跟着这条消息发出去，又赖在输入框附件区。
        const imgs = [], notes = [];
        for (const file of f.files) {
          const raw = await fileToDataUrl(file);
          const small = await compressImage(raw, 1024, 0.8);
          imgs.push(small); notes.push('');
        }
        pendingImages.push(...imgs);
        pendingNotes.push(...notes);
        renderAttachPreview();
      } catch (err) {
        toast('图片处理失败：' + ((err && err.message) || err));
      } finally {
        _pickingImages = false;
      }
    };
    f.click();
  };

  // 角色编辑：滑块实时显示数值
  $('e-temp').oninput = e => { $('e-v-temp').textContent = String(Number(Number(e.target.value).toFixed(2))); };
  $('e-maxtok').oninput = e => { $('e-v-maxtok').textContent = e.target.value; };
  $('e-ctx').oninput = e => { $('e-v-ctx').textContent = e.target.value; };
  $('e-delay').oninput = e => { $('e-v-delay').textContent = Number(e.target.value).toFixed(1) + 'x'; };

  // 角色编辑：头像
  $('btn-pick-avatar').onclick = () => $('e-avatar-file').click();
  $('e-avatar-file').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';                    // 允许再次选同一张
    if (!file) return;
    try {
      const raw = await fileToDataUrl(file);
      const big = await compressImage(raw, 1600, 0.95);   // 先压一下再进裁剪器，避免卡顿
      openCropper(big);
    } catch (err) {
      toast('图片读取失败：' + err.message);
    }
  };

  // 角色编辑：外貌
  $('e-look').oninput = refreshLookCount;

  /**
   * 把外貌【立刻】存进角色，不等右上角 ✓。
   *
   * ⚠️ 外貌分两层，别混：
   *   · appearance     —— 长期基线。由右上角 ✓（saveCharEdit）写入。
   *   · appearanceLive —— 临时覆盖。由「立即生效」写入，优先级更高。
   * 注入时 Live 有值就用 Live，没有才用 appearance。
   *
   * 这样「清除」才能做到"丢掉临时覆盖、回落到上次保存的样子"，
   * 而不是把用户辛苦打的字也一起抹了。
   */
  const saveLookNow = async () => {
    if (!editingId) { toast('先保存角色，外貌才有归属'); return false; }
    const c = await chars.get(editingId);
    if (!c) { toast('角色不存在了'); return false; }
    await chars.put({ ...c, appearanceLive: $('e-look').value, appearanceOn: $('e-look-on').checked });
    await loadChars();
    if (curCharId === editingId) curChar = allChars.find(x => x.id === editingId) || curChar;
    return true;
  };

  // 「立即生效」：存 + 立刻生效。框里是空的也照存 —— 等于告诉她"没有额外状态"。
  $('e-look-apply').onclick = async () => {
    const btn = $('e-look-apply');
    btn.disabled = true;
    try {
      if (!(await saveLookNow())) return;
      refreshLookCount();
      const n = ($('e-look').value || '').trim().length;
      toast(n ? ('已生效（' + n + ' 字），下一句她就按这个来') : '已生效：当前没有额外状态', 2600);
    } catch (err) {
      toast('保存失败：' + ((err && err.message) || err));
    } finally { btn.disabled = false; }
  };

  // 「清除」：撤掉「立即生效」那份临时覆盖，回落到上次「保存」的样子。
  // 文本框也跟着还原 —— 不再一刀切清空，用户写的字不会白丢。
  $('e-look-clearlive').onclick = async () => {
    if (!editingId) { toast('先保存角色，外貌才有归属'); return; }
    const c = await chars.get(editingId);
    if (!c) { toast('角色不存在了'); return; }
    const live = (c.appearanceLive || '').trim();
    if (!live) { toast('没有需要清除的临时外貌'); return; }
    const ok = await confirmBox('清除临时外貌',
      '<p>撤掉「立即生效」的那份，回到你上次<b>点右上角 ✓ 保存</b>的样子。</p>'
      + '<p>文本框会还原成那一刻的内容，<b>你写的字不会丢</b>。</p>', '清除');
    if (!ok) return;
    try {
      const kept = (k, d) => (k || d);
      await chars.put({ ...c, appearanceLive: '', appearanceOn: $('e-look-on').checked });
      await loadChars();
      if (curCharId === editingId) curChar = allChars.find(x => x.id === editingId) || curChar;
      // 文本框还原成长期基线
      $('e-look').value = kept(c.appearance, '');
      refreshLookCount();
      toast(kept(c.appearance, '') ? '已清除，回到上次保存的样子' : '已清除，她不再有当前外貌设定');
    } catch (err) {
      toast('清除失败：' + ((err && err.message) || err));
    }
  };

  $('e-look-img').onclick = () => $('e-look-file').click();
  $('e-look-file').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';                 // 允许再次选同一张
    if (!file) return;
    const btn = $('e-look-img');
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = '识别中…';
    try {
      const raw = await fileToDataUrl(file);
      const small = await compressImage(raw, 1024, 0.85);   // 压一下再发，省流量也省 token
      const text = await describeAppearance(small);
      if (!text) { toast('没识别出内容，换一张试试'); return; }
      appendLook(text);
      toast('已加到框里，确认后点「立即生效」', 3000);
    } catch (err) {
      toast('识别失败：' + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  };

  // 裁剪器按钮
  $('btn-crop-cancel').onclick = () => {
    cropImg = null;
    goBack();
  };
  $('btn-crop-ok').onclick = async () => {
    try {
      const dataUrl = getCroppedDataUrl();
      cropImg = null;
      if (cropTarget === 'me') {
        await saveSettings({ myAvatar: dataUrl });
        renderMyAvatar();
        goBack();
        await renderMessagesIfIdle();   // 纯视觉改动，不值得为它清掉正在打字的气泡
        toast('你的头像已更新');
      } else {
        editingAvatar = dataUrl;
        $('e-avatar-prev').innerHTML = `<img src="${esc(editingAvatar)}" style="width:100%;height:100%;object-fit:cover">`;
        goBack();
        toast('头像已更新，记得点右上角 ✓ 保存');
      }
    } catch (err) {
      toast('裁剪失败：' + err.message);
    }
  };
  bindCropDrag();
  bindClockEditor();

  // 我的头像
  $('btn-pick-my-avatar').onclick = () => $('my-avatar-file').click();
  $('my-avatar-file').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const raw = await fileToDataUrl(file);
      const big = await compressImage(raw, 1600, 0.95);
      openCropper(big, 'me');
    } catch (err) {
      toast('图片读取失败：' + err.message);
    }
  };
  $('btn-clear-my-avatar').onclick = async () => {
    await saveSettings({ myAvatar: null });
    renderMyAvatar();
    await renderMessagesIfIdle();   // 同上，纯视觉
    toast('已恢复默认头像');
  };

  // 删除角色
  $('btn-del-char').onclick = async () => {
    if (!editingId) return;
    // ⚠️ 生成中不许删角色（v1.21.52）：在途请求不会因为角色被删就停下，
    // 它走到 AbortError 分支时照样把半截回复落库，而 charId 用的是【发送时冻结的】那个
    //（也就是刚被删掉的）角色 —— 留下一条看不见、导不出、删不掉的孤儿消息，
    // 带图的话能占几 MB，永久趴在 IndexedDB 里。
    if (busy) { toast('她还在打字，先按停止再删角色', 2600); return; }
    // 删除范围（v1.21.59 起）：角色本体 + 聊天记录（含归档的）+ 长期记忆 + 世界书里的成员身份和单独条目。
    // 以前记忆是特意留着的（注释还写着"记忆是全局共用的"，那句是错的），
    // 结果是删完角色，她的记忆留下当孤儿。现在一并清掉，只清她自己那份。
    // ⚠️ 这条不可恢复，所以文案要说明白删的是什么。
    if (!confirm('删除这个角色？\n\n她的聊天记录和长期记忆会一起删除，无法恢复。\n（别的角色不受影响）')) return;
    // ⚠️ 世界书也要一起清（v1.21.24 修，审计第 4 条）。
    //
    // 起因：db.js 里 wb.purgeChar() 实现完整、e2e-worldbook 也覆盖了，
    // 但【全项目零调用】—— 属于"函数写好了、接线忘了"。
    // 后果：角色组的 members 永久留着不存在的 charId（组列表显示"3 人"却只列 2 个），
    // wbSolo 整条残留成永远回收不了的孤儿数据。
    try { await wb.purgeChar(editingId); } catch { /* 清不掉也不影响删除本身 */ }
    await chars.del(editingId);
    // 把所有「按角色 id 存」的键都清掉。id 是 uid() 生成的、不会复用，
    // 漏清就会变成永远回收不了的孤儿键（原来只清了 clock:）。
    // memRolling: 同理 —— 漏了它会留下永远回收不了的孤儿键（占着 IndexedDB 不释放）。
    // ⚠️ 【根治】不再靠人工维护前缀表（v1.21.36 修，复审 新A1 —— 第 4 次复发）。
    //
    // 历史（这个位置被改过三次，每次都是"新加键忘了加进清单"）：
    //   · v1.21.24 硬编码 10 个前缀，漏了 memArchiveLastAt:
    //   · v1.21.32 改成从 BACKUP_KV_PREFIXES 派生
    //   · v1.21.35 新增 memZeroRetry:/memQueueLen: 时加进去了，注释还写"漏了会留孤儿"
    //     —— 却漏了【同一批新增】的 memNeedTidy:（本轮新A1）
    //
    // 只要清单要人维护，就一定会再漏。改成扫库：任何以 ':<角色id>' 结尾的键都清掉。
    // 天然覆盖未来新增的键，也不会误删（角色 id 是 uid()，永不复用）。
    try {
      const allKv = await kv.entries();
      for (const e of allKv) {
        if (String(e.k || '').endsWith(':' + editingId) || String(e.k || '').endsWith(':' + editingId + ':real')) {
          try { await kv.del(e.k); } catch { /* 单条清不掉不影响整体 */ }
        }
      }
    } catch { /* 扫库失败就退回按清单清，保证不崩 */
      for (const k of [...BACKUP_KV_PREFIXES, 'memTidyBackup:']) {
        try { await kv.del(k + editingId); } catch { /* 清不掉也不影响删除 */ }
      }
    }
    // ⚠️ clock:<id>:real 是【另一个键】（现实时间模式的存档位，v1.20.21 新增），
    // 上面的 'clock:' + id 匹配不到它 —— 漏了它会留下永远回收不了的孤儿键。
    try { await kv.del('clock:' + editingId + ':real'); } catch { /* 同上 */ }
    await loadChars();
    if (!allChars.length) { await showEmptyChat(); }
    // 删掉的如果不是正在聊的那个角色，就别动当前会话 —— 原来一律跳回
    // allChars[0]，还会顺手改写 lastCharId，下次启动就回到别人那儿了。
    else if (allChars.some(c => c.id === curCharId)) await selectChar(curCharId);
    else await selectChar(allChars[0].id);
    renderCharList();
    resetTo('chat');
    toast('已删除');
  };

  // 折叠面板：设置页里这几块都收起来，点开才展开
  const fold = (headId, wrapId, onOpen) => {
    const head = $(headId), wrap = $(wrapId);
    if (!head || !wrap) return;
    head.onclick = async () => {
      const open = wrap.classList.toggle('open');
      head.classList.toggle('open', open);
      if (open && onOpen) await onOpen();
    };
  };
  fold('mem-set-fold', 'mem-set-wrap', refreshMemOverflow);   // 记忆节奏（全局参数）
  fold('arch-fold', 'arch-wrap', renderArchiveHint);   // 归档旧对话

  // 联网搜索折叠头的角标：一眼看出开没开
  function refreshSearchHint() {
    const el = $('search-hint');
    if (!el) return;
    el.textContent = (S.searchOn === false) ? '已关闭' : (S.searchKey ? '已启用' : '缺 key');
  }
  refreshSearchHint();

  // ================= 重新提炼长期记忆 ==================
  // 治的是 v1.20.20 之前那个 bug：parseMemJson 解析失败时静默返回 []，
  // summarizeChunk 把它当成"模型说没有新的"，于是【照常把整批 id 推进 memSummed】——
  // 那些对话从此被判定"看过了"，永远不再提炼，内容永久丢失。
  //
  // 实测（2026-09-29 用户真实备份）：角色Q 195 条对话只剩 1 条记忆，
  // memSummed 里却记着 151 个 id；全库 2291 条消息总共只产出 36 条记忆。
  //
  // 好消息是【消息原文一条都没丢】—— 归档只是打了个 archived 标记，
  // 所以只要把这些 id 从 memSummed 里摘掉，下次整理会重新读、重新提炼。
  //
  // ⚠️ 不动 messages / memories 里的任何内容，只动 memSummed 这一个记账键。
  async function reExtractMemories(charIds) {
    let cleared = 0, chars = 0;
    for (const cid of charIds) {
      const before = await kv.get('memSummed:' + cid, []) || [];
      if (before.length) {
        // 只清【已归档】那些：未归档的本来就会在正常节奏里被总结，
        // 一起清掉等于让它们多提炼一遍（白花 token）。
        // ⚠️ 第三个参数必须是 true（v1.21.54 修，审计发现）。
        // msgs.list(cid) 默认【不含归档】，于是下一行的 filter(m => m.archived) 永远是空集：
        // keep === before、cleared 恒为 0 —— 这个按钮（以及「全部角色」那个）
        // 从上线起就没清掉过任何一条标记，界面却每次都说「已解除 0 条」。
        // 它的用途恰恰是修"老对话被标成提炼过、记忆却是空的"，等于一直是死的。
        const arr = await msgs.list(cid, 0, true);
        const archivedIds = new Set(arr.filter(m => m.archived).map(m => m.id));
        const keep = before.filter(id => !archivedIds.has(id));
        cleared += before.length - keep.length;
        await kv.set('memSummed:' + cid, keep);
      }
      // 注：这里【只是计数】。原来的注释说"把归档水位推回去"，但没有任何代码在动
      // memArchiveAt / memArchiveLastAt —— 注释与实现不符（v1.21.54 如实改掉），
      // 清完 memSummed 之后 autoArchiveIfNeeded 自然会把这段再走一遍，不需要额外推水位。
      chars++;
    }
    return { cleared, chars };
  }

  const resumHint = $('resum-hint');
  const setResumHint = (t) => { if (resumHint) resumHint.textContent = t; };

  $('btn-mem-resum').onclick = async () => {
    if (!curCharId) { toast('先选一个角色'); return; }
    const c = await chars.get(curCharId);
    const ok = await confirmBox('重新提炼长期记忆',
      '<p>把 <b>' + esc(c?.name || '当前角色') + '</b> 已经归档的老对话<b>重新读一遍</b>，'
      + '把当初漏掉的记忆补回来。</p>'
      + '<p>· 只动"哪些对话提炼过"这个记账，<b>聊天记录一条不动</b><br>'
      + '· 已有的长期记忆也<b>不会被删</b><br>'
      + '· 会花一些 API 额度（要重新过一遍模型）</p>', '开始重新提炼');
    if (!ok) return;
    setResumHint('正在处理…');
    const r = await reExtractMemories([curCharId]);
    setResumHint('已解除 ' + r.cleared + ' 条对话的"已提炼"标记，点「立即整理记忆」或等下一轮自动补。');
    toast('已解除 ' + r.cleared + ' 条，接下来会自动重新提炼', 4000);
  };

  $('btn-mem-resum-all').onclick = async () => {
    const all = await chars.all();
    const ok = await confirmBox('重新提炼全部角色',
      '<p>对全部 <b>' + all.length + ' 个角色</b>做同样的事。</p>'
      + '<p>聊天记录和已有记忆都不动，只是让老对话重新被读一遍。<br>'
      + '<b>会花明显多一些的 API 额度</b>，而且要跑一阵子。</p>', '全部重新提炼');
    if (!ok) return;
    setResumHint('正在处理…');
    const r = await reExtractMemories(all.map(c => c.id));
    setResumHint('已解除 ' + r.cleared + ' 条对话的"已提炼"标记（涉及 ' + r.chars + ' 个角色）。');
    toast('已解除 ' + r.cleared + ' 条，接下来会陆续重新提炼', 4200);
  };
  fold('mem-fold', 'mem-wrap', renderMem);   // 已记住的事（按人物分组）
  // 联网搜索（原本是平铺的一大块，和设置页其它区块样式不一致，2026-09-29 收进折叠）
  fold('search-fold', 'search-wrap', refreshSearchHint);
  fold('e-mem-fold', 'e-mem-wrap', () => renderCharMem(editingId));  // 角色页：她的记忆
  fold('e-more-fold', 'e-more-wrap');   // 角色页：打字/分段/提示（次要项，默认收起）
  // 角色页：表达方式（一整段，最长的一块，默认收起 —— 不挡着下面的「节奏与细节」「长期记忆」）
  fold('e-exp-fold', 'e-exp-wrap');
  fold('look-fold', 'look-wrap', refreshLookCount);   // 角色页：外貌（她此刻的样子）
  // 角色页：「他的设定」「他的居处」（v1.21.47，从 ⚙ 里搬过来的）
  fold('e-mine-fold', 'e-mine-wrap', refreshEditMineBrief);
  fold('e-home-fold', 'e-home-wrap', refreshEditMineBrief);
  $('e-mine').oninput = refreshEditMineBrief;
  $('e-home').oninput = refreshEditMineBrief;
  // 「填回默认」和设置页原来那个一样：只填进框，不直接落库
  $('btn-e-mine-reset').onclick = async () => {
    const ok = await confirmBox('填回默认内容',
      '<p>把这一份换成<b>默认的那份</b>？</p>'
      + '<p>只是填进上面的框里，<b>还没保存</b>——你先看看，改完再点右上角 ✓。</p>', '填回默认');
    if (!ok) return;
    $('e-mine').value = DEFAULTS.myProfile;
    refreshEditMineBrief();
    toast('已填回默认，记得点右上角 ✓ 保存');
  };
  $('btn-e-mine-apply').onclick = () => openPickChars('myProfile', '他的设定', $('e-mine').value);
  $('btn-e-home-apply').onclick = () => openPickChars('myEnv', '他的居处', $('e-home').value);
  // 人设 / 开场白：入口行 + 弹窗（v1.21.58）。
  // 这里只负责"把弹窗打开、确定后写回源框"，保存链路（saveCharEdit）不用知道。
  $('e-greeting-open').onclick = () => openTextEditor({
    title: '开场白',
    hint: '新建对话时她说的第一句。留空的话，她会等你先开口。',
    srcId: 'e-greeting',
  });
  $('e-persona-open').onclick = () => openTextEditor({
    title: '人设',
    hint: '写下她是谁、什么性格、怎么说话。这一段每一轮都会发给她 —— 写得越长，能留给聊天记录的额度就越少。',
    srcId: 'e-persona',
  });
  $('txt-input').oninput = updateTxtCount;
  $('txt-cancel').onclick = closeTextEditor;
  $('txt-ok').onclick = () => {
    const src = _txtSrcId ? $(_txtSrcId) : null;
    if (src) src.value = $('txt-input').value;   // 写回源框 = 生效
    refreshCharTextBriefs();
    closeTextEditor();
  };
  // 多选角色弹窗的三个按钮
  $('pick-chars-all').onclick = () => {
    document.querySelectorAll('#pick-chars-list input[type=checkbox]').forEach(b => { b.checked = true; });
    refreshPickCount();
  };
  $('pick-chars-none').onclick = () => {
    document.querySelectorAll('#pick-chars-list input[type=checkbox]').forEach(b => { b.checked = false; });
    refreshPickCount();
  };
  $('pick-chars-cancel').onclick = () => $('pick-chars-modal').classList.add('hidden');
  $('pick-chars-ok').onclick = async () => {
    if (!_pickCharsCtx) return;
    const { field, label, text } = _pickCharsCtx;
    const ids = [...document.querySelectorAll('#pick-chars-list input[type=checkbox]')]
      .filter(b => b.checked).map(b => b.dataset.id);
    if (!ids.length) { toast('一个都没勾'); return; }
    for (const id of ids) {
      const c = await chars.get(id);
      if (!c) continue;
      c[field] = text;
      await chars.put(c);
    }
    // 内存里那份也同步，否则下次打开弹窗看到还是"已有 N 字"的旧值
    for (const c of allChars) if (ids.includes(c.id)) c[field] = text;
    $('pick-chars-modal').classList.add('hidden');
    toast('已把「' + label + '」覆盖给 ' + ids.length + ' 个角色');
  };
  // 接口 / 时段划分（v1.21.57）：两块都收成折叠，角标说明当前状态。
  // refreshApiHint 也可以在 renderProviderUI 里刷，但换服务商之外还有
  // "填完 key 没换服务商"这条路，展开时再兜一次最稳。
  fold('api-fold', 'api-wrap', refreshApiHint);
  fold('clock-fold', 'clock-wrap', refreshClockHint);
  $('s-ranges-open').onclick = openPhaseModal;
  $('phase-cancel').onclick = closePhaseModal;
  $('phase-ok').onclick = async () => {
    const next = phaseDraft || draftClockRanges();
    closePhaseModal();      // 先关弹窗：即使下面存失败，界面也是干净的（改动没丢，草稿还在手里）
    await saveSettings({ clockRanges: next });
    refreshClockHint();
    toast('时段划分已保存', 2200);
  };
  // 设置页里「加一条」是按人物动态生成的（见 renderMem），这里不绑定。
  // 角色编辑页那份是固定的一个输入框，绑在这里。
  $('e-mem-add').onclick = async () => {
    const inp = $('e-mem-input');
    const txt = inp.value.trim();
    if (!txt) return;
    if (!editingId) { toast('先保存这个角色，再加记忆'); return; }
    // mine:true = 这是你自己写的（显示上会带「自定义」标签）
    await mem.add({ id: uid(), charId: editingId, text: txt, kind: 'fact', untilDay: null, mine: true, ts: Date.now() });
    inp.value = '';
    await renderCharMem(editingId);
    inp.focus();
  };
  // 用 onkeydown 赋值而不是 addEventListener：这个函数每次初始化都会跑一遍，
  // 用 addEventListener 会越挂越多，一次回车触发 N 次"加一条"。
  // （同一个"加"的动作在 await 之后才清空输入框，所以几次触发都能读到非空值。）
  $('e-mem-input').onkeydown = e => {
    if (e.key === 'Enter') { e.preventDefault(); $('e-mem-add').click(); }
  };

  // 覆盖全局：勾上的瞬间先问一次，取消就把勾退回去
  $('e-override-global').onchange = async e => {
    if (!e.target.checked) return;
    const ok = await confirmBox('覆盖全局设定',
      '这一页的「对话参数」和「表达方式」会覆盖<b>其他所有角色</b>，她们会全部变成现在这套。<br><br>确定吗？', '覆盖');
    if (!ok) e.target.checked = false;
  };

  // 角色卡（实验，v1.21.40）
  $('btn-cc-import').onclick = () => $('cc-import-file').click();
  $('cc-import-file').onchange = async (e) => {
    const f = e.target.files[0];
    e.target.value = '';   // 同上：不重置的话再选同一个文件不触发 onchange
    if (!f) return;
    try {
      const buf = await f.arrayBuffer();
      // 先认 PNG 签名再决定怎么读 —— 比看扩展名可靠：
      // 有的站把卡片存成 .png 其实里面是纯 JSON，反之也有改名的。
      const png = isPng(buf);
      const card = png
        ? extractCardFromPng(buf)
        : parseCardJson(new TextDecoder('utf-8').decode(new Uint8Array(buf)));
      // ⚠️ PNG 卡里嵌的那张图就是她的立绘，顺手当头像（v1.21.52）。
      // 原来 importCharacterCard 里写死 avatar: null —— 自己导出的卡导回来头像没了，
      // 每次都得重设一遍（JSON 卡没图，本来就该是空）。
      await importCharacterCard(card, png ? ('data:image/png;base64,' + bytesToB64(new Uint8Array(buf))) : '');
    } catch (err) {
      toast('导入失败：' + ((err && err.message) || err), 4200);
    }
  };
  $('btn-cc-export-png').onclick = () => exportCharacterCard('png');
  $('btn-cc-export-json').onclick = () => exportCharacterCard('json');

  // 数据
  $('btn-export').onclick = exportData;
  $('btn-import').onclick = () => $('file-import').click();
  $('file-import').onchange = async (e) => {
    const f = e.target.files[0];
    e.target.value = '';   // 不重置的话，再选同一个文件不会触发 onchange，界面像卡住
    if (!f) return;
    try {
      // ① 先解析，拿到"这份备份里有什么"
      const data = JSON.parse(await f.text());
      // ⚠️ 入口校验要放宽（v1.21.28 修，复审 新8_）。
  //
  // 起因：世界书页导出的是 {version, kind, exportedAt, groups, solo} —— 【没有 characters】，
  // 而这里硬卡 characters，于是专为此设计的「仅世界书」模式【永远够不着】。
  // 实测：{有characters字段: false} → 抛「文件格式不对（不是梦弦居的备份）」。
  //
  // 自相矛盾处：下面 applyImport 的注释明说「「仅世界书」导出的备份、或手写世界书文件，
  // 可能是有 solo 但没有 characters 条目的」—— 作者知道这种文件存在，入口却不让它进来。
  //
  // 现在：至少含 characters / groups / solo / messages 之一就放行。
  if (!data.characters && !data.groups && !data.solo && !data.messages) {
    throw new Error('文件格式不对（不是梦弦居的备份）');
  }
      const survey = surveyBackup(data);
      const localCounts = await dbAdmin.counts();
      // ② 看完内容再选模式 —— 反过来选完才发现文件不对，要重来一遍
      const mode = await pickImportMode(survey, localCounts);
      if (!mode) { toast('已取消'); return; }
      // ③ 真正导入（importData 里还会做模式 1 的二次确认）
      await importData(f, mode);
    } catch (err) {
      console.error('[导入] 失败', err);
      toast('导入失败：' + ((err && err.message) || err), 4200);
    }
  };
  $('btn-clear-chat').onclick = async () => {
    // ⚠️ 生成中不许清（v1.21.52）。
    // 这轮生成不会因为清了记录就停下，而成功路径是【无条件落库】的
    //（send 里那句 await msgs.add(am)，不校验对应的用户消息还在不在）——
    // 清完就会在空对话里冒出一条"自问自答"的孤儿回复，内容还是用已被删掉的历史生成的。
    // 单条删除那条路早就拦了（见 attachMsgActions 里的 busy 判据，注释里还留着当时的实测记录），
    // 这个入口漏了 —— 同一个坑第二次。
    if (busy) { toast('她还在打字，先按停止再清空', 2600); return; }
    const nm = esc(curChar?.name || '她');
    const ok = await confirmBox(
      '清空聊天记录',
      `<p>要清掉和「${nm}」的<b>全部聊天记录</b>吗？</p>` +
      `<p>清完之后她会变回<b>刚创建时的样子</b>——像新角色一样，重进来自动重新说开场白。</p>` +
      `<p>她记住的事（长期记忆）和剧情天数<b>也一起清掉</b>，回到第一天。</p>` +
      `<p>人设、参数、头像、世界书都<b>不动</b>。别的角色的记忆不受影响。</p>` +
      `<p><b>这件事不能撤销。</b></p>`,
      '清空'
    );
    if (!ok) return;

    // 再确认一次。清空不可恢复，上一层的确认按钮又和「保存」离得近，
    // 手滑点到就找不回来了。
    const sure = await confirmBox('真的确定？',
      `「${nm}」的聊天记录和长期记忆会<b>永久消失</b>，找不回来。`, '确定清空');
    if (!sure) { toast('已取消'); return; }

    const id = curCharId;
    // ⚠️ 长期记忆也要清（2026-09-28 改）。
    //
    // 起因（需求，原话）：
    //   「清除当前角色的记忆聊天记录那个按钮点了后会把那个人物的长期记忆和
    //     聊天记录全删且不会影响到我后续和她聊天……她那部分只有已经有的
    //     设定设置那些的世界树也在，长期记忆和聊天记录全清除」
    //
    // 旧版这里【不清记忆】，确认框写的理由还是「长期记忆是所有角色共用的」——
    // 那句话是错的：memories 表就是按 charId 分开存的
    // （dedupeIfNeeded 里"记忆按角色分开"的注释、summarizeChunk 的 charId 参数都证明了）。
    // 所以这里可以放心只删她自己的，别的角色一条都不动。
    const memCount = (await mem.list(id)).length;
    await msgs.clear(id);
    for (const m of await mem.list(id)) {
      try { await mem.del(m.id); } catch { /* 单条删不掉不该挡住整个清空 */ }
    }
    // 剧情天数也回第一天。clock: 不在下面那串键里 —— 漏了它的话，
    // 清空后她还停在"第 300 天"，跟空白的聊天记录完全对不上。
    try { await kv.del('clock:' + id); } catch { /* 同上 */ }
    if (id === curCharId) {
      clockState = { day: 1, phase: phaseFromNow(), season: seasonFromNow(),
                     weather: 'clear', locked: false, hour: null, minute: 0 };
      renderClock();
    }
    // 清掉「开场白已经说过了」的标记，这样重绘时会当成全新角色、
    // 重新补一次开场白。不重置这一步的话，清完只剩一条空提示，
    // 开场白再也不会出现。
    try { await kv.del('greeted:' + id); } catch { /* 清不掉也不影响后面的重绘 */ }
    // 把所有跟"这段对话的进度"有关的键都重置。消息都没了，旧账毫无意义：
    //   memSummed/memSumAt/memDedupeAt/memArchiveAt —— 记忆节奏的记账
    //   memDeleted —— ⚠️ 最容易漏的一个：它是"用户删掉的对话"清单，
    //                 残留下来的话下次整理记忆时会拿着【已经不存在的旧对话】
    //                 去删记忆，把好好的记忆误删。
    //   msgSeq —— 不清的话，清空前的累计序号会让"攒够多少条总结"立刻误判。
    //   memRolling —— ⚠️ 滚动摘要（v1.18.10 新增）。它是"你们之前发生过什么"，
    //                 清空聊天就是要从头开始，留着会把【已经不存在的前情】讲给她听，
    //                 她会提到用户根本没经历过的往事。
    // ⚠️ 同样从常量派生（v1.21.32 修，复审 #11 的第二处硬编码）。
    for (const k of [...BACKUP_KV_PREFIXES, 'memTidyBackup:']) {
      try { await kv.del(k + id); } catch { /* 同上 */ }
    }
    // 现实时间模式的存档位（v1.20.21）：清空 = 回到第一天，
    // 所以这里【重开】而不是删掉 —— 从此刻算第 1 天。
    // 上面那个循环删不掉它（键名多了 ':real' 后缀），得单独处理。
    try { await kv.del('clock:' + id + ':real'); } catch { /* 同上 */ }
    if (id === curCharId && isRealClock()) {
      clockReal = null;
      await startRealClock(id);
      clockState = { ...clockState, ...realNow() };
    }
    await renderMessages();
    toast('已清空，「' + (curChar?.name || '她') + '」的记忆和记录都清掉了'
          + (memCount ? '（' + memCount + ' 条记忆）' : '') + '，回到第一天');
  };
  $('btn-wipe').onclick = async () => {
    // ⚠️ 生成中不许清（v1.21.54，审计发现）：「清空当前角色的聊天记录」那边早有这个守卫，
    //    这个入口漏了。正在流的回复回来时会【无条件落库】，清完就会在空库里冒出一条
    //    自问自答的孤儿回复（内容还是用已经删掉的历史生成的）。
    if (busy) { toast('她还在打字，先按停止再清空', 2800); return; }
    if (!confirm('清空全部数据（角色、记录、设置）？不可恢复！')) return;
    // ⚠️ 必须看返回值（v1.21.54，审计发现）：deleteDatabase 被在途连接挡住时走 onblocked →
    //    resolve(false)，数据【并没有删掉】。而以前无论成败都提示「已清空，正在重启…」——
    //    对一个装着私密聊天记录的 App，这句话不该无条件给出去。
    const ok = await wipeAll();
    if (!ok) {
      toast('没清干净：还有连接占着数据库，重启一次再试', 5200);
      return;
    }
    toast('已清空，正在重启…');
    setTimeout(() => location.reload(), 800);
  };
}

/** Android 物理返回键：先走返回栈，弹到栈底了才真的退出软件 */
function bindBackButton() {
  const App = capPlugin('App');
  if (!App || !App.addListener) return;   // 桌面浏览器里没有，静默跳过
  App.addListener('backButton', () => {
    // 弹窗不是视图、从不进返回栈，所以得单独先处理。
    // 否则剧情时间 / 确认弹窗开着时按返回键会直接把 App 杀掉，
    // 没保存的改动一起丢；弹窗内容偏高时更是连退出都只剩这一条路。
    const openModal = document.querySelector('.modal:not(.hidden)');
    if (openModal) {
      // 尽量走各自的取消按钮，保证收尾逻辑一致（剧情时间要写回状态）
      const cancel = openModal.querySelector('#clock-cancel, #modal-cancel, #phase-cancel, #txt-cancel');
      if (cancel) { cancel.click(); return; }
      openModal.classList.add('hidden');
      return;
    }
    if (!goBack()) App.exitApp();
  });
}

// ================= 启动 =================
/**
 * 关于页显示的版本号。
 *
 * v1.21.45 修：这一行原来写死「AI伙伴 v0.1.0」—— 名字和 App 名（梦弦居）对不上，
 * 版本停在 0.1.0，而 app.js 里没有任何一行去更新这个节点。定了「版本号只增不减」
 * 的规矩，却把版本号锁在一个没人碰的角落。
 *
 * 现在真机上直接问原生要（App.getInfo() → build.gradle 的 versionName），单一真相源，
 * 不会再漂移。桌面浏览器上这个 API 必抛 unimplemented，用常量兜底 ——
 * 构建脚本会断言这个常量和 build.gradle 一致，对不上就构建失败。
 */
const WEB_VERSION_FALLBACK = '0.3.0';

/** 源码地址。换了仓库记得改这里（关于页和 README 都用它）。 */
const REPO_URL = 'https://github.com/nan333680/mengxianju';

/** 关于页：填源码地址（版本号由 renderAppVersion 一并填） */
function renderAbout() {
  const el = document.getElementById('about-repo');
  if (el) el.textContent = REPO_URL;
}

async function renderAppVersion() {
  const el = document.getElementById('app-ver');
  const el2 = document.getElementById('about-ver');
  if (!el && !el2) return;
  let v = '';
  const App = capPlugin('App');
  if (App && App.getInfo) {
    try {
      const info = await App.getInfo();
      v = String((info && info.version) || '');
    } catch { /* web 上必抛，落到下面的常量 */ }
  }
  const ver = 'v' + (v || WEB_VERSION_FALLBACK);
  if (el) el.textContent = ver;
  if (el2) el2.textContent = ver;
}

async function init() {
  await loadSettings();
  // 界面语言要【先于】一切渲染设好（v1.21.60）：applyI18n 刷的是 DOM 上的静态文本，
  // 抽屉菜单那些是拼出来的、渲染时自己会过 t()。
  setLang(S.lang);
  applyI18n();
  // 「跟随系统」时，用户在后台把手机语言改了，回到 App 要跟着变（v1.21.61）。
  // 只在【实际生效的语言变了】时才重刷，免得每次回前台都白跑一遍 DOM。
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    const before = getActiveLang();
    if (refreshLang() !== before) { applyI18n(); renderDrawerMenu(); }
  });
  applyTheme();
  bindEvents();
  bindBackButton();
  renderAppVersion();   // 关于页版本号（v1.21.45）：真机读原生，不再写死 v0.1.0
  // ⚠️ updateStatus 必须在这里补一次（v1.21.40）。
  // 它原来只在 selectChar（切角色）和设置页回调里跑，而这两条在冷启动时都可能不发生 ——
  // 于是没填 Key 的用户进来看到的是空状态栏，引导条也不会亮。
  updateStatus();
  // 输入框先按设置摆好形状（v1.21.48）。
  // 不放在 bindSettings 里：那是进设置页才跑的，没进过设置的人会看到一个
  // 没同步过的框（实测 43px、overflow 默认 auto、--input-max 为空）。
  syncInput();
  await loadChars();
  await ensureChar();
  renderCharList();

  // 自动备份：一天最多一次（v1.21.40）。
  //
  // 延迟 5 秒再动，别和首屏抢 —— 它要读全部消息，角色多的时候是几 MB。
  // 静默处理：自动的事不该弹 toast 打扰人，但失败一定要留下痕迹
  // （console），否则"备份没做成"会一直没人知道，直到真的需要那份备份。
  setTimeout(() => {
    const FS = capPlugin('Filesystem');
    autoBackupIfDue({ kv, FS, collect: collectBackupPayload }).then(async r => {
      if (r.ran) {
        console.log('[自动备份] 已写入', r.dir, r.name,
          r.deleted && r.deleted.length ? ('，清理旧备份 ' + r.deleted.length + ' 份') : '');
        // ⚠️ 退到"卸载即删"的目录时必须【说出来】（v1.21.54，审计发现）。
        // DOCUMENTS 写不进去时（Android 10 及以下没给存储权限、或用户拒了授权），
        // 备份会依次退到 EXTERNAL / DATA —— 那是 /Android/data/<包名>/files，
        // 卸载应用或「清除数据」时系统会整目录删掉，正是备份要防的那两件事。
        // 以前这里只有一行 console，用户以为有备份，换机时一无所有。
        if (r.dir && r.dir !== 'DOCUMENTS') {
          // 同一个目录只提醒一次，别天天弹
          const warned = await kv.get('autoBackupDirWarned', '');
          if (warned !== r.dir) {
            try { await kv.set('autoBackupDirWarned', r.dir); } catch { /* 记不上就下次再提醒 */ }
            toast('自动备份只能写进「' + r.dir + '」——卸载或清除数据时会跟着消失，快去设置里手动导出一次', 6500);
          }
        }
      } else if (r.reason !== 'not-due' && r.reason !== 'no-filesystem') {
        console.warn('[自动备份] 没做成：', r.reason, r.error || '');
        // 写失败也让人知道（v1.21.54）：以前只有 console，而"备份没做成"
        // 正是最该被知道、却最容易被忽略的一件事。
        if (r.reason === 'write-failed') {
          toast('自动备份没做成（多半是存储权限被拒或空间不足），到设置里手动导出一份吧', 6000);
        }
      }
    }).catch(e => console.warn('[自动备份] 异常：', e));
  }, 5000);
}

init().catch(e => {
  console.error(e);
  document.body.innerHTML = '<div style="padding:40px;color:#f2555a;font-family:sans-serif">启动失败：' + esc(e.message) + '</div>';
});

