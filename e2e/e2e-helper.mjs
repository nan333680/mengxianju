// 测试共用：不依赖内置模板，直接往 IndexedDB 塞角色
//
// 2026-09-21 起，App 只保留「空白角色」，内置模板全部删掉了（现在软件里一个都不带）。
// 老测试靠点模板建角色 —— 模板一没，建出来的角色就没名字、
// 没开场白，一路断言全挂。
//
// 这个 helper 直接写库，测试就不再受模板增减影响。

/**
 * 已删除的内置模板名。只做「界面里不该再出现」的反向断言用，不是素材、不是默认值。
 * 要加要删只改这一处，别在套件里手抄名字。
 */
export const LEGACY_TEMPLATES = ['键山雏', '冴月麟', '伊吹萃香', '西行寺幽幽子'];

/** 在页面里塞 n 个测试角色，返回 [{id, name}]（按名字 A/B/C… 命名） */
export async function seedChars(page, specs) {
  return await page.evaluate(async (list) => {
    const req = indexedDB.open('ai-companion');
    const db = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
    const out = [];
    for (const s of list) {
      const c = {
        id: s.id || ('t' + Math.random().toString(36).slice(2, 10)),
        name: s.name,
        greeting: s.greeting !== undefined ? s.greeting : ('（' + s.name + '的开场白）'),
        persona: s.persona || ('你是' + s.name + '。'),
        avatar: null,
        temperature: 1.0, maxTokens: 2048, topP: 1.0, reasoningEffort: 'low',
        contextRounds: 20, kaomojiFreq: 0.15, kaomojiStyle: 'jp-soft', emojiFreq: 0.1,
        verbosity: 'medium', splitMessages: false, typingDelay: 1.0,
        hesitation: true, showTyping: true, longMemory: false, allowEditMine: false,
        descLevel: 'mid', povLock: false, appearance: '', appearanceOn: true,
        presetKey: 'blank', createdAt: Date.now()
      };
      Object.assign(c, s.extra || {});
      await new Promise((res) => {
        const tx = db.transaction('characters', 'readwrite');
        tx.objectStore('characters').put(c);
        tx.oncomplete = res;
      });
      out.push({ id: c.id, name: c.name });
    }
    db.close();
    return out;
  }, specs);
}

/** 塞一个角色，返回它的 id */
export async function seedChar(page, name, extra = {}) {
  const r = await seedChars(page, [{ name, extra }]);
  return r[0].id;
}

/**
 * 等一次 AI 生成真正结束。
 *
 * ⚠️ 为什么必须用这个函数，不能自己写循环：
 * 以前各套件都是这样写的 ——
 *
 *   await page.click('#btn-send');
 *   for (...) {
 *     const busy = await page.$eval('#btn-stop', el => !el.classList.contains('hidden'));
 *     if (!busy) break;          // ← 点完立刻查
 *   }
 *
 * **点击返回后、send() 把 #btn-stop 显示出来之前有一段同步代码**，
 * 测试的第一次轮询正好跑在它前面，于是立刻判定"已经结束"（实测 done 在 0.4s），
 * 然后去读一个还没产生的回复 —— 断言全挂，而且报错指向断言，看不出是竞态。
 *
 * 实测证据：1.17.7 原版（未做任何改动的基线）跑同样流程，同样是 0.4s 判定结束、
 * 消息数 1。也就是说这批套件在基线就挂，跟被测代码无关。
 *
 * 正确顺序：**先等它出现，再等它消失。**
 * 两个阶段都带超时，避免"生成根本没开始"时永久挂死（那比失败更糟）。
 *
 * @param page      puppeteer 页面
 * @param startedMs 等"开始"的超时（默认 8 秒）
 * @param doneMs    等"结束"的超时（默认 120 秒，真实 API 有时很慢）
 * @returns {Promise<{started:boolean, ended:boolean}>}
 */
export async function waitIdle(page, startedMs = 8000, doneMs = 120000) {
  const stopShown = () => page.$eval('#btn-stop', el => !el.classList.contains('hidden'))
    .catch(() => false);

  // 阶段一：等生成开始（按钮出现）
  let started = false;
  const t1 = Date.now();
  while (Date.now() - t1 < startedMs) {
    if (await stopShown()) { started = true; break; }
    await new Promise(r => setTimeout(r, 120));
  }
  // ⚠️ startedMs 很小时，"查不到按钮"根本不能推出"请求没发出去"（2026-09-28 修）。
  //
  // 调用方常写 waitIdle(page, 1, 120000) —— 意思明明是
  // 「我已经确认它开始了，别在阶段一浪费时间，直接等结束」。
  // 但循环体是【先查再等】：startedMs=1 时只查一次就退出，
  // 而首字已经出现、停止按钮却恰好还是 hidden（实测总耗时 1.9s / 首字 1.8s 就是这种），
  // 于是 started=false，函数立刻返回 {started:false, ended:false}，
  // 调用方把 done 判成 false，报「生成正常结束」失败 —— 可回复明明是完整的。
  //
  // 修法：startedMs <= 200 时不要在这里下"没开始"的结论，
  // 直接进阶段二等结束 —— 按钮若已消失，第一圈就会返回 ended:true。
  // 真正的"没发出去"由调用方自己的首字/按钮检查负责（e2e-test 就是那么写的）。
  // 从没出现 = 这次请求压根没发出去（缺 Key / 出错）。
  // 直接返回，把判断权交给后面的断言 —— 不要在这里替它下结论。
  //
  // ⚠️ 例外：startedMs 很小（调用方已经自己确认过开始了）时不能这么判 ——
  // 见上面那段注释。此时直接进阶段二：按钮若已消失，第一圈就返回 ended:true。
  if (!started && startedMs > 200) return { started: false, ended: false };

  // 阶段二：等生成结束（按钮消失）
  const t2 = Date.now();
  while (Date.now() - t2 < doneMs) {
    if (!(await stopShown())) return { started: true, ended: true };
    await new Promise(r => setTimeout(r, 300));
  }
  return { started: true, ended: false };
}

/**
 * 点一个元素 —— **一律用这个，不要用 page.click()**。
 *
 * ⚠️ page.click() 走的是真实鼠标事件（Chromium 要算元素的可点击点），
 * 在下面这两种情况下会**直接抛错或静默落空**：
 *   · 元素被别的层盖住 / 在视口外 → 抛 "Node is either not clickable or not an Element"
 *   · 元素存在但位置算错 → 点了但事件没落在它身上（不报错，最难查）
 *
 * 实测（2026-09-24）：e2e-fix2 用 page.click('#btn-send') → 消息数一直是 1；
 * 换成 el.click() → 消息数 3。同一份代码、同一个页面，只差点击方式。
 * 一次修好之后 e2e-perf / e2e-ziworldbook 跟着一起过。
 *
 * 这是血泪第 9 条那个坑的通用版本：**测试里一律用 el.click()**。
 * 事件照样会冒泡、照样触发 onclick，和真实点击在业务上等价，
 * 但不依赖布局和遮挡关系。
 *
 * @param page     puppeteer 页面
 * @param selector CSS 选择器
 * @param idx      命中多个时点第几个（默认 0）
 */
export async function tap(page, selector, idx = 0) {
  const ok = await page.evaluate((sel, i) => {
    const els = [...document.querySelectorAll(sel)];
    if (!els[i]) return false;
    els[i].click();
    return true;
  }, selector, idx);
  if (!ok) throw new Error('tap: 找不到元素 ' + selector + ' (idx=' + idx + ')');
  return true;
}

/**
 * v1.19.11 起，导入会先弹「选模式」的弹窗。
 * 老套件上传完文件就直接等数据进库 —— 弹窗没人点，导入永远不执行，全挂。
 *
 * 这个函数负责把弹窗走完：等它出现 → 勾模式 → 点「导入」。
 * 模式 1「完全还原」还会再弹一次确认，也要点掉。
 *
 * @param page   puppeteer 页面
 * @param mode   all | config | chars | msgs | wb（默认 msgs —— 老套件导的多半是聊天记录）
 * @param sleep  调用方自己的 sleep 函数
 */
export async function pickImportMode(page, mode = 'msgs', sleep = (ms) => new Promise(r => setTimeout(r, ms))) {
  // 等弹窗（解析 3.8MB JSON + 数库都是异步的）
  let shown = false;
  for (let i = 0; i < 80; i++) {
    shown = await page.$eval('#import-modal', el => !el.classList.contains('hidden')).catch(() => false);
    if (shown) break;
    await sleep(100);
  }
  if (!shown) return false;   // 没弹出来（比如解析就失败了），交给调用方的断言去报
  await page.evaluate((k) => {
    const el = document.querySelector('input[name="imp-mode"][value="' + k + '"]');
    if (el) el.checked = true;
  }, mode);
  await sleep(100);
  await page.evaluate(() => document.getElementById('import-ok').click());
  // 模式 1 的二次确认
  if (mode === 'all') {
    for (let i = 0; i < 40; i++) {
      const m = await page.$eval('#modal', el => !el.classList.contains('hidden')).catch(() => false);
      if (m) { await page.evaluate(() => document.getElementById('modal-ok').click()); break; }
      await sleep(100);
    }
  }
  return true;
}

export default { seedChars, seedChar, waitIdle, tap, pickImportMode };

/**
 * 把 App 语言钉成中文（v0.4.1 修）。
 *
 * 起因：CI（GitHub runner）的系统语言是 en-US，而 App 的语言设置默认是「跟随系统」，
 * 于是在 CI 上整个界面直接渲染成英文 —— 任何断言中文文案的套件都会红
 * （e2e-i18n 的「抽屉是中文」、e2e-menu 的「编辑重发」、e2e-empty 的空态引导都是这么红的）。
 * 本地跑没事，因为开发机是中文系统。
 *
 * 用法：page 加载完、断言中文之前调一次 await pinLang(page)。
 * ⚠️ 要在 reload 之前写库，之后再 reload 才生效（App 是启动时读 settings.lang）。
 */
export async function pinLang(page, lang = 'zh') {
  await page.evaluate(async (v) => {
    // ⚠️ 必须先确认库已经存在：直接 open 一个不存在的库会【创建一个空的】，
    //    里面没有 kv/characters 这些表，App 下一次初始化就会炸（实测就是这么炸的）。
    const dbs = await indexedDB.databases();
    if (!dbs.some(d => d.name === 'ai-companion')) {
      throw new Error('pinLang: App 还没建库 —— 先让它启动加载一次（或先 seed 一个角色）再调');
    }
    const o = indexedDB.open('ai-companion');
    const db = await new Promise((res, rej) => { o.onsuccess = () => res(o.result); o.onerror = () => rej(o.error); });
    const rec = await new Promise(res => {
      const q = db.transaction('kv').objectStore('kv').get('settings');
      q.onsuccess = () => res(q.result);
    });
    // ⚠️ 记录不存在就【别写】：写一个只带 lang 的 settings 会把全局设置冲掉
    //    （第一版就是这么把 API Key 等默认值弄没的）
    if (!rec || !rec.v) return;
    const s = Object.assign({}, rec.v, { lang: v });
    await new Promise(res => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put({ k: 'settings', v: s });
      tx.oncomplete = res;
    });
    db.close();
  }, lang);
}
