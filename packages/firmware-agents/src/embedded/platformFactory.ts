/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createBuildSystem, IBuildSystem } from './build/buildSystems';
import { EspIdfFlasher, IFlasher, OpenOcdFlasher, PlatformIoFlasher, StFlashFlasher } from './flash/flashers';
import { ProjectInfo } from './project';
import { ArmGccToolchain, EspIdfToolchain, IToolchain, PlatformIoToolchain } from './toolchain';

/**
 * The matched set of components for one project (Abstract Factory). P1 covers the development
 * side; the debug side (probe, debug server, debugger, architecture, crash sources, RTOS
 * awareness) joins it in P2.
 */
export interface DevPlatform {
	readonly toolchain: IToolchain;
	readonly buildSystem: IBuildSystem;
	/** In order of preference; empty when the target is unknown. */
	readonly flashers: readonly IFlasher[];
	/** Prefix for binutils (`size`, `objcopy`), e.g. `arm-none-eabi-`. */
	readonly binutilsPrefix?: string;
}

export interface IPlatformFactory {
	create(project: ProjectInfo): DevPlatform;
}

export class DefaultPlatformFactory implements IPlatformFactory {
	create(project: ProjectInfo): DevPlatform {
		const buildSystem = createBuildSystem(project.buildSystem);
		const target = project.target;
		if (project.buildSystem === 'platformio') {
			return { toolchain: new PlatformIoToolchain(), buildSystem, flashers: [new PlatformIoFlasher()], ...target ? { binutilsPrefix: target.toolchainPrefix } : {} };
		}
		if (project.buildSystem === 'esp-idf') {
			const prefix = target?.toolchainPrefix ?? 'xtensa-esp32-elf-';
			return { toolchain: new EspIdfToolchain(prefix), buildSystem, flashers: [new EspIdfFlasher()], binutilsPrefix: prefix };
		}
		if (target?.vendor === 'esp32') {
			// An ESP32 project on plain CMake/Make: the chip's compiler, but no idf.py to flash with.
			return { toolchain: new EspIdfToolchain(target.toolchainPrefix), buildSystem, flashers: [], binutilsPrefix: target.toolchainPrefix };
		}
		const prefix = target?.toolchainPrefix ?? 'arm-none-eabi-';
		const flashers: IFlasher[] = [];
		if (target?.openocdConfig) {
			flashers.push(new OpenOcdFlasher(target.openocdConfig, target.vendor === 'stm32' ? '0x08000000' : undefined));
		}
		if (target?.vendor === 'stm32') {
			flashers.push(new StFlashFlasher(`${prefix}objcopy`));
		}
		return { toolchain: new ArmGccToolchain(prefix), buildSystem, flashers, binutilsPrefix: prefix };
	}
}
