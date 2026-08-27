# Void — Agent 功能优化建议

> 范围：`src/vs/workbench/contrib/void/browser/chatThreadService.ts`（Agent Loop + 工具执行）、
> `common/prompt/prompts.ts`（工具集与 prompt）、
> `electron-main/llmMessage/extractGrammar.ts`（XML 工具解析）、
> `electron-main/llmMessage/sendLLMMessage.impl.ts`（工具调用下发）。
> 所有引用均为当前真实代码位置。

---

## 一、功能正确性 / 安全性（建议优先修）

### 1. Agent Loop 没有最大步数上限 —— 可能无限循环
- 位置：`chatThreadService.ts:771` `while (shouldSendAnotherMessage)`，循环体内只累加
  `nMessagesSent`（:775），而该计数**仅作为埋点上报**（:910 `capture('Agent Loop Done')`），
  没有任何 `if (nMessagesSent >= MAX) break`。
- 问题：模型一旦进入"工具调用→再调用"的循环（例如重复 `edit_file`、或工具持续报错），
  loop 会一直跑，直到上下文溢出或用户手动中止，**既烧 token 又可能卡死 UI**。
- 建议：引入 `AGENT_MAX_STEPS`（如 25/50，可配置）常量，超阈值时停止并在 UI 提示
  "已达最大步数"。同时建议记录本回合工具调用序列用于诊断。

### 2. 每轮 LLM 只执行**一个**工具调用 —— 与 prompt 自相矛盾
- 位置：`chatThreadService.ts:885` `if (toolCall)`（单值），`onFinalMessage` 只 resolve 一个
  `toolCall`（`RawToolCallObj | undefined`，:818）；
  上游 `extractGrammar.ts:283` 的 XML 解析只累积**单个** `latestToolCall`；
  OpenAI 路径更显式丢弃 `index !== 0`（`sendLLMMessage.impl.ts:349`）。
- 矛盾点：`prompts.ts:400-401` 的 system prompt 明确写
  *"You are allowed to call multiple tools by specifying them consecutively"*，
  但代码实际**永远只执行第一个工具调用**，其余静默丢弃。
- 后果：
  - 无法实现**并行工具调用**（现代 agent 的常见需求）；
  - 模型按 prompt 预期"连发多个工具"时，只有第一个生效，行为与指令不符，调试困难。
- 建议：
  - 短期：把 system prompt 改成"每轮只调用一个工具"，消除误导；
  - 中期：支持**单回合多工具**（聚合 `toolCall[]` + 顺序/并行执行），
    新增 `_runToolCalls(...)` 并批量回灌结果。

### 3. 工具执行失败后 loop 仍继续发下一轮（与 #1 叠加放大风险）
- 位置：`_runToolCall` 在工具失败时返回 `{}`（:706、:721），
  回到 loop 后 `awaitingUserApproval`/`interrupted` 均为 undefined，
  命中 `chatThreadService.ts:894-895` 的 `else { shouldSendAnotherMessage = true }`。
- 问题：工具持续报错（如参数永远不对、MCP 服务挂了）时，
  模型每轮都拿到 tool_error 并重试，**与 #1 一起构成无限重试循环**。
- 建议：对工具失败也加"连续失败次数"上限，或让失败 N 次后停止并提示用户。

### 4. MCP 工具无法真正中断
- 位置：`chatThreadService.ts:689` MCP 分支直接
  `resolveInterruptor(() => { })`（空操作）；
  而内置工具分支有真实 `interruptTool?.()`（:679-680）。
- 问题：用户在 agent 跑 MCP 工具时点"停止"，只会标记状态，**底层 MCP server 的调用不会真正取消**，
  仍可能在后台执行完、甚至回写结果。
- 建议：通过 MCP 的 `cancellationToken` 传播 abort（MCP 协议支持 `CancelledNotification`）。

### 5. `edit_file`/`rewrite_file` 的 checkpoint 在 preapproved 路径被跳过
- 位置：`chatThreadService.ts:639-640` 的 checkpoint 创建在
  `if (!opts.preapproved)` 块内；而 `callThisToolFirst`（自动批准路径，:760）走的是
  `preapproved: true`，**不创建 undo checkpoint**。
- 问题：通过"自动批准"机制执行的文件改写没有历史检查点，用户难以回退。
- 建议：checkpoint 创建与 preapproved 解耦，凡是改文件的工具都建 checkpoint。

---

## 二、架构 / 可维护性

### 6. 工具集与执行通道严重耦合在 `availableTools` + 单值 `toolCall`
- 位置：`prompts.ts:361-378` 按 `chatMode` 决定暴露哪些工具；
  但执行侧（`_runChatAgent`）只认单个工具，导致 `agent` 模式"暴露全部工具 + MCP"
  的能力被单工具执行瓶颈（#2）部分架空。
- 建议：把"工具选择"与"工具执行/聚合"分离，为并行执行预留数据模型
  （`toolCall: RawToolCallObj[]`）。

### 7. 重试逻辑只覆盖 LLM 错误，不含工具/校验错误
- 位置：`chatThreadService.ts:853` `if (nAttempts < CHAT_RETRIES)` 仅在
  `llmError` 分支内；参数校验失败（`invalid_params`，:635）与工具异常（:705）
  都不走重试。
- 问题：瞬时性的工具执行错误没有重试机会，直接变成 tool_error 喂回模型。
- 建议：为工具执行（尤其 IO 类，如 terminal、read_file）加 1-2 次轻量重试。

### 8. 每次迭代都重算并回传整段历史
- 位置：`chatThreadService.ts:779-784` 每轮 `prepareLLMChatMessages` 全量重算
  （消息越多越慢，且工具结果被反复序列化）。
- 问题：agent 多轮累积后呈 O(n²) token 增长，长任务明显变慢变贵。
  （`convertToLLMMessageService.ts:586` 的 `cutOffMessage` 是按条数截断，不解决单条工具结果过大。）
- 建议：对**超长工具结果**（如大文件读取、长终端输出）做截断/摘要；
  考虑缓存 system prompt 与已定稿消息的 tokenization。

---

## 三、测试（延续"void 模块零测试"结论）

### 9. Agent Loop 核心逻辑完全无单测
- 以下易错逻辑均无 `*.test.ts`：
  - 工具调用→继续 / 待审批 / 中断 三种分支（:884-898）；
  - 工具失败后仍继续（#3）与步数上限（#1）；
  - `abortRunning` 在 idle/LLM/tool/awaiting_user 各状态下的消息补全（:557-590）；
  - XML 多工具解析只取首个（extractGrammar.ts:283）。
- 建议：优先补这几个纯逻辑单测，再动行为（#1、#2）。

---

## 改进路线（按投入产出比）

| 优先级 | 项 | 影响 |
|---|---|---|
| 高 | #1 加 `AGENT_MAX_STEPS` 上限 | 防止失控循环/烧钱 |
| 高 | #2 修正"单工具"与 prompt 矛盾 | 行为符合预期 / 为并行铺路 |
| 高 | #3 工具连续失败停止 | 与 #1 共同兜底 |
| 中 | #4 MCP 真正可中断 | 可控性 |
| 中 | #5 preapproved 也建 checkpoint | 可回退 |
| 中 | #8 工具结果截断 + 历史缓存 | 性能/成本 |
| 低 | #6/#7/#9 解耦与测试 | 可维护 |

> 注：以上基于当前代码静态分析，未运行。涉及行为变更（#1、#2、#4）建议先补单测再改。
