/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable } from '../../kernel/disposable';
import { IAgentHost, IProcessHandle } from '../../kernel/host';
import { BreakpointBudget, budgetFromControlRegisters, CORTEX_M_CORE_REGISTERS, CrashReport, decodeCortexMFault, DWT_CTRL, FP_CTRL, SCB, stackFromExcReturn } from '../arch/cortexM';
import { espBudget, espChip, exceptionCause, RISCV_CORE_REGISTERS, XTENSA_CORE_REGISTERS } from '../arch/esp';
import { crashKindMeaning, isEspIdfSource } from '../crash/espPanicLog';
import { DecodedPeripheral, decodeRegister, hex, readableRegister, readLittleEndian, SkippedRegister } from '../svd/peripheralDecoder';
import { findPeripheral, SvdDevice } from '../svd/svdParser';
import { CoreArchitecture, TargetDescriptor } from '../target';
import { GdbMiClient, MiError, StopEvent } from './gdbmi/client';
import { miList, miQuote, MiRecord, miString, miTuple, MiTuple, MiValue } from './gdbmi/parser';
import { acquireProbe, OpenOcdServer, OpenOcdStartOptions } from './openocdServer';

/** An expected failure the agent should see (bad input, target running, budget exhausted). */
export class DebugSessionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'DebugSessionError';
	}
}

export interface StopInfo {
	readonly reason?: string;
	readonly pc?: string;
	readonly function?: string;
	readonly file?: string;
	readonly line?: number;
	readonly breakpoint?: number;
	readonly signal?: string;
}

export interface Frame {
	readonly level: number;
	readonly address: string;
	readonly function?: string;
	readonly file?: string;
	readonly line?: number;
}

export interface BreakpointInfo {
	readonly id: number;
	readonly kind: 'breakpoint' | 'watchpoint';
	readonly location: string;
	readonly address?: string;
	readonly condition?: string;
	readonly access?: 'r' | 'w' | 'rw';
	/** Code locations (one comparator each): an inlined function can have several. */
	readonly locations?: number;
}

export interface Variable {
	readonly name: string;
	readonly type?: string;
	readonly value?: string;
}

export type StepKind = 'instruction' | 'over' | 'into' | 'out';

export interface RegisterAt {
	/** `PERIPHERAL.REGISTER`. */
	readonly name: string;
	readonly address: string;
	/** Why reading it is not safe (side effect, write-only); undefined when it is. */
	readonly unreadable?: string;
}

export interface SourceLocation {
	readonly address: string;
	readonly function: string;
	readonly file?: string;
	readonly line?: number;
}

/**
 * Cortex-M3/M4 peripheral bit-band: each word of 0x42000000–0x43FFFFFF reads or writes one bit
 * of 0x40000000–0x400FFFFF. Returns the bit-band region range an access really touches.
 */
export function bitBandTarget(address: number, length: number): [number, number] {
	const end = address + length - 1;
	if (address > 0x43FFFFFF || end < 0x42000000) {
		return [address, length];
	}
	const from = 0x40000000 + Math.floor((Math.max(address, 0x42000000) - 0x42000000) / 32);
	const to = 0x40000000 + Math.floor((Math.min(end, 0x43FFFFFF) - 0x42000000) / 32);
	return [from & ~3, (to & ~3) + 4 - (from & ~3)];
}

const LIT = String.raw`(?<lit>0[xX][0-9a-fA-F]+|0[0-7]*|[1-9]\d*)[uUlL]*`;
/** Reads through a literal address: `*(T *)lit`, `((T *)lit)->` / `[`, `{T}lit`. */
const LITERAL_READS: readonly RegExp[] = [
	new RegExp(String.raw`\*\s*\(\s*[^()]*\*\s*\)\s*\(?\s*${LIT}`, 'g'),
	new RegExp(String.raw`\(\s*[^()]*\*\s*\)\s*${LIT}\s*\)\s*(?:\[|->)`, 'g'),
	new RegExp(String.raw`\{[^{}]*\}\s*\(?\s*${LIT}`, 'g'),
];

/** A C integer literal as GDB reads it (hex, octal with a leading 0, decimal). */
function parseCLiteral(text: string): number | undefined {
	const t = text.toLowerCase();
	const n = t.startsWith('0x') ? parseInt(t.slice(2), 16) : t.length > 1 && t.startsWith('0') ? parseInt(t.slice(1), 8) : Number(t);
	return Number.isSafeInteger(n) ? n : undefined;
}

/** Peripheral space, where a read can have side effects. */
export const PERIPHERAL_SPACE = { from: 0x40000000, to: 0x5FFFFFFF } as const;

function describeLocation(l: SourceLocation): string {
	return `${l.function} (${l.file ? `${l.file}:${l.line}, ` : ''}${l.address})`;
}

export type CortexCrashDecode = CrashReport & { readonly backtrace: Frame[]; readonly faultingCode?: SourceLocation; readonly caller?: SourceLocation };

/** An ESP32-family crash seen through GDB (live over the GDB stub, or from a core dump). */
export interface EspCrashDecode {
	readonly arch: 'xtensa' | 'riscv';
	/** Whether the CPU stopped because of an exception (a signal), not a breakpoint or a halt. */
	readonly faulted: boolean;
	/** GDB's signal for the stop, e.g. `SIGSEGV` (the stub maps EXCCAUSE to a signal). */
	readonly signal?: string;
	/** Exception name, e.g. `LoadProhibited`, when known (core dump EXCCAUSE). */
	readonly exception?: string;
	/** What it usually means in firmware. */
	readonly meaning?: string;
	readonly pc?: string;
	/** The instruction at the PC as GDB disassembles it. */
	readonly faultingInstruction?: string;
	/** The data address of a bad load/store, and how it was found. */
	readonly faultAddress?: { readonly address: string; readonly source: 'EXCVADDR' | 'faulting instruction' };
	readonly access?: 'read' | 'write';
	/** Text abort()/assert left in the core dump. */
	readonly panicDetails?: string;
	readonly faultingCode?: SourceLocation;
	readonly caller?: SourceLocation;
	/** First frame in the application's own code (not ESP-IDF's abort/panic path). */
	readonly applicationFrame?: Frame;
	readonly thread?: string;
	readonly backtrace: Frame[];
	readonly summary: string;
}

export type CrashDecode = CortexCrashDecode | EspCrashDecode;

/** How GDB reaches the target. */
export type DebugTransport = 'openocd' | 'gdb-stub' | 'core-dump';

/** What the session is connected through (OpenOCD's probe facts, the serial device or the core file). */
export interface DebugConnectionInfo {
	readonly transport: DebugTransport;
	/** OpenOCD's GDB port. */
	readonly port?: number;
	/** Serial device of the GDB stub. */
	readonly device?: string;
	/** Workspace path of the core file. */
	readonly coreFile?: string;
	readonly probe?: string;
	readonly targetVoltage?: number;
	readonly core?: string;
}

export interface ThreadInfo {
	readonly id: number;
	/** GDB's target id, e.g. `Thread 1 (Name: IDLE0 State: Running @CPU - 0)` or `process 1073412600`. */
	readonly targetId: string;
	/** FreeRTOS task name, when known. */
	readonly name?: string;
	/** Task state as the GDB stub reports it, e.g. `Running @CPU - 0`'s `Running`, `Blocked`. */
	readonly state?: string;
	readonly current: boolean;
	readonly frame?: Frame;
}

/** Facts a core dump carries beside the ELF core (EXCCAUSE/EXCVADDR, abort text). */
export interface CoreDumpFacts {
	/** TCB of the task that crashed (RISC-V: its exception frame holds mcause/mtval). */
	readonly crashedTaskTcb?: number;
	readonly exccause?: number;
	readonly excvaddr?: number;
	readonly panicDetails?: string;
}

/** Port: one debug session on one target (Facade over the debug server and debugger). */
export interface ITargetSession {
	readonly target: TargetDescriptor;
	readonly server: DebugConnectionInfo;
	/** False for a post-mortem session (core dump): no run control, breakpoints or writes. */
	readonly live: boolean;
	readonly budget: BreakpointBudget;
	readonly state: 'stopped' | 'running' | 'unknown';
	readonly lastStop: StopInfo | undefined;
	readonly hasSymbols: boolean;
	halt(): Promise<StopInfo>;
	/** Resumes; with `waitMs`, waits that long for the target to stop again (e.g. at a breakpoint). */
	resume(waitMs?: number): Promise<StopInfo | undefined>;
	step(kind: StepKind): Promise<StopInfo>;
	reset(mode: 'halt' | 'run'): Promise<StopInfo | undefined>;
	setBreakpoint(location: string, condition?: string): Promise<BreakpointInfo>;
	setWatchpoint(expression: string, access: 'r' | 'w' | 'rw'): Promise<BreakpointInfo>;
	clearBreakpoint(id: number): Promise<void>;
	breakpoints(): readonly BreakpointInfo[];
	readMemory(address: number, length: number): Promise<Uint8Array>;
	writeMemory(address: number, data: Uint8Array): Promise<void>;
	readCoreRegisters(): Promise<Record<string, string>>;
	evaluate(expression: string): Promise<string>;
	backtrace(maxFrames?: number): Promise<Frame[]>;
	locals(frame?: number): Promise<Variable[]>;
	/** Threads GDB knows: FreeRTOS tasks on ESP32 (GDB stub, core dump), cores or the one CPU otherwise. */
	threads(): Promise<ThreadInfo[]>;
	/** Makes `id` the current thread for backtrace, locals and evaluate. */
	selectThread(id: number): Promise<Frame | undefined>;
	peripherals(): Promise<{ name: string; baseAddress: string; description?: string }[]>;
	readPeripheral(name: string): Promise<DecodedPeripheral>;
	/**
	 * SVD registers overlapping `[address, address + length)`, with whether a read is safe, plus
	 * the peripheral itself (`name` without a register) for undescribed offsets inside its block.
	 * Peripheral bit-band aliases (0x42000000–0x43FFFFFF) are mapped to the registers they touch.
	 * Undefined when no SVD is available.
	 */
	registersIn(address: number, length: number): Promise<RegisterAt[] | undefined>;
	/** The last {@link readPeripheral} result for `name` in this session. */
	lastSnapshot(name: string): DecodedPeripheral | undefined;
	decodeCrash(): Promise<CrashDecode>;
	dispose(options?: { resume?: boolean }): Promise<void>;
}

export interface SessionStartOptions {
	readonly target: TargetDescriptor;
	/** Exactly one of `openocd`, `serial` and `coreFile` says how GDB reaches the target. */
	readonly openocd?: OpenOcdStartOptions;
	/** ESP-IDF's GDB stub on a serial port (CONFIG_ESP_SYSTEM_GDBSTUB_RUNTIME / PANIC_GDBSTUB). */
	readonly serial?: { readonly device: string; readonly baud: number };
	/** Workspace path of an ELF core file (an ESP-IDF core dump), opened post-mortem. */
	readonly coreFile?: string;
	readonly coreFacts?: CoreDumpFacts;
	/** Absolute path of GDB. */
	readonly gdb: string;
	/** Workspace-relative ELF with symbols (optional: without it, addresses only). */
	readonly elf?: string;
	/** Register descriptions, loaded on first use. */
	readonly svd?: () => Promise<SvdDevice>;
	/** Probe lock key, e.g. `stlink`. */
	readonly probe: string;
	/** Who holds the probe (agent id), for "probe busy" messages. */
	readonly owner: string;
	readonly signal?: AbortSignal;
	readonly log?: (message: string) => void;
}

/** Longest single memory read (bigger dumps flood the model's context; ask in pieces). */
export const MAX_READ_BYTES = 4096;
export const MAX_WRITE_BYTES = 256;
const STEP_TIMEOUT_MS = 10_000;
const MAX_EXPRESSION = 256;

/** Core registers of an architecture, as GDB names them. */
export function coreRegisters(arch: CoreArchitecture): readonly string[] {
	return arch === 'xtensa' ? XTENSA_CORE_REGISTERS : arch === 'riscv' ? RISCV_CORE_REGISTERS : CORTEX_M_CORE_REGISTERS;
}

/** Register names the agent may use as `$name` in expressions. */
function registerVariables(arch: CoreArchitecture): Set<string> {
	return new Set([...coreRegisters(arch), 'pc', 'sp', 'fp']);
}

/** Peripheral register space of a target, where a read can have side effects. */
export function peripheralRanges(target?: TargetDescriptor): readonly (readonly [number, number])[] {
	const esp = target?.vendor === 'esp32' ? espChip(target.part) : undefined;
	return esp ? esp.peripherals : [[PERIPHERAL_SPACE.from, PERIPHERAL_SPACE.to]];
}

/** Whether `[address, address + length)` touches peripheral space. */
export function inPeripheralSpace(target: TargetDescriptor | undefined, address: number, length: number): boolean {
	return peripheralRanges(target).some(([from, to]) => address <= to && address + length - 1 >= from);
}

/**
 * Expressions go to GDB, which can also assign, call target functions and run GDB's own
 * convenience functions (`$_shell` runs a shell command). Refuse those; GDB is additionally
 * configured with `may-write-memory`, `may-write-registers` and `may-call-functions` off.
 */
export function checkExpression(expression: string, target?: TargetDescriptor): string {
	const e = expression.trim();
	if (!e || e.length > MAX_EXPRESSION) {
		throw new DebugSessionError(`An expression must be 1–${MAX_EXPRESSION} characters.`);
	}
	if (/[\x00-\x1f\x7f]/.test(e)) {
		throw new DebugSessionError('Expressions cannot contain control characters.');
	}
	// Assignments (=, +=, <<=, …) but not comparisons (==, !=, <=, >=), and ++ / --.
	if (/(?<![=!<>])=(?!=)|<<=|>>=|\+\+|--/.test(e.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""'))) {
		throw new DebugSessionError('Expressions must not change the target (no assignments or ++/--); use write_memory, which asks the user.');
	}
	// Best effort, against accidents (not a boundary: pointer variables such as huart1.Instance->DR
	// are not recognised): a read through a literal peripheral address — `*(T *)0x4…`,
	// `((T *)0x4…)->F`, `((T *)0x4…)[i]`, `{T}0x4…` — goes through read_peripheral / read_memory,
	// which check the SVD, because reading some registers clears flags or pops a FIFO.
	for (const m of LITERAL_READS.flatMap(re => [...e.matchAll(re)])) {
		const n = parseCLiteral(m.groups!.lit);
		if (n !== undefined && inPeripheralSpace(target, n, 1)) {
			throw new DebugSessionError('Expressions may not read through a literal peripheral address (reading some registers clears flags or pops a FIFO); use read_peripheral or read_memory, which check the register first.');
		}
	}
	const registers = registerVariables(target?.arch ?? 'cortex-m');
	for (const m of e.matchAll(/\$([A-Za-z_]\w*)/g)) {
		if (!registers.has(m[1].toLowerCase())) {
			throw new DebugSessionError(`"$${m[1]}" is not allowed in expressions (only core registers such as $pc, $sp, ${target?.arch === 'xtensa' ? '$a2' : target?.arch === 'riscv' ? '$a0' : '$r0'}).`);
		}
	}
	return e;
}

const LOCATION = /^(?:\*0x[0-9a-fA-F]{1,8}|[\w./+-]+:\d{1,7}|[\w./+-]+:[A-Za-z_]\w*|[A-Za-z_][\w:]*)$/;

/** Breakpoint locations: `main`, `file.c:42`, `file.c:func`, `*0x08000100`. */
export function checkLocation(location: string): string {
	const l = location.trim();
	if (!LOCATION.test(l) || l.startsWith('-') || l.length > 256) {
		throw new DebugSessionError(`"${location}" is not a breakpoint location (use a function name, file.c:LINE, file.c:function or *0xADDRESS).`);
	}
	return l;
}

function toStopInfo(event: StopEvent | undefined): StopInfo | undefined {
	if (!event) {
		return undefined;
	}
	const r = event.results;
	const frame = miTuple(r.frame);
	const line = Number(miString(frame?.line));
	const bkpt = Number(miString(r.bkptno));
	const fn = miString(frame?.func);
	const file = miString(frame?.file);
	const pc = miString(frame?.addr);
	const signal = miString(r['signal-name']);
	return {
		...event.reason ? { reason: event.reason } : {},
		...pc ? { pc } : {},
		...fn && fn !== '??' ? { function: fn } : {},
		...file ? { file } : {},
		...Number.isFinite(line) && line > 0 ? { line } : {},
		...Number.isFinite(bkpt) && bkpt > 0 ? { breakpoint: bkpt } : {},
		...signal ? { signal } : {},
	};
}

function toFrame(value: MiValue): Frame | undefined {
	const f = miTuple(value);
	if (!f) {
		return undefined;
	}
	const line = Number(miString(f.line));
	const fn = miString(f.func);
	const file = miString(f.file);
	return {
		level: Number(miString(f.level) ?? 0),
		address: miString(f.addr) ?? '?',
		...fn && fn !== '??' ? { function: fn } : {},
		...file ? { file } : {},
		...Number.isFinite(line) && line > 0 ? { line } : {},
	};
}

function hexToBytes(contents: string): Uint8Array {
	const out = new Uint8Array(contents.length / 2);
	for (let k = 0; k < out.length; k++) {
		out[k] = parseInt(contents.slice(k * 2, k * 2 + 2), 16);
	}
	return out;
}

function bytesToHex(data: Uint8Array): string {
	return [...data].map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The data access a load/store instruction makes, from GDB's disassembly: Xtensa
 * `l32i.n a2, a8, 0` / `s32i a3, a1, 16`, RISC-V `lw a5,0(a5)` / `sw a4,8(sp)`.
 */
export function memoryAccess(arch: 'xtensa' | 'riscv', instruction: string | undefined): { access: 'read' | 'write'; base: string; offset: number } | undefined {
	if (!instruction) {
		return undefined;
	}
	const m = arch === 'xtensa'
		? /^(?<op>l(?:32i|16ui|16si|8ui|32ai|32e)|s(?:32i|16i|8i|32ri|32c1i|32e))(?:\.n)?\s+a\d+,\s*(?<base>a\d+),\s*(?<off>-?(?:0x[0-9a-fA-F]+|\d+))\b/.exec(instruction)
		: /^(?:c\.)?(?<op>l(?:b|bu|h|hu|w)|s(?:b|h|w)|flw|fsw)\s+\w+,\s*(?<off>-?(?:0x[0-9a-fA-F]+|\d+))\((?<base>\w+)\)/.exec(instruction);
	if (!m) {
		return undefined;
	}
	const op = m.groups!.op;
	const off = m.groups!.off;
	const offset = off.startsWith('-') ? -Number(off.slice(1)) : Number(off);
	return { access: /^(?:s|fs)/.test(op) ? 'write' : 'read', base: m.groups!.base, offset };
}

/**
 * Memory a core-dump session may read, from GDB's `maint info sections`: the core file's loaded
 * segments (what was really dumped) and the ELF's read-only sections and flash-mapped data
 * (identical on the chip). Sorted, merged ranges [from, to).
 */
export function coreMemoryRegions(sections: string): [number, number][] {
	const out: [number, number][] = [];
	let file: 'exec' | 'core' | undefined;
	for (const line of sections.split('\n')) {
		if (/^\s*Exec file:/.test(line)) {
			file = 'exec';
			continue;
		}
		if (/^\s*Core file:/.test(line)) {
			file = 'core';
			continue;
		}
		const m = /^\s*\[\d+\]\s+0x(?<from>[0-9a-fA-F]+)->0x(?<to>[0-9a-fA-F]+) at 0x[0-9a-fA-F]+: (?<name>\S+) (?<flags>.*)$/.exec(line);
		if (!m || !file) {
			continue;
		}
		const from = parseInt(m.groups!.from, 16);
		const to = parseInt(m.groups!.to, 16);
		const flags = m.groups!.flags;
		const loaded = /\bALLOC\b/.test(flags) && /\bLOAD\b/.test(flags) && /\bHAS_CONTENTS\b/.test(flags);
		const keep = file === 'core' ? loaded : loaded && (/\bREADONLY\b/.test(flags) || /^\.flash\./.test(m.groups!.name));
		if (keep && to > from) {
			out.push([from, to]);
		}
	}
	out.sort((a, b) => a[0] - b[0]);
	const merged: [number, number][] = [];
	for (const r of out) {
		const last = merged[merged.length - 1];
		if (last && r[0] <= last[1]) {
			last[1] = Math.max(last[1], r[1]);
		} else {
			merged.push([r[0], r[1]]);
		}
	}
	return merged.slice(0, 256);
}

/** Serial-device paths the GDB stub transport accepts (GDB opens them itself). */
const SERIAL_DEVICE = /^\/dev\/(?:tty(?:USB|ACM|S|AMA|SAC)\d{1,3}|cu\.[\w.-]{1,64}|tty\.[\w.-]{1,64})$/;
const SERIAL_BAUDS = new Set([9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600]);

/** The long-lived program behind GDB (OpenOCD), if any: a GDB stub or a core file has none. */
interface GdbBackend {
	readonly exited: Promise<unknown>;
	stop(): Promise<void>;
	tail(lines: number): string;
}

/**
 * GDB/MI as the debugger for every target, reaching it through OpenOCD (any probe), ESP-IDF's
 * GDB stub on a serial port, or an ELF core file (post-mortem).
 */
export class OpenOcdGdbSession implements ITargetSession {
	private readonly bps = new Map<number, BreakpointInfo>();
	private registerNames: string[] | undefined;
	private disposed = false;
	private ended: string | undefined;
	private readonly snapshots = new Map<string, DecodedPeripheral>();
	/**
	 * ESP-IDF's stub (v6.1, verified on an ESP32): after a single-step, watchpoints set later do
	 * not trigger until the CPU has stopped at a breakpoint or watchpoint again.
	 */
	private steppedSinceBreak = false;
	/**
	 * The debugger itself stopped the target (attach or halt). ESP-IDF's stub then reports a
	 * signal made from a stale exception cause, which is not a crash.
	 */
	private haltedByDebugger = false;
	/** GDB stub without symbols for its panic state: a stop signal may be real or stale. */
	private signalUncertain = false;

	private constructor(
		readonly target: TargetDescriptor,
		readonly server: DebugConnectionInfo,
		private readonly backend: GdbBackend | undefined,
		private readonly gdb: IProcessHandle,
		private readonly mi: GdbMiClient,
		private readonly lock: IDisposable,
		readonly budget: BreakpointBudget,
		readonly hasSymbols: boolean,
		private readonly svd: (() => Promise<SvdDevice>) | undefined,
		private readonly gdbStderr: string[],
		records: ((record: MiRecord) => void)[],
		private readonly coreFacts: CoreDumpFacts | undefined,
	) {
		// GDB deletes some breakpoints itself (a watchpoint whose variable went out of scope).
		records.push(record => {
			if (record.kind === 'notify' && record.asyncClass === 'breakpoint-deleted') {
				this.bps.delete(Number(miString(record.results.id)));
			} else if (record.kind === 'exec' && record.asyncClass === 'stopped' && miString(record.results.reason) === 'watchpoint-scope') {
				this.bps.delete(Number(miString(record.results.wpnum)));
			}
		});
		void gdb.exited.then(e => this.markEnded(`GDB exited (${e.spawnError ?? `exit ${e.exitCode}`})`));
		void backend?.exited.then(() => this.markEnded('OpenOCD exited (probe unplugged or target lost?)'));
	}

	get live(): boolean {
		return this.server.transport !== 'core-dump';
	}

	get state(): 'stopped' | 'running' | 'unknown' {
		return this.ended ? 'unknown' : this.live ? this.mi.state : 'stopped';
	}

	get lastStop(): StopInfo | undefined {
		const stop = toStopInfo(this.mi.lastStop);
		if (stop && this.server.transport === 'gdb-stub' && this.haltedByDebugger && (stop.reason === undefined || stop.reason === 'signal-received')) {
			const { signal: _ignored, ...rest } = stop;
			return { ...rest, reason: 'interrupted' };
		}
		return stop;
	}

	static async start(host: IAgentHost, options: SessionStartOptions): Promise<OpenOcdGdbSession> {
		if (!host.spawn) {
			throw new DebugSessionError('This host cannot run long-lived programs, so it cannot start a debug session.');
		}
		const transports = [options.openocd, options.serial, options.coreFile].filter(x => x !== undefined).length;
		if (transports !== 1) {
			throw new DebugSessionError('A debug session needs exactly one of: a debug probe (OpenOCD), a serial GDB stub, or a core file.');
		}
		if (options.serial && (!SERIAL_DEVICE.test(options.serial.device) || !SERIAL_BAUDS.has(options.serial.baud))) {
			throw new DebugSessionError(`"${options.serial.device}" at ${options.serial.baud} baud is not a serial port the debugger may open.`);
		}
		const workspaceFile = async (path: string, what: string) => {
			if (!await host.fs.exists(path)) {
				throw new DebugSessionError(`${what} "${path}" not found in the workspace.`);
			}
			// The real path (inside the workspace; NodeFileSystem refuses links that leave it).
			const real = await host.fs.realPath(path);
			miQuote(real);
			return real;
		};
		const elf = options.elf ? await workspaceFile(options.elf, 'ELF file') : undefined;
		const coreFile = options.coreFile ? await workspaceFile(options.coreFile, 'Core file') : undefined;
		if (coreFile && !elf) {
			throw new DebugSessionError('A core dump needs the ELF of the program that crashed (pass "elf").');
		}
		// A core file needs no probe; the serial port and the probe are exclusive.
		const lock = coreFile ? { dispose: () => { } } : acquireProbe(options.probe, options.owner);
		let openocd: OpenOcdServer | undefined;
		let gdb: IProcessHandle | undefined;
		try {
			openocd = options.openocd ? await OpenOcdServer.start(host, options.openocd) : undefined;
			const stderr: string[] = [];
			// GDB is started right below; nothing is written to it before.
			const records: ((record: MiRecord) => void)[] = [];
			const client = new GdbMiClient(text => gdb?.write(text), record => records.forEach(listener => listener(record)));
			gdb = host.spawn(options.gdb, [
				'--interpreter=mi3', '-nx', '-q',
				// Never run scripts that come with the ELF or the project.
				'-iex', 'set auto-load off',
				'-iex', 'set history save off',
				'-iex', 'set debuginfod enabled off',
			], {
				onOutput: (stream, chunk) => {
					if (stream === 'stdout') {
						client.feed(chunk);
					} else if (stderr.length < 100) {
						stderr.push(chunk);
					}
				},
			});
			const handle = gdb;
			void handle.exited.then(e => client.close(e.spawnError ?? `exit ${e.exitCode}`));
			const mi = client;
			const signal = options.signal;
			const send = (command: string, timeoutMs = 10_000) => mi.send(command, { timeoutMs, ...signal ? { signal } : {} });
			for (const setting of [
				'mi-async on', 'confirm off', 'pagination off', 'width 0', 'print pretty off', 'print elements 64',
				'mem inaccessible-by-default off',
				// Read-only by default: the agent's approved write tool lifts this for one write.
				'may-write-memory off', 'may-write-registers off', 'may-call-functions off',
			]) {
				await send(`-gdb-set ${setting}`);
			}
			if (elf) {
				await send(`-file-exec-and-symbols ${miQuote(elf)}`, 30_000);
			}
			let server: DebugConnectionInfo;
			let budget: BreakpointBudget | undefined;
			if (openocd) {
				// Attaching halts the target (OpenOCD's gdb-attach event); the *stopped arrives with it.
				const stopped = mi.waitForStop({ timeoutMs: 15_000 });
				stopped.catch(() => { });
				const port = openocd.info.port;
				if (!Number.isInteger(port) || port < 1 || port > 65535) {
					throw new DebugSessionError(`OpenOCD reported an invalid port ${port}.`);
				}
				// Not quoted: GDB takes a quoted "host:port" literally.
				await send(`-target-select remote 127.0.0.1:${port}`, 20_000);
				await stopped.catch(() => undefined);
				const { budget: openocdBudget, ...info } = openocd.info;
				server = { transport: 'openocd', ...info };
				budget = openocdBudget ?? (options.target.vendor === 'esp32' ? espBudget(options.target.part) : undefined);
				if (!budget && options.target.arch === 'cortex-m') {
					const fp = await OpenOcdGdbSession.readWord(mi, FP_CTRL);
					const dwt = await OpenOcdGdbSession.readWord(mi, DWT_CTRL);
					budget = budgetFromControlRegisters(fp, dwt);
				}
			} else if (options.serial) {
				// ESP-IDF's runtime stub only listens after a Ctrl-C byte: GDB sends one on connect.
				// A stub entered by a panic ignores it. The stub answers with the stop reason.
				for (const setting of [`serial baud ${options.serial.baud}`, 'remote interrupt-on-connect on', 'remotetimeout 5']) {
					await send(`-gdb-set ${setting}`);
				}
				const stopped = mi.waitForStop({ timeoutMs: 20_000 });
				stopped.catch(() => { });
				try {
					// Not quoted (GDB would take the quotes literally); SERIAL_DEVICE allows no spaces or quotes.
					await send(`-target-select remote ${options.serial.device}`, 25_000);
				} catch (err) {
					if (err instanceof MiError && err.kind === 'timeout') {
						throw new DebugSessionError(`No GDB stub answered on ${options.serial.device}. The firmware needs CONFIG_ESP_SYSTEM_GDBSTUB_RUNTIME=y (live) or CONFIG_ESP_SYSTEM_PANIC_GDBSTUB=y (after a crash), and nothing else (a serial monitor) may hold the port.`);
					}
					throw err;
				}
				await stopped.catch(() => undefined);
				server = { transport: 'gdb-stub', device: options.serial.device, probe: `ESP-IDF GDB stub on ${options.serial.device} (${options.serial.baud} baud)` };
				budget = espBudget(options.target.part);
			} else {
				await send(`-target-select core ${miQuote(coreFile!)}`, 30_000);
				// GDB would read memory the dump lacks (globals, heap) from the ELF: initial values,
				// zeros for .bss. Only the dump's segments and the ELF's read-only code/flash data are real.
				const sections = (await send(`-interpreter-exec console ${miQuote('maint info sections')}`, 30_000)).output;
				const regions = coreMemoryRegions(sections);
				if (regions.length) {
					await send('-gdb-set mem inaccessible-by-default on');
					for (const [from, to] of regions) {
						await send(`-interpreter-exec console ${miQuote(`mem ${hex(from)} ${hex(to)} ro`)}`);
					}
				}
				server = { transport: 'core-dump', coreFile: options.coreFile!, probe: 'core dump (post-mortem, no target)' };
				budget = { breakpoints: 0, watchpoints: 0 };
			}
			options.log?.(`Debug session on ${options.target.part}: ${server.probe ?? options.probe}${server.core ? `, ${server.core}` : ''}${server.port ? `, port ${server.port}` : ''}`);
			const backend: GdbBackend | undefined = openocd;
			const session = new OpenOcdGdbSession(options.target, server, backend, handle, mi, lock, budget ?? { breakpoints: 2, watchpoints: 1 }, !!elf, options.svd, stderr, records, options.coreFacts);
			if (options.serial && (options.target.arch === 'xtensa' || options.target.arch === 'riscv')) {
				// Attaching interrupts a running program (its stop signal is stale) unless the chip
				// already sits in the panic stub (then the signal is real). Without symbols, unknown.
				const panic = elf ? await session.stubPanicFacts(options.target.arch) : { state: 'unknown' as const };
				session.haltedByDebugger = panic.state === 'running';
				session.signalUncertain = panic.state === 'unknown';
			}
			return session;
		} catch (err) {
			await gdb?.kill();
			await openocd?.stop();
			lock.dispose();
			if (err instanceof MiError) {
				throw new DebugSessionError(`GDB: ${err.message}${openocd ? `\nOpenOCD: ${openocd.tail(8)}` : ''}`);
			}
			throw err;
		}
	}

	private static async readWord(mi: GdbMiClient, address: number): Promise<number> {
		const r = await mi.send(`-data-read-memory-bytes ${hex(address)} 4`);
		const block = miTuple(miList(r.results.memory)[0]);
		return readLittleEndian(hexToBytes(miString(block?.contents) ?? '00000000'), 0, 32);
	}

	private markEnded(reason: string): void {
		if (!this.ended) {
			this.ended = reason;
			this.mi.close(reason);
		}
	}

	private alive(): void {
		if (this.disposed) {
			throw new DebugSessionError('The debug session has ended; start a new one.');
		}
		if (this.ended) {
			throw new DebugSessionError(`The debug session has ended: ${this.ended}. ${this.gdbStderr.join('').slice(-300)}`.trim());
		}
	}

	private stoppedOnly(what: string): void {
		this.alive();
		if (this.live && this.mi.state === 'running') {
			throw new DebugSessionError(`The target is running; halt it before ${what}.`);
		}
	}

	/** Run control, breakpoints and writes need a live target. */
	private liveOnly(what: string): void {
		this.alive();
		if (!this.live) {
			throw new DebugSessionError(`This is a core dump (a snapshot of the crash): ${what} needs a live target. Read registers, memory, threads, backtraces and variables instead.`);
		}
	}

	private async send(command: string, timeoutMs = 10_000) {
		this.alive();
		try {
			return await this.mi.send(command, { timeoutMs });
		} catch (err) {
			if (err instanceof MiError && err.kind === 'error') {
				if (!this.live && /Cannot access memory/.test(err.message)) {
					throw new DebugSessionError(`${err.message}: not in the core dump. ESP-IDF dumps task stacks and TCBs only; globals and the heap need CONFIG_ESP_COREDUMP_CAPTURE_DRAM=y.`);
				}
				throw new DebugSessionError(err.message);
			}
			throw err;
		}
	}

	/** Runs the target with `command` until it stops; GDB errors become {@link DebugSessionError}. */
	private async runUntilStop(command: string, timeoutMs: number): Promise<StopEvent> {
		this.alive();
		try {
			return await this.mi.runUntilStop(command, { timeoutMs });
		} catch (err) {
			if (err instanceof MiError && err.kind === 'error') {
				throw new DebugSessionError(err.message);
			}
			throw err;
		}
	}

	private async console(command: string, timeoutMs = 15_000): Promise<string> {
		return (await this.send(`-interpreter-exec console ${miQuote(command)}`, timeoutMs)).output;
	}

	async halt(): Promise<StopInfo> {
		this.alive();
		if (!this.live || this.mi.state === 'stopped') {
			return this.lastStop ?? await this.currentFrameStop();
		}
		const stop = toStopInfo(await this.runUntilStop('-exec-interrupt', 5_000))!;
		this.haltedByDebugger = true;
		if (this.server.transport === 'gdb-stub') {
			// The stub's signal for a Ctrl-C stop comes from a stale exception cause.
			const { signal: _ignored, ...rest } = stop;
			return { ...rest, reason: 'interrupted' };
		}
		return stop;
	}

	/** Where a core dump (no stop event) stands: frame 0 of the current thread. */
	private async currentFrameStop(): Promise<StopInfo> {
		const r = await this.send('-stack-info-frame').catch(() => undefined);
		const f = r && toFrame(r.results.frame);
		return f ? { reason: this.live ? 'stopped' : 'core dump', pc: f.address, ...f.function ? { function: f.function } : {}, ...f.file ? { file: f.file } : {}, ...f.line ? { line: f.line } : {} } : {};
	}

	async resume(waitMs = 0): Promise<StopInfo | undefined> {
		this.liveOnly('resuming');
		this.stoppedOnly('resuming');
		this.haltedByDebugger = false;
		if (waitMs <= 0) {
			await this.send('-exec-continue');
			return undefined;
		}
		try {
			const stop = toStopInfo(await this.runUntilStop('-exec-continue', waitMs));
			if (stop?.reason === 'breakpoint-hit' || stop?.reason === 'watchpoint-trigger' || stop?.reason === 'read-watchpoint-trigger' || stop?.reason === 'access-watchpoint-trigger') {
				this.steppedSinceBreak = false;
			}
			return stop;
		} catch (err) {
			if (err instanceof MiError && err.kind === 'timeout' && this.mi.state === 'running') {
				return undefined; // still running: no breakpoint hit in time
			}
			throw err;
		}
	}

	async step(kind: StepKind): Promise<StopInfo> {
		this.liveOnly('stepping');
		this.stoppedOnly('stepping');
		if (kind !== 'instruction' && !this.hasSymbols) {
			throw new DebugSessionError('Source-level stepping needs the ELF with symbols; start the session with "elf", or step by instruction.');
		}
		if (kind === 'out' && this.hardwareBreakpointsUsed() >= this.budget.breakpoints) {
			throw new DebugSessionError('Stepping out needs a free hardware breakpoint; clear one first.');
		}
		const command = { instruction: '-exec-step-instruction', over: '-exec-next', into: '-exec-step', out: '-exec-finish' }[kind];
		this.haltedByDebugger = false;
		try {
			this.steppedSinceBreak = true;
			return toStopInfo(await this.runUntilStop(command, STEP_TIMEOUT_MS))!;
		} catch (err) {
			if (err instanceof MiError && err.kind === 'timeout' && this.mi.state === 'running') {
				const stop = await this.halt();
				return { ...stop, reason: `step did not finish within ${STEP_TIMEOUT_MS / 1000} s (a long loop or a wait?); halted here` };
			}
			throw err;
		}
	}

	async reset(mode: 'halt' | 'run'): Promise<StopInfo | undefined> {
		this.liveOnly('reset');
		if (this.server.transport !== 'openocd') {
			throw new DebugSessionError('The GDB stub cannot reset the chip. End the session and use read_serial with reset (or press the board\'s EN/RST button).');
		}
		await this.halt();
		await this.console('monitor reset halt');
		// GDB does not know OpenOCD reset the core: drop its cached registers and frames.
		await this.console('maintenance flush register-cache');
		if (mode === 'run') {
			await this.send('-exec-continue');
			return undefined;
		}
		return { reason: 'reset', pc: await this.evaluate('$pc') };
	}

	private hardwareBreakpointsUsed(): number {
		return [...this.bps.values()].filter(b => b.kind === 'breakpoint').reduce((n, b) => n + (b.locations ?? 1), 0);
	}

	async setBreakpoint(location: string, condition?: string): Promise<BreakpointInfo> {
		this.liveOnly('setting breakpoints');
		const loc = checkLocation(location);
		const cond = condition !== undefined ? checkExpression(condition, this.target) : undefined;
		// Keep one comparator free: `next` and `finish` need a temporary breakpoint.
		const limit = Math.max(1, this.budget.breakpoints - 1);
		if (this.hardwareBreakpointsUsed() >= limit) {
			throw new DebugSessionError(`All ${limit} usable hardware breakpoints are in use (the core has ${this.budget.breakpoints}, one is kept for stepping); clear one first.`);
		}
		if (!this.hasSymbols && !loc.startsWith('*')) {
			throw new DebugSessionError('Without the ELF only address breakpoints (*0x…) work; start the session with "elf".');
		}
		// OpenOCD: hardware breakpoints (Z1). ESP-IDF's stub answers only Z0 and places it in a
		// hardware comparator itself (it never patches code).
		const kind = this.server.transport === 'openocd' ? '-h ' : '';
		const r = await this.send(`-break-insert ${kind}${cond !== undefined ? `-c ${miQuote(cond)} ` : ''}${miQuote(loc)}`);
		const b = miTuple(miList(r.results.bkpt)[0]);
		const id = Number(miString(b?.number));
		if (!Number.isFinite(id)) {
			throw new DebugSessionError('GDB did not report the breakpoint number.');
		}
		const address = miString(b?.addr);
		// `addr="<MULTIPLE>"`: one comparator per location (e.g. an inlined function).
		const locations = Math.max(1, miList(b?.locations).length);
		if (this.hardwareBreakpointsUsed() + locations > limit) {
			await this.send(`-break-delete ${id}`).catch(() => undefined);
			throw new DebugSessionError(`"${loc}" has ${locations} code locations (inlined?), which needs ${locations} hardware breakpoints; only ${limit - this.hardwareBreakpointsUsed()} are free. Break on file.c:LINE inside it instead.`);
		}
		const info: BreakpointInfo = { id, kind: 'breakpoint', location: loc, ...address && address !== '<MULTIPLE>' ? { address } : {}, ...locations > 1 ? { locations } : {}, ...cond ? { condition: cond } : {} };
		this.bps.set(id, info);
		return info;
	}

	async setWatchpoint(expression: string, access: 'r' | 'w' | 'rw'): Promise<BreakpointInfo> {
		this.liveOnly('setting watchpoints');
		const expr = checkExpression(expression, this.target);
		if (this.server.transport === 'gdb-stub' && this.steppedSinceBreak) {
			// Verified on an ESP32 with ESP-IDF v6.1: such a watchpoint never triggers.
			throw new DebugSessionError('ESP-IDF\'s GDB stub does not arm watchpoints set after a step until the CPU stops at a breakpoint again: resume to a breakpoint first, then set the watchpoint (or set watchpoints before stepping).');
		}
		const used = [...this.bps.values()].filter(b => b.kind === 'watchpoint').length;
		if (used >= this.budget.watchpoints) {
			throw new DebugSessionError(`All ${this.budget.watchpoints} hardware watchpoints are in use; clear one first.`);
		}
		const flag = access === 'r' ? '-r ' : access === 'rw' ? '-a ' : '';
		const r = await this.send(`-break-watch ${flag}${miQuote(expr)}`);
		const w = miTuple(r.results.wpt) ?? miTuple(r.results['hw-rwpt']) ?? miTuple(r.results['hw-awpt']);
		const id = Number(miString(w?.number));
		if (!Number.isFinite(id)) {
			throw new DebugSessionError('GDB did not report the watchpoint number.');
		}
		const info: BreakpointInfo = { id, kind: 'watchpoint', location: expr, access };
		this.bps.set(id, info);
		return info;
	}

	async clearBreakpoint(id: number): Promise<void> {
		if (!this.bps.has(id)) {
			throw new DebugSessionError(`There is no breakpoint or watchpoint ${id}.`);
		}
		try {
			await this.send(`-break-delete ${id}`);
		} catch (err) {
			// Already gone on GDB's side (deleted by GDB itself): just forget it.
			if (!(err instanceof DebugSessionError && /No breakpoint number/i.test(err.message))) {
				throw err;
			}
		}
		this.bps.delete(id);
	}

	breakpoints(): readonly BreakpointInfo[] {
		return [...this.bps.values()];
	}

	async readMemory(address: number, length: number): Promise<Uint8Array> {
		this.stoppedOnly('reading memory');
		if (!Number.isInteger(address) || address < 0 || address > 0xFFFFFFFF || !Number.isInteger(length) || length < 1 || length > MAX_READ_BYTES || address + length > 0x100000000) {
			throw new DebugSessionError(`Read 1–${MAX_READ_BYTES} bytes inside the 32-bit address space.`);
		}
		const r = await this.send(`-data-read-memory-bytes ${hex(address)} ${length}`);
		const out = new Uint8Array(length);
		let covered = 0;
		for (const block of miList(r.results.memory).map(miTuple)) {
			const begin = Number(miString(block?.begin));
			const bytes = hexToBytes(miString(block?.contents) ?? '');
			out.set(bytes.subarray(0, Math.max(0, length - (begin - address))), begin - address);
			covered += bytes.length;
		}
		if (covered < length) {
			throw new DebugSessionError(`Only ${covered} of ${length} bytes at ${hex(address)} are readable.`);
		}
		return out;
	}

	async writeMemory(address: number, data: Uint8Array): Promise<void> {
		this.liveOnly('writing memory');
		this.stoppedOnly('writing memory');
		if (!Number.isInteger(address) || address < 0 || data.length < 1 || data.length > MAX_WRITE_BYTES || address + data.length > 0x100000000) {
			throw new DebugSessionError(`Write 1–${MAX_WRITE_BYTES} bytes inside the 32-bit address space.`);
		}
		await this.send('-gdb-set may-write-memory on');
		try {
			await this.send(`-data-write-memory-bytes ${hex(address)} ${bytesToHex(data)}`);
		} finally {
			await this.send('-gdb-set may-write-memory off').catch(() => undefined);
		}
	}

	async readCoreRegisters(): Promise<Record<string, string>> {
		this.stoppedOnly('reading registers');
		if (!this.registerNames) {
			const r = await this.send('-data-list-register-names');
			this.registerNames = miList(r.results['register-names']).map(v => miString(v) ?? '');
		}
		const names = coreRegisters(this.target.arch);
		const wanted = this.registerNames.map((name, index) => ({ name, index })).filter(x => names.includes(x.name));
		const r = await this.send(`-data-list-register-values x ${wanted.map(w => w.index).join(' ')}`);
		const values = new Map(miList(r.results['register-values']).map(miTuple).map(t => [Number(miString(t?.number)), miString(t?.value) ?? '']));
		// A register the stub or the core file does not provide reads as <unavailable>: leave it out.
		return Object.fromEntries(wanted.map(w => [w.name, values.get(w.index) ?? '?']).filter(([, v]) => v && !/unavailable/.test(v)));
	}

	async evaluate(expression: string): Promise<string> {
		this.stoppedOnly('evaluating expressions');
		const r = await this.send(`-data-evaluate-expression ${miQuote(checkExpression(expression, this.target))}`);
		return miString(r.results.value) ?? '';
	}

	async backtrace(maxFrames = 16): Promise<Frame[]> {
		this.stoppedOnly('reading the backtrace');
		const n = Math.max(1, Math.min(64, Math.floor(maxFrames)));
		const r = await this.send(`-stack-list-frames 0 ${n - 1}`);
		return miList(r.results.stack).map(toFrame).filter((f): f is Frame => !!f);
	}

	async locals(frame = 0): Promise<Variable[]> {
		this.stoppedOnly('reading variables');
		const f = Math.max(0, Math.min(63, Math.floor(frame)));
		const thread = await this.currentThreadId();
		const r = await this.send(`-stack-list-variables --thread ${thread} --frame ${f} --simple-values`);
		return miList(r.results.variables).map(miTuple).filter((v): v is MiTuple => !!v).map(v => {
			const type = miString(v.type);
			const value = miString(v.value);
			return { name: miString(v.name) ?? '?', ...type ? { type } : {}, ...value !== undefined ? { value } : {} };
		});
	}

	private async currentThreadId(): Promise<number> {
		const r = await this.send('-thread-info').catch(() => undefined);
		const id = Number(miString(r?.results['current-thread-id']));
		return Number.isInteger(id) && id > 0 ? id : 1;
	}

	async threads(): Promise<ThreadInfo[]> {
		this.stoppedOnly('listing threads');
		const r = await this.send('-thread-info', 30_000);
		const current = Number(miString(r.results['current-thread-id']));
		const out: ThreadInfo[] = [];
		for (const t of miList(r.results.threads).map(miTuple).slice(0, 64)) {
			const id = Number(miString(t?.id));
			if (!t || !Number.isInteger(id)) {
				continue;
			}
			const targetId = miString(t['target-id']) ?? '';
			const frame = toFrame(t.frame);
			const details = miString(t.details) ?? '';
			let name = /Name: ([^\s)]+)/.exec(`${targetId} ${details}`)?.[1] ?? miString(t.name);
			const state = /State: ([^@)]+?)\s*(?:@|$|\))/.exec(details)?.[1];
			// A core dump names each task by its TCB address ("process 1073412600"): read the name from the TCB.
			const tcb = /^process (\d+)$/.exec(targetId);
			if (!name && tcb && this.hasSymbols) {
				const v = await this.send(`-data-evaluate-expression ${miQuote(`((TCB_t *)${tcb[1]})->pcTaskName`)}`).catch(() => undefined);
				name = /"([^"]*)"/.exec(miString(v?.results.value) ?? '')?.[1]?.replace(/\\0.*$/, '') || undefined;
			}
			out.push({ id, targetId, ...name ? { name } : {}, ...state ? { state } : {}, current: id === current, ...frame ? { frame } : {} });
		}
		return out;
	}

	async selectThread(id: number): Promise<Frame | undefined> {
		this.stoppedOnly('selecting a thread');
		if (!Number.isInteger(id) || id < 1) {
			throw new DebugSessionError(`"${id}" is not a thread id (see threads).`);
		}
		const r = await this.send(`-thread-select ${id}`);
		return toFrame(r.results.frame);
	}

	private async device(): Promise<SvdDevice> {
		if (!this.svd) {
			throw new DebugSessionError(`No register descriptions (SVD) for ${this.target.part}; restart the session with an "svd" path.`);
		}
		return this.svd();
	}

	async peripherals(): Promise<{ name: string; baseAddress: string; description?: string }[]> {
		return (await this.device()).peripherals.map(p => ({ name: p.name, baseAddress: hex(p.baseAddress), ...p.description ? { description: p.description } : {} }));
	}

	async readPeripheral(name: string): Promise<DecodedPeripheral> {
		this.stoppedOnly('reading peripherals');
		const device = await this.device();
		const p = findPeripheral(device, name);
		if (!p) {
			throw new DebugSessionError(`${device.name} has no peripheral "${name}". Use list_peripherals to see the names.`);
		}
		const registers = [];
		const skipped: SkippedRegister[] = [];
		for (const reg of p.registers) {
			const readable = readableRegister(reg);
			if (!readable.ok) {
				skipped.push({ name: reg.name, reason: readable.reason });
				continue;
			}
			const bytes = await this.readMemory(p.baseAddress + reg.offset, reg.size / 8);
			registers.push(decodeRegister(p, reg, readLittleEndian(bytes, 0, reg.size)));
		}
		const decoded: DecodedPeripheral = { name: p.name, baseAddress: hex(p.baseAddress), ...p.description ? { description: p.description } : {}, registers, skipped };
		this.snapshots.set(p.name, decoded);
		return decoded;
	}

	async registersIn(address: number, length: number): Promise<RegisterAt[] | undefined> {
		const device = this.svd ? await this.svd().catch(() => undefined) : undefined;
		if (!device) {
			return undefined;
		}
		[address, length] = bitBandTarget(address, length);
		const out: RegisterAt[] = [];
		for (const p of device.peripherals) {
			let hit = false;
			let blockEnd = p.baseAddress;
			for (const r of p.registers) {
				const start = p.baseAddress + r.offset;
				blockEnd = Math.max(blockEnd, start + r.size / 8);
				if (start < address + length && start + r.size / 8 > address) {
					hit = true;
					const readable = readableRegister(r);
					out.push({ name: `${p.name}.${r.name}`, address: hex(start), ...readable.ok ? {} : { unreadable: readable.reason } });
				}
			}
			if (!hit && p.baseAddress < address + length && blockEnd > address) {
				out.push({ name: p.name, address: hex(p.baseAddress) });
			}
		}
		return out;
	}

	/** The last decode of a peripheral in this session (for before/after comparisons). */
	lastSnapshot(name: string): DecodedPeripheral | undefined {
		return [...this.snapshots.entries()].find(([n]) => n.toUpperCase() === name.trim().toUpperCase())?.[1];
	}

	async decodeCrash(): Promise<CrashDecode> {
		this.stoppedOnly('decoding a crash');
		if (this.target.arch === 'xtensa' || this.target.arch === 'riscv') {
			return this.decodeEspCrash(this.target.arch);
		}
		const scb = await this.readMemory(SCB.SHCSR, SCB.AFSR + 4 - SCB.SHCSR);
		const word = (address: number) => readLittleEndian(scb, address - SCB.SHCSR, 32);
		const regs = await this.readCoreRegisters();
		const num = (name: string) => Number(regs[name] ?? 0);
		const lr = num('lr');
		// Only an exception handler has a stacked frame to look at (IPSR = exception number).
		const stackedFrom = (num('xpsr') & 0x1FF) !== 0 ? stackFromExcReturn(lr) : undefined;
		let stackedWords: number[] | undefined;
		let frameNote: string | undefined;
		if (stackedFrom) {
			// A handler that pushes registers first (e.g. `push {r7}` at -O0) moves MSP below the
			// exception frame. GDB's unwinder knows the handler's frame address (its CFA), which is
			// where the frame starts. The PSP is untouched by handlers.
			let sp = stackedFrom === 'PSP' ? num('psp') : num('msp');
			if (stackedFrom === 'MSP') {
				const cfa = this.hasSymbols ? await this.frameAddress() : undefined;
				if (cfa !== undefined) {
					sp = cfa;
				} else {
					frameNote = 'The frame was read at the current MSP (no symbols to unwind the handler); if the handler pushed registers, the stacked values are shifted.';
				}
			}
			const frame = await this.readMemory(sp, 32).catch(() => undefined);
			stackedWords = frame ? Array.from({ length: 8 }, (_, k) => readLittleEndian(frame, k * 4, 32)) : undefined;
			if (stackedWords && (stackedWords[7] & 0x01000000) === 0) {
				frameNote = `The stacked xPSR (${hex(stackedWords[7])}) has the Thumb bit clear, so the frame at ${hex(sp)} is probably not the exception frame; trust the flags and addresses, not the stacked registers.`;
			}
		}
		const report = decodeCortexMFault({
			cfsr: word(SCB.CFSR), hfsr: word(SCB.HFSR), mmfar: word(SCB.MMFAR), bfar: word(SCB.BFAR), shcsr: word(SCB.SHCSR),
			xpsr: num('xpsr'), pc: num('pc'), lr, msp: num('msp'), psp: num('psp'),
			...stackedWords && stackedFrom ? { stackedWords, stackedFrom } : {},
		});
		const backtrace = await this.backtrace(16).catch(() => []);
		let summary = frameNote ? `${report.summary} ${frameNote}` : report.summary;
		let location: { faultingCode?: SourceLocation; caller?: SourceLocation } = {};
		if (report.stackedFrame && this.hasSymbols) {
			// GDB often cannot unwind out of a fault handler; resolve the stacked PC and LR directly.
			const faultingCode = await this.sourceLine(Number(report.stackedFrame.pc));
			const caller = await this.sourceLine((Number(report.stackedFrame.lr) & ~1) >>> 0);
			location = { ...faultingCode ? { faultingCode } : {}, ...caller ? { caller } : {} };
			if (faultingCode) {
				summary += ` Faulting code: ${describeLocation(faultingCode)}${caller ? `, called from ${describeLocation(caller)}` : ''}.`;
			}
		}
		return { ...report, ...location, summary, backtrace };
	}

	/**
	 * ESP32 family: the stop signal (the stub maps EXCCAUSE to one), the cause from a core dump,
	 * the faulting instruction and — for a bad load/store — its data address (EXCVADDR when the
	 * core dump has it, else computed from the instruction's base register and offset).
	 */
	private async decodeEspCrash(arch: 'xtensa' | 'riscv'): Promise<EspCrashDecode> {
		const stop = this.lastStop;
		const signal = stop?.signal;
		let facts = this.coreFacts ?? (this.server.transport === 'gdb-stub' && !this.haltedByDebugger ? (await this.stubPanicFacts(arch)).facts : undefined);
		if (!this.live && arch === 'riscv' && facts?.exccause === undefined) {
			facts = { ...facts, ...await this.riscvTrapFacts(facts?.crashedTaskTcb) };
		}
		const pcText = await this.evaluate('$pc').catch(() => undefined);
		const pc = pcText ? Number(/0x[0-9a-fA-F]+/.exec(pcText)?.[0] ?? pcText.split(' ')[0]) : undefined;
		const backtrace: Frame[] = await this.backtrace(16).catch(() => []);
		const applicationFrame = backtrace.find(f => f.function && f.file && !isEspIdfSource(f.file));
		// abort()/assert/task watchdog end in ESP-IDF's panic_abort, which executes an illegal
		// instruction on purpose: the cause is the abort, not that instruction.
		const details = facts?.panicDetails;
		const abortKind = details
			? (/^assert failed/.test(details) ? 'assert' : /Task watchdog/i.test(details) ? 'task-watchdog' : 'abort')
			: /^(?:panic_abort|esp_system_abort|abort|__assert_func)$/.test(backtrace[0]?.function ?? '') ? 'abort' : undefined;
		const cause = !abortKind && facts?.exccause !== undefined ? exceptionCause(arch, facts.exccause) : undefined;
		const faulted = !!abortKind || cause !== undefined || !!signal && signal !== 'SIGTRAP' && signal !== 'SIGINT';
		const disasm = pc !== undefined ? await this.console(`x/i ${hex(pc)}`).catch(() => '') : '';
		const insn = /=>\s*0x[0-9a-fA-F]+(?:\s*<[^>]*>)?:\s*(?<text>.+)/.exec(disasm)?.groups?.text.replace(/\s+/g, ' ').trim();
		const memoryFault = !abortKind && (signal === 'SIGSEGV' || signal === 'SIGBUS' || (cause !== undefined && /Prohibited|Alignment|LoadStore|access fault|misaligned|debug exception/i.test(cause.name)));
		const memory = memoryFault ? memoryAccess(arch, insn) : undefined;
		let faultAddress: EspCrashDecode['faultAddress'];
		if (facts?.excvaddr !== undefined && cause && /Prohibited|Alignment|LoadStore|access fault|misaligned/.test(cause.name)) {
			faultAddress = { address: hex(facts.excvaddr), source: 'EXCVADDR' };
		} else if (memory) {
			const base = await this.evaluate(`$${memory.base}`).catch(() => undefined);
			const value = base !== undefined && /^-?\d+$|^0x[0-9a-fA-F]+$/.test(base.trim()) ? Number(base.trim()) : NaN;
			if (Number.isFinite(value)) {
				faultAddress = { address: hex((value + memory.offset) >>> 0), source: 'faulting instruction' };
			}
		}
		const faultingCode = abortKind && applicationFrame
			? { address: applicationFrame.address, function: applicationFrame.function!, ...applicationFrame.file ? { file: applicationFrame.file, line: applicationFrame.line } : {} }
			: pc !== undefined && this.hasSymbols ? await this.sourceLine(pc) : undefined;
		const callerFrame = abortKind && applicationFrame ? backtrace[backtrace.indexOf(applicationFrame) + 1] : backtrace[1];
		const caller = callerFrame?.function ? { address: callerFrame.address, function: callerFrame.function, ...callerFrame.file ? { file: callerFrame.file, line: callerFrame.line } : {} } : undefined;
		const threadName = (await this.threads().catch(() => [])).find(t => t.current);
		const thread = threadName ? threadName.name ?? threadName.targetId : undefined;
		const exception = abortKind === 'assert' ? 'assert() failed' : abortKind === 'task-watchdog' ? 'Task watchdog' : abortKind === 'abort' ? 'abort()' : cause?.name
			?? (signal === 'SIGSEGV' ? (memory?.access === 'write' ? 'StoreProhibited / Store access fault' : memory?.access === 'read' ? 'LoadProhibited / Load access fault' : 'invalid memory access') : signal === 'SIGILL' ? 'IllegalInstruction' : signal === 'SIGFPE' ? 'IntegerDivideByZero' : signal === 'SIGBUS' ? 'LoadStoreAlignment / LoadStoreError' : undefined);
		const meaning = abortKind ? crashKindMeaning(abortKind) : cause?.meaning ?? (signal === 'SIGSEGV' ? 'access to an invalid address: a NULL pointer when the address is near 0, otherwise a corrupted or dangling pointer' : signal === 'SIGILL' ? 'invalid instruction: corrupted code, a jump into data, or a bad function pointer' : undefined);
		const parts: string[] = [];
		if (faulted && this.signalUncertain && !cause && !abortKind) {
			parts.push(`(Without the ELF it is unknown whether the chip panicked: if the debugger stopped a running program, the stub's ${signal ?? 'signal'} is stale.)`);
		}
		if (!faulted) {
			parts.push(`No exception: the CPU stopped (${stop?.reason ?? 'halted'}${signal ? `, ${signal}` : ''}) at ${faultingCode ? describeLocation(faultingCode) : pcText ?? 'an unknown PC'}.`);
		} else {
			parts.push(`${exception ?? signal ?? 'Crash'}${thread ? ` in task ${thread}` : ''}${meaning ? `: ${meaning}` : ''}.`);
			if (details) {
				parts.push(`Panic details: ${details}.`);
			}
			if (faultingCode) {
				parts.push(`${abortKind ? 'Called from application code' : 'Faulting code'}: ${describeLocation(faultingCode)}${caller ? `, called from ${describeLocation(caller)}` : ''}.`);
			}
			if (insn && !abortKind) {
				parts.push(`Instruction: ${insn}.`);
			}
			if (faultAddress) {
				parts.push(`${memory?.access === 'write' ? 'Write to' : memory?.access === 'read' ? 'Read from' : 'Access to'} ${faultAddress.address} (${faultAddress.source === 'EXCVADDR' ? 'EXCVADDR' : `computed from ${memory!.base} + ${memory!.offset}`})${Number(faultAddress.address) < 0x1000 ? ': a NULL pointer dereference' : ''}.`);
			}
		}
		return {
			arch,
			faulted,
			...signal ? { signal } : {},
			...exception ? { exception } : {},
			...meaning ? { meaning } : {},
			...pc !== undefined ? { pc: hex(pc) } : {},
			...insn ? { faultingInstruction: insn } : {},
			...faultAddress ? { faultAddress } : {},
			...faultAddress && memory ? { access: memory.access } : {},
			...details ? { panicDetails: details } : {},
			...faultingCode ? { faultingCode } : {},
			...caller ? { caller } : {},
			...applicationFrame ? { applicationFrame } : {},
			...thread ? { thread } : {},
			backtrace,
			summary: parts.join(' '),
		};
	}

	/**
	 * After a panic, ESP-IDF's stub keeps the exception frame in its global `s_scratch`
	 * (`state` leaves GDBSTUB_NOT_STARTED only in the panic handler; needs
	 * CONFIG_ESP_GDBSTUB_SUPPORT_TASKS, the default). Undefined when the chip did not panic.
	 */
	private async stubPanicFacts(arch: 'xtensa' | 'riscv'): Promise<{ state: 'panicked' | 'running' | 'unknown'; facts?: CoreDumpFacts }> {
		const value = async (expression: string) => miString((await this.send(`-data-evaluate-expression ${miQuote(expression)}`).catch(() => undefined))?.results.value);
		const state = await value('s_scratch.state');
		// `state` is only kept with task support (CONFIG_ESP_GDBSTUB_SUPPORT_TASKS, the default).
		if (!state || !/GDBSTUB_/.test(state) || await value('sizeof(s_scratch.tasks)') === undefined) {
			return { state: 'unknown' };
		}
		if (/NOT_STARTED/.test(state)) {
			return { state: 'running' };
		}
		const [cause, address] = arch === 'xtensa' ? ['exccause', 'excvaddr'] : ['mcause', 'mtval'];
		const num = (v: string | undefined) => v !== undefined && /^-?\d+$/.test(v.trim()) ? Number(v.trim()) >>> 0 : undefined;
		const exccause = num(await value(`(unsigned long)s_scratch.paniced_frame.${cause}`));
		const excvaddr = num(await value(`(unsigned long)s_scratch.paniced_frame.${address}`));
		this.haltedByDebugger = false;
		return { state: 'panicked', facts: { ...exccause !== undefined ? { exccause } : {}, ...excvaddr !== undefined ? { excvaddr } : {} } };
	}

	/**
	 * RISC-V core dumps keep no mcause/mtval register (PRSTATUS has the 32 GPRs only). The trap
	 * vector pushes an RvExcFrame (37 words, 0xA0 bytes aligned) on the faulting stack and stores
	 * the original sp in it, and the dump's registers for the crashed task come from that frame —
	 * so it sits at $sp − 0xA0. It is trusted only when its saved mepc and sp equal $pc and $sp
	 * (riscv/rvruntime-frames.h, riscv/vectors.S, espcoredump parse_exc_regs). mcause at 0x88,
	 * mtval at 0x8C; an interrupt cause (bit 31) is no exception.
	 */
	private async riscvTrapFacts(crashedTaskTcb: number | undefined): Promise<CoreDumpFacts | undefined> {
		// The crashed task's thread (target id "process <TCB>"; the first thread otherwise), frame 0,
		// whatever thread the model selected before.
		const threads = await this.send('-thread-info').catch(() => undefined);
		const list = miList(threads?.results.threads).map(miTuple);
		const crashed = list.find(t => crashedTaskTcb !== undefined && miString(t?.['target-id']) === `process ${crashedTaskTcb}`) ?? list[0];
		const thread = Number(miString(crashed?.id));
		const scope = Number.isInteger(thread) && thread > 0 ? `--thread ${thread} --frame 0 ` : '';
		const word = async (expression: string) => {
			const v = miString((await this.send(`-data-evaluate-expression ${scope}${miQuote(expression)}`).catch(() => undefined))?.results.value)?.trim();
			return v !== undefined && /^\d+$/.test(v) ? Number(v) >>> 0 : undefined;
		};
		const pc = await word('(unsigned long)$pc');
		const sp = await word('(unsigned long)$sp');
		if (pc === undefined || sp === undefined || sp < 0xA0) {
			return undefined;
		}
		const frame = sp - 0xA0;
		const at = (offset: number) => word(`*(unsigned long *)${frame + offset}`);
		if (await at(0) !== pc || await at(8) !== sp) {
			return undefined;
		}
		const exccause = await at(0x88);
		if (exccause === undefined || (exccause & 0x80000000) !== 0) {
			return undefined;
		}
		const excvaddr = await at(0x8C);
		return { exccause, ...excvaddr !== undefined ? { excvaddr } : {} };
	}

	/** Frame 0's frame address (CFA) from GDB's unwinder: `Stack level 0, frame at 0x…`. */
	private async frameAddress(): Promise<number | undefined> {
		const out = await this.console('info frame').catch(() => '');
		const m = /Stack level 0, frame at (0x[0-9a-fA-F]{1,8})/.exec(out);
		return m ? Number(m[1]) : undefined;
	}

	/** Function and source line of a code address (`info line`), when the ELF has them. */
	private async sourceLine(address: number): Promise<SourceLocation | undefined> {
		const out = await this.console(`info line *${hex(address)}`).catch(() => '');
		const m = /Line (\d+) of "([^"]+)"[^<]*<([^>+]+)(?:\+(\d+))?>/.exec(out) ?? /address (0x[0-9a-fA-F]+) <([^>+]+)(?:\+(\d+))?>/.exec(out);
		if (!m) {
			return undefined;
		}
		return m.length === 5
			? { address: hex(address), function: m[3], file: m[2], line: Number(m[1]) }
			: { address: hex(address), function: m[2] };
	}

	async dispose(options: { resume?: boolean } = {}): Promise<void> {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		try {
			if (!this.ended && options.resume !== false && this.live) {
				if (this.server.transport === 'gdb-stub') {
					// The stub cannot detach; its "kill" packet leaves the stub and lets the program
					// run on (after a panic the chip stays in the panic handler).
					await this.mi.send(`-interpreter-exec console ${miQuote('kill')}`, { timeoutMs: 5_000 }).catch(() => undefined);
				} else {
					// Detaching makes OpenOCD resume the target.
					await this.mi.send('-target-detach', { timeoutMs: 5_000 }).catch(() => undefined);
				}
			}
			if (!this.ended) {
				await this.mi.send('-gdb-exit', { timeoutMs: 3_000 }).catch(() => undefined);
			}
		} finally {
			await this.gdb.kill();
			await this.backend?.stop();
			this.mi.close('session ended');
			this.lock.dispose();
		}
	}
}
