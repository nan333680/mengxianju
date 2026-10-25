// tools/run-e2e.mjs —— 逐套跑 e2e，每套带超时，结果落盘
//
// 为什么不用一条 pwsh 循环：
//   某一套卡死（等不到页面 / Chrome 没起来）时，整条循环会静默挂在那里，
//   后面所有套件都不跑，看起来像"回归没跑"而不是"某一套卡了"。
//   这里每套单独起进程、单独超时、单独记录 —— 一套卡死只损失那一套。
//
// 用法：
//   node tools/run-e2e.mjs                 # 默认这一轮该跑的 12 套
//   node tools/run-e2e.mjs e2e-v2 e2e-arc  # 只跑指定的
//
// 结果同时写到 tools/.e2e-report.txt（node 侧写，不依赖控制台缓冲）。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DEFAULT = [
  'e2e-v2', 'e2e-secret', 'e2e-mempick', 'e2e-memos', 'e2e-composer', 'e2e-psyche',
  'e2e-settings', 'e2e-i18n', 'e2e-arc', 'e2e-deflavor', 'e2e-channel',
  'e2e-v34fix'
];
const names = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT;
const REPORT = path.join(ROOT, 'tools', '.e2e-report.txt');
// 每套的超时。e2e-v2 单独给 15 分钟：它一轮要等三候选 + 评审 + 重写 + 逐条上屏，
// 5 个场景串下来本来就慢；300 秒会在 B5 附近被打断，看起来像"卡死"，其实只是没跑完。
const TIMEOUTS = { 'e2e-v2': 900000, 'e2e-arc': 400000 };
const TIMEOUT = 300000;

fs.writeFileSync(REPORT, '', 'utf8');
const say = (s) => { console.log(s); try { fs.appendFileSync(REPORT, s + '\n', 'utf8'); } catch {} };

let totalPass = 0, totalFail = 0, bad = 0;
for (const n of names) {
  const file = path.join(ROOT, 'e2e', n + '.mjs');
  if (!fs.existsSync(file)) { say(n + ' => 缺文件'); bad++; continue; }
  const t0 = Date.now();
  let out = '', code = 0;
  try {
    out = execFileSync(process.execPath, [file], {
      cwd: ROOT, encoding: 'utf8', timeout: TIMEOUTS[n] || TIMEOUT, maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (e) {
    code = e.status == null ? 1 : e.status;
    out = String(e.stdout || '') + String(e.stderr || '');
    if (e.killed || e.signal) out += '\n[超时或被杀：' + (e.signal || 'killed') + ']';
  }
  const ms = Date.now() - t0;
  // 各套件的收尾格式不统一，三种都见过：
  //   「通过 52 项 / 失败 0 项」「通过 64 项，失败 0 项」「54 项通过 / 0 项失败」
  // 用宽松匹配，别让格式差异被当成"没有结果行"。
  //   `通过 32 项 / 失败 0 项` 里【项与斜杠之间有空格】—— 原来的字符类 [，,/、] 不含空格，
  //   e2e-secret / e2e-mempick 就这么被判成「没有结果行」了（实际打的是全绿）。
  const m1 = out.match(/通过\s*(\d+)\s*项\s*[，,\/、]?\s*失败\s*(\d+)\s*项/);
  const m2 = m1 ? null : out.match(/(\d+)\s*项通过\s*[，,\/、]?\s*(\d+)\s*项失败/);
  const line = m1 || m2 ? ['', (m1 || m2)[1], (m1 || m2)[2]] : [];
  const p = Number(line[1] || 0), f = Number(line[2] == null ? -1 : line[2]);
  // 没打出「通过 N 项」= 套件自己崩了（不是断言失败）—— 单独标出来，别混进失败数
  if (line.length === 0) {
    bad++;
    say(n + ' => 没有结果行（exit=' + code + ', ' + ms + 'ms）');
    const tail = out.split(/\r?\n/).filter(Boolean).slice(-6).join(' | ');
    if (tail) say('        ' + tail.slice(0, 600));
  } else {
    totalPass += p; totalFail += Math.max(0, f);
    say(n + ' => 通过 ' + p + ' / 失败 ' + f + '（exit=' + code + ', ' + ms + 'ms）');
    if (f > 0) {
      for (const l of out.split(/\r?\n/)) if (l.indexOf('FAIL') >= 0) say('        ' + l.trim().slice(0, 300));
    }
  }
}
say('');
say('合计：通过 ' + totalPass + ' 项 / 失败 ' + totalFail + ' 项' + (bad ? ' / ' + bad + ' 套没出结果' : ''));
process.exit((totalFail || bad) ? 1 : 0);
