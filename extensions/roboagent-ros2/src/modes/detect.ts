/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  RoboAgent — project-type detection for the Mode selector (pure filesystem, no vscode).
 *
 *    STM32  — a `*.ioc` (STM32CubeMX) file, an `STM32CubeIDE/` folder, or a RoboAgent STM32
 *             CMake project (`cmake/arm-none-eabi.cmake`).
 *    ESP32  — `sdkconfig` / `sdkconfig.defaults`, or a CMakeLists.txt (root or `main/`) that
 *             mentions `idf_component_register` or `IDF_PATH`.
 *    ROS2   — a `package.xml` at the root or under `src/` (a colcon workspace).
 *
 *  Walks are shallow (bounded depth) and skip build output so detection stays cheap on open.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { Mode } from './modeProvider';

const SKIP_DIRS = new Set(['build', 'install', 'log', 'node_modules', '.git', 'out', 'dist', '.cache', 'managed_components']);

async function exists(p: string): Promise<boolean> {
	try {
		await fs.promises.access(p);
		return true;
	} catch {
		return false;
	}
}

async function isDir(p: string): Promise<boolean> {
	try {
		return (await fs.promises.stat(p)).isDirectory();
	} catch {
		return false;
	}
}

async function readText(p: string): Promise<string | undefined> {
	try {
		return await fs.promises.readFile(p, 'utf8');
	} catch {
		return undefined;
	}
}

/**
 * Find the first file whose name satisfies `match`, searching `root` breadth-first down to
 * `maxDepth` (0 = root only). Directories in SKIP_DIRS are never entered.
 */
export async function findFile(root: string, match: (name: string) => boolean, maxDepth: number): Promise<string | undefined> {
	let frontier: string[] = [root];
	for (let depth = 0; depth <= maxDepth && frontier.length > 0; depth++) {
		const next: string[] = [];
		for (const dir of frontier) {
			let entries: fs.Dirent[];
			try {
				entries = await fs.promises.readdir(dir, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const entry of entries) {
				if (entry.isFile() && match(entry.name)) {
					return path.join(dir, entry.name);
				}
				if (entry.isDirectory() && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
					next.push(path.join(dir, entry.name));
				}
			}
		}
		frontier = next;
	}
	return undefined;
}

export async function detectStm32(folder: string): Promise<boolean> {
	if (await isDir(path.join(folder, 'STM32CubeIDE'))) {
		return true;
	}
	if (await exists(path.join(folder, 'cmake', 'arm-none-eabi.cmake'))) {
		return true;
	}
	return (await findFile(folder, name => name.endsWith('.ioc'), 2)) !== undefined;
}

export async function detectEsp32(folder: string): Promise<boolean> {
	if (await exists(path.join(folder, 'sdkconfig')) || await exists(path.join(folder, 'sdkconfig.defaults'))) {
		return true;
	}
	for (const candidate of [path.join(folder, 'CMakeLists.txt'), path.join(folder, 'main', 'CMakeLists.txt')]) {
		const text = await readText(candidate);
		if (text && /idf_component_register|IDF_PATH/.test(text)) {
			return true;
		}
	}
	return false;
}

export async function detectRos2(folder: string): Promise<boolean> {
	if (await exists(path.join(folder, 'package.xml'))) {
		return true;
	}
	const src = path.join(folder, 'src');
	if (!(await isDir(src))) {
		return false;
	}
	return (await findFile(src, name => name === 'package.xml', 3)) !== undefined;
}

export const DETECTORS: Readonly<Record<Mode, (folder: string) => Promise<boolean>>> = {
	stm32: detectStm32,
	esp32: detectEsp32,
	ros2: detectRos2,
};

/**
 * The mode a folder looks like, or undefined. STM32 and ESP32 markers are more specific than
 * a `package.xml` (a micro-ROS firmware tree can carry both), so they win.
 */
export async function detectMode(folder: string): Promise<Mode | undefined> {
	for (const mode of ['stm32', 'esp32', 'ros2'] as const) {
		if (await DETECTORS[mode](folder)) {
			return mode;
		}
	}
	return undefined;
}
