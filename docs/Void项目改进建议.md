# Voidly（Void 派生编辑器）项目改进建议

> 审计日期：2026-08-15
> 审计对象：`C:\Users\a\Desktop\code-enterprise\void`（Voidly，基于 VSCode → Void 的 AI 代码编辑器 fork，由 Zevino 独立维护分发）
> 审计方式：静态扫描（grep / 文件统计 / 配置与文档比对）+ 关键文件人工核查，未修改任何源码

---

## 0. 执行摘要

Voidly 是在 VSCode 基础上二次派生的 AI 编辑器，核心价值集中在 `src/vs/workbench/contrib/void`（以下简称 **void 模块**，64 个 `.ts` 文件、约 2.1 万行）。整体工程结构继承自 VSCode，主框架稳健；但作为"独立分发版"，在**品牌一致性、质量门禁、依赖卫生、void 模块测试、贡献规范**五个维度存在可改进的明确短板。

按优先级排序：

| 优先级 | 问题 | 影响 |
|--------|------|------|
| 高 | void 模块 **0 个单元测试**，且 `.voidrules` 禁止自动校验 | AI 功能回归无法被自动发现 |
| 高 | `package.json` 元数据仍是 **microsoft/vscode**（作者/仓库/issues） | 问题被错误导向微软，分发版归属混乱 |
| 中 | **无 PR/构建 CI**：仅 release / triage 流水线，未接 `core-ci`/`extensions-ci` | 提交未经 lint/test 即合入 |
| 中 | 陈旧/风险依赖：`event-stream`、`husky@0.13.1`、`glob@5`、`rimraf@2`、`mime@1`、TS 预发布版 | 供应链与可复现性风险 |
| 中 | eslint 对 void 模块**放宽规则**（关闭 curly/semi/危险类型断言），与 `.voidrules`"禁止 any"相悖 | 规范自相矛盾，代码质量下滑 |
| 中 | README 仅 1.6KB，贡献规范分散、未对齐 void 模块 | 新贡献者上手成本高 |
| 低 | 构建脚本用脆弱的相对路径 `cd ../../../../../../../` 回退根目录 | 目录结构微调即失效 |
| 低 | 大量上游遗留 TODO（1072 处）与大文件（editorOptions.ts 232KB 等） | 维护负担，建议标注而非立即清理 |

---

## 1. 品牌与元数据漂移（高）

**现象**
- `package.json:2-7`：`"name": "code-oss-dev"`，`"author": "Microsoft Corporation"`，`repository.url` 与 `bugs.url` 均指向 `https://github.com/microsoft/vscode(.git|/issues)`。
- `product.json` 已全面改名为 **Voidly / Zevino**（nameShort、applicationName、win32*、darwinBundleIdentifier `com.zevino.voidly`、licenseUrl 指向 `github.com/Zevino/void`）。
- `README.md:12,29` 自述为 "a personal maintained and distributed fork … by Zevino"，仓库指向 `github.com/Zevino/void`。
- `.voidrules:1` 仍写 "This is a fork of the VSCode repo called **Void**."（而非 Voidly）。

**风险**
- 用户按下"报告问题"会跳到微软 VSCode 的 issues；`bugs` 字段也指向微软，错误反馈流失。
- 分发票据、About 信息、自动更新源归因混乱，存在许可与品牌合规隐患。

**建议**
1. 将 `package.json` 的 `author`、`repository`、`bugs` 改为 Zevino/Voidly 的真实地址（保留 `license: MIT`）。
2. 统一三处命名：`.voidrules` 中 "called Void" 改为 "called Voidly (Zevino)"，与 `product.json`/`README` 一致。
3. 在 `package.json` 增加 `homepage` 与 `void` 专属 `README` 入口。

---

## 2. void 模块测试覆盖缺失（高）

**现象**
- `find src/vs/workbench/contrib/void -name "*.test.ts"` → **0 个测试文件**。
- void 模块含 64 个 `.ts`、约 20,863 行，覆盖 AI 自动补全（`autocompleteService.ts`）、聊天（`chatThreadService.ts`）、上下文收集（`contextGatheringService.ts`）、LLM 消息（`electron-main/llmMessage/`）、React 面板（`browser/react/`）等核心功能——**全部无单测**。
- `.voidrules:16` 明确写："Do not run anything to validate your changes; tell the user what to do instead."——主动放弃自动校验。

**风险**
- AI 功能是产品差异化卖点，却无任何自动化回归保护；改动极易引入静默回归。
- 规则"禁止自动校验"与"高质量分发版"目标直接冲突。

**建议**
1. 在 void 模块新增 `*.test.ts`，优先为纯逻辑单元（prompt 构造、token 计数、上下文裁剪、工具调用解析）补单测，复用 VSCode 现有 `mocha` 测试基建（`test-node` 脚本）。
2. 将 `.voidrules:16` 改为"改动后须运行 `npm run test-node` 中 void 相关用例"，或至少在 CI 中强制。
3. 为 LLM 调用路径补充 mock provider 的集成测试，避免依赖真实 API key。

---

## 3. 缺少 PR / 构建 CI 质量门禁（中）

**现象**
- `.github/workflows/` 仅 `release.yml`（tag 触发，构建 Windows x64 安装包）与 `triage.yml`（ issue 分流）。
- `package.json` 中存在 `core-ci`/`core-ci-pr`/`extensions-ci`/`extensions-ci-pr`/`hygiene`/`eslint` 等脚本，但**未在任何 GitHub Action 中调用**。
- 没有在 PR 上跑 lint / 类型检查 / 单测的门禁。

**风险**
- 提交可未经任何自动化检查合入，已存在的 `hygiene`（代码风格）、`valid-layers-check`（分层）、`tsec-compile-check`（类型）等能力被闲置。

**建议**
1. 新增 `.github/workflows/ci.yml`：`push`/`pull_request` 到 `main` 时依次运行 `npm run hygiene`、`npm run eslint`、`npm run compile`（或 `core-ci-pr`）、`npm run test-node`。
2. 将 `core-ci`/`extensions-ci` 接入 CI，确保分层与类型契约不被破坏。
3. 对 void 模块至少要求"类型检查通过"。

---

## 4. 依赖卫生与供应链风险（中）

**现象（`package.json`）**
- `devDependencies` 含 **`event-stream@3.3.4`**：该包已停止维护，历史上有著名的供应链投毒事件（恶意代码经由 `flatmap-stream` 注入 3.3.6）。虽 3.3.4 本身未受污染，但属于应避免的废弃依赖。
- **`husky@^0.13.1`**：2016 年的古董版本（当前为 9.x），且仓库内**无 `.husky` 目录或钩子配置**，`precommit` 脚本（`node build/hygiene.js`）实际不生效。
- 老旧 dev 依赖：`glob@^5.0.13`（2015）、`rimraf@^2.2.8`（2017）、`mime@^1.4.1`（1.x 已废弃）、`source-map-support@^0.3.2`、`util@^0.12.4`。
- **`minimist` 重复声明**：同时出现在 `dependencies` 与 `devDependencies`（均为 `^1.2.6`）。
- **TypeScript 锁到预发布版**：`typescript@^5.8.0-dev.20250207`——使用 insider/开发版，影响构建可复现性。

**风险**
- 废弃/预发布依赖降低可复现性与供应链安全性；重复依赖增加体积与歧义。

**建议**
1. 移除 `event-stream`（确认是否被某构建脚本实际引用；若无则删除，若有则用现代替代如 `rxjs`/`observable` 或 VSCode 自带工具）。
2. 升级或移除 `husky`：若要用 pre-commit，升级到 `^9` 并初始化 `.husky`；否则删除 `husky` 与 `precommit` 脚本，避免"看似有钩子实则无"。
3. 将 `glob`→`^10`、`rimraf`→`^5`、`mime`→`^3`、`minimist` 去重（仅保留一处）。
4. 将 TypeScript 固定到稳定版 `5.8.x`（去掉 `-dev` 预发布标签），并用 `package-lock.json` 锁版本。

---

## 5. ESLint 规则对 void 模块放宽，与贡献规范矛盾（中）

**现象（`eslint.config.js`）**
- `:43` `'curly': 'off'`、`eslint.config.js:144` 注释 "this should only apply to workbench/void/"、`eslint.config.js:46,86,144` 对 void 关闭 `code-no-dangerous-type-assertions`、`@stylistic/ts/semi: 'off'` 等。
- 但 `.voidrules:8` 明确要求："NEVER lazily cast to 'any'. Find the correct type to apply and use it."

**风险**
- 规则文件要求不用 `any`/危险断言，eslint 却对 void 模块关闭了对应守卫，规范自相矛盾，容易让 void 代码质量劣化（与第 2 节"禁止自动校验"叠加）。

**建议**
1. 统一口径：要么在 `.voidrules` 中说明"因历史原因暂时放宽，新代码仍禁用 any"，要么恢复 void 模块的危险类型断言检查。
2. 对 void 模块新增针对性 eslint 规则覆盖（如禁止 `as any`、要求 `bOfA` 命名约定已在 `.voidrules:14` 约定，可加 lint 规则强制）。

---

## 6. 文档与贡献者上手（中）

**现象**
- `README.md` 仅 **1.6KB**，绝大部分是外链（Repository / Project Board），缺乏本地构建、开发、void 模块架构说明。
- `VOID_CODEBASE_GUIDE.md`（9.9KB）与 `HOW_TO_CONTRIBUTE.md`（8.2KB）内容较好，但**面向上游 VSCode 派生流程**，未体现 void 模块约定（React 面板构建靠 `buildreact` 脚本、`.voidrules` 的特殊要求）。
- 真实贡献规范 `.voidrules` 藏在仓库根目录，未被 README/CONTRIBUTE 引用。

**建议**
1. README 补充：本地构建步骤（`npm install` → `npm run compile` → `./scripts/code.sh`）、void 模块位置与职责、如何运行 void 测试。
2. 在 `HOW_TO_CONTRIBUTE.md` 增加"void 模块开发"小节，引用 `.voidrules` 与 `buildreact`/`watchreact` 用法。
3. 将 `.voidrules` 链接进 README 的"Contributing"段。

---

## 7. 构建脚本脆弱性（低）

**现象（`package.json:13-14`）**
```json
"buildreact": "cd ./src/vs/workbench/contrib/void/browser/react/ && node build.js && cd ../../../../../../../",
"watchreact": "cd ./src/vs/workbench/contrib.../react/ && node build.js --watch && cd ../../../../../../../"
```
用 7 层相对路径 `cd ../../../../../../../` 回退到仓库根，目录层级一旦变化即失效，且可读性差。

**建议**
- 改为基于 `INIT_CWD` 或绝对路径：`"buildreact": "node src/vs/workbench/contrib/void/browser/react/build.js"`，或用 `npm pkg`/脚本内 `process.cwd()` 解析，去掉脆弱的相对回退。

---

## 8. 上游遗留技术债（低，建议标注而非立即清理）

**现象**
- 排除 `node_modules` 后，`src` + `extensions` 仍有 **1072 处** `TODO/FIXME/HACK/XXX`；void 模块自身 31 处。
- 超大单文件（多为上游 VSCode 继承）：`src/vs/editor/common/config/editorOptions.ts` 232KB、`abstractTaskService.ts` 149KB、`extensionsActions.ts` 146KB 等。

**说明**
- 这些是 VSCode 上游固有结构，fork 不应贸然重构；但建议在 void 模块内对 31 处 TODO 做优先级标注，区分"上游同步待办"与"void 自身待办"。

---

## 9. 安全扫描（低，未发现硬编码密钥）

- 对 `src/vs/workbench/contrib/void` 做轻量密钥扫描（`api_key`/`secret`/`password`/`sk-...`），仅命中合法的 token 变量名（如 `autocompleteService.ts` 的 `Token` 类型），**未发现硬编码密钥或泄露的 `sk-` 凭证**。
- 注意：`node-pty` 等原生模块与 LLM provider key 在运行时处理，建议在文档中明确"密钥仅经 `product.json`/设置项注入，绝不入库"。

---

## 10. 推荐的改进路线（按投入产出比）

| 顺序 | 动作 | 工作量 | 收益 |
|------|------|--------|------|
| 1 | 修正 `package.json` 品牌元数据 + 统一命名 | 低 | 高（合规/归因） |
| 2 | void 模块补核心逻辑单测 + 放开自动校验 | 中 | 高（防回归） |
| 3 | 接入 PR CI（lint+类型+单测门禁） | 中 | 高（质量门禁） |
| 4 | 清理风险/陈旧依赖（event-stream、husky、glob/rimraf/mime、TS 预发布） | 低-中 | 中（供应链） |
| 5 | 统一 ESLint 与 `.voidrules` 口径 | 低 | 中（规范一致） |
| 6 | 充实 README + 贡献指南对齐 void 模块 | 低 | 中（上手效率） |
| 7 | 加固 `buildreact` 路径、标注上游 TODO | 低 | 低-中（稳健性） |

---

## 附：证据采集命令（可复现）

```bash
# TODO 密度（排除 node_modules）
grep -rnoE "\b(TODO|FIXME|HACK|XXX)\b" src extensions --exclude-dir=node_modules | wc -l   # 1072
grep -rnoE "\b(TODO|FIXME|HACK|XXX)\b" src/vs/workbench/contrib/void | wc -l                 # 31

# void 模块规模与测试
find src/vs/workbench/contrib/void -name "*.ts" | wc -l                                    # 64
find src/vs/workbench/contrib/void -name "*.test.ts" | wc -l                              # 0

# 大文件 TOP
find src -name "*.ts" -printf "%s %p\n" | sort -rn | head -15

# CI 流程
ls .github/workflows                                                                      # release.yml, triage.yml

# 品牌元数据
grep -nE '"(name|author|repository|bugs)"' package.json
```
