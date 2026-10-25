// e2e-mempick.mjs —— 记忆经历化：相关度打分 / 情绪强度 / 未完成 / 突然想起来
//
// 这一套只测纯函数，不劫持 fetch：mempick.js 与 memory.js 都不碰 IndexedDB / DOM / 模型，
// 所以整套在页面里直接 import 就能跑，几十毫秒出结果。
//
// 覆盖：
//   A. 语义分母         bigramsOf / semanticScore
//   B. 情绪强度         heatNorm（没标的按 kind 给保守值）
//   C. 打分公式         scoreOf（权重 0.35/0.25/0.20/0.10/0.10 精确到小数）
//   D. 排序行为         userText 命中的压过 kind 固定顺序
//   E. promise 类别     why / 不被没兑现的旧承诺顶掉
//   F. 突然想起来       cb 抽取条件 + memoryBlockText 前缀 + 各种不该抽的情形
//   G. 小说模式         不打分、不抽 cb、保持 kind 顺序
//   H. pinned           绝对优先
//   I. 老数据           normalizeMemory 补 heat/open 默认值
//   J. 提炼链路         源码断言：heat/open 从模型输出一路带到库里
//
// 为什么值得单独一套：这几条是【静默生效】的 —— 排错了不会报错，
// 只会让「她这一轮怎么突然提起那把伞」变成「她一直在念计划」。

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

// ---------------------------------------------------------------------------
// A ~ I：全部在页面里跑（模块原样 import，不 mock）
// ---------------------------------------------------------------------------
const res = await page.evaluate(async () => {
  const mp = await import("/js/mempick.js");
  const mem = await import("/js/memory.js");
  const { bigramsOf, semanticScore, heatNorm, scoreOf, pickMemories, memoryBlockText } = mp;
  const { normalizeMemory, planSupersede } = mem;
  const out = {};
  let seq = 0;
  const mk = (o) => Object.assign({ id: "mem-" + (++seq), kind: "fact", scope: "character", subject: "char", status: "active", day: 30, ts: 1000 + seq }, o);

  // ---- A. 语义分母 ----
  const g = bigramsOf("那把伞呢？");
  out.g1 = g.size;                       // 「那把」「把伞」「伞呢」= 3（标点被去掉）
  out.g2 = g.has("把伞");
  out.g3 = semanticScore("那把伞", bigramsOf("那天那把伞到底哪去了"));  // 分母是记忆的两字组
  out.g4 = semanticScore("那把伞", null);
  out.g5 = semanticScore("今天天气不错", bigramsOf("那把伞到底哪去了"));

  // ---- B. 情绪强度 ----
  out.h5 = heatNorm({ heat: 5 });
  out.h3 = heatNorm({ heat: 3 });
  out.hRel = heatNorm({ kind: "relationship" });
  out.hFact = heatNorm({ kind: "fact" });
  out.hEvent = heatNorm({ kind: "event" });
  out.hOver = heatNorm({ heat: 9 });
  out.hStr = heatNorm({ heat: "4" });     // 字符串数字也要认

  // ---- C. 打分公式（手算：0.25*1 + 0.20*1 + 0.10*rec(今天=1) = 0.55）----
  const s1 = scoreOf({ text: "他摔门走了", kind: "event", heat: 5, open: true, day: 10 }, { userGrams: null, nowDay: 10 });
  out.s1 = Math.round(s1 * 1000) / 1000;
  const s2 = scoreOf({ text: "他敲了两下门", kind: "event", heat: 0, day: 10 }, { userGrams: null, nowDay: 10 });
  out.s2 = Math.round(s2 * 1000) / 1000;   // 0.25*0.2 + 0.10*1 = 0.15

  // ---- D. 排序：内容命中的压过固定 kind 顺序 ----
  const listD = [
    mk({ kind: "goal", text: "她想把下个月房租攒出来", day: 29 }),
    mk({ kind: "event", text: "他把她那把伞弄丢了", day: 28, heat: 4 }),
    mk({ kind: "fact", text: "她讨厌下雨天", day: 5 })
  ];
  const pd = pickMemories({ list: listD, nowDay: 30, userText: "那把伞到底哪去了" });
  out.d1 = pd.used[0].text;
  out.d2 = pd.used[0].sem;
  out.d3 = pd.used[0].score;
  out.d4 = typeof pd.used[0].open === "boolean" && typeof pd.used[0].heat === "number";

  // 没有 userText 时（开场、续写），语义分恒为 0，但情绪强度【照样生效】——
  // 这不是 bug：她那会儿最在意的事本来就该先浮上来，kind 顺序只是同分时的次序。
  const pd2 = pickMemories({ list: listD.map(x => ({ ...x })), nowDay: 30 });
  out.d5 = pd2.used[0].kind;
  // 全都没标 heat / open 时，才真正回落到 kind 顺序（goal 第一）
  const pd3 = pickMemories({ list: [
    mk({ kind: "goal", text: "她想把下个月房租攒出来", day: 29 }),
    mk({ kind: "event", text: "他把她那把伞弄丢了", day: 28 }),
    mk({ kind: "fact", text: "她讨厌下雨天", day: 5 })
  ], nowDay: 30 });
  out.d6 = pd3.used[0].kind;

  // ---- E. promise ----
  const listE = [mk({ kind: "promise", text: "她答应过他明天把书还回来", open: true })];
  const pe = pickMemories({ list: listE, nowDay: 30 });
  out.e1 = pe.used[0] && pe.used[0].why;
  // 没兑现的承诺不被新承诺顶掉
  const oldP = mk({ id: "old-p", kind: "promise", key: "计划", text: "她答应周末陪他去医院", open: true });
  const newP = mk({ id: "new-p", kind: "promise", key: "计划", text: "她答应下周把伞还他", open: true });
  out.e2 = planSupersede(newP, [oldP]).length;
  const oldP2 = Object.assign({}, oldP, { open: false, id: "old-p2" });
  out.e3 = planSupersede(newP, [oldP2]).length;
  // 其它类型的老行为不变
  const oldF = mk({ id: "old-f", kind: "fact", key: "职业", text: "她做护士" });
  const newF = mk({ id: "new-f", kind: "fact", key: "职业", text: "她改行做兽医了" });
  out.e4 = planSupersede(newF, [oldF]).length;

  // ---- F. 突然想起来 ----
  // 7 条当天相关的（互不相同、和 userText 无关）+ 1 条 20 天前、heat 4 的
  const listF = [];
  for (let i = 0; i < 7; i++) listF.push(mk({ kind: "state", text: "今天第" + i + "件小事记下来了", day: 30, heat: 0 }));
  listF.push(mk({ kind: "event", text: "她小时候在河边掉进过水里", day: 10, heat: 4 }));
  const pf = pickMemories({ list: listF, nowDay: 30, userText: "你在干嘛呢" });
  const cbHit = pf.used.filter(x => x.cb === true);
  out.f1 = cbHit.length;
  out.f2 = cbHit.length ? cbHit[0].text.indexOf("河边") >= 0 : false;
  out.f3 = memoryBlockText(pf.used).indexOf("· （她突然想起来）") >= 0;

  // 今天刚说的不算「想起来」
  const pf2 = pickMemories({ list: [mk({ kind: "event", text: "她刚哭过一场", day: 30, heat: 5 })].concat(listF.slice(0, 6)), nowDay: 30, userText: "你在干嘛呢" });
  out.f4 = pf2.used.filter(x => x.cb === true).length;
  // pinned 不参与
  const pf3 = pickMemories({ list: [mk({ kind: "event", text: "她小时候在河边掉进过水里", day: 10, heat: 4, pinned: true })].concat(listF.slice(0, 6)), nowDay: 30, userText: "你在干嘛呢" });
  out.f5 = pf3.used.filter(x => x.cb === true).length;
  // legacy（老备份迁来的，日期不可信）不参与
  const pf4 = pickMemories({ list: [mk({ kind: "event", text: "她小时候在河边掉进过水里", day: 10, heat: 4, legacy: true })].concat(listF.slice(0, 6)), nowDay: 30, userText: "你在干嘛呢" });
  out.f6 = pf4.used.filter(x => x.cb === true).length;
  // 这一轮他直接提到了它 → 不算突然想起来
  const pf5 = pickMemories({ list: listF.slice(0, 7).concat([mk({ kind: "event", text: "她小时候在河边掉进过水里", day: 10, heat: 4 })]), nowDay: 30, userText: "你小时候在河边掉进过水里那事" });
  out.f7 = pf5.used.filter(x => x.cb === true).length;
  // 只有 3 条时完全不抽（免得整段变成回忆录）
  const pf6 = pickMemories({ list: [mk({ kind: "event", text: "她小时候在河边掉进过水里", day: 10, heat: 4 }), mk({ kind: "state", text: "今天挺累" })], nowDay: 30, userText: "你在干嘛" });
  out.f8 = pf6.used.filter(x => x.cb === true).length;

  // ---- G. 小说模式 ----
  const listG = [
    mk({ kind: "fact", text: "她小时候在河边掉进过水里", day: 3, heat: 5 }),
    mk({ kind: "relationship", text: "他们还没把话说明白", day: 20 })
  ];
  const pg = pickMemories({ list: listG.map(x => ({ ...x })), nowDay: 30, forScene: true, userText: "河边" });
  out.g6 = pg.used.every(x => x.score === 0 && x.sem === 0);
  out.g7 = pg.used.filter(x => x.cb).length;
  out.g8 = pg.used[0].kind;               // 小说模式 relationship 排最前

  // ---- H. pinned ----
  const listH = [
    mk({ kind: "goal", text: "她想搬去南方", heat: 5, open: true }),
    mk({ kind: "event", text: "她讨厌被问起家里", pinned: true })
  ];
  const ph = pickMemories({ list: listH, nowDay: 30, userText: "你想搬去南方吗" });
  out.h1 = ph.used[0].pinned === true;
  out.h2 = ph.used[0].why;

  // ---- I. normalizeMemory 的默认值 ----
  out.i1 = normalizeMemory({ text: "x", heat: 5.6 }).heat;
  out.i2 = normalizeMemory({ text: "x", heat: -3 }).heat;
  out.i3 = normalizeMemory({ text: "x", heat: "abc" }).heat;
  out.i4 = normalizeMemory({ text: "x", open: "true" }).open;   // 字符串不算真
  out.i5 = normalizeMemory({ text: "x", open: true }).open;
  const oldRec = normalizeMemory({ text: "老备份里的一条" });   // 没有 heat/open 字段
  out.i6 = oldRec.heat;
  out.i7 = oldRec.open;
  out.i8 = oldRec.v;

  // ---- 被挤掉的仍然是带原因的（规格 §5.3）----
  const pLimit = pickMemories({ list: listF.slice(0, 5).map(x => ({ ...x })), nowDay: 30, limit: 2 });
  out.j1 = pLimit.dropped.length;
  out.j2 = pLimit.dropped.every(x => !!x.reason);

  // ---- L. 选择性遗忘 ----
  // 60 天前的三件事：一件没标强度的琐事（该模糊）、一件同样久的事实（不能模糊）、
  // 一件带情绪强度的旧事（不能模糊）。
  const listL = [
    mk({ kind: "event", text: "他那天在便利店门口把伞弄丢了", day: 10 }),
    mk({ kind: "fact", text: "她在城南的医院上夜班", day: 10 }),
    mk({ kind: "event", text: "他那天在便利店门口把伞弄丢之后又折回来找", day: 10, heat: 4, id: "mem-hot" })
  ];
  const pl = pickMemories({ list: listL.map(x => ({ ...x })), nowDay: 70 });
  const oldEv = pl.used.filter(x => x.kind === "event" && x.heat === 0)[0];
  const hotEv = pl.used.filter(x => x.heat === 4)[0];
  const oldFact = pl.used.filter(x => x.kind === "fact")[0];
  out.l1 = !!(oldEv && oldEv.blur === true);
  out.l2 = !!(oldEv && oldEv.text === "他那天在便利店门口把伞弄丢了");
  out.l3 = memoryBlockText(pl.used).indexOf("记不太清了") >= 0;
  out.l4 = !!(oldFact && oldFact.blur === false);
  out.l5 = !!(hotEv && hotEv.blur === false);
  const pn = pickMemories({ list: [mk({ kind: "event", text: "他那天在便利店门口把伞弄丢了", day: 40 })], nowDay: 70 });
  out.l6 = pn.used[0].blur === false;

  return out;
});

const eq = (n, a, b) => t(n, a === b, "实际=" + JSON.stringify(a) + " 期望=" + JSON.stringify(b));
const near = (n, a, b) => t(n, Math.abs(Number(a) - Number(b)) < 1e-9, "实际=" + a + " 期望=" + b);

console.log("\n【A】两字组与语义重合");
eq("「那把伞呢？」去掉标点后是 3 个两字组", res.g1, 3);
t("含「把伞」", res.g2 === true);
t("重叠率为 1（记忆的每个两字组都在他这句话里）", res.g3 === 1, String(res.g3));
eq("没有他的原话时语义分为 0", res.g4, 0);
eq("毫不相干时语义分为 0", res.g5, 0);

console.log("\n【B】情绪强度归一");
near("heat 5 → 1", res.h5, 1);
near("heat 3 → 0.6", res.h3, 0.6);
near("没标 heat 的 relationship → 0.6", res.hRel, 0.6);
near("没标 heat 的 fact → 0.2", res.hFact, 0.2);
near("没标 heat 的 event 也是 0.2（不给事件破格，否则计划永远排它后面）", res.hEvent, 0.2);
near("heat 9 被夹到 1", res.hOver, 1);
near("字符串 \"4\" 也认 → 0.8", res.hStr, 0.8);

console.log("\n【C】打分公式（0.35 语义 + 0.25 情绪 + 0.20 未完成 + 0.10 新近 + 0.10 关系）");
near("heat 5 + open + 当天 → 0.55", res.s1, 0.55);
near("没标 heat 的 event 当天 → 0.15", res.s2, 0.15);

console.log("\n【D】排序：内容命中的压过固定 kind 顺序");
t("问「那把伞哪去了」，进来的是伞那条而不是攒钱计划", String(res.d1).indexOf("伞") >= 0, String(res.d1));
// 分母是记忆那条的两字组（8 组），他这句话命中「那把」「把伞」两组 = 0.25。
// 不追求高分：两条两字重合就足够把它从第 3 名顶到第 1 名。
t("它的语义重合 > 0.2（命中「那把」「把伞」两组）", res.d2 > 0.2, String(res.d2));
t("它的总分 > 0.3", res.d3 > 0.3, String(res.d3));
t("used 每条都带 score/sem/heat/open（检查器能看见为什么是它）", res.d4 === true);
eq("没给他这句话时，情绪强度照样把那条 event 顶上去", res.d5, "event");
eq("全都没标 heat/open 时才回落到 kind 顺序（goal 第一）", res.d6, "goal");

console.log("\n【E】promise 类别");
eq("promise 的 why 是「她答应过的事」", res.e1, "她答应过的事");
eq("没兑现的旧承诺不被新承诺顶掉", res.e2, 0);
eq("已经兑现/放下的旧承诺照常被顶掉", res.e3, 1);
eq("fact 的老行为不变（同槽位仍被取代）", res.e4, 1);

console.log("\n【F】她突然想起来");
eq("7 条当天相关 + 1 条 20 天前带情绪 → 抽中 1 条", res.f1, 1);
t("抽中的正是那条很久以前的事", res.f2 === true);
t("memoryBlockText 给它加了「（她突然想起来）」前缀", res.f3 === true);
eq("今天刚说的不算想起来", res.f4, 0);
eq("钉住的不参与", res.f5, 0);
eq("老备份迁来的（日期不可信）不参与", res.f6, 0);
eq("他这一轮正提到它 → 不算突然想起来", res.f7, 0);
eq("总数不到 4 条时不抽（免得变成回忆录）", res.f8, 0);

console.log("\n【G】小说模式");
t("小说模式完全不打分（score/sem 全是 0）", res.g6 === true);
eq("小说模式不抽「突然想起来」", res.g7, 0);
eq("小说模式 relationship 排最前", res.g8, "relationship");

console.log("\n【H】pinned 绝对优先");
t("钉住的排在第一，哪怕另一条分更高", res.h1 === true);
eq("它的 why 是「你钉住的」", res.h2, "你钉住的");

console.log("\n【I】老数据与非法值");
eq("heat 5.6 → 5", res.i1, 5);
eq("heat -3 → 0", res.i2, 0);
eq("heat \"abc\" → 0", res.i3, 0);
eq("open: \"true\"（字符串）不算真", res.i4, false);
eq("open: true 保留", res.i5, true);
eq("老备份没有 heat → 0", res.i6, 0);
eq("老备份没有 open → false", res.i7, false);
eq("仍是记忆 OS v2 格式", res.i8, 2);

console.log("\n【J】被挤掉的仍带原因");
t("条数满了会进 dropped", res.j1 > 0, String(res.j1));
t("dropped 每条都有 reason", res.j2 === true);

console.log("\n【L】选择性遗忘（琐事模糊，事实与有情绪的不动）");
t("60 天前、没标强度的琐事 → 注入行换成模糊版", res.l1 === true);
t("原文没被改（检查器/导出/备份里还是原话）", res.l2 === true);
t("memoryBlockText 里出现「记不太清了」", res.l3 === true);
t("事实不会因为久远而模糊（模糊了她会答错）", res.l4 === true);
t("带情绪强度的旧事不模糊", res.l5 === true);
t("不到 45 天不模糊", res.l6 === true);

// ---------------------------------------------------------------------------
// K. 提炼链路：heat / open / promise 从模型输出一路带到库里（源码断言）
// ---------------------------------------------------------------------------
// parseMemJson / memRecFromItem 没有 export，跑不到函数层，只能读源码：
// 这三处任何一处漏了，前面 9 组测试全绿、真机上 heat 也永远进不了库。
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const appSrc = stripComments(fs.readFileSync(path.join(WWW, "js", "app.js"), "utf8"));
const memSrc = stripComments(fs.readFileSync(path.join(WWW, "js", "memory.js"), "utf8"));
const pickSrc = stripComments(fs.readFileSync(path.join(WWW, "js", "mempick.js"), "utf8"));

console.log("\n【K】提炼链路接线");
t("MEM_OUTPUT_SHAPE 让模型回 heat 与 open", appSrc.indexOf('\"heat\":0,\"open\":false') >= 0);
t("类别说明里补了 promise", appSrc.indexOf("promise") >= 0 && appSrc.indexOf("说定的事") >= 0);
t("parseMemJson 产出 heat（夹到 0~5）", appSrc.indexOf("Math.max(0, Math.min(5, Math.round(n)))") >= 0);
t("parseMemJson 产出 open（只认 true）", appSrc.indexOf("open: x.open === true") >= 0);
t("memRecFromItem 把 heat 带进库", appSrc.indexOf("Math.max(0, Math.min(5, Math.round(Number(it.heat))))") >= 0);
t("memRecFromItem 把 open 带进库", appSrc.indexOf("open: it.open === true") >= 0);
t("memory.js 的八类里有 promise", memSrc.indexOf("'promise'") >= 0);
t("normalizeMemory 产出 heat", memSrc.indexOf("out.heat = (() =>") >= 0);
t("planSupersede 跳过没兑现的承诺", memSrc.indexOf("kind === 'promise' && old.open === true") >= 0);
t("打分函数按方案权重（0.35/0.25/0.20/0.10/0.10）", pickSrc.indexOf("0.35 * sem + 0.25 * heat + 0.20 * open + 0.10 * rec + 0.10 * rel") >= 0);
t("pickMemories 接收 userText", pickSrc.indexOf("opts.userText") >= 0);
const userTextCalls = (appSrc.match(/userText:\s*visibleText/g) || []).length;
t("app.js 三处检索都把他的原话传了进去（群聊两条 + 单聊一条）", userTextCalls >= 3, String(userTextCalls));
t("没有 pageerror", errs.length === 0, errs.join(" | "));

await browser.close();
server.close();

console.log("\n通过 " + pass + " 项 / 失败 " + fail + " 项");
process.exit(fail ? 1 : 0);
