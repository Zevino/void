/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// LLM agent eval harness — types.
//
// This is a HEADLESS eval harness for comparing how different LLM providers/models
// drive Void's agent (tool calling + loop decisions). It is intentionally free of
// editor/UI dependencies so it can run from a plain node/electron script.
//
// It reuses the REAL sendLLMMessage (provider SDKs + streaming + native tool calls),
// REAL extractGrammar (XML tool parsing) and REAL availableTools/builtinTools (tool set),
// so eval results reflect production behavior rather than a re-implementation.

import { ModelSelection, ProviderName, SettingsOfProvider } from '../../../common/voidSettingsTypes.js';
import { InternalToolInfo } from '../../../common/prompt/prompts.js';

/** A single tool the model decided to call during a run. */
export type EvalToolCall = {
	name: string;
	params: Record<string, unknown>;
	/** index of the agent round (0-based) in which this tool was requested */
	step: number;
	/** whether the executor reported success */
	ok: boolean;
	result: string;
	/** how long the tool execution took (ms) */
	ms: number;
};

/** One evaluation task the model must solve using tools. */
export type EvalTask = {
	id: string;
	description: string;
	/** initial user prompt sent to the agent */
	prompt: string;
	/** optional tools injected for this task (mock/real), merged with builtins */
	tools?: InternalToolInfo[];
	/**
	 * A custom tool executor. Maps toolName -> async ({ params }) => result string.
	 * If omitted, a default executor resolves against `tools` with a stub result.
	 * Return `{ ok: false, result }` to simulate a tool failure.
	 */
	executeTool?: (toolName: string, params: Record<string, unknown>) => Promise<{ ok: boolean; result: string }>;
	/**
	 * Optional scorer. Given the transcript + final answer, decide pass/fail.
	 * If omitted, the harness marks the run as pass if it ended with a final
	 * assistant answer that is non-empty and did not run out of steps.
	 */
	score?: (ctx: EvalScoreContext) => EvalScore;
};

export type EvalScoreContext = {
	task: EvalTask;
	toolCalls: EvalToolCall[];
	/** the last assistant text produced (the "final answer") */
	finalAnswer: string;
	fullTranscript: { role: 'user' | 'assistant' | 'tool'; content: string }[];
	stoppedReason: 'done' | 'max_steps' | 'consecutive_tool_failures' | 'error';
	steps: number;
};

export type EvalScore = { pass: boolean; reason: string };

/** The LLM "subject" being evaluated. */
export type EvalModel = {
	id: string;
	providerName: ProviderName;
	modelName: string;
	/** settings for the provider (apiKey/endpoint/etc). Usually loaded from env/CLI. */
	settingsOfProvider: SettingsOfProvider;
	modelSelectionOptions?: import('../../../common/voidSettingsTypes.js').ModelSelectionOptions;
};

/** Per-run result captured by the harness. */
export type EvalRunResult = {
	taskId: string;
	modelId: string;
	startedAt: string;
	finishedAt: string;
	durationMs: number;
	steps: number;
	stoppedReason: EvalScoreContext['stoppedReason'];
	pass: boolean;
	scoreReason: string;
	toolCalls: EvalToolCall[];
	toolCallCount: number;
	/** distinct tools used, e.g. ['read_file','edit_file'] */
	toolsUsed: string[];
	finalAnswer: string;
	transcript: EvalScoreContext['fullTranscript'];
	error?: string;
};

export type EvalReport = {
	runAt: string;
	tasks: string[];
	models: { id: string; providerName: string; modelName: string }[];
	results: EvalRunResult[];
};

/** A minimal metrics shim — sendLLMMessage expects an IMetricsService. */
export type MetricsLike = { capture: (event: string, data?: Record<string, unknown>) => void };

/** Helper to build a ModelSelection for a given model config. */
export const modelSelectionOf = (m: EvalModel): ModelSelection => ({
	providerName: m.providerName,
	modelName: m.modelName,
});
