// 上下文预算（v1.21.54）—— 纯函数行为 + 源码接线。
//
// 为什么分两层测：这两层的失败方式完全不同。
//   · 纯函数（api.js 里那几个）：直接 import 来跑，看的是【数字对不对】
//   · 接线（谁调用了谁、跨不跨得过 try）：读源码断言，看的是【有没有接上】
// 只测一层都会漏：函数写对了但没人调用 = 修了等于没修
// （v1.21.52 那张人物卡就是这么栽的：函数、调用点都在，签名没改）。
import fs from 'fs';
import path from 'path';
import os from 'os';
import { pathToFileURL } from 'url';

const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');
let pass = 0, fail = 0;
const t = (n, ok, ex = '') => { if (ok) { pass++; console.log('  OK   ' + n); } else { fail++; console.log('  FAIL ' + n + (ex ? '  -> ' + ex : '')); } };
const readOr = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };

// 拷到临时目录再 import：相对 import 会按【临时目录】解析。
// ⚠️ 原来只拷 api.js 一个文件（那时它是自包含的）；v0.5.3.2 起 api.js 多了
//    `import { kindOfStatus } from './errorkit.js'` —— 只拷一个就 ERR_MODULE_NOT_FOUND，
//    整套 0.2 秒退出码 1。所以整个 js 目录一起拷，以后再加相对 import 也不会崩。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-ctxbudget-api-'));
for (const f of fs.readdirSync(path.join(R, 'www/js'))) {
  if (f.endsWith('.js')) fs.copyFileSync(path.join(R, 'www/js', f), path.join(tmpDir, f));
}
const api = await import(pathToFileURL(path.join(tmpDir, 'api.js')).href);

console.log('=== 1. estimateTokens：中文贵、英文便宜、空的是 0 ===');
t('空串 = 0', api.estimateTokens('') === 0);
t('null = 0', api.estimateTokens(null) === 0);
t('undefined = 0', api.estimateTokens(undefined) === 0);
t('10 个汉字 = 10', api.estimateTokens('字'.repeat(10)) === 10, String(api.estimateTokens('字'.repeat(10))));
t('4 个 ASCII = 2（3.5 个/token，向上取整）', api.estimateTokens('abcd') === 2, String(api.estimateTokens('abcd')));
t('7 个 ASCII = 2', api.estimateTokens('abcdefg') === 2, String(api.estimateTokens('abcdefg')));
t('同样长度下汉字比 ASCII 贵', api.estimateTokens('字字字字字字字字') > api.estimateTokens('abcdefgh'));
t('emoji 按一个字算', api.estimateTokens('🌸') === 1, String(api.estimateTokens('🌸')));

console.log('');
console.log('=== 2. 图片按张算，绝不按 base64 长度算 ===');
// ⚠️ 这套里最要紧的一条。
//    images 里存的是 dataURL 全文；拿字符串长度去估，一张图就是十几万 token，
//    结果是历史被整段砍光 —— 而且用户完全看不出是"图片把预算吃满了"。
const bigImg = 'data:image/jpeg;base64,' + 'A'.repeat(300000);
const one = api.estimateMsgTokens({ role: 'user', content: '看这个', images: [bigImg] });
t('★ 一张 30 万字符的图算 1200 上下，不是十几万', one >= 1200 && one < 1400, String(one));
const three = api.estimateMsgTokens({ role: 'user', content: '', images: [bigImg, bigImg, bigImg] });
t('★ 三张图按三倍算', three >= 3600 && three < 3800, String(three));
t('图片说明也算进去',
  api.estimateMsgTokens({ role: 'user', content: '', images: [bigImg], imageNotes: ['字'.repeat(50)] }) > three / 3);
t('空消息仍有 4（role / 分隔开销）', api.estimateMsgTokens({ role: 'user', content: '' }) === 4);
t('一整段 = 逐条相加',
  api.estimateMessagesTokens([{ role: 'user', content: '字'.repeat(10) }, { role: 'assistant', content: '' }]) === 18);

console.log('');
console.log('=== 3. fitHistoryByBudget：只从最旧的一端丢 ===');
const mk = (n, chars) => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: '字'.repeat(chars) }));
// 每条 = 104（100 个字 + 4 的开销）
t('单条成本是 104（供下面几条断言当基准）', api.estimateMsgTokens(mk(1, 100)[0]) === 104, String(api.estimateMsgTokens(mk(1, 100)[0])));

const list10 = mk(10, 100);
const roomy = api.fitHistoryByBudget(list10, 10000);
t('预算够就一条不丢', roomy.kept.length === 10 && roomy.dropped === 0, JSON.stringify({ k: roomy.kept.length, d: roomy.dropped }));
t('不丢时 kept 与原文同序', roomy.kept[0] === list10[0] && roomy.kept[9] === list10[9]);

const tight = api.fitHistoryByBudget(list10, 300);
t('预算 300 → 只留 2 条', tight.kept.length === 2, String(tight.kept.length));
t('★ 留下的是【最新】的两条（丢的是最旧的）', tight.kept[1] === list10[9] && tight.kept[0] === list10[8]);
t('dropped 报的是丢掉的条数', tight.dropped === 8, String(tight.dropped));
t('tokens 报的是留下的那部分', tight.tokens === 208, String(tight.tokens));

const zero = api.fitHistoryByBudget(list10, 0);
t('★ 预算为 0 也必须留 minKeep 条（不是一条不留）', zero.kept.length === 2, String(zero.kept.length));
const nanFit = api.fitHistoryByBudget(list10, NaN);
t('★ 预算是 NaN 时【不裁】（配置缺失不该静默清空历史）',
  nanFit.kept.length === 10 && nanFit.dropped === 0, JSON.stringify({ k: nanFit.kept.length }));
const undefFit = api.fitHistoryByBudget(list10, undefined);
t('预算是 undefined 时同样不裁', undefFit.kept.length === 10);
t('空数组不会炸', (() => { const f = api.fitHistoryByBudget([], 100); return f.kept.length === 0 && f.dropped === 0 && f.tokens === 0; })());
t('不是数组也不会炸', api.fitHistoryByBudget(null, 100).kept.length === 0);
t('minKeep 可以调大', api.fitHistoryByBudget(list10, 0, 5).kept.length === 5);

console.log('');
console.log('=== 4. isContextOverflow：认得超长，别把网络抖动当超长 ===');
t('context_length_exceeded', api.isContextOverflow(new Error('API 错误 400: {"error":{"message":"context_length_exceeded"}}')));
t("This model's maximum context length is 65536 tokens", api.isContextOverflow(new Error("This model's maximum context length is 65536 tokens")));
t('Please reduce the length of the messages', api.isContextOverflow(new Error('Please reduce the length of the messages.')));
t('too many tokens', api.isContextOverflow(new Error('too many tokens in the request')));
t('中文「输入过长」', api.isContextOverflow(new Error('输入过长，请缩短')));
// ⚠️ 下面这几条是【假阳性】防线：判错的代价是把一次网络抖动当成超长，
//    白白砍掉一段历史重发一次 —— 用户看到的是"她突然忘事"，比报错更难查。
t('★ fetch failed 不算超长', !api.isContextOverflow(new Error('fetch failed')));
t('★ 401 无效 key 不算超长', !api.isContextOverflow(new Error('API 错误 401: invalid api key')));
t('★ rate limit exceeded 不算超长', !api.isContextOverflow(new Error('rate limit exceeded')));
t('★ 60 秒没数据不算超长', !api.isContextOverflow(new Error('等太久了：服务器 60 秒没有回数据，检查下网络或稍后重试')));
t('★ 主动停止不算超长', !api.isContextOverflow(Object.assign(new Error('已停止'), { name: 'AbortError' })));
t('★ 空错误不算超长', !api.isContextOverflow(null) && !api.isContextOverflow(undefined) && !api.isContextOverflow(''));

console.log('');
console.log('=== 5. 源码接线：函数对但没人调用，等于没修 ===');
const appJs = readOr(R + '/www/js/app.js');
const apiJs = readOr(R + '/www/js/api.js');
const html = readOr(R + '/www/index.html');
const gradle = readOr(R + '/android/app/build.gradle');

t('api.js 导出了 fitHistoryByBudget', !!apiJs && apiJs.includes('export function fitHistoryByBudget'));
t('api.js 导出了四个估算/判定函数',
  !!apiJs && ['estimateTokens', 'estimateMsgTokens', 'estimateMessagesTokens', 'isContextOverflow']
    .every(n => apiJs.includes('export function ' + n)));
t('app.js 把用得到的都引了进来',
  !!appJs && ['estimateTokens', 'estimateMsgTokens', 'isContextOverflow', 'fitHistoryByBudget']
    .every(n => appJs.includes(n)));
t('★ 本轮用户消息按【消息】算额度（图片不会被漏掉）',
  !!appJs && appJs.includes("const turnTokens = estimateMsgTokens({ content: cont ? CONT_NUDGE : (noUser ? '' : visibleText), images, imageNotes });"));
t('没有留下用不到的 import', !!appJs && !appJs.includes('estimateMessagesTokens'));
t('★ app.js 里没有第二份 fitHistoryByBudget（搬走后不能留副本）', !!appJs && !appJs.includes('function fitHistoryByBudget'));
t('默认预算 48000', !!appJs && appJs.includes('contextBudget: 48000'));
t('发送前先算了固定段的占用', !!appJs && appJs.includes('const fixedTokens = estimateTokens(sysStable)'));
t('★ 固定段吃满时历史额度可以是 0', !!appJs && appJs.includes('histBudget = Math.max(0, ctxBudget - fixedTokens)'));
t('★ 重试循环里认得出超长', !!appJs && appJs.includes('isContextOverflow(err)'));
t('★ 超长时重拼请求体', !!appJs && appJs.includes('apiMsgs = composeApiMsgs(histBudget)'));
t('★ 没有可丢的历史时【不】重试（不然是空转）',
  !!appJs && appJs.includes('if (!ctxRetried && ctxFit && ctxFit.dropped > 0 && isContextOverflow(err))'));
t('★ 只降一次', !!appJs && appJs.includes('ctxRetried = true'));
t('★ 跨 try 边界的变量都在函数顶部声明',
  !!appJs && appJs.includes('let ctxBudget = 0, histBudget = 0, ctxFit = null, ctxRetried = false, composeApiMsgs = null;'));
t('设置页有预算输入框', !!html && html.includes('id="s-ctx-budget"'));
t('设置页有占用显示位', !!html && html.includes('id="s-ctx-note"'));
t('bindSettings 读写这个框', !!appJs && appJs.includes("$('s-ctx-budget')"));
t('占用显示函数写好了，并在 bindSettings 里调用',
  !!appJs && appJs.includes('function renderCtxNote()') && appJs.includes('renderCtxNote();'));
t('gradle 打开了 v3 签名', !!gradle && gradle.includes('enableV3Signing true'));

try { fs.unlinkSync(tmp); } catch {}
console.log('');
console.log('通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
