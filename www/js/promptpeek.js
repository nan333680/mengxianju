// promptpeek.js — 提示词检查器（0.5.3.5）
//
// 为什么要有它（用户方向文档 P0-2）：
//   「她今天怎么这么不像话」这类问题，一半出在提示词里 —— 但整个应用此前
//   没有任何地方能看到【实际发出去的那份】。改设置 → 发一句 → 效果变了，
//   中间那一步（提示词长什么样、哪一段来自哪个设置）完全是黑箱。
//
// 这个文件只做纯变换：把一份请求快照切成段、标上来源、算字数。
// 不读 DOM、不碰网络，所以能单测、也能在诊断页之外复用。
//
// 快照形状（由 app.js 的 send() 在真正发请求那一刻记下）：
//   { at, model, charName, stable, note, search, msgs: [{role, content}], tokens }
//
// 来源只有三种，按拼接顺序定：稳定前缀（可缓存）/ 历史（按分支取的活动路径）/ 本轮重建。
// ⚠️ 不要把「来源」写成猜测式判断（比如"含【记忆】就是记忆段"）——
//    那样改一次段名就悄悄错位，而这一页存在的意义就是【说得准】。

/** 按行首「# 」切段。没有标题的前导内容算一段「（开头）」 */
export function splitPromptSections(text) {
  const src = String(text == null ? '' : text);
  const lines = src.split('\n');
  const out = [];
  let head = '';
  let body = [];
  const flush = () => {
    const t = body.join('\n').trim();
    if (head || t) out.push({ head: head || '（开头）', text: t, chars: t.length });
    body = [];
  };
  for (const ln of lines) {
    if (/^#\s/.test(ln)) { flush(); head = ln.replace(/^#\s*/, '').trim(); }
    else body.push(ln);
  }
  flush();
  return out;
}

/**
 * 把快照整理成「可以照着念」的段落列表。
 * 顺序与真实请求体一致：稳定前缀 → 历史 → 本轮 → 搜索（如果有）。
 */
export function summarizePrompt(snap) {
  const s = snap || {};
  const msgs = Array.isArray(s.msgs) ? s.msgs : [];
  const rows = [];
  const pushSys = (title, text, source) => {
    const secs = splitPromptSections(text);
    if (!secs.length) return;
    rows.push({ kind: 'sec-head', title, source, chars: String(text || '').length, index: rows.length });
    for (const sec of secs) {
      rows.push({ kind: 'sec', title: sec.head, source, chars: sec.chars, text: sec.text, index: rows.length });
    }
  };
  pushSys('稳定前缀', s.stable, '可缓存');
  // 历史：真正发出去的那几条，按 role 标（群聊里 user 那行带【名字】前缀，原样显示）
  const hist = msgs.filter(m => m && m.role !== 'system');
  if (hist.length) {
    rows.push({ kind: 'sec-head', title: '聊天历史', source: '这一轮取的 ' + hist.length + ' 条', chars: 0, index: rows.length });
    hist.forEach((m, i) => {
      const txt = String(m.content || '');
      const isLast = i === hist.length - 1;
      rows.push({
        kind: 'msg', title: (m.role === 'assistant' ? '她' : '你') + (isLast ? '（这一条）' : '') ,
        source: m.role === 'assistant' ? '历史里的回复' : '历史里的发言',
        chars: txt.length, text: txt, index: rows.length,
      });
    });
  }
  pushSys('本轮重建', s.note, '每轮都变');
  if (s.search) pushSys('联网搜索结果', s.search, '只在打了 /搜 的那一轮');
  const sysMsgs = msgs.filter(m => m && m.role === 'system');
  // 深度插入的世界书条目也是 system（不在 stable/note 里），单独列出来，
  // 否则「世界书深度 4 的那条到底发没发」永远查不到。
  const extra = sysMsgs.filter(m => m.content !== s.stable && m.content !== s.note && m.content !== s.search);
  if (extra.length) {
    rows.push({ kind: 'sec-head', title: '深度插入的世界书', source: '按 depth 插在历史里', chars: 0, index: rows.length });
    extra.forEach((m, i) => rows.push({ kind: 'msg', title: '第 ' + (i + 1) + ' 条', source: '世界书', chars: String(m.content || '').length, text: String(m.content || ''), index: rows.length }));
  }
  return rows;
}

/** 一句话总览（给弹层顶部用） */
export function promptSummary(snap) {
  const s = snap || {};
  const msgs = Array.isArray(s.msgs) ? s.msgs : [];
  const sysChars = msgs.filter(m => m.role === 'system').reduce((a, m) => a + String(m.content || '').length, 0);
  const histChars = msgs.filter(m => m.role !== 'system').reduce((a, m) => a + String(m.content || '').length, 0);
  return {
    chars: sysChars + histChars,
    sysChars,
    histChars,
    msgs: msgs.length,
    tokens: Number(s.tokens) || 0,
    model: String(s.model || ''),
    charName: String(s.charName || ''),
  };
}
