/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describeById, NodeSerialPorts, SERIAL_DEVICE_PATTERN } from '../adapters/node/nodeSerialPort';
import { captureSerial, ESP_CRASH_END } from '../embedded/serial/serialPort';
import { toDisposable } from '../kernel/disposable';
import { ExecResult, ISerialConnection } from '../kernel/host';
import { FakeSystemProbe } from './fakeHost';

/** A connection whose output the test pushes; records what was written. */
function fakeConnection(): { connection: ISerialConnection; push: (text: string) => void; written: string[] } {
	const listeners = new Set<(text: string) => void>();
	const written: string[] = [];
	return {
		written,
		push: text => [...listeners].forEach(l => l(text)),
		connection: {
			device: '/dev/ttyUSB0',
			onData: l => {
				listeners.add(l);
				return toDisposable(() => listeners.delete(l));
			},
			write: async text => void written.push(text),
			close: async () => { },
		},
	};
}

suite('Serial capture', () => {

	test('stops shortly after the end of a crash report, keeping the trailing lines', async () => {
		const { connection, push } = fakeConnection();
		const done = captureSerial(connection, { durationMs: 10_000, until: ESP_CRASH_END });
		push('boot\nGuru Meditation Error: Core  0 panic\'ed (LoadProhibited).\n');
		push('ELF file SHA256: 59a068287\nCPU ha');
		push('lted.\n');
		setTimeout(() => push('late line\n'), 50);
		const started = Date.now();
		const r = await done;
		assert.ok(Date.now() - started < 2000);
		assert.deepStrictEqual([r.stoppedBy, r.text.endsWith('late line\n'), r.dropped], ['pattern', true, 0]);
	});

	test('keeps only the newest output past the cap; times out; can be cancelled; sends once', async () => {
		const a = fakeConnection();
		const capped = captureSerial(a.connection, { durationMs: 50, maxChars: 10, send: 'n' });
		a.push('0123456789abcdef');
		const r = await capped;
		assert.deepStrictEqual([r.text, r.chars, r.dropped, r.stoppedBy, a.written], ['6789abcdef', 16, 6, 'timeout', ['n']]);

		const b = fakeConnection();
		const cancel = new AbortController();
		const cancelled = captureSerial(b.connection, { durationMs: 10_000, signal: cancel.signal });
		b.push('x');
		cancel.abort();
		assert.deepStrictEqual([(await cancelled).stoppedBy, (await cancelled).text], ['cancelled', 'x']);
	});
});

suite('NodeSerialPorts (no hardware)', () => {

	let dir: string;

	setup(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fwagents-serial-'));
	});

	teardown(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	function ports(exec: (command: string, args: readonly string[]) => Partial<ExecResult> = () => ({ exitCode: 0 })) {
		const system = new FakeSystemProbe();
		const calls: string[][] = [];
		return {
			calls, system, serial: new NodeSerialPorts({
				system,
				exec: async (command, args) => {
					calls.push([command, ...args]);
					return { exitCode: 0, stdout: '', stderr: '', timedOut: false, cancelled: false, truncated: false, ...exec(command, args) };
				},
				platform: 'linux',
				byIdDir: path.join(dir, 'by-id'),
				devDir: dir,
			}),
		};
	}

	test('by-id names describe the bridge; only serial device names are accepted', () => {
		assert.deepStrictEqual([
			describeById('usb-Silicon_Labs_CP2102_USB_to_UART_Bridge_Controller_0001-if00-port0'),
			describeById('usb-1a86_USB_Serial-if00-port0'),
			describeById('pci-0000:00:14.0'),
		], ['Silicon Labs CP2102 USB to UART Bridge Controller', '1a86 USB Serial', undefined]);
		assert.deepStrictEqual(['/dev/ttyUSB0', '/dev/ttyACM12', '/dev/cu.usbserial-0001', '/dev/ttyS0', '/dev/sda', '/dev/null', '/dev/ttyUSB0/../sda', '/dev/tty'].map(p => SERIAL_DEVICE_PATTERN.test(p)),
			[true, true, true, true, false, false, false, false]);
	});

	test('anything that is not a real serial device is refused, also through links; listing skips it', async () => {
		const { serial } = ports();
		await fs.mkdir(path.join(dir, 'by-id'));
		await fs.writeFile(path.join(dir, 'ttyUSB9'), 'not a device');
		await fs.symlink('/dev/null', path.join(dir, 'by-id', 'usb-Evil_Link-if00-port0'));
		await assert.rejects(serial.resolve('/etc/passwd'), /not a serial device/);
		await assert.rejects(serial.resolve('/dev/null'), /not a serial device the agents may open/);
		await assert.rejects(serial.resolve('relative/ttyUSB0'), /not a serial device/);
		await assert.rejects(serial.resolve('/dev/ttyUSB-nonexistent-99'), /does not exist/);
		assert.deepStrictEqual(await serial.list(), []);
	});

	test('opening needs the system stty; its errors are explained (permission, busy)', async () => {
		const { serial, system } = ports(() => ({ exitCode: 1, stderr: 'stty: /dev/ttyUSB0: Permission denied' }));
		// The port must exist for these checks; without hardware only the stty lookup is reachable.
		const device = (await fs.readdir('/dev').catch(() => [] as string[])).map(n => `/dev/${n}`).find(p => /^\/dev\/tty(?:USB|ACM)\d+$/.test(p));
		if (!device) {
			await assert.rejects(serial.open('/dev/ttyUSB0', { baud: 115200 }), /does not exist|not a serial/);
			return;
		}
		await assert.rejects(serial.open(device, { baud: 115200 }), /stty was not found/);
		system.programs.set('stty', { path: '/usr/bin/stty' });
		await assert.rejects(serial.open(device, { baud: 1234 }), /Unsupported baud/);
		await assert.rejects(serial.open(device, { baud: 115200 }), /No permission .*dialout/);
	});
});

suite('Node adapters: review regressions', () => {

	test('esptool is not run when the workspace configures it (it could change the reset sequence)', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fwagents-esptool-'));
		try {
			await fs.writeFile(path.join(root, 'setup.cfg'), '[metadata]\nname = x\n\n[esptool]\ncustom_reset_sequence = R0|D1\n');
			const system = new FakeSystemProbe();
			system.programs.set('esptool', { path: '/usr/bin/esptool' });
			const calls: string[] = [];
			const serial = new NodeSerialPorts({ system, workspaceRoot: root, exec: async c => { calls.push(c); return { exitCode: 0, stdout: '', stderr: '', timedOut: false, cancelled: false, truncated: false }; } });
			const r = await serial.resetEsp32('/dev/ttyUSB0');
			assert.deepStrictEqual([r.ok, /setup\.cfg configures esptool/.test(r.detail), calls], [false, true, []]);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('the streamed SHA-256 of a workspace file matches, with no size cap', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fwagents-sha-'));
		try {
			const data = Buffer.alloc(9 * 1024 * 1024, 7);
			await fs.writeFile(path.join(root, 'big.elf'), data);
			const { NodeFileSystem } = await import('../adapters/node/nodeFileSystem');
			const { createHash } = await import('crypto');
			assert.strictEqual(await new NodeFileSystem(root).sha256('big.elf'), createHash('sha256').update(data).digest('hex'));
			await assert.rejects(new NodeFileSystem(root).sha256('../outside.elf'), /outside the workspace/);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});

suite('Serial capture: review regressions', () => {

	test('a 6 MB stream in small chunks is captured in linear time and capped from the front', async () => {
		const { connection, push } = fakeConnection();
		const done = captureSerial(connection, { durationMs: 60_000, maxChars: 6 * 1024 * 1024, until: ESP_CRASH_END });
		const chunk = 'x'.repeat(255) + '\n';
		const t0 = Date.now();
		for (let k = 0; k < 30_000; k++) {
			push(chunk);
		}
		push('CPU halted.\n');
		assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
		const r = await done;
		assert.deepStrictEqual([r.stoppedBy, r.text.length, r.dropped + r.text.length, r.text.endsWith('CPU halted.\n')], ['pattern', 6 * 1024 * 1024, 30_000 * 256 + 12, true]);
	});

	test('the end pattern is found across chunk boundaries', async () => {
		const { connection, push } = fakeConnection();
		const done = captureSerial(connection, { durationMs: 10_000, until: ESP_CRASH_END });
		for (const c of ['Enter', 'ing gdb ', 'stub now', '.\n']) {
			push(c);
		}
		assert.strictEqual((await done).stoppedBy, 'pattern');
	});
});
