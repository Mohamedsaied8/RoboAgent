/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable } from './disposable';

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
	/** Discovers the system layout (programs, udev folders) by search. Optional. */
	readonly system?: ISystemProbe;
	/**
	 * Starts a long-lived program (OpenOCD, GDB) and returns a handle to talk to it. Optional:
	 * hosts without it cannot run debug sessions.
	 */
	spawn?(command: string, args: readonly string[], options?: SpawnOptions): IProcessHandle;
	/** Serial ports (ESP32 console, panic logs, core dumps, the GDB stub). Optional. */
	readonly serial?: ISerialPorts;
}

export interface SpawnOptions {
	/** Relative to the workspace root (default: the root). */
	readonly cwd?: string;
	/**
	 * Absolute working folder outside the workspace instead of `cwd`, e.g. OpenOCD's own scripts
	 * folder. Hosts accept it only inside the tool store or in a folder trusted for root.
	 */
	readonly trustedCwd?: string;
	readonly env?: Readonly<Record<string, string>>;
	/** Variables removed from the child's environment (e.g. `OPENOCD_SCRIPTS`). */
	readonly unsetEnv?: readonly string[];
	/** Output as it arrives (redacted), split into chunks as the pipe delivers them. */
	readonly onOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void;
}

export interface ProcessExit {
	readonly exitCode: number | null;
	readonly signal?: string;
	readonly spawnError?: string;
}

/** A running program with stdin open. Killing it also stops everything it started. */
export interface IProcessHandle {
	readonly pid: number | undefined;
	/** Writes to the program's stdin; ignored once it has exited. */
	write(text: string): void;
	/** Settles when the program has exited (never rejects). */
	readonly exited: Promise<ProcessExit>;
	/** SIGTERM to the process group, SIGKILL after a grace period; resolves when it is gone. */
	kill(): Promise<ProcessExit>;
}

export interface ProgramSearchOptions {
	/** Search the system PATH only, not the tool store's folders. */
	readonly systemOnly?: boolean;
	/** For programs run as root: only files (and folders) owned by root and not writable by others. Implies `systemOnly`. */
	readonly trustedForRoot?: boolean;
}

export interface UdevRuleFile {
	readonly file: string;
	readonly content: string;
}

/**
 * Port: facts about the machine, found by search rather than hard-coded paths. Implementations
 * search PATH for programs and ask the system itself where udev keeps its rules.
 */
export interface ISystemProbe {
	/** Absolute path of a program, or undefined when it is not found (or not trusted for root). */
	findProgram(name: string, options?: ProgramSearchOptions): Promise<string | undefined>;
	/** udev's rule folders on this machine in udev's priority order (first = the administrator's folder); empty when not Linux/udev. */
	udevRuleDirs(): Promise<string[]>;
	/** udev's administrator folder (where root steps write), or undefined when it is missing or untrusted. */
	udevAdminDir(): Promise<string | undefined>;
	/** The rules udev applies (overrides and /dev/null masks taken into account). */
	readUdevRules(): Promise<UdevRuleFile[]>;
	/**
	 * The first candidate (absolute paths) that is an existing folder the agents' file tools
	 * cannot change: inside the tool store, or root-owned and not writable by others. Returns its
	 * real path. Used for program data such as OpenOCD's scripts folder.
	 */
	trustedDataDir?(candidates: readonly string[]): Promise<string | undefined>;
}

/** Paths are relative to the host's workspace root; implementations refuse paths that escape it. */
export interface IFileSystem {
	readFile(path: string): Promise<string>;
	writeFile(path: string, content: string): Promise<void>;
	/** Raw bytes of a regular file (ELF images, core dumps); optional, with the same confinement. */
	readBytes?(path: string): Promise<Uint8Array>;
	/** Writes raw bytes (creating folders); optional, with the same confinement. */
	writeBytes?(path: string, data: Uint8Array): Promise<void>;
	/** SHA-256 (hex) of a regular file of any size, streamed; optional, with the same confinement. */
	sha256?(path: string): Promise<string>;
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
	/** `file`: a single file (e.g. an SVD), stored as `<binDir>/<fileName>`. */
	readonly format: 'tar.gz' | 'tar.xz' | 'zip' | 'file';
	/** For `file`: the name to store it under. */
	readonly fileName?: string;
	/** For files from a git repository: the git blob id, checked as well as the SHA-256. */
	readonly gitBlobSha1?: string;
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

/** A serial port the host can open. */
export interface SerialPortInfo {
	/** Real device path, e.g. `/dev/ttyUSB0`. */
	readonly device: string;
	/** Stable alias, e.g. `/dev/serial/by-id/usb-Silicon_Labs_CP2102_…-if00-port0`. */
	readonly alias?: string;
	/** USB bridge or board, when the alias says (e.g. `Silicon Labs CP2102`). */
	readonly description?: string;
}

/** An open serial port. Text is decoded as Latin-1 (one char per byte), as consoles print it. */
export interface ISerialConnection {
	readonly device: string;
	onData(listener: (text: string) => void): IDisposable;
	write(text: string): Promise<void>;
	/**
	 * Stops (true) or restarts (false) reading, so another program (esptool resetting the chip)
	 * can use the port meanwhile; what arrives later is still delivered. Optional.
	 */
	hold?(on: boolean): void;
	close(): Promise<void>;
}

/** Port: serial devices (ESP32 console, panic logs, core dumps over UART). */
export interface ISerialPorts {
	list(): Promise<SerialPortInfo[]>;
	/**
	 * The real device behind `path` (an alias such as `/dev/serial/by-id/…` resolves to its
	 * `/dev/ttyUSB0`). Throws for anything that is not a serial device.
	 */
	resolve(path: string): Promise<string>;
	open(device: string, options: { readonly baud: number }): Promise<ISerialConnection>;
	/**
	 * Resets an ESP32 through the USB-serial bridge's RTS/DTR lines (classic DevKit auto-reset
	 * circuit) so it boots the application. Optional: hosts without it ask the user to press EN.
	 */
	resetEsp32?(device: string, signal?: AbortSignal): Promise<{ ok: boolean; detail: string }>;
}
