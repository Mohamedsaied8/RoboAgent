/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  CMake messages → Problems: the parser, colcon's command.log, and a colcon log folder.
 *  Regression for the 2026-11-25 manual test: a colcon build failing in CMake left Problems empty.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { cmakeCacheSourceDir, colconBuildDir, colconSourceDir, parseCMakeOutput, readColconCMakeProblems } from '../cmakeDiagnostics';

const PKG = '/ws/src/demo_pkg';

// Verbatim from colcon's log/latest_build/demo_pkg/stderr.log, colour codes included.
const MISSING_PACKAGE = '\x1b[31mCMake Error at CMakeLists.txt:7 (find_package):\n'
	+ '  By not providing "Findexample_interfaces.cmake" in CMAKE_MODULE_PATH this\n'
	+ '  project has asked CMake to find a package configuration file provided by\n'
	+ '  "example_interfaces", but CMake did not find one.\n'
	+ '\n'
	+ '  Could not find a package configuration file provided by\n'
	+ '  "example_interfaces" with any of the following names:\n'
	+ '\n'
	+ '    example_interfacesConfig.cmake\n'
	+ '    example_interfaces-config.cmake\n'
	+ '\n'
	+ '\x1b[0m\n';

suite('CMake diagnostics', () => {

	test('a find_package error from colcon\'s stderr.log, relative to the package', () => {
		assert.deepStrictEqual(parseCMakeOutput(MISSING_PACKAGE, PKG), [{
			file: '/ws/src/demo_pkg/CMakeLists.txt',
			line: 7,
			severity: 'error',
			command: 'find_package',
			message: 'By not providing "Findexample_interfaces.cmake" in CMAKE_MODULE_PATH this project has asked CMake to find a package configuration file provided by "example_interfaces", but CMake did not find one.\n'
				+ 'Could not find a package configuration file provided by "example_interfaces" with any of the following names:\n'
				+ 'example_interfacesConfig.cmake example_interfaces-config.cmake',
		}]);
	});

	test('warnings, (dev) warnings, generate-time and location-less errors', () => {
		const text = [
			'-- The C compiler identification is GNU 11.4.0',
			'CMake Warning at sub/CMakeLists.txt:1 (message):',
			'  careful',
			'',
			'CMake Warning (dev) at CMakeLists.txt:3 (project):',
			'  Policy CMP0048 is not set.',
			'This warning is for project developers.  Use -Wno-dev to suppress it.',
			'',
			'CMake Error in CMakeLists.txt:',
			'  Target "app" links to target "missing::lib" but the target was not found.',
			'',
			'CMake Error: The source directory "/nowhere" does not exist.',
			'CMake Warning:',
			'  Manually-specified variables were not used by the project:',
			'',
			'    AMENT_CMAKE_SYMLINK_INSTALL',
			'',
			'CMake Error in C:/work/pkg/CMakeLists.txt:',
			'  generate-time error on Windows',
			'-- Configuring incomplete, errors occurred!',
		].join('\n');
		assert.deepStrictEqual(parseCMakeOutput(text, PKG), [
			{ file: '/ws/src/demo_pkg/sub/CMakeLists.txt', line: 1, severity: 'warning', command: 'message', message: 'careful' },
			{ file: '/ws/src/demo_pkg/CMakeLists.txt', line: 3, severity: 'warning', command: 'project', message: 'Policy CMP0048 is not set.' },
			{ file: '/ws/src/demo_pkg/CMakeLists.txt', line: 1, severity: 'error', command: undefined, message: 'Target "app" links to target "missing::lib" but the target was not found.' },
			{ file: '/ws/src/demo_pkg/CMakeLists.txt', line: 1, severity: 'error', command: undefined, message: 'The source directory "/nowhere" does not exist.' },
			// The location-less "Manually-specified variables" warning is dropped (colcon's own -D flags).
			{ file: 'C:/work/pkg/CMakeLists.txt', line: 1, severity: 'error', command: undefined, message: 'generate-time error on Windows' },
		]);
	});

	test('an error raised inside an installed .cmake module is placed at the package\'s own call-stack frame', () => {
		const text = [
			'CMake Error at /opt/ros/humble/share/ament_cmake_core/cmake/core/ament_package_xml.cmake:95 (message):',
			'  ament_cmake_core: package.xml does not exist',
			'Call Stack (most recent call first):',
			'  /opt/ros/humble/share/ament_cmake_core/cmake/core/ament_package.cmake:66 (_ament_package_xml)',
			'  CMakeLists.txt:40 (ament_package)',
			'',
			'CMake Error at /opt/ros/humble/share/x/x.cmake:1 (message):',
			'  no frame in the package',
		].join('\n');
		assert.deepStrictEqual(parseCMakeOutput(text, PKG), [
			{ file: '/ws/src/demo_pkg/CMakeLists.txt', line: 40, severity: 'error', command: 'message', message: 'ament_cmake_core: package.xml does not exist\n(reported in /opt/ros/humble/share/ament_cmake_core/cmake/core/ament_package_xml.cmake:95)' },
			{ file: '/opt/ros/humble/share/x/x.cmake', line: 1, severity: 'error', command: 'message', message: 'no frame in the package' },
		]);
	});

	test('nothing to report in a clean configure or compiler-only output', () => {
		assert.deepStrictEqual(parseCMakeOutput('-- Configuring done\n/ws/src/a.cpp:3:1: error: x\n', PKG), []);
	});

	test('colcon command.log: the cmake source folder; none for ament_python packages', () => {
		const cmake = 'Invoking command in \'/ws/build/demo_pkg\': CMAKE_PREFIX_PATH=/opt/ros/humble /usr/bin/cmake /ws/src/demo_pkg -DAMENT_CMAKE_SYMLINK_INSTALL=1 -DCMAKE_INSTALL_PREFIX=/ws/install/demo_pkg\n'
			+ 'Invoked command in \'/ws/build/demo_pkg\' returned \'1\': CMAKE_PREFIX_PATH=/opt/ros/humble /usr/bin/cmake /ws/src/demo_pkg\n';
		const python = 'Invoking command in \'/ws/src/py_bridge\': PYTHONPATH=/ws/build/py_bridge/prefix_override /usr/bin/python3 setup.py egg_info\n';
		assert.deepStrictEqual([colconSourceDir(cmake), colconSourceDir(python)], ['/ws/src/demo_pkg', undefined]);
		assert.deepStrictEqual([colconBuildDir(cmake), colconBuildDir(python)], ['/ws/build/demo_pkg', '/ws/src/py_bridge']);
		assert.strictEqual(cmakeCacheSourceDir('# This is the CMakeCache file.\nCMAKE_HOME_DIRECTORY:INTERNAL=/my ws/src/repo/pkg\nFOO:BOOL=ON\n'), '/my ws/src/repo/pkg');
	});

	test('a colcon workspace: every package\'s CMake problems, resolved against its own source folder', async () => {
		const ws = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'roboagent-cmake-diag-'));
		try {
			const write = async (rel: string, text: string) => {
				await fs.promises.mkdir(path.dirname(path.join(ws, rel)), { recursive: true });
				await fs.promises.writeFile(path.join(ws, rel), text);
			};
			const srcA = path.join(ws, 'src', 'nested', 'pkg_a');
			await write('log/latest_build/pkg_a/command.log', `Invoking command in '${ws}/build/pkg_a': /usr/bin/cmake ${srcA} -DX=1\n`);
			await write('log/latest_build/pkg_a/stderr.log', MISSING_PACKAGE);
			// No command.log (colcon stopped early): falls back to src/<pkg> when it has a CMakeLists.txt.
			await write('src/pkg_b/CMakeLists.txt', '');
			await write('log/latest_build/pkg_b/stderr.log', 'CMake Warning at CMakeLists.txt:2 (message):\n  hi\n');
			// ament_python package with unrelated stderr: skipped.
			await write('log/latest_build/py_bridge/command.log', 'Invoking command in x: /usr/bin/python3 setup.py egg_info\n');
			await write('log/latest_build/py_bridge/stderr.log', 'warning: no files found matching \'*.msg\'\n');
			const problems = await readColconCMakeProblems(ws);
			assert.deepStrictEqual(problems.map(p => [p.file, p.line, p.severity]), [
				[path.join(srcA, 'CMakeLists.txt'), 7, 'error'],
				[path.join(ws, 'src', 'pkg_b', 'CMakeLists.txt'), 2, 'warning'],
			]);
			assert.deepStrictEqual(await readColconCMakeProblems(path.join(ws, 'no-such-dir')), []);

			// Review finding: a rebuild has no configure line (CMake re-runs inside `cmake --build`), and
			// the package sits in src/<repo>/<pkg> under a folder with a space: the build folder's
			// CMakeCache.txt still names the source folder.
			const srcC = path.join(ws, 'src', 'my repo', 'pkg_c');
			await write('build/pkg_c/CMakeCache.txt', `CMAKE_HOME_DIRECTORY:INTERNAL=${srcC}\n`);
			await write('log/latest_build/pkg_c/command.log', `Invoking command in '${ws}/build/pkg_c': /usr/bin/cmake --build ${ws}/build/pkg_c -- -j8\n`);
			await write('log/latest_build/pkg_c/stderr.log', 'CMake Error at CMakeLists.txt:12 (add_executable):\n  Cannot find source file: main.cpp\n');
			assert.deepStrictEqual((await readColconCMakeProblems(ws)).map(p => [p.file, p.line]).filter(([f]) => String(f).includes('pkg_c')),
				[[path.join(srcC, 'CMakeLists.txt'), 12]]);

			// Logs are read only as regular files: a FIFO or a symlink to a device is skipped.
			await fs.promises.rm(path.join(ws, 'log', 'latest_build', 'pkg_b', 'stderr.log'));
			await fs.promises.symlink('/dev/zero', path.join(ws, 'log', 'latest_build', 'pkg_b', 'stderr.log'));
			assert.ok(!(await readColconCMakeProblems(ws)).some(p => p.file.includes('pkg_b')));
		} finally {
			await fs.promises.rm(ws, { recursive: true, force: true });
		}
	});
});
