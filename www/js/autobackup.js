/**
 * 自动备份 —— v1.21.40
 *
 * 为什么要有它：所有数据都在手机的 IndexedDB 里。系统清理、用户「清除数据」、
 * 换机、WebView 存储损坏 —— 任何一种都让几年的对话一次性没了，而且【不可恢复】。
 * 手动的「导出全部数据」要用户自己想起来点，事实上没人会点。
 *
 * 做成独立文件的原因和 charcard.js 一样：主文件已经 7600+ 行，
 * 而且这东西的逻辑（到期判断 / 多目录回退 / 滚动清理）值得单独测。
 *
 * 依赖全部通过参数注入，不 import 任何东西 —— 这样纯 Node 里就能把
 * 「什么时候该跑」「写不进去怎么办」「删哪几份」测干净。
 */

/**
 * 解析备份 JSON（v0.4.2.1）。
 * ⚠️ 本文件刻意【不 import 任何东西】（见开头），所以这里就地写一份 ——
 *    和 charcard.js 的 parseJsonSafe 是同一条规矩：备份文件是要发给别人、
 *    传网盘的，里面的 "__proto__" / "constructor" 键不能有机会进到我们的对象里。
 */
function parseJsonSafe(text) {
  return JSON.parse(String(text), (k, v) =>
    (k === '__proto__' || k === 'constructor' || k === 'prototype') ? undefined : v);
}

/** 两次自动备份的最小间隔：一天 */
export const DAY_MS = 24 * 60 * 60 * 1000;

/** 本地保留几份 */
export const KEEP = 7;

/**
 * 自动备份依次尝试的目录。
 *
 * ⚠️ v1.21.52 把顺序改回了 DOCUMENTS 优先 —— v1.21.51 曾把它降到第二，
 *    理由是"公共目录别的 App 看得见"。那个理由本身没错，但漏了更要紧的一条：
 *    EXTERNAL 在 Android 上就是 /Android/data/<包名>/files，
 *    而【卸载应用、或在系统设置里"清除数据"，系统会把整个 /Android/data/<包名> 删掉】——
 *    那恰恰是这份备份最需要派上用场的两个场景（它存在的理由就是它们）。
 *    也就是说：排在第二的 DOCUMENTS 才是唯一能活过卸载/清数据/换机的位置，
 *    把它降级 = 让备份在最该起作用的时候不存在。
 *
 * 取舍写明白：DOCUMENTS 是公共目录，文件管理器、以及任何拿到 SAF 授权的 App 都看得见，
 *    而里面是全部聊天记录 + 记忆 + 世界书的【明文】。这条已经写进设置页的说明了。
 *    "永久丢失"比"被别的 App 看见"严重得多，所以默认留活得久的那个。
 *    （没降到 CACHE：会被系统清缓存清掉，等于没备份。）
 * DATA 垫底：应用私有目录一定写得进去，但卸载即消失，只当最后一道。
 */
export const BACKUP_DIRS = ['DOCUMENTS', 'EXTERNAL', 'DATA'];

export const STAMP_KEY = 'autoBackupAt';

/**
 * 备份文件名。用日期而不是时间戳，因为自动备份一天最多一次，
 * 同一天再跑就是覆盖同一份 —— 这是有意的：宁可覆盖当天的，也不要堆重复内容。
 */
export function backupName(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return '梦弦居自动备份-' + d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '.json';
}

/**
 * 挑出该删哪些：按文件名排序（名字里带日期，字典序就是时间序），
 * 留下最新的 keep 份，其余删掉。
 *
 * ⚠️ 只认本函数生成的名字。目录里可能有用户自己导出的东西，不能一起删 ——
 * 「批量删除前先算删完还剩什么」（这条规则在这个项目里已经踩过好几次）。
 *
 * @param {string[]} names 目录里的文件名
 * @param {number} keep
 * @returns {string[]} 要删的文件名
 */
export function pickOldBackups(names, keep = KEEP) {
  const mine = (names || [])
    .filter(n => typeof n === 'string' && n.startsWith('梦弦居自动备份-') && n.endsWith('.json'))
    .sort();                                   // 字典序 = 日期序（名字是固定宽度的 YYYY-MM-DD）
  if (mine.length <= keep) return [];
  return mine.slice(0, mine.length - keep);    // 越早的越靠前
}

/**
 * 到期就跑一次自动备份。
 *
 * @param {object} o
 * @param {{get: Function, set: Function}} o.kv   要有 get / set
 * @param {{writeFile: Function, readdir: Function, deleteFile: Function, readFile?: Function}|null} o.FS  Capacitor Filesystem 插件对象（可为 null）
 * @param {Function} o.collect 返回可 JSON.stringify 的备份对象（复用 exportData 的那套）
 * @param {string[]} [o.directories] 依次尝试的目录枚举值
 * @param {number} [o.now]
 * @param {number} [o.intervalMs]
 * @param {number} [o.keep]
 * @returns {Promise<{ran:boolean, reason?:string, dir?:string, name?:string, deleted?:string[], error?:string}>}
 */
export async function autoBackupIfDue(o) {
  const {
    kv, FS, collect,
    directories = BACKUP_DIRS,          // 顺序理由见文件上方 BACKUP_DIRS 的说明
    now = Date.now(),
    intervalMs = DAY_MS,
    keep = KEEP,
  } = o || {};

  if (!FS) return { ran: false, reason: 'no-filesystem' };
  if (typeof collect !== 'function') return { ran: false, reason: 'no-collect' };

  // ① 到期了吗
  let last = 0;
  try { last = Number(await kv.get(STAMP_KEY, 0)) || 0; } catch { last = 0; }
  if (last && now - last < intervalMs) return { ran: false, reason: 'not-due' };

  // ② 收集 + 序列化。这一步失败就什么都别做，更不能盖时间戳 ——
  //    盖了就又要等一整天，等于把失败也当成"备份过了"。
  let json;
  try { json = JSON.stringify(await collect()); }
  catch (e) { return { ran: false, reason: 'collect-failed', error: String((e && e.message) || e) }; }

  const name = backupName(new Date(now));
  const folder = '梦弦居备份';

  // ③ 依次试目录。Android 版本之间能写的地方不一样 —— 顺序理由见 BACKUP_DIRS。
  let usedDir = null, writeErr = null;
  for (const dir of directories) {
    try {
      await FS.writeFile({
        path: folder + '/' + name,
        data: json,
        directory: dir,
        encoding: 'utf8',
        recursive: true,
      });
      usedDir = dir;
      break;
    } catch (e) {
      writeErr = e;
    }
  }
  if (!usedDir) {
    return { ran: false, reason: 'write-failed', error: String((writeErr && writeErr.message) || writeErr) };
  }

  // ④ 滚动清理。删不掉不算失败 —— 磁盘上多留几份，比因为清理报错而
  //    把"已经备份成功"这件事丢掉强。
  let deleted = [];
  try {
    const rd = await FS.readdir({ path: folder, directory: usedDir });
    const names = (rd && rd.files ? rd.files : []).map(f => (typeof f === 'string' ? f : f && f.name));
    deleted = pickOldBackups(names, keep);
    for (const n of deleted) {
      try { await FS.deleteFile({ path: folder + '/' + n, directory: usedDir }); }
      catch { /* 单个删不掉不影响其余 */ }
    }
  } catch { /* 读不了目录就跳过清理 */ }

  // ⑤ 只有真的写成功了才盖时间戳
  try { await kv.set(STAMP_KEY, now); } catch { /* 记不上就是下次再跑一遍，无害 */ }

  return { ran: true, dir: usedDir, name, deleted };
}

/**
 * 把最近一份自动备份【读回来】，返回解析后的对象本身（v0.4.0）。
 *
 * 和 verifyLatestBackup 的分工：
 *   · 这个函数负责「找到 + 读出来 + 确认它真是一份备份」，把 data 一起返回；
 *   · verifyLatestBackup 在它之上只数几个数（自检日志 / 备份健康面板要用）。
 * 拆开是因为【恢复演练】（设置页那个"检查我最近那份备份能不能用"）需要 data 本体，
 * 好走一遍导入预览 —— 没有 data 就只能说"能读"，说不出"里面有什么"。
 *
 * @param {object} o
 * @param {{readdir: Function, readFile: Function}|null} o.FS
 * @param {string[]} [o.directories]
 * @returns {Promise<{ok:boolean, reason?:string, dir?:string, name?:string, bytes?:number, count?:number, error?:string, data?:object}>}
 */
export async function readLatestBackup(o) {
  const { FS, directories = BACKUP_DIRS } = o || {};
  if (!FS) return { ok: false, reason: 'no-filesystem' };
  const folder = '梦弦居备份';
  // ⚠️ 记下"第一个出问题的目录"，但【不立刻返回】（v0.4.2 修，用户复核）：
  //    原来 DOCUMENTS 里那份最新的坏掉时直接 return —— EXTERNAL / DATA 里那份好的
  //    永远不会被看到，面板就红着说"最近那份读不出来"。现在读坏就换下一个目录，
  //    全试完还是没有可用的，才把记下的那条报出去。
  let firstBad = null;
  const keepBad = (info) => { if (!firstBad) firstBad = info; };
  for (const dir of directories) {
    let names;
    try {
      const rd = await FS.readdir({ path: folder, directory: dir });
      names = (rd && rd.files ? rd.files : []).map(f => (typeof f === 'string' ? f : f && f.name));
    } catch { continue; }   // 这个目录没有或读不了，换下一个
    const mine = (names || [])
      .filter(n => typeof n === 'string' && n.startsWith('梦弦居自动备份-') && n.endsWith('.json'))
      .sort();
    if (!mine.length) continue;
    const latest = mine[mine.length - 1];
    let raw = null;
    let readFailed = null;
    try {
      const rd = await FS.readFile({ path: folder + '/' + latest, directory: dir, encoding: 'utf8' });
      raw = (rd && typeof rd.data === 'string') ? rd.data : null;
    } catch (e) { readFailed = String((e && e.message) || e); }
    if (readFailed !== null || raw == null) {
      keepBad({ ok: false, reason: 'read-failed', dir, name: latest, error: readFailed || '' });
      continue;
    }
    let obj;
    try { obj = parseJsonSafe(raw); }
    catch (e) {
      keepBad({ ok: false, reason: 'corrupt', dir, name: latest, bytes: raw.length,
                error: String((e && e.message) || e) });
      continue;
    }
    // 光能 parse 还不够：一份 {} 也是合法 JSON。要确认它真是【备份】——
    // 至少得有导出时间，否则等于没有内容可恢复。
    if (!obj || typeof obj !== 'object' || !obj.exportedAt) {
      keepBad({ ok: false, reason: 'empty', dir, name: latest, bytes: raw.length });
      continue;
    }
    // count = 这个目录里一共有几份自动备份（设置页的「保留份数 N / 7」要用）
    return { ok: true, dir, name: latest, bytes: raw.length, count: mine.length, data: obj };
  }
  if (firstBad) return firstBad;   // 全试完了，报最靠前那个（最有信息量的那条）
  return { ok: false, reason: 'none' };
}

/**
 * 启动自检：把最近一份自动备份【读回来】，确认它真的能解析（v0.3.1）。
 *
 * 起因：autoBackupIfDue 每天写一份，却【从来不读回】—— 写成功 ≠ 那份文件是可用的。
 *   存储写满、写到一半被杀、SAF 授权被回收，都可能留下一份长度正常但内容截断的 JSON。
 *   而这份备份存在的唯一意义就是「出事时能读回来」，它自己坏掉却没人知道 ——
 *   等到真要用的时候才发现，那时已经晚了。
 *
 * 只验最近一份：它才是出事时你会去读的那一份。更早的坏掉不影响结论。
 *
 * @param {object} o
 * @param {{readdir: Function, readFile: Function}|null} o.FS Capacitor Filesystem 插件对象（可为 null）
 * @param {string[]} [o.directories]
 * @returns {Promise<{ok:boolean, reason?:string, dir?:string, name?:string, bytes?:number, count?:number, error?:string, characters?:number, messages?:number}>}
 */
export async function verifyLatestBackup(o) {
  const r = await readLatestBackup(o);
  if (!r.ok) return r;
  /** @type {any} */ const obj = r.data;   // 备份 JSON，字段名是历史约定，这里不设死类型
  // ⚠️ messages 和 characters 的【形状不一样】（v0.3.1 复查时发现报数一直是 0）。
  //
  // 起因：这里原来对两者都写 Array.isArray(...)。characters 确实是数组
  // （collectBackupPayload 里 payload.characters = await chars.all()），但 messages
  // 是【按 charId 分组的对象】：payload.messages[c.id] = await msgs.list(...)。
  // 于是 Array.isArray 对真实备份恒为 false，messages 永远算出 0 ——
  // 自检日志每次都打印「消息 0」，看着像"这份备份里没有聊天记录"，
  // 而这正是它要否认的那种事（写成功 ≠ 读得回来）。
  //
  // ⚠️ 上一版的测试没抓到它，因为 e2e 的 fixture 把 messages 写成了数组 ——
  //    测试验的是一个不存在的形状。改这里时【两个形状都要认】，
  //    免得哪天有人为了兼容老备份又把数组写回来。
  let msgN = 0;
  if (Array.isArray(obj.messages)) {
    msgN = obj.messages.length;
  } else if (obj.messages && typeof obj.messages === 'object') {
    for (const k of Object.keys(obj.messages)) {
      const arr = obj.messages[k];
      if (Array.isArray(arr)) msgN += arr.length;
    }
  }
  return { ok: true, dir: r.dir, name: r.name, bytes: r.bytes, count: r.count,
           characters: Array.isArray(obj.characters) ? obj.characters.length : 0,
           messages: msgN };
}

