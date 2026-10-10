import { buildStablePrompt, buildTurnNote } from '../www/js/persona.js';
let pass=0, fail=0;
const t=(n,ok,ex='')=>{if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));}};
const char = { persona: '你是紫。', descLevel:'mid', verbosity:'medium' };
const s = { myProfile:'', myEnv:'', kaomojiFreq:0.15, kaomojiStyle:'jp-soft', emojiFreq:0.1,
            splitMessages:false, hesitation:true, povLock:false, longMemory:false, worldbookOn:true };
const clock = '第 1 天 早上';

console.log('=== 1. 命中时注入 ===');
const hits = [{ title:'红魔馆', content:'红魔馆是蕾米莉亚的宅邸。' }];
const note = buildTurnNote(char, s, { memories:[], useKaomoji:false, worldbook:hits, clock });
console.log('   ' + note.slice(0,120).replace(/\n/g,' | '));
t('含「相关设定」段', note.includes('# 相关设定'));
t('含标题', note.includes('红魔馆'));
t('含内容', note.includes('蕾米莉亚的宅邸'));

console.log('=== 2. 没命中就不注入（不浪费 token）===');
const note2 = buildTurnNote(char, s, { memories:[], useKaomoji:false, worldbook:[], clock });
t('没有相关设定段', !note2.includes('# 相关设定'));

console.log('=== 3. 绝不进稳定前缀（否则缓存全废）===');
const stable = buildStablePrompt(char, s);
t('稳定前缀里没有世界书', !stable.includes('相关设定') && !stable.includes('蕾米莉亚'));

console.log('=== 4. 稳定前缀本身不受世界书开关影响（缓存一致性）===');
const stableOn = buildStablePrompt(char, { ...s, worldbookOn: true });
const stableOff = buildStablePrompt(char, { ...s, worldbookOn: false });
t('开关不影响稳定前缀（换开关不会打掉缓存）', stableOn === stableOff);

console.log('=== 5. 多条命中按顺序拼 ===');
const note3 = buildTurnNote(char, s, { memories:[], useKaomoji:false, clock, worldbook:[
  { title:'红魔馆', content:'AAA' }, { title:'符卡', content:'BBB' }]});
t('两条都在', note3.includes('AAA') && note3.includes('BBB'));
t('顺序正确（红魔馆在前）', note3.indexOf('AAA') < note3.indexOf('BBB'));

console.log('\n结果: pass='+pass+' fail='+fail);
process.exit(fail?1:0);
