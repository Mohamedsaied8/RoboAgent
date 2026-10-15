/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  @hw — the P2a debug gate on a real board: an ST-Link V2 wired to a Blue Pill (STM32F103C8T6).
 *  Opt-in with FWAGENT_HW=1 because it REFLASHES the board. Uses the user's tool store (as the
 *  product does) and installs the debug tools there if they are missing. The model is scripted;
 *  everything else is real: OpenOCD, GDB, the probe, the chip.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { execFileSync } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NodeAgentHost } from '../adapters/node/nodeAgentHost';
import { createDefaultToolStore } from '../adapters/node/nodeToolStore';
import { createFirmwareDebugAgent } from '../agents/debug/debugAgent';
import { OpenOcdFlasher } from '../embedded/flash/flashers';
import { DefaultTargetCatalog } from '../embedded/target';
import { ApprovalRequest } from '../kernel/host';
import { callTool, say, ScriptedFakeLlm } from '../llm/scriptedFakeLlm';
import { BLUEPILL_BUILD_ARGS, writeBluePillDebugFixture } from './firmwareFixtures';

function resultOf(llm: ScriptedFakeLlm, callId: string): Record<string, unknown> & { error?: string } {
	for (const request of [...llm.requests].reverse()) {
		const m = request.messages.find(x => x.role === 'tool' && x.toolCallId === callId);
		if (m && m.role === 'tool') {
			return JSON.parse(m.content);
		}
	}
	throw new Error(`no result for ${callId}`);
}

suite('@hw FirmwareDebugAgent on an STM32F103C8T6 Blue Pill over ST-Link V2 (P2a gate)', function () {

	this.timeout(300_000);
	let root: string;

	suiteSetup(function () {
		if (process.env.FWAGENT_HW !== '1') {
			this.skip();
		}
	});

	setup(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), 'fwagents-hw-'));
	});

	teardown(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	// -O0 (CubeIDE's Debug default) makes the HardFault handler push r7, which moves MSP off the exception frame.
	for (const optimization of ['-Og', '-O0']) {
	test(`${optimization}: attach, breakpoint, watch expressions, registers, memory, RCC/GPIO decode, watchpoint, seeded HardFault`, async () => {
		const fw = path.join(root, 'fw');
		await writeBluePillDebugFixture(fw);
		const approvals: ApprovalRequest[] = [];
		const host = new NodeAgentHost({ root, toolStore: createDefaultToolStore(), approve: async r => { approvals.push(r); return true; }, write: () => { } });
		const target = new DefaultTargetCatalog().resolve('STM32F103C8T6')!;

		// Tools first (a no-op when they are installed), then build and flash with the Dev agent's flasher.
		const llm = new ScriptedFakeLlm([
			callTool('ensure', 'ensure_debug_tools', { part: 'STM32F103C8T6' }),
			say('ready'),
		]);
		const setup = createFirmwareDebugAgent({ llm, host });
		await setup.run('set up');
		assert.strictEqual(resultOf(llm, 'ensure').ok, true, JSON.stringify(resultOf(llm, 'ensure')));
		const gcc = await host.exec('arm-none-eabi-gcc', BLUEPILL_BUILD_ARGS.map(a => a === '-Og' ? optimization : a), { cwd: 'fw' });
		assert.strictEqual(gcc.exitCode, 0, gcc.stderr);
		const flashed = await new OpenOcdFlasher(target.openocdConfig!).flash(host, { dir: 'fw', buildSystem: 'make', target, rtos: 'none', evidence: [] }, 'fw/bluepill.elf', {});
		assert.ok(flashed.ok && flashed.verified, flashed.problem ?? flashed.outputTail);
		const symbol = (name: string) => execFileSync('arm-none-eabi-nm', [path.join(fw, 'bluepill.elf')], { encoding: 'utf8' }).split('\n').find(l => l.endsWith(` ${name}`))!.split(' ')[0];

		const debug = new ScriptedFakeLlm([
			callTool('start', 'start_session', { part: 'STM32F103C8T6', dir: 'fw', elf: 'fw/bluepill.elf' }),
			callTool('bp', 'set_breakpoint', { location: 'toggle_led' }),
			callTool('run', 'resume', { waitMs: 5000 }),
			callTool('watch', 'evaluate', { expressions: ['counter', 'sensor', 'sensor.reading == (counter & 0xFF)', 'counter = 0'] }),
			callTool('regs', 'read_core_registers', {}),
			callTool('mem', 'read_memory', { address: '&sensor', length: 4, format: 'hex' }),
			callTool('rcc', 'read_peripheral', { name: 'RCC', register: 'APB2ENR' }),
			callTool('gpioc', 'read_peripheral', { name: 'GPIOC', register: 'CRH' }),
			callTool('gpioa', 'read_peripheral', { name: 'GPIOA' }),
			callTool('clr', 'clear_breakpoint', { id: 1 }),
			callTool('wp', 'set_watchpoint', { expression: 'counter', access: 'w' }),
			callTool('hit', 'resume', { waitMs: 5000 }),
			callTool('clr2', 'clear_breakpoint', { id: 2 }),
			callTool('seed', 'write_memory', { address: '&fault_trigger', bytes: '01000000' }),
			callTool('crashrun', 'resume', { waitMs: 1000 }),
			callTool('halt', 'halt', {}),
			callTool('crash', 'decode_crash', {}),
			callTool('report', 'report_findings', { rootCause: 'read_sensor_bus reads 0x60000000, where the C8 has no memory (precise BusFault escalated to HardFault).', confidence: 'high', evidence: [{ kind: 'crash', summary: 'CFSR.PRECISERR, BFAR = 0x60000000' }] }),
			callTool('end', 'end_session', { resume: true }),
			say('done'),
		]);
		const agent = createFirmwareDebugAgent({ llm: debug, host });
		const { findings } = await agent.investigate({ type: 'investigation-request', bugId: 'HW-1', symptom: 'board stops blinking when fault_trigger is set' }, { dir: 'fw' });
		await agent.dispose();

		const start = resultOf(debug, 'start');
		assert.deepStrictEqual([start.target, start.core, start.hardwareBreakpoints, start.hardwareWatchpoints, start.symbols], ['STM32F103C8T6', 'Cortex-M3 r1p1', 6, 4, 'fw/bluepill.elf'], JSON.stringify(start));
		assert.ok(Number(start.targetVoltage) > 2.9, `target voltage ${start.targetVoltage}`);
		assert.deepStrictEqual((resultOf(debug, 'run').at as { function: string }).function, 'toggle_led');

		const watch = resultOf(debug, 'watch') as unknown as { expression: string; value?: string; error?: string }[];
		assert.match(watch[0].value!, /^\d+$/);
		assert.match(watch[1].value!, /^\{id = 7, reading = -?\d+\}$/);
		assert.strictEqual(watch[2].value, '1');
		assert.match(watch[3].error!, /must not change the target/);
		// GDB places a function breakpoint after the prologue (at -O0 that is past the symbol address).
		const bpAddress = (resultOf(debug, 'bp') as { address: string }).address;
		assert.strictEqual(Number((resultOf(debug, 'regs') as { pc: string }).pc), Number(bpAddress));
		assert.ok(Number(bpAddress) >= Number(`0x${symbol('toggle_led')}`) && Number(bpAddress) < Number(`0x${symbol('toggle_led')}`) + 16);
		assert.match((resultOf(debug, 'mem').dump as string[])[0], /^0x20000000: 07 00 /);

		const fields = (id: string) => ((resultOf(debug, id).registers as { fields: Record<string, number> }[])[0]).fields;
		assert.strictEqual(fields('rcc').IOPCEN, 1);
		assert.deepStrictEqual([fields('gpioc').MODE13, fields('gpioc').CNF13], [2, 0]);
		const gpioa = resultOf(debug, 'gpioa') as { registers: { name: string }[]; notRead: { name: string }[] };
		assert.deepStrictEqual([gpioa.registers.map(r => r.name), gpioa.notRead.map(r => r.name)], [['CRL', 'CRH', 'IDR', 'ODR', 'LCKR'], ['BSRR', 'BRR']]);

		assert.match(JSON.stringify(resultOf(debug, 'hit')), /watchpoint-trigger/);
		assert.deepStrictEqual(resultOf(debug, 'seed'), { written: 4, address: '0x20000008', readBack: '01000000' });
		assert.strictEqual((resultOf(debug, 'halt') as { function: string }).function, 'HardFault_Handler');
		const crash = resultOf(debug, 'crash') as { flags: { flag: string }[]; faultAddress: unknown; faultingCode: { function: string }; caller: { function: string } };
		assert.deepStrictEqual([crash.flags.map(f => f.flag), crash.faultAddress, crash.faultingCode.function, crash.caller.function], [['FORCED', 'PRECISERR', 'BFARVALID'], { register: 'BFAR', address: '0x60000000' }, 'read_sensor_bus', 'main']);
		assert.deepStrictEqual([findings.bugId, findings.confidence], ['HW-1', 'high']);
		// Approvals: attach and the one memory write (installs are auto-approved by policy, not asked).
		assert.deepStrictEqual(approvals.map(a => a.toolName), ['start_session', 'write_memory']);
	});
}
});
