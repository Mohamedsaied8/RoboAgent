/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IAgentHost } from '../../kernel/host';
import { defineTool, ToolError } from '../../kernel/tool';
import { AnyTool } from '../../kernel/toolRegistry';
import { DebugStackError, locateDebugStack, PROBE_INTERFACES } from '../../embedded/debug/debugStack';
import { DebugServerError, ProbeBusyError } from '../../embedded/debug/openocdServer';
import { bitBandTarget, DebugSessionError, ITargetSession, MAX_READ_BYTES, MAX_WRITE_BYTES, OpenOcdGdbSession, PERIPHERAL_SPACE, StepKind } from '../../embedded/debug/targetSession';
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

/** State the Debug agent's tools share: the live session and the findings reported so far. */
export class DebugToolContext {
	session: ITargetSession | undefined;
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
		if (err instanceof DebugSessionError || err instanceof DebugServerError || err instanceof DebugStackError || err instanceof ProbeBusyError || err instanceof SvdError) {
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
const PROTECTED_PERIPHERAL = /^(FLASH|DBGMCU|DBG|OB|OPTIONBYTES?)$/i;

async function protectedReason(session: ITargetSession, address: number, length: number): Promise<string | undefined> {
	// A bit-band alias write lands in the region it maps to: check both.
	for (const [from, len] of [[address, length], bitBandTarget(address, length)]) {
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

const sessionInput = {
	type: 'object',
	properties: {
		part: { type: 'string', maxLength: 64, description: 'MCU part, e.g. STM32F103C8T6 (default: detected from dir)' },
		dir: { type: 'string', maxLength: 512, description: 'Project directory (default ".")' },
		elf: { type: 'string', maxLength: 512, description: 'Workspace path of the ELF with debug symbols (default: the only *.elf under <dir>/build or <dir>)' },
		svd: { type: 'string', maxLength: 512, description: 'Workspace path of an .svd file (default: the pinned SVD for the part)' },
		probe: { enum: Object.keys(PROBE_INTERFACES), description: 'Debug probe (default stlink)' },
	},
	additionalProperties: false,
} as const;

interface SessionInput {
	readonly part?: string;
	readonly dir?: string;
	readonly elf?: string;
	readonly svd?: string;
	readonly probe?: string;
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
		throw new ToolError('Could not tell which MCU this is; pass "part" (e.g. STM32F103C8T6).');
	}
	const probe = input.probe ?? 'stlink';
	const stack = await locateDebugStack(host, target, probe, signal);
	const elf = input.elf ? checkWorkspaceFile(input.elf, 'an ELF file', /\.(elf|axf|out)$/i) : await findElf(host, dir);
	const svdPath = input.svd ? checkWorkspaceFile(input.svd, 'an SVD file', /\.svd$/i) : undefined;
	host.progress(`Starting OpenOCD + GDB for ${target.part} over ${probe}${elf ? ` with ${elf}` : ' (no ELF: addresses only)'}`);
	const session = await ctx.startSession(host, {
		target,
		gdb: stack.gdb,
		...elf ? { elf } : {},
		svd: () => ctx.svd.load(host, target, svdPath),
		probe,
		owner: ctx.agentId,
		openocd: { program: stack.openocd, scriptsDir: stack.scriptsDir, interfaceScript: stack.interfaceScript, targetScript: stack.targetScript, signal },
		signal,
		log: m => host.log('info', m),
	});
	ctx.session = session;
	return {
		target: target.part,
		probe: session.server.probe ?? probe,
		core: session.server.core,
		targetVoltage: session.server.targetVoltage,
		hardwareBreakpoints: session.budget.breakpoints,
		hardwareWatchpoints: session.budget.watchpoints,
		symbols: session.hasSymbols ? elf : 'none (addresses only; pass "elf" for source-level debugging)',
		state: session.state,
		stoppedAt: session.lastStop,
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
			description: 'Attach to the target over the debug probe (OpenOCD + GDB) and halt it. Needs the debug tools (see check_debug_tools / ensure_debug_tools). Pass the ELF for source-level debugging; reports the stop location, hardware breakpoint/watchpoint budget and target voltage.',
			risk: 'hardware',
			category: 'hardware',
			inputSchema: sessionInput,
			describeCall: (input: SessionInput) => `Attach the debugger to ${input.part ?? `the target of ${input.dir ?? '.'}`} over ${input.probe ?? 'ST-Link'} and halt it${input.elf ? ` (symbols from ${input.elf})` : ''}${input.svd ? ` (registers from ${input.svd})` : ''}`,
			invoke: (input: SessionInput, { host, signal }) => guarded(() => startSession(host, ctx, input, signal)),
		}),
		defineTool({
			name: 'end_session',
			description: 'End the debug session: detach (the target keeps running) and stop OpenOCD and GDB. With resume=false the target stays halted.',
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
				const [touched, touchedLength] = bitBandTarget(address, input.length);
				if (!registers && touched <= PERIPHERAL_SPACE.to && touched + touchedLength - 1 >= PERIPHERAL_SPACE.from) {
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
			description: `Write up to ${MAX_WRITE_BYTES} bytes to target RAM or a peripheral register. Flash, option bytes, the flash controller and DBGMCU are refused. "bytes" is hex, lowest address first (little-endian: the word 0x00000001 is "01000000"). The user must approve.`,
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
			description: 'Core registers: r0–r12, sp, lr, pc, xpsr, msp, psp, primask, basepri, faultmask, control.',
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
			name: 'decode_crash',
			description: 'Explain a fault: the current exception, HardFault/BusFault/MemManage/UsageFault status flags with their meaning, the faulting data address, the stacked registers of the interrupted code, and its source location. Halt first.',
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
