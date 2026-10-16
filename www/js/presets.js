// 角色模板。
//
// 只剩「空白角色」一项：不带人设、不带开场白，进场就是个空表单。
// 想照着现成的写，仓库 examples/ 目录里有几份角色卡可以直接导入。
// PARAM_DEFAULTS 是新建角色时的参数初值（之后每个角色各改各的）。

export const PARAM_DEFAULTS = {
  temperature: 1.0,
  maxTokens: 2048,
  topP: 1.0,
  reasoningEffort: 'low',
  contextRounds: 20,
  kaomojiFreq: 0.15,
  // kaomojiStyle 于 v0.4.2.3 删除（审计 F3）：四档旋钮改了看不出区别，
  // 唯一作用是提示词里那句「你的口味偏X」，删掉省得留个假开关。
  emojiFreq: 0.1,
  verbosity: 'medium',
  splitMessages: false,
  typingDelay: 1.0,
  hesitation: true,
  longMemory: false,
  allowEditMine: false,   // 允许她整理记忆时改动"我手动加的那几条"
  // ⚠️ 这三个是【历史遗留】（2026-10-15 注）：长期记忆的节奏参数是【全局】的
  //    （app.js 的 DEFAULTS 说了算），角色记录里根本不保存它们 —— saveCharEdit
  //    收集的字段里没有 mem*，所以写在这里只影响编辑页表单的预填值，而表单上没有
  //    对应的控件，等于没人读。真值以 app.js DEFAULTS 为准（总结 50 / 上限 20）。
  //    memDedupeEvery 已整个删掉：查重门槛从 v1.21.28 起看的是新增记忆条数，
  //    不由轮次控制（见 app.js dedupeIfNeeded 的 grownEnough）。
  memSummarizeEvery: 50,
  memLimit: 20
};

export const PRESETS = [
  {
    key: 'blank',
    name: '空白角色',
    emoji: '✨',
    tagline: '从零开始，自己写人设',
    greeting: '',
    params: {},
    persona: ''
  }
];

export function getPreset(key) {
  return PRESETS.find(p => p.key === key);
}
