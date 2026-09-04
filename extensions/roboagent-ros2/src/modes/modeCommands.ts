/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  RoboAgent — the `roboagent.*` mode commands: the mode-dispatching trio the toolbar calls
 *  (`create` / `build` / `debug`), `selectMode`, the per-mode aliases (`roboagent.stm32.build`
 *  …) for the palette, and the STM32 first-run installer.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ModeHost } from './modeHost';
import { Mode, MODE_DESCRIPTORS, ModeProvider, MODES } from './modeProvider';
import { ModeService } from './modeService';
import { logError } from './output';
import { ensureStm32Extension, EnsureExtensionOptions } from './stm32/ensureExtension';

type Verb = 'create' | 'build' | 'debug';

export function registerModeCommands(service: ModeService, providers: ReadonlyMap<Mode, ModeProvider>, host: ModeHost): vscode.Disposable[] {
	const reg = vscode.commands.registerCommand;

	const run = async (label: string, action: () => Promise<unknown>): Promise<void> => {
		try {
			await action();
		} catch (e) {
			logError(`${label} failed:`, e);
			void vscode.window.showErrorMessage(vscode.l10n.t('RoboAgent: {0} failed — {1}. See the RoboAgent output channel.', label, e instanceof Error ? e.message : String(e)));
		}
	};

	const dispatch = (verb: Verb) => () => {
		const provider = service.provider;
		return run(`${verb} (${MODE_DESCRIPTORS[provider.mode].label})`, () => provider[verb]());
	};

	const disposables: vscode.Disposable[] = [
		reg('roboagent.selectMode', () => run('select mode', () => service.selectMode())),
		reg('roboagent.create', dispatch('create')),
		reg('roboagent.build', dispatch('build')),
		reg('roboagent.debug', dispatch('debug')),
		reg('roboagent.stm32.ensureExtension', (options?: EnsureExtensionOptions) => run('STM32 extension setup', () => ensureStm32Extension(host, options))),
	];

	for (const mode of MODES) {
		for (const verb of ['create', 'build', 'debug'] as const) {
			disposables.push(reg(`roboagent.${mode}.${verb}`, () => {
				const provider = providers.get(mode);
				if (!provider) {
					return undefined;
				}
				return run(`${verb} (${MODE_DESCRIPTORS[mode].label})`, () => provider[verb]());
			}));
		}
	}
	return disposables;
}
