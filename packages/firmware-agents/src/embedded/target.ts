/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Target descriptors and the catalog port. The data mirrors the REQ-6 MCU catalog
 *  (extensions/roboagent-ros2/src/modes/stm32/mcuDatabase.ts); the RoboAgent adapter can supply
 *  that catalog directly through ITargetCatalog, so this copy is only the host-agnostic default.
 *--------------------------------------------------------------------------------------------*/

export type TargetVendor = 'stm32' | 'esp32';
export type CoreArchitecture = 'cortex-m' | 'xtensa' | 'riscv';

export interface TargetDescriptor {
	readonly vendor: TargetVendor;
	/** Part number or chip id as the user writes it, e.g. `STM32F103C8T6`, `esp32s3`. */
	readonly part: string;
	/** Family id, e.g. `F1` (STM32) or `esp32s3` (ESP32). */
	readonly family: string;
	readonly arch: CoreArchitecture;
	/** `-mcpu` value for Cortex-M targets. */
	readonly cpu?: string;
	/** Compiler prefix, e.g. `arm-none-eabi-`, `xtensa-esp32s3-elf-`, `riscv32-esp-elf-`. */
	readonly toolchainPrefix: string;
	readonly flashKb?: number;
	readonly ramKb?: number;
	/** OpenOCD target script (`target/<x>.cfg`) for STM32, board script for ESP32. */
	readonly openocdConfig?: string;
	/** False when the part was not in the catalog and sizes are unknown. */
	readonly exact: boolean;
}

/** Port: resolves what the user or the project calls the chip into a descriptor. */
export interface ITargetCatalog {
	resolve(partOrChip: string): TargetDescriptor | undefined;
}

interface Stm32Family {
	readonly id: string;
	readonly cpu: string;
	readonly openocdTarget: string;
}

const STM32_FAMILIES: readonly Stm32Family[] = [
	{ id: 'F0', cpu: 'cortex-m0', openocdTarget: 'stm32f0x' },
	{ id: 'F1', cpu: 'cortex-m3', openocdTarget: 'stm32f1x' },
	{ id: 'F2', cpu: 'cortex-m3', openocdTarget: 'stm32f2x' },
	{ id: 'F3', cpu: 'cortex-m4', openocdTarget: 'stm32f3x' },
	{ id: 'F4', cpu: 'cortex-m4', openocdTarget: 'stm32f4x' },
	{ id: 'F7', cpu: 'cortex-m7', openocdTarget: 'stm32f7x' },
	{ id: 'G0', cpu: 'cortex-m0plus', openocdTarget: 'stm32g0x' },
	{ id: 'G4', cpu: 'cortex-m4', openocdTarget: 'stm32g4x' },
	{ id: 'H7', cpu: 'cortex-m7', openocdTarget: 'stm32h7x' },
	{ id: 'L0', cpu: 'cortex-m0plus', openocdTarget: 'stm32l0' },
	{ id: 'L1', cpu: 'cortex-m3', openocdTarget: 'stm32l1' },
	{ id: 'L4', cpu: 'cortex-m4', openocdTarget: 'stm32l4x' },
	{ id: 'L5', cpu: 'cortex-m33', openocdTarget: 'stm32l5x' },
	{ id: 'U5', cpu: 'cortex-m33', openocdTarget: 'stm32u5x' },
	{ id: 'WB', cpu: 'cortex-m4', openocdTarget: 'stm32wbx' },
	{ id: 'WL', cpu: 'cortex-m4', openocdTarget: 'stm32wlx' },
	{ id: 'C0', cpu: 'cortex-m0plus', openocdTarget: 'stm32c0x' },
];

/** Known parts: [name, flash KB, RAM KB]. Same set as the REQ-6 catalog. */
const STM32_PARTS: readonly (readonly [string, number, number])[] = [
	['STM32F030F4P6', 16, 4], ['STM32F072RBT6', 128, 16], ['STM32F091RCT6', 256, 32],
	['STM32F103C8T6', 64, 20], ['STM32F103RBT6', 128, 20], ['STM32F103ZET6', 512, 64],
	['STM32F303K8T6', 64, 16], ['STM32F303RET6', 512, 80], ['STM32F334R8T6', 64, 16],
	['STM32F401RET6', 512, 96], ['STM32F405RGT6', 1024, 128], ['STM32F407VGT6', 1024, 128],
	['STM32F411CEU6', 512, 128], ['STM32F429ZIT6', 2048, 192], ['STM32F446RET6', 512, 128],
	['STM32F746ZGT6', 1024, 320], ['STM32F767ZIT6', 2048, 512],
	['STM32G030K6T6', 32, 8], ['STM32G071RBT6', 128, 36], ['STM32G0B1RET6', 512, 144],
	['STM32G431KBT6', 128, 32], ['STM32G474RET6', 512, 128], ['STM32G491RET6', 512, 112],
	['STM32H723ZGT6', 1024, 564], ['STM32H743ZIT6', 2048, 1024], ['STM32H750VBT6', 128, 1024], ['STM32H7A3ZIT6', 2048, 1344],
	['STM32L031K6T6', 32, 8], ['STM32L072CZT6', 192, 20],
	['STM32L432KCU6', 256, 64], ['STM32L476RGT6', 1024, 128], ['STM32L4R5ZIT6', 2048, 640],
	['STM32L552ZET6', 512, 256], ['STM32U575ZIT6', 2048, 786], ['STM32U585AII6', 2048, 786],
	['STM32WB55RGV6', 1024, 256], ['STM32WB55CGU6', 1024, 256],
];

interface Esp32Chip {
	readonly id: string;
	readonly arch: CoreArchitecture;
	readonly prefix: string;
	readonly openocdBoard: string;
}

const ESP32_CHIPS: readonly Esp32Chip[] = [
	{ id: 'esp32', arch: 'xtensa', prefix: 'xtensa-esp32-elf-', openocdBoard: 'board/esp32-wrover-kit-3.3v.cfg' },
	{ id: 'esp32s2', arch: 'xtensa', prefix: 'xtensa-esp32s2-elf-', openocdBoard: 'board/esp32s2-kaluga-1.cfg' },
	{ id: 'esp32s3', arch: 'xtensa', prefix: 'xtensa-esp32s3-elf-', openocdBoard: 'board/esp32s3-builtin.cfg' },
	{ id: 'esp32c3', arch: 'riscv', prefix: 'riscv32-esp-elf-', openocdBoard: 'board/esp32c3-builtin.cfg' },
	{ id: 'esp32c6', arch: 'riscv', prefix: 'riscv32-esp-elf-', openocdBoard: 'board/esp32c6-builtin.cfg' },
	{ id: 'esp32h2', arch: 'riscv', prefix: 'riscv32-esp-elf-', openocdBoard: 'board/esp32h2-builtin.cfg' },
];

/** `STM32F407VGT6` → `F4`, `STM32WB55RG` → `WB`; undefined when not an STM32 part number. */
export function stm32FamilyId(part: string): string | undefined {
	const m = /^STM32([A-Z]{1,2})(\d)?/i.exec(part.trim());
	if (!m) {
		return undefined;
	}
	const letters = m[1].toUpperCase();
	return letters.length === 2 ? letters : m[2] ? `${letters}${m[2]}` : undefined;
}

/** Matches a catalog part, also when the project only names a prefix (`STM32F103C8Tx`, `STM32F103C8`). */
function findStm32Part(part: string): readonly [string, number, number] | undefined {
	const wanted = part.toUpperCase().replace(/X+$/, '');
	return STM32_PARTS.find(p => p[0] === wanted) ?? STM32_PARTS.find(p => wanted.length >= 11 && p[0].startsWith(wanted));
}

/** The built-in STM32 + ESP32 catalog. */
export class DefaultTargetCatalog implements ITargetCatalog {
	resolve(partOrChip: string): TargetDescriptor | undefined {
		const raw = partOrChip.trim();
		const lower = raw.toLowerCase().replace(/[-_]/g, '');
		const chip = ESP32_CHIPS.find(c => c.id === lower);
		if (chip) {
			return { vendor: 'esp32', part: chip.id, family: chip.id, arch: chip.arch, toolchainPrefix: chip.prefix, openocdConfig: chip.openocdBoard, exact: true };
		}
		const familyId = stm32FamilyId(raw);
		const family = familyId && STM32_FAMILIES.find(f => f.id === familyId);
		if (!family) {
			return undefined;
		}
		const known = findStm32Part(raw);
		return {
			vendor: 'stm32',
			part: known?.[0] ?? raw.toUpperCase(),
			family: family.id,
			arch: 'cortex-m',
			cpu: family.cpu,
			toolchainPrefix: 'arm-none-eabi-',
			...known ? { flashKb: known[1], ramKb: known[2] } : {},
			openocdConfig: `target/${family.openocdTarget}.cfg`,
			exact: known !== undefined,
		};
	}
}
