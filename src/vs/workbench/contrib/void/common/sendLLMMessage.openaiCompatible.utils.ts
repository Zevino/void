/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import type { RawToolCallObj, RawToolParamsObj } from './sendLLMMessageTypes.js'

// ------------ OPENAI-COMPATIBLE (PURE HELPERS) ------------
// These helpers are kept free of any SDK imports so they can be unit-tested in isolation.
// They live in the `common` layer so the node-based unit-test runner can pick them up.

/**
 * Parse a user-supplied JSON object string into headers for the OpenAI SDK.
 * - Returns `undefined` when the input is empty/absent.
 * - Throws a readable error when the input is not valid JSON or not an object.
 * - Filters out `null`/`undefined` values (the OpenAI SDK would otherwise serialize them as the string "null").
 */
export const parseHeadersJSON = (s: string | undefined): Record<string, string> | undefined => {
	if (!s) return undefined
	let parsed: unknown
	try {
		parsed = JSON.parse(s)
	} catch (e) {
		throw new Error(`Error parsing OpenAI-Compatible headers: ${s} is not a valid JSON.`)
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw new Error(`Error parsing OpenAI-Compatible headers: ${s} is not a valid JSON object.`)
	}
	return Object.fromEntries(
		Object.entries(parsed as Record<string, unknown>).filter(([, v]) => v != null)
	) as Record<string, string>
}

/**
 * Make sure a user-supplied baseURL ends with `/v1` (a very common omission that otherwise 404s).
 */
export const normalizeV1BaseURL = (baseURL: string) => {
	if (!baseURL) return baseURL
	if (baseURL.endsWith('/v1')) return baseURL
	return baseURL.replace(/\/+$/, '') + '/v1'
}

/**
 * Convert the raw `arguments` string of a tool call into our internal tool-call object.
 * Returns `null` if the arguments aren't valid JSON / not an object.
 */
export const rawToolCallObjOfParamsStr = (name: string, toolParamsStr: string, id: string): RawToolCallObj | null => {
	let input: unknown
	try { input = JSON.parse(toolParamsStr) }
	catch (e) { return null }

	if (input === null) return null
	if (typeof input !== 'object') return null
	// an array is technically an object but is never a valid tool-parameters object
	if (Array.isArray(input)) return null

	const rawParams: RawToolParamsObj = input
	return { id, name, rawParams, doneParams: Object.keys(rawParams), isDone: true }
}

// ---- tool call aggregation ----
// OpenAI streams parallel tool calls with different `index` values, interleaved across chunks.
// We aggregate each index separately — concatenating all indexes into one string would corrupt
// the arguments of every tool call. The "active" tool call is the lowest index seen so far.

export type AccumulatedToolCall = { name: string; id: string; arguments: string }
export type ToolCallDelta = { index: number; id?: string; function?: { name?: string; arguments?: string } }

/**
 * Apply a batch of streaming tool-call deltas to the accumulation map.
 * `activeToolIndex` is the lowest index seen so far across all calls (persisted by the caller).
 * Returns the updated map and the updated active index.
 */
export const aggregateToolCalls = (
	toolCallsByIndex: Map<number, AccumulatedToolCall>,
	deltas: ToolCallDelta[],
	activeToolIndex: number | null = null,
): { toolCallsByIndex: Map<number, AccumulatedToolCall>; activeToolIndex: number | null } => {
	for (const delta of deltas) {
		const existing = toolCallsByIndex.get(delta.index) ?? { name: '', id: '', arguments: '' }
		existing.name += delta.function?.name ?? ''
		existing.arguments += delta.function?.arguments ?? ''
		// the id arrives on the first (non-incremental) chunk of a tool call
		if (delta.id) existing.id = delta.id
		toolCallsByIndex.set(delta.index, existing)
		if (activeToolIndex === null || delta.index < activeToolIndex) activeToolIndex = delta.index
	}
	return { toolCallsByIndex, activeToolIndex }
}
