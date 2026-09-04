/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  RoboAgent — Mode model and the ModeProvider strategy interface.
 *
 *  A Mode (STM32 / ESP32 / ROS2) decides what the Create, Build and Debug toolbar buttons do.
 *  Each mode is a ModeProvider; the ModeService owns the current selection and dispatches to
 *  the active provider. This file is vscode-free on purpose so the unit tests can import it.
 *--------------------------------------------------------------------------------------------*/

export type Mode = 'stm32' | 'esp32' | 'ros2';

export const MODES: readonly Mode[] = ['stm32', 'esp32', 'ros2'];

export const DEFAULT_MODE: Mode = 'ros2';

export interface ModeDescriptor {
	readonly id: Mode;
	/** Short label used in the toolbar and status bar (`Mode: STM32`). */
	readonly label: string;
	/** One-line description shown in the Mode picker. */
	readonly description: string;
	/** Codicon id (without `$()`), e.g. `circuit-board`. */
	readonly icon: string;
}

export const MODE_DESCRIPTORS: Readonly<Record<Mode, ModeDescriptor>> = {
	stm32: { id: 'stm32', label: 'STM32', icon: 'circuit-board', description: 'Cortex-M firmware — CMake + arm-none-eabi-gcc, OpenOCD / ST-Link debugging' },
	esp32: { id: 'esp32', label: 'ESP32', icon: 'radio-tower', description: 'Espressif ESP-IDF — idf.py build, flash and monitor, OpenOCD/JTAG debugging' },
	ros2: { id: 'ros2', label: 'ROS2', icon: 'rocket', description: 'ROS 2 colcon workspace — ament packages, launch files, node debugging' },
};

export function isMode(value: unknown): value is Mode {
	return typeof value === 'string' && (MODES as readonly string[]).includes(value);
}

export function modeLabel(mode: Mode): string {
	return MODE_DESCRIPTORS[mode].label;
}

/**
 * The strategy every mode implements. `detect` is pure (filesystem only) so the toolbar's
 * enablement can be computed without UI; the other three drive the wizard / task / debug
 * surfaces for that mode.
 */
export interface ModeProvider {
	readonly mode: Mode;
	/** Whether `folderFsPath` contains a project of this mode's kind. */
	detect(folderFsPath: string): Promise<boolean>;
	/** The mode's Create wizard. Resolves when the wizard finishes or is cancelled. */
	create(): Promise<void>;
	/** Build the current project; resolves to the build's exit code when one is known. */
	build(): Promise<number | undefined>;
	/** Debug the current project (offering to build first when nothing is built). */
	debug(): Promise<void>;
}
