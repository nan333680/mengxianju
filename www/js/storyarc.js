// 剧情卡（story arc）—— 一张卡 = 「这段关系要往哪走」。
//
// 和人设的分工：人设回答「她是谁」，剧情卡回答「这段关系往哪走」。
// 它不是剧本，不给台词，只给方向和几拍，剩下的交给模型。
//
// ⚠️ 只有这四样东西：方向 / 不能发生 / 几拍 / 现在走到哪一拍。
//    stakes（每个人想要什么怕什么）、threads（未解决线索）、styleCard（风格卡）
//    这些【故意不做】—— Phase 0 实测（tmp/phase0.mjs，3 张卡 × 10 轮）：
//    光是「当前拍 + 目标 + 障碍 + 转折 + 不能发生」这一组，三张卡都在第 3 轮
//    就走到了最后一拍，说明这套信息已经够模型看懂方向了。再加字段只是让卡变重。
//    等到「拍走太快」或「立场写不出来」变成真的问题时，再按需加。
//
// ⚠️ 拍的定义被 Phase 0 改过一次：原来把「转折」和「目标」并列摆给模型，
//    它一轮就把目标、障碍、转折全演完（实测修罗场 r1 一轮走完第 1 拍）。
//    现在转折是「到这一拍结束才该发生」的东西，提示词明说这一轮别给 ——
//    目标是终点线，不是这一轮的任务单。

export const ARC_BEATS_MAX = 5;
export const ARC_BEATS_MIN = 1;

/** 一张空卡。status='off' 表示这个角色没有在跑的剧情。 */
export function emptyArc() {
  return { title: '', direction: '', constraints: [], beats: [], currentBeat: 0, status: 'off', updatedAt: 0 };
}

const S = (v, n = 400) => String(v == null ? '' : v).replace(/\r/g, '').trim().slice(0, n);

/**
 * 把任意来源（kv / 导入 / 手滑）的东西收成合法形状。永远返回一张卡，不抛。
 *
 * keepEmpty = true 是给【编辑中的草稿】用的：刚点「加一拍」还没填字的那一拍要留着，
 * 否则下一次重画表单它就被自己吃掉了（v0.5.0 实测过：连点两次「加一拍」只得到一拍）。
 * 落盘和进提示词都走默认的 false —— 空拍不该存在库里。
 */
export function normalizeArc(raw, opts) {
  const keepEmpty = !!(opts && opts.keepEmpty);
  const a = raw && typeof raw === 'object' ? raw : {};
  const beats = Array.isArray(a.beats) ? a.beats : [];
  const out = {
    title: S(a.title, 60),
    direction: S(a.direction, 1200),
    constraints: (Array.isArray(a.constraints) ? a.constraints : []).map(x => S(x, 80)).filter(Boolean).slice(0, 6),
    beats: beats.map(b => ({
      t: S(b && b.t, 60),
      goal: S(b && b.goal, 200),
      obs: S(b && b.obs, 200),
      turn: S(b && b.turn, 200),
    })).filter(b => keepEmpty || b.t || b.goal || b.obs || b.turn).slice(0, ARC_BEATS_MAX),
    currentBeat: 0,
    status: a.status === 'on' ? 'on' : 'off',
    updatedAt: Number(a.updatedAt) || 0,
  };
  // 一拍都没有、方向也空 —— 那就是没卡，别当成开着。
  if (!out.direction && !out.beats.length) { out.status = 'off'; out.title = ''; }
  out.currentBeat = Math.max(0, Math.min(out.beats.length - 1, Math.round(Number(a.currentBeat) || 0)));
  if (!out.beats.length) out.currentBeat = 0;
  return out;
}

/** 这轮到底要不要往提示词里塞剧情卡。 */
export function arcActive(arc) {
  const a = normalizeArc(arc);
  return a.status === 'on' && (!!a.direction || a.beats.length > 0);
}

/**
 * 生成注入本轮段的那一段。
 * 只注入【当前拍】，不注入整张卡 —— 整张卡会让模型提前演后面的拍（Phase 0 实测过：
 * 把三拍全给它，它第 1 轮就想把三拍串起来）。
 */
export function arcPrompt(raw) {
  const a = normalizeArc(raw);
  if (!arcActive(a)) return '';
  const lines = ['# 这段剧情的走向'];
  const head = [];
  if (a.title) head.push('这段叫「' + a.title + '」。');
  if (a.direction) {
    head.push('他要这段往这个方向走：' + a.direction);
    head.push('这是【方向】不是剧本：你自己安排每轮演到哪一步，不要为了赶进度把后面的事提前搬上来。');
  }
  if (head.length) lines.push(head.join('\n'));

  const b = a.beats[a.currentBeat];
  if (b) {
    const blk = ['现在演到第 ' + (a.currentBeat + 1) + ' 拍（共 ' + a.beats.length + ' 拍）' + (b.t ? '：' + b.t : '') + '。'];
    if (b.goal) blk.push('这一拍要到的地方：' + b.goal);
    if (b.obs) blk.push('卡在哪：' + b.obs);
    if (b.turn) {
      // 这一句是 Phase 0 之后加的：转折必须是"终点"而不是"这一轮的任务"，
      // 否则模型一轮演完一拍，三拍撑不过三轮。
      blk.push('到这一拍【结束】才该发生的事：' + b.turn
        + '\n—— 这一轮别给它。先让上面那个「卡在哪」真的卡住、让两个人各按各的立场顶一顶；'
        + '什么时候给、给多少，你看着来，别一轮就把这一拍演完。');
    }
    lines.push(blk.join('\n'));
  }

  if (a.constraints.length) {
    lines.push('这几件事【不要发生】：\n' + a.constraints.map(c => '· ' + c).join('\n'));
  }
  lines.push('他要是把话题岔开了，先接住他的话，再往回带 —— 别硬拽回这条线，也别把方向当成台词念出来。');
  return lines.join('\n\n');
}
