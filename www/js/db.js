// IndexedDB 封装：角色、消息、设置、记忆
const DB_NAME = 'ai-companion';
// ⚠️ 加新表时必须 +1，并且 onupgradeneeded 里要写成【增量式】——
//    只建"还不存在的表"，绝不能把老表删了重建，否则老用户数据全没。
//    v2 加了 worldbook（世界书：角色组 + 条目）。
//    v3 给记忆补 status/sourceMsgIds/day/legacy（时间锚与来源）。
//    v4 加了 scenes（小说层：一场戏一张卡，正文不进 messages）。
//    v5（0.6.0 记忆 OS）：不建表，只给 memories 的每条补新字段 —— normalizeMemory
//       会把 v/kind/scope/subject/sourceKind/pinned/sinceDay/quote 等全补成默认值，
//       所以老库、老备份直接能读，不做数据搬迁。
import { normalizeMemory, planSupersede, planExpire, MEMORY_STATUS } from './memory.js';
const DB_VER = 5;
// 诊断页要显示库版本（0.5.3.5）：升级后「数据没上来」有一半是库没迁完，
// 用户报版本号的时候顺手能看到 v? 比问「你的库是几」有用。
export const DB_VERSION = DB_VER;

let _db = null;

export async function openDB() {
  if (_db) return _db;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('characters')) {
        const s = db.createObjectStore('characters', { keyPath: 'id' });
        s.createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains('messages')) {
        const s = db.createObjectStore('messages', { keyPath: 'id' });
        s.createIndex('charId_ts', ['charId', 'ts']);
        s.createIndex('charId', 'charId');
      }
      if (!db.objectStoreNames.contains('kv')) {
        db.createObjectStore('kv', { keyPath: 'k' });
      }
      if (!db.objectStoreNames.contains('memories')) {
        const s = db.createObjectStore('memories', { keyPath: 'id' });
        s.createIndex('charId', 'charId');
      }
      // ---- v2 新增：世界书 ----
      // groups：角色组（组名 + 成员 charId 列表 + 该组的条目）
      // solo  ：「单独角色」的条目，按 charId 分
      if (!db.objectStoreNames.contains('wbGroups')) {
        db.createObjectStore('wbGroups', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('wbSolo')) {
        const s = db.createObjectStore('wbSolo', { keyPath: 'id' });
        s.createIndex('charId', 'charId');
      }
      // ---- v4 新增：小说层 ----
      // 只加表，不动 messages / memories / characters / kv（规格 §12 的硬约束）。
      // 小说正文【不】进 messages：聊天是发生，小说是成篇，两者共用同一场戏但不共用一张表。
      if (!db.objectStoreNames.contains('scenes')) {
        const s = db.createObjectStore('scenes', { keyPath: 'id' });
        s.createIndex('charId', 'charId');
        s.createIndex('createdAt', 'createdAt');
      }
      // ---- v3 迁移：老记忆补字段 ----
      // 旧记录没有 day/sourceMsgIds/status。这里不能凭空造出「记于第几天」，
      // 所以 day 保持 null、sourceMsgIds 为空、legacy=true；界面会显示「旧记忆」。
      // 新建的表（全新安装）也会走到这里，但表是空的，遍历没有副作用。
      const memStore = req.transaction.objectStore('memories');
      const cur = memStore.openCursor();
      cur.onsuccess = (ev) => {
        const c = ev.target.result;
        if (!c) return;
        const raw = c.value || {};
        const rec = normalizeMemory(raw);
        // 手写记忆不标 legacy：它不该被自动反推，也不该在注入时被当成「旧记忆」。
        // ⚠️ 只在【原记录还没 legacy 字段】时判定（0.6.0 修，见规格 §9 幂等要求）。
        //    原来是无条件 rec.legacy = ...，而这段迁移每次 DB_VER 升级都会重跑，
        //    于是 v3 之后已经标成 legacy:false 的记忆会被改回 true。
        //    normalizeMemory 总会给出布尔值，所以只能看 raw。
        if (raw.legacy === undefined) rec.legacy = raw.mine === true ? false : true;
        c.update(rec);
        c.continue();
      };
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

/** 关闭数据库连接（清空全部数据前必须调用，否则 deleteDatabase 会被阻塞） */
export function closeDB() {
  if (_db) {
    try { _db.close(); } catch { /* 忽略 */ }
    _db = null;
  }
}

/** 彻底删除整个数据库 */
export function wipeAll() {
  return new Promise((resolve) => {
    closeDB();
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve(true);
    req.onerror = () => resolve(false);
    req.onblocked = () => resolve(false);   // 仍有其它连接时也不会永远挂住
  });
}

function tx(store, mode, fn) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    try { out = fn(s); } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

const req2p = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

// ---------- 通用 KV ----------
export const kv = {
  async get(k, def = null) {
    const db = await openDB();
    const r = await req2p(db.transaction('kv').objectStore('kv').get(k));
    return r ? r.v : def;
  },
  async set(k, v) {
    const db = await openDB();
    const t = db.transaction('kv', 'readwrite');
    t.objectStore('kv').put({ k, v });
    return new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
  },
  async del(k) {
    const db = await openDB();
    const t = db.transaction('kv', 'readwrite');
    t.objectStore('kv').delete(k);
    return new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
  },
  /** 全部键值对（备份用）。返回 [{k, v}]，不是对象 —— 键里带冒号，转对象没必要 */
  async entries() {
    const db = await openDB();
    const arr = await req2p(db.transaction('kv').objectStore('kv').getAll());
    return arr.map(r => ({ k: r.k, v: r.v }));
  },
  /** 批量写入（导入用）。一次事务，比逐条 set 快一个数量级 */
  async setMany(pairs) {
    if (!pairs || !pairs.length) return 0;
    const db = await openDB();
    const t = db.transaction('kv', 'readwrite');
    const s = t.objectStore('kv');
    for (const p of pairs) s.put({ k: p.k, v: p.v });
    return new Promise((res, rej) => { t.oncomplete = () => res(pairs.length); t.onerror = () => rej(t.error); });
  }
};

// ---------- 管理（导入的「完全还原」要用）----------
// 注意：这些是【不可逆】操作，只在用户明确选了"完全还原"之后才允许调用。
export const dbAdmin = {
  /**
   * 清空指定的表。不传 = 一张都不清。
   * 刻意不做"不带参数就清全部"—— 那种默认值迟早会被误调一次。
   */
  async clearStores(names) {
    const list = (names || []).filter(Boolean);
    if (!list.length) return 0;
    const db = await openDB();
    const t = db.transaction(list, 'readwrite');
    for (const n of list) t.objectStore(n).clear();
    return new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
  },
  /** 各表的条数（导入确认弹窗要显示"将删除多少条"）*/
  async counts() {
    const db = await openDB();
    const one = (store) => req2p(db.transaction(store).objectStore(store).count());
    const [characters, messages, memories, wbGroups, wbSolo, kvCount, scenesCount] = await Promise.all(
      ['characters', 'messages', 'memories', 'wbGroups', 'wbSolo', 'kv', 'scenes'].map(one));
    return { characters, messages, memories, wbGroups, wbSolo, kv: kvCount, scenes: scenesCount };
  }
};

// ---------- 角色 ----------
export const chars = {
  async all() {
    const db = await openDB();
    return req2p(db.transaction('characters').objectStore('characters').getAll());
  },
  async get(id) {
    const db = await openDB();
    return req2p(db.transaction('characters').objectStore('characters').get(id));
  },
  async put(c) {
    const db = await openDB();
    const t = db.transaction('characters', 'readwrite');
    t.objectStore('characters').put(c);
    return new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
  },
  /**
   * 删角色，连同属于她的一切：聊天记录（含归档的）+ 长期记忆。
   *
   * 记忆这一条是 v1.21.59 改的。原来这里写着「记忆是全局共用的，删角色不连坐」——
   * 那句是错的：memories 表有 charId 索引，每条记忆都明确属于某一个角色，
   * 「全局共用」的只是记忆的【整理节奏参数】。于是删角色之后，她的记忆全留下来
   * 变成孤儿，只能在记忆页的「已删除的角色」分组里看到，既删不干净也占着空间。
   *
   * 按 charId 走索引删，不会碰到别的角色的记忆。
   */
  async del(id) {
    const db = await openDB();
    const t = db.transaction(['characters', 'messages', 'memories'], 'readwrite');
    t.objectStore('characters').delete(id);
    for (const store of ['messages', 'memories']) {
      const req = t.objectStore(store).index('charId').openCursor(IDBKeyRange.only(id));
      req.onsuccess = (e) => { const c = e.target.result; if (c) { c.delete(); c.continue(); } };
    }
    return new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
  }
};

// ---------- 消息 ----------
export const msgs = {
  /**
   * 列出消息。
   * 默认【不含已归档的】——归档的意义就是"不再进上下文、不再参与计数"，
   * 但原文仍留在库里，随时能展开回看。
   * includeArchived=true 用来取全部（归档区展示用）。
   */
  async list(charId, limit = 0, includeArchived = false) {
    const db = await openDB();
    const idx = db.transaction('messages').objectStore('messages').index('charId_ts');
    let all = await req2p(idx.getAll(IDBKeyRange.bound([charId, -Infinity], [charId, Infinity])));
    if (!includeArchived) all = all.filter(m => !m.archived);
    return limit > 0 ? all.slice(-limit) : all;
  },
  /** 已归档的那些（按时间正序），给界面折叠区用 */
  async archived(charId) {
    const db = await openDB();
    const idx = db.transaction('messages').objectStore('messages').index('charId_ts');
    const all = await req2p(idx.getAll(IDBKeyRange.bound([charId, -Infinity], [charId, Infinity])));
    return all.filter(m => m.archived);
  },
  /** 批量打归档标记。故意不真删：原文留着，随时能恢复 */
  async archive(ids) {
    if (!ids || !ids.length) return 0;
    const db = await openDB();
    const t = db.transaction('messages', 'readwrite');
    const st = t.objectStore('messages');
    for (const id of ids) {
      const r = st.get(id);
      r.onsuccess = () => {
        const m = r.result;
        if (m) { m.archived = true; st.put(m); }
      };
    }
    return new Promise((res, rej) => {
      t.oncomplete = () => res(ids.length);
      t.onerror = () => rej(t.error);
    });
  },
  /** 取消归档（恢复） */
  /**
   * 取消【单条】归档（v1.21.24 新增，审计第 14 条）。
   *
   * 起因：归档区消息菜单里有「取消归档」按钮，但点击分派链里根本没有对应分支 ——
   * 点下去菜单关闭、无 toast、无报错、状态不变，完全是哑的。
   * 而上面那个 unarchive(charId) 是【全量】恢复，做不了"只恢复这一条"。
   */
  async unarchiveOne(id) {
    const db = await openDB();
    const t = db.transaction('messages', 'readwrite');
    const s = t.objectStore('messages');
    const m = await req2p(s.get(id));
    if (m) { m.archived = false; s.put(m); }
    return new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
  },

  async unarchive(charId) {
    const db = await openDB();
    const t = db.transaction('messages', 'readwrite');
    const st = t.objectStore('messages');
    const idx = st.index('charId');
    const r = idx.openCursor(IDBKeyRange.only(charId));
    let n = 0;
    r.onsuccess = (e) => {
      const c = e.target.result;
      if (c) {
        const m = c.value;
        if (m.archived) { delete m.archived; c.update(m); n++; }
        c.continue();
      }
    };
    return new Promise((res, rej) => {
      t.oncomplete = () => res(n);
      t.onerror = () => rej(t.error);
    });
  },
  async add(m) {
    const db = await openDB();
    const t = db.transaction('messages', 'readwrite');
    t.objectStore('messages').put(m);
    return new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
  },
  /**
   * 批量写入（v0.4.0，导入酒馆聊天记录用）。
   *
   * 为什么要它：一份酒馆导出的聊天记录动辄几千条，逐条 add 就是几千个事务 ——
   * 在手机上实测会卡到几十秒，中途退出还会留下半份记录（而且没人知道导到哪了）。
   * 一个事务写完，要么全进要么全不进。
   */
  async addMany(list) {
    const arr = (list || []).filter(m => m && m.id);
    if (!arr.length) return 0;
    const db = await openDB();
    const t = db.transaction('messages', 'readwrite');
    const s = t.objectStore('messages');
    for (const m of arr) s.put(m);
    return new Promise((res, rej) => { t.oncomplete = () => res(arr.length); t.onerror = () => rej(t.error); });
  },
  async del(id) {
    const db = await openDB();
    const t = db.transaction('messages', 'readwrite');
    t.objectStore('messages').delete(id);
    return new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
  },
  async clear(charId) {
    const db = await openDB();
    const t = db.transaction('messages', 'readwrite');
    const idx = t.objectStore('messages').index('charId');
    const r = idx.openCursor(IDBKeyRange.only(charId));
    r.onsuccess = (e) => { const c = e.target.result; if (c) { c.delete(); c.continue(); } };
    return new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
  }
};

// ---------- 长期记忆 ----------
/**
 * 记忆数据变了就广播一声（v0.5.2.3）。
 *
 * 设置页「已记住的事」那段列表是 renderMem() 一次性拼出来的静态 HTML ——
 * 它只在【展开那一段】和【用户自己操作完】的时候重绘。可是记忆真正变化的地方
 * 大多在它看不见的地方：后台按时间过期、自动整理压成大意、模型这一轮新抽出一条、
 * 群聊那边收下一条草稿…… 结果是列表停在用户上次展开时的样子（条数、状态都不对），
 * 退出设置页再进来才对 —— 而这一段是折叠的，退出再进也不会自动重绘。
 *
 * 所以：所有写入成功之后在这里统一广播，谁关心谁自己听（app.js 听的是重绘）。
 * 用事件而不是回调，是因为写入点分散在总结 / 归档 / 整理 / 导入 / 手写好几处，
 * 逐个去接一定会漏。
 */
function notifyMemChanged() {
  try { window.dispatchEvent(new CustomEvent('mem-changed')); } catch { /* 没有 window 就算了 */ }
}

export const mem = {
  /** 全部记忆（记忆是全局的，不按角色分） */
  async all() {
    const db = await openDB();
    const arr = await req2p(db.transaction('memories').objectStore('memories').getAll());
    return arr.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  },
  async list(charId) {
    const db = await openDB();
    return req2p(db.transaction('memories').objectStore('memories').index('charId').getAll(charId));
  },
  async add(m) {
    const db = await openDB();
    const rec = normalizeMemory(m);
    // 槽位取代（v0.5.1.1 / M0.6）：同一个槽位只留最新说法，旧的标 superseded、不物理删。
    //
    // 放在这一层而不是各个写入点：全库有 7 处 mem.add（实时总结 / 归档总结 / 群聊总结 /
    // 整理记忆 / 导入 / 手写），逐处加"先查一遍旧记录"既啰嗦又一定会漏掉某处。
    // 这里是唯一收口，加一次全部生效。
    //
    // ⚠️ 单事务（v0.5.1.6 修，外部评审 §六）。
    //
    // 原来是【两个事务】：先单独提交"把旧的标成 superseded"，再另起一个事务 put 新的。
    // 中间那次失败（配额满、事务中止、页面被系统杀）的后果是：
    //   旧的已经不在 active，新的又没写进去，supersededBy 指向一个不存在的 id ——
    // 用户看到的是"记忆凭空消失"，而且没有任何报错。
    //
    // 顺带堵住并发：两个总结同时写同一个槽位时，原来两边可能都读到"旧的还没被标"，
    // 于是同槽出现两条 active，或者同一条被顶两次。
    //
    // 现在读旧 / 标旧 / 写新在同一个 readwrite 事务里，要么全成要么全不成。
    // ⚠️ 事务回调里【不能 await】（会跳出事件循环、事务自动提交），
    //    所以这一段全是同步的 put，由 oncomplete 统一收口。
    // ⚠️ 只有【生效的写入】才参与冲突计划（v0.5.2.2，外部评审 P0-1）。
    //
    // 原来是"无条件跑 planSupersede / planExpire"，只看旧记录是不是 active、
    // 不看【新记录】是什么状态。后果是一条待确认的草稿（status='draft'，
    // 按设计不进提示词）也能把同槽位当前生效的记忆顶成 superseded/expired：
    // 收件箱里躺着一条"待确认"，她同时把原来记得的事忘了 —— 用户看到的是
    // 「待确认」，感受到的是失忆。导入旧备份里的 superseded/deleted 条目同理。
    //
    // 状态不是 active（或没有 status，= 老数据的 active）时一律"原样落库"，
    // 不碰任何旧记录。
    const isLive = !rec.status || rec.status === MEMORY_STATUS.ACTIVE;
    const t = db.transaction('memories', 'readwrite');
    const st = t.objectStore('memories');
    const rq = st.index('charId').getAll(rec.charId);
    rq.onsuccess = () => {
      try {
        const old = rq.result || [];
        // 同槽位的新说法 → 旧的标 superseded（fact / goal / relationship / item / belief）
        const plan = (isLive && rec.key) ? planSupersede(rec, old) : [];
        for (const id of plan) {
          const o = old.find(x => x && x.id === id);
          if (!o) continue;
          st.put(normalizeMemory({
            ...o,
            status: MEMORY_STATUS.SUPERSEDED,
            supersededBy: rec.id,
            supersededDay: rec.day || null,
            supersededAt: Date.now()
          }));
        }
        if (plan.length) rec.supersedes = plan.slice();
        // 同槽位的旧 state → 标 expired，限期 = 新状态的起点（0.6.0 §6.1）。
        // 语义不一样：state 不是"被顶掉"，而是"到那天为止是这样"，
        // 记忆页的时间线要按「已过期」显示，不能和「已被取代」混在一起。
        const exp = (isLive && rec.key) ? planExpire(rec, old) : [];
        for (const one of exp) {
          const o = old.find(x => x && x.id === one.id);
          if (!o) continue;
          st.put(normalizeMemory({
            ...o,
            status: MEMORY_STATUS.EXPIRED,
            untilDay: one.untilDay != null ? one.untilDay : (o.untilDay != null ? o.untilDay : null),
            expiredBy: rec.id,
            expiredAt: Date.now()
          }));
        }
      } catch (e) {
        // 取代计划出错就只写新的，旧的留着（宁可两条并存，也不静默丢一条）。
        // 但要留下痕迹（v0.5.2.2，外部评审 P1-9）：原来这里是空 catch，
        // 用户只看到"检查器里两条同时显示"，没有任何地方能查到为什么。
        try { console.warn('[mem.add] 冲突计划失败，只写新的', e); } catch { /* 控制台也没了就认了 */ }
        delete rec.supersedes;
      }
      st.put(rec);
    };
    // 读旧条失败（极少）：不 abort 整个事务，退化成"只写新的"
    rq.onerror = () => { try { st.put(rec); } catch { /* 真写不进去就让事务报错 */ } };
    return new Promise((res, rej) => {
      t.oncomplete = () => { notifyMemChanged(); res(undefined); };
      t.onerror = () => rej(t.error);
    });
  },
  /**
   * 改一条记忆的字段 / 状态（0.6.0）。
   * 软删、恢复、pin、编辑 text/key/kind/scope 全走这里：一处归一化、一处盖 updatedAt。
   * 只 get + put 两个请求，同一个事务，失败整条不生效。
   */
  async mark(id, patch) {
    const db = await openDB();
    const t = db.transaction('memories', 'readwrite');
    const st = t.objectStore('memories');
    const rq = st.get(id);
    rq.onsuccess = () => {
      const cur = rq.result;
      if (!cur) return;
      st.put(normalizeMemory({ ...cur, ...(patch || {}), updatedAt: Date.now() }));
    };
    return new Promise((res, rej) => {
      t.oncomplete = () => { notifyMemChanged(); res(undefined); };
      t.onerror = () => rej(t.error);
    });
  },
  /**
   * 软删除（规格 §6.3）：只把 status 改成 deleted 并记 deletedAt，不物理删。
   * 物理删一条关系记忆是没法从聊天记录里找回来的；30 天后才允许清理。
   */
  async softDel(id) {
    return this.mark(id, { status: MEMORY_STATUS.DELETED, deletedAt: Date.now() });
  },
  /** 恢复一条被软删 / 过期的记忆：状态回 active，清掉删除时间与限期（否则下一轮又过期） */
  async restore(id) {
    return this.mark(id, { status: MEMORY_STATUS.ACTIVE, deletedAt: null, untilDay: null, untilHour: null, untilMinute: null });
  },
  /**
   * 物理删。只给"清空这个角色的数据"用（规格 §6.3 允许的唯一场景），
   * 界面上的删除按钮一律走 softDel。
   */
  async del(id) {
    const db = await openDB();
    const t = db.transaction('memories', 'readwrite');
    t.objectStore('memories').delete(id);
    return new Promise((res, rej) => {
      t.oncomplete = () => { notifyMemChanged(); res(undefined); };
      t.onerror = () => rej(t.error);
    });
  }
};

// ---------- 世界书 ----------
// 结构说明：
//   wbGroups: { id, name, members:[charId...], entries:[{id,keys:[],content,on}] }
//             —— "全局设置"里的角色组。一个角色可以在多个组里。
//             —— ⚠️ 没被加进任何组的角色【不受全局影响】（用户明确要求）。
//   wbSolo:   { id, charId, entries:[{id,keys:[],content,on}] }
//             —— "单独角色"的条目，和全局完全独立、互不影响。
// 条目里的 keys 是触发词数组，content 是命中后注入的正文。
export const wb = {
  // ---- 角色组 ----
  async groups() {
    const db = await openDB();
    const arr = await req2p(db.transaction('wbGroups').objectStore('wbGroups').getAll());
    // 排序：用户拖过的按 order 排；没拖过的（v1.16.4 之前的老数据）order 视为 0，
    // 用创建时间当次序 —— 这样老数据不会因为缺 order 就被顶到最前面。
    return arr.sort((a, b) => {
      const oa = typeof a.order === 'number' ? a.order : 0;
      const ob = typeof b.order === 'number' ? b.order : 0;
      if (oa !== ob) return oa - ob;
      return (a.createdAt || 0) - (b.createdAt || 0);
    });
  },
  /** 批量写排序：ids 按目标顺序排列，第 i 个的顺序值 = i */
  async reorderGroups(ids) {
    const all = await wb.groups();
    const byId = new Map(all.map(g => [g.id, g]));
    const seen = new Set();
    let n = 1;
    // ⚠️ 拖过的按拖拽顺序编号（v1.21.24 修，审计第 7 条）。
    for (const id of ids) {
      const g = byId.get(id);
      if (g) { await wb.putGroup({ ...g, order: n++ }); seen.add(id); }   // 从 1 开始，避开"没 set 过 = 0"
    }
    // ⚠️ 没参与本次拖拽的组【也要编号】，接在后面（v1.21.24 修）。
    //
    // 起因：老写法只给传入的 ids 赋 order，其余组 order 保持 undefined →
    // groups() 排序时按 0 算 → 它们插到所有已排序组【前面】。
    // 用户拖一次，别的组自己跳到最上面；再拖还是乱的（不收敛）。
    // 实测证据：拖 ['G3','G1'] 后实际顺序 `组2, 组3, 组1`（期望 `组3, 组1, 组2`）。
    for (const g of all) {
      if (!seen.has(g.id)) await wb.putGroup({ ...g, order: n++ });
    }
  },
  async group(id) {
    const db = await openDB();
    return req2p(db.transaction('wbGroups').objectStore('wbGroups').get(id));
  },
  async putGroup(g) {
    const db = await openDB();
    const t = db.transaction('wbGroups', 'readwrite');
    t.objectStore('wbGroups').put(g);
    return new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
  },
  async delGroup(id) {
    const db = await openDB();
    const t = db.transaction('wbGroups', 'readwrite');
    t.objectStore('wbGroups').delete(id);
    return new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
  },
  // ---- 单独角色 ----
  async soloAll() {
    const db = await openDB();
    return req2p(db.transaction('wbSolo').objectStore('wbSolo').getAll());
  },
  async solo(charId) {
    const db = await openDB();
    const arr = await req2p(db.transaction('wbSolo').objectStore('wbSolo').index('charId').getAll(charId));
    // 一个角色可能因为历史原因有多条，取第一条（正常只有一条）
    return arr[0] || null;
  },
  async putSolo(rec) {
    const db = await openDB();
    const t = db.transaction('wbSolo', 'readwrite');
    t.objectStore('wbSolo').put(rec);
    return new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
  },
  async delSolo(id) {
    const db = await openDB();
    const t = db.transaction('wbSolo', 'readwrite');
    t.objectStore('wbSolo').delete(id);
    return new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
  },
  // ---- 删角色时清掉它的成员身份和单独条目（否则会留下幽灵引用）----
  async purgeChar(charId) {
    const gs = await wb.groups();
    for (const g of gs) {
      if ((g.members || []).includes(charId)) {
        g.members = g.members.filter(x => x !== charId);
        await wb.putGroup(g);
      }
    }
    // ⚠️ 要删【所有】同 charId 的 solo，不能只删第一条（v1.21.27 修，复审 新4）。
    //
    // 起因：wb.solo() 只返回第一条（内部是 arr[0]）。
    // 历史遗留 / 旧版本导入造成同一角色有 ≥2 条时，删角色只清掉第一条 ——
    // 剩下的成了永久孤儿：角色没了，条目还在库里，而且 uid 不复用、永远回收不了。
    // 实测：删除前 solo 2 条 → 删除后仍残留 1 条。
    //
    // 这与复审 ③（导入认领主键）是同一根因，那边已修，这里补上。
    for (const s of await wb.soloAll()) {
      if (s && s.charId === charId) await wb.delSolo(s.id);
    }
  },
};

// ---------- 小说层：一场戏 ----------
//
// 一张表存整张场景卡（含正文 blocks 与场记 log）。
// 为什么不做三张表（场景 / 拍 / 段落）：这一层的读写单位【永远是整场】——
// 开一场、写一拍、删一段、进回收站，全是在一张卡上改。拆开只会带来
// 「卡读到一半、段落读失败」和跨表事务，换不到任何好处。
// 正文条数上限 400 段（normalizeScene 里 already 夹住），单条卡撑不到几十 KB。
export const scenes = {
  /** 全部（含回收站里的）—— 备份/导出用 */
  async all() {
    const db = await openDB();
    return req2p(db.transaction('scenes').objectStore('scenes').getAll());
  },
  /** 某个角色的全部（含回收站） */
  async byChar(charId) {
    const db = await openDB();
    return req2p(db.transaction('scenes').objectStore('scenes').index('charId').getAll(charId));
  },
  /** 书架用：不进回收站的那些，新的在前 */
  async shelf(charId) {
    const arr = await scenes.byChar(charId);
    return arr.filter(s => s && s.status !== 'trashed').sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  },
  /** 回收站 */
  async trash(charId) {
    const arr = charId ? await scenes.byChar(charId) : await scenes.all();
    return arr.filter(s => s && s.status === 'trashed')
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  },
  async get(id) {
    const db = await openDB();
    return req2p(db.transaction('scenes').objectStore('scenes').get(id));
  },
  async put(rec) {
    const db = await openDB();
    const t = db.transaction('scenes', 'readwrite');
    t.objectStore('scenes').put(rec);
    return new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
  },
  async putMany(list) {
    const arr = (list || []).filter(Boolean);
    if (!arr.length) return 0;
    const db = await openDB();
    const t = db.transaction('scenes', 'readwrite');
    for (const s of arr) t.objectStore('scenes').put(s);
    return new Promise((res, rej) => { t.oncomplete = () => res(arr.length); t.onerror = () => rej(t.error); });
  },
  async del(id) {
    const db = await openDB();
    const t = db.transaction('scenes', 'readwrite');
    t.objectStore('scenes').delete(id);
    return new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
  },
  /**
   * 删角色时用：把这个角色的戏【解绑】而不是删掉。
   * 规格 §12 的硬规则：删角色时问「保留作品 / 一起删」，默认保留。
   * 保留 = charId 置空、卡上记一个 charName 以便书架还能显示是谁的戏。
   */
  async detachChar(charId, charName) {
    const arr = await scenes.byChar(charId);
    if (!arr.length) return 0;
    const db = await openDB();
    const t = db.transaction('scenes', 'readwrite');
    for (const s of arr) {
      s.charId = '';
      if (charName) s.detachedName = String(charName).slice(0, 40);
      s.updatedAt = Date.now();
      t.objectStore('scenes').put(s);
    }
    return new Promise((res, rej) => { t.oncomplete = () => res(arr.length); t.onerror = () => rej(t.error); });
  },
  /** 清空某个角色的戏（只在用户明确选了「一起删」时调用） */
  async delByChar(charId) {
    const arr = await scenes.byChar(charId);
    const db = await openDB();
    const t = db.transaction('scenes', 'readwrite');
    for (const s of arr) t.objectStore('scenes').delete(s.id);
    return new Promise((res, rej) => { t.oncomplete = () => res(arr.length); t.onerror = () => rej(t.error); });
  }
};

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
