// 界面多语言（v1.21.60）
//
// ⚠️ 一条硬约束：**中文下渲染出来的字必须和以前逐字相同**。
//    回归里有几十处断言直接匹配中文界面文本（includes('长期记忆') 这种），
//    改一个标点就会红。所以这里的做法是：
//      · DOM 上的静态文本：切到非中文才替换，切回中文从元素里存的原文恢复 ——
//        中文路径上是"一个字节都不动"。
//      · 代码里拼出来的动态文本：走 t(key)，中文映射就是原来的字符串。
//
// 加新语言：往 MAP 里加一份，再在 LANGS 里加一行。

export const LANGS = [
  { key: 'system', label: '跟随系统' },
  { key: 'zh', label: '中文' },
  { key: 'en', label: 'English' },
];

/** 英文。key 是给代码用的短标识，值才是显示的文案 */
const EN = {
  // ---- 抽屉 ----
  'drawer.worldbook': 'World book',
  'drawer.settings': 'All settings',
  'drawer.chars': 'Characters',
  'drawer.profile': 'About me',
  'drawer.about': 'About',
  'drawer.global': 'Global settings',
  'drawer.global.s': 'API / expression / memory',
  'drawer.mine': 'My settings',
  'drawer.mine.s': 'Avatar / look / data',
  'drawer.worldbook.s': 'Keyword-triggered lore',
  'drawer.settings.s': 'API / memory / appearance',
  'drawer.about.s': 'Version & license',
  'drawer.read': 'Reading mode',
  'drawer.read.s': 'Chat as prose',
  'drawer.read.off': 'Exit reading',
  'drawer.scene': 'Write a scene',
  'drawer.scene.s': 'One sitting, becomes prose',
  'drawer.shelf': 'Shelf',
  'drawer.shelf.s': 'Scenes you have written',

  // ---- 设置页栏目标题 ----
  'set.avatar': 'My avatar',
  'set.desc': 'Description & expression',
  'set.composer': 'Composer',
  'set.memory': 'Memory',
  'set.search': 'Web search',
  'set.look': 'Appearance',
  'set.data': 'Data',
  'set.cards': 'Character cards',
  'set.cards.sub': 'experimental',
  'set.api': 'API',
  'set.clock': 'Time of day',
  'set.remembered': 'Remembered',
  'set.cadence': 'Memory cadence (global)',
  'set.archive': 'Archive old chats',
  'set.ranges': 'Hours for each time of day',

  // ---- 通用 ----
  'common.language': 'Language',
  'common.language.note': 'Interface language. It does not change what she says — she replies in whatever language you write to her.',
  'about.title': 'About',
  'about.license': 'License',
  'about.repo': 'Source code',
  'about.contact': 'Contact',
  'about.trademark': 'Name & icon',
  'about.third': 'Third party',
};

const MAP = { en: EN };

/**
 * 界面短文案 → 英文（v0.4.2 补全翻译时生成）。
 * 两个用途：① 展示用的短词（时段/季节/天气/空态）；
 *           ② 【文字夹着动态值】的块里那些文本节点（见 applyI18n 里 data-i18n-nodes 那一段）——
 *              那些块不能整块换 innerHTML（会摧毁里面的动态元素），只能逐个数节点翻，
 *              而节点上的文字就是这里的 key。
 * ⚠️ 只在英文下生效；中文路径一个字节都不动。
 */
const EXTRA_ZH = {
  "未选择角色": "No character selected",
  "离线": "Offline",
  "第 1 天 · 早上": "Day 1 · Morning",
  "场景": "Scene",
  "还没填 API Key，填完才能开始聊天": "No API key yet — fill it in to start chatting",
  "去填写 ›": "Fill it in ›",
  "聊天记录表是空的，但收发记账还在 —— 像是被系统回收过。去看看备份 ›": "The message store is empty while the send counters are still there - it looks like the system reclaimed it. Check your backup.",
  "去检查 ›": "Check now",
  "发送": "Send",
  "停止": "Stop",
  "角色": "characters",
  "＋ 创建新角色": "+ New character",
  "👥 新建群聊（两个以上的人一起聊）": "New group chat (2+ people in one room)",
  "群设置": "Group settings",
  "换群头像": "Change group avatar",
  "群成员": "Members",
  "群设定": "Group setup",
  "这个群是怎么回事": "What this group is about",
  "在她们眼里，他是谁（这个群共用一份）": "Who he is in their eyes (shared by the group)",
  "这个群在哪儿（城市 / 季节 / 这间屋子）": "Where this group is (city / season / the room)",
  "常驻": "Always on",
  "临时": "Temporary",
  "他在这个群里的住处（一般不填）": "His place in this group (usually leave blank)",
  "这个群在哪": "Where the group is",
  "他家什么样": "What his place is like",
  "发言方式": "Who speaks",
  "谁先开口": "Who speaks first",
  "轮流（按上面的成员顺序，一轮一个）": "Take turns (one per round, in member order)",
  "概率（按各人的活跃度抽，可连发）": "Weighted (drawn by how often each one speaks; may send several)",
  "点名（你 @谁 或写「谁：」才由她开口）": "Only when called (she speaks if you @ her or write \"name:\")",
  "试一次（看这一轮会轮到谁）": "Try once (see who would speak this round)",
  "允许冷场（小概率这一轮没人接话）": "Allow silence (small chance nobody replies this round)",
  "每一幕都是一次完整请求，token 成倍": "Each scene is a full request — tokens multiply",
  "这一幕怎么写": "How this scene is written",
  "小说式一幕（一轮里可以几个人说话）": "Novel-style scene (several people may speak in one round)",
  "带旁白（场面描写单独成一条，标成旁白）": "With narration (scene description becomes its own line, marked as narration)",
  "上一个说话的人": "The one who spoke last",
  "这一幕写多长（直接决定花多少 token）": "How long this scene is (directly decides token cost)",
  "短 · 120~220 字，最多两个人开口": "Short · 120–220 chars, at most two speak",
  "中 · 200~350 字（默认）": "Medium · 200–350 chars (default)",
  "长 · 350~600 字": "Long · 350–600 chars",
  "抽": "Draw",
  "表达方式": "Expression",
  "跟随全局": "Follow global",
  "这个群用自己的表达方式（不勾 = 跟随 ⚙ 全局那份）": "This group uses its own expression (unchecked = follow the global one in ⚙)",
  "回复长度（只管说出口的话）": "Reply length (what she actually says)",
  "很短": "Very short",
  "短": "Short",
  "中等": "Medium",
  "长": "Long",
  "非对话描写（只管括号里的）": "Narration (what goes in parentheses)",
  "描写详细程度（括号里必须写成什么形状）": "Description detail (what shape the parentheses must take)",
  "叙事视角（群聊里最容易飘的就是这个）": "Narrative point of view (the thing that drifts most in groups)",
  "颜文字频率": "Kaomoji frequency",
  "颜文字风格": "Kaomoji style",
  "日式 · 温和": "Japanese / soft",
  "日式 · 可爱": "Japanese / cute",
  "中式": "Chinese",
  "混合": "Mixed",
  "emoji 频率": "Emoji frequency",
  "群自己的参数": "Group-specific parameters",
  "这个群用自己的参数（不勾 = 跟随 ⚙ 全局那份）": "This group uses its own parameters (unchecked = follow the global ones in ⚙)",
  "这个群的资料": "Group details",
  "群世界书": "Group world book",
  "群记忆": "Group memory",
  "进群后自动生效": "Applies automatically inside the group",
  "删除这个群": "Delete this group",
  "她在群里": "Her in this group",
  "群内人设": "Persona inside the group",
  "跟随她本人": "Follow her own",
  "群内补充": "Extra notes for this group",
  "她怎么看群里这些人": "How she sees the others here",
  "她在群里的参数": "Her parameters in this group",
  "正常": "Normal",
  "在不在场": "Whether she is in the scene",
  "给她多少台词": "How many lines she gets",
  "常在场但基本不说话": "Often present but barely speaks",
  "不常出现但一开口就一大段": "Rarely appears but talks at length when she does",
  "每一轮都会写进她的人设": "Written into her persona every round",
  "她整个不参与（连出场都不抽她，你点名时仍会答）": "She sits out entirely (not even drawn for the scene; still answers when you call her)",
  "只影响这个群": "Affects this group only",
  "查看她的完整设定 ›": "See her full character ›",
  "恢复成跟随她本人": "Reset to follow her own",
  "选择角色模板": "Pick a template",
  "选一个模板快速创建——人设、开场白和推荐参数都会自动带出来，建好后随便改。": "Pick a template to create one fast — persona, greeting and suggested parameters come along; change anything afterwards.",
  "新建角色": "New character",
  "名字": "Name",
  "头像": "Avatar",
  "选择图片": "Choose an image",
  "开场白（新建对话时她说的第一句）": "Greeting (her first line in a new chat)",
  "人设（性格 / 背景 / 说话方式）": "Persona (personality / background / how she talks)",
  "下面这些设置只对「她」生效。切到别的角色，她们各有各的脾气。": "These settings apply to her only. Switch to another character and she has her own temper.",
  "你的设定": "About you",
  "只有她": "Her only",
  "挑你在意的写": "Write what you care about",
  "建议换成你自己的": "Worth replacing with your own",
  "填回默认": "Reset to default",
  "应用到其他角色…": "Apply to other characters…",
  "你的居处": "Where you live",
  "会照这个来": "She will follow this",
  "越具体越好": "The more specific the better",
  "对话参数": "Chat parameters",
  "温度": "Temperature",
  "（低=沉稳，高=活泼）": "(low = calm, high = lively)",
  "最大回复长度": "Max reply length",
  "推理强度（聊天用 low 足够）": "Reasoning effort (low is plenty for chat)",
  "上下文轮数": "Context rounds",
  "这两项是分开的：话可以说得很短，但括号里的动作神态照样写得很足。": "These two are independent: she can speak in very few words while still describing a lot in the parentheses.",
  "描写详细程度": "Description detail",
  "必须写成什么形状": "What shape it must take",
  "跟随全局设置": "Follow global settings",
  "表达预设（点一下，把下面这些一次填好）": "Presets (fill everything below in one tap)",
  "叙事视角": "Narrative point of view",
  "强制聊天模式": "Force chat mode",
  "没被说出口的": "What was not said aloud",
  "只听你说出口的话": "Only what you actually said",
  "读心能力": "Mind reading",
  "联网搜索": "Web search",
  "/搜 something": "/search something",
  "/搜 要查的东西": "/search what you want to look up",
  "强制开": "Forced on",
  "时间跟现实走": "Follow the real clock",
  "关": "Off",
  "开": "On",
  "外貌": "Appearance",
  "未填": "Not set",
  "是否启用": "Enabled",
  "此刻": "Right now",
  "0 字": "0 chars",
  "清除": "Clear",
  "立即生效": "Apply now",
  "不受右上角 ✓ 影响": "Not affected by the ✓ at top right",
  "也可以用图片生成——只认衣服和发饰，不猜是谁。": "You can also generate from an image — it reads clothes and accessories only, never guesses who it is.",
  "节奏与细节": "Pacing & detail",
  "打字 / 分段 / 提示": "Typing / splitting / hints",
  "显示「正在输入」": "Show",
  "分段发送（一条拆成几条发）": "Split messages",
  "打字延迟": "Typing delay",
  "使用「……」表现迟疑": "Use",
  "长期记忆": "Long-term memory",
  "自动记住重要的事": "Remember important things automatically",
  "允许她整理时修改我加的": "Let her edit the ones I added",
  "她记住的事": "What she remembers",
  "加": "Add",
  "每个角色各记各的": "Each character keeps her own",
  "覆盖全局设定": "Override global settings",
  "把这一页的参数同步给所有角色": "Apply this page's settings to every character",
  "覆盖其他所有角色": "Override every other character",
  "删除此角色": "Delete this character",
  "全局设置": "Global settings",
  "接口": "API",
  "服务商": "Provider",
  "对话模型": "Chat model",
  "识图模型（发图片时用，同款即可）": "Vision model (for images; the same one is fine)",
  "账户余额": "Balance",
  "查询": "Check",
  "上下文预算（估算 token）": "Context budget (estimated tokens)",
  "所有角色共用": "Shared by all characters",
  "描写与表达": "Description & expression",
  "两个独立开关": "Two separate switches",
  "非对话描写（上限 —— 括号里最多写多长）": "Non-dialogue description (the cap — how long the parentheses may get)",
  "上限": "Cap",
  "结构": "Structure",
  "描写详细程度（结构 —— 必须写成什么样）": "Narration detail (structure)",
  "不额外约束": "No extra constraint",
  "角色编辑页": "Character edit page",
  "写字台": "Composer",
  "输入": "Input",
  "输入框高度（最高长到几行）": "Input box height",
  "回车键做什么": "What Enter does",
  "已写多少字": "Length so far",
  "记忆管理": "Memory",
  "按角色分开": "Separate per character",
  "角色编辑页 → 长期记忆": "Character edit page → Long-term memory",
  "记忆节奏（全局统一）": "Memory cadence (global)",
  "全局统一": "One global setting",
  "攒够多少条消息总结一次": "Summarize after how many messages",
  "记忆条数上限": "Max memories",
  "立即整理记忆": "Tidy memories now",
  "撤销上次整理": "Undo last tidy",
  "上次的样子": "Previous state",
  "重新提炼长期记忆": "Re-distill long-term memory",
  "原文还在": "Originals are still there",
  "重新提炼当前角色": "Re-extract for this character",
  "重新提炼全部角色": "Re-extract for all characters",
  "归档旧对话": "Archive old chats",
  "每轮都会重复发出去": "Sent again every round",
  "原文还在，能展开回看": "Originals are kept and can be expanded",
  "自动归档": "Auto archive",
  "自动收走最早的": "Automatically takes the oldest",
  "保留最近多少条不归档": "Keep the latest N unarchived",
  "归档并整理进长期记忆": "Archive and fold into memory",
  "全部取消归档": "Unarchive everything",
  "联网搜索（只在 /搜 时联网）": "Web search (only when you type /搜)",
  "默认是纯本地的。": "Local by default.",
  "省额度、也不变慢": "Saves quota, no slowdown",
  "启用联网搜索": "Enable web search",
  "搜索用哪家": "Search backend",
  "智谱 GLM（可用同一个 key）": "Zhipu GLM (can reuse the same key)",
  "搜索 API Key": "Search API key",
  "每次取几条结果": "Results per search",
  "当前状态": "Status",
  "未启用": "Not enabled",
  "测试一下能不能搜": "Test the search",
  "酒馆预设": "SillyTavern preset",
  "它自己不会生效": "It does not take effect by itself",
  "导入酒馆预设 JSON": "Import a SillyTavern preset",
  "已记住的事": "Remembered",
  "时段划分": "Time of day",
  "显示具体时间（时:分）": "Show exact time (hh:mm)",
  "打开后，聊天栏的时间会精确到几点几分；记忆也能设到「第几天几点」。": "When on, the time bar shows the exact hour and minute, and memories can be dated to the hour.",
  "按手机真实时钟走": "Follows the phone clock",
  "打开的那一刻": "The moment you open it",
  "再打开会接着上次关闭时的时间继续": "Reopening continues from when you last closed it",
  "开着的时候聊天栏的时间条会缩成一行只读小字": "While on, the time bar in chat shrinks to one read-only line",
  "每个时段对应几点": "What hours each time of day covers",
  "我的设置": "My settings",
  "我的头像": "My avatar",
  "聊天里你自己那一侧显示的头像": "The avatar shown on your side",
  "恢复默认": "Restore default",
  "外观": "Appearance",
  "语言": "Language",
  "界面语言。不影响她说什么 —— 你用哪种语言写，她就用哪种回。": "Interface language. It does not change what she says - she replies in whatever language you write to her.",
  "主题": "Theme",
  "深色": "Dark",
  "浅色": "Light",
  "跟随系统": "Follow system",
  "字体大小": "Font size",
  "显示 token 使用量": "Show token usage",
  "关掉后气泡右下角不再显示 ↑输入 ↓输出的角标，聊天记录照常保存。": "When off, the ↑in ↓out badge disappears from the bubbles. Chats are still saved either way.",
  "朗读她的回复": "Read her replies aloud",
  "数据": "Data",
  "导出当前角色的对话（Markdown）": "Export this chat (Markdown)",
  "导出全部数据（角色+记录）": "Export everything (characters + chats)",
  "导入数据": "Import",
  "清空当前角色的聊天记录": "Clear this chat",
  "清空全部数据": "Clear everything",
  "自动备份": "Auto backup",
  "活过卸载和「清除数据」": "Survives uninstall and \"clear data\"",
  "是明文、别的 App 也可能看到": "Plain text — other apps may see it",
  "检查我最近那份备份能不能用": "Check whether my latest backup is usable",
  "只读，什么都不改": "Read-only, changes nothing",
  "角色卡": "Character cards",
  "实验": "experimental",
  "新建": "New",
  "导入角色卡（.json / .png / .charx）": "Import character card (.json / .png / .charx)",
  "把当前角色导出为 PNG 卡": "Export as PNG card",
  "把当前角色导出为 JSON 卡": "Export as JSON card",
  "酒馆正则": "Regex scripts",
  "副本": "Copy",
  "存档原文一个字都不动": "The saved original is never touched",
  "酒馆聊天记录": "SillyTavern chat logs",
  "聊天记录没了就是没了": "Chat logs, once gone, are gone",
  "不猜": "No guessing",
  "导入酒馆聊天记录（.jsonl）": "Import SillyTavern chat log (.jsonl)",
  "关于": "About",
  "梦弦居": "Mengxianju",
  "版权": "License",
  "GNU Affero 通用公共许可证第 3 版": "GNU Affero General Public License v3",
  "不提供任何担保": "No warranty of any kind",
  "源代码": "Source code",
  "完整源代码在这里，许可证全文（LICENSE）也在同一个仓库里：": "Full source code is here. The license text (LICENSE) lives in the same repository:",
  "复制地址": "Copy address",
  "联系": "Contact",
  "名称与图标": "Name & icon",
  "代码": "Source code",
  "尚未注册商标": "No trademark registered",
  "第三方": "Third party",
  "Capacitor —— WebView 外壳（MIT License）。": "Capacitor - the WebView shell (MIT License).",
  "设置": "Settings",
  "世界书": "World book",
  "总开关": "Master switch",
  "是否启用世界书": "World book enabled",
  "开着才会把设定按关键词注入。关着的时候，下面所有内容都不生效（也不会花 token）。": "Lore is injected by keyword only while this is on. When off, nothing below applies (and costs no tokens).",
  "从哪来": "Where it came from",
  "还没建角色组": "No character groups yet",
  "单独角色": "Per-character",
  "给某一个角色单独写设定": "Write lore for one specific character",
  "导入 / 导出": "Import / Export",
  "追加": "Append",
  "导入世界书文件": "Import a world book file",
  "导出世界书": "Export world book",
  "不受这里影响": "Not affected by this",
  "长按组可以拖动排序": "Long-press a group to reorder",
  "＋ 新建角色组": "+ New character group",
  "条目": "Entries",
  "＋ 新建条目": "+ New entry",
  "调整头像": "Adjust avatar",
  "缩放": "Zoom",
  "按住图片拖动位置 · 拖动滑块缩放": "Drag the image to move it, drag the slider to zoom",
  "点「确定」才会存下来。": "Nothing is saved until you press OK.",
  "取消": "Cancel",
  "确定": "OK",
  "编辑": "Edit",
  "剧情时间": "Story time",
  "这是你们对话里的时间。她会按这个判断\"今天是哪天、现在是什么时候\"。": "This is the time inside your story. She uses it to tell which day it is and what time it is.",
  "时段": "Time of day",
  "具体时间": "Exact time",
  "用当前时段": "Use the time of day",
  "季节": "Season",
  "天气": "Weather",
  "以我设定的时间为准（她自己不擅自改）": "Use the time I set (she will not change it on her own)",
  "确认": "Confirm",
  "必须写成什么样": "Must be written as",
  "这份备份里有": "This backup contains",
  "选择导入方式": "Choose how to import",
  "导入": "Import",
  "临时场景": "Temporary scene",
  "不写进人设": "Not written into the persona",
  "下一条回复立刻生效": "Takes effect on the next reply",
  "当前场景：无": "Current scene: none",
  "保存并应用": "Save and apply",
  "应用到其他角色": "Apply to other characters",
  "全选": "Select all",
  "全不选": "Select none",
  "应用": "Apply",
  "你不说话时自动再写": "Keep writing when you go quiet",
  "幕（0 = 关）": "scenes (0 = off)",
  "出场频率": "Appearance rate",
  "她这一场戏": "she is in this scene",
  "。概率发言时就是抽签的权重。": ". In weighted mode this is the draw weight.",
  "说话分量": "Speaking weight",
  "她出场时": "when she appears,",
  "。拉到 0 = 只做动作不说话 —— 人还在场，眼神和举动照样写出来，只是不出声。": ". Pull it to 0 = actions only, no lines — she is still there, her looks and gestures are still written, she just does not speak.",
  "聊天里说「早上」「傍晚」的时候，她按这里理解具体是几点。": "When the chat says “morning” or “dusk”, this is what she understands the hours to be.",
  "24 小时制：左边是开始、右边是结束，结束填 24 表示到午夜。": "24-hour clock: left is the start, right is the end; put 24 for midnight.",
  "年": "year",
  "第": "Day",
  "控制她括号里的动作描写": "Controls the action description inside her parentheses —",
  "和「非对话描写」是两个独立开关：那个管": "Two separate switches from “Non-dialogue description”: that one caps",
  "（最多写多长），这个管": " (how long at most); this one sets",
  "（必须写成什么形状）。": " (what shape it must take).",
  "凌晨": "Small hours",
  "早上": "Morning",
  "上午": "Late morning",
  "中午": "Noon",
  "下午": "Afternoon",
  "傍晚": "Dusk",
  "晚上": "Evening",
  "深夜": "Late night",
  "春": "Spring",
  "夏": "Summer",
  "秋": "Autumn",
  "冬": "Winter",
  "晴": "Clear",
  "多云": "Cloudy",
  "阴": "Overcast",
  "雨": "Rain",
  "雷雨": "Thunderstorm",
  "雪": "Snow",
  "风": "Windy",
  "雾": "Fog",
  "（空的）": "(empty)",
  "还没有": "None yet",
  "跟随手机时间": "Following the phone clock",
  "无": "none",
  "不写": "None",
  "简": "Brief",
  "中": "Medium",
  "丰富": "Rich",
  "中文": "中文",
  "上次自动备份": "Last auto backup",
  "这台机器上还没跑过": "Never run on this device",
  "存放位置": "Location",
  "（还不知道）": "(unknown yet)",
  "最近一次自检": "Last self-check",
  "从没跑过": "Never run",
  "主数据对账": "Main data check",
  "备份频率": "Backup frequency",
  "每天": "Every day",
  "每 3 天": "Every 3 days",
  "每周": "Every week",
  "关掉自动备份": "Turn auto backup off",
  "每天最多写一份，写完会当场读回来验一遍；本地只留最近 7 份。": "At most one file per day; it reads the file back right after writing to verify it. Only the latest 7 are kept on the device.",
  "还没填 key": "No key yet",
  // 「点」是时段表里的小时单位（0–24 点）。英文里数字后面不加单位，所以给空串。
  "点": "",
  // 运行时光拼出来的 title / placeholder（下面的元素拿不到 index.html 上的 data 标注）
  "正在跟随手机时间，改不了（想手动调就去设置里关掉）": "Following the phone time; turn that off in settings to set it by hand",
  "点这里调整剧情时间": "Tap to adjust the story time",
  "点这里给这一段对话设一个场景": "Tap to give this conversation a scene",
  "当前场景：": "Scene: ",
  "（不填就用不了 /搜）": " (required for /搜)",
  "时": "hr",
  "分": "min",
  "对得上": "OK",
  "记录": "records",
  "Kimi（月之暗面）": "Kimi (Moonshot)",
  "智谱 GLM": "Zhipu GLM",
  "硅基流动": "SiliconFlow",
  "本地（Ollama）": "Local (Ollama)",
  "自定义（OpenAI 兼容）": "Custom (OpenAI-compatible)",
  "默认。自带看图能力，能查余额。": "Default. Built-in vision and balance check.",
  "还没发过消息，发一条就能看到占用。": "No messages yet — send one to see usage.",
  "这一页是": "This page holds",
  "的：接口、描写、记忆、联网、时段。": " — API, description, memory, web search, time of day.",
  "打字时框会自己长高，最多到 3 行，再长就在框里滚动。": "The box grows as you type, up to 3 lines, then it scrolls.",
  "回车就发": "Enter sends",
  "回车换行": "Enter makes a new line",
  "待总结": "To summarize",
  "待清理队列": "Cleanup queue",
  "条": "items",
  "上次归档": "Last archived",
  "还没跑过": "Not run yet",
  "缺 key": "No key",
  "缺 Key": "No key",
  "她本来就知道的东西（常识、原理、怎么写、某个东西是什么）直接回答，不联网。": "Things she already knows (common knowledge, principles, how to write something, what an object is) are answered without going online.",
  "只有你在输入框里": "Only when you type",
  "明确打": "explicitly",
  "时，才会真的上网查一次。": "does she actually search the web once.",
  "比如：": "For example:",
  "/搜 今天北京天气": "/search weather in Beijing today",
  "/搜 最近有什么新番": "/search any new anime this season",
  "这样设计是为了": "The point of this is",
  "—— 普通聊天完全不受影响。": " — normal chat is completely unaffected.",
  "搜索用的是": "Search uses",
  "tavily.com → 注册免费、每月 1000 次，不用绑卡。key 是": "tavily.com → free signup, 1000 searches a month, no card needed. The key starts with",
  "开头。": ".",
  "key 只存在你这台手机里，不会上传到任何地方。": "The key stays on this phone and is never uploaded anywhere.",
  "跟现实走": "Follow real time",
  "默认划分": "Default ranges",
  "点一下会真的把最近那份自动备份读出来，告诉你里面有多少角色 / 记录。": "This really reads your latest auto backup and tells you how many characters / records it holds.",
  "还没有。从酒馆的角色卡或预设文件导入时会自动带过来。": "None yet. Importing a character card or a preset file brings them over automatically.",
  "模型默认": "Model defaults to",
  "✅ 对得上": "✅ OK"
};
/**
 * 动态文本的翻译表：**直接用中文原文当 key**。
 *
 * 为什么不另起一套 key：代码里拼出来的文案（长按菜单、toast）散落在几千行里，
 * 每次都要"先去字典登记一个 key、再回来改代码"，很容易漏。
 * 直接拿原文查表，中文下原样返回 —— 没登记过的也不会变。
 */
const BY_ZH = {
  // 长按消息的菜单
  '编辑重发': 'Edit & resend',
  // ⚠️ v0.4.3：长按菜单新增的一项。它是 app.js 里动态拼出来的中文原文，
  //    不在这里登记，英文界面下就显示中文 —— 而 i18n-report 扫不到这类动态串，
  //    报告仍会显示 100%，只能靠人眼查（本次自查就是这么发现它的）。
  '当时的场景': 'Scene at the time',
  '复制文字': 'Copy text',
  '朗读这条': 'Read aloud',
  '删除这条': 'Delete',
  '重新生成': 'Regenerate',
  '从这里重聊': 'Rewind to here',
  '取消': 'Cancel',
  '确定': 'OK',
  '关闭': 'Close',
  // ⚠️ v0.4.4：「＋」抽屉与「附加内容」都是 app.js 里拼出来的中文原文，
  //    不在这里登记，英文界面下就是中文 —— i18n-report 扫不到这类动态串。
  '联网搜索': 'Web search',
  '本轮更改': 'This turn',
  '剧情方向': 'Plot direction',
  '发送图片': 'Send image',
  '附加内容': 'Attached',
  '附': 'Attach',
  '这一轮的附加内容': 'What was attached this turn',
  '（没填内容）': '(nothing filled in)',
  '（没搜成）': '(search did not run)',
  // ⚠️ v0.4.2.2：「上一轮的要求」余温条也是 app.js 里拼出来的（同上一批的性质）。
  '上一轮的要求还在延续：': 'Still in effect from last turn: ',
  '不再延续': "Don't carry it over",
  // 空状态
  '还没有角色。': 'No characters yet.',
  // ⚠️ 补上（v0.3.1）：这句原来是硬拼在 app.js 的 innerHTML 里、没走 tt()，
  //    所以英文界面下它一直是中文；接进 tt() 之后字典里必须有对应条目。
  '点左上角 ☰ → 角色列表 → 右上角 ＋ 建一个。':
    'Tap ☰ top-left → Characters → ＋ top-right to create one.',
  // ⚠️ v0.4.2.3（审计 F20）：「＋」参数槽与只读弹层里那几条【属性类】文案。
  //    title / placeholder 不在 applyI18n 的兜底范围内 —— 它只扫文本节点，
  //    带 data-i18n-en-ph 标注的只有 index.html 里那 6 个静态输入框。
  //    JS 拼出来的元素没有那个标注，所以必须自己走 tt() + 在这里登记。
  '知道了': 'Got it',
  '去掉这个功能': 'Remove this',
  '要搜什么？例如：今天北京天气': 'What to search? e.g. weather in Beijing today',
  '这一轮想怎么演？例如：用可爱向的写法': 'How should this turn read? e.g. write it cuter',
  '这一轮大概往哪走？例如：她开始起疑心，气氛往下沉': 'Where should the plot head this turn? e.g. she starts getting suspicious',
  '说明这张图…': 'Describe this image…',
  '上一批图片还在处理，稍等一下': 'Still processing the last batch, one moment',
  // v0.5.0 剧情卡。弹窗里的静态标注走 data-i18n-en，这里登记的是 app.js 拼出来的那几条
  // （空态提示是纯 JS 串，扫不到）。
  '还没拍。写个方向直接保存也行 —— 不发拍就只按方向走。': 'No beats yet. A direction alone is fine — it will follow that without beats.',
  '剧情卡已保存': 'Plot card saved',
  '剧情卡已清空': 'Plot card cleared',
  '这一段的剧情卡已关掉（内容还在）': 'Plot card turned off (its content is kept)',
  // v0.5.5 复读角标 + 长篇自动串联
  '复读': 'Repetitive',
  '阅读模式': 'Reading mode',
  '气泡已摊成段落 · 按剧情天数分章': 'Bubbles become paragraphs, one chapter per story day',
  '聊天气泡摊成段落': 'Chat as prose',
  '退出阅读': 'Exit reading',
  '写完一段自动接着写（只长篇生效）': 'Auto-continue after each segment (long-form only)',
  '不接着写': 'Do not continue',
  '连写 2 段': '2 segments total',
  '连写 3 段': '3 segments total',
  '连写 4 段': '4 segments total',
  '每一段都是独立请求、分别计费。只有想让她不用你再点「继续」时才开。': 'Each segment is a separate request and bills separately. Turn this on only if she should keep writing without another tap.',
  // ⚠️ v0.5.0.1：剧情卡弹窗里剩下的中文。
  //    静态标注靠 applyI18n 的兜底扫（扫文本节点、命中词典才换），
  //    动态的是 app.js 里 sc(…) 拼出来的 —— 两边都查这张表。
  '这段剧情往哪走': 'Where this story is going',
  '写出方向，她自己往下演；不用写台词，也不用写完整大纲。':
    'Write the direction and she plays it out; no lines, no full outline needed.',
  '只注入当前这一拍': 'Only the current beat is injected',
  '—— 后面几拍不进提示词，也不会被要求一次演完。':
    '— the later beats never enter the prompt and are not asked to be acted out at once.',
  '这段叫什么': 'What is this called',
  '（可空）': '(optional)',
  '想往哪走': 'Where should it go',
  '不能发生什么': 'What must not happen',
  '（一行一条）': '(one per line)',
  '几拍': 'Beats',
  '＋ 加一拍': '+ Add a beat',
  '这一拍叫什么（可空）': 'Name this beat (optional)',
  '设为当前': 'Set as current',
  '当前': 'Current',
  '删掉这一拍': 'Delete this beat',
  '要到': 'Reach',
  '卡在': 'Blocked by',
  '终点': 'Ends with',
  '这一拍要达到的地方': 'What this beat should reach',
  '卡在哪、谁不肯让': "Where it stalls, who won't give",
  '到这一拍结束才该发生的事': 'What only happens once this beat ends',
  '这段最后要走到哪儿。一句话就够，不用写台词，也不用写大纲。':
    'Where this stretch should end up. One line is enough - no dialogue, no outline.',
  '你最不想在这段里看到什么，一行写一条': 'What you do not want to see happen here, one per line',
  '只有你自己看，随便起': 'Just for you - name it anything',
  // v0.5.0.2：推进 / 状态 / 群聊各人的目的 / 删卡
  '现在演到': 'Now at',
  '还没拍': 'No beats yet',
  '这一拍演完了 →': 'This beat is done →',
  '这一段演完了 →': 'This arc is done →',
  '点右边那颗 = 这一拍收尾、立刻保存、走到下一拍。每拍下面写的「结果」会进下一轮的提示词。':
    'Tap the one on the right to close this beat, save it right away and move on. What you write under Result feeds into the next turn.',
  '还没演完': 'Not done yet',
  '✓ 演完了': '✓ Done',
  '结果': 'Result',
  '演完之后实际发生了什么（可空）': 'What actually happened (optional)',
  '这一拍已经收尾。这段走到头了 —— 想接着演就往下面加一拍':
    'That beat is closed. You are at the end of this arc — add another beat below to keep going.',
  '各人的目的': "Everyone's agenda",
  '群聊才用': 'Group chats only',
  '这一场里每个人想要什么。只给名字的话，模型会让所有人替同一件事说话。':
    'What each person wants in this scene. With names alone the model makes everyone push the same thing.',
  '（无名）': '(unnamed)',
  '这一场里他想要什么（可空）': 'What they want in this scene (optional)',
  '自动判定这一拍演完没有': 'Auto-detect when a beat is done',
  '（beta，每轮多一次小请求）': ' (beta, one extra small request per turn)',
  '删掉这张卡': 'Delete this card',
  '整张剧情卡都会删掉：方向、几拍、各人的目的。': 'The whole plot card is deleted: direction, beats, agendas.',
  '聊天记录不动。': 'Chat history is untouched.',
  // ⚠️ v0.5.2：小说层（开一场戏 / 书架 / 阅读页）。
  //    静态标注靠 index.html 的 data-i18n-en*，这里补的是 app.js 里拼出来的那些。
  '先建一个角色，再来开戏': 'Create a character first.',
  '空白开戏': 'Start blank',
  '从这段聊起来': 'Grow out of this chat',
  '从头起：只按下面填的地方、时间、人物写，不读聊天记录。':
    'From scratch: written only from the place, time and people you fill in below. Your chat is not read.',
  '从这段聊起来：把你们最近的聊天截一段当背景（只截文字，之后就独立了）—— 这场戏不会改动聊天，聊天变了也不影响它。':
    'Grows out of this chat: a slice of your recent chat is taken as background (text only, and only once) - the scene never edits it, and later chat changes do not touch it.',
  '这段聊天还没什么内容，按空白开戏写': 'This chat has nothing to draw on yet - starting blank.',
  '短 · 300–600 字': 'Short · 300–600 chars',
  '中 · 600–1200 字': 'Medium · 600–1200 chars',
  '你在场：你自己那句由你写，她、旁白、临时人物由模型写。模型不替你说话。':
    'You are in the scene: you write your own lines; she, the narration and the temporary people are written by the model. It never speaks for you.',
  '你不在场：你输入的是导演指令（不进正文、不进记忆），正文里不出现「你」。':
    'You are not in the scene: what you type is a direction (never part of the prose or memory), and the prose never says you.',
  '你在场，模型可以先替你说；你一开口就接手。':
    'You are in the scene and the model may speak for you first; the moment you start, it stops.',
  '还没写。': 'Nothing written yet.',
  '这一段没写完。': 'This part is unfinished.',
  '继续这一段': 'Continue this part',
  '重写这一段': 'Rewrite this part',
  '就这样': 'Keep it as is',
  '本场完': 'End of scene',
  '你这一句 / 你的动作': 'Your line / your action',
  '说': 'Say',
  '导演指令：让谁做什么（不进正文）': 'Direction: who does what (never enters the prose)',
  '导': 'Direct',
  '还在写上一段': 'Still writing the last part',
  '请求失败': 'Request failed',
  '模型这次一个字都没给': 'The model returned nothing',
  '这一段没写完（被长度截断）': 'This part is unfinished (cut off by length)',
  '想名字中…': 'Thinking of a name…',
  '没想出来，再点一次试试': 'Could not come up with one — tap again',
  '生成失败：': 'Generation failed: ',
  '从哪儿开始': 'Where it starts',
  '这一拍改变了什么': 'What this beat changes',
  '停在哪儿': 'Where it stops',
  '先选一个角色': 'Pick a character first',
  '在分拍…': 'Splitting into beats…',
  '分拍没成，先按一拍写': 'Could not split it — writing it as one beat',
  '在重新分拍…': 'Splitting again…',
  '还是没分好': 'Still could not split it',
  '删除这一场': 'Delete this scene',
  '删除': 'Delete',
  '已经和那段聊天断开了，正文还在': 'Detached from that chat; the prose stays',
  '恢复这一场': 'Restore this scene',
  '找回这一场了': 'Scene restored',
  '这一场没有临时人物': 'No temporary people in this scene',
  '连台词一起删': 'Delete their lines too',
  '还在写，写完再走': 'Still writing — let it finish',
  '接着往下写，别重复已经写过的': 'Keep going, do not repeat what is already written',
  '改这一场的拍': "Edit this scene's beats",
  '去掉这场里的人物…': 'Remove a character from this scene…',
  '断开与聊天的关联': 'Detach from the chat',
  '删除这一场（进回收站）': 'Delete this scene (to trash)',
  '演员': 'Actor',
  '导演': 'Director',
  '观众': 'Audience',
  // 书架那一行的元信息是分段拼的（长度 · 在场方式 · 字数），所以这三个也要能单独翻。
  '短': 'Short',
  '中': 'Medium',
  '字': 'chars',
  '没写完': 'Unfinished',
  '草稿': 'Draft',
  '回收站': 'Trash',
  '← 回书架': '← Back to shelf',
  '回收站是空的。': 'Trash is empty.',
  '还没有戏。点右上角 ＋ 开一场。': 'No scenes yet. Tap + at the top right to start one.',
  '撤销了': 'Undone',
  '只剩一拍，删了就没得写了': 'Only one beat left — deleting it leaves nothing to write.',
  '这一拍写出来的正文也会一起删掉。<br>删错了可以点下面的「撤销」。':
    'The prose written for this beat goes with it.<br>Deleted by mistake? Tap Undo right below.',
  // v0.5.0.3：剧情卡状态机（推进落盘 / 终态 / 撤销 / 节奏 / 内联条）
  '这一段演完了': 'This arc is done',
  '开新一段': 'Start a new arc',
  '清空': 'Clear',
  '清空方向、几拍、各人的目的，从空白开始。聊天记录不动。':
    'Clears the direction, the beats and every agenda, starting from a blank card. Chat history is untouched.',
  '清空了 —— 写个新方向吧': 'Cleared — write a new direction',
  '撤回到上一拍': 'Back to the previous beat',
  '保存失败：': 'Save failed: ',
  '关掉失败：': 'Could not turn it off: ',
  '这一拍没有可推进的内容': 'Nothing to advance here — this beat has no content',
  '这一拍像演完了：': 'This beat looks done: ',
  '这一拍像演完了': 'This beat looks done',
  '推进': 'Advance',
  '再演一轮': 'One more round',
  '这一段演完了 —— 这张卡不再进提示词': 'This arc is done — the card no longer reaches the prompt',
  '这张卡不会进提示词了。想接着演就加一拍；开新一段 = 清空方向和几拍，重新写一张。':
    'This card no longer reaches the prompt. Add a beat to keep going; start a new arc clears the direction and beats so you can write a fresh one.',
  '剧情卡已删掉': 'Plot card deleted',
  '删掉': 'Delete',
  '这一拍看样子演完了 —— 打开剧情卡确认要不要往前推':
    'This beat looks finished — open the plot card to decide whether to move on',
  // ⚠️ v0.5.0.4：off 语义改成「真暂停」之后新增的那几句。
  //    off 卡保存/加拍不再偷偷变 on，重开只有「重新开启」一条明路 —— 所以这条路的
  //    每一步都得说人话，不能靠界面自己猜。
  '这张卡已经关掉了，不会进提示词。想接着用就点右边那颗。':
    'This card is turned off, so it never reaches the prompt. To keep using it, tap the button on the right.',
  '重新开启': 'Reopen',
  '已重新开启 —— 这一轮开始它会进提示词': 'Reopened — it will reach the prompt from this turn on',
  '这张卡是关着的 —— 先点上面的「重新开启」，它才会进提示词。':
    'This card is turned off — tap Reopen above before it can reach the prompt.',
  '剧情卡已保存（这张卡是关着的）': 'Plot card saved (this card is turned off)',
  '「不能发生什么」写多了': 'Too many items under What must not happen',
  '丢掉': 'Drop',
  '这张卡是空的，先写个方向': 'This card is empty — write a direction first',
  '这张卡还是空的，先写个方向或填一拍': 'Still empty — write a direction or fill in a beat first',
  '删不掉：': 'Could not delete it: ',
  '撤销失败：': 'Undo failed: ',
  '已经推到下一拍了': 'Moved on to the next beat',
  '撤销': 'Undo',
  '撤回上一拍': 'Went back one beat',
  // ⚠️ 0.6.0：记忆 OS（收件箱 / 事实卡 / 槽位 / 拆分 / 本轮注入检查器）。
  //    这一批大多直接拼在 innerHTML 里、没走 tt，靠 applyI18n 的兜底扫文本节点翻 ——
  //    所以【必须】登记在这里，否则英文界面下整页中文（i18n-report 也扫不到这类串）。
  '按人看': 'By person',
  '按时间线看': 'By timeline',
  '待确认': 'Pending',
  '事实卡': 'By slot',
  '连「她以为」一起看': 'Also show what she assumes',
  '长期': 'Long-term',
  '建议拆开': 'Split suggested',
  '自定义': 'Custom',
  '她以为': 'She assumes',
  '她以为（不一定真）': 'What she assumes (not necessarily true)',
  '算数': 'Counts',
  '已被取代': 'Superseded',
  '已过期': 'Expired',
  '已删除': 'Deleted',
  '收下': 'Keep',
  '不收': 'Drop',
  '恢复': 'Restore',
  '事实': 'Fact',
  '事件': 'Event',
  '状态': 'State',
  '关系': 'Relationship',
  '物品': 'Item',
  '计划': 'Goal',
  '一直算数': 'Always counts',
  '只在这一条线': 'This branch only',
  '只在小说里': 'Scenes only',
  '没归槽的': 'No slot',
  '模型没归槽，不会自动顶替': 'No slot from the model, so it replaces nothing',
  '这一条现在没有在用的说法。': 'Nothing in use at this slot right now.',
  '模型拿不准的先落在这儿，不进提示词。收下才会进她的脑子。':
    'Whatever the model was unsure of lands here and stays out of the prompt. Keep it and she remembers it.',
  '没有待确认的。她自动记下都够确定，不用你操心。':
    'Nothing pending. Everything she noted on her own was clear enough.',
  '她还没记住什么。': 'She has not remembered anything yet.',
  '已删除的角色': 'Deleted character',
  '怎么拆': 'How',
  '拆': 'Split',
  '拆成几条': 'Split into memories',
  '至少要有两条才叫拆开': 'Needs at least two lines to split',
  '一行一条，一条只说一件事。改完点保存 —— 原来那条会标成「已被取代」，随时能恢复。':
    'One line each, one thing per line. Save it and the original is marked superseded — you can always bring it back.',
  '修改这条记忆': 'Edit this memory',
  '槽位，比如 identity.job，可留空': 'Slot, e.g. identity.job — optional',
  '同一槽位的新说法会顶掉旧的（旧的留着能恢复）。留空 = 不归槽，照样注入。':
    'A newer claim in the same slot replaces the older one (kept, and restorable). Empty = no slot; it is still injected.',
  '在某一天之后不再记着': 'Stop remembering after a certain day',
  '天之后不再记着': 'onwards — stop remembering',
  '第': 'Day',
  '为止（留空 = 那一天过完）': 'until then (empty = the whole day)',
  '收下了，下一轮起她会记得': 'Kept — she remembers it from the next turn',
  '没记这条（在「已删除」里还能撤回）': 'Not kept (you can undo it under Deleted)',
  '那条已经不在这一屏（可能归档了，或在另一条线上）':
    'That message is not on this screen (archived, or on another branch)',
  '看原话': 'Show the words',
  '（这条包含不止一件事，建议去记忆页拆开）':
    '(holds more than one thing — split it on the memory page)',
  '剧情卡': 'Plot card',
  // ⚠️ '本轮更改' 在 :531 已经登记过（那时检查器的标题是「本轮更改」）。这里不重复登记，
  //    重复的 key 是 tsc 的 TS1117（语法错），ci-check 会直接拦下来。

  '世界书 · 命中': 'Worldbook · matched',
  '世界书 · 常驻': 'Worldbook · always',
  '这一轮除了人设和聊天记录，什么附加内容都没注入。':
    'Nothing extra was injected this turn beyond the persona and the chat history.',
  '人设、聊天记录、滚动摘要每轮都在，这里不逐条列。':
    'The persona, the chat history and the rolling summary are always there; they are not listed one by one.',
  // 记忆为什么被选进来的说法（mempick.js 的 KIND_WHY）与没进来的原因
  '你钉住的': 'pinned by you',
  '她想做但还没做到': 'what she wants but has not done',
  '两人关系': 'between the two of you',
  '当前状态': 'current state',
  '最近发生的': 'happened recently',
  '她以为的': 'what she assumes',
  '较早的事实': 'older facts',
  '只在小说里用': 'scenes only',
  '不在这条故事线上': 'not on this branch',
  '预算不足': 'out of budget',
  '别人的私事，她不知道': "someone else's business — she does not know",
  '她进群之前的事': 'before she joined the group',
  // 时间线那张图里「类型 · 状态」是拼成整串塞进一个 span 的，所以组合也得登记。
  '事件 · 已过期': 'Event · expired',
  '事实 · 已过期': 'Fact · expired',
  '事件 · 已被取代': 'Event · superseded',
  '事实 · 已被取代': 'Fact · superseded',
  '这个人还没有带天数的事件。事件型记忆会记下是第几天发生的。':
    'No dated events for this character yet. Event memories record which day they happened.',
  // 事实卡的分组名（KEY_HEAD_NAME）与几个常见槽位的人话名（KEY_FULL_NAME）
  '身份': 'Identity',
  '地方': 'Place',
  '身体': 'Body',
  '称呼': 'Address',
  '打算': 'Plans',
  '东西': 'Things',
  '他是做什么的': 'What he does',
  '他叫什么': 'His name',
  '他多大': 'His age',
  '他住哪': 'Where he lives',
  '他此刻在哪': 'Where he is now',
  '他在哪上班': 'Where he works',
  '他身体怎么样': 'How his body is',
  '他跟她算什么': 'What they are to each other',
  '他怎么称呼她': 'What he calls her',
  '她眼下想做什么': 'What she wants to do now',
};

let _lang = 'zh';       // 实际生效的（'zh' / 'en'）
let _pref = 'system';   // 用户选的（'system' / 'zh' / 'en'）

/**
 * 把"用户的选择"解析成"实际生效的语言"。
 *
 * 'system' 时看 navigator.language —— Android WebView 会把它设成手机的语言，
 * 所以手机换语言、App 跟着变。非中文一律落到英文（比落到中文更有用）。
 */
function resolve(pref) {
  if (pref === 'en') return 'en';
  if (pref === 'zh') return 'zh';
  let nav = '';
  try { nav = String(navigator.language || '').toLowerCase(); } catch { /* 取不到就当中文 */ }
  return nav.startsWith('zh') ? 'zh' : (nav ? 'en' : 'zh');
}

/** 语言只在设置里改，启动时由 init 灌进来 */
export function setLang(l) {
  _pref = (l === 'en' || l === 'zh') ? l : 'system';
  _lang = resolve(_pref);
}
/** 返回【用户的选择】（'system' 也算一种选择，下拉要显示它） */
export function getLang() { return _pref; }
/** 当前实际生效的语言 */
export function getActiveLang() { return _lang; }
/** 系统语言变了之后重新解析一次（比如 App 回到前台时） */
export function refreshLang() { _lang = resolve(_pref); return _lang; }

/** 代码里拼出来的文本走这里。中文直接返回 key 对应的原文（就是中文本身） */
const ZH = {
  'drawer.worldbook': '世界书',
  'drawer.settings': '全部设置',
  'drawer.chars': '角色列表',
  'drawer.profile': '我的相关设定',
  'drawer.about': '关于',
  'drawer.global': '全局设置',
  'drawer.global.s': '接口 / 描写 / 记忆',
  'drawer.mine': '我的设置',
  'drawer.mine.s': '头像 / 外观 / 数据',
  'drawer.worldbook.s': '按关键词注入设定',
  'drawer.settings.s': '接口 / 记忆 / 外观',
  'drawer.about.s': '版本与许可',
  'drawer.read': '阅读模式',
  'drawer.read.s': '聊天气泡摊成段落',
  'drawer.read.off': '退出阅读',
  'drawer.scene': '写一场戏',
  'drawer.scene.s': '一次坐下来写成一篇',
  'drawer.shelf': '书架',
  'drawer.shelf.s': '已经写出来的场',
  'common.language': '语言',
  'about.title': '关于',
};
export function t(key) {
  const m = _lang === 'en' ? MAP.en : ZH;
  return (m && m[key]) || ZH[key] || key;
}

/** 按中文原文翻译（动态拼出来的文案用它） */
/**
 * 组合出来的文案（v0.4.2）。
 * 「第 4 天」「共 12 字」这种是拼出来的，查表查不到 —— 所以再给一张【按模式】的表。
 * ⚠️ 只在英文下生效；中文路径一个字节都不动（和 tt 同一条硬约束）。
 */
/** @type {Array<[RegExp, (m: RegExpExecArray) => string]>} */
const BY_PATTERN = [
  [/^第 (\d+) 天$/, (m) => 'Day ' + m[1]],
  [/^第 (\d+) 年 (\d+) 天$/, (m) => 'Year ' + m[1] + ', day ' + m[2]],
  [/^共 (\d+) 字$/, (m) => m[1] + ' chars'],
  [/^(\d+) 字$/, (m) => m[1] + ' chars'],
  [/^已有 (\d+) 字$/, (m) => m[1] + ' chars so far'],
  [/^已选 (\d+) \/ (\d+)$/, (m) => 'Selected ' + m[1] + ' / ' + m[2]],
  [/^(.+?)（(\d+):00-(\d+):00）$/, (m) => m[1] + ' (' + m[2] + ':00–' + m[3] + ':00)'],
  [/^(\d+):00-(\d+):00$/, (m) => m[1] + ':00–' + m[2] + ':00'],
  [/^(\d+) 行$/, (m) => m[1] + (m[1] === '1' ? ' line' : ' lines')],
  [/^\/ (\d+) 条$/, (m) => '/ ' + m[1] + ' items'],
  [/^· 模型默认 (.+)$/, (m) => '· Default model ' + m[1]],
  // v0.5.0.1 剧情卡：拍号与删除确认都是「固定词 + 数字」拼出来的
  [/^第 (\d+) 拍$/, (m) => 'Beat ' + m[1]],
  [/^删掉第 (\d+) 拍？$/, (m) => 'Delete beat ' + m[1] + '?'],
  [/^演到第 (\d+) 拍$/, (m) => 'Now at beat ' + m[1]],
  // v0.5.0.4：下面这几条都是「固定词 + 数字」拼出来的完整句子，精确表里放不下
  [/^演了 (\d+) 轮 \/ 至少 (\d+) 轮$/, (m) => 'played ' + m[1] + (m[1] === '1' ? ' round' : ' rounds') + ' / at least ' + m[2]],
  [/^这一拍才演 (\d+) 轮，至少 (\d+) 轮才算演完 —— 别急着点。$/,
    (m) => 'Only ' + m[1] + (m[1] === '1' ? ' round' : ' rounds') + ' into this beat; at least ' + m[2] + ' before it counts as done — no rush.'],
  [/^第 (\d+) 拍：(.*) · 第 (\d+) 轮$/, (m) => 'Beat ' + m[1] + ': ' + m[2] + ' · round ' + m[3]],
  [/^最多只留 (\d+) 条，下面这些会丢掉：$/, (m) => 'Only ' + m[1] + ' can be kept; these will be dropped:'],
  [/^第 (\d+) 拍：(.+)$/, (m) => 'Beat ' + m[1] + ': ' + m[2]],
  // v0.5.0.3：轮数与推进
  [/^第 (\d+) 拍：(.*) · 第 (\d+) 轮$/, (m) => 'Beat ' + m[1] + ': ' + m[2] + ' · round ' + m[3]],
  [/^第 (\d+) 拍 · 第 (\d+) 轮$/, (m) => 'Beat ' + m[1] + ' · round ' + m[2]],
  // v0.5.2 小说层：夜号、拍号、字数、进度这些都是「固定词 + 数字」拼出来的
  [/^第 (\d+) 夜$/, (m) => 'Night ' + m[1]],
  [/^第 (\d+) 夜 · (.+)$/, (m) => 'Night ' + m[1] + ' · ' + m[2]],
  [/^（正在写第 (\d+) 拍…）$/, (m) => '(writing beat ' + m[1] + '…)'],
  [/^最多 (\d+) 个临时人物$/, (m) => 'At most ' + m[1] + ' temporary people'],
  [/^回收站（(\d+)）$/, (m) => 'Trash (' + m[1] + ')'],
  [/^去掉「(.+)」$/, (m) => 'Removed “' + m[1] + '”'],
  [/^已去掉 (.+)$/, (m) => 'Removed ' + m[1]],
  [/^(\d+) 拍$/, (m) => m[1] + (m[1] === '1' ? ' beat' : ' beats')],
  // 小说层删一拍（注意：剧情卡那条带问号，这里不带，两条互不影响）
  [/^删掉第 (\d+) 拍$/, (m) => 'Delete beat ' + m[1]],
  [/^删掉了第 (\d+) 拍$/, (m) => 'Deleted beat ' + m[1]],
  [/^演了 (\d+) 轮 \/ 至少 (\d+) 轮$/, (m) => 'round ' + m[1] + ' / at least ' + m[2]],
  [/^演到第 (\d+) 拍（已保存）$/, (m) => 'Now at beat ' + m[1] + ' (saved)'],
  [/^这一拍才演 (\d+) 轮，至少 (\d+) 轮才算演完 —— 别急着点。$/,
    (m) => 'Only ' + m[1] + ' rounds so far; ' + m[2] + ' is the minimum before this beat counts as done — hold on.'],
  // v0.6.0 记忆 OS：记忆页 / 检查器里的数字拼串（「记于第 N 天」「有 N 条旧记忆…」「没进来的（N 条）」）。
  // ⚠️ `(\d+) 条` 是通用条目数，放在这里比放精确表里可靠 —— 分组标题、收件箱角标都是拼出来的。
  [/^记于第 (\d+) 天$/, (m) => 'Noted day ' + m[1]],
  [/^(\d+) 条$/, (m) => m[1] + (m[1] === '1' ? ' item' : ' items')],
  [/^以前的说法（(\d+)）$/, (m) => 'Previous takes (' + m[1] + ')'],
  [/^来自 (\d+) 条$/, (m) => 'from ' + m[1] + (m[1] === '1' ? ' message' : ' messages')],
  [/^有 (\d+) 条旧记忆里装着好几件事，她一次全倒出来容易串味。$/,
    (m) => m[1] + (m[1] === '1' ? ' old memory holds' : ' old memories hold')
      + ' several things at once, and she tends to dump them all in one go.'],
  [/^拆成了 (\d+) 条$/, (m) => 'Split into ' + m[1] + ' memories'],
  [/^没进来的（(\d+) 条）$/, (m) => 'Left out (' + m[1] + ')'],
  [/^约 (\d+) token$/, (m) => 'about ' + m[1] + ' tokens'],
  [/^条数满了（已用 (\d+) 条）$/, (m) => 'No room left (' + m[1] + ' already)'],
  [/^长期记忆（(\d+) 条）$/, (m) => 'Long-term memory (' + m[1] + ')'],
  [/^长期记忆（(\d+) 条，约 (\d+) token）$/, (m) => 'Long-term memory (' + m[1] + ', about ' + m[2] + ' tokens)'],
  [/^长期记忆（(\d+) 条，条数已满）$/, (m) => 'Long-term memory (' + m[1] + ', at the cap)'],
  [/^长期记忆（(\d+) 条，约 (\d+) token，条数已满）$/,
    (m) => 'Long-term memory (' + m[1] + ', about ' + m[2] + ' tokens, at the cap)'],
  // 检查器（这一轮用了什么）里的小节计数与拍号：「剧情方向（2）」「第 1/2 拍」
  [/^（(\d+)）$/, (m) => ' (' + m[1] + ')'],
  [/^第 (\d+)\/(\d+) 拍$/, (m) => 'Beat ' + m[1] + '/' + m[2]],
];

/** 只查词典、不看当前语言（v0.5.0.1 抽出来的）。
 *  为什么要它：data-i18n-nodes 的元素【只在第一次遇到时】算一遍英文缓存，
 *  而那一次多半发生在中文状态下 —— 走 tt() 会因为它「中文下原样返回」把英文串成中文，
 *  于是这些元素（版本行、「第 X 年 Y 天」……）切到英文后永远不翻。 */
function _tr(zh) {
  // 用 in 而不是真值判断：「点」这类单位在英文里就该是空串，falsy 判会把它漏掉。
  if (zh in BY_ZH) return BY_ZH[zh];
  if (zh in EXTRA_ZH) return EXTRA_ZH[zh];
  for (const [re, f] of BY_PATTERN) { const m = re.exec(String(zh)); if (m) return f(m); }
  return zh;
}

export function tt(zh) {
  if (_lang !== 'en') return zh;          // 中文下原样返回，一个字节都不动
  return _tr(zh);
}

/**
 * 把 DOM 上的静态文本按当前语言刷一遍。
 *
 * @param root 从哪个节点往下找（默认整个 document）
 *
 * 原文存在元素的 dataset 里（第一次遇到时记下），所以切回中文永远能还原 ——
 * 不依赖 ZH 字典里有没有那条，也就不可能"翻回中文反而变了字"。
 */
let _observer = null;
let _applying = false;
let _obsTimer = null;

/**
 * 英文模式下挂一个 DOM 观察者（v0.4.2）。
 *
 * 为什么需要：设置页里那些小字、状态行、下拉项是【异步渲染】出来的 ——
 * 切视图时扫一遍会扫在它们出现之前，于是英文界面里夹着中文。
 * 观察者只在英文下挂，回调里防抖 200ms 再扫；扫的时候置 _applying，
 * 并且【只在内容真的会变时才写 DOM】，所以不会自己触发自己。
 */
export function watchI18n() {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return;
  if (_observer) {
    if (_lang !== 'en') { _observer.disconnect(); _observer = null; }
    return;
  }
  if (_lang !== 'en') return;
  _observer = new MutationObserver(() => {
    if (_applying || _lang !== 'en') return;
    clearTimeout(_obsTimer);
    _obsTimer = setTimeout(() => applyI18n(), 200);
  });
  _observer.observe(document.body, { childList: true, subtree: true, characterData: true });
}

export function applyI18n(root) {
  _applying = true;
  try { _applyI18n(root); } finally { _applying = false; }
}

function _applyI18n(root) {
  const box = root || document;
  for (const el of box.querySelectorAll('[data-i18n-en]')) {
    // ⚠️ 只处理"纯文本"元素。textContent 赋值会【销毁子元素】——
    // 像 <span>温度 <b id="v-temp">1</b>（低=沉稳…）</span> 这种，
    // 替换一次就把里面的 <b> 删了，切回中文也回不来，
    // 后面 $('v-temp').textContent = ... 就直接改到空气里。
    // 这类带结构的标签要拆开标记（给内层的纯文本节点标），不能整块标。
    if (el.children.length) continue;
    if (el.dataset.i18nZh === undefined) el.dataset.i18nZh = el.textContent;
    // ⚠️ 中文下【不要】无脑把缓存的原文写回去（v0.4.2 修）：
    //    这些元素里有一部分是 JS 会改的（群世界书的标题、聊天页页眉、字数统计……）。
    //    原来每次 applyI18n 都拿"第一次看到的那份中文"覆盖，于是 JS 刚写进去的值被改回旧值 ——
    //    CI 上抓到的「标题变成了"单独角色"」「页眉变成了"未选择角色"」就是这么来的。
    //    现在的规矩：只在【确实是我们写进去的英文】时才还原中文。
    if (_lang === 'en') {
      if (el.textContent !== el.dataset.i18nEn) el.textContent = el.dataset.i18nEn;
      el.dataset.i18nApplied = '1';
    } else if (el.dataset.i18nApplied === '1') {
      if (el.textContent !== el.dataset.i18nZh) el.textContent = el.dataset.i18nZh;
      delete el.dataset.i18nApplied;
    }
  }
  // 【兜底扫一遍所有文本节点】（v0.4.2）：JS 拼出来的界面文案（toast/状态行/下拉项……）
  // 没法逐个标属性，但它们的文字恰好都在 BY_ZH / EXTRA_ZH 里 —— 所以整篇扫一遍，
  // 命中就换。查不到的（她的台词、人设、用户输入）原样留着。
  // ⚠️ 必须跳过【内容区】：聊天记录、输入框、以及明确标了 .no-i18n 的地方 ——
  //    否则一条内容恰好等于「取消」两个字的消息会被翻成 "Cancel"。
  {
    const inContent = (el) => {
      let p = el;
      while (p && p !== box) {
        if (p.nodeType === 1) {
          const tag = p.tagName;
          if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SCRIPT' || tag === 'STYLE') return true;
          if (p.id === 'messages' || (p.classList && (p.classList.contains('no-i18n') || p.classList.contains('bub')))) return true;
        }
        p = p.parentNode;
      }
      return false;
    };
    const all = box.querySelectorAll ? box.querySelectorAll('*') : [];
    for (const el of all) {
      if (inContent(el)) continue;
      for (const n of el.childNodes) {
        if (n.nodeType !== 3) continue;
        const raw = n.textContent;
        const t = raw.replace(/\s+/g, ' ').trim();
        // ⚠️ 「含中文才处理」这条只对【英文】成立（v0.5.0.1 修）：
        //    英文下没中文就没得翻，跳过是对的；但中文下要还原的恰恰是【我们翻成英文的那份】——
        //    它一个中文都没有，原来的 continue 会把还原也一起挡掉，于是靠兜底扫翻过的界面文字
        //    切回中文后永久留在英文（要重启 App 重新加载 index.html 才恢复）。
        if (_lang === 'en') {
          if (!t || !/[\u4e00-\u9fa5]/.test(t)) continue;
        } else if (n.__en === undefined) continue;
        // ⚠️ 只动【我们自己写进去的那份】（v0.4.2 修）：
        //    第一版在中文下无条件把节点恢复成"第一次看到时的原文"，于是 JS 后来更新过的
        //    文字会被悄悄地改回旧值 —— 群世界书标题被改回「单独角色」、聊天页页眉被改回
        //    「未选择角色」都是这么来的（CI 环境里被抓到的）。
        //    现在的规矩：英文下命中词典才写，并记下我们写的是什么；中文下只把【还等于我们
        //    写的那份】的节点还原 —— 别人改过的（JS 更新过的）一个字都不碰。
        if (_lang === 'en') {
          const en = tt(t);
          if (en !== t) {
            const lead = (/^\s*/.exec(raw) || [''])[0];
            const tail = (/\s*$/.exec(raw) || [''])[0];
            const want = lead + en + tail;
            if (n.textContent !== want) {
              n.__zh = raw;
              n.__en = want;
              n.textContent = want;
            }
          }
        } else if (n.__en !== undefined && n.textContent === n.__en) {
          if (n.__zh !== undefined && n.textContent !== n.__zh) n.textContent = n.__zh;
        }
      }
    }
  }

  // 【文字夹着动态值】的块（v0.4.2）：<span>共 <b id=x>12</b> 字</span> 这种。
  // ⚠️ 不能整块换 innerHTML —— 那会把带 id、带监听的子元素重建掉（上面的注释就是为这个写的）。
  //    这里只按顺序翻【文本节点】，子元素原封不动；查不到译文的那段原样留着。
  for (const el of box.querySelectorAll('[data-i18n-nodes]')) {
    const nodes = [...el.childNodes].filter(n => n.nodeType === 3);
    if (!nodes.length) continue;
    // ⚠️ 缓存对不上就重建（v0.5.0.1）：JS 可能后来改了子节点的个数/顺序，
    //    对不上还硬按老数组写，会把内容写错位或写出 undefined。
    if (el.dataset.i18nNodesZh) {
      let n0 = 0;
      try { n0 = JSON.parse(el.dataset.i18nNodesZh).length; } catch { n0 = -1; }
      if (n0 !== nodes.length) { delete el.dataset.i18nNodesZh; delete el.dataset.i18nNodesEn; }
    }
    if (!el.dataset.i18nNodesZh) {
      el.dataset.i18nNodesZh = JSON.stringify(nodes.map(n => n.textContent));
      el.dataset.i18nNodesEn = JSON.stringify(nodes.map(n => {
        const raw = n.textContent;
        const t = raw.replace(/\s+/g, ' ').trim();
        if (!t) return raw;
        // ⚠️ 必须用 _tr 而不是 tt（v0.5.0.1）：缓存建立时多半还在中文下，
        //    tt() 那时原样返回，enArr 会整份存成中文 —— 之后切英文写回去的还是中文。
        const en = _tr(t);
        if (!en) return raw;
        // 保住原样的前后空白，免得两个片段粘在一起
        const lead = (/^\s*/.exec(raw) || [''])[0];
        const tail = (/\s*$/.exec(raw) || [''])[0];
        return lead + en + tail;
      }));
    }
    const zhArr = JSON.parse(el.dataset.i18nNodesZh);
    const enArr = JSON.parse(el.dataset.i18nNodesEn);
    nodes.forEach((n, k) => { n.textContent = _lang === 'en' ? enArr[k] : zhArr[k]; });
  }

  // placeholder 单独一套属性：它是要改 attribute，不是 textContent
  for (const el of box.querySelectorAll('[data-i18n-en-ph]')) {
    if (el.dataset.i18nZhPh === undefined) el.dataset.i18nZhPh = el.getAttribute('placeholder') || '';
    el.setAttribute('placeholder', _lang === 'en' ? el.dataset.i18nEnPh : el.dataset.i18nZhPh);
  }
  // title 同理（v0.5.0.1）。原来只认 placeholder，「剧情」那颗按钮的 title 一直是中文 ——
  // 属性不在兜底扫的范围内，长按看到的就是一句中文夹在英文界面里。
  for (const el of box.querySelectorAll('[data-i18n-en-title]')) {
    if (el.dataset.i18nZhTitle === undefined) el.dataset.i18nZhTitle = el.getAttribute('title') || '';
    el.setAttribute('title', _lang === 'en' ? el.dataset.i18nEnTitle : el.dataset.i18nZhTitle);
  }
  // 带格式的段落（说明文字里常夹着 <b> / <br>）：整块换 innerHTML。
  // ⚠️ 只能用在【纯展示】的段落上 —— innerHTML 赋值会把里面的元素重建一遍，
  //    谁要是有 id、有事件监听、或者会被 JS 更新，就会被摧毁。
  //    所以这里刻意跳过任何内含 id= 的块（那种段落要拆开标内层）。
  for (const el of box.querySelectorAll('[data-i18n-en-html]')) {
    if (/id=/.test(el.innerHTML)) continue;
    if (el.dataset.i18nZhHtml === undefined) el.dataset.i18nZhHtml = el.innerHTML;
    el.innerHTML = _lang === 'en' ? el.dataset.i18nEnHtml : el.dataset.i18nZhHtml;
  }
}
