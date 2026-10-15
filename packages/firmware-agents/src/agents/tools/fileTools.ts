/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IFileSystem } from '../../kernel/host';
import { defineTool, ToolError } from '../../kernel/tool';
import { AnyTool } from '../../kernel/toolRegistry';
import { findFiles, joinPath } from '../../embedded/project';

/**
 * Files the model must never read or write: credentials, keys, VCS internals (writing
 * `.git/hooks` or `.git/config` would run code), and dotenv files. Matching is on the
 * normalised workspace-relative path, case-insensitive.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
	/(^|\/)\.git(\/|$)/,
	/(^|\/)\.env(\..*)?$/,
	/(^|\/)\.ssh(\/|$)/,
	/(^|\/)\.gnupg(\/|$)/,
	/(^|\/)\.aws(\/|$)/,
	/(^|\/)(id_rsa|id_dsa|id_ecdsa|id_ed25519)(\.pub)?$/,
	/\.(pem|key|p12|pfx|jks|keystore|asc|gpg)$/,
	/(^|\/)\.(netrc|npmrc|pypirc|git-credentials|docker\/config\.json)$/,
	/(^|\/)[^/]*(credential|secret)[^/]*$/,
];

export function normalizeWorkspacePath(path: string): string {
	return path.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+/g, '/').replace(/\/$/, '');
}

/**
 * Readable, but never written by an agent: files that tools run automatically (direnv, editor
 * tasks, CI pipelines, git hook managers).
 */
const WRITE_PROTECTED_PATTERNS: readonly RegExp[] = [
	/(^|\/)\.envrc$/,
	/(^|\/)\.vscode\/(tasks|launch|settings)\.json$/,
	/(^|\/)\.github\/workflows(\/|$)/,
	/(^|\/)\.gitlab-ci\.yml$/,
	/(^|\/)\.husky(\/|$)/,
	/(^|\/)\.pre-commit-config\.yaml$/,
	/(^|\/)\.devcontainer(\/|$)/,
];

export function isSecretPath(path: string): boolean {
	const p = normalizeWorkspacePath(path).toLowerCase();
	return SECRET_PATTERNS.some(re => re.test(p));
}

export function isWriteProtectedPath(path: string): boolean {
	const p = normalizeWorkspacePath(path).toLowerCase();
	return isSecretPath(p) || WRITE_PROTECTED_PATTERNS.some(re => re.test(p));
}

/**
 * Checks the requested path **and** what it resolves to: a harmless-looking symlink
 * (`notes.txt -> .env`, `hooks -> .git/hooks`) must not get around the policy.
 */
async function guard(fs: IFileSystem, path: string, access: 'read' | 'write'): Promise<string> {
	if (typeof path !== 'string' || !path.trim()) {
		throw new ToolError('A path is required.');
	}
	if (path.startsWith('-')) {
		throw new ToolError('Paths may not start with "-".');
	}
	const blocked = access === 'write' ? isWriteProtectedPath : isSecretPath;
	if (blocked(path) || blocked(await fs.realPath(path))) {
		throw new ToolError(access === 'write' && !isSecretPath(path) && !isSecretPath(await fs.realPath(path))
			? `"${path}" is run automatically by other tools (direnv, editor tasks, CI, git hooks); agents may not change it.`
			: `"${path}" is a credential, key or VCS-internal file; agents may not read or change it.`);
	}
	return path;
}

/** True when `path` or its symlink target is a secret (for filtering listings and searches). */
async function isSecretTarget(fs: IFileSystem, path: string): Promise<boolean> {
	if (isSecretPath(path)) {
		return true;
	}
	try {
		return isSecretPath(await fs.realPath(path));
	} catch {
		return true; // unresolvable (e.g. outside the workspace): treat as hidden
	}
}

/** Records which files the agent changed, for change reports. */
export class ChangeTracker {
	private readonly changes = new Map<string, number>();
	private seq = 0;

	record(path: string): void {
		this.changes.set(normalizeWorkspacePath(path), ++this.seq);
	}
	/** Logical clock: every change and every {@link tick} advances it. */
	now(): number {
		return this.seq;
	}
	/** Advances the clock without a change (marks when a build ran, to order it against edits). */
	tick(): number {
		return ++this.seq;
	}
	changedSince(marker: number): string[] {
		return [...this.changes.entries()].filter(([, at]) => at > marker).map(([p]) => p);
	}
	/** Clock value of the most recent change (0 when nothing changed). */
	lastChange(): number {
		return Math.max(0, ...this.changes.values());
	}
}

const TEXT_FILE = /\.(c|h|cc|cpp|cxx|hpp|hh|s|asm|ld|lds|cmake|txt|ini|md|json|ya?ml|py|mk|cfg|conf|ioc|defaults)$|^(Makefile|makefile|GNUmakefile|CMakeLists\.txt|Kconfig.*|sdkconfig.*)$/i;
const MAX_LINES = 400;

export function createFileTools(changes: ChangeTracker): AnyTool[] {
	return [
		defineTool({
			name: 'read_file',
			description: 'Read a text file from the workspace. Returns numbered lines; use startLine/maxLines for long files.',
			risk: 'read',
			inputSchema: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'Workspace-relative path', maxLength: 1024 },
					startLine: { type: 'integer', minimum: 1 },
					maxLines: { type: 'integer', minimum: 1, maximum: 2000 },
				},
				required: ['path'],
				additionalProperties: false,
			},
			invoke: async (input: { path: string; startLine?: number; maxLines?: number }, { host }) => {
				const text = await host.fs.readFile(await guard(host.fs, input.path, 'read'));
				const lines = text.split(/\r?\n/);
				const start = input.startLine ?? 1;
				const count = input.maxLines ?? MAX_LINES;
				const slice = lines.slice(start - 1, start - 1 + count);
				return {
					path: input.path,
					totalLines: lines.length,
					startLine: start,
					endLine: start - 1 + slice.length,
					content: slice.map((l, i) => `${start + i}\t${l}`).join('\n'),
					...start - 1 + slice.length < lines.length ? { more: `${lines.length - (start - 1 + slice.length)} more lines; call again with startLine=${start + slice.length}` } : {},
				};
			},
		}),
		defineTool({
			name: 'list_directory',
			description: 'List a workspace directory (folders end with "/").',
			risk: 'read',
			inputSchema: { type: 'object', properties: { path: { type: 'string', maxLength: 1024 } }, additionalProperties: false },
			invoke: async (input: { path?: string }, { host }) => {
				const path = input.path ?? '.';
				if (path !== '.') {
					await guard(host.fs, path, 'read');
				}
				const visible: string[] = [];
				for (const e of await host.fs.readDir(path)) {
					if (!await isSecretTarget(host.fs, joinPath(path, e.name))) {
						visible.push(e.isDirectory ? `${e.name}/` : e.name);
					}
				}
				return visible.sort();
			},
		}),
		defineTool({
			name: 'search_text',
			description: 'Find a literal text in source and build files (C/C++/asm, headers, linker scripts, CMake, Make, ini, Kconfig). Skips build output.',
			risk: 'read',
			inputSchema: {
				type: 'object',
				properties: {
					text: { type: 'string', maxLength: 200 },
					path: { type: 'string', maxLength: 1024, description: 'Directory to search (default: workspace root)' },
					maxResults: { type: 'integer', minimum: 1, maximum: 200 },
				},
				required: ['text'],
				additionalProperties: false,
			},
			invoke: async (input: { text: string; path?: string; maxResults?: number }, { host, signal }) => {
				if (!input.text) {
					throw new ToolError('text must not be empty.');
				}
				const dir = input.path ?? '.';
				if (dir !== '.') {
					await guard(host.fs, dir, 'read');
				}
				const limit = input.maxResults ?? 50;
				const files = await findFiles(host.fs, dir, n => TEXT_FILE.test(n), 8, 2000);
				const matches: string[] = [];
				for (const file of files) {
					if (signal.aborted || matches.length >= limit) {
						break;
					}
					if (await isSecretTarget(host.fs, file)) {
						continue;
					}
					let text: string;
					try {
						text = await host.fs.readFile(file);
					} catch {
						continue;
					}
					text.split('\n').forEach((line, i) => {
						if (matches.length < limit && line.includes(input.text)) {
							matches.push(`${file}:${i + 1}: ${line.trim().slice(0, 200)}`);
						}
					});
				}
				return { matches, truncated: matches.length >= limit, filesSearched: files.length };
			},
		}),
		defineTool({
			name: 'write_file',
			description: 'Create or overwrite a workspace file with the given content. Prefer edit_file for changes to existing files.',
			risk: 'write',
			inputSchema: {
				type: 'object',
				properties: { path: { type: 'string', maxLength: 1024 }, content: { type: 'string', maxLength: 1_000_000 } },
				required: ['path', 'content'],
				additionalProperties: false,
			},
			describeCall: (input: { path: string; content: string }) => `Write ${input.path} (${input.content.split('\n').length} lines)`,
			invoke: async (input: { path: string; content: string }, { host }) => {
				await host.fs.writeFile(await guard(host.fs, input.path, 'write'), input.content);
				changes.record(input.path);
				return { written: input.path, bytes: input.content.length };
			},
		}),
		defineTool({
			name: 'edit_file',
			description: 'Replace one exact occurrence of oldText with newText in a workspace file. oldText must match exactly (including whitespace) and occur exactly once; include enough surrounding lines to make it unique.',
			risk: 'write',
			inputSchema: {
				type: 'object',
				properties: {
					path: { type: 'string', maxLength: 1024 },
					oldText: { type: 'string', maxLength: 100_000 },
					newText: { type: 'string', maxLength: 100_000 },
				},
				required: ['path', 'oldText', 'newText'],
				additionalProperties: false,
			},
			describeCall: (input: { path: string; oldText: string; newText: string }) => `Edit ${input.path} (replace ${input.oldText.split('\n').length} line(s) with ${input.newText.split('\n').length})`,
			invoke: async (input: { path: string; oldText: string; newText: string }, { host }) => {
				const path = await guard(host.fs, input.path, 'write');
				if (!input.oldText) {
					throw new ToolError('oldText must not be empty; use write_file to create a file.');
				}
				const text = await host.fs.readFile(path);
				// read_file shows lines without `\r`; in a CRLF file (common in CubeMX output) match
				// and write with CRLF so the model's LF text still applies.
				const crlf = text.includes('\r\n');
				const toFile = (t: string) => crlf ? t.replace(/\r?\n/g, '\r\n') : t;
				const oldText = toFile(input.oldText);
				const first = text.indexOf(oldText);
				if (first < 0) {
					throw new ToolError(`oldText was not found in ${path}. Read the file again and copy the text exactly.`);
				}
				if (text.indexOf(oldText, first + 1) >= 0) {
					throw new ToolError(`oldText occurs more than once in ${path}; include more surrounding lines.`);
				}
				await host.fs.writeFile(path, text.slice(0, first) + toFile(input.newText) + text.slice(first + oldText.length));
				changes.record(path);
				return { edited: path, line: text.slice(0, first).split('\n').length };
			},
		}),
	];
}
