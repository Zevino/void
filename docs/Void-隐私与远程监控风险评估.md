# Void — 隐私与远程监控风险评估

> 评估对象：`src/vs/workbench/contrib/void`（Void 的 AI 模块）
> 方法：静态审查所有外部网络出口、遥测采集点、剪贴板/键盘/屏幕/文件监视迹象。
> 结论先行：**未发现隐蔽监控或隐私外泄通道**；遥测在上游被强制关闭；
> 唯一真正"离机"的数据流是**你主动配置的 LLM 请求**（代码/文件内容发往所选模型供应商）。

---

## 一、外部网络出口（全量盘点）

在整个 void 模块中，真实会发起网络请求的目标只有三类：

| 出口 | 位置 | 发送内容 | 是否离机敏感数据 |
|---|---|---|---|
| LLM 供应商 API | `sendLLMMessage.impl.ts`（openai/anthropic/deepseek/openrouter/groq/xAI/mistral/googleVertex/azure/bedrock/ollama/vLLM/lmStudio/liteLLM 等） | 你的代码、打开的文件、工作区结构、对话与工具结果 | **是（按你配置的供应商）** |
| GitHub 更新检查 | `voidUpdateMainService.ts:98` `fetch('https://api.github.com/repos/voideditor/binaries/releases/latest')` | 仅请求最新 release 的 `tag_name` | 否（仅暴露 IP + "运行 Void"，标准更新检查） |
| PostHog 遥测 | `metricsMainService.ts:91-93` `host: 'https://us.i.posthog.com'` | **实际不发送**（见下） | 否 |

未发现 WebSocket、裸 `http/https` 模块直连、隐藏 `child_process` 回传、`deviceId`/MAC/定位采集等任何隐蔽通道。
`child_process` 仅用于 `voidSCMMainService.ts`（执行 git 命令）与 React 构建脚本，均非监控。

---

## 二、遥测（PostHog）—— 已被强制关闭（好消息）

代码里确实接入了 PostHog（`posthog-node`，真实 project key `phc_...`），但关键点在于它被**主动禁用**：

- `metricsMainService.ts:129-131`：`capture` 方法是**空实现**
  ```ts
  capture: IMetricsService['capture'] = (event, params) => {
    // Do nothing to prevent any event capturing
  }
  ```
- `metricsMainService.ts:122-123`：`initialize()` 里强制 `this.client.optOut()` 并打印
  `Force opting out of all Void metrics for privacy.`
- 因此全代码约 50 处 `metricsService.capture(...)` 调用（diff 接受/拒绝、Agent Loop 次数、
  复制代码长度、执行 shell 长度等）**全部无效**。

附加观察：
- 采集字段均为**使用计数**，不含代码正文、文件路径、对话文本、密钥
  （如 `{ length: codeStr.length }` 只发长度、`{ nMessagesSent, chatMode }` 只发次数）。
- 每 15 分钟有一次 `Alive` 心跳轮询（`metricsPollService.ts:39-42`，`PING_EVERY_MS = 15*60*1000`），
  但它同样调用的是空 `capture`，**不联网**。
- 机器 ID（`distinctId`/`userId`）仍会在本地生成并存入 `.vscdb`，但**不会外发**。

> 结论：**当前构建不会向 PostHog 发送任何数据。** 这是改动后刻意关闭的结果，属于隐私友好状态。

---

## 三、没有发现"监控类"代码

针对用户最担心的几类行为，逐一排查结果：

- **键盘记录 / 全局快捷键监控**：无。capture 里的 `keyboard: true` 只是"该事件由键盘触发"的标记位，不是按键采集。
- **剪贴板窃取**：无。`IClipboardService` 仅在复制代码时**写入**剪贴板（`fileService.ts:68`）。
- **屏幕截图 / 录屏**：无。`screen`/`screenshot` 命中项均为 React 内部 `Offscreen` 组件，与监控无关。
- **文件监视后上传**：无。没有 `fs.watch` 把本地文件偷偷回传的逻辑。
- **隐藏 C2 / 心跳回传**：无（心跳只有 PostHog，已关闭）。

---

## 四、真正需要注意的隐私点（按设计，但需知晓）

以下不是"漏洞"，而是 AI 编辑器品类的固有数据流向，但建议用户明确知情：

1. **代码/文件内容会发往你所选的 LLM 供应商**
   - chat / agent / gather / autocomplete / FIM 都会把光标上下文、打开文件、工作区目录结构、
     终端输出、对话内容发送给配置的模型端点。
   - 用云端供应商（OpenAI / Anthropic / DeepSeek / OpenRouter / Groq / xAI / Mistral / Google）时，
     **内容离开本机，受对应厂商隐私条款约束**。
   - 用本地供应商（Ollama / vLLM / lmStudio / 本地 LiteLLM）或自建 `openAICompatible` 端点时，
     数据留在本地/你控制的服务器。

2. **发往 LLM 前没有密钥脱敏**
   - agent/gather 会读取工作区文件并塞进 prompt。若仓库里含 `.env`、凭证、私钥等，
     **这些明文可能随 prompt 发往模型供应商**。
   - 当前代码**没有发送前的密钥扫描/脱敏**。这是 AI 编码工具的通病，但值得在文档里提醒用户。

3. **OpenRouter 请求带 Void 标识头**
   - `sendLLMMessage.impl.ts:103-104` 给 OpenRouter 请求附加
     `HTTP-Referer: 'https://voideditor.com'` 与 `X-Title: 'Void'`，
     仅用于 OpenRouter 排行榜，不含代码内容，影响极小。

4. **更新检查暴露运行信息给 GitHub**
   - 每次检查更新会向 `api.github.com` 发请求，GitHub 侧可见你的 IP 与"该 IP 运行 Void"。

---

## 五、改进建议（透明化 / 加固）

| 项 | 建议 |
|---|---|
| 死代码清理 | 移除已禁用的 PostHog 客户端初始化、`Alive` 心跳定时器、本地机器 ID 生成——避免"看似关闭实则残留"的审计困惑，也防止未来被误改启用。 |
| 让用户真正可控 | 若保留遥测，应做成真实开关（当前 `setOptOut` 存了 key 但 `capture` 是硬空实现，UI 开关是摆设）。 |
| 隐私说明 | 在 README / 设置页明确写出"代码会发往所选 LLM 供应商""更新检查会访问 GitHub"。 |
| 密钥脱敏 | 在发送 prompt 前对 `.env`/凭据类内容做简单的忽略或脱敏提示（尤其 agent/gather 读文件时）。 |
| 更新检查可关 | 更新检查应可配置关闭，并明示其网络行为。 |

---

## 总评

- **隐蔽远程监控风险：无。**
- **隐私外泄风险：仅来自你主动使用的 LLM 功能**（按设计、可控），外加一个无内容的 GitHub 更新检查。
- **遥测：已强制关闭，当前不发送任何数据。**

> 注：以上为静态代码分析结论；运行期行为建议用网络抓包（如 Wireshark / mitmproxy）最终确认一次。
