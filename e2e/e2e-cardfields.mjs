// e2e-cardfields.mjs —— 卡片里"另外那几项"和 V3 的 PNG 块（v0.4.2）
//
// 起因（用户复核 v0.4.1）：
//   ① charcard 把卡里的 personality / scenario / mes_example / system_prompt /
//      post_history_instructions 都读出来了，app.js 却一个字都没引用 ——
//      导进来永久少一块，toast 也一声不吭。而仓库自带的三张示例卡这三项【长度都是 0】，
//      130 套 e2e 里 grep personality 是 0 命中 —— 也就是说这条路上从来没跑过真有这些字段的卡。
//   ② PNG 导出只写 chara 一个块，而 V3 规范要求 V3 对象进 ccv3（chara 只放 V2 降级版）。
//   ③ 自动备份：DOCUMENTS 里那份最新的坏掉时，EXTERNAL / DATA 里那份好的从来没被看过。
//
// 这个套件专门用【真有这些内容的卡】跑一遍，并且直接测那三处。
import puppeteer from 'puppeteer-core';
import fs from 'fs'; import os from 'os'; import path from 'path';
import http from 'http';
import { readLatestBackup, BACKUP_DIRS, backupName } from '../www/js/autobackup.js';
const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');
const WWW = R + '/www';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.png':'image/png' };
let pass = 0, fail = 0;
const t = (n, ok, ex) => { if (ok) { pass++; console.log('  OK   ' + n); } else { fail++; console.log('  FAIL ' + n + (ex !== undefined ? '  -> ' + JSON.stringify(ex) : '')); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- ③ 先测纯函数（不需要浏览器）
console.log('=== 1. 自动备份：第一个目录读坏时要继续看后面 ===');
const GOOD = { exportedAt: '2026-10-14T00:00:00.000Z', characters: [{ name: '甲' }] };
const mkFS = (map) => ({
  readdir: async ({ directory }) => ({ files: (map[directory] || []).map(n => ({ name: n })) }),
  readFile: async ({ path: p, directory }) => {
    const name = p.split('/').pop();
    const e = (map['__bad'] || {})[directory];
    if (e && e[name]) throw new Error(e[name]);
    const rec = (map['__content'] || {})[directory];
    if (rec && rec[name] !== undefined) return { data: rec[name] };
    throw new Error('not found');
  },
});
const bad = backupName(new Date('2026-10-14'));
const good = backupName(new Date('2026-10-13'));
{
  // DOCUMENTS 里最新那份读不出来，DATA 里有一份好的
  const map = { DOCUMENTS: [bad], DATA: [good], __bad: { DOCUMENTS: { [bad]: 'EACCES' } }, __content: { DATA: { [good]: JSON.stringify(GOOD) } } };
  const r = await readLatestBackup({ FS: mkFS(map), directories: ['DOCUMENTS', 'EXTERNAL', 'DATA'] });
  console.log('   读失败那份在 DOCUMENTS，好那份在 DATA -> ' + JSON.stringify({ ok: r.ok, dir: r.dir, reason: r.reason }));
  t('第一个目录读不出来时会继续找后面的', r.ok === true && r.dir === 'DATA', r);
}
{
  // DOCUMENTS 里最新那份是坏 JSON
  const map = { DOCUMENTS: [bad], DATA: [good], __content: { DOCUMENTS: { [bad]: '{ 坏掉的 json' }, DATA: { [good]: JSON.stringify(GOOD) } } };
  const r = await readLatestBackup({ FS: mkFS(map), directories: BACKUP_DIRS });
  console.log('   坏 JSON 在 DOCUMENTS -> ' + JSON.stringify({ ok: r.ok, dir: r.dir }));
  t('JSON 坏掉时也继续找后面的', r.ok === true && r.dir === 'DATA', r);
}
{
  // 全是坏的：要报出最靠前那条错，不能装作没有
  const map = { DOCUMENTS: [bad], DATA: [good], __bad: { DOCUMENTS: { [bad]: 'EACCES' }, DATA: { [good]: 'EACCES' } } };
  const r = await readLatestBackup({ FS: mkFS(map), directories: BACKUP_DIRS });
  console.log('   全坏 -> ' + JSON.stringify({ ok: r.ok, reason: r.reason, dir: r.dir }));
  t('全坏时如实报错（不返回 ok）', r.ok === false && r.reason === 'read-failed' && r.dir === 'DOCUMENTS', r);
}

// ---------------------------------------------------------------- ② PNG 块（纯函数）
console.log('');
console.log('=== 2. PNG 导出：V3 要写 ccv3，chara 放 V2 降级版 ===');
const cc = await import('../www/js/charcard.js');
// 用一张真 PNG 当底图（1×1）
const basePng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
// buildCardV2 是纯函数：给一个带 V3 字段的角色，它应该返回 V3
const v3char = { name: '紫', persona: '她是八云紫。', greeting: '（她抬眼）', nickname: '紫妈', groupGreetings: ['（群里）'], cardFields: { personality: '懒散而深不可测', mesExample: '<START>她：嗯。' } };
const card = cc.buildCardV2(v3char, [], { withAvatar: false });
t('带昵称的角色导出的是 V3 卡', card.spec === 'chara_card_v3', card.spec);
t('V3 卡里带回了 personality', card.data.personality === '懒散而深不可测', card.data.personality);
t('V3 卡里带回了 mes_example', card.data.mes_example === '<START>她：嗯。', card.data.mes_example);
const v2proj = cc.toV2Projection(card);
t('投影成 V2 时摘掉 V3 专属字段', v2proj.spec === 'chara_card_v2' && v2proj.data.nickname === undefined && v2proj.data.group_only_greetings === undefined, Object.keys(v2proj.data).slice(0, 8));
// 逐块读 PNG 的 tEXt 关键字
const textKeywords = (buf) => {
  const out = [];
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString('latin1');
    if (type === 'tEXt' || type === 'iTXt') {
      const body = buf.subarray(off + 8, off + 8 + len);
      const nul = body.indexOf(0);
      out.push(body.subarray(0, nul).toString('latin1'));
    }
    off = off + 8 + len + 4;
    if (type === 'IEND') break;
  }
  return out;
};
const withChunks = cc.insertTextChunk(
  cc.insertTextChunk(new Uint8Array(basePng), 'ccv3', Buffer.from(JSON.stringify(card), 'utf8').toString('base64')),
  'chara', Buffer.from(JSON.stringify(v2proj), 'utf8').toString('base64'));
const kws = textKeywords(Buffer.from(withChunks));
console.log('   PNG 里的 tEXt 关键字: ' + JSON.stringify(kws));
t('V3 卡导出后有 ccv3 块', kws.includes('ccv3'), kws);
t('同时保留 chara 块（给老软件兜底）', kws.includes('chara'), kws);
// 读回来：应该优先拿 ccv3（完整版）
const back = cc.extractCardFromPng(Buffer.from(withChunks));
// ⚠️ extractCardFromPng 返回的是【规范化后的平铺卡对象】（name/personality… 在顶层，没有 .data），
//    第一版按 {spec, data} 取，直接炸了。
const bd = (back && back.data) ? back.data : back;
console.log('   读回来: spec=' + back.spec + ' nickname=' + JSON.stringify(bd.nickname));
t('读回来优先用 ccv3（昵称还在）', back.spec === 'chara_card_v3' && bd.nickname === '紫妈', { spec: back.spec, nick: bd.nickname });
t('读回来的 personality 没丢', bd.personality === '懒散而深不可测', bd.personality);

// ---------------------------------------------------------------- ① 走真实导入路径
console.log('');
console.log('=== 3. 真的导一张"这些字段都有内容"的卡 ===');
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = path.join(WWW, p);
  if (!fs.existsSync(f)) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
  res.end(fs.readFileSync(f));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = []; page.on('pageerror', e => errs.push(e.message));

const CARD = {
  spec: 'chara_card_v3', spec_version: '3.0',
  data: {
    name: '复核实测',
    description: '她是被复核出来的角色。',
    personality: '冷淡、话少，但记得住每一件小事。',
    scenario: '在一间雨天的旧书店里。',
    first_mes: '（她把书合上）你来了。',
    mes_example: '<START>\n{{user}}：在吗\n{{char}}：（没抬头）在。',
    system_prompt: '永远用短句回答，不说教。',
    post_history_instructions: '别把话题岔开。',
    creator_notes: '给测试用的卡',
    alternate_greetings: ['（另一条开场白）'],
    tags: [], creator: '', character_version: '',
    nickname: '', group_only_greetings: [],
  },
};
const cardFile = path.join(os.tmpdir(), 'mxj-e2e-cardfields.json');
fs.writeFileSync(cardFile, JSON.stringify(CARD), 'utf8');

await page.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'networkidle0', timeout: 40000 });
await sleep(1000);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil: 'networkidle0' }); await sleep(900);
await (await page.$('#cc-import-file')).uploadFile(cardFile);
await sleep(3000);
const toastTxt = await page.evaluate(() => { const e = document.getElementById('toast'); return e ? e.textContent : ''; });
console.log('   toast: ' + toastTxt);
const rec = await page.evaluate(async () => {
  const { chars } = await import('/js/db.js');
  const all = await chars.all();
  const c = all[all.length - 1];
  return { name: c.name, persona: c.persona, cardFields: c.cardFields || null, spec: c.cardSpec || '' };
});
console.log('   落到库里的 cardFields: ' + JSON.stringify(rec.cardFields));
t('personality 存下来了', !!rec.cardFields && rec.cardFields.personality === CARD.data.personality, rec.cardFields);
t('scenario 存下来了', !!rec.cardFields && rec.cardFields.scenario === CARD.data.scenario, rec.cardFields);
// ⚠️ 宏在导入时就被展开了（{{user}}→你、{{char}}→角色名），这是设计，所以不能拿原文比
const wantExample = CARD.data.mes_example.replace('{{user}}', '你').replace('{{char}}', CARD.data.name);
t('mes_example 存下来了（宏已展开）', !!rec.cardFields && rec.cardFields.mesExample === wantExample, rec.cardFields && rec.cardFields.mesExample);
t('system_prompt 存下来了', !!rec.cardFields && rec.cardFields.systemPrompt === CARD.data.system_prompt, rec.cardFields);
t('post_history_instructions 存下来了', !!rec.cardFields && rec.cardFields.postHistory === CARD.data.post_history_instructions, rec.cardFields);
t('导入提示里说了这几项（不再一声不吭）', /性格|对话范例/.test(toastTxt), toastTxt);
t('人设本体没被这些标签污染（往返才不会膨胀）', rec.persona === CARD.data.description, rec.persona);

console.log('');
console.log('=== 4. 这些内容要真的进她的稳定前缀 ===');
const sys = await page.evaluate(async () => {
  const { chars } = await import('/js/db.js');
  const { buildStablePrompt } = await import('/js/persona.js');
  const all = await chars.all();
  const c = all[all.length - 1];
  return buildStablePrompt(c, { longMemory: false }, '');
});
console.log('   稳定前缀长度: ' + sys.length + ' 字');
t('前缀里有【性格】段', sys.includes('【性格】') && sys.includes(CARD.data.personality), sys.slice(0, 80));
t('前缀里有【场景】段', sys.includes('【场景】') && sys.includes(CARD.data.scenario), '');
t('前缀里有【对话范例】段（并说明照它写）', sys.includes('【对话范例】') && /照这个的写法说话/.test(sys), '');
t('前缀里有【卡里给的角色说明】', sys.includes('【卡里给的角色说明】') && sys.includes(CARD.data.system_prompt), '');
t('前缀里有【对话之后要一直记着的】', sys.includes('【对话之后要一直记着的】') && sys.includes(CARD.data.post_history_instructions), '');

console.log('');
console.log('=== 5. 再导出成卡：这五项要原样写回去（不再是单程票）===');
const out = await page.evaluate(async () => {
  const { chars } = await import('/js/db.js');
  const cc2 = await import('/js/charcard.js');
  const all = await chars.all();
  const c = all[all.length - 1];
  return cc2.buildCardV2(c, [], { withAvatar: false });
});
t('导出的 personality 与导入一致', out.data.personality === CARD.data.personality, out.data.personality);
t('导出的 scenario 与导入一致', out.data.scenario === CARD.data.scenario, out.data.scenario);
t('导出的 mes_example 与库里一致（宏展开后原样带回）', out.data.mes_example === wantExample, out.data.mes_example);
t('导出的 system_prompt 与导入一致', out.data.system_prompt === CARD.data.system_prompt, out.data.system_prompt);
t('导出的 post_history_instructions 与导入一致', out.data.post_history_instructions === CARD.data.post_history_instructions, out.data.post_history_instructions);
t('description 没被塞进标签（人设本体还是原样）', out.data.description === CARD.data.description, out.data.description);

t('全程没有页面报错', errs.length === 0, errs.slice(0, 3));
await browser.close(); server.close();
console.log('');
console.log('通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
