/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IAgentHost } from '../../kernel/host';
import { defineTool, ToolError } from '../../kernel/tool';
import { AnyTool } from '../../kernel/toolRegistry';
import { detectProject } from '../../embedded/project';
import { DefaultTargetCatalog, ITargetCatalog, TargetDescriptor } from '../../embedded/target';
import { IDependency } from '../../install/dependencies';
import { PROBES, ProbeId } from '../../install/probes';
import { debugRequirements, DependencyResolver } from '../../install/resolver';
import { isSecretPath, normalizeWorkspacePath } from '../tools/fileTools';

export interface DebugSetupOptions {
	readonly catalog?: ITargetCatalog;
	/** Let root steps use the desktop's password dialog (`pkexec`) when `sudo -n` is not possible. */
	readonly allowGraphicalPrompt?: boolean;
}

interface TargetInput {
	readonly part?: string;
	readonly dir?: string;
	readonly probes?: ProbeId[];
}

const PROBE_IDS = Object.keys(PROBES) as ProbeId[];

const inputSchema = {
	type: 'object',
	properties: {
		part: { type: 'string', maxLength: 64, description: 'MCU part or chip, e.g. STM32F103C8T6, esp32s3 (default: detected from dir)' },
		dir: { type: 'string', maxLength: 512, description: 'Project directory to detect the target from (default ".")' },
		probes: { type: 'array', items: { enum: PROBE_IDS }, maxItems: PROBE_IDS.length, description: 'Debug probes to set up USB access for (default by target)' },
	},
	additionalProperties: false,
} as const;

async function resolveTarget(host: IAgentHost, catalog: ITargetCatalog, input: TargetInput): Promise<TargetDescriptor | undefined> {
	if (input.part) {
		const t = catalog.resolve(input.part);
		if (!t) {
			throw new ToolError(`Unknown part "${input.part}" (STM32 parts and esp32/esp32s2/esp32s3/esp32c3/esp32c6/esp32h2 are supported).`);
		}
		return t;
	}
	const dir = normalizeWorkspacePath(input.dir ?? '.') || '.';
	if (dir.startsWith('-') || isSecretPath(dir)) {
		throw new ToolError(`"${input.dir}" is not a project directory the agent may use.`);
	}
	return (await detectProject(host.fs, dir, catalog))?.target;
}

async function requirements(host: IAgentHost, catalog: ITargetCatalog, input: TargetInput): Promise<{ deps: IDependency[]; target?: TargetDescriptor }> {
	const target = await resolveTarget(host, catalog, input);
	return { deps: debugRequirements({ ...target ? { target } : {}, ...input.probes?.length ? { probes: input.probes } : {} }), ...target ? { target } : {} };
}

/**
 * Tools that bring the debug stack to a working state: check (read-only), user-space installs
 * into the tool store, and root-level USB/serial access (approved separately).
 */
export function createDebugSetupTools(options: DebugSetupOptions = {}): AnyTool[] {
	const catalog = options.catalog ?? new DefaultTargetCatalog();
	return [
		defineTool({
			name: 'check_debug_tools',
			description: 'Check everything on-chip debugging needs for the target: OpenOCD (or Espressif OpenOCD), the target\'s GDB, USB access rules for the debug probe, serial-port access for ESP32. Reports versions, where each tool was found, and what is missing.',
			risk: 'read',
			inputSchema,
			invoke: async (input: TargetInput, { host, signal }) => {
				const { deps, target } = await requirements(host, catalog, input);
				const report = await new DependencyResolver(host).check(deps, signal);
				return { target: target?.part ?? '(unknown: assuming STM32 + ST-Link)', toolStore: host.toolStore?.location ?? null, ...report };
			},
		}),
		defineTool({
			name: 'ensure_debug_tools',
			description: 'Download and install the missing debug tools (OpenOCD, GDB) as pinned, checksum-verified vendor archives into the user\'s tool store. Needs no root and changes nothing outside the tool store. USB access rules need install_probe_access.',
			risk: 'write',
			category: 'install',
			inputSchema,
			describeCall: async (input: TargetInput, context) => {
				if (!context) {
					return 'Download missing debug tools into the tool store';
				}
				const { deps, target } = await requirements(context.host, catalog, input);
				const plan = await new DependencyResolver(context.host).plan(deps, context.signal);
				return plan.downloads.length
					? `For ${target?.part ?? 'STM32 (assumed)'}: download ${plan.downloads.join('; ')} into ${plan.location ?? 'the tool store'} (pinned versions, SHA-256 verified)`
					: `For ${target?.part ?? 'STM32 (assumed)'}: nothing to download (all debug tools are present)`;
			},
			invoke: async (input: TargetInput, { host, signal }) => {
				if (!host.toolStore) {
					throw new ToolError('This host has no tool store, so tools cannot be installed in user space; see check_debug_tools for manual steps.');
				}
				const { deps, target } = await requirements(host, catalog, input);
				const report = await new DependencyResolver(host).ensureUserSpace(deps, signal);
				return { target: target?.part ?? '(unknown: assuming STM32 + ST-Link)', toolStore: host.toolStore.location, ...report };
			},
		}),
		defineTool({
			name: 'install_probe_access',
			description: 'Set up root-level access the debug stack needs on Linux: udev rules so the debug probe (ST-Link, ESP USB-JTAG, ESP-PROG, CMSIS-DAP, J-Link) is usable without root, and serial-port group membership for ESP32. Uses passwordless sudo when available; otherwise returns the exact command for the user. Run ensure_debug_tools first (it provides the rules file).',
			risk: 'write',
			category: 'system',
			inputSchema,
			describeCall: async (input: TargetInput, context) => {
				if (!context) {
					return 'Run root-level setup for debug probe access';
				}
				const { deps, target } = await requirements(context.host, catalog, input);
				const plan = await new DependencyResolver(context.host).plan(deps, context.signal);
				return plan.systemChanges.length
					? `For ${target?.part ?? 'STM32 (assumed)'}, as root: ${plan.systemChanges.join('; ')}`
					: `For ${target?.part ?? 'STM32 (assumed)'}: no root changes needed`;
			},
			invoke: async (input: TargetInput, { host, signal }) => {
				const { deps, target } = await requirements(host, catalog, input);
				const report = await new DependencyResolver(host).ensureSystem(deps, { allowGraphicalPrompt: options.allowGraphicalPrompt ?? false }, signal);
				const userCommands = report.installed.map(i => i.userCommand).filter((c): c is string => !!c);
				return { target: target?.part ?? '(unknown: assuming STM32 + ST-Link)', ...report, ...userCommands.length ? { askUserToRun: userCommands } : {} };
			},
		}),
	];
}
