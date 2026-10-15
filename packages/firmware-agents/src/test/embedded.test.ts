/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { CMakeBuildSystem, EspIdfBuildSystem, MakeBuildSystem, PlatformIoBuildSystem } from '../embedded/build/buildSystems';
import { parseBuildOutput } from '../embedded/build/gccDiagnostics';
import { parseMapFile } from '../embedded/build/mapFile';
import { parseBerkeleySize, summarizeSize } from '../embedded/build/sizeReport';
import { EspIdfFlasher, OpenOcdFlasher, StFlashFlasher } from '../embedded/flash/flashers';
import { lintFreeRtosConfig } from '../embedded/freertosLint';
import { DefaultPlatformFactory } from '../embedded/platformFactory';
import { detectProject, ProjectInfo } from '../embedded/project';
import { DefaultTargetCatalog } from '../embedded/target';
import { ArmGccToolchain, EspIdfToolchain, installCommand, probeToolchain } from '../embedded/toolchain';
import { FakeHost } from './fakeHost';

const catalog = new DefaultTargetCatalog();

suite('DefaultTargetCatalog', () => {

	test('resolves catalog parts, CubeMX-style prefixes, unknown parts of known families and ESP32 chips', () => {
		assert.deepStrictEqual(catalog.resolve('stm32f103c8t6'), {
			vendor: 'stm32', part: 'STM32F103C8T6', family: 'F1', arch: 'cortex-m', cpu: 'cortex-m3', toolchainPrefix: 'arm-none-eabi-',
			flashKb: 64, ramKb: 20, openocdConfig: 'target/stm32f1x.cfg', exact: true,
		});
		assert.strictEqual(catalog.resolve('STM32F103C8Tx')?.part, 'STM32F103C8T6');
		const unknown = catalog.resolve('STM32F413ZHT6');
		assert.deepStrictEqual([unknown?.family, unknown?.exact, unknown?.flashKb], ['F4', false, undefined]);
		assert.deepStrictEqual([catalog.resolve('ESP32-S3')?.arch, catalog.resolve('esp32c3')?.toolchainPrefix], ['xtensa', 'riscv32-esp-elf-']);
		assert.strictEqual(catalog.resolve('ATmega328P'), undefined);
	});
});

suite('detectProject', () => {

	test('the RoboAgent STM32 fixture: CMake, STM32F103C8T6 from the README, no RTOS', async () => {
		const host = new FakeHost();
		host.fs.files.set('stm32_test/CMakeLists.txt', 'project(stm32_test C ASM)\nadd_compile_definitions(STM32F103xB USE_HAL_DRIVER)\n');
		host.fs.files.set('stm32_test/README.md', '# stm32_test — STM32 library (STM32F103C8T6)\n');
		host.fs.files.set('stm32_test/Src/stm32_test.c', '');
		const p = await detectProject(host.fs, 'stm32_test', catalog);
		assert.deepStrictEqual({ build: p?.buildSystem, part: p?.target?.part, exact: p?.target?.exact, rtos: p?.rtos }, { build: 'cmake', part: 'STM32F103C8T6', exact: true, rtos: 'none' });
		assert.ok(p?.evidence.some(e => e.includes('README.md')));
	});

	test('a define alone gives the family; project.json and .ioc are preferred over text', async () => {
		const host = new FakeHost();
		host.fs.files.set('a/Makefile', 'CFLAGS += -DSTM32F407xx\n');
		const a = await detectProject(host.fs, 'a', catalog);
		assert.deepStrictEqual([a?.buildSystem, a?.target?.family, a?.target?.exact], ['make', 'F4', false]);

		host.fs.files.set('b/CMakeLists.txt', '# STM32F103C8T6\n');
		host.fs.files.set('b/board.ioc', 'Mcu.UserName=STM32F446RETx\n');
		host.fs.files.set('b/Core/Inc/FreeRTOSConfig.h', '');
		const b = await detectProject(host.fs, 'b', catalog);
		assert.deepStrictEqual([b?.target?.part, b?.rtos, b?.freertosConfig], ['STM32F446RET6', 'freertos', 'b/Core/Inc/FreeRTOSConfig.h']);

		host.fs.files.set('c/CMakeLists.txt', '');
		host.fs.files.set('c/.roboagent/project.json', JSON.stringify({ controlLevel: 'low', target: 'stm32', part: 'STM32G431KBT6' }));
		assert.strictEqual((await detectProject(host.fs, 'c', catalog))?.target?.part, 'STM32G431KBT6');
	});

	test('ESP-IDF and PlatformIO projects', async () => {
		const host = new FakeHost();
		host.fs.files.set('idf/CMakeLists.txt', 'include($ENV{IDF_PATH}/tools/cmake/project.cmake)\nproject(blink)\n');
		host.fs.files.set('idf/sdkconfig', 'CONFIG_IDF_TARGET=' + JSON.stringify('esp32c3') + '\n');
		const idf = await detectProject(host.fs, 'idf', catalog);
		assert.deepStrictEqual([idf?.buildSystem, idf?.target?.part, idf?.rtos], ['esp-idf', 'esp32c3', 'freertos']);

		host.fs.files.set('pio/platformio.ini', '[env:esp32-s3-devkitc-1]\nplatform = espressif32\nboard = esp32-s3-devkitc-1\n\n[env:debug]\n');
		const pio = await detectProject(host.fs, 'pio', catalog);
		assert.deepStrictEqual([pio?.buildSystem, pio?.target?.part, pio?.platformioEnvs], ['platformio', 'esp32s3', ['esp32-s3-devkitc-1', 'debug']]);
	});

	test('no build system → undefined', async () => {
		const host = new FakeHost();
		host.fs.files.set('docs/readme.md', 'STM32F103C8T6');
		assert.strictEqual(await detectProject(host.fs, 'docs', catalog), undefined);
	});
});

suite('parseBuildOutput', () => {

	test('GCC errors and warnings with columns and flags (real arm-none-eabi-gcc 10.3 output)', () => {
		const out = [
			`Src/main.c: In function 'main':`,
			`Src/main.c:1:17: warning: implicit declaration of function 'undefined_fn' [-Wimplicit-function-declaration]`,
			'    1 | int main(void){ undefined_fn(); int x = ; }',
			'      |                 ^~~~~~~~~~~~',
			`Src/main.c:1:41: error: expected expression before ';' token`,
			'Inc/app.h:3:10: fatal error: stm32f1xx_hal.h: No such file or directory',
			'compilation terminated.',
			'make[2]: *** [CMakeFiles/app.dir/build.make:76: CMakeFiles/app.dir/Src/main.c.obj] Error 1',
		].join('\n');
		assert.deepStrictEqual(parseBuildOutput(out), [
			{ severity: 'warning', source: 'compiler', message: `implicit declaration of function 'undefined_fn'`, file: 'Src/main.c', line: 1, column: 17, flag: '-Wimplicit-function-declaration' },
			{ severity: 'error', source: 'compiler', message: `expected expression before ';' token`, file: 'Src/main.c', line: 1, column: 41 },
			{ severity: 'error', source: 'compiler', message: 'stm32f1xx_hal.h: No such file or directory', file: 'Inc/app.h', line: 3, column: 10 },
			{ severity: 'error', source: 'make', message: '[CMakeFiles/app.dir/build.make:76: CMakeFiles/app.dir/Src/main.c.obj] Error 1' },
		]);
	});

	test('linker: undefined references, multiple definitions, region overflow', () => {
		const out = [
			'/usr/lib/gcc/arm-none-eabi/10.3.1/../../../arm-none-eabi/bin/ld: CMakeFiles/app.dir/Src/main.c.obj: in function `main\':',
			'/work/Src/main.c:12: undefined reference to `HAL_UART_Transmit\'',
			'/usr/bin/arm-none-eabi-ld: build/util.o: multiple definition of `crc16\'; build/main.o:/work/Src/main.c:40: first defined here',
			'/usr/bin/../lib/gcc/arm-none-eabi/10.3.1/../../../../arm-none-eabi/bin/ld: app.elf section `.text\' will not fit in region `FLASH\'',
			'/usr/bin/../lib/gcc/arm-none-eabi/10.3.1/../../../../arm-none-eabi/bin/ld: region `FLASH\' overflowed by 1844 bytes',
			'collect2: error: ld returned 1 exit status',
		].join('\n');
		const d = parseBuildOutput(out);
		assert.deepStrictEqual(d.map(x => [x.source, x.message, x.file, x.line, x.region, x.overflowBytes]), [
			['linker', 'undefined reference to `HAL_UART_Transmit\'', '/work/Src/main.c', 12, undefined, undefined],
			['linker', 'multiple definition of `crc16\'', undefined, undefined, undefined, undefined],
			['linker', 'app.elf section `.text\' will not fit in region `FLASH\'', undefined, undefined, 'FLASH', undefined],
			['linker', 'region `FLASH\' overflowed by 1844 bytes', undefined, undefined, 'FLASH', 1844],
		]);
	});

	test('CMake errors take their indented detail; missing tools are recognised; ANSI colours are ignored', () => {
		const out = [
			'CMake Error at CMakeLists.txt:12 (add_executable):',
			'  Cannot find source file:',
			'',
			'    Src/missing.c',
			'',
			'-- Configuring incomplete, errors occurred!',
			'/bin/sh: 1: arm-none-eabi-gcc: not found',
			'\x1b[01m\x1b[KSrc/x.c:2:3:\x1b[m\x1b[K \x1b[01;31m\x1b[Kerror: \x1b[m\x1b[Kboom',
		].join('\n');
		assert.deepStrictEqual(parseBuildOutput(out).map(x => [x.source, x.message, x.file, x.line]), [
			['cmake', 'add_executable: Cannot find source file: Src/missing.c', 'CMakeLists.txt', 12],
			['tool', 'arm-none-eabi-gcc: command not found', undefined, undefined],
			['compiler', 'boom', 'Src/x.c', 2],
		]);
	});

	test('deduplicates repeated diagnostics and caps the list', () => {
		const line = 'a.c:1:1: warning: w [-Wx]';
		assert.strictEqual(parseBuildOutput(`${line}\n${line}`).length, 1);
		assert.strictEqual(parseBuildOutput(Array.from({ length: 50 }, (_, i) => `a.c:${i + 1}:1: error: e`).join('\n'), 10).length, 10);
	});
});

suite('size and map reports', () => {

	test('Berkeley size output, ELF and static library', () => {
		const elf = '   text\t   data\t    bss\t    dec\t    hex\tfilename\n     96\t     12\t   1024\t   1132\t    46c\tbuild/app.elf\n';
		assert.deepStrictEqual(summarizeSize(parseBerkeleySize(elf), 64, 20), {
			entries: [{ text: 96, data: 12, bss: 1024, file: 'build/app.elf' }],
			flashBytes: 108, ramBytes: 1036, flashTotalBytes: 65536, flashPercent: 0.2, ramTotalBytes: 20480, ramPercent: 5.1,
		});
		const lib = '   text\t   data\t    bss\t    dec\t    hex\tfilename\n     40\t      0\t      0\t     40\t     28\tstm32_test.c.obj (ex build/libstm32_test.a)\n     10\t      4\t      8\t     22\t     16\tother.c.obj (ex build/libstm32_test.a)\n';
		const r = summarizeSize(parseBerkeleySize(lib));
		assert.deepStrictEqual([r.entries.length, r.flashBytes, r.ramBytes, r.flashPercent], [2, 54, 12, undefined]);
	});

	// Trimmed from a real GNU ld 2.36 map of a Cortex-M3 image (see the integration test for a live one).
	const MAP = [
		'Memory Configuration',
		'',
		'Name             Origin             Length             Attributes',
		'FLASH            0x0000000008000000 0x0000000000010000 xr',
		'RAM              0x0000000020000000 0x0000000000005000 xrw',
		'*default*        0x0000000000000000 0xffffffffffffffff',
		'',
		'Linker script and memory map',
		'',
		'LOAD build/main.o',
		'.isr_vector     0x0000000008000000        0x8',
		' *(.isr_vector)',
		' .isr_vector    0x0000000008000000        0x8 build/startup.o',
		'                0x0000000008000000                vectors',
		'',
		'.text           0x0000000008000008       0x60',
		' *(.text*)',
		' .text.main     0x0000000008000008       0x20 build/main.o',
		'                0x0000000008000008                main',
		' .text.HAL_GPIO_WritePin_with_a_really_long_name',
		'                0x0000000008000028       0x40 libhal.a(stm32f1xx_hal_gpio.o)',
		'',
		'.data           0x0000000020000000        0x4 load address 0x0000000008000068',
		' .data.counter  0x0000000020000000        0x4 build/main.o',
		'',
		'.bss            0x0000000020000004      0x400 load address 0x000000000800006c',
		' .bss.buffer    0x0000000020000004      0x400 build/main.o',
		' COMMON         0x0000000020000404        0x0 build/main.o',
		'',
		'.debug_info     0x0000000000000000      0x9c3',
		' .debug_info    0x0000000000000000      0x9c3 build/main.o',
	].join('\n');

	test('regions count run and load images; contributors are attributed, wrapped lines included', () => {
		const r = parseMapFile(MAP);
		assert.deepStrictEqual(r.regions.map(x => [x.name, x.used, x.length]), [['FLASH', 108, 65536], ['RAM', 1028, 20480]]);
		assert.deepStrictEqual(r.sections.map(s => [s.name, s.size, s.region, s.loadRegion]), [
			['.isr_vector', 8, 'FLASH', undefined], ['.text', 96, 'FLASH', undefined], ['.data', 4, 'RAM', 'FLASH'], ['.bss', 1024, 'RAM', undefined],
		]);
		assert.deepStrictEqual(r.contributors, [
			{ object: 'build/main.o', bytes: 1060, sections: { '.text': 32, '.data': 4, '.bss': 1024 } },
			{ object: 'libhal.a(stm32f1xx_hal_gpio.o)', bytes: 64, sections: { '.text': 64 } },
			{ object: 'build/startup.o', bytes: 8, sections: { '.isr_vector': 8 } },
		]);
	});
});

suite('lintFreeRtosConfig', () => {

	test('flags the settings that make crashes undiagnosable', () => {
		const header = '#define configUSE_PREEMPTION 1\n#define configCHECK_FOR_STACK_OVERFLOW 0 /* off */\n// #define configASSERT( x )\n';
		assert.deepStrictEqual(lintFreeRtosConfig(header, { arch: 'cortex-m', buildFiles: 'add_link_options(-Wl,--gc-sections)' }).map(f => [f.severity, f.setting]), [
			['warning', 'configASSERT'],
			['warning', 'configCHECK_FOR_STACK_OVERFLOW'],
			['warning', 'configUSE_MALLOC_FAILED_HOOK'],
			['info', 'configQUEUE_REGISTRY_SIZE'],
			['info', 'configUSE_TRACE_FACILITY'],
			['error', 'configMAX_SYSCALL_INTERRUPT_PRIORITY'],
			['info', 'uxTopUsedPriority'],
		]);
	});

	test('a well-configured header is clean', () => {
		const header = [
			'#define configASSERT( x ) if( ( x ) == 0 ) { taskDISABLE_INTERRUPTS(); for( ;; ); }',
			'#define configCHECK_FOR_STACK_OVERFLOW 2',
			'#define configUSE_MALLOC_FAILED_HOOK 1U',
			'#define configQUEUE_REGISTRY_SIZE ( 8 )',
			'#define configUSE_TRACE_FACILITY 1',
			'#define configMAX_SYSCALL_INTERRUPT_PRIORITY ( 5 << 4 )',
		].join('\n');
		assert.deepStrictEqual(lintFreeRtosConfig(header, { arch: 'cortex-m', buildFiles: '-Wl,--undefined=uxTopUsedPriority' }), []);
	});
});

const stm32Project: ProjectInfo = { dir: 'fw', buildSystem: 'cmake', target: catalog.resolve('STM32F103C8T6')!, rtos: 'none', evidence: [] };

suite('toolchain probing', () => {

	test('reports versions, treats flasher alternatives as a group, and plans an apt install', async () => {
		const host = new FakeHost();
		const present = new Set(['arm-none-eabi-gcc', 'arm-none-eabi-size', 'arm-none-eabi-objcopy', 'make', 'st-flash', 'apt-get', 'gdb-multiarch']);
		host.onExec = command => present.has(command) ? { stdout: `${command} 1.0\nmore` } : { exitCode: null, spawnError: `spawn ${command} ENOENT` };
		const report = await probeToolchain(host, new ArmGccToolchain(), 'cmake', ['build', 'flash', 'debug']);
		assert.deepStrictEqual(report.missing, ['cmake', 'openocd']);
		assert.deepStrictEqual(report.tools.find(t => t.name === 'gdb'), { name: 'gdb', purpose: 'debug', found: true, command: 'gdb-multiarch', version: 'gdb-multiarch 1.0' });
		assert.deepStrictEqual(report.install, { packageManager: 'apt', commandLine: 'sudo apt-get install -y cmake openocd', manual: [] });
	});

	test('ESP-IDF tools come with manual instructions; install commands never use a shell', async () => {
		const host = new FakeHost();
		host.onExec = command => ({ exitCode: null, spawnError: `spawn ${command} ENOENT` });
		const report = await probeToolchain(host, new EspIdfToolchain('xtensa-esp32s3-elf-'), 'esp-idf', ['build']);
		assert.deepStrictEqual(report.missing, ['idf.py', 'gcc', 'cmake', 'ninja']);
		assert.ok(report.install?.manual.some(m => m.includes('export.sh')));
		assert.deepStrictEqual(installCommand('pacman', ['openocd']), { command: 'sudo', args: ['-n', 'pacman', '-S', '--needed', '--noconfirm', 'openocd'] });
	});
});

suite('build systems', () => {

	test('CMake re-runs its configure before every build; an existing tree keeps its build type unless one is asked for', async () => {
		const host = new FakeHost();
		const cmake = new CMakeBuildSystem();
		const steps = await cmake.build(host, stm32Project);
		assert.deepStrictEqual(steps.map(s => [s.step, s.ok]), [['configure', true], ['build', true]]);
		assert.deepStrictEqual(host.commands, [
			{ command: 'cmake', args: ['-S', '.', '-B', 'build', '-DCMAKE_BUILD_TYPE=Debug'], cwd: 'fw' },
			{ command: 'cmake', args: ['--build', 'build', '--parallel'], cwd: 'fw' },
		]);
		host.fs.files.set('fw/build/CMakeCache.txt', '');
		host.fs.files.set('fw/build/Makefile', '');
		host.commands.length = 0;
		await cmake.build(host, stm32Project);
		await cmake.build(host, stm32Project, { buildType: 'Release' });
		assert.deepStrictEqual(host.commands.map(c => c.args.join(' ')), [
			'-S . -B build', '--build build --parallel',
			'-S . -B build -DCMAKE_BUILD_TYPE=Release', '--build build --parallel',
		]);
	});

	test('a failed step carries diagnostics, and the output tail only when nothing was recognised', async () => {
		const host = new FakeHost();
		host.fs.files.set('fw/build/CMakeCache.txt', '');
		host.onExec = () => ({ exitCode: 2, stderr: 'Src/main.c:3:5: error: unknown type name \'uint8\'\n' });
		const [step] = await new CMakeBuildSystem().build(host, stm32Project);
		assert.deepStrictEqual([step.ok, step.counts.error, step.diagnostics[0].line], [false, 1, 3]);
		assert.ok(step.outputTail.includes('uint8'));
	});

	test('Make, PlatformIO and ESP-IDF commands', async () => {
		const host = new FakeHost();
		const p = (buildSystem: ProjectInfo['buildSystem']): ProjectInfo => ({ ...stm32Project, buildSystem });
		await new MakeBuildSystem().build(host, p('make'));
		await new PlatformIoBuildSystem().build(host, p('platformio'), { environment: 'nucleo' });
		await new EspIdfBuildSystem().clean(host, p('esp-idf'));
		assert.deepStrictEqual(host.commands.map(c => [c.command, ...c.args].join(' ')), ['make -j4', 'pio run -e nucleo', 'idf.py clean']);
	});

	test('finds artifacts in the build directory', async () => {
		const host = new FakeHost();
		for (const f of ['app.elf', 'app.map', 'app.bin', 'CMakeFiles/x.o', 'lib/libdrv.a']) {
			host.fs.files.set(`fw/build/${f}`, '');
		}
		assert.deepStrictEqual(await new CMakeBuildSystem().findArtifacts(host, stm32Project), {
			elf: ['fw/build/app.elf'], map: ['fw/build/app.map'], bin: ['fw/build/app.bin'], hex: [], lib: ['fw/build/lib/libdrv.a'],
		});
	});
});

suite('flashers', () => {

	const artifacts = { elf: ['fw/build/app.elf'], map: [], bin: [], hex: [], lib: [] };

	test('OpenOCD programs the ELF (path relative to the project) and reports verification', async () => {
		const host = new FakeHost();
		host.onExec = () => ({ stderr: 'Info : stm32f1x.cpu: hardware has 6 breakpoints\n** Programming Finished **\n** Verified OK **\n' });
		const flasher = new OpenOcdFlasher('target/stm32f1x.cfg');
		const picked = flasher.pickImage(artifacts, {});
		assert.deepStrictEqual(picked, { ok: true, image: 'fw/build/app.elf' });
		const result = await flasher.flash(host, stm32Project, 'fw/build/app.elf', {});
		assert.deepStrictEqual(host.commands[0].args, ['-f', 'interface/stlink.cfg', '-f', 'target/stm32f1x.cfg', '-c', 'program {build/app.elf} verify reset exit']);
		assert.deepStrictEqual([result.ok, result.verified], [true, true]);
	});

	test('explains common probe failures and refuses unsafe image paths', async () => {
		const host = new FakeHost();
		host.onExec = () => ({ exitCode: 1, stderr: 'Error: open failed\nin procedure \'program\'\n' });
		const result = await new OpenOcdFlasher('target/stm32f1x.cfg').flash(host, stm32Project, 'fw/build/app.elf', { probe: 'stlink' });
		assert.deepStrictEqual([result.ok, /No debug probe/.test(result.problem ?? '')], [false, true]);
		assert.strictEqual(new OpenOcdFlasher('t.cfg').pickImage({ ...artifacts, elf: ['fw/build/a} ; shutdown {.elf'] }, {}).ok, false);
		assert.strictEqual(new OpenOcdFlasher('t.cfg').pickImage({ ...artifacts, elf: [] }, {}).ok, false);
	});

	test('st-flash converts an ELF to a binary first; idf.py passes the port', async () => {
		const host = new FakeHost();
		await new StFlashFlasher().flash(host, stm32Project, 'fw/build/app.elf', {});
		await new EspIdfFlasher().flash(host, { ...stm32Project, buildSystem: 'esp-idf' }, 'build', { port: '/dev/ttyACM0' });
		assert.deepStrictEqual(host.commands.map(c => [c.command, ...c.args].join(' ')), [
			'arm-none-eabi-objcopy -O binary build/app.elf build/app.bin',
			'st-flash --reset write build/app.bin 0x08000000',
			'idf.py -p /dev/ttyACM0 flash',
		]);
	});
});

suite('DefaultPlatformFactory', () => {

	test('matches toolchain, build system and flashers to the project', () => {
		const f = new DefaultPlatformFactory();
		const stm32 = f.create(stm32Project);
		assert.deepStrictEqual([stm32.toolchain.id, stm32.buildSystem.id, stm32.flashers.map(x => x.id), stm32.binutilsPrefix], ['arm-none-eabi-gcc', 'cmake', ['openocd', 'st-flash'], 'arm-none-eabi-']);
		const esp = f.create({ ...stm32Project, buildSystem: 'esp-idf', target: catalog.resolve('esp32s3')! });
		assert.deepStrictEqual([esp.toolchain.id, esp.flashers.map(x => x.id), esp.binutilsPrefix], ['esp-idf', ['idf.py'], 'xtensa-esp32s3-elf-']);
		const noTarget = f.create({ dir: '.', buildSystem: 'make', rtos: 'none', evidence: [] });
		assert.deepStrictEqual(noTarget.flashers, []);
	});
});
