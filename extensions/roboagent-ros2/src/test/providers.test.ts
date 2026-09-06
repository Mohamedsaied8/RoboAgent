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

	/** A fake unpacked Arm toolchain: `<root>/arm/bin/arm-none-eabi-gcc` (+ gdb). */
	async function fakeToolchain(): Promise<string> {
		const bin = path.join(root, 'arm', 'bin');
		await fs.promises.mkdir(bin, { recursive: true });
		await fs.promises.writeFile(path.join(bin, 'arm-none-eabi-gcc'), '');
		await fs.promises.writeFile(path.join(bin, 'arm-none-eabi-gdb'), '');
		return bin;
	}

	async function fakeElf(): Promise<void> {
		await fs.promises.mkdir(path.join(root, 'build'), { recursive: true });
		await fs.promises.writeFile(path.join(root, 'build', 'fw.elf'), 'ELF');
	}

	const INSTALL_APT = 'Install with apt…';
	const USE_EXISTING = 'Use Existing Toolchain…';

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
		assert.strictEqual(host.messages.length, 0, 'no prompt when the toolchain is present');
	});

	test('build passes the configured toolchain path and ignores a stale one', async () => {
		const bin = await fakeToolchain();
		host.tools.add('cmake');
		host.settings.set('roboagent.stm32.toolchainPath', bin);
		await new Stm32ModeProvider(host).build();
		assert.ok(host.tasks[0].command.includes(`-DTOOLCHAIN_PATH=${bin}`), host.tasks[0].command);

		const stale = new FakeHost();
		stale.tools.add('arm-none-eabi-gcc').add('cmake');
		stale.settings.set('roboagent.stm32.toolchainPath', '/opt/arm/bin');
		await new Stm32ModeProvider(stale).build();
		assert.strictEqual(stale.tasks.length, 1);
		assert.ok(!stale.tasks[0].command.includes('TOOLCHAIN_PATH'), stale.tasks[0].command);
	});

	test('build without the toolchain does not build; it offers to install or locate it', async () => {
		host.tools.add('apt-get');
		await new Stm32ModeProvider(host).build();
		assert.strictEqual(host.tasks.length, 0);
		assert.strictEqual(host.messages.length, 1);
		assert.strictEqual(host.messages[0].level, 'warning');
		assert.ok(host.messages[0].message.includes('missing: arm-none-eabi-gcc (Arm GNU toolchain), cmake'), host.messages[0].message);
		assert.ok(host.messages[0].message.includes('cannot be built'), host.messages[0].message);
		assert.deepStrictEqual(host.messages[0].actions, [INSTALL_APT, USE_EXISTING]);
	});

	test('"Install with apt…" runs the apt command for exactly the missing tools in a terminal', async () => {
		host.tools.add('apt-get').add('cmake');
		host.autoPick = INSTALL_APT;
		await new Stm32ModeProvider(host).build();
		assert.strictEqual(host.tasks.length, 0);
		assert.strictEqual(host.terminals.length, 1);
		assert.strictEqual(host.terminals[0].name, 'RoboAgent: STM32 toolchain install');
		assert.strictEqual(host.terminals[0].command, 'sudo apt-get update && sudo apt-get install -y gcc-arm-none-eabi libnewlib-arm-none-eabi libstdc++-arm-none-eabi-newlib');
		assert.ok(host.messages.some(m => m.level === 'info' && m.message.includes('run Create / Build / Debug again')), JSON.stringify(host.messages));
	});

	test('other package managers, and the download page when there is none', async () => {
		const brew = new FakeHost();
		brew.tools.add('brew');
		brew.autoPick = 'Install with Homebrew…';
		await new Stm32ModeProvider(brew).build();
		assert.strictEqual(brew.terminals[0].command, 'brew install --cask gcc-arm-embedded && brew install cmake');

		const none = new FakeHost();
		none.autoPick = 'Download Toolchain…';
		await new Stm32ModeProvider(none).build();
		assert.strictEqual(none.terminals.length, 0);
		assert.deepStrictEqual(none.opened, ['https://developer.arm.com/downloads/-/arm-gnu-toolchain-downloads']);
		assert.ok(none.messages[0].message.endsWith('Download it now?'), none.messages[0].message);
	});

	test('"Use Existing Toolchain…" validates the folder, stores roboagent.stm32.toolchainPath and builds', async () => {
		host.tools.add('cmake');
		host.autoPick = USE_EXISTING;
		host.folderToPick = root;   // no compiler in there
		await new Stm32ModeProvider(host).build();
		assert.strictEqual(host.tasks.length, 0);
		assert.ok(host.messages.some(m => m.level === 'error' && m.message.includes('contains no arm-none-eabi-gcc')), JSON.stringify(host.messages));
		assert.strictEqual(host.settings.get('roboagent.stm32.toolchainPath'), undefined);

		const ok = new FakeHost();
		ok.tools.add('cmake');
		ok.autoPick = USE_EXISTING;
		const bin = await fakeToolchain();
		ok.folderToPick = path.dirname(bin);   // the unpacked archive root; bin/ is found inside
		await new Stm32ModeProvider(ok).build();
		assert.strictEqual(ok.settings.get('roboagent.stm32.toolchainPath'), bin);
		assert.strictEqual(ok.tasks.length, 1);
		assert.ok(ok.tasks[0].command.includes(`-DTOOLCHAIN_PATH=${bin}`), ok.tasks[0].command);
	});

	test('debug offers to build when no .elf exists, then starts Cortex-Debug', async () => {
		host.tools.add('arm-none-eabi-gcc').add('cmake').add('openocd').add('arm-none-eabi-gdb');
		host.installed.add('marus25.cortex-debug');
		host.autoPick = 'Build now';
		// Simulate the build producing the image.
		host.runShellTask = async req => {
			host.tasks.push(req);
			await fakeElf();
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
		assert.strictEqual(cfg.gdbPath, undefined, 'the default arm-none-eabi-gdb needs no override');
		assert.strictEqual(cfg.armToolchainPath, undefined);
	});

	test('debug points Cortex-Debug at gdb-multiarch / an off-PATH toolchain when that is what exists', async () => {
		await fakeElf();
		host.tools.add('openocd').add('gdb-multiarch');
		host.installed.add('marus25.cortex-debug');
		await new Stm32ModeProvider(host).debug();
		assert.strictEqual(host.debugSessions[0].configuration.gdbPath, 'gdb-multiarch');

		const offPath = new FakeHost();
		offPath.tools.add('openocd');
		offPath.installed.add('marus25.cortex-debug');
		const bin = await fakeToolchain();
		offPath.settings.set('roboagent.stm32.toolchainPath', bin);
		await new Stm32ModeProvider(offPath).debug();
		assert.strictEqual(offPath.debugSessions[0].configuration.armToolchainPath, bin);
		assert.strictEqual(offPath.debugSessions[0].configuration.gdbPath, undefined);
	});

	test('debug falls back to cpptools + OpenOCD when Cortex-Debug is absent but gdb exists', async () => {
		await fakeElf();
		host.tools.add('arm-none-eabi-gdb').add('openocd');
		await new Stm32ModeProvider(host).debug();
		assert.strictEqual(host.debugSessions[0].configuration.type, 'cppdbg');
		assert.strictEqual(host.debugSessions[0].configuration.miDebuggerPath, 'arm-none-eabi-gdb');
		assert.strictEqual(host.debugSessions[0].configuration.miDebuggerServerAddress, 'localhost:3333');

		const multiarch = new FakeHost();
		multiarch.tools.add('gdb-multiarch').add('openocd');
		await new Stm32ModeProvider(multiarch).debug();
		assert.strictEqual(multiarch.debugSessions[0].configuration.miDebuggerPath, 'gdb-multiarch');
	});

	test('debug without openocd / gdb offers the toolchain installer instead of a session', async () => {
		await fakeElf();
		host.tools.add('arm-none-eabi-gcc').add('cmake').add('apt-get');
		host.installed.add('marus25.cortex-debug');
		await new Stm32ModeProvider(host).debug();
		assert.strictEqual(host.debugSessions.length, 0);
		assert.strictEqual(host.messages.length, 1);
		assert.ok(host.messages[0].message.includes('missing: openocd, arm-none-eabi-gdb / gdb-multiarch'), host.messages[0].message);
		assert.ok(host.messages[0].message.includes('cannot be flashed or debugged'), host.messages[0].message);
		assert.deepStrictEqual(host.messages[0].actions, [INSTALL_APT, USE_EXISTING]);

		host.autoPick = INSTALL_APT;
		await new Stm32ModeProvider(host).debug();
		assert.strictEqual(host.terminals[0].command, 'sudo apt-get update && sudo apt-get install -y openocd gdb-multiarch');
	});

	test('create without a compiler asks first and stops unless the user chooses to go on', async () => {
		host.tools.add('apt-get');
		await new Stm32ModeProvider(host).create();
		assert.strictEqual(host.messages.length, 1);
		assert.ok(host.messages[0].message.includes('can be created, but it cannot be built'), host.messages[0].message);
		assert.deepStrictEqual(host.messages[0].actions, [INSTALL_APT, USE_EXISTING, 'Create Anyway']);
		assert.ok(host.logs.some(l => l.includes('Create cancelled')), host.logs.join('\n'));

		const install = new FakeHost();
		install.tools.add('apt-get');
		install.autoPick = INSTALL_APT;
		await new Stm32ModeProvider(install).create();
		assert.strictEqual(install.terminals[0].command, 'sudo apt-get update && sudo apt-get install -y gcc-arm-none-eabi libnewlib-arm-none-eabi libstdc++-arm-none-eabi-newlib');
		assert.ok(install.logs.some(l => l.includes('Create cancelled')), 'the wizard does not run while the installer is running');
	});

	test('the palette check reports a complete toolchain', async () => {
		const { ensureStm32Toolchain } = require('../modes/stm32/ensureToolchain') as typeof import('../modes/stm32/ensureToolchain');
		host.tools.add('arm-none-eabi-gcc').add('cmake').add('openocd').add('gdb-multiarch');
		const result = await ensureStm32Toolchain(host);
		assert.strictEqual(result.ready, true);
		assert.strictEqual(host.messages[0].level, 'info');
		assert.ok(host.messages[0].message.includes('STM32 toolchain found: arm-none-eabi-gcc on PATH, cmake, no make, openocd, gdb: gdb-multiarch'), host.messages[0].message);
	});
});

suite('ESP32 provider', () => {
	let root: string;
	let host: FakeHost;
	const savedEnv = { HOME: process.env['HOME'], IDF_PATH: process.env['IDF_PATH'] };
	setup(async () => {
		root = await tmp('roboagent-esp32-');
		await fs.promises.writeFile(path.join(root, 'sdkconfig.defaults'), 'CONFIG_IDF_TARGET="esp32"\n');
		vscodeStub.setFolders(root);
		host = new FakeHost();
		// Discovery also looks at $IDF_PATH and the home directory: isolate the test from this machine.
		process.env['HOME'] = root;
		delete process.env['IDF_PATH'];
	});
	teardown(async () => {
		process.env['HOME'] = savedEnv.HOME;
		if (savedEnv.IDF_PATH !== undefined) { process.env['IDF_PATH'] = savedEnv.IDF_PATH; }
		await fs.promises.rm(root, { recursive: true, force: true });
	});

	/** A fake ESP-IDF checkout under the temp root (not registered anywhere). */
	async function fakeIdf(name = 'esp-idf'): Promise<string> {
		const idf = path.join(root, name);
		await fs.promises.mkdir(path.join(idf, 'tools', 'cmake'), { recursive: true });
		await fs.promises.writeFile(path.join(idf, 'tools', 'idf.py'), '');
		await fs.promises.writeFile(path.join(idf, 'tools', 'cmake', 'version.cmake'), 'set(IDF_VERSION_MAJOR 5)\nset(IDF_VERSION_MINOR 3)\nset(IDF_VERSION_PATCH 1)\n');
		return idf;
	}

	const INSTALL = 'Install ESP-IDF…';
	const USE_EXISTING = 'Use Existing Install…';

	test('build goes through espIdf.buildDevice when the ESP-IDF extension is installed', async () => {
		host.installed.add('espressif.esp-idf-extension');
		host.settings.set('roboagent.esp32.idfPath', await fakeIdf());
		await new Esp32ModeProvider(host).build();
		assert.deepStrictEqual(host.commands.map(c => c.id), ['espIdf.buildDevice']);
		assert.strictEqual(host.tasks.length, 0);
		assert.strictEqual(host.messages.length, 0, 'no prompt when ESP-IDF is present');
		assert.ok(host.logs.some(l => l.includes('ESP-IDF v5.3.1')), host.logs.join('\n'));
	});

	test('build falls back to idf.py in an IDF-activated task', async () => {
		const idf = await fakeIdf();
		host.settings.set('roboagent.esp32.idfPath', idf);
		await new Esp32ModeProvider(host).build();
		assert.strictEqual(host.tasks.length, 1);
		assert.strictEqual(host.tasks[0].command, `IDF_PATH=${idf}; export IDF_PATH; . "$IDF_PATH/export.sh" >/dev/null && idf.py build`);
		assert.deepStrictEqual(host.tasks[0].problemMatchers, ['$roboagent-gcc']);
	});

	test('build finds an ESP-IDF registered by the Installation Manager (eim_idf.json under ~/.espressif)', async () => {
		const idf = await fakeIdf(path.join('.espressif', 'v5.3.1', 'esp-idf'));
		await fs.promises.mkdir(path.join(root, '.espressif', 'tools'), { recursive: true });
		await fs.promises.writeFile(path.join(root, '.espressif', 'tools', 'eim_idf.json'), JSON.stringify({ idfSelectedId: 'x', idfInstalled: { x: { name: 'v5.3.1', path: idf } } }));
		await new Esp32ModeProvider(host).build();
		assert.strictEqual(host.messages.length, 0);
		assert.strictEqual(host.tasks.length, 1);
		assert.ok(host.tasks[0].command.startsWith(`IDF_PATH=${idf};`), host.tasks[0].command);
	});

	test('build without ESP-IDF does not build; it offers to install or locate it', async () => {
		host.installed.add('espressif.esp-idf-extension');
		await new Esp32ModeProvider(host).build();
		assert.deepStrictEqual(host.commands, [], 'espIdf.buildDevice must not run without a toolchain');
		assert.strictEqual(host.tasks.length, 0);
		assert.strictEqual(host.messages.length, 1);
		assert.strictEqual(host.messages[0].level, 'warning');
		assert.ok(host.messages[0].message.includes('ESP-IDF was not found'), host.messages[0].message);
		assert.ok(host.messages[0].message.includes('cannot be built'), host.messages[0].message);
		assert.deepStrictEqual(host.messages[0].actions, [INSTALL, USE_EXISTING]);
	});

	test('"Install ESP-IDF…" opens the Installation Manager through the extension, or its download page without it', async () => {
		host.installed.add('espressif.esp-idf-extension');
		host.autoPick = INSTALL;
		await new Esp32ModeProvider(host).build();
		assert.deepStrictEqual(host.commands.map(c => c.id), ['espIdf.installManager']);
		assert.deepStrictEqual(host.opened, []);
		assert.strictEqual(host.tasks.length, 0);

		const bare = new FakeHost();
		bare.autoPick = INSTALL;
		await new Esp32ModeProvider(bare).build();
		assert.deepStrictEqual(bare.commands, []);
		assert.deepStrictEqual(bare.opened, ['https://dl.espressif.com/dl/eim/']);
	});

	test('"Use Existing Install…" validates the folder, stores roboagent.esp32.idfPath and builds', async () => {
		host.autoPick = USE_EXISTING;
		host.folderToPick = root;   // not a checkout
		await new Esp32ModeProvider(host).build();
		assert.strictEqual(host.tasks.length, 0);
		assert.ok(host.messages.some(m => m.level === 'error' && m.message.includes('tools/idf.py')), JSON.stringify(host.messages));
		assert.strictEqual(host.settings.get('roboagent.esp32.idfPath'), undefined);

		const ok = new FakeHost();
		ok.autoPick = USE_EXISTING;
		ok.folderToPick = await fakeIdf();
		await new Esp32ModeProvider(ok).build();
		assert.strictEqual(ok.settings.get('roboagent.esp32.idfPath'), ok.folderToPick);
		assert.strictEqual(ok.tasks.length, 1);
		assert.ok(ok.tasks[0].command.startsWith(`IDF_PATH=${ok.folderToPick};`), ok.tasks[0].command);
	});

	test('debug: extension session first, flash+monitor fallback when it does not start', async () => {
		host.installed.add('espressif.esp-idf-extension');
		host.settings.set('roboagent.esp32.idfPath', await fakeIdf());
		host.debugStarts = false;
		host.autoPick = 'Flash + Monitor';
		await new Esp32ModeProvider(host).debug();
		assert.strictEqual(host.debugSessions[0].configuration.type, 'gdbtarget');
		assert.deepStrictEqual(host.commands.map(c => c.id), ['espIdf.buildFlashMonitor']);
	});

	test('debug without the extension offers a terminal flash+monitor', async () => {
		const idf = await fakeIdf();
		host.settings.set('roboagent.esp32.idfPath', idf);
		host.settings.set('roboagent.esp32.port', '/dev/ttyUSB1');
		host.autoPick = 'Flash + Monitor';
		await new Esp32ModeProvider(host).debug();
		assert.strictEqual(host.debugSessions.length, 0);
		assert.strictEqual(host.terminals.length, 1);
		assert.ok(host.terminals[0].command.startsWith(`IDF_PATH=${idf};`), host.terminals[0].command);
		assert.ok(host.terminals[0].command.includes('idf.py -p /dev/ttyUSB1 flash monitor'));
	});

	test('debug without ESP-IDF offers the installer instead of a session', async () => {
		host.installed.add('espressif.esp-idf-extension');
		await new Esp32ModeProvider(host).debug();
		assert.strictEqual(host.debugSessions.length, 0);
		assert.strictEqual(host.terminals.length, 0);
		assert.deepStrictEqual(host.commands, []);
		assert.strictEqual(host.messages.length, 1);
		assert.ok(host.messages[0].message.includes('cannot be flashed or debugged'), host.messages[0].message);
		assert.deepStrictEqual(host.messages[0].actions, [INSTALL, USE_EXISTING]);
	});

	test('create without ESP-IDF asks first and stops unless the user chooses to go on', async () => {
		host.installed.add('espressif.esp-idf-extension');
		await new Esp32ModeProvider(host).create();
		assert.strictEqual(host.messages.length, 1);
		assert.ok(host.messages[0].message.includes('can be created, but it cannot be built'), host.messages[0].message);
		assert.deepStrictEqual(host.messages[0].actions, [INSTALL, USE_EXISTING, 'Create Anyway']);
		assert.deepStrictEqual(host.commands, []);
		assert.ok(host.logs.some(l => l.includes('Create cancelled')), host.logs.join('\n'));

		const install = new FakeHost();
		install.installed.add('espressif.esp-idf-extension');
		install.autoPick = INSTALL;
		await new Esp32ModeProvider(install).create();
		assert.deepStrictEqual(install.commands.map(c => c.id), ['espIdf.installManager']);
		assert.ok(install.logs.some(l => l.includes('Create cancelled')), 'the wizard does not run while the installer is open');
	});

	test('the palette check reports a found installation', async () => {
		const { ensureEspIdf } = require('../modes/esp32/ensureIdf') as typeof import('../modes/esp32/ensureIdf');
		const idf = await fakeIdf();
		host.settings.set('roboagent.esp32.idfPath', idf);
		const result = await ensureEspIdf(host);
		assert.strictEqual(result.installation?.idfPath, idf);
		assert.strictEqual(result.installation?.source, 'setting');
		assert.strictEqual(host.messages[0].level, 'info');
		assert.ok(host.messages[0].message.includes('ESP-IDF v5.3.1 found'), host.messages[0].message);
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
