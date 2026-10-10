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
 * @param {object} o.kv       要有 get / set
 * @param {object} o.FS       Capacitor Filesystem 插件对象（可为 null）
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
