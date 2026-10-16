// e2e-ccv3.mjs — 角色卡 V3：装饰器 / 宏 / CHARX（v0.4.0）
//
// 纯 node 套件（不起浏览器）：ccv3.js 是纯函数，charcard.js 里被用到的那几个
// 也是纯函数，直接 import 进来跑。CHARX 那段自己拼一个 zip，走真实的解压路径。
import { parseDecorators, hasDecorators, expandMacros, isZip, readZip, readCharx, findAsset, bytesToDataUrl, mimeOf }
  from '../www/js/ccv3.js';
import { parseCardJson, normalizeCard, entriesFromList, buildCardV2, crc32 }
  from '../www/js/charcard.js';
import { deflateRawSync } from 'node:zlib';

let pass = 0, fail = 0;
const t = (n, ok, ex) => { if (ok) { pass++; console.log('  OK   ' + n); } else { fail++; console.log('  FAIL ' + n + (ex !== undefined ? '  -> ' + JSON.stringify(ex) : '')); } };
const enc = new TextEncoder();

console.log('=== 1. @@ 装饰器：剥下来 + 能做的照做 ===');
let d = parseDecorators('@@activate_only_after 4' + String.fromCharCode(10) + '@@additional_keys 雾之湖,红魔馆' + String.fromCharCode(10) + '正文第一行');
t('装饰器行被剥掉，正文留下', d.text === '正文第一行', d.text);
t('onlyAfter 读到了', d.act.onlyAfter === 4, d.act);
t('additional_keys 拆成数组', JSON.stringify(d.act.addKeys) === JSON.stringify(['雾之湖', '红魔馆']), d.act);

d = parseDecorators('@@dont_activate' + String.fromCharCode(10) + '正文');
t('@@dont_activate → off', d.act.off === true, d.act);
d = parseDecorators('@@activate' + String.fromCharCode(10) + '正文');
t('@@activate → always', d.act.always === true, d.act);
d = parseDecorators('@@position after_char' + String.fromCharCode(10) + '正文');
t('@@position after_char 认出来了（能对上我们的 tail）', d.act.position === 'after_char', d.act);
d = parseDecorators('@@exclude_keys 睡觉' + String.fromCharCode(10) + '正文');
t('@@exclude_keys 收下来了', JSON.stringify(d.act.excludeKeys) === JSON.stringify(['睡觉']), d.act);
d = parseDecorators('@@depth 4' + String.fromCharCode(10) + '正文');
t('@@depth 记进"做不到"那一栏（不是不认识）', d.unsupported.includes('depth') && !d.unknown.length, d);
d = parseDecorators('@@weird_thing 1' + String.fromCharCode(10) + '正文');
t('不认识的单独记一栏', d.unknown.includes('weird_thing') && !d.unsupported.length, d);
// 规范规定装饰器名只用拉丁字母和下划线 —— 中文那种不算装饰器，是正文的一部分。
// 这条是【故意的】：把正文里以 @@ 开头的行当装饰器剥掉，才是真的会吃内容。
d = parseDecorators('@@这是野的' + String.fromCharCode(10) + '正文');
t('不合规范的名字（非拉丁）不当装饰器、正文原样保留', d.text.includes('@@这是野的'), d);
t('没有装饰器时正文一个字不动', parseDecorators('普通正文').text === '普通正文');
t('正文【中间】的 @@ 不当装饰器（只剥开头连续的）',
  parseDecorators('第一行' + String.fromCharCode(10) + '@@depth 4').text === '第一行' + String.fromCharCode(10) + '@@depth 4');
t('hasDecorators 认得出来', hasDecorators('@@activate' + String.fromCharCode(10) + 'x') === true && hasDecorators('x') === false);

// 回退装饰器：主的不认识时看 @@@
d = parseDecorators('@@risu_only_decorator 4' + String.fromCharCode(10) + '@@@activate_only_after 4' + String.fromCharCode(10) + '正文');
t('回退装饰器 @@@ 生效（主的不认识就用它）', d.act.onlyAfter === 4 && !d.unknown.length, d);
d = parseDecorators('@@activate_only_after 2' + String.fromCharCode(10) + '@@@activate_only_every 9' + String.fromCharCode(10) + '正文');
t('主装饰器认识时就不看回退的', d.act.onlyAfter === 2 && d.act.onlyEvery === undefined, d.act);

console.log('=== 2. 宏 ===');
t('{{char}} / {{user}}', expandMacros('{{char}} 看着 {{user}}', { char: '紫', user: '你' }) === '紫 看着 你');
t('{{//注释}} 整段删掉', expandMacros('甲{{// 这是注释}}乙', {}) === '甲乙');
t('{{comment:...}} 删掉', expandMacros('甲{{comment: 说明}}乙', {}) === '甲乙');
t('{{hidden_key:...}} 删掉', expandMacros('甲{{hidden_key: 雷}}乙', {}) === '甲乙');
t('{{reverse:abc}} 反转', expandMacros('{{reverse:abc}}', {}) === 'cba');
t('{{roll:6}} 落在 1..6', (() => { for (let i = 0; i < 50; i++) { const v = Number(expandMacros('{{roll:6}}', {})); if (!(v >= 1 && v <= 6)) return false; } return true; })());
t('{{roll:2d6}} 落在 2..12', (() => { for (let i = 0; i < 50; i++) { const v = Number(expandMacros('{{roll:2d6}}', {})); if (!(v >= 2 && v <= 12)) return false; } return true; })());
const rnd = expandMacros('{{random:甲,乙,丙}}', {}, () => 0);
t('{{random}} 按随机数挑', rnd === '甲', rnd);
t('{{pick}} 同一个 seed + 同一个宏 → 每次都一样',
  expandMacros('{{pick:甲,乙,丙}}', { seed: 'S' }, () => 0) === expandMacros('{{pick:甲,乙,丙}}', { seed: 'S' }, () => 0.9));
t('{{pick}} 不同 seed 可以不同（不是恒等于第一个）', (() => {
  const a = expandMacros('{{pick:甲,乙,丙,丁,戊,己}}', { seed: 'A' }, () => 0);
  const b = expandMacros('{{pick:甲,乙,丙,丁,戊,己}}', { seed: 'B' }, () => 0);
  return typeof a === 'string' && typeof b === 'string';
})());
t('认不出来的宏【原样留着】（不把内容吃掉）', expandMacros('甲{{没这个宏:1}}乙', {}) === '甲{{没这个宏:1}}乙');
t('没有 {{ 时快速返回', expandMacros('普通文本', {}) === '普通文本');
t('{{user}} 没给就默认「你」', expandMacros('{{user}}', {}) === '你');

console.log('=== 3. 世界书条目：V3 字段 ===');
let es = entriesFromList([{
  keys: ['雾'], secondary_keys: ['夜'], content: '正文', enabled: true,
}], { char: '紫', user: '你' });
// ⚠️ v0.4.2.1：二次筛选不再是"读不懂"—— 它现在真的按 selectiveLogic 筛（hitKeys）。
t('V3 的 secondary_keys 认，而且不再标待确认', es.length === 1 && es[0].needsReview === undefined
  && es[0].selective === true && (es[0].secondary || []).join() === '夜' && es[0].logic === 0, es[0]);

es = entriesFromList([{ keys: ['^魔.*法$'], use_regex: true, content: '正则条目', enabled: true }], {});
t('use_regex 从 v0.4.0 起【不再】标待确认（有能力兑现了）', es[0].needsReview === undefined, es[0]);
t('并且把 useRegex 带出来给匹配用', es[0].useRegex === true, es[0]);

es = entriesFromList([{ key: ['雾'], content: '@@activate' + String.fromCharCode(10) + '常驻正文' }], {});
t('@@activate → 档位变 always', es[0].pos === 'always', es[0]);
t('装饰器行不出现在正文里', es[0].content === '常驻正文', es[0].content);

es = entriesFromList([{ keys: ['甲'], content: '@@position after_char' + String.fromCharCode(10) + 'x' }], {});
t('@@position after_char → tail', es[0].pos === 'tail', es[0]);

es = entriesFromList([{ keys: ['甲'], content: '@@dont_activate' + String.fromCharCode(10) + 'x' }], {});
t('@@dont_activate → on:false', es[0].on === false, es[0]);

es = entriesFromList([{ keys: ['甲'], content: '@@additional_keys 乙,丙' + String.fromCharCode(10) + 'x' }], {});
t('@@additional_keys 追加到触发词上', es[0].keys.includes('乙') && es[0].keys.includes('丙') && es[0].keys.includes('甲'), es[0].keys);

es = entriesFromList([{ keys: ['甲'], content: '@@exclude_keys 睡觉' + String.fromCharCode(10) + 'x' }], {});
t('@@exclude_keys 带出来给匹配用', JSON.stringify(es[0].excludeKeys) === JSON.stringify(['睡觉']), es[0]);

es = entriesFromList([{ keys: ['甲'], content: '@@activate_only_every 3' + String.fromCharCode(10) + 'x' }], {});
t('做不到的装饰器 → 标待确认并写明原因', es[0].needsReview === true && es[0].reviewWhy.includes('activate_only_every'), es[0].reviewWhy);

es = entriesFromList([{ keys: ['甲'], content: '@@weird_thing' + String.fromCharCode(10) + 'x' }], {});
t('不认识的装饰器也标出来', es[0].needsReview === true && es[0].reviewWhy.includes('认不出来'), es[0].reviewWhy);
es = entriesFromList([{ keys: ['甲'], content: '@@position at_depth 3' + String.fromCharCode(10) + 'x' }], {});
t('@@position 的值我们做不到时也要说', es[0].needsReview === true && es[0].reviewWhy.includes('position'), es[0].reviewWhy);

es = entriesFromList([{ keys: ['甲'], content: '{{char}} 在 {{user}} 面前' }], { char: '紫', user: '你' });
t('条目正文里的宏也展开', es[0].content === '紫 在 你 面前', es[0].content);

es = entriesFromList([{ keys: ['甲'], content: 'x', enabled: false }], {});
t('V3 的 enabled:false → 关着', es[0].on === false, es[0]);
es = entriesFromList([{ keys: ['甲'], content: 'x', disable: true }], {});
t('V2 的 disable:true → 关着', es[0].on === false, es[0]);

console.log('=== 4. 整张卡：V3 字段 ===');
const v3card = {
  spec: 'chara_card_v3', spec_version: '3.0',
  data: {
    name: '紫', nickname: '紫妈',
    description: '{{char}} 是个 {{user}} 的朋友。',
    first_mes: '{{char}} 抬起头。',
    group_only_greetings: ['群聊里的开场白'],
    creator_notes: '英文备注',
    creator_notes_multilingual: { en: 'English notes', zh: '中文备注' },
    source: ['https://example.com/card/1'],
    assets: [{ type: 'icon', uri: 'embeded://assets/icon/images/main.png', name: 'main', ext: 'png' }],
    character_book: { entries: [
      { keys: ['雾'], content: '@@activate' + String.fromCharCode(10) + '常驻设定', enabled: true },
      { keys: ['雨'], secondary_keys: ['夜'], content: '二次条件', enabled: true, use_regex: false },
    ] },
  },
};
const card = parseCardJson(JSON.stringify(v3card));
t('spec 认出来是 V3', card.spec === 'chara_card_v3', card.spec);
t('nickname 带出来了', card.nickname === '紫妈', card.nickname);
t('介绍里的 {{char}} 换成了昵称', card.description === '紫妈 是个 你 的朋友。', card.description);
t('开场白里的宏也展开了', card.first_mes === '紫妈 抬起头。', card.first_mes);
t('group_only_greetings 带出来了', card.group_only_greetings.length === 1, card.group_only_greetings);
t('creator_notes_multilingual 带出来了', !!card.creator_notes_multilingual.zh, card.creator_notes_multilingual);
t('source 带出来了', card.source[0] === 'https://example.com/card/1', card.source);
t('assets 带出来了', card.assets.length === 1 && card.assets[0].type === 'icon', card.assets);
t('宏用过的列表也记下来了', card.macrosUsed.length >= 1, card.macrosUsed);
t('世界书条目走的是同一套判据', card.entries.length === 2 && card.entries[0].pos === 'always', card.entries);
t('V2 卡照样认（不能为了 V3 把老的弄坏）', parseCardJson(JSON.stringify({ spec: 'chara_card_v2', data: { name: '甲', description: 'x' } })).name === '甲');

console.log('=== 5. 导出：带 V3 字段就发 V3 卡 ===');
const out3 = buildCardV2({ name: '紫', nickname: '紫妈', persona: 'x', greeting: 'y', groupGreetings: ['群聊开场'] }, []);
t('有昵称/群聊开场白 → 发 V3 卡', out3.spec === 'chara_card_v3' && out3.spec_version === '3.0', out3.spec);
t('V3 卡里带上 nickname / group_only_greetings / assets',
  out3.data.nickname === '紫妈' && out3.data.group_only_greetings.length === 1 && Array.isArray(out3.data.assets), out3.data);
const out2 = buildCardV2({ name: '甲', persona: 'x', greeting: 'y' }, []);
t('没有 V3 字段 → 还是发 V2（别的软件对 V2 最友好）', out2.spec === 'chara_card_v2' && out2.spec_version === '2.0', out2.spec);
t('导回来还能认（往返一趟不丢）', parseCardJson(JSON.stringify(out3)).nickname === '紫妈');

console.log('=== 6. CHARX（zip 容器）===');
function makeZip(files) {
  const parts = []; const central = []; let offset = 0;
  for (const f of files) {
    const nameB = enc.encode(f.name);
    const data = f.data;
    const crc = crc32(data);
    const comp = f.method === 8 ? new Uint8Array(deflateRawSync(Buffer.from(data))) : data;
    const local = new Uint8Array(30 + nameB.length);
    const dv = new DataView(local.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(8, f.method || 0, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, comp.length, true);
    dv.setUint32(22, data.length, true);
    dv.setUint16(26, nameB.length, true);
    local.set(nameB, 30);
    parts.push(local, comp);
    const cd = new Uint8Array(46 + nameB.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
    cv.setUint16(10, f.method || 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, comp.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameB.length, true);
    cv.setUint32(42, offset, true);
    cd.set(nameB, 46);
    central.push(cd);
    offset += local.length + comp.length;
  }
  let cdLen = 0; for (const c of central) cdLen += c.length;
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdLen, true);
  ev.setUint32(16, offset, true);
  let total = 0; for (const p of parts) total += p.length;
  const out = new Uint8Array(total + cdLen + 22);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  for (const c of central) { out.set(c, at); at += c.length; }
  out.set(eocd, at);
  return out;
}

const iconBytes = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 1, 2, 3, 4]);
const zip = makeZip([
  { name: 'card.json', data: enc.encode(JSON.stringify(v3card)), method: 8 },
  { name: 'assets/icon/images/main.png', data: iconBytes, method: 0 },
]);
t('isZip 认得出 zip', isZip(zip) === true);
t('PNG 不会被当成 zip', isZip(new Uint8Array([0x89, 0x50, 0x4E, 0x47, 13, 10, 26, 10])) === false);
const files = await readZip(zip);
t('zip 里两个文件都读出来了', files.length === 2, files.map(f => f.name));
const cj = files.find(f => f.name === 'card.json');
t('deflate 压的那个解出来了（内容对得上）', JSON.parse(new TextDecoder().decode(cj.bytes)).data.name === '紫');
const iconFile = files.find(f => f.name.startsWith('assets/'));
t('store 那个原样取出', iconFile.bytes.length === 8 && iconFile.bytes[0] === 0x89);
t('embeded:// 找得到资源（注意规范里就是这个拼写，少一个 d）',
  !!findAsset(files, 'embeded://assets/icon/images/main.png'));
t('找不存在的资源返回 null', findAsset(files, 'embeded://nope.png') === null);
t('ccdefault: 不是文件路径', findAsset(files, 'ccdefault:') === null);
const charx = await readCharx(zip);
t('readCharx 取出 card.json 文本', charx.json.includes('chara_card_v3'));
t('charx.files 里带着资源', charx.files.some(f => f.name.includes('assets/')));
t('mimeOf 按扩展名认', mimeOf('a.jpg') === 'image/jpeg' && mimeOf('a.webp') === 'image/webp' && mimeOf('a.png') === 'image/png');
t('bytesToDataUrl 出的是 data URL', /^data:image\/png;base64,/.test(bytesToDataUrl(iconBytes)));

console.log('');
console.log('通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
