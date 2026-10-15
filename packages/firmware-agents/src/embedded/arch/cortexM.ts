/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Cortex-M (ARMv6-M / ARMv7-M / ARMv8-M mainline) knowledge that every vendor shares: the
 *  System Control Block fault registers, exception numbers, the exception stack frame and the
 *  FPB/DWT unit sizes. Addresses and bit positions are from the ARMv7-M Architecture Reference
 *  Manual (B3.2 System Control Space, C1.8 FPB, C1.8 DWT).
 *--------------------------------------------------------------------------------------------*/

import { hex } from '../svd/peripheralDecoder';

/** System Control Block registers used for fault analysis. */
export const SCB = {
	ICSR: 0xE000ED04,
	VTOR: 0xE000ED08,
	SHCSR: 0xE000ED24,
	CFSR: 0xE000ED28,
	HFSR: 0xE000ED2C,
	DFSR: 0xE000ED30,
	MMFAR: 0xE000ED34,
	BFAR: 0xE000ED38,
	AFSR: 0xE000ED3C,
} as const;

/** Flash Patch and Breakpoint control and DWT control registers. */
export const FP_CTRL = 0xE0002000;
export const DWT_CTRL = 0xE0001000;

const EXCEPTIONS: Readonly<Record<number, string>> = {
	0: 'Thread mode', 1: 'Reset', 2: 'NMI', 3: 'HardFault', 4: 'MemManage', 5: 'BusFault', 6: 'UsageFault',
	7: 'SecureFault', 11: 'SVCall', 12: 'DebugMonitor', 14: 'PendSV', 15: 'SysTick',
};

/** Name of an exception number (IPSR), e.g. 3 → HardFault, 16 → IRQ0. */
export function exceptionName(n: number): string {
	return EXCEPTIONS[n] ?? (n >= 16 ? `IRQ${n - 16}` : `reserved exception ${n}`);
}

interface FlagInfo {
	readonly bit: number;
	readonly name: string;
	readonly meaning: string;
}

const CFSR_FLAGS: readonly FlagInfo[] = [
	{ bit: 0, name: 'IACCVIOL', meaning: 'MemManage: instruction fetch from a region the MPU forbids (or execute-never)' },
	{ bit: 1, name: 'DACCVIOL', meaning: 'MemManage: data access to a region the MPU forbids' },
	{ bit: 3, name: 'MUNSTKERR', meaning: 'MemManage: fault while unstacking on exception return' },
	{ bit: 4, name: 'MSTKERR', meaning: 'MemManage: fault while stacking on exception entry (stack overflow into a guard region?)' },
	{ bit: 5, name: 'MLSPERR', meaning: 'MemManage: fault during lazy floating-point state preservation' },
	{ bit: 7, name: 'MMARVALID', meaning: 'MMFAR holds the faulting address' },
	{ bit: 8, name: 'IBUSERR', meaning: 'BusFault: instruction fetch from an invalid address (bad function pointer or corrupted return address?)' },
	{ bit: 9, name: 'PRECISERR', meaning: 'BusFault: precise data access error; BFAR has the address and the stacked PC is the faulting instruction' },
	{ bit: 10, name: 'IMPRECISERR', meaning: 'BusFault: imprecise data access error (a buffered write); the stacked PC is after the faulting instruction' },
	{ bit: 11, name: 'UNSTKERR', meaning: 'BusFault: fault while unstacking on exception return' },
	{ bit: 12, name: 'STKERR', meaning: 'BusFault: fault while stacking on exception entry (stack pointer outside RAM: stack overflow?)' },
	{ bit: 13, name: 'LSPERR', meaning: 'BusFault: fault during lazy floating-point state preservation' },
	{ bit: 15, name: 'BFARVALID', meaning: 'BFAR holds the faulting address' },
	{ bit: 16, name: 'UNDEFINSTR', meaning: 'UsageFault: undefined instruction (jumped into data or a corrupted code pointer?)' },
	{ bit: 17, name: 'INVSTATE', meaning: 'UsageFault: invalid EPSR state, typically a branch to an address with bit 0 clear (ARM state) such as a NULL or data pointer called as a function' },
	{ bit: 18, name: 'INVPC', meaning: 'UsageFault: invalid EXC_RETURN value on exception return (corrupted LR or stack)' },
	{ bit: 19, name: 'NOCP', meaning: 'UsageFault: coprocessor instruction with the coprocessor disabled (FPU used before CPACR enabled it?)' },
	{ bit: 20, name: 'STKOF', meaning: 'UsageFault: stack limit (PSPLIM/MSPLIM) exceeded' },
	{ bit: 24, name: 'UNALIGNED', meaning: 'UsageFault: unaligned access with UNALIGN_TRP set (or an instruction that never allows it, e.g. LDM/STRD)' },
	{ bit: 25, name: 'DIVBYZERO', meaning: 'UsageFault: integer division by zero with DIV_0_TRP set' },
];

const HFSR_FLAGS: readonly FlagInfo[] = [
	{ bit: 1, name: 'VECTTBL', meaning: 'HardFault: bus error reading the vector table (bad VTOR or vector table)' },
	{ bit: 30, name: 'FORCED', meaning: 'HardFault: escalated from a configurable fault (MemManage/BusFault/UsageFault disabled or not allowed to run); see CFSR' },
	{ bit: 31, name: 'DEBUGEVT', meaning: 'HardFault: debug event (e.g. BKPT instruction with no debugger attached)' },
];

const bit = (value: number, n: number) => Math.floor(value / 2 ** n) % 2 === 1;

export interface CortexMFaultInput {
	readonly cfsr: number;
	readonly hfsr: number;
	readonly mmfar: number;
	readonly bfar: number;
	readonly shcsr?: number;
	readonly xpsr: number;
	readonly pc: number;
	readonly lr: number;
	readonly msp: number;
	readonly psp: number;
	/** The 8 words at the stack pointer the exception used (r0, r1, r2, r3, r12, lr, pc, xpsr), when readable. */
	readonly stackedWords?: readonly number[];
	/** Which stack `stackedWords` came from. */
	readonly stackedFrom?: 'MSP' | 'PSP';
}

export interface FaultFlag {
	readonly register: 'CFSR' | 'HFSR';
	readonly flag: string;
	readonly meaning: string;
}

export interface StackedFrame {
	readonly stack: 'MSP' | 'PSP';
	readonly r0: string;
	readonly r1: string;
	readonly r2: string;
	readonly r3: string;
	readonly r12: string;
	/** Return address of the interrupted code. */
	readonly lr: string;
	/** Address of the faulting (or next) instruction. */
	readonly pc: string;
	readonly xpsr: string;
}

export interface CrashReport {
	readonly arch: 'cortex-m';
	/** Exception the core is in now, e.g. `HardFault`, `Thread mode`. */
	readonly currentException: string;
	readonly inFaultHandler: boolean;
	readonly faulted: boolean;
	readonly flags: readonly FaultFlag[];
	readonly faultAddress?: { readonly register: 'MMFAR' | 'BFAR'; readonly address: string };
	readonly stackedFrame?: StackedFrame;
	readonly raw: Readonly<Record<string, string>>;
	/** One paragraph a developer can act on. */
	readonly summary: string;
}

/**
 * Which stack the exception frame is on: EXC_RETURN bit 2 (1 = PSP). Returns undefined when LR
 * does not hold an EXC_RETURN value (the handler has already reused LR).
 */
export function stackFromExcReturn(lr: number): 'MSP' | 'PSP' | undefined {
	const v = lr >>> 0;
	// 0xFFFFFFFF is LR's reset value, not an EXC_RETURN.
	if (v === 0xFFFFFFFF) {
		return undefined;
	}
	// ARMv7-M uses 0xFFFFFFE1…0xFFFFFFFD, ARMv8-M adds security bits in the low byte; all have the top 24 bits set.
	if ((v & 0xFFFFFF00) >>> 0 !== 0xFFFFFF00) {
		return undefined;
	}
	return bit(v, 2) ? 'PSP' : 'MSP';
}

/** Turns the fault registers and the stacked frame into flags with meanings and a summary. */
export function decodeCortexMFault(input: CortexMFaultInput): CrashReport {
	const ipsr = input.xpsr & 0x1FF;
	const current = exceptionName(ipsr);
	const inFaultHandler = ipsr >= 3 && ipsr <= 6;
	const flags: FaultFlag[] = [
		...HFSR_FLAGS.filter(f => bit(input.hfsr, f.bit)).map(f => ({ register: 'HFSR' as const, flag: f.name, meaning: f.meaning })),
		...CFSR_FLAGS.filter(f => bit(input.cfsr, f.bit)).map(f => ({ register: 'CFSR' as const, flag: f.name, meaning: f.meaning })),
	];
	const faulted = flags.length > 0 || inFaultHandler;
	const faultAddress = bit(input.cfsr, 15)
		? { register: 'BFAR' as const, address: hex(input.bfar) }
		: bit(input.cfsr, 7) ? { register: 'MMFAR' as const, address: hex(input.mmfar) } : undefined;
	const w = input.stackedWords;
	const stackedFrame: StackedFrame | undefined = w && w.length >= 8 && input.stackedFrom
		? { stack: input.stackedFrom, r0: hex(w[0]), r1: hex(w[1]), r2: hex(w[2]), r3: hex(w[3]), r12: hex(w[4]), lr: hex(w[5]), pc: hex(w[6]), xpsr: hex(w[7]) }
		: undefined;

	const parts: string[] = [];
	if (!faulted) {
		parts.push(`No fault: the core is in ${current} and the fault status registers are clear.`);
	} else {
		parts.push(inFaultHandler ? `The core is in the ${current} handler.` : `Fault status flags are set (sticky from an earlier fault), the core is now in ${current}.`);
		const causes = flags.filter(f => !['MMARVALID', 'BFARVALID', 'FORCED'].includes(f.flag));
		if (flags.some(f => f.flag === 'FORCED')) {
			parts.push('It is a HardFault escalated from a configurable fault.');
		}
		if (causes.length) {
			parts.push(`Cause: ${causes.map(c => `${c.flag} (${c.meaning})`).join('; ')}.`);
		}
		if (faultAddress) {
			parts.push(`Faulting data address: ${faultAddress.address} (${faultAddress.register}).`);
		}
		if (stackedFrame) {
			parts.push(`The interrupted code was at PC ${stackedFrame.pc} (called from LR ${stackedFrame.lr}), on the ${stackedFrame.stack}.`);
		} else if (inFaultHandler) {
			parts.push('The stacked frame could not be located (LR no longer holds EXC_RETURN); use the backtrace.');
		}
	}
	return {
		arch: 'cortex-m',
		currentException: current,
		inFaultHandler,
		faulted,
		flags,
		...faultAddress ? { faultAddress } : {},
		...stackedFrame ? { stackedFrame } : {},
		raw: {
			CFSR: hex(input.cfsr), HFSR: hex(input.hfsr), MMFAR: hex(input.mmfar), BFAR: hex(input.bfar),
			...input.shcsr !== undefined ? { SHCSR: hex(input.shcsr) } : {},
			xPSR: hex(input.xpsr), PC: hex(input.pc), LR: hex(input.lr), MSP: hex(input.msp), PSP: hex(input.psp),
		},
		summary: parts.join(' '),
	};
}

export interface BreakpointBudget {
	/** Hardware breakpoint comparators (FPB). */
	readonly breakpoints: number;
	/** Data watchpoint comparators (DWT). */
	readonly watchpoints: number;
}

/** Comparator counts from FP_CTRL (NUM_CODE) and DWT_CTRL (NUMCOMP). */
export function budgetFromControlRegisters(fpCtrl: number, dwtCtrl: number): BreakpointBudget {
	const numCode = ((fpCtrl >>> 4) & 0xF) | (((fpCtrl >>> 12) & 0x7) << 4);
	return { breakpoints: numCode, watchpoints: (dwtCtrl >>> 28) & 0xF };
}

/** Core register names GDB reports for Cortex-M that the agent shows (others are omitted). */
export const CORTEX_M_CORE_REGISTERS: readonly string[] = [
	'r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10', 'r11', 'r12',
	'sp', 'lr', 'pc', 'xpsr', 'msp', 'psp', 'primask', 'basepri', 'faultmask', 'control',
];
