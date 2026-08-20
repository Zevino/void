/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
import React, { useEffect, useState } from 'react';

import { useChatThreadsState } from '../util/services.js';
import { formatTokenCount, formatCostUsd } from './MessageBubbles.js';
import { IconX } from './ChatInput.js';

// A tiny, muted footer at the bottom of the chat showing the current thread's
// cumulative token usage and estimated cost, e.g. "Session: 12.4k tokens · $0.08".
// Renders "—" when there is no usage data yet.
export const SessionUsageFooter = () => {
	const chatThreadsState = useChatThreadsState()

	// derive the current thread from reactive state so this component re-renders on its own
	const currentThread = chatThreadsState.currentThreadId ? chatThreadsState.allThreads[chatThreadsState.currentThreadId] : undefined
	if (!currentThread) return null

	const usage = currentThread.usage
	const hasUsage = !!usage && (usage.totalTokens > 0 || usage.promptTokens > 0 || usage.completionTokens > 0)

	let text: string
	if (!hasUsage) {
		text = '—'
	} else {
		const total = formatTokenCount(usage.totalTokens)
		const cost = formatCostUsd(usage.estimatedCostUsd)
		const parts: string[] = []
		if (total !== null) parts.push(`Session: ${total} tokens`)
		if (cost !== null) parts.push(cost)
		text = parts.length > 0 ? parts.join(' · ') : '—'
	}

	return (
		<div className='flex justify-end px-4 pb-1 select-none' role="status" aria-live="polite">
			<span className='text-[10px] opacity-60 font-mono text-void-fg-3 whitespace-nowrap'>
				{text}
			</span>
		</div>
	)
}

// A transient, dismissible hint shown when the last message preparation pass
// saved tokens (Optimization C placeholder deletion). Auto-dismisses after ~4s
// or on manual dismiss. Only renders when savings are a positive number.
export const TokenSavingsHint = () => {
	const chatThreadsState = useChatThreadsState()

	// derive the current thread from reactive state so this component re-renders on its own
	const currentThread = chatThreadsState.currentThreadId ? chatThreadsState.allThreads[chatThreadsState.currentThreadId] : undefined
	const savedTokens = currentThread?.lastTokenSavings?.placeholderDeletedTokens

	// local visibility: once shown, allow manual dismiss / auto-dismiss
	const [visible, setVisible] = useState(true)

	// reset visibility whenever a new savings value arrives (a new turn)
	useEffect(() => {
		setVisible(true)
	}, [savedTokens])

	// auto-dismiss after ~4s
	useEffect(() => {
		if (!visible) return
		const t = setTimeout(() => setVisible(false), 4000)
		return () => clearTimeout(t)
	}, [visible, savedTokens])

	if (!currentThread) return null
	if (!savedTokens || savedTokens <= 0) return null
	if (!visible) return null

	const savedStr = formatTokenCount(savedTokens) ?? `${savedTokens}`

	return (
		<div className='flex items-center gap-2 px-4 pb-1 select-none' role="status" aria-live="polite">
			<div className='flex items-center gap-1.5 rounded-full bg-void-bg-1-alt/60 px-2.5 py-0.5 text-[10px] text-void-fg-2 opacity-80'>
				<span className='font-mono'>Saved ~{savedStr} tokens this turn</span>
				<button
					type='button'
					aria-label='Dismiss token savings hint'
					onClick={() => setVisible(false)}
					className='opacity-60 hover:opacity-100 transition-opacity cursor-pointer'
				>
					<IconX size={10} />
				</button>
			</div>
		</div>
	)
}