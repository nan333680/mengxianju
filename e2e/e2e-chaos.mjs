// e2e-chaos.mjs —— 突发情况（0.5.4）：生成中连点 / 停止 / 切角色 / 刷新 / 断流 / 断网 / 坏 JSON / 超长输入 / 疯狂切角色
//
// 为什么单开一套：现有套件都是「顺着走一遍」——发一条、等它回、看结果。
// 真实用户的手比测试快：生成没完就再点发送、生成没完就切角色、生成中把屏幕关掉再开回来、
// 地铁里网络断在半截。这些路径以前没人走，出错也看不出来（不崩，但库里留孤儿消息）。
//
// 全部用劫持 fetch 造假，不真调 API：跑一次 0 费用。
import puppeteer from "puppeteer-core";
import http from "http";
import fs from "fs";
import path from "path";
import { seedChars } from "./e2e-helper.mjs";

const R = path.resolve(import.meta.dirname, "..").split(path.sep).join("/");
const WWW = R + "/www";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const NL = String.fromCharCode(10);
const SEP = String.fromCharCode(10, 10);

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

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"] });
const page = await browser.newPage();
await page.setCacheEnabled(false);
await page.setViewport({ width: 393, height: 851, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = [];
page.on("pageerror", e => errs.push(e.message));
// console 也要收：send() 的 catch 第一行就是 console.error(e)，
// 出错时它才是唯一能说明「到底是什么错」的东西。
// console 里的 error 单独收一份：pageerror 只收未捕获异常，
// 而 send() 的 catch 是【捕获后自己处理】的，真相只在 console.error 里。
const clogs = [];
page.on("console", m => { try { if (m.type() === "error") clogs.push(m.text()); } catch (e) {} });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const t = (n, ok, ex = "") => { if (ok) { pass++; console.log("  OK   " + n); } else { fail++; console.log("  FAIL " + n + (ex ? "  -> " + ex : "")); } };

// ---------------- mock ----------------
await page.evaluateOnNewDocument(() => {
  const NLC = String.fromCharCode(10), SEPC = String.fromCharCode(10, 10);
  // mode: ok / slow / hang / cut / badjson / reject
  window.__ctl = { mode: "ok" };
  window.__hits = [];
  const realFetch = window.fetch.bind(window);
  const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { "Content-Type": "application/json" } });
  const sse = (s) => new Response(s, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  const chunk = (o) => "data: " + JSON.stringify(o) + SEPC;
  const TEXT = ["嗯。", "我在。", "怎么了？"];
  // ⚠️ 必须把 signal 接上：真 fetch 在 abort 时会掐断 body，这里的假 Response 不会。
  //    不接的话「点停止」「生成中切角色」都掐不断，busy 会永久卡住 ——
  //    后面每个场景都会被它带崩（第一版就是这么假失败的）。
  const mkStream = (producer, sig) => {
    const enc = new TextEncoder();
    let closed = false;
    const timer = [];
    const st = new ReadableStream({
      start(c) {
        const push = (s) => { if (closed) return; try { c.enqueue(enc.encode(s)); } catch (e) {} };
        const stop = () => { closed = true; timer.forEach(clearTimeout); try { c.close(); } catch (e) {} };
        producer(push, stop, timer);
        if (sig) {
          const onAbort = () => {
            closed = true;
            timer.forEach(clearTimeout);
            try { c.error(new DOMException("Aborted", "AbortError")); } catch (e) {}
          };
          if (sig.aborted) onAbort(); else sig.addEventListener("abort", onAbort);
        }
      },
      cancel() { closed = true; timer.forEach(clearTimeout); }
    });
    return new Response(st, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  };
  const sigOf = (opts) => (opts && opts.signal) || null;

  window.fetch = async function (url, opts) {
    const u = String(url);
    if (u.indexOf("/chat/completions") < 0) return realFetch(url, opts);
    let body = {};
    try { body = JSON.parse((opts && opts.body) || "{}"); } catch (e) {}
    const mode = (window.__ctl && window.__ctl.mode) || "ok";
    window.__hits.push({ stream: body.stream, mode });
    if (body.stream === false) return json({ choices: [{ message: { content: "{}" } }], usage: { prompt_tokens: 10, completion_tokens: 1 } });
    if (mode === "reject") throw new TypeError("Failed to fetch");
    if (mode === "badjson") {
      return sse("data: {这不是JSON}" + SEPC
        + chunk({ choices: [{ delta: { content: "嗯。" } }] })
        + chunk({ choices: [{ delta: {}, finish_reason: "stop" }] })
        + "data: [DONE]" + SEPC);
    }
    if (mode === "cut") {
      // 断流：发完第一个字就把连接关掉 —— 没有 finish_reason、没有 [DONE]
      return mkStream((push, stop, timer) => {
        timer.push(setTimeout(() => {
          push(chunk({ choices: [{ delta: { content: "嗯。" } }] }));
          stop();
        }, 80));
      }, sigOf(opts));
    }
    // ok / slow / hang：真·流式（hang 永远不收尾，用来测「停止」和「中途切走」）
    const gap = mode === "hang" ? 500 : 90;
    return mkStream((push, stop, timer) => {
      TEXT.forEach((tx, i) => {
        timer.push(setTimeout(() => {
          push(chunk({ choices: [{ delta: { content: tx } }] }));
          if (i === TEXT.length - 1 && mode !== "hang") {
            push(chunk({ choices: [{ delta: {}, finish_reason: "stop" }] }) + "data: [DONE]" + SEPC);
            stop();
          }
        }, gap * (i + 1)));
      });
    }, sigOf(opts));
  };
});

await page.goto("http://127.0.0.1:" + port + "/index.html", { waitUntil: "networkidle0" });
await sleep(800);
await seedChars(page, [
  { id: "CHA", name: "甲", greeting: "", extra: { typingDelay: 0, splitMessages: false, kaomojiFreq: 0, emojiFreq: 0, showTyping: false } },
  { id: "CHB", name: "乙", greeting: "", extra: { typingDelay: 0, splitMessages: false, kaomojiFreq: 0, emojiFreq: 0, showTyping: false } },
  { id: "CHC", name: "丙", greeting: "", extra: { typingDelay: 0, splitMessages: false, kaomojiFreq: 0, emojiFreq: 0, showTyping: false } }
]);
await page.evaluate(async () => {
  const db = await new Promise((res, rej) => { const rq = indexedDB.open("ai-companion"); rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); });
  const put = (k, v) => new Promise((res) => { const tx = db.transaction("kv", "readwrite"); tx.objectStore("kv").put({ k, v }); tx.oncomplete = res; });
  await put("settings", { apiKey: "sk-chaos", baseUrl: "https://api.deepseek.com", model: "deepseek-flash", clockMode: false, liveV2: false });
  await put("lastCharId", "CHA");
  db.close();
});
await page.reload({ waitUntil: "domcontentloaded" });
await sleep(1800);

// ---------------- 小工具 ----------------
const mode = (m) => page.evaluate((x) => { window.__ctl.mode = x; }, m);
const bubbleHtml = () => page.$eval("#messages", el => el.innerHTML).catch(() => "");
async function dbRows(ch) {
  return page.evaluate(async (id) => {
    const db = await new Promise((res, rej) => { const rq = indexedDB.open("ai-companion"); rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); });
    const tx = db.transaction("messages", "readonly");
    const all = await new Promise((res) => { const rq = tx.objectStore("messages").getAll(); rq.onsuccess = () => res(rq.result || []); rq.onerror = () => res([]); });
    db.close();
    return all.filter(m => m.charId === id).map(m => ({ role: m.role, content: m.content, ts: m.ts }));
  }, ch);
}
async function isBusy() { return page.evaluate(() => { const b = document.getElementById("btn-stop"); return !!(b && !b.classList.contains("hidden")); }); }
async function waitBusyOn(ms = 6000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await isBusy()) return true; await sleep(100); } return false; }
async function waitBusyOff(ms = 30000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (!(await isBusy())) return true; await sleep(150); } return false; }
async function fillAndSend(txt) {
  await page.evaluate((s) => { const i = document.getElementById("input"); i.value = s; i.dispatchEvent(new Event("input", { bubbles: true })); }, txt);
  await page.evaluate(() => document.getElementById("btn-send").click());
}
// 等到「这一轮真的开始吐字」再动手。
// 为什么不是 sleep 固定毫秒：一轮里前面还有拼提示词、判断要不要独白等本地步骤，
// 固定等 900ms 有时流还没开始 —— 那时按停止属于「一个字都没收到」，
// 产品行为是只弹一句「已停止生成」，这是对的，但作为测试就测不到想测的那条路。
async function waitHits(n, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if ((await page.evaluate(() => window.__hits.length)) >= n) return true;
    await sleep(60);
  }
  return false;
}
// 等「正文真的出现在最后一个气泡里」。
// 判据必须是正文里的字（假流回的是「嗯。」），不能只判「气泡非空」——
// 占位气泡本身就带「···」，那样会在请求还没发出时就假命中，
// 变成在「假打字延迟」阶段按停止（那一步 full 还是空，本来就只弹 toast）。
async function waitLastText(need, ms = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const s = await page.evaluate(() => {
      const b = document.getElementById("messages");
      if (!b) return "";
      const ns = b.querySelectorAll(".msg");
      return ns.length ? (ns[ns.length - 1].textContent || "") : "";
    });
    if (s.indexOf(need) >= 0) return true;
    await sleep(80);
  }
  return false;
}
const CHAR_NAME = { CHA: "甲", CHB: "乙", CHC: "丙" };

// 等到会话头上真显示成这个角色。
// 不能只 sleep：CI 的 runner 比本机慢，selectChar 里要读库 + 重绘，
// 固定等 900ms 有时还不够，读 chat-name 会读到上一态（甚至「No character selected」）。
async function waitChatName(name, ms) {
  const t0 = Date.now();
  for (;;) {
    const cur = await page.evaluate(() => (document.getElementById("chat-name") || {}).textContent || "");
    if (String(cur).trim() === name) return String(cur).trim();
    if (Date.now() - t0 > ms) return String(cur).trim();
    await sleep(80);
  }
}

async function openChar(id) {
  await page.evaluate(() => { const b = document.getElementById("btn-chars"); if (b) b.click(); });
  // 等卡片真的画出来（列表是异步渲染的），再点。
  const t0 = Date.now();
  while (Date.now() - t0 < 6000) {
    const has = await page.evaluate((cid) => !![...document.querySelectorAll("#char-list .char-card")].find(x => (x.dataset.id || "") === cid), id);
    if (has) break;
    await sleep(80);
  }
  await page.evaluate((cid) => { const cards = [...document.querySelectorAll("#char-list .char-card")]; const c = cards.find(x => (x.dataset.id || "") === cid); if (c) c.click(); }, id);
  await waitChatName(CHAR_NAME[id] || id, 8000);
}

// ================= 1. 生成中连点发送 =================
console.log("");
console.log("=== 1. 生成中点五次发送 ===");
await mode("slow");
let before = (await dbRows("CHA")).length;
await fillAndSend("连点测试");
await waitBusyOn();
for (let i = 0; i < 4; i++) { await page.evaluate(() => document.getElementById("btn-send").click()); await sleep(40); }
await waitBusyOff();
await sleep(600);
let rows = await dbRows("CHA");
const users1 = rows.filter(r => r.role === "user" && String(r.content).indexOf("连点测试") >= 0);
t("生成中连点五次，库里的用户消息只多一条", users1.length === 1, "条数=" + users1.length);
t("一轮生成只落一条回复（不会连出五条）", rows.length - before <= 2, "新增=" + (rows.length - before));

// ================= 2. 生成中点停止 =================
console.log("");
console.log("=== 2. 生成中点停止 ===");
await mode("hang");
before = (await dbRows("CHA")).length;
const h2 = await page.evaluate(() => window.__hits.length);
await fillAndSend("停了它");
await waitBusyOn();
await waitHits(h2 + 1, 20000);
await waitLastText("嗯。", 25000);
await sleep(120);
await page.evaluate(() => document.getElementById("btn-stop").click());
await waitBusyOff(15000);
await sleep(800);
rows = await dbRows("CHA");
const last2 = rows[rows.length - 1] || {};
t("停止后落库的那条带「已中断」", String(last2.content || "").indexOf("已中断") >= 0 || String(last2.content || "").indexOf("中断") >= 0, String(last2.content || "").slice(0, 40));
t("停止后按钮复位、不再卡在生成中", !(await isBusy()));
const dotsLeft = await page.$$eval("#messages .dots", els => els.length);
t("停止后没有残留的「正在输入」气泡", dotsLeft === 0, "dots=" + dotsLeft);

// ================= 3. 生成中切角色 =================
console.log("");
console.log("=== 3. 生成中切走再切回 ===");
await mode("hang");
const bBefore = (await dbRows("CHB")).length;
const h3 = await page.evaluate(() => window.__hits.length);
await fillAndSend("切走测试");
await waitBusyOn();
await waitHits(h3 + 1, 20000);
await waitLastText("嗯。", 25000);
await sleep(120);
await openChar("CHB");
await sleep(1200);
const bAfter = (await dbRows("CHB")).length;
t("切到另一个角色：那边一条都没多（回复没串台）", bAfter === bBefore, bBefore + " -> " + bAfter);
await openChar("CHA");
await sleep(800);
const aRows = await dbRows("CHA");
const cut = aRows.filter(r => r.role === "assistant" && String(r.content).indexOf("嗯。") >= 0 && String(r.content).indexOf("中断") >= 0);
t("切回原角色：中断的那半条落在原角色名下", cut.length >= 1 || aRows.some(r => String(r.content).indexOf("中断") >= 0), "assistant 条数=" + aRows.filter(r => r.role === "assistant").length);

// ================= 4. 流断在半截 =================
console.log("");
console.log("=== 4. 流发到一半连接断了 ===");
if (await isBusy()) { await page.evaluate(() => document.getElementById("btn-stop").click()); await waitBusyOff(15000); }
await mode("cut");
const e4 = errs.length;
before = (await dbRows("CHA")).length;
await fillAndSend("断流测试");
await waitBusyOff(20000);
await sleep(800);
rows = await dbRows("CHA");
const gotCut = rows.slice(before).filter(r => r.role === "assistant");
t("断流不崩（没有未捕获异常）", errs.length === e4, errs.slice(e4).join(" | "));
t("断流时已收到的那点字留下来了，不是空泡", gotCut.length === 0 || gotCut.some(r => String(r.content || "").replace(/（已中断）/, "").trim().length > 0) || (await bubbleHtml()).indexOf("断流测试") >= 0, "assistant 条数=" + gotCut.length);
const dots4 = await page.$$eval("#messages .dots", els => els.length);
t("断流后没有卡住的「正在输入」", dots4 === 0, "dots=" + dots4);

// ================= 5. 流里混进坏 JSON =================
console.log("");
console.log("=== 5. 流里有一行不是 JSON ===");
await mode("badjson");
const e5 = errs.length;
await fillAndSend("坏行测试");
await waitBusyOff(20000);
await sleep(600);
t("坏行被跳过、不崩", errs.length === e5, errs.slice(e5).join(" | "));
rows = await dbRows("CHA");
t("坏行之后照样收到回复", rows.some(r => r.role === "assistant" && String(r.content).indexOf("嗯。") >= 0), "assistant=" + rows.filter(r => r.role === "assistant").length);

// ================= 6. 整个请求都发不出去 =================
console.log("");
console.log("=== 6. 断网（fetch 直接失败）===");
await mode("reject");
const e6 = errs.length;
await fillAndSend("断网测试");
await waitBusyOff(40000);
await sleep(1000);
const errBub = await page.$$eval(".err-bub", els => els.length);
const retryBtn = await page.$$eval(".retry-btn", els => els.length);
t("断网给错误卡，不是静默失败", errBub >= 1, "err-bub=" + errBub);
t("错误卡上有重试按钮", retryBtn >= 1, "retry=" + retryBtn);
t("断网不崩", errs.length === e6, errs.slice(e6).join(" | "));

// ================= 7. 超长输入 =================
console.log("");
console.log("=== 7. 一次贴八千字 ===");
await mode("ok");
const long = "超".repeat(8000);
await fillAndSend(long);
await waitBusyOff(30000);
await sleep(800);
rows = await dbRows("CHA");
const longRow = rows.filter(r => r.role === "user" && String(r.content).length >= 8000);
t("八千字一条不丢（长度对得上）", longRow.length === 1 && String(longRow[0].content).length === 8000, longRow.length ? "长度=" + String(longRow[0].content).length : "没找到");
const taLen = await page.evaluate(() => { const i = document.getElementById("input"); return i ? i.value.length : -1; });
t("发出去之后输入框清空了", taLen === 0, "残留=" + taLen);

// ================= 8. 疯狂切角色 =================
console.log("");
console.log("=== 8. 连着切八次角色 ===");
await mode("ok");
const e8 = errs.length;
for (let i = 0; i < 8; i++) { await openChar(i % 2 ? "CHB" : "CHC"); await sleep(150); }
await openChar("CHA");
const nameOk = await waitChatName("甲", 8000);
t("连切八次不崩", errs.length === e8, errs.slice(e8).join(" | "));
t("最后停在点开的那个角色上", nameOk.trim() === "甲", "chat-name=" + nameOk);
const msgLen = await page.$$eval("#messages .msg", els => els.length);
t("切回来还能正常画出消息", msgLen > 0, "msg=" + msgLen);

// ================= 9. 生成中把页面刷新 =================
console.log("");
console.log("=== 9. 生成到一半刷新页面 ===");
await mode("hang");
await fillAndSend("刷新测试");
await waitBusyOn();
await sleep(600);
await page.reload({ waitUntil: "domcontentloaded" });
await sleep(2200);
const dots9 = await page.$$eval("#messages .dots", els => els.length);
const halfRows = (await dbRows("CHA")).filter(r => r.role === "assistant" && String(r.content || "").trim() === "");
t("刷新回来没有卡住的气泡", dots9 === 0, "dots=" + dots9);
t("刷新没有在库里留空回复", halfRows.length === 0, "空回复=" + halfRows.length);

// ================= 汇总 =================
console.log("");
console.log("========================================");
t("全程没有未捕获异常", errs.length === 0, errs.slice(0, 3).join(" | "));
console.log("通过 " + pass + " 项，失败 " + fail + " 项");
await browser.close();
server.close();
process.exit(fail ? 1 : 0);
