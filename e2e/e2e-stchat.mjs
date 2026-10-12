// e2e-stchat.mjs — 酒馆聊天记录解析（v0.4.0）
//
// 纯 node 套件：stchat.js 不碰 DOM、不碰数据库，直接 import 进来跑。
// 聊天记录是酒馆用户【唯一搬不回来的东西】（卡能重下、世界书能重下），
// 所以解析这一层必须钉死：认不出来的地方宁可跳过，也不能安到错的人头上。
import { parseStChat, parseStChatJsonl, parseStChatJson, parseStDate, toMessages }
  from '../www/js/stchat.js';

let pass = 0, fail = 0;
const t = (n, ok, ex) => { if (ok) { pass++; console.log('  OK   ' + n); } else { fail++; console.log('  FAIL ' + n + (ex !== undefined ? '  -> ' + JSON.stringify(ex) : '')); } };
const NL = String.fromCharCode(10);

console.log('=== 1. 酒馆的 .jsonl（一行一条）===');
const jsonl = [
  JSON.stringify({ user_name: '我', character_name: '紫', create_date: '2026-01-01T00:00:00.000Z' }),
  JSON.stringify({ name: '我', is_user: true, mes: '在吗', send_date: '2026-01-01T10:00:00.000Z' }),
  JSON.stringify({ name: '紫', is_user: false, mes: '在的', send_date: '2026-01-01T10:00:30.000Z' }),
  JSON.stringify({ name: '紫', is_user: false, mes: '怎么了', send_date: '2026-01-01T10:01:00.000Z' }),
].join(NL);
let p = parseStChat(jsonl);
t('认得出这是酒馆的记录', p.ok === true, p);
t('三条消息都进来了', p.ok && p.msgs.length === 3, p.msgs && p.msgs.length);
t('元信息（你和她的名字）也读到了', p.meta.userName === '我' && p.meta.charName === '紫', p.meta);
t('谁是用户认得出', p.msgs[0].isUser === true && p.msgs[1].isUser === false, p.msgs.map(m => m.isUser));
t('时间跨度算出来了', p.from === Date.parse('2026-01-01T10:00:00.000Z') && p.to === Date.parse('2026-01-01T10:01:00.000Z'), [p.from, p.to]);
t('说话人统计按条数排', p.senders[0].name === '紫' && p.senders[0].count === 2, p.senders);

console.log('=== 2. 坏行只跳那一行，不整份判死 ===');
p = parseStChat([JSON.stringify({ name: '紫', is_user: false, mes: '好', send_date: 1 }),
  '{这不是 JSON',
  '',
  JSON.stringify({ name: '我', is_user: true, mes: '嗯', send_date: 2 })].join(NL));
t('两份好的都进来了', p.ok && p.msgs.length === 2, p.msgs && p.msgs.length);
t('坏行数记下来了', p.badLines === 1, p.badLines);
t('空行不算坏行', p.ok === true);

console.log('=== 3. 没有正文 / 没有时间 ===');
p = parseStChat([JSON.stringify({ name: '紫', is_user: false, mes: '   ', send_date: 1 }),
  JSON.stringify({ name: '紫', is_user: false, mes: '有话', send_date: 2 }),
  JSON.stringify({ name: '紫', is_user: false, mes: '没时间' })].join(NL));
t('空正文的跳过', p.msgs.length === 2, p.msgs.length);
t('空正文有计数', p.noText === 1, p.noText);
t('没时间的也留着（不该丢内容）', p.msgs[1].ts === null, p.msgs[1]);
t('没时间的也计数', p.noTime === 1, p.noTime);

console.log('=== 4. 整份 JSON 的导出也认 ===');
p = parseStChatJson(JSON.stringify([{ name: '紫', is_user: false, mes: 'a', send_date: 1 },
  { name: '我', is_user: true, mes: 'b', send_date: 2 }]));
t('数组形态认', p.ok && p.msgs.length === 2, p.msgs && p.msgs.length);
p = parseStChatJson(JSON.stringify({ user_name: '我', character_name: '紫',
  messages: [{ name: '紫', is_user: false, mes: 'a', send_date: 1 }] }));
t('{messages:[...]} 形态认', p.ok && p.msgs.length === 1, p);
const wrapped = parseStChat(JSON.stringify({ messages: [{ name: '紫', mes: 'a', send_date: 1 }] }));
t('parseStChat 自动分流到 JSON 那条', wrapped.ok === true, wrapped);
p = parseStChat('不是 JSON 也不是 jsonl');
t('两不像 → 说清楚读不了', p.ok === false && !!p.reason, p);
t('空文件 → 说清楚是空的', parseStChat('').ok === false);
t('空数组 → 说清楚里面没有消息', parseStChatJson('[]').ok === false);

console.log('=== 5. 时间的几种存法 ===');
t('毫秒数', parseStDate(1767225600000) === 1767225600000);
t('秒数（小于 1e12 当秒）', parseStDate(1767225600) === 1767225600000);
t('ISO 字符串', parseStDate('2026-01-01T00:00:00.000Z') === Date.parse('2026-01-01T00:00:00.000Z'));
t('认不出的返回 null（不瞎编一个时间）', parseStDate('zzz-not-a-date') === null, parseStDate('zzz-not-a-date'));
t('空的返回 null', parseStDate('') === null && parseStDate(null) === null);

console.log('=== 6. 落库形状 ===');
// ⚠️ 时间要用【真实量级】的毫秒值：parseStDate 对小于 1e12 的数当"秒"处理
// （酒馆两种都存过），拿 1000 / 61000 这种当毫秒用会被它正确地当成秒，测出来就是假的失败。
const T0 = 1767225600000;
p = parseStChat([JSON.stringify({ name: '我', is_user: true, mes: '甲', send_date: T0 }),
  JSON.stringify({ name: '紫', is_user: false, mes: '乙', send_date: T0 + 60000 }),
  JSON.stringify({ name: '我', is_user: true, mes: '丙', send_date: T0 + 120000 })].join(NL));
const ms = toMessages(p, 'C1', 5000, (() => { let i = 0; return () => 'x' + (++i); })());
t('条数对上', ms.length === 3, ms.length);
t('角色对调对了（is_user → user/assistant）', ms[0].role === 'user' && ms[1].role === 'assistant', ms.map(m => m.role));
t('charId 全挂上了', ms.every(m => m.charId === 'C1'));
t('正文原样', ms[0].content === '甲' && ms[2].content === '丙', ms.map(m => m.content));
t('id 不重复', new Set(ms.map(m => m.id)).size === 3);
t('相对间隔保留（0 / 60s / 120s）', ms[0].ts === 5000 && ms[1].ts === 65000 && ms[2].ts === 125000, ms.map(m => m.ts));
t('原文一个字没被改（甲还是甲）', p.msgs[0].mes === '甲');

console.log('=== 7. 一份大的也要扛得住 ===');
const big = [];
for (let i = 0; i < 3000; i++) {
  big.push(JSON.stringify({ name: i % 2 ? '紫' : '我', is_user: i % 2 === 0, mes: '第' + i + '句，随便写点什么让它有点长度。', send_date: 1767225600000 + i * 60000 }));
}
const t0 = Date.now();
const bp = parseStChat(big.join(NL));
t('3000 条全解析出来', bp.ok && bp.msgs.length === 3000, bp.msgs && bp.msgs.length);
t('解析耗时在 1 秒内', Date.now() - t0 < 1000, (Date.now() - t0) + 'ms');
t('说话人就两个', bp.senders.length === 2, bp.senders.map(s => s.name));

console.log('');
console.log('通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
