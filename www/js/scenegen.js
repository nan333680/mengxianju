// 小说生成编排（v0.5.2）。
//
// 分工：scene.js 是纯函数（提示词 + 检查），这里只负责「发请求、收文本、跑检查」。
// 故意【不碰 DOM、不碰 db】—— e2e-scene 可以在浏览器里直接 import 它，
// 用假 fetch 把整个生成流程跑一遍。
//
// 规格 §8 的四步在这里一一对应：
//   短场：genProse 一次 → genLog 一次（不单独分镜）
//   中场：genBeatPlan 一次 → 他确认/改拍 → genProse 每拍一次 → genLog 一次
// 截断与失败的判定留给调用方（app.js）做界面，这里只把事实交出去：
//   { text, finish, quality:{ok,reasons,chars}, truncated }

import { streamChat, onceChat } from './api.js';
import {
  sceneProsePrompt, sceneBeatPlanPrompt, sceneLogPrompt, tempCastPrompt,
  parseJsonLoose, checkQuality, beatChars
} from './scene.js';

function baseOf(cfg) {
  const c = cfg || {};
  return {
    apiKey: c.apiKey, baseUrl: c.baseUrl, model: c.model, provider: c.provider
  };
}

/**
 * 这一次正文最多让模型写多少 token。
 *
 * 中文一个字约 1.5–1.8 token，留 2.2 倍 + 400 的余量；
 * 上限卡 8000 —— 再大不是在写这一场，是在烧钱（规格 §3：字数是上限不是任务）。
 */
export function maxTokensFor(targetChars) {
  const t = Number(targetChars) || 600;
  return Math.max(1200, Math.min(8000, Math.round(t * 2.2) + 400));
}

/**
 * 写一拍正文（流式）。
 *
 * opts: { scene, cfg, beatIdx, prevText, userLine, directive, context, log, signal, onDelta }
 *   prevText  —— 「继续这一段」：把已经写的尾巴接上
 *   userLine  —— 演员模式：他自己写的那句（不许替他说）
 *   directive —— 导演模式：导演指令（不进正文）
 *   context   —— 开戏时的底色快照（她是谁 / 世界 / 已发生过什么），v0.5.2.4
 *   log       —— 前面几拍的场记（多拍接力用），v0.5.2.4
 */
export async function genProse(o) {
  const { scene, cfg, beatIdx = 0, prevText = '', userLine = '', directive = '',
    context = '', log = null, signal, onDelta } = o || {};
  const prompt = sceneProsePrompt(scene, {
    beatIdx, prevText, userLine, directive, context, log,
    fixup: (o && o.fixup) || ''
  });
  // 多拍时按【一拍】的额度要 token（v0.5.3.1）：整场 8000 字一次要一万八千 token，
  // maxTokensFor 上限 8000 会把尾巴截断 —— 而后几拍本来就是另外几次请求。
  const per = beatChars(scene && scene.length);
  const capChars = Math.max(per.max, Number(scene && scene.targetChars && scene.targetChars[1]) || 600);
  let text = '';
  let finish = '';
  const it = streamChat({
    ...baseOf(cfg),
    messages: [{ role: 'system', content: prompt }],
    temperature: Number((cfg && cfg.temperature) || 0.9),
    maxTokens: maxTokensFor(capChars),
    reasoningEffort: 'none',
    signal,
    onFinish: fr => { finish = String(fr || ''); }
  });
  for await (const d of it) {
    text += d;
    if (onDelta) { try { onDelta(text); } catch { /* 回调出错不该打断生成 */ } }
  }
  const trimmed = text.trim();
  const quality = checkQuality(trimmed, scene, beatIdx);
  return {
    text: trimmed,
    finish,
    quality,
    // finish_reason=length = 被 token 上限截断。调用方据此显示「这一段没写完」。
    truncated: finish === 'length'
  };
}

/** 分镜：按档位出 1–5 拍（JSON）。解析失败返回 null，由调用方决定重试还是让用户手写。 */
export async function genBeatPlan(o) {
  const { scene, cfg } = o || {};
  const raw = await onceChat({
    ...baseOf(cfg),
    messages: [{ role: 'system', content: sceneBeatPlanPrompt(scene) }],
    temperature: 0.7,
    maxTokens: 2200,   // 5 拍（整章档）的 JSON 也要装得下
    noThink: true,
    timeoutMs: 120000
  });
  const j = parseJsonLoose(raw);
  if (!j) return { ok: false, beats: [], raw };
  const arr = Array.isArray(j.beats) ? j.beats : [];
  return { ok: arr.length > 0, beats: arr, raw };
}

/** 场记（§9.2）：正文写完之后单独一次请求，产出 {events, cast, change, openThreads, keyLines} */
export async function genLog(o) {
  const { text, cfg } = o || {};
  const raw = await onceChat({
    ...baseOf(cfg),
    messages: [{ role: 'system', content: sceneLogPrompt(text) }],
    temperature: 0.3,
    maxTokens: 900,
    noThink: true,
    timeoutMs: 120000
  });
  const j = parseJsonLoose(raw);
  if (!j) return { ok: false, log: null, raw };
  const arr = v => (Array.isArray(v) ? v : []).map(x => String(x || '').trim()).filter(Boolean);
  return {
    ok: true,
    log: {
      events: arr(j.events),
      cast: arr(j.cast),
      change: String(j.change || '').trim(),
      openThreads: arr(j.openThreads),
      keyLines: arr(j.keyLines).slice(0, 3),
      // v0.5.3：这一场新确立的设定。不写进这里 = 提示词要了、模型给了、然后被丢掉。
      newSettings: arr(j.newSettings).map(x => x.slice(0, 40)).slice(0, 3)
    },
    raw
  };
}

/** 临时人物 5 行小卡（§6）。名字由模型给，但风格约束在提示词里。 */
export async function genTempCast(o) {
  const { scene, used = [], extra = '', cfg } = o || {};
  const raw = await onceChat({
    ...baseOf(cfg),
    messages: [{ role: 'system', content: tempCastPrompt(scene, used, extra) }],
    temperature: 0.8,
    maxTokens: 500,
    noThink: true,
    timeoutMs: 90000
  });
  const j = parseJsonLoose(raw);
  if (!j || !String(j.name || '').trim()) return { ok: false, card: null };
  return {
    ok: true,
    card: {
      name: String(j.name).trim().slice(0, 12),
      identity: String(j.identity || '').trim().slice(0, 40),
      look: String(j.look || '').trim().slice(0, 60),
      want: String(j.want || '').trim().slice(0, 60),
      secret: String(j.secret || '').trim().slice(0, 60)
    }
  };
}
