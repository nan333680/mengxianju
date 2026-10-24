// e2e-deflavor.mjs — 去 AI 味（deflavor）与模板动作（cliche）的纯逻辑回归
//
// 为什么要有这一套：这两个模块是 0.5.3.4 去 AI 味的全部底层，
// 而在 0.5.3.4 复查之前它们在 e2e 里【一条断言都没有】。
// 它们又是最容易"改一个正则、悄悄弄坏一句话"的地方（下面每一条都对应一次真实事故）。
//
// 纯 node，不开浏览器：没有 DOM 依赖，跑一段十几毫秒。

const NL = '\n';
import { deflavor, deflavorFor, DROP_SENTENCE, DROP_CLAUSE } from '../www/js/deflavor.js';
import { findCliches, templateHits, TEMPLATE_ACTS } from '../www/js/cliche.js';

let pass = 0, fail = 0;
function t(name, ok, extra) {
  if (ok) { pass++; console.log('  OK   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra === undefined ? '' : '  → ' + JSON.stringify(extra))); }
}
const clean = (s) => deflavor(s).text;
const hits = (s) => deflavor(s).hits;

console.log('=== 1. 认输系：删得掉，但不许把句子黏在一起 ===');
{
  // 事故：句尾字符类用 [。！？…」』\n]* 收尾，把句号一起吞掉 →
  // 「你要我认手重，我认。你要问我从哪学的」变成「你要我认手重你要问我从哪学的」（真实语料 4/1708）
  t('「这个我认。」整句删掉', clean('这个我认。' + NL + '（她低下头）') === '（她低下头）', clean('这个我认。' + NL + '（她低下头）'));
  t('删完不黏住下一句', clean('我认。你要问我从哪学的') === '你要问我从哪学的', clean('我认。你要问我从哪学的'));
  t('后面跟着另一句时，那一句照旧留着', clean('你要我认手重，我认。你要问我从哪学的').includes('你要问我从哪学的'), clean('你要我认手重，我认。你要问我从哪学的'));
  t('「我不认这条路。」不删（有实义）', clean('我不认这条路。') === '我不认这条路。', clean('我不认这条路。'));
  t('「我认得他。」不删（认=认识）', clean('我认得他。') === '我认得他。', clean('我认得他。'));
  t('「我认你是我哥。」不删', clean('我认你是我哥。') === '我认你是我哥。', clean('我认你是我哥。'));
  t('「这个我认了。」删完不会剩一个「这个。」', clean('这个我认了。') === '', clean('这个我认了。'));
  // 注意这里前半句本来就含「我认手重」（认得下手重），只该删掉尾部的「，我认。」
  t('「你要我认手重，我认。」只删尾部的服软，前半句不动', clean('你要我认手重，我认。') === '你要我认手重。', clean('你要我认手重，我认。'));
  t('hits 只在真删时出现', hits('我认得他。').length === 0, hits('我认得他。'));
  t('真删时有 hits', hits('这个我认。').length > 0, hits('这个我认。'));
}

console.log('=== 2. 停顿套话：只删套话本身，不许吃主语/吃后面的字 ===');
{
  // 事故：正则写成 (?:他|她|我)?顿了(?:顿|一下|一瞬)(?:[，、,])? ——
  // 「他顿了顿才开口。」→「才开口。」、「他顿了顿神。」→「神。」、「她顿了顿脚，没说话。」→「脚，没说话。」
  t('「他顿了顿才开口。」不能变成「才开口。」', clean('他顿了顿才开口。') === '他顿了顿才开口。', clean('他顿了顿才开口。'));
  t('「他顿了顿神。」不能变成「神。」', clean('他顿了顿神。') === '他顿了顿神。', clean('他顿了顿神。'));
  t('「她顿了顿脚，没说话。」不能变成「脚，没说话。」', clean('她顿了顿脚，没说话。') === '她顿了顿脚，没说话。', clean('她顿了顿脚，没说话。'));
  t('括号里的「（顿了一下，眼睛没飘）」保住后半句', clean('（顿了一下，眼睛没飘）') === '（眼睛没飘）', clean('（顿了一下，眼睛没飘）'));
  // 紧跟「才/就/便/又」时不删：那是「顿了一下才意识到」这种真动作链，切了就读不通
  t('「（顿了一下，才反应过来）」保守不动', clean('（顿了一下，才反应过来）') === '（顿了一下，才反应过来）', clean('（顿了一下，才反应过来）'));
}

console.log('=== 3. 删完的残迹：空括号、空引号、孤儿引号 ===');
{
  t('「（她顿了顿。）」不留「（。）」', clean('（她顿了顿。）') === '', clean('（她顿了顿。）'));
  t('「「我认。」」不留孤儿后引号', clean('「我认。」') === '', clean('「我认。」'));
  t('空括号被清掉', !/[（(]\s*[）)]/.test(clean('（顿了一下，眼睛没飘）')), clean('（顿了一下，眼睛没飘）'));
  t('「……」这种六点省略号不被动', clean('她没说话……') === '她没说话……', clean('她没说话……'));
  t('重复的同一个标点被收拢', clean('别说了。。') === '别说了。', clean('别说了。。'));
  t('逗号重复被收拢', clean('别说了，，') === '别说了，', clean('别说了，，'));
}

console.log('=== 4. 不许误伤正常内容 ===');
{
  const keep = [
    '她把伞收起来，靠在门边的墙角。',
    '他低头看了一眼，没说话。',
    '「水凉了。」她说。',
    '*我其实不想说*',
    '窗外的雨声忽然大了一阵。',
  ];
  for (const s of keep) t('原样保留：' + s, clean(s) === s, clean(s));
  t('洗空时上层会退回原文（这里只确认洗空确实返回空串）', clean('我认。') === '', clean('我认。'));
}

console.log('=== 5. DROP_SENTENCE / DROP_CLAUSE 的形状 ===');
{
  t('DROP_SENTENCE 里没有空串（空串会匹配一切）', DROP_SENTENCE.every(x => typeof x === 'string' && x.length > 0));
  t('DROP_CLAUSE 每条都有 re', DROP_CLAUSE.every(r => r && r.re instanceof RegExp));
  t('DROP_CLAUSE 的 re 都是 /g（否则 replace 只换第一处）', DROP_CLAUSE.every(r => r.re.flags.includes('g')));
  t('DROP_CLAUSE 没有用 lookbehind（旧 WebView 直接 SyntaxError）', DROP_CLAUSE.every(r => !r.re.source.includes('(?<')));
}

console.log('=== 6. 模板动作：偏头痛 / 眼底出血 不许误判 ===');
{
  t('「他偏头痛，眼底出血。」不算模板动作', templateHits('他偏头痛，眼底出血。').length === 0, templateHits('他偏头痛，眼底出血。'));
  t('真的用了四个模板动作就四个都抓到', templateHits('偏头看她，后颈一凉，喉结动了一下，眼底发沉。').length === 4, templateHits('偏头看她，后颈一凉，喉结动了一下，眼底发沉。'));
  t('「顿了一下」不在模板表里（deflavor 免费删，不该再付一次重写的钱）', !TEMPLATE_ACTS.some(a => a.name.includes('顿')), TEMPLATE_ACTS.map(a => a.name));
  t('干净文本返回空', templateHits('她把杯子推过来。').length === 0);
  t('模板表里每条都有 name 与 re', TEMPLATE_ACTS.every(a => a && typeof a.name === 'string' && a.re instanceof RegExp));
}

console.log('=== 7. 惯性短语：只留像动作的，不许全是碎片 ===');
{
  // 事故：STOP 表 40 条里 39 条是 2-3 字死条目（gram 只产 4/5/6 字），
  // 于是「了一会儿」「着的那只」这类碎片一路进提示词。
  const mk = (n, s) => Array.from({ length: n }, (_, i) => '（' + s + '，第' + i + '次）「嗯」');
  const got = findCliches(mk(10, '他低头看他'), { limit: 6 });
  t('反复出现的动作短语被抓到', got.includes('他低头看他'), got);
  t('没有以虚词开头的碎片', got.every(g => !/^[在的了着把被往从和与就都也还又很太再才只没不儿们的]/.test(g)), got);
  t('没有停在半个词上', got.every(g => !/[的了着地得呗呢吧啊啦呀]$/.test(g)), got);
  t('limit:0 返回空（不是 1 条）', findCliches(mk(10, '他低头看他'), { limit: 0 }).length === 0);
  t('limit 是小数时向下取整', findCliches(mk(10, '他低头看他'), { limit: 2.5 }).length <= 2);
  t('少于 6 条消息时宁可不说', findCliches(mk(3, '他低头看他')).length === 0);
  const a = findCliches(mk(10, '他低头看他'));
  const b = findCliches(mk(10, '他低头看他').reverse());
  t('同一批消息正序/倒序结果一致（排序有 tiebreak）', JSON.stringify(a) === JSON.stringify(b), [a, b]);
}

console.log('=== 8. 按模型分档：没实测过的模型不许乱删 ===');
{
  // 分档的目的不是"多删点"，是"换一家接口时别把她的话删残"：
  // 「认」在别的模型里可能就是正常的"承认"，整句照删会删掉实义。
  t('deepseek 档照删', deflavorFor('这个我认了。', { model: 'deepseek-flash' }).text === '', deflavorFor('这个我认了。', { model: 'deepseek-flash' }).text);
  t('厂商名也算（deepseek-chat）', deflavorFor('这个我认。', { model: 'deepseek-chat' }).text === '');
  t('别的模型不动「认」系', deflavorFor('这个我认了。', { model: 'gpt-4o' }).text === '这个我认了。', deflavorFor('这个我认了。', { model: 'gpt-4o' }).text);
  t('别的模型也不记假 hits', deflavorFor('这个我认了。', { model: 'gpt-4o' }).hits.length === 0, deflavorFor('这个我认了。', { model: 'gpt-4o' }).hits);
  t('不传模型时保持旧行为（全部表）', deflavorFor('这个我认了。').text === '', deflavorFor('这个我认了。').text);
  t('用户自定义禁用词对任何模型都生效',
    deflavorFor('烦死了，走吧', { model: 'gpt-4o', extraBanned: ['烦死了'] }).text === '，走吧',
    deflavorFor('烦死了，走吧', { model: 'gpt-4o', extraBanned: ['烦死了'] }).text);
}

console.log('=== 9. 删完之后尾巴上的孤立指代 ===');
{
  // 事故（0.5.3.5 真实输出）：「（她抬手把杯子推过来）这个我认了。」
  // 删掉「我认了」之后剩「（她抬手把杯子推过来）这个。」—— 11 个汉字，
  // minRest / dropWhole 都拦不住，读起来是半截话。
  t('长句尾巴的「这个」也清掉', clean('（她抬手把杯子推过来）这个我认了。') === '（她抬手把杯子推过来）。', clean('（她抬手把杯子推过来）这个我认了。'));
  t('正常句子里的「这个」不许动', clean('我喜欢这个。') === '我喜欢这个。', clean('我喜欢这个。'));
  t('「这话我认」也清尾巴', !clean('（她别过脸）这话我认。').includes('这话'), clean('（她别过脸）这话我认。'));
}

console.log('');
// ⚠️ 格式要跟回归脚本认的那三种之一对齐（「通过 N 项，失败 M 项」），
// 否则 tools/run-regression.ps1 会记成 "(无汇总)"，断言数进不了总数。
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail > 0 ? 1 : 0);
