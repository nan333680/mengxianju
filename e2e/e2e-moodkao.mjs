// e2e-moodkao.mjs —— 颜文字按【心情】分组（v0.4.2.2）+ 「本轮更改」的余温一轮
//
// 覆盖：
//   1. 库结构：12 个心情组、每组条数、MOOD_NAME 齐全
//   2. 每一条颜文字：字符在 Android 有字形的白名单内 + detectKaomoji 认得出 + stripKaomoji 清得掉
//   3. 每个 emoji：单码点（可带 FE0F）+ 不是 Emoji 5.0 之后新增的（老字体里是方框）
//   4. 稳定前缀：按心情的整张表 + 三条硬约束 + 口味句；关闭档位不出表
//   5. 「本轮更改」的余温：只延续一轮、本轮再提以本轮为准、下一轮就没了
//   6. 余温条看得见、点 ✕ 就不带（落库那条打 cancelled 标记）
//
// ⚠️ 第 2 条是这套件的核心：用户手机上那些颜文字是一片方框 □，
//    因为源素材用了手机没装的字体。加条目必须先过这一关。

import puppeteer from 'puppeteer-core';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { MOOD_ORDER, MOOD_NAME, KAOMOJI_MOODS, EMOJI_MOODS, detectKaomoji, stripKaomoji } from '../www/js/persona.js';
const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');
const WWW = R + '/www';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

let pass = 0, fail = 0;
const t = (n, ok, ex = '') => { if (ok) { pass++; console.log('  OK   ' + n); } else { fail++; console.log('  FAIL ' + n + (ex ? '  -> ' + ex : '')); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- 1/2/3. 库本身 ----------
console.log('');
console.log('=== 1. 库结构 ===');
t('12 个心情组', MOOD_ORDER.length === 12, String(MOOD_ORDER.length));
t('心情都有中文名', MOOD_ORDER.every(k => MOOD_NAME[k]), MOOD_ORDER.filter(k => !MOOD_NAME[k]).join(','));
for (const k of MOOD_ORDER) {
  t('  ' + k + ' 有至少 8 条颜文字 / 3 个 emoji',
    (KAOMOJI_MOODS[k] || []).length >= 8 && (EMOJI_MOODS[k] || []).length >= 3,
    (KAOMOJI_MOODS[k] || []).length + '条/' + (EMOJI_MOODS[k] || []).length + '个');
}

// 字符白名单：Android 自带 Noto Sans / Noto Sans CJK / Noto Sans Symbols 覆盖的区间。
// 刻意【不含】CJK 汉字与扩展区、音标扩展、生僻符号 —— 那些就是方框的来源。
const RANGES = [[0x20,0x7e],[0xa1,0xff],[0x391,0x3c9],[0x2010,0x2027],[0x2030,0x205e],[0x2190,0x21ff],
  [0x2200,0x22ff],[0x2500,0x257f],[0x25a0,0x25ff],[0x2600,0x26ff],[0x2700,0x27bf],[0x3001,0x303f],
  [0x3041,0x309f],[0x30a1,0x30ff],[0xfe30,0xfe4f],[0xfe00,0xfe0f],[0xff01,0xff5e],[0xff61,0xff9f],[0xffe0,0xffe6]];
const cpOK = (c) => RANGES.some(([a, b]) => c >= a && c <= b);
const badChars = (s) => [...s].filter(ch => !cpOK(ch.codePointAt(0)));

console.log('');
console.log('=== 2. 每一条颜文字 ===');
const all = MOOD_ORDER.flatMap(k => KAOMOJI_MOODS[k]);
const seen = new Set(); let dup = [];
for (const k of MOOD_ORDER) for (const x of KAOMOJI_MOODS[k]) { if (seen.has(x)) dup.push(x); seen.add(x); }
t('没有重复条目', dup.length === 0, dup.join(' '));
const badFont = all.filter(x => badChars(x).length);
t('全部字符在手机有字形的白名单内（' + all.length + ' 条）', badFont.length === 0,
  badFont.slice(0, 3).map(x => x + ':' + badChars(x).map(c => 'U+' + c.codePointAt(0).toString(16).toUpperCase()).join(',')).join(' | '));
const noDetect = all.filter(x => !detectKaomoji(x).length);
t('detectKaomoji 认得出每一条', noDetect.length === 0, noDetect.slice(0, 3).join(' '));
const noStrip = all.filter(x => stripKaomoji('她笑了 ' + x + ' 呢').includes(x));
t('关闭档位能清掉每一条（stripKaomoji）', noStrip.length === 0, noStrip.slice(0, 3).join(' '));
// ⚠️ 审计 F2：光「原串不在结果里」还不够 —— 旧判据会把 (´∀｀)σ 清成 "σ"、
//    把嵌套的 (o(〃＾▽＾〃)o) 清成 "o)"，原串确实没了，屏幕上却留一撮残渣。
//    所以这条钉死「清完之后只剩句子本身」。
const leftover = all.filter(x => stripKaomoji('她笑了 ' + x + ' 呢').replace(/\s+/g, '') !== '她笑了呢');
t('★ 清完之后不留残渣（整条删干净，审计 F2）', leftover.length === 0,
  leftover.slice(0, 4).map(x => x + ' -> ' + JSON.stringify(stripKaomoji(x))).join(' | '));

// ⚠️ 审计 F1/F11/F15：判据反过来也不能误伤正文。
//    老判据是「括号里含任一记号字符就整组删」，于是带表情符号的正常句子被整句吃掉；
//    BARE_KAO 里的 www/233/hhh/orz 又都是正常人话。
console.log('');
console.log('=== 2b. 关闭档位不能误伤正文（审计 F1 / F11 / F15）===');
const KEEP = ['（笑 ♡）', '（她低下头 ✧）', '（心里一暖 ♥）', '（轻轻的 ☆）',
  '（看着你，眼睛有点亮 ♡ 然后移开了视线）', '（脸红）', '（她说：真的吗？）', '（笑 ☺️）',
  '他说 www.example.com 上有', '笑死 233 了', 'hhh 你好烦', '她 orz 了一下', '编号 233 不对'];
const harmed = KEEP.filter(s => stripKaomoji(s) !== s);
t('★ 带表情符号的括号句原样保留（F11/F15）', harmed.length === 0, harmed.join(' | '));
const bareHarmed = KEEP.slice(8).filter(s => stripKaomoji(s) !== s);
t('★ 正文里的 www / 233 / hhh / orz 不再被删（F1）', bareHarmed.length === 0, bareHarmed.join(' | '));
t('★ 「233」不再被算成「她用了颜文字」（F1 的负反馈那条）', detectKaomoji('笑死 233 了').length === 0,
  JSON.stringify(detectKaomoji('笑死 233 了')));
t('真颜文字照样清得掉（别为了不误伤就什么都不删）', stripKaomoji('今天好累 (´・ω・`)').includes('ω') === false,
  JSON.stringify(stripKaomoji('今天好累 (´・ω・`)')));

console.log('');
console.log('=== 3. emoji ===');
// 允许的块（Emoji 5.0 及以前就有的）+ Emoji 5.0 之后新增的码点黑名单。
const EMOJI_RANGES = [[0x2600,0x27bf],[0x2b00,0x2bff],[0x1f300,0x1f5ff],[0x1f600,0x1f64f],[0x1f6c0,0x1f6ff],[0x1f900,0x1f9ff]];
const EMOJI_BAN = [[0x1f7e0,0x1f7eb],[0x1f90c,0x1f90f],[0x1f93f,0x1f93f],[0x1f94d,0x1f94f],[0x1f96c,0x1f96f],
  [0x1f970,0x1f97f],[0x1f99d,0x1f99f],[0x1f9b0,0x1f9cf],[0x1f9e7,0x1f9ff],[0x1fa70,0x1faff]];
const emoOK = (c) => c === 0xfe0f || (EMOJI_RANGES.some(([a,b]) => c >= a && c <= b) && !EMOJI_BAN.some(([a,b]) => c >= a && c <= b));
const allEmo = MOOD_ORDER.flatMap(k => EMOJI_MOODS[k]);
const badEmo = allEmo.filter(e => [...e].some(ch => !emoOK(ch.codePointAt(0))));
t('全部 emoji 都是老字体里就有的（' + allEmo.length + ' 个）', badEmo.length === 0, badEmo.join(' '));
const compound = allEmo.filter(e => { const c = [...e]; return c.length > 2 || (c.length === 2 && c[1].codePointAt(0) !== 0xfe0f); });
t('没有组合序列（ZWJ / 肤色 / 旗帜）', compound.length === 0, compound.join(' '));
// 开发机上有官方清单时再做一次严格校验（E 版本号必须 ≤ 5.0）
const etest = R + '/tmp/emoji-test.txt';
if (fs.existsSync(etest)) {
  const lines = fs.readFileSync(etest, 'utf8').split(/\r?\n/);
  const ver = new Map();
  for (const ln of lines) {
    const m = /^([0-9A-F ]+)\s*;\s*fully-qualified\s*#\s*\S+\s+E([\d.]+)/.exec(ln);
    if (!m) continue;
    const cps = m[1].trim().split(/\s+/).map(h => parseInt(h, 16));
    if (cps.length <= 2) ver.set(cps.map(c => String.fromCodePoint(c)).join(''), parseFloat(m[2]));
  }
  const newer = allEmo.filter(e => { const v = ver.get(e); return v !== undefined && v > 5.0; });
  const unknown = allEmo.filter(e => ver.get(e) === undefined);
  t('官方清单复核：没有 Emoji 5.0 之后新增的', newer.length === 0, newer.map(e => e + '(' + ver.get(e) + ')').join(' '));
  t('官方清单复核：每个都在清单里（版本可查）', unknown.length === 0, unknown.join(' '));
} else {
  console.log('  （跳过：没有 tmp/emoji-test.txt，只做了码点级校验）');
}

// ---------- 页面部分 ----------
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8' };
const server = http.createServer((req,res) => {
  let q = decodeURIComponent(req.url.split('?')[0]); if (q === '/') q = '/index.html';
  const f = path.join(WWW, q);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = [];
page.on('pageerror', e => errs.push(e.message));

await page.evaluateOnNewDocument(() => {
  window.__hits = { chat: [] };
  const realFetch = window.fetch.bind(window);
  window.fetch = async function (url, opts) {
    const u = String(url);
    if (u.includes('/chat/completions')) {
      let body = {}; try { body = JSON.parse((opts && opts.body) || '{}'); } catch (e) {}
      window.__hits.chat.push(body);
      const chunk = (o) => 'data: ' + JSON.stringify(o) + String.fromCharCode(10,10);
      const payload = chunk({ choices: [{ delta: { content: '嗯。' } }] })
        + chunk({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 5 } })
        + 'data: [DONE]' + String.fromCharCode(10,10);
      return new Response(payload, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    return realFetch(url, opts);
  };
});

const seed = (spec) => page.evaluate(async (s) => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const put = (store, rec) => new Promise(r => { const tx = db.transaction(store,'readwrite'); tx.objectStore(store).put(rec); tx.oncomplete = r; });
  for (const c of (s.chars||[])) await put('characters', c);
  for (const e of (s.kv||[])) await put('kv', e);
  db.close();
}, spec);

const baseChar = (id, name, extra) => Object.assign({
  id, name, greeting: '（' + name + '）', persona: '你是' + name + '。',
  avatar: null, temperature: 1.0, maxTokens: 2048, topP: 1.0, reasoningEffort: 'low',
  contextRounds: 20, kaomojiFreq: 0.35, emojiFreq: 0.35,   // kaomojiStyle 已按审计 F3 删除
  verbosity: 'medium', splitMessages: false, typingDelay: 0, hesitation: false,
  showTyping: true, longMemory: false, allowEditMine: false,
  descLevel: 'low', povLock: false, appearance: '', appearanceOn: true,
  presetKey: 'blank', createdAt: Date.now()
}, extra || {});

async function pickChar(id) {
  await page.evaluate(async (cid) => {
    const o = indexedDB.open('ai-companion');
    const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
    await new Promise(r => { const tx = db.transaction('kv','readwrite'); tx.objectStore('kv').put({ k:'lastCharId', v: cid }); tx.oncomplete = r; });
    db.close();
    location.reload();
  }, id);
  await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30000 }).catch(()=>{});
  await sleep(900);
}

async function say(text) {
  await page.evaluate(t2 => {
    const el = document.getElementById('input');
    el.value = t2; el.dispatchEvent(new Event('input', { bubbles: true }));
  }, text);
  await sleep(120);
  await page.evaluate(() => document.getElementById('btn-send').click());
  for (let i = 0; i < 200; i++) {
    const b = await page.$eval('#btn-stop', el => !el.classList.contains('hidden')).catch(() => false);
    if (!b) break;
    await sleep(100);
  }
  await sleep(400);
  const h = await page.evaluate(() => window.__hits.chat);
  return h.length ? h[h.length - 1] : null;
}
const sysOf = (b) => b ? (b.messages || []).map(m => m.content || '').join('\n') : '';
const isHidden = (sel) => page.$eval(sel, el => el.classList.contains('hidden')).catch(() => null);
const textOf = (sel) => page.$eval(sel, el => el.textContent).catch(() => '');
const addCmd = async (k, arg) => {
  await page.evaluate(() => document.getElementById('btn-plus').click());
  await sleep(250);
  await page.evaluate(kk => {
    const b = [...document.querySelectorAll('#cmd-drawer .cmd-item')].find(x => x.dataset.cmd === kk);
    if (b) b.click();
  }, k);
  await sleep(300);
  if (arg) {
    await page.evaluate((kk, vv) => {
      const i = document.querySelector('#cmd-slots [data-cmd="' + kk + '"]');
      if (i) { i.value = vv; i.dispatchEvent(new Event('input', { bubbles: true })); }
    }, k, arg);
    await sleep(150);
  }
};
const tagsOfMsg = (cid, content) => page.evaluate(async (id, want) => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => { o.onsuccess = () => r(o.result); });
  const all = await new Promise(r => { const q = db.transaction('messages').objectStore('messages').getAll(); q.onsuccess = () => r(q.result); });
  db.close();
  const mine = all.filter(m => m.charId === id && m.role === 'user').sort((a,b) => a.ts - b.ts);
  const hit = mine.find(m => (m.content || '').includes(want));
  return hit ? (hit.tags || null) : 'NO_MSG';
}, cid, content);

console.log('');
console.log('=== 4. 稳定前缀里的心情表 ===');
await page.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'networkidle0', timeout: 40000 });
await sleep(1200);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil: 'networkidle0' });
await sleep(1000);

const CID = 'cmood1', CID0 = 'cmood0';
await seed({
  chars: [ baseChar(CID, '心情'), baseChar(CID0, '关掉', { kaomojiFreq: 0, emojiFreq: 0 }) ],
  kv: [ { k: 'settings', v: { apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', clockMode: false } } ],
});
await pickChar(CID);
const b1 = await say('第一句');
const s1 = sysOf(b1);
t('前缀里有按心情挑的那句', s1.includes('先看自己这会儿是什么心情'), s1.length + ' 字');
t('12 个心情名全在表里', MOOD_ORDER.every(k => s1.includes(MOOD_NAME[k])), MOOD_ORDER.filter(k => !s1.includes(MOOD_NAME[k])).join(','));
t('表里带了颜文字（抽查第一条）', s1.includes(KAOMOJI_MOODS.calm[0]) && s1.includes(KAOMOJI_MOODS.sad[0]), '');
t('表里带了 emoji（抽查）', s1.includes(EMOJI_MOODS.love[0]) || s1.includes(EMOJI_MOODS.happy[0]), EMOJI_MOODS.love.join(''));
t('三条硬约束都在', s1.includes('一条消息顶多加一个颜文字') && s1.includes('别自己造、也别用表里没有的符号')
  && s1.includes('不要连着两条用同一个'), '');
t('说了表外字符会显示成方框', s1.includes('方框'), '');
// 审计 F3：kaomojiStyle（四档口味）已从产品里删掉，提示词里不该再留它的痕迹
t('★ 删掉的 kaomojiStyle 不再出现在提示词里', !s1.includes('不是挑选依据') && !s1.includes('jp-soft'), '');
t('emoji 有上限那句话', s1.includes('一条消息最多两个'), '');

await pickChar(CID0);
const b0 = await say('第二句');
const s0 = sysOf(b0);
t('关闭档位：说不使用颜文字', s0.includes('你不使用任何颜文字'), '');
t('关闭档位：不贴心情表', !s0.includes('先看自己这会儿是什么心情'), '');
t('关闭档位：不说可以用 emoji', !s0.includes('可以适度使用 emoji'), '');

console.log('');
console.log('=== 5. 「本轮更改」的余温 ===');
await pickChar(CID);
await addCmd('direct', '叫我哥哥');
const b2 = await say('第三句');
const s2 = sysOf(b2);
t('本轮段还是「这一轮的额外要求」', s2.includes('这一轮的额外要求') && s2.includes('叫我哥哥'), '');
t('本轮不提「上一轮的要求」', !s2.includes('上一轮的要求'), '');
t('余温条出现了', (await isHidden('#carry-tag')) === false, '');
t('余温条写着他上一轮的要求', (await textOf('#carry-tag')).includes('叫我哥哥'), await textOf('#carry-tag'));
t('落库那条带 direct 标签', JSON.stringify(await tagsOfMsg(CID, '第三句')).includes('叫我哥哥'), JSON.stringify(await tagsOfMsg(CID, '第三句')));

const b3 = await say('第四句');
const s3 = sysOf(b3);
t('下一轮带上了「上一轮的要求（还没过去）」', s3.includes('上一轮的要求（还没过去）') && s3.includes('叫我哥哥'), '');
t('说了它正在过去、别挂嘴上', s3.includes('比上一轮淡一些'), '');
t('余温条这一轮消失了（只延续一轮）', (await isHidden('#carry-tag')) === true, '');

const b4 = await say('第五句');
const s4 = sysOf(b4);
t('再下一轮就真的没了', !s4.includes('上一轮的要求'), '');

console.log('');
console.log('=== 6. 点 ✕ 取消余温 ===');
await addCmd('direct', '别叫我名字');
await say('第六句');
t('余温条又出现了', (await isHidden('#carry-tag')) === false, '');
await page.evaluate(() => document.getElementById('carry-x').click());
await sleep(300);
t('点 ✕ 之后余温条消失', (await isHidden('#carry-tag')) === true, '');
const tg = await tagsOfMsg(CID, '第六句');
t('落库那条被标了 cancelled（历史仍看得到）', JSON.stringify(tg).includes('cancelled'), JSON.stringify(tg));
const b6 = await say('第七句');
t('取消之后这一轮不带上一轮的要求', !sysOf(b6).includes('上一轮的要求'), '');

console.log('');
t('全程没有页面报错', errs.length === 0, errs.slice(0, 3).join(' | '));

console.log('');
console.log('心情颜文字：通过 ' + pass + ' 项 / 失败 ' + fail + ' 项');
await browser.close();
server.close();
process.exit(fail ? 1 : 0);
