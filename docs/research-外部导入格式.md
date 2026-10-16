# 外部文件导入兼容调研（角色卡 / 世界书 / 预设 / 聊天 / 正则 / 同类软件）

- 调研日期：**2026-10-14**（所有 URL 均在此日抓取；SillyTavern 取 `release` 分支，RisuAI / Agnai 取 `main` 分支）
- 目标读者：纯前端 Capacitor/WebView 中文 AI 陪伴聊天 App 的导入功能设计与实现
- 证据分级：
  - **【一手-规范】**：CCv2 / CCv3 规范原文
  - **【一手-源码】**：SillyTavern、RisuAI、Agnai、KoboldAI 源码中的类型定义 / 解析代码
  - **【二手】**：博客、转换器站点、社区帖子
  - **【未核实】**：没有找到一手证据，属于推断，**不可当事实使用**

> 阅读提示：本报告里 `data.extensions` 这种写法就是 JSON 字段路径。所有字段表后面都跟了 URL。

---

## 1. 角色卡 V2（spec_v2.md）

来源（一手-规范）：<https://github.com/malfoyslastname/character-card-spec-v2/blob/main/spec_v2.md>
V1 对照（一手-规范）：<https://github.com/malfoyslastname/character-card-spec-v2/blob/main/spec_v1.md>

### 1.1 顶层结构

```ts
type TavernCardV2 = {
  spec: 'chara_card_v2'          // MUST 为这个值
  spec_version: '2.0'            // MUST
  data: { ...见下表... }
}
```

V1 卡（TavernAI/Pygmalion 时代，字段在顶层）与 V2 卡（字段嵌在 `data`）在生态里长期共存，所以导入器必须先判断 `spec`，判断不到再按 V1 处理。

### 1.2 `data` 完整字段表

| 字段 | 类型 | 规范要求 / 语义 | 导入建议 |
|---|---|---|---|
| `name` | string | V1 字段，角色名 | 必读 |
| `description` | string | V1 字段，角色描述 | 必读，默认进 prompt |
| `personality` | string | V1 字段，性格摘要 | 必读 |
| `scenario` | string | V1 字段，场景 | 必读 |
| `first_mes` | string | V1 字段，开场白 | 必读，作为首条消息 |
| `mes_example` | string | V1 字段，示例对话（`<START>` 分段） | 可裁剪 |
| `creator_notes` | string | V2 新增。**MUST NOT** 进入 prompt；**SHOULD** 对用户可见（至少显示一段） | 存展示字段 |
| `system_prompt` | string | V2 新增。前端**默认行为 MUST** 用它替换「系统提示词」；支持 `{{original}}` 占位符（替换为用户原本的系统提示词）。空串则回退用户设置 | 建议支持 |
| `post_history_instructions` | string | V2 新增。默认**MUST** 替换 UJB/jailbreak 设置；同样支持 `{{original}}` | 建议支持 |
| `alternate_greetings` | string[] | V2 新增。前端**MUST** 为开场白提供 swipe，每项是一个 swipe | 必读，做多开场白 |
| `character_book` | CharacterBook? | V2 新增，角色专属世界书。前端**MUST** 默认启用；**SHOULD** 与用户世界书叠加，且**角色书 SHOULD 完全优先** | 必读，见 `1.4 |
| `tags` | string[] | V2 新增。无取值限制；**SHOULD NOT** 进 prompt；可用于排序筛选（**SHOULD** 大小写不敏感） | 存标签 |
| `creator` | string | V2 新增。**MUST NOT** 进 prompt，**MAY** 展示 | 存展示字段 |
| `character_version` | string | V2 新增。**MUST NOT** 进 prompt，**MAY** 展示/排序 | 存展示字段 |
| `extensions` | Record | V2 新增。**MUST** 默认为 `{}`；可放任意键值；编辑器导入导出时 **MUST NOT** 销毁未知键；键名 **SHOULD** 加命名空间（如 `agnai/voice`、`agnai: { voice: ... }`） | **原样保留**，见 `1.3 |

### 1.3 `data.extensions` 实际约定（生态事实）

规范只规定 `extensions` 是自由容器，但生态里已经形成事实标准：

| 键 | 内容 | 来源（一手-源码） |
|---|---|---|
| `extensions.talkativeness` | number，ST 的「话痨度」，默认 0.5 | ST `public/scripts/char-data.js`（`v2CharDataExtensionInfos`）；导出逻辑 `src/endpoints/characters.js` |
| `extensions.fav` | boolean，收藏 | 同上 |
| `extensions.world` | string，绑定的世界书文件名 | 同上 |
| `extensions.depth_prompt` | `{depth: number, prompt: string, role: 'system'\|'user'\|'assistant'}`，ST 的「@ Depth 角色提示」（默认 depth 4、role `system`） | <https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/char-data.js>、<https://github.com/SillyTavern/SillyTavern/blob/release/src/endpoints/characters.js>（`_.set(char, 'data.extensions.depth_prompt.prompt'...)`） |
| `extensions.regex_scripts` | `RegexScriptData[]`，角色内嵌正则脚本 | <https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/char-data.js> |
| `extensions.pygmalion_id` / `github_repo` / `source_url` / `chub: {full_path}` / `risuai: {source}` / `sd_character_prompt: {positive, negative}` | 各平台的「非标准但常见」扩展，ST 明确列为外部工具写入 | 同上（`v2CharDataExtensionInfos` 注释「Non-standard extensions added by external tools」） |

> 注意：`extensions.depth_prompt` 不在 CCv2/CCv3 规范文本里，是 ST 自建的扩展键（CCv3 规范全文检索不到 `depth_prompt`）。CCv3 里对应的机制是世界书 decorator `@@depth` / `@@role` 和 `assets`。

### 1.4 `character_book`（CCv2 版世界书）

```ts
type CharacterBook = {
  name?: string
  description?: string
  scan_depth?: number        // agnai: "Memory: Chat History Depth"
  token_budget?: number      // agnai: "Memory: Context Limit"
  recursive_scanning?: boolean
  extensions: Record
  entries: Array<{
    keys: string[]
    content: string
    extensions: Record
    enabled: boolean
    insertion_order: number          // 越小越靠前
    case_sensitive?: boolean
    name?: string                    // 不用于 prompt
    priority?: number                // 超预算时优先丢弃数值小的
    id?: number
    comment?: string
    selective?: boolean              // 需要 keys 与 secondary_keys 同时命中
    secondary_keys?: string[]
    constant?: boolean               // 无视 keys 常驻
    position?: 'before_char' | 'after_char'
  }>
}
```

规范要点：前端**MUST** 默认使用角色书；编辑器**MUST** 按此格式保存；角色书 **SHOULD** 与用户世界书叠加且角色书优先。
ST 侧的同名字段类型定义见 <https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/char-data.js>（`v2DataWorldInfoEntry` / `v2DataWorldInfoEntryExtensionInfos`）。

### 1.5 ST 实际写出的 V2 卡（导入时要能读）

ST 用 `charaFormatData()` 组装卡片：先取原卡 JSON（`json_data`）保留未知字段，再逐字段覆盖，然后补 ST 扩展：`data.extensions.talkativeness/fav/world`、`data.extensions.depth_prompt.{prompt,depth,role}`、`data.character_book`（由绑定的世界书转换，见 `3.5）。
源：<https://github.com/SillyTavern/SillyTavern/blob/release/src/endpoints/characters.js>
导入 V2 时 ST 还会把 `fav` 重置、删除 `chat`（`unsetPrivateFields`），并给 `extensions.talkativeness/fav` 缺失时补默认值（`readFromV2`）。

### 1.6 兜底建议（实现层）

1. 先判 `spec === 'chara_card_v3'` → 走 V3；`spec === 'chara_card_v2'` → 走 V2；否则若顶层有 `name` 且无 `data` → V1；若顶层有 `char_name` → Pygmalion/gradio 老格式（见 `7.5）。
2. 任何情况下都要把**原始 JSON 整份留档**（ST 的做法就是保留 `json_data` 再回写），否则 `extensions` 里的第三方数据会丢。


---

## 2. 角色卡 V3（SPEC_V3.md）

来源（一手-规范）：<https://github.com/kwaroran/character-card-spec-v3/blob/main/SPEC_V3.md>
ST 实现（一手-源码）：<https://github.com/SillyTavern/SillyTavern/blob/release/src/character-card-parser.js>、<https://github.com/SillyTavern/SillyTavern/blob/release/src/charx.js>

### 2.1 顶层与新增字段

```ts
interface CharacterCardV3 {
  spec: 'chara_card_v3'
  spec_version: '3.0'
  data: {
    // 继承 CCv2 全部字段
    name, description, tags, creator, character_version, mes_example,
    extensions, system_prompt, post_history_instructions, first_mes,
    alternate_greetings, personality, scenario,
    creator_notes: string            // 语义微调，见下
    character_book?: Lorebook        // 换成 V3 Lorebook 类型
    // CCv3 新增
    assets?: Array<{ type: string, uri: string, name: string, ext: string }>
    nickname?: string
    creator_notes_multilingual?: Record<string, string>
    source?: string[]
    group_only_greetings: string[]   // MUST 存在（可为空数组）
    creation_date?: number           // unix 秒（UTC），可为 0 表示未知
    modification_date?: number       // unix 秒（UTC），导出时 SHOULD 更新
  }
}
```

字段语义（规范原文要点）：

| 字段 | 规范要求 | 实现建议 |
|---|---|---|
| `spec` | **MUST** 为 `chara_card_v3`；不等于该值时 **SHOULD NOT** 认为它符合 V3 | 首判定 |
| `spec_version` | **MUST** 为 `3.0`；但 **SHOULD NOT** 因取值不同而拒绝导入；按 **float 解析**判断新旧（>3.0 视为更新版本，应提示用户但 **SHOULD** 仍允许导入，缺失字段填默认值） | 宽松解析 |
| `creator_notes` | **MUST** 为 string。若 `creator_notes_multilingual` 不存在，它就是创作者备注；若存在但缺 `en` 键，则它充任 `en`；否则**忽略该字段** | 多语言时别重复显示 |
| `creator_notes_multilingual` | **MUST** 为对象或 undefined；键 **MUST** 是 ISO 639-1 语言码（**不带地区码**），值 **MUST** 是 string；**SHOULD** 按客户端语言显示，**MAY** 提供语言选择 | 中文卡常有 `zh` |
| `nickname` | string 或 undefined。存在时，`{{char}}`（以及等价写法）**SHOULD** 用它替换，而非 `name` | 显示名与调用名分离 |
| `source` | string[] 或 undefined。是来源 ID 或 HTTP(S) URL；**SHOULD NOT** 允许用户编辑；应用 **SHOULD** 只追加、不删改非自己写入的元素 | 保留原样 |
| `group_only_greetings` | string[]，**MUST 存在**（可空）。**SHOULD** 视为「仅群聊可用的额外开场白」 | 单人聊里可忽略但要保存 |
| `creation_date` / `modification_date` | number 或 undefined；**MUST** 为 unix 秒（UTC）；用户 **SHOULD NOT** 能编辑；`0` 表示未知 | 导出时刷新 modification_date |
| `assets` | 数组或 undefined。未定义时 **MUST** 等价于 `[{type:'icon', uri:'ccdefault:', name:'main', ext:'png'}]`。URI 可为 HTTP(S) / base64 data URL / `embeded://path` / `ccdefault:`。`type='icon'` 且 `name='main'` 时应用 **MUST** 用作主头像；多个 icon 时 **MUST** 恰有一个 `main`。`ext` **MUST** 是小写扩展名（不含点），未知可用 `unknown`；应用 **SHOULD** 至少支持 png/jpeg/webp。应用自造 type **SHOULD** 以 `x_` 开头 | 只做 icon 也能跑；其余资产原样保留 |

### 2.2 `character_book` 在 V3 的差异（Lorebook 类型）

```ts
type Lorebook = {
  name?, description?, scan_depth?, token_budget?, recursive_scanning?,
  extensions: Record,
  entries: Array<{
    keys: string[]
    content: string
    extensions: Record
    enabled: boolean
    insertion_order: number
    case_sensitive?: boolean
    use_regex: boolean            // V3 新增，且「V3 上是必实现」；true 时 keys 按正则匹配，非法正则 MUST 视为不命中
    constant?: boolean            // V2 可选 → V3 要求必须实现
    name?, priority?, id?: number|string, comment?, selective?, secondary_keys?,
    position?: 'before_char' | 'after_char'
  }>
}
```

与 CCv2 `character_book` 的差异汇总：

1. `use_regex` 从「无」变成**必须实现**的布尔字段（V2 里 ST 是把 `use_regex` 塞在 `extensions` 里的）。
2. `constant` 从可选变成必须实现。
3. `id` 类型放宽为 `number|string`（V2 是 number）。
4. 新增 **decorators**：写在 `content` 里、以 `@@` 开头到行尾的指令，包括 `@@activate_only_after`、`@@activate_only_every`、`@@keep_activate_after_match`、`@@dont_activate_after_match`、`@@depth`、`@@instruct_depth`、`@@reverse_depth`、`@@reverse_instruct_depth`、`@@role`、`@@scan_depth`、`@@instruct_scan_depth`、`@@is_greeting`、`@@position`（值：`after_desc`/`before_desc`/`personality`/`scenario`）、`@@ignore_on_max_context`、`@@additional_keys`、`@@exclude_keys`、`@@is_user_icon`、`@@dont_activate`、`@@activate`、`@@disable_ui_prompt`。用三个 `@` 可写 fallback（`@@@…`），规范建议至少支持 5 层链。**回填成 V2 时 SHOULD 删除所有 decorator。**
5. 独立世界书导出格式：`{ spec: 'lorebook_v3', data: Lorebook }`。
6. 未知字段**SHOULD** 忽略而不是拒绝导入、**MAY** 保存以便原样导出（应用自造数据只能放 `extensions`）。

### 2.3 PNG / APNG 里的 `ccv3` 与 `chara`

规范原文（一手-规范）：

- V3 对象 **MUST** 以 tEXt chunk 嵌入，chunk 名 **MUST** 为 `ccv3`，值 **MUST** 是 V3 对象 JSON 经 **utf-8 → base64** 的结果。
- 应用 **MAY** 从 `chara` chunk **回填**一个 V2 对象；回填时 **SHOULD** 在 `creator_notes` 里加警告文案（示例：`This character card is Character Card V3, but it is loaded as a Character Card V2. …`），除非这份文件本来就只为 V2 导出；**回填出来的 `chara` chunk 在导入时 SHOULD 被裁剪（trim）**。
- **同时存在 `chara` 与 `ccv3` 时应优先用 `ccv3`。**
- PNG/APNG **MAY** 用额外 tEXt chunk 承载资产，chunk 名 **MUST** 为 `chara-ext-asset_:{path}`，值 **MUST** 是 base64 二进制，可用 `__asset:{path}` URI 访问；但规范说新应用 **SHOULD 避免**这种用法，**SHOULD** 改用 CHARX。
- 纯 JSON 文件 **MUST** 是 V3 对象本身。

> **关于「ccv3 必须同时写一份 V2 投影到 chara」**：规范原文说的是「应用 **MAY** 回填 `chara`，回填物导入时 SHOULD 被 trim」，**并没有**「必须写 V2 投影」的强制条款；这是生态兼容实践（老客户端只读 `chara`）。**未核实**：是否存在某个规范修订把 MAY 改成 MUST——截至 2026-10-14 抓取的主分支原文是 MAY。

ST 的实际实现（一手-源码，值得照抄的兼容策略）：

- 写：先清掉已有的 `chara`/`ccv3` tEXt chunk，写入 `chara` = 当前卡片 JSON 的 base64(utf-8)；再尝试把同一对象**改标** `spec='chara_card_v3'`、`spec_version='3.0'` 后写入 `ccv3`。（注意：ST 的 `ccv3` 只是把 V2 数据改了标，并没有真正补齐 `assets`/`group_only_greetings` 等 V3 字段。）
- 读：先找 `ccv3`，命中就用它；否则退到 `chara`；两者都无则报错「PNG metadata does not contain any character data」。
- 源：<https://github.com/SillyTavern/SillyTavern/blob/release/src/character-card-parser.js>

**APNG 说明**：规范把 PNG/APNG 并列处理（同一套 tEXt 规则）。解析时按 chunk 遍历即可，不需要理解动画帧。**未核实**：是否有平台把卡片塞进 APNG 的 `acTL`/`fcTL` 之外的私有 chunk。

### 2.4 CHARX（zip 容器）

规范原文要点（一手-规范）：

- CHARX 就是 zip，**MUST** 在 zip 根目录有 `card.json`（内容为 V3 对象），扩展名 `.charx`。
- 内嵌资产用 `embeded://path/to/asset.png` URI 访问——**注意规范明确写的是少一个 d 的 `embeded://`（不是 `embedded://`）**，路径大小写敏感、以 `/` 分隔。
- 目录约定（**SHOULD**）：图片 `assets/{type}/images/`、音频 `assets/{type}/audio/`、视频 `assets/{type}/video/`、Live2D `assets/{type}/l2d/`、3D `assets/{type}/3d/`、AI 模型 `assets/{type}/ai/`、字体 `assets/{type}/fonts/`、代码 `assets/{type}/code/`、其它 `assets/{type}/other/`；`{type}` 取 `icon`/`background`/`emotion`/`user_icon`/`other`，平台专属可自定。
- 应用专属数据 **MAY** 以 JSON 文件放在 zip 根。
- zip **SHOULD NOT** 加密，文件名/路径 **SHOULD** 仅用 ASCII。
- 应用 **MAY** 因过大/损坏/加密等原因拒绝。

RisuAI / ST 的落地实现（一手-源码，说明真实世界的文件长什么样）：

- ST `src/charx.js`：接受 `embeded://`、`embedded://`（注释明确写「'embeded://' is intentional - RisuAI exports use this misspelling」）以及 `__asset:` 三种前缀；`type` 里 `emotion`/`expression` 归为立绘、`background` 归为背景；还处理 SFX（自解压）zip 签名偏移。
- RisuAI `src/ts/characterCards.ts`：导入支持 `.charx`、`.jpg`、`.jpeg`（JPEG 内嵌 CHARX 的模式），导出支持 `png` / `json` / `charx` / `charxJpeg` 四种，还支持「skippable / signal」两种 CHARX 变体（`CharXSkippableChecker`）。
- 源：<https://github.com/SillyTavern/SillyTavern/blob/release/src/charx.js>、<https://github.com/kwaroran/RisuAI/blob/main/src/ts/characterCards.ts>

### 2.5 V3 里没被 ST 处理的字段（对照表，便于判断「中文卡带 V3 特性时会不会丢」）

ST 的 `public/scripts/char-data.js` 里 `v2CharData` 只声明到 V2 字段 + `extensions` 若干扩展键（`talkativeness/fav/world/depth_prompt/regex_scripts/…`）。`nickname`、`assets`、`creator_notes_multilingual`、`source`、`group_only_greetings`、`creation_date`、`modification_date` 都不在其列。ST 之所以仍能「原样透传」，是因为导入 PNG 时它把整份 JSON 解析后重新序列化写回（`importFromPng` → `writeCharacterData`），而不是按 schema 白名单重建。**结论：只要导入器保留原 JSON，就不会丢 V3 独有字段；一旦按自己的字段表重建，就会丢。**


---

## 3. 世界书 / Lorebook JSON

一手-源码（SillyTavern `release`）：

- 条目字段与默认值：<https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/world-info.js>（`newWorldInfoEntryDefinition` / `newWorldInfoEntryTemplate`）
- 枚举：同文件 `world_info_logic` / `world_info_position` / `world_info_insertion_strategy`；`extension_prompt_roles` 在 <https://github.com/SillyTavern/SillyTavern/blob/release/public/script.js>
- 文件读写与导入校验：<https://github.com/SillyTavern/SillyTavern/blob/release/src/endpoints/worldinfo.js>
- ST ↔ CCv2 双向映射：`originalWIDataKeyMap`（world-info.js）与 `convertWorldInfoToCharacterBook()`（<https://github.com/SillyTavern/SillyTavern/blob/release/src/endpoints/characters.js>）
- 文档（一手-官方文档）：<https://docs.sillytavern.app/usage/core-concepts/worldinfo/> ｜ 源文件 <https://github.com/SillyTavern/SillyTavern-Docs/blob/main/Usage/worldinfo.md>

### 3.1 ST 写出的条目完整字段（含默认值、类型）

| 字段 | 类型 | 默认值 | 含义 / 注意 |
|---|---|---|---|
| `uid` | number | 自动分配 | ST 内部唯一 id，等于文件里 `entries` 对象的键 |
| `key` | string[] | `[]` | 主关键词（**数组**；ST 内部按正则匹配） |
| `keysecondary` | string[] | `[]` | 次关键词（配合 `selective`） |
| `comment` | string | `''` | 备注（不进 prompt） |
| `content` | string | `''` | 命中后插入的内容 |
| `constant` | boolean | `false` | 常驻（蓝灯） |
| `vectorized` | boolean | `false` | 向量化条目（配合向量扩展） |
| `selective` | boolean | `true` | 是否启用次关键词逻辑（绿灯） |
| `selectiveLogic` | enum | `world_info_logic.AND_ANY` = 0 | 取值：**0 = AND_ANY、1 = NOT_ALL、2 = NOT_ANY、3 = AND_ALL** |
| `addMemo` | boolean | `false` | 是否显示备注气泡 |
| `order` | number | `100` | 插入顺序（越小越靠前） |
| `position` | enum | `0` | 取值：**0=before(char 定义前)、1=after、2=AN Top、3=AN Bottom、4=@D(atDepth)、5=EM Top、6=EM Bottom、7=outlet** |
| `disable` | boolean | `false` | 停用（注意与 CCv2 的 `enabled` 正好相反） |
| `ignoreBudget` | boolean | `false` | 忽略 token 预算（新字段） |
| `excludeRecursion` | boolean | `false` | 不参与递归扫描 |
| `preventRecursion` | boolean | `false` | 不被递归激活 |
| `delayUntilRecursion` | number | `0` | 延迟到第 N 层递归才检查（0/1/2…） |
| `probability` | number | `100` | 触发概率（百分数） |
| `useProbability` | boolean | `true` | 是否启用概率 |
| `depth` | number | `DEFAULT_DEPTH`（4） | @D 位置时的深度 |
| `outletName` | string | `''` | outlet（命名插槽）名字 |
| `group` | string | `''` | 互斥分组名 |
| `groupOverride` | boolean | `false` | 组内只取最高权重 |
| `groupWeight` | number | `DEFAULT_WEIGHT`（100） | 组内权重 |
| `scanDepth` | number\|null | `null` | 覆盖全局扫描深度 |
| `caseSensitive` | boolean\|null | `null` | 覆盖全局大小写敏感 |
| `matchWholeWords` | boolean\|null | `null` | 覆盖全词匹配 |
| `useGroupScoring` | boolean\|null | `null` | 覆盖组内评分 |
| `automationId` | string | `''` | 自动化（STscript / QR）绑定 id |
| `role` | enum | `0` | 仅 `position=4`（@D）时有效：**0=system、1=user、2=assistant**（`extension_prompt_roles`） |
| `sticky` | number\|null | `null` | 命中后强制保持 N 条消息 |
| `cooldown` | number\|null | `null` | 命中后冷却 N 条消息 |
| `delay` | number\|null | `null` | 前 N 条消息内不触发 |
| `triggers` | string[] | `[]` | 限定触发时机：`normal/continue/impersonate/swipe/regenerate/quiet`（`GENERATION_TYPE_TRIGGERS`，constants.js） |
| `characterFilterNames` / `characterFilterTags` / `characterFilterExclude` | array/bool | `[]`/`false` | **不写入模板**（`excludeFromTemplate: true`），只存在 ST 运行时/设置里 |
| `extensions` | object | `{}` | 保留外部工具字段；ST 自己也会往这里写 `extensions.display_index` 等（见 `3.4） |
| `displayIndex` | number | = uid | 列表排序用；ST 保存到 `extensions.display_index` |

> 你给的清单里 `displayIndex`、`scanDepth`、`caseSensitive`、`matchWholeWords`、`useGroupScoring`、`automationId`、`role`、`vectorized`、`sticky`、`cooldown`、`delay` 全部存在；另外**新版本还多了 `ignoreBudget`、`triggers`、`outletName`、`matchPersonaDescription`、`matchCharacterDescription`、`matchCharacterPersonality`、`matchCharacterDepthPrompt`、`matchScenario`、`matchCreatorNotes`**（后六个是「关键词也匹配人设/场景/创作者备注」的开关），这些在老文档里查不到，容易被漏掉。

### 3.2 顶层字段

| 形态 | 结构 | 说明 |
|---|---|---|
| ST 原生（V2 形） | `{ "entries": { "0": {uid:0, …}, "1": {…} } }` | `entries` 是**以 uid 为键的对象**。ST 客户端一律按 `data.entries[uid]` 访问 |
| V2 世界书 / CCv2 `character_book`（数组形） | `{ "entries": [ {keys, content, enabled, insertion_order, …}, … ] }` | CCv2 规范形态。ST 也接受（服务端只校验 `'entries' in worldContent`），但会走 `convertCharacterBook()` 转换 |
| NovelAI lorebook | `{ "lorebookVersion": …, "entries": [ {keys, text, displayName, enabled, contextConfig:{budgetPriority}} ] }` | ST 检测到 `lorebookVersion` 就调用 `convertNovelLorebook()` |
| Agnai Memory Book | `{ "kind": "memory", "entries": [ {name, entry, keywords, enabled, weight, priority} ] }` | ST 检测 `kind === 'memory'` 调 `convertAgnaiMemoryBook()` |
| RisuAI lorebook | `{ "type": "risu", "data": [ {key, secondkey, content, comment, insertorder, alwaysActive, selective, activationPercent} ] }` | ST 检测 `type === 'risu'` 调 `convertRisuLorebook()` |
| 其它 | 顶层 `name` / `description` / `extensions` 可存在（ST 列表接口读 `name` 与 `extensions` 用于显示） | `scan_depth` / `token_budget` / `recursive_scanning` 在 ST 文件里**不存在**：ST 把它们放在全局设置 `world_info_depth` / `world_info_budget` / `world_info_recursive` / `world_info_max_recursion_steps` / `world_info_min_activations*`（`power_user`）里 |

**关键结论（一手-源码）**：`src/endpoints/worldinfo.js` 的 `/import` 与 `/edit` 只做一件事——检查 `'entries' in worldContent`，否则 400「Is not a valid world info file」。所以：

- `{entries:{...}}` 与 `{entries:[...]}` **都能通过导入校验**；
- **顶层裸数组 `[…  ]`（没有 `entries` 包裹）会被 ST 拒绝**。网上流传的「V1 裸数组」如果指的是「顶层就是数组」，ST 不接受；如果指的是「`entries` 是数组」，那是 CCv2/KoboldAI 形态，ST 接受并转换为内部 `entries` 对象。

### 3.3 全局设置（影响世界书行为，导入时没有文件可带）

ST 的 `world_info_*` 全局项：`world_info_depth`、`world_info_budget`、`world_info_budget_cap`、`world_info_recursive`、`world_info_max_recursion_steps`、`world_info_min_activations`、`world_info_min_activations_depth_max`、`world_info_include_names`、`world_info_overflow_alert`、`world_info_case_sensitive`、`world_info_match_whole_words`、`world_info_use_group_scoring`、`world_info_character_strategy`（插入策略枚举 `world_info_insertion_strategy = {evenly:0, character_first:1, global_first:2}`）、`world_info`（含 `globalSelect` 列表）。
源：<https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/world-info.js>

### 3.4 ST ↔ CCv2 字段映射（导入/导出世界书时最容易出错的地方）

`originalWIDataKeyMap`（ST 内部键 → 原始 JSON 路径）：

```
displayIndex → extensions.display_index        order        → insertion_order
excludeRecursion → extensions.exclude_recursion  depth      → extensions.depth
preventRecursion → extensions.prevent_recursion  probability → extensions.probability
delayUntilRecursion → extensions.delay_until_recursion       position → extensions.position
selectiveLogic → selectiveLogic                 role         → extensions.role
comment → comment                               content      → content
constant → constant                             enabled      → enabled
key → keys                                      keysecondary → secondary_keys
selective → selective                           matchWholeWords → extensions.match_whole_words
useGroupScoring → extensions.use_group_scoring  caseSensitive → extensions.case_sensitive
scanDepth → extensions.scan_depth               automationId → extensions.automation_id
vectorized → extensions.vectorized              groupOverride → extensions.group_override
groupWeight → extensions.group_weight           sticky → extensions.sticky
cooldown → extensions.cooldown                  delay → extensions.delay
triggers → extensions.triggers                  ignoreBudget → extensions.ignore_budget
matchPersonaDescription → extensions.match_persona_description
matchCharacterDescription → extensions.match_character_description
matchCharacterPersonality → extensions.match_character_personality
matchCharacterDepthPrompt → extensions.match_character_depth_prompt
matchScenario → extensions.match_scenario       matchCreatorNotes → extensions.match_creator_notes
```

导出成 CCv2 `character_book` 时 ST 还会做**有损**处理（`convertWorldInfoToCharacterBook`）：

- `position: entry.position == 0 ? 'before_char' : 'after_char'` —— **@D / AN / EM / outlet 这些位置全部塌缩成 before/after**（真正的值被塞进 `extensions.position` 保底）。
- `use_regex: true` 恒为 true（ST 的关键词就是正则）。
- `enabled: !entry.disable`（取反）。
- 顶层只写 `{entries, name}`，**不写** `scan_depth` / `token_budget` / `recursive_scanning`。
- 反方向（`convertCharacterBook`）读 CCv2 时：`uid = entry.id ?? index`、`disable = !entry.enabled`、`position = extensions.position ?? (position==='before_char' ? 0 : 1)`，且 **`characterBook.scan_depth` / `token_budget` / `recursive_scanning` 被直接丢弃**（代码里根本没读）。

### 3.5 世界书三种「归属」（导入时别混淆）

- **角色书（character lore）**：卡内 `data.character_book`，或 ST 里绑到角色的世界书（`data.extensions.world`）。导出角色时只有「主」世界书会内嵌。
- **全局世界书**：用户勾选激活。
- **Chat Lore（聊天级世界书）**：只在该对话生效，存在聊天文件的元数据里，键名 `chat_metadata.world_info = "<世界书名>"`（`METADATA_KEY = 'world_info'`）。
- 另有 **Persona Lore**（`power_user.persona_description_lorebook`）。
- 文档：<https://docs.sillytavern.app/usage/core-concepts/worldinfo/>（Character Lore / Persona Lorebook / Chat Lorebook / Lore Insertion Strategy 小节）


---

## 4. SillyTavern 的预设 / 设置导出

一手-源码：

- 预设管理器（导出/导入/主包）：<https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/preset-manager.js>
- 服务端存取与目录：<https://github.com/SillyTavern/SillyTavern/blob/release/src/endpoints/presets.js>
- 默认预设样例：<https://github.com/SillyTavern/SillyTavern/tree/release/default/content/presets>
- 默认设置：<https://github.com/SillyTavern/SillyTavern/blob/release/default/content/settings.json>
- 文档：<https://github.com/SillyTavern/SillyTavern-Docs/blob/main/Usage/Prompts/advancedformatting.md>、<https://github.com/SillyTavern/SillyTavern-Docs/blob/main/Usage/Prompts/instructmode.md>、<https://github.com/SillyTavern/SillyTavern-Docs/blob/main/Usage/Prompts/context-template.md>、<https://github.com/SillyTavern/SillyTavern-Docs/blob/main/Usage/Prompts/reasoning.md>

### 4.1 用户点「导出预设」时文件长什么样

**A. 单一预设导出**（`[data-preset-manager-export]` 按钮）：把当前预设对象整体 `JSON.stringify(preset, null, 4)` 存成 `<预设名>.json` 下载。也就是说：

- 预设类型由**按钮所在面板**决定（apiId），文件本身**不带类型标记**；
- 导入时：`const name = data?.name ?? fileName; data.name = name;` —— 名字优先取文件里的 `name`，否则取文件名。所以聊天补全预设**必须**有 `name` 才不乱序（`preset_settings_openai` 也是靠 name 索引）。
- 源：preset-manager.js 的 `[data-preset-manager-export]` / `[data-preset-manager-file]` 处理器。

**B. 高级格式化「主导出」**（Advanced Formatting → Export）：文件名 `ST-formatting-YYYY-MM-DD.json`，内容是若干 section 的字典：

```json
{
  "instruct":  { /* Instruct Template */ },
  "context":   { /* Context Template */ },
  "sysprompt": { /* System Prompt */ },
  "preset":    { /* Text Completion Preset（导出弹窗里默认不勾选） */ },
  "reasoning": { /* Reasoning Formatting */ },
  "srw":       { "value": "…", "show": false }   // Start Reply With（默认不勾选）
}
```

- 各 section 的键名固定为 `instruct|context|sysprompt|preset|reasoning|srw`，导出弹窗里 `preset` 与 `srw` 默认**不勾选**。
- 导入（`performMasterImport`）优先解析「主包」结构；解析失败则**回退**逐类型嗅探，嗅探规则就是各类型的特征字段（见 `4.6），最后还会单独识别「老式」单预设文件。

### 4.2 Chat Completion 预设（oai_settings，62 个顶层键）

来源：<https://github.com/SillyTavern/SillyTavern/blob/release/default/content/presets/openai/Default.json>

```
chat_completion_source openai_model claude_model openrouter_model openrouter_use_fallback
openrouter_group_models openrouter_sort_models ai21_model mistralai_model chutes_model
chutes_sort_models minimax_model minimax_endpoint electronhub_model electronhub_sort_models
electronhub_group_models custom_model custom_url custom_include_body custom_exclude_body
custom_include_headers google_model vertexai_model temperature frequency_penalty
presence_penalty top_p top_k top_a min_p repetition_penalty openai_max_context
openai_max_tokens names_behavior send_if_empty impersonation_prompt new_chat_prompt
new_group_chat_prompt new_example_chat_prompt continue_nudge_prompt bias_preset_selected
reverse_proxy proxy_password max_context_unlocked wi_format scenario_format personality_format
group_nudge_prompt stream_openai prompts prompt_order show_external_models assistant_prefill
assistant_impersonation use_sysprompt squash_system_messages media_inlining bypass_status_check
continue_prefill continue_postfix seed n
```

其中两个结构性字段是**导入还原的关键**：

```jsonc
// prompts: 提示词块列表
{ "name": "Main Prompt", "system_prompt": true, "role": "system",
  "content": "Write {{char}}'s next reply …", "identifier": "main" }
// marker: true 的块（dialogueExamples / chatHistory / worldInfoBefore / worldInfoAfter /
// charDescription / charPersonality / scenario / personaDescription）没有 content，是占位锚点
{ "identifier": "chatHistory", "name": "Chat History", "system_prompt": true, "marker": true }

// prompt_order: 每个 character_id 一份顺序表（100000 = 通用，100001 = 群聊）
{ "character_id": 100000,
  "order": [ { "identifier": "main", "enabled": true }, … ] }
```

默认 `prompts` 的 identifier 集合（共 12 个）：`main、nsfw、dialogueExamples、jailbreak、chatHistory、worldInfoAfter、worldInfoBefore、enhanceDefinitions、charDescription、charPersonality、scenario、personaDescription`。
搜索/采样相关的实际字段全集（截断显示，完整键名见上面的 62 键与 openai.js 的 `settingsToUpdate`）：`temperature/frequency_penalty/presence_penalty/top_p/top_k/top_a/min_p/repetition_penalty/seed/n/reasoning_effort/verbosity/show_thoughts/…`（`reasoning_effort`、`verbosity`、`show_thoughts`、`function_calling`、`tool_call_recurse_limit`、`request_images` 等由 openai.js 的 UI 绑定写入，默认预设里没有）。
源：<https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/openai.js>

### 4.3 Text Completion 预设（textgen_settings，61 键）

来源：<https://github.com/SillyTavern/SillyTavern/blob/release/default/content/presets/textgen/Default.json>

```
temp temperature_last top_p top_k top_a tfs epsilon_cutoff eta_cutoff typical_p min_p
rep_pen rep_pen_range rep_pen_decay rep_pen_slope no_repeat_ngram_size penalty_alpha
num_beams length_penalty min_length encoder_rep_pen freq_pen presence_pen skew do_sample
early_stopping dynatemp min_temp max_temp dynatemp_exponent smoothing_factor smoothing_curve
dry_allowed_length dry_multiplier dry_base dry_sequence_breakers dry_penalty_last_n
add_bos_token ban_eos_token skip_special_tokens mirostat_mode mirostat_tau mirostat_eta
guidance_scale negative_prompt grammar_string json_schema json_schema_allow_empty
banned_tokens sampler_priority samplers samplers_priorities ignore_eos_token
spaces_between_special_tokens speculative_ngram sampler_order logit_bias xtc_threshold
xtc_probability nsigma min_keep rep_pen_size
```

### 4.4 Instruct Template（22 键，样例 `Alpaca`）

来源：<https://github.com/SillyTavern/SillyTavern/blob/release/default/content/presets/instruct/Alpaca.json>

```
input_sequence output_sequence last_output_sequence system_sequence stop_sequence wrap macro
names_behavior activation_regex first_output_sequence skip_examples output_suffix input_suffix
system_suffix user_alignment_message system_same_as_user last_system_sequence
first_input_sequence last_input_sequence sequences_as_stop_strings story_string_prefix
story_string_suffix name
```

（`names_behavior` 有 0/1/2 三态；`names_behavior: "force"` 是旧式字符串，两种都要能读——默认文件里是字符串 `"force"`，openai 预设里是数字 `0`。）

### 4.5 Context Template / System Prompt / Reasoning Formatting

**Context Template**（`default/content/presets/context/Default.json`）：
`story_string`（Handlebars 模板，用 `{{#if description}}…` 等变量拼提示词）、`example_separator`、`chat_start`、`use_stop_strings`、`names_as_stop_strings`、`story_string_position`、`story_string_depth`、`story_string_role`、`always_force_name2`、`trim_sentences`、`single_line`、`name`。

**System Prompt**（`default/content/presets/sysprompt/Roleplay - Simple.json`）：
`{ "name": "…", "content": "You're {{char}} …", "post_history": "" }` —— 只有三键。

**Reasoning Formatting**（`default/content/presets/reasoning/DeepSeek.json`）：
`{ "name": "DeepSeek", "prefix": "<think>\n", "suffix": "\n</think>", "separator": "\n\n" }`。

**Quick Replies（老格式 v1，见 `7.7）**、**Kobold（`kai_settings`）**、**NovelAI（`nai_settings`）** 也是同一套 preset manager 管理的预设类型，目录分别是 `koboldAI_Settings`、`novelAI_Settings`、`textGen_Settings`、`openAI_Settings`、`instruct`、`context`、`sysprompt`、`reasoning`（`getPresetSettingsByAPI`，src/endpoints/presets.js）。

### 4.6 类型嗅探规则（拿一个陌生 JSON 判断它是什么预设）

```js
isPossiblyInstructData      = ['name','input_sequence','output_sequence']
isPossiblyContextData       = ['name','story_string']
isPossiblySystemPromptData  = ['name','content']
isPossiblyTextCompletionData= ['temp','top_k','top_p','rep_pen']
isPossiblyReasoningData     = ['name','prefix','suffix','separator']
isPossiblyStartReplyWithData= ['value','show']
```

源：preset-manager.js 的 `static isPossibly*Data`。注意 `sysprompt` 与 `reasoning` 的判据都很弱（`name+content` / `name+prefix+suffix+separator`），实现时要靠**组合**判断，否则会把角色卡误判成系统提示词。

### 4.7 settings.json 里的 key 分组

`default/content/settings.json` 顶层键（一手-源码）：

```
firstRun username api_server preset_settings user_avatar amount_gen max_context main_api
world_info_settings textgenerationwebui_settings swipes horde_settings power_user
extension_settings tags tag_map nai_settings kai_settings oai_settings
```

- `power_user` 里放的是**格式化/世界书/人格等大头设置**（`context`、`instruct`、`sysprompt`、`reasoning`、`persona_descriptions`、`personas`、`world_info_*`、`theme` 相关字段、`user_prompt_bias` 等）。
- `extension_settings` 里按扩展名分桶（`regex`、`regex_presets`、`quickReplyV2`、`quickReply`…）。
- 服务端 `/api/settings/get` 返回的 JSON 里还会**注入** `quickReplyPresets`（`quick-reply/index.js` 的 `loadSets` 读取）。
- 源：<https://github.com/SillyTavern/SillyTavern/blob/release/src/endpoints/settings.js>、<https://github.com/SillyTavern/SillyTavern/blob/release/default/content/settings.json>


---

## 5. 聊天记录

一手-源码：

- 存盘/读取（服务端）：<https://github.com/SillyTavern/SillyTavern/blob/release/src/endpoints/chats.js>
- 客户端存盘与头部：<https://github.com/SillyTavern/SillyTavern/blob/release/public/script.js>、<https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/chats.js>
- 时间戳实现：<https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/RossAscends-mods.js>
- 文档：<https://github.com/SillyTavern/SillyTavern-Docs/blob/main/Usage/Characters/chatfilemanagement.md>

### 5.1 现在的 `.jsonl`（一行一个 JSON）

**第 1 行 = 元数据头**：

```json
{"chat_metadata":{…},"user_name":"unused","character_name":"unused"}
```

- 注意 `user_name` / `character_name` 都是字面量 `"unused"`（新版 ST 已经把真实名字去掉，靠目录/文件名关联角色）。老版本这里曾是真实用户名与角色名，**导入时要两种都能吃**。
- 元数据键（代码里实际用到的）：`integrity`（UUID，保存时校验聊天文件完整性）、`attachments`、`timedWorldInfo`、`lastInContextMessageId`、`tainted`、`persona`、`scenario`、`system_prompt`、`mes_example`、`world_info`（Chat Lore 绑定，见 `3.5）。**未核实**：完整键集是开放的（代码用动态赋值），上表只是当前版本代码里出现的键。
- `chat_metadata.integrity` 若缺失，客户端加载时会补一个新 UUID；服务端开启完整性检查时，slug 不匹配会拒绝保存。

**第 2 行起 = 消息对象**：

```json
{
  "name": "角色名或用户名",
  "is_user": false,
  "is_system": false,
  "send_date": "2026-10-14T12:00:00.000Z",
  "mes": "正文",
  "extra": { }
}
```

| 字段 | 类型 | 说明 / 来源 |
|---|---|---|
| `name` | string | 显示名（用户消息取 `name1`/人格名） |
| `is_user` | boolean | true = 用户消息 |
| `is_system` | boolean | true = 被隐藏（hide）的消息，仍在文件里但默认不进上下文；ST 的 `hideChatMessageRange` 直接写这个字段 |
| `send_date` | string | **ISO 8601 UTC 字符串**（`getMessageTimeStamp` = `new Date().toISOString()`）。历史文件里可能是本地化的「humanized」字符串，解析要容错 |
| `mes` | string | 正文 |
| `extra` | object | 见下 |
| `force_avatar` | string? | 可选，锁定该消息的头像（人格锁定时写入） |
| `swipes` | string[]? | 可选，多候选回复（旧版存字符串数组；Chub 导出里可能是对象数组，见 `5.3） |
| `swipe_id` / `swipe_info` | number/array? | 可选，swipe 索引与每条的生成信息 |

**`extra` 里出现过的键**（对全部 ST 前端源码扫 `extra.X =` 得到）：`api`、`model`、`gen_id`、`reasoning`、`reasoning_duration`、`reasoning_signature`、`reasoning_type`、`time_to_first_token`、`token_count`、`bias`、`inline_image`、`media`、`media_display`、`media_index`、`files`、`fileLength`、`isSmallSys`、`type`（系统消息类型，如 `NARRATOR` / `ASSISTANT_NOTE`）。
**导入建议**：`extra` 全部按「不认识的键原样保留」处理，只读你确实要用的几个。

### 5.2 旧的 `.json` 聊天形态

ST **自己现在只写 `.jsonl`**；`.json` 是「从别的软件导进来」的形态，ST 的 `/api/chats/import` 按 `file_type` 分派（一手-源码）：

| 来源 | 判定条件 | 结构要点 | 转换损失 |
|---|---|---|---|
| oobabooga | `Array.isArray(jsonData.data_visible)` | `data_visible` = `[[用户文本, 角色文本], …]` 的二维数组 | 时间戳重造、无 swipe、无 metadata |
| Agnai | `Array.isArray(jsonData.messages)` | 每条 `{userId, msg}`；有 `userId` 即用户消息 | 同上；`_id/created` 丢弃 |
| CAI Tools（Character.AI） | `jsonData.histories` | `histories.histories[].msgs[].{src.is_human, text}`；一个 history 一个文件 | 多分支 → 多文件；分支元数据丢 |
| KoboldAI Lite | `jsonData.savedsettings` | `savedsettings.chatname / chatopponent`（`\|\|$\|\|` 分隔，取第一段）、`actions[]` 消息串（含 `{{[INPUT]}}` / `{{[OUTPUT]}}` 标记）、可选 `prompt` | 采样设置、软提示全丢 |
| RisuAI | `jsonData.type === 'risuChat'` | `data.message[]` 的 `{role:'user'\|'char', data, time, name}` | 生成信息（`generationInfo`）丢 |
| Chub | 看不出标记，靠「扁平化」试探：`mes` 可能是 `{message: …}`、`swipes` 里可能是 `{message: …}` 对象 | ST 用 `flattenChubChat()` 把它们压成字符串 | 对象里的其它字段丢 |
| 标准 jsonl | 首行含 `user_name`/`name`/`chat_metadata` 之一 | 直接复制成 `<角色> - <时间> imported.jsonl` | 图片/附件按文档说明**不包含** |

> TavernAI 原始版自己的 `.json` 聊天文件结构：**未核实**（没找到一手源码；ST 的导入列表里也没有单独的 TavernAI 分支，只有上述几种）。

### 5.3 导入实现建议

1. 先按 `.jsonl` 读：首行必须是对象且含 `chat_metadata`/`user_name`/`name`，否则报错（ST 的判据）。
2. `.json` 就按上面的判定顺序嗅探，嗅探不到再提示用户。
3. 一律输出成你的内部格式，并**至少保留 `extra` 与 `chat_metadata`**，否则「导入再导出」会丢东西。

---

## 6. 正则脚本（ST Regex 扩展）

一手-源码：

- 字段类型定义（最权威）：<https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/char-data.js>（`RegexScriptData`）
- 枚举与执行：<https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/extensions/regex/engine.js>
- 编辑/导出/导入：<https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/extensions/regex/index.js>
- 文档：<https://github.com/SillyTavern/SillyTavern-Docs/blob/main/extensions/Regex.md>

### 6.1 脚本对象字段

```ts
/** @typedef {object} RegexScriptData */
{
  id: string            // UUID
  scriptName: string    // 脚本名
  findRegex: string     // 匹配用的正则（字符串形式，通常带 /…/flags）
  replaceString: string // 替换串（支持 {{match}} 之类的宏）
  trimStrings: string[] // 替换结果里要裁掉的字符串列表
  placement: number[]   // 作用位置，可多选，见下
  disabled: boolean
  markdownOnly: boolean // 只作用于显示（Only Format Display）
  promptOnly: boolean   // 只作用于发给模型的提示词
  runOnEdit: boolean    // 编辑消息时也执行
  substituteRegex: number // 0=NONE, 1=RAW, 2=ESCAPED
  minDepth: number      // 仅对深度 ≥ minDepth 的消息生效
  maxDepth: number      // 仅对深度 ≤ maxDepth 的消息生效
}
```

`placement`（`regex_placement`，engine.js）：

| 值 | 名称 | 说明 |
|---|---|---|
| 0 | `MD_DISPLAY` | **已废弃**（源码注释：Do not use） |
| 1 | `USER_INPUT` | 用户输入 |
| 2 | `AI_OUTPUT` | AI 输出 |
| 3 | `SLASH_COMMAND` | 斜杠命令 |
| 4 | （保留） | 旧的 sendAs 模式，源码注释 legacy |
| 5 | `WORLD_INFO` | 世界书内容 |
| 6 | `REASONING` | 思维链内容 |

`substituteRegex`（`substitute_find_regex`）：`NONE: 0` / `RAW: 1` / `ESCAPED: 2`。

### 6.2 导出的文件形态

- **单脚本导出**（脚本行上的导出按钮）：`JSON.stringify(script, null, 4)` → `<脚本名>.json`。**顶层是单个对象**，不是数组。
- **导入**：`onRegexImportFileChange` 先 `JSON.parse`，**数组就逐个导入，对象就单个导入**；导入时还会弹窗问放到 `global` / `scoped` / `preset` 哪个桶。
- **正则预设（Regex Preset）**：`extension_settings.regex_presets[]`，结构 `{ id, name, isSelected, global: [{id}], scoped: [{id}], preset: [{id}] }` —— 预设**只存脚本 id 引用**，不存脚本本体，所以「导出一份正则预设」必须同时导出被引用的脚本（**未核实**：ST 是否提供把预设+脚本打成单文件的官方导出；源码里看到的是脚本级导出与预设编辑器）。
- **角色卡内嵌正则**：`data.extensions.regex_scripts` = `RegexScriptData[]`（见 `1.3），是「卡带正则」的官方位置。


---

## 7. 其他同类软件的格式与可导入性

### 7.1 RisuAI（`.risum` / `.charx` / 原生卡）

一手-源码：<https://github.com/kwaroran/RisuAI/blob/main/src/ts/storage/database.svelte.ts>（`character` / `loreBook` / `Chat` / `Message`）、<https://github.com/kwaroran/RisuAI/blob/main/src/ts/characterCards.ts>（导入导出与 V2/V3 互转）、<https://github.com/kwaroran/RisuAI/blob/main/src/ts/process/modules.ts>（`.risum`）

**原生角色对象 `character`（Risu 数据库里的形态，导出时再转成 V2/V3）关键字段**：
`name`、`image`、`firstMessage`、`desc`、`notes`、`personality`、`scenario`、`exampleMessage`、`creatorNotes`、`systemPrompt`、`postHistoryInstructions`、`alternateGreetings[]`、`tags[]`、`creator`、`characterVersion`、`bias: [string, number][]`、`emotionImages: [string, string][]`、`globalLore: loreBook[]`、`loreSettings {tokenBudget, scanDepth, recursiveScanning, fullWordMatching?}`、`customscript[]`、`triggerscript[]`、`utilityBot`、`viewScreen`、`sdData`、`newGenData`、`additionalData {tag?, creator?, character_version?}`、`chats: Chat[]`、`chaId`、`firstMsgIndex`。

**Risu 世界书条目 `loreBook`（注意有个拼写错误 `extentions`）**：
`key: string`（**逗号分隔字符串**，不是数组）、`secondkey: string`、`insertorder: number`、`comment: string`、`content: string`、`mode: 'multiple'|'constant'|'normal'|'child'|'folder'`、`alwaysActive: boolean`、`selective: boolean`、`extentions?: {risu_case_sensitive: boolean}`、`activationPercent?: number`、`loreCache?`、`useRegex?: boolean`、`bookVersion?`、`id?`、`folder?`。

**聊天 `Chat` / `Message`**：`Chat { message: Message[], note, name, localLore: loreBook[], modules?, scriptstate?, bindedPersona?, folderId?, bookmarks? … }`；`Message { role: 'user'|'char', data: string, saying?, chatId?, time?: number, generationInfo?, promptInfo?, name?, otherUser?, disabled?: false|true|'allBefore', isComment? }`。

**卡片文件**：导出支持 `png` / `json` / `charx` / `charxJpeg` 四种（`exportCharacterCard`）；导入还认 `.charx/.jpg/.jpeg` 与 CHARX 的 skippable/signal 变体。V2 卡里 Risu 的私有数据放在 `data.extensions.risuai`：`emotions`、`bias`、`viewScreen`、`customScripts`、`utilityBot`、`sdData`、`additionalAssets`、`backgroundHTML`、`license`、`triggerscript`、`private`、`additionalText`、`virtualscript`、`largePortrait`、`lorePlus`、`inlayViewScreen`、`newGenData`、`vits`；另有 `data.extensions.depth_prompt {depth, prompt}`。

**`.risum` 模块**：`RisuModule { name, description, lorebook?: loreBook[], regex?: customscript[], cjs?: string, trigger?: triggerscript[], id, lowLevelAccess?, hideIcon?, backgroundEmbedding?, assets?: [string,string,string][], namespace?, customModuleToggle?, mcp?, icon? }`；老式导出是二进制包（写 1 字节 magic `111`、1 字节版本、4 字节 LE 长度、然后 `encodeRPack` 压缩的 `{module, type:'risuModule'}` JSON，后面追加资产）；新版 `exportModule` 直接包成 `<name>.module`（内部是 charx）。

**转换程度**：
- Risu V2/V3 卡 → 你的 App：**几乎无损**（标准字段 + `extensions` 原样留存）。
- Risu 世界书 → 标准世界书：`key/secondkey` 逗号切分成数组、`alwaysActive→constant`、`insertorder→order`、`activationPercent→probability(useProbability)`、`useRegex→use_regex`、`extentions.risu_case_sensitive→case_sensitive`。**会丢**：`mode` 的 `multiple/child/folder` 分组语义、`folder` 目录树、`loreCache`。
- Risu 的 `content` 里可能带 CCv3 **decorator**（Risu 自己就会把 `extensions.probability`、`position=4+depth+role`、`selectiveLogic`、`delay`、`match_whole_words` 转成 `@@probability` / `@@depth` / `@@role` / `@@exclude_keys_all` / `@@exclude_keys` / `@@additional_keys` / `@@activate_only_after` / `@@match_full_word` / `@@match_partial_word`，见 `convertCharbook()`）。**建议：直接按 CCv3 decorator 语义解析，一份代码同时兼容 Risu 与 V3 卡。**
- 会丢：立绘/背景/表情（需 CHARX 资产处理）、`customscript`/`triggerscript`（JS 逻辑无法移植）、`vits`/TTS 配置、`hypaV2Data` 等 RAG 缓存。

### 7.2 Agnai

一手-源码：<https://github.com/agnaistic/agnai/blob/main/common/types/library.ts>、<https://github.com/agnaistic/agnai/blob/main/common/types/memory.ts>、<https://github.com/agnaistic/agnai/blob/main/srv/api/character.ts>
一手-官方指南：<https://agnai.guide/docs/creating-a-character/>

**角色 `Character`（= `BaseCharacter` + 扩展）**：
`_id`、`name`、`description?`、`appearance?`、`avatar?`、`persona: Persona`、`greeting: string`、`scenario: string`、`sampleChat: string`、`kind: 'character'`、`userId`、`culture?`、`tags?: string[]`、`visualType?`、`sprite?`、`favorite?`、`voice?`、`json?: ResponseSchema`、`folder?`，以及**已经为兼容 V2 加上的字段**：`alternateGreetings?`、`characterBook?: MemoryBook`、`extensions?`、`systemPrompt?`、`postHistoryInstructions?`、`insert?: {depth, prompt}`、`creator?`、`characterVersion?`。

**人格 `Persona`**：`{ kind: PersonaFormat, attributes: { [key]: string[] } }` 或 `{ kind: 'text', attributes: { text: [string] } }`（官方指南里叫 Persona Schema：plain text 与 attributes 两种）。

**记忆书 `MemoryBook`**：`{ kind: 'memory', _id, name, description?, userId, entries: MemoryEntry[], scanDepth?, tokenBudget?, recursiveScanning?, extensions? }`。
**`MemoryEntry`**：`{ name, entry, keywords: string[], priority, weight, enabled, id?, comment?, secondaryKeys?, constant?, position?, probability?, useProbability?, selective?, selectiveLogic?, excludeRecursion? }`。

**聊天**：`{ messages: [ { userId?, msg } ] }`（ST 的判据就是 `Array.isArray(jsonData.messages)`）。

**转换程度**：
- 角色 → V2 卡：`persona.attributes` 拍平成 `"key: value"` 文本进 `description/personality`（**丢结构**）、`greeting→first_mes`、`sampleChat→mes_example`、`scenario→scenario`、`insert→extensions.depth_prompt`、`characterBook→character_book`。**丢**：`sprite/visualType`（立绘）、`voice`、`json`（响应格式约束）、`appearance`（可并入 description）。
- 记忆书 → 世界书：`keywords→key`、`entry→content`、`name→comment`、`weight→order`（ST 就是这样转的）。**丢**：`priority`（ST 丢弃）、`scanDepth/tokenBudget/recursiveScanning`（ST 丢弃，见 `3.4）。
- 聊天 → `.jsonl`：只保留 `msg` 与「谁说的」，时间戳重造。

### 7.3 Chub

一手-官方文档：<https://docs.chub.ai/docs/the-basics/character-creation>、<https://docs.chub.ai/docs/advanced-setups/prompting>
一手-源码（ST 兼容处理）：<https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/char-data.js>（`extensions.chub: {full_path}`）、<https://github.com/SillyTavern/SillyTavern/blob/release/src/endpoints/chats.js>（`flattenChubChat`）

- **角色卡**：Chub 下载的就是 CCv2/CCv3 PNG 或 JSON，额外元数据放在 `extensions.chub.full_path`（ST 明确把它列为「第三方非标准扩展」）。Chub 平台的「Character Info」字段（Display Name/In-Chat Name、Tagline、Avatar、Tags、NSFW 标记）里，**只有 Display Name/In-Chat Name 有卡片对应物（V3 `nickname`）**，Tagline 等**平台字段没有卡片对应**（计入丢失）。
- **Lorebook**：即 CCv2 `character_book`，可直接读。
- **聊天导出**：`.jsonl`，但 `mes` 可能是 `{message: …}` 对象、`swipes` 里元素可能是 `{message: …}` 对象；ST 用 `flattenChubChat()` 把它们压平成字符串。**会丢**：对象里的其它字段（ST 只取 `.message`）。格式细节 **【二手】**：<https://thredly.io/save-chub-ai-chats>（JSONL / PNG / text 三种导出）。

### 7.4 JanitorAI

一手-官方帮助：<https://help.janitorai.com/en/article/bot-creation-guide-w-images-by-faylua-8jcbw1/>
二手：<https://charactercardconverter.com/guides/janitorai-to-sillytavern-guide.html>

- **创作者侧字段**：Name、Avatar、Tagline、Tags、内容分级（Limited / Limitless）、**Personality（自由格式「角色卡」正文）**、Scenario、First Message、Example Dialogs。
- **导出形态**：社区转换器说「JanitorAI 导出通常是 V2 PNG（`chara` 里 base64 JSON）或 V2 风格 JSON」——**【二手】**；Jack 平台侧的确切字段名 **【未核实】**。
- **转换程度**：按 V2 读即可拿到大部分内容；**会丢**：Tagline、内容分级、平台内部 id / 作者归属（若导出里没有 `creator`/`source`）。

### 7.5 Pygmalion / TavernAI 老格式

一手-规范 V1：<https://github.com/malfoyslastname/character-card-spec-v2/blob/main/spec_v1.md>
一手-源码（ST 的导入分支）：<https://github.com/SillyTavern/SillyTavern/blob/release/src/endpoints/characters.js>（`importFromJson`）

- **V1 卡（顶层 6 字段）**：`name`、`description`、`personality`、`scenario`、`first_mes`、`mes_example`，全部 **MUST** 默认为空串；`{{char}}`/`<BOT>`、`{{user}}`/`<USER>` 大小写不敏感替换；`<START>` 分段示例对话。
- **Pygmalion/gradio 老 JSON（ST 认这个）**：`char_name`、`char_persona`、`char_greeting`、`example_dialogue`、`world_scenario`（可选 `creator_notes`/`creatorcomment`、`talkativeness`、`tags`）。ST 的映射：`name←char_name`、`description←char_persona`、`first_mes←char_greeting`、`mes_example←example_dialogue`、`scenario←world_scenario`、`personality←''`。
- **转换程度**：很高，但**必丢**：无 `personality`、无 `alternate_greetings`、无 `character_book`、无 `creator`/`character_version`、无 `system_prompt`（这些字段在那个年代不存在）。

### 7.6 KoboldAI world info

一手-源码：<https://github.com/KoboldAI/KoboldAI-Client/blob/main/aiserver.py>

- **条目结构**（`addwiitem` 与 lua 属性白名单）：`key`（**字符串**，逗号分隔，不是数组）、`keysecondary`（字符串）、`content`、`comment`、`folder`（所属文件夹 uid）、`num`（序号）、`init`、`selective`（bool）、`constant`（bool）、`uid`（随机 int，可负）。
- **文件夹**：`wifolders` / `wifolders_d` / `wifolders_u`；界面 API 是 `GET /api/v1/world_info`、`/world_info/folders` 等；世界信息**随 KoboldAI 存档/settings 走，没有像 ST 那样的「世界书 .json 单文件」导出**（一手证据：aiserver.py 里没有独立 WI 文件的读写路径）。
- **转换程度**：条目本身好转——`key/keysecondary` 按逗号切成数组、`selective`/`constant`/`comment`/`content` 直接对应、`uid` 可当 ST 的 uid。**会丢 / 会歧义**：`folder` 是「目录」语义，ST/CCv2 的 `group` 是「互斥分组」语义——**不能直接映射**（建议丢进 `extensions.kobold_folder` 保底）；`num`/`init` 无意义。
- **ST 侧的现状**：ST 的 `importWorldInfo()` 只内置 NovelAI（`lorebookVersion`）、Agnai（`kind:'memory'`）、Risu（`type:'risu'`）三种转换分支，**没有 KoboldAI 分支** —— 想收 KoboldAI 用户就得自己写（判定：顶层有 `entries` 数组且元素含 `key`/`keysecondary` 字符串 + `folder`/`num`/`init` 特征）。

### 7.7 SillyTavern 的 Quick Replies / Persona / Themes / Chat Lore

一手-源码：<https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/extensions/quick-reply/index.js>、<https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/extensions/quick-reply/src/QuickReply.js>、<https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/personas.js>、<https://github.com/SillyTavern/SillyTavern/blob/release/default/content/themes/Azure.json>

**Quick Replies（v2，当前形态）** —— 一个「集合」就是一个文件（`/api/quick-replies/save` 把请求体整体写成 `<name>.json`）：
```jsonc
{ "name": "…", "scope": "global|chat|character", "disableSend": false,
  "placeBeforeInput": false, "injectInput": false, "color": "transparent",
  "onlyBorderColor": false, "idIndex": 0,
  "qrList": [ {
      "id": 1, "icon": "", "label": "…", "showLabel": false, "title": "…",
      "message": "/command 或文本", "preventAutoExecute": true, "isHidden": false,
      "executeOnStartup": false, "executeOnUser": false, "executeOnAi": false,
      "executeOnChatChange": false, "executeOnGroupMemberDraft": false,
      "executeOnNewChat": false, "executeBeforeGeneration": false,
      "automationId": "", "contextList": [ {"set": "其他集合名", "isChained": false} ]
  } ] }
```
旧版（v1，`default/content/presets/quick-replies/Default.json`）：`{name, quickReplyEnabled, quickReplySlots:[{mes,label,enabled,title,hidden,autoExecute_appStartup|userMessage|botMessage|chatLoad|groupMemberDraft|newChat|beforeGeneration,automationId,contextMenu:[{preset,chain}]}], numberOfSlots, selectedPreset}`。`version !== 2` 时 ST 会按 `loadSets()` 里的映射自动迁移。
**转换程度**：`label/message` 直接可用；`executeOn*` 触发时机与 `/slash` 命令体系**在你的 App 里没有对应物**，属于会丢或需重写。

**Persona 导出**：文件名 `personas_YYYYMMDD.json`，内容 `{ "personas": {avatarId: 名字}, "persona_descriptions": {avatarId: {description, position, depth, role, lorebook, title, connections: [{type:'character'|'group', id}]}}, "default_persona": … }`；`position` 枚举 `persona_description_positions = {IN_PROMPT:0, AFTER_CHAR(已废弃):1, TOP_AN:2, BOTTOM_AN:3, AT_DEPTH:4, NONE:9}`。
**转换程度**：`description` 直接可用；`position/depth/role` 要映射到你自己的「人格注入位置」模型；`connections`（绑定到具体角色/群聊）与 `lorebook` 需要额外逻辑。

**Themes**：主题文件就是一份 `power_user` 主题字段的 JSON。`default/content/themes/Azure.json` 的 34 个键：
```
name blur_strength main_text_color italics_text_color underline_text_color quote_text_color
blur_tint_color chat_tint_color user_mes_blur_tint_color bot_mes_blur_tint_color shadow_color
shadow_width border_color font_scale fast_ui_mode waifuMode avatar_style chat_display noShadows
chat_width timer_enabled timestamps_enabled timestamp_model_icon mesIDDisplay_enabled
hideChatAvatars_enabled message_token_count_enabled expand_message_actions enableZenSliders
enableLabMode hotswap_enabled custom_css bogus_folders reduced_motion compact_input_area
```
**转换程度**：颜色/模糊/字号可映射；`custom_css`、`waifuMode`、`avatar_style` 等 ST 专有项无法移植（**会丢**）。

**Chat Lore**：不是独立文件，而是聊天元数据里的一个字符串 `chat_metadata.world_info = "<世界书名>"`（`METADATA_KEY = 'world_info'`）；导入聊天时要同时把被引用的世界书一起导入，否则该绑定失效。


---

## 8. 引用清单（按证据等级）

### 8.1 一手：规范原文

| 主题 | URL |
|---|---|
| 角色卡 V1 规范 | <https://github.com/malfoyslastname/character-card-spec-v2/blob/main/spec_v1.md> |
| 角色卡 V2 规范 | <https://github.com/malfoyslastname/character-card-spec-v2/blob/main/spec_v2.md> |
| 角色卡 V3 规范（CCv3 / CHARX / Lorebook / decorators / CBS） | <https://github.com/kwaroran/character-card-spec-v3/blob/main/SPEC_V3.md> |

### 8.2 一手：SillyTavern 源码（`release` 分支）与官方文档

| 主题 | URL |
|---|---|
| PNG `chara`/`ccv3` 读写 | <https://github.com/SillyTavern/SillyTavern/blob/release/src/character-card-parser.js> |
| CHARX 解析 | <https://github.com/SillyTavern/SillyTavern/blob/release/src/charx.js> |
| 角色卡字段类型（V1/V2/世界书/正则） | <https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/char-data.js> |
| 角色卡组装/导入/导出（含 Pygmalion、V1、V2/V3、`character_book` 转换） | <https://github.com/SillyTavern/SillyTavern/blob/release/src/endpoints/characters.js> |
| 世界书条目定义、枚举、映射、外部格式转换 | <https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/world-info.js> |
| 世界书服务端校验/读写 | <https://github.com/SillyTavern/SillyTavern/blob/release/src/endpoints/worldinfo.js> |
| 聊天 jsonl 读写与多格式导入 | <https://github.com/SillyTavern/SillyTavern/blob/release/src/endpoints/chats.js> |
| 聊天头部与消息构造 | <https://github.com/SillyTavern/SillyTavern/blob/release/public/script.js>、<https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/chats.js> |
| `send_date` 实现 | <https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/RossAscends-mods.js> |
| 预设管理器（导出/导入/主包/嗅探） | <https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/preset-manager.js> |
| 预设服务端存取 | <https://github.com/SillyTavern/SillyTavern/blob/release/src/endpoints/presets.js> |
| 默认预设与设置文件 | <https://github.com/SillyTavern/SillyTavern/tree/release/default/content/presets>、<https://github.com/SillyTavern/SillyTavern/blob/release/default/content/settings.json> |
| 正则脚本字段/枚举/导入导出 | <https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/extensions/regex/index.js>、<https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/extensions/regex/engine.js> |
| Quick Replies（v2 字段与 v1 迁移） | <https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/extensions/quick-reply/index.js>、<https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/extensions/quick-reply/src/QuickReply.js> |
| 人格导出/结构 | <https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/personas.js> |
| 主题键集 | <https://github.com/SillyTavern/SillyTavern/blob/release/default/content/themes/Azure.json> |
| 世界书官方文档 | <https://docs.sillytavern.app/usage/core-concepts/worldinfo/> |
| 角色设计官方文档 | <https://docs.sillytavern.app/usage/core-concepts/characterdesign/> |
| 正则扩展官方文档 | <https://docs.sillytavern.app/extensions/regex/> |
| 聊天文件管理官方文档 | <https://github.com/SillyTavern/SillyTavern-Docs/blob/main/Usage/Characters/chatfilemanagement.md> |
| 高级格式化/Instruct/上下文模板/推理官方文档 | <https://github.com/SillyTavern/SillyTavern-Docs/blob/main/Usage/Prompts/advancedformatting.md>、<https://github.com/SillyTavern/SillyTavern-Docs/blob/main/Usage/Prompts/instructmode.md>、<https://github.com/SillyTavern/SillyTavern-Docs/blob/main/Usage/Prompts/context-template.md>、<https://github.com/SillyTavern/SillyTavern-Docs/blob/main/Usage/Prompts/reasoning.md> |

### 8.3 一手：其他软件源码/官方文档

| 主题 | URL |
|---|---|
| RisuAI：角色/世界书/聊天类型 | <https://github.com/kwaroran/RisuAI/blob/main/src/ts/storage/database.svelte.ts> |
| RisuAI：卡导入导出、V2/V3 转换、`.charx` | <https://github.com/kwaroran/RisuAI/blob/main/src/ts/characterCards.ts> |
| RisuAI：`.risum` 模块格式 | <https://github.com/kwaroran/RisuAI/blob/main/src/ts/process/modules.ts> |
| Agnai：角色/人格类型 | <https://github.com/agnaistic/agnai/blob/main/common/types/library.ts> |
| Agnai：记忆书类型 | <https://github.com/agnaistic/agnai/blob/main/common/types/memory.ts> |
| Agnai：角色 API（导入导出字段） | <https://github.com/agnaistic/agnai/blob/main/srv/api/character.ts> |
| Agnai：官方角色创建指南（Persona Schema） | <https://agnai.guide/docs/creating-a-character/> |
| Chub：官方角色创建文档 | <https://docs.chub.ai/docs/the-basics/character-creation> |
| Chub：官方提示词/格式文档 | <https://docs.chub.ai/docs/advanced-setups/prompting> |
| JanitorAI：官方 bot 创建指南 | <https://help.janitorai.com/en/article/bot-creation-guide-w-images-by-faylua-8jcbw1/> |
| KoboldAI：世界书条目与 API | <https://github.com/KoboldAI/KoboldAI-Client/blob/main/aiserver.py> |

### 8.4 二手（仅作旁证，不作为实现依据）

- JanitorAI 导出形态与转换：<https://charactercardconverter.com/guides/janitorai-to-sillytavern-guide.html>
- Chub 聊天导出格式说明：<https://thredly.io/save-chub-ai-chats>
- Pygmalion JSON 转换器：<https://charactercardconverter.com/tools/any-to-pygmalion/>

### 8.5 明确「未核实」的条目（实现前请自行验证）

1. 「CCv3 必须同时写一份 V2 投影到 `chara`」——规范原文是 **MAY 回填**，MUST 的说法**未核实**。
2. TavernAI 原始版 `.json` 聊天文件的字段结构（只核实了 ST 能从 ooba/Agnai/CAI/KoboldLite/Risu 导入）。
3. JanitorAI 卡片导出的确切字段名（只有二手来源说它是 V2 PNG/JSON）。
4. Chub 聊天 jsonl 除 `mes`/`swipes` 对象化之外的完整 schema。
5. ST 正则「预设（preset）+ 脚本」是否有一体化导出文件（源码里只看到脚本级导出）。
6. APNG 里是否存在超出规范描述的私有 chunk 用法。
7. RisuAI `encodeRPack` 的具体压缩算法（本文只说明它是「magic 111 + 版本 + 长度 + rpack 载荷」的容器）。

---

## 9. 转换损失速查表

| 来源 → 目标 | 能带过去 | 会丢 |
|---|---|---|
| CCv2 → 你的内部卡 | 全部 V2 字段 + `extensions` | 无（前提是保留未知键） |
| CCv3 → 你的内部卡 | 全部 V2 字段 + `nickname/assets/source/日期/群聊开场白/多语言备注` | 无（前提是保留未知键） |
| CCv3 → 降级成 CCv2 | 文本类字段、`character_book` | `assets`、`nickname`、`group_only_greetings`、`creator_notes_multilingual`、`source`、日期、`use_regex`、所有 decorator |
| ST 世界书 → CCv2 `character_book` | 关键词/内容/开关/顺序 | `position` 的 @D/AN/EM/outlet 精度（塌缩为 before/after）、`scan_depth/token_budget/recursive_scanning`（根本不写） |
| Risu 世界书 → 标准世界书 | 关键词/内容/开关/概率/大小写 | `mode` 分组、`folder` 目录、`loreCache` |
| Agnai 记忆书 → 世界书 | keywords/entry/name | `priority`、`scanDepth/tokenBudget/recursiveScanning` |
| KoboldAI WI → 世界书 | key/keysecondary（切分）、content/comment/selective/constant | `folder` 目录语义（与 `group` 不同义） |
| 任意聊天 → jsonl | 消息文本、角色/用户标记、时间 | swipe、生成参数、附件（ST 官方文档明确说不含图片与附件） |
| ST 预设 → 你的设置 | 采样参数、提示词块顺序 | `reverse_proxy/proxy_password` 等连接级敏感项、`prompt_order` 的 character_id 特化 |

---

## 10. 这套调研能支撑的 10 个最高价值导入能力

> 按「用户手里真有的文件 × 实现成本 × 感知价值」排序。

1. **PNG 角色卡导入（`chara` + `ccv3`，base64/utf-8，优先 ccv3）** —— 生态 90% 的卡都是 PNG。规范一条条都写清楚了，实现成本极低，是所有导入的入口。（<https://github.com/kwaroran/character-card-spec-v3/blob/main/SPEC_V3.md>）
2. **V2/V3 字段全量落地 + `data.extensions` 原样留存** —— 直接决定「中文大卡」里 `depth_prompt`、`regex_scripts`、`world` 有没有效；且保证「导入再导出」不损坏第三方数据（规范强制 MUST NOT destroy）。（spec_v2.md / spec_v3.md）
3. **`data.character_book` 自动转成本地世界书并默认启用** —— 卡自带世界观是"像不像这个角色"的关键；规范要求角色书优先于全局世界书。（spec_v2.md `character_book）
4. **世界书 JSON 导入（`{entries:{...}}` 与 `{entries:[...]}` 双形态 + 外部格式嗅探）** —— 覆盖 ST / CCv2 / NovelAI / Agnai / Risu 五种现实形态；再补一个 KoboldAI 特征判定就能吃下老 Kobold 用户。（world-info.js / endpoints/worldinfo.js）
5. **`.jsonl` 聊天导入导出（首行元数据 + `is_user/is_system/send_date/mes/extra`）** —— 用户迁移时最痛的是「聊天记录能不能带走」；把 `extra` 与 `chat_metadata` 原样留存就能无损往返。（src/endpoints/chats.js）
6. **旧 App 聊天迁移（ooba / Agnai / CAI / KoboldAI Lite / Risu / Chub）** —— ST 已经把判定条件与转换逻辑写全，可以照抄判定顺序：`data_visible` → `messages` → `histories` → `savedsettings` → `type:'risuChat'`。（src/endpoints/chats.js）
7. **多开场白（`alternate_greetings` / `group_only_greetings`）与 swipe 导入** —— 中文卡大量使用副开场白；规范里这是 MUST（swipe）。（spec_v2.md / spec_v3.md）
8. **正则脚本导入（单对象或数组）+ 卡内 `extensions.regex_scripts` 生效** —— 中文卡常见「去除旁白/格式修复」正则，做出来立竿见影；字段只有 12 个，实现极快。（char-data.js `RegexScriptData`）
9. **预设导入：Chat Completion / Text Completion / Instruct / Context / Sysprompt / Reasoning 六类嗅探** —— 用 ST 的 `isPossibly*Data` 判据即可自动识别类型，一次能吃下 ST 生态最常见的分享文件。（preset-manager.js）
10. **CHARX（zip，`card.json` + `embeded://` 资产）导入 + RisuAI 卡兼容** —— 这是 V3 时代的主流分发包，也是唯一能不丢立绘/表情的形态；ST 的 `src/charx.js` 已给出「三种 URI 前缀 + type 分类」的可直接照抄的规则。（SPEC_V3.md / src/charx.js）

**次级但值得排期**：Quick Replies（`label/message` 可用，触发时机需重写）、Persona（`personas_YYYYMMDD.json`）、主题配色（34 键里约一半可映射）、`.risum` 模块（需 rpack 解码，性价比低）、KoboldAI 存档内的世界书（需要用户先在 KoboldAI 里做一次导出）。
