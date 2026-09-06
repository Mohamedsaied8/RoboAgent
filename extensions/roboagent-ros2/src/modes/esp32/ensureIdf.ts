/*---------------------------------------------------------------------------------------------
 *  Copyright (c) RoboAgent. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  RoboAgent — `roboagent.esp32.ensureIdf`: is ESP-IDF installed on this machine?
 *
 *  The ESP-IDF *extension* ships with RoboAgent, but the ESP-IDF *toolchain* (the esp-idf
 *  checkout, its Python environment and the Xtensa/RISC-V compilers) does not — the user has to
 *  install it once. ESP32 Create / Build / Debug call this first; when nothing is found the
 *  user is offered the ESP-IDF Installation Manager (EIM, via the bundled extension's
 *  `espIdf.installManager`, or its download page when the extension is missing), or to point
 *  RoboAgent at an existing checkout. Also runnable on demand from the palette.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ESP_IDF_EXTENSION_ID } from '../bundledExtensions';
import { MessageAction, ModeHost } from '../modeHost';
import { discoverEspIdf, EspIdfInstallation, EspIdfSource, isEspIdfCheckout, readEspIdfVersion } from '../toolchains';

/** Download page of the ESP-IDF Installation Manager (the page the ESP-IDF extension itself links to). */
export const ESP_IDF_INSTALL_MANAGER_URL = 'https://dl.espressif.com/dl/eim/';

export type EspIdfPurpose = 'create' | 'build' | 'debug';

export interface EnsureIdfOptions {
	/** When ESP-IDF is present, say nothing (used before Create / Build / Debug). */
	readonly silentIfPresent?: boolean;
	/** What the user was about to do; tailors the message. */
	readonly purpose?: EspIdfPurpose;
	/** Offer to go on without ESP-IDF (Create can still scaffold the project files). */
	readonly allowContinue?: boolean;
}

export interface EnsureIdfResult {
	/** The installation to use, or undefined when there is none (yet). */
	readonly installation: EspIdfInstallation | undefined;
	/** True when the user chose the `allowContinue` action. */
	readonly continueWithout: boolean;
}

const SOURCE_LABEL: Readonly<Record<EspIdfSource, string>> = {
	setting: 'roboagent.esp32.idfPath',
	env: '$IDF_PATH',
	extension: 'ESP-IDF extension setup',
	eim: 'ESP-IDF Installation Manager',
	home: 'default install folder',
};

/** {@link discoverEspIdf} fed from the settings visible to the host. */
export function findEspIdf(host: ModeHost): Promise<EspIdfInstallation | undefined> {
	return discoverEspIdf({
		configured: host.getSetting<string>('roboagent.esp32.idfPath'),
		extensionSetup: host.getSetting<string>('idf.currentSetup'),
		eimJsonPath: host.getSetting<string>('idf.eimIdfJsonPath'),
	});
}

export function describeEspIdf(installation: EspIdfInstallation): string {
	return `ESP-IDF ${installation.version ?? '(version unknown)'} at ${installation.idfPath} [${SOURCE_LABEL[installation.source]}]`;
}

/** Startup log line (never a notification). */
export async function logEspIdfStatus(host: ModeHost): Promise<void> {
	const installation = await findEspIdf(host);
	host.log(installation
		? `ESP32: ${describeEspIdf(installation)}.`
		: 'ESP32: no ESP-IDF installation found — Create / Build / Debug will offer to install it (roboagent.esp32.ensureIdf).');
}

/**
 * Resolve the ESP-IDF installation to use. When none exists, tell the user and offer to
 * install one (or to locate an existing checkout); resolves once the notification is
 * answered or dismissed.
 */
export async function ensureEspIdf(host: ModeHost, options: EnsureIdfOptions = {}): Promise<EnsureIdfResult> {
	const installation = await findEspIdf(host);
	if (installation) {
		host.log(`ESP32: using ${describeEspIdf(installation)}.`);
		if (!options.silentIfPresent) {
			await host.showInfo(vscode.l10n.t('ESP-IDF {0} found at {1} — ESP32 mode is ready.', installation.version ?? '', installation.idfPath).replace('  ', ' '));
		}
		return { installation, continueWithout: false };
	}
	host.log('ESP32: no ESP-IDF installation found (checked roboagent.esp32.idfPath, $IDF_PATH, the ESP-IDF extension setup, the Installation Manager registry, ~/esp and ~/.espressif).');

	let located: EspIdfInstallation | undefined;
	let continueWithout = false;
	const actions: MessageAction[] = [
		{ title: vscode.l10n.t('Install ESP-IDF…'), run: () => installEspIdf(host) },
		{ title: vscode.l10n.t('Use Existing Install…'), run: async () => { located = await locateEspIdf(host); } },
	];
	if (options.allowContinue) {
		actions.push({ title: vscode.l10n.t('Create Anyway'), run: () => { continueWithout = true; } });
	}
	await host.showWarning(missingMessage(options.purpose), ...actions);
	return { installation: located, continueWithout };
}

function missingMessage(purpose: EspIdfPurpose | undefined): string {
	const notFound = vscode.l10n.t('ESP-IDF was not found on this machine ($IDF_PATH, roboagent.esp32.idfPath, the ESP-IDF extension setup and the usual install folders were checked).');
	switch (purpose) {
		case 'create':
			return `${notFound} ${vscode.l10n.t('The project can be created, but it cannot be built until ESP-IDF is installed. Download and install ESP-IDF now?')}`;
		case 'build':
			return `${notFound} ${vscode.l10n.t('The project cannot be built without it. Download and install ESP-IDF now?')}`;
		case 'debug':
			return `${notFound} ${vscode.l10n.t('The project cannot be flashed or debugged without it. Download and install ESP-IDF now?')}`;
		default:
			return `${notFound} ${vscode.l10n.t('Download and install ESP-IDF now?')}`;
	}
}

/**
 * Start the ESP-IDF Installation Manager: through the bundled ESP-IDF extension when present
 * (it downloads EIM and opens its GUI), else its download page in the browser.
 */
async function installEspIdf(host: ModeHost): Promise<void> {
	if (host.isExtensionInstalled(ESP_IDF_EXTENSION_ID)) {
		host.log('ESP32: opening the ESP-IDF Installation Manager (espIdf.installManager).');
		try {
			await host.executeCommand('espIdf.installManager');
			await host.showInfo(vscode.l10n.t('Finish the installation in the ESP-IDF Installation Manager, then run Create / Build again — RoboAgent picks the new install up automatically.'));
			return;
		} catch (e) {
			host.log(`ESP32: espIdf.installManager failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
	host.log(`ESP32: opening ${ESP_IDF_INSTALL_MANAGER_URL}.`);
	await host.openExternal(ESP_IDF_INSTALL_MANAGER_URL);
	await host.showInfo(vscode.l10n.t('Download and run the ESP-IDF Installation Manager from the page that opened. When it finishes, run Create / Build again (or set roboagent.esp32.idfPath to the checkout).'));
}

/** Folder picker for an existing checkout; validated and stored in `roboagent.esp32.idfPath`. */
async function locateEspIdf(host: ModeHost): Promise<EspIdfInstallation | undefined> {
	const picked = await host.pickFolder(vscode.l10n.t('Select the ESP-IDF folder (the checkout containing tools/idf.py)'), vscode.l10n.t('Use this ESP-IDF'));
	if (!picked) {
		return undefined;
	}
	if (!(await isEspIdfCheckout(picked))) {
		await host.showError(vscode.l10n.t('"{0}" is not an ESP-IDF checkout: it has no tools/idf.py.', picked));
		return undefined;
	}
	await host.updateSetting('roboagent.esp32.idfPath', picked);
	const installation: EspIdfInstallation = { idfPath: picked, source: 'setting', version: await readEspIdfVersion(picked) };
	host.log(`ESP32: roboagent.esp32.idfPath set to ${picked} (${installation.version ?? 'version unknown'}).`);
	return installation;
}
