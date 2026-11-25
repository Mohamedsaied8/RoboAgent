/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService } from '../../../../services/statusbar/browser/statusbar.js';
import { TestContextService } from '../../../../test/common/workbenchTestServices.js';
import { Ros2StatusBar } from '../../browser/ros2StatusBar.js';
import { IRos2WorkspaceService } from '../../common/ros2WorkspaceService.js';
import { EMPTY_ROS2_GRAPH } from '../../common/ros2WorkspaceModel.js';

// Regression for task board A10: the ROS2 indicator ("ROS2  Not indexed") showed in STM32 and
// ESP32 projects, which have no ROS2 workspace.
suite('RoboAgent - ROS2 status bar entry', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('shown in the ROS2 mode only (not while the mode is unknown, not in STM32 / ESP32)', () => {
		const shown: string[] = [];
		const statusbar = {
			addEntry: (entry: IStatusbarEntry) => {
				shown.push(entry.text);
				return { update: () => { }, dispose: () => { shown.pop(); } } satisfies IStatusbarEntryAccessor;
			},
		} as Partial<IStatusbarService> as IStatusbarService;
		const ros2 = { onDidChangeGraph: Event.None, onDidChangeIndexing: Event.None, isIndexing: false, getGraph: () => EMPTY_ROS2_GRAPH } as Partial<IRos2WorkspaceService> as IRos2WorkspaceService;
		const files = { readFile: () => Promise.reject(new Error('no project.json')) } as Partial<IFileService> as IFileService;
		const contextKeys = store.add(new ContextKeyService(new TestConfigurationService()));
		const mode = contextKeys.createKey<string>('roboagent.mode', undefined);
		store.add(toDisposable(() => mode.reset()));

		store.add(new Ros2StatusBar(statusbar, ros2, new TestContextService(), files, contextKeys));
		const seen = [shown.length];
		for (const next of ['stm32', 'ros2', 'esp32', 'ros2']) {
			mode.set(next);
			seen.push(shown.length);
		}
		assert.deepStrictEqual(seen, [0, 0, 1, 0, 1]);
	});
});
