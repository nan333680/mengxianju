// e2e-stregex.mjs — 酒馆正则引擎（v0.4.0）
//
// 这一套【不起浏览器】：stregex.js 是纯函数（不碰 DOM、不碰数据库），
// 所以直接 import 进来跑，几十毫秒出结果。
//
// 钉住的核心是那条红线：正则只作用于【副本】—— applyStRegex 只返回新字符串，
// 不碰传进来的脚本对象，也不碰任何存档。存档原文永远是原样。
import { splitRegex, safeRegExp, parseStRegex, parseStRegexList, applyStRegex, scriptActive, previewOne }
  from '../www/js/stregex.js';

let pass = 0, fail = 0;
const t = (n, ok, ex) => { if (ok) { pass++; console.log('  OK   ' + n); } else { fail++; console.log('  FAIL ' + n + (ex !== undefined ? '  -> ' + JSON.stringify(ex) : '')); } };
const BS = String.fromCharCode(92);   // 反斜杠，省得在源码里绕转义

console.log('=== 1. findRegex 的拆解 ===');
let r = splitRegex('/abc/gi');
t('/abc/gi 拆成 abc + gi', r.src === 'abc' && r.flags === 'gi', r);
r = splitRegex('plain');
t('裸 pattern 原样保留、没有 flags', r.src === 'plain' && r.flags === '', r);
r = splitRegex('/a' + BS + '/b/gi');
t('带转义斜杠的找【最后一个】斜杠（找第一个就切错了）', r.src === 'a' + BS + '/b' && r.flags === 'gi', r);
r = splitRegex('/x/zz');
t('非法 flags 被滤掉', r.src === 'x' && r.flags === '', r);

console.log('=== 2. 编不出来的正则 ===');
t('语法错的 pattern → null', safeRegExp('(', '') === null);
t('空 pattern → null', safeRegExp('', '') === null);
t('超长 pattern → null（外面来的东西，不编）', safeRegExp('a'.repeat(4001), '') === null);
t('正常 pattern 编得出来', safeRegExp('a+', 'g') instanceof RegExp);

console.log('=== 3. 一条酒馆脚本 → 我们的形状 ===');
let s = parseStRegex({ scriptName: '去粗体', findRegex: '/[*][*](.+?)[*][*]/g', replaceString: '$1', placement: [2] }, '卡：甲');
t('认得出名字', s && s.name === '去粗体', s);
t('默认开着（作者没关，我们不自作主张）', s && s.enabled === true, s);
t('默认两边都改', s && s.display === true && s.prompt === true, s);
t('来源带过来了', s && s.source === '卡：甲', s);

s = parseStRegex({ scriptName: '关着的', findRegex: 'x', replaceString: 'y', disabled: true });
t('作者关掉的照样关着', s && s.enabled === false, s);

s = parseStRegex({ scriptName: '写坏了', findRegex: '(', replaceString: 'y' });
t('编不出来的默认关着（不让它假装生效）', s && s.enabled === false, s);
t('并且留下原因', s && s.note.includes('编不出来'), s && s.note);

s = parseStRegex({ scriptName: '只管斜杠命令', findRegex: 'x', replaceString: 'y', placement: [3, 4] });
t('只挂酒馆斜杠命令/世界书的默认关着', s && s.enabled === false, s);
t('并且说明为什么', s && s.note.includes('斜杠命令'), s && s.note);

s = parseStRegex({ scriptName: '只改显示', findRegex: 'x', replaceString: 'y', markdownOnly: true });
t('markdownOnly → 只改显示、不改提示词', s && s.display === true && s.prompt === false, s);
s = parseStRegex({ scriptName: '只改提示词', findRegex: 'x', replaceString: 'y', promptOnly: true });
t('promptOnly → 只改提示词、不改显示', s && s.display === false && s.prompt === true, s);

s = parseStRegex({ name: '老字段名', regex: 'a', replacement: 'b', trimStrings: ['X'] });
t('老字段名（name / regex / replacement）也认', s && s.name === '老字段名' && s.find === 'a' && s.replace === 'b', s);
t('trimStrings 带过来了', s && s.trim.length === 1 && s.trim[0] === 'X', s);

t('不是对象 → null', parseStRegex(null) === null);
t('没有 findRegex → null', parseStRegex({ scriptName: '空' }) === null);
t('数组里混着垃圾也不炸', parseStRegexList([null, 5, { findRegex: 'a', replaceString: 'b' }], 'x').length === 1);
t('不是数组 → 空表', parseStRegexList('nope', 'x').length === 0);

console.log('=== 4. 应用：作用域与深度 ===');
const mk = (o) => parseStRegex(Object.assign({ findRegex: 'x', replaceString: 'Y', placement: [2] }, o));
const onlyDisplay = mk({ scriptName: 'd', markdownOnly: true });
const onlyPrompt = mk({ scriptName: 'p', promptOnly: true });
const both = mk({ scriptName: 'b' });
const off = mk({ scriptName: 'off', disabled: true });
const deep = mk({ scriptName: 'deep', minDepth: 2, maxDepth: 3 });

t('display 模式跳过 promptOnly 的', applyStRegex('x', [onlyPrompt], 'display', 0) === 'x');
t('display 模式应用 markdownOnly 的', applyStRegex('x', [onlyDisplay], 'display', 0) === 'Y');
t('prompt 模式跳过 markdownOnly 的', applyStRegex('x', [onlyDisplay], 'prompt', 0) === 'x');
t('prompt 模式应用 promptOnly 的', applyStRegex('x', [onlyPrompt], 'prompt', 0) === 'Y');
t('两边都改的哪边都应用', applyStRegex('x', [both], 'display', 0) === 'Y' && applyStRegex('x', [both], 'prompt', 0) === 'Y');
t('关着的一律不应用', applyStRegex('x', [off], 'display', 0) === 'x' && applyStRegex('x', [off], 'prompt', 0) === 'x');
t('深度不够不应用', applyStRegex('x', [deep], 'display', 1) === 'x');
t('深度在窗口内才应用', applyStRegex('x', [deep], 'display', 2) === 'Y' && applyStRegex('x', [deep], 'display', 3) === 'Y');
t('深度超了不应用', applyStRegex('x', [deep], 'display', 4) === 'x');
t('depth 不给 = 0', applyStRegex('x', [deep], 'display') === 'x');
t('没有脚本 → 原样返回', applyStRegex('x', [], 'display', 0) === 'x');
t('空文本 → 原样返回', applyStRegex('', [both], 'display', 0) === '');
t('脚本表不是数组也不会炸', applyStRegex('x', null, 'display', 0) === 'x');

console.log('=== 5. 红线：只改副本，不碰传进来的东西 ===');
const script = mk({ scriptName: '红线', trimStrings: ['!'] });
const snap = JSON.stringify(script);
const src = 'x!';
const out = applyStRegex(src, [script], 'display', 0);
t('返回的是新字符串，内容是过滤后的', out === 'Y', out);
t('原文（存档里那份）一个字没变', src === 'x!', src);
t('脚本对象本身也没被改（没有被写上临时字段）', JSON.stringify(script) === snap, script);
const listSnap = JSON.stringify([script]);
applyStRegex('xx', [script], 'prompt', 0);
t('跑两遍结果一样（没有全局正则的状态残留）',
  applyStRegex('x', [both], 'display', 0) === applyStRegex('x', [both], 'display', 0));

console.log('=== 6. 设置页要用的小工具 ===');
t('scriptActive 认显示侧', scriptActive(onlyDisplay, 'display') === true && scriptActive(onlyDisplay, 'prompt') === false);
t('scriptActive 认关着的', scriptActive(off, 'display') === false);
t('previewOne 给出替换后的样子', previewOne(both, 'axb') === 'aYb', previewOne(both, 'axb'));
t('previewOne 对编不出来的返回空串', previewOne({ find: '(', flags: '', replace: 'z', trim: [] }, 'a') === '');

console.log('');
console.log('通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
