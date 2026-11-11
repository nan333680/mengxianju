import puppeteer from 'puppeteer-core';
import http from 'http'; import fs from 'fs'; import path from 'path';
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
const t=(n,ok,ex='')=>{if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));}};

await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
await sleep(1200);

console.log('=== 1. 版本号解析与比较 ===');
const cmp = await page.evaluate(async () => {
  const m = await import('/js/updater.js');
  return {
    p1: m.parseVersion('v0.5.6.4'), p2: m.parseVersion('0.5.7'), p3: m.parseVersion('0.5.7-beta'),
    p4: m.parseVersion(''), p5: m.parseVersion(null),
    c1: m.cmpVersion('0.5.6.10', '0.5.6.9'),
    c2: m.cmpVersion('0.5.7', '0.5.7.0'),
    c3: m.cmpVersion('0.5.7', '0.5.6.4'),
    c4: m.cmpVersion('0.5.6.4', '0.5.7'),
  };
});
t('v0.5.6.4 → [0,5,6,4]', JSON.stringify(cmp.p1) === '[0,5,6,4]', JSON.stringify(cmp.p1));
t('0.5.7 → [0,5,7]', JSON.stringify(cmp.p2) === '[0,5,7]', JSON.stringify(cmp.p2));
t('0.5.7-beta 截到 [0,5,7]', JSON.stringify(cmp.p3) === '[0,5,7]', JSON.stringify(cmp.p3));
t('空串 / null → []', cmp.p4.length === 0 && cmp.p5.length === 0, JSON.stringify([cmp.p4, cmp.p5]));
t('0.5.6.10 > 0.5.6.9（字符串比较会错）', cmp.c1 === 1, String(cmp.c1));
t('0.5.7 == 0.5.7.0（短者补 0）', cmp.c2 === 0, String(cmp.c2));
t('0.5.7 > 0.5.6.4', cmp.c3 === 1, String(cmp.c3));
t('0.5.6.4 < 0.5.7', cmp.c4 === -1, String(cmp.c4));

console.log('');
console.log('=== 2. 同版本 → 不提示 ===');
const same = await page.evaluate(async () => {
  const m = await import('/js/updater.js');
  const fetchImpl = async () => ({ ok: true, json: async () => ({ tag_name: 'v0.5.7', assets: [{ name: 'x.apk', browser_download_url: 'https://e/x.apk', size: 9 }] }) });
  return await m.checkUpdate({ currentVersion: '0.5.7', fetchImpl, sources: [{ id: 'fake', kind: 'release', url: 'u' }] });
});
t('ok=true', same.ok === true, JSON.stringify(same));
t('hasUpdate=false', same.hasUpdate === false, JSON.stringify(same));
t('answered=1/total=1', same.answered === 1 && same.total === 1, JSON.stringify(same));

console.log('');
console.log('=== 3. 远端更大 → 提示 ===');
const newer = await page.evaluate(async () => {
  const m = await import('/js/updater.js');
  const fetchImpl = async () => ({ ok: true, json: async () => ({
    tag_name: 'v0.5.8', name: 'v0.5.8 — 测试', body: '修了点什么',
    published_at: '2026-12-01T00:00:00Z',
    assets: [{ name: 'mengxianju-v0.5.8.apk', browser_download_url: 'https://e/v0.5.8.apk', size: 53985121 }]
  }) });
  return await m.checkUpdate({ currentVersion: '0.5.7', fetchImpl, sources: [{ id: 'fake', kind: 'release', url: 'u' }] });
});
t('hasUpdate=true', newer.hasUpdate === true, JSON.stringify(newer));
t('latest.version=0.5.8', newer.latest && newer.latest.version === '0.5.8', JSON.stringify(newer.latest));
t('带上下载链接', newer.latest && /v0\.5\.8\.apk$/.test(newer.latest.url), String(newer.latest && newer.latest.url));
t('带上说明文字', newer.latest && newer.latest.notes === '修了点什么', String(newer.latest && newer.latest.notes));
t('日期截到 10 位', newer.latest && newer.latest.date === '2026-12-01', String(newer.latest && newer.latest.date));

console.log('');
console.log('=== 4. 取最大，不是先到先用 ===');
const race = await page.evaluate(async () => {
  const m = await import('/js/updater.js');
  const fetchImpl = async (url) => {
    if (url === 'slow') await new Promise(r => setTimeout(r, 450));
    return { ok: true, json: async () => ({ tag_name: url === 'slow' ? 'v0.6.0' : 'v0.5.9', assets: [] }) };
  };
  return await m.checkUpdate({
    currentVersion: '0.5.7', fetchImpl,
    sources: [{ id: 'fast', kind: 'release', url: 'fast' }, { id: 'slow', kind: 'release', url: 'slow' }],
  });
});
t('慢源的新版本赢了', race.latest && race.latest.version === '0.6.0', JSON.stringify(race.latest));
t('两个源都收到了', race.answered === 2, JSON.stringify(race));

console.log('');
console.log('=== 5. version.json 结构也能认 ===');
const jn = await page.evaluate(async () => {
  const m = await import('/js/updater.js');
  const fetchImpl = async () => ({ ok: true, json: async () => ({
    versionCode: 193, versionName: '0.5.8', date: '2026-12-02', notes: '说明文字',
    apk: { size: 100, sha256: 'abc', url: 'https://mirror/v0.5.8.apk', mirrors: ['https://mirror2/v0.5.8.apk'] }
  }) });
  return await m.checkUpdate({ currentVersion: '0.5.7', fetchImpl, sources: [{ id: 'j', kind: 'json', url: 'u' }] });
});
t('version.json 也认', jn.hasUpdate === true && jn.latest.version === '0.5.8', JSON.stringify(jn.latest));
t('主链接取 apk.url', jn.latest.url === 'https://mirror/v0.5.8.apk', String(jn.latest.url));
t('镜像留在 mirrors 里', Array.isArray(jn.latest.mirrors) && jn.latest.mirrors[0] === 'https://mirror2/v0.5.8.apk', JSON.stringify(jn.latest.mirrors));

console.log('');
console.log('=== 6. 全部源失败 → 不崩 ===');
const allBad = await page.evaluate(async () => {
  const m = await import('/js/updater.js');
  const fetchImpl = async () => { throw new Error('RST'); };
  return await m.checkUpdate({ currentVersion: '0.5.7', fetchImpl, sources: [{ id: 'a', kind: 'json', url: 'u1' }, { id: 'b', kind: 'json', url: 'u2' }] });
});
t('ok=false', allBad.ok === false, JSON.stringify(allBad));
t('reason=all-failed', allBad.reason === 'all-failed', String(allBad.reason));
t('answered=0', allBad.answered === 0, String(allBad.answered));

console.log('');
console.log('=== 7. 403 限流 / 404 静默丢弃 ===');
const httpBad = await page.evaluate(async () => {
  const m = await import('/js/updater.js');
  const fetchImpl = async (url) => url === 'ghost' ? ({ ok: false, status: 403, json: async () => ({}) }) : ({ ok: true, json: async () => ({ tag_name: 'v0.5.9', assets: [] }) });
  return await m.checkUpdate({ currentVersion: '0.5.7', fetchImpl, sources: [{ id: 'a', kind: 'release', url: 'ghost' }, { id: 'b', kind: 'release', url: 'good' }] });
});
t('403 的那个被丢掉', httpBad.answered === 1 && httpBad.latest.version === '0.5.9', JSON.stringify(httpBad));

console.log('');
console.log('=== 8. 不知道当前版本时不许瞎提示 ===');
const noVer = await page.evaluate(async () => {
  const m = await import('/js/updater.js');
  const fetchImpl = async () => ({ ok: true, json: async () => ({ tag_name: 'v9.9.9', assets: [] }) });
  return await m.checkUpdate({ currentVersion: '', fetchImpl, sources: [{ id: 'a', kind: 'release', url: 'u' }] });
});
t('currentVersion 空 → hasUpdate=false', noVer.ok === true && noVer.hasUpdate === false, JSON.stringify(noVer));

console.log('');
console.log('=== 9. 慢源拖不住整个检查 ===');
const slow = await page.evaluate(async () => {
  const m = await import('/js/updater.js');
  const fetchImpl = async (url) => {
    if (url === 'hang') return await new Promise(() => {});   // 永不返回
    return { ok: true, json: async () => ({ tag_name: 'v0.5.8', assets: [] }) };
  };
  const t0 = Date.now();
  const r = await m.checkUpdate({ currentVersion: '0.5.7', fetchImpl, timeoutMs: 900,
    sources: [{ id: 'hang', kind: 'release', url: 'hang' }, { id: 'ok', kind: 'release', url: 'ok' }] });
  return { r, ms: Date.now() - t0 };
});
t('仍然拿到好源的结果', slow.r.ok === true && slow.r.hasUpdate === true, JSON.stringify(slow.r));
t('900ms 预算内结束（实测 ' + slow.ms + 'ms）', slow.ms < 2500, String(slow.ms));

console.log('');
console.log('=== 9b. 主源回来后提前收尾（不让人等满 8 秒）===');
const early = await page.evaluate(async () => {
  const m = await import('/js/updater.js');
  const fetchImpl = async (url) => {
    if (url === 'api') return { ok: true, json: async () => ({ tag_name: 'v0.5.6', assets: [] }) };
    return await new Promise(() => {});          // 备用源永不返回
  };
  const t0 = Date.now();
  const r = await m.checkUpdate({ currentVersion: '0.5.7', fetchImpl, timeoutMs: 8000,
    sources: [{ id: 'api', kind: 'release', url: 'api' }, { id: 'x', kind: 'release', url: 'hang' }] });
  return { r, ms: Date.now() - t0 };
});
t('主源回来后 ~2s 收尾（实测 ' + early.ms + 'ms）', early.ms < 3500, String(early.ms));
t('结果仍然正确（0.5.6 不比 0.5.7 新）', early.r.ok === true && early.r.hasUpdate === false, JSON.stringify(early.r));

const keepMax = await page.evaluate(async () => {
  const m = await import('/js/updater.js');
  const fetchImpl = async (url) => {
    if (url === 'api') return { ok: true, json: async () => ({ tag_name: 'v0.5.8', assets: [] }) };
    if (url === 'slow') { await new Promise(r => setTimeout(r, 900)); return { ok: true, json: async () => ({ tag_name: 'v0.5.9', assets: [] }) }; }
    return await new Promise(() => {});
  };
  return await m.checkUpdate({ currentVersion: '0.5.7', fetchImpl, timeoutMs: 8000,
    sources: [{ id: 'api', kind: 'release', url: 'api' }, { id: 'slow', kind: 'release', url: 'slow' }, { id: 'hang', kind: 'release', url: 'hang' }] });
});
t('早退那 2 秒里回来的更大版本仍然赢', keepMax.latest && keepMax.latest.version === '0.5.9', JSON.stringify(keepMax.latest));

const apiDown = await page.evaluate(async () => {
  const m = await import('/js/updater.js');
  const fetchImpl = async (url) => {
    if (url === 'api') throw new Error('403 rate limited');        // 主源直接挂
    if (url === 'backup') { await new Promise(r => setTimeout(r, 3000)); return { ok: true, json: async () => ({ versionName: '0.5.8', notes: '', apk: {} }) }; }
    return await new Promise(() => {});
  };
  const t0 = Date.now();
  const r = await m.checkUpdate({ currentVersion: '0.5.7', fetchImpl, timeoutMs: 8000,
    sources: [{ id: 'api', kind: 'release', url: 'api' }, { id: 'backup', kind: 'json', url: 'backup' }] });
  return { r, ms: Date.now() - t0 };
});
t('主源挂了不能 2 秒就切断（要等备用源）', apiDown.r.ok === true && apiDown.r.hasUpdate === true, JSON.stringify(apiDown.r));
t('确实等到了备用源（实测 ' + apiDown.ms + 'ms ≥ 3000）', apiDown.ms >= 2900, String(apiDown.ms));

const noApi = await page.evaluate(async () => {
  const m = await import('/js/updater.js');
  const fetchImpl = async () => await new Promise(() => {});
  const t0 = Date.now();
  await m.checkUpdate({ currentVersion: '0.5.7', fetchImpl, timeoutMs: 800,
    sources: [{ id: 'x', kind: 'release', url: 'h1' }, { id: 'y', kind: 'release', url: 'h2' }] });
  return Date.now() - t0;
});
t('主源没回来时不早退，老实等预算（' + noApi + 'ms）', noApi >= 700, String(noApi));

console.log('');
console.log('=== 10. 节流键 ===');
const thr = await page.evaluate(async () => {
  const m = await import('/js/updater.js');
  localStorage.removeItem('mxj.upd.lastAt');
  const a = m.shouldAutoCheck(24);
  m.markChecked(Date.now());
  const b = m.shouldAutoCheck(24);
  const c = m.shouldAutoCheck(24, Date.now() + 25 * 3600 * 1000);
  localStorage.removeItem('mxj.upd.lastAt');
  return { a, b, c };
});
t('没记录 → 该查', thr.a === true, String(thr.a));
t('刚查过 → 不查', thr.b === false, String(thr.b));
t('过了 25h → 又该查', thr.c === true, String(thr.c));

console.log('');
console.log('=== 11. 关于页：按钮真的接上了 ===');
await page.evaluate(() => { document.getElementById('btn-settings').click(); });
await sleep(700);
await page.evaluate(() => { const b = document.querySelector('[data-wb-drawer="about"]'); if (b) b.click(); });
await sleep(800);
const ui = await page.evaluate(() => {
  const btn = document.getElementById('btn-about-check');
  const ver = document.getElementById('about-ver');
  return {
    aboutActive: !!document.querySelector('#view-about.active'),
    hasBtn: !!btn, label: btn ? btn.textContent.trim() : '',
    ver: ver ? ver.textContent.trim() : '',
  };
});
t('关于页打开了', ui.aboutActive === true, JSON.stringify(ui));
t('有「检查更新」按钮', ui.hasBtn === true && ui.label === '检查更新', JSON.stringify(ui));
t('版本号已显示', /^v0\.5\.\d+/.test(ui.ver), ui.ver);

console.log('');
console.log('=== 12. 有新版本 → 弹窗 ===');
const mockRelease = (tag, body) => {
  const real = window.__realFetch || (window.__realFetch = window.fetch.bind(window));
  window.fetch = async (u) => {
    const s = String(u);
    if (s.includes('github.com') || s.includes('jsdelivr') || s.includes('ghproxy') || s.includes('githubusercontent')) {
      return { ok: true, json: async () => ({ tag_name: tag, name: 'n', body,
        published_at: '2026-12-01T09:00:00Z',
        assets: [{ name: 'mengxianju-' + tag + '.apk', browser_download_url: 'https://example.com/' + tag + '.apk', size: 53985121 }] }) };
    }
    return real(u);
  };
};
await page.evaluate(mockRelease, 'v0.5.9', '这一版修了点什么');
await page.evaluate(() => { document.getElementById('btn-about-check').click(); });
await sleep(1500);
const modal = await page.evaluate(() => {
  const m = document.getElementById('modal');
  const g = (id) => { const e = document.getElementById(id); return e ? e.textContent : ''; };
  return { open: !!m && !m.classList.contains('hidden'), title: g('modal-title'), text: g('modal-text'), ok: g('modal-ok') };
});
t('弹窗出现了', modal.open === true, JSON.stringify(modal));
t('标题写明新版本号', /发现新版本/.test(modal.title) && /0\.5\.9/.test(modal.title), modal.title);
t('正文带版本号和说明', /v0\.5\.9/.test(modal.text) && /这一版修了点什么/.test(modal.text), modal.text.slice(0, 100));
t('确定按钮是「分享链接」', modal.ok.trim() === '分享链接', modal.ok);

console.log('');
console.log('=== 13. 取消后按钮恢复 ===');
await page.evaluate(() => { document.getElementById('modal-cancel').click(); });
await sleep(400);
const after = await page.evaluate(() => {
  const m = document.getElementById('modal');
  const b = document.getElementById('btn-about-check');
  return { closed: !!m && m.classList.contains('hidden'), dis: b.disabled, label: b.textContent.trim() };
});
t('弹窗关掉了', after.closed === true, JSON.stringify(after));
t('按钮恢复可用、文字复原', after.dis === false && after.label === '检查更新', JSON.stringify(after));

console.log('');
console.log('=== 14. 同版本 → 只弹 toast，不开模态 ===');
await page.evaluate(mockRelease, 'v0.5.6.4', '旧版');
await page.evaluate(() => { document.getElementById('btn-about-check').click(); });
await sleep(1200);
const sameUi = await page.evaluate(() => {
  const m = document.getElementById('modal');
  const t = document.getElementById('toast');
  return { modalClosed: !!m && m.classList.contains('hidden'), toastShown: !!t && !t.classList.contains('hidden'), toastText: t ? t.textContent : '' };
});
t('没开模态', sameUi.modalClosed === true, JSON.stringify(sameUi));
t('toast 说已经是最新版', sameUi.toastShown === true && /已经是最新版了/.test(sameUi.toastText), JSON.stringify(sameUi));

console.log('');
console.log('=== 15. 全源失败 → toast，不卡 ===');
await page.evaluate(() => { window.fetch = async () => { throw new Error('RST'); }; });
const t0fail = Date.now();
await page.evaluate(() => { document.getElementById('btn-about-check').click(); });
await sleep(1600);
const failUi = await page.evaluate(() => {
  const m = document.getElementById('modal');
  const t = document.getElementById('toast');
  const b = document.getElementById('btn-about-check');
  return { modalClosed: !!m && m.classList.contains('hidden'), toastText: t ? t.textContent : '', dis: b.disabled, label: b.textContent.trim() };
});
t('没开模态', failUi.modalClosed === true, JSON.stringify(failUi));
t('toast 说连不上', /连不上，稍后再试/.test(failUi.toastText), failUi.toastText);
t('按钮已恢复（没被卡死）', failUi.dis === false && failUi.label === '检查更新', JSON.stringify(failUi));

console.log('');
console.log('=== 16. 无报错 ===');
t('无 pageerror', errs.length === 0, errs.join(' | '));

console.log('');
console.log('通过 ' + pass + ' / 失败 ' + fail);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
