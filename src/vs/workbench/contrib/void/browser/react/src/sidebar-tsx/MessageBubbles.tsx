/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
import React, { KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';

import { useAccessor, useChatThreadsStreamState, useFullChatThreadsStreamState } from '../util/services.js';
import { ChatMarkdownRender, ChatMessageLocation } from '../markdown/ChatMarkdownRender.js';
import { ChatMessage, CheckpointEntry, StagingSelectionItem } from '../../../../common/chatThreadServiceTypes.js';
import { IsRunningType } from '../../../chatThreadService.js';
import ErrorBoundary from './ErrorBoundary.js';
import { VoidChatArea, SelectedFiles, IconLoading } from './ChatInput.js';
import { VoidInputBox2, TextAreaFns } from '../util/inputs.js';
import { ToolHeaderWrapper, ToolChildrenWrapper, InvalidTool, CanceledTool, MCPToolWrapper, builtinToolNameToComponent, ResultWrapper, ToolRequestAcceptRejectButtons, recordToolStart, SmallProseWrapper, ToolCallTimeline, ToolCallTimelineItem } from './ToolMessages.js';
import { Pencil, X, Copy, Check, RotateCw, MessagesSquare } from 'lucide-react';
import { isABuiltinToolName } from '../../../../common/prompt/prompts.js';
import { ToolName } from '../../../../common/toolsServiceTypes.js';
const UserMessageComponent = ({ chatMessage, messageIdx, isCheckpointGhost, currCheckpointIdx, _scrollToBottom }: { chatMessage: ChatMessage & { role: 'user' }, messageIdx: number, currCheckpointIdx: number | undefined, isCheckpointGhost: boolean, _scrollToBottom: (() => void) | null }) => {

	const accessor = useAccessor()
	const chatThreadsService = accessor.get('IChatThreadService')

	// global state
	let isBeingEdited = false
	let stagingSelections: StagingSelectionItem[] = []
	let setIsBeingEdited = (_: boolean) => { }
	let setStagingSelections = (_: StagingSelectionItem[]) => { }

	if (messageIdx !== undefined) {
		const _state = chatThreadsService.getCurrentMessageState(messageIdx)
		isBeingEdited = _state.isBeingEdited
		stagingSelections = _state.stagingSelections
		setIsBeingEdited = (v) => chatThreadsService.setCurrentMessageState(messageIdx, { isBeingEdited: v })
		setStagingSelections = (s) => chatThreadsService.setCurrentMessageState(messageIdx, { stagingSelections: s })
	}


	// local state
	const mode: ChatBubbleMode = isBeingEdited ? 'edit' : 'display'
	const [isFocused, setIsFocused] = useState(false)
	const [isHovered, setIsHovered] = useState(false)
	const [isDisabled, setIsDisabled] = useState(false)
	const [textAreaRefState, setTextAreaRef] = useState<HTMLTextAreaElement | null>(null)
	const textAreaFnsRef = useRef<TextAreaFns | null>(null)
	// initialize on first render, and when edit was just enabled
	const _mustInitialize = useRef(true)
	const _justEnabledEdit = useRef(false)
	useEffect(() => {
		const canInitialize = mode === 'edit' && textAreaRefState
		const shouldInitialize = _justEnabledEdit.current || _mustInitialize.current
		if (canInitialize && shouldInitialize) {
			setStagingSelections(
				(chatMessage.selections || []).map(s => { // quick hack so we dont have to do anything more
					if (s.type === 'File') return { ...s, state: { ...s.state, wasAddedAsCurrentFile: false, } }
					else return s
				})
			)

			if (textAreaFnsRef.current)
				textAreaFnsRef.current.setValue(chatMessage.displayContent || '')

			textAreaRefState.focus();

			_justEnabledEdit.current = false
			_mustInitialize.current = false
		}

	}, [chatMessage, mode, _justEnabledEdit, textAreaRefState, textAreaFnsRef.current, _justEnabledEdit.current, _mustInitialize.current])

	const onOpenEdit = () => {
		setIsBeingEdited(true)
		chatThreadsService.setCurrentlyFocusedMessageIdx(messageIdx)
		_justEnabledEdit.current = true
	}
	const onCloseEdit = () => {
		setIsFocused(false)
		setIsHovered(false)
		setIsBeingEdited(false)
		chatThreadsService.setCurrentlyFocusedMessageIdx(undefined)

	}

	const EditSymbol = mode === 'display' ? Pencil : X


	let chatbubbleContents: React.ReactNode
	if (mode === 'display') {
		chatbubbleContents = <>
			<SelectedFiles type='past' messageIdx={messageIdx} selections={chatMessage.selections || []} />
			<span className='px-0.5'>{chatMessage.displayContent}</span>
		</>
	}
	else if (mode === 'edit') {

		const onSubmit = async () => {

			if (isDisabled) return;
			if (!textAreaRefState) return;
			if (messageIdx === undefined) return;

			// cancel any streams on this thread
			const threadId = chatThreadsService.state.currentThreadId

			await chatThreadsService.abortRunning(threadId)

			// update state
			setIsBeingEdited(false)
			chatThreadsService.setCurrentlyFocusedMessageIdx(undefined)

			// stream the edit
			const userMessage = textAreaRefState.value;
			try {
				await chatThreadsService.editUserMessageAndStreamResponse({ userMessage, messageIdx, threadId })
			} catch (e) {
				console.error('Error while editing message:', e)
			}
			await chatThreadsService.focusCurrentChat()
			requestAnimationFrame(() => _scrollToBottom?.())
		}

		const onAbort = async () => {
			const threadId = chatThreadsService.state.currentThreadId
			await chatThreadsService.abortRunning(threadId)
		}

		const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
			if (e.key === 'Escape') {
				onCloseEdit()
			}
			if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
				onSubmit()
			}
		}

		if (!chatMessage.content) { // don't show if empty and not loading (if loading, want to show).
			return null
		}

		chatbubbleContents = <VoidChatArea
			featureName='Chat'
			onSubmit={onSubmit}
			onAbort={onAbort}
			isStreaming={false}
			isDisabled={isDisabled}
			showSelections={true}
			showProspectiveSelections={false}
			selections={stagingSelections}
			setSelections={setStagingSelections}
		>
			<VoidInputBox2
				enableAtToMention
				ref={setTextAreaRef}
				className='min-h-[81px] max-h-[500px] px-0.5'
				placeholder="Edit your message..."
				onChangeText={(text) => setIsDisabled(!text)}
				onFocus={() => {
					setIsFocused(true)
					chatThreadsService.setCurrentlyFocusedMessageIdx(messageIdx);
				}}
				onBlur={() => {
					setIsFocused(false)
				}}
				onKeyDown={onKeyDown}
				fnsRef={textAreaFnsRef}
				multiline={true}
			/>
		</VoidChatArea>
	}

	const isMsgAfterCheckpoint = currCheckpointIdx !== undefined && currCheckpointIdx === messageIdx - 1

	return <div
		// align chatbubble accoridng to role
		className={`
        relative ml-auto group
        ${mode === 'edit' ? 'w-full max-w-full'
				: mode === 'display' ? `self-end w-fit max-w-full whitespace-pre-wrap` : '' // user words should be pre
			}

        ${isCheckpointGhost && !isMsgAfterCheckpoint ? 'opacity-50 pointer-events-none' : ''}
    `}
		onMouseEnter={() => setIsHovered(true)}
		onMouseLeave={() => setIsHovered(false)}
	>
		<div
			// style chatbubble according to role
			className={`
            text-left rounded-lg max-w-full
            ${mode === 'edit' ? ''
					: mode === 'display' ? 'p-2 flex flex-col bg-void-bg-1 text-void-fg-1 overflow-x-auto cursor-pointer' : ''
				}
        `}
			onClick={() => { if (mode === 'display') { onOpenEdit() } }}
			{...(mode === 'display' ? {
				role: 'button',
				tabIndex: 0,
				'aria-label': 'Edit message',
				onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => {
					if (e.key === 'Enter' || e.key === ' ') {
						e.preventDefault();
						onOpenEdit();
					}
				},
			} : {})}
		>
			{chatbubbleContents}
		</div>



		<div
			className="absolute -top-1 -right-1 translate-x-0 -translate-y-0 z-1"
		// data-tooltip-id='void-tooltip'
		// data-tooltip-content='Edit message'
		// data-tooltip-place='left'
		>
			<EditSymbol
				size={18}
				role="button"
				tabIndex={0}
				aria-label={mode === 'display' ? 'Edit message' : 'Close edit'}
				className={`
                    cursor-pointer
                    p-[2px]
                    bg-void-bg-1 border border-void-border-1 rounded-md
                    transition-opacity duration-200 ease-in-out
                    ${isHovered || (isFocused && mode === 'edit') ? 'opacity-100' : 'opacity-0'}
                    group-focus-within:opacity-100
                `}
				onClick={() => {
					if (mode === 'display') {
						onOpenEdit()
					} else if (mode === 'edit') {
						onCloseEdit()
					}
				}}
				onKeyDown={(e) => {
					if (e.key === 'Enter' || e.key === ' ') {
						e.preventDefault();
						if (mode === 'display') {
							onOpenEdit()
						} else if (mode === 'edit') {
							onCloseEdit()
						}
					}
				}}
			/>
		</div>


	</div>

}
export const ProseWrapper = ({ children }: { children: React.ReactNode }) => {
	return <div className='
text-void-fg-2
prose
prose-sm
break-words
prose-p:block
prose-hr:my-4
prose-pre:my-2
marker:text-inherit
prose-ol:list-outside
prose-ol:list-decimal
prose-ul:list-outside
prose-ul:list-disc
prose-li:my-0
prose-code:before:content-none
prose-code:after:content-none
prose-headings:prose-sm
prose-headings:font-bold

prose-p:leading-normal
prose-ol:leading-normal
prose-ul:leading-normal

max-w-none
'
	>
		{children}
	</div>
}
// format a token count for the readout, e.g. 1234 -> "1.2k", 340 -> "340"
export const formatTokenCount = (n: number | undefined): string | null => {
	if (n === undefined) return null
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
	return `${n}`
}

// format an estimated cost in USD, e.g. 0.004 -> "$0.004"
export const formatCostUsd = (c: number | undefined): string | null => {
	if (c === undefined) return null
	return `$${c.toFixed(4)}`
}

// build the small per-message token/cost readout string. Returns "—" when usage is undefined.
const AssistantMessageComponent = ({ chatMessage, isCheckpointGhost, isCommitted, messageIdx }: { chatMessage: ChatMessage & { role: 'assistant' }, isCheckpointGhost: boolean, messageIdx: number, isCommitted: boolean }) => {

	const accessor = useAccessor()
	const chatThreadsService = accessor.get('IChatThreadService')
	const clipboardService = accessor.get('IClipboardService')

	const reasoningStr = chatMessage.reasoning?.trim() || null
	const hasReasoning = !!reasoningStr
	const isDoneReasoning = !!chatMessage.displayContent
	const thread = chatThreadsService.getCurrentThread()


	const chatMessageLocation: ChatMessageLocation = {
		threadId: thread.id,
		messageIdx: messageIdx,
	}

	const isEmpty = !chatMessage.displayContent && !chatMessage.reasoning
	if (isEmpty) return null

	// gather the tool calls that produced this committed assistant message:
	// scan backwards from this message to the previous user message, collecting
	// tool messages (and any interrupted/canceled streaming tools) in order.
	const toolCalls: ToolCallTimelineItem[] = []
	if (isCommitted) {
		const messages = thread.messages
		for (let i = messageIdx - 1; i >= 0; i--) {
			const m = messages[i]
			if (!m) break
			if (m.role === 'user') break
			if (m.role === 'tool') {
				const status: ToolCallTimelineItem['status'] =
					m.type === 'success' ? 'done'
						: m.type === 'tool_error' || m.type === 'invalid_params' ? 'error'
							: m.type === 'rejected' ? 'rejected'
								// these two are still in-flight when the assistant message is committed
								: m.type === 'running_now' || m.type === 'tool_request' ? 'running'
									// documented fallback: never silently report an unknown type as 'running'
									: 'done'
				toolCalls.unshift({ name: m.name, status })
			} else if (m.role === 'interrupted_streaming_tool') {
				toolCalls.unshift({ name: m.name, status: 'rejected' })
			}
		}
	}

	// copy feedback state
	const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle')

	// timer for resetting copy feedback; cleared on unmount to avoid a state update after teardown
	const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
	useEffect(() => {
		return () => {
			if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
		}
	}, [])

	const onCopy = async () => {
		try {
			await clipboardService.writeText(chatMessage.displayContent || '')
			setCopyState('copied')
		} catch {
			setCopyState('error')
		}
		if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
		copyTimerRef.current = setTimeout(() => setCopyState('idle'), 1500)
	}

	// re-run the last user message that produced this assistant message
	const onRetry = async () => {
		const messages = thread.messages
		let userMessage = ''
		for (let i = messageIdx - 1; i >= 0; i--) {
			const m = messages[i]
			if (m?.role === 'user') {
				userMessage = m.displayContent
				break
			}
		}
		if (!userMessage) return
		await chatThreadsService.addUserMessageAndStreamResponse({ userMessage, threadId: thread.id })
	}

	// copy the entire thread (all messages) as plain text — useful for
	// inspecting the raw output / debugging leaked fragments.
	const [copyThreadState, setCopyThreadState] = useState<'idle' | 'copied' | 'error'>('idle')
	const onCopyThread = async () => {
		try {
			const lines: string[] = []
			for (const m of thread.messages) {
				if (m.role === 'user') {
					lines.push(`[USER]`)
					if (m.displayContent) lines.push(m.displayContent)
					lines.push('')
				} else if (m.role === 'assistant') {
					lines.push(`[ASSISTANT]`)
					if (m.reasoning) { lines.push(`<reasoning>\n${m.reasoning}\n</reasoning>`); lines.push('') }
					if (m.displayContent) lines.push(m.displayContent)
					lines.push('')
				} else if (m.role === 'tool') {
					lines.push(`[TOOL ${m.type} ${m.name}]`)
					if (m.rawParams !== undefined) lines.push(`<rawParams>\n${JSON.stringify(m.rawParams, null, 2)}\n</rawParams>`)
					if (m.content) lines.push(m.content)
					lines.push('')
				} else if (m.role === 'interrupted_streaming_tool') {
					lines.push(`[INTERRUPTED_TOOL ${m.name}]`)
					lines.push('')
				} else if (m.role === 'checkpoint') {
					lines.push(`[CHECKPOINT ${m.type}]`)
					lines.push('')
				}
			}
			await clipboardService.writeText(lines.join('\n'))
			setCopyThreadState('copied')
		} catch {
			setCopyThreadState('error')
		}
		if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
		copyTimerRef.current = setTimeout(() => setCopyThreadState('idle'), 1500)
	}

	// per-message token/cost readout
	const usage = chatMessage.usage
	let tokenReadout: string
	if (!usage) {
		tokenReadout = '—'
	} else {
		const prompt = formatTokenCount(usage.promptTokens)
		const completion = formatTokenCount(usage.completionTokens)
		const cost = formatCostUsd(usage.estimatedCostUsd)
		const parts: string[] = []
		if (prompt !== null || completion !== null) {
			parts.push(`↑${prompt ?? '—'} ↓${completion ?? '—'}`)
		}
		if (cost !== null) parts.push(cost)
		tokenReadout = parts.length > 0 ? parts.join(' · ') : '—'
	}

	return <div
		className={`relative group ${isCheckpointGhost ? 'opacity-50' : ''}`}
	>
		{/* tool call timeline */}
		{toolCalls.length > 0 && <ToolCallTimeline toolCalls={toolCalls} />}

		{/* reasoning token */}
		{hasReasoning &&
			<div>
				<ReasoningWrapper isDoneReasoning={isDoneReasoning} isStreaming={!isCommitted}>
					<SmallProseWrapper>
						<ChatMarkdownRender
							string={reasoningStr}
							chatMessageLocation={chatMessageLocation}
							isApplyEnabled={false}
							isLinkDetectionEnabled={true}
						/>
					</SmallProseWrapper>
				</ReasoningWrapper>
			</div>
		}

		{/* assistant message */}
		{chatMessage.displayContent &&
			<div>
				<ProseWrapper>
					<ChatMarkdownRender
						string={chatMessage.displayContent || ''}
						chatMessageLocation={chatMessageLocation}
						isApplyEnabled={true}
						isLinkDetectionEnabled={true}
					/>
				</ProseWrapper>
			</div>
		}

		{/* always-visible per-message footer action bar: copy message / copy entire conversation / retry.
		    Designed after Cursor-style chat footers — sits below the message body so it is visible without hover. */}
		<div
			className="
				mt-1.5 flex items-center gap-1
				select-none
			"
		>
			<button
				aria-label="Copy message"
				title="Copy this message"
				onClick={(e) => { e.preventDefault(); e.stopPropagation(); onCopy() }}
				className="
					inline-flex items-center gap-1
					h-6 px-1.5
					text-[11px] text-void-fg-3
					bg-void-bg-1 border border-void-border-1 rounded-md
					hover:brightness-110 hover:text-void-fg-2
				"
			>
				{copyState === 'copied' ? <Check size={12} /> : copyState === 'error' ? <X size={12} /> : <Copy size={12} />}
				<span>{copyState === 'copied' ? 'Copied' : copyState === 'error' ? 'Failed' : 'Copy'}</span>
			</button>
			<button
				aria-label="Copy entire conversation"
				title="Copy entire conversation"
				onClick={(e) => { e.preventDefault(); e.stopPropagation(); onCopyThread() }}
				className="
					inline-flex items-center gap-1
					h-6 px-1.5
					text-[11px] text-void-fg-3
					bg-void-bg-1 border border-void-border-1 rounded-md
					hover:brightness-110 hover:text-void-fg-2
				"
			>
				{copyThreadState === 'copied' ? <Check size={12} /> : copyThreadState === 'error' ? <X size={12} /> : <MessagesSquare size={12} />}
				<span>{copyThreadState === 'copied' ? 'Copied' : copyThreadState === 'error' ? 'Failed' : 'Copy all'}</span>
			</button>
			<button
				aria-label="Retry"
				title="Retry this message"
				disabled={!isCommitted}
				onClick={(e) => { e.preventDefault(); e.stopPropagation(); onRetry() }}
				className="
					inline-flex items-center gap-1
					h-6 px-1.5
					text-[11px] text-void-fg-3
					bg-void-bg-1 border border-void-border-1 rounded-md
					hover:brightness-110 hover:text-void-fg-2
					disabled:opacity-50 disabled:cursor-not-allowed
				"
			>
				<RotateCw size={12} />
				<span>Retry</span>
			</button>

			{/* per-message token/cost readout pushed to the right */}
			<div className="ml-auto text-[10px] opacity-60 font-mono select-none" aria-hidden="true">
				{tokenReadout}
			</div>
		</div>
	</div>

}
const ReasoningWrapper = ({ isDoneReasoning, isStreaming, children }: { isDoneReasoning: boolean, isStreaming: boolean, children: React.ReactNode }) => {
	const isDone = isDoneReasoning || !isStreaming
	const isWriting = !isDone
	const [isOpen, setIsOpen] = useState(isWriting)
	useEffect(() => {
		if (!isWriting) setIsOpen(false) // if just finished reasoning, close
	}, [isWriting])
	return <ToolHeaderWrapper title='Reasoning' desc1={isWriting ? <IconLoading /> : ''} isOpen={isOpen} onClick={() => setIsOpen(v => !v)}>
		<ToolChildrenWrapper>
			<div className='!select-text cursor-auto'>
				{children}
			</div>
		</ToolChildrenWrapper>
	</ToolHeaderWrapper>
}
const Checkpoint = ({ message, threadId, messageIdx, isCheckpointGhost, threadIsRunning }: { message: CheckpointEntry, threadId: string; messageIdx: number, isCheckpointGhost: boolean, threadIsRunning: boolean }) => {
	const accessor = useAccessor()
	const chatThreadService = accessor.get('IChatThreadService')
	const streamState = useFullChatThreadsStreamState()

	const isRunning = useChatThreadsStreamState(threadId)?.isRunning
	const isDisabled = useMemo(() => {
		if (isRunning) return true
		return !!Object.keys(streamState).find((threadId2) => streamState[threadId2]?.isRunning)
	}, [isRunning, streamState])

	return <div
			className={`flex items-center gap-2 px-3 my-1 select-none ${isCheckpointGhost ? 'opacity-50' : 'opacity-100'}`}
		>
			<div className="flex-1 h-px bg-void-border-3" />
			<div
				className={`
					text-[10px] tracking-wider uppercase text-void-fg-3
					select-none
					${isDisabled ? 'cursor-default' : 'cursor-pointer hover:text-void-fg-2 transition-colors duration-150'}
				`}
				style={{ position: 'relative', display: 'inline-block' }} // allow absolute icon
				onClick={() => {
					if (threadIsRunning) return
					if (isDisabled) return
					chatThreadService.jumpToCheckpointBeforeMessageIdx({
						threadId,
						messageIdx,
						jumpToUserModified: messageIdx === (chatThreadService.state.allThreads[threadId]?.messages.length ?? 0) - 1
					})
				}}
				{...isDisabled ? {
					'data-tooltip-id': 'void-tooltip',
					'data-tooltip-content': `Disabled ${isRunning ? 'when running' : 'because another thread is running'}`,
					'data-tooltip-place': 'top',
				} : {}}
			>
				Checkpoint
			</div>
			<div className="flex-1 h-px bg-void-border-3" />
		</div>
}
type ChatBubbleMode = 'display' | 'edit'
type ChatBubbleProps = {
	chatMessage: ChatMessage,
	messageIdx: number,
	isCommitted: boolean,
	chatIsRunning: IsRunningType,
	threadId: string,
	currCheckpointIdx: number | undefined,
	_scrollToBottom: (() => void) | null,
}
export const ChatBubble = (props: ChatBubbleProps) => {
	return <ErrorBoundary>
		<_ChatBubble {...props} />
	</ErrorBoundary>
}
const _ChatBubble = ({ threadId, chatMessage, currCheckpointIdx, isCommitted, messageIdx, chatIsRunning, _scrollToBottom }: ChatBubbleProps) => {
	const role = chatMessage.role

	const isCheckpointGhost = messageIdx > (currCheckpointIdx ?? Infinity) && !chatIsRunning // whether to show as gray (if chat is running, for good measure just dont show any ghosts)

	if (role === 'user') {
		return <UserMessageComponent
			chatMessage={chatMessage}
			isCheckpointGhost={isCheckpointGhost}
			currCheckpointIdx={currCheckpointIdx}
			messageIdx={messageIdx}
			_scrollToBottom={_scrollToBottom}
		/>
	}
	else if (role === 'assistant') {
		return <AssistantMessageComponent
			chatMessage={chatMessage}
			isCheckpointGhost={isCheckpointGhost}
			messageIdx={messageIdx}
			isCommitted={isCommitted}
		/>
	}
	else if (role === 'tool') {

		if (chatMessage.type === 'invalid_params') {
			return <div className={`${isCheckpointGhost ? 'opacity-50' : ''}`}>
				<InvalidTool toolName={chatMessage.name} message={chatMessage.content} mcpServerName={chatMessage.mcpServerName} />
			</div>
		}

		const toolName = chatMessage.name
		const isBuiltInTool = isABuiltinToolName(toolName)
		const ToolResultWrapper = isBuiltInTool ? builtinToolNameToComponent[toolName]?.resultWrapper as ResultWrapper<ToolName>
			: MCPToolWrapper as ResultWrapper<ToolName>

		// record the start time when a tool begins running, so its elapsed duration
		// can be displayed once it finishes. #ui
		recordToolStart(chatMessage)

		if (ToolResultWrapper)
			return <>
				<div className={`${isCheckpointGhost ? 'opacity-50' : ''}`}>
					<ToolResultWrapper
						toolMessage={chatMessage}
						messageIdx={messageIdx}
						threadId={threadId}
					/>
				</div>
				{chatMessage.type === 'tool_request' ?
					<div className={`${isCheckpointGhost ? 'opacity-50 pointer-events-none' : ''}`}>
						<ToolRequestAcceptRejectButtons toolName={chatMessage.name} />
					</div> : null}
			</>
		return null
	}

	else if (role === 'interrupted_streaming_tool') {
		return <div className={`${isCheckpointGhost ? 'opacity-50' : ''}`}>
			<CanceledTool toolName={chatMessage.name} mcpServerName={chatMessage.mcpServerName} />
		</div>
	}

	else if (role === 'checkpoint') {
		return <Checkpoint
			threadId={threadId}
			message={chatMessage}
			messageIdx={messageIdx}
			isCheckpointGhost={isCheckpointGhost}
			threadIsRunning={!!chatIsRunning}
		/>
	}

}
