/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IFileSystem } from '../kernel/host';
import { ITargetCatalog, TargetDescriptor } from './target';

export type BuildSystemId = 'cmake' | 'make' | 'platformio' | 'esp-idf';

export interface ProjectInfo {
	/** Project directory, relative to the workspace root (`.` for the root itself). */
	readonly dir: string;
	readonly buildSystem: BuildSystemId;
	readonly target?: TargetDescriptor;
	readonly rtos: 'freertos' | 'none';
	/** Workspace-relative path of FreeRTOSConfig.h, when there is one. */
	readonly freertosConfig?: string;
	/** PlatformIO environment names, when the project is PlatformIO. */
	readonly platformioEnvs?: readonly string[];
	/** How each fact was found, so the model (and the user) can judge it. */
	readonly evidence: readonly string[];
}

/** Folders never searched: build output, VCS data, dependency caches. */
const SKIP_DIRS = new Set(['build', 'out', '.git', 'node_modules', '.pio', '.vscode', 'managed_components', 'cmake-build-debug', 'cmake-build-release']);

export function joinPath(dir: string, name: string): string {
	return dir === '.' || dir === '' ? name : `${dir.replace(/\/+$/, '')}/${name}`;
}

/** Breadth-first search for files matching `match`, bounded by depth and count. */
export async function findFiles(fs: IFileSystem, dir: string, match: (name: string) => boolean, maxDepth = 4, limit = 20): Promise<string[]> {
	const found: string[] = [];
	let level = [dir];
	for (let depth = 0; depth <= maxDepth && level.length && found.length < limit; depth++) {
		const next: string[] = [];
		for (const d of level) {
			let entries;
			try {
				entries = await fs.readDir(d);
			} catch {
				continue;
			}
			for (const e of entries) {
				const p = joinPath(d, e.name);
				if (e.isDirectory) {
					if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) {
						next.push(p);
					}
				} else if (match(e.name) && found.length < limit) {
					found.push(p);
				}
			}
		}
		level = next;
	}
	return found;
}

/** Folders never searched for build output (sources and VCS data only, not `build/`). */
const SKIP_OUTPUT_DIRS = new Set(['.git', 'node_modules', 'CMakeFiles', 'Drivers', 'Middlewares', 'managed_components']);

/**
 * Like {@link findFiles}, for build output: it does descend into `build/`, `out/` and `.pio/`
 * (where artifacts live) and skips only source trees and VCS data.
 */
export async function findBuildOutputs(fs: IFileSystem, dir: string, match: (name: string) => boolean, maxDepth = 3, limit = 50): Promise<string[]> {
	const found: string[] = [];
	let level = [dir];
	for (let depth = 0; depth <= maxDepth && level.length && found.length < limit; depth++) {
		const next: string[] = [];
		for (const d of level) {
			let entries;
			try {
				entries = await fs.readDir(d);
			} catch {
				continue;
			}
			for (const e of entries) {
				const p = joinPath(d, e.name);
				if (e.isDirectory) {
					if (!SKIP_OUTPUT_DIRS.has(e.name)) {
						next.push(p);
					}
				} else if (match(e.name) && found.length < limit) {
					found.push(p);
				}
			}
		}
		level = next;
	}
	return found;
}

async function readIfExists(fs: IFileSystem, path: string): Promise<string | undefined> {
	try {
		return await fs.exists(path) ? await fs.readFile(path) : undefined;
	} catch {
		return undefined;
	}
}

/** Part numbers in free text, including compiler defines such as `-DSTM32F407xx`. */
const STM32_PART = /(?:\b|(?<=-D))STM32[A-Z]{1,2}\d[0-9A-Z]{2,9}\b/gi;
/** `esp32-s3-devkitc-1` → s3, `esp32c3` → c3, `esp32dev` / `esp32doit-devkit-v1` → plain esp32. */
const ESP_CHIP = /esp32(?:[-_]?(s2|s3|c3|c6|h2))?/i;

/**
 * Detects build system, target and RTOS of the project in `dir`. Sources, most authoritative
 * first: `.roboagent/project.json`, STM32CubeMX `.ioc`, `platformio.ini`, ESP-IDF `sdkconfig`,
 * then part numbers mentioned in README / CMakeLists / Makefile.
 */
export async function detectProject(fs: IFileSystem, dir: string, catalog: ITargetCatalog): Promise<ProjectInfo | undefined> {
	const evidence: string[] = [];
	const file = (name: string) => readIfExists(fs, joinPath(dir, name));

	const pioIni = await file('platformio.ini');
	const cmakeLists = await file('CMakeLists.txt');
	const makefile = await file('Makefile') ?? await file('makefile') ?? await file('GNUmakefile');
	const sdkconfig = await file('sdkconfig') ?? await file('sdkconfig.defaults');

	let buildSystem: BuildSystemId | undefined;
	if (pioIni !== undefined) {
		buildSystem = 'platformio';
		evidence.push('platformio.ini present → PlatformIO');
	} else if (cmakeLists?.includes('tools/cmake/project.cmake')) {
		buildSystem = 'esp-idf';
		evidence.push('CMakeLists.txt includes $IDF_PATH/tools/cmake/project.cmake → ESP-IDF');
	} else if (cmakeLists !== undefined) {
		buildSystem = 'cmake';
		evidence.push('CMakeLists.txt present → CMake');
	} else if (makefile !== undefined) {
		buildSystem = 'make';
		evidence.push('Makefile present → Make');
	}
	if (!buildSystem) {
		return undefined;
	}

	// Target: collect candidates in order of authority; the first that resolves wins.
	const candidates: [string, string][] = [];
	const projectJson = await file('.roboagent/project.json');
	if (projectJson) {
		try {
			const parsed = JSON.parse(projectJson) as Record<string, unknown>;
			for (const key of ['part', 'mcu', 'chip', 'target']) {
				if (typeof parsed[key] === 'string') {
					candidates.push([parsed[key] as string, `.roboagent/project.json "${key}"`]);
				}
			}
		} catch {
			evidence.push('.roboagent/project.json is not valid JSON (ignored)');
		}
	}
	for (const ioc of await findFiles(fs, dir, n => n.endsWith('.ioc'), 1, 2)) {
		// Keys are sorted, so `Mcu.Name=STM32F103C(8-B)Tx` (a pattern) comes before the real part.
		const text = await fs.readFile(ioc);
		const user = /^Mcu\.UserName=(\S+)/m.exec(text);
		const name = /^Mcu\.Name=(\S+)/m.exec(text);
		if (user) {
			candidates.push([user[1], `${ioc} Mcu.UserName`]);
		} else if (name) {
			candidates.push([name[1].replace(/\([^)]*\)/g, ''), `${ioc} Mcu.Name`]);
		}
	}
	if (pioIni) {
		const mcu = /^\s*board_build\.mcu\s*=\s*(\S+)/m.exec(pioIni);
		if (mcu) {
			candidates.push([mcu[1], 'platformio.ini board_build.mcu']);
		}
		const board = /^\s*board\s*=\s*(\S+)/m.exec(pioIni);
		const chip = board && ESP_CHIP.exec(board[1]);
		if (chip) {
			candidates.push([`esp32${chip[1] ?? ''}`, `platformio.ini board = ${board![1]}`]);
		} else if (/^\s*platform\s*=\s*espressif32\b/m.test(pioIni)) {
			candidates.push(['esp32', `platformio.ini platform = espressif32${board ? ` (board ${board[1]})` : ''}`]);
		}
	}
	if (sdkconfig) {
		const m = /^CONFIG_IDF_TARGET="(\w+)"/m.exec(sdkconfig);
		if (m) {
			candidates.push([m[1], 'sdkconfig CONFIG_IDF_TARGET']);
		}
	}
	for (const [name, text] of [['README.md', await file('README.md')], ['CMakeLists.txt', cmakeLists], ['Makefile', makefile]] as const) {
		for (const m of text?.matchAll(STM32_PART) ?? []) {
			candidates.push([m[0], `${name} mentions ${m[0]}`]);
		}
	}
	// First resolvable candidate wins; a later exact catalog part of the same family refines it
	// (e.g. a `STM32F103xB` define first, then `STM32F103C8T6` in the README).
	let target: TargetDescriptor | undefined;
	let targetSource = '';
	for (const [candidate, source] of candidates) {
		const resolved = catalog.resolve(candidate);
		if (!resolved || (target && (target.exact || !resolved.exact || resolved.family !== target.family))) {
			continue;
		}
		target = resolved;
		targetSource = source;
		if (resolved.exact) {
			break;
		}
	}
	if (target) {
		evidence.push(`target ${target.part} (${target.exact ? 'catalog part' : 'family only, sizes unknown'}) from ${targetSource}`);
	} else if (buildSystem === 'esp-idf') {
		target = catalog.resolve('esp32');
		evidence.push('ESP-IDF project without CONFIG_IDF_TARGET → assuming esp32');
	}

	const [freertosConfig] = await findFiles(fs, dir, n => n === 'FreeRTOSConfig.h', 5, 1);
	const rtos = freertosConfig || buildSystem === 'esp-idf' ? 'freertos' : 'none';
	if (freertosConfig) {
		evidence.push(`FreeRTOS: ${freertosConfig}`);
	} else if (buildSystem === 'esp-idf') {
		evidence.push('FreeRTOS: always part of ESP-IDF');
	}

	const platformioEnvs = pioIni ? [...pioIni.matchAll(/^\s*\[env:([^\]]+)\]/gm)].map(m => m[1]) : undefined;
	return {
		dir,
		buildSystem,
		...target ? { target } : {},
		rtos,
		...freertosConfig ? { freertosConfig } : {},
		...platformioEnvs ? { platformioEnvs } : {},
		evidence,
	};
}
