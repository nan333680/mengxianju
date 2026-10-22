import { parseDecorators, expandMacros, isZip, readCharx, findAsset, bytesToDataUrl, mimeOf } from './ccv3.js';

/**
 * 角色卡（Character Card V2 / V3）导入 / 导出 —— v1.21.40
 *
 * 这是个【实验性】功能，刻意做成独立文件：
 *   · 不动 app.js 的现有逻辑，只由它 import 三个入口函数；
 *   · 全部是纯函数（解析 / 打包），只有 makeCardPng 碰 Canvas；
 *   · 解析失败一律 throw 带人话的 Error，由调用方 toast，不静默吞。
 *
 * 为什么要手写 PNG chunk 而不用库：
 *   package.json 里没有打包器，www/ 是原样同步进 APK 的静态目录 ——
 *   WebView 里没有 node_modules，裸模块名 import 会让整个 app 挂掉
 *   （app.js 第 6-9 行专门写了这条教训）。所以 PNG 和 CRC32 只能自己写。
 *
 * 规范：
 *   V2: github.com/malfoyslastname/character-card-spec-v2
 *     { spec:'chara_card_v2', spec_version:'2.0', data:{...} }
 *   V3: github.com/kwaroran/character-card-spec-v3 （v0.4.0 起支持）
 *     { spec:'chara_card_v3', spec_version:'3.0', data:{...} }
 *     V3 多出来的：assets / group_only_greetings / nickname /
 *     creator_notes_multilingual / source / 世界书条目里的 use_regex 和 @@ 装饰器。
 *   V1 卡（老卡）就是字段平铺，没有 data 外壳 —— 三种都要认。
 *
 *   PNG 卡：把卡片 JSON 以 base64 塞进 tEXt chunk。
 *     keyword 有两个：老的是 "chara"，V3 加的是 "ccv3"。
 *     ⚠️ 一张 V3 卡【两个块都可能带】，而且规范没说谁在前 ——
 *       原来这里是"谁先出现返回谁"，于是先读到兼容用的 V2 那份就少一堆东西。
 *       现在整张图扫完，ccv3 优先、chara 兜底。
 */

// ============================================================
//  Base64 / UTF-8
// ============================================================

/**
 * UTF-8 字符串 → base64。
 *
 * ⚠️ 不能直接 btoa(str)：它只认 Latin1，中文会直接抛 InvalidCharacterError。
 * 先经 TextEncoder 变成字节，再逐字节喂给 btoa。
 * 分块拼接是因为 String.fromCharCode.apply 在大数组上会爆栈。
 */
export function encodeB64Utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(bin);
}

/** base64 → UTF-8 字符串（encodeB64Utf8 的逆） */
export function decodeB64Utf8(b64) {
  const bin = atob(String(b64).replace(/\s+/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

// ============================================================
//  CRC32（PNG 每个 chunk 末尾都要）
// ============================================================

let _crcTable = null;

function crcTable() {
  if (_crcTable) return _crcTable;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  _crcTable = t;
  return t;
}

/** 标准 PNG CRC-32（多项式 0xEDB88320，初值/终值取反） */
export function crc32(bytes) {
  const t = crcTable();
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ============================================================
//  JSON 卡解析
// ============================================================

/**
 * 解析卡片对象（V1 或 V2）成统一形状。
 * @param {any} raw 已经 JSON.parse 过的对象
 */
export function normalizeCard(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('卡片不是一个对象');
  // ⚠️ 老 TavernAI / Pygmalion 的 JSON（v0.4.2.1 补）。
  //    那一代卡不叫 name/description，叫 char_name / char_persona / world_scenario /
  //    example_dialogue / char_greeting —— 字段名全不一样，于是这里会直接报
  //    「卡片里没有 name 字段」，用户看到的是"这个文件不是角色卡"。
  //    而这些卡在网上还大量存在（Pygmalion 时代的遗产），且信息量一点不少。
  //    判据：没有 name、没有 data、但有 char_name —— 三个条件同时成立才走这条映射，
  //    免得把别的形状误认成老卡。
  if (!raw.name && !(raw.data && typeof raw.data === 'object') && (raw.char_name || raw.char_persona)) {
    raw = {
      name: String(raw.char_name || '').trim(),
      description: String(raw.char_persona || raw.persona || ''),
      personality: String(raw.personality || ''),
      scenario: String(raw.world_scenario || raw.scenario || ''),
      first_mes: String(raw.char_greeting || raw.first_mes || ''),
      mes_example: String(raw.example_dialogue || raw.mes_example || ''),
      creator_notes: String(raw.creatorcomment || raw.creator_notes || ''),
      tags: Array.isArray(raw.tags) ? raw.tags : [],
    };
  }
  // V2 把真正的字段放在 data 里；V1 平铺。
  // 判据用 data 是否存在且是对象 —— 不能靠 spec 字段，实测有卡只写了 data 没写 spec。
  const d = (raw.data && typeof raw.data === 'object') ? raw.data : raw;
  const name = String(d.name || '').trim();
  if (!name) throw new Error('卡片里没有 name 字段');
  // V3 的 nickname：{{char}} 该被换成它，而不是 name（规范明确这么写）。
  // 我们把它当"显示/替换用的名字"，真名仍是 name。
  const nickname = String(d.nickname || '').trim();
  // ⚠️ 宏要在【导入时】就展开（v0.4.0）。
  //    起因：卡里的开场白写着 "{{char}} 抬起头"、人设里写着 "{{user}} 是 {{char}} 的…"，
  //    而全 www 树原来一处都不处理 —— 导进来的角色张口就是字面的 "{{char}}"，
  //    用户看到的是满屏大括号。这是 V2 时代就有的坑，不是 V3 才有的。
  //    {{user}} 本软件没有"我的名字"这个设置项，统一换成「你」（说清楚，不假装有）。
  const mctx = { char: nickname || name, user: '你', seed: name };
  const mac = (v) => expandMacros(String(v == null ? '' : v), mctx);
  const macrosUsed = [];
  const macCount = (v) => { const m = String(v == null ? '' : v).match(/\{\{[^}]*\}\}/g); if (m) macrosUsed.push(...m); };
  for (const k of ['description', 'personality', 'scenario', 'first_mes', 'mes_example',
    'system_prompt', 'post_history_instructions', 'creator_notes']) macCount(d[k]);
  if (Array.isArray(d.alternate_greetings)) d.alternate_greetings.forEach(macCount);
  return {
    spec: String(raw.spec || (raw.data ? 'chara_card_v2' : 'v1')),
    specVersion: String(d.spec_version || raw.spec_version || ''),
    name,
    nickname,
    description: mac(d.description),
    personality: mac(d.personality),
    scenario: mac(d.scenario),
    first_mes: mac(d.first_mes),
    mes_example: mac(d.mes_example),
    creator_notes: mac(d.creator_notes),
    system_prompt: mac(d.system_prompt),
    post_history_instructions: mac(d.post_history_instructions),
    alternate_greetings: Array.isArray(d.alternate_greetings) ? d.alternate_greetings.map(v => mac(v)) : [],
    tags: Array.isArray(d.tags) ? d.tags.map(String) : [],
    // —— 下面这几个是 V3 才有的，全都【原样带出来】，由 app.js 决定怎么用 ——
    group_only_greetings: Array.isArray(d.group_only_greetings) ? d.group_only_greetings.map(String) : [],
    creator_notes_multilingual: (d.creator_notes_multilingual && typeof d.creator_notes_multilingual === 'object')
      ? d.creator_notes_multilingual : {},
    source: Array.isArray(d.source) ? d.source.map(String) : (d.source ? [String(d.source)] : []),
    assets: Array.isArray(d.assets) ? d.assets.filter(a => a && typeof a === 'object') : [],
    creation_date: Number.isFinite(Number(d.creation_date)) ? Number(d.creation_date) : null,
    macrosUsed: [...new Set(macrosUsed)],
    entries: extractEntries(d.character_book, mctx),
    // ⚠️ v1.21.47：extensions 必须带出来。
    // 我们自己导出的卡把角色级参数（表达方式 / 外貌 / 「他的设定」/ 临时场景）
    // 挂在 extensions.mengxianju 上，而这里原来是【直接丢掉】的 ——
    // 于是 readMkParams 永远读到 undefined，导入时静默把参数全丢了。
    extensions: (d.extensions && typeof d.extensions === 'object') ? d.extensions : {},
  };
}

/**
 * 解析【外来】JSON 文本（v0.4.2.1）。
 *
 * ⚠️ 为什么不直接用 JSON.parse：卡片 / 世界书 / 备份都是【外面来的文件】。
 *    JSON.parse 会把 "__proto__" 当成一个普通键【原样建出来】，而下游到处都是
 *    Object.assign({}, x) / obj[key] 这种写法 —— 一旦源对象带着 __proto__，
 *    合并出来的对象原型就被换掉了，之后 obj['随便什么'] 可能命中原型链上的值。
 *    这不是理论问题：ST 的 entries 是 {"0":…,"1":…} 这种**以键为数据**的形态，
 *    世界书的条目映射也是，都属于"外来键名"直接进对象的高风险面。
 *    这条路径上没有任何合法数据需要 __proto__ / constructor / prototype 当键名，
 *    所以一律在 reviver 里丢掉它们，而不是等到出事再补。
 */
export function parseJsonSafe(text) {
  return JSON.parse(String(text), (k, v) =>
    (k === '__proto__' || k === 'constructor' || k === 'prototype') ? undefined : v);
}

/** 从 JSON 文本解析卡片 */
export function parseCardJson(text) {
  let raw;
  try { raw = parseJsonSafe(text); }
  catch (e) { throw new Error('不是合法的 JSON：' + ((e && e.message) || e)); }
  return normalizeCard(raw);
}

/**
 * character_book.entries → 本项目世界书条目的形状 { title, keys, content, on, pos }。
 *
 * v0.4.0 起按 V3 规范多认这些东西：
 *   · content 开头的 @@ 装饰器 —— 【剥掉】再当正文（规范：回填成 V2 时要去掉），
 *     能照做的照做（activate / dont_activate / additional_keys / exclude_keys /
 *     position），做不到的如实记在 decoNote 里
 *   · secondary_keys（V3）—— V2 叫 keysecondary，两边都认
 *   · enabled（V3）/ disable（V2，取反）
 *   · priority / insertion_order —— 只用于排序，不构成"读不懂"
 *   · 正文里的宏（{{char}} / {{user}} / {{random}} …）
 */
function extractEntries(book, mctx) {
  if (!book) return [];
  // ⚠️ v0.4.2.1：entries 除了数组，还可能是【映射】（{"0":{…},"1":{…}}）。
  //    酒馆世界书的默认导出形态就是这个，而在角色卡的 character_book 里也大量存在
  //    （规范写的是数组，但现实里两种都有）。原来这里只认数组 ——
  //    于是这类卡的世界书【整块静默消失】：卡导进来了，设定一条没有，也不报错。
  const list = Array.isArray(book.entries) ? book.entries
    : (book.entries && typeof book.entries === 'object'
        // Object.keys 而不是 for..in：后者会把原型链上的键也带进来
        ? Object.keys(book.entries).map(k => book.entries[k]) : null);
  if (!list) return [];
  const out = [];
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    // 装饰器写在 content 最前面。先剥下来，剩下的才是正文。
    const dc = parseDecorators(e.content);
    let content = String(dc.text || '').trim();
    if (mctx) content = expandMacros(content, mctx);
    if (!content) continue;                                  // 空条目没意义，别塞进去占位
    // 限长（v1.21.53）：卡是外面来的东西，一条塞几 MB 会撑爆提示词和存储
    if (content.length > 20000) content = content.slice(0, 20000);
    // V2 用 keys，V1 的旧字段叫 key（单数）或 keywords，都认
    let keys = [];
    // KoboldAI 的 key / keysecondary 是【逗号分隔的字符串】，不是数组
    //（见 docs/research-外部导入格式.md §7）。整串当一个触发词的话永远也匹配不上，
    // 而这类文件导进来只会静默变成一条条永不触发的条目。
    const splitK = (v) => {
      const raw = String(v == null ? '' : v).trim();
      if (!raw) return [];
      return raw.includes(',') ? raw.split(',').map(x => x.trim()).filter(Boolean) : [raw];
    };
    if (Array.isArray(e.keys)) keys = e.keys;
    else if (typeof e.keys === 'string') keys = splitK(e.keys);
    else if (Array.isArray(e.keywords)) keys = e.keywords;
    else if (typeof e.keywords === 'string') keys = splitK(e.keywords);
    // ⚠️ key 也要认数组（v0.3.1 复查）：酒馆世界书的 key 本来就是 string[]，
    //    旧卡里写成 ["甲","乙"] 很常见。原来只认字符串，于是这类条目 keys=[]
    //    → 被标成「没有触发词」的待确认。不会静默生效（闸门挡住了），
    //    但同一个文件从【世界书导入】进来能解析出触发词、从【角色卡】进来却不能，
    //    而上面那段注释刚承诺"两个入口同一套判据"。
    else if (Array.isArray(e.key)) keys = e.key;
    else if (typeof e.key === 'string') keys = splitK(e.key);
    keys = keys.map(k => String(k || '').trim().slice(0, 64)).filter(Boolean).slice(0, 64);
    // 装饰器里的 @@additional_keys：规范说它【追加】到 keys 上
    if (dc.act.addKeys && dc.act.addKeys.length) {
      const more = dc.act.addKeys.map(k => String(k).trim().slice(0, 64)).filter(Boolean);
      keys = [...new Set(keys.concat(more))].slice(0, 64);
    }
    // 标题：先认 SillyTavern 的 comment / name，再认我们自己导出的那份（v1.21.51）
    const mk = (e.extensions && e.extensions.mengxianju) || {};
    // 档位：优先我们自己导出的那一层（extensions.mengxianju.pos），
    // 但也认条目上直接写的 pos —— 手写的世界书文件/数组形态常常就是平铺的。
    const mkPos = mk.pos || e.pos || '';
    const title = String(e.comment || e.name || mk.title || e.title || '').trim();
    // 「一直生效」不需要触发词。三个来源：我们自己导出的档位、ST 的 constant: true、
    // V3 的 @@activate 装饰器。
    const always = mkPos === 'always' || e.constant === true || dc.act.always === true;
    // @@position：规范里的 before_char / after_char 恰好对上我们的 front / tail，
    // 能对上就照做 —— 这是少数几个我们真能兑现的装饰器。
    const decoPos = (dc.act.position === 'before_char' || dc.act.position === 'before') ? 'front'
      : (dc.act.position === 'after_char' || dc.act.position === 'after') ? 'tail' : '';
    // position：0/1 = 角色卡前/后；2/3 = Author's Note 前/后（本软件没有 AN，一并当 front）；
    //           4 = 按对话深度插入（v0.4.2.1 起【真的照做】，见下面 pos='atdepth'）
    const deep = Number(e.position) === 4;
    // 深度：酒馆的 @D 深度就是它，默认 4（官方表单默认值）。0 = 紧贴最后一条。
    const depthN = deep ? Math.max(0, Math.min(1000, Math.round(Number(e.depth)) || 4)) : -1;
    // @@position 的值我们只认 before/after；别的（比如 at_depth）照样算"做不到"
    const decoPosBad = dc.act.position !== undefined && !decoPos;
    const pos = always ? 'always'
      : (deep ? 'atdepth' : (decoPos || (mkPos === 'tail' ? 'tail' : 'front')));
    // 读不懂触发条件的，标 needsReview —— 和世界书文件那条导入路径（fromSillyTavern）
    // 用同一套判据，别让同一个文件从两个入口进来得到两种结果。
    const why = [];
    // ⚠️ use_regex 从 v0.4.0 起【真的照做】（hitKeys 里按正则匹配），
    //    所以它不再是一条"读不懂"。原来它在这里被标成待确认 —— 那是当时的实话，
    //    现在有能力兑现了还标着，就等于把能用的条目锁在门外。
    const useRegex = e.use_regex === true || e.useRegex === true;
    // ⚠️ V3 把 keysecondary 改名成 secondary_keys（v0.4.0 补）——
    //    只认老名字的话，V3 卡的二次筛选条件会被【当成没有】，
    //    于是"主键一命中就出现"，而不是"两个条件都满足才出现"。
    //
    // ⚠️ v0.4.2.1：二次筛选 / 概率 / 深度插入这三样【从"待确认"升级成"真的照做"】
    //    （见 app.js 的 hitKeys / worldbookHits / composeApiMsgs）。
    //    原来它们一律标 needsReview、于是【不注入】—— 一份从酒馆搬来的世界书，
    //    凡是用了这三种设置的条目全部静默躺尸，用户看到的是"导进来了，但她不知道"。
    //    有能力兑现还标着待确认，就是把能用的东西锁在门外（这条规矩 v0.4.0 已经写过一次）。
    const secRaw = Array.isArray(e.secondary_keys) ? e.secondary_keys
      : (Array.isArray(e.keysecondary) ? e.keysecondary
        : (typeof e.keysecondary === 'string' ? splitK(e.keysecondary)
          : (typeof e.secondary_keys === 'string' ? splitK(e.secondary_keys) : [])));
    const sec = secRaw.map(k => String(k == null ? '' : k).trim().slice(0, 64)).filter(Boolean).slice(0, 64);
    // selectiveLogic：0=AND_ANY（默认，任一二次键命中）1=NOT_ALL 2=NOT_ANY 3=AND_ALL
    const logicRaw = Number(e.selectiveLogic != null ? e.selectiveLogic : e.selective_logic);
    const logic = Number.isFinite(logicRaw) ? Math.max(0, Math.min(3, Math.round(logicRaw))) : 0;
    // 概率：ST 是 0~100，100 = 必触发。useProbability===false 时不看这个数。
    const probRaw = Number(e.probability);
    const prob = (e.useProbability === false || !Number.isFinite(probRaw))
      ? 100 : Math.max(0, Math.min(100, Math.round(probRaw)));
    // ⚠️ 概率 0 = 永远不会触发。这几乎不可能是用户想要的，所以【不静默吞掉】，
    //    标成待确认让他自己看见（真要关掉一条应该用「已关闭」）。
    if (prob === 0) why.push('概率是 0%（永远不会触发）');
    // 大小写 / 整词匹配：两条都是酒馆的字段。整词匹配对中日文有害（官方文档明确警告），
    // 所以它只对"纯英文数字"的触发词生效，中文一律还是子串匹配 —— 见 app.js hitKeys。
    const caseSensitive = e.caseSensitive === true || e.case_sensitive === true;
    const wholeWords = e.matchWholeWords === true || e.match_whole_words === true;
    // 插入顺序：酒馆用它决定同一轮里多条设定的先后。读得到就照做（原来是按库里的顺序）。
    const orderRaw = Number(e.order != null ? e.order : e.insertion_order);
    const order = Number.isFinite(orderRaw) ? Math.max(-100000, Math.min(100000, Math.round(orderRaw))) : 100;
    // 装饰器里我们【做不到】的那些：把它们明说出来，别装作这张卡是干净的。
    // 只报"会影响生效时机"的 —— 那才是 needsReview 要防的事。
    if (dc.act.onlyAfter != null) why.push('@@activate_only_after ' + dc.act.onlyAfter + '（按对话条数才生效）');
    if (dc.act.onlyEvery != null) why.push('@@activate_only_every ' + dc.act.onlyEvery);
    if (dc.act.keepAfter) why.push('@@keep_activate_after_match');
    if (dc.act.dontAfter) why.push('@@dont_activate_after_match');
    if (dc.unsupported.length) why.push('用了本软件做不到的装饰器：' + dc.unsupported.map(x => '@@' + x).join(' '));
    if (decoPosBad) why.push('用了本软件做不到的装饰器：@@position ' + dc.act.position);
    if (dc.unknown.length) why.push('有认不出来的装饰器：' + dc.unknown.map(x => '@@' + x).join(' '));
    // ⚠️ v0.4.2.1：酒馆还有几种"拿别的文本当触发源"的开关（匹配角色卡描述 / 人设 /
    //    场景 / 作者注 …）。这些【本软件做不到】，而它们不会让字段变得认不出来 ——
    //    不说的话，条目在我们这边只按 key 命中，也就是【触发时机是错的】，
    //    而用户看不到任何提示。按既有规矩：做不到就标出来，别装作这是一张干净的卡。
    const matchKeys = ['matchPersonaDescription', 'matchCharacterDescription', 'matchCharacterPersonality',
      'matchCharacterDepthPrompt', 'matchScenario', 'matchCreatorNotes'];
    const usedMatch = matchKeys.filter(k => e[k] === true);
    if (usedMatch.length) why.push('用了本软件做不到的触发方式：' + usedMatch.join(' '));
    if (e.triggers && (!Array.isArray(e.triggers) || e.triggers.length)) why.push('用了本软件做不到的触发器（triggers）');
    // ⚠️ 没有触发词又不是常驻 = 永远不会生效。
    //    v0.3.1 起【不再静默丢掉】（原来这里直接 continue）：标 needsReview 落库，
    //    世界书页会显示「待确认」，用户能点「一直生效」或补触发词。
    //    理由同 fromSillyTavern —— 静默丢弃和静默错设定一样糟，用户看不到任何提示。
    if (!keys.length && !always) why.push('没有触发词');
    // ⚠️ on:false 也要认（v0.4.0 统一判据时漏掉的，被 e2e-stworldbook 抓回来）。
    //    三种写法都是"这条关着"：本软件自己的 on:false、酒馆的 disable:true、V3 的 enabled:false。
    //    只认后两种的话，本软件自己导出的备份再导回来，【关掉的条理会自己打开】。
    out.push({ title, keys, content,
               on: e.enabled !== false && e.disable !== true && e.on !== false && dc.act.off !== true, pos,
               ...(useRegex ? { useRegex: true } : {}),
               // 排除词能兑现（匹配时看到它就跳过），所以单独带出来
               ...(dc.act.excludeKeys && dc.act.excludeKeys.length ? { excludeKeys: dc.act.excludeKeys } : {}),
               // ---- v0.4.2.1：酒馆那几档"生效时机"字段，落库并真的执行 ----
               ...(sec.length || e.selective === true ? { secondary: sec, logic, selective: true } : {}),
               ...(prob < 100 ? { prob } : {}),
               ...(caseSensitive ? { caseSensitive: true } : {}),
               ...(wholeWords ? { wholeWords: true } : {}),
               ...(order !== 100 ? { order } : {}),
               ...(deep ? { depth: depthN } : {}),
               ...(why.length ? { needsReview: true, reviewWhy: why.join('、') } : {}) });
  }
  return out;
}

/**
 * 一组世界书条目（对象或数组都行）→ 本软件的条目形状。
 *
 * ⚠️ 这个函数存在的意义就是【两个入口同一套判据】（v0.4.0）：
 *    从角色卡进来的、和从世界书文件进来的，走的是同一段代码。
 *    charcard.js 里那句"别让同一个文件从两个入口进来得到两种结果"从 v0.3.1 起
 *    一直写在注释里，但两条路径其实是各写各的 —— 于是 needsReview 在卡那条路上
 *    被丢掉、keysecondary / use_regex / 装饰器只在一半的地方认。现在只有一份。
 *
 * @param {Array|object} listOrMap
 * @param {object} [mctx] 宏上下文 { char, user, seed }
 */
export function entriesFromList(listOrMap, mctx) {
  let list = [];
  if (Array.isArray(listOrMap)) list = listOrMap;
  else if (listOrMap && typeof listOrMap === 'object') list = Object.keys(listOrMap).map(k => listOrMap[k]);
  return extractEntries({ entries: list }, mctx);
}

// ============================================================
//  PNG 卡
// ============================================================

const PNG_SIG = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

/** 前 8 字节是不是 PNG 签名 */
export function isPng(buf) {
  const u8 = new Uint8Array(buf);
  if (u8.length < 8) return false;
  for (let i = 0; i < 8; i++) if (u8[i] !== PNG_SIG[i]) return false;
  return true;
}

function latin1(u8, from, to) {
  let s = '';
  for (let i = from; i < to; i++) s += String.fromCharCode(u8[i]);
  return s;
}

/**
 * 从 PNG 里取出 "chara" / "ccv3" 的 tEXt（或 iTXt）内容并解析成卡片。
 *
 * PNG 结构：8 字节签名，然后是一串 chunk：
 *   [长度 4B 大端][类型 4B][数据][CRC 4B]
 * tEXt 的数据是：keyword \0 text  （两边都是 Latin1；卡片本体是 base64 所以是纯 ASCII）
 *
 * ⚠️ v0.4.0 改：**整张图扫完再决定用哪个块**。
 *    规范里 V3 卡【可以同时带 chara 和 ccv3】，而且没说谁在前 ——
 *    ccv3 是完整版，chara 是为了兼容老软件而回填的 V2 版（规范明确要求
 *    回填时把所有 @@ 装饰器删掉）。原来这里是"谁先出现就返回谁"，
 *    遇到 chara 在前的那种卡就读到那份阉割版，装饰器、secondary_keys、
 *    use_regex 一整批设定无声无息地没了。
 *    现在的顺序：ccv3 能用就用 ccv3，不行再退回 chara。
 */
export function extractCardFromPng(buf) {
  const u8 = new Uint8Array(buf);
  if (!isPng(u8)) throw new Error('不是 PNG 文件');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let off = 8;
  let fallback = null;
  const found = { chara: null, ccv3: null };   // 存解析后的卡片
  const bad = { chara: null, ccv3: null };     // 存解析失败的原因
  while (off + 8 <= u8.length) {
    const len = dv.getUint32(off);
    const type = latin1(u8, off + 4, off + 8);
    const ds = off + 8;
    const de = ds + len;
    if (de + 4 > u8.length) break;                           // 文件被截断，别再往下读
    if (type === 'tEXt' || type === 'iTXt') {
      // 找 keyword 和正文之间的那个 \0
      let nul = -1;
      for (let k = ds; k < de; k++) { if (u8[k] === 0) { nul = k; break; } }
      if (nul > ds) {
        const kw = latin1(u8, ds, nul);
        if ((kw === 'chara' || kw === 'ccv3') && !found[kw]) {
          const raw = latin1(u8, nul + 1, de);
          // iTXt 的正文前面还挂着 压缩标志/语言/译文名，这里只认最简单的形态，
          // 认不出来就记下来当 fallback —— 别因为一个怪 chunk 就把整张卡判死。
          try { found[kw] = parseCardJson(decodeB64Utf8(raw)); }
          catch (e) { bad[kw] = e; if (!fallback) fallback = e; }
        }
      }
    }
    // ⚠️ 不能读到 IEND 就 break —— 有的卡把 chara 写在 IEND 后面（不合规但真的存在），
    //    而我们要的是"扫完整张图"。IEND 之后没有合法 chunk，但循环本来就会因
    //    长度越界自然停下，所以这里只跳过 IEND 继续走，不多花多少时间。
    off = de + 4;
  }
  if (found.ccv3) return found.ccv3;
  if (found.chara) return found.chara;
  if (fallback) throw fallback;
  if (bad.ccv3 || bad.chara) throw new Error('这张 PNG 里的角色数据读不出来');
  throw new Error('这张 PNG 里没有角色数据（找不到 chara / ccv3 块）');
}

/**
 * 认一个文件到底是哪种卡，然后交给对应的解析器（v0.4.0）。
 *
 * 三种容器：PNG（tEXt 块）、CHARX（zip 里有 card.json）、纯 JSON 文本。
 * ⚠️ 顺序不能反：CHARX 和 PNG 都可能被改名成任意扩展名，
 *    所以一律【按文件头判断】，不看扩展名。
 *
 * @param {ArrayBuffer} buf
 * @returns {Promise<{card:object, avatarDataUrl:string, kind:string, assets:Array}>}
 */
export async function parseCardAuto(buf) {
  const u8 = new Uint8Array(buf);
  if (isPng(u8)) {
    return { card: extractCardFromPng(buf), avatarDataUrl: '', kind: 'png', assets: [] };
  }
  if (isZip(u8)) {
    const { json, files } = await readCharx(buf);
    const card = parseCardJson(json);
    // V3 的 assets：挑一张 icon 类型的当头像。
    // 规范里 ccdefault: 表示"用默认图"，我们没有默认图，跳过它。
    let avatarDataUrl = '';
    const list = Array.isArray(card.assets) ? card.assets : [];
    const icon = list.find(a => String(a.type || '') === 'icon' && a.uri && !/^ccdefault:/i.test(a.uri))
      || list.find(a => a.uri && !/^ccdefault:/i.test(a.uri));
    if (icon) {
      const bytes = findAsset(files, icon.uri);
      if (bytes) avatarDataUrl = bytesToDataUrl(bytes, mimeOf(icon.name || icon.uri));
    }
    return { card, avatarDataUrl, kind: 'charx', assets: files.map(f => f.name) };
  }
  // 剩下的当 JSON 文本 —— 用 TextDecoder 而不是 atob，因为可能是 UTF-8 带 BOM
  const text = new TextDecoder('utf-8').decode(u8).replace(/^\uFEFF/, '');
  return { card: parseCardJson(text), avatarDataUrl: '', kind: 'json', assets: [] };
}

/** 在 IHDR 之后插入一个 tEXt chunk，返回新的字节数组 */
/**
 * 把 V3 卡投影成 V2（写进 PNG 的 chara 块用）。
 * 规范说 chara 里放的是"给老软件回填的 V2 版"，所以 V3 专属字段要摘掉 ——
 * 留着它们会让按 V2 读的实现拿到一个它不认识的形状。
 */
export function toV2Projection(card) {
  const V3_ONLY = ['nickname', 'group_only_greetings', 'assets', 'creation_date',
    'modification_date', 'creator_notes_multilingual', 'source'];
  const data = {};
  for (const k of Object.keys((card && card.data) || {})) {
    if (V3_ONLY.indexOf(k) >= 0) continue;
    data[k] = card.data[k];
  }
  return { spec: 'chara_card_v2', spec_version: '2.0', data };
}

export function insertTextChunk(pngBytes, keyword, text) {
  const src = new Uint8Array(pngBytes);
  if (!isPng(src)) throw new Error('底图不是 PNG');
  const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);

  // 找 IHDR 之后的位置（规范要求 IHDR 必须是第一个 chunk）
  let off = 8;
  let insertAt = -1;
  while (off + 8 <= src.length) {
    const len = dv.getUint32(off);
    const type = latin1(src, off + 4, off + 8);
    off = off + 8 + len + 4;
    if (type === 'IHDR') { insertAt = off; break; }
  }
  if (insertAt < 0) throw new Error('PNG 结构异常：找不到 IHDR');

  const kw = String(keyword);
  const tx = String(text);
  // tEXt 只允许 Latin1 —— keyword 是 ASCII，正文是 base64（也是 ASCII），所以两个都安全。
  // 要是有人往这里塞中文，这里会静默截断成低字节，所以下面做个断言。
  if (/[^\x00-\x7F]/.test(kw) || /[^\x00-\x7F]/.test(tx)) {
    throw new Error('tEXt 只能存 ASCII，正文必须已是 base64');
  }

  const dataLen = kw.length + 1 + tx.length;
  const chunk = new Uint8Array(12 + dataLen);
  const cdv = new DataView(chunk.buffer);
  cdv.setUint32(0, dataLen);
  chunk[4] = 0x74; chunk[5] = 0x45; chunk[6] = 0x58; chunk[7] = 0x74;   // 'tEXt'
  for (let i = 0; i < kw.length; i++) chunk[8 + i] = kw.charCodeAt(i) & 0xFF;
  chunk[8 + kw.length] = 0;
  const txAt = 8 + kw.length + 1;
  for (let i = 0; i < tx.length; i++) chunk[txAt + i] = tx.charCodeAt(i) & 0xFF;
  // CRC 覆盖「类型 + 数据」，不含长度字段
  cdv.setUint32(8 + dataLen, crc32(chunk.subarray(4, 8 + dataLen)));

  const out = new Uint8Array(src.length + chunk.length);
  out.set(src.subarray(0, insertAt), 0);
  out.set(chunk, insertAt);
  out.set(src.subarray(insertAt), insertAt + chunk.length);
  return out;
}

// ============================================================
// 打包成卡片
// ============================================================

/**
 * 本项目的角色 + 世界书条目 → V2 卡对象。
 * @param {object} char 角色（name / greeting / persona）
 * @param {Array}  entries 世界书条目 [{keys, content, on}]
 */
/**
 * 梦弦居自己的角色级参数（v1.21.47）。
 *
 * 之前导出的卡只有名字/人物设定/开场白/世界书 —— 表达方式、外貌、颜文字、
 * 「他的设定」这些全留在手机里，换台机器导回去就全丢了。CCv2 的 extensions
 * 本来就是留给各家放私有字段的自由区：别的软件会忽略它，我们自己导回来能原样还原。
 *
 * ⚠️ 只放跟这个角色绑定的东西。全局设置（API Key、搜索 key 之类）绝不能进卡 ——
 *    卡是会被随手分享出去的东西。
 */
const MK_CARD_KEYS = [
  'temperature', 'maxTokens', 'contextRounds', 'reasoningEffort',
  'kaomojiFreq', 'emojiFreq', 'verbosity', 'epicChain', 'descLevel', 'detailDrive',
  'splitMessages', 'povLock', 'thinkMode', 'searchPolicy', 'clockPolicy',
  // ⚠️ povStyle 是现行字段（v1.21.49 起），povLock 已经废弃只是还留着兼容。
  //    这张表原来只有废弃的那个 —— 于是 L2/L3/L4 视角的角色导出卡片再导回来，
  //    视角整段静默消失（只有 L1 侥幸活着，因为 L1 ≡ povLock=true）。
  'povStyle',
  'appearance', 'appearanceOn', 'longMemory', 'allowEditMine',
  'typingDelay', 'hesitation', 'showTyping',
  // ⚠️ v1.21.53 补：「立即生效」那一层（她此刻的样子）也要进卡。
  //    原来只带 appearance 基线，导回来时她身上那套临时的就没了。
  'appearanceLive',
  // 「临时场景」是【角色的】当前情境（c.scene），不是"我的设置"——
  // 和下面被排除的那两项不同类，所以进卡（v1.21.53 从排除名单里挪回来）。
  'scene',
  // ⚠️ myProfile / myEnv 是【你自己的】私事（"我是谁""我住哪"），不是这个角色的设定。
  //    角色卡是会被随手分享出去的东西 —— 这两项不进卡（v1.21.52）。
  //    整机搬家请用设置页的「导出全部数据」，那条路会带。
  //    （scene 曾经也被错划进这一组，v1.21.53 挪回来了：它是【角色的】当前情境 c.scene，
  //     写在角色对象上、跟着角色走，和"我是谁/我住哪"不同类。这段注释当时没跟着改，
  //     一直写着"三项不进卡"，和上面 MK_CARD_KEYS 里的 'scene' 自相矛盾 —— v1.21.54 更正。）
  // ⚠️ v0.5.3：「后来补的设定」也是【角色的】设定（小说里新确立、之后进聊天与小说两边），
  //    和 scene / appearance 同一类。不进卡的话，换台机器导回来她就不认这些事了。
  'canonExtra',
];

function mkParams(char) {
  const o = {};
  for (const k of MK_CARD_KEYS) if (char && char[k] !== undefined) o[k] = char[k];
  return o;
}

/**
 * 几个数字字段的合理范围（v1.21.53）。
 *
 * 为什么要有它：卡是外面来的东西。原来只判 `!== undefined`，于是一张写坏的、
 * 或者故意构造的卡可以把 contextRounds 设成 999999、kaomojiFreq 设成字符串 ——
 * 前者会让 buildHistory 一口气 slice 出整段历史，后者会让界面算出 NaN。
 * 上限刻意放得很宽（宁可松，不要误伤正常人设的值）。
 */
const NUM_LIMITS = {
  temperature: [0, 2], maxTokens: [1, 1000000], contextRounds: [1, 2000],
  kaomojiFreq: [0, 1], emojiFreq: [0, 1], typingDelay: [0, 60], epicChain: [0, 4],
};
const BOOL_KEYS = ['splitMessages', 'thinkMode', 'appearanceOn', 'longMemory', 'allowEditMine', 'hesitation', 'showTyping', 'povLock'];
const STR_KEYS = {
  reasoningEffort: 32, verbosity: 32, descLevel: 32,
  detailDrive: 32, povStyle: 8, searchPolicy: 8, clockPolicy: 8,
};
const TEXT_KEYS = { appearance: 8000, appearanceLive: 8000, scene: 8000, canonExtra: 4000 };

function sanitizeParam(k, v) {
  if (TEXT_KEYS[k]) return typeof v === 'string' ? v.slice(0, TEXT_KEYS[k]) : undefined;
  if (BOOL_KEYS.includes(k)) return !!v;
  if (STR_KEYS[k]) return typeof v === 'string' ? v.slice(0, STR_KEYS[k]) : undefined;
  const lim = NUM_LIMITS[k];
  if (lim) {
    const n = Number(v);
    if (!Number.isFinite(n)) return undefined;
    const c = Math.min(lim[1], Math.max(lim[0], n));
    // epicChain 数的是【段数】，只认整数：2.5 段是看不懂的
    return k === 'epicChain' ? Math.round(c) : c;
  }
  return v;
}

/** 从卡里读回梦弦居自己的参数。老卡没有这一段 → 返回空对象（导进去就是默认值） */
export function readMkParams(card) {
  const box = card && card.extensions && card.extensions.mengxianju;
  const p = box && box.params;
  if (!p || typeof p !== 'object') return {};
  const o = {};
  for (const k of MK_CARD_KEYS) {
    if (p[k] === undefined) continue;
    const v = sanitizeParam(k, p[k]);
    if (v !== undefined) o[k] = v;
  }
  // 头像（v1.21.53）：JSON 卡里没有图，只能靠这一份 dataURL 还原。
  // 只认 data:image/，且限个大小 —— 免得一张构造过的卡塞进几 MB 的串。
  if (typeof box.avatar === 'string' && /^data:image\//.test(box.avatar) && box.avatar.length < 4000000) {
    o.avatar = box.avatar;
  }
  return o;
}

export function buildCardV2(char, entries, opts) {
  // ⚠️ v1.21.51：「一直生效」那一档【没有触发词】，按老判据会被整个滤掉 ——
  //    导出卡片时那几条常驻设定就这么无声无息地没了（导回来当然也没有）。
  //    判据改成「有内容，且有触发词或者本身就是常驻」。
  const list = Array.isArray(entries)
    ? entries.filter(e => e && e.content && ((e.keys || []).length || e.pos === 'always'))
    : [];
  // V3 的那几样我们自己也存了（昵称 / 群聊开场白），导出时要带上 ——
  // 不带的话"导进来存下来"就成了单程票，换台机器导回去又没了。
  // 规范说 V3 卡要 spec:'chara_card_v3' + spec_version:'3.0'，
  // 所以只有真带了 V3 字段时才写 V3，否则老老实实 V2（别的软件对 V2 最友好）。
  const nick = String(char.nickname || '').trim();
  const grp = Array.isArray(char.groupGreetings) ? char.groupGreetings.map(String).filter(Boolean) : [];
  const alt = Array.isArray(char.alternateGreetings)
    ? char.alternateGreetings.map(String).filter(Boolean).slice(0, 20) : [];
  // alternate_greetings 其实是 V2 就有的字段，所以它【不】参与 V3 判定
  const isV3 = !!(nick || grp.length);
  // 卡里"另外那几项"（v0.4.2 起存进 char.cardFields）
  const cf = (char.cardFields && typeof char.cardFields === 'object') ? char.cardFields : {};
  /** @type {any} */
  const data = {
    name: String(char.name || '').trim() || '未命名',
    // 名称的对应关系：卡片 description ↔ 本项目 persona（都是"她是谁"）
    description: String(char.persona || ''),
    // ⚠️ 原来这四项【写死成空串】（v0.4.2 修）：导进来时没存、导出时抹掉，来回一次就没了。
    //    现在从 char.cardFields 原样写回（老角色没有这个字段 → 还是空串，和以前一样）。
    personality: cf.personality || '',
    scenario: cf.scenario || '',
    // 卡片 first_mes ↔ 本项目 greeting（开场白）
    first_mes: String(char.greeting || ''),
    mes_example: cf.mesExample || '',
    creator_notes: '由 梦弦居 导出',
    system_prompt: cf.systemPrompt || '',
    post_history_instructions: cf.postHistory || '',
    // v0.4.2.1：这两样现在存下来了，导出必须写回去 —— 不然换台机器导回去又没了
    alternate_greetings: alt,
    tags: Array.isArray(char.tags) ? char.tags.map(String).slice(0, 20) : [],
    creator: '',
    character_version: '',
    // 只有 V3 才写的字段：规范要求它们存在，写空数组也比不写强
    ...(isV3 ? {
      nickname: nick,
      group_only_greetings: grp,
      source: Array.isArray(char.source) ? char.source.slice(0, 5) : [],
      assets: [],
      creation_date: 0,
    } : {}),
    // v1.21.47：把我们自己的角色级参数挂在这里。别的软件读卡时忽略它，
    // 我们自己导回来则完整还原（含「他的设定 / 他的居处」和临时场景）。
    // 头像（v1.21.53）：JSON 卡没有别的地方存图，只能塞在这儿。
    // ⚠️ PNG 卡不塞（withAvatar:false）—— 它的图本身就是头像，再塞一份等于翻倍。
    extensions: { mengxianju: Object.assign(
      { spec: 1, params: mkParams(char) },
      (opts && opts.withAvatar === false) ? {} : (typeof char.avatar === 'string' && char.avatar ? { avatar: char.avatar } : {})
    ) },
  };
  if (list.length) {
    data.character_book = {
      name: data.name + ' 的世界书',
      entries: list.map((e, i) => ({
        // ⚠️ keys 可能是空的（常驻档）——原来直接 e.keys.map 会抛
        keys: (e.keys || []).map(String),
        content: String(e.content),
        enabled: e.on !== false,
        insertion_order: i,
        case_sensitive: false,
        // HACK v1.21.51：标题和档位是我们自己的字段，挂在标准扩展位里。
        // 别的软件读卡时会忽略它，我们导回来则完整还原（和 params 一个套路）。
        extensions: { mengxianju: { title: e.title || '', pos: e.pos || 'front' } },
      })),
    };
  }
  return isV3
    ? { spec: 'chara_card_v3', spec_version: '3.0', data }
    : { spec: 'chara_card_v2', spec_version: '2.0', data };
}

function loadImage(src) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error('头像加载失败'));
    im.src = src;
  });
}

/**
 * 生成 PNG 卡：用 Canvas 出一张合法 PNG 当底图，再把卡片 JSON 塞进 tEXt。
 *
 * 为什么要过 Canvas 而不是直接拿头像：
 *   头像可能是 JPEG（压缩后就选 jpeg），而 tEXt 只能挂在 PNG 上。
 *   自己手搓 IDAT 的 zlib 流不现实，Canvas.toDataURL('image/png') 直接给合法 PNG。
 */
export async function makeCardPng(char, entries, avatarDataUrl, size = 512) {
  // 图就在这张卡里，JSON 里不必再塞一份 dataURL（见 buildCardV2 末尾）
  const cardOpts = { withAvatar: false };
  const SZ = size;
  const cv = document.createElement('canvas');
  cv.width = SZ; cv.height = SZ;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#12131a';
  ctx.fillRect(0, 0, SZ, SZ);
  if (avatarDataUrl) {
    try {
      const img = await loadImage(avatarDataUrl);
      // 按 cover 铺满：短边贴边，长边居中裁掉
      const r = Math.max(SZ / img.width, SZ / img.height);
      const w = img.width * r, h = img.height * r;
      ctx.drawImage(img, (SZ - w) / 2, (SZ - h) / 2, w, h);
    } catch (e) { /* 画不上就留纯色底，不影响卡片数据 */ }
  }
  const b64 = cv.toDataURL('image/png').split(',')[1];
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

  const card = buildCardV2(char, entries, cardOpts);
  const json = JSON.stringify(card);
  // ⚠️ V3 卡必须把 V3 对象放进 ccv3 块（用户复核发现：原来只有 chara，
  //    而 chara 里塞的却是 spec=chara_card_v3 的对象）——
  //    SPEC_V3 原文：「The CharacterCardV3 object MUST be embedded … as a tEXt chunk.
  //    The tEXt chunk MUST be named ccv3」「Application MAY backfill Character Card V2
  //    objects from the PNG/APNG files in chara chunk」。
  //    也就是说：ccv3 = 完整 V3；chara = 给老软件（和给读 chara 的实现）看的 V2 降级版。
  //    我们自己读的时候 ccv3 优先（见 extractCardFromPng），所以往返照旧完整。
  if (card.spec === 'chara_card_v3') {
    const v2 = toV2Projection(card);
    return insertTextChunk(
      insertTextChunk(bytes, 'ccv3', encodeB64Utf8(json)),
      'chara', encodeB64Utf8(JSON.stringify(v2)));
  }
  return insertTextChunk(bytes, 'chara', encodeB64Utf8(json));
}

/** Uint8Array → base64（写文件给 Filesystem 用时需要） */
export function bytesToB64(bytes) {
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(bin);
}
