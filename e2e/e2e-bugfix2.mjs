import puppeteer from 'puppeteer-core';
import { seedChar, seedChars } from './e2e-helper.mjs';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { readCode } from './e2e-src.mjs';
// 工作目录自适应（原来写死 C:/A-DSH-Tool/ai-companion）
const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');

const WWW = `${R}/www`;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8' };

// 同一个服务器既发静态文件，又当 DeepSeek 的假端点 —— 同源，省掉 CORS 麻烦。
// /api/chat/completions 返回一段会「卡住」的 SSE 流，好让测试在中途点停止。
let sseStarted = 0;
let failMode = false;   // 打开后 /api/chat/completions 一律回 500
let holdOpen = false;   // 打开后流只吐几段就挂着不结束（用来测「点停止」）
const server = http.createServer((req,res) => {
  if (req.url.startsWith('/api/chat/completions')) {
    // 活人感 v2：这一轮先跑独白/判断（非流式），再流式出三条候选。
    // holdOpen 只该挂住【正文】那条流 —— 把辅助请求也挂住的话，1.4 秒时正文根本没开始，
    // 点「停止」时手上没有半截可留，第 7 段测的就不是「中断的那半截」了。
    let _raw = '';
    req.on('data', c => { _raw += c; });
    req.on('end', () => { _chat(req, res, _raw); });
    return;
  }
  let p = decodeURIComponent(req.url.split('?')[0]); if (p==='/') p='/index.html';
  const f = path.join(WWW, p);
  if (!fs.existsSync(f)) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f));
});
const _chat = (req, res, _raw) => {
  {
    let _b = null;
    try { _b = JSON.parse(_raw || '{}'); } catch { _b = null; }
    if (_b && _b.stream === false) {
      // 辅助请求（独白/判断/评审）：立刻回一个空的 JSON，别把它挂住。
      res.writeHead(200, { 'Content-Type':'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '{}' } }] }));
      return;
    }
    if (failMode) {
      res.writeHead(500, { 'Content-Type':'application/json' });
      res.end(JSON.stringify({ error: { message: '模拟失败(测试用)' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type':'text/event-stream', 'Cache-Control':'no-cache', 'Connection':'keep-alive' });
    sseStarted++;
    const send = (txt) => res.write('data: ' + JSON.stringify({ choices:[{ delta:{ content: txt } }] }) + '\n\n');
    send('第一段');
    setTimeout(() => { try { send('，第二段'); } catch {} }, 120);
    setTimeout(() => { try { send('，第三段'); } catch {} }, 240);
    if (holdOpen) {
      // 不发 [DONE]、也不 end —— 流就这么挂着，等测试点「停止」
      return;
    }
    setTimeout(() => { try { res.write('data: [DONE]\n\n'); res.end(); } catch {} }, 340);
    return;
  }
};
await new Promise(r => server.listen(0,'127.0.0.1',r));
const port = server.address().port;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 120000, args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

// 假装跑在原生壳里，好让 bindBackButton 注册回调；exitApp 记下来供断言
await page.evaluateOnNewDocument(() => {
  window.__backCb = null; window.__exited = false;
  window.Capacitor = {
    isNativePlatform: () => true,
    Plugins: {
      App: {
        addListener: (ev, cb) => { if (ev === 'backButton') window.__backCb = cb; return { remove(){} }; },
        exitApp: () => { window.__exited = true; }
      }
    }
  };
});

const errs = [];
page.on('pageerror', e => errs.push(e.message));
page.on('dialog', async d => { await d.accept(); });   // 删角色用的是原生 confirm

const waitIdle = async (ms = 30000) => {
  const t0 = Date.now();
  await sleep(700);
  while (Date.now() - t0 < ms) {
    const busy = await page.$eval('#btn-stop', el => !el.classList.contains('hidden')).catch(() => false);
    if (!busy) return;
    await sleep(300);
  }
};
const sleep = ms => new Promise(r=>setTimeout(r,ms));

// v1.15.2 起右上角 ⚙ 拉开【抽屉】，设置页要从抽屉里的「全部设置」进。
// 这个函数兼容两种点法，且可重复调用（已进设置页就直接返回）。
const openSettings = async (page, sleep) => {
  // 先退到聊天页：栈底是 chat，其它页面连点返回即可。
  // ⚠️ 只在 view-chat 时点 ⚙ 是不够的 —— 从角色列表/编辑页进来时
  //    当前页不是 chat，会跳过这一步，后续所有断言都打在不可见的页面上（踩过）。
  for (let i = 0; i < 6; i++) {
    const cur = await page.evaluate(() => (document.querySelector('.view.active') || {}).id);
    if (cur === 'view-chat') break;
    await page.evaluate(() => {
      const b = document.getElementById('btn-edit-back')
             || document.getElementById('btn-chars-back')
             || document.getElementById('btn-set-back')
             || document.getElementById('btn-drawer-close')
             || document.getElementById('btn-wb-back');
      if (b) b.click();
    });
    await sleep(500);
  }
  await page.evaluate(() => document.getElementById('btn-settings').click());
  await sleep(800);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('#drawer-menu [data-wb-drawer]')].find(x => x.dataset.wbDrawer === 'settings');
    if (b) b.click();
  });
  await sleep(900);
};
let pass=0, fail=0;
const t=(n,ok,ex='')=>{ if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));} };
const jsClick = (sel) => page.evaluate(s => document.querySelector(s).click(), sel);

await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
await sleep(1500);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil:'networkidle0' });
// v1.21.59：全新安装不再自动建角色（产品改空），测试自己塞一个
await seedChar(page, '测试角色', { greeting: '' });   // 空开场白：不额外多出一条消息
await page.reload({waitUntil:'networkidle0'}); await sleep(500);

// —— v1.20.21：新装默认「时间跟现实走」。这些套件依赖【手动时间】，
//    所以开局先关掉现实模式，否则剧情时间会被手机时钟顶成第 1 天。
await page.evaluate(async () => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => o.onsuccess = () => r(o.result));
  const tx = db.transaction('kv','readwrite'); const st = tx.objectStore('kv');
  const g = await new Promise(r => { const q = st.get('settings'); q.onsuccess = () => r(q.result); });
  const val = Object.assign({}, (g && g.v) || {});
  val.clockMode = false;
  st.put({ k:'settings', v: val });
  await new Promise(r => tx.oncomplete = r);
  db.close();
});
await page.reload({ waitUntil:'networkidle0' }); await sleep(500);
await sleep(200);

// 走 UI 把 baseUrl 指向假端点（直接写 IndexedDB 会跟删库撞上）
await openSettings(page, sleep);
await page.$eval('#s-apikey', el => { el.value = 'sk-test'; el.dispatchEvent(new Event('change', { bubbles: true })); });
await page.$eval('#s-baseurl', (el, p) => { el.value = p; el.dispatchEvent(new Event('change', { bubbles: true })); }, 'http://127.0.0.1:' + port + '/api');
await sleep(400);
const savedBase = await page.$eval('#s-baseurl', el => el.value);
console.log('   假端点 baseUrl: ' + savedBase);
await page.click('#btn-set-back'); await sleep(500);
  // v1.15.2 起栈多了 drawer 一层，退到设置页的上一层是抽屉，还要再关一次
  await page.evaluate(() => { const b = document.getElementById('btn-drawer-close'); if (b && document.querySelector('#view-drawer.active')) b.click(); });
  await sleep(500);

const src = readCode(WWW + '/js/app.js');

console.log('=== 1. 记忆 untilDay=null 不再被当成过期 ===');
t('源码里显式排除了 null', /x\.untilDay !== null && x\.untilDay !== ''/.test(src));
t('没有回退成裸 Number() 判断', !/untilDay: \(x\.kind === 'event' && Number\.isFinite/.test(src));

console.log('');
console.log('=== 2. pickCharParams 不再把缺的键抄成 undefined ===');
t('跳过 undefined', /if \(s\[k\] !== undefined\) o\[k\] = s\[k\]/.test(src));

console.log('');
console.log('=== 3. 裁剪页排在设置页之后（否则会被设置页盖住）===');
const order = await page.evaluate(() => [...document.querySelectorAll('.view')].map(v => v.id));
console.log('   DOM 顺序: ' + JSON.stringify(order));
t('view-crop 排在 view-settings 之后', order.indexOf('view-crop') > order.indexOf('view-settings'),
  'crop@' + order.indexOf('view-crop') + ' settings@' + order.indexOf('view-settings'));

console.log('');
console.log('=== 4. 返回键：弹窗开着时先关弹窗，不要退出 App ===');
await jsClick('#chat-clock');
await sleep(600);
t('剧情时间弹窗已打开', (await page.$eval('#clock-modal', el => !el.classList.contains('hidden'))));
await page.evaluate(() => window.__backCb());
await sleep(500);
t('返回键关掉了弹窗', (await page.$eval('#clock-modal', el => el.classList.contains('hidden'))));
t('返回键没有退出 App', (await page.evaluate(() => window.__exited)) === false);

console.log('');
console.log('=== 5. 返回键：确认弹窗同样先关 ===');
await openSettings(page, sleep);
await jsClick('#btn-clear-chat'); await sleep(600);
t('确认弹窗已打开', (await page.$eval('#modal', el => !el.classList.contains('hidden'))));
await page.evaluate(() => window.__backCb());
await sleep(500);
t('返回键关掉了确认弹窗', (await page.$eval('#modal', el => el.classList.contains('hidden'))));
t('仍然没有退出 App', (await page.evaluate(() => window.__exited)) === false);
await page.click('#btn-set-back'); await sleep(500);
  // v1.15.2 起栈多了 drawer 一层，退到设置页的上一层是抽屉，还要再关一次
  await page.evaluate(() => { const b = document.getElementById('btn-drawer-close'); if (b && document.querySelector('#view-drawer.active')) b.click(); });
  await sleep(500);

console.log('');
console.log('=== 6. 返回键：没有弹窗、已是栈底时才真的退出 ===');
await page.evaluate(() => { window.__exited = false; });
await page.evaluate(() => window.__backCb());
await sleep(400);
t('栈底按返回键 → 退出 App', (await page.evaluate(() => window.__exited)) === true);

console.log('');
console.log('=== 7. 中断后的半截回复，长按要能弹菜单 ===');
holdOpen = true;   // 这一段要的是「流挂住，然后点停止」
await page.evaluate(() => { window.__exited = false; });
await page.click('#input');
await page.type('#input', '测中断', { delay: 10 });
await page.click('#btn-send');
await sleep(1400);                        // 等它吐完前几段、挂在流上
t('假端点确实被请求了', sseStarted >= 1, 'sse=' + sseStarted);
const midText = await page.$eval('#messages .msg.ai:last-child .gen-text', el => el.textContent).catch(()=>'');
console.log('   中断前的正文: ' + JSON.stringify(midText));
await page.click('#btn-stop');
await sleep(1500);

const aborted = await page.evaluate(() => {
  const el = document.querySelector('#messages .msg.ai:last-child');
  return { text: el ? el.textContent.trim() : null, bound: el ? el.dataset.bound : null };
});
console.log('   中断后最后一条: ' + JSON.stringify(aborted).slice(0, 120));
t('中断后留下了半截回复', !!(aborted.text && aborted.text.includes('已中断')), aborted.text);
t('这条消息已绑定长按事件（dataset.bound）', aborted.bound === '1');

// 真派发 contextmenu 看菜单会不会出来
await page.evaluate(() => {
  const el = document.querySelector('#messages .msg.ai:last-child');
  el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
});
await sleep(600);
const menuOpen = await page.$$eval('.msg-menu', els => els.length);
t('长按能弹出菜单', menuOpen >= 1, '菜单数=' + menuOpen);
await page.evaluate(() => { document.querySelectorAll('.msg-menu').forEach(m => m.remove()); });

holdOpen = false;   // 后面几段要的是正常收尾
console.log('');
console.log('=== 8. 档位表：当前值不在档位里时也有高亮 ===');
await page.click('#btn-chars'); await sleep(500);
await page.evaluate(() => document.querySelectorAll('#char-list .char-card button[data-edit]')[0].click());
await sleep(700);
// ⚠️ v0.4.1.7 起这一节的前提变了：频率控件从"一排五档按钮"改成【入口行 + 五档弹窗】，
//    而且"当前值不在档位表里就补一个印着 0.1 的按钮"这个行为被【明确删掉了】
//    （用户实测反馈："关闭的往上一挡是数字 0.1"）。所以这里改成验新契约：
//      ① 入口行上永远显示【档位名】，不显示裸数字；② 点开有 5 档；③ 当前档有高亮。
const emojiBrief = await page.$eval('#e-emoji-brief', el => el.textContent.trim());
console.log('   emoji 入口行显示: ' + JSON.stringify(emojiBrief));
t('emoji 那行显示的是档位名（不是裸数字）', /^(关闭|偶尔|适中|经常|总是)$/.test(emojiBrief), emojiBrief);
const kaoBrief = await page.$eval('#e-kao-freq-brief', el => el.textContent.trim());
console.log('   颜文字入口行显示: ' + JSON.stringify(kaoBrief));
t('颜文字那行显示的也是档位名', /^(关闭|偶尔|适中|经常|总是)$/.test(kaoBrief), kaoBrief);
await page.click('#e-emoji');
await sleep(450);
const freqSeg = await page.$$eval('#drive-list button', els => els.map(e => ({
  t: (e.querySelector('b') || e).textContent.trim(), on: e.classList.contains('on'),
})));
console.log('   弹窗里的档位: ' + JSON.stringify(freqSeg));
t('档位弹窗是 5 档', freqSeg.length === 5, freqSeg.length);
t('当前档有高亮（而且是唯一一个）', freqSeg.filter(x => x.on).length === 1, JSON.stringify(freqSeg.filter(x => x.on)));
t('档位名就是那五个', freqSeg.map(x => x.t).join(',') === '关闭,偶尔,适中,经常,总是', freqSeg.map(x => x.t).join(','));
await page.click('#drive-cancel');
await sleep(300);

console.log('');
console.log('=== 9. 横屏：弹窗和裁剪页都能滚，按钮够得着 ===');
await page.evaluate(() => document.getElementById('btn-edit-back').click()); await sleep(400);
await page.setViewport({ width: 851, height: 393, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await sleep(600);
await page.evaluate(() => document.getElementById('clock-modal').classList.remove('hidden'));
await sleep(500);
const modalL = await page.evaluate(() => {
  const m = document.getElementById('clock-modal');
  const ok = document.getElementById('clock-ok');
  const r = ok.getBoundingClientRect();
  return { overflowY: getComputedStyle(m).overflowY, scrollable: m.scrollHeight > m.clientHeight,
           okBottom: Math.round(r.bottom), vh: window.innerHeight };
});
console.log('   横屏弹窗: ' + JSON.stringify(modalL));
t('弹窗可滚动', modalL.overflowY === 'auto', modalL.overflowY);
await page.evaluate(() => { const m = document.getElementById('clock-modal'); m.scrollTop = m.scrollHeight; });
await sleep(300);
const okAfter = await page.evaluate(() => {
  const r = document.getElementById('clock-ok').getBoundingClientRect();
  return { top: Math.round(r.top), bottom: Math.round(r.bottom), vh: window.innerHeight };
});
console.log('   滚到底后「确定」按钮: ' + JSON.stringify(okAfter));
t('滚到底后「确定」按钮进入视口', okAfter.bottom <= okAfter.vh + 1, JSON.stringify(okAfter));
await page.evaluate(() => document.getElementById('clock-modal').classList.add('hidden'));
await sleep(300);

await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await sleep(400);
await openSettings(page, sleep);
await page.evaluate(() => {
  const inp = document.querySelector('#my-avatar-file');
  const c = document.createElement('canvas'); c.width = 700; c.height = 700;
  const g = c.getContext('2d'); g.fillStyle = '#0af'; g.fillRect(0,0,700,700);
  return new Promise(res => c.toBlob(b => {
    const dt = new DataTransfer();
    dt.items.add(new File([b], 'm.png', { type: 'image/png' }));
    inp.files = dt.files; inp.dispatchEvent(new Event('change', { bubbles: true })); res(true);
  }, 'image/png'));
});
await sleep(1300);
t('已进入裁剪页', (await page.$eval('#view-crop', el => el.classList.contains('active'))));
await page.setViewport({ width: 851, height: 393, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await sleep(700);
const cropL = await page.evaluate(() => {
  const m = document.querySelector('.crop-main');
  return { overflowY: getComputedStyle(m).overflowY, scrollable: m.scrollHeight > m.clientHeight };
});
console.log('   横屏裁剪页: ' + JSON.stringify(cropL));
t('裁剪页可滚动', cropL.overflowY === 'auto', cropL.overflowY);
await page.evaluate(() => { const m = document.querySelector('.crop-main'); m.scrollTop = m.scrollHeight; });
await sleep(300);
const zoomAfter = await page.evaluate(() => {
  const r = document.getElementById('crop-zoom').getBoundingClientRect();
  return { top: Math.round(r.top), bottom: Math.round(r.bottom), vh: window.innerHeight };
});
console.log('   滚到底后缩放滑块: ' + JSON.stringify(zoomAfter));
t('滚到底后缩放滑块进入视口', zoomAfter.bottom <= zoomAfter.vh + 1, JSON.stringify(zoomAfter));

console.log('');
console.log('=== 10. 删掉「不是当前」的角色，当前会话不能被顶掉 ===');
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
// 上一段停在横屏的裁剪页里，直接重载回到干净的聊天页最省事
await page.reload({ waitUntil: 'networkidle0' });
await sleep(200);   // networkidle0 已保证网络静默，后面是纯白等

const nameBefore = await page.$eval('#chat-name', el => el.textContent.trim());
console.log('   当前角色: ' + nameBefore);
// 新建第二个角色（直接塞库，然后手动切过去 —— 塞库不会自动选中）
await seedChar(page, '第二个角色'); await sleep(600);
await page.reload({ waitUntil:'networkidle0' }); await sleep(200);
await page.click('#btn-chars'); await sleep(700);
await page.evaluate(() => {
  const c = [...document.querySelectorAll('#char-list .char-card')]
    .find(x => x.textContent.includes('第二个角色'));
  if (c) c.click();
});
await sleep(1300);
const nameAfterNew = await page.$eval('#chat-name', el => el.textContent.trim());
console.log('   新建后当前角色: ' + nameAfterNew);
t('新建的角色成为当前角色', nameAfterNew !== nameBefore, nameAfterNew);

// 把当前角色切回第一个，再去删掉第二个
await page.click('#btn-chars'); await sleep(500);
await page.evaluate(() => document.querySelectorAll('#char-list .char-card')[0].click());
await sleep(900);
const cur = await page.$eval('#chat-name', el => el.textContent.trim());
console.log('   切回的当前角色: ' + cur);
// 删除「不是当前」的那个（列表里第二个）
await page.click('#btn-chars'); await sleep(500);
const cards = await page.$$eval('#char-list .char-card button[data-edit]', els => els.length);
console.log('   角色数: ' + cards);
await page.evaluate(() => document.querySelectorAll('#char-list .char-card button[data-edit]')[1].click());
await sleep(700);
const editingName = await page.$eval('#e-name', el => el.value);
console.log('   正在编辑(准备删): ' + editingName);
await page.evaluate(() => document.getElementById('btn-del-char').click());
await sleep(1200);
const nameAfterDel = await page.$eval('#chat-name', el => el.textContent.trim());
console.log('   删完之后当前角色: ' + nameAfterDel);
t('删的不是当前角色 → 当前会话保持不变', nameAfterDel === cur, '删前=' + cur + ' 删后=' + nameAfterDel);
t('确实删掉了一个角色', nameAfterDel !== editingName || editingName === cur, editingName);

console.log('');
console.log('=== 11. 失败后用旧错误气泡重试，重发的必须是它自己那条 ===');
failMode = true;
await page.click('#input'); await page.type('#input', '消息AAA', { delay: 5 });
await page.click('#btn-send');
await waitIdle();
await sleep(1200);
const errCount = (await page.$$('.err-bub')).length;
console.log('   错误气泡数: ' + errCount);
t('A 失败后出现错误气泡', errCount >= 1, '气泡数=' + errCount);

failMode = false;
await page.click('#input'); await page.type('#input', '消息BBB', { delay: 5 });
await page.click('#btn-send');
await waitIdle();
await sleep(1500);
const before = await page.$$eval('#messages .msg.me', els => els.map(e => e.textContent.trim()));
console.log('   重试前用户消息: ' + JSON.stringify(before.map(s => s.slice(0, 8))));

await page.evaluate(() => { const b = document.querySelector('.err-bub .retry-btn'); if (b) b.click(); });
await waitIdle();
await sleep(1500);
const after = await page.$$eval('#messages .msg.me', els => els.map(e => e.textContent.trim()));
console.log('   重试后用户消息: ' + JSON.stringify(after.map(s => s.slice(0, 8))));
const lastUser = after[after.length - 1] || '';
t('重发的是 A（它自己那条）', lastUser.includes('AAA'), lastUser.slice(0, 16));
t('B 没有被重复发送', after.filter(s => s.includes('BBB')).length <= 1,
  JSON.stringify(after.map(s => s.slice(0, 8))));

console.log('');
if (errs.length) console.log('  JS 错误: ' + JSON.stringify(errs));
t('全程无 JS 错误', errs.length === 0, errs.join(' | '));

console.log('');
console.log('========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
