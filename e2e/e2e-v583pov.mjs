// e2e-v583pov.mjs —— 叙事视角文案与镜头层数锚点（v0.5.8.3）。
//
// 纯 Node，不启浏览器：persona.js 没有 DOM 依赖，直接 import 就能测
// （同 e2e-v59beat.mjs / e2e-v58fix.mjs）。
//
// 为什么要有这一套：这一版改的全是【给人看的说明】和【注入给模型的锚点】，
// 改错了不会有任何报错 —— 界面照常显示，提示词照常发出去，只是慢慢漂回旧的。
// 所以锁四件事：
//   1. 视角说明里没有「她」（0.5.7.7 定的中性化口径，漏掉的那五条这一版才补上）
//   2. 版本沿革已经删干净（「老版本的『锁定她的视角=开』」那半句）
//   3. LENS 四档的层数锚点在、而且逐档递增
//   4. 篇幅归 PAREN_LEN、层数归 LENS，两边不再互相越界
import { POV_STYLE_PRESETS, POV_STYLES, LENS, PAREN_LEN, LENS_HEAD } from '../www/js/persona.js';

let pass = 0, fail = 0;
const t = (n, ok, ex = '') => { if (ok) { pass++; console.log('  OK   ' + n); } else { fail++; console.log('  FAIL ' + n + (ex ? '  -> ' + ex : '')); } };

const notes = POV_STYLE_PRESETS.map(p => p.note).join('\n');
const lensAll = ['low', 'mid', 'high', 'max'].map(k => LENS[k].join('')).join('\n');
const parenHigh = PAREN_LEN.high.join('');
const head = LENS_HEAD.join('');

console.log('=== 视角说明（给人看的） ===');
t('1 五条说明里没有「她」', !notes.includes('她'), (notes.match(/她/g) || []).length + ' 处');
t('2 没有「老版本」这类沿革', !notes.includes('老版本'));
t('3 L4 只剩「角色」和「你」两个指代词', !notes.slice(notes.indexOf('全知叙述者')).includes('他'));
t('4 五档还在（关 / L1 / L2 / L3 / L4）',
  POV_STYLE_PRESETS.length === 5 && POV_STYLE_PRESETS[1].value === 'L1' && POV_STYLE_PRESETS[0].value === '');

console.log('=== 注入给模型的视角段没被动 ===');
t('5 L1 正文还是「只能站在【你自己的视角】」', POV_STYLES.L1.join('').includes('只能站在【你自己的视角】'));

console.log('=== 层数锚点 ===');
t('6 low 拆一层', LENS.low.join('').includes('一层'));
t('7 mid 拆两层', LENS.mid.join('').includes('两层'));
t('8 high 拆三层', LENS.high.join('').includes('三层'));
t('9 max 下限四层', LENS.max.join('').includes('四层'));
// 锚点必须用「层」不用句子数 —— 篇幅和层数是两个旋钮，混用会互相取小。
t('10 四档都没有回头用句子数当锚点', !/句子|句话/.test(lensAll));

console.log('=== 两个旋钮各管一样 ===');
t('11 LENS_HEAD 堵住了「多写几个括号」这个岔路', head.includes('不是多写几个括号'));
t('12 PAREN_LEN.high 不再讲层', !parenHigh.includes('碰到的东西') && !parenHigh.includes('让什么变了'));
t('13 PAREN_LEN 仍然只管长度', parenHigh.includes('一百多字'));

console.log('pass=' + pass + ' fail=' + fail);
process.exit(fail ? 1 : 0);
