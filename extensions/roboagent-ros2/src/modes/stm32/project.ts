/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  RoboAgent — reading an existing STM32 project (pure Node, no vscode): how to build it, where
 *  its firmware image lands and which MCU it targets. Covers RoboAgent-generated projects as
 *  well as STM32CubeIDE / STM32CubeMX ones (CMake, a Makefile, or CubeIDE's managed build).
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { STM32_LINKER_SCRIPT } from '../detect';
import { Stm32BuildOptions, Stm32Toolchain } from './generator';

export interface Stm32BuildPlan {
	readonly buildSystem: Stm32Toolchain;
	readonly options: Stm32BuildOptions;
	/** Whether the project's CMake toolchain file / Makefile reads `TOOLCHAIN_PATH` (RoboAgent-generated ones do). */
	readonly usesToolchainPath: boolean;
}

async function readText(p: string): Promise<string | undefined> {
	try {
		return await fs.promises.readFile(p, 'utf8');
	} catch {
		return undefined;
	}
}

async function readNames(dir: string): Promise<string[]> {
	try {
		return await fs.promises.readdir(dir);
	} catch {
		return [];
	}
}

/**
 * How to build the project in `root`: its CMakeLists.txt, else its Makefile, else the makefile
 * STM32CubeIDE generated under `Debug/` (or `Release/`). Undefined when there is nothing to build.
 */
export async function planStm32Build(root: string): Promise<Stm32BuildPlan | undefined> {
	const cmakeLists = await readText(path.join(root, 'CMakeLists.txt'));
	if (cmakeLists !== undefined) {
		// STM32CubeIDE's template names its toolchain file only in comments / CMakePresets.json.
		const setsToolchain = /^\s*set\s*\(\s*CMAKE_TOOLCHAIN_FILE\b/m.test(cmakeLists);
		const toolchainFile = setsToolchain ? undefined : await findCMakeToolchainFile(root);
		const toolchainText = await readText(toolchainFile ? path.resolve(root, toolchainFile) : path.join(root, 'cmake', 'arm-none-eabi.cmake'));
		return {
			buildSystem: 'cmake',
			options: { toolchainFile, cachedGenerator: await cachedCMakeGenerator(path.join(root, 'build')) },
			usesToolchainPath: /\bTOOLCHAIN_PATH\b/.test(cmakeLists + (toolchainText ?? '')),
		};
	}
	const makefile = await readText(path.join(root, 'Makefile'));
	if (makefile !== undefined) {
		return { buildSystem: 'make', options: {}, usesToolchainPath: /\bTOOLCHAIN_PATH\b/.test(makefile) };
	}
	for (const config of ['Debug', 'Release']) {
		if ((await readText(path.join(root, config, 'makefile'))) !== undefined) {
			return { buildSystem: 'make', options: { makeDirectory: config }, usesToolchainPath: false };
		}
	}
	return undefined;
}

/**
 * The arm-none-eabi toolchain file for a CMake project that does not set one: the first
 * `toolchainFile` in CMakePresets.json, else a `*.cmake` in the root or `cmake/` that sets
 * `CMAKE_C_COMPILER` to arm-none-eabi-gcc (STM32CubeIDE's `cubeide-gcc.cmake`). Relative to `root`.
 */
export async function findCMakeToolchainFile(root: string): Promise<string | undefined> {
	const presets = await readText(path.join(root, 'CMakePresets.json'));
	if (presets) {
		try {
			const json = JSON.parse(presets) as { configurePresets?: { toolchainFile?: string }[] };
			for (const preset of json.configurePresets ?? []) {
				const file = preset.toolchainFile?.replace(/\$\{sourceDir\}/g, root);
				if (file && !file.includes('$') && (await readText(path.resolve(root, file))) !== undefined) {
					return path.relative(root, path.resolve(root, file));
				}
			}
		} catch {
			// Not valid JSON; fall through to the file scan.
		}
	}
	for (const dir of ['', 'cmake']) {
		for (const name of (await readNames(path.join(root, dir))).filter(n => n.endsWith('.cmake')).sort()) {
			const rel = path.join(dir, name);
			if (/CMAKE_C_COMPILER[\s\S]*arm-none-eabi|arm-none-eabi[\s\S]*CMAKE_C_COMPILER/.test(await readText(path.join(root, rel)) ?? '')) {
				return rel;
			}
		}
	}
	return undefined;
}

/** `CMAKE_GENERATOR` of an existing build tree, or undefined when `buildDir` was never configured. */
export async function cachedCMakeGenerator(buildDir: string): Promise<string | undefined> {
	const cache = await readText(path.join(buildDir, 'CMakeCache.txt'));
	return cache ? /^CMAKE_GENERATOR:INTERNAL=(.*)$/m.exec(cache)?.[1]?.trim() : undefined;
}

/** Firmware images (`*.elf`) under `build/`, `Debug/` and `Release/`, most recently built first. */
export async function findFirmwareImages(root: string): Promise<string[]> {
	const images: { file: string; mtime: number }[] = [];
	const visit = async (dir: string, depth: number): Promise<void> => {
		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const p = path.join(dir, entry.name);
			if (entry.isFile() && entry.name.endsWith('.elf')) {
				images.push({ file: p, mtime: (await fs.promises.stat(p)).mtimeMs });
			} else if (entry.isDirectory() && depth > 0 && entry.name !== 'CMakeFiles') {
				await visit(p, depth - 1);
			}
		}
	};
	for (const dir of ['build', 'Debug', 'Release']) {
		await visit(path.join(root, dir), 2);
	}
	return images.sort((a, b) => b.mtime - a.mtime).map(i => i.file);
}

/**
 * The MCU part number of an STM32CubeMX / STM32CubeIDE project: the `.ioc`'s `Mcu.CPN` /
 * `Mcu.UserName`, the `.cproject`'s target MCU option, or the linker script name
 * (`STM32F103C8TX_FLASH.ld` → `STM32F103C8TX`).
 */
export async function readStm32Part(root: string): Promise<string | undefined> {
	const names = await readNames(root);
	const ioc = names.find(n => n.endsWith('.ioc'));
	const fromIoc = ioc && /^Mcu\.(?:CPN|UserName)=(STM32\w+)/m.exec(await readText(path.join(root, ioc)) ?? '')?.[1];
	if (fromIoc) {
		return fromIoc.toUpperCase();
	}
	const fromCProject = /target_mcu"[^>]*?\svalue="(STM32\w+)"/.exec(await readText(path.join(root, '.cproject')) ?? '')?.[1];
	if (fromCProject) {
		return fromCProject.toUpperCase();
	}
	const linkerScript = names.find(n => STM32_LINKER_SCRIPT.test(n));
	return linkerScript ? /^(STM32\w+?)_(?:FLASH|RAM)/i.exec(linkerScript)?.[1]?.toUpperCase() : undefined;
}
