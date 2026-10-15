/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ApprovalRequest, DirEntry, ExecOptions, ExecResult, IAgentHost, IFileSystem, LogLevel } from '../kernel/host';

const normalize = (p: string) => p.replace(/^\.(\/+|$)/, '').replace(/\/+$/, '');

export class MemoryFileSystem implements IFileSystem {
	readonly files = new Map<string, string>();

	async readFile(path: string): Promise<string> {
		const content = this.files.get(normalize(path)) ?? this.files.get(await this.realPath(path));
		if (content === undefined) {
			throw new Error(`ENOENT: ${path}`);
		}
		return content;
	}
	async writeFile(path: string, content: string): Promise<void> {
		this.files.set(normalize(path), content);
	}
	async exists(path: string): Promise<boolean> {
		const p = normalize(path);
		return this.files.has(p) || [...this.files.keys()].some(f => p === '' || f.startsWith(`${p}/`));
	}
	/** Symlinks for tests: link path → target path (workspace-relative). */
	readonly links = new Map<string, string>();

	async realPath(path: string): Promise<string> {
		let p = normalize(path);
		for (const [link, target] of this.links) {
			if (p === link || p.startsWith(`${link}/`)) {
				p = target + p.slice(link.length);
			}
		}
		return p || '.';
	}

	/** Directories are implied by file paths. */
	async readDir(path: string): Promise<DirEntry[]> {
		const p = normalize(path);
		const prefix = p ? `${p}/` : '';
		const entries = new Map<string, boolean>();
		for (const file of this.files.keys()) {
			if (file.startsWith(prefix)) {
				const [name, ...rest] = file.slice(prefix.length).split('/');
				entries.set(name, rest.length > 0 || entries.get(name) === true);
			}
		}
		if (!entries.size && p) {
			throw new Error(`ENOENT: ${path}`);
		}
		return [...entries].map(([name, isDirectory]) => ({ name, isDirectory }));
	}
}

export type ExecHandler = (command: string, args: readonly string[], options: ExecOptions) => Partial<ExecResult> | undefined;

/** In-memory host that records approvals, commands and logs; `onExec` scripts command results. */
export class FakeHost implements IAgentHost {
	readonly fs = new MemoryFileSystem();
	readonly approvals: ApprovalRequest[] = [];
	readonly commands: { command: string; args: readonly string[]; cwd?: string; noToolStorePath?: boolean }[] = [];
	readonly logs: { level: LogLevel; message: string }[] = [];
	onExec: ExecHandler = () => undefined;

	constructor(private readonly approveAll = true) { }

	async exec(command: string, args: readonly string[], options: ExecOptions = {}): Promise<ExecResult> {
		this.commands.push({ command, args, ...options.cwd ? { cwd: options.cwd } : {}, ...options.noToolStorePath ? { noToolStorePath: true } : {} });
		const scripted = this.onExec(command, args, options);
		const result: ExecResult = { exitCode: 0, stdout: '', stderr: '', timedOut: false, cancelled: false, truncated: false, ...scripted };
		if (scripted?.stdout) {
			options.onOutput?.('stdout', scripted.stdout);
		}
		if (scripted?.stderr) {
			options.onOutput?.('stderr', scripted.stderr);
		}
		return result;
	}
	async approve(request: ApprovalRequest): Promise<boolean> {
		this.approvals.push(request);
		return this.approveAll;
	}
	log(level: LogLevel, message: string): void {
		this.logs.push({ level, message });
	}
	progress(): void { }
}
