/**
 * 主题色板（v0.5.7.4）
 *
 * 这里【只有】纯函数和一张表：不读设置、不碰 DOM、不 import 别的模块。
 * 所以它能在 node 里直接跑表验证（18 色 × 深浅两套的对比度），不用开浏览器。
 *
 * 参数化而不是写 18 段 CSS 的理由：18 色 × 深浅 2 套 × 3 个变量 = 108 条规则，
 * 改一个色相要动 6 处。参数化之后只在 JS 里 set 三个变量，调色只改表。
 */

/**
 * 色相 h（0-360）+ 饱和度 s（0-100），亮度由主题决定。
 * lDark / lLight 只在个别色相上覆写 —— 亮色相（黄、黄绿）在白底上会糊，
 * 紫这套的默认亮度会把按钮推到「白字刚好不达标」的边上（见下）。
 */
export const THEME_COLORS = [
  { k: 'violet', name: '紫',   h: 255, s: 88 },
  { k: 'rose',   name: '玫红', h: 340, s: 80 },
  { k: 'pink',   name: '粉',   h: 325, s: 75 },
  { k: 'coral',  name: '珊瑚', h: 10,  s: 85 },
  { k: 'red',    name: '红',   h: 355, s: 78 },
  { k: 'orange', name: '橙',   h: 22,  s: 90 },
  { k: 'amber',  name: '琥珀', h: 35,  s: 90 },
  { k: 'yellow', name: '黄',   h: 45,  s: 92, lDark: 56, lLight: 40 },
  { k: 'lime',   name: '黄绿', h: 95,  s: 58, lDark: 58, lLight: 38 },
  { k: 'green',  name: '绿',   h: 145, s: 62 },
  { k: 'teal',   name: '青绿', h: 170, s: 68 },
  { k: 'cyan',   name: '青',   h: 185, s: 80 },
  { k: 'sky',    name: '天蓝', h: 200, s: 85 },
  { k: 'blue',   name: '蓝',   h: 220, s: 85 },
  { k: 'indigo', name: '靛',   h: 245, s: 65 },
  { k: 'mauve',  name: '藕',   h: 300, s: 45 },
  { k: 'slate',  name: '灰蓝', h: 215, s: 32 },
  { k: 'stone',  name: '石板', h: 30,  s: 12 }
];

export const L_DARK = 66;
export const L_LIGHT = 52;

/** 两个候选前景色。深色的那个不是纯黑 —— 纯黑在深色主题里太硬。 */
export const FG_WHITE = '#ffffff';
export const FG_INK = '#101014';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** hsl(h, s%, l%) → [r, g, b]（0-255）。s / l 传 0-100。 */
export function hslToRgb(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

/** WCAG 相对亮度。入参 0-255。 */
export function relLum(r, g, b) {
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** 两个相对亮度之间的对比度（1-21）。 */
export function contrast(l1, l2) {
  const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

/** 给定底色，白字与墨字哪个对比度高就返回哪个（不设阈值 —— 阈值在边界上会跳）。 */
export function pickFg(r, g, b) {
  const L = relLum(r, g, b);
  const cw = contrast(L, relLum(255, 255, 255));
  const ci = contrast(L, relLum(16, 16, 20));
  return cw >= ci ? FG_WHITE : FG_INK;
}

/** 某个候选前景色在该底色上的实际对比度。 */
export function fgContrast(r, g, b, fg) {
  const L = relLum(r, g, b);
  const f = fg === FG_WHITE ? relLum(255, 255, 255) : relLum(16, 16, 20);
  return contrast(L, f);
}

/** 按钮底 / 气泡底 / 浅色主题下文字色，各自的白字达标线（relLum 上限）。 */
export const TARGET_BTN = 0.17;
export const TARGET_BUB = 0.15;
export const TARGET_TEXT_LIGHT = 0.165;

/**
 * 从 from 往下找【最亮】的那个 L，使该色在 L 处的相对亮度 <= target。
 * 亮一点观感好，达标是硬约束 —— 所以是「达标里取最亮」，不是「越暗越安全」。
 */
function levelFor(c, satOff, from, target) {
  const s = clamp(c.s + satOff, 0, 100);
  for (let L = from; L >= 18; L -= 1) {
    const rgb = hslToRgb(c.h, s, L);
    if (relLum(rgb[0], rgb[1], rgb[2]) <= target) return { L, rgb };
  }
  const rgb = hslToRgb(c.h, s, 18);
  return { L: 18, rgb };
}

/**
 * 一套色 → 六个 CSS 值。
 *
 * pri      亮档：边框 / focus / 色板圆点 / 选中勾。要鲜，不承载文字。
 * pri2     比 pri 再亮一档（历史语义），仍只做边框与强调装饰。
 * priText  浅色主题下压暗后的强调文字色；深色主题直接用 pri。
 * btn      按钮底：搜到能配白字的最亮 L。
 * bubble   自己那条气泡的底：比 btn 更暗一档（气泡里文字更密）。
 */
export function colorVars(c, isLight) {
  const H = c.h;
  const priLevel = clamp(isLight ? (c.lLight ?? L_LIGHT) : (c.lDark ?? L_DARK), 0, 100);
  const pri2Level = clamp(priLevel + 10, 0, 88);
  const priS = clamp(c.s, 0, 100);
  const pri2S = clamp(c.s - 10, 0, 100);
  const bubS = clamp(c.s - 12, 0, 100);

  const btn = levelFor(c, 0, isLight ? 46 : 62, TARGET_BTN);
  const bub = levelFor(c, -12, isLight ? 46 : 62, TARGET_BUB);
  const txt = isLight ? levelFor(c, 0, priLevel, TARGET_TEXT_LIGHT) : { L: priLevel };

  return {
    pri: `hsl(${H}, ${priS}%, ${priLevel}%)`,
    pri2: `hsl(${H}, ${pri2S}%, ${pri2Level}%)`,
    priText: `hsl(${H}, ${priS}%, ${txt.L}%)`,
    btn: `hsl(${H}, ${priS}%, ${btn.L}%)`,
    btnFg: relLum(btn.rgb[0], btn.rgb[1], btn.rgb[2]) <= TARGET_BTN
      ? FG_WHITE
      : pickFg(btn.rgb[0], btn.rgb[1], btn.rgb[2]),
    bubble: `hsl(${H}, ${bubS}%, ${bub.L}%)`,
    bubbleFg: relLum(bub.rgb[0], bub.rgb[1], bub.rgb[2]) <= TARGET_BUB
      ? FG_WHITE
      : pickFg(bub.rgb[0], bub.rgb[1], bub.rgb[2]),
    // 调试 / 测试用：实际档位与 rgb
    levels: { pri: priLevel, pri2: pri2Level, priText: txt.L, btn: btn.L, bubble: bub.L },
    btnRgb: btn.rgb, bubbleRgb: bub.rgb, priRgb: hslToRgb(H, priS, priLevel),
    priTextRgb: hslToRgb(H, priS, txt.L)
  };
}
