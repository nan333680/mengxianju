// e2e-star.mjs —— 心声星号的四种形状（v0.5.4.5）
//
// 起因：0.5.3.4 的取舍是「宁可露出一个星号，也不要把后面半条消息吞进斜体」。
// 用户已经把要求改成另一头：要么渲染成心里话，要么干脆不显示，不能露出裸星号。
// 数据里实际出现过三种：漏写右星号、块级独占一行、以及（还没见过但要兜住的）散落孤星。
//
// 这个套件直接调用 app.js 里的真源码（不是抄一份实现），四种形状 + 三条不许回退的。
import puppeteer from 'puppeteer-core';
import http from 'http'; import fs from 'fs'; import path from 'path';
const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');
const WWW = R + '/www';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8' };
const server = http.createServer((req,res) => {
  let q = decodeURIComponent(req.url.split('?')[0]); if (q==='/') q='/index.html';
  const f = path.join(WWW, q);
  if (!fs.existsSync(f)) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f));
});
await new Promise(r => server.listen(0,'127.0.0.1',r));
const port = server.address().port;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 120000,
  args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
const page = await browser.newPage();
// ⚠️ CI 的 runner 是 en-US，界面默认「跟随系统」。钉成中文，否则英文界面下断言中文文案的地方会红。
await page.evaluateOnNewDocument(() => {
  Object.defineProperty(navigator, 'language', { get: () => 'zh-CN', configurable: true });
  Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh'], configurable: true });
});
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = []; page.on('pageerror', e => errs.push(e.message));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass=0, fail=0;
const t=(n,ok,ex='')=>{ if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));} };

await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
await sleep(900);

// 从真源码里把这几段抠出来跑 —— 断言的必须是产品里那份实现。
const src = await page.evaluate(async () => (await fetch('./js/app.js')).text());
const run = (fn, input) => page.evaluate(({src, fn, input}) => {
  const ESC = 'const esc = (s) => String(s ?? \'\').replace(/[&<>"\']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",\'"\':"&quot;","\\\'":"&#39;"}[c]));';
  const b1 = src.slice(src.indexOf('const INNER_RE'), src.indexOf('function toast('));
  const t1 = src.slice(src.indexOf('function ttsClean'), src.indexOf('/** 读一段字'));
  // eslint-disable-next-line no-new-func
  const f = new Function(ESC + b1 + t1 + '; return { renderBody, ttsClean };');
  return f()[fn](input);
}, {src, fn, input});

// ⚠️ 第一行的**结尾星号不能漏**：漏了它，第一个 * 会和第 3 行那个配成一对，
//    把「主人方才」也一起吃掉 —— 那是测试造错了数据，不是产品错（踩过）。
const BODY_BLOCK = ['*他生我的气，还肯回来给我包腿。*', '主人方才说要罚。我知道不准躲。也不躲了。', '*', '那就罚吧。总得把这一场收下来。', '*'].join('\n');

console.log('=== 一、形态 A：漏写右星号 ===');
const a1 = await run('renderBody', '*他那个东西在响。');
t('整行变成心里话', a1.includes('<em class="inner-thought">') && a1.includes('他那个东西在响。'), a1);
t('不出现裸星号', !a1.includes('*'), a1);

const a2 = await run('renderBody', '*扛不住。他缩成这样，叫扛得住。（纸里那层皮绷着了，往我手上顶。）');
t('带括号的长句也整行变心里话', a2.includes('<em class="inner-thought">') && a2.includes('扛不住'), a2.slice(0, 90));
t('不出现裸星号（形态 A 第二条）', !a2.includes('*'), a2.slice(0, 90));

console.log('=== 二、形态 B：块级独占一行 ===');
const b = await run('renderBody', BODY_BLOCK);
t('中间那段变暗淡', b.includes('<em class="inner-thought">那就罚吧。总得把这一场收下来。</em>'), b);
t('两个孤星号都不见了', !b.includes('*'), b);
t('第一行的行内成对仍然正常', b.includes('<em class="inner-thought">他生我的气，还肯回来给我包腿。</em>'), b.slice(0, 120));
t('两条正常正文没被吞', b.includes('主人方才说要罚'), b);

console.log('=== 三、不许回退的三条 ===');
const ok1 = await run('renderBody', '你好。*正常心声*再见。');
t('正常成对心声仍然渲染', ok1.includes('<em class="inner-thought">正常心声</em>') && ok1.includes('你好。'), ok1);

// v0.5.5：双星号按「她的意图」渲染成心里话，不是加粗、也不是删记号。
// ⚠️ 这条在 v0.5.5 之前测的是反的（断言「不是心里话」），而当时的实现是把记号吃掉、
//    内容留成普通文字 —— 断言绿、行为错。
const ok2 = await run('renderBody', '**加粗**');
t('双星号按心里话渲染', ok2.includes('<em class="inner-thought">加粗</em>'), ok2);

// v0.5.5：括号里不解析星号。
// ⚠️ 原来那两条都是假通过：`!includes('*')` 在「被吃成 <em>」之后照样成立，
//    而 `!startsWith('<em')` 永远成立 —— 颜文字前面永远有个 '('。
const ok3 = await run('renderBody', '(*/ω＼*)');
t('颜文字原样保留', ok3 === '(*/ω＼*)', ok3);
t('颜文字没被包成心里话', !ok3.includes('inner-thought'), ok3);

// 真实中招的那三个之一（KAOMOJI_MOODS 里成对半角星的 3 条：(*^ω^*) (*´ω｀*) (*｀ω´*)）
const ok4 = await run('renderBody', '(*^ω^*)');
t('成对星号的颜文字不被吃', ok4 === '(*^ω^*)', ok4);

// 洞一：独占一行的 ** 包多行 —— 记号不会被吃、内容要变暗
const ok5 = await run('renderBody', '**\n多行\n**');
t('块级双星号变心里话', ok5.includes('<em class="inner-thought">多行</em>'), ok5);

// 洞二：跨行括号里的星号不能被当心里话
const ok6 = await run('renderBody', '（她笑了 *嗯*\n然后又哭了）');
t('跨行括号里的星号不动', ok6.includes('*嗯*'), ok6);
t('跨行括号里没被包成心里话', !ok6.includes('inner-thought'), ok6);

console.log('=== 四、朗读：这两种形状不能念出来 ===');
const s1 = await run('ttsClean', '*他那个东西在响。');
t('漏写右星号那段不念', !s1.includes('他那个东西在响'), JSON.stringify(s1));

const s2 = await run('ttsClean', BODY_BLOCK);
t('块级中间那段不念', !s2.includes('那就罚吧'), JSON.stringify(s2));
t('块级外的正文照念', s2.includes('主人方才说要罚'), JSON.stringify(s2));

const s3 = await run('ttsClean', '你好。*正常心声*再见。');
t('正常成对心声也不念', !s3.includes('正常心声') && s3.includes('你好'), JSON.stringify(s3));

console.log('=== 五、群聊名字标记：念之前要剥掉，但不许碰正文 ===');
// 12073 那一支：认不出名字时整行原样留下，标记在行首
const g1 = await run('ttsClean', '【阿芙】今天怎么样');
t('名字标记不念', !g1.includes('阿芙'), JSON.stringify(g1));
t('标记后面的内容照念', g1.includes('今天怎么样'), JSON.stringify(g1));

// 两个 piece 用 \n 拼进来（8433 的 join），第二个标记也要剥
const g2 = await run('ttsClean', '你好。\n【阿芙】今天怎么样');
t('第二段的名字标记也剥', !g2.includes('阿芙'), JSON.stringify(g2));

// 只剥行首：正文中间偶然出现的【】必须留着（这是不选全局剥的理由）
const g3 = await run('ttsClean', '她说【笑】然后就走了。');
t('正文中间的【】保留', g3.includes('【笑】'), JSON.stringify(g3));

t('无未捕获报错', errs.length === 0, errs.slice(0,2).join(' | '));
console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
