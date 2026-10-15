/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IAgentHost, PlatformId } from '../kernel/host';
import { TargetDescriptor } from '../embedded/target';
import { svdSpecFor } from '../embedded/svd/svdManifest';
import { DependencyContext, DependencyStatus, ExecutableDependency, HostOs, IDependency, InstallOutcome, PinnedFileDependency, ProbeAccessDependency, SerialAccessDependency, SystemInstallOptions } from './dependencies';
import { archiveFor, TOOL_MANIFEST, ToolId } from './manifest';
import { ProbeId } from './probes';

export interface DebugRequirementsOptions {
	readonly target?: TargetDescriptor;
	/** Probes to grant USB access for (default: ST-Link for STM32; USB-JTAG + ESP-PROG for ESP32). */
	readonly probes?: readonly ProbeId[];
}

const ARM_GDB_MANUAL = 'Install arm-none-eabi-gdb (Arm GNU Toolchain: https://developer.arm.com/downloads/-/arm-gnu-toolchain-downloads) or gdb-multiarch from the system package manager.';
const OPENOCD_MANUAL = 'Install OpenOCD (https://github.com/xpack-dev-tools/openocd-xpack/releases) or the openocd package.';
const ESP_MANUAL = 'Install the ESP-IDF tools (https://docs.espressif.com/projects/esp-idf/en/stable/esp32/get-started/).';

/** The dependencies of the debug stack for a target (default: STM32 with ST-Link). */
export function debugRequirements(options: DebugRequirementsOptions = {}): IDependency[] {
	const t = options.target;
	const svd = t?.vendor === 'stm32' ? svdSpecFor(t.part) : undefined;
	if (t?.vendor === 'esp32') {
		const gdbArchive = t.arch === 'riscv' ? 'riscv32-esp-elf-gdb' : 'xtensa-esp-elf-gdb';
		const gdbName = t.arch === 'riscv' ? 'riscv32-esp-elf-gdb' : `xtensa-${t.part}-elf-gdb`;
		return [
			// systemPathOnly: the tool store's upstream OpenOCD would otherwise hide an ESP-IDF one on PATH.
			new ExecutableDependency({ id: 'openocd-esp32', label: 'OpenOCD for ESP32 (Espressif)', commands: ['openocd'], versionMatch: /esp32/i, archive: 'openocd-esp32', systemPathOnly: true, manualHint: ESP_MANUAL }),
			new ExecutableDependency({ id: 'gdb', label: `GDB for ${t.part}`, commands: [gdbName], archive: gdbArchive, manualHint: ESP_MANUAL }),
			new ProbeAccessDependency(options.probes ?? ['esp-usb-jtag', 'esp-prog']),
			new SerialAccessDependency(),
		];
	}
	return [
		new ExecutableDependency({ id: 'openocd', label: 'OpenOCD', commands: ['openocd'], archive: 'xpack-openocd', manualHint: OPENOCD_MANUAL }),
		new ExecutableDependency({ id: 'gdb', label: 'GDB for Arm Cortex-M', commands: ['arm-none-eabi-gdb', 'gdb-multiarch'], archive: 'xpack-arm-none-eabi-gcc', manualHint: ARM_GDB_MANUAL }),
		new ProbeAccessDependency(options.probes ?? ['stlink']),
		...svd ? [new PinnedFileDependency('svd', `Register descriptions (SVD) for ${t!.part}`, svd)] : [],
	];
}

export interface DependencyReport {
	readonly ok: boolean;
	readonly statuses: readonly DependencyStatus[];
	/** What the agent can do next, in plain words. */
	readonly next: string;
}

export interface EnsureReport extends DependencyReport {
	readonly installed: readonly InstallOutcome[];
}

/**
 * Checks and installs the debug stack (Facade). User-space installs (tool store) and system
 * changes (root) are separate calls, so hosts can approve them under different policies.
 */
export class DependencyResolver {
	constructor(private readonly host: IAgentHost) { }

	private async context(signal?: AbortSignal): Promise<DependencyContext> {
		const platform = this.host.toolStore?.platform();
		let os: HostOs;
		if (platform) {
			os = platform.startsWith('linux') ? 'linux' : platform.startsWith('darwin') ? 'darwin' : 'win32';
		} else {
			const uname = await this.host.exec('uname', ['-s'], { timeoutMs: 10_000 });
			const name = uname.stdout.trim().toLowerCase();
			os = name === 'linux' ? 'linux' : name === 'darwin' ? 'darwin' : uname.spawnError ? 'win32' : 'other';
		}
		return { host: this.host, platform, os, ...signal ? { signal } : {} };
	}

	/** Exactly what each call would do, for approval prompts: downloads (with sizes) and root changes. */
	async plan(deps: readonly IDependency[], signal?: AbortSignal): Promise<{ downloads: string[]; systemChanges: string[]; location?: string }> {
		const ctx = await this.context(signal);
		const missingDownloads: IDependency[] = [];
		const systemChanges: string[] = [];
		for (const d of deps) {
			const status = await d.check(ctx);
			if (status.ok) {
				continue;
			}
			if (status.remedy === 'user-space') {
				missingDownloads.push(d);
			} else if (status.remedy === 'system' && d.describeSystemChange) {
				const change = await d.describeSystemChange(ctx);
				if (change) {
					systemChanges.push(change);
				}
			}
		}
		return { downloads: describeDownloads(missingDownloads, ctx.platform), systemChanges, ...this.host.toolStore ? { location: this.host.toolStore.location } : {} };
	}

	async check(deps: readonly IDependency[], signal?: AbortSignal): Promise<DependencyReport> {
		const ctx = await this.context(signal);
		const statuses: DependencyStatus[] = [];
		for (const d of deps) {
			statuses.push(await d.check(ctx));
		}
		return { ok: statuses.every(s => s.ok || s.optional), statuses, next: nextStep(statuses) };
	}

	/** Installs every missing dependency that has a user-space install; touches nothing outside the tool store. */
	async ensureUserSpace(deps: readonly IDependency[], signal?: AbortSignal): Promise<EnsureReport> {
		const ctx = await this.context(signal);
		const installed: InstallOutcome[] = [];
		for (const d of deps) {
			const status = await d.check(ctx);
			if (!status.ok && status.remedy === 'user-space' && d.installUserSpace) {
				try {
					installed.push(await d.installUserSpace(ctx));
				} catch (err) {
					installed.push({ id: d.id, ok: false, action: 'needs-user', detail: `Install failed: ${err instanceof Error ? err.message : String(err)}` });
				}
			}
		}
		const after = await this.check(deps, signal);
		return { ...after, installed };
	}

	/** Makes the root-level changes (udev rules, serial group) for missing dependencies. */
	async ensureSystem(deps: readonly IDependency[], options: SystemInstallOptions = {}, signal?: AbortSignal): Promise<EnsureReport> {
		const ctx = await this.context(signal);
		const installed: InstallOutcome[] = [];
		for (const d of deps) {
			const status = await d.check(ctx);
			if (!status.ok && status.remedy === 'system' && d.installSystem) {
				try {
					installed.push(await d.installSystem(ctx, options));
				} catch (err) {
					installed.push({ id: d.id, ok: false, action: 'needs-user', detail: `Failed: ${err instanceof Error ? err.message : String(err)}` });
				}
			}
		}
		const after = await this.check(deps, signal);
		return { ...after, installed };
	}
}

function nextStep(statuses: readonly DependencyStatus[]): string {
	const missing = statuses.filter(s => !s.ok && !s.optional);
	const optional = statuses.filter(s => !s.ok && s.optional);
	const pending = statuses.filter(s => s.pending).map(s => `${s.label}: ${s.pending}`);
	const extras = optional.length ? [`Optional, not installed: ${optional.map(s => s.label).join(', ')}${optional.some(s => s.remedy === 'user-space') ? ' (ensure_debug_tools can download it)' : ''}.`] : [];
	if (!missing.length) {
		return ['Everything the debug stack needs is installed.', ...extras, ...pending].join(' ');
	}
	const parts: string[] = [];
	const user = missing.filter(s => s.remedy === 'user-space');
	const system = missing.filter(s => s.remedy === 'system');
	const manual = missing.filter(s => s.remedy === 'manual');
	if (user.length) {
		parts.push(`ensure_debug_tools can download ${user.map(s => s.label).join(', ')}.`);
	}
	if (system.length) {
		parts.push(`install_probe_access can set up ${system.map(s => s.label).join(', ')} (needs root).`);
	}
	if (manual.length) {
		parts.push(...manual.map(s => `${s.label}: ${s.manualStep ?? 'install it manually'}`));
	}
	return [...parts, ...extras].join(' ');
}

/** One line per download the user-space install could make, for approval prompts. */
export function describeDownloads(deps: readonly IDependency[], platform: PlatformId | undefined): string[] {
	const ids = new Set<ToolId>();
	const files: string[] = [];
	for (const d of deps) {
		if (d instanceof ExecutableDependency && d.archive) {
			ids.add(d.archive);
		} else if (d instanceof PinnedFileDependency) {
			files.push(`${d.spec.fileName} (${Math.max(1, Math.round(d.spec.size / 1e6))} MB)`);
		}
	}
	return [...[...ids].map(id => {
		const tool = TOOL_MANIFEST[id];
		// Without a platform (e.g. in an approval prompt) show the largest variant as "about".
		const size = platform ? archiveFor(id, platform)?.size : Math.max(...Object.values(tool.platforms).map(p => p.size));
		if (!size) {
			return `${tool.vendor} ${tool.version} (no pinned download for this platform)`;
		}
		return `${tool.vendor} ${tool.version} (${platform ? '' : 'about '}${Math.max(1, Math.round(size / 1e6))} MB)`;
	}), ...files];
}
