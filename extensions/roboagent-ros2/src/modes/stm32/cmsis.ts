/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  RoboAgent — CMSIS headers for STM32 projects.
 *
 *  A generated STM32 project needs the CMSIS core headers (Arm) and the device headers of its
 *  family (ST) for `#include "stm32f1xx.h"`, RCC, GPIOA… ST publishes both on GitHub under
 *  Apache-2.0 (STMicroelectronics/cmsis-core, cmsis-device-<family>). They are downloaded once per
 *  family at a pinned tag, checked against a pinned SHA-256, unpacked into
 *  `~/.local/share/roboagent/cmsis/` and copied into each project's `Drivers/CMSIS/`, together
 *  with the family's real startup file and system_<family>.c.
 *
 *  Pure apart from the injected {@link CmsisIo}, so it can be unit-tested offline.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import { upgradeGeneratedBuildFile } from './generator';
import { ResolvedStm32Target, Stm32Family } from './mcuDatabase';

export interface CmsisPack {
	/** Repository under github.com/STMicroelectronics. */
	readonly repo: string;
	readonly tag: string;
	/** SHA-256 of the tag's .tar.gz from codeload.github.com. */
	readonly sha256: string;
}

/** Arm CMSIS core headers (core_cm*.h, cmsis_gcc.h, …) as redistributed by ST. */
export const CMSIS_CORE: CmsisPack = { repo: 'cmsis-core', tag: 'v5.9.0', sha256: '6cbeb8e53d029f18bae2fbf4be3c33abdce8e8e1a27a2cab69a8550478614fc7' };

/** ST device packs per MCU family (`Stm32Family.id`). Refresh: new tag → download → sha256sum. */
export const CMSIS_DEVICE: Readonly<Record<string, CmsisPack>> = {
	F0: { repo: 'cmsis-device-f0', tag: 'v2.3.8', sha256: '6518a9bd48dab051e00809be0227525d1b7dfbc4981e24037b888a2a08fae5e8' },
	F1: { repo: 'cmsis-device-f1', tag: 'v4.3.5', sha256: '2994ffe58af1f819928f11840359565e0293e91dfb840661da77c2e02de24ca3' },
	F3: { repo: 'cmsis-device-f3', tag: 'v2.3.9', sha256: 'edb331679749d6cca21a93f1edf1f1bed81b63f32b8e06d615ebe17c31c0e329' },
	F4: { repo: 'cmsis-device-f4', tag: 'v2.6.12', sha256: 'f055d3dbaf1bd22a72277d2191b1bf85ee69ebcef48bde29198564bf63041cab' },
	F7: { repo: 'cmsis-device-f7', tag: 'v1.2.11', sha256: '9a6ee49d26d0283e885be20ab29390e93f1f5fd319b585b14161947ccbb76e3d' },
	G0: { repo: 'cmsis-device-g0', tag: 'v1.4.5', sha256: '494164a7f00a3571669df90a48707fe3ec38716647fdecbbad64f18dcea65037' },
	G4: { repo: 'cmsis-device-g4', tag: 'v1.2.6', sha256: 'a150d4b334610d8d8445385e9104d08aa7ae8c4e443b2a7dc6f19c9711d8bb4c' },
	H7: { repo: 'cmsis-device-h7', tag: 'v1.10.8', sha256: '2a07360ddf2c70e945367fb50ff3c452854abf316ed54f489a2864fe0e6e4125' },
	L0: { repo: 'cmsis-device-l0', tag: 'v1.9.4', sha256: '849c8ce05c188df5e012cc7f16b74f9ab32d1012c4580cc15efb3074a933b504' },
	L4: { repo: 'cmsis-device-l4', tag: 'v1.7.5', sha256: 'cc98c0cd067a08df6b827e92613167ac8bd847764603bb4bc77bc96103a11946' },
	L5: { repo: 'cmsis-device-l5', tag: 'v1.0.7', sha256: '5313f7e3b0af80a1a4990bac5144033b3e8ae543af1d209d8b34f79bda792fb8' },
	U5: { repo: 'cmsis-device-u5', tag: 'v1.4.3', sha256: '4fed633cc1a4ddcf39d7f472788c4c7cd4effdc157d3231fcbdf3d5458cf428a' },
	WB: { repo: 'cmsis-device-wb', tag: 'v1.12.4', sha256: 'ca21493e2822ab227f67f1c012399ffffd43de7929c13fce3e67f96b8a27c8df' },
};

const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MARKER = '.roboagent-sha256';

export function cmsisArchiveUrl(pack: CmsisPack): string {
	return `https://codeload.github.com/STMicroelectronics/${pack.repo}/tar.gz/refs/tags/${pack.tag}`;
}

/** `$XDG_DATA_HOME/roboagent/cmsis` (default `~/.local/share/roboagent/cmsis`), next to the agents' tool store. */
export function cmsisStoreDir(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
	return path.join(env['XDG_DATA_HOME'] || path.join(home, '.local', 'share'), 'roboagent', 'cmsis');
}

/** The CMSIS device folder name ST uses for a family: `STM32F1xx`, `STM32WBxx`. */
export function cmsisFamilyFolder(family: Pick<Stm32Family, 'id'>): string {
	return `STM32${family.id}xx`;
}

/** I/O the downloader needs; injected for tests. */
export interface CmsisIo {
	/** GET `url` (following redirects) into memory; rejects above `maxBytes`. */
	download(url: string, maxBytes: number): Promise<Buffer>;
	/** Unpack a .tar.gz into an existing empty folder. */
	extractTarGz(archive: string, destination: string): Promise<void>;
}

/**
 * The unpacked pack (its top folder: `…/cmsis-device-f1-4.3.5`), downloading it first when the
 * store has no verified copy. The archive must match the pinned SHA-256 or nothing is kept.
 */
const inFlight = new Map<string, Promise<string>>();

export async function ensureCmsisPack(pack: CmsisPack, store: string, io: CmsisIo): Promise<string> {
	// One install per pack at a time in this process (two Creates, or Create + Retry).
	const key = path.join(store, `${pack.repo}-${pack.tag}`);
	let pending = inFlight.get(key);
	if (!pending) {
		pending = installPack(pack, store, key, io).finally(() => inFlight.delete(key));
		inFlight.set(key, pending);
	}
	return pending;
}

async function installPack(pack: CmsisPack, store: string, dir: string, io: CmsisIo): Promise<string> {
	const cached = await readTopFolder(dir, pack.sha256);
	if (cached) {
		return cached;
	}
	const archive = await io.download(cmsisArchiveUrl(pack), MAX_ARCHIVE_BYTES);
	const actual = crypto.createHash('sha256').update(archive).digest('hex');
	if (actual !== pack.sha256) {
		throw new Error(`${pack.repo} ${pack.tag}: SHA-256 mismatch (expected ${pack.sha256}, got ${actual}); nothing was installed.`);
	}
	// The store holds code that is compiled into firmware: private to the user.
	await fs.promises.mkdir(store, { recursive: true, mode: 0o700 });
	await fs.promises.chmod(store, 0o700).catch(() => undefined);   // also a store made before this
	await removeStaleStaging(store);
	const staging = await fs.promises.mkdtemp(path.join(store, '.staging-'));
	try {
		const archiveFile = path.join(staging, 'pack.tar.gz');
		await fs.promises.writeFile(archiveFile, archive);
		const unpacked = path.join(staging, 'pack');
		await fs.promises.mkdir(unpacked);
		await io.extractTarGz(archiveFile, unpacked);
		await fs.promises.writeFile(path.join(unpacked, MARKER), pack.sha256);
		// Another RoboAgent window may have installed it meanwhile: keep that copy. An invalid
		// left-over is moved aside (not deleted in place) and removed once the new copy is in.
		if (!(await readTopFolder(dir, pack.sha256))) {
			const aside = `${dir}.old-${process.pid}-${Date.now()}`;
			await fs.promises.rename(dir, aside).catch(() => undefined);
			try {
				await fs.promises.rename(unpacked, dir);
			} catch (e) {
				if (!(await readTopFolder(dir, pack.sha256))) {
					throw e;
				}
			} finally {
				await fs.promises.rm(aside, { recursive: true, force: true });
			}
		}
	} finally {
		await fs.promises.rm(staging, { recursive: true, force: true });
	}
	const installed = await readTopFolder(dir, pack.sha256);
	if (!installed) {
		throw new Error(`${pack.repo} ${pack.tag}: the archive did not unpack into a single folder.`);
	}
	return installed;
}

/** Staging folders older than an hour are left-overs of an interrupted install. */
async function removeStaleStaging(store: string): Promise<void> {
	const hourAgo = Date.now() - 60 * 60 * 1000;
	for (const name of await fs.promises.readdir(store).catch(() => [] as string[])) {
		if (name.startsWith('.staging-')) {
			const stat = await fs.promises.lstat(path.join(store, name)).catch(() => undefined);
			if (stat && stat.mtimeMs < hourAgo) {
				await fs.promises.rm(path.join(store, name), { recursive: true, force: true });
			}
		}
	}
}

async function readTopFolder(dir: string, sha256: string): Promise<string | undefined> {
	try {
		if ((await fs.promises.readFile(path.join(dir, MARKER), 'utf8')).trim() !== sha256) {
			return undefined;
		}
		const entries = (await fs.promises.readdir(dir, { withFileTypes: true })).filter(e => e.isDirectory());
		return entries.length === 1 ? path.join(dir, entries[0].name) : undefined;
	} catch {
		return undefined;
	}
}

/** One file to copy into the project: `from` absolute, `to` relative to the project root. */
export interface CmsisFileCopy {
	readonly from: string;
	readonly to: string;
}

/**
 * The files a project gets from the unpacked packs: core headers → `Drivers/CMSIS/Include/`,
 * device headers and licence → `Drivers/CMSIS/Device/ST/<STM32F1xx>/`, `system_<family>.c` →
 * `Core/Src/`, and the device's gcc startup file over the project's placeholder (when the pack
 * has one for `define`; free-text parts keep the placeholder).
 */
export async function cmsisProjectFiles(coreRoot: string, deviceRoot: string, family: Pick<Stm32Family, 'id' | 'cmsisPrefix'>, define: string, core?: string): Promise<CmsisFileCopy[]> {
	const list = async (dir: string, pattern: RegExp) => {
		try {
			return (await fs.promises.readdir(dir)).filter(f => pattern.test(f)).sort();
		} catch {
			return [];
		}
	};
	const deviceFolder = `Drivers/CMSIS/Device/ST/${cmsisFamilyFolder(family)}`;
	const copies: CmsisFileCopy[] = [];
	for (const header of await list(path.join(coreRoot, 'Core', 'Include'), /\.h$/)) {
		copies.push({ from: path.join(coreRoot, 'Core', 'Include', header), to: `Drivers/CMSIS/Include/${header}` });
	}
	for (const header of await list(path.join(deviceRoot, 'Include'), /\.h$/)) {
		copies.push({ from: path.join(deviceRoot, 'Include', header), to: `${deviceFolder}/Include/${header}` });
	}
	for (const licence of await list(deviceRoot, /^licen[sc]e(\.md|\.txt)?$/i)) {
		copies.push({ from: path.join(deviceRoot, licence), to: `${deviceFolder}/${licence}` });
	}
	const system = `system_${family.cmsisPrefix}.c`;
	if ((await list(path.join(deviceRoot, 'Source', 'Templates'), /\.c$/)).includes(system)) {
		copies.push({ from: path.join(deviceRoot, 'Source', 'Templates', system), to: `Core/Src/${system}` });
	}
	// The project's startup file is `startup_<define>.s`; ST names some single-core-in-a-family parts
	// `startup_<define>_cm4.s` (STM32WB) or `_cm7.s`.
	const startup = `startup_${define.toLowerCase()}.s`;
	const gccStartups = await list(path.join(deviceRoot, 'Source', 'Templates', 'gcc'), /\.s$/);
	const perCore = core === 'cortex-m7' ? ['_cm7.s', '_cm4.s'] : ['_cm4.s', '_cm7.s'];
	const source = [startup, ...perCore.map(suffix => startup.replace(/\.s$/, suffix))].find(name => gccStartups.includes(name));
	if (source) {
		copies.push({ from: path.join(deviceRoot, 'Source', 'Templates', 'gcc', source), to: startup });
	}
	return copies;
}

/** Provenance note written to `Drivers/CMSIS/README.md`. */
export function cmsisReadme(core: CmsisPack, device: CmsisPack): string {
	return `# CMSIS

Added by RoboAgent from STMicroelectronics' GitHub releases (Apache License 2.0, see the notice
in each file and \`Device/ST/*/LICENSE.md\`):

- \`Include/\` — Arm CMSIS core headers, [${core.repo}](https://github.com/STMicroelectronics/${core.repo}) ${core.tag}
- \`Device/ST/\` — device headers, [${device.repo}](https://github.com/STMicroelectronics/${device.repo}) ${device.tag}
- \`Core/Src/system_*.c\` and the \`startup_*.s\` file in the project root come from the device pack
`;
}

export type CmsisInstallResult =
	| { readonly kind: 'installed'; readonly files: number; readonly updatedBuildFile?: string; readonly buildFileNotUpdated?: string }
	/** The project already has its own Drivers/CMSIS (STM32CubeMX / CubeIDE): left alone. */
	| { readonly kind: 'already-present' }
	/** No ST device pack is known for this family. */
	| { readonly kind: 'unknown-family'; readonly family: string }
	/** The pack has no header for this device define (a guessed define for a part outside the catalog). */
	| { readonly kind: 'unknown-device'; readonly define: string };

const GENERATED_MARK = 'Generated by RoboAgent';

/**
 * Put the CMSIS core + device headers into the STM32 project at `root` (downloading the packs
 * when needed). The build file of a project RoboAgent generated before CMSIS support is upgraded
 * to use them. Only when the build file is RoboAgent's (and so compiles system_<family>.c) does
 * the real startup file replace RoboAgent's placeholder (never a startup file the user wrote) and
 * system_<family>.c get added; a build file of the user's own keeps its startup, and the core
 * headers go where it looks for them (`Drivers/CMSIS/Core/Include`, newer STM32Cube layout, or
 * `Drivers/CMSIS/Include`).
 */
export async function installCmsisIntoProject(root: string, target: Pick<ResolvedStm32Target, 'family' | 'define'> & { readonly core?: string }, io: CmsisIo, store = cmsisStoreDir()): Promise<CmsisInstallResult> {
	const device = CMSIS_DEVICE[target.family.id];
	if (!device) {
		return { kind: 'unknown-family', family: target.family.id };
	}
	const realRoot = await fs.promises.realpath(root);
	const readme = path.join(root, 'Drivers', 'CMSIS', 'README.md');
	const hasCmsis = await exists(path.join(root, 'Drivers', 'CMSIS', 'Include')) || await exists(path.join(root, 'Drivers', 'CMSIS', 'Core', 'Include'));
	if (hasCmsis && !((await readOptional(readme)) ?? '').includes('Added by RoboAgent')) {
		return { kind: 'already-present' };
	}
	const coreRoot = await ensureCmsisPack(CMSIS_CORE, store, io);
	const deviceRoot = await ensureCmsisPack(device, store, io);
	// A guessed define (part outside the catalog) that the pack does not know would make the family
	// header stop with `#error "Please select first the target STM32…"`: add nothing in that case.
	if (!(await exists(path.join(deviceRoot, 'Include', `${target.define.toLowerCase()}.h`)))) {
		return { kind: 'unknown-device', define: target.define };
	}

	// The marker goes first, so a copy that fails half-way is finished by the next attempt instead
	// of being taken for the user's own Drivers/CMSIS.
	await writeInside(realRoot, readme, cmsisReadme(CMSIS_CORE, device));

	// The build file decides what else the project gets (see above).
	let updatedBuildFile: string | undefined;
	let buildFileNotUpdated: string | undefined;
	let ownBuild = false;
	let coreFolder = 'Drivers/CMSIS/Include';
	for (const [name, kind] of [['CMakeLists.txt', 'cmake'], ['Makefile', 'make']] as const) {
		const file = path.join(root, name);
		let text = await readOptional(file);
		if (text === undefined) {
			continue;
		}
		if (text.includes(GENERATED_MARK) && !text.includes('Drivers/CMSIS/Include')) {
			const upgraded = upgradeGeneratedBuildFile(kind, text, target);
			if (upgraded === undefined) {
				buildFileNotUpdated = name;
			} else {
				await writeInside(realRoot, file, upgraded);
				updatedBuildFile = name;
				text = upgraded;
			}
		}
		ownBuild ||= text.includes(GENERATED_MARK) && text.includes('Drivers/CMSIS/Include');
		if (!text.includes(GENERATED_MARK) && text.includes('Drivers/CMSIS/Core/Include')) {
			coreFolder = 'Drivers/CMSIS/Core/Include';
		}
	}
	if (ownBuild) {
		// IntelliSense: drop the HAL define older RoboAgent projects carry.
		const props = path.join(root, '.vscode', 'c_cpp_properties.json');
		const text = await readOptional(props);
		if (text?.includes('USE_HAL_DRIVER')) {
			try {
				const json = JSON.parse(text) as { configurations?: { defines?: string[] }[] };
				for (const config of json.configurations ?? []) {
					config.defines = config.defines?.filter(d => !/^USE_HAL_DRIVER(=.*)?$/.test(d));
				}
				await writeInside(realRoot, props, JSON.stringify(json, undefined, '\t') + '\n');
			} catch {
				// Not plain JSON (comments): left as the user wrote it.
			}
		}
	}

	let files = 0;
	for (const copy of await cmsisProjectFiles(coreRoot, deviceRoot, target.family, target.define, target.core)) {
		const isStartup = copy.to.startsWith('startup_');
		const isSystem = copy.to.startsWith('Core/Src/system_');
		if ((isStartup || isSystem) && !ownBuild) {
			continue;   // the user's build file would not compile system_*.c, which ST's startup needs
		}
		const to = copy.to.startsWith('Drivers/CMSIS/Include/') ? coreFolder + copy.to.slice('Drivers/CMSIS/Include'.length) : copy.to;
		const dest = path.join(root, ...to.split('/'));
		const existing = await readOptional(dest);
		if (existing !== undefined && ((isStartup && !existing.includes(GENERATED_MARK)) || isSystem)) {
			continue;   // the user's own startup / system file
		}
		await writeInside(realRoot, dest, await fs.promises.readFile(copy.from));
		files++;
	}
	if (ownBuild && files > 0) {
		// A build folder configured before Drivers/CMSIS existed must re-run CMake: its
		// `if(EXISTS Drivers/CMSIS/Include)` decided to leave out system_*.c, which ST's startup calls.
		const cmakeLists = path.join(root, 'CMakeLists.txt');
		if (await exists(cmakeLists)) {
			const now = new Date();
			await fs.promises.utimes(cmakeLists, now, now).catch(() => undefined);
		}
	}
	return { kind: 'installed', files, updatedBuildFile, buildFileNotUpdated };
}

/**
 * Write `file` only if it stays inside the project: its folder must resolve (symlinks followed)
 * under `realRoot`, and an existing symlink at `file` itself is replaced, never written through.
 */
async function writeInside(realRoot: string, file: string, content: string | Buffer): Promise<void> {
	// Check the nearest existing ancestor first, so no folder is created outside the project either.
	let existing = path.dirname(file);
	while (!(await exists(existing)) && path.dirname(existing) !== existing) {
		existing = path.dirname(existing);
	}
	const outside = (dir: string) => {
		const relative = path.relative(realRoot, dir);
		return relative.startsWith('..') || path.isAbsolute(relative);
	};
	if (outside(await fs.promises.realpath(existing))) {
		throw new Error(`${file} is outside the project (through a symbolic link); not written.`);
	}
	await fs.promises.mkdir(path.dirname(file), { recursive: true });
	const realDir = await fs.promises.realpath(path.dirname(file));
	if (outside(realDir)) {
		throw new Error(`${file} is outside the project (through a symbolic link); not written.`);
	}
	const target = path.join(realDir, path.basename(file));
	const stat = await fs.promises.lstat(target).catch(() => undefined);
	if (stat?.isSymbolicLink()) {
		await fs.promises.unlink(target);
	}
	await fs.promises.writeFile(target, content);
}

async function exists(p: string): Promise<boolean> {
	try {
		await fs.promises.access(p);
		return true;
	} catch {
		return false;
	}
}

async function readOptional(file: string): Promise<string | undefined> {
	try {
		return await fs.promises.readFile(file, 'utf8');
	} catch {
		return undefined;
	}
}

/** The real {@link CmsisIo}: Node https (redirects followed, size-capped) and the system `tar`. */
export function nodeCmsisIo(): CmsisIo {
	return {
		download: (url, maxBytes) => httpsGet(url, maxBytes, 5),
		extractTarGz: (archive, destination) => new Promise((resolve, reject) => {
			cp.execFile('tar', ['-xzf', archive, '-C', destination, '--no-same-owner', '--no-same-permissions'], { timeout: 120_000 }, error => error ? reject(error) : resolve());
		}),
	};
}

function httpsGet(url: string, maxBytes: number, redirectsLeft: number): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const request = https.get(url, { timeout: 60_000 }, response => {
			const status = response.statusCode ?? 0;
			if (status >= 300 && status < 400 && response.headers.location) {
				response.resume();
				if (redirectsLeft <= 0) {
					reject(new Error(`Too many redirects downloading ${url}`));
					return;
				}
				const next = new URL(response.headers.location, url);
				if (next.protocol !== 'https:') {
					reject(new Error(`Refusing a non-https redirect for ${url}`));
					return;
				}
				httpsGet(next.toString(), maxBytes, redirectsLeft - 1).then(resolve, reject);
				return;
			}
			if (status !== 200) {
				response.resume();
				reject(new Error(`HTTP ${status} downloading ${url}`));
				return;
			}
			const chunks: Buffer[] = [];
			let size = 0;
			response.on('data', (chunk: Buffer) => {
				size += chunk.length;
				if (size > maxBytes) {
					request.destroy(new Error(`${url} is larger than ${maxBytes} bytes`));
					return;
				}
				chunks.push(chunk);
			});
			response.on('end', () => resolve(Buffer.concat(chunks)));
			response.on('error', reject);
		});
		request.on('timeout', () => request.destroy(new Error(`Timed out downloading ${url}`)));
		request.on('error', reject);
	});
}
