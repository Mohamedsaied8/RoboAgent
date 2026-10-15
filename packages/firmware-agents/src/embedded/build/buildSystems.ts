/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ExecResult, IAgentHost } from '../../kernel/host';
import { BuildSystemId, findBuildOutputs, joinPath, ProjectInfo } from '../project';
import { countBySeverity, Diagnostic, DiagnosticSeverity, parseBuildOutput } from './gccDiagnostics';

export type BuildStep = 'configure' | 'build' | 'clean';
export type BuildType = 'Debug' | 'Release' | 'MinSizeRel' | 'RelWithDebInfo';

export interface BuildOptions {
	readonly buildType?: BuildType;
	/** PlatformIO environment (`[env:name]`). */
	readonly environment?: string;
	readonly signal?: AbortSignal;
	readonly onOutput?: (chunk: string) => void;
}

export interface StepResult {
	readonly step: BuildStep;
	readonly ok: boolean;
	/** What ran, for the model and the user (program and arguments). */
	readonly command: string;
	readonly exitCode: number | null;
	readonly durationMs: number;
	readonly diagnostics: readonly Diagnostic[];
	readonly counts: Readonly<Record<DiagnosticSeverity, number>>;
	/** Last part of the combined output, for problems the parser does not recognise. */
	readonly outputTail: string;
	readonly timedOut?: boolean;
	readonly cancelled?: boolean;
	readonly spawnError?: string;
	/** Something the build system did on its own that the model should know about. */
	readonly note?: string;
}

export interface BuildArtifacts {
	readonly elf: readonly string[];
	readonly map: readonly string[];
	readonly bin: readonly string[];
	readonly hex: readonly string[];
	readonly lib: readonly string[];
}

/** Port: one build system (Strategy). All paths are workspace-relative. */
export interface IBuildSystem {
	readonly id: BuildSystemId;
	/** Where build output lands. */
	buildDir(project: ProjectInfo): string;
	configure(host: IAgentHost, project: ProjectInfo, options?: BuildOptions): Promise<StepResult>;
	/** Builds, configuring first when the build tree does not exist yet. */
	build(host: IAgentHost, project: ProjectInfo, options?: BuildOptions): Promise<StepResult[]>;
	clean(host: IAgentHost, project: ProjectInfo, options?: BuildOptions): Promise<StepResult>;
	findArtifacts(host: IAgentHost, project: ProjectInfo): Promise<BuildArtifacts>;
}

const BUILD_TIMEOUT_MS = 30 * 60 * 1000;
const TAIL_CHARS = 4000;

/**
 * Template Method: running a step (exec, parse diagnostics, summarise) is shared; subclasses
 * only say which commands each step is.
 */
export abstract class CommandBuildSystem implements IBuildSystem {
	abstract readonly id: BuildSystemId;
	abstract buildDir(project: ProjectInfo): string;
	/** `configured` tells whether a build tree already exists (CMake keeps its build type then). */
	protected abstract configureCommand(project: ProjectInfo, options: BuildOptions, configured: boolean): readonly [string, string[]] | undefined;
	protected abstract buildCommand(project: ProjectInfo, options: BuildOptions): readonly [string, string[]];
	protected abstract cleanCommand(project: ProjectInfo, options: BuildOptions): readonly [string, string[]];
	/** Whether a build tree exists (default: there is no separate configure step). */
	protected async isConfigured(_host: IAgentHost, _project: ProjectInfo): Promise<boolean> {
		return true;
	}
	/** Whether {@link build} runs configure even on an existing tree (cheap and self-healing for CMake). */
	protected readonly configureEveryBuild: boolean = false;

	async configure(host: IAgentHost, project: ProjectInfo, options: BuildOptions = {}): Promise<StepResult> {
		const command = this.configureCommand(project, options, await this.isConfigured(host, project));
		if (!command) {
			return { step: 'configure', ok: true, command: '(no configure step)', exitCode: 0, durationMs: 0, diagnostics: [], counts: { error: 0, warning: 0, note: 0 }, outputTail: '' };
		}
		return this.run(host, project, 'configure', command, options);
	}

	async build(host: IAgentHost, project: ProjectInfo, options: BuildOptions = {}): Promise<StepResult[]> {
		const steps: StepResult[] = [];
		if (this.configureEveryBuild || !await this.isConfigured(host, project)) {
			const configured = await this.configure(host, project, options);
			steps.push(configured);
			if (!configured.ok) {
				return steps;
			}
		}
		steps.push(await this.run(host, project, 'build', this.buildCommand(project, options), options));
		return steps;
	}

	clean(host: IAgentHost, project: ProjectInfo, options: BuildOptions = {}): Promise<StepResult> {
		return this.run(host, project, 'clean', this.cleanCommand(project, options), options);
	}

	async findArtifacts(host: IAgentHost, project: ProjectInfo): Promise<BuildArtifacts> {
		const dir = this.buildDir(project);
		const files = await host.fs.exists(dir) ? await findBuildOutputs(host.fs, dir, n => /\.(elf|map|bin|hex|a)$/i.test(n), 3, 50) : [];
		const ext = (e: string) => files.filter(f => f.toLowerCase().endsWith(e));
		return { elf: ext('.elf'), map: ext('.map'), bin: ext('.bin'), hex: ext('.hex'), lib: ext('.a') };
	}

	protected async run(host: IAgentHost, project: ProjectInfo, step: BuildStep, [program, args]: readonly [string, string[]], options: BuildOptions): Promise<StepResult> {
		const started = Date.now();
		const result: ExecResult = await host.exec(program, args, {
			cwd: project.dir,
			timeoutMs: BUILD_TIMEOUT_MS,
			maxOutputBytes: 4 * 1024 * 1024,
			...options.signal ? { signal: options.signal } : {},
			...options.onOutput ? { onOutput: (_stream: 'stdout' | 'stderr', chunk: string) => options.onOutput!(chunk) } : {},
		});
		// The host's captured buffers: size-capped and redacted as a whole (not chunk by chunk).
		const output = `${result.stdout}\n${result.stderr}`;
		const diagnostics = parseBuildOutput(output);
		const ok = result.exitCode === 0 && !result.spawnError;
		return {
			step,
			ok,
			command: [program, ...args].join(' '),
			exitCode: result.exitCode,
			durationMs: Date.now() - started,
			diagnostics,
			counts: countBySeverity(diagnostics),
			outputTail: output.length > TAIL_CHARS ? `…${output.slice(-TAIL_CHARS)}` : output,
			...result.timedOut ? { timedOut: true } : {},
			...result.cancelled ? { cancelled: true } : {},
			...result.spawnError ? { spawnError: result.spawnError } : {},
		};
	}
}

/**
 * CMake re-runs its configure step before every build. That is incremental (well under a second
 * when nothing changed) and catches what `cmake --build` alone silently gets wrong: a previous
 * configure that failed, a requested build type that differs from the cache, and a build tree
 * copied from another source folder (which would compile the *original* sources).
 */
export class CMakeBuildSystem extends CommandBuildSystem {
	readonly id = 'cmake';
	protected override readonly configureEveryBuild = true;

	buildDir(project: ProjectInfo): string {
		return joinPath(project.dir, 'build');
	}
	protected configureCommand(_project: ProjectInfo, options: BuildOptions, configured: boolean): readonly [string, string[]] {
		// On an existing tree, keep its build type unless one was asked for.
		const buildType = options.buildType ?? (configured ? undefined : 'Debug');
		return ['cmake', ['-S', '.', '-B', 'build', ...buildType ? [`-DCMAKE_BUILD_TYPE=${buildType}`] : []]];
	}

	/** A cache created for another source folder: the tree must be recreated. */
	private static isForeignCache(step: StepResult): boolean {
		return /CMakeCache\.txt directory .* is different than the directory|does not match the source .* used to generate cache/s.test(step.outputTail);
	}

	override async build(host: IAgentHost, project: ProjectInfo, options: BuildOptions = {}): Promise<StepResult[]> {
		const configured = await this.configure(host, project, options);
		if (!configured.ok && CMakeBuildSystem.isForeignCache(configured)) {
			// Recovered automatically: report the removal, not the stale-cache error (it is resolved,
			// and the model must not try to "fix" it).
			const removed = await this.run(host, project, 'clean', ['cmake', ['-E', 'remove_directory', 'build']], options);
			const step: StepResult = { ...removed, note: 'The build tree had been created for another source folder (copied project); it was removed and configured afresh.' };
			if (!removed.ok) {
				return [configured, step];
			}
			const fresh = await this.configure(host, project, options);
			return fresh.ok ? [step, fresh, await this.run(host, project, 'build', this.buildCommand(), options)] : [step, fresh];
		}
		if (!configured.ok) {
			return [configured];
		}
		return [configured, await this.run(host, project, 'build', this.buildCommand(), options)];
	}
	protected buildCommand(): readonly [string, string[]] {
		return ['cmake', ['--build', 'build', '--parallel']];
	}
	protected cleanCommand(): readonly [string, string[]] {
		return ['cmake', ['--build', 'build', '--target', 'clean']];
	}
	/** A *generated* tree: CMake writes CMakeCache.txt even when configure fails. */
	protected override async isConfigured(host: IAgentHost, project: ProjectInfo): Promise<boolean> {
		const dir = this.buildDir(project);
		return await host.fs.exists(joinPath(dir, 'CMakeCache.txt'))
			&& (await host.fs.exists(joinPath(dir, 'Makefile')) || await host.fs.exists(joinPath(dir, 'build.ninja')));
	}
}

export class MakeBuildSystem extends CommandBuildSystem {
	readonly id = 'make';

	/** The project folder: CubeMX-style Makefiles write to `build/`, others next to the sources. */
	buildDir(project: ProjectInfo): string {
		return project.dir;
	}
	protected configureCommand(): undefined {
		return undefined;
	}
	protected buildCommand(): readonly [string, string[]] {
		return ['make', ['-j4']];
	}
	protected cleanCommand(): readonly [string, string[]] {
		return ['make', ['clean']];
	}
}

export class PlatformIoBuildSystem extends CommandBuildSystem {
	readonly id = 'platformio';

	buildDir(project: ProjectInfo): string {
		return joinPath(project.dir, '.pio/build');
	}
	protected configureCommand(): undefined {
		return undefined;
	}
	protected buildCommand(_project: ProjectInfo, options: BuildOptions): readonly [string, string[]] {
		return ['pio', ['run', ...options.environment ? ['-e', options.environment] : []]];
	}
	protected cleanCommand(_project: ProjectInfo, options: BuildOptions): readonly [string, string[]] {
		return ['pio', ['run', '-t', 'clean', ...options.environment ? ['-e', options.environment] : []]];
	}
}

export class EspIdfBuildSystem extends CommandBuildSystem {
	readonly id = 'esp-idf';

	buildDir(project: ProjectInfo): string {
		return joinPath(project.dir, 'build');
	}
	protected configureCommand(): readonly [string, string[]] {
		return ['idf.py', ['reconfigure']];
	}
	protected buildCommand(): readonly [string, string[]] {
		return ['idf.py', ['build']];
	}
	protected cleanCommand(): readonly [string, string[]] {
		return ['idf.py', ['clean']];
	}
}

const BUILD_SYSTEMS: Readonly<Record<BuildSystemId, () => IBuildSystem>> = {
	'cmake': () => new CMakeBuildSystem(),
	'make': () => new MakeBuildSystem(),
	'platformio': () => new PlatformIoBuildSystem(),
	'esp-idf': () => new EspIdfBuildSystem(),
};

export function createBuildSystem(id: BuildSystemId): IBuildSystem {
	return BUILD_SYSTEMS[id]();
}
