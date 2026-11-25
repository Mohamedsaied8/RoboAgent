/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  ESP32-family knowledge: Xtensa EXCCAUSE and RISC-V mcause codes with what they usually mean
 *  in ESP-IDF firmware, the core registers GDB shows, debug-unit sizes, and the memory a
 *  debugger must never write. Codes and names follow ESP-IDF v6.1
 *  (components/esp_system/port/arch/{xtensa,riscv}/panic_arch.c, soc/<chip>/include/soc/soc_caps.h,
 *  soc/<chip>/register/soc/reg_base.h).
 *--------------------------------------------------------------------------------------------*/

import { BreakpointBudget } from './cortexM';
import { CoreArchitecture } from '../target';

interface CauseInfo {
	readonly name: string;
	readonly meaning: string;
}

/** Xtensa EXCCAUSE values ESP-IDF names, with the usual firmware cause. */
const XTENSA_CAUSES: Readonly<Record<number, CauseInfo>> = {
	0: { name: 'IllegalInstruction', meaning: 'the CPU fetched an invalid instruction: corrupted code, a jump into data, or a function pointer to garbage' },
	1: { name: 'Syscall', meaning: 'a SYSCALL instruction was executed' },
	2: { name: 'InstructionFetchError', meaning: 'error while fetching an instruction (bad address or cache disabled while running from flash)' },
	3: { name: 'LoadStoreError', meaning: 'a load or store the memory does not support, e.g. a byte access to IRAM or an unaligned access to it' },
	4: { name: 'Level1Interrupt', meaning: 'level-1 interrupt (should not reach the panic handler)' },
	5: { name: 'Alloca', meaning: 'MOVSP with spilled register windows (stack corruption?)' },
	6: { name: 'IntegerDivideByZero', meaning: 'integer division by zero' },
	7: { name: 'PCValue', meaning: 'invalid PC value' },
	8: { name: 'Privileged', meaning: 'privileged instruction in user mode' },
	9: { name: 'LoadStoreAlignment', meaning: 'unaligned load or store (a misaligned pointer cast?)' },
	12: { name: 'InstrPDAddrError', meaning: 'instruction fetch PIF data error' },
	13: { name: 'LoadStorePIFDataError', meaning: 'load/store PIF data error' },
	14: { name: 'InstrPIFAddrError', meaning: 'instruction fetch PIF address error' },
	15: { name: 'LoadStorePIFAddrError', meaning: 'load/store PIF address error (access to a non-existent address?)' },
	16: { name: 'InstTLBMiss', meaning: 'instruction TLB miss' },
	17: { name: 'InstTLBMultiHit', meaning: 'instruction TLB multi-hit' },
	18: { name: 'InstFetchPrivilege', meaning: 'instruction fetch privilege violation' },
	20: { name: 'InstrFetchProhibited', meaning: 'jump to an address that is not executable: usually a NULL or corrupted function pointer (PC and EXCVADDR show the target)' },
	24: { name: 'LoadStoreTLBMiss', meaning: 'load/store TLB miss' },
	25: { name: 'LoadStoreTLBMultihit', meaning: 'load/store TLB multi-hit' },
	26: { name: 'LoadStorePrivilege', meaning: 'load/store privilege violation' },
	28: { name: 'LoadProhibited', meaning: 'read from an invalid address: a NULL pointer when EXCVADDR is near 0, otherwise a corrupted or dangling pointer' },
	29: { name: 'StoreProhibited', meaning: 'write to an invalid address: a NULL pointer when EXCVADDR is near 0, otherwise a corrupted or dangling pointer' },
};

/** RISC-V mcause exception codes (interrupt bit clear). */
const RISCV_CAUSES: Readonly<Record<number, CauseInfo>> = {
	0: { name: 'Instruction address misaligned', meaning: 'jump to a misaligned address (corrupted function pointer?)' },
	1: { name: 'Instruction access fault', meaning: 'jump to an address that is not executable: usually a NULL or corrupted function pointer' },
	2: { name: 'Illegal instruction', meaning: 'invalid instruction: corrupted code, a jump into data, or ESP-IDF\'s abort()/assert on RISC-V (unimp)' },
	3: { name: 'Breakpoint', meaning: 'EBREAK without a debugger attached' },
	4: { name: 'Load address misaligned', meaning: 'unaligned load (a misaligned pointer cast?)' },
	5: { name: 'Load access fault', meaning: 'read from an invalid address: a NULL pointer when MTVAL is near 0, otherwise a corrupted or dangling pointer' },
	6: { name: 'Store address misaligned', meaning: 'unaligned store (a misaligned pointer cast?)' },
	7: { name: 'Store access fault', meaning: 'write to an invalid address: a NULL pointer when MTVAL is near 0, otherwise a corrupted or dangling pointer' },
	8: { name: 'Environment call from U-mode', meaning: 'ECALL from user mode' },
	11: { name: 'Environment call from M-mode', meaning: 'ECALL from machine mode' },
};

/**
 * ESP-IDF's pseudo causes (panic_arch.c, PANIC_RSN_*): core dumps store them as 64 + N
 * (XCHAL_EXCCAUSE_NUM + N) to keep them apart from real EXCCAUSE values.
 */
const XTENSA_PSEUDO_CAUSES: Readonly<Record<number, CauseInfo>> = {
	1: { name: 'Unhandled debug exception', meaning: 'a debug exception with no debugger attached: usually FreeRTOS\'s end-of-stack watchpoint (CONFIG_FREERTOS_WATCHPOINT_END_OF_STACK), i.e. the current task overflowed its stack, or a stray BREAK instruction' },
	2: { name: 'Double exception', meaning: 'an exception while handling an exception (often a corrupted stack)' },
	3: { name: 'Unhandled kernel exception', meaning: 'an exception in kernel mode the handler does not cover' },
	4: { name: 'Coprocessor exception', meaning: 'floating-point/coprocessor use where it is not allowed (e.g. FPU in an ISR)' },
	5: { name: 'Interrupt wdt timeout on CPU0', meaning: 'an interrupt handler (or code with interrupts disabled) ran too long on CPU0' },
	6: { name: 'Interrupt wdt timeout on CPU1', meaning: 'an interrupt handler (or code with interrupts disabled) ran too long on CPU1' },
	7: { name: 'Cache error', meaning: 'flash or PSRAM accessed while the cache was disabled (e.g. an ISR without IRAM_ATTR during a flash write)' },
};

/** Core dumps encode an Xtensa pseudo cause N as 64 + N. */
export const XTENSA_PSEUDO_CAUSE_BASE = 64;

/** Name and usual cause of an exception code (Xtensa: 64 + N for ESP-IDF's pseudo causes); `undefined` for unknown codes. */
export function exceptionCause(arch: CoreArchitecture, code: number): CauseInfo | undefined {
	if (arch === 'xtensa') {
		return code >= XTENSA_PSEUDO_CAUSE_BASE ? XTENSA_PSEUDO_CAUSES[code - XTENSA_PSEUDO_CAUSE_BASE] : XTENSA_CAUSES[code];
	}
	// mcause bit 31 marks an interrupt, not an exception.
	return arch === 'riscv' && (code & 0x80000000) === 0 ? RISCV_CAUSES[code] : undefined;
}

/** Finds an exception by the name ESP-IDF prints, e.g. `LoadProhibited`, `Load access fault`. */
export function causeByName(name: string): CauseInfo | undefined {
	const n = name.trim().toLowerCase();
	return [...Object.values(XTENSA_CAUSES), ...Object.values(XTENSA_PSEUDO_CAUSES), ...Object.values(RISCV_CAUSES)].find(c => c.name.toLowerCase() === n);
}

/** Core registers GDB reports for each architecture (names as GDB spells them). */
export const XTENSA_CORE_REGISTERS: readonly string[] = [
	'pc', 'ps', 'a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9', 'a10', 'a11', 'a12', 'a13', 'a14', 'a15',
	'sar', 'lbeg', 'lend', 'lcount', 'windowbase', 'windowstart', 'exccause', 'excvaddr',
];
export const RISCV_CORE_REGISTERS: readonly string[] = [
	'pc', 'ra', 'sp', 'gp', 'tp', 't0', 't1', 't2', 'fp', 's1', 'a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7',
	's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10', 's11', 't3', 't4', 't5', 't6', 'mstatus', 'mtvec', 'mepc', 'mcause', 'mtval',
];

interface EspChipFacts {
	readonly breakpoints: number;
	readonly watchpoints: number;
	readonly cores: number;
	/** Peripheral register space (reads can have side effects). */
	readonly peripherals: readonly (readonly [number, number])[];
	/** Never written by the debugger: eFuses (permanent), flash controllers, flash-mapped memory. */
	readonly protectedRanges: readonly { readonly from: number; readonly to: number; readonly what: string }[];
}

const EFUSE = 'eFuse controller (burning eFuses is permanent)';
const SPI_FLASH = 'the SPI flash controller (SPI0/SPI1)';

const ESP_CHIPS: Readonly<Record<string, EspChipFacts>> = {
	esp32: {
		breakpoints: 2, watchpoints: 2, cores: 2,
		peripherals: [[0x3FF00000, 0x3FF7FFFF], [0x60000000, 0x600BFFFF]],
		protectedRanges: [
			{ from: 0x3FF5A000, to: 0x3FF5AFFF, what: EFUSE },
			{ from: 0x3FF42000, to: 0x3FF43FFF, what: SPI_FLASH },
			// The same peripherals through the AHB alias (0x3FF40000–0x3FF7FFFF at 0x60000000–0x6003FFFF).
			{ from: 0x6001A000, to: 0x6001AFFF, what: EFUSE },
			{ from: 0x60002000, to: 0x60003FFF, what: SPI_FLASH },
			{ from: 0x3FF10000, to: 0x3FF13FFF, what: 'the flash MMU tables' },
			{ from: 0x3F400000, to: 0x3F7FFFFF, what: 'flash-mapped data (DROM)' },
			{ from: 0x400C2000, to: 0x40BFFFFF, what: 'flash-mapped code (IROM)' },
		],
	},
	esp32s2: {
		breakpoints: 2, watchpoints: 2, cores: 1,
		peripherals: [[0x3F400000, 0x3F4FFFFF], [0x60000000, 0x600FFFFF]],
		protectedRanges: [
			{ from: 0x3F41A000, to: 0x3F41AFFF, what: EFUSE },
			{ from: 0x6001A000, to: 0x6001AFFF, what: EFUSE },
			{ from: 0x3F402000, to: 0x3F403FFF, what: SPI_FLASH },
			{ from: 0x60002000, to: 0x60003FFF, what: SPI_FLASH },
			{ from: 0x3F000000, to: 0x3FF7FFFF, what: 'flash-mapped data (DROM)' },
			{ from: 0x40080000, to: 0x407FFFFF, what: 'flash-mapped code (IROM)' },
		],
	},
	esp32s3: {
		breakpoints: 2, watchpoints: 2, cores: 2,
		peripherals: [[0x60000000, 0x600FFFFF]],
		protectedRanges: [
			{ from: 0x60007000, to: 0x60007FFF, what: EFUSE },
			{ from: 0x60002000, to: 0x60003FFF, what: SPI_FLASH },
			{ from: 0x3C000000, to: 0x3DFFFFFF, what: 'flash-mapped data (DROM)' },
			{ from: 0x42000000, to: 0x43FFFFFF, what: 'flash-mapped code (IROM)' },
		],
	},
	esp32c3: {
		breakpoints: 8, watchpoints: 8, cores: 1,
		peripherals: [[0x60000000, 0x600FFFFF]],
		protectedRanges: [
			{ from: 0x60008800, to: 0x60008FFF, what: EFUSE },
			{ from: 0x60002000, to: 0x60003FFF, what: SPI_FLASH },
			{ from: 0x3C000000, to: 0x3C7FFFFF, what: 'flash-mapped data (DROM)' },
			{ from: 0x42000000, to: 0x427FFFFF, what: 'flash-mapped code (IROM)' },
		],
	},
	esp32c6: {
		breakpoints: 4, watchpoints: 4, cores: 1,
		peripherals: [[0x60000000, 0x600DFFFF]],
		protectedRanges: [
			{ from: 0x600B0800, to: 0x600B0FFF, what: EFUSE },
			{ from: 0x60002000, to: 0x60003FFF, what: SPI_FLASH },
			{ from: 0x42000000, to: 0x42FFFFFF, what: 'flash-mapped code and data' },
		],
	},
	esp32h2: {
		breakpoints: 4, watchpoints: 4, cores: 1,
		peripherals: [[0x60000000, 0x600DFFFF]],
		protectedRanges: [
			{ from: 0x600B0800, to: 0x600B0FFF, what: EFUSE },
			{ from: 0x60002000, to: 0x60003FFF, what: SPI_FLASH },
			{ from: 0x42000000, to: 0x42FFFFFF, what: 'flash-mapped code and data' },
		],
	},
};

/** Facts about an ESP32-family chip (`esp32`, `esp32s3`, …); undefined for other parts. */
export function espChip(part: string): EspChipFacts | undefined {
	return ESP_CHIPS[part.toLowerCase()];
}

/** Hardware breakpoint/watchpoint units per core. */
export function espBudget(part: string): BreakpointBudget | undefined {
	const chip = espChip(part);
	return chip ? { breakpoints: chip.breakpoints, watchpoints: chip.watchpoints } : undefined;
}

/**
 * Xtensa return addresses carry the caller's window increment in the top two bits; ESP-IDF maps
 * them back into the code region (0x40000000) and points at the call instruction (−3).
 */
export function xtensaReturnToCall(address: number): number {
	return (((address & 0x3FFFFFFF) | 0x40000000) - 3) >>> 0;
}
