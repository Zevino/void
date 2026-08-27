# Void — OpenAI-Compatible 功能优化建议

> 范围：`src/vs/workbench/contrib/void/electron-main/llmMessage/sendLLMMessage.impl.ts`  
> 与 `src/vs/workbench/contrib/void/common/modelCapabilities.ts` 中"OpenAI 兼容"路径  
> （覆盖 provider：openAI、openAICompatible、ollama、vLLM、liteLLM、lmStudio、  
> openRouter、deepseek、groq、xAI、mistral、googleVertex、microsoftAzure、awsBedrock）。  
> 所有引用均为当前真实代码位置。

---

## 一、功能正确性 / 兼容性（建议优先修）

### 1. 从不下发 `max_tokens` / `max_completion_tokens`

- 位置：`sendLLMMessage.impl.ts:310`（`// max_completion_tokens: maxTokens` 被注释），  
  `_sendOpenAICompatibleChat`（:273）整个函数未调用 `getReservedOutputTokenSpace`。
- 问题：
  - 对 **o1 / o3 类推理模型是硬伤**——它们忽略 `max_tokens`、要求 `max_completion_tokens`，  
    否则可能被服务端拒绝或默认截断，用户设置的"预留输出空间"完全不生效。
  - `getReservedOutputTokenSpace`（:19 已导入）在 OpenAI 兼容路径是 **死代码**，  
    `getModelCapabilities` 算出的 `reservedOutputTokenSpace` 没被消费。
- 建议：在 `_sendOpenAICompatibleChat` 中按语境下发——  
  推理模型（参考 `reasoningCapabilities`）用 `max_completion_tokens`，  
  其余用 `max_tokens`；值取自 `getReservedOutputTokenSpace(...)`。

### 2. 工具调用只认 `index === 0`，并行调用被丢弃

- 位置：`sendLLMMessage.impl.ts:347-354`
  ```ts
  for (const tool of chunk.choices[0]?.delta?.tool_calls ?? []) {
      const index = tool.index
      if (index !== 0) continue   // ← 直接跳过
  ```
- 问题：OpenAI 流式协议里**并行工具调用**会用不同 `index` 下发多个 `tool_call`。  
  当前实现 `continue` 跳过非 0，导致 agent 模式下的多工具并行调用静默丢失，只认第一个。
- 建议：改成按 `index` 聚合（`Map<number, {name, arguments, id}>`），流结束后合并。

### 3. 通用 provider 的 reasoning 输出字段写死 `reasoning_content`

- 位置：通用 `openaiCompatible` 在 `modelCapabilities.ts:1246-1254` 写  
  `output: { nameOfFieldInDelta: 'reasoning_content' }`。
- 问题：OpenAI-compatible 后端千差万别——
  - DeepSeek 用 `reasoning_content`（“幸运”命中）；
  - OpenAI 官方 `o1`/`o3` 不返回增量 reasoning 字段；
  - QwQ、Groq、OpenRouter 用 `reasoning` 或需请求里带 `include_reasoning` / `reasoning_format`。  
    通用 provider 无法正确解析绝大多数后端的推理内容。
- 建议：在 `openAICompatible` 设置里提供"reasoning 字段名"可配置项（或预设几类），  
  而非全局假设 `reasoning_content`。

### 4. `openAICompatible` 不支持模型列表，但同类 provider 支持

- 位置：`sendLLMMessageToProviderImplementation.openAICompatible.list = null`（:891）；  
  而 vLLM（:901）、lmStudio（:918）同样是 OpenAI 兼容却绑定了 `_openaiCompatibleList`。
- 问题：既然是 OpenAI-compatible，`/v1/models` 是标准端点，通用 provider 本应默认支持 list，  
  否则用户每次都得手填模型名，体验差于"同级"的 vLLM/lmStudio。
- 建议：把 `openAICompatible.list` 也绑定为 `_openaiCompatibleList`  
  （或在 baseURL 不含标准路径时给出友好降级提示）。

### 5. `baseURL` 未做 `/v1` 归一化（仅 awsBedrock 做了）

- 位置：`openAICompatible` 分支直接用 `...baseURL: thisConfig.endpoint`（:156），无归一化；  
  对比 awsBedrock（:142-143）会强制补 `/v1`。
- 问题：用户若填 `https://x.com`（漏掉 `/v1`）会直接 404，没有提示。
- 建议：对所有自定义 endpoint 的 provider 统一做"以 `/v1` 结尾"的归一化工具函数。

---

## 二、架构 / 可维护性（重构类）

### 6. `newOpenAICompatibleSDK` 是巨型 if/else 链

- 位置：`sendLLMMessage.impl.ts:72-171`（约 100 行，13+ 个分支）。
- 问题：大量重复 `new OpenAI({ baseURL, apiKey: 'noop', ...commonPayloadOpts })`，  
  新增 provider 要改函数、改 `CallFnOfProvider`、改设置类型，散落多处，易漏。
- 建议：抽成**配置表驱动**——
  ```ts
  const OAI_PROVIDER_CONFIG: Record<ProviderName, {
      baseURL: (c) => string; apiKeyField?: keyof Settings; keyFallback?: string;
      defaultHeaders?: (c) => Record<string,string>;
  }> = { ... }
  ```
  函数退化为"读表 → `new OpenAI(...)`"，新增 provider 只加一条配置。

### 7. `sendLLMMessageToProviderImplementation` 同样庞大且重复

- 位置：`sendLLMMessage.impl.ts:857-941`。
- 问题：13 个 provider 显式各写一遍 `{ sendChat, sendFIM, list }`，  
  其中 11 个的 `sendChat` 都是 `(p) => _sendOpenAICompatibleChat(p)`。
- 建议：配合第 6 点的配置表，用循环/工厂生成该对象，减少样板。

### 8. `headersJSON` 解析时机错误

- 位置：`parseHeadersJSON`（:63-70）在请求时（`newOpenAICompatibleSDK` 内，:155）解析并抛错。
- 问题：用户在设置页填错 JSON，要等到真正发请求才报错，且错误信息直接抛到 `onError` 链路。
- 建议：在设置保存时（schema/表单校验）就解析校验，请求路径不再 try/catch 解析。

---

## 三、健壮性 / 安全

### 9. 硬编码 `apiKey: 'noop'`

- 位置：`ollama`/`vLLM`/`liteLLM`/`lmStudio` 分支（:83,87,91,95 等）。
- 问题：部分自建网关会校验非空 key，`'noop'` 可能被拒；语义也不清晰。
- 建议：本地/可选 key 的 provider 允许 `apiKey` 为空串或省略，不强制 `'noop'`。

### 10. `defaultHeaders` 可能接收 null/undefined

- 位置：`parseHeadersJSON` 返回 `Record<string, string | null | undefined>`（:64），  
  直接当作 OpenAI `defaultHeaders`（:156）。
- 问题：OpenAI SDK 的 `defaultHeaders` 类型是 `Record<string, string>`，  
  null 值会被序列化成字符串 `"null"` 或导致 header 异常。
- 建议：解析后 `Object.fromEntries(Object.entries(h).filter(([,v]) => v != null))` 过滤。

### 11. 无超时 / 无重试 / 部分路径无 abort

- 位置：`newOpenAICompatibleSDK`（:72）未传 `timeout` / `maxRetries`；  
  `_setAborter` 仅 chat 流用了 `response.controller.abort()`（:339），  
  list 等调用没有 abort 路径。
- 问题：本地优先编辑器在网络抖动/模型服务卡死时，请求会长时间挂起、无重试。
- 建议：客户端统一加 `timeout`（如 60s）+ `maxRetries`（1-2 次）；  
  为 list 提供独立的超时/取消。

### 12. `additionalOpenAIPayload` 被双重 spread

- 位置：先合并进 `includeInPayload`（:287-290），又在 `options` 里再 spread 一次（:309）。
- 问题：若 payload 含 `max_completion_tokens` / 推理字段，两处顺序决定最终值，  
  可读性差、易踩坑（尤其和第 1 点一起改时）。
- 建议：合并成单一来源，避免重复展开。

---

## 四、测试（延续上一轮"void 模块零测试"结论）

### 13. 核心转换逻辑完全无单测

- 位置：整段 `_sendOpenAICompatibleChat`、工具聚合、reasoning 字段解析、`parseHeadersJSON`、  
  `_openaiCompatibleList` 分页均无 `*.test.ts`。
- 建议优先补单测的易错点：
  - 工具调用按 index 聚合（#2）；
  - `headersJSON` 解析与 null 过滤（#8、#10）；
  - reasoning 字段名可配置解析（#3）；
  - list 分页 `hasNextPage` 循环（:411-413）。

---

## 改进路线（按投入产出比）

| 优先级 | 项                                      | 影响               |
| --- | -------------------------------------- | ---------------- |
| 高   | #1 下发 max_tokens/max_completion_tokens | 推理模型直接可用         |
| 高   | #2 工具 index 聚合                         | agent 多工具不丢      |
| 高   | #13 补单测                                | 防止回归             |
| 中   | #3 reasoning 字段可配置                     | 通用 provider 推理可见 |
| 中   | #4/#5 list 与 /v1 归一化                   | 体验一致             |
| 中   | #6/#7 表驱动重构                            | 可维护性             |
| 低   | #8/#9/#10/#11/#12 健壮性与清理               | 稳定性              |



> 注：以上基于当前代码静态分析，未运行。涉及行为变更（#1、#2、#3）建议先补单测再改。
