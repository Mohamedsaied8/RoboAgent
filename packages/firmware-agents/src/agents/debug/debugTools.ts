/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IAgentHost } from '../../kernel/host';
import { defineTool, ToolError } from '../../kernel/tool';
import { AnyTool } from '../../kernel/toolRegistry';
import { createHash } from 'crypto';
import { espChip } from '../../embedded/arch/esp';
import { CoreDumpError, EspCoreDump, extractUartCoreDumps, parseCoreDump, readCoreNotes } from '../../embedded/crash/espCoreDump';
import { crashAddress, EspCrash, parseEspLog, stripCoreDumpBodies } from '../../embedded/crash/espPanicLog';
import { DebugStackError, locateDebugStack, locateGdb, PROBE_INTERFACES } from '../../embedded/debug/debugStack';
import { acquireProbe, DebugServerError, ProbeBusyError } from '../../embedded/debug/openocdServer';
import { symbolize, Symbolized } from '../../embedded/debug/symbolizer';
import { bitBandTarget, DebugSessionError, inPeripheralSpace, ITargetSession, MAX_READ_BYTES, MAX_WRITE_BYTES, OpenOcdGdbSession, StepKind } from '../../embedded/debug/targetSession';
import { captureSerial, CaptureResult, ESP_CRASH_END } from '../../embedded/serial/serialPort';
import { redactSecrets } from '../../kernel/redact';
import { MiError } from '../../embedded/debug/gdbmi/client';
import { comparePeripheral, DecodedPeripheral, hex } from '../../embedded/svd/peripheralDecoder';
import { DefaultSvdProvider, ISvdProvider } from '../../embedded/svd/svdProvider';
import { SvdError } from '../../embedded/svd/svdParser';
import { DefaultTargetCatalog, ITargetCatalog, TargetDescriptor } from '../../embedded/target';
import { DebugFindings, Evidence, EvidenceKind } from '../../orchestration/messages';
import { isSecretPath, normalizeWorkspacePath } from '../tools/fileTools';
import { resolveTarget } from './setupTools';

/** Starts a session; replaceable in tests. */
export type SessionFactory = (host: IAgentHost, options: Parameters<typeof OpenOcdGdbSession.start>[1]) => Promise<ITargetSession>;

/** The last serial capture: what the ESP32 printed (boot log, panic, core dump). */
export interface SerialCapture {
	readonly device: string;
	readonly text: string;
	readonly at: number;
	/** Characters dropped from the start of the capture (its size cap). */
	readonly dropped: number;
}

/** State the Debug agent's tools share: the live session and the findings reported so far. */
export class DebugToolContext {
	session: ITargetSession | undefined;
	/** Serial output kept for decode_panic and core dumps (the latest capture, bounded). */
	serialLog: SerialCapture | undefined;
	readonly findings: DebugFindings[] = [];
	/** Investigation the agent is working on (for `report_findings`). */
	bugId = 'adhoc';

	constructor(
		readonly agentId: string,
		readonly catalog: ITargetCatalog = new DefaultTargetCatalog(),
		readonly svd: ISvdProvider = new DefaultSvdProvider(),
		readonly startSession: SessionFactory = (host, options) => OpenOcdGdbSession.start(host, options),
	) { }

	/** Addresses shown in write_memory approval prompts, by tool call, so the write uses exactly that one. */
	readonly approvedAddresses = new Map<string, number | undefined>();

	requireSession(): ITargetSession {
		if (!this.session) {
			throw new ToolError('No debug session: call start_session first.');
		}
		return this.session;
	}

	async endSession(resume = true): Promise<void> {
		const s = this.session;
		this.session = undefined;
		this.approvedAddresses.clear();
		await s?.dispose({ resume });
	}
}

/** Maps the debug layer's expected errors to errors the model sees. */
async function guarded<T>(work: () => Promise<T>): Promise<T> {
	try {
		return await work();
	} catch (err) {
		if (err instanceof DebugSessionError || err instanceof DebugServerError || err instanceof DebugStackError || err instanceof ProbeBusyError || err instanceof SvdError || err instanceof CoreDumpError) {
			throw new ToolError(err.message);
		}
		if (err instanceof MiError) {
			throw new ToolError(`Debugger: ${err.message}`);
		}
		throw err;
	}
}

/**
 * Memory the debugger never writes, whatever the user approves: flash (and its alias at 0), system
 * memory and option bytes, the flash controllers of every STM32 family (unlock + erase, or read-out
 * protection level 2, which disables debugging for good), and the debug configuration (DBGMCU).
 * Flashing is the Dev agent's job.
 */
const PROTECTED_RANGES: readonly { readonly from: number; readonly to: number; readonly what: string }[] = [
	{ from: 0x00000000, to: 0x001FFFFF, what: 'the boot alias of flash' },
	{ from: 0x08000000, to: 0x0FFFFFFF, what: 'flash' },
	{ from: 0x1FF00000, to: 0x1FFFFFFF, what: 'system memory / option bytes' },
	{ from: 0x40022000, to: 0x400223FF, what: 'the FLASH controller (F0/F1/F3/G0/G4/L0/L4/L5/U5/C0)' },
	{ from: 0x40023C00, to: 0x40023FFF, what: 'the FLASH controller (F2/F4/F7/L1)' },
	{ from: 0x50022000, to: 0x500223FF, what: 'the FLASH controller (L5/U5/H5 secure alias)' },
	{ from: 0x52002000, to: 0x52002FFF, what: 'the FLASH controller (H7)' },
	{ from: 0x58004000, to: 0x580043FF, what: 'the FLASH controller (WB/WL)' },
	{ from: 0x40015800, to: 0x400158FF, what: 'DBGMCU (debug configuration, F0/G0/L0)' },
	{ from: 0x5C001000, to: 0x5C001FFF, what: 'DBGMCU (debug configuration, H7)' },
	{ from: 0xE0042000, to: 0xE00423FF, what: 'DBGMCU (debug configuration)' },
];

/** Peripherals the SVD names that are protected the same way on parts not listed above. */
const PROTECTED_PERIPHERAL = /^(FLASH|DBGMCU|DBG|OB|OPTIONBYTES?|EFUSE|SPI0|SPI1|SPI_MEM\w*)$/i;

async function protectedReason(session: ITargetSession, address: number, length: number): Promise<string | undefined> {
	const esp = session.target.vendor === 'esp32' ? espChip(session.target.part) : undefined;
	if (session.target.vendor === 'esp32' && !esp) {
		// Fail closed: without the chip's memory map, eFuse and flash controller addresses are unknown.
		return `memory of ${session.target.part}, whose protected ranges (eFuse, flash controller) are not known`;
	}
	if (esp) {
		const hit = esp.protectedRanges.find(r => address <= r.to && address + length - 1 >= r.from);
		if (hit) {
			return hit.what;
		}
	}
	// A bit-band alias write lands in the region it maps to: check both.
	for (const [from, len] of esp ? [] : [[address, length], bitBandTarget(address, length)]) {
		const hit = PROTECTED_RANGES.find(r => from <= r.to && from + len - 1 >= r.from);
		if (hit) {
			return hit.what;
		}
	}
	const named = (await session.registersIn(address, length))?.find(r => PROTECTED_PERIPHERAL.test(r.name.split('.')[0]));
	return named ? `${named.name} (flash/debug control)` : undefined;
}

/** `0x…`, decimal, or (with a session) a C expression such as `&buffer[4]` evaluated by GDB. */
async function parseAddress(session: ITargetSession, value: string): Promise<number> {
	const v = value.trim();
	if (/^0x[0-9a-f]{1,8}$/i.test(v)) {
		return parseInt(v, 16);
	}
	if (/^\d{1,10}$/.test(v)) {
		return Number(v);
	}
	const result = await session.evaluate(`(unsigned long)(${v})`);
	const n = Number(result.trim().split(/\s/)[0]);
	if (!Number.isSafeInteger(n) || n < 0 || n > 0xFFFFFFFF) {
		throw new ToolError(`"${value}" does not evaluate to an address (got ${result}).`);
	}
	return n;
}

function hexDump(address: number, bytes: Uint8Array): string[] {
	const lines: string[] = [];
	for (let off = 0; off < bytes.length; off += 16) {
		const row = bytes.subarray(off, off + 16);
		const ascii = [...row].map(b => b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.').join('');
		lines.push(`${hex(address + off)}: ${[...row].map(b => b.toString(16).padStart(2, '0')).join(' ')}  ${ascii}`);
	}
	return lines;
}

/** Peripheral decode trimmed for the model: optional register filter, fields compact. */
function compact(p: DecodedPeripheral, register?: string): unknown {
	const regs = register ? p.registers.filter(r => r.name.toUpperCase() === register.trim().toUpperCase()) : p.registers;
	if (register && !regs.length) {
		throw new ToolError(`${p.name} has no readable register "${register}" (registers: ${p.registers.map(r => r.name).join(', ')}${p.skipped.length ? `; not read: ${p.skipped.map(s => s.name).join(', ')}` : ''}).`);
	}
	return {
		peripheral: p.name,
		baseAddress: p.baseAddress,
		registers: regs.map(r => ({
			name: r.name,
			address: r.address,
			value: r.value,
			fields: Object.fromEntries(r.fields.map(f => [f.name, f.meaning ? `${f.value} (${f.meaning})` : f.value])),
			...r.changedFromReset?.length ? { changedFromReset: r.changedFromReset } : {},
		})),
		...p.skipped.length && !register ? { notRead: p.skipped } : {},
	};
}

/** Enough for the biggest core dump accepted (4 MB as base64) plus the log around it. */
const CAPTURE_CHARS = 6 * 1024 * 1024;

const BAUDS = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

const sessionInput = {
	type: 'object',
	properties: {
		part: { type: 'string', maxLength: 64, description: 'MCU part, e.g. STM32F103C8T6, esp32 (default: detected from dir)' },
		dir: { type: 'string', maxLength: 512, description: 'Project directory (default ".")' },
		elf: { type: 'string', maxLength: 512, description: 'Workspace path of the ELF with debug symbols (default: the only *.elf under <dir>/build or <dir>)' },
		svd: { type: 'string', maxLength: 512, description: 'Workspace path of an .svd file (default: the pinned SVD for the part)' },
		transport: { enum: ['probe', 'serial', 'coredump'], description: '"probe": OpenOCD + a debug probe (STM32 default; ESP32 with esp-usb-jtag/esp-prog). "serial": ESP32 without a probe, through ESP-IDF\'s GDB stub on the UART (live: CONFIG_ESP_SYSTEM_GDBSTUB_RUNTIME; after a crash: CONFIG_ESP_SYSTEM_PANIC_GDBSTUB) — ESP32 default when no probe is given. "coredump": post-mortem from an ESP-IDF core dump.' },
		probe: { enum: Object.keys(PROBE_INTERFACES), description: 'Debug probe for transport "probe" (default stlink; ESP32: esp-usb-jtag or esp-prog)' },
		port: { type: 'string', maxLength: 256, description: 'Serial port for transport "serial", e.g. /dev/ttyUSB0 (default: the only one, see list_serial_ports)' },
		baud: { enum: BAUDS, description: 'Serial baud rate (default 115200, ESP-IDF\'s console speed)' },
		coreDump: { type: 'string', maxLength: 512, description: 'Transport "coredump": "serial" (default: the last core dump read_serial captured) or a workspace file: a raw core dump image (.bin, e.g. read from the coredump partition) or an ELF core file' },
	},
	additionalProperties: false,
} as const;

interface SessionInput {
	readonly part?: string;
	readonly dir?: string;
	readonly elf?: string;
	readonly svd?: string;
	readonly transport?: 'probe' | 'serial' | 'coredump';
	readonly probe?: string;
	readonly port?: string;
	readonly baud?: number;
	readonly coreDump?: string;
}

function checkWorkspaceFile(path: string, what: string, extension: RegExp): string {
	const p = normalizeWorkspacePath(path);
	if (!p || p.startsWith('-') || isSecretPath(p) || !extension.test(p)) {
		throw new ToolError(`"${path}" is not ${what} the agent may use.`);
	}
	return p;
}

/** The only `.elf` in `<dir>/build` (two levels) or `<dir>`; undefined when none or several. */
async function findElf(host: IAgentHost, dir: string): Promise<string | undefined> {
	const found: string[] = [];
	const scan = async (folder: string, depth: number) => {
		const entries = await host.fs.readDir(folder).catch(() => []);
		for (const e of entries) {
			const p = folder === '.' ? e.name : `${folder}/${e.name}`;
			if (e.isDirectory && depth > 0 && !/^(\.|CMakeFiles$)/.test(e.name)) {
				await scan(p, depth - 1);
			} else if (!e.isDirectory && /\.elf$/i.test(e.name)) {
				found.push(p);
			}
		}
	};
	const base = dir === '.' ? '' : `${dir}/`;
	await scan(`${base}build`.replace(/\/$/, '') || 'build', 2);
	if (!found.length) {
		await scan(dir, 0);
	}
	return found.length === 1 ? found[0] : undefined;
}

/** The serial device to use: the given one (resolved), else the only one the host lists. */
async function serialDevice(host: IAgentHost, port: string | undefined): Promise<string> {
	if (!host.serial) {
		throw new ToolError('This host cannot open serial ports.');
	}
	if (port) {
		return host.serial.resolve(port).catch(err => {
			throw new ToolError(err instanceof Error ? err.message : String(err));
		});
	}
	const ports = await host.serial.list();
	if (ports.length !== 1) {
		throw new ToolError(ports.length ? `Several serial ports: ${ports.map(p => `${p.device}${p.description ? ` (${p.description})` : ''}`).join(', ')}; pass "port".` : 'No serial port found (is the board plugged in?).');
	}
	return ports[0].device;
}

/** Holds the serial port like a probe, so a capture and a GDB stub session never share it. */
function serialLockKey(device: string): string {
	return `serial:${device}`;
}

async function sha256Prefix(host: IAgentHost, elf: string): Promise<string | undefined> {
	// Streamed when the host can (ESP-IDF ELFs with debug info are often larger than a read cap).
	if (host.fs.sha256) {
		return host.fs.sha256(elf).catch(() => undefined);
	}
	if (!host.fs.readBytes) {
		return undefined;
	}
	const bytes = await host.fs.readBytes(elf).catch(() => undefined);
	return bytes ? createHash('sha256').update(bytes).digest('hex') : undefined;
}

/** Whether the ELF is the program that printed `sha` (ESP-IDF prints a prefix of the ELF's SHA-256). */
async function elfMatches(host: IAgentHost, elf: string, sha: string | undefined): Promise<boolean | undefined> {
	if (!sha) {
		return undefined;
	}
	const full = await sha256Prefix(host, elf);
	return full ? full.startsWith(sha.toLowerCase()) : undefined;
}

let coreDumpCounter = 0;

/** A core dump from the last serial capture or a workspace file, written as an ELF core GDB can open. */
async function loadCoreDump(host: IAgentHost, ctx: DebugToolContext, source: string | undefined): Promise<{ coreFile: string; dump?: Omit<EspCoreDump, 'elf' | 'version' | 'chipRevision' | 'checksum'> & Partial<Pick<EspCoreDump, 'checksum'>>; from: string }> {
	if (!host.fs.writeBytes || !host.fs.readBytes) {
		throw new ToolError('This host cannot write binary files, so it cannot open core dumps.');
	}
	let image: Uint8Array;
	let from: string;
	if (!source || source === 'serial') {
		const dumps = ctx.serialLog ? extractUartCoreDumps(ctx.serialLog.text) : [];
		if (!dumps.length) {
			if (ctx.serialLog && ctx.serialLog.dropped > 0 && ctx.serialLog.text.includes('CORE DUMP END')) {
				throw new ToolError(`The capture was cut (${ctx.serialLog.dropped} characters dropped from its start), so the core dump's start is missing. Capture again with a shorter durationMs right before the crash.`);
			}
			throw new ToolError('No core dump in the captured serial output. The firmware needs CONFIG_ESP_COREDUMP_ENABLE_TO_UART=y and CONFIG_ESP_COREDUMP_DATA_FORMAT_ELF=y; capture the crash with read_serial or reset_and_capture first. Or pass a workspace file.');
		}
		image = dumps[dumps.length - 1];
		from = `serial output of ${ctx.serialLog!.device}`;
	} else {
		const p = checkWorkspaceFile(source, 'a core dump file', /\.(bin|elf|core|dump|cdmp)$/i);
		image = await host.fs.readBytes(p);
		from = p;
		// An ELF core file is opened as it is.
		if (image[0] === 0x7F && image[1] === 0x45 && image[2] === 0x4C && image[3] === 0x46) {
			return { coreFile: p, dump: readCoreNotes(image), from };
		}
	}
	const dump = parseCoreDump(image);
	const coreFile = `.roboagent/coredumps/core-${Date.now()}-${++coreDumpCounter}.elf`;
	await host.fs.writeBytes(coreFile, dump.elf);
	return { coreFile, dump, from };
}

async function startSession(host: IAgentHost, ctx: DebugToolContext, input: SessionInput, signal: AbortSignal): Promise<unknown> {
	if (ctx.session) {
		throw new ToolError('A debug session is already running; call end_session first.');
	}
	const dir = normalizeWorkspacePath(input.dir ?? '.') || '.';
	if (dir.startsWith('-') || isSecretPath(dir)) {
		throw new ToolError(`"${input.dir}" is not a project directory the agent may use.`);
	}
	const target: TargetDescriptor | undefined = await resolveTarget(host, ctx.catalog, input);
	if (!target) {
		throw new ToolError('Could not tell which MCU this is; pass "part" (e.g. STM32F103C8T6, esp32).');
	}
	const transport = input.transport ?? (target.vendor === 'esp32' && !input.probe ? 'serial' : 'probe');
	if (transport !== 'probe' && target.vendor !== 'esp32') {
		throw new ToolError(`Transport "${transport}" is for ESP32 targets (ESP-IDF's GDB stub and core dumps); ${target.part} is debugged over a probe.`);
	}
	const elf = input.elf ? checkWorkspaceFile(input.elf, 'an ELF file', /\.(elf|axf|out)$/i) : await findElf(host, dir);
	const svdPath = input.svd ? checkWorkspaceFile(input.svd, 'an SVD file', /\.svd$/i) : undefined;
	const common = {
		target,
		...elf ? { elf } : {},
		svd: () => ctx.svd.load(host, target, svdPath),
		owner: ctx.agentId,
		signal,
		log: (m: string) => host.log('info', m),
	};
	let session: ITargetSession;
	let notes: Record<string, unknown> = {};
	if (transport === 'probe') {
		const probe = input.probe ?? (target.vendor === 'esp32' ? 'esp-usb-jtag' : 'stlink');
		const stack = await locateDebugStack(host, target, probe, signal);
		host.progress(`Starting OpenOCD + GDB for ${target.part} over ${probe}${elf ? ` with ${elf}` : ' (no ELF: addresses only)'}`);
		session = await ctx.startSession(host, {
			...common,
			gdb: stack.gdb,
			probe,
			openocd: { program: stack.openocd, scriptsDir: stack.scriptsDir, interfaceScript: stack.interfaceScript, targetScript: stack.targetScript, signal },
		});
	} else if (transport === 'serial') {
		const device = await serialDevice(host, input.port);
		const gdb = await locateGdb(host, target, signal);
		host.progress(`Attaching GDB to the ESP-IDF GDB stub on ${device}${elf ? ` with ${elf}` : ' (no ELF: addresses only)'}`);
		session = await ctx.startSession(host, { ...common, gdb, probe: serialLockKey(device), serial: { device, baud: input.baud ?? 115200 } });
	} else {
		if (!elf) {
			throw new ToolError('A core dump needs the ELF of the program that crashed: pass "elf" (e.g. build/app.elf).');
		}
		const gdb = await locateGdb(host, target, signal);
		const { coreFile, dump, from } = await loadCoreDump(host, ctx, input.coreDump);
		const matches = await elfMatches(host, elf, dump?.appElfSha256);
		host.progress(`Opening the core dump from ${from} with ${elf}`);
		session = await ctx.startSession(host, {
			...common,
			gdb,
			probe: 'core-dump',
			coreFile,
			...dump ? { coreFacts: { ...dump.crashedTaskTcb !== undefined ? { crashedTaskTcb: dump.crashedTaskTcb } : {}, ...dump.exccause !== undefined ? { exccause: dump.exccause } : {}, ...dump.excvaddr !== undefined ? { excvaddr: dump.excvaddr } : {}, ...dump.panicDetails ? { panicDetails: dump.panicDetails } : {} } } : {},
		});
		notes = {
			coreDump: { from, coreFile, ...dump?.checksum ? { checksum: `${dump.checksum} ok` } : {}, ...dump?.appElfSha256 ? { appElfSha256: dump.appElfSha256 } : {} },
			...matches === false ? { warning: `The ELF ${elf} is not the program that crashed (its SHA-256 does not start with ${dump?.appElfSha256}): rebuild from the same source or use the matching ELF, or source lines will be wrong.` } : {},
		};
	}
	ctx.session = session;
	return {
		target: target.part,
		transport,
		connection: session.server.probe ?? session.server.transport,
		...session.server.core ? { core: session.server.core } : {},
		...session.server.targetVoltage !== undefined ? { targetVoltage: session.server.targetVoltage } : {},
		live: session.live,
		hardwareBreakpoints: session.budget.breakpoints,
		hardwareWatchpoints: session.budget.watchpoints,
		symbols: session.hasSymbols ? elf : 'none (addresses only; pass "elf" for source-level debugging)',
		state: session.state,
		stoppedAt: session.lastStop ?? await session.halt().catch(() => undefined),
		...notes,
	};
}

const serialInput = {
	port: { type: 'string', maxLength: 256, description: 'Serial port, e.g. /dev/ttyUSB0 (default: the only one)' },
	baud: { enum: BAUDS, description: 'Baud rate (default 115200)' },
	durationMs: { type: 'integer', minimum: 100, maximum: 60000, description: 'How long to listen (default 10000); stops early after a crash report ends' },
} as const;

interface SerialInput {
	readonly port?: string;
	readonly baud?: number;
	readonly durationMs?: number;
}

/**
 * Opens the port (holding it like a probe), optionally resets the chip or sends text, and keeps
 * what it printed for decode_panic and core dumps.
 */
async function serialCapture(host: IAgentHost, ctx: DebugToolContext, input: SerialInput & { reset?: boolean; send?: string }, signal: AbortSignal): Promise<unknown> {
	if (ctx.session?.server.transport === 'gdb-stub') {
		throw new ToolError('The GDB stub session holds the serial port; end_session first.');
	}
	const device = await serialDevice(host, input.port);
	const lock = acquireProbe(serialLockKey(device), ctx.agentId);
	let reset: { ok: boolean; detail: string } | undefined;
	let result: CaptureResult;
	try {
		// Open first and hold the port while esptool resets the chip, so the boot output (reset
		// reason, an early crash) is not missed; reading resumes once esptool is done.
		const connection = await host.serial!.open(device, { baud: input.baud ?? 115200 });
		try {
			if (input.reset) {
				connection.hold?.(true);
				try {
					reset = host.serial!.resetEsp32 ? await host.serial!.resetEsp32(device, signal) : { ok: false, detail: 'this host cannot reset the chip; press its EN/RST button' };
				} finally {
					connection.hold?.(false);
				}
			}
			result = await captureSerial(connection, { durationMs: input.durationMs ?? 10_000, until: ESP_CRASH_END, maxChars: CAPTURE_CHARS, ...input.send !== undefined ? { send: input.send } : {}, signal });
		} finally {
			await connection.close();
		}
	} finally {
		lock.dispose();
	}
	// Firmware can print anything, including credentials: keep known secret formats out.
	const text = redactSecrets(result.text);
	ctx.serialLog = { device, text, at: Date.now(), dropped: result.dropped };
	const summary = parseEspLog(text);
	const lines = text.replace(/\r/g, '').split('\n');
	const coreDumps = extractUartCoreDumps(text).length;
	// The model sees the end of the output (where crashes are), without core dump base64.
	const shown = stripCoreDumpBodies(text, '[base64 core dump omitted: use start_session with transport "coredump"]').replace(/\r/g, '').split('\n').slice(-120).join('\n');
	return {
		device,
		...reset ? { reset } : {},
		stoppedBy: result.stoppedBy,
		chars: result.chars,
		lines: lines.length,
		crashes: summary.crashes.map(c => `${c.kind}${c.reason ? ` (${c.reason})` : ''}${c.task ? ` in task ${c.task}` : ''}${c.then ? `, then ${c.then}` : ''}`),
		...coreDumps ? { coreDumps } : {},
		...summary.boots.length ? { boots: summary.boots } : {},
		output: shown.slice(-12_000),
		...summary.crashes.length ? { next: 'decode_panic explains the crash with source lines' } : {},
	};
}

/** One crash report from the captured (or a workspace) log, symbolized against the ELF. */
async function decodePanic(host: IAgentHost, ctx: DebugToolContext, input: { log?: string; elf?: string; dir?: string; part?: string; index?: number }, signal: AbortSignal): Promise<unknown> {
	let text: string;
	let from: string;
	if (input.log) {
		const p = checkWorkspaceFile(input.log, 'a log file', /\.(log|txt)$/i);
		text = await host.fs.readFile(p);
		from = p;
	} else if (ctx.serialLog) {
		text = ctx.serialLog.text;
		from = `serial output of ${ctx.serialLog.device}`;
	} else {
		throw new ToolError('No serial output captured yet: run read_serial or reset_and_capture first, or pass "log" (a workspace file).');
	}
	const summary = parseEspLog(text);
	if (!summary.crashes.length) {
		return { from, crashes: 0, boots: summary.boots, note: 'No ESP-IDF crash report (Guru Meditation, abort, assert, stack overflow, watchdog, brownout) in this output.' };
	}
	const index = input.index ?? summary.crashes.length - 1;
	const crash: EspCrash | undefined = summary.crashes[index];
	if (!crash) {
		throw new ToolError(`There are ${summary.crashes.length} crash reports (index 0–${summary.crashes.length - 1}).`);
	}
	const dir = normalizeWorkspacePath(input.dir ?? '.') || '.';
	const elf = input.elf ? checkWorkspaceFile(input.elf, 'an ELF file', /\.(elf|axf|out)$/i) : await findElf(host, dir);
	const target = await resolveTarget(host, ctx.catalog, input).catch(() => undefined) ?? ctx.catalog.resolve('esp32');
	let symbols = new Map<number, Symbolized>();
	let symbolNote: string | undefined;
	if (elf && target) {
		try {
			const gdb = await locateGdb(host, target, signal);
			const addresses = [crashAddress(crash), crash.abortPc, ...crash.backtrace.map(f => f.pc)].filter((a): a is number => a !== undefined);
			// The real file (inside the workspace) is what GDB opens, not a link that leads elsewhere.
			symbols = await symbolize(host, gdb, await host.fs.realPath(elf), addresses, signal);
		} catch (err) {
			symbolNote = `Addresses not resolved: ${err instanceof Error ? err.message : String(err)}`;
		}
	} else {
		symbolNote = 'No ELF found: pass "elf" to resolve addresses to functions and source lines.';
	}
	const sha = crash.elfSha256 ?? summary.appElfSha256;
	const matches = elf ? await elfMatches(host, elf, sha) : undefined;
	const where = (a: number | undefined) => a === undefined ? undefined : symbols.get(a) ?? { address: `0x${a.toString(16).toUpperCase().padStart(8, '0')}` };
	const frames = crash.backtrace.map((f, k) => ({ frame: k, ...where(f.pc)! }));
	const pc = where(crashAddress(crash));
	const firstOwn = frames.find(f => f.file && !/[\\/](esp-idf|components[\\/](freertos|esp_system|newlib|esp_hw_support))[\\/]/.test(f.file));
	const regs = Object.entries(crash.registers);
	return {
		from,
		crash: index,
		of: summary.crashes.length,
		kind: crash.kind,
		...crash.reason ? { reason: crash.reason } : {},
		...crash.core !== undefined ? { core: crash.core } : {},
		...crash.meaning ? { meaning: crash.meaning } : {},
		...crash.details.length ? { details: crash.details.map(d => redactSecrets(d)) } : {},
		...crash.task ? { task: crash.task } : {},
		...crash.assertion ? { assertion: { ...crash.assertion, expression: redactSecrets(crash.assertion.expression) } } : {},
		...pc ? { pc } : {},
		...crash.faultAddress !== undefined ? { faultAddress: `0x${crash.faultAddress.toString(16).toUpperCase().padStart(8, '0')}${crash.faultAddress < 0x1000 ? ' (NULL pointer dereference)' : ''}` } : {},
		...firstOwn ? { firstApplicationFrame: firstOwn } : {},
		backtrace: frames,
		...crash.backtraceCorrupted ? { backtraceCorrupted: 'the stack was overwritten: frames after the first ones are unreliable (stack overflow or a buffer overrun on the stack?)' } : {},
		...regs.length ? { registers: Object.fromEntries(regs.map(([k, v]) => [k, `0x${v.toString(16).padStart(8, '0')}`])) } : {},
		...crash.then ? { then: crash.then } : {},
		...crash.coreDump ? { coreDump: 'printed: open it with start_session transport "coredump" for every task\'s stack and variables' } : {},
		...matches === false ? { warning: `The ELF ${elf} is not the program that crashed (the log's ELF SHA-256 starts with ${sha}): source lines may be wrong; use the ELF of the flashed build.` } : matches ? { elf: `${elf} (SHA-256 matches the log)` } : elf ? { elf } : {},
		...symbolNote ? { note: symbolNote } : {},
	};
}

/**
 * The Debug agent's on-chip tools. Reading state and run control (halt, resume, step,
 * breakpoints) are `read`: they do not change the program or the chip's configuration. Starting
 * a session halts the target and reset/memory writes change it, so those ask (`hardware`).
 */
export function createDebugTools(ctx: DebugToolContext): AnyTool[] {
	const withSession = <T>(work: (s: ITargetSession) => Promise<T>) => guarded(() => work(ctx.requireSession()));
	return [
		defineTool({
			name: 'start_session',
			description: 'Start a debug session and halt the target: over a debug probe (OpenOCD + GDB), or for ESP32 without a probe over the serial port (ESP-IDF\'s GDB stub), or post-mortem from an ESP-IDF core dump. Needs the debug tools (see check_debug_tools / ensure_debug_tools). Pass the ELF for source-level debugging; reports the stop location and the hardware breakpoint/watchpoint budget.',
			risk: 'hardware',
			category: 'hardware',
			inputSchema: sessionInput,
			describeCall: (input: SessionInput) => input.transport === 'coredump'
				? `Open the ESP32 core dump${input.coreDump && input.coreDump !== 'serial' ? ` ${input.coreDump}` : ' captured from the serial port'} in GDB${input.elf ? ` with ${input.elf}` : ''} (no target access)`
				: input.transport === 'serial' || (!input.probe && /esp32/i.test(input.part ?? ''))
					? `Attach GDB to ${input.part ?? 'the ESP32'} through ESP-IDF's GDB stub on ${input.port ?? 'the serial port'} and halt it${input.elf ? ` (symbols from ${input.elf})` : ''}`
					: `Attach the debugger to ${input.part ?? `the target of ${input.dir ?? '.'}`} over ${input.probe ?? 'ST-Link'} and halt it${input.elf ? ` (symbols from ${input.elf})` : ''}${input.svd ? ` (registers from ${input.svd})` : ''}`,
			invoke: (input: SessionInput, { host, signal }) => guarded(() => startSession(host, ctx, input, signal)),
		}),
		defineTool({
			name: 'end_session',
			description: 'End the debug session: detach (the target keeps running) and stop OpenOCD and GDB. With resume=false the target stays halted. ESP32 GDB stub: the program continues (after a panic the chip stays stopped until reset).',
			risk: 'read',
			inputSchema: { type: 'object', properties: { resume: { type: 'boolean', description: 'Let the target run after detaching (default true)' } }, additionalProperties: false },
			invoke: async (input: { resume?: boolean }) => {
				if (!ctx.session) {
					return { ended: false, note: 'no session was running' };
				}
				await ctx.endSession(input.resume ?? true);
				return { ended: true, targetRunning: input.resume ?? true };
			},
		}),
		defineTool({
			name: 'halt',
			description: 'Stop the CPU where it is and report the location.',
			risk: 'read',
			inputSchema: { type: 'object', properties: {}, additionalProperties: false },
			invoke: () => withSession(s => s.halt()),
		}),
		defineTool({
			name: 'resume',
			description: 'Let the CPU run. With waitMs, wait up to that long for it to stop again (breakpoint, watchpoint, fault) and report where; otherwise return at once.',
			risk: 'read',
			inputSchema: { type: 'object', properties: { waitMs: { type: 'integer', minimum: 0, maximum: 60000, description: 'How long to wait for a stop (default 0)' } }, additionalProperties: false },
			invoke: (input: { waitMs?: number }) => withSession(async s => {
				const stop = await s.resume(input.waitMs ?? 0);
				return stop ? { stopped: true, at: stop } : { stopped: false, state: s.state, note: input.waitMs ? `no stop within ${input.waitMs} ms; still running (call halt to stop it)` : 'running' };
			}),
		}),
		defineTool({
			name: 'step',
			description: 'Step: "over" (next source line), "into" (enter calls), "out" (finish the current function), "instruction" (one machine instruction). Source steps need the ELF.',
			risk: 'read',
			inputSchema: { type: 'object', properties: { kind: { enum: ['over', 'into', 'out', 'instruction'] } }, required: ['kind'], additionalProperties: false },
			invoke: (input: { kind: StepKind }) => withSession(s => s.step(input.kind)),
		}),
		defineTool({
			name: 'reset',
			description: 'Reset the target (system reset) and either halt at the reset vector or let it run. Clears RAM state the program set up.',
			risk: 'hardware',
			category: 'hardware',
			inputSchema: { type: 'object', properties: { mode: { enum: ['halt', 'run'], description: 'default halt' } }, additionalProperties: false },
			describeCall: (input: { mode?: string }) => `Reset the target and ${input.mode === 'run' ? 'let it run' : 'halt at the reset vector'}`,
			invoke: (input: { mode?: 'halt' | 'run' }) => withSession(async s => ({ reset: true, mode: input.mode ?? 'halt', at: await s.reset(input.mode ?? 'halt') ?? 'running' })),
		}),
		defineTool({
			name: 'set_breakpoint',
			description: 'Set a hardware breakpoint at a function, file.c:LINE, file.c:function or *0xADDRESS, optionally with a condition (C expression). Hardware breakpoints are scarce (see start_session); one is kept free for stepping.',
			risk: 'read',
			inputSchema: {
				type: 'object',
				properties: {
					location: { type: 'string', maxLength: 256 },
					condition: { type: 'string', maxLength: 256, description: 'Stop only when this C expression is true, e.g. "counter > 10"' },
				},
				required: ['location'],
				additionalProperties: false,
			},
			invoke: (input: { location: string; condition?: string }) => withSession(async s => ({ ...await s.setBreakpoint(input.location, input.condition), budget: `${s.breakpoints().filter(b => b.kind === 'breakpoint').length}/${s.budget.breakpoints - 1} usable breakpoints in use` })),
		}),
		defineTool({
			name: 'set_watchpoint',
			description: 'Stop when a variable or memory location is written ("w"), read ("r") or either ("rw"). Uses a hardware watchpoint (the core has few).',
			risk: 'read',
			inputSchema: {
				type: 'object',
				properties: { expression: { type: 'string', maxLength: 256, description: 'e.g. "counter", "sensor.reading", "*(uint32_t *)0x20000100"' }, access: { enum: ['w', 'r', 'rw'] } },
				required: ['expression'],
				additionalProperties: false,
			},
			invoke: (input: { expression: string; access?: 'r' | 'w' | 'rw' }) => withSession(s => s.setWatchpoint(input.expression, input.access ?? 'w')),
		}),
		defineTool({
			name: 'clear_breakpoint',
			description: 'Remove a breakpoint or watchpoint by id.',
			risk: 'read',
			inputSchema: { type: 'object', properties: { id: { type: 'integer', minimum: 1 } }, required: ['id'], additionalProperties: false },
			invoke: (input: { id: number }) => withSession(async s => {
				await s.clearBreakpoint(input.id);
				return { cleared: input.id, remaining: s.breakpoints() };
			}),
		}),
		defineTool({
			name: 'list_breakpoints',
			description: 'Breakpoints and watchpoints set in this session, with the hardware budget.',
			risk: 'read',
			inputSchema: { type: 'object', properties: {}, additionalProperties: false },
			invoke: () => withSession(async s => ({ breakpoints: s.breakpoints(), budget: s.budget })),
		}),
		defineTool({
			name: 'read_memory',
			description: `Read up to ${MAX_READ_BYTES} bytes of target memory. "address" is 0x…, decimal, or a C expression such as "&buffer[4]". Ranges covering registers whose read has a side effect (per the SVD, e.g. a UART data register) are refused; prefer read_peripheral for registers.`,
			risk: 'read',
			inputSchema: {
				type: 'object',
				properties: {
					address: { type: 'string', maxLength: 256 },
					length: { type: 'integer', minimum: 1, maximum: MAX_READ_BYTES },
					format: { enum: ['hex', 'words'], description: '"hex" dump (default) or little-endian 32-bit "words"' },
				},
				required: ['address', 'length'],
				additionalProperties: false,
			},
			invoke: (input: { address: string; length: number; format?: 'hex' | 'words' }) => withSession(async s => {
				const address = await parseAddress(s, input.address);
				const registers = await s.registersIn(address, input.length);
				const [touched, touchedLength] = s.target.arch === 'cortex-m' ? bitBandTarget(address, input.length) : [address, input.length];
				if (!registers && s.live && inPeripheralSpace(s.target, touched, touchedLength)) {
					throw new ToolError('Not read: this is peripheral space and no SVD is available (none for this part, or it failed to load — read_peripheral shows why) to tell which registers are safe to read (some clear flags or pop FIFOs when read). Start the session with "svd" (a workspace .svd file).');
				}
				const unsafe = (registers ?? []).filter(r => r.unreadable);
				if (unsafe.length) {
					throw new ToolError(`Not read: ${unsafe.map(r => `${r.name} (${r.unreadable})`).join(', ')}. Read the other registers with read_peripheral.`);
				}
				const bytes = await s.readMemory(address, input.length);
				if (input.format === 'words') {
					const words: string[] = [];
					for (let k = 0; k + 4 <= bytes.length; k += 4) {
						words.push(`${hex(address + k)}: ${hex(bytes[k] | bytes[k + 1] << 8 | bytes[k + 2] << 16 | bytes[k + 3] << 24)}`);
					}
					return { address: hex(address), words };
				}
				return { address: hex(address), dump: hexDump(address, bytes) };
			}),
		}),
		defineTool({
			name: 'write_memory',
			description: `Write up to ${MAX_WRITE_BYTES} bytes to target RAM or a peripheral register. Flash, option bytes, the flash controller, DBGMCU and (ESP32) eFuses are refused; RAM writes can still change what the program does (e.g. a function pointer), so write only what the investigation needs. "bytes" is hex, lowest address first (little-endian: the word 0x00000001 is "01000000"). The user must approve.`,
			risk: 'hardware',
			category: 'hardware',
			inputSchema: {
				type: 'object',
				properties: { address: { type: 'string', maxLength: 256 }, bytes: { type: 'string', maxLength: MAX_WRITE_BYTES * 2, description: 'Hex bytes, e.g. "01000000"' } },
				required: ['address', 'bytes'],
				additionalProperties: false,
			},
			describeCall: async (input: { address: string; bytes: string }, context) => {
				const what = `Write ${input.bytes.length / 2} byte(s) (${input.bytes.slice(0, 32)}${input.bytes.length > 32 ? '…' : ''}) to target memory at ${input.address}`;
				// Name the register when the address is known and described, so the user sees what changes.
				const s = ctx.session;
				const address = s ? await parseAddress(s, input.address).catch(() => undefined) : undefined;
				if (context) {
					// Entries of declined calls are never consumed by invoke: keep the map small.
					if (ctx.approvedAddresses.size >= 32) {
						ctx.approvedAddresses.clear();
					}
					ctx.approvedAddresses.set(context.callId, address);
				}
				const regs = s && address !== undefined ? await s.registersIn(address, Math.max(1, input.bytes.length / 2)).catch(() => undefined) ?? [] : [];
				return `${what}${address !== undefined && !/^0x/i.test(input.address.trim()) ? ` (${hex(address)})` : ''}${regs.length ? ` = ${regs.map(r => r.name).join(', ')}` : ''}`;
			},
			invoke: (input: { address: string; bytes: string }, { callId }) => withSession(async s => {
				if (!/^(?:[0-9a-fA-F]{2})+$/.test(input.bytes)) {
					throw new ToolError('"bytes" must be an even number of hex digits, e.g. "01000000".');
				}
				const shown = ctx.approvedAddresses.get(callId);
				const wasShown = ctx.approvedAddresses.has(callId);
				ctx.approvedAddresses.delete(callId);
				const address = await parseAddress(s, input.address);
				// The user approved the address the prompt showed; an expression must still mean that address.
				if (wasShown && !/^(0x[0-9a-f]+|\d+)$/i.test(input.address.trim()) && shown !== address) {
					throw new ToolError(shown === undefined
						? `"${input.address}" could not be resolved when the user was asked (target running?); halt and ask again.`
						: `"${input.address}" now resolves to ${hex(address)}, not ${hex(shown)} as approved; ask again.`);
				}
				const data = Uint8Array.from(input.bytes.match(/../g)!.map(h => parseInt(h, 16)));
				const blocked = await protectedReason(s, address, data.length);
				if (blocked) {
					throw new ToolError(`Refused: ${hex(address)}…${hex(address + data.length - 1)} touches ${blocked}. The debugger does not write flash or its controls; flashing is the Dev agent's flash tool.`);
				}
				await s.writeMemory(address, data);
				const back = await s.readMemory(address, data.length);
				return { written: data.length, address: hex(address), readBack: [...back].map(b => b.toString(16).padStart(2, '0')).join('') };
			}),
		}),
		defineTool({
			name: 'read_core_registers',
			description: 'Core registers of the current thread: Cortex-M r0–r12, sp, lr, pc, xpsr, msp, psp, primask, basepri, faultmask, control; Xtensa pc, ps, a0–a15, sar, …; RISC-V pc, ra, sp, a0–a7, … (registers the GDB stub or core dump lacks are left out).',
			risk: 'read',
			inputSchema: { type: 'object', properties: {}, additionalProperties: false },
			invoke: () => withSession(s => s.readCoreRegisters()),
		}),
		defineTool({
			name: 'evaluate',
			description: 'Evaluate C expressions in the current frame with GDB (variables, struct members, array elements, casts, pointer dereferences, $pc/$sp). Assignments and calls are refused. Do not read peripheral registers through pointers here (e.g. huart1.Instance->DR): a read can clear flags or pop a FIFO; use read_peripheral. Up to 16 at once (a watch list).',
			risk: 'read',
			inputSchema: {
				type: 'object',
				properties: { expressions: { type: 'array', items: { type: 'string', maxLength: 256 }, maxItems: 16 } },
				required: ['expressions'],
				additionalProperties: false,
			},
			invoke: (input: { expressions: string[] }) => withSession(async s => {
				const out: { expression: string; value?: string; error?: string }[] = [];
				for (const expression of input.expressions) {
					try {
						out.push({ expression, value: await s.evaluate(expression) });
					} catch (err) {
						if (err instanceof DebugSessionError || err instanceof MiError) {
							out.push({ expression, error: err.message });
						} else {
							throw err;
						}
					}
				}
				return out;
			}),
		}),
		defineTool({
			name: 'backtrace',
			description: 'Call stack of the halted CPU (function, file, line per frame).',
			risk: 'read',
			inputSchema: { type: 'object', properties: { maxFrames: { type: 'integer', minimum: 1, maximum: 64 } }, additionalProperties: false },
			invoke: (input: { maxFrames?: number }) => withSession(s => s.backtrace(input.maxFrames ?? 16)),
		}),
		defineTool({
			name: 'locals',
			description: 'Local variables and arguments of a stack frame (0 = innermost); aggregates show their type, use evaluate for their contents.',
			risk: 'read',
			inputSchema: { type: 'object', properties: { frame: { type: 'integer', minimum: 0, maximum: 63 } }, additionalProperties: false },
			invoke: (input: { frame?: number }) => withSession(s => s.locals(input.frame ?? 0)),
		}),
		defineTool({
			name: 'list_peripherals',
			description: 'Peripherals the SVD describes (name, base address), optionally filtered by a substring.',
			risk: 'read',
			inputSchema: { type: 'object', properties: { filter: { type: 'string', maxLength: 32 } }, additionalProperties: false },
			invoke: (input: { filter?: string }) => withSession(async s => {
				const all = await s.peripherals();
				const f = input.filter?.toUpperCase();
				return f ? all.filter(p => p.name.toUpperCase().includes(f) || p.description?.toUpperCase().includes(f)) : all.map(p => `${p.name} @ ${p.baseAddress}`);
			}),
		}),
		defineTool({
			name: 'read_peripheral',
			description: 'Read a peripheral (e.g. RCC, GPIOA, USART2) and decode every register into named fields using the SVD; optionally just one register. Registers whose read has side effects (data registers, write-only) are not read. Lists fields that differ from their reset value.',
			risk: 'read',
			inputSchema: {
				type: 'object',
				properties: { name: { type: 'string', maxLength: 32 }, register: { type: 'string', maxLength: 64 } },
				required: ['name'],
				additionalProperties: false,
			},
			invoke: (input: { name: string; register?: string }) => withSession(async s => compact(await s.readPeripheral(input.name), input.register)),
		}),
		defineTool({
			name: 'compare_peripheral',
			description: 'Read a peripheral again and list the fields that changed since the last read_peripheral of it in this session (e.g. before and after an init function).',
			risk: 'read',
			inputSchema: { type: 'object', properties: { name: { type: 'string', maxLength: 32 } }, required: ['name'], additionalProperties: false },
			invoke: (input: { name: string }) => withSession(async s => {
				const before = s.lastSnapshot(input.name);
				if (!before) {
					throw new ToolError(`No earlier read of ${input.name} in this session; call read_peripheral first.`);
				}
				const after = await s.readPeripheral(input.name);
				const changes = comparePeripheral(before, after);
				return { peripheral: after.name, changes, unchanged: changes.length === 0 };
			}),
		}),
		defineTool({
			name: 'threads',
			description: 'Threads of the halted target: FreeRTOS tasks on ESP32 (GDB stub or core dump) with their state and current function; otherwise the CPU. The current thread is marked; select_thread switches.',
			risk: 'read',
			inputSchema: { type: 'object', properties: {}, additionalProperties: false },
			invoke: () => withSession(s => s.threads()),
		}),
		defineTool({
			name: 'select_thread',
			description: 'Make a thread (task) current, so backtrace, locals, evaluate and read_core_registers show it.',
			risk: 'read',
			inputSchema: { type: 'object', properties: { id: { type: 'integer', minimum: 1, maximum: 1024 } }, required: ['id'], additionalProperties: false },
			invoke: (input: { id: number }) => withSession(async s => ({ thread: input.id, frame: await s.selectThread(input.id) })),
		}),
		defineTool({
			name: 'list_serial_ports',
			description: 'Serial ports on this machine (ESP32 boards show up as USB-serial bridges such as CP2102 or CH340, or as USB-JTAG/serial).',
			risk: 'read',
			inputSchema: { type: 'object', properties: {}, additionalProperties: false },
			invoke: async (_input: unknown, { host }) => {
				if (!host.serial) {
					throw new ToolError('This host cannot open serial ports.');
				}
				return host.serial.list();
			},
		}),
		defineTool({
			name: 'read_serial',
			description: 'Listen to the ESP32 serial console: what it prints (logs, a crash report, a core dump). Stops early once a crash report ends. Keeps the output for decode_panic and core dumps. Opening the port does not reset boards with CP210x/CH34x bridges; some other USB-serial bridges briefly toggle the reset line when a port is opened.',
			risk: 'read',
			inputSchema: { type: 'object', properties: serialInput, additionalProperties: false },
			invoke: (input: SerialInput, { host, signal }) => guarded(() => serialCapture(host, ctx, input, signal)),
		}),
		defineTool({
			name: 'reset_and_capture',
			description: 'Reset the ESP32 through the USB-serial bridge (RTS/EN, needs esptool) and capture what it prints from boot: start-up logs and any crash that follows. Keeps the output for decode_panic and core dumps.',
			risk: 'hardware',
			category: 'hardware',
			inputSchema: { type: 'object', properties: serialInput, additionalProperties: false },
			describeCall: (input: SerialInput) => `Reset the ESP32 on ${input.port ?? 'the serial port'} and capture its output for ${(input.durationMs ?? 10_000) / 1000} s`,
			invoke: (input: SerialInput, { host, signal }) => guarded(() => serialCapture(host, ctx, { ...input, reset: true }, signal)),
		}),
		defineTool({
			name: 'send_serial',
			description: 'Send a line of text to the firmware\'s serial console (e.g. a command its console understands) and capture the reply. Not for GDB stub firmware (it would enter the stub).',
			risk: 'hardware',
			category: 'hardware',
			inputSchema: {
				type: 'object',
				// Printable text, tabs and line endings only, and no "$": Ctrl-C would enter a runtime GDB
				// stub, and "$…#xx" packets would drive a stub waiting after a panic (memory writes that
				// bypass write_memory's checks).
				properties: { ...serialInput, text: { type: 'string', maxLength: 256, pattern: '^[\\t\\n\\r\\x20-\\x23\\x25-\\x7e]*$', description: 'Printable ASCII (no "$") sent as is; add "\\n" for a line ending' } },
				required: ['text'],
				additionalProperties: false,
			},
			describeCall: (input: SerialInput & { text: string }) => `Send ${JSON.stringify(input.text)} to the firmware on ${input.port ?? 'the serial port'} and capture the reply`,
			invoke: (input: SerialInput & { text: string }, { host, signal }) => guarded(() => {
				// Ctrl-C would enter a runtime GDB stub; other control bytes are not console input.
				if (/[^\t\n\r\x20-\x7e]|\$/.test(input.text)) {
					throw new ToolError('Only printable text (no "$"), tabs and line endings can be sent.');
				}
				if (ctx.serialLog && parseEspLog(ctx.serialLog.text).crashes.at(-1)?.then === 'gdb-stub') {
					throw new ToolError('The chip is waiting in its GDB stub after a panic: use start_session with transport "serial" instead of sending text.');
				}
				return serialCapture(host, ctx, { ...input, send: input.text }, signal);
			}),
		}),
		defineTool({
			name: 'decode_panic',
			description: 'Explain an ESP-IDF crash report (Guru Meditation exception, abort, assert, stack overflow, task/interrupt watchdog, brownout) from the captured serial output or a workspace log: reason and its usual cause, the faulting address, the backtrace resolved to functions and source lines with the ELF, and whether the ELF matches the running firmware.',
			risk: 'read',
			inputSchema: {
				type: 'object',
				properties: {
					log: { type: 'string', maxLength: 512, description: 'Workspace log file (default: the last serial capture)' },
					elf: { type: 'string', maxLength: 512, description: 'Workspace path of the app ELF (default: the only *.elf under <dir>/build)' },
					dir: { type: 'string', maxLength: 512 },
					part: { type: 'string', maxLength: 64, description: 'Chip, e.g. esp32 (default: detected from dir)' },
					index: { type: 'integer', minimum: 0, maximum: 31, description: 'Which crash report (default: the last)' },
				},
				additionalProperties: false,
			},
			invoke: (input: { log?: string; elf?: string; dir?: string; part?: string; index?: number }, { host, signal }) => guarded(() => decodePanic(host, ctx, input, signal)),
		}),
		defineTool({
			name: 'decode_crash',
			description: 'Explain a fault on the halted target. Cortex-M: the current exception, HardFault/BusFault/MemManage/UsageFault flags with their meaning, the faulting data address, the stacked registers and source location. ESP32 (GDB stub / core dump): the exception, the faulting instruction and source line, the bad data address (from EXCVADDR or the instruction), abort/assert text, the task and its backtrace.',
			risk: 'read',
			inputSchema: { type: 'object', properties: {}, additionalProperties: false },
			invoke: () => withSession(s => s.decodeCrash()),
		}),
		defineTool({
			name: 'report_findings',
			description: 'Record the result of the investigation: root cause, confidence, and the evidence you collected (register values, peripheral fields, crash decode, backtrace). Call it once at the end, before your summary.',
			risk: 'read',
			inputSchema: {
				type: 'object',
				properties: {
					rootCause: { type: 'string', maxLength: 2000 },
					confidence: { enum: ['low', 'medium', 'high'] },
					evidence: {
						type: 'array',
						maxItems: 20,
						items: {
							type: 'object',
							properties: {
								kind: { enum: ['registers', 'memory', 'peripheral', 'backtrace', 'crash', 'rtos', 'expression', 'note'] },
								summary: { type: 'string', maxLength: 500, description: 'One line, e.g. "RCC.APB1ENR.USART2EN = 0 (expected 1)"' },
							},
							required: ['kind', 'summary'],
							additionalProperties: false,
						},
					},
					suggestedFix: { type: 'string', maxLength: 2000 },
				},
				required: ['confidence', 'evidence'],
				additionalProperties: false,
			},
			invoke: async (input: { rootCause?: string; confidence: 'low' | 'medium' | 'high'; evidence: { kind: EvidenceKind; summary: string }[]; suggestedFix?: string }) => {
				const findings: DebugFindings = {
					type: 'debug-findings',
					bugId: ctx.bugId,
					confidence: input.confidence,
					evidence: input.evidence.map((e): Evidence => ({ kind: e.kind, summary: e.summary })),
					...input.rootCause ? { rootCause: input.rootCause } : {},
					...input.suggestedFix ? { suggestedFix: input.suggestedFix } : {},
				};
				ctx.findings.push(findings);
				return { recorded: true };
			},
		}),
	];
}
