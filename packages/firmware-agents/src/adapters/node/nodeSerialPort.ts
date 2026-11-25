/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { constants, open as fsOpen, promises as fs, write as fsWrite } from 'fs';
import * as path from 'path';
import * as tty from 'tty';
import { IDisposable, toDisposable } from '../../kernel/disposable';
import { ExecOptions, ExecResult, ISerialConnection, ISerialPorts, ISystemProbe, SerialPortInfo } from '../../kernel/host';

/** Serial device names the agents may open: USB-serial bridges, CDC-ACM, on-board UARTs, macOS call-out devices. */
export const SERIAL_DEVICE_PATTERN = /^\/dev\/(?:tty(?:USB|ACM|S|AMA|SAC)\d{1,3}|cu\.[\w.-]{1,64}|tty\.[\w.-]{1,64})$/;

const BAUDS = new Set([9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600]);

export interface NodeSerialPortsOptions {
	readonly system: ISystemProbe;
	/** Runs a program with the host's filtered environment (used for esptool resets). */
	readonly exec: (command: string, args: readonly string[], options?: ExecOptions) => Promise<ExecResult>;
	readonly platform?: NodeJS.Platform;
	/** Workspace root: esptool runs there, so a project esptool.cfg / setup.cfg / tox.ini is checked first. */
	readonly workspaceRoot?: string;
	/** Folder listing aliases (default `/dev/serial/by-id`) and the device folder (default `/dev`); for tests. */
	readonly byIdDir?: string;
	readonly devDir?: string;
}

/** `usb-Silicon_Labs_CP2102_USB_to_UART_Bridge_Controller_0001-if00-port0` → `Silicon Labs CP2102 USB to UART Bridge Controller`. */
export function describeById(name: string): string | undefined {
	const m = /^usb-(?<what>.+?)(?:_[0-9A-Fa-f]{4,})?(?:-if\d+)?(?:-port\d+)?$/.exec(name);
	return m ? m.groups!.what.replace(/_/g, ' ').trim() : undefined;
}

/** {@link ISerialPorts} for Linux and macOS, with no native module: `stty` configures, a tty stream reads. */
export class NodeSerialPorts implements ISerialPorts {
	private readonly platform: NodeJS.Platform;

	constructor(private readonly options: NodeSerialPortsOptions) {
		this.platform = options.platform ?? process.platform;
	}

	async list(): Promise<SerialPortInfo[]> {
		const out = new Map<string, SerialPortInfo>();
		const byId = this.options.byIdDir ?? '/dev/serial/by-id';
		for (const name of await fs.readdir(byId).catch(() => [] as string[])) {
			const alias = path.join(byId, name);
			const device = await this.resolve(alias).catch(() => undefined);
			if (device) {
				const description = describeById(name);
				out.set(device, { device, alias, ...description ? { description } : {} });
			}
		}
		const dev = this.options.devDir ?? '/dev';
		for (const name of await fs.readdir(dev).catch(() => [] as string[])) {
			const wanted = this.platform === 'darwin' ? /^cu\.(?:usbserial|usbmodem|SLAB_USBtoUART|wchusbserial)/ : /^tty(?:USB|ACM)\d+$/;
			if (!wanted.test(name)) {
				continue;
			}
			const device = await this.resolve(path.join(dev, name)).catch(() => undefined);
			if (device && !out.has(device)) {
				out.set(device, { device });
			}
		}
		return [...out.values()].sort((a, b) => a.device.localeCompare(b.device));
	}

	async resolve(p: string): Promise<string> {
		if (!path.isAbsolute(p) || !p.startsWith('/dev/')) {
			throw new Error(`"${p}" is not a serial device (expected /dev/ttyUSB0, /dev/ttyACM0, /dev/serial/by-id/…, /dev/cu.…).`);
		}
		const real = await fs.realpath(p).catch(() => undefined);
		if (!real) {
			throw new Error(`"${p}" does not exist (is the board plugged in?).`);
		}
		if (!SERIAL_DEVICE_PATTERN.test(real)) {
			throw new Error(`"${p}" (${real}) is not a serial device the agents may open.`);
		}
		const stat = await fs.stat(real);
		if (!stat.isCharacterDevice()) {
			throw new Error(`"${real}" is not a character device.`);
		}
		return real;
	}

	async open(device: string, options: { readonly baud: number }): Promise<ISerialConnection> {
		const real = await this.resolve(device);
		if (real !== device) {
			throw new Error(`Open the real device (${real}), not "${device}".`);
		}
		if (!BAUDS.has(options.baud)) {
			throw new Error(`Unsupported baud rate ${options.baud}.`);
		}
		// System stty only (never one from the tool store or the workspace).
		const stty = await this.options.system.findProgram('stty', { systemOnly: true });
		if (!stty) {
			throw new Error('stty was not found; it is needed to configure the serial port.');
		}
		const configured = await this.options.exec(stty, [this.platform === 'darwin' ? '-f' : '-F', real, String(options.baud), 'raw', '-echo', '-hupcl', 'clocal', 'cs8', '-cstopb', '-parenb', '-crtscts', '-ixon', '-ixoff'], { timeoutMs: 10_000 });
		if (configured.exitCode !== 0) {
			const why = `${configured.stderr}${configured.spawnError ?? ''}`.trim();
			throw new Error(/Permission denied/i.test(why)
				? `No permission to open ${real}: add the user to the serial group (dialout or uucp) and log in again (install_probe_access does this).`
				: /busy/i.test(why) ? `${real} is busy (another program, e.g. a serial monitor, holds it).` : `Could not configure ${real}: ${why}`);
		}
		let fd: number;
		try {
			// Non-blocking, and never the controlling terminal: the read stream polls it through libuv.
			// A raw descriptor (not a FileHandle, which would close it on garbage collection under the stream).
			fd = await new Promise<number>((resolve, reject) => fsOpen(real, constants.O_RDWR | constants.O_NOCTTY | constants.O_NONBLOCK, (err, opened) => err ? reject(err) : resolve(opened)));
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			throw new Error(code === 'EACCES' ? `No permission to open ${real}: add the user to the serial group (dialout or uucp) and log in again.` : code === 'EBUSY' ? `${real} is busy.` : `Could not open ${real}: ${(err as Error).message}`);
		}
		return new NodeSerialConnection(real, fd);
	}

	async resetEsp32(device: string, signal?: AbortSignal): Promise<{ ok: boolean; detail: string }> {
		// esptool reads an [esptool] section from esptool.cfg / setup.cfg / tox.ini in its working
		// folder (the workspace): a project could change the reset sequence (hold EN or IO0).
		for (const name of ['esptool.cfg', 'setup.cfg', 'tox.ini']) {
			const text = this.options.workspaceRoot ? await fs.readFile(path.join(this.options.workspaceRoot, name), 'utf8').catch(() => '') : '';
			if (/^\s*\[esptool\]/m.test(text)) {
				return { ok: false, detail: `The workspace's ${name} configures esptool ([esptool] section), which could change how the chip is reset; not running it. Press the board's EN/RST button instead.` };
			}
		}
		const real = await this.resolve(device);
		const esptool = await this.options.system.findProgram('esptool') ?? await this.options.system.findProgram('esptool.py');
		if (!esptool) {
			return { ok: false, detail: 'esptool was not found on PATH (it comes with ESP-IDF: run ". $IDF_PATH/export.sh"); press the board\'s EN/RST button instead.' };
		}
		// esptool v5 spellings first, then v4 (underscores). The chip enters the ROM bootloader,
		// answers, and is hard-reset into the application by the RTS line.
		let last: ExecResult | undefined;
		for (const args of [['--before', 'default-reset', '--after', 'hard-reset', 'chip-id'], ['--before', 'default_reset', '--after', 'hard_reset', 'chip_id']]) {
			last = await this.options.exec(esptool, ['--port', real, ...args], { timeoutMs: 30_000, ...signal ? { signal } : {} });
			if (last.exitCode === 0) {
				return { ok: true, detail: `reset through ${path.basename(esptool)} (RTS/DTR)` };
			}
			if (!/invalid choice|unrecognized arguments|No such option/i.test(`${last.stderr}${last.stdout}`)) {
				break;
			}
		}
		const tail = `${last?.stdout ?? ''}${last?.stderr ?? ''}${last?.spawnError ?? ''}`.trim().split('\n').slice(-3).join(' ');
		return { ok: false, detail: `esptool could not reset the chip: ${tail}` };
	}
}

class NodeSerialConnection implements ISerialConnection {
	private readonly stream: tty.ReadStream;
	private readonly listeners = new Set<(text: string) => void>();
	private closed = false;
	private readonly closedPromise: Promise<void>;
	private writes: Promise<void> = Promise.resolve();

	constructor(readonly device: string, private readonly fd: number) {
		this.stream = new tty.ReadStream(fd);
		this.stream.setRawMode(true);
		this.closedPromise = new Promise(resolve => this.stream.once('close', () => resolve()));
		this.stream.on('data', (chunk: Buffer) => {
			const text = chunk.toString('latin1');
			for (const l of [...this.listeners]) {
				l(text);
			}
		});
		// A board unplugged mid-read: stop quietly, the capture reports what it got.
		this.stream.on('error', () => void this.close());
	}

	onData(listener: (text: string) => void): IDisposable {
		this.listeners.add(listener);
		return toDisposable(() => this.listeners.delete(listener));
	}

	write(text: string): Promise<void> {
		if (this.closed) {
			return Promise.reject(new Error(`${this.device} is closed`));
		}
		const data = Buffer.from(text, 'latin1');
		const next = this.writes.then(() => new Promise<void>((resolve, reject) => {
			let off = 0;
			const next = () => {
				if (this.closed) {
					return reject(new Error(`${this.device} is closed`));
				}
				fsWrite(this.fd, data, off, data.length - off, null, (err: NodeJS.ErrnoException | null, n: number) => {
					if (err?.code === 'EAGAIN') {
						return void setTimeout(next, 5);
					}
					if (err) {
						return reject(err);
					}
					off += n;
					return off < data.length ? next() : resolve();
				});
			};
			next();
		}));
		// A failed write must not fail every later one.
		this.writes = next.catch(() => undefined);
		return next;
	}

	/**
	 * pause() alone only stops 'data' events: libuv keeps reading the fd into the buffer, racing
	 * esptool for the bytes. Stop the handle's reads too (Node's tty handle has readStop/readStart).
	 */
	hold(on: boolean): void {
		const handle = (this.stream as unknown as { _handle?: { readStop?(): number; reading?: boolean } })._handle;
		if (on) {
			this.stream.pause();
			if (handle?.readStop) {
				handle.readStop();
				// Node restarts reading itself (resume → _read → readStart) only when it knows it stopped.
				handle.reading = false;
			}
		} else {
			this.stream.resume();
		}
	}

	async close(): Promise<void> {
		if (!this.closed) {
			this.closed = true;
			this.listeners.clear();
			this.stream.destroy();
		}
		await Promise.race([this.closedPromise, new Promise(r => setTimeout(r, 1000))]);
	}
}
