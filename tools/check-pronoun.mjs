// tools/check-pronoun.mjs —— 查备份里她的话还写不写「他」
//
// 为什么要有这个：0.5.4.7 的代词中性化（'you' 分支 + userSideLines 那 11 处）
// 唯一的目的就是让模型不再写「他」。**mock 测不出来，e2e 也测不出来** ——
// 它们只证明代码没崩、断言还认，证明不了模型听话。
//
// ⚠️ 只看「他」的次数会误判：0 次也可能是【这 10 条根本没用到第三人称】
//    （独白、纯环境描写、全是台词，本来就不会出现「他」）。
//    所以同时统计「你」——它是"这个样本到底有没有覆盖到对方"的对照。
//
// 用法：
//   node tools/check-pronoun.mjs "C:\path\to\梦弦居备份-2026-11-07.json"
//   node tools/check-pronoun.mjs <备份.json> 10     ← 每个角色只看最后 10 条
//
// 判读（同一批里）：
//   你 ≥10  他 0      → 生效
//   你 ≥10  他 1~2    → 模型偶尔漏，正常
//   你 ≥10  他 每轮有 → 没生效：查 userSideLines 有没有执行到、「you」分支进没进提示词
//   你 少    他 0      → ★ 这 10 条没验到（样本没覆盖），重聊一轮再说
import fs from 'node:fs';

const p = process.argv[2];
const tail = Math.max(1, Number(process.argv[3]) || 10);
if (!p) {
  console.error('用法: node tools/check-pronoun.mjs <备份.json> [只看最后几条，默认 10]');
  process.exit(1);
}
if (!fs.existsSync(p)) { console.error('找不到文件：' + p); process.exit(1); }

const j = JSON.parse(fs.readFileSync(p, 'utf8'));
const nameOf = new Map((j.characters || []).map(c => [c.id, c.name || '(未命名)']));
const rows = [];
let allMsgs = 0, allYou = 0, allHe = 0;
for (const [cid, list] of Object.entries(j.messages || {})) {
  if (!Array.isArray(list)) continue;
  const hers = list.filter(m => m && m.role === 'assistant' && typeof m.content === 'string');
  if (!hers.length) continue;
  // 只统计最近几条：改版之前的旧消息本来就是「他」，算进去没有意义
  const recent = hers.slice(-tail);
  let you = 0, he = 0;
  for (const m of recent) {
    you += (m.content.match(/你/g) || []).length;
    he += (m.content.match(/他/g) || []).length;
  }
  allMsgs += recent.length; allYou += you; allHe += he;
  rows.push({ name: nameOf.get(cid) || cid.slice(0, 8), n: recent.length, you, he });
}
rows.sort((a, b) => b.he - a.he);

console.log('角色 | 最近消息数 | 「你」 | 「他」');
for (const r of rows) console.log(`${r.name} | ${r.n} | ${r.you} | ${r.he}`);
console.log('');
console.log(`合计：${allMsgs} 条，「你」${allYou} 次，「他」${allHe} 次`);
console.log('');

// 四行判读，最后一行是最容易误判的那格
if (allYou < 10) {
  console.log('★ 这 ' + allMsgs + ' 条里「你」只出现 ' + allYou + ' 次 —— 样本没覆盖到对方，');
  console.log('  0 个「他」不能说明生效。重聊一轮（要有对话、有动作描写）再看。');
} else if (allHe === 0) {
  console.log('✓ 生效：「你」' + allYou + ' 次，「他」0 次');
} else if (allHe <= 2) {
  console.log('~ 模型偶尔漏（' + allHe + ' 次），可接受');
} else {
  console.log('✗ 偏多：查 userSideLines 有没有被执行到（userPronoun 是不是真的 you）');
}
