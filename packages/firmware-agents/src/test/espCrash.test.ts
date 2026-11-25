/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import * as path from 'path';
import { espBudget, exceptionCause, xtensaReturnToCall } from '../embedded/arch/esp';
import { CoreDumpError, extractUartCoreDumps, parseCoreDump } from '../embedded/crash/espCoreDump';
import { cleanSerialText, crashAddress, isEspIdfSource, MAX_LOG_CHARS, parseEspLog, stripCoreDumpBodies } from '../embedded/crash/espPanicLog';
import { parseInfoLines } from '../embedded/debug/symbolizer';
import { coreMemoryRegions, memoryAccess } from '../embedded/debug/targetSession';

/** Serial logs captured from an ESP32-D0WDQ6 (ESP-IDF v6.1) running the seeded-bug fixture, 2026-10-25. */
function fixture(name: string): string {
	return readFileSync(path.resolve(__dirname, '..', '..', 'src', 'test', 'fixtures', name), 'latin1');
}

suite('ESP-IDF panic logs (recorded on an ESP32)', () => {

	test('NULL pointer read: LoadProhibited, EXCVADDR 0, the backtrace, then the core dump and halt', () => {
		const log = parseEspLog(fixture('esp32-null-pointer.log'));
		assert.strictEqual(log.crashes.length, 1);
		const c = log.crashes[0];
		assert.deepStrictEqual({
			kind: c.kind, core: c.core, reason: c.reason, faultAddress: c.faultAddress, pc: crashAddress(c),
			exccause: c.registers.EXCCAUSE, registers: Object.keys(c.registers).length, frames: c.backtrace.length, first: c.backtrace[0],
			corrupted: c.backtraceCorrupted, sha: c.elfSha256, then: c.then, coreDump: c.coreDump, appSha: log.appElfSha256,
		}, {
			kind: 'exception', core: 0, reason: 'LoadProhibited', faultAddress: 0, pc: 0x400dc388,
			exccause: 28, registers: 24, frames: 5, first: { pc: 0x400dc385, sp: 0x3ffb4fa0 },
			corrupted: false, sha: '59a068287', then: 'halt', coreDump: true, appSha: '59a068287',
		});
		assert.match(c.meaning!, /NULL pointer/);
	});

	test('assert(): function, location and expression; no register dump', () => {
		const c = parseEspLog(fixture('esp32-assert.log')).crashes[0];
		assert.deepStrictEqual([c.kind, c.assertion, Object.keys(c.registers).length, c.backtrace.length, c.then], [
			'assert', { function: 'check_reading', location: 'main.c:36', expression: 'reading >= 0 && "sensor reading must not be negative"' }, 0, 8, 'halt',
		]);
	});

	test('a smashed stack: two nested Guru Meditations, corrupted backtraces, the second core\'s dump ignored, then a reboot', () => {
		const log = parseEspLog(fixture('esp32-stack-smash.log'));
		assert.deepStrictEqual(log.crashes.map(c => [c.kind, c.reason, c.core, c.backtraceCorrupted, c.then]), [
			['exception', 'StoreProhibited', 1, true, 'nested-panic'],
			['exception', 'InstrFetchProhibited', 1, true, 'nested-panic'],
		]);
		assert.deepStrictEqual([log.crashes[0].faultAddress, log.crashes[0].registers.PC, log.crashes[1].registers.PC, log.boots], [0xa2117170, 0x4008640e, 0x00060023, ['SW_CPU_RESET (0xc)']]);
	});

	test('task watchdog: the tasks that starved, what each CPU ran, and the backtrace', () => {
		const c = parseEspLog(fixture('esp32-task-wdt.log')).crashes[0];
		assert.deepStrictEqual([c.kind, c.details.slice(1, 5), c.backtrace.length, c.then], ['task-watchdog', ['- main (CPU 0)', '- IDLE0 (CPU 0)', 'Tasks currently running:', 'CPU 0: main'], 4, 'halt']);
	});

	test('stack canary watchpoint, abort(), brownout, RISC-V register dumps and interrupt watchdogs', () => {
		const text = [
			'Guru Meditation Error: Core  0 panic\'ed (Unhandled debug exception). ',
			'Debug exception reason: Stack canary watchpoint triggered (sensor_task) ',
			'Core  0 register dump:',
			'PC      : 0x4008008f  PS      : 0x00060336  A0      : 0x3ffb5db0  A1      : 0x3ffb5d50  ',
			'Backtrace: 0x4008008c:0x3ffb5d50 0x3ffb5dad:0x3ffb5ab0 |<-CORRUPTED',
			'Rebooting...',
			'abort() was called at PC 0x400d1234 on core 1',
			'Backtrace: 0x40081234:0x3ffb0000',
			'Brownout detector was triggered',
			'Guru Meditation Error: Core  0 panic\'ed (Load access fault). Exception was unhandled.',
			'Core  0 register dump:',
			'MEPC    : 0x42000a1c  RA      : 0x42000a10  SP      : 0x3fc8e0a0  GP      : 0x3fc8a600  ',
			'S0/FP   : 0x00000000  S1      : 0x00000001  MCAUSE  : 0x00000005  MTVAL   : 0x00000004  ',
			'',
			'Stack memory:',
			'Guru Meditation Error: Core  1 panic\'ed (Interrupt wdt timeout on CPU1). ',
		].join('\r\n');
		const log = parseEspLog(text);
		assert.deepStrictEqual(log.crashes.map(c => [c.kind, c.task, c.then]), [
			['stack-overflow', 'sensor_task', 'reboot'],
			['abort', undefined, undefined],
			['brownout', undefined, 'reboot'],
			['exception', undefined, undefined],
			['interrupt-watchdog', undefined, undefined],
		]);
		assert.deepStrictEqual([log.crashes[1].abortPc, log.crashes[3].registers.MEPC, log.crashes[3].registers.S0, log.crashes[3].faultAddress, crashAddress(log.crashes[3])], [0x400d1234, 0x42000a1c, 0, 4, 0x42000a1c]);
		assert.match(log.crashes[2].meaning!, /supply voltage/);
	});

	test('ANSI colours, control bytes and the boot ROM\'s garbage are cleaned; a huge log is cut from the front in linear time', () => {
		assert.strictEqual(cleanSerialText('\x1b[0;31mE (12) x\x1b[0m\r\nok\x00\x07'), 'E (12) x\nok');
		const filler = 'I (1) app: '.padEnd(200, 'x') + '\n';
		const big = filler.repeat(5000) + fixture('esp32-null-pointer.log');
		const started = Date.now();
		const log = parseEspLog(big);
		assert.ok(Date.now() - started < 2000);
		assert.deepStrictEqual([log.crashes.length, log.crashes[0].reason, log.truncatedLines > 0], [1, 'LoadProhibited', true]);
		// Adversarial lines: long runs that almost match must not make matching slow.
		const evil = `${'Backtrace:'}${' 0x1'.repeat(50_000)}\n${'Core  0 register dump:'}\n${'A0 : 0x'.repeat(20_000)}\n`;
		const t0 = Date.now();
		parseEspLog(evil);
		assert.ok(Date.now() - t0 < 2000);
	});

	test('ESP-IDF\'s own sources are told apart from the application\'s', () => {
		assert.deepStrictEqual([
			isEspIdfSource('/opt/esp-idf/components/esp_system/panic.c'),
			isEspIdfSource('/home/u/esp/esp-idf-v5.3/components/freertos/tasks.c'),
			isEspIdfSource('/work/fw/components/sensor/sensor.c'),
			isEspIdfSource('/work/fw/main/main.c'),
			isEspIdfSource(undefined),
		], [true, true, false, false, false]);
	});
});

suite('ESP-IDF core dumps (recorded on an ESP32)', () => {

	test('the UART dump of the NULL-pointer crash: header, SHA-256, ELF core, and the notes GDB cannot show', () => {
		const [image, ...more] = extractUartCoreDumps(fixture('esp32-null-pointer.log'));
		assert.strictEqual(more.length, 0);
		const dump = parseCoreDump(image);
		assert.deepStrictEqual({ ...dump, elf: dump.elf.length }, {
			elf: 6516, version: { chipId: 0, major: 1, minor: 4 }, chipRevision: 100, checksum: 'sha256',
			appElfSha256: '59a068287', crashedTaskTcb: 1073412600, exccause: 28, excvaddr: 0, isrContext: false,
		});
	});

	test('assert and watchdog dumps carry their text; their EXCCAUSE slot (no exception frame) is not reported', () => {
		const assertDump = parseCoreDump(extractUartCoreDumps(fixture('esp32-assert.log'))[0]);
		assert.deepStrictEqual([assertDump.panicDetails, assertDump.exccause], ['assert failed: check_reading main.c:36 (reading >= 0 && "sensor reading must not be negative")', 0]);
		const wdt = parseCoreDump(extractUartCoreDumps(fixture('esp32-task-wdt.log'))[0]);
		assert.deepStrictEqual([wdt.exccause, wdt.excvaddr, wdt.panicDetails?.split('\n')[0]], [undefined, undefined, 'Task watchdog got triggered. The following tasks/users did not reset the watchdog in time:']);
	});

	test('corrupted, truncated, mixed-up or foreign dumps are refused with a reason', () => {
		const image = extractUartCoreDumps(fixture('esp32-null-pointer.log'))[0];
		const flipped = Uint8Array.from(image);
		flipped[100] ^= 0xFF;
		assert.throws(() => parseCoreDump(flipped), (e: Error) => e instanceof CoreDumpError && /checksum does not match/.test(e.message));
		assert.throws(() => parseCoreDump(image.subarray(0, image.length - 40)), /header says 6560 bytes but 6520/);
		const binary = Uint8Array.from(image);
		binary[5] = 0; // version 0.4: the old binary format
		assert.throws(() => parseCoreDump(binary), /not the ELF format/);
		assert.throws(() => parseCoreDump(new Uint8Array(10)), /too short/);
		// A log line inside the base64 makes the dump unusable instead of decoding garbage.
		const text = fixture('esp32-null-pointer.log').replace('Q09SRQAAAAA=', 'I (99) wifi: connected');
		assert.deepStrictEqual(extractUartCoreDumps(text), []);
	});

	test('CRC32 dumps (format 1.2) are checked too', () => {
		const elf = extractUartCoreDumps(fixture('esp32-null-pointer.log'))[0].subarray(12, -32);
		const body = new Uint8Array(12 + elf.length);
		const v = new DataView(body.buffer);
		v.setUint32(0, 12 + elf.length + 4, true);
		v.setUint32(4, 0x0102, true);
		v.setUint32(8, 300, true);
		body.set(elf, 12);
		let crc = 0xFFFFFFFF;
		for (const b of body) {
			crc ^= b;
			for (let k = 0; k < 8; k++) {
				crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
			}
		}
		const image = new Uint8Array(body.length + 4);
		image.set(body);
		new DataView(image.buffer).setUint32(body.length, (crc ^ 0xFFFFFFFF) >>> 0, true);
		assert.deepStrictEqual([parseCoreDump(image).checksum, parseCoreDump(image).chipRevision], ['crc32', 300]);
	});

	test('the note reader survives arbitrary bytes (bounded, never reads past the end)', () => {
		const real = extractUartCoreDumps(fixture('esp32-null-pointer.log'))[0];
		let seed = 7;
		const rand = () => (seed = (seed * 1103515245 + 12345) >>> 0) >>> 16;
		for (let round = 0; round < 200; round++) {
			const elf = Uint8Array.from(real.subarray(12, -32));
			for (let k = 0; k < 20; k++) {
				elf[52 + rand() % (elf.length - 52)] = rand() & 0xFF;
			}
			const image = new Uint8Array(12 + elf.length + 32);
			const v = new DataView(image.buffer);
			v.setUint32(0, image.length, true);
			v.setUint32(4, 0x0104, true);
			image.set(elf, 12);
			image.set(createHash('sha256').update(image.subarray(0, 12 + elf.length)).digest(), 12 + elf.length);
			parseCoreDump(image);
		}
	});
});

suite('ESP32 architecture facts', () => {

	test('exception causes, ESP-IDF pseudo causes (64 + N) and RISC-V mcause', () => {
		assert.deepStrictEqual([
			exceptionCause('xtensa', 28)?.name, exceptionCause('xtensa', 20)?.name, exceptionCause('xtensa', 65)?.name,
			exceptionCause('xtensa', 69)?.name, exceptionCause('xtensa', 0xFFFF), exceptionCause('riscv', 5)?.name, exceptionCause('riscv', 0x80000007), exceptionCause('cortex-m', 1),
		], ['LoadProhibited', 'InstrFetchProhibited', 'Unhandled debug exception', 'Interrupt wdt timeout on CPU0', undefined, 'Load access fault', undefined, undefined]);
		assert.deepStrictEqual([espBudget('esp32'), espBudget('ESP32C3'), espBudget('stm32f103')], [{ breakpoints: 2, watchpoints: 2 }, { breakpoints: 8, watchpoints: 8 }, undefined]);
		assert.strictEqual(xtensaReturnToCall(0x800d7967), 0x400d7964);
	});

	test('the data access of a faulting load/store comes from the disassembly', () => {
		assert.deepStrictEqual([
			memoryAccess('xtensa', 'l32i.n a2, a8, 0'),
			memoryAccess('xtensa', 's32i a3, a1, 16'),
			memoryAccess('xtensa', 's32e a4, a0, -32'),
			memoryAccess('xtensa', 'l16ui a9, a10, 0x6'),
			memoryAccess('riscv', 'lw a5,0(a5)'),
			memoryAccess('riscv', 'c.sw a4,8(sp)'),
			memoryAccess('xtensa', 'retw.n'),
			memoryAccess('xtensa', 'ill'),
			memoryAccess('riscv', undefined),
		], [
			{ access: 'read', base: 'a8', offset: 0 },
			{ access: 'write', base: 'a1', offset: 16 },
			{ access: 'write', base: 'a0', offset: -32 },
			{ access: 'read', base: 'a10', offset: 6 },
			{ access: 'read', base: 'a5', offset: 0 },
			{ access: 'write', base: 'sp', offset: 8 },
			undefined, undefined, undefined,
		]);
	});

	test('a core dump session reads only dumped memory and read-only code (from GDB\'s section list)', () => {
		const sections = [
			'Exec file: `/work/fw/esp32_debug.elf\', file type elf32-xtensa-le.',
			' [8]      0x40080404->0x4008ac3f at 0x0000e404: .iram0.text ALLOC LOAD READONLY CODE HAS_CONTENTS',
			' [9]      0x3ffb0000->0x3ffb2fea at 0x0000b000: .dram0.data ALLOC LOAD DATA HAS_CONTENTS',
			' [13]     0x3ffb2ff0->0x3ffb3d28 at 0x0000dfea: .dram0.bss ALLOC',
			' [15]     0x3f400120->0x3f409ba4 at 0x00001120: .flash.rodata ALLOC LOAD DATA HAS_CONTENTS',
			' [7]      0x40080000->0x40080404 at 0x0000e000: .iram0.vectors ALLOC LOAD READONLY CODE HAS_CONTENTS',
			' [24]     0x0000->0x10cc79 at 0x0002e628: .debug_info READONLY HAS_CONTENTS',
			'Core file: `/work/.roboagent/coredumps/core.elf\', file type elf32-xtensa-le.',
			' [1]      0x0000->0x0200 at 0x00000210: .reg/1073412600 HAS_CONTENTS',
			' [7]      0x3ffaf9f8->0x3ffafa5c at 0x00000d94: load1 ALLOC LOAD HAS_CONTENTS',
			' [8]      0x3ffafa5c->0x3ffafa80 at 0x00000df8: load2 ALLOC LOAD HAS_CONTENTS',
		].join('\n');
		// .data and .bss of the ELF are not trusted (their values on the chip differ); adjacent ranges merge.
		assert.deepStrictEqual(coreMemoryRegions(sections), [[0x3f400120, 0x3f409ba4], [0x3ffaf9f8, 0x3ffafa80], [0x40080000, 0x4008ac3f]]);
	});

	test('GDB batch "info line" output becomes function, file and line per address', () => {
		const out = [
			'@@0x400DC385',
			'Line 31 of "/work/fw/main/main.c" starts at address 0x400dc383 <read_sensor_bus+3> and ends at 0x400dc38a <read_sensor_bus+10>.',
			'@@0x40081234',
			'No line number information available for address 0x40081234 <read_id_core+51>',
			'@@0x12',
			'No line number information available for address 0x12',
			'@@0x400D7898',
			'Line 58 of "/work/fw/main/main.c" is at address 0x400d7898 <toggle_led> but contains no code.',
		].join('\n');
		assert.deepStrictEqual([...parseInfoLines(out).values()], [
			{ address: '0x400DC385', function: 'read_sensor_bus', file: '/work/fw/main/main.c', line: 31 },
			{ address: '0x40081234', function: 'read_id_core' },
			{ address: '0x00000012' },
			{ address: '0x400D7898', function: 'toggle_led', file: '/work/fw/main/main.c', line: 58 },
		]);
	});
});

suite('ESP-IDF log parsing: review regressions', () => {

	const guru = (n: number) => [
		`Guru Meditation Error: Core  0 panic'ed (LoadProhibited). Exception was unhandled.`,
		'Core  0 register dump:',
		`PC      : 0x400d${(0x1000 + n).toString(16)}  PS      : 0x00060830  `,
		`Backtrace: 0x400d${(0x1000 + n).toString(16)}:0x3ffb4fa0`,
		'Rebooting...',
		'ets Jun  8 2016 00:22:57',
		'rst:0xc (SW_CPU_RESET),boot:0x13 (SPI_FAST_FLASH_BOOT)',
	].join('\n');

	test('more than 32 reports keep the newest ones and say how many older ones were dropped', () => {
		const log = parseEspLog(Array.from({ length: 40 }, (_, n) => guru(n)).join('\n'));
		assert.deepStrictEqual([log.crashes.length, log.droppedCrashes, log.crashes.at(-1)!.registers.PC, log.boots.length], [32, 8, 0x400d1000 + 39, 40]);
	});

	test('a core dump cut off by a reset does not hide the boots and crashes after it', () => {
		const text = [guru(1).split('\n').slice(0, 4).join('\n'), '================= CORE DUMP START =================', 'oBkAAAQBAABkAAAA', 'f0VMRgEBAQAAAAAAAAAAAAQAXgAB', 'ets Jun  8 2016 00:22:57', 'rst:0x1 (POWERON_RESET),boot:0x13 (SPI_FAST_FLASH_BOOT)', guru(2)].join('\n');
		const log = parseEspLog(text);
		assert.deepStrictEqual([log.crashes.length, log.crashes[0].coreDump, log.crashes[0].then, log.crashes[1].registers.PC, log.boots], [2, true, 'reboot', 0x400d1002, ['POWERON_RESET (0x1)', 'SW_CPU_RESET (0xc)']]);
	});

	test('a cut-off dump before a later complete one hides neither the reboot nor the newer crash; line numbers stay right', () => {
		const text = [guru(1).split('\n').slice(0, 4).join('\n'), '================= CORE DUMP START =================', 'QUFBQQ==', 'QUFBQQ==',
			'ets Jun  8 2016 00:22:57', 'rst:0xc (SW_CPU_RESET),boot:0x13 (SPI_FAST_FLASH_BOOT)',
			guru(2).split('\n').slice(0, 4).join('\n'), '================= CORE DUMP START =================', 'QUFBQQ==', '================= CORE DUMP END =================', 'Rebooting...'].join('\n');
		const log = parseEspLog(text);
		assert.deepStrictEqual([log.crashes.map(c => c.registers.PC), log.boots, log.crashes.map(c => c.line), log.crashes.map(c => c.coreDump)],
			[[0x400d1001, 0x400d1002], ['SW_CPU_RESET (0xc)'], [1, 10], [true, true]]);
		assert.strictEqual(stripCoreDumpBodies(text, '[dump]').split('\n').filter(l => l === '[dump]').length, 2);
	});

	test('a crash in a new boot (its reset line missed) is not taken for a nested panic', () => {
		const first = guru(1).split('\n').slice(0, 4).join('\n');
		const log = parseEspLog(`${first}\nI (27) boot: ESP-IDF v6.1 2nd stage bootloader\n${guru(2)}`);
		assert.deepStrictEqual(log.crashes.map(c => c.then), ['reboot', 'reboot']);
		const nested = parseEspLog(`${first}\nCore  1 register dump:\nPC      : 0x${guru(2)}`);
		assert.strictEqual(nested.crashes[0].then, 'nested-panic');
	});

	test('abort()/assert blame abort\'s caller, not ESP-IDF\'s panic_abort at the top of the backtrace', () => {
		const c = parseEspLog('abort() was called at PC 0x400d1234 on core 0\nBacktrace: 0x40085cc5:0x3ffb4e40 0x400d1231:0x3ffb4e60\n').crashes[0];
		assert.deepStrictEqual([c.kind, crashAddress(c)], ['abort', 0x400d1234]);
	});

	test('pathological serial lines (long runs of "=", letters, markers without an end) stay fast', () => {
		const equals = `${'='.repeat(200_000)} CORE DUMP\n${'='.repeat(200_000)}\n`;
		const letters = `Core  0 register dump:\n${'A'.repeat(200_000)}\n`;
		const markers = '================= CORE DUMP START =================\n'.repeat(5_000);
		for (const text of [equals, letters, markers, equals + letters + markers]) {
			const t0 = Date.now();
			parseEspLog(text);
			extractUartCoreDumps(text);
			stripCoreDumpBodies(text);
			assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0} ms`);
		}
	});

	test('a large core dump is reduced to one line, so the crash report before it survives the length cap', () => {
		const report = guru(3).split('\n').slice(0, 4).join('\n');
		const body = 'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFB\n'.repeat(15_000);
		const text = `${report}\n================= CORE DUMP START =================\n${body}================= CORE DUMP END =================\nCPU halted.\n`;
		assert.ok(text.length > MAX_LOG_CHARS);
		const log = parseEspLog(text);
		assert.deepStrictEqual([log.crashes.length, log.crashes[0].coreDump, log.crashes[0].then, log.truncatedLines], [1, true, 'halt', 0]);
	});
});
