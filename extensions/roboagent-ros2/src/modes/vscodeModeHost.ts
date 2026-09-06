/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { exists, onPath } from '../util';
import { MessageAction, ModeHost, ShellTaskRequest, TaskResult } from './modeHost';
import { log } from './output';
import { pickFolder } from './wizardSteps';

/** The production {@link ModeHost}: thin adapters over the vscode API. */
export class VscodeModeHost implements ModeHost {

	async runShellTask(request: ShellTaskRequest): Promise<TaskResult> {
		const execution = new vscode.ShellExecution(request.command, { cwd: request.cwd, env: request.env ? { ...request.env } : undefined });
		const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(request.cwd));
		const task = new vscode.Task({ type: 'roboagent-mode', name: request.name }, folder ?? vscode.TaskScope.Workspace, request.name, 'RoboAgent', execution, [...(request.problemMatchers ?? [])]);
		task.group = request.group === 'test' ? vscode.TaskGroup.Test : vscode.TaskGroup.Build;
		task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated, clear: true, showReuseMessage: false };

		log(`task "${request.name}" in ${request.cwd}: ${request.command}`);
		const done = new Promise<TaskResult>(resolve => {
			const listener = vscode.tasks.onDidEndTaskProcess(e => {
				if (e.execution === executionHandle) {
					listener.dispose();
					log(`task "${request.name}" exited with ${e.exitCode}`);
					resolve({ exitCode: e.exitCode });
				}
			});
		});
		let executionHandle: vscode.TaskExecution;
		try {
			executionHandle = await vscode.tasks.executeTask(task);
		} catch (e) {
			log(`task "${request.name}" failed to start: ${e instanceof Error ? e.message : String(e)}`);
			return { exitCode: undefined };
		}
		return done;
	}

	sendToTerminal(name: string, command: string, cwd?: string): void {
		const terminal = vscode.window.createTerminal({ name, cwd });
		terminal.show();
		log(`terminal "${name}": ${command}`);
		terminal.sendText(command);
	}

	async startDebugging(folderFsPath: string | undefined, configuration: Record<string, unknown>): Promise<boolean> {
		const folder = folderFsPath ? vscode.workspace.getWorkspaceFolder(vscode.Uri.file(folderFsPath)) : undefined;
		log(`debug: ${JSON.stringify(configuration)}`);
		return vscode.debug.startDebugging(folder, configuration as unknown as vscode.DebugConfiguration);
	}

	executeCommand(commandId: string, ...args: unknown[]): Promise<unknown> {
		return Promise.resolve(vscode.commands.executeCommand(commandId, ...args));
	}

	isExtensionInstalled(extensionId: string): boolean {
		return vscode.extensions.getExtension(extensionId) !== undefined;
	}

	getSetting<T>(key: string): T | undefined {
		const { section, name } = splitSettingKey(key);
		return vscode.workspace.getConfiguration(section).get<T>(name);
	}

	async updateSetting(key: string, value: unknown): Promise<void> {
		const { section, name } = splitSettingKey(key);
		await vscode.workspace.getConfiguration(section).update(name, value, vscode.ConfigurationTarget.Global);
	}

	pickFolder(title: string, openLabel: string): Promise<string | undefined> {
		return pickFolder(title, openLabel);
	}

	async openExternal(url: string): Promise<void> {
		await vscode.env.openExternal(vscode.Uri.parse(url));
	}

	toolOnPath(tool: string): Promise<boolean> {
		return onPath(tool);
	}

	fileExists(fsPath: string): Promise<boolean> {
		return exists(vscode.Uri.file(fsPath));
	}

	showInfo(message: string, ...actions: MessageAction[]): Promise<void> {
		return dispatch(vscode.window.showInformationMessage(message, ...actions.map(a => a.title)), actions);
	}

	showWarning(message: string, ...actions: MessageAction[]): Promise<void> {
		return dispatch(vscode.window.showWarningMessage(message, ...actions.map(a => a.title)), actions);
	}

	showError(message: string, ...actions: MessageAction[]): Promise<void> {
		return dispatch(vscode.window.showErrorMessage(message, ...actions.map(a => a.title)), actions);
	}

	log(message: string): void {
		log(message);
	}
}

/** `roboagent.esp32.idfPath` → section `roboagent.esp32`, name `idfPath` (the first dot splits). */
function splitSettingKey(key: string): { section: string | undefined; name: string } {
	const dot = key.indexOf('.');
	return dot === -1 ? { section: undefined, name: key } : { section: key.slice(0, dot), name: key.slice(dot + 1) };
}

async function dispatch(choice: Thenable<string | undefined>, actions: MessageAction[]): Promise<void> {
	const picked = await choice;
	const action = actions.find(a => a.title === picked);
	if (action) {
		await action.run();
	}
}
