/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { budgetFromControlRegisters, decodeCortexMFault, stackFromExcReturn } from '../embedded/arch/cortexM';
import { GdbMiClient, MiError } from '../embedded/debug/gdbmi/client';
import { miQuote, parseMiLine } from '../embedded/debug/gdbmi/parser';
import { acquireProbe, OpenOcdServer, ProbeBusyError } from '../embedded/debug/openocdServer';
import { bitBandTarget, checkExpression, checkLocation, DebugSessionError, OpenOcdGdbSession } from '../embedded/debug/targetSession';
import { parseSvd } from '../embedded/svd/svdParser';
import { DefaultTargetCatalog } from '../embedded/target';
import { fakeOpenOcd, loadTranscript, openocdStartupLines, scriptedGdb, TranscriptGdb } from './fakeDebug';
import { FakeHost } from './fakeHost';

suite('GDB/MI parser', () => {

	test('parses the record kinds of a real session', () => {
		const lines = [
			'(gdb) ',
			'12^connected',
			'16^done,value="{id = 7, reading = 3}"',
			'*running,thread-id="all"',
			'=thread-group-added,id="i1"',
			'~"Breakpoint 1, toggle_led () at Src/main.c:51\\n"',
			'@"xPSR: 0x01000000 pc: 0x080000a4 msp: 0x20005000\\n"',
			'&"warning: No executable has been specified\\n"',
			'21^error,msg="Cannot access memory at address 0x0"',
		];
		assert.deepStrictEqual(lines.map(l => JSON.parse(JSON.stringify(parseMiLine(l)))), [
			{ kind: 'prompt' },
			{ kind: 'result', token: 12, resultClass: 'connected', results: {} },
			{ kind: 'result', token: 16, resultClass: 'done', results: { value: '{id = 7, reading = 3}' } },
			{ kind: 'exec', asyncClass: 'running', results: { 'thread-id': 'all' } },
			{ kind: 'notify', asyncClass: 'thread-group-added', results: { id: 'i1' } },
			{ kind: 'console', text: 'Breakpoint 1, toggle_led () at Src/main.c:51\n' },
			{ kind: 'target', text: 'xPSR: 0x01000000 pc: 0x080000a4 msp: 0x20005000\n' },
			{ kind: 'log', text: 'warning: No executable has been specified\n' },
			{ kind: 'result', token: 21, resultClass: 'error', results: { msg: 'Cannot access memory at address 0x0' } },
		]);
	});

	test('nested tuples and lists, lists of results, repeated names, octal UTF-8 escapes', () => {
		const stopped = parseMiLine('*stopped,reason="breakpoint-hit",bkptno="1",frame={addr="0x08000032",func="toggle_led",args=[],file="Src/main.c",line="51"},thread-id="1"');
		assert.ok(stopped.kind === 'exec');
		assert.deepStrictEqual(JSON.parse(JSON.stringify(stopped.results)), { reason: 'breakpoint-hit', bkptno: '1', frame: { addr: '0x08000032', func: 'toggle_led', args: [], file: 'Src/main.c', line: '51' }, 'thread-id': '1' });
		const stack = parseMiLine('15^done,stack=[frame={level="0",addr="0x1"},frame={level="1",addr="0x2"}]');
		assert.ok(stack.kind === 'result');
		assert.deepStrictEqual(JSON.parse(JSON.stringify(stack.results.stack)), [{ level: '0', addr: '0x1' }, { level: '1', addr: '0x2' }]);
		const multi = parseMiLine('3^done,bkpt={number="1"},bkpt={number="1.1"},bkpt={number="1.2"}');
		assert.ok(multi.kind === 'result');
		assert.deepStrictEqual(JSON.parse(JSON.stringify(multi.results.bkpt)), [{ number: '1' }, { number: '1.1' }, { number: '1.2' }]);
		// GDB prints non-ASCII bytes as octal escapes: "°C" is \302\260C.
		assert.deepStrictEqual(parseMiLine('~"T=25\\302\\260C\\t\\"ok\\"\\n"'), { kind: 'console', text: 'T=25°C\t"ok"\n' });
	});

	test('malformed lines come back as unknown instead of throwing', () => {
		for (const line of ['^done,value="unterminated', '5^done,x=', '*stopped,frame={a="1"', 'random text', '^done,a="1"garbage', `^done,x=${'['.repeat(100)}`]) {
			assert.strictEqual(parseMiLine(line).kind, 'unknown', line);
		}
	});

	test('miQuote escapes quotes and backslashes and refuses line breaks (command injection)', () => {
		assert.strictEqual(miQuote('a "b" \\c'), '"a \\"b\\" \\\\c"');
		assert.throws(() => miQuote('main\n-target-select remote evil:1'));
		assert.throws(() => miQuote('x\r'));
	});
});

suite('GdbMiClient', () => {

	function client() {
		const written: string[] = [];
		const c = new GdbMiClient(t => written.push(t));
		return { c, written };
	}

	test('matches replies by token, collects stream output, maps ^error', async () => {
		const { c, written } = client();
		const a = c.send('-interpreter-exec console "monitor reset halt"');
		const b = c.send('-data-evaluate-expression "x"');
		assert.deepStrictEqual(written, ['1-interpreter-exec console "monitor reset halt"\n', '2-data-evaluate-expression "x"\n']);
		c.feed('@"halted\\n"\n1^done\n(gdb) \n2^err');
		c.feed('or,msg="No symbol \\"x\\" in current context."\n');
		assert.deepStrictEqual(await a, { resultClass: 'done', results: Object.create(null), output: 'halted\n' });
		await assert.rejects(b, (e: MiError) => e.kind === 'error' && e.message === 'No symbol "x" in current context.');
	});

	test('times out, can be cancelled, and refuses commands with line breaks', async () => {
		const { c } = client();
		await assert.rejects(c.send('-exec-interrupt', { timeoutMs: 20 }), (e: MiError) => e.kind === 'timeout');
		const ac = new AbortController();
		const p = c.send('-exec-interrupt', { signal: ac.signal });
		ac.abort();
		await assert.rejects(p, (e: MiError) => e.kind === 'cancelled');
		await assert.rejects(c.send('-gdb-exit\n-target-select remote x:1'), /line break/);
	});

	test('runUntilStop sees a stop that arrives in the same chunk as ^running', async () => {
		const { c } = client();
		const p = c.runUntilStop('-exec-step-instruction');
		c.feed('1^running\n*running,thread-id="all"\n(gdb) \n*stopped,reason="end-stepping-range",frame={addr="0x8000034"}\n');
		const stop = await p;
		assert.strictEqual(stop.reason, 'end-stepping-range');
		assert.strictEqual(c.state, 'stopped');
	});

	test('a failing resume command does not leave a stop waiter behind', async () => {
		const { c } = client();
		const p = c.runUntilStop('-exec-finish', { timeoutMs: 60_000 });
		c.feed('1^error,msg="\\"finish\\" not meaningful in the outermost frame."\n');
		await assert.rejects(p, /outermost frame/);
		// A later stop is not delivered to the dead waiter (it would have resolved a settled promise).
		c.feed('*stopped,reason="signal-received"\n');
		assert.strictEqual(c.state, 'stopped');
	});

	test('close fails everything that is waiting, and later sends', async () => {
		const { c } = client();
		const p = c.send('-exec-continue');
		const s = c.waitForStop({ timeoutMs: 60_000 });
		c.close('exit 1');
		await assert.rejects(p, (e: MiError) => e.kind === 'closed');
		await assert.rejects(s, (e: MiError) => e.kind === 'closed');
		await assert.rejects(c.send('-gdb-exit'), (e: MiError) => e.kind === 'closed');
	});
});

suite('Debug input guards', () => {

	test('expressions: reads pass; assignments, ++/--, and GDB convenience functions are refused', () => {
		for (const ok of ['counter', 'sensor.reading', 'buffer[3] == 4', 'x != 0 && y >= 2 || z <= 1', '*(uint32_t *)0x20000000', '$pc', '$SP', '(void (*)()) 0x8000048', 'str == "a=b"', 'a->b']) {
			assert.strictEqual(checkExpression(ok), ok, ok);
		}
		for (const bad of ['counter = 5', 'x += 1', 'x <<= 2', 'x >>= 1', 'counter++', '--counter', '$_shell("id")', '$_as_string(x)', '$foo', 'a\nb', '', 'x'.repeat(300)]) {
			assert.throws(() => checkExpression(bad), DebugSessionError, bad);
		}
	});

	test('expressions may not read through a literal peripheral address (best effort); masks, products and RAM reads are fine', () => {
		for (const bad of ['*(uint32_t *)0x40013804', '*(int*)0X40013804', '*(volatile unsigned int *)1073821700', '*(int *)010000234004', '((USART_TypeDef *)0x40013800)->DR', '((uint32_t *)0x40013800)[1]', '{int}0x40013804', '{unsigned short} (0x50000000)']) {
			assert.throws(() => checkExpression(bad), /literal peripheral address/, bad);
		}
		for (const ok of ['*(uint32_t *)0x20000000', '(unsigned long)0x40013804', 'buffer[0x10]', 'x * 0x40000000', 'arr[i] & 0x40000000', 's->flags & 0x40000000', '*p == 0x50000000', '{int}0x20000000']) {
			assert.strictEqual(checkExpression(ok), ok, ok);
		}
	});

	test('bit-band aliases map to the register bits they touch', () => {
		// USART1 DR (0x40013804) bit 0, and F1 FLASH_CR (0x40022010) bit 2 (MER).
		assert.deepStrictEqual([bitBandTarget(0x42270080, 4), bitBandTarget(0x42440208, 4), bitBandTarget(0x20000000, 16)], [[0x40013804, 4], [0x40022010, 4], [0x20000000, 16]]);
	});

	test('breakpoint locations: function, file:line, file:function, *address; nothing that looks like an option', () => {
		for (const ok of ['main', 'Src/main.c:42', 'main.c:toggle_led', '*0x08000100', 'ns::func']) {
			assert.strictEqual(checkLocation(ok), ok);
		}
		for (const bad of ['-h main', 'main if x', 'main; shell id', '*$pc', 'a b', '"main"']) {
			assert.throws(() => checkLocation(bad), DebugSessionError, bad);
		}
	});

	test('the probe lock has one holder at a time', () => {
		const first = acquireProbe('stlink-test', 'fw-debug');
		assert.throws(() => acquireProbe('stlink-test', 'fw-test'), ProbeBusyError);
		first.dispose();
		acquireProbe('stlink-test', 'fw-test').dispose();
	});
});

suite('Cortex-M fault decoding', () => {

	test('the seeded BusFault recorded on a Blue Pill decodes to PRECISERR at 0x60000000', () => {
		// Values read from the real board (see fixtures/stm32f103-bluepill.mi.txt, the decode after the seeded fault).
		const report = decodeCortexMFault({
			cfsr: 0x00008200, hfsr: 0x40000000, mmfar: 0x60000000, bfar: 0x60000000, shcsr: 0,
			xpsr: 0x21000003, pc: 0x0800001C, lr: 0xFFFFFFF9, msp: 0x20004FD0, psp: 0xB947CDB8,
			stackedWords: [0x30D40, 0x20000004, 0xFFFFFFFF, 0x60000000, 0xDFA7FDF5, 0x0800008D, 0x08000048, 0x21000000], stackedFrom: 'MSP',
		});
		assert.deepStrictEqual({ current: report.currentException, flags: report.flags.map(f => `${f.register}.${f.flag}`), address: report.faultAddress, pc: report.stackedFrame?.pc, lr: report.stackedFrame?.lr }, {
			current: 'HardFault', flags: ['HFSR.FORCED', 'CFSR.PRECISERR', 'CFSR.BFARVALID'], address: { register: 'BFAR', address: '0x60000000' }, pc: '0x08000048', lr: '0x0800008D',
		});
		assert.match(report.summary, /escalated .* PRECISERR .* 0x60000000 \(BFAR\)/);
	});

	test('no fault after reset: LR = 0xFFFFFFFF is not an EXC_RETURN', () => {
		assert.strictEqual(stackFromExcReturn(0xFFFFFFFF), undefined);
		assert.deepStrictEqual([stackFromExcReturn(0xFFFFFFF9), stackFromExcReturn(0xFFFFFFFD), stackFromExcReturn(0xFFFFFFBC), stackFromExcReturn(0x0800008D)], ['MSP', 'PSP', 'PSP', undefined]);
		const report = decodeCortexMFault({ cfsr: 0, hfsr: 0, mmfar: 0xE000EDF8, bfar: 0xE000EDF8, xpsr: 0x01000000, pc: 0x080000A4, lr: 0xFFFFFFFF, msp: 0x20005000, psp: 0 });
		assert.deepStrictEqual([report.faulted, report.stackedFrame, report.summary], [false, undefined, 'No fault: the core is in Thread mode and the fault status registers are clear.']);
	});

	test('usage faults and the comparator counts', () => {
		const r = decodeCortexMFault({ cfsr: 1 << 17, hfsr: 1 << 30, mmfar: 0, bfar: 0, xpsr: 3, pc: 0, lr: 0x01, msp: 0, psp: 0 });
		assert.deepStrictEqual(r.flags.map(f => f.flag), ['FORCED', 'INVSTATE']);
		assert.match(r.summary, /stacked frame could not be located/);
		// STM32F103: FP_CTRL NUM_CODE = 6, DWT_CTRL NUMCOMP = 4.
		assert.deepStrictEqual(budgetFromControlRegisters(0x00000260, 0x40000000), { breakpoints: 6, watchpoints: 4 });
	});
});

const BLUEPILL_SVD = `<?xml version="1.0"?>
<device><name>STM32F103xx</name><size>0x20</size><resetValue>0x0</resetValue>
<peripherals>
 <peripheral><name>RCC</name><baseAddress>0x40021000</baseAddress><registers>
  <register><name>CR</name><addressOffset>0x0</addressOffset><resetValue>0x00000083</resetValue><fields>
   <field><name>HSION</name><bitOffset>0</bitOffset><bitWidth>1</bitWidth></field>
   <field><name>HSIRDY</name><bitOffset>1</bitOffset><bitWidth>1</bitWidth></field>
   <field><name>HSITRIM</name><bitOffset>3</bitOffset><bitWidth>5</bitWidth></field>
  </fields></register>
  <register><name>APB2ENR</name><addressOffset>0x18</addressOffset><access>read-write</access><fields>
   <field><name>IOPCEN</name><bitOffset>4</bitOffset><bitWidth>1</bitWidth></field>
  </fields></register>
 </registers></peripheral>
 <peripheral><name>GPIOA</name><baseAddress>0x40010800</baseAddress><registers>
  <register><name>CRH</name><addressOffset>0x4</addressOffset><resetValue>0x44444444</resetValue><fields>
   <field><name>MODE13</name><bitOffset>20</bitOffset><bitWidth>2</bitWidth></field>
   <field><name>CNF13</name><bitOffset>22</bitOffset><bitWidth>2</bitWidth></field>
  </fields></register>
  <register><name>BSRR</name><addressOffset>0x10</addressOffset><access>write-only</access></register>
 </registers></peripheral>
 <peripheral derivedFrom="GPIOA"><name>GPIOC</name><baseAddress>0x40011000</baseAddress></peripheral>
</peripherals></device>`;

suite('Recorded session replay (STM32F103C8T6 Blue Pill + ST-Link V2)', function () {

	this.timeout(20_000);

	function hostWithReplay() {
		const host = new FakeHost();
		const gdb = new TranscriptGdb(loadTranscript('stm32f103-bluepill.mi.txt'));
		host.fs.files.set('fw/bluepill.elf', '\x7fELF');
		host.onSpawn = (command, _args, options) => command.endsWith('openocd') ? fakeOpenOcd(options, openocdStartupLines()) : gdb.spawn(options);
		return { host, gdb };
	}

	const target = new DefaultTargetCatalog().resolve('STM32F103C8T6')!;
	const openocd = { program: '/tools/openocd/bin/openocd', scriptsDir: '/tools/openocd/scripts', interfaceScript: 'interface/stlink.cfg', targetScript: 'target/stm32f1x.cfg' };

	test('the whole recorded session: attach, breakpoint, peripherals, steps, guards, seeded fault, reset, detach', async () => {
		const { host, gdb } = hostWithReplay();
		const svd = parseSvd(BLUEPILL_SVD);
		const s = await OpenOcdGdbSession.start(host, { target, openocd, gdb: '/tools/gdb/bin/arm-none-eabi-gdb', elf: 'fw/bluepill.elf', svd: async () => svd, probe: 'stlink-replay', owner: 'test' });

		// OpenOCD: absolute scripts, run inside its scripts folder, localhost only, port 0, no flashing via GDB.
		assert.deepStrictEqual(host.spawned[0].args, ['-s', '/tools/openocd/scripts', '-f', '/tools/openocd/scripts/interface/stlink.cfg', '-f', '/tools/openocd/scripts/target/stm32f1x.cfg', '-c', 'bindto 127.0.0.1', '-c', 'gdb_port 0', '-c', 'tcl_port disabled', '-c', 'telnet_port disabled', '-c', 'gdb_flash_program disable']);
		assert.deepStrictEqual([host.spawned[0].options.trustedCwd, host.spawned[0].options.unsetEnv], ['/tools/openocd/scripts', ['OPENOCD_SCRIPTS']]);
		assert.deepStrictEqual(host.spawned[1].args, ['--interpreter=mi3', '-nx', '-q', '-iex', 'set auto-load off', '-iex', 'set history save off', '-iex', 'set debuginfod enabled off']);
		assert.deepStrictEqual([s.server, s.budget, s.state, s.lastStop], [
			{ probe: 'STLINK V2J48S7 (API v2) VID:PID 0483:3748', targetVoltage: 3.280645, core: 'Cortex-M3 r1p1', budget: { breakpoints: 6, watchpoints: 4 }, port: 46273 },
			{ breakpoints: 6, watchpoints: 4 }, 'stopped', { pc: '0x08000024', function: 'delay', file: 'Src/main.c', line: 46 },
		]);

		const bp = await s.setBreakpoint('toggle_led');
		assert.deepStrictEqual(await s.resume(5000), { reason: 'breakpoint-hit', pc: '0x08000032', function: 'toggle_led', file: 'Src/main.c', line: 51, breakpoint: 1 });
		assert.deepStrictEqual((await s.backtrace()).map(f => `${f.function}@${f.line}`), ['toggle_led@51', 'main@67']);
		assert.deepStrictEqual([await s.evaluate('counter'), await s.evaluate('sensor'), await s.evaluate('$pc')], ['4', '{id = 7, reading = 4}', '0x8000032 <toggle_led>']);
		const regs = await s.readCoreRegisters();
		assert.deepStrictEqual([regs.pc, regs.sp, regs.xpsr, Object.keys(regs).length], ['0x8000032', '0x20004ff0', '0x1000000', 23]);

		// The recording read the full F103 RCC (10 registers); this test SVD has two, so read them by address.
		await assert.rejects(s.readPeripheral('USART1'), /no peripheral "USART1"/);
		assert.strictEqual(gdb.mismatches.length, 0);
		// Skip ahead over the recorded RCC/GPIOC reads with direct reads of the same addresses.
		for (const address of [0x40021000, 0x40021004, 0x40021008, 0x4002100C, 0x40021010, 0x40021014]) {
			await s.readMemory(address, 4);
		}
		const apb2enr = await s.readMemory(0x40021018, 4);
		assert.deepStrictEqual([...apb2enr], [0x10, 0, 0, 0]); // IOPCEN = 1
		for (const address of [0x4002101C, 0x40021020, 0x40021024, 0x40011000]) {
			await s.readMemory(address, 4);
		}
		const gpioc = await s.readPeripheral('GPIOC');
		assert.deepStrictEqual(gpioc.registers.map(r => [r.name, r.value, r.fields.map(f => `${f.name}=${f.value}`).join(' '), r.changedFromReset]), [['CRH', '0x44244444', 'MODE13=2 CNF13=0', ['MODE13', 'CNF13']]]);
		assert.deepStrictEqual(gpioc.skipped, [{ name: 'BSRR', reason: 'write-only' }]);
		for (const address of [0x40011008, 0x4001100C, 0x40011018]) {
			await s.readMemory(address, 4);
		}

		assert.deepStrictEqual((await s.step('over')).line, 68);
		assert.deepStrictEqual((await s.step('into')).function, 'delay');
		assert.deepStrictEqual(await s.step('out'), { reason: 'function-finished', pc: '0x08000082', function: 'main', file: 'Src/main.c', line: 69 });
		for (const bad of ['counter = 5', '$_shell("id")', 'counter++']) {
			await assert.rejects(s.evaluate(bad), DebugSessionError);
		}
		await s.clearBreakpoint(bp.id);
		const wp = await s.setWatchpoint('fault_trigger', 'rw');
		assert.deepStrictEqual(wp, { id: 2, kind: 'watchpoint', location: 'fault_trigger', access: 'rw' });
		await s.clearBreakpoint(wp.id);

		// Seed the fault: the only memory write, with may-write-memory lifted just around it.
		const address = Number(await s.evaluate('(unsigned long)&fault_trigger'));
		await s.writeMemory(address, Uint8Array.from([1, 0, 0, 0]));
		assert.strictEqual(await s.evaluate('fault_trigger'), '1');
		assert.strictEqual(await s.resume(300), undefined);
		assert.strictEqual(s.state, 'running');
		await assert.rejects(s.readMemory(0x20000000, 4), /running; halt it/);
		assert.strictEqual((await s.halt()).function, 'HardFault_Handler');
		const crash = await s.decodeCrash();
		assert.deepStrictEqual([crash.currentException, crash.faultAddress, crash.faultingCode, crash.caller], ['HardFault', { register: 'BFAR', address: '0x60000000' },
			{ address: '0x08000048', function: 'read_sensor_bus', file: 'Src/main.c', line: 57 },
			{ address: '0x0800008C', function: 'main', file: 'Src/main.c', line: 70 }]);
		assert.match(crash.summary, /Faulting code: read_sensor_bus \(Src\/main\.c:57, 0x08000048\), called from main \(Src\/main\.c:70, 0x0800008C\)\./);

		assert.deepStrictEqual(await s.reset('halt'), { reason: 'reset', pc: '0x80000a4 <Reset_Handler>' });
		assert.strictEqual((await s.decodeCrash()).faulted, false);
		await s.dispose({ resume: true });
		assert.deepStrictEqual([gdb.mismatches, gdb.remaining], [[], 0]);
		// The probe is free again.
		acquireProbe('stlink-replay', 'next').dispose();
	});

	test('budget: one hardware breakpoint is kept for stepping; source breakpoints need the ELF', async () => {
		for (const withElf of [true, false]) {
			const host = new FakeHost();
			host.fs.files.set('fw/bluepill.elf', '\x7fELF');
			let next = 1;
			host.onSpawn = (command, _args, options) => command.endsWith('openocd')
				? fakeOpenOcd(options, openocdStartupLines(4000))
				: scriptedGdb(options, c => c.startsWith('-break-insert') ? `TOKEN^done,bkpt={number="${next++}",addr="0x08000032"}` : undefined);
			const s = await OpenOcdGdbSession.start(host, { target, openocd, gdb: '/tools/gdb', ...withElf ? { elf: 'fw/bluepill.elf' } : {}, probe: 'stlink-budget', owner: 'test' });
			if (withElf) {
				for (let k = 0; k < 5; k++) {
					await s.setBreakpoint(`main.c:${10 + k}`);
				}
				await assert.rejects(s.setBreakpoint('main.c:99'), /All 5 usable hardware breakpoints are in use \(the core has 6, one is kept for stepping\)/);
			} else {
				await assert.rejects(s.setBreakpoint('main'), /only address breakpoints/);
				await assert.rejects(s.step('over'), /needs the ELF/);
				assert.strictEqual((await s.setBreakpoint('*0x08000032')).id, 1);
			}
			await s.dispose({ resume: false });
		}
	});
});

suite('Debug session bookkeeping (scripted GDB)', function () {

	this.timeout(20_000);
	const target = new DefaultTargetCatalog().resolve('STM32F103C8T6')!;
	const openocd = { program: '/tools/openocd/bin/openocd', scriptsDir: '/tools/openocd/scripts', interfaceScript: 'interface/stlink.cfg', targetScript: 'target/stm32f1x.cfg' };

	async function session(respond: (command: string, gdb: { emit(text: string): void }) => string | undefined, probe: string) {
		const host = new FakeHost();
		host.fs.files.set('fw/app.elf', '\x7fELF');
		let emitter: { emit(text: string): void } = { emit: () => { } };
		host.onSpawn = (command, _args, options) => {
			if (command.endsWith('openocd')) {
				return fakeOpenOcd(options, openocdStartupLines(4001));
			}
			const p = scriptedGdb(options, c => respond(c, emitter));
			emitter = { emit: text => p.emit('stdout', text) };
			return p;
		};
		return OpenOcdGdbSession.start(host, { target, openocd, gdb: '/tools/gdb', elf: 'fw/app.elf', probe, owner: 'test' });
	}

	test('breakpoints GDB deletes itself free their slot; clearing one GDB no longer has works', async () => {
		let n = 1;
		const s = await session(c => c.startsWith('-break-watch') ? `TOKEN^done,wpt={number="${n++}",exp="x"}`
			: c === '-break-delete 3' ? 'TOKEN^error,msg="No breakpoint number 3."' : undefined, 'stlink-bk1');
		for (let k = 0; k < 4; k++) {
			await s.setWatchpoint('x', 'w');
		}
		await assert.rejects(s.setWatchpoint('x', 'w'), /All 4 hardware watchpoints are in use/);
		// GDB reports a watchpoint going out of scope, and deletes another one.
		(s as unknown as { mi: GdbMiClient }).mi.feed('*stopped,reason="watchpoint-scope",wpnum="1",frame={addr="0x1"}\n=breakpoint-deleted,id="2"\n');
		assert.deepStrictEqual(s.breakpoints().map(b => b.id), [3, 4]);
		await s.clearBreakpoint(3);
		assert.deepStrictEqual(s.breakpoints().map(b => b.id), [4]);
		await s.dispose({ resume: false });
	});

	test('a breakpoint with several locations counts every location, and is removed when they do not fit', async () => {
		const deleted: string[] = [];
		let n = 1;
		const s = await session(c => {
			if (c.startsWith('-break-delete')) {
				deleted.push(c);
				return undefined;
			}
			return c.startsWith('-break-insert') && c.includes('delay')
				? `TOKEN^done,bkpt={number="${n++}",addr="<MULTIPLE>",locations=[{number="1.1",addr="0x8000020"},{number="1.2",addr="0x8000060"},{number="1.3",addr="0x8000090"}]}`
				: c.startsWith('-break-insert') ? `TOKEN^done,bkpt={number="${n++}",addr="0x8000032"}` : undefined;
		}, 'stlink-bk2');
		const first = await s.setBreakpoint('delay');
		assert.deepStrictEqual([first.locations, first.address], [3, undefined]);
		await s.setBreakpoint('main');
		await assert.rejects(s.setBreakpoint('delay'), /has 3 code locations .* only 1 are free/);
		assert.deepStrictEqual([deleted, s.breakpoints().length], [['-break-delete 3'], 2]);
		await s.dispose({ resume: false });
	});

	test('decode_crash reads the frame at the handler\'s frame address (a handler that pushed r7), not at MSP', async () => {
		const read: string[] = [];
		const regs = '{number="13",value="0x20004fcc"},{number="14",value="0xfffffff9"},{number="15",value="0x800007c"},{number="25",value="0x21000003"},{number="91",value="0x20004fcc"},{number="92",value="0x0"}';
		const s = await session(c => {
			if (c.startsWith('-data-read-memory-bytes')) {
				read.push(c);
				const [, address, length] = c.split(' ');
				const contents = address === '0xE000ED24' ? '00000000008200000000004000000000000000600000006000000000'
					: address === '0x20004FD0' ? '400d030004000020ffffffff00000060f5fda7df8d0000084800000800000021' : '00'.repeat(Number(length));
				return `TOKEN^done,memory=[{begin="${address}",offset="0x0",end="0x0",contents="${contents}"}]`;
			}
			if (c === '-data-list-register-names') {
				return `TOKEN^done,register-names=[${Array.from({ length: 97 }, (_, k) => `"${({ 13: 'sp', 14: 'lr', 15: 'pc', 25: 'xpsr', 91: 'msp', 92: 'psp' } as Record<number, string>)[k] ?? ''}"`).join(',')}]`;
			}
			if (c.startsWith('-data-list-register-values')) {
				return `TOKEN^done,register-values=[${regs}]`;
			}
			if (c === '-interpreter-exec console "info frame"') {
				return '~"Stack level 0, frame at 0x20004fd0:\\n"\nTOKEN^done';
			}
			if (c.startsWith('-interpreter-exec console "info line')) {
				return '~"Line 57 of \\"Src/main.c\\" starts at address 0x8000044 <read_sensor_bus> and ends at 0x800004a <read_sensor_bus+6>.\\n"\nTOKEN^done';
			}
			return c.startsWith('-stack-list-frames') ? 'TOKEN^done,stack=[]' : undefined;
		}, 'stlink-o0');
		const crash = await s.decodeCrash();
		assert.ok(read.includes('-data-read-memory-bytes 0x20004FD0 32'), read.join('; '));
		assert.deepStrictEqual([crash.stackedFrame?.pc, crash.stackedFrame?.lr, crash.faultingCode?.function], ['0x08000048', '0x0800008D', 'read_sensor_bus']);
		assert.doesNotMatch(crash.summary, /Thumb bit/);
		await s.dispose({ resume: false });
	});
});

suite('OpenOCD server start-up', () => {

	test('a missing probe is reported in plain words, and nothing is left running', async () => {
		const host = new FakeHost();
		let openocd: ReturnType<typeof fakeOpenOcd> | undefined;
		host.onSpawn = (_c, _a, options) => openocd = fakeOpenOcd(options, ['Info : Listening on port 6666 for tcl connections', 'Error: open failed'], 1);
		await assert.rejects(OpenOcdServer.start(host, { program: '/x/openocd', scriptsDir: '/x/scripts', interfaceScript: 'interface/stlink.cfg', targetScript: 'target/stm32f1x.cfg' }),
			/OpenOCD stopped before it was ready \(exit 1\)\. No debug probe found: .* OpenOCD said: Error: open failed/);
		assert.strictEqual((await openocd!.exited).exitCode, 1);
	});

	test('script names cannot leave the scripts folder; a timeout kills OpenOCD', async () => {
		const host = new FakeHost();
		let openocd: ReturnType<typeof fakeOpenOcd> | undefined;
		host.onSpawn = (_c, _a, options) => openocd = fakeOpenOcd(options, ['Info : clock speed 950 kHz']);
		for (const bad of ['../../etc/x.cfg', '/abs/x.cfg', 'interface/stlink.tcl', 'interface/../x.cfg', '-c shutdown.cfg']) {
			await assert.rejects(OpenOcdServer.start(host, { program: '/x/openocd', scriptsDir: '/x/s', interfaceScript: bad, targetScript: 'target/stm32f1x.cfg' }), /not an OpenOCD script name/, bad);
		}
		assert.strictEqual(host.spawned.length, 0);
		await assert.rejects(OpenOcdServer.start(host, { program: '/x/openocd', scriptsDir: '/x/s', interfaceScript: 'interface/stlink.cfg', targetScript: 'target/stm32f1x.cfg', timeoutMs: 50 }), /not ready within 50 ms/);
		assert.strictEqual((await openocd!.exited).exitCode, null);
	});
});
