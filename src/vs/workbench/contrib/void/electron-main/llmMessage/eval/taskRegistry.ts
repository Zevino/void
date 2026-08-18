/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Example eval tasks + a mock in-memory file-system tool executor.
//
// The mock executor lets you compare how different LLMs drive tool calls WITHOUT any
// side effects: every read/edit happens against an in-memory map, so eval runs are
// deterministic and safe to run in CI. Real filesystem tools (read_file, edit_file,
// run_command, ...) are available via the builtin set but need a real environment —
// for pure LLM tool-call comparison, the mock executor is the recommended default.

import { EvalTask, EvalScoreContext, EvalScore } from './types.js';

/** In-memory fake file system used by the mock tools. */
export type FakeFS = { [path: string]: string };

export const defaultFakeFS = (): FakeFS => ({
	'/repo/package.json': JSON.stringify({
		name: 'sample-repo',
		version: '1.0.0',
		dependencies: { lodash: '^4.17.21' },
	}, null, 2),
	'/repo/src/add.ts': 'export const add = (a: number, b: number) => a + b\n',
	'/repo/src/index.ts': `import { add } from './add'\nconsole.log(add(1, 2))\n`,
	'/repo/README.md': '# sample-repo\n\nA demo repo used to evaluate agent tool calling.\n',
});

/** Creates a mock tool executor backed by an in-memory FS. */
export const makeMockExecutor = (fs: FakeFS) => {
	const exec = async (toolName: string, params: Record<string, unknown>) => {
		switch (toolName) {
			case 'read_file': {
				const p = String(params.uri ?? '');
				if (!(p in fs)) return { ok: false, result: `ENOENT: no such file '${p}'` };
				return { ok: true, result: fs[p] };
			}
			case 'ls_dir': {
				const files = Object.keys(fs);
				return { ok: true, result: files.join('\n') };
			}
			case 'search_for_files': {
				const q = String(params.query ?? '');
				const hits = Object.keys(fs).filter(p => fs[p].includes(q));
				return { ok: true, result: hits.length ? hits.join('\n') : 'no matches' };
			}
			case 'get_git_status': {
				return { ok: true, result: 'On branch main\nChanges: none\nLast commit: fix(eval): initial' };
			}
			case 'edit_file': {
				const p = String(params.uri ?? '');
				if (!(p in fs)) return { ok: false, result: `ENOENT: no such file '${p}'` };
				// naive: just mark it edited
				return { ok: true, result: `edited ${p}` };
			}
			case 'rewrite_file': {
				const p = String(params.uri ?? '');
				fs[p] = String(params.new_content ?? '');
				return { ok: true, result: `wrote ${p}` };
			}
			case 'run_command': {
				return { ok: true, result: `(mock) executed: ${String(params.command ?? '')}` };
			}
			default: {
				// unknown mock tool — simulate failure so the model learns to use known tools
				return { ok: false, result: `unknown mock tool "${toolName}"` };
			}
		}
	};
	return exec;
};

/** A simple "did the model read + edit the right file?" scorer. */
export const checkReadThenEdit = (readPath: string, editPath: string) =>
	(ctx: EvalScoreContext): EvalScore => {
		const calls = ctx.toolCalls;
		const usedRead = calls.some(c => c.name === 'read_file' && String(c.params.uri ?? '') === readPath);
		const usedEdit = calls.some(c => c.name === 'edit_file' || c.name === 'rewrite_file');
		if (!usedRead) return { pass: false, reason: `never read ${readPath}` };
		if (!usedEdit) return { pass: false, reason: 'never edited any file' };
		return { pass: true, reason: `read ${readPath} then edited ${editPath}` };
	};

/**
 * Sample eval tasks. Each provides a prompt, an optional mock tool set, and an
 * optional scorer. Add your own tasks here (or in a JSON config file).
 */
export const defaultTasks: EvalTask[] = [
	{
		id: 'read-index',
		description: 'Read a single file and summarize its imports',
		prompt: 'Open the file /repo/src/index.ts and tell me what it imports.',
		executeTool: makeMockExecutor(defaultFakeFS()),
		score: (ctx) => {
			const usedRead = ctx.toolCalls.some(c => c.name === 'read_file');
			return { pass: usedRead, reason: usedRead ? 'used read_file' : 'did not read any file' };
		},
	},
	{
		id: 'search-lodash',
		description: 'Find where lodash is used and answer a question about dependencies',
		prompt: 'Look at /repo/package.json. What version of lodash is it pinned to? Use the tools to find out.',
		executeTool: makeMockExecutor(defaultFakeFS()),
		score: (ctx) => {
			const ans = ctx.finalAnswer;
			const ok = /4\.17\.21|4\.17/.test(ans) || ctx.toolCalls.some(c => c.name === 'read_file' && String(c.params.uri ?? '').includes('package.json'));
			return { pass: ok, reason: ok ? 'answered about lodash version' : 'did not answer about lodash version' };
		},
	},
	{
		id: 'edit-file',
		description: 'Make a small edit using the edit_file tool',
		prompt: 'In /repo/README.md, add a line "This repo is evaluated by Void\'s harness." Use a tool to edit the file.',
		executeTool: makeMockExecutor(defaultFakeFS()),
		score: checkReadThenEdit('/repo/README.md', '/repo/README.md'),
	},
];

/** Look up tasks by id, or all tasks if no id given. */
export const resolveTasks = (ids: string[] | undefined): EvalTask[] => {
	if (!ids || ids.length === 0) return defaultTasks;
	const wanted = new Set(ids);
	const found = defaultTasks.filter(t => wanted.has(t.id));
	const missing = ids.filter(id => !found.some(t => t.id === id));
	if (missing.length) throw new Error(`Unknown eval task id(s): ${missing.join(', ')}`);
	return found;
};
