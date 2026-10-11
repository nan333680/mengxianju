// 导出 Markdown（v1.21.48）
//
// 为什么单独一个文件：这是【唯一】一个「把聊天变成成品」的出口 ——
// 设计建议里那句话是「写了几万字，导不出 Markdown/TXT，就等于没写」。
// 它不碰存储、不碰 prompt、不碰渲染，只读消息然后拼字符串，
// 所以放在这里当纯函数：接一组消息进来，吐一个字符串出去，e2e 可以直接喂数据断言。

/** 时段 → 中文。app.js 里有一份 CLOCK_PHASES 是给界面用的，这里自备一份，
 *  免得导出模块反过来依赖 app.js（它俩的用途不同：那边是选项，这边是标题文案）。 */
const PHASE_CN = {
  dawn: '凌晨', morning: '早上', forenoon: '上午', noon: '中午',
  afternoon: '下午', evening: '傍晚', night: '晚上', lateNight: '深夜',
};

/** 一年 = 365 天（和 app 里那一套换算保持一致；这里只用来显示） */
export function dayText(day) {
  const d = Number(day) || 1;
  if (d <= 365) return '第 ' + d + ' 天';
  const y = Math.floor((d - 1) / 365) + 1;
  const rest = d - (y - 1) * 365;
  return '第 ' + y + ' 年 ' + rest + ' 天';
}

/** 一条消息的剧情时间标题（老消息没有 story 就返回空串） */
function stampText(m) {
  const s = m && m.story;
  if (!s || !s.day) return '';
  const phase = PHASE_CN[s.phase] || '';
  const hm = (typeof s.hour === 'number') ? (' ' + String(s.hour).padStart(2, '0') + ':' + String(s.minute || 0).padStart(2, '0')) : '';
  return dayText(s.day) + (phase ? ' · ' + phase : '') + hm;
}

/** 真实时间戳 → 本地 'YYYY-MM-DD HH:mm'（导出文件的头部用） */
function realText(ts) {
  const d = new Date(Number(ts) || Date.now());
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
       + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

/**
 * 把一段对话拼成 Markdown。
 *
 * @typedef {object} ExportMsg
 * @property {string}  [role]
 * @property {string}  [content]
 * @property {boolean} [archived]
 * @property {number}  [ts]
 * @property {string[]} [images]
 * @property {string[]} [imageNotes]
 *
 * @param {object} o
 * @param {{name?: string}} [o.char]  角色对象（只用到 name）
 * @param {ExportMsg[]} [o.messages]  该角色的全部消息，按时间正序
 * @param {string} [o.meName] 我那一侧显示成什么（默认就是：我）
 * @param {number} [o.now]    导出时刻（测试里固定用）
 * @returns {string}
 */
export function buildChatMarkdown({ char, messages, meName = '我', now = Date.now() } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const name = (char && char.name) || '未命名角色';
  const archivedCount = list.filter(m => m && m.archived).length;
  const out = [];
  out.push('# ' + name + ' · 对话记录');
  out.push('');
  out.push('- 导出时间：' + realText(now));
  out.push('- 消息：' + list.length + ' 条' + (archivedCount ? '（其中已归档 ' + archivedCount + ' 条）' : ''));
  if (list.length) {
    const first = stampText(list[0]), last = stampText(list[list.length - 1]);
    if (first || last) out.push('- 剧情时间：' + (first || '？') + ' → ' + (last || '？'));
  }
  out.push('');
  out.push('---');
  out.push('');

  let curStamp = null;
  for (const m of list) {
    if (!m) continue;
    const st = stampText(m);
    // 剧情时间一变就开一段 —— 读者靠它找「那天发生了什么」。
    // 老消息没有 story（st 为空）时不分段，全都放在同一个标题下面。
    if (st !== curStamp) {
      curStamp = st;
      if (st) { out.push('## ' + st); out.push(''); }
    }
    const who = m.role === 'user' ? meName : name;
    out.push('**' + who + '**' + (m.archived ? '（已归档）' : ''));
    out.push('');
    const body = String(m.content == null ? '' : m.content).trim();
    out.push(body || '（空）');
    // 图片只留个占位：Markdown 里嵌 dataURL 会把文件撑成几 MB，发给谁都打不开。
    const pics = Array.isArray(m.images) ? m.images.length : 0;
    if (pics) {
      const notes = Array.isArray(m.imageNotes) ? m.imageNotes : [];
      for (let i = 0; i < pics; i++) {
        out.push('［图片' + (pics > 1 ? ' ' + (i + 1) : '') + (notes[i] ? '：' + String(notes[i]).replace(/[\r\n]+/g, ' ') : '') + '］');
      }
    }
    out.push('');
  }
  if (!list.length) out.push('（这个角色还没有聊天记录）');
  return out.join('\n');
}

/** 文件名：角色名 + 日期。角色名里的路径字符要去掉（否则安卓写文件会失败）。 */
export function markdownFileName(charName, now = Date.now()) {
  const d = new Date(Number(now) || Date.now());
  const p = n => String(n).padStart(2, '0');
  const date = d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate());
  const safe = String(charName || '对话').replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 24);
  return '梦弦居-' + safe + '-' + date + '.md';
}