// 风格卡（v0.5.3.2 · 清单 §7.3「风格卡：句长、视角、密度、禁用词、样例段落」）
//
// ⚠️ 为什么只做【样例段落】和【禁用词】两样：
//    句长 / 视角 / 密度这三样项目里【已经有开关了】——
//    视角是 povStyle，句长是 verbosity，密度是 descLevel + detailDrive。
//    再在这里做一套，就是第二个"DRIVE_CAP"：两套上限互相覆盖，
//    界面上选的东西被静默改掉（v0.4.3.3 修的就是这个病）。
//    样例段落和禁用词没有对应开关，也不会和它们打架 —— 这两样才进风格卡。
//
// ⚠️ 为什么样例比规则有效：
//    规则说的是"别怎样"，模型拿不准边界；样例给的是一段真实输出，
//    句子怎么起、话和动作怎么排、一段停在哪，它可以直接照着仿。
//    所以注入时【样例单独成段】放在表达方式的最后，紧挨着描述要求。

/** 样例段落最多这么长。（一条提示词里塞一整篇小说没有意义，反而挤掉人设） */
export const STYLE_SAMPLE_MAX = 800;
/** 禁用词最多这么多条。 */
export const STYLE_BAN_MAX = 12;

const S = (v, n) => String(v == null ? '' : v).replace(/\r/g, '').trim().slice(0, n);

/** 空格子 */
export function emptyStyleCard() { return { sample: '', ban: [] }; }

/**
 * 把任何输入洗成 { sample, ban[] }。
 *
 * 两种来源会进来：① 角色对象上的 char.styleCard（自己写的）
 * ② 别人给的卡里的 extensions.mengxianju.params.styleCard（外来的，什么都可能有）
 * 所以这里一律重建，不信任形状。
 */
export function normalizeStyleCard(raw) {
  const a = (raw && typeof raw === 'object') ? raw : {};
  const out = { sample: S(a.sample, STYLE_SAMPLE_MAX), ban: [] };
  const seen = new Set();
  const list = Array.isArray(a.ban) ? a.ban : (typeof a.ban === 'string' ? a.ban.split(/[\n,，;；]/) : []);
  for (const x of list) {
    const t = S(x, 30);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.ban.push(t);
    if (out.ban.length >= STYLE_BAN_MAX) break;
  }
  return out;
}

export function styleCardActive(raw) {
  const a = normalizeStyleCard(raw);
  return !!(a.sample || a.ban.length);
}

/**
 * 给提示词的那一段。空的就返回空串 —— 没填过的角色一个字符都不多。
 */
export function styleCardBlock(raw) {
  const a = normalizeStyleCard(raw);
  if (!a.sample && !a.ban.length) return '';
  const out = [];
  if (a.sample) {
    out.push('- 下面是他给的范例。写的【写法】照它来：句子多长、话和动作怎么排、一段停在哪儿，都参照它。');
    out.push('- ⚠️ 只学写法和腔调【不要复述】范例里的人物、地点、发生过的事 —— 那是别的场合，这里没有发生过。');
    // 范例逐行缩进两格：它是【样例】不是规则，缩进一下才不会和上面几条规则混成一片。
    out.push('【范例】');
    for (const ln of a.sample.split('\n')) out.push('  ' + ln);
  }
  if (a.ban.length) {
    out.push('- 这几样【不要写进正文】：' + a.ban.join('、') + '。');
  }
  return out.join('\n');
}
