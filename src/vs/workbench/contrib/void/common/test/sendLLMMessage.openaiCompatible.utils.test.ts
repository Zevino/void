/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import {
	parseHeadersJSON,
	normalizeV1BaseURL,
	rawToolCallObjOfParamsStr,
	aggregateToolCalls,
	AccumulatedToolCall,
} from '../sendLLMMessage.openaiCompatible.utils.js';

suite('parseHeadersJSON', () => {

	test('returns undefined for empty input', () => {
		assert.strictEqual(parseHeadersJSON(undefined), undefined);
		assert.strictEqual(parseHeadersJSON(''), undefined);
	});

	test('parses a valid JSON object', () => {
		assert.deepStrictEqual(parseHeadersJSON('{"X-Request-Id": "abc"}'), { 'X-Request-Id': 'abc' });
		assert.deepStrictEqual(parseHeadersJSON('{ "Authorization": "Bearer x" }'), { 'Authorization': 'Bearer x' });
	});

	test('throws on invalid JSON', () => {
		assert.throws(() => parseHeadersJSON('not json'), /not a valid JSON/);
		assert.throws(() => parseHeadersJSON('{'), /not a valid JSON/);
	});

	test('throws on a non-object JSON value', () => {
		assert.throws(() => parseHeadersJSON('[]'), /not a valid JSON object/);
		assert.throws(() => parseHeadersJSON('"hello"'), /not a valid JSON object/);
		assert.throws(() => parseHeadersJSON('123'), /not a valid JSON object/);
		assert.throws(() => parseHeadersJSON('null'), /not a valid JSON object/);
	});

	test('filters out null/undefined values', () => {
		// the OpenAI SDK would serialize a null header value as the string "null", so we drop it
		assert.deepStrictEqual(parseHeadersJSON('{"keep": "yes", "drop": null}'), { 'keep': 'yes' });
	});

});

suite('normalizeV1BaseURL', () => {

	test('returns empty input unchanged', () => {
		assert.strictEqual(normalizeV1BaseURL(''), '');
	});

	test('appends /v1 when missing', () => {
		assert.strictEqual(normalizeV1BaseURL('https://my-website.com'), 'https://my-website.com/v1');
		assert.strictEqual(normalizeV1BaseURL('http://localhost:8000'), 'http://localhost:8000/v1');
	});

	test('trims trailing slashes before appending /v1', () => {
		assert.strictEqual(normalizeV1BaseURL('https://my-website.com/'), 'https://my-website.com/v1');
		assert.strictEqual(normalizeV1BaseURL('https://my-website.com///'), 'https://my-website.com/v1');
	});

	test('leaves an existing /v1 untouched', () => {
		assert.strictEqual(normalizeV1BaseURL('https://my-website.com/v1'), 'https://my-website.com/v1');
		assert.strictEqual(normalizeV1BaseURL('http://localhost:4000/v1'), 'http://localhost:4000/v1');
	});

});

suite('rawToolCallObjOfParamsStr', () => {

	test('parses valid JSON arguments', () => {
		const result = rawToolCallObjOfParamsStr('doThing', '{"a": "1", "b": "2"}', 'call_1');
		assert.ok(result);
		assert.strictEqual(result!.name, 'doThing');
		assert.strictEqual(result!.id, 'call_1');
		assert.strictEqual(result!.isDone, true);
		assert.deepStrictEqual(result!.rawParams, { a: '1', b: '2' });
		assert.deepStrictEqual(result!.doneParams, ['a', 'b']);
	});

	test('returns null for invalid JSON', () => {
		assert.strictEqual(rawToolCallObjOfParamsStr('x', 'not-json', 'id'), null);
		assert.strictEqual(rawToolCallObjOfParamsStr('x', '', 'id'), null);
	});

	test('returns null for non-object JSON', () => {
		assert.strictEqual(rawToolCallObjOfParamsStr('x', 'null', 'id'), null);
		assert.strictEqual(rawToolCallObjOfParamsStr('x', '"str"', 'id'), null);
		assert.strictEqual(rawToolCallObjOfParamsStr('x', '[1,2]', 'id'), null);
	});

});

suite('aggregateToolCalls (parallel tool calls)', () => {

	const newMap = () => new Map<number, AccumulatedToolCall>();

	test('aggregates a single tool call across incremental chunks', () => {
		let map = newMap();
		let active = null;

		({ toolCallsByIndex: map, activeToolIndex: active } = aggregateToolCalls(
			map,
			[{ index: 0, id: 'call_0', function: { name: 'readFile', arguments: '{"path":' } }],
			active,
		));
		({ toolCallsByIndex: map, activeToolIndex: active } = aggregateToolCalls(
			map,
			[{ index: 0, function: { arguments: '"a.txt"}' } }],
			active,
		));

		assert.strictEqual(active, 0);
		const call = map.get(0)!;
		assert.strictEqual(call.name, 'readFile');
		assert.strictEqual(call.id, 'call_0');
		assert.strictEqual(call.arguments, '{"path":"a.txt"}');
	});

	test('does not corrupt arguments when parallel tool calls are interleaved', () => {
		let map = newMap();
		let active = null;

		// two parallel calls (index 0 and 1), their argument chunks interleaved across chunks
		const chunks = [
			{ index: 0, id: 'call_0', function: { name: 'readFile', arguments: '{"path":' } },
			{ index: 1, id: 'call_1', function: { name: 'listDir', arguments: '{"dir":' } },
			{ index: 0, function: { arguments: '"a.txt"' } },
			{ index: 1, function: { arguments: '"./src"' } },
			{ index: 0, function: { arguments: '}' } },
			{ index: 1, function: { arguments: '}' } },
		];
		for (const c of chunks) {
			({ toolCallsByIndex: map, activeToolIndex: active } = aggregateToolCalls(map, [c], active));
		}

		assert.strictEqual(active, 0);
		const call0 = map.get(0)!;
		const call1 = map.get(1)!;
		// each call's arguments must be internally consistent (not mixed with the other call)
		assert.strictEqual(call0.name, 'readFile');
		assert.strictEqual(call0.arguments, '{"path":"a.txt"}');
		assert.strictEqual(call1.name, 'listDir');
		assert.strictEqual(call1.arguments, '{"dir":"./src"}');
	});

	test('tracks the lowest index as the active tool call', () => {
		let map = newMap();
		let active = null;

		// first we see index 1, then index 0 — active must drop to 0
		({ toolCallsByIndex: map, activeToolIndex: active } = aggregateToolCalls(
			map, [{ index: 1, id: 'call_1', function: { name: 'b', arguments: '{}' } }], active,
		));
		assert.strictEqual(active, 1);
		({ toolCallsByIndex: map, activeToolIndex: active } = aggregateToolCalls(
			map, [{ index: 0, id: 'call_0', function: { name: 'a', arguments: '{}' } }], active,
		));
		assert.strictEqual(active, 0);
	});

	test('empty deltas leave state unchanged', () => {
		let map = newMap();
		let active = null;
		({ toolCallsByIndex: map, activeToolIndex: active } = aggregateToolCalls(map, [], active));
		assert.strictEqual(active, null);
		assert.strictEqual(map.size, 0);
	});

});
