/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  @hw — the P2b gate on a real ESP32 DevKit without a JTAG probe: everything over the
 *  USB-serial bridge (ESP-IDF's GDB stub, panic logs, core dumps). Opt-in with FWAGENT_HW=1
 *  because it REFLASHES the board, and it needs ESP-IDF in the environment (". $IDF_PATH/export.sh"),
 *  which builds the fixture and provides esptool and the chip's GDB. The port is
 *  $FWAGENT_ESP32_PORT, or the only serial port found. The model is scripted; the rest is real.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { execFileSync } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NodeAgentHost } from '../adapters/node/nodeAgentHost';
import { createFirmwareDebugAgent } from '../agents/debug/debugAgent';
import { ApprovalRequest } from '../kernel/host';
import { callTool, say, ScriptedFakeLlm } from '../llm/scriptedFakeLlm';
import { writeEsp32DebugFixture } from './firmwareFixtures';

function resultOf(llm: ScriptedFakeLlm, callId: string): Record<string, unknown> & { error?: string } {
	for (const request of [...llm.requests].reverse()) {
		const m = request.messages.find(x => x.role === 'tool' && x.toolCallId === callId);
		if (m && m.role === 'tool') {
			return JSON.parse(m.content);
		}
	}
	throw new Error(`no result for ${callId}`);
}

suite('@hw FirmwareDebugAgent on an ESP32 DevKit over its USB-serial port (P2b gate)', function () {

	this.timeout(900_000);
	let root: string;
	let port: string;

	suiteSetup(async function () {
		if (process.env.FWAGENT_HW !== '1' || !process.env.IDF_PATH) {
			this.skip();
		}
		const host = new NodeAgentHost({ root: os.tmpdir(), write: () => { } });
		const ports = await host.serial!.list();
		const wanted = process.env.FWAGENT_ESP32_PORT;
		const found = wanted ? await host.serial!.resolve(wanted) : ports.length === 1 ? ports[0].device : undefined;
		if (!found) {
			this.skip();
		}
		port = found!;
		root = await fs.mkdtemp(path.join(os.tmpdir(), 'fwagents-esp32-hw-'));
		await writeEsp32DebugFixture(path.join(root, 'fw'));
	});

	suiteTeardown(async () => {
		if (root) {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	/** Builds one configuration with idf.py and flashes it (the test's own setup, not an agent action). */
	function buildAndFlash(config: 'gdbstub' | 'coredump'): void {
		const fw = path.join(root, 'fw');
		const args = ['-B', `build-${config}`, `-DSDKCONFIG=build-${config}/sdkconfig`, `-DSDKCONFIG_DEFAULTS=sdkconfig.defaults;sdkconfig.${config}`];
		execFileSync('idf.py', [...args, 'build'], { cwd: fw, stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 });
		execFileSync('idf.py', [...args, '-p', port, '-b', '460800', 'flash'], { cwd: fw, stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 });
	}

	function host(approvals: ApprovalRequest[]): NodeAgentHost {
		return new NodeAgentHost({ root, approve: async r => { approvals.push(r); return true; }, write: () => { } });
	}

	test('live over the GDB stub: tasks, breakpoint, watchpoint, memory write, seeded NULL-pointer crash decoded', async () => {
		buildAndFlash('gdbstub');
		const approvals: ApprovalRequest[] = [];
		const elf = 'fw/build-gdbstub/esp32_debug.elf';
		const llm = new ScriptedFakeLlm([
			callTool('chk', 'check_debug_tools', { part: 'esp32', transport: 'serial' }),
			callTool('start', 'start_session', { part: 'esp32', transport: 'serial', port, elf }),
			callTool('threads', 'threads', {}),
			callTool('bp', 'set_breakpoint', { location: 'toggle_led' }),
			callTool('run', 'resume', { waitMs: 5000 }),
			callTool('ev', 'evaluate', { expressions: ['sensor.id', 'sensor.reading == (counter & 0xFF)'] }),
			callTool('clr', 'clear_breakpoint', { id: 1 }),
			callTool('wp', 'set_watchpoint', { expression: 'counter', access: 'w' }),
			callTool('hit', 'resume', { waitMs: 5000 }),
			callTool('clr2', 'clear_breakpoint', { id: 2 }),
			callTool('seed', 'write_memory', { address: '&fault_trigger', bytes: '01000000' }),
			callTool('crash', 'resume', { waitMs: 10000 }),
			callTool('dec', 'decode_crash', {}),
			callTool('end', 'end_session', {}),
			say('done'),
		]);
		const agent = createFirmwareDebugAgent({ llm, host: host(approvals) });
		await agent.run('debug the ESP32');
		await agent.dispose();

		assert.strictEqual(resultOf(llm, 'chk').ok, true, JSON.stringify(resultOf(llm, 'chk')));
		const start = resultOf(llm, 'start');
		assert.deepStrictEqual([start.live, start.hardwareBreakpoints, start.hardwareWatchpoints], [true, 2, 2], JSON.stringify(start));
		const names = (resultOf(llm, 'threads') as unknown as { name: string }[]).map(t => t.name);
		assert.ok(['main', 'IDLE0', 'IDLE1'].every(n => names.includes(n)), names.join(','));
		assert.strictEqual((resultOf(llm, 'run').at as { function: string }).function, 'toggle_led');
		assert.deepStrictEqual(resultOf(llm, 'ev'), [{ expression: 'sensor.id', value: '7' }, { expression: 'sensor.reading == (counter & 0xFF)', value: '1' }] as unknown);
		assert.strictEqual((resultOf(llm, 'hit').at as { reason: string } | undefined)?.reason, 'watchpoint-trigger', JSON.stringify([resultOf(llm, 'clr'), resultOf(llm, 'wp'), resultOf(llm, 'hit')]));
		const dec = resultOf(llm, 'dec') as { exception: string; faultAddress: { address: string }; faultingCode: { function: string }; thread: string };
		assert.deepStrictEqual([dec.exception, dec.faultAddress.address, dec.faultingCode.function, dec.thread], ['LoadProhibited', '0x00000000', 'read_sensor_bus', 'main'], JSON.stringify(dec));
		assert.deepStrictEqual(approvals.map(a => a.toolName), ['start_session', 'write_memory']);
	});

	test('panic log + core dump: NULL pointer, assert, stack overflow and task watchdog decoded from the UART', async () => {
		buildAndFlash('coredump');
		const elf = 'fw/build-coredump/esp32_debug.elf';
		const expected: Record<string, [string, string]> = { n: ['exception', 'read_sensor_bus'], a: ['assert', 'check_reading'], s: ['stack-overflow', ''], w: ['task-watchdog', 'run_seeded_bug'] };
		for (const [bug, [kind, fn]] of Object.entries(expected)) {
			const approvals: ApprovalRequest[] = [];
			const llm = new ScriptedFakeLlm([
				callTool('boot', 'reset_and_capture', { port, durationMs: 4000 }),
				callTool('send', 'send_serial', { port, text: bug, durationMs: 20000 }),
				callTool('panic', 'decode_panic', { elf, part: 'esp32' }),
				callTool('start', 'start_session', { part: 'esp32', transport: 'coredump', elf }),
				callTool('dec', 'decode_crash', {}),
				callTool('end', 'end_session', {}),
				say('done'),
			]);
			const agent = createFirmwareDebugAgent({ llm, host: host(approvals) });
			await agent.run(`seeded bug ${bug}`);
			await agent.dispose();
			const boot = resultOf(llm, 'boot') as { reset: { ok: boolean }; boots?: string[] };
			assert.deepStrictEqual([boot.reset.ok, (boot.boots ?? []).length > 0], [true, true], JSON.stringify(boot));
			const panic = resultOf(llm, 'panic') as { kind: string; elf?: string; firstApplicationFrame?: { function: string } };
			assert.strictEqual(panic.kind, kind, JSON.stringify(panic));
			// The ELF is the one that runs: decode_panic confirms it from the log's SHA-256.
			assert.match(panic.elf ?? '', /SHA-256 matches/, JSON.stringify(panic));
			if (fn) {
				assert.strictEqual(panic.firstApplicationFrame?.function, fn, JSON.stringify(panic));
			}
			const start = resultOf(llm, 'start') as { live: boolean; warning?: string; coreDump: { checksum: string } };
			assert.deepStrictEqual([start.live, start.warning, start.coreDump.checksum], [false, undefined, 'sha256 ok'], JSON.stringify(start));
			const dec = resultOf(llm, 'dec') as { faulted: boolean; applicationFrame?: { function: string } };
			assert.strictEqual(dec.faulted, true, JSON.stringify(dec));
			assert.deepStrictEqual(approvals.map(a => a.toolName), ['reset_and_capture', 'send_serial', 'start_session']);
		}
	});
});
