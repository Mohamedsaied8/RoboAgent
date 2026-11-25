/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  ESP-IDF crash reports as they appear on the serial console: "Guru Meditation" exceptions with
 *  their register dump, abort()/assert, FreeRTOS stack-overflow checks, task and interrupt
 *  watchdogs, brownout, the backtrace, the ELF SHA-256 of the running app and what happened next
 *  (reboot, halt, GDB stub, core dump). Formats follow ESP-IDF v6.1 (esp_system/panic.c,
 *  port/arch/{xtensa,riscv}/panic_arch.c, task_wdt.c, FreeRTOS port.c) and real logs from an
 *  ESP32-D0WDQ6.
 *--------------------------------------------------------------------------------------------*/

import { causeByName } from '../arch/esp';

export type EspCrashKind =
	| 'exception' | 'abort' | 'assert' | 'stack-overflow' | 'task-watchdog' | 'interrupt-watchdog'
	| 'brownout' | 'cache-error' | 'double-exception';

export interface BacktraceEntry {
	/** Code address as printed (ESP-IDF already maps Xtensa return addresses to the call). */
	readonly pc: number;
	/** Stack pointer of that frame (Xtensa only). */
	readonly sp?: number;
}

export interface EspCrash {
	readonly kind: EspCrashKind;
	/** Line number in the log where the crash report starts (1-based). */
	readonly line: number;
	readonly core?: number;
	/** ESP-IDF's reason, e.g. `LoadProhibited`, `Load access fault`, `Interrupt wdt timeout on CPU0`. */
	readonly reason?: string;
	/** Plain-language meaning of the reason (what usually causes it). */
	readonly meaning?: string;
	/** The lines that explain it (assert expression and location, overflowing task, watchdog tasks). */
	readonly details: string[];
	/** Task named by the report (stack overflow, canary watchpoint), when there is one. */
	readonly task?: string;
	/** For assert(): `function`, `file:line` and the failed expression. */
	readonly assertion?: { readonly function: string; readonly location: string; readonly expression: string };
	/** `abort() was called at PC 0x… on core N`. */
	readonly abortPc?: number;
	/** Register dump by name (`PC`, `EXCCAUSE`, `EXCVADDR`, `MEPC`, `MCAUSE`, `MTVAL`, `A0`…), from the crashing core. */
	readonly registers: Readonly<Record<string, number>>;
	/** The faulting data address (EXCVADDR / MTVAL) for memory-access exceptions. */
	readonly faultAddress?: number;
	readonly backtrace: readonly BacktraceEntry[];
	/** The backtrace ended in `|<-CORRUPTED` (stack overwritten). */
	readonly backtraceCorrupted: boolean;
	/** Prefix of the running app's ELF SHA-256, as printed after the report. */
	readonly elfSha256?: string;
	/** What the chip did after the report (`nested-panic`: the panic handler itself crashed, memory was already corrupted). */
	readonly then?: 'reboot' | 'halt' | 'gdb-stub' | 'nested-panic';
	readonly coreDump: boolean;
}

export interface EspLogSummary {
	readonly crashes: readonly EspCrash[];
	/** Reset reasons of each boot in the log (`rst:0xc (SW_CPU_RESET)`), in order. */
	readonly boots: readonly string[];
	/** ELF SHA-256 prefix the app printed at start-up (`app_init: ELF file SHA256: …`). */
	readonly appElfSha256?: string;
	/** Lines that were dropped because the log was longer than the parser's cap. */
	readonly truncatedLines: number;
	/** Older crash reports dropped beyond the newest {@link MAX_CRASHES}. */
	readonly droppedCrashes: number;
}

/** Longest log the parser looks at (the end is kept: that is where the latest crash is). */
export const MAX_LOG_CHARS = 512 * 1024;
const MAX_CRASHES = 32;
const MAX_FRAMES = 64;
/** Lines longer than this are not crash-report lines; skipping them keeps every regex cheap. */
const MAX_LINE = 4096;
const DUMP_START = 'CORE DUMP START';
const DUMP_END = 'CORE DUMP END';

const BASE64_LINE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Removes the base64 data of UART core dumps (one pass over the lines). A dump's data are the
 * base64 lines after its START marker, up to its END marker or — for a dump cut off by a reset —
 * the first line that is not dump data, which is kept. Without `placeholder` every data line
 * becomes empty (line numbers stay right); with it the data collapse into that one line.
 */
export function stripCoreDumpBodies(text: string, placeholder?: string): string {
	const out: string[] = [];
	let inDump = false;
	let collapsed = false;
	for (const line of text.split('\n')) {
		if (inDump) {
			const l = line.trim();
			if (line.includes(DUMP_END)) {
				inDump = false;
			} else if (!l || (l.length <= MAX_LINE && BASE64_LINE.test(l))) {
				if (placeholder === undefined) {
					out.push('');
				} else if (!collapsed) {
					out.push(placeholder);
					collapsed = true;
				}
				continue;
			} else {
				inDump = false;
			}
		}
		if (line.includes(DUMP_START)) {
			inDump = true;
			collapsed = false;
		}
		out.push(line);
	}
	return out.join('\n');
}

const MEMORY_EXCEPTIONS = /^(LoadProhibited|StoreProhibited|LoadStoreAlignment|LoadStoreError|Load access fault|Store access fault|Load address misaligned|Store address misaligned)$/;

/** Removes ANSI colour codes, CRs and other control characters (keeps tabs). */
export function cleanSerialText(text: string): string {
	return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

function hexValue(text: string): number | undefined {
	const n = parseInt(text, 16);
	return Number.isFinite(n) && /^[0-9a-fA-F]{1,8}$/.test(text) ? n >>> 0 : undefined;
}

interface Draft {
	kind: EspCrashKind;
	line: number;
	core?: number;
	reason?: string;
	details: string[];
	task?: string;
	assertion?: { function: string; location: string; expression: string };
	abortPc?: number;
	registers: Record<string, number>;
	registersCore?: number;
	backtrace: BacktraceEntry[];
	backtraceCorrupted: boolean;
	elfSha256?: string;
	then?: 'reboot' | 'halt' | 'gdb-stub' | 'nested-panic';
	coreDump: boolean;
}

function kindOfReason(reason: string): EspCrashKind {
	if (/^Interrupt wdt timeout/i.test(reason)) {
		return 'interrupt-watchdog';
	}
	if (/^Cache error/i.test(reason)) {
		return 'cache-error';
	}
	if (/^Double exception/i.test(reason)) {
		return 'double-exception';
	}
	if (/^Task watchdog/i.test(reason)) {
		return 'task-watchdog';
	}
	if (/^Stack protection fault/i.test(reason)) {
		return 'stack-overflow';
	}
	return 'exception';
}

const KIND_MEANING: Partial<Record<EspCrashKind, string>> = {
	'abort': 'abort() was called: by the application, by ESP_ERROR_CHECK on an error code, or by a failed check inside ESP-IDF',
	'assert': 'a C assert() failed',
	'stack-overflow': 'a task used more stack than it was given: increase its stack size or reduce deep recursion / large local arrays',
	'task-watchdog': 'a task did not yield or reset the task watchdog in time: a busy loop without vTaskDelay, a deadlock, or a blocked high-priority task starving the idle task',
	'interrupt-watchdog': 'an interrupt handler (or code with interrupts disabled) ran too long: a long critical section, a spinlock deadlock, or a flash operation with the cache off',
	'brownout': 'the supply voltage dropped below the brownout threshold: weak USB power, a current spike (Wi-Fi start), or a bad regulator',
	'cache-error': 'code or data in flash was accessed while the flash cache was disabled (e.g. from an ISR during a flash write without IRAM_ATTR)',
	'double-exception': 'an exception while handling an exception (often a corrupted stack)',
};

/** What a crash kind usually means in firmware. */
export function crashKindMeaning(kind: EspCrashKind): string | undefined {
	return KIND_MEANING[kind];
}

/** Whether a source file belongs to ESP-IDF itself (its components), not the application. */
export function isEspIdfSource(file: string | undefined): boolean {
	return !!file && /[\\/]esp-idf[^\\/]*[\\/](?:components|tools)[\\/]/.test(file);
}

/**
 * Parses an ESP-IDF serial log into crash reports. Linear in the length of the log; only the last
 * {@link MAX_LOG_CHARS} characters are considered.
 */
export function parseEspLog(raw: string): EspLogSummary {
	let text = stripCoreDumpBodies(cleanSerialText(raw));
	let truncatedLines = 0;
	if (text.length > MAX_LOG_CHARS) {
		const cut = text.length - MAX_LOG_CHARS;
		truncatedLines = text.slice(0, cut).split('\n').length - 1;
		text = text.slice(cut);
	}
	const lines = text.split('\n');
	const crashes: Draft[] = [];
	const boots: string[] = [];
	let appElfSha256: string | undefined;
	let current: Draft | undefined;
	let inRegisterDump = false;
	let inCoreDump = false;
	let droppedCrashes = 0;
	/** Boot output seen since the current report: a later report belongs to a new boot. */
	let bootSince = false;

	const start = (draft: Omit<Draft, 'details' | 'registers' | 'backtrace' | 'backtraceCorrupted' | 'coreDump'> & { details?: string[] }): Draft => {
		const d: Draft = { details: [], registers: {}, backtrace: [], backtraceCorrupted: false, coreDump: false, ...draft };
		// The newest reports matter most: drop the oldest.
		crashes.push(d);
		if (crashes.length > MAX_CRASHES) {
			crashes.shift();
			droppedCrashes++;
		}
		current = d;
		inRegisterDump = false;
		bootSince = false;
		return d;
	};
	/** A report that has not printed its backtrace yet can absorb the Guru/abort line that follows it. */
	const open = (): Draft | undefined => current && !current.backtrace.length && !current.then ? current : undefined;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const at = truncatedLines + i + 1;
		if (inCoreDump) {
			if (line.includes(DUMP_END)) {
				inCoreDump = false;
				continue;
			}
			// A dump cut off (reset or power loss): leave it at the first line that is not dump data.
			const l = line.trim();
			if (!l || (l.length <= MAX_LINE && BASE64_LINE.test(l))) {
				continue;
			}
			inCoreDump = false;
		}
		if (line.length > MAX_LINE) {
			continue;
		}
		if (/^(?:ets [A-Z][a-z]{2} |rst:0x|ESP-ROM:|I \(\d+\) boot)/.test(line)) {
			bootSince = true;
		}
		let m: RegExpExecArray | null;

		// A crash report can start mid-line (a truncated register dump: "PC      : 0xGuru Meditation…").
		if ((m = /Guru Meditation Error: Core\s+(?<core>\d+) panic'ed \((?<reason>[^)]*)\)\.?\s*(?<desc>.*)$/.exec(line))) {
			const core = Number(m.groups!.core);
			const reason = m.groups!.reason.trim();
			// A new report after a finished one that never said what came next: the panic handler
			// crashed — unless the chip booted in between (the reset line was missed).
			if (current && current.backtrace.length > 0 && !current.then) {
				current.then = bootSince ? 'reboot' : 'nested-panic';
			}
			const pending = open();
			if (pending && (pending.kind === 'assert' || pending.kind === 'abort' || pending.kind === 'stack-overflow' || pending.kind === 'task-watchdog')) {
				pending.core = core;
				pending.reason ??= reason;
			} else {
				const canary = /Stack canary watchpoint triggered \((?<task>[^)]+)\)/.exec(m.groups!.desc);
				start({ kind: canary ? 'stack-overflow' : kindOfReason(reason), line: at, core, reason, ...canary ? { task: canary.groups!.task, details: [m.groups!.desc.trim()] } : m.groups!.desc.trim() ? { details: [m.groups!.desc.trim()] } : {} });
			}
			continue;
		}
		if ((m = /^Debug exception reason: (?<why>.*)$/.exec(line)) && current) {
			current.details.push(line.trim());
			const canary = /Stack canary watchpoint triggered \((?<task>[^)]+)\)/.exec(m.groups!.why);
			if (canary) {
				current.kind = 'stack-overflow';
				current.task = canary.groups!.task;
			}
			continue;
		}
		if ((m = /assert failed: (?<fn>\S+) (?<loc>\S+:\d+) \((?<expr>.*)\)\s*$/.exec(line))) {
			start({ kind: 'assert', line: at, assertion: { function: m.groups!.fn, location: m.groups!.loc, expression: m.groups!.expr }, details: [line.trim()] });
			continue;
		}
		if ((m = /abort\(\) was called at PC 0x(?<pc>[0-9a-fA-F]{1,8}) on core (?<core>\d+)/.exec(line))) {
			const pending = open();
			const d = pending && pending.kind !== 'exception' ? pending : start({ kind: 'abort', line: at });
			d.abortPc = hexValue(m.groups!.pc);
			d.core = Number(m.groups!.core);
			d.details.push(line.trim());
			continue;
		}
		if ((m = /\*\*\*ERROR\*\*\* A stack overflow in task (?<task>.+?) has been detected/.exec(line))) {
			start({ kind: 'stack-overflow', line: at, task: m.groups!.task, details: [line.trim()] });
			continue;
		}
		if (/task_wdt: Task watchdog got triggered/.test(line)) {
			start({ kind: 'task-watchdog', line: at, details: [line.replace(/^.*task_wdt: /, '').trim()] });
			continue;
		}
		if ((m = /task_wdt: (?<rest>(?: - |CPU \d+:|Tasks currently running|Aborting|Print CPU).*)$/.exec(line)) && current?.kind === 'task-watchdog' && !current.backtrace.length) {
			current.details.push(m.groups!.rest.trim());
			continue;
		}
		if (/Brownout detector was triggered/i.test(line)) {
			start({ kind: 'brownout', line: at, details: [line.trim()] });
			current!.then = 'reboot';
			continue;
		}
		if ((m = /^Core\s+(?<core>\d+) register dump:/.exec(line)) && current) {
			const core = Number(m.groups!.core);
			// Only the crashing core's dump (the first one) fills the registers.
			inRegisterDump = current.registersCore === undefined || current.registersCore === core;
			current.registersCore ??= core;
			continue;
		}
		if (inRegisterDump && current) {
			let any = false;
			for (const r of line.matchAll(/(?<name>[A-Z][A-Z0-9/]*)\s*:\s*0x(?<value>[0-9a-fA-F]{1,8})\b/g)) {
				const value = hexValue(r.groups!.value);
				if (value !== undefined) {
					current.registers[r.groups!.name.split('/')[0]] = value;
					any = true;
				}
			}
			if (any || !line.trim()) {
				continue;
			}
			inRegisterDump = false;
		}
		if ((m = /^\s*Backtrace:(?<frames>.*)$/.exec(line)) && current) {
			inRegisterDump = false;
			// A second backtrace for the same report (e.g. the other core) is ignored.
			if (current.backtrace.length) {
				continue;
			}
			for (const f of m.groups!.frames.matchAll(/0x(?<pc>[0-9a-fA-F]{1,8})(?::0x(?<sp>[0-9a-fA-F]{1,8}))?/g)) {
				if (current.backtrace.length >= MAX_FRAMES) {
					break;
				}
				const pc = hexValue(f.groups!.pc)!;
				const sp = f.groups!.sp !== undefined ? hexValue(f.groups!.sp) : undefined;
				current.backtrace.push({ pc, ...sp !== undefined ? { sp } : {} });
			}
			current.backtraceCorrupted = /\|<-CORRUPTED/.test(line);
			continue;
		}
		if ((m = /^ELF file SHA256:\s*(?<sha>[0-9a-fA-F]+)/.exec(line)) && current) {
			current.elfSha256 = m.groups!.sha.toLowerCase();
			continue;
		}
		if ((m = /app_init: ELF file SHA256:\s*(?<sha>[0-9a-fA-F]+)/.exec(line))) {
			appElfSha256 = m.groups!.sha.toLowerCase();
			continue;
		}
		if (line.includes(DUMP_START)) {
			inCoreDump = true;
			if (current) {
				current.coreDump = true;
			}
			continue;
		}
		if (current && !current.then) {
			if (/Entering gdb stub now/.test(line)) {
				current.then = 'gdb-stub';
			} else if (/^CPU halted\./.test(line)) {
				current.then = 'halt';
			} else if (/Rebooting\.\.\.|^Rebooting in|Panic handler entered multiple times/.test(line)) {
				current.then = /multiple times/.test(line) ? 'nested-panic' : 'reboot';
			}
		}
		if ((m = /^rst:0x(?<code>[0-9a-fA-F]+) \((?<name>[A-Z0-9_]+)\)/.exec(line))) {
			boots.push(`${m.groups!.name} (0x${m.groups!.code})`);
			if (current && !current.then) {
				current.then = 'reboot';
			}
			current = undefined;
			inRegisterDump = false;
		}
	}
	return { crashes: crashes.map(finish), boots, ...appElfSha256 ? { appElfSha256 } : {}, truncatedLines, droppedCrashes };
}

function finish(d: Draft): EspCrash {
	const cause = d.reason ? causeByName(d.reason) : undefined;
	const meaning = cause?.meaning ?? KIND_MEANING[d.kind];
	const faultAddress = d.kind === 'exception' && d.reason && MEMORY_EXCEPTIONS.test(d.reason)
		? d.registers.EXCVADDR ?? d.registers.MTVAL
		: undefined;
	return {
		kind: d.kind,
		line: d.line,
		...d.core !== undefined ? { core: d.core } : {},
		...d.reason ? { reason: d.reason } : {},
		...meaning ? { meaning } : {},
		details: d.details.slice(0, 32),
		...d.task ? { task: d.task } : {},
		...d.assertion ? { assertion: d.assertion } : {},
		...d.abortPc !== undefined ? { abortPc: d.abortPc } : {},
		registers: d.registers,
		...faultAddress !== undefined ? { faultAddress } : {},
		backtrace: d.backtrace,
		backtraceCorrupted: d.backtraceCorrupted,
		...d.elfSha256 ? { elfSha256: d.elfSha256 } : {},
		...d.then ? { then: d.then } : {},
		coreDump: d.coreDump,
	};
}

/** The code address the report blames first: abort's caller for abort/assert, else the exception PC, else the top frame. */
export function crashAddress(crash: EspCrash): number | undefined {
	// abort()/assert: the backtrace starts in ESP-IDF's panic_abort; abort's caller is the real site.
	if ((crash.kind === 'abort' || crash.kind === 'assert') && crash.abortPc !== undefined) {
		return crash.abortPc;
	}
	return crash.registers.PC ?? crash.registers.MEPC ?? crash.backtrace[0]?.pc ?? crash.abortPc;
}
