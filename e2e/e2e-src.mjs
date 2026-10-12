import fs from 'node:fs';

// e2e-src.mjs —— 读源码来断言时，先把注释剥掉（v0.4.0）
//
// 为什么要有它：
//   项目里有一批断言是"读 app.js 的文本，看某个片段在不在"（\`SRC.includes(...)\`）。
//   它们的问题不是写法，是【被断言的东西】—— 源码文本里既有代码也有注释，
//   而注释里出现同一段文字太容易了（这个仓库的注释密度非常高）。
//   于是改一句注释就能让断言变红、把代码挪走却还是绿的。
//   能被一次无意义重构搞成假绿的测试，比没有测试更危险 —— 它给的是虚假的安全感。
//
// 做法：在【读的那一刻】把注释剥掉，而不是去改几百个断言点。
//   一处改动，整个文件所有 \`includes\` 立刻变成"只认代码"。
//
// ⚠️ 这是启发式剥离，不是完整词法分析。它保证【不误伤代码】（宁可少剥），
//    所以保守地处理正则字面量：只有出现在明显的"表达式起始位置"的 / 才当正则。

const RE_BEFORE = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^', 'return']);

/** 剥掉 JS 注释。字符串和正则字面量里的内容原样保留。 */
export function stripJsComments(text) {
  const s = String(text == null ? '' : text);
  const out = [];
  let i = 0;
  // 记录"上一个有意义的字符"，用来判断 / 是除号还是正则开头
  let prev = '';
  const pushPrev = (c) => { if (!/\s/.test(c)) prev = c; };
  while (i < s.length) {
    const c = s[i];
    const d = s[i + 1];
    if (c === '/' && d === '/') {                 // 行注释
      while (i < s.length && s[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && d === '*') {                 // 块注释
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++;
      i += 2;
      out.push(' ');                              // 用空格替掉，别把两边的 token 粘起来
      continue;
    }
    if (c === '/' && (prev === '' || RE_BEFORE.has(prev))) {   // 正则字面量
      out.push(c); i++;
      let cls = false;
      while (i < s.length) {
        const x = s[i];
        if (x === '\\') { out.push(s[i], s[i + 1] || ''); i += 2; continue; }
        if (x === '[') cls = true;
        else if (x === ']') cls = false;
        else if (x === '/' && !cls) { out.push(x); i++; break; }
        else if (x === '\n') break;              // 没闭合，别把后面全吃掉
        out.push(x); i++;
      }
      pushPrev('/');
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {    // 字符串 / 模板串
      out.push(c); i++;
      while (i < s.length) {
        const x = s[i];
        if (x === '\\') { out.push(s[i], s[i + 1] || ''); i += 2; continue; }
        out.push(x); i++;
        if (x === c) break;
      }
      pushPrev('x');
      continue;
    }
    out.push(c);
    pushPrev(c);
    i++;
  }
  return out.join('');
}

/** 剥掉 CSS 注释（/* … *\/） */
export function stripCssComments(text) {
  return String(text == null ? '' : text).replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/**
 * 读一份源码文件，按扩展名剥掉注释。
 * @param {string} file 绝对路径
 */
export function readCode(file) {
  const text = fs.readFileSync(file, 'utf8');
  if (/\.css$/i.test(file)) return stripCssComments(text);
  if (/\.html?$/i.test(file)) return stripCssComments(text);   // HTML 里的注释块也很少进断言
  return stripJsComments(text);
}


export default { stripJsComments, stripCssComments, readCode };
