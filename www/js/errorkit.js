/**
 * 错误翻译（v0.5.3.2，清单 §3.1）
 *
 * 问题：主对话以前把服务端原文直接甩给用户 ——「API 错误 400: Bad Request」。
 * 这句话对用户等于没说：他不知道是自己 key 错了、余额空了，还是模型名打错了。
 * 更糟的是它出现在【她的气泡旁边】，看起来像她学会了说 HTTP。
 *
 * 这里只做一件事：把「错误」翻成三样东西 ——
 *   一句话原因（title） / 下一步做什么（steps） / 该给哪几个按钮（actions）
 * 外加一条判断：这个错【该不该自动重试】。
 *
 * 为什么不用一个函数返回字符串：界面要按钮，日志要原话，诊断要结构化字段。
 * 三者拆开，就不会出现「为了好看把有用信息吃掉」的老问题。
 */

/** 错误分类。值同时被 e2e 和 CHANGELOG 引用，改动要连带改测试。 */
export const ERR_KIND = {
  auth: 'auth',           // 401：key 无效 / 过期
  balance: 'balance',     // 402：余额不足
  perm: 'perm',           // 403：没权限 / 模型未开通
  notfound: 'notfound',   // 404：地址或模型名不对
  param: 'param',         // 400/422：参数不支持
  rate: 'rate',           // 429 限流
  quota: 'quota',         // 429 额度用完（跟限流长得像，处置完全不同）
  server: 'server',       // 5xx
  net: 'net',             // 断网 / 连不上
  timeout: 'timeout',     // 连上了但不吐数据
  block: 'block',         // 服务商内容拦截
  tooLong: 'tooLong',     // 上下文超长
  aborted: 'aborted',     // 用户自己按了停止
  unknown: 'unknown'
};

const QUOTA_RE = /quota|insufficient|balance|额度|余额|欠费|arrears/i;
const BLOCK_RE = /safety|content[_ ]?filter|content[_ ]?policy|moderation|违规|内容审查|风险内容/i;
const OVERFLOW_RE = /context[_ ]?length|maximum context|too many tokens|exceed[^.]{0,32}(?:context|token)|上下文[^。；]{0,24}(?:超|过长|上限|溢出)/i;
const TIMEOUT_RE = /等太久了|timeout|timed out|ETIMEDOUT|响应超时/i;
const NET_RE = /failed to fetch|networkerror|network error|load failed|断网|网络|econnreset|enotfound|fetch failed/i;

const T = {
  auth: {
    title: 'API Key 无效或过期',
    steps: ['去设置里重新填一次 Key', '填完点「测试连接」确认能通', 'Key 只在创建时显示一次，复制时别带上空格'],
    actions: ['fillkey', 'testconn', 'copy']
  },
  balance: {
    title: '账户余额不足',
    steps: ['去服务商控制台充值', '或者换一个接口 / 换一把 Key'],
    actions: ['recharge', 'provider', 'copy']
  },
  perm: {
    title: '这个 Key 没有权限，或模型没开通',
    steps: ['到服务商控制台确认这个模型已开通', '或者换一个你确定能用的模型名'],
    actions: ['provider', 'copy']
  },
  notfound: {
    title: '接口地址或模型名不对',
    steps: ['检查「接口」里的 Base URL 是不是少了 /v1', '检查模型名有没有打错（区分大小写）'],
    actions: ['provider', 'testconn', 'copy']
  },
  param: {
    title: '服务商不接受这个请求参数',
    steps: ['多半是思考档位 / 用量回传这类高级参数，', '已经自动摘掉重试过一次还是不行，就先把它关掉'],
    actions: ['retry', 'copy']
  },
  rate: {
    title: '请求太快，正在等你',
    steps: ['一秒别连发好几条', '等十几秒再试'],
    actions: ['retry', 'copy']
  },
  quota: {
    title: '今日或本月的额度用完了',
    steps: ['到服务商控制台看用量和重置时间', '或者换一把 Key / 换一个接口'],
    actions: ['recharge', 'provider', 'copy']
  },
  server: {
    title: '服务商那边繁忙或出错',
    steps: ['这不是你这边的问题，等一会儿再试', '一直这样就去服务商状态页看看'],
    actions: ['retry', 'copy']
  },
  net: {
    title: '网络断了，或者连不上',
    steps: ['看看手机是不是切了网 / 开了飞行模式', '自建地址的话确认服务真的在跑'],
    actions: ['retry', 'copy']
  },
  timeout: {
    title: '连上了，但它一直不回话',
    steps: ['再试一次；还这样就换个时间段', '自建端点慢的话，模型换小一点的'],
    actions: ['retry', 'copy']
  },
  block: {
    title: '被服务商的安全策略挡下了',
    steps: ['把这一轮的剧情往轻里写一点', '或者换一个模型 / 换一个接口'],
    actions: ['retry', 'provider', 'copy']
  },
  tooLong: {
    title: '这一段太长了，模型装不下',
    steps: ['已经试着少带几段历史，还是不行', '那就「从头聊」或者把这段收个尾再往下写'],
    actions: ['retry', 'copy']
  },
  aborted: {
    title: '已停止',
    steps: [],
    actions: []
  },
  unknown: {
    title: '出了点问题',
    steps: ['点「重试一次」再试一遍', '还不行就复制诊断发给开发者'],
    actions: ['retry', 'copy']
  }
};

/** 哪些错误【不该】自动重试（清单 §3.1 表里明确「否」的那几行） */
const NO_RETRY = new Set([
  ERR_KIND.auth, ERR_KIND.balance, ERR_KIND.perm, ERR_KIND.notfound,
  ERR_KIND.param, ERR_KIND.quota, ERR_KIND.block, ERR_KIND.tooLong, ERR_KIND.aborted
]);

/**
 * 把一个 status + detail 归类。
 * @param {number} status
 * @param {string} detail
 * @returns {string}
 */
export function kindOfStatus(status, detail) {
  const d = String(detail || '');
  if (BLOCK_RE.test(d)) return ERR_KIND.block;
  if (OVERFLOW_RE.test(d)) return ERR_KIND.tooLong;
  if (status === 401) return ERR_KIND.auth;
  if (status === 402) return ERR_KIND.balance;
  if (status === 403) return ERR_KIND.perm;
  if (status === 404) return ERR_KIND.notfound;
  if (status === 429) return QUOTA_RE.test(d) ? ERR_KIND.quota : ERR_KIND.rate;
  if (status === 400 || status === 422) return ERR_KIND.param;
  if (status >= 500) return ERR_KIND.server;
  return ERR_KIND.unknown;
}

/**
 * 把一个已经抛出来的错误归类（网络层没有 status，只能看文本）。
 * @param {any} err
 * @returns {string}
 */
export function kindOfError(err) {
  const name = String((err && err.name) || '');
  if (name === 'AbortError') return ERR_KIND.aborted;
  const k = String((err && err.kind) || '');
  if (k) return k;
  const status = Number(err && err.status) || 0;
  const msg = String((err && (err.detail || err.message)) || err || '');
  if (status) return kindOfStatus(status, msg);
  if (OVERFLOW_RE.test(msg)) return ERR_KIND.tooLong;
  if (BLOCK_RE.test(msg)) return ERR_KIND.block;
  if (TIMEOUT_RE.test(msg)) return ERR_KIND.timeout;
  if (NET_RE.test(msg)) return ERR_KIND.net;
  return ERR_KIND.unknown;
}

/**
 * 交给界面的那张卡。
 * @param {any} err
 * @returns {{kind:string,title:string,steps:string[],actions:string[],retryable:boolean,detail:string,status:number}}
 */
export function explain(err) {
  const kind = kindOfError(err);
  const t = T[kind] || T.unknown;
  return {
    kind,
    title: t.title,
    steps: t.steps.slice(),
    actions: t.actions.slice(),
    retryable: !NO_RETRY.has(kind),
    detail: oneLine(String((err && (err.detail || err.message)) || err || '')),
    status: Number(err && err.status) || 0
  };
}

/** 该自动重试吗 */
export function shouldRetry(err) {
  return explain(err).retryable;
}

/**
 * 服务端原文压成一行（错误卡的「技术详情」用它）。
 * 原样保留 —— 排错时就是靠这行。
 */
export function oneLine(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/** 只留 host：诊断里不该出现完整路径（有的中转把 key 塞在 path 里） */
function hostOf(baseUrl) {
  try { return new URL(String(baseUrl || '')).host || '-'; } catch { return '-'; }
}

/**
 * 「复制诊断」。清单要求：含 provider/model/status/code/requestId/时间，
 * 【绝不含】key 与聊天正文 —— 所以这里只收显式传进来的元数据。
 * @param {any} err
 * @param {{provider?:string,model?:string,baseUrl?:string,version?:string,requestId?:string}} [ctx]
 */
export function diagText(err, ctx) {
  const c = ctx || {};
  const e = explain(err);
  const raw = String((err && (err.detail || err.message)) || err || '');
  const lines = [
    '梦弦居 ' + (c.version || '-'),
    '时间 ' + new Date().toISOString(),
    '分类 ' + e.kind + (e.status ? ' (HTTP ' + e.status + ')' : ''),
    '接口 ' + (c.provider || '-') + ' @ ' + hostOf(c.baseUrl),
    '模型 ' + (c.model || '-')
  ];
  if (c.requestId) lines.push('requestId ' + c.requestId);
  if (e.detail) lines.push('原因 ' + e.detail.slice(0, 300));
  if (!e.detail && raw) lines.push('原因 ' + oneLine(raw).slice(0, 300));
  return lines.join('\n');
}
