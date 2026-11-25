/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  RoboAgent — STM32 mode: Create (wizard → CMake/Makefile project), Build (CMake configure +
 *  make, or the project's Makefile, with the gcc problem matcher), Debug (Cortex-Debug + OpenOCD,
 *  bundled with RoboAgent). Build and Debug act on the STM32 project holding the active file,
 *  which may sit below the workspace folder (an STM32CubeIDE workspace). All three first make
 *  sure the tools they need are installed (`ensureToolchain.ts`) and offer to install them when
 *  they are not.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CORTEX_DEBUG_EXTENSION_ID } from '../bundledExtensions';
import { detectStm32, findStm32Projects } from '../detect';
import { ModeHost } from '../modeHost';
import { ModeProvider } from '../modeProvider';
import { materialize, ScaffoldError, toIdentifier } from '../scaffold';
import { BACK, inputStep, pickFolder, pickOrTypeStep, pickStep, StepResult, validateProjectName } from '../wizardSteps';
import { CmsisIo, installCmsisIntoProject, nodeCmsisIo } from './cmsis';
import { ensureStm32Toolchain } from './ensureToolchain';
import { describeOpenOcdFailure, generateStm32Project, openocdArgs, stm32BuildCommands, Stm32ProjectKind, Stm32ProjectSpec, stm32LaunchConfigurations, Stm32Toolchain } from './generator';
import { isPlausiblePartNumber, ResolvedStm32Target, resolveTarget, STM32_FAMILIES, STM32_PARTS } from './mcuDatabase';
import { findFirmwareImages, planStm32Build, readStm32Part } from './project';

interface Stm32WizardResult {
	readonly location: string;
	readonly project: Stm32ProjectSpec;
}

interface Stm32ProjectJson {
	name?: string;
	part?: string;
	kind?: Stm32ProjectKind;
	toolchain?: Stm32Toolchain;
}

const TOTAL_STEPS = 5;

export class Stm32ModeProvider implements ModeProvider {

	readonly mode = 'stm32' as const;

	constructor(private readonly host: ModeHost, private readonly cmsisIo: CmsisIo = nodeCmsisIo()) { }

	detect(folderFsPath: string): Promise<boolean> {
		return detectStm32(folderFsPath);
	}

	// --- Create ---------------------------------------------------------------

	async create(): Promise<void> {
		// The compiler is checked up front: the project can be scaffolded without it, but the user
		// should know before investing in the wizard that nothing will build until it is installed.
		const { ready, continueWithout } = await ensureStm32Toolchain(this.host, { silentIfPresent: true, purpose: 'create', allowContinue: true });
		if (!ready && !continueWithout) {
			this.host.log('STM32: Create cancelled — the Arm GNU toolchain is not installed.');
			return;
		}
		const result = await this.runWizard();
		if (!result) {
			return;
		}
		const dest = path.join(result.location, result.project.name);
		try {
			await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Creating STM32 project "{0}"…', result.project.name) }, async () => {
				await materialize(dest, generateStm32Project(result.project));
			});
		} catch (e) {
			if (e instanceof ScaffoldError && e.code === 'cancelled') { return; }
			await this.host.showError(vscode.l10n.t('Could not create the STM32 project: {0}', e instanceof Error ? e.message : String(e)));
			return;
		}
		this.host.log(`STM32: created ${dest} (${result.project.target.part}, ${result.project.kind}, ${result.project.toolchain})`);
		if (result.project.kind === 'executable') {
			await this.addCmsisTo(dest, result.project.target);
		}

		if (!ready) {
			this.host.log('STM32: arm-none-eabi-gcc not installed — the project will not build until it is (Build offers the installer).');
		} else if (result.project.toolchain === 'cmake' && !(await this.host.toolOnPath('cmake'))) {
			await this.host.showWarning(vscode.l10n.t('cmake was not found on PATH; Build will offer to install it.'));
		}
		await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(dest), { forceNewWindow: false });
	}

	private async runWizard(): Promise<Stm32WizardResult | undefined> {
		type Step = 'name' | 'location' | 'mcu' | 'kind' | 'toolchain';
		let step: Step = 'name';
		let name = '';
		let location: string | undefined;
		let part: string | undefined;
		let kind: Stm32ProjectKind = 'executable';
		let toolchain: Stm32Toolchain = 'cmake';

		while (true) {
			switch (step) {
				case 'name': {
					const r = await inputStep({ title: vscode.l10n.t('New STM32 Project — Name'), step: 1, totalSteps: TOTAL_STEPS, prompt: vscode.l10n.t('Project name (folder and CMake project name)'), value: name, validate: validateProjectName });
					if (r === undefined || r === BACK) { return undefined; }
					name = r.trim();
					step = 'location';
					break;
				}
				case 'location': {
					const picked = await pickFolder(vscode.l10n.t('New STM32 Project — Location (parent folder)'), vscode.l10n.t('Create here'), location ? vscode.Uri.file(location) : undefined);
					if (!picked) { step = 'name'; break; }   // dialog cancel → back to the name step
					location = picked;
					step = 'mcu';
					break;
				}
				case 'mcu': {
					const items = STM32_PARTS.map(p => {
						const family = STM32_FAMILIES.find(f => f.id === p.family);
						return { label: `$(circuit-board) ${p.name}`, description: `${family?.core ?? ''} · ${p.flashKb} KB flash / ${p.ramKb} KB RAM`, detail: `${family?.label ?? p.family}${p.description ? ' — ' + p.description : ''}`, value: p.name };
					});
					const r: StepResult<string> = await pickOrTypeStep(
						{ title: vscode.l10n.t('New STM32 Project — Target MCU'), step: 2, totalSteps: TOTAL_STEPS, placeholder: vscode.l10n.t('Search by part number (e.g. STM32F407VGT6) or type any STM32 part'), canGoBack: true },
						items,
						v => isPlausiblePartNumber(v) ? undefined : vscode.l10n.t('Enter an STM32 part number such as STM32F103C8T6'),
						part);
					if (r === undefined) { return undefined; }
					if (r === BACK) { step = 'location'; break; }
					part = r.toUpperCase();
					step = 'kind';
					break;
				}
				case 'kind': {
					const r: StepResult<Stm32ProjectKind> = await pickStep<Stm32ProjectKind>({ title: vscode.l10n.t('New STM32 Project — Project Type'), step: 3, totalSteps: TOTAL_STEPS, canGoBack: true }, [
						{ label: '$(run) Executable', description: vscode.l10n.t('Firmware image: main.c, startup file, linker script, flash + debug configs'), value: 'executable' },
						{ label: '$(library) Library', description: vscode.l10n.t('Static library (add_library STATIC) for other STM32 projects'), value: 'library' },
					], kind);
					if (r === undefined) { return undefined; }
					if (r === BACK) { step = 'mcu'; break; }
					kind = r;
					step = 'toolchain';
					break;
				}
				case 'toolchain': {
					const r: StepResult<Stm32Toolchain> = await pickStep<Stm32Toolchain>({ title: vscode.l10n.t('New STM32 Project — Build System'), step: 4, totalSteps: TOTAL_STEPS, canGoBack: true }, [
						{ label: '$(tools) CMake + arm-none-eabi-gcc', description: vscode.l10n.t('Recommended: toolchain file, compile_commands.json, cmake --build'), value: 'cmake' },
						{ label: '$(terminal) Makefile', description: vscode.l10n.t('Plain GNU Make with the same flags'), value: 'make' },
					], toolchain);
					if (r === undefined) { return undefined; }
					if (r === BACK) { step = 'kind'; break; }
					toolchain = r;
					const target = resolveTarget(part!);
					if (!target.exact) {
						this.host.log(`STM32: ${target.part} is not in the catalog; using ${target.core} with default memory sizes`);
					}
					return {
						location: location!,
						project: { name, target, kind, toolchain, openocdInterface: this.host.getSetting<string>('roboagent.stm32.openocdInterface') || 'stlink' },
					};
				}
			}
		}
	}

	// --- Build ----------------------------------------------------------------

	/**
	 * The STM32 project to act on: the one containing the active file, else the only one in the
	 * workspace, else the user's pick. Without a recognisable STM32 project, the nearest folder
	 * above the active file with a CMakeLists.txt / Makefile, else the workspace folder.
	 */
	private async projectRoot(): Promise<string | undefined> {
		const folders = (vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file').map(f => f.uri.fsPath);
		if (folders.length === 0) {
			await this.host.showWarning(vscode.l10n.t('Open an STM32 project folder first (or use Create).'));
			return undefined;
		}
		const active = vscode.window.activeTextEditor?.document.uri;
		const activePath = active?.scheme === 'file' ? active.fsPath : undefined;
		const projects = (await Promise.all(folders.map(f => findStm32Projects(f)))).flat();
		const containing = activePath && projects.filter(p => isInside(activePath, p)).sort((a, b) => b.length - a.length)[0];
		if (containing) {
			return containing;
		}
		if (projects.length === 1) {
			return projects[0];
		}
		if (projects.length > 1) {
			const pick = await vscode.window.showQuickPick(projects.map(p => ({ label: path.basename(p), description: p, root: p })), { title: vscode.l10n.t('Select the STM32 project') });
			return pick?.root;
		}
		const folder = activePath && folders.find(f => isInside(activePath, f));
		if (activePath && folder) {
			for (let dir = path.dirname(activePath); isInside(dir, folder); dir = path.dirname(dir)) {
				if (await this.host.fileExists(path.join(dir, 'CMakeLists.txt')) || await this.host.fileExists(path.join(dir, 'Makefile'))) {
					return dir;
				}
				if (dir === folder) { break; }
			}
		}
		return folder || folders[0];
	}

	// --- CMSIS headers ----------------------------------------------------------

	/** `roboagent.stm32.addCmsis`: put the CMSIS headers into the current STM32 project. */
	async addCmsis(): Promise<void> {
		const root = await this.projectRoot();
		if (!root) { return; }
		const json = await this.readProjectJson(root);
		if (json.kind === 'library') {
			await this.host.showInfo(vscode.l10n.t('This is a library project: it uses the CMSIS headers of the executable project that links it.'));
			return;
		}
		const part = json.part ?? await readStm32Part(root);
		if (!part) {
			await this.host.showWarning(vscode.l10n.t('Could not tell which STM32 this project is for (no .roboagent/project.json, .ioc, .cproject or STM32*.ld).'));
			return;
		}
		await this.addCmsisTo(root, resolveTarget(part), true);
	}

	/**
	 * Download (once per family) and copy the CMSIS core + device headers into `root`. Failing to
	 * download is not fatal: the project builds without them, and the message says how to add them later.
	 */
	private async addCmsisTo(root: string, target: ResolvedStm32Target, reportSuccess = false): Promise<void> {
		try {
			const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Adding the CMSIS headers for {0}…', target.part) },
				() => installCmsisIntoProject(root, target, this.cmsisIo));
			switch (result.kind) {
				case 'installed':
					this.host.log(`STM32: CMSIS headers added to ${root} (${result.files} files${result.updatedBuildFile ? `, ${result.updatedBuildFile} updated` : ''})`);
					if (result.buildFileNotUpdated) {
						await this.host.showWarning(vscode.l10n.t('CMSIS headers for {0} added to Drivers/CMSIS, but {1} was edited and could not be updated: add Drivers/CMSIS/Include and Drivers/CMSIS/Device/ST/{2}/Include to its include folders.', target.part, result.buildFileNotUpdated, `STM32${target.family.id}xx`));
					} else if (reportSuccess) {
						await this.host.showInfo(result.updatedBuildFile
							? vscode.l10n.t('CMSIS headers for {0} added to Drivers/CMSIS, and {1} updated to use them.', target.part, result.updatedBuildFile)
							: vscode.l10n.t('CMSIS headers for {0} added to Drivers/CMSIS.', target.part));
					}
					break;
				case 'unknown-device':
					await this.host.showWarning(vscode.l10n.t('{0} is not in RoboAgent\'s MCU catalog, and ST\'s CMSIS pack has no device header for the guessed define {1}; no CMSIS headers were added. Add them from STM32Cube for your exact part.', target.part, result.define));
					break;
				case 'already-present':
					if (reportSuccess) {
						await this.host.showInfo(vscode.l10n.t('This project already has its own Drivers/CMSIS; nothing was changed.'));
					}
					break;
				case 'unknown-family':
					await this.host.showWarning(vscode.l10n.t('No CMSIS device pack is known for the STM32{0} family; add the headers from STM32Cube.', result.family));
					break;
			}
		} catch (e) {
			this.host.log(`STM32: CMSIS headers not added: ${e instanceof Error ? e.message : String(e)}`);
			await this.host.showWarning(
				vscode.l10n.t('The CMSIS headers (stm32*.h, RCC, GPIO…) could not be downloaded: {0}. The project builds without them; add them later with "RoboAgent: STM32: Add CMSIS Headers".', e instanceof Error ? e.message : String(e)),
				{ title: vscode.l10n.t('Retry'), run: () => this.addCmsisTo(root, target, true) });
		}
	}

	private async readProjectJson(root: string): Promise<Stm32ProjectJson> {
		try {
			return JSON.parse(await fs.promises.readFile(path.join(root, '.roboagent', 'project.json'), 'utf8')) as Stm32ProjectJson;
		} catch {
			return {};
		}
	}

	async build(): Promise<number | undefined> {
		const root = await this.projectRoot();
		return root ? this.buildProject(root) : undefined;
	}

	private async buildProject(root: string): Promise<number | undefined> {
		const plan = await planStm32Build(root);
		if (!plan) {
			await this.host.showWarning(vscode.l10n.t('No CMakeLists.txt or Makefile in "{0}" — nothing to build. Use Create to scaffold an STM32 project.', root));
			return undefined;
		}
		const { ready, tools } = await ensureStm32Toolchain(this.host, { silentIfPresent: true, purpose: 'build', buildSystem: plan.buildSystem });
		if (!ready) { return undefined; }   // the user was offered the installer
		const commands = stm32BuildCommands(plan.buildSystem, plan.usesToolchainPath ? tools.toolchainDir : undefined, plan.options);
		// A toolchain off PATH (setting, well-known location, STM32CubeIDE) also goes first on PATH, for
		// projects whose toolchain file / makefiles call plain `arm-none-eabi-gcc`.
		const env = tools.toolchainDir ? { PATH: `${tools.toolchainDir}${path.delimiter}${process.env['PATH'] ?? ''}` } : undefined;
		const result = await this.host.runShellTask({ name: 'RoboAgent: STM32 build', command: commands.build, cwd: root, problemMatchers: ['$roboagent-gcc', '$roboagent-cmake'], group: 'build', env });
		return result.exitCode;
	}

	// --- Debug ----------------------------------------------------------------

	async debug(): Promise<void> {
		const root = await this.projectRoot();
		if (!root) { return; }
		const json = await this.readProjectJson(root);
		if (json.kind === 'library') {
			await this.host.showWarning(vscode.l10n.t('This is an STM32 library project; debug an executable project that links it.'));
			return;
		}
		// Cortex-Debug ships with RoboAgent; it is missing only when the user disabled (or removed) it.
		// Checked first, before any toolchain or build prompt. A disabled built-in is re-enabled
		// from the Extensions view; installing again would not enable it.
		if (!this.host.isExtensionInstalled(CORTEX_DEBUG_EXTENSION_ID)) {
			await this.host.showError(vscode.l10n.t('STM32 debugging needs the Cortex-Debug extension, which is disabled.'),
				{ title: vscode.l10n.t('Show Cortex-Debug'), run: async () => { await this.host.executeCommand('workbench.extensions.search', `@id:${CORTEX_DEBUG_EXTENSION_ID}`); } });
			return;
		}
		// OpenOCD + a GDB are needed for the debug session; the compiler is checked by Build below if needed.
		const { ready, tools } = await ensureStm32Toolchain(this.host, { silentIfPresent: true, purpose: 'debug' });
		if (!ready) { return; }   // the user was offered the installer

		let elf = (await findFirmwareImages(root))[0];
		if (!elf) {
			const build = vscode.l10n.t('Build now');
			let chosen = false;
			await this.host.showWarning(vscode.l10n.t('No firmware image (.elf) found under build/ or Debug/. Build first?'), { title: build, run: () => { chosen = true; } });
			if (!chosen) { return; }
			const exitCode = await this.buildProject(root);
			if (exitCode !== 0) { return; }
			elf = (await findFirmwareImages(root))[0];
			if (!elf) {
				await this.host.showError(vscode.l10n.t('The build finished but no .elf was produced under build/.'));
				return;
			}
		}

		const part = json.part ?? await readStm32Part(root);
		const target = resolveTarget(part ?? 'STM32F407VGT6');
		if (!part) {
			this.host.log('STM32: no MCU found in .roboagent/project.json, *.ioc, .cproject or the linker script; assuming an STM32F4-class OpenOCD target for the debug config');
		}
		const plan = await planStm32Build(root);
		let openocdInterface = this.host.getSetting<string>('roboagent.stm32.openocdInterface') || 'stlink';
		if (tools.openocdPath && openocdInterface === 'stlink') {
			// ST's OpenOCD fork recurses endlessly on the HLA `stlink` interface script; ST-Link is driven through `stlink-dap` there.
			openocdInterface = 'stlink-dap';
		}
		const spec: Stm32ProjectSpec = { name: path.basename(root), target, kind: 'executable', toolchain: plan?.buildSystem ?? 'cmake', openocdInterface };
		const [cortex] = stm32LaunchConfigurations(spec, json.name ?? toIdentifier(path.basename(root)));
		// `${workspaceFolder}` only names the project when the project is the workspace folder.
		const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(root))?.uri.fsPath;
		const atFolderRoot = folder === root;
		const executable = atFolderRoot ? '${workspaceFolder}/' + path.relative(root, elf).split(path.sep).join('/') : elf;
		const cwd = atFolderRoot ? '${workspaceFolder}' : root;

		const configuration: Record<string, unknown> = { ...cortex, executable, cwd, preLaunchTask: undefined };
		// Cortex-Debug defaults to `arm-none-eabi-gdb` / `openocd` on PATH; point it at what was actually found.
		if (tools.toolchainDir) { configuration['armToolchainPath'] = tools.toolchainDir; }
		if (tools.gdbPath && tools.gdbPath !== 'arm-none-eabi-gdb' && path.dirname(tools.gdbPath) !== tools.toolchainDir) { configuration['gdbPath'] = tools.gdbPath; }
		if (tools.openocdPath) { configuration['serverpath'] = tools.openocdPath; }
		if (tools.openocdScriptsDir) { configuration['searchDir'] = [tools.openocdScriptsDir]; }

		// Without a reachable probe the debug adapter just ends silently; check first and say why.
		const probeArgs = [...(tools.openocdScriptsDir ? ['-s', tools.openocdScriptsDir] : []), ...openocdArgs(spec), '-c', 'init; shutdown'];
		const probe = await this.host.runProcess(tools.openocdPath ?? 'openocd', probeArgs, 20000);
		if (probe.exitCode !== 0) {
			this.host.log(`STM32: OpenOCD probe check failed (exit ${probe.exitCode}):\n${probe.output.split(/\r?\n/).filter(l => l && !l.startsWith('DEPRECATED')).join('\n')}`);
			await this.host.showError(describeOpenOcdFailure(probe.output),
				{ title: vscode.l10n.t('Retry'), run: () => this.debug() },
				{ title: vscode.l10n.t('Show Log'), run: () => this.host.showLog() });
			return;
		}
		if (!(await this.host.startDebugging(root, configuration))) {
			await this.host.showError(vscode.l10n.t('The STM32 debug session did not start. See the Debug Console and the RoboAgent log for details.'),
				{ title: vscode.l10n.t('Show Log'), run: () => this.host.showLog() });
		}
	}
}

function isInside(child: string, parent: string): boolean {
	const rel = path.relative(parent, child);
	return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
