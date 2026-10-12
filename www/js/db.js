// IndexedDB 封装：角色、消息、设置、记忆
const DB_NAME = 'ai-companion';
// ⚠️ 加新表时必须 +1，并且 onupgradeneeded 里要写成【增量式】——
//    只建"还不存在的表"，绝不能把老表删了重建，否则老用户数据全没。
//    v2 加了 worldbook（世界书：角色组 + 条目）。
const DB_VER = 2;

let _db = null;

export async function openDB() {
  if (_db) return _db;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
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
    const [characters, messages, memories, wbGroups, wbSolo, kvCount] = await Promise.all(
      ['characters', 'messages', 'memories', 'wbGroups', 'wbSolo', 'kv'].map(one));
    return { characters, messages, memories, wbGroups, wbSolo, kv: kvCount };
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
    const t = db.transaction('memories', 'readwrite');
    t.objectStore('memories').put(m);
    return new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
  },
  async del(id) {
    const db = await openDB();
    const t = db.transaction('memories', 'readwrite');
    t.objectStore('memories').delete(id);
    return new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
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

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
