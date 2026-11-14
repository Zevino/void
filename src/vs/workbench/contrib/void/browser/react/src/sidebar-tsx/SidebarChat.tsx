/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
import React, { Fragment, KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, Bug, Code2, FileText, Sparkles } from 'lucide-react';

import { useAccessor, useChatThreadsState, useChatThreadsStreamState, useSettingsState } from '../util/services.js';
import { ErrorDisplay } from './ErrorDisplay.js';
import { TextAreaFns, VoidInputBox2 } from '../util/inputs.js';
import { PastThreadsList } from './SidebarThreadSelector.js';
import { VOID_CTRL_L_ACTION_ID } from '../../../actionIDs.js';
import { VOID_OPEN_SETTINGS_ACTION_ID } from '../../../voidSettingsPane.js';
import { isFeatureNameDisabled } from '../../../../../../../workbench/contrib/void/common/voidSettingsTypes.js';
import { ICommandService } from '../../../../../../../platform/commands/common/commands.js';
import { WarningBox } from '../void-settings-tsx/WarningBox.js';
import { StagingSelectionItem } from '../../../../common/chatThreadServiceTypes.js';
import ErrorBoundary from './ErrorBoundary.js';
import { VoidChatArea, IconLoading } from './ChatInput.js';
import { ChatBubble, ProseWrapper } from './MessageBubbles.js';
import { ToolCallSoFar } from './ToolMessages.js';
import { CommandBarInChat } from './CommandBarInChat.js';
import { SessionUsageFooter, TokenSavingsHint } from './SessionUsage.js';

// Re-export all symbols that were previously exported from this module so that
// external imports of './SidebarChat.js' remain unaffected by the split.
export { IconX, IconWarning, IconLoading, VoidChatArea, ButtonSubmit, ButtonStop, getRelative, getFolderName, getBasename, voidOpenFileFn, SelectedFiles } from './ChatInput.js';
export { ToolChildrenWrapper, CodeChildren, ListableToolItem } from './ToolMessages.js';
const scrollToBottom = (divRef: { current: HTMLElement | null }) => {
	if (divRef.current) {
		divRef.current.scrollTop = divRef.current.scrollHeight;
	}
};
const ScrollToBottomContainer = ({ children, className, style, scrollContainerRef }: { children: React.ReactNode, className?: string, style?: React.CSSProperties, scrollContainerRef: React.MutableRefObject<HTMLDivElement | null> }) => {
	const [isAtBottom, setIsAtBottom] = useState(true); // Start at bottom

	const divRef = scrollContainerRef

	const onScroll = () => {
		const div = divRef.current;
		if (!div) return;

		const isBottom = Math.abs(
			div.scrollHeight - div.clientHeight - div.scrollTop
		) < 4;

		setIsAtBottom(isBottom);
	};

	// When children change (new messages added)
	useEffect(() => {
		if (isAtBottom) {
			scrollToBottom(divRef);
		}
	}, [children, isAtBottom]); // Dependency on children to detect new messages

	// Initial scroll to bottom
	useEffect(() => {
		scrollToBottom(divRef);
	}, []);

	return (
		<div
			ref={divRef}
			onScroll={onScroll}
			className={className}
			style={style}
			role="log"
			aria-live="polite"
		>
			{children}
		</div>
	);
};
export const SidebarChat = () => {
	const textAreaRef = useRef<HTMLTextAreaElement | null>(null)
	const textAreaFnsRef = useRef<TextAreaFns | null>(null)

	const accessor = useAccessor()
	const commandService = accessor.get('ICommandService')
	const chatThreadsService = accessor.get('IChatThreadService')

	const settingsState = useSettingsState()
	// ----- HIGHER STATE -----

	// threads state
	const chatThreadsState = useChatThreadsState()

	const currentThread = chatThreadsService.getCurrentThread()
	const previousMessages = currentThread?.messages ?? []

	const selections = currentThread.state.stagingSelections
	const setSelections = (s: StagingSelectionItem[]) => { chatThreadsService.setCurrentThreadState({ stagingSelections: s }) }

	// stream state
	const currThreadStreamState = useChatThreadsStreamState(chatThreadsState.currentThreadId)
	const isRunning = currThreadStreamState?.isRunning
	const latestError = currThreadStreamState?.error
	const { displayContentSoFar, toolCallSoFar: toolCallSoFarArr, reasoningSoFar } = currThreadStreamState?.llmInfo ?? {}

	// all tool calls currently being streamed by the LLM (parallel tool calls are
	// all present in the array, not just the first one)
	const inFlightToolCalls = toolCallSoFarArr?.filter(t => !t.isDone) ?? []

	// this is just if it's currently being generated, NOT if it's currently running
	const toolIsGenerating = inFlightToolCalls.length > 0 // show loading for slow tools (right now just edit)

	// ----- SIDEBAR CHAT state (local) -----

	// state of current message
	const initVal = ''
	const [instructionsAreEmpty, setInstructionsAreEmpty] = useState(!initVal)

	const isDisabled = instructionsAreEmpty || !!isFeatureNameDisabled('Chat', settingsState)

	const sidebarRef = useRef<HTMLDivElement>(null)
	const scrollContainerRef = useRef<HTMLDivElement | null>(null)
	const onSubmit = useCallback(async (_forceSubmit?: string) => {

		if (isDisabled && !_forceSubmit) return
		if (isRunning) return

		const threadId = chatThreadsService.state.currentThreadId

		// send message to LLM
		const userMessage = _forceSubmit || textAreaRef.current?.value || ''

		try {
			await chatThreadsService.addUserMessageAndStreamResponse({ userMessage, threadId })
		} catch (e) {
			console.error('Error while sending message in chat:', e)
		}

		setSelections([]) // clear staging
		textAreaFnsRef.current?.setValue('')
		textAreaRef.current?.focus() // focus input after submit

	}, [chatThreadsService, isDisabled, isRunning, textAreaRef, textAreaFnsRef, setSelections, settingsState])

	const onAbort = async () => {
		const threadId = currentThread.id
		await chatThreadsService.abortRunning(threadId)
	}

	const keybindingString = accessor.get('IKeybindingService').lookupKeybinding(VOID_CTRL_L_ACTION_ID)?.getLabel()

	const threadId = currentThread.id
	const currCheckpointIdx = chatThreadsState.allThreads[threadId]?.state?.currCheckpointIdx ?? undefined  // if not exist, treat like checkpoint is last message (infinity)



	// resolve mount info
	const isResolved = chatThreadsState.allThreads[threadId]?.state.mountedInfo?.mountedIsResolvedRef.current
	useEffect(() => {
		if (isResolved) return
		chatThreadsState.allThreads[threadId]?.state.mountedInfo?._whenMountedResolver?.({
			textAreaRef: textAreaRef,
			scrollToBottom: () => scrollToBottom(scrollContainerRef),
		})

	}, [chatThreadsState, threadId, textAreaRef, scrollContainerRef, isResolved])




	const previousMessagesHTML = useMemo(() => {
		// const lastMessageIdx = previousMessages.findLastIndex(v => v.role !== 'checkpoint')
		// tool request shows up as Editing... if in progress
		return previousMessages.map((message, i) => {
			return <ChatBubble
				key={i}
				currCheckpointIdx={currCheckpointIdx}
				chatMessage={message}
				messageIdx={i}
				isCommitted={true}
				chatIsRunning={isRunning}
				threadId={threadId}
				_scrollToBottom={() => scrollToBottom(scrollContainerRef)}
			/>
		})
	}, [previousMessages, threadId, currCheckpointIdx, isRunning])

	const streamingChatIdx = previousMessagesHTML.length
	const currStreamingMessageHTML = reasoningSoFar || displayContentSoFar || isRunning ?
		<ChatBubble
			key={'curr-streaming-msg'}
			currCheckpointIdx={currCheckpointIdx}
			chatMessage={{
				role: 'assistant',
				displayContent: displayContentSoFar ?? '',
				reasoning: reasoningSoFar ?? '',
				anthropicReasoning: null,
			}}
			messageIdx={streamingChatIdx}
			isCommitted={false}
			chatIsRunning={isRunning}

			threadId={threadId}
			_scrollToBottom={null}
		/> : null


	// the tools currently being generated (all in-flight tool calls render, so
	// parallel tool calls are all visible while streaming)
	const generatingTools = toolIsGenerating ?
		<div className='flex flex-col gap-2'>
			{inFlightToolCalls.map((toolCall, i) => (
				<ToolCallSoFar
					key={`${toolCall.id}-${i}`}
					toolCallSoFar={toolCall}
				/>
			))}
		</div>
		: null

	const messagesHTML = <ScrollToBottomContainer
		key={'messages' + chatThreadsState.currentThreadId} // force rerender on all children if id changes
		scrollContainerRef={scrollContainerRef}
		className={`
			flex min-h-0 flex-1 flex-col gap-5
			px-4 py-5
			w-full
			overflow-x-hidden
			overflow-y-auto overscroll-contain
			${previousMessagesHTML.length === 0 && !displayContentSoFar ? 'hidden' : ''}
		`}
	>
		{/* previous messages */}
		{previousMessagesHTML}
		{currStreamingMessageHTML}

		{/* Generating tools */}
		{generatingTools}

		{/* loading indicator */}
		{isRunning === 'LLM' || isRunning === 'idle' && !toolIsGenerating ? <ProseWrapper>
			{<IconLoading className='opacity-50 text-sm' />}
		</ProseWrapper> : null}


		{/* error message */}
		{latestError === undefined ? null :
			<div className='px-2 my-1'>
				<ErrorDisplay
					message={latestError.message}
					fullError={latestError.fullError}
					onDismiss={() => { chatThreadsService.dismissStreamError(currentThread.id) }}
					showDismiss={true}
				/>

				<WarningBox className='text-sm my-2 mx-4' onClick={() => { commandService.executeCommand(VOID_OPEN_SETTINGS_ACTION_ID) }} text='Open settings' />
			</div>
		}
	</ScrollToBottomContainer>


	const onChangeText = useCallback((newStr: string) => {
		setInstructionsAreEmpty(!newStr)
	}, [setInstructionsAreEmpty])
	const onKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
			onSubmit()
		} else if (e.key === 'Escape' && isRunning) {
			onAbort()
		}
	}, [onSubmit, onAbort, isRunning])

	const inputChatArea = <VoidChatArea
		className='rounded-2xl border-void-border-2 bg-void-bg-1 shadow-lg shadow-black/5 focus-within:border-void-border-3'
		featureName='Chat'
		onSubmit={() => onSubmit()}
		onAbort={onAbort}
		isStreaming={!!isRunning}
		isDisabled={isDisabled}
		showSelections={true}
		// showProspectiveSelections={previousMessagesHTML.length === 0}
		selections={selections}
		setSelections={setSelections}
		onClickAnywhere={() => { textAreaRef.current?.focus() }}
	>
		<VoidInputBox2
			enableAtToMention
			className={`min-h-[96px] px-1 py-1`}
			placeholder={`@ to mention, ${keybindingString ? `${keybindingString} to add a selection. ` : ''}Enter instructions...`}
			onChangeText={onChangeText}
			onKeyDown={onKeyDown}
			onFocus={() => { chatThreadsService.setCurrentlyFocusedMessageIdx(undefined) }}
			ref={textAreaRef}
			fnsRef={textAreaFnsRef}
			multiline={true}
		/>

	</VoidChatArea>


	const isLandingPage = previousMessages.length === 0


	const promptCards = [
		{ title: 'Understand this codebase', detail: 'Map the architecture and key files', prompt: 'Summarize my codebase', icon: <Code2 size={16} /> },
		{ title: 'Find and fix a bug', detail: 'Trace an issue and suggest a fix', prompt: 'Help me find and fix a bug in this project', icon: <Bug size={16} /> },
		{ title: 'Create documentation', detail: 'Turn code into clear documentation', prompt: 'Create useful documentation for this project', icon: <FileText size={16} /> },
	]

	const initiallySuggestedPromptsHTML = <div className='grid grid-cols-1 gap-2 w-full'>
		{promptCards.map((item) => (
			<button
				key={item.title}
				type='button'
				onClick={() => onSubmit(item.prompt)}
				className='group flex items-center gap-3 rounded-xl border border-void-border-2 bg-void-bg-1 px-3 py-3 text-left transition-all hover:border-void-border-3 hover:bg-void-bg-2 focus:outline-none focus:ring-1 focus:ring-void-border-3'
			>
				<span className='flex size-9 shrink-0 items-center justify-center rounded-lg bg-void-bg-2 text-void-fg-2 group-hover:text-void-fg-1'>{item.icon}</span>
				<span className='min-w-0 flex-1'>
					<span className='block text-sm font-medium text-void-fg-1'>{item.title}</span>
					<span className='mt-0.5 block truncate text-xs text-void-fg-3'>{item.detail}</span>
				</span>
				<ArrowUpRight size={15} className='shrink-0 text-void-fg-4 opacity-0 transition-opacity group-hover:opacity-100' />
			</button>
		))}
	</div>


	const threadPageInput = <div key={'input' + chatThreadsState.currentThreadId} className='shrink-0 border-t border-void-border-2 bg-void-bg-1'>
		<TokenSavingsHint />
		<div className='px-4'>
			<CommandBarInChat />
		</div>
		<div className='px-3 pt-2 pb-3'>
			{inputChatArea}
		</div>
		<SessionUsageFooter />
	</div>

	const landingPageInput = <div className='mt-7'>
		{inputChatArea}
	</div>

	const landingPageContent = <div
		ref={sidebarRef}
		className='w-full h-full min-h-0 flex flex-col overflow-y-auto overscroll-contain bg-void-bg-0'
	>
		<div className='px-4 pt-7 pb-5'>
			<div className='mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-void-fg-3'>
				<span className='flex size-7 items-center justify-center rounded-lg bg-void-bg-2 text-void-fg-1'><Sparkles size={15} /></span>
				Voidly Agent
			</div>
			<h2 className='text-2xl font-semibold tracking-tight text-void-fg-1'>What are we building today?</h2>
			<p className='mt-2 max-w-md text-sm leading-6 text-void-fg-3'>Explore your code, solve problems, and turn ideas into working software.</p>
			<ErrorBoundary>
				{landingPageInput}
			</ErrorBoundary>
			<div className='mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-void-fg-4'>
				<span>Enter to send</span><span>Shift + Enter for a new line</span><span>@ to add context</span>
			</div>
		</div>
		<div className='border-t border-void-border-2 px-4 py-5'>
			<div className='mb-3 flex items-center justify-between'>
				<span className='text-xs font-semibold uppercase tracking-wider text-void-fg-3'>Start with an idea</span>
				<span className='text-[11px] text-void-fg-4'>Suggested tasks</span>
			</div>
			{initiallySuggestedPromptsHTML}
		</div>
		{Object.keys(chatThreadsState.allThreads).length > 1 ?
			<div className='border-t border-void-border-2 px-4 py-5'>
				<div className='mb-3 flex items-center justify-between'>
					<span className='text-xs font-semibold uppercase tracking-wider text-void-fg-3'>Recent conversations</span>
				</div>
				<ErrorBoundary><PastThreadsList /></ErrorBoundary>
			</div>
			: null}
	</div>


	// const threadPageContent = <div>
	// 	{/* Thread content */}
	// 	<div className='flex flex-col overflow-hidden'>
	// 		<div className={`overflow-hidden ${previousMessages.length === 0 ? 'h-0 max-h-0 pb-2' : ''}`}>
	// 			<ErrorBoundary>
	// 				{messagesHTML}
	// 			</ErrorBoundary>
	// 		</div>
	// 		<ErrorBoundary>
	// 			{inputForm}
	// 		</ErrorBoundary>
	// 	</div>
	// </div>
	const threadPageContent = <div
		ref={sidebarRef}
		className='w-full h-full min-h-0 flex flex-col overflow-hidden bg-void-bg-0'
	>

		<ErrorBoundary>
			{messagesHTML}
		</ErrorBoundary>
		<ErrorBoundary>
			{threadPageInput}
		</ErrorBoundary>
	</div>


	return (
		<Fragment key={threadId} // force rerender when change thread
		>
			{isLandingPage ?
				landingPageContent
				: threadPageContent}
		</Fragment>
	)
}
