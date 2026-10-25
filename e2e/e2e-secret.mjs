// e2e-secret.mjs —— 信息差 / 她自己 / 底线（活人感 v2 第二批）
//
// 这一套只测纯函数 + 源码接线，不劫持 fetch：
// psyche.js 与 director.js 都不碰 IndexedDB / DOM / 模型，页面里直接 import 就能跑。
//
// 覆盖：
//   A. normalizePsyche   三个新字段的默认值 / 上限 / reveal 条件
//   B. applyPsycheDelta  只增不换、去重、说破就删
//   C. psycheActive      只有这三样时也算"有状态"
//   D. psychePrompt      三行文案（别主动交代 / 你自己这两天 / 底线）
//   E. director          白名单与条数上限 + delta 接线 + 说破提示
//   F. 接线               app.js 把 directorDelta 直接喂给 applyPsycheDelta
//
// 为什么值得单独一套：这三样是【静默】的 —— 少了任何一处接线，
// 她照样能聊天，只是永远没有瞒着的事、没有自己的生活、也没有底线。

import puppeteer from "puppeteer-core";
import http from "http";
import fs from "fs";
import path from "path";
const R = path.resolve(import.meta.dirname, "..").split(path.sep).join("/");
const WWW = R + "/www";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const server = http.createServer((req, res) => {
  let q = decodeURIComponent(req.url.split("?")[0]);
  if (q === "/") q = "/index.html";
  const f = path.join(WWW, q);
  if (!fs.existsSync(f)) { res.writeHead(404); res.end("404"); return; }
  res.writeHead(200, { "Content-Type": MIME[path.extname(f)] || "application/octet-stream", "Cache-Control": "no-store, no-cache, must-revalidate" });
  res.end(fs.readFileSync(f));
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
});
const page = await browser.newPage();
await page.setCacheEnabled(false);
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = [];
page.on("pageerror", e => errs.push(e.message));
let pass = 0, fail = 0;
const t = (n, ok, ex = "") => { if (ok) { pass++; console.log("  OK   " + n); } else { fail++; console.log("  FAIL " + n + (ex ? "  -> " + ex : "")); } };

await page.goto("http://127.0.0.1:" + port + "/", { waitUntil: "domcontentloaded" });

const res = await page.evaluate(async () => {
  const P = await import("/js/psyche.js");
  const D = await import("/js/director.js");
  const out = {};
  const now = Date.now();

  // ---- A. 默认值与上限 ----
  out.a1 = P.normalizePsyche({}).secrets.length;
  out.a2 = P.normalizePsyche({ secrets: "不是数组" }).secrets.length;
  out.a3 = P.normalizePsyche({ secrets: [{ t: "她瞒着一件旧事", reveal: "他问起工作" }] }).secrets[0].reveal;
  out.a4 = P.normalizePsyche({ secrets: ["a1", "a2", "a3", "a4", "a5"] }).secrets.length;
  out.a5 = P.normalizePsyche({ selfEvents: ["e1", "e2", "e3", "e4", "e5", "e6"] }).selfEvents.length;
  out.a6 = P.normalizePsyche({ boundaries: ["b1", "b2", "b3", "b4", "b5"] }).boundaries.length;
  out.a7 = P.normalizePsyche({ secrets: [{ t: "" }] }).secrets.length;

  // ---- B. 只增不换 / 去重 / 说破就删 ----
  let p = P.emptyPsyche();
  p = P.applyPsycheDelta(p, { secret: ["她其实已经辞职了"] }, now);
  out.b1 = p.secrets.length;
  p = P.applyPsycheDelta(p, { secret: ["她其实已经辞职了"] }, now);
  out.b2 = p.secrets.length;                 // 同一件事说两次仍是一条
  p = P.applyPsycheDelta(p, { revealSecret: ["她其实已经辞职了"] }, now);
  out.b3 = p.secrets.length;                 // 说破了就不再是秘密
  p = P.applyPsycheDelta(p, { selfEvent: ["她今天去剪了头发", "她把阳台的花换了盆"] }, now);
  out.b4 = p.selfEvents.length;
  p = P.applyPsycheDelta(p, { boundary: ["别拿这种玩笑试探她", "别替她安排"] }, now);
  out.b5 = p.boundaries.length;
  // 下一轮没有任何这三样，不该被清空（不是 withheld 那种"每轮换掉"）
  p = P.applyPsycheDelta(p, { mood: { label: "平静", intensity: 1 } }, now);
  out.b6 = p.selfEvents.length;

  // ---- C. psycheActive ----
  out.c1 = P.psycheActive({ secrets: [{ t: "瞒着一件事" }] });
  out.c2 = P.psycheActive({ selfEvents: [{ t: "她今天去剪了头发" }] });
  out.c3 = P.psycheActive({ boundaries: [{ t: "别试探她" }] });
  out.c4 = P.psycheActive(P.emptyPsyche());

  // ---- D. 提示词 ----
  out.d0 = P.psychePrompt(P.emptyPsyche());
  const pp = P.applyPsycheDelta(P.emptyPsyche(), {
    secret: [{ t: "她妈住院了", reveal: "他问起家里" }],
    selfEvent: ["她今天去剪了头发"],
    boundary: ["别拿这种玩笑试探她"]
  }, now);
  const s = P.psychePrompt(pp);
  out.d1 = s.indexOf("你瞒着他的") >= 0;
  out.d2 = s.indexOf("除非他先问起他问起家里") >= 0 || s.indexOf("否则别主动说") >= 0;
  out.d3 = s.indexOf("你自己这两天") >= 0 && s.indexOf("剪了头发") >= 0;
  out.d4 = s.indexOf("你的底线") >= 0 && s.indexOf("不需要假装没事") >= 0;

  // ---- E. 判断层 ----
  out.e1 = D.normalizeDirector({ secret: ["a", "b", "c"] }).secret.length;
  out.e2 = D.normalizeDirector({ boundary: ["a", "b"] }).boundary.length;
  out.e3 = !!D.normalizeDirector({ selfEvent: ["她今天去剪了头发"] });
  const nd0 = D.normalizeDirector({});
  out.e4 = nd0 === null;
  const nd = D.normalizeDirector({ move: "answer", secret: ["她瞒着一件事"], selfEvent: ["她今天去剪了头发"], boundary: ["别替她安排"], revealSecret: ["她瞒着一件事"] });
  out.e5 = [!!nd, nd.secret.length, nd.selfEvent.length, nd.boundary.length, nd.revealSecret.length].join(",");
  const dl = D.directorDelta({ stance: {}, secret: ["她瞒着一件事"], selfEvent: ["她今天去剪了头发"], boundary: ["别替她安排"], revealSecret: ["她瞒着一件事"] });
  out.e6 = [!!dl.secret, !!dl.selfEvent, !!dl.boundary, !!dl.revealSecret].join(",");
  const dl2 = D.directorDelta({ stance: {} });
  out.e7 = !dl2.secret && !dl2.selfEvent && !dl2.boundary;   // 空的时候【不传】，否则每轮清一次
  out.e8 = D.directorPrompt(nd).indexOf("这一轮你决定说破") >= 0;

  return out;
});

const eq = (n, a, b) => t(n, a === b, "实际=" + JSON.stringify(a) + " 期望=" + JSON.stringify(b));

console.log("\n【A】老数据 / 坏数据 / 条数上限");
eq("空对象的 secrets 是空数组", res.a1, 0);
eq("secrets 不是数组也不抛", res.a2, 0);
eq("reveal 条件保留下来", res.a3, "他问起工作");
eq("secrets 上限 4", res.a4, 4);
eq("selfEvents 上限 5", res.a5, 5);
eq("boundaries 上限 4", res.a6, 4);
eq("空文本的秘密不算一条", res.a7, 0);

console.log("\n【B】只增不换 / 去重 / 说破就删");
eq("写进一条秘密", res.b1, 1);
eq("同一件事再说一次仍是一条", res.b2, 1);
eq("说破了就从秘密里删掉", res.b3, 0);
eq("她自己的事能攒两条", res.b4, 2);
eq("底线去重后两条", res.b5, 2);
eq("下一轮不提也不会被清空（不是 withheld 那种覆盖）", res.b6, 2);

console.log("\n【C】有这三样也算有状态");
t("只有秘密 → 有状态", res.c1 === true);
t("只有她自己的事 → 有状态", res.c2 === true);
t("只有底线 → 有状态", res.c3 === true);
t("空状态仍然是空", res.c4 === false);

console.log("\n【D】提示词里怎么写的");
eq("空状态一个字都不出", res.d0, "");
t("有「你瞒着他的」", res.d1 === true);
t("有 reveal 条件时写明「否则别主动说」", res.d2 === true);
t("有「你自己这两天」且带上了那件事", res.d3 === true);
t("有「你的底线」且写明不用假装没事", res.d4 === true);

console.log("\n【E】判断层字段");
eq("secret 最多 2 条", res.e1, 2);
eq("boundary 最多 1 条", res.e2, 1);
t("只给了 selfEvent 也算有效判断（不是空对象）", res.e3 === true);
t("空对象仍然算判断失败", res.e4 === true);
eq("归一化带出四个字段", res.e5, "true,1,1,1,1");
eq("directorDelta 认这四样", res.e6, "true,true,true,true");
t("空的时候不往下传（否则每轮清一次）", res.e7 === true);
t("说破那一件写进「这一轮」而不是长期状态", res.e8 === true);

console.log("\n【F】接线（源码断言：evaluate 里没有 fs，只能在 Node 侧读）");
const appSrc = fs.readFileSync(path.join(WWW, "js", "app.js"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
t("app.js 把 directorDelta 的结果直接喂给 applyPsycheDelta（新字段自动落地）",
  appSrc.indexOf("applyPsycheDelta(psyBefore, d, Date.now())") >= 0);

t("没有 pageerror", errs.length === 0, errs.join(" | "));

console.log("\n通过 " + pass + " 项 / 失败 " + fail + " 项");
await browser.close();
server.close();
process.exit(fail > 0 ? 1 : 0);
