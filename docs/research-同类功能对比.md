# 同类软件功能对比调研 —— 中文 AI 陪伴 / 角色扮演聊天 App

> 调研对象：本仓库「梦弦居」（Capacitor + WebView 纯前端，见 [README.md](../README.md)）
> 目的：找出**别的软件有、本 App 没有**的功能点，按「价值 / 成本比」排序，作为后续排期输入。
> 调研日期：2026-10-14。工具限制：`tavily_*` 工具在本环境报 HTTP 432 已失效，全部结论只用 `web_search` + `web_fetch` 取得。
> 方法说明：功能事实以**一手来源**为准（官方文档站、官方仓库 README/SPEC、官方帮助中心）。凡无法用一手来源确认的，正文里显式标「未核实」。
> 本轮无法派生子代理核实（子代理深度上限为 1），全部核实工作由本代理直接完成。

---

## 0. 基线：本 App 已经有什么（用来判定「没有」）

从 [README.md](../README.md) 与 `www/js/app.js`（`contextBudget: 48000`、`estimateTokens`、`fitHistoryByBudget` 等）确认**已有**、因此**不**计入「缺失」的能力：

- 角色卡 V2 / V3 导入导出（JSON / PNG），卡内 `character_book` 会一并导入
- 世界书两层（角色组 / 单独角色）、触发词、一直生效、临场提醒；读不懂的条目落库但不注入并标「待确认」
- 群聊（轮流 / 点名 / 点顶部名字强制），群有独立记录、剧情时间、共享记忆
- 聊天记录 `.jsonl` 导入、酒馆正则导入、酒馆预设**查看**（正则需手动「收进来」，提示词段可转成世界书/人设补充）
- 长期记忆 + 滚动摘要；剧情时间线；发图识图；可选联网搜索
- TTS 朗读开关；上下文预算估算（48000 token 折中值）与按预算裁剪历史
- 大量「表达方式」调节：颜文字频率（带负反馈统计）、emoji、回复长度、分段发送、打字延迟、迟疑
- 数据导出/导入、自动备份保留 7 份、长按消息菜单（复制 / 编辑重发 / 朗读 / 重新生成 / 从这里重聊）

> 注意：世界书条目字段的**实际落库形态**（是否有 constant / probability / depth / 递归）本轮未逐行审计 `app.js`，若某项其实已实现，按「已实现」处理即可，本报告相应条目作废。

---

## A. 缺失功能点清单（70 条）

列含义：**价值**＝对「中文陪伴向聊天」的价值（高/中/低）；**难度**＝纯前端 WebView 环境下的实现难度（低/中/高）；**导入相关**＝是否与「导入外部文件或设置」相关。

### A1 · 角色与卡（1–10）

| # | 功能名 | 谁有 | 解决什么问题 | 价值 | 难度 | 导入相关 |
|---|---|---|---|---|---|---|
| 1 | 多条备选开场白（Alternate Greetings）+ 开局抽一条 | SillyTavern、Character.AI | 每次开局同一句话，重开新鲜感归零 | 高 | 低 | 是（卡字段 `alternate_greetings`） |
| 2 | 群聊专用备选开场白 | SillyTavern（卡规范字段）；谁先消费未核实 | 开局话术按「单人 / 多人」分流 | 中 | 低 | 是 |
| 3 | 创作者备注（Creator Notes）：只在 UI 显示、永不进 prompt | SillyTavern、Character.AI（Tagline/Description 属公开资料） | 让人看到「怎么用这张卡 / 出处在哪」，又不烧 token | 中 | 低 | 是 |
| 4 | 角色版本 / 创建者 / 卡规范版本字段展示 | SillyTavern（CCv2/CCv3） | 卡重复、来源不明、改版后不知道哪张新 | 低 | 低 | 是 |
| 5 | 角色标签（Tags）+ 按标签筛选 | SillyTavern、Character.AI、星野 | 角色多了找不动 | 中 | 低 | 是 |
| 6 | 角色「深度提示词」（Character Note / Depth Prompt）+ 深度可调 | SillyTavern（Prompt Manager 中 Character Notes / Depth prompts） | 不重写人设就把「一直要记住的行为约束」塞到对话最近处，顺从度明显更高 | 高 | 低 | 否 |
| 7 | 对话示例（Example Messages）单独成段、位置策略（全丢 / 渐次挤出 / 永不丢） | SillyTavern | 示例是塑造口吻最有效的手段；本 App 只能塞进人设里吃固定 token | 高 | 中 | 是（CCv2 `mes_example`） |
| 8 | 个性摘要（Personality summary）+「增强定义」（把短标签扩写成完整描述） | SillyTavern | 卡上只写了几个词的性格，直接发等于废话 | 中 | 中 | 是 |
| 9 | 角色级「主要提示词覆盖」（卡自带 system prompt / 覆盖全局预设） | SillyTavern（Prefer Char. Prompt） | 不同角色需要不同书写规则（第一人称 / 禁用旁白 / 出戏台词），全局共用一条会很拧 | 高 | 低 | 是 |
| 10 | 场景（Scenario）字段独立注入 + 每会话覆盖 | SillyTavern、KoboldCpp、Agnai | 「现在是什么场合」是角色扮演的最小上下文单位，混在人设里没法改 | 高 | 低 | 是（卡字段 `scenario`） |

### A2 · 世界书引擎（11–20）

| # | 功能名 | 谁有 | 解决什么问题 | 价值 | 难度 | 导入相关 |
|---|---|---|---|---|---|---|
| 11 | 条目开关（enable/disable，不动内容） | SillyTavern、JanitorAI、KoboldCpp | 调试期想临时掐掉一条，删除又怕丢 | 高 | 低 | 是 |
| 12 | 插入顺序 Order（触发多条时决定谁更靠近结尾） | SillyTavern、NovelAI（Insertion Order） | 全是关键词命中时注入次序随机，重点信息被埋在中间 | 高 | 低 | 是 |
| 13 | 插入位置 Position + 深度 Depth（Before/After Char Defs、Before/After Example Messages、Top/Bottom of Author's Note、按深度插入 + system/user/assistant 角色） | SillyTavern；NovelAI 亦有 position/order 类字段 | 「设定」和「指令」需要放在完全不同的位置才生效，位置错了等于没写 | 高 | 中 | 是 |
| 14 | Selective Logic 二段过滤（AND ANY / AND ALL / NOT ANY / NOT ALL） | SillyTavern、NovelAI（secondary keys + logic） | 「提到咖啡**且**在下雨才注入」这类精确条件，纯触发词做不到 | 高 | 低 | 是 |
| 15 | 递归扫描 + 每条的递归三态（不可被递归 / 阻止继续递归 / 延迟到递归，含 Recursion Level） | SillyTavern；RisuAI 亦有 recursive 模式 | 百科式条目互相引用（提到 A 自动带出 A→B→C），一次触发带出一整片设定 | 中 | 高 | 是 |
| 16 | 条目分组 Inclusion Group + groupWeight + Prioritize Inclusion + Use Group Scoring | SillyTavern | 「一组同义条目只出一条」+「命中词多的那条赢」+「按权重随机」，避免同义信息刷屏 | 中 | 中 | 是 |
| 17 | 概率 Probability（触发 %） | SillyTavern、JanitorAI（Scripts 条目里有 Probability 字段） | 做随机事件 / 稀有彩蛋，不用写脚本 | 中 | 低 | 是 |
| 18 | 时效三件套 Sticky / Cooldown / Delay（按消息数计） | SillyTavern | 「进场后才解锁」「说过一次就闭嘴 N 轮」是人设节奏的关键，纯关键词会复读 | 中 | 中 | 是 |
| 19 | 生成类型触发器（Normal / Continue / Impersonate / Swipe / Regenerate / Quiet）per entry 与 per prompt | SillyTavern | 不希望重 roll 时把某条设定再灌一遍；或只在替用户代笔时给某条规则 | 中 | 中 | 是 |
| 20 | 角色过滤器 / 标签过滤器（含 Exclude 反转） | SillyTavern | 一个世界书服务多个角色时不用手工拆书 | 中 | 低 | 是 |

### A3 · 世界书引擎·续（21–30）

| # | 功能名 | 谁有 | 解决什么问题 | 价值 | 难度 | 导入相关 |
|---|---|---|---|---|---|---|
| 21 | 向量化条目（🔗 状态）配合嵌入模型做语义匹配 | SillyTavern（Vector Storage 扩展） | 用户换个说法（「天气」vs「下雨」）也能命中，关键词漏触发是陪伴向最常见的翻车 | 高 | 高 | 否 |
| 22 | Token 预算 / Min Activations / Max Depth / Alert on overflow | SillyTavern；Chub AI（Token Budget） | 世界书一旦爆炸就把对话挤出窗口，且没人告诉你 | 高 | 中 | 否 |
| 23 | 扫描深度 Scan Depth（全局 + 条目级覆盖） | SillyTavern、Chub AI（Scan Depth） | 只看最近 N 条能省 token、也避免久远关键词误触发 | 高 | 低 | 否 |
| 24 | Include Names（把说话人名作为扫描前缀） | SillyTavern（默认开） | 「只有 Alice 在场时才注入」这类条目靠名字匹配 | 中 | 低 | 否 |
| 25 | 大小写敏感 / 全词匹配 **按语言自动关** | SillyTavern（官方明确警告中日文不要开全词匹配） | 官方原话：不用空格分词的语言开着会**严重误伤**，中文必须默认关 | 高 | 低 | 否 |
| 26 | 正则作为触发键（斜杠包裹的正则，含按说话人匹配的分隔符用法） | SillyTavern | 「只在她说天气时注入」这类条件，纯关键词做不到 | 中 | 中 | 是 |
| 27 | 世界书的角色绑定 / persona 绑定 / **会话绑定**（chat lore）三层自动激活 | SillyTavern | 单聊专属的世界书不用手工开关；换人自动换书 | 高 | 低 | 是 |
| 28 | 世界书来源插入策略（Sorted Evenly / Character First / Global First） | SillyTavern | 同一关键词在角色书和全局书都有条目时，谁优先是可控的 | 低 | 低 | 是 |
| 29 | 条目 Memo / Title 与「用首键回填备注」 | SillyTavern | 二百条条目没标题等于不可维护 | 中 | 低 | 是 |
| 30 | 世界书条目「Outlet」——不自动注入，由 prompt 里的 outlet 宏决定位置 | SillyTavern（官方文档已明确其限制） | 高级用法：让同一条设定出现在精确位置 | 低 | 中 | 否 |

### A4 · 聊天记录 / 会话（31–40）

| # | 功能名 | 谁有 | 解决什么问题 | 价值 | 难度 | 导入相关 |
|---|---|---|---|---|---|---|
| 31 | 检查点 / 分支（Branch 切换、Checkpoint 后台留存、Back to parent） | SillyTavern | 想试另一条剧情线又不愿毁掉当前记录 | 高 | 中 | 否 |
| 32 | 消息「是否可见」开关（Included / Excluded） | SillyTavern | 想留底稿但这一轮不发给模型，一行标志位解决 | 高 | 低 | 否 |
| 33 | 消息上/下移（Move Up / Move Down） | SillyTavern | 挽救顺序错误的注入/系统消息 | 中 | 低 | 否 |
| 34 | 批量多选删除 | SillyTavern | 清一段黑历史不用一条条点 | 中 | 低 | 否 |
| 35 | Token 概率面板（看候选词、改一个 token 后重生成） | SillyTavern | 想让某句话换个走向时，有手术刀级的干预手段 | 低 | 高 | 否 |
| 36 | 新建聊天的「挡板」文案（New Chat / New Group Chat / New Example Chat） | SillyTavern（Prompt Manager Utility Prompts） | 分隔「设定区」和「对话区」，是稳定格式的最省事手段 | 中 | 低 | 是 |
| 37 | 继续（Continue）：把被截断的回复接着写 | SillyTavern、KoboldCpp | 输出被 max_tokens 切断时只能重生成，等于把好开头扔掉 | 高 | 低 | 否 |
| 38 | 空消息替换文案（Replace Empty Message） | SillyTavern | 空发送即可推进剧情（配合自动模式） | 中 | 低 | 是 |
| 39 | 替用户代笔（Impersonate） | SillyTavern、RisuAI（Impersonate inside prompts） | 不知道怎么接话时让 AI 写一句用户台词 | 中 | 低 | 是 |
| 40 | 群聊 Group Nudge 模板 | SillyTavern | 群聊最后缺一句「这次由 X 来说」，模型容易抢话或重复同一人 | 中 | 低 | 是 |

### A5 · 群聊（41–50）

| # | 功能名 | 谁有 | 解决什么问题 | 价值 | 难度 | 导入相关 |
|---|---|---|---|---|---|---|
| 41 | 群聊场景覆盖（用一段共享场景替换全部成员各自的 Scenario） | SillyTavern | 群聊要的是「同一屋檐」，各人自带场景会互相打架 | 中 | 低 | 是 |
| 42 | 「拼接角色卡」模式（Join character cards）+ 前缀/后缀模板 | SillyTavern | 全员定义合并成一份，利于前缀缓存省 token/降延迟；也可控地避免「只认识当前发言人」 | 中 | 中 | 是 |
| 43 | 成员静音 Mute | SillyTavern | 不想某人插话但不想移出群 | 高 | 低 | 否 |
| 44 | 强制发言 Force Talk（绕过发言顺序，静音也能被点名） | SillyTavern | 「这轮我就要她说」 | 高 | 低 | 否 |
| 45 | 自动模式 Auto-mode（按顺序自动连发，5 秒间隔，用户一打字就停） | SillyTavern | 挂机看戏式体验 | 中 | 中 | 否 |
| 46 | 发言积极性 Talkativeness（0=沉默 100=话痨，默认 50%） | SillyTavern（Advanced Definitions） | 群聊里「谁该多说话」是人设的一部分 | 高 | 低 | 是 |
| 47 | 发言顺序：自然顺序（Natural Order，含名字整词识别） | SillyTavern | 现在只有「轮流 / 点名」，真人感不足 | 高 | 中 | 否 |
| 48 | 发言顺序：随机池（Pooled Order，一轮内不重复） | SillyTavern | 一轮里每人都有机会、但不固定次序 | 中 | 低 | 否 |
| 49 | 「转成群聊」（Convert to group，保留历史） | SillyTavern | 单聊聊到一半想拉人进来 | 中 | 中 | 否 |
| 50 | 允许自我连续回复（Allow Self Responses） | SillyTavern | 自然顺序下自己 @ 自己会连发，需要开关约束 | 低 | 低 | 否 |

### A6 · 记忆 / RAG / 向量（51–56）

| # | 功能名 | 谁有 | 解决什么问题 | 价值 | 难度 | 导入相关 |
|---|---|---|---|---|---|---|
| 51 | 聊天向量化（把久远但相关的旧消息临时挪进上下文） | SillyTavern（Chat Vectorization） | 纯摘要会丢细节；相关旧事能自动被翻出来，陪伴向「她记得」质感提升明显 | 高 | 高 | 否 |
| 52 | 知识库 / Data Bank（PDF、HTML、Markdown、ePub、TXT、网页、YouTube 字幕，分全局/角色/会话三级作用域） | SillyTavern（Data Bank/RAG）、Chatbox（知识库/文件上传，未核实）、Agnai（Pipeline：Wikipedia 与 PDF embedding） | 想让她懂一本书 / 一份设定集，不必手写世界书 | 中 | 高 | 是 |
| 53 | 消息向量化分块（chunk 400 字符、按段/换行切） | SillyTavern | 长消息只有最相关片段被注入，省 token | 低 | 高 | 否 |
| 54 | 自动摘要与向量记忆的协同（摘要管「全局梗概」，向量管「细节回溯」） | SillyTavern（内置 Summarize + Vector Storage 两个扩展） | 只有摘要时，具体细节（说过的那句话、去过的店）永久丢失 | 高 | 中 | 否 |
| 55 | 记忆条目的编辑 / 删除 / 单条重生成 · 附带时间戳 | SillyTavern（Summarize 扩展） | 记错的东西要能改，否则越聊越歪 | 高 | 低 | 否 |
| 56 | 固定记忆（Pin message，C.AI 每会话 5 条） | Character.AI（官方帮助中心） | 让用户显式指定「这件事必须一直记得」，比自动摘要可控 | 高 | 低 | 否 |

### A7 · 导入 / 导出 / 互操作（57–62）

| # | 功能名 | 谁有 | 解决什么问题 | 价值 | 难度 | 导入相关 |
|---|---|---|---|---|---|---|
| 57 | 从 TavernAI / Text-Gen-WebUI / Agnai / KoboldAI Lite / RisuAI **导入聊天记录** | SillyTavern（官方 Chat import 列表） | 迁移期老记录能带走，降低换 App 的心理成本 | 中 | 中 | 是 |
| 58 | 导出「角色卡 PNG」（把角色+聊天元数据嵌回图片） | SillyTavern | 分享/迁移靠一张图，比 JSON 方便 | 中 | 低 | 是 |
| 59 | 正则脚本的导出 / 导入 / 全局↔角色作用域互换 | SillyTavern（Regex 扩展） | 正则社区生态是可分享资产 | 中 | 低 | 是 |
| 60 | 预设文件的完整激活（顺序、角色、触发类型、开关） | SillyTavern（Prompt Manager） | 现在只能「看」预设，逐段手动收，迁入成本高 | 高 | 中 | 是 |
| 61 | 斜杠命令 / 脚本（STscript）体系 | SillyTavern（STscript；Quick Replies 为内置扩展） | 自动化、批处理、社区可分享的小工具 | 中 | 高 | 是 |
| 62 | 快捷回复（Quick Replies，面板式常用提示词） | SillyTavern（内置扩展）；JanitorAI 用 Scripts 部分覆盖 | 每天要重复打的「(继续)」「换个说法」应有按钮 | 高 | 低 | 是 |

### A8 · 提示词工程与调试（63–67）

| # | 功能名 | 谁有 | 解决什么问题 | 价值 | 难度 | 导入相关 |
|---|---|---|---|---|---|---|
| 63 | 提示词检查器（Prompt Itemization / Prompt Inspector：看最终 prompt 与各项 token 占用） | SillyTavern | 调不出效果时，唯一能定位「到底发出去了什么」的手段 | 高 | 中 | 否 |
| 64 | 提示词条目开关与拖拽排序（Prompt Manager 的 Prompts List） | SillyTavern；RisuAI（Powerful Prompting，可改顺序/条件） | 不需要编辑 JSON 就能重排与逐段关闭 | 高 | 中 | 是 |
| 65 | 每条的 Role（System / AI Assistant / User）× Position（相对 / In-Chat）× Depth × Order | SillyTavern（Prompt Manager） | 同一段文字以不同 role 送出，效果完全不同 | 中 | 中 | 是 |
| 66 | 可编辑的格式模板（World Info 包装模板、Scenario/Personality 包装模板、Group Nudge、Continue Nudge） | SillyTavern（Utility Prompts） | 决定「设定以什么标题/格式出现」，直接影响跟随度 | 中 | 低 | 是 |
| 67 | Tokenizer 选择（按实际模型分词计数，而非字符估算） | SillyTavern（Token Counter 扩展）、KoboldCpp（显示 context 与 token） | 中文用字符估算误差大，预算判断会失真 | 中 | 中 | 否 |

### A9 · 生成与会话控制（68–70）

| # | 功能名 | 谁有 | 解决什么问题 | 价值 | 难度 | 导入相关 |
|---|---|---|---|---|---|---|
| 68 | 完整采样参数（Top K / 重复惩罚 / 存在惩罚 / 频率惩罚 / Min-P / 种子） | SillyTavern、KoboldCpp、ChatterUI（Sampler fields）、LM Studio | 中文复读、称呼错乱常靠惩罚项与 top-k 缓解 | 中 | 低 | 是 |
| 69 | 本地模型（手机侧 GGUF 推理，Local Mode） | ChatterUI、RisuAI 移动端、KoboldCpp | 无网/无 key 也能聊，隐私彻底 | 中 | 高 | 是 |
| 70 | 配置预设（Config Presets：系统提示 + 参数打包复用） | LM Studio（官方文档）、SillyTavern（Chat Completion preset） | 「陪伴模式 / 创作模式 / 快问快答」一键切换 | 中 | 低 | 是 |

---

## B. 重点展开一：导入时该做什么

### B1 角色卡导入 → 字段怎么进 prompt

**先明确一件事：卡里没有「prompt」这个东西，只有字段；prompt 是导入后由应用自己拼的。** 所以「导入做得对不对」＝字段有没有被正确映射到 prompt 的某个位置。

SillyTavern 的拼装规则（Text Completion 用 Story String 模板，Chat Completion 用 Prompt Manager）官方写得很直白：

- Story String 可用占位符（Handlebars）：`{{description}}`、`{{scenario}}`、`{{personality}}`、`{{system}}`、`{{persona}}`、`{{char}}`、`{{user}}`、`{{wiBefore}} / {{loreBefore}}`、`{{wiAfter}} / {{loreAfter}}`、`{{mesExamples}}`、`{{mesExamplesRaw}}`、`{{anchorBefore}}`、`{{anchorAfter}}`。
- **官方警告：模板里没写的参数，就完全不会送进 prompt。** —— 来源：<https://docs.sillytavern.app/usage/prompts/context-template/>
- 卡字段与 prompt 位置的对应：Description→`{{description}}`；Scenario→`{{scenario}}`（可被会话级 Scenario 覆盖）；Personality→`{{personality}}`；Example Messages→`{{mesExamples}}` 或独立的 Chat Examples 段；卡内 system prompt→`{{system}}`（需「Prefer Char. Prompt」）；卡内 post-history instructions→Post-History Instructions 段；Character Note→Prompt Manager 里的 Character Notes / Depth prompts。
- Chat Completion 的固定默认段（不可删、只能关）：Main Prompt、World Info (before/after)、Persona Description、Character Description、Character Personality、Scenario、Enhance Definitions、Auxiliary Prompt、Chat Examples、Chat History、Post-History Instructions。来源：<https://docs.sillytavern.app/usage/prompts/prompt-manager/>
- 段的 Role（System / AI Assistant / User）、Position（Relative 跟随列表顺序 / In-Chat 走 Depth，忽略列表顺序）、Depth（0＝最后一条消息之后，1＝最后一条之前，依次往前）、Order（同 Role 同 Depth 时按 Order 排，且同类内固定顺序为 User → AI Assistant → System）。来源同上。
- Character Card V3 规范（字段定义、PNG 用 `ccv3` tEXt chunk 存 UTF-8→base64 的 JSON，V2 回退读 `chara` chunk）：<https://github.com/kwaroran/character-card-spec-v3/blob/main/SPEC_V3.md>

**给本 App 的落地建议**：卡字段 → 独立槽位（人设 / 场景 / 对话示例 / 卡内系统提示 / 卡内事后指令 / 深度提示词）→ 每个槽位有明确的 prompt 位置与深度 → 有一个「这段现在到底发在哪」的可视化。当前 App 把大部分内容压在「人设」一个槽里，是导入体验的最大结构性缺口。

### B2 lorebook（世界书）激活机制 —— 确切语义

以下全部来自 <https://docs.sillytavern.app/usage/core-concepts/worldinfo/>：

**激活策略（Strategy）三态**

1. 🔵 Constant（常驻）——不需要任何关键词，无条件触发。
2. 🟢 Normal——只有出现关键词才触发。
3. 🔗 Vectorized——允许由嵌入相似度触发（依赖 Vector Storage 扩展）。

**二段过滤 / Selective Logic**（Optional Filter，配合主键）

- AND ANY：主键**且**任意一个过滤键出现
- AND ALL：主键**且**所有过滤键都出现
- NOT ANY：主键**且**过滤键一个都不出现
- NOT ALL：过滤键全出现时**阻止**触发

**条目字段速查**

| 字段 | 确切含义 |
|---|---|
| Insertion Order | 数值。同时命中多条时决定谁更靠后（越靠后影响越大）。例：Order 100 出现在 Order 250 之前 |
| Insertion Position | Before/After Char Defs、Before/After Example Messages（按示例对话格式解析）、Top/Bottom of AN、按深度插入（**Depth 0＝prompt 最底部**，可指定 system ⚙️ / user 👤 / assistant 🤖 角色）、Outlet |
| Probability | 被激活后**不插入**的概率过滤。100＝每次都插，50＝一半，0＝等于禁用 |
| Inclusion Group | 同名组内同时命中只插一条；默认按 groupWeight（默认 100）随机选；一条可属于多个组（逗号分隔） |
| Prioritize Inclusion | 组内不随机，取 Order 最大者（做 fallback 序列用） |
| Use Group Scoring | 组内以「命中键数」先淘汰，再按权重/优先选。主键 1 命中＝1 分；AND ANY 每条次级键 1 分；AND ALL 全中时每条 1 分；NOT ANY/NOT ALL 不加分 |
| Automation ID | 与 Quick Replies 的自动化 ID 相同时，条目激活即自动执行该命令（同一 ID 多条只跑一次） |
| Character Filter | 只有名单内角色（或带指定标签的角色）能激活；可切 Exclude 反转 |
| Triggers | 只在指定生成类型下激活：Normal / Continue / Impersonate / Swipe / Regenerate / Quiet。群聊没有 Regenerate（群聊重生成走不同逻辑：删掉上一轮全部回复，按群策略重排，按 Normal 生成） |
| Additional matching sources | 匹配源可扩到：角色 Description / Personality / Scenario / Persona Description / Character's Note / Creator's Notes（后两者默认不进 prompt，只作匹配源） |

**Timed Effects（时效，按消息条数计，非轮数）**

- 规则：只作用于被激活的那个会话（分支继承父会话状态）；聊天不前进（最后一条被 swipe/删除）时时效被移除；**改动条目本身会强制移除正在生效的时效**；时效生效期间再次命中关键词**不刷新**时长。
- Sticky＝激活后继续生效 N 条；被 sticky 的条目在后续扫描中**跳过 probability 检查**直到过期。
- Cooldown＝激活后 N 条内不能再激活；**可与 sticky 连用**（sticky 结束后才进入 cooldown）。
- Delay＝聊天消息数**不足 N 条**时不能激活（Delay=1 表示空聊天/无开场白时不能激活）。
- 官方示例：sticky=3, cooldown=2, delay=2 → 第 0 条延迟、第 1 条激活、2~4 sticky、5~6 cooldown、第 7 条起可再次激活。

**全局激活设置**

- Scan Depth：扫描最近多少条消息。**0＝只评估递归条目与 Author's Note**；1＝只看最后一条。条目级可覆盖。
- Include Names：把「说话人名字:」作为扫描前缀（默认开）。
- Context % / Budget：世界书可占用多少 token；**预算用尽后即使命中也不再注入**；常驻条目先插，然后按 Order 从大到小；**直接命中关键词的条目优先于「被其他条目内容带出来」的条目**。
- Min Activations：忽略 Scan Depth，从最新往回扫直到凑够 N 条（仍受 Max Depth / Budget 限制）；额外扫描不看上一轮递归新增的条目。与 Max Recursion Steps 互斥。
- Max Depth：配 Min Activations 用的最大回溯深度。
- Recursive scanning：条目内容里提到别的关键词可以带动别的条目。每条三态：Non-recursable（不被递归激活）/ Prevent further recursion（激活后不再引发别的）/ Delay until recursion（只在递归阶段激活；带 Recursion Level，先处理小层级，无命中才进入下一层）。
- Max Recursion Steps：0＝只受预算限制；1＝等于关闭递归；2＝只能递归一层。
- Case-sensitive keys / Match whole words（是否整词匹配，条目级可覆盖）。**官方明确：整词匹配对不用空格分词的语言（如中文、日文）有害，建议关闭。**
- Alert on overflow：世界书超出预算时弹警告。

**同页还给出**：Vector Storage 语义匹配的规则（只替代关键词这一步，trigger%、角色过滤、分组等仍要满足；不用 Scan Depth，改用 Query messages；🔗 只是标记，条目本身仍是普通条目）。以及 4 条插入来源（Global / Character / Persona / Chat）与合并策略（Sorted Evenly 默认、Character Lore First、Global Lore First），来源顺序固定为 Chat Lore → Persona Lore → Character/Global Lore。

> 对比参考：Chub AI 的 lorebook 说明给出 Scan Depth / Token Budget 两个全局项，并明确默认「大小写不敏感 + 整词匹配」。来源：<https://docs.chub.ai/docs/advanced-setups/lorebooks>
> KoboldCpp 侧宣称支持 world info / memory / author's note 并保存在单个文件里（官方 wiki 首页）：<https://github.com/LostRuins/koboldcpp/wiki>
> JanitorAI 的等价物叫 **Scripts**，最简形态是 Lorebook，条目字段含 Keys / Content / **Probability**，并可指派给指定角色。来源：<https://help.janitorai.com/en/article/how-to-use-scripts-your-beginner-friendly-step-by-step-guide-1bdk5hc/>

### B3 群聊发言顺序模式（natural / list order / manual）

来源：<https://docs.sillytavern.app/usage/core-concepts/groupchats/>

- **Manual**：从菜单或 `/trigger` 指定谁说；用户发消息也**不会**自动触发任何回复；空输入触发随机一个未静音成员。
- **Natural Order**：① 从最后一条消息里抽取被提到的成员名（**只认整词**，「Misaka Mikoto」只认 Misaka / Mikoto；「Allow Self Responses」关闭时，不会响应自己消息里对自己名字的提及）；② 按 **Talkativeness**（0% 害羞＝只有被点名才说，100% 话痨＝必回，默认 50%）决定是否激活；③ 前面都没选中就随机一个。
- **List Order**：严格按成员列表顺序，无其它规则。
- **Pooled Order**：随机选一个「自上次用户消息以来还没说过」的成员；都说过之后随机，直到下一条用户消息。

**同一页还有**：

- 生成处理模式：Swap character cards（默认，只带当前发言人卡）/ Join character cards（把所有成员的定义拼成一份联合 prompt，分「含静音 / 不含静音」两子模式；官方警告容易导致角色自我混淆、人格融合）。拼接字段为 Description、Scenario、Personality、Message examples、Character notes / Depth prompts。
- Join Prefix / Suffix：拼接时的分隔模板。
- Mute Character（静音）/ Force Talk（强制发言，绕过顺序、静音也可被点）/ Auto-mode（按顺序自动连发，上一条发出后 5 秒触发下一轮，用户一打字就关闭，但已排队的生成不会自动取消）/ Allow Self Responses / **Group Chat Scenario Override**（全组共用同一段场景，分支继承父会话的覆盖值）/ Peek Character Definitions / 成员增删与排序。

本 App 现状：只有「轮流（≈List Order）」与「点名（≈Manual + @`）」+ 点顶部名字（≈Force Talk）。缺 Natural Order（含整词识别 + Talkativeness）、Pooled Order、Auto-mode、静音、共享场景覆盖。

### B4 chat lore / persona 注入 / Author's Note 深度

- **Chat Lore（会话级世界书）**：绑定到某个具体会话，只在那个会话生效，不随角色带到别的会话。同级还有 Character Lore（跨该角色所有会话，含群聊；仅「主」世界书会随卡导出）与 Persona Lore（该 persona 被选中时生效，与角色无关）。来源：<https://docs.sillytavern.app/usage/core-concepts/worldinfo/>
- **Persona 注入位置**（Persona Description 的 Position，按 persona 保存）：None / In Story String（Prompt Manager，默认）/ Top of Author's Note / Bottom of Author's Note（仅当 Author's Note 存在）/ **In Chat @ Depth**（可选深度与 role）。另有 persona 锁定三类：锁会话、锁角色（可多锁）、默认 persona；以及临时 persona 概念。来源：<https://docs.sillytavern.app/usage/core-concepts/personas/>
- **Author's Note 深度与频率**（来源：<https://docs.sillytavern.app/usage/core-concepts/authors-note/>）：
  - Placement：**After Scenario**（放在角色定义之后、示例消息之前）或 **In-chat + Depth**。
  - **Depth 0 ＝ 放在聊天记录最末尾；Depth 4 ＝ 放在最近 3 条消息之前，成为聊天记录里的第 4 个实体。越靠底部，对下一次回复影响越大。**
  - **Insertion Frequency**：0＝永不插入；1＝每次用户输入都插入；4＝每第 4 次用户输入插入一次。
  - 会话级 AN 的内容**不会**自动带到新会话；面板底部另有一个「默认 AN」用于新会话。
  - 官方点名的用法：提醒回复格式、强化指令、当作临时世界书 / 角色偏向（character bias）、给非 instruct 模型当 instruct 用。

---

## C. 重点展开二：设置项

### C1 tokenizer / 上下文预算显示

- ST 的 Token Counter 是**内置扩展**（官方扩展页列出），负责「把文本转成 token 并计数」。来源：<https://docs.sillytavern.app/extensions/>
- 更实用的两个位置：① **提示词条目化（Prompt Itemization）**——在 AI 回复上点一下，能看到该次生成的完整 prompt 与 token 占用；② 消息级 Prompt 动作可以看到该条生成的 prompt 与 token 用量。来源：<https://docs.sillytavern.app/usage/prompts/> 与 <https://docs.sillytavern.app/usage/chatting/>
- 世界书侧另有 Context % / Budget 与 Alert on overflow（见 B2）。
- LM Studio 侧是「每个模型可设默认上下文长度与 GPU offload」的 per-model defaults：<https://lmstudio.ai/docs/app/advanced/per-model>
- 本 App 已有 `estimateTokens` ＋ 48000 的 contextBudget ＋ fitHistoryByBudget（字符估算），缺的是**按真实模型分词**与**「这次到底发了什么、各段各占多少」的可视化**。

### C2 Prompt Manager 条目开关（可直接照搬的最小骨架）

1. 一个拖拽列表，越靠上越早发出，最下面是最后发出的内容（通常是 Post-History Instructions）。
2. 每条可 **ON/OFF 关闭但不删除**；默认段不可删除。
3. 每条有：Name（仅内部用）、Role（System / AI Assistant / User）、Triggers（Normal / Continue / Impersonate / Swipe / Regenerate / Quiet，可多选；不选＝全部）、Position（Relative 跟随列表 / In-Chat 走 Depth）、Depth、Order。
4. 另有 Utility Prompts：格式模板（World Info / Scenario / Personality 的包装模板）、Group Nudge、New Chat / New Group Chat / New Example Chat、Continue Nudge、Replace Empty Message。
5. 依赖 preset 的保存语义：改完 prompt 要**先存条目再存预设**，否则切换预设即丢失。

来源：<https://docs.sillytavern.app/usage/prompts/prompt-manager/>

### C3 Quick Replies（快捷回复）

- 官方在 STscript 语言参考里把 Quick Replies 描述为「内置的 SillyTavern 扩展」：<https://docs.sillytavern.app/usage/st-script/>
- 与提示词系统的接口：Prompt Manager 里有 Quick Prompts Edit（Main Prompt / Auxiliary Prompt / Post-History Instructions 的快速编辑区）。
- 与世界书的接口：**Automation ID**——世界书条目激活时自动执行同 ID 的快捷回复命令（见 B2）。
- 旧的独立扩展文档路径（extensions/quick-replies/）当前返回 page_not_found，故此处只写能在 STscript 页与 Prompt Manager 页确认的部分。

### C4 正则脚本的「作用位置」（Affects）—— 官方逐项定义

来源：<https://docs.sillytavern.app/extensions/regex/>

- **User Input**：用户按下发送后，作用于用户输入内容。
- **AI Response**：收到 AI 回复后，作用于回复内容。
- **Slash Commands**：作用于斜杠命令插入到 prompt / 聊天里的值。
- **World Info**：作用于世界书条目被注入 prompt 时的内容（需勾选 Alter Outgoing Prompt，或两个 ephemerality 都取消勾选）。
- **Reasoning**：作用于 Chat Completion API（Gemini、DeepSeek 等）返回的 reasoning 对象内容；勾了 Alter Outgoing Prompt 时也会作用于后续轮次被塞回 prompt 的 reasoning 块。
- 全部不勾：正常聊天时永不触发，但仍可被斜杠命令 / STscript 触发。
- 其它：Disabled（覆盖开关，但仍可被命令触发）、**Run on Edit**（编辑消息后是否重跑）、Macros in Find Regex（Don't Substitute / Raw / Escaped）、**Min/Max Depth**（0＝最后一条；blank 或 -1＝也会作用于 Continue 的目标；系统与工具提示词不受影响）、Flags（i/g/s/m/u）、**Ephemerality**（默认直接改写聊天 JSONL，不可逆；可分别只改「显示」或只改「发出去的 prompt」，两者都勾＝都不写盘）。
- 作用域：Global 脚本存进 settings.json；Scoped 只作用于当前角色并存进角色卡数据；支持导出/导入 JSON 与全局↔角色互转、拖拽排序。

### C5 swipe / 重新生成 / 编辑重发的语义

来源：<https://docs.sillytavern.app/usage/chatting/>

- Swipe＝生成另一条不同回复（保留历史候选，可左右翻）；右方向键＝swipe，上方向键＝编辑最后一条消息。
- 官方点名的组合用法：**「如果你想换句话说的话，先编辑你的消息，然后 swipe AI 的回复拿到新的回答」**——即编辑用户消息后 swipe，是在「保持该用户输入」的前提下重采样。
- Regenerate＝重新生成（单聊与群聊语义不同：群聊会删掉上一轮全部回复，按群策略重排并全部以 Normal 类型生成）。
- Continue＝延长最后一条消息；Impersonate＝让 AI 以用户身份写一条。
- 消息动作面板还包含：Translate / Generate Image / Narrate（TTS）/ **Prompt（查看该次 prompt 与 token 用量）**；Message Visibility（Included / Excluded）；Embed 附件；Checkpoint / Branch / Copy / Edit。
- 编辑面板内还有：Copy / Delete / **Move Up / Move Down**。
- Token 概率面板（Rerolling）：点任意 token 看候选与其概率，替换某 token 后从那里重新生成，前面部分保留为灰色（不重新生成、无概率信息）。

本 App 现状：有「重新生成（仅最后一条）」「从这里重聊」「编辑重发」；缺 swipe 多候选、Continue、Impersonate、Excluded、Move、Checkpoint 切换与 Back to parent。

### C6 消息删除与分支

- ST 的 **Checkpoints** 是「当前聊天的克隆」：复制到某条消息为止，并存一条指向源（按聊天文件名）的链接。两点入口：**Create Branch**（克隆到该条并切换过去）与 **Create Checkpoint**（克隆并命名，但**不**切换），官方用「新标签页打开 / 后台标签页打开」类比；回父会话用输入框左侧菜单的 **Back to parent chat**。附带风险：**重命名聊天文件会让 checkpoints 的链接失效**。来源：<https://docs.sillytavern.app/usage/core-concepts/chatfilemanagement/>
- 批量删除在「聊天选项面板 → Delete messages」（多选删除）；Convert to group 也在这里。
- 导出：`.jsonl`（含元数据，可回导）与 `.txt`（纯文本，**不能**再导回）。导入来源官方列出 TavernAI、text-generation-webui、Agnai、KoboldAI Lite、RisuAI，以及 Character.AI（需第三方 CAI Tools 浏览器扩展）。

### C7 世界书条目的 UI 编辑字段（可直接当表单设计稿）

按条目分组，建议 UI 分四个折叠区：

1. **基本**：Entry Title / Memo（不进 prompt）、Entry Content（真正注入的文本）、启用开关。
2. **触发**：Keys（纯文本逗号分隔 / fancy 分块两种输入模式）、Optional Filter + Selective Logic（AND ANY / AND ALL / NOT ANY / NOT ALL）、Case-sensitive、Match whole words、Additional matching sources（角色 Description / Personality / Scenario / Persona Description / Character's Note / Creator's Notes）。
3. **注入**：Strategy（🔵 Constant / 🟢 Normal / 🔗 Vectorized）、Insertion Order、Insertion Position（含按深度插入与 ⚙️/👤/🤖 role）、Outlet Name、Probability、Inclusion Group、Prioritize Inclusion、Use Group Scoring、Automation ID、Character Filter（含 Exclude）。
4. **高级 / 节奏**：Triggers（Normal / Continue / Impersonate / Swipe / Regenerate / Quiet）、递归三态（Non-recursable / Prevent further recursion / Delay until recursion + Recursion Level）、Timed Effects（Sticky / Cooldown / Delay，单位＝消息条数）、条目级覆盖（Scan Depth / Case-sensitive / Match whole words）。

来源同 B2。

---

## D. 按「价值 / 成本比」排的前 20 条

判定口径：价值看「对中文陪伴向聊天的直接体感」，成本看「纯前端 WebView、无自建后端」下的实现难度。**「不做会显得残废」＝同类软件里属于事实标准、且用户会立刻发现缺失的东西。**

### D1 全部低成本、高价值（可直接排进最近两个版本）

| 排名 | 功能（条目号） | 价值 | 难度 | 为什么这么排 |
|---|---|---|---|---|
| 1 | 世界书整词匹配按语言自动关闭（#25） | 高 | 低 | 官方已点明中日文开整词匹配会严重误伤；**这是**导入 ST 世界书后「条目全部不触发」的头号嫌疑，属于**不做会显得残废**的缺陷级修复 |
| 2 | 世界书条目 UI 字段补齐（#11 开关、#12 Order、#13 Position/Depth、#14 Selective Logic、#17 Probability、#23 Scan Depth、#18 Sticky/Cooldown/Delay） | 高 | 低~中 | 一张表单解决 7 条；导入通道已通，缺的是「导进来之后能不能改」。**不做会显得残废**（导入的世界书变成只读黑盒） |
| 3 | 世界书 Token 预算 + 溢出提示（#22） | 高 | 中 | 没有预算就等于「世界书一多，对话被挤出窗口」，且现象是「她突然变傻」，用户无法归因。**不做会显得残废** |
| 4 | 消息「是否发给 AI」开关（#32） | 高 | 低 | 一个布尔位，解决「留档但不发送」，调试与创作都用。**不做会显得残废**（ST 用户第一周就会发现没有） |
| 5 | 继续（Continue，接续被截断的回复）（#37） | 高 | 低 | 输出被 max_tokens 砍断是日常；现在只能整条重生成。**不做会显得残废** |
| 6 | 快捷回复面板（#62） | 高 | 低 | 每天重复输入的固定短语（(继续) / 换个说法 / 场景切换）一张面板即可；还天然接 Automation ID |
| 7 | 固定记忆 Pin（#56） | 高 | 低 | C.AI 官方就给了 5 条/会话；让用户显式钉住「必须记住的事」，比自动摘要可控得多 |
| 8 | 角色「深度提示词」槽 + 深度可调（#6） | 高 | 低 | 行为约束放对话近处，顺从度提升立竿见影，且不动人设 |
| 9 | 场景 Scenario 独立注入 + 会话级覆盖（#10、#41） | 高 | 低 | 角色扮演的最小上下文单位；现在被压在人设里，改一次场景就要动人设 |
| 10 | 多条备选开场白 + 开局随机（#1） | 高 | 低 | 直接治「每次开局都一样」的重复疲劳；ST 卡里现成的数组白白丢掉可惜 |
| 11 | 群聊成员静音 + 强制发言 + 发言积极性（#43、#44、#46） | 高 | 低 | 群聊的三个最基本操控；现在只能靠点名字硬掰 |
| 12 | 世界书条目级角色绑定 / persona 绑定 / 会话绑定（#27） | 高 | 低 | 省掉手工开关世界书；群聊里「只对某人生效」的设定是刚需 |
| 13 | 编辑用户消息后 swipe 的语义对齐 + swipe 多候选（C5） | 高 | 中 | 现只有「编辑重发」；把「编辑→重采样」这条路走通，是重 roll 体验的核心 |
| 14 | 检查点 / 分支（#31） | 高 | 中 | 敢试另一条线的前提；也能当「备份」心理安全垫（App 自身有 IndexedDB 被回收的真实风险） |
| 15 | 自然顺序发言（整词识别 + Talkativeness）（#47） | 高 | 中 | 群聊从「排队发言」变「像真人插话」，是群聊体感的代差 |

### D2 高价值但成本更高（值得立项，分批做）

| 排名 | 功能（条目号） | 价值 | 难度 | 为什么这么排 |
|---|---|---|---|---|
| 16 | 提示词条目开关 + 拖拽排序 + Role/Position/Depth（#64、#65）+ 只读的提示词检查器（#63） | 高 | 中 | 「导入了 ST 预设却只能看」的正面解法，也是调试一切问题的地基。建议先做只读的「这次发了什么」，再做编辑 |
| 17 | 酒馆预设「一键收进来」（#60） | 高 | 中 | 迁移体验的关键一步；现流程要逐段手工处理，等于把成本转嫁给用户 |
| 18 | 向量化世界书条目 / 语义触发（#21） | 高 | 高 | 治「换个说法就不触发」；纯前端可行（IndexedDB + 嵌入 API）但重 |
| 19 | 聊天向量化回溯（#51） | 高 | 高 | 「她记得」的最高形态；可与 #21 共用一个向量基建 |
| 20 | 提示词检查器完整体 + tokenizer 选择（#63、#67） | 高 | 中 | 中文按字符估算误差大；能看到「每段占多少 token」才能自己把预算调对 |

### D3 「不做会显得残废」清单（照抄即可排期）

1. **#25** 中文默认关闭「整词匹配」（含 UI 暴露该开关）
2. **#11 / #12 / #13 / #14 / #17 / #23 / #18** 世界书条目的开关 / 顺序 / 位置深度 / 二段逻辑 / 概率 / 扫描深度 / 时效三件套
3. **#22** 世界书 token 预算 + 超限提示
4. **#32** 消息级「是否发送给 AI」
5. **#37** 继续（Continue）
6. **#56** 固定记忆
7. **#31** 分支 / 检查点（至少做到「从这里分叉并保留原线」）
8. **#62** 快捷回复
9. **#1** 备选开场白
10. **#10** 场景字段独立化
11. **#27** 世界书三级绑定（角色 / persona / 会话）
12. **#6** 角色深度提示词
13. **#47 / #43 / #44** 群聊自然顺序 / 静音 / 强制发言

> 一句话总结：**导入管道已经比多数同类 App 都宽（ST 世界书 / 卡 / jsonl / 正则 / 预设都能吃），但「吃进来之后可不可改、能不能看见自己发了什么」这一层几乎空白。前 20 条里有 13 条都在补这一层，投入产出比最高。**

---

## E. 未核实项（明确标注，避免被当成事实使用）

- Character.AI 的「故事分支」具体交互细节：官方有群聊功能公告（<https://blog.character.ai/new-feature-announcement-character-group-chat/>），但分支能力的具体形态本轮未取得一手说明。
- Talkie 的长期记忆、语音、角色导入格式：仅有一手站点/商店页（<https://www.talkie-ai.com/>、<https://play.google.com/store/apps/details?id=com.weaver.app.prod>），未找到官方帮助文档，**细节未核实**。
- 星野的「世界书 / 记忆 / 声音模型 / 视觉模型」表述来自 App Store 官方文案（<https://apps.apple.com/cn/app/id6463076337>），未找到对应的可操作文档，**具体机制未核实**。
- ChatterUI 的世界书 / 正则 / 快捷回复支持情况：官方 README（<https://github.com/Vali-98/ChatterUI>）只列到「角色卡 v2、多会话、采样与 Instruct 格式、系统 TTS、端上 GGUF」，其余**未核实**。
- Chatbox 的知识库、WebDAV 同步等：本轮未取得官方一手页面，**未核实**。
- LM Studio 的「结构化输出 / RAG 文档上传」具体入口：本轮只核实到 per-model 默认参数与 Config Presets 两页，其余**未核实**。
- RisuAI 的 lorebook 触发模式确切枚举名、charx 内部结构（情绪 / 脚本 / 世界书块）：仅核实到官方 README 的功能列表与 CCv3 规范对 CHARX 的定义，**枚举名未核实**。
- KoboldCpp 的 World Info 字段级细节：wiki 单页抓取返回的是首页内容（wiki 为单页聚合），**字段级细节未核实**，仅确认其宣称支持 world info / memory / author's note。
- 本 App 侧的缺口判定基于 README 与 `www/js/app.js` 的局部阅读，**未逐行审计世界书与消息菜单实现**；若某项实际已实现，请以代码为准并作废对应条目。

---

## F. 一手来源汇总

- SillyTavern · World Info：<https://docs.sillytavern.app/usage/core-concepts/worldinfo/>
- SillyTavern · Group Chats：<https://docs.sillytavern.app/usage/core-concepts/groupchats/>
- SillyTavern · Author's Note：<https://docs.sillytavern.app/usage/core-concepts/authors-note/>
- SillyTavern · Personas：<https://docs.sillytavern.app/usage/core-concepts/personas/>
- SillyTavern · Prompts（总览与 Prompt Itemization）：<https://docs.sillytavern.app/usage/prompts/>
- SillyTavern · Prompt Manager：<https://docs.sillytavern.app/usage/prompts/prompt-manager/>
- SillyTavern · Context Template（Story String 占位符）：<https://docs.sillytavern.app/usage/prompts/context-template/>
- SillyTavern · Advanced Formatting：<https://docs.sillytavern.app/usage/core-concepts/advancedformatting/>
- SillyTavern · Regex 扩展：<https://docs.sillytavern.app/extensions/regex/>
- SillyTavern · STscript（含 Quick Replies 说明）：<https://docs.sillytavern.app/usage/st-script/>
- SillyTavern · 扩展总览（Token Counter / Summarize / Vector Storage 等内置）：<https://docs.sillytavern.app/extensions/>
- SillyTavern · Data Bank (RAG)：<https://docs.sillytavern.app/usage/core-concepts/data-bank/>
- SillyTavern · Chat Vectorization：<https://docs.sillytavern.app/extensions/chat-vectorization/>
- SillyTavern · Chatting（swipe / edit / message actions / token probabilities）：<https://docs.sillytavern.app/usage/chatting/>
- SillyTavern · Chat File Management（checkpoints / 导入来源 / 导出）：<https://docs.sillytavern.app/usage/core-concepts/chatfilemanagement/>
- Character Card V3 规范（含 CHARX 与 PNG ccv3 chunk）：<https://github.com/kwaroran/character-card-spec-v3/blob/main/SPEC_V3.md>
- Chub AI · Lorebooks：<https://docs.chub.ai/docs/advanced-setups/lorebooks>
- RisuAI · README（功能列表）：<https://github.com/kwaroran/RisuAI>
- Agnai · README（功能列表、Memory/Lore books、Pipeline 长时记忆与 PDF 嵌入）：<https://github.com/agnaistic/agnai>
- ChatterUI · README（移动端、角色卡 v2、系统 TTS、端上 GGUF）：<https://github.com/Vali-98/ChatterUI>
- KoboldCpp · Wiki 首页（world info / memory / author's note）：<https://github.com/LostRuins/koboldcpp/wiki>
- LM Studio · Per-model Defaults：<https://lmstudio.ai/docs/app/advanced/per-model>
- LM Studio · Config Presets：<https://lmstudio.ai/docs/app/presets>
- JanitorAI · Scripts（Lorebook 入门指南，含 Probability）：<https://help.janitorai.com/en/article/how-to-use-scripts-your-beginner-friendly-step-by-step-guide-1bdk5hc/>
- JanitorAI · Scripts 分类页：<https://help.janitorai.com/en/category/scripts-1qzakwc/>
- Character.AI · Pinned Memories（每会话 5 条）：<https://support.character.ai/hc/en-us/articles/24327914463003-Pinned-Memories>
- Character.AI · User Personas：<https://book.character.ai/character-guide/user-personas>
- Character.AI · Creator Guide（Name/Avatar/Voice/Greeting/Tags/Tagline/Description/Definition 各字段作用）：<https://support.character.ai/hc/en-us/articles/50608794517915-1-Welcome-to-the-Creator-Guide>
- Character.AI · Character Group Chat 公告：<https://blog.character.ai/new-feature-announcement-character-group-chat/>
- 星野 · App Store 官方页（形象/声音/人设/技能、记忆与声音模型表述）：<https://apps.apple.com/cn/app/id6463076337>
- Talkie · 官方站点：<https://www.talkie-ai.com/>

---

*本文件由调研任务生成，未修改仓库内其它任何文件。*
