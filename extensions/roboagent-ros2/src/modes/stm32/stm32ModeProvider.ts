/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  RoboAgent — STM32 mode: Create (wizard → CMake/Makefile project), Build (arm-none-eabi-gcc
 *  task with the gcc problem matcher), Debug (Cortex-Debug → cpptools/OpenOCD fallback). All
 *  three first make sure the tools they need are installed (`ensureToolchain.ts`) and offer to
 *  install them when they are not.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CORTEX_DEBUG_EXTENSION_ID } from '../bundledExtensions';
import { detectStm32 } from '../detect';
import { ModeHost } from '../modeHost';
import { ModeProvider } from '../modeProvider';
import { materialize, ScaffoldError, toIdentifier } from '../scaffold';
import { BACK, inputStep, pickFolder, pickOrTypeStep, pickStep, StepResult, validateProjectName } from '../wizardSteps';
import { ensureStm32Toolchain } from './ensureToolchain';
import { generateStm32Project, stm32BuildCommands, Stm32ProjectKind, Stm32ProjectSpec, stm32LaunchConfigurations, Stm32Toolchain } from './generator';
import { isPlausiblePartNumber, resolveTarget, STM32_FAMILIES, STM32_PARTS } from './mcuDatabase';

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

	constructor(private readonly host: ModeHost) { }

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

	private async projectRoot(): Promise<string | undefined> {
		const active = vscode.window.activeTextEditor?.document.uri;
		const folder = (active && vscode.workspace.getWorkspaceFolder(active)) ?? vscode.workspace.workspaceFolders?.[0];
		if (!folder || folder.uri.scheme !== 'file') {
			await this.host.showWarning(vscode.l10n.t('Open an STM32 project folder first (or use Create).'));
			return undefined;
		}
		return folder.uri.fsPath;
	}

	private async readProjectJson(root: string): Promise<Stm32ProjectJson> {
		try {
			return JSON.parse(await fs.promises.readFile(path.join(root, '.roboagent', 'project.json'), 'utf8')) as Stm32ProjectJson;
		} catch {
			return {};
		}
	}

	private async toolchainFor(root: string): Promise<Stm32Toolchain> {
		const json = await this.readProjectJson(root);
		if (json.toolchain) { return json.toolchain; }
		if (await this.host.fileExists(path.join(root, 'CMakeLists.txt'))) { return 'cmake'; }
		return 'make';
	}

	async build(): Promise<number | undefined> {
		const root = await this.projectRoot();
		if (!root) { return undefined; }
		const toolchain = await this.toolchainFor(root);
		if (toolchain === 'make' && !(await this.host.fileExists(path.join(root, 'Makefile')))) {
			await this.host.showWarning(vscode.l10n.t('No CMakeLists.txt or Makefile in "{0}" — nothing to build. Use Create to scaffold an STM32 project.', root));
			return undefined;
		}
		const { ready, tools } = await ensureStm32Toolchain(this.host, { silentIfPresent: true, purpose: 'build', buildSystem: toolchain });
		if (!ready) { return undefined; }   // the user was offered the installer
		const commands = stm32BuildCommands(toolchain, tools.toolchainDir);
		const result = await this.host.runShellTask({ name: 'RoboAgent: STM32 build', command: commands.build, cwd: root, problemMatchers: ['$roboagent-gcc'], group: 'build' });
		return result.exitCode;
	}

	// --- Debug ----------------------------------------------------------------

	private async findElf(root: string): Promise<string | undefined> {
		const json = await this.readProjectJson(root);
		const expected = path.join(root, 'build', `${json.name ?? toIdentifier(path.basename(root))}.elf`);
		if (await this.host.fileExists(expected)) {
			return expected;
		}
		const found = await vscode.workspace.findFiles(new vscode.RelativePattern(root, 'build/**/*.elf'), undefined, 10);
		if (found.length === 1) { return found[0].fsPath; }
		if (found.length > 1) {
			const pick = await vscode.window.showQuickPick(found.map(u => ({ label: path.relative(root, u.fsPath), uri: u })), { title: vscode.l10n.t('Select the firmware image to debug') });
			return pick?.uri.fsPath;
		}
		return undefined;
	}

	async debug(): Promise<void> {
		const root = await this.projectRoot();
		if (!root) { return; }
		const json = await this.readProjectJson(root);
		if (json.kind === 'library') {
			await this.host.showWarning(vscode.l10n.t('This is an STM32 library project; debug an executable project that links it.'));
			return;
		}
		// OpenOCD + a GDB are needed whichever debug adapter runs; the compiler is checked by Build below if needed.
		const { ready, tools } = await ensureStm32Toolchain(this.host, { silentIfPresent: true, purpose: 'debug' });
		if (!ready) { return; }   // the user was offered the installer

		let elf = await this.findElf(root);
		if (!elf) {
			const build = vscode.l10n.t('Build now');
			let chosen = false;
			await this.host.showWarning(vscode.l10n.t('No firmware image (.elf) found under build/. Build first?'), { title: build, run: () => { chosen = true; } });
			if (!chosen) { return; }
			const exitCode = await this.build();
			if (exitCode !== 0) { return; }
			elf = await this.findElf(root);
			if (!elf) {
				await this.host.showError(vscode.l10n.t('The build finished but no .elf was produced under build/.'));
				return;
			}
		}

		const target = resolveTarget(json.part ?? 'STM32F407VGT6');
		if (!json.part) {
			this.host.log('STM32: no .roboagent/project.json part; assuming an STM32F4-class OpenOCD target for the debug config');
		}
		const spec: Stm32ProjectSpec = { name: path.basename(root), target, kind: 'executable', toolchain: await this.toolchainFor(root), openocdInterface: this.host.getSetting<string>('roboagent.stm32.openocdInterface') || 'stlink' };
		const [cortex, cppdbg] = stm32LaunchConfigurations(spec, json.name ?? toIdentifier(path.basename(root)));
		const relElf = '${workspaceFolder}/' + path.relative(root, elf).split(path.sep).join('/');

		let configuration: Record<string, unknown>;
		if (this.host.isExtensionInstalled(CORTEX_DEBUG_EXTENSION_ID)) {
			configuration = { ...cortex, executable: relElf, preLaunchTask: undefined };
			// Cortex-Debug defaults to `arm-none-eabi-gdb` on PATH; point it at what was actually found.
			if (tools.toolchainDir) { configuration['armToolchainPath'] = tools.toolchainDir; }
			if (tools.gdbPath === 'gdb-multiarch') { configuration['gdbPath'] = tools.gdbPath; }
		} else {
			this.host.log(`STM32: Cortex-Debug not installed; using cpptools cppdbg + OpenOCD with ${tools.gdbPath}`);
			configuration = { ...cppdbg, program: relElf, preLaunchTask: undefined, miDebuggerPath: tools.gdbPath };
		}
		await this.host.startDebugging(root, configuration);
	}
}
