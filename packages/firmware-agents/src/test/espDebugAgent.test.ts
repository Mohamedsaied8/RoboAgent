/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { readFileSync } from 'fs';
import * as path from 'path';
import { createFirmwareDebugAgent } from '../agents/debug/debugAgent';
import { OpenOcdGdbSession } from '../embedded/debug/targetSession';
import { DefaultTargetCatalog } from '../embedded/target';
import { debugRequirements } from '../install/resolver';
import { callTool, say, ScriptedFakeLlm } from '../llm/scriptedFakeLlm';
import { FakeSerialPorts, loadTranscript, scriptedGdb, TranscriptGdb } from './fakeDebug';
import { FakeHost, FakeSystemProbe } from './fakeHost';

function fixture(name: string): string {
	return readFileSync(path.resolve(__dirname, '..', '..', 'src', 'test', 'fixtures', name), 'latin1');
}

function resultOf(llm: ScriptedFakeLlm, callId: string): Record<string, unknown> & { error?: string } {
	for (const request of [...llm.requests].reverse()) {
		const m = request.messages.find(x => x.role === 'tool' && x.toolCallId === callId);
		if (m && m.role === 'tool') {
			return JSON.parse(m.content);
		}
	}
	throw new Error(`no result for ${callId}`);
}

const GDB = '/opt/espressif/tools/xtensa-esp-elf-gdb/bin/xtensa-esp32-elf-gdb';
const PORT = { device: '/dev/ttyUSB0', alias: '/dev/serial/by-id/usb-Silicon_Labs_CP2102_USB_to_UART_Bridge_Controller_0001-if00-port0', description: 'Silicon Labs CP2102 USB to UART Bridge Controller' };

/** A host with the ESP32 GDB on PATH, the user in dialout, one CP2102 port and the app ELF in fw/. */
function espHost(serialOutput: (device: string, sent: string | undefined) => string = () => ''): { host: FakeHost; serial: FakeSerialPorts } {
	const host = new FakeHost();
	host.system = new FakeSystemProbe();
	host.system.programs.set('xtensa-esp32-elf-gdb', { path: GDB });
	host.onExec = (command, args) => command === 'xtensa-esp32-elf-gdb' && args[0] === '--version' ? { stdout: 'GNU gdb (esp-gdb) 17.1_20260402' }
		: command === 'id' ? { stdout: args[0] === '-un' ? 'dev' : 'dev dialout' } : command === 'getent' ? { stdout: 'dialout:x:20:dev' } : undefined;
	host.fs.files.set('fw/esp32_debug.elf', '\x7fELF (not the real ELF: its SHA-256 does not match the logs)');
	const serial = new FakeSerialPorts([PORT], serialOutput);
	host.serial = serial;
	return { host, serial };
}

suite('ESP32 Debug agent: replays of sessions recorded on an ESP32 DevKit (CP2102, ESP-IDF v6.1)', function () {

	this.timeout(20_000);

	test('live over the UART GDB stub: tasks, breakpoint, registers, step, the stub\'s watchpoint quirk, memory write, seeded crash decoded, kill', async () => {
		const { host, serial } = espHost();
		const gdb = new TranscriptGdb(loadTranscript('esp32-stub.mi.txt'));
		host.onSpawn = (_command, _args, options) => gdb.spawn(options);
		const llm = new ScriptedFakeLlm([
			callTool('chk', 'check_debug_tools', { part: 'esp32', transport: 'serial' }),
			callTool('start', 'start_session', { part: 'esp32', transport: 'serial', port: '/dev/ttyUSB0', elf: 'fw/esp32_debug.elf' }),
			callTool('threads', 'threads', {}),
			callTool('bp', 'set_breakpoint', { location: 'toggle_led' }),
			callTool('run', 'resume', { waitMs: 5000 }),
			callTool('ev', 'evaluate', { expressions: ['counter', 'sensor', '$a2'] }),
			callTool('regs', 'read_core_registers', {}),
			callTool('wp0', 'set_watchpoint', { expression: 'sensor.reading', access: 'w' }),
			callTool('step', 'step', { kind: 'over' }),
			callTool('wpx', 'set_watchpoint', { expression: 'counter', access: 'w' }),
			callTool('clr0', 'clear_breakpoint', { id: 2 }),
			callTool('run2', 'resume', { waitMs: 3000 }),
			callTool('clr', 'clear_breakpoint', { id: 1 }),
			callTool('wp', 'set_watchpoint', { expression: 'counter', access: 'w' }),
			callTool('hit', 'resume', { waitMs: 5000 }),
			callTool('clr2', 'clear_breakpoint', { id: 3 }),
			callTool('mem', 'read_memory', { address: '&sensor', length: 8 }),
			callTool('seed', 'write_memory', { address: '&fault_trigger', bytes: '01000000' }),
			callTool('crash', 'resume', { waitMs: 5000 }),
			callTool('dec', 'decode_crash', {}),
			callTool('end', 'end_session', { resume: true }),
			say('done'),
		]);
		const agent = createFirmwareDebugAgent({ llm, host });
		await agent.run('debug the ESP32');
		await agent.dispose();

		assert.deepStrictEqual(gdb.mismatches, []);
		assert.strictEqual(gdb.remaining, 0);
		assert.strictEqual(resultOf(llm, 'chk').ok, true);
		// GDB opens the port itself, at 115200 baud, interrupting the runtime stub on connect; nothing else held it.
		assert.deepStrictEqual([host.spawned[0].command, serial.openPorts], [GDB, 0]);
		const start = resultOf(llm, 'start');
		assert.deepStrictEqual([start.transport, start.connection, start.live, start.hardwareBreakpoints, start.hardwareWatchpoints, (start.stoppedAt as { function: string; reason: string }).function, (start.stoppedAt as { reason: string }).reason],
			['serial', 'ESP-IDF GDB stub on /dev/ttyUSB0 (115200 baud)', true, 2, 2, 'esp_cpu_wait_for_intr', 'interrupted']);
		const threads = resultOf(llm, 'threads') as unknown as { name: string; state: string; current: boolean }[];
		assert.deepStrictEqual(threads.map(t => `${t.name}:${t.state}${t.current ? '*' : ''}`), ['IDLE0:Running*', 'IDLE1:Running', 'main:Blocked', 'ipc0:Blocked', 'ipc1:Blocked']);
		assert.deepStrictEqual([resultOf(llm, 'bp').budget, (resultOf(llm, 'run').at as { function: string }).function], ['1/1 usable breakpoints in use', 'toggle_led']);
		assert.deepStrictEqual(resultOf(llm, 'ev'), [{ expression: 'counter', value: '27' }, { expression: 'sensor', value: '{id = 7, reading = 27}' }, { expression: '$a2', value: '3' }] as unknown);
		const regs = resultOf(llm, 'regs');
		assert.deepStrictEqual([regs.pc, regs.a1, regs.windowbase, Object.keys(regs).includes('exccause')], ['0x400d7898', '0x3ffb4e10', '0x0', false]);
		assert.match(resultOf(llm, 'wpx').error!, /does not arm watchpoints set after a step/);
		assert.deepStrictEqual([(resultOf(llm, 'run2').at as { reason: string }).reason, (resultOf(llm, 'hit').at as { reason: string }).reason], ['breakpoint-hit', 'watchpoint-trigger']);
		assert.deepStrictEqual(resultOf(llm, 'seed'), { written: 4, address: '0x3FFB39CC', readBack: '01000000' });
		const dec = resultOf(llm, 'dec') as { exception: string; faultAddress: unknown; faultingInstruction: string; faultingCode: { function: string; line: number }; caller: { function: string; line: number }; thread: string; summary: string };
		assert.deepStrictEqual([dec.exception, dec.faultAddress, dec.faultingInstruction, dec.faultingCode.function, dec.faultingCode.line, dec.caller.function, dec.caller.line, dec.thread],
			['LoadProhibited', { address: '0x00000000', source: 'EXCVADDR' }, 'l32i.n a2, a8, 0', 'read_sensor_bus', 31, 'run_seeded_bug', 67, 'main']);
		assert.match(dec.summary, /NULL pointer dereference/);
		// Attaching and the memory write asked; reads, run control and decoding did not.
		assert.deepStrictEqual(host.approvals.map(a => a.toolName), ['start_session', 'write_memory']);
	});

	test('post-mortem from the UART core dump: capture, decode_panic, every task, the crash, and globals the dump lacks are refused', async () => {
		const log = fixture('esp32-null-pointer-coredump.log');
		const { host, serial } = espHost((_device, sent) => sent === 'n' ? log : '');
		const gdb = new TranscriptGdb(loadTranscript('esp32-core.mi.txt'));
		host.onSpawn = (_command, _args, options) => gdb.spawn(options);
		// decode_panic resolves addresses with GDB in batch mode.
		const batch: string[][] = [];
		const onExec = host.onExec;
		host.onExec = (command, args, options) => {
			if (command === GDB && args[0] === '-batch') {
				batch.push([...args]);
				const addresses = args.filter(a => a.startsWith('info line *')).map(a => a.slice('info line *'.length));
				const known: Record<string, string> = {
					'0x400DC3B9': 'Line 31 of "/work/esp32_debug/main/main.c" starts at address 0x400dc3b6 <read_sensor_bus+6> and ends at 0x400dc3be.',
					'0x400DC3BC': 'Line 31 of "/work/esp32_debug/main/main.c" starts at address 0x400dc3b6 <read_sensor_bus+6> and ends at 0x400dc3be.',
					'0x400D7998': 'Line 67 of "/work/esp32_debug/main/main.c" starts at address 0x400d7990 <run_seeded_bug+28> and ends at 0x400d799e.',
					'0x400D7AA5': 'Line 109 of "/work/esp32_debug/main/main.c" starts at address 0x400d7aa0 <app_main+40> and ends at 0x400d7aab.',
					'0x400D4070': 'Line 206 of "/opt/esp-idf/components/freertos/app_startup.c" starts at address 0x400d406e <main_task+98> and ends at 0x400d4073.',
				};
				return { stdout: addresses.map(a => `@@${a}\n${known[a] ?? `No line number information available for address ${a}`}\n`).join('') };
			}
			return onExec(command, args, options);
		};
		const llm = new ScriptedFakeLlm([
			callTool('send', 'send_serial', { text: 'n', durationMs: 15000 }),
			callTool('panic', 'decode_panic', { elf: 'fw/esp32_debug.elf', part: 'esp32' }),
			callTool('start', 'start_session', { part: 'esp32', transport: 'coredump', elf: 'fw/esp32_debug.elf' }),
			callTool('threads', 'threads', {}),
			callTool('dec', 'decode_crash', {}),
			callTool('ev', 'evaluate', { expressions: ['counter'] }),
			callTool('sel', 'select_thread', { id: 2 }),
			callTool('bt', 'backtrace', { maxFrames: 4 }),
			callTool('bpx', 'set_breakpoint', { location: 'main' }),
			callTool('wx', 'write_memory', { address: '0x3ffb4ee0', bytes: '00' }),
			callTool('end', 'end_session', {}),
			say('done'),
		]);
		const agent = createFirmwareDebugAgent({ llm, host });
		await agent.run('why did it crash?');
		await agent.dispose();

		assert.deepStrictEqual(gdb.mismatches, []);
		assert.deepStrictEqual([serial.written, serial.openPorts], [['n'], 0]);
		const send = resultOf(llm, 'send') as { stoppedBy: string; crashes: string[]; coreDumps: number; output: string };
		assert.deepStrictEqual([send.stoppedBy, send.crashes, send.coreDumps], ['pattern', ['exception (LoadProhibited), then halt'], 1]);
		// The base64 dump is not shown to the model.
		assert.match(send.output, /\[base64 core dump omitted/);
		assert.doesNotMatch(send.output, /f0VMRgEBAQ/);

		const panic = resultOf(llm, 'panic') as { kind: string; reason: string; faultAddress: string; pc: { function: string; line: number }; firstApplicationFrame: { function: string }; backtrace: { function?: string; line?: number }[]; warning: string; coreDump: string };
		assert.deepStrictEqual([panic.kind, panic.reason, panic.faultAddress, panic.pc.function, panic.pc.line, panic.firstApplicationFrame.function, panic.backtrace.map(f => `${f.function}:${f.line}`)],
			['exception', 'LoadProhibited', '0x00000000 (NULL pointer dereference)', 'read_sensor_bus', 31, 'read_sensor_bus', ['read_sensor_bus:31', 'run_seeded_bug:67', 'app_main:109', 'main_task:206', 'undefined:undefined']]);
		// The workspace ELF is not the one that crashed: decode_panic says so.
		assert.match(panic.warning, /not the program that crashed .* 7cab942cd/);
		// Symbols come from GDB in batch mode, never loading scripts; the ELF goes after "--".
		assert.deepStrictEqual([batch[0].slice(0, 9), batch[0].slice(-2)], [['-batch', '-nx', '-q', '-iex', 'set auto-load off', '-iex', 'set debuginfod enabled off', '-iex', 'set pagination off'], ['--', 'fw/esp32_debug.elf']]);

		const start = resultOf(llm, 'start') as { live: boolean; coreDump: { checksum: string; appElfSha256: string; coreFile: string }; warning: string };
		assert.deepStrictEqual([start.live, start.coreDump.checksum, start.coreDump.appElfSha256], [false, 'sha256 ok', '7cab942cd']);
		assert.match(start.warning, /not the program that crashed/);
		// The ELF core was written into the workspace for GDB.
		assert.strictEqual(host.fs.binaries.get(start.coreDump.coreFile)?.length, 6516);
		const threads = resultOf(llm, 'threads') as unknown as { name: string; current: boolean }[];
		assert.deepStrictEqual(threads.map(t => t.name), ['main', 'IDLE0', 'IDLE1', 'ipc0', 'ipc1']);
		const dec = resultOf(llm, 'dec') as { exception: string; faultAddress: unknown; faultingCode: { function: string }; thread: string };
		assert.deepStrictEqual([dec.exception, dec.faultAddress, dec.faultingCode.function, dec.thread], ['LoadProhibited', { address: '0x00000000', source: 'EXCVADDR' }, 'read_sensor_bus', 'main']);
		// Globals are not in the dump: GDB is not allowed to read their initial values from the ELF.
		assert.match((resultOf(llm, 'ev') as unknown as { error: string }[])[0].error, /not in the core dump.*CONFIG_ESP_COREDUMP_CAPTURE_DRAM/);
		assert.deepStrictEqual(((resultOf(llm, 'bt') as unknown as { function: string }[]).map(f => f.function)), ['esp_cpu_wait_for_intr', 'esp_vApplicationIdleHook', 'prvIdleTask', 'vPortTaskWrapper']);
		assert.match(resultOf(llm, 'bpx').error!, /core dump .* needs a live target/);
		assert.match(resultOf(llm, 'wx').error!, /core dump .* needs a live target/);
		assert.deepStrictEqual(host.approvals.map(a => a.toolName), ['send_serial', 'start_session', 'write_memory']);
	});
});

/** A fake OpenRouter key for the redaction test, built at runtime so secret scanners do not flag it. */
const FAKE_OPENROUTER_KEY = ['sk', 'or', 'v1', '0123456789abcdef'.repeat(4)].join('-');

suite('ESP32 Debug agent: serial tools and guards', function () {

	this.timeout(20_000);

	test('read_serial listens without approval; reset_and_capture and send_serial ask; control bytes are refused; secrets are redacted', async () => {
		const { host, serial } = espHost((_d, sent) => sent === undefined ? `I (10) wifi: key ${FAKE_OPENROUTER_KEY}\nesp32_debug ready\n` : `echo ${sent}`);
		const llm = new ScriptedFakeLlm([
			callTool('ports', 'list_serial_ports', {}),
			callTool('listen', 'read_serial', { durationMs: 200 }),
			callTool('reset', 'reset_and_capture', { durationMs: 200 }),
			callTool('ctrl', 'send_serial', { text: '\x03' }),
			callTool('cmd', 'send_serial', { text: 'help\n', durationMs: 200 }),
			callTool('nolog', 'decode_panic', {}),
			say('done'),
		]);
		const agent = createFirmwareDebugAgent({ llm, host });
		await agent.run('look at the console');
		assert.deepStrictEqual((resultOf(llm, 'ports') as unknown as { device: string }[]).map(p => p.device), ['/dev/ttyUSB0']);
		const listen = resultOf(llm, 'listen') as { stoppedBy: string; output: string; crashes: string[] };
		assert.deepStrictEqual([listen.stoppedBy, listen.crashes], ['timeout', []]);
		assert.doesNotMatch(listen.output, /0123456789abcdef0123/);
		assert.match(listen.output, /esp32_debug ready/);
		assert.deepStrictEqual([(resultOf(llm, 'reset').reset as { ok: boolean }).ok, serial.resets], [true, ['/dev/ttyUSB0']]);
		// Refused by the input schema, before anyone is asked.
		assert.match(resultOf(llm, 'ctrl').error!, /not allowed/);
		assert.match(resultOf(llm, 'cmd').output as string, /echo help/);
		assert.match((resultOf(llm, 'nolog') as { note: string }).note, /No ESP-IDF crash report/);
		assert.deepStrictEqual(host.approvals.map(a => a.toolName), ['reset_and_capture', 'send_serial']);
		assert.strictEqual(serial.openPorts, 0);
	});

	test('the serial transport needs only GDB and serial access; probes are matched to their chips', () => {
		const esp32 = new DefaultTargetCatalog().resolve('esp32')!;
		assert.deepStrictEqual(debugRequirements({ target: esp32, transport: 'serial' }).map(d => d.id), ['gdb', 'serial-port-access']);
		assert.deepStrictEqual(debugRequirements({ target: esp32 }).map(d => d.id), ['openocd-esp32', 'gdb', 'probe-usb-access', 'serial-port-access']);
	});

	test('session guards: one transport only, serial devices by pattern, a core dump needs the ELF, transports are ESP32-only', async () => {
		const { host } = espHost();
		host.onSpawn = (_c, _a, options) => scriptedGdb(options);
		const esp32 = new DefaultTargetCatalog().resolve('esp32')!;
		const base = { target: esp32, gdb: GDB, probe: 'x', owner: 't' };
		await assert.rejects(OpenOcdGdbSession.start(host, { ...base }), /exactly one of/);
		await assert.rejects(OpenOcdGdbSession.start(host, { ...base, serial: { device: '/dev/ttyUSB0', baud: 115200 }, coreFile: 'c.elf' }), /exactly one of/);
		for (const device of ['/dev/sda', '/dev/ttyUSB0 -ex shell', '/tmp/x', '/dev/ttyUSB0\n']) {
			await assert.rejects(OpenOcdGdbSession.start(host, { ...base, serial: { device, baud: 115200 } }), /not a serial port the debugger may open/);
		}
		await assert.rejects(OpenOcdGdbSession.start(host, { ...base, serial: { device: '/dev/ttyUSB0', baud: 12345 } }), /not a serial port/);
		host.fs.files.set('core.elf', '\x7fELF');
		await assert.rejects(OpenOcdGdbSession.start(host, { ...base, coreFile: 'core.elf' }), /needs the ELF/);

		const llm = new ScriptedFakeLlm([
			callTool('stm', 'start_session', { part: 'STM32F103C8T6', transport: 'serial' }),
			callTool('noport', 'start_session', { part: 'esp32', transport: 'serial', port: '/dev/ttyUSB7', elf: 'fw/esp32_debug.elf' }),
			callTool('nodump', 'start_session', { part: 'esp32', transport: 'coredump', elf: 'fw/esp32_debug.elf' }),
			callTool('wrongprobe', 'start_session', { part: 'esp32', probe: 'stlink' }),
			say('done'),
		]);
		const agent = createFirmwareDebugAgent({ llm, host });
		await agent.run('try');
		assert.match(resultOf(llm, 'stm').error!, /for ESP32 targets/);
		assert.match(resultOf(llm, 'noport').error!, /not a serial device/);
		assert.match(resultOf(llm, 'nodump').error!, /No core dump in the captured serial output/);
		assert.match(resultOf(llm, 'wrongprobe').error!, /esp-usb-jtag.*esp-prog.*serial/);
	});
});

suite('ESP32 debugging: review regressions', function () {

	this.timeout(20_000);

	test('reset_and_capture opens the port first and holds it while esptool resets, so the boot line is kept', async () => {
		const { host, serial } = espHost();
		const llm = new ScriptedFakeLlm([callTool('r', 'reset_and_capture', { durationMs: 100 }), say('done')]);
		await createFirmwareDebugAgent({ llm, host }).run('reset');
		assert.deepStrictEqual(serial.events, ['open', 'hold', 'reset', 'release', 'close']);
	});

	test('send_serial refuses GDB remote-protocol packets and text for a chip waiting in its panic stub', async () => {
		const stubLog = 'Guru Meditation Error: Core  0 panic\'ed (LoadProhibited). Exception was unhandled.\nBacktrace: 0x400d1000:0x3ffb0000\nEntering gdb stub now.\n';
		const { host, serial } = espHost((_d, sent) => sent === undefined ? stubLog : '');
		const llm = new ScriptedFakeLlm([
			callTool('packet', 'send_serial', { text: '$M6001a0f8,4:01000000#00' }),
			callTool('listen', 'read_serial', { durationMs: 100 }),
			callTool('plain', 'send_serial', { text: 'help\n' }),
			say('done'),
		]);
		await createFirmwareDebugAgent({ llm, host }).run('poke');
		assert.match(resultOf(llm, 'packet').error!, /not allowed/);
		assert.match(resultOf(llm, 'plain').error!, /waiting in its GDB stub/);
		assert.deepStrictEqual(serial.written, []);
	});

	test('write_memory never touches ESP32 eFuses or the SPI flash controller, through either bus', async () => {
		const { host } = espHost();
		host.onSpawn = (_c, _a, options) => scriptedGdb(options, command => command.startsWith('-target-select') ? '*stopped,frame={addr="0x400d7898"}\nTOKEN^connected' : undefined);
		const llm = new ScriptedFakeLlm([
			callTool('start', 'start_session', { part: 'esp32', transport: 'serial', port: '/dev/ttyUSB0' }),
			...['0x3FF5A0F8', '0x6001A0F8', '0x60002000', '0x3FF42000', '0x3F400100', '0x400D0100'].map((address, k) => callTool(`w${k}`, 'write_memory', { address, bytes: '01000000' })),
			callTool('end', 'end_session', {}),
			say('done'),
		]);
		await createFirmwareDebugAgent({ llm, host }).run('write');
		assert.deepStrictEqual([0, 1, 2, 3, 4, 5].map(k => /Refused: .*(eFuse|SPI flash controller|flash-mapped)/.test(resultOf(llm, `w${k}`).error ?? '')), [true, true, true, true, true, true]);
	});

	test('a GDB stub without symbols keeps the stop signal (the chip may have panicked) and says it may be stale', async () => {
		const { host } = espHost();
		host.onSpawn = (_c, _a, options) => scriptedGdb(options, command =>
			command.startsWith('-target-select') ? '*stopped,reason="signal-received",signal-name="SIGSEGV",frame={addr="0x400db870"}\nTOKEN^connected'
				: command === '-data-evaluate-expression "$pc"' ? 'TOKEN^done,value="0x400db870"'
					: command.startsWith('-interpreter-exec console "x/i') ? '~"=> 0x400db870:\\tl32i.n\\ta2, a8, 0\\n"\nTOKEN^done'
						: command === '-data-evaluate-expression "$a8"' ? 'TOKEN^done,value="0"' : undefined);
		const llm = new ScriptedFakeLlm([
			callTool('start', 'start_session', { part: 'esp32', transport: 'serial', port: '/dev/ttyUSB0' }),
			callTool('dec', 'decode_crash', {}),
			callTool('end', 'end_session', { resume: false }),
			say('done'),
		]);
		await createFirmwareDebugAgent({ llm, host }).run('crash?');
		assert.strictEqual((resultOf(llm, 'start').stoppedAt as { signal?: string }).signal, 'SIGSEGV');
		const dec = resultOf(llm, 'dec') as { faulted: boolean; faultAddress: { address: string }; summary: string };
		assert.deepStrictEqual([dec.faulted, dec.faultAddress.address], [true, '0x00000000']);
		assert.match(dec.summary, /unknown whether the chip panicked/);
	});

	test('a RISC-V core dump is decoded from the exception frame below the crashed thread\'s sp, only when its saved mepc/sp match', async () => {
		const { host } = espHost();
		host.system!.programs.set('riscv32-esp-elf-gdb', { path: '/opt/gdb/riscv32-esp-elf-gdb' });
		host.fs.binaries.set('c3/core.elf', riscvCoreWithExtraInfo(1070129824));
		host.fs.files.set('c3/app.elf', '\x7fELF');
		// $sp = 0x3FC8E100: the exception frame is at 0x3FC8E060 and saved mepc/sp match.
		const memory: Record<number, number> = { 0x3FC8E060: 0x42000a1c, 0x3FC8E068: 0x3FC8E100, 0x3FC8E0E8: 5, 0x3FC8E0EC: 4 };
		const stale = { value: false };
		host.onSpawn = (_c, _a, options) => scriptedGdb(options, command => {
			if (command === '-thread-info') {
				return 'TOKEN^done,threads=[{id="1",target-id="process 1",frame={addr="0x0"}},{id="2",target-id="process 1070129824",frame={addr="0x42000a1c"}}],current-thread-id="1"';
			}
			// Reads are pinned to the crashed task's thread (its TCB is in the dump's extra-info note), frame 0.
			const read = /^-data-evaluate-expression --thread 2 --frame 0 "\*\(unsigned long \*\)(\d+)"$/.exec(command);
			if (read) {
				const address = Number(read[1]);
				return `TOKEN^done,value="${stale.value && address === 0x3FC8E060 ? 0x40000000 : memory[address] ?? 0}"`;
			}
			return command === '-data-evaluate-expression --thread 2 --frame 0 "(unsigned long)$pc"' ? 'TOKEN^done,value="1107298844"'
				: command === '-data-evaluate-expression --thread 2 --frame 0 "(unsigned long)$sp"' ? 'TOKEN^done,value="1070129408"'
					: command === '-data-evaluate-expression "$pc"' ? 'TOKEN^done,value="0x42000a1c <read_sensor+8>"'
						: command.startsWith('-interpreter-exec console "x/i') ? '~"=> 0x42000a1c <read_sensor+8>:\\tlw\\ta0,4(a5)\\n"\nTOKEN^done'
							: command.startsWith('-stack-list-frames') ? 'TOKEN^done,stack=[frame={level="0",addr="0x42000a1c",func="read_sensor",file="/work/main/main.c",line="31"}]'
								: command.startsWith('-target-select') ? 'TOKEN^connected' : undefined;
		});
		const llm = new ScriptedFakeLlm([
			callTool('start', 'start_session', { part: 'esp32c3', transport: 'coredump', coreDump: 'c3/core.elf', elf: 'c3/app.elf' }),
			callTool('dec', 'decode_crash', {}),
			callTool('end', 'end_session', {}),
			say('done'),
		]);
		await createFirmwareDebugAgent({ llm, host }).run('crash?');
		const dec = resultOf(llm, 'dec') as { faulted: boolean; exception: string; faultAddress: { address: string } };
		assert.deepStrictEqual([dec.faulted, dec.exception, dec.faultAddress.address], [true, 'Load access fault', '0x00000004'], JSON.stringify(resultOf(llm, 'dec')));

		// A frame whose saved mepc does not match $pc is not the exception frame: no cause is claimed.
		stale.value = true;
		const again = new ScriptedFakeLlm([
			callTool('start', 'start_session', { part: 'esp32c3', transport: 'coredump', coreDump: 'c3/core.elf', elf: 'c3/app.elf' }),
			callTool('dec', 'decode_crash', {}),
			callTool('end', 'end_session', {}),
			say('done'),
		]);
		await createFirmwareDebugAgent({ llm: again, host }).run('crash?');
		const unsure = resultOf(again, 'dec') as { faulted: boolean; exception?: string };
		assert.deepStrictEqual([unsure.faulted, unsure.exception], [false, undefined]);
	});
});

/** A minimal 32-bit RISC-V ELF core with ESP-IDF's ESP_EXTRA_INFO note: { crashed_task_tcb, isr_context }. */
function riscvCoreWithExtraInfo(tcb: number): Uint8Array {
	const name = Buffer.from('ESP_EXTRA_INFO\0\0');
	const note = Buffer.alloc(12 + name.length + 8);
	note.writeUInt32LE(15, 0);
	note.writeUInt32LE(8, 4);
	note.writeUInt32LE(677, 8);
	name.copy(note, 12);
	note.writeUInt32LE(tcb, 12 + name.length);
	const elf = Buffer.alloc(52 + 32 + note.length);
	elf.set([0x7F, 0x45, 0x4C, 0x46, 1, 1, 1]);
	elf.writeUInt16LE(4, 16); // ET_CORE
	elf.writeUInt16LE(243, 18); // EM_RISCV
	elf.writeUInt32LE(52, 28); // e_phoff
	elf.writeUInt16LE(32, 42); // e_phentsize
	elf.writeUInt16LE(1, 44); // e_phnum
	elf.writeUInt32LE(4, 52); // PT_NOTE
	elf.writeUInt32LE(84, 56); // p_offset
	elf.writeUInt32LE(note.length, 68); // p_filesz
	note.copy(elf, 84);
	return new Uint8Array(elf);
}
