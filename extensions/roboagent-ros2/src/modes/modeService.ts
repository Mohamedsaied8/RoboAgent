/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  RoboAgent — ModeService: owns the current Mode (STM32 / ESP32 / ROS2).
 *
 *  Persistence: `workspaceState` per workspace, `globalState` as the fallback for new
 *  workspaces, and the `roboagent.mode` setting as the last resort (its default is `ros2`).
 *  Surfaces: the `roboagent.mode` / `roboagent.modeProjectPresent` context keys (the fork's
 *  title-bar toolbar and every `when` clause read these), a clickable status-bar item, the
 *  Mode QuickPick, and the auto-detection-on-open with an Undo action.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { detectMode } from './detect';
import { DEFAULT_MODE, isMode, Mode, MODE_DESCRIPTORS, ModeProvider, modeLabel, MODES } from './modeProvider';
import { pickStep } from './wizardSteps';
import { log } from './output';

const WORKSPACE_STATE_KEY = 'roboagent.mode';
const GLOBAL_STATE_KEY = 'roboagent.mode';
const SETTING_KEY = 'roboagent.mode';
export const CONTEXT_MODE = 'roboagent.mode';
export const CONTEXT_PROJECT_PRESENT = 'roboagent.modeProjectPresent';

/** Files whose appearance/disappearance can change what the current mode's `detect()` says. */
const PROJECT_MARKER_GLOB = '**/{package.xml,sdkconfig,sdkconfig.defaults,CMakeLists.txt,*.ioc,arm-none-eabi.cmake}';

export class ModeService implements vscode.Disposable {

	private readonly disposables: vscode.Disposable[] = [];
	private readonly _onDidChangeMode = new vscode.EventEmitter<Mode>();
	readonly onDidChangeMode = this._onDidChangeMode.event;

	private readonly statusItem: vscode.StatusBarItem;
	private _projectPresent = false;
	private refreshTimer: NodeJS.Timeout | undefined;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly providers: ReadonlyMap<Mode, ModeProvider>,
	) {
		this.statusItem = vscode.window.createStatusBarItem('roboagent.mode', vscode.StatusBarAlignment.Left, 101);
		this.statusItem.name = 'RoboAgent Mode';
		this.statusItem.command = 'roboagent.selectMode';
		this.disposables.push(this.statusItem, this._onDidChangeMode);

		const watcher = vscode.workspace.createFileSystemWatcher(PROJECT_MARKER_GLOB);
		this.disposables.push(
			watcher,
			watcher.onDidCreate(() => this.scheduleRefresh()),
			watcher.onDidDelete(() => this.scheduleRefresh()),
			vscode.workspace.onDidChangeWorkspaceFolders(() => this.scheduleRefresh()),
			vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration(SETTING_KEY)) {
					// The setting is the fallback; an explicit user edit of it should win for this
					// workspace, so mirror it into workspaceState.
					const configured = vscode.workspace.getConfiguration().get<string>(SETTING_KEY);
					if (isMode(configured) && configured !== this.mode) {
						void this.setMode(configured, 'setting');
					}
				}
			}),
		);
	}

	dispose(): void {
		if (this.refreshTimer) { clearTimeout(this.refreshTimer); }
		vscode.Disposable.from(...this.disposables).dispose();
	}

	/** The effective mode: workspaceState → globalState → setting → default. */
	get mode(): Mode {
		const ws = this.context.workspaceState.get<string>(WORKSPACE_STATE_KEY);
		if (isMode(ws)) { return ws; }
		const global = this.context.globalState.get<string>(GLOBAL_STATE_KEY);
		if (isMode(global)) { return global; }
		const configured = vscode.workspace.getConfiguration().get<string>(SETTING_KEY);
		return isMode(configured) ? configured : DEFAULT_MODE;
	}

	/** Whether the current mode's `detect()` found a project in the workspace. */
	get projectPresent(): boolean {
		return this._projectPresent;
	}

	get provider(): ModeProvider {
		const provider = this.providers.get(this.mode);
		if (!provider) {
			throw new Error(`No provider registered for mode "${this.mode}"`);
		}
		return provider;
	}

	/** Called once after the providers are registered. */
	async initialize(): Promise<void> {
		await this.publish();
		await this.autoDetect();
	}

	async setMode(mode: Mode, reason: 'user' | 'detected' | 'undo' | 'setting'): Promise<void> {
		const previous = this.mode;
		await this.context.workspaceState.update(WORKSPACE_STATE_KEY, mode);
		await this.context.globalState.update(GLOBAL_STATE_KEY, mode);
		log(`mode: ${previous} → ${mode} (${reason})`);
		await this.publish();
		if (previous !== mode) {
			this._onDidChangeMode.fire(mode);
		}
	}

	/** The Mode QuickPick (`roboagent.selectMode`). */
	async selectMode(): Promise<void> {
		const current = this.mode;
		const picked = await pickStep<Mode>({ title: 'RoboAgent — Select Mode', placeholder: 'What are you building?' },
			MODES.map(id => {
				const d = MODE_DESCRIPTORS[id];
				return { label: `$(${d.icon}) ${d.label}`, description: d.description, detail: id === current ? 'Current mode' : undefined, value: id };
			}), current);
		if (!isMode(picked)) {
			return;
		}
		await this.setMode(picked, 'user');
		if (picked === 'stm32') {
			// First-run installer for the STM32 debug stack (log-only afterwards).
			await vscode.commands.executeCommand('roboagent.stm32.ensureExtension', { silentIfPresent: true });
		}
	}

	/**
	 * On a workspace without a stored mode, look at the folder contents and switch when it
	 * clearly is an STM32 / ESP32 / ROS2 project. Non-blocking notification with Undo.
	 */
	private async autoDetect(): Promise<void> {
		if (isMode(this.context.workspaceState.get<string>(WORKSPACE_STATE_KEY))) {
			return;   // an explicit choice (or an earlier detection) exists for this workspace
		}
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (!folder || folder.uri.scheme !== 'file') {
			return;
		}
		const detected = await detectMode(folder.uri.fsPath);
		if (!detected) {
			log(`auto-detect: no STM32/ESP32/ROS2 markers in ${folder.uri.fsPath}; keeping mode ${this.mode}`);
			return;
		}
		const previous = this.mode;
		if (detected === previous) {
			// Same mode as the fallback: pin it for this workspace silently.
			await this.context.workspaceState.update(WORKSPACE_STATE_KEY, detected);
			await this.publish();
			return;
		}
		await this.setMode(detected, 'detected');
		const undo = vscode.l10n.t('Undo');
		const choice = await vscode.window.showInformationMessage(
			vscode.l10n.t('Detected {0} project — Mode set to {0}.', modeLabel(detected)), undo);
		if (choice === undo) {
			await this.setMode(previous, 'undo');
		}
	}

	private scheduleRefresh(): void {
		if (this.refreshTimer) { clearTimeout(this.refreshTimer); }
		this.refreshTimer = setTimeout(() => { this.refreshTimer = undefined; void this.publish(); }, 300);
	}

	/** Recompute `projectPresent`, then push context keys + status bar. */
	private async publish(): Promise<void> {
		const mode = this.mode;
		const folder = vscode.workspace.workspaceFolders?.[0];
		let present = false;
		if (folder && folder.uri.scheme === 'file') {
			try {
				present = await this.providers.get(mode)?.detect(folder.uri.fsPath) ?? false;
			} catch (e) {
				log(`detect(${mode}) failed: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
		this._projectPresent = present;
		await vscode.commands.executeCommand('setContext', CONTEXT_MODE, mode);
		await vscode.commands.executeCommand('setContext', CONTEXT_PROJECT_PRESENT, present);

		const d = MODE_DESCRIPTORS[mode];
		this.statusItem.text = `$(${d.icon}) Mode: ${d.label}`;
		this.statusItem.tooltip = new vscode.MarkdownString(`**RoboAgent Mode: ${d.label}**\n\n${d.description}\n\n${present ? `$(check) ${d.label} project detected in this workspace` : `$(circle-slash) No ${d.label} project detected — use **Create**`}\n\nClick to change the mode.`, true);
		this.statusItem.show();
	}
}
