/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  RoboAgent — after every colcon build (the toolbar Build and the `colcon` tasks), put the
 *  CMake errors and warnings of each package in Problems. Compiler errors carry absolute paths
 *  and are already placed by the `$colcon` problem matcher; CMake's are relative to the package
 *  and are read from colcon's logs instead (see cmakeDiagnostics.ts). The packages'
 *  compile_commands.json files are merged for clangd at the same time (see compileCommands.ts).
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CMakeProblem, readColconCMakeProblems } from './cmakeDiagnostics';
import { mergeColconCompileCommands } from './compileCommands';
import { log } from './modes/output';

/** Whether `task` is a colcon build: a `colcon` task in build mode or the toolbar's colcon build. */
export function isColconBuild(task: vscode.Task): boolean {
	const definition = task.definition as { type?: string; mode?: string };
	if (definition.type === 'colcon') {
		return definition.mode === 'build';
	}
	return definition.type === 'roboagent-mode' && task.name.startsWith('RoboAgent: colcon build');
}

function taskCwd(task: vscode.Task): string | undefined {
	const execution = task.execution;
	if (execution instanceof vscode.ShellExecution || execution instanceof vscode.ProcessExecution) {
		return execution.options?.cwd;
	}
	return undefined;
}

function toDiagnostics(problems: readonly CMakeProblem[]): [vscode.Uri, vscode.Diagnostic[]][] {
	const byFile = new Map<string, vscode.Diagnostic[]>();
	for (const p of problems) {
		const range = new vscode.Range(p.line - 1, 0, p.line - 1, Number.MAX_SAFE_INTEGER);
		const diagnostic = new vscode.Diagnostic(range, p.message, p.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning);
		diagnostic.source = 'CMake';
		if (p.command) { diagnostic.code = p.command; }
		const list = byFile.get(p.file) ?? [];
		list.push(diagnostic);
		byFile.set(p.file, list);
	}
	return [...byFile].map(([file, diagnostics]) => [vscode.Uri.file(file), diagnostics]);
}

export function registerColconProblems(): vscode.Disposable {
	const collection = vscode.languages.createDiagnosticCollection('roboagent-colcon-cmake');
	// Bumped whenever a colcon build starts, so the logs of a build that has since been replaced by
	// a newer one are not published over it.
	let generation = 0;
	const onStart = vscode.tasks.onDidStartTask(e => {
		if (isColconBuild(e.execution.task)) {
			generation++;
			collection.clear();
		}
	});
	const onEnd = vscode.tasks.onDidEndTaskProcess(async e => {
		const task = e.execution.task;
		if (!isColconBuild(task)) { return; }
		const root = taskCwd(task);
		if (!root) { return; }
		const started = generation;
		try {
			const merged = await mergeColconCompileCommands(root, log);
			if (merged) {
				log(`colcon build: ${merged} compile command(s) merged into build/compile_commands.json for clangd`);
			}
		} catch (err) {
			log(`colcon build: could not merge compile_commands.json: ${err instanceof Error ? err.message : String(err)}`);
		}
		const problems = await readColconCMakeProblems(root);
		if (started !== generation) { return; }
		collection.clear();
		collection.set(toDiagnostics(problems));
		if (problems.length) {
			log(`colcon build: ${problems.length} CMake problem(s) put in Problems`);
		}
	});
	return vscode.Disposable.from(collection, onStart, onEnd);
}
