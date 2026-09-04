/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  RoboAgent — STM32 MCU database (bundled, data-only).
 *
 *  ST's own device database ships only with its proprietary extension (see docs/extensions.md),
 *  so RoboAgent bundles a curated catalog of common families and parts: the Cortex core (which
 *  fixes the -mcpu / -mfpu / -mfloat-abi flags), the OpenOCD target script, the HAL device
 *  define and the memory sizes the linker-script stub needs. Free-text part numbers are
 *  resolved by family prefix so any STM32 can be used; unknown parts fall back to conservative
 *  defaults and say so in the generated files. Adding a part is a data edit.
 *--------------------------------------------------------------------------------------------*/

export type CortexCore = 'cortex-m0' | 'cortex-m0plus' | 'cortex-m3' | 'cortex-m4' | 'cortex-m7' | 'cortex-m33';

export interface CoreFlags {
	readonly mcpu: string;
	readonly mfpu?: string;
	readonly mfloatAbi: 'soft' | 'hard';
}

export const CORE_FLAGS: Readonly<Record<CortexCore, CoreFlags>> = {
	'cortex-m0': { mcpu: 'cortex-m0', mfloatAbi: 'soft' },
	'cortex-m0plus': { mcpu: 'cortex-m0plus', mfloatAbi: 'soft' },
	'cortex-m3': { mcpu: 'cortex-m3', mfloatAbi: 'soft' },
	'cortex-m4': { mcpu: 'cortex-m4', mfpu: 'fpv4-sp-d16', mfloatAbi: 'hard' },
	'cortex-m7': { mcpu: 'cortex-m7', mfpu: 'fpv5-d16', mfloatAbi: 'hard' },
	'cortex-m33': { mcpu: 'cortex-m33', mfpu: 'fpv5-sp-d16', mfloatAbi: 'hard' },
};

export interface Stm32Family {
	/** Short id used in part-number prefixes, e.g. `F4` (STM32F4xx). */
	readonly id: string;
	readonly label: string;
	readonly core: CortexCore;
	/** OpenOCD `target/<script>.cfg`. */
	readonly openocdTarget: string;
	/** CMSIS device family header prefix, e.g. `stm32f4xx`. */
	readonly cmsisPrefix: string;
	/** Typical flash origin; all STM32 map main flash at 0x08000000. */
	readonly flashOrigin?: string;
}

export interface Stm32Part {
	readonly name: string;
	readonly family: string;
	readonly flashKb: number;
	readonly ramKb: number;
	/** HAL/CMSIS device define, e.g. `STM32F407xx`. */
	readonly define: string;
	/** Per-part core/FPU override (e.g. F74x has a single-precision FPU). */
	readonly core?: CortexCore;
	readonly mfpu?: string;
	readonly description?: string;
}

export const STM32_FAMILIES: readonly Stm32Family[] = [
	{ id: 'F0', label: 'STM32F0 — Cortex-M0 entry level', core: 'cortex-m0', openocdTarget: 'stm32f0x', cmsisPrefix: 'stm32f0xx' },
	{ id: 'F1', label: 'STM32F1 — Cortex-M3 mainstream', core: 'cortex-m3', openocdTarget: 'stm32f1x', cmsisPrefix: 'stm32f1xx' },
	{ id: 'F3', label: 'STM32F3 — Cortex-M4F mixed-signal', core: 'cortex-m4', openocdTarget: 'stm32f3x', cmsisPrefix: 'stm32f3xx' },
	{ id: 'F4', label: 'STM32F4 — Cortex-M4F high performance', core: 'cortex-m4', openocdTarget: 'stm32f4x', cmsisPrefix: 'stm32f4xx' },
	{ id: 'F7', label: 'STM32F7 — Cortex-M7', core: 'cortex-m7', openocdTarget: 'stm32f7x', cmsisPrefix: 'stm32f7xx' },
	{ id: 'G0', label: 'STM32G0 — Cortex-M0+ mainstream', core: 'cortex-m0plus', openocdTarget: 'stm32g0x', cmsisPrefix: 'stm32g0xx' },
	{ id: 'G4', label: 'STM32G4 — Cortex-M4F mixed-signal', core: 'cortex-m4', openocdTarget: 'stm32g4x', cmsisPrefix: 'stm32g4xx' },
	{ id: 'H7', label: 'STM32H7 — Cortex-M7 high performance', core: 'cortex-m7', openocdTarget: 'stm32h7x', cmsisPrefix: 'stm32h7xx' },
	{ id: 'L0', label: 'STM32L0 — Cortex-M0+ ultra-low-power', core: 'cortex-m0plus', openocdTarget: 'stm32l0', cmsisPrefix: 'stm32l0xx' },
	{ id: 'L4', label: 'STM32L4 — Cortex-M4F ultra-low-power', core: 'cortex-m4', openocdTarget: 'stm32l4x', cmsisPrefix: 'stm32l4xx' },
	{ id: 'L5', label: 'STM32L5 — Cortex-M33 (TrustZone)', core: 'cortex-m33', openocdTarget: 'stm32l5x', cmsisPrefix: 'stm32l5xx' },
	{ id: 'U5', label: 'STM32U5 — Cortex-M33 ultra-low-power', core: 'cortex-m33', openocdTarget: 'stm32u5x', cmsisPrefix: 'stm32u5xx' },
	{ id: 'WB', label: 'STM32WB — Cortex-M4F + BLE radio', core: 'cortex-m4', openocdTarget: 'stm32wbx', cmsisPrefix: 'stm32wbxx' },
];

export const STM32_PARTS: readonly Stm32Part[] = [
	// F0
	{ name: 'STM32F030F4P6', family: 'F0', flashKb: 16, ramKb: 4, define: 'STM32F030x6', description: 'TSSOP20, 48 MHz' },
	{ name: 'STM32F072RBT6', family: 'F0', flashKb: 128, ramKb: 16, define: 'STM32F072xB', description: 'LQFP64, USB' },
	{ name: 'STM32F091RCT6', family: 'F0', flashKb: 256, ramKb: 32, define: 'STM32F091xC', description: 'LQFP64, CAN' },
	// F1
	{ name: 'STM32F103C8T6', family: 'F1', flashKb: 64, ramKb: 20, define: 'STM32F103xB', description: '"Blue Pill", LQFP48, 72 MHz' },
	{ name: 'STM32F103RBT6', family: 'F1', flashKb: 128, ramKb: 20, define: 'STM32F103xB', description: 'LQFP64, 72 MHz' },
	{ name: 'STM32F103ZET6', family: 'F1', flashKb: 512, ramKb: 64, define: 'STM32F103xE', description: 'LQFP144, FSMC' },
	// F3
	{ name: 'STM32F303K8T6', family: 'F3', flashKb: 64, ramKb: 16, define: 'STM32F303x8', description: 'LQFP32, Nucleo-32' },
	{ name: 'STM32F303RET6', family: 'F3', flashKb: 512, ramKb: 80, define: 'STM32F303xE', description: 'LQFP64, Nucleo-64' },
	{ name: 'STM32F334R8T6', family: 'F3', flashKb: 64, ramKb: 16, define: 'STM32F334x8', description: 'LQFP64, HRTIM' },
	// F4
	{ name: 'STM32F401RET6', family: 'F4', flashKb: 512, ramKb: 96, define: 'STM32F401xE', description: 'LQFP64, Nucleo-64, 84 MHz' },
	{ name: 'STM32F405RGT6', family: 'F4', flashKb: 1024, ramKb: 128, define: 'STM32F405xx', description: 'LQFP64, 168 MHz' },
	{ name: 'STM32F407VGT6', family: 'F4', flashKb: 1024, ramKb: 128, define: 'STM32F407xx', description: 'LQFP100, Discovery, 168 MHz' },
	{ name: 'STM32F411CEU6', family: 'F4', flashKb: 512, ramKb: 128, define: 'STM32F411xE', description: '"Black Pill", UFQFPN48, 100 MHz' },
	{ name: 'STM32F429ZIT6', family: 'F4', flashKb: 2048, ramKb: 192, define: 'STM32F429xx', description: 'LQFP144, LTDC, 180 MHz' },
	{ name: 'STM32F446RET6', family: 'F4', flashKb: 512, ramKb: 128, define: 'STM32F446xx', description: 'LQFP64, Nucleo-64, 180 MHz' },
	// F7
	{ name: 'STM32F746ZGT6', family: 'F7', flashKb: 1024, ramKb: 320, define: 'STM32F746xx', mfpu: 'fpv5-sp-d16', description: 'LQFP144, Nucleo-144, 216 MHz' },
	{ name: 'STM32F767ZIT6', family: 'F7', flashKb: 2048, ramKb: 512, define: 'STM32F767xx', description: 'LQFP144, Nucleo-144, DP-FPU' },
	// G0
	{ name: 'STM32G030K6T6', family: 'G0', flashKb: 32, ramKb: 8, define: 'STM32G030xx', description: 'LQFP32, 64 MHz' },
	{ name: 'STM32G071RBT6', family: 'G0', flashKb: 128, ramKb: 36, define: 'STM32G071xx', description: 'LQFP64, Nucleo-64' },
	{ name: 'STM32G0B1RET6', family: 'G0', flashKb: 512, ramKb: 144, define: 'STM32G0B1xx', description: 'LQFP64, USB-C PD, FDCAN' },
	// G4
	{ name: 'STM32G431KBT6', family: 'G4', flashKb: 128, ramKb: 32, define: 'STM32G431xx', description: 'LQFP32, Nucleo-32, 170 MHz' },
	{ name: 'STM32G474RET6', family: 'G4', flashKb: 512, ramKb: 128, define: 'STM32G474xx', description: 'LQFP64, Nucleo-64, HRTIM, 170 MHz' },
	{ name: 'STM32G491RET6', family: 'G4', flashKb: 512, ramKb: 112, define: 'STM32G491xx', description: 'LQFP64, Nucleo-64' },
	// H7
	{ name: 'STM32H723ZGT6', family: 'H7', flashKb: 1024, ramKb: 564, define: 'STM32H723xx', description: 'LQFP144, Nucleo-144, 550 MHz' },
	{ name: 'STM32H743ZIT6', family: 'H7', flashKb: 2048, ramKb: 1024, define: 'STM32H743xx', description: 'LQFP144, Nucleo-144, 480 MHz' },
	{ name: 'STM32H750VBT6', family: 'H7', flashKb: 128, ramKb: 1024, define: 'STM32H750xx', description: 'LQFP100, value line (external flash)' },
	{ name: 'STM32H7A3ZIT6', family: 'H7', flashKb: 2048, ramKb: 1344, define: 'STM32H7A3xx', description: 'LQFP144, Nucleo-144, 280 MHz' },
	// L0
	{ name: 'STM32L031K6T6', family: 'L0', flashKb: 32, ramKb: 8, define: 'STM32L031xx', description: 'LQFP32, Nucleo-32' },
	{ name: 'STM32L072CZT6', family: 'L0', flashKb: 192, ramKb: 20, define: 'STM32L072xx', description: 'LQFP48, USB, LoRa modules' },
	// L4
	{ name: 'STM32L432KCU6', family: 'L4', flashKb: 256, ramKb: 64, define: 'STM32L432xx', description: 'UFQFPN32, Nucleo-32' },
	{ name: 'STM32L476RGT6', family: 'L4', flashKb: 1024, ramKb: 128, define: 'STM32L476xx', description: 'LQFP64, Nucleo-64, 80 MHz' },
	{ name: 'STM32L4R5ZIT6', family: 'L4', flashKb: 2048, ramKb: 640, define: 'STM32L4R5xx', description: 'LQFP144, Nucleo-144, 120 MHz' },
	// L5
	{ name: 'STM32L552ZET6', family: 'L5', flashKb: 512, ramKb: 256, define: 'STM32L552xx', description: 'LQFP144, Nucleo-144, TrustZone' },
	// U5
	{ name: 'STM32U575ZIT6', family: 'U5', flashKb: 2048, ramKb: 786, define: 'STM32U575xx', description: 'LQFP144, Nucleo-144, 160 MHz' },
	{ name: 'STM32U585AII6', family: 'U5', flashKb: 2048, ramKb: 786, define: 'STM32U585xx', description: 'UFBGA169, B-U585I-IOT02A' },
	// WB
	{ name: 'STM32WB55RGV6', family: 'WB', flashKb: 1024, ramKb: 256, define: 'STM32WB55xx', description: 'VFQFPN68, Nucleo-WB55, BLE 5' },
	{ name: 'STM32WB55CGU6', family: 'WB', flashKb: 1024, ramKb: 256, define: 'STM32WB55xx', description: 'UFQFPN48, BLE 5' },
];

/** A fully resolved target the generator can work from. */
export interface ResolvedStm32Target {
	readonly part: string;
	readonly family: Stm32Family;
	readonly core: CortexCore;
	readonly flags: CoreFlags;
	readonly flashKb: number;
	readonly ramKb: number;
	readonly define: string;
	/** False when the part was not in the catalog and sizes/define are guesses. */
	readonly exact: boolean;
}

export function getFamily(id: string): Stm32Family | undefined {
	return STM32_FAMILIES.find(f => f.id === id.toUpperCase());
}

export function getPart(name: string): Stm32Part | undefined {
	const wanted = name.trim().toUpperCase();
	return STM32_PARTS.find(p => p.name === wanted);
}

/** `STM32F407VGT6` → `F4`, `STM32WB55RG` → `WB`, `STM32H7A3ZI` → `H7`; undefined when not an STM32 part number. */
export function familyIdFromPartNumber(part: string): string | undefined {
	const m = /^STM32([A-Z]{1,2})(\d)?/i.exec(part.trim());
	if (!m) {
		return undefined;
	}
	const letters = m[1].toUpperCase();
	const digit = m[2];
	// Two-letter series (WB, WL, MP…) have no digit in the family id; single-letter ones do.
	if (letters.length === 2) {
		return letters;
	}
	return digit ? `${letters}${digit}` : undefined;
}

export function isPlausiblePartNumber(part: string): boolean {
	return /^STM32[A-Z]{1,2}\d[A-Z0-9]{3,8}$/i.test(part.trim());
}

/**
 * Resolve a catalog part or a free-text part number. Unknown parts of a known family get the
 * family's core and conservative sizes (256 KB flash / 64 KB RAM) plus `exact: false`; a
 * completely unknown family falls back to Cortex-M4 (soft float) so the project still builds.
 */
export function resolveTarget(partNumber: string): ResolvedStm32Target {
	const part = partNumber.trim().toUpperCase();
	const known = getPart(part);
	const familyId = known?.family ?? familyIdFromPartNumber(part);
	const family = (familyId && getFamily(familyId)) || FALLBACK_FAMILY;
	const core = known?.core ?? family.core;
	const base = CORE_FLAGS[core];
	const flags: CoreFlags = known?.mfpu ? { ...base, mfpu: known.mfpu } : (family === FALLBACK_FAMILY ? { mcpu: 'cortex-m4', mfloatAbi: 'soft' } : base);
	return {
		part,
		family,
		core,
		flags,
		flashKb: known?.flashKb ?? 256,
		ramKb: known?.ramKb ?? 64,
		define: known?.define ?? guessDefine(part),
		exact: known !== undefined,
	};
}

const FALLBACK_FAMILY: Stm32Family = { id: '??', label: 'Unknown STM32 family', core: 'cortex-m4', openocdTarget: 'stm32f4x', cmsisPrefix: 'stm32xxxx' };

/** `STM32F407VGT6` → `STM32F407xx` — the usual HAL define shape; only a guess for unknown parts. */
function guessDefine(part: string): string {
	const m = /^(STM32[A-Z]{1,2}\d{2,3})/i.exec(part);
	return m ? `${m[1].toUpperCase()}xx` : 'STM32xx';
}

/** Compiler flags for a resolved target (`-mcpu=… -mfpu=… -mfloat-abi=… -mthumb`). */
export function cpuFlags(target: ResolvedStm32Target): string[] {
	const flags = [`-mcpu=${target.flags.mcpu}`, '-mthumb'];
	if (target.flags.mfpu) {
		flags.push(`-mfpu=${target.flags.mfpu}`);
	}
	flags.push(`-mfloat-abi=${target.flags.mfloatAbi}`);
	return flags;
}
