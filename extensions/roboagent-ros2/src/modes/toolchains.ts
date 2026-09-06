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

async function readText(p: string): Promise<string | undefined> {
	try {
		return await fs.promises.readFile(p, 'utf8');
	} catch {
		return undefined;
	}
}

// --- ESP-IDF -----------------------------------------------------------------------------

/** Where an ESP-IDF checkout was found; the order below is also the search order. */
export type EspIdfSource = 'setting' | 'env' | 'extension' | 'eim' | 'home';

export interface EspIdfInstallation {
	/** The ESP-IDF checkout (what `IDF_PATH` should be). */
	readonly idfPath: string;
	readonly source: EspIdfSource;
	/** `vX.Y.Z` from `tools/cmake/version.cmake` (or `version.txt`), when readable. */
	readonly version?: string;
}

export interface EspIdfDiscoveryOptions {
	/** `roboagent.esp32.idfPath`. */
	readonly configured?: string;
	/** The ESP-IDF extension's `idf.currentSetup` — the checkout it is configured to use. */
	readonly extensionSetup?: string;
	/** The ESP-IDF extension's `idf.eimIdfJsonPath`, overriding the default EIM location. */
	readonly eimJsonPath?: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly platform?: NodeJS.Platform;
}

/** An ESP-IDF checkout is recognised by its `tools/idf.py`. */
export async function isEspIdfCheckout(p: string | undefined): Promise<boolean> {
	return !!p && !!p.trim() && await isFile(path.join(p.trim(), 'tools', 'idf.py'));
}

/** `vX.Y.Z` of a checkout, from `tools/cmake/version.cmake` (git checkouts) or `version.txt` (release archives). */
export async function readEspIdfVersion(idfPath: string): Promise<string | undefined> {
	const cmake = await readText(path.join(idfPath, 'tools', 'cmake', 'version.cmake'));
	if (cmake) {
		const part = (name: string) => new RegExp(`IDF_VERSION_${name}\\s+(\\d+)`).exec(cmake)?.[1];
		const [major, minor, patch] = [part('MAJOR'), part('MINOR'), part('PATCH')];
		if (major !== undefined && minor !== undefined && patch !== undefined) {
			return `v${major}.${minor}.${patch}`;
		}
	}
	const txt = (await readText(path.join(idfPath, 'version.txt')))?.trim();
	return txt ? txt.split(/\s+/)[0] : undefined;
}

/**
 * The ESP-IDF Installation Manager (EIM) registry the ESP-IDF extension 2.x reads:
 * `C:\Espressif\tools\eim_idf.json` on Windows, else `~/.espressif/tools/eim_idf.json`.
 */
export function defaultEimIdfJsonPath(homeDir: string, platform: NodeJS.Platform = process.platform): string {
	return platform === 'win32' ? 'C:\\Espressif\\tools\\eim_idf.json' : path.join(homeDir, '.espressif', 'tools', 'eim_idf.json');
}

interface EimInstallEntry {
	readonly id?: string;
	readonly name?: string;
	readonly path?: string;
	readonly idfPath?: string;
}

/**
 * The checkouts listed in an `eim_idf.json`, the selected one first, then newest by name.
 * `idfInstalled` is an object keyed by id in current EIM releases and an array in older ones;
 * both are accepted. Missing / unreadable file → empty list.
 */
export async function readEimIdfCheckouts(jsonPath: string): Promise<string[]> {
	const text = await readText(jsonPath);
	if (!text) {
		return [];
	}
	let json: { idfSelectedId?: string; idfInstalled?: Record<string, EimInstallEntry> | EimInstallEntry[] };
	try {
		json = JSON.parse(text);
	} catch {
		return [];
	}
	const raw = json.idfInstalled;
	const entries: EimInstallEntry[] = Array.isArray(raw)
		? raw
		: raw && typeof raw === 'object' ? Object.entries(raw).map(([id, e]) => ({ id, ...e })) : [];
	const byNewest = (a: EimInstallEntry, b: EimInstallEntry) => (b.name ?? '').localeCompare(a.name ?? '', undefined, { numeric: true });
	const selected = entries.filter(e => e.id !== undefined && e.id === json.idfSelectedId);
	const rest = entries.filter(e => !selected.includes(e)).sort(byNewest);
	return [...selected, ...rest].map(e => e.path ?? e.idfPath ?? '').filter(p => !!p);
}

/**
 * Find an ESP-IDF installation: `roboagent.esp32.idfPath` → `$IDF_PATH` → the ESP-IDF
 * extension's current setup → the EIM registry → conventional homes (`~/esp/esp-idf`,
 * `~/esp/v<version>/esp-idf`, EIM's `~/.espressif/v<version>/esp-idf`, and on Windows
 * `C:\esp\v<version>`, `C:\Espressif\frameworks\esp-idf-v<version>`). Undefined when nothing usable exists.
 */
export async function discoverEspIdf(options: EspIdfDiscoveryOptions = {}): Promise<EspIdfInstallation | undefined> {
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const home = env['HOME'] ?? os.homedir();
	const found = async (p: string | undefined, source: EspIdfSource): Promise<EspIdfInstallation | undefined> =>
		(await isEspIdfCheckout(p)) ? { idfPath: p!.trim(), source, version: await readEspIdfVersion(p!.trim()) } : undefined;

	return await found(options.configured, 'setting')
		?? await found(env['IDF_PATH'], 'env')
		?? await found(options.extensionSetup, 'extension')
		?? await firstFound(await eimCheckouts(options.eimJsonPath, home, platform), 'eim', found)
		?? await firstFound(await conventionalCheckouts(home, platform), 'home', found);
}

async function firstFound(candidates: string[], source: EspIdfSource, found: (p: string, source: EspIdfSource) => Promise<EspIdfInstallation | undefined>): Promise<EspIdfInstallation | undefined> {
	for (const candidate of candidates) {
		const hit = await found(candidate, source);
		if (hit) { return hit; }
	}
	return undefined;
}

async function eimCheckouts(configuredJson: string | undefined, home: string, platform: NodeJS.Platform): Promise<string[]> {
	const jsonPath = configuredJson && configuredJson.trim() && await isFile(configuredJson.trim()) ? configuredJson.trim() : defaultEimIdfJsonPath(home, platform);
	return readEimIdfCheckouts(jsonPath);
}

async function conventionalCheckouts(home: string, platform: NodeJS.Platform): Promise<string[]> {
	const newestFirst = (dirs: string[]) => dirs.sort((a, b) => path.basename(b).localeCompare(path.basename(a), undefined, { numeric: true }));
	const versioned = async (parent: string, pattern: RegExp) => newestFirst((await listDirs(parent)).filter(d => pattern.test(path.basename(d))));
	const espHome = path.join(home, 'esp');
	const candidates: string[] = [path.join(espHome, 'esp-idf')];
	candidates.push(...(await versioned(espHome, /^v\d/)).map(d => path.join(d, 'esp-idf')));
	candidates.push(...(await versioned(path.join(home, '.espressif'), /^v\d/)).map(d => path.join(d, 'esp-idf')));
	if (platform === 'win32') {
		candidates.push(...(await versioned('C:\\esp', /^v\d/)).map(d => path.join(d, 'esp-idf')));
		candidates.push(...await versioned('C:\\Espressif\\frameworks', /^esp-idf-v\d/));
	}
	return candidates;
}

/** Just the checkout path of {@link discoverEspIdf} (setting → env → conventional homes). */
export async function discoverIdfPath(configured: string | undefined, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
	return (await discoverEspIdf({ configured, env }))?.idfPath;
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
