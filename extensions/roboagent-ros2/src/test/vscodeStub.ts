/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  A minimal `vscode` module stub so the mode providers (which import `vscode` for UI calls)
 *  can be unit-tested under plain Node + mocha. Only the members the tested code paths touch
 *  are implemented; everything UI-related records what it was asked.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';

export interface StubWorkspaceFolder {
	readonly uri: { readonly scheme: string; readonly fsPath: string; readonly path: string };
	readonly name: string;
	readonly index: number;
}

export interface VscodeStub {
	readonly window: {
		activeTextEditor: { document: { uri: { scheme: string; fsPath: string; path: string; languageId?: string } } } | undefined;
		readonly quickPicks: unknown[][];
		showQuickPick(items: unknown[]): Promise<unknown>;
		showTextDocument(): Promise<void>;
		withProgress<T>(_options: unknown, task: () => Promise<T>): Promise<T>;
	};
	readonly workspace: {
		workspaceFolders: StubWorkspaceFolder[] | undefined;
		getWorkspaceFolder(uri: { fsPath: string }): StubWorkspaceFolder | undefined;
		readonly fs: { stat(uri: { fsPath: string }): Promise<{ type: number }> };
		findFiles(): Promise<unknown[]>;
		getConfiguration(): { get(): undefined };
	};
	readonly commands: { readonly executed: [string, unknown[]][]; executeCommand(id: string, ...args: unknown[]): Promise<unknown> };
	readonly l10n: { t(message: string, ...args: unknown[]): string };
	readonly Uri: { file(p: string): StubUri; joinPath(base: StubUri, ...segments: string[]): StubUri };
	readonly ProgressLocation: { Notification: number };
	readonly FileType: { File: number; Directory: number };
	readonly RelativePattern: new (base: unknown, pattern: string) => { base: unknown; pattern: string };
	readonly env: { openExternal(): Promise<boolean> };
	setFolders(...folders: string[]): void;
}

export class StubUri {
	readonly scheme = 'file';
	constructor(readonly path: string) { }
	get fsPath(): string { return this.path; }
	with(change: { path?: string }): StubUri { return new StubUri(change.path ?? this.path); }
	toString(): string { return `file://${this.path}`; }
}

export function createVscodeStub(): VscodeStub {
	const folders: StubWorkspaceFolder[] = [];
	const executed: [string, unknown[]][] = [];
	const quickPicks: unknown[][] = [];
	const uriOf = (p: string) => new StubUri(p);
	const stub: VscodeStub = {
		window: {
			activeTextEditor: undefined,
			quickPicks,
			async showQuickPick(items: unknown[]) { quickPicks.push(items); return undefined; },
			async showTextDocument() { /* no-op */ },
			withProgress: (_o, task) => task(),
		},
		workspace: {
			workspaceFolders: folders,
			getWorkspaceFolder: uri => folders.find(f => uri.fsPath === f.uri.fsPath || uri.fsPath.startsWith(f.uri.fsPath + '/')),
			fs: {
				async stat(uri) {
					const st = await fs.promises.stat(uri.fsPath);
					return { type: st.isDirectory() ? 2 : 1 };
				},
			},
			async findFiles() { return []; },
			getConfiguration: () => ({ get: () => undefined }),
		},
		commands: { executed, async executeCommand(id, ...args) { executed.push([id, args]); return undefined; } },
		l10n: { t: (message, ...args) => message.replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)])) },
		Uri: { file: uriOf, joinPath: (base, ...segments) => new StubUri(path.posix.join(base.path, ...segments)) },
		ProgressLocation: { Notification: 15 },
		FileType: { File: 1, Directory: 2 },
		RelativePattern: class { constructor(readonly base: unknown, readonly pattern: string) { } },
		env: { async openExternal() { return true; } },
		setFolders(...paths: string[]) {
			folders.splice(0, folders.length, ...paths.map((p, i) => ({ uri: uriOf(p), name: p.split('/').pop() ?? p, index: i })));
		},
	};
	return stub;
}

let installed: VscodeStub | undefined;

/** Make `require('vscode')` resolve to the stub for the rest of the process. Idempotent. */
export function installVscodeStub(): VscodeStub {
	if (installed) {
		return installed;
	}
	installed = createVscodeStub();
	// The CommonJS Module constructor itself (an ESM namespace import of 'module' is read-only).
	const moduleAny = require('module') as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
	const originalLoad = moduleAny._load;
	moduleAny._load = function (request: string, parent: unknown, isMain: boolean) {
		if (request === 'vscode') {
			return installed;
		}
		return originalLoad.call(this, request, parent, isMain);
	};
	return installed;
}
