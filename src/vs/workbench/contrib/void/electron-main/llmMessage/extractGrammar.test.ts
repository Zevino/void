/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert'
import { extractXMLToolsWrapper } from './extractGrammar.js'
import type { ChatMode } from '../../common/voidSettingsTypes.js'
import type { InternalToolInfo } from '../../common/prompt/prompts.js'
import type { OnFinalMessage, OnText, RawToolCallObj } from '../../common/sendLLMMessageTypes.js'


// minimal MCP tool definitions so the XML wrapper recognizes the open tags
const makeTools = (names: string[]): InternalToolInfo[] => names.map((name) => ({
	name,
	description: `test tool ${name}`,
	params: { arg: { description: 'a test arg' } },
	mcpServerName: 'test-server',
}))


const extractTools = (xml: string, chatMode: ChatMode, mcpTools: InternalToolInfo[]): RawToolCallObj[] | undefined => {
	let finalToolCalls: RawToolCallObj[] | undefined
	const onText: OnText = () => { /* noop */ }
	const onFinalMessage: OnFinalMessage = (params) => {
		finalToolCalls = params.toolCall
	}
	const { newOnText, newOnFinalMessage } = extractXMLToolsWrapper(onText, onFinalMessage, chatMode, mcpTools)
	newOnText({ fullText: xml, fullReasoning: '' })
	newOnFinalMessage({ fullText: '', fullReasoning: '', anthropicReasoning: null })
	return finalToolCalls
}


suite('extractGrammar XML tool resolution', () => {

	test('resolves a single tool call', () => {
		const xml = '<customToolA>\n<arg>hello</arg>\n</customToolA>'
		const tools = extractTools(xml, 'agent', makeTools(['customToolA']))
		assert.ok(tools && tools.length === 1, 'expected exactly one tool call')
		assert.strictEqual(tools![0].name, 'customToolA')
	})

	// #2 / #9: the XML path now accumulates EVERY completed tool call (in order),
	// so when the model emits multiple tools consecutively, all are surfaced.
	test('all tool calls are resolved when multiple are emitted consecutively', () => {
		const xml = [
			'<customToolA>',
			'  <arg>first</arg>',
			'</customToolA>',
			'<customToolB>',
			'  <arg>second</arg>',
			'</customToolB>',
		].join('\n')

		const tools = extractTools(xml, 'agent', makeTools(['customToolA', 'customToolB']))

		assert.ok(tools, 'expected tool calls to be resolved')
		assert.strictEqual(tools!.length, 2, 'XML path must surface all consecutive tool calls')
		assert.strictEqual(tools![0].name, 'customToolA')
		assert.strictEqual(tools![1].name, 'customToolB')
	})

	test('a tool call after plain text is still resolved', () => {
		const xml = 'some preamble text\n<customToolA>\n<arg>x</arg>\n</customToolA>'
		const tools = extractTools(xml, 'agent', makeTools(['customToolA']))
		assert.ok(tools && tools.length === 1, 'expected exactly one tool call after preamble text')
		assert.strictEqual(tools![0].name, 'customToolA')
	})

})
