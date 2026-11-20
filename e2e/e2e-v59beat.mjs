// e2e-v59beat.mjs —— 分段提示词必须读到素材（v0.5.8.2）。
//
// 纯 Node，不启浏览器：scene.js 没有任何 import，直接 import 就能测
// （同 e2e-v58fix.mjs 测 autobackup 的做法）。
//
// 为什么要有这一套：v0.5.3.1 把正文侧的口径从「当背景」改成「当素材」，漏了分段侧 ——
// 于是「把这段写成小说」分出来的拍全是凭角色名编的，正文再硬往编好的框上缝。
// 这里锁三件事：素材进得去、排得对、场景四项不丢。
import { sceneBeatPlanPrompt, emptyScene, normalizeScene } from '../www/js/scene.js';

let pass = 0, fail = 0;
const t = (n, ok, ex = '') => { if (ok) { pass++; console.log('  OK   ' + n); } else { fail++; console.log('  FAIL ' + n + (ex ? '  -> ' + ex : '')); } };

const EXCERPT = '小铃：这本账你还了吗\n我：还没。\n小铃：那我记着。夜里别来敲门。';
const base = (o) => normalizeScene({ ...emptyScene('c1'), length: 'medium', userMode: 'actor', ...o });

const chat = base({
  source: { kind: 'chat', chatCharId: 'c1', msgIds: ['m1'], excerpt: EXCERPT },
  setting: { place: '铃奈庵', time: '傍晚', weather: '下雨' },
  cast: [
    { role: 'main', name: '本居小铃', charId: 'c1' },
    { role: 'user', name: '你' },
    { role: 'temp', name: '阿求', card: { identity: '记录者' } }
  ]
});
const src = sceneBeatPlanPrompt(chat);

console.log('=== 素材 ===');
t('1 素材进了提示词', src.includes(EXCERPT));
t('2 素材排在「要改变什么」之前', src.indexOf(EXCERPT) >= 0 && src.indexOf(EXCERPT) < src.indexOf('这一场要改变什么'));
t('3 第一行仍是「给这一场戏分拍」（e2e 假模型靠这两个字路由）', src.split('\n')[0].startsWith('给这一场戏分拍'));
t('4 明说了不要照抄对话', src.includes('不要整句照抄素材里的对话'));

console.log('=== 场景四项 ===');
t('5 时间进了提示词', src.includes('时间：傍晚'));
t('6 天气进了提示词', src.includes('天气：下雨'));
t('7 主视角在了', src.includes('主视角：本居小铃'));
t('8 在场列到了临时人物', src.includes('阿求（临时人物）'));

console.log('=== 边界 ===');
const blank = sceneBeatPlanPrompt(base({ source: { kind: 'blank', chatCharId: '', msgIds: [], excerpt: '' } }));
t('9 空白开戏不出【素材】块', !blank.includes('【素材'));
t('10 空白开戏也不留空的「时间：」行', !blank.includes('时间：'));
const dir = sceneBeatPlanPrompt(base({
  length: 'long', userMode: 'director',
  cast: [{ role: 'main', name: '小铃' }, { role: 'user', name: '你' }]
}));
t('11 导演模式的在场不列「你」', !dir.includes('在场：你'));

console.log('pass=' + pass + ' fail=' + fail);
process.exit(fail ? 1 : 0);
