/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  @toolchain — the P1 gate with the real arm-none-eabi toolchain and CMake on this machine
 *  (skipped when they are missing). The model is scripted; everything else is real: files,
 *  processes, compiler, linker, size.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { execFileSync } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NodeAgentHost } from '../adapters/node/nodeAgentHost';
import { createFirmwareDevAgent } from '../agents/dev/devAgent';
import { parseBerkeleySize } from '../embedded/build/sizeReport';
import { callTool, say, ScriptedFakeLlm } from '../llm/scriptedFakeLlm';
import { writeStm32ExecutableFixture, writeStm32LibraryFixture } from './firmwareFixtures';

function available(command: string): boolean {
	try {
		execFileSync(command, ['--version'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
}

function resultOf(llm: ScriptedFakeLlm, callId: string): Record<string, unknown> {
	for (const request of [...llm.requests].reverse()) {
		const m = request.messages.find(x => x.role === 'tool' && x.toolCallId === callId);
		if (m && m.role === 'tool') {
			return JSON.parse(m.content);
		}
	}
	throw new Error(`no result for ${callId}`);
}

suite('@toolchain FirmwareDevAgent with the real toolchain (P1 gate)', function () {

	this.timeout(180_000);
	let root: string;

	suiteSetup(function () {
		if (!available('arm-none-eabi-gcc') || !available('cmake') || !available('make')) {
			this.skip();
		}
	});

	setup(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), 'fwagents-p1-'));
	});

	teardown(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	const host = () => new NodeAgentHost({ root, approve: async () => true, write: () => { } });

	test('builds the STM32 fixture library from a clean checkout and sizes it like arm-none-eabi-size', async () => {
		const source = await writeStm32LibraryFixture(path.join(root, 'stm32_test'));
		const llm = new ScriptedFakeLlm([
			callTool('d', 'detect_project', { dir: 'stm32_test' }),
			callTool('t', 'check_toolchain', { dir: 'stm32_test' }),
			callTool('b', 'build', { dir: 'stm32_test' }),
			callTool('s', 'size_report', { dir: 'stm32_test' }),
			say('Built libstm32_test.a.'),
		]);
		const result = await createFirmwareDevAgent({ llm, host: host() }).run('Build stm32_test');
		assert.strictEqual(result.stopReason, 'done', `fixture source: ${source}`);

		const detected = resultOf(llm, 'd') as { buildSystem: string; target: { part: string; flashKb: number } };
		assert.deepStrictEqual([detected.buildSystem, detected.target.part, detected.target.flashKb], ['cmake', 'STM32F103C8T6', 64]);
		assert.deepStrictEqual((resultOf(llm, 't') as { missing: string[] }).missing, []);

		const build = resultOf(llm, 'b') as { ok: boolean; steps: { step: string; ok: boolean; errors: number }[]; artifacts: { lib: string[] } };
		assert.deepStrictEqual(build.steps.map(s => [s.step, s.ok, s.errors]), [['configure', true, 0], ['build', true, 0]]);
		assert.deepStrictEqual(build.artifacts.lib, ['stm32_test/build/libstm32_test.a']);

		const expected = parseBerkeleySize(execFileSync('arm-none-eabi-size', [path.join(root, 'stm32_test/build/libstm32_test.a')]).toString());
		const size = resultOf(llm, 's') as { flashBytes: number; ramBytes: number; note: string };
		assert.strictEqual(size.flashBytes, expected.reduce((s, e) => s + e.text + e.data, 0));
		assert.strictEqual(size.ramBytes, expected.reduce((s, e) => s + e.data + e.bss, 0));
		assert.match(size.note, /Static library/);
	});

	test('a seeded compile error comes back as a structured diagnostic, and the fix builds', async () => {
		await writeStm32LibraryFixture(path.join(root, 'stm32_test'));
		const file = path.join(root, 'stm32_test/Src/stm32_test.c');
		await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace('return ++s_ticks;', 'return ++s_tick;'));
		const llm = new ScriptedFakeLlm([
			callTool('b1', 'build', { dir: 'stm32_test' }),
			callTool('e', 'edit_file', { path: 'stm32_test/Src/stm32_test.c', oldText: 'return ++s_tick;', newText: 'return ++s_ticks;' }),
			callTool('b2', 'build', { dir: 'stm32_test' }),
			say('Fixed.'),
		]);
		await createFirmwareDevAgent({ llm, host: host() }).run('Build stm32_test');

		const failed = resultOf(llm, 'b1') as { ok: boolean; steps: { step: string; diagnostics: { severity: string; file: string; line: number; message: string }[] }[] };
		const errors = failed.steps.at(-1)!.diagnostics.filter(d => d.severity === 'error');
		assert.strictEqual(failed.ok, false);
		assert.ok(errors.length >= 1);
		assert.match(errors[0].file, /Src\/stm32_test\.c$/);
		assert.match(errors[0].message, /'s_tick' undeclared/);
		const lineOfError = (await fs.readFile(file, 'utf8')).split('\n').findIndex(l => l.includes('return ++s_ticks;')) + 1;
		assert.strictEqual(errors[0].line, lineOfError);
		assert.strictEqual((resultOf(llm, 'b2') as { ok: boolean }).ok, true);
	});

	test('an executable: ELF and map are found; size and map agree with the toolchain', async () => {
		await writeStm32ExecutableFixture(path.join(root, 'blinky'));
		const llm = new ScriptedFakeLlm([
			callTool('d', 'detect_project', { dir: 'blinky' }),
			callTool('b', 'build', { dir: 'blinky', buildType: 'MinSizeRel' }),
			callTool('s', 'size_report', { dir: 'blinky' }),
			callTool('m', 'map_report', { dir: 'blinky' }),
			say('ok'),
		]);
		await createFirmwareDevAgent({ llm, host: host() }).run('Build blinky');

		const build = resultOf(llm, 'b') as { ok: boolean; artifacts: { elf: string[]; map: string[] } };
		assert.deepStrictEqual([build.ok, build.artifacts.elf, build.artifacts.map], [true, ['blinky/build/blinky.elf'], ['blinky/build/blinky.map']]);

		const [expected] = parseBerkeleySize(execFileSync('arm-none-eabi-size', [path.join(root, 'blinky/build/blinky.elf')]).toString());
		const size = resultOf(llm, 's') as { flashBytes: number; ramBytes: number; flashPercent: number; topContributors: { object: string }[] };
		assert.deepStrictEqual([size.flashBytes, size.ramBytes], [expected.text + expected.data, expected.data + expected.bss]);
		assert.ok(size.flashPercent > 0 && size.flashPercent < 5);
		assert.match(size.topContributors[0].object, /main\.c\.obj$/);

		const map = resultOf(llm, 'm') as { regions: { name: string; used: number; length: number }[] };
		const flash = map.regions.find(r => r.name === 'FLASH')!;
		const ram = map.regions.find(r => r.name === 'RAM')!;
		assert.deepStrictEqual([flash.length, ram.length], [64 * 1024, 20 * 1024]);
		// The map counts the vector table and .data initialisers in FLASH; `size` agrees on flash.
		assert.strictEqual(flash.used, expected.text + expected.data);
		assert.ok(ram.used >= 1024 + 4, `RAM used ${ram.used}`);
	});

	test('a project copied with its build tree builds the copy, not the original (stale CMake cache)', async () => {
		await writeStm32LibraryFixture(path.join(root, 'orig'));
		execFileSync('cmake', ['-S', '.', '-B', 'build'], { cwd: path.join(root, 'orig'), stdio: 'ignore' });
		await fs.cp(path.join(root, 'orig'), path.join(root, 'copy'), { recursive: true });
		const file = path.join(root, 'copy/Src/stm32_test.c');
		await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace('return ++s_ticks;', 'return ++s_tick;'));
		const llm = new ScriptedFakeLlm([callTool('b', 'build', { dir: 'copy' }), say('x')]);
		await createFirmwareDevAgent({ llm, host: host() }).run('Build copy');
		const build = resultOf(llm, 'b') as { ok: boolean; steps: { step: string; diagnostics: { message: string }[] }[] };
		// The seeded error is only in the copy: a green build would mean the original was compiled.
		assert.strictEqual(build.ok, false);
		assert.ok(build.steps.some(s => s.diagnostics.some(d => /'s_tick' undeclared/.test(d.message))), JSON.stringify(build.steps.map(s => s.step)));
		assert.deepStrictEqual(build.steps.map(s => s.step), ['clean', 'configure', 'build']);
	});
});
