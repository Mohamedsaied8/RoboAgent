/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import { roboAgentActivationEvents } from '../../../../../platform/extensions/common/roboagentActivationOverrides.js';

// Regression for the 2026-11-25 manual test: the ESP-IDF extension activated in STM32 and ROS2
// projects (any CMakeLists.txt) and asked "activate anyway?" / recommended clangd there.
suite('RoboAgent - narrower workspaceContains activation', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('ESP-IDF activates on ESP-IDF project markers, not on any CMakeLists.txt; its other events are kept', () => {
		// The view in the Explorer (idfComponents) would activate it in any project: dropped.
		const espIdf = { identifier: new ExtensionIdentifier('espressif.esp-idf-extension'), activationEvents: ['onCommand:espIdf.buildDevice', 'onView:idfComponents', 'onView:idfPartitionExplorer', 'workspaceContains:**/CMakeLists.txt'] };
		assert.deepStrictEqual(roboAgentActivationEvents(espIdf), [
			'onCommand:espIdf.buildDevice',
			'onView:idfPartitionExplorer',
			'workspaceContains:sdkconfig',
			'workspaceContains:sdkconfig.defaults',
			'workspaceContains:main/CMakeLists.txt',
			'workspaceContains:*/sdkconfig.defaults',
			'workspaceContains:*/main/CMakeLists.txt',
		]);
	});

	test('other extensions are untouched', () => {
		const cmakeTools = { identifier: new ExtensionIdentifier('ms-vscode.cmake-tools'), activationEvents: ['workspaceContains:CMakeLists.txt'] };
		assert.strictEqual(roboAgentActivationEvents(cmakeTools), cmakeTools.activationEvents);
	});
});
