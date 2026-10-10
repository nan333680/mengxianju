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

## 代码约定

- `www/` 是纯前端、**没有构建步骤**，改完直接生效
- 界面文案有几十处断言**直接匹配中文原文**，改一个标点就会打红 —— 动文案前先搜一遍
- `.ps1` 必须存成 **UTF-8 带 BOM**。Windows 自带的 `powershell` 是 5.1，
  读无 BOM 的文件会按 GBK 解码，中文变乱码、引号配对崩，报一串 `Unexpected token`
- `e2e/*.mjs` 用 `path.resolve(import.meta.dirname, '..')` 定位仓库根 —— 它们不在根目录了

## 提交

- 一次改动一个主题，说清"改了什么、为什么"
- 别提交 `releases/`、`tools/local.env`、任何 `*.keystore` / `keystore.properties`

## 更多

- 架构、数据模型、版本与发布规则：[docs/开发记录.md](docs/开发记录.md)
- 每一版改了什么：[CHANGELOG.md](CHANGELOG.md)
