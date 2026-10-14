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

/** 展示用的短词（v0.4.2 补全翻译时加的）：时段 / 季节 / 天气 / 计数 / 空态 */
const EXTRA_ZH = {
  '凌晨': 'Small hours', '早上': 'Morning', '上午': 'Late morning', '中午': 'Noon',
  '下午': 'Afternoon', '傍晚': 'Dusk', '晚上': 'Evening', '深夜': 'Late night',
  '春': 'Spring', '夏': 'Summer', '秋': 'Autumn', '冬': 'Winter',
  '晴': 'Clear', '多云': 'Cloudy', '阴': 'Overcast', '雨': 'Rain',
  '雷雨': 'Thunderstorm', '雪': 'Snow', '风': 'Windy', '雾': 'Fog',
  '（空的）': '(empty)', '还没有': 'None yet', '未填': 'Not set', '未选择角色': 'No character selected',
  '离线': 'Offline', '跟随手机时间': 'Following the phone clock', '无': 'none',
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
  '复制文字': 'Copy text',
  '朗读这条': 'Read aloud',
  '删除这条': 'Delete',
  '重新生成': 'Regenerate',
  '从这里重聊': 'Rewind to here',
  '取消': 'Cancel',
  '确定': 'OK',
  '关闭': 'Close',
  // 空状态
  '还没有角色。': 'No characters yet.',
  // ⚠️ 补上（v0.3.1）：这句原来是硬拼在 app.js 的 innerHTML 里、没走 tt()，
  //    所以英文界面下它一直是中文；接进 tt() 之后字典里必须有对应条目。
  '点左上角 ☰ → 角色列表 → 右上角 ＋ 建一个。':
    'Tap ☰ top-left → Characters → ＋ top-right to create one.',
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
const BY_PATTERN = [
  [/^第 (\d+) 天$/, (m) => 'Day ' + m[1]],
  [/^第 (\d+) 年 (\d+) 天$/, (m) => 'Year ' + m[1] + ', day ' + m[2]],
  [/^共 (\d+) 字$/, (m) => m[1] + ' chars'],
  [/^(\d+) 字$/, (m) => m[1] + ' chars'],
  [/^已有 (\d+) 字$/, (m) => m[1] + ' chars so far'],
  [/^已选 (\d+) \/ (\d+)$/, (m) => 'Selected ' + m[1] + ' / ' + m[2]],
  [/^(.+?)（(\d+):00-(\d+):00）$/, (m) => m[1] + ' (' + m[2] + ':00–' + m[3] + ':00)'],
  [/^(\d+):00-(\d+):00$/, (m) => m[1] + ':00–' + m[2] + ':00'],
];

export function tt(zh) {
  if (_lang !== 'en') return zh;          // 中文下原样返回，一个字节都不动
  if (BY_ZH[zh]) return BY_ZH[zh];
  if (EXTRA_ZH[zh]) return EXTRA_ZH[zh];
  for (const [re, f] of BY_PATTERN) { const m = re.exec(String(zh)); if (m) return f(m); }
  return zh;
}

/**
 * 把 DOM 上的静态文本按当前语言刷一遍。
 *
 * @param root 从哪个节点往下找（默认整个 document）
 *
 * 原文存在元素的 dataset 里（第一次遇到时记下），所以切回中文永远能还原 ——
 * 不依赖 ZH 字典里有没有那条，也就不可能"翻回中文反而变了字"。
 */
export function applyI18n(root) {
  const box = root || document;
  for (const el of box.querySelectorAll('[data-i18n-en]')) {
    // ⚠️ 只处理"纯文本"元素。textContent 赋值会【销毁子元素】——
    // 像 <span>温度 <b id="v-temp">1</b>（低=沉稳…）</span> 这种，
    // 替换一次就把里面的 <b> 删了，切回中文也回不来，
    // 后面 $('v-temp').textContent = ... 就直接改到空气里。
    // 这类带结构的标签要拆开标记（给内层的纯文本节点标），不能整块标。
    if (el.children.length) continue;
    if (el.dataset.i18nZh === undefined) el.dataset.i18nZh = el.textContent;
    el.textContent = _lang === 'en' ? el.dataset.i18nEn : el.dataset.i18nZh;
  }
  // placeholder 单独一套属性：它是要改 attribute，不是 textContent
  for (const el of box.querySelectorAll('[data-i18n-en-ph]')) {
    if (el.dataset.i18nZhPh === undefined) el.dataset.i18nZhPh = el.getAttribute('placeholder') || '';
    el.setAttribute('placeholder', _lang === 'en' ? el.dataset.i18nEnPh : el.dataset.i18nZhPh);
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
