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
import { ARM_QUERY_DRIVERS, ESP_QUERY_DRIVERS, queryDriverArgument } from '../modes/clangd';

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

	test('CMake Tools: no status-bar build / launch / debug, no configure (kit prompt) on open, no kit scan (reconfigure prompt)', () => {
		assert.deepStrictEqual(manifest.contributes.configurationDefaults, {
			'clangd.arguments': [queryDriverArgument([...ARM_QUERY_DRIVERS, ...ESP_QUERY_DRIVERS])],
			'cmake.configureOnOpen': false,
			'cmake.enableAutomaticKitScan': false,
			'cmake.options.advanced': {
				build: { statusBarVisibility: 'hidden' },
				launch: { statusBarVisibility: 'hidden' },
				debug: { statusBarVisibility: 'hidden' },
			},
		});
	});

	// Review finding: `**` becomes `.*` in clangd's glob, so `/opt/**/bin/…` also matched
	// `/opt/../home/<user>/<repo>/bin/…` — a compiler shipped inside a repository.
	test('clangd --query-driver allow-list: real toolchain folders only, single-segment wildcards', () => {
		const drivers = [...ARM_QUERY_DRIVERS, ...ESP_QUERY_DRIVERS].map(d => d.replace('${userHome}', '/home/u'));
		// clangd's glob: `**` → any characters, `*` → anything but '/'.
		const toRegex = (glob: string) => new RegExp('^' + glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*') + '$');
		const allowed = (p: string) => drivers.some(d => toRegex(d).test(p));
		assert.ok(drivers.every(d => !d.includes('**')));
		assert.deepStrictEqual([
			'/usr/bin/arm-none-eabi-gcc',
			'/opt/gcc-arm-none-eabi-10/bin/arm-none-eabi-gcc',
			'/opt/st/stm32cubeide_2.2.0/plugins/com.st.gnu-tools-for-stm32.14.3/tools/bin/arm-none-eabi-gcc',
			'/home/u/.local/share/roboagent/tools/xpack-arm-none-eabi-gcc/15.2.1-1.1/xpack-arm-none-eabi-gcc-15.2.1-1.1/bin/arm-none-eabi-gcc',
			'/home/u/.espressif/tools/xtensa-esp-elf/esp-15.2.0_20251204/xtensa-esp-elf/bin/xtensa-esp32s3-elf-gcc',
			'/home/u/.espressif/tools/riscv32-esp-elf/esp-15.2.0_20251204/riscv32-esp-elf/bin/riscv32-esp-elf-gcc',
		].map(allowed), [true, true, true, true, true, true]);
		assert.deepStrictEqual([
			'/opt/../home/u/repo/bin/arm-none-eabi-gcc',
			'/home/u/repo/tools/bin/arm-none-eabi-gcc',
			'/home/u/.espressif/tools/../../repo/x/bin/xtensa-esp32-elf-gcc',
			'/tmp/evil/bin/arm-none-eabi-gcc',
		].map(allowed), [false, false, false, false]);
	});

	test('problem matchers for gcc, colcon and CMake are contributed', () => {
		assert.deepStrictEqual(manifest.contributes.problemMatchers.map(m => m.name), ['colcon', 'roboagent-gcc', 'roboagent-cmake']);
	});
});
