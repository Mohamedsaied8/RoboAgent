/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  RoboAgent — the side-effect surface mode providers use (tasks, terminals, debug sessions,
 *  notifications, settings). Providers talk to this interface instead of `vscode` directly so
 *  the unit tests can substitute a recording fake; `vscodeModeHost.ts` is the real thing.
 *--------------------------------------------------------------------------------------------*/

export interface ShellTaskRequest {
	/** Task label; also the terminal title (`RoboAgent: STM32 build`). */
	readonly name: string;
	/** Full shell command line. */
	readonly command: string;
	readonly cwd: string;
	/** Problem matcher names (`$roboagent-gcc`, `$colcon`). */
	readonly problemMatchers?: readonly string[];
	readonly group?: 'build' | 'test';
	/** Extra environment for the task shell. */
	readonly env?: Readonly<Record<string, string>>;
}

export interface TaskResult {
	/** Process exit code, or undefined when the task could not be started / was cancelled. */
	readonly exitCode: number | undefined;
}

export interface MessageAction {
	readonly title: string;
	readonly run: () => void | Promise<void>;
}

export interface ModeHost {
	/** Run a shell task in the Terminal panel; resolves when the process ends. */
	runShellTask(request: ShellTaskRequest): Promise<TaskResult>;
	/** Send a command line to a (new) integrated terminal and reveal it. */
	sendToTerminal(name: string, command: string, cwd?: string): void;
	/** Start a debug session; resolves to whether the session started. */
	startDebugging(folderFsPath: string | undefined, configuration: Record<string, unknown>): Promise<boolean>;
	executeCommand(commandId: string, ...args: unknown[]): Promise<unknown>;
	isExtensionInstalled(extensionId: string): boolean;
	/** Read a `roboagent.*` (or any) setting. */
	getSetting<T>(key: string): T | undefined;
	/** Whether `tool` resolves on PATH. */
	toolOnPath(tool: string): Promise<boolean>;
	fileExists(fsPath: string): Promise<boolean>;
	showInfo(message: string, ...actions: MessageAction[]): Promise<void>;
	showWarning(message: string, ...actions: MessageAction[]): Promise<void>;
	showError(message: string, ...actions: MessageAction[]): Promise<void>;
	log(message: string): void;
}
