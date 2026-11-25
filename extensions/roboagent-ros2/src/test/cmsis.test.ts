/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  CMSIS headers for STM32 projects (offline: packs are built here or pre-seeded in the store).
 *  Regression for the 2026-11-25 manual test: a Create'd project could not `#include
 *  "stm32f1xx.h"` (no CMSIS headers), so register-level code did not build.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as cp from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CMSIS_CORE, CMSIS_DEVICE, cmsisArchiveUrl, CmsisIo, CmsisPack, cmsisProjectFiles, ensureCmsisPack, installCmsisIntoProject, nodeCmsisIo } from '../modes/stm32/cmsis';
import { generateStm32Project, upgradeGeneratedBuildFile } from '../modes/stm32/generator';
import { resolveTarget } from '../modes/stm32/mcuDatabase';

async function write(root: string, rel: string, text: string): Promise<void> {
	await fs.promises.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
	await fs.promises.writeFile(path.join(root, rel), text);
}

/** A .tar.gz of `files` under one top folder, like a GitHub tag archive. */
async function tarball(dir: string, top: string, files: Record<string, string>): Promise<Buffer> {
	const src = path.join(dir, 'src');
	for (const [rel, text] of Object.entries(files)) {
		await write(path.join(src, top), rel, text);
	}
	const out = path.join(dir, 'pack.tar.gz');
	cp.execFileSync('tar', ['-czf', out, '-C', src, top]);
	return fs.promises.readFile(out);
}

/** Seed the store with an already-verified unpacked pack (what a previous download leaves). */
async function seed(store: string, pack: CmsisPack, top: string, files: Record<string, string>): Promise<void> {
	const dir = path.join(store, `${pack.repo}-${pack.tag}`);
	for (const [rel, text] of Object.entries(files)) {
		await write(path.join(dir, top), rel, text);
	}
	await fs.promises.writeFile(path.join(dir, '.roboagent-sha256'), pack.sha256);
}

const noNetwork: CmsisIo = {
	download: async url => { throw new Error(`unexpected download of ${url}`); },
	extractTarGz: async () => { throw new Error('unexpected extract'); },
};

suite('STM32 CMSIS headers', () => {
	let tmp: string;
	setup(async () => { tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'roboagent-cmsis-')); });
	teardown(() => fs.promises.rm(tmp, { recursive: true, force: true }));

	test('every catalog family has a pinned pack; archive URLs are the GitHub tag tarballs', () => {
		assert.deepStrictEqual(Object.keys(CMSIS_DEVICE).sort(), ['F0', 'F1', 'F3', 'F4', 'F7', 'G0', 'G4', 'H7', 'L0', 'L4', 'L5', 'U5', 'WB']);
		assert.ok([CMSIS_CORE, ...Object.values(CMSIS_DEVICE)].every(p => /^[0-9a-f]{64}$/.test(p.sha256) && /^v\d+\.\d+\.\d+$/.test(p.tag)));
		assert.strictEqual(cmsisArchiveUrl(CMSIS_DEVICE.F1), 'https://codeload.github.com/STMicroelectronics/cmsis-device-f1/tar.gz/refs/tags/v4.3.5');
	});

	test('a download is installed only when it matches the pinned SHA-256, and is then reused', async () => {
		const archive = await tarball(tmp, 'cmsis-device-zz-1.0.0', { 'Include/stm32zzxx.h': '/* zz */' });
		const good: CmsisPack = { repo: 'cmsis-device-zz', tag: 'v1.0.0', sha256: crypto.createHash('sha256').update(archive).digest('hex') };
		const store = path.join(tmp, 'store');
		let downloads = 0;
		const io: CmsisIo = { download: async () => { downloads++; return archive; }, extractTarGz: nodeCmsisIo().extractTarGz };

		await assert.rejects(ensureCmsisPack({ ...good, sha256: '0'.repeat(64) }, store, io), /SHA-256 mismatch/);
		assert.deepStrictEqual(await fs.promises.readdir(store).catch(() => []), [], 'nothing kept from a bad download');

		const root = await ensureCmsisPack(good, store, io);
		assert.strictEqual(await fs.promises.readFile(path.join(root, 'Include', 'stm32zzxx.h'), 'utf8'), '/* zz */');
		assert.strictEqual(await ensureCmsisPack(good, store, io), root);
		assert.strictEqual(downloads, 2, 'the verified copy is reused');
	});

	test('a new project gets the headers, the real startup over the placeholder, system_*.c and a README', async () => {
		const store = path.join(tmp, 'store');
		await seed(store, CMSIS_CORE, 'cmsis-core-5.9.0', { 'Core/Include/core_cm3.h': '/* cm3 */', 'Core/Include/cmsis_gcc.h': '/* gcc */' });
		await seed(store, CMSIS_DEVICE.F1, 'cmsis-device-f1-4.3.5', {
			'Include/stm32f1xx.h': '/* f1 */', 'Include/stm32f103xb.h': '/* f103xb */', 'Include/system_stm32f1xx.h': '/* sys */', 'License.md': 'Apache',
			'Source/Templates/system_stm32f1xx.c': '/* SystemInit */', 'Source/Templates/gcc/startup_stm32f103xb.s': '/* real startup */',
		});
		const target = resolveTarget('STM32F103C8T6');
		const project = path.join(tmp, 'blinky');
		for (const [rel, text] of generateStm32Project({ name: 'blinky', target, kind: 'executable', toolchain: 'cmake', openocdInterface: 'stlink' })) {
			await write(project, rel, text);
		}
		const result = await installCmsisIntoProject(project, target, noNetwork, store);
		assert.deepStrictEqual(result, { kind: 'installed', files: 8, updatedBuildFile: undefined, buildFileNotUpdated: undefined });
		const read = (rel: string) => fs.promises.readFile(path.join(project, rel), 'utf8');
		assert.deepStrictEqual(await Promise.all(['Drivers/CMSIS/Include/core_cm3.h', 'Drivers/CMSIS/Device/ST/STM32F1xx/Include/stm32f103xb.h', 'Core/Src/system_stm32f1xx.c', 'startup_stm32f103xb.s'].map(read)),
			['/* cm3 */', '/* f103xb */', '/* SystemInit */', '/* real startup */']);
		assert.ok((await read('Drivers/CMSIS/README.md')).includes('cmsis-device-f1'));
		assert.ok((await read('Core/Inc/main.h')).includes('#if __has_include("stm32f1xx.h")'));

		// The user's own startup / system files are never overwritten on a second run.
		await write(project, 'startup_stm32f103xb.s', '/* mine */');
		await write(project, 'Core/Src/system_stm32f1xx.c', '/* my SystemInit */');
		await installCmsisIntoProject(project, target, noNetwork, store);
		assert.deepStrictEqual([await read('startup_stm32f103xb.s'), await read('Core/Src/system_stm32f1xx.c')], ['/* mine */', '/* my SystemInit */']);
	});

	// Found on the user's test_gpio: its own CMakeLists (STM32CubeIDE template) looks for the core
	// headers in Drivers/CMSIS/Core/Include and does not compile system_*.c.
	test('a project with its own build file gets the headers where it looks for them, and keeps its startup', async () => {
		const store = path.join(tmp, 'store');
		await seed(store, CMSIS_CORE, 'cmsis-core-5.9.0', { 'Core/Include/core_cm3.h': '/* cm3 */' });
		await seed(store, CMSIS_DEVICE.F1, 'cmsis-device-f1-4.3.5', {
			'Include/stm32f1xx.h': '/* f1 */', 'Include/stm32f103xb.h': '/* f103xb */', 'Source/Templates/system_stm32f1xx.c': '/* SystemInit */', 'Source/Templates/gcc/startup_stm32f103xb.s': '/* real startup */',
		});
		const project = path.join(tmp, 'theirs');
		await write(project, 'CMakeLists.txt', 'set(PROJECT_INCLUDES ${CMAKE_CURRENT_SOURCE_DIR}/Drivers/CMSIS/Core/Include)\n');
		await write(project, 'startup_stm32f103xb.s', '/* Generated by RoboAgent placeholder */');
		const result = await installCmsisIntoProject(project, resolveTarget('STM32F103C8T6'), noNetwork, store);
		assert.deepStrictEqual(result, { kind: 'installed', files: 3, updatedBuildFile: undefined, buildFileNotUpdated: undefined });
		assert.strictEqual(await fs.promises.readFile(path.join(project, 'Drivers/CMSIS/Core/Include/core_cm3.h'), 'utf8'), '/* cm3 */');
		assert.strictEqual(await fs.promises.readFile(path.join(project, 'startup_stm32f103xb.s'), 'utf8'), '/* Generated by RoboAgent placeholder */');
		assert.ok(!fs.existsSync(path.join(project, 'Core/Src/system_stm32f1xx.c')));
	});

	test('an STM32CubeMX project with its own Drivers/CMSIS is left alone; unknown families are reported', async () => {
		const project = path.join(tmp, 'cube');
		await write(project, 'Drivers/CMSIS/Include/core_cm4.h', '/* ST */');
		assert.deepStrictEqual(await installCmsisIntoProject(project, resolveTarget('STM32F407VGT6'), noNetwork, path.join(tmp, 'store')), { kind: 'already-present' });
		assert.deepStrictEqual(await installCmsisIntoProject(project, resolveTarget('STM32N657X0'), noNetwork, path.join(tmp, 'store')), { kind: 'unknown-family', family: resolveTarget('STM32N657X0').family.id });
	});

	test('a project generated before CMSIS support gets its build file upgraded once', () => {
		const target = resolveTarget('STM32F103C8T6');
		const fresh = generateStm32Project({ name: 'p', target, kind: 'executable', toolchain: 'cmake', openocdInterface: 'stlink' }).get('CMakeLists.txt')!;
		const begin = fresh.indexOf('\n# CMSIS core + device headers');
		const end = fresh.indexOf('endif()\nendif()\n') + 'endif()\nendif()\n'.length;
		const old = (fresh.slice(0, begin) + fresh.slice(end)).replace('add_compile_definitions(STM32F103xB)', 'add_compile_definitions(STM32F103xB USE_HAL_DRIVER)');
		const upgraded = upgradeGeneratedBuildFile('cmake', old, target)!;
		assert.ok(upgraded.includes('add_compile_definitions(STM32F103xB)\n'));
		assert.ok(upgraded.includes('target_sources(${PROJECT_NAME}.elf PRIVATE Core/Src/system_stm32f1xx.c)'));
		assert.strictEqual(upgradeGeneratedBuildFile('cmake', upgraded, target), undefined, 'idempotent');
		assert.strictEqual(upgradeGeneratedBuildFile('cmake', 'project(theirs)\n', target), undefined, 'not RoboAgent\'s file');

		const make = generateStm32Project({ name: 'p', target, kind: 'executable', toolchain: 'make', openocdInterface: 'stlink' }).get('Makefile')!;
		assert.ok(make.includes('-IDrivers/CMSIS/Device/ST/STM32F1xx/Include'));
		assert.ok(!make.includes('USE_HAL_DRIVER'));
	});

	suite('review findings (2026-11-25)', () => {

		async function seededStore(deviceFiles: Record<string, string>, pack = CMSIS_DEVICE.F1, top = 'cmsis-device-f1-4.3.5'): Promise<string> {
			const store = path.join(tmp, 'store');
			await seed(store, CMSIS_CORE, 'cmsis-core-5.9.0', { 'Core/Include/core_cm3.h': '/* cm3 */' });
			await seed(store, pack, top, deviceFiles);
			return store;
		}

		async function generated(name: string, part: string, toolchain: 'cmake' | 'make' = 'cmake'): Promise<string> {
			const project = path.join(tmp, name);
			for (const [rel, text] of generateStm32Project({ name, target: resolveTarget(part), kind: 'executable', toolchain, openocdInterface: 'stlink' })) {
				await write(project, rel, text);
			}
			return project;
		}

		test('a part outside the catalog whose guessed define the pack does not know gets nothing (no #error builds)', async () => {
			const store = await seededStore({ 'Include/stm32f1xx.h': '#error "Please select first the target STM32F1xx device"', 'Include/stm32f103xb.h': '' });
			const project = await generated('guess', 'STM32F103C6T6');
			assert.deepStrictEqual(await installCmsisIntoProject(project, resolveTarget('STM32F103C6T6'), noNetwork, store), { kind: 'unknown-device', define: 'STM32F103xx' });
			assert.ok(!fs.existsSync(path.join(project, 'Drivers')));
		});

		test('STM32WB: ST\'s startup_<define>_cm4.s becomes the project\'s startup_<define>.s', async () => {
			const store = await seededStore({ 'Include/stm32wbxx.h': '', 'Include/stm32wb55xx.h': '', 'Source/Templates/system_stm32wbxx.c': '', 'Source/Templates/gcc/startup_stm32wb55xx_cm4.s': '/* wb cm4 */' }, CMSIS_DEVICE.WB, 'cmsis-device-wb-1.12.4');
			const project = await generated('wb', 'STM32WB55RGV6');
			await installCmsisIntoProject(project, resolveTarget('STM32WB55RGV6'), noNetwork, store);
			assert.strictEqual(await fs.promises.readFile(path.join(project, 'startup_stm32wb55xx.s'), 'utf8'), '/* wb cm4 */');
			// …whose Reset_Handler initialises .MB_MEM2: the generated linker script provides it for WB.
			const ld = await fs.promises.readFile(path.join(project, 'STM32WB55RGV6_FLASH.ld'), 'utf8');
			assert.ok(['_siMB_MEM2', '_sMB_MEM2', '_eMB_MEM2'].every(symbol => ld.includes(symbol)));
		});

		test('writes never follow a symbolic link out of the project', async () => {
			const store = await seededStore({ 'Include/stm32f1xx.h': '', 'Include/stm32f103xb.h': '' });
			const project = await generated('links', 'STM32F103C8T6');
			const victim = path.join(tmp, 'victim.txt');
			await fs.promises.writeFile(victim, 'keep me');
			await fs.promises.mkdir(path.join(project, 'Drivers', 'CMSIS'), { recursive: true });
			await fs.promises.symlink(victim, path.join(project, 'Drivers', 'CMSIS', 'README.md'));
			await installCmsisIntoProject(project, resolveTarget('STM32F103C8T6'), noNetwork, store);
			assert.strictEqual(await fs.promises.readFile(victim, 'utf8'), 'keep me');
			assert.ok(!(await fs.promises.lstat(path.join(project, 'Drivers', 'CMSIS', 'README.md'))).isSymbolicLink());

			const outside = path.join(tmp, 'outside');
			await fs.promises.mkdir(outside);
			await fs.promises.rm(path.join(project, 'Core', 'Src'), { recursive: true });
			await fs.promises.symlink(outside, path.join(project, 'Core', 'Src'));
			await fs.promises.rm(path.join(project, 'Drivers'), { recursive: true });
			await assert.rejects(installCmsisIntoProject(project, resolveTarget('STM32F103C8T6'), noNetwork, await seededStore({ 'Include/stm32f1xx.h': '', 'Include/stm32f103xb.h': '', 'Source/Templates/system_stm32f1xx.c': '' })), /outside the project/);
			assert.deepStrictEqual(await fs.promises.readdir(outside), []);
		});

		test('an old CRLF CMakeLists with USE_HAL_DRIVER among other defines is upgraded; IntelliSense loses the HAL define', async () => {
			const target = resolveTarget('STM32F103C8T6');
			const fresh = generateStm32Project({ name: 'p', target, kind: 'executable', toolchain: 'cmake', openocdInterface: 'stlink' }).get('CMakeLists.txt')!;
			const begin = fresh.indexOf('\n# CMSIS core + device headers');
			const end = fresh.indexOf('endif()\nendif()\n') + 'endif()\nendif()\n'.length;
			const old = (fresh.slice(0, begin) + fresh.slice(end)).replace('add_compile_definitions(STM32F103xB)', 'add_compile_definitions(STM32F103xB USE_HAL_DRIVER MY_FLAG)').replace(/\n/g, '\r\n');
			const upgraded = upgradeGeneratedBuildFile('cmake', old, target)!;
			assert.ok(upgraded.includes('add_compile_definitions(STM32F103xB MY_FLAG)\r\n'));
			assert.ok(upgraded.includes('Core/Src/system_stm32f1xx.c'));
			assert.ok(!/[^\r]\n/.test(upgraded), 'line endings kept');

			const oldMake = generateStm32Project({ name: 'p', target, kind: 'executable', toolchain: 'make', openocdInterface: 'stlink' }).get('Makefile')!
				.replace(/# CMSIS core \+ device headers[^\n]*\n[^\n]*\n/, '').replace('-DSTM32F103xB', '-DSTM32F103xB -DUSE_HAL_DRIVER');
			const make = upgradeGeneratedBuildFile('make', oldMake, target)!;
			assert.ok(!make.includes('USE_HAL_DRIVER') && make.includes('-IDrivers/CMSIS/Include'));

			const store = await seededStore({ 'Include/stm32f1xx.h': '', 'Include/stm32f103xb.h': '' });
			const project = await generated('ide', 'STM32F103C8T6');
			await write(project, '.vscode/c_cpp_properties.json', '{"configurations":[{"defines":["STM32F103xB","USE_HAL_DRIVER"]}]}');
			await installCmsisIntoProject(project, target, noNetwork, store);
			assert.deepStrictEqual(JSON.parse(await fs.promises.readFile(path.join(project, '.vscode', 'c_cpp_properties.json'), 'utf8')).configurations[0].defines, ['STM32F103xB']);
		});

		test('two installs of the same pack at once download it once and both succeed', async () => {
			const archive = await tarball(tmp, 'cmsis-device-zz-1.0.0', { 'Include/stm32zzxx.h': '' });
			const pack: CmsisPack = { repo: 'cmsis-device-zz', tag: 'v1.0.0', sha256: crypto.createHash('sha256').update(archive).digest('hex') };
			let downloads = 0;
			const io: CmsisIo = { download: async () => { downloads++; return archive; }, extractTarGz: nodeCmsisIo().extractTarGz };
			const store = path.join(tmp, 'store2');
			const [a, b] = await Promise.all([ensureCmsisPack(pack, store, io), ensureCmsisPack(pack, store, io)]);
			assert.deepStrictEqual([a === b, downloads], [true, 1]);
			assert.strictEqual((await fs.promises.stat(store)).mode & 0o777, 0o700);
		});

		test('re-review: a failed install does not stick, nothing is created through a symlinked parent, every IntelliSense configuration is fixed, M7 parts prefer _cm7', async () => {
			const archive = await tarball(tmp, 'cmsis-device-yy-1.0.0', { 'Include/stm32yyxx.h': '' });
			const pack: CmsisPack = { repo: 'cmsis-device-yy', tag: 'v1.0.0', sha256: crypto.createHash('sha256').update(archive).digest('hex') };
			let fail = true;
			const io: CmsisIo = { download: async () => { if (fail) { throw new Error('offline'); } return archive; }, extractTarGz: nodeCmsisIo().extractTarGz };
			const store = path.join(tmp, 'store3');
			await assert.rejects(ensureCmsisPack(pack, store, io), /offline/);
			fail = false;
			assert.ok(await ensureCmsisPack(pack, store, io));

			const seeded = await seededStore({ 'Include/stm32f1xx.h': '', 'Include/stm32f103xb.h': '' });
			const project = await generated('parent-link', 'STM32F103C8T6');
			const elsewhere = path.join(tmp, 'elsewhere');
			await fs.promises.mkdir(elsewhere);
			await fs.promises.symlink(elsewhere, path.join(project, 'Drivers'));
			await assert.rejects(installCmsisIntoProject(project, resolveTarget('STM32F103C8T6'), noNetwork, seeded), /outside the project/);
			assert.deepStrictEqual(await fs.promises.readdir(elsewhere), [], 'no folder created outside');

			const ide = await generated('two-configs', 'STM32F103C8T6');
			await write(ide, '.vscode/c_cpp_properties.json', JSON.stringify({ configurations: [{ defines: ['STM32F103xB', 'USE_HAL_DRIVER'] }, { defines: ['USE_HAL_DRIVER=1'] }] }));
			await installCmsisIntoProject(ide, resolveTarget('STM32F103C8T6'), noNetwork, seeded);
			assert.deepStrictEqual(JSON.parse(await fs.promises.readFile(path.join(ide, '.vscode', 'c_cpp_properties.json'), 'utf8')).configurations.map((c: { defines: string[] }) => c.defines), [['STM32F103xB'], []]);
		});

		test('re-review: a Cortex-M7 part takes the _cm7 startup when ST ships per-core files', async () => {
			const device = path.join(tmp, 'h7');
			await write(device, 'Source/Templates/gcc/startup_stm32h745xx_cm4.s', 'cm4');
			await write(device, 'Source/Templates/gcc/startup_stm32h745xx_cm7.s', 'cm7');
			const pick = async (core: string) => (await cmsisProjectFiles(path.join(tmp, 'nocore'), device, { id: 'H7', cmsisPrefix: 'stm32h7xx' }, 'STM32H745xx', core)).find(c => c.to.startsWith('startup_'))!.from;
			assert.deepStrictEqual([path.basename(await pick('cortex-m7')), path.basename(await pick('cortex-m4'))], ['startup_stm32h745xx_cm7.s', 'startup_stm32h745xx_cm4.s']);
		});
	});
});
