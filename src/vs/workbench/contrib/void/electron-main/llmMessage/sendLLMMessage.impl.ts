/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// disable foreign import complaints
/* eslint-disable */
import Anthropic from '@anthropic-ai/sdk';
import { Ollama } from 'ollama';
import OpenAI, { ClientOptions, AzureOpenAI } from 'openai';
import { MistralCore } from '@mistralai/mistralai/core.js';
import { fimComplete } from '@mistralai/mistralai/funcs/fimComplete.js';
import { Tool as GeminiTool, FunctionDeclaration, GoogleGenAI, ThinkingConfig, Schema, Type } from '@google/genai';
import { GoogleAuth } from 'google-auth-library'
/* eslint-enable */

import { AnthropicLLMChatMessage, GeminiLLMChatMessage, LLMChatMessage, LLMFIMMessage, ModelListParams, OllamaModelResponse, OnError, OnFinalMessage, OnText, RawToolCallObj, RawToolParamsObj } from '../../common/sendLLMMessageTypes.js';
import { ChatMode, displayInfoOfProviderName, ModelSelectionOptions, OverridesOfModel, ProviderName, SettingsOfProvider } from '../../common/voidSettingsTypes.js';
import { getSendableReasoningInfo, getModelCapabilities, getProviderCapabilities, defaultProviderSettings, getReservedOutputTokenSpace } from '../../common/modelCapabilities.js';
import { extractReasoningWrapper, extractXMLToolsWrapper } from './extractGrammar.js';
import { availableTools, InternalToolInfo } from '../../common/prompt/prompts.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { aggregateToolCalls, normalizeV1BaseURL, parseHeadersJSON, rawToolCallObjOfParamsStr } from '../../common/sendLLMMessage.openaiCompatible.utils.js';

const getGoogleApiKey = async () => {
	// module‑level singleton
	const auth = new GoogleAuth({ scopes: `https://www.googleapis.com/auth/cloud-platform` });
	const key = await auth.getAccessToken()
	if (!key) throw new Error(`Google API failed to generate a key.`)
	return key
}




type InternalCommonMessageParams = {
	onText: OnText;
	onFinalMessage: OnFinalMessage;
	onError: OnError;
	providerName: ProviderName;
	settingsOfProvider: SettingsOfProvider;
	modelSelectionOptions: ModelSelectionOptions | undefined;
	overridesOfModel: OverridesOfModel | undefined;
	modelName: string;
	_setAborter: (aborter: () => void) => void;
}

type SendChatParams_Internal = InternalCommonMessageParams & {
	messages: LLMChatMessage[];
	separateSystemMessage: string | undefined;
	chatMode: ChatMode | null;
	mcpTools: InternalToolInfo[] | undefined;
}
type SendFIMParams_Internal = InternalCommonMessageParams & { messages: LLMFIMMessage; separateSystemMessage: string | undefined; }
export type ListParams_Internal<ModelResponse> = ModelListParams<ModelResponse>


const invalidApiKeyMessage = (providerName: ProviderName) => `Invalid ${displayInfoOfProviderName(providerName).title} API key.`

// ------------ OPENAI-COMPATIBLE (HELPERS) ------------



// headers to include on every request so the provider recognizes our traffic
const openRouterHeaders = {
	'HTTP-Referer': 'https://voideditor.com', // Optional, for including your app on openrouter.ai rankings.
	'X-Title': 'Void', // Optional. Shows in rankings on openrouter.ai.
}

// how long (ms) we wait before aborting a request; and how many times we retry on transient failures
const OPENAI_TIMEOUT_MS = 60_000
const OPENAI_MAX_RETRIES = 1

type OpenAICompatibleProviderConfig = {
	baseURL: (settingsOfProvider: SettingsOfProvider, providerName: ProviderName) => string | Promise<string>;
	// the setting field that holds the API key; undefined means the provider uses a fallback (e.g. noop / empty)
	apiKeyField?: keyof SettingsOfProvider[ProviderName];
	apiKey?: (settingsOfProvider: SettingsOfProvider) => string | undefined | Promise<string | undefined>;
	defaultHeaders?: Record<string, string>;
	// pull custom headers from the provider's headersJSON setting (only openAICompatible)
	defaultHeadersFromSettings?: boolean;
	// use AzureOpenAI instead of OpenAI
	isAzure?: boolean;
	azureConfig?: (settingsOfProvider: SettingsOfProvider) => { endpoint: string; apiKey: string; apiVersion: string };
}
// Config table that maps each OpenAI-compatible provider to how it constructs an SDK.
// Adding a new provider is now a one-line addition here instead of a new if/else branch.
const openAICompatibleProviderConfigs: Record<Exclude<ProviderName, 'anthropic' | 'gemini'>, OpenAICompatibleProviderConfig> = {
	openAI: {
		apiKeyField: 'apiKey',
		baseURL: () => 'https://api.openai.com/v1',
	},
	ollama: {
		baseURL: ({ ollama }) => normalizeV1BaseURL(ollama.endpoint),
		// local providers don't need a real key
		apiKey: () => '',
	},
	vLLM: {
		baseURL: ({ vLLM }) => normalizeV1BaseURL(vLLM.endpoint),
		apiKey: () => '',
	},
	liteLLM: {
		baseURL: ({ liteLLM }) => normalizeV1BaseURL(liteLLM.endpoint),
		apiKey: () => '',
	},
	lmStudio: {
		baseURL: ({ lmStudio }) => normalizeV1BaseURL(lmStudio.endpoint),
		apiKey: () => '',
	},
	openRouter: {
		apiKeyField: 'apiKey',
		baseURL: () => 'https://openrouter.ai/api/v1',
		defaultHeaders: openRouterHeaders,
	},
	googleVertex: {
		baseURL: async ({ googleVertex }) => `https://${googleVertex.region}-aiplatform.googleapis.com/v1/projects/${googleVertex.project}/locations/${googleVertex.region}/endpoints/${'openapi'}`,
		// https://cloud.google.com/vertex-ai/generative-ai/docs/multimodal/call-vertex-using-openai-library
		apiKey: async () => getGoogleApiKey(),
	},
	microsoftAzure: {
		isAzure: true,
		azureConfig: ({ microsoftAzure }) => {
			const endpoint = `https://${microsoftAzure.project}.openai.azure.com/`;
			const apiVersion = microsoftAzure.azureApiVersion ?? '2024-04-01-preview';
			return { endpoint, apiKey: microsoftAzure.apiKey, apiVersion };
		},
		baseURL: () => '',
	},
	awsBedrock: {
		apiKeyField: 'apiKey',
		// We treat Bedrock as *OpenAI-compatible only through a proxy*:
		//   • LiteLLM default → http://localhost:4000/v1
		//   • Bedrock-Access-Gateway → https://<api-id>.execute-api.<region>.amazonaws.com/openai/
		// The native Bedrock runtime endpoint is **NOT** OpenAI-compatible, so we don't fall back to it.
		baseURL: ({ awsBedrock }) => normalizeV1BaseURL(awsBedrock.endpoint || 'http://localhost:4000/v1'),
	},
	deepseek: {
		apiKeyField: 'apiKey',
		baseURL: () => 'https://api.deepseek.com/v1',
	},
	openAICompatible: {
		apiKeyField: 'apiKey',
		baseURL: ({ openAICompatible }) => normalizeV1BaseURL(openAICompatible.endpoint),
		defaultHeadersFromSettings: true,
	},
	groq: {
		apiKeyField: 'apiKey',
		baseURL: () => 'https://api.groq.com/openai/v1',
	},
	xAI: {
		apiKeyField: 'apiKey',
		baseURL: () => 'https://api.x.ai/v1',
	},
	mistral: {
		apiKeyField: 'apiKey',
		baseURL: () => 'https://api.mistral.ai/v1',
	},
}

const newOpenAICompatibleSDK = async ({ settingsOfProvider, providerName }: { settingsOfProvider: SettingsOfProvider, providerName: Exclude<ProviderName, 'anthropic' | 'gemini'> }) => {
	const commonPayloadOpts: ClientOptions = {
		dangerouslyAllowBrowser: true,
		// fail fast + retry a little on transient network errors
		timeout: OPENAI_TIMEOUT_MS,
		maxRetries: OPENAI_MAX_RETRIES,
	}

	const config = openAICompatibleProviderConfigs[providerName]
	if (!config) throw new Error(`Void providerName was invalid: ${providerName}.`)

	// microsoftAzure uses a different SDK/client
	if (config.isAzure) {
		const { endpoint, apiKey, apiVersion } = config.azureConfig!(settingsOfProvider)
		return new AzureOpenAI({ endpoint, apiKey, apiVersion, ...commonPayloadOpts })
	}

	const baseURL = await config.baseURL(settingsOfProvider, providerName)
	const apiKey = config.apiKeyField
		? settingsOfProvider[providerName][config.apiKeyField]
		: await config.apiKey?.(settingsOfProvider)

	// custom headers (only the OpenAI-Compatible aggregator lets users provide their own)
	const defaultHeaders = {
		...config.defaultHeaders,
		...(config.defaultHeadersFromSettings ? parseHeadersJSON(settingsOfProvider.openAICompatible.headersJSON) : {}),
	}

	return new OpenAI({ baseURL, apiKey, defaultHeaders, ...commonPayloadOpts })
}


const _sendOpenAICompatibleFIM = async ({ messages: { prefix, suffix, stopTokens }, onFinalMessage, onError, settingsOfProvider, modelName: modelName_, _setAborter, providerName, overridesOfModel }: SendFIMParams_Internal) => {

	const {
		modelName,
		supportsFIM,
		additionalOpenAIPayload,
	} = getModelCapabilities(providerName, modelName_, overridesOfModel)

	if (!supportsFIM) {
		if (modelName === modelName_)
			onError({ message: `Model ${modelName} does not support FIM.`, fullError: null })
		else
			onError({ message: `Model ${modelName_} (${modelName}) does not support FIM.`, fullError: null })
		return
	}

	const openai = await newOpenAICompatibleSDK({ providerName, settingsOfProvider })
	openai.completions
		.create({
			model: modelName,
			prompt: prefix,
			suffix: suffix,
			stop: stopTokens,
			max_tokens: 300,
			...additionalOpenAIPayload,
		})
		.then(async response => {
			const fullText = response.choices[0]?.text
			onFinalMessage({ fullText, fullReasoning: '', anthropicReasoning: null });
		})
		.catch(error => {
			if (error instanceof OpenAI.APIError && error.status === 401) { onError({ message: invalidApiKeyMessage(providerName), fullError: error }); }
			else { onError({ message: error + '', fullError: error }); }
		})
}


const toOpenAICompatibleTool = (toolInfo: InternalToolInfo) => {
	const { name, description, params } = toolInfo

	const paramsWithType: { [s: string]: { description: string; type: 'string' } } = {}
	for (const key in params) { paramsWithType[key] = { ...params[key], type: 'string' } }

	return {
		type: 'function',
		function: {
			name: name,
			// strict: true, // strict mode - https://platform.openai.com/docs/guides/function-calling?api-mode=chat
			description: description,
			parameters: {
				type: 'object',
				properties: params,
				// required: Object.keys(params), // in strict mode, all params are required and additionalProperties is false
				// additionalProperties: false,
			},
		}
	} satisfies OpenAI.Chat.Completions.ChatCompletionTool
}

const openAITools = (chatMode: ChatMode | null, mcpTools: InternalToolInfo[] | undefined) => {
	const allowedTools = availableTools(chatMode, mcpTools)
	if (!allowedTools || Object.keys(allowedTools).length === 0) return null

	const openAITools: OpenAI.Chat.Completions.ChatCompletionTool[] = []
	for (const t in allowedTools ?? {}) {
		openAITools.push(toOpenAICompatibleTool(allowedTools[t]))
	}
	return openAITools
}


const rawToolCallObjOfAnthropicParams = (toolBlock: Anthropic.Messages.ToolUseBlock): RawToolCallObj | null => {
	const { id, name, input } = toolBlock

	if (input === null) return null
	if (typeof input !== 'object') return null

	const rawParams: RawToolParamsObj = input
	return { id, name, rawParams, doneParams: Object.keys(rawParams), isDone: true }
}


// ------------ OPENAI-COMPATIBLE ------------


const _sendOpenAICompatibleChat = async ({ messages, onText, onFinalMessage, onError, settingsOfProvider, modelSelectionOptions, modelName: modelName_, _setAborter, providerName, chatMode, separateSystemMessage, overridesOfModel, mcpTools }: SendChatParams_Internal) => {
	const {
		modelName,
		specialToolFormat,
		reasoningCapabilities,
		additionalOpenAIPayload,
	} = getModelCapabilities(providerName, modelName_, overridesOfModel)

	const { providerReasoningIOSettings } = getProviderCapabilities(providerName)

	// reasoning
	const { canIOReasoning, openSourceThinkTags } = reasoningCapabilities || {}
	const reasoningInfo = getSendableReasoningInfo('Chat', providerName, modelName_, modelSelectionOptions, overridesOfModel) // user's modelName_ here

	// payload sent in the request body (single source of truth — merged in once, below)
	const includeInPayload = {
		...providerReasoningIOSettings?.input?.includeInPayload?.(reasoningInfo),
		...additionalOpenAIPayload
	}

	// how much output token space the model reserves. o1/o3-style reasoning models
	// ignore `max_tokens` and require `max_completion_tokens`, so choose the field accordingly.
	const maxTokens = getReservedOutputTokenSpace(providerName, modelName_, {
		isReasoningEnabled: !!reasoningInfo?.isReasoningEnabled,
		overridesOfModel,
	})
	const isReasoningModel = !!reasoningCapabilities
	const outputTokenField: 'max_tokens' | 'max_completion_tokens' = isReasoningModel ? 'max_completion_tokens' : 'max_tokens'

	// tools
	const potentialTools = openAITools(chatMode, mcpTools)
	const nativeToolsObj = potentialTools && specialToolFormat === 'openai-style' ?
		{ tools: potentialTools } as const
		: {}

	// instance
	const openai: OpenAI = await newOpenAICompatibleSDK({ providerName, settingsOfProvider })
	if (providerName === 'microsoftAzure') {
		// Required to select the model
		(openai as AzureOpenAI).deploymentName = modelName;
	}
	const options: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
		model: modelName,
		messages: messages as any,
		stream: true,
		...nativeToolsObj,
		...includeInPayload,
		// only send the token field if we actually know a space to reserve
		...(maxTokens != null ? { [outputTokenField]: maxTokens } : {}),
	}

	// open source models - manually parse think tokens
	const { needsManualParse: needsManualReasoningParse, nameOfFieldInDelta: nameOfReasoningFieldInDelta } = providerReasoningIOSettings?.output ?? {}
	// the generic OpenAI-Compatible provider can't assume every backend uses `reasoning_content`.
	// let the user point us at the right field (e.g. `reasoning` for QwQ/Groq/OpenRouter), or empty to disable.
	const configuredReasoningField = providerName === 'openAICompatible' ? settingsOfProvider.openAICompatible.reasoningField : ''
	const effectiveReasoningField = configuredReasoningField !== '' ? configuredReasoningField : nameOfReasoningFieldInDelta
	const manuallyParseReasoning = needsManualReasoningParse && canIOReasoning && openSourceThinkTags
	if (manuallyParseReasoning) {
		const { newOnText, newOnFinalMessage } = extractReasoningWrapper(onText, onFinalMessage, openSourceThinkTags)
		onText = newOnText
		onFinalMessage = newOnFinalMessage
	}

	// manually parse out tool results if XML
	if (!specialToolFormat) {
		const { newOnText, newOnFinalMessage } = extractXMLToolsWrapper(onText, onFinalMessage, chatMode, mcpTools)
		onText = newOnText
		onFinalMessage = newOnFinalMessage
	}

	let fullReasoningSoFar = ''
	let fullTextSoFar = ''

	// OpenAI streams parallel tool calls with different `index` values, interleaved across chunks.
	// We must aggregate each index separately — concatenating all indexes into one string would
	// corrupt the arguments of every tool call. Since the rest of the pipeline consumes a single
	// tool call at a time, we emit the first (lowest-index) completed tool call.
	//
	// index -> accumulated tool call
	let toolCallsByIndex = new Map<number, { name: string; id: string; arguments: string }>()
	// the lowest index we've seen so far (the "active" tool call to surface during streaming)
	let activeToolIndex: number | null = null

	openai.chat.completions
		.create(options)
		.then(async response => {
			_setAborter(() => response.controller.abort())
			// when receive text
			for await (const chunk of response) {
				// message
				const newText = chunk.choices[0]?.delta?.content ?? ''
				fullTextSoFar += newText

				// tool call (aggregate each parallel index separately — see `aggregateToolCalls`)
				({ toolCallsByIndex, activeToolIndex } = aggregateToolCalls(toolCallsByIndex, chunk.choices[0]?.delta?.tool_calls ?? [], activeToolIndex))


				// reasoning
				let newReasoning = ''
				if (effectiveReasoningField) {
					// @ts-ignore
					newReasoning = (chunk.choices[0]?.delta?.[effectiveReasoningField] || '') + ''
					fullReasoningSoFar += newReasoning
				}

				// call onText
				const activeTool = activeToolIndex !== null ? toolCallsByIndex.get(activeToolIndex) : undefined
				onText({
					fullText: fullTextSoFar,
					fullReasoning: fullReasoningSoFar,
					toolCall: !activeTool || !activeTool.name ? undefined : { name: activeTool.name, rawParams: {}, isDone: false, doneParams: [], id: activeTool.id },
				})

			}
			// on final
			// surface ALL completed tool calls (sorted by index) as an array, so the
			// agent loop can execute multiple tools in one round. #2
			const completedToolCalls: RawToolCallObj[] = []
			for (const idx of [...toolCallsByIndex.keys()].sort((a, b) => a - b)) {
				const tc = toolCallsByIndex.get(idx)
				if (tc?.name) {
					completedToolCalls.push(rawToolCallObjOfParamsStr(tc.name, tc.arguments, tc.id))
				}
			}
			const hasToolCall = completedToolCalls.length > 0
			if (!fullTextSoFar && !fullReasoningSoFar && !hasToolCall) {
				onError({ message: 'Void: Response from model was empty.', fullError: null })
			}
			else {
				const toolCallObj = hasToolCall ? { toolCall: completedToolCalls } : {}
				onFinalMessage({ fullText: fullTextSoFar, fullReasoning: fullReasoningSoFar, anthropicReasoning: null, ...toolCallObj });
			}
		})
		// when error/fail - this catches errors of both .create() and .then(for await)
		.catch(error => {
			if (error instanceof OpenAI.APIError && error.status === 401) { onError({ message: invalidApiKeyMessage(providerName), fullError: error }); }
			else { onError({ message: error + '', fullError: error }); }
		})
}



type OpenAIModel = {
	id: string;
	created: number;
	object: 'model';
	owned_by: string;
}
const _openaiCompatibleList = async ({ onSuccess: onSuccess_, onError: onError_, settingsOfProvider, providerName }: ListParams_Internal<OpenAIModel>) => {
	const onSuccess = ({ models }: { models: OpenAIModel[] }) => {
		onSuccess_({ models })
	}
	const onError = ({ error }: { error: string }) => {
		onError_({ error })
	}
	try {
		const openai = await newOpenAICompatibleSDK({ providerName, settingsOfProvider })
		openai.models.list()
			.then(async (response) => {
				const models: OpenAIModel[] = []
				models.push(...response.data)
				while (response.hasNextPage()) {
					models.push(...(await response.getNextPage()).data)
				}
				onSuccess({ models })
			})
			.catch((error) => {
				onError({ error: error + '' })
			})
	}
	catch (error) {
		onError({ error: error + '' })
	}
}




// ------------ ANTHROPIC (HELPERS) ------------
const toAnthropicTool = (toolInfo: InternalToolInfo) => {
	const { name, description, params } = toolInfo
	const paramsWithType: { [s: string]: { description: string; type: 'string' } } = {}
	for (const key in params) { paramsWithType[key] = { ...params[key], type: 'string' } }
	return {
		name: name,
		description: description,
		input_schema: {
			type: 'object',
			properties: paramsWithType,
			// required: Object.keys(params),
		},
	} satisfies Anthropic.Messages.Tool
}

const anthropicTools = (chatMode: ChatMode | null, mcpTools: InternalToolInfo[] | undefined) => {
	const allowedTools = availableTools(chatMode, mcpTools)
	if (!allowedTools || Object.keys(allowedTools).length === 0) return null

	const anthropicTools: Anthropic.Messages.ToolUnion[] = []
	for (const t in allowedTools ?? {}) {
		anthropicTools.push(toAnthropicTool(allowedTools[t]))
	}
	return anthropicTools
}



// ------------ ANTHROPIC ------------
const sendAnthropicChat = async ({ messages, providerName, onText, onFinalMessage, onError, settingsOfProvider, modelSelectionOptions, overridesOfModel, modelName: modelName_, _setAborter, separateSystemMessage, chatMode, mcpTools }: SendChatParams_Internal) => {
	const {
		modelName,
		specialToolFormat,
	} = getModelCapabilities(providerName, modelName_, overridesOfModel)

	const thisConfig = settingsOfProvider.anthropic
	const { providerReasoningIOSettings } = getProviderCapabilities(providerName)

	// reasoning
	const reasoningInfo = getSendableReasoningInfo('Chat', providerName, modelName_, modelSelectionOptions, overridesOfModel) // user's modelName_ here
	const includeInPayload = providerReasoningIOSettings?.input?.includeInPayload?.(reasoningInfo) || {}

	// anthropic-specific - max tokens
	const maxTokens = getReservedOutputTokenSpace(providerName, modelName_, { isReasoningEnabled: !!reasoningInfo?.isReasoningEnabled, overridesOfModel })

	// tools
	const potentialTools = anthropicTools(chatMode, mcpTools)
	const nativeToolsObj = potentialTools && specialToolFormat === 'anthropic-style' ?
		{ tools: potentialTools, tool_choice: { type: 'auto' } } as const
		: {}


	// instance
	const anthropic = new Anthropic({
		apiKey: thisConfig.apiKey,
		dangerouslyAllowBrowser: true
	});

	const stream = anthropic.messages.stream({
		system: separateSystemMessage ?? undefined,
		messages: messages as AnthropicLLMChatMessage[],
		model: modelName,
		max_tokens: maxTokens ?? 4_096, // anthropic requires this
		...includeInPayload,
		...nativeToolsObj,

	})

	// manually parse out tool results if XML
	if (!specialToolFormat) {
		const { newOnText, newOnFinalMessage } = extractXMLToolsWrapper(onText, onFinalMessage, chatMode, mcpTools)
		onText = newOnText
		onFinalMessage = newOnFinalMessage
	}

	// when receive text
	let fullText = ''
	let fullReasoning = ''

	let fullToolName = ''
	let fullToolParams = ''


	const runOnText = () => {
		onText({
			fullText,
			fullReasoning,
			toolCall: !fullToolName ? undefined : { name: fullToolName, rawParams: {}, isDone: false, doneParams: [], id: 'dummy' },
		})
	}
	// there are no events for tool_use, it comes in at the end
	stream.on('streamEvent', e => {
		// start block
		if (e.type === 'content_block_start') {
			if (e.content_block.type === 'text') {
				if (fullText) fullText += '\n\n' // starting a 2nd text block
				fullText += e.content_block.text
				runOnText()
			}
			else if (e.content_block.type === 'thinking') {
				if (fullReasoning) fullReasoning += '\n\n' // starting a 2nd reasoning block
				fullReasoning += e.content_block.thinking
				runOnText()
			}
			else if (e.content_block.type === 'redacted_thinking') {
				console.log('delta', e.content_block.type)
				if (fullReasoning) fullReasoning += '\n\n' // starting a 2nd reasoning block
				fullReasoning += '[redacted_thinking]'
				runOnText()
			}
			else if (e.content_block.type === 'tool_use') {
				fullToolName += e.content_block.name ?? '' // anthropic gives us the tool name in the start block
				runOnText()
			}
		}

		// delta
		else if (e.type === 'content_block_delta') {
			if (e.delta.type === 'text_delta') {
				fullText += e.delta.text
				runOnText()
			}
			else if (e.delta.type === 'thinking_delta') {
				fullReasoning += e.delta.thinking
				runOnText()
			}
			else if (e.delta.type === 'input_json_delta') { // tool use
				fullToolParams += e.delta.partial_json ?? '' // anthropic gives us the partial delta (string) here - https://docs.anthropic.com/en/api/messages-streaming
				runOnText()
			}
		}
	})

	// on done - (or when error/fail) - this is called AFTER last streamEvent
	stream.on('finalMessage', (response) => {
		const anthropicReasoning = response.content.filter(c => c.type === 'thinking' || c.type === 'redacted_thinking')
		const tools = response.content.filter(c => c.type === 'tool_use')
		// console.log('TOOLS!!!!!!', JSON.stringify(tools, null, 2))
		// console.log('TOOLS!!!!!!', JSON.stringify(response, null, 2))
		// Anthropic supports multiple tool_use blocks per message - surface all. #2
		const toolCalls: RawToolCallObj[] = tools.map(t => rawToolCallObjOfAnthropicParams(t)).filter(Boolean) as RawToolCallObj[]
		const toolCallObj = toolCalls.length > 0 ? { toolCall: toolCalls } : {}

		onFinalMessage({ fullText, fullReasoning, anthropicReasoning, ...toolCallObj })
	})
	// on error
	stream.on('error', (error) => {
		if (error instanceof Anthropic.APIError && error.status === 401) { onError({ message: invalidApiKeyMessage(providerName), fullError: error }) }
		else { onError({ message: error + '', fullError: error }) }
	})
	_setAborter(() => stream.controller.abort())
}



// ------------ MISTRAL ------------
// https://docs.mistral.ai/api/#tag/fim
const sendMistralFIM = ({ messages, onFinalMessage, onError, settingsOfProvider, overridesOfModel, modelName: modelName_, _setAborter, providerName }: SendFIMParams_Internal) => {
	const { modelName, supportsFIM } = getModelCapabilities(providerName, modelName_, overridesOfModel)
	if (!supportsFIM) {
		if (modelName === modelName_)
			onError({ message: `Model ${modelName} does not support FIM.`, fullError: null })
		else
			onError({ message: `Model ${modelName_} (${modelName}) does not support FIM.`, fullError: null })
		return
	}

	const mistral = new MistralCore({ apiKey: settingsOfProvider.mistral.apiKey })
	fimComplete(mistral,
		{
			model: modelName,
			prompt: messages.prefix,
			suffix: messages.suffix,
			stream: false,
			maxTokens: 300,
			stop: messages.stopTokens,
		})
		.then(async response => {

			// unfortunately, _setAborter() does not exist
			let content = response?.ok ? response.value.choices?.[0]?.message?.content ?? '' : '';
			const fullText = typeof content === 'string' ? content
				: content.map(chunk => (chunk.type === 'text' ? chunk.text : '')).join('')

			onFinalMessage({ fullText, fullReasoning: '', anthropicReasoning: null });
		})
		.catch(error => {
			onError({ message: error + '', fullError: error });
		})
}


// ------------ OLLAMA ------------
const newOllamaSDK = ({ endpoint }: { endpoint: string }) => {
	// if endpoint is empty, normally ollama will send to 11434, but we want it to fail - the user should type it in
	if (!endpoint) throw new Error(`Ollama Endpoint was empty (please enter ${defaultProviderSettings.ollama.endpoint} in Void if you want the default url).`)
	const ollama = new Ollama({ host: endpoint })
	return ollama
}

const ollamaList = async ({ onSuccess: onSuccess_, onError: onError_, settingsOfProvider }: ListParams_Internal<OllamaModelResponse>) => {
	const onSuccess = ({ models }: { models: OllamaModelResponse[] }) => {
		onSuccess_({ models })
	}
	const onError = ({ error }: { error: string }) => {
		onError_({ error })
	}
	try {
		const thisConfig = settingsOfProvider.ollama
		const ollama = newOllamaSDK({ endpoint: thisConfig.endpoint })
		ollama.list()
			.then((response) => {
				const { models } = response
				onSuccess({ models })
			})
			.catch((error) => {
				onError({ error: error + '' })
			})
	}
	catch (error) {
		onError({ error: error + '' })
	}
}

const sendOllamaFIM = ({ messages, onFinalMessage, onError, settingsOfProvider, modelName, _setAborter }: SendFIMParams_Internal) => {
	const thisConfig = settingsOfProvider.ollama
	const ollama = newOllamaSDK({ endpoint: thisConfig.endpoint })

	let fullText = ''
	ollama.generate({
		model: modelName,
		prompt: messages.prefix,
		suffix: messages.suffix,
		options: {
			stop: messages.stopTokens,
			num_predict: 300, // max tokens
			// repeat_penalty: 1,
		},
		raw: true,
		stream: true, // stream is not necessary but lets us expose the
	})
		.then(async stream => {
			_setAborter(() => stream.abort())
			for await (const chunk of stream) {
				const newText = chunk.response
				fullText += newText
			}
			onFinalMessage({ fullText, fullReasoning: '', anthropicReasoning: null })
		})
		// when error/fail
		.catch((error) => {
			onError({ message: error + '', fullError: error })
		})
}

// ---------------- GEMINI NATIVE IMPLEMENTATION ----------------

const toGeminiFunctionDecl = (toolInfo: InternalToolInfo) => {
	const { name, description, params } = toolInfo
	return {
		name,
		description,
		parameters: {
			type: Type.OBJECT,
			properties: Object.entries(params).reduce((acc, [key, value]) => {
				acc[key] = {
					type: Type.STRING,
					description: value.description
				};
				return acc;
			}, {} as Record<string, Schema>)
		}
	} satisfies FunctionDeclaration
}

const geminiTools = (chatMode: ChatMode | null, mcpTools: InternalToolInfo[] | undefined): GeminiTool[] | null => {
	const allowedTools = availableTools(chatMode, mcpTools)
	if (!allowedTools || Object.keys(allowedTools).length === 0) return null
	const functionDecls: FunctionDeclaration[] = []
	for (const t in allowedTools ?? {}) {
		functionDecls.push(toGeminiFunctionDecl(allowedTools[t]))
	}
	const tools: GeminiTool = { functionDeclarations: functionDecls, }
	return [tools]
}



// Implementation for Gemini using Google's native API
const sendGeminiChat = async ({
	messages,
	separateSystemMessage,
	onText,
	onFinalMessage,
	onError,
	settingsOfProvider,
	overridesOfModel,
	modelName: modelName_,
	_setAborter,
	providerName,
	modelSelectionOptions,
	chatMode,
	mcpTools,
}: SendChatParams_Internal) => {

	if (providerName !== 'gemini') throw new Error(`Sending Gemini chat, but provider was ${providerName}`)

	const thisConfig = settingsOfProvider[providerName]

	const {
		modelName,
		specialToolFormat,
		// reasoningCapabilities,
	} = getModelCapabilities(providerName, modelName_, overridesOfModel)

	// const { providerReasoningIOSettings } = getProviderCapabilities(providerName)

	// reasoning
	// const { canIOReasoning, openSourceThinkTags, } = reasoningCapabilities || {}
	const reasoningInfo = getSendableReasoningInfo('Chat', providerName, modelName_, modelSelectionOptions, overridesOfModel) // user's modelName_ here
	// const includeInPayload = providerReasoningIOSettings?.input?.includeInPayload?.(reasoningInfo) || {}

	const thinkingConfig: ThinkingConfig | undefined = !reasoningInfo?.isReasoningEnabled ? undefined
		: reasoningInfo.type === 'budget_slider_value' ?
			{ thinkingBudget: reasoningInfo.reasoningBudget }
			: undefined

	// tools
	const potentialTools = geminiTools(chatMode, mcpTools)
	const toolConfig = potentialTools && specialToolFormat === 'gemini-style' ?
		potentialTools
		: undefined

	// instance
	const genAI = new GoogleGenAI({ apiKey: thisConfig.apiKey });


	// manually parse out tool results if XML
	if (!specialToolFormat) {
		const { newOnText, newOnFinalMessage } = extractXMLToolsWrapper(onText, onFinalMessage, chatMode, mcpTools)
		onText = newOnText
		onFinalMessage = newOnFinalMessage
	}

	// when receive text
	let fullReasoningSoFar = ''
	let fullTextSoFar = ''

	let toolName = ''
	let toolParamsStr = ''
	let toolId = ''


	genAI.models.generateContentStream({
		model: modelName,
		config: {
			systemInstruction: separateSystemMessage,
			thinkingConfig: thinkingConfig,
			tools: toolConfig,
		},
		contents: messages as GeminiLLMChatMessage[],
	})
		.then(async (stream) => {
			_setAborter(() => { stream.return(fullTextSoFar); });

			// Process the stream
			for await (const chunk of stream) {
				// message
				const newText = chunk.text ?? ''
				fullTextSoFar += newText

				// tool call
				const functionCalls = chunk.functionCalls
				if (functionCalls && functionCalls.length > 0) {
					const functionCall = functionCalls[0] // Get the first function call
					toolName = functionCall.name ?? ''
					toolParamsStr = JSON.stringify(functionCall.args ?? {})
					toolId = functionCall.id ?? ''
				}

				// (do not handle reasoning yet)

				// call onText
				onText({
					fullText: fullTextSoFar,
					fullReasoning: fullReasoningSoFar,
					toolCall: !toolName ? undefined : { name: toolName, rawParams: {}, isDone: false, doneParams: [], id: toolId },
				})
			}

			// on final
			if (!fullTextSoFar && !fullReasoningSoFar && !toolName) {
				onError({ message: 'Void: Response from model was empty.', fullError: null })
			} else {
				if (!toolId) toolId = generateUuid() // ids are empty, but other providers might expect an id
				const toolCall = rawToolCallObjOfParamsStr(toolName, toolParamsStr, toolId)
				const toolCallObj = toolCall ? { toolCall: [toolCall] } : {}
				onFinalMessage({ fullText: fullTextSoFar, fullReasoning: fullReasoningSoFar, anthropicReasoning: null, ...toolCallObj });
			}
		})
		.catch(error => {
			const message = error?.message
			if (typeof message === 'string') {

				if (error.message?.includes('API key')) {
					onError({ message: invalidApiKeyMessage(providerName), fullError: error });
				}
				else if (error?.message?.includes('429')) {
					onError({ message: 'Rate limit reached. ' + error, fullError: error });
				}
				else
					onError({ message: error + '', fullError: error });
			}
			else {
				onError({ message: error + '', fullError: error });
			}
		})
};



type CallFnOfProvider = {
	[providerName in ProviderName]: {
		sendChat: (params: SendChatParams_Internal) => Promise<void>;
		sendFIM: ((params: SendFIMParams_Internal) => void) | null;
		list: ((params: ListParams_Internal<any>) => void) | null;
	}
}

// ---- which FIM / list implementation each provider uses (chat is shared) ----
type OAICompatImplementationConfig = {
	sendFIM: 'openai-compatible' | 'ollama' | 'mistral' | null;
	list: 'openai-compatible' | 'ollama' | null;
}
// providers that use the shared OpenAI-compatible chat path.
// adding a provider here (plus a row in `openAICompatibleProviderConfigs`) is all that's needed.
const openAICompatibleImplementationConfigs: Record<Exclude<ProviderName, 'anthropic' | 'gemini'>, OAICompatImplementationConfig> = {
	openAI: { sendFIM: null, list: null },
	xAI: { sendFIM: null, list: null },
	mistral: { sendFIM: 'mistral', list: null },
	ollama: { sendFIM: 'ollama', list: 'ollama' },
	openAICompatible: { sendFIM: 'openai-compatible', list: 'openai-compatible' },
	openRouter: { sendFIM: 'openai-compatible', list: null },
	vLLM: { sendFIM: 'openai-compatible', list: 'openai-compatible' },
	deepseek: { sendFIM: null, list: null },
	groq: { sendFIM: null, list: null },
	lmStudio: { sendFIM: 'openai-compatible', list: 'openai-compatible' },
	liteLLM: { sendFIM: 'openai-compatible', list: null },
	googleVertex: { sendFIM: null, list: null },
	microsoftAzure: { sendFIM: null, list: null },
	awsBedrock: { sendFIM: null, list: null },
}

const openAICompatibleProviderImplementation = (providerName: Exclude<ProviderName, 'anthropic' | 'gemini'>) => {
	const { sendFIM, list } = openAICompatibleImplementationConfigs[providerName]
	return {
		sendChat: (params: SendChatParams_Internal) => _sendOpenAICompatibleChat(params),
		sendFIM:
			sendFIM === 'ollama' ? sendOllamaFIM
				: sendFIM === 'mistral' ? sendMistralFIM
					: sendFIM === 'openai-compatible' ? (params: SendFIMParams_Internal) => _sendOpenAICompatibleFIM(params)
						: null,
		list:
			list === 'ollama' ? ollamaList
				: list === 'openai-compatible' ? (params: ListParams_Internal<any>) => _openaiCompatibleList(params)
					: null,
	}
}

// pick out just the openai-compatible providers (everything except anthropic and gemini)
const openAICompatibleProviderNames = Object.keys(openAICompatibleProviderConfigs) as Exclude<ProviderName, 'anthropic' | 'gemini'>[]

export const sendLLMMessageToProviderImplementation: CallFnOfProvider = {
	anthropic: {
		sendChat: sendAnthropicChat,
		sendFIM: null,
		list: null,
	},
	gemini: {
		sendChat: sendGeminiChat,
		sendFIM: null,
		list: null,
	},
	...Object.fromEntries(openAICompatibleProviderNames.map(providerName => [providerName, openAICompatibleProviderImplementation(providerName)])),
} satisfies CallFnOfProvider




/*
FIM info (this may be useful in the future with vLLM, but in most cases the only way to use FIM is if the provider explicitly supports it):

qwen2.5-coder https://ollama.com/library/qwen2.5-coder/blobs/e94a8ecb9327
<|fim_prefix|>{{ .Prompt }}<|fim_suffix|>{{ .Suffix }}<|fim_middle|>

codestral https://ollama.com/library/codestral/blobs/51707752a87c
[SUFFIX]{{ .Suffix }}[PREFIX] {{ .Prompt }}

deepseek-coder-v2 https://ollama.com/library/deepseek-coder-v2/blobs/22091531faf0
<｜fim▁begin｜>{{ .Prompt }}<｜fim▁hole｜>{{ .Suffix }}<｜fim▁end｜>

starcoder2 https://ollama.com/library/starcoder2/blobs/3b190e68fefe
<file_sep>
<fim_prefix>
{{ .Prompt }}<fim_suffix>{{ .Suffix }}<fim_middle>
<|end_of_text|>

codegemma https://ollama.com/library/codegemma:2b/blobs/48d9a8140749
<|fim_prefix|>{{ .Prompt }}<|fim_suffix|>{{ .Suffix }}<|fim_middle|>

*/
