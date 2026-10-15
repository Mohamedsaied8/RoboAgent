/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable } from '../../kernel/disposable';
import { IAgentHost, IProcessHandle } from '../../kernel/host';
import { BreakpointBudget, budgetFromControlRegisters, CORTEX_M_CORE_REGISTERS, CrashReport, decodeCortexMFault, DWT_CTRL, FP_CTRL, SCB, stackFromExcReturn } from '../arch/cortexM';
import { DecodedPeripheral, decodeRegister, hex, readableRegister, readLittleEndian, SkippedRegister } from '../svd/peripheralDecoder';
import { findPeripheral, SvdDevice } from '../svd/svdParser';
import { TargetDescriptor } from '../target';
import { GdbMiClient, MiError, StopEvent } from './gdbmi/client';
import { miList, miQuote, MiRecord, miString, miTuple, MiTuple, MiValue } from './gdbmi/parser';
import { acquireProbe, OpenOcdInfo, OpenOcdServer, OpenOcdStartOptions } from './openocdServer';

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

export type CrashDecode = CrashReport & { readonly backtrace: Frame[]; readonly faultingCode?: SourceLocation; readonly caller?: SourceLocation };

/** Port: one live debug session on one target (Facade over the debug server and debugger). */
export interface ITargetSession {
	readonly target: TargetDescriptor;
	readonly server: OpenOcdInfo;
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
	readonly openocd: OpenOcdStartOptions;
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

/** Register names the agent may use as `$name` in expressions. */
const REGISTER_VARIABLE = new Set([...CORTEX_M_CORE_REGISTERS, 'fp']);

/**
 * Expressions go to GDB, which can also assign, call target functions and run GDB's own
 * convenience functions (`$_shell` runs a shell command). Refuse those; GDB is additionally
 * configured with `may-write-memory`, `may-write-registers` and `may-call-functions` off.
 */
export function checkExpression(expression: string): string {
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
		if (n !== undefined && n >= PERIPHERAL_SPACE.from && n <= PERIPHERAL_SPACE.to) {
			throw new DebugSessionError('Expressions may not read through a literal peripheral address (reading some registers clears flags or pops a FIFO); use read_peripheral or read_memory, which check the register first.');
		}
	}
	for (const m of e.matchAll(/\$([A-Za-z_]\w*)/g)) {
		if (!REGISTER_VARIABLE.has(m[1].toLowerCase())) {
			throw new DebugSessionError(`"$${m[1]}" is not allowed in expressions (only core registers such as $pc, $sp, $r0).`);
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

/** OpenOCD as GDB server + GDB/MI as the debugger: the primary backend for every target. */
export class OpenOcdGdbSession implements ITargetSession {
	private readonly bps = new Map<number, BreakpointInfo>();
	private registerNames: string[] | undefined;
	private disposed = false;
	private ended: string | undefined;
	private readonly snapshots = new Map<string, DecodedPeripheral>();

	private constructor(
		readonly target: TargetDescriptor,
		private readonly openocd: OpenOcdServer,
		private readonly gdb: IProcessHandle,
		private readonly mi: GdbMiClient,
		private readonly lock: IDisposable,
		readonly budget: BreakpointBudget,
		readonly hasSymbols: boolean,
		private readonly svd: (() => Promise<SvdDevice>) | undefined,
		private readonly gdbStderr: string[],
		records: ((record: MiRecord) => void)[],
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
		void openocd.exited.then(() => this.markEnded('OpenOCD exited (probe unplugged or target lost?)'));
	}

	get server(): OpenOcdInfo {
		return this.openocd.info;
	}

	get state(): 'stopped' | 'running' | 'unknown' {
		return this.ended ? 'unknown' : this.mi.state;
	}

	get lastStop(): StopInfo | undefined {
		return toStopInfo(this.mi.lastStop);
	}

	static async start(host: IAgentHost, options: SessionStartOptions): Promise<OpenOcdGdbSession> {
		if (!host.spawn) {
			throw new DebugSessionError('This host cannot run long-lived programs, so it cannot start a debug session.');
		}
		let elf: string | undefined;
		if (options.elf) {
			if (!await host.fs.exists(options.elf)) {
				throw new DebugSessionError(`ELF file "${options.elf}" not found in the workspace.`);
			}
			// The real path (inside the workspace; NodeFileSystem refuses links that leave it).
			elf = await host.fs.realPath(options.elf);
			miQuote(elf);
		}
		const lock = acquireProbe(options.probe, options.owner);
		let openocd: OpenOcdServer | undefined;
		let gdb: IProcessHandle | undefined;
		try {
			openocd = await OpenOcdServer.start(host, options.openocd);
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

			let budget = openocd.info.budget;
			if (!budget && options.target.arch === 'cortex-m') {
				const fp = await OpenOcdGdbSession.readWord(mi, FP_CTRL);
				const dwt = await OpenOcdGdbSession.readWord(mi, DWT_CTRL);
				budget = budgetFromControlRegisters(fp, dwt);
			}
			options.log?.(`Debug session on ${options.target.part}: ${openocd.info.probe ?? options.probe}, ${openocd.info.core ?? 'core'}, port ${openocd.info.port}`);
			return new OpenOcdGdbSession(options.target, openocd, handle, mi, lock, budget ?? { breakpoints: 2, watchpoints: 1 }, !!elf, options.svd, stderr, records);
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
		if (this.mi.state === 'running') {
			throw new DebugSessionError(`The target is running; halt it before ${what}.`);
		}
	}

	private async send(command: string, timeoutMs = 10_000) {
		this.alive();
		try {
			return await this.mi.send(command, { timeoutMs });
		} catch (err) {
			if (err instanceof MiError && err.kind === 'error') {
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
		if (this.mi.state === 'stopped') {
			return this.lastStop ?? {};
		}
		return toStopInfo(await this.runUntilStop('-exec-interrupt', 5_000))!;
	}

	async resume(waitMs = 0): Promise<StopInfo | undefined> {
		this.stoppedOnly('resuming');
		if (waitMs <= 0) {
			await this.send('-exec-continue');
			return undefined;
		}
		try {
			return toStopInfo(await this.runUntilStop('-exec-continue', waitMs));
		} catch (err) {
			if (err instanceof MiError && err.kind === 'timeout' && this.mi.state === 'running') {
				return undefined; // still running: no breakpoint hit in time
			}
			throw err;
		}
	}

	async step(kind: StepKind): Promise<StopInfo> {
		this.stoppedOnly('stepping');
		if (kind !== 'instruction' && !this.hasSymbols) {
			throw new DebugSessionError('Source-level stepping needs the ELF with symbols; start the session with "elf", or step by instruction.');
		}
		if (kind === 'out' && this.hardwareBreakpointsUsed() >= this.budget.breakpoints) {
			throw new DebugSessionError('Stepping out needs a free hardware breakpoint; clear one first.');
		}
		const command = { instruction: '-exec-step-instruction', over: '-exec-next', into: '-exec-step', out: '-exec-finish' }[kind];
		try {
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
		this.alive();
		const loc = checkLocation(location);
		const cond = condition !== undefined ? checkExpression(condition) : undefined;
		// Keep one comparator free: `next` and `finish` need a temporary breakpoint.
		const limit = Math.max(1, this.budget.breakpoints - 1);
		if (this.hardwareBreakpointsUsed() >= limit) {
			throw new DebugSessionError(`All ${limit} usable hardware breakpoints are in use (the core has ${this.budget.breakpoints}, one is kept for stepping); clear one first.`);
		}
		if (!this.hasSymbols && !loc.startsWith('*')) {
			throw new DebugSessionError('Without the ELF only address breakpoints (*0x…) work; start the session with "elf".');
		}
		const r = await this.send(`-break-insert -h ${cond !== undefined ? `-c ${miQuote(cond)} ` : ''}${miQuote(loc)}`);
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
		this.alive();
		const expr = checkExpression(expression);
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
		const wanted = this.registerNames.map((name, index) => ({ name, index })).filter(x => CORTEX_M_CORE_REGISTERS.includes(x.name));
		const r = await this.send(`-data-list-register-values x ${wanted.map(w => w.index).join(' ')}`);
		const values = new Map(miList(r.results['register-values']).map(miTuple).map(t => [Number(miString(t?.number)), miString(t?.value) ?? '']));
		return Object.fromEntries(wanted.map(w => [w.name, values.get(w.index) ?? '?']));
	}

	async evaluate(expression: string): Promise<string> {
		this.stoppedOnly('evaluating expressions');
		const r = await this.send(`-data-evaluate-expression ${miQuote(checkExpression(expression))}`);
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
		const r = await this.send(`-stack-list-variables --thread 1 --frame ${f} --simple-values`);
		return miList(r.results.variables).map(miTuple).filter((v): v is MiTuple => !!v).map(v => {
			const type = miString(v.type);
			const value = miString(v.value);
			return { name: miString(v.name) ?? '?', ...type ? { type } : {}, ...value !== undefined ? { value } : {} };
		});
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
		if (this.target.arch !== 'cortex-m') {
			throw new DebugSessionError(`Crash decoding for ${this.target.arch} is not available yet.`);
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
			if (!this.ended && options.resume !== false) {
				// Detaching makes OpenOCD resume the target.
				await this.mi.send('-target-detach', { timeoutMs: 5_000 }).catch(() => undefined);
			}
			if (!this.ended) {
				await this.mi.send('-gdb-exit', { timeoutMs: 3_000 }).catch(() => undefined);
			}
		} finally {
			await this.gdb.kill();
			await this.openocd.stop();
			this.mi.close('session ended');
			this.lock.dispose();
		}
	}
}
