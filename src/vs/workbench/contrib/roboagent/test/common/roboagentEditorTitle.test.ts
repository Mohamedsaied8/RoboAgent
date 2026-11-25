/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IContext } from '../../../../../platform/contextkey/common/contextkey.js';
import { roboAgentEditorTitleCondition } from '../../../../services/actions/common/menusExtensionPoint.js';

// Regression for the 2026-11-25 manual test: in STM32 mode the editor title showed the ESP-IDF
// extension's button next to RoboAgent's, and single-file build buttons built for the host.
suite('RoboAgent - bundled extensions\' editor-title buttons per mode', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	function visibleIn(mode: string, command: string): boolean {
		const context: IContext = { getValue: <T>(key: string) => (key === 'roboagent.mode' ? mode : undefined) as T | undefined };
		return roboAgentEditorTitleCondition(command)?.evaluate(context) ?? true;
	}

	test('ESP-IDF Search Error Hint only in ESP32 mode; host single-file builds never in firmware modes', () => {
		const commands = ['espIdf.searchError', 'cmake.compileFile', 'C_Cpp.BuildAndRunFile', 'python.execInTerminal'];
		const table = Object.fromEntries(['stm32', 'esp32', 'ros2'].map(mode => [mode, commands.filter(c => visibleIn(mode, c))]));
		assert.deepStrictEqual(table, {
			stm32: ['python.execInTerminal'],
			esp32: ['espIdf.searchError', 'python.execInTerminal'],
			ros2: ['cmake.compileFile', 'C_Cpp.BuildAndRunFile', 'python.execInTerminal'],
		});
	});
});
