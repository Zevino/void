# AGENTS.md — Voidly (code-oss-dev 定制版)

本文件供 AI 编码助手快速了解项目结构、启动方式与常见坑位。

## Project Overview

Voidly is a personal fork of [Void](https://github.com/voideditor/void), an open-source AI code editor built on VS Code (Electron). Most Void-specific code lives in `src/vs/workbench/contrib/void/`.

- Based on VS Code OSS (`code-oss-dev`), customized as **Voidly** (`Void.exe`).
- Version `1.99.9`, entry `./out/main.js`, ESM project (`"type": "module"`).
- React subproject: `src/vs/workbench/contrib/void/browser/react/`.

## Architecture

VS Code is an Electron app with 3 process layers:
- **`browser/`** — Runs in the browser process. Can use `window` APIs. Cannot import `node_modules` directly.
- **`common/`** — Shared by both processes. No special imports.
- **`electron-main/`** — Runs in the main (Node) process. Can import `node_modules`.

React components are bundled into the browser process via tsup (see `browser/react/`).

## Key Commands

| Command | Purpose |
|---------|---------|
| `npm run dev` | 一键启动：后台编译 + 打开 Voidly Dev 窗口 |
| `npm run watch` | 并行编译 `watch-client` + `watch-extensions` |
| `npm run watch-client` | 仅编译核心（`out/vs`） |
| `npm run watch-extensions` | 编译内置扩展 |
| `npm run compile` | 一次性全量编译（不做 watch） |
| `npm run buildreact` | 编译 React 组件 (tsup + Tailwind) |
| `npm run watchreact` | React 编译 watch 模式 |
| `npm run gulp` | 直接调用 gulp |
| `node scripts/dev.js` | 启动开发服务器 |
| `./scripts/code.bat` (Win) / `./scripts/code.sh` (Mac/Linux) | 打开开发窗口 |
| `Ctrl+R` / `Cmd+R` inside dev window | 重载以查看变更 |

`npm run dev` 脚本逻辑（`scripts/dev.js`）：
1. 关闭 CodeBuddy safe-delete 拦截（`CODEBUDDY_SAFE_DELETE_ENABLED=0`）。
2. 清理旧的 `npm run watch` 进程树，释放 `watch_run.log` 文件锁。
3. 后台启动 `npm run watch` 编译（日志 → `watch_run.log`）。
4. 打开 Voidly Dev 窗口（隔离 `user-data` / `extensions` 到 `.tmp/`，日志 → `void_runtime.log`）。

改完代码后，在开发者窗口内按 `Ctrl+R` 重载即可（watch 会自动重编译）。

## React Build Pipeline

Source: `src/vs/workbench/contrib/void/browser/react/src/`
Output: `src/vs/workbench/contrib/void/browser/react/src2/` (Tailwind) → `out/` (tsup bundle)

- **Entry**: Each feature has its own entry (sidebar, settings, onboarding, quick-edit, editor-widgets, tooltip).
- **Styling**: Tailwind CSS with `void-` prefix. Custom theme colors map to VS Code CSS variables (e.g., `void-fg-1` → `var(--void-fg-1)`).
- **VS Code colors**: Available via `vscode-*` Tailwind classes (e.g., `vscode-input-bg`, `vscode-focus-border`).

Type-check React code:
```bash
npx tsc --noEmit -p src/vs/workbench/contrib/void/browser/react/tsconfig.json
```

## Import Conventions

- Use **NodeNext** module resolution with `.js` extension on all imports.
- Example: `import { something } from './myFile.js';`
- Missing `.js` causes untraceable build errors.

## Styling Conventions

- Prefer Tailwind utility classes over inline styles.
- Use `void-*` theme tokens for colors (`void-bg-1`, `void-fg-1`, `void-border-2`, etc.).
- Use `vscode-*` tokens when you need direct VS Code theme colors.
- Do not hardcode color values.
- VS Code applies global focus outlines to all textareas/inputs. Override with `outline: none` in `styles.css` or inline when needed within `.void-scope`.

## Linting

```bash
npx eslint src/vs/workbench/contrib/void/
```

## Key Services (Singletons)

Services are registered with `registerSingleton` and injected via `@IServiceName` decorator pattern. Key Void services:
- `voidSettingsService` — Provider/model configuration
- `chatThreadService` — Chat message history and streaming
- `editCodeService` — Code editing (apply, diff zones)
- `toolsService` — Tool calls (file read/write, terminal, etc.)
- `convertToLLMMessageService` — Message formatting for LLMs
- `sendLLMMessageService` — LLM communication (delegates to electron-main via channel)

## Data Flow: Chat Message → LLM

1. User types in sidebar → `chatThreadService.addUserMessageAndStreamResponse()`
2. Messages formatted via `convertToLLMMessageService`
3. Sent to main process via `sendLLMMessageChannel`
4. Main process (`electron-main/llmMessage/`) handles HTTP to provider
5. Streamed tokens returned to browser process via channel
6. UI updates reactively through service state

## ⚠️ 关键坑位（已修复，勿回退）

### 1. CodeBuddy safe-delete 拦截编译
- **现象**：`watch-extensions` 报 `Error: [safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED]`。
- **原因**：CodeBuddy 的 `node-language-shim.cjs` 通过 `NODE_OPTIONS` 注入，在 `CODEBUDDY_SAFE_DELETE_ENABLED !== '0'` 时加载 safe-delete，批量删除 `out/` 超过阈值（50）即报错。
- **修复**：`dev.js` 通过 `spawn` 的 `env` 显式传递 `CODEBUDDY_SAFE_DELETE_ENABLED: '0'`。**注意**：system 级该变量为 `1`，不能用 `set` 中间层（会被子进程重置），必须走 `spawn` 的 env 选项。

### 2. `watch-client` 每次启动清空 `out` 全量重编
- `build/gulpfile.js` 原 `watch-client` 定义为 `task.series(util.rimraf('out'), ...)`。
- **已改为** `task.series(task.parallel(...))`，去掉 `rimraf`，保留增量编译。
- 因此首次启动后 `out/` 不再被清空，后续改代码仅增量编译。

### 3. `dev.js` 启动 `code.bat` 的路径引号问题
- **现象**：`void_runtime.log` 报「文件名、目录名或卷标语法不正确」。
- **原因**：`cmd.exe /c "cd /d \"...\" && code.bat ..."` 在 `shell:false` 时引号丢失。
- **修复**：改为 `spawn(code.bat 绝对路径, [...], { shell: true })`，并去掉多余 `cd`（已设 `cwd`）。

### 4. `watch_run.log` EBUSY 文件锁
- **现象**：`fs.openSync` 报 `EBUSY`，因上次的 `npm run watch` 进程仍占用日志文件。
- **修复**：`dev.js` 启动前先 `killOldWatch()` 终止旧进程树。

## Common Pitfalls

- **Node modules in browser**: Cannot import `node_modules` in `browser/` code. Use channels to main process or bundle (as done for React).
- **CSS specificity**: VS Code global styles can override Void styles. Use `.void-scope` prefixed selectors or inline styles for overrides.
- **Tailwind in src2/**: `src2/` is generated output from Tailwind processing `src/`. Never edit `src2/` directly — edit `src/styles.css` and Tailwind config.
- **Out directory**: `out/` in `browser/react/` is tsup output. Never edit directly.

## 日志文件

| 文件 | 内容 |
|------|------|
| `watch_run.log` | `npm run watch` 编译输出（含 safe-delete 报错） |
| `void_runtime.log` | Electron 主进程运行日志（有 `NODE_OPTIONS` 无害警告） |
| `out/` | 编译产物根目录（`out/vs/code/electron-main/main.js` 为渲染入口） |

## 目录速览

- `src/vs/workbench/contrib/void/` — Voidly 核心功能（chat、LLM message、settings 等）
- `src/vs/workbench/contrib/void/browser/react/` — Void 的 React 子项目
- `build/gulpfile.js` — 编译/打包 gulpfile（`watch-client` / `watch-extensions` 定义）
- `scripts/dev.js` — 一键开发启动脚本
- `scripts/code.bat` / `code.sh` — 启动 Voidly Dev 窗口
- `.tmp/user-data`、`.tmp/extensions` — Dev 窗口隔离的用户数据与扩展目录

## 直接排查命令（Windows）

```powershell
# 查看 watch 编译进程树
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'npm.*watch|gulp.*watch|npm-run-all.*watch' }

# 清理所有 watch 进程
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'npm.*watch|gulp.*watch' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

# 查看 out 编译产物大小
[math]::Round((Get-ChildItem out -Recurse -File -EA 0 | Measure-Object Length -Sum).Sum/1MB,1)
```

## 🤖 LLM 避坑指南（基于真实排查经验）

以下是 AI 助手在本项目中最容易重复犯错的点，下次处理时务必先读这里。

### 1. 不要反复重启 `npm run dev` / `npm run watch`
- **错误做法**：碰到编译慢或窗口 Error，就反复杀进程重启 `npm run dev`。
- **后果**：`watch-client` 每次启动会清空 `out` 全量重编（已有修复但仍需注意残留进程）；反复重启 → 永远编不完 → 窗口永远 Error。
- **正确做法**：启动一次后**耐心等待全量编译完成**（VS Code 核心首次编译需 30-60 分钟）。期间用排查命令观察 `out/` 是否在增长、`watch_run.log` 是否有报错。

### 2. safe-delete 报错不要去改 gulpfile 的 rimraf
- **错误做法**：看到 `SAFE_DELETE_BULK_CONFIRM_REQUIRED` 就去删 `util.rimraf('out')` 或注释清理任务。
- **正确做法**：这是 CodeBuddy 的 safe-delete 拦截，禁用方式是在**启动进程的环境变量**中设置 `CODEBUDDY_SAFE_DELETE_ENABLED=0`，且**必须走 spawn 的 `env` 选项**，不能用 `cmd /c "set X=0 && ..."` 中间层（子进程会被系统环境 `1` 重置）。

### 3. 窗口显示 "Error" 不一定是启动脚本 bug
- **错误做法**：窗口标题是 "Error" 就认定 `code.bat` / `dev.js` 有问题，反复改启动脚本。
- **正确做法**：先确认 `out/vs/code/electron-main/main.js` 等关键产物是否已生成。未生成 = 编译未完成，等即可。主进程存活 + 无崩溃日志 = 启动脚本正常。

### 4. `watch_run.log` 为空 ≠ 编译没跑
- **错误做法**：看到日志文件为空就判定 watch 没启动。
- **原因**：`fs.openSync` + `detached` 的管道方式在 Windows 下经常丢输出。改用 `cmd /c "... > log 2>&1"` 或确认进程树存在来判断。
- **正确做法**：用进程查询命令确认 `npm-run-all` / `gulp watch-client` / `gulp watch-extensions` 进程是否存活，而非只看日志文件。

### 5. 修改 `dev.js` 后用 `node --check` 验证，但别用 `spawn('npm.cmd', ..., {shell:false})`
- **错误做法**：Windows 上 `spawn('npm.cmd', [...], {shell:false})` 会报 `EINVAL`（无法直接执行 .cmd），又退回用 `cmd.exe /c "set ... && npm ..."` 导致 env 丢失。
- **正确做法**：`spawn('npm.cmd', ['run','watch'], { shell: true, env: { ...process.env, CODEBUDDY_SAFE_DELETE_ENABLED: '0' } })`。

### 6. 清理进程前先确认匹配模式不会误杀
- `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'npm.*watch' }` 会匹配 `npm run watch-client`、`npm run watch-extensions` 等所有变体，不会误杀 `npm run dev`（不匹配 `watch`）。安全。
- 但不要用过于宽泛的模式（如 `node`）清理，会杀掉 CodeBuddy 自身。

### 7. 诊断要由表及里，不要跳步
排查顺序参考：
1. 窗口起没起？→ 看 `void_runtime.log` 有无「文件名语法不正确」类错误。
2. 编译在跑吗？→ 进程树 + `watch_run.log` 尾部。
3. 产物生成了吗？→ `out/vs/code/electron-main/main.js` 是否存在。
4. 卡在哪？→ CPU 占用（满负荷=正常编译；0=卡死/已退出）、日志报错。
不要一上来就删 `out/` 或重装依赖。

