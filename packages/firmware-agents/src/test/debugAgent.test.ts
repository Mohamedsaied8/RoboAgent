/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { createFirmwareDebugAgent } from '../agents/debug/debugAgent';
import { SessionFactory } from '../agents/debug/debugTools';
import { CrashDecode, DebugSessionError, ITargetSession } from '../embedded/debug/targetSession';
import { DecodedPeripheral } from '../embedded/svd/peripheralDecoder';
import { callTool, say, ScriptedFakeLlm } from '../llm/scriptedFakeLlm';
import { FakeHost, FakeSystemProbe } from './fakeHost';

/** An in-memory target: 256 bytes of RAM at 0x20000000, a decoded RCC, a canned crash. */
class FakeSession implements ITargetSession {
	readonly target = { vendor: 'stm32', part: 'STM32F103C8T6', family: 'F1', arch: 'cortex-m', toolchainPrefix: 'arm-none-eabi-', exact: true } as const;
	readonly server = { port: 1234, probe: 'STLINK V2J48S7', core: 'Cortex-M3 r1p1', targetVoltage: 3.28 };
	readonly budget = { breakpoints: 6, watchpoints: 4 };
	readonly hasSymbols = true;
	state: 'stopped' | 'running' = 'stopped';
	readonly ram = new Uint8Array(256);
	readonly calls: string[] = [];
	disposed: { resume?: boolean } | undefined;
	/** False: behave as if no SVD could be loaded. */
	svdLoaded = true;
	private moving = 0x20000040;
	private snapshot: DecodedPeripheral | undefined;
	get lastStop() { return { function: 'main', line: 12 }; }
	async halt() { this.state = 'stopped'; return { function: 'main' }; }
	async resume(waitMs?: number) { this.calls.push(`resume ${waitMs}`); return waitMs ? { reason: 'breakpoint-hit', function: 'uart_init', breakpoint: 1 } : (this.state = 'running', undefined); }
	async step() { return { function: 'main', line: 13 }; }
	async reset() { this.calls.push('reset'); return { reason: 'reset', pc: '0x80000a4' }; }
	async setBreakpoint(location: string) { this.calls.push(`bp ${location}`); return { id: 1, kind: 'breakpoint' as const, location }; }
	async setWatchpoint(expression: string, access: 'r' | 'w' | 'rw') { return { id: 2, kind: 'watchpoint' as const, location: expression, access }; }
	async clearBreakpoint() { }
	breakpoints() { return []; }
	async readMemory(address: number, length: number) {
		if (this.state === 'running') {
			throw new DebugSessionError('The target is running; halt it before reading memory.');
		}
		return this.ram.slice(address - 0x20000000, address - 0x20000000 + length);
	}
	async writeMemory(address: number, data: Uint8Array) { this.calls.push(`write ${address.toString(16)}`); this.ram.set(data, address - 0x20000000); }
	async readCoreRegisters() { return { pc: '0x8000032', sp: '0x20004ff0' }; }
	async evaluate(expression: string) {
		if (expression.includes('=') && !expression.includes('==')) {
			throw new DebugSessionError('Expressions must not change the target');
		}
		if (expression === '(unsigned long)(&moving)') {
			return String(this.moving += 4); // a pointer that changes between two evaluations
		}
		return expression === '(unsigned long)(&rx_count)' ? '536870928' : expression === 'rx_count' ? '0' : `<${expression}>`;
	}
	async backtrace() { return [{ level: 0, address: '0x08000032', function: 'uart_init' }]; }
	async locals() { return []; }
	async peripherals() { return [{ name: 'RCC', baseAddress: '0x40021000' }, { name: 'USART2', baseAddress: '0x40004400' }]; }
	async readPeripheral(name: string): Promise<DecodedPeripheral> {
		const usart2en = this.snapshot ? 1 : 0;
		this.snapshot = { name, baseAddress: '0x40021000', registers: [{ name: 'APB1ENR', address: '0x4002101C', value: `0x000${usart2en ? '2' : '0'}0000`, fields: [{ name: 'USART2EN', bits: '[17]', value: usart2en }] }], skipped: [] };
		return this.snapshot;
	}
	lastSnapshot() { return this.snapshot; }
	async registersIn(address: number, length: number) {
		if (!this.svdLoaded) {
			return undefined;
		}
		const known = [{ name: 'USART2.DR', at: 0x40004404, unreadable: 'data register: reading it can pop a receive FIFO or clear status flags' }, { name: 'RCC.APB1ENR', at: 0x4002101C }, { name: 'FLASH.KEYR', at: 0x50001004 }];
		return known.filter(r => r.at < address + length && r.at + 4 > address).map(r => ({ name: r.name, address: `0x${r.at.toString(16)}`, ...r.unreadable ? { unreadable: r.unreadable } : {} }));
	}
	async decodeCrash(): Promise<CrashDecode> { return { arch: 'cortex-m', currentException: 'Thread mode', inFaultHandler: false, faulted: false, flags: [], raw: {}, summary: 'No fault', backtrace: [] }; }
	async dispose(options: { resume?: boolean } = {}) { this.disposed = options; }
}

function debugHost(approve = true): FakeHost {
	const host = new FakeHost(approve);
	host.system = new FakeSystemProbe();
	host.system.programs.set('openocd', { path: '/usr/bin/openocd' });
	host.system.programs.set('arm-none-eabi-gdb', { path: '/usr/bin/arm-none-eabi-gdb' });
	host.system.trustedDirs.add('/usr/share/openocd/scripts');
	host.onExec = command => command === 'openocd' ? { stderr: 'Open On-Chip Debugger 0.12.0' } : command === 'arm-none-eabi-gdb' ? { stdout: 'GNU gdb 13.1' } : undefined;
	host.fs.files.set('fw/build/app.elf', '\x7fELF');
	host.fs.files.set('fw/Src/uart.c', 'void uart_init(void) { /* RCC->APB1ENR |= RCC_APB1ENR_USART2EN; */ }\n');
	return host;
}

function resultOf(llm: ScriptedFakeLlm, callId: string): { error?: string } & Record<string, unknown> {
	for (const request of [...llm.requests].reverse()) {
		const m = request.messages.find(x => x.role === 'tool' && x.toolCallId === callId);
		if (m && m.role === 'tool') {
			return JSON.parse(m.content);
		}
	}
	throw new Error(`no result for ${callId}`);
}

suite('FirmwareDebugAgent', () => {

	test('investigates with a session, asks only for hardware-changing tools, and returns the findings it recorded', async () => {
		const host = debugHost();
		const session = new FakeSession();
		let started: Parameters<SessionFactory>[1] | undefined;
		const llm = new ScriptedFakeLlm([
			callTool('s', 'start_session', { part: 'STM32F103C8T6', dir: 'fw' }),
			callTool('b', 'set_breakpoint', { location: 'uart_init' }),
			callTool('r', 'resume', { waitMs: 2000 }),
			callTool('p1', 'read_peripheral', { name: 'RCC', register: 'APB1ENR' }),
			callTool('src', 'read_file', { path: 'fw/Src/uart.c' }),
			callTool('e', 'evaluate', { expressions: ['rx_count', 'rx_count = 1'] }),
			callTool('w', 'write_memory', { address: '&rx_count', bytes: '05000000' }),
			callTool('m', 'read_memory', { address: '&rx_count', length: 4, format: 'words' }),
			callTool('p2', 'compare_peripheral', { name: 'RCC' }),
			callTool('f', 'report_findings', {
				rootCause: 'uart_init never enables the USART2 clock.', confidence: 'high',
				evidence: [{ kind: 'peripheral', summary: 'RCC.APB1ENR.USART2EN = 0 (expected 1)' }],
				suggestedFix: 'Set RCC_APB1ENR_USART2EN in uart_init (fw/Src/uart.c).',
			}),
			callTool('x', 'end_session', {}),
			say('USART2 clock is off.'),
		]);
		const agent = createFirmwareDebugAgent({ llm, host, startSession: async (_h, options) => { started = options; return session; } });
		const { findings, run } = await agent.investigate({ type: 'investigation-request', bugId: 'BUG-7', symptom: 'No UART output', hypotheses: ['USART2 not clocked'] }, { dir: 'fw' });

		assert.strictEqual(run.stopReason, 'done');
		assert.deepStrictEqual(findings, {
			type: 'debug-findings', bugId: 'BUG-7', confidence: 'high',
			evidence: [{ kind: 'peripheral', summary: 'RCC.APB1ENR.USART2EN = 0 (expected 1)' }],
			rootCause: 'uart_init never enables the USART2 clock.', suggestedFix: 'Set RCC_APB1ENR_USART2EN in uart_init (fw/Src/uart.c).',
		});
		// Only attaching and writing memory asked; reads, breakpoints and resume did not.
		assert.deepStrictEqual(host.approvals.map(a => [a.toolName, a.category]), [['start_session', 'hardware'], ['write_memory', 'hardware']]);
		assert.strictEqual(host.approvals[1].summary, 'Write 4 byte(s) (05000000) to target memory at &rx_count (0x20000010)');
		// The ELF was found under fw/build; OpenOCD's scripts folder came from the trusted-folder search.
		assert.deepStrictEqual([started?.elf, started?.gdb, started?.openocd.scriptsDir, started?.openocd.targetScript], ['fw/build/app.elf', '/usr/bin/arm-none-eabi-gdb', '/usr/share/openocd/scripts', 'target/stm32f1x.cfg']);
		assert.deepStrictEqual(resultOf(llm, 'p1'), { peripheral: 'RCC', baseAddress: '0x40021000', registers: [{ name: 'APB1ENR', address: '0x4002101C', value: '0x00000000', fields: { USART2EN: 0 } }] });
		assert.deepStrictEqual(resultOf(llm, 'e'), [{ expression: 'rx_count', value: '0' }, { expression: 'rx_count = 1', error: 'Expressions must not change the target' }] as unknown);
		assert.deepStrictEqual(resultOf(llm, 'w'), { written: 4, address: '0x20000010', readBack: '05000000' });
		assert.deepStrictEqual(resultOf(llm, 'm'), { address: '0x20000010', words: ['0x20000010: 0x00000005'] });
		assert.deepStrictEqual(resultOf(llm, 'p2'), { peripheral: 'RCC', changes: [{ register: 'APB1ENR', field: 'USART2EN', before: 0, after: 1 }], unchanged: false });
		assert.deepStrictEqual(session.disposed, { resume: true });
	});

	test('the Debug agent cannot write source files, and flash is out of reach of write_memory', async () => {
		const host = debugHost();
		const session = new FakeSession();
		const llm = new ScriptedFakeLlm([
			callTool('w', 'write_file', { path: 'fw/Src/uart.c', content: 'x' }),
			callTool('s', 'start_session', { part: 'STM32F103C8T6', dir: 'fw' }),
			callTool('fl', 'write_memory', { address: '0x08000000', bytes: '00' }),
			callTool('al', 'write_memory', { address: '0x00000100', bytes: '00' }),
			callTool('key', 'write_memory', { address: '0x40022004', bytes: '23016745' }),
			callTool('rdp', 'write_memory', { address: '0x40023C14', bytes: 'cc000000' }),
			callTool('ob', 'write_memory', { address: '0x1FFFF800', bytes: 'a55a' }),
			callTool('cross', 'write_memory', { address: '0x07FFFFFE', bytes: '00000000' }),
			callTool('svdflash', 'write_memory', { address: '0x50001004', bytes: '00000000' }),
			callTool('dr', 'read_memory', { address: '0x40004400', length: 16 }),
			callTool('bitband', 'write_memory', { address: '0x42440208', bytes: '01000000' }),
			callTool('secure', 'write_memory', { address: '0x50022010', bytes: '00000000' }),
			callTool('dbg', 'write_memory', { address: '0x40015804', bytes: '00000000' }),
			callTool('moved', 'write_memory', { address: '&moving', bytes: '01' }),
			callTool('bad', 'write_memory', { address: '0x20000000', bytes: '0' }),
			say('done'),
		]);
		const agent = createFirmwareDebugAgent({ llm, host, startSession: async () => session });
		await agent.run('try');
		assert.match(resultOf(llm, 'w').error!, /Unknown tool "write_file"/);
		assert.match(resultOf(llm, 'fl').error!, /touches flash/);
		assert.match(resultOf(llm, 'al').error!, /boot alias of flash/);
		assert.match(resultOf(llm, 'key').error!, /FLASH controller \(F0\/F1/);
		assert.match(resultOf(llm, 'rdp').error!, /FLASH controller \(F2\/F4/);
		assert.match(resultOf(llm, 'ob').error!, /option bytes/);
		assert.match(resultOf(llm, 'cross').error!, /0x07FFFFFE…0x08000001 touches flash/);
		assert.match(resultOf(llm, 'svdflash').error!, /touches FLASH\.KEYR \(flash\/debug control\)/);
		assert.match(resultOf(llm, 'dr').error!, /Not read: USART2\.DR \(data register/);
		assert.match(resultOf(llm, 'bitband').error!, /FLASH controller \(F0\/F1/);
		assert.match(resultOf(llm, 'secure').error!, /secure alias/);
		assert.match(resultOf(llm, 'dbg').error!, /DBGMCU \(debug configuration, F0\/G0/);
		assert.match(resultOf(llm, 'moved').error!, /"&moving" now resolves to 0x20000048, not 0x20000044 as approved/);
		assert.match(resultOf(llm, 'bad').error!, /even number of hex digits/);
		assert.deepStrictEqual(session.calls.filter(c => c.startsWith('write')), []);
		await agent.dispose();
		assert.deepStrictEqual(session.disposed, { resume: true });
	});

	test('a declined attach starts nothing; tools without a session say so; missing tools point to ensure_debug_tools', async () => {
		const host = debugHost(false);
		let starts = 0;
		const llm = new ScriptedFakeLlm([
			callTool('s', 'start_session', { part: 'STM32F103C8T6', dir: 'fw' }),
			callTool('h', 'halt', {}),
			say('stopped'),
		]);
		await createFirmwareDebugAgent({ llm, host, startSession: async () => { starts++; return new FakeSession(); } }).run('debug');
		assert.strictEqual(starts, 0);
		assert.match(resultOf(llm, 'h').error!, /No debug session: call start_session first/);

		const bare = debugHost();
		bare.system!.programs.clear();
		bare.onExec = () => ({ exitCode: null, spawnError: 'ENOENT' });
		const llm2 = new ScriptedFakeLlm([callTool('s', 'start_session', { part: 'STM32F103C8T6' }), say('x')]);
		await createFirmwareDebugAgent({ llm: llm2, host: bare, startSession: async () => new FakeSession() }).run('debug');
		assert.match(resultOf(llm2, 's').error!, /debug tools are not ready: .* Run ensure_debug_tools first/);
	});

	test('investigate() ends a session the model left open, and reports a low-confidence note without findings', async () => {
		const host = debugHost();
		const session = new FakeSession();
		const llm = new ScriptedFakeLlm([callTool('s', 'start_session', { part: 'STM32F103C8T6', dir: 'fw' }), say('I could not tell.')]);
		const agent = createFirmwareDebugAgent({ llm, host, startSession: async () => session });
		const { findings } = await agent.investigate({ type: 'investigation-request', bugId: 'B2', symptom: 'hangs' });
		assert.deepStrictEqual([session.disposed, agent.context.session, findings], [{ resume: true }, undefined, { type: 'debug-findings', bugId: 'B2', confidence: 'low', evidence: [{ kind: 'note', summary: 'I could not tell.' }] }]);
	});

	test('without an SVD, read_memory refuses peripheral space (including bit-band aliases) but reads RAM', async () => {
		const host = debugHost();
		const session = new FakeSession();
		session.svdLoaded = false;
		const llm = new ScriptedFakeLlm([
			callTool('s', 'start_session', { part: 'STM32F103C8T6', dir: 'fw' }),
			callTool('p', 'read_memory', { address: '0x40013800', length: 8 }),
			callTool('bb', 'read_memory', { address: '0x42270080', length: 4 }),
			callTool('ram', 'read_memory', { address: '0x20000000', length: 4 }),
			say('ok'),
		]);
		await createFirmwareDebugAgent({ llm, host, startSession: async () => session }).run('x');
		assert.match(resultOf(llm, 'p').error!, /peripheral space and no SVD is available/);
		assert.match(resultOf(llm, 'bb').error!, /peripheral space and no SVD is available/);
		assert.deepStrictEqual(resultOf(llm, 'ram'), { address: '0x20000000', dump: ['0x20000000: 00 00 00 00  ....'] });
	});

	test('a running target must be halted before reads; a second session is refused while one is open', async () => {
		const host = debugHost();
		const session = new FakeSession();
		const llm = new ScriptedFakeLlm([
			callTool('s', 'start_session', { part: 'STM32F103C8T6', dir: 'fw' }),
			callTool('s2', 'start_session', { part: 'STM32F103C8T6', dir: 'fw' }),
			callTool('r', 'resume', {}),
			callTool('m', 'read_memory', { address: '0x20000000', length: 4 }),
			say('ok'),
		]);
		await createFirmwareDebugAgent({ llm, host, startSession: async () => session }).run('x');
		assert.match(resultOf(llm, 's2').error!, /already running; call end_session first/);
		assert.deepStrictEqual(resultOf(llm, 'r'), { stopped: false, state: 'running', note: 'running' });
		assert.match(resultOf(llm, 'm').error!, /running; halt it before reading memory/);
	});
});
