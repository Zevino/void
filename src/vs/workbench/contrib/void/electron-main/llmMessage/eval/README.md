# LLM Agent Eval Harness

A headless harness for comparing how different LLM providers/models drive Void's
**agent** (tool calling + loop decisions). It reuses the **real** production code —
`sendLLMMessage` (provider SDKs, streaming, native tool calls), `extractGrammar`
(XML tool parsing), and `availableTools`/`builtinTools` (tool set) — so eval results
reflect actual behavior, not a re-implementation.

## Why

Void's agent loop lets the model call tools repeatedly until it answers. Different
models differ wildly in:
- **tool-call reliability** (do they invent tools / malformed params?),
- **step efficiency** (do they read once or thrash?),
- **final-answer quality** (do they actually complete the task?).

This harness lets you measure that objectively across providers/models with one
command, and produces a JSON report you can diff over time.

## Layout

| file | purpose |
|---|---|
| `types.ts` | config / result / report types |
| `runAgent.ts` | the headless agent loop (mirrors production decision logic) |
| `taskRegistry.ts` | sample tasks + an in-memory mock tool executor (no side effects) |
| `runEval.ts` | CLI runner: models × tasks → JSON report + summary table |
| `eval.config.example.json` | sample model config |

## Usage

1. **Build** the TypeScript once (`npm run compile`), which emits to `out/`.
2. Copy the example config and fill in real API keys (use `env:VAR` to avoid secrets):

```bash
cp eval.config.example.json eval.config.json
# edit eval.config.json
```

3. Run the harness:

```bash
node ./out/vs/workbench/contrib/void/electron-main/llmMessage/eval/runEval.js \
  --config ./eval.config.json \
  --out ./eval-report.json \
  --tasks read-index,edit-file
```

If `--tasks` is omitted, every task in the registry runs. `--out` defaults to
`./eval-report.json`.

## Config format

```jsonc
[
  {
    "id": "deepseek",                 // short label used in the report
    "providerName": "deepseek",       // must be a Void ProviderName
    "modelName": "deepseek-chat",     // model id at the provider
    "apiKey": "env:DEEPSEEK_API_KEY"  // literal key, or "env:NAME"
    // optional: "endpoint": "https://..."  (only for endpoint-based providers)
  }
]
```

## Writing tasks

Add tasks to `taskRegistry.ts`. A task is:

- `prompt`: the user prompt sent to the agent.
- `executeTool`: a mock executor (recommended — deterministic, no side effects).
- `score`: optional; given the tool calls + final answer, return `{ pass, reason }`.
  If omitted, a run passes iff it produced a non-empty final answer without
  exhausting steps.

The built-in mock executor (`makeMockExecutor`) provides `read_file`, `ls_dir`,
`search_for_files`, `edit_file`, `rewrite_file`, `run_command`, `get_git_status`
against an in-memory file map — ideal for pure LLM tool-call comparisons.

## Exit code

The CLI exits `0` if every run passed, `1` if any failed or errored — handy for CI
gates.
