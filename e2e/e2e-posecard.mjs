// e2e-posecard.mjs — 状态卡片（0.5.8.10）端到端回归
//
// 这一版治的是「细节丢」：眼镜摘下放桌上 → 五轮之后只剩「摘下」；
// 咲夜把换洗的衣物放在门口 → 十五轮之后她还在为「没干净衣服」发愁。
// 实证：那段 119 轮里，信息一直在上下文里（28,803 token / 80,000 预算，一条没被裁），
// 她自己甚至写过「门外的走廊有了响动…是布料叠起来搁下的声音」，十五轮后还是没接上。
// 所以这不是「记不住」，是「没连上」—— 要的是每轮都在、槽位固定的一行。
//
// 本套件盯的是它最容易坏、且坏了【不报错】的地方：
//   1) 归一化：模型不照格式写（半角竖线 / 乱序 / 带前言 / 跨行）时还能不能收成五槽
//      —— 收不了就该返回空串（这一轮不注入），绝不能把半句塞进提示词
//   2) 它【不挂 liveV2】—— 「角色怎么想」关着的时候正是它最该在的时候
//   3) 唯一写 'pose:<charId>' 的是它，判断层不写（两边都写 = 互相覆盖，每覆盖一次就缩一次）
//   4) 失败要【看得见】（「这一轮没记成」），否则用户会把"请求超时"读成"她又忘了"
//   5) 失败【不覆盖】旧值（旧值下一轮还能当继承源），但注入侧也【不拿旧值顶】
//   6) 上一轮那行要进输入（继承源）—— 不给的话它每轮从历史重猜，跨轮就断了
import puppeteer from 'puppeteer-core';
import http from 'http'; import fs from 'fs'; import path from 'path';
import { readCode } from './e2e-src.mjs';
import { normalizePose, poseAsk, POSE_LABEL, POSE_SEP, POSE_MAX_LEN } from '../www/js/posecard.js';

const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');
const WWW = R + '/www';
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
// ⚠️ 调试开关：SLOW=1 把 CPU 降速，模拟 CI 的 windows-latest。
//   这套在 CI 里连红两次、本地怎么跑都是 77/77 —— 以后遇到「本地绿、CI 红」，
//   先 SLOW=1 跑一遍，能复现就在本地调，别靠推一版等二十分钟。
if (process.env.SLOW) {
  const rate = Number(process.env.SLOW) > 1 ? Number(process.env.SLOW) : 6;
  await page.emulateCPUThrottling(rate).catch(() => { /* 老版本 puppeteer 没这个方法就算了 */ });
  console.log('   [SLOW] CPU 降速 x' + rate);
}
const sleep = ms => new Promise(r=>setTimeout(r,ms));
let pass=0, fail=0;
const t=(n,ok,ex='')=>{ if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));} };

// 卡片那趟的识别标记：poseAsk 的指令里独有的一句。
// ⚠️ 不能用 stream 区分 —— 判断层、独白也是非流式；而正文是流式。
const POSE_MARK = '只记一样东西';
const NL = String.fromCharCode(10);
const POSE_REPLY = [
  '在哪：地下室这间屋，床沿｜姿势：坐着，腿搭在床边｜手里：空着',
  '｜身上：一件皱了的纯白睡裙，袜子剩一只｜身边：门口台阶上搁着咲夜送来的两叠换洗衣裳'
].join(NL);

let poseReqs = 0, mainReqs = 0;
let lastPoseIn = '', lastMainSys = '';
let poseMode = 'ok';          // 'ok' | 'junk'（用来测失败态）
await page.setRequestInterception(true);
page.on('request', req => {
  const u = req.url();
  if (u.includes('deepseek') || u.includes('/chat/completions')) {
    if (req.method()==='OPTIONS') { req.respond({status:204,headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'*'}}); return; }
    let b = {};
    try { b = JSON.parse(req.postData()||'{}'); } catch { b = {}; }
    const joined = (b.messages||[]).map(m=>m.content||'').join(NL);
    if (joined.includes(POSE_MARK)) {
      poseReqs++; lastPoseIn = joined;
      const body = poseMode === 'junk' ? '好的，我记一下。' : POSE_REPLY;
      req.respond({status:200,headers:{'Access-Control-Allow-Origin':'*'},contentType:'application/json',
        body:JSON.stringify({choices:[{message:{content:body}}]})}); return;
    }
    mainReqs++; lastMainSys = joined;
    if (b.stream) {
      const pl='data: '+JSON.stringify({choices:[{delta:{content:'好。'}}]})+NL+NL+'data: [DONE]'+NL+NL;
      req.respond({status:200,headers:{'Access-Control-Allow-Origin':'*'},contentType:'text/event-stream',body:pl}); return;
    }
    req.respond({status:200,headers:{'Access-Control-Allow-Origin':'*'},contentType:'application/json',body:JSON.stringify({choices:[{message:{content:'{}'}}]})}); return;
  }
  req.continue();
});

const putDB = (store, rec) => page.evaluate(async (s, r2) => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => o.onsuccess = () => r(o.result));
  await new Promise(r => { const tx = db.transaction(s,'readwrite'); tx.objectStore(s).put(r2); tx.oncomplete = r; });
  db.close();
}, store, rec);
const getDB = (store, key) => page.evaluate(async (s, k) => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => o.onsuccess = () => r(o.result));
  const v = await new Promise(r => { const q = db.transaction(s).objectStore(s).get(k); q.onsuccess = () => r(q.result); });
  db.close(); return v || null;
}, store, key);
const allMsgs = () => page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => o.onsuccess = () => r(o.result));
  const v = await new Promise(r => { const q = db.transaction('messages').objectStore('messages').getAll(); q.onsuccess = () => r(q.result||[]); });
  db.close(); return v;
});
// 等【条件】，不等时间。CI 的 windows-latest 比本地慢好几倍，
// 第一版这里全是固定 sleep —— 本地 77/77、CI 直接红（e2e-posecard 退出码 1），
// 查了半小时没有日志可看（job 日志要 admin 权限）。以后新套件别写死 sleep。
const waitFor = (fn, ms = 15000, ...args) => page.waitForFunction(fn, { timeout: ms }, ...args).catch(() => null);
const msgCount = () => page.evaluate(() => document.querySelectorAll('#messages .msg').length);
const gotoChar = async (name) => {
  await waitFor(() => !!document.querySelector('#char-list .char-card'));
  // ⚠️ 找不到角色就直接抛，不要 if (c) 静默跳过 —— 静默跳过之后所有断言都会红，
  //    但红在别处，看起来像"功能坏了"。
  const ok = await page.evaluate((n) => {
    const c = [...document.querySelectorAll('#char-list .char-card')].find(x => x.textContent.includes(n));
    if (!c) return false;
    c.click(); return true;
  }, name);
  if (!ok) throw new Error('找不到角色卡：' + name);
  await waitFor(() => { const v = document.getElementById('view-chat'); return v && v.classList.contains('active'); });
  await waitFor(() => !!document.getElementById('input'));
  await sleep(250);
};
const typeText = (s) => page.evaluate((x) => { const i=document.getElementById('input'); i.value=x; i.dispatchEvent(new Event('input',{bubbles:true})); }, s);
// 发一句 + 等这一轮真的结束。
// 判据不是"转圈圈停了"（CI 上它可能在两次请求的间隙里短暂不转），
// 而是【消息数多出两条】（他的 + 她的）且按钮不再处于停止态。
const sendOne = async (txt) => {
  const n0 = await msgCount();
  await typeText(txt);
  await sleep(150);
  await page.evaluate(() => document.getElementById('btn-send').click());
  for (let i = 0; i < 150; i++) {
    await sleep(300);
    const n = await msgCount();
    const busy = await page.$eval('#btn-stop', e => !e.classList.contains('hidden')).catch(() => false);
    if (n >= n0 + 2 && !busy) break;
  }
  await sleep(700);
};

await page.goto('http://127.0.0.1:'+port+'/index.html', { waitUntil:'networkidle0' });
await sleep(900);

console.log('=== 1. 模块本身：参数、护栏、出口（源码契约）===');
{
  const pc = readCode(WWW + '/js/posecard.js');
  t('posecard.js 导出 runPose / normalizePose / poseAsk',
    pc.includes('export async function runPose') && pc.includes('export function normalizePose') && pc.includes('export function poseAsk'));
  t('输出上限 260（五槽约 100 字，留余量）', pc.includes('const POSE_MAX_TOKENS = 260'));
  t('关思考用 noThink，不是 reasoningEffort', pc.includes('noThink: true') && !pc.includes('reasoningEffort'));
  t('低温 0.2：这一趟是抄写，不是发挥', pc.includes('temperature: 0.2'));
  t('超时 6000：和正文并行，绝不能拖慢正文', pc.includes('timeoutMs: 6000'));
  t('读 8 条历史（和判断层/独白同一个数）', pc.includes('const POSE_N = 8'));
  t('提示词要求「身边」那一项写清是谁的、搁在哪儿',
    pc.includes('「身边」这一项最容易漏') && pc.includes('写清是谁的、搁在哪儿'));
  t('提示词禁止写情绪/打算/台词（只记画面）', pc.includes('不写情绪、不写打算、不写台词'));
  t('保险丝：明确写了变了才改，没提就照抄',
    pc.includes('【明确写了】这一槽变了') && pc.includes('【没提】这一槽，就照抄'));
  t('保险丝：上一轮有、这一轮没提到的要留着', pc.includes('留着，不要删'));
  t('至少两槽才算记成（一槽 = 返回空串）', pc.includes('if (filled < 2) return'));
  t('超长时整槽丢掉，不砍半句', pc.includes('if (out.length && len + add > maxLen) continue;'));
  t('槽内超长按标点收尾（cutSlot）', pc.includes('function cutSlot'));
  t('上一轮那行进输入（继承源）', pc.includes('（上一轮记下的：') && pc.includes('这是第一次记'));
}

console.log('');
console.log('=== 2. 归一化：模型不照格式写也得收得住（直接跑函数）===');
{
  // 第 1 节那个 pc 是块作用域里的，这一节要用得重新读（别改成共享全局，免得串味）。
  const pc = readCode(WWW + '/js/posecard.js');
  const std = '在哪：地下室这间屋，床沿｜姿势：坐着，腿搭在床边｜手里：空着｜身上：一件皱了的纯白睡裙，袜子剩一只｜身边：门口台阶上搁着咲夜送来的两叠换洗衣裳';
  const r1 = normalizePose(std);
  const seg1 = r1.split(POSE_SEP);
  t('标准五槽：五个标签齐全、顺序不变',
    seg1.length === 5 && POSE_LABEL.every((lb, i) => seg1[i].startsWith(lb + '：')), r1);
  t('标准五槽：长度在 100 以内', r1.length <= POSE_MAX_LEN, r1.length);

  const r2 = normalizePose('在哪:床沿 | 姿势:坐着 | 手里:空着 | 身上:睡裙 | 身边:门口两叠衣裳');
  t('半角竖线 + 半角冒号也认', r2.startsWith('在哪：床沿') && r2.includes('身边：门口两叠衣裳'), r2);

  const r3 = normalizePose('床沿｜坐着｜空着｜白睡裙｜门口两叠衣裳');
  t('完全没标签时按顺序落座', r3 === '在哪：床沿｜姿势：坐着｜手里：空着｜身上：白睡裙｜身边：门口两叠衣裳', r3);

  const r4 = normalizePose('好的，我记一下：' + NL + '在哪：床沿｜姿势：坐着｜手里：空着｜身上：睡裙｜身边：门口两叠衣裳');
  t('有开场白也不吃进第一个槽', r4.startsWith('在哪：床沿'), r4);

  const r5 = normalizePose('去哪：床沿｜姿态：坐着｜手上：空着｜穿着：睡裙｜旁边：门口两叠衣裳');
  t('模型的同义标签能归位（去哪/姿态/手上/穿着/旁边）',
    r5 === '在哪：床沿｜姿势：坐着｜手里：空着｜身上：睡裙｜身边：门口两叠衣裳', r5);

  const r6 = normalizePose('身边：门口两叠衣裳｜在哪：床沿｜身上：睡裙｜姿势：坐着｜手里：空着');
  t('标签乱序也能排回标准顺序', r6 === '在哪：床沿｜姿势：坐着｜手里：空着｜身上：睡裙｜身边：门口两叠衣裳', r6);

  const r7 = normalizePose('在哪：床沿｜姿势：坐着' + NL + '手里：空着｜身上：睡裙｜身边：门口两叠衣裳');
  t('跨行输出能拼起来', r7.split(POSE_SEP).length === 5, r7);

  t('只有一槽 → 空串（这一轮不注入，而不是塞半句）', normalizePose('在哪：床沿') === '');
  t('全是废话 → 空串', normalizePose('好的，我知道了。') === '');
  t('空输入 → 空串', normalizePose('') === '');

  const r11 = normalizePose('在哪：地下室这间屋的床沿边上｜姿势：坐着，两条腿都搭在床沿外头｜手里：空着没拿东西｜身上：一件皱了的纯白睡裙｜身边：门口台阶上搁着咲夜送来的两叠换洗衣裳，一叠她的，一叠是他的');
  t('超长时槽内按标点收尾，不切在字中间',
    r11.includes('身边：') && !/[，、；]$/.test(r11) && r11.length <= POSE_MAX_LEN, r11);

  const ask = poseAsk({ prev: '在哪：沙发｜姿势：坐着' });
  t('指令里带着上一轮那行（继承源）', ask.includes('在哪：沙发｜姿势：坐着'));
  t('没有上一轮时明说「第一次记」', poseAsk({}).includes('这是第一次记'));
  // ⚠️ v0.5.8.10 修：第一版把指令拼成一条 user 消息，等于把「只回一行五个槽」
  //    当成对话里的下一句，模型可能顺着接话。现在它必须是 system。
  t('指令单独一条 system，不是塞在 user 里',
    pc.includes("msgs.push({ role: 'system', content: poseAsk({ prev }) })")
    && !pc.includes("msgs.push({ role: 'user', content: poseAsk("));
  t('他这一轮的话仍然是独立的 user 消息',
    pc.includes("if (ut) msgs.push({ role: 'user', content: ut });"));
}

console.log('');
console.log('=== 3. app.js 接线：不挂 v2、唯一写者、来源可查（源码契约）===');
{
  const app = readCode(WWW + '/js/app.js');
  t('import 了 runPose', app.includes("import { runPose } from './posecard.js'"));
  t('开关判空写成 !== false（老库里没这个键要当开）', app.includes('const poseOn = S.poseCard !== false && !!S.apiKey'));
  t('★ 开关不挂 LIVE（v2 关着也跑）', !/poseOn\s*=\s*LIVE\s*&&/.test(app) && !app.includes('LIVE && S.poseCard'));
  // 建 promise 的位置相对「判断块」的位置：必须在前（并行），await 必须在后。
  const iP = app.indexOf('const posePromise = poseOn');
  const iL = app.indexOf('if (LIVE && S.apiKey) {', Math.max(0, iP - 20000));
  t('★ promise 建在 liveV2 判断块【之前】（并行，不是串行）', iP > 0 && iL > iP, { iP, iL });
  const iA = app.indexOf('poseCard = String(await posePromise');
  t('结果在判断块【之后】才 await（真并行）', iA > iL && iL > 0, { iA, iL });
  const setN = (app.match(/kv\.set\(poseKey/g) || []).length;
  t('★ 只有状态卡片写 pose 库（判断层不写，避免互相覆盖）', setN === 1, setN);
  // ⚠️ 这里不能用注释文本当断言：readCode 会把注释剥掉（e2e-src.mjs 的设计），
  //    「0.5.8.10 起【不写了】」在注释里，读出来是空的。只认代码。
  t('判断层那段里 nowPose 已经删干净（没有写库代码）',
    !app.includes('if (nowPose) await kv.set(poseKey') && !app.includes('nowPose'));
  t('★ 注入优先级：卡片 > 判断层 now', app.includes("pose: poseCard || ((LIVE && psyDir && psyDir.now) ? psyDir.now : '')"));
  t('卡片没记成时【不覆盖】旧值（写库在 else 里）',
    /if \(!poseCard\) poseCardFail = true;[\s\S]{0,220}else \{[\s\S]{0,220}kv\.set\(poseKey/.test(app));
  t('turnInj 记了来源（card / now）', app.includes("poseSrc: poseCard ? 'card' :"));
  t('turnInj 记了失败标记', app.includes('poseFail: !!(poseOn && poseCardFail)'));
  t('turnInj 里的 pose 没被 _cut 截断（要能核对五槽齐不齐）', !app.includes('pose: _cut('));
  t('失败态在检查器里说得出来（「不是她忘了」）', app.includes('不是她忘了'));
  // ⚠️ index.html 不能用 readCode 读：它是按 JS 词法剥注释的，HTML 里的 // 和 <!-- --> 会被误删。
  t('设置页有开关 #s-posecard', fs.readFileSync(WWW + '/index.html', 'utf8').includes('id="s-posecard"'));
}

console.log('');
console.log('=== 4. 判断层的危险授权改掉了（源码契约）===');
{
  const dir = readCode(WWW + '/js/director.js');
  t('poseBlock 标题改成「上一轮记下的样子」（不止是位置）', dir.includes('# 上一轮记下的样子'));
  t('★ 旧措辞「聊天记录里已经动过了，就以聊天记录为准，改过来」已消失',
    !dir.includes('聊天记录里已经动过了，就以聊天记录为准'));
  t('新措辞：明确写了变了才改', dir.includes('【明确写了】某一项变了'));
  t('新措辞：没提到的照抄，别顺手清掉',
    dir.includes('【没提】到的，原样照抄') && dir.includes('不要顺手清掉'));
  t('新措辞点破「你没看到不等于没发生」', dir.includes('你没看到不等于没发生'));
}

console.log('');
console.log('=== 5. 正文侧注入段（源码契约）===');
{
  const per = readCode(WWW + '/js/persona.js');
  t('标题改成「你这会儿的样子」', per.includes('# 你这会儿的样子'));
  t('旧标题「# 你现在在哪」不再作为注入标题', !per.includes("parts.push('# 你现在在哪"));
  t('措辞堵住「报菜名」（不要一件件报出来）', per.includes('不要一件件报出来'));
  t('措辞说明「该用到的时候它自己会出现」', per.includes('该用到的时候它自己会出现'));
  t('措辞允许作废已过时的项（就当它不在）', per.includes('就当它不在'));
  t('仍然不交代来路（不写「我本来在…」）', per.includes('也不要说「我本来在…」'));
}

console.log('');
console.log('=== 6. 真机路径：v2 关着也发这一趟，五槽进正文 ===');
await putDB('characters', { id:'c-pose', name:'状态测试', avatar:null, greeting:'（她抬眼看你）',
  persona:'你是一个测试角色，说话简短。', createdAt:Date.now(),
  longMemory:false, splitMessages:false });
{
  const st = await getDB('kv', 'settings') || { k:'settings', v:{} };
  st.v = st.v || {};
  st.v.apiKey = 'sk-test';
  st.v.baseUrl = 'https://api.deepseek.com';
  // ★ 关键：把「角色怎么想」关掉 —— 实测用户就是关着的（1253 条注入快照里 pose 非空 0 条）。
  //   状态卡片必须在这种机器上照样工作，这正是它存在的理由。
  st.v.liveV2 = false;
  st.v.poseCard = true;
  await putDB('kv', st);
}
await page.reload({ waitUntil:'networkidle0' }); await sleep(1200);
await gotoChar('状态测试');
poseReqs = 0; mainReqs = 0; lastPoseIn = ''; lastMainSys = '';
await sendOne('咲夜把换洗的衣物放在门口外面，没有进去过。');
{
  t('★ liveV2 关着照样发这一趟（它不挂判断层）', poseReqs === 1, poseReqs);
  t('卡片输入里带着他这一轮的话', lastPoseIn.includes('咲夜把换洗的衣物放在门口外面'), lastPoseIn.slice(0, 120));
  t('★ 五槽进了正文提示词', lastMainSys.includes('# 你这会儿的样子'), '');
  t('正文里能看到「身边」那一槽（最容易丢的那项）',
    lastMainSys.includes('门口台阶上搁着咲夜送来的两叠换洗衣裳'), '');
  const kvp = await getDB('kv', 'pose:c-pose');
  t('★ 结果落库到 pose:<charId>（下一轮的继承源）',
    !!(kvp && kvp.v && String(kvp.v.text).includes('身边：')), JSON.stringify(kvp && kvp.v));
  const ms = await allMsgs();
  const ai = ms.filter(m => m.charId === 'c-pose' && m.role === 'assistant' && m.inj).pop();
  t('turnInj 记了 pose 五槽', !!(ai && ai.inj.pose && ai.inj.pose.includes('身边：')), ai && ai.inj.pose);
  t('turnInj 标了来源是卡片', !!(ai && ai.inj.poseSrc === 'card'), ai && ai.inj.poseSrc);
  t('这一轮没标失败', !!(ai && ai.inj.poseFail === false), ai && String(ai.inj.poseFail));
}

console.log('');
console.log('--- 长按 →「这一轮用了什么」要能看到那五槽 ---');
await page.evaluate(() => {
  const els = document.querySelectorAll('#messages .msg');
  const el = els[els.length - 1];
  el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
});
await page.waitForFunction(() => !!document.querySelector('.msg-menu'), { timeout: 8000 }).catch(() => {});
await sleep(300);
await page.evaluate(() => { const m = document.querySelector('.msg-menu [data-more]'); if (m) m.click(); });
await sleep(300);
await page.evaluate(() => { const b = [...document.querySelectorAll('.msg-menu button')].find(x => x.textContent.indexOf('这一轮用了什么') >= 0); if (b) b.click(); });
await page.waitForFunction(() => { const m = document.getElementById('modal'); return m && !m.classList.contains('hidden'); }, { timeout: 8000 }).catch(() => {});
await sleep(400);
{
  const txt = await page.evaluate(() => { const b = document.getElementById('modal-text'); return b ? b.textContent : ''; });
  t('检查器里有「角色此刻」那一格', txt.indexOf('角色此刻') >= 0, txt.slice(0, 120));
  t('检查器里显示的是五槽（不是 40 字那句）', txt.indexOf('身边：') >= 0, txt.slice(0, 300));
  await page.evaluate(() => { const b = document.getElementById('modal-ok'); if (b) b.click(); });
  await sleep(300);
}

console.log('');
console.log('=== 7. 继承源 + 失败态 ===');
poseReqs = 0; lastPoseIn = '';
await sendOne('还没睡醒，她已经醒了。');
{
  t('第二趟卡片请求带着上一轮那行（继承源）',
    lastPoseIn.includes('上一轮记下的') && lastPoseIn.includes('门口台阶上搁着咲夜送来的两叠换洗衣裳'), lastPoseIn.slice(-400));
}
const poseBefore = await getDB('kv', 'pose:c-pose');
poseMode = 'junk';
poseReqs = 0; lastMainSys = '';
await sendOne('你要去洗澡吗。');
{
  t('卡片返回废话时仍发起了请求（不是没跑）', poseReqs === 1, poseReqs);
  t('★ 失败时正文里【没有】这一段（不拿旧值顶，也不塞废话）',
    !lastMainSys.includes('# 你这会儿的样子'), '');
  const ms = await allMsgs();
  const ai = ms.filter(m => m.charId === 'c-pose' && m.role === 'assistant' && m.inj).pop();
  t('★ turnInj 标了这一轮没记成', !!(ai && ai.inj.poseFail === true), ai && String(ai.inj.poseFail));
  t('失败时 pose 那格是空的（不是旧值）', !!(ai && !ai.inj.pose), ai && ai.inj.pose);
  const kvAfter = await getDB('kv', 'pose:c-pose');
  t('★ 失败【不覆盖】旧值（下一轮还能当继承源）',
    !!(kvAfter && String(kvAfter.v && kvAfter.v.text) === String(poseBefore.v && poseBefore.v.text)), JSON.stringify(kvAfter && kvAfter.v).slice(0, 120));
}

console.log('');
console.log('--- 失败那一轮，检查器要说出「这一轮没记成」---');
await page.evaluate(() => {
  const els = document.querySelectorAll('#messages .msg');
  const el = els[els.length - 1];
  el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
});
await page.waitForFunction(() => !!document.querySelector('.msg-menu'), { timeout: 8000 }).catch(() => {});
await sleep(300);
await page.evaluate(() => { const m = document.querySelector('.msg-menu [data-more]'); if (m) m.click(); });
await sleep(300);
await page.evaluate(() => { const b = [...document.querySelectorAll('.msg-menu button')].find(x => x.textContent.indexOf('这一轮用了什么') >= 0); if (b) b.click(); });
await page.waitForFunction(() => { const m = document.getElementById('modal'); return m && !m.classList.contains('hidden'); }, { timeout: 8000 }).catch(() => {});
await sleep(400);
{
  const txt = await page.evaluate(() => { const b = document.getElementById('modal-text'); return b ? b.textContent : ''; });
  t('★ 检查器明说「这一轮没记成」（不是让她背锅）', txt.indexOf('这一轮没记成') >= 0, txt.slice(0, 200));
  t('并且说清「不是她忘了」', txt.indexOf('不是她忘了') >= 0, '');
  await page.evaluate(() => { const b = document.getElementById('modal-ok'); if (b) b.click(); });
  await sleep(300);
}

console.log('');
console.log('=== 8. 开关：关掉就真的不跑 ===');
{
  // ⚠️ 设置页必须从【抽屉】进：btn-settings 只调 openDrawer()，
  //    bindSettings() 是点抽屉里 data-wb-drawer="settings" 那一项才跑的。
  //    直接点 btn-settings 读到的是 HTML 默认值（全部 unchecked）——
  //    这会造出两种假结论：「默认是关的」和「关掉也没用」。这一条踩过。
  await page.evaluate(() => document.getElementById('btn-settings').click());
  // 抽屉是渲染出来的，不是一开就有 —— 等它出现，别赌 450 毫秒。
  await waitFor(() => !!document.querySelector('[data-wb-drawer="settings"]'));
  const openedSettings = await page.evaluate(() => {
    const b = document.querySelector('[data-wb-drawer="settings"]');
    if (!b) return false;
    b.click(); return true;
  });
  if (!openedSettings) throw new Error('抽屉里没有 data-wb-drawer="settings" 这一项');
  // ⚠️ 等【设置视图真的切过去】，不能等 #s-posecard 存在 ——
  //    那个 input 从一开始就在 DOM 里（index.html 静态的），
  //    等它等于没等，读到的还是 bindSettings() 跑之前的 HTML 默认值。
  await waitFor(() => { const v = document.getElementById('view-settings'); return v && v.classList.contains('active'); });
  await sleep(400);
  const box = await page.evaluate(() => {
    const el = document.getElementById('s-posecard');
    return { exists: !!el, checked: el ? el.checked : null };
  });
  t('设置页有「记住东西在哪」这一栏的开关', box.exists, JSON.stringify(box));
  t('默认是开的（老库里没这个键也当开）', box.checked === true, JSON.stringify(box));
  // 关掉
  await page.evaluate(() => {
    const el = document.getElementById('s-posecard');
    if (el) { el.checked = false; el.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  await sleep(600);
  // 关掉开关之后整页重载，回到聊天列表 —— 比找返回按钮稳。
  await page.reload({ waitUntil:'networkidle0' }); await sleep(1200);
  await gotoChar('状态测试');
  poseReqs = 0;
  await sendOne('关掉开关之后这一条。');
  t('★ 关掉之后不再发这一趟', poseReqs === 0, poseReqs);
}

console.log('');
const realErrs = errs.filter(e => !/favicon|ResizeObserver/i.test(e));
t('全程没有页面级 JS 报错', realErrs.length === 0, realErrs.slice(0, 2).join(' | '));

console.log('');
console.log('汇总: 通过 ' + pass + ' / 失败 ' + fail + ' / 共 ' + (pass+fail) + ' 项');
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
