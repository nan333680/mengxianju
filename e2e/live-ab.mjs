// live-ab.mjs —— 真 key 跑「v2 开 vs 关」对照（不进回归：文件名不是 e2e-*.mjs）
//
// 同一角色人设、同一组输入、同样的设置，只有 liveV2 一个变量。
// 逐轮记录她的输出 + 可量化指标，最后并排给出来看。
// 用法：$env:DSH_API_KEY='...'; node e2e/live-ab.mjs
import puppeteer from 'puppeteer-core';
import { waitIdle } from './e2e-helper.mjs';
import http from 'http';
import fs from 'fs';
import path from 'path';
const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');
const WWW = R + '/www';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const KEY = (process.env.DSH_API_KEY || '').trim();
if (!KEY || KEY.length < 20) { console.log('没有 DSH_API_KEY，退出'); process.exit(2); }
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const server = http.createServer((req, res) => {
  let q = decodeURIComponent(req.url.split('?')[0]); if (q === '/') q = '/index.html';
  const f = path.join(WWW, q);
  if (!fs.existsSync(f)) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(fs.readFileSync(f));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
const page = await browser.newPage();
await page.setCacheEnabled(false);
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = [];
page.on('pageerror', e => errs.push(e.message));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 问题序列：日常一句 / 收尾一句 / 追问一句 / 撒娇一句
const SAYS = ['今天有点累，不想说话。', '那你去忙吧。', '你刚才那句话是什么意思？', '算了，陪我待会儿。'];

async function seed(charId, liveV2) {
  await page.evaluate(async (cid, on, k) => {
    const db = await new Promise((res, rej) => { const rq = indexedDB.open('ai-companion'); rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); });
    const put = (s, v) => new Promise((res, rej) => { const tx = db.transaction(s, 'readwrite'); tx.objectStore(s).put(v); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    const now = Date.now();
    await put('characters', {
      id: cid, name: '阿绫', greeting: '（阿绫靠在门边，抬了下眼）', persona: '你是阿绫，二十岁，脾气直，句子短，不爱解释。', avatar: null,
      temperature: 1.0, maxTokens: 2048, topP: 1.0, reasoningEffort: 'low', contextRounds: 20,
      kaomojiFreq: 0, emojiFreq: 0, verbosity: 'medium', splitMessages: true, typingDelay: 0.15,
      hesitation: false, showTyping: true, longMemory: false, allowEditMine: false,
      descLevel: 'high', detailDrive: 'max', povLock: false, appearance: '', appearanceOn: true, presetKey: 'blank', createdAt: now
    });
    await put('kv', { k: 'settings', v: { apiKey: k, baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', clockMode: false, liveV2: on } });
    await put('kv', { k: 'lastCharId', v: cid });
    db.close();
  }, charId, liveV2, KEY);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(2400);
}

async function round(cid, txt) {
  const before = await page.evaluate(async (c) => {
    const db = await new Promise((res, rej) => { const rq = indexedDB.open('ai-companion'); rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); });
    const all = await new Promise(r => { const q = db.transaction(['messages'], 'readonly').objectStore('messages').getAll(); q.onsuccess = () => r(q.result); });
    db.close();
    return all.filter(m => m.charId === c).length;
  }, cid);
  await page.evaluate((x) => { const i = document.getElementById('input'); i.value = x; i.dispatchEvent(new Event('input', { bubbles: true })); }, txt);
  await page.click('#btn-send');
  const idle = await waitIdle(page, 15000, 180000);
  const got = await page.evaluate(async (c, n) => {
    const db = await new Promise((res, rej) => { const rq = indexedDB.open('ai-companion'); rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); });
    const all = await new Promise(r => { const q = db.transaction(['messages'], 'readonly').objectStore('messages').getAll(); q.onsuccess = () => r(q.result); });
    const rec = await new Promise(r => { const q = db.transaction(['kv'], 'readonly').objectStore('kv').get('psyche:' + c); q.onsuccess = () => r(q.result); });
    db.close();
    const mine = all.filter(m => m.charId === c).sort((a, b) => a.ts - b.ts).slice(n);
    const inner = (rec && rec.v && rec.v.lastInner) || '';
    return { text: mine.filter(m => m.role === 'assistant').map(m => m.content).join('\n'), inner };
  }, cid, before);
  return { ...got, ended: idle.ended };
}

const CSC = ['我理解', '理解你的', '我明白', '你不用', '建议你', '其实你可以', '没关系', '慢慢来', '别太', '照顾自己', '抱抱', '我在呢', '加油', '辛苦', '不容易', '注意休息', '好好休息'];
const EMO = ['百感交集', '五味杂陈', '说不出', '涌上心头', '心里一紧', '心头一暖', '莫名', '说不清', '有点复杂'];
const FILL = ['那个', '那东西', '某种', '什么的', '之类', '差不多', '那种'];
function hits(s, arr) { let n = 0; for (const w of arr) { let i = 0; while ((i = s.indexOf(w, i)) >= 0) { n++; i += w.length; } } return n; }
function stat(text) {
  const s = String(text || '');
  const sents = s.split(/[。！？!?\n]+/).map(x => x.trim()).filter(Boolean);
  const parens = (s.match(/[（(][^）)]*[）)]/g) || []).length;
  const tail = s.trim().slice(-1);
  return {
    len: s.length, sents: sents.length, parens,
    csc: hits(s, CSC), emo: hits(s, EMO), fill: hits(s, FILL),
    complete: /[。！？~～."'』」）)]/.test(tail) ? 1 : 0,
    avgSent: sents.length ? Math.round(s.length / sents.length) : 0
  };
}
const grams = (s, n = 3) => { const t = String(s || '').replace(/\s+/g, ''); const o = new Set(); for (let i = 0; i + n <= t.length; i++) o.add(t.slice(i, i + n)); return o; };
function overlap(a, b) { const A = grams(a), B = grams(b); if (!A.size || !B.size) return 0; let n = 0; for (const g of A) if (B.has(g)) n++; return Math.round(n / A.size * 100); }

await page.goto('http://127.0.0.1:' + port + '/index.html', { waitUntil: 'networkidle0' });
await sleep(600);

const RUNS = [];
for (const [tag, v2] of [['A', true], ['B', false]]) {
  const cid = 'AB' + tag;
  await seed(cid, v2);
  console.log('');
  console.log('=== ' + tag + ' 组：liveV2=' + v2 + ' ===');
  const rows = [];
  for (let i = 0; i < SAYS.length; i++) {
    const t0 = Date.now();
    const r = await round(cid, SAYS[i]);
    const st = stat(r.text);
    st.sec = ((Date.now() - t0) / 1000).toFixed(1);
    st.overlap = rows.length ? overlap(rows[rows.length - 1].raw, r.text) : 0;
    st.raw = r.text;
    st.inner = r.inner;
    rows.push(st);
    console.log('--- 第 ' + (i + 1) + ' 轮（' + st.sec + 's）他: ' + SAYS[i]);
    console.log('她: ' + r.text.split('\n').filter(Boolean).join(' / '));
    if (r.inner) console.log('（没说出口的）' + r.inner.split('\n').filter(Boolean).join(' / '));
    console.log('  长度 ' + st.len + ' | 句 ' + st.sents + ' | 括号 ' + st.parens + ' | 客服腔 ' + st.csc + ' | 情绪总结 ' + st.emo + ' | 含糊 ' + st.fill + ' | 结尾完整 ' + st.complete + ' | 与上轮三字重合 ' + st.overlap + '%');
  }
  RUNS.push({ tag, v2, rows });
}

const sum = (rows, k) => rows.reduce((a, r) => a + r[k], 0);
const avg = (rows, k) => Math.round(rows.reduce((a, r) => a + r[k], 0) / rows.length * 10) / 10;
console.log('');
console.log('===== 并排（' + SAYS.length + ' 轮合计） =====');
console.log('指标            | v2 开 | v2 关');
const A = RUNS[0].rows, B = RUNS[1].rows;
const line = (n, a, b) => console.log((n + '                ').slice(0, 15) + ' | ' + String(a).padEnd(5) + ' | ' + String(b).padEnd(5));
line('总字数', sum(A, 'len'), sum(B, 'len'));
line('平均字数', avg(A, 'len'), avg(B, 'len'));
line('平均句长', avg(A, 'avgSent'), avg(B, 'avgSent'));
line('括号段总数', sum(A, 'parens'), sum(B, 'parens'));
line('客服腔命中', sum(A, 'csc'), sum(B, 'csc'));
line('情绪总结命中', sum(A, 'emo'), sum(B, 'emo'));
line('含糊指代', sum(A, 'fill'), sum(B, 'fill'));
line('结尾完整句数', sum(A, 'complete'), sum(B, 'complete'));
line('重复上轮%', avg(A, 'overlap'), avg(B, 'overlap'));
console.log('');
console.log('页内异常: ' + errs.length + (errs.length ? ' -> ' + errs.slice(0, 2).join(' | ') : ''));
await browser.close();
server.close();
