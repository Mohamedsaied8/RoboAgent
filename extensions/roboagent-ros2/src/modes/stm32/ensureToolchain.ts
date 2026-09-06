/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  RoboAgent — `roboagent.stm32.ensureToolchain`: is the STM32 toolchain installed?
 *
 *  STM32 mode needs host tools that RoboAgent cannot bundle: the Arm GNU toolchain
 *  (`arm-none-eabi-gcc`), `cmake` or `make`, and for debugging `openocd` plus a GDB
 *  (`arm-none-eabi-gdb`, or the distro's `gdb-multiarch`). STM32 Create / Build / Debug call
 *  this first; when something required is missing the user is offered an install command for
 *  the machine's package manager (run in a terminal, so `sudo` can ask for a password), the
 *  Arm download page when there is none, or a folder picker for a toolchain already on disk.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { MessageAction, ModeHost } from '../modeHost';
import { discoverArmToolchainDir } from '../toolchains';
import { Stm32Toolchain } from './generator';

export const ARM_GNU_TOOLCHAIN_URL = 'https://developer.arm.com/downloads/-/arm-gnu-toolchain-downloads';

export type Stm32Tool = 'gcc' | 'cmake' | 'make' | 'openocd' | 'gdb';
export type Stm32Purpose = 'create' | 'build' | 'debug';
export type PackageManager = 'apt' | 'dnf' | 'pacman' | 'brew';

export interface Stm32Tools {
	/** Directory holding `arm-none-eabi-gcc` when it is not simply on PATH (setting or a well-known location). */
	readonly toolchainDir: string | undefined;
	/** The GDB to run: `<toolchainDir>/arm-none-eabi-gdb`, `arm-none-eabi-gdb` or `gdb-multiarch` on PATH. */
	readonly gdbPath: string | undefined;
	readonly present: ReadonlySet<Stm32Tool>;
}

export interface EnsureToolchainOptions {
	/** When everything required is present, say nothing (used before Create / Build / Debug). */
	readonly silentIfPresent?: boolean;
	/** What the user was about to do; decides what is required and tailors the message. */
	readonly purpose?: Stm32Purpose;
	/** For `build`: the project's build system (`cmake` needs cmake, `make` needs make). */
	readonly buildSystem?: Stm32Toolchain;
	/** Offer to go on without the toolchain (Create can still scaffold the project files). */
	readonly allowContinue?: boolean;
}

export interface EnsureToolchainResult {
	readonly tools: Stm32Tools;
	/** Every tool the purpose needs is present (possibly after *Use Existing Toolchain…*). */
	readonly ready: boolean;
	/** True when the user chose the `allowContinue` action. */
	readonly continueWithout: boolean;
}

const TOOL_LABEL: Readonly<Record<Stm32Tool, string>> = {
	gcc: 'arm-none-eabi-gcc (Arm GNU toolchain)',
	cmake: 'cmake',
	make: 'make',
	openocd: 'openocd',
	gdb: 'arm-none-eabi-gdb / gdb-multiarch',
};

const PM_EXECUTABLE: Readonly<Record<PackageManager, string>> = { apt: 'apt-get', dnf: 'dnf', pacman: 'pacman', brew: 'brew' };
const PM_LABEL: Readonly<Record<PackageManager, string>> = { apt: 'apt', dnf: 'dnf', pacman: 'pacman', brew: 'Homebrew' };

/** Distro packages per tool. Homebrew's Arm toolchain (with GDB) is the `gcc-arm-embedded` cask, handled separately. */
const PACKAGES: Readonly<Record<PackageManager, Readonly<Record<Stm32Tool, readonly string[]>>>> = {
	apt: { gcc: ['gcc-arm-none-eabi', 'libnewlib-arm-none-eabi', 'libstdc++-arm-none-eabi-newlib'], cmake: ['cmake'], make: ['make'], openocd: ['openocd'], gdb: ['gdb-multiarch'] },
	dnf: { gcc: ['arm-none-eabi-gcc-cs', 'arm-none-eabi-gcc-cs-c++', 'arm-none-eabi-newlib'], cmake: ['cmake'], make: ['make'], openocd: ['openocd'], gdb: ['gdb'] },
	pacman: { gcc: ['arm-none-eabi-gcc', 'arm-none-eabi-newlib'], cmake: ['cmake'], make: ['make'], openocd: ['openocd'], gdb: ['arm-none-eabi-gdb'] },
	brew: { gcc: [], cmake: ['cmake'], make: ['make'], openocd: ['open-ocd'], gdb: [] },
};

/** What a purpose needs; the palette check (no purpose) wants the whole stack. */
export function requiredStm32Tools(purpose: Stm32Purpose | undefined, buildSystem: Stm32Toolchain = 'cmake'): Stm32Tool[] {
	switch (purpose) {
		case 'create': return ['gcc'];
		case 'build': return ['gcc', buildSystem === 'make' ? 'make' : 'cmake'];
		case 'debug': return ['openocd', 'gdb'];
		default: return ['gcc', 'cmake', 'openocd', 'gdb'];
	}
}

export function missingStm32Tools(tools: Stm32Tools, required: readonly Stm32Tool[]): Stm32Tool[] {
	return required.filter(t => !tools.present.has(t));
}

/** The shell line that installs `missing` with `pm`; shown to the user and run in a terminal. */
export function stm32InstallCommand(pm: PackageManager, missing: readonly Stm32Tool[]): string {
	const packages = [...new Set(missing.flatMap(t => PACKAGES[pm][t]))].join(' ');
	switch (pm) {
		case 'apt': return `sudo apt-get update && sudo apt-get install -y ${packages}`;
		case 'dnf': return `sudo dnf install -y ${packages}`;
		case 'pacman': return `sudo pacman -S --needed ${packages}`;
		case 'brew': {
			const steps: string[] = [];
			if (missing.includes('gcc') || missing.includes('gdb')) { steps.push('brew install --cask gcc-arm-embedded'); }
			if (packages) { steps.push(`brew install ${packages}`); }
			return steps.join(' && ');
		}
	}
}

export async function detectPackageManager(host: ModeHost): Promise<PackageManager | undefined> {
	for (const pm of ['apt', 'dnf', 'pacman', 'brew'] as const) {
		if (await host.toolOnPath(PM_EXECUTABLE[pm])) { return pm; }
	}
	return undefined;
}

/** `folder` itself or its `bin/` when one of them holds `arm-none-eabi-gcc`. */
export async function resolveToolchainBinDir(host: ModeHost, folder: string): Promise<string | undefined> {
	for (const dir of [folder, path.join(folder, 'bin')]) {
		if (await host.fileExists(path.join(dir, 'arm-none-eabi-gcc'))) { return dir; }
	}
	return undefined;
}

/** Probe PATH, `roboagent.stm32.toolchainPath` and the well-known install locations. */
export async function probeStm32Tools(host: ModeHost): Promise<Stm32Tools> {
	const present = new Set<Stm32Tool>();
	const gccOnPath = await host.toolOnPath('arm-none-eabi-gcc');
	const configured = host.getSetting<string>('roboagent.stm32.toolchainPath')?.trim() || undefined;
	let toolchainDir = await discoverArmToolchainDir(configured, gccOnPath);
	if (toolchainDir && !(await host.fileExists(path.join(toolchainDir, 'arm-none-eabi-gcc')))) {
		host.log(`STM32: roboagent.stm32.toolchainPath "${toolchainDir}" has no arm-none-eabi-gcc — ignoring it.`);
		toolchainDir = await discoverArmToolchainDir(undefined, gccOnPath);
	}
	if (gccOnPath || toolchainDir) { present.add('gcc'); }
	for (const tool of ['cmake', 'make', 'openocd'] as const) {
		if (await host.toolOnPath(tool)) { present.add(tool); }
	}
	let gdbPath: string | undefined;
	if (toolchainDir && await host.fileExists(path.join(toolchainDir, 'arm-none-eabi-gdb'))) {
		gdbPath = path.join(toolchainDir, 'arm-none-eabi-gdb');
	} else if (await host.toolOnPath('arm-none-eabi-gdb')) {
		gdbPath = 'arm-none-eabi-gdb';
	} else if (await host.toolOnPath('gdb-multiarch')) {
		gdbPath = 'gdb-multiarch';
	}
	if (gdbPath) { present.add('gdb'); }
	return { toolchainDir, gdbPath, present };
}

export function describeStm32Tools(tools: Stm32Tools): string {
	const parts: string[] = [];
	parts.push(tools.present.has('gcc') ? `arm-none-eabi-gcc ${tools.toolchainDir ? `in ${tools.toolchainDir}` : 'on PATH'}` : 'no arm-none-eabi-gcc');
	for (const tool of ['cmake', 'make', 'openocd'] as const) {
		parts.push(tools.present.has(tool) ? tool : `no ${tool}`);
	}
	parts.push(tools.gdbPath ? `gdb: ${tools.gdbPath}` : 'no gdb');
	return parts.join(', ');
}

/** Startup log line (never a notification). */
export async function logStm32ToolchainStatus(host: ModeHost): Promise<void> {
	const tools = await probeStm32Tools(host);
	const missing = missingStm32Tools(tools, requiredStm32Tools(undefined));
	host.log(missing.length === 0
		? `STM32: toolchain complete — ${describeStm32Tools(tools)}.`
		: `STM32: toolchain incomplete (${describeStm32Tools(tools)}) — Create / Build / Debug will offer to install what they need (roboagent.stm32.ensureToolchain).`);
}

/**
 * Make sure the tools `purpose` needs exist. When some are missing, tell the user and offer
 * to install them (or to locate an existing toolchain); resolves once the notification is
 * answered or dismissed.
 */
export async function ensureStm32Toolchain(host: ModeHost, options: EnsureToolchainOptions = {}): Promise<EnsureToolchainResult> {
	const required = requiredStm32Tools(options.purpose, options.buildSystem);
	let tools = await probeStm32Tools(host);
	let missing = missingStm32Tools(tools, required);
	if (missing.length === 0) {
		host.log(`STM32: toolchain ready — ${describeStm32Tools(tools)}.`);
		if (!options.silentIfPresent) {
			await host.showInfo(vscode.l10n.t('STM32 toolchain found: {0}.', describeStm32Tools(tools)));
		}
		return { tools, ready: true, continueWithout: false };
	}
	host.log(`STM32: missing ${missing.map(t => TOOL_LABEL[t]).join(', ')} (${describeStm32Tools(tools)}).`);

	const pm = await detectPackageManager(host);
	let continueWithout = false;
	let relocated = false;
	const actions: MessageAction[] = [
		pm
			? { title: vscode.l10n.t('Install with {0}…', PM_LABEL[pm]), run: () => installWith(host, pm, missing) }
			: { title: vscode.l10n.t('Download Toolchain…'), run: () => openDownloadPage(host) },
	];
	if (missing.includes('gcc') || missing.includes('gdb')) {
		actions.push({ title: vscode.l10n.t('Use Existing Toolchain…'), run: async () => { relocated = await locateToolchain(host); } });
	}
	if (options.allowContinue) {
		actions.push({ title: vscode.l10n.t('Create Anyway'), run: () => { continueWithout = true; } });
	}
	await host.showWarning(missingMessage(missing, options.purpose, pm), ...actions);
	if (relocated) {
		tools = await probeStm32Tools(host);
		missing = missingStm32Tools(tools, required);
	}
	return { tools, ready: missing.length === 0, continueWithout };
}

function missingMessage(missing: readonly Stm32Tool[], purpose: Stm32Purpose | undefined, pm: PackageManager | undefined): string {
	const what = vscode.l10n.t('The STM32 toolchain is not fully installed on this machine — missing: {0}.', missing.map(t => TOOL_LABEL[t]).join(', '));
	const consequence = purpose === 'create'
		? vscode.l10n.t('The project can be created, but it cannot be built until the compiler is installed.')
		: purpose === 'build'
			? vscode.l10n.t('The project cannot be built without it.')
			: purpose === 'debug'
				? vscode.l10n.t('The project cannot be flashed or debugged without it.')
				: '';
	const offer = pm ? vscode.l10n.t('Install it with {0} now?', PM_LABEL[pm]) : vscode.l10n.t('Download it now?');
	return [what, consequence, offer].filter(s => s).join(' ');
}

/** Run the package-manager command in a visible terminal so `sudo` can prompt. */
async function installWith(host: ModeHost, pm: PackageManager, missing: readonly Stm32Tool[]): Promise<void> {
	const command = stm32InstallCommand(pm, missing);
	host.log(`STM32: installing with ${pm}: ${command}`);
	host.sendToTerminal('RoboAgent: STM32 toolchain install', command);
	await host.showInfo(vscode.l10n.t('The install command is running in the "RoboAgent: STM32 toolchain install" terminal (enter your password there if asked). When it finishes, run Create / Build / Debug again.'));
}

async function openDownloadPage(host: ModeHost): Promise<void> {
	host.log(`STM32: opening ${ARM_GNU_TOOLCHAIN_URL}.`);
	await host.openExternal(ARM_GNU_TOOLCHAIN_URL);
	await host.showInfo(vscode.l10n.t('Download and unpack the Arm GNU Toolchain from the page that opened, then choose "Use Existing Toolchain…" (or set roboagent.stm32.toolchainPath) to point RoboAgent at its bin folder. OpenOCD and CMake are separate installs.'));
}

/** Folder picker for a toolchain already on disk; stored in `roboagent.stm32.toolchainPath`. */
async function locateToolchain(host: ModeHost): Promise<boolean> {
	const picked = await host.pickFolder(vscode.l10n.t('Select the Arm GNU toolchain folder (the one containing arm-none-eabi-gcc, or its parent)'), vscode.l10n.t('Use this toolchain'));
	if (!picked) {
		return false;
	}
	const dir = await resolveToolchainBinDir(host, picked);
	if (!dir) {
		await host.showError(vscode.l10n.t('"{0}" contains no arm-none-eabi-gcc (neither the folder nor its bin/ subfolder).', picked));
		return false;
	}
	await host.updateSetting('roboagent.stm32.toolchainPath', dir);
	host.log(`STM32: roboagent.stm32.toolchainPath set to ${dir}.`);
	return true;
}
