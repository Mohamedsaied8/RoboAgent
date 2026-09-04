/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import { MessageAction, ModeHost, ShellTaskRequest, TaskResult } from '../modes/modeHost';

/** A recording {@link ModeHost} for provider tests: no terminals, no debug sessions, no UI. */
export class FakeHost implements ModeHost {
	readonly tasks: ShellTaskRequest[] = [];
	readonly terminals: { name: string; command: string; cwd?: string }[] = [];
	readonly debugSessions: { folder: string | undefined; configuration: Record<string, unknown> }[] = [];
	readonly commands: { id: string; args: unknown[] }[] = [];
	readonly messages: { level: 'info' | 'warning' | 'error'; message: string; actions: string[] }[] = [];
	readonly logs: string[] = [];
	readonly installed = new Set<string>();
	readonly tools = new Set<string>();
	readonly settings = new Map<string, unknown>();
	/** Title of the message action to auto-pick (simulates the user clicking it). */
	autoPick: string | undefined;
	taskExitCode: number | undefined = 0;
	debugStarts = true;

	async runShellTask(request: ShellTaskRequest): Promise<TaskResult> {
		this.tasks.push(request);
		return { exitCode: this.taskExitCode };
	}
	sendToTerminal(name: string, command: string, cwd?: string): void {
		this.terminals.push({ name, command, cwd });
	}
	async startDebugging(folder: string | undefined, configuration: Record<string, unknown>): Promise<boolean> {
		this.debugSessions.push({ folder, configuration });
		return this.debugStarts;
	}
	async executeCommand(id: string, ...args: unknown[]): Promise<unknown> {
		this.commands.push({ id, args });
		return undefined;
	}
	isExtensionInstalled(id: string): boolean {
		return this.installed.has(id);
	}
	getSetting<T>(key: string): T | undefined {
		return this.settings.get(key) as T | undefined;
	}
	async toolOnPath(tool: string): Promise<boolean> {
		return this.tools.has(tool);
	}
	async fileExists(p: string): Promise<boolean> {
		try { await fs.promises.access(p); return true; } catch { return false; }
	}
	private async message(level: 'info' | 'warning' | 'error', message: string, actions: MessageAction[]): Promise<void> {
		this.messages.push({ level, message, actions: actions.map(a => a.title) });
		const pick = actions.find(a => a.title === this.autoPick);
		if (pick) { await pick.run(); }
	}
	showInfo(message: string, ...actions: MessageAction[]): Promise<void> { return this.message('info', message, actions); }
	showWarning(message: string, ...actions: MessageAction[]): Promise<void> { return this.message('warning', message, actions); }
	showError(message: string, ...actions: MessageAction[]): Promise<void> { return this.message('error', message, actions); }
	log(message: string): void { this.logs.push(message); }
}
