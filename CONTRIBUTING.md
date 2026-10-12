# 参与开发

## 环境

- **Node.js 20+** —— 跑测试用
- **JDK 21 + Android SDK** —— 打 APK 用。这两个路径不写死在仓库里，
  在 `tools/local.env` 里写一行 `JAVA_HOME=...` / `ANDROID_HOME=...` 即可（该文件不进版本库）。

## 改完要做什么

1. 先跑相关的几套：`pwsh -File tools/run-regression.ps1 -Only "e2e-mem*.mjs"`
2. 动了界面或行为，就补一条 `e2e-*.mjs` 断言 —— 光说"我测过了"不算
3. 提交前跑全量：`pwsh -File tools/run-regression.ps1`（串行，约半小时）

**测试必须串行。** 每套自己起一个静态服务器和一个 Chrome 实例，
并发跑会互相抢，报出来的是随机假失败。

### ⚠️ 新克隆下来有 11 套跑不了，这是预期的

`_fixtures/` **不在版本库里**（被 `.gitignore` 排除）—— 里面有一份真实的个人备份
（聊天记录）和若干同人素材，不适合公开。所以依赖它的 **11 套**会失败：

```
e2e-cardio  e2e-import  e2e-importchars  e2e-settings  e2e-stpreset
e2e-stworldbook  e2e-test2  e2e-wbentryio  e2e-wbimport  e2e-wbtouhou  e2e-ziworldbook
```

其余 **110 套**不依赖它，克隆后可以直接跑。要在本地补齐这 11 套，就在仓库根建一个
`_fixtures/`，按套件里实际读到的文件名放你自己的样本（每个套件顶部的注释写了它要什么形状）。

判断一次失败是不是这个原因：看报错里有没有 `ENOENT` 和 `_fixtures` 路径。

### 读源码来断言：用 `readCode`，不要直接 `fs.readFileSync`

有一批断言是"读 `app.js` 的文本，看某个片段在不在"。它们的问题不是写法，
是**被断言的东西**：源码文本里既有代码也有注释，而这个仓库注释密度很高 ——
改一句注释就能让断言变红、把代码挪走却还是绿的。
**能被一次无意义重构搞成假绿的测试，比没有测试更危险。**

所以读的那一刻就把注释剥掉：

```js
import { readCode } from './e2e-src.mjs';
const SRC = readCode(WWW + '/js/app.js');   // 注释已经被剥掉了
```

`e2e-src.mjs` 自带一个保守的 JS 词法剥离器（字符串和正则字面量里的 `//` 不会误伤）。
新写的套件请一律用它；老套件还在陆续切过来。

### CI

`.github/workflows/ci.yml` 跑两件事：静态检查（**只认语法错**）+ **14 套不依赖任何 key 的 e2e**。

- 全量回归需要真实模型的 key（`DSH_API_KEY`），**不进 CI**
- 类型噪音目前稳定在 28 条（全是 `Element` / 动态键那一类），
  `tools/ci-check.mjs` 里记着基线；涨了会打一行警告，但不拦
- GitHub 的 windows 镜像自带 Chrome，路径正好是各套件里写死的那个

## 代码约定

- `www/` 是纯前端、**没有构建步骤**，改完直接生效
- 界面文案有几十处断言**直接匹配中文原文**，改一个标点就会打红 —— 动文案前先搜一遍
- 跨 `try` 边界用到的变量**一律在函数顶部 `let` 声明**。`app.js` 的 `send()` 里有两个顺序的
  `try`，而 `catch` 看不到 `try` 块里的 `const`/`let` —— 这个坑在同一个函数里踩过三次
  （`_cmd0` / `clockSnapshot` / v0.4.0 的 `speaker`）。症状是"回复被整个回滚删掉"或者
  抛一个盖住真错的 `ReferenceError`
- `.ps1` 必须存成 **UTF-8 带 BOM**。Windows 自带的 `powershell` 是 5.1，
  读无 BOM 的文件会按 GBK 解码，中文变乱码、引号配对崩，报一串 `Unexpected token`
- `e2e/*.mjs` 用 `path.resolve(import.meta.dirname, '..')` 定位仓库根 —— 它们不在根目录了

## 提交

- 一次改动一个主题，说清"改了什么、为什么"
- 别提交 `releases/`、`tools/local.env`、任何 `*.keystore` / `keystore.properties`

## 更多

- 架构、数据模型、版本与发布规则：[docs/开发记录.md](docs/开发记录.md)
- 每一版改了什么：[CHANGELOG.md](CHANGELOG.md)
