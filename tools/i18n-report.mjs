// tools/i18n-report.mjs —— 翻译覆盖率报告（v0.4.2 加）
//
// 起因（用户复核 v0.4.1）：「还有一点，翻译没有全覆盖」—— 这句话没法执行，也没有数字。
// 这个脚本把它变成可数的东西：哪些界面文案切到英文还是中文。
//
// 用法：
//   node tools/i18n-report.mjs            # 汇总 + 前 30 条
//   node tools/i18n-report.mjs --all      # 全列出来
//   node tools/i18n-report.mjs --check    # 覆盖率低于 tools/i18n-baseline.json 就非零退出
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'www', 'index.html'), 'utf8');
const i18n = fs.readFileSync(path.join(root, 'www', 'js', 'i18n.js'), 'utf8');

// 静态文案：<tag ...>中文</tag>
const STATIC = /<(button|span|h3|h4|label|p|em|option|div|b|i)([^>]*)>([^<]{1,60})<\/\1>/g;
const rows = [];
for (const m of html.matchAll(STATIC)) {
  const attrs = m[2];
  const inner = m[3].replace(/\s+/g, ' ').trim();
  if (!/[\u4e00-\u9fa5]/.test(inner)) continue;
  const hasEn = /data-i18n-en="([^"]*)"/.exec(attrs);
  rows.push({ text: inner, translated: !!hasEn && hasEn[1].trim().length > 0, en: hasEn ? hasEn[1].trim() : '' });
}
// 去重（同一个词在多处出现算一条）
const byText = new Map();
for (const r of rows) {
  const cur = byText.get(r.text);
  if (!cur) byText.set(r.text, r);
  else if (r.translated) cur.translated = true;   // 只要有一处标了就算标了
}
const all = [...byText.values()];
const done = all.filter(r => r.translated);
const todo = all.filter(r => !r.translated);

// 动态词典
const dict = [...i18n.matchAll(/'([^']+)'\s*:\s*'([^']*)'/g)].map(m => ({ zh: m[1], en: m[2] }));
const dictZh = dict.filter(d => /[\u4e00-\u9fa5]/.test(d.zh));
const dictEmpty = dictZh.filter(d => !d.en.trim());

const pct = all.length ? Math.round((done.length / all.length) * 1000) / 10 : 100;
console.log('界面静态文案（去重后）: ' + all.length + ' 条，已标英文 ' + done.length + ' 条 → 覆盖 ' + pct + '%');
console.log('还差 ' + todo.length + ' 条。动态词典 ' + dictZh.length + ' 条' + (dictEmpty.length ? ('，其中 ' + dictEmpty.length + ' 条英文是空的') : ''));

if (process.argv.includes('--all')) {
  console.log('\n--- 还没有英文的（全部）---');
  todo.forEach(r => console.log('  ' + r.text));
} else if (todo.length) {
  console.log('\n--- 还没有英文的（前 30 条）---');
  todo.slice(0, 30).forEach(r => console.log('  ' + r.text));
  if (todo.length > 30) console.log('  …还有 ' + (todo.length - 30) + ' 条（--all 看全）');
}

if (process.argv.includes('--check')) {
  const bf = path.join(root, 'tools', 'i18n-baseline.json');
  const base = fs.existsSync(bf) ? JSON.parse(fs.readFileSync(bf, 'utf8')) : null;
  if (!base) {
    fs.writeFileSync(bf, JSON.stringify({ untranslated: todo.length, total: all.length, at: new Date().toISOString() }, null, 2) + '\n', 'utf8');
    console.log('\n（第一次跑，已把当前水位写进 tools/i18n-baseline.json：' + todo.length + ' 条未翻译）');
    process.exit(0);
  }
  if (todo.length > base.untranslated) {
    console.log('\n✗ 未翻译的条数从 ' + base.untranslated + ' 涨到了 ' + todo.length + '（新加的界面文案请顺手标英文）');
    process.exit(1);
  }
  console.log('\n✓ 不比基线差（基线 ' + base.untranslated + ' 条，现在 ' + todo.length + ' 条）');
}
