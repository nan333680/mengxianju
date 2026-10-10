// 「他的设定」这一块的排版 —— v1.21.47 从 ⚙ 设置页搬到了角色编辑页，这一套跟着搬。
// 原来量的是「她该怎么理解你」那块的提示/输入框/按钮位置，现在量角色页的「他的设定」。
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
const sleep = ms => new Promise(r=>setTimeout(r,ms));
await page.goto('http://127.0.0.1:'+port+'/', { waitUntil:'networkidle0', timeout:40000 });
await sleep(1500);
await page.evaluate(() => indexedDB.deleteDatabase('ai-companion'));
await page.reload({ waitUntil:'networkidle0' }); await sleep(1200);

// 进当前角色的编辑页：点聊天页顶部标题
await page.evaluate(() => document.getElementById('chat-titletxt').click());
await sleep(900);
await page.evaluate(() => document.getElementById('e-mine-fold').click());
await sleep(700);

const m = await page.evaluate(() => {
  const q = s => document.querySelector(s);
  const rect = el => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  const save = q('#btn-e-mine-reset'), reset = q('#btn-e-mine-apply');
  return {
    save: rect(save), reset: rect(reset),
    saveText: save.textContent.trim(), resetText: reset.textContent.trim(),
    saveLines: Math.round(save.getBoundingClientRect().height),
    sameRow: Math.abs(save.getBoundingClientRect().y - reset.getBoundingClientRect().y) < 2,
    tip: rect(q('#e-mine-wrap .profile-tip')),
    box: rect(q('#e-mine')),
    foot: rect(q('#e-mine-wrap .profile-foot')),
    viewport: { w: innerWidth, h: innerHeight },
  };
});
console.log(JSON.stringify(m, null, 2));
console.log('按钮同一行:', m.sameRow);
console.log('按钮高度(单行约34-38):', m.saveLines);
console.log('提示在输入框上方:', m.tip.y < m.box.y);
console.log('按钮在提示下方:', m.foot.y > m.tip.y);
console.log('按钮没超出屏幕:', m.save.x >= 0 && m.reset.x + m.reset.w <= m.viewport.w);

// 截图给人看
await page.evaluate(() => { document.querySelector('#e-mine-wrap .profile-tip').scrollIntoView({ block: 'start' }); });
await sleep(500);
await page.screenshot({ path: `${R}/tmp/profile-btns3.png` });
await browser.close(); server.close();
