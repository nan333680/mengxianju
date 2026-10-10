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
  kaomojiStyle: 'jp-soft',
  emojiFreq: 0.1,
  verbosity: 'medium',
  splitMessages: false,
  typingDelay: 1.0,
  hesitation: true,
  longMemory: false,
  allowEditMine: false,   // 允许她整理记忆时改动"我手动加的那几条"
  // 长期记忆的三个节奏参数（新建角色时的初值）。
  // v1.14.0 起放宽：30/10 → 50/20，和 app.js 的 DEFAULTS 保持一致。
  // 两处必须同步改，否则新建角色和全局默认会打架。
  memSummarizeEvery: 50,
  memDedupeEvery: 20,
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
