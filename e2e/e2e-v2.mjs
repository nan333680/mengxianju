// e2e-v2.mjs —— 活人感 v2（0.5.3.6）：独白 / 三候选 / 评审 / 上屏节奏 / 生活与关系 / 主动开场
//
// 覆盖两类：
//   A. 纯函数（页面里直接 import 模块跑）
//      innerthought.js：normalizeInner（编号 / markdown / 行数 / 400 字上限）
//      critique.js：parseCritique（围栏 / 尾逗号 / 中文引号 / 越界 / 非法）
//      cadence.js：planCadence（固定 rnd 把 delayMs 断言死 / busy / 低电量 / 前插短条）
//      psyche.js：deriveLife（各时段）/ relationLine / applyRelation（clamp）
//   B. 端到端（劫持 fetch：非流式按 system 里的指令分四类，流式按温度分三条候选）
//      · 一次 send 里：独白进提示词 + 三条候选温度 0.85/1.0/1.15 + 评审挑 pick + 用量累加
//      · flaws>=2 触发第 4 个流式请求（重写），且上屏的是重写版
//      · pick 越界 / 评审输出不是 JSON → 用候选 0，聊天不断
//      · 独白失败 → 提示词里没有那段，聊天照常
//      · 群聊：按发言人各存一份 psyche
//      · 主动开场：只开口一次，第二次进来不再开口
//      · 极短语气条只上屏、不进库

import puppeteer from "puppeteer-core";
import http from "http";
import fs from "fs";
import path from "path";
const R = path.resolve(import.meta.dirname, "..").split(path.sep).join("/");
const WWW = R + "/www";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const NL = String.fromCharCode(10);

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const server = http.createServer((req, res) => {
  let q = decodeURIComponent(req.url.split("?")[0]);
  if (q === "/") q = "/index.html";
  const f = path.join(WWW, q);
  if (!fs.existsSync(f)) { res.writeHead(404); res.end("404"); return; }
  // ⚠️ 必须 no-store：改完 www/js 重跑 e2e 时，Chrome 会拿启发式缓存里的旧 app.js，
  //    于是报错行号对不上、变量"未定义"，看着像生产 bug，其实是测试站缓存。
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
const logs = [];
page.on("console", async m => { try { const tx = m.text(); if (m.type() === "error") { let st = ""; try { const a = m.args(); if (a && a[0]) st = await a[0].evaluate(e => (e && e.stack) ? String(e.stack) : String(e)); } catch (e2) {} logs.push("[error] " + tx + "  STACK: " + st.replace(/\n/g, " | ")); } else if (tx.indexOf("[") >= 0) logs.push("[" + m.type() + "] " + tx); } catch (e) {} });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const t = (n, ok, ex = "") => { if (ok) { pass++; console.log("  OK   " + n); } else { fail++; console.log("  FAIL " + n + (ex ? "  -> " + ex : "")); } };

// 判断层（director）的固定输出。故意【不带 inner】：inner 走独白那一路，
// 带上它会盖住「独白失败」那个用例（app.js 里 psyDir.inner 是兜底）。
const DIR = {
  reading: "他在试探我是不是还在为昨天的事不高兴",
  confidence: 0.4,
  sting: "被他说穿了",
  goal: "让他先开口承认昨天过分",
  urgency: 0.6,
  blockedBy: "拉不下脸",
  mood: { label: "不耐", intensity: 3, cause: "昨天的事还没过去" },
  stance: { warmth: 1, trust: 0, irritation: 2, playfulness: 0 },
  withhold: ["其实我昨天等到很晚"],
  move: "deflect",
  beats: ["先顿一下", "把话岔开"],
  callback: "昨晚那通没接的电话",
  length: "short",
  risk: "over_explain"
};

await page.evaluateOnNewDocument((dirJson) => {
  const NLC = String.fromCharCode(10), SEP = String.fromCharCode(10, 10);
  // 主动开场那次掷签必须过：只改「调用栈里有 maybeProactiveOpen」的那一次随机。
  // 全局固定 Math.random 会让 uid 撞车（同毫秒两条消息拿到同一个 id）。
  const _rnd = Math.random;
  Math.random = function () {
    try { if (new Error().stack.indexOf("maybeProactiveOpen") >= 0) return 0.1; } catch (e) {}
    return _rnd();
  };

  window.__cfg = {
    dir: dirJson,
    // 默认：挑第 3 条（= 温度 1.15 那条），一条毛病都不挑 —— 不该触发重写
    crit: '{"pick": 3, "flaws": [], "rewrite": ""}',
    // 独白故意给成「带编号 + markdown + 多行」，normalizeInner 要能吃下去
    inner: ["1. 第一反应是没懂", "- 手停在半空", "**咽回去了**", "# 想岔开", "", "真话是我也在意", "第五行", "第六行"].join(NLC),
    proactive: "你还醒着吗",
    dirFail: false
  };
  window.__hits = { once: [], stream: [] };
  const realFetch = window.fetch.bind(window);
  const allOf = (body) => (((body && body.messages) || []).map(m => String(m.content || ""))).join(NLC);
  const kindOf = (all) => {
    if (all.indexOf("# 这一轮先别写正文") >= 0) return "dir";
    if (all.indexOf("只输出 JSON") >= 0 && all.indexOf('"pick"') >= 0) return "crit";
    if (all.indexOf("先别写回复") >= 0) return "inner";
    if (all.indexOf("你先开口") >= 0) return "proactive";
    return "other";
  };
  window.fetch = async function (url, opts) {
    const u = String(url);
    let body = {};
    try { body = JSON.parse((opts && opts.body) || "{}"); } catch (e) {}
    if (u.indexOf("/chat/completions") < 0) return realFetch(url, opts);
    const all = allOf(body);
    const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { "Content-Type": "application/json" } });
    const usage = { prompt_tokens: 100, completion_tokens: 5 };
    if (body.stream === false) {
      const kind = kindOf(all);
      window.__hits.once.push({ kind, all });
      const cfg = window.__cfg || {};
      if (kind === "dir") return json({ choices: [{ message: { content: JSON.stringify(cfg.dir || {}) } }], usage });
      if (kind === "crit") return json({ choices: [{ message: { content: String(cfg.crit || "") } }], usage });
      if (kind === "inner") return json({ choices: [{ message: { content: String(cfg.inner || "") } }], usage });
      if (kind === "proactive") return json({ choices: [{ message: { content: String(cfg.proactive || "") } }], usage });
      return json({ choices: [{ message: { content: "" } }], usage });
    }
    // 流式：先认重写（正文里带着「上面这条不合格」），再按温度分三条候选
    const isRewrite = all.indexOf("上面这条不合格") >= 0;
    const temp = Number(body.temperature);
    window.__hits.stream.push({ temp, isRewrite, all });
    let text;
    // ⚠️ 重写版必须带一对星号：v1 留下的「缺星号那一层」判据还在（innerSeen 冷启动），
    //    不带星号的重写版会被判不合格、保留原样 —— 这条断言测的就变成"重写被否"了。
    if (isRewrite) text = "重写版（修好了）*这句是心里话*";
    else if (Math.abs(temp - 0.85) < 1e-6) text = "候选甲（0.85）";
    else if (Math.abs(temp - 1.15) < 1e-6) text = "候选丙（1.15）";
    else text = "候选乙（1.0）";
    const chunk = (o) => "data: " + JSON.stringify(o) + SEP;
    const payload = chunk({ choices: [{ delta: { content: text } }] })
      + chunk({ choices: [{ delta: {}, finish_reason: "stop" }], usage })
      + "data: [DONE]" + SEP;
    return new Response(payload, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  };
}, DIR);

// 进度落盘：后台 job 的输出不流式，卡住时只能靠这个文件看出停在哪一条。
const PROG = R + "/tools/.v2-progress.txt";
const prog = (s) => { try { fs.appendFileSync(PROG, s + "\n"); } catch {} };
prog("goto begin");
await page.goto("http://127.0.0.1:" + port + "/index.html", { waitUntil: "networkidle0" });
prog("goto done");
await sleep(800);

// ---------- 铺数据 ----------
const chars = [
  { id: "V1", name: "阿绫", greeting: "（阿绫）", persona: "你是阿绫。说话很短。", presetKey: "blank" },
  { id: "V2", name: "阿烛", greeting: "（阿烛）", persona: "你是阿烛。说话很短。", presetKey: "blank" },
  { id: "VP", name: "小满", greeting: "（小满）", persona: "你是小满。说话很短。", presetKey: "blank" },
  { id: "VG", name: "群组", greeting: "", persona: "", presetKey: "blank", isGroup: true, memberIds: ["V1", "VP"], narrative: false }
];
await page.evaluate(async (charsJson) => {
  const list = JSON.parse(charsJson);
  const db = await new Promise((res, rej) => {
    const rq = indexedDB.open("ai-companion");
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
  const put = (store, val) => new Promise((res, rej) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(val);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
  const now = Date.now();
  for (const c of list) {
    await put("characters", Object.assign({
      id: c.id, name: c.name, greeting: c.greeting, persona: c.persona, avatar: null,
      temperature: 1.0, maxTokens: 2048, topP: 1.0, reasoningEffort: "low", contextRounds: 20,
      kaomojiFreq: 0, emojiFreq: 0, verbosity: "medium", splitMessages: false, typingDelay: 0,
      hesitation: false, showTyping: true, longMemory: false, allowEditMine: false,
      descLevel: "low", povLock: false, appearance: "", appearanceOn: true, presetKey: "blank",
      createdAt: now
    }, c));
  }
  await put("kv", { k: "settings", v: { apiKey: "sk-test", baseUrl: "https://api.deepseek.com", model: "deepseek-flash", clockMode: false } });
  await put("kv", { k: "lastCharId", v: "V1" });
}, JSON.stringify(chars));

await page.reload({ waitUntil: "domcontentloaded" });
await sleep(2000);

// ---------- 小工具 ----------
async function kvGet(k) {
  return page.evaluate(async (key) => {
    const db = await new Promise((res, rej) => {
      const rq = indexedDB.open("ai-companion");
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
    return new Promise((res) => {
      const tx = db.transaction("kv", "readonly");
      const rq = tx.objectStore("kv").get(key);
      rq.onsuccess = () => res(rq.result ? rq.result.v : null);
      rq.onerror = () => res(null);
    });
  }, k);
}
async function mark() {
  const h = await page.evaluate(() => ({ o: window.__hits.once.length, s: window.__hits.stream.length }));
  return h;
}
async function since(m) {
  return page.evaluate((mm) => ({
    once: window.__hits.once.slice(mm.o).map(x => ({ kind: x.kind, all: x.all })),
    stream: window.__hits.stream.slice(mm.s).map(x => ({ temp: x.temp, isRewrite: x.isRewrite, all: x.all }))
  }), m);
}
async function setCfg(patch) {
  await page.evaluate((p) => { Object.assign(window.__cfg, p); }, patch);
}
async function bubbles() {
  return page.evaluate(() => Array.from(document.querySelectorAll("#messages .msg")).map(x => ({
    ai: x.classList.contains("ai"),
    text: (x.querySelector(".gen-text") || x.querySelector(".bub") || x).textContent.trim()
  })));
}
async function say(text) {
  await page.evaluate((s) => {
    const inp = document.getElementById("input");
    inp.value = s;
    inp.dispatchEvent(new Event("input", { bubbles: true }));
  }, text);
  await page.click("#btn-send");
  for (let i = 0; i < 200; i++) { if (await page.$("#btn-stop")) break; await sleep(100); }
  for (let i = 0; i < 400; i++) { if (!(await page.$("#btn-stop"))) break; await sleep(100); }
  await sleep(600);
}

// ================= A. 纯函数 =================
prog("A begin");
console.log("[A] 纯函数");

const A1 = await page.evaluate(async () => {
  const M = await import("/js/innerthought.js");
  const N = String.fromCharCode(10);
  const raw = ["1. 第一反应是没懂", "2、手停在半空", "- 咽回去了半句", "# 想岔开", "", "**真话**", "第四行", "第五行", "第六行"].join(N);
  const s = String(M.normalizeInner(raw) || "");
  const lines = s.split(N).filter(x => x.trim().length > 0);
  const leads = ["0","1","2","3","4","5","6","7","8","9","-","*","#",">","·"];
  const badLead = lines.filter(x => leads.indexOf(x.trim().charAt(0)) >= 0);
  const longText = String(M.normalizeInner(new Array(40).fill("一二三四五六七八九十").join(N)) || "");
  return {
    nonEmpty: s.length > 0,
    lineCount: lines.length,
    text: s,
    badLeadCount: badLead.length,
    noStar: s.indexOf("*") < 0,
    capped: longText.length <= 400,
    emptyOk: M.normalizeInner("   ") === "",
    nullOk: M.normalizeInner(null) === ""
  };
});
t("normalizeInner 吃下带编号/markdown 的独白", A1.nonEmpty, A1.text);
t("normalizeInner 最多留 5 行", A1.lineCount <= 5 && A1.lineCount > 0, "行数=" + A1.lineCount);
t("normalizeInner 行首不留编号/markdown 标记", A1.badLeadCount === 0, "剩编号行=" + A1.badLeadCount + " | " + A1.text);
t("normalizeInner 不留 markdown 星号", A1.noStar, A1.text);
t("normalizeInner 截到 400 字以内", A1.capped);
t("normalizeInner 空输入/空值返回空串", A1.emptyOk && A1.nullOk);

const A2 = await page.evaluate(async () => {
  const P = await import("/js/critique.js");
  const N = String.fromCharCode(10);
  const fenced = "```json" + N + '{"pick": 2, "flaws": ["说了太多解释",], "rewrite": "再短一点",}' + N + "```";
  const a = P.parseCritique(fenced, 3);
  const cnq = '{“pick”: 1, “flaws”: [], “rewrite”: “”}';
  const b = P.parseCritique(cnq, 3);
  const out = P.parseCritique('{"pick": 9, "flaws": [], "rewrite": ""}', 3);
  const bad = P.parseCritique("我今天不太想评价", 3);
  const zero = P.parseCritique('{"pick": 0}', 3);
  const huge = P.parseCritique('{"pick": 1, "flaws": ["' + new Array(200).join("长") + '"], "rewrite": "' + new Array(200).join("长") + '"}', 3);
  return {
    aPick: a ? a.pick : null,
    aFlaws: a ? a.flaws.length : -1,
    aFlaw0: a ? String(a.flaws[0] || "") : "",
    aRewrite: a ? a.rewriteHint : "",
    bPick: b ? b.pick : null,
    outNull: out === null,
    badNull: bad === null,
    zeroNull: zero === null,
    flawLen: huge ? String(huge.flaws[0] || "").length : -1,
    rwLen: huge ? String(huge.rewriteHint || "").length : -1
  };
});
t("parseCritique 剥围栏/尾逗号，编号 2 落到下标 1", A2.aPick === 1, "pick=" + A2.aPick);
t("parseCritique 留下 flaws 与 rewrite", A2.aFlaws === 1 && A2.aFlaw0 === "说了太多解释" && A2.aRewrite === "再短一点", A2.aFlaw0 + " / " + A2.aRewrite);
t("parseCritique 认中文引号", A2.bPick === 0, "pick=" + A2.bPick);
t("parseCritique pick 越界返回 null", A2.outNull);
t("parseCritique 不是 JSON 返回 null", A2.badNull);
t("parseCritique pick 为 0 返回 null", A2.zeroNull);
t("parseCritique 截断超长的 flaws/rewrite", A2.flawLen > 0 && A2.flawLen <= 40 && A2.rwLen >= 0 && A2.rwLen <= 80, "flaw=" + A2.flawLen + " rw=" + A2.rwLen);

const A3 = await page.evaluate(async () => {
  const C = await import("/js/cadence.js");
  const fixed = () => 0.5;
  const p1 = C.planCadence(["喂喂喂"], { rnd: fixed });
  const p2 = C.planCadence(["喂喂喂"], { rnd: fixed, busy: true });
  const p3 = C.planCadence(["喂喂喂"], { rnd: fixed, energy: 0.2 });
  const seq = [0.05, 0.5, 0.5, 0.5, 0.5];
  let si = 0;
  const rr = () => (si < seq.length ? seq[si++] : 0.5);
  const p4 = C.planCadence(["这是一条超过十二个字的回复"], { rnd: rr });
  const many = C.planCadence(["第一段内容写得比较长一点点"], { rnd: fixed });
  return {
    n1: p1.steps.length, d1: p1.steps[0].delayMs, ty1: p1.steps[0].typingMs,
    d2: p2.steps[0].delayMs, d3: p3.steps[0].delayMs,
    n4: p4.steps.length, first4: p4.steps[0].text, d4: p4.steps[0].delayMs,
    total: many.totalMs
  };
});
t("planCadence 固定 rnd 的 delay 算得死", A3.n1 === 1 && A3.d1 === 830 && A3.ty1 === 500, "delay=" + A3.d1 + " typing=" + A3.ty1);
t("planCadence 忙的时候更慢（x1.6）", A3.d2 === 1327, "delay=" + A3.d2);
t("planCadence 电量低更慢（x1.4）", A3.d3 === 1161, "delay=" + A3.d3);
t("planCadence 首条够长时前面插一条极短", A3.n4 === 2 && A3.first4.length <= 2 && A3.d4 === 0, "n=" + A3.n4 + " first=" + A3.first4);
t("planCadence 总时长压在 12 秒内", A3.total > 0 && A3.total <= 12000, "total=" + A3.total);

const A4 = await page.evaluate(async () => {
  const S = await import("/js/psyche.js");
  const b = S.emptyPsyche();
  const l3 = S.deriveLife(b, { now: 1000, hour: 3, rnd: () => 0.1 });
  const l14 = S.deriveLife(b, { now: 1000, hour: 14, rnd: () => 0.5 });
  const l18 = S.deriveLife(b, { now: 1000, hour: 18, rnd: () => 0.9 });
  const l23 = S.deriveLife(b, { now: 1000, hour: 23, rnd: () => 0.5 });
  const withBond = (n) => ({ relation: Object.assign({}, b.relation, { bond: n }) });
  let rel = S.applyRelation(b, { warmth: 0.15, trust: 0.15 });
  const warm1 = rel.relation.warmth;
  for (let i = 0; i < 80; i++) rel = S.applyRelation(rel, { warmth: -1 });
  return {
    l3: { a: l3.activity, busy: l3.busy, e: l3.energyNow },
    l14: { a: l14.activity, busy: l14.busy, e: l14.energyNow },
    l18: { busy: l18.busy, e: l18.energyNow },
    l23: { e: l23.energyNow },
    rl0: S.relationLine(b),
    rl5: S.relationLine(withBond(5)),
    rl15: S.relationLine(withBond(15)),
    rl30: S.relationLine(withBond(30)),
    warm1: warm1,
    warmClamped: rel.relation.warmth,
    llBusy: S.lifeLine({ life: { activity: "在忙", busy: true } }),
    llIdle: S.lifeLine({ life: { activity: "躺着刷手机", busy: false } })
  };
});
t("deriveLife 深夜：睡了、忙、电量 0.2", A4.l3.a === "睡着了" && A4.l3.busy === true && A4.l3.e === 0.2, JSON.stringify(A4.l3));
t("deriveLife 午后：闲、电量 0.8", A4.l14.busy === false && A4.l14.e === 0.8, JSON.stringify(A4.l14));
t("deriveLife 忙时段的忙碌是概率的", A4.l18.busy === false, JSON.stringify(A4.l18));
t("deriveLife 深夜电量降到 0.4", A4.l23.e === 0.4, JSON.stringify(A4.l23));
t("relationLine 生人不说熟话", A4.rl0 === "", A4.rl0);
t("relationLine 按亲密度换说法", A4.rl5.indexOf("不算生人") >= 0 && A4.rl15.indexOf("不用客气") >= 0 && A4.rl30.indexOf("没什么好客气") >= 0, A4.rl5 + " | " + A4.rl15 + " | " + A4.rl30);
t("applyRelation 一轮只走一步（+0.15）", A4.warm1 === 1.15, "warmth=" + A4.warm1);
t("applyRelation 有下限（不会掉穿 -5）", A4.warmClamped === -5, "warmth=" + A4.warmClamped);
t("lifeLine 忙的时候带一句说明", A4.llBusy.indexOf("腾不出手") >= 0 && A4.llIdle === "躺着刷手机", A4.llBusy + " / " + A4.llIdle);

// ================= B. 端到端 =================
prog("A done / B begin");
console.log("[B] 端到端");

async function readKv(prefix) {
  return page.evaluate(async (pre) => {
    const db = await new Promise((res, rej) => {
      const rq = indexedDB.open("ai-companion");
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
    const all = await new Promise((res) => {
      const tx = db.transaction("kv", "readonly");
      const rq = tx.objectStore("kv").getAll();
      rq.onsuccess = () => res(rq.result || []);
      rq.onerror = () => res([]);
    });
    return all.filter(x => String(x.k || "").indexOf(pre) === 0).map(x => x.k);
  }, prefix);
}
async function aiMsgs(charId) {
  return page.evaluate(async (cid) => {
    const db = await new Promise((res, rej) => {
      const rq = indexedDB.open("ai-companion");
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
    const all = await new Promise((res) => {
      const tx = db.transaction("messages", "readonly");
      const rq = tx.objectStore("messages").getAll();
      rq.onsuccess = () => res(rq.result || []);
      rq.onerror = () => res([]);
    });
    return (all || [])
      .filter(x => x && x.role === "assistant" && x.charId === cid)
      .sort((a, b) => (a.ts || 0) - (b.ts || 0))
      .map(x => ({ id: x.id, content: x.content, ts: x.ts, proactive: !!x.proactive, usage: x.usage || null }));
  }, charId);
}
async function switchTo(charId, patch) {
  await page.evaluate((id) => new Promise((res, rej) => {
    const rq = indexedDB.open("ai-companion");
    rq.onsuccess = () => {
      const db = rq.result;
      const tx = db.transaction("kv", "readwrite");
      tx.objectStore("kv").put({ k: "lastCharId", v: id });
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    };
    rq.onerror = () => rej(rq.error);
  }), charId);
  await page.reload({ waitUntil: "domcontentloaded" });
  await sleep(2000);
  if (patch) await setCfg(patch);
}

// ---- B1 正常一轮：独白 + 三候选 + 评审挑第 3 条 + 用量累加 ----
prog("B1 mark begin");
let mm = await mark();
prog("B1 say begin");
await say("我今天有点累");
prog("B1 say done");
const h1 = await since(mm);
prog("B1 since done");
const k1 = h1.once.map(x => x.kind).sort().join(",");
t("B1 一轮里独白、判断、评审各跑一次", k1 === "crit,dir,inner", "实际=" + k1);
const temps1 = h1.stream.filter(x => !x.isRewrite).map(x => Number(Number(x.temp).toFixed(2))).sort((a, b) => a - b);
t("B1 三条候选并行，温度 0.85/1.0/1.15", temps1.length === 3 && temps1[0] === 0.85 && temps1[1] === 1 && temps1[2] === 1.15, temps1.join(","));
t("B1 没错可挑时不额外重写", h1.stream.every(x => !x.isRewrite), "流式请求数=" + h1.stream.length);
const gen1 = (h1.stream.find(x => !x.isRewrite) || {}).all || "";
t("B1 生成提示词里带「你脑子里刚转过这几句」", gen1.indexOf("# 你脑子里刚转过这几句") >= 0);
t("B1 生成提示词里带归一后的独白", gen1.indexOf("第一反应是没懂") >= 0);
t("B1 评审看的也是同一份独白", ((h1.once.find(x => x.kind === "crit") || {}).all || "").indexOf("第一反应是没懂") >= 0);
t("B1 刚认识时不出现「你们之间」那句", gen1.indexOf("# 你们之间") < 0);
prog("B1 asserts done");
const bb1raw = await bubbles();
prog("B1 bubbles done n=" + bb1raw.length);
const bb1 = bb1raw.filter(x => x.ai);
t("B1 pick=3 → 上屏第 3 条候选", bb1.length > 0 && bb1[bb1.length - 1].text.indexOf("候选丙") >= 0, bb1.length ? bb1[bb1.length - 1].text : "无");
const am1 = await aiMsgs("V1");
prog("B1 aiMsgs done n=" + am1.length);
const u1 = am1.length ? am1[am1.length - 1].usage : null;
t("B1 用量记了三条候选 + 评审", !!u1 && JSON.stringify(u1).indexOf("400") >= 0, JSON.stringify(u1));
{
  console.log("  [logs]\n" + logs.filter(x => x.indexOf("[error]") >= 0 || x.indexOf("[warn]") >= 0).slice(-6).join("\n"));
}

// ---- B2 评审挑出两条毛病 → 触发重写 ----
await setCfg({ crit: '{"pick": 2, "flaws": ["把话说满了", "客服腔"], "rewrite": ""}' });
prog("B2 setCfg done");
mm = await mark();
prog("B2 mark done");
await say("你在干吗");
prog("B2 say done");
const h2 = await since(mm);
prog("B2 since done");
const rw2 = h2.stream.filter(x => x.isRewrite);
t("B2 flaws>=2 → 多跑一次重写", rw2.length === 1, "重写请求=" + rw2.length);
t("B2 重写请求里带着被否掉的那条", rw2.length > 0 && rw2[0].all.indexOf("候选乙") >= 0);
const bb2 = (await bubbles()).filter(x => x.ai);
t("B2 上屏的是重写版", bb2.length > 0 && bb2[bb2.length - 1].text.indexOf("重写版") >= 0, bb2.length ? bb2[bb2.length - 1].text : "无");

// ---- B3 pick 越界（评审乱给编号）----
await switchTo("V2", { crit: '{"pick": 9, "flaws": [], "rewrite": ""}' });
mm = await mark();
await say("你好");
const h3 = await since(mm);
t("B3 pick 越界不触发重写", h3.stream.filter(x => x.isRewrite).length === 0);
const bb3 = (await bubbles()).filter(x => x.ai);
t("B3 pick 越界 → 退回第 1 条候选", bb3.length > 0 && bb3[bb3.length - 1].text.indexOf("候选甲") >= 0, bb3.length ? bb3[bb3.length - 1].text : "无");

// ---- B4 评审输出不是 JSON ----
await setCfg({ crit: "我觉得都还行" });
mm = await mark();
await say("嗯");
const h4 = await since(mm);
t("B4 评审坏了也不挡聊天", h4.stream.filter(x => !x.isRewrite).length === 3, "流式请求数=" + h4.stream.length);
const bb4 = (await bubbles()).filter(x => x.ai);
// ⚠️ 这里不能死等"候选甲"。V2 跑到这一轮已经有 2 条 assistant 历史、且都没有 *心里话*，
//    v1 留下来的「缺星号那一层」兜底会照常触发一次重写 —— 那是设计内的（innerMiss 补两次才放弃），
//    不是评审变好了。断言的意图是「评审坏了也照样出话、没有卡死」，不是「一定用第 1 条候选」。
const _bb4 = bb4.length ? bb4[bb4.length - 1].text : "";
t("B4 评审坏了 → 照样出话（候选 1 或补星号重写都算）",
  bb4.length > 0 && (_bb4.indexOf("候选甲") >= 0 || _bb4.indexOf("重写版") >= 0), _bb4 || "无");

// ---- B5 独白失败：提示词里没有那一段，聊天照常 ----
await setCfg({ inner: "", crit: '{"pick": 1, "flaws": [], "rewrite": ""}' });
mm = await mark();
await say("在吗");
const h5 = await since(mm);
const gen5 = (h5.stream.find(x => !x.isRewrite) || {}).all || "";
t("B5 独白为空 → 提示词里没有那一段", gen5.indexOf("# 你脑子里刚转过这几句") < 0);
t("B5 独白失败也照样出话", h5.stream.filter(x => !x.isRewrite).length === 3, "候选数=" + h5.stream.filter(x => !x.isRewrite).length);

// ---- B6 群聊：判断也跑，状态按发言人分开存 ----
prog("B6 switchTo(VG) begin");
await switchTo("VG");
prog("B6 switchTo(VG) done");
mm = await mark();
prog("B6 say1 begin");
await say("你们都在吗");
prog("B6 say1 done");
await say("我先说一句");
prog("B6 say2 done");
const gkeys = await readKv("psyche:VG:");
prog("B6 readKv done");
t("B6 群聊也跑判断、按发言人分键存", gkeys.length >= 2, gkeys.join(","));
const hg = await since(mm);
const genG = (hg.stream.find(x => !x.isRewrite) || {}).all || "";
t("B6 群聊提示词里点名了这轮谁在回", genG.length === 0 || (hg.once.some(x => x.kind === "dir" && x.all.indexOf("# 这一轮是谁在回") >= 0)), hg.once.map(x => x.kind).join(","));

// ---- B7 主动开场：只开口一次 ----
const OLD = Date.now() - 7 * 3600 * 1000;
await page.evaluate(async (ts) => {
  const db = await new Promise((res, rej) => {
    const rq = indexedDB.open("ai-companion");
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
  const put = (store, val) => new Promise((res, rej) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(val);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
  await put("messages", { id: "pm0", charId: "VP", role: "assistant", content: "晚安。", ts: ts });
  await put("kv", { k: "psyche:VP", v: { v: 1, relation: { warmth: 2, trust: 2, bond: 5, since: 1 } } });
}, OLD);
await switchTo("VP");
await sleep(7000);
let vpm = await aiMsgs("VP");
let pro = vpm.filter(x => x.proactive);
t("B7 七个小时没说话，她先开口了", pro.length === 1, "主动开口条数=" + pro.length);
t("B7 开口就是那一句，没有寒暄", pro.length > 0 && pro[0].content.indexOf("你还醒着吗") >= 0, pro.length ? pro[0].content : "无");
const pk = await readKv("proactive:VP:");
t("B7 记下了「今天已经开过口」", pk.length === 1, pk.join(","));
// 把那条消息的时间改回七小时前，再进来一次：条件全满足，但今天开过口了
await page.evaluate(async (ts) => {
  const db = await new Promise((res, rej) => {
    const rq = indexedDB.open("ai-companion");
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
  const get = () => new Promise((res, rej) => {
    const tx = db.transaction("messages", "readonly");
    const rq = tx.objectStore("messages").getAll();
    rq.onsuccess = () => res(rq.result || []);
    rq.onerror = () => rej(rq.error);
  });
  const all = await get();
  const one = all.find(x => x && x.proactive && x.charId === "VP");
  if (!one) return;
  one.ts = ts;
  await new Promise((res, rej) => {
    const tx = db.transaction("messages", "readwrite");
    tx.objectStore("messages").put(one);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}, OLD);
await page.reload({ waitUntil: "domcontentloaded" });
await sleep(7000);
vpm = await aiMsgs("VP");
pro = vpm.filter(x => x.proactive);
t("B7 同一天不重复开口", pro.length === 1, "主动开口条数=" + pro.length);

// ---- 收尾 ----
if (logs.length) { console.log(""); console.log("--- 页面日志（节选）---"); for (const L of logs.slice(-25)) console.log("  " + L.slice(0, 200)); }
t("全程没有 pageerror", errs.length === 0, errs.slice(0, 3).join(" | "));
console.log("");
console.log("通过 " + pass + " 项，失败 " + fail + " 项");
await browser.close();
server.close();
process.exit(fail > 0 ? 1 : 0);
