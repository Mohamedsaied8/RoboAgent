/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IAgentHost } from '../kernel/host';
import { BuildSystemId } from './project';

export type ToolPurpose = 'build' | 'flash' | 'debug';

/** A logical tool with the executables that can provide it, in order of preference. */
export interface RequiredTool {
	/** Logical name, e.g. `gcc`, `gdb`, `openocd`. Also the key for install packages. */
	readonly name: InstallableTool | 'idf.py' | 'pio' | 'esptool';
	readonly commands: readonly string[];
	readonly purpose: ToolPurpose;
	/** True when any one of a group is enough (e.g. OpenOCD *or* st-flash for flashing). */
	readonly group?: string;
}

export interface ToolStatus {
	readonly name: string;
	readonly purpose: ToolPurpose;
	readonly found: boolean;
	/** The executable that answered. */
	readonly command?: string;
	readonly version?: string;
}

export interface ToolchainReport {
	readonly toolchain: string;
	readonly tools: readonly ToolStatus[];
	/** Logical names that are missing for the requested purposes (groups count as one). */
	readonly missing: readonly string[];
	/** How to get the missing tools: a package-manager install, or manual steps. */
	readonly install?: InstallPlan;
}

export type PackageManager = 'apt' | 'dnf' | 'pacman' | 'brew';
export type InstallableTool = 'gcc' | 'size' | 'objcopy' | 'gdb' | 'openocd' | 'cmake' | 'make' | 'ninja' | 'st-flash';

export interface InstallPlan {
	readonly packageManager?: PackageManager;
	/** Shell line for the user to run themselves (shown verbatim). */
	readonly commandLine?: string;
	/** Tools a package manager cannot provide, with where to get them. */
	readonly manual: readonly string[];
}

/** Port: what a toolchain needs on this machine for a build system, and how to install it. */
export interface IToolchain {
	readonly id: string;
	requiredTools(buildSystem: BuildSystemId, purposes: readonly ToolPurpose[]): RequiredTool[];
	manualInstallHint(tool: string): string | undefined;
}

export const ARM_GNU_TOOLCHAIN_URL = 'https://developer.arm.com/downloads/-/arm-gnu-toolchain-downloads';
export const ESP_IDF_INSTALL_URL = 'https://docs.espressif.com/projects/esp-idf/en/stable/esp32/get-started/';
export const PLATFORMIO_INSTALL_URL = 'https://docs.platformio.org/en/latest/core/installation/';

/** GNU Arm Embedded (arm-none-eabi-*) for STM32 and other Cortex-M parts. */
export class ArmGccToolchain implements IToolchain {
	readonly id = 'arm-none-eabi-gcc';

	constructor(private readonly prefix = 'arm-none-eabi-') { }

	requiredTools(buildSystem: BuildSystemId, purposes: readonly ToolPurpose[]): RequiredTool[] {
		const p = this.prefix;
		const tools: RequiredTool[] = [];
		if (purposes.includes('build')) {
			tools.push(
				{ name: 'gcc', commands: [`${p}gcc`], purpose: 'build' },
				{ name: 'size', commands: [`${p}size`], purpose: 'build' },
				{ name: 'objcopy', commands: [`${p}objcopy`], purpose: 'build' },
			);
			if (buildSystem === 'cmake') {
				tools.push({ name: 'cmake', commands: ['cmake'], purpose: 'build' });
			}
			if (buildSystem === 'cmake' || buildSystem === 'make') {
				tools.push({ name: 'make', commands: ['make', 'gmake'], purpose: 'build' });
			}
		}
		if (purposes.includes('flash')) {
			tools.push(
				{ name: 'openocd', commands: ['openocd'], purpose: 'flash', group: 'flasher' },
				{ name: 'st-flash', commands: ['st-flash'], purpose: 'flash', group: 'flasher' },
			);
		}
		if (purposes.includes('debug')) {
			tools.push(
				{ name: 'openocd', commands: ['openocd'], purpose: 'debug' },
				{ name: 'gdb', commands: [`${p}gdb`, 'gdb-multiarch'], purpose: 'debug' },
			);
		}
		return tools;
	}

	manualInstallHint(tool: string): string | undefined {
		return tool === 'gcc' || tool === 'gdb' ? `Arm GNU Toolchain: ${ARM_GNU_TOOLCHAIN_URL}` : undefined;
	}
}

/** ESP-IDF: `idf.py` plus the chip's compiler, which are on PATH after sourcing `export.sh`. */
export class EspIdfToolchain implements IToolchain {
	readonly id = 'esp-idf';

	constructor(private readonly prefix: string) { }

	requiredTools(_buildSystem: BuildSystemId, purposes: readonly ToolPurpose[]): RequiredTool[] {
		const tools: RequiredTool[] = [];
		if (purposes.includes('build')) {
			tools.push(
				{ name: 'idf.py', commands: ['idf.py'], purpose: 'build' },
				{ name: 'gcc', commands: [`${this.prefix}gcc`], purpose: 'build' },
				{ name: 'cmake', commands: ['cmake'], purpose: 'build' },
				{ name: 'ninja', commands: ['ninja'], purpose: 'build' },
			);
		}
		if (purposes.includes('flash')) {
			tools.push({ name: 'esptool', commands: ['esptool.py', 'esptool'], purpose: 'flash' });
		}
		if (purposes.includes('debug')) {
			tools.push(
				{ name: 'openocd', commands: ['openocd'], purpose: 'debug' },
				{ name: 'gdb', commands: [`${this.prefix}gdb`], purpose: 'debug' },
			);
		}
		return tools;
	}

	manualInstallHint(): string {
		return `Install ESP-IDF (EIM or install.sh) and run ". $IDF_PATH/export.sh" before starting the agent: ${ESP_IDF_INSTALL_URL}`;
	}
}

/** PlatformIO brings its own compilers and uploaders; only `pio` must be on PATH. */
export class PlatformIoToolchain implements IToolchain {
	readonly id = 'platformio';

	requiredTools(_buildSystem: BuildSystemId, purposes: readonly ToolPurpose[]): RequiredTool[] {
		return purposes.length ? [{ name: 'pio', commands: ['pio', 'platformio'], purpose: purposes[0] }] : [];
	}

	manualInstallHint(): string {
		return `Install PlatformIO Core (e.g. "pipx install platformio"): ${PLATFORMIO_INSTALL_URL}`;
	}
}

const PACKAGES: Readonly<Record<PackageManager, Readonly<Record<InstallableTool, readonly string[]>>>> = {
	apt: { gcc: ['gcc-arm-none-eabi', 'libnewlib-arm-none-eabi'], size: ['binutils-arm-none-eabi'], objcopy: ['binutils-arm-none-eabi'], gdb: ['gdb-multiarch'], openocd: ['openocd'], cmake: ['cmake'], make: ['make'], ninja: ['ninja-build'], 'st-flash': ['stlink-tools'] },
	dnf: { gcc: ['arm-none-eabi-gcc-cs', 'arm-none-eabi-newlib'], size: ['arm-none-eabi-binutils-cs'], objcopy: ['arm-none-eabi-binutils-cs'], gdb: ['gdb'], openocd: ['openocd'], cmake: ['cmake'], make: ['make'], ninja: ['ninja-build'], 'st-flash': ['stlink'] },
	pacman: { gcc: ['arm-none-eabi-gcc', 'arm-none-eabi-newlib'], size: ['arm-none-eabi-binutils'], objcopy: ['arm-none-eabi-binutils'], gdb: ['arm-none-eabi-gdb'], openocd: ['openocd'], cmake: ['cmake'], make: ['make'], ninja: ['ninja'], 'st-flash': ['stlink'] },
	brew: { gcc: [], size: [], objcopy: [], gdb: [], openocd: ['open-ocd'], cmake: ['cmake'], make: ['make'], ninja: ['ninja'], 'st-flash': ['stlink'] },
};

const INSTALLABLE: ReadonlySet<string> = new Set(Object.keys(PACKAGES.apt));

export function isInstallable(tool: string): tool is InstallableTool {
	return INSTALLABLE.has(tool);
}

/** Package names for `tools`; empty when the manager has no package for them. */
export function packagesFor(pm: PackageManager, tools: readonly InstallableTool[]): string[] {
	return [...new Set(tools.flatMap(t => PACKAGES[pm][t]))];
}

/** The non-interactive install command as program + args (no shell). */
export function installCommand(pm: PackageManager, packages: readonly string[]): { command: string; args: string[] } {
	switch (pm) {
		case 'apt': return { command: 'sudo', args: ['-n', 'apt-get', 'install', '-y', ...packages] };
		case 'dnf': return { command: 'sudo', args: ['-n', 'dnf', 'install', '-y', ...packages] };
		case 'pacman': return { command: 'sudo', args: ['-n', 'pacman', '-S', '--needed', '--noconfirm', ...packages] };
		case 'brew': return { command: 'brew', args: ['install', ...packages] };
	}
}

async function firstLine(host: IAgentHost, command: string, args: string[]): Promise<string | undefined> {
	const result = await host.exec(command, args, { timeoutMs: 15_000, maxOutputBytes: 16_384 });
	if (result.spawnError || result.exitCode === null) {
		return undefined;
	}
	const line = (result.stdout || result.stderr).split('\n').map(l => l.trim()).find(l => l) ?? '';
	return line.slice(0, 160) || '(no version output)';
}

export async function detectPackageManager(host: IAgentHost): Promise<PackageManager | undefined> {
	for (const [pm, probe] of [['apt', 'apt-get'], ['dnf', 'dnf'], ['pacman', 'pacman'], ['brew', 'brew']] as const) {
		if (await firstLine(host, probe, ['--version']) !== undefined) {
			return pm;
		}
	}
	return undefined;
}

/** Runs `<command> --version` for every candidate of every required tool. */
export async function probeToolchain(host: IAgentHost, toolchain: IToolchain, buildSystem: BuildSystemId, purposes: readonly ToolPurpose[]): Promise<ToolchainReport> {
	const required = toolchain.requiredTools(buildSystem, purposes);
	const tools: ToolStatus[] = [];
	const seen = new Set<string>();
	for (const tool of required) {
		const key = `${tool.name}/${tool.purpose}`;
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		let status: ToolStatus = { name: tool.name, purpose: tool.purpose, found: false };
		for (const command of tool.commands) {
			const version = await firstLine(host, command, ['--version']);
			if (version !== undefined) {
				status = { name: tool.name, purpose: tool.purpose, found: true, command, version };
				break;
			}
		}
		tools.push(status);
	}

	const missing: string[] = [];
	for (const tool of required) {
		const status = tools.find(t => t.name === tool.name && t.purpose === tool.purpose)!;
		if (status.found) {
			continue;
		}
		if (tool.group && required.some(t => t.group === tool.group && tools.find(s => s.name === t.name && s.purpose === t.purpose)?.found)) {
			continue; // another member of the group is present
		}
		if (tool.group && missing.some(m => required.find(r => r.name === m)?.group === tool.group)) {
			continue; // report a group once, by its preferred member
		}
		if (!missing.includes(tool.name)) {
			missing.push(tool.name);
		}
	}
	if (!missing.length) {
		return { toolchain: toolchain.id, tools, missing };
	}

	const pm = await detectPackageManager(host);
	const viaPm = pm ? missing.filter(isInstallable).filter(t => packagesFor(pm, [t]).length) : [];
	const manual = missing.filter(t => !viaPm.includes(t as InstallableTool)).map(t => toolchain.manualInstallHint(t) ?? `${t}: install it and make sure it is on PATH`);
	const packages = pm ? packagesFor(pm, viaPm as InstallableTool[]) : [];
	const command = pm && packages.length ? installCommand(pm, packages) : undefined;
	return {
		toolchain: toolchain.id,
		tools,
		missing,
		install: {
			...pm ? { packageManager: pm } : {},
			...command ? { commandLine: [command.command, ...command.args.filter(a => a !== '-n')].join(' ') } : {},
			manual: [...new Set(manual)],
		},
	};
}
