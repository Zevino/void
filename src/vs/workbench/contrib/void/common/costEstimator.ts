/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Best-effort USD cost estimation for LLM usage. Prices are rough public-list
// figures from 2025-2026, per *million* tokens, split into input/output.
// These are NOT authoritative — providers change pricing and offer bulk
// discounts, so treat the result as an estimate for visualization only.
// Unknown models return `undefined` (UI shows a dash).

type PriceEntry = {
	// per 1M tokens, USD
	input: number;
	output: number;
}

// ordered longest-first so specific prefixes (e.g. "gpt-4o-mini") win over
// generic ones (e.g. "gpt-4o")
const MODEL_PRICE_TABLE: { prefix: string; price: PriceEntry }[] = [
	// OpenAI GPT-4o family
	{ prefix: 'gpt-4o-mini', price: { input: 0.15, output: 0.60 } },
	{ prefix: 'gpt-4o', price: { input: 2.50, output: 10.00 } },
	// OpenAI reasoning models
	{ prefix: 'o3', price: { input: 2.00, output: 8.00 } },
	{ prefix: 'o1', price: { input: 15.00, output: 60.00 } },
	// Anthropic Claude
	{ prefix: 'claude-3-5-sonnet', price: { input: 3.00, output: 15.00 } },
	{ prefix: 'claude-3-7-sonnet', price: { input: 3.00, output: 15.00 } },
	{ prefix: 'claude-sonnet-4', price: { input: 3.00, output: 15.00 } },
	{ prefix: 'claude-3-5-haiku', price: { input: 0.80, output: 4.00 } },
	{ prefix: 'claude-3-haiku', price: { input: 0.25, output: 1.25 } },
	// Google Gemini
	{ prefix: 'gemini-2.5', price: { input: 1.25, output: 10.00 } },
	{ prefix: 'gemini-2.0', price: { input: 1.25, output: 10.00 } },
	// DeepSeek
	{ prefix: 'deepseek', price: { input: 0.27, output: 1.10 } },
	// Meta Llama (hosted, approx)
	{ prefix: 'llama', price: { input: 0.25, output: 0.25 } },
]

/**
 * Estimate the USD cost of a request given its model name and token counts.
 * Returns `undefined` for unknown models or when no token counts are available.
 */
export const estimateCostUsd = (model: string | undefined, promptTokens: number | undefined, completionTokens: number | undefined): number | undefined => {
	if (!model || (promptTokens === undefined && completionTokens === undefined)) return undefined

	const lower = model.toLowerCase()
	const entry = MODEL_PRICE_TABLE.find(p => lower.startsWith(p.prefix))
	if (!entry) return undefined

	const { input, output } = entry.price
	const cost =
		((promptTokens ?? 0) / 1_000_000) * input +
		((completionTokens ?? 0) / 1_000_000) * output

	return cost > 0 ? cost : undefined
}
