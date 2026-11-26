// e2e-v584life.mjs —— 「角色自己的生活」+ 位置提取（v0.5.8.4）。
//
// 纯 Node，不启浏览器：psyche.js 是纯数据变换（连 import 都没有），
// director.js / persona.js / app.js 用源码文本断言（它们各有 API/DOM 依赖，
// 在 Node 里 import 会连带着把整个运行环境拉起来）。
//
// 为什么要有这一套：
//   这一版把一张【写死在代码里的作息表】挖出来给用户改，又加了一条
//   【从聊天记录里提取位置】的路。两边改错了都不会报错 —— 界面照常显示，
//   请求照常发出去，只是慢慢退回「她说她在洗澡」「她站着、提示词说她躺着」。
//   所以锁七件事：
//     1. 「在洗澡」已经从表里删掉（症状 A 的源头）
//     2. lifeSelf 关掉时 activity 在【产出层】就空（不然主动开场那条路照样带病）
//     3. lifeSelf 关掉不影响 busy / energy（打字节奏别跟着变）
//     4. override 只换词、不动 busy / energy（施工单 §5.1-4 那个陷阱）
//     5. 用户七段表：改过的段用他的词、空数组那段不写、没改过的段跟随内置表
//     6. 判断层的 now 在 ASK / 白名单 / salvage 三处都登记了
//     7. 让位句和「你现在在哪」那段在 persona.js 里，且不含「她」
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveLife, lifeLine, LIFE_SLOT_DEFS } from '../www/js/psyche.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const readJs = (p) => fs.readFileSync(path.join(HERE, '..', 'www', 'js', p), 'utf8');

let pass = 0, fail = 0;
const t = (n, ok, ex = '') => { if (ok) { pass++; console.log('  OK   ' + n); } else { fail++; console.log('  FAIL ' + n + (ex ? '  -> ' + ex : '')); } };

const b = {};

console.log('=== 1. 作息表里不能有会「冒出来」的身体状态 ===');
const allAct = LIFE_SLOT_DEFS.map(s => s.act.join('|')).join('|');
t('1 「在洗澡」已经删掉', allAct.indexOf('在洗澡') < 0, allAct);
t('2 19-22 档还剩三条候选', (LIFE_SLOT_DEFS.find(s => s.from === 19) || { act: [] }).act.length === 3);
t('3 七档都在', LIFE_SLOT_DEFS.length === 7 && LIFE_SLOT_DEFS.map(s => s.from).join(',') === '0,7,10,13,15,19,23');

console.log('=== 2. lifeSelf：在【产出层】清空，但不动节奏 ===');
const r1 = deriveLife(b, { now: 1000, hour: 20, rnd: () => 0.4 });
const r2 = deriveLife(b, { now: 1000, hour: 20, rnd: () => 0.4, lifeSelf: false });
t('4 默认（不传 lifeSelf）照样给 activity', !!r1.activity, r1.activity);
t('5 lifeSelf=false 时 activity 是空串', r2.activity === '', JSON.stringify(r2.activity));
t('6 lifeSelf=false 不影响 busy', r2.busy === r1.busy, r1.busy + ' / ' + r2.busy);
t('7 lifeSelf=false 不影响 energyNow', r2.energyNow === r1.energyNow, r1.energyNow + ' / ' + r2.energyNow);

console.log('=== 3. override 只换词，不动 busy / energy（§5.1-4 的陷阱）===');
const l18def = deriveLife(b, { now: 1000, hour: 18, rnd: () => 0.9 });
const l18ov = deriveLife(b, { now: 1000, hour: 18, rnd: () => 0.9, override: { act: ['在改稿'] } });
t('8 override 换掉了候选词', l18ov.activity === '在改稿', l18ov.activity);
t('9 override 不动 busy', l18ov.busy === l18def.busy, l18def.busy + ' / ' + l18ov.busy);
t('10 override 不动 energyNow', l18ov.energyNow === l18def.energyNow, l18def.energyNow + ' / ' + l18ov.energyNow);
t('11 15-18 档的 energy 还是 0.8', l18def.energyNow === 0.8, String(l18def.energyNow));

console.log('=== 4. 用户七段表（稀疏覆盖）===');
const slots = { '19': ['刚回家'], '0': [] };
t('12 改过的段用用户配的词', deriveLife(b, { now: 1000, hour: 20, rnd: () => 0, slots }).activity === '刚回家',
  deriveLife(b, { now: 1000, hour: 20, rnd: () => 0, slots }).activity);
t('13 空数组那段不写', deriveLife(b, { now: 1000, hour: 3, rnd: () => 0, slots }).activity === '');
t('14 没改过的段跟随内置表', deriveLife(b, { now: 1000, hour: 11, rnd: () => 0, slots }).activity !== '',
  deriveLife(b, { now: 1000, hour: 11, rnd: () => 0, slots }).activity);
t('15 空数组那段 busy 照旧（节奏不跟着停）', deriveLife(b, { now: 1000, hour: 3, rnd: () => 0, slots }).busy === true);

console.log('=== 5. lifeLine 的兜底 ===');
t('16 activity 为空时 lifeLine 返回空串', lifeLine({ life: { activity: '', busy: true } }) === '',
  JSON.stringify(lifeLine({ life: { activity: '', busy: true } })));

console.log('=== 6. 判断层：now 字段登记齐全 ===');
const DIR = readJs('director.js');
t('17 ASK 里有 now 字段', DIR.indexOf('"now":') > 0);
t('18 now 排在 reading 之后（截断从尾巴丢）', DIR.indexOf('"now":') > DIR.indexOf('"reading":'));
t('19 salvage 白名单收了 now', /const STR = \['reading', 'now'/.test(DIR));
t('20 normalizeDirector 白名单收了 now', /now: cut\(raw\.now, 40\)/.test(DIR));
// 0.5.8.9：解构里多了 outline（剧情小纲要给判断层读）—— 断言跟着加，但 prevPose 仍必须在这条里。
t('21 runDirector 读 prevPose', /\{ stable, recent, userText, psyche, api, signal, roster, target, plot, outline, prevPose \}/.test(DIR));
t('22 poseBlock 拼进了 system 消息', /poseBlock \+ whoBlock \+ ASK/.test(DIR));
// ⚠️ v0.5.8.10 改了这一句：原文「聊天记录里已经动过了，就以聊天记录为准，改过来」
//    是【危险授权】—— 判断层只看得到最近 8 条，「它没看到」被它读成「没动过」，
//    于是把还在的槽（门口搁着的衣裳）当成过期清掉。现在只认「明确写了变了」。
t('23 惯性块改成「明确写了变了才改，没提的照抄」',
  DIR.indexOf('【明确写了】某一项变了') > 0 && DIR.indexOf('聊天记录里已经动过了') < 0);

console.log('=== 7. 正文侧：让位句 + 你现在在哪 ===');
const PER = readJs('persona.js');
const lifeIdx = PER.indexOf('如果聊天记录里已经不在这个处境了');
const lifeSeg = lifeIdx >= 0 ? PER.slice(lifeIdx, lifeIdx + 220) : '';
t('24 让位句在 lifeLine 那一段里', lifeIdx > 0);
t('25 让位句不含「她」', lifeSeg.indexOf('她') < 0, lifeSeg.slice(0, 60));
t('26 让位句要求以聊天记录为准', lifeSeg.indexOf('以聊天记录为准') > 0);
// ⚠️ v0.5.8.10 改了标题：内容从「40 字位置」变成五槽画面（在哪/姿势/手里/身上/身边），
//    「你现在在哪」已经盖不住穿着和身边搁着的东西。
t('27 有「你这会儿的样子」那一段', PER.indexOf('# 你这会儿的样子') > 0);
t('28 pose 是 buildTurnNote 的参数', /pose = '',/.test(PER));

console.log('=== 8. app.js：开关 / 稀疏存储 / 弹窗 ===');
const APP = readJs('app.js');
t('29 lifeSelf 传进了 deriveLife', APP.indexOf('lifeSelf: S.lifeSelf !== false') > 0);
t('30 lifeSlots 也传进去了', APP.indexOf('slots: S.lifeSlots') > 0);
t('31 DEFAULTS 里 lifeSelf 默认开', /lifeSelf: true,/.test(APP));
t('32 DEFAULTS 里 lifeSlots 默认空对象（稀疏）', /lifeSlots: \{\},/.test(APP));
// ⚠️ v0.5.8.10：来源多了一个（状态卡片五槽，优先），但「不拿库里的旧值兜底」这条没变 ——
//    两个来源都只认【本轮】的，空就是空，那一段整段不出现。
t('33 正文只认本轮的来源，不拿 stale 兜底',
  APP.indexOf("pose: poseCard || ((LIVE && psyDir && psyDir.now) ? psyDir.now : ''),") > 0);
t('34 弹窗标题中性化成「角色本来在做」', APP.indexOf("tt('角色本来在做')") > 0);
t('35 弹窗小字指向「角色自己的生活」', APP.indexOf('要改去「角色自己的生活」') > 0);
t('36 设置页有七个文本框的渲染', APP.indexOf('data-life-slot') > 0);

console.log('=== 9. 0.5.8.5：七段收进弹层 ===');
const lifeFn = APP.slice(APP.indexOf('function renderLifeSlots'), APP.indexOf('async function flushLifeSlots'));
t('37 七段搬进了弹层', APP.indexOf('life-modal') > 0 && APP.indexOf('s-life-open') > 0);
t('38 关掉总开关也能编辑（renderLifeSlots 里不再拼 disabled）',
  lifeFn.length > 500 && lifeFn.indexOf('disabled') < 0, lifeFn.length + ' 字节');
t('39 入口那行有状态（默认 / 已改 N 段）',
  APP.indexOf('updateLifeBrief') > 0 && APP.indexOf("tt('已改 ' + n + ' 段')") > 0);
t('40 「全部恢复默认」在（清空 lifeSlots 就回到内置表）',
  APP.indexOf("saveSettings({ lifeSlots: {} })") > 0);
t('41 保存能被等待（reset 靠 promise 精确等，不靠延时）',
  APP.indexOf('let lifeSave = Promise.resolve()') > 0 && APP.indexOf('await lifeSave') > 0);

console.log('pass=' + pass + ' fail=' + fail);
process.exit(fail ? 1 : 0);
