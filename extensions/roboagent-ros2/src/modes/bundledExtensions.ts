/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  RoboAgent — bundled toolchain extensions.
 *
 *  RoboAgent ships the ESP-IDF extension as a built-in (product.json `builtInExtensions`); the
 *  STM32 debug stack (Cortex-Debug) is installed on first use because ST's own extension cannot
 *  be redistributed (see docs/extensions.md). This module only *reports*: a startup check that
 *  logs what is present and what is missing, never a nag.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { log } from './output';

export const ESP_IDF_EXTENSION_ID = 'espressif.esp-idf-extension';
export const CORTEX_DEBUG_EXTENSION_ID = 'marus25.cortex-debug';
export const CPPTOOLS_EXTENSION_ID = 'ms-vscode.cpptools';
export const ST_STM32_EXTENSION_ID = 'stmicroelectronics.stm32-vscode-extension';

export function isExtensionInstalled(id: string): boolean {
	return vscode.extensions.getExtension(id) !== undefined;
}

export function extensionVersion(id: string): string | undefined {
	return (vscode.extensions.getExtension(id)?.packageJSON as { version?: string } | undefined)?.version;
}

/**
 * Log the presence of the toolchain extensions RoboAgent relies on. Bundled ones are expected
 * (a miss means the build/packaging dropped them); the STM32 debug stack is optional until the
 * user picks STM32 mode.
 */
export function checkBundledExtensions(): void {
	const expected: ReadonlyArray<[id: string, purpose: string]> = [
		[ESP_IDF_EXTENSION_ID, 'ESP32 mode (idf.py build/flash/monitor, gdbtarget debugging)'],
		[CPPTOOLS_EXTENSION_ID, 'C/C++ IntelliSense and the cppdbg fallback debugger'],
	];
	for (const [id, purpose] of expected) {
		if (isExtensionInstalled(id)) {
			log(`Bundled extension ${id}@${extensionVersion(id)} present — ${purpose}.`);
		} else {
			log(`Bundled extension ${id} is MISSING — ${purpose} will be degraded. It should ship as a built-in (product.json builtInExtensions); check the packaging step.`);
		}
	}
	if (isExtensionInstalled(CORTEX_DEBUG_EXTENSION_ID)) {
		log(`Optional extension ${CORTEX_DEBUG_EXTENSION_ID}@${extensionVersion(CORTEX_DEBUG_EXTENSION_ID)} present — STM32 on-chip debugging available.`);
	} else {
		log(`Optional extension ${CORTEX_DEBUG_EXTENSION_ID} not installed — STM32 mode offers to install it on first use (roboagent.stm32.ensureExtension).`);
	}
	if (isExtensionInstalled(ST_STM32_EXTENSION_ID)) {
		log(`Optional extension ${ST_STM32_EXTENSION_ID}@${extensionVersion(ST_STM32_EXTENSION_ID)} present (user-installed).`);
	}
}
