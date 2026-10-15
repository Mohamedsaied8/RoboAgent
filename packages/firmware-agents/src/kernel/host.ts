/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Port to everything outside the agents: files, processes, the user, logs. RoboAgent, the CLI and
 * the MCP server each provide an implementation, which is what keeps the core host-agnostic.
 */
export interface IAgentHost {
	readonly fs: IFileSystem;
	exec(command: string, args: readonly string[], options?: ExecOptions): Promise<ExecResult>;
	/** Asks the user to allow a risky action. Hosts without a user must deny. */
	approve(request: ApprovalRequest): Promise<boolean>;
	log(level: LogLevel, message: string): void;
	progress(message: string): void;
	/** Where agents install the tools they need (user space, outside any workspace). Optional. */
	readonly toolStore?: IToolStore;
}

/** Paths are relative to the host's workspace root; implementations refuse paths that escape it. */
export interface IFileSystem {
	readFile(path: string): Promise<string>;
	writeFile(path: string, content: string): Promise<void>;
	exists(path: string): Promise<boolean>;
	readDir(path: string): Promise<DirEntry[]>;
	/**
	 * The workspace-relative path `path` really refers to after following symlinks (for a path
	 * that does not exist yet: its deepest existing ancestor resolved, plus the rest). Policies
	 * such as the secret-file block must check this as well as the requested path.
	 */
	realPath(path: string): Promise<string>;
}

export interface DirEntry {
	readonly name: string;
	readonly isDirectory: boolean;
}

export interface ExecOptions {
	/** Relative to the workspace root. */
	readonly cwd?: string;
	readonly env?: Readonly<Record<string, string>>;
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
	/** Cap on captured stdout/stderr each; the rest is dropped and `truncated` is set. */
	readonly maxOutputBytes?: number;
	readonly onOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void;
	/** Written to the program's stdin, which is then closed (default: no stdin). */
	readonly input?: string;
	/** Leave the tool store's folders off PATH for this run (to find what the system itself provides). */
	readonly noToolStorePath?: boolean;
}

export interface ExecResult {
	/** `null` when the process did not exit normally (killed, or failed to start). */
	readonly exitCode: number | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly timedOut: boolean;
	readonly cancelled: boolean;
	readonly truncated: boolean;
	/** Set when the process could not start, e.g. `spawn openocd ENOENT`. */
	readonly spawnError?: string;
}

/**
 * What kind of action needs approval, so hosts can apply policies (e.g. "install tools without
 * asking") without parsing tool names. `system` = changes outside user space (root, system files).
 */
export type ApprovalCategory = 'edit' | 'build' | 'install' | 'system' | 'hardware';

export interface ApprovalRequest {
	readonly agentId: string;
	readonly toolName: string;
	readonly risk: 'write' | 'hardware';
	readonly category: ApprovalCategory;
	/** One line the user can decide on, e.g. "Flash build/app.elf to STM32F407 over ST-Link". */
	readonly summary: string;
	readonly input: unknown;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type PlatformId = 'linux-x64' | 'linux-arm64' | 'darwin-x64' | 'darwin-arm64' | 'win32-x64';

/** A pinned vendor archive: what to download, how to check it, where its programs are. */
export interface ArchiveSpec {
	readonly id: string;
	readonly version: string;
	readonly url: string;
	/** Published by the vendor; the download is refused when it does not match. */
	readonly sha256: string;
	readonly size: number;
	readonly format: 'tar.gz' | 'tar.xz' | 'zip';
	/** Folder with the executables, relative to the archive root (e.g. `xpack-openocd-0.12.0-7/bin`). */
	readonly binDir: string;
	/** Whether `binDir` goes on child processes' PATH (false for tools that would shadow others). */
	readonly onPath: boolean;
}

export interface InstalledTool {
	readonly id: string;
	readonly version: string;
	/** Absolute install folder. */
	readonly dir: string;
	/** Absolute folder with the executables. */
	readonly binDir: string;
	readonly sha256: string;
	readonly onPath: boolean;
}

/**
 * Port: a user-space store of downloaded tools. Implementations download only over https from
 * allowlisted hosts, verify the SHA-256 before extracting, extract safely, and install atomically.
 */
export interface IToolStore {
	/** Shown to the user (approval prompts, reports). */
	readonly location: string;
	/** This machine's platform, or undefined when no pinned archives exist for it. */
	platform(): PlatformId | undefined;
	installed(): Promise<InstalledTool[]>;
	find(id: string, version?: string): Promise<InstalledTool | undefined>;
	install(spec: ArchiveSpec, options?: { signal?: AbortSignal; onProgress?: (bytes: number, total: number) => void }): Promise<InstalledTool>;
	remove(id: string, version?: string): Promise<void>;
	/** `binDir`s of installed tools marked `onPath`, newest first. */
	binPaths(): Promise<string[]>;
	/**
	 * A text file from an installed tool, by path relative to the archive root (e.g. its udev
	 * rules). Refuses paths that leave the install folder.
	 */
	readFile(id: string, version: string, relativePath: string, maxBytes?: number): Promise<string>;
}
