/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Reading existing STM32 projects: build plan, firmware images, MCU part number, and the tools
 *  bundled in an STM32CubeIDE install.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findCMakeToolchainFile, findFirmwareImages, planStm32Build, readStm32Part } from '../modes/stm32/project';
import { stm32CubeIdeTools } from '../modes/toolchains';

async function touch(root: string, rel: string, content = ''): Promise<string> {
	const p = path.join(root, ...rel.split('/'));
	await fs.promises.mkdir(path.dirname(p), { recursive: true });
	await fs.promises.writeFile(p, content);
	return p;
}

suite('STM32 project reading', () => {
	let root: string;
	setup(async () => { root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'roboagent-stm32-project-')); });
	teardown(() => fs.promises.rm(root, { recursive: true, force: true }));

	test('no build definition, no plan', async () => {
		assert.strictEqual(await planStm32Build(root), undefined);
	});

	test('CMake: a toolchain file set in CMakeLists.txt is not passed again; TOOLCHAIN_PATH support is detected', async () => {
		await touch(root, 'CMakeLists.txt', 'set(CMAKE_TOOLCHAIN_FILE ${CMAKE_CURRENT_SOURCE_DIR}/cmake/arm-none-eabi.cmake)\n');
		await touch(root, 'cmake/arm-none-eabi.cmake', 'if(DEFINED TOOLCHAIN_PATH)\nendif()\nset(CMAKE_C_COMPILER arm-none-eabi-gcc)\n');
		assert.deepStrictEqual(await planStm32Build(root), { buildSystem: 'cmake', options: { toolchainFile: undefined, cachedGenerator: undefined }, usesToolchainPath: true });
	});

	test('CMake: toolchain file from CMakePresets.json, else a *.cmake that sets an arm-none-eabi compiler', async () => {
		await touch(root, 'CMakeLists.txt', '# cmake -DCMAKE_TOOLCHAIN_FILE=x.cmake (a comment, not a setting)\nproject(p)\n');
		await touch(root, 'tools.cmake', 'set(CMAKE_C_COMPILER arm-none-eabi-gcc)\n');
		assert.strictEqual(await findCMakeToolchainFile(root), 'tools.cmake');
		await touch(root, 'presets/stm32.cmake', 'set(CMAKE_C_COMPILER arm-none-eabi-gcc)\n');
		await touch(root, 'CMakePresets.json', JSON.stringify({ configurePresets: [{ name: 'base' }, { name: 'Debug', toolchainFile: '${sourceDir}/presets/stm32.cmake' }] }));
		assert.strictEqual(await findCMakeToolchainFile(root), path.join('presets', 'stm32.cmake'));
		const plan = await planStm32Build(root);
		assert.strictEqual(plan?.options.toolchainFile, path.join('presets', 'stm32.cmake'));
		assert.strictEqual(plan?.usesToolchainPath, false);
	});

	test('Makefile and STM32CubeIDE managed build', async () => {
		await touch(root, 'Debug/makefile', 'all:\n');
		assert.deepStrictEqual(await planStm32Build(root), { buildSystem: 'make', options: { makeDirectory: 'Debug' }, usesToolchainPath: false });
		await touch(root, 'Makefile', 'PREFIX := $(TOOLCHAIN_PATH)/arm-none-eabi-\n');
		assert.deepStrictEqual(await planStm32Build(root), { buildSystem: 'make', options: {}, usesToolchainPath: true });
	});

	test('firmware images: newest first, CMakeFiles ignored', async () => {
		const old = await touch(root, 'Debug/app.elf');
		await fs.promises.utimes(old, new Date(2020, 1, 1), new Date(2020, 1, 1));
		const fresh = await touch(root, 'build/app.elf');
		await touch(root, 'build/CMakeFiles/probe.elf');
		assert.deepStrictEqual(await findFirmwareImages(root), [fresh, old]);
	});

	test('MCU part: .ioc, then .cproject, then the linker script name', async () => {
		assert.strictEqual(await readStm32Part(root), undefined);
		await touch(root, 'STM32F103C8TX_FLASH.ld');
		assert.strictEqual(await readStm32Part(root), 'STM32F103C8TX');
		await touch(root, '.cproject', '<option superClass="com.st.stm32cube.ide.mcu.gnu.managedbuild.option.target_mcu" useByScannerDiscovery="true" value="STM32F103CBTx" valueType="string"/>');
		assert.strictEqual(await readStm32Part(root), 'STM32F103CBTX');
		await touch(root, 'board.ioc', 'Mcu.Family=STM32F4\nMcu.CPN=STM32F407VGT6\nMcu.Name=STM32F407V(E-G)Tx\n');
		assert.strictEqual(await readStm32Part(root), 'STM32F407VGT6');
	});

	test('STM32CubeIDE bundled tools', async () => {
		const plugins = path.join(root, 'stm32cubeide_2.2.0', 'plugins');
		assert.deepStrictEqual(await stm32CubeIdeTools([path.dirname(plugins)]), { gccBinDir: undefined, openocdPath: undefined, openocdScriptsDir: undefined });
		const gcc = await touch(plugins, 'com.st.stm32cube.ide.mcu.externaltools.gnu-tools-for-stm32.14.3.rel1.linux64_1.0.100/tools/bin/arm-none-eabi-gcc');
		await touch(plugins, 'com.st.stm32cube.ide.mcu.debug.openocd_2.3.400/resources/openocd/st_scripts/target/stm32f1x.cfg');
		// Scripts alone are useless without the OpenOCD binary.
		assert.deepStrictEqual(await stm32CubeIdeTools([path.dirname(plugins)]), { gccBinDir: path.dirname(gcc), openocdPath: undefined, openocdScriptsDir: undefined });
		const openocd = await touch(plugins, 'com.st.stm32cube.ide.mcu.externaltools.openocd.linux64_2.4.500/tools/bin/openocd');
		assert.deepStrictEqual(await stm32CubeIdeTools([path.dirname(plugins)]), {
			gccBinDir: path.dirname(gcc),
			openocdPath: openocd,
			openocdScriptsDir: path.join(plugins, 'com.st.stm32cube.ide.mcu.debug.openocd_2.3.400', 'resources', 'openocd', 'st_scripts'),
		});
	});
});
