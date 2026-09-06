/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  STM32 toolchain check: what each purpose needs, and the install command per package manager.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { installVscodeStub } from './vscodeStub';

installVscodeStub();
const { describeStm32Tools, missingStm32Tools, probeStm32Tools, requiredStm32Tools, resolveToolchainBinDir, stm32InstallCommand } = require('../modes/stm32/ensureToolchain') as typeof import('../modes/stm32/ensureToolchain');
import type { Stm32Tool, Stm32Tools } from '../modes/stm32/ensureToolchain';
import { FakeHost } from './fakeHost';

function tools(present: Stm32Tool[], extra: Partial<Stm32Tools> = {}): Stm32Tools {
	return { toolchainDir: undefined, gdbPath: undefined, present: new Set(present), ...extra };
}

suite('STM32 toolchain check', () => {
	test('requirements per purpose', () => {
		assert.deepStrictEqual(requiredStm32Tools('create'), ['gcc']);
		assert.deepStrictEqual(requiredStm32Tools('build', 'cmake'), ['gcc', 'cmake']);
		assert.deepStrictEqual(requiredStm32Tools('build', 'make'), ['gcc', 'make']);
		assert.deepStrictEqual(requiredStm32Tools('debug'), ['openocd', 'gdb']);
		assert.deepStrictEqual(requiredStm32Tools(undefined), ['gcc', 'cmake', 'openocd', 'gdb']);
	});

	test('missing tools', () => {
		assert.deepStrictEqual(missingStm32Tools(tools(['gcc']), ['gcc', 'cmake']), ['cmake']);
		assert.deepStrictEqual(missingStm32Tools(tools([]), ['openocd', 'gdb']), ['openocd', 'gdb']);
		assert.deepStrictEqual(missingStm32Tools(tools(['gcc', 'cmake', 'openocd', 'gdb']), requiredStm32Tools(undefined)), []);
	});

	test('install commands per package manager', () => {
		assert.strictEqual(stm32InstallCommand('apt', ['gcc', 'cmake']), 'sudo apt-get update && sudo apt-get install -y gcc-arm-none-eabi libnewlib-arm-none-eabi libstdc++-arm-none-eabi-newlib cmake');
		assert.strictEqual(stm32InstallCommand('apt', ['openocd', 'gdb']), 'sudo apt-get update && sudo apt-get install -y openocd gdb-multiarch');
		assert.strictEqual(stm32InstallCommand('dnf', ['gcc', 'openocd', 'gdb']), 'sudo dnf install -y arm-none-eabi-gcc-cs arm-none-eabi-gcc-cs-c++ arm-none-eabi-newlib openocd gdb');
		assert.strictEqual(stm32InstallCommand('pacman', ['gcc', 'gdb', 'make']), 'sudo pacman -S --needed arm-none-eabi-gcc arm-none-eabi-newlib arm-none-eabi-gdb make');
		assert.strictEqual(stm32InstallCommand('brew', ['gcc', 'openocd', 'cmake']), 'brew install --cask gcc-arm-embedded && brew install open-ocd cmake');
		assert.strictEqual(stm32InstallCommand('brew', ['gdb']), 'brew install --cask gcc-arm-embedded');
		assert.strictEqual(stm32InstallCommand('brew', ['openocd']), 'brew install open-ocd');
	});

	test('probe: PATH tools, gdb resolution order, stale toolchainPath ignored', async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'roboagent-stm32-tools-'));
		try {
			const host = new FakeHost();
			let probed = await probeStm32Tools(host);
			assert.deepStrictEqual([...probed.present], []);
			assert.strictEqual(probed.gdbPath, undefined);
			assert.ok(describeStm32Tools(probed).includes('no arm-none-eabi-gcc'));

			host.tools.add('arm-none-eabi-gcc').add('cmake').add('openocd').add('gdb-multiarch');
			probed = await probeStm32Tools(host);
			assert.deepStrictEqual([...probed.present].sort(), ['cmake', 'gcc', 'gdb', 'openocd']);
			assert.strictEqual(probed.gdbPath, 'gdb-multiarch');
			assert.strictEqual(probed.toolchainDir, undefined, 'on PATH means no explicit dir');

			host.tools.add('arm-none-eabi-gdb');
			assert.strictEqual((await probeStm32Tools(host)).gdbPath, 'arm-none-eabi-gdb', 'the Arm gdb beats gdb-multiarch');

			// A toolchain directory with its own gdb wins over PATH.
			const bin = path.join(root, 'arm', 'bin');
			await fs.promises.mkdir(bin, { recursive: true });
			await fs.promises.writeFile(path.join(bin, 'arm-none-eabi-gcc'), '');
			await fs.promises.writeFile(path.join(bin, 'arm-none-eabi-gdb'), '');
			host.settings.set('roboagent.stm32.toolchainPath', bin);
			probed = await probeStm32Tools(host);
			assert.strictEqual(probed.toolchainDir, bin);
			assert.strictEqual(probed.gdbPath, path.join(bin, 'arm-none-eabi-gdb'));

			// A stale setting is ignored (gcc still counts from PATH) and logged.
			host.settings.set('roboagent.stm32.toolchainPath', path.join(root, 'gone'));
			probed = await probeStm32Tools(host);
			assert.strictEqual(probed.toolchainDir, undefined);
			assert.ok(probed.present.has('gcc'));
			assert.ok(host.logs.some(l => l.includes('has no arm-none-eabi-gcc')), host.logs.join('\n'));

			assert.strictEqual(await resolveToolchainBinDir(host, path.join(root, 'arm')), bin, 'parent folder resolves to bin/');
			assert.strictEqual(await resolveToolchainBinDir(host, bin), bin);
			assert.strictEqual(await resolveToolchainBinDir(host, root), undefined);
		} finally {
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});
});
