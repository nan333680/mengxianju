// 世界书「什么时候生效」三档（v1.21.51）—— 纯函数测试，不需要 Chrome。
//
// 三档的落点（都在 persona.js 里）：
//   front  命中才注入 → 本轮段最前「# 相关设定」（原来的行为）
//   tail   命中才注入 → 本轮段靠后「# 临场设定」（记忆之后、本轮要求之前）
//   always 每轮都注入 → 稳定前缀「# 基础设定」（角色设定之后、关于对方之前）
//
// ⚠️ 最要紧的两条：
//   1) 不传常驻条目时，稳定前缀必须【逐字节不变】—— 否则老用户每轮白白全量重算。
//   2) 常驻条目不能跟着命中集走。跟着走 = 每轮改一次前缀 = 前缀缓存全废。
import { buildStablePrompt, buildTurnNote } from '../www/js/persona.js';

let pass = 0, fail = 0;
const t = (n, ok, ex = '') => { if (ok) { pass++; console.log('  OK   ' + n); } else { fail++; console.log('  FAIL ' + n + (ex ? '  -> ' + ex : '')); } };
const char = { persona: '你是紫。', descLevel: 'mid', verbosity: 'medium' };
const s = { myProfile: '', myEnv: '', kaomojiFreq: 0.15, kaomojiStyle: 'jp-soft', emojiFreq: 0.1,
            splitMessages: false, hesitation: true, povLock: false, longMemory: true, worldbookOn: true };
const clock = '第 1 天 早上';
const mem = (n) => ({ id: 'm' + n, text: '他喜欢红苹果 ' + n });

console.log('=== 1. front 档：进「相关设定」，在本轮段最前 ===');
const front = [{ title: '红魔馆', content: '红魔馆是蕾米莉亚的宅邸。', pos: 'front' }];
const n1 = buildTurnNote(char, s, { memories: [], useKaomoji: false, worldbook: front, clock });
t('含「相关设定」段', n1.includes('# 相关设定'));
t('含标题与内容', n1.includes('红魔馆') && n1.includes('蕾米莉亚的宅邸'));
t('没有「临场设定」段', !n1.includes('# 临场设定'));
t('排在时间之前', n1.indexOf('# 相关设定') < n1.indexOf('# 现在的时间'), n1.indexOf('# 相关设定') + ' vs ' + n1.indexOf('# 现在的时间'));

console.log('=== 2. tail 档：进「临场设定」，排在本轮段靠后 ===');
const tail = [{ title: '此刻的口吻', content: '这一轮她说话很轻。', pos: 'tail' }];
const n2 = buildTurnNote(char, s, { memories: [mem(1), mem(2)], useKaomoji: false, worldbook: tail, clock });
t('含「临场设定」段', n2.includes('# 临场设定'));
t('含内容', n2.includes('这一轮她说话很轻'));
t('没有「相关设定」段', !n2.includes('# 相关设定'));
t('排在时间之后', n2.indexOf('# 临场设定') > n2.indexOf('# 现在的时间'));
t('排在记忆之后（比背景更靠后）', n2.indexOf('# 临场设定') > n2.indexOf('# 你记得关于他的事'),
  n2.indexOf('# 临场设定') + ' vs ' + n2.indexOf('# 你记得关于他的事'));

console.log('=== 3. 两档同时出现：各就各位 ===');
const n3 = buildTurnNote(char, s, { memories: [mem(1)], useKaomoji: false, worldbook: front.concat(tail), clock });
t('背景在前、临场在后', n3.indexOf('# 相关设定') < n3.indexOf('# 临场设定'));
t('两边内容都在', n3.includes('蕾米莉亚的宅邸') && n3.includes('这一轮她说话很轻'));
t('背景里没有临场那条', n3.slice(n3.indexOf('# 相关设定'), n3.indexOf('# 临场设定')).includes('说话很轻') === false);

console.log('=== 4. 稳定前缀：不传常驻时逐字节不变（老用户缓存不能白废）===');
const base = buildStablePrompt(char, s);
const baseUndef = buildStablePrompt(char, s, undefined);
const baseEmpty = buildStablePrompt(char, s, []);
t('不传第三参 = 显式传 undefined', base === baseUndef);
t('不传第三参 = 传空数组', base === baseEmpty);
t('里面没有「基础设定」段', !base.includes('# 基础设定'));

console.log('=== 5. 常驻档进稳定前缀 ===');
const cw = [{ title: '世界观', content: '这里是一个永远黄昏的镇子。', pos: 'always' }];
// 「关于对方」只有 myProfile 非空时才出现 —— 这里给它一份，好把位置钉死
const s2 = { ...s, myProfile: '我是阿澈，普通上班族。' };
const withCw = buildStablePrompt(char, s2, cw);
t('含「基础设定」段', withCw.includes('# 基础设定'));
t('含标题与内容', withCw.includes('世界观') && withCw.includes('永远黄昏的镇子'));
t('在角色设定之后', withCw.indexOf('# 基础设定') > withCw.indexOf('# 你的角色设定'));
t('在「关于对方」之前', withCw.indexOf('# 基础设定') < withCw.indexOf('# 关于对方'),
  withCw.indexOf('# 基础设定') + ' vs ' + withCw.indexOf('# 关于对方'));

console.log('=== 6. 稳定前缀必须【稳定】—— 两次调用一字不差 ===');
t('同输入两次输出相同', buildStablePrompt(char, s2, cw) === withCw);
t('常驻条目换顺序 → 输出跟着换（顺序由调用方保证，别自己排）',
  buildStablePrompt(char, s2, cw) !== buildStablePrompt(char, s2, [{ ...cw[0], content: '别的' }]));

console.log('=== 7. 老条目（没有 pos 字段）走 front，行为不变 ===');
const legacy = [{ title: '旧条目', content: '老世界书写法。' }];
const n7 = buildTurnNote(char, s, { memories: [], useKaomoji: false, worldbook: legacy, clock });
t('进「相关设定」', n7.includes('# 相关设定') && n7.includes('老世界书写法'));
t('不进「临场设定」', !n7.includes('# 临场设定'));

console.log('');
console.log('通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);