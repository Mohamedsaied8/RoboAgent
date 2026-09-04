/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  RoboAgent — `roboagent.stm32.ensureExtension`: the STM32 first-run installer.
 *
 *  ST's "STM32CubeIDE for VS Code" is under SLA0048 and only on the Microsoft Marketplace, so
 *  it can neither be bundled nor fetched from RoboAgent's gallery (Open VSX) — see
 *  docs/extensions.md. What CAN be installed is the open-source debug stack: Cortex-Debug (MIT),
 *  which pulls its mcu-debug.* dependencies from Open VSX. This runs on the first switch to
 *  STM32 mode and on demand from the palette.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CORTEX_DEBUG_EXTENSION_ID, ST_STM32_EXTENSION_ID } from '../bundledExtensions';
import { ModeHost } from '../modeHost';

export const STM32_EXTENSIONS_DOC_URL = 'https://github.com/Mohamedsaied8/RoboAgent/blob/main/docs/extensions.md#stm32-why-sts-extension-is-not-vendored-decision';

export interface EnsureExtensionOptions {
	/** When the extension is already present, say nothing (used from the Mode picker). */
	readonly silentIfPresent?: boolean;
}

/** Resolves to whether Cortex-Debug is installed when the command finishes. */
export async function ensureStm32Extension(host: ModeHost, options: EnsureExtensionOptions = {}): Promise<boolean> {
	if (host.isExtensionInstalled(CORTEX_DEBUG_EXTENSION_ID)) {
		host.log(`STM32: ${CORTEX_DEBUG_EXTENSION_ID} already installed.`);
		if (!options.silentIfPresent) {
			await host.showInfo(vscode.l10n.t('Cortex-Debug is installed — STM32 on-chip debugging is ready.'));
		}
		return true;
	}

	let installed = false;
	const stNote = host.isExtensionInstalled(ST_STM32_EXTENSION_ID)
		? ''
		: ' ' + vscode.l10n.t('(ST\'s own "STM32CubeIDE for VS Code" cannot be bundled or auto-installed: it is licensed under ST SLA0048 and is not on Open VSX.)');
	await host.showInfo(
		vscode.l10n.t('STM32 mode uses Cortex-Debug (MIT) from Open VSX for OpenOCD / ST-Link debugging. Install it now?') + stNote,
		{
			title: vscode.l10n.t('Install Cortex-Debug'),
			run: async () => {
				await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Installing Cortex-Debug from Open VSX…') }, async () => {
					try {
						await host.executeCommand('workbench.extensions.installExtension', CORTEX_DEBUG_EXTENSION_ID);
						installed = true;
						host.log(`STM32: installed ${CORTEX_DEBUG_EXTENSION_ID}.`);
					} catch (e) {
						host.log(`STM32: installing ${CORTEX_DEBUG_EXTENSION_ID} failed: ${e instanceof Error ? e.message : String(e)}`);
						await host.showError(vscode.l10n.t('Installing Cortex-Debug failed. Open the Extensions view and search for "Cortex-Debug", or check the RoboAgent output channel.'));
					}
				});
			},
		},
		{
			title: vscode.l10n.t('Why not the ST extension?'),
			run: () => { void vscode.env.openExternal(vscode.Uri.parse(STM32_EXTENSIONS_DOC_URL)); },
		},
	);
	return installed || host.isExtensionInstalled(CORTEX_DEBUG_EXTENSION_ID);
}
