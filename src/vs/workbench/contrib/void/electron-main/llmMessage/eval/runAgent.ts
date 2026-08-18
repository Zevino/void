/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Headless agent loop for the eval harness. Mirrors the production agent loop's
// decision logic (call tools → feed results → repeat until done / max steps), but
// without editor/UI/stream-state dependencies, so it runs from a plain node/electron
// script against the REAL sendLLMMessage + extractGrammar.

import { sendLLMMessage } from '../sendLLMMessage.js';
import { extractXMLToolsWrapper } from '../extractGrammar.js';
import { availableTools } from '../../../common/prompt/prompts.js';
import {
	LLMChatMessage,
	OnText,
	RawToolCallObj,
} from '../../../common/sendLLMMessageTypes.js';
import { getModelCapabilities } from '../../../common/modelCapabilities.js';
import { IMetricsService } from '../../../common/metricsService.js';
import {
	EvalModel,
	EvalRunResult,
	EvalTask,
	EvalToolCall,
	modelSelectionOf,
} from './types.js';

// Mirror the production agent guards so eval behavior matches the real agent.
const AGENT_MAX_STEPS = 25;
const AGENT_MAX_CONSECUTIVE_TOOL_FAILURES = 5;

type SimpleMessage =
	| { role: 'user'; content: string }
	| { role: 'assistant'; content: string }
	| { role: 'tool'; name: string; id: string; params: Record<string, unknown>; content: string };

type RunOpts = {
	task: EvalTask;
	model: EvalModel;
	metrics: IMetricsService;
};

/**
 * A lightweight XML tool wrapper is unnecessary here: we feed the model a plain
 * user prompt and a system message that lists available tools. Whether the model
 * calls tools natively (openai/anthropic-style) or via XML, the harness reuses the
 * SAME extractGrammar wrapper the production loop uses, so XML parsing is exercised
 * for real. (Native tool formats are parsed inside sendLLMMessage for anthropic/openai.)
 */
export const runEvalTask = async (opts: RunOpts): Promise<EvalRunResult> => {
	const { task, model, metrics } = opts;
	const startedAt = new Date();
	const startedMs = Date.now();

	const mcpTools = task.tools;
	const tools = availableTools('agent', mcpTools);
	const toolNames = new Set((tools ?? []).map(t => t.name));

	const { specialToolFormat } = getModelCapabilities(model.providerName, model.modelName, undefined);

	// ---- accumulate the transcript (what the model "sees") ----
	// We keep a running LLM chat history and re-prepare it each round, exactly like
	// the production loop. To keep it simple and deterministic, we track the transcript
	// as SimpleMessage[] and convert to LLMChatMessage[] per round.
	const transcript: SimpleMessage[] = [];

	// ---- result accumulators ----
	const toolCalls: EvalToolCall[] = [];
	let finalAnswer = '';
	let error: string | undefined;
	let stoppedReason: EvalRunResult['stoppedReason'] = 'done';

	// default tool executor: resolves mock tools with a stub result
	const defaultExecuteTool = async (toolName: string, params: Record<string, unknown>) => {
		if (task.executeTool) return task.executeTool(toolName, params);
		return { ok: true, result: `[${toolName} executed ok${Object.keys(params).length ? ` with ${JSON.stringify(params)}` : ''}]` };
	};

	const runTool = async (call: RawToolCallObj): Promise<void> => {
		const toolName = call.name;
		const params = call.rawParams as unknown as Record<string, unknown>;
		const t0 = Date.now();
		let ok = true;
		let result = '';
		try {
			const res = await defaultExecuteTool(toolName, params);
			ok = res.ok;
			result = res.result;
		} catch (e) {
			ok = false;
			result = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
		}
		const ms = Date.now() - t0;
		toolCalls.push({ name: toolName, params, step: toolCalls.length, ok, result, ms });
		transcript.push({ role: 'tool', name: toolName, id: call.id, params, content: result });
	};

	// the system message: describes role + available tools. Reuses real tool defs.
	const systemMessage = `You are an expert coding agent in an automated evaluation.
You will be given a task. Use the available tools to accomplish it, then produce a concise final answer describing what you did.

Available tools:
${(tools ?? []).map(t => `- ${t.name}: ${t.description}`).join('\n')}

Rules:
- Call tools as needed. You may call multiple tools in a single round.
- After gathering enough info, produce your final answer as normal text.
- Do not ask the user questions. Do your best autonomously.`;

	// Build the LLM message list. For special tool formats (openai/anthropic/gemini),
	// send native tool definitions. For XML (no special format), the system prompt lists
	// tools and extractGrammar parses the XML output.
	const buildMessages = (): { messages: LLMChatMessage[]; separateSystemMessage: string | undefined } => {
		// convert transcript (SimpleMessage[]) -> a first-order LLM history.
		const llmMessages: LLMChatMessage[] = [];
		for (const m of transcript) {
			if (m.role === 'user') llmMessages.push({ role: 'user', content: m.content });
			else if (m.role === 'assistant') llmMessages.push({ role: 'assistant', content: m.content, anthropicReasoning: null } as LLMChatMessage);
			else if (m.role === 'tool') {
				// represent tool calls + results as a user message containing the result,
				// plus (for native formats) the assistant tool_call marker. For eval
				// purposes a faithful-enough representation is fine: the point is to
				// exercise the real LLM tool-calling path and real parsing.
				llmMessages.push({
					role: 'user',
					content: `<${m.name}>\n${m.content}\n</${m.name}>`,
				} as LLMChatMessage);
			}
		}
		return { messages: llmMessages, separateSystemMessage: systemMessage };
	};

	let shouldSendAnotherMessage = true;
	let steps = 0;
	let consecutiveToolFailures = 0;

	while (shouldSendAnotherMessage) {
		shouldSendAnotherMessage = false;
		steps += 1;

		if (steps > AGENT_MAX_STEPS) {
			stoppedReason = 'max_steps';
			break;
		}

		const { messages, separateSystemMessage } = buildMessages();
		// push the task prompt as the first user message on the first round
		if (transcript.length === 0) {
			transcript.push({ role: 'user', content: task.prompt });
		}

		// if there are no messages yet, add the prompt
		const effectiveMessages = messages.length === 0
			? [{ role: 'user' as const, content: task.prompt } as LLMChatMessage]
			: messages;

		// per-round text/tool output
		let roundText = '';
		let roundToolCalls: RawToolCallObj[] | undefined;

		// wrap with XML parser when no native tool format, matching production.
		let onTextInner: OnText = (p) => { roundText = p.fullText; };
		let onFinalInner: (p: { fullText: string; fullReasoning: string; toolCall?: RawToolCallObj[]; anthropicReasoning: unknown[] | null }) => void = (p) => {
			roundText = p.fullText;
			roundToolCalls = p.toolCall;
		};

		if (!specialToolFormat) {
			const wrapped = extractXMLToolsWrapper(onTextInner, onFinalInner as never, 'agent', mcpTools);
			onTextInner = wrapped.newOnText;
			onFinalInner = wrapped.newOnFinalMessage as typeof onFinalInner;
		}

		await new Promise<void>((resolve) => {
			const abortRef = { current: null as (() => void) | null };
			sendLLMMessage(
				{
					messagesType: 'chatMessages',
					messages: effectiveMessages,
					separateSystemMessage,
					chatMode: 'agent',
					settingsOfProvider: model.settingsOfProvider,
					modelSelection: modelSelectionOf(model),
					modelSelectionOptions: model.modelSelectionOptions,
					overridesOfModel: undefined,
					mcpTools,
					onText: onTextInner,
					onFinalMessage: onFinalInner as never,
					onError: ({ message }) => { error = message; resolve(); },
					logging: { loggingName: `Eval - ${model.id} - ${task.id}`, loggingExtras: { taskId: task.id, modelId: model.id, step: steps } },
					abortRef,
				},
				metrics,
			).finally(() => resolve());
		});

		if (error) { stoppedReason = 'error'; break; }

		// record assistant text (if any)
		if (roundText) {
			finalAnswer = roundText;
			transcript.push({ role: 'assistant', content: roundText });
		}

		// execute requested tool calls
		const calls = roundToolCalls ?? [];
		if (calls.length === 0) {
			// model produced a final answer — done
			stoppedReason = 'done';
			break;
		}

		for (const call of calls) {
			// guard: model shouldn't invent tools not in the set
			if (!toolNames.has(call.name)) {
				transcript.push({
					role: 'tool',
					name: call.name,
					id: call.id,
					params: call.rawParams as unknown as Record<string, unknown>,
					content: `Unknown tool "${call.name}". Only use: ${[...toolNames].join(', ')}.`,
				});
				consecutiveToolFailures += 1;
				continue;
			}
			await runTool(call);
			// track failures
			const last = toolCalls[toolCalls.length - 1];
			if (last && !last.ok) {
				consecutiveToolFailures += 1;
				if (consecutiveToolFailures >= AGENT_MAX_CONSECUTIVE_TOOL_FAILURES) {
					stoppedReason = 'consecutive_tool_failures';
					break;
				}
			} else {
				consecutiveToolFailures = 0;
			}
		}
		if (stoppedReason === 'consecutive_tool_failures') break;

		// after tools ran, loop again to let the model react to results
		shouldSendAnotherMessage = true;
	}

	// ---- score ----
	const scoreCtx = {
		task,
		toolCalls,
		finalAnswer,
		fullTranscript: transcript.map(m => ({ role: m.role as 'user' | 'assistant' | 'tool', content: m.content })),
		stoppedReason,
		steps,
	};

	let pass: boolean;
	let scoreReason: string;
	if (task.score) {
		const s = task.score(scoreCtx);
		pass = s.pass;
		scoreReason = s.reason;
	} else {
		pass = stoppedReason === 'done' && finalAnswer.trim().length > 0;
		scoreReason = pass ? 'produced a final answer' : `stopped: ${stoppedReason}`;
	}

	const finishedAt = new Date();
	return {
		taskId: task.id,
		modelId: model.id,
		startedAt: startedAt.toISOString(),
		finishedAt: finishedAt.toISOString(),
		durationMs: Date.now() - startedMs,
		steps,
		stoppedReason,
		pass,
		scoreReason,
		toolCalls,
		toolCallCount: toolCalls.length,
		toolsUsed: [...new Set(toolCalls.map(t => t.name))],
		finalAnswer,
		transcript: scoreCtx.fullTranscript,
		error,
	};
};
