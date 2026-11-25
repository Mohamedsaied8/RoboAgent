/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  RoboAgent — ESP32 mode: Create (wizard → ESP-IDF project), Build (espIdf.buildDevice when the
 *  bundled extension is set up with the ESP-IDF in use, else `idf.py build` in an IDF-activated
 *  task), Debug (the extension's gdbtarget session, falling back to flash + monitor). All three
 *  first make sure an ESP-IDF installation exists (`ensureIdf.ts`) and offer to install one when
 *  it does not.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { ESP_IDF_EXTENSION_ID } from '../bundledExtensions';
import { detectEsp32 } from '../detect';
import { ModeHost } from '../modeHost';
import { ModeProvider } from '../modeProvider';
import { materialize, ScaffoldError } from '../scaffold';
import { EspIdfInstallation, espIdfExtensionCheckouts, realPath } from '../toolchains';
import { BACK, inputStep, pickFolder, pickStep, StepResult, validateProjectName } from '../wizardSteps';
import { ensureEspIdf } from './ensureIdf';
import { ESP32_CHIPS, Esp32Chip, esp32DebugConfiguration, esp32IdfCommand, Esp32ProjectSpec, Esp32Template, generateEsp32Project } from './generator';

type TemplateChoice = Esp32Template | 'extension';

interface Esp32WizardResult {
	readonly location: string;
	readonly project: Esp32ProjectSpec;
	/** True when the user chose the ESP-IDF extension's own New Project flow. */
	readonly useExtensionWizard: boolean;
}

const TOTAL_STEPS = 4;

export class Esp32ModeProvider implements ModeProvider {

	readonly mode = 'esp32' as const;

	constructor(private readonly host: ModeHost) { }

	detect(folderFsPath: string): Promise<boolean> {
		return detectEsp32(folderFsPath);
	}

	private get extensionInstalled(): boolean {
		return this.host.isExtensionInstalled(ESP_IDF_EXTENSION_ID);
	}

	/**
	 * Whether the ESP-IDF extension can act on `installation`. The extension only knows the
	 * checkouts it was set up with (`idf.currentSetup` or the Installation Manager's
	 * `eim_idf.json`); with any other checkout its build fails with "Something went wrong", so
	 * that case runs `idf.py` directly. Decided by the checkout itself, not by where RoboAgent
	 * found it: `$IDF_PATH` from a sourced export.sh may well be the extension's own checkout.
	 */
	private async extensionCanUse(installation: EspIdfInstallation): Promise<boolean> {
		if (!this.extensionInstalled) { return false; }
		const known = await espIdfExtensionCheckouts({
			extensionSetup: this.host.getSetting<string>('idf.currentSetup'),
			eimJsonPath: this.host.getSetting<string>('idf.eimIdfJsonPath'),
		});
		if (known.includes(await realPath(installation.idfPath))) { return true; }
		this.host.log(`ESP32: the ESP-IDF extension is not set up with ${installation.idfPath}; using idf.py directly.`);
		return false;
	}

	private port(): string | undefined {
		const p = this.host.getSetting<string>('roboagent.esp32.port');
		return p && p.trim() ? p.trim() : undefined;
	}

	// --- Create ---------------------------------------------------------------

	async create(): Promise<void> {
		// ESP-IDF is checked up front: the project can be scaffolded without it, but the user
		// should know before investing in the wizard that nothing will build until it is installed.
		const { installation, continueWithout } = await ensureEspIdf(this.host, { silentIfPresent: true, purpose: 'create', allowContinue: true });
		if (!installation && !continueWithout) {
			this.host.log('ESP32: Create cancelled — ESP-IDF is not installed.');
			return;
		}
		const result = await this.runWizard();
		if (!result) {
			return;
		}
		if (result.useExtensionWizard) {
			this.host.log('ESP32: handing over to the ESP-IDF extension New Project wizard');
			await this.host.executeCommand('espIdf.createNewProject');
			return;
		}
		const dest = path.join(result.location, result.project.name);
		try {
			await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Creating ESP-IDF project "{0}"…', result.project.name) }, async () => {
				await materialize(dest, generateEsp32Project(result.project));
			});
		} catch (e) {
			if (e instanceof ScaffoldError && e.code === 'cancelled') { return; }
			await this.host.showError(vscode.l10n.t('Could not create the ESP32 project: {0}', e instanceof Error ? e.message : String(e)));
			return;
		}
		this.host.log(`ESP32: created ${dest} (${result.project.chip}, ${result.project.template})`);

		// No `idf.py set-target` here: sdkconfig.defaults pins the chip for the first build, and a
		// terminal started now would be killed by the folder switch below, leaving an empty build/.
		await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(dest), { forceNewWindow: false });
	}

	private async runWizard(): Promise<Esp32WizardResult | undefined> {
		type Step = 'name' | 'location' | 'chip' | 'template';
		let step: Step = 'name';
		let name = '';
		let location: string | undefined;
		let chip: Esp32Chip = 'esp32';
		let template: TemplateChoice = 'hello_world';

		while (true) {
			switch (step) {
				case 'name': {
					const r = await inputStep({ title: vscode.l10n.t('New ESP32 Project — Name'), step: 1, totalSteps: TOTAL_STEPS, prompt: vscode.l10n.t('Project name (folder and CMake project name)'), value: name, validate: validateProjectName });
					if (r === undefined || r === BACK) { return undefined; }
					name = r.trim();
					step = 'location';
					break;
				}
				case 'location': {
					const picked = await pickFolder(vscode.l10n.t('New ESP32 Project — Location (parent folder)'), vscode.l10n.t('Create here'), location ? vscode.Uri.file(location) : undefined);
					if (!picked) { step = 'name'; break; }
					location = picked;
					step = 'chip';
					break;
				}
				case 'chip': {
					const r: StepResult<Esp32Chip> = await pickStep<Esp32Chip>({ title: vscode.l10n.t('New ESP32 Project — Target Chip'), step: 2, totalSteps: TOTAL_STEPS, canGoBack: true },
						ESP32_CHIPS.map(c => ({ label: `$(radio-tower) ${c.label}`, description: c.description, detail: `idf.py set-target ${c.id} · ${c.arch}`, value: c.id })), chip);
					if (r === undefined) { return undefined; }
					if (r === BACK) { step = 'location'; break; }
					chip = r;
					step = 'template';
					break;
				}
				case 'template': {
					const items: { label: string; description: string; value: TemplateChoice }[] = [
						{ label: '$(file-code) hello_world', description: vscode.l10n.t('Minimal app_main printing chip info (bundled template)'), value: 'hello_world' },
						{ label: '$(lightbulb) blink', description: vscode.l10n.t('GPIO LED blink with FreeRTOS delay (bundled template)'), value: 'blink' },
					];
					if (this.extensionInstalled) {
						items.push({ label: '$(extensions) ESP-IDF extension: New Project…', description: vscode.l10n.t('Use the ESP-IDF extension wizard (IDF examples, components)'), value: 'extension' });
					}
					const r: StepResult<TemplateChoice> = await pickStep<TemplateChoice>({ title: vscode.l10n.t('New ESP32 Project — Template'), step: 3, totalSteps: TOTAL_STEPS, canGoBack: true }, items, template);
					if (r === undefined) { return undefined; }
					if (r === BACK) { step = 'chip'; break; }
					template = r;
					return {
						location: location!,
						useExtensionWizard: template === 'extension',
						project: { name, chip, template: template === 'extension' ? 'hello_world' : template, port: this.port() },
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
			await this.host.showWarning(vscode.l10n.t('Open an ESP-IDF project folder first (or use Create).'));
			return undefined;
		}
		return folder.uri.fsPath;
	}

	async build(): Promise<number | undefined> {
		const root = await this.projectRoot();
		if (!root) { return undefined; }
		const { installation } = await ensureEspIdf(this.host, { silentIfPresent: true, purpose: 'build' });
		if (!installation) { return undefined; }   // the user was offered the installer
		if (await this.extensionCanUse(installation)) {
			this.host.log('ESP32: build via espIdf.buildDevice');
			await this.host.executeCommand('espIdf.buildDevice');
			return undefined;   // the extension owns the task; no exit code available here
		}
		const result = await this.host.runShellTask({ name: 'RoboAgent: ESP32 build', command: esp32IdfCommand('build', undefined, installation.idfPath), cwd: root, problemMatchers: ['$roboagent-gcc', '$roboagent-cmake'], group: 'build' });
		return result.exitCode;
	}

	// --- Debug ----------------------------------------------------------------

	async debug(): Promise<void> {
		const root = await this.projectRoot();
		if (!root) { return; }
		const { installation } = await ensureEspIdf(this.host, { silentIfPresent: true, purpose: 'debug' });
		if (!installation) { return; }   // the user was offered the installer
		const viaExtension = await this.extensionCanUse(installation);
		if (viaExtension) {
			const started = await this.host.startDebugging(root, esp32DebugConfiguration());
			if (started) { return; }
			this.host.log('ESP32: gdbtarget session did not start (board not connected / OpenOCD not configured); offering flash + monitor');
		}
		await this.host.showWarning(
			viaExtension
				? vscode.l10n.t('Could not start the ESP-IDF debug session (is the board connected via JTAG/USB and OpenOCD configured?). Flash and monitor instead?')
				: this.extensionInstalled
					? vscode.l10n.t('The ESP-IDF extension is not set up with this ESP-IDF, so on-chip debugging is unavailable. Flash and monitor instead?')
					: vscode.l10n.t('The ESP-IDF extension is not installed, so on-chip debugging is unavailable. Flash and monitor instead?'),
			{ title: vscode.l10n.t('Flash + Monitor'), run: () => this.flashMonitor(root, installation, viaExtension) },
		);
	}

	private async flashMonitor(root: string, installation: EspIdfInstallation, viaExtension: boolean): Promise<void> {
		if (viaExtension) {
			await this.host.executeCommand('espIdf.buildFlashMonitor');
			return;
		}
		this.host.sendToTerminal('RoboAgent: ESP32 monitor', esp32IdfCommand('flash monitor', this.port(), installation.idfPath), root);
	}
}
