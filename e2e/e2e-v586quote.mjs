// e2e-v586quote.mjs —— 引号格式（小说体）：提示词 / 渲染 / 朗读（v0.5.8.6）
//
// 纯 Node，不启浏览器：
//   · 提示词部分直接 import www/js/persona.js（同 e2e-v583pov，那边已验证没有 DOM 依赖）
//   · renderBody / ttsClean 是纯函数，从 app.js 里按锚点抠出来跑
//     （同 e2e-star 的办法；那边为了 DOM 断言起了浏览器，这里不需要）
//
// 这一版最容易悄悄退回去的几处，都在这里守着：
//   1. 三通道的标签换了、旧标签真的没了
//   2. off 档只剩两层，且新的硬规则在
//   3. 渲染：引号原样显示、星号仍变斜体、老格式（括号）显示不变
//   4. 朗读：有引号只念引号内；一个引号都没有时【退回老逻辑】——不能静音
//   5. 界面可见文本里不再出现「括号」
//
// ⚠️ 测试数据必须用【弯引号】U+201C / U+201D。直角引号「」会让 ttsClean 掉进
//    「无引号退回老逻辑」那一支 —— 断言照样绿，但测的是老逻辑，等于假通过。
//    e2e-channel:213 就这么踩过一次（那版 seed 写的是「水凉了。」）。所以下面
//    专门有一条断言在验证「本套件用的确实是弯引号」。
import { readFileSync } from 'fs';
import path from 'path';
import { buildStablePrompt } from '../www/js/persona.js';
import { findCliches } from '../www/js/cliche.js';

const R = path.resolve(import.meta.dirname, '..');
let pass = 0, fail = 0;
const t = (n, ok, ex = '') => { if (ok) { pass++; console.log('  OK   ' + n); } else { fail++; console.log('  FAIL ' + n + (ex ? '  -> ' + ex : '')); } };

// ── 从 app.js 里抠出两个纯函数 ──
const src = readFileSync(path.join(R, 'www/js/app.js'), 'utf8');
const iInner = src.indexOf('const INNER_RE');
const iToast = src.indexOf('function toast(');
const iTts = src.indexOf('function ttsClean');
const iRead = src.indexOf('/** 读一段字');
t('能定位到 INNER_RE → toast 那一段', iInner > 0 && iToast > iInner, iInner + '/' + iToast);
t('能定位到 ttsClean → 「读一段字」那一段', iTts > 0 && iRead > iTts, iTts + '/' + iRead);
const ESC = `const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));`;
const mod = new Function(ESC + src.slice(iInner, iToast) + src.slice(iTts, iRead) + '; return { renderBody, ttsClean };')();

// ── 本套件自己用的那份台词（顺带证明它是弯引号）──
const Q = '“水凉了。”';
t('★ 测试数据用的是弯引号 U+201C/U+201D（不是直角）',
  Q.codePointAt(0) === 0x201c && Q.codePointAt(Q.length - 1) === 0x201d,
  '首=' + Q.codePointAt(0).toString(16) + ' 尾=' + Q.codePointAt(Q.length - 1).toString(16));

// ══ 一、提示词：三通道换了标签 ══
console.log('=== 1. 提示词：引号是台词，括号退场 ===');
const base = { persona: '你是阿紫。', descLevel: 'mid', verbosity: 'medium',
  kaomojiFreq: 0.15, kaomojiStyle: 'jp-soft', emojiFreq: 0.1,
  splitMessages: false, hesitation: true, longMemory: true };
const sys = buildStablePrompt(base, { ...base, detailDrive: 'max' });
t('有「引号里【说出口】」', sys.includes('引号里【说出口】'));
t('有「引号外【叙述】」', sys.includes('引号外【叙述】'));
t('有「星号里【心里】」', sys.includes('星号里【心里】'));
t('旧的三条标签一条都不剩',
  !sys.includes('括号里【外面】') && !sys.includes('括号外【之间】') && !sys.includes('星号里【里面】'));
t('分组那条改成了「一段叙述里」',
  sys.includes('一段叙述里写的要是同一件事') && !sys.includes('一段括号里写的要是同一件事'));
t('禁令改成「别拿引号冒充心里话」', sys.includes('引号里只放你真说出口的话'));
t('旧的「括号里不许写想/觉得」退场', !sys.includes('括号里不许写「想 / 觉得 / 知道'));

// ══ 二、off 档：只剩两层 ══
console.log('=== 2. descLevel=off：只剩两层，且新的硬规则在 ===');
const sysOff = buildStablePrompt(base, { ...base, descLevel: 'off', detailDrive: 'off' });
t('off 档不再有「引号里【说出口】」', !sysOff.includes('引号里【说出口】'));
t('off 档有「引号里：你真正说出口的话」', sysOff.includes('引号里：你真正说出口的话'));
t('off 档说了「整条不写叙述」', sysOff.includes('整条不写叙述'));
t('off 档新硬规则：只输出引号里的台词', sysOff.includes('只输出引号里的台词'));
t('off 档第二条：引号外面不许出现句子', sysOff.includes('引号外面不许出现句子'));

// ══ 三、渲染 ══
console.log('=== 3. 渲染：引号原样、星号照旧、老格式不变 ===');
const body = mod.renderBody(Q + '她把杯子放下。');
t('引号原样显示', body.includes(Q), body);
t('叙述也在', body.includes('她把杯子放下'), body);
t('本版没给引号加包装（.q 样式延后）', !body.includes('class="q"'), body);

const inner = mod.renderBody('*这话我才不说。*');
t('星号的心里话仍然变斜体', inner.includes('inner-thought') && inner.includes('这话我才不说'), inner);

const kao = mod.renderBody('(*^ω^*)');
t('括号里的星号不解析（第 0 步必须留着）', kao === '(*^ω^*)', kao);

const oldFmt = mod.renderBody('（她抬头看你）你来了。');
t('老格式（括号）显示和以前一样', oldFmt.includes('（她抬头看你）') && oldFmt.includes('你来了。'), oldFmt);

// ══ 四、朗读 ══
console.log('=== 4. 朗读：有引号只念引号内，没引号退回老逻辑 ===');
const s1 = mod.ttsClean('她把杯子放下。' + Q + '*这话我才不说。*');
t('有引号 → 念到台词', s1.includes('水凉了'), JSON.stringify(s1));
t('有引号 → 不念叙述', !s1.includes('她把杯子放下'), JSON.stringify(s1));
t('有引号 → 不念心里话', !s1.includes('这话我才不说'), JSON.stringify(s1));

const s2 = mod.ttsClean('（她把杯子放下）水凉了。');
t('无引号 → 退回老逻辑，没静音', s2.includes('水凉了'), JSON.stringify(s2));
t('无引号 → 仍然剥掉括号里的动作', !s2.includes('她把杯子放下'), JSON.stringify(s2));

const s3 = mod.ttsClean('「水凉了。」');
t('直角引号走退回分支也能念出来（决策 6 的宽松兜底）', s3.includes('水凉了'), JSON.stringify(s3));

const s4 = mod.ttsClean('（她把杯子放下）');
t('整条只有括号 → 返回字符串，不炸', typeof s4 === 'string', JSON.stringify(s4));

// ⚠️ 这条守的是「抽引号之前必须先挖括号」。第一版是先扫全文抽引号，
//    于是「（他低声说了句“走吧”）」里那个「走吧」会被念出来 ——
//    整段本来是动作描写，一个字都不该念。
const s5 = mod.ttsClean('（他低声说了句“走吧”）');
t('★ 括号里的引号不念（整段是动作，不是台词）', !s5.includes('走吧'), JSON.stringify(s5));

// ══ 五、界面文案 ══
console.log('=== 5. 界面文案里不再出现「括号」 ===');
const html = readFileSync(path.join(R, 'www/index.html'), 'utf8');
t('index.html 里一个「括号」都没有', !html.includes('括号'));
const i18nSrc = readFileSync(path.join(R, 'www/js/i18n.js'), 'utf8');
t('i18n.js 里没有「括号」', !i18nSrc.includes('括号'));
t('i18n.js 里没有 parentheses', !/parenthese/i.test(i18nSrc));
t('新文案「台词之外的描写写多长」已进页面', html.includes('台词之外的描写写多长（上限）'));

// ══ 六、cliche：「这几样这一轮别再用」在新格式下还活着吗 ══
//
// ⚠️ 这一节是补一个【笔 1 留下的洞】。新格式下她不再写括号了，而 gramsIn 原来
//    只扫括号 —— 于是每条新消息都返回空集，findCliches 恒为 []，
//    app.js 那段「这几样这一轮别再用」永远不会注入。它坏得没有声音：
//    e2e-channel 第 9 节的 seed 是括号写的，两种实现下都绿。
console.log('=== 6. cliche：新格式下还抓得到动作惯性吗 ===');
const qNarr = line => '“别动。”' + line;
const newFmt = [
  qNarr('抬手把他按住，指尖抵在锁骨下面。'),
  qNarr('抬手把他推开，手背擦过他的袖子。'),
  qNarr('抬手把他扶正，另一只手还压着肩头。'),
  qNarr('抬手把他往里带，门在身后合上。'),
  qNarr('低头看他一眼，没说话。'),
  qNarr('低头看他笑，眼睛弯了一下。'),
];
const gotNew = findCliches(newFmt, { limit: 6 });
t('★ 新格式：引号外的动作短语抓得到', gotNew.some(x => x.includes('抬手把他')), JSON.stringify(gotNew));

const onlyQuote = [
  '“抬手把他按住。”', '“抬手把他推开。”', '“抬手把他扶正。”',
  '“抬手把他往里带。”', '“抬手把他扶起来。”', '“抬手把他按住别动。”',
];
const gotQ = findCliches(onlyQuote, { limit: 6 });
t('整条都是台词时，不算动作惯性', !gotQ.some(x => x.includes('抬手把他')), JSON.stringify(gotQ));

const oldSeed = ['（抬手把他按住）', '（抬手把他推开）', '（抬手把他扶正）',
  '（抬手把他往里带）', '（低头看他一眼）', '（低头看他笑）'];
const gotOld = findCliches(oldSeed, { limit: 6 });
t('老格式（无引号、括号）仍按原样抓得到', gotOld.some(x => x.includes('抬手把他')), JSON.stringify(gotOld));

console.log('');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
