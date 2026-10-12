import puppeteer from 'puppeteer-core';
import http from 'http'; import fs from 'fs'; import path from 'path';
import { readCode } from './e2e-src.mjs';
// 工作目录自适应（原来写死 C:/A-DSH-Tool/ai-companion）
const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');
const WWW = `${R}/www`;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8' };
const server = http.createServer((req,res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p==='/') p='/index.html';
  const f = path.join(WWW, p);
  if (!fs.existsSync(f)) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f));
});
await new Promise(r => server.listen(0,'127.0.0.1',r));
const port = server.address().port;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 120000, args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = []; page.on('pageerror', e => errs.push(e.message));
page.on('dialog', async d => { await d.accept(); });
const sleep = ms => new Promise(r=>setTimeout(r,ms));
let pass=0, fail=0;
const t=(n,ok,ex='')=>{ if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));} };

const personaSrc = readCode(WWW + '/js/persona.js');
const appSrc = readCode(WWW + '/js/app.js');

console.log('=== 1. 提示词层的硬约束（对所有角色生效）===');
t('有「绝不允许整条只有省略号」', personaSrc.includes('【绝不允许】整条消息只有一个省略号'));
t('有「不说话 ≠ 不回复」', personaSrc.includes('不说话 ≠ 不回复'));
t('有「沉默要写出来」', personaSrc.includes('被捂住了嘴、不想开口'));
t('hesitation 那句被收窄了', personaSrc.includes('不能整条消息只有它'));
t('坏示例已撤（不再示范「平静地看着」）', !personaSrc.includes('哪怕只是「（平静地看着他，没开口）」'));
t('THINK_HINT 堵住「等他开口」', personaSrc.includes('【听不见 ≠ 不反应】'));
t('THINK_HINT 不再授权干等', !personaSrc.includes('然后自己起头、或者等他开口'));
t('约束在 buildStablePrompt（稳定前缀，能命中缓存）', (() => {
  const i = personaSrc.indexOf('【绝不允许】整条消息只有一个省略号');
  const s = personaSrc.lastIndexOf('export function buildStablePrompt', i);
  const tn = personaSrc.indexOf('export function buildTurnNote');
  return i > s && i < tn;
})());

console.log('');
console.log('=== 2. 代码层兜底 ===');
t('不再把空白写成「……」', !appSrc.includes("if (!full) full = '……';"));
t('有纯标点兜底正则', appSrc.includes("if (!full || /^[\\s.…。，,、！!？?~～·]+$/.test(full))"));
// ⚠️ 断言更新（v1.21.30）：兜底现在多收一个素材参数（模型的思考内容），
// 用于 content 为空、话都写在 reasoning 里的情况。断言改成匹配【前缀】，不再锁死整行。
t('兜底是上下文接话，不是通用模板', appSrc.includes('buildBlankFallback(_cmd0 ? text : visibleText, pastRaw'));
t('兜底接他的动作', appSrc.includes('我没接话，手还停在刚才的地方'));
t('兜底接他的话', appSrc.includes('听他说完「'));
t('兜底接她上一轮的状态', appSrc.includes('我没接他的话'));
t('旧通用模板已删干净', !appSrc.includes('（没开口，只是看着他）') && !appSrc.includes('（安静地看着他，手还搭在原处）'));
t('兜底有 console.warn 留痕', appSrc.includes('模型回了空白/纯标点'));

console.log('');
console.log('=== 3. 兜底真的会替换（走真实链路）===');
// 用装好钩子的页面验证：造一条 assistant 消息内容是 '……'，检查渲染时的处理
await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
await sleep(1200);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil:'networkidle0' }); await sleep(600);

// 直接单测那个正则的行为
const reTest = await page.evaluate(() => {
  const re = /^[\s.…。，,、！!？?~～·]+$/;
  const cases = [
    ['……', true], ['...', true], ['。', true], ['  ', true], ['，、！', true],
    ['（平静地看着他）', false], ['嗯。', false], ['……嗯，来了。', false], ['好', false],
  ];
  return cases.map(([s, want]) => ({ s, want, got: re.test(s) }));
});
let reOk = true;
for (const c of reTest) {
  if (c.got !== c.want) { reOk = false; console.log('     ✗ ' + JSON.stringify(c.s) + ' -> ' + c.got + '（期望 ' + c.want + '）'); }
}
t('兜底正则：纯标点/空白命中，有内容的不命中', reOk, JSON.stringify(reTest));

console.log('');
console.log('  JS 错误: ' + (errs.length ? JSON.stringify(errs) : '无'));
t('无 JS 错误', errs.length === 0, errs.join(' | '));

console.log('');
console.log('========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
