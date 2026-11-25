/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { describeOpenOcdFailure, generateStm32Project, stm32BuildCommands, stm32LaunchConfigurations, Stm32ProjectSpec } from '../modes/stm32/generator';
import { resolveTarget } from '../modes/stm32/mcuDatabase';
import { ARM_QUERY_DRIVERS, queryDriverArgument } from '../modes/clangd';

function spec(overrides: Partial<Stm32ProjectSpec> = {}): Stm32ProjectSpec {
	return { name: 'motor-ctrl', target: resolveTarget('STM32H743ZIT6'), kind: 'executable', toolchain: 'cmake', openocdInterface: 'stlink', ...overrides };
}

suite('STM32 generator', () => {

	test('executable CMake project has the core flags, linker script, startup and main', () => {
		const files = generateStm32Project(spec());
		const cmake = files.get('CMakeLists.txt')!;
		assert.ok(cmake.includes('set(MCU_FLAGS -mcpu=cortex-m7 -mthumb -mfpu=fpv5-d16 -mfloat-abi=hard)'), cmake);
		// No USE_HAL_DRIVER: with it the CMSIS device header pulls in the HAL, which is not in the project.
		assert.ok(cmake.includes('add_compile_definitions(STM32H743xx)'));
		assert.ok(cmake.includes('if(EXISTS ${CMAKE_CURRENT_SOURCE_DIR}/Drivers/CMSIS/Include)'));
		assert.ok(cmake.includes('Drivers/CMSIS/Device/ST/STM32H7xx/Include'));
		assert.ok(cmake.includes('Core/Src/system_stm32h7xx.c'));
		assert.ok(cmake.includes('add_executable(${PROJECT_NAME}.elf'));
		assert.ok(cmake.includes('-TSTM32H743ZIT6_FLASH.ld') || cmake.includes('STM32H743ZIT6_FLASH.ld'));
		assert.ok(files.has('cmake/arm-none-eabi.cmake'));
		assert.ok(files.has('Core/Src/main.c'));
		assert.ok(files.has('Core/Inc/main.h'));
		assert.ok(files.has('startup_stm32h743xx.s'));
		const ld = files.get('STM32H743ZIT6_FLASH.ld')!;
		assert.ok(ld.includes('FLASH (rx)  : ORIGIN = 0x08000000, LENGTH = 2048K'));
		// AXI SRAM, not the 128 KB DTCM at 0x20000000 (task board A11).
		assert.ok(ld.includes('RAM   (xrw) : ORIGIN = 0x24000000, LENGTH = 512K'));
		assert.ok(files.has('.vscode/launch.json') && files.has('.vscode/tasks.json'));
		// IntelliSense is clangd (cpptools is not shipped): no c_cpp_properties.json, clangd reads build/compile_commands.json
		// and may run only Arm GCCs from toolchain install folders.
		assert.ok(!files.has('.vscode/c_cpp_properties.json'));
		assert.deepStrictEqual(JSON.parse(files.get('.vscode/settings.json')!)['clangd.arguments'], [queryDriverArgument(ARM_QUERY_DRIVERS)]);
		assert.ok(files.get('.roboagent/project.json')!.includes('"part": "STM32H743ZIT6"'));
	});

	test('library project uses add_library STATIC and omits firmware-only files', () => {
		const files = generateStm32Project(spec({ kind: 'library', target: resolveTarget('STM32F103C8T6') }));
		const cmake = files.get('CMakeLists.txt')!;
		assert.ok(cmake.includes('add_library(${PROJECT_NAME} STATIC'));
		assert.ok(cmake.includes('-mcpu=cortex-m3 -mthumb -mfloat-abi=soft'));
		assert.ok(!cmake.includes('add_executable'));
		assert.ok(!files.has('Core/Src/main.c'));
		assert.ok(!files.has('STM32F103C8T6_FLASH.ld'));
		assert.ok(![...files.keys()].some(k => k.startsWith('startup_')));
		assert.ok(!files.has('.vscode/launch.json'));
		assert.ok(files.has('Inc/motor_ctrl.h') && files.has('Src/motor_ctrl.c'));
	});

	test('Makefile toolchain emits a Makefile with the same flags and no CMake files', () => {
		const files = generateStm32Project(spec({ toolchain: 'make', target: resolveTarget('STM32F407VGT6') }));
		assert.ok(!files.has('CMakeLists.txt') && !files.has('cmake/arm-none-eabi.cmake'));
		const mk = files.get('Makefile')!;
		assert.ok(mk.includes('MCU_FLAGS  := -mcpu=cortex-m4 -mthumb -mfpu=fpv4-sp-d16 -mfloat-abi=hard'));
		assert.ok(mk.includes('-DSTM32F407xx'));
		assert.ok(mk.includes('$(BUILD_DIR)/$(TARGET).elf'));
		// No compile_commands.json from make: clangd gets the same flags from compile_flags.txt.
		assert.strictEqual(files.get('.clangd'), 'CompileFlags:\n  Compiler: arm-none-eabi-gcc\n', 'so clangd asks the Arm GCC for newlib headers');
		assert.deepStrictEqual(files.get('compile_flags.txt')!.trim().split('\n'), ['--target=arm-none-eabi', '-mcpu=cortex-m4', '-mthumb', '-mfpu=fpv4-sp-d16', '-mfloat-abi=hard', '-DSTM32F407xx', '-ICore/Inc', '-IDrivers/CMSIS/Include', '-IDrivers/CMSIS/Device/ST/STM32F4xx/Include', '-std=gnu11']);
	});

	test('unknown part is flagged in the linker script and README', () => {
		const files = generateStm32Project(spec({ target: resolveTarget('STM32F412ZGT6') }));
		assert.ok(files.get('STM32F412ZGT6_FLASH.ld')!.includes('NOT IN THE ROBOAGENT CATALOG'));
		assert.ok(files.get('README.md')!.includes('part not in catalog'));
	});

	test('build commands: CMake configure + make, a kept generator, plain make, with a quoted toolchain path', () => {
		assert.deepStrictEqual(stm32BuildCommands('cmake'), {
			configure: `cmake -S . -B build -G 'Unix Makefiles' -DCMAKE_BUILD_TYPE=Debug`,
			build: `cmake -S . -B build -G 'Unix Makefiles' -DCMAKE_BUILD_TYPE=Debug && make -C build -j`,
			clean: 'make -C build clean',
		});
		assert.strictEqual(stm32BuildCommands('cmake', '/opt/gcc arm/bin').build, `cmake -S . -B build -G 'Unix Makefiles' -DCMAKE_BUILD_TYPE=Debug -DTOOLCHAIN_PATH='/opt/gcc arm/bin' && make -C build -j`);
		assert.strictEqual(stm32BuildCommands('cmake', undefined, { toolchainFile: 'cubeide-gcc.cmake', cachedGenerator: 'Unix Makefiles' }).build, `cmake -S . -B build -G 'Unix Makefiles' -DCMAKE_BUILD_TYPE=Debug -DCMAKE_TOOLCHAIN_FILE=cubeide-gcc.cmake && make -C build -j`);
		assert.deepStrictEqual(stm32BuildCommands('cmake', undefined, { cachedGenerator: 'Ninja' }), {
			configure: 'cmake -S . -B build -DCMAKE_BUILD_TYPE=Debug',
			build: 'cmake -S . -B build -DCMAKE_BUILD_TYPE=Debug && cmake --build build --parallel',
			clean: 'cmake --build build --target clean',
		});
		assert.strictEqual(stm32BuildCommands('make', '/opt/arm/bin').build, 'make -j TOOLCHAIN_PATH=/opt/arm/bin');
		assert.deepStrictEqual(stm32BuildCommands('make', undefined, { makeDirectory: 'Debug' }), { build: 'make -C Debug -j all', clean: 'make -C Debug clean' });
	});

	test('OpenOCD probe failures are explained', () => {
		assert.ok(describeOpenOcdFailure('Info : auto-selecting first available session transport "dapdirect_swd".\nError: open failed\n').startsWith('No debug probe found.'));
		assert.ok(describeOpenOcdFailure('Error: libusb_open() failed with LIBUSB_ERROR_ACCESS\nError: open failed').includes('USB permission denied'));
		assert.ok(describeOpenOcdFailure('Info : Target voltage: 0.0\nError: init mode failed (unable to connect to the target)').includes('could not connect to the MCU'));
		assert.strictEqual(describeOpenOcdFailure('Error: something odd\n'), 'OpenOCD could not connect to the target: Error: something odd');
	});

	test('launch configuration: Cortex-Debug with the matching OpenOCD scripts (no cpptools fallback)', () => {
		const configurations = stm32LaunchConfigurations(spec({ openocdInterface: 'jlink' }), 'motor_ctrl');
		assert.strictEqual(configurations.length, 1);
		const [cortex] = configurations;
		assert.strictEqual(cortex.type, 'cortex-debug');
		assert.strictEqual(cortex.servertype, 'openocd');
		assert.deepStrictEqual(cortex.configFiles, ['interface/jlink.cfg', 'target/stm32h7x.cfg']);
		assert.strictEqual(cortex.executable, '${workspaceFolder}/build/motor_ctrl.elf');
	});

	test('generated JSON is valid', () => {
		const files = generateStm32Project(spec());
		for (const name of ['.vscode/launch.json', '.vscode/tasks.json', '.vscode/settings.json', '.roboagent/project.json']) {
			assert.doesNotThrow(() => JSON.parse(files.get(name)!), name);
		}
	});
});
