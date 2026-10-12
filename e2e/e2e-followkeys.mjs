// e2e-followkeys.mjs — 「描写档位」三态键（descLevel / detailDrive）端到端回归（v0.3.1）
//
// 背景：这两个键是"不写 = 跟随全局"，但机制补上之前编辑页把当时生效的值写进了角色，
// 而 effSettings 角色值优先 —— 于是设置页改这两个档位对老角色【零效果】。
// 本套件覆盖三条能证伪的路径：
//   1) 启动迁移：老角色身上的快照被清掉，原值留档
//   2) 迁移之后，改全局档位对该角色【真的生效】（发真实请求，看 system 提示词）
//   3) 三条写入路径（编辑页保存 / 广播 / 导入卡）+ 空库边界（源码契约）
import puppeteer from 'puppeteer-core';
import http from 'http'; import fs from 'fs'; import path from 'path';
import { readCode } from './e2e-src.mjs';
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
const sleep = ms => new Promise(r=>setTimeout(r,ms));
let pass=0, fail=0;
const t=(n,ok,ex='')=>{ if(ok){pass++;console.log('  OK   '+n);}else{fail++;console.log('  FAIL '+n+(ex?'  -> '+ex:''));} };

let lastSys = '';
await page.setRequestInterception(true);
page.on('request', req => {
  const u = req.url();
  if (u.includes('deepseek') || u.includes('/chat/completions')) {
    if (req.method()==='OPTIONS') { req.respond({status:204,headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'*'}}); return; }
    const b = JSON.parse(req.postData()||'{}');
    lastSys = (b.messages||[]).map(m=>m.content||'').join(String.fromCharCode(10));
    if (b.stream) {
      const pl='data: '+JSON.stringify({choices:[{delta:{content:'好。'}}]})+String.fromCharCode(10,10)+'data: [DONE]'+String.fromCharCode(10,10);
      req.respond({status:200,headers:{'Access-Control-Allow-Origin':'*'},contentType:'text/event-stream',body:pl}); return;
    }
    req.respond({status:200,headers:{'Access-Control-Allow-Origin':'*'},contentType:'application/json',body:JSON.stringify({choices:[{message:{content:'[]'}}]})}); return;
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

const getChar = (id) => page.evaluate(async (cid) => {
  const o = indexedDB.open('ai-companion');
  const db = await new Promise(r => o.onsuccess = () => r(o.result));
  const v = await new Promise(r => { const q = db.transaction('characters').objectStore('characters').get(cid); q.onsuccess = () => r(q.result); });
  db.close(); return v || null;
}, id);

const gotoChar = async (name) => {
  await page.evaluate((n) => { const c=[...document.querySelectorAll('#char-list .char-card')].find(x=>x.textContent.includes(n)); if(c)c.click(); }, name);
  await sleep(800);
};

const sendOne = async (text) => {
  await page.evaluate((s) => { const i=document.getElementById('input'); i.value=s; i.dispatchEvent(new Event('input',{bubbles:true})); }, text);
  await page.evaluate(() => document.getElementById('btn-send').click());
  for (let i=0;i<25;i++){ await sleep(300); const b=await page.$eval('#btn-stop',e=>!e.classList.contains('hidden')).catch(()=>false); if(!b) break; }
  await sleep(600);
};

await page.goto('http://127.0.0.1:'+port+'/index.html', { waitUntil:'networkidle0' });
await sleep(900);

console.log('=== 1. 启动迁移：老角色身上的描写档位快照被清掉 ===');
{
  await putDB('characters', { id:'c-fk', name:'档位迁移', avatar:null, greeting:'（她抬眼看你）',
    persona:'你是一个测试角色，说话简短。', createdAt:Date.now(),
    longMemory:false, splitMessages:false, descLevel:'high', detailDrive:'rich' });
  const before = await getChar('c-fk');
  t('造数成功：角色带 descLevel/detailDrive', before.descLevel==='high' && before.detailDrive==='rich');
  await page.reload({ waitUntil:'networkidle0' }); await sleep(1300);
  const after = await getChar('c-fk');
  console.log('   迁移后: ' + JSON.stringify({ descLevel: after.descLevel, detailDrive: after.detailDrive }));
  t('迁移清掉了 descLevel', after.descLevel === undefined);
  t('迁移清掉了 detailDrive', after.detailDrive === undefined);
  t('角色本身还在', !!after && after.name === '档位迁移');
  const bk = await getDB('kv', 'followKeysBackup:v0.3.1');
  console.log('   留档: ' + JSON.stringify(bk && bk.v));
  t('原值留档了', !!bk && bk.v && bk.v['c-fk.descLevel'] === 'high' && bk.v['c-fk.detailDrive'] === 'rich');
  const st = await getDB('kv', 'settings');
  t('迁移标记已落库', !!st && st.v && st.v.followKeysMigrated === true);
}

console.log('');
console.log('=== 2. 迁移之后，改全局档位对该角色真的生效 ===');
{
  // ⚠️ 取值必须是 UI 真给的档：DESC_PRESETS 只有 off/low/mid/high（v0.3.1 核对），
  //    写 'max' 会落到 persona.js 的 DESC_HINT[x] || DESC_HINT.mid 兜底上去 —— 测了个寂寞。
  //    detailDrive 才有 max（DRIVE_PRESETS）。
  const st = await getDB('kv', 'settings');
  st.v.descLevel = 'off';
  st.v.detailDrive = 'off';
  // 本套件要走到【真实请求】才会产生 system 提示词 —— 没有 Key 时 send 直接被拦，
  // lastSys 恒为空，断言会假失败（实测踩到）。
  st.v.apiKey = 'sk-test';
  st.v.baseUrl = st.v.baseUrl || 'https://api.deepseek.com';
  await putDB('kv', st);
  await page.reload({ waitUntil:'networkidle0' }); await sleep(1100);
  await gotoChar('档位迁移');
  await sendOne('测试描写档 off');
  const sysOff = lastSys;
  console.log('   off：提示词长度 ' + sysOff.length);
  t('全局 off 时该角色没有描写档约束',
    sysOff.length > 0 && !sysOff.includes('不超过 60 个字') && !sysOff.includes('三段式'));

  const st2 = await getDB('kv', 'settings');
  st2.v.descLevel = 'high';
  st2.v.detailDrive = 'max';
  await putDB('kv', st2);
  await page.reload({ waitUntil:'networkidle0' }); await sleep(1100);
  await gotoChar('档位迁移');
  await sendOne('测试描写档 high');
  const sysHi = lastSys;
  console.log('   high+max：提示词长度 ' + sysHi.length);
  t('全局 descLevel=high 时该角色下一轮就带上上限约束', sysHi.includes('不超过 60 个字'));
  t('全局 detailDrive=max 时该角色下一轮带上三段式', sysHi.includes('三段式'));
}

console.log('');
console.log('=== 3. 三条写入路径 + 空库边界（源码契约）===');
{
  const src = readCode(WWW + '/js/app.js');
  t('FOLLOW_KEYS 定义了这两个键', src.includes("const FOLLOW_KEYS = ['descLevel', 'detailDrive'];"));
  t('编辑页保存：跟随全局时删键', src.includes('for (const k of FOLLOW_KEYS) if (data[k] === undefined) delete nextC[k];'));
  t('广播：先删键再写这一页的值', src.includes('for (const k of FOLLOW_KEYS) delete nextC[k];'));
  t('导入卡：不继承三态键', src.includes('...omitFollowKeys(pickCharParams(S)),'));
  t('空库不写迁移标记', src.includes('if (!allChars.length) return;'));
}

console.log('');
console.log('  JS 错误: ' + (errs.length ? JSON.stringify(errs.slice(0,3)) : '无'));
t('无 JS 错误', errs.length === 0, errs.join(' | '));

console.log('');
console.log('========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
