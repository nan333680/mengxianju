// 剧情卡（story arc）—— 一张卡 = 「这段关系要往哪走」。
//
// 和人设的分工：人设回答「她是谁」，剧情卡回答「这段关系往哪走」。
// 它不是剧本，不给台词，只给方向和几拍，剩下的交给模型。
//
// 只有四样东西：方向 / 不能发生 / 几拍 / 现在走到哪一拍。
//   stakes、threads、styleCard 这些【故意不做】—— 2026-10 的 Phase 0 实测（3 张卡 × 10 轮）：
//   光是「当前拍 + 目标 + 障碍 + 转折 + 不能发生」这一组，三张卡都在第 3 轮就走到了最后一拍。
//   注意那是【改前】的结果：当时「转折」和「目标」并列摆给模型，它一轮就全演完了。
//   现在转折写成「到这一拍结束才该发生」的终点线，加字段已经不是主要矛盾，节奏才是。
//
// ⚠️ 拍的定义被 Phase 0 改过一次：原来把「转折」和「目标」并列摆给模型，
//    它一轮就把目标、障碍、转折全演完。现在转折是「到这一拍结束才该发生」的
//    东西，提示词明说这一轮别给 —— 目标是终点线，不是这一轮的任务单。
//
// v0.5.0.2 加了三样，都是「卡 → 引擎」这一步必须有的：
//    ① 每拍带 done + result：演完了要留一句「实际发生了什么」。不然推进到下一拍
//       之后模型完全不知道上一拍的结果 —— 卡上的「转折」写的是【预期】会怎么结束，
//       不等于真的那么发生了（它可能压根没发生）。
//    ② 卡上带 agenda（成员 id → 这一场里他想要什么）：群聊里每个人立场不同，
//       只给名字的话模型会让所有人替同一件事说话。
//    ③ 上一拍结果进提示词，当前拍仍然只给这一拍（后面几拍还是不给）。
//
// v0.5.0.3 把它当状态机补完（「存得住」→「演得完」）：
//    ④ 每拍记 turns（这一拍已经演了几轮）+ 卡上记 minTurns（一拍至少几轮才准收）。
//       没有这个，5 拍 3 轮就能走完 —— 那不是节奏，是提纲。
//    ⑤ status 三态：off / on / done。演完最后一拍进 done，arcPrompt 立刻返回空，
//       顶栏显示「剧情 · 完」—— 否则用户点了「这一段演完了」，下一轮她还在演同一拍。
//    ⑥ v 记卡结构版本。0.5.0.2 加了 done/result/agenda，将来再改字段时能认出旧卡。

export const ARC_BEATS_MAX = 12;
export const ARC_BEATS_MIN = 1;
/** 「不能发生什么」最多几条。超了保存前会问一句，不再静默截断。 */
export const ARC_CONSTRAINTS_MAX = 8;
/**
 * 卡结构版本。
 *   1 = 0.5.0.1 及更早（没有 done / result / turns / agenda）
 *   2 = 0.5.0.2 / 0.5.0.3（加了 done / result / agenda / turns / minTurns）
 *   3 = 0.5.0.4（off 变成真暂停；约束上限 6 → 8）
 * ⚠️ v0.5.0.4：这个数字现在真的被 normalizeArc 读了（见下面的 fromV），
 *    不再只是「写进去当个记号」。
 */
export const ARC_SCHEMA = 3;
/** 一拍至少演几轮才允许收。4 轮 × 5 拍 = 20 轮，才像一个段落。 */
export const ARC_MIN_TURNS = 4;

/** 一张空卡。status=off 表示这个角色没有在跑的剧情。 */
export function emptyArc() {
  return {
    v: ARC_SCHEMA, title: '', direction: '', constraints: [], beats: [], agenda: {},
    autoJudge: false, currentBeat: 0, status: 'off', minTurns: ARC_MIN_TURNS, updatedAt: 0,
  };
}

const S = (v, n = 400) => String(v == null ? '' : v).replace(/\r/g, '').trim().slice(0, n);
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

/**
 * 把任意来源（kv / 导入 / 手滑）的东西收成合法形状。永远返回一张卡，不抛。
 *
 * v0.5.0.3：空拍【默认保留】。以前落盘会把还没填字的拍滤掉，于是「加一拍 → 直接点
 * 『这一拍演完了』」会把当前拍当成最后一拍，整段当场结束 —— 而用户明明看到两拍。
 * 刚点「加一拍」那一拍必须活着（v0.5.0 也踩过：连点两次「加一拍」只得到一拍）。
 * 现在只有明确 dropEmpty 才滤，没有任何调用点用它 —— 空拍是合法状态：位置占着，内容待写。
 */
export function normalizeArc(raw, opts) {
  const dropEmpty = !!(opts && opts.dropEmpty);
  const a = raw && typeof raw === 'object' ? raw : {};
  const beats = Array.isArray(a.beats) ? a.beats : [];
  // v0.5.0.4：结构版本真的参与收编。
  //   v0（没有这个字段）= 0.5.0.1 及更早的卡：那些字段一个都没有，下面全部按默认值补；
  //   v1（内部草稿位，从未发布）：agenda 一度存成数组 [{id, want}]，这里转成 id → 一句话的对象。
  //     只认对象形态：没有 id 的裸字符串还原不出「谁想要什么」，落过也没法救，别假装能救；
  //   v2 → v3：只多了「约束上限 6→8」和 off 语义，不涉及字段形状，不用转换。
  const fromV = Math.round(num(a.v, 0));
  let agendaSrc = a.agenda;
  if (fromV < 2 && Array.isArray(agendaSrc)) {
    const o = {};
    for (const it of agendaSrc) {
      if (it && typeof it === 'object' && it.id) o[String(it.id)] = it.want || it.text || '';
    }
    agendaSrc = o;
  }
  const out = {
    v: ARC_SCHEMA,
    title: S(a.title, 60),
    direction: S(a.direction, 1200),
    constraints: (Array.isArray(a.constraints) ? a.constraints : []).map(x => S(x, 80)).filter(Boolean).slice(0, ARC_CONSTRAINTS_MAX),
    beats: beats.map(b => ({
      t: S(b && b.t, 60),
      goal: S(b && b.goal, 200),
      obs: S(b && b.obs, 200),
      turn: S(b && b.turn, 200),
      // v0.5.0.2：这拍演完没有、演完时到底发生了什么。
      // done 只有界面上的「这一拍演完了」或自动判定会写；老卡一进来就是没演完。
      done: !!(b && b.done),
      // v0.5.0.4：done 是谁标的。'auto' = 自动判定，'user' = 人点的（✓ 开关或「这一拍演完了」）。
      // 为什么要记：重新生成等于这一轮重演一遍，自动判定的结论当场过期，得能单独清掉；
      // 人手标的 done 是他的判断，重抽一次不该被系统抹掉。
      doneBy: b && (b.doneBy === 'user' || b.doneBy === 'auto') ? b.doneBy : '',
      // v0.5.0.4 追加：result 只在 done 时才【注入】，但没 done 也不静默删掉。
      //
      // 第一版写的是「读入即清」（eval 里 done=false 一律变成空串），当场踩了坑：
      // 界面上「实际发生了什么」这个框是可以先填、后点「这一拍演完了」的 ——
      // 填完不点保存直接推进，normalizeArc 先把 result 抹掉，再标 done，
      // 用户看到自己填的字凭空消失，而且没有任何提示。撒谎的方式只是换了个方向。
      //
      // 现在的规矩：库里照存，注入侧把关。唯一印 result 的地方是 arcPrompt 里
      // prevDoneBeat() 那个分支，它只认 done 为 true 的拍 —— 所以 0.5.0.2/0.3 遗留的
      // 「done=false 却带着 result」的旧卡，永远进不了提示词，也就不存在诈尸。
      result: S(b && b.result, 240),
      // v0.5.0.3：这一拍已经演了几轮。切到这一拍时是 0，每轮她说完 +1。
      turns: Math.max(0, Math.round(num(b && b.turns, 0))),
    })).filter(b => !dropEmpty || b.t || b.goal || b.obs || b.turn || b.done || b.result).slice(0, ARC_BEATS_MAX),
    // 群聊：成员 id → 这一场里他想要什么。键是角色 id，值是一句话。
    agenda: {},
    // 每轮让模型自己判「这一拍演完没有」（beta，默认关：每轮多一次小请求）。
    // 只标记 done，不自动推进 —— 推错了毁节奏且没法回滚，推进权留给人。
    autoJudge: !!(a.autoJudge),
    currentBeat: 0,
    status: a.status === 'on' ? 'on' : (a.status === 'done' ? 'done' : 'off'),
    minTurns: Math.min(20, Math.max(1, Math.round(num(a.minTurns, ARC_MIN_TURNS)))),
    updatedAt: Number(a.updatedAt) || 0,
  };
  if (agendaSrc && typeof agendaSrc === 'object' && !Array.isArray(agendaSrc)) {
    for (const k of Object.keys(agendaSrc)) {
      const v = S(agendaSrc[k], 120);
      if (k && v) out.agenda[k] = v;
    }
  }
  // 一张既没有方向、也没有任何一拍写了字的卡 = 空卡，别当成开着（v0.5.0.4 追加）。
  //
  // ⚠️ 原来这里判的是「一拍都没有」。于是「有方向 → 加一个空拍 → 把方向清掉再保存」
  //    会留下一张 beats.length=1、direction='' 的卡：normalizeArc 不强制 off，
  //    status 停在 'on'；而 arcActive 却要求「有方向或有写了字的拍」→ false。
  //    结果是同一个状态被三处各判一套：顶栏显示「剧情 · 关」、弹窗因为没有
  //    status==='off' 而不显示黄条/重新开启、推进按钮却能点（点了什么都不发生）。
  //    现在条件与 arcActive 严格对齐 —— 不变量：status==='on' ⟺ arcActive()。
  if (!out.direction && !out.beats.some(beatHasText)) { out.status = 'off'; out.title = ''; }
  out.currentBeat = Math.max(0, Math.min(out.beats.length - 1, Math.round(Number(a.currentBeat) || 0)));
  if (!out.beats.length) out.currentBeat = 0;
  // 演完了但卡上还有拍：保持 done（别再被 arcActive 当开着）。
  return out;
}

/**
 * 这轮到底要不要往提示词里塞剧情卡。done 之后不再注入。
 *
 * v0.5.0.4 追加：只认 status，不再自己另判一次「有方向或有写了字的拍」。
 * 那个第二条件是上面那个 bug 的另一半 —— 两套判据一旦不一致，就会出现
 * 「顶栏说关着、按钮说能推」这种状态。自洽由 normalizeArc 保证（它会把
 * 真正的空卡强制成 off），这里只读一个来源。
 */
export function arcActive(arc) {
  return normalizeArc(arc).status === 'on';
}

/** 这一拍写了东西没有（空拍只占位置，不进提示词内容）。 */
export function beatHasText(b) {
  return !!(b && (b.t || b.goal || b.obs || b.turn || b.result));
}

/** 这一段是否已经演完（最后一拍也收尾了）。 */
export function arcFinished(arc) {
  const a = normalizeArc(arc);
  return a.status === 'done' && (!!a.direction || a.beats.length > 0);
}

/** 当前拍是不是最后一拍。界面拿它决定「推进」按钮要不要变成「这段演完了」。 */
export function atLastBeat(arc) {
  const a = normalizeArc(arc);
  return !a.beats.length || a.currentBeat >= a.beats.length - 1;
}

/**
 * 紧邻的上一拍如果演完了，返回它的拍号（0 基），否则 -1。
 *
 * ⚠️ v0.5.0.4 追加：原来是「从 currentBeat-1 往前找最近一拍 done」。那样会认错人 ——
 * 「设为当前」允许跳过中间拍，于是 currentBeat=3、第 1 拍 done、第 2 拍没演完时，
 * 它会把【第 1 拍】当成「上一拍」把 result 注入进去，而真正的上一拍（第 2 拍）
 * 压根没演。提示词里写「上一拍已经过去了，实际发生的是 X」就是在讲没发生过的历史。
 * 只认 currentBeat-1：跳过的拍就是没演，不硬凑一个「上一拍」出来。
 */
export function prevDoneBeat(arc) {
  const a = normalizeArc(arc);
  const i = a.currentBeat - 1;
  return i >= 0 && a.beats[i] && a.beats[i].done ? i : -1;
}

/** 当前拍演了几轮、够不够收。arcPrompt 和自动判定都用这一组判断。 */
export function beatTurns(arc, i) {
  const a = normalizeArc(arc);
  const b = a.beats[i === undefined ? a.currentBeat : i];
  return { turns: b ? b.turns : 0, min: a.minTurns, enough: !!b && b.turns >= a.minTurns };
}

/**
 * 生成注入本轮段的那一段。
 * 只注入【当前拍】，不注入整张卡 —— 整张卡会让模型提前演后面的拍（Phase 0 实测过：
 * 把三拍全给它，它第 1 轮就想把三拍串起来）。
 *
 * opts.names：群聊时用，成员 id → 名字，用来把 arc.agenda 印成人能读的「谁想要什么」。
 */
export function arcPrompt(raw, opts) {
  const a = normalizeArc(raw);
  if (!arcActive(a)) return '';
  const names = (opts && opts.names) || {};
  const lines = ['# 这段剧情的走向'];
  const head = [];
  if (a.title) head.push('这段叫「' + a.title + '」。');
  if (a.direction) {
    head.push('他要这段往这个方向走：' + a.direction);
    head.push('这是【方向】不是剧本：你自己安排每轮演到哪一步，不要为了赶进度把后面的事提前搬上来。');
  }
  // v0.5.0.2：上一拍真的演完了就带一句结果。
  // 卡上的「转折」是【预期】它会怎么结束，不等于真的那么发生了 ——
  // 只把预期当历史讲给她，会出现「上一拍说东西摔了」但正文里根本没摔的情况。
  const pi = prevDoneBeat(a);
  if (pi >= 0) {
    const pb = a.beats[pi];
    const lbl = '第 ' + (pi + 1) + ' 拍' + (pb.t ? '「' + pb.t + '」' : '');
    head.push(pb.result
      ? '上一拍（' + lbl + '）已经过去了，实际发生的是：' + pb.result
      : '上一拍（' + lbl + '）已经过去了。');
    head.push('这一轮从它【之后】接着写 —— 上一拍的事已经演完了，别再演一遍。');
  }
  if (head.length) lines.push(head.join('\n'));

  const b = a.beats[a.currentBeat];
  if (b) {
    const blk = [];
    const no = '现在演到第 ' + (a.currentBeat + 1) + ' 拍（共 ' + a.beats.length + ' 拍）' + (b.t ? '：' + b.t : '') + '。';
    blk.push(no);
    if (!beatHasText(b)) {
      blk.push('这一拍还没写内容 —— 就按上面那个方向自己往下走，别把这一轮当成要冲终点。');
    }
    if (b.goal) blk.push('这一拍要到的地方：' + b.goal);
    if (b.obs) blk.push('卡在哪：' + b.obs);
    // v0.5.0.3：节奏写进提示词。以前只有「这一轮别给它」，模型没有轮数概念，
    // 于是 5 拍 3 轮就演完 —— 那不是节奏，是提纲。
    const turnLine = b.turns > 0
      ? '这一拍才演了 ' + b.turns + ' 轮' + (b.turns < a.minTurns
          ? '（至少 ' + a.minTurns + ' 轮才收），现在还不够 —— 别把她往终点推，先让这一拍自己长。'
          : '（已经够 ' + a.minTurns + ' 轮了），可以往收的地方引，但别一步跳过去。')
      : '';
    if (b.turn) {
      blk.push('到这一拍【结束】才该发生的事：' + b.turn
        + '\n' + '—— 这一轮别给它。先让上面那个「卡在哪」真的卡住、让在场的人各按各的立场顶一顶；'
        + '什么时候给、给多少，你看着来，别一轮就把这一拍演完。');
    }
    if (turnLine) blk.push(turnLine);
    lines.push(blk.join('\n'));
  }

  // v0.5.0.2：群聊各人的目的。没有 agenda 就整段不出现（单聊永远走不到这里）。
  const ag = [];
  for (const id of Object.keys(a.agenda)) {
    const nm = names[id] || '';
    if (nm) ag.push('· ' + nm + '：' + a.agenda[id]);
  }
  if (ag.length) {
    lines.push('这一场里各人想要的东西不一样：' + '\n' + ag.join('\n')
      + '\n' + '—— 写谁就用谁的目的说话办事，别让所有人都替同一件事着急；也别让没在场的人插嘴。');
  }

  if (a.constraints.length) {
    lines.push('这几件事【不要发生】：' + '\n' + a.constraints.map(c => '· ' + c).join('\n'));
  }
  lines.push('他要是把话题岔开了，先接住他的话，再往回带 —— 别硬拽回这条线，也别把方向当成台词念出来。');
  return lines.join('\n\n');
}
