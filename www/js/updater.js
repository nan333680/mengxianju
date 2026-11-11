/**
 * 检查更新（v0.5.7）。
 *
 * 只做 A 档：查到有没有新版 → 给一个下载链接。「应用内下载 + 拉起安装器」不做 ——
 * 现有 Capacitor 插件只有 app / filesystem / share，没有 browser，也没有
 * DownloadManager 封装；要做下载得动原生 + FileProvider + 未知来源安装授权。
 * 先把「有新版本了」这个信息可靠地送到，比把下载做好更要紧。
 *
 * ── 三个容易写错、写错又不显眼的地方 ──────────────────────────────────
 *
 * 1) 【必须取最大，不能先到先用】
 *    jsDelivr 对 @main 的缓存是 s-maxage=43200（12 小时），刚发完版 12 小时内
 *    它还在吐旧版本；api.github.com 是实时的。两个源同时回来、内容不同时，
 *    先到的那个很可能就是旧的。所以是「8 秒内收齐所有应答，再取最大」，
 *    不是 Promise.race —— 先到先用会让刚发布的版本查不出来。
 *
 * 2) 【版本号一律解析成数字数组比较】
 *    字符串比较会踩 "0.5.6.10" < "0.5.6.9" 的坑。短者补 0，所以
 *    0.5.7 与 0.5.7.0 相等。
 *
 * 3) 【浏览器 / e2e 里没有 App.getInfo】
 *    调用方传空 currentVersion 进来时必须不报错、也不提示 —— 不知道自己
 *    在哪个版本时，不能假装「有新版本」。
 *
 * 网络现状（2026-11-11 本机实测，同一时刻连打多次）：
 *   api.github.com          0.28~0.65s   实时        CORS *
 *   gcore.jsdelivr.net      1.8~5.9s     s-max 12h   CORS *
 *   testingcf.jsdelivr.net  2.2~3.4s     s-max 12h   CORS *
 *   ghproxy.net             0.77~8.7s    5min        CORS *
 *   raw.githubusercontent   RST          —           —
 *   cdn.jsdelivr.net        RST          —           —
 * 没有一个源是稳定的 —— 换一条网络出口，排名就整个反过来（同一天另一台机器
 * 上 ghproxy.net 六次全失败、这里六次全通）。所以全部保留 + 竞速。
 */

const GH_RAW = 'https://raw.githubusercontent.com/nan333680/mengxianju/main/version.json';

/**
 * 数据源。数组顺序只是展示顺序，实际上全部同时发、不等彼此。
 * kind = 'release' 认 GitHub Release 结构；'json' 认仓库根的 version.json。
 */
export const SOURCES = [
  { id: 'api',     kind: 'release', url: 'https://api.github.com/repos/nan333680/mengxianju/releases/latest' },
  { id: 'gcore',   kind: 'json',    url: 'https://gcore.jsdelivr.net/gh/nan333680/mengxianju@main/version.json' },
  { id: 'testcf',  kind: 'json',    url: 'https://testingcf.jsdelivr.net/gh/nan333680/mengxianju@main/version.json' },
  { id: 'ghproxy', kind: 'json',    url: 'https://ghproxy.net/' + GH_RAW },
  { id: 'raw',     kind: 'json',    url: GH_RAW },
];

/** "v0.5.6.4" / "0.5.7" / "0.5.7-beta" → [0,5,6,4] / [0,5,7] / [0,5,7] */
export function parseVersion(v) {
  const s = String(v == null ? '' : v).trim().replace(/^v/i, '');
  if (!s) return [];
  const out = [];
  for (const part of s.split('.')) {
    const m = /^(\d+)/.exec(part);
    if (!m) break;                    // 遇到 "beta" 这类非数字段就停
    out.push(parseInt(m[1], 10));
  }
  return out;
}

/** 逐段比，短者补 0。返回 1 / 0 / -1 */
export function cmpVersion(a, b) {
  const A = parseVersion(a), B = parseVersion(b);
  const n = Math.max(A.length, B.length);
  for (let i = 0; i < n; i++) {
    const x = A[i] || 0, y = B[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/** 从一批应答里挑 version 最大的那条（不是先到的） */
export function pickBest(list) {
  let best = null;
  for (const it of (list || [])) {
    if (!it || !it.version) continue;
    if (!best || cmpVersion(it.version, best.version) > 0) best = it;
  }
  return best;
}

/** 两种数据源 → 同一个内部形状 */
function normalize(src, data) {
  if (!data || typeof data !== 'object') return null;
  if (src.kind === 'release') {
    const ver = String(data.tag_name || '').replace(/^v/i, '');
    if (!ver) return null;
    const assets = Array.isArray(data.assets) ? data.assets : [];
    const apk = assets.find((a) => a && /\.apk$/i.test(String(a.name || ''))) || assets[0] || null;
    return {
      version: ver,
      notes: String(data.body || data.name || '').trim(),
      url: apk ? String(apk.browser_download_url || '') : '',
      size: apk ? (Number(apk.size) || 0) : 0,
      date: String(data.published_at || '').slice(0, 10),
      source: src.id,
    };
  }
  const ver = String(data.versionName || '').replace(/^v/i, '');
  if (!ver) return null;
  const apk = (data.apk && typeof data.apk === 'object') ? data.apk : {};
  const mirrors = Array.isArray(apk.mirrors) ? apk.mirrors.filter(Boolean).map(String) : [];
  const primary = String(apk.url || '') || mirrors[0] || '';
  return {
    version: ver,
    notes: String(data.notes || '').trim(),
    url: primary,
    size: Number(apk.size) || 0,
    date: String(data.date || '').slice(0, 10),
    source: src.id,
    mirrors: mirrors.filter((u) => u !== primary),
  };
}

/** 单源；任何失败（RST / 超时 / 403 限流 / 非 JSON）都返回 null，绝不抛 */
async function fetchOne(src, timeoutMs, fetchImpl) {
  const hasAbort = typeof AbortController === 'function';
  const ctl = hasAbort ? new AbortController() : null;
  let timer = null;
  if (ctl) timer = setTimeout(() => { try { ctl.abort(); } catch { /* ignore */ } }, timeoutMs);
  try {
    const res = await fetchImpl(src.url, {
      method: 'GET',
      cache: 'no-store',
      signal: ctl ? ctl.signal : undefined,
    });
    if (!res || !res.ok) return null;
    return normalize(src, await res.json());
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 查一次。
 * @param {{currentVersion?: string, timeoutMs?: number, fetchImpl?: any, sources?: any[], now?: () => number}} opts
 * @returns {Promise<{ok: boolean, reason?: string, current?: string, latest?: any,
 *                    hasUpdate?: boolean, answered: number, total: number, ms: number}>}
 */
export async function checkUpdate(opts = {}) {
  const {
    currentVersion = '',
    timeoutMs = 8000,
    fetchImpl = (typeof fetch === 'function' ? fetch : null),
    sources = SOURCES,
    now = () => Date.now(),
  } = opts;

  const t0 = now();
  const total = sources.length;
  if (!fetchImpl || !total) return { ok: false, reason: 'no-fetch', answered: 0, total, ms: 0 };

  const got = [];
  await new Promise((resolve) => {
    let left = total;
    let settled = false;
    let hard = null;
    let early = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (hard) clearTimeout(hard);
      if (early) clearTimeout(early);
      resolve();
    };
    // 硬上限：再慢的源也拖不住整个检查
    hard = setTimeout(finish, timeoutMs + 250);
    for (const src of sources) {
      fetchOne(src, timeoutMs, fetchImpl).then((r) => {
        if (r) got.push(r);
        // ⚠️ 早退（v0.5.7 实测加）：主源是 api.github.com，实测 0.3~0.65s 就回来，
        //    而几个备用源里最慢的能拖满 8 秒。没有这一条时，用户点「检查更新」
        //    要对着「正在查…」干等 8 秒 —— 实测就是 8040ms。
        //    主源回来后只再给 2 秒收尾：这段时间够其余源各报一次（它们的实测中位数
        //    都在这以内），同时也保住了「取最大」—— 2 秒里回来的更大版本仍然会赢。
        //    主源自己没回来时不早退，老老实实等满预算（那时它是唯一实时的源）。
        // ⚠️ r && 不能少（审查抓到）：api 源 403/抖动时 fetchOne 返回 null，
        //    只判 id 照样触发 2 秒早退 —— 而那几个备用源的实测回包时间是 2.5~5.9 秒，
        //    全部会被切断，最后返回 all-failed。api 失败恰恰是备用源唯一有意义的场景。
        if (r && src.id === 'api' && !settled) {
          if (early) clearTimeout(early);
          early = setTimeout(finish, 2000);
        }
        if (--left <= 0) finish();
      });
    }
  });

  const base = { answered: got.length, total, ms: now() - t0 };
  const best = pickBest(got);
  if (!best) return { ok: false, reason: 'all-failed', ...base };
  return {
    ok: true,
    current: currentVersion,
    latest: best,
    hasUpdate: !!currentVersion && cmpVersion(best.version, currentVersion) > 0,
    ...base,
  };
}

// ── 自动检查的节流（24h）─────────────────────────────────────────────
const LS_LAST = 'mxj.upd.lastAt';

export function shouldAutoCheck(hours = 24, at = Date.now()) {
  try {
    const raw = localStorage.getItem(LS_LAST);
    const t = raw ? parseInt(raw, 10) : 0;
    if (!t || !isFinite(t)) return true;
    return (at - t) > hours * 3600 * 1000;
  } catch { return true; }
}

export function markChecked(at = Date.now()) {
  try { localStorage.setItem(LS_LAST, String(at)); } catch { /* ignore */ }
}
