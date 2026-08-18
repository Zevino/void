/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// LLM agent eval harness — CLI runner.
//
// Usage (after building src, e.g. via `npm run compile`):
//   node ./out/vs/workbench/contrib/void/electron-main/llmMessage/eval/runEval.js \
//     --config ./eval.config.json [--out ./eval-report.json] [--tasks read-index,edit-file]
//
// The config file is a JSON array of models to evaluate:
//   [
//     { "id": "deepseek", "providerName": "deepseek", "modelName": "deepseek-chat", "apiKey": "<env KEY or literal>" },
//     { "id": "openai",   "providerName": "openAI",    "modelName": "gpt-4o-mini",     "apiKey": "<...>" }
//   ]
//
// `providerName` must be a Void ProviderName. `apiKey` may reference an env var by
// prefixing it with `env:` (e.g. "env:DEEPSEEK_API_KEY") to avoid hardcoding secrets.
//
// Output: a JSON report comparing each model on each task (steps, tool calls, pass/fail,
// duration, final answer). Also prints a human-readable table to stdout.

import { readFileSync, writeFileSync } from 'fs';
import { EvalModel, EvalReport } from './types.js';
import { runEvalTask } from './runAgent.js';
import { resolveTasks } from './taskRegistry.js';
import { defaultProviderSettings } from '../../../common/modelCapabilities.js';
import { IMetricsService } from '../../../common/metricsService.js';

type ConfigModel = {
	id: string;
	providerName: EvalModel['providerName'];
	modelName: string;
	apiKey?: string;
	endpoint?: string;
};

const parseArgs = (argv: string[]) => {
	const args: Record<string, string> = {};
	for (let i = 0; i < argv.length; i += 1) {
		const a = argv[i];
		if (a.startsWith('--')) {
			const key = a.slice(2);
			const value = argv[i + 1];
			args[key] = value ?? 'true';
			i += 1;
		}
	}
	return args;
};

const resolveSecret = (value: string | undefined): string | undefined => {
	if (!value) return undefined;
	if (value.startsWith('env:')) {
		const name = value.slice('env:'.length);
		return process.env[name];
	}
	return value;
};

const buildModelSettings = (cfg: ConfigModel): EvalModel['settingsOfProvider'] => {
	// Build a full SettingsOfProvider using the provider's defaults, then override
	// apiKey/endpoint for the relevant provider.
	const settings = structuredClone(defaultProviderSettings) as Record<string, Record<string, unknown>>;
	const providerSettings = settings[cfg.providerName];
	if (providerSettings) {
		if ('apiKey' in providerSettings) providerSettings.apiKey = resolveSecret(cfg.apiKey) ?? '';
		if ('endpoint' in providerSettings && cfg.endpoint) providerSettings.endpoint = cfg.endpoint;
	}
	return settings as EvalModel['settingsOfProvider'];
};

const loadModels = (configPath: string): EvalModel[] => {
	const raw = readFileSync(configPath, 'utf8');
	const list = JSON.parse(raw) as ConfigModel[];
	if (!Array.isArray(list)) throw new Error('config must be a JSON array of models');
	return list.map(cfg => ({
		id: cfg.id,
		providerName: cfg.providerName,
		modelName: cfg.modelName,
		settingsOfProvider: buildModelSettings(cfg),
	}));
};

// no-op metrics — we don't want to send eval events anywhere
const metrics: IMetricsService = {
	_serviceBrand: undefined,
	capture: () => { },
	setOptOut: () => { },
	getDebuggingProperties: async () => ({}),
};

const run = async (argv: string[]) => {
	const args = parseArgs(argv);
	const configPath = args['config'];
	if (!configPath) {
		console.error('Missing --config <path> (JSON array of models to evaluate).');
		process.exit(1);
	}
	const outPath = args['out'] ?? './eval-report.json';
	const taskIds = args['tasks'] ? args['tasks'].split(',').map(s => s.trim()).filter(Boolean) : undefined;

	const models = loadModels(configPath);
	const tasks = resolveTasks(taskIds);
	const results = [];

	console.log(`Evaluating ${models.length} model(s) × ${tasks.length} task(s)...\n`);

	for (const model of models) {
		for (const task of tasks) {
			process.stdout.write(`  [${model.id}] ${task.id} ... `);
			const t0 = Date.now();
			try {
				const res = await runEvalTask({ task, model, metrics });
				const secs = ((Date.now() - t0) / 1000).toFixed(1);
				console.log(`${res.pass ? 'PASS' : 'FAIL'} (${res.steps} steps, ${res.toolCallCount} tool calls, ${secs}s)`);
				results.push(res);
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				console.log(`ERROR (${msg})`);
				results.push({
					taskId: task.id,
					modelId: model.id,
					startedAt: new Date().toISOString(),
					finishedAt: new Date().toISOString(),
					durationMs: Date.now() - t0,
					steps: 0,
					stoppedReason: 'error' as const,
					pass: false,
					scoreReason: `runner error: ${msg}`,
					toolCalls: [],
					toolCallCount: 0,
					toolsUsed: [],
					finalAnswer: '',
					transcript: [],
					error: msg,
				});
			}
		}
	}

	const report: EvalReport = {
		runAt: new Date().toISOString(),
		tasks: tasks.map(t => t.id),
		models: models.map(m => ({ id: m.id, providerName: m.providerName, modelName: m.modelName })),
		results,
	};

	writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
	console.log(`\nReport written to ${outPath}`);

	// summary table
	console.log('\n==== Summary ====');
	console.log('model       task                steps  tools  pass  ');
	console.log('----------- ------------------- ----- ------ ----- ');
	for (const r of results) {
		const tools = r.toolCallCount.toString().padStart(4);
		console.log(
			`${r.modelId.padEnd(11)} ${r.taskId.padEnd(19)} ${String(r.steps).padStart(5)} ${tools}  ${r.pass ? 'PASS' : 'FAIL'}`,
		);
	}

	// exit non-zero if any failed
	const anyFail = results.some(r => !r.pass || !!r.error);
	process.exit(anyFail ? 1 : 0);
};

run(process.argv.slice(2)).catch(e => {
	console.error('Fatal:', e);
	process.exit(1);
});
