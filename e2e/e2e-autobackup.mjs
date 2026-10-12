// 自动备份（autobackup.js）的纯函数测试 —— 不需要 Chrome。
//
// 重点是「删除」那条路：这段代码每次跑都会从用户目录里删文件，
// 删错一次就是不可逆的数据损失。所以边界要全部钉死。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readCode } from './e2e-src.mjs';

const R = path.resolve(import.meta.dirname, '..').split(path.sep).join('/');
const tmp = R + '/_archive/_autobackup_undertest.mjs';
fs.mkdirSync(R + '/_archive', { recursive: true });
fs.writeFileSync(tmp, readCode(R + '/www/js/autobackup.js'), 'utf8');
const AB = await import(pathToFileURL(tmp).href);

let pass = 0, fail = 0;
const t = (n, ok, ex) => { if (ok) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (ex !== undefined ? '   → ' + ex : '')); } };

// ---- 假的 kv / FS ----
function makeKv(init = {}) {
  const m = new Map(Object.entries(init));
  return { get: async (k, d) => (m.has(k) ? m.get(k) : d), set: async (k, v) => { m.set(k, v); }, _m: m };
}
function makeFS(opts = {}) {
  const log = { writes: [], dirs: [], deleted: [], readdirCalls: [] };
  const failDirs = new Set(opts.failDirs || []);
  return {
    log,
    writeFile: async (o) => { log.writes.push(o); if (failDirs.has(o.directory)) throw new Error('EACCES ' + o.directory); log.dirs.push(o.directory); return { uri: 'file:///' + o.directory + '/' + o.path }; },
    readdir: async (o) => { log.readdirCalls.push(o); return { files: (opts.files || []).map(n => ({ name: n })) }; },
    deleteFile: async (o) => { log.deleted.push(o.path); },
  };
}
const collect = async () => ({ version: 1, characters: [], messages: {} });

// ---------- backupName ----------
console.log('文件名');
t('格式固定宽度（字典序=日期序）', AB.backupName(new Date(2026, 9, 7)) === '梦弦居自动备份-2026-10-07.json', AB.backupName(new Date(2026, 9, 7)));
t('月份补零', AB.backupName(new Date(2026, 0, 3)) === '梦弦居自动备份-2026-01-03.json');

// ---------- pickOldBackups ----------
console.log('滚动清理');
const mk = n => '梦弦居自动备份-2026-01-' + String(n).padStart(2, '0') + '.json';
t('不足 7 份不删', AB.pickOldBackups([mk(1), mk(2), mk(3)]).length === 0);
t('刚好 7 份不删', AB.pickOldBackups(Array.from({ length: 7 }, (_, i) => mk(i + 1))).length === 0);
const over = AB.pickOldBackups(Array.from({ length: 10 }, (_, i) => mk(i + 1)));
t('10 份删 3 份', over.length === 3, over.length);
t('删的是最旧的 3 份', JSON.stringify(over) === JSON.stringify([mk(1), mk(2), mk(3)]), JSON.stringify(over));
t('自定义 keep', AB.pickOldBackups(Array.from({ length: 5 }, (_, i) => mk(i + 1)), 2).length === 3);

// ⚠️ 这条最重要：目录里可能混着用户自己导出的备份 / 别的东西，绝不能一起删
t('不动用户自己的文件', AB.pickOldBackups(['梦弦居备份-2026-01-01.json', '我的照片.png', 'notes.txt', mk(1)]).length === 0);
t('只认自动备份的前缀和后缀', AB.pickOldBackups(['梦弦居自动备份-2026-01-01.zip', 'x梦弦居自动备份-2026-01-01.json']).length === 0);
t('混在一起时只删够数的自动备份', AB.pickOldBackups(['别动我.json', mk(1), mk(2), mk(3), mk(4), mk(5), mk(6), mk(7), mk(8)]).length === 1);
t('空/非数组不炸', AB.pickOldBackups(null).length === 0 && AB.pickOldBackups([null, 123, undefined]).length === 0);

// ---------- autoBackupIfDue ----------
console.log('到期判断');
const NOW = new Date(2026, 9, 7, 12, 0, 0).getTime();
{
  const kv = makeKv({ [AB.STAMP_KEY]: NOW - 1000 });   // 1 秒前刚备份过
  const FS = makeFS();
  const r = await AB.autoBackupIfDue({ kv, FS, collect, now: NOW });
  t('没到期 → 不跑', r.ran === false && r.reason === 'not-due', JSON.stringify(r));
  t('没到期 → 不写文件', FS.log.writes.length === 0);
}
{
  const kv = makeKv({ [AB.STAMP_KEY]: NOW - AB.DAY_MS - 1 });   // 刚过 24 小时
  const FS = makeFS();
  const r = await AB.autoBackupIfDue({ kv, FS, collect, now: NOW });
  t('过 24 小时 → 跑', r.ran === true, JSON.stringify(r));
  t('文件名带日期', r.name === '梦弦居自动备份-2026-10-07.json', r.name);
  t('写进子目录', FS.log.writes[0] && FS.log.writes[0].path === '梦弦居备份/梦弦居自动备份-2026-10-07.json', JSON.stringify(FS.log.writes[0] && FS.log.writes[0].path));
  t('utf8 编码', FS.log.writes[0].encoding === 'utf8');
  t('写了时间戳', kv._m.get(AB.STAMP_KEY) === NOW, kv._m.get(AB.STAMP_KEY));
}
{
  const kv = makeKv();   // 从没备份过
  const FS = makeFS();
  const r = await AB.autoBackupIfDue({ kv, FS, collect, now: NOW });
  t('从未备份过 → 立刻跑', r.ran === true);
}

console.log('目录回退');
{
  const kv = makeKv();
  // v1.21.52 把顺序改回 DOCUMENTS 优先：EXTERNAL 就是 /Android/data/<包名>/files，
  // 卸载或「清除数据」时会被系统连包一起删掉 —— 那正是备份最该起作用的两个场景。
  t('默认第一顺位是 DOCUMENTS（唯一能活过卸载的位置）', AB.BACKUP_DIRS[0] === 'DOCUMENTS', AB.BACKUP_DIRS.join(' → '));
  t('EXTERNAL 仍然是第二顺位', AB.BACKUP_DIRS[1] === 'EXTERNAL', AB.BACKUP_DIRS.join(' → '));
  const FS = makeFS({ failDirs: ['DOCUMENTS'] });
  const r = await AB.autoBackupIfDue({ kv, FS, collect, now: NOW });
  t('第一个目录失败就试下一个', r.ran === true && r.dir === 'EXTERNAL', JSON.stringify(r));
  t('两个目录都试过', FS.log.writes.length === 2, FS.log.writes.length);
}
{
  const kv = makeKv();
  const FS = makeFS({ failDirs: ['DOCUMENTS', 'EXTERNAL', 'DATA'] });
  const r = await AB.autoBackupIfDue({ kv, FS, collect, now: NOW });
  t('全失败 → write-failed', r.ran === false && r.reason === 'write-failed', JSON.stringify(r));
  // ⚠️ 关键：写失败【不能】盖时间戳，否则接下来一整天都不再尝试
  t('写失败【不】盖时间戳', !kv._m.has(AB.STAMP_KEY), kv._m.get(AB.STAMP_KEY));
}

console.log('失败分支');
{
  const kv = makeKv();
  const FS = makeFS();
  const r = await AB.autoBackupIfDue({ kv, FS, collect: async () => { throw new Error('IndexedDB 挂了'); }, now: NOW });
  t('收集失败 → collect-failed', r.ran === false && r.reason === 'collect-failed', JSON.stringify(r));
  t('收集失败带原因', /IndexedDB 挂了/.test(r.error || ''), r.error);
  t('收集失败【不】盖时间戳', !kv._m.has(AB.STAMP_KEY));
  t('收集失败不写文件', FS.log.writes.length === 0);
}
{
  const r = await AB.autoBackupIfDue({ kv: makeKv(), FS: null, collect });
  t('没有 Filesystem 插件（浏览器）→ 直接跳过', r.ran === false && r.reason === 'no-filesystem');
}

console.log('清理');
{
  const kv = makeKv();
  // ⚠️ readdir 必须包含【本次刚写进去的那份】—— 真实目录就是这样。
  //    第一版漏了它，期望值算成 9-7=2（而不是 10-7=3），是测试错了不是代码错了。
  const files = Array.from({ length: 9 }, (_, i) => '梦弦居自动备份-2026-09-' + String(i + 1).padStart(2, '0') + '.json')
    .concat(['梦弦居自动备份-2026-10-07.json']);
  const FS = makeFS({ files });
  const r = await AB.autoBackupIfDue({ kv, FS, collect, now: NOW });
  t('9 份旧 + 本次 = 10 → 删 3', r.deleted.length === 3, JSON.stringify(r.deleted));
  t('删的是最早的', r.deleted[0] === files[0], r.deleted[0]);
  t('真的调了 deleteFile', FS.log.deleted.length === 3, FS.log.deleted.length);
}
{
  const kv = makeKv();
  const FS = makeFS();
  FS.readdir = async () => { throw new Error('读不了目录'); };
  const r = await AB.autoBackupIfDue({ kv, FS, collect, now: NOW });
  t('清理失败不影响「备份成功」的结论', r.ran === true, JSON.stringify(r));
}


// ---------- verifyLatestBackup（v0.3.1：写成功 ≠ 读得回来）----------
// 造一个只做 readdir / readFile 的假 FS。map 的键是完整 path，值是文件内容。
function mkVerifyFS(map) {
  return {
    readdir: async (o) => ({ files: Object.keys(map[o.directory] || {}).map(p => ({ name: p.split('/').pop() })) }),
    readFile: async (o) => {
      const v = (map[o.directory] || {})[o.path];
      if (v === undefined) throw new Error('ENOENT ' + o.path);
      return { data: v };
    },
  };
}
console.log('备份自检');
// ⚠️ messages 必须用【真实形状】（v0.3.1 复查）：它是按 charId 分组的对象，
//    不是数组 —— 见 app.js 的 collectBackupPayload：payload.messages[c.id] = [...]
//    这里原来写成数组，于是测试验的是一个不存在的形状，也就没能发现
//    verifyLatestBackup 里 Array.isArray(obj.messages) 恒为 false、消息数永远报 0。
const GOOD = JSON.stringify({ version: 1, exportedAt: 123, characters: [{ id: 'a' }],
                              messages: { a: [{ id: 'm1' }, { id: 'm2' }] } });
const P1 = '梦弦居备份/梦弦居自动备份-2026-01-01.json';
const P2 = '梦弦居备份/梦弦居自动备份-2026-02-02.json';
{
  const r = await AB.verifyLatestBackup({ FS: mkVerifyFS({ DOCUMENTS: { [P1]: GOOD } }) });
  t('好备份：认得出可读，并报出条数', r.ok === true && r.characters === 1 && r.messages === 2, JSON.stringify(r));
}
{
  // ⚠️ 这条是补的（v0.3.1）：上面那条只要 fixture 写对了就能过，
  //    但"对象形状"这件事本身值得单独钉住 —— 它正是漏掉那个 bug 的地方。
  const OBJ = JSON.stringify({ version: 1, exportedAt: 1, characters: [], messages: { a: [{ id: 'x' }], b: [{ id: 'y' }, { id: 'z' }] } });
  const r = await AB.verifyLatestBackup({ FS: mkVerifyFS({ DOCUMENTS: { [P1]: OBJ } }) });
  t('多个角色的消息要【累加】数（对象形状，不是取 .length）', r.ok === true && r.messages === 3, JSON.stringify(r));
}
{
  // 兼容：万一将来有老备份把 messages 存成数组，也得数得出来。
  const ARR = JSON.stringify({ version: 1, exportedAt: 1, characters: [], messages: [{ id: 'x' }, { id: 'y' }] });
  const r = await AB.verifyLatestBackup({ FS: mkVerifyFS({ DOCUMENTS: { [P1]: ARR } }) });
  t('messages 万一是数组也认（兼容老形状）', r.ok === true && r.messages === 2, JSON.stringify(r));
}
{
  const NON = JSON.stringify({ version: 1, exportedAt: 1, characters: [], messages: null });
  const r = await AB.verifyLatestBackup({ FS: mkVerifyFS({ DOCUMENTS: { [P1]: NON } }) });
  t('messages 缺失/null → 数成 0，不炸', r.ok === true && r.messages === 0, JSON.stringify(r));
}
{
  const r = await AB.verifyLatestBackup({ FS: mkVerifyFS({ DOCUMENTS: { [P1]: GOOD.slice(0, 40) } }) });
  t('截断的 JSON → 报 corrupt（这就是「写成功但读不回来」）', r.ok === false && r.reason === 'corrupt', JSON.stringify(r));
}
{
  const r = await AB.verifyLatestBackup({ FS: mkVerifyFS({ DOCUMENTS: { [P1]: '{}' } }) });
  t('合法但空的对象 → 不算数', r.ok === false && r.reason === 'empty', JSON.stringify(r));
}
{
  const r = await AB.verifyLatestBackup({ FS: mkVerifyFS({ DOCUMENTS: { [P1]: 'x' } }) });
  t('坏掉的备份仍然报得出文件名（提示里要说清是哪一份）', r.name === '梦弦居自动备份-2026-01-01.json', JSON.stringify(r));
}
{
  const r = await AB.verifyLatestBackup({ FS: mkVerifyFS({}) });
  t('一份都没有 → reason=none（不算故障，不该弹提示）', r.ok === false && r.reason === 'none');
}
{
  const r = await AB.verifyLatestBackup({ FS: null });
  t('没有文件系统插件 → no-filesystem（同样不算故障）', r.ok === false && r.reason === 'no-filesystem');
}
{
  const r = await AB.verifyLatestBackup({ FS: mkVerifyFS({ DOCUMENTS: { [P1]: 'BROKEN', [P2]: GOOD } }) });
  t('只看最近一份（更早的坏了不影响结论）', r.ok === true && r.name === '梦弦居自动备份-2026-02-02.json', JSON.stringify(r));
}
{
  const r = await AB.verifyLatestBackup({ FS: mkVerifyFS({ EXTERNAL: { [P1]: GOOD } }) });
  t('DOCUMENTS 里没有就去 EXTERNAL 找（跟写侧的目录回退一致）', r.ok === true && r.dir === 'EXTERNAL', JSON.stringify(r));
}
{
  const r = await AB.verifyLatestBackup({ FS: mkVerifyFS({ DOCUMENTS: { '梦弦居备份/别人的文件.json': GOOD } }) });
  t('不把用户自己的文件当备份', r.ok === false && r.reason === 'none', JSON.stringify(r));
}
{
  const FS = { readdir: async () => { throw new Error('读不了目录'); }, readFile: async () => ({ data: GOOD }) };
  const r = await AB.verifyLatestBackup({ FS });
  t('目录读不了 → 不当成故障（继续试下一个 / 返回 none）', r.ok === false && r.reason === 'none', JSON.stringify(r));
}
{
  const FS = { readdir: async () => ({ files: [{ name: '梦弦居自动备份-2026-01-01.json' }] }),
               readFile: async () => { throw new Error('EACCES'); } };
  const r = await AB.verifyLatestBackup({ FS });
  t('文件读不了 → read-failed，且带上原因', r.ok === false && r.reason === 'read-failed', JSON.stringify(r));
}
fs.rmSync(tmp, { force: true });
console.log('');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
