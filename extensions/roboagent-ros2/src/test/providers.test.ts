/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Provider tests: the Build/Debug dispatch of each ModeProvider against a recording FakeHost
 *  and a stubbed `vscode` module (installed before the providers are required).
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { installVscodeStub } from './vscodeStub';

const vscodeStub = installVscodeStub();

// Required after the stub so their `import * as vscode from 'vscode'` resolves to it.
const { Stm32ModeProvider } = require('../modes/stm32/stm32ModeProvider') as typeof import('../modes/stm32/stm32ModeProvider');
const { Esp32ModeProvider } = require('../modes/esp32/esp32ModeProvider') as typeof import('../modes/esp32/esp32ModeProvider');
const { Ros2ModeProvider } = require('../modes/ros2/ros2ModeProvider') as typeof import('../modes/ros2/ros2ModeProvider');
import { FakeHost } from './fakeHost';
import { generateStm32Project } from '../modes/stm32/generator';
import { resolveTarget } from '../modes/stm32/mcuDatabase';
import { writeFileSet } from '../modes/scaffold';

async function tmp(prefix: string): Promise<string> {
	return fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
}

suite('STM32 provider', () => {
	let root: string;
	let host: FakeHost;
	setup(async () => {
		root = await tmp('roboagent-stm32-');
		await writeFileSet(root, generateStm32Project({ name: 'fw', target: resolveTarget('STM32F407VGT6'), kind: 'executable', toolchain: 'cmake', openocdInterface: 'stlink' }));
		vscodeStub.setFolders(root);
		vscodeStub.window.activeTextEditor = undefined;
		host = new FakeHost();
	});
	teardown(() => fs.promises.rm(root, { recursive: true, force: true }));

	test('detect recognises the generated project', async () => {
		assert.strictEqual(await new Stm32ModeProvider(host).detect(root), true);
	});

	test('build runs the CMake configure+build task with the gcc matcher', async () => {
		host.tools.add('arm-none-eabi-gcc').add('cmake');
		const exit = await new Stm32ModeProvider(host).build();
		assert.strictEqual(exit, 0);
		assert.strictEqual(host.tasks.length, 1);
		const task = host.tasks[0];
		assert.strictEqual(task.cwd, root);
		assert.strictEqual(task.name, 'RoboAgent: STM32 build');
		assert.deepStrictEqual(task.problemMatchers, ['$roboagent-gcc']);
		assert.ok(task.command.startsWith('cmake -S . -B build -DCMAKE_BUILD_TYPE=Debug && cmake --build build --parallel'), task.command);
	});

	test('build passes the configured toolchain path and refuses without a compiler', async () => {
		host.settings.set('roboagent.stm32.toolchainPath', '/opt/arm/bin');
		await new Stm32ModeProvider(host).build();
		assert.ok(host.tasks[0].command.includes('-DTOOLCHAIN_PATH=/opt/arm/bin'));

		const bare = new FakeHost();
		await new Stm32ModeProvider(bare).build();
		assert.strictEqual(bare.tasks.length, 0);
		assert.strictEqual(bare.messages[0].level, 'error');
		assert.ok(bare.messages[0].message.includes('arm-none-eabi-gcc'));
	});

	test('debug offers to build when no .elf exists, then starts Cortex-Debug', async () => {
		host.tools.add('arm-none-eabi-gcc').add('openocd');
		host.installed.add('marus25.cortex-debug');
		host.autoPick = 'Build now';
		// Simulate the build producing the image.
		host.runShellTask = async req => {
			host.tasks.push(req);
			await fs.promises.mkdir(path.join(root, 'build'), { recursive: true });
			await fs.promises.writeFile(path.join(root, 'build', 'fw.elf'), 'ELF');
			return { exitCode: 0 };
		};
		await new Stm32ModeProvider(host).debug();
		assert.strictEqual(host.tasks.length, 1, 'built first');
		assert.strictEqual(host.debugSessions.length, 1);
		const cfg = host.debugSessions[0].configuration;
		assert.strictEqual(cfg.type, 'cortex-debug');
		assert.strictEqual(cfg.executable, '${workspaceFolder}/build/fw.elf');
		assert.deepStrictEqual(cfg.configFiles, ['interface/stlink.cfg', 'target/stm32f4x.cfg']);
		assert.strictEqual(cfg.preLaunchTask, undefined);
	});

	test('debug falls back to cpptools + OpenOCD when Cortex-Debug is absent but gdb exists', async () => {
		await fs.promises.mkdir(path.join(root, 'build'), { recursive: true });
		await fs.promises.writeFile(path.join(root, 'build', 'fw.elf'), 'ELF');
		host.tools.add('arm-none-eabi-gdb').add('openocd');
		await new Stm32ModeProvider(host).debug();
		assert.strictEqual(host.debugSessions[0].configuration.type, 'cppdbg');
		assert.strictEqual(host.debugSessions[0].configuration.miDebuggerServerAddress, 'localhost:3333');
	});

	test('debug without any debugger runs the first-run installer instead', async () => {
		await fs.promises.mkdir(path.join(root, 'build'), { recursive: true });
		await fs.promises.writeFile(path.join(root, 'build', 'fw.elf'), 'ELF');
		await new Stm32ModeProvider(host).debug();
		assert.strictEqual(host.debugSessions.length, 0);
		assert.ok(host.messages.some(m => m.actions.includes('Install Cortex-Debug')));
	});
});

suite('ESP32 provider', () => {
	let root: string;
	let host: FakeHost;
	setup(async () => {
		root = await tmp('roboagent-esp32-');
		await fs.promises.writeFile(path.join(root, 'sdkconfig.defaults'), 'CONFIG_IDF_TARGET="esp32"\n');
		vscodeStub.setFolders(root);
		host = new FakeHost();
	});
	teardown(() => fs.promises.rm(root, { recursive: true, force: true }));

	test('build goes through espIdf.buildDevice when the ESP-IDF extension is installed', async () => {
		host.installed.add('espressif.esp-idf-extension');
		await new Esp32ModeProvider(host).build();
		assert.deepStrictEqual(host.commands.map(c => c.id), ['espIdf.buildDevice']);
		assert.strictEqual(host.tasks.length, 0);
	});

	test('build falls back to idf.py in an IDF-activated task', async () => {
		const idf = path.join(root, 'esp-idf');
		await fs.promises.mkdir(path.join(idf, 'tools'), { recursive: true });
		await fs.promises.writeFile(path.join(idf, 'tools', 'idf.py'), '');
		host.settings.set('roboagent.esp32.idfPath', idf);
		await new Esp32ModeProvider(host).build();
		assert.strictEqual(host.tasks.length, 1);
		assert.strictEqual(host.tasks[0].command, `IDF_PATH=${idf}; export IDF_PATH; . "$IDF_PATH/export.sh" >/dev/null && idf.py build`);
		assert.deepStrictEqual(host.tasks[0].problemMatchers, ['$roboagent-gcc']);
	});

	test('debug: extension session first, flash+monitor fallback when it does not start', async () => {
		host.installed.add('espressif.esp-idf-extension');
		host.debugStarts = false;
		host.autoPick = 'Flash + Monitor';
		await new Esp32ModeProvider(host).debug();
		assert.strictEqual(host.debugSessions[0].configuration.type, 'gdbtarget');
		assert.deepStrictEqual(host.commands.map(c => c.id), ['espIdf.buildFlashMonitor']);
	});

	test('debug without the extension offers a terminal flash+monitor', async () => {
		host.settings.set('roboagent.esp32.port', '/dev/ttyUSB1');
		host.autoPick = 'Flash + Monitor';
		await new Esp32ModeProvider(host).debug();
		assert.strictEqual(host.debugSessions.length, 0);
		assert.strictEqual(host.terminals.length, 1);
		assert.ok(host.terminals[0].command.includes('idf.py -p /dev/ttyUSB1 flash monitor'));
	});
});

suite('ROS2 provider', () => {
	let root: string;
	let host: FakeHost;
	setup(async () => {
		root = await tmp('roboagent-ros2-');
		await fs.promises.mkdir(path.join(root, 'src', 'my_pkg'), { recursive: true });
		await fs.promises.writeFile(path.join(root, 'src', 'my_pkg', 'package.xml'), '<package/>');
		vscodeStub.setFolders(root);
		vscodeStub.window.activeTextEditor = undefined;
		host = new FakeHost();
		host.tools.add('colcon');
	});
	teardown(() => fs.promises.rm(root, { recursive: true, force: true }));

	test('build runs colcon build --symlink-install at the workspace root', async () => {
		await new Ros2ModeProvider(host).build();
		assert.strictEqual(host.tasks.length, 1);
		assert.strictEqual(host.tasks[0].cwd, root);
		assert.ok(host.tasks[0].command.endsWith('colcon build --symlink-install'), host.tasks[0].command);
		assert.deepStrictEqual(host.tasks[0].problemMatchers, ['$colcon']);
	});

	test('build scopes to the focused package and passes the configured distro', async () => {
		vscodeStub.window.activeTextEditor = { document: { uri: vscodeStub.Uri.file(path.join(root, 'src', 'my_pkg', 'src', 'node.cpp')) } };
		host.settings.set('roboagent.ros2.distro', 'humble');
		await new Ros2ModeProvider(host).build();
		assert.ok(host.tasks[0].command.endsWith('colcon build --symlink-install --packages-select my_pkg'), host.tasks[0].command);
		assert.strictEqual(host.tasks[0].name, 'RoboAgent: colcon build my_pkg');
		// The distro setting only applies when /opt/ros/<distro> exists or ROS_DISTRO is set.
		const expected = process.env['ROS_DISTRO'] ?? (fs.existsSync('/opt/ros/humble/setup.bash') ? 'humble' : undefined);
		assert.strictEqual(host.tasks[0].env?.['ROS_DISTRO'], expected);
	});

	test('debug with nothing built offers a build', async () => {
		host.autoPick = 'Build now';
		await new Ros2ModeProvider(host).debug();
		assert.strictEqual(host.tasks.length, 1);
		assert.strictEqual(host.commands.length, 0);
	});

	test('debug picks a built node and forwards to roboagent.debugNode', async () => {
		const lib = path.join(root, 'install', 'my_pkg', 'lib', 'my_pkg');
		await fs.promises.mkdir(lib, { recursive: true });
		await fs.promises.writeFile(path.join(lib, 'talker'), '#!/usr/bin/python3\nprint(1)\n', { mode: 0o755 });
		vscodeStub.window.showQuickPick = async (items: unknown[]) => items[0];
		await new Ros2ModeProvider(host).debug();
		assert.strictEqual(host.commands.length, 1);
		assert.strictEqual(host.commands[0].id, 'roboagent.debugNode');
		assert.deepStrictEqual(host.commands[0].args[0], { package: 'my_pkg', node: 'talker', language: 'python' });
	});
});
