/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  package.json contributions that shape the UI. Regression for the 2026-11-25 manual test:
 *  Build and Debug appeared three times in STM32 mode (title bar, editor title, and CMake
 *  Tools' status bar, which builds with its own kit), and CMake Tools asked for a kit on open.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

interface MenuItem { command: string; when?: string }
interface Manifest {
	contributes: {
		menus: Record<string, MenuItem[]>;
		configurationDefaults?: Record<string, unknown>;
		problemMatchers: { name: string }[];
	};
}

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as Manifest;

/** Evaluate the `roboagent.mode` clauses of a when-clause (other keys are taken as true). */
function shownInMode(when: string | undefined, mode: string): boolean {
	if (!when) { return true; }
	const notMode = [...when.matchAll(/roboagent\.mode != (\w+)/g)].map(m => m[1]);
	const isMode = [...when.matchAll(/roboagent\.mode == (\w+)/g)].map(m => m[1]);
	return !notMode.includes(mode) && (isMode.length === 0 || isMode.includes(mode));
}

suite('Extension manifest', () => {

	test('build and debug buttons: only the title-bar toolbar has them in a mode, not the editor title', () => {
		const buildOrDebug = /^roboagent\.(build|debug|colconBuild)$/;
		const table = Object.fromEntries(['stm32', 'esp32', 'ros2'].map(mode => [mode,
			['editor/title', 'editor/title/run'].flatMap(menu => (manifest.contributes.menus[menu] ?? [])
				.filter(item => buildOrDebug.test(item.command) && shownInMode(item.when, mode))
				.map(item => `${menu}:${item.command}`))]));
		assert.deepStrictEqual(table, { stm32: [], esp32: [], ros2: [] });
	});

	test('CMake Tools: no status-bar build / launch / debug and no configure (kit prompt) on open', () => {
		assert.deepStrictEqual(manifest.contributes.configurationDefaults, {
			'cmake.configureOnOpen': false,
			'cmake.options.advanced': {
				build: { statusBarVisibility: 'hidden' },
				launch: { statusBarVisibility: 'hidden' },
				debug: { statusBarVisibility: 'hidden' },
			},
		});
	});

	test('problem matchers for gcc, colcon and CMake are contributed', () => {
		assert.deepStrictEqual(manifest.contributes.problemMatchers.map(m => m.name), ['colcon', 'roboagent-gcc', 'roboagent-cmake']);
	});
});
