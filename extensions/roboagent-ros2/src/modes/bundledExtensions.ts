/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  RoboAgent — bundled toolchain extensions.
 *
 *  RoboAgent ships these as built-ins (product.json `builtInExtensions`, all open source): the
 *  ESP-IDF extension, clangd for C/C++ IntelliSense, and Cortex-Debug (with its mcu-debug views)
 *  for STM32 on-chip debugging. Microsoft's C/C++ extension (cpptools) is not shipped: its licence
 *  limits it to Microsoft's own products. ST's STM32 extension cannot be redistributed either (see
 *  docs/extensions.md). This module only *reports*: a startup check that logs what is present and
 *  what is missing, never a nag.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { log } from './output';

export const ESP_IDF_EXTENSION_ID = 'espressif.esp-idf-extension';
export const CORTEX_DEBUG_EXTENSION_ID = 'marus25.cortex-debug';
export const CLANGD_EXTENSION_ID = 'llvm-vs-code-extensions.vscode-clangd';
export const ST_STM32_EXTENSION_ID = 'stmicroelectronics.stm32-vscode-extension';

export function isExtensionInstalled(id: string): boolean {
	return vscode.extensions.getExtension(id) !== undefined;
}

export function extensionVersion(id: string): string | undefined {
	return (vscode.extensions.getExtension(id)?.packageJSON as { version?: string } | undefined)?.version;
}

/**
 * Log the presence of the toolchain extensions RoboAgent relies on. They are all bundled, so a
 * miss means the build/packaging dropped them (or the user disabled one).
 */
export function checkBundledExtensions(): void {
	const expected: ReadonlyArray<[id: string, purpose: string]> = [
		[ESP_IDF_EXTENSION_ID, 'ESP32 mode (idf.py build/flash/monitor, gdbtarget debugging)'],
		[CLANGD_EXTENSION_ID, 'C/C++ IntelliSense (clangd, from compile_commands.json)'],
		[CORTEX_DEBUG_EXTENSION_ID, 'STM32 on-chip debugging (OpenOCD / ST-Link)'],
	];
	for (const [id, purpose] of expected) {
		if (isExtensionInstalled(id)) {
			log(`Bundled extension ${id}@${extensionVersion(id)} present — ${purpose}.`);
		} else {
			log(`Bundled extension ${id} is MISSING — ${purpose} will be degraded. It should ship as a built-in (product.json builtInExtensions); check the packaging step.`);
		}
	}
	if (isExtensionInstalled(ST_STM32_EXTENSION_ID)) {
		log(`Optional extension ${ST_STM32_EXTENSION_ID}@${extensionVersion(ST_STM32_EXTENSION_ID)} present (user-installed).`);
	}
}
