// 角色卡（charcard.js）纯函数测试 —— 不需要 Chrome，不起 http server。
//
// 为什么单独一套：这张卡的核心是二进制打包（PNG chunk + CRC32）和编码往返，
// 这些出错时【界面上完全看不出来】—— 导出的 PNG 照样能打开、能看，
// 只是别的软件读不出角色数据。必须逐字节验。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readCode } from './e2e-src.mjs';

const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');

// ⚠️ www/js/charcard.js 是 ESM 源码但扩展名是 .js，而 package.json 没有 "type":"module"，
//    node 会按 CJS 解析它然后报 "Cannot use import statement"。复制成 .mjs 再 import。
//
// ⚠️ v0.4.0：charcard.js 现在会 import 兄弟文件（ccv3.js），复制时必须【连它一起复制】，
//    否则 _archive 里那份会去 import 一个不存在的 ./ccv3.js，整套直接 ERR_MODULE_NOT_FOUND。
//    这里做成"顺着 import 找兄弟、逐个复制并改写后缀"，以后再加依赖不用再改这段。
//    注意：这里用【原样读】，不能用 readCode —— 抄过去是要【执行】的，剥了注释等于改了源码。
const tmp = R + '/_archive/_charcard_undertest.mjs';
fs.mkdirSync(R + '/_archive', { recursive: true });
const srcDir = R + '/www/js';
let ccSrc = fs.readFileSync(srcDir + '/charcard.js', 'utf8');
const siblings = [...ccSrc.matchAll(/from '\.\/([A-Za-z0-9_]+)\.js'/g)].map(m => m[1]);
for (const sib of siblings) {
  const to = R + '/_archive/_' + sib + '_undertest.mjs';
  fs.writeFileSync(to, fs.readFileSync(srcDir + '/' + sib + '.js', 'utf8'), 'utf8');
  ccSrc = ccSrc.split("from './" + sib + ".js'").join("from './_" + sib + "_undertest.mjs'");
}
fs.writeFileSync(tmp, ccSrc, 'utf8');
const CC = await import(pathToFileURL(tmp).href);

let pass = 0, fail = 0;
function t(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail !== undefined ? '   → ' + detail : '')); }
}

// ---------- 1. CRC32 ----------
console.log('CRC32');
// PNG 规范里 IEND（长度 0、无数据）的 CRC 恒为 AE426082，是个标准对照值
t('crc32("IEND") === 0xAE426082', CC.crc32(new TextEncoder().encode('IEND')) === 0xAE426082,
  '0x' + CC.crc32(new TextEncoder().encode('IEND')).toString(16));
t('空输入的 crc32 === 0', CC.crc32(new Uint8Array(0)) === 0);

// ---------- 2. base64 / UTF-8 往返 ----------
console.log('编码往返');
for (const s of ['hello', '你好，世界', '幽幽子🌸西行寺', 'a\nb\t"c"\\d', '']) {
  t('往返 ' + JSON.stringify(s.slice(0, 12)), CC.decodeB64Utf8(CC.encodeB64Utf8(s)) === s);
}
// 裸 btoa 遇到中文会直接抛 InvalidCharacterError —— 这就是 encodeB64Utf8 存在的理由
let rawThrew = false;
try { btoa('你好'); } catch (e) { rawThrew = true; }
t('裸 btoa 确实处理不了中文', rawThrew);

// ---------- 3. JSON 卡解析 ----------
console.log('JSON 卡解析');
const v2 = {
  spec: 'chara_card_v2', spec_version: '2.0',
  data: {
    name: '测试丁', description: '测试用的角色描述', first_mes: '呀，你来啦。',
    alternate_greetings: ['第二句开场', '第三句'],
    tags: ['东方'],
    character_book: { entries: [
      { keys: ['约定', '樱花'], content: '她和谁有个约定', enabled: true },
      { keys: ['老家'], content: '她住在老家', enabled: false },
      { keys: [], content: '没有触发词，v0.3.1 起保留待确认' },
      { keys: ['空'], content: '', enabled: true },
    ] },
  },
};
const c2 = CC.parseCardJson(JSON.stringify(v2));
t('V2 name', c2.name === '测试丁', c2.name);
t('V2 description（→ persona）', c2.description === '测试用的角色描述');
t('V2 first_mes（→ greeting）', c2.first_mes === '呀，你来啦。');
t('V2 备选开场白被保留待调用方提示', c2.alternate_greetings.length === 2);
// ⚠️ 断言更新（v0.3.1）：空 content 的仍然丢掉（没内容可注入），
//    但【没有触发词的】不再静默丢弃 —— 标 needsReview 落库，世界书页会给「待确认」。
//    理由是静默丢弃和静默错设定一样糟：用户看不到任何提示（同 fromSillyTavern 的判据）。
t('V2 世界书：空 content 丢掉、没有触发词的保留 → 3 条', c2.entries.length === 3, c2.entries.length);
t('那条没有触发词的被标了待确认', c2.entries.some(e => e.needsReview === true && /没有触发词/.test(e.reviewWhy || '')));
t('只有它一条待确认', c2.entries.filter(e => e.needsReview === true).length === 1);
t('V2 条目 on 跟随 enabled', c2.entries[0].on === true && c2.entries[1].on === false);
t('V2 keys 数组原样', JSON.stringify(c2.entries[0].keys) === JSON.stringify(['约定', '樱花']));

// V1：字段平铺，没有 data 外壳
const v1 = { name: '测试戊', description: '测试用的角色描述', first_mes: '你好呀', character_book: { entries: [{ keys: ['手艺'], content: '她会做手工艺品' }] } };
const c1 = CC.parseCardJson(JSON.stringify(v1));
t('V1 name', c1.name === '测试戊');
t('V1 世界书', c1.entries.length === 1 && c1.entries[0].keys[0] === '手艺');
t('V1 条目默认 on（enabled 缺省视为开）', c1.entries[0].on === true);

// V1 旧字段名 key（单数）
const ck = CC.parseCardJson(JSON.stringify({ name: 'X', character_book: { entries: [{ key: '单独触发词', content: '正文' }] } }));
t('V1 兼容 key 单数字段', ck.entries.length === 1 && ck.entries[0].keys[0] === '单独触发词');

// ⚠️ 补的（v0.3.1 复查）：酒馆世界书里 key 本来就是 string[]，
//    旧卡写成数组很常见。原来只认字符串 → keys=[] → 被误标「没有触发词」，
//    而同一个文件从【世界书导入】进来却能解析出来（fromSillyTavern 认数组）。
//    这条钉的正是"两个入口同一套判据"。
{
  const ca = CC.parseCardJson(JSON.stringify({ name: 'Y', character_book: { entries: [
    { key: ['甲', '乙'], content: '正文' },
  ] } }));
  t('V1 的 key 是数组时也要解析出来（不是当成没有触发词）',
    ca.entries.length === 1 && JSON.stringify(ca.entries[0].keys) === JSON.stringify(['甲', '乙'])
    && ca.entries[0].needsReview !== true,
    JSON.stringify(ca.entries[0]));
}

// 错误分支
let threw = '';
try { CC.parseCardJson('{ not json'); } catch (e) { threw = e.message; }
t('坏 JSON 抛人话错误', /不是合法的 JSON/.test(threw), threw);
threw = '';
try { CC.parseCardJson(JSON.stringify({ description: '没有名字' })); } catch (e) { threw = e.message; }
t('缺 name 抛错', /没有 name/.test(threw), threw);

// ---------- 4. PNG 往返 ----------
console.log('PNG');
// 标准 1x1 透明 PNG（业界通用的最小样本）
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const pngBytes = Uint8Array.from(atob(PNG_1PX), ch => ch.charCodeAt(0));
t('识别 PNG 签名', CC.isPng(pngBytes) === true);
t('拒绝非 PNG', CC.isPng(new TextEncoder().encode('{"name":"x"}')) === false);

const card = { spec: 'chara_card_v2', data: { name: '帕秋莉', description: '魔女', first_mes: '别吵', character_book: { entries: [{ keys: ['魔法'], content: '她读魔导书' }] } } };
const out = CC.insertTextChunk(pngBytes, 'chara', CC.encodeB64Utf8(JSON.stringify(card)));

t('插入后仍是 PNG', CC.isPng(out));
t('插入后变长', out.length > pngBytes.length, out.length + ' > ' + pngBytes.length);
t('IEND 还在末尾', String.fromCharCode(...out.subarray(out.length - 8, out.length - 4)) === 'IEND');

const back = CC.extractCardFromPng(out);
t('读回 name', back.name === '帕秋莉', back.name);
t('读回 description', back.description === '魔女');
t('读回世界书', back.entries.length === 1 && back.entries[0].content === '她读魔导书');

// 逐字节验 tEXt 的 CRC —— 上面那条路不校验 CRC，写错了也照样读得回来，
// 但别的软件（SillyTavern）会直接判定文件损坏。
{
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  let off = 8, checked = false, okCrc = false, okType = false;
  while (off + 8 <= out.length) {
    const len = dv.getUint32(off);
    const type = String.fromCharCode(...out.subarray(off + 4, off + 8));
    if (type === 'tEXt') {
      okType = true;
      const want = dv.getUint32(off + 8 + len);
      const got = CC.crc32(out.subarray(off + 4, off + 8 + len));
      okCrc = (want === got);
      checked = true;
      break;
    }
    off = off + 8 + len + 4;
  }
  t('找到 tEXt chunk', okType);
  t('tEXt 的 CRC 自洽', checked && okCrc);
}

// 原图没被改动
t('原字节数组未被就地修改（tEXt 之前的内容一致）',
  Buffer.from(out.subarray(0, 33)).equals(Buffer.from(pngBytes.subarray(0, 33))));

// 没有 chara 的 PNG
threw = '';
try { CC.extractCardFromPng(pngBytes); } catch (e) { threw = e.message; }
t('纯底图 PNG 抛「没有角色数据」', /没有角色数据/.test(threw), threw);

// 非 ASCII 正文必须被拦下（tEXt 只允许 Latin1，静默截断会让卡片悄悄坏掉）
threw = '';
try { CC.insertTextChunk(pngBytes, 'chara', '中文不行'); } catch (e) { threw = e.message; }
t('非 ASCII 正文被拒绝', /只能存 ASCII/.test(threw), threw);

// ---------- 5. 导出打包 ----------
console.log('导出打包');
const built = CC.buildCardV2({ name: 'uuz', persona: '西行寺', greeting: '你好' }, [{ keys: ['a'], content: 'b', on: true }]);
t('spec 字段', built.spec === 'chara_card_v2' && built.spec_version === '2.0');
t('name/description/first_mes 映射', built.data.name === 'uuz' && built.data.description === '西行寺' && built.data.first_mes === '你好');
t('世界书带上了', built.data.character_book.entries.length === 1);
t('条目 enabled 跟随 on', built.data.character_book.entries[0].enabled === true);
const noBook = CC.buildCardV2({ name: 'x', persona: '', greeting: '' }, []);
t('没世界书时不写 character_book 字段', noBook.data.character_book === undefined);
t('导出再导入是同一个角色', CC.parseCardJson(JSON.stringify(built)).name === 'uuz');

// ---------- 5b. 「一直生效」那一档（v1.21.51）----------
// 起因：那一档【没有触发词】，而老判据是「没 keys 就滤掉」——
// 导出卡片时那几条常驻设定会无声无息地消失，导回来当然也没有。
console.log('常驻条目往返');
const withAlways = CC.buildCardV2({ name: 'z', persona: 'p', greeting: 'g' }, [
  { id: 'a1', title: '世界观', keys: [], content: '永远黄昏', on: true, pos: 'always' },
  { id: 'a2', title: '红魔馆', keys: ['红魔馆'], content: '宅邸', on: true, pos: 'tail' },
]);
const bk = withAlways.data.character_book;
t('没触发词的常驻条目也导出了', !!bk && bk.entries.length === 2, bk && bk.entries.length);
const alwaysE = bk && bk.entries.find(e => e.content === '永远黄昏');
t('它的 keys 是空数组（不是崩溃）', !!alwaysE && Array.isArray(alwaysE.keys) && alwaysE.keys.length === 0);
t('档位写进了 extensions', !!alwaysE && alwaysE.extensions.mengxianju.pos === 'always', alwaysE && JSON.stringify(alwaysE.extensions));
t('标题也带上了', !!alwaysE && alwaysE.extensions.mengxianju.title === '世界观');
const backCard = CC.parseCardJson(JSON.stringify(withAlways));
t('导回来仍然两条', backCard.entries.length === 2, backCard.entries.length);
t('常驻档还原（keys 仍为空）', backCard.entries.some(e => e.pos === 'always' && e.content === '永远黄昏' && e.keys.length === 0),
  JSON.stringify(backCard.entries.map(e => ({ p: e.pos, k: e.keys.length }))));
t('临场档还原', backCard.entries.some(e => e.pos === 'tail' && e.content === '宅邸'));
t('标题还原', backCard.entries.some(e => e.title === '世界观'), JSON.stringify(backCard.entries.map(e => e.title)));
// ST 的 constant: true 也是「一直生效」的意思，不认它等于把别人的常驻设定丢了
const stCard = CC.parseCardJson(JSON.stringify({ name: 's', character_book: { entries: [
  { comment: 'ST 常驻', keys: [], content: 'ST 的常驻内容', constant: true },
] } }));
t('ST 的 constant:true 映射成「一直生效」', stCard.entries.length === 1 && stCard.entries[0].pos === 'always',
  JSON.stringify(stCard.entries));
t('ST 的 comment 当成标题', stCard.entries[0] && stCard.entries[0].title === 'ST 常驻');

// ---------- 5c. 角色设置「全同步」+ 外来卡的类型校验（v1.21.53）----------
console.log('角色设置全同步 / 外来卡的校验');
const full = CC.buildCardV2({
  name: 'z', persona: 'p', greeting: 'g',
  appearance: '基线：白裙', appearanceLive: '此刻：红裙', scene: '祭典',
  temperature: 0.8, contextRounds: 40, kaomojiFreq: 0.3, splitMessages: true,
  avatar: 'data:image/png;base64,AAAA',
}, []);
const fp = full.data.extensions.mengxianju.params;
t('「立即生效」那一层进卡（她此刻的样子）', fp.appearanceLive === '此刻：红裙');
t('临时场景进卡（是角色的情境，不是我的设置）', fp.scene === '祭典');
t('头像挂在 extensions.mengxianju.avatar（不混进 params）',
  full.data.extensions.mengxianju.avatar === 'data:image/png;base64,AAAA' && fp.avatar === undefined);
const fback = CC.readMkParams(CC.parseCardJson(JSON.stringify(full)));
t('读回来：基线 / 此刻 / 场景 三样都在',
  fback.appearance === '基线：白裙' && fback.appearanceLive === '此刻：红裙' && fback.scene === '祭典');
t('读回来：头像也回来了', fback.avatar === 'data:image/png;base64,AAAA');
t('读回来：数字与布尔原样', fback.temperature === 0.8 && fback.contextRounds === 40 && fback.splitMessages === true);

// 卡是外面来的：离谱的值不能原样进角色
const bad = CC.readMkParams({ extensions: { mengxianju: { params: {
  contextRounds: 999999, temperature: 99, kaomojiFreq: 'abc', maxTokens: -5,
  splitMessages: 'yes', verbosity: 12345, scene: 'x'.repeat(9000),
} } } });
t('离谱的 contextRounds 被夹到上限', bad.contextRounds === 2000, String(bad.contextRounds));
t('离谱的 temperature 被夹到上限', bad.temperature === 2, String(bad.temperature));
t('负数 maxTokens 被夹到下限', bad.maxTokens === 1, String(bad.maxTokens));
t('不是数字的 kaomojiFreq 被丢掉', bad.kaomojiFreq === undefined, String(bad.kaomojiFreq));
t('不是字符串的 verbosity 被丢掉', bad.verbosity === undefined, String(bad.verbosity));
t('布尔字段被强制成布尔', bad.splitMessages === true);
t('超长文本被截断', typeof bad.scene === 'string' && bad.scene.length === 8000, String(bad.scene && bad.scene.length));
t('不是 data:image 的 avatar 不采纳',
  CC.readMkParams({ extensions: { mengxianju: { avatar: 'https://evil/x.png' } } }).avatar === undefined);

fs.rmSync(tmp, { force: true });
console.log('');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
