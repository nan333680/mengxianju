// e2e-v585gap.mjs —— 时间差（clockGap）的模糊档（v0.5.8.5）。
//
// 纯 Node，不启浏览器：clockGap 是 persona.js 里的纯函数，这一轮为它加了 export。
//
// 为什么要有这一套：
//   原来「同一天、时段不同、又没有钟点」这一格是【直接返回空串】的——
//   而「时间细化」默认关，所以这恰恰是绝大多数情况。用户实测（爱丽丝出门务农那半天）
//   模型手里什么都没有，只能去写「下午的光」。这一版补了按时段跨档的模糊说法，
//   而模糊档最容易出的错是【带数字】：下面有一条「不许自己编数字」的硬规矩,
//   我们在这边先给个「大概 6 小时」，模型就会当真值复述出去。所以锁两件事：
//     1. 各档说法都对、且一个数字都没有
//     2. 有钟点 / 跨天 / 回拨这些老分支一个都没被这版改坏
import { clockGap } from '../www/js/persona.js';

let pass = 0, fail = 0;
const t = (n, ok, ex = '') => { if (ok) { pass++; console.log('  OK   ' + n); } else { fail++; console.log('  FAIL ' + n + (ex ? '  -> ' + ex : '')); } };

const P = (day, phase, hour = null, minute = 0) => ({ day, phase, hour, minute });
const hasNum = (s) => /[0-9０-９一二三四五六七八九十百]\s*(小时|分钟|钟头|天|周|个月|年)/.test(s);

console.log('=== 1. 模糊档（没有钟点时按时段跨几档）===');
const g1 = clockGap(P(1, 'forenoon'), P(1, 'morning'));
t('1 跨 1 档 → 个把钟头', g1.includes('个把钟头'), g1.replace(/\n/g, ' '));
t('2 跨 1 档里有「时间过去了」', g1.includes('【时间过去了】'));

const g2 = clockGap(P(1, 'noon'), P(1, 'morning'));
t('3 跨 2 档 → 几个钟头', g2.includes('几个钟头'), g2.replace(/\n/g, ' '));

// 爱丽丝那条线的实际情况：上午出门（forenoon）→ 下午回来（afternoon），跨 2 档。
const g4 = clockGap(P(1, 'afternoon'), P(1, 'forenoon'));
t('4 上午→下午（跨 2 档）→ 几个钟头', g4.includes('几个钟头'), g4.replace(/\n/g, ' '));

const g6 = clockGap(P(1, 'evening'), P(1, 'morning'));
t('5 早上→傍晚（跨 4 档）→ 大半天', g6.includes('大半天'), g6.replace(/\n/g, ' '));

const g7 = clockGap(P(1, 'lateNight'), P(1, 'morning'));
t('6 早上→深夜（跨 6 档）→ 一整天', g7.includes('一整天'), g7.replace(/\n/g, ' '));

console.log('=== 2. 模糊档一个数字都不许带 ===');
// ⚠️ 只检查「大概过了 X」那一小段 —— 整段里还有「第 1 天」这种剧情天数，
//    那是真值、必须留；要防的是把【跨度】写成一个数字。
const fuzzyWord = (s) => (s.match(/大概过了(.+?)。/) || [])[1] || '';
const words = [g1, g2, g4, g6, g7].map(fuzzyWord);
t('7 五个模糊说法都取到了', words.every(Boolean), words.join(' / '));
t('8 模糊说法本身一个数字都没有', words.every(w => !/[0-9０-９]/.test(w)), words.join(' / '));
t('9 明说了「没有精确到小时」', [g1, g4, g7].every(s => s.includes('没有精确到小时')));

console.log('=== 3. 老分支一个都没坏 ===');
t('10 同一时段、没钟点 → 还是空串（什么都没过去）', clockGap(P(1, 'morning'), P(1, 'morning')) === '',
  JSON.stringify(clockGap(P(1, 'morning'), P(1, 'morning'))));
t('11 有钟点 → 还是精确的「2 小时 30 分钟」',
  clockGap({ day: 1, phase: 'afternoon', hour: 14, minute: 30 }, { day: 1, phase: 'noon', hour: 12, minute: 0 }).includes('2 小时 30 分钟'),
  clockGap({ day: 1, phase: 'afternoon', hour: 14, minute: 30 }, { day: 1, phase: 'noon', hour: 12, minute: 0 }).replace(/\n/g, ' '));
t('12 跨 1 天 → 一天', clockGap(P(2, 'morning'), P(1, 'morning')).includes('一天'));
t('13 跨 3 天 → 3 天', clockGap(P(4, 'morning'), P(1, 'morning')).includes('3 天'));
t('14 时间被往回拨 → 明说是他调的',
  clockGap({ day: 1, phase: 'afternoon', hour: 17, minute: 20 }, { day: 1, phase: 'evening', hour: 19, minute: 0 }).includes('往回拨'));
t('15 没有上一条 → 空串', clockGap(P(1, 'morning'), null) === '');
t('16 没有当前时间 → 空串', clockGap(null, P(1, 'morning')) === '');

console.log('pass=' + pass + ' fail=' + fail);
process.exit(fail ? 1 : 0);
