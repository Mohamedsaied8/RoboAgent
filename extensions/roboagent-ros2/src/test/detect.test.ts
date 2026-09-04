/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detectEsp32, detectMode, detectRos2, detectStm32, findFile } from '../modes/detect';

async function tmp(): Promise<string> {
	return fs.promises.mkdtemp(path.join(os.tmpdir(), 'roboagent-detect-'));
}

async function touch(root: string, rel: string, content = ''): Promise<void> {
	const p = path.join(root, ...rel.split('/'));
	await fs.promises.mkdir(path.dirname(p), { recursive: true });
	await fs.promises.writeFile(p, content);
}

suite('Mode detection', () => {
	const dirs: string[] = [];
	teardown(async () => {
		await Promise.all(dirs.splice(0).map(d => fs.promises.rm(d, { recursive: true, force: true })));
	});

	test('empty folder detects nothing', async () => {
		const root = await tmp(); dirs.push(root);
		assert.strictEqual(await detectMode(root), undefined);
	});

	test('STM32: .ioc file, STM32CubeIDE folder, or RoboAgent toolchain file', async () => {
		const a = await tmp(); dirs.push(a);
		await touch(a, 'firmware/board.ioc');
		assert.strictEqual(await detectStm32(a), true);
		const b = await tmp(); dirs.push(b);
		await fs.promises.mkdir(path.join(b, 'STM32CubeIDE'));
		assert.strictEqual(await detectStm32(b), true);
		const c = await tmp(); dirs.push(c);
		await touch(c, 'cmake/arm-none-eabi.cmake');
		assert.strictEqual(await detectStm32(c), true);
		assert.strictEqual(await detectEsp32(c), false);
	});

	test('ESP32: sdkconfig or IDF markers in CMakeLists', async () => {
		const a = await tmp(); dirs.push(a);
		await touch(a, 'sdkconfig.defaults', 'CONFIG_IDF_TARGET="esp32s3"\n');
		assert.strictEqual(await detectEsp32(a), true);
		const b = await tmp(); dirs.push(b);
		await touch(b, 'CMakeLists.txt', 'include($ENV{IDF_PATH}/tools/cmake/project.cmake)\nproject(x)\n');
		assert.strictEqual(await detectEsp32(b), true);
		const c = await tmp(); dirs.push(c);
		await touch(c, 'main/CMakeLists.txt', 'idf_component_register(SRCS "main.c")\n');
		assert.strictEqual(await detectEsp32(c), true);
		const d = await tmp(); dirs.push(d);
		await touch(d, 'CMakeLists.txt', 'project(plain)\n');
		assert.strictEqual(await detectEsp32(d), false);
	});

	test('ROS2: package.xml at root or under src/', async () => {
		const a = await tmp(); dirs.push(a);
		await touch(a, 'package.xml', '<package/>');
		assert.strictEqual(await detectRos2(a), true);
		const b = await tmp(); dirs.push(b);
		await touch(b, 'src/my_pkg/package.xml', '<package/>');
		assert.strictEqual(await detectRos2(b), true);
		const c = await tmp(); dirs.push(c);
		await touch(c, 'build/my_pkg/package.xml', '<package/>');   // build output is ignored
		assert.strictEqual(await detectRos2(c), false);
	});

	test('priority: STM32 and ESP32 markers win over a package.xml (micro-ROS firmware)', async () => {
		const a = await tmp(); dirs.push(a);
		await touch(a, 'src/uros/package.xml');
		await touch(a, 'sdkconfig');
		assert.strictEqual(await detectMode(a), 'esp32');
		await touch(a, 'board.ioc');
		assert.strictEqual(await detectMode(a), 'stm32');
	});

	test('findFile honours depth and skips build directories', async () => {
		const a = await tmp(); dirs.push(a);
		await touch(a, 'x/y/z/deep.ioc');
		assert.strictEqual(await findFile(a, n => n.endsWith('.ioc'), 2), undefined);
		assert.ok(await findFile(a, n => n.endsWith('.ioc'), 3));
		await touch(a, 'node_modules/skipped.ioc');
		assert.strictEqual(await findFile(a, n => n === 'skipped.ioc', 5), undefined);
	});
});
