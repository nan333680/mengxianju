// e2e-liveoff.mjs —— 活人感 v2 总开关（0.5.3.6，用户 m02892 第 2 条）
//
// 用户要的是「两档：开 / 关，直接管理全部」，而且关掉必须【真的回到 0.5.3.5】：
// 少花钱、少请求、提示词里别残留 v2 的段落。
// 之所以单独开一套而不是塞进 e2e-v2：那边 52 项全是「开着」的行为，
// 混进来以后一旦有人说"关了怎么不对"，分不清是开关坏了还是 v2 坏了。
//
//   L1 关掉：一轮只有 1 次流式请求、0 次非流式请求
//   L2 关掉：生成提示词里没有「你脑子里刚转过这几句 / 你这会儿的状态 / 你们之间」
//   L3 关掉：回复照常上屏、照常落库（不能变成"关了就不说话"）
//   L4 打开（缺省）：独白 + 判断 + 评审都还在
//   L5 打开：提示词里那句「你脑子里刚转过这几句」回来了
//
// 视觉节奏、群聊、主动开场都不在这里测 —— 见 e2e-v2.mjs。

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
  // no-store：改完 www/js 重跑时别让 Chrome 拿缓存里的旧 app.js（踩过一次）
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
page.on("console", m => { try { const tx = m.text(); if (m.type() === "error" || tx.indexOf("[") >= 0) logs.push("[" + m.type() + "] " + tx); } catch (e) {} });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const t = (n, ok, ex = "") => { if (ok) { pass++; console.log("  OK   " + n); } else { fail++; console.log("  FAIL " + n + (ex ? "  -> " + ex : "")); } };

await page.evaluateOnNewDocument(() => {
  const NLC = String.fromCharCode(10), SEP = String.fromCharCode(10, 10);
  window.__cfg = {
    dir: { reading: "他在找我", confidence: 0.4, mood: { label: "平静", intensity: 2, cause: "" }, stance: { warmth: 1, trust: 0, irritation: 0, playfulness: 0 }, move: "answer", length: "short" },
    crit: '{"pick": 1, "flaws": [], "rewrite": ""}',
    inner: "第一反应是他又来消息了" + NLC + "手停在键盘上"
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
    const cfg = window.__cfg || {};
    if (body.stream === false) {
      const kind = kindOf(all);
      window.__hits.once.push({ kind, all });
      if (kind === "dir") return json({ choices: [{ message: { content: JSON.stringify(cfg.dir || {}) } }], usage });
      if (kind === "crit") return json({ choices: [{ message: { content: String(cfg.crit || "") } }], usage });
      if (kind === "inner") return json({ choices: [{ message: { content: String(cfg.inner || "") } }], usage });
      return json({ choices: [{ message: { content: "" } }], usage });
    }
    const isRewrite = all.indexOf("上面这条不合格") >= 0;
    const temp = Number(body.temperature);
    window.__hits.stream.push({ temp, isRewrite, all });
    let text;
    if (isRewrite) text = "重写版*心里那层*";
    else if (Math.abs(temp - 0.85) < 1e-6) text = "候选甲（0.85）";
    else if (Math.abs(temp - 1.15) < 1e-6) text = "候选丙（1.15）";
    else if (Math.abs(temp - 1.0) < 1e-6) text = "候选乙（1.0）";
    else text = "老路回复";
    const chunk = (o) => "data: " + JSON.stringify(o) + SEP;
    const payload = chunk({ choices: [{ delta: { content: text } }] })
      + chunk({ choices: [{ delta: {}, finish_reason: "stop" }], usage })
      + "data: [DONE]" + SEP;
    return new Response(payload, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  };
});

await page.goto("http://127.0.0.1:" + port + "/index.html", { waitUntil: "networkidle0" });
await sleep(600);

// ---------- 铺数据（开关先关着）----------
await page.evaluate(async () => {
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
  await put("characters", {
    id: "L1", name: "阿绫", greeting: "（阿绫）", persona: "你是阿绫。说话很短。", avatar: null,
    temperature: 1.0, maxTokens: 2048, topP: 1.0, reasoningEffort: "low", contextRounds: 20,
    kaomojiFreq: 0, emojiFreq: 0, verbosity: "medium", splitMessages: false, typingDelay: 0,
    hesitation: false, showTyping: true, longMemory: false, allowEditMine: false,
    descLevel: "low", povLock: false, appearance: "", appearanceOn: true, presetKey: "blank",
    createdAt: now
  });
  // ⚠️ apiKey 必须有假值：没有它前端根本不发请求，整套会"绿"得毫无意义
  await put("kv", { k: "settings", v: { apiKey: "sk-test", baseUrl: "https://api.deepseek.com", model: "deepseek-flash", clockMode: false, liveV2: false } });
  await put("kv", { k: "lastCharId", v: "L1" });
});
await page.reload({ waitUntil: "domcontentloaded" });
await sleep(1800);

// ---------- 小工具 ----------
async function mark() {
  return page.evaluate(() => ({ o: window.__hits.once.length, s: window.__hits.stream.length }));
}
async function since(m) {
  return page.evaluate((mm) => ({
    once: window.__hits.once.slice(mm.o).map(x => ({ kind: x.kind, all: x.all })),
    stream: window.__hits.stream.slice(mm.s).map(x => ({ temp: x.temp, isRewrite: x.isRewrite, all: x.all }))
  }), m);
}
async function bubbles() {
  return page.evaluate(() => Array.from(document.querySelectorAll("#messages .msg")).map(x => ({
    ai: x.classList.contains("ai"),
    text: (x.querySelector(".gen-text") || x.querySelector(".bub") || x).textContent.trim()
  })));
}
async function aiMsgs(charId) {
  return page.evaluate(async (id) => {
    const db = await new Promise((res, rej) => {
      const rq = indexedDB.open("ai-companion");
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
    const all = await new Promise((res, rej) => {
      const tx = db.transaction("messages", "readonly");
      const rq = tx.objectStore("messages").getAll();
      rq.onsuccess = () => res(rq.result || []);
      rq.onerror = () => rej(rq.error);
    });
    return all.filter(x => x && x.charId === id && x.role === "assistant");
  }, charId);
}
async function say(text) {
  await page.evaluate((s) => {
    const inp = document.getElementById("input");
    inp.value = s;
    inp.dispatchEvent(new Event("input", { bubbles: true }));
  }, text);
  await page.click("#btn-send");
  // 等这一轮结束：停止按钮连续几拍不可见就算收工。
  // ⚠️ 不能只等"出现过再消失"：关掉时一轮几十毫秒就跑完，检测不到出现过，
  //    会白等满整段循环（e2e-v2 里的写法在这里要 20 秒）。这里两头都顾。
  let quiet = 0;
  for (let i = 0; i < 400; i++) {
    const vis = await page.evaluate(() => {
      const b = document.getElementById("btn-stop");
      return !!(b && !b.classList.contains("hidden"));
    });
    if (vis) quiet = 0; else quiet++;
    if (quiet >= 5 && i > 6) break;
    await sleep(100);
  }
  await sleep(800);
}

// ================= L. 开关关掉 =================
console.log("[L] 关掉总开关");
let mm = await mark();
await say("在吗");
const h1 = await since(mm);
const nS1 = h1.stream.length;
const nO1 = h1.once.length;
t("L1 关掉后一轮只有 1 次流式请求", nS1 === 1, "实际=" + nS1);
t("L1 关掉后没有独白 / 判断 / 评审（0 次非流式）", nO1 === 0, "实际=" + nO1 + "：" + h1.once.map(x => x.kind).join(","));
const gen1 = (h1.stream[0] || {}).all || "";
t("L2 关掉后提示词里没有「你脑子里刚转过这几句」", gen1.indexOf("# 你脑子里刚转过这几句") < 0);
t("L2 关掉后提示词里没有「你这会儿的状态」", gen1.indexOf("# 你这会儿的状态") < 0);
t("L2 关掉后提示词里没有「你们之间」", gen1.indexOf("# 你们之间") < 0);
t("L2 关掉后提示词里没有「这一轮心里在发生什么」", gen1.indexOf("# 你这一轮心里在发生什么") < 0);
const bb1 = (await bubbles()).filter(x => x.ai);
t("L3 关掉后回复照常上屏", bb1.length > 0 && bb1[bb1.length - 1].text.indexOf("候选乙") >= 0, bb1.length ? bb1[bb1.length - 1].text : "无");
const am1 = await aiMsgs("L1");
t("L3 关掉后照常落库", am1.length >= 1, "assistant 条数=" + am1.length);

// ================= LO. 开关打开 =================
console.log("[LO] 打开总开关");
await page.evaluate(async () => {
  const db = await new Promise((res, rej) => {
    const rq = indexedDB.open("ai-companion");
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
  await new Promise((res, rej) => {
    const tx = db.transaction("kv", "readwrite");
    tx.objectStore("kv").put({ k: "settings", v: { apiKey: "sk-test", baseUrl: "https://api.deepseek.com", model: "deepseek-flash", clockMode: false, liveV2: true } });
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
});
await page.reload({ waitUntil: "domcontentloaded" });
await sleep(1800);
mm = await mark();
await say("再说一句");
const h2 = await since(mm);
const kinds = h2.once.map(x => x.kind).sort().join(",");
t("L4 打开后独白 + 判断 + 评审都在", kinds === "crit,dir,inner", "实际=" + kinds);
const temps = h2.stream.filter(x => !x.isRewrite).map(x => Number(Number(x.temp).toFixed(2))).sort((a, b) => a - b);
t("L4 打开后候选还是三条（0.85/1.0/1.15）", temps.length === 3 && temps[0] === 0.85 && temps[1] === 1 && temps[2] === 1.15, temps.join(","));
const gen2 = (h2.stream.find(x => !x.isRewrite) || {}).all || "";
t("L5 打开后「你脑子里刚转过这几句」回来了", gen2.indexOf("# 你脑子里刚转过这几句") >= 0);

// ---- 收尾 ----
if (logs.length) { console.log(""); console.log("--- 页面日志（节选）---"); for (const L of logs.slice(-12)) console.log("  " + L.slice(0, 200)); }
t("全程没有 pageerror", errs.length === 0, errs.slice(0, 3).join(" | "));
console.log("");
console.log("通过 " + pass + " 项，失败 " + fail + " 项");
await browser.close();
server.close();
process.exit(fail > 0 ? 1 : 0);
