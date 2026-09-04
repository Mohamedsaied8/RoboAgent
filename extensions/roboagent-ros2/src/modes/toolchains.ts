/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  RoboAgent — toolchain discovery (pure Node). Settings win; otherwise well-known install
 *  locations are probed. Nothing here hardcodes a path into generated projects: discovered
 *  paths are passed on the command line / environment of the build that uses them.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

async function isDir(p: string): Promise<boolean> {
	try {
		return (await fs.promises.stat(p)).isDirectory();
	} catch {
		return false;
	}
}

async function isFile(p: string): Promise<boolean> {
	try {
		return (await fs.promises.stat(p)).isFile();
	} catch {
		return false;
	}
}

async function listDirs(parent: string): Promise<string[]> {
	try {
		const entries = await fs.promises.readdir(parent, { withFileTypes: true });
		return entries.filter(e => e.isDirectory()).map(e => path.join(parent, e.name));
	} catch {
		return [];
	}
}

/**
 * Directory holding `arm-none-eabi-gcc`, or undefined when it should simply be taken from
 * PATH. `configured` is `roboagent.stm32.toolchainPath`.
 */
export async function discoverArmToolchainDir(configured: string | undefined, onPath: boolean): Promise<string | undefined> {
	if (configured && configured.trim()) {
		return configured.trim();
	}
	if (onPath) {
		return undefined;
	}
	const home = os.homedir();
	const candidates: string[] = ['/usr/local/bin', '/opt/homebrew/bin'];
	for (const root of ['/opt', '/usr/local', path.join(home, 'opt'), path.join(home, 'tools')]) {
		for (const dir of await listDirs(root)) {
			if (/gcc-arm-none-eabi|arm-gnu-toolchain|arm-none-eabi/i.test(path.basename(dir))) {
				candidates.push(path.join(dir, 'bin'));
			}
		}
	}
	// xPack (xpm) installs: ~/.local/xPacks/@xpack-dev-tools/arm-none-eabi-gcc/<ver>/.content/bin
	for (const ver of await listDirs(path.join(home, '.local', 'xPacks', '@xpack-dev-tools', 'arm-none-eabi-gcc'))) {
		candidates.push(path.join(ver, '.content', 'bin'));
	}
	for (const dir of candidates) {
		if (await isFile(path.join(dir, 'arm-none-eabi-gcc'))) {
			return dir;
		}
	}
	return undefined;
}

/** An ESP-IDF checkout (`IDF_PATH`): setting → env → ~/esp/esp-idf → newest ~/esp/v<version>/esp-idf. */
export async function discoverIdfPath(configured: string | undefined, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
	const check = async (p: string | undefined) => (p && await isFile(path.join(p, 'tools', 'idf.py'))) ? p : undefined;
	const fromSetting = await check(configured?.trim());
	if (fromSetting) { return fromSetting; }
	const fromEnv = await check(env['IDF_PATH']);
	if (fromEnv) { return fromEnv; }
	const espHome = path.join(os.homedir(), 'esp');
	const direct = await check(path.join(espHome, 'esp-idf'));
	if (direct) { return direct; }
	const versioned = (await listDirs(espHome)).filter(d => /^v\d/.test(path.basename(d))).sort().reverse();
	for (const dir of versioned) {
		const p = await check(path.join(dir, 'esp-idf'));
		if (p) { return p; }
	}
	return undefined;
}

/** ROS 2 distro name: setting → $ROS_DISTRO → newest `/opt/ros/<distro>` (release names sort alphabetically). */
export async function discoverRos2Distro(configured: string | undefined, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
	const check = async (d: string | undefined) => (d && await isFile(path.join('/opt/ros', d, 'setup.bash'))) ? d : undefined;
	const fromSetting = await check(configured?.trim());
	if (fromSetting) { return fromSetting; }
	if (env['ROS_DISTRO']) { return env['ROS_DISTRO']; }   // already sourced in this environment
	const distros = (await listDirs('/opt/ros')).map(d => path.basename(d)).sort();
	for (const d of distros.reverse()) {
		if (await check(d)) { return d; }
	}
	return undefined;
}

/** Whether `/opt/ros` (or a sourced env) exists at all. */
export async function ros2Installed(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
	return !!env['ROS_DISTRO'] || await isDir('/opt/ros');
}
