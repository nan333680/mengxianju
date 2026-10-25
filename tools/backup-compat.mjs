// tools/backup-compat.mjs —— 拿【真实备份】验证记忆与状态的兼容性
//
// 为什么要这个：
//   e2e 里的记忆全是当场造的，形状永远是最理想的那种。真机上跑着的
//   是几十个备份里攒下来的老数据：老记忆没有 heat / open，老的 psyche
//   根本没有 life / relation，还有些备份压根没有 psyche 键。
//   这些数据不会报错，只会【静默地排错序】或【静默地丢字段】——
//   那正是「她怎么不记得了」最典型的来源。
//
// 数据来源：本机某个目录里的梦弦居备份（路径不进仓库，由参数或环境变量给）。
//   ⚠️ 只读。本脚本不写、不复制、不打印任何一条记忆/消息的正文，
//      也不会把里面的任何内容带进软件当示例 —— 只统计形状和数量。
//
// 用法：node tools/backup-compat.mjs "<放备份的目录>"
//       或设环境变量 MXJ_BACKUP_DIR 指向那个目录
import fs from 'node:fs';
import path from 'node:path';
import { normalizeMemory, MEMORY_KINDS } from '../www/js/memory.js';
import { normalizePsyche, emptyPsyche, psychePrompt } from '../www/js/psyche.js';
import { pickMemories, memoryBlockText } from '../www/js/mempick.js';

const DIR = process.argv[2] || process.env.MXJ_BACKUP_DIR || '';
if (!DIR) {
  console.log('没给备份目录。用法：node tools/backup-compat.mjs "<放备份的目录>"（或设 MXJ_BACKUP_DIR）');
  process.exit(2);
}
// 占位串：给打分函数一个"他这一轮说的话"。绝不用备份里的真实内容 ——
// 这个脚本只该出现在仓库里，不该带着用户的东西。
const PROBE_USER = '今天几点了';

let pass = 0, fail = 0;
const t = (n, ok, ex = '') => { if (ok) { pass++; console.log('  OK   ' + n); } else { fail++; console.log('  FAIL ' + n + (ex ? '  -> ' + ex : '')); } };

const files = fs.readdirSync(DIR).filter(f => /^梦弦居备份-.*\.json$/i.test(f)).sort();
if (!files.length) { console.log('找不到备份文件：' + DIR); process.exit(1); }
console.log('备份 ' + files.length + ' 份（' + DIR + '）\n');

let totMem = 0, totMsg = 0, totChar = 0, withPsy = 0, psyKeys = 0;
const kindCount = {};
let badJson = 0, badMem = 0, nanScore = 0, badUsed = 0, noReason = 0, badPsy = 0, promptBad = 0;
let heatPreset = 0, openTrue = 0, promiseN = 0, legacyN = 0;
let worstMs = 0, worstFile = '';

for (const f of files) {
  const p = path.join(DIR, f);
  const t0 = Date.now();
  let o;
  try { o = JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { badJson++; console.log('  !! 解析失败 ' + f + '：' + ((e && e.message) || e)); continue; }

  const ms = Array.isArray(o.memories) ? o.memories : [];
  const chars = Array.isArray(o.characters) ? o.characters : [];
  const msgMap = o.messages && typeof o.messages === 'object' ? o.messages : {};
  const kv = Array.isArray(o.kv) ? o.kv : [];
  totMem += ms.length; totChar += chars.length;
  for (const arr of Object.values(msgMap)) if (Array.isArray(arr)) totMsg += arr.length;

  // ---- 1. 记忆归一：老记录不能抛，也不能丢字段 ----
  const norm = [];
  for (const m of ms) {
    let n;
    try { n = normalizeMemory(m); } catch (e) { badMem++; continue; }
    norm.push(n);
    if (n.v !== 2) badMem++;
    if (!Number.isInteger(n.heat) || n.heat < 0 || n.heat > 5) badMem++;
    if (n.open !== true && n.open !== false) badMem++;
    if (!MEMORY_KINDS.includes(n.kind)) badMem++;
    if (n.heat > 0) heatPreset++;
    if (n.open === true) openTrue++;
    if (n.kind === 'promise') promiseN++;
    if (n.legacy === true) legacyN++;
    kindCount[n.kind] = (kindCount[n.kind] || 0) + 1;
  }

  // ---- 2. 老 psyche（没有 life / relation）也要能归一 ----
  const psyByChar = new Map();
  for (const row of kv) {
    const k = String(row && row.k);
    if (k.indexOf('psyche:') !== 0) continue;
    psyKeys++;
    let p2;
    try { p2 = normalizePsyche(row.v); } catch (e) { badPsy++; continue; }
    if (!p2.life || !p2.relation || typeof p2.relation.bond !== 'number') badPsy++;
    // 归一后的状态再拼一次提示词：老数据里那些奇怪的值不该让渲染崩
    try { const s = psychePrompt(p2); if (typeof s !== 'string') promptBad++; } catch (e) { promptBad++; }
    psyByChar.set(k.slice('psyche:'.length), p2);
  }
  if (psyKeys > 0 && psyByChar.size > 0) withPsy++;

  // ---- 3. 按角色跑一次真实检索 ----
  const byChar = new Map();
  for (const m of norm) {
    const cid = String(m.charId || '');
    if (!byChar.has(cid)) byChar.set(cid, []);
    byChar.get(cid).push(m);
  }
  for (const [cid, list] of byChar) {
    let nowDay = 0;
    for (const m of list) if (m.day > nowDay) nowDay = m.day;
    let pick;
    try {
      pick = pickMemories({ list, nowDay: nowDay || 1, limit: 12, budgetTokens: 4000, userText: PROBE_USER, pathIds: null });
    } catch (e) { badUsed++; continue; }
    if (pick.used.length > 12) badUsed++;
    for (const u of pick.used) {
      if (!Number.isFinite(u.score) || !Number.isFinite(u.sem)) nanScore++;
      if (typeof u.why !== 'string' || !u.why) badUsed++;
    }
    for (const d of pick.dropped) if (!d.reason) noReason++;
    // 记忆块拼接（含「她突然想起来」前缀）不能抛
    try { memoryBlockText(pick.used); } catch (e) { badUsed++; }
    // 没 psyche 的角色：空状态不该渲染出任何一段
    if (!psyByChar.has(cid)) {
      if (psychePrompt(emptyPsyche()) !== '') badPsy++;
    }
  }

  const msCost = Date.now() - t0;
  if (msCost > worstMs) { worstMs = msCost; worstFile = f; }
}

console.log('汇总：角色 ' + totChar + ' 个 / 记忆 ' + totMem + ' 条 / 消息 ' + totMsg + ' 条 / psyche 键 ' + psyKeys + ' 个（' + withPsy + ' 份备份里有）');
console.log('类别分布：' + JSON.stringify(kindCount));
console.log('已带 heat ' + heatPreset + ' 条 / open=true ' + openTrue + ' 条 / promise ' + promiseN + ' 条 / legacy ' + legacyN + ' 条\n');

t('全部备份都能解析', badJson === 0, String(badJson) + ' 份失败');
t('老记忆归一后字段合法（v=2 / heat 整数 0~5 / open 布尔 / kind 在白名单里）', badMem === 0, String(badMem) + ' 条不合格');
t('老状态归一后都有 life / relation', badPsy === 0, String(badPsy) + ' 处不合格');
t('空状态渲染为空串（不会给老角色平白加一段提示词）', promptBad === 0, String(promptBad));
t('每个角色都能跑出检索结果，且不超过 limit', badUsed === 0, String(badUsed));
t('打分里没有 NaN（老记忆缺 heat 也不会算出 NaN）', nanScore === 0, String(nanScore));
t('被挤掉的每条都有 reason', noReason === 0, String(noReason));
t('最慢一份 ' + worstMs + ' ms（' + worstFile + '）', worstMs < 20000, worstMs + 'ms');

console.log('\n通过 ' + pass + ' 项 / 失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
