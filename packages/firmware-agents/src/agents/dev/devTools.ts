/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { posix } from 'path';
import { IAgentHost } from '../../kernel/host';
import { defineTool, ToolError } from '../../kernel/tool';
import { AnyTool } from '../../kernel/toolRegistry';
import { BuildType, StepResult } from '../../embedded/build/buildSystems';
import { parseMapFile } from '../../embedded/build/mapFile';
import { parseBerkeleySize, summarizeSize } from '../../embedded/build/sizeReport';
import { FlashOptions } from '../../embedded/flash/flashers';
import { lintFreeRtosConfig } from '../../embedded/freertosLint';
import { DevPlatform, IPlatformFactory } from '../../embedded/platformFactory';
import { detectProject, joinPath, ProjectInfo } from '../../embedded/project';
import { ITargetCatalog } from '../../embedded/target';
import { detectPackageManager, installCommand, InstallableTool, isInstallable, packagesFor, probeToolchain, ToolPurpose } from '../../embedded/toolchain';
import { ChangeTracker, isSecretPath, normalizeWorkspacePath } from '../tools/fileTools';

/** Shared state of one Dev agent's tools: project cache and the build/edit timeline. */
export class DevToolContext {
	private readonly projects = new Map<string, ProjectInfo>();
	/** Per project dir: clock value and outcome of the last build. */
	readonly lastBuild = new Map<string, { at: number; ok: boolean }>();

	constructor(
		readonly catalog: ITargetCatalog,
		readonly platforms: IPlatformFactory,
		readonly changes: ChangeTracker,
	) { }

	async project(host: IAgentHost, dir = '.', refresh = false): Promise<{ project: ProjectInfo; platform: DevPlatform }> {
		const key = normalizeWorkspacePath(dir) || '.';
		if (key.startsWith('-') || isSecretPath(key)) {
			throw new ToolError(`"${dir}" is not a project directory the agent may use.`);
		}
		let project = refresh ? undefined : this.projects.get(key);
		if (!project) {
			project = await detectProject(host.fs, key, this.catalog);
			if (!project) {
				throw new ToolError(`No build system found in "${key}" (looked for platformio.ini, CMakeLists.txt, Makefile). Use list_directory to find the project folder.`);
			}
			this.projects.set(key, project);
		}
		return { project, platform: this.platforms.create(project) };
	}
}

const dirProp = { type: 'string', maxLength: 512, description: 'Project directory, workspace-relative (default ".")' } as const;
const BUILD_TYPES: readonly BuildType[] = ['Debug', 'Release', 'MinSizeRel', 'RelWithDebInfo'];
const PURPOSES: readonly ToolPurpose[] = ['build', 'flash', 'debug'];

/** A step for the model: diagnostics first; raw output only when it explains something. */
function summarizeStep(step: StepResult) {
	return {
		step: step.step,
		ok: step.ok,
		command: step.command,
		exitCode: step.exitCode,
		durationMs: step.durationMs,
		errors: step.counts.error,
		warnings: step.counts.warning,
		diagnostics: step.diagnostics.slice(0, 40),
		...step.diagnostics.length > 40 ? { moreDiagnostics: step.diagnostics.length - 40 } : {},
		...!step.ok && (step.counts.error === 0 || step.spawnError) ? { outputTail: step.outputTail } : {},
		...step.spawnError ? { spawnError: step.spawnError, hint: 'The build tool is missing: run check_toolchain.' } : {},
		...step.timedOut ? { timedOut: true } : {},
		...step.note ? { note: step.note } : {},
	};
}

/** `{ note }` with the given texts joined, or nothing. */
function notes(...items: (string | false | undefined)[]): { note?: string } {
	const text = items.filter((x): x is string => !!x).join(' ');
	return text ? { note: text } : {};
}

/** A path argument for an external program: inside the workspace, not an option, not a secret. */
async function checkPathArgument(host: IAgentHost, path: string, what: string): Promise<string> {
	if (path.startsWith('-') || isSecretPath(path)) {
		throw new ToolError(`Invalid ${what} path "${path}".`);
	}
	if (!await host.fs.exists(path)) {
		throw new ToolError(`${what} "${path}" does not exist.`);
	}
	if (isSecretPath(await host.fs.realPath(path))) {
		throw new ToolError(`Invalid ${what} path "${path}".`);
	}
	return path;
}

export function createDevTools(ctx: DevToolContext): AnyTool[] {
	return [
		defineTool({
			name: 'detect_project',
			description: 'Detect the firmware project in a directory: build system (CMake, Make, PlatformIO, ESP-IDF), target MCU (part, core, flash/RAM sizes), FreeRTOS use, and the evidence for each.',
			risk: 'read',
			inputSchema: { type: 'object', properties: { dir: dirProp }, additionalProperties: false },
			invoke: async (input: { dir?: string }, { host }) => {
				const { project, platform } = await ctx.project(host, input.dir, true);
				return { ...project, toolchain: platform.toolchain.id, flashers: platform.flashers.map(f => f.id) };
			},
		}),

		defineTool({
			name: 'check_toolchain',
			description: 'Check that the tools this project needs are installed (compiler, binutils, CMake/Make, flasher, debugger) and report versions, what is missing, and how to install it.',
			risk: 'read',
			inputSchema: {
				type: 'object',
				properties: { dir: dirProp, purposes: { type: 'array', items: { enum: [...PURPOSES] }, maxItems: 3, description: 'Default: ["build"]' } },
				additionalProperties: false,
			},
			invoke: async (input: { dir?: string; purposes?: ToolPurpose[] }, { host }) => {
				const { project, platform } = await ctx.project(host, input.dir);
				return probeToolchain(host, platform.toolchain, project.buildSystem, input.purposes?.length ? input.purposes : ['build']);
			},
		}),

		defineTool({
			name: 'install_tools',
			description: 'Install missing tools with the system package manager (non-interactive; needs passwordless sudo on Linux, otherwise returns the command for the user to run). Only the listed tool names are accepted.',
			risk: 'write',
			inputSchema: {
				type: 'object',
				properties: { tools: { type: 'array', items: { enum: ['gcc', 'size', 'objcopy', 'gdb', 'openocd', 'cmake', 'make', 'ninja', 'st-flash'] }, maxItems: 9 } },
				required: ['tools'],
				additionalProperties: false,
			},
			describeCall: (input: { tools: string[] }) => `Install ${input.tools.join(', ')} with the system package manager (apt-get, dnf or pacman through sudo; brew without). Debian/Ubuntu packages: ${packagesFor('apt', input.tools.filter(isInstallable) as InstallableTool[]).join(' ') || 'none'}`,
			invoke: async (input: { tools: string[] }, { host, signal }) => {
				const tools = input.tools.filter(isInstallable) as InstallableTool[];
				const pm = await detectPackageManager(host);
				if (!pm) {
					throw new ToolError('No supported package manager found (apt, dnf, pacman, brew); the user must install the tools manually.');
				}
				const packages = packagesFor(pm, tools);
				if (!packages.length) {
					throw new ToolError(`${pm} has no packages for ${tools.join(', ')}; see check_toolchain for manual install hints.`);
				}
				const { command, args } = installCommand(pm, packages);
				const userCommand = [command, ...args.filter(a => a !== '-n')].join(' ');
				const result = await host.exec(command, args, { timeoutMs: 20 * 60 * 1000, signal });
				if (result.exitCode === 0) {
					return { installed: packages, packageManager: pm };
				}
				if (/password is required|a terminal is required|sudo: a password/i.test(result.stderr)) {
					throw new ToolError(`Installing needs the user's password. Ask the user to run: ${userCommand}`, { command: userCommand });
				}
				throw new ToolError(`Install failed (exit ${result.exitCode ?? result.spawnError}).`, { command: userCommand, output: (result.stderr || result.stdout).slice(-2000) });
			},
		}),

		defineTool({
			name: 'configure',
			description: 'Configure the build (CMake: generate build/; ESP-IDF: reconfigure). Build does this automatically when needed; use it to change the build type.',
			risk: 'write',
			inputSchema: { type: 'object', properties: { dir: dirProp, buildType: { enum: [...BUILD_TYPES] } }, additionalProperties: false },
			describeCall: (input: { dir?: string; buildType?: BuildType }) => `Configure the build in ${input.dir ?? '.'}${input.buildType ? ` (${input.buildType})` : ''}`,
			invoke: async (input: { dir?: string; buildType?: BuildType }, { host, signal }) => {
				const { project, platform } = await ctx.project(host, input.dir);
				return summarizeStep(await platform.buildSystem.configure(host, project, { signal, ...input.buildType ? { buildType: input.buildType } : {} }));
			},
		}),

		defineTool({
			name: 'build',
			description: 'Build the firmware. Returns success, structured compiler/linker diagnostics (file, line, severity, message), and the produced artifacts (ELF, map, bin, hex, lib).',
			risk: 'write',
			inputSchema: {
				type: 'object',
				properties: { dir: dirProp, buildType: { enum: [...BUILD_TYPES] }, environment: { type: 'string', maxLength: 64, description: 'PlatformIO environment' } },
				additionalProperties: false,
			},
			describeCall: (input: { dir?: string }) => `Build the firmware in ${input.dir ?? '.'}`,
			invoke: async (input: { dir?: string; buildType?: BuildType; environment?: string }, { host, signal }) => {
				const { project, platform } = await ctx.project(host, input.dir);
				const steps = await platform.buildSystem.build(host, project, {
					signal,
					...input.buildType ? { buildType: input.buildType } : {},
					...input.environment ? { environment: input.environment } : {},
				});
				const ok = steps.every(s => s.ok);
				ctx.lastBuild.set(project.dir, { at: ctx.changes.tick(), ok });
				const artifacts = ok ? await platform.buildSystem.findArtifacts(host, project) : undefined;
				return { ok, steps: steps.map(summarizeStep), ...artifacts ? { artifacts } : {} };
			},
		}),

		defineTool({
			name: 'clean',
			description: 'Delete build outputs (the build system\'s clean target).',
			risk: 'write',
			inputSchema: { type: 'object', properties: { dir: dirProp }, additionalProperties: false },
			describeCall: (input: { dir?: string }) => `Clean the build in ${input.dir ?? '.'}`,
			invoke: async (input: { dir?: string }, { host, signal }) => {
				const { project, platform } = await ctx.project(host, input.dir);
				return summarizeStep(await platform.buildSystem.clean(host, project, { signal }));
			},
		}),

		defineTool({
			name: 'size_report',
			description: 'Flash and RAM usage of the built image (text/data/bss via the toolchain\'s size tool), as bytes and as a percentage of the target\'s memory, plus the largest contributors from the map file when there is one.',
			risk: 'read',
			inputSchema: { type: 'object', properties: { dir: dirProp, image: { type: 'string', maxLength: 1024, description: 'ELF or .a to measure (default: the build output)' } }, additionalProperties: false },
			invoke: async (input: { dir?: string; image?: string }, { host }) => {
				const { project, platform } = await ctx.project(host, input.dir);
				const artifacts = await platform.buildSystem.findArtifacts(host, project);
				const image = input.image ? await checkPathArgument(host, input.image, 'Image') : artifacts.elf[0] ?? artifacts.lib[0];
				if (!image) {
					throw new ToolError('No ELF or library found; build first.');
				}
				const sizeTool = `${platform.binutilsPrefix ?? ''}size`;
				const result = await host.exec(sizeTool, [image], { timeoutMs: 60_000 });
				if (result.exitCode !== 0) {
					throw new ToolError(`${sizeTool} failed: ${result.spawnError ?? result.stderr.trim()}`);
				}
				const report = summarizeSize(parseBerkeleySize(result.stdout), project.target?.flashKb, project.target?.ramKb);
				const isLibrary = image.endsWith('.a');
				const map = artifacts.map[0];
				let topContributors;
				if (map && !isLibrary) {
					topContributors = parseMapFile(await host.fs.readFile(map), 10).contributors.map(c => ({ object: c.object, bytes: c.bytes }));
				}
				return {
					image,
					...report,
					entries: report.entries.slice(0, 30),
					...notes(
						isLibrary && 'Static library: totals are the sum of its object files; final usage depends on what the application links.',
						project.target && !project.target.exact && `Memory sizes of ${project.target.part} are unknown, so no percentages.`,
						!project.target && 'The target MCU is unknown, so no percentages.',
					),
					...topContributors ? { topContributors } : {},
				};
			},
		}),

		defineTool({
			name: 'map_report',
			description: 'Analyse the linker map file: memory regions (used/total), output sections, and the object files that use the most memory.',
			risk: 'read',
			inputSchema: { type: 'object', properties: { dir: dirProp, map: { type: 'string', maxLength: 1024 }, top: { type: 'integer', minimum: 1, maximum: 100 } }, additionalProperties: false },
			invoke: async (input: { dir?: string; map?: string; top?: number }, { host }) => {
				const { project, platform } = await ctx.project(host, input.dir);
				const map = input.map ? await checkPathArgument(host, input.map, 'Map file') : (await platform.buildSystem.findArtifacts(host, project)).map[0];
				if (!map) {
					throw new ToolError('No .map file found. Link with -Wl,-Map=<name>.map (most generated projects already do) and build again.');
				}
				const report = parseMapFile(await host.fs.readFile(map), input.top ?? 15);
				return { map, ...report };
			},
		}),

		defineTool({
			name: 'flash',
			description: 'Program the built image into the target (OpenOCD over ST-Link by default for STM32; st-flash as fallback; idf.py flash for ESP-IDF; pio upload for PlatformIO). Only when the user asked to flash.',
			risk: 'hardware',
			inputSchema: {
				type: 'object',
				properties: {
					dir: dirProp,
					image: { type: 'string', maxLength: 1024 },
					flasher: { enum: ['openocd', 'st-flash', 'idf.py', 'pio'] },
					probe: { enum: ['stlink', 'cmsis-dap', 'jlink'], description: 'OpenOCD interface (default stlink)' },
					port: { type: 'string', maxLength: 128, description: 'Serial port for ESP32/PlatformIO uploads' },
					environment: { type: 'string', maxLength: 64 },
				},
				additionalProperties: false,
			},
			describeCall: (input: { image?: string; flasher?: string; dir?: string }) => `Flash ${input.image ?? `the build in ${input.dir ?? '.'}`} to the target${input.flasher ? ` with ${input.flasher}` : ''}`,
			invoke: async (input: { dir?: string; image?: string; flasher?: string; probe?: string; port?: string; environment?: string }, { host, signal }) => {
				const { project, platform } = await ctx.project(host, input.dir);
				if (!platform.flashers.length) {
					throw new ToolError(project.target
						? `No flasher for ${project.target.part} in a ${project.buildSystem} project: ESP32 images are flashed through ESP-IDF (idf.py) or PlatformIO.`
						: 'The target MCU is unknown, so there is no flasher; tell the user to record the part number (e.g. in README.md or .roboagent/project.json).');
				}
				const flasher = input.flasher ? platform.flashers.find(f => f.id === input.flasher) : platform.flashers[0];
				if (!flasher) {
					throw new ToolError(`Flasher "${input.flasher}" does not apply to this project; available: ${platform.flashers.map(f => f.id).join(', ')}.`);
				}
				if (input.port && !/^[\w./:-]+$/.test(input.port)) {
					throw new ToolError(`Invalid port "${input.port}".`);
				}
				const imagePath = input.image ? normalizeWorkspacePath(posix.normalize(input.image.replace(/\\/g, '/'))) : undefined;
				if (imagePath && (imagePath.startsWith('../') || (project.dir !== '.' && !imagePath.startsWith(`${project.dir}/`)))) {
					throw new ToolError(`The image must be inside the project folder "${project.dir}".`);
				}
				const options: FlashOptions = {
					signal,
					...input.image ? { artifact: normalizeWorkspacePath(await checkPathArgument(host, input.image, 'Image')) } : {},
					...input.probe ? { probe: input.probe } : {},
					...input.port ? { port: input.port } : {},
					...input.environment ? { environment: input.environment } : {},
				};
				const picked = flasher.pickImage(await platform.buildSystem.findArtifacts(host, project), options);
				if (!picked.ok) {
					throw new ToolError(picked.reason);
				}
				const last = ctx.lastBuild.get(project.dir);
				const warning = !last
					? (ctx.changes.lastChange() > 0 ? 'Files were changed in this session but the project was not built since; the image may be out of date.' : undefined)
					: !last.ok
						? 'The last build failed, so this image is from an earlier build.'
						: ctx.changes.lastChange() > last.at ? 'Source files changed after the last build; the flashed image may be out of date.' : undefined;
				const result = await flasher.flash(host, project, picked.image, options);
				return { ...result, image: picked.image, ...warning ? { warning } : {} };
			},
		}),

		defineTool({
			name: 'lint_freertos_config',
			description: 'Check FreeRTOSConfig.h for settings that make crashes diagnosable (stack-overflow checking, configASSERT, malloc-failed hook, interrupt-priority limits, queue registry, OpenOCD task awareness).',
			risk: 'read',
			inputSchema: { type: 'object', properties: { dir: dirProp }, additionalProperties: false },
			invoke: async (input: { dir?: string }, { host }) => {
				const { project } = await ctx.project(host, input.dir);
				if (!project.freertosConfig) {
					return { applicable: false, reason: project.buildSystem === 'esp-idf' ? 'ESP-IDF configures FreeRTOS through menuconfig (sdkconfig), not FreeRTOSConfig.h.' : 'No FreeRTOSConfig.h in this project.' };
				}
				let buildFiles = '';
				for (const name of ['CMakeLists.txt', 'Makefile', 'platformio.ini']) {
					const p = joinPath(project.dir, name);
					if (await host.fs.exists(p)) {
						buildFiles += await host.fs.readFile(p);
					}
				}
				return {
					applicable: true,
					file: project.freertosConfig,
					findings: lintFreeRtosConfig(await host.fs.readFile(project.freertosConfig), { ...project.target ? { arch: project.target.arch } : {}, buildFiles }),
				};
			},
		}),
	];
}
