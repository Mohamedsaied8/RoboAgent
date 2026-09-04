/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Smoke test: each mode's Create output is a skeleton the real toolchain accepts.
 *  Toolchain-dependent steps run only when the tool is installed (and are reported as
 *  skipped otherwise); the structural checks always run.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { generateEsp32Project } from '../modes/esp32/generator';
import { generateRos2Package } from '../modes/ros2/generator';
import { materialize } from '../modes/scaffold';
import { generateStm32Project } from '../modes/stm32/generator';
import { resolveTarget } from '../modes/stm32/mcuDatabase';
import { detectMode } from '../modes/detect';

function run(command: string, cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<{ code: number | null; out: string }> {
	return new Promise(resolve => {
		cp.exec(command, { cwd, env, timeout: 180_000, shell: '/bin/bash' }, (error, stdout, stderr) => {
			resolve({ code: error ? (error as cp.ExecException).code ?? 1 : 0, out: `${stdout}\n${stderr}` });
		});
	});
}

async function have(tool: string): Promise<boolean> {
	return (await run(`command -v ${tool}`, os.tmpdir())).code === 0;
}

suite('Create skeletons compile (smoke)', () => {
	let root: string;
	suiteSetup(async () => { root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'roboagent-smoke-')); });
	suiteTeardown(() => fs.promises.rm(root, { recursive: true, force: true }));

	test('STM32 executable: structure, detection, and (if arm-none-eabi-gcc + cmake exist) a real configure + build', async function () {
		const dest = path.join(root, 'stm32-exe');
		await materialize(dest, generateStm32Project({ name: 'stm32-exe', target: resolveTarget('STM32F407VGT6'), kind: 'executable', toolchain: 'cmake', openocdInterface: 'stlink' }));
		assert.strictEqual(await detectMode(dest), 'stm32');
		for (const f of ['CMakeLists.txt', 'cmake/arm-none-eabi.cmake', 'Core/Src/main.c', 'startup_stm32f407xx.s', 'STM32F407VGT6_FLASH.ld', '.vscode/launch.json']) {
			assert.ok(fs.existsSync(path.join(dest, f)), f);
		}
		if (!(await have('cmake')) || !(await have('arm-none-eabi-gcc'))) {
			this.skip();
		}
		const configure = await run('cmake -S . -B build -DCMAKE_BUILD_TYPE=Debug', dest);
		assert.strictEqual(configure.code, 0, configure.out);
		const build = await run('cmake --build build --parallel', dest);
		assert.strictEqual(build.code, 0, build.out);
		assert.ok(fs.existsSync(path.join(dest, 'build', 'stm32_exe.elf')), 'elf produced');
	});

	test('STM32 library (Makefile): structure and (if the toolchain exists) make', async function () {
		const dest = path.join(root, 'stm32-lib');
		await materialize(dest, generateStm32Project({ name: 'stm32-lib', target: resolveTarget('STM32G474RET6'), kind: 'library', toolchain: 'make', openocdInterface: 'stlink' }));
		assert.ok(fs.existsSync(path.join(dest, 'Makefile')) && fs.existsSync(path.join(dest, 'Src', 'stm32_lib.c')));
		if (!(await have('make')) || !(await have('arm-none-eabi-gcc'))) {
			this.skip();
		}
		const result = await run('make', dest);
		assert.strictEqual(result.code, 0, result.out);
		assert.ok(fs.existsSync(path.join(dest, 'build', 'libstm32_lib.a')));
	});

	test('ESP32: structure, detection, and (if an ESP-IDF checkout exists) idf.py reconfigure', async function () {
		const dest = path.join(root, 'esp32-hello');
		await materialize(dest, generateEsp32Project({ name: 'esp32-hello', chip: 'esp32c3', template: 'hello_world' }));
		assert.strictEqual(await detectMode(dest), 'esp32');
		assert.ok(fs.existsSync(path.join(dest, 'main', 'main.c')) && fs.existsSync(path.join(dest, 'sdkconfig.defaults')));
		const idf = process.env['IDF_PATH'];
		if (!idf || !fs.existsSync(path.join(idf, 'export.sh'))) {
			this.skip();
		}
		const result = await run(`. "$IDF_PATH/export.sh" >/dev/null && idf.py set-target esp32c3 && idf.py reconfigure`, dest);
		assert.strictEqual(result.code, 0, result.out);
	});

	test('ROS2 packages: structure, well-formed package.xml, python compiles, and (if colcon + a distro exist) colcon build', async function () {
		const ws = path.join(root, 'ros2_ws');
		await materialize(path.join(ws, 'src', 'cpp_pkg'), generateRos2Package({ name: 'cpp_pkg', buildType: 'ament_cmake', dependencies: ['std_msgs'] }));
		await materialize(path.join(ws, 'src', 'py_pkg'), generateRos2Package({ name: 'py_pkg', buildType: 'ament_python', dependencies: [] }));
		await materialize(path.join(ws, 'src', 'lib_pkg'), generateRos2Package({ name: 'lib_pkg', buildType: 'ament_cmake_library', dependencies: [] }));
		await materialize(path.join(ws, 'src', 'ifaces'), generateRos2Package({ name: 'ifaces', buildType: 'interface', dependencies: [] }));
		assert.strictEqual(await detectMode(ws), 'ros2');

		if (await have('python3')) {
			for (const pkg of ['cpp_pkg', 'py_pkg', 'lib_pkg', 'ifaces']) {
				const xml = await run(`python3 -c "import xml.etree.ElementTree as E,sys; t=E.parse(sys.argv[1]); assert t.getroot().tag=='package'" src/${pkg}/package.xml`, ws);
				assert.strictEqual(xml.code, 0, `${pkg}/package.xml: ${xml.out}`);
			}
			const py = await run('python3 -m py_compile src/py_pkg/py_pkg/py_pkg_node.py src/py_pkg/setup.py src/cpp_pkg/launch/cpp_pkg.launch.py', ws);
			assert.strictEqual(py.code, 0, py.out);
		}

		const distro = process.env['ROS_DISTRO'] ?? (fs.existsSync('/opt/ros') ? fs.readdirSync('/opt/ros').filter(d => fs.existsSync(`/opt/ros/${d}/setup.bash`)).sort().pop() : undefined);
		if (!distro || !(await have('colcon')) || !process.env['ROBOAGENT_SMOKE_BUILD']) {
			this.skip();   // set ROBOAGENT_SMOKE_BUILD=1 to run the (slow) colcon build
		}
		const result = await run(`. /opt/ros/${distro}/setup.bash && colcon build --symlink-install`, ws, { ...process.env, ROS_DISTRO: distro });
		assert.strictEqual(result.code, 0, result.out);
		assert.ok(fs.existsSync(path.join(ws, 'install', 'cpp_pkg', 'lib', 'cpp_pkg', 'cpp_pkg_node')));
	});
});
